import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { zipSync, strFromU8, strToU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { Store } from '../src/main/store';
import { Files } from '../src/main/workspace';
import { Documents, unpack, paginateExcel } from '../src/main/documents';
let root:string,store:Store,files:Files,docs:Documents,id:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'office-reliable-'));await mkdir(join(root,'work'));store=new Store(join(root,'data'));await store.init();files=new Files(store);id=(await files.add(join(root,'work'))).id;docs=new Documents(files,join(process.cwd(),'resources'));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main',S='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
it('preserves tabs, soft breaks, spaces, Unicode and mixed run styles, refusing lossy changes unless explicitly requested',async()=>{
 const source=zipSync({'word/document.xml':strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> A😀</w:t><w:tab/><w:t>B</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:br/><w:t>C </w:t></w:r></w:p></w:body></w:document>`),'word/styles.xml':strToU8('keep')});await writeFile(join(root,'work','a.docx'),source);let doc=await docs.inspect(id,'a.docx');if(doc.kind!=='docx')throw Error();expect(doc.blocks[0].text).toBe(' A😀\tB\nC ');
 await docs.apply(id,doc.path,doc.version,[{type:'word_replace',blockId:'p:0',oldText:'😀\tB\nC',newText:'🦊\tD\nE'}],files.newChangeSet(id,'s'));doc=await docs.inspect(id,'a.docx');if(doc.kind!=='docx')throw Error();expect(doc.blocks[0].runs).toEqual([{text:' A🦊\tD',bold:true},{text:'\nE ',italic:true}]);const before=await files.bytes(id,doc.path);
 await expect(docs.apply(id,doc.path,doc.version,[{type:'word_replace',blockId:'p:0',oldText:'D\nE',newText:'longer text'}],files.newChangeSet(id,'s'))).rejects.toThrow('跨越不同文字格式');expect(await files.bytes(id,doc.path)).toEqual(before);
 const set=files.newChangeSet(id,'s');await docs.apply(id,doc.path,doc.version,[{type:'word_replace',blockId:'p:0',oldText:'D\nE',newText:'longer text',stylePolicy:'first-run'}],set);expect(set.changes[0].summary).toContain('显式 first-run');expect(set.changes[0].diff).toContain('修改前');await files.undo(id,set.id);expect(await files.bytes(id,doc.path)).toEqual(before);
});
async function workbook(){
 await docs.create(id,'book.xlsx','',files.newChangeSet(id,'s'));const parts=unpack(await files.bytes(id,'book.xlsx'));
 parts['xl/workbook.xml']=strToU8(strFromU8(parts['xl/workbook.xml']).replace('</sheets>','<sheet name="第二表" sheetId="2" r:id="rId2"/></sheets>'));
 parts['xl/_rels/workbook.xml.rels']=strToU8(strFromU8(parts['xl/_rels/workbook.xml.rels']).replace('</Relationships>','<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
 parts['xl/worksheets/sheet1.xml']=strToU8(`<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>3</v></c><c r="B1"><f>A1*2</f><v>6</v></c><c r="C1"><f>B1+1</f><v>7</v></c><c r="D1"><f>100+1</f><v>101</v></c><c r="E1"><f>INDIRECT("A1")</f><v>3</v></c></row></sheetData></worksheet>`);
 parts['xl/worksheets/sheet2.xml']=strToU8(`<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><f>Sheet1!C1*2</f><v>14</v></c><c r="B1"><f>99+1</f><v>100</v></c><c r="C1"><f>Sheet1!E1+1</f><v>4</v></c></row></sheetData></worksheet>`);
 await writeFile(join(root,'work','book.xlsx'),zipSync(parts));return docs.inspect(id,'book.xlsx');
}
it('invalidates direct, chained, cross-sheet and dynamic formula caches while preserving proven independent caches',async()=>{
 const doc=await workbook();const set=files.newChangeSet(id,'s');await docs.apply(id,doc.path,doc.version,[{type:'cell',sheetId:'rId1',ref:'A1',value:'4'}],set);const after=await docs.inspect(id,doc.path);if(after.kind!=='xlsx')throw Error();const values=Object.fromEntries(after.sheets.flatMap(s=>s.cells.map(c=>[`${s.name}!${c.ref}`,c.value])));
 expect(values).toMatchObject({'Sheet1!A1':'4','Sheet1!B1':'','Sheet1!C1':'','Sheet1!D1':'101','Sheet1!E1':'','第二表!A1':'','第二表!B1':'100','第二表!C1':''});expect(after.needsRecalculation).toBe(true);expect(set.changes[0].summary).toContain('保留 2 个');
 const next=files.newChangeSet(id,'s');await docs.apply(id,doc.path,after.version,[{type:'cell',sheetId:'rId1',ref:'D1',value:'',formula:'200+1'}],next);const final=await docs.inspect(id,doc.path);if(final.kind!=='xlsx')throw Error();expect(final.sheets[0].cells.find(c=>c.ref==='D1')?.value).toBe('');expect(final.sheets[1].cells.find(c=>c.ref==='B1')?.value).toBe('100');
});
it('reads asymmetric sheets with independent cursors and consistent cross-workbook cell order',async()=>{
 const doc=await workbook();if(doc.kind!=='xlsx')throw Error();const page=paginateExcel(doc,{offset:4,limit:3});expect(page.sheets.map(s=>s.cells.map(c=>c.ref))).toEqual([['E1'],['A1','B1']]);expect(page.pagination.nextOffset).toBe(7);const directed=paginateExcel(doc,{sheet:'第二表',offset:1,limit:1});expect(directed.sheets[0].cells[0].ref).toBe('B1');expect(directed.sheets[0].pagination.nextOffset).toBe(2);expect(paginateExcel(doc,{sheet:'rId1',offset:0,limit:1}).sheets[0].cells[0].ref).toBe('A1');
});
it('keeps unsupported Unicode as a native PDF note but refuses unsupported font text without any file write',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage();await writeFile(join(root,'work','a.pdf'),await pdf.save());const doc=await docs.inspect(id,'a.pdf'),before=await files.bytes(id,'a.pdf');await expect(docs.apply(id,doc.path,doc.version,[{type:'pdf_text',page:1,x:20,y:20,text:'中文 🧑‍🚀'}],files.newChangeSet(id,'s'))).rejects.toThrow('字体不支持');expect(await files.bytes(id,doc.path)).toEqual(before);const set=files.newChangeSet(id,'s');await docs.apply(id,doc.path,doc.version,[{type:'pdf_note',page:1,x:20,y:20,text:'🧑‍🚀 中文 Unicode'}],set);const opened=await PDFDocument.load(await files.bytes(id,doc.path));expect(opened.getPage(0).node.Annots()?.size()).toBe(1);await files.undo(id,set.id);expect(await files.bytes(id,doc.path)).toEqual(before);
});
it('openpyxl data_only sees valid independent caches and no stale dependent results',async()=>{
 const doc=await workbook();await docs.apply(id,doc.path,doc.version,[{type:'cell',sheetId:'rId1',ref:'A1',value:'4'}],files.newChangeSet(id,'s'));
 if(process.env.SIMPLE_AGENT_INTEROP_OUTPUT)await writeFile(process.env.SIMPLE_AGENT_INTEROP_OUTPUT,await files.bytes(id,doc.path));
 const python=process.env.SIMPLE_AGENT_PYTHON??(process.platform==='win32'?join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe'):'python3');
 const code=`import openpyxl,sys,json\np=sys.argv[1]\nv=openpyxl.load_workbook(p,data_only=True)\nf=openpyxl.load_workbook(p,data_only=False)\nassert v['Sheet1']['B1'].value is None\nassert v['Sheet1']['D1'].value == 101\nassert v['第二表']['A1'].value is None\nassert v['第二表']['B1'].value == 100\nassert f['第二表']['A1'].value == '=Sheet1!C1*2'\nassert f.calculation.fullCalcOnLoad\nprint('cache interoperability OK')`;
 const result=spawnSync(python,['-c',code,join(root,'work','book.xlsx')],{encoding:'utf8',timeout:15000});expect(result.stderr).not.toContain('Traceback');expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('interoperability OK');
});

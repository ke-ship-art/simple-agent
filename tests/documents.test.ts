import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { Store } from '../src/main/store';
import { Files } from '../src/main/workspace';
import { Documents, unpack } from '../src/main/documents';

let root: string, files: Files, docs: Documents, id: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'simple-agent-office-')); await mkdir(join(root, 'workspace')); const store = new Store(join(root, 'data')); await store.init(); files = new Files(store); id = (await files.add(join(root, 'workspace'))).id; docs = new Documents(files, join(process.cwd(), 'resources')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
it('edits text spanning styled Word runs while preserving untouched parts and complex fields', async () => {
  const bytes = zipSync({ 'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>你好</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>世界！</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格文字</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t>复杂域</w:t></w:r></w:p></w:body></w:document>`), 'word/styles.xml': strToU8('keep-original-style'), 'word/media/image1.png': new Uint8Array([1, 2, 3, 4]) });
  const entries = unpack(bytes); entries['word/document.xml'] = strToU8(strFromU8(entries['word/document.xml']).replace('</w:body>', '<w:p><w:fldSimple w:instr="DATE"><w:r><w:t>日期域</w:t></w:r></w:fldSimple></w:p><w:sdt><w:sdtContent><w:p><w:r><w:t>内容控件</w:t></w:r></w:p></w:sdtContent></w:sdt></w:body>'));
  await writeFile(join(root, 'workspace', 'styled.docx'), zipSync(entries)); const doc = await docs.inspect(id, 'styled.docx'); if (doc.kind !== 'docx') throw new Error(); expect(doc.blocks[1].type).toBe('table-cell'); expect(doc.blocks.slice(2).every(b => !b.editable)).toBe(true);
  await docs.apply(id, doc.path, doc.version, [{ type: 'word_replace', blockId: 'p:0', oldText: '好世界', newText: '好朋友' }], files.newChangeSet(id, 'manual'));
  const parts = unpack(await files.bytes(id, doc.path)); const reread = await docs.inspect(id, doc.path); if (reread.kind !== 'docx') throw new Error(); expect(reread.blocks[0].text).toBe('你好朋友！'); expect(reread.blocks[0].runs).toEqual([{text:'你好',bold:true},{text:'朋友！',italic:true}]); expect(strFromU8(parts['word/document.xml'])).toContain('w:i'); expect(strFromU8(parts['word/styles.xml'])).toBe('keep-original-style'); expect(parts['word/media/image1.png']).toEqual(new Uint8Array([1, 2, 3, 4]));
  const edited = await docs.inspect(id, doc.path); await expect(docs.apply(id, doc.path, edited.version, [{ type: 'word_replace', blockId: 'p:2', oldText: '复杂域', newText: '破坏' }], files.newChangeSet(id, 'manual'))).rejects.toThrow('复杂');
});
it('keeps Excel styles, merges, other sheets, invalidates formula caches and rejects array edits', async () => {
  let doc = await docs.create(id, 'book.xlsx', '', files.newChangeSet(id, 'manual')); const parts = unpack(await files.bytes(id, 'book.xlsx'));
  const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  parts['xl/worksheets/sheet1.xml'] = strToU8(`<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" s="2"><v>3</v></c><c r="B1"><f>A1*2</f><v>6</v></c><c r="D1"><f t="array" ref="D1:D2">A1:A2</f><v>3</v></c></row></sheetData><mergeCells><mergeCell ref="A3:B3"/></mergeCells></worksheet>`);
  parts['xl/styles.xml'] = strToU8('unchanged-styles'); parts['xl/worksheets/untouched.xml'] = strToU8('unchanged-other-sheet');
  parts['xl/workbook.xml'] = strToU8(strFromU8(parts['xl/workbook.xml']).replace('</sheets>', '<sheet name="第二表" sheetId="2" r:id="rId2"/></sheets>'));
  parts['xl/_rels/workbook.xml.rels'] = strToU8(strFromU8(parts['xl/_rels/workbook.xml.rels']).replace('</Relationships>', '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
  parts['xl/worksheets/sheet2.xml'] = strToU8(`<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>另一工作表</t></is></c></row></sheetData></worksheet>`);
  await writeFile(join(root, 'workspace', 'book.xlsx'), zipSync(parts)); doc = await docs.inspect(id, 'book.xlsx');
  await docs.apply(id, doc.path, doc.version, [{ type: 'cell', sheetId: 'rId1', ref: 'A1', value: '4' }, { type: 'cell', sheetId: 'rId1', ref: 'C1', value: '', formula: 'SUM(A1:B1)' }], files.newChangeSet(id, 'manual'));
  const edited = await docs.inspect(id, doc.path); if (edited.kind !== 'xlsx') throw new Error(); expect(edited.needsRecalculation).toBe(true); expect(edited.sheets[0].cells.find(c => c.ref === 'B1')?.value).toBe(''); expect(edited.sheets[0].cells.find(c => c.ref === 'A1')?.style).toBe('2'); expect(edited.sheets[0].merges).toEqual(['A3:B3']);
  expect(edited.sheets).toHaveLength(2); expect(edited.sheets[1].cells[0].value).toBe('另一工作表');
  const final = unpack(await files.bytes(id, doc.path)); expect(strFromU8(final['xl/styles.xml'])).toBe('unchanged-styles'); expect(strFromU8(final['xl/worksheets/untouched.xml'])).toBe('unchanged-other-sheet');
  for (const ref of ['D1', 'D2', 'B3']) await expect(docs.apply(id, doc.path, edited.version, [{ type: 'cell', sheetId: 'rId1', ref, value: 'bad' }], files.newChangeSet(id, 'manual'))).rejects.toThrow();
});
it('adds native Unicode PDF notes and Chinese text, merges/reorders pages and restores exact bytes', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([300, 400]); const second = pdf.addPage([400, 300]); second.setRotation({ type: 'degrees' as any, angle: 90 }); const original = await pdf.save(); await writeFile(join(root, 'workspace', 'a.pdf'), original);
  const other = await PDFDocument.create(); other.addPage(); await writeFile(join(root, 'workspace', 'b.pdf'), await other.save());
  const doc = await docs.inspect(id, 'a.pdf'); const set = files.newChangeSet(id, 'manual'); await docs.apply(id, doc.path, doc.version, [{ type: 'pdf_note', page: 1, x: 20, y: 20, text: '中文批注' }, { type: 'pdf_text', page: 1, x: 30, y: 100, text: '你好，世界' }, { type: 'pdf_merge', paths: ['b.pdf'] }, { type: 'pdf_pages', pages: [2, 1, 3] }], set);
  const edited = await PDFDocument.load(await files.bytes(id, 'a.pdf')); expect(edited.getPageCount()).toBe(3); expect(edited.getPages()[0].getRotation().angle).toBe(90); expect(edited.getPages()[1].node.Annots()?.size()).toBe(1); await files.undo(id); expect(await readFile(join(root, 'workspace', 'a.pdf'))).toEqual(Buffer.from(original));
});
it('creates valid basic Word, Excel and PDF packages that reopen', async () => { for (const ext of ['docx', 'xlsx', 'pdf']) { const doc = await docs.create(id, `新文件.${ext}`, '中文初始内容', files.newChangeSet(id, 'manual')); expect(doc.kind).toBe(ext); } });
it('splits PDF pages to a new file, preserves source bytes and guards conflicts', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([300, 400]); pdf.addPage([400, 300]); const original = await pdf.save(); await writeFile(join(root, 'workspace', 'source.pdf'), original);
  const doc = await docs.inspect(id, 'source.pdf');
  await docs.exportPdf(id, doc.path, doc.version, 'split/第二页.pdf', [2], files.newChangeSet(id, 'manual'));
  const exported = await PDFDocument.load(await files.bytes(id, 'split/第二页.pdf')); expect(exported.getPageCount()).toBe(1); expect(exported.getPages()[0].getWidth()).toBe(400); expect(await files.bytes(id, doc.path)).toEqual(Buffer.from(original));
  await expect(docs.exportPdf(id, doc.path, doc.version, 'source.pdf', [1], files.newChangeSet(id, 'manual'))).rejects.toThrow('版本');
  await expect(docs.exportPdf(id, doc.path, doc.version, '../outside.pdf', [1], files.newChangeSet(id, 'manual'))).rejects.toThrow();
  await files.undo(id); await expect(files.bytes(id, 'split/第二页.pdf')).rejects.toThrow(); expect(await files.bytes(id, doc.path)).toEqual(Buffer.from(original));
});
it('rejects ZIP bomb size metadata before decompressing', () => { const bytes = zipSync({ 'word/document.xml': strToU8('small') }); const view = new DataView(bytes.buffer); for (let i = 0; i < bytes.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 300 * 1024 * 1024, true); break; } expect(() => unpack(bytes)).toThrow('解压'); });

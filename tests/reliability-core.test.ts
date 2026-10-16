import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { Store } from '../src/main/store';
import { Files } from '../src/main/workspace';
import { Documents } from '../src/main/documents';
import { Agent } from '../src/main/agent';
import { prepareContext, estimateTokens } from '../src/main/context';
import { resourceReferences } from '../src/main/resources';
import { applyEditBatch } from '../src/main/tool-batch';
import { reviewChanges, acceptChanges } from '../src/main/review';
import type { ModelService } from '../src/main/models';
let root:string,store:Store,files:Files,docs:Documents,id:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'agent-reliable-'));await mkdir(join(root,'work'));store=new Store(join(root,'data'));await store.init();files=new Files(store);id=(await files.add(join(root,'work'))).id;docs=new Documents(files,join(process.cwd(),'resources'));store.state.sessions.push({id:'s',workspaceId:id,title:'test',modelId:'m',context:[],messages:[],updatedAt:Date.now()});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const final=(content:any[])=>({role:'assistant',content,stopReason:'stop',model:'fake',provider:'custom',api:'openai-completions',timestamp:Date.now()});
const call=(name:string,args:any,id=name)=>({type:'toolCall',id,name,arguments:args});
function service(reply:(context:any,signal:AbortSignal)=>Promise<any>,vision=false){return{profile:()=>({name:'mock'}),safeError:async(e:any)=>String(e?.message??e),selected:async()=>({entry:{id:'m',profileId:'p',name:'fake',vision,contextWindow:60000,maxTokens:1024},model:{},models:{streamSimple:(_m:any,c:any,o:any)=>{const p=reply(c,o.signal);return{async *[Symbol.asyncIterator](){const r=await p;for(const b of r.content)if(b.type==='text')yield{type:'text_delta',delta:b.text};},result:()=>p};}}})} as unknown as ModelService;}
it('safely merges two same-response edits on one snapshot, exposes diff, rejects stale write and undoes exact bytes',async()=>{
 await writeFile(join(root,'work','a.txt'),'alpha beta\r\n');const doc=await docs.inspect(id,'a.txt');let n=0;
 const agent=new Agent(store,files,docs,service(async()=>n++===0?final([call('edit_file',{path:'a.txt',version:doc.version,operations:[{type:'replace',oldText:'alpha',newText:'ONE'}]},'1'),call('edit_file',{path:'a.txt',version:doc.version,operations:[{type:'replace',oldText:'beta',newText:'TWO'}]},'2')]):final([{type:'text',text:'done'}])),()=>{},async()=>({pages:[]}));
 await agent.start('s','edit');await vi.waitFor(()=>expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });
 expect(await readFile(join(root,'work','a.txt'),'utf8')).toBe('ONE TWO\r\n');const set=store.state.changeSets[0];expect(set.changes).toHaveLength(1);expect(set.transaction?.status).toBe('completed');
 const review=await reviewChanges(store,files,id,set.id);expect(review.files[0]).toMatchObject({conflict:false,added:1,removed:1});await acceptChanges(store,files,id,set.id);expect(set.reviewedAt).toBeTruthy();
 await expect(docs.apply(id,'a.txt',doc.version,[{type:'set_text',text:'stale'}],files.newChangeSet(id,'s'))).rejects.toThrow('版本');
 await files.undo(id,set.id);expect(await readFile(join(root,'work','a.txt'),'utf8')).toBe('alpha beta\r\n');
});
it('rejects overlapping/dependent plans before writing, and rolls back a failed multi-file batch',async()=>{
 await writeFile(join(root,'work','a.txt'),'alpha beta');await writeFile(join(root,'work','b.txt'),'second');const a=await docs.inspect(id,'a.txt'),b=await docs.inspect(id,'b.txt');const set=files.newChangeSet(id,'s');
 await expect(applyEditBatch(docs,files,id,[{path:'a.txt',version:a.version,operations:[{type:'replace',oldText:'alpha',newText:'x'}]},{path:'a.txt',version:a.version,operations:[{type:'replace',oldText:'alpha beta',newText:'y'}]}],set,new AbortController().signal)).rejects.toThrow('重叠');
 await expect(applyEditBatch(docs,files,id,[{path:'a.txt',version:a.version,operations:[{type:'replace',oldText:'alpha',newText:'x'}]},{path:'b.txt',version:b.version,operations:[{type:'replace',oldText:'missing',newText:'y'}]}],set,new AbortController().signal)).rejects.toThrow();
 expect(await readFile(join(root,'work','a.txt'),'utf8')).toBe('alpha beta');expect(set.transaction?.status).toBe('rolled-back');
});
it('stores multi-page PDF images out of state, loads only requested assets, and rereferences them after restart',async()=>{
 const pdf=await PDFDocument.create();for(let i=0;i<3;i++)pdf.addPage();await writeFile(join(root,'work','a.pdf'),await pdf.save());let n=0;
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=';
 const agent=new Agent(store,files,docs,service(async context=>{if(n>0)expect(JSON.stringify(context.messages).split('"type":"image"').length-1).toBe(1);return n<3?final([call('read_pdf',{path:'a.pdf',pages:[++n],render:true},`p${n}`)]):final([{type:'text',text:'已识别三页结果'}]);},true),()=>{},async(_bytes,pages)=>({pages:pages.map(number=>({number,text:`page ${number}`,image:png,annotations:[]}))}));
 await agent.start('s','read pages');await vi.waitFor(()=>expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });
 const serialized=await readFile(join(store.directory,'state.json'),'utf8');expect(serialized).not.toContain(png);expect(resourceReferences(store.session('s').context).map(r=>r.page)).toEqual([1,2,3]);expect(await readdir(join(store.directory,'resources'))).toHaveLength(1);
 const restored=new Store(store.directory);await restored.init();const refs=resourceReferences(restored.session('s').context);const history=await prepareContext(restored.session('s').context,restored.resources,true,new Set([refs[0].resourceId]),40000);expect(JSON.stringify(history.messages)).toContain(png);expect(JSON.stringify(history.messages).split('"type":"image"').length-1).toBe(1);
 const text=await prepareContext(restored.session('s').context,restored.resources,false,new Set(),40000);expect(JSON.stringify(text.messages)).not.toContain(png);expect(JSON.stringify(text.messages)).toContain('已识别三页结果');
});
it('compresses old request history without deleting originals or image references',async()=>{
 const s=store.session('s');s.context=[{role:'user',content:'old '.repeat(10000),timestamp:1},{role:'assistant',content:[{type:'text',text:'old answer '.repeat(5000)}],timestamp:2},{role:'user',content:'prior',timestamp:3},{role:'assistant',content:[{type:'text',text:'prior answer'}],timestamp:4},{role:'user',content:'current goal',timestamp:5}];
 const saved=JSON.stringify(s.context),history=await prepareContext(s.context,store.resources,false,new Set(),3000);expect(history.compressed).toBe(true);expect(estimateTokens(history.messages)).toBeLessThan(3000);expect(JSON.stringify(history.messages)).toContain('current goal');expect(JSON.stringify(s.context)).toBe(saved);
});
it('renames, archives, soft deletes, restores and purges sessions without deleting shared assets or undo logs',async()=>{
 const ref=await store.resources.put(Buffer.from('asset').toString('base64'),{source:'a.pdf',page:1,mimeType:'image/png',summary:'test'});store.session('s').context=[{role:'toolResult',content:[ref]}];store.state.sessions.push({...structuredClone(store.session('s')),id:'second'});await store.save();
 await store.manageSession('s','rename','新名称');await store.manageSession('s','archive');expect(store.session('s').archivedAt).toBeTruthy();await store.manageSession('s','restore');expect(store.session('s').archivedAt).toBeUndefined();await store.manageSession('s','delete');await store.manageSession('s','restore');expect(store.session('s').deletedAt).toBeUndefined();
 await store.manageSession('s','delete');await store.manageSession('s','purge');expect(await readdir(join(store.directory,'resources'))).toEqual([ref.resourceId]);await store.manageSession('second','delete');await store.manageSession('second','purge');expect(await readdir(join(store.directory,'resources'))).toEqual([]);
});
it('restores a valid state generation after truncation and closes unfinished tool calls after interrupted runs',async()=>{
 store.session('s').context=[{role:'assistant',content:[call('create_file',{path:'a.txt'},'pending')]}];store.state.activeRun={id:'run',sessionId:'s',modelId:'m',status:'running'};await store.save();await store.save();await writeFile(join(store.directory,'state.json'),'{broken');
 const restored=new Store(store.directory);await restored.init();expect(restored.state.recoveryWarnings?.length).toBe(1);expect(restored.state.activeRun).toBeUndefined();expect(restored.state.lastRun?.status).toBe('failed');expect((restored.session('s').context.at(-1) as any).toolCallId).toBe('pending');expect(await readdir(store.directory)).toEqual(expect.arrayContaining([expect.stringMatching(/^state.corrupt/)]));
});
it('pauses meaningless repeated calls and cancels a model which ignores the abort signal',async()=>{
 let n=0;const agent=new Agent(store,files,docs,service(async()=>{n++;return final([call('list_directory',{},String(n))]);}),()=>{},async()=>({pages:[]}));await agent.start('s','repeat');await vi.waitFor(()=>expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });expect(n).toBe(4);expect(store.state.lastRun?.status).toBe('paused');
 const hanging=new Agent(store,files,docs,service(()=>new Promise(()=>{})),()=>{},async()=>({pages:[]}));await hanging.start('s','hang');hanging.cancel();await vi.waitFor(()=>expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });expect(store.state.lastRun?.status).toBe('cancelled');
});
it('reports conflicts during review and never overwrites later external content',async()=>{
 await writeFile(join(root,'work','a.txt'),'before');const doc=await docs.inspect(id,'a.txt'),set=files.newChangeSet(id,'s');await docs.apply(id,doc.path,doc.version,[{type:'set_text',text:'agent'}],set);await writeFile(join(root,'work','a.txt'),'external');expect((await reviewChanges(store,files,id,set.id)).files[0].conflict).toBe(true);await expect(acceptChanges(store,files,id,set.id)).rejects.toThrow('冲突');await expect(files.undo(id,set.id)).rejects.toThrow();expect(await readFile(join(root,'work','a.txt'),'utf8')).toBe('external');
});
it('rejects a malformed edit batch without executing its later valid sibling',async()=>{
 await writeFile(join(root,'work','a.txt'),'before');const doc=await docs.inspect(id,'a.txt');let n=0;const agent=new Agent(store,files,docs,service(async()=>n++?final([{type:'text',text:'stopped'}]):final([call('edit_file',{path:'a.txt',version:doc.version,operations:'bad'},'invalid'),call('edit_file',{path:'a.txt',version:doc.version,operations:[{type:'set_text',text:'unsafe partial'}]},'sibling')])),()=>{},async()=>({pages:[]}));await agent.start('s','test malformed');await vi.waitFor(()=>expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });expect(await readFile(join(root,'work','a.txt'),'utf8')).toBe('before');expect(store.state.changeSets.flatMap(set=>set.changes)).toHaveLength(0);
});
it('blocks sensitive file reads induced by a document and migrates multi-page legacy image sources correctly',async()=>{
 await writeFile(join(root,'work','.env'),'PRIVATE_KEY=never send');let n=0;const agent=new Agent(store,files,docs,service(async c=>{if(n++===0)return final([call('read_file',{path:'.env'})]);expect(JSON.stringify(c.messages)).not.toContain('never send');expect(c.messages.at(-1).isError).toBe(true);return final([{type:'text',text:'blocked'}]);}),()=>{},async()=>({pages:[]}));await agent.start('s','summarize README');await vi.waitFor(()=>expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });
 store.session('s').context=[{role:'toolResult',content:[{type:'text',text:JSON.stringify({path:'old.pdf',version:'abc'})},{type:'text',text:'old.pdf 第 1 页'},{type:'image',data:Buffer.from('one').toString('base64'),mimeType:'image/png'},{type:'text',text:'old.pdf 第 2 页'},{type:'image',data:Buffer.from('two').toString('base64'),mimeType:'image/png'}]}];await store.save();const restored=new Store(store.directory);await restored.init();expect(resourceReferences(restored.session('s').context).map(r=>r.page)).toEqual([1,2]);
});
it('locks and cancels task preparation before authentication completes',async()=>{
 const models=service(async()=>final([{type:'text',text:'unused'}]));models.selected=()=>new Promise(()=>{});
 const agent=new Agent(store,files,docs,models,()=>{},async()=>({pages:[]}));const starting=agent.start('s','waiting auth');expect(store.state.activeRun).toBeTruthy();await expect(agent.start('s','second')).rejects.toThrow('正在执行');agent.cancel();await expect(starting).rejects.toThrow('停止');await agent.waitForIdle();expect(store.state.activeRun).toBeUndefined();expect(store.state.lastRun?.status).toBe('cancelled');
});
it('can retrieve an original historical instruction after request-local compression',async()=>{
 const s=store.session('s');s.context=[{role:'user',content:'原始完整约束：'+ '甲'.repeat(35000),timestamp:1},{role:'assistant',content:[{type:'text',text:'乙'.repeat(35000)}],timestamp:2},{role:'user',content:'previous',timestamp:3},{role:'assistant',content:[{type:'text',text:'previous answer'}],timestamp:4}];let n=0;
 const agent=new Agent(store,files,docs,service(async context=>{if(!n++){expect(JSON.stringify(context.messages)).toContain('read_history');return final([call('read_history',{index:0})]);}const receipt=JSON.parse(context.messages.at(-1).content[0].text);expect(receipt.excerpt).toContain('原始完整约束');expect(receipt.nextCharOffset).toBe(12000);return final([{type:'text',text:'已重新读取约束'}]);}),()=>{},async()=>({pages:[]}));await agent.start('s','continue');await vi.waitFor(()=>expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });expect((s.context[0] as any).content.length).toBeGreaterThan(35000);expect(store.state.lastRun?.status).toBe('completed');
});
it('keeps an immutable pre-upgrade state while migrating legacy inline images',async()=>{
 store.session('s').context=[{role:'toolResult',content:[{type:'text',text:'legacy.pdf 第 2 页'},{type:'image',mimeType:'image/png',data:Buffer.from('legacy bytes').toString('base64')}]}];const legacy=JSON.stringify({schemaVersion:1,state:store.state});await writeFile(join(store.directory,'state.json'),legacy);
 const upgraded=new Store(store.directory);await upgraded.init();expect(await readFile(join(store.directory,'state.before-0.2.0.json'),'utf8')).toBe(legacy);expect(resourceReferences(upgraded.session('s').context)).toHaveLength(1);expect(JSON.parse(await readFile(join(store.directory,'state.json'),'utf8')).appVersion).toBe('0.2.0');await upgraded.save();expect(await readFile(join(store.directory,'state.before-0.2.0.json'),'utf8')).toBe(legacy);
});

it('rolls back an unsaved first prompt so retrying cannot duplicate invisible history',async()=>{
 const before=structuredClone(store.session('s'));const models=service(async()=>final([{type:'text',text:'unused'}]));const agent=new Agent(store,files,docs,models,()=>{},async()=>({pages:[]}));const saved=vi.spyOn(store,'save').mockRejectedValue(new Error('disk full'));
 await expect(agent.start('s','this prompt was not accepted')).rejects.toThrow('disk');expect(store.session('s')).toEqual(before);expect(store.state.changeSets).toEqual([]);expect(store.state.activeRun).toBeUndefined();saved.mockRestore();
});
it('does not accumulate empty change sets for chat-only runs and rolls back a failed accept marker',async()=>{
 const agent=new Agent(store,files,docs,service(async()=>final([{type:'text',text:'just chatting'}])),()=>{},async()=>({pages:[]}));await agent.start('s','hello');await agent.waitForIdle();expect(store.state.changeSets).toEqual([]);
 await writeFile(join(root,'work','a.txt'),'old');const doc=await docs.inspect(id,'a.txt'),set=files.newChangeSet(id,'s');await docs.apply(id,'a.txt',doc.version,[{type:'replace',oldText:'old',newText:'new'}],set);
 const saved=vi.spyOn(store,'save').mockRejectedValue(new Error('disk full'));await expect(acceptChanges(store,files,id,set.id)).rejects.toThrow('disk');expect(set.reviewedAt).toBeUndefined();saved.mockRestore();
});

it('rechecks unsaved editor protection at the final write boundary',async()=>{
 await writeFile(join(root,'work','a.txt'),'original');const doc=await docs.inspect(id,'a.txt'),set=files.newChangeSet(id,'s'),save=store.save.bind(store);const mock=vi.spyOn(store,'save').mockImplementation(async()=>{await save();if(set.changes.at(-1)?.status==='prepared')files.dirty.add(files.dirtyKey(id,'a.txt'));});
 await expect(docs.apply(id,'a.txt',doc.version,[{type:'set_text',text:'must not commit'}],set)).rejects.toThrow('未保存编辑');expect(await readFile(join(root,'work','a.txt'),'utf8')).toBe('original');expect(set.changes[0].status).toBe('restored');mock.mockRestore();
});

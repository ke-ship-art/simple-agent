import { expect, it } from 'vitest';
import { reconcileState,readDrafts } from '../src/renderer/src/ui-state';
import { externalUrl } from '../src/main/external-url';
import { OperationGate } from '../src/main/operation-gate';
import { emptyState } from '../src/main/store';
import { parseTsv, serializeTsv } from '../src/shared/tabular';

it('round trips spreadsheet cells containing line breaks, tabs, quotes and empty values',()=>{
  const rows=[['中文\n第二行','a\tb','他说"好"',''],['=SUM(A1:A2)','normal','','tail']];
  expect(parseTsv(serializeTsv(rows)+'\r\n')).toEqual(rows);
  expect(parseTsv('A\tB\r\n1\t2\r\n')).toEqual([['A','B'],['1','2']]);
  expect(()=>parseTsv('"unfinished')).toThrow('未闭合');expect(()=>parseTsv('"closed"extra')).toThrow('格式无效');expect(()=>parseTsv('x'.repeat(200001))).toThrow('过大');
});

it('does not rewind a streamed answer when an older state reply arrives',()=>{
  const incoming={...emptyState(),activeRun:{id:'r',sessionId:'s',modelId:'m',status:'running' as const},sessions:[{id:'s',workspaceId:'w',title:'t',modelId:'m',context:[],updatedAt:0,messages:[{id:'a',role:'assistant' as const,text:'你',timestamp:0}]}]};
  const live=new Map([['a','你好世界']]);expect(reconcileState(incoming,live).sessions[0].messages[0].text).toBe('你好世界');expect(incoming.sessions[0].messages[0].text).toBe('你');
  incoming.sessions[0].messages[0].text='你好世界！';expect(reconcileState(incoming,live).sessions[0].messages[0].text).toBe('你好世界！');expect(live.get('a')).toBe('你好世界！');
  const complete=reconcileState({...incoming,activeRun:undefined},live);expect(complete.sessions[0].messages[0].text).toBe('你好世界！');expect(live.size).toBe(0);
});
it('permits deliberate web links and rejects file, command and credential URLs',()=>{
  expect(externalUrl('https://example.com/a?q=hello#b')).toBe('https://example.com/a?q=hello#b');
  for(const url of ['file:///C:/Windows/a.exe','javascript:alert(1)','ms-settings:','https://user:secret@example.com','https://example.com\n/a'])expect(()=>externalUrl(url)).toThrow();
});
it('blocks task startup during a settings request and releases the gate after cancellation',async()=>{
  const gate=new OperationGate();let signal:AbortSignal|undefined;
  const waiting=gate.run(s=>{signal=s;return new Promise((_resolve,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}));});
  expect(()=>gate.assertIdle()).toThrow('设置');await expect(gate.run(async()=>0)).rejects.toThrow('设置');gate.cancel();expect(signal?.aborted).toBe(true);await expect(waiting).rejects.toThrow('取消');expect(()=>gate.assertIdle()).not.toThrow();expect(await gate.run(async()=>42)).toBe(42);
});

it('loads valid local drafts while rejecting corrupt or oversized draft entries',()=>{
 const draft={input:'尚未发送的中文',references:['带 空格.docx']};expect(readDrafts(JSON.stringify({s:draft,bad:{input:'x',references:[42]},large:{input:'x'.repeat(50001),references:[]}}))).toEqual({s:draft});expect(readDrafts('{broken')).toEqual({});expect(readDrafts('null')).toEqual({});
});

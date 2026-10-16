import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/main/store';
import { Files } from '../src/main/workspace';
import { Documents } from '../src/main/documents';
import { Agent, compatibleHistory, estimateTokens } from '../src/main/agent';
import type { ModelService } from '../src/main/models';

let root: string, store: Store, files: Files, docs: Documents, id: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'simple-agent-loop-')); await mkdir(join(root, 'workspace')); store = new Store(join(root, 'state')); await store.init(); files = new Files(store); docs = new Documents(files, join(process.cwd(), 'resources')); id = (await files.add(join(root, 'workspace'))).id; store.state.sessions.push({ id: 'session', workspaceId: id, title: 'test', modelId: 'model', messages: [], context: [], updatedAt: Date.now() }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function fakeService(reply: (context: any, signal: AbortSignal, options?: any) => Promise<any>) {
  return { profile: () => ({ name: 'fake' }), safeError: async (error: any) => String(error.message ?? error), selected: async () => ({ entry: { id: 'model', name: 'Fake', profileId: 'fake', vision: false, contextWindow: 100000, maxTokens: 1024 }, model: {}, models: { streamSimple: (_model: any, context: any, options: any) => { const promise = reply(context, options.signal, options); return { async *[Symbol.asyncIterator]() { const final = await promise; for (const b of final.content) if (b.type === 'text') yield { type: 'text_delta', delta: b.text }; }, result: () => promise }; } } }) } as unknown as ModelService;
}
const final = (content: any[]) => ({ role: 'assistant', content, stopReason: 'stop', model: 'fake', provider: 'custom', api: 'openai-completions', timestamp: Date.now() });
it('freezes reasoning throughout tool loops and records the actual level on replies', async () => {
  const levels: string[] = []; let count = 0;
  const service = fakeService(async (_context, _signal, options) => {
    levels.push(options.reasoning);
    if (!count++) { selection.entry.reasoningLevel = 'low'; return final([{ type: 'toolCall', id: 'list', name: 'list_directory', arguments: {} }]); }
    return final([{ type: 'text', text: 'done' }]);
  });
  const selection = await service.selected('model'); selection.entry.reasoning = true; selection.entry.reasoningLevel = 'high'; selection.entry.supportedReasoningLevels = ['low', 'medium', 'high']; selection.model.api = 'openai-responses';
  service.selected = async () => selection;
  const run = await new Agent(store, files, docs, service, () => undefined, async () => ({ pages: [] })).start('session', 'list');
  await vi.waitFor(() => expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });
  expect(run.reasoningLevel).toBe('high'); expect(levels).toEqual(['high', 'high']);
  expect(store.session('session').messages.filter(message => message.role === 'assistant').map(message => message.reasoningLevel)).toEqual(['high', 'high']);
});
it('reports a reasoning-only truncated response without claiming completion or executing tools', async () => {
  const service = fakeService(async () => ({ ...final([{ type: 'thinking', thinking: 'hidden' }]), stopReason: 'length' }));
  await new Agent(store, files, docs, service, () => undefined, async () => ({ pages: [] })).start('session', 'limited');
  await vi.waitFor(() => expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 }); expect(store.session('session').messages.at(-1)?.text).toContain('输出上限'); expect(store.state.changeSets.flatMap(set=>set.changes)).toHaveLength(0); expect(store.session('session').context).toHaveLength(1);
});
it('runs real create/edit tools, records the selected model and provides an undoable change set', async () => {
  let n = 0;
  const service = fakeService(async context => {
    if (n++ === 0) return final([{ type: 'toolCall', id: 'call1', name: 'create_file', arguments: { path: '结果.md', content: '初稿' } }]);
    if (n === 2) { const result = JSON.parse(context.messages.at(-1).content[0].text); return final([{ type: 'toolCall', id: 'call2', name: 'edit_file', arguments: { path: '结果.md', version: result.version, operations: [{ type: 'replace', oldText: '初稿', newText: '完成' }] } }]); }
    return final([{ type: 'text', text: '已完成修改。' }]);
  });
  const agent = new Agent(store, files, docs, service, () => undefined, async () => ({ pages: [] })); await agent.start('session', '创建并修改文件'); await vi.waitFor(() => expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });
  expect(await readFile(join(root, 'workspace', '结果.md'), 'utf8')).toBe('完成'); expect(store.session('session').messages.some(m => m.modelName === 'Fake · fake')).toBe(true); expect(store.state.changeSets[0].changes).toHaveLength(2); await files.undo(id);
});
it('rejects unknown tool calls and returns errors to the model without file changes', async () => {
  let n = 0;
  const service = fakeService(async context => { if (!n++) return final([{ type: 'toolCall', id: 'bad', name: 'run_shell', arguments: { command: 'erase' } }]); expect(context.messages.at(-1).isError).toBe(true); return final([{ type: 'text', text: '工具不可用' }]); });
  await new Agent(store, files, docs, service, () => undefined, async () => ({ pages: [] })).start('session', 'test'); await vi.waitFor(() => expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 }); expect(store.state.changeSets.flatMap(set=>set.changes)).toHaveLength(0);
});
it('cancels without starting later tools and refuses concurrent runs', async () => {
  const service = fakeService((_context, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
  const agent = new Agent(store, files, docs, service, () => undefined, async () => ({ pages: [] })); await agent.start('session', 'waiting'); await expect(agent.start('session', 'second')).rejects.toThrow('正在执行'); agent.cancel(); await vi.waitFor(() => expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 }); expect(store.session('session').messages.at(-1)?.text).toContain('保留');
});
it('rejects visual PDF reads for text-only models', async () => {
  let n = 0;
  const service = fakeService(async context => { if (!n++) return final([{ type: 'toolCall', id: 'pdf', name: 'read_pdf', arguments: { path: 'scan.pdf', pages: [1], render: true } }]); expect(context.messages.at(-1).content[0].text).toContain('不支持视觉'); return final([{ type: 'text', text: '请切换模型' }]); });
  const pdf = vi.fn(); await new Agent(store, files, docs, service, () => undefined, pdf).start('session', 'read scan'); await vi.waitFor(() => expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 }); expect(pdf).not.toHaveBeenCalled();
});
it('retains textual history and recognition results when switching away from vision', () => {
  const context = [{ role: 'toolResult', content: [{ type: 'text', text: 'page 1' }, { type: 'image', data: 'ABC', mimeType: 'image/png' }] }, { role: 'assistant', content: [{ type: 'text', text: '识别结果：金额100' }] }];
  const compatible = compatibleHistory(context, false); expect(JSON.stringify(compatible)).not.toContain('ABC'); expect(JSON.stringify(compatible)).toContain('金额100'); expect((context[0].content[1] as any).type).toBe('image'); expect(estimateTokens(compatible)).toBeLessThan(4000);
});
it('pauses at the model loop limit without claiming completion', async () => {
  let calls = 0;
  const service = fakeService(async () => final([{ type: 'toolCall', id: `list-${++calls}`, name: 'list_directory', arguments: {path:`changing-${calls}`} }]));
  await new Agent(store, files, docs, service, () => undefined, async () => ({ pages: [] })).start('session', '持续读取'); await vi.waitFor(() => expect(store.state.activeRun).toBeUndefined(), { timeout: 10000 });
  expect(calls).toBe(20); expect(store.session('session').messages.at(-1)?.text).toContain('20 次');
});

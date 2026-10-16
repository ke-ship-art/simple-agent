import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { unzipSync, zipSync, strToU8 } from 'fflate';

let app: ElectronApplication, page: Page, server: Server, root: string, requests: any[], runtimeErrors: string[];
async function launch() {
  const env = { ...process.env, SIMPLE_AGENT_TEST: '1', SIMPLE_AGENT_DATA_DIR: join(root, 'data') }; delete (env as any).ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(process.env.SIMPLE_AGENT_PACKAGED_EXE ? { executablePath: process.env.SIMPLE_AGENT_PACKAGED_EXE, args: [] } : { args: [resolve('out/main/index.js')] }), env, timeout: 30000 });
  await expect.poll(() => app.windows().length).toBe(2); page = app.windows().find(p => p.url().includes('index.html')) ?? app.windows()[1];
  for (const target of app.windows()) target.on('pageerror', e => runtimeErrors.push(e.message));
  await expect(page.getByText('Simple Agent', { exact: true })).toBeVisible();
  const versions = await app.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node })); expect(versions).toEqual({ electron: '44.5.1', node: '24.21.0' });
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, join(root, '工作区'));
}
const answer = (response: any, text?: string, call?: { name: string; arguments: object }) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const delta = call ? { tool_calls: [{ index: 0, id: 'call_' + Date.now(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: text ?? 'OK' };
  response.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock-agent', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'mock-agent', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
  response.end('data: [DONE]\n\n');
};
test.beforeEach(async ({}, info) => {
  root = info.outputPath('fixture'); await mkdir(join(root, '工作区'), { recursive: true }); await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, '工作区', 'note.md'), 'old\n中文内容\n');
  const pdf = await PDFDocument.create(); const first = pdf.addPage([300, 400]); const png = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=', 'base64')); first.drawImage(png, { x: 20, y: 20, width: 80, height: 80 }); pdf.addPage([400, 300]); await writeFile(join(root, '工作区', 'scan.pdf'), await pdf.save());
  requests = []; runtimeErrors = [];
  server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'mock-agent' }, { id: 'mock-vision' }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ ...body, testHeaders: request.headers });
    if(body.model==='slow-probe'){const timer=setTimeout(()=>answer(response,'late probe'),30000);response.on('close',()=>clearTimeout(timer));return;}
    if (!body.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model: 'mock-agent', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })); return; }
    const messages = body.messages, last = messages.at(-1), lastText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    if (last.role === 'user' && lastText.includes('模拟认证失败')) { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: '模拟认证失败 sk-fake-e2e-key-12345', type: 'invalid_api_key' } })); return; }
    if (last.role === 'user' && lastText.includes('模拟网络断开')) { response.destroy(); return; }
    if (messages.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('检查未保存 Word'))) {
      if (last.role !== 'tool') answer(response, undefined, { name: 'read_file', arguments: { path: '手动.docx' } });
      else { let result: any; try { result = JSON.parse(lastText); } catch {} if (result?.kind === 'docx') answer(response, undefined, { name: 'edit_file', arguments: { path: '手动.docx', version: result.version, operations: [{ type: 'word_replace', blockId: 'p:0', oldText: '原文', newText: 'AI 内容' }] } }); else answer(response, '未保存编辑发生冲突，文件保持原样。'); }
      return;
    }
    if (!body.tools?.length) { answer(response, 'OK'); return; }
    if (messages.some((m:any)=>m.role==='user'&&JSON.stringify(m.content).includes('异常退出恢复')) && last.role==='tool') {
      let result:any;try{result=JSON.parse(lastText);}catch{}
      if(result?.kind==='text'&&typeof result.text==='string')answer(response,undefined,{name:'edit_file',arguments:{path:'note.md',version:result.version,operations:[{type:'replace',oldText:'old',newText:'new'}]}});
      else {const timer=setTimeout(()=>answer(response,'done'),30000);response.on('close',()=>clearTimeout(timer));}return;
    }
    if (messages.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('慢响应'))) { const timer = setTimeout(() => answer(response, '晚到的回复'), 30000); response.on('close', () => clearTimeout(timer)); return; }
    if (messages.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('识别扫描'))) {
      if (!JSON.stringify(messages).includes('data:image/png')) answer(response, undefined, { name: 'read_pdf', arguments: { path: 'scan.pdf', pages: [1], render: true } }); else answer(response, '已收到指定扫描页图片。'); return;
    }
    if (last.role === 'tool') {
      let result: any; try { result = JSON.parse(lastText); } catch {}
      if (result?.kind === 'text' && typeof result.text === 'string') answer(response, undefined, { name: 'edit_file', arguments: { path: 'note.md', version: result.version, operations: [{ type: 'replace', oldText: 'old', newText: 'new' }] } }); else answer(response, '已将 old 替换为 new，文件已保存。');
    } else answer(response, undefined, { name: 'read_file', arguments: { path: 'note.md' } });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await launch();
});
test.afterEach(async () => { if(app)await app.evaluate(({dialog})=>{dialog.showMessageBoxSync=()=>1;}).catch(()=>undefined); await app?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });
async function configure() {
  const port = (server.address() as any).port;
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByLabel('配置名称', { exact: true }).fill('测试接入一'); await page.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${port}/v1`); await page.getByLabel('API Key', { exact: true }).fill('sk-fake-e2e-key-12345');
  await page.getByRole('button', { name: '保存接入配置', exact: true }).click(); await expect(page.getByText('接入配置已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '读取供应商模型目录' }).click(); await expect(page.getByLabel('供应商模型目录')).toBeVisible(); await page.getByLabel('供应商模型目录').selectOption('mock-agent'); await page.getByLabel('模型显示名称').fill('文件助手');
  await page.getByRole('button', { name: '添加模型', exact: true }).click(); await expect(page.getByText('模型已添加到聊天下拉菜单')).toBeVisible();
  await page.getByRole('button', { name: '测试连接', exact: true }).click(); await expect(page.getByText('连接成功：OK', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新增接入', exact: true }).click(); await page.getByLabel('配置名称', { exact: true }).fill('测试接入二'); await page.getByLabel('Base URL', { exact: true }).fill(`http://127.0.0.1:${port}/v1`); await page.getByLabel('认证方式').selectOption('none'); await page.getByRole('button', { name: '保存接入配置', exact: true }).click(); await expect(page.getByText('接入配置已保存', { exact: true })).toBeVisible();
  await page.getByLabel('模型显示名称').fill('视觉助手'); await page.getByLabel('模型 ID', { exact: true }).fill('mock-vision'); await page.getByLabel('支持图像 / 扫描 PDF').check(); await page.getByRole('button', { name: '添加模型', exact: true }).click(); await expect(page.getByText('模型已添加到聊天下拉菜单')).toBeVisible();
  await page.getByRole('button', { name: '完成', exact: true }).click(); await page.getByLabel('选择工作区', { exact: true }).click(); await expect(page.getByRole('button', { name: 'note.md', exact: true })).toBeVisible();
}
test('configuration, model dropdown, streamed tools, edits, undo and history survive restart', async ({}, info) => {
  await configure();
  expect(await page.getByLabel('聊天模型').locator('option').allTextContents()).toEqual(['文件助手 · 测试接入一', '视觉助手 ◉ · 测试接入二']);
  await page.getByRole('button', { name: 'note.md', exact: true }).click(); await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.getByLabel('聊天消息').fill('把 note.md 中的 old 修改成 new'); await page.getByLabel('发送消息', { exact: true }).click(); await expect(page.getByText('已将 old 替换为 new，文件已保存。', { exact: true })).toBeVisible(); await expect(page.getByText('准备就绪', { exact: true })).toBeVisible(); expect(await readFile(join(root, '工作区', 'note.md'), 'utf8')).toBe('new\n中文内容\n');
  await page.screenshot({ path: info.outputPath('desktop.png') });
  await page.getByRole('button', { name: '修改记录', exact: true }).click(); await page.getByRole('button', { name: '撤销最近一轮', exact: true }).click(); await expect.poll(() => readFile(join(root, '工作区', 'note.md'), 'utf8')).toBe('old\n中文内容\n'); await page.getByLabel('关闭修改记录').click();
  await page.getByLabel('聊天模型').selectOption({ label: '视觉助手 ◉ · 测试接入二' }); await expect(page.getByText('已将 old 替换为 new，文件已保存。', { exact: true })).toBeVisible();
  const state = await page.evaluate(() => window.agent.invoke<any>('state')); expect(state.profiles).toHaveLength(2); expect(state.sessions[0].messages.length).toBeGreaterThan(3); expect(JSON.stringify(state)).not.toContain('sk-fake');
  await expect.poll(async () => JSON.parse(await readFile(join(root, 'data', 'state.json'), 'utf8')).state.sessions[0].modelId).toBe(state.models[1].id); const persisted = JSON.parse(await readFile(join(root, 'data', 'state.json'), 'utf8')); expect(persisted.state.changeSets[0].undone).toBe(true);
  const encrypted = await readFile(join(root, 'data', 'credentials.enc')); expect(encrypted.toString()).not.toContain('sk-fake-e2e'); expect(runtimeErrors).toEqual([]);
  await app.close(); await launch();
  await expect(page.getByText('已将 old 替换为 new，文件已保存。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('聊天模型')).toHaveValue(state.models[1].id);
  await expect(page.getByRole('button', { name: 'note.md', exact: true })).toBeVisible();
});
test('PDF preview, native note, Chinese text, page operations and visual tool input', async ({}, info) => {
  await configure(); await page.getByRole('button', { name: 'scan.pdf', exact: true }).click(); await expect.poll(() => page.locator('.pdf-canvas-wrap canvas').evaluate((c: HTMLCanvasElement) => c.width)).toBe(450); await expect(page.locator('.pdf-canvas-wrap')).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('PDF 批注文字').fill('中文批注'); await page.getByRole('button', { name: '添加批注', exact: true }).click(); await page.getByRole('button', { name: '添字', exact: true }).click(); await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await PDFDocument.load(await readFile(join(root, '工作区', 'scan.pdf')))).getPages()[0].node.Annots()?.size()).toBe(1); await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.getByLabel('PDF 页面序列').fill('1'); await page.getByLabel('PDF 导出路径').fill('拆分页.pdf'); await page.getByRole('button', { name: '导出页面', exact: true }).click(); await expect(page.getByText('已导出到 拆分页.pdf', { exact: true })).toBeVisible(); expect((await PDFDocument.load(await readFile(join(root, '工作区', '拆分页.pdf')))).getPageCount()).toBe(1);
  await page.getByLabel('聊天模型').selectOption({ label: '视觉助手 ◉ · 测试接入二' }); await page.getByLabel('聊天消息').fill('识别扫描 PDF 的第 1 页'); await page.getByLabel('发送消息', { exact: true }).click(); await expect(page.getByText('已收到指定扫描页图片。', { exact: true })).toBeVisible();
  expect(JSON.stringify(requests)).toContain('data:image/png'); expect(requests.filter(r => r.model === 'mock-vision').every(r => !r.testHeaders.authorization)).toBe(true); await page.screenshot({ path: info.outputPath('pdf.png') });
  await page.getByLabel('PDF 页面序列').fill('2,1'); await page.getByRole('button', { name: '重排 / 提取' }).click(); await page.getByRole('button', { name: '保存', exact: true }).click(); await expect.poll(async () => (await PDFDocument.load(await readFile(join(root, '工作区', 'scan.pdf')))).getPages()[0].getWidth()).toBe(400); expect(runtimeErrors).toEqual([]);
});
test('stop button cancels model request and prevents further tool activity', async () => {
  await configure(); await page.getByLabel('聊天消息').fill('慢响应测试'); await page.getByLabel('发送消息', { exact: true }).click(); await expect(page.getByLabel('停止任务', { exact: true })).toBeVisible(); await page.getByLabel('停止任务', { exact: true }).click(); await expect(page.getByText('准备就绪', { exact: true })).toBeVisible(); expect(await readFile(join(root, '工作区', 'note.md'), 'utf8')).toContain('old');
});
test('manual Word and Excel edits, formulas, unsaved conflicts and model menu filtering', async () => {
  await configure();
  const workspaceId = await page.evaluate(async () => (await window.agent.invoke<any>('state')).workspaces[0].id);
  await page.evaluate(async id => { await window.agent.invoke('createFile', { workspaceId: id, path: '手动.docx', content: '原文' }); await window.agent.invoke('createFile', { workspaceId: id, path: '手动.xlsx', content: '1' }); }, workspaceId);
  const wordBefore = await readFile(join(root, '工作区', '手动.docx'));
  await page.getByRole('button', { name: '手动.docx', exact: true }).click(); await page.getByLabel('Word p:0', { exact: true }).fill('中文修改');
  await page.getByLabel('聊天消息').fill('检查未保存 Word'); await page.getByLabel('发送消息', { exact: true }).click(); await expect(page.getByText('未保存编辑发生冲突，文件保持原样。', { exact: true })).toBeVisible(); await expect(page.getByText('准备就绪', { exact: true })).toBeVisible(); expect(await readFile(join(root, '工作区', '手动.docx'))).toEqual(wordBefore); await expect(page.getByLabel('Word p:0', { exact: true })).toHaveValue('中文修改');
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; }); await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(w => w.isVisible())!.close(); }); expect(page.isClosed()).toBe(false);
  await page.getByRole('button', { name: '保存', exact: true }).click(); await expect.poll(async () => (await page.evaluate(id => window.agent.invoke<any>('inspect', { workspaceId: id, path: '手动.docx' }), workspaceId)).blocks[0].text).toBe('中文修改'); await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '修改记录', exact: true }).click(); await page.getByRole('button', { name: '撤销最近一轮', exact: true }).click(); await expect.poll(() => readFile(join(root, '工作区', '手动.docx'))).toEqual(wordBefore); await page.getByLabel('关闭修改记录').click();
  await page.getByRole('button', { name: '手动.xlsx', exact: true }).click(); await page.getByLabel('单元格地址', { exact: true }).fill('B1'); await page.getByLabel('单元格新内容', { exact: true }).fill('=A1*2'); await page.getByRole('button', { name: '添加修改', exact: true }).click(); await page.getByRole('button', { name: '保存', exact: true }).click(); await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect.poll(async () => (await page.evaluate(id => window.agent.invoke<any>('inspect', { workspaceId: id, path: '手动.xlsx' }), workspaceId)).needsRecalculation).toBe(true); const sheet = await page.evaluate(id => window.agent.invoke<any>('inspect', { workspaceId: id, path: '手动.xlsx' }), workspaceId); expect(sheet.sheets[0].cells.find((c: any) => c.ref === 'B1')).toMatchObject({ formula: 'A1*2', value: '' });
  await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByRole('button').filter({ hasText: '测试接入一' }).click(); await page.getByLabel('启用 文件助手', { exact: true }).uncheck(); await page.getByRole('button', { name: '完成', exact: true }).click(); await expect.poll(() => page.getByLabel('聊天模型').locator('option').allTextContents()).toEqual(['视觉助手 ◉ · 测试接入二']);
  expect(runtimeErrors).toEqual([]);
});
test('authentication errors are shown without leaking configured credentials', async () => {
  await configure(); await page.getByLabel('聊天消息').fill('模拟认证失败'); await page.getByLabel('发送消息', { exact: true }).click(); await expect(page.locator('.message.notice')).toContainText('401'); await expect(page.getByText('准备就绪', { exact: true })).toBeVisible(); expect(await page.locator('.messages').innerText()).not.toContain('sk-fake-e2e-key-12345');
});

test('reasoning menu sends selected effort, remembers each model and survives restart', async ({}, info) => {
  await configure(); await expect(page.getByLabel('推理强度', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('button').filter({ hasText: '测试接入一' }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('推理模型', { exact: true }).check(); await page.getByLabel('支持强度调节', { exact: true }).check();
  await page.getByRole('button', { name: '保存模型修改', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('模型修改已保存');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('medium');
  expect(await page.getByLabel('推理强度', { exact: true }).locator('option').allTextContents()).toEqual(['低', '中', '高']);
  await page.getByLabel('推理强度', { exact: true }).selectOption('high');
  await expect.poll(async () => (await page.evaluate(() => window.agent.invoke<any>('state'))).models.find((m: any) => m.name === '文件助手').reasoningLevel).toBe('high');
  const before = requests.length;
  await page.getByLabel('聊天消息').fill('测试强度，读取并修改 note.md'); await page.getByLabel('发送消息', { exact: true }).click();
  await expect(page.locator('.message.assistant').last()).toContainText('已将 old 替换为 new');
  expect(requests.slice(before).every(request => request.reasoning_effort === 'high')).toBe(true); expect(requests.length - before).toBeGreaterThan(1);
  await expect(page.locator('.message.assistant .message-label').first()).toContainText('推理：高');
  const models = (await page.evaluate(() => window.agent.invoke<any>('state'))).models;
  const first = models.find((m: any) => m.name === '文件助手'), second = models.find((m: any) => m.name === '视觉助手');
  await page.evaluate(async model => { await window.agent.invoke('saveModel', { ...model, reasoning: true, supportedReasoningLevels: ['low', 'high'] }); }, second);
  await page.getByLabel('聊天模型', { exact: true }).selectOption(second.id); await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('high');
  await expect.poll(()=>page.getByLabel('推理强度', { exact: true }).locator('option').allTextContents()).toEqual(['低', '高']);
  await page.getByLabel('推理强度', { exact: true }).selectOption('low');
  await page.getByLabel('聊天模型', { exact: true }).selectOption(first.id); await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('high');
  await page.getByLabel('聊天消息').fill('慢响应'); await page.getByLabel('发送消息', { exact: true }).click();
  await expect(page.getByLabel('推理强度', { exact: true })).toBeDisabled();
  await expect.poll(async()=>!!(await page.evaluate(()=>window.agent.invoke<any>('state'))).activeRun).toBe(true);
  const error = await page.evaluate(async modelId => { try { await window.agent.invoke('setReasoningLevel', { modelId, level: 'low' }); return ''; } catch (error) { return (error as Error).message; } }, first.id); expect(error).toContain('停止');
  await page.getByLabel('停止任务', { exact: true }).click(); await expect(page.getByText('准备就绪', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建会话', exact: true }).click(); await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('high');
  await app.close(); await launch(); await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('high');
  const saved = (await page.evaluate(() => window.agent.invoke<any>('state'))).models;
  expect(saved.find((m: any) => m.id === second.id).reasoningLevel).toBe('low');
  await page.screenshot({ path: info.outputPath('reasoning-menu.png') }); expect(runtimeErrors).toEqual([]);
});

test('proxy settings persist across restart and apply to main-process fetch', async () => {
  const proxy = createServer(); let tunnels = 0;
  const sockets = new Set<any>();
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (_req, socket) => {
    tunnels++; socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nproxy OK'));
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as any).port}`;
  try {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await expect(page.getByLabel('代理地址', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('启用代理', { exact: true })).not.toBeChecked();
    await page.getByLabel('启用代理', { exact: true }).check();
    await page.getByLabel('代理地址', { exact: true }).fill(proxyUrl);
    await page.getByRole('button', { name: '保存代理设置', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('代理设置已保存');
    const result = await app.evaluate(async () => (await fetch('http://model.example.invalid/probe')).text());
    expect(result).toBe('proxy OK'); expect(tunnels).toBe(1);
    await app.close(); await launch();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await expect(page.getByLabel('代理地址', { exact: true })).toHaveValue(proxyUrl);
    await page.getByLabel('代理地址', { exact: true }).fill('socks5://127.0.0.1:7897');
    await page.getByRole('button', { name: '保存代理设置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('代理仅支持');
    expect((await page.evaluate(() => window.agent.invoke<any>('state'))).network.proxyUrl).toBe(proxyUrl);
    await page.getByLabel('代理地址', { exact: true }).fill(proxyUrl); await page.getByLabel('启用代理', { exact: true }).uncheck();
    await page.getByRole('button', { name: '保存代理设置', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('代理设置已保存');
    expect((await page.evaluate(() => window.agent.invoke<any>('state'))).network.enabled).toBe(false);
    expect(runtimeErrors).toEqual([]);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});
test('network connection failure stops the run and preserves workspace files', async () => {
  await configure(); await page.getByLabel('聊天消息').fill('模拟网络断开'); await page.getByLabel('发送消息', { exact: true }).click(); await expect(page.locator('.message.notice')).toContainText(/Connection|fetch|网络|connect/i, { timeout: 15000 }); await expect(page.getByText('准备就绪', { exact: true })).toBeVisible(); expect(await readFile(join(root, '工作区', 'note.md'), 'utf8')).toBe('old\n中文内容\n');
});

test('recovers a crashed PDF renderer and persists asset references instead of image data',async()=>{
 await configure();
 const previous=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>!w.isVisible())!;const id=w.webContents.id;w.webContents.forcefullyCrashRenderer();return id;});
 await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.isVisible())?.webContents.id)).not.toBe(previous);
 await page.getByLabel('聊天模型').selectOption({label:'视觉助手 ◉ · 测试接入二'});
 await page.getByLabel('聊天消息').fill('识别扫描 PDF 第1页');await page.getByLabel('发送消息',{exact:true}).click();await expect(page.getByText('已收到指定扫描页图片。',{exact:true})).toBeVisible();
 const saved=await readFile(join(root,'data','state.json'),'utf8');expect(saved).toContain('resourceId');expect(saved).not.toContain('iVBOR');expect(requests.some(r=>JSON.stringify(r).includes('data:image/png'))).toBe(true);
 await app.close();await launch();await expect(page.getByText('已收到指定扫描页图片。',{exact:true})).toBeVisible();
});

test('session rename, archive, restore, trash and permanent cleanup are usable from the UI',async()=>{
 await configure();await page.getByLabel('聊天消息').fill('需要彻底清理的未发送草稿');await page.getByLabel('重命名 新会话',{exact:true}).click();await page.getByLabel('会话名称',{exact:true}).fill('审计会话');await page.getByRole('button',{name:'保存名称',exact:true}).click();
 await page.getByLabel('归档 审计会话',{exact:true}).click();await page.getByRole('button',{name:'归档',exact:true}).click();await expect(page.locator('.session-item')).toHaveText('审计会话');await page.getByRole('button',{name:'恢复',exact:true}).click();
 await page.getByLabel('删除 审计会话',{exact:true}).click();await page.getByRole('button',{name:'回收站',exact:true}).click();await expect(page.locator('.session-item')).toHaveText('审计会话');await page.getByRole('button',{name:'恢复',exact:true}).click();
 await page.getByLabel('删除 审计会话',{exact:true}).click();await page.getByRole('button',{name:'回收站',exact:true}).click();await page.getByRole('button',{name:'永久清理',exact:true}).click();await page.getByRole('button',{name:'确认永久清理',exact:true}).click();await expect(page.locator('.session-item')).toHaveCount(0);expect((await page.evaluate(()=>window.agent.invoke<any>('state'))).sessions).toHaveLength(0);await expect.poll(()=>page.evaluate(()=>Object.values(JSON.parse(localStorage.getItem('chat-drafts')??'{}')).some((v:any)=>v.input==='需要彻底清理的未发送草稿'))).toBe(false);
});

test('searches provider endpoints and workspace content, then reviews and undoes a file diff',async({},info)=>{
 await configure();await page.getByRole('button',{name:'工作区搜索',exact:true}).click();await page.getByLabel('搜索内容',{exact:true}).fill('中文内容');await page.getByRole('button',{name:'搜索',exact:true}).click();await expect(page.locator('.search-results')).toContainText('note.md:2');await page.getByLabel('关闭搜索').click();
 const state=await page.evaluate(()=>window.agent.invoke<any>('state'));expect(await page.evaluate(profileId=>window.agent.invoke<string>('testNetwork',{profileId}),state.profiles[0].id)).toContain('目录接口连接成功');
 await page.getByLabel('聊天消息').fill('修改 note.md');await page.getByLabel('发送消息',{exact:true}).click();await expect(page.getByText('已将 old 替换为 new，文件已保存。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'修改记录',exact:true}).click();await expect(page.locator('.changes-content')).toContainText('note.md');await expect(page.locator('.diff')).toContainText('+new');await page.getByLabel('修改前后并排').check();await expect(page.locator('.diff-pair').first()).toBeVisible();await page.screenshot({path:info.outputPath('diff-audit.png')});await page.getByRole('button',{name:'接受本轮修改',exact:true}).click();await page.getByRole('button',{name:'撤销本轮修改',exact:true}).click();await expect.poll(()=>readFile(join(root,'工作区','note.md'),'utf8')).toBe('old\n中文内容\n');
});

test('recovers committed changes and undo after an actual application process termination',async()=>{
 await configure();await page.getByLabel('聊天消息').fill('异常退出恢复，修改 note.md');await page.getByLabel('发送消息',{exact:true}).click();await expect.poll(()=>readFile(join(root,'工作区','note.md'),'utf8')).toBe('new\n中文内容\n');
 await expect.poll(async()=>JSON.parse(await readFile(join(root,'data','state.json'),'utf8')).state.changeSets[0]?.changes[0]?.status).toBe('committed');
 const child=app.process();const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));await app.evaluate(({app})=>app.exit(77)).catch(()=>undefined);await exited;await launch();await expect(page.locator('.message.notice')).toContainText('异常中断');
 await page.getByRole('button',{name:'修改记录',exact:true}).click();await page.getByRole('button',{name:'撤销本轮修改',exact:true}).click();await expect.poll(()=>readFile(join(root,'工作区','note.md'),'utf8')).toBe('old\n中文内容\n');
});

test('virtualizes a large worksheet and supports TSV copy and paste without flattening the workbook',async()=>{
 await configure();const state=await page.evaluate(()=>window.agent.invoke<any>('state')),workspaceId=state.workspaces[0].id;
 await page.evaluate(workspaceId=>window.agent.invoke('createFile',{workspaceId,path:'large.xlsx',content:''}),workspaceId);
 const bookPath=join(root,'工作区','large.xlsx'),parts=unzipSync(await readFile(bookPath));parts['xl/worksheets/sheet1.xml']=strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from({length:2500},(_,i)=>`<row r="${i+1}"><c r="A${i+1}"><v>${i+1}</v></c></row>`).join('')}</sheetData></worksheet>`);await writeFile(bookPath,zipSync(parts));
 await page.getByRole('button',{name:'large.xlsx',exact:true}).click();await expect(page.getByLabel('Sheet1!A1',{exact:true})).toHaveValue('1');expect(await page.locator('.sheet-table tbody input').count()).toBeLessThan(60);
 await page.locator('.virtual-sheet').evaluate((el:HTMLElement)=>{el.scrollTop=2000*36;});await expect(page.getByLabel('Sheet1!A2001',{exact:true})).toBeVisible();
 await page.getByText('批量复制 / 粘贴（Tab 分列、换行分行）',{exact:true}).click();await page.getByLabel('单元格地址',{exact:true}).fill('B1');await page.getByLabel('批量粘贴',{exact:true}).fill('中文\t2\n3\t4');await page.getByRole('button',{name:'添加粘贴修改',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('button',{name:'保存',exact:true})).toBeDisabled();
 await expect.poll(async()=>{const d=await page.evaluate(workspaceId=>window.agent.invoke<any>('inspect',{workspaceId,path:'large.xlsx'}),workspaceId);return d.sheets[0].cells.find((c:any)=>c.ref==='B1')?.value;}).toBe('中文');const after=await page.evaluate(workspaceId=>window.agent.invoke<any>('inspect',{workspaceId,path:'large.xlsx'}),workspaceId);expect(after.sheets[0].cells.find((c:any)=>c.ref==='C2').value).toBe('4');expect(after.sheets[0].cells.find((c:any)=>c.ref==='A2500').value).toBe('2500');
 await page.getByLabel('复制区域',{exact:true}).fill('B1:C2');await page.getByRole('button',{name:'准备复制',exact:true}).click();await expect(page.getByLabel('复制数据',{exact:true})).toHaveValue('中文\t2\n3\t4');
});

test('keeps independent chat drafts and file references when switching sessions',async()=>{
 await configure();const first=(await page.evaluate(()=>window.agent.invoke<any>('state'))).sessions[0];await page.evaluate(sessionId=>window.agent.invoke('manageSession',{sessionId,action:'rename',title:'会话甲'}),first.id);
 await page.getByLabel('聊天消息').fill('甲会话未发送的草稿');await page.getByRole('button',{name:'note.md',exact:true}).click();await page.getByLabel('引用当前文件',{exact:true}).click();await page.getByLabel('新建会话',{exact:true}).click();await expect(page.getByLabel('聊天消息')).toHaveValue('');await expect(page.locator('.references button')).toHaveCount(0);await page.getByLabel('聊天消息').fill('乙会话草稿');
 const second=(await page.evaluate(()=>window.agent.invoke<any>('state'))).sessions.find((s:any)=>s.id!==first.id);await page.evaluate(sessionId=>window.agent.invoke('manageSession',{sessionId,action:'rename',title:'会话乙'}),second.id);
 await page.locator('.session-item').filter({hasText:'会话甲'}).click();await expect(page.getByLabel('聊天消息')).toHaveValue('甲会话未发送的草稿');await expect(page.locator('.references')).toContainText('note.md');await page.locator('.session-item').filter({hasText:'会话乙'}).click();await expect(page.getByLabel('聊天消息')).toHaveValue('乙会话草稿');await expect(page.locator('.references button')).toHaveCount(0);await app.close();await launch();await page.locator('.session-item').filter({hasText:'会话甲'}).click();await expect(page.getByLabel('聊天消息')).toHaveValue('甲会话未发送的草稿');await expect(page.locator('.references')).toContainText('note.md');
});
test('can select an unconfigured model without authenticating and choose a model after the last session is deleted',async()=>{
 await configure();const model=await page.evaluate(async()=>{const p=await window.agent.invoke<any>('saveProfile',{name:'尚未登录',provider:'openai',protocol:'openai-responses',baseUrl:'',authMode:'api_key'});return window.agent.invoke<any>('saveModel',{profileId:p.id,name:'待登录模型',modelId:'gpt-4o-mini',enabled:true,vision:false,reasoning:false,contextWindow:32768,maxTokens:4096});});
 const before=requests.length;await page.getByLabel('聊天模型').selectOption(model.id);await expect(page.getByLabel('聊天模型')).toHaveValue(model.id);expect(requests.length).toBe(before);
 const state=await page.evaluate(()=>window.agent.invoke<any>('state'));await page.evaluate(sessionId=>window.agent.invoke('manageSession',{sessionId,action:'delete'}),state.sessions[0].id);await expect(page.getByLabel('聊天模型')).toBeEnabled();await page.getByLabel('聊天消息').fill('首次发送失败仍需保留的草稿');await page.getByLabel('聊天模型').selectOption(model.id);await expect(page.getByLabel('聊天消息')).toHaveValue('首次发送失败仍需保留的草稿');await expect.poll(async()=>{const s=await page.evaluate(()=>window.agent.invoke<any>('state'));return s.sessions.find((v:any)=>!v.deletedAt)?.modelId;}).toBe(model.id);await page.getByLabel('发送消息',{exact:true}).click();await expect(page.getByRole('alert')).toContainText('凭据');await expect(page.getByLabel('聊天消息')).toHaveValue('首次发送失败仍需保留的草稿');
});
test('resets PDF controls for a different file and clamps the current page after extraction',async()=>{
 await configure();const workspaceId=(await page.evaluate(()=>window.agent.invoke<any>('state'))).workspaces[0].id;await page.evaluate(workspaceId=>window.agent.invoke('createFile',{workspaceId,path:'another.pdf',content:''}),workspaceId);
 await page.getByRole('button',{name:'scan.pdf',exact:true}).click();await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.getByText('第 2 / 2 页',{exact:true})).toBeVisible();await page.getByLabel('PDF 批注文字').fill('上一文件的草稿');await page.getByRole('button',{name:'another.pdf',exact:true}).click();await expect(page.getByText('第 1 / 1 页',{exact:true})).toBeVisible();await expect(page.getByLabel('PDF 批注文字')).toHaveValue('');
 await page.getByRole('button',{name:'scan.pdf',exact:true}).click();await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByLabel('PDF 页面序列').fill('1');await page.getByRole('button',{name:'重排 / 提取',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByText('第 1 / 1 页',{exact:true})).toBeVisible();
});
test('blocks editor input while a save is in flight, preserves bytes and supports Ctrl+S',async()=>{
 await configure();const workspaceId=(await page.evaluate(()=>window.agent.invoke<any>('state'))).workspaces[0].id;await page.evaluate(workspaceId=>window.agent.invoke('createFile',{workspaceId,path:'save.docx',content:'原始内容'}),workspaceId);await page.getByRole('button',{name:'save.docx',exact:true}).click();await page.getByLabel('Word p:0',{exact:true}).fill('保存后的内容');
 await app.evaluate(async(_electron,workRoot)=>{const fs=process.getBuiltinModule('fs/promises') as typeof import('node:fs/promises'),module=process.getBuiltinModule('module'),original=fs.writeFile;(globalThis as any).__restoreWrite=()=>{fs.writeFile=original;module.syncBuiltinESMExports();};fs.writeFile=(async(...args:any[])=>{if(String(args[0]).startsWith(workRoot)&&String(args[0]).endsWith('.tmp')){(globalThis as any).__saveBlocked=true;await new Promise<void>(resolve=>{(globalThis as any).__releaseSave=resolve;});}return (original as any)(...args);}) as typeof original;module.syncBuiltinESMExports();},join(root,'工作区'));
 try{await page.getByLabel('Word p:0',{exact:true}).press('Control+s');await expect.poll(()=>app.evaluate(()=>(globalThis as any).__saveBlocked)).toBe(true);await expect(page.getByLabel('Word p:0',{exact:true})).toBeDisabled();await expect(page.getByLabel('选择工作区',{exact:true})).toBeDisabled();await app.evaluate(()=>{(globalThis as any).__restoreWrite();(globalThis as any).__releaseSave();});await expect(page.getByLabel('Word p:0',{exact:true})).toBeEnabled();await expect(page.getByText('已保存',{exact:true})).toBeVisible();const after=await page.evaluate(workspaceId=>window.agent.invoke<any>('inspect',{workspaceId,path:'save.docx'}),workspaceId);expect(after.blocks[0].text).toBe('保存后的内容');}
 finally{await app.evaluate(()=>{(globalThis as any).__restoreWrite?.();(globalThis as any).__releaseSave?.();});}
});
test('cancels a hanging connection test and keeps settings usable afterwards',async()=>{
 await configure();await page.getByRole('button',{name:'模型设置',exact:true}).click();await page.getByRole('button').filter({hasText:'测试接入一'}).click();await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('模型 ID',{exact:true}).fill('slow-probe');await page.getByRole('button',{name:'保存模型修改',exact:true}).click();await expect(page.getByText('模型修改已保存',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'测试连接',exact:true}).click();await expect(page.getByRole('button',{name:'取消连接测试',exact:true})).toBeVisible();await expect(page.getByLabel('配置名称',{exact:true})).toBeDisabled();await page.getByRole('button',{name:'取消连接测试',exact:true}).click();await expect(page.getByRole('button',{name:'完成',exact:true})).toBeEnabled({timeout:10000});await expect(page.getByLabel('配置名称',{exact:true})).toBeEnabled();
});

test('pastes and copies quoted multiline spreadsheet cells without shifting data',async()=>{
 await configure();const workspaceId=(await page.evaluate(()=>window.agent.invoke<any>('state'))).workspaces[0].id;await page.evaluate(workspaceId=>window.agent.invoke('createFile',{workspaceId,path:'quoted.xlsx',content:'keep'}),workspaceId);await page.getByRole('button',{name:'quoted.xlsx',exact:true}).click();await page.getByText('批量复制 / 粘贴（Tab 分列、换行分行）',{exact:true}).click();await page.getByLabel('单元格地址',{exact:true}).fill('B1');await page.getByLabel('批量粘贴',{exact:true}).fill('"一行\n二行"\t"带""引号"');await page.getByRole('button',{name:'添加粘贴修改',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();await expect.poll(async()=>{const d=await page.evaluate(workspaceId=>window.agent.invoke<any>('inspect',{workspaceId,path:'quoted.xlsx'}),workspaceId);return d.sheets[0].cells.find((c:any)=>c.ref==='B1')?.value;}).toBe('一行\n二行');
 const after=await page.evaluate(workspaceId=>window.agent.invoke<any>('inspect',{workspaceId,path:'quoted.xlsx'}),workspaceId);expect(after.sheets[0].cells.find((c:any)=>c.ref==='C1').value).toBe('带"引号');expect(after.sheets[0].cells.find((c:any)=>c.ref==='A1').value).toBe('keep');await page.getByLabel('复制区域',{exact:true}).fill('B1:C1');await page.getByRole('button',{name:'准备复制',exact:true}).click();await expect(page.getByLabel('复制数据',{exact:true})).toHaveValue('"一行\n二行"\t"带""引号"');
});

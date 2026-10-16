import { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } from 'electron';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import { z } from 'zod';
import { validateToolCall } from '@earendil-works/pi-ai/utils/validation';
import { Store, Secrets } from './store';
import { OperationGate } from './operation-gate';
import { externalUrl } from './external-url';
import { Files, hash } from './workspace';
import { Documents } from './documents';
import { ModelService } from './models';
import { NetworkService, defaultNetwork, validateNetwork } from './network';
import { Agent, tools } from './agent';
import { reviewChanges, acceptChanges } from './review';
import { PdfService } from './pdf-service';
import type { AppEvent, FileOperation, Session } from '../shared/types';

app.setName('SimpleAgent');
if (process.env.SIMPLE_AGENT_TEST === '1' && process.env.SIMPLE_AGENT_DATA_DIR) app.setPath('userData', process.env.SIMPLE_AGENT_DATA_DIR);
protocol.registerSchemesAsPrivileged([{ scheme: 'agent', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const here = fileURLToPath(new URL('.', import.meta.url));
let window: BrowserWindow;
const authenticationUrls = new Set<string>();
const workspacePath = z.object({ workspaceId: z.string(), path: z.string() });
const sessionId = z.object({ sessionId: z.string() });
const idInput = z.object({ id: z.string() });

async function loadWindow(target: BrowserWindow, page: string) {
  if (process.env.ELECTRON_RENDERER_URL) await target.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}`);
  else await target.loadURL(`agent://app/${page}`);
}
async function main() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  const rendererRoot = resolve(here, '../renderer');
  protocol.handle('agent', request => {
    const url = new URL(request.url), target = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname));
    const rel = relative(rendererRoot, target);
    if (url.host !== 'app' || rel.startsWith('..') || isAbsolute(rel)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });
  const store = new Store(app.getPath('userData')); await store.init();
  const network = new NetworkService();
  network.apply(store.state.network ?? defaultNetwork());
  store.state.network = network.settings;
  app.once('will-quit', () => network.close());
  const files = new Files(store); await files.recover();
  const resources = app.isPackaged ? join(process.resourcesPath, 'resources') : resolve(here, '../../resources');
  const documents = new Documents(files, resources);
  const secrets = new Secrets(store.directory, {
    encrypt: async text => { if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Windows 凭据加密暂不可用，请稍后重试'); return safeStorage.encryptStringAsync(text); },
    decrypt: async bytes => (await safeStorage.decryptStringAsync(Buffer.from(bytes))).result
  });
  const emit = (event: AppEvent) => { if (!window?.isDestroyed()) window?.webContents.send('agent:event', event); };
  const openAuth = async (url: string) => {
    const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('授权链接无效');
    authenticationUrls.add(url); await shell.openExternal(url);
  };
  const models = new ModelService(store, secrets, emit, openAuth, message => network.explain(message));
  await models.init();
  const preferences: Electron.WebPreferences = { preload: join(here, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true };
  const harden = (target: BrowserWindow) => {
    target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    target.webContents.on('will-navigate', event => event.preventDefault());
    target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  };
  const pdfService = new PdfService(async failed => {
    const target = new BrowserWindow({ show: false, webPreferences: { ...preferences, backgroundThrottling: false } });
    harden(target);
    target.webContents.once('render-process-gone', (_event, details) => failed(`PDF 渲染进程异常退出（${details.reason}），已停止当前读取并重建服务`));
    target.once('closed', () => failed('PDF 渲染窗口已关闭，已停止当前读取并重建服务'));
    const loadTimer=setTimeout(()=>{if(!target.isDestroyed())target.destroy();},14000);
    try { await loadWindow(target, 'pdf.html'); }
    catch (error) { if (!target.isDestroyed()) target.destroy(); throw error; }
    finally {clearTimeout(loadTimer);}
    return { sender: target.webContents, send: task => target.webContents.send('agent:pdf-task', task), destroy: () => { if (!target.isDestroyed()) target.destroy(); } };
  });
  const agent = new Agent(store, files, documents, models, emit, (bytes, pages, render, signal) => pdfService.render(bytes, pages, render, signal));
  ipcMain.on('agent:pdf-result', (event, value) => pdfService.receive(event.sender, value));
  app.once('will-quit', () => { agent.cancel(); pdfService.close(); });
  const operations=new OperationGate();
  const configurationMethods=new Set(['saveNetwork','saveProfile','deleteProfile','saveModel','deleteModel','setReasoningLevel','logout','testNetwork','testModel','catalog']);
  const methods: Record<string, (input: unknown, signal?:AbortSignal) => unknown> = {
    state: () => store.publicState(),
    saveNetwork: async input => {
      models.assertIdle();
      const settings = validateNetwork(input), previous = network.settings;
      network.apply(settings); store.state.network = settings;
      try { await store.save(); } catch (error) { network.apply(previous); store.state.network = previous; throw error; }
      emit({ type: 'state' }); return settings;
    },
    testNetwork: (input,signal) => { models.assertIdle(); const args = z.object({ profileId: z.string(), modelId: z.string().optional() }).parse(input); return network.test(() => models.probe(args.profileId,args.modelId,signal)); },
    chooseWorkspace: async () => {
      if (store.state.activeRun) throw new Error('请先停止当前任务');
      const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '选择智能体工作区' });
      if (selection.canceled) return null;
      const result = await files.add(selection.filePaths[0]); emit({ type: 'state' }); return result;
    },
    list: input => { const args = workspacePath.parse(input); return files.list(args.workspaceId, args.path); },
    search: input => { const args = z.object({ workspaceId: z.string(), searchId: z.string().optional(), query: z.string().min(1).max(1000), content: z.boolean().optional(), excludes: z.array(z.string().max(100)).max(30).optional() }).parse(input); return files.search(args.workspaceId, args.query, args.content, { searchId: args.searchId, excludes: args.excludes, onProgress: progress => emit({ type: 'search_progress', workspaceId: args.workspaceId, searchId: args.searchId ?? '', progress }) }); },
    cancelSearch: input => { const args=z.object({workspaceId: z.string(),searchId:z.string().optional()}).parse(input); return files.cancelSearch(args.workspaceId,args.searchId); },
    inspect: input => { const args = workspacePath.parse(input); return documents.inspect(args.workspaceId, args.path); },
    fileBytes: async input => { const args=workspacePath.extend({version:z.string().optional()}).parse(input);const bytes=await files.bytes(args.workspaceId,args.path);if(args.version&&hash(bytes)!==args.version)throw new Error('文件已被外部修改，请重新打开后预览');return bytes; },
    dirty: input => { const args = workspacePath.extend({ dirty: z.boolean() }).parse(input); const key = files.dirtyKey(args.workspaceId, args.path); if (args.dirty) files.dirty.add(key); else files.dirty.delete(key); },
    saveFile: async input => {
      const args = workspacePath.extend({ version: z.string().regex(/^[a-f0-9]{64}$/), operations: z.array(z.unknown()).min(1).max(100) }).parse(input);
      const validated = validateToolCall(tools, { type: 'toolCall', id: 'manual', name: 'edit_file', arguments: { path: args.path, version: args.version, operations: args.operations as any } });
      const set = files.newChangeSet(args.workspaceId, 'manual');
      const result = await documents.apply(args.workspaceId, args.path, args.version, validated.operations as FileOperation[], set, true);
      files.dirty.delete(files.dirtyKey(args.workspaceId, args.path)); emit({ type: 'state' }); return result;
    },
    createFile: async input => { const args = workspacePath.extend({ content: z.string().default('') }).parse(input); const set = files.newChangeSet(args.workspaceId, 'manual'); const result = await documents.create(args.workspaceId, args.path, args.content, set); emit({ type: 'state' }); return result; },
    exportPdf: async input => {
      const args = workspacePath.extend({ version: z.string().regex(/^[a-f0-9]{64}$/), target: z.string(), pages: z.array(z.number().int().min(1)).min(1).max(1000) }).parse(input);
      const result = await documents.exportPdf(args.workspaceId, args.path, args.version, args.target, args.pages, files.newChangeSet(args.workspaceId, 'manual')); emit({ type: 'state' }); return result;
    },
    undo: async input => { const args = z.object({ workspaceId: z.string(), setId: z.string().optional() }).parse(input); const result = await files.undo(args.workspaceId, args.setId); emit({ type: 'state' }); return result; },
    reviewChanges: input => { const args = z.object({workspaceId: z.string(), setId: z.string()}).parse(input); return reviewChanges(store, files, args.workspaceId, args.setId); },
    acceptChanges: async input => { const args = z.object({workspaceId: z.string(), setId: z.string()}).parse(input); const result = await acceptChanges(store, files, args.workspaceId, args.setId); emit({type:'state'}); return result; },
    manageSession: async input => { const args = sessionId.extend({ action: z.enum(['rename','archive','restore','delete','purge']), title: z.string().max(100).optional() }).parse(input); await store.manageSession(args.sessionId,args.action,args.title);if(args.action==='purge')emit({type:'session_purged',sessionId:args.sessionId});emit({type:'state'}); },
    saveProfile: input => models.saveProfile(input), deleteProfile: input => models.deleteProfile(idInput.parse(input).id),
    saveModel: input => models.saveModel(input), deleteModel: input => models.deleteModel(idInput.parse(input).id),
    setReasoningLevel: input => models.setReasoningLevel(input),
    catalog: (input,signal) => models.catalog(idInput.parse(input).id,signal), testModel:(input,signal)=>models.test(idInput.parse(input).id,signal),
    login: input => models.login(idInput.parse(input).id),
    answerAuth: input => { const args = z.object({ promptId: z.string(), value: z.string().max(10000) }).parse(input); models.answer(args.promptId, args.value); },
    cancelAuth: input => models.cancelLogin(idInput.parse(input).id), logout: input => models.logout(idInput.parse(input).id),
    openExternal: input => shell.openExternal(externalUrl(z.object({url:z.string().max(4096)}).parse(input).url)),
    openAuthUrl: input => { const url = z.object({ url: z.string() }).parse(input).url; if (!authenticationUrls.has(url)) throw new Error('此链接不是当前登录流程提供的链接'); return openAuth(url); },
    createSession: async input => {
      if(store.state.activeRun)throw new Error('请先停止当前任务再新建会话');const args=z.object({workspaceId:z.string()}).parse(input);files.workspace(args.workspaceId);
      const session: Session = { id: randomUUID(), workspaceId: args.workspaceId, title: '新会话', modelId: store.state.models.find(m => m.enabled)?.id ?? '', messages: [], context: [], updatedAt: Date.now() };
      store.state.sessions.push(session);try{await store.save();}catch(error){store.state.sessions=store.state.sessions.filter(s=>s!==session);throw error;} emit({ type: 'state' }); return { ...session, context: [] };
    },
    selectModel: async input => { if(store.state.activeRun)throw new Error('任务运行期间不能切换模型'); const args = sessionId.extend({ modelId: z.string() }).parse(input); const session=store.session(args.sessionId);if(!store.state.models.some(m=>m.id===args.modelId&&m.enabled&&store.state.profiles.some(p=>p.id===m.profileId)))throw new Error('请选择已启用的模型');const previous=session.modelId;session.modelId=args.modelId;try{await store.save();}catch(error){session.modelId=previous;throw error;} emit({ type: 'state' }); },
    start: input => { const args = sessionId.extend({ text: z.string().min(1).max(50000), references: z.array(z.string()).max(20).default([]) }).parse(input); return agent.start(args.sessionId, args.text, args.references); },
    cancelConnection:()=>operations.cancel(),
    cancel: () => agent.cancel()
  };
  ipcMain.handle('agent:invoke', async (event, method: string, input: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !Object.hasOwn(methods, method)) return { ok: false, error: '不允许的应用接口' };
    try {if(configurationMethods.has(method)){models.assertIdle();return {ok:true,data:await operations.run(signal=>Promise.resolve(methods[method](input,signal)))};}if(['start','selectModel','login','chooseWorkspace','createSession'].includes(method))operations.assertIdle();if(method==='start')models.assertIdle();return {ok:true,data:await methods[method](input)}; }
    catch (error) { return { ok: false, error: error instanceof z.ZodError ? '输入格式无效，请检查必填项与数值范围' : await models.safeError(error) }; }
  });
  // A malformed PDF or failed auxiliary renderer must not prevent the main application opening.
  await pdfService.start().catch(() => undefined);
  window = new BrowserWindow({ width: 1500, height: 960, minWidth: 1000, minHeight: 680, backgroundColor: '#11151c', title: 'Simple Agent', autoHideMenuBar: true, show: false, webPreferences: preferences });
  harden(window);
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (store.state.activeRun) { event.preventDefault(); agent.cancel(); void agent.waitForIdle().finally(()=>{if(!window.isDestroyed())window.close();}); return; }
    if (!files.dirty.size) return;
    const choice = dialog.showMessageBoxSync(window, { type: 'question', title: '未保存的编辑', message: '当前文件有未保存的编辑。', detail: '返回应用可保存编辑；退出将放弃未保存的内容。', buttons: ['返回应用', '放弃编辑并退出'], defaultId: 0, cancelId: 0 });
    if (choice === 0) event.preventDefault();
  });
  window.on('closed', () => { agent.cancel(); pdfService.close(); });
  app.on('second-instance', () => { if (window.isMinimized()) window.restore(); window.focus(); });
  await loadWindow(window, 'index.html');
}
app.on('window-all-closed', () => app.quit());
void main().catch(error => { dialog.showErrorBox('Simple Agent 启动失败', String(error)); app.quit(); });

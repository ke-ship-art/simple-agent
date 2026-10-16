import { contextBridge, ipcRenderer } from 'electron';
import type { Api, AppEvent, PdfTask } from '../shared/types';
const methods = new Set(['manageSession', 'reviewChanges', 'acceptChanges', 'cancelSearch', 'setReasoningLevel', 'saveNetwork', 'testNetwork', 'state', 'chooseWorkspace', 'list', 'search', 'inspect', 'fileBytes', 'dirty', 'saveFile', 'createFile', 'exportPdf', 'undo', 'saveProfile', 'deleteProfile', 'saveModel', 'deleteModel', 'catalog', 'testModel', 'login', 'answerAuth', 'cancelAuth', 'cancelConnection', 'logout', 'createSession', 'selectModel', 'start', 'cancel', 'openAuthUrl', 'openExternal']);
const api: Api = {
  async invoke(method, args) {
    if (!methods.has(method)) throw new Error('未知应用接口');
    const response = await ipcRenderer.invoke('agent:invoke', method, args ?? {});
    if (!response.ok) throw new Error(response.error);
    return response.data;
  },
  onEvent(handler) { const listener = (_event: Electron.IpcRendererEvent, value: AppEvent) => handler(value); ipcRenderer.on('agent:event', listener); return () => ipcRenderer.removeListener('agent:event', listener); },
  onPdfTask(handler) { const listener = (_event: Electron.IpcRendererEvent, task: PdfTask) => handler(task); ipcRenderer.on('agent:pdf-task', listener); return () => ipcRenderer.removeListener('agent:pdf-task', listener); },
  pdfResult(id, result, error) { ipcRenderer.send('agent:pdf-result', { id, result, error }); }
};
contextBridge.exposeInMainWorld('agent', api);

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { AppState, Session } from '../shared/types';
import { Resources } from './resources';
import { closePendingTools } from './history';

export const emptyState = (): AppState => ({ profiles: [], models: [], workspaces: [], sessions: [], changeSets: [] });
export async function atomicWrite(path: string, bytes: string | Uint8Array, beforeReplace?: () => Promise<void>) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', flush: true });
    for (let attempt = 0; ; attempt++) {
      await beforeReplace?.();
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, [50, 100, 250, 500][attempt]));
      }
    }
  } catch (error) {
    const { unlink } = await import('node:fs/promises');
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
export class Store {
  state: AppState = emptyState();
  private pending: Promise<unknown> = Promise.resolve();
  readonly resources: Resources;
  constructor(readonly directory: string) { this.resources = new Resources(directory); }
  async init() {
    await mkdir(this.directory, { recursive: true });
    let needsSave = false;
    let loadedText: string | undefined;
    try {
      loadedText=await readFile(join(this.directory,'state.json'),'utf8');this.state = this.decode(loadedText);
    } catch (error) {
      try {
        loadedText=await readFile(join(this.directory,'state.backup.json'),'utf8');this.state=this.decode(loadedText);
        const damaged = await readFile(join(this.directory, 'state.json')).catch(() => null);
        if (damaged) await atomicWrite(join(this.directory, `state.corrupt.${Date.now()}.json`), damaged);
        this.state.recoveryWarnings = ['主配置不可读取，已保留原文件并恢复上一次有效快照；最近一次未提交状态可能需要重新检查。'];
        needsSave = true;
      } catch (backupError) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (backupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`无法读取应用数据或有效备份，原文件已保留：${String(error)}`);
      }
    }
    if(loadedText&&JSON.parse(loadedText).appVersion!=='0.2.0'){
      const legacy=join(this.directory,'state.before-0.2.0.json');
      await readFile(legacy).catch(async error=>{if(error.code!=='ENOENT')throw error;await atomicWrite(legacy,loadedText!);});
    }
    for (const session of this.state.sessions) {
      if (!Array.isArray(session.context)) session.context = [];
      if(closePendingTools(session.context,'应用异常退出；此工具结果未确认，必须重新读取文件和修改记录后规划，不能重复执行旧计划。'))needsSave=true;
    }
    if (this.state.activeRun) {
      const run = this.state.activeRun, session = this.state.sessions.find(s => s.id === run.sessionId);
      session?.messages.push({ id: randomUUID(), role: 'notice', text: '上次任务被异常中断；已检查恢复日志。已保存的修改保留，请查看修改记录，继续前重新读取文件。', timestamp: Date.now() });
      this.state.lastRun = { ...run, status: 'failed' }; this.state.activeRun = undefined; needsSave = true;
    }
    if (await this.resources.migrate(this.state.sessions)) needsSave = true;
    if (needsSave) await this.save();
    // Include the recovery generation in asset roots; never remove an image still recoverable there.
    const backup = await readFile(join(this.directory, 'state.backup.json'), 'utf8').then(JSON.parse).catch(() => null);
    await this.resources.collect([this.state.sessions, backup]).catch(() => undefined);
  }
  private decode(serialized: string): AppState {
    const saved = JSON.parse(serialized);
    if (saved.schemaVersion !== 1) throw new Error('不支持的配置文件版本');
    if (!saved.state || ['profiles', 'models', 'workspaces', 'sessions', 'changeSets'].some(key => !Array.isArray(saved.state[key]))) throw new Error('配置结构不完整');
    if (saved.checksum && saved.checksum !== createHash('sha256').update(JSON.stringify(saved.state)).digest('hex')) throw new Error('配置校验失败');
    for (const s of saved.state.sessions) if (typeof s.id !== 'string' || !Array.isArray(s.messages)) throw new Error('会话数据无效');
    return { ...emptyState(), ...saved.state };
  }
  save() {
    const snapshot = JSON.stringify({...this.state,activeRun:this.state.activeRun?.status==='running'?this.state.activeRun:undefined});
    const serialized = `{"schemaVersion":1,"appVersion":"0.2.0","checksum":${JSON.stringify(createHash('sha256').update(snapshot).digest('hex'))},"state":${snapshot}}`;
    const task = this.pending.catch(() => undefined).then(async () => {
      const target = join(this.directory, 'state.json');
      const previous = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (previous) {
        let valid = false; try { this.decode(previous); valid = true; } catch { /* Keep the last valid backup after corruption. */ }
        if (valid) await atomicWrite(join(this.directory, 'state.backup.json'), previous);
      }
      await atomicWrite(target, serialized);
    });
    this.pending = task;
    return task;
  }
  publicState(): AppState {
    return { ...this.state, profiles: this.state.profiles.map(p => ({ ...p })), sessions: this.state.sessions.map(s => ({ ...s, context: [] })) };
  }
  session(id: string): Session {
    const result = this.state.sessions.find(s => s.id === id);
    if (!result) throw new Error('会话不存在');
    return result;
  }
  async manageSession(id: string, action: 'rename' | 'archive' | 'restore' | 'delete' | 'purge', title?: string) {
    if (this.state.activeRun) throw new Error('请先停止当前任务再管理会话');
    const session = this.session(id), previous = structuredClone(session);
    if (action === 'rename') { if (!title?.trim() || title.length > 100) throw new Error('会话名称需为 1–100 个字符'); session.title = title.trim(); session.titleEdited = true; }
    if (action === 'archive') session.archivedAt = Date.now();
    if (action === 'delete') session.deletedAt = Date.now();
    if (action === 'restore') { delete session.deletedAt; delete session.archivedAt; }
    if (action === 'purge') {
      if (!session.deletedAt) throw new Error('只能永久清理回收站中的会话');
      this.state.sessions = this.state.sessions.filter(s => s.id !== id);
    }
    session.updatedAt = Date.now();
    try { await this.save(); } catch (error) { const i = this.state.sessions.findIndex(s => s.id === id); if (i >= 0) this.state.sessions[i] = previous; else this.state.sessions.push(previous); throw error; }
    if (action === 'purge') {
      // Rotate the backup too before collecting; preserve file change logs and undo snapshots.
      await this.save();
      const backup = await readFile(join(this.directory, 'state.backup.json'), 'utf8').then(JSON.parse).catch(() => null);
      await this.resources.collect([this.state.sessions, backup], 0,()=>!this.state.activeRun);
    }
  }
}

export interface Encryption { encrypt(text: string): Promise<Uint8Array>; decrypt(bytes: Uint8Array): Promise<string>; }
/** A separate, serialized encrypted store. Secrets never enter public application state. */
export class Secrets {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private encryption: Encryption) {}
  private async readAll(): Promise<Record<string, unknown>> {
    try { return JSON.parse(await this.encryption.decrypt(await readFile(join(this.directory, 'credentials.enc')))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('凭据无法解密，请在原 Windows 用户账户下打开应用'); }
  }
  async read(key: string): Promise<any> { await this.pending.catch(() => undefined); return (await this.readAll())[key]; }
  modify(key: string, fn: (current: any) => any | Promise<any>) {
    const task = this.pending.catch(() => undefined).then(async () => {
      const data = await this.readAll();
      const next = await fn(data[key]);
      if (next == null) delete data[key]; else data[key] = next;
      await atomicWrite(join(this.directory, 'credentials.enc'), await this.encryption.encrypt(JSON.stringify(data)));
      return next;
    });
    this.pending = task;
    return task;
  }
  delete(key: string) { return this.modify(key, () => undefined); }
  async list(prefix: string) {
    await this.pending.catch(() => undefined);
    const all = await this.readAll();
    return Object.entries(all).filter(([key]) => key.startsWith(prefix)).map(([key, credential]) => ({ providerId: key.slice(prefix.length), type: (credential as { type: 'api_key' | 'oauth' }).type }));
  }
}

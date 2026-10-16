import { lstat, realpath, readdir, readFile, mkdir, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, dirname, basename, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reviewPatch } from './diff';
import { atomicWrite, Store } from './store';
import { searchWorkspace, type SearchOptions } from './search';
import type { Change, ChangeSet, TreeEntry, Workspace } from '../shared/types';

export const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'release', '.next']);
type JournalChange = Change & { beforeVersion?: string | null; recoveryError?: string };
type Transaction = { id: string; startIndex: number; status: 'applying' | 'rolling-back' | 'completed' | 'rolled-back' | 'conflict'; error?: string };
type DurableChangeSet = ChangeSet & { transaction?: Transaction };
const normalizePath = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
function validRelative(path: string) {
  if (!path || isAbsolute(path) || /[:<>"|?*\x00-\x1f]/.test(path) || /^[\\/]/.test(path)) throw new Error('必须使用工作区内的相对路径');
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.some(p => p === '..' || p === '.' || !p || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) throw new Error('路径包含不允许的名称或上级目录');
  return parts;
}
export class Files {
  dirty = new Set<string>();
  private writing = false;
  private activeTransaction?: string;
  private searches = new Map<string, Map<AbortController, string | undefined>>();
  constructor(readonly store: Store) {}
  workspace(id: string): Workspace {
    const workspace = this.store.state.workspaces.find(w => w.id === id);
    if (!workspace) throw new Error('请先选择工作区');
    return workspace;
  }
  dirtyKey(workspaceId: string, path: string) {
    this.workspace(workspaceId);
    const normalized = validRelative(path).join('/');
    return `${workspaceId}:${process.platform === 'win32' ? normalized.toLowerCase() : normalized}`;
  }
  isDirty(workspaceId: string, path: string) {
    const absolute = normalizePath(resolve(this.workspace(workspaceId).root, ...validRelative(path)));
    // Nested workspaces may name the same file; an unsaved editor in either one
    // protects that file from AI writes and undo.
    for (const key of this.dirty) {
      const split = key.indexOf(':'), id = key.slice(0, split), relative = key.slice(split + 1);
      const workspace = this.store.state.workspaces.find(w => w.id === id);
      if (workspace && normalizePath(resolve(workspace.root, ...validRelative(relative))) === absolute) return true;
    }
    return false;
  }
  async add(root: string) {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new Error('工作区必须是文件夹');
    let workspace = this.store.state.workspaces.find(w => w.root.toLowerCase() === canonical.toLowerCase());
    if (!workspace) { workspace = { id: randomUUID(), root: canonical, name: basename(canonical) }; this.store.state.workspaces.push(workspace); await this.store.save(); }
    return workspace;
  }
  async path(workspaceId: string, path: string, createParents = false) {
    const root = await this.root(workspaceId);
    const parts = validRelative(path);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      try {
        const item = await lstat(current);
        if (item.isSymbolicLink()) throw new Error('不允许通过符号链接或目录联接访问文件');
        if (i < parts.length - 1 && !item.isDirectory()) throw new Error('父路径不是文件夹');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (i < parts.length - 1 && createParents) {
          await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
          const created = await lstat(current);
          if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('父文件夹在创建期间发生变化');
        }
        else if (i < parts.length - 1) throw new Error('父文件夹不存在');
      }
    }
    const result = resolve(root, ...parts);
    const rel = relative(root, result);
    if (rel.startsWith('..') || isAbsolute(rel) || result === root) throw new Error('路径超出工作区');
    return result;
  }
  async bytes(workspaceId: string, path: string) {
    const resolved = await this.path(workspaceId, path);
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('目标不是普通文件');
    if (info.size > 50 * 1024 * 1024) throw new Error('首版支持不超过 50 MB 的单个文件');
    return readFile(resolved);
  }
  async list(workspaceId: string, path = ''): Promise<TreeEntry[]> {
    const root = path ? await this.path(workspaceId, path) : await this.root(workspaceId);
    const items = await readdir(root, { withFileTypes: true });
    return items.filter(e => !e.isSymbolicLink() && !ignored.has(e.name)).map(e => ({ name: e.name, path: [path, e.name].filter(Boolean).join('/'), directory: e.isDirectory() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }
  private async root(workspaceId: string) {
    const stored = this.workspace(workspaceId).root;
    if ((await lstat(stored)).isSymbolicLink()) throw new Error('工作区根目录已变成链接，请重新选择工作区');
    const canonical = await realpath(stored);
    const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
    if (normalize(canonical) !== normalize(stored)) throw new Error('工作区根目录已变化，请重新选择工作区');
    return canonical;
  }
  async search(workspaceId: string, query: string, content = false, options: SearchOptions = {}) {
    const root = await this.root(workspaceId), controller = new AbortController();
    const pending = this.searches.get(workspaceId) ?? new Map<AbortController, string | undefined>();
    pending.set(controller, options.searchId); this.searches.set(workspaceId, pending);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try { return await searchWorkspace(root, query, content, { ...options, signal }); }
    finally { pending.delete(controller); if (!pending.size) this.searches.delete(workspaceId); }
  }
  cancelSearch(workspaceId: string, searchId?: string) { for (const [controller, id] of this.searches.get(workspaceId) ?? []) if (!searchId || id === searchId) controller.abort(); }
  newChangeSet(workspaceId: string, sessionId: string): ChangeSet {
    const set: ChangeSet = { id: randomUUID(), workspaceId, sessionId, createdAt: Date.now(), changes: [] };
    this.store.state.changeSets.push(set);
    return set;
  }
  async write(workspaceId: string, path: string, expectedVersion: string | null, bytes: Uint8Array, set: ChangeSet, summary: string, allowDirty = false, semanticDiff?: string) {
    if (this.writing) throw new Error('正在保存其他文件，请稍后重试');
    if (this.activeTransaction && this.activeTransaction !== set.id) throw new Error('正在提交另一批文件修改，请稍后重试');
    if (set.workspaceId !== workspaceId || !this.store.state.changeSets.includes(set) || set.undone) throw new Error('文件修改日志与工作区不匹配或已撤销');
    if (bytes.length > 50 * 1024 * 1024) throw new Error('单个文件写入不得超过 50 MB');
    if (expectedVersion !== null && !/^[a-f\d]{64}$/.test(expectedVersion)) throw new Error('文件版本标识无效，请重新读取');
    path = validRelative(path).join('/');
    this.writing = true;
    try {
      if (!allowDirty && this.isDirty(workspaceId, path)) throw new Error('文件有未保存的编辑，请先保存或放弃编辑');
      const target = await this.path(workspaceId, path, true);
      const before = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const actualVersion = before ? hash(before) : null;
      if (actualVersion !== expectedVersion) throw new Error(`文件版本已变化，请重新读取后再编辑：${path}；计划版本 ${expectedVersion ?? '不存在'}，当前版本 ${actualVersion ?? '不存在'}`);
      if (before && actualVersion === hash(bytes)) return actualVersion;
      const backupDir = join(this.store.directory, 'backups', set.id);
      await mkdir(backupDir, { recursive: true });
      const backupName = before ? `${randomUUID()}.bin` : null;
      if (before && backupName) await atomicWrite(join(backupDir, backupName), before);
      const change: JournalChange = { path, before: backupName, beforeVersion: actualVersion, after: hash(bytes), status: 'prepared', summary, diff: semanticDiff };
      if (!semanticDiff && !/\.(docx|xlsx|pdf)$/i.test(path) && bytes.length <= 2*1024*1024 && (!before || before.length <= 2*1024*1024)) change.diff = await reviewPatch(path, before?.toString('utf8') ?? '', Buffer.from(bytes).toString('utf8'));
      set.changes.push(change);
      await this.store.save();
      // Recheck immediately before committing, including the directory/link boundary.
      await this.path(workspaceId, path);
      const latest = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if ((latest ? hash(latest) : null) !== expectedVersion) { change.status = 'restored'; await this.store.save(); throw new Error('保存前检测到外部修改，写入已停止'); }
      try { await atomicWrite(target, bytes, async () => {
        await this.path(workspaceId, path);
        if (!allowDirty && this.isDirty(workspaceId, path)) throw new Error('文件在保存期间出现未保存编辑，写入已停止');
        const current = await readFile(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if ((current ? hash(current) : null) !== expectedVersion) throw new Error('保存前检测到外部修改，写入已停止');
      }); }
      catch (error) {
        const current = await readFile(target).catch(() => null);
        if ((current ? hash(current) : null) === expectedVersion) { change.status = 'restored'; await this.store.save(); }
        throw new Error(`文件保存失败，原文件与快照已保留：${error instanceof Error ? error.message : String(error)}`);
      }
      change.status = 'committed';
      await this.store.save();
      return hash(bytes);
    } finally { this.writing = false; }
  }
  /** A recoverable batch: journal each write; rollback only bytes this batch owns. */
  async runTransaction<T>(set: ChangeSet, action: () => Promise<T>): Promise<T> {
    if (this.writing || this.activeTransaction) throw new Error('正在提交其他文件修改');
    if (!this.store.state.changeSets.includes(set) || set.undone) throw new Error('修改日志不可用');
    const durable = set as DurableChangeSet;
    if (durable.transaction && ['applying', 'rolling-back', 'conflict'].includes(durable.transaction.status)) throw new Error('此修改批次尚未恢复，请先处理恢复冲突');
    const transaction: Transaction = { id: randomUUID(), startIndex: set.changes.length, status: 'applying' };
    durable.transaction = transaction; this.activeTransaction = set.id;
    try {
      await this.store.save();
      const result = await action();
      transaction.status = 'completed'; await this.store.save();
      return result;
    } catch (error) {
      transaction.status = 'rolling-back'; transaction.error = error instanceof Error ? error.message : String(error);
      try {
        await this.store.save();
        this.writing = true;
        await this.rollback(set, transaction.startIndex);
        transaction.status = 'rolled-back'; await this.store.save();
      } catch (rollbackError) {
        transaction.status = 'conflict';
        transaction.error += `；恢复未完成：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
        await this.store.save().catch(() => undefined);
        throw new Error(`批量修改失败，部分文件需要处理恢复冲突；快照已保留。${transaction.error}`, { cause: error });
      }
      throw new Error(`批量修改失败，本批修改已安全撤销：${transaction.error}`, { cause: error });
    } finally { this.writing = false; this.activeTransaction = undefined; }
  }
  private async versionAt(workspaceId: string, path: string) {
    const target = await this.path(workspaceId, path);
    try { return hash(await readFile(target)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async backup(set: ChangeSet, change: JournalChange) {
    if (!change.before) return null;
    if (!/^[a-f\d-]{36}\.bin$/i.test(change.before) || !/^[a-f\d-]{36}$/i.test(set.id)) throw new Error('恢复快照路径无效');
    const bytes = await readFile(join(this.store.directory, 'backups', set.id, change.before));
    if (change.beforeVersion !== undefined && hash(bytes) !== change.beforeVersion) throw new Error(`${change.path} 的恢复快照校验失败，文件保持不变`);
    return bytes;
  }
  private async classify(set: ChangeSet, change: JournalChange) {
    try {
      const current = await this.versionAt(set.workspaceId, change.path);
      if (current === change.after) { change.status = 'committed'; delete change.recoveryError; }
      else if (change.beforeVersion !== undefined && current === change.beforeVersion) { change.status = 'restored'; delete change.recoveryError; }
      else { change.status = 'conflict'; change.recoveryError = `恢复版本冲突：${change.path}；写入后 ${change.after}，写入前 ${change.beforeVersion ?? '未知或不存在'}，当前 ${current ?? '不存在'}。未覆盖文件。`; }
    } catch (error) { change.status = 'conflict'; change.recoveryError = `恢复检查失败，未覆盖文件：${error instanceof Error ? error.message : String(error)}`; }
  }
  private async rollback(set: ChangeSet, startIndex = 0) {
    const changes = set.changes.slice(startIndex) as JournalChange[];
    for (const change of changes) if (change.status === 'prepared' || change.status === 'restoring' || change.status==='conflict') await this.classify(set, change);
    const pending = changes.filter(change => change.status !== 'restored');
    const last = new Map<string, JournalChange>();
    for (const change of pending) last.set(this.dirtyKey(set.workspaceId, change.path), change);
    // Check every target and every snapshot before touching the first file.
    for (const change of pending) {
      if (change.status === 'conflict') throw new Error(change.recoveryError ?? `${change.path} 存在恢复冲突`);
      await this.backup(set, change);
    }
    for (const change of last.values()) {
      if (this.isDirty(set.workspaceId, change.path)) throw new Error(`${change.path} 有未保存内容`);
      const current = await this.versionAt(set.workspaceId, change.path);
      if (current !== change.after) throw new Error(`${change.path} 已被再次修改，撤销已停止；期望 ${change.after}，当前 ${current ?? '不存在'}`);
    }
    for (const change of [...pending].reverse()) {
      const target = await this.path(set.workspaceId, change.path);
      const check = async () => {
        await this.path(set.workspaceId, change.path);
        if (this.isDirty(set.workspaceId, change.path) || await this.versionAt(set.workspaceId, change.path) !== change.after) throw new Error(`${change.path} 撤销过程中检测到外部修改，恢复已停止`);
      };
      await check();
      change.status = 'restoring'; await this.store.save();
      const bytes = await this.backup(set, change);
      if (bytes) await atomicWrite(target, bytes, check);
      else { await check(); await unlink(target); }
      change.status = 'restored'; delete change.recoveryError; await this.store.save();
    }
  }
  async recover() {
    let changed = false;
    for (const set of this.store.state.changeSets as DurableChangeSet[]) {
      for (const change of set.changes as JournalChange[]) {
        if (change.status !== 'prepared' && change.status !== 'restoring') continue;
        await this.classify(set, change); changed = true;
      }
      if (set.transaction && ['applying', 'rolling-back'].includes(set.transaction.status)) {
        this.writing = true;
        try {
          set.transaction.status = 'rolling-back'; await this.store.save();
          await this.rollback(set, set.transaction.startIndex);
          set.transaction.status = 'rolled-back';
          this.recoveryNotice(set, '应用上次退出时文件批次尚未完成，已从快照恢复。后续操作必须重新读取文件。');
        } catch (error) {
          set.transaction.status = 'conflict'; set.transaction.error = error instanceof Error ? error.message : String(error);
          this.recoveryNotice(set, `应用上次退出时文件批次尚未完成，自动恢复遇到冲突；文件与快照保留：${set.transaction.error}`);
        } finally { this.writing = false; }
        changed = true;
      }
      const conflicts = (set.changes as JournalChange[]).filter(change => change.status === 'conflict');
      if (conflicts.length) this.recoveryNotice(set, conflicts.map(c => c.recoveryError).join('\n'));
    }
    if (changed) await this.store.save();
  }
  private recoveryNotice(set: ChangeSet, text: string) {
    const session = this.store.state.sessions.find(s => s.id === set.sessionId);
    if (session && !session.messages.some(m => m.role === 'notice' && m.text === text)) {
      session.messages.push({ id: randomUUID(), role: 'notice', text, timestamp: Date.now() });
      session.context.push({ role: 'user', content: text, timestamp: Date.now() });
    }
  }
  async undo(workspaceId: string, setId?: string) {
    if (this.store.state.activeRun || this.writing || this.activeTransaction) throw new Error('请先停止当前任务');
    const set = [...this.store.state.changeSets].reverse().find(s => s.workspaceId === workspaceId && (!setId || s.id === setId) && !s.undone && s.changes.some(c => c.status !== 'restored')) as DurableChangeSet | undefined;
    if (!set) throw new Error('没有可撤销的修改');
    this.writing = true;
    try {
      const transaction: Transaction = { id: randomUUID(), startIndex: 0, status: 'rolling-back' };
      set.transaction = transaction; await this.store.save();
      try { await this.rollback(set); }
      catch (error) { transaction.status = 'conflict'; transaction.error = error instanceof Error ? error.message : String(error); await this.store.save(); throw error; }
      transaction.status = 'rolled-back'; set.undone = true;
      this.recoveryNotice(set, `用户已撤销修改：${[...new Set(set.changes.map(c => c.path))].join('、')}。之前工具报告的写入结果已失效，后续编辑必须重新读取。`);
      await this.store.save(); return set;
    } finally { this.writing = false; }
  }
}

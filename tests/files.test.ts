import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/store';
import { Files, hash } from '../src/main/workspace';
import { Documents } from '../src/main/documents';
const faults = vi.hoisted(() => ({ path: '' }));
vi.mock('../src/main/store', async importOriginal => {
  const original = await importOriginal<typeof import('../src/main/store')>();
  return { ...original, atomicWrite: async (target: string, data: Uint8Array | string, check?: () => Promise<void>) => { if (target === faults.path) throw new Error('EBUSY: 文件被占用'); return original.atomicWrite(target, data, check); } };
});

let root: string, store: Store, files: Files, docs: Documents, workspaceId: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'simple-agent-test-')); await mkdir(join(root, '中文 工作区')); store = new Store(join(root, 'state')); await store.init(); files = new Files(store); docs = new Documents(files, join(process.cwd(), 'resources')); workspaceId = (await files.add(join(root, '中文 工作区'))).id; });
afterEach(async () => { faults.path = ''; await rm(root, { recursive: true, force: true }); });
describe('workspace file transactions', () => {
  it('preserves UTF-8 BOM and CRLF and restores original bytes after restart', async () => {
    const original = Buffer.from('\ufeff第一行\r\n第二行\r\n'); await writeFile(join(root, '中文 工作区', '说明 文档.md'), original);
    const doc = await docs.inspect(workspaceId, '说明 文档.md'); expect(doc.kind).toBe('text');
    const set = files.newChangeSet(workspaceId, 'manual'); await docs.apply(workspaceId, doc.path, doc.version, [{ type: 'replace', oldText: '第二行', newText: '第三行\n第四行' }], set);
    expect(await readFile(join(root, '中文 工作区', doc.path), 'utf8')).toBe('\ufeff第一行\r\n第三行\r\n第四行\r\n');
    const reloaded = new Store(join(root, 'state')); await reloaded.init(); await new Files(reloaded).undo(workspaceId); expect(await readFile(join(root, '中文 工作区', doc.path))).toEqual(original);
  });
  it('rejects traversal, absolute, ADS, reserved and ambiguous Windows paths', async () => {
    for (const path of ['../outside.txt', '..\\outside.txt', 'C:\\outside.txt', '/outside', '\\\\server\\share', 'note.md:stream', 'CON.txt', 'folder./file', 'folder /file', 'a//b']) await expect(files.path(workspaceId, path, true)).rejects.toThrow();
  });
  it('rejects directory junctions before creating or reading any file', async () => {
    const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'outside'); await symlink(outside, join(root, '中文 工作区', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(files.bytes(workspaceId, 'linked/secret.txt')).rejects.toThrow('链接'); await expect(files.path(workspaceId, 'linked/new.txt', true)).rejects.toThrow();
  });
  it('rejects a workspace root replaced with a junction after selection', async () => {
    const workspace = join(root, '中文 工作区'), outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'secret'); await rename(workspace, join(root, 'original-workspace'));
    await symlink(outside, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(files.list(workspaceId)).rejects.toThrow('根目录'); await expect(files.bytes(workspaceId, 'secret.txt')).rejects.toThrow('根目录');
  });
  it('refuses stale revisions, dirty editors and undo over external changes', async () => {
    await writeFile(join(root, '中文 工作区', 'a.txt'), 'original'); const doc = await docs.inspect(workspaceId, 'a.txt'); files.dirty.add(`${workspaceId}:a.txt`);
    await expect(docs.apply(workspaceId, 'a.txt', doc.version, [{ type: 'set_text', text: 'ai' }], files.newChangeSet(workspaceId, 'manual'))).rejects.toThrow('未保存'); files.dirty.clear();
    await docs.apply(workspaceId, 'a.txt', doc.version, [{ type: 'set_text', text: 'ai' }], files.newChangeSet(workspaceId, 'manual'));
    await expect(docs.apply(workspaceId, 'a.txt', doc.version, [{ type: 'set_text', text: 'stale' }], files.newChangeSet(workspaceId, 'manual'))).rejects.toThrow('版本');
    await writeFile(join(root, '中文 工作区', 'a.txt'), 'external'); await expect(files.undo(workspaceId)).rejects.toThrow('再次修改'); expect(await readFile(join(root, '中文 工作区', 'a.txt'), 'utf8')).toBe('external');
  });
  it('reverses multiple writes and new files in one run', async () => {
    const set = files.newChangeSet(workspaceId, 'manual'); let doc = await docs.create(workspaceId, 'sub/a.txt', 'one', set); doc = await docs.apply(workspaceId, doc.path, doc.version, [{ type: 'set_text', text: 'two' }], set); await docs.create(workspaceId, 'b.txt', 'b', set);
    await files.undo(workspaceId); await expect(readFile(join(root, '中文 工作区', 'sub/a.txt'))).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(join(root, '中文 工作区', 'b.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('recovers a prepared write and interrupted undo from durable journal', async () => {
    await writeFile(join(root, '中文 工作区', 'a.txt'), 'before'); const set = files.newChangeSet(workspaceId, 'manual'); await files.write(workspaceId, 'a.txt', hash(Buffer.from('before')), Buffer.from('after'), set, 'test');
    set.changes[0].status = 'prepared'; await store.save(); await files.recover(); expect(set.changes[0].status).toBe('committed');
    set.changes[0].status = 'restoring'; await store.save(); await writeFile(join(root, '中文 工作区', 'a.txt'), 'before'); await files.recover(); expect(set.changes[0].status).toBe('restored');
  });
  it('does not overwrite existing files when creating', async () => { const set = files.newChangeSet(workspaceId, 'manual'); await docs.create(workspaceId, 'a.txt', 'first', set); await expect(docs.create(workspaceId, 'a.txt', 'second', set)).rejects.toThrow('版本'); expect(await readFile(join(root, '中文 工作区', 'a.txt'), 'utf8')).toBe('first'); });
  it('retains the original and backup when atomic replacement fails', async () => {
    faults.path = join(root, '中文 工作区', 'locked.txt'); await writeFile(faults.path, 'original'); const doc = await docs.inspect(workspaceId, 'locked.txt'); const set = files.newChangeSet(workspaceId, 'manual');
    await expect(docs.apply(workspaceId, doc.path, doc.version, [{ type: 'set_text', text: 'new' }], set)).rejects.toThrow('文件保存失败'); expect(await readFile(faults.path, 'utf8')).toBe('original'); expect(set.changes[0].status).toBe('restored'); expect(await readFile(join(store.directory, 'backups', set.id, set.changes[0].before!), 'utf8')).toBe('original');
  });
  it('normalizes Windows case and slash aliases for unsaved editor conflicts', async () => {
    await mkdir(join(root, '中文 工作区', 'sub')); await writeFile(join(root, '中文 工作区', 'sub', 'a.txt'), 'original'); const doc = await docs.inspect(workspaceId, 'sub/a.txt');
    files.dirty.add(files.dirtyKey(workspaceId, process.platform === 'win32' ? 'SUB\\A.TXT' : 'sub\\a.txt'));
    await expect(docs.apply(workspaceId, doc.path, doc.version, [{ type: 'set_text', text: 'ai' }], files.newChangeSet(workspaceId, 'manual'))).rejects.toThrow('未保存');
  });
  it('preserves existing data on corrupted state', async () => { await writeFile(join(root, 'state', 'state.json'), '{broken'); await expect(new Store(join(root, 'state')).init()).rejects.toThrow('原文件已保留'); expect(await readFile(join(root, 'state', 'state.json'), 'utf8')).toBe('{broken'); });
});

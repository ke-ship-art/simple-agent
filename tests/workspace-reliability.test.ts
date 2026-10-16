import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Files, hash } from '../src/main/workspace';
import { Store } from '../src/main/store';
import { Documents } from '../src/main/documents';

let root: string, workspace: string, store: Store, files: Files, docs: Documents, id: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'simple-agent-reliability-'));
  workspace = join(root, '中文 工作区'); await mkdir(workspace);
  store = new Store(join(root, 'state')); await store.init();
  files = new Files(store); id = (await files.add(workspace)).id;
  docs = new Documents(files, join(process.cwd(), 'resources'));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const version = (text: string) => hash(Buffer.from(text));

describe('recoverable file batches', () => {
  it('applies two dependent edits to the same file and undoes to byte-identical original', async () => {
    const original = Buffer.from('\ufeff甲\r\n乙\r\n'); await writeFile(join(workspace, 'a.txt'), original);
    const set = files.newChangeSet(id, 'test');
    await files.runTransaction(set, async () => {
      const first = await docs.apply(id, 'a.txt', hash(original), [{ type: 'replace', oldText: '甲', newText: '第一段' }], set);
      await docs.apply(id, 'a.txt', first.version, [{ type: 'replace', oldText: '乙', newText: '第二段' }], set);
    });
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('\ufeff第一段\r\n第二段\r\n');
    expect(set.changes).toHaveLength(2); await files.undo(id, set.id);
    expect(await readFile(join(workspace, 'a.txt'))).toEqual(original);
  });
  it('does not rewrite a stale plan version and rolls back earlier writes in the failed batch', async () => {
    await writeFile(join(workspace, 'a.txt'), 'alpha beta'); const set = files.newChangeSet(id, 'test');
    await expect(files.runTransaction(set, async () => {
      await files.write(id, 'a.txt', version('alpha beta'), Buffer.from('ALPHA beta'), set, 'one');
      await files.write(id, 'a.txt', version('alpha beta'), Buffer.from('alpha BETA'), set, 'stale');
    })).rejects.toThrow('本批修改已安全撤销');
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('alpha beta');
    expect(set.changes[0].status).toBe('restored');
  });
  it('commits independent replacements once and retains a line diff', async () => {
    await writeFile(join(workspace, 'a.txt'), 'alpha\nbeta\n'); const set = files.newChangeSet(id, 'test');
    await files.runTransaction(set, () => docs.apply(id, 'a.txt', version('alpha\nbeta\n'), [
      { type: 'replace', oldText: 'alpha', newText: 'ALPHA' }, { type: 'replace', oldText: 'beta', newText: 'BETA' }
    ], set));
    expect(set.changes).toHaveLength(1); expect(set.changes[0].diff).toContain('-alpha'); expect(set.changes[0].diff).toContain('+ALPHA');
  });
  it('rolls back both existing and new files when a later operation fails', async () => {
    await writeFile(join(workspace, 'a.txt'), 'original'); const set = files.newChangeSet(id, 'test');
    await expect(files.runTransaction(set, async () => {
      await files.write(id, 'a.txt', version('original'), Buffer.from('changed'), set, 'one');
      await files.write(id, 'b.txt', null, Buffer.from('new'), set, 'two');
      throw new Error('simulated validation failure');
    })).rejects.toThrow('本批修改已安全撤销');
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('original');
    await expect(readFile(join(workspace, 'b.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves external edits instead of forcing a batch rollback', async () => {
    await writeFile(join(workspace, 'a.txt'), 'original'); const set = files.newChangeSet(id, 'test');
    await expect(files.runTransaction(set, async () => {
      await files.write(id, 'a.txt', version('original'), Buffer.from('agent'), set, 'one');
      await writeFile(join(workspace, 'a.txt'), 'external'); throw new Error('later failure');
    })).rejects.toThrow('恢复冲突');
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('external');
    expect(set.transaction?.status).toBe('conflict');
    expect(await readFile(join(store.directory, 'backups', set.id, set.changes[0].before!), 'utf8')).toBe('original');
  });
  it('recovers an interrupted multi-file batch after restarting', async () => {
    await writeFile(join(workspace, 'a.txt'), 'original'); const set = files.newChangeSet(id, 'test');
    await files.write(id, 'a.txt', version('original'), Buffer.from('agent'), set, 'one');
    await files.write(id, 'b.txt', null, Buffer.from('new'), set, 'two');
    set.transaction = { id: 'simulated-transaction', startIndex: 0, status: 'applying' }; await store.save();
    const restored = new Store(store.directory); await restored.init(); await new Files(restored).recover();
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('original');
    await expect(readFile(join(workspace, 'b.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(restored.state.changeSets[0].transaction?.status).toBe('rolled-back');
  });
  it('marks uncertain recovery as a conflict with both versions and preserves external bytes', async () => {
    await writeFile(join(workspace, 'a.txt'), 'original'); const set = files.newChangeSet(id, 'test');
    await files.write(id, 'a.txt', version('original'), Buffer.from('agent'), set, 'one');
    set.changes[0].status = 'prepared'; await writeFile(join(workspace, 'a.txt'), 'external'); await store.save();
    const restored = new Store(store.directory); await restored.init(); await new Files(restored).recover();
    expect(restored.state.changeSets[0].changes[0].status).toBe('conflict');
    expect(restored.state.changeSets[0].changes[0].recoveryError).toContain(version('external'));
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('external');
  });
  it('rejects a corrupted backup before changing any file during undo', async () => {
    await writeFile(join(workspace, 'a.txt'), 'original'); const set = files.newChangeSet(id, 'test');
    await files.write(id, 'a.txt', version('original'), Buffer.from('agent'), set, 'one');
    await writeFile(join(store.directory, 'backups', set.id, set.changes[0].before!), 'corrupted');
    await expect(files.undo(id, set.id)).rejects.toThrow('快照校验失败');
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('agent');
  });
  it('protects unsaved content opened through a nested workspace alias', async () => {
    await mkdir(join(workspace, 'nested')); await writeFile(join(workspace, 'nested', 'a.txt'), 'original');
    const nested = await files.add(join(workspace, 'nested')); files.dirty.add(files.dirtyKey(nested.id, 'a.txt'));
    await expect(files.write(id, 'nested/a.txt', version('original'), Buffer.from('agent'), files.newChangeSet(id, 'test'), 'one')).rejects.toThrow('未保存');
  });
  it('rejects concurrent writes from another batch while a recoverable transaction is open', async () => {
    const first = files.newChangeSet(id, 'test'), second = files.newChangeSet(id, 'test');
    await files.runTransaction(first, async () => {
      await expect(files.write(id, 'b.txt', null, Buffer.from('other'), second, 'two')).rejects.toThrow('另一批');
      await files.write(id, 'a.txt', null, Buffer.from('own'), first, 'one');
    });
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('own');
  });
});

describe('isolated, bounded workspace search', () => {
  it('does not expose credential contents through full-text search',async()=>{
    await mkdir(join(workspace,'secrets'));await writeFile(join(workspace,'secrets','token.json'),'needle-private');await writeFile(join(workspace,'id_rsa'),'needle-private');await writeFile(join(workspace,'certificate.pem'),'needle-private');await writeFile(join(workspace,'public.txt'),'needle-public');
    const result=await files.search(id,'needle',true);expect(result.hits.map(h=>h.path)).toEqual(['public.txt']);expect((await files.search(id,'id_rsa')).hits).toContainEqual({path:'id_rsa'});
  });
  it('streams huge single-line UTF-8 and CSV with correct lines, bounded previews and encoding exclusions', async () => {
    await writeFile(join(workspace, 'large.json'), 'a'.repeat(3 * 1024 * 1024) + '目标');
    await writeFile(join(workspace, 'rows.csv'), 'id,value\r\n1,目标\r\n2,no\r\n');
    await writeFile(join(workspace, 'legacy.txt'), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
    await writeFile(join(workspace, '.env'), '目标=secret');
    const result = await files.search(id, '目标', true, { maxFileBytes: 4 * 1024 * 1024 });
    expect(result.hits.map(h => h.path).sort()).toEqual(['large.json', 'rows.csv']);
    expect(result.hits.find(h => h.path === 'large.json')?.text).toHaveLength(500);
    expect(result.hits.find(h => h.path === 'rows.csv')?.line).toBe(2);
    expect(result.stats.skippedFiles).toBe(2); expect(result.stats.scannedFiles).toBe(2);
  });
  it('honors exclude globs, hit limits and maximum file sizes', async () => {
    await mkdir(join(workspace, 'skip')); await writeFile(join(workspace, 'skip', 'secret.txt'), 'needle');
    await writeFile(join(workspace, 'one.txt'), 'needle\nneedle'); await writeFile(join(workspace, 'too-big.txt'), 'needle'.repeat(1000));
    const result = await files.search(id, 'needle', true, { excludes: ['**/skip/**'], maxFileBytes: 100, maxHits: 1 });
    expect(result.hits).toHaveLength(1); expect(result.hits[0].path).toBe('one.txt'); expect(result.truncated).toBe(true);
  });
  it('cancels large searches without blocking the main event loop', async () => {
    const block = 'x'.repeat(1024 * 1024);
    await Promise.all(Array.from({ length: 24 }, (_, i) => writeFile(join(workspace, `${i}.json`), block.repeat(4))));
    const controller = new AbortController(); let progress = 0, ticks = 0;
    const interval = setInterval(() => { ticks++; }, 1);
    try {
      await expect(files.search(id, 'not-present', true, { maxFileBytes: 5 * 1024 * 1024, signal: controller.signal, onProgress: () => { progress++; controller.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
      expect(progress).toBeGreaterThan(0); expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(interval); }
    // Cancellation releases file handles; a fresh search can run immediately.
    expect((await files.search(id, '0.json')).hits).toContainEqual({ path: '0.json' });
  });
  it('supports cancellation by workspace and already-aborted signals', async () => {
    await writeFile(join(workspace, 'a.txt'), 'x'.repeat(2 * 1024 * 1024));
    await expect(files.search(id, 'missing', true, { onProgress: () => files.cancelSearch(id) })).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController(); controller.abort();
    await expect(files.search(id, 'x', true, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

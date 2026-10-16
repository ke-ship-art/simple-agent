import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResourceReference, Session } from '../shared/types';
import { atomicWrite } from './store';

const idPattern = /^[a-f0-9]{64}$/;
export function resourceReferences(value: unknown): ResourceReference[] {
  const refs: ResourceReference[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'resource' && idPattern.test(node.resourceId)) refs.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else Object.values(node).forEach(visit);
  };
  visit(value); return refs;
}

/** Content-addressed assets are committed before their reference enters state.json. */
export class Resources {
  readonly directory: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(directory: string) { this.directory = join(directory, 'resources'); }
  put(data: string, metadata: Omit<ResourceReference, 'type' | 'resourceId' | 'bytes'>): Promise<ResourceReference> {
    const task=this.pending.catch(()=>undefined).then(()=>this.putAsset(data,metadata));this.pending=task;return task;
  }
  private async putAsset(data: string, metadata: Omit<ResourceReference, 'type' | 'resourceId' | 'bytes'>): Promise<ResourceReference> {
    if (!['image/png', 'image/jpeg'].includes(metadata.mimeType) || data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('页面图片格式无效或超过 20 MB');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('页面图片为空或过大');
    const resourceId = createHash('sha256').update(bytes).digest('hex');
    await mkdir(this.directory, { recursive: true });
    const existing = await readFile(join(this.directory, resourceId)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if (!existing || createHash('sha256').update(existing).digest('hex') !== resourceId) await atomicWrite(join(this.directory, resourceId), bytes);
    return { ...metadata, type: 'resource', resourceId, bytes: bytes.length };
  }
  async load(ref: ResourceReference) {
    if (!idPattern.test(ref.resourceId)) throw new Error('图片资源编号无效');
    const bytes = await readFile(join(this.directory, ref.resourceId)).catch(() => { throw new Error(`历史图片资源不可用：${ref.source} 第 ${ref.page ?? '?'} 页，请重新读取源文件`); });
    if (createHash('sha256').update(bytes).digest('hex') !== ref.resourceId) throw new Error('历史图片资源已损坏，请重新读取源文件');
    return { type: 'image' as const, data: bytes.toString('base64'), mimeType: ref.mimeType };
  }
  async migrate(sessions: Session[]) {
    let changed = false;
    for (const session of sessions) for (const message of session.context as any[]) if (Array.isArray(message?.content)) {
      for (let i = 0; i < message.content.length; i++) {
        const block = message.content[i];
        if (block?.type !== 'image') continue;
        let source = '历史图片', page: number | undefined, version: string | undefined;
        for (const other of message.content.slice(0, i)) if (other.type === 'text') {
          try { const json = JSON.parse(other.text); if (typeof json.path === 'string') { source = json.path; version = json.version; } } catch { const match = /^(.*) 第 (\d+) 页$/.exec(other.text); if (match) { source = match[1]; page = Number(match[2]); } }
        }
        message.content[i] = await this.put(block.data, { source, page, version, summary: `历史页面图片，已有识别结果保留在会话文字中`, mimeType: block.mimeType });
        changed = true;
      }
    }
    return changed;
  }
  /** Both state generations are roots. Orphans from interrupted writes have a 24h grace period. */
  collect(roots: unknown[], graceMs = 24 * 3600 * 1000, canCollect=()=>true) {
    const task=this.pending.catch(()=>undefined).then(()=>this.collectAssets(roots,graceMs,canCollect));this.pending=task;return task;
  }
  private async collectAssets(roots: unknown[], graceMs: number, canCollect:()=>boolean) {
    const used = new Set(roots.flatMap(resourceReferences).map(ref => ref.resourceId));
    for (const name of await readdir(this.directory).catch(() => [] as string[])) {
      if (!idPattern.test(name) || used.has(name)) continue;
      const target = join(this.directory, name), info = await stat(target);
      if (!canCollect())return;
      if (Date.now() - info.mtimeMs >= graceMs) await unlink(target);
    }
  }
}

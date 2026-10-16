import { Files, hash } from './workspace';
import { Store } from './store';
export async function reviewChanges(store: Store, files: Files, workspaceId: string, setId: string) {
  const set = store.state.changeSets.find(s => s.id === setId && s.workspaceId === workspaceId);
  if (!set) throw new Error('修改记录不存在');
  const grouped = new Map<string, typeof set.changes>();
  for (const change of set.changes) { const key = files.dirtyKey(workspaceId, change.path); const list = grouped.get(key) ?? []; list.push(change); grouped.set(key, list); }
  const items = [];
  for (const changes of grouped.values()) {
    const latest = changes.filter(c => c.status !== 'restored').at(-1), path = changes[0].path;
    const bytes = await files.bytes(workspaceId, path).catch(() => null);
    const conflict = !!latest && (!['committed','conflict'].includes(latest.status) || !bytes || hash(bytes) !== latest.after || files.isDirty(workspaceId, path));
    const patches = changes.map(c => c.diff ?? c.summary), lines = patches.join('\n').split('\n');
    items.push({ path, patches, conflict, added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length, removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length });
  }
  return { setId, files: items, canUndo: !set.undone && set.changes.some(c=>c.status==='committed'||c.status==='conflict') && !items.some(i => i.conflict), reviewedAt: set.reviewedAt, undone: set.undone };
}
export async function acceptChanges(store: Store, files: Files, workspaceId: string, setId: string) {
  if (store.state.activeRun) throw new Error('请先等待任务完成');
  const review = await reviewChanges(store, files, workspaceId, setId);
  if (!review.canUndo) throw new Error('文件存在后续修改、未保存内容或恢复冲突，请先检查，不能确认旧版本。');
  const set=store.state.changeSets.find(s=>s.id===setId)!,previous=set.reviewedAt;set.reviewedAt=Date.now();try{await store.save();}catch(error){set.reviewedAt=previous;throw error;} return review;
}

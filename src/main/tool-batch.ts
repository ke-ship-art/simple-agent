import type { ChangeSet, FileOperation } from '../shared/types';
import { Documents } from './documents';
import { Files } from './workspace';

export interface EditPlan { path: string; version: string; operations: FileOperation[]; }
/** Plans on a shared snapshot are merged only when their original targets are provably disjoint. */
export async function mergeEditPlans(documents: Documents, files: Files, workspaceId: string, plans: EditPlan[]) {
  const groups = new Map<string, EditPlan[]>();
  for (const plan of plans) {
    const key = files.dirtyKey(workspaceId, plan.path);
    const group = groups.get(key) ?? []; group.push(plan); groups.set(key, group);
  }
  const merged: EditPlan[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (group.length === 1) { merged.push(first); continue; }
    if (group.some(p => p.version !== first.version)) throw new Error(`${first.path}：同批编辑使用不同版本，无法证明依赖关系；请重新读取后规划。`);
    const doc = await documents.inspect(workspaceId, first.path);
    if (doc.version !== first.version) throw new Error(`${first.path}：文件版本冲突，计划 ${first.version}，实际 ${doc.version}；请重新读取。`);
    const ops = group.flatMap(p => p.operations);
    if (doc.kind === 'text' && ops.every(op => op.type === 'replace')) {
      const spans = ops.map(op => {
        const at = doc.text.indexOf(op.oldText);
        if (!op.oldText || at < 0 || doc.text.indexOf(op.oldText, at + 1) >= 0) throw new Error(`${first.path}：批量替换目标不唯一或依赖另一项修改；请重新读取并拆分操作。`);
        return { at, end: at + op.oldText.length, text: op.newText };
      }).sort((a, b) => a.at - b.at);
      if (spans.some((s, i) => i > 0 && s.at < spans[i - 1].end)) throw new Error(`${first.path}：同批编辑范围重叠，未写入；请重新读取并规划。`);
      let text = doc.text;
      for (const span of spans.reverse()) text = text.slice(0, span.at) + span.text + text.slice(span.end);
      merged.push({ ...first, operations: [{ type: 'set_text', text }] });
    } else {
      const targets = new Set<string>();
      for (const op of ops) {
        const sheet=op.type==='cell'&&doc.kind==='xlsx'?doc.sheets.find(s=>s.id===op.sheetId||s.name===op.sheetId):undefined;
        const key = op.type === 'cell' && sheet ? `cell:${sheet.id}:${op.ref.toUpperCase()}` : op.type === 'word_replace' ? `word:${op.blockId}` : null;
        if (!key || targets.has(key)) throw new Error(`${first.path}：同批编辑存在依赖或无法安全合并的结构操作，未写入；请重新读取并拆分。`);
        targets.add(key);
      }
      merged.push({ ...first, operations: ops });
    }
  }
  return merged;
}

export async function applyEditBatch(documents: Documents, files: Files, workspaceId: string, plans: EditPlan[], set: ChangeSet, signal: AbortSignal) {
  const merged = await mergeEditPlans(documents, files, workspaceId, plans);
  return files.runTransaction(set, async () => {
    const results = new Map<string, {path: string; kind: string; version: string; summary?: string; message: string}>();
    for (const plan of merged) {
      signal.throwIfAborted();
      const doc = await documents.apply(workspaceId, plan.path, plan.version, plan.operations, set, false, signal);
      results.set(files.dirtyKey(workspaceId, plan.path), { path: doc.path, kind: doc.kind, version: doc.version, summary: set.changes.at(-1)?.summary, message: '批量修改已保存；继续编辑前请重新读取最新内容。' });
    }
    return plans.map(plan => results.get(files.dirtyKey(workspaceId, plan.path))!);
  });
}

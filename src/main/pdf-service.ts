import { randomUUID } from 'node:crypto';
import type { PdfResult, PdfTask } from '../shared/types';

export interface PdfRenderer {
  readonly sender: unknown;
  send(task: PdfTask): void;
  destroy(): void;
}
type Pending = { resolve(value: PdfResult): void; reject(error: Error): void; finish(): void };
/** A failed renderer never retries a request silently. Its next generation serves new requests. */
export class PdfService {
  private renderer?: PdfRenderer;
  private creating?: Promise<PdfRenderer>;
  private generation = 0;
  private closed = false;
  private attempts: number[] = [];
  private pending = new Map<string, Pending>();
  constructor(private readonly create: (failed: (reason: string) => void) => Promise<PdfRenderer>, private readonly options = { timeoutMs: 60000, startTimeoutMs: 15000, restartLimit: 3, restartWindowMs: 60000 }) {}
  async start() { await this.ready(); }
  private async ready(): Promise<PdfRenderer> {
    if (this.closed) throw new Error('PDF 渲染服务已关闭');
    if (this.renderer) return this.renderer;
    if (this.creating) return this.creating;
    const now = Date.now(); this.attempts = this.attempts.filter(time => now - time < this.options.restartWindowMs);
    if (this.attempts.length >= this.options.restartLimit) throw new Error('PDF 渲染服务连续失败，已暂停自动重建；请稍后重试，或检查此 PDF 是否损坏');
    this.attempts.push(now);
    const generation = ++this.generation;
    this.creating = new Promise<PdfRenderer>((resolve, reject) => {
      const timer = setTimeout(() => { if (generation === this.generation) this.generation++; reject(new Error('PDF 渲染服务启动超时，请稍后重试')); }, this.options.startTimeoutMs);
      void this.create(reason => { if (generation === this.generation) this.fail(reason); }).then(renderer => {
        clearTimeout(timer);
        if (this.closed || generation !== this.generation) { renderer.destroy(); reject(new Error('PDF 渲染服务在启动期间退出')); return; }
        this.renderer = renderer; resolve(renderer);
      }, error => { clearTimeout(timer); reject(error); });
    }).finally(() => { this.creating = undefined; });
    return this.creating;
  }
  private fail(reason: string) {
    const renderer = this.renderer; this.renderer = undefined; this.generation++;
    const error = new Error(reason);
    for (const pending of [...this.pending.values()]) pending.reject(error);
    renderer?.destroy();
    // Let a failed startup finish before creating its successor.
    if (!this.closed) setTimeout(() => { void this.ready().catch(() => undefined); }, 100);
  }
  receive(sender: unknown, value: unknown) {
    if (!this.renderer || sender !== this.renderer.sender || !value || typeof value !== 'object') return;
    const reply = value as { id?: string; error?: unknown; result?: PdfResult };
    const pending = typeof reply.id === 'string' ? this.pending.get(reply.id) : undefined;
    if (!pending) return;
    if (reply.error) pending.reject(new Error(String(reply.error).slice(0, 2000)));
    else if (!reply.result || !Array.isArray(reply.result.pages) || reply.result.pages.length > 3 || reply.result.pages.some(page => typeof page.number !== 'number' || typeof page.text !== 'string' || !Array.isArray(page.annotations) || (page.image !== undefined && (typeof page.image !== 'string' || page.image.length > 12000000)))) pending.reject(new Error('PDF 渲染服务返回了无效或过大的页面数据'));
    else pending.resolve(reply.result);
  }
  async render(bytes: Uint8Array, pages: number[], render: boolean, signal?: AbortSignal): Promise<PdfResult> {
    signal?.throwIfAborted();
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('PDF 超过 100 MB 渲染限制，请拆分文档后重试');
    if (!pages.length || pages.length > 3 || pages.some(page => !Number.isInteger(page) || page < 1)) throw new Error('每次 PDF 读取须指定 1 至 3 个有效页码');
    if (this.pending.size >= 2) throw new Error('PDF 渲染服务正在处理其他请求，请稍后重试');
    const renderer = await this.ready(); signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise<PdfResult>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending.delete(id); };
      const cancel = () => { pending.reject(new Error('PDF 读取已取消')); this.fail('PDF 渲染任务已取消，请重新读取'); };
      const timer = setTimeout(() => this.fail('PDF 处理超时；渲染服务将重建，请减少页数后重试'), this.options.timeoutMs);
      const pending: Pending = { finish, resolve: result => { finish(); resolve(result); }, reject: error => { finish(); reject(error); } };
      this.pending.set(id, pending); signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      try { renderer.send({ id, bytes, pages, render }); } catch { this.fail('PDF 渲染进程已退出，请重新读取'); }
    });
  }
  close() {
    this.closed = true;
    this.fail('应用正在关闭，PDF 读取已停止');
  }
}

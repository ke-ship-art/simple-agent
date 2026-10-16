import { expect, it, vi } from 'vitest';
import { PdfService, type PdfRenderer } from '../src/main/pdf-service';
import type { PdfTask } from '../src/shared/types';

function fixture(options = { timeoutMs: 100, startTimeoutMs: 100, restartLimit: 3, restartWindowMs: 60000 }) {
  const renderers: (PdfRenderer & { fail(reason: string): void; tasks: PdfTask[]; destroyed: boolean })[] = [];
  const service = new PdfService(async failed => {
    const renderer = { sender: {}, tasks: [] as PdfTask[], destroyed: false, send(task: PdfTask) { this.tasks.push(task); }, destroy() { this.destroyed = true; }, fail: failed };
    renderers.push(renderer); return renderer;
  }, options);
  return { service, renderers };
}
const bytes = new Uint8Array([1, 2, 3]);
it('rejects waiting requests after renderer crash and serves later requests with a new renderer', async () => {
  const { service, renderers } = fixture();
  await service.start(); const pending = service.render(bytes, [1], true);
  await vi.waitFor(() => expect(renderers[0].tasks).toHaveLength(1));
  renderers[0].fail('renderer crashed'); await expect(pending).rejects.toThrow('crashed');
  const recovered = service.render(bytes, [2], true);
  await vi.waitFor(() => expect(renderers).toHaveLength(2));
  await vi.waitFor(() => expect(renderers[1].tasks).toHaveLength(1));
  service.receive(renderers[0].sender, { id: renderers[1].tasks[0].id, result: { pages: [] } });
  service.receive(renderers[1].sender, { id: renderers[1].tasks[0].id, result: { pages: [{ number: 2, text: '恢复', annotations: [] }] } });
  expect((await recovered).pages[0].text).toBe('恢复'); expect(renderers[0].destroyed).toBe(true); service.close();
});
it('times out and recreates a hung renderer, and rate limits repeated crashes', async () => {
  const { service, renderers } = fixture({ timeoutMs: 15, startTimeoutMs: 100, restartLimit: 2, restartWindowMs: 60000 });
  await expect(service.render(bytes, [1], false)).rejects.toThrow('超时');
  await service.start(); renderers[1].fail('second crash');
  await expect(service.render(bytes, [1], false)).rejects.toThrow('连续失败');
  expect(renderers).toHaveLength(2); service.close();
});
it('cancels a render, clears resources and never resurrects a renderer during shutdown', async () => {
  const { service, renderers } = fixture(); const controller = new AbortController();
  const pending = service.render(bytes, [1], false, controller.signal);
  await vi.waitFor(() => expect(renderers[0]?.tasks).toHaveLength(1));
  controller.abort(); await expect(pending).rejects.toThrow('取消');
  service.close(); await expect(service.start()).rejects.toThrow('关闭');
  expect(renderers.every(renderer => renderer.destroyed)).toBe(true);
});
it('bounds startup and closes a renderer that finishes after shutdown', async () => {
  let finish!: (renderer: PdfRenderer) => void;
  const destroy = vi.fn(), service = new PdfService(() => new Promise(resolve => { finish = resolve; }), { timeoutMs: 10, startTimeoutMs: 10, restartLimit: 3, restartWindowMs: 60000 });
  const pending = service.start(); await expect(pending).rejects.toThrow('启动超时');
  service.close(); finish({ sender: {}, send() {}, destroy });
  await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
});

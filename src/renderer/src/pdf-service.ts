import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfResult } from '../../shared/types';
import { pdfOptions } from './pdf-options';
GlobalWorkerOptions.workerSrc = workerUrl;
window.agent.onPdfTask(task => {
  void (async () => {
    const loading = getDocument({ data: new Uint8Array(task.bytes), ...pdfOptions });
    const pdf = await loading.promise;
    try {
      const result: PdfResult = { pages: [] };
      for (const number of task.pages) {
        const page = await pdf.getPage(number), content = await page.getTextContent();
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        const annotations = (await page.getAnnotations()).map(a => a.contentsObj?.str ?? a.contents ?? '').filter(Boolean);
        let image: string | undefined;
        if (task.render) {
          const original = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(original.width, original.height)) });
          const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
          image = canvas.toDataURL('image/png').split(',')[1];
        }
        result.pages.push({ number, text: text.slice(0, 50000), annotations, image });
        page.cleanup();
      }
      window.agent.pdfResult(task.id, result);
    } finally { await loading.destroy(); }
  })().catch(error => window.agent.pdfResult(task.id, undefined, String(error)));
});

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { IndexHtmlTransformContext } from 'vite';

export function rendererCsp() {
  return { name: 'renderer-dev-csp', transformIndexHtml(html: string, context: IndexHtmlTransformContext) {
    return context.server ? html.replace("script-src 'self' 'wasm-unsafe-eval';", "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline';").replace("connect-src 'self';","connect-src 'self' ws://localhost:* http://localhost:*;") : html;
  } };
}

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: {
    plugins: [react(), rendererCsp()],
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), pdf: resolve('src/renderer/pdf.html') } } }
  }
});

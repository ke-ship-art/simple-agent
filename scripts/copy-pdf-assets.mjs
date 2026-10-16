import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const target = resolve('src/renderer/public/pdfjs');
await mkdir(target, { recursive: true });
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(resolve('node_modules/pdfjs-dist', folder), resolve(target, folder), { recursive: true });
}

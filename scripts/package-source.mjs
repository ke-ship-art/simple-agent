import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';
const parts = {};
async function collect(directory) {
  for (const entry of await readdir(resolve(directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path);
    else parts[`simple-agent/${path}`] = new Uint8Array(await readFile(path));
  }
}
for (const directory of ['src/main', 'src/preload', 'src/shared', 'src/renderer/src', 'tests', 'scripts', 'resources', 'docs']) await collect(directory);
for (const file of ['README.md', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'electron.vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'src/renderer/index.html', 'src/renderer/pdf.html']) parts[`simple-agent/${file}`] = new Uint8Array(await readFile(file));
await mkdir('release', { recursive: true });
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const output = `release/Simple-Agent-${version}-source.zip`;
await writeFile(output, zipSync(parts, { level: 6 }));
console.log(`源码包已保存：${output}`);

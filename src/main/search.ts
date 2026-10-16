import { Worker } from 'node:worker_threads';

export interface SearchProgress { visited: number; scannedFiles: number; skippedFiles: number; bytesRead: number; hits: number; currentPath?: string; }
export interface SearchOptions {
  searchId?: string;
  signal?: AbortSignal;
  excludes?: string[];
  maxFileBytes?: number;
  maxFiles?: number;
  maxHits?: number;
  onProgress?: (progress: SearchProgress) => void;
}
export interface SearchResult {
  hits: { path: string; line?: number; text?: string }[];
  truncated: boolean;
  stats: SearchProgress;
}

// Keep the worker self-contained so it also runs from Electron's bundled main.js.
// Blocking directory enumeration and decoding happen only inside this worker.
const source = String.raw`
const { parentPort, workerData: data } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'release', '.next']);
const stats = { visited: 0, scannedFiles: 0, skippedFiles: 0, bytesRead: 0, hits: 0 };
const hits = [];
let truncated = false, lastProgress = 0;
const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
const root = fs.realpathSync(data.root);
const prefix = normalize(root + path.sep);
const excluded = data.excludes.map(pattern => {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { out += '(?:.*/)?'; i++; } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '(?:/.*)?$', 'i');
});
function progress(currentPath, force = false) {
  stats.hits = hits.length;
  if (force || Date.now() - lastProgress >= 75) {
    lastProgress = Date.now(); parentPort.postMessage({ type: 'progress', value: { ...stats, currentPath } });
  }
}
function inside(target) {
  const canonical = normalize(fs.realpathSync(target));
  if (canonical !== normalize(root) && !canonical.startsWith(prefix)) throw new Error('搜索路径超出工作区');
}
function scan(target, relative, initial) {
  let fd;
  const localHits = [];
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(target, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > data.maxFileBytes || opened.ino !== initial.ino || opened.dev !== initial.dev) { stats.skippedFiles++; return; }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const chunk = Buffer.allocUnsafe(65536);
    let line = 1, preview = '', tail = '', matched = false, total = 0;
    function part(value, endLine) {
      if (preview.length < 500) preview += value.slice(0, 500 - preview.length);
      const lower = tail + value.toLowerCase();
      if (lower.includes(data.query)) matched = true;
      tail = data.query.length > 1 ? lower.slice(-(data.query.length - 1)) : '';
      if (endLine) {
        if (matched && hits.length + localHits.length < data.maxHits) localHits.push({ path: relative, line, text: preview.replace(/\r$/, '') });
        line++; preview = ''; tail = ''; matched = false;
      }
    }
    function consume(value) {
      let start = 0, end;
      while ((end = value.indexOf('\n', start)) >= 0) { part(value.slice(start, end), true); start = end + 1; }
      part(value.slice(start), false);
    }
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count; stats.bytesRead += count;
      if (total > data.maxFileBytes || chunk.subarray(0, count).includes(0)) { stats.skippedFiles++; return; }
      consume(decoder.decode(chunk.subarray(0, count), { stream: true }));
      progress(relative);
    }
    consume(decoder.decode()); part('', true);
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) { stats.skippedFiles++; return; }
    stats.scannedFiles++; hits.push(...localHits);
    if (hits.length >= data.maxHits) truncated = true;
  } catch { stats.skippedFiles++; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function walk(dir, relative = '') {
  inside(dir);
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (stats.visited >= data.maxFiles || hits.length >= data.maxHits) { truncated = true; return; }
    const name = relative ? relative + '/' + item.name : item.name;
    if (item.isSymbolicLink() || ignored.has(item.name) || excluded.some(rule => rule.test(name))) continue;
    stats.visited++; progress(name);
    const target = path.join(dir, item.name);
    try {
      const info = fs.lstatSync(target);
      if (info.isSymbolicLink()) { stats.skippedFiles++; continue; }
      inside(target);
      if (info.isDirectory()) { walk(target, name); continue; }
      if (!info.isFile()) continue;
      if (!data.content) { if (name.toLowerCase().includes(data.query)) hits.push({ path: name }); continue; }
      if (info.size > data.maxFileBytes || /\.(docx?|xlsx?|xlsm|pdf|png|jpe?g|gif|webp|zip|exe|dll|woff2?|ttf|otf|mp[34]|pem|key|p12|pfx)$/i.test(name) || /(^|\/)(?:\.env|id_rsa|id_ed25519|credentials|secrets?|api[-_]?keys?|private[-_]?keys?)(?:[./]|$)/i.test(name)) { stats.skippedFiles++; continue; }
      scan(target, name, info);
    } catch { stats.skippedFiles++; }
  }
}
try { walk(root); progress(undefined, true); parentPort.postMessage({ type: 'result', value: { hits, truncated, stats } }); }
catch (error) { parentPort.postMessage({ type: 'error', message: error.message }); }
`;

export function searchWorkspace(root: string, query: string, content: boolean, options: SearchOptions = {}): Promise<SearchResult> {
  if (!query || query.length > 1000) return Promise.reject(new Error('搜索关键词长度须为 1–1000 字符'));
  const limit = (value: number | undefined, fallback: number, maximum: number) => Number.isInteger(value) && value! > 0 ? Math.min(value!, maximum) : fallback;
  if (options.signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 }, workerData: {
      root, query: query.toLowerCase(), content,
      maxFileBytes: limit(options.maxFileBytes, 2 * 1024 * 1024, 50 * 1024 * 1024),
      maxFiles: limit(options.maxFiles, 20000, 100000), maxHits: limit(options.maxHits, 100, 1000),
      excludes: (options.excludes ?? []).slice(0, 100).filter(p => typeof p === 'string' && p.length <= 500).map(p => p.replaceAll('\\', '/'))
    } });
    let settled = false;
    const finish = (error?: Error, value?: SearchResult) => {
      if (settled) return;
      settled = true; options.signal?.removeEventListener('abort', cancel);
      // Wait for termination to release file handles before callers dispose
      // temporary workspaces or start a replacement search on Windows.
      void worker.terminate().finally(() => { if (error) reject(error); else resolve(value!); });
    };
    const cancel = () => finish(aborted());
    options.signal?.addEventListener('abort', cancel, { once: true });
    // Cover the race between checking the signal and registering its listener.
    if (options.signal?.aborted) { cancel(); return; }
    worker.on('message', message => {
      if (message.type === 'progress') { try { options.onProgress?.(message.value); } catch { /* UI observers cannot change search results. */ } }
      else if (message.type === 'result') finish(undefined, message.value);
      else if (message.type === 'error') finish(new Error(`搜索失败：${message.message}`));
    });
    worker.on('error', error => finish(new Error(`搜索服务异常：${error.message}`)));
    worker.on('exit', code => { if (!settled) finish(new Error(`搜索服务意外退出（${code}）`)); });
  });
}
function aborted() { const error = new Error('搜索已取消'); error.name = 'AbortError'; return error; }

import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { rendererCsp } from '../../electron.vite.config';

test('development renderer starts with React refresh and isolated preload', async ({}, info) => {
  test.skip(!!process.env.SIMPLE_AGENT_PACKAGED_EXE, '便携包使用构建后的静态界面');
  const server = await createServer({ configFile: false, root: resolve('src/renderer'), plugins: [react(), rendererCsp()], server: { host: 'localhost', port: 0 } });
  await server.listen();
  const env = { ...process.env, SIMPLE_AGENT_TEST: '1', SIMPLE_AGENT_DATA_DIR: info.outputPath('data'), ELECTRON_RENDERER_URL: server.resolvedUrls!.local[0].replace(/\/$/, '') }; delete (env as any).ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 });
  try {
    const page = await app.waitForEvent('window', { predicate: p => p.url().includes('index.html'), timeout: 30000 }).catch(() => app.windows().find(p => p.url().includes('index.html'))!);
    await expect(page.getByText('Simple Agent', { exact: true })).toBeVisible({ timeout: 30000 }); await expect(page.getByRole('button', { name: '配置第一个模型', exact: true })).toBeVisible();
    expect(await page.evaluate(() => typeof window.agent.invoke)).toBe('function'); expect(await page.evaluate(() => 'require' in window)).toBe(false);
  } finally { await app.close(); await server.close(); }
});

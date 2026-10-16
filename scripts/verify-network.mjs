import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Uses only the public login metadata endpoint, never credentials or an account.
const data = await mkdtemp(join(tmpdir(), 'simple-agent-network-check-'));
const env = { ...process.env, SIMPLE_AGENT_TEST: '1', SIMPLE_AGENT_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ ...(process.argv[2] ? { executablePath: resolve(process.argv[2]), args: [] } : { args: [resolve('out/main/index.js')] }), env, timeout: 30000 });
  const page = await app.waitForEvent('window', { predicate: page => page.url().endsWith('/index.html') }).catch(() => app.windows().find(page => page.url().endsWith('/index.html')));
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('button', { name: '保存并测试网络', exact: true }).click();
  await page.waitForFunction(() => /网络连接成功|网络连接失败|超时|HTTP 4|HTTP 5/.test(document.querySelector('[role=status]')?.textContent ?? ''), undefined, { timeout: 25000 });
  const status = await page.getByRole('status').innerText();
  console.log(status);
  if (!status.includes('网络连接成功')) throw new Error('实际代理网络验证未通过');
} finally {
  await app?.close();
  await rm(data, { recursive: true, force: true });
}

import { setGlobalProxyFromEnv } from 'node:http';
import { z } from 'zod';
import type { NetworkSettings } from '../shared/types';

export const defaultNetwork = (): NetworkSettings => ({ enabled: false, proxyUrl: '' });
const schema = z.object({ enabled: z.boolean(), proxyUrl: z.string().trim().max(2048) });
export function validateNetwork(input: unknown): NetworkSettings {
  const settings = schema.parse(input);
  if (!settings.enabled && !settings.proxyUrl) return settings;
  let url: URL;
  try { url = new URL(settings.proxyUrl); } catch { throw new Error('请输入完整代理地址，例如 http://127.0.0.1:7897'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('代理仅支持不含账号、密码和路径的 HTTP(S) 地址，例如 http://127.0.0.1:7897');
  return { ...settings, proxyUrl: url.origin };
}
/** Configures this process only; never changes Windows settings or process.env. */
export class NetworkService {
  private restore?: () => void;
  settings = defaultNetwork();
  apply(input: unknown) {
    const settings = validateNetwork(input);
    this.restore?.();
    this.restore = setGlobalProxyFromEnv({ http_proxy: settings.enabled ? settings.proxyUrl : '', https_proxy: settings.enabled ? settings.proxyUrl : '', no_proxy: 'localhost,127.0.0.1,127.*,[::1],::1' });
    this.settings = settings;
    return settings;
  }
  close() { this.restore?.(); this.restore = undefined; }
  explain(message: string) {
    if (!/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connect timeout|Connection error/i.test(message)) return message;
    return this.settings.enabled ? `网络连接失败。当前代理：${this.settings.proxyUrl}。请确认代理软件已启动、端口正确，再点击“测试网络”。（${message}）` : `网络连接失败。当前使用直连，可在模型设置中启用代理。（${message}）`;
  }
  async test(probe?: () => Promise<string>) {
    if (!probe) throw new Error('请先保存并选择要测试的接入配置；网络测试会使用该供应商的实际接口');
    try {
      return await probe();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error(`网络测试超时，请检查${this.settings.enabled ? '代理软件、端口与线路' : '网络，或启用代理'}。`);
      throw new Error(this.explain(message));
    }
  }
}

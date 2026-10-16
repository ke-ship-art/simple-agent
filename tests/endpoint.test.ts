import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { endpointFetch, validateEndpoint, addressKind } from '../src/main/endpoint';
import { classifyConnectionError } from '../src/main/models';
import { defaultNetwork, validateNetwork, NetworkService } from '../src/main/network';

let server: Server | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
it('starts direct without depending on any personal proxy port', async () => {
  expect(defaultNetwork()).toEqual({ enabled: false, proxyUrl: '' });
  expect(validateNetwork(defaultNetwork())).toEqual(defaultNetwork());
  expect(() => validateNetwork({ enabled: true, proxyUrl: '' })).toThrow();
  await expect(new NetworkService().test()).rejects.toThrow('接入配置');
});
it('requires explicit trust for LAN HTTP, pins approved DNS, and blocks special or mixed addresses', async () => {
  const resolver = async () => ['192.168.1.22'];
  await expect(validateEndpoint({ baseUrl: 'http://nas.local:8000/v1' }, resolver)).rejects.toThrow('显式');
  expect(await validateEndpoint({ baseUrl: 'http://nas.local:8000/v1', trustedHttp: true }, resolver)).toEqual({ trustedAddresses: ['192.168.1.22'] });
  for (const address of ['169.254.169.254', '0.0.0.0', '100.64.0.1', 'fe80::1', '224.0.0.1', '::']) {
    expect(addressKind(address)).toBe('blocked');
    await expect(validateEndpoint({ baseUrl: 'http://nas.local/v1', trustedHttp: true }, async () => [address])).rejects.toThrow();
  }
  await expect(validateEndpoint({ baseUrl: 'http://nas.local/v1', trustedHttp: true }, async () => ['192.168.1.22', '8.8.8.8'])).rejects.toThrow('局域网');
  const guarded = endpointFetch({ baseUrl: 'http://nas.local/v1', trustedHttp: true, trustedAddresses: ['192.168.1.22'] }, undefined, async () => ['192.168.1.23']);
  await expect(guarded('http://nas.local/v1/models')).rejects.toThrow('DNS');
});
it('uses real pinned loopback transport, preserves requests, blocks redirects and cancels', async () => {
  const received: string[] = [];
  server = createServer(async (req, res) => {
    if (req.url === '/slow') return;
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    received.push(`${req.method}:${req.url}:${body}`); res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"local"}]}');
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const guarded = endpointFetch({ baseUrl: base });
  expect(await (await guarded(`${base}/v1/models`, { method: 'POST', body: '中文', headers: { Authorization: 'Bearer fake' } })).json()).toEqual({ data: [{ id: 'local' }] });
  expect(received).toEqual(['POST:/v1/models:中文']);
  await expect(guarded(`${base}/redirect`)).rejects.toThrow('重定向');
  await expect(guarded('https://example.com/models')).rejects.toThrow('未配置');
  const controller = new AbortController(), pending = guarded(`${base}/slow`, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it('checks public HTTPS DNS, forbids private rebinding, and disables automatic redirects', async () => {
  const native = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"data":[]}'));
  const guarded = endpointFetch({ baseUrl: 'https://models.example/v1' }, undefined, async () => ['93.184.216.34']);
  await guarded('https://models.example/v1/models');
  expect(native).toHaveBeenCalledWith('https://models.example/v1/models', expect.objectContaining({ redirect: 'error' }));
  const untrusted = endpointFetch({ baseUrl: 'https://models.example/v1' }, undefined, async () => ['192.168.1.4']);
  await expect(untrusted('https://models.example/v1/models')).rejects.toThrow('不可信');
  expect(native).toHaveBeenCalledTimes(1);
});
it('cancels DNS resolution without waiting for the resolver to return', async () => {
  const controller = new AbortController();
  const guarded = endpointFetch({ baseUrl: 'https://models.example/v1' }, undefined, () => new Promise(() => undefined));
  const pending = guarded('https://models.example/v1/models', { signal: controller.signal });
  controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it('classifies authentication, missing model, protocol, network, limits and timeout distinctly', () => {
  expect(classifyConnectionError('401 invalid_api_key')).toContain('认证失败');
  expect(classifyConnectionError('404 model_not_found')).toContain('模型不存在');
  expect(classifyConnectionError('404 Not Found')).toContain('协议不兼容');
  expect(classifyConnectionError('fetch failed ECONNREFUSED')).toContain('网络连接失败');
  expect(classifyConnectionError('429 quota')).toContain('额度不足');
  expect(classifyConnectionError('request timeout')).toContain('超时');
});

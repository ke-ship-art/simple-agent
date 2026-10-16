import { afterEach, expect, it } from 'vitest';
import { createServer, get, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { NetworkService, validateNetwork } from '../src/main/network';

const network = new NetworkService();
let server: Server | undefined, proxy: Server | undefined;
const sockets = new Set<Socket>();
afterEach(async () => {
  network.close();
  for (const socket of sockets) socket.destroy(); sockets.clear();
  await Promise.all([server, proxy].map(value => value && new Promise<void>(resolve => value.close(() => resolve()))));
});
it('routes fetch and HTTP requests through a proxy, while loopback stays direct', async () => {
  const received: string[] = [], tunnels: string[] = [];
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push(`${req.url}:${body}`); res.end(req.url === '/stream' ? 'data: OK\n\n' : 'OK');
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const targetPort = (server.address() as any).port;
  proxy = createServer((req, res) => { tunnels.push(req.url!); res.end('HTTP proxy OK'); });
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url!);
    const upstream = connect(targetPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    sockets.add(upstream); upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
  network.apply({ enabled: true, proxyUrl: `http://127.0.0.1:${(proxy.address() as any).port}` });
  const response = await fetch('http://model.example.invalid/stream', { method: 'POST', body: 'request body', signal: AbortSignal.timeout(3000) });
  expect(await response.text()).toBe('data: OK\n\n'); expect(received).toContain('/stream:request body'); expect(tunnels).toContain('model.example.invalid:80');
  expect(await new Promise<string>((resolve, reject) => { get('http://model.example.invalid/http', res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(body)); }).on('error', reject); })).toBe('HTTP proxy OK');
  const before = tunnels.length;
  expect(await (await fetch(`http://127.0.0.1:${targetPort}/local`)).text()).toBe('OK'); expect(tunnels).toHaveLength(before);
  network.apply({ enabled: false, proxyUrl: network.settings.proxyUrl });
  expect(await (await fetch(`http://127.0.0.1:${targetPort}/direct`)).text()).toBe('OK'); expect(tunnels).toHaveLength(before);
});
it('preserves cancellation and reports a failed proxy without silently using direct access', async () => {
  proxy = createServer(); let attempts = 0;
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (_req, client) => { attempts++; client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); });
  await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as any).port}`; network.apply({ enabled: true, proxyUrl });
  const controller = new AbortController(); const request = fetch('http://slow.example.invalid/response', { signal: controller.signal });
  setTimeout(() => controller.abort(), 50); await expect(request).rejects.toMatchObject({ name: 'AbortError' }); expect(attempts).toBe(1);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => proxy!.close(() => resolve())); proxy = undefined;
  await expect(fetch('http://offline.example.invalid/', { signal: AbortSignal.timeout(1000) })).rejects.toThrow('fetch failed');
  expect(network.explain('fetch failed')).toContain(proxyUrl);
});
it('validates proxy addresses before replacing active configuration', () => {
  network.apply({ enabled: false, proxyUrl: 'http://127.0.0.1:7897' });
  for (const proxyUrl of ['socks5://127.0.0.1:7897', 'http://user:password@localhost:7897', 'http://localhost/path', 'http://localhost/?secret=1', '7897']) expect(() => network.apply({ enabled: true, proxyUrl })).toThrow();
  expect(network.settings.enabled).toBe(false);
  expect(validateNetwork({ enabled: true, proxyUrl: '  http://127.0.0.1:7897/  ' }).proxyUrl).toBe('http://127.0.0.1:7897');
});

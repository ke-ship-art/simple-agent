import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelService } from '../src/main/models';
import { Secrets, Store } from '../src/main/store';
import { NetworkService } from '../src/main/network';

it('uses the configured proxy for native ChatGPT code exchange and refresh, and persists credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simple-agent-proxy-oauth-'));
  const network = new NetworkService(), nativeFetch = globalThis.fetch;
  const grants: string[] = [], tunnels: string[] = [], sockets = new Set<Socket>();
  const tokens = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body), grant = form.get('grant_type')!; grants.push(grant);
    expect(form.get('client_id')).toBe('mock-issued-client');
    if (grant === 'authorization_code') { expect(form.get('code')).toBe('mock-code'); expect(form.get('code_verifier')).toBeTruthy(); }
    else expect(form.get('refresh_token')).toBe('mock-refresh');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ access_token: grant === 'authorization_code' ? 'mock-access' : 'mock-refreshed-access', refresh_token: 'mock-refresh', id_token: 'mock-id', scope: 'openid profile offline_access resource.invoke chatgpt.tokens.use.direct', expires_in: grant === 'authorization_code' ? 1 : 3600 }));
  });
  const proxy = createServer();
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url!); const upstream = connect((tokens.address() as any).port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
    }); sockets.add(upstream); upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  try {
    await new Promise<void>(resolve => tokens.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    network.apply({ enabled: true, proxyUrl: `http://127.0.0.1:${(proxy.address() as any).port}` });
    // Only redirect the token endpoint in this isolated test; native SDK keeps PKCE/state validation.
    globalThis.fetch = (input, init) => nativeFetch(String(input) === 'https://auth.openai.com/api/accounts/oauth/token' ? 'http://oauth.example.invalid/token' : input, init);
    const store = new Store(root); await store.init();
    const secrets = new Secrets(root, { encrypt: async text => Buffer.from(text), decrypt: async bytes => Buffer.from(bytes).toString() });
    let authorizationUrl: URL, completed = false, failure = '';
    const service = new ModelService(store, secrets, event => {
      if (event.type === 'auth_prompt') queueMicrotask(() => service.answer(event.promptId, `http://127.0.0.1:1455/auth/callback?code=mock-code&state=${authorizationUrl.searchParams.get('state')}&client_id=mock-issued-client`));
      if (event.type === 'auth') { const value = event.event as any; if (value.type === 'success') completed = true; if (value.type === 'error') failure = value.message; }
    }, async url => { authorizationUrl = new URL(url); });
    const profile = await service.saveProfile({ name: 'test ChatGPT', provider: 'openai', protocol: 'openai-responses', baseUrl: '', authMode: 'oauth' });
    await service.login(profile.id);
    await expect.poll(() => completed || failure).toBe(true);
    expect(profile.hasCredential).toBe(true);
    const { models } = await service.runtime(profile);
    expect((await models.getAuth('openai'))?.auth.apiKey).toBe('mock-refreshed-access');
    expect(grants).toEqual(['authorization_code', 'refresh_token']); expect(tunnels).toContain('oauth.example.invalid:80');
    const restarted = new Store(root); await restarted.init(); expect(restarted.state.profiles[0].hasCredential).toBe(true);
    expect((await secrets.read(`${profile.id}:openai`)).access).toBe('mock-refreshed-access');
    await service.logout(profile.id); expect(await secrets.read(`${profile.id}:openai`)).toBeUndefined();
  } finally {
    globalThis.fetch = nativeFetch; network.close(); for (const socket of sockets) socket.destroy();
    await Promise.all([tokens, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
});

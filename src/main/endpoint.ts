import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { ConnectionProfile } from '../shared/types';

type EndpointProfile = Pick<ConnectionProfile, 'baseUrl'> & { trustedHttp?: boolean; trustedAddresses?: string[] };
type Resolver = (hostname: string) => Promise<string[]>;
const resolveAddresses: Resolver = async hostname => isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true, verbatim: true })).map(item => item.address);
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
const normalized = (address: string) => address.toLowerCase().replace(/^::ffff:/, '');
async function resolved(hostname: string, resolver: Resolver, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<string[]>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { finish(); reject(signal?.reason ?? new Error('地址解析已取消')); };
    const timer = setTimeout(() => { finish(); reject(new Error('模型服务 DNS 解析超时')); }, 10000);
    signal?.addEventListener('abort', cancel, { once: true });
    void resolver(hostname).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
  });
}
export function addressKind(value: string): 'loopback' | 'lan' | 'public' | 'blocked' {
  const address = normalized(value), version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return 'lan';
    if (a === 0 || a === 169 && b === 254 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 192 && b === 0 || a === 198 && (b === 18 || b === 19)) return 'blocked';
    return 'public';
  }
  if (version === 6) {
    if (address === '::1') return 'loopback';
    if (/^f[cd]/.test(address)) return 'lan';
    if (/^[23]/.test(address)) return 'public';
  }
  return 'blocked';
}
export function parseEndpoint(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error('请输入完整的模型服务 HTTP(S) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址需为不含凭据或查询参数的 HTTP(S) URL');
  if (url.hostname.includes('%') || !url.hostname) throw new Error('服务地址无效');
  return url;
}
/** Resolve once on save. Only RFC1918/ULA addresses are eligible for explicit HTTP trust. */
export async function validateEndpoint(profile: EndpointProfile, resolver: Resolver = resolveAddresses): Promise<{ trustedAddresses?: string[] }> {
  const url = parseEndpoint(profile.baseUrl), host = hostOf(url);
  // Public HTTPS is checked when used, avoiding a network dependency when saving credentials.
  if (url.protocol === 'https:' && !isIP(host) && host !== 'localhost') return {};
  const addresses = await resolved(host, resolver);
  if (!addresses.length || addresses.some(address => addressKind(address) === 'blocked')) throw new Error('模型地址指向不允许的特殊网络地址');
  if (url.protocol === 'http:') {
    if (addresses.every(address => addressKind(address) === 'loopback')) return {};
    if (!profile.trustedHttp) throw new Error('HTTP 局域网模型服务需要显式勾选“信任此 HTTP 局域网服务”；公网服务请使用 HTTPS');
    if (!addresses.every(address => addressKind(address) === 'lan')) throw new Error('可信 HTTP 服务必须只解析到局域网私有地址，不能是公网、回环或混合地址');
    return { trustedAddresses: [...new Set(addresses)].sort() };
  }
  if (addresses.some(address => addressKind(address) !== 'public' && addressKind(address) !== 'loopback')) throw new Error('HTTPS 模型服务不能指向特殊或未授权的局域网地址');
  return {};
}

/** HTTP LAN requests bypass proxies and connect to the approved IP, preventing DNS rebinding. */
function pinnedHttpFetch(url: URL, approved: string[], init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers), rawHeaders: Record<string, string> = {};
    headers.forEach((value, key) => { if (!['host', 'connection', 'content-length', 'proxy-authorization'].includes(key.toLowerCase())) rawHeaders[key] = value; });
    rawHeaders['accept-encoding'] = 'identity';
    const outgoing = request(url, { method: init.method ?? 'GET', headers: rawHeaders, signal: init.signal ?? undefined, agent: false,
      lookup: (_hostname, options, callback) => {
        const address = approved.find(value => !(options as { family?: number }).family || isIP(value) === (options as { family?: number }).family);
        if (!address) { callback(new Error('可信局域网地址没有可用的 IP'), '', 4); return; }
        // http.request may request all addresses for auto-family selection.
        if ((options as { all?: boolean }).all) (callback as any)(null, [{ address, family: isIP(address) }]);
        else callback(null, address, isIP(address));
      }
    }, incoming => {
      if (!approved.some(address => normalized(address) === normalized(incoming.socket.remoteAddress ?? ''))) { incoming.destroy(); reject(new Error('实际连接地址与可信局域网地址不一致')); return; }
      if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400) { incoming.destroy(); reject(new Error('模型服务重定向已阻止，请直接配置最终服务地址')); return; }
      const responseHeaders = new Headers();
      for (const [key, values] of Object.entries(incoming.headers)) if (values !== undefined) for (const value of Array.isArray(values) ? values : [values]) responseHeaders.append(key, value);
      const status = incoming.statusCode ?? 502;
      const encoding = incoming.headers['content-encoding'];
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
      if (decoder) { responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length'); pipeline(incoming, decoder, () => undefined); }
      const body = [204, 205, 304].includes(status) || init.method === 'HEAD' ? null : Readable.toWeb(decoder ?? incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(180000, () => outgoing.destroy(new Error('模型连接超时')));
    if (init.body === undefined || init.body === null) outgoing.end();
    else if (typeof init.body === 'string' || init.body instanceof Uint8Array) outgoing.end(init.body);
    else { outgoing.destroy(); reject(new Error('此局域网模型请求正文格式暂不支持')); }
  });
}
export function endpointFetch(profile: EndpointProfile, baseUrl = profile.baseUrl, resolver: Resolver = resolveAddresses, upstream?: typeof fetch): typeof fetch {
  const base = parseEndpoint(baseUrl);
  return async (input, init) => {
    const isRequest = input instanceof Request;
    const url = new URL(isRequest ? input.url : String(input));
    if (url.origin !== base.origin || url.username || url.password) throw new Error('模型请求试图访问未配置的服务地址，已阻止');
    const requestInit: RequestInit = isRequest ? { method: input.method, headers: input.headers, signal: input.signal, body: ['GET', 'HEAD'].includes(input.method) ? undefined : await input.text(), ...init } : { ...init };
    requestInit.signal?.throwIfAborted();
    const addresses = await resolved(hostOf(url), resolver, requestInit.signal ?? undefined);
    requestInit.signal?.throwIfAborted();
    if (!addresses.length || addresses.some(address => addressKind(address) === 'blocked')) throw new Error('模型地址解析到不允许的特殊网络地址');
    const kinds = addresses.map(addressKind);
    if (url.protocol === 'http:') {
      const loopback = kinds.every(kind => kind === 'loopback');
      if (!loopback && (!profile.trustedHttp || !profile.trustedAddresses?.length || !kinds.every(kind => kind === 'lan') || addresses.some(address => !profile.trustedAddresses!.includes(address)))) throw new Error('HTTP 局域网地址尚未信任或 DNS 地址已变化；请检查服务后重新保存接入配置');
      return pinnedHttpFetch(url, loopback ? addresses : profile.trustedAddresses!, requestInit);
    }
    if (!kinds.every(kind => kind === 'public') && !kinds.every(kind => kind === 'loopback')) throw new Error('HTTPS 请求指向不可信的局域网或混合地址，已阻止');
    return (upstream ?? globalThis.fetch)(input, { ...requestInit, redirect: 'error' });
  };
}

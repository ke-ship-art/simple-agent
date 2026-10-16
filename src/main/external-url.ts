/** Only explicit user clicks reach this function; never allow OS command/file schemes. */
export function externalUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('链接不是完整的网址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\x00-\x20]/.test(value)) throw new Error('只允许打开不含凭据的 HTTP(S) 网页链接');
  return url.href;
}

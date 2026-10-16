import { AsyncLocalStorage } from 'node:async_hooks';
import { endpointFetch } from './endpoint';
import type { ConnectionProfile } from '../shared/types';
const scope = new AsyncLocalStorage<typeof fetch>();
let upstream: typeof fetch | undefined;
/** pi-ai's Gemini adapter does not accept custom fetch. Scope its SDK's global
 * fetch asynchronously so concurrent OAuth requests retain their own routing. */
export function requestScope(profile: ConnectionProfile, baseUrl: string) {
  if (!upstream) {
    upstream = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => (scope.getStore() ?? upstream!)(input, init);
  }
  const guarded = endpointFetch(profile, baseUrl, undefined, upstream);
  return <T>(work: () => T): T => scope.run(guarded, work);
}

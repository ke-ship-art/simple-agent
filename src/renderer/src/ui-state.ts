import type { AppState } from '../../shared/types';
export interface ChatDraft {input:string;references:string[]}
export function readDrafts(serialized:string|null):Record<string,ChatDraft> {
  try {
    const value=JSON.parse(serialized??'{}');
    if(!value||typeof value!=='object'||Array.isArray(value))return {};
    return Object.fromEntries(Object.entries(value).filter((entry):entry is [string,ChatDraft]=>{
      const draft=entry[1] as ChatDraft;
      return !!draft&&typeof draft.input==='string'&&draft.input.length<=50000&&Array.isArray(draft.references)&&draft.references.length<=20&&draft.references.every(p=>typeof p==='string'&&p.length<=4096);
    }));
  }catch{return {};}
}

/** A state reply may have been captured before newer stream deltas arrived. */
export function reconcileState(incoming: AppState, streamed: Map<string, string>): AppState {
  if (!incoming.activeRun) { streamed.clear(); return incoming; }
  return { ...incoming, sessions: incoming.sessions.map(session => ({ ...session, messages: session.messages.map(message => {
    const live = streamed.get(message.id);
    if (live === undefined) return message;
    if (message.text.startsWith(live)) { streamed.set(message.id, message.text); return message; }
    return live.startsWith(message.text) ? { ...message, text: live } : message;
  }) })) };
}

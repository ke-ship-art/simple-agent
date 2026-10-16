import { createModels, createProvider, getSupportedThinkingLevels, clampThinkingLevel, type Model, type Models, type CredentialStore, type Provider as PiProvider, type AuthPrompt } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Store, Secrets, atomicWrite } from './store';
import type { AppEvent, ConnectionProfile, ModelEntry } from '../shared/types';
import { reasoningLevels } from '../shared/reasoning';
import { reasoningOptions, checkResponse } from './reasoning';
import { endpointFetch, validateEndpoint } from './endpoint';
import { requestScope } from './request-scope';

const profileSchema = z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(100), provider: z.enum(['custom', 'openai', 'anthropic', 'google', 'github-copilot', 'openrouter']), protocol: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']), baseUrl: z.string().trim().max(2048), authMode: z.enum(['api_key', 'oauth', 'none']), apiKey: z.string().optional(), trustedHttp: z.boolean().optional() });
const modelSchema = z.object({ id: z.string().optional(), profileId: z.string(), name: z.string().trim().min(1).max(100), modelId: z.string().trim().min(1).max(300), enabled: z.boolean(), vision: z.boolean(), reasoning: z.boolean(), contextWindow: z.number().int().min(1024).max(2000000), maxTokens: z.number().int().min(128).max(1000000), builtin: z.boolean().optional() });
const factories: Record<string, () => PiProvider> = { openai: openaiProvider, anthropic: anthropicProvider, google: googleProvider, 'github-copilot': githubCopilotProvider, openrouter: openrouterProvider };
const implementations = { 'openai-completions': openAICompletionsApi, 'openai-responses': openAIResponsesApi, 'anthropic-messages': anthropicMessagesApi, 'google-generative-ai': googleGenerativeAIApi };
const reasoningSchema = z.enum(reasoningLevels);
const configuredModelSchema = modelSchema.extend({ reasoningLevel: reasoningSchema.optional(), supportedReasoningLevels: z.array(reasoningSchema).max(7).optional() });
async function limitedJson(response: Response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('接口返回空响应');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 2 * 1024 * 1024) throw new Error('模型目录超过 2 MB 限制'); chunks.push(item.value); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new Error('接口协议不兼容：服务返回了无效 JSON'); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function classifyConnectionError(message: string): string {
  if (/\b(401|403)\b|unauthorized|invalid.?api.?key|authentication|not configured/i.test(message)) return `认证失败：服务可达，但凭据无效、未登录或没有访问权限。（${message}）`;
  if (/model.{0,30}(?:not found|does not exist|not exist|unknown)|model_not_found|unknown model/i.test(message)) return `模型不存在或无访问权限：请核对模型 ID 与账号权限。（${message}）`;
  if (/\b(404|405|415|422)\b|unexpected token|invalid json|unsupported.{0,20}(?:protocol|parameter)|unknown.{0,20}(?:endpoint|parameter)/i.test(message)) return `接口协议不兼容：请核对协议、Base URL（兼容服务通常包含 /v1）与参数。（${message}）`;
  if (/\b429\b|rate.?limit|quota/i.test(message)) return `服务限流或额度不足。（${message}）`;
  if (/timeout|timed out|超时|aborted/i.test(message)) return `连接超时或请求已取消。（${message}）`;
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|Connection error|socket|certificate|TLS/i.test(message)) return `网络连接失败：请检查地址、服务是否启动、证书和代理设置。（${message}）`;
  return message;
}
export class ModelService {
  private runtimes = new Map<string, { models: Models; provider: PiProvider }>();
  private authentications = new Map<string, { controller: AbortController; profileId: string }>();
  private prompts = new Map<string, { resolve(value: string): void; reject(error: Error): void; authId: string }>();
  constructor(readonly store: Store, readonly secrets: Secrets, readonly emit: (event: AppEvent) => void, readonly openUrl: (url: string) => Promise<void>, readonly explainNetwork: (message: string) => string = message => message) {}
  assertIdle() { this.notRunning(); if (this.authentications.size) throw new Error('请先完成或取消登录，再修改或测试网络设置'); }
  profile(id: string) { const profile = this.store.state.profiles.find(p => p.id === id); if (!profile) throw new Error('接入配置不存在'); return profile; }
  private notRunning() { if (this.store.state.activeRun) throw new Error('请先停止当前任务再修改模型配置'); }
  private normalizeReasoning(profile: ConnectionProfile, entry: ModelEntry): ModelEntry {
    const native = factories[profile.provider]?.(), builtin = native?.getModels().find(m => m.id === entry.modelId);
    const reasoning = builtin?.reasoning ?? entry.reasoning;
    const supportedReasoningLevels = !reasoning ? [] : builtin ? getSupportedThinkingLevels(builtin) : reasoningLevels.filter(level => entry.supportedReasoningLevels?.includes(level));
    const current = entry.reasoningLevel ?? 'medium';
    const reasoningLevel = !supportedReasoningLevels.length ? undefined : supportedReasoningLevels.includes(current) ? current : clampThinkingLevel({ ...this.toModel(profile, { ...entry, reasoning }, native), thinkingLevelMap: Object.fromEntries(reasoningLevels.map(level => [level, supportedReasoningLevels.includes(level) ? level : null])) }, current);
    return { ...entry, builtin: !!builtin, reasoning, supportedReasoningLevels, reasoningLevel };
  }
  async init() {
    const before = JSON.stringify(this.store.state.models);
    this.store.state.models = this.store.state.models.filter(entry=>{if(this.store.state.profiles.some(p=>p.id===entry.profileId))return true;this.store.state.recoveryWarnings=[...(this.store.state.recoveryWarnings??[]),'已忽略没有所属接入的模型：'+entry.name+'，请重新配置。'];return false;}).map(entry => this.normalizeReasoning(this.profile(entry.profileId), entry));
    if (before !== JSON.stringify(this.store.state.models)) await this.store.save();
  }
  async setReasoningLevel(input: unknown) {
    this.notRunning(); const { modelId, level } = z.object({ modelId: z.string(), level: reasoningSchema }).parse(input);
    const entry = this.store.state.models.find(model => model.id === modelId);
    if (!entry) throw new Error('模型不存在');
    if (!entry.supportedReasoningLevels?.includes(level)) throw new Error('当前模型不支持此推理强度');
    const old = entry.reasoningLevel; entry.reasoningLevel = level;
    try { await this.store.save(); } catch (error) { entry.reasoningLevel = old; throw error; }
    this.emit({ type: 'state' }); return entry;
  }
  async saveProfile(input: unknown) {
    this.notRunning(); const parsed = profileSchema.parse(input), id = parsed.id || randomUUID();
    if (parsed.id && !this.store.state.profiles.some(p => p.id === id)) throw new Error('接入配置不存在');
    const endpoint = parsed.baseUrl ? await validateEndpoint(parsed) : {};
    if (parsed.provider === 'custom' && !parsed.baseUrl) throw new Error('自定义接入必须填写服务地址');
    if (parsed.authMode === 'oauth' && !['openai', 'anthropic', 'github-copilot', 'openrouter'].includes(parsed.provider)) throw new Error('此供应商不支持内置 OAuth 登录');
    if (parsed.authMode === 'none' && parsed.provider !== 'custom') throw new Error('无密钥模式仅用于自定义本地服务');
    const old = this.store.state.profiles.find(p => p.id === id);
    if (this.authentications.size) throw new Error('请先完成或取消登录');
    const { apiKey, ...data } = parsed;
    const profile: ConnectionProfile = { ...data, ...endpoint, id, hasCredential: false, ...(old?{credentialNamespace:`${id}:revision-${randomUUID()}`}:{}) };
    const key = `${profile.credentialNamespace??id}:${profile.provider === 'custom' ? 'custom' : profile.provider}`;
    const previousCredential=old&&old.provider===profile.provider&&old.authMode===profile.authMode?await this.secrets.read(`${old.credentialNamespace??old.id}:${old.provider}`):undefined;
    const nextCredential=apiKey&&profile.authMode==='api_key'?{type:'api_key',key:apiKey}:previousCredential;
    if(nextCredential)await this.secrets.modify(key,()=>nextCredential);
    profile.hasCredential = !!(await this.secrets.read(key));
    const previousProfiles=this.store.state.profiles;
    this.store.state.profiles = [...this.store.state.profiles.filter(p => p.id !== id), profile];
    try{await this.store.save();}catch(error){this.store.state.profiles=previousProfiles;await this.secrets.delete(key).catch(()=>undefined);throw error;}
    this.runtimes.delete(id); this.emit({ type: 'state' }); return profile;
  }
  async deleteProfile(id: string) {
    this.notRunning(); const profile = this.profile(id);
    if (this.authentications.size) throw new Error('请先完成或取消登录');
    const previousProfiles=this.store.state.profiles,previousModels=this.store.state.models;
    this.store.state.profiles = this.store.state.profiles.filter(p => p.id !== id);
    this.store.state.models = this.store.state.models.filter(m => m.profileId !== id);
    try{await this.store.save();}catch(error){this.store.state.profiles=previousProfiles;this.store.state.models=previousModels;throw error;}
    this.runtimes.delete(id);for(const credential of await this.secrets.list(`${id}:`))await this.secrets.delete(`${id}:${credential.providerId}`);this.emit({type:'state'});
  }
  async saveModel(input: unknown) {
    this.notRunning(); const parsed = configuredModelSchema.parse(input); const profile = this.profile(parsed.profileId);
    if (parsed.maxTokens >= parsed.contextWindow) throw new Error('输出上限必须小于上下文长度');
    const old = this.store.state.models.find(entry => entry.id === parsed.id);
    if(parsed.id&&(!old||old.profileId!==parsed.profileId))throw new Error('模型不存在或不能移动到其他接入，请重新添加');
    const previousModels=this.store.state.models;
    const model: ModelEntry = this.normalizeReasoning(profile, { ...parsed, reasoningLevel: parsed.reasoningLevel ?? old?.reasoningLevel, id: parsed.id || randomUUID() });
    this.store.state.models = [...this.store.state.models.filter(m => m.id !== model.id), model];
    try{await this.store.save();}catch(error){this.store.state.models=previousModels;throw error;}this.runtimes.delete(model.profileId);this.emit({type:'state'});return model;
  }
  async deleteModel(id: string) { this.notRunning(); const model = this.store.state.models.find(m => m.id === id); const previous=this.store.state.models;this.store.state.models=this.store.state.models.filter(m=>m.id!==id);try{await this.store.save();}catch(error){this.store.state.models=previous;throw error;}if(model)this.runtimes.delete(model.profileId); this.emit({ type: 'state' }); }
  async runtime(profile: ConnectionProfile) {
    const existing = this.runtimes.get(profile.id); if (existing) return existing;
    const prefix = `${profile.credentialNamespace??profile.id}:`;
    const credentials: CredentialStore = {
      read: async (id, options) => { options?.signal?.throwIfAborted(); return this.secrets.read(prefix + id); },
      list: async options => { options?.signal?.throwIfAborted(); return this.secrets.list(prefix); },
      modify: async (id, fn, options) => this.secrets.modify(prefix + id, async current => { options?.signal?.throwIfAborted(); const result = await fn(current); options?.signal?.throwIfAborted(); return result ?? current; }),
      delete: async (id, options) => { options?.signal?.throwIfAborted(); await this.secrets.delete(prefix + id); }
    };
    const models = createModels({ credentials, authContext: { env: async name => ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].includes(name) ? process.env[name] : undefined, fileExists: async () => false } });
    const native = factories[profile.provider]?.();
    const configured = this.store.state.models.filter(m => m.profileId === profile.id).map(entry => this.toModel(profile, entry, native));
    let provider: PiProvider;
    if (native) provider = { ...native, ...createProvider({ id: native.id, name: native.name, baseUrl: native.baseUrl, auth: native.auth, models: configured, api: { 'openai-completions': openAICompletionsApi(), 'openai-responses': openAIResponsesApi(), 'anthropic-messages': anthropicMessagesApi(), 'google-generative-ai': googleGenerativeAIApi() } }) };
    else provider = createProvider({ id: 'custom', name: profile.name, baseUrl: profile.baseUrl, auth: { apiKey: { name: profile.name, resolve: async ({ credential }) => profile.authMode === 'none' ? { auth: { apiKey: 'local-no-key', headers: { Authorization: null, 'x-api-key': null } } } : credential?.key ? { auth: { apiKey: credential.key } } : undefined } }, models: configured, api: implementations[profile.protocol]() });
    models.setProvider(provider); const runtime = { models, provider }; this.runtimes.set(profile.id, runtime); return runtime;
  }
  private toModel(profile: ConnectionProfile, entry: ModelEntry, native?: PiProvider): Model<any> {
    const builtin = native?.getModels().find(m => m.id === entry.modelId);
    const api = profile.provider === 'github-copilot' ? builtin?.api ?? profile.protocol : profile.protocol;
    const adjustable = !!entry.supportedReasoningLevels?.length;
    const customThinking = !builtin ? { thinkingLevelMap: Object.fromEntries(reasoningLevels.map(level => [level, entry.supportedReasoningLevels?.includes(level) ? level === 'off' ? 'none' : level : null])) } : {};
    return { ...builtin, ...customThinking, id: entry.modelId, name: entry.name, provider: native?.id ?? 'custom', api, baseUrl: profile.baseUrl || builtin?.baseUrl || native?.baseUrl || '', reasoning: entry.reasoning, input: entry.vision ? ['text', 'image'] : ['text'], cost: builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, ...(profile.provider === 'custom' && api === 'openai-completions' ? { compat: { supportsDeveloperRole: false, supportsReasoningEffort: adjustable, supportsStore: false, maxTokensField: 'max_tokens' } } : {}) };
  }
  async selected(id: string, includeDisabled = false, signal?: AbortSignal) {
    const entry = this.store.state.models.find(m => m.id === id && (m.enabled || includeDisabled));
    if (!entry) throw new Error('请选择已启用的模型');
    const profile = this.profile(entry.profileId), runtime = await this.runtime(profile);
    const model=this.toModel(profile,entry,factories[profile.provider]?.());
    if (!model) throw new Error('模型未找到');
    const auth = await runtime.models.getAuth(model, { signal: signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000) });
    if(!auth)throw new Error('此接入尚未配置凭据，请填写 API Key 或完成登录');
    const baseUrl = auth.auth.baseUrl || model.baseUrl;
    return { ...runtime, entry, model, withRequest: model.api === 'google-generative-ai' ? requestScope(profile, baseUrl) : <T>(work:()=>T)=>work(), requestOptions: { ...(model.api === 'google-generative-ai' ? {} : { fetch: endpointFetch(profile, baseUrl) }), transport: 'sse' as const, maxRetries: 0 } };
  }
  async catalog(profileId: string, signal?: AbortSignal) {
    const profile = this.profile(profileId), native = factories[profile.provider]?.();
    if (native) return native.getModels().map(m => ({ modelId: m.id, name: m.name, vision: m.input.includes('image'), reasoning: m.reasoning, supportedReasoningLevels: m.reasoning ? getSupportedThinkingLevels(m) : [], contextWindow: m.contextWindow, maxTokens: m.maxTokens, builtin: true }));
    if (!['openai-completions', 'openai-responses'].includes(profile.protocol)) throw new Error('此自定义协议请手动填写模型 ID');
    const { models, provider } = await this.runtime(profile); const auth=await models.getAuth(provider.id,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
    if (!auth) throw new Error('请先配置 API Key');
    const response = await endpointFetch(profile)(`${profile.baseUrl.replace(/\/$/, '')}/models`, { headers: profile.authMode !== 'none' && auth.auth.apiKey ? { Authorization: `Bearer ${auth.auth.apiKey}` } : {}, signal: signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(classifyConnectionError(`获取模型列表返回 HTTP ${response.status}`)); }
    const body = await limitedJson(response) as { data?: { id: string }[] };
    if (!Array.isArray(body.data) || body.data.some(item => !item || typeof item.id !== 'string')) throw new Error('接口协议不兼容：/models 没有返回预期的模型列表，可手动填写模型 ID');
    return body.data.slice(0, 1000).map(m => ({ modelId: m.id, name: m.id, vision: false, reasoning: false, contextWindow: 32768, maxTokens: 4096, builtin: false }));
  }
  async probe(profileId: string, modelId?: string, signal?: AbortSignal) {
    const profile = this.profile(profileId);
    if (modelId) {
      const entry = this.store.state.models.find(model => model.id === modelId && model.profileId === profileId);
      if (!entry) throw new Error('测试模型不属于当前接入配置');
      return `${profile.name}：模型调用成功，${await this.test(modelId,signal)}`;
    }
    const native = factories[profile.provider]?.(), { models, provider } = await this.runtime(profile);
    const auth = await models.getAuth(provider.id, { signal: signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000) });
    if (!auth) throw new Error('认证失败：请先配置 API Key 或完成登录');
    if(profile.authMode==='oauth')return `${profile.name} 已读取登录凭据；尚未测试模型服务，请先添加模型并测试实际调用。`;
    const baseUrl = auth.auth.baseUrl || profile.baseUrl || native?.baseUrl || '';
    const headers = new Headers();
    for (const [name, value] of Object.entries(auth.auth.headers ?? {})) if (value !== null) headers.set(name, value);
    if (profile.authMode !== 'none' && auth.auth.apiKey) {
      if (profile.protocol === 'anthropic-messages') { headers.set('x-api-key', auth.auth.apiKey); headers.set('anthropic-version', '2023-06-01'); }
      else if (profile.protocol === 'google-generative-ai') headers.set('x-goog-api-key', auth.auth.apiKey);
      else if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${auth.auth.apiKey}`);
    }
    try {
      const prefix=baseUrl.replace(/\/$/,'');
      const catalogUrl=profile.protocol==='anthropic-messages'&&!/\/v\d+(?:beta)?$/.test(new URL(prefix).pathname)?`${prefix}/v1/models`:`${prefix}/models`;
      const response = await endpointFetch(profile, baseUrl)(catalogUrl, { headers, signal: signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(classifyConnectionError(`服务 ${profile.name} 返回 HTTP ${response.status}`)); }
      const body = await limitedJson(response) as { data?: unknown[]; models?: unknown[] };
      if (!Array.isArray(body.data) && !Array.isArray(body.models)) throw new Error('接口协议不兼容：服务可达，但模型目录响应格式不符；请添加模型后使用“测试连接”验证推理接口');
      return `${profile.name} 目录接口连接成功（HTTP ${response.status}）。请添加模型后测试实际调用。`;
    } catch (error) { throw new Error(await this.safeError(classifyConnectionError(error instanceof Error ? error.message : String(error)))); }
  }
  async test(id: string, signal?: AbortSignal) {
    const { models, model, entry, requestOptions, withRequest } = await this.selected(id,true,signal);
    const response = await withRequest(() => models.completeSimple(model, { messages: [{ role: 'user', content: '只回复 OK。', timestamp: Date.now() }] }, { ...requestOptions, ...reasoningOptions(entry, model), ...(!entry.reasoningLevel || entry.reasoningLevel === 'off' ? { maxTokens: 32 } : {}), signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000) }));
    if (['error', 'aborted'].includes(response.stopReason)) throw new Error(await this.safeError(classifyConnectionError(response.errorMessage ?? response.stopReason)));
    checkResponse(response);
    return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  async login(profileId: string) {
    this.notRunning(); const profile = this.profile(profileId);
    if (profile.authMode !== 'oauth') throw new Error('请先将认证方式设为 OAuth');
    if (this.authentications.size) throw new Error('已有登录流程正在进行');
    const authId = randomUUID(), controller = new AbortController(); this.authentications.set(authId, { controller, profileId });
    const timeout = setTimeout(() => controller.abort(new Error('登录已超时，请重新开始')), 5 * 60 * 1000);
    const work = async () => {
      let rollback:undefined|(()=>Promise<void>);
      try {
        const {models,provider}=await this.runtime(profile);const key=`${profile.credentialNamespace??profile.id}:${provider.id}`,before=await this.secrets.read(key);rollback=async()=>{await this.secrets.modify(key,()=>before);profile.hasCredential=!!before;await this.store.save();};
        let deviceId: string;
        try { deviceId = await readFile(join(this.store.directory, 'device-id'), 'utf8'); } catch { deviceId = randomUUID(); await atomicWrite(join(this.store.directory, 'device-id'), deviceId); }
        await models.login(provider.id, 'oauth', {
          signal: controller.signal,
          prompt: (prompt: AuthPrompt) => new Promise((resolve, reject) => {
            const promptId = randomUUID();
            const cancel = () => { this.prompts.delete(promptId); reject(new Error('登录输入已取消')); };
            this.prompts.set(promptId, { resolve: value => { prompt.signal?.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', cancel); resolve(value); }, reject, authId });
            prompt.signal?.addEventListener('abort', cancel, { once: true }); controller.signal.addEventListener('abort', cancel, { once: true });
            if (prompt.signal?.aborted || controller.signal.aborted) { cancel(); return; }
            const { signal: _signal, ...publicPrompt } = prompt;
            this.emit({ type: 'auth_prompt', profileId, authId, promptId, prompt: publicPrompt });
          }),
          notify: event => {
            this.emit({ type: 'auth', profileId, authId, event });
            const url = event.type === 'auth_url' ? event.url : event.type === 'device_code' ? event.verificationUri : undefined;
            if (url) void this.openUrl(url).catch(() => this.emit({ type: 'auth', profileId, authId, event: { type: 'info', message: '请复制上方链接到浏览器完成授权' } }));
          }
        }, { getDeviceId: () => deviceId });
        controller.signal.throwIfAborted();profile.hasCredential = true; await this.store.save(); this.emit({ type: 'auth', profileId, authId, event: { type: 'success', message: '登录成功' } });
      } catch (error) {if(controller.signal.aborted&&rollback)try{await rollback();}catch(restoreError){error=new Error('登录已取消，但原凭据恢复失败：'+String(restoreError));}this.emit({type:'auth',profileId,authId,event:{type:'error',message:await this.safeError(error)}});}
      finally { clearTimeout(timeout); this.authentications.delete(authId); for (const [id, prompt] of this.prompts) if (prompt.authId === authId) { prompt.reject(new Error('登录结束')); this.prompts.delete(id); } this.emit({ type: 'state' }); }
    };
    void work(); return authId;
  }
  answer(promptId: string, value: string) { const prompt = this.prompts.get(promptId); if (!prompt) throw new Error('此登录步骤已结束'); this.prompts.delete(promptId); prompt.resolve(value); }
  cancelLogin(authId: string) { this.authentications.get(authId)?.controller.abort(); }
  async logout(profileId: string) { this.assertIdle(); const profile = this.profile(profileId), { models, provider } = await this.runtime(profile); await models.logout(provider.id);for(const credential of await this.secrets.list(`${profileId}:`))await this.secrets.delete(`${profileId}:${credential.providerId}`); profile.hasCredential = false; await this.store.save(); this.emit({ type: 'state' }); }
  async safeError(error: unknown) {
    let text = error instanceof Error ? error.message : String(error);
    for (const profile of this.store.state.profiles) {
      for(const credential of await this.secrets.list(`${profile.id}:`).catch(()=>[])){
        const value=await this.secrets.read(`${profile.id}:${credential.providerId}`).catch(()=>undefined);
        for (const key of ['key', 'access', 'refresh']) if (typeof value?.[key] === 'string' && value[key].length > 5) text = text.replaceAll(value[key], '[已隐藏凭据]');
      }
    }
    return this.explainNetwork(text.replace(/(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{10,}/g, '[已隐藏凭据]').slice(0, 2000));
  }
}

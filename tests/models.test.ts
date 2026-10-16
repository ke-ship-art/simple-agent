import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, Secrets } from '../src/main/store';
import { ModelService } from '../src/main/models';
import type { AppEvent } from '../src/shared/types';

const oauth = vi.hoisted(() => ({ refresh: vi.fn(async (credential: any) => ({ ...credential, access: 'new-access', expires: Date.now() + 3600000 })) }));
vi.mock('@earendil-works/pi-ai/providers/openai', async importOriginal => {
  const original = await importOriginal<typeof import('@earendil-works/pi-ai/providers/openai')>();
  return { ...original, openaiProvider: () => {
    const native = original.openaiProvider();
    return { ...native, auth: { ...native.auth, oauth: {
      name: 'Mock OAuth', login: async (interaction: any) => {
        interaction.notify({ type: 'auth_url', url: 'https://example.com/oauth' });
        interaction.notify({ type: 'device_code', userCode: 'CODE-123', verificationUri: 'https://example.com/device' });
        await interaction.prompt({ type: 'select', message: '选择账号', options: [{ id: 'personal', label: '个人账号' }], signal: interaction.signal });
        await interaction.prompt({ type: 'manual_code', message: '回填授权', signal: interaction.signal });
        interaction.signal.throwIfAborted();
        return { type: 'oauth', access: 'mock-access', refresh: 'mock-refresh', expires: Date.now() - 1000 };
      }, refresh: oauth.refresh, toAuth: async (credential: any) => ({ apiKey: credential.access })
    } } };
  } };
});
let root: string, store: Store, secrets: Secrets, service: ModelService, events: AppEvent[], autoAnswer: boolean;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'simple-agent-models-')); store = new Store(root); await store.init();
  secrets = new Secrets(root, { encrypt: async s => Buffer.from(Buffer.from(s).toString('base64')), decrypt: async bytes => Buffer.from(Buffer.from(bytes).toString(), 'base64').toString() }); events = []; autoAnswer = true;
  service = new ModelService(store, secrets, event => { events.push(event); if (event.type === 'auth_prompt' && autoAnswer) queueMicrotask(() => service.answer(event.promptId, event.prompt.type === 'select' ? 'personal' : 'manual-callback')); }, async () => undefined); oauth.refresh.mockClear();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const profile = (name: string, mode = 'api_key') => ({ name, provider: 'openai', protocol: 'openai-responses', baseUrl: '', authMode: mode });
it('isolates credentials for two profiles of the same supplier, encrypts and redacts keys', async () => {
  const a = await service.saveProfile({ ...profile('first'), apiKey: 'sk-first-private-key-12345' }), b = await service.saveProfile({ ...profile('second'), apiKey: 'sk-second-private-key-67890' });
  const ra = await service.runtime(a), rb = await service.runtime(b);
  expect((await ra.models.getAuth('openai'))?.auth.apiKey).toBe('sk-first-private-key-12345'); expect((await rb.models.getAuth('openai'))?.auth.apiKey).toBe('sk-second-private-key-67890');
  const disk = await readFile(join(root, 'credentials.enc'), 'utf8'); expect(disk).not.toContain('sk-first'); expect(JSON.stringify(store.publicState())).not.toContain('private-key'); expect(await service.safeError('error sk-first-private-key-12345')).toBe('error [已隐藏凭据]');
});
it('handles browser/device/select/manual OAuth interactions, serialized refresh and logout', async () => {
  const a = await service.saveProfile(profile('subscription', 'oauth')); await service.login(a.id);
  await vi.waitFor(() => expect(a.hasCredential).toBe(true)); expect(events.filter(e => e.type === 'auth_prompt')).toHaveLength(2);
  const { models } = await service.runtime(a); const results = await Promise.all([models.getAuth('openai'), models.getAuth('openai')]); expect(results[0]?.auth.apiKey).toBe('new-access'); expect(results[1]?.auth.apiKey).toBe('new-access'); expect(oauth.refresh).toHaveBeenCalledTimes(1);
  await service.logout(a.id); expect(await secrets.read(`${a.id}:openai`)).toBeUndefined(); expect(a.hasCredential).toBe(false);
});
it('cancels a pending login without storing partial credentials', async () => {
  autoAnswer = false; const a = await service.saveProfile(profile('cancelled', 'oauth')); const authId = await service.login(a.id);
  await vi.waitFor(() => expect(events.some(e => e.type === 'auth_prompt')).toBe(true)); expect(() => service.assertIdle()).toThrow('取消登录'); service.cancelLogin(authId);
  await vi.waitFor(() => expect(events.some(e => e.type === 'auth' && (e.event as any).type === 'error')).toBe(true)); expect(await secrets.read(`${a.id}:openai`)).toBeUndefined();
});
it('validates auth and model limits and preserves disabled models outside chat selections', async () => {
  await expect(service.saveProfile({ ...profile('invalid'), provider: 'custom', baseUrl: '', authMode: 'none' })).rejects.toThrow('服务地址');
  const a = await service.saveProfile({ ...profile('local'), provider: 'custom', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1234/v1', authMode: 'none' });
  const model = await service.saveModel({ profileId: a.id, modelId: 'local-model', name: 'local', vision: false, reasoning: false, enabled: false, contextWindow: 8192, maxTokens: 1024 });
  await expect(service.selected(model.id)).rejects.toThrow('已启用'); await expect(service.saveModel({ ...model, maxTokens: 8192 })).rejects.toThrow('上下文');
});

it('stages credential revisions so a failed configuration save cannot pair a new key with an old endpoint',async()=>{
 const first=await service.saveProfile({...profile('stable'),apiKey:'old-private-credential-12345'});const save=vi.spyOn(store,'save').mockRejectedValueOnce(new Error('disk unavailable'));
 await expect(service.saveProfile({...first,baseUrl:'https://models.example/v1',apiKey:'new-private-credential-67890'})).rejects.toThrow('disk');save.mockRestore();
 const after=service.profile(first.id);expect(after.baseUrl).toBe('');expect((await (await service.runtime(after)).models.getAuth('openai'))?.auth.apiKey).toBe('old-private-credential-12345');
 const updated=await service.saveProfile({...first,apiKey:'new-private-credential-67890'});expect(updated.credentialNamespace).toContain('revision');expect((await (await service.runtime(updated)).models.getAuth('openai'))?.auth.apiKey).toBe('new-private-credential-67890');
 expect(await service.safeError('old-private-credential-12345 new-private-credential-67890')).toBe('[已隐藏凭据] [已隐藏凭据]');await service.logout(updated.id);expect(await secrets.list(`${updated.id}:`)).toEqual([]);
});

it('rolls back model edits and deletions when state persistence fails',async()=>{
 const p=await service.saveProfile({...profile('local'),provider:'custom',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1234/v1',authMode:'none'});
 const model=await service.saveModel({profileId:p.id,modelId:'local',name:'stable',vision:false,reasoning:false,enabled:true,contextWindow:8192,maxTokens:1024});
 const save=vi.spyOn(store,'save').mockRejectedValue(new Error('disk unavailable'));
 await expect(service.saveModel({...model,name:'unsaved'})).rejects.toThrow('disk');expect(store.state.models[0].name).toBe('stable');
 await expect(service.deleteModel(model.id)).rejects.toThrow('disk');expect(store.state.models).toHaveLength(1);save.mockRestore();
});
it('preserves profile, models and encrypted credentials when profile deletion cannot be saved',async()=>{
 const p=await service.saveProfile({...profile('stable'),apiKey:'keep-private-credential-12345'});const save=vi.spyOn(store,'save').mockRejectedValue(new Error('disk full'));
 await expect(service.deleteProfile(p.id)).rejects.toThrow('disk');expect(service.profile(p.id)).toEqual(p);expect((await secrets.read(`${p.id}:openai`)).key).toBe('keep-private-credential-12345');save.mockRestore();
});
it('refuses logout during an unfinished login and does not probe subscription credentials at an incompatible public models URL',async()=>{
 autoAnswer=false;const p=await service.saveProfile(profile('subscription','oauth'));const id=await service.login(p.id);await vi.waitFor(()=>expect(events.some(e=>e.type==='auth_prompt')).toBe(true));await expect(service.logout(p.id)).rejects.toThrow('取消登录');service.cancelLogin(id);await vi.waitFor(()=>expect(events.some(e=>e.type==='auth'&&(e.event as any).type==='error')).toBe(true));
 await secrets.modify(`${p.id}:openai`,()=>({type:'oauth',access:'existing-access',refresh:'existing-refresh',expires:Date.now()+3600000}));expect(await service.probe(p.id)).toContain('尚未测试模型服务');
});
it('keeps the application usable when a legacy model points to a missing profile',async()=>{
 store.state.models.push({id:'orphan',profileId:'missing',name:'orphan',modelId:'x',enabled:true,vision:false,reasoning:false,contextWindow:8192,maxTokens:1024});await service.init();expect(store.state.models).toEqual([]);expect(store.state.recoveryWarnings?.join('')).toContain('orphan');
});

it('restores an existing subscription credential when a replacement login is cancelled',async()=>{
 autoAnswer=false;const p=await service.saveProfile(profile('existing','oauth'));const previous={type:'oauth',access:'old-access',refresh:'old-refresh',expires:Date.now()+3600000};await secrets.modify(`${p.id}:openai`,()=>previous);p.hasCredential=true;await store.save();const id=await service.login(p.id);await vi.waitFor(()=>expect(events.some(e=>e.type==='auth_prompt')).toBe(true));service.cancelLogin(id);await vi.waitFor(()=>expect(events.some(e=>e.type==='auth'&&(e.event as any).type==='error')).toBe(true));expect(await secrets.read(`${p.id}:openai`)).toEqual(previous);expect(p.hasCredential).toBe(true);
});

it('uses the selected entry settings when two configured entries share an upstream model ID',async()=>{
 const p=await service.saveProfile({...profile('local'),provider:'custom',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1234/v1',authMode:'none'});const common={profileId:p.id,modelId:'same-upstream',enabled:true,reasoning:false};const a=await service.saveModel({...common,name:'small text',vision:false,contextWindow:8192,maxTokens:1024}),b=await service.saveModel({...common,name:'large vision',vision:true,contextWindow:65536,maxTokens:8192});
 const selectedA=await service.selected(a.id),selectedB=await service.selected(b.id);expect(selectedA.model).toMatchObject({name:'small text',input:['text'],contextWindow:8192,maxTokens:1024});expect(selectedB.model).toMatchObject({name:'large vision',input:['text','image'],contextWindow:65536,maxTokens:8192});
});

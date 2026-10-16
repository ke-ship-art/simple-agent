import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai';
import { ModelService } from '../src/main/models';
import { Store, Secrets } from '../src/main/store';
import { reasoningOptions, checkResponse } from '../src/main/reasoning';

let root: string, store: Store, service: ModelService, server: Server | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'simple-agent-reasoning-')); store = new Store(root); await store.init();
  const secrets = new Secrets(root, { encrypt: async text => Buffer.from(text), decrypt: async bytes => Buffer.from(bytes).toString() });
  service = new ModelService(store, secrets, () => undefined, async () => undefined);
});
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } await rm(root, { recursive: true, force: true }); });
const entry = { name: 'model', modelId: 'model', enabled: true, vision: false, reasoning: true, contextWindow: 100000, maxTokens: 4096 };
const profile = (protocol = 'openai-completions') => service.saveProfile({ name: 'custom', provider: 'custom', protocol, baseUrl: 'http://127.0.0.1:1234/v1', authMode: 'none' });

it('reads native capabilities and migrates legacy preferences without changing historical messages', async () => {
  const builtin = openaiProvider().getModels().find(model => model.reasoning && getSupportedThinkingLevels(model).includes('high'))!;
  const connection = await service.saveProfile({ name: 'OpenAI', provider: 'openai', protocol: 'openai-responses', baseUrl: '', authMode: 'api_key', apiKey:'fake-metadata-only-key' });
  store.state.models.push({ ...entry, id: 'old', profileId: connection.id, modelId: builtin.id });
  store.state.sessions.push({ id: 'history', title: 'history', workspaceId: 'old-workspace', modelId: 'old', context: [], messages: [{ id: 'message', role: 'assistant', text: 'legacy', timestamp: 1 }], updatedAt: 1 });
  await service.init();
  expect(store.state.models[0].supportedReasoningLevels).toEqual(getSupportedThinkingLevels(builtin));
  expect(store.state.models[0].reasoningLevel).toBe(clampThinkingLevel(builtin, 'medium'));
  await service.setReasoningLevel({ modelId: 'old', level: 'high' });
  const restarted = new Store(root); await restarted.init(); expect(restarted.state.models[0].reasoningLevel).toBe('high');
  expect(restarted.state.sessions[0].messages[0]).not.toHaveProperty('reasoningLevel');
  const selected = await service.selected('old'); expect(selected.model.thinkingLevelMap).toEqual(builtin.thinkingLevelMap);
});
it('keeps preferences separate and requires explicit custom capability declarations', async () => {
  const connection = await profile();
  const a = await service.saveModel({ ...entry, profileId: connection.id }); expect(a.supportedReasoningLevels).toEqual([]);
  await expect(service.setReasoningLevel({ modelId: a.id, level: 'high' })).rejects.toThrow('不支持');
  const b = await service.saveModel({ ...entry, name: 'B', modelId: 'B', profileId: connection.id, supportedReasoningLevels: ['low', 'medium', 'high'] });
  const c = await service.saveModel({ ...entry, name: 'C', modelId: 'C', profileId: connection.id, supportedReasoningLevels: ['low', 'high'] });
  expect(b.reasoningLevel).toBe('medium'); expect(c.reasoningLevel).toBe('high');
  await service.setReasoningLevel({ modelId: b.id, level: 'low' }); expect(c.reasoningLevel).toBe('high');
  await expect(service.setReasoningLevel({ modelId: b.id, level: 'off' })).rejects.toThrow('不支持');
  store.state.activeRun = { id: 'run', sessionId: 'session', modelId: b.id, status: 'running' };
  await expect(service.setReasoningLevel({ modelId: b.id, level: 'high' })).rejects.toThrow('停止');
});

it.each([
  ['openai-completions', 'mock-reasoner', 'high'],
  ['openai-responses', 'mock-reasoner', 'high'],
  ['anthropic-messages', 'claude-sonnet-4-5', 'medium'],
  ['google-generative-ai', 'gemini-3.1-pro-preview', 'high'],
  ['google-generative-ai', 'gemini-2.5-flash', 'medium']
] as const)('sends real %s wire requests with mapped reasoning and bounded tokens (%s)', async (protocol, modelId, level) => {
  const requests: any[] = [];
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body));
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'captured test request', status: 'INVALID_ARGUMENT' } }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const connection = await service.saveProfile({ name: 'capture', provider: 'custom', protocol, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, authMode: 'api_key', apiKey: 'fake-test-key' });
  const model = await service.saveModel({ ...entry, profileId: connection.id, modelId, supportedReasoningLevels: ['low', 'medium', 'high'], reasoningLevel: level });
  await expect(service.test(model.id)).rejects.toThrow('captured test request'); expect(requests).toHaveLength(1);
  const body = requests[0];
  if (protocol === 'openai-completions') { expect(body.reasoning_effort).toBe(level); expect(body.max_tokens).toBe(4096); }
  if (protocol === 'openai-responses') { expect(body.reasoning.effort).toBe(level); expect(body.max_output_tokens).toBe(4096); }
  if (protocol === 'anthropic-messages') { expect(body.thinking).toMatchObject({ type: 'enabled', budget_tokens: 3072 }); expect(body.max_tokens).toBe(4096); }
  if (protocol === 'google-generative-ai') {
    expect(body.generationConfig.maxOutputTokens).toBe(4096);
    expect(body.generationConfig.thinkingConfig).toMatchObject(modelId.includes('3.1') ? { thinkingLevel: 'HIGH' } : { thinkingBudget: 3072 });
  }
});
it('rejects insufficient reasoning budgets and truncated or empty successes', () => {
  const configured = { ...entry, id: 'x', profileId: 'x', supportedReasoningLevels: ['medium'] as const, reasoningLevel: 'medium' as const };
  expect(() => reasoningOptions({ ...configured, supportedReasoningLevels: ['medium'], maxTokens: 1024 }, { api: 'anthropic-messages' } as any)).toThrow('2048');
  expect(() => checkResponse({ stopReason: 'length', content: [] } as any)).toThrow('输出上限');
  expect(() => checkResponse({ stopReason: 'stop', content: [{ type: 'thinking', thinking: 'hidden' }] } as any)).toThrow('未返回');
});
it('preserves native adaptive Anthropic capabilities and sends its effort field', async () => {
  const builtin = anthropicProvider().getModels().find(model => model.compat?.forceAdaptiveThinking && getSupportedThinkingLevels(model).includes('high') && !model.compat.allowedFallbackModels)!;
  expect(builtin).toBeTruthy(); const requests: any[] = [];
  server = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body)); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'captured adaptive request' } })); });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const connection = await service.saveProfile({ name: 'Anthropic', provider: 'anthropic', protocol: 'anthropic-messages', baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, authMode: 'api_key', apiKey: 'fake-test-key' });
  const model = await service.saveModel({ ...entry, modelId: builtin.id, profileId: connection.id, reasoningLevel: 'high' });
  await expect(service.test(model.id)).rejects.toThrow('captured adaptive request');
  expect(requests).toHaveLength(1); expect(requests[0].thinking.type).toBe('adaptive'); expect(requests[0].output_config.effort).toBe(builtin.thinkingLevelMap?.high ?? 'high'); expect(requests[0].max_tokens).toBe(4096);
});

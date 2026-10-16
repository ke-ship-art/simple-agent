import type { Model, SimpleStreamOptions, AssistantMessage } from '@earendil-works/pi-ai';
import type { ModelEntry } from '../shared/types';

/** Keep reasoning and visible output inside the configured total response ceiling. */
export function reasoningOptions(entry: ModelEntry, model: Model<any>): Pick<SimpleStreamOptions, 'reasoning' | 'maxTokens' | 'thinkingBudgets'> {
  const level = entry.supportedReasoningLevels?.includes(entry.reasoningLevel!) ? entry.reasoningLevel : undefined;
  if (!level || level === 'off') return { maxTokens: entry.maxTokens };
  const usesBudget = (model.api === 'anthropic-messages' && (model as Model<'anthropic-messages'>).compat?.forceAdaptiveThinking !== true) || (model.api === 'google-generative-ai' && !/gemini-3(?:\.\d+)?-(?:pro|flash)|gemini-flash-(?:lite-)?latest|gemma-?4/i.test(model.id));
  if (!usesBudget) return { reasoning: level, maxTokens: entry.maxTokens };
  if (entry.maxTokens < 2048) throw new Error('推理与回答共享输出上限；此模型启用推理时请将输出上限至少设为 2048，或选择关闭推理。');
  const room = entry.maxTokens - 1024;
  return { reasoning: level, maxTokens: entry.maxTokens, thinkingBudgets: { minimal: Math.min(1024, room), low: Math.min(2048, room), medium: Math.min(8192, room), high: Math.min(16384, room) } };
}
export function checkResponse(response: AssistantMessage) {
  if (response.stopReason === 'length') throw new Error('模型达到输出上限，回答可能不完整；推理也会占用输出额度。请提高输出上限或降低推理强度后重试。');
  if (!response.content.some(block => block.type === 'text' && block.text.trim() || block.type === 'toolCall')) throw new Error('模型未返回可显示的回答或工具调用；请检查输出上限、推理强度及模型服务。');
}

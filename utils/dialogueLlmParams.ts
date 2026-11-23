/**
 * 角色对话请求的采样温度、输出上限和思考参数。本地私聊和云端定时类生成（定时主动消息、
 * 离开后消息、见面离开提醒）按同一套规则取值，同一个角色在两条路上用同一组参数。
 */
import type { APIConfig, CharacterProfile } from '../types';
import { isAmsg2EnabledForChar } from './amsg2Tasks';
import { dialogueMaxTokens } from './characterApi';
import { isAnthropicEndpoint } from './llmEndpoint';
import { shouldSendThinkingParams } from './thinkingGate';

/**
 * 开思考时的模型名：packycode / anyrouter 等第三方 Claude 中转认模型名的 -thinking 后缀，
 * 原生 Anthropic 端点保留真实模型 ID。即时对话（请求体终值）和定时类（chat 凭据行）共用。
 */
export const withThinkingModelSuffix = (model: string, baseUrl: string): string =>
  !isAnthropicEndpoint(baseUrl) && /^claude-/i.test(model) && !/-thinking$/i.test(model)
    ? `${model}-thinking` : model;

export interface DialogueLlmParams {
  /** 请求体终值：兼容模式下 claude 系开思考时带 -thinking 后缀。 */
  model: string;
  /** 开思考时不带（Claude 系开思考只接受默认温度）。 */
  temperature?: number;
  maxTokens: number;
  /** 思考三件套（thinking / reasoning_effort / extra_body），不同代理认不同入口。 */
  extraBody?: Record<string, unknown>;
}

export const resolveDialogueLlmParams = (input: {
  api: { baseUrl: string; model: string; temperature?: number; maxTokens?: number };
  thinkingActive: boolean;
  legacyToolModeActive: boolean;
  amsg2ToolsInjected: boolean;
}): DialogueLlmParams => {
  const maxTokens = dialogueMaxTokens(input.api);
  const model = input.api.model || '';
  if (maxTokens <= 1024 || !shouldSendThinkingParams({
    thinkingActive: input.thinkingActive,
    legacyToolModeActive: input.legacyToolModeActive,
    amsg2ToolsInjected: input.amsg2ToolsInjected,
    model,
  })) {
    return { model, temperature: input.api.temperature ?? 0.85, maxTokens };
  }
  const thinking = { type: 'enabled', budget_tokens: Math.min(4000, maxTokens - 1) };
  return {
    model: withThinkingModelSuffix(model, input.api.baseUrl),
    maxTokens,
    extraBody: { thinking, reasoning_effort: 'medium', extra_body: { thinking } },
  };
};

/** 去掉 withThinkingModelSuffix 加上的后缀（救援导回本地时用）。 */
export const withoutThinkingModelSuffix = (model: string, baseUrl: string): string =>
  !isAnthropicEndpoint(baseUrl) && /^claude-.+-thinking$/i.test(model) ? model.replace(/-thinking$/i, '') : model;

/**
 * 定时类到点时的工具环境：这个角色会不会上云 MCP 工具、原生 tools 开关开没开。
 * 读的是浏览器里的设置，由 activeMsgClient 注册进来——这份文件经凭据行模块进了
 * worker bundle，不能直接依赖那些浏览器模块。没注册时按「没有 MCP、原生 tools」处理。
 */
export interface ScheduledToolEnv { cloudMcp: boolean; nativeTools: boolean }
let scheduledToolEnv: ((charId: string) => ScheduledToolEnv) | null = null;
export const registerScheduledToolEnv = (provider: ((charId: string) => ScheduledToolEnv) | null): void => {
  scheduledToolEnv = provider;
};

/**
 * 定时类云端生成（定时主动消息、离开后消息、见面离开提醒）的参数，思考门与本地私聊、即时对话
 * 同一套判定（useChatAI 的 toolModeActive 与 amsg2ToolMode）：
 *  - 会上云 MCP 工具 = 工具模式，思考让步（模型名也不加后缀）；
 *  - 2.0 排程工具只在原生 tools 时随请求带上，正文模式下没有「thinking + tools 同发」。
 */
export const resolveScheduledLlmParams = (
  char: Pick<CharacterProfile, 'id' | 'showThinkingChain' | 'activeMsg2Config'>,
  api: Pick<APIConfig, 'baseUrl' | 'model' | 'temperature' | 'maxTokens'>,
): DialogueLlmParams => {
  const env = scheduledToolEnv?.(char.id) ?? { cloudMcp: false, nativeTools: true };
  return resolveDialogueLlmParams({
    api,
    thinkingActive: !!char.showThinkingChain,
    legacyToolModeActive: env.cloudMcp,
    amsg2ToolsInjected: isAmsg2EnabledForChar(char as CharacterProfile) && env.nativeTools,
  });
};

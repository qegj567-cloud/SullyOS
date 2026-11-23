// utils/dialogueLlmParams.test.ts
//
// 回归守卫：定时类云端生成的思考门与本地私聊、即时对话同一套判定——
//   - 角色会上云 MCP 工具（工具模式）时思考让步，chat 行的模型名也不加 -thinking；
//   - 原生 tools 开关关着（正文模式）时请求里没有 tools，Gemini 不必让步；
//   - 普通角色照常带思考参数。
import { afterEach, describe, expect, it } from 'vitest';
import * as params from './dialogueLlmParams';

const relay = { baseUrl: 'https://relay.example/v1/chat/completions', model: 'claude-sonnet-4', maxTokens: 8000 };
const gemini = { baseUrl: 'https://relay.example/v1/chat/completions', model: 'gemini-2.5-pro', maxTokens: 8000 };
const char = (over: Record<string, unknown> = {}) => ({
  id: 'c-gate', showThinkingChain: true, activeMsg2Config: { enabled: true, tasks: [] }, ...over,
}) as any;
const withEnv = (env: { cloudMcp: boolean; nativeTools: boolean }) =>
  (params as any).registerScheduledToolEnv(() => env);

afterEach(() => { (params as any).registerScheduledToolEnv?.(null); });

describe('resolveScheduledLlmParams 的思考门', () => {
  it('会上云 MCP 工具的角色：思考让步，模型名不加后缀', () => {
    withEnv({ cloudMcp: true, nativeTools: true });
    const out = params.resolveScheduledLlmParams(char(), relay);
    expect(out.extraBody).toBeUndefined();
    expect(out.model).toBe('claude-sonnet-4');
    expect(out.temperature).toBe(0.85);
  });

  it('Gemini + 正文模式：请求不带 tools，照常带思考参数', () => {
    withEnv({ cloudMcp: false, nativeTools: false });
    expect(params.resolveScheduledLlmParams(char(), gemini).extraBody).toBeTruthy();
    withEnv({ cloudMcp: false, nativeTools: true });
    expect(params.resolveScheduledLlmParams(char(), gemini).extraBody).toBeUndefined();
  });

  it('普通角色：带思考参数，中转 claude 模型加后缀', () => {
    withEnv({ cloudMcp: false, nativeTools: true });
    const out = params.resolveScheduledLlmParams(char(), relay);
    expect(out.extraBody).toBeTruthy();
    expect(out.model).toBe('claude-sonnet-4-thinking');
  });
});

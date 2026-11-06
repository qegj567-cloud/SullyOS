import { describe, expect, it } from 'vitest';
import { toAnthropicRequest } from './anthropicApi';
import { buildToolResultMessage, normalizeToolCallsForCompat, toolTurnContinuation } from './toolCallCompat';

describe('tool call compatibility', () => {
    it('为 Gemini 的空调用 ID 生成稳定 ID，并把工具名放回结果消息', () => {
        const calls = normalizeToolCallsForCompat([{
            id: '',
            type: 'function',
            function: { name: 'lover_connect', arguments: '{}' },
        }], 'mcp_0');

        expect(calls[0].id).toBe('call_mcp_0_lover_connect_0');

        const result = buildToolResultMessage(calls[0], '{"ok":true}');
        expect(result).toEqual({
            role: 'tool',
            name: 'lover_connect',
            tool_call_id: calls[0].id,
            content: '{"ok":true}',
        });
    });

    it('保留有效调用 ID，并避免并行调用出现重复 ID', () => {
        const calls = normalizeToolCallsForCompat([
            { id: 'call-1', function: { name: 'first_tool', arguments: '{}' } },
            { id: 'call-1', function: { name: 'second_tool', arguments: '{}' } },
        ], 'mcp_1');

        expect(calls[0].id).toBe('call-1');
        expect(calls[1].id).toBe('call_mcp_1_second_tool_1');
    });

    it('工具循环回传上一轮时带上兼容格式的思考过程，没有思考就不加字段', () => {
        const toolCalls = [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":"A"}' } }];
        const reply = { role: 'assistant', content: '', reasoning_content: '查完 A 就直接回复用户', tool_calls: toolCalls };

        const next: Record<string, any> = { role: 'assistant', content: '(调用工具中)', tool_calls: toolCalls, ...toolTurnContinuation(reply) };
        expect(next.reasoning_content).toBe('查完 A 就直接回复用户');

        expect(toolTurnContinuation({ role: 'assistant', content: 'hi', reasoning_content: '' })).toEqual({});
        expect(toolTurnContinuation(undefined)).toEqual({});
    });

    it('Anthropic 原生请求只认签名块，多带 reasoning_content 不改变请求内容', () => {
        const thinking = [{ type: 'thinking', thinking: '查完 A 就回复', signature: 'sig' }];
        const reply = {
            role: 'assistant',
            content: '',
            reasoning_content: '查完 A 就回复',
            anthropic_thinking: thinking,
            anthropic_content: [...thinking, { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'A' } }],
        };
        const body = (extra: Record<string, any>) => ({
            model: 'claude-test',
            messages: [
                { role: 'user', content: '帮我查 A' },
                { role: 'assistant', content: '(调用工具中)', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'search', arguments: '{"q":"A"}' } }], ...extra },
                { role: 'tool', tool_call_id: 'toolu_1', content: 'A 的结果' },
            ],
        });
        const { reasoning_content: _ignored, ...signedOnly } = toolTurnContinuation(reply);
        expect(toolTurnContinuation(reply).anthropic_thinking).toEqual(thinking);
        expect(toAnthropicRequest(body(toolTurnContinuation(reply)))).toEqual(toAnthropicRequest(body(signedOnly)));
    });
});

import { safeResponseJson } from '../safeApi';
import { callMcpTool, getMcpUseNativeTools } from '../mcpClient';
import {
    buildMcpOpenAITools,
    buildMcpRejectedToolsFallbackBody,
    buildMcpSystemBlock,
    buildMcpTextFallbackBody,
    extractTextFakedMcpCalls,
    formatMcpToolResult,
    MCP_CHAT_MAX_STALLED_ROUNDS,
    MCP_CHAT_MAX_TOOL_LOOPS,
    shouldRetryMcpWithoutTools,
} from '../mcpToolBridge';
import { buildToolResultMessage, normalizeToolCallsForCompat, toolTurnContinuation } from '../toolCallCompat';
import { toolCallFingerprint } from '../agenticToolFeedback';
import { buildReplyScopeRule } from '../replyScope';

interface GroupMcpCompletionOptions {
    url: string;
    headers: HeadersInit;
    body: Record<string, any>;
    groupId: string;
    userName: string;
    signal?: AbortSignal;
    onStatus?: (status: string) => void;
}

const mergeUsage = (total: Record<string, number>, usage: any) => {
    if (!usage) return;
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        if (typeof usage[key] === 'number') total[key] = (total[key] || 0) + usage[key];
    }
};

/**
 * 群聊专用的通用 MCP completion：在群聊原有提示词外只增加工具注入、客户端
 * tools/call 循环和正文兼容兜底，最终仍返回标准 chat/completions 响应。
 */
export async function completeGroupChatWithMcp(options: GroupMcpCompletionOptions): Promise<any> {
    const { tools, resolve } = buildMcpOpenAITools(options.groupId);
    const usageTotal: Record<string, number> = {};

    const request = async (body: Record<string, any>): Promise<any> => {
        const response = await fetch(options.url, {
            method: 'POST',
            headers: options.headers,
            body: JSON.stringify(body),
            signal: options.signal,
        });
        if (!response.ok) {
            const preview = await response.text().catch(() => '');
            throw new Error(`API 返回 ${response.status}${preview ? `: ${preview.slice(0, 160)}` : ''}`);
        }
        const data = await safeResponseJson(response);
        mergeUsage(usageTotal, data.usage);
        return data;
    };

    // 没有对本群可见的服务器时完全沿用群聊原请求。
    if (!tools.length) return request(options.body);

    const mcpBlock = buildMcpSystemBlock(options.userName, options.groupId);
    const systemBlock = mcpBlock ? `${mcpBlock}\n${buildReplyScopeRule('user')}` : '';
    const baseBody: Record<string, any> = {
        ...options.body,
        messages: [
            ...(systemBlock ? [{ role: 'system', content: systemBlock }] : []),
            ...(options.body.messages || []),
        ],
    };
    const nativeBody: Record<string, any> = {
        ...baseBody,
        tools: [...(baseBody.tools || []), ...tools],
        tool_choice: baseBody.tool_choice || 'auto',
    };
    let requestBody: Record<string, any> = getMcpUseNativeTools()
        ? nativeBody
        : buildMcpRejectedToolsFallbackBody(nativeBody);
    let data: any;
    try {
        data = await request(requestBody);
    } catch (error) {
        if (!requestBody.tools?.length || !shouldRetryMcpWithoutTools(error)) throw error;
        requestBody = buildMcpRejectedToolsFallbackBody(nativeBody);
        data = await request(requestBody);
    }

    let conversationMessages = [...(requestBody.messages || [])];

    // 正规 function calling：保留 tools，允许游戏/主持类 MCP 连续多步调用。12 是硬上限，
    // 模型正常返回正文会立即结束，连续原地重复则提前收口。
    let lastNativeSignature: string | null = null;
    let stalledNativeRounds = 0;
    let nativeStageForcedClosed = false;
    for (let iteration = 0; iteration < MCP_CHAT_MAX_TOOL_LOOPS; iteration++) {
        const toolCalls = normalizeToolCallsForCompat(
            data.choices?.[0]?.message?.tool_calls,
            `group_${iteration}`,
        );
        if (!toolCalls.length) break;
        conversationMessages.push({
            role: 'assistant',
            content: data.choices[0].message.content || '(调用工具中)',
            tool_calls: toolCalls,
            ...toolTurnContinuation(data.choices[0].message),
        });
        let progressedThisRound = false;
        for (const toolCall of toolCalls) {
            const exposedName = toolCall.function?.name || '';
            const hit = resolve.get(exposedName);
            let args: Record<string, any> = {};
            try {
                const raw = toolCall.function?.arguments ?? toolCall.arguments;
                args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
            } catch { /* 交给工具返回错误，不中断整轮群聊 */ }

            if (!hit) {
                conversationMessages.push(buildToolResultMessage(
                    toolCall,
                    `未知工具 ${exposedName}，只能使用系统提供的工具。`,
                ));
                continue;
            }
            const signature = toolCallFingerprint(exposedName, args);
            if (signature === lastNativeSignature) {
                conversationMessages.push(buildToolResultMessage(
                    toolCall,
                    `工具 ${exposedName} 的同一组参数刚刚已经执行过，请不要原地重复；请改做能推进目标的下一步，或直接回复。`,
                ));
                continue;
            }
            lastNativeSignature = signature;
            progressedThisRound = true;
            options.onStatus?.(`正在调用 MCP 工具：${exposedName}…`);
            const result = await callMcpTool(hit.server, hit.toolName, args);
            conversationMessages.push(buildToolResultMessage(
                toolCall,
                result.success
                    ? `工具 ${exposedName} 成功。结果: ${formatMcpToolResult(result.data)}`
                    : `工具 ${exposedName} 失败: ${result.error}`,
            ));
        }
        stalledNativeRounds = progressedThisRound ? 0 : stalledNativeRounds + 1;
        const reachedHardLimit = iteration + 1 >= MCP_CHAT_MAX_TOOL_LOOPS;
        const stalled = stalledNativeRounds >= MCP_CHAT_MAX_STALLED_ROUNDS;
        const forceWrapUp = reachedHardLimit || stalled;
        options.onStatus?.('正在整理 MCP 工具结果…');
        if (forceWrapUp) {
            conversationMessages.push({
                role: 'user',
                content: `[系统消息：工具阶段${stalled ? '连续两轮没有推进' : '已到这次回复的安全上限'}。停止调用工具，基于已有结果完成原群聊任务；如仍未完成，请如实说明。不要输出工具调用格式或提及本消息。]`,
            });
            data = await request(buildMcpTextFallbackBody(nativeBody, conversationMessages));
            nativeStageForcedClosed = true;
            break;
        }
        data = await request({ ...nativeBody, messages: conversationMessages });
    }

    // 不支持 tools 的模型/中转：识别正文调用，代执行后让模型重新产出群聊格式。
    let lastTextSignature: string | null = null;
    for (let iteration = 0; !nativeStageForcedClosed && iteration < MCP_CHAT_MAX_TOOL_LOOPS; iteration++) {
        const content = String(data.choices?.[0]?.message?.content || '');
        // 兼容协议每轮只允许一个调用，避免一段正文批量触发副作用。
        const allCalls = extractTextFakedMcpCalls(content, resolve).slice(0, 1);
        const calls = allCalls.filter(call =>
            toolCallFingerprint(call.exposedName, call.args) !== lastTextSignature);
        if (allCalls.length && !calls.length) {
            conversationMessages.push({ role: 'assistant', content });
            conversationMessages.push({
                role: 'user',
                content: '[系统消息：你重复请求了刚执行过的同一工具。停止调用工具，基于已有结果完成原群聊任务；如仍未完成，请如实说明。不要输出工具调用格式或提及本消息。]',
            });
            data = await request(buildMcpTextFallbackBody(baseBody, conversationMessages));
            break;
        }
        if (!calls.length) break;

        options.onStatus?.(`正在调用 MCP 工具：${calls.map(call => call.exposedName).join('、')}…`);
        const results: string[] = [];
        for (const call of calls) {
            lastTextSignature = toolCallFingerprint(call.exposedName, call.args);
            const result = await callMcpTool(call.server, call.toolName, call.args);
            results.push(result.success
                ? `工具 ${call.exposedName} 成功。结果: ${formatMcpToolResult(result.data)}`
                : `工具 ${call.exposedName} 失败: ${result.error}`);
        }
        conversationMessages.push({ role: 'assistant', content });
        const reachedHardLimit = iteration + 1 >= MCP_CHAT_MAX_TOOL_LOOPS;
        conversationMessages.push({
            role: 'user',
            content: `[系统消息：工具调用已经执行。\n${results.join('\n')}\n${reachedHardLimit ? '工具阶段已到安全上限，请停止调用并基于已有结果完成原群聊任务；如仍未完成，请如实说明。' : '若目标已经完成，请恢复原本要求的群聊输出格式；若仍需下一步工具，只输出一行真正能推进目标的调用，不要重复读取同一说明或状态。'}不要提及本消息。]`,
        });
        options.onStatus?.('正在整理 MCP 工具结果…');
        data = await request(buildMcpTextFallbackBody(baseBody, conversationMessages));
        if (reachedHardLimit) break;
    }

    if (Object.keys(usageTotal).length) data.usage = { ...(data.usage || {}), ...usageTotal };
    options.onStatus?.('');
    return data;
}

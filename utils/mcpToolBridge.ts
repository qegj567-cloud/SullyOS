/**
 * 通用 MCP → 聊天工具循环 的桥接层（对标 luckinToolBridge 的角色分工）
 *
 * 职责：
 * 1. 把所有启用 MCP 服务器的已发现工具聚合成 OpenAI function-calling 格式
 * 2. 生成注入 systemPrompt 的说明块与尾部提醒
 * 3. 中转不认 function calling 时的兼容兜底（降级请求体、前置气泡粗洗）
 * 重名映射和正文假调用解析住在 mcpFireCore（浏览器与 amsg worker 共用）。
 * 工具循环本体在 hooks/useChatAI.ts（对标 luckinChat 循环）。
 */

import { getEnabledMcpServers, type McpServerConfig, type McpToolDef } from './mcpClient';
import { buildMcpNameMap, type FakedMcpCall as FakedMcpCallCore, type McpResolvedToolCore } from './mcpFireCore';

// 结果格式化和正文假调用解析都是纯逻辑，住在 mcpFireCore 里给浏览器和 amsg
// worker 共用；这里按原名转出来，调用方的引用路径不用动。
export {
    MCP_RESULT_MAX_CHARS,
    formatMcpToolResult,
    stripTextFakedMcpCalls,
    extractTextFakedMcpCalls,
} from './mcpFireCore';

export interface OpenAIMcpTool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: any;
    };
}

/**
 * 前台 MCP 工具循环硬上限。不是固定调用次数：模型正常回复会立即退出；只有仍在调用工具
 * 才继续，连续原地重复则提前收束。游戏/论坛类多步任务最多可推进到 12 轮。
 */
export const MCP_CHAT_MAX_TOOL_LOOPS = 12;
export const MCP_CHAT_MAX_STALLED_ROUNDS = 2;

/** 名映射条目，server 收窄成前台的完整配置类型（含 proxyUrl 等浏览器侧字段） */
export type ResolvedMcpTool = McpResolvedToolCore<McpServerConfig>;

/** 正文假调用条目，server 收窄成前台完整配置（callMcpTool 要 proxyUrl/proxyKey） */
export type FakedMcpCall = FakedMcpCallCore<McpServerConfig>;

/**
 * 聚合启用服务器的工具，返回 OpenAI 工具数组 + 暴露名→真实工具 的映射。
 * 暴露名（含重名前缀、非法字符替换）统一由 mcpFireCore.buildMcpNameMap 算，
 * 保证前台聊天和 amsg worker 后台 fire 看到的是同一套工具名。
 * charId：只聚合对该角色可见的服务器（通用 + 绑定了该角色的）。
 */
export const buildMcpOpenAITools = (charId?: string): { tools: OpenAIMcpTool[]; resolve: Map<string, ResolvedMcpTool> } => {
    const servers = getEnabledMcpServers(charId);
    const resolve: Map<string, ResolvedMcpTool> = buildMcpNameMap(servers);
    const tools: OpenAIMcpTool[] = [];
    for (const [exposed, { server, tool }] of resolve) {
        tools.push({
            type: 'function',
            function: {
                name: exposed,
                description: buildToolDescription(server, tool, servers.length > 1),
                parameters: tool.inputSchema || { type: 'object', properties: {} },
            },
        });
    }
    return { tools, resolve };
};

const buildToolDescription = (server: McpServerConfig, t: McpToolDef, multi: boolean): string => {
    const desc = (t.description || '').trim();
    // 多服务器时在描述里带上来源，帮模型区分同类工具
    return multi ? `[${server.name}] ${desc}` : desc;
};

// ========== 提示词 ==========

/**
 * MCP 工具模式的 systemPrompt 说明块。
 * 与瑞幸不同：这里的工具是用户自配的、内容未知，所以只讲纪律，不讲业务流程。
 * charId：只列对该角色可见的服务器，与 buildMcpOpenAITools 的过滤保持一致。
 */
export const buildMcpSystemBlock = (userName: string = '用户', charId?: string): string => {
    const servers = getEnabledMcpServers(charId);
    if (!servers.length) return '';
    const lines = servers.map(s => {
        const names = (s.tools || []).map(t => t.name).join('、');
        return `- ${s.name}: ${names}`;
    });
    return `

---
[外部工具已接入 —— ${userName} 在设置里给你连了 MCP 工具服务器]

**核心**: 你还是原来的角色、原来的语气、原来的记忆。工具只是你顺手能用的能力，**每次回复都要有角色化的文字**，别干巴巴报结果。

可用工具来源:
${lines.join('\n')}

**使用纪律**:
- 需要时直接调工具（系统会自动执行并把结果给你），不需要时正常聊天，**别硬找理由调工具**。
- 用户明确要求完成游戏、论坛或其他多步任务时，先做必要检查，随后立刻调用能推进目标的动作工具；不要反复读取同一份说明或状态。执行动作后可以再次检查新状态，并继续到目标完成或工具明确失败。
- 工具必须通过系统的 function calling 接口发起，**绝对不要把工具名和参数写进聊天正文**（比如输出 \`工具名(参数)\` 这种文字），用户会看到乱码一样的东西。
- 工具结果只挑与对话相关的部分用角色语气转述，别整段复读 JSON。
- 工具失败就如实说，并根据报错调整参数重试或换个方式，别编造结果。
- 涉及真实世界副作用的操作（发布内容、下单、删除等），若 ${userName} 在最新消息里已经明确要求执行，即视为已经确认；没有明确要求时才先确认一句再动手。
---
`;
};

/** 尾部小提醒（注入 messages 末尾，防长对话把纪律冲掉） */
export const MCP_TAIL_REMINDER = `[MCP 工具 ON · 永远用角色语气回复别空回; 工具只能走 function calling 接口、严禁写成正文文字; 工具结果别复读 JSON; 用户最新消息里已明确要求的操作视为已确认，否则副作用操作先确认]`;

// ========== 掉格式容错: 正文里的"假工具调用"（解析本体见 mcpFireCore） ==========

/**
 * MCP 工具前置气泡专用粗洗。该气泡在统一后处理之前落库，必须自行清掉模型
 * 复刻的历史外壳和思考标签；不能把“用户发送了表情包”反向变成角色消息。
 */
export const sanitizeMcpLeadInText = (raw: string): string => {
    let cleaned = raw || '';
    cleaned = cleaned.replace(/<(think|thinking|thought)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    cleaned = cleaned.replace(/<(?:think|thinking|thought)\b[^>]*>[\s\S]*$/gi, '');
    cleaned = cleaned.replace(/<\/?(?:think|thinking|thought)\b[^>]*>/gi, '');
    cleaned = cleaned.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*.*?\]/gi, '');
    cleaned = cleaned.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[^\]]*\]/g, '');
    cleaned = cleaned.replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * 正文假调用已经由客户端代为执行，下一跳只负责把结果组织成角色回复。
 * 这里必须移除 tools；否则部分中转会在这一跳改走正规 tool_calls，返回空正文，
 * 而正规工具循环阶段已经结束，最终表现就是角色一直打字后不落消息。
 * 不支持 FC 的模型仍可继续输出正文假调用，并由同一兜底循环处理多步任务。
 */
export const buildMcpTextFallbackBody = (baseReqBody: any, messages: any[]): any => {
    const followBody = { ...baseReqBody, messages };
    delete followBody.tools;
    delete followBody.tool_choice;
    return followBody;
};

/** tools 被中转拒绝时，把最小 schema 仅作为本轮兼容说明交给正文调用兜底。 */
export const buildMcpRejectedToolsFallbackBody = (baseReqBody: any): any => {
    const followBody = buildMcpTextFallbackBody(baseReqBody, baseReqBody.messages || []);
    const signatures = (baseReqBody.tools || []).map((tool: any) => {
        const fn = tool?.function || {};
        const schema = fn.parameters || {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const args = Object.entries(schema.properties || {}).map(([name, def]: [string, any]) =>
            `${name}${required.has(name) ? '*' : ''}:${def?.type || 'any'}`,
        );
        const description = typeof fn.description === 'string' ? fn.description.trim() : '';
        return `- ${fn.name}(${args.join(', ')})${description ? `：${description}` : ''}`;
    }).filter(Boolean);
    followBody.messages = [...followBody.messages, {
        role: 'system',
        content: `[MCP 兼容模式：当前 API 中转拒绝 function calling 参数。必须根据下方工具的来源、描述和参数选择真正匹配用户意图的工具，禁止因为名字看起来通用就乱选。每一步如果需要工具，只输出一行 tool_name({"参数":"值"})，系统会代为执行后把结果给你；收到结果后，若任务还没完成就选择下一步真正能推进目标的工具，不要反复读取同一份说明或状态。没有收到系统返回前不要声称工具已经成功，也不要自行编造结果。* 表示必填参数。\n${signatures.join('\n')}]`,
    }];
    return followBody;
};

/** 部分 OpenAI 兼容中转不是忽略 tools，而是直接用 4xx 拒绝整次请求。 */
export const shouldRetryMcpWithoutTools = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error || '');
    return /(?:^|\D)(?:400|401|403|422)(?:\D|$)/.test(message);
};

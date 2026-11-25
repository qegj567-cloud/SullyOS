/**
 * 透明流式升级（Transparent Stream Upgrade）
 *
 * 背景：仓库里有 40+ 处 LLM 调用点硬编码 `stream:false`（查手机 / 记忆宫殿 / 日程 /
 * 剧场 / 群聊 / 日记…）。非流式的长生成最容易撞网关/中转的空闲超时——连接上几十秒
 * 一个字节都不回，网关掐掉连接，表现为「回复被截断 / 半截 JSON」。
 *
 * 做法：在 OSContext 的全局 fetch 拦截器（所有 /chat/completions 的统一出口，与
 * 采样参数兼容层同一位置）做双向改写：
 *   - 请求侧：主 API 设置开了 stream 时，把 `stream:false/缺省` 的请求体升级为
 *     `stream:true (+ stream_options.include_usage)`
 *   - 响应侧：把 SSE 攒齐拼回标准 chat.completion JSON，再交还调用方
 *
 * 调用方拿到的响应与升级前**字节级等价**（同样的 choices/usage 结构），但传输过程
 * 一直有字节在流，网关不会误判死连接。已经自己设了 `stream:true` 的调用（聊天主路径、
 * 见面、情绪评估）不碰——它们各自的解析链路（增量预览 / safeResponseJson）原样工作。
 *
 * 个别中转若拒绝 stream/stream_options，错误会原样交给调用方。不能在拦截器里自动
 * 重发付费生成请求：中转可能已经把第一份交给上游，静默重发会造成重复扣费。
 */

import { extractSseStreamError, isSseResponseText, parseSseToCompletion } from './safeApi';
import { readLlmResponseText, type LlmResponseInfo } from './llmEndpoint';
import { readStoredMainApi, readStoredPresets, resolveGlobalMainApi } from './apiSlots';

const API_CONFIG_KEY = 'os_api_config';

/** 主 API 设置里的流式开关（设置 → API → 流式；若主 API 绑定了预设则按预设实时值）。读取失败一律视为关。 */
export function isGlobalStreamEnabled(): boolean {
    try {
        const main = readStoredMainApi();
        if (!main) return false;
        const resolved = resolveGlobalMainApi(main, readStoredPresets());
        return resolved.stream === true;
    } catch {
        return false;
    }
}

/**
 * 判断某次 /chat/completions 请求是否应执行透明流式升级：
 * 1. 调用方在 __sullyMeta.slotStream 显式给出了该槽位自己的流式开关时，优先服从该槽位；
 * 2. 未显式指定时，仅当全局主 API 开启了 stream 且请求地址与主 API baseUrl 同源时才升级，
 *    避免主 API 的流式开关跨服务商误伤另一家渠道的副 API 或识图请求。
 */
export function shouldUpgradeChatRequestToStream(
    requestUrl: string,
    explicitSlotStream?: boolean,
): boolean {
    if (typeof explicitSlotStream === 'boolean') return explicitSlotStream;
    try {
        const main = readStoredMainApi();
        if (!main) return false;
        const resolved = resolveGlobalMainApi(main, readStoredPresets());
        if (resolved.stream !== true) return false;
        if (!resolved.baseUrl || !requestUrl) return true;
        const reqOrigin = new URL(requestUrl).origin;
        const mainOrigin = new URL(resolved.baseUrl).origin;
        return reqOrigin === mainOrigin;
    } catch {
        return isGlobalStreamEnabled();
    }
}

/**
 * 把一个 chat/completions 请求体升级为流式。
 * 返回升级后的 body 字符串；不需要升级（已是流式 / 非 JSON / 非对象）返回 null。
 * 注意：调用方负责先判断全局开关（isGlobalStreamEnabled），本函数保持纯粹。
 */
export function upgradeChatBodyToStream(bodyStr: string): string | null {
    let parsed: any;
    try { parsed = JSON.parse(bodyStr); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.stream === true) return null;  // 调用方自己开了流式：不碰
    parsed.stream = true;
    // include_usage：让末尾 chunk 带 usage，token 计费徽标 / API 调用记录不缺数
    parsed.stream_options = { include_usage: true };
    return JSON.stringify(parsed);
}

/**
 * 把（升级后拿到的）响应归一化回调用方期待的形态：
 *   - SSE 流 → 攒齐拼装成标准 chat.completion JSON（Content-Type: application/json）
 *   - 已是 JSON（代理无视 stream）/ 其他文本 → 原文重新包装（body 已被消费，必须重包）
 * 只在响应 ok 时调用；错误响应由调用方原样透传给业务层的错误处理。
 */
export async function assembleUpgradedResponse(response: Response, info?: LlmResponseInfo): Promise<Response> {
    let text: string;
    try {
        text = await readLlmResponseText(response, info);
    } catch (err: any) {
        if (err?.__sullyUpstreamStreamError) {
            const syntheticStatus = Number(err.httpStatus) || 502;
            const errMsg = typeof err.message === 'string' && err.message.trim()
                ? err.message.replace(/^API Error(?:\s+\d{3})?\s*[:：]\s*/i, '').trim()
                : 'Upstream stream error';
            if (info) info.status = syntheticStatus;
            return new Response(JSON.stringify({ error: { message: errMsg } }), {
                status: syntheticStatus,
                statusText: 'Upstream Stream Error',
                headers: { 'Content-Type': 'application/json' },
            });
        }
        throw err;
    }
    if (isSseResponseText(text, response.headers.get('content-type'))) {
        // 若上游在 HTTP 200 的 SSE 流里直接下发了 `{"error": ...}` 或 `event: error`，还原为非 2xx JSON 响应，
        // 让拦截器的 HTTP 错误日志、API 调用记录（记失败）、同接口成功缓存以及业务调用方全部拿到真实错误原因。
        const streamErr = extractSseStreamError(text);
        if (streamErr) {
            const syntheticStatus = streamErr.status || 502;
            const errorBody = JSON.stringify({
                error: streamErr.rawError && typeof streamErr.rawError === 'object'
                    ? streamErr.rawError
                    : { message: streamErr.message },
            });
            if (info) info.status = syntheticStatus;
            return new Response(errorBody, {
                status: syntheticStatus,
                statusText: 'Upstream Stream Error',
                headers: { 'Content-Type': 'application/json' },
            });
        }
        const assembled = parseSseToCompletion(text);
        if (assembled) {
            return new Response(JSON.stringify(assembled), {
                status: response.status,
                statusText: response.statusText,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        // 拼不出任何 chunk：按原文透传，让调用方的解析器报出带 preview 的错误
    }
    return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: { 'Content-Type': response.headers.get('content-type') || 'application/json' },
    });
}

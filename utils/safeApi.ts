/**
 * Safe API response parsing utilities.
 *
 * Prevents "Unexpected token <" crashes that happen when API proxies
 * return HTML error pages (CloudFlare, nginx 502/503, rate limits)
 * instead of JSON responses.
 */

// 同时挂两套日志：
//   - devDebug 的 api 类目（开发者勾「API」复制 / 下载导出）
//   - 全局 fetch 拦截器 + apiCallLog（用户在「设置 → API 调用记录」里看）
// 后者的 meta 通过下面 safeFetchJson 的第 5 个参数挂到 __sullyMeta 上传出去。
import { appendDevDebugApiLog, makeDebugLogger } from './devDebug';
import { type ApiCallMeta } from './apiCallLog';

const log = makeDebugLogger('api', 'SafeAPI');

function isChatCompletionUrl(url: string): boolean {
    return url.includes('/chat/completions');
}

/** Parse a fetch Response as JSON safely (text-first, then JSON.parse) */
export async function safeResponseJson(response: Response): Promise<any> {
    const text = await response.text();

    // Detect HTML / XML responses
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<')) {
        // Extract useful info from HTML error pages
        const titleMatch = trimmed.match(/<title>(.*?)<\/title>/i);
        const hint = titleMatch ? titleMatch[1] : trimmed.slice(0, 120);
        throw new Error(
            `API返回了HTML而非JSON (HTTP ${response.status}): ${hint}`
        );
    }

    // Empty body
    if (!trimmed) {
        throw new Error(`API返回了空响应 (HTTP ${response.status})`);
    }

    // SSE / 流式响应（有些 OpenAI 兼容代理无视 stream:false 强行流式返回）：
    // 形如 "data: {...}\ndata: {...}\ndata: [DONE]\n"，把 deltas 拼成完整 content
    if (trimmed.startsWith('data:')) {
        const assembled = parseSseToCompletion(text);
        if (assembled) return assembled;
        // 解析不出来 → 继续往下尝试当普通 JSON 抛错，保留原 preview
    }

    try {
        return JSON.parse(text);
    } catch (e) {
        // Show a snippet of what we got for debugging
        const preview = text.slice(0, 200);
        throw new Error(
            `API返回了无效JSON (HTTP ${response.status}): ${preview}`
        );
    }
}

/**
 * 把 OpenAI 兼容的 SSE 流响应合成一个普通 chat/completion 响应对象。
 *
 * 支持两种形态：
 *  1. delta 流：每个 chunk 的 choices[0].delta.content 是增量片段，拼接起来
 *  2. 一次性 SSE：choices[0].message.content 直接就是全部内容（少见）
 *
 * 返回 { choices: [{ message: { content, role }, finish_reason }], ... } 方便上游
 * 用现有的 data.choices[0].message.content 路径消费，无需改调用点。
 */
function parseSseToCompletion(raw: string): any | null {
    let assembled = '';
    let role = 'assistant';
    let finishReason: string | null = null;
    let firstChunk: any = null;
    let usage: any = undefined;
    let gotAnyChunk = false;

    // 按行切，逐行找 "data: " 开头（允许 \r\n、空行分隔）
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { continue; }
        gotAnyChunk = true;
        if (!firstChunk) firstChunk = chunk;
        // OpenAI 流式 usage 在最后一个 chunk（include_usage=true 时），也可能出现在中途；
        // 始终取最后一个非空的 usage，兼容各家代理。
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        // delta 路径（OpenAI 流式常见）
        if (choice.delta) {
            if (typeof choice.delta.content === 'string') assembled += choice.delta.content;
            if (choice.delta.role) role = choice.delta.role;
        }
        // message 路径（一次性 SSE，不常见但兼容）
        else if (choice.message) {
            if (typeof choice.message.content === 'string') {
                assembled += choice.message.content;
            }
            if (choice.message.role) role = choice.message.role;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    if (!gotAnyChunk) return null;

    // 合成兼容结构
    return {
        id: firstChunk?.id || 'sse-assembled',
        object: 'chat.completion',
        created: firstChunk?.created || Math.floor(Date.now() / 1000),
        model: firstChunk?.model || '',
        choices: [{
            index: 0,
            message: { role, content: assembled },
            finish_reason: finishReason,
        }],
        usage: usage || firstChunk?.usage,
    };
}

/**
 * Fetch with automatic retry for transient errors.
 * Retries on: 429, 500, 502, 503, 504 and network failures.
 * Returns the parsed JSON data directly.
 *
 * `timeoutMs`：每次尝试的硬超时。如果调用方没在 options.signal 里自带 AbortController，
 * 这里会给每次 attempt 起一个内部 AbortController，超时就 abort，避免提供方 stall
 * 住整个页面（用户误以为卡死，只能重新打开网页）。0 / 未传 = 不超时。
 */
export async function safeFetchJson(
    url: string,
    options: RequestInit,
    maxRetries: number = 2,
    timeoutMs: number = 0,
    /** 可选：补充「哪个 App / 哪个角色 / 用途」到 API 调用记录（设置 → API 调用记录）。 */
    meta?: ApiCallMeta,
): Promise<any> {
    const retryableStatuses = new Set([429, 500, 502, 503, 504]);
    let lastError: Error | null = null;
    const urlStr = String(url);
    let lastStatus: number | undefined;

    // 把 meta 挂到 RequestInit 上（浏览器忽略未知字段），交给全局 fetch 拦截器统一记录
    // 到「API 调用记录」。这样裸 fetch 和 safeFetchJson 走同一个记录入口，不会重复计。
    const metaOptions: RequestInit = meta ? { ...options, __sullyMeta: meta } as RequestInit : options;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // 每次 attempt 建一个独立的 AbortController（仅用于 timeout）
        // 调用方自己的 options.signal 仍然有效，两者任一触发就 abort
        let attemptOptions = metaOptions;
        let timeoutHandle: any = null;
        if (timeoutMs > 0) {
            const ac = new AbortController();
            timeoutHandle = setTimeout(() => ac.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
            if (options.signal) {
                // 串联外部 signal：外部 abort 也触发内部
                if (options.signal.aborted) {
                    clearTimeout(timeoutHandle);
                    throw new Error('aborted');
                }
                options.signal.addEventListener('abort', () => ac.abort(), { once: true });
            }
            attemptOptions = { ...metaOptions, signal: ac.signal };
        }
        try {
            const response = await fetch(url, attemptOptions);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            lastStatus = response.status;

            if (!response.ok) {
                // For retryable status codes, retry before giving up
                if (retryableStatuses.has(response.status) && attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
                    log.warn('HTTP retry', { status: response.status, attempt: attempt + 1, maxRetries, delay });
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                // Non-retryable or last attempt: parse body for error details
                const data = await safeResponseJson(response);
                // If we somehow got valid JSON with error info, wrap it
                const errMsg = data?.error?.message || data?.error || `HTTP ${response.status}`;
                throw new Error(`API Error ${response.status}: ${errMsg}`);
            }

            const data = await safeResponseJson(response);
            if (isChatCompletionUrl(urlStr)) {
                appendDevDebugApiLog({
                    url: urlStr,
                    method: options.method,
                    status: response.status,
                    requestBody: options.body,
                    response: data,
                });
            }
            return data;
        } catch (e: any) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            lastError = e;

            // AbortError（含 timeout）：是否重试看上层策略，先按可重试处理（网络层面）
            const isAbort = e?.name === 'AbortError' || /aborted|timeout/i.test(e?.message || '');

            // Network errors (fetch itself failed) are retryable
            if ((e?.name === 'TypeError' || isAbort) && attempt < maxRetries) {
                const delay = Math.pow(2, attempt) * 1000;
                log.warn(isAbort ? 'Timeout/Abort retry' : 'Network error retry', { attempt: attempt + 1, maxRetries, delay, message: e?.message });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            // For HTML/parse errors on non-ok responses during retry, continue
            if (attempt < maxRetries && e?.message?.includes('API返回了HTML')) {
                const delay = Math.pow(2, attempt) * 1000;
                log.warn('HTML response retry', { attempt: attempt + 1, maxRetries, delay });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            if (isChatCompletionUrl(urlStr)) {
                appendDevDebugApiLog({
                    url: urlStr,
                    method: options.method,
                    status: lastStatus,
                    requestBody: options.body,
                    error: e,
                });
            }
            throw e;
        }
    }

    throw lastError || new Error('API请求失败');
}

/**
 * Safely extract the AI content string from an OpenAI-compatible response.
 * Returns '' instead of crashing when the structure is unexpected.
 *
 * Handles thinking models (DeepSeek-R1, GLM-4.5, QwQ, Qwen3, ...):
 *  - Falls back to `reasoning_content` when `content` is missing/empty
 *  - Strips hidden <think>...</think> chain-of-thought blocks
 */
export function extractContent(data: any): string {
    const msg = data?.choices?.[0]?.message;
    let text: string = msg?.content || '';
    if (!text.trim()) text = msg?.reasoning_content || '';
    // Strip hidden chain-of-thought blocks: <think> / <thinking> / <thought>
    text = text.replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '');
    text = text.replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');
    return text.trim();
}

/**
 * Robustly extract a JSON object from AI-generated text.
 *
 * Handles common Claude format instabilities:
 *  - JSON wrapped in ```json ... ``` code blocks
 *  - Extra prose before/after the JSON ("Here is the result: { ... }")
 *  - Trailing commas in arrays/objects  (common Claude habit)
 *  - Single-quoted strings
 *  - Unquoted keys
 *
 * Returns parsed object on success, null on total failure.
 */
/**
 * Walk through a JSON-ish string and re-escape `"` characters that appear inside
 * string values but weren't escaped by the LLM.
 *
 * Common with Claude when the content quotes a phrase ("还不够好" / "我爱你"等)
 * inside a string value — the inner quotes break JSON.parse because they look
 * like closing delimiters.
 *
 * Heuristic for distinguishing "real closing quote" vs "unescaped inner quote":
 *   A `"` is treated as closing iff the next non-whitespace char is one of
 *   , } ] : end-of-input. Otherwise it's an inner quote and gets \-escaped.
 */
function escapeUnescapedInnerQuotes(text: string): string {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (escaped) { result += ch; escaped = false; continue; }
        if (ch === '\\' && inString) { result += ch; escaped = true; continue; }

        if (ch === '"') {
            if (!inString) {
                inString = true;
                result += ch;
                continue;
            }
            // We're inside a string. Look ahead to decide: closing or inner?
            let j = i + 1;
            while (j < text.length && /[ \t\r\n]/.test(text[j])) j++;
            const next = j < text.length ? text[j] : '';
            // Closing iff next meaningful char is one of , } ] : or EOF
            if (next === '' || next === ',' || next === '}' || next === ']' || next === ':') {
                inString = false;
                result += ch;
            } else {
                // Inner unescaped quote → escape it
                result += '\\"';
            }
            continue;
        }

        result += ch;
    }

    return result;
}

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 * Handles the common case where LLM output is cut off mid-string.
 */
function repairTruncatedJson(text: string): string | null {
    // If it already ends with } or ], it's probably not truncated in a way we can fix
    const trimmed = text.trim();
    if (trimmed.endsWith('}') || trimmed.endsWith(']')) return null; // let other steps handle it

    // Walk through the string tracking state
    let inString = false;
    let escaped = false;
    const stack: ('{' | '[')[] = [];
    let lastKeyValueEnd = 0; // position after last complete key:value pair

    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') stack.push('{');
        else if (ch === '[') stack.push('[');
        else if (ch === '}') { if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop(); }
        else if (ch === ']') { if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop(); }

        // Track positions after complete values at object level
        if (stack.length === 1 && stack[0] === '{' && (ch === ',' || ch === '}')) {
            lastKeyValueEnd = i + 1;
        }
    }

    if (stack.length === 0) return null; // balanced, nothing to repair

    // Strategy: truncate to last complete key:value, then close brackets
    let repaired = '';
    if (lastKeyValueEnd > 0) {
        repaired = trimmed.slice(0, lastKeyValueEnd).replace(/,\s*$/, '');
    } else {
        // No complete key:value found at top level, try closing from current position
        repaired = trimmed;
        // If we're in an open string, close it
        if (inString) repaired += '"';
    }

    // Close remaining open brackets in reverse order
    for (let i = stack.length - 1; i >= 0; i--) {
        repaired += stack[i] === '{' ? '}' : ']';
    }

    return repaired;
}

export function extractJson(raw: string): any | null {
    if (!raw) return null;

    // 1. Strip markdown code fences
    let text = raw
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();

    // 2. Try direct parse first (fast path)
    try { return JSON.parse(text); } catch {}

    // 3. Extract the outermost { ... } or [ ... ]
    const objMatch = text.match(/(\{[\s\S]*\})/);
    const arrMatch = text.match(/(\[[\s\S]*\])/);
    // Prefer whichever starts earlier in the text
    let jsonStr = '';
    if (objMatch && arrMatch) {
        jsonStr = (text.indexOf(objMatch[1]) <= text.indexOf(arrMatch[1]))
            ? objMatch[1] : arrMatch[1];
    } else {
        jsonStr = objMatch?.[1] || arrMatch?.[1] || '';
    }

    if (!jsonStr) return null;

    // 4. Try parsing the extracted substring
    try { return JSON.parse(jsonStr); } catch {}

    // 5. Fix common AI formatting issues and retry
    let fixed = jsonStr
        // Trailing commas: ,} or ,]
        .replace(/,\s*([}\]])/g, '$1')
        // Single quotes → double quotes (careful with apostrophes in text)
        // Only replace quotes that look like JSON string delimiters
        .replace(/'/g, '"')
        // Unquoted keys:  { foo: "bar" } → { "foo": "bar" }
        .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

    try { return JSON.parse(fixed); } catch {}

    // 6. Try to repair unescaped inner quotes (LLM writes naked " inside a string value).
    // Common with Claude when the content quotes a phrase like 「埋一句"我爱你"」
    // — the inner " breaks JSON parsing because they're not \-escaped.
    const innerQuoteFixed = escapeUnescapedInnerQuotes(jsonStr);
    if (innerQuoteFixed && innerQuoteFixed !== jsonStr) {
        try { return JSON.parse(innerQuoteFixed); } catch {}
        try {
            return JSON.parse(innerQuoteFixed
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
        } catch {}
    }

    // 7. Try to repair truncated JSON (LLM hit max_tokens)
    // Find the first { and attempt to close any open strings/brackets
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0) {
        let truncated = text.slice(firstBrace);
        const repaired = repairTruncatedJson(truncated);
        if (repaired) {
            try { return JSON.parse(repaired); } catch {}
            // Also try with common fixes applied
            try {
                return JSON.parse(repaired
                    .replace(/,\s*([}\]])/g, '$1')
                    .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
            } catch {}
            // Also try escaping inner quotes on the truncated-repaired version
            const repairedInnerFixed = escapeUnescapedInnerQuotes(repaired);
            if (repairedInnerFixed !== repaired) {
                try { return JSON.parse(repairedInnerFixed); } catch {}
            }
        }
    }

    // 8. Last resort: try to extract individual JSON objects if there are multiple
    // (AI sometimes outputs two JSON blocks, take the larger one)
    const allObjects = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    if (allObjects.length > 0) {
        // Sort by length, try the longest first (most likely the full response)
        const sorted = allObjects.sort((a, b) => b[0].length - a[0].length);
        for (const m of sorted) {
            try {
                return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
            } catch {}
            try {
                const fixedInner = escapeUnescapedInnerQuotes(m[0]);
                return JSON.parse(fixedInner.replace(/,\s*([}\]])/g, '$1'));
            } catch {}
        }
    }

    // 9. AI sometimes wraps the expected JSON in a wrapper object like {"result": {...}}
    // Try to find the first nested object value and return it
    for (const m of allObjects) {
        try {
            const parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
            const vals = Object.values(parsed);
            if (vals.length === 1 && typeof vals[0] === 'object' && vals[0] !== null) return vals[0];
        } catch {}
    }

    console.error('[extractJson] All attempts failed. Raw:', raw.slice(0, 300));
    return null;
}

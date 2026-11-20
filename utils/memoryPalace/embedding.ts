/**
 * Memory Palace — Embedding 服务
 *
 * 调用 OpenAI 兼容的 Embedding API，将文本转为向量。
 * 支持硅基流动 / 阿里云 / 字节等端点。
 */

import { waitForPalaceRequest, readMaintenanceSettings } from './maintenanceMode';
import type { EmbeddingConfig } from './types';

// ─── 核心 API 调用 ────────────────────────────────────

/**
 * 单条文本向量化 — 返回 Float32Array 节省内存
 */
export async function getEmbedding(text: string, config: EmbeddingConfig): Promise<Float32Array> {
    const results = await getEmbeddings([text], config);
    return results[0];
}

/**
 * 批量文本向量化（一次最多 10 条，超出自动分批）
 * 返回 Float32Array[] — 比 number[][] 节省约 50% 内存
 */
export async function getEmbeddings(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // DashScope（Qwen 官端）的 text-embedding-v3/v4、Qwen3-Embedding 单次 batch
    // 硬上限是 10 条，超过直接 400 InvalidParameter。取 10 作为通用安全值：
    // 硅基流动等 bge 系列用 10 也照常工作，纯按 token 计费不受影响。
    const BATCH_SIZE = 10;
    // 单条防线：bge-m3 等模型单条输入上限 8192 token，服务端不截断、超出
    // 直接 400（硅基流动 code 20015 "The parameter is invalid"）。中文最坏
    // ≈ 1 token/字，4000 字符留足余量。正常聊天/记忆内容远短于此，只有
    // base64 / 超长文档这类异常输入会被截。
    const MAX_ITEM_CHARS = 4000;
    // 批量防线：部分服务商按「整个请求的 token 总量」校验——每条都合法、
    // 合批后加起来超限照样 400（单条「测试连接」正常而检索批量报错的来源
    // 之一）。按批内字符预算切批兜住最坏情况；正常聊天 query 都很短，
    // 一般仍是 1~2 批，行为不变。
    const BATCH_CHAR_BUDGET = 6000;
    // 多批并行发送，避免拆批后变成串行多往返拖慢检索（尤其硅基用户本来一次
    // 就发完）。但限制并发数，防止「重建全部记忆」(上百批) 一次性轰出去触发
    // 服务商限流 / 429。检索通常就 1~2 批 → 全并行 ≈ 1 个往返。
    const MAX_CONCURRENCY = 5;

    const truncatedNotes: string[] = [];
    const safeTexts = texts.map((t, i) => {
        if (t.length <= MAX_ITEM_CHARS) return t;
        truncatedNotes.push(`第${i + 1}条(${t.length}字, 开头"${t.slice(0, 30).replace(/\n/g, ' ')}")`);
        return t.slice(0, MAX_ITEM_CHARS);
    });
    // 正常聊天 query（≤2000 字）和记忆内容（LLM 总结, 几百字）都够不着这条线，
    // 触发说明有异常超长输入混了进来。走 console.error——设置里的日志面板只
    // 捕获 error 通道，保证用户能看到"发生了截断、截的是哪条"。
    if (truncatedNotes.length > 0) {
        console.error(
            `⚠️ [Embedding] ${truncatedNotes.length} 条输入超 ${MAX_ITEM_CHARS} 字上限，已截断出向量（内容本体不受影响，仅按前 ${MAX_ITEM_CHARS} 字建索引）：${truncatedNotes.join('；')}`,
        );
    }

    // 先按顺序切块：条数 ≤ BATCH_SIZE 且批内字符总量 ≤ BATCH_CHAR_BUDGET
    // （顺序很重要：调用方按下标取向量）。单条超预算时独占一批。
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentChars = 0;
    for (const t of safeTexts) {
        if (currentChunk.length > 0
            && (currentChunk.length >= BATCH_SIZE || currentChars + t.length > BATCH_CHAR_BUDGET)) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentChars = 0;
        }
        currentChunk.push(t);
        currentChars += t.length;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const results: Float32Array[] = [];
    // 每次并行跑 MAX_CONCURRENCY 个块；块间顺序、块内顺序都严格保持
    for (let i = 0; i < chunks.length; i += MAX_CONCURRENCY) {
        const window = chunks.slice(i, i + MAX_CONCURRENCY);
        const windowResults = await Promise.all(
            window.map(chunk => callEmbeddingAPI(chunk, config)),
        ).catch(error => {
            let host = '';
            try { host = new URL(config.baseUrl).hostname; } catch { /* nonstandard endpoint */ }
            console.error(/^(?:ai|api)\.siliconflow\.(?:cn|com)$/.test(host) ? '[记忆宫殿·硅基流动]' : '[Embedding]', error);
            throw error;
        });
        // Promise.all 保序：windowResults[j] 对应 window[j]，按序展开
        for (const batchResult of windowResults) {
            results.push(...batchResult.map(v => new Float32Array(v)));
        }
    }

    return results;
}

/**
 * 该模型是否支持自定义 `dimensions` 参数。
 *
 * 硅基流动文档明确：`dimensions` 仅 Qwen/Qwen3-Embedding 系列支持。
 * bge 系列（bge-m3、bge-large 等）输出维度固定，传入 `dimensions` 会被
 * 服务端拒绝（2026-06 起返回 500）。这里只给支持的模型带上该参数。
 */
function modelSupportsDimensions(model: string): boolean {
    return /qwen3?-?embedding/i.test(model);
}

/**
 * 实际调用 Embedding API
 */
async function callEmbeddingAPI(
    input: string[], config: EmbeddingConfig, retryCount: number = 0
): Promise<number[][]> {
    // 自动修正常见 URL 错误
    let baseUrl = config.baseUrl.replace(/\/+$/, '');
    baseUrl = baseUrl.replace('ai.siliconflow.cn', 'api.siliconflow.cn');
    const url = `${baseUrl}/embeddings`;

    const body: Record<string, unknown> = {
        model: config.model,
        input,
        encoding_format: 'float',
    };
    // 仅在模型支持时才发送 dimensions，否则 bge 等固定维度模型会报 500
    if (modelSupportsDimensions(config.model) && config.dimensions) {
        body.dimensions = config.dimensions;
    }

    try {
        await waitForPalaceRequest();
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body), __sullyHandlesFailure: true,
        } as RequestInit);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            // 保留本次尝试的诊断，最终失败时才发出系统提醒。
            console.warn(
                `❌ [Embedding] API ${response.status} (model=${config.model}, batch=${input.length} 条, 各条字符数=[${input.map(s => s.length).join(', ')}])`,
                errorText,
            );
            const err = new Error(`Embedding API error ${response.status}: ${errorText}`) as Error & { status?: number };
            err.status = response.status;
            throw err;
        }

        const data = await response.json();

        if (!data.data || !Array.isArray(data.data)) {
            throw new Error(`Embedding API returned unexpected format: ${JSON.stringify(data).slice(0, 200)}`);
        }

        // OpenAI 格式: data[].embedding[]
        // 按 index 排序确保顺序正确
        const sorted = [...data.data].sort((a: any, b: any) => a.index - b.index);
        return sorted.map((item: any) => item.embedding as number[]);

    } catch (err: any) {
        const status: number | undefined = err?.status;
        // 参数类 4xx 重试同样的请求不会变好；网络错误 / 5xx / 429 才值得重试一次
        const retryable = status === undefined || status >= 500 || status === 429;
        if (retryable && retryCount < 1 && !(status === 429 && readMaintenanceSettings().enabled)) {
            console.warn(`⚡ [Embedding] Retry after error: ${err.message}`);
            await new Promise(r => setTimeout(r, 1000));
            return callEmbeddingAPI(input, config, retryCount + 1);
        }
        // 批量被 400 拒 → 自动降级为逐条向量化：一来绕开「批内 token 总量
        // 超限」类校验（每条单独发就合法），二来能精确定位坏输入是哪条。
        if (status === 400 && input.length > 1) {
            console.warn(`⚡ [Embedding] 批量 ${input.length} 条被 400 拒，自动降级为逐条向量化`);
            const results: number[][] = [];
            for (let i = 0; i < input.length; i++) {
                try {
                    // retryCount=1：单条失败不再重试/再降级，直接进 catch 定位
                    const single = await callEmbeddingAPI([input[i]], config, 1);
                    results.push(single[0]);
                } catch (itemErr: any) {
                    const preview = input[i].slice(0, 80).replace(/\n/g, ' ');
                    throw new Error(
                        `Embedding 逐条降级后第 ${i + 1}/${input.length} 条仍失败（${input[i].length} 字，开头："${preview}"）: ${itemErr.message}`,
                    );
                }
            }
            console.info(
                `⚠️ [Embedding] 上面的批量 400 已自动降级为逐条向量化并全部成功，本次结果完整无缺。若频繁出现，请把日志里 400 那条的完整响应反馈给开发者`,
            );
            return results;
        }
        throw err;
    }
}

// ─── 数学工具 ──────────────────────────────────────────

/**
 * 余弦相似度（Float32Array 优化版）
 *
 * 支持 number[] 和 Float32Array 混合输入。
 * 使用 Float32Array 时内存访问连续，V8 可以利用 SIMD 加速，
 * 在 1024 维向量上比普通 number[] 快 3-5x。
 *
 * 返回值范围 [-1, 1]，越接近 1 越相似
 */
export function cosineSimilarity(
    a: number[] | Float32Array,
    b: number[] | Float32Array,
): number {
    const len = a.length;
    if (len !== b.length) {
        throw new Error(`Vector dimension mismatch: ${len} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // 4x 循环展开 — 减少分支预测开销，配合连续内存布局显著提速
    const limit = len - (len % 4);
    let i = 0;
    for (; i < limit; i += 4) {
        const a0 = a[i], a1 = a[i+1], a2 = a[i+2], a3 = a[i+3];
        const b0 = b[i], b1 = b[i+1], b2 = b[i+2], b3 = b[i+3];
        dotProduct += a0*b0 + a1*b1 + a2*b2 + a3*b3;
        normA += a0*a0 + a1*a1 + a2*a2 + a3*a3;
        normB += b0*b0 + b1*b1 + b2*b2 + b3*b3;
    }
    // 处理余数
    for (; i < len; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
}

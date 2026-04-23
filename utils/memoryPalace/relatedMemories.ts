/**
 * Memory Palace — 取相关记忆的共享 helper
 *
 * 在记忆提取流程中（聊天 buffer 路径 + 旧聊天迁移路径），
 * 我们需要让 LLM 看到一些"已经存在的、可能相关的旧记忆"，
 * 这样它才能：
 *   ① 避免误解隐式指代
 *   ② 输出 relatedTo 标记，把新记忆和旧事件绑成同一个 EventBox
 *
 * 核心策略：**细粒度 per-event 查询**，而不是把大段文本切 3 段 embed。
 * - 迁移路径：把 YAML 列表 (`- 事件X`) 拆成每个 bullet 一个 query
 * - 聊天 buffer 路径：每条 ≥4 字的 user 消息独立 query
 * - 切不出细粒度（非 YAML / 全是短消息）时自动 fallback 到旧的 3 段切法
 *
 * 结果合并：同一记忆取最高相似度；按相似度降序取 top N。
 */

import type { EmbeddingConfig, RemoteVectorConfig } from './types';
import type { RelatedMemoryRef } from './extraction';
import { getEmbeddings } from './embedding';
import { vectorSearch, isRemoteSearchBroken } from './vectorSearch';

/** 从 localStorage 读取远程向量配置，判断本次是走远程还是本地路径
 *
 * 和 pipeline.ts / digestion.ts / db.ts / eventBoxCompression.ts 里的同名 helper
 * 对齐：enabled/initialized 任一为假就当没配置，避免后续调用方忘记手动 gate
 * 时把 enabled:false 的旧配置继续喂给 vectorSearch。 */
function getLocalRemoteConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const config = JSON.parse(raw) as RemoteVectorConfig;
        return (config.enabled && config.initialized) ? config : undefined;
    } catch { return undefined; }
}

export interface FetchRelatedOptions {
    /** 单段查询的相似度阈值，默认 0.40（细粒度 query 下给点宽松度） */
    threshold?: number;
    /** 单段查询取 top 几条，默认 3（太少会错过稍微改写的同事件） */
    perQueryTopK?: number;
    /** 合并后最多返回多少条，默认 15 */
    maxTotal?: number;
    /** 内容截断长度，默认 100 字 */
    contentTruncate?: number;
}

/**
 * 用一组文本片段搜出相关旧记忆。
 *
 * 使用场景：
 * - 缓冲区提取：传每条 ≥4 字的 user 消息
 * - 旧记忆迁移：传拆分后的 bullet 列表
 *
 * @param snippets 用于做向量查询的文本片段（精细粒度，一条事件/一条消息一段）
 */
export async function fetchRelatedMemoriesForExtraction(
    snippets: string[],
    charId: string,
    embeddingConfig: EmbeddingConfig,
    opts: FetchRelatedOptions = {},
): Promise<RelatedMemoryRef[]> {
    const validSnippets = snippets.map(s => s.trim()).filter(s => s.length > 0);
    if (validSnippets.length === 0) return [];

    // 防御性 cap：即便调用方传入一大堆 snippet（比如 bullets 路径 80+），也不要全跑
    // 否则 embedding/vectorSearch/内存都会炸。均匀抽样降到 MAX 条。
    //
    // 历史：曾经死扣到 15。原因是当时远程 Supabase RPC 一旦 CORS 失败会被
    // 每条 query 各踩一次 + 回退本地全量加载，30 条 query 直接撕碎 V8
    // typed-array arena。后来加了会话级远程熔断 + 本地批处理一次加载、
    // 内存串行打分（vectorSearch.ts / relatedMemories.ts 远程熔断分支），
    // 30 条已经不再是问题。
    //
    // 提到 25 是为了换召回质量：被抽样跳过的 bullet 没机会让 LLM 看到
    // "新事件 vs 旧事件"的关联提示，跨 sub-batch 的事件盒合并率会偏低。
    // 25 比 15 多覆盖 67% 的 bullet，每 sub-batch 代价约 +5-10s embedding/打分。
    const HARD_MAX_SNIPPETS = 25;
    let workingSnippets = validSnippets;
    if (validSnippets.length > HARD_MAX_SNIPPETS) {
        const step = validSnippets.length / HARD_MAX_SNIPPETS;
        workingSnippets = [];
        for (let i = 0; i < HARD_MAX_SNIPPETS; i++) {
            workingSnippets.push(validSnippets[Math.floor(i * step)]);
        }
        console.log(`🏰 [RelatedMemories] ${validSnippets.length} 段 snippet 降采样到 ${HARD_MAX_SNIPPETS}（防主线程阻塞）`);
    }

    const threshold = opts.threshold ?? 0.40;
    const perQueryTopK = opts.perQueryTopK ?? 3;
    const maxTotal = opts.maxTotal ?? 15;
    const contentTruncate = opts.contentTruncate ?? 100;

    try {
        // 并行 batch embedding（一次请求拿回所有向量，便宜）
        const vectors = await getEmbeddings(workingSnippets, embeddingConfig);

        const searchResults: Array<{ node: any; similarity: number }[]> = [];

        // 本地 vs 远程分路：本地路径之前每个 query 都独立 getAllByCharId 加载全量向量库，
        // 30 次冗余加载 500+ × 1024 维 Float32Array 瞬间 60MB 分配，GC 跟不上就 OOM 崩 tab。
        // 改成：本地路径**一次性**加载向量 + 节点索引，内存里串行打分；远程路径保留
        // concurrency 4 的 Promise.all（每个 query 是独立 HTTP 无法合并）。
        //
        // ⚠️ 远程熔断：isRemoteSearchBroken() 在首次 Supabase RPC 抛网络错误
        //（CORS / 500 无 CORS 头）后会置 true，从那一刻起本会话直接跳过远程
        // 走"一次性加载、内存里串行打分"的本地快路径 —— 否则迁移批量
        // 查询会每条都踩一次 CORS 失败 + 回退到本地 getAllByCharId，15 次冗余
        // 全量加载能把 tab 冻住好几秒直到 GC。
        const remoteCfg = getLocalRemoteConfig();
        let usingRemote = !!(remoteCfg?.enabled && remoteCfg?.initialized) && !isRemoteSearchBroken();

        // 本地快路径的 state（remote 中途熔断时复用，避免重复加载）
        let localVectors: any[] | null = null;
        let localNodeMap: Map<string, any> | null = null;
        const { cosineSimilarity } = await import('./embedding');
        async function ensureLocalIndex(): Promise<boolean> {
            if (localVectors && localNodeMap) return localVectors.length > 0;
            const { MemoryVectorDB, MemoryNodeDB } = await import('./db');
            localVectors = await MemoryVectorDB.getAllByCharId(charId);
            if (localVectors.length === 0) {
                localNodeMap = new Map();
                return false;
            }
            const allNodes = await MemoryNodeDB.getByCharId(charId);
            localNodeMap = new Map(allNodes.map(n => [n.id, n]));
            return true;
        }
        function localScoreOne(qv: Float32Array): { node: any; similarity: number }[] {
            const scored: { memoryId: string; similarity: number }[] = [];
            for (const ev of localVectors!) {
                const sim = cosineSimilarity(qv, ev.vector);
                if (sim >= threshold) {
                    scored.push({ memoryId: ev.memoryId, similarity: sim });
                }
            }
            scored.sort((a, b) => b.similarity - a.similarity);
            const top = scored.slice(0, perQueryTopK);
            const hits: { node: any; similarity: number }[] = [];
            for (const s of top) {
                const node = localNodeMap!.get(s.memoryId);
                if (node && !node.archived) hits.push({ node, similarity: s.similarity });
            }
            return hits;
        }

        if (usingRemote) {
            const CONCURRENCY = 4;
            let consumed = 0;
            for (let i = 0; i < vectors.length; i += CONCURRENCY) {
                // 每轮开始前重新检查熔断：只要前一批里有任何一条触发 markRemoteBroken，
                // 剩余查询就立刻切到本地快路径，不再踩 CORS。
                if (isRemoteSearchBroken()) {
                    usingRemote = false;
                    break;
                }
                const batch = vectors.slice(i, i + CONCURRENCY);
                const batchResults = await Promise.all(
                    batch.map(vec => vectorSearch(vec, charId, threshold, perQueryTopK, remoteCfg))
                );
                searchResults.push(...batchResults);
                consumed = i + batch.length;
                await new Promise(r => setTimeout(r, 0)); // 让出主线程
            }
            if (!usingRemote) {
                // 远程中途挂了：剩余 query 走本地快路径（不丢弃已拿到的 batchResults）
                const hasLocal = await ensureLocalIndex();
                if (!hasLocal) {
                    // 本地没东西：剩余全补空即可（保持 searchResults 长度与 vectors 对齐不是硬需求，
                    // 因为后面是合并去重，空批次不会引入错误）
                } else {
                    console.log(`🏰 [RelatedMemories] 远程熔断后切本地：剩 ${vectors.length - consumed} 条 query 走本地路径`);
                    for (let qi = consumed; qi < vectors.length; qi++) {
                        searchResults.push(localScoreOne(vectors[qi]));
                        if ((qi + 1) % 5 === 0 && qi < vectors.length - 1) {
                            await new Promise(r => setTimeout(r, 0));
                        }
                    }
                }
            }
        } else {
            // 本地路径：一次性加载，内存里打分
            const hasLocal = await ensureLocalIndex();
            if (!hasLocal) return [];
            for (let qi = 0; qi < vectors.length; qi++) {
                searchResults.push(localScoreOne(vectors[qi]));
                // 每 5 条 query 让一下主线程
                if ((qi + 1) % 5 === 0 && qi < vectors.length - 1) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }
        }

        // 合并去重：同一记忆保留最高相似度
        const seen = new Map<string, { node: any; similarity: number }>();
        for (const results of searchResults) {
            for (const r of results) {
                const existing = seen.get(r.node.id);
                if (!existing || r.similarity > existing.similarity) {
                    seen.set(r.node.id, r);
                }
            }
        }

        // 按相似度降序
        const related = [...seen.values()]
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, maxTotal);

        return related.map(r => ({
            id: r.node.id,
            room: r.node.room,
            content: (r.node.content || '').slice(0, contentTruncate),
        }));
    } catch (e: any) {
        console.warn(`🏰 [RelatedMemories] 检索失败（不影响主流程）: ${e?.message || e}`);
        return [];
    }
}

// ─── 细粒度拆分：YAML bullets（迁移路径用） ──────────────

/**
 * 把 YAML 列表格式的总结文本拆成每个 bullet 一个片段。
 *
 * 典型输入：
 *   - 今天吃了蛋糕，很开心
 *   - 晚上和妈妈吵架了
 *   - 决定明天去跑步
 * 输出：[
 *   "今天吃了蛋糕，很开心",
 *   "晚上和妈妈吵架了",
 *   "决定明天去跑步",
 * ]
 *
 * 兼容 "- " / "-  " / "- \t" 以及以连字符开头的多行内容（仅切行首的 -）。
 *
 * @returns bullet 片段数组；如果切不出 ≥ 2 条，返回空数组表示"不是列表格式"
 */
/**
 * 支持的 bullet 字符：ASCII hyphen、Chinese 全角破折号 －、em dash —、bullet
 * dot •、middle dot ·、asterisk *。LLM / Markdown 渲染器可能产出任一种，
 * 只认 ASCII `-` 会漏掉很多真实列表。
 */
const BULLET_LEAD_RE = /[-－—•·*]/;
const BULLET_SPLIT_RE = /\n(?=[-－—•·*][\s\u3000])/;      // 换行后紧跟任一 bullet 字符 + 空白
const BULLET_STRIP_RE = /^[-－—•·*][\s\u3000]+/;           // 行首 bullet 字符 + 空白

export function splitYamlBullets(text: string): string[] {
    if (!text) return [];
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    // 若整段根本没有任一 bullet 字符 → 必然不是列表
    if (!BULLET_LEAD_RE.test(normalized)) return [];
    // 按"换行 + 行首 bullet"切
    const parts = normalized.split(BULLET_SPLIT_RE);
    const bullets: string[] = [];
    for (const part of parts) {
        const s = part.replace(BULLET_STRIP_RE, '').trim();
        if (s.length >= 4) bullets.push(s);
    }
    // 至少 2 条才算有效列表
    return bullets.length >= 2 ? bullets : [];
}

/**
 * 给迁移路径用的细粒度拆分：
 * 把一批 daily logs 拍平成 bullet 列表。
 * 每条 bullet 前缀上日期，方便 embedding 时保留时间线索。
 *
 * 如果无法拆出 bullets（有些用户可能改过归档模板），返回空数组；
 * 调用方应 fallback 到传统的 3 段切法。
 */
export function splitLogsToBullets(
    logs: { date: string; summary: string }[],
): string[] {
    const bullets: string[] = [];
    let usedBulletFormat = 0;
    for (const log of logs) {
        const items = splitYamlBullets(log.summary);
        if (items.length > 0) {
            usedBulletFormat++;
            for (const it of items) {
                bullets.push(`[${log.date}] ${it}`);
            }
        } else {
            // 整条日志作为一个片段兜底
            if (log.summary.trim().length >= 4) {
                bullets.push(`[${log.date}] ${log.summary.trim().slice(0, 300)}`);
            }
        }
    }
    // 只有"大部分日志都是 bullet 格式"才认为这个策略有效
    const ok = usedBulletFormat >= Math.max(1, Math.floor(logs.length * 0.3));
    return ok ? bullets : [];
}

// ─── 细粒度拆分：per-message（buffer 路径用） ─────────────

/**
 * Buffer 路径：每条 ≥ MIN_LEN 字的 user 消息独立作为 query。
 * 短语气词/纯标点/URL 过滤掉。
 *
 * 如果可用消息数 < 2，返回空数组，让调用方 fallback 到传统 3 段切法。
 */
export function splitMessagesToSpikes(
    messages: { role: string; content: string }[],
    minLen: number = 4,
    maxPerMsg: number = 300,
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
        if (m.role !== 'user') continue;
        let text = (m.content || '').trim();
        if (!text) continue;
        // 剥离 URL（embedding 里是随机噪声）
        text = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
        // 有意义字符数判断
        const meaningful = text.replace(/[\s\p{P}]/gu, '');
        if (meaningful.length < minLen) continue;
        const key = text.slice(0, 100);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text.slice(0, maxPerMsg));
    }
    return out.length >= 2 ? out : [];
}

// ─── 兜底：传统 3 段切法（保留做 fallback） ──────────────

/**
 * 从一段消息列表中切出头/中/尾 3 段文本片段。
 * 兜底：当 per-message / per-bullet 拆分失败时用。
 */
export function sampleSnippetsFromMessages(
    messages: { content: string }[],
    sampleSize: number = 5,
    snippetCharLimit: number = 300,
): string[] {
    const len = messages.length;
    if (len === 0) return [];

    const ranges = [
        messages.slice(0, sampleSize),
        messages.slice(
            Math.max(0, Math.floor(len / 2) - Math.floor(sampleSize / 2)),
            Math.floor(len / 2) + Math.ceil(sampleSize / 2),
        ),
        messages.slice(Math.max(0, len - sampleSize)),
    ];

    const snippets: string[] = [];
    for (const range of ranges) {
        const text = range.map(m => m.content).join('\n').slice(0, snippetCharLimit);
        if (text.trim()) snippets.push(text);
    }
    return snippets;
}

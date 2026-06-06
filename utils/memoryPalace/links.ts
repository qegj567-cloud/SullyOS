/**
 * Memory Palace — 关联网络 (Memory Links)
 *
 * 记忆之间的五种连接：temporal, emotional, causal, person, metaphor。
 * - temporal / emotional: 自动规则建立
 * - causal / person / metaphor: LLM 判断（每次封盒时对新记忆 vs Top-5 相似旧记忆做一次批量判断）
 */

import type { MemoryNode, MemoryLink, LinkType } from './types';
import type { LightLLMConfig } from './pipeline';
import { MemoryLinkDB } from './db';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';
import { getEmotionVA, emotionDistance } from './emotionSpace';

const TEMPORAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 小时
const CO_ACTIVATION_INCREMENT = 0.05;
const MAX_STRENGTH = 1.0;

// ─── Emotional link 阈值（Russell 情感空间） ─────────
/** 情感距离 < 此值才建 emotional 边 */
const EMOTIONAL_LINK_DIST = 0.35;
/** 双方 (v,a) 模长都 < 此值 视为"情绪太弱"，不建边（避免一堆 neutral 节点互链） */
const EMOTIONAL_MIN_MAGNITUDE = 0.2;

/** 判断一条新-旧节点对是否应建 emotional 边，以及该给多大 strength */
function emotionalLinkStrength(a: MemoryNode, b: MemoryNode): number {
    const va = getEmotionVA(a);
    const vb = getEmotionVA(b);
    const magA = Math.hypot(va.v, va.a);
    const magB = Math.hypot(vb.v, vb.a);
    if (magA < EMOTIONAL_MIN_MAGNITUDE || magB < EMOTIONAL_MIN_MAGNITUDE) return 0;
    const dist = emotionDistance(va, vb);
    if (dist >= EMOTIONAL_LINK_DIST) return 0;
    // 距离 0 → 0.55；距离 = 阈值 → 0.25。线性。
    return 0.25 + (0.55 - 0.25) * (1 - dist / EMOTIONAL_LINK_DIST);
}

function generateId(): string {
    return `ml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── LLM 关联判断 ────────────────────────────────────

/**
 * 一次 LLM 调用，批量判断所有新记忆和候选旧记忆之间的深层关联
 */
async function batchClassifyDeepLinks(
    newNodes: MemoryNode[],
    candidates: MemoryNode[],
    llmConfig: LightLLMConfig,
): Promise<{ sourceId: string; targetId: string; type: LinkType; strength: number }[]> {
    if (newNodes.length === 0 || candidates.length === 0) return [];

    const newList = newNodes
        .map((n, i) => `[N${i}] (${n.room}, ${n.mood}): ${n.content.slice(0, 80)}`)
        .join('\n');

    const oldList = candidates
        .map((c, i) => `[O${i}] (${c.room}, ${c.mood}): ${c.content.slice(0, 80)}`)
        .join('\n');

    const prompt = `你是一个记忆关联分析器。给你一组新记忆 [N*] 和一组旧记忆 [O*]，找出它们之间的深层关联。

三种关联类型：
- causal: 因果关系（一件事导致了另一件事）
- person: 提到了同一个人
- metaphor: 隐喻/类比（不同事件但有相似的情感模式）

只输出存在关联的配对。严格 JSON 数组格式：
[{"from": "N0", "to": "O2", "type": "person", "strength": 0.6}]

strength 范围 0.3-0.8。没有关联返回 []。只输出 JSON。`;

    const userMsg = `新记忆：\n${newList}\n\n旧记忆：\n${oldList}`;

    try {
        const data = await safeFetchJson(
            `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${llmConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: llmConfig.model,
                    messages: [
                        { role: 'system', content: prompt },
                        { role: 'user', content: userMsg },
                    ],
                    temperature: 0.2,
                    max_tokens: 800,
                    stream: false,
                }),
            },
            2, 0, { appName: '记忆宫殿', purpose: '记忆关联' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);
        const validTypes: LinkType[] = ['causal', 'person', 'metaphor'];

        return parsed
            .filter(item => {
                const fromIdx = parseInt(item.from?.replace('N', '') || '-1', 10);
                const toIdx = parseInt(item.to?.replace('O', '') || '-1', 10);
                return fromIdx >= 0 && fromIdx < newNodes.length &&
                       toIdx >= 0 && toIdx < candidates.length &&
                       validTypes.includes(item.type as LinkType);
            })
            .map(item => ({
                sourceId: newNodes[parseInt(item.from.replace('N', ''), 10)].id,
                targetId: candidates[parseInt(item.to.replace('O', ''), 10)].id,
                type: item.type as LinkType,
                strength: Math.max(0.3, Math.min(0.8, item.strength || 0.5)),
            }));

    } catch (err: any) {
        console.warn('⚡ [Links] Batch deep link classification failed:', err.message);
        return [];
    }
}

// ─── 主函数 ──────────────────────────────────────────

/**
 * 为新记忆节点建立关联
 *
 * 三层：
 * 1. temporal — 24h 内 / 同 box 自动建链
 * 2. emotional — 相同 mood 自动建链
 * 3. causal / person / metaphor — LLM 判断（如果提供了 llmConfig）
 *
 * @param llmConfig 可选。传入则启用 LLM 深层关联判断。
 */
export async function buildLinks(
    newNodes: MemoryNode[],
    existingNodes: MemoryNode[],
    llmConfig?: LightLLMConfig | null,
): Promise<MemoryLink[]> {
    const links: MemoryLink[] = [];
    const linkSet = new Set<string>();

    for (const newNode of newNodes) {
        // ─── 自动规则关联 ─────────────────────────

        for (const existing of existingNodes) {
            if (newNode.id === existing.id) continue;

            // 1. Temporal: 24h 内创建
            if (Math.abs(newNode.createdAt - existing.createdAt) < TEMPORAL_WINDOW_MS) {
                const key = makeKey(newNode.id, existing.id, 'temporal');
                if (!linkSet.has(key)) {
                    links.push(createLink(newNode.id, existing.id, 'temporal', 0.3));
                    linkSet.add(key);
                }
            }

            // 2. Emotional: Russell 情感空间距离 < 0.35，strength 随距离线性缩放
            const emoStrength = emotionalLinkStrength(newNode, existing);
            if (emoStrength > 0) {
                const key = makeKey(newNode.id, existing.id, 'emotional');
                if (!linkSet.has(key)) {
                    links.push(createLink(newNode.id, existing.id, 'emotional', emoStrength));
                    linkSet.add(key);
                }
            }
        }

        // 同批次内的节点
        for (const other of newNodes) {
            if (newNode.id === other.id) continue;

            if (newNode.boxId === other.boxId) {
                const key = makeKey(newNode.id, other.id, 'temporal');
                if (!linkSet.has(key)) {
                    links.push(createLink(newNode.id, other.id, 'temporal', 0.5));
                    linkSet.add(key);
                }
            }

            const emoStrength = emotionalLinkStrength(newNode, other);
            if (emoStrength > 0) {
                const key = makeKey(newNode.id, other.id, 'emotional');
                if (!linkSet.has(key)) {
                    links.push(createLink(newNode.id, other.id, 'emotional', emoStrength));
                    linkSet.add(key);
                }
            }
        }

    }

    // ─── LLM 深层关联（causal / person / metaphor）── 一次调用处理所有新节点

    if (llmConfig && existingNodes.length > 0 && newNodes.length > 0) {
        const candidates = existingNodes
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 8); // 最近 8 条旧记忆作为候选

        if (candidates.length > 0) {
            const deepLinks = await batchClassifyDeepLinks(newNodes, candidates, llmConfig);

            for (const dl of deepLinks) {
                const key = makeKey(dl.sourceId, dl.targetId, dl.type);
                if (!linkSet.has(key)) {
                    links.push(createLink(dl.sourceId, dl.targetId, dl.type, dl.strength));
                    linkSet.add(key);
                }
            }
        }
    }

    // 批量保存
    if (links.length > 0) {
        await MemoryLinkDB.saveMany(links);
        console.log(`🔗 [Links] Created ${links.length} links (temporal/emotional: auto, causal/person/metaphor: ${llmConfig ? 'LLM' : 'skipped'})`);
    }

    return links;
}

/**
 * 共同激活：当多条记忆同时被检索命中时，加强它们之间的关联
 */
export async function strengthenCoActivated(nodeIds: string[]): Promise<void> {
    if (nodeIds.length < 2) return;

    for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
            const links = await MemoryLinkDB.getBySourceId(nodeIds[i]);
            const existingLink = links.find(l => l.targetId === nodeIds[j]);

            if (existingLink) {
                existingLink.strength = Math.min(
                    MAX_STRENGTH,
                    existingLink.strength + CO_ACTIVATION_INCREMENT
                );
                await MemoryLinkDB.save(existingLink);
            }
            else {
                const reverseLinks = await MemoryLinkDB.getBySourceId(nodeIds[j]);
                const reverseLink = reverseLinks.find(l => l.targetId === nodeIds[i]);
                if (reverseLink) {
                    reverseLink.strength = Math.min(
                        MAX_STRENGTH,
                        reverseLink.strength + CO_ACTIVATION_INCREMENT
                    );
                    await MemoryLinkDB.save(reverseLink);
                }
                else {
                    const link = createLink(nodeIds[i], nodeIds[j], 'temporal', CO_ACTIVATION_INCREMENT);
                    await MemoryLinkDB.save(link);
                }
            }
        }
    }
}

// ─── 工具函数 ──────────────────────────────────────────

function createLink(sourceId: string, targetId: string, type: LinkType, strength: number): MemoryLink {
    return {
        id: generateId(),
        sourceId,
        targetId,
        type,
        strength,
    };
}

/** 生成去重 key（确保 A-B 和 B-A 视为同一对） */
function makeKey(id1: string, id2: string, type: string): string {
    const [a, b] = id1 < id2 ? [id1, id2] : [id2, id1];
    return `${a}-${b}-${type}`;
}

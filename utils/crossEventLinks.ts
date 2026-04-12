/**
 * 跨事件关联系统 (Cross-Event Links)
 *
 * 三级升级系统：
 * - L1 观察：单次发现，仅存内存，session 结束清除
 * - L2 假说：2-3 次独立验证，持久化到 IndexedDB
 * - L3 稳定认知：5+ 次验证，同步到 UserCognitiveModel
 */

import {
    saveCrossEventLink,
    getCrossEventLinks as dbGetLinks,
    deleteCrossEventLink,
} from './emotionStorage';
import type { CrossEventLink } from '../types';

// ── Promotion Rules ──

const PROMOTION_RULES = {
    L1_to_L2: { minObservations: 2, minConfidence: 0.5 },
    L2_to_L3: { minObservations: 5, minConfidence: 0.7 },
    L3_demotion_staleDays: 60,
};

// ── In-memory L1 store (per character) ──

const _l1Store = new Map<string, CrossEventLink[]>();

function getL1Links(charId: string): CrossEventLink[] {
    return _l1Store.get(charId) ?? [];
}

// ── Core Logic ──

/**
 * 接收海马体输出的新关联，处理升级逻辑
 */
export async function processNewLinks(
    charId: string,
    newLinks: Array<{
        memoryA: string;
        memoryB: string;
        pattern: string;
        confidence: number;
    }>
): Promise<{ promoted: CrossEventLink[]; created: CrossEventLink[] }> {
    const now = Date.now();
    const promoted: CrossEventLink[] = [];
    const created: CrossEventLink[] = [];

    // Load existing L2/L3 from DB
    const existing = await dbGetLinks(charId);
    const l1s = getL1Links(charId);

    for (const raw of newLinks) {
        // Check if this pattern already exists at any level
        const existingLink = findMatchingLink(raw.pattern, [...existing, ...l1s]);

        if (existingLink) {
            // Reinforce existing link
            existingLink.observationCount += 1;
            existingLink.lastSeen = now;
            existingLink.confidence = Math.min(1.0,
                (existingLink.confidence + raw.confidence) / 2 + 0.05
            );

            // Check for promotion
            const newLevel = checkPromotion(existingLink);
            if (newLevel && newLevel !== existingLink.level) {
                existingLink.level = newLevel;
                existingLink.promotedAt = now;
                promoted.push(existingLink);
            }

            // Persist if L2 or L3
            if (existingLink.level !== 'L1_observation') {
                await saveCrossEventLink(existingLink);
            }
        } else {
            // New observation — start as L1
            const link: CrossEventLink = {
                id: `cel_${now}_${Math.random().toString(36).slice(2, 8)}`,
                charId,
                memoryA: raw.memoryA,
                memoryB: raw.memoryB,
                pattern: raw.pattern,
                confidence: raw.confidence,
                level: 'L1_observation',
                observationCount: 1,
                firstSeen: now,
                lastSeen: now,
            };

            // Add to L1 store
            if (!_l1Store.has(charId)) _l1Store.set(charId, []);
            _l1Store.get(charId)!.push(link);
            created.push(link);
        }
    }

    return { promoted, created };
}

/**
 * 获取角色所有活跃关联（L2 + L3 从 DB，L1 从内存）
 */
export async function getActiveLinks(charId: string): Promise<CrossEventLink[]> {
    const persisted = await dbGetLinks(charId);
    const l1s = getL1Links(charId);
    return [...persisted, ...l1s];
}

/**
 * 获取指定级别的关联
 */
export async function getLinksByLevel(
    charId: string,
    level: CrossEventLink['level']
): Promise<CrossEventLink[]> {
    if (level === 'L1_observation') {
        return getL1Links(charId);
    }
    const all = await dbGetLinks(charId);
    return all.filter(l => l.level === level);
}

/**
 * 清理过期的 L3 链接（超过 staleDays 没被验证 → 降级回 L2）
 */
export async function demoteStalL3Links(charId: string): Promise<CrossEventLink[]> {
    const cutoff = Date.now() - PROMOTION_RULES.L3_demotion_staleDays * 24 * 3600 * 1000;
    const all = await dbGetLinks(charId);
    const demoted: CrossEventLink[] = [];

    for (const link of all) {
        if (link.level === 'L3_stable' && link.lastSeen < cutoff) {
            link.level = 'L2_hypothesis';
            link.promotedAt = Date.now();
            await saveCrossEventLink(link);
            demoted.push(link);
        }
    }

    return demoted;
}

/**
 * 清除 session 结束时的 L1 数据
 */
export function clearL1Links(charId: string): void {
    _l1Store.delete(charId);
}

/**
 * 格式化关联为 prompt 注入文本
 */
export function formatLinksForPrompt(links: CrossEventLink[]): string | null {
    // Only include L2 and L3
    const significant = links.filter(l => l.level !== 'L1_observation');
    if (significant.length === 0) return null;

    const lines = significant.map(l => {
        const level = l.level === 'L3_stable' ? '确定' : '初步';
        const confidence = Math.round(l.confidence * 100);
        return `- [${level}/${confidence}%] ${l.pattern}（验证${l.observationCount}次）`;
    });

    return `### 你观察到的规律\n${lines.join('\n')}`;
}

// ── Helpers ──

function findMatchingLink(
    pattern: string,
    links: CrossEventLink[]
): CrossEventLink | undefined {
    // Simple heuristic: pattern text similarity
    // In production, could use embedding similarity
    const normalized = pattern.toLowerCase().trim();
    return links.find(l => {
        const existingNorm = l.pattern.toLowerCase().trim();
        // Check for high overlap (> 60% shared characters)
        const overlap = computeOverlap(normalized, existingNorm);
        return overlap > 0.6;
    });
}

function computeOverlap(a: string, b: string): number {
    if (a.length === 0 || b.length === 0) return 0;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    let matches = 0;
    for (const char of shorter) {
        if (longer.includes(char)) matches++;
    }
    return matches / shorter.length;
}

function checkPromotion(link: CrossEventLink): CrossEventLink['level'] | null {
    if (link.level === 'L1_observation') {
        if (link.observationCount >= PROMOTION_RULES.L1_to_L2.minObservations &&
            link.confidence >= PROMOTION_RULES.L1_to_L2.minConfidence) {
            return 'L2_hypothesis';
        }
    }
    if (link.level === 'L2_hypothesis') {
        if (link.observationCount >= PROMOTION_RULES.L2_to_L3.minObservations &&
            link.confidence >= PROMOTION_RULES.L2_to_L3.minConfidence) {
            return 'L3_stable';
        }
    }
    return null;
}

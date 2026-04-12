/**
 * 未解决张力系统 (Tensions)
 *
 * 管理角色内心尚未理解或消解的困惑
 * 生命周期：创建 → 活跃 → 消解中 → 已消解 / 休眠
 */

import { saveTension, getTensions as dbGetTensions, deleteTension } from './emotionStorage';
import type { Tension } from '../types';

// ── Constants ──

const DORMANT_THRESHOLD_DAYS = 30;
const DORMANT_DECAY_RATE = 0.1; // per day after threshold

// ── Core Operations ──

/**
 * 创建新张力
 */
export async function createTension(
    charId: string,
    description: string,
    relatedMemories: string[],
    intensity: number = 0.5
): Promise<Tension> {
    const now = Date.now();
    const tension: Tension = {
        id: `tension_${now}_${Math.random().toString(36).slice(2, 8)}`,
        charId,
        description,
        relatedMemories,
        intensity: Math.max(0, Math.min(1, intensity)),
        createdAt: now,
        lastRevisited: now,
        revisitCount: 0,
        status: 'active',
        resolutionAttempts: [],
    };

    await saveTension(tension);
    return tension;
}

/**
 * 重访张力（相关话题再次出现时调用）
 */
export async function revisitTension(
    tensionId: string,
    charId: string,
    updateDescription?: string,
    resolutionAttempt?: string
): Promise<Tension | null> {
    const tensions = await dbGetTensions(charId);
    const tension = tensions.find(t => t.id === tensionId);
    if (!tension) return null;

    tension.lastRevisited = Date.now();
    tension.revisitCount += 1;

    if (updateDescription) {
        tension.description = updateDescription;
    }

    if (resolutionAttempt) {
        tension.resolutionAttempts.push(resolutionAttempt);
        // If character is attempting to resolve, transition to 'resolving'
        if (tension.status === 'active') {
            tension.status = 'resolving';
        }
    }

    // Revisiting may increase intensity slightly
    tension.intensity = Math.min(1.0, tension.intensity + 0.05);

    await saveTension(tension);
    return tension;
}

/**
 * 消解张力
 */
export async function resolveTension(tensionId: string, charId: string): Promise<void> {
    const tensions = await dbGetTensions(charId);
    const tension = tensions.find(t => t.id === tensionId);
    if (!tension) return;

    tension.status = 'resolved';
    tension.lastRevisited = Date.now();
    await saveTension(tension);
}

/**
 * 获取活跃张力（active + resolving），应用休眠检测
 */
export async function getActiveTensions(charId: string): Promise<Tension[]> {
    const tensions = await dbGetTensions(charId);
    const now = Date.now();
    const active: Tension[] = [];

    for (const t of tensions) {
        if (t.status === 'resolved') continue;

        // Check dormancy
        const daysSinceRevisit = (now - t.lastRevisited) / (24 * 3600 * 1000);
        if (daysSinceRevisit > DORMANT_THRESHOLD_DAYS && t.status !== 'dormant') {
            t.status = 'dormant';
            // Decay intensity
            const daysOverThreshold = daysSinceRevisit - DORMANT_THRESHOLD_DAYS;
            t.intensity = Math.max(0, t.intensity - DORMANT_DECAY_RATE * daysOverThreshold);
            await saveTension(t);
        }

        if (t.status === 'dormant') continue;

        active.push(t);
    }

    return active;
}

/**
 * 获取所有张力（含 resolved 和 dormant，用于 UI）
 */
export async function getAllTensions(charId: string): Promise<Tension[]> {
    return dbGetTensions(charId);
}

/**
 * 处理海马体输出的新张力
 */
export async function processNewTensions(
    charId: string,
    rawTensions: Array<{
        description: string;
        relatedMemories: string[];
        intensity: number;
    }>
): Promise<Tension[]> {
    const existing = await dbGetTensions(charId);
    const created: Tension[] = [];

    for (const raw of rawTensions) {
        // Check if similar tension already exists
        const similar = existing.find(t =>
            t.status !== 'resolved' &&
            computeTextSimilarity(t.description, raw.description) > 0.5
        );

        if (similar) {
            // Revisit existing tension
            await revisitTension(similar.id, charId, raw.description);
        } else {
            // Create new tension
            const tension = await createTension(charId, raw.description, raw.relatedMemories, raw.intensity);
            created.push(tension);
        }
    }

    return created;
}

/**
 * 格式化张力为 prompt 注入文本
 */
export function formatTensionsForPrompt(tensions: Tension[]): string | null {
    const active = tensions.filter(t => t.status === 'active' || t.status === 'resolving');
    if (active.length === 0) return null;

    const lines = active.map(t => {
        const intensity = t.intensity > 0.6 ? '强烈' : t.intensity > 0.3 ? '持续' : '隐约';
        const status = t.status === 'resolving' ? '（正在试图理解）' : '';
        return `- [${intensity}] ${t.description}${status}（已回想${t.revisitCount}次）`;
    });

    return `### 你内心的困惑\n以下是你尚未完全理解的事情，它们时不时会浮现在你脑海中：\n${lines.join('\n')}`;
}

// ── Helpers ──

function computeTextSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    const setA = new Set(a.split(''));
    const setB = new Set(b.split(''));
    let intersection = 0;
    for (const char of setA) {
        if (setB.has(char)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

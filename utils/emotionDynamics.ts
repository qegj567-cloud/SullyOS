/**
 * 情绪动力学引擎 (Emotion Dynamics Engine)
 *
 * 三层情绪栈 + 真实时间衰减 + 交叉影响 + 容量限制
 * 纯本地计算，零 API 依赖
 */

import { getOntologyEntry, getPrimaryLabel } from './emotionOntology';
import type { EmotionState, EmotionLayer, EmotionalTag } from '../types';

// ── Constants ──

const LAYER_CAPACITY: Record<EmotionLayer['depth'], number> = {
    surface: 3,
    middle: 4,
    deep: 5,
};

/** 深层负面情绪压制表层正面情绪的最大比例 */
const CROSS_LAYER_SUPPRESSION_MAX = 0.30;

/** 情绪低于此强度自动移除 */
const MIN_INTENSITY = 0.05;

// ── Core Engine ──

export class EmotionDynamicsEngine {
    private state: EmotionState;

    constructor(initialState?: EmotionState) {
        this.state = initialState ?? createEmptyState();
    }

    /**
     * 核心更新方法
     * 1. applyDecay → 2. removeExpired → 3. mergeNewTags → 4. applyCrossInfluence → 5. enforceCapacity
     */
    update(newTags: EmotionalTag[], currentTime: number = Date.now()): EmotionState {
        // 1. Apply time-based decay
        this.applyDecay(currentTime);

        // 2. Remove expired layers
        this.removeExpired();

        // 3. Merge new emotional tags
        for (const tag of newTags) {
            this.mergeTag(tag, currentTime);
        }

        // 4. Apply cross-layer influence
        this.applyCrossInfluence();

        // 5. Enforce capacity limits
        this.enforceCapacity();

        // Update timestamp
        this.state.lastUpdatedAt = currentTime;

        return { ...this.state };
    }

    /**
     * 生成自然语言描述（给 prompt 注入用）
     */
    describe(): string {
        const parts: string[] = [];

        const deepLayers = this.getLayersByDepth('deep').filter(l => l.intensity > 0.1);
        const middleLayers = this.getLayersByDepth('middle').filter(l => l.intensity > 0.1);
        const surfaceLayers = this.getLayersByDepth('surface').filter(l => l.intensity > 0.1);

        if (deepLayers.length > 0) {
            const desc = deepLayers.map(l => {
                const label = getPrimaryLabel(l.ontologyId);
                const strength = l.intensity > 0.6 ? '强烈的' : l.intensity > 0.3 ? '持续的' : '隐约的';
                return `${strength}${label}（来源：${l.sourceContext || '未知'}）`;
            }).join('、');
            parts.push(`【深层情绪底色】${desc}`);
        }

        if (middleLayers.length > 0) {
            const desc = middleLayers.map(l => {
                const label = getPrimaryLabel(l.ontologyId);
                return `${label}(${Math.round(l.intensity * 100)}%)`;
            }).join('、');
            parts.push(`【中层情绪】${desc}`);
        }

        if (surfaceLayers.length > 0) {
            const desc = surfaceLayers.map(l => {
                const label = getPrimaryLabel(l.ontologyId);
                const nuance = l.nuance ? `（${l.nuance}）` : '';
                return `${label}${nuance}`;
            }).join('、');
            parts.push(`【当前表层感受】${desc}`);
        }

        if (parts.length === 0) {
            parts.push('【情绪状态】平静，没有特别强烈的情绪波动');
        }

        return parts.join('\n');
    }

    /**
     * 获取最强 N 个情绪（跨所有层）
     */
    getTopEmotions(n: number): EmotionLayer[] {
        return [...this.state.layers]
            .sort((a, b) => b.intensity - a.intensity)
            .slice(0, n);
    }

    /**
     * 获取当前最高情绪强度
     */
    getMaxIntensity(): number {
        if (this.state.layers.length === 0) return 0;
        return Math.max(...this.state.layers.map(l => l.intensity));
    }

    /**
     * 模拟衰减 N 小时后的状态（debug 用，不修改实际状态）
     */
    simulateDecay(hours: number): EmotionState {
        const clone = new EmotionDynamicsEngine(JSON.parse(JSON.stringify(this.state)));
        const futureTime = this.state.lastUpdatedAt + hours * 3600 * 1000;
        clone.applyDecay(futureTime);
        clone.removeExpired();
        return clone.getState();
    }

    /**
     * 获取当前状态（用于序列化）
     */
    getState(): EmotionState {
        return { ...this.state };
    }

    /**
     * 获取可视化数据
     */
    getVisualizationData(): {
        surface: EmotionLayer[];
        middle: EmotionLayer[];
        deep: EmotionLayer[];
        overallValence: number;
        overallArousal: number;
    } {
        const surface = this.getLayersByDepth('surface');
        const middle = this.getLayersByDepth('middle');
        const deep = this.getLayersByDepth('deep');

        // Weighted average of valence/arousal
        const allLayers = this.state.layers;
        const totalWeight = allLayers.reduce((s, l) => s + l.intensity, 0);

        let overallValence = 0;
        let overallArousal = 0;
        if (totalWeight > 0) {
            for (const l of allLayers) {
                const entry = getOntologyEntry(l.ontologyId);
                if (entry) {
                    overallValence += entry.defaultValence * l.intensity;
                    overallArousal += entry.defaultArousal * l.intensity;
                }
            }
            overallValence /= totalWeight;
            overallArousal /= totalWeight;
        }

        return { surface, middle, deep, overallValence, overallArousal };
    }

    // ── Private Methods ──

    private applyDecay(currentTime: number) {
        const elapsed = currentTime - this.state.lastUpdatedAt;
        if (elapsed <= 0) return;

        const hoursElapsed = elapsed / (3600 * 1000);

        for (const layer of this.state.layers) {
            const entry = getOntologyEntry(layer.ontologyId);
            const config = entry?.decayConfig ?? { rate: 0.1, function: 'exponential' as const };

            layer.intensity = applyDecayFunction(
                layer.intensity,
                hoursElapsed,
                config.rate,
                config.function,
                config.plateauHours
            );
        }
    }

    private removeExpired() {
        this.state.layers = this.state.layers.filter(l => l.intensity >= MIN_INTENSITY);
    }

    private mergeTag(tag: EmotionalTag, currentTime: number) {
        // Find existing layer with same ontologyId and depth
        const existing = this.state.layers.find(
            l => l.ontologyId === tag.ontologyId && l.depth === tag.depth
        );

        if (existing) {
            // Merge: additive intensity (capped at 1.0), update timestamp
            existing.intensity = Math.min(1.0, existing.intensity + tag.intensity * 0.6);
            existing.sourceTimestamp = currentTime;
            existing.nuance = tag.nuance || existing.nuance;
            existing.sourceContext = tag.sourceContext || existing.sourceContext;
        } else {
            // New layer
            this.state.layers.push({
                id: `el_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                ontologyId: tag.ontologyId,
                depth: tag.depth,
                intensity: Math.min(1.0, tag.intensity),
                nuance: tag.nuance,
                sourceTimestamp: currentTime,
                sourceContext: tag.sourceContext,
            });
        }
    }

    private applyCrossInfluence() {
        const deepLayers = this.getLayersByDepth('deep');
        const surfaceLayers = this.getLayersByDepth('surface');

        // Deep negative emotions suppress surface positive emotions
        const deepNegativeTotal = deepLayers
            .filter(l => {
                const entry = getOntologyEntry(l.ontologyId);
                return entry && entry.defaultValence < -0.3;
            })
            .reduce((sum, l) => sum + l.intensity, 0);

        if (deepNegativeTotal > 0.3) {
            const suppressionFactor = Math.min(
                CROSS_LAYER_SUPPRESSION_MAX,
                (deepNegativeTotal - 0.3) * 0.5
            );
            for (const sl of surfaceLayers) {
                const entry = getOntologyEntry(sl.ontologyId);
                if (entry && entry.defaultValence > 0) {
                    sl.intensity *= (1 - suppressionFactor);
                }
            }
        }
    }

    private enforceCapacity() {
        for (const depth of ['surface', 'middle', 'deep'] as const) {
            const layers = this.getLayersByDepth(depth);
            const cap = LAYER_CAPACITY[depth];

            if (layers.length > cap) {
                // Keep strongest N, remove the rest
                layers.sort((a, b) => b.intensity - a.intensity);
                const toRemove = new Set(layers.slice(cap).map(l => l.id));
                this.state.layers = this.state.layers.filter(l => !toRemove.has(l.id));
            }
        }
    }

    private getLayersByDepth(depth: EmotionLayer['depth']): EmotionLayer[] {
        return this.state.layers.filter(l => l.depth === depth);
    }
}

// ── Decay Functions ──

function applyDecayFunction(
    intensity: number,
    hoursElapsed: number,
    rate: number,
    fn: 'exponential' | 'logarithmic' | 'plateau',
    plateauHours?: number
): number {
    switch (fn) {
        case 'exponential':
            return intensity * Math.pow(1 - rate, hoursElapsed);

        case 'logarithmic':
            return intensity / (1 + rate * Math.log(1 + hoursElapsed));

        case 'plateau': {
            const ph = plateauHours ?? 8;
            if (hoursElapsed <= ph) return intensity;
            const effectiveHours = hoursElapsed - ph;
            return intensity * Math.pow(1 - rate, effectiveHours);
        }

        default:
            return intensity * Math.pow(1 - rate, hoursElapsed);
    }
}

// ── Factory ──

export function createEmptyState(): EmotionState {
    return {
        layers: [],
        lastUpdatedAt: Date.now(),
    };
}

/**
 * 从序列化数据恢复引擎（IndexedDB 加载后调用）
 */
export function restoreEngine(serialized: EmotionState): EmotionDynamicsEngine {
    return new EmotionDynamicsEngine(serialized);
}

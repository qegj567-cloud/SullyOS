import { describe, expect, it } from 'vitest';
import {
    SAR_ALL_MODULES,
    SAR_STORY_MODULES,
    SAR_VARIANT_MODULES,
    drawSARModule,
    isSARFreeDrawAvailable,
    readSARGachaState,
} from './vrWorld/sarGacha';

const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
    };
};

describe('SAR 异世界双卡池', () => {
    it('包含 25 张异界异格和 24 张异界坐标模块，且底层兼容 ID 唯一', () => {
        expect(SAR_VARIANT_MODULES).toHaveLength(25);
        expect(SAR_STORY_MODULES).toHaveLength(24);
        expect(new Set(SAR_ALL_MODULES.map(module => module.id)).size).toBe(49);
        expect(SAR_STORY_MODULES.map(module => module.title)).toEqual(expect.arrayContaining(['王城处刑夜', '浮空学院坠落', '护送末代神明', '唯一归还名额']));
        expect(SAR_STORY_MODULES.some(module => module.title === '企业战争')).toBe(false);
        expect(SAR_STORY_MODULES.filter(module => /已经|正在|即将|只剩|开始|来到|进行到|连续抵达/.test(module.summary)).length).toBeGreaterThanOrEqual(18);
    });

    it('两池每天各有一次免费抽取，互不占用', () => {
        const storage = memoryStorage();
        const today = new Date(2026, 8, 1, 8, 0, 0);
        const variant = drawSARModule('variant', storage, today, () => 0);
        expect(variant.ok).toBe(true);

        const afterVariant = readSARGachaState(storage);
        expect(isSARFreeDrawAvailable('variant', afterVariant, today)).toBe(false);
        expect(isSARFreeDrawAvailable('story', afterVariant, today)).toBe(true);
        expect(drawSARModule('story', storage, today, () => 0.999).ok).toBe(true);
    });

    it('同池当天不能重复免费抽，次日恢复', () => {
        const storage = memoryStorage();
        const today = new Date(2026, 8, 1, 23, 59, 0);
        const tomorrow = new Date(2026, 8, 2, 0, 1, 0);
        expect(drawSARModule('variant', storage, today, () => 0).ok).toBe(true);
        expect(drawSARModule('variant', storage, today, () => 0).ok).toBe(false);
        expect(drawSARModule('variant', storage, tomorrow, () => 0).ok).toBe(true);
    });

    it('重复模块会叠加数量，并保留抽取记录', () => {
        const storage = memoryStorage();
        drawSARModule('story', storage, new Date(2026, 8, 1), () => 0);
        drawSARModule('story', storage, new Date(2026, 8, 2), () => 0);
        const state = readSARGachaState(storage);
        expect(state.collection['story-01']).toBe(2);
        expect(state.history).toHaveLength(2);
    });

    it('开发模式可以重复抽取，且不消耗原有每日额度', () => {
        const storage = memoryStorage();
        const today = new Date(2026, 8, 1, 12, 0, 0);
        expect(drawSARModule('story', storage, today, () => 0, true).ok).toBe(true);
        expect(drawSARModule('story', storage, today, () => 0, true).ok).toBe(true);
        const state = readSARGachaState(storage);
        expect(state.collection['story-01']).toBe(2);
        expect(state.freeDrawDate.story).toBeUndefined();
        expect(isSARFreeDrawAvailable('story', state, today)).toBe(true);
    });

    it('损坏的本地存档会安全回退', () => {
        const storage = memoryStorage();
        storage.setItem('vr_sar_gacha_state_v1', '{broken');
        expect(readSARGachaState(storage)).toMatchObject({ version: 1, collection: {}, history: [] });
    });
});

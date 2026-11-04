import { describe, it, expect } from 'vitest';
import {
    EVENT_BOX_SUMMARY_TARGET_MIN_CHARS,
    EVENT_BOX_SUMMARY_TARGET_MAX_CHARS,
    EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
} from './types';
import { enforceSummaryLengthBudget } from './summaryLengthBudget';

describe('EventBox summary 字数预算', () => {
    it('目标区间下界小于上界', () => {
        expect(EVENT_BOX_SUMMARY_TARGET_MIN_CHARS).toBeLessThan(EVENT_BOX_SUMMARY_TARGET_MAX_CHARS);
    });

    it('二次精简触发线高于目标上界，给模型估算留缓冲', () => {
        expect(EVENT_BOX_SUMMARY_HARD_MAX_CHARS).toBeGreaterThan(EVENT_BOX_SUMMARY_TARGET_MAX_CHARS);
    });
});

describe('enforceSummaryLengthBudget — 超限二次压缩兜底', () => {
    const HARD = 900;
    const ELLIPSIS = '……';

    it('未超限：原样返回，且不触发二次压缩', async () => {
        const text = 'a'.repeat(500);
        let called = false;
        const out = await enforceSummaryLengthBudget(text, async () => { called = true; return null; }, HARD);
        expect(out).toBe(text);
        expect(called).toBe(false);
    });

    it('超限 + 二次压缩达标：采用压缩结果，不留省略号', async () => {
        const text = 'a'.repeat(1000);
        const out = await enforceSummaryLengthBudget(text, async () => 'b'.repeat(600), HARD);
        expect(out).toBe('b'.repeat(600));
        expect(out.endsWith(ELLIPSIS)).toBe(false);
    });

    it('二次压缩仍超目标：采用更短的完整结果，不截尾', async () => {
        const text = 'a'.repeat(1000);
        expect(await enforceSummaryLengthBudget(text, async () => 'b'.repeat(950), HARD)).toBe('b'.repeat(950));
    });

    it('二次压缩失败：完整保留首次正文', async () => {
        const text = 'a'.repeat(1000);
        expect(await enforceSummaryLengthBudget(text, async () => null, HARD)).toBe(text);
        expect(await enforceSummaryLengthBudget(text, async () => { throw new Error('timeout'); }, HARD)).toBe(text);
        expect(await enforceSummaryLengthBudget(text, async () => 'b'.repeat(1200), HARD)).toBe(text);
    });
});

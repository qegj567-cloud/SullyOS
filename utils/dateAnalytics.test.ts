import { expect, it, vi } from 'vitest';
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
import { trackEvent } from './analytics';
import { trackDateGeneration } from './dateAnalytics';

it('reports only fixed generation stages and results; unknown purposes never leave the device', () => {
    for (const purpose of ['见面开场', '重随见面开场', '见面对话', '重随见面回复']) {
        trackDateGeneration(purpose, true); trackDateGeneration(purpose, false);
    }
    trackDateGeneration('PRIVATE-URL-user-input', false);
    expect(trackEvent).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain('PRIVATE');
    for (const [name, props] of vi.mocked(trackEvent).mock.calls) {
        expect(name).toBe('见面生成结果');
        expect(['开场', '重生成开场', '回复', '重生成回复']).toContain(props?.阶段);
        expect(['成功', '失败']).toContain(props?.结果);
    }
});

import { beforeEach, expect, it, vi } from 'vitest';
import { trackEvent } from './analytics';
import { trackBibiEntry, trackBibiFeature, trackHalloweenFeature } from './octoberAnalytics';
vi.mock('./analytics', () => ({trackEvent:vi.fn()}));
beforeEach(() => vi.clearAllMocks());
it('reports only the fixed feature and entry labels', () => {
    trackHalloweenFeature('change'); trackHalloweenFeature('gift'); trackHalloweenFeature('replay');
    trackBibiEntry('app'); trackBibiEntry('phone'); trackBibiFeature('relations');
    expect(vi.mocked(trackEvent).mock.calls).toEqual([
        ['体验彼方万圣节',{功能:'更换装扮'}],['体验彼方万圣节',{功能:'收到节日赠礼'}],['体验彼方万圣节',{功能:'回看对话'}],
        ['进入哔哔',{入口:'独立App'}],['进入哔哔',{入口:'家园小手机'}],['打开哔哔功能',{功能:'关注与身份关系'}],
    ]);
});
it('drops private strings, arbitrary IDs, dialogue choices and future unknown actions', () => {
    for (const poison of ['PRIVATE_CHARACTER','sk-secret','https://private.invalid','我不喜欢','withdraw','post-123','future-feature',{},null,undefined,new Error('私人正文')]) {
        trackHalloweenFeature(poison); trackBibiEntry(poison); trackBibiFeature(poison);
    }
    expect(trackEvent).not.toHaveBeenCalled();
});

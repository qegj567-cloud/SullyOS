import { describe, expect, it } from 'vitest';
import { WORLDBOOK_SCENE_NONE_TEXT, setAllWorldbookScenes, setWorldbookScene, setWorldbookSceneCategory, summarizeWorldbookScenes } from './worldbookScenes';

describe('世界书生效场景 · 界面摘要', () => {
    it('undefined / null 是全部场景，[] 是警示态', () => {
        expect(summarizeWorldbookScenes(undefined)).toEqual({ kind: 'all', text: '全部场景' });
        expect(summarizeWorldbookScenes(null)).toEqual({ kind: 'all', text: '全部场景' });
        expect(summarizeWorldbookScenes([])).toEqual({ kind: 'none', text: WORLDBOOK_SCENE_NONE_TEXT });
    });

    it('只剩 App 自管或认不出的令牌算警示态；隐藏场景按「其他」计入', () => {
        expect(summarizeWorldbookScenes(['apps.storyTheater', 'future.x']).kind).toBe('none');
        expect(summarizeWorldbookScenes(['chat.qqBridge'])).toEqual({ kind: 'some', text: '线上私聊·其他' });
    });

    it('全选关后只开跑团，摘要直接写跑团', () => {
        const scenes = setWorldbookScene(setAllWorldbookScenes(false), 'apps.trpg', true);
        expect(scenes).toEqual(['apps.trpg']);
        expect(summarizeWorldbookScenes(scenes)).toEqual({ kind: 'some', text: '跑团' });
    });

    it('整类开着且不多时列分类名，多了只报个数', () => {
        expect(summarizeWorldbookScenes(['offline', 'group']).text).toBe('多人、线下在场');
        const mixed = setWorldbookSceneCategory(['apps.trpg', 'apps.spark', 'apps.dream'], 'offline', true);
        expect(summarizeWorldbookScenes(mixed).text).toBe('已选 8 个场景');
    });
});

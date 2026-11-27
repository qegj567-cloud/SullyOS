import { describe, expect, it } from 'vitest';
import { DB } from './db';

// 启动时 OSContext 用到的资源键：四个固定键 + 四类前缀。这里按消费方的判断条件独立写一遍，
// 不引用 db.ts 里的清单，两边对不上时这组用例会红。
const EXACT = ['wallpaper', 'lock_wallpaper', 'launcherWidgetImage', 'custom_font_data'];
const PREFIXES = ['icon_', 'widget_', 'appearance_preset_', 'deco_'];
const usedAtStartup = (id: string) => EXACT.includes(id) || PREFIXES.some(prefix => id.startsWith(prefix));

describe('启动只读桌面外观用到的资源', () => {
    it('每一类要用的键都读到，语音和语音合成缓存等大块数据不读', async () => {
        const wanted = [
            ...EXACT,
            // 前缀本身、前缀后紧跟最大码位的键也算这一类
            'icon_chat', 'icon_settings', 'icon_', 'icon_\uffff\uffffx',
            'widget_tl', 'widget_bl',
            'appearance_preset_1700000000000', 'appearance_preset_1700000000001',
            'deco_abc', 'deco_\uffffx',
        ];
        const unwanted = [
            'voice_msg_1', 'voice_msg_2', 'voice_msg_3', 'tts_abc', 'tts_def',
            'song_cache_1', 'friend_feed_v1', 'ls_mirror_v1', 'mp_hwm_v1_c1',
            // 紧挨着前缀范围两端的键，不该被圈进来
            'icon', 'icon`x', 'icons_x', 'widget', 'widgets', 'deco', 'decoy', 'appearance_preset', 'wallpaper_backup',
        ];
        for (const id of [...wanted, ...unwanted]) await DB.saveAsset(id, `data:${id}`);

        const startup = await DB.getStartupAssets();
        const ids = startup.map(row => row.id);

        expect([...ids].sort()).toEqual([...wanted].sort());
        expect(ids.some(id => id.startsWith('voice_msg_') || id.startsWith('tts_'))).toBe(false);
        for (const row of startup) expect(row.data).toBe(`data:${row.id}`);

        // 内容和顺序都与「整表读出来再按消费方条件筛」完全一致
        const all = await DB.getAllAssets();
        expect(startup).toEqual(all.filter(row => usedAtStartup(row.id)));
    });
});

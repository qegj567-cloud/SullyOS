import { describe, it, expect, beforeEach } from 'vitest';
import { DB } from './db';
import { MIRRORED_KEYS, healLocalStorageMirror, snapshotLocalStorageMirror } from './lsMirror';
import { healAllMemoryPalaceHighWaterMarks, setReliableMemoryPalaceHighWaterMark } from './memoryPalace/highWaterMark';

// localStorage 镜像：模拟"浏览器清了 localStorage 但 IndexedDB 幸存"的用户现场
// （主题回初始 / 盲盒收藏册清空 / API 配置丢失导致「更新这一天」无反应）。
describe('localStorage IndexedDB 镜像 (lsMirror)', () => {
    beforeEach(async () => {
        localStorage.clear();
        await DB.saveAssetRaw('ls_mirror_v1', null as any).catch(() => {});
    });

    it('快照 → localStorage 被清 → 回填恢复', async () => {
        localStorage.setItem('os_theme', '{"hue":300}');
        localStorage.setItem('os_api_config', '{"baseUrl":"https://x","apiKey":"sk-1","model":"m"}');
        localStorage.setItem('os_dream_collection', '{"sweet":{"firstAt":1,"count":2}}');
        await snapshotLocalStorageMirror();

        localStorage.clear(); // 模拟浏览器驱逐

        const restored = await healLocalStorageMirror();
        expect(restored.sort()).toEqual(['os_api_config', 'os_dream_collection', 'os_theme']);
        expect(localStorage.getItem('os_theme')).toBe('{"hue":300}');
        expect(localStorage.getItem('os_dream_collection')).toBe('{"sweet":{"firstAt":1,"count":2}}');
    });

    it('localStorage 已有值时回填不覆盖（真值永远是 localStorage）', async () => {
        localStorage.setItem('os_theme', '{"hue":1}');
        await snapshotLocalStorageMirror();

        localStorage.setItem('os_theme', '{"hue":2}'); // 用户之后又改了主题
        const restored = await healLocalStorageMirror();
        expect(restored).toEqual([]);
        expect(localStorage.getItem('os_theme')).toBe('{"hue":2}');
    });

    it('removeItem 语义：新快照不再含已删除的键，回填不会复活它', async () => {
        localStorage.setItem('study_api_config', '{"baseUrl":"https://private"}');
        localStorage.setItem('os_theme', '{"hue":9}');
        await snapshotLocalStorageMirror();

        localStorage.removeItem('study_api_config'); // 用户点了「恢复使用全局 API」
        await snapshotLocalStorageMirror();          // 页面隐藏/定时快照跟进

        localStorage.clear();
        const restored = await healLocalStorageMirror();
        expect(restored).toEqual(['os_theme']);
        expect(localStorage.getItem('study_api_config')).toBeNull();
    });

    it('localStorage 全空时不写快照（不拿空覆盖有效镜像）', async () => {
        localStorage.setItem('os_theme', '{"hue":7}');
        await snapshotLocalStorageMirror();

        localStorage.clear();
        await snapshotLocalStorageMirror(); // 空的，应当被忽略

        const restored = await healLocalStorageMirror();
        expect(restored).toEqual(['os_theme']);
    });

    it('没有镜像时回填静默返回空数组', async () => {
        const restored = await healLocalStorageMirror();
        expect(restored).toEqual([]);
    });

    it('镜像键名单不含大体积键（data URI 类必须走 assets）', () => {
        for (const k of MIRRORED_KEYS) {
            expect(k).not.toMatch(/wallpaper|font|sprite|image|blob/i);
        }
    });

    it('SAR 存档、悬浮球、瑞幸 MCP、音乐登录与更新公告已读标记在 localStorage 被清后完整自愈', async () => {
        localStorage.setItem('vr_fishing_market_v1', '{"coins":9999,"dinosaurGarden":{"eggs":3},"sarFamiliarity":{"aiven":88}}');
        localStorage.setItem('vr_sar_club_v1', '{"seenIntro":true}');
        localStorage.setItem('vr_sar_gacha_v1', '{"chips":["ssr-1"]}');
        localStorage.setItem('vr_sar_module_shop_v1', '{"modules":["mod-a"]}');
        localStorage.setItem('sully_navigation_ball_enabled_v1', 'true');
        localStorage.setItem('sully_navigation_ball_slots_v1', '["Chat","VRWorld","Settings"]');
        localStorage.setItem('aetheros.luckin.mcpToken', 'lk-secret');
        localStorage.setItem('aetheros.luckin.mcpEnabled', 'true');
        localStorage.setItem('sully_music_cfg_v1', '{"workerUrl":"","cookie":"MUSIC_U=abc","quality":"exhigh"}');
        localStorage.setItem('sullyos_update_2026_09_11_sar_seen', '1');
        localStorage.setItem('sullyos_disclaimer_accepted', '1700000000000');

        await snapshotLocalStorageMirror();
        localStorage.clear();

        const restored = await healLocalStorageMirror();
        expect(restored).toEqual(expect.arrayContaining([
            'vr_fishing_market_v1',
            'vr_sar_club_v1',
            'vr_sar_gacha_v1',
            'vr_sar_module_shop_v1',
            'sully_navigation_ball_enabled_v1',
            'sully_navigation_ball_slots_v1',
            'aetheros.luckin.mcpToken',
            'aetheros.luckin.mcpEnabled',
            'sully_music_cfg_v1',
            'sullyos_update_2026_09_11_sar_seen',
            'sullyos_disclaimer_accepted',
        ]));
        expect(localStorage.getItem('vr_fishing_market_v1')).toBe('{"coins":9999,"dinosaurGarden":{"eggs":3},"sarFamiliarity":{"aiven":88}}');
        expect(localStorage.getItem('vr_sar_gacha_v1')).toBe('{"chips":["ssr-1"]}');
        expect(localStorage.getItem('sully_navigation_ball_enabled_v1')).toBe('true');
        expect(localStorage.getItem('aetheros.luckin.mcpToken')).toBe('lk-secret');
        expect(localStorage.getItem('sully_music_cfg_v1')).toBe('{"workerUrl":"","cookie":"MUSIC_U=abc","quality":"exhigh"}');
        expect(localStorage.getItem('sullyos_update_2026_09_11_sar_seen')).toBe('1');
    });

    it('记忆宫殿水位线在 localStorage 被清后从 IndexedDB mp_hwm_v1_* 批量自愈', async () => {
        await setReliableMemoryPalaceHighWaterMark('char-a', 6800);
        await setReliableMemoryPalaceHighWaterMark('char-b', 1200);

        localStorage.clear();
        expect(localStorage.getItem('mp_lastMsgId_char-a')).toBeNull();
        expect(localStorage.getItem('mp_lastMsgId_char-b')).toBeNull();

        const healed = await healAllMemoryPalaceHighWaterMarks();
        expect(healed.sort()).toEqual(['mp_lastMsgId_char-a', 'mp_lastMsgId_char-b']);
        expect(localStorage.getItem('mp_lastMsgId_char-a')).toBe('6800');
        expect(localStorage.getItem('mp_lastMsgId_char-b')).toBe('1200');
    });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AppID } from '../types';
import { shellHandlesSafeArea, SELF_SAFE_AREA_APPS } from './safeAreaApps';

// 已迁移成自理安全区的 App：外壳不该再替它加 padding（否则顶部双重让位、留白过多）。
// 这是回归守卫——谁把某个 App 从 SELF_SAFE_AREA_APPS 删了，对应断言立刻挂。
const SELF_HANDLED: AppID[] = [
    AppID.Launcher, AppID.VRWorld, AppID.Chat, AppID.GroupChat, AppID.Social,
    AppID.Settings, AppID.Character, AppID.ThemeMaker, AppID.Appearance, AppID.Gallery,
    AppID.Date, AppID.User, AppID.Journal, AppID.Schedule, AppID.Room, AppID.CheckPhone,
    AppID.Study, AppID.FAQ, AppID.Game, AppID.Worldbook, AppID.Novel, AppID.Bank,
    AppID.XhsStock, AppID.XhsFreeRoam, AppID.Browser, AppID.Songwriting, AppID.Music,
    AppID.Call, AppID.VoiceDesigner, AppID.Guidebook, AppID.LifeSim, AppID.MemoryPalace,
    AppID.Handbook, AppID.QQBridge, AppID.HotNews, AppID.WorldHome, AppID.CharCreatorDev,
    AppID.SpecialMoments, AppID.FriendFeed,
];

describe('shellHandlesSafeArea', () => {
    it('所有已登记 App 都自理安全区，外壳不加 padding', () => {
        for (const appId of SELF_HANDLED) {
            expect(shellHandlesSafeArea(appId)).toBe(false);
        }
    });

    // 双向一致：名单里有的断言里也要有，反之亦然，防止以后加/删 App 时漏更新其中一处。
    it('自理名单与断言列表一一对应（防漏登记）', () => {
        expect([...SELF_HANDLED].sort()).toEqual([...SELF_SAFE_AREA_APPS].sort());
    });

    it('笔友会所有顶栏都避开共享状态栏点击层', () => {
        const appSource = readFileSync(path.resolve(__dirname, '../apps/NovelApp.tsx'), 'utf8');
        const writerSource = readFileSync(path.resolve(__dirname, '../components/novel/NovelWriter.tsx'), 'utf8');

        expect(appSource.match(/paddingTop: 'var\(--chrome-top\)'/g)).toHaveLength(3);
        expect(writerSource).toContain("style={{ paddingTop: 'var(--chrome-top)' }}");
    });
});

import { expect, it, vi } from 'vitest';
import { readHelpDeskSettings } from './sullyHelpSettings';
import type { CharacterProfile } from '../types';

vi.mock('./activeMsgStore', async importOriginal => {
    const actual = await importOriginal<typeof import('./activeMsgStore')>();
    return { ...actual, ActiveMsgStore: { ...actual.ActiveMsgStore, getGlobalConfig: vi.fn(async () => null) } };
});
const os = { isDataLoaded: true, apiConfig: {}, memoryPalaceConfig: { lightLLM: {}, embedding: {} }, realtimeConfig: {}, theme: {} } as any;

it('Sully-11 读取当前角色的见面设置，保留范围说明而不带私人正文或素材', async () => {
    const char = { id: 'test', name: 'PRIVATE_NAME', dateActionChoicesEnabled: true,
        dateStyleConfig: { style: 'slice_of_life', tone: 'daily_warm', pov: 'first-you', extra: 'PRIVATE_EXTRA', sceneSeed: 'PRIVATE_SCENE' },
        dateExtraPresets: [{ id: 'PRIVATE_ID', name: 'PRIVATE_PRESET', content: 'PRIVATE_CONTENT', experience: { style: 'syrup' } }],
        dateObserve: { enabled: true, style: 'ink', fields: { place: { enabled: false, hint: 'PRIVATE_HINT' } }, custom: [{ id: 'PRIVATE_DIM', label: 'PRIVATE_LABEL', hint: 'PRIVATE_HINT' }] },
        dateLeaveReminder: { enabled: true, delayMinutes: 12 }, dateBackground: 'https://PRIVATE_IMAGE',
        dateSkinSets: [{ id: 'PRIVATE_SKIN', name: 'PRIVATE_NAME', sprites: { normal: 'PRIVATE_IMAGE' } }], activeSkinSetId: 'PRIVATE_SKIN',
        dateVoiceEnabled: true, dateTimeAwarenessEnabled: false, dateAppearance: { preset: 'paper', name: 'PRIVATE_NAME', customCss: 'PRIVATE_CSS' },
    } as CharacterProfile;
    const result = await readHelpDeskSettings(os, char);
    expect(result.指定角色设置).toMatchObject({
        陪伴默认体验: { 行动选择: true, 文风: 'slice_of_life', 基调: 'daily_warm', 场景已设: true, 完整体验预设数: 1, 作用范围: expect.stringContaining('不包含本场临时内容') },
        见面设置: { 观测协议: { 开启: true, 样式: 'ink', 启用的基础维度数: 3, 启用的自定义维度数: 1 }, 离开提醒: { 开启: true, 等待分钟: 12 }, 当前套装: '自定义套装', 套装数: 2, 背景已设: true, 阅读样式: 'paper', 语音播放: true, 见面时间感知: false },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const changed = await readHelpDeskSettings(os, { ...char, dateActionChoicesEnabled: false, dateLeaveReminder: { enabled: false } });
    expect(changed.指定角色设置).toMatchObject({ 陪伴默认体验: { 行动选择: false }, 见面设置: { 离开提醒: { 开启: false, 等待分钟: 5 } } });
    const unknown = await readHelpDeskSettings(os, { ...char, dateStyleConfig: { style: 'PRIVATE_STYLE' }, dateObserve: { style: 'PRIVATE_STYLE' } } as any);
    expect(JSON.stringify(unknown)).not.toContain('PRIVATE');
    expect((await readHelpDeskSettings(os)).指定角色设置).toEqual(expect.any(String));
});

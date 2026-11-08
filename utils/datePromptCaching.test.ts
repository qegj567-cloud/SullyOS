import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatePrompts } from './datePrompts';
import { toAnthropicRequest } from './anthropicApi';
import * as palace from './memoryPalace/pipeline';
import * as location from './userLocation';
import * as holidays from './userHolidays';
import * as schedules from './dailySchedule';
import { installSARModuleOnCharacter, advanceSARModuleRuntime, buildSARModulePrompt } from './vrWorld/sarModuleRuntime';
import { SAR_MODULE_CATALOG } from './vrWorld/sarModuleShop';
import type { CharacterProfile, Message, UserProfile } from '../types';

const start = Date.parse('2026-11-08T12:34:00Z');
const user = { name: '测试用户', bio: '固定用户资料' } as UserProfile;
const makeChar = (overrides: Partial<CharacterProfile> = {}) => ({
    id: 'date-cache', name: '测试角色', description: '', avatar: '',
    systemPrompt: '固定角色设定', worldview: '固定世界观', memories: [],
    customTimezoneEnabled: true, customTimezone: 'UTC', contextLimit: 1000,
    ...overrides,
} as CharacterProfile);
const history = (): Message[] => Array.from({ length: 81 }, (_, index) => ({
    id: index + 1, charId: 'date-cache', role: index % 2 ? 'assistant' : 'user', type: 'text',
    content: `历史原文-${index}`, timestamp: start - (81 - index) * 1000,
    metadata: { source: 'date' },
}));
type Mode = 'send' | 'reroll' | 'approach' | 'invite';
const build = async (mode: Mode, char = makeChar(), rows = history()) => {
    const input = { char, userProfile: user, allMsgs: rows, emojis: [] };
    return mode === 'send' || mode === 'reroll'
        ? DatePrompts.buildSessionPayload({ ...input, userText: rows.at(-1)?.content || '第一句', variant: mode })
        : DatePrompts.buildPeekPayload({ ...input, openingMode: mode });
};
const native = (payload: Awaited<ReturnType<typeof build>>) => toAnthropicRequest({ model: 'claude-opus-4-6', messages: payload.messages });
const blocks = (request: any) => request.messages.flatMap((message: any) => message.content.map((block: any) => ({ role: message.role, ...block })));
const withoutCacheMarker = ({ cache_control: _marker, ...block }: any) => block;
const cachedHistory = (request: any) => {
    const content = blocks(request);
    const end = content.findLastIndex((block: any) => block.cache_control);
    expect(end).toBeGreaterThanOrEqual(0);
    return content.slice(0, end + 1).map(withoutCacheMarker);
};
const text = (payload: Awaited<ReturnType<typeof build>>) => payload.messages.map(message => String(message.content)).join('\n');

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    vi.spyOn(palace, 'injectMemoryPalace').mockResolvedValue({} as any);
    vi.spyOn(location, 'getUserLocationContext').mockResolvedValue('');
    vi.spyOn(holidays, 'getCachedUserHolidayReminder').mockReturnValue('');
    vi.spyOn(schedules, 'getDailyScheduleForChar').mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('见面稳定前缀与原生缓存边界', () => {
    it.each(['send', 'reroll', 'approach', 'invite'] as const)('%s 跨分钟、随机线索变化不改变稳定系统与历史缓存前缀', async mode => {
        const rows = history(), original = structuredClone(rows);
        const a = await build(mode, makeChar(), rows);
        vi.setSystemTime(start + 60_000);
        const b = await build(mode, makeChar(), rows);
        expect(a.messages[0]).toEqual(b.messages[0]);
        expect(a.messages[0].content).not.toContain('当前时间');
        const nativeA = native(a), nativeB = native(b);
        expect(nativeA.system).toEqual(nativeB.system);
        expect(cachedHistory(nativeA)).toEqual(cachedHistory(nativeB));
        const prefix = JSON.stringify(cachedHistory(nativeA));
        expect(prefix).toContain('历史原文-0');
        expect(prefix).toContain('历史原文-79');
        expect(prefix).not.toContain('Live Context');
        expect(prefix).not.toContain('System Note');
        expect(text(a)).toContain('12:34');
        expect(text(b)).toContain('12:35');
        const firstLive = a.messages.findIndex(message => String(message.content).includes('见面实时状态'));
        expect(firstLive).toBeGreaterThan(1);
        expect(rows).toEqual(original);
    });

    it('真实续轮保留上次写入的历史前缀，本轮 user 的格式提醒不进入缓存', async () => {
        const rows = history();
        const first = native(await build('send', makeChar(), rows));
        const previousPrefix = cachedHistory(first);
        const more: Message[] = [...rows,
            { ...rows[0], id: 82, role: 'assistant', content: '[normal] 本轮回复', timestamp: start },
            { ...rows[0], id: 83, role: 'user', content: '下一句', timestamp: start + 60_000 },
        ];
        vi.setSystemTime(start + 60_000);
        const next = native(await build('send', makeChar(), more));
        expect(next.system).toEqual(first.system);
        expect(blocks(next).slice(0, previousPrefix.length).map(withoutCacheMarker)).toEqual(previousPrefix);
        expect(cachedHistory(next).length - previousPrefix.length).toBeLessThan(20);
        expect(JSON.stringify(previousPrefix)).not.toContain('历史原文-80');
        expect(JSON.stringify(cachedHistory(next))).toContain('本轮回复');
    });

    it.each(['send', 'reroll', 'approach', 'invite'] as const)('%s 无历史时也不把实时状态合入原生 system', async mode => {
        const a = native(await build(mode, makeChar(), []));
        vi.setSystemTime(start + 60_000);
        const b = native(await build(mode, makeChar(), []));
        expect(a.system).toEqual(b.system);
        expect(JSON.stringify(a.system)).not.toContain('当前时间');
        expect(JSON.stringify(a.messages)).toContain('12:34');
        expect(JSON.stringify(b.messages)).toContain('12:35');
    });

    it.each(['send', 'approach'] as const)('%s 的召回、日程、位置、节假日变化只进入实时尾段', async mode => {
        vi.mocked(location.getUserLocationContext).mockResolvedValue('位置甲');
        vi.mocked(holidays.getCachedUserHolidayReminder).mockReturnValue('节日甲');
        vi.mocked(schedules.getDailyScheduleForChar).mockResolvedValue({ slots: [{ startTime: '00:00', activity: '日程甲' }] } as any);
        const char = makeChar({ memoryPalaceEnabled: true, memoryPalaceInjection: '召回甲', scheduleFeatureEnabled: true });
        const a = await build(mode, char);
        vi.mocked(location.getUserLocationContext).mockResolvedValue('位置乙');
        vi.mocked(holidays.getCachedUserHolidayReminder).mockReturnValue('节日乙');
        vi.mocked(schedules.getDailyScheduleForChar).mockResolvedValue({ slots: [{ startTime: '00:00', activity: '日程乙' }] } as any);
        const b = await build(mode, { ...char, memoryPalaceInjection: '召回乙' });
        expect(a.messages[0]).toEqual(b.messages[0]);
        expect(cachedHistory(native(a))).toEqual(cachedHistory(native(b)));
        for (const part of ['召回', '日程', '位置', '节日']) {
            expect(a.messages[0].content).not.toContain(`${part}甲`);
            // 日程正文同时列出当前活动和全天安排，但只出现在一个实时块里。
            expect(a.messages.filter(message => String(message.content).includes(`${part}甲`))).toHaveLength(1);
            expect(b.messages.filter(message => String(message.content).includes(`${part}乙`))).toHaveLength(1);
            expect(text(b)).not.toContain(`${part}甲`);
        }
        expect(location.getUserLocationContext).toHaveBeenCalledTimes(2);
        expect(location.getUserLocationContext).toHaveBeenCalledWith(user.name, char.id);
        expect(schedules.getDailyScheduleForChar).toHaveBeenCalledTimes(2);
    });

    it.each(['send', 'approach'] as const)('%s 关闭线下时间仍保留召回正文，但不查询位置或日程、不泄漏现实日期', async mode => {
        const result = await build(mode, makeChar({
            dateTimeAwarenessEnabled: false, memoryPalaceEnabled: true, scheduleFeatureEnabled: true,
            memoryPalaceInjection: '- [2026年11月8日（今天）] 还书的约定（对应日期：2026年11月9日）（剩余 1 天）',
        }));
        expect(text(result)).toContain('还书的约定');
        expect(text(result)).not.toContain('2026年11月');
        expect(text(result)).not.toContain('剩余 1 天');
        expect(text(result)).not.toContain('当前时间');
        expect(location.getUserLocationContext).not.toHaveBeenCalled();
        expect(schedules.getDailyScheduleForChar).not.toHaveBeenCalled();
        expect(holidays.getCachedUserHolidayReminder).not.toHaveBeenCalled();
    });

    it('SAR 剩余轮数推进时保留完整模块规则，不改变历史前面的稳定设定', async () => {
        const runtime = installSARModuleOnCharacter(SAR_MODULE_CATALOG[0], start);
        const char = makeChar({ vrState: { enabled: true, intervalMinutes: 120, sarModule: runtime } });
        const nextChar = { ...char, vrState: { ...char.vrState!, sarModule: advanceSARModuleRuntime(runtime) } };
        const a = await build('send', char), b = await build('send', nextChar);
        expect(a.messages[0]).toEqual(b.messages[0]);
        expect(a.messages[0].content).not.toContain('SAR 临时模块');
        expect(cachedHistory(native(a))).toEqual(cachedHistory(native(b)));
        expect(text(a)).toContain(buildSARModulePrompt(char, user, 'date'));
        expect(text(b)).toContain(buildSARModulePrompt(nextChar, user, 'date'));
        expect(text(a)).toContain('还剩 10/10 次');
        expect(text(b)).toContain('还剩 9/10 次');
    });
});

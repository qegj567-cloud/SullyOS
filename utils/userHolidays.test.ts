import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUserHolidayReminder, getCachedUserHolidayReminder, hasChosenHolidayIntro, hasHolidaySettingsRequest, requestHolidaySettings, consumeHolidaySettings, insertUserHolidayInProfile, loadHolidayCalendar, parseHolidayCalendar, renderUserHoliday, type UserHolidayConfig } from './userHolidays';
import { buildToolConfig, parseToolConfig } from './amsgToolPack';
import { defaultRealtimeConfig, RealtimeContextManager } from './realtimeContext';
import { buildUserHolidayBlock } from '../worker/amsg/src/realtimeWorld';
import { ContextBuilder } from './context';
import { DatePrompts } from './datePrompts';
import JSZip from 'jszip';
import { writeV2Backup, assembleV2Backup } from './backupFormat';

const china: UserHolidayConfig = { enabled: true, countryCode: 'CN', timeZone: 'Asia/Shanghai' };
afterEach(() => { localStorage.removeItem('os_realtime_config'); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('用户所在地节假日', () => {
    it('中国公告覆盖连休以及周末补班，普通日期不增加提醒，离线可用', async () => {
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        expect(await getUserHolidayReminder(china, undefined, Date.parse('2026-09-26T04:00Z'))).toContain('中秋节公共假期');
        expect(await getUserHolidayReminder(china, undefined, Date.parse('2026-09-20T04:00Z'))).toContain('国庆节调休补班日');
        expect(await getUserHolidayReminder(china, undefined, Date.parse('2026-09-28T04:00Z'))).toBe('');
        expect(await getUserHolidayReminder(china, undefined, Date.parse('2026-09-26T04:00Z'), '小桃')).toBe('小桃所在地中国 2026-09-26 为中秋节公共假期，实际休息与否以小桃自己的日程和说明为准。');
        expect(await getUserHolidayReminder({ ...china, enabled: false })).toBe('');
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('使用用户日历日，与角色和服务器的日历日无关', async () => {
        const at = Date.parse('2026-09-24T17:00Z');
        expect(await getUserHolidayReminder(china, undefined, at)).toContain('2026-09-25');
        expect(await getUserHolidayReminder({ ...china, timeZone: 'America/New_York' }, undefined, at)).toBe('');
    });
    it('排除银行节日与未选中的地方假期，仅选中地区才适用', () => {
        const raw = ['Public', 'Bank'].map(type => ({ date: '2026-09-25', countryCode: 'US', localName: type, types: [type], global: true }));
        raw.push({ ...raw[0], localName: 'Local', global: false, counties: ['US-CA'] } as any);
        const data = parseHolidayCalendar('US', 2026, raw, 1)!;
        expect(data.days).toHaveLength(2);
        expect(renderUserHoliday({ enabled: true, countryCode: 'US' }, '2026-09-25', data.days)).not.toContain('Local');
        expect(renderUserHoliday({ enabled: true, countryCode: 'US', subdivisionCode: 'US-CA' }, '2026-09-25', data.days)).toContain('Public、Local');
        expect(parseHolidayCalendar('CN', 2027, { year: 2027, papers: [], days: [] }, 1)).toBeNull();
    });
    it('年度请求合并并写缓存，不支持/网络故障不冒充正常工作日', async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify([{ date: '2026-07-01', countryCode: 'CA', localName: 'Canada Day', types: ['Public'], global: true }])));
        vi.stubGlobal('fetch', fetcher);
        const cache = { read: vi.fn(async () => null), write: vi.fn(async () => {}) };
        const [first, second] = await Promise.all([loadHolidayCalendar('CA', 2026, cache, 100), loadHolidayCalendar('CA', 2026, cache, 100)]);
        expect(first).toEqual(second);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(cache.write).toHaveBeenCalledTimes(1);
        await loadHolidayCalendar('CA', 2026, cache, 101);
        expect(fetcher).toHaveBeenCalledTimes(1);
        fetcher.mockRejectedValue(new Error('offline'));
        expect(await loadHolidayCalendar('JP', 2090, cache, 100)).toBeNull();
        expect(await getUserHolidayReminder({ enabled: true, countryCode: 'XX' })).toBe('');
    });
    it('十二月合并下一年度公告的补班安排', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ year: 2027, papers: ['official'], days: [{ date: '2026-12-26', name: '元旦', isOffDay: false }] }))));
        expect(await getUserHolidayReminder(china, undefined, Date.parse('2026-12-26T04:00Z'))).toContain('元旦调休补班日');
    });
    it('配置序列化和云端工具包保留国家地区，按设备时区同步', () => {
        const config = JSON.parse(JSON.stringify({ ...defaultRealtimeConfig, userHolidays: china }));
        const pack = buildToolConfig(config);
        expect(parseToolConfig(JSON.stringify(pack))?.userHolidays).toEqual({ ...china, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    });
    it('完整与文本备份的配置经真实 ZIP 导出导入不丢失', async () => {
        for (const mode of ['full', 'text_only']) {
            const zip = new JSZip();
            const config = { ...defaultRealtimeConfig, userHolidays: { ...china, introChoice: 'declined', enabled: false, subdivisionCode: 'CN-TEST' } };
            await writeV2Backup(zip, { realtimeConfig: config }, { mode });
            const restoredZip = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
            const result = await assembleV2Backup(restoredZip, JSON.parse(await restoredZip.file('manifest.json')!.async('string')));
            expect(result.realtimeConfig).toEqual(config);
        }
    });
    it('前后台均尊重时间感知关闭，后台不使用角色时区计算用户假期', async () => {
        const cfg = { ...defaultRealtimeConfig, feishuEnabled: false, feishuAppId: '', feishuAppSecret: '', feishuBaseId: '', feishuTableId: '', xhsEnabled: false, userHolidays: china };
        vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-09-24T17:00Z'));
        expect(await RealtimeContextManager.buildFullContext(cfg, 'America/New_York', { includeTime: false })).toBe('');
        const args = { toolConfig: { ...buildToolConfig(cfg), userHolidays: china }, nowMs: Date.now(), tzId: 'America/New_York', globalRows: [], globalNamespace: 'amsg:global', timeAwarenessEnabled: true };
        const text = await buildUserHolidayBlock(args);
        expect(text).toContain('2026-09-25 为中秋节公共假期');
        expect(text.split('\n')).toHaveLength(1);
        expect(await buildUserHolidayBlock({ ...args, userName: '小桃' })).toContain('小桃所在地');
        expect(await buildUserHolidayBlock({ ...args, timeAwarenessEnabled: false })).toBe('');
        expect(await buildUserHolidayBlock({ ...args, nowMs: Date.parse('2026-09-28T04:00Z') })).toBe('');
    });
    it('共用用户信息区包含实际用户名；关闭、普通日、见面架空模式不注入', async () => {
        vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date(2026, 8, 26, 12));
        localStorage.setItem('os_realtime_config', JSON.stringify({ userHolidays: china }));
        const char = { id: 'test', name: 'Sully', timeAwarenessEnabled: true } as any;
        const user = { name: '小桃', bio: '测试用户简介' } as any;
        const prompt = (await ContextBuilder.buildCharacterContext({ scene: 'chat.private', char, user })).coreContext;
        const expected = getCachedUserHolidayReminder('小桃');
        expect(expected).toContain('小桃所在地');
        expect(prompt.indexOf(expected)).toBeGreaterThan(prompt.indexOf('### 互动对象 (User)'));
        expect(prompt.split(expected)).toHaveLength(2);
        const dateInput = { char, userProfile: user, allMsgs: [], emojis: [] };
        expect(JSON.stringify((await DatePrompts.buildPeekPayload(dateInput)).messages)).toContain(expected);
        expect(JSON.stringify((await DatePrompts.buildSessionPayload({ ...dateInput, userText: '在吗', variant: 'send' })).messages)).toContain(expected);
        expect(JSON.stringify((await DatePrompts.buildPeekPayload({ ...dateInput, char: { ...char, dateTimeAwarenessEnabled: false } })).messages)).not.toContain(expected);
        expect((await ContextBuilder.buildCharacterContext({ scene: 'chat.private', char, user, timeOptions: { skipTimeAwareness: true } })).coreContext).not.toContain('公共假期');
        localStorage.setItem('os_realtime_config', JSON.stringify({ userHolidays: { ...china, enabled: false, introChoice: 'declined' } }));
        expect(hasChosenHolidayIntro()).toBe(true);
        expect(getCachedUserHolidayReminder('小桃')).toBe('');
        expect((await ContextBuilder.buildCharacterContext({ scene: 'chat.private', char, user })).coreContext).not.toContain('公共假期');
    });
    it('云端补入用户区，不把假期放在天气新闻块；空提醒不会添加任何文字', () => {
        const prompt = '角色\n### 互动对象 (User)\n- 名字: 小桃\n记忆';
        expect(insertUserHolidayInProfile(prompt, '小桃所在地今天补班。')).toContain('### 互动对象 (User)\n- 小桃所在地今天补班。\n- 名字');
        expect(insertUserHolidayInProfile(prompt, '')).toBe(prompt);
    });
    it('去填写标记允许 StrictMode 连读两次，提交 effect 后才消费', () => {
        const store = new Map<string, string>();
        vi.stubGlobal('sessionStorage', { getItem: (key: string) => store.get(key) || null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
        requestHolidaySettings();
        expect(hasHolidaySettingsRequest()).toBe(true);
        expect(hasHolidaySettingsRequest()).toBe(true);
        expect(consumeHolidaySettings()).toBe(true);
        expect(hasHolidaySettingsRequest()).toBe(false);
    });
});

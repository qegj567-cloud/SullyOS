import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, DailySchedule, UserProfile } from '../types';
import { DB } from './db';
import { getScheduleDateKey } from './scheduleTime';
import {
    generateDailyScheduleForChar,
    isScheduleGeneratingFor,
    isScheduleRetryBackedOff,
    requestDailySchedule,
    SCHEDULE_RETRY_BACKOFF_MS,
} from './scheduleGenerator';
import { putCloudGenJob } from './cloudGen/registry';
import { lander } from './cloudGen/landers/schedule';
import { HOME_VISITS_KEY, readHomeVisits } from './homeVisits';
import type { CloudGenJobRecord, CloudGenResponse, CloudGenSubmitInput } from './cloudGen/types';

const mocks = vi.hoisted(() => ({ submit: vi.fn(), markDirty: vi.fn() }));
vi.mock('./memoryPalace/pipeline', () => ({ injectMemoryPalace: vi.fn() }));
vi.mock('./chatContextRange', () => ({ loadCharacterContextRange: async () => ({ messages: [] }) }));
vi.mock('./cloudGen/submit', () => ({ trySubmitCloudGeneration: mocks.submit }));
vi.mock('./amsgStateSync', () => ({ markAmsgStateDirty: mocks.markDirty }));
vi.mock('./activeMsgRuntime', () => ({ loadRealtimeConfigFromLocalStorage: () => undefined }));

const user = { name: '小明' } as UserProfile;
const config = { baseUrl: 'https://test.invalid', apiKey: 'test', model: 'test-model' };
const makeChar = (id: string, extra: Partial<CharacterProfile> = {}) =>
    ({ id, name: id, scheduleFeatureEnabled: true, timeAwarenessEnabled: false, ...extra } as unknown as CharacterProfile);

const PAYLOAD = {
    slots: [
        { startTime: '14:00', activity: '画草稿', description: '拖稿中', emoji: '🎨' },
        { startTime: '09:00', activity: '买菜', emoji: '🥬' },
    ],
    flowNarrative: { morning: '早上好困……', afternoon: '  下午在画画  ', evening: '' },
};
const reply = (payload: object): CloudGenResponse => ({
    choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }],
});
const okFetch = (payload: object = PAYLOAD) =>
    vi.fn().mockImplementation(async () => new Response(JSON.stringify(reply(payload)), { headers: { 'Content-Type': 'application/json' } }));

const record = (charId: string, context: unknown, extra: Partial<CloudGenJobRecord> = {}): CloudGenJobRecord => ({
    jobId: `job-${charId}`, purpose: 'schedule', charId, charName: charId, uuid: `uuid-${charId}`,
    submittedAt: Date.now() - 5 * 60_000, snapshotAt: Date.now() - 5 * 60_000,
    status: 'running', notify: false, context, ...extra,
});
const info = (charId: string) => ({ jobId: `job-${charId}`, purpose: 'schedule' as const, charId });
const existingSchedule = (char: CharacterProfile): DailySchedule => {
    const date = getScheduleDateKey(char);
    return { id: `${char.id}_${date}`, charId: char.id, date, generatedAt: Date.now() - 60_000, slots: [{ startTime: '08:00', activity: '旧安排' }] };
};

beforeEach(() => {
    // 只假 Date：fake-indexeddb 和 vi.waitFor 要真定时器。固定在本地中午，测试不跨日。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 24, 12, 0, 0));
    localStorage.clear();
    mocks.submit.mockReset().mockResolvedValue({ route: 'local', reason: 'amsg2-off' });
    mocks.markDirty.mockReset();
    vi.spyOn(DB, 'getEmojis').mockResolvedValue([]);
    vi.spyOn(DB, 'getUserProfile').mockResolvedValue(user);
    vi.spyOn(DB, 'getGroups').mockResolvedValue([]);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('本机与云端用同一份请求', () => {
    it('本机请求体的字段、参数和调用记录标签保持原样', async () => {
        const fetch = okFetch();
        vi.stubGlobal('fetch', fetch);
        const char = makeChar('same-local');
        const result = await generateDailyScheduleForChar(char, user, config, true);
        const [url, init] = fetch.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(url).toBe('https://test.invalid/chat/completions');
        expect(Object.keys(body)).toEqual(['model', 'messages', 'temperature', 'max_tokens']);
        expect(body).toMatchObject({ model: 'test-model', temperature: 0.85, max_tokens: 8000 });
        expect(init.__sullyMeta).toEqual({ appName: '日程系统', charId: char.id, charName: char.name, purpose: '生成当日日程' });
        expect(body.messages.at(-1).content).toContain('## Task: 生成角色的今日日程');
        // 解析结果：按时间排序、独白去空白、空段丢掉
        expect(result?.slots.map(s => s.activity)).toEqual(['买菜', '画草稿']);
        expect(result?.flowNarrative).toEqual({ morning: '早上好困……', afternoon: '下午在画画' });
        expect(result?.id).toBe(`${char.id}_${getScheduleDateKey(char)}`);
    });

    it('交云端时 messages、参数、凭据和标签与本机那次完全一致，本机不再请求', async () => {
        const char = makeChar('same-cloud');
        // 不落库：否则第二次请求的上下文里会带上第一次生成的日程
        vi.spyOn(DB, 'saveDailySchedule').mockResolvedValue(undefined);
        const fetch = okFetch();
        vi.stubGlobal('fetch', fetch);
        await generateDailyScheduleForChar(char, user, config, true);
        const localBody = JSON.parse(fetch.mock.calls[0][1].body);
        const localMeta = fetch.mock.calls[0][1].__sullyMeta;

        mocks.submit.mockResolvedValue({ route: 'cloud', jobId: 'j1' });
        expect(await requestDailySchedule(char, user, config, true)).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        const input: CloudGenSubmitInput = mocks.submit.mock.calls[0][0];
        expect(input.purpose).toBe('schedule');
        expect(input.messages).toEqual(localBody.messages);
        expect(input.params).toEqual({ temperature: localBody.temperature, max_tokens: localBody.max_tokens });
        expect(input.api).toBe(config);
        expect(input.apiMeta).toEqual(localMeta);
        expect(input.context).toEqual({ date: getScheduleDateKey(char), force: true, homePrompt: false });
    });

    it('同一份响应，云端落地和本机解析出的日程一样（generatedAt 取交出时刻）', async () => {
        const char = makeChar('same-land');
        await DB.saveCharacter(char);
        vi.stubGlobal('fetch', okFetch());
        const local = await generateDailyScheduleForChar(char, user, config, true);
        const job = record(char.id, { date: getScheduleDateKey(char), force: true, homePrompt: false });
        expect(await lander.land(reply(PAYLOAD), job, info(char.id))).toBe('landed');
        const saved = await DB.getDailySchedule(char.id, getScheduleDateKey(char));
        expect({ ...saved, generatedAt: 0 }).toEqual({ ...local, generatedAt: 0 });
        expect(saved?.generatedAt).toBe(job.submittedAt);
        expect(mocks.markDirty).toHaveBeenCalledOnce();
    });

    it('busy 时既不交也不在本机生成', async () => {
        const fetch = okFetch();
        vi.stubGlobal('fetch', fetch);
        mocks.submit.mockResolvedValue({ route: 'busy', jobId: 'j0' });
        expect(await requestDailySchedule(makeChar('busy'), user, config, true)).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('落地规则', () => {
    it('角色当地已经翻到别的日子：丢弃', async () => {
        const char = makeChar('land-stale');
        await DB.saveCharacter(char);
        const save = vi.spyOn(DB, 'saveDailySchedule');
        expect(await lander.land(reply(PAYLOAD), record(char.id, { date: '2026-11-23', force: true, homePrompt: false }), info(char.id))).toBe('discarded');
        expect(save).not.toHaveBeenCalled();
    });

    it('自动生成的那份回来时这一天已有日程：丢弃，原日程不动', async () => {
        const char = makeChar('land-existing');
        await DB.saveCharacter(char);
        const old = existingSchedule(char);
        await DB.saveDailySchedule(old);
        expect(await lander.land(reply(PAYLOAD), record(char.id, { date: old.date, force: false, homePrompt: false }), info(char.id))).toBe('discarded');
        expect((await DB.getDailySchedule(char.id, old.date))?.slots).toEqual(old.slots);
    });

    it('手动重新生成 / 换风格（force）覆盖已有日程', async () => {
        const char = makeChar('land-force');
        await DB.saveCharacter(char);
        const old = existingSchedule(char);
        await DB.saveDailySchedule(old);
        expect(await lander.land(reply(PAYLOAD), record(char.id, { date: old.date, force: true, homePrompt: false }), info(char.id))).toBe('landed');
        expect((await DB.getDailySchedule(char.id, old.date))?.slots.map(s => s.activity)).toEqual(['买菜', '画草稿']);
    });

    it('请求时要了家园位置、落地时房间已删：按失败收尾，计入退避', async () => {
        const char = makeChar('land-room', {
            homeDefinition: { kind: 'between-worlds', notes: '' },
            home3D: { version: 1, activeRoomId: 'kept', rooms: [{ id: 'kept', name: '客厅', level: 0, x: 0, z: 0, items: [] }] },
        } as any);
        await DB.saveCharacter(char);
        const payload = { slots: [{ startTime: '15:00', activity: '直播', homePosition: { kind: 'home', roomId: 'deleted' } }] };
        expect(await lander.land(reply(payload), record(char.id, { date: getScheduleDateKey(char), force: true, homePrompt: true }), info(char.id)))
            .toEqual({ failed: expect.objectContaining({ code: 'invalid-output' }) });
        expect(await DB.getDailySchedule(char.id, getScheduleDateKey(char))).toBeNull();
        expect(isScheduleRetryBackedOff(char.id, getScheduleDateKey(char))).toBe(true);
    });

    it('开始时间已过的串门申请只丢这一项，日程照常保存', async () => {
        await DB.saveAsset(HOME_VISITS_KEY, JSON.stringify({ version: 1, visits: [] }));
        const host = makeChar('visit-host', { home3D: { version: 1, activeRoomId: 'r', rooms: [{ id: 'r', name: '客厅', level: 0, x: 0, z: 0, items: [] }] } } as any);
        const guest = makeChar('visit-guest', { phoneState: { contacts: [{ kind: 'real', linkedCharId: host.id, status: 'friend', affinity: 80 }] } } as any);
        await DB.saveCharacter(host);
        await DB.saveCharacter(guest);
        const payload = { ...PAYLOAD, homeVisits: [{ hostId: host.id, startTime: '08:00', endTime: '09:00', purpose: '串门' }] };
        expect(await lander.land(reply(payload), record(guest.id, { date: getScheduleDateKey(guest), force: true, homePrompt: false }), info(guest.id))).toBe('landed');
        expect((await DB.getDailySchedule(guest.id, getScheduleDateKey(guest)))?.slots).toHaveLength(2);
        expect(await readHomeVisits()).toEqual([]);
    });
});

describe('生成闸门按角色', () => {
    it('一个角色在生成时，同一角色不重复跑，另一个角色照常', async () => {
        const pending: Array<() => void> = [];
        const fetch = vi.fn().mockImplementation(() => new Promise<Response>(resolve => {
            pending.push(() => resolve(new Response(JSON.stringify(reply(PAYLOAD)))));
        }));
        vi.stubGlobal('fetch', fetch);
        const a = makeChar('gate-a');
        const b = makeChar('gate-b');
        const first = requestDailySchedule(a, user, config, true);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        expect(isScheduleGeneratingFor(a.id)).toBe(true);
        expect(isScheduleGeneratingFor(b.id)).toBe(false);
        expect(await requestDailySchedule(a, user, config, true)).toBeNull();
        expect(mocks.submit).toHaveBeenCalledTimes(1);

        const second = requestDailySchedule(b, user, config, true);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        pending.forEach(release => release());
        expect((await first)?.charId).toBe(a.id);
        expect((await second)?.charId).toBe(b.id);
        expect(isScheduleGeneratingFor(a.id)).toBe(false);
    });

    it('云端有一份在飞：算正在生成，不再拼请求也不再交', async () => {
        const char = makeChar('gate-cloud');
        putCloudGenJob(record(char.id, { date: getScheduleDateKey(char), force: false, homePrompt: false }));
        expect(isScheduleGeneratingFor(char.id)).toBe(true);
        const fetch = okFetch();
        vi.stubGlobal('fetch', fetch);
        expect(await requestDailySchedule(char, user, config, true)).toBeNull();
        expect(mocks.submit).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('失败退避', () => {
    it('本机失败后 30 分钟内不自动重试，手动重新生成不受限', async () => {
        const fetch = vi.fn().mockImplementation(async () => new Response('down', { status: 500 }));
        vi.stubGlobal('fetch', fetch);
        const char = makeChar('backoff-local');
        expect(await requestDailySchedule(char, user, config, false)).toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        await requestDailySchedule(char, user, config, false);
        expect(fetch).toHaveBeenCalledTimes(1);
        await requestDailySchedule(char, user, config, true);
        expect(fetch).toHaveBeenCalledTimes(2);
        vi.setSystemTime(Date.now() + SCHEDULE_RETRY_BACKOFF_MS + 1000);
        await requestDailySchedule(char, user, config, false);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('云端失败（onFailed 或登记表里的 failed 记录）同样进退避，只管同一天', async () => {
        const char = makeChar('backoff-cloud');
        const date = getScheduleDateKey(char);
        await lander.onFailed!(record(char.id, { date, force: false, homePrompt: false }), { code: 'x', message: 'x' });
        expect(isScheduleRetryBackedOff(char.id, date)).toBe(true);
        expect(isScheduleRetryBackedOff(char.id, '2026-11-25')).toBe(false);

        // 刷新后内存没了，靠登记表那条 failed 撑住
        const other = makeChar('backoff-registry');
        putCloudGenJob(record(other.id, { date, force: false, homePrompt: false }, { status: 'failed', settledAt: Date.now() }));
        expect(isScheduleRetryBackedOff(other.id, date)).toBe(true);
        vi.setSystemTime(Date.now() + SCHEDULE_RETRY_BACKOFF_MS + 1000);
        expect(isScheduleRetryBackedOff(other.id, date)).toBe(false);
    });
});

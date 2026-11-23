import { describe, it, expect } from 'vitest';

import { ChatPrompts } from './chatPrompts';
import { tzAwarenessNote } from './timezone';

// 即时对话（timelyByWorker）这份 prompt 交给 worker 补时钟。时钟由 worker 补，
// 跟时钟同属本地时间块、又不随时间变的内容要留在前端这份里，开头那句框定也不能再
// 提「当前时间」。云端主动消息模板（forFirePack）的记忆调取教学跟随用户开关。

const userProfile = { name: '小明' } as any;
const baseChar = (over: Record<string, unknown> = {}) => ({ id: 'char-timely-parity', name: '阿一', ...over }) as any;

const build = (char: any, options: Record<string, unknown>) => ChatPrompts.buildSystemPromptParts(
    char, userProfile, [], [], [], [],
    undefined, undefined, undefined, undefined, undefined, undefined, options,
);

const NY_NOTE = tzAwarenessNote('America/New_York').trim();
const customTz = { customTimezoneEnabled: true, customTimezone: 'America/New_York' };

describe('即时对话的实时状态段', () => {
    it('开头不再说包含「当前时间」，本地照旧', async () => {
        const cloud = await build(baseChar(), { timelyByWorker: true });
        expect(cloud.volatileState).toContain('以下是此刻的实时状态');
        expect(cloud.volatileState).not.toContain('当前时间、');
        const local = await build(baseChar(), {});
        expect(local.volatileState).toContain('以下是此刻的实时状态——当前时间、');
    });

    it('角色有自定义时区时带上时差说明，与本地同一句、各只出现一次', async () => {
        const cloud = await build(baseChar(customTz), { timelyByWorker: true });
        expect(cloud.volatileState.split(NY_NOTE)).toHaveLength(2);
        const local = await build(baseChar(customTz), {});
        expect(local.volatileState.split(NY_NOTE)).toHaveLength(2);
    });

    it('没开自定义时区、或关了时间感知时没有时差说明', async () => {
        expect((await build(baseChar(), { timelyByWorker: true })).volatileState).not.toContain('你身处');
        expect((await build(baseChar({ ...customTz, timeAwarenessEnabled: false }), { timelyByWorker: true })).volatileState)
            .not.toContain('你身处');
    });
});

describe('本地私聊的实时状态段', () => {
    it('关了时间感知时开头也不提「当前时间」，与即时对话那份一致', async () => {
        const local = await build(baseChar({ timeAwarenessEnabled: false }), {});
        const cloud = await build(baseChar({ timeAwarenessEnabled: false }), { timelyByWorker: true });
        expect(local.volatileState).not.toContain('当前时间、');
        expect(local.volatileState).toBe(cloud.volatileState);
    });

    it('主动消息打包（forFirePack）时这一段没有钟，开头也不提「当前时间」', async () => {
        const fire = await build(baseChar(), { forFirePack: true });
        expect(fire.volatileState).toContain('以下是此刻的实时状态');
        expect(fire.volatileState).not.toContain('当前时间、');
    });

    it('有时差时「对方那边几点」写的是用户名', async () => {
        const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const charTz = deviceTz === 'Pacific/Auckland' ? 'Asia/Tokyo' : 'Pacific/Auckland';
        const local = await build(baseChar({ customTimezoneEnabled: true, customTimezone: charTz }), { includeUserClock: true });
        expect(local.volatileState).toContain('小明那边现在是');
        expect(local.volatileState).not.toContain('对方那边现在是');
    });
});

describe('云端模板的记忆调取教学跟随「隐藏调取记忆提示」开关', () => {
    const recallRule = '- 调取记忆: `[[RECALL: YYYY-MM]]`';
    it.each([undefined, true])('开关缺省或开启（%s）时不教', async hideMonthlyRecallPrompt => {
        const fire = await build(baseChar({ hideMonthlyRecallPrompt }), { forFirePack: true });
        expect(fire.stable).not.toContain(recallRule);
    });
    it('开关关掉时教', async () => {
        const fire = await build(baseChar({ hideMonthlyRecallPrompt: false }), { forFirePack: true });
        expect(fire.stable).toContain(recallRule);
    });
});

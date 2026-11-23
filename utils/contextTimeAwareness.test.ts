import { describe, it, expect } from 'vitest';
import { ContextBuilder } from './context';

// 时间块贴在生成点前、注意力最强的位置，人设却躺在几千字之外的开头。只报一句
// 「现在是深夜 23:47」的话，模型每轮都会把话题收到「快睡吧」上，聊到哪都一样，
// 而用户往人设/世界书里怎么写都盖不过它。这句框定跟着时间一起注入，钉住它别丢。
//
// 措辞刻意全正向（只说时间该起什么作用，不点名任何要避开的话术）——把禁语写进
// 提示词反而会激活它，同 context.ts 里「表达底线」的设计。

const charAt = (timeAwarenessEnabled?: boolean) => ({
    id: 'char-time',
    name: '阿一',
    ...(timeAwarenessEnabled === undefined ? {} : { timeAwarenessEnabled }),
}) as any;

describe('时间块的分寸框定', () => {
    it('对话场合报时的同时说明时间该起什么作用', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined), { conversational: true });
        expect(block).toContain('现在是');
        expect(block).toContain('时间是你此刻所处的背景');
        expect(block).toContain('跟着你们正在说的事情走');
    });

    // 这个函数同样服务日程生成、歌单、攻略、手册、小剧场，以及角色跟角色之间的对话。
    // 那些场合没有「对方」在这个点跟你说话，末句会变成摆在注意力最强位置上的一句假话
    // ——日程生成器会以为用户正在聊天，角色间对话里的「对方」其实是另一个角色。
    it('没人在对话时只报时，不带那句语境框定', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined));
        expect(block).toContain('现在是');
        expect(block).not.toContain('时间是你此刻所处的背景');
        expect(block).not.toContain('还在跟你说话');
    });

    it('全正向：不靠列举要避开的话术来防守', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined), { conversational: true });
        expect(block).not.toContain('不要说');
        expect(block).not.toContain('禁止');
        expect(block).not.toContain('晚安');
    });

    it('时间感知关掉时整段都不出现，这句自然也不该单独漏出来', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(false));
        expect(block).toBe('');
    });

    it('见面纯架空（skipTimeAwareness）同样整段不出现', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(charAt(undefined), { skipTimeAwareness: true, conversational: true });
        expect(block).toBe('');
    });

    it('skipTimeAwareness 同时拦住今日实时日程注入', async () => {
        const char = {
            ...charAt(true),
            scheduleConfig: { enabled: true, style: 'conscious' },
        };
        const scheduleBlock = await ContextBuilder.buildCurrentScheduleContext(
            char,
            false,
            Promise.resolve({
                id: 'char-time_2026-11-03',
                charId: 'char-time',
                date: '2026-11-03',
                slots: [{ id: 's1', startTime: '08:00', activity: '晨跑', completed: false }],
                createdAt: 1,
            }),
            { skipTimeAwareness: true },
        );
        expect(scheduleBlock).toBe('');
    });
});

// 用户和角色时区不同时，本地报时也带「对方那边几点」那一行（与即时对话云端同一个函数）。
describe('报时处的对方时区参考', () => {
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const farTz = deviceTz === 'Pacific/Kiritimati' ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
    const tzChar = (tz: string) => ({ ...charAt(undefined), customTimezoneEnabled: true, customTimezone: tz });

    // 只有隔着手机的线上交流要这一行；见面和各类生成器默认不带，由调用方显式打开。
    it('默认不带，调用方没打开时即使时区不同也不出', () => {
        expect(ContextBuilder.buildTimeAwarenessBlock(tzChar(farTz), { conversational: true, userName: '小明' }))
            .not.toContain('那边现在是');
    });

    it('时区不同 → 带一行对方那边的时间，主语写明', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(tzChar(farTz), { conversational: true, userName: '小明', includeUserClock: true });
        expect(block).toContain('小明那边现在是');
        expect(block).toContain('别拿自己这边的钟去推断');
    });

    it('时区相同或没开自定义时区 → 不出', () => {
        expect(ContextBuilder.buildTimeAwarenessBlock(tzChar(deviceTz), { userName: '小明', includeUserClock: true })).not.toContain('那边现在是');
        expect(ContextBuilder.buildTimeAwarenessBlock(charAt(undefined), { userName: '小明', includeUserClock: true })).not.toContain('那边现在是');
    });

    it('报时那句时间观念提示引用共用常量（与云端时效块同一出处）', async () => {
        const { TIME_AWARENESS_NOTE } = await import('./timeFramingNote');
        expect(ContextBuilder.buildTimeAwarenessBlock(charAt(undefined))).toContain(TIME_AWARENESS_NOTE);
        const fs = await import('node:fs');
        const src = fs.readFileSync(new URL('./context.ts', import.meta.url), 'utf8');
        expect(src).not.toContain(TIME_AWARENESS_NOTE);
    });
});

// 线上聊天（私聊、群聊）打开这一行，见面是两个人在同一个地方，不带。
describe('对方时区参考按场合开关', () => {
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const farTz = deviceTz === 'Pacific/Kiritimati' ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
    const char = { id: 'char-clock-scope', name: '阿一', customTimezoneEnabled: true, customTimezone: farTz } as any;
    const user = { name: '小明' } as any;

    const payloadText = async (extra: Record<string, unknown>) => {
        const { buildChatRequestPayload } = await import('./chatRequestPayload');
        const payload = await buildChatRequestPayload({
            char, userProfile: user, groups: [], emojis: [], categories: [], contextLimit: 20,
            historyMsgs: [{ id: 1, charId: char.id, role: 'user', type: 'text', content: '在吗', timestamp: Date.now() }] as any[],
            ...extra,
        } as any);
        return payload.fullMessages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    };

    it('私聊带；家园手机、家园、彼方这些共用聊天管线的场合不带', async () => {
        expect(await payloadText({ recallEntryPoint: 'chat_app' })).toContain('小明那边现在是');
        expect(await payloadText({ recallEntryPoint: 'chat_app', homePhoneContext: '【家园手机聊天】' })).not.toContain('那边现在是');
        for (const recallEntryPoint of ['home_3d', 'world_home', 'vr_world', 'chat_payload', undefined]) {
            expect(await payloadText({ recallEntryPoint })).not.toContain('那边现在是');
        }
    });

    it('群聊成员上下文显式打开', async () => {
        const fs = await import('node:fs');
        const src = fs.readFileSync(new URL('../apps/GroupChat.tsx', import.meta.url), 'utf8');
        expect(src).toMatch(/worldbookMessages: liveGroupMsgs, conversational: true, includeUserClock: true/);
    });

    it('语音 / 视频通话的对话上下文显式打开', async () => {
        const fs = await import('node:fs');
        const src = fs.readFileSync(new URL('../apps/CallApp.tsx', import.meta.url), 'utf8');
        expect(src).toMatch(/timeOptions: \{ conversational: true, includeUserLocation: true, includeUserClock: true \}/);
    });

    it('见面开场和见面对话都不带', async () => {
        const { DatePrompts } = await import('./datePrompts');
        const join = (messages: Array<{ content: any }>) => messages
            .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
        const peek = await DatePrompts.buildPeekPayload({ char, userProfile: user, allMsgs: [], emojis: [] });
        expect(join(peek.messages)).toContain('现在是');
        expect(join(peek.messages)).not.toContain('那边现在是');
        const session = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs: [], emojis: [], userText: '到了', variant: 'send',
        });
        expect(join(session.messages)).not.toContain('那边现在是');
    });
});

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

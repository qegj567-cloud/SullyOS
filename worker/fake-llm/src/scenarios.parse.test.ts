import { afterEach, describe, expect, it, vi } from 'vitest';
import { planResponse, SIDE_EFFECT_TAGS, DATA_TAGS, type ReplyPlan } from './scenarios';
// 下面全是 App 的真实解析代码：标签语法一改，这里跟着挂，假模型的输出就不会变成过期数据。
import { classifyLLMOutput } from '../../amsg/src/classifier';
import { extractTransferCommands } from '../../../utils/transferFormat';
import { extractScheduleChangeDirectives } from '../../../utils/scheduleChangeParse';
import { extractFriendFeedReplyTags } from '../../../utils/friendFeedReplyFormat';
import { extractFireScheduleTextCalls } from '../../../utils/amsgFireSchedule';
import { sanitizeIntoSegments } from '../../../utils/sanitize';
import { ChatParser } from '../../../utils/chatParser';
import { DB } from '../../../utils/db';
import { readAssistantMessage, splitInlineThinking } from '../../../utils/assistantThinking';
import { extractContent } from '../../../utils/safeApi';

const userTurn = (text: string) => ({ model: 'fake/basic', messages: [{ role: 'system', content: '你是小明的朋友。' }, { role: 'user', content: text }] });
const contentOf = (model: string, text = '今天好累') => {
    const { plan } = planResponse({ ...userTurn(text), model });
    expect(plan.type).toBe('reply');
    return (plan as ReplyPlan).content;
};

afterEach(() => { vi.restoreAllMocks(); });

describe('副作用场景喂给云端分类器（worker/amsg/src/classifier.ts，前端工具循环也用它）', () => {
    const expected: Record<string, string> = {
        poke: 'poke', transfer: 'transfer', 'add-event': 'add_event', 'schedule-message': 'schedule_message',
        'change-schedule': 'change_schedule', music: 'music_action', news: 'news_card', life: 'life_record',
        'friend-feed': 'friend_feed_reply',
    };

    it.each(Object.entries(expected))('tag-%s → %s 指令', (tag, type) => {
        const result = classifyLLMOutput(contentOf(`fake/tag-${tag}`));
        expect(result.kind).toBe('finish');
        if (result.kind !== 'finish') return;
        expect(result.directives.map(d => d.type)).toContain(type);
        // 标签不能漏进给用户看的正文
        expect(result.sanitizedBody).not.toMatch(/\[\[|schedule_message \|/);
    });

    it('side-effects 合集一次带出全部指令', () => {
        const { plan } = planResponse({ model: 'fake/side-effects', messages: [{ role: 'system', content: '可以用 [schedule_message | 时间 | fixed | 内容] 排消息' }, { role: 'user', content: '在吗' }] });
        const result = classifyLLMOutput((plan as ReplyPlan).content);
        expect(result.kind).toBe('finish');
        if (result.kind !== 'finish') return;
        expect(new Set(result.directives.map(d => d.type))).toEqual(new Set(Object.values(expected)));
    });

    it('每个副作用标签都在合集里（提示词教过时），每个都有单独场景', () => {
        const taught = '[schedule_message | …] 以及 schedule_active_message({...})';
        const { plan } = planResponse({ model: 'fake/side-effects', messages: [{ role: 'system', content: taught }, { role: 'user', content: '在吗' }] }, 0);
        for (const name of Object.keys(SIDE_EFFECT_TAGS)) {
            const single = (planResponse({ model: `fake/tag-${name}`, messages: [{ role: 'user', content: '在吗' }] }, 0).plan as ReplyPlan).content;
            expect((plan as ReplyPlan).content).toContain(single.split('\n').pop());
        }
    });

    it('提示词没教的排程标签不进合集：没开 2.0 时正文排程会原样露成气泡', () => {
        const all = contentOf('fake/side-effects');
        expect(all).not.toContain('schedule_active_message');
        expect(all).not.toContain('[schedule_message');
    });

    it('引用只抄用户原话：App 给 user 消息加的「[时间] [聊天]」前缀会把 [[QUOTE: …]] 提前闭合', () => {
        const quote = contentOf('fake/tag-quote', '[2026-11-27 02:23] [聊天] #fake:tag-quote 今天好累');
        expect(quote.split('\n')[0]).toBe('[[QUOTE: 今天好累]]');
    });

    it.each([['recall', 'recall'], ['search', 'web_search']])('tag-%s 是回连标签，分类成工具请求 %s', (tag, name) => {
        const result = classifyLLMOutput(contentOf(`fake/tag-${tag}`));
        expect(result.kind).toBe('tool-request');
        if (result.kind !== 'tool-request') return;
        expect(result.toolCalls.map(c => c.function.name)).toEqual([name]);
    });
});

describe('副作用场景喂给前端各自的解析器', () => {
    it('转账：extractTransferCommands 认出一笔给用户的转账', () => {
        expect(extractTransferCommands(contentOf('fake/tag-transfer')).events).toEqual([expect.objectContaining({ kind: 'send', amount: expect.anything() })]);
    });

    it('改日程：extractScheduleChangeDirectives 认出时段', () => {
        expect(extractScheduleChangeDirectives(contentOf('fake/tag-change-schedule')).directives).toEqual([{ startTime: '18:30', activity: '去超市' }]);
    });

    it('2.0 正文排程：extractFireScheduleTextCalls 认出调用和参数', () => {
        const calls = extractFireScheduleTextCalls(contentOf('fake/tag-amsg-schedule'));
        expect(calls).toHaveLength(1);
        expect(calls[0].args).toMatchObject({ send_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} 09:00$/) });
    });

    it('哔哔：从提示词里抄到真实 requestId 和 postId', () => {
        const prompt = '在正常回复末尾输出 [[FRIEND_FEED_REPLY:{"requestId":"ffr_1","kind":"comment","postId":"p_9","comment":"1–2000字评论"}]]。';
        const { plan } = planResponse({ model: 'fake/tag-friend-feed', messages: [{ role: 'system', content: prompt }, { role: 'user', content: '在吗' }] });
        const { actions } = extractFriendFeedReplyTags((plan as ReplyPlan).content);
        expect(actions).toEqual([expect.objectContaining({ requestId: 'ffr_1', postId: 'p_9', kind: 'comment' })]);
    });

    it('表情包：splitResponse 切出单独的表情段', () => {
        expect(ChatParser.splitResponse(contentOf('fake/tag-sticker')).map(p => p.type)).toEqual(['text', 'emoji', 'text']);
    });

    it('戳一戳、转账、纪念日、新闻卡、定时消息：parseAndExecuteActions 真的落库', async () => {
        const saved = vi.spyOn(DB, 'saveMessage').mockResolvedValue(undefined as any);
        const anniversary = vi.spyOn(DB, 'saveAnniversary').mockResolvedValue(undefined as any);
        const scheduled = vi.spyOn(DB, 'saveScheduledMessage').mockResolvedValue(undefined as any);
        vi.spyOn(DB, 'getLatestHotNewsSnapshot').mockResolvedValue(null as any);
        const content = ['poke', 'transfer', 'add-event', 'news', 'schedule-message'].map(t => contentOf(`fake/tag-${t}`)).join('\n');
        const out = await ChatParser.parseAndExecuteActions(content, 'c-fake', '小明', () => {});
        expect(out).not.toMatch(/\[\[|\[schedule_message/);
        expect(saved.mock.calls.map(c => c[0].type)).toEqual(expect.arrayContaining(['interaction', 'transfer', 'news_card']));
        expect(anniversary).toHaveBeenCalledTimes(1);
        expect(scheduled).toHaveBeenCalledWith(expect.objectContaining({ content: '早安，这是假模型排的消息' }));
    });
});

describe('分句与思考链', () => {
    it('multi-part 在云端切成多条推送，前端切成多个气泡', () => {
        const content = contentOf('fake/multi-part');
        expect(sanitizeIntoSegments(content).length).toBeGreaterThanOrEqual(5);
        expect(ChatParser.chunkText(content).length).toBeGreaterThanOrEqual(5);
    });

    it('thinking-field 走 reasoning_content，正文干净', () => {
        const { plan } = planResponse({ ...userTurn('嗨'), model: 'fake/thinking-field' });
        const parts = readAssistantMessage({ content: (plan as ReplyPlan).content, reasoning_content: (plan as ReplyPlan).reasoning });
        expect(parts.reasoning).toContain('先想一想');
        expect(parts.content).not.toContain('先想一想');
    });

    it('thinking-tag 的 <think> 块被拆出去', () => {
        const split = splitInlineThinking(contentOf('fake/thinking-tag'));
        expect(split.reasoning).toContain('先想一想');
        expect(split.content).not.toContain('<think>');
    });

    it('thinking-only 按空回复处理：extractContent 不拿思考补正文', () => {
        const { plan } = planResponse({ ...userTurn('嗨'), model: 'fake/thinking-only' });
        const p = plan as ReplyPlan;
        expect(extractContent({ choices: [{ message: { role: 'assistant', content: p.content, reasoning_content: p.reasoning }, finish_reason: 'stop' }] })).toBe('');
    });
});

it('DATA_TAGS 和 SIDE_EFFECT_TAGS 不重名（场景名 tag-<name> 共用一个命名空间）', () => {
    expect(Object.keys(DATA_TAGS).filter(k => k in SIDE_EFFECT_TAGS)).toEqual([]);
});

it('回连那一轮之后，App 交回工具结果时给收尾正文，不再重复打标签', () => {
    const lead = contentOf('fake/basic', '#fake:tag-recall 上个月聊了啥').split('\n')[0];
    // 照前端工具循环的样子：上一轮正文（剥掉回连标签）+ 一条 [系统: …] 工具结果；
    // 场景写在第一轮的 #fake: 里，这一轮已经读不到了。
    const { plan, scenario } = planResponse({ model: 'fake/basic', messages: [
        { role: 'user', content: '#fake:tag-recall 上个月聊了啥' },
        { role: 'assistant', content: lead },
        { role: 'user', content: '[系统: 你调取某个月的记忆，拿回了下面这些]\n{"ok":false}' },
    ] });
    expect(scenario).toBe('follow-up');
    expect(classifyLLMOutput((plan as ReplyPlan).content).kind).toBe('finish');
    expect((plan as ReplyPlan).content).toContain('工具结果拿到了');
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { DatePrompts } from './datePrompts';
import { buildChatRequestPayload } from './chatRequestPayload';
import type { CharacterProfile, Message, UserProfile } from '../types';

// 检查实际请求：若历史时间戳或开场提示绕过开关，这些用例必须失败。
const user = { name: '楪', bio: '' } as UserProfile;
const now = new Date(2026, 9, 2, 2, 17);
const storyTime = '2099年夏天早上八点';
const makeChar = (chatTimeOn?: boolean, dateTimeOn?: boolean): CharacterProfile => ({
    id: 'time-awareness-request', name: '小白', avatar: '', description: '',
    systemPrompt: `剧情时间是${storyTime}。`, memories: [],
    timeAwarenessEnabled: chatTimeOn, dateTimeAwarenessEnabled: dateTimeOn,
} as CharacterProfile);
const makeHistory = (): Message[] => [
    { id: 1, charId: 'time-awareness-request', role: 'assistant', type: 'text',
        content: '[normal] 我们一起出发吧。', timestamp: new Date(2026, 9, 2, 0, 17).getTime(),
        metadata: { source: 'date' } },
    { id: 2, charId: 'time-awareness-request', role: 'user', type: 'text',
        content: `现在是${storyTime}，继续剧情。`, timestamp: now.getTime() },
];
const textOf = (messages: Array<{ content: any }>): string => messages
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
    .join('\n');

beforeEach(() => { vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe.each([
    { chatTimeOn: false, dateTimeOn: false },
    { chatTimeOn: false, dateTimeOn: true },
    { chatTimeOn: true, dateTimeOn: false },
    { chatTimeOn: true, dateTimeOn: true },
])('时间开关独立：聊天=$chatTimeOn，见面=$dateTimeOn', ({ chatTimeOn, dateTimeOn }) => {
    it('线上完整请求只跟随聊天开关，且保留剧情原文与消息存档', async () => {
        const history = makeHistory();
        const original = structuredClone(history);
        const payload = await buildChatRequestPayload({
            scene: 'chat.private',
            char: makeChar(chatTimeOn, dateTimeOn), userProfile: user,
            groups: [], emojis: [], categories: [], historyMsgs: history, contextLimit: 20,
        });
        const text = textOf(payload.fullMessages);
        expect(text.includes('[2026-10-02 02:17]')).toBe(chatTimeOn);
        expect(text.includes('### 当前时间 (Now)')).toBe(chatTimeOn);
        expect(text.includes('距离上一条消息')).toBe(chatTimeOn);
        expect(text).toContain(storyTime);
        expect(text).toContain('[约会]');
        expect(history).toEqual(original);
    });

    it.each(['send', 'reroll'] as const)('见面 %s 完整请求只跟随线下开关', async variant => {
        const payload = await DatePrompts.buildSessionPayload({
            char: makeChar(chatTimeOn, dateTimeOn), userProfile: user,
            allMsgs: makeHistory(), emojis: [], userText: `继续${storyTime}的剧情。`, variant,
        });
        const text = textOf(payload.messages);
        expect(text.includes('[2026-10-02 00:17]')).toBe(dateTimeOn);
        expect(text.includes('**Time**: 当前时间')).toBe(dateTimeOn);
        if (!dateTimeOn) expect(text).not.toContain('### 当前时间 (Now)');
        expect(text).toContain(storyTime);
        expect(text).toContain('[约会]');
    });

    it.each(['approach', 'invite'] as const)('%s 开场关闭时不按现实跳过时间，也不假定刚刚还在聊天', async openingMode => {
        const payload = (await DatePrompts.buildPeekPayload({
            char: makeChar(chatTimeOn, dateTimeOn), userProfile: user,
            allMsgs: makeHistory().slice(0, 1), emojis: [], openingMode,
        }));
        const text = textOf(payload.messages);
        expect(text.includes('[2026-10-02 00:17]')).toBe(dateTimeOn);
        expect(text.includes('当前时间:')).toBe(dateTimeOn);
        expect(text.includes('距离上次互动: 2 小时')).toBe(dateTimeOn);
        expect(text.includes('现在是深夜/清晨')).toBe(dateTimeOn);
        if (!dateTimeOn) {
            expect(text).not.toContain('TIME SKIP');
            expect(text).not.toContain('刚刚还在聊天');
            expect(text).toContain('剧情时间');
        }
    });
});

it.each([false, true])('见面历史的互动间隔按线下开关决定：$0', async dateTimeOn => {
    const history = makeHistory();
    // 最后一条是本轮输入；前两条历史之间隔了两小时，不能让聊天开关越过线下设置。
    history.push({ ...history[1], id: 3, timestamp: now.getTime() + 1000 });
    const payload = await DatePrompts.buildSessionPayload({
        char: makeChar(!dateTimeOn, dateTimeOn), userProfile: user,
        allMsgs: history, emojis: [], userText: '继续剧情。', variant: 'send',
    });
    expect(textOf(payload.messages).includes('距离上一条消息: 2 小时')).toBe(dateTimeOn);
});

it('缺省开关仍开启，见面按角色时区报时', async () => {
    vi.setSystemTime(new Date('2026-10-01T17:17:00Z'));
    const char = { ...makeChar(), customTimezoneEnabled: true, customTimezone: 'UTC' };
    const history = makeHistory();
    history[0].timestamp = new Date('2026-10-01T15:17:00Z').getTime();
    const payload = await DatePrompts.buildSessionPayload({
        char, userProfile: user, allMsgs: history, emojis: [], userText: '继续剧情。', variant: 'send',
    });
    expect(textOf(payload.messages)).toContain('[2026-10-01 15:17]');
    expect(textOf(payload.messages)).toContain('当前时间 2026-10-01 17:17');
});

it.each([
    { type: 'text', content: '2099-07-01 08:00 出发。' },
    { type: 'image', content: 'https://example.com/story.jpg' },
    { type: 'image', content: 'https://example.com/story.jpg', metadata: { visionDescription: '画面里是八点的钟。' } },
    { type: 'interaction', content: '' },
    { type: 'html_card', content: '{"title":"行程","content":"早上八点出发"}' },
] as Partial<Message>[])('关闭感知也遮住 $type 消息的时间戳', override => {
    const message = { ...makeHistory()[1], ...override };
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        [message], 20, makeChar(false, true), user, [], undefined, { useVisionDescriptions: true },
    );
    const text = textOf(apiMessages);
    expect(text).not.toContain('[2026-10-02 02:17]');
    if (override.type === 'text') expect(text).toContain(override.content);
    if (override.type === 'image' && !override.metadata) expect(text).toContain(override.content);
    if (override.metadata?.visionDescription) expect(text).toContain(override.metadata.visionDescription);
});

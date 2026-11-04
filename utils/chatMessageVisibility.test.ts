import { afterEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import { isChatPreviewMessage, isVisibleChatMessage, chatPreviewText } from './chatMessageVisibility';
import type { Message } from '../types';

const message = (overrides: Partial<Message> = {}): Message => ({
    id: 1, charId: 'visibility', role: 'assistant', type: 'text', content: '晚安', timestamp: 1,
    ...overrides,
});
let sequence = 0;
const nextCharId = () => `chat-visibility-${++sequence}`;

afterEach(() => localStorage.clear());

describe('私聊与桌面预览的消息范围', () => {
    it.each([undefined, 'chat', 'home'])('秘密只在历史操作中查看，普通聊天和桌面始终隐藏（%s）', source => {
        const note = message({ role: 'system', type: 'secret_note', content: '纸条正文', metadata: { source } });
        expect(isVisibleChatMessage(note)).toBe(false);
        expect(isVisibleChatMessage(note, true)).toBe(false);
        expect(isChatPreviewMessage(note)).toBe(false);
    });
    it('图片与表情只显示类型标签，不泄漏底层存储引用', () => {
        expect(chatPreviewText(message({ type: 'image', content: 'blobref:private' }))).toBe('[图片]');
        expect(chatPreviewText(message({ type: 'emoji', content: 'https://example.com/emoji.png' }))).toBe('[表情]');
        expect(chatPreviewText(message({ content: 'data:image/png;base64,abc' }))).toBe('[图片]');
        expect(chatPreviewText(message())).toBe('晚安');
    });
    it.each(['date', 'call', 'home', 'story_theater_memory'])('%s 正文不出现在私聊和桌面消息卡', source => {
        const row = message({ metadata: { source } });
        expect(isVisibleChatMessage(row)).toBe(false);
        expect(isChatPreviewMessage(row)).toBe(false);
    });

    it('主动消息正文、旧记录和通话后的私聊回信仍然显示', () => {
        expect(isVisibleChatMessage(message())).toBe(true);
        expect(isChatPreviewMessage(message())).toBe(true);
        expect(isChatPreviewMessage(message({ metadata: { source: 'call-end-popup' } }))).toBe(true);
        expect(isVisibleChatMessage(message({ role: 'user', metadata: { proactiveHint: true, hidden: true } }))).toBe(false);
        expect(isChatPreviewMessage(message({ groupId: 'group' }))).toBe(false);
    });

    it('桌面隐藏系统消息，聊天的隐藏日志设置仍保留评分卡', () => {
        const log = message({ role: 'system' });
        expect(isVisibleChatMessage(log)).toBe(true);
        expect(isVisibleChatMessage(log, true)).toBe(false);
        expect(isVisibleChatMessage(message({ role: 'system', type: 'score_card' }), true)).toBe(true);
        const comment = message({role: 'system', type: 'friend_feed_card', metadata: {source: 'friend_feed'}});
        expect(isVisibleChatMessage(comment, true)).toBe(true);
        expect(isChatPreviewMessage(comment)).toBe(false); // Quiet history, never a new private reply notification.
        expect(isChatPreviewMessage(log)).toBe(false);
    });
});

describe('先按显示范围过滤，再计算最近 N 条', () => {
    it('纸条留在原始历史计数中，但不占普通聊天的可见分页位置', async () => {
        const charId = nextCharId();
        const ids: number[] = [];
        for (let i = 0; i < 35; i++) {
            ids.push(await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: `回复 ${i}` }));
            await DB.saveMessage({ charId, role: 'system', type: 'secret_note', content: `秘密 ${i}` });
        }
        const page = await DB.getRecentMessagesWithCount(charId, 30, isVisibleChatMessage);
        expect(page.messages.map(m => m.id)).toEqual(ids.slice(-30));
        expect(page.totalCount).toBe(70);
        expect(await DB.getMessagesByCharId(charId, true)).toHaveLength(70);
    });
    it('大量见面/通话/隐藏提示不能挤掉已保存的主动消息，桌面和聊天均能找到它', async () => {
        const charId = nextCharId();
        const saved = await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: '该出门了' });
        for (let i = 0; i < 60; i++) {
            await DB.saveMessage({
                charId, role: 'user', type: 'text', content: '其他界面或内部提示',
                metadata: i % 3 === 0 ? { proactiveHint: true, hidden: true } : { source: i % 3 === 1 ? 'date' : 'call' },
            });
        }
        const chat = await DB.getRecentMessagesWithCount(charId, 30, isVisibleChatMessage);
        const preview = await DB.getRecentMessagesWithCount(charId, 1, isChatPreviewMessage);
        expect(chat.messages.map(m => m.id)).toEqual([saved]);
        expect(preview.messages.map(m => m.id)).toEqual([saved]);
        // 只改读取，不删见面/通话记录，也不改变模型的上下文读取。
        expect(await DB.getMessagesByCharId(charId, true)).toHaveLength(61);
    });

    it('分页仍按消息顺序返回完整一页，并跳过大量系统日志', async () => {
        const charId = nextCharId();
        const ids: number[] = [];
        for (let i = 0; i < 35; i++) {
            ids.push(await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: `消息 ${i}` }));
            await DB.saveMessage({ charId, role: 'system', type: 'text', content: '日志' });
        }
        const recent = await DB.getRecentMessagesWithCount(charId, 30, m => isVisibleChatMessage(m, true));
        expect(recent.messages.map(m => m.id)).toEqual(ids.slice(-30));
    });

    it('记忆处理水位不影响桌面预览和可回看的聊天', async () => {
        const charId = nextCharId();
        const id = await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: '旧聊天仍能回看' });
        localStorage.setItem(`mp_lastMsgId_${charId}`, String(id));
        expect(await DB.getMessagesByCharId(charId)).toEqual([]);
        const preview = await DB.getRecentMessagesWithCount(charId, 1, isChatPreviewMessage);
        expect(preview.messages.map(m => m.id)).toEqual([id]);
        expect(localStorage.getItem(`mp_lastMsgId_${charId}`)).toBe(String(id));
    });
});

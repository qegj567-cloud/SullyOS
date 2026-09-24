import { describe, expect, it } from 'vitest';
import { assertChatHasDialogue } from './chatRequestGuard';

describe('chat request empty dialogue guard', () => {
    it('blocks the reported four-system request with recovery instructions', () => {
        const messages = Array.from({ length: 4 }, () => ({ role: 'system', content: '角色提示词' }));
        expect(() => assertChatHasDialogue(messages)).toThrow('请再发一条消息');
        expect(messages).toHaveLength(4);
    });

    it('blocks empty history and tool-only or blank conversation content', () => {
        for (const messages of [
            [],
            [{ role: 'tool', content: '成功' }],
            [{ role: 'user', content: '  ' }, { role: 'assistant', content: null }],
            [{ role: 'user', content: [{ type: 'text', text: ' ' }, { type: 'image_url', image_url: { url: '' } }] }],
        ]) expect(() => assertChatHasDialogue(messages)).toThrow('没有找到可以回复的聊天内容');
    });

    it('allows user text, assistant continuation and image-only requests without mutation', () => {
        for (const message of [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '还想说一句' },
            { role: 'user', content: [{ type: 'text', text: '你好' }] },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
        ]) {
            const messages = [{ role: 'system', content: '提示词' }, message];
            const before = JSON.stringify(messages);
            expect(() => assertChatHasDialogue(messages)).not.toThrow();
            expect(JSON.stringify(messages)).toBe(before);
        }
    });
});

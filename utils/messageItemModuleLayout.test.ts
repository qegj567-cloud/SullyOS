import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';
import MessageItem from '../components/chat/MessageItem';

const activeTheme = {
    id: 'test-theme',
    name: 'Test',
    user: {},
    ai: {},
} as any;

const renderMessage = (
    msg: Message,
    moduleAlign: 'anchor' | 'center' = 'center',
    avatarMode: 'grouped' | 'every_message' = 'every_message',
) => renderToStaticMarkup(React.createElement(MessageItem, {
    msg,
    isFirstInGroup: true,
    isLastInGroup: true,
    activeTheme,
    charAvatar: 'https://example.com/char.png',
    charName: '角色',
    userAvatar: 'https://example.com/user.png',
    onLongPress: vi.fn(),
    onReply: vi.fn(),
    selectionMode: false,
    isSelected: false,
    onToggleSelect: vi.fn(),
    avatarMode,
    moduleAlign,
}));

const htmlCard = (): Message => ({
    id: 1,
    charId: 'char-1',
    role: 'assistant',
    type: 'html_card',
    content: '[HTML卡片]',
    timestamp: 1,
    metadata: { htmlSource: '<div>hello</div>' },
});

const musicCard = (): Message => ({
    id: 2,
    charId: 'char-1',
    role: 'assistant',
    type: 'music_card',
    content: '[音乐卡片]',
    timestamp: 2,
    metadata: {
        intent: 'join',
        song: { songId: 7, name: 'Song', artists: 'Artist', albumPic: '' },
    },
});

describe('MessageItem module layout', () => {
    it('renders an XHS card as a real note link with a visible copy-link hint', () => {
        const markup=renderMessage({...htmlCard(),type:'xhs_card',metadata:{xhsNote:{
            noteId:'a'.repeat(24),title:'晚饭',xsecToken:'abc+=',xsecSource:'pc_search',
        }}} as Message);
        expect(markup).toContain('<a href="https://www.xiaohongshu.com/');
        expect(markup).toContain('xsec_token=abc%2B%3D');
        expect(markup).toContain('xsec_source=pc_search');
        expect(markup).toContain('rel="noopener noreferrer"');
        expect(markup).toContain('长按此处复制链接');
    });
    const moduleModes = [
        ['center', 'grouped'],
        ['center', 'every_message'],
        ['anchor', 'grouped'],
        ['anchor', 'every_message'],
    ] as const;

    it.each(moduleModes)('HTML 卡片在 %s / %s 模式都不渲染消息外侧头像', (align, avatarMode) => {
        const markup = renderMessage(htmlCard(), align, avatarMode);
        expect(markup).not.toContain('alt="avatar"');
        expect(markup).toContain('sully-html-wrap');
        expect(markup).toContain(align === 'center' ? 'sully-chat-message-ai justify-center' : 'sully-chat-message-ai justify-start');
        expect(markup).toContain(align === 'center' ? 'w-fit max-w-full mx-auto sully-html-wrap' : 'max-w-[72%] ml-12 sully-html-wrap');
        expect(markup).toContain('w-[280px] max-w-full');
        expect(markup).toContain('block w-full min-h-[120px]');
        expect(markup).toContain('sully-html-source-bar');
        expect(markup).toContain('sully-html-source-toggle');
        expect(markup).toContain('aria-expanded="false"');
        expect(markup).toContain('aria-label="展开 HTML 源码操作"');
        expect(markup).toContain('aria-label="复制完整 HTML 源码"');
        expect(markup).toContain('完整源码');
        expect(markup).toContain('复制源码');
    });

    it.each(moduleModes)('一起听卡片在 %s / %s 模式跟随模块位置且没有消息外侧头像', (align, avatarMode) => {
        const markup = renderMessage(musicCard(), align, avatarMode);
        expect(markup).not.toContain('alt="avatar"');
        expect(markup).toContain(align === 'center' ? 'sully-chat-message-ai justify-center' : 'sully-chat-message-ai justify-start');
        expect(markup).toContain(align === 'center' ? 'w-fit max-w-full mx-auto sully-html-wrap' : 'max-w-[72%] ml-12 sully-html-wrap');
        // 卡片内部的“一起听”双头像仍保留；只移除消息外壳头像。
        expect(markup).toContain('https://example.com/user.png');
        expect(markup).toContain('https://example.com/char.png');
    });

    it('普通角色消息继续显示外侧头像', () => {
        const markup = renderMessage({
            id: 3,
            charId: 'char-1',
            role: 'assistant',
            type: 'text',
            content: '普通消息',
            timestamp: 3,
        });
        expect(markup).toContain('alt="avatar"');
        expect(markup).toContain('https://example.com/char.png');
    });

    it('心象卡片提供长按复制提示与独立交互入口', () => {
        const markup = renderMessage({
            id: 4,
            charId: 'char-1',
            role: 'assistant',
            type: 'text',
            content: '回复正文',
            timestamp: 4,
            metadata: { thinkingChain: '这是可以一键复制的完整心象。' },
        });

        expect(markup).toContain('aria-label="心象：点击展开，长按复制全文"');
        expect(markup).toContain('title="长按复制心象全文"');
        expect(markup).toContain('这是可以一键复制的完整心象');
        expect(markup).toContain('user-select:text');
        expect(markup).toContain('-webkit-touch-callout:default');
    });
});

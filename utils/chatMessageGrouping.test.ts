// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MessageItem from '../components/chat/MessageItem';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { renderChatDecorationSample } from '../components/chat/ChatDecorationSample';
import {
    CHAT_TIME_SEGMENT_GAP_MS,
    computeTimeSegmentStarts,
    formatChatTimeDivider,
    formatChatTimestamp,
    startsNewMessageGroup,
} from './chatMessageGrouping';
import { WHITEBOX_SCOPE_HINT, WHITEBOX_SCOPE_REGEX } from './chatWhitebox';
import { validateScopedCss } from './scopedCss';
import type { Message } from '../types';

const noop = () => {};

it('保留相隔十四分钟的头像和时间边界，同批短消息仍合组', () => {
    const first = { role: 'assistant' as const, timestamp: 1_000_000 };
    expect(startsNewMessageGroup(first, { ...first, timestamp: first.timestamp + 14 * 60_000 })).toBe(true);
    expect(startsNewMessageGroup(first, { ...first, timestamp: first.timestamp + 5 * 60_000 })).toBe(true);
    expect(startsNewMessageGroup(first, { ...first, timestamp: first.timestamp + 30_000 })).toBe(false);
    expect(startsNewMessageGroup(first, { ...first, role: 'user' })).toBe(true);
    expect(startsNewMessageGroup(null, first)).toBe(true);
});

describe('chatMessageGrouping & timestamp position', () => {
    it('segments top time dividers by 5-minute gaps across speakers while skipping system messages', () => {
        const t0 = new Date(2026, 10, 17, 14, 0, 0).getTime();
        const messages: Array<Pick<Message, 'role' | 'timestamp'>> = [
            { role: 'system', timestamp: t0 },
            { role: 'user', timestamp: t0 + 60_000 },
            { role: 'assistant', timestamp: t0 + 120_000 },
            { role: 'system', timestamp: t0 + 180_000 },
            { role: 'user', timestamp: t0 + 240_000 },
            { role: 'assistant', timestamp: t0 + 60_000 + CHAT_TIME_SEGMENT_GAP_MS + 240_000 },
        ];
        expect(computeTimeSegmentStarts(messages)).toEqual([
            false, // leading system notice never gets a conversation time divider
            true,  // first non-system message starts segment 1
            false, // +1 min, different speaker -> stays in segment 1
            false, // interleaved system notice skipped
            false, // +2 min from previous non-system -> stays in segment 1
            true,  // >= 5 min from previous non-system -> starts segment 2
        ]);
    });

    it('formats top time dividers across today, yesterday, same year, and cross-year in local time', () => {
        const now = new Date(2026, 10, 17, 18, 30, 0); // 2026-11-17 18:30 local
        expect(formatChatTimestamp(new Date(2026, 10, 17, 9, 5).getTime())).toBe('09:05');
        expect(formatChatTimeDivider(new Date(2026, 10, 17, 14, 2).getTime(), now)).toBe('14:02');
        expect(formatChatTimeDivider(new Date(2026, 10, 16, 23, 58).getTime(), now)).toBe('昨天 23:58');
        expect(formatChatTimeDivider(new Date(2026, 2, 8, 8, 15).getTime(), now)).toBe('3月8日 08:15');
        expect(formatChatTimeDivider(new Date(2025, 11, 31, 22, 40).getTime(), now)).toBe('2025年12月31日 22:40');
    });

    it('renders below-bubble timestamps by default and centered top dividers in top_center mode', () => {
        const basePreset = {
            format: 'sullyos-chat-decoration',
            version: 1,
            name: '时间测试',
            parts: { layout: { chatShowTimestamp: 'always' as const, chatTimestampPosition: 'below' as const } },
        };
        const belowHtml = renderChatDecorationSample(basePreset, 'conversation').markup;
        expect(belowHtml).toContain('sully-chat-timestamp-slot');
        expect(belowHtml).toContain('sully-chat-timestamp');
        expect(belowHtml).not.toContain('sully-chat-time-divider');

        const topPreset = {
            ...basePreset,
            parts: { layout: { chatShowTimestamp: 'always' as const, chatTimestampPosition: 'top_center' as const } },
        };
        const topHtml = renderChatDecorationSample(topPreset, 'conversation').markup;
        const dividerMatches = topHtml.match(/sully-chat-time-divider/g) || [];
        // All 4 sample messages in 'conversation' are within the same 5-minute window -> exactly 1 top divider at start
        expect(dividerMatches).toHaveLength(1);
        expect(topHtml).not.toContain('sully-chat-timestamp-slot');
        expect(topHtml).not.toContain('bg-black/[0.05]');
        expect(topHtml.indexOf('sully-chat-time-divider')).toBeLessThan(topHtml.indexOf('class="sully-chat-message '));

        const wechatTopPreset = {
            ...basePreset,
            parts: { layout: { chatShowTimestamp: 'always' as const, chatTimestampPosition: 'top_center' as const, chatBubbleStyle: 'wechat' as const } },
        };
        const wechatTopHtml = renderChatDecorationSample(wechatTopPreset, 'conversation').markup;
        expect(wechatTopHtml).toContain('bg-black/[0.05]');
        expect(wechatTopHtml).toContain('rounded-[4px]');

        const hiddenPreset = {
            ...basePreset,
            parts: { layout: { chatShowTimestamp: 'never' as const, chatTimestampPosition: 'top_center' as const } },
        };
        const hiddenHtml = renderChatDecorationSample(hiddenPreset, 'conversation').markup;
        expect(hiddenHtml).not.toContain('sully-chat-time-divider');
        expect(hiddenHtml).not.toContain('sully-chat-timestamp');
    });

    it('keeps Worker send progress below the bubble when timestampPosition is top_center', () => {
        const msg: Message = {
            id: 1,
            charId: 'char-1',
            role: 'user',
            type: 'text',
            content: '在吗？',
            timestamp: new Date(2026, 10, 17, 14, 32).getTime(),
        };
        const html = renderToStaticMarkup(
            React.createElement(MessageItem, {
                msg,
                isFirstInGroup: true,
                isLastInGroup: true,
                activeTheme: PRESET_THEMES.default,
                charAvatar: '',
                charName: '角色',
                userAvatar: '',
                onLongPress: noop,
                onReply: noop,
                selectionMode: false,
                isSelected: false,
                onToggleSelect: noop,
                showTimestamp: 'always',
                timestampPosition: 'top_center',
                startsTimeSegment: true,
                timestampNow: new Date(2026, 10, 17, 15, 0),
                sendPhase: 'sending',
            }),
        );
        expect(html).toContain('sully-chat-time-divider');
        expect(html).toContain('14:32');
        // Send progress stays in the below-bubble slot without duplicating timestamp text there
        expect(html).toContain('sully-chat-timestamp-slot');
        expect((html.match(/14:32/g) || [])).toHaveLength(1);
    });

    it('accepts timestamp hooks in scoped whitebox CSS validation', () => {
        const css = `
            .sully-chat-time-divider { margin: 14px 0 !important; }
            .sully-chat-timestamp { background: rgba(0, 0, 0, 0.06); padding: 2px 8px; border-radius: 999px; }
            .sully-chat-timestamp-slot { margin-top: 4px; }
        `;
        expect(validateScopedCss(css, WHITEBOX_SCOPE_REGEX, WHITEBOX_SCOPE_HINT).isValid).toBe(true);
    });
});

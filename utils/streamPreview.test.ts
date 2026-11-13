import { describe, it, expect } from 'vitest';
import {
    computeStreamPreviewBubbles,
    extractStreamingEmbeddedThinking,
    findNewStreamPreviewHandoverIds,
} from './streamPreview';
import type { Message } from '../types';

// 流式预览气泡的过滤策略：普通尾句持续增长；遇到指令/语音/翻译/日记/HTML 块时
// 只展示控制标记前的安全正文。最终渲染仍由 applyAssistantPostProcessing 负责。

describe('computeStreamPreviewBubbles', () => {
    it('无换行的当前尾句也实时展示', () => {
        expect(computeStreamPreviewBubbles('今天天气真好')).toEqual(['今天天气真好']);
    });

    it('已完成的行逐条成为气泡，最后的尾句持续增长', () => {
        const bubbles = computeStreamPreviewBubbles('今天天气真好\n要不要出去走走\n我在想');
        expect(bubbles).toEqual(['今天天气真好', '要不要出去走走', '我在想']);
    });

    it('未完成尾句只显示控制标记前的安全正文', () => {
        expect(computeStreamPreviewBubbles('先说一句，然后[[SEARCH: 半截')).toEqual(['先说一句，然后']);
        expect(computeStreamPreviewBubbles('<think>不能漏')).toEqual([]);
        expect(computeStreamPreviewBubbles('[html')).toEqual([]);
    });

    it('含 [[...]] 指令的行不预览（表情/动作/召回等）', () => {
        const text = '哼，看在你可怜的份上\n[[SEND_EMOJI: 傲娇]]\n[[RECALL: 2024-05]]\n明天见\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['哼，看在你可怜的份上', '明天见']);
    });

    it('定时消息指令行不预览', () => {
        const text = '晚安啦\n[schedule_message | 2026-07-15 08:00:00 | fixed | 早安！]\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['晚安啦']);
    });

    it('单行语音标签整行跳过', () => {
        const text = '先打个字\n<语音 emotion="happy">你猜猜我在干嘛？</语音>\n再打一行\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['先打个字', '再打一行']);
    });

    it('尚未换行、仍在增长的语音/字幕标签不会漏出内容', () => {
        expect(computeStreamPreviewBubbles('<语')).toEqual([]);
        expect(computeStreamPreviewBubbles('<语音 emotion="happy">你猜猜')).toEqual([]);
        expect(computeStreamPreviewBubbles('<语音>Hello</语音><字幕>你好')).toEqual([]);
    });

    it('跨行语音块（未闭合时全部扣住，闭合后仍不预览块内容）', () => {
        const open = '好\n<语音 emotion="sad">I do not wanna\n';
        expect(computeStreamPreviewBubbles(open)).toEqual(['好']);
        const closed = open + 'move anymore</语音>\n<字幕>不想动了</字幕>\n但是没办法\n';
        expect(computeStreamPreviewBubbles(closed)).toEqual(['好', '但是没办法']);
    });

    it('日记多行块不泄漏为聊天气泡', () => {
        const text = '我写篇日记去\n[[DIARY_START: 今天 | 开心]]\n# 大标题\n正文絮絮叨叨\n[[DIARY_END]]\n写完了\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['我写篇日记去', '写完了']);
    });

    it('飞书/Notion 同构日记块同样不泄漏', () => {
        const text = '稍等\n[[FS_DIARY_START: 今天 | 平静]]\n不该成为聊天气泡\n[[FS_DIARY_END]]\n好了\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['稍等', '好了']);
    });

    it('HTML 卡片块不泄漏', () => {
        const text = '给你做张卡\n[html]\n<div>card</div>\n[/html]\n好看吗\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['给你做张卡', '好看吗']);
    });

    it('think 块（content 内嵌形态）不泄漏', () => {
        const text = '<think>\n她这句话是什么意思…\n</think>\n没什么，随口一问\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['没什么，随口一问']);
    });

    it('双语翻译标签行不预览', () => {
        const text = '<翻译>\n<原文>こんにちは</原文>\n<译文>你好</译文>\n</翻译>\n';
        expect(computeStreamPreviewBubbles(text)).toEqual([]);
    });

    it('CJK 之间的空格按最终管线保留在同一个气泡', () => {
        const bubbles = computeStreamPreviewBubbles('你来了 坐吧\n');
        expect(bubbles).toEqual(['你来了 坐吧']);
    });

    it('空文本 / 纯空行返回空数组', () => {
        expect(computeStreamPreviewBubbles('')).toEqual([]);
        expect(computeStreamPreviewBubbles('\n\n')).toEqual([]);
    });
});

describe('extractStreamingEmbeddedThinking', () => {
    it('a closed block followed by an open block on the same line never leaks later lines', () => {
        const text='<think>第一段</think>你好<think>第二段\n不能上屏\n';
        expect(computeStreamPreviewBubbles(text)).toEqual(['你好']);
        expect(extractStreamingEmbeddedThinking(text)).toBe('第一段\n\n第二段\n不能上屏');
    });

    it('an unfinished multi-line opening tag stays hidden until it completes', () => {
        expect(computeStreamPreviewBubbles('你好\n<thinking\nmode="summary"\n')).toEqual(['你好']);
        expect(computeStreamPreviewBubbles('你好\n<thinking\nmode="summary">\n摘要\n')).toEqual(['你好']);
    });

    it('tag attributes and a closing space do not leak thoughts into preview', () => {
        const text='<thinking mode="summary">\n第一段\n</thinking >\n你好\n<thought>后半段\n';
        expect(extractStreamingEmbeddedThinking(text)).toBe('第一段\n\n后半段');
        expect(computeStreamPreviewBubbles(text)).toEqual(['你好']);
    });
    it('实时提取仍未闭合的 think 尾块', () => {
        expect(extractStreamingEmbeddedThinking('<think>刚想到这里')).toBe('刚想到这里');
    });

    it('合并已闭合块与后续仍在增长的块', () => {
        expect(extractStreamingEmbeddedThinking(
            '<think>第一段</think>正文<thinking>第二段还没写完',
        )).toBe('第一段\n\n第二段还没写完');
    });
});

describe('findNewStreamPreviewHandoverIds', () => {
    const message = (id: number, content: string, type: Message['type'] = 'text'): Message => ({
        id,
        charId: 'char-1',
        role: 'assistant',
        type,
        content,
        timestamp: id,
    });

    it('只匹配基线后确实展示过的文本，不误伤二次回复和卡片', () => {
        const messages = [
            message(10, '旧消息'),
            message(11, '第一句'),
            message(12, '表情', 'emoji'),
            message(13, '第二句'),
            message(14, '二次调用的新回复'),
        ];

        expect(findNewStreamPreviewHandoverIds(messages, ['第一句', '第二句'], 10, new Set()))
            .toEqual([11, 13]);
    });

    it('多次刷新消息列表时只返回尚未登记的接棒消息', () => {
        const claimed = new Set([11]);
        expect(findNewStreamPreviewHandoverIds(
            [message(10, '旧消息'), message(11, '第一句'), message(12, '第二句')],
            ['第一句', '第二句'],
            10,
            claimed,
        )).toEqual([12]);
    });
});

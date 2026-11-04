/**
 * 流式回复的「预览气泡」计算 —— 纯函数，无副作用。
 *
 * 主聊天路径开启 stream 后，边收流边把已完成行和安全的未完成尾句渲染成临时预览气泡
 * （utils/safeApi.ts StreamHooks.onDelta → hooks/useChatAI.ts → apps/Chat.tsx）。
 * 流结束后仍由既有后处理管线 (applyAssistantPostProcessing) 负责真正的解析、
 * 落库与渲染，预览气泡随即被清掉 —— 预览只影响体感延迟，不改变任何持久化行为。
 *
 * 因此这里的过滤策略是「宁缺毋滥」：拿不准的行（指令、语音/翻译/思考/日记/HTML 块、
 * 未闭合标签）一律不预览，等最终管线处理。漏显示只损失一点预览完整度；
 * 错显示（把 [[DIARY_START]] 的日记正文当聊天气泡弹出来）才是事故。
 *
 * 每次 onDelta 都基于累计全文全量重算（幂等）——safeFetchJson 内部重试会重开一条流、
 * 全文从头累计，全量重算天然处理这种重置。
 */

import { ChatParser } from './chatParser';
import {extractFriendFeedReplyTags} from './friendFeedReplyFormat';
import type { Message } from '../types';

/** 跨行块规则：open 命中进入抑制态，直到 close 命中（含闭合行本身）。 */
const BLOCK_RULES: Array<{ open: RegExp; close: RegExp }> = [
    // Notion / 飞书日记多行块 —— 正文是日记内容，不是聊天气泡
    { open: /\[\[(?:FS_)?DIARY_START/i, close: /\[\[(?:FS_)?DIARY_END\]\]/i },
    // HTML 卡片块
    { open: /\[html\]/i, close: /\[\/html\]/i },
    // 思考链（content 内嵌形态；reasoning_content 通道根本不进正文）
    { open: /<(?:think|thinking|thought)>/i, close: /<\/(?:think|thinking|thought)>/i },
    // 语音 / 字幕 / 双语翻译标签 —— 由最终管线成对解析渲染，预览一律不碰
    { open: /<[语語]音[^>]*>/, close: /<\/\s*[语語]音\s*>/ },
    { open: /<字幕>/, close: /<\/字幕>/ },
    { open: /<翻译>/, close: /<\/翻译>/ },
];

/** 单行级排除：含任何 [[...]] 指令、日程指令、双语标记的行不预览。 */
function isLinePreviewable(line: string): boolean {
    if (!line) return false;
    if (line.includes('[[')) return false;                    // SEND_EMOJI / QUOTE / ACTION / RECALL / XHS_* …
    if (/^\[schedule_message\s*\|/i.test(line)) return false; // 定时消息指令
    if (/%%BILINGUAL%%|%%TRANS%%/i.test(line)) return false;
    if (/<\/?(?:[语語]音|字幕|翻译|原文|译文|think|thinking|thought)\b/i.test(line)) return false;
    return true;
}

/**
 * 从「累计到目前为止的原始流文本」计算当前可展示的预览气泡。
 *
 * 已完成行按既有规则过滤；未完成尾句也会持续增长，但在 `[`, `<`, `%%`
 * 这类控制标记前截断，避免半截指令或标签泄漏到聊天气泡。
 */
export function computeStreamPreviewBubbles(fullText: string): string[] {
    if (!fullText) return [];
    fullText = extractFriendFeedReplyTags(extractFriendFeedReplyTags(fullText).text,'HOME_VISIT_REPLY').text;
    const lastNl = fullText.lastIndexOf('\n');
    const completed = lastNl < 0 ? '' : fullText.slice(0, lastNl);
    const trailing = lastNl < 0 ? fullText : fullText.slice(lastNl + 1);

    const kept: string[] = [];
    let inBlockClose: RegExp | null = null;
    for (const rawLine of completed.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (inBlockClose) {
            // 抑制态：只找闭合，闭合行本身也不展示
            if (inBlockClose.test(line)) inBlockClose = null;
            continue;
        }
        const opened = BLOCK_RULES.find(r => r.open.test(line));
        if (opened) {
            // 同行开闭（如单行 <语音>…</语音>）→ 该行整体跳过；否则进入抑制态
            const closeIdx = line.search(opened.close);
            const openIdx = line.search(opened.open);
            if (closeIdx < 0 || closeIdx <= openIdx) inBlockClose = opened.close;
            continue;
        }
        if (!isLinePreviewable(line)) continue;
        kept.push(line);
    }

    // Stream the unfinished tail too, but stop before a possible control/tag prefix.
    // This keeps ordinary one-paragraph replies live without flashing partial directives.
    if (!inBlockClose && trailing.trim()) {
        const markerIndexes = [trailing.indexOf('['), trailing.indexOf('<'), trailing.indexOf('%%')]
            .filter(index => index >= 0);
        const safeEnd = markerIndexes.length > 0 ? Math.min(...markerIndexes) : trailing.length;
        const safeTrailing = trailing.slice(0, safeEnd).trim();
        if (safeTrailing && isLinePreviewable(safeTrailing)) kept.push(safeTrailing);
    }
    if (kept.length === 0) return [];

    // 与最终管线同一套气泡切分（只认显式换行），再逐条 sanitize + 有效内容校验，
    // 让预览气泡的边界和内容尽量贴近最终落库的样子。
    const bubbles: string[] = [];
    for (const chunk of ChatParser.chunkText(kept.join('\n'))) {
        const clean = ChatParser.sanitize(chunk).trim();
        if (clean && ChatParser.hasDisplayContent(clean)) bubbles.push(clean);
    }
    return bubbles;
}

/** 提取普通 content 通道里已闭合或仍在增长的内嵌思考块。 */
export function extractStreamingEmbeddedThinking(fullText: string): string {
    if (!fullText) return '';
    const blocks: string[] = [];
    const closed = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
    let match: RegExpExecArray | null;
    let lastClosedEnd = 0;
    while ((match = closed.exec(fullText)) !== null) {
        const text = match[2].trim();
        if (text) blocks.push(text);
        lastClosedEnd = closed.lastIndex;
    }

    const tail = fullText.slice(lastClosedEnd);
    const open = tail.match(/<(?:think|thinking|thought)>([\s\S]*)$/i);
    if (open?.[1].trim()) blocks.push(open[1].trim());
    return blocks.join('\n\n').trim();
}

/**
 * 找出本轮真正由流式预览展示过、随后才落库的消息。
 *
 * 后处理可能还会追加二次 LLM 回复、表情或功能卡片；这些内容没有在预览里出现，
 * 不能一并禁用入场动画。因此按「基线后的 assistant 文本 + 预览正文顺序」精确匹配。
 * claimedIds 让多次 setMessages（A -> A+B -> A+B+C）只上报新接棒的 id。
 */
export function findNewStreamPreviewHandoverIds(
    messages: Message[],
    previewBubbles: readonly string[],
    baselineMaxId: number,
    claimedIds: ReadonlySet<number>,
): number[] {
    if (previewBubbles.length === 0) return [];

    const found: number[] = [];
    let previewIndex = 0;
    for (const message of messages) {
        if (
            message.id <= baselineMaxId
            || message.role !== 'assistant'
            || message.type !== 'text'
        ) continue;

        if (previewIndex >= previewBubbles.length) break;
        const persistedText = ChatParser.sanitize(message.content).trim();
        if (persistedText !== previewBubbles[previewIndex]) continue;

        if (!claimedIds.has(message.id)) found.push(message.id);
        previewIndex++;
    }
    return found;
}

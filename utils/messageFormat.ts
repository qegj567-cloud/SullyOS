/**
 * 消息内容规范化：把带特殊 type / metadata 的消息转成可读的单行文本。
 *
 * 适用所有"拼聊天上下文"的场景：
 *  - Chat.tsx / Character.tsx 手动归档
 *  - memoryPalace extraction / retrieval 提取上下文
 *  - 其它需要把 Message → prompt 文本的地方
 *
 * 历史问题：同样的 type-switch 逻辑在三个地方被复制粘贴过，差异演化后导致
 * palace 路径漏掉 score_card / system / transfer / interaction，总结里丢信息。
 * 抽到这里后单点维护。
 */

import type { Message } from '../types';
import { formatLifeSimResetCardForContext } from './lifeSimChatCard';

/** 仅返回内容体（不加 sender / timestamp）。调用方自行拼外层。 */
export function normalizeMessageContent(
    msg: Message,
    charName: string,
    userName: string,
): string {
    const type = msg.type as string;

    // 纯视觉/音频类：给个占位，别让 URL / base64 污染 LLM 上下文
    if (type === 'image') return '[图片]';
    if (type === 'emoji') return '[表情包]';
    if (type === 'voice') return '[语音]';

    // 系统交互事件
    if (type === 'interaction') return `[系统: ${userName}戳了${charName}一下]`;
    if (type === 'transfer') {
        const amt = msg.metadata?.amount;
        return amt !== undefined ? `[系统: ${userName}转账 ${amt}]` : `[系统: ${userName}转账]`;
    }

    // 结算卡：几种 app 产生，用字段逐一翻成自然文本
    if (type === 'score_card') {
        try {
            const card = msg.metadata?.scoreCard || JSON.parse(msg.content);
            if (card?.type === 'lifesim_reset_card') {
                return formatLifeSimResetCardForContext(card, charName);
            }
            if (card?.type === 'guidebook_card') {
                const diff = (card.finalAffinity ?? 0) - (card.initialAffinity ?? 0);
                return `[攻略本游戏结算] ${charName}和${userName}玩了一局"攻略本"恋爱小游戏（${card.rounds || '?'}回合）。结局：「${card.title || '???'}」 好感度变化：${card.initialAffinity} → ${card.finalAffinity}（${diff >= 0 ? '+' : ''}${diff}） ${charName}的评语：${card.charVerdict || '无'} ${charName}对${userName}的新发现：${card.charNewInsight || '无'}`;
            }
            if (card?.type === 'whiteday_card') {
                const passedStr = card.passed ? `通过测验，解锁了DIY巧克力` : `未通过测验`;
                const questionsText = (card.questions as any[])?.map((q: any, i: number) =>
                    `第${i + 1}题"${q.question}"：${userName}选"${q.userAnswer}"（${q.isCorrect ? '✓' : '✗'}）${q.review ? `，${charName}评语：${q.review}` : ''}`
                ).join('；') || '';
                return `[白色情人节默契测验] ${userName}完成了${charName}出的白色情人节测验，答对${card.score}/${card.total}题，${passedStr}。${questionsText}${card.finalDialogue ? `。${charName}最终评价：${card.finalDialogue}` : ''}`;
            }
            if (card?.type === 'like520_card') {
                // 520 特别活动：那个"小小的下午"+ char 给 user 的信。信的内容是这次活动的母题落点，
                // 归档 / 月度总结 / 向量召回都应该读到它，否则只是一个"[系统卡片]"占位会让前后文断层。
                const letter = (typeof card.letter === 'string' && card.letter.trim()) ? card.letter.trim() : '';
                const titlePart = card.title ? `结局「${card.title}」。` : '';
                const descPart = card.description ? `${card.description} ` : '';
                const letterPart = letter ? ` ${charName}写给${userName}的信原文：${letter}` : '';
                return `[520 特别活动] ${charName}和${userName}一起度过了"小小的下午"——${charName}"变小了"的版本被${userName}照顾着，最后${charName}对${userName}说了真心话，并写了一封信。${titlePart}${descPart}${letterPart}`;
            }
            // 其它结算卡类型（songwriting/study/lifesim 日常 等）：如果有 summary/content 字段优先用
            if (typeof card?.summary === 'string' && card.summary.trim()) return `[系统卡片] ${card.summary.trim()}`;
            return '[系统卡片]';
        } catch {
            return '[系统卡片]';
        }
    }

    // 系统消息（通话结束标记等）
    if (type === 'system' && msg.content) {
        return `[系统] ${msg.content}`;
    }

    // HTML 卡片：上下文 / 归档 / palace 都只看到剥离 HTML 后的纯文字摘要，
    // 避免 270px 的视觉 div 把上下文 token 全占了 + LLM 误把 HTML 当正经分析对象。
    if (type === 'html_card') {
        const meta: any = msg.metadata || {};
        const preview = (typeof meta.htmlTextPreview === 'string' && meta.htmlTextPreview)
            ? meta.htmlTextPreview
            : (typeof msg.content === 'string' ? msg.content.replace(/^\[HTML卡片\]\s*/, '') : '');
        return preview ? `[HTML卡片] ${preview}` : '[HTML卡片]';
    }

    // 音乐卡片：把 metadata.song + intent 翻成自然文本，否则归档/palace/向量只看到
    // "[音乐卡片]" 这种没信息量的占位，丢掉"谁因为什么歌做了什么"的语义
    if (type === 'music_card') {
        const song = msg.metadata?.song as { name?: string; artists?: string } | undefined;
        const intent = msg.metadata?.intent as 'join' | 'add' | 'join_and_add' | undefined;
        const addedTo = msg.metadata?.addedToPlaylistTitle as string | undefined;
        if (song?.name) {
            const songDesc = song.artists ? `《${song.name}》— ${song.artists}` : `《${song.name}》`;
            const action =
                intent === 'join' ? `决定和${userName}一起听这首`
                : intent === 'add' ? `把这首收进了自己的歌单${addedTo ? `《${addedTo}》` : ''}`
                : intent === 'join_and_add' ? `决定和${userName}一起听，也收进了自己的歌单${addedTo ? `《${addedTo}》` : ''}`
                : `对这首有了反应`;
            return `[音乐卡片] ${charName}${action}：${songDesc}`;
        }
        return '[音乐卡片]';
    }

    // 默认：text / 未知类型 → 用 content
    return msg.content || '';
}

/** 完整的"[发送者]: 内容"格式，用于 LLM prompt 里的对话拼接 */
export function formatMessageForPrompt(
    msg: Message,
    charName: string,
    userName: string,
): string {
    const sender = msg.role === 'user' ? userName
        : msg.role === 'system' ? '[系统]'
        : charName;
    return `[${sender}]: ${normalizeMessageContent(msg, charName, userName)}`;
}

/** 带时间戳的版本（归档常用）：`[HH:MM] 发送者: 内容` */
export function formatMessageWithTime(
    msg: Message,
    charName: string,
    userName: string,
    timeFormatter: (ts: number) => string,
): string {
    const sender = msg.role === 'user' ? userName
        : msg.role === 'system' ? '[系统]'
        : charName;
    const time = msg.timestamp > 0 ? timeFormatter(msg.timestamp) : '';
    const prefix = time ? `[${time}] ` : '';
    return `${prefix}${sender}: ${normalizeMessageContent(msg, charName, userName)}`;
}

/**
 * 判断一条消息是否"对 palace / archive 有语义价值"。
 *
 * pipeline 以前的过滤是 `type === 'text'`，这会漏掉 score_card / system /
 * transfer / interaction 等有内容的事件；纯二进制类型（image/emoji/voice）
 * 通过 normalize 会变成短占位符，LLM 看到也没帮助，直接过滤掉。
 */
export function isMessageSemanticallyRelevant(msg: Message): boolean {
    const type = msg.type as string;
    if (type === 'image' || type === 'emoji' || type === 'voice') return false;
    // 有内容或有结构化 metadata 才算
    return !!(msg.content?.trim() || msg.metadata?.scoreCard || msg.metadata?.amount || msg.metadata?.song);
}

// 群聊动作派发 —— 从 GroupChat.tsx triggerDirector 抽出的执行层（PRIVATE 侧信道、
// 表情包、气泡分段、打字延迟），导演模式与轮询模式共用。
import { DB } from '../db';
import { CharacterProfile, EmojiCategory, Message, Toast } from '../../types';
import { DirectorAction } from './parse';
import {
    GroupPacketMeta,
    PacketReceiptMeta,
    PacketCommand,
    ClaimResult,
    claimPacket,
    effectivePacketStatus,
    extractPacketCommands,
    makePacketMeta,
} from './redpacket';
import { normalizeAssistantEmojiFormatting } from '../assistantActionFormat';
import { extractHtmlBlocks } from '../htmlPrompt';

interface EmojiItem { name: string; url: string; categoryId?: string }

export interface DispatchContext {
    groupId: string;
    /** 群成员 id 列表——charId 不在其中的动作直接丢弃 */
    memberIds: string[];
    characters: CharacterProfile[];
    emojis: EmojiItem[];
    categories: EmojiCategory[];
    /** 每条气泡落库后刷新 UI（GroupChat 的 refreshMessages） */
    refresh: () => Promise<unknown>;
    addToast: (message: string, type?: Toast['type']) => void;
    /** 中途取消：每次延迟/落库前检查，aborted 后提前返回 */
    signal?: AbortSignal;
    /** [[QUOTE: 原话片段]] 解析：按片段找被引用消息，找不到返回 undefined（标记静默剥除） */
    resolveQuote?: (snippet: string) => { id: number; content: string; name: string } | undefined;
    /** 用户显示名——红包目标解析（direct:用户名）与回执命名用 */
    userName: string;
    /** 群 HTML 模块模式开启时解析 [html] 块为 html_card 消息 */
    htmlMode?: boolean;
}

/**
 * 逐条执行成员动作：解析 [[PRIVATE:]] 进私聊频道、[[SEND_EMOJI:]] 发表情、
 * 剩余文本按换行分气泡带打字延迟落库。逻辑逐字搬自 triggerDirector，
 * 仅把 `setMessages(await DB.getGroupMessages(...))` 换成 ctx.refresh()、加 signal 检查。
 */
export async function dispatchMemberActions(actions: DirectorAction[], ctx: DispatchContext): Promise<void> {
    const { groupId, memberIds, characters, emojis, categories, refresh, addToast, signal, resolveQuote } = ctx;

    for (const action of actions) {
        if (signal?.aborted) return;
        const targetId = memberIds.find(id => id === action.charId);
        if (!targetId) continue;
        const charName = characters.find(c => c.id === targetId)?.name || '成员';

        // 0. Check for Private Message Command (Regex updated for robustness)
        let publicContent = action.content;
        const privateMatches: RegExpExecArray[] = [];
        // Handle multiple private messages in one block or mixed content
        const privateRegex = /\[\[PRIVATE\s*[:：]\s*([\s\S]*?)\]\]/g;
        let match;
        while ((match = privateRegex.exec(publicContent)) !== null) {
            privateMatches.push(match);
        }

        if (privateMatches.length > 0) {
            for (const m of privateMatches) {
                const privateContent = m[1].trim();
                if (privateContent) {
                    // Save to private chat (no groupId)
                    await DB.saveMessage({
                        charId: targetId,
                        role: 'assistant',
                        type: 'text',
                        content: privateContent
                    });
                    addToast(`${charName} 悄悄对你说: ${privateContent.substring(0, 15)}...`, 'info');
                }
                // Strip the private command from the public content
                publicContent = publicContent.replace(m[0], '');
            }
            publicContent = publicContent.trim();

            // If content is empty after stripping (pure private message), skip public rendering
            if (!publicContent) continue;
        }

        // 0.5 [[QUOTE: 原话片段]]：AI 想针对某条具体发言回复。两层容错精神——
        // 匹配不到目标就静默剥除标记，绝不因引用失败丢正文
        let quoteReplyTo: { id: number; content: string; name: string } | undefined;
        const quoteMatch = publicContent.match(/\[\[\s*QUOTE\s*[:：]\s*([\s\S]*?)\]\]/i);
        if (quoteMatch) {
            publicContent = publicContent.replace(quoteMatch[0], '').trim();
            quoteReplyTo = resolveQuote?.(quoteMatch[1].trim());
        }

        // 0.7 红包命令：[[GRAB_PACKET]] / [[RETURN_PACKET]] / [[SEND_PACKET: …]]。
        // 找不到适用包 / 目标名解析失败 → 静默剥标记保正文
        const packetExtract = extractPacketCommands(publicContent);
        publicContent = packetExtract.text;
        for (const cmd of packetExtract.commands) {
            if (signal?.aborted) return;
            await executePacketCommand(cmd, targetId, charName, ctx);
        }

        if (!publicContent) continue;

        publicContent = normalizeAssistantEmojiFormatting(publicContent);

        // 1. Check for Emoji Commands (handle multiple emojis)
        // Filter emojis by character visibility to prevent using hidden emoji packs
        const charVisibleEmojis = (() => {
            const visibleCats = categories.filter(c => {
                if (!c.allowedCharacterIds || c.allowedCharacterIds.length === 0) return true;
                return c.allowedCharacterIds.includes(targetId);
            });
            const hiddenCatIds = new Set(categories.filter(c => !visibleCats.some(vc => vc.id === c.id)).map(c => c.id));
            if (hiddenCatIds.size === 0) return emojis;
            return emojis.filter(e => !e.categoryId || !hiddenCatIds.has(e.categoryId));
        })();
        const emojiRegex = /\[\[SEND_EMOJI:\s*(.*?)\]\]/g;
        let emojiMatch;
        while ((emojiMatch = emojiRegex.exec(publicContent)) !== null) {
            if (signal?.aborted) return;
            const emojiName = emojiMatch[1].trim();
            const foundEmoji = charVisibleEmojis.find(e => e.name === emojiName);
            if (foundEmoji) {
                await DB.saveMessage({
                    charId: targetId,
                    groupId,
                    role: 'assistant',
                    type: 'emoji',
                    content: foundEmoji.url
                });
                await refresh();
                await new Promise(r => setTimeout(r, 800)); // Delay after emoji
            }
        }

        // 1.5 HTML 卡片（群 HTML 模式开启时）：[html]...[/html] 块抽成 html_card 消息，
        // 剩余文本继续走分气泡（字段对齐私聊 applyAssistantPostProcessing 的落库格式）
        let contentForText = publicContent;
        if (ctx.htmlMode && /\[html\]/i.test(contentForText)) {
            const { blocks, cleanedContent } = extractHtmlBlocks(contentForText);
            contentForText = cleanedContent;
            for (const block of blocks) {
                if (signal?.aborted) return;
                await DB.saveMessage({
                    charId: targetId,
                    groupId,
                    role: 'assistant',
                    type: 'html_card',
                    content: `[HTML卡片] ${block.textPreview}`,
                    metadata: { htmlSource: block.html, htmlTextPreview: block.textPreview },
                });
                await refresh();
                await new Promise(r => setTimeout(r, 300));
            }
        }

        // 2. Text Splitting (Standard Chat Logic)
        // Remove the emoji tag if it was processed, or just clean up
        const textContent = contentForText.replace(/\[\[SEND_EMOJI:.*?\]\]/g, '').trim();

        if (textContent) {
            // 只认显式换行；行内空格属于正文，不能把混合语言的一句话拆成多条气泡。
            const chunks = textContent.split(/(?:\r\n|\r|\n|\u2028|\u2029)+/)
                .map(c => c.trim())
                .filter(c => c.length > 0);

            for (const chunk of chunks) {
                if (signal?.aborted) return;
                // Typing delay
                const delay = Math.max(500, chunk.length * 50 + Math.random() * 200);
                await new Promise(r => setTimeout(r, delay));
                if (signal?.aborted) return;

                await DB.saveMessage({
                    charId: targetId,
                    groupId,
                    role: 'assistant',
                    type: 'text',
                    content: chunk,
                    // 引用只挂第一条文字气泡
                    ...(quoteReplyTo ? { replyTo: quoteReplyTo } : {}),
                });
                quoteReplyTo = undefined;
                await refresh();
            }
        }
    }
}

/** 红包目标名 → claimantId：精确成员名 → 模糊 → 用户；失败 undefined（调用方丢命令保正文） */
function resolvePacketTarget(name: string, ctx: DispatchContext): string | undefined {
    const n = name.trim();
    if (!n) return undefined;
    if (n === ctx.userName || n === '用户') return 'user';
    const members = ctx.characters.filter(c => ctx.memberIds.includes(c.id));
    const exact = members.find(c => c.name === n);
    if (exact) return exact.id;
    const fuzzy = members.find(c => c.name.includes(n) || n.includes(c.name));
    if (fuzzy) return fuzzy.id;
    if (ctx.userName && (ctx.userName.includes(n) || n.includes(ctx.userName))) return 'user';
    return undefined;
}

/**
 * 执行角色的红包命令。
 * - send：发新红包（direct 目标解析失败则丢弃命令）
 * - grab/return：从新到旧找适用包（发给自己的 direct 优先，其次可抢的 lucky），
 *   通过 updateMessageMetadata 事务内重跑 claimPacket 防并发双写，
 *   成功后落回执消息。任何失败都静默返回（正文已在调用方保住）。
 */
async function executePacketCommand(
    cmd: PacketCommand,
    actorId: string,
    actorName: string,
    ctx: DispatchContext,
): Promise<void> {
    const { groupId, characters, userName, refresh } = ctx;
    const nameOf = (id: string) => (id === 'user' ? userName : characters.find(c => c.id === id)?.name || '成员');

    if (cmd.kind === 'send') {
        if (!cmd.send) return;
        let packetTargetId: string | undefined;
        if (cmd.send.packetType === 'direct') {
            packetTargetId = resolvePacketTarget(cmd.send.targetName || '', ctx);
            if (!packetTargetId) return; // 名字解析不出来，不落半成品红包
        }
        const meta = makePacketMeta({
            packetType: cmd.send.packetType,
            totalAmount: cmd.send.totalAmount,
            shares: cmd.send.shares,
            targetId: packetTargetId,
            note: cmd.send.note,
            now: Date.now(),
        });
        await DB.saveMessage({ charId: actorId, groupId, role: 'assistant', type: 'transfer', content: '[红包]', metadata: meta });
        await refresh();
        return;
    }

    // grab / return
    const msgs = await DB.getGroupMessages(groupId);
    const now = Date.now();
    const packets = msgs.filter(m => m.type === 'transfer' && (m.metadata as GroupPacketMeta | undefined)?.packet);
    const newestFirst = [...packets].reverse();
    // 发给自己的 direct 优先；其次（仅 grab）还没抢过的 lucky
    const directTargeted = newestFirst.find(m => {
        const meta = m.metadata as GroupPacketMeta;
        return meta.packetType === 'direct' && meta.targetId === actorId && effectivePacketStatus(meta, now) === 'pending';
    });
    const luckyOpen = cmd.kind === 'grab'
        ? newestFirst.find(m => {
            const meta = m.metadata as GroupPacketMeta;
            return meta.packetType === 'lucky'
                && effectivePacketStatus(meta, now) === 'pending'
                && !meta.claims.some(c => c.claimantId === actorId);
        })
        : undefined;
    const targetMsg: Message | undefined = directTargeted || luckyOpen;
    if (!targetMsg) return;

    const action = cmd.kind === 'return' ? 'return' : 'claim';
    // `as ClaimResult` 保住联合类型：赋值发生在回调里，TS 流分析追不到，
    // 不 cast 会把 outcome 窄化成 {ok:false} 分支导致下方 .action 报 never
    let outcome = { ok: false, reason: 'not_pending' } as ClaimResult;
    await DB.updateMessageMetadata(targetMsg.id, (prev) => {
        // updater 内重跑状态机：以库内最新 claims 判重，防止与用户点「抢」并发双写
        outcome = claimPacket(prev as GroupPacketMeta, actorId, now, action);
        return outcome.ok ? outcome.meta : prev;
    }).catch(() => { /* 消息被删等——静默 */ });
    if (!outcome.ok) return;

    const senderName = targetMsg.role === 'user' ? userName : nameOf(targetMsg.charId);
    const receipt: PacketReceiptMeta = {
        packetReceipt: outcome.action,
        ref: targetMsg.id,
        amount: outcome.action === 'claimed' ? outcome.amount : undefined,
        claimantName: actorName,
        senderName,
    };
    await DB.saveMessage({
        charId: actorId,
        groupId,
        role: 'assistant',
        type: 'transfer',
        content: outcome.action === 'claimed' ? '[领取红包]' : '[退回红包]',
        metadata: receipt,
    });
    await refresh();
}

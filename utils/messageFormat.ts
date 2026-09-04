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

import type { Message, Emoji } from '../types';
import { formatLifeSimResetCardForContext } from './lifeSimChatCard';
import { formatQixiEventCardForContext, tryParseQixiEventChatCard } from './qixiChatCard';
import { formatTransferRecord } from './transferFormat';
import { formatStatCount } from './videoParser';

/**
 * 表情包消息的 content 存的是图床 URL，本身不带名字。拼上下文时要靠这个反查出
 * 当初设的表情名（关键字），非识图模型才能"看见"对方发了什么表情。
 * 私聊主历史、群聊主历史都从这里取名，避免一处查一处漏（群聊曾漏查，只给 [表情包]）。
 */
export function stickerNameFromUrl(emojis: Emoji[], url: string): string {
    return emojis.find(e => e.url === url)?.name || '未知表情';
}

/**
 * 语音消息的音频资源与转写文本可能分别落在 content / metadata 中。
 * 记忆链路只取可理解的文字，绝不把 blob、data URI 或纯音频 URL 当成上下文。
 */
export function getVoiceTranscript(msg: Message): string {
    const meta = msg.metadata || {};
    const candidates = [
        meta.transcript,
        meta.originalText,
        meta.spokenText,
        meta.text,
        msg.content,
    ];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (!trimmed) continue;
        if (/^(?:blob:|data:audio\/)/i.test(trimmed)) continue;
        if (/^https?:\/\/\S+$/i.test(trimmed)) continue;
        const cleaned = trimmed
            .replace(/<\/?(?:语音|語音|字幕)[^>]*>/g, ' ')
            .replace(/%%BILINGUAL%%/gi, '\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
        if (cleaned) return cleaned;
    }
    return '';
}

/**
 * 把「窥视的是哪个具体时间」组成一句人话：日期相对词 + 时段词 + 时刻。
 * 例：今天上午08:00 / 昨天晚上21:30 / 6月25日下午14:00。
 * 用于小剧场卡片注入——晚上看上午的内容时，不能含糊说"刚刚/刚才"，要落到具体时间。
 * @param dateStr  卡片记录的日期 "YYYY-MM-DD"（缺失则只给时段+时刻）
 * @param slotTime 时段起始 "HH:MM"
 */
export function theaterWhenPhrase(dateStr?: string, slotTime?: string): string {
    const time = (slotTime || '').trim();
    const hour = parseInt(time.split(':')[0], 10);
    const period = !Number.isFinite(hour) ? ''
        : hour < 5 ? '凌晨'
        : hour < 8 ? '早上'
        : hour < 11 ? '上午'
        : hour < 13 ? '中午'
        : hour < 17 ? '下午'
        : hour < 19 ? '傍晚'
        : hour < 23 ? '晚上'
        : '深夜';

    let dayWord = '今天';
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const now = new Date();
        const today = ymd(now);
        if (dateStr !== today) {
            const yest = new Date(now); yest.setDate(now.getDate() - 1);
            if (dateStr === ymd(yest)) {
                dayWord = '昨天';
            } else {
                const [, mo, da] = dateStr.split('-');
                dayWord = `${parseInt(mo, 10)}月${parseInt(da, 10)}日`;
            }
        }
    }
    return `${dayWord}${period}${time}`;
}

/** 仅返回内容体（不加 sender / timestamp）。调用方自行拼外层。 */
export function normalizeMessageContent(
    msg: Message,
    charName: string,
    userName: string,
): string {
    const type = msg.type as string;

    // 纯视觉类给占位；语音优先使用配套转写，避免把音频资源地址送进上下文。
    if (type === 'image') return '[图片]';
    if (type === 'emoji') return '[表情包]';
    if (type === 'voice') {
        const transcript = getVoiceTranscript(msg);
        return transcript ? `[语音转写] ${transcript}` : '[语音]';
    }

    // 系统交互事件
    // TODO(记录形态): 转账已迁到 [[记录:TRANSFER|...]] (见 transferFormat.ts 头注)，
    // 戳一戳等其他系统事件观察一段时间后再迁 —— sanitize 终线和幂等哨兵已按整个
    // 记录命名空间就位，迁移时只需要改这里的渲染。
    if (type === 'interaction') return `[系统: ${userName}戳了${charName}一下]`;
    if (type === 'transfer') {
        // 与私聊历史 (chatPrompts.buildMessageHistory) 共用同一渲染 —— 全链路一副面孔，
        // 记忆宫殿/归档的总结器看到的和角色平时看到的是同一形态。to 用固定词不写真名。
        const meta = msg.metadata || {};
        return formatTransferRecord({
            role: msg.role === 'user' ? 'user' : 'assistant',
            amount: meta.amount,
            receipt: meta.receipt,
            status: meta.status,
        });
    }

    // 结算卡：几种 app 产生，用字段逐一翻成自然文本
    if (type === 'score_card') {
        try {
            const card = msg.metadata?.scoreCard || JSON.parse(msg.content);
            if (card?.type === 'lifesim_reset_card') {
                return formatLifeSimResetCardForContext(card, charName);
            }
            const qixiCard = tryParseQixiEventChatCard(card);
            if (qixiCard) return formatQixiEventCardForContext(qixiCard, 'archive');
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
            if (card?.type === 'diary_card') {
                const uName = card.userName || userName;
                const userTextPart = (card.userText || '').trim();
                const charTextPart = (card.charText || '').trim();
                const userBlock = userTextPart ? `${uName}写道：「${userTextPart}」` : `${uName}那页是空的`;
                const charBlock = charTextPart ? `${charName}回道：「${charTextPart}」` : `${charName}那页是空的`;
                return `[交换日记 ${card.date || ''}] ${uName}和${charName}今天通过【交换日记】交换了一篇日记。${userBlock} ${charBlock}`;
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

    // TRPG 跑团片段：从 TRPG 游戏里多选转发到聊天的剧情。必须翻成完整可读文本，
    // 让上下文 / 归档 / palace 都能读到"和用户一起玩游戏时发生了什么"，并标明来自 TRPG。
    if (type === 'trpg_card') {
        const t = msg.metadata?.trpg as {
            gameTitle?: string;
            userName?: string;
            partyNames?: string[];
            excerpt?: Array<{ speaker?: string; text?: string }>;
        } | undefined;
        if (t) {
            const others = (t.partyNames || []).filter(n => n && n !== charName);
            const withPart = others.length ? `（和${others.join('、')}）` : '';
            const lines = (t.excerpt || [])
                .map(e => `${e.speaker || ''}: ${(e.text || '').replace(/\s*\n+\s*/g, ' ').trim()}`)
                .filter(s => s.trim() !== ':')
                .join('\n');
            return `[TRPG游戏片段] 这是${charName}和${t.userName || userName}${withPart}一起玩《${t.gameTitle || 'TRPG'}》跑团时的一段剧情（从游戏里转发到聊天，相当于你们一起玩游戏的共同回忆）：\n${lines}`;
        }
        return '[TRPG游戏片段]';
    }

    // 笔友会小说章节：从笔友会历史章节多选转发到聊天的归档总结。必须翻成完整可读文本，
    // 让上下文 / 归档 / palace 都能读到"这本书写了什么"。共创者视角是"我们一起写的书"，
    // 非共创者视角是"用户分享给我看的书"，措辞要区分开。
    if (type === 'novel_card') {
        const n = msg.metadata?.novel as {
            bookTitle?: string;
            subtitle?: string;
            bookSummary?: string;
            userName?: string;
            collaboratorNames?: string[];
            chapters?: Array<{ index?: number; summary?: string }>;
        } | undefined;
        if (n) {
            const collabs = n.collaboratorNames || [];
            const isCoauthor = collabs.includes(charName);
            const others = collabs.filter(name => name && name !== charName);
            const uName = n.userName || userName;
            const withPart = others.length ? `（还有${others.join('、')}）` : '';
            const head = isCoauthor
                ? `这是${charName}和${uName}${withPart}一起在笔友会共同创作的小说《${n.bookTitle || '无题'}》的章节归档（用户转发到聊天，这本书是你们共同的创作回忆，你是执笔人之一）`
                : `这是${uName}${collabs.length ? `和${collabs.join('、')}` : ''}在笔友会创作的小说《${n.bookTitle || '无题'}》的章节归档（用户分享给${charName}看的，${charName}没有参与创作）`;
            const intro = (n.bookSummary || '').trim() ? `\n简介：${(n.bookSummary || '').trim()}` : '';
            const body = (n.chapters || [])
                .map(c => `第${c.index ?? '?'}章总结：\n${(c.summary || '').trim().slice(0, 2000)}`)
                .join('\n\n');
            return `[笔友会小说章节] ${head}：${intro}\n${body}`;
        }
        return '[笔友会小说章节]';
    }

    // 小红书卡片：把笔记标题 + 正文 desc + 作者翻成可读文本喂给角色。标题来自分享文案
    // （无需后端），desc/作者来自 MCP 抓取（可能没有）。没专门分支时会走默认只给 content(=标题)，
    // 抓空时甚至空字符串，角色读不到任何东西。
    if (type === 'xhs_card') {
        const note: any = msg.metadata?.xhsNote || {};
        const title = (note.title || msg.content || '').trim();
        const desc = (note.desc || '').trim();
        const author = (note.author || '').trim();
        const authorPart = author ? `（作者：${author}）` : '';
        const head = `[小红书笔记] ${userName}分享了一篇小红书笔记${title ? `《${title}》` : ''}${authorPart}`;
        // 评论区：建卡时抓到的评论一并喂给角色（含归档/记忆宫殿场景），与浏览笔记时的可见性对齐。
        const comments = Array.isArray(note.comments) ? note.comments : [];
        const commentsPart = comments.length
            ? `\n评论区：\n${comments.slice(0, 15).map((c: any) => `· ${c.author || '匿名'}：${c.content}`).join('\n')}`
            : '';
        if (desc) return `${head}\n笔记正文：\n${desc}${commentsPart}`;
        // 只有标题（没部署 MCP / 没抓到正文）：角色至少知道是哪篇笔记，但别假装读过正文。
        if (title) return `${head}\n（注：只拿到了笔记标题，正文/图片没抓到——要读完整内容需部署小红书功能。别假装读过正文。）`;
        return `${head}\n（注：这篇笔记的内容没能获取到。）`;
    }

    // 网页卡片：用户粘贴链接分享的网页。卡片只给人看封面，上下文/归档/palace 要读到
    // 提取出的正文纯文字，角色才"看见"了网页内容（正文截到 ~1500 字防 token 爆）。
    if (type === 'webpage_card') {
        const meta: any = msg.metadata?.webpage || {};
        const title = meta.title || msg.content || '网页';
        const site = meta.siteName ? `（来自 ${meta.siteName}）` : '';
        const url = meta.finalUrl || meta.url || '';
        // 视频平台分享（videoParser 解析路径）：没有可读正文，喂给角色的是
        // 「标题 + 作者 + 热度数据」，并明确告知看不到画面内容，防止对着标题瞎编剧情。
        if (meta.video) {
            const v: any = meta.video;
            const plat = v.platformLabel || v.platform || '视频平台';
            const isImage = v.contentType === 'image';
            const kindLabel = isImage ? `图文${v.imageCount ? `（${v.imageCount} 张图）` : ''}` : '视频';
            const author = v.authorName ? `（作者：${v.authorName}）` : '';
            const head = `[视频分享] ${userName}分享了一个${plat}${kindLabel}${title ? `《${title}》` : ''}${author}${url ? `\n链接：${url}` : ''}`;
            const stats = [
                v.playCount ? `播放 ${formatStatCount(v.playCount)}` : '',
                v.likeCount ? `点赞 ${formatStatCount(v.likeCount)}` : '',
                v.commentCount ? `评论 ${formatStatCount(v.commentCount)}` : '',
                v.collectCount ? `收藏 ${formatStatCount(v.collectCount)}` : '',
            ].filter(Boolean);
            const note = isImage
                ? '（注：你能看到的是这个图文的标题、作者和热度数据，看不到图片内容本身，别假装看过图。）'
                : '（注：你能看到的是这个视频的标题、作者和热度数据，看不到视频画面和声音，别假装看过视频内容。）';
            return [
                head,
                stats.length ? `热度：${stats.join(' · ')}` : '',
                v.publishTime ? `发布时间：${v.publishTime}` : '',
                note,
            ].filter(Boolean).join('\n');
        }
        const bodyRaw = (typeof meta.content === 'string' && meta.content.trim())
            ? meta.content.trim()
            : (typeof meta.excerpt === 'string' ? meta.excerpt.trim() : '');
        const head = `[网页分享] ${userName}分享了一个网页《${title}》${site}${url ? `\n链接：${url}` : ''}`;
        // 正文抓空（登录墙 / SPA 动态渲染等）：明确告诉角色没读到正文，避免它对着标题瞎编网页内容。
        if (!bodyRaw) {
            return `${head}\n（注：这个网页的正文没能抓取到——可能需要登录，或是用 JS 动态渲染的页面。你只看到标题和链接，不知道正文写了什么，别假装读过内容。）`;
        }
        const body = bodyRaw.length > 1500 ? bodyRaw.slice(0, 1500) + '…（正文过长已截断）' : bodyRaw;
        return `${head}\n网页正文：\n${body}`;
    }

    // 小剧场卡片：用户在日程表"窥视"了角色某时段的行为演出，并把这一刻发到聊天里。
    // 归档/记忆宫殿要读到「用户偷看了你 + 你当时在做什么」，角色才会记得"被看到"这件事。
    if (type === 'theater_card') {
        const t: any = msg.metadata?.theater || {};
        const meta: any = msg.metadata || {};
        const exposed = meta.exposed !== false; // 缺省按已暴露处理（兼容旧卡片）
        const beat = Array.isArray(t.lines)
            ? t.lines.map((l: any) => `· ${typeof l?.text === 'string' ? l.text : ''}`).filter((s: string) => s.length > 2).join('\n')
            : '';
        const head = `[小剧场·窥视] ${userName}悄悄看了${charName}在 ${theaterWhenPhrase(meta.date, meta.slotTime)}「${meta.activity || '某个时段'}」时的样子`;
        const tail = exposed
            ? `（${charName}意识到自己被${userName}看到了。）`
            : `（这是${charName}当时真实在做的事，${charName}自己记得；但${charName}并不知道被${userName}看到。）`;
        if (beat) return `${head}\n${charName}当时的画面：\n${beat}\n${tail}`;
        return head;
    }

    // SAR 模块的外显版本只用于界面，不进入任何上下文。这里给主聊天、归档与记忆宫殿
    // 同一条极短的语义护栏：总结器即使只吃到模块中途的几轮，也知道 content 才是真意，
    // 不会把临时古风/傲娇等外显归纳成永久人格或关系变化。
    const sarSurface = msg.metadata?.sarModuleSurface;
    if (sarSurface?.surface) {
        const title = sarSurface.moduleTitle || '未知模块';
        return `${msg.content || ''}\n[SAR临时外显注记：本条 content 是真实语义；「${title}」只改变了当时界面显示，不代表真实内心、事实、永久人格、长期偏好或关系变化。]`;
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
 * transfer / interaction 等有内容的事件；image/emoji 这类纯视觉资源直接过滤。
 * voice 只要带转写文字就属于语义上下文，应该与文字和卡片一起参与统计与总结。
 */
export function isMessageSemanticallyRelevant(msg: Message): boolean {
    const type = msg.type as string;
    if (type === 'image' || type === 'emoji') return false;
    if (type === 'voice') return !!getVoiceTranscript(msg);
    // 卡片是其它功能汇入聊天的结构化上下文；即使 content 为空，只要专用格式化器
    // 能从 metadata 生成可读摘要，也必须参与缓冲区计数和记忆总结。
    if (type?.endsWith('_card')) {
        return !!normalizeMessageContent(msg, '角色', '用户').trim();
    }
    // 有内容或有结构化 metadata 才算
    return !!(msg.content?.trim() || msg.metadata?.scoreCard || msg.metadata?.amount || msg.metadata?.song || msg.metadata?.trpg || msg.metadata?.webpage);
}

import { loadCharacterContextMessages } from './chatContextRange';
// 人际关系系统 · 核心引擎
// 查手机「人际关系」模块的纯逻辑 + LLM 链路：真假甄别、好感、双 LLM 私下对话（A 发 B 回）、AI 玩 AI。
// UI 层（CheckPhone.tsx）负责把这里的结果落库 / 镜像到对方角色，本文件只产数据，不碰 React。

import { CharacterProfile, PhoneContact, UserProfile, ConvTopic, PhoneEvidence } from '../types';
import { ContextBuilder, type CharacterContextInput, type ContextMessage } from './context';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { DB } from './db';
import { safeResponseJson } from './safeApi';
import { phoneTranscriptToText } from './phoneTranscript';
import type { ApiCallMeta } from './apiCallLog';

export interface MiniApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ============================================================
//  纯函数（可单测，不触网）
// ============================================================

/** 归一化人名用于匹配：去空白、去括号身份后缀、转小写 */
export function normName(s: string): string {
    return (s || '')
        .replace(/[（(].*?[）)]/g, '') // 去掉「名字(身份)」里的身份部分
        .replace(/\s+/g, '')
        .trim()
        .toLowerCase();
}

/**
 * 真假甄别兜底：把一个联系人名字跟神经链接里的真实角色名单做匹配。
 * 命中返回该角色 id；否则 undefined（=纯 NPC）。
 * 先精确匹配，再做包含匹配（「学长阿哲」含「阿哲」也算命中）。
 */
export function matchRealChar(
    name: string,
    roster: { id: string; name: string }[],
): string | undefined {
    const n = normName(name);
    if (!n) return undefined;
    const exact = roster.find(r => normName(r.name) === n);
    if (exact) return exact.id;
    const contains = roster.find(r => {
        const rn = normName(r.name);
        return rn.length >= 2 && (n.includes(rn) || rn.includes(n));
    });
    return contains?.id;
}

/**
 * 把一条新「了解」累积进已有的了解文本里：逐行存、去重、保留最近 maxLines 行。
 * 这是机主对某人的「印象/判断」（来源是对方在聊天里自己说的，未必属实），刻意和 note(事实) 分开。
 */
export function appendLearned(prev: string | undefined, addition: string, maxLines = 8): string {
    const add = (addition || '').trim();
    const lines = (prev || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!add) return lines.join('\n');
    if (!lines.some(l => l === add)) lines.push(add);
    return lines.slice(-maxLines).join('\n');
}

/** 把话题盒（多条总结记忆）拼成用作上下文的文本；空则返回空串。默认只取最近 maxItems 条，避免无限膨胀。 */
export function topicText(box: ConvTopic[] | undefined, maxItems = 10): string {
    const items = (box || []).filter(t => t.text && t.text.trim());
    if (!items.length) return '';
    return items.slice(-maxItems).map(t => `· ${t.text.trim()}`).join('\n');
}

/** 好感度钳制到 -100..100 */
export function clampAffinity(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(-100, Math.min(100, Math.round(n)));
}

/**
 * 以 name 为键把一条联系人 upsert 进列表（不可变，返回新数组）。
 * 已存在则浅合并（保留原 id/affinity/createdAt，除非 incoming 显式带了）。
 */
export function upsertContact(
    contacts: PhoneContact[],
    incoming: Partial<PhoneContact> & { name: string },
): PhoneContact[] {
    const key = normName(incoming.name);
    const idx = contacts.findIndex(c => normName(c.name) === key);
    if (idx === -1) {
        const fresh: PhoneContact = {
            id: incoming.id || `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: incoming.name,
            identity: incoming.identity,
            identityManual: incoming.identityManual,
            note: incoming.note,
            avatar: incoming.avatar,
            kind: incoming.kind || 'npc',
            linkedCharId: incoming.linkedCharId,
            affinity: clampAffinity(incoming.affinity ?? 0),
            status: incoming.status || 'friend',
            lastInteraction: incoming.lastInteraction,
            createdAt: Date.now(),
        };
        return [...contacts, fresh];
    }
    const next = [...contacts];
    const cur = next[idx];
    // 只合并 incoming 里「确实有值」的字段：避免 note:undefined / identity:undefined
    // 这种把已有备注、身份、头像悄悄抹掉（扫描通讯录 / 对话回填都会触发，是「角色不看备注」的根因之一）。
    const merged = { ...cur } as unknown as Record<string, unknown>;
    (Object.keys(incoming) as (keyof PhoneContact)[]).forEach(k => {
        const v = incoming[k];
        if (v !== undefined) merged[k as string] = v;
    });
    // 备注是机主/用户手动维护的事实，扫描或对话自动回填不得覆盖已有的非空备注（显式编辑走 UI 直接改，不经这里）。
    if (cur.note && cur.note.trim()) merged.note = cur.note;
    // 用户手动确认过备注名/关系后，后续扫描只能更新好感等模型数据，不能把人工值覆盖回去。
    // identityManual=true 且 identity 为空也要保留：这代表用户明确选择「显示真名」。
    if (cur.identityManual) {
        merged.identity = cur.identity;
        merged.identityManual = true;
    }
    merged.affinity = incoming.affinity != null ? clampAffinity(incoming.affinity) : cur.affinity;
    merged.createdAt = cur.createdAt;
    merged.id = cur.id;
    next[idx] = merged as unknown as PhoneContact;
    return next;
}

/** 把这一段真实对话合入最新手机状态，不能用发请求前的整份通讯录/记录覆盖。 */
export function applyRealConversationToPhoneState(
    current: CharacterProfile['phoneState'],
    result: {
        partnerName: string; partnerCharId: string; detail: string; delta: number;
        partnerNote?: string; learnedNew?: string; seedIdentity?: string;
        timestamp: number; recordId: string; systemMessageId?: number;
    },
): { phoneState: NonNullable<CharacterProfile['phoneState']>; broadcast: string } {
    const matchesPartner = (c: PhoneContact) => c.linkedCharId === result.partnerCharId
        || normName(c.name) === normName(result.partnerName);
    const hadContact = current?.contacts?.some(matchesPartner);
    let contacts = upsertContact(current?.contacts || [], {
        name: result.partnerName, kind: 'real', linkedCharId: result.partnerCharId,
        note: result.partnerNote, identity: hadContact ? undefined : result.seedIdentity,
        lastInteraction: result.timestamp,
    });
    const contactId = contacts.find(matchesPartner)!.id;
    let broadcast = '';
    contacts = contacts.map(contact => {
        if (contact.id !== contactId) return contact;
        const affinity = clampAffinity(contact.affinity + result.delta);
        let status = contact.status;
        if (affinity <= -60 && status === 'friend') {
            status = 'deleted';
            broadcast = `（我把 ${contact.name} 删了，懒得再联系。）`;
        } else if (affinity >= 60 && status !== 'friend' && status !== 'blocked') {
            status = 'friend';
            broadcast = `（我又把 ${contact.name} 加回来了。）`;
        }
        return { ...contact, affinity, status,
            learned: result.learnedNew ? appendLearned(contact.learned, result.learnedNew) : contact.learned };
    });
    const records = current?.records || [];
    const existing = records.find(record => record.type === 'chat'
        && (record.contactId === contactId || (!record.contactId && normName(record.title) === normName(result.partnerName))));
    const record: PhoneEvidence = {
        ...(existing || { id: result.recordId, type: 'chat', title: result.partnerName }),
        detail: result.detail, timestamp: result.timestamp, contactId,
        systemMessageId: result.systemMessageId ?? existing?.systemMessageId,
    };
    return {
        phoneState: { ...current, contacts, records: existing
            ? records.map(item => item.id === existing.id ? record : item)
            : [...records, record] },
        broadcast,
    };
}

/**
 * 把「我:/对方:」对话脚本解析成结构化气泡，**带前缀继承**：
 * 一条消息可能跨多行（模型连发几条 / 正文里有换行），后续没有「我:/对方:」前缀的行
 * 归属于上一条的说话人，而不是被误判成对方。这是「消息错位 / 续写丢内容」的根因修复。
 *
 * - isMe: 这一行是不是「我」(机主) 说的
 * - text: 剥掉前缀后的正文
 * 空行被跳过。首行若无前缀，默认归为「对方」。
 */
export function parseTranscript(detail: unknown, firstUnprefixedIsMe = false): { isMe: boolean; text: string }[] {
    const out: { isMe: boolean; text: string }[] = [];
    let lastIsMe = firstUnprefixedIsMe; // 首行无前缀时的兜底归属（续写时可指定「下一个该谁说」）
    for (const raw of phoneTranscriptToText(detail).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^(我|对方|Me|Them)\s*[:：]\s*(.*)$/);
        if (m) {
            lastIsMe = m[1] === '我' || m[1] === 'Me';
            if (m[2].trim()) out.push({ isMe: lastIsMe, text: m[2].trim() });
        } else {
            // 无前缀 = 上一条说话人的续行，跟随 lastIsMe（修复多行消息错位）
            out.push({ isMe: lastIsMe, text: line });
        }
    }
    return out;
}

/** 把结构化气泡序列化回「我:/对方:」脚本，每行都带前缀（保证后续解析无损） */
export function serializeTurns(turns: { isMe: boolean; text: string }[]): string {
    return turns.map(t => `${t.isMe ? '我' : '对方'}: ${t.text}`).join('\n');
}

/**
 * 把一段「我:/对方:」对话脚本翻转视角。
 * A 视角的 detail（"我"=A，"对方"=B）→ B 视角（"我"=B，"对方"=A）。
 * 用于把同一段真实对话镜像写进对方角色的手机。
 * 走 parseTranscript（带前缀继承），多行消息也能正确翻转、且每行都补回前缀。
 */
export function flipTranscript(detail: string): string {
    return parseTranscript(detail)
        .map(t => `${t.isMe ? '对方' : '我'}: ${t.text}`)
        .join('\n');
}

// ============================================================
//  LLM 调用
// ============================================================

async function chatCompletion(api: MiniApiConfig,
    userContent: string,
    temperature = 0.85,
    characterContext?: CharacterContextInput,
    history: ContextMessage[] = [],
    meta?: ApiCallMeta,
): Promise<string> {
    const res = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: characterContext ? (await ContextBuilder.buildCharacterRequest(characterContext, [
                { role: 'system', content: userContent }, ...history,
                { role: 'user', content: '请按上述要求继续。' },
            ])) : [{ role: 'user', content: userContent }],
            temperature,
        }),
        __sullyMeta: {
            appId: 'checkphone',
            appName: '查手机',
            ...(characterContext?.char ? { charId: characterContext.char.id, charName: characterContext.char.name } : {}),
            ...meta,
        },
    } as RequestInit);
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data = await safeResponseJson(res);
    return (data?.choices?.[0]?.message?.content || '').trim();
}

/** 取某角色的有效原文范围（自适应 / 手动），压成纯文本 */
async function recentContextText(
    char: CharacterProfile,
    selfLabel: string,
    userName: string,
): Promise<string> {
    const msgs = await loadCharacterContextMessages(char);
    if (!msgs.length) return '（暂无最近聊天）';
    return msgs
        .map(m => {
            const who = m.role === 'user' ? userName : selfLabel;
            const body = m.type === 'text' ? m.content : `[${m.type}]`;
            return `${who}: ${body}`;
        })
        .join('\n');
}

/**
 * 按需注入记忆宫殿，query=对方的人名（用户指定的输入契约），返回 buildCoreContext 结果。
 * 记忆宫殿关闭时自动跳过（injectMemoryPalace 内部已 guard）。
 */
async function buildSpeakerContext(speaker: CharacterProfile,
    user: UserProfile,
    otherName: string,
): Promise<CharacterContextInput> {
    try {
        if (speaker.memoryPalaceEnabled) {
            const recent = await loadCharacterContextMessages(speaker);
            await injectMemoryPalace(speaker, recent, otherName, user.name);
        }
    } catch {
        /* 记忆宫殿失败不阻塞对话 */
    }
    // 让角色在和联系人对话时，也意识到「距离上次和用户联系多久了」（统一走 buildCoreContext）
    const lastInteractionTs = await lastUserInteractionTs(speaker.id);
    return { char: speaker, user, timeOptions: { lastInteractionTs } };
}

/** 取该角色与用户最后一次互动的时间戳（最近一条消息）。失败/无消息返回 undefined。 */
async function lastUserInteractionTs(charId: string): Promise<number | undefined> {
    try {
        const recent = await DB.getRecentMessagesByCharId(charId, 1);
        return recent[recent.length - 1]?.timestamp;
    } catch {
        return undefined;
    }
}

/**
 * 把一段对话原文浓缩成「说话人第一人称、带主观色彩」的一段记忆（单次 LLM）。
 * transcript 用该侧视角（"我:"=speaker，"对方:"=other）。失败/空则返回空串。
 */
export async function summarizeConversation(p: {
    api: MiniApiConfig;
    speakerId?: string;
    speakerName: string;
    otherName: string;
    transcript: string;
}): Promise<string> {
    if (!p.transcript.trim()) return '';
    const prompt = `你是「${p.speakerName}」。下面是你和「${p.otherName}」的一段聊天记录（"我:"=你，"对方:"=${p.otherName}）：
"""
${p.transcript}
"""
请用**第一人称、带你自己的主观色彩**，把这段聊天浓缩成一段你自己的记忆/印象（3-5 句）：你们聊了什么、你当时的感受和判断、对 TA 的看法有没有变化。只输出这段记忆本身，别加「我:」之类前缀、别解释、别旁白。`;
    try {
        const out = await chatCompletion(p.api, prompt, 0.7, undefined, [], {
            ...(p.speakerId ? { charId: p.speakerId } : {}),
            charName: p.speakerName,
            purpose: '关系记忆整理',
        });
        return out.replace(/^[「"']|[」"']$/g, '').trim();
    } catch {
        return '';
    }
}

export interface RealConversationResult {
    /** A 机主视角脚本（"我"=A，"对方"=B） */
    aDetail: string;
    /** B 机主视角脚本（"我"=B，"对方"=A） */
    bDetail: string;
    aDelta: number;
    bDelta: number;
    /** A 这次新了解到的关于 B 的认识（来自 B 的说法，未必属实）；无则空串 */
    aLearnedNew: string;
    /** B 这次新了解到的关于 A 的认识；无则空串 */
    bLearnedNew: string;
}

interface RunRealConversationParams {
    a: CharacterProfile;
    b: CharacterProfile;
    user: UserProfile;
    api: MiniApiConfig;
    /** A 对 B 的当前好感 */
    affinityA: number;
    /** B 对 A 的当前好感 */
    affinityB: number;
    /** 往返轮数（每轮 = A 说一次 + B 回一次），默认 3 */
    rounds?: number;
    /** 续写时已有的 A 视角脚本（"我"=A） */
    existingDetail?: string;
    aNote?: string;
    bNote?: string;
    /** A 目前对 B 已有的「了解」（印象，未必属实） */
    bLearned?: string;
    /** B 目前对 A 已有的「了解」 */
    aLearned?: string;
    /** A 的聊天话题盒（第一人称记忆，替代被归档的原文进上下文） */
    aSummary?: string;
    /** B 的聊天话题盒 */
    bSummary?: string;
}

/**
 * 双 LLM 私下对话：A 用 A 自己的人设/记忆/上下文发消息，B 用 B 自己的人设/记忆/上下文回。
 * 每一方都按用户指定的输入契约：buildCoreContext(true) + 记忆宫殿(query=对方名) + 统一有效原文范围。
 */
export async function runRealConversation(
    p: RunRealConversationParams,
): Promise<RealConversationResult> {
    const { a, b, user, api, affinityA, affinityB } = p;
    // 默认 1 个往返 = A 发一次 + B 回一次 = 正好 2 次 LLM 调用（好感变化折进各自回复，不再额外调用）
    const rounds = Math.max(1, Math.min(8, p.rounds ?? 1));

    const ctxA = await buildSpeakerContext(a, user, b.name);
    const ctxB = await buildSpeakerContext(b, user, a.name);
    const recentA = await recentContextText(a, a.name, user.name);
    const recentB = await recentContextText(b, b.name, user.name);

    // transcript: 用名字标注，喂给两边的 prompt
    const turns: { speaker: 'A' | 'B'; text: string }[] = [];

    // 续写：把已有 A 视角脚本解析回 turns（带前缀继承，多行消息不丢——修复「续写覆盖/吞掉之前内容」）
    if (p.existingDetail) {
        for (const seg of parseTranscript(p.existingDetail)) {
            turns.push({ speaker: seg.isMe ? 'A' : 'B', text: seg.text });
        }
    }

    // 从一段回复里抽出 [[Δ:+N]] 好感变化 + [[了解:…]] 新认识，剥掉这些标记，再去掉可能的「名字:」前缀
    const extract = (raw: string, selfName: string): { text: string; delta: number; learned: string } => {
        let delta = 0;
        const learnedParts: string[] = [];
        let text = raw.replace(/\[\[\s*Δ?\s*[:：]?\s*([+-]?\d+)\s*\]\]/g, (_m, n) => {
            delta += parseInt(n, 10) || 0;
            return '';
        });
        text = text.replace(/\[\[\s*了解\s*[:：]\s*([\s\S]*?)\]\]/g, (_m, s) => {
            const t = String(s).trim();
            if (t) learnedParts.push(t);
            return '';
        });
        text = text
            .replace(/^[「"']|[」"']$/g, '')
            .replace(new RegExp(`^\\s*(我|${selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*[:：]\\s*`), '')
            .trim();
        return { text, delta: Math.max(-20, Math.min(20, delta)), learned: learnedParts.join('；') };
    };

    let aDelta = 0;
    let bDelta = 0;
    let aLearnedNew = '';
    let bLearnedNew = '';

    for (let i = 0; i < rounds; i++) {
        // ---- A 发 ----
        const aPrompt = `

### [你和用户「${user.name}」的私聊背景（仅供参考，不是这场对话）]
${recentA}

### [人际关系 · 私聊「${b.name}」]
你是「${a.name}」。你正在用手机和「${b.name}」私聊，这是你日常的社交往来。
⚠️ 分清人：「${b.name}」是**另一个独立的人**，**不是**用户「${user.name}」。上面那段只是你和「${user.name}」的背景；别把「${b.name}」当成「${user.name}」，也别把只属于「${user.name}」的称呼、昵称、记忆、关系硬套到「${b.name}」身上。${
            p.bNote ? `

【机主对「${b.name}」的备注 —— 这是已确立的事实/关系背景，必须当作真实情况严格遵守，不得无视或与之矛盾】：
${p.bNote}` : ''
        }${
            p.bLearned ? `

【你对「${b.name}」逐渐积累的了解 —— 这只是你凭相处得来的印象，**来源是 TA 自己说的，未必属实**，可作参考但别当铁证】：
${p.bLearned}` : ''
        }${
            p.aSummary ? `

【你和「${b.name}」更早聊过的（你自己的记忆/印象，第一人称——原文较久远已归档，这是你记得的部分）：
${p.aSummary}】` : ''
        }
你对 TA 的当前好感度：${affinityA}（-100~100；>0 亲近、=0 普通、<0 才有反感）。

${p.aSummary ? '最近的对话' : '已经发生的对话'}（"${a.name}:" 是你，"${b.name}:" 是对方）：
"""
${turns.length ? '见独立消息历史。' : '（还没开始，由你起头）'}
"""

要求：
- 你是一个**完整、独立的人格**，有自己的生活、立场和情绪。这条消息是**你主动发的**，一定**事出有因**。先想清楚这次的动机——可以是其中一种或几种，也可以是别的：
  · 好奇「怎么会有 ${b.name} 这么个联系人」、想弄明白你俩是什么关系；
  · 单纯寒暄水聊、维系关系；
  · 有具体的事要问 / 求助 / 约下一次；
  · 打听某件事、套话、试探或确认对方的身份底细；
  · 报备近况、表达在意，或者表达不满、对峙。
  带着这个动机去说，让人能感到你「为什么现在找 TA」。
- 既然是你主动开口，就**贯彻你的目的、保持前后一致**：别莫名其妙地自我矛盾，别明明是自己找上门却突然卑微讨好、低声下气或反过来阴阳怪气。该硬气就硬气，该客气就客气，但都要合乎你的人设与动机。
- 始终保持「${a.name}」的人设、语气、说话习惯，**别 OOC**。
- 依据你们的真实关系（见上方备注）和好感度自然地聊；**不要凭空制造敌意、阴阳怪气、攻击或狗血冲突**——除非你的人设、备注或明显的负好感确实如此。好感为正或中性时就正常、友好地交流。
- 紧扣已有对话的话题往下接，别跳戏、别把对方当成别人。

任务：以「${a.name}」的身份，发给「${b.name}」接下来的消息（3-6 句、可连发几条，IM 风格，信息量够）。
只输出消息正文，不要加「${a.name}:」之类前缀，不要解释、不要旁白。
然后另起一行，用 [[Δ:+N]] 标注说完这段后你对 TA 的好感变化（N 为 -20~20 的整数，没变化写 [[Δ:0]]）。
如果这次交流让你对「${b.name}」**有了新的认识**（TA 是谁、什么身份、在意什么、透露了什么关键信息——记住这些只是 TA 自己说的、**未必是真的**，写成你的判断），再另起一行用 [[了解:一句话]] 记下来；没有新认识就别写这一行。`;
        let aRaw = '';
        try {
            aRaw = await chatCompletion(
                api,
                aPrompt,
                0.85,
                ctxA,
                turns.map(t => ({ role: t.speaker === 'A' ? 'assistant' : 'user', content: t.text })),
                { charId: a.id, charName: a.name, purpose: '跨角色私聊互动' },
            );
        } catch {
            break;
        }
        const aParsed = extract(aRaw, a.name);
        aDelta += aParsed.delta;
        if (aParsed.learned) aLearnedNew = appendLearned(aLearnedNew, aParsed.learned);
        if (aParsed.text) turns.push({ speaker: 'A', text: aParsed.text });

        // ---- B 回 ----
        const bPrompt = `

### [你和用户「${user.name}」的私聊背景（仅供参考，不是这场对话）]
${recentB}

### [人际关系 · 「${a.name}」私聊你]
你是「${b.name}」。「${a.name}」正在用手机私聊你。
⚠️ 分清人：「${a.name}」是**另一个独立的人**，**不是**用户「${user.name}」。上面那段只是你和「${user.name}」的背景；别把「${a.name}」当成「${user.name}」，也别把只属于「${user.name}」的称呼、昵称、记忆、关系硬套到「${a.name}」身上。${
            p.aNote ? `

【机主对「${a.name}」的备注 —— 这是已确立的事实/关系背景，必须当作真实情况严格遵守，不得无视或与之矛盾】：
${p.aNote}` : ''
        }${
            p.aLearned ? `

【你对「${a.name}」逐渐积累的了解 —— 凭相处得来的印象，**来源是 TA 自己说的，未必属实**，可作参考别当铁证】：
${p.aLearned}` : ''
        }${
            p.bSummary ? `

【你和「${a.name}」更早聊过的（你自己的记忆/印象，第一人称——原文较久远已归档，这是你记得的部分）：
${p.bSummary}】` : ''
        }
你对 TA 的当前好感度：${affinityB}（-100~100；>0 亲近、=0 普通、<0 才有反感）。

${p.bSummary ? '最近的对话' : '对话记录'}（"${b.name}:" 是你，"${a.name}:" 是对方）：
"""
见独立消息历史。
"""

要求：
- 你是一个**完整、独立的人格**，有自己的生活、立场和情绪。基于你自己的处境与态度去回应对方，**别一味迎合、也别无故敌对**——你怎么接这话，取决于你的人设、你们的关系和此刻的动机。回应里也可以带上你自己的目的（反问、打听、提条件、回避…）。
- 行为要前后一致、合乎动机，别莫名其妙地自我矛盾或忽冷忽热。
- 始终保持「${b.name}」的人设、语气、说话习惯，**别 OOC**。
- 依据你们的真实关系（见上方备注）和好感度自然回复；**不要凭空制造敌意、阴阳怪气或冲突**——除非人设、备注或明显的负好感确实如此。好感为正或中性时就正常、友好地回。
- 紧扣对方刚说的话回应，别跳戏、别认错人。

任务：以「${b.name}」的身份回复「${a.name}」（3-6 句、可连发几条，IM 风格，信息量够）。
只输出回复正文，不要前缀，不要解释、不要旁白。
然后另起一行，用 [[Δ:+N]] 标注回完这段后你对 TA 的好感变化（N 为 -20~20 的整数，没变化写 [[Δ:0]]）。
如果这次交流让你对「${a.name}」**有了新的认识**（TA 是谁、身份、在意什么、透露了什么——记住只是 TA 自己说的、**未必为真**，写成你的判断），再另起一行用 [[了解:一句话]] 记下来；没有就别写。`;
        let bRaw = '';
        try {
            bRaw = await chatCompletion(
                api,
                bPrompt,
                0.85,
                ctxB,
                turns.map(t => ({ role: t.speaker === 'B' ? 'assistant' : 'user', content: t.text })),
                { charId: b.id, charName: b.name, purpose: '跨角色私聊互动' },
            );
        } catch {
            break;
        }
        const bParsed = extract(bRaw, b.name);
        bDelta += bParsed.delta;
        if (bParsed.learned) bLearnedNew = appendLearned(bLearnedNew, bParsed.learned);
        if (bParsed.text) turns.push({ speaker: 'B', text: bParsed.text });
    }

    // A 视角脚本（"我"=A）。一条消息可能跨多行（连发几条），**每一行都补上说话人前缀**，
    // 这样渲染时不会把续行误判给对方，续写解析也不丢内容（修复消息错位 + 续写覆盖）。
    const lineify = (who: '我' | '对方', text: string) =>
        text.split('\n').map(l => l.trim()).filter(Boolean).map(l => `${who}: ${l}`).join('\n');
    const aDetail = turns
        .map(t => lineify(t.speaker === 'A' ? '我' : '对方', t.text))
        .filter(Boolean)
        .join('\n');
    const bDetail = flipTranscript(aDetail);

    return {
        aDetail,
        bDetail,
        aDelta: Math.max(-20, Math.min(20, aDelta)),
        bDelta: Math.max(-20, Math.min(20, bDelta)),
        aLearnedNew,
        bLearnedNew,
    };
}

interface RunNpcConversationParams {
    /** 机主角色 */
    host: CharacterProfile;
    user: UserProfile;
    api: MiniApiConfig;
    /** 虚构联系人名字 */
    npcName: string;
    /** 虚构联系人身份/关系标签 */
    identity?: string;
    /** 机主对此人的备注 */
    note?: string;
    /** 机主目前对此人已有的「了解」（印象，未必属实）——用于保持 NPC 跨次一致 */
    learned?: string;
    rounds?: number;
    existingDetail?: string;
}

/**
 * 与虚构 NPC 的对话：机主按人设脑补出这个不存在的人，单 LLM 分饰两角生成聊天脚本。
 * 纯虚构产物——不镜像、不涉及任何真实角色。
 * learnedNew：本次机主新「了解」到的 NPC 设定（写回 contact.learned，让这个虚构的人下次保持一致）。
 */
export async function runNpcConversation(
    p: RunNpcConversationParams,
): Promise<{ detail: string; learnedNew: string }> {
    const rounds = Math.max(1, Math.min(8, p.rounds ?? 4));
    const hostLastTs = await lastUserInteractionTs(p.host.id);
    const ctxHost = { char: p.host, user: p.user, timeOptions: { lastInteractionTs: hostLastTs } };

    // 续写时算出「下一句该谁说」，并提示模型从对的那一方接（避免一直自说自话繁殖 host 的话）
    const exTurns = parseTranscript(p.existingDetail || '');
    const lastIsMe = exTurns.length ? exTurns[exTurns.length - 1].isMe : false;
    const nextIsMe = exTurns.length ? !lastIsMe : true; // 全新开场：你(host)先开口
    const turnHint = exTurns.length
        ? (lastIsMe
            ? `\n上一句是你（${p.host.name}）说的，**接下来轮到「${p.npcName}」先回**，第一行必须用「对方:」开头。`
            : `\n上一句是「${p.npcName}」说的，**接下来轮到你（${p.host.name}）**，第一行必须用「我:」开头。`)
        : '';

    const prompt = `

### [人际关系 · 与虚构联系人的聊天]
你是「${p.host.name}」。你正在用手机和「${p.npcName}」私聊。
⚠️ **「${p.npcName}」是另一个独立的人，绝不是用户「${p.user.name}」。** 全程都在跟「${p.npcName}」说话；不要把 TA 当成用户、不要中途改用对用户的口吻/称呼/记忆，也别突然切换说话对象。${
        p.identity ? `对方身份：${p.identity}。` : ''
    }${
        p.note ? `

【机主对「${p.npcName}」的备注 —— 这是已确立的事实/关系背景，必须当作真实情况严格遵守，不得无视或与之矛盾】：
${p.note}` : ''
    }${
        p.learned ? `

【你对「${p.npcName}」已有的了解（之前相处积累的印象，保持前后一致）】：
${p.learned}` : ''
    }
「${p.npcName}」是按你的人设合理虚构出来的人（不是真实存在的角色），由你脑补出 TA 的性格与说话方式。

要求：
- 你（${p.host.name}）是一个**完整、独立的人格**。你发起或推进这段对话一定**事出有因**——动机可以是好奇/打听身份/有事相求/水聊/试探/报备/不满等任意贴合情境的一种或几种，带着它去说、前后一致；既然是你开口，就贯彻目的，别莫名其妙地自我矛盾、卑微讨好或反过来阴阳怪气。
- 始终保持「${p.host.name}」的人设；对方的性格也要前后一致。
- 依据上方备注/身份设定的关系自然地聊；**不要凭空制造敌意、阴阳怪气或狗血冲突**，除非备注/身份/人设确实如此。
- 紧扣已有对话往下接，别跳戏、别认错人。

${p.existingDetail ? `已经聊了：\n"""\n见独立消息历史。\n"""\n请接着往下聊。${turnHint}` : '现在开始这段对话。'}

任务：生成你（${p.host.name}）和「${p.npcName}」接下来 ${rounds} 个来回的对话，信息量要够。
格式（**严格遵守**）：
- 每一行都必须以「我:」或「对方:」开头；"我:" 代表你（${p.host.name}），"对方:" 代表「${p.npcName}」。
- 你和「${p.npcName}」**轮流说话、一来一回**；别一个人连说好几轮、别写成独白。
只输出对话行，不要解释、不要旁白、不要重复已有内容。
如果这次让你对「${p.npcName}」有了新的设定/认识（身份、性格、在意的事…），在最末尾另起一行用 [[了解:一句话]] 记下来，方便下次保持一致；没有就别写。`;

    let out = '';
    try {
        out = await chatCompletion(
            p.api,
            prompt,
            0.9,
            ctxHost,
            exTurns.map(t => ({ role: t.isMe ? 'assistant' : 'user', content: t.text })),
            { charId: p.host.id, charName: p.host.name, purpose: '联系人私聊回复' },
        );
    } catch {
        return { detail: p.existingDetail || '', learnedNew: '' };
    }
    out = out.replace(/```/g, '').trim();
    // 抽出 [[了解:…]] 并从正文里剥掉，避免混进对话气泡
    let learnedNew = '';
    out = out.replace(/\[\[\s*了解\s*[:：]\s*([\s\S]*?)\]\]/g, (_m, s) => {
        learnedNew = appendLearned(learnedNew, String(s).trim());
        return '';
    }).trim();
    // 关键：新内容**单独解析**，无前缀的首行归给「该说话的下一方」(nextIsMe)，
    // 不再继承上一句的说话人——否则上一句是 host 时，整段续写会全被算成 host（“繁殖 char 的话”）。
    const newTurns = parseTranscript(out, nextIsMe);
    const detail = serializeTurns([...exTurns, ...newTurns]);
    return { detail, learnedNew };
}

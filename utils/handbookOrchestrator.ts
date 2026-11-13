/**
 * 手账 v2 编排器 — 版式优先 / 槽位填空
 *
 * 哲学: "大家共写的一本手账", 不是 user 主写 + 角色伴奏。
 *
 * 流程:
 *  1. roll layout: pickTemplate(date 条件) → 一组 SlotDef
 *  2. user 步: *仅当 user 今天有聊天素材* 才跑, 一次 LLM 填 1~2 个最该填的 user 槽 (不全填)
 *  3. 角色步: 取参与角色 (默认 cap 2 个), 每人一次 LLM 调用, 看到 "已填的所有内容 +
 *     剩余可填槽 + 自己人格", 选 1 个槽填或 pass
 *  4. 收尾: 把 filled slots 转成 HandbookPage[] + HandbookLayout
 *
 * 关键约束:
 *  - 不让 LLM 排版 (位置已定)
 *  - 字数硬约束 (charBudget) — 写溢出客户端截断
 *  - sticky-reaction 必须有 refersTo 指向已填槽, 缺失整槽作废
 *  - **today-only 硬约束**: 只写今天发生过的事, 不要把以前的事编进来
 *  - **共写而非中心化**: 角色 prompt 不把自己定位成 "user 的伴奏", 而是 "另一个参与者"
 *  - **user 没素材 → 完全跳过**, 不留假占位
 */

import {
    CharacterProfile, UserProfile,
    HandbookPage, HandbookFragment, HandbookLayout, LayoutPlacement,
    LayoutTemplate, SlotDef, SlotRole, SlotPayload,
} from '../types';
import { DB } from './db';
import { loadCharacterContextMessages } from './chatContextRange';
import { safeResponseJson, extractJson } from './safeApi';
import { ContextBuilder, type CharacterContextInput } from './context';
import { LAYOUT_TEMPLATES, pickTemplate } from './handbookLayouts';
import { getLocalDayRange } from './localDate';
import { normalizeMessageContent } from './messageFormat';

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ─── 工具: 当日时间窗 ────────────────────────────────────
function dayRange(date: string): { start: number; end: number } {
    return getLocalDayRange(date) || { start: 0, end: 0 };
}

function dayOfWeekZh(date: string): string {
    return ['日', '一', '二', '三', '四', '五', '六'][
        new Date(date.replace(/-/g, '/')).getDay()
    ];
}

// ─── 工具: user 当日跟某角色对话片段 ─────────────────────
// （export 仅为了回归测试能直接验这段文本，见 handbookOrchestratorContent.test.ts）
export async function todayChatLines(
    char: CharacterProfile,
    date: string,
    userName: string,
): Promise<{ lines: string[]; userMsgCount: number }> {
    const { start, end } = dayRange(date);
    let all: any[] = [];
    try { all = await DB.getMessagesByCharId(char.id, true); } catch { return { lines: [], userMsgCount: 0 }; }
    const today = all
        .filter(m => m.timestamp >= start && m.timestamp < end)
        .sort((a, b) => a.timestamp - b.timestamp);
    const lines: string[] = [];
    let userMsgCount = 0;
    for (const m of today) {
        if (m.role === 'system') continue;
        if (typeof m.content !== 'string' || !m.content.trim()) continue;
        const speaker = m.role === 'user' ? userName : char.name;
        // 不能直接截 m.content：卡片类消息（score_card / html_card / 小红书…）的 content
        // 是一整段 JSON，头像这种图片字段就排在开头几十字里；图片消息的 content
        // 本身就是一张图。图片现在存的是 `blobref:<id>` 短令牌（~28 字），长度截断拦不住，
        // 到网络出口（utils/apiBlobRefs.ts）会被还原成整张 base64。这里统一走
        // normalizeMessageContent：卡片压成一行摘要，图片/表情一律换成占位符。
        const normalized = normalizeMessageContent(m as any, char.name, userName);
        if (!normalized.trim()) continue;
        const text = normalized.length > 200 ? normalized.slice(0, 200) + '…' : normalized;
        lines.push(`${speaker}: ${text}`);
        if (m.role === 'user') userMsgCount++;
    }
    return { lines, userMsgCount };
}

// ─── 槽 → prompt 描述 ─────────────────────────────────────
function describeSlotForPrompt(s: SlotDef): string {
    const auth = s.eligibleAuthors.join('|');
    return `[${s.id}] role=${s.slotRole} 字数=${s.charBudget[0]}~${s.charBudget[1]} 谁能写=${auth}\n  目的: ${s.hint}`;
}

// ─── 槽 → 输出 schema 描述 (告诉 LLM 要返回的 JSON shape) ──
function slotOutputSchema(role: SlotRole): string {
    switch (role) {
        case 'todo':
            return `{ "slotId": "X", "payload": { "kind": "todo", "items": [{"text":"...", "done": true|false}, ...] } }`;
        case 'gratitude':
            return `{ "slotId": "X", "payload": { "kind": "gratitude", "items": ["...", "...", "..."] } }`;
        case 'timeline-plan':
            return `{ "slotId": "X", "payload": { "kind": "timeline", "items": [{"time":"07:30", "text":"起床", "emoji":"☀️"}, ...] } }`;
        case 'mood-card':
            return `{ "slotId": "X", "text": "今天的心情一句话", "payload": { "kind": "mood", "rating": 1~5, "tag": "可选小标签" } }`;
        case 'photo-caption':
            return `{ "slotId": "X", "payload": { "kind": "photo", "caption": "短描述 (≤25字)" } }`;
        case 'sticky-reaction':
            return `{ "slotId": "X", "text": "便签内容", "refersTo": "被引用的slotId(必填)" }`;
        case 'hero-diary':
        case 'corner-note':
        default:
            return `{ "slotId": "X", "text": "纯文本内容" }`;
    }
}

// ─── 共享: today-only 红线 ────────────────────────────────
const TODAY_ONLY_RULE = `
【⚠️⚠️⚠️ TODAY-ONLY 硬约束 — 违反整组判废】
- 只写 *今天 (该日期)* 真正发生过的事 / 真正想到的念头
- **严禁**把以前的回忆、过往的对话、过去的经历当作"今天的事"扯出来
- **严禁**虚构今天和 user 一起做了什么 (没见面就没有)
- 如果你这个角色今天根本没素材, 直接 pass —— 不要硬挤
- 反应型槽 (sticky-reaction) 必须明确引用 "已填的某个槽 (slotId)" 的具体内容, 不许凭空发挥
`;

// ─── LLM call ────────────────────────────────────────────
async function callLLM(
    apiConfig: ApiConfig, prompt: string, temperature: number, maxTokens: number = 4000, characterContext?: CharacterContextInput,
): Promise<string | null> {
    try {
        const t0 = Date.now();
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: characterContext ? (await ContextBuilder.buildCharacterRequest(characterContext, [{ role: 'user', content: prompt }])) : [{ role: 'user', content: prompt }],
                temperature,
                max_tokens: maxTokens,
            }),
            __sullyMeta: {
                appId: 'handbook',
                appName: '手账',
                ...(characterContext?.char ? { charId: characterContext.char.id, charName: characterContext.char.name } : {}),
                purpose: '手账排版编排',
            },
        } as RequestInit);
        if (!response.ok) {
            console.error(`[Handbook v2] HTTP ${response.status} ${response.statusText}`);
            return null;
        }
        const data = await safeResponseJson(response);
        const raw: string = data.choices?.[0]?.message?.content || '';
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[Handbook v2] LLM 返回 ${raw.length} chars (${elapsed}s)`);
        return raw.trim();
    } catch (e) {
        console.error('[Handbook v2] LLM call failed:', e);
        return null;
    }
}

function parseLLMJson(raw: string): any | null {
    let s = raw.trim()
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '').trim();
    try { return JSON.parse(s); }
    catch { try { return extractJson(s); } catch { return null; } }
}

// ─── filled slot 内部表示 ────────────────────────────────
interface FilledSlot {
    slotId: string;
    slotRole: SlotRole;
    /** 文本内容 (有些 role 没有, 走 payload) */
    text: string;
    payload?: SlotPayload;
    /** 'user' 或 charId */
    authorKind: 'user' | 'char';
    authorName: string;
    charId?: string;
    refersTo?: string;
}

// ─── 渲染 "已填上下文" 给下一轮 LLM 看 ────────────────────
function renderFilledContext(filled: FilledSlot[]): string {
    if (filled.length === 0) return '【已填的槽】(暂无)';
    const lines: string[] = ['【已填的槽 — 你可以引用这些内容】'];
    for (const f of filled) {
        const preview = f.text || (f.payload ? JSON.stringify(f.payload).slice(0, 80) : '');
        lines.push(`  [${f.slotId}] (${f.slotRole}, by ${f.authorName}): ${preview}`);
    }
    return lines.join('\n');
}

function renderRemainingSlots(remaining: SlotDef[], authorKind: 'user' | 'char'): string {
    const eligible = remaining.filter(s => s.eligibleAuthors.includes(authorKind));
    if (eligible.length === 0) return '【你能填的槽】(无 — 该 pass)';
    return ['【剩余可填的槽】'].concat(eligible.map(describeSlotForPrompt)).join('\n');
}

// ─── 1. user 槽 — 仅当 user 今天有聊天才跑, 只填 1~2 个最该填的 ────
//
// 行为:
//  - user 今天没聊过任何东西 → 返回 [], 整个 user 步跳过 (不留假占位)
//  - 有聊过 → 让 LLM 在 user-eligible 槽里挑 2~4 个最适合的, 填掉
async function fillUserSlots(
    template: LayoutTemplate,
    date: string,
    selectedCharIds: string[],
    characters: CharacterProfile[],
    userProfile: UserProfile,
    apiConfig: ApiConfig,
): Promise<FilledSlot[]> {
    const userName = userProfile.name || '我';
    const slots = template.pages.flat().filter(s => s.eligibleAuthors.includes('user'));
    if (slots.length === 0) return [];

    // 收集 user 今日素材
    const transcriptParts: string[] = [];
    let totalUserMsgs = 0;
    for (const charId of selectedCharIds) {
        const c = characters.find(ch => ch.id === charId);
        if (!c) continue;
        const { lines, userMsgCount } = await todayChatLines(c, date, userName);
        totalUserMsgs += userMsgCount;
        if (lines.length === 0) continue;
        const trimmed = lines.length > 50 ? lines.slice(-50) : lines;
        transcriptParts.push(`== 与「${c.name}」==\n${trimmed.join('\n')}`);
    }

    // user 今天什么都没说 → 直接跳过, 不留假货
    if (totalUserMsgs === 0) {
        console.log(`[Handbook v2] ╳ user 步跳过 — ${userName} 今天没素材`);
        return [];
    }
    console.log(`[Handbook v2] ▶ user "${userName}" 步开始 — userMsgs=${totalUserMsgs}, 候选槽=${slots.length} 个 (${slots.map(s => `${s.id}/${s.slotRole}`).join(', ')})`);

    const dow = dayOfWeekZh(date);
    const slotBlock = slots.map(describeSlotForPrompt).join('\n');
    const schemaExamples = slots.slice(0, 4).map(s => slotOutputSchema(s.slotRole)).join(',\n  ');

    const prompt = `今天是 ${date} (星期${dow})。你是「${userName}」的私人手账代笔。
这是 ${userName} 跟一群角色共写的一本手账, 不是只有 ${userName} 在写。
请你基于 ${userName} 今天的真实对话, **挑 2~4 个最有素材可填的 user 槽**, 用 ${userName} 的第一人称填好。每个槽都要落到 charBudget 区间。没素材的槽不要硬挤, 留给角色或留白。

${slotBlock}

${TODAY_ONLY_RULE}

【输出 JSON 数组】1~2 个元素, 形如:
[
  ${schemaExamples}
]

字段说明:
- slotId 必须是上面列出来的 id
- text: 纯文本 (适用 hero-diary / corner-note / mood-card 等)
- payload: 结构化数据 (适用 todo / gratitude / timeline-plan / mood-card / photo-caption)
- 字数硬卡: text 长度落在 charBudget 区间内
- 优先选 user 今天聊天里有具体素材的槽, 没素材的不要填
- 不要 emoji 开头, 不要标题

【今日对话素材】
${transcriptParts.join('\n\n')}

直接输出 JSON 数组。`;

    const raw = await callLLM(apiConfig, prompt, 0.75);
    if (!raw) {
        console.error(`[Handbook v2] ✗ user "${userName}" — LLM 返回空`);
        return [];
    }
    console.log(`[Handbook v2] user 原始 LLM 响应:\n${raw.length > 800 ? raw.slice(0, 800) + '\n…(截断)' : raw}`);
    const parsed = parseLLMJson(raw);
    if (!Array.isArray(parsed)) {
        console.error(`[Handbook v2] ✗ user — JSON 解析失败 / 不是数组, 类型=${typeof parsed}`);
        return [];
    }

    const filled: FilledSlot[] = [];
    const dropped: string[] = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') { dropped.push('非对象'); continue; }
        const slotId = String(item.slotId || '').toUpperCase();
        const slot = slots.find(s => s.id === slotId);
        if (!slot) { dropped.push(`未知 slotId=${slotId}`); continue; }
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        const payload = sanitizePayload(item.payload, slot.slotRole);
        if (!text && !payload) { dropped.push(`${slotId} 内容空`); continue; }
        filled.push({
            slotId: slot.id,
            slotRole: slot.slotRole,
            text: clampText(text, slot.charBudget),
            payload,
            authorKind: 'user',
            authorName: userName,
        });
        if (filled.length >= 5) break;       // 模型偶尔超额, 客户端硬卡 (允许填多, 但留一些给角色)
    }
    console.log(`[Handbook v2] ◀ user "${userName}" 完成 — 填了 ${filled.length} 个槽 [${filled.map(f => `${f.slotId}/${f.slotRole}`).join(', ')}]${dropped.length ? `, 丢弃 ${dropped.length} 条 (${dropped.join('; ')})` : ''}`);
    for (const f of filled) {
        const preview = f.text || (f.payload ? `[payload:${f.payload.kind}]` : '');
        console.log(`[Handbook v2]   • [${f.slotId}] ${f.slotRole}: ${preview.length > 60 ? preview.slice(0, 60) + '…' : preview}`);
    }
    return filled;
}

function clampText(text: string, [_min, max]: [number, number]): string {
    if (text.length <= max) return text;
    // 优先在标点处截断
    const slice = text.slice(0, max);
    const lastPunct = Math.max(
        slice.lastIndexOf('。'), slice.lastIndexOf('!'), slice.lastIndexOf('?'),
        slice.lastIndexOf('.'), slice.lastIndexOf(','), slice.lastIndexOf(','),
    );
    return lastPunct > max - 30 ? slice.slice(0, lastPunct + 1) : slice + '…';
}

function sanitizePayload(p: any, role: SlotRole): SlotPayload | undefined {
    if (!p || typeof p !== 'object') return undefined;
    const kind = p.kind;
    if (role === 'todo' && kind === 'todo' && Array.isArray(p.items)) {
        const items = p.items
            .map((it: any) => {
                if (typeof it === 'string') return { text: it.trim(), done: false };
                if (it && typeof it === 'object' && typeof it.text === 'string') {
                    return { text: it.text.trim(), done: !!it.done };
                }
                return null;
            })
            .filter((x: any) => x && x.text);
        return items.length > 0 ? { kind: 'todo', items } : undefined;
    }
    if (role === 'gratitude' && kind === 'gratitude' && Array.isArray(p.items)) {
        const items = p.items.map((s: any) => String(s || '').trim()).filter(Boolean);
        return items.length > 0 ? { kind: 'gratitude', items } : undefined;
    }
    if (role === 'timeline-plan' && kind === 'timeline' && Array.isArray(p.items)) {
        const items = p.items
            .map((it: any) => {
                if (!it || typeof it !== 'object') return null;
                const time = String(it.time || '').trim();
                const text = String(it.text || '').trim();
                if (!time || !text) return null;
                const emoji = typeof it.emoji === 'string' ? it.emoji.trim() : undefined;
                return { time, text, emoji };
            })
            .filter(Boolean);
        return items.length > 0 ? { kind: 'timeline', items } : undefined;
    }
    if (role === 'mood-card' && kind === 'mood') {
        const rating = Math.max(1, Math.min(5, Math.round(Number(p.rating) || 3)));
        const tag = typeof p.tag === 'string' ? p.tag.trim() : undefined;
        return { kind: 'mood', rating, tag };
    }
    if (role === 'photo-caption' && kind === 'photo') {
        const caption = String(p.caption || '').trim();
        const src = typeof p.src === 'string' ? p.src : undefined;
        return caption ? { kind: 'photo', caption, src } : undefined;
    }
    return undefined;
}

// ─── 2. char 步 — 单次 LLM 调用填多个槽 ────────────────────
//
// 设计:
//  - 一次 LLM 调用返回一组 (3~5 条) ta 今天的内容 — 像生活系角色"今日小生活"
//  - 自由发挥: hero-diary / mood-card / 多个 corner-note / 可选 sticky-reaction
//  - 生活系角色被鼓励 "造谣" 自己今天的日常 (跟 user 无关), 不能假装今天和 user 一起做了什么
//  - sticky-reaction 必须有 refersTo, filled 全空时自动剔除该 role 候选
//  - 必须写, 不能 pass; LLM 烂数据 → 重试一次 → 仍烂才静默丢
async function fillCharTurn(
    char: CharacterProfile,
    template: LayoutTemplate,
    filled: FilledSlot[],
    date: string,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
): Promise<FilledSlot[]> {
    let remaining = template.pages.flat().filter(s =>
        !filled.find(f => f.slotId === s.id) && s.eligibleAuthors.includes('char')
    );
    // sticky-reaction 没东西可引 → 踢出候选 (没法满足 refersTo)
    if (filled.length === 0) {
        remaining = remaining.filter(s => s.slotRole !== 'sticky-reaction');
    }
    console.log(`[Handbook v2] ▶ char "${char.name}" 步开始 — 剩余可填槽 ${remaining.length} 个 [${remaining.map(s => `${s.id}/${s.slotRole}`).join(', ')}]`);
    if (remaining.length === 0) {
        console.log(`[Handbook v2] ╳ char "${char.name}" — 没槽可填, 跳过`);
        return [];
    }

    const userName = userProfile.name || 'user';
    const dow = dayOfWeekZh(date);


    // 抽 ta 平时怎么说话的样本
    let speechSamples: string[] = [];
    try {
        const all = await loadCharacterContextMessages(char);
        const charMsgs = all.filter((m: any) =>
            m.role === 'assistant'
            && typeof m.content === 'string'
            && m.content.length > 4
            && m.content.length < 400
            && !(m.content.trim().startsWith('{') && m.content.trim().endsWith('}'))
        );
        if (charMsgs.length <= 25) {
            speechSamples = charMsgs.map((m: any) => m.content.slice(0, 180));
        } else {
            const step = charMsgs.length / 25;
            for (let i = 0; i < 25; i++) {
                speechSamples.push(charMsgs[Math.floor(i * step)].content.slice(0, 180));
            }
        }
    } catch {}

    // 该 char 今天有没有跟 user 聊过 (有素材才允许写 sticky-reaction 引 user 的槽)
    const { lines: todayLines } = await todayChatLines(char, date, userName);

    const speechBlock = speechSamples.length > 0
        ? `\n【⚠️ ${char.name} 平时怎么说话 — 严格模仿语气/用词/句式/口头禅, 不像 ta 整组判废】\n${speechSamples.map((s, i) => `[${i + 1}] ${s}`).join('\n')}\n`
        : '';

    const todayChatBlock = todayLines.length > 0
        ? `\n【今天 ${char.name} 跟 ${userName} 的对话片段 — 仅供参考, 是 *今天* 真实发生的】\n${todayLines.slice(-25).join('\n')}\n`
        : `\n【⚠️ ${char.name} 今天没和 ${userName} 说过话】没关系 — 写你自己今天的生活就好 (生活流可以"造谣": 早起喝什么、谁路过、刷到什么、忽然想起什么…只要符合人设)。\n`;

    const filledBlock = renderFilledContext(filled);
    const remainingBlock = renderRemainingSlots(remaining, 'char');

    // 列 char-eligible 槽的 schema 例子 (按 role 去重显示)
    const seenRoles = new Set<string>();
    const exampleSchemas = remaining
        .filter(s => {
            if (seenRoles.has(s.slotRole)) return false;
            seenRoles.add(s.slotRole); return true;
        })
        .slice(0, 5)
        .map(s => `  - ${s.slotRole}: ${slotOutputSchema(s.slotRole)}`)
        .join('\n');

    // 一次目标填多少: 看剩余槽位多少, 角色越靠后填得越少 (前面已经填掉一些)
    const targetMin = Math.min(2, remaining.length);
    const targetMax = Math.min(5, remaining.length);

    const prompt = `今天是 ${date} (星期${dow})。这是一本 *大家共写* 的手账, 你 (角色「${char.name}」) 在这一页留下你今天的笔迹。

【你的人格档案】

${speechBlock}${todayChatBlock}

${filledBlock}

${remainingBlock}

${TODAY_ONLY_RULE}

【这一轮你要做什么】
你今天会在这本手账上**留 ${targetMin}~${targetMax} 条笔迹** (一次性, 不分轮)。每条都是一个槽位的填充。
内容主体应该是**写你自己今天**:
  - 1 条 hero-diary 或 mood-card: 你今天的主线 (生活片段 / 心情)
  - 多条 corner-note: 散落的小独白、看到的、想到的、口头禅式碎句
  - 0~2 条 sticky-reaction: 看到 "已填" 列表里某条有反应, 写便签 (refersTo 必填)

【⚠️ 内容硬约束】
- **可以"造谣"自己今天的生活流** — 早起做了什么、看到什么、买了什么、刷到什么、谁路过、突然想到什么…只要符合人设, 大胆写
- 但**不要虚构和 ${userName} 的共同事件** (没见面就不能编"我们一起去了…")
- 不要把过去的回忆当今天的事讲
- 不要把 ${userName} 当主语 ("想念 ${userName}" / "等 ${userName}" 通通禁绝)
- 严格模仿你的说话样本 — 语气/用词/句式/标点/口头禅
- 不要 emoji 开头, 不要标题, 不要 ** 加粗 (除偶尔笔感修饰)

【输出 JSON 数组】${targetMin}~${targetMax} 个对象。每个对象一个槽, 形如:
[
${exampleSchemas}
]

字段说明:
- slotId 必须是上面 "剩余可填的槽" 里列出的 id
- 每个 slotId 在你这一组里只能出现一次
- text 必填 (除 photo-caption 走 payload), 长度落在该槽 charBudget 区间
- sticky-reaction 必须 refersTo 引用 "已填" 列表里的某 slotId
- 不要 pass / 空内容 / 占位文本

直接输出 JSON 数组。`;

    // 一次主调 + 最多一次重试
    let attempt = 0;
    while (attempt < 2) {
        const isRetry = attempt > 0;
        const finalPrompt = isRetry
            ? prompt + `\n\n【⚠️ 重试】上一次响应没产出有效内容 (slotId 错 / 数组空 / sticky 没 refersTo)。再试一次, 必须返回 ${targetMin}~${targetMax} 个有效对象的数组。`
            : prompt;
        if (isRetry) console.warn(`[Handbook v2] ⟳ char "${char.name}" — 重试 (第 ${attempt + 1} 次)`);
        const raw = await callLLM(apiConfig, finalPrompt, 0.85, 6000, { char, user: userProfile });
        attempt++;
        if (!raw) {
            console.error(`[Handbook v2] ✗ char "${char.name}" — LLM 返回空`);
            continue;
        }
        console.log(`[Handbook v2] char "${char.name}" 原始 LLM 响应:\n${raw.length > 1000 ? raw.slice(0, 1000) + '\n…(截断)' : raw}`);
        const parsed = parseLLMJson(raw);
        let arr: any[];
        if (Array.isArray(parsed)) arr = parsed;
        else if (parsed && typeof parsed === 'object' && 'slotId' in parsed) arr = [parsed];   // 单对象兜底
        else {
            console.error(`[Handbook v2] ✗ char "${char.name}" — JSON 解析失败 / 不是数组, 类型=${typeof parsed}`);
            continue;
        }

        const out: FilledSlot[] = [];
        const usedSlotIds = new Set<string>();
        const dropped: string[] = [];

        for (const item of arr) {
            if (!item || typeof item !== 'object') { dropped.push('非对象'); continue; }
            const slotId = String(item.slotId || '').toUpperCase();
            if (usedSlotIds.has(slotId)) { dropped.push(`${slotId} 重复`); continue; }       // 同 slot 不能重复
            const slot = remaining.find(s => s.id === slotId);
            if (!slot) { dropped.push(`未知 slotId=${slotId}`); continue; }
            const text = typeof item.text === 'string' ? item.text.trim() : '';
            const payload = sanitizePayload(item.payload, slot.slotRole);
            if (!text && !payload) { dropped.push(`${slotId} 内容空`); continue; }

            let refersTo: string | undefined;
            if (slot.slotRole === 'sticky-reaction') {
                refersTo = String(item.refersTo || '').toUpperCase();
                // 引用必须在 "filled" (此次新填的不算, 不允许自引环)
                const exists = filled.find(f => f.slotId === refersTo);
                if (!exists) {
                    dropped.push(`${slotId} sticky refersTo=${refersTo || '空'} 无效`);
                    continue;
                }
            }

            usedSlotIds.add(slotId);
            out.push({
                slotId: slot.id,
                slotRole: slot.slotRole,
                text: clampText(text, slot.charBudget),
                payload,
                authorKind: 'char',
                authorName: char.name,
                charId: char.id,
                refersTo,
            });
        }

        if (out.length > 0) {
            console.log(`[Handbook v2] ◀ char "${char.name}" 完成 — 填了 ${out.length} 个槽 [${out.map(f => `${f.slotId}/${f.slotRole}`).join(', ')}]${dropped.length ? `, 丢弃 ${dropped.length} 条 (${dropped.join('; ')})` : ''}`);
            for (const f of out) {
                const preview = f.text || (f.payload ? `[payload:${f.payload.kind}]` : '');
                console.log(`[Handbook v2]   • [${f.slotId}] ${f.slotRole}${f.refersTo ? ` →${f.refersTo}` : ''}: ${preview.length > 80 ? preview.slice(0, 80) + '…' : preview}`);
            }
            return out;
        }
        console.error(`[Handbook v2] ✗ char "${char.name}" 第 ${attempt} 次没出有效内容${dropped.length ? `, 丢弃: ${dropped.join('; ')}` : ''}`);
    }
    console.error(`[Handbook v2] ╳ char "${char.name}" 两次都不行 — 这一格留白`);
    return [];
}

// ─── 3. 主入口: composePageV2 ────────────────────────────
export interface ComposeV2Input {
    date: string;
    selectedCharIds: string[];
    characters: CharacterProfile[];
    userProfile: UserProfile;
    apiConfig: ApiConfig;
    /** 强制使用某模板 id, 不传则按条件自动选 */
    forcedTemplateId?: string;
    /** 一天最多让几个角色参与 (默认 6 — 尊重 user 选择, 选了几个就跑几个) */
    maxChars?: number;
    /** 进度回调 — 给 UI 用 */
    onProgress?: (info: { stage: 'user' | 'char'; name: string; i: number; n: number }) => void;
}

export interface ComposeV2Result {
    pages: HandbookPage[];
    layouts: HandbookLayout[];
    templateId: string;
    /** debug: 哪些槽留白了 */
    skippedSlotIds: string[];
    /** 实际参与的 char ids (被 cap 截掉的不在内) */
    participatingCharIds: string[];
}

const DEFAULT_MAX_CHARS = 6;

export async function composePageV2(input: ComposeV2Input): Promise<ComposeV2Result> {
    const { date, characters, userProfile, apiConfig, forcedTemplateId, onProgress } = input;
    const maxChars = Math.max(0, input.maxChars ?? DEFAULT_MAX_CHARS);
    const userName = userProfile.name || '我';

    console.log('═══════════════════════════════════════════════════════');
    console.log(`[Handbook v2] 🟣 composePageV2 启动 — date=${date}`);
    console.log(`[Handbook v2] 候选角色 (${input.selectedCharIds.length} 个): [${input.selectedCharIds.map(id => characters.find(c => c.id === id)?.name || id).join(', ')}]`);
    console.log(`[Handbook v2] maxChars=${maxChars} (${input.maxChars !== undefined ? '调用方传入' : '默认 ' + DEFAULT_MAX_CHARS})`);

    // ─── 1. 决定哪些 char 参与 (按今日聊天活跃度排序, cap N) ──
    const charsWithActivity: { id: string; userMsgs: number; charMsgs: number }[] = [];
    for (const cid of input.selectedCharIds) {
        const c = characters.find(x => x.id === cid);
        if (!c) continue;
        const { lines, userMsgCount } = await todayChatLines(c, date, userName);
        charsWithActivity.push({
            id: cid,
            userMsgs: userMsgCount,
            charMsgs: lines.length - userMsgCount,
        });
    }
    // 排序: 今日总活跃度降序 → 优先让 "今天真有素材" 的角色参与
    charsWithActivity.sort((a, b) =>
        (b.userMsgs + b.charMsgs) - (a.userMsgs + a.charMsgs)
    );
    const participating = charsWithActivity.slice(0, maxChars);
    const totalUserMsgs = charsWithActivity.reduce((s, x) => s + x.userMsgs, 0);

    console.log(`[Handbook v2] 活跃度排序后:`);
    for (const x of charsWithActivity) {
        const c = characters.find(ch => ch.id === x.id);
        console.log(`[Handbook v2]   - ${c?.name || x.id}: userMsgs=${x.userMsgs}, charMsgs=${x.charMsgs}`);
    }
    if (charsWithActivity.length > maxChars) {
        const cut = charsWithActivity.slice(maxChars);
        console.warn(`[Handbook v2] ⚠ 候选超过 maxChars(${maxChars}), 砍掉 ${cut.length} 个: [${cut.map(x => characters.find(c => c.id === x.id)?.name).join(', ')}]`);
    }
    console.log(`[Handbook v2] 实际参与 (${participating.length}): [${participating.map(p => characters.find(c => c.id === p.id)?.name).join(', ')}]`);
    console.log(`[Handbook v2] 总 user 消息数 (跨所有 char): ${totalUserMsgs}`);

    // ─── 2. roll layout ──
    let template = forcedTemplateId ? LAYOUT_TEMPLATES[forcedTemplateId] : null;
    if (!template) {
        template = pickTemplate({
            userMsgCount: totalUserMsgs,
            charCount: participating.length,
        });
    }
    console.log(`[Handbook v2] 选用版式: ${template.id} (${template.name}), 共 ${template.pages.flat().length} 槽位`);

    // ─── 3. 进度
    const userWillRun = totalUserMsgs > 0;
    const totalTurns = (userWillRun ? 1 : 0) + participating.length;
    let turnIdx = 0;
    const tick = (stage: 'user' | 'char', name: string) => {
        turnIdx++;
        onProgress?.({ stage, name, i: turnIdx, n: totalTurns });
    };

    const filled: FilledSlot[] = [];

    // ─── 4. user 步 (仅当有今日聊天) ──
    if (userWillRun) {
        tick('user', userName);
        const userFilled = await fillUserSlots(
            template, date, input.selectedCharIds, characters, userProfile, apiConfig,
        );
        filled.push(...userFilled);
    }

    // ─── 5. chars 顺序轮 (每个 char 一次 LLM 调用, 出 2~5 条 fragment) ──
    for (const { id } of participating) {
        const c = characters.find(x => x.id === id);
        if (!c) continue;
        tick('char', c.name);
        const charFills = await fillCharTurn(c, template, filled, date, userProfile, apiConfig);
        filled.push(...charFills);
    }

    // ─── 6. 收尾 ──
    const allSlots = template.pages.flat();
    const skippedSlotIds = allSlots
        .filter(s => !filled.find(f => f.slotId === s.id))
        .map(s => s.id);

    console.log(`[Handbook v2] 🟢 完成 — 共填 ${filled.length}/${allSlots.length} 个槽`);
    const byAuthor: Record<string, number> = {};
    for (const f of filled) byAuthor[f.authorName] = (byAuthor[f.authorName] || 0) + 1;
    console.log(`[Handbook v2] 按作者: ${Object.entries(byAuthor).map(([a, n]) => `${a}=${n}`).join(', ')}`);
    if (skippedSlotIds.length > 0) {
        console.log(`[Handbook v2] 留白槽 (${skippedSlotIds.length}): [${skippedSlotIds.join(', ')}]`);
    }
    console.log('═══════════════════════════════════════════════════════');

    const result = buildPagesAndLayout(template, filled, date);
    return {
        ...result,
        templateId: template.id,
        skippedSlotIds,
        participatingCharIds: participating.map(p => p.id),
    };
}

// ─── filled → HandbookPage[] + HandbookLayout ────────────
//
// 旧渲染管道吃 HandbookPage[] (有 fragments) + HandbookLayout (placements 指 fragment).
// 我们让每个作者一份 HandbookPage, fragments 是 ta 填的所有槽; placements 按
// SlotDef 的位置生成, 同时把 SlotRole / payload 传进 fragment.
function buildPagesAndLayout(
    template: LayoutTemplate,
    filled: FilledSlot[],
    date: string,
): { pages: HandbookPage[]; layouts: HandbookLayout[] } {
    const allSlots = template.pages.flat();
    // 按作者分组 → 一个 HandbookPage / 作者
    const byAuthor: Map<string, FilledSlot[]> = new Map();
    for (const f of filled) {
        const key = f.authorKind === 'user' ? '__user__' : (f.charId || `__char__${f.authorName}`);
        if (!byAuthor.has(key)) byAuthor.set(key, []);
        byAuthor.get(key)!.push(f);
    }

    const pages: HandbookPage[] = [];
    const placements: LayoutPlacement[] = [];

    for (const [key, fs] of byAuthor.entries()) {
        const isUser = key === '__user__';
        const charId = isUser ? undefined : fs[0].charId;
        const pageId = isUser
            ? `udiary-${date}-${Date.now()}`
            : `lifestream-${charId || fs[0].authorName}-${date}-${Date.now()}`;

        const fragments: HandbookFragment[] = fs.map((f, i) => ({
            id: `frag-${pageId}-${i}-${f.slotId}`,
            text: f.text,
            slotId: f.slotId,
            slotRole: f.slotRole,
            authorKind: f.authorKind,
            refersTo: f.refersTo,
            payload: f.payload,
        }));

        const content = fs.map(f => f.text || (f.payload ? JSON.stringify(f.payload) : '')).filter(Boolean).join('\n\n');

        const page: HandbookPage = {
            id: pageId,
            type: isUser ? 'user_diary' : 'character_life',
            charId,
            content,
            fragments,
            paperStyle: template.paperStyle || 'plain',
            generatedBy: 'llm',
            generatedAt: Date.now(),
        };
        pages.push(page);

        // placements
        for (const f of fs) {
            const slot = allSlots.find(s => s.id === f.slotId);
            if (!slot) continue;
            const fragId = fragments.find(fr => fr.slotId === f.slotId)?.id;
            placements.push({
                pageId, fragmentId: fragId,
                xPct: slot.xPct, yPct: slot.yPct, widthPct: slot.widthPct,
                rotate: slot.rotate ?? 0, zIndex: slot.zIndex ?? 10,
                role: slotRoleToLegacyRole(slot.slotRole),
                isHero: !!slot.isHero,
                slotId: slot.id, slotRole: slot.slotRole,
                maxHeightPct: slot.maxHeightPct, skinVariant: slot.skinVariant,
            });
        }
    }

    const layout: HandbookLayout = {
        pageNumber: 1,
        placements,
        generatedAt: Date.now(),
        templateId: template.id,
    };

    return { pages, layouts: [layout] };
}

// 新 SlotRole → 旧 LayoutRole 兜底 (老渲染器还在用)
function slotRoleToLegacyRole(role: SlotRole): 'main' | 'side' | 'corner' | 'margin' {
    switch (role) {
        case 'hero-diary': return 'main';
        case 'timeline-plan': return 'main';
        case 'todo': return 'main';
        case 'gratitude': return 'side';
        case 'mood-card': return 'side';
        case 'photo-caption': return 'side';
        case 'sticky-reaction': return 'corner';
        case 'corner-note': return 'margin';
    }
}

// ─── 4. 单角色重生 (v2) ───────────────────────────────────
//
// 用法: handleRegenerateLifestream 调它, 拿到只更新该角色 slot 的结果。
// 流程: 找回原 templateId → 把其它角色 + user 的 fills 当作 "已填" → 再调一次 fillCharTurn。
export interface RegenCharInput {
    date: string;
    charId: string;
    pages: HandbookPage[];           // 当前所有 page
    layouts: HandbookLayout[];       // 当前所有 layout
    characters: CharacterProfile[];
    userProfile: UserProfile;
    apiConfig: ApiConfig;
}

export interface RegenCharResult {
    /** 新的 page (替换原 charId 的那条 LLM page) */
    newPage: HandbookPage | null;
    /** 新的整体 layouts (替换 entry.layouts) */
    newLayouts: HandbookLayout[];
}

export async function regenerateCharSlots(input: RegenCharInput): Promise<RegenCharResult> {
    const { date, charId, pages, layouts, characters, userProfile, apiConfig } = input;
    const char = characters.find(c => c.id === charId);
    if (!char) return { newPage: null, newLayouts: layouts };

    // 找 templateId — v2 layout 必须有
    const v2Layout = layouts.find(l => l.templateId);
    if (!v2Layout?.templateId) return { newPage: null, newLayouts: layouts };
    const template = LAYOUT_TEMPLATES[v2Layout.templateId];
    if (!template) return { newPage: null, newLayouts: layouts };

    // 重建 "已填的所有 slot" — 包含 user + 其它 chars (排除被重生的 char)
    const filled: FilledSlot[] = [];
    const allSlots = template.pages.flat();
    for (const page of pages) {
        if (page.charId === charId) continue;       // 跳过被重生的
        if (!page.fragments) continue;
        for (const frag of page.fragments) {
            if (!frag.slotId) continue;
            const slot = allSlots.find(s => s.id === frag.slotId);
            if (!slot) continue;
            const author = page.charId
                ? (characters.find(c => c.id === page.charId)?.name || '某角色')
                : (userProfile.name || '我');
            filled.push({
                slotId: frag.slotId,
                slotRole: frag.slotRole || slot.slotRole,
                text: frag.text,
                payload: frag.payload,
                authorKind: page.charId ? 'char' : 'user',
                authorName: author,
                charId: page.charId,
                refersTo: frag.refersTo,
            });
        }
    }

    // 调 char turn (返回数组, 一次出多条 fragment)
    const newFills = await fillCharTurn(char, template, filled, date, userProfile, apiConfig);
    if (newFills.length === 0) return { newPage: null, newLayouts: layouts };

    // 拼新 char page (一组 fragments)
    const newPageId = `lifestream-${charId}-${date}-${Date.now()}`;
    const fragments: HandbookFragment[] = newFills.map((f, i) => ({
        id: `frag-${newPageId}-${i}-${f.slotId}`,
        text: f.text,
        slotId: f.slotId,
        slotRole: f.slotRole,
        authorKind: 'char',
        refersTo: f.refersTo,
        payload: f.payload,
    }));
    const newPage: HandbookPage = {
        id: newPageId,
        type: 'character_life',
        charId,
        content: newFills.map(f => f.text || (f.payload ? JSON.stringify(f.payload) : '')).filter(Boolean).join('\n\n'),
        fragments,
        paperStyle: template.paperStyle || 'plain',
        generatedBy: 'llm',
        generatedAt: Date.now(),
    };

    // 重建 v2 layout: 剔除该 char 旧的 placements, 加新的多条
    const otherPlacements = v2Layout.placements.filter(pl => {
        const ownerPage = pages.find(p => p.id === pl.pageId);
        return ownerPage?.charId !== charId;
    });
    const newPlacements: LayoutPlacement[] = [];
    for (const f of newFills) {
        const slot = allSlots.find(s => s.id === f.slotId);
        if (!slot) continue;
        const fragId = fragments.find(fr => fr.slotId === f.slotId)?.id;
        newPlacements.push({
            pageId: newPageId, fragmentId: fragId,
            xPct: slot.xPct, yPct: slot.yPct, widthPct: slot.widthPct,
            rotate: slot.rotate ?? 0, zIndex: slot.zIndex ?? 10,
            role: slotRoleToLegacyRole(slot.slotRole),
            isHero: !!slot.isHero,
            slotId: slot.id, slotRole: slot.slotRole,
            maxHeightPct: slot.maxHeightPct, skinVariant: slot.skinVariant,
        });
    }
    const newV2Layout: HandbookLayout = {
        ...v2Layout,
        placements: [...otherPlacements, ...newPlacements],
        generatedAt: Date.now(),
    };
    const newLayouts = layouts.map(l => l === v2Layout ? newV2Layout : l);
    return { newPage, newLayouts };
}

// ─── 5. 删 / 编辑后重算 layout ────────────────────────────
//
// 旧的 composePageLayout 会重洗版式 — v2 不要。这个 helper:
//  1. 保留所有 v2 layouts 的 placement, 但剔除指向已删除 page 的
//  2. user_note (用户手写) 走旧 composePageLayout 单独排, 拼到 v2 之后
//
// 调用方: HandbookApp 里 updatePage / handleDeletePage / handleAddNote 等
//
// 注: 这里不依赖旧 composePageLayout (避免循环 import), HandbookApp 自己处理 user_note。
//     这个函数只负责 v2 部分的重算。
export function recomposeV2Layouts(
    layouts: HandbookLayout[],
    pages: HandbookPage[],
): HandbookLayout[] {
    return layouts
        .filter(l => l.templateId)
        .map(l => ({
            ...l,
            placements: l.placements.filter(pl => pages.some(p => p.id === pl.pageId)),
        }))
        .filter(l => l.placements.length > 0);
}

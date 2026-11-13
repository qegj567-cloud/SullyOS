/**
 * 手账生成器
 *
 * 两个独立管线 (NOT 复用 daily_schedule 的 flowNarrative —— 那个会被覆盖且和 user 强耦合)：
 *
 * 1. generateUserDiaryPage —— 主体
 *    给 LLM 喂 user 当日所有跨角色聊天，让 ta 用第一人称、碎片日记体替 user 写一份草稿。
 *    user 会二次编辑，所以不强求模仿语气，只追求"事实可读、留白真实"。
 *
 * 2. generateLifestreamPage —— 陪伴页（仅 lifestyle 角色）
 *    单独调一次 LLM 生成"角色今天的小生活"短文，存进当日 handbook entry。
 *    硬性约束：不准 AI 捧场、不准等/想 user 当主语，user 至多一带而过。
 *    mindful 角色不进此管线（ta 们没有"小生活"可写）。
 */

import {
    CharacterProfile, UserProfile, Message,
    HandbookPage, HandbookFragment, HandbookLayout, LayoutPlacement, LayoutRole,
} from '../types';
import { DB } from './db';
import { loadCharacterContextMessages } from './chatContextRange';
import { safeResponseJson, extractJson } from './safeApi';
import { ContextBuilder } from './context';
import { getLocalDayRange } from './localDate';

// 局部 seedFloat — composePageLayout 用 (不引用 components/ 避免 utils → components 反向依赖).
// FNV-1a + xorshift, 与 paper.tsx 里同名函数行为一致.
function seedFloat(seed: string, salt: number = 0): number {
    let h = ((salt | 0) + 0x811c9dc5) >>> 0;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
    h ^= h >>> 15;
    return (h >>> 0) / 0x100000000;
}

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ─── 工具：把 LLM 输出的 JSON 数组解析成 HandbookFragment[] ─
function parseFragmentsFromLLMOutput(raw: string): HandbookFragment[] {
    let s = raw.trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    let parsed: any = null;
    try {
        parsed = JSON.parse(s);
    } catch {
        // extractJson 兜底:从乱七八糟里掏 JSON
        try { parsed = extractJson(s); } catch {}
    }
    if (!parsed || !Array.isArray(parsed)) return [];
    return parsed
        .map((item: any, i: number): HandbookFragment | null => {
            if (typeof item === 'string') {
                return { id: `frag-${Date.now()}-${i}`, text: item.trim() };
            }
            if (item && typeof item === 'object') {
                const text = typeof item.text === 'string' ? item.text.trim()
                           : typeof item.content === 'string' ? item.content.trim()
                           : '';
                if (!text) return null;
                const time = typeof item.time === 'string' ? item.time.trim()
                           : typeof item.timeHint === 'string' ? item.timeHint.trim()
                           : undefined;
                return { id: `frag-${Date.now()}-${i}`, text, time };
            }
            return null;
        })
        .filter((f): f is HandbookFragment => !!f && f.text.length > 1);
}

// 把 fragments 拼成可读的 plain text(存 content 字段,user 编辑/兜底用)
function fragmentsToPlainText(fragments: HandbookFragment[]): string {
    return fragments.map(f => f.time ? `[${f.time}] ${f.text}` : f.text).join('\n\n');
}

// ─── 工具：取一天范围 [start, end) 的 ms ───
function dayRange(date: string): { start: number; end: number } {
    return getLocalDayRange(date) || { start: 0, end: 0 };
}

// 把单条消息渲染成一行文本，截掉过长内容；过滤系统/工具/隐藏内容
function renderMsgLine(m: Message, userName: string, charName: string): string | null {
    if (m.role === 'system') return null;
    if (!m.content || typeof m.content !== 'string') return null;
    const raw = m.content.trim();
    if (!raw) return null;
    // 过滤纯结构化的 JSON / 系统消息（启发式）
    if (raw.startsWith('{') && raw.endsWith('}') && raw.length > 50 && /"\w+"\s*:/.test(raw)) {
        return null;
    }
    const speaker = m.role === 'user' ? userName : charName;
    const text = raw.length > 220 ? raw.slice(0, 220) + '…' : raw;
    return `${speaker}: ${text}`;
}

// 取 user 当日和某角色的对话片段（按时间升序）
async function getTodayChatLines(
    char: CharacterProfile,
    date: string,
    userName: string,
): Promise<{ lines: string[]; userMsgCount: number }> {
    const { start, end } = dayRange(date);
    // includeProcessed=true 绕过记忆宫殿水位线，拿到 raw 数据
    const all = await DB.getMessagesByCharId(char.id, true);
    const today = all
        .filter(m => m.timestamp >= start && m.timestamp < end)
        .sort((a, b) => a.timestamp - b.timestamp);
    const lines: string[] = [];
    let userMsgCount = 0;
    for (const m of today) {
        const line = renderMsgLine(m, userName, char.name);
        if (line) {
            lines.push(line);
            if (m.role === 'user') userMsgCount++;
        }
    }
    return { lines, userMsgCount };
}

// ─── 共用: 估高 / 占位渲染 / turn 输出解析 ───────────────

const PAGE_W_DEFAULT = 360;
const PAGE_H_DEFAULT = 720;

/** 估计一张卡片的高度(% of page);chars + widthPct → est lines → est px → est %. */
export function estHeightPctFromChars(chars: number, widthPct: number, pageHeight: number = PAGE_H_DEFAULT, role: 'main' | 'side' | 'corner' | 'margin' = 'main'): number {
    const charsPerLine = Math.max(8, Math.floor(widthPct * 0.16));
    const lines = Math.max(1, Math.ceil(chars / charsPerLine));
    const base = role === 'margin' ? 4 : role === 'corner' ? 6 : 9;
    return Math.min(60, lines * 3.4 + base);
}

function renderOccupiedBlock(occupied: PlacementHint[]): string {
    if (occupied.length === 0) {
        return `【占用情况】纸还是空的, 你怎么摆都行 (但留出页眉 yPct < 8 给日期, 页脚 yPct > 88 给页码).`;
    }
    const byPage: Record<number, PlacementHint[]> = {};
    for (const o of occupied) {
        const k = o.pageNumber;
        if (!byPage[k]) byPage[k] = [];
        byPage[k].push(o);
    }
    const lines: string[] = [`【已被占用 — 你必须避开这些区域, 留 ≥ 3% 间距】`];
    for (const k of Object.keys(byPage).sort()) {
        const items = byPage[Number(k)];
        lines.push(`page ${k}:`);
        for (const o of items) {
            const x2 = (o.xPct + o.widthPct).toFixed(0);
            const y2 = (o.yPct + o.estHeightPct).toFixed(0);
            const preview = o.textPreview.length > 28 ? o.textPreview.slice(0, 28) + '…' : o.textPreview;
            lines.push(`  - bbox(${o.xPct.toFixed(0)},${o.yPct.toFixed(0)})~(${x2},${y2}) by ${o.author}: ${preview.replace(/\n/g, ' ')}`);
        }
    }
    return lines.join('\n');
}

/** 一片轮回的输出 — placement 比 LayoutPlacement 多带 pageNumber, 用来分组到不同 HandbookLayout */
export interface PlacedPiece extends LayoutPlacement {
    pageNumber: number;
}

interface TurnOutputParsed {
    fragments: HandbookFragment[];
    placements: PlacedPiece[];
}

/** 解析 LLM 一次输出 — 它的 JSON 数组里每条同时含 text+time+page+xPct+yPct+widthPct+role */
function parseTurnOutput(raw: string, pageId: string, occupied: PlacementHint[]): TurnOutputParsed {
    const stripped = raw.trim()
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();
    let parsed: any;
    try { parsed = JSON.parse(stripped); }
    catch { try { parsed = extractJson(stripped); } catch { parsed = null; } }

    if (!parsed) return { fragments: [], placements: [] };
    // 兼容: { items: [...] } / { fragments: [...] } / [ ... ]
    let arr: any[] = [];
    if (Array.isArray(parsed)) arr = parsed;
    else if (Array.isArray(parsed.items)) arr = parsed.items;
    else if (Array.isArray(parsed.fragments)) arr = parsed.fragments;
    else if (Array.isArray(parsed.placements)) arr = parsed.placements;
    else {
        for (const v of Object.values(parsed)) {
            if (Array.isArray(v) && v.length > 0) { arr = v; break; }
        }
    }
    if (arr.length === 0) return { fragments: [], placements: [] };

    const clamp = (n: any, lo: number, hi: number) => {
        const v = Number(n);
        if (!Number.isFinite(v)) return (lo + hi) / 2;
        return Math.max(lo, Math.min(hi, v));
    };
    const normalizeRole = (r: any): LayoutRole => {
        const s = String(r ?? '').toLowerCase().trim();
        if (s.startsWith('main') || s === 'center' || s === 'body') return 'main';
        if (s.startsWith('side')) return 'side';
        if (s.startsWith('corner')) return 'corner';
        if (s.startsWith('margin') || s === 'edge') return 'margin';
        return 'main';
    };

    const fragments: HandbookFragment[] = [];
    const placements: PlacedPiece[] = [];

    arr.forEach((item, i) => {
        if (!item || typeof item !== 'object') return;
        const text = typeof item.text === 'string' ? item.text.trim()
                   : typeof item.content === 'string' ? item.content.trim()
                   : '';
        if (!text || text.length < 1) return;
        const time = typeof item.time === 'string' && item.time.trim() ? item.time.trim() : undefined;
        const fragmentId = `frag-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`;
        fragments.push({ id: fragmentId, text, time });

        const role = normalizeRole(item.role ?? item.kind ?? item.slot);
        const widthPct = clamp(item.widthPct ?? item.width ?? item.w ?? 50, 18, 92);
        const pageNumberRaw = item.page ?? item.pageNumber ?? item.pageNum ?? 1;
        const pageNumber = Math.max(1, Math.min(2, Math.round(Number(pageNumberRaw)) || 1));
        const placement: PlacedPiece = {
            pageId,
            fragmentId,
            xPct: clamp(item.xPct ?? item.x ?? item.left ?? 5, 0, 92),
            yPct: clamp(item.yPct ?? item.y ?? item.top ?? 5, 0, 92),
            widthPct,
            rotate: clamp(item.rotate ?? item.rotation ?? 0, -15, 15),
            zIndex: 10 + i,
            role,
            pageNumber,
        };
        placements.push(placement);
    });

    // 客户端兜底:有的 LLM 还是会和 occupied 撞 → 把撞的往下推
    nudgeAwayFromOccupied(placements, occupied, fragments);

    return { fragments, placements };
}

/** 把和 occupied 撞或彼此撞的 placement 向下推; 不造内容只挪位置 */
function nudgeAwayFromOccupied(
    placements: PlacedPiece[],
    occupied: PlacementHint[],
    fragments: HandbookFragment[],
): void {
    type Box = { x1: number; y1: number; x2: number; y2: number; page: number };
    const PAD = 1.5;
    const intersect = (a: Box, b: Box) =>
        a.page === b.page &&
        !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1);

    const occBoxes: Box[] = occupied.map(o => ({
        x1: o.xPct - PAD, y1: o.yPct - PAD,
        x2: o.xPct + o.widthPct + PAD, y2: o.yPct + o.estHeightPct + PAD,
        page: o.pageNumber,
    }));

    const placedBoxes: Box[] = [];
    placements.forEach((pl, i) => {
        const fragmentText = fragments[i]?.text ?? '';
        const charCount = fragmentText.length;
        const role = (pl.role === 'margin' || pl.role === 'corner') ? pl.role : 'main';
        const estH = estHeightPctFromChars(charCount, pl.widthPct, PAGE_H_DEFAULT, role);
        let box: Box = {
            x1: pl.xPct - PAD, y1: pl.yPct - PAD,
            x2: pl.xPct + pl.widthPct + PAD, y2: pl.yPct + estH + PAD, page: pl.pageNumber,
        };
        let safety = 0;
        while (safety++ < 20) {
            const collide =
                occBoxes.find(b => intersect(b, box)) ??
                placedBoxes.find(b => intersect(b, box));
            if (!collide) break;
            const newY = collide.y2 + 0.5;
            if (newY > 88) {
                pl.yPct = 88;
                box = { ...box, y1: pl.yPct - PAD, y2: pl.yPct + estH + PAD };
                break;
            }
            pl.yPct = Math.min(88, newY);
            box = { ...box, y1: pl.yPct - PAD, y2: pl.yPct + estH + PAD };
        }
        placedBoxes.push(box);
    });
}

/** 工具: placements + fragments → 下一轮可以用的 occupied hints */
export function placementsToHints(
    placements: PlacedPiece[],
    fragments: HandbookFragment[],
    author: string,
): PlacementHint[] {
    return placements.map((pl, i) => {
        const text = fragments[i]?.text ?? '';
        const role = (pl.role === 'corner' || pl.role === 'margin') ? pl.role : 'main';
        return {
            pageNumber: pl.pageNumber,
            xPct: pl.xPct,
            yPct: pl.yPct,
            widthPct: pl.widthPct,
            estHeightPct: estHeightPctFromChars(text.length, pl.widthPct, PAGE_H_DEFAULT, role),
            author,
            textPreview: text.length > 30 ? text.slice(0, 30) + '…' : text,
        };
    });
}

/** 工具: placedPieces[] → HandbookLayout[] (按 pageNumber 分组) */
export function placedPiecesToLayouts(pieces: PlacedPiece[]): HandbookLayout[] {
    const byPage: Record<number, LayoutPlacement[]> = {};
    for (const p of pieces) {
        const k = p.pageNumber;
        if (!byPage[k]) byPage[k] = [];
        const { pageNumber: _pn, ...rest } = p;
        byPage[k].push(rest);
    }
    return Object.keys(byPage)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => ({
            pageNumber: Number(k),
            placements: byPage[Number(k)],
            generatedAt: Date.now(),
        }));
}

// ─── 1. user 视角日记（跨角色聚合）─────────────────────────
//
// 新设计 (轮回写作): 这一次 LLM 调用同时产出"写什么"和"写在哪"。
// LLM 收到一个"已经被占用的区域"列表 (前面作者已经摆好的卡片 bbox),
// 必须把自己新写的 fragment 摆在空位, 不许重叠。
//
export interface PlacementHint {
    pageNumber: number;        // 1 起
    xPct: number;
    yPct: number;
    widthPct: number;
    estHeightPct: number;      // 服务端估算的高度
    author: string;            // "我" / 角色名
    textPreview: string;       // 截 30 字给 LLM 提示这格里写的啥
}

export interface UserDiaryGenInput {
    date: string;                  // YYYY-MM-DD
    selectedCharIds: string[];     // 入册的角色（默认：今天聊过的）
    characters: CharacterProfile[];
    userProfile: UserProfile;
    apiConfig: ApiConfig;
    /** 篇幅预算: 期望生成多少条 fragment(±2);0 = 跳过该 page */
    fragmentBudget?: number;
    /** 已经被前面作者占用的区域,这次摆位必须避开 */
    occupied?: PlacementHint[];
    /** 画布像素尺寸,只用于换算估高 */
    canvasPixelHint?: { width: number; height: number };
    /** 当前最大已用页码;新片可在 [1, maxPage+1] 之间选,但总数不超 2 */
    maxPageInUse?: number;
}

export interface UserDiaryGenResult {
    page: HandbookPage | null;
    /** 此次 LLM 给的位置 (含 pageNumber, 待调用方分组合到 layouts) */
    placements: PlacedPiece[];
    totalUserMsgs: number;
    perChar: { charId: string; charName: string; userMsgs: number; totalLines: number }[];
}

export async function generateUserDiaryPage(
    input: UserDiaryGenInput,
): Promise<UserDiaryGenResult> {
    const {
        date, selectedCharIds, characters, userProfile, apiConfig, fragmentBudget,
        occupied = [], canvasPixelHint, maxPageInUse,
    } = input;
    const userName = userProfile.name || '我';

    const perChar: UserDiaryGenResult['perChar'] = [];
    const transcriptParts: string[] = [];
    let totalUserMsgs = 0;

    for (const charId of selectedCharIds) {
        const char = characters.find(c => c.id === charId);
        if (!char) continue;
        const { lines, userMsgCount } = await getTodayChatLines(char, date, userName);
        perChar.push({ charId, charName: char.name, userMsgs: userMsgCount, totalLines: lines.length });
        totalUserMsgs += userMsgCount;
        if (lines.length === 0) continue;
        // 控制单角色片段长度（最多 60 行，避免某天极长对话压垮 prompt）
        const trimmed = lines.length > 60 ? lines.slice(-60) : lines;
        transcriptParts.push(`== 与「${char.name}」==\n${trimmed.join('\n')}`);
    }

    if (totalUserMsgs === 0 || transcriptParts.length === 0) {
        return { page: null, placements: [], totalUserMsgs, perChar };
    }

    const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][new Date(date.replace(/-/g, '/')).getDay()];

    // 篇幅预算: 默认 5~9 条,有外部预算就遵循
    const targetCount = fragmentBudget && fragmentBudget > 0
        ? `${Math.max(1, fragmentBudget - 1)} ~ ${fragmentBudget + 1}`
        : '5 ~ 9';

    const W = canvasPixelHint?.width ?? 360;
    const H = canvasPixelHint?.height ?? 720;
    const occupiedBlock = renderOccupiedBlock(occupied);
    const maxAllowedPage = Math.min(2, (maxPageInUse ?? 0) + 1) || 1;

    const prompt = `今天是 ${date}（星期${dayOfWeek}）。

你是「${userName}」的私人手账代笔。请基于 ${userName} 今天和不同角色的对话碎片,在一张 ${W}x${H}px 的瘦长手帐纸上**亲手写下**${userName} 的"今日碎片"——是社媒碎碎念体(像微博/Twitter 单条),不是规整日记。**写什么 + 写在哪都你定**。

${occupiedBlock}

【输出 JSON 数组】每条同时包含内容和位置:
[
  { "time": "上午", "text": "...", "page": 1, "xPct": 8, "yPct": 10, "widthPct": 62, "role": "main" },
  { "text": "好困", "page": 1, "xPct": 70, "yPct": 16, "widthPct": 28, "role": "corner" },
  ...
]

【内容要求】
- ${targetCount} 条之间
- time 可选 ("上午"/"中午"/"下午"/"深夜"/"10:23")
- text 必填,正常条 30~80 字
- 鼓励 1~2 条**< 14 字的涂鸦句** (例: "下雨了。" / "好困" / "今天买花。") — 会渲染成大字手写
- 第一人称,单瞬间+情绪,不叙事堆叠
- 只写 ${userName} 真做过/说过的, 没素材就少写
- 不把角色当收件人, 不 AI 升华, 不 emoji

【位置要求 — 关键】
- page: 1 或 2 (现在最多到第 ${maxAllowedPage} 页)
- xPct/yPct: 卡片左上角占整页百分比 [0, 90]
- widthPct: 卡片宽度 [22, 88]
- role: "main"(主区,长卡 chars>50, widthPct 55~85) / "side"(中型 40~62) / "corner"(角落小卡 chars<35, widthPct 28~50) / "margin"(< 14 字涂鸦, widthPct 28~42)
- **新片必须摆在已占区域之外**,bbox 不能与 occupied 列表里任何片重叠,留 ≥ 3% 间距
- 1 页能装就 1 页,不强行拆 page 2
- 同 page 内卡片高度估算 = chars / (widthPct*0.16) * 3.4 + 6 (% of page)

【可选笔感修饰】 text 里允许少量 markdown:
**粗** *斜* ==高亮== ~~删~~ [color:red/pink/blue/sky/green/mint/yellow/purple/orange](文)
每条最多用 1 处,不滥用。

【今日对话素材】
${transcriptParts.join('\n\n')}

直接输出 JSON 数组。`;

    const activeChars = perChar.filter(p => p.totalLines > 0);
    const soleChar = activeChars.length === 1 ? activeChars[0] : undefined;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.8,
                max_tokens: 12000,
            }),
            __sullyMeta: {
                appId: 'handbook',
                appName: '手账',
                ...(soleChar ? { charId: soleChar.charId, charName: soleChar.charName } : {}),
                purpose: '日记手账生成',
            },
        } as RequestInit);
        if (!response.ok) {
            console.error('[Handbook/UserDiary] API error:', response.status);
            return { page: null, placements: [], totalUserMsgs, perChar };
        }
        const data = await safeResponseJson(response);
        let raw: string = data.choices?.[0]?.message?.content || '';
        raw = raw.trim();
        if (raw.length < 4) return { page: null, placements: [], totalUserMsgs, perChar };

        // 同时解析 fragments 和 placements
        const pageId = `udiary-${date}-${Date.now()}`;
        const { fragments, placements } = parseTurnOutput(raw, pageId, occupied);
        if (fragments.length === 0) {
            return { page: null, placements: [], totalUserMsgs, perChar };
        }
        const content = fragmentsToPlainText(fragments);

        const page: HandbookPage = {
            id: pageId,
            type: 'user_diary',
            content,
            fragments,
            paperStyle: 'lined',
            generatedBy: 'llm',
            generatedAt: Date.now(),
        };
        return { page, placements, totalUserMsgs, perChar };
    } catch (e) {
        console.error('[Handbook/UserDiary] failed:', e);
        return { page: null, placements: [], totalUserMsgs, perChar };
    }
}

// ─── 2. 生活系角色生活流（陪伴页）──────────────────────────
//
// 设计原则(user 反馈对齐 2026-04, depth + 角色沉淀注入版):
// - 角色一天不是一句话,要丰满、有节奏
// - 接入 DailySchedule.slots 作为骨架
// - **大量注入角色沉淀**: worldview / personalityStyle / selfInsights /
//   refinedMemories / impression。深度从角色内核来,不是凭空"看猫想到无常"
// - **类型配比强制**: physical / reflection / observation / user_thought
//   "看到野猫打架想起你"作为反例 few-shot 严禁
// - **3 档深度** light/medium/deep,调整四类型配比和字数
// - 红线: 不要虚构 user 和角色共同发生的事
//
export type LifestreamDepth = 'light' | 'medium' | 'deep';

export interface LifestreamGenResult {
    page: HandbookPage | null;
    placements: PlacedPiece[];
}

export async function generateLifestreamPage(
    char: CharacterProfile,
    date: string,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    depth: LifestreamDepth = 'medium',
    /** 篇幅预算: 期望 fragment 数(±1);0 跳过 */
    fragmentBudget?: number,
    /** 已经被前面作者占用的区域,这次摆位必须避开 */
    occupied: PlacementHint[] = [],
    /** 当前最大已用页码 */
    maxPageInUse: number = 0,
    canvasPixelHint?: { width: number; height: number },
): Promise<LifestreamGenResult> {

    if (fragmentBudget !== undefined && fragmentBudget <= 0) return { page: null, placements: [] };
    // (取消 lifestyle gate: 只要 user 把 ta 选进来,就让 ta 在这页留一笔。
    //  scheduleStyle 仍用于决定是否注入 schedule 骨架。)
    const userName = userProfile.name || 'user';
    const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][new Date(date.replace(/-/g, '/')).getDay()];

    // ─── 1. 直接调项目统一的 ContextBuilder.buildCoreContext ──
    //   它已经处理了:身份/systemPrompt/selfInsights/worldview/mountedWorldbooks
    //   /user profile/impression(完整含 likes/triggers/comfort/changes)
    //   /refinedMemories/activeMemoryMonths 详细日志/memoryPalace/buff
    //   是聊天系统在用的 source of truth,改它会自动跟进
    const characterContextInput = { char, user: userProfile, includeDetailedMemories: true };


    // ─── 1b. ta 实际怎么说话 — buildCoreContext 没的,得自己补 ──
    // 这是"像不像 ta"最关键的输入: prompt 描述规则,样本展示语气
    let speechSamples: string[] = [];
    try {
        const all = await loadCharacterContextMessages(char);
        const charMsgs = all.filter(m =>
            m.role === 'assistant'
            && typeof m.content === 'string'
            && m.content.length > 4
            && m.content.length < 600
            && !(m.content.trim().startsWith('{') && m.content.trim().endsWith('}'))
        );
        // 在可见范围内均匀抽 30 条语气样本
        if (charMsgs.length <= 30) {
            speechSamples = charMsgs.map(m => m.content.slice(0, 200));
        } else {
            const step = charMsgs.length / 30;
            for (let i = 0; i < 30; i++) {
                const idx = Math.floor(i * step);
                speechSamples.push(charMsgs[idx].content.slice(0, 200));
            }
        }
    } catch { /* 无所谓 */ }

    // ─── 2. 当日 schedule slots ──
    let scheduleBlock = '';
    try {
        const sched = await DB.getDailySchedule(char.id, date);
        if (sched && sched.slots && sched.slots.length > 0) {
            const lines = sched.slots.map(s => {
                const parts = [`- ${s.startTime}`, s.activity];
                if (s.description) parts.push(`(${s.description})`);
                if (s.location) parts.push(`@${s.location}`);
                return parts.join(' ');
            });
            scheduleBlock = `\n【今日日程骨架】\n${lines.join('\n')}\n`;
        }
    } catch {}

    // ─── 7. 类型配比(按 depth 档位) ──
    const composition = (() => {
        switch (depth) {
            case 'light':
                return { defaultTotal: 6, physical: '3~4', reflection: '1~2', observation: '0~1', userThought: '0~1(仅当聊天有真实素材)', avgChars: '30~60', note: '偏日常,反思一两条点缀,不必深' };
            case 'deep':
                return { defaultTotal: 7, physical: '1~2', reflection: '3~4', observation: '2', userThought: '0', avgChars: '50~110', note: '深度反刍,反思和外界观察占主导,几乎不出现 user' };
            case 'medium':
            default:
                return { defaultTotal: 7, physical: '2~3', reflection: '2~3', observation: '1~2', userThought: '0~1(仅当聊天有真实素材)', avgChars: '40~80', note: '日常 + 反思平衡,有内核但不沉重' };
        }
    })();
    // 篇幅预算优先;没传就用 depth 默认值 ±1
    const targetTotal = fragmentBudget && fragmentBudget > 0
        ? `${Math.max(1, fragmentBudget - 1)} ~ ${fragmentBudget + 1}`
        : `${Math.max(1, composition.defaultTotal - 1)} ~ ${composition.defaultTotal + 1}`;

    // ─── 4. 组装 prompt ──────────
    const speechBlock = speechSamples.length > 0
        ? `\n【⚠️ ta 平时怎么说话 — 这是"像不像 ta"最关键的输入,严格模仿这个语气、用词、句式、节奏、口头禅、标点习惯】\n${speechSamples.map((s, i) => `[${i + 1}] ${s}`).join('\n')}\n`
        : '';

    const W = canvasPixelHint?.width ?? 360;
    const H = canvasPixelHint?.height ?? 720;
    const occupiedBlock = renderOccupiedBlock(occupied);
    const maxAllowedPage = Math.min(2, (maxPageInUse ?? 0) + 1) || 1;

    // depth=light 时,user impression 在角色 context 里仍存在,但 prompt 末尾会
    // 强调"几乎不出现 user_thought",通过类型配比抑制即可,不需要再剥 context
    const prompt = `今天是 ${date}（星期${dayOfWeek}）。${userName} 已经在 ${W}x${H}px 的瘦长手账纸上写下了 ta 今天的碎片。请你 (角色「${char.name}」) **在纸上的空白处, 也写一组自己的今日碎片**——不是日记,是 ta 散落的瞬间,各自独立又拼出 ta 的一天。**写什么 + 写在哪都你定**。

【角色完整档案】

${speechBlock}${scheduleBlock}

${occupiedBlock}

【输出 JSON 数组】每条同时含内容和位置:
[
  { "time": "上午", "type": "physical", "text": "...", "page": 1, "xPct": 60, "yPct": 14, "widthPct": 36, "role": "side" },
  { "type": "reflection", "text": "...", "page": 1, "xPct": 8, "yPct": 70, "widthPct": 84, "role": "main" },
  ...
]

【内容要求】
- 共 ${targetTotal} 条
- type 必填, 配比:
  - "physical" (具体到角色身份的物件/动作): ${composition.physical} 条
  - "reflection" (基于"自我领悟"+"记忆痕迹"延伸): ${composition.reflection} 条
  - "observation" (对路过事/世界/陌生人, **不涉及 ${userName}**): ${composition.observation} 条
  - "user_thought" (短暂想到 ${userName}): ${composition.userThought} 条
- text 必填, 正常条 ${composition.avgChars} 字。${composition.note}
- 允许 1 条**极短涂鸦句** (< 14 字, 例: "再睡一会。" / "这破代码。"), 短句会渲染成大字手写
- time 可选

【位置要求 — 关键】
- page: 1 或 2 (现在最多到第 ${maxAllowedPage} 页)
- xPct/yPct: 卡片左上角占整页 [0, 90]
- widthPct: [22, 88]
- role: "main" / "side" / "corner"(< 35 字, widthPct 28~50) / "margin"(< 14 字短句, widthPct 28~42)
- **新片必须摆在 occupied 列表给的所有 bbox 之外**, 留 ≥ 3% 间距
- 因为 ${userName} 已经占了主区, 你大概率应该走 "side" / "corner" / "margin" 见缝插针 — 在 user 的卡之间或左右两侧的留白里
- 高度估算: chars / (widthPct*0.16) * 3.4 + 6 (% of page)
- 1 页装得下就 1 页, 别强行开 page 2

【⚠️⚠️⚠️ 像不像 ta 的核心要求 —— 严格遵守】
- **必须模仿上方"ta 平时怎么说话"样本里的语气、用词、句式、节奏、口头禅、标点习惯**
- 如果 ta 平时用 "啊" "嗯" "诶" 这种语气词,你就要用;如果 ta 不用,你就不要塞进去
- 如果 ta 喜欢长句,你就写长句;ta 喜欢短句就短;ta 爱用破折号就用破折号
- 不要用 ta 说话样本里完全没出现过的"AI 文艺腔"(比如"恍惚间"、"忽然意识到"、"如同一道闪电")
- 这是这个功能的命门:user 一眼就能看出"这不是 ta",一旦不像 user 会立刻删除整组

【⚠️ 类型说明 + 反例(严禁 vs 推荐)】

1. "physical" — 必须**具体到角色身份**的物件/动作:
   ❌ "今天磨咖啡时手抖了"(任何人都可以发,跟角色无关)
   ✅ "戴 noise-canceling 耳机调那段卡住的鼓 fill,左右声道又错位 0.3 拍"(角色是音乐人,具体)

2. "reflection" — **必须从【自我领悟】或【记忆痕迹】延伸**,不是凭空文艺:
   ❌ "看到落叶想到无常"(伪深度,跟角色无关)
   ✅ 假设 selfInsight = "我习惯先撑住再喊救命":
       "又一次到了'我先撑住'阶段。能听见自己说这句话的语气和上次完全一样,但还是这么说。"

3. "observation" — 角色对外界,**绝不涉及 ${userName}**:
   ✅ "刚刷到一篇'躺平 vs 效率'的争论,两边都说被异化,可没人点'被谁异化'"
   ✅ "便利店换了新店员,扫码慢得让前面的 OL 都翻白眼。我倒不急。"

4. "user_thought" — 短暂念头,**不能成为段落主语**,**不能虚构共同事件**:
   ❌❌❌ "看到楼下野猫打架,想起 ${userName}"
   ❌❌❌ "今天给花浇了水,然后想起 ${userName}"
   原因:这种"小事 + 想起 ta"的句式信息量为零,${userName} 看了会觉得 ${char.name} 没自己的内核 —— 这是这个 app 最丢人的失败模式,严禁出现。
   ✅(基于 impression):"想起 ${userName} 上次说 ta 在 burnout 边缘 —— 我大概知道这意味着 ta 接下来会强行假装没事。"
   ✅(只在有真实聊天材料):"${userName} 早上发的那张图,是 ta 选了那家店没去成,我截屏了。"

【⚠️ 绝对铁律 —— 违反整组判废】
- **不要虚构 ${userName} 和 ${char.name} 之间发生过的事**:没见面 / 没一起做 / user 没说过的话,一律不能编。会让 ${userName} 觉得人生被夺舍。
- 严禁 AI 捧场:"希望 ${userName} 看到""如果 ${userName} 在就好了""想给 ta 惊喜"
- 用 ${char.name} 自己的口吻(第一人称最自然),不要旁白腔
- 紧贴日程骨架但**不复述**,要"造谣"成手感片段
- 允许真实的消极、无聊、拖延、独处、emo
- 不要 emoji 开头/不要标题/不要包裹符号

【可选 — 笔感修饰(让一两条更鲜活)】
text 里允许少量 markdown 语法,渲染时会变成对应的视觉效果:
- **粗** 真的想强调的词
- *斜* 引用/自语
- ==高亮== 马克笔划重点(每组最多 2 条用)
- ~~删除~~ 自嘲否定
- [color:red](文字) 彩笔颜色: red/pink/blue/sky/green/mint/yellow/purple/orange/gray
约束:**每条最多用 1 个修饰**,大部分句子纯文本就好。

直接输出 JSON 数组。`;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [{ role: 'user', content: prompt }])),
                temperature: 0.85,
                max_tokens: 12000,
            }),
            __sullyMeta: {
                appId: 'handbook',
                appName: '手账',
                charId: char.id,
                charName: char.name,
                purpose: '生活流手账生成',
            },
        } as RequestInit);
        if (!response.ok) {
            console.error('[Handbook/Lifestream] API error:', response.status, char.name);
            return { page: null, placements: [] };
        }
        const data = await safeResponseJson(response);
        let raw: string = data.choices?.[0]?.message?.content || '';
        raw = raw.trim();
        if (raw.length < 4) return { page: null, placements: [] };

        const pageId = `lifestream-${char.id}-${date}-${Date.now()}`;
        const { fragments, placements } = parseTurnOutput(raw, pageId, occupied);
        if (fragments.length === 0) return { page: null, placements: [] };

        const content = fragmentsToPlainText(fragments);
        const page: HandbookPage = {
            id: pageId,
            type: 'character_life',
            charId: char.id,
            content,
            fragments,
            paperStyle: 'plain',
            generatedBy: 'llm',
            generatedAt: Date.now(),
        };
        return { page, placements };
    } catch (e) {
        console.error('[Handbook/Lifestream] failed:', char.name, e);
        return { page: null, placements: [] };
    }
}

// ─── 工具：今天日期字符串（本地时区）─────────────────────
export function getLocalDateStr(d: Date = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ─── 探测:统计 user 今天和指定角色们一共说了多少话 ────
export async function countUserMsgsToday(
    charIds: string[],
    date: string,
): Promise<number> {
    if (charIds.length === 0) return 0;
    const { start, end } = dayRange(date);
    let total = 0;
    for (const id of charIds) {
        try {
            const all = await DB.getMessagesByCharId(id, true);
            total += all.filter(m => m.timestamp >= start && m.timestamp < end && m.role === 'user').length;
        } catch {}
    }
    return total;
}

// ─── 探测：今天哪些角色和 user 有过对话 ───────────────────
export async function findCharactersWithChatToday(
    characters: CharacterProfile[],
    date: string,
): Promise<string[]> {
    const { start, end } = dayRange(date);
    const result: string[] = [];
    for (const c of characters) {
        try {
            const all = await DB.getMessagesByCharId(c.id, true);
            const hasUserMsg = all.some(m => m.timestamp >= start && m.timestamp < end && m.role === 'user');
            if (hasUserMsg) result.push(c.id);
        } catch {}
    }
    return result;
}

// 候选可写陪伴页的角色 = 全部角色（user 自己挑）。保留旧导出名以减小改动面。
export function pickLifestreamChars(characters: CharacterProfile[]): CharacterProfile[] {
    return characters.slice();
}

// ─── 篇幅预算规划 ────────────────────────────────────────
//
// 一天 ≤ 2 页, ~14 片 fragment 总预算。
// 按 user 当天聊天活跃度,先给 user 分一份,剩下的均摊给参与陪伴的角色。
// user 多话 → user 多写、char 少陪;user 少话 → char 来撑场。
//
export interface FragmentBudgetPlan {
    /** user_diary 的 fragment 数 */
    userBudget: number;
    /** key=charId, value=该角色 lifestream 的 fragment 数 */
    perChar: Record<string, number>;
    /** 估算总片数 */
    total: number;
    /** debug 用: 计算依据 */
    rationale: string;
}

export function planFragmentBudget(
    totalUserMsgsToday: number,
    selectedDiaryCharIds: string[],
    selectedLifeChars: CharacterProfile[],
): FragmentBudgetPlan {
    const TOTAL = 14;   // 2 页 × 7 片左右

    // user 份额: 没说话就 0;1~5 句给 4 片;6~15 句给 6 片;16~30 给 7 片;>30 给 8 片
    let userBudget: number;
    if (selectedDiaryCharIds.length === 0 || totalUserMsgsToday === 0) userBudget = 0;
    else if (totalUserMsgsToday < 6)  userBudget = 4;
    else if (totalUserMsgsToday < 16) userBudget = 6;
    else if (totalUserMsgsToday < 31) userBudget = 7;
    else                              userBudget = 8;

    // 角色份额 = 剩下的均摊
    const charPool = Math.max(0, TOTAL - userBudget);
    const numChars = selectedLifeChars.length;
    const perChar: Record<string, number> = {};
    if (numChars > 0 && charPool > 0) {
        // 平均每角色 ≥ 2 (太少没意思)、≤ 5 (单人不要霸屏)
        let basePerChar = Math.max(2, Math.min(5, Math.floor(charPool / numChars)));
        // 如果 basePerChar × numChars 超 charPool 太多, 缩到 charPool / numChars 向上取整
        if (basePerChar * numChars > charPool + 2) {
            basePerChar = Math.max(2, Math.ceil(charPool / numChars));
        }
        for (const c of selectedLifeChars) perChar[c.id] = basePerChar;
    } else if (numChars > 0 && charPool === 0) {
        // user 抢光了, 角色每人就给 2 片象征性陪一笔
        for (const c of selectedLifeChars) perChar[c.id] = 2;
    }

    const total = userBudget + Object.values(perChar).reduce((a, b) => a + b, 0);
    const rationale =
        `userMsgs=${totalUserMsgsToday}, chars=${numChars}; ` +
        `userBudget=${userBudget}, perChar=${Object.values(perChar)[0] ?? 0}, total=${total}`;
    return { userBudget, perChar, total, rationale };
}

// ═══════════════════════════════════════════════════════════════════
// ─── 3. 确定性版式引擎 (composePageLayout) ───────────────────────
// ═══════════════════════════════════════════════════════════════════
//
// 取代 LLM 排版 — 改成同步、可证、可 lint 的 pure function。
//
// 输入: 当日所有 page (含 fragments) + 角色表 + user 资料 + date 种子
// 输出: HandbookLayout[] (每张纸 placements 列表, 每片有确定 xPct/yPct/widthPct/role/isHero)
//
// 核心约束 (硬编码, LLM 碰不到):
//   1. 每页恰好 1 个 hero (isHero=true) — 字号最大、视觉最显眼
//   2. 每片只能落到某个固定槽 (slot) 里, x/w 由槽决定, y 自动堆叠
//   3. rotate 限制在 ±2 (主带 0, 角落 ±1.5)
//   4. 槽的 yStart/yEnd 自然产生 ≥ 25% 留白
//   5. 单片不会与前一片 bbox 重叠 (堆叠 + gap)
//   6. 装饰预算: 见 JournalCanvas (硬编码 ≤ 1 颗)
//   7. 强调预算: lintEmphasis 在渲染层每页 ≤ 2, 由 JournalCanvas 计算
//
// 这个函数没有副作用、不调网络、不抛错 (内容空时返回 [])。

export interface LayoutGenInput {
    date: string;
    pages: HandbookPage[];
    characters: CharacterProfile[];
    userProfile: UserProfile;
}

interface FlatPiece {
    pageId: string;
    fragmentId?: string;
    author: string;
    type: HandbookPage['type'];
    text: string;
    charCount: number;
}

function flattenPiecesForLayout(
    pages: HandbookPage[],
    userName: string,
    characters: CharacterProfile[],
): FlatPiece[] {
    const out: FlatPiece[] = [];
    for (const p of pages) {
        if (p.excluded) continue;
        const author = p.charId
            ? (characters.find(c => c.id === p.charId)?.name || '某角色')
            : userName;
        if (p.fragments && p.fragments.length > 0) {
            for (const f of p.fragments) {
                out.push({
                    pageId: p.id, fragmentId: f.id, author, type: p.type,
                    text: f.text, charCount: f.text.length,
                });
            }
        } else if (p.content && p.content.trim()) {
            out.push({
                pageId: p.id, author, type: p.type,
                text: p.content, charCount: p.content.length,
            });
        }
    }
    return out;
}

// ─── 模板定义 ────────────────────────────────────────────
//
// 每个模板 = 一组固定槽位 (slot)。槽位定义了 x / w / y 范围 / 容量 /
// 接受的 role。pieces 按规则分配到槽,槽内自上而下堆,溢出走 page 2。

type TemplateKind = 'A_journal' | 'B_split' | 'C_emotional' | 'D_dialogue';

interface SlotDef {
    id: string;
    xPct: number;
    widthPct: number;
    yStart: number;          // 起始 y%
    yEnd: number;            // 截止 y%, 超出去 page 2
    accepts: LayoutRole;     // 此槽接收的 role
    capacity?: number;       // 最多堆几片 (undefined = 直到 yEnd)
}

interface TemplateDef {
    slots: SlotDef[];
}

// 设计要点:
// - 主带 widthPct 76~85, 让正文像真实日记一样横贯纸面
// - 槽的总占比 < 75%, 自带留白
// - corner / margin 永远在角落, 不挤主区
const TEMPLATES: Record<TemplateKind, TemplateDef> = {
    // A · 日志 (默认): 一个长主带 + 右下角槽 + 左上 margin
    A_journal: {
        slots: [
            { id: 'main',   xPct: 7,  widthPct: 80, yStart: 4,  yEnd: 78, accepts: 'main' },
            { id: 'side',   xPct: 7,  widthPct: 80, yStart: 4,  yEnd: 78, accepts: 'side' },
            { id: 'corner', xPct: 56, widthPct: 38, yStart: 78, yEnd: 92, accepts: 'corner', capacity: 2 },
            { id: 'margin', xPct: 7,  widthPct: 36, yStart: 78, yEnd: 92, accepts: 'margin', capacity: 2 },
        ],
    },
    // B · 双栏: 左主带 + 右辅带 + 底通栏
    B_split: {
        slots: [
            { id: 'left',   xPct: 6,  widthPct: 44, yStart: 4,  yEnd: 80, accepts: 'main' },
            { id: 'right',  xPct: 53, widthPct: 42, yStart: 4,  yEnd: 80, accepts: 'side' },
            { id: 'corner', xPct: 6,  widthPct: 88, yStart: 82, yEnd: 92, accepts: 'corner', capacity: 1 },
            { id: 'margin', xPct: 75, widthPct: 20, yStart: 4,  yEnd: 16, accepts: 'margin', capacity: 1 },
        ],
    },
    // C · 情绪页 (内容少): 中央 hero + 上下小碎片
    C_emotional: {
        slots: [
            { id: 'hero',    xPct: 8,  widthPct: 84, yStart: 28, yEnd: 60, accepts: 'main',   capacity: 1 },
            { id: 'top',     xPct: 8,  widthPct: 84, yStart: 8,  yEnd: 24, accepts: 'side',   capacity: 1 },
            { id: 'corner',  xPct: 8,  widthPct: 84, yStart: 64, yEnd: 88, accepts: 'corner', capacity: 2 },
            { id: 'margin',  xPct: 70, widthPct: 24, yStart: 4,  yEnd: 18, accepts: 'margin', capacity: 1 },
        ],
    },
    // D · 对话流 (≥3 个作者): 左右交错带, 像聊天落在纸上
    D_dialogue: {
        slots: [
            { id: 'left',    xPct: 5,  widthPct: 56, yStart: 4,  yEnd: 90, accepts: 'main' },
            { id: 'right',  xPct: 38, widthPct: 56, yStart: 14, yEnd: 90, accepts: 'side' },
            { id: 'margin',  xPct: 76, widthPct: 20, yStart: 4,  yEnd: 14, accepts: 'margin', capacity: 1 },
        ],
    },
};

// ─── 模板选择 ────────────────────────────────────────────
//
// 不让 LLM 选 — 按内容形态确定:
//   - 总字数 < 100 OR 片数 ≤ 2  → C (情绪页, hero 大字)
//   - 不同作者 ≥ 3              → D (对话流)
//   - 不同作者 = 2 AND 片数 ≥ 4  → B (双栏)
//   - 其它                       → A (默认日志)
function pickTemplate(pieces: FlatPiece[]): TemplateKind {
    const totalChars = pieces.reduce((s, p) => s + p.charCount, 0);
    const authors = new Set(pieces.map(p => p.author));

    if (pieces.length <= 2 || totalChars < 100) return 'C_emotional';
    if (authors.size >= 3) return 'D_dialogue';
    if (authors.size === 2 && pieces.length >= 4) return 'B_split';
    return 'A_journal';
}

// ─── piece → role ────────────────────────────────────────
// 字数 + 内容形态决定 role, 不让 LLM 选
function pieceRole(piece: FlatPiece): LayoutRole {
    if (piece.charCount < 18) return 'margin';
    if (piece.charCount < 35) return 'corner';
    if (piece.charCount < 60) return 'side';
    return 'main';
}

// ─── 把 pieces 分配到 template 的 slot ────────────────────
//
// 规则:
//   1. 每片先算自己的 role
//   2. 找模板里 accepts 此 role 的槽,选一个还有容量的
//   3. 找不到匹配槽 → 退化到 main 槽 (永远存在)
//   4. 同作者的 pieces 尽量临近 (放进同一个槽队列)
function assignToSlots(
    pieces: FlatPiece[],
    template: TemplateDef,
): Record<string, FlatPiece[]> {
    const slotPieces: Record<string, FlatPiece[]> = {};
    template.slots.forEach(s => slotPieces[s.id] = []);

    // 同作者尽量临近: 按 (author, originalIndex) 稳定排序
    const indexed = pieces.map((p, i) => ({ piece: p, i }));
    indexed.sort((a, b) => {
        if (a.piece.author === b.piece.author) return a.i - b.i;
        return a.piece.author.localeCompare(b.piece.author);
    });

    for (const { piece } of indexed) {
        const role = pieceRole(piece);

        // 优先匹配 role 的槽
        let slot = template.slots.find(s =>
            s.accepts === role &&
            slotPieces[s.id].length < (s.capacity ?? 99)
        );

        // 找不到 → 降级
        if (!slot) {
            // 短句溢出去 corner / main
            const fallbacks: LayoutRole[] = role === 'margin'
                ? ['corner', 'side', 'main']
                : role === 'corner'
                ? ['side', 'main']
                : role === 'side'
                ? ['main']
                : ['side', 'corner'];
            for (const fb of fallbacks) {
                slot = template.slots.find(s =>
                    s.accepts === fb &&
                    slotPieces[s.id].length < (s.capacity ?? 99)
                );
                if (slot) break;
            }
        }

        // 兜底: 第一个槽
        if (!slot) slot = template.slots[0];
        slotPieces[slot.id].push(piece);
    }

    return slotPieces;
}

// ─── 槽内堆叠 → PlacedPiece[] ─────────────────────────────
//
// 在每个槽内自上而下堆,每片高度按字数估算,gap 3%。
// 超出 slot.yEnd → 翻到 page 2 的同槽 (page 2 槽位等同 page 1)。
// 最多 2 页, 第 3 页以后丢掉 (实测 user 一天的内容 < 30 片, 2 页够用)。
function stackInSlots(
    slotPieces: Record<string, FlatPiece[]>,
    template: TemplateDef,
    seedKey: string,
): PlacedPiece[] {
    const placed: PlacedPiece[] = [];
    const GAP_Y = 3;

    for (const slot of template.slots) {
        const items = slotPieces[slot.id] || [];
        if (items.length === 0) continue;

        let pageNumber = 1;
        let y = slot.yStart;

        for (const piece of items) {
            const role = slot.accepts;
            const h = estHeightPctFromChars(
                piece.charCount, slot.widthPct, PAGE_H_DEFAULT,
                role === 'main' || role === 'side' ? 'main' : role,
            );

            // 溢出 → 翻页
            if (y + h > slot.yEnd) {
                pageNumber++;
                if (pageNumber > 2) break;
                y = slot.yStart;
            }

            const seed = piece.fragmentId ?? piece.pageId ?? seedKey;
            // rotate: main 永远 0, side ±0.6, corner ±1.5, margin ±2
            const rotateRange = role === 'main' ? 0
                : role === 'side' ? 0.6
                : role === 'corner' ? 1.5
                : 2;
            const rotate = rotateRange === 0 ? 0
                : Math.round(((seedFloat(seed, 9) - 0.5) * 2 * rotateRange) * 10) / 10;

            placed.push({
                pageId: piece.pageId,
                fragmentId: piece.fragmentId,
                xPct: slot.xPct,
                yPct: y,
                widthPct: slot.widthPct,
                rotate,
                zIndex: 10,
                role,
                pageNumber,
            });

            y += h + GAP_Y;
        }
    }

    return placed;
}

// ─── lint: hero 选定 ──────────────────────────────────────
// 每页选 1 个 hero — 优先 main 中字数最长, 没 main 就最长 side
function lintHero(layouts: HandbookLayout[], pieces: FlatPiece[]): void {
    const charById = new Map<string, number>();
    pieces.forEach(p => charById.set(p.fragmentId ?? p.pageId, p.charCount));

    for (const lay of layouts) {
        let hero: LayoutPlacement | undefined;
        let heroChars = -1;

        // 第一轮: 找最长的 main
        for (const pl of lay.placements) {
            if (pl.role !== 'main') continue;
            const c = charById.get(pl.fragmentId ?? pl.pageId) ?? 0;
            if (c > heroChars) { hero = pl; heroChars = c; }
        }

        // 第二轮兜底: 没有 main 就找最长的 side
        if (!hero) {
            for (const pl of lay.placements) {
                if (pl.role !== 'side') continue;
                const c = charById.get(pl.fragmentId ?? pl.pageId) ?? 0;
                if (c > heroChars) { hero = pl; heroChars = c; }
            }
        }

        // 还没有就拿 placements[0]
        if (!hero && lay.placements.length > 0) hero = lay.placements[0];

        // 标记 isHero, 保证一页只一个
        for (const pl of lay.placements) pl.isHero = (pl === hero);
    }
}

// ─── 主入口 ──────────────────────────────────────────────
export function composePageLayout(input: LayoutGenInput): HandbookLayout[] {
    const userName = input.userProfile.name || '我';
    const pieces = flattenPiecesForLayout(input.pages, userName, input.characters);
    if (pieces.length === 0) return [];

    const templateKind = pickTemplate(pieces);
    const template = TEMPLATES[templateKind];
    const slotPieces = assignToSlots(pieces, template);
    const placed = stackInSlots(slotPieces, template, input.date);

    // 漏片兜底: 如果某片没被分配 (capacity 不够 + 翻页溢出), 强行塞到 main 槽 page 2 末尾
    const placedKeys = new Set(placed.map(p => p.fragmentId ?? `pg:${p.pageId}`));
    const missing = pieces.filter(p => !placedKeys.has(p.fragmentId ?? `pg:${p.pageId}`));
    if (missing.length > 0) {
        const mainSlot = template.slots.find(s => s.accepts === 'main') || template.slots[0];
        let y = mainSlot.yStart;
        for (const piece of missing) {
            const h = estHeightPctFromChars(piece.charCount, mainSlot.widthPct, PAGE_H_DEFAULT, 'main');
            placed.push({
                pageId: piece.pageId,
                fragmentId: piece.fragmentId,
                xPct: mainSlot.xPct,
                yPct: Math.min(85, y),
                widthPct: mainSlot.widthPct,
                rotate: 0,
                zIndex: 10,
                role: 'main',
                pageNumber: 2,
            });
            y += h + 3;
        }
    }

    const layouts = placedPiecesToLayouts(placed);
    lintHero(layouts, pieces);
    return layouts;
}


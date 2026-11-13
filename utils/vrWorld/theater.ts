/**
 * 彼方·剧院 —— LLM 编排管线（脚本生成/润色、演员意见收集、导演整合）。
 *
 * 把所有 LLM 调用集中在这里，UI 只管交互。API 通道与彼方其它功能一致：
 * 角色无关的调用走 彼方独立 API（getVRApi）→ 回落聊天默认 apiConfig；演员意见
 * 这种"角色自己说话"的调用，走 buildChatRequestPayload（ContextBuilder + 记忆宫殿）
 * 拿到该角色完整人设上下文，跟 runSession 自由活动一致。
 */

import type {
    CharacterProfile, UserProfile, GroupProfile, APIConfig, Emoji, EmojiCategory,
    VRScript, VRCastAssign, VRActorNote, VRStageMode,
} from '../../types';
import { DB } from '../db';
import { getVRApi } from './vrApi';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { safeFetchJson } from '../safeApi';
import type { ApiCallMeta } from '../apiCallLog';
import { STAGE_BUBBLE_MAX } from './constants';
import {
    buildLLMScriptTurn, buildPolishTurn, parseScriptOutput, type ParsedScript,
    buildActorReviewTurn, parseActorReview,
    buildActorsBatchTurn, parseActorsBatch,
    buildDirectorTurn, parseDirectorOutput, type ParsedDirector,
} from './prompts';

export interface TheaterApi { baseUrl: string; apiKey: string; model: string; }

/** 解析剧院要用的 API（彼方独立 API → 聊天默认）。 */
export async function resolveTheaterApi(apiConfig: APIConfig): Promise<TheaterApi | null> {
    const vr = await getVRApi();
    const api = vr?.baseUrl ? vr : apiConfig;
    if (!api?.baseUrl) return null;
    return { baseUrl: api.baseUrl.replace(/\/+$/, ''), apiKey: api.apiKey || 'sk-none', model: api.model };
}

async function chat(
    api: TheaterApi,
    messages: Array<{ role: string; content: any }>,
    temperature = 0.9,
    meta?: Partial<ApiCallMeta>,
): Promise<string> {
    const data: any = await safeFetchJson(`${api.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey}` },
        body: JSON.stringify({ model: api.model, messages, temperature, stream: false }),
    }, 2, 0, { appId: 'vrworld', appName: '彼方', purpose: '夜间剧场', ...meta });
    const c: string = data.choices?.[0]?.message?.content || '';
    return c.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** 角色无关上下文（UI 注入一次）。 */
export interface TheaterCtx {
    characters: CharacterProfile[];
    userProfile: UserProfile;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
}

/** 导演用的精简人设：姓名 + 核心指令 + 世界观/补充设定（OOC 已在演员重写台词那步处理）。 */
const directorPersona = (ch: CharacterProfile): string => [
    `姓名：${ch.name}`,
    `核心指令：${(ch.systemPrompt || '').trim() || '（无）'}`,
    (ch.worldview || '').trim() ? `世界观 / 补充设定：${ch.worldview!.trim()}` : '',
].filter(Boolean).join('\n');

/** 较完整人设（核心性格 + 世界观，不切片）—— 给"固定两次"批量模式用，平衡长度。 */
const personaBrief = (ch: CharacterProfile): string =>
    [ch.systemPrompt, ch.worldview && `世界观：${ch.worldview}`].filter(Boolean).join('\n').trim() || '（无设定）';

/** 用户给个 brief（可带写作风格预设），让 LLM 代写一出剧本。 */
export async function generateScript(brief: string, api: TheaterApi, presetPrompt?: string): Promise<ParsedScript> {
    return parseScriptOutput(await chat(api, [{ role: 'user', content: buildLLMScriptTurn(brief, presetPrompt) }], 0.9, { purpose: '剧院生成剧本' }));
}

/** 按写作风格预设 + 额外要求润色重写一份剧本正文。 */
export async function polishScript(body: string, presetPrompt: string, extra: string, api: TheaterApi): Promise<ParsedScript> {
    return parseScriptOutput(await chat(api, [{ role: 'user', content: buildPolishTurn(body, presetPrompt, extra) }], 0.9, { purpose: '剧院润色剧本' }));
}

const castLineOf = (cast: VRCastAssign[]) => cast.map(c => `${c.actorName} 饰 ${c.roleName}`).join('；');

/** 逐角色模式：每个 char 演员各调一次 LLM（带各自 ContextBuilder + 记忆），并发。 */
async function perRoleNotes(script: VRScript, cast: VRCastAssign[], charAssigns: VRCastAssign[], ctx: TheaterCtx, api: TheaterApi): Promise<VRActorNote[]> {
    const line = castLineOf(cast);
    return Promise.all(charAssigns.map(async (a): Promise<VRActorNote> => {
        const char = ctx.characters.find(c => c.id === a.actorId);
        if (!char) return { actorId: a.actorId, actorName: a.actorName, roleName: a.roleName, note: '（演员缺席）', cooperative: true };
        try {
            const contextLimit = char.contextLimit || 200;
            const historyMsgs = await DB.getRecentMessagesByCharId(char.id, contextLimit);
            const mates = cast.map(c => c.actorName).filter(n => n !== char.name);
            // 名字权重加重：重复同台演员名 + 显式问关系/印象，便于召回角色之间的过往
            const recallQueryHint = mates.length > 0
                ? `彼方剧院和这些人同台演戏：${mates.join('、')}。\n${mates.join(' ')} ${mates.join(' ')}\n我对${mates.join('、')}的印象、我和 ta 们的关系与过往。`
                : `彼方剧院排戏《${script.title}》。`;
            const payload = await buildChatRequestPayload({
                char, userProfile: ctx.userProfile, groups: ctx.groups, emojis: ctx.emojis, categories: ctx.categories,
                historyMsgs, contextLimit, recallQueryHint,
            });
            const userTurn = buildActorReviewTurn(script.title, script.logline, script.body, a.roleName, line, char.name);
            const out = await chat(
                api,
                [{ role: 'system', content: payload.systemPrompt }, ...payload.cleanedApiMessages, { role: 'user', content: userTurn }],
                0.9,
                { charId: char.id, charName: char.name, purpose: '剧院演员审本' },
            );
            const p = parseActorReview(out);
            return { actorId: char.id, actorName: char.name, roleName: a.roleName, note: p.note, lines: p.lines, taboo: p.taboo, direction: p.direction, attitude: p.attitude, cooperative: p.cooperative };
        } catch {
            return { actorId: char.id, actorName: char.name, roleName: a.roleName, note: '（没能读完剧本，先就位了）', attitude: '配合', cooperative: true };
        }
    }));
}

/** 两次调用模式：一次让 LLM 同时扮演所有 char 演员给意见（省，可能 OOC）。 */
async function batchNotes(script: VRScript, charAssigns: VRCastAssign[], ctx: TheaterCtx, api: TheaterApi): Promise<VRActorNote[]> {
    const castForBatch = charAssigns.map(a => {
        const ch = ctx.characters.find(c => c.id === a.actorId);
        return { roleName: a.roleName, actorName: a.actorName, persona: ch ? personaBrief(ch) : '' };
    });
    const sys = '你是一个多角色扮演引擎。下面会给你若干演员各自的人设，请分别站在他们各自的立场和性格回应，保持每人独立、别串味，态度也别整齐划一。';
    let parsed: Record<string, ReturnType<typeof parseActorReview>> = {};
    try {
        const out = await chat(api, [
            { role: 'system', content: sys },
            { role: 'user', content: buildActorsBatchTurn(script.title, script.logline, script.body, castForBatch) },
        ], 0.9, { purpose: '剧院批量审本' });
        parsed = parseActorsBatch(out);
    } catch { /* 失败则全体默认就位 */ }
    return charAssigns.map(a => {
        const p = parsed[a.actorName] || { note: '（没给具体意见，听导演的）', cooperative: true, lines: undefined, taboo: undefined, direction: undefined, attitude: '配合' };
        return { actorId: a.actorId, actorName: a.actorName, roleName: a.roleName, note: p.note, lines: p.lines, taboo: p.taboo, direction: p.direction, attitude: p.attitude, cooperative: p.cooperative };
    });
}

/**
 * 收集所有演员对剧本的意见。NPC 不调 LLM（直接就位），只有 char 演员吃调用。
 * per-role：char 数次并发调用（精准）；two-call：1 次批量（省）。
 */
export async function collectActorNotes(script: VRScript, cast: VRCastAssign[], mode: VRStageMode, ctx: TheaterCtx, api: TheaterApi): Promise<VRActorNote[]> {
    const charAssigns = cast.filter(c => !c.isNpc);
    const npcNotes: VRActorNote[] = cast.filter(c => c.isNpc).map(c => ({
        actorId: c.actorId, actorName: c.actorName, roleName: c.roleName, note: '（NPC 演员就位，听导演调度）', attitude: '配合', cooperative: true,
    }));
    const charNotes = charAssigns.length === 0 ? []
        : mode === 'two-call' ? await batchNotes(script, charAssigns, ctx, api)
        : await perRoleNotes(script, cast, charAssigns, ctx, api);
    // 按 cast 顺序归位
    const byRole = new Map([...charNotes, ...npcNotes].map(n => [n.roleName + ' ' + n.actorId, n]));
    return cast.map(c => byRole.get(c.roleName + ' ' + c.actorId)!).filter(Boolean);
}

/** char 演员人数（= 这次编排会吃的 LLM 调用基数，导演再 +1）。 */
export function charActorCount(cast: VRCastAssign[]): number {
    return cast.filter(c => !c.isNpc).length;
}

/** 导演整合：原剧本 + 角色本色 + 演员自重写台词 + 用户硬性要求 → 最终演出脚本 + 锐评 + 评级。 */
export async function runDirector(script: VRScript, cast: VRCastAssign[], notes: VRActorNote[], ctx: TheaterCtx, api: TheaterApi, userRequirement?: string): Promise<ParsedDirector> {
    // 给导演注入每位演员的本色，避免导演反手把角色写 OOC
    const personas = cast.map(c => {
        if (c.isNpc) return { actorName: c.actorName, roleName: c.roleName, persona: '即兴客串的 NPC，无固定人设，可自由塑造' };
        const ch = ctx.characters.find(x => x.id === c.actorId);
        return { actorName: c.actorName, roleName: c.roleName, persona: ch ? directorPersona(ch) : '（未知）' };
    });
    const out = await chat(api, [{
        role: 'user',
        content: buildDirectorTurn(
            script.title, script.logline, script.body,
            cast.map(c => ({ roleName: c.roleName, actorName: c.actorName })),
            personas, notes, STAGE_BUBBLE_MAX, userRequirement,
        ),
    }], 0.85, { purpose: '剧院导演整合' });
    return parseDirectorOutput(out);
}

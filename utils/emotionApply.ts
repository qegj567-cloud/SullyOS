import { DB } from './db';
import {parseHomeEmotion} from './homeEmotion';
import type { CharacterProfile, CharacterBuff } from '../types';
import { CHAT_GEN_EVENTS } from './chatGenEvents';
import {landHomeSecrets} from './homeSecrets';
import type {SecretNoteOrigin} from './secretNote';
import {homeSecretEvalRequestId} from './emotionEvalCore';
import {landFriendFeedEmotionAction} from './friendFeedEmotion';

// 情绪评估失败的用户可见信号（OSContext 监听弹 toast）。本函数是本地 / instant(worker)
// 两条路径的共用落点，在这里派发能覆盖「worker 推回的 raw 解析全灭」这类云端失败。
const announceEmotionFailed = (charData: CharacterProfile, reason: string): void => {
    try {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(CHAT_GEN_EVENTS.emotionFailed, {
                detail: { charId: charData.id, charName: charData.name, reason },
            }));
        }
    } catch { /* SSR / 测试环境无 window */ }
};

// 角色「最后一次内心独白(InnerState)」的轻量缓存（localStorage）。
// innerState 是瞬时产物，这里在情绪评估落地的共用点顺手缓存一份，供别处（如查手机首页）读取，
// 不额外动 CharacterProfile / DB schema。
export {getLastInnerState, lastInnerStateKey} from './emotionState';
import {lastInnerStateKey} from './emotionState';

// 情绪评估结果「解析 + 落 buff」的共用实现.
//
// 原本内联在 hooks/useChatAI.ts 的 evaluateEmotionBackground 里. 提取出来是为了让两条路径共用:
//   1. 本地模式: 客户端跑 eval LLM 拿到 raw, 调本函数落地.
//   2. instant 模式: worker 跑 eval LLM, 把 raw 作为 emotion_update push 推回, 客户端 flush 时调本函数落地.
//
// 入参 rawText = LLM 返回的原始文本 (可能含 ```json 包裹). 返回 innerState (意识流) 字符串或 null,
// 调用方负责把它喂回下一轮 prompt (evolvedNarrative). buff 的应用 (写 DB + 广播 emotion-updated)
// 在本函数内完成.

const sanitizeBuffs = (buffs?: CharacterBuff[]): CharacterBuff[] => {
    if (!Array.isArray(buffs)) return [];
    return buffs
        .map((buff, index) => {
            let label = typeof buff?.label === 'string' ? buff.label.trim() : '';
            let name = typeof buff?.name === 'string' ? buff.name.trim() : '';
            // 模型偶尔漏 name (内部英文 id) 或漏 label (中文标签) — 缺一半不该整条丢弃,
            // 用另一半兜底: name 缺就从 id/序号派生, label 缺就用 name 顶上.
            if (!label && !name) return null;
            if (!name) name = (typeof buff?.id === 'string' && buff.id.trim()) ? buff.id.trim() : `emotion_${index}`;
            if (!label) label = name;

            const rawIntensity = Number((buff as any)?.intensity);
            const intensity: 1 | 2 | 3 = !Number.isFinite(rawIntensity)
                ? 2
                : rawIntensity <= 1
                    ? 1
                    : rawIntensity >= 3
                        ? 3
                        : 2;

            const out: CharacterBuff = {
                id: typeof buff?.id === 'string' && buff.id.trim() ? buff.id.trim() : `buff_${Date.now()}_${index}`,
                name,
                label,
                intensity,
            };
            if (typeof buff?.emoji === 'string') out.emoji = buff.emoji;
            if (typeof buff?.color === 'string') out.color = buff.color;
            if (typeof buff?.description === 'string') out.description = buff.description;
            const behavior=parseHomeEmotion(buff.homeBehavior);
            if(behavior){out.homeBehavior=behavior;out.homeBehaviorAt=Date.now();}
            return out;
        })
        .filter((buff): buff is CharacterBuff => !!buff);
};

// ─── JSON 修复链 (全部 string-aware 逐字符扫描, 不用正则盲扫以免误伤字符串内容) ───

// 修复 1: 把 JSON 字符串值里的裸换行/制表符转义, 兼容 LLM 偶尔吐未转义控制字符的情况.
const repairControlChars = (s: string): string => {
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { inStr = !inStr; out += ch; continue; }
        if (inStr && ch === '\n') { out += '\\n'; continue; }
        if (inStr && ch === '\r') { out += '\\r'; continue; }
        if (inStr && ch === '\t') { out += '\\t'; continue; }
        out += ch;
    }
    return out;
};

// 修复 2: 转义字符串值内部的裸英文双引号 (模型写中文引语时常直接用 " 不转义).
// 判定规则: 处于字符串内时遇到 ", 向后看第一个非空白字符 — 是 , : } ] 或到结尾才算真正的
// 闭合引号, 否则视为内容里的裸引号, 转成 \". 启发式并不完美, 但只在直接 parse 失败后才启用.
const repairInnerQuotes = (s: string): string => {
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') {
            if (!inStr) { inStr = true; out += ch; continue; }
            let j = i + 1;
            while (j < s.length && /\s/.test(s[j])) j++;
            const next = j < s.length ? s[j] : '';
            if (next === '' || next === ',' || next === ':' || next === '}' || next === ']') {
                inStr = false; out += ch;
            } else {
                out += '\\"';
            }
            continue;
        }
        out += ch;
    }
    return out;
};

// 修复 3: 去掉 } / ] 前的尾逗号.
const stripTrailingCommas = (s: string): string => {
    let inStr = false, esc = false, out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            out += ch;
            continue;
        }
        if (ch === '"') { inStr = true; out += ch; continue; }
        if (ch === ',') {
            let j = i + 1;
            while (j < s.length && /\s/.test(s[j])) j++;
            if (s[j] === '}' || s[j] === ']') continue; // 丢弃尾逗号
        }
        out += ch;
    }
    return out;
};

// 修复 4: 补全被截断的 JSON (max_tokens 截断 / 响应中断).
// 扫描记录括号栈, 结尾时: 关掉未闭合字符串 → 去掉悬空的 , / 给悬空的 : 补 null → 逆序补闭合括号.
const closeTruncatedJson = (s: string): string => {
    let inStr = false, esc = false;
    const stack: string[] = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') {
            if (stack[stack.length - 1] === ch) stack.pop();
        }
    }
    let out = s;
    if (esc) out = out.slice(0, -1); // 截断在反斜杠上, 丢掉半个转义序列
    if (inStr) out += '"';
    out = out.replace(/[\s]+$/, '');
    if (out.endsWith(',')) out = out.slice(0, -1);
    if (out.endsWith(':')) out += ' null';
    while (stack.length) out += stack.pop();
    return out;
};

// 从原文里定位第一个 { 并按括号平衡截取完整对象 (容忍前后夹杂闲聊文字, 后缀里有 } 也不误吞).
const extractBalancedObject = (raw: string): string | undefined => {
    const start = raw.indexOf('{');
    if (start < 0) return undefined;
    let inStr = false, esc = false, depth = 0;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return raw.slice(start, i + 1);
        }
    }
    return undefined;
};

export interface EmotionEvalResult {
    friendFeedAction?: unknown;
    homeSecrets?: unknown;
    homeSecretRequestId?: string;
    changed: boolean;
    buffs?: CharacterBuff[];
    injection?: string;
    innerState?: string;
    /** true = 整体 JSON.parse 全失败, 靠字段级正则抢救出来的部分结果 */
    salvaged?: boolean;
}

const looksLikeEvalResult = (v: any): boolean =>
    !!v && typeof v === 'object' && !Array.isArray(v)
    && ('changed' in v || 'buffs' in v || 'injection' in v || 'innerState' in v || 'homeSecrets' in v || 'friendFeedAction' in v);

const tryParseObject = (s: string): any | null => {
    try {
        const v = JSON.parse(s);
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
    } catch { return null; }
};

// Recover the complete secrets array independently when another JSON field is malformed.
const salvageSecrets = (raw: string): unknown[] | undefined => {
    const match = /"homeSecrets"\s*:\s*\[/.exec(raw);
    if (!match) return;
    const start = raw.indexOf('[', match.index);
    let inString = false, escaped = false, depth = 0;
    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (escaped) {escaped = false; continue;}
        if (inString) {if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue;}
        if (ch === '"') inString = true;
        else if (ch === '[') depth++;
        else if (ch === ']' && --depth === 0) {
            try {return JSON.parse(stripTrailingCommas(raw.slice(start, i + 1)));} catch {return;}
        }
    }
};

// 字段级抢救: 整体 parse 全灭时, 用带转义感知的正则把 innerState / injection / changed / buffs
// 单独抠出来 — 宁可拿到部分结果, 也不要整轮情绪评估静默蒸发.
const salvageFields = (repairedRaw: string): EmotionEvalResult | null => {
    const pickString = (key: string): string | undefined => {
        const m = repairedRaw.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`));
        if (!m || !m[1]) return undefined;
        let v: string;
        try { v = JSON.parse(`"${m[1]}"`); }
        catch {
            v = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        v = v.trim();
        return v || undefined;
    };

    let buffs: CharacterBuff[] | undefined;
    const buffsIdx = repairedRaw.search(/"buffs"\s*:\s*\[/);
    if (buffsIdx >= 0) {
        const arrStart = repairedRaw.indexOf('[', buffsIdx);
        let inStr = false, esc = false, depth = 0;
        for (let i = arrStart; i < repairedRaw.length; i++) {
            const ch = repairedRaw[i];
            if (esc) { esc = false; continue; }
            if (inStr) {
                if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === '[') depth++;
            else if (ch === ']') {
                depth--;
                if (depth === 0) {
                    try {
                        const arr = JSON.parse(stripTrailingCommas(repairedRaw.slice(arrStart, i + 1)));
                        if (Array.isArray(arr)) buffs = arr;
                    } catch { /* 数组本身也烂, 放弃 buffs */ }
                    break;
                }
            }
        }
    }

    const injection = pickString('injection');
    const innerState = pickString('innerState');
    const homeSecrets = salvageSecrets(repairedRaw);
    const homeSecretRequestId = pickString('homeSecretRequestId');
    const changedMatch = repairedRaw.match(/"changed"\s*:\s*"?(true|false)"?/i);

    if (!injection && !innerState && !buffs && !homeSecrets) return null;
    const changed = changedMatch
        ? changedMatch[1].toLowerCase() === 'true'
        : !!(injection || buffs); // 抢救出了 injection/buffs 就当有变化, 只有 innerState 则不动 buff
    return { changed, buffs, injection, innerState, homeSecrets, homeSecretRequestId, salvaged: true };
};

/**
 * 纯解析层 (无副作用, 导出供测试): 从 LLM 原始输出里尽量抠出情绪评估结果.
 *
 * 候选片段 (依次尝试): ```json 围栏 → 裸 ``` 围栏 → 未闭合围栏 → 括号平衡对象 →
 * 贪婪首 { 尾 } → 首 { 到文末 (截断). 每个候选跑修复链: 原样 → 转义裸控制字符 →
 * 转义字符串内裸引号 → 去尾逗号 → 补全截断. 全灭后走字段级正则抢救. 实在没有 → null.
 */
export function parseEmotionEvalOutput(rawText: string): EmotionEvalResult | null {
    const raw = (rawText || '').trim();
    if (!raw) return null;

    const candidates: string[] = [];
    const pushCand = (s?: string) => {
        const t = (s || '').trim();
        if (t && t.includes('{') && !candidates.includes(t)) candidates.push(t);
    };
    const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fenceRe.exec(raw)) !== null) pushCand(fm[1]);
    const openFence = raw.match(/```(?:json)?\s*([\s\S]*)$/i);
    if (openFence) pushCand(openFence[1]); // 围栏没闭合 (输出被截断)
    pushCand(extractBalancedObject(raw));
    // 「首 { 到文末」要排在贪婪匹配之前: 截断场景下贪婪会停在 buffs 里最后一个 } 上,
    // 补全后只剩 changed+buffs, 把后面的 injection/innerState 全丢了; 而这个候选对
    // 完整 JSON + 尾巴闲聊的输入必然 parse 失败 (尾部有非 JSON 文本), 不会误伤.
    const firstBrace = raw.indexOf('{');
    if (firstBrace >= 0) pushCand(raw.slice(firstBrace));
    const greedy = raw.match(/\{[\s\S]*\}/);
    if (greedy) pushCand(greedy[0]);

    let repairedForSalvage = '';
    for (const cand of candidates) {
        const c1 = repairControlChars(cand);
        const c2 = repairInnerQuotes(c1);
        const c3 = stripTrailingCommas(c2);
        const c4 = closeTruncatedJson(c3);
        if (!repairedForSalvage) repairedForSalvage = c3;
        for (const attempt of [cand, c1, c2, c3, c4]) {
            const v = tryParseObject(attempt);
            if (v && looksLikeEvalResult(v)) {
                // 模型偶尔把布尔写成字符串 "true"/"false"
                const changed = v.changed === true || (typeof v.changed === 'string' && v.changed.toLowerCase() === 'true');
                return {
                    changed,
                    // Never publish a comment fabricated by closing a truncated string/object.
                    friendFeedAction: attempt === c4 && c4 !== c3 ? undefined : v.friendFeedAction,
                    // Closing a truncated JSON string is acceptable for partial emotion text,
                    // but must not turn half a secret/memory into an established experience.
                    homeSecrets: attempt === c4 && c4 !== c3 ? salvageSecrets(c3) : v.homeSecrets,
                    homeSecretRequestId: typeof v.homeSecretRequestId === 'string' ? v.homeSecretRequestId : undefined,
                    buffs: Array.isArray(v.buffs) ? v.buffs : undefined,
                    injection: typeof v.injection === 'string' ? v.injection : undefined,
                    innerState: typeof v.innerState === 'string' ? v.innerState : undefined,
                };
            }
        }
    }

    return salvageFields(repairedForSalvage || repairInnerQuotes(repairControlChars(raw)));
}

/**
 * 从 chat-completion 响应的 message 对象里尽量抠出文本.
 * content 可能是字符串, 也可能是分块数组 (部分 Claude 兼容代理); content 为空时回退
 * reasoning_content (个别代理开思考后把全部输出塞进 reasoning, content 留空 —— 后续
 * parseEmotionEvalOutput 会从里面正则定位 JSON, 喂进去无害).
 */
export function extractAssistantText(message: any): string {
    if (!message) return '';
    const c = message.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) {
        const joined = c
            .map((p: any) => (typeof p === 'string' ? p : (p?.text || '')))
            .filter(Boolean)
            .join('\n');
        if (joined.trim()) return joined;
    }
    const r = message.reasoning_content;
    if (typeof r === 'string' && r.trim()) return r;
    return '';
}

/**
 * 解析情绪评估 raw 文本并落地 buff. 返回 innerState (意识流) 或 null.
 * - 解析失败 → 返回 null, 不动 buff.
 * - changed=false → 不动 buff, 返回 innerState (若有).
 * - changed=true → sanitize buffs → DB.saveCharacter → 广播 'emotion-updated' → 返回 innerState.
 * - changed=true 但 buffs / injection 双缺失 (格式烂到只抢救出 innerState) → 不清空已有
 *   buff 状态, 只返回 innerState —— 解析半残不该把角色现有情绪底色抹掉.
 */
export async function applyEmotionEvalRaw(
    rawText: string,
    charData: CharacterProfile,
    secretRequestId?: string,
    secretOrigin?: SecretNoteOrigin,
): Promise<string | null> {
    try {
        const result = parseEmotionEvalOutput(rawText || '');
        if (!result) {
            const requestId = secretRequestId || homeSecretEvalRequestId(rawText);
            if (requestId) {
                try {await landHomeSecrets(charData.id, {}, requestId, rawText);} catch { /* Failure is announced below. */ }
            }
            console.warn('🎭 [Emotion] Could not parse eval output (all repairs + salvage failed):', (rawText || '').slice(0, 300));
            announceEmotionFailed(charData, '评估模型的输出不是可解析的 JSON（模型掉格式，可换个评估模型试试）');
            return null;
        }
        if (result.salvaged) {
            console.warn('🎭 [Emotion] Full JSON parse failed, salvaged fields:', {
                buffs: result.buffs?.length ?? 0,
                injection: !!result.injection,
                innerState: !!result.innerState,
            });
        }

        const innerStateOut = (typeof result.innerState === 'string' && result.innerState.trim())
            ? result.innerState.trim()
            : null;

        if (innerStateOut) {
            try { localStorage.setItem(lastInnerStateKey(charData.id), innerStateOut); } catch { /* ignore */ }
            if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('emotion-innerstate-updated', {detail: {charId: charData.id, innerState: innerStateOut}}));
        }

        // Secrets are independent of changed/buffs; persist before the unchanged-emotion early return.
        try {
            await landFriendFeedEmotionAction(charData.id, result.friendFeedAction, 'emotion');
        } catch (error) {
            announceEmotionFailed(charData, error instanceof Error ? error.message : '好友圈评论保存失败');
        }
        try {
            await landHomeSecrets(charData.id, result, secretRequestId || homeSecretEvalRequestId(rawText), rawText, secretOrigin);
        } catch (error) {
            announceEmotionFailed(charData, error instanceof Error ? error.message : '秘密保存失败');
        }

        if (!result.changed) {
            console.log('🎭 [Emotion] No change detected, skipping buff update');
            if (innerStateOut) console.log(`🌊 [InnerState] ${charData.name}: ${innerStateOut}`);
            return innerStateOut;
        }

        const hasBuffArray = Array.isArray(result.buffs);
        const hasInjection = typeof result.injection === 'string' && !!result.injection.trim();
        if (!hasBuffArray && !hasInjection) {
            // changed=true 但两个载荷都没拿到 — 保留现状比清空安全
            console.warn('🎭 [Emotion] changed=true but no buffs/injection parsed, keeping existing state');
            if (innerStateOut) console.log(`🌊 [InnerState] ${charData.name}: ${innerStateOut}`);
            return innerStateOut;
        }

        // buffs 数组在场 → 完整更新 (数组为空 = 模型主动清空, 尊重).
        // buffs 缺失但 injection 在场 (抢救场景) → 保留旧 buffs, 只换 injection.
        const sanitizedBuffs = hasBuffArray ? sanitizeBuffs(result.buffs) : (charData.activeBuffs || []);
        const buffInjection = hasInjection ? result.injection! : (hasBuffArray ? '' : (charData.buffInjection || ''));
        await DB.saveCharacterEmotion(charData.id, sanitizedBuffs, buffInjection);

        // detail 直接带上 buffs + buffInjection: 监听方 (Chat) 可直接落 OSContext, 不必重读 DB
        // —— 避开 saveCharacter 未等事务提交 / instant flush 下 DB 重读偶发拿旧值的竞态.
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('emotion-updated', {
                detail: { charId: charData.id, buffs: sanitizedBuffs, buffInjection },
            }));
        }
        console.log('🎭 [Emotion] Updated buffs:', sanitizedBuffs.map((b) => b.label).join(', ') || 'none');
        if (innerStateOut) console.log(`🌊 [InnerState] ${charData.name}: ${innerStateOut}`);
        return innerStateOut;
    } catch (e: any) {
        console.warn('🎭 [Emotion] applyEmotionEvalRaw failed:', e?.message);
        announceEmotionFailed(charData, `评估结果落库失败：${e?.message || '未知错误'}`);
        return null;
    }
}

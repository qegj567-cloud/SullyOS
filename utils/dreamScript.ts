// 梦境剧本的请求参数、本机直连与校验。本机生成和云端代跑（utils/cloudGen/landers/dream.ts）
// 共用同一份参数和同一个 validateDreamResponse：云端拼回的响应形状与本机 safeResponseJson
// 拿到的一致，两条路校验结果只能一样。导演 prompt 由 DreamTheater 拼好再交进来。
import type { CharacterProfile, DreamScript } from '../types';
import type { ApiCallMeta } from './apiCallLog';
import { extractContent, safeResponseJson } from './safeApi';

export interface DreamApiConfig { apiKey: string; baseUrl: string; model: string; }

// 梦境鼓励高幻觉 → 温度拉到安全上限。注意 temperature 封顶 1.0：Anthropic/Claude
// 中转的合法区间是 0~1，>1 会直接报错（OpenAI 虽允许到 2，但 1.0 已足够发散）。
// max_tokens 用 8192：梦是一堆短碎片，足够用；16000 在 claude-3.5 等输出上限 8192 的
// 模型上会 400。仍有「finish_reason==='length' → 截断」兜底。
export const DREAM_REQUEST_PARAMS = { temperature: 1.0, max_tokens: 8192 };

export const dreamApiMeta = (char: Pick<CharacterProfile, 'id' | 'name'>): ApiCallMeta =>
    ({ appId: 'dreamtheater', appName: '潜意识剧场', charId: char.id, charName: char.name, purpose: '梦境剧本生成' });

export function parseDream(raw: string): DreamScript | null {
    if (!raw) return null;
    let s = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    s = s.slice(first, last + 1);
    const repair = (str: string) => {
        let inStr = false, esc = false, out = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
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
    try { return JSON.parse(s); } catch { }
    try { return JSON.parse(repair(s)); } catch (e) { console.warn('dream parse failed', e); return null; }
}

/**
 * 模型响应 → 可播放的梦。不合格就抛错，错误文案直接是给人看的原因。
 * 正文用 extractContent 取：数组形态的 content、开头的 <think> 块都不会把解析带歪。
 */
export function validateDreamResponse(data: any): DreamScript {
    if (data?.choices?.[0]?.finish_reason === 'length') throw new Error('梦境生成被截断');
    const parsed = parseDream(extractContent(data));
    if (!parsed || !parsed.archetype) throw new Error('梦境解析失败');
    // 深眠（隐藏）允许无碎片——沉默即演出；其它梦必须有碎片
    if (parsed.archetype !== 'deepsleep' && !(parsed.fragments?.length)) throw new Error('梦境为空');
    if (!parsed.fragments) parsed.fragments = [];
    return parsed;
}

/** 本机直连生成：messages 与交云端的是同一份。 */
export async function fetchDreamScript(
    apiConfig: DreamApiConfig,
    char: Pick<CharacterProfile, 'id' | 'name'>,
    messages: Array<{ role: string; content: unknown }>,
): Promise<DreamScript> {
    const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({ model: apiConfig.model, messages, ...DREAM_REQUEST_PARAMS }),
        __sullyMeta: dreamApiMeta(char),
    } as RequestInit);
    if (!res.ok) throw new Error('API');
    return validateDreamResponse(await safeResponseJson(res));
}

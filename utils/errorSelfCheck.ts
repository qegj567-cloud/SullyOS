import type { ApiPreset, CharacterProfile, DialogueApiConfig, SystemLog } from '../types';
import type { ApiCallMeta } from './apiCallLog';

export interface ErrorAdvice { title: string; action: string }
type Endpoint = Pick<DialogueApiConfig, 'baseUrl' | 'model'> & { apiKey?: string };
type Candidate = { name: string; config: Endpoint; preset?: boolean };
export interface ErrorRoutes {
    apiConfig: Endpoint;
    apiPresets: ApiPreset[];
    characters: Pick<CharacterProfile, 'id' | 'name' | 'dialogueApi' | 'emotionConfig'>[];
    memoryPalaceConfig: { lightLLM: Endpoint; embedding: Endpoint; rerank: Endpoint };
}
function url(value?: string) {
    if (!value) return;
    try { const u = new URL(value.includes('://') ? value : 'https://' + value); if (/^https?:$/.test(u.protocol)) return u; } catch {}
}
const generic = /^(api\d*|www\d*|gateway|proxy|chat|openai|relay|v\d+|com|cn|net|org|co|io|dev|ai|localhost)$/;
function distinctive(host: string) {
    return host.split('.').slice(0,-1).filter(label => label.length >= 3 && !generic.test(label) && !/^\d+$/.test(label));
}
// A different suffix is only a hint. A shared generic "api." cannot identify a provider.
export function matchErrorRoute(destinations: string[], candidates: Candidate[], model?: string, credential?: string) {
    let tentative: { name: string; host: string; possible: boolean } | undefined;
    for (const address of destinations) {
        const target = url(address);
        if (!target) continue;
        const ranked = candidates.flatMap(candidate => {
            const base = url(candidate.config.baseUrl);
            if (!base) return [];
            const path = base.pathname.replace(/\/$/, '');
            const prefix = target.pathname === path || target.pathname.startsWith(path + '/');
            const exact = base.host === target.host;
            const possible = distinctive(target.hostname).some(label => distinctive(base.hostname).includes(label));
            if (!exact && !possible) return [];
            const score = (exact ? 1000 : 0) + (prefix ? Math.min(path.length, 100) + 1 : 0) + (model && model === candidate.config.model ? 200 : 0) + (credential && credential === candidate.config.apiKey ? 400 : 0);
            return [{ candidate, score, exact, host:base.host }];
        });
        if (!ranked.length) continue;
        if (!ranked.some(row => row.exact) && new Set(ranked.map(row => row.host)).size > 1) continue;
        const top = ranked.filter(row => row.score === Math.max(...ranked.map(r => r.score)));
        const presets = top.filter(row => row.candidate.preset);
        const names = [...new Set((presets.length ? presets : top).map(row => row.candidate.name))];
        if (names.length === 1 && new Set(top.map(row => row.host)).size === 1) {
            const match = { name:names[0], host:top[0].host, possible:!top[0].exact };
            if (!match.possible) return match;
            tentative ??= match;
        }
        if (top[0].exact) return { name:'你的 API', host:target.host, possible:false };
    }
    return tentative;
}
function advice(title: string, action: string): ErrorAdvice { return {title, action}; }
const builtIn = (feature: string) => advice('这次没取到' + feature, '可以先在实时感知里关闭' + feature + '。超过 12 小时仍有问题，请反馈给糯米机作者。');

export function textErrorAdvice(message: string, detail = ''): ErrorAdvice | undefined {
    const text = message + '\n' + detail;
    if (/backing store|indexeddb\.open/i.test(text)) return advice('浏览器暂时打不开本地数据', '请先保留浏览器数据，重启设备后再打开糯米机。');
    if (/Failed to fetch weather:/i.test(message)) {
        if (/OpenWeatherMap[^\n]*?HTTP 401/.test(text)) return advice('这次没取到天气', '请检查天气设置里的 OpenWeatherMap Key。');
        if (/找不到城市|请先填写城市/.test(text)) return advice('这次没找到天气城市', '请检查天气设置里的城市名称。');
        return builtIn('天气');
    }
    if (message.includes('[hot_news] 所有新闻源均未返回内容')) return builtIn('新闻');
    if (/API返回了HTML而非JSON|API返回了无效JSON|API流式响应未返回有效数据/.test(text)) return advice('API 没有返回可用的回复', '请重试一次，持续出现请联系这套 API 的服务商。');
    if (/\[记忆宫殿·硅基流动\]/.test(message)) return siliconAdvice(Number(text.match(/Embedding API error (\d+)/)?.[1]), text);
    const feature = /记忆提取/.test(text) ? '记忆提取' : /性格检测/.test(text) ? '性格检测' : '这次生成';
    if (/finish_reason\s*[=:"'\s]+length\b|输出被截断|API 截断了本轮回复|回复被截断/.test(text)) return advice(feature + '没完成，模型回复被截断了', '请重新生成一次。');
    if (/(模型|LLM|记忆提取|性格检测|模型回复|模型输出)[^\n]{0,40}(未返回有效\s*JSON|格式不正确|没有按.*格式|找不到.*JSON|格式错误)/i.test(text)) return advice(feature + '没完成，模型回复的格式不对', '请重新生成一次，反复出现可以换个模型。');
}

export function requestErrorAdvice(routes: ErrorRoutes, request: string, returned: string, status: number, body = '', model?: string, meta?: ApiCallMeta, headers?: HeadersInit): ErrorAdvice | undefined {
    const target = url(request);
    if (!target) return;
    const palace = routes.memoryPalaceConfig;
    if (/^(?:api|ai)\.siliconflow\.(cn|com)$/.test(target.hostname) && /\/(embeddings|rerank)\/?$/.test(target.pathname)
        && [palace.embedding, palace.rerank].some(c => url(c.baseUrl)?.hostname.replace(/^ai\./,'api.') === target.hostname.replace(/^ai\./,'api.'))) {
        return siliconAdvice(status, body);
    }
    const candidates: Candidate[] = [{name:'主 API',config:routes.apiConfig},{name:'记忆宫殿副 API',config:palace.lightLLM}];
    for (const char of routes.characters) {
        if (meta?.charId && char.id !== meta.charId) continue;
        if (char.dialogueApi) candidates.push({name:char.name+'的对话 API',config:char.dialogueApi});
        if (char.emotionConfig?.api) candidates.push({name:char.name+'的情绪副 API',config:char.emotionConfig.api});
    }
    for (const preset of routes.apiPresets) candidates.push({name:'API「'+preset.name+'」',config:preset.config,preset:true});
    const sentHeaders = new Headers(headers);
    const credential = sentHeaders.get('x-api-key') || sentHeaders.get('Authorization')?.replace(/^Bearer\s+/i, '');
    const route = matchErrorRoute([request, returned].filter(Boolean), candidates, model, credential);
    if (!route) return;
    const name = route.possible ? '可能是'+route.name : route.name;
    const label = name.includes('「') ? name : name+'（'+route.host+'）';
    const action = status===401 ? '请检查这套 API 的 Key。' : status===402 || /insufficient_quota|insufficient.balance|余额不足/i.test(body) ? '请检查这套 API 的余额或额度。' : status===429 ? '请求太频繁或额度受限，请稍后重试。' : status===0 ? '请检查网络后重试，仍连不上请联系这套 API 的服务商。' : '请重试一次，持续出现请联系这套 API 的服务商。';
    return advice((meta?.purpose ? meta.purpose+'：' : '')+label+' 请求失败',action);
}
export function siliconAdvice(status: number, body: string) {
    const action = status===402 || /余额不足|insufficient.balance/i.test(body) ? '请检查硅基流动账号的余额。'
        : status===401 ? '请检查记忆宫殿里填写的硅基流动 Key。'
        : '请确认硅基流动账号已实名认证且余额充足，再试一次。超过 12 小时仍有问题，请反馈给糯米机作者。';
    return advice('记忆宫殿没能调用硅基流动', action);
}
export function selfCheck(log: SystemLog) {
    return log.advice ?? textErrorAdvice(log.message, log.detail) ?? advice(log.type === 'network' ? '这次请求没成功' : '这次操作遇到了问题', '请再试一次。反复出现时，请复制技术详情反馈给糯米机作者。');
}

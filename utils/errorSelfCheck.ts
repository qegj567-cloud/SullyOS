import type { ApiPreset, CharacterProfile, DialogueApiConfig, SystemLog } from '../types';
import type { ApiCallMeta } from './apiCallLog';
import { redactRelayTokensInText } from './networkRequestSource';

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

const MEDIA_ERROR_LABELS: Record<number, string> = {
    1: '音频加载被中止 (MEDIA_ERR_ABORTED)',
    2: '音频网络读取失败 (MEDIA_ERR_NETWORK)',
    3: '音频解码失败 (MEDIA_ERR_DECODE)',
    4: '音频源不可用或格式不支持 (MEDIA_ERR_SRC_NOT_SUPPORTED)',
};

function sanitizeEventResourceUrl(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) return '';
    const trimmed = raw.trim();
    if (/^data:/i.test(trimmed)) {
        const header = trimmed.slice(0, Math.min(trimmed.indexOf(',') >= 0 ? trimmed.indexOf(',') : 48, 48));
        return `${header},<inline ${trimmed.length} chars>`;
    }
    if (/^blob:/i.test(trimmed)) return 'blob:<local>';
    return trimmed.split(/[?#]/)[0].slice(0, 160);
}

function formatErrorValueInternal(error: unknown, fallback: string, depth: number, seen: Set<unknown>): string {
    if (error == null || error === '') return fallback;
    if (typeof error === 'string') return error.trim() || fallback;
    if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') return String(error);
    if (typeof error !== 'object') return fallback;
    if (seen.has(error)) return fallback;
    seen.add(error);

    // MediaError（HTMLAudioElement / HTMLVideoElement 的 WebIDL 错误对象，或跨桥序列化后的同构对象）
    const maybeMedia = error as { code?: unknown; message?: unknown; constructor?: { name?: string } };
    const isMediaErr = (typeof MediaError !== 'undefined' && error instanceof MediaError)
        || maybeMedia?.constructor?.name === 'MediaError'
        || (
            typeof maybeMedia.code === 'number'
            && maybeMedia.code >= 1
            && maybeMedia.code <= 4
            && typeof maybeMedia.message === 'string'
            && /MEDIA_ERR|DEMUXER_ERROR|PIPELINE_ERROR|AUDIO_RENDERER|CHUNK_DEMUXER/i.test(maybeMedia.message)
        );
    if (isMediaErr && typeof maybeMedia.code === 'number' && MEDIA_ERROR_LABELS[maybeMedia.code]) {
        const label = MEDIA_ERROR_LABELS[maybeMedia.code];
        const detail = typeof maybeMedia.message === 'string' && maybeMedia.message.trim() ? `: ${maybeMedia.message.trim()}` : '';
        return `${label}${detail}`;
    }

    if (typeof ErrorEvent !== 'undefined' && error instanceof ErrorEvent) {
        if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
        if (error.error != null && depth < 3) return formatErrorValueInternal(error.error, fallback, depth + 1, seen);
        return '运行脚本异常 (ErrorEvent)';
    }

    const maybeEvent = error as { type?: unknown; target?: { tagName?: unknown; src?: unknown; href?: unknown } | null; message?: unknown; error?: unknown };
    const isDomEvent = (typeof Event !== 'undefined' && error instanceof Event)
        || (typeof maybeEvent.type === 'string' && maybeEvent.target != null && typeof maybeEvent.target === 'object' && maybeEvent.message == null && maybeEvent.error == null);
    if (isDomEvent) {
        let tag = '';
        let resUrl = '';
        try {
            const target = maybeEvent.target;
            tag = typeof target?.tagName === 'string' && target.tagName ? target.tagName.toLowerCase() : '';
            resUrl = sanitizeEventResourceUrl(target?.src || target?.href);
        } catch { /* cross-origin Window target may throw SecurityError */ }
        const where = [tag ? `<${tag}>` : '', resUrl].filter(Boolean).join(' ');
        return `资源或读写事件失败 (${String(maybeEvent.type || 'error')}${where ? ` · ${where}` : ''})`;
    }

    if (Array.isArray(error)) {
        const parts = error
            .slice(0, 4)
            .map((item) => {
                if (item && typeof item === 'object') {
                    const rec = item as { loc?: unknown; msg?: unknown; message?: unknown; error?: unknown };
                    const msg = typeof rec.msg === 'string' ? rec.msg.trim()
                        : typeof rec.message === 'string' ? rec.message.trim()
                            : rec.error != null && depth < 3 ? formatErrorValueInternal(rec.error, '', depth + 1, seen) : '';
                    const loc = Array.isArray(rec.loc)
                        ? rec.loc.filter((s): s is string | number => typeof s === 'string' || typeof s === 'number').map(String).join('.')
                        : '';
                    if (msg) return loc ? `${loc}: ${msg}` : msg;
                }
                return depth < 3 ? formatErrorValueInternal(item, '', depth + 1, seen) : '';
            })
            .filter(Boolean);
        return parts.join('; ') || fallback;
    }

    const rec = error as Record<string, unknown>;

    let primary = '';
    if (typeof rec.message === 'string' && rec.message.trim()) {
        primary = rec.message.trim();
    } else if (rec.message && typeof rec.message === 'object' && depth < 3) {
        primary = formatErrorValueInternal(rec.message, '', depth + 1, seen);
    }
    if (!primary && typeof rec.msg === 'string' && rec.msg.trim()) {
        primary = rec.msg.trim();
    }
    if (!primary && rec.error != null && depth < 3) {
        primary = formatErrorValueInternal(rec.error, '', depth + 1, seen);
    }
    if (!primary && rec.errors != null && depth < 3) {
        primary = formatErrorValueInternal(rec.errors, '', depth + 1, seen);
    }
    const baseResp = rec.base_resp as { status_code?: unknown; status_msg?: unknown } | undefined;
    if (!primary && baseResp && typeof baseResp === 'object') {
        const bMsg = typeof baseResp.status_msg === 'string' ? baseResp.status_msg.trim() : '';
        const bCode = typeof baseResp.status_code === 'number' || typeof baseResp.status_code === 'string' ? String(baseResp.status_code) : '';
        primary = bMsg ? (bCode && !bMsg.includes(bCode) ? `${bMsg} [${bCode}]` : bMsg) : (bCode ? `status_code=${bCode}` : '');
    }
    if (!primary && rec.detail != null && depth < 3) {
        primary = formatErrorValueInternal(rec.detail, '', depth + 1, seen);
    }
    if (!primary && rec.details != null && depth < 3) {
        primary = formatErrorValueInternal(rec.details, '', depth + 1, seen);
    }
    if (!primary && typeof rec.reason === 'string' && rec.reason.trim()) {
        primary = rec.reason.trim();
    }

    const code = (typeof rec.code === 'string' || typeof rec.code === 'number') ? String(rec.code).trim() : '';
    const status = (typeof rec.status === 'number' || typeof rec.status === 'string') ? String(rec.status).trim() : '';
    const extraDetail = typeof rec.details === 'string' && rec.details.trim() && rec.details.trim() !== primary ? rec.details.trim().slice(0, 160) : '';
    const hint = typeof rec.hint === 'string' && rec.hint.trim() ? `提示: ${rec.hint.trim().slice(0, 120)}` : '';

    const tags = [
        code && !primary.includes(code) ? code : '',
        !code && status && !primary.includes(status) ? `status=${status}` : '',
    ].filter(Boolean);

    let combined = primary;
    if (tags.length) combined = combined ? `${combined} [${tags.join(', ')}]` : `[${tags.join(', ')}]`;
    if (extraDetail && !combined.includes(extraDetail)) combined = combined ? `${combined} (${extraDetail})` : extraDetail;
    if (hint && !combined.includes(hint)) combined = combined ? `${combined} · ${hint}` : hint;

    if (!combined && !(error instanceof Error) && typeof rec.toString === 'function' && rec.toString !== Object.prototype.toString) {
        try {
            const rendered = String(error).trim();
            if (
                rendered
                && rendered !== 'undefined'
                && rendered !== 'null'
                && rendered !== 'Error'
                && !/\[object\s+[^\]]+\]/.test(rendered)
            ) {
                combined = rendered;
            }
        } catch { /* fall through */ }
    }

    if (!combined && typeof rec.name === 'string' && rec.name.trim() && rec.name.trim() !== 'Error') {
        combined = rec.name.trim();
    }

    if (rec.cause != null && depth < 2) {
        const causeText = formatErrorValueInternal(rec.cause, '', depth + 1, seen);
        if (causeText && !combined.includes(causeText)) {
            combined = combined ? `${combined} (cause: ${causeText})` : causeText;
        }
    }

    return combined || fallback;
}

/**
 * 将任意异常值（Error、DOMException、PostgREST/网关 JSON 对象、DOM Event、MediaError、null 等）
 * 安全转成可读文本，杜绝产出 `[object Object]`、`[object Event]` 或 `undefined`。
 */
export function formatUnknownError(error: unknown, fallback = '未知错误'): string {
    try {
        return formatErrorValueInternal(error, fallback, 0, new Set());
    } catch {
        return fallback;
    }
}

const VENDOR_STACK_LINE_RE = /(?:\/assets\/build\/vendor(?:-[A-Za-z0-9_-]+)?\.js|\/node_modules\/(?:react-dom|react|scheduler)\/)/i;

/** 折叠无 sourcemap 生产包里成片的 vendor-react 内部调和栈帧，保留业务入口帧与折叠计数。 */
export function cleanErrorStack(stack: string): string {
    if (!stack || typeof stack !== 'string') return '';
    const lines = stack.split(/\r?\n/);
    const out: string[] = [];
    let skippedVendor = 0;
    const flushSkipped = () => {
        if (skippedVendor > 0) {
            out.push(`    ... (已折叠 ${skippedVendor} 行框架内部调用)`);
            skippedVendor = 0;
        }
    };
    for (const line of lines) {
        if (VENDOR_STACK_LINE_RE.test(line)) {
            skippedVendor += 1;
            continue;
        }
        flushSkipped();
        out.push(line);
    }
    flushSkipped();
    return out.join('\n');
}

/** 报错弹窗和「复制报错」用的文本：报错原文在前，调用栈在后。Safari 的 stack 不带报错原文，只给 stack 会让人看到一屏代码位置。 */
export function errorDetails(error: unknown): string {
    const e = error as { stack?: unknown; cause?: unknown } | null | undefined;
    const message = formatUnknownError(error, '未知错误');
    const rawStack = typeof e?.stack === 'string' ? e.stack : '';
    const stack = cleanErrorStack(rawStack);
    let result = !stack ? message : (stack.includes(message) ? stack : `${message}\n\n${stack}`);
    try {
        if (e && typeof e === 'object' && e.cause != null && e.cause !== error) {
            const causeObj = e.cause as { stack?: unknown } | null;
            const causeStack = typeof causeObj?.stack === 'string' ? cleanErrorStack(causeObj.stack) : formatUnknownError(e.cause, '');
            if (causeStack && !result.includes(causeStack)) {
                result = `${result}\n\nCaused by: ${causeStack}`;
            }
        }
    } catch { /* ignore hostile cause getter */ }
    return redactRelayTokensInText(result);
}

export function textErrorAdvice(message: string, detail = ''): ErrorAdvice | undefined {
    const text = message + '\n' + detail;
    if (/损坏的备份包/.test(text)) return advice('这份备份文件损坏了', '请换一份备份，或者重新导出、重新下载后再导入。');
    // iOS 把页面挂起后会中止进行中的写库事务，中止时不带原因（真机实测：恢复途中切走约一分钟）
    if (/^(导入失败|云端恢复失败)$/.test(message) && /IndexedDB transaction aborted/.test(detail)) {
        return advice('恢复被系统打断了', '通常是恢复途中离开这个页面太久，系统中断了写入，数据只恢复了一部分。请重新恢复一次，过程中保持亮屏、不要切走。');
    }
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

function readHeaderSafe(headers: HeadersInit | undefined, name: string): string | undefined {
    if (!headers) return undefined;
    try {
        return new Headers(headers).get(name) ?? undefined;
    } catch {
        const lower = name.toLowerCase();
        try {
            if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name) ?? undefined;
            if (Array.isArray(headers)) {
                const hit = headers.find((pair) => Array.isArray(pair) && String(pair[0]).toLowerCase() === lower);
                return hit && typeof hit[1] === 'string' ? hit[1] : undefined;
            }
            if (typeof headers === 'object') {
                for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
                    if (k.toLowerCase() === lower && typeof v === 'string') return v;
                }
            }
        } catch { /* ignore */ }
        return undefined;
    }
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
    const credential = readHeaderSafe(headers, 'x-api-key') || readHeaderSafe(headers, 'Authorization')?.replace(/^Bearer\s+/i, '');
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

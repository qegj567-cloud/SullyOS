/**
 * 全局 API 调用记录（给 设置 → API 调用记录 页面用）。
 *
 * 设计：项目里 LLM 调用分两类——走 `utils/safeApi.ts` 的 `safeFetchJson` 的，和
 * 各 App 自己写的裸 `fetch`（TRPG / 自习室 / 群聊 / 日记…）。为了一个都不漏，记录点
 * 放在 `OSContext` 里那个全局 `fetch` monkey-patch 上：所有 `/chat/completions`
 * （含 safeFetchJson 内部 fetch）都经过它，统一调 `recordApiCall`，不重复计。
 *
 * 「时间 / 哪个 API / 哪个模型 / token」从请求体 + 响应里自动解析；「哪个 App / 哪个
 * 角色 / 具体用途」靠两条来源：
 *   1. 显式 meta —— safeFetchJson 调用点通过第 5 个参数传，挂到 RequestInit 的
 *      `__sullyMeta` 上由拦截器读取（精确，含 purpose）。
 *   2. 环境兜底 ambientMeta —— OSContext 在切 App / 角色时写入「当前在哪个 App、
 *      当前角色」，裸 fetch 没有显式 meta 时用它兜底标 App / 角色。
 *
 * 只保留近 5 天，超期在 DB 层写入时丢弃。recordApiCall 是 best-effort：任何异常都
 * 吞掉，绝不影响主请求链路。
 */

/** 调用方可补充的语义信息（哪个 App / 角色 / 用途）。能填多少填多少。 */
export interface ApiCallMeta {
    /** AppID 字符串，如 'chat' / 'lifesim'，可空 */
    appId?: string;
    /** App 显示名，如 '消息' / '记忆宫殿'，列表里直接展示这个 */
    appName?: string;
    /** 角色 id，可空 */
    charId?: string;
    /** 角色名，可空 */
    charName?: string;
    /** 具体用途，如 '聊天回复' / '情绪评估' / '记忆提取'，可空 */
    purpose?: string;
}

/** 落库的一条记录。 */
export interface ApiCallLogEntry extends ApiCallMeta {
    id: string;
    /** 调用发起（实际是响应回来）时间戳 ms */
    timestamp: number;
    /** 命中的预设名；匹配不到时回退成 baseUrl 的 host */
    presetName: string;
    baseUrl: string;
    model: string;
    /** HTTP 状态码（成功 / 失败均记，失败时可能是最后一次的状态） */
    status?: number;
    /** 请求是否成功拿到 JSON */
    ok: boolean;
    /** 输入 token（prompt_tokens），来自响应 usage，拿不到则空 */
    promptTokens?: number;
    /** 输出 token（completion_tokens） */
    completionTokens?: number;
    /** 总 token（total_tokens） */
    totalTokens?: number;
}

const PRESETS_STORAGE_KEY = 'os_api_presets';

/**
 * 环境上下文（兜底用）：很多 App 走的是裸 fetch，调用点无法/来不及传 meta。
 * OSContext 会在切换 App / 角色时把「当前在哪个 App、当前角色是谁」写到这里，
 * 全局 fetch 拦截器记录裸 fetch 调用时拿它当兜底标签。
 * 注意：safeFetchJson 传了显式 meta 的调用以显式 meta 为准，不用兜底（避免后台
 * 任务被误标成用户当前所在的 App）。
 */
let ambientMeta: ApiCallMeta = {};

export function setApiCallAmbientContext(meta: ApiCallMeta): void {
    ambientMeta = meta || {};
}

function hasMeta(meta?: ApiCallMeta): boolean {
    return !!meta && Object.values(meta).some((v) => v != null && v !== '');
}

function stripTrailingSlash(s: string): string {
    return s.replace(/\/+$/, '');
}

/** 把 `https://host/v1/chat/completions` 还原成 `https://host/v1`（预设里存的 baseUrl 形态）。 */
function deriveBaseUrl(url: string): string {
    return stripTrailingSlash(url.replace(/\/chat\/completions\/?$/i, ''));
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** 从请求体里抠出 model 字段（body 可能是 JSON 字符串或对象）。 */
function extractModel(body: unknown): string {
    if (!body) return '';
    let parsed: any = body;
    if (typeof body === 'string') {
        try { parsed = JSON.parse(body); } catch { return ''; }
    }
    return typeof parsed?.model === 'string' ? parsed.model : '';
}

/**
 * 用 baseUrl + model 在用户保存的预设里反查预设名（截图里的「奇异果 / 铃兰 / 千岛2」那些）。
 * 预设结构见 types.ts ApiPreset：{ id, name, config: { baseUrl, apiKey, model } }。
 * 匹配不到（比如用的是没存成预设的临时配置）就回退成 host。
 */
function resolvePresetName(baseUrl: string, model: string): string {
    try {
        if (typeof localStorage === 'undefined') return hostOf(baseUrl);
        const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
        if (!raw) return hostOf(baseUrl);
        const presets = JSON.parse(raw);
        if (!Array.isArray(presets)) return hostOf(baseUrl);
        const normBase = stripTrailingSlash(baseUrl);
        // 优先 baseUrl + model 都对上；退而求其次只对 baseUrl
        const exact = presets.find((p: any) =>
            stripTrailingSlash(p?.config?.baseUrl || '') === normBase &&
            (p?.config?.model || '') === model);
        if (exact?.name) return exact.name;
        const byBase = presets.find((p: any) =>
            stripTrailingSlash(p?.config?.baseUrl || '') === normBase);
        if (byBase?.name) return byBase.name;
        return hostOf(baseUrl);
    } catch {
        return hostOf(baseUrl);
    }
}

/**
 * 记录一次 API 调用。fire-and-forget，绝不 throw / 阻塞主链路。
 * 在 safeFetchJson 里对 `/chat/completions` 的成功与失败都会调用。
 */
/** 从 OpenAI 兼容响应里抠 usage（各家代理大多遵循这个字段）。 */
function extractUsage(response: unknown): { prompt?: number; completion?: number; total?: number } {
    const usage = (response as any)?.usage;
    if (!usage || typeof usage !== 'object') return {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return {
        prompt: num(usage.prompt_tokens),
        completion: num(usage.completion_tokens),
        total: num(usage.total_tokens),
    };
}

export function recordApiCall(input: {
    url: string;
    body?: unknown;
    status?: number;
    ok: boolean;
    response?: unknown;
    meta?: ApiCallMeta;
}): void {
    try {
        const baseUrl = deriveBaseUrl(input.url);
        const model = extractModel(input.body);
        // 显式 meta 优先（safeFetchJson 各调用点传的精确信息）；没有就用环境兜底（裸 fetch）。
        const meta = hasMeta(input.meta) ? input.meta! : ambientMeta;
        const usage = extractUsage(input.response);
        const entry: ApiCallLogEntry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            presetName: resolvePresetName(baseUrl, model),
            baseUrl,
            model,
            status: input.status,
            ok: input.ok,
            promptTokens: usage.prompt,
            completionTokens: usage.completion,
            totalTokens: usage.total,
            appId: meta.appId,
            appName: meta.appName,
            charId: meta.charId,
            charName: meta.charName,
            purpose: meta.purpose,
        };
        // 动态 import 避开 safeApi ↔ db 的潜在加载顺序问题；写库失败静默吞掉。
        import('./db')
            .then(({ DB }) => DB.appendApiCallLog(entry))
            .catch(() => {});
    } catch {
        // best-effort：任何异常都不影响主请求
    }
}

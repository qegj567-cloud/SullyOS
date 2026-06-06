// ===== 捕获类别（分类日志的"单一真理源"）=====
// 加新类只动这里：
//   1. 在 DevDebugCaptureCategory 加一个字面量
//   2. 在 DEV_DEBUG_CAPTURE_CATEGORIES 加一行（面板会自动多出一个开关）
//   3. 写一个语义化的 appendDevDebugXxxLog 薄封装（见文件末尾 appendDevDebugApiLog / appendDevDebugInstantPushLog）
// 其余存储 / 脱敏 / 限容 / 导出逻辑全部通用，不用改。
// 分类按「来源通道」切：api = 普通聊天直发模型；instant-push = 经 worker 的通道事件。
export type DevDebugCaptureCategory = 'api' | 'instant-push';

export interface DevDebugCaptureCategoryMeta {
    key: DevDebugCaptureCategory;
    /** 面板 checkbox 上显示的短标签（如 'API' / 'Instant Push'）。 */
    title: string;
    /** 这一类抓什么的说明；面板不再渲染（看不懂就别用），仅作源码内文档。 */
    detail: string;
}

export const DEV_DEBUG_CAPTURE_CATEGORIES: DevDebugCaptureCategoryMeta[] = [
    {
        key: 'api',
        title: 'API',
        detail: '普通聊天直发模型的 chat completions 请求与响应。',
    },
    {
        key: 'instant-push',
        title: 'IP',
        detail: 'Instant Push 通道：经 worker 的 LLM 交换 + SSE 投递结果（超时 / 收到 / 失败）。',
    },
];

const CAPTURE_CATEGORY_KEYS: DevDebugCaptureCategory[] = DEV_DEBUG_CAPTURE_CATEGORIES.map((c) => c.key);

export interface DevDebugFlags {
    skipPromptBuild: boolean;
    skipEmotionEval: boolean;
    /**
     * 日志总开关：关掉时无论勾了哪些类别都不抓，默认关。
     * 跟 captureLogs 配合——是否抓 = captureEnabled && captureLogs.includes(category)。
     */
    captureEnabled: boolean;
    /** 勾选了哪些捕获类别（纯选择）。取消勾选只影响此后抓取，不清已有日志。 */
    captureLogs: DevDebugCaptureCategory[];
    /**
     * 导出（复制 / 下载）时是否输出完整内容。
     * 默认 false：长文本折叠成「前 N 字 + ...」，省隐私 / 省体积。
     * 只影响导出那一层，不改变实际抓取 / 存储的数据。
     */
    exposeLogDetail: boolean;
}

export interface DevDebugLogEntry {
    id: string;
    timestamp: string;
    category: DevDebugCaptureCategory;
    /** 列表 / 导出里用的一行摘要，比如 "POST https://.../chat/completions"。 */
    label?: string;
    /** 抓取时是否折叠了长文本（即抓的那一刻没开 exposeLogDetail）。 */
    collapsed?: boolean;
    /** 该类自定义的 payload，写入前会递归脱敏；默认还会折叠长文本。 */
    data: unknown;
}

export interface DevDebugFloatingPosition {
    x: number;
    y: number;
}

export const DEV_DEBUG_STORAGE_KEY = 'sullyos.devDebug.flags.v1';
export const DEV_DEBUG_EVENT = 'sullyos-dev-debug-change';
export const DEV_DEBUG_LOG_STORAGE_KEY = 'sullyos.devDebug.log.v1';
export const DEV_DEBUG_LOG_EVENT = 'sullyos-dev-debug-log-change';
// 内部事件名，只通过 subscribeDevDebugAvailability 暴露——不 export 出去，免得固化成公共契约。
const DEV_DEBUG_AVAILABILITY_EVENT = 'sullyos-dev-debug-availability';

export const DEFAULT_DEV_DEBUG_FLAGS: DevDebugFlags = {
    skipPromptBuild: false,
    skipEmotionEval: false,
    captureEnabled: false,
    captureLogs: [],
    exposeLogDetail: false,
};

const MAX_LOG_ENTRIES = 100;
const MAX_LOG_STORAGE_CHARS = 1_000_000;
// 只折 messages 这一个 key——别的字段（url、error.reason、response 任意键值等）一律原样保留，
// 免得 reason / outcome / status 这种关键短字符串也被截掉。
// messages 数组本身整个换成 ["…共 N 项（已折叠）"]，一条都不留——首条 system prompt 体积通常很大，
// 留着没省到多少空间，要看就开「记录完整内容」。
const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|bearer|token|secret|endpoint|p256dh|auth)$/i;
let memoryLog: DevDebugLogEntry[] | null = null;

function normalizeStorageKeyPart(value: string): string {
    return value.trim().replace(/[^a-z0-9._-]+/gi, '_') || 'unknown';
}

function getBuildBranch(): string {
    return typeof __BUILD_BRANCH__ !== 'undefined' ? __BUILD_BRANCH__ : 'unknown';
}

function getScopedStorageKey(baseKey: string): string {
    return `${baseKey}.${normalizeStorageKeyPart(getBuildBranch())}`;
}

function canUseDevDebugStorage(): boolean {
    return isDevDebugAvailable() && typeof window !== 'undefined';
}

function normalizeCaptureLogs(value: unknown): DevDebugCaptureCategory[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<DevDebugCaptureCategory>();
    for (const item of value) {
        // 旧版本只有 'llm' 一类，迁移成 'api'，老用户存档不丢勾选。
        const migrated = item === 'llm' ? 'api' : item;
        if (CAPTURE_CATEGORY_KEYS.includes(migrated as DevDebugCaptureCategory)) {
            seen.add(migrated as DevDebugCaptureCategory);
        }
    }
    return [...seen];
}

function normalizeFlags(value: unknown): DevDebugFlags {
    const source = (value && typeof value === 'object') ? value as Partial<DevDebugFlags> : {};
    const captureLogs = normalizeCaptureLogs(source.captureLogs);
    // 平滑迁移：老存档没 captureEnabled 字段（旧 schema 只有 captureLogs，勾了就抓），
    // 直接推 false 会让老用户升级后类型还勾着、其实静默停录。所以「字段缺 + 有勾选」时推 true。
    const legacyHasCapture = !('captureEnabled' in source) && captureLogs.length > 0;
    return {
        skipPromptBuild: source.skipPromptBuild === true,
        skipEmotionEval: source.skipEmotionEval === true,
        captureEnabled: source.captureEnabled === true || legacyHasCapture,
        captureLogs,
        exposeLogDetail: source.exposeLogDetail === true,
    };
}

// 会话级开关（都不落 localStorage → 刷新即重置）：
//   manualUnlock：prod 上连点构建版本 5 下临时解锁，刷新即关。
//   forceClosed：面板「关闭」按钮，任意分支强制关掉；刷新后失效 → 非 prod 自动回来。
let devDebugManualUnlock = false;
let devDebugForceClosed = false;

export function isDevDebugAvailable(): boolean {
    if (devDebugForceClosed) return false;
    const badgeVisible = typeof __BUILD_BADGE_VISIBLE__ !== 'undefined' && __BUILD_BADGE_VISIBLE__;
    // 非 prod（badge 可见）默认一直开；prod 默认关，靠 manualUnlock 临时调出。
    return badgeVisible || devDebugManualUnlock;
}

function emitDevDebugAvailability(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<boolean>(DEV_DEBUG_AVAILABILITY_EVENT, { detail: isDevDebugAvailable() }));
}

/** 连点构建版本 5 下：会话级解锁面板（刷新即关），并解除强制关闭。 */
export function unlockDevDebug(): void {
    devDebugManualUnlock = true;
    devDebugForceClosed = false;
    // 失效内存缓存：prod 初始 mount 时 canUseDevDebugStorage()=false 会把 memoryLog 锁成 []，
    // 解锁后如果不重读，上一会话存在 localStorage 里的日志会被遮蔽，下一次 append 还会覆盖掉。
    memoryLog = null;
    emitDevDebugAvailability();
}

/** 面板「关闭」按钮：任意分支强制关掉（会话级；刷新后非 prod 会自动恢复）。 */
export function closeDevDebug(): void {
    devDebugForceClosed = true;
    devDebugManualUnlock = false;
    emitDevDebugAvailability();
}

/** 订阅「面板是否可用」变化（解锁 / 关闭）。会话级，无跨标签页同步。 */
export function subscribeDevDebugAvailability(listener: (available: boolean) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const onChange = (event: Event) => {
        const detail = (event as CustomEvent<boolean>).detail;
        listener(typeof detail === 'boolean' ? detail : isDevDebugAvailable());
    };
    window.addEventListener(DEV_DEBUG_AVAILABILITY_EVENT, onChange);
    return () => window.removeEventListener(DEV_DEBUG_AVAILABILITY_EVENT, onChange);
}

export function readDevDebugFlags(): DevDebugFlags {
    if (!canUseDevDebugStorage()) return DEFAULT_DEV_DEBUG_FLAGS;

    try {
        const raw = window.localStorage.getItem(getScopedStorageKey(DEV_DEBUG_STORAGE_KEY));
        if (!raw) return DEFAULT_DEV_DEBUG_FLAGS;
        return normalizeFlags(JSON.parse(raw));
    } catch {
        return DEFAULT_DEV_DEBUG_FLAGS;
    }
}

export function writeDevDebugFlags(flags: DevDebugFlags): DevDebugFlags {
    const next = normalizeFlags(flags);
    if (!canUseDevDebugStorage()) return next;
    const prev = readDevDebugFlags();

    try {
        window.localStorage.setItem(getScopedStorageKey(DEV_DEBUG_STORAGE_KEY), JSON.stringify(next));
    } catch {
        // localStorage can be blocked in private / embedded contexts; the UI still keeps local state.
    }

    // 取消勾选某类别「不」清它的日志——勾选是纯选择，只影响此后抓取。
    // 要清日志走「重置」（面板 resetFlags → clearDevDebugLog）。
    // 例外：总开关 captureEnabled 由 true → false 时清空日志——一次「录制周期」结束。
    // 放在数据层而不是 UI handler 里，是为了让任何路径改 captureEnabled 都享受同一行为，
    // 不会因为换个调用点（测试 helper、未来设置镜像）漏掉。
    if (prev.captureEnabled && !next.captureEnabled) {
        clearDevDebugLog();
    }

    window.dispatchEvent(new CustomEvent<DevDebugFlags>(DEV_DEBUG_EVENT, { detail: next }));
    return next;
}

export function updateDevDebugFlags(updater: (flags: DevDebugFlags) => DevDebugFlags): DevDebugFlags {
    return writeDevDebugFlags(updater(readDevDebugFlags()));
}

export function subscribeDevDebugFlags(listener: (flags: DevDebugFlags) => void): () => void {
    if (typeof window === 'undefined') return () => {};

    const storageKey = getScopedStorageKey(DEV_DEBUG_STORAGE_KEY);
    const onChange = (event: Event) => {
        const detail = (event as CustomEvent<DevDebugFlags>).detail;
        listener(detail ? normalizeFlags(detail) : readDevDebugFlags());
    };
    const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey) listener(readDevDebugFlags());
    };

    window.addEventListener(DEV_DEBUG_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(DEV_DEBUG_EVENT, onChange);
        window.removeEventListener('storage', onStorage);
    };
}

export function isPromptBuildSkipped(): boolean {
    return readDevDebugFlags().skipPromptBuild;
}

export function isEmotionEvalSkipped(): boolean {
    return readDevDebugFlags().skipEmotionEval;
}

export function isCaptureEnabled(category: DevDebugCaptureCategory): boolean {
    // 「关闭」按钮 = 强制下线整个调试系统（任意分支）。这里也必须挡住捕获，
    // 否则面板已收起，业务代码却还往 localStorage 里写带 url/status 的日志条目（隐私债）。
    if (devDebugForceClosed) return false;
    const flags = readDevDebugFlags();
    // 总开关关掉时一律不抓，哪怕该类别勾着。
    return flags.captureEnabled && flags.captureLogs.includes(category);
}

function redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (!value || typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEY_PATTERN.test(key)) {
            out[key] = '<redacted>';
        } else {
            out[key] = redactSecrets(item);
        }
    }
    return out;
}

function safeJsonValue(value: unknown): unknown {
    if (value === undefined) return undefined;
    try {
        return redactSecrets(JSON.parse(JSON.stringify(value)));
    } catch {
        return String(value);
    }
}

function parseRequestBody(body: unknown): unknown {
    if (body === undefined || body === null) return undefined;
    if (typeof body !== 'string') return body;
    try {
        return JSON.parse(body);
    } catch {
        return body;
    }
}

// 折叠 messages（聊天历史）数组：整组替换成单句 metadata，一条都不留。
function collapseMessagesArray(arr: unknown[]): unknown[] {
    if (arr.length === 0) return arr;
    return [`…共 ${arr.length} 项（已折叠）`];
}

// 递归遍历对象 / 数组，**只对** key === 'messages' 且值为数组的字段折叠。
// 其它字段（字符串、数字、布尔、其它数组、其它对象）一律原样保留——
// 折太多反而看不到 error.reason / response.outcome 这类关键字段。
function collapseMessagesInData(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(collapseMessagesInData);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[key] = (key === 'messages' && Array.isArray(item))
                ? collapseMessagesArray(item)
                : collapseMessagesInData(item);
        }
        return out;
    }
    return value;
}

function readPersistedLog(): DevDebugLogEntry[] {
    if (memoryLog) return memoryLog;
    if (!canUseDevDebugStorage()) {
        memoryLog = [];
        return memoryLog;
    }
    try {
        const raw = window.localStorage.getItem(getScopedStorageKey(DEV_DEBUG_LOG_STORAGE_KEY));
        const parsed = raw ? JSON.parse(raw) : [];
        memoryLog = Array.isArray(parsed) ? parsed : [];
    } catch {
        memoryLog = [];
    }
    return memoryLog;
}

function emitLogChange(entries: DevDebugLogEntry[]): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<DevDebugLogEntry[]>(DEV_DEBUG_LOG_EVENT, { detail: entries }));
}

function persistLog(entries: DevDebugLogEntry[]): void {
    memoryLog = entries;
    if (canUseDevDebugStorage()) {
        try {
            window.localStorage.setItem(getScopedStorageKey(DEV_DEBUG_LOG_STORAGE_KEY), JSON.stringify(entries));
        } catch {
            // Keep the in-memory log even when localStorage is full or blocked.
        }
    }
    emitLogChange(entries);
}

/** 读取捕获日志；传 category 只取该类，不传取全部。 */
export function readDevDebugLog(category?: DevDebugCaptureCategory): DevDebugLogEntry[] {
    const all = [...readPersistedLog()];
    return category ? all.filter((entry) => entry.category === category) : all;
}

/** 清空日志；传 categories 只清这几类，不传清全部。 */
export function clearDevDebugLog(categories?: DevDebugCaptureCategory[]): void {
    if (!categories || categories.length === 0) {
        memoryLog = [];
        if (canUseDevDebugStorage()) {
            try {
                window.localStorage.removeItem(getScopedStorageKey(DEV_DEBUG_LOG_STORAGE_KEY));
            } catch {
                // ignore
            }
        }
        emitLogChange([]);
        return;
    }

    const remaining = readPersistedLog().filter((entry) => !categories.includes(entry.category));
    persistLog(remaining);
}

/**
 * 通用捕获入口：所有分类日志都走这里。
 * 自带门禁（该类没勾就空操作）、脱敏、折叠、限容、双写（内存 + localStorage）、广播，调用方不用操心。
 * 默认只折 messages 数组（聊天历史几十条会刷屏，留首条 + 计数提示）；其它字段（reason / outcome /
 * url / status / 任意 response 值）原样保留。开了 exposeLogDetail 后连 messages 也整段存。
 */
export function appendDevDebugLog(category: DevDebugCaptureCategory, input: { label?: string; data: unknown }): void {
    try {
        if (!isCaptureEnabled(category)) return;

        const exposed = readDevDebugFlags().exposeLogDetail;
        const safeData = safeJsonValue(input.data);
        const entry: DevDebugLogEntry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
            category,
            label: input.label,
            collapsed: !exposed,
            data: exposed ? safeData : collapseMessagesInData(safeData),
        };

        const next = [...readPersistedLog(), entry].slice(-MAX_LOG_ENTRIES);
        while (next.length > 1 && JSON.stringify(next).length > MAX_LOG_STORAGE_CHARS) {
            next.shift();
        }
        persistLog(next);
    } catch (e) {
        console.error('Failed to append dev debug log', e);
    }
}

/** HTTP 类日志的统一形状：api（普通聊天）和 instant-push（通道事件）共用。 */
export interface DevDebugHttpLogInput {
    url: string;
    method?: string;
    status?: number;
    requestBody?: unknown;
    response?: unknown;
    error?: unknown;
}

/** 通用 HTTP 日志薄封装；按 category 落到对应类别，请求体 / 错误统一整形。 */
function appendDevDebugHttpLog(category: DevDebugCaptureCategory, input: DevDebugHttpLogInput): void {
    // label 前缀加分类——activeMsgRuntime 的 instant-push 交换 url 跟 safeApi 的 api 直发一字不差
    // （两边都是 baseUrl + /chat/completions），不带前缀的话导出 JSON 里两类条目肉眼分不清。
    appendDevDebugLog(category, {
        label: `[${category}] ${input.method ?? 'POST'} ${input.url}`,
        data: {
            url: input.url,
            method: input.method,
            status: input.status,
            request: parseRequestBody(input.requestBody),
            response: input.response,
            error: input.error
                ? {
                    name: (input.error as any)?.name,
                    message: (input.error as any)?.message || String(input.error),
                }
                : undefined,
        },
    });
}

/** api 类：普通聊天直发模型的 chat completions（消费点 safeApi）。 */
export function appendDevDebugApiLog(input: DevDebugHttpLogInput): void {
    appendDevDebugHttpLog('api', input);
}

/** instant-push 类：经 worker 的通道事件（消费点 activeMsgRuntime / instantPushClient）。 */
export function appendDevDebugInstantPushLog(input: DevDebugHttpLogInput): void {
    appendDevDebugHttpLog('instant-push', input);
}

export interface DevDebugLogger {
    log(event: string, ...details: unknown[]): void;
    info(event: string, ...details: unknown[]): void;
    debug(event: string, ...details: unknown[]): void;
    warn(event: string, ...details: unknown[]): void;
    error(event: string, ...details: unknown[]): void;
}

/**
 * 模块级 logger 工厂：把一个模块跟 (category, tagPrefix) 绑定，业务代码用 `log.warn(event, ...)`
 * 替代 `console.warn('[Tag] event', ...)`。内部双写：
 *   1) `console[level]('[tagPrefix] event', ...details)`——F12 看到的跟以前完全一样
 *   2) `appendDevDebugLog(category, { label: 'level:Tag event', data: details })`——勾了对应类
 *      就被复制 / 下载导出。
 *
 * gate 由 isCaptureEnabled 自动管，未勾时 step 2 是空操作、零成本。每文件顶部建一次即可，
 * 业务代码新增日志只用一行 `log.warn(...)`，自动既上 F12 又进 devDebug——免得每条 console
 * 调用旁边手抄一行 appendDevDebugLog 容易漏。
 */
export function makeDebugLogger(category: DevDebugCaptureCategory, tagPrefix: string): DevDebugLogger {
    const make = (level: 'log' | 'info' | 'debug' | 'warn' | 'error') =>
        (event: string, ...details: unknown[]): void => {
            try {
                // eslint-disable-next-line no-console -- 故意保留 F12 输出
                console[level](`[${tagPrefix}] ${event}`, ...details);
            } catch { /* console 不可用就放过 */ }
            appendDevDebugLog(category, {
                label: `${level}:${tagPrefix} ${event}`,
                data: details.length === 0 ? undefined : details.length === 1 ? details[0] : details,
            });
        };
    return {
        log: make('log'),
        info: make('info'),
        debug: make('debug'),
        warn: make('warn'),
        error: make('error'),
    };
}

/**
 * 把捕获日志格式化成可复制 / 可下载的 JSON 文本；传 category 只导该类，无日志返回空串。
 * 折叠在写入层就做完了，这里直接吐存的内容；带 `collapsed` 的条目即抓取时没开 exposeLogDetail。
 */
export function formatDevDebugLog(category?: DevDebugCaptureCategory): string {
    const entries = readDevDebugLog(category);
    if (entries.length === 0) return '';

    const hasCollapsed = entries.some((entry) => entry.collapsed);
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        build: {
            branch: typeof __BUILD_BRANCH__ !== 'undefined' ? __BUILD_BRANCH__ : 'unknown',
            commit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'unknown',
        },
        ...(hasCollapsed
            ? { note: '部分条目抓取时已折叠 messages 聊天历史（整组替换成一句计数）；想要完整内容请先在面板开「记录完整内容」再复现。' }
            : {}),
        entries,
    }, null, 2);
}

export function subscribeDevDebugLog(listener: (entries: DevDebugLogEntry[]) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const onChange = (event: Event) => {
        const detail = (event as CustomEvent<DevDebugLogEntry[]>).detail;
        listener(Array.isArray(detail) ? [...detail] : readDevDebugLog());
    };
    window.addEventListener(DEV_DEBUG_LOG_EVENT, onChange);
    return () => window.removeEventListener(DEV_DEBUG_LOG_EVENT, onChange);
}

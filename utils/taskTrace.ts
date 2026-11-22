/**
 * 长任务的中断留痕：任务途中把「做到哪」写进 localStorage，正常结束或报错结束时删掉。
 * App 闪退、被系统杀掉时内存里的一切都没了，只有这个键留得下来；下次启动时 consumeTaskTrace 把它读成一段日志文本，读完即删。
 * 各个任务只负责报「我在做什么、做到哪」，节流、写入兜底、删除、读出都在这里。设计见 docs/backup-pipeline.md「中断留痕」。
 *
 * 键名一律是 `sullyos_notice_<任务>_progress_v<版本>`：
 * - `sullyos_notice_` 前缀让 isSharedSpaceKey 认它是各用户空间共用的键，重开后进哪个空间都读得到，
 *   它也因此不进任何空间的本地设置，canMigrateLocalKey 不放它迁入；
 * - 共享设置那一路由 userSpaceBackup.ts 的 privateLocalExcluded 用 isTaskTraceKey 拦下，不进备份。
 * 只记位置、计数和体积，不记任何字段内容。
 */
import { rawSpaceStorage } from './userSpaces';

export type TraceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** 同一步里两次留痕至少隔这么久，几千页、几千次进度回调不会每次都写一遍 localStorage。 */
const TRACE_INTERVAL_MS = 500;

export const isTaskTraceKey = (key: string) => /^sullyos_notice_[a-z0-9_]+_progress_v\d+$/.test(key);

export interface TaskTraceBase { version: 1; startedAt: number; updatedAt: number; build?: string }

/**
 * 开一份留痕。返回的 trace 由调用方直接改字段，再调 save()；save(true) 跳过节流立刻写。
 * storage 为 undefined（没有 localStorage 的环境）时什么都不写。
 */
export function openTaskTrace<T extends object>(key: string, fields: T, options: { startedAt?: number; storage?: TraceStorage | undefined } = {}) {
    const storage = 'storage' in options ? options.storage : rawSpaceStorage;
    const build = (globalThis as { __APP_BUILD_ID__?: unknown }).__APP_BUILD_ID__;
    const trace = {
        version: 1 as const, startedAt: options.startedAt ?? Date.now(), updatedAt: 0,
        ...(typeof build === 'string' && build ? { build } : {}),
        ...fields,
    } as TaskTraceBase & T;
    let lastWrite = -Infinity;
    return {
        trace,
        save(force = false) {
            const now = performance.now();
            if (!force && now - lastWrite < TRACE_INTERVAL_MS) return;
            lastWrite = now;
            trace.updatedAt = Date.now();
            try { storage?.setItem(key, JSON.stringify(trace)); } catch { /* 写不进去只是少一份诊断，任务照常 */ }
        },
        clear() { try { storage?.removeItem(key); } catch { /* ignore */ } },
    };
}

export interface TaskTraceKind<T = any> {
    key: string;
    /** 日志标题，如「上次备份导出没有完成」 */
    title: string;
    /** 系统调试终端里的来源标签 */
    source: string;
    /** 给用户看的下一步建议 */
    advice: string;
    describe(trace: TaskTraceBase & T): string;
}
export interface TaskTraceReport { key: string; title: string; source: string; advice: string; detail: string }

/**
 * 启动时调用：有上次没走完的留痕就生成日志文本并删掉这个键，同一份只报一次；没有就返回 null。
 * 内容解析不了时照样删键，只报一句没完成。
 */
export function consumeTaskTrace(kind: TaskTraceKind, storage: TraceStorage | undefined = rawSpaceStorage): TaskTraceReport | null {
    let text: string | null = null;
    try { text = storage?.getItem(kind.key) ?? null; } catch { return null; }
    if (!text) return null;
    try { storage?.removeItem(kind.key); } catch { /* ignore */ }
    let detail = '诊断信息读不出来了。';
    try {
        const trace = JSON.parse(text);
        if (trace && typeof trace === 'object' && trace.version === 1) detail = kind.describe(trace);
    } catch { /* 用上面的兜底句 */ }
    return { key: kind.key, title: kind.title, source: kind.source, advice: kind.advice, detail };
}

export function formatTraceBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const localTime = (ms: number) => {
    const d = new Date(ms), pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const duration = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
};
/** 每份留痕末尾共用的两行：开始时间和持续多久、构建标识。 */
export function traceFooter(trace: TaskTraceBase): string[] {
    const lines = [`开始时间：${localTime(trace.startedAt)}，到最后一次留痕持续了 ${duration(trace.updatedAt - trace.startedAt)}`];
    if (trace.build) lines.push(`构建：${trace.build}`);
    return lines;
}

// ---- 按步骤报进度的留痕：单用户导出、云端上传下载、一键优化共用 ----

/** B 表示字节，显示时换算成 KB / MB。 */
export type StepUnit = '条' | '页' | '片' | '张' | '项' | '%' | 'B';
export interface StepTrace {
    /** 正在做的那一步，如「打包 messages」「上传第 2 / 5 片」 */
    step: string;
    done?: number; total?: number; unit?: StepUnit;
    /** 定位用的附加事实，键是显示名，值只放计数、体积、固定枚举 */
    facts: Record<string, string | number>;
}
const STEP_KINDS = {
    singleExport: { key: 'sullyos_notice_single_export_progress_v1', title: '上次备份导出没有完成', source: '备份导出', advice: '可能是导出途中页面被系统关掉了。请把下方技术详情里的这条日志复制发给开发者，再导出一次前建议先刷新页面。' },
    cloudUpload: { key: 'sullyos_notice_cloud_upload_progress_v1', title: '上次云端备份上传没有完成', source: '云端备份', advice: '可能是上传途中页面被系统关掉了，云端那份不完整的备份不会出现在恢复列表里。请把下方技术详情里的这条日志复制发给开发者，再上传一次。' },
    cloudDownload: { key: 'sullyos_notice_cloud_download_progress_v1', title: '上次云端备份下载没有完成', source: '云端备份', advice: '可能是下载途中页面被系统关掉了，这时还没开始恢复，本机数据没动过。请把下方技术详情里的这条日志复制发给开发者，再下载一次。' },
    optimize: { key: 'sullyos_notice_optimize_progress_v1', title: '上次一键优化没有完成', source: '存储优化', advice: '可能是优化途中页面被系统关掉了。已经改写的记录都是完整的，可以再点一次一键优化接着做。请把下方技术详情里的这条日志复制发给开发者。' },
} as const;
export type StepTraceKindName = keyof typeof STEP_KINDS;

const amount = (n: number, unit: StepUnit | undefined) => unit === 'B' ? formatTraceBytes(n) : `${n}${unit && unit !== '%' ? ` ${unit}` : unit ?? ''}`;
export function describeStepTrace(trace: TaskTraceBase & StepTrace): string {
    const lines = [`停在：${trace.step}`];
    if (typeof trace.done === 'number') lines.push(`进度：${amount(trace.done, trace.unit)}${typeof trace.total === 'number' ? ` / ${amount(trace.total, trace.unit)}` : ''}`);
    for (const [label, value] of Object.entries(trace.facts || {})) lines.push(`${label}：${value}`);
    return [...lines, ...traceFooter(trace)].join('\n');
}
export const STEP_TRACE_KINDS: TaskTraceKind<StepTrace>[] = Object.values(STEP_KINDS).map(kind => ({ ...kind, describe: describeStepTrace }));

/**
 * 开一份按步骤报进度的留痕。换了一步立刻写，同一步里的进度更新按节流写。
 * 调用方必须在 finally 里 clear()：只有走不到收尾的情况才该把它留下来。
 */
export function startStepTrace(kind: StepTraceKindName, facts: StepTrace['facts'] = {}, storage: TraceStorage | undefined = rawSpaceStorage) {
    const { trace, save, clear } = openTaskTrace<StepTrace>(STEP_KINDS[kind].key, { step: '开始', facts: { ...facts } }, { storage });
    save(true);
    return {
        step(step: string, done?: number, total?: number, unit?: StepUnit) {
            const changed = step !== trace.step;
            Object.assign(trace, { step, done, total, unit });
            save(changed);
        },
        /** 补几条附加事实，立刻写。 */
        note(facts: StepTrace['facts']) { Object.assign(trace.facts, facts); save(true); },
        clear,
    };
}
export type StepTraceWriter = ReturnType<typeof startStepTrace>;

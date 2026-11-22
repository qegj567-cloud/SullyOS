/**
 * 多空间导出的进度留痕：导出途中把「进行到哪」写进 localStorage，正常结束或报错结束时删掉。
 * 闪退、被系统杀掉时内存里的一切都没了，只有这个键留得下来；下次启动时 consumeExportTrace 把它写成一条系统调试终端日志。
 *
 * 键名用 `sullyos_notice_` 前缀：isSharedSpaceKey 认它是各用户空间共用的键，按空间加前缀的那层包装不会改写它，
 * 重开后进哪个空间都读得到；同样因为是共用键，它不进任何空间的本地设置，canMigrateLocalKey 也不放它迁入。
 * 共享设置那一路由 userSpaceBackup.ts 的 privateLocalExcluded 拦下（与「导入中」标记同一条规则）。
 * 只记位置和体积，不记任何字段内容。
 */
import { rawSpaceStorage } from './userSpaces';

export const EXPORT_TRACE_KEY = 'sullyos_notice_export_progress_v1';
/** 同一张表内两次留痕至少隔这么久，几千页的小表不会每页都写一次 localStorage。 */
const TRACE_INTERVAL_MS = 500;
/** 单条超过这个粗估体积时，打包这一页之前立刻留痕：这类行正是要找的嫌疑。 */
const LARGE_ROW_BYTES = 1024 * 1024;
const KEY_TEXT_LIMIT = 80;

type TraceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ExportTraceTable {
    space: string; store: string;
    rowsRead: number; total: number; pages: number;
    /** 最近读出的那一页的粗估字节数 */
    pageBytes: number;
    /** 这张表到目前为止最大的一条，主键转成字符串并截断 */
    maxRowBytes: number; maxRowKey?: string;
}
export interface ExportTrace {
    version: 1;
    startedAt: number; updatedAt: number;
    mode: string; scope: string; build?: string;
    /** read = 正在读当前表的下一页；pack = 正在打包写入刚读出的那一页；assets = 正在打包共享素材 */
    stage: 'read' | 'pack' | 'assets';
    onDisk: boolean; writtenBytes: number;
    current?: ExportTraceTable; previous?: ExportTraceTable;
}

const keyText = (key: IDBValidKey | undefined) => {
    if (key === undefined) return undefined;
    try { return String(key).slice(0, KEY_TEXT_LIMIT); } catch { return undefined; }
};

export function createExportTrace(options: { mode: string; scope: string; onDisk: boolean; startedAt?: number }, storage: TraceStorage | undefined = rawSpaceStorage) {
    const build = (globalThis as { __APP_BUILD_ID__?: unknown }).__APP_BUILD_ID__;
    const trace: ExportTrace = {
        version: 1, startedAt: options.startedAt ?? Date.now(), updatedAt: 0, mode: options.mode, scope: options.scope,
        ...(typeof build === 'string' && build ? { build } : {}),
        stage: 'read', onDisk: options.onDisk, writtenBytes: 0,
    };
    let lastWrite = -Infinity;
    const save = (force = false) => {
        const now = performance.now();
        if (!force && now - lastWrite < TRACE_INTERVAL_MS) return;
        lastWrite = now;
        trace.updatedAt = Date.now();
        try { storage?.setItem(EXPORT_TRACE_KEY, JSON.stringify(trace)); } catch { /* 写不进去只是少一份诊断，导出照常 */ }
    };
    const moveOn = () => { if (trace.current) trace.previous = trace.current; trace.current = undefined; };
    return {
        /** 开读一张表之前调用，立刻留痕。 */
        table(space: string, store: string, total: number) {
            moveOn();
            trace.current = { space, store, rowsRead: 0, total, pages: 0, pageBytes: 0, maxRowBytes: 0 };
            trace.stage = 'read';
            save(true);
        },
        /** 一页读出来、打包之前调用。 */
        pageRead(page: { rows: unknown[]; bytes: number; maxRowBytes: number; maxRowKey?: IDBValidKey }) {
            const current = trace.current;
            if (!current) return;
            current.rowsRead += page.rows.length; current.pages++; current.pageBytes = page.bytes;
            if (page.maxRowBytes > current.maxRowBytes) { current.maxRowBytes = page.maxRowBytes; current.maxRowKey = keyText(page.maxRowKey); }
            trace.stage = 'pack';
            save(page.maxRowBytes >= LARGE_ROW_BYTES);
        },
        /** 一页写进压缩包之后调用；它同时就是读下一页之前的那次留痕。 */
        pageWritten() { trace.stage = 'read'; save(); },
        assets() { moveOn(); trace.stage = 'assets'; save(true); },
        written(bytes: number) { trace.writtenBytes = bytes; },
        clear() { try { storage?.removeItem(EXPORT_TRACE_KEY); } catch { /* ignore */ } },
    };
}
export type ExportTraceWriter = ReturnType<typeof createExportTrace>;

const MODE_LABELS: Record<string, string> = { full: '整合备份', text_only: '纯文字备份', media_only: '媒体与美化素材' };
const SCOPE_LABELS: Record<string, string> = { current: '当前用户', all: '所有用户' };

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
const largest = (t: ExportTraceTable) => t.maxRowBytes ? `约 ${formatTraceBytes(t.maxRowBytes)}${t.maxRowKey !== undefined ? `（编号 ${t.maxRowKey}）` : ''}` : '还没读到';
const tableName = (t: ExportTraceTable) => `${t.space} · ${t.store}`;

export function describeExportTrace(trace: ExportTrace): string {
    const { current, previous } = trace;
    const lines: string[] = [];
    if (trace.stage === 'assets') lines.push('停在：打包共享素材（各张表已读完）');
    else if (current) {
        lines.push(`停在：${tableName(current)}（${trace.stage === 'pack' ? `正在打包第 ${current.pages} 页` : `正在读取第 ${current.pages + 1} 页`}）`);
        lines.push(`已读 / 总条数：${current.rowsRead} / ${current.total}`);
        lines.push(`当前这一页：${current.pages ? `约 ${formatTraceBytes(current.pageBytes)}` : '还没读出'}`);
        lines.push(`这张表最大的一条：${largest(current)}`);
    } else lines.push('停在：还没开始读表');
    if (previous) lines.push(`前一张表：${tableName(previous)}，已读 ${previous.rowsRead} / ${previous.total} 条，共 ${previous.pages} 页，最大的一条${largest(previous)}`);
    lines.push(`已写出：${formatTraceBytes(trace.writtenBytes)}（${trace.onDisk ? '写在磁盘上' : '写在内存里'}）`);
    lines.push(`导出样式：${MODE_LABELS[trace.mode] ?? trace.mode} · ${SCOPE_LABELS[trace.scope] ?? trace.scope}`);
    lines.push(`开始时间：${localTime(trace.startedAt)}，到最后一次留痕持续了 ${duration(trace.updatedAt - trace.startedAt)}`);
    if (trace.build) lines.push(`构建：${trace.build}`);
    return lines.join('\n');
}

/**
 * 启动时调用：有上次没走完的导出留痕就生成日志文本并删掉这个键，同一份留痕只报一次；没有就返回 null。
 * 内容解析不了时照样删键，只报一句没完成。
 */
export function consumeExportTrace(storage: TraceStorage | undefined = rawSpaceStorage): { title: string; detail: string } | null {
    let text: string | null = null;
    try { text = storage?.getItem(EXPORT_TRACE_KEY) ?? null; } catch { return null; }
    if (!text) return null;
    try { storage?.removeItem(EXPORT_TRACE_KEY); } catch { /* ignore */ }
    let detail = '诊断信息读不出来了。';
    try {
        const trace = JSON.parse(text) as ExportTrace;
        if (trace && typeof trace === 'object' && trace.version === 1) detail = describeExportTrace(trace);
    } catch { /* 用上面的兜底句 */ }
    return { title: '上次备份导出没有完成', detail };
}

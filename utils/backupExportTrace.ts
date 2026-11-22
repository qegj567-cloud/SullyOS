/**
 * 多空间导出的进度留痕。节流写入、删除、启动时读出都在 taskTrace.ts，这里只管导出报的是哪几项、读出来怎么写。
 * 只记位置和体积，不记任何字段内容。
 */
import { consumeTaskTrace, formatTraceBytes, openTaskTrace, traceFooter, type TaskTraceBase, type TaskTraceKind, type TraceStorage } from './taskTrace';
import { rawSpaceStorage } from './userSpaces';

export { formatTraceBytes };
export const EXPORT_TRACE_KEY = 'sullyos_notice_export_progress_v1';
/** 单条超过这个粗估体积时，打包这一页之前立刻留痕：这类行正是要找的嫌疑。 */
const LARGE_ROW_BYTES = 1024 * 1024;
const KEY_TEXT_LIMIT = 80;

export interface ExportTraceTable {
    space: string; store: string;
    rowsRead: number; total: number; pages: number;
    /** 最近读出的那一页的粗估字节数 */
    pageBytes: number;
    /** 这张表到目前为止最大的一条，主键转成字符串并截断 */
    maxRowBytes: number; maxRowKey?: string;
}
export interface ExportTrace extends TaskTraceBase {
    mode: string; scope: string;
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
    const { trace, save, clear } = openTaskTrace<Omit<ExportTrace, keyof TaskTraceBase>>(EXPORT_TRACE_KEY, {
        mode: options.mode, scope: options.scope, stage: 'read', onDisk: options.onDisk, writtenBytes: 0,
    }, { startedAt: options.startedAt, storage });
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
        clear,
    };
}
export type ExportTraceWriter = ReturnType<typeof createExportTrace>;

const MODE_LABELS: Record<string, string> = { full: '整合备份', text_only: '纯文字备份', media_only: '媒体与美化素材' };
const SCOPE_LABELS: Record<string, string> = { current: '当前用户', all: '所有用户' };

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
    return [...lines, ...traceFooter(trace)].join('\n');
}

export const EXPORT_TRACE_KIND: TaskTraceKind<ExportTrace> = {
    key: EXPORT_TRACE_KEY, title: '上次备份导出没有完成', source: '备份导出',
    advice: '可能是导出途中页面被系统关掉了。请把下方技术详情里的这条日志复制发给开发者，再导出一次前建议先刷新页面。',
    describe: describeExportTrace,
};

/** 启动时调用：有上次没走完的导出留痕就生成日志文本并删掉这个键，同一份只报一次；没有就返回 null。 */
export function consumeExportTrace(storage: TraceStorage | undefined = rawSpaceStorage): { title: string; detail: string } | null {
    const report = consumeTaskTrace(EXPORT_TRACE_KIND, storage);
    return report && { title: report.title, detail: report.detail };
}

/**
 * 启动时把上次没走完的各项长任务留痕一次读出来，每项一条，交给系统调试终端。
 * 中断留痕（taskTrace.ts）读完即删；「导入中」标记只读不删，它的去留归重新导入的提示管。
 */
import { EXPORT_TRACE_KIND } from './backupExportTrace';
import { readImportMarkerReport } from './backupImportPolicy';
import { consumeTaskTrace, STEP_TRACE_KINDS, type TaskTraceReport, type TraceStorage } from './taskTrace';
import { rawSpaceStorage } from './userSpaces';

export const TASK_TRACE_KINDS = [EXPORT_TRACE_KIND, ...STEP_TRACE_KINDS];

/** shared 是不分用户空间的原始 localStorage；space 是当前空间的视图，「导入中」标记按空间存。 */
export function collectStartupTraceReports(storages: { shared?: TraceStorage; space?: Pick<Storage, 'getItem'> } = {}): TaskTraceReport[] {
    const shared = 'shared' in storages ? storages.shared : rawSpaceStorage;
    const reports = TASK_TRACE_KINDS.map(kind => consumeTaskTrace(kind, shared));
    reports.push(readImportMarkerReport(storages.space));
    return reports.filter((report): report is TaskTraceReport => report !== null);
}

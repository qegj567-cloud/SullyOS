/**
 * SullyOS 只恢复自身备份。
 *
 * v1 SullyOS 备份仍是宽松的单根 data.json，不能仅靠扩展名或 ZIP 布局识别来源；
 * 这里拦截已经明确属于旧第三方迁移格式的顶层字段。检查必须在任何数据库写入前完成。
 */
import { trackEvent } from './analytics';
import type { BackupMissingAsset } from './backupMissingAssets';
import { formatTraceBytes, traceFooter, type TaskTraceReport } from './taskTrace';

const UNSUPPORTED_THIRD_PARTY_FIELDS = [
    'vectorMemories',
    'extraLocalStorageConfig',
] as const;

export function assertSupportedSullyBackup(input: unknown): asserts input is Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        trackEvent('拒绝导入第三方备份', { reason: 'invalid_shape' });
        throw new Error('备份内容无效：只支持 SullyOS·糯米机 导出的 ZIP 或 JSON 备份。');
    }

    const record = input as Record<string, unknown>;
    if (UNSUPPORTED_THIRD_PARTY_FIELDS.some(field => Object.prototype.hasOwnProperty.call(record, field))) {
        trackEvent('拒绝导入第三方备份', { reason: 'third_party_field' });
        throw new Error('不支持导入第三方系统备份，请选择由 SullyOS·糯米机 导出的 ZIP 或 JSON 文件。');
    }
}

export const IMPORT_IN_PROGRESS_KEY = 'sullyos_import_in_progress_v1';

/**
 * 「导入中」标记：启动时据此提示重新导入，同时写进系统调试终端（describeImportMarker）。读包、校验阶段的进度更新不落盘，
 * beginWrite（即将写库）那一刻写下第一笔，所以写库前失败不会留下标记，第一次写库之前标记一定已经在。
 * 之后每次进度回调都覆盖写一次「写到哪」：阶段、步骤（多用户恢复的「正在清空 / 正在写入」）、用户 · 表或板块、第几页或第几条。
 * 报错结束时不删，改记 error：库已经写了一半，要靠它提示重新导入。只有成功或迁入失败已回滚干净时才删。
 */
export function createImportProgressMarker(source: string, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage) {
    let startedAt: number | null = null;
    const build = (globalThis as { __APP_BUILD_ID__?: unknown }).__APP_BUILD_ID__;
    const update = (phase: string, fields: Record<string, unknown> = {}) => {
        if (startedAt === null) return;
        try {
            storage.setItem(IMPORT_IN_PROGRESS_KEY, JSON.stringify({ startedAt, updatedAt: Date.now(), phase, source, ...(typeof build === 'string' && build ? { build } : {}), ...fields }));
        } catch { /* ignore */ }
    };
    return {
        beginWrite: (phase = 'database') => {
            if (startedAt !== null) return;
            startedAt = Date.now();
            update(phase);
        },
        update,
        clear: () => {
            startedAt = null;
            try { storage.removeItem(IMPORT_IN_PROGRESS_KEY); } catch { /* ignore */ }
        },
    };
}

export interface ImportProgressMarker {
    startedAt?: number; updatedAt?: number; phase?: string; source?: string; sourceSize?: number; build?: string;
    /** 多用户恢复的步骤，如「正在清空」「正在写入」「正在写入图片」「正在收尾」 */
    stage?: string;
    current?: string; currentFile?: string; currentFileSize?: number;
    assetDone?: number; assetTotal?: number; itemDone?: number; itemTotal?: number;
    error?: string;
}

export const importPhaseLabel = (phase?: string) => {
    switch (phase) {
        case 'parsing': return '解析备份文件';
        case 'assets': return '恢复备份素材';
        case 'database': return '写入数据库';
        case 'settings': return '恢复系统设置';
        case 'error': return '导入报错';
        default: return '导入流程';
    }
};

/** 标记写成日志文本。备份文件名不写进去，只写大小。 */
export function describeImportMarker(marker: ImportProgressMarker): string {
    const lines = [`停在：${importPhaseLabel(marker.phase)}${marker.stage ? ` · ${marker.stage}` : ''}`];
    if (marker.current) lines.push(`当前部分：${marker.current}`);
    if (typeof marker.itemTotal === 'number' && marker.itemTotal > 0) lines.push(`进度：${marker.itemDone || 0} / ${marker.itemTotal}`);
    if (typeof marker.assetTotal === 'number' && marker.assetTotal > 0) lines.push(`素材：${marker.assetDone || 0} / ${marker.assetTotal}`);
    if (marker.currentFile) lines.push(`当前文件：${marker.currentFile}${typeof marker.currentFileSize === 'number' ? ` · ${formatTraceBytes(marker.currentFileSize)}` : ''}`);
    if (typeof marker.sourceSize === 'number') lines.push(`备份文件大小：${formatTraceBytes(marker.sourceSize)}`);
    if (marker.error) lines.push(`报错：${marker.error}`);
    if (typeof marker.startedAt === 'number') lines.push(...traceFooter({ version: 1, startedAt: marker.startedAt, updatedAt: marker.updatedAt ?? marker.startedAt, build: marker.build }));
    return lines.join('\n');
}

/**
 * 启动时读「导入中」标记生成日志，不删：标记的去留归重新导入的提示管，没有重新导入成功之前每次启动都会再报一次。
 */
export function readImportMarkerReport(storage?: Pick<Storage, 'getItem'>): TaskTraceReport | null {
    let text: string | null = null;
    try { text = (storage ?? localStorage).getItem(IMPORT_IN_PROGRESS_KEY); } catch { return null; }
    if (!text) return null;
    let marker: ImportProgressMarker | null = null;
    try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object') marker = parsed; } catch { /* 用下面的兜底句 */ }
    const failed = !!marker?.error;
    return {
        key: IMPORT_IN_PROGRESS_KEY, source: '备份恢复',
        title: failed ? '上次备份恢复失败了' : '上次备份恢复没有完成',
        advice: '数据可能只恢复了一半，请重新导入同一个备份文件。如果再次失败，请把下方技术详情里的这条日志复制发给开发者。',
        detail: marker ? describeImportMarker(marker) : '诊断信息读不出来了。',
    };
}

/**
 * 恢复时跳过的损坏素材清单：恢复写完库立刻刷新页面，清单先存在这里，重启后弹一次提示再清掉。
 * `sullyos_notice_` 前缀的键各用户空间共用（见 userSpaces.ts 的 isSharedSpaceKey）：迁入为新用户后
 * 当前空间换成了新用户，按空间存的键在那边读不到。
 */
export const RESTORE_DAMAGED_ASSETS_KEY = 'sullyos_notice_restore_damaged_assets_v1';
const DAMAGED_ASSETS_KEPT = 200;

export interface RestoreDamagedAssets {
    /** 实际跳过的份数；items 最多留前 200 份，免得撑爆 localStorage */
    total: number;
    items: BackupMissingAsset[];
}

export function saveRestoreDamagedAssets(items: readonly BackupMissingAsset[], storage: Pick<Storage, 'setItem'> = localStorage): void {
    if (!items.length) return;
    try {
        storage.setItem(RESTORE_DAMAGED_ASSETS_KEY, JSON.stringify({ total: items.length, items: items.slice(0, DAMAGED_ASSETS_KEPT) } satisfies RestoreDamagedAssets));
    } catch { /* 存不下就不提示，恢复本身不受影响 */ }
}

export function readRestoreDamagedAssets(storage: Pick<Storage, 'getItem'> = localStorage): RestoreDamagedAssets | null {
    try {
        const parsed = JSON.parse(storage.getItem(RESTORE_DAMAGED_ASSETS_KEY) || 'null');
        if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) return null;
        const items = parsed.items.filter((item: any) => item && typeof item.id === 'string')
            .map((item: any): BackupMissingAsset => ({ id: item.id, locations: [], reason: 'damaged' }));
        return items.length ? { total: Math.max(Number(parsed.total) || 0, items.length), items } : null;
    } catch {
        return null;
    }
}

export function clearRestoreDamagedAssets(storage: Pick<Storage, 'removeItem'> = localStorage): void {
    try { storage.removeItem(RESTORE_DAMAGED_ASSETS_KEY); } catch { /* ignore */ }
}

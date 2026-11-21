/**
 * SullyOS 只恢复自身备份。
 *
 * v1 SullyOS 备份仍是宽松的单根 data.json，不能仅靠扩展名或 ZIP 布局识别来源；
 * 这里拦截已经明确属于旧第三方迁移格式的顶层字段。检查必须在任何数据库写入前完成。
 */
import { trackEvent } from './analytics';
import type { BackupMissingAsset } from './backupMissingAssets';

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
 * 「导入中」标记：启动时据此提示重新导入。读包、校验阶段的进度更新不落盘，
 * beginWrite（即将写库）那一刻写下第一笔，所以写库前失败不会留下标记，第一次写库之前标记一定已经在。
 */
export function createImportProgressMarker(source: string, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage) {
    let startedAt: number | null = null;
    const update = (phase: string, fields: Record<string, unknown> = {}) => {
        if (startedAt === null) return;
        try {
            storage.setItem(IMPORT_IN_PROGRESS_KEY, JSON.stringify({ startedAt, updatedAt: Date.now(), phase, source, ...fields }));
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

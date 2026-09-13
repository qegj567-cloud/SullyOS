/**
 * SullyOS 只恢复自身备份。
 *
 * v1 SullyOS 备份仍是宽松的单根 data.json，不能仅靠扩展名或 ZIP 布局识别来源；
 * 这里拦截已经明确属于旧第三方迁移格式的顶层字段。检查必须在任何数据库写入前完成。
 */
import { trackEvent } from './analytics';

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

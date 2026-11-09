/**
 * 备份偏好：控制「整包备份里带哪些东西」。
 *
 * 手动导出、上传到 GitHub / WebDAV 都经过 OSContext 的 exportSystem，由它在那一处读这份
 * 偏好，各个入口不再自己传开关。以后要按模块细分备份范围，往这里加字段即可。
 *
 * 存在设备级的共享设置里（见 userSpaces 的 sharedKeys），切换用户空间不会变。
 */
export interface BackupPreferences {
    /**
     * 带不带主动消息 2.0 的后端连接（Worker 地址、共享密钥、主密钥、用户 id）。
     * 带上后，拿到备份的人能连上那台 Worker、解开里面的密文，所以默认不带。
     */
    includeBackendConnection: boolean;
}

export const BACKUP_PREFERENCES_KEY = 'os_backup_preferences_v1';

export function readBackupPreferences(): BackupPreferences {
    let stored: any = null;
    try { stored = JSON.parse(localStorage.getItem(BACKUP_PREFERENCES_KEY) || 'null'); } catch { /* 损坏按默认值处理 */ }
    // 只认严格的 true：这一项决定钥匙会不会被打包带走，宁可漏带也不能误带。
    return { includeBackendConnection: stored?.includeBackendConnection === true };
}

export function updateBackupPreferences(patch: Partial<BackupPreferences>): BackupPreferences {
    const next = { ...readBackupPreferences(), ...patch };
    localStorage.setItem(BACKUP_PREFERENCES_KEY, JSON.stringify(next));
    return next;
}

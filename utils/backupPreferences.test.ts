import { afterEach, describe, expect, it } from 'vitest';
import { BACKUP_PREFERENCES_KEY, readBackupPreferences, updateBackupPreferences } from './backupPreferences';
import { isSharedSpaceKey } from './userSpaces';

describe('备份偏好', () => {
    afterEach(() => localStorage.removeItem(BACKUP_PREFERENCES_KEY));

    it('默认不带后端连接', () => {
        expect(readBackupPreferences().includeBackendConnection).toBe(false);
    });

    it('勾上后记住，手动导出和云端备份读到的是同一份', () => {
        updateBackupPreferences({ includeBackendConnection: true });
        expect(readBackupPreferences().includeBackendConnection).toBe(true);
        updateBackupPreferences({ includeBackendConnection: false });
        expect(readBackupPreferences().includeBackendConnection).toBe(false);
    });

    it('存的值损坏或不是严格的 true 时一律当作不带', () => {
        localStorage.setItem(BACKUP_PREFERENCES_KEY, '{oops');
        expect(readBackupPreferences().includeBackendConnection).toBe(false);
        localStorage.setItem(BACKUP_PREFERENCES_KEY, JSON.stringify({ includeBackendConnection: 'true' }));
        expect(readBackupPreferences().includeBackendConnection).toBe(false);
    });

    it('是设备级设置，切换用户空间不变', () => {
        expect(isSharedSpaceKey(BACKUP_PREFERENCES_KEY)).toBe(true);
    });
});

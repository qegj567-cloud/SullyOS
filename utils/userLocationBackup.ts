import { USER_LOCATION_STORAGE_KEY, validateUserLocationConfig, type UserLocationConfig } from './userLocationPrivacy';

/** Saved configuration only. The validator excludes live fixes, lookup results and unknown fields. */
export function exportUserLocationSettings(storage: Pick<Storage, 'getItem'> = localStorage): UserLocationConfig | undefined {
    try {
        const raw = storage.getItem(USER_LOCATION_STORAGE_KEY);
        return raw === null ? undefined : validateUserLocationConfig(JSON.parse(raw));
    } catch {
        throw new Error('真实定位设置无法读取，已停止备份。请到真实定位设置检查并重新保存。');
    }
}

export async function importUserLocationSettings(value: unknown): Promise<void> {
    if (value === undefined) return; // Old archives must preserve the receiving device's configuration.
    const config = validateUserLocationConfig(value);
    const { saveUserLocationConfig } = await import('./userLocation');
    saveUserLocationConfig(config); // Also cancels in-flight lookups and drops the old in-memory place cache.
}

export interface SpaceLocationBackup {
    settings: Omit<UserLocationConfig, 'characterIds'>;
    /** null preserves "all characters" within this space; [] remains nobody. */
    audiences: Record<string, string[] | null>;
}

/** Preflight before any database write. Never broaden a missing or malformed audience to all. */
export function validateSpaceLocationBackup(value: unknown, spaceIds: string[]): SpaceLocationBackup | undefined {
    if (value === undefined) return undefined;
    const input = value as SpaceLocationBackup;
    if (!input || !input.audiences || typeof input.audiences !== 'object' || Array.isArray(input.audiences)
        || Object.keys(input.audiences).some(id => !spaceIds.includes(id))) throw new Error('备份中的真实定位授权范围无效');
    const audiences: SpaceLocationBackup['audiences'] = {};
    let settings: SpaceLocationBackup['settings'] | undefined;
    for (const id of spaceIds) {
        if (!Object.prototype.hasOwnProperty.call(input.audiences, id)) throw new Error('备份缺少用户的真实定位授权范围');
        const audience = input.audiences[id];
        if (audience !== null && !Array.isArray(audience)) throw new Error('备份中的真实定位授权范围无效');
        const { characterIds, ...shared } = validateUserLocationConfig({ ...input.settings, characterIds: audience === null ? undefined : audience });
        audiences[id] = characterIds ?? null;
        settings = shared;
    }
    if (!settings) throw new Error('备份中的真实定位用户范围为空');
    return { settings, audiences };
}

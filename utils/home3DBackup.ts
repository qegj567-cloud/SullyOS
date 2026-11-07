/** Small local preferences only. Keep this module independent of DB/React/3D rendering. */
const options: Record<string, readonly string[]> = {
    'sully-home3d-room-scope': ['floor', 'room'],
    'sully-home3d-wall-view': ['hidden', 'cutaway', 'dollhouse'],
    'sully-home3d-view-mode': ['flat', 'free'],
    'sully-home3d-light-finish': ['on', 'off'],
    'sully-home3d-light-mode': ['auto', 'morning', 'day', 'sunset', 'night'],
    'sully-home3d-quality': ['eco', 'balanced', 'clear'],
    'sully-home3d-furniture-outline': ['on', 'off'],
    'sully-home3d-furniture-style': ['retro', 'original'],
};
const PHOTO_LOOK_KEY = 'sully.home.photo-look-library.v1';
export const HOME3D_LOCAL_KEYS = [...Object.keys(options), PHOTO_LOOK_KEY] as const;

function valid(key: string, value: unknown): value is string {
    if (typeof value !== 'string') return false;
    if (key !== PHOTO_LOOK_KEY) return options[key]?.includes(value) ?? false;
    if (value.length > 256_000) return false;
    try {
        const entries = JSON.parse(value);
        return Array.isArray(entries) && entries.length <= 60 && entries.every(p =>
            p && typeof p.id === 'string' && typeof p.name === 'string' && p.look &&
            ['natural', 'neon', 'dream', 'afterglow', 'watercolor', 'daylight'].includes(p.look.preset) &&
            ([['glow', 0, 3], ['fringe', 0, 1], ['vignette', 0, 1], ['exposure', .5, 1.6]] as const)
                .every(([k, min, max]) => typeof p.look[k] === 'number' && Number.isFinite(p.look[k]) && p.look[k] >= min && p.look[k] <= max));
    } catch { return false; }
}

export function exportHome3DLocal(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of HOME3D_LOCAL_KEYS) {
        const value = localStorage.getItem(key);
        if (valid(key, value)) result[key] = value;
    }
    return result;
}

export function importHome3DLocal(input: unknown): void {
    // Old backups do not contain this section. An explicit empty section restores defaults.
    if (input === undefined) return;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('3D 家园偏好格式不正确');
    const next = input as Record<string, unknown>;
    for (const key of HOME3D_LOCAL_KEYS) {
        if (Object.prototype.hasOwnProperty.call(next, key) && !valid(key, next[key])) throw new Error('3D 家园偏好包含无效配置');
    }
    const previous = HOME3D_LOCAL_KEYS.map(key => localStorage.getItem(key));
    try {
        for (const key of HOME3D_LOCAL_KEYS) {
            if (Object.prototype.hasOwnProperty.call(next, key)) localStorage.setItem(key, next[key] as string);
            else localStorage.removeItem(key);
        }
    } catch (error) {
        HOME3D_LOCAL_KEYS.forEach((key, i) => {
            try { if (previous[i] === null) localStorage.removeItem(key); else localStorage.setItem(key, previous[i]!); } catch { /* storage unavailable */ }
        });
        throw error;
    }
}

/** Device-only data. Never put this object in RealtimeConfig, backups or cloud state. */
export interface UserPrivacyRegion {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    radiusKm: number;
}
export interface UserLocationConfig {
    /** Absent: all characters (legacy); empty: nobody. Device-only. */
    characterIds?: string[];
    enabled: boolean;
    regions: UserPrivacyRegion[];
    provider?: 'basic' | 'amap' | 'geoapify';
    /** Device-only, sent solely to the selected AMap endpoint outside hidden areas. */
    amapKey?: string;
    /** Device-only, sent solely to Geoapify outside hidden areas. */
    geoapifyKey?: string;
}
export interface LocationFix { latitude: number; longitude: number; accuracy: number }
export const USER_LOCATION_STORAGE_KEY = 'os_user_location_privacy_v1';
export const USER_LOCATION_LOOKUP_URL = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
export const GEOAPIFY_LOCATION_ENDPOINT = 'https://api.geoapify.com/v1/geocode/reverse';
export const MAX_PRIVACY_REGIONS = 12;

export function isLocationFix(value: LocationFix): boolean {
    return Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90
        && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180
        && Number.isFinite(value.accuracy) && value.accuracy >= 0;
}

/** Do not silently drop broken circles: that could expose a formerly protected place. */
export function validateUserLocationConfig(value: unknown): UserLocationConfig {
    const input = value as UserLocationConfig | undefined;
    if (!input || typeof input.enabled !== 'boolean' || !Array.isArray(input.regions) || input.regions.length > MAX_PRIVACY_REGIONS) throw new Error('定位设置有问题，请重新保存隐藏地点');
    if (input.provider !== undefined && !['basic', 'amap', 'geoapify'].includes(input.provider)) throw new Error('请选择定位方式');
    if (input.amapKey !== undefined && typeof input.amapKey !== 'string') throw new Error('高德 Key 格式不正确');
    const amapKey = input.amapKey?.trim();
    if (amapKey && !/^[a-zA-Z0-9_-]{1,128}$/.test(amapKey)) throw new Error('高德 Key 格式不正确，请只粘贴 Key');
    if (input.enabled && input.provider === 'amap' && !amapKey) throw new Error('使用高德定位前，请填写高德 Key');
    if (input.geoapifyKey !== undefined && typeof input.geoapifyKey !== 'string') throw new Error('Geoapify Key 格式不正确');
    const geoapifyKey = input.geoapifyKey?.trim();
    if (geoapifyKey && !/^[a-zA-Z0-9_-]{1,128}$/.test(geoapifyKey)) throw new Error('Geoapify Key 格式不正确，请只粘贴 Key');
    if (input.enabled && input.provider === 'geoapify' && !geoapifyKey) throw new Error('使用全球街道定位前，请填写 Geoapify Key');
    if (input.characterIds !== undefined && (!Array.isArray(input.characterIds) || !input.characterIds.every(id => typeof id === 'string' && !!id.trim()))) throw new Error('定位可见角色设置有问题，请重新选择');
    const ids = new Set<string>();
    const regions = input.regions.map(region => {
        if (!region || typeof region.id !== 'string' || !region.id || ids.has(region.id)
            || typeof region.name !== 'string' || !region.name.trim() || region.name.trim().length > 30
            || !isLocationFix({ ...region, accuracy: 0 }) || !Number.isFinite(region.radiusKm)
            || region.radiusKm < 0.1 || region.radiusKm > 100) throw new Error('请给每个隐藏地点起名字、填好位置，并设置隐藏 0.1–100 公里');
        ids.add(region.id);
        return { id: region.id, name: region.name.trim(), latitude: region.latitude, longitude: region.longitude, radiusKm: region.radiusKm };
    });
    return { enabled: input.enabled, regions, ...(input.characterIds !== undefined ? {characterIds: [...new Set(input.characterIds)]} : {}), ...(input.provider ? { provider: input.provider } : {}), ...(amapKey ? { amapKey } : {}), ...(geoapifyKey ? { geoapifyKey } : {}) };
}

export function loadUserLocationConfig(): UserLocationConfig {
    const raw = localStorage.getItem(USER_LOCATION_STORAGE_KEY);
    return raw ? validateUserLocationConfig(JSON.parse(raw)) : { enabled: false, regions: [] };
}

export function locationDistanceMeters(a: Pick<LocationFix, 'latitude' | 'longitude'>, b: Pick<LocationFix, 'latitude' | 'longitude'>): number {
    const radians = (degrees: number) => degrees * Math.PI / 180;
    const lat = radians(b.latitude - a.latitude), lng = radians(b.longitude - a.longitude);
    const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(lng / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Include the accuracy circle at boundaries; ambiguity must hide the position. */
export function matchUserPrivacyRegion(fix: LocationFix, regions: UserPrivacyRegion[]): { region: UserPrivacyRegion; uncertain: boolean } | undefined {
    if (!isLocationFix(fix)) throw new Error('设备没有返回有效定位');
    for (const region of regions) {
        const distance = locationDistanceMeters(fix, region);
        if (distance <= region.radiusKm * 1000 + fix.accuracy) return { region, uncertain: distance > region.radiusKm * 1000 };
    }
}

/** Only these descriptive fields can reach prompts; never coordinates, postcode or plusCode. */
export function userLocationPlaceName(data: any): string {
    if (!['coordinates', 'reverseGeocoding'].includes(data?.lookupSource)) throw new Error('地点服务未返回基于设备坐标的结果');
    const names = [data.countryName, data.principalSubdivision, data.city, data.locality]
        .filter((name): name is string => typeof name === 'string' && !!name.trim())
        .map(name => name.replace(/[\r\n<>]/g, ' ').trim().slice(0, 80));
    const unique = [...new Set(names)];
    if (!unique.length) throw new Error('未查到当前位置的区域名称');
    return unique.join(' · ');
}

/** Used by the fetch interceptor to avoid recording sensitive coordinate URLs. */
export function isUserLocationLookupUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.origin === 'https://api.bigdatacloud.net' && url.pathname === '/data/reverse-geocode-client'
            || url.origin === 'https://api.geoapify.com' && url.pathname === '/v1/geocode/reverse';
    } catch { return false; }
}

/** Missing/invalid recipients never broaden an explicit allowlist. */
export function canCharacterSeeUserLocation(config: UserLocationConfig, charId?: string): boolean {
    return config.enabled && (config.characterIds === undefined || !!charId && config.characterIds.includes(charId));
}

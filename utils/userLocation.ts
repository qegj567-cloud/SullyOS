import { describeDevicePositionError, getCurrentPositionSmart } from './geo';
import { AmapLocationError, parseAmapLocation, queryAmapLocation } from './amapUserLocation';
import { GeoapifyLocationError, parseGeoapifyLocation, queryGeoapifyLocation } from './geoapifyUserLocation';
import {
    isLocationFix, loadUserLocationConfig, canCharacterSeeUserLocation, locationDistanceMeters, matchUserPrivacyRegion,
    userLocationPlaceName, validateUserLocationConfig, USER_LOCATION_LOOKUP_URL, USER_LOCATION_STORAGE_KEY,
    type LocationFix, type UserLocationConfig,
} from './userLocationPrivacy';

export type UserLocationSnapshot = { description: string } & (
    { kind: 'private' | 'place'; location: string; uncertain?: boolean; attribution?: 'geoapify' }
    | { kind: 'unavailable'; failureHint?: string }
);
let pending: Promise<UserLocationSnapshot | null> | undefined;
let revision = 0;
let activeLookup: AbortController | undefined;
// Memory only. Always obtain a fresh device fix and check circles before using this cache.
let placeCache: { fix: LocationFix; place: string; at: number; provider: string } | undefined;

export function saveUserLocationConfig(value: UserLocationConfig): void {
    const config = validateUserLocationConfig(value);
    localStorage.setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify(config));
    revision++;
    activeLookup?.abort();
    placeCache = undefined;
}

function foreground(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function stillAllowed(config: UserLocationConfig, startRevision: number): boolean {
    try {
        return foreground() && startRevision === revision && JSON.stringify(loadUserLocationConfig()) === JSON.stringify(config);
    } catch { return false; }
}

async function locate(): Promise<UserLocationSnapshot | null> {
    let config: UserLocationConfig;
    try { config = loadUserLocationConfig(); }
    catch { return { kind: 'unavailable', description: '隐私区域配置不可读取，本次不提供位置。' }; }
    if (!config.enabled || !foreground()) return null;
    const startRevision = revision;
    let stage: 'device' | 'map' = 'device', mapTimedOut = false;
    try {
        const fix = await getCurrentPositionSmart({ quiet: true, retry: true });
        if (!stillAllowed(config, startRevision)) return null;
        if (!isLocationFix(fix)) throw new Error('定位无效');
        const hit = matchUserPrivacyRegion(fix, config.regions);
        if (hit) return { kind: 'private', location: `${hit.region.name}附近`, uncertain: hit.uncertain, description: hit.uncertain
            ? `现在可能在${hit.region.name}附近，具体地址已隐藏。`
            : `现在在${hit.region.name}附近。` };
        if (fix.accuracy > 1000) return { kind: 'unavailable', description: '设备定位精度不足，本次不提供具体位置。' };
        let place: string;
        const provider = config.provider || 'basic';
        if (placeCache && placeCache.provider === provider && Date.now() - placeCache.at < 5 * 60 * 1000 && locationDistanceMeters(placeCache.fix, fix) < 50) {
            place = placeCache.place;
        } else {
            stage = 'map';
            const controller = new AbortController();
            activeLookup = controller;
            const timeout = setTimeout(() => { mapTimedOut = true; controller.abort(); }, 5000);
            const onVisibility = () => { if (!foreground()) controller.abort(); };
            if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
            try {
                if (provider === 'amap') {
                    const data = await queryAmapLocation(fix, config.amapKey!, controller.signal);
                    if (!stillAllowed(config, startRevision)) return null;
                    place = parseAmapLocation(data);
                } else if (provider === 'geoapify') {
                    const data = await queryGeoapifyLocation(fix, config.geoapifyKey!, controller.signal);
                    if (!stillAllowed(config, startRevision)) return null;
                    place = parseGeoapifyLocation(data);
                } else {
                    const url = new URL(USER_LOCATION_LOOKUP_URL);
                    url.searchParams.set('latitude', String(fix.latitude));
                    url.searchParams.set('longitude', String(fix.longitude));
                    url.searchParams.set('localityLanguage', 'zh');
                    // Fixed direct endpoint. No Worker, proxy, cookies, API key or IP fallback.
                    const response = await fetch(url.href, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
                    if (!response.ok) throw new Error('地点查询失败');
                    const data = await response.json();
                    if (!stillAllowed(config, startRevision)) return null;
                    place = userLocationPlaceName(data);
                }
                placeCache = { fix, place, at: Date.now(), provider };
            } finally {
                clearTimeout(timeout);
                if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
                if (activeLookup === controller) activeLookup = undefined;
            }
        }
        const note = provider !== 'basic'
            ? '设备定位有误差，不代表进入附近店铺，也不能确定楼层。'
            : '只能知道大概地区，不能确定具体建筑或店铺。';
        return stillAllowed(config, startRevision)
            ? { kind: 'place', location: place, description: `现在大约在：${place}。${note}`, ...(provider === 'geoapify' ? {attribution:'geoapify' as const} : {}) } : null;
    } catch (error) {
        // Browser/provider errors can contain coordinates. Do not log or persist the raw error.
        const providerName = config.provider === 'amap' ? '高德' : config.provider === 'geoapify' ? 'Geoapify' : '地区';
        const failureHint = stage === 'device'
            ? `${describeDevicePositionError(error)}还没有查询地图。`
            : mapTimedOut ? `${providerName}地点查询超时，请检查网络后重试。`
            : error instanceof AmapLocationError || error instanceof GeoapifyLocationError ? error.message
            : `${providerName}地点查询未成功，请检查网络或稍后重试。`;
        return stillAllowed(config, startRevision) ? { kind: 'unavailable', failureHint,
            description: '本次定位或地点查询未成功，当前位置未知。' } : null;
    }
}

export async function refreshUserLocation(): Promise<UserLocationSnapshot | null> {
    if (!pending) {
        const request = locate();
        pending = request;
        void request.finally(() => { if (pending === request) pending = undefined; });
    }
    return pending;
}

function renderUserLocationContext(snapshot: UserLocationSnapshot | null, userName?: string): string {
    if (!snapshot) return '';
    const name = userName?.trim() || '对方';
    const location = snapshot.kind === 'unavailable' ? '未知' : `${snapshot.uncertain ? '可能' : ''}在${snapshot.location}`;
    const attribution = snapshot.kind !== 'unavailable' && snapshot.attribution === 'geoapify' ? '\n地图数据：Geoapify / OpenStreetMap contributors。' : '';
    return `\n### ${name}当前的位置\n${name}现在的定位${location}，作为辅助参考背景信息，具体以${name}的说明为准。${attribution}\n`;
}

export async function getUserLocationContext(userName?: string, charId?: string): Promise<string> {
    try {
        if (!canCharacterSeeUserLocation(loadUserLocationConfig(), charId)) return '';
        const snapshot = await refreshUserLocation();
        // Selection may have changed while the device/provider was answering.
        return canCharacterSeeUserLocation(loadUserLocationConfig(), charId) ? renderUserLocationContext(snapshot, userName) : '';
    } catch { return ''; }
}

/** Scheduled cloud messages cannot read the device. Never freeze a current fix in a template. */
export function getBackgroundUserLocationContext(userName?: string, charId?: string): string {
    try {
        return canCharacterSeeUserLocation(loadUserLocationConfig(), charId)
            ? renderUserLocationContext({ kind: 'unavailable', description: '' }, userName) : '';
    } catch { return ''; }
}

/** Preview shares one lookup with the prompt, but provider diagnostics stay in UI. */
export async function getUserLocationPreview(userName?: string): Promise<{ context: string; failureHint?: string; attribution?: 'geoapify' }> {
    const snapshot = await refreshUserLocation();
    return { context: renderUserLocationContext(snapshot, userName), ...(snapshot?.kind === 'place' && snapshot.attribution ? {attribution:snapshot.attribution} : {}),
        failureHint: snapshot?.kind === 'unavailable' ? snapshot.failureHint || snapshot.description : undefined };
}

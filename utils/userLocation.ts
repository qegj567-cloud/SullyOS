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
const CONVERSATION_LOCATION_TIMEOUT_MS = 5000;
type LocationRequestMode = 'conversation' | 'preview' | 'manual';
const pending = new Map<LocationRequestMode, Promise<UserLocationSnapshot | null>>();
const activeRequests = new Set<AbortController>();
let revision = 0;
// Memory only. Always obtain a fresh device fix and check circles before using this cache.
let placeCache: { fix: LocationFix; place: string; at: number; provider: string } | undefined;

export function saveUserLocationConfig(value: UserLocationConfig): void {
    const config = validateUserLocationConfig(value);
    localStorage.setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify(config));
    invalidateUserLocationContext();
}

/** Call after restoring shared settings and per-space audiences without rewriting either. */
export function invalidateUserLocationContext(): void {
    revision++;
    pins.clear(); manual.clear(); notifyPins();
    for (const controller of activeRequests) controller.abort();
    pending.clear();
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

async function locate(signal: AbortSignal, deadline: number, force: boolean): Promise<UserLocationSnapshot | null> {
    let config: UserLocationConfig;
    try { config = loadUserLocationConfig(); }
    catch { return { kind: 'unavailable', description: '隐私区域配置不可读取，本次不提供位置。' }; }
    if (!config.enabled || !foreground() || signal.aborted) return null;
    const startRevision = revision;
    const allowed = () => !signal.aborted && Date.now() < deadline && stillAllowed(config, startRevision);
    let stage: 'device' | 'map' = 'device', mapTimedOut = false;
    try {
        const fix = await getCurrentPositionSmart({ quiet: true, retry: true, signal });
        if (!allowed()) return null;
        if (!isLocationFix(fix)) throw new Error('定位无效');
        const hit = matchUserPrivacyRegion(fix, config.regions);
        if (hit) return { kind: 'private', location: `${hit.region.name}附近`, uncertain: hit.uncertain, description: hit.uncertain
            ? `现在可能在${hit.region.name}附近，具体地址已隐藏。`
            : `现在在${hit.region.name}附近。` };
        if (fix.accuracy > 1000) return { kind: 'unavailable', description: '设备定位精度不足，本次不提供具体位置。' };
        let place: string;
        const provider = config.provider || 'basic';
        if (!force && placeCache && placeCache.provider === provider && Date.now() - placeCache.at < (config.cacheMinutes ?? 10) * 60000 && locationDistanceMeters(placeCache.fix, fix) < 50) {
            place = placeCache.place;
        } else {
            stage = 'map';
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            signal.addEventListener('abort', onAbort, { once: true });
            const timeout = setTimeout(() => { mapTimedOut = true; controller.abort(); }, 5000);
            try {
                if (provider === 'amap') {
                    const data = await queryAmapLocation(fix, config.amapKey!, controller.signal);
                    if (!allowed()) return null;
                    place = parseAmapLocation(data);
                } else if (provider === 'geoapify') {
                    const data = await queryGeoapifyLocation(fix, config.geoapifyKey!, controller.signal);
                    if (!allowed()) return null;
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
                    if (!allowed()) return null;
                    place = userLocationPlaceName(data);
                }
                if (config.cacheMinutes !== 0) placeCache = { fix, place, at: Date.now(), provider };
            } finally {
                clearTimeout(timeout);
                signal.removeEventListener('abort', onAbort);
            }
        }
        const note = provider !== 'basic'
            ? '设备定位有误差，不代表进入附近店铺，也不能确定楼层。'
            : '只能知道大概地区，不能确定具体建筑或店铺。';
        return allowed()
            ? { kind: 'place', location: place, description: `现在大约在：${place}。${note}`, ...(provider === 'geoapify' ? {attribution:'geoapify' as const} : {}) } : null;
    } catch (error) {
        // Browser/provider errors can contain coordinates. Do not log or persist the raw error.
        const providerName = config.provider === 'amap' ? '高德' : config.provider === 'geoapify' ? 'Geoapify' : '地区';
        const failureHint = stage === 'device'
            ? `${describeDevicePositionError(error)}还没有查询地图。`
            : mapTimedOut ? `${providerName}地点查询超时，请检查网络后重试。`
            : error instanceof AmapLocationError || error instanceof GeoapifyLocationError ? error.message
            : `${providerName}地点查询未成功，请检查网络或稍后重试。`;
        return allowed() ? { kind: 'unavailable', failureHint,
            description: '本次定位或地点查询未成功，当前位置未知。' } : null;
    }
}

export async function refreshUserLocation(mode: LocationRequestMode = 'preview'): Promise<UserLocationSnapshot | null> {
    const existing = pending.get(mode);
    if (existing) return existing;
    // Preview keeps the full device retry budget. A conversation never joins a
    // slow preview, and concurrent conversation callers share the same deadline.
    const controller = new AbortController();
    const deadline = mode === 'conversation' ? Date.now() + CONVERSATION_LOCATION_TIMEOUT_MS : Infinity;
    activeRequests.add(controller);
    const request = new Promise<UserLocationSnapshot | null>(resolve => {
        let settled = false;
        const timer = mode === 'conversation'
            ? setTimeout(() => controller.abort(), CONVERSATION_LOCATION_TIMEOUT_MS) : undefined;
        const onVisibility = () => { if (!foreground()) controller.abort(); };
        const finish = (snapshot: UserLocationSnapshot | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', onAbort);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
            activeRequests.delete(controller);
            resolve(snapshot);
        };
        const onAbort = () => finish(null);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        // Release the caller even if a native/provider implementation ignores abort.
        // locate also checks cancellation before queries and before caching results.
        void locate(controller.signal, deadline, mode === 'manual').then(finish, () => finish(null));
    });
    pending.set(mode, request);
    void request.finally(() => { if (pending.get(mode) === request) pending.delete(mode); });
    return request;
}

function renderUserLocationContext(snapshot: UserLocationSnapshot | null, userName?: string): string {
    if (!snapshot) return '';
    const name = userName?.trim() || '对方';
    const location = snapshot.kind === 'unavailable' ? '未知' : `${snapshot.uncertain ? '可能' : ''}在${snapshot.location}`;
    const attribution = snapshot.kind !== 'unavailable' && snapshot.attribution === 'geoapify' ? '\n地图数据：Geoapify / OpenStreetMap contributors。' : '';
    return `\n### ${name}当前的位置\n${name}现在的定位${location}，作为辅助参考背景信息，具体以${name}的说明为准。${attribution}\n`;
}

type PinState = { snapshot?: UserLocationSnapshot | null };
const pins = new Map<string, PinState>();
const listeners = new Set<() => void>();
const manual = new Map<string, { snapshot: UserLocationSnapshot; config: string }>();
export const readLocationPin = (id: string) => pins.get(id);
export function subscribeLocationPin(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function notifyPins() { listeners.forEach(listener => listener()); }
export function clearLocationPin(id: string) { if (pins.delete(id)) notifyPins(); }
export async function refreshChatLocation(id: string) {
    if (!canCharacterSeeUserLocation(loadUserLocationConfig(), id)) return;
    manual.delete(id);
    const start = revision;
    const snapshot = await refreshUserLocation('manual');
    if (start !== revision || !canCharacterSeeUserLocation(loadUserLocationConfig(), id)) return;
    if (snapshot && snapshot.kind !== 'unavailable') manual.set(id, {snapshot, config: JSON.stringify(loadUserLocationConfig())});
    return snapshot;
}

export async function getUserLocationContext(userName?: string, charId?: string, chat = false): Promise<string> {
    try {
        if (!canCharacterSeeUserLocation(loadUserLocationConfig(), charId)) return '';
        const pin = {};
        if (chat && charId) { pins.set(charId, pin); notifyPins(); }
        const selected = chat && charId ? manual.get(charId) : undefined;
        if (chat && charId) manual.delete(charId);
        const snapshot = selected && selected.config === JSON.stringify(loadUserLocationConfig())
            ? selected.snapshot : await refreshUserLocation('conversation');
        if (chat && charId && pins.get(charId) === pin) {
            pins.set(charId, { snapshot }); notifyPins();
        }
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

/** Explicit previews keep full device retries; provider diagnostics stay in UI. */
export async function getUserLocationPreview(userName?: string): Promise<{ context: string; failureHint?: string; attribution?: 'geoapify' }> {
    const snapshot = await refreshUserLocation();
    return { context: renderUserLocationContext(snapshot, userName), ...(snapshot?.kind === 'place' && snapshot.attribution ? {attribution:snapshot.attribution} : {}),
        failureHint: snapshot?.kind === 'unavailable' ? snapshot.failureHint || snapshot.description : undefined };
}

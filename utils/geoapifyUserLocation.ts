import {GEOAPIFY_LOCATION_ENDPOINT, isLocationFix, type LocationFix} from './userLocationPrivacy';

const failures = {
    key: 'Geoapify Key 无效或访问限制不匹配，请检查 Key 与网站 Origin 设置。',
    quota: 'Geoapify 查询额度或频率已超限，请稍后重试。',
    empty: 'Geoapify 没有返回可用地址，请稍后重试。',
    network: 'Geoapify 地点查询失败，请检查网络后重试。',
    response: 'Geoapify 没有返回有效地点，请检查 Key 或稍后重试。',
};
export class GeoapifyLocationError extends Error {
    constructor(public readonly kind: keyof typeof failures) { super(failures[kind]); }
}
export function buildGeoapifyLocationUrl(fix: LocationFix, key: string): string {
    if (!isLocationFix(fix) || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new GeoapifyLocationError('key');
    const url = new URL(GEOAPIFY_LOCATION_ENDPOINT);
    url.searchParams.set('lat', String(fix.latitude));
    url.searchParams.set('lon', String(fix.longitude));
    url.searchParams.set('lang', 'zh');
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('apiKey', key);
    return url.href;
}
/** Direct browser CORS request. Never use an app Worker, proxy or map SDK. */
export async function queryGeoapifyLocation(fix: LocationFix, key: string, signal: AbortSignal): Promise<unknown> {
    const url = buildGeoapifyLocationUrl(fix, key);
    if (signal.aborted) throw new GeoapifyLocationError('network');
    try {
        const response = await fetch(url, {signal, credentials:'omit', referrerPolicy:'no-referrer', cache:'no-store'});
        if (response.status === 401 || response.status === 403) throw new GeoapifyLocationError('key');
        if (response.status === 429) throw new GeoapifyLocationError('quota');
        if (!response.ok) throw new GeoapifyLocationError('response');
        return await response.json();
    } catch (error) {
        if (error instanceof GeoapifyLocationError) throw error;
        throw new GeoapifyLocationError('network');
    }
}
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/[\r\n<>]/g,' ').trim().slice(0,100) : '';
/** Build from address words only; never forward coordinates, IDs, postcodes or the full response. */
export function parseGeoapifyLocation(data: any): string {
    const place = Array.isArray(data?.results) ? data.results[0] : undefined;
    if (!place || typeof place !== 'object') throw new GeoapifyLocationError('empty');
    const names = [place.country, place.state, place.city || place.town || place.village, place.district, place.suburb, place.street, place.housenumber, place.name]
        .map(text).filter(Boolean);
    if (!names.length) throw new GeoapifyLocationError('empty');
    return [...new Set(names)].join(' · ');
}

import { isLocationFix, type LocationFix } from './userLocationPrivacy';
import { wgs84ToAmap } from './amapCoordinates';

export const AMAP_LOCATION_ENDPOINT = 'https://restapi.amap.com/v3/geocode/regeo';
export const AMAP_LOCATION_CALLBACK = '__sullyUserLocation';

const AMAP_FAILURE_HINTS = {
    key: '高德 Key 无效、过期或已删除，请重新复制有效的 Key。',
    platform: '高德 Key 类型不匹配，请申请「Web服务」Key，不能用「Web端 JS API」。',
    restricted: '高德 Key 的访问限制或签名设置阻止了查询，请到高德控制台检查。',
    permission: '这个高德 Key 没有该接口的权限，请到高德控制台检查 Web服务权限。',
    quota: '高德查询次数或频率已超限，请稍后重试，或到高德控制台检查额度。',
    empty: '高德没有返回可用地址，请稍后重试。',
    network: '高德地点查询失败，请检查网络后重试。',
    response: '高德没有返回有效地点，请检查 Key 或稍后重试。',
};
export class AmapLocationError extends Error {
    constructor(public readonly reason: keyof typeof AMAP_FAILURE_HINTS) { super(AMAP_FAILURE_HINTS[reason]); }
}

function amapResponseError(data: any): AmapLocationError {
    const code = String(data?.infocode);
    if (['10001', '10013'].includes(code)) return new AmapLocationError('key');
    if (code === '10009') return new AmapLocationError('platform');
    if (['10005', '10006', '10007', '10008'].includes(code)) return new AmapLocationError('restricted');
    if (['10002', '10012'].includes(code)) return new AmapLocationError('permission');
    if (['10003', '10004', '10010', '10014'].includes(code)) return new AmapLocationError('quota');
    return new AmapLocationError('response');
}

export function buildAmapLocationUrl(fix: LocationFix, key: string): string {
    if (!isLocationFix(fix) || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new Error('高德定位参数无效');
    const [longitude, latitude] = wgs84ToAmap(fix.longitude, fix.latitude);
    const url = new URL(AMAP_LOCATION_ENDPOINT);
    url.searchParams.set('key', key);
    url.searchParams.set('location', `${longitude.toFixed(6)},${latitude.toFixed(6)}`);
    url.searchParams.set('extensions', 'all');
    url.searchParams.set('radius', '300');
    url.searchParams.set('output', 'JSON');
    url.searchParams.set('callback', AMAP_LOCATION_CALLBACK);
    return url.href;
}

/** AMap's supported callback response avoids fetch CORS; it runs in an opaque,
 * isolated frame so provider scripts cannot read the app or its saved home point. */
export function queryAmapLocation(fix: LocationFix, key: string, signal: AbortSignal): Promise<unknown> {
    const url = buildAmapLocationUrl(fix, key);
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('定位查询已取消')); return; }
        const frame = document.createElement('iframe');
        frame.hidden = true;
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.referrerPolicy = 'no-referrer';
        frame.title = '地点查询';
        const token = crypto.randomUUID();
        const cleanup = () => {
            window.removeEventListener('message', receive);
            signal.removeEventListener('abort', abort);
            frame.remove();
        };
        const abort = () => { cleanup(); reject(new Error('定位查询已取消')); };
        const receive = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.data?.token !== token) return;
            cleanup();
            if (event.data.error) reject(new AmapLocationError('network'));
            else resolve(event.data.result);
        };
        window.addEventListener('message', receive);
        signal.addEventListener('abort', abort, { once: true });
        const encode = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
        frame.srcdoc = `<!doctype html><html><head><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://restapi.amap.com; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'"></head><body><script>
            const token=${encode(token)};
            window.${AMAP_LOCATION_CALLBACK}=result=>parent.postMessage({token,result},'*');
            const script=document.createElement('script');
            script.referrerPolicy='no-referrer';
            script.src=${encode(url)};
            script.onerror=()=>parent.postMessage({token,error:true},'*');
            document.body.appendChild(script);
        <\/script></body></html>`;
        try { document.body.appendChild(frame); }
        catch { cleanup(); reject(new Error('当前环境无法查询高德地点')); }
    });
}

const placeText = (value: unknown): string => typeof value === 'string' ? value.replace(/[\r\n<>]/g, ' ').trim().slice(0, 240) : '';

export function parseAmapLocation(data: any): string {
    if (String(data?.status) !== '1' || !data.regeocode) throw amapResponseError(data);
    const geo = data.regeocode;
    const address = placeText(geo.formatted_address) || [...new Set([
        geo.addressComponent?.province, geo.addressComponent?.city, geo.addressComponent?.district,
        geo.addressComponent?.township, geo.addressComponent?.streetNumber?.street, geo.addressComponent?.streetNumber?.number,
    ].map(placeText).filter(Boolean))].join('');
    if (!address) throw new AmapLocationError('empty');
    const nearest = Array.isArray(geo.pois) ? geo.pois
        .filter((poi: any) => placeText(poi?.name) && (typeof poi.distance === 'number' || typeof poi.distance === 'string') && String(poi.distance).trim() !== '' && Number.isFinite(Number(poi.distance)) && Number(poi.distance) >= 0 && Number(poi.distance) <= 100)
        .sort((a: any, b: any) => Number(a.distance) - Number(b.distance))[0] : undefined;
    return `${address}${nearest && !address.includes(placeText(nearest.name)) ? `；附近地点：${placeText(nearest.name)}` : ''}`;
}

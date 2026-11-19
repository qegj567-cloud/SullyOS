import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import UserLocationSettings, { USER_LOCATION_PAGE_TITLES, getUserLocationParentPage, type UserLocationSettingsPage } from '../../components/settings/UserLocationSettings';
import { saveUserLocationConfig, getUserLocationContext } from '../../utils/userLocation';
import type { UserLocationConfig } from '../../utils/userLocationPrivacy';
import UserLocationNotice from '../../components/os/UserLocationNotice';
import { ChatLocationPin } from '../../components/chat/ChatLocationPin';

if (location.port !== '5192') throw new Error('仅在独立验收端口 5192 使用模拟定位');
if (new URLSearchParams(location.search).has('chat')) {
    const settings = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
        getItem: (key: string) => settings.get(key) ?? null,
        setItem: (key: string, value: string) => settings.set(key, value),
    } });
}
const originalFetch = window.fetch.bind(window);
const originalGeo = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
const originalCreateElement = document.createElement.bind(document);
let outside = false, deny = false, highAccuracyTimeout = false, alwaysTimeout = false, mapRequests = 0;
// Exercise the actual sandbox callback transport using a same-origin mock script.
// The real AMap endpoint, real GPS and real Key never leave this fixture.
document.createElement = ((name: string, options?: ElementCreationOptions) => {
    const element = originalCreateElement(name, options);
    if (name === 'iframe') {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
        Object.defineProperty(element, 'srcdoc', {
            get() { return descriptor.get!.call(element); },
            set(markup: string) {
                if (markup.includes('https://restapi.amap.com/v3/geocode/regeo')) {
                    mapRequests++;
                    markup = markup.replaceAll('https://restapi.amap.com', location.origin)
                        .replace('/v3/geocode/regeo?', '/test/fixtures/amap-user-location-mock.js?');
                }
                descriptor.set!.call(element, markup);
            },
        });
    }
    return element;
}) as typeof document.createElement;
Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(success: (position: any) => void, failure: (error: any) => void, options?: PositionOptions) {
        if (deny) failure({ code: 1, message: '模拟权限拒绝' });
        else if (alwaysTimeout || (highAccuracyTimeout && options?.enableHighAccuracy)) failure({ code: 3, message: '模拟设备超时' });
        else success({ coords: outside ? { latitude: 30, longitude: 120, accuracy: 15 } : { latitude: 31.2304, longitude: 121.4737, accuracy: 10 } });
    },
} });
window.fetch = async (input, init) => {
    if (String(input).startsWith('https://api.geoapify.com/v1/geocode/reverse')) {
        mapRequests++;
        return new Response(JSON.stringify({results:[{country:'United Kingdom',city:'London',street:'Oxford Street',housenumber:'12',lat:30,lon:120,postcode:'SHOULD-NOT-APPEAR'}]}),{headers:{'Content-Type':'application/json'}});
    }
    if (!String(input).startsWith('https://api.bigdatacloud.net/data/reverse-geocode-client')) return originalFetch(input, init);
    mapRequests++;
    return new Response(JSON.stringify({ lookupSource: 'coordinates', countryName: '中国', principalSubdivision: '浙江省', city: '演示市', locality: '演示镇', latitude: 30, longitude: 120, plusCode: 'SHOULD-NOT-APPEAR' }), { headers: { 'Content-Type': 'application/json' } });
};
function App() {
    const [value, setValue] = useState<UserLocationConfig>({ enabled: false, regions: [] });
    const [page, setPage] = useState<UserLocationSettingsPage>('main');
    const [report, setReport] = useState('仅模拟设备定位及地图响应，不请求真实坐标或真实地图服务。');
    const save = () => { try { saveUserLocationConfig(value); return true; } catch (error: any) { setReport(error.message); return false; } };
    const inspect = async () => { if (!save()) return; const before = mapRequests; const text = await getUserLocationContext('小雨'); setReport(`本次地图请求次数：${mapRequests - before}（累计 ${mapRequests} 次）\n\n实际位置提示词：\n${text || '（未启用，无位置文字）'}`); };
    return <div className="qa-layout"><main className="qa-phone"><h1 className="mb-4 text-lg font-bold">{USER_LOCATION_PAGE_TITLES[page]}</h1><UserLocationSettings value={value} onChange={setValue} onSave={save} page={page} onNavigate={setPage} userName="小雨" /><button onClick={() => { if (save()) { setReport('本机配置已保存。'); setPage(getUserLocationParentPage(page)); } }} className="mt-4 min-h-11 w-full rounded-2xl bg-violet-600 text-white">{page === 'main' ? '保存配置' : '保存并返回'}</button></main><aside className="qa-report"><h2 className="mb-4 text-lg font-bold">隐私验收 · 模拟数据</h2><div className="flex flex-wrap gap-2">{[
        ['模拟在家', () => { outside = false; deny = highAccuracyTimeout = alwaysTimeout = false; }], ['模拟区域外', () => { outside = true; deny = highAccuracyTimeout = alwaysTimeout = false; }], ['模拟权限拒绝', () => { deny = true; }],
        ['模拟高精度超时后成功', () => { outside = true; deny = alwaysTimeout = false; highAccuracyTimeout = true; }], ['模拟持续定位超时', () => { deny = false; alwaysTimeout = true; }],
    ].map(([label, action]) => <button key={String(label)} className="min-h-11 rounded-xl bg-white px-3" onClick={() => { (action as () => void)(); setReport(String(label)); }}>{String(label)}</button>)}<button className="min-h-11 rounded-xl bg-sky-700 px-3 text-white" onClick={() => void inspect()}>检查实际位置提示词</button></div><pre className="mt-5 whitespace-pre-wrap break-words text-xs leading-6" role="status">{report}</pre></aside></div>;
}
function ChatPinDemo() {
    const [phase, setPhase] = useState<'ready' | 'reply' | 'done'>('ready');
    const send = async () => {
        setPhase('reply');
        // On the phone's HTTP LAN URL only the simulated GPS below is used.
        Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
        Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
            getCurrentPosition(success: PositionCallback) {
                setTimeout(() => success({ coords: { latitude: 30, longitude: 120, accuracy: 10 } } as GeolocationPosition), 1800);
            },
        } });
        if (phase === 'ready') saveUserLocationConfig({ enabled: true, regions: [{id:'demo',name:'图书馆',latitude:30,longitude:120,radiusKm:1}] });
        await getUserLocationContext('小雨', 'pin-demo', true);
    };
    return <main className="mx-auto max-w-md min-h-screen bg-slate-50 p-5"><h1 className="font-bold">聊天定位预览</h1>
        <p className="my-3 text-xs text-slate-500">使用模拟位置。可手动结束回复，方便查看大头针详情。</p>
        {phase !== 'ready' && <div className="mt-10 flex justify-end gap-3"><span className="rounded-xl bg-white p-3">我到啦</span><div className="relative grid h-10 w-10 place-items-center rounded-full bg-sky-100">雨{phase === 'reply' && <ChatLocationPin charId="pin-demo" />}</div></div>}
        {phase === 'done' && <p className="mt-10">好，我在门口等你。</p>}
        <button className="mt-20 rounded-xl bg-sky-700 px-4 py-3 text-white" onClick={() => phase === 'reply' ? setPhase('done') : void send()}>{phase === 'reply' ? '结束模拟回复' : '发送测试消息'}</button>
    </main>;
}
function Preview() {
    const [notice, setNotice] = useState(new URLSearchParams(location.search).has('notice'));
    if (new URLSearchParams(location.search).has('chat')) return <ChatPinDemo />;
    return <><App />{notice && <UserLocationNotice onDone={() => setNotice(false)} onConfigure={() => setNotice(false)} />}</>;
}
const root = createRoot(document.getElementById('root')!); if (new URLSearchParams(location.search).has('fullscreen')) {
    const [{default: Settings}, {OSProvider}, {requestSettingsFocus}] = await Promise.all([
        import('../../apps/Settings'), import('../../context/OSContext'), import('../../utils/settingsNavigation'),
    ]);
    requestSettingsFocus('location');
    root.render(<OSProvider><Settings /></OSProvider>);
} else root.render(<Preview />);
import.meta.hot?.dispose(() => {
    root.unmount(); window.fetch = originalFetch;
    document.createElement = originalCreateElement;
    if (originalGeo) Object.defineProperty(navigator, 'geolocation', originalGeo);
    else delete (navigator as any).geolocation;
});

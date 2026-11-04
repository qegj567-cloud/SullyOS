import {CharacterLocationAudience} from './CharacterAwarenessSettings';
import type {CharacterProfile} from '../../types';
import React, { useEffect, useState } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { describeDevicePositionError, getCurrentPositionSmart } from '../../utils/geo';
import { getUserLocationPreview } from '../../utils/userLocation';
import { MAX_PRIVACY_REGIONS, type UserLocationConfig, type UserPrivacyRegion } from '../../utils/userLocationPrivacy';

export type UserLocationSettingsPage = 'characters' | 'main' | 'location' | 'regions' | 'amap' | 'geoapify' | 'about';
export const USER_LOCATION_PAGE_TITLES: Record<UserLocationSettingsPage, string> = {
    characters: '定位可见角色', main: '实时感知配置', location: '真实定位', regions: '隐藏地点', amap: '高德 API', geoapify: '全球街道 · Geoapify', about: '定位说明',
};
export const getUserLocationParentPage = (page: UserLocationSettingsPage): UserLocationSettingsPage =>
    page === 'location' || page === 'main' ? 'main' : 'location';

export default function UserLocationSettings({ value, onChange, onSave, page, onNavigate, onBusyChange, userName, characters = [] }: {
    value: UserLocationConfig; onChange: (config: UserLocationConfig) => void; onSave: () => boolean;
    page: UserLocationSettingsPage; onNavigate: (page: UserLocationSettingsPage) => void;
    onBusyChange?: (busy: boolean) => void;
    userName?: string; characters?: Pick<CharacterProfile, 'id'|'name'|'avatar'>[];
}) {
    const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const [previewText, setPreviewText] = useState('');
    const [previewSource, setPreviewSource] = useState<'geoapify'>();
    const [failureHint, setFailureHint] = useState(''), [showKey, setShowKey] = useState(false);
    useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
    useEffect(() => { setMessage(''); setShowKey(false); }, [page]);
    useEffect(() => { setPreviewText(''); setFailureHint(''); setPreviewSource(undefined); }, [value, userName]);
    useLocalBackHandler(() => {
        if (busy) return true;
        if (page === 'main') return false;
        onNavigate(getUserLocationParentPage(page)); return true;
    }, 40);
    const updateRegion = (id: string, patch: Partial<UserPrivacyRegion>) => onChange({ ...value, regions: value.regions.map(region => region.id === id ? { ...region, ...patch } : region) });
    const addCurrentRegion = async () => {
        if (busy || value.regions.length >= MAX_PRIVACY_REGIONS) return;
        setBusy(true); setMessage('正在记录这里的位置，不会发给地图或角色。');
        try {
            const fix = await getCurrentPositionSmart({ quiet: true, retry: true });
            if (!Number.isFinite(fix.accuracy) || fix.accuracy > 1000) {
                setMessage('当前位置精度不足，先不记录隐藏地点，以免把家或公司记到错误位置。请到窗边重试，或在下方手动填写。');
                return;
            }
            onChange({ ...value, regions: [...value.regions, { id: crypto.randomUUID(), name: value.regions.length ? '隐藏地点' : '家', latitude: fix.latitude, longitude: fix.longitude, radiusKm: 3 }] });
            setMessage('已记住这里。给它起个名字，选好隐藏几公里，再保存。');
        } catch (error) { setMessage(describeDevicePositionError(error)); }
        finally { setBusy(false); }
    };
    const preview = async () => {
        if (busy || !onSave()) return;
        setBusy(true); setPreviewText(''); setFailureHint(''); setPreviewSource(undefined); setMessage('正在定位…');
        try {
            const result = await getUserLocationPreview(userName);
            setPreviewText(result.context); setFailureHint(result.failureHint || '');
            setPreviewSource(result.attribution);
            setMessage(result.context ? '' : '真实定位已关闭，或页面已进入后台。');
        } catch { setMessage('本次未取得位置，请稍后重试。'); }
        finally { setBusy(false); }
    };
    const addManual = () => onChange({ ...value, regions: [...value.regions, { id: crypto.randomUUID(), name: '隐藏地点', latitude: NaN, longitude: NaN, radiusKm: 3 }] });
    const pageLink = (target: UserLocationSettingsPage, title: string, detail: string) => <button type="button" disabled={busy} onClick={() => onNavigate(target)} className="flex min-h-14 w-full items-center justify-between gap-3 border-b border-sky-100 py-3 text-left disabled:opacity-40"><span><span className="block text-xs font-bold text-slate-700">{title}</span><span className="mt-1 block text-[11px] text-slate-500">{detail}</span></span><span aria-hidden="true" className="text-xl text-sky-600">›</span></button>;
    return <section className="space-y-3 rounded-2xl bg-sky-50/60 p-4">
        {page !== 'main' && <button type="button" disabled={busy} onClick={() => onNavigate(getUserLocationParentPage(page))} className="min-h-11 text-xs text-sky-700 disabled:opacity-40">{page === 'location' ? '‹ 返回实时感知' : '‹ 返回真实定位'}</button>}
        {(page === 'main' || page === 'location') && <label className="flex items-center justify-between gap-3"><span className="text-sm font-bold text-sky-800">真实定位</span><input aria-label="开启真实定位" type="checkbox" checked={value.enabled} disabled={busy} onChange={event => onChange({ ...value, enabled: event.target.checked })} className="h-5 w-5 accent-sky-600" /></label>}
        {page === 'main' && <button type="button" disabled={busy} onClick={() => onNavigate('location')} className="flex min-h-11 w-full items-center justify-between gap-3 text-left text-xs text-sky-700 disabled:opacity-40"><span>设置与预览</span><span aria-hidden="true" className="text-xl">›</span></button>}
        {page === 'location' && <>
        <label className="block text-xs font-bold text-slate-700">定位方式<select aria-label="定位方式" value={value.provider || 'basic'} disabled={busy} onChange={event => { const provider = event.target.value as NonNullable<UserLocationConfig['provider']>; setMessage(''); onChange({ ...value, provider }); if (provider === 'amap' || provider === 'geoapify') onNavigate(provider); }} className="mt-2 w-full rounded-xl border border-sky-200 bg-white p-3 text-xs"><option value="basic">免费 · 全球大概地区，不用填 Key</option><option value="amap">高德 · 街道和附近地点，需要填 Key</option><option value="geoapify">全球 · 街道地址，Geoapify 免费 Key</option></select></label>
        <nav aria-label="真实定位设置">
            {pageLink('characters', '可见角色', value.characterIds === undefined ? '所有角色可见 · 点击单独授权' : `仅选中的 ${characters.filter(c=>value.characterIds?.includes(c.id)).length} 位角色可见`)}
            {pageLink('regions', '隐藏地点', value.regions.length ? `已设置 ${value.regions.length} 个地点 · 点击修改` : '把家、公司等不想发送的地点隐藏')}
            {pageLink('amap', '高德 API', value.amapKey?.trim() ? (value.provider === 'amap' ? '已填写 Key · 当前使用高德' : '已填写 Key · 当前未选用') : '查街道和附近地点 · 申请并填写 Key')}
            {pageLink('geoapify', '全球街道 · Geoapify', value.geoapifyKey?.trim() ? (value.provider === 'geoapify' ? '已填写 Key · 当前使用全球街道' : '已填写 Key · 当前未选用') : '适合海外 · 注册复制免费 Key，不用绑信用卡')}
            {pageLink('about', '定位说明', '位置怎么查，角色能知道什么')}
        </nav>
        <div className="space-y-3 rounded-xl bg-white/80 p-3">
            <h3 className="text-xs font-bold text-slate-700">角色能看到什么</h3>
            {failureHint && <p role="alert" className="text-xs leading-6 text-rose-700">{failureHint}</p>}
            {previewText ? <>
                <p role="status" className="text-xs leading-6 text-slate-700">{previewText.trim().split('\n')[1]}</p>
                {previewSource === 'geoapify' && <p className="text-[11px] text-slate-500">Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer" className="underline">Geoapify</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap contributors</a></p>}
                <details><summary className="cursor-pointer py-2 text-[11px] text-sky-700">查看完整位置提示词</summary><pre className="whitespace-pre-wrap break-words text-xs leading-6 text-slate-600">{previewText.trim()}</pre></details>
            </> : <p className="text-xs leading-6 text-slate-500">{value.enabled ? '点击预览，查看这次会发给角色的位置。' : '开启真实定位后，可以查看位置预览。'}</p>}
            <button disabled={busy || !value.enabled} onClick={() => void preview()} className="min-h-11 w-full rounded-xl bg-sky-700 px-3 text-xs font-bold text-white disabled:opacity-40">{busy ? '正在定位…' : '定位并预览'}</button>
            <details><summary className="cursor-pointer py-2 text-xs text-sky-700">一直定位超时，或找不到权限开关？</summary><div className="space-y-2 text-xs leading-6 text-slate-600">
                <p>先检查系统给浏览器的定位权限，再检查浏览器「设置 → 网站设置 → 位置信息」中糯米机的权限。安装到桌面的版本（PWA）也使用浏览器定位，不一定有单独的 App 权限开关。</p>
                <p>手机的「定位精度」服务可能影响室内定位。Wi-Fi／蓝牙扫描可以辅助定位，但不要求必须开蓝牙；也可以到窗边或室外重试。</p>
                <p>首次取得位置可能需要约 25 秒。如果提示「设备定位超时」，说明还没拿到坐标，更换地图方式或 Key 无法解决这一步；如果提示「地点查询失败」，再检查地图服务和网络。</p>
                <a href="https://support.google.com/chrome/answer/142065?hl=zh-Hans&co=GENIE.Platform%3DAndroid" target="_blank" rel="noreferrer" className="inline-block text-sky-700 underline">Chrome 定位权限说明 ↗</a>
            </div></details>
            <p className="text-[11px] text-slate-500">预览会先保存当前设置。</p>
        </div>
        </>}
        {page === 'characters' && <CharacterLocationAudience characters={characters} value={value.characterIds} onChange={characterIds=>onChange({...value,characterIds})}/>}
        {page === 'amap' && <div className="space-y-3">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900">
                添加 Key 时，服务平台请选择 <strong className="inline-block rounded-md bg-amber-200 px-2 text-sm font-bold">Web服务</strong>
                <p className="mt-1">别选「Web端（JS API）」，这个功能用不了那种 Key。</p>
            </div>
            <label className="block text-xs font-bold text-slate-700">高德 Web服务 Key</label>
            <div className="flex items-center gap-2">
                <input aria-label="高德 Key" type={showKey ? 'text' : 'password'} autoComplete="off" value={value.amapKey || ''} disabled={busy} onChange={event => { setMessage(''); onChange({ ...value, provider: 'amap', amapKey: event.target.value }); }} placeholder="粘贴高德 Web服务 Key" className="min-w-0 flex-1 rounded-xl border border-sky-200 bg-white p-3 text-sm" />
                <button type="button" aria-label={showKey ? '隐藏高德 Key' : '显示高德 Key'} aria-pressed={showKey} disabled={busy} onClick={() => setShowKey(current => !current)} className="min-h-11 shrink-0 px-2 text-xs text-sky-700">{showKey ? '隐藏' : '显示'}</button>
            </div>
            <p className="text-[11px] leading-5 text-slate-500">填写后自动选用高德，保存并返回即可。Key 只存这台设备。</p>
            <p className="text-xs leading-6 text-slate-600">还没有 Key？去高德申请时选「Web服务」。</p>
            <a href="https://console.amap.com/" target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-center rounded-xl border border-sky-200 bg-white px-3 text-xs font-bold text-sky-700">去高德申请 Key ↗</a>
            <details><summary className="cursor-pointer py-2 text-xs text-sky-700">怎么申请？</summary><ol className="space-y-2 text-xs leading-6 text-slate-600"><li>1. 登录或注册高德控制台。</li><li>2. 创建应用，添加 Key 时选「Web服务」，不是「Web端 JS API」。</li><li>3. 复制 Key，回到这里粘贴。</li></ol></details>
            <a href="https://lbs.amap.com/api/webservice/create-project-and-key" target="_blank" rel="noreferrer" className="inline-block py-2 text-xs text-sky-700 underline">不会申请？看高德图文步骤 ↗</a>
            <p className="text-[11px] leading-5 text-slate-500">查到的店铺只是附近地点，不代表你一定在店里，也不能知道楼层。隐藏地点附近仍然不查高德。</p>
        </div>}
        {page === 'geoapify' && <div className="space-y-3">
            <p className="rounded-xl border border-sky-200 bg-white/80 p-3 text-xs leading-6 text-sky-900">海外用户可以选这个。免费账户不用绑信用卡，注册后创建项目、复制 Key 就能用。</p>
            <label className="block text-xs font-bold text-slate-700">Geoapify API Key</label>
            <div className="flex items-center gap-2">
                <input aria-label="Geoapify Key" type={showKey ? 'text' : 'password'} autoComplete="off" value={value.geoapifyKey || ''} disabled={busy} onChange={event => {setMessage(''); onChange({...value, provider:'geoapify', geoapifyKey:event.target.value});}} placeholder="粘贴 Geoapify Key" className="min-w-0 flex-1 rounded-xl border border-sky-200 bg-white p-3 text-sm" />
                <button type="button" aria-label={showKey ? '隐藏 Geoapify Key' : '显示 Geoapify Key'} aria-pressed={showKey} disabled={busy} onClick={() => setShowKey(current => !current)} className="min-h-11 shrink-0 px-2 text-xs text-sky-700">{showKey ? '隐藏' : '显示'}</button>
            </div>
            <p className="text-[11px] leading-5 text-slate-500">填写后自动选用全球街道，保存并返回即可。Key 只存这台设备。</p>
            <a href="https://myprojects.geoapify.com/" target="_blank" rel="noreferrer" className="flex min-h-11 items-center justify-center rounded-xl border border-sky-200 bg-white px-3 text-xs font-bold text-sky-700">注册并获取免费 Key ↗</a>
            <ol className="space-y-2 text-xs leading-6 text-slate-600"><li>1. 注册或登录 Geoapify MyProjects。</li><li>2. 创建项目，在 API Keys 中复制自动生成的 Key。</li><li>3. 回到这里粘贴，再保存并预览。</li></ol>
            <details><summary className="cursor-pointer py-2 text-xs text-sky-700">保护 Key 与免费额度</summary><p className="text-xs leading-6 text-slate-600">可在 Key 设置中添加允许的网站 Origin，填写你打开糯米机的网址。每个账户有免费额度，最新限额以官方页面为准；用自己的 Key，不与所有用户共用一份额度。</p><a href="https://myprojects.geoapify.com/help/api-keys/" target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline">Key 设置说明 ↗</a></details>
            <a href="https://www.geoapify.com/pricing/" target="_blank" rel="noreferrer" className="inline-block py-2 text-xs text-sky-700 underline">查看免费额度与价格 ↗</a>
            <p className="text-[11px] leading-5 text-slate-500">地址来自地图数据，部分地方可能只有街道或地区；不能判断你是否进了店或在哪一层。隐藏地点附近不查询任何地图。</p>
        </div>}
        {page === 'about' && <div className="space-y-3 text-xs leading-6 text-slate-600">
            <p>让角色知道你在哪。首次使用要允许手机或浏览器定位。</p>
            <p>任何形式的 API 中转站，理论上都能看到你发给角色的聊天内容。地址涉及隐私，不想把家、公司等具体地址发出去，就把这些地点隐藏。</p>
            <div className="rounded-xl bg-white/80 p-3 text-xs leading-6 text-slate-700"><div className="font-bold">举个例子，发给角色的内容：</div><div className="mt-1"><span className="text-slate-500">隐藏前：</span>你现在在 XX市XX区XX路123号附近。</div><div><span className="text-sky-700">隐藏后：</span>你现在在家附近。</div></div>
            <p>先从手机或浏览器拿到你现在的位置，再在这台设备上判断是不是在隐藏地点附近。比如设置了「家周围 3 公里」，范围里就只告诉角色「在家附近」，不会拿这个位置去查地图。</p>
            <p>其他地方由你的设备直接查询所选地图服务，不走糯米机后台。免 Key 方式可以查全球大概地区；高德可以查街道和附近地点；Geoapify 适合海外街道地址。地图服务会收到这次定位；免费地区服务 BigDataCloud 还会用定位和 IP 改进自己的数据。</p>
            <p>选了高德或 Geoapify，就使用所选 API 返回的地址。查询失败会在位置预览中说明是哪项服务失败及原因，不会自动换成免费地区查询或另一家地图。设备取坐标的重试也不会更换你选的地图服务。</p>
            <p>地址会跟天气一起发给角色。API 中转站理论上能看到这段聊天内容，所以家、公司等不想发送的地点建议先隐藏。</p>
            <p>定位失败时只告诉角色「位置未知」，不会拿上次的位置代替。关着页面时不会继续定位。</p>
            <a href="https://www.bigdatacloud.com/docs/article/why-is-reverse-geocoding-api-free" target="_blank" rel="noreferrer" className="inline-block py-2 text-sky-700 underline">免费服务的说明 ↗</a>
        </div>}
        {page === 'regions' && <div className="space-y-3"><h3 className="text-xs font-bold text-slate-700">不想发送的地点 · {value.regions.length}/{MAX_PRIVACY_REGIONS}</h3>
            <p className="text-[11px] leading-5 text-slate-500">比如把家周围 3 公里设为隐藏，这个范围里都只会发送「在家附近」。名字写「家」「公司」就行，别写真实地址。这里的位置只存你的设备，不进备份；换手机后重新设置。修改后请保存。</p>
            {value.regions.map((region, index) => <div key={region.id} className="rounded-xl border border-sky-100 bg-white/80 p-3 space-y-2">
                <div className="flex gap-2"><label className="flex-1 min-w-0 text-xs text-slate-600">叫它什么<input aria-label={`隐私区域 ${index + 1} 名称`} maxLength={30} value={region.name} disabled={busy} onChange={event => updateRegion(region.id, { name: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm" /></label><label className="w-24 text-xs text-slate-600">隐藏几公里<input aria-label={`隐私区域 ${index + 1} 半径`} type="number" min="0.1" max="100" step="0.1" value={Number.isFinite(region.radiusKm) ? region.radiusKm : ''} disabled={busy} onChange={event => updateRegion(region.id, { radiusKm: event.target.valueAsNumber })} className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm" /></label></div>
                <details><summary className="cursor-pointer py-2 text-[11px] text-sky-700">手动填写经纬度（可不管）</summary><p className="mb-2 text-[11px] text-slate-500">这里用手机定位的 WGS84 坐标，不要直接复制高德坐标。</p><div className="grid grid-cols-2 gap-2">{(['latitude', 'longitude'] as const).map(field => <label key={field} className="text-xs text-slate-600">{field === 'latitude' ? '纬度' : '经度'}<input aria-label={`隐私区域 ${index + 1} ${field === 'latitude' ? '纬度' : '经度'}`} type="number" step="any" value={Number.isFinite(region[field]) ? region[field] : ''} disabled={busy} onChange={event => updateRegion(region.id, { [field]: event.target.valueAsNumber })} className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm" /></label>)}</div></details>
                <button disabled={busy} onClick={() => onChange({ ...value, regions: value.regions.filter(item => item.id !== region.id) })} className="min-h-10 text-xs text-rose-600 disabled:opacity-40">不再隐藏这里</button>
            </div>)}
            <div className="flex flex-wrap gap-2"><button disabled={busy || value.regions.length >= MAX_PRIVACY_REGIONS} onClick={() => void addCurrentRegion()} className="min-h-11 rounded-xl border border-sky-200 bg-white px-3 text-xs text-sky-800 disabled:opacity-40">把当前位置设为隐藏地点</button><button disabled={busy || value.regions.length >= MAX_PRIVACY_REGIONS} onClick={addManual} className="min-h-11 px-2 text-xs text-sky-700 disabled:opacity-40">手动填写位置</button></div>
        </div>}
        {message && <p role="status" className="rounded-xl bg-white/70 p-3 text-xs leading-6 text-slate-700">{message}</p>}
    </section>;
}

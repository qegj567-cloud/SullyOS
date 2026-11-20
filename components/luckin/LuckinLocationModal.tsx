import React, { useState } from 'react';
import { getCurrentPositionSmart } from '../../utils/geo';

/**
 * 瑞幸定位选择 (点"瑞一杯"时弹出)
 *
 * queryShopList / createOrder 的经纬度必填。浏览器/容器抓到的 GPS 常常是机房位置
 * (实测拿到新加坡), 所以这里让用户显式选城市 / 用定位 / 手输, 把对的坐标交给角色。
 */

const CITIES: Array<{ name: string; lng: number; lat: number; note?: string }> = [
    { name: '北京·AI点单测试店', lng: 116.392435, lat: 39.982376, note: '文档示例门店, 测试首选' },
    { name: '北京', lng: 116.407, lat: 39.904 },
    { name: '上海', lng: 121.473, lat: 31.230 },
    { name: '广州', lng: 113.264, lat: 23.129 },
    { name: '深圳', lng: 114.057, lat: 22.543 },
    { name: '杭州', lng: 120.155, lat: 30.274 },
    { name: '成都', lng: 104.066, lat: 30.572 },
    { name: '南京', lng: 118.797, lat: 32.060 },
    { name: '武汉', lng: 114.305, lat: 30.593 },
];

const LuckinLocationModal: React.FC<{
    open: boolean;
    onClose: () => void;
    onPick: (lng: number, lat: number, cityName?: string) => void;
}> = ({ open, onClose, onPick }) => {
    const [locating, setLocating] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [lng, setLng] = useState('');
    const [lat, setLat] = useState('');
    const [geo, setGeo] = useState<{ lng: number; lat: number; acc: number } | null>(null);

    if (!open) return null;

    const useGeo = async () => {
        setLocating(true); setErr(null); setGeo(null);
        try {
            const r = await getCurrentPositionSmart(); // 原生走 Capacitor 插件(弹权限), 浏览器走 navigator
            setGeo({ lng: r.longitude, lat: r.latitude, acc: r.accuracy });
        } catch (e: any) {
            setErr(e?.message || '定位失败, 直接选城市也行');
        } finally {
            setLocating(false);
        }
    };

    const submitManual = () => {
        const a = parseFloat(lng), b = parseFloat(lat);
        if (!isFinite(a) || !isFinite(b)) { setErr('经纬度格式不对'); return; }
        onPick(a, b, '自定义坐标');
    };

    return (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-gradient-to-b from-[#FAF7F0] to-[#F3EFE6] text-[#1c1917] w-full sm:max-w-sm rounded-2xl overflow-hidden shadow-2xl flex flex-col" style={{ maxHeight: 'calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 2rem)' }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-[#0B1F3A] to-[#1E4D8C] rounded-t-2xl">
                    <div className="flex items-center gap-2">
                        <span className="text-xl">🦌</span>
                        <div>
                            <div className="text-[13px] font-bold text-white">瑞一杯 · 你在哪儿？</div>
                            <div className="text-[9px] text-white/70">瑞幸按位置查门店, 选个城市让 ta 帮你点</div>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-white active:scale-90">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                    <button onClick={useGeo} disabled={locating}
                        className="w-full p-3 rounded-xl bg-white border border-[#E6DFCF] text-[13px] font-bold text-[#0B1F3A] active:scale-[0.98] disabled:opacity-60">
                        {locating ? '定位中…' : '📡 用我的定位'}
                        <span className="block text-[10px] font-normal text-slate-400 mt-0.5">开了手机精确定位走 GPS, 梯子不影响; 关了会退回 IP 定位, 可能被梯子带偏</span>
                    </button>

                    {err && <div className="text-[11px] text-red-600 bg-red-50 rounded-lg p-2">{err}</div>}

                    {geo && (() => {
                        const accKm = geo.acc / 1000;
                        const poor = geo.acc > 2000; // >2km 基本是 IP/WiFi 兜底 (可能被梯子带偏)
                        return (
                            <div className={`rounded-xl p-2.5 border ${poor ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
                                <div className="text-[11px] font-bold text-slate-700">
                                    {poor ? '⚠️ 定位精度较低' : '✅ 定位成功'} · 精度 ±{geo.acc >= 1000 ? `${accKm.toFixed(1)}km` : `${Math.round(geo.acc)}m`}
                                </div>
                                <div className="text-[10px] text-slate-500 font-mono mt-0.5">{geo.lat.toFixed(5)}, {geo.lng.toFixed(5)}</div>
                                {poor && <div className="text-[10px] text-amber-700 mt-1 leading-snug">这多半是 IP 定位 (可能被梯子带偏)。要么开手机精确定位重试, 要么直接选下面城市。</div>}
                                <button onClick={() => onPick(geo.lng, geo.lat, poor ? '我的定位(粗略)' : '我的定位')}
                                    className="mt-1.5 w-full py-1.5 bg-[#0B1F3A] text-white text-[12px] font-bold rounded-lg active:scale-95">
                                    就用这个定位
                                </button>
                            </div>
                        );
                    })()}

                    <div>
                        <div className="text-[11px] font-bold text-[#0B1F3A]/60 mb-1.5">选城市</div>
                        <div className="grid grid-cols-2 gap-2">
                            {CITIES.map((c) => (
                                <button key={c.name} onClick={() => onPick(c.lng, c.lat, c.name)}
                                    className="p-2 rounded-xl bg-white border border-[#E6DFCF] text-left active:scale-95 active:bg-[#FAF7F0]">
                                    <div className="text-[12px] font-bold text-[#16386F]">{c.name}</div>
                                    {c.note && <div className="text-[9px] text-[#B8860B]">{c.note}</div>}
                                </button>
                            ))}
                        </div>
                    </div>

                    <details className="text-[11px] text-slate-500">
                        <summary className="cursor-pointer text-[#16386F]">手动输入经纬度</summary>
                        <div className="flex gap-2 mt-2">
                            <input value={lng} onChange={e => setLng(e.target.value)} placeholder="经度 lng" className="flex-1 bg-white border border-[#E6DFCF] rounded-lg px-2 py-1.5 text-[12px] text-slate-800 placeholder:text-slate-400" />
                            <input value={lat} onChange={e => setLat(e.target.value)} placeholder="纬度 lat" className="flex-1 bg-white border border-[#E6DFCF] rounded-lg px-2 py-1.5 text-[12px] text-slate-800 placeholder:text-slate-400" />
                            <button onClick={submitManual} className="px-3 bg-[#0B1F3A] text-white rounded-lg text-[12px] font-bold active:scale-95">用</button>
                        </div>
                    </details>
                </div>
            </div>
        </div>
    );
};

export default LuckinLocationModal;

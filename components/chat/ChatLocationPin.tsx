import React, { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { readLocationPin, refreshChatLocation, subscribeLocationPin, type UserLocationSnapshot } from '../../utils/userLocation';

const preferenceKey = 'chat_location_pin_visible';
const subscribers = new Set<() => void>();
function subscribe(listener: () => void) {
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
}
function useVisible() {
    return useSyncExternalStore(subscribe, () => localStorage.getItem(preferenceKey) !== 'off');
}
export function LocationPinPreference() {
    const visible = useVisible();
    return <label className="flex items-center justify-between py-2">聊天定位大头针<input type="checkbox" checked={visible} onChange={e => {
        localStorage.setItem(preferenceKey, e.target.checked ? 'on' : 'off');
        subscribers.forEach(listener => listener());
    }} /></label>;
}
export function ChatLocationPin({charId}: {charId: string}) {
    const state = useSyncExternalStore(subscribeLocationPin, () => readLocationPin(charId));
    const visible = useVisible();
    const [open,setOpen] = useState(false);
    const [busy,setBusy] = useState(false);
    const [manual,setManual] = useState<UserLocationSnapshot | null>();
    if (!state) return null;
    const snapshot = manual === undefined ? state.snapshot : manual;
    const pending = busy || snapshot === undefined;
    const label = pending ? '定位中' : snapshot && snapshot.kind !== 'unavailable' ? '当前定位：' + Array.from(snapshot.location).slice(0,3).join('') : '定位未知';
    return <>{visible && <button type="button" onClick={() => setOpen(true)} className="absolute right-0 top-full whitespace-nowrap text-[10px] text-slate-500"><span className={pending ? 'motion-safe:animate-pulse' : ''}>📍</span>{label}</button>}
    {open && createPortal(<div className="fixed inset-0 z-[9999] grid place-items-center bg-black/30 p-5" onClick={() => setOpen(false)}><div role="dialog" aria-label="当前定位" className="w-full max-w-xs space-y-3 rounded-2xl bg-white p-5 text-sm text-slate-800" onClick={e => e.stopPropagation()}>
        <strong>当前定位</strong><p>{pending ? '正在定位…' : snapshot?.description || '本轮未取得位置。'}</p>
        {snapshot?.kind === 'place' && snapshot.attribution && <small>Geoapify · © OpenStreetMap contributors</small>}
        <LocationPinPreference />
        <button disabled={busy} onClick={async () => { setBusy(true); try { setManual(await refreshChatLocation(charId) ?? null); } catch { setManual(null); } finally { setBusy(false); } }}>重新获取定位</button>
        {manual && manual.kind !== 'unavailable' && <p>下轮回复将使用这次位置。</p>}
        <button className="block w-full py-2" onClick={() => setOpen(false)}>关闭</button>
    </div></div>, document.body)}</>;
}

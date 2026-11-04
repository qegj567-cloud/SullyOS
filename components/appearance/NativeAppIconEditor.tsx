import React, { useEffect, useRef, useState } from 'react';
import { PWA_DEFAULT_ICON_URL, PWA_CLASSIC_ICON_URL } from '../../utils/appIcon';
import { getNativeAppIcon, setNativeAppIcon, type NativeAppIcon } from '../../utils/nativeAppIcon';

/** APK choices reflect PackageManager, not the PWA field imported from backups. */
export default function NativeAppIconEditor() {
    const [icon, setIcon] = useState<NativeAppIcon | null>(null);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const mounted = useRef(false);
    const pending = useRef(false);

    const load = async () => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setError('');
        try {
            const state = await getNativeAppIcon();
            if (mounted.current) { setIcon(state.icon); setReady(true); }
        } catch (e) {
            if (mounted.current) { setReady(false); setError(e instanceof Error ? e.message : '读取桌面图标失败，请重试。'); }
        } finally { pending.current = false; if (mounted.current) setBusy(false); }
    };
    useEffect(() => {
        mounted.current = true;
        void load();
        return () => { mounted.current = false; };
    }, []);

    const choose = async (next: NativeAppIcon) => {
        if (pending.current || !ready || next === icon) return;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try {
            const result = await setNativeAppIcon(next);
            if (mounted.current) { setIcon(result.icon); setNotice('已请求切换桌面图标，桌面刷新可能稍有延迟。'); }
        } catch (e) {
            if (mounted.current) setError(e instanceof Error ? e.message : '图标切换失败，请重试。');
            // A failed/partially applied system operation is not a successful selection.
            try {
                const actual = await getNativeAppIcon();
                if (mounted.current) setIcon(actual.icon);
            } catch { if (mounted.current) { setIcon(null); setReady(false); } }
        } finally { pending.current = false; if (mounted.current) setBusy(false); }
    };

    return <section className="bg-white rounded-3xl p-5 shadow-sm border border-slate-100 space-y-4">
        <h3 className="text-sm font-medium text-slate-700">Android 桌面图标</h3>
        <div className="grid grid-cols-2 gap-3" role="group" aria-label="Android 桌面图标">
            {([{id:'jellyfish', name:'水母', image:PWA_DEFAULT_ICON_URL}, {id:'classic', name:'经典', image:PWA_CLASSIC_ICON_URL}] as const).map(option =>
                <button key={option.id} type="button" disabled={busy || !ready} aria-pressed={icon === option.id}
                    onClick={() => void choose(option.id)}
                    className={`flex flex-col items-center gap-2 p-3 rounded-2xl border transition-colors disabled:opacity-50 ${icon === option.id ? 'border-primary bg-primary/5' : 'border-slate-200'}`}>
                    <img src={option.image} alt="" className="w-20 h-20 rounded-2xl" />
                    <span className="text-xs text-slate-700">{option.name}{icon === option.id ? ' · 已选' : ''}</span>
                </button>)}
        </div>
        {busy && <p role="status" className="text-xs text-slate-500">正在读取或切换图标…</p>}
        {notice && <p role="status" className="text-xs text-slate-600">{notice}</p>}
        {error && <div role="alert" className="text-xs text-red-600 space-y-2"><p>{error}</p>
            <button type="button" disabled={busy} onClick={() => void load()} className="underline">重新读取</button></div>}
        <p className="text-xs text-slate-500 leading-relaxed">更换的是这台设备的桌面启动图标，不需要卸载，不影响聊天与设置。部分桌面可能延迟刷新或重新排列图标；系统设置中的应用图标仍可能显示默认水母。</p>
        <p className="text-xs text-slate-400 leading-relaxed">APK 暂只支持这两种内置图标；网页版的上传图标设置与备份保持不变。</p>
    </section>;
}

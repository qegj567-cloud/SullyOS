import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import React, { useEffect, useRef, useState } from 'react';
import Modal from '../os/Modal';
import { checkNativeAlarm, createNativeAlarm } from '../../utils/nativeAlarm';
import { trackEvent } from '../../utils/analytics';

export interface AlarmTarget { title: string; date?: string; kind: 'task' | 'anniversary' }
export default function SystemAlarmDialog({ target, onClose, onOpened }: { target: AlarmTarget | null; onClose: () => void; onOpened: () => void }) {
    const [time, setTime] = useState('09:00');
    const [error, setError] = useState('');
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const inFlight = useRef(false);
    useLocalBackHandler(() => { if (!inFlight.current) onClose(); return true; }, 70, !!target);
    useEffect(() => {
        if (!target) return;
        let cancelled = false;
        setReady(false); setError(''); setTime('09:00');
        trackEvent('打开时光契约系统闹钟', { kind: target.kind });
        void checkNativeAlarm().then(() => { if (!cancelled) setReady(true); }).catch(error => {
            if (!cancelled) { setError(error instanceof Error ? error.message : '无法读取系统时钟'); trackEvent('时光契约系统闹钟结果', { outcome: 'unavailable' }); }
        });
        return () => { cancelled = true; };
    }, [target]);
    const submit = async () => {
        if (!target || !ready || inFlight.current) return;
        inFlight.current = true; setBusy(true); setError('');
        try {
            await createNativeAlarm(time, target.title);
            trackEvent('时光契约系统闹钟结果', { outcome: 'opened' });
            onOpened(); onClose();
        } catch (error) {
            setError(error instanceof Error ? error.message : '打开系统闹钟失败，请重试');
            trackEvent('时光契约系统闹钟结果', { outcome: 'failed' });
        } finally { inFlight.current = false; setBusy(false); }
    };
    return <Modal isOpen={!!target} title="添加到系统闹钟" onClose={busy ? () => {} : onClose}
        footer={<div className="w-full space-y-2"><button disabled={!ready || busy || !time} onClick={submit} className="w-full rounded-xl bg-slate-800 text-white py-3 text-sm disabled:opacity-40">{busy ? '正在打开…' : '创建闹钟并打开时钟'}</button><button disabled={busy} onClick={onClose} className="w-full py-2 text-xs text-slate-500">取消</button></div>}>
        <div className="space-y-4 text-slate-700">
            <p className="text-sm font-semibold break-words">{target?.title}</p>
            <label className="block text-xs">响铃时间（手机本地时间）<input aria-label="响铃时间" type="time" value={time} onChange={e => setTime(e.target.value)} className="mt-2 block w-full min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-base text-slate-800 [color-scheme:light]" /></label>
            <div className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
                {target?.date && <p className="font-semibold mb-1">条目日期：{target.date.slice(0, 10)}</p>}
                <p>系统接口只接收时刻，不接收年月日。这里创建的是下一次该时刻的闹钟，不会自动绑定条目日期，也不会设置每年重复。</p>
                <p className="mt-2">系统时钟可能直接创建闹钟，请核对响铃时间与重复规则。之后完成、删除条目或恢复备份，都不会修改系统时钟里的闹钟。</p>
            </div>
            {!ready && !error && <p role="status" className="text-xs">正在检查系统时钟…</p>}
            {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        </div>
    </Modal>;
}

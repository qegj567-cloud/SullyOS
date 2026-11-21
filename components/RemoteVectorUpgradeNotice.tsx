import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { appShortcutLaunch } from '../utils/appShortcutLaunch';
import { SESSION_SPACE_ID } from '../utils/userSpaces';
import { readUpgrade, testConnection, upgradeKey, upgradeRemoteVectors } from '../utils/memoryPalace/supabaseVector';
import { trackEvent } from '../utils/analytics';

export default function RemoteVectorUpgradeNotice() {
    const { remoteVectorConfig: config, isDataLoaded, openApp, updateRemoteVectorConfig } = useOS();
    const [notice, setNotice] = useState<{ message: string; failed?: boolean } | null>(null);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        setNotice(null);
        if (!isDataLoaded || !config.enabled || !config.supabaseUrl || !config.supabaseAnonKey || (config.initialized && readUpgrade(config).done)) return;
        const controller = new AbortController();
        const { signal } = controller;
        const seenKey = upgradeKey(config) + ':notice';
        let show = false;
        let busy = false;
        let retryTimer: ReturnType<typeof setTimeout>;
        let delay = 60000;
        const work = async () => {
            if (signal.aborted || (config.initialized && readUpgrade(config).done)) return;
            try {
                if (!config.initialized) {
                    const result = await testConnection(config);
                    if (signal.aborted) return;
                    if (!result.ok) throw new Error(result.message);
                    updateRemoteVectorConfig({ initialized: true });
                    return; // Re-enter with the verified configuration.
                }
                await upgradeRemoteVectors(config, signal, (checked, total) => {
                    if (!localStorage.getItem(seenKey)) {
                        show = true;
                        localStorage.setItem(seenKey, '1');
                    }
                    if (show && !signal.aborted) setNotice({ message: `正在用已有连接核对远程记忆（${checked}/${total}）。无需登录 Supabase，可以继续聊天；下次打开会接着处理。` });
                });
                if (signal.aborted) return;
                trackEvent('远程记忆自动适配结果', { 结果: '完成' });
                const message = readUpgrade(config).divergent
                    ? '已完成核对。发现两端有不同版本，已保留云端原文，当前设备优先使用本地记忆。'
                    : '远程记忆已适配完成。原来的云库和向量可以继续使用。';
                setNotice(current => show || retry || current?.failed ? { message } : null);
            } catch (error) {
                if (signal.aborted) return;
                const reason = error instanceof Error ? error.message : '';
                // Show only locally generated diagnostics. fetch exceptions may contain arbitrary URLs.
                const message = /^(HTTP \d{3}|请求超时|连接失败|云端未确认元数据更新)/.test(reason) ? reason : '云端连接或本地读取暂时不可用';
                const failureKey = SESSION_SPACE_ID + ':' + seenKey + ':failed';
                if (!sessionStorage.getItem(failureKey) || retry) {
                    sessionStorage.setItem(failureKey, '1');
                    setNotice({ failed: true, message: `${message}。本地记忆可继续使用，已确认的批次会保留。` });
                }
                trackEvent('远程记忆自动适配结果', { 结果: '暂停' });
                if (!/^HTTP 4(?!29)/.test(message)) {
                    clearTimeout(retryTimer);
                    retryTimer = setTimeout(run, delay);
                    delay = Math.min(delay * 2, 15 * 60000);
                }
            }
        };
        const run = async () => {
            if (busy || signal.aborted || navigator.onLine === false) return;
            busy = true;
            try {
                if (navigator.locks?.request) {
                    await navigator.locks.request(SESSION_SPACE_ID + ':' + upgradeKey(config), { signal }, work);
                } else await work();
            } catch (error) {
                if (!signal.aborted) console.warn('[MemoryPalace] 无法启动后台同步', error);
            } finally { busy = false; }
        };
        const onStorage = (event: StorageEvent) => {
            if (event.key !== 'os_remote_vector_config') return;
            const saved = JSON.parse(event.newValue || '{}');
            if (!saved.enabled || saved.supabaseUrl !== config.supabaseUrl || saved.supabaseAnonKey !== config.supabaseAnonKey) {
                controller.abort();
                clearTimeout(retryTimer);
                setNotice(null);
            }
        };
        void run();
        window.addEventListener('online', run);
        window.addEventListener('storage', onStorage);
        return () => {
            controller.abort();
            clearTimeout(retryTimer);
            window.removeEventListener('online', run);
            window.removeEventListener('storage', onStorage);
        };
    }, [isDataLoaded, config.enabled, config.initialized, config.supabaseUrl, config.supabaseAnonKey, retry]);

    const [dismissed, setDismissed] = useState('');
    const dismissalKey = upgradeKey(config) + (notice?.failed ? ':failed' : ':info') + retry;
    if (!notice || !config.enabled || !isDataLoaded || dismissed === dismissalKey) return null;
    return createPortal(
        <aside role="dialog" aria-label="远程记忆更新" className="fixed left-4 right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[250] mx-auto max-w-sm rounded-2xl border border-slate-200 bg-white p-4 text-slate-800 shadow-lg">
            <h2 className="font-semibold">{notice.failed ? '远程记忆同步已暂停' : '远程记忆更新'}</h2>
            <p className="mt-1 text-sm">{notice.message}</p>
            <div className="mt-3 flex justify-end gap-4 text-sm">
                {notice.failed && <button onClick={() => {
                    setDismissed(dismissalKey);
                    appShortcutLaunch.request({ appId: AppID.MemoryPalace, entryId: 'globalSettings', resourceId: 'remoteVector' });
                    openApp(AppID.MemoryPalace);
                }}>查看设置</button>}
                {notice.failed && <button onClick={() => setRetry(n => n + 1)}>重试</button>}
                <button onClick={() => setDismissed(dismissalKey)}>知道了</button>
            </div>
        </aside>, document.body);
}

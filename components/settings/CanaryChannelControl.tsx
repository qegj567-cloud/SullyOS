import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { trackEvent } from '../../utils/analytics';
import { RELEASE_CHANNEL, describeCanaryJoinBlocker } from '../../utils/releaseChannel';
import { joinCanary, leaveCanary, loadCanaryJoinContext } from '../../utils/releaseChannelSwitch';

/**
 * 设置底部版本信息下面的 canary 入口（docs/canary-channel.md）。
 * 在 canary 里一直显示「回到正式版」；正式版上要先连点版本号解锁调试面板才出现「加入 canary」。
 */
const CanaryChannelControl: React.FC<{ unlocked: boolean }> = ({ unlocked }) => {
    const { requestConfirm, confirmDialog } = useConfirmDialog();
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    const leave = async () => {
        const confirmed = await requestConfirm({
            title: '回到正式版',
            message: '会切回正式版并刷新页面。开着主动消息 2.0 的话，Worker 也会一起换回正式版。',
            confirmText: '回到正式版',
            variant: 'info',
        });
        if (!confirmed) return;
        setBusy(true);
        trackEvent('退出 canary');
        await leaveCanary();
    };

    const join = async () => {
        setBusy(true);
        setNote(null);
        try {
            const blocker = describeCanaryJoinBlocker(await loadCanaryJoinContext());
            if (blocker) { setNote(blocker); return; }
            const confirmed = await requestConfirm({
                title: '加入 canary',
                message: 'canary 是还没正式发布的新版本，和正式版共用同一份数据，新版本的问题可能碰到你的真实数据。加入前请先在「设置 → 备份」导出一份备份。开着主动消息 2.0 的话，Worker 会先换成 canary 版本。',
                confirmText: '加入',
                variant: 'warning',
                confirmDelaySeconds: 3,
            });
            if (!confirmed) return;
            const result = await joinCanary(() => trackEvent('加入 canary'));
            if (!result.ok) setNote(result.message);
        } finally {
            setBusy(false);
        }
    };

    if (RELEASE_CHANNEL === 'canary') {
        return (
            <div className="flex items-center gap-2 text-[10px] text-amber-600">
                <span>当前是 canary</span>
                <button type="button" disabled={busy} onClick={leave} className="underline disabled:opacity-50">回到正式版</button>
                {confirmDialog}
            </div>
        );
    }
    if (!unlocked || Capacitor.isNativePlatform()) return null;
    return (
        <div className="flex flex-col items-center gap-1 text-[10px] text-slate-400">
            <button type="button" disabled={busy} onClick={join} className="underline disabled:opacity-50">
                {busy ? '检查中…' : '加入 canary'}
            </button>
            {note && <span className="max-w-xs text-center text-amber-600">{note}</span>}
            {confirmDialog}
        </div>
    );
};

export default CanaryChannelControl;

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { trackEvent } from '../../utils/analytics';
import { CANARY_NAMES, CanaryBird } from '../CanaryBird';
import {
  RELEASE_CHANNEL,
  BUNDLED_ANDROID_CHANNELS,
  describeCanaryJoinBlocker,
  readCanaryDotHidden,
  writeCanaryDotHidden,
} from '../../utils/releaseChannel';
import { joinCanary, leaveCanary, loadCanaryJoinContext } from '../../utils/releaseChannelSwitch';

/** canary 经典黄。 */
const CANARY_YELLOW = '#FACC15';
/** 加入动画扫一遍的时长；跳走前至少扫完一遍，Worker 换得再快也看得见。 */
const SWEEP_MS = 1400;
/** 退出时小鸟飞走的时长，飞完才切回正式版。 */
const LEAVE_MS = 1100;

const GLOW_CSS = `
@keyframes canary-sweep { from { transform: translateY(100%); } to { transform: translateY(-100%); } }
.canary-glow-ring { position: absolute; inset: 0; padding: 9px; overflow: hidden; background: rgba(250,204,21,0.22);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); filter: blur(1.5px); }
.canary-glow-bloom { position: absolute; inset: 0; overflow: hidden; opacity: 0.28; filter: blur(32px); }
.canary-glow-band { position: absolute; inset: 0; animation: canary-sweep ${SWEEP_MS}ms cubic-bezier(.45,0,.25,1) infinite;
  background: linear-gradient(to top, transparent 22%, ${CANARY_YELLOW} 44%, #FFF6C2 50%, ${CANARY_YELLOW} 56%, transparent 78%); }
@media (prefers-reduced-motion: reduce) { .canary-glow-band { animation: none; opacity: 0.6; } }
`;

/** 各国叫法在屏幕上的横向位置和出场错开，取一半就够热闹。 */
const RISING_HELLOS = CANARY_NAMES.slice(0, 8).map((text, index) => ({
    text,
    left: `${8 + ((index * 37) % 84)}%`,
    delay: `${(index * 0.33).toFixed(2)}s`,
    top: `${18 + ((index * 23) % 64)}%`,
}));

/**
 * 加入 canary 时盖在整个屏幕上的黄光：屏幕边缘一圈光带，一道亮光从底部往顶部扫，
 * 中间一层很淡的泛光跟着走；小金丝雀跟着光往上飞，身边飘起它在各国语言里的名字。
 * 不拦点击，一直扫到页面跳走。
 */
export const CanaryJoinGlow: React.FC = () => createPortal(
    <div aria-hidden className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 2147483647 }}>
        <style>{GLOW_CSS}</style>
        <div className="canary-glow-bloom"><div className="canary-glow-band" /></div>
        <div className="canary-glow-ring"><div className="canary-glow-band" /></div>
        {RISING_HELLOS.map((hello) => (
            <span
                key={hello.text}
                className="canary-hello"
                style={{ left: hello.left, animationDelay: hello.delay, ['--canary-hello-top' as string]: hello.top }}
            >
                {hello.text}
            </span>
        ))}
        <div className="canary-bird-rise" style={{ ['--canary-rise-ms' as string]: `${SWEEP_MS}ms` }}>
            <div className="canary-bird-sway"><CanaryBird size={56} mode="fly" /></div>
            <span className="canary-feather" style={{ left: 6, top: 30 }} />
            <span className="canary-feather" style={{ left: 34, top: 24, animationDelay: '0.8s' }} />
        </div>
    </div>,
    document.body,
);

/** 退出 canary 时小金丝雀往左上角飞走。 */
const CanaryLeaveFlight: React.FC = () => createPortal(
    <div aria-hidden className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 2147483647 }}>
        <div className="canary-bird-leave" style={{ ['--canary-leave-ms' as string]: `${LEAVE_MS}ms` }}>
            <CanaryBird size={48} mode="fly" />
        </div>
    </div>,
    document.body,
);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * 设置底部版本信息下面的通道切换（docs/canary-channel.md）。
 * 在 canary 里一直显示；正式版上要先连点版本号解锁调试面板才出现。
 */
const CanaryChannelControl: React.FC<{ unlocked: boolean }> = ({ unlocked }) => {
    const { requestConfirm, confirmDialog } = useConfirmDialog();
    const [busy, setBusy] = useState(false);
    const [glowing, setGlowing] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [dotHidden, setDotHidden] = useState(readCanaryDotHidden);
    const inCanary = RELEASE_CHANNEL === 'canary';

    const leave = async () => {
        const confirmed = await requestConfirm({
            title: '回到正式版',
            message: '切回后，聊天和设置会接着现在的进度，不会回到加入金丝雀之前。如果开着主动消息 2.0，也会尝试把 Worker 切回正式版。',
            confirmText: '回到正式版',
            variant: 'info',
        });
        if (!confirmed) return;
        setBusy(true);
        setLeaving(true);
        trackEvent('退出 canary');
        await wait(LEAVE_MS);
        await leaveCanary();
    };

    const join = async () => {
        setBusy(true);
        setNote(null);
        try {
            const context = await loadCanaryJoinContext();
            const blocker = describeCanaryJoinBlocker(context);
            if (blocker) { setNote(blocker); return; }
            const confirmed = await requestConfirm({
                title: '想先试试金丝雀的新功能吗？',
                message: <>
                    <p>两个版本共用同一份聊天和设置，不用重新导入。以后切回正式版，也会从那时的进度接着用。</p>
                    {context.amsg && <p>你已启用主动消息 2.0，对应的 Worker 也会一起切换。</p>}
                    <p>顺便提醒：无论用哪个版本，日常操作都可能遇到意外，重要的聊天记得定期备份。</p>
                </>,
                cancelText: '先不切换',
                confirmText: '切换到金丝雀',
                variant: 'info',
            });
            if (!confirmed) return;
            setGlowing(true);
            const startedAt = Date.now();
            const result = await joinCanary(async () => {
                trackEvent('加入 canary');
                await wait(startedAt + SWEEP_MS - Date.now());
            });
            if (!result.ok) { setGlowing(false); setNote(result.message); }
        } finally {
            setBusy(false);
        }
    };

    if (!inCanary && (!unlocked || (Capacitor.isNativePlatform() && !BUNDLED_ANDROID_CHANNELS))) return null;

    const tab = (channel: 'stable' | 'canary', label: React.ReactNode) => {
        const active = (channel === 'canary') === inCanary;
        return (
            <button
                type="button"
                role="tab"
                aria-selected={active}
                disabled={busy}
                onClick={active ? undefined : channel === 'canary' ? join : leave}
                className={`relative z-10 flex items-center justify-center gap-1.5 rounded-full transition-colors disabled:opacity-60 ${active ? 'text-slate-800' : 'text-slate-400'}`}
            >
                {label}
            </button>
        );
    };

    return (
        <div className="flex flex-col items-center gap-2 pt-1">
            <div role="tablist" aria-label="版本通道" className="relative grid grid-cols-2 w-60 h-10 p-1 rounded-full bg-slate-200/70 text-sm font-medium">
                <span
                    aria-hidden
                    className="absolute top-1 bottom-1 left-1 rounded-full shadow-sm transition-all duration-300"
                    style={{
                        width: 'calc(50% - 4px)',
                        transform: inCanary ? 'translateX(100%)' : 'none',
                        background: inCanary ? CANARY_YELLOW : '#fff',
                    }}
                />
                {tab('stable', '正式版')}
                {tab('canary', <>
                    <CanaryBird size={18} mode={busy ? 'fly' : inCanary ? 'idle' : 'still'} />
                    {busy && !inCanary ? '切换中…' : 'canary'}
                </>)}
            </div>
            {inCanary && (
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                    <input
                        type="checkbox"
                        checked={!dotHidden}
                        onChange={(event) => {
                            const hidden = !event.target.checked;
                            writeCanaryDotHidden(hidden);
                            setDotHidden(hidden);
                        }}
                    />
                    右下角显示 canary 黄点
                </label>
            )}
            {note && <span className="max-w-xs text-center text-[11px] text-amber-600">{note}</span>}
            {glowing && <CanaryJoinGlow />}
            {leaving && <CanaryLeaveFlight />}
            {confirmDialog}
        </div>
    );
};

export default CanaryChannelControl;

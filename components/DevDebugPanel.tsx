import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, Check, ClipboardText, DownloadSimple, Power, Trash, Wrench, X } from '@phosphor-icons/react';
import {
    clearDevDebugLog,
    closeDevDebug,
    DEFAULT_DEV_DEBUG_FLAGS,
    DEV_DEBUG_CAPTURE_CATEGORIES,
    formatDevDebugLog,
    isDevDebugAvailable,
    readDevDebugFlags,
    readDevDebugLog,
    subscribeDevDebugAvailability,
    subscribeDevDebugLog,
    subscribeDevDebugFlags,
    writeDevDebugFlags,
} from '../utils/devDebug';
import { BUILD_LABEL } from '../utils/buildInfo';
import type { DevDebugCaptureCategory, DevDebugFlags, DevDebugFloatingPosition } from '../utils/devDebug';

const FLOATING_BUTTON_SIZE = 44;
const FLOATING_SAFE_MARGIN = 16;
const PANEL_WIDTH = 342;
const PANEL_ESTIMATED_HEIGHT = 392;
const DRAG_THRESHOLD_PX = 4;

function getViewportSize() {
    if (typeof window === 'undefined') return { width: 390, height: 844 };
    return {
        width: window.visualViewport?.width ?? window.innerWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

function clampFloatingPosition(position: DevDebugFloatingPosition): DevDebugFloatingPosition {
    const viewport = getViewportSize();
    return {
        x: clamp(position.x, FLOATING_SAFE_MARGIN, viewport.width - FLOATING_BUTTON_SIZE - FLOATING_SAFE_MARGIN),
        y: clamp(position.y, FLOATING_SAFE_MARGIN, viewport.height - FLOATING_BUTTON_SIZE - FLOATING_SAFE_MARGIN),
    };
}

function getDefaultFloatingPosition(): DevDebugFloatingPosition {
    const viewport = getViewportSize();
    return clampFloatingPosition({
        x: FLOATING_SAFE_MARGIN,
        y: viewport.height - FLOATING_BUTTON_SIZE - FLOATING_SAFE_MARGIN,
    });
}

function getPanelPosition(position: DevDebugFloatingPosition): DevDebugFloatingPosition {
    const viewport = getViewportSize();
    const panelWidth = Math.min(PANEL_WIDTH, viewport.width - FLOATING_SAFE_MARGIN * 2);
    const panelHeight = Math.min(PANEL_ESTIMATED_HEIGHT, viewport.height - FLOATING_SAFE_MARGIN * 2);
    return {
        x: clamp(position.x, FLOATING_SAFE_MARGIN, viewport.width - panelWidth - FLOATING_SAFE_MARGIN),
        y: clamp(position.y, FLOATING_SAFE_MARGIN, viewport.height - panelHeight - FLOATING_SAFE_MARGIN),
    };
}

const ToggleRow: React.FC<{
    title: string;
    detail?: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}> = ({ title, detail, checked, onChange }) => (
    <div className="flex items-center justify-between gap-4 py-3">
        <div className="min-w-0">
            <div className="text-[13px] font-bold text-white">{title}</div>
            {detail && <div className="mt-1 text-[11px] leading-relaxed text-white/55">{detail}</div>}
        </div>
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
                checked
                    ? 'border-amber-300/60 bg-amber-300/80'
                    : 'border-white/15 bg-white/10'
            }`}
        >
            <span
                className={`absolute left-1 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform ${
                    checked ? 'translate-x-5' : 'translate-x-0'
                }`}
            />
        </button>
    </div>
);

// 类别用紧凑 checkbox「并排」摆（无说明，看不懂就别用），跟总开关那种 switch 区分开。
const CheckboxChip: React.FC<{
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}> = ({ label, checked, onChange }) => (
    <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex items-center gap-2"
    >
        <span
            className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                checked
                    ? 'border-amber-300/70 bg-amber-300/80 text-black'
                    : 'border-white/25 bg-white/5 text-transparent'
            }`}
        >
            <Check size={12} weight="bold" />
        </span>
        <span className="text-[13px] font-bold text-white">{label}</span>
    </button>
);

// 复制 / 下载 / 未来其它日志动作共享同一种胶囊按钮——抽出来免得两套 className 28 行各自跑偏。
const LogActionButton: React.FC<{
    onClick: () => void;
    disabled: boolean;
    icon: React.ReactNode;
    label: React.ReactNode;
}> = ({ onClick, disabled, icon, label }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[11px] font-bold transition-colors ${
            disabled
                ? 'bg-white/5 text-white/25'
                : 'bg-white/10 text-white/75 active:scale-95'
        }`}
    >
        {icon}
        {label}
    </button>
);

const DevDebugPanel: React.FC = () => {
    const [open, setOpen] = useState(false);
    const [available, setAvailable] = useState(() => isDevDebugAvailable());
    const [flags, setFlags] = useState<DevDebugFlags>(() => readDevDebugFlags());
    const [logCount, setLogCount] = useState(() => readDevDebugLog().length);
    const [copied, setCopied] = useState(false);
    // 位置不持久化：每次出现都回默认角，拖动只在本次会话内有效（prod 刷新=失效=类似关闭，没必要存）。
    const [floatingPosition, setFloatingPosition] = useState<DevDebugFloatingPosition>(getDefaultFloatingPosition);
    const dragStateRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        origin: DevDebugFloatingPosition;
        moved: boolean;
    } | null>(null);
    const suppressClickRef = useRef(false);

    useEffect(() => subscribeDevDebugFlags(setFlags), []);
    // 解锁时（false→true）从 storage 重读 flags：mount 时 isDevDebugAvailable() 为 false 的话
    // useState 拿到的是 DEFAULT_DEV_DEBUG_FLAGS（canUseDevDebugStorage gate 不放行），
    // 后续 unlock 不刷新就会用户改一个开关 → writeDevDebugFlags({...DEFAULT, [k]:v}) 覆盖掉
    // localStorage 里其他配置。这里在变可用时再读一次兜底。
    useEffect(() => subscribeDevDebugAvailability((next) => {
        setAvailable(next);
        if (next) setFlags(readDevDebugFlags());
    }), []);
    // logCount 只在面板展开时才用得到（复制 (N) 按钮），收起 / 不可用都不订阅——
    // 避免 instant-push 高频 append 时每条都触发整个 panel re-render。
    useEffect(() => {
        if (!open) return;
        setLogCount(readDevDebugLog().length); // open 时拉一次最新值
        return subscribeDevDebugLog((entries) => setLogCount(entries.length));
    }, [open]);
    // 视口 resize / scroll 只在面板可见时跟随——!available 阶段不挂监听器，避免 mobile
    // 地址栏伸缩高频触发 setState 把整个 panel re-render（即使它返回 null）。
    useEffect(() => {
        if (!available) return;
        const clampToViewport = () => {
            setFloatingPosition((current) => {
                const next = clampFloatingPosition(current);
                // 同样的 {x,y} 还要返回原对象，免得 React 因为 Object.is 失败而每次 commit。
                return (next.x === current.x && next.y === current.y) ? current : next;
            });
        };
        window.addEventListener('resize', clampToViewport);
        window.visualViewport?.addEventListener('resize', clampToViewport);
        window.visualViewport?.addEventListener('scroll', clampToViewport);
        return () => {
            window.removeEventListener('resize', clampToViewport);
            window.visualViewport?.removeEventListener('resize', clampToViewport);
            window.visualViewport?.removeEventListener('scroll', clampToViewport);
        };
    }, [available]);

    const activeCount = useMemo(
        () => (flags.skipPromptBuild ? 1 : 0)
            + (flags.skipEmotionEval ? 1 : 0)
            // 「在录」= 总开关开 且 至少勾了一类——否则浮球红点会骗人「在录」其实 isCaptureEnabled
            // 任何类别都返 false。
            + (flags.captureEnabled && flags.captureLogs.length > 0 ? 1 : 0)
            // exposeLogDetail 只在录制实际生效时才计（同上）。
            + (flags.captureEnabled && flags.captureLogs.length > 0 && flags.exposeLogDetail ? 1 : 0),
        [flags],
    );
    // 用 read-write-set 三步：从 localStorage 读 source of truth → 写回 → 同步 React state。
    // 不在 setFlags(updater) 里做副作用——updater 必须是纯函数（StrictMode / concurrent
    // 会让 updater 重跑），副作用塞进去会重复 dispatch / 重复写盘。这套写法同时绕开了 React
    // 闭包的 stale-flags 问题（双标签页 storage 事件 + 用户点击 race），因为 read 拿的是
    // localStorage 当前值。
    const updateFlag = <K extends keyof DevDebugFlags,>(key: K, value: DevDebugFlags[K]) => {
        const next = { ...readDevDebugFlags(), [key]: value };
        setFlags(writeDevDebugFlags(next));
    };
    const toggleCapture = (category: DevDebugCaptureCategory, checked: boolean) => {
        const current = readDevDebugFlags();
        const next = {
            ...current,
            captureLogs: checked
                ? [...current.captureLogs, category]
                : current.captureLogs.filter((item) => item !== category),
        };
        setFlags(writeDevDebugFlags(next));
    };
    const resetFlags = () => {
        // 重置 = 回默认（总开关关 + 清空勾选）+ 清空所有日志，比「全不勾」更彻底。
        // 注：writeDevDebugFlags 内部检测到 captureEnabled true→false 也会清日志，这里显式 clear
        // 是为了「即便上次就是 false」时也保证清干净（重置语义包含清理日志）。
        setFlags(writeDevDebugFlags(DEFAULT_DEV_DEBUG_FLAGS));
        clearDevDebugLog();
    };
    const handleForceClose = () => {
        // 「关闭」= 收起 + 位置回默认（纯内存）+ 强制关掉；任意分支生效，里面的开关另存不动。
        setOpen(false);
        setFloatingPosition(getDefaultFloatingPosition());
        closeDevDebug();
    };
    const copyLog = async () => {
        const text = formatDevDebugLog();
        if (!text) return;
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
    };
    const downloadLog = () => {
        const text = formatDevDebugLog();
        if (!text) return;
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        anchor.href = url;
        anchor.download = `devdebug-log-${__BUILD_BRANCH__}-${stamp}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    };
    const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (open || (event.pointerType === 'mouse' && event.button !== 0)) return;
        dragStateRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            origin: floatingPosition,
            moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragStateRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;

        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
            drag.moved = true;
        }

        if (drag.moved) {
            event.preventDefault();
            setFloatingPosition(clampFloatingPosition({
                x: drag.origin.x + dx,
                y: drag.origin.y + dy,
            }));
        }
    };
    const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragStateRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;

        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const next = clampFloatingPosition({
            x: drag.origin.x + dx,
            y: drag.origin.y + dy,
        });
        dragStateRef.current = null;
        suppressClickRef.current = drag.moved;

        if (drag.moved) {
            event.preventDefault();
            setFloatingPosition(next);
            window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        }

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };
    const handleFloatingClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (suppressClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClickRef.current = false;
            return;
        }
        setOpen(true);
    };

    if (!available) return null;

    const panelPosition = getPanelPosition(floatingPosition);
    // 面板最大高度按「实际可视高度」算（visualViewport，避开手机动态工具栏），跟定位口径一致，超出部分中间滚动。
    const panelMaxHeight = getViewportSize().height - FLOATING_SAFE_MARGIN * 2;

    return (
        <div
            className="fixed select-none"
            style={{
                left: open ? panelPosition.x : floatingPosition.x,
                top: open ? panelPosition.y : floatingPosition.y,
                zIndex: 2147483646,
            }}
        >
            {!open && (
                <button
                    type="button"
                    aria-label="打开调试面板"
                    onClick={handleFloatingClick}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={finishDrag}
                    onPointerCancel={finishDrag}
                    className="relative flex h-11 w-11 cursor-grab touch-none items-center justify-center rounded-full border border-white/15 bg-black/45 text-white shadow-lg backdrop-blur-md active:scale-95 active:cursor-grabbing"
                >
                    <Wrench size={20} weight="bold" />
                    {activeCount > 0 && (
                        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-300 px-1 text-[10px] font-black leading-none text-black">
                            {activeCount}
                        </span>
                    )}
                </button>
            )}

            {open && (
                <section
                    className="flex w-[min(342px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-white/12 bg-zinc-950/90 text-white shadow-2xl backdrop-blur-xl"
                    style={{ maxHeight: panelMaxHeight }}
                    aria-label="开发调试面板"
                >
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-amber-200">
                                <Wrench size={17} weight="bold" />
                            </div>
                            <div className="min-w-0">
                                <div className="text-sm font-black leading-tight">Dev Debug</div>
                                <div className="truncate font-mono text-[10px] text-white/40">
                                    {BUILD_LABEL}
                                </div>
                            </div>
                        </div>
                        <button
                            type="button"
                            aria-label="关闭调试面板"
                            onClick={() => setOpen(false)}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/70 active:scale-95"
                        >
                            <X size={15} weight="bold" />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto px-4">
                        <ToggleRow
                            title="跳过 Prompt Build"
                            detail="只发送聊天历史。"
                            checked={flags.skipPromptBuild}
                            onChange={(checked) => updateFlag('skipPromptBuild', checked)}
                        />
                        <div className="h-px bg-white/10" />
                        <ToggleRow
                            title="暂停情绪副评估"
                            detail="主回复仍照常发送，但不启动本地或 Instant Push 的 emotion eval。"
                            checked={flags.skipEmotionEval}
                            onChange={(checked) => updateFlag('skipEmotionEval', checked)}
                        />
                        <div className="h-px bg-white/10" />

                        {/* 记录日志：总开关；打开后才露出 类型 / 记录完整 / 复制 / 下载 一整套 —— 关掉时整段收起。
                            true→false 时清空日志这一步在 writeDevDebugFlags 数据层做，这里走通用 updateFlag。 */}
                        <ToggleRow
                            title="记录日志"
                            checked={flags.captureEnabled}
                            onChange={(checked) => updateFlag('captureEnabled', checked)}
                        />
                        {flags.captureEnabled && (
                            <>
                                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pb-3 pl-0.5">
                                    {DEV_DEBUG_CAPTURE_CATEGORIES.map((category) => (
                                        <CheckboxChip
                                            key={category.key}
                                            label={category.title}
                                            checked={flags.captureLogs.includes(category.key)}
                                            onChange={(checked) => toggleCapture(category.key, checked)}
                                        />
                                    ))}
                                </div>
                                <div className="mt-1 mb-3 flex gap-2">
                                    <LogActionButton
                                        onClick={copyLog}
                                        disabled={logCount === 0}
                                        icon={<ClipboardText size={13} weight="bold" />}
                                        label={copied ? '已复制' : logCount > 0 ? `复制 (${logCount})` : '暂无日志'}
                                    />
                                    <LogActionButton
                                        onClick={downloadLog}
                                        disabled={logCount === 0}
                                        icon={<DownloadSimple size={13} weight="bold" />}
                                        label="下载"
                                    />
                                    {/* 「清空」只清日志，不动开关 / 勾选；区别于「重置」（连开关一起回默认）和关掉总开关（清完后类型 UI 也收起）。 */}
                                    <LogActionButton
                                        onClick={() => clearDevDebugLog()}
                                        disabled={logCount === 0}
                                        icon={<Trash size={13} weight="bold" />}
                                        label="清空"
                                    />
                                </div>
                                <div className="h-px bg-white/10" />
                                <ToggleRow
                                    title="记录完整内容"
                                    detail="只对新条目生效"
                                    checked={flags.exposeLogDetail}
                                    onChange={(checked) => updateFlag('exposeLogDetail', checked)}
                                />
                            </>
                        )}
                    </div>

                    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
                        <button
                            type="button"
                            onClick={handleForceClose}
                            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-white/10 px-3 text-[11px] font-bold text-white/70 active:scale-95"
                        >
                            <Power size={13} weight="bold" />
                            关闭
                        </button>
                        <button
                            type="button"
                            onClick={resetFlags}
                            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-white/10 px-3 text-[11px] font-bold text-white/70 active:scale-95"
                        >
                            <ArrowsClockwise size={13} weight="bold" />
                            重置
                        </button>
                    </div>
                </section>
            )}
        </div>
    );
};

export default DevDebugPanel;

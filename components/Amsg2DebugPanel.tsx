import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
const AmsgReproductionPanel = lazy(() => import('./AmsgReproductionPanel'));
import { createPortal } from 'react-dom';
import { CornersIn, CornersOut, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import Modal from './os/Modal';
import {
    buildAmsg2DebugTasks,
    clampPanelPosition,
    formatCountdown,
    DEBUG_PANEL_MARGIN_PX,
    type Amsg2DebugTaskView,
    type Amsg2PanelPosition,
} from '../utils/amsg2DebugView';
import {
    formatFullTraceLog,
    readAllInstantTraces,
    readRecentInstantTraces,
} from '../utils/instantTraceLog';
import { shareOrDownloadBlob } from '../utils/shareExport';
import { summarizeChannelHealth, type SwChannelHealth } from '../utils/swChannelProbe';
import {
    describeExpirePolicy,
    describeRecurrence,
    describeTaskMode,
} from '../utils/amsg2Tasks';
import {
    isDevDebugAvailable,
    readDevDebugFlags,
    subscribeDevDebugAvailability,
    subscribeDevDebugFlags,
    writeDevDebugFlags,
} from '../utils/devDebug';

// 倒计时只显示到秒，1s 一跳就够——500ms 的话有一半重绘画出来的字是一样的。
const REDRAW_MS = 1_000;
const TRACE_RELOAD_MS = 2_000;
const TRACE_SHOWN = 5;

const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

/** 列表里的时间：今天只写钟点，明天写「明天」，再远带上日期。看的是用户自己的钟。 */
function whenLabel(ms: number, nowMs: number): string {
    const dayStart = (value: number) => new Date(value).setHours(0, 0, 0, 0);
    const days = Math.round((dayStart(ms) - dayStart(nowMs)) / 86_400_000);
    if (days === 0) return hhmm(ms);
    if (days === 1) return `明天 ${hhmm(ms)}`;
    const date = new Date(ms);
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm(ms)}`;
}

type TraceEntry = ReturnType<typeof readRecentInstantTraces>[number];

// 技术记录里给送达相关的事件上色：作废 / 吞没 / 失败是橙的（消息没发出去），收到是绿的。
function traceTone(event: string): string {
    // 防穿帮闸的「放行了」和「没跑」都是正常结局，名字里带 expire 但不该刷成告警色——
    // 一屏橙色的话，真正要找的那条（吞掉）反而不显眼了。这两条排在下面那行之前。
    if (/expire-decision-pass|expire-gate-skipped/i.test(event)) return 'text-slate-400';
    if (/expire|swallow|fail|error|timeout/i.test(event)) return 'text-amber-600';
    if (/receiv|deliver|ok|success/i.test(event)) return 'text-emerald-600';
    return 'text-slate-400';
}

/** 倒计时里的数字放大、单位缩小，一眼先看到「几」。 */
const Countdown: React.FC<{ text: string }> = ({ text }) => (
    <span className="tabular-nums">
        {text.split(/(\d+)/).filter(Boolean).map((part, index) => (/^\d+$/.test(part)
            ? <span key={index} className="text-[34px] leading-none font-light tracking-tight">{part}</span>
            : <span key={index} className="text-sm text-slate-400 mx-0.5">{part.trim()}</span>))}
    </span>
);

/** 最近要发的那一条，占面板的主视觉。 */
const NextUp: React.FC<{ view: Amsg2DebugTaskView; nowMs: number }> = ({ view, nowMs }) => {
    const { task, state, occurrenceMs, cronTickMs } = view;
    return (
        <div className="px-1 pt-1 pb-3">
            <div className="text-xs font-bold text-slate-500">{view.charName}的下一条</div>
            {occurrenceMs == null ? (
                <div className="mt-2 text-sm text-rose-500">时间读不出来：{task.firstSendTime}</div>
            ) : state === 'firing' ? (
                <div className="mt-1.5 flex items-center gap-2 text-primary">
                    <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                    <span className="text-2xl font-light">正在准备</span>
                </div>
            ) : (
                <div className="mt-1 text-primary"><Countdown text={formatCountdown(occurrenceMs - nowMs)} /></div>
            )}
            {/* 「开始写」不是「送达」：cron 到点只负责把任务捞起来开始生成，消息还要等 AI 写完才推出去。 */}
            {occurrenceMs != null && (
                <p className="mt-1.5 text-xs text-slate-500">
                    {state === 'firing'
                        ? `原定 ${hhmm(occurrenceMs)}，写好就推送`
                        : `${whenLabel(cronTickMs ?? occurrenceMs, nowMs)} 开始写，写好就推送`}
                </p>
            )}
            <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{describeRecurrence(task.recurrenceType)}</span>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{describeExpirePolicy(task.expirePolicy)}</span>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 max-w-full truncate">{describeTaskMode(task)}</span>
            </div>
            {!view.charEnabled && <p className="mt-2 text-xs text-amber-600">这个角色的主动消息关着，到点也不会发。</p>}
            {task.lastError && <p className="mt-2 text-xs text-rose-500 break-all">上次出错：{task.lastError}</p>}
        </div>
    );
};

const TaskRow: React.FC<{ view: Amsg2DebugTaskView; nowMs: number }> = ({ view, nowMs }) => {
    const { task, state, occurrenceMs } = view;
    const dead = state === 'expired' || state === 'cancelled';
    return (
        <li className="py-2 flex items-baseline justify-between gap-3 text-[13px]">
            <span className={`min-w-0 truncate ${dead ? 'text-slate-400' : 'text-slate-700'}`}>
                {view.charName}
                {!view.charEnabled && <span className="ml-1.5 text-[11px] text-amber-600">已关</span>}
                {task.lastError && <span className="ml-1.5 text-[11px] text-rose-500">出过错</span>}
            </span>
            {/* 过点的只说「原定几点」，不说「没发」：这里纯本地推算、不查远端，发没发它并不知道。
                要分辨发没发，看设置面板里那条任务的进度（它会拿远端底账对账）。 */}
            <span className="shrink-0 tabular-nums text-slate-400">
                {occurrenceMs == null ? '时间有误'
                    : state === 'firing' ? <span className="text-primary">正在准备</span>
                        : dead ? `${state === 'cancelled' ? '已取消' : '原定'} ${whenLabel(occurrenceMs, nowMs)}`
                            : whenLabel(occurrenceMs, nowMs)}
            </span>
        </li>
    );
};

const HeaderButton: React.FC<{
    onClick: () => void;
    label: string;
    children: React.ReactNode;
}> = ({ onClick, label, children }) => (
    <button
        type="button"
        aria-label={label}
        onClick={onClick}
        // 标题栏整条是拖动把手，按钮得把 pointerdown 拦下来，否则点全屏 / 关闭会被当成开始拖。
        onPointerDown={(event) => event.stopPropagation()}
        className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 active:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
        {children}
    </button>
);

/** 通知通道一句话体检。iOS 上「实时提醒没接上」几乎是常态：App 不在最前台时 SW 喊不到页面。 */
const HealthLine: React.FC<{ health: SwChannelHealth | null }> = ({ health }) => {
    const [dot, text] = health?.status === 'ok'
        ? ['bg-emerald-500', '通知通道正常']
        : health?.status === 'fallback-only'
            ? ['bg-amber-500', '实时提醒没接上，消息会晚几秒到，不会丢']
            : ['bg-slate-300', '还没收到过消息，暂时看不出通道状况'];
    return (
        <div className="flex items-start gap-2 px-1 text-xs text-slate-500">
            <span className={`mt-[5px] w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
            <span>{text}</span>
        </div>
    );
};

const getViewportSize = () => ({
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
});

/**
 * amsg2 任务的实时观察窗。入口在 Dev Debug 面板里，打开后常驻右上角小窗，
 * 点一下铺满全屏看长列表；关掉聊天时它还在，随时能瞄一眼下一次触发还有多久。
 *
 * 抓标题栏可以把小窗拖到别处：它默认压在右上角，正好盖住聊天页手动触发主动消息的
 * 那颗按钮，而「开着面板等触发」又恰恰是它最常见的用法。位置只活在本次会话里，
 * 关掉重开回默认角（同 DevDebugPanel 的浮球）。
 *
 * 任务数据直接取 OSContext 的 characters（面板挂在 Provider 里面），不轮询 IndexedDB——
 * getAllCharacters 会把整库角色连头像、立绘、世界书一起反序列化出来，而这面板正是「等推送
 * 时开着」的，每两秒来一遍就是往送达路径上压连接。trace 是 localStorage 小字符串，照旧轮询。
 *
 * 渲染走 portal 到 body：面板本体是 fixed 定位，留在 shell 的 transform 子树里会变成相对它
 * 定位、位置飘掉（同 apps/Chat.tsx 的剧场浮层）。
 */
const Amsg2DebugPanel: React.FC = () => {
    const { characters, apiConfig, apiPresets } = useOS();
    const [showReproduction, setShowReproduction] = useState(false);
    const [available, setAvailable] = useState(() => isDevDebugAvailable());
    const [enabled, setEnabled] = useState(() => readDevDebugFlags().amsg2Panel);
    const [fullscreen, setFullscreen] = useState(false);
    const [traces, setTraces] = useState<TraceEntry[]>([]);
    // 缓冲里一共攒了多少条（列表只显示得下最近几条）。导出按钮报的是这个数，
    // 用户才知道自己交出去的是全部现场、不是屏幕上这几行。
    const [traceTotal, setTraceTotal] = useState(0);
    const [traceExport, setTraceExport] = useState<'idle' | 'done' | 'failed'>('idle');
    const [nowMs, setNowMs] = useState(() => Date.now());
    // null = 还没拖过，用默认的右上角；拖过之后记实际坐标。不持久化，关掉重开回默认。
    const [position, setPosition] = useState<Amsg2PanelPosition | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: Amsg2PanelPosition } | null>(null);

    const [health, setHealth] = useState<SwChannelHealth | null>(null);

    useEffect(() => subscribeDevDebugAvailability(setAvailable), []);
    useEffect(() => subscribeDevDebugFlags((flags) => setEnabled(flags.amsg2Panel)), []);

    const active = available && enabled;

    useEffect(() => {
        if (!active) return;
        const readTraces = () => {
            setTraces(readRecentInstantTraces(TRACE_SHOWN));
            const all = readAllInstantTraces();
            setTraceTotal(all.length);
            // 用全部两百条算，而不是上面显示的那几条：通道断没断要看一段时间的走势。
            setHealth(summarizeChannelHealth(all));
        };
        readTraces();
        const timer = window.setInterval(readTraces, TRACE_RELOAD_MS);
        return () => window.clearInterval(timer);
    }, [active]);

    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNowMs(Date.now()), REDRAW_MS);
        return () => window.clearInterval(timer);
    }, [active]);

    // nowMs 每秒变一次，但任务表只在 characters 变了才需要重算——别把 nowMs 塞进依赖里
    // 让整张表每秒重算一遍。状态分界（到点、过宽限）本来就是分钟级的事，晚一拍无所谓。
    const views = useMemo(() => buildAmsg2DebugTasks(characters, Date.now()), [characters]);
    const liveViews = useMemo(() => views.filter((v) => v.state === 'pending' || v.state === 'firing'), [views]);
    const deadViews = useMemo(() => views.filter((v) => v.state === 'expired' || v.state === 'cancelled'), [views]);

    // 转屏 / 手机地址栏伸缩会把拖过的面板推到屏幕外，视口一变就拉回来。
    // 没拖过（position 为 null）时靠 right:8 自己贴边，不用管。
    useEffect(() => {
        if (!active) return;
        const pullBack = () => {
            const panel = panelRef.current;
            if (!panel) return;
            // updater 形式读当前值，不吃闭包里那份——这个 effect 只在 active 变化时重挂。
            setPosition((current) => (current === null ? null : clampPanelPosition(
                current,
                { width: panel.offsetWidth, height: panel.offsetHeight },
                getViewportSize(),
            )));
        };
        window.addEventListener('resize', pullBack);
        window.visualViewport?.addEventListener('resize', pullBack);
        return () => {
            window.removeEventListener('resize', pullBack);
            window.visualViewport?.removeEventListener('resize', pullBack);
        };
    }, [active]);

    const close = () => {
        setFullscreen(false);
        setPosition(null);
        setEnabled(writeDevDebugFlags({ ...readDevDebugFlags(), amsg2Panel: false }).amsg2Panel);
    };

    /**
     * 把整个 trace 缓冲导出成一个 json 文件。
     *
     * 走 shareOrDownloadBlob（跟导出备份同一条路）而不是自己拼 `<a download>`：这个按钮
     * 的使用场景就是「用户在手机上，隔着屏幕把现场发过来」，而原生壳 / iOS PWA 里裸的
     * blob 下载基本是死的——那条路上先试系统分享面板，实在不行才退回浏览器下载。
     * 失败（分享被拒 / 原生插件挂了）就把按钮改成「导出失败」，别假装成功——
     * 用户会以为文件已经在手上了。
     */
    const exportTraces = async () => {
        // 页面侧 + SW 侧合在一起导：只有页面那半截的话，「推送到没到、SW 有没有喊到
        // 页面」全看不见，而这类故障的答案恰恰在那一段。
        const text = await formatFullTraceLog();
        if (!text) return;
        try {
            const result = await shareOrDownloadBlob({
                blob: new Blob([text], { type: 'application/json' }),
                fileName: `sullyos_amsg2_trace_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
                shareTitle: 'SullyOS·糯米机 amsg2 trace',
            });
            // 用户自己在分享面板上点了取消：既不算成功也不是错，按钮回到原样就行。
            if (result === 'cancelled') return;
            setTraceExport('done');
        } catch {
            setTraceExport('failed');
        }
        window.setTimeout(() => setTraceExport('idle'), 1500);
    };

    // 全屏时四边都钉死了，没有可拖的余地。
    const draggable = !fullscreen;

    const dragTo = (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        const panel = panelRef.current;
        if (!drag || !panel || drag.pointerId !== event.pointerId) return null;
        return clampPanelPosition(
            { x: drag.origin.x + (event.clientX - drag.startX), y: drag.origin.y + (event.clientY - drag.startY) },
            { width: panel.offsetWidth, height: panel.offsetHeight },
            getViewportSize(),
        );
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!draggable || (event.pointerType === 'mouse' && event.button !== 0)) return;
        const panel = panelRef.current;
        if (!panel) return;
        // 第一次拖：起点从当前实际位置读（默认态是 right 定位，没有 x/y 可继承），
        // 否则会从 (0,0) 起跳、面板瞬移到左上角。
        const rect = panel.getBoundingClientRect();
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            origin: position ?? { x: rect.left, y: rect.top },
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const next = dragTo(event);
        if (!next) return;
        event.preventDefault();
        setPosition(next);
    };

    const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        const next = dragTo(event);
        dragRef.current = null;
        if (next) setPosition(next);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    if (!active) return null;

    if (showReproduction) return createPortal(
        <div style={{ position: 'fixed', inset: 0, zIndex: 2147483645 }}>
            <Modal isOpen title="测试推送" onClose={() => setShowReproduction(false)}>
                <Suspense fallback={<div className="text-xs text-slate-400">正在打开…</div>}>
                    <AmsgReproductionPanel apiConfig={apiConfig} apiPresets={apiPresets} />
                </Suspense>
            </Modal>
        </div>,
        document.body,
    );

    const [next, ...later] = liveViews;

    return createPortal(
        <div
            ref={panelRef}
            style={{
                position: 'fixed',
                // 没拖过就贴右上角；拖过之后改用左上角坐标定位（right 必须让位，否则宽度被两端撑死）。
                ...(position && !fullscreen
                    ? { top: position.y, left: position.x }
                    : { top: DEBUG_PANEL_MARGIN_PX, right: DEBUG_PANEL_MARGIN_PX }),
                ...(fullscreen
                    ? { left: DEBUG_PANEL_MARGIN_PX, bottom: DEBUG_PANEL_MARGIN_PX }
                    : { width: 'min(300px, calc(100vw - 16px))', maxHeight: '78vh' }),
                zIndex: 2147483645,
            }}
            className="flex flex-col font-sans text-slate-800 bg-white/90 backdrop-blur-xl rounded-[28px] ring-1 ring-slate-900/5 shadow-[0_16px_40px_-12px_rgba(15,23,42,0.35)] p-3"
            role="dialog"
            aria-label="主动消息观察窗"
        >
            {/* 标题栏固定，内容区自己滚——不然列表一长，切全屏 / 关闭的按钮就滚没了。
                这一整条同时是拖动把手：touchAction none 让手机上按住横竖拖都归我们，不被页面滚动抢走。 */}
            <div
                className="shrink-0 flex items-center justify-between pl-1 pb-1"
                style={{ cursor: draggable ? 'grab' : 'default', touchAction: draggable ? 'none' : undefined }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
            >
                <span className="text-[13px] font-bold">
                    主动消息
                    {liveViews.length > 0 && <span className="ml-1.5 font-normal text-slate-400">{liveViews.length} 条待发</span>}
                </span>
                <span className="flex items-center">
                    <HeaderButton onClick={() => setFullscreen((v) => !v)} label={fullscreen ? '缩回小窗' : '铺满全屏'}>
                        {fullscreen ? <CornersIn size={14} weight="bold" /> : <CornersOut size={14} weight="bold" />}
                    </HeaderButton>
                    <HeaderButton onClick={close} label="关闭主动消息观察窗">
                        <X size={14} weight="bold" />
                    </HeaderButton>
                </span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar">
                {next ? <NextUp view={next} nowMs={nowMs} /> : (
                    <div className="px-1 pt-2 pb-4">
                        <p className="text-sm text-slate-600">现在没有排好的主动消息</p>
                        <p className="mt-1 text-xs text-slate-400">角色排了消息后，倒计时会出现在这里。</p>
                    </div>
                )}

                <HealthLine health={health} />

                {(later.length > 0 || deadViews.length > 0) && (
                    <div className="mt-3 pt-1 px-1 border-t border-slate-100">
                        {later.length > 0 && (
                            <ul className="divide-y divide-slate-100">
                                {later.map((view) => <TaskRow key={`${view.charId}:${view.task.taskUuid}`} view={view} nowMs={nowMs} />)}
                            </ul>
                        )}
                        {/* 失效的照样留着：排查「怎么没响」时，看得见那条死任务比它凭空消失有用。 */}
                        {deadViews.length > 0 && (
                            <details className="group text-[13px]">
                                <summary className="py-2 cursor-pointer list-none text-slate-400 flex justify-between">
                                    <span>已过点 {deadViews.length} 条</span>
                                    <span className="inline-block group-open:rotate-90 transition-transform">›</span>
                                </summary>
                                <ul className="divide-y divide-slate-100">
                                    {deadViews.map((view) => <TaskRow key={`${view.charId}:${view.task.taskUuid}`} view={view} nowMs={nowMs} />)}
                                </ul>
                            </details>
                        )}
                    </div>
                )}

                <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={() => setShowReproduction(true)}
                        className="py-2.5 rounded-2xl bg-primary/15 text-primary text-xs font-bold active:scale-95 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                        测试推送
                    </button>
                    {/* 屏幕上只放得下几行，缓冲里其实攒着几百条。远端排障要的是「一小时前
                        那会儿发生了什么」，全靠这个按钮把它们交出来；按钮上的数字就是交出去的全部条数。 */}
                    <button
                        type="button"
                        onClick={exportTraces}
                        disabled={traceTotal === 0}
                        className={`py-2.5 rounded-2xl bg-slate-100 text-xs font-bold active:scale-95 transition-transform disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${traceExport === 'failed' ? 'text-rose-500' : 'text-slate-600'}`}
                    >
                        {traceExport === 'done' ? '已导出'
                            : traceExport === 'failed' ? '导出失败'
                                : traceTotal === 0 ? '暂无记录' : `导出记录 ${traceTotal}`}
                    </button>
                </div>

                <details className="group mt-2 px-1">
                    <summary className="py-1.5 cursor-pointer list-none text-[11px] text-slate-400 flex justify-between">
                        <span>技术记录</span>
                        <span className="inline-block group-open:rotate-90 transition-transform">›</span>
                    </summary>
                    <div className="pb-1 font-mono text-[10.5px] leading-relaxed">
                        {health?.lastSwMessageAt && <div className="text-slate-400">上次收到 SW 消息 {hhmmss(new Date(health.lastSwMessageAt).getTime())}</div>}
                        {health && health.flushByTrigger.length > 0 && (
                            <div className="text-slate-400">冲刷来源 {health.flushByTrigger.map((item) => `${item.trigger}×${item.count}`).join(' ')}</div>
                        )}
                        {traces.length === 0 ? <div className="text-slate-400">暂无</div> : traces.map((entry, index) => (
                            <div key={`${entry.ts ?? 'no-ts'}-${index}`} className={`truncate ${traceTone(entry.event ?? '')}`}>
                                {entry.ts ? hhmmss(new Date(entry.ts).getTime()) : '--:--:--'} {entry.event ?? '?'}
                            </div>
                        ))}
                    </div>
                </details>
            </div>
        </div>,
        document.body,
    );
};

export default Amsg2DebugPanel;

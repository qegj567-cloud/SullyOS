import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornersIn, CornersOut, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
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
/** 快到点了：倒计时转绿的阈值。 */
const IMMINENT_MS = 60_000;

// GitHub Dark 的配色，等宽字 + 深底——这面板是当调试终端看的，跟 app 本身的视觉分开。
// 走内联 style 不走 Tailwind：这些是精确色值，项目的调色板里没有对应色阶。
const C = {
    fg: '#e6edf3',
    dim: '#8b949e',
    line: '#21262d',
    border: '#2b3a55',
    bg: 'rgba(10,12,20,.93)',
    green: '#7ee787',
    blue: '#58a6ff',
    orange: '#f0883e',
    red: '#f85149',
    yellow: '#d29922',
} as const;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

type TraceEntry = ReturnType<typeof readRecentInstantTraces>[number];

// 送达相关的事件挑出来上色：作废 / 吞没 / 失败是橙的（消息没发出去），收到是绿的。
function traceColor(event: string): string {
    // 防穿帮闸的「放行了」和「没跑」都是正常结局，名字里带 expire 但不该刷成告警色——
    // 一屏橙色的话，真正要找的那条（吞掉）反而不显眼了。这两条排在下面那行之前。
    if (/expire-decision-pass|expire-gate-skipped/i.test(event)) return C.dim;
    if (/expire|swallow|fail|error|timeout/i.test(event)) return C.orange;
    if (/receiv|deliver|ok|success/i.test(event)) return C.green;
    return C.dim;
}

/** 一条任务的主色：正在发 > 快到点 > 还早；失效的一律沉成灰。 */
function taskColor(view: Amsg2DebugTaskView, nowMs: number): string {
    if (view.state === 'expired' || view.state === 'cancelled') return C.dim;
    if (view.state === 'firing') return C.orange;
    if (view.occurrenceMs != null && view.occurrenceMs - nowMs < IMMINENT_MS) return C.green;
    return C.blue;
}

const TaskRow: React.FC<{ view: Amsg2DebugTaskView; nowMs: number }> = ({ view, nowMs }) => {
    const { task, state, occurrenceMs, cronTickMs } = view;
    const dead = state === 'expired' || state === 'cancelled';
    const color = taskColor(view, nowMs);

    return (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: '5px 0' }}>
            {occurrenceMs == null ? (
                <div style={{ color: C.red }}>触发时间解析不了：{task.firstSendTime}</div>
            ) : dead ? (
                // 只说「已过点」，不说「未发」：这个面板是纯本地派生、不查远端，发没发它并不知道。
                // 断言成「未发」会把排查带偏——实测就有过任务其实早被 worker 消费掉、面板却写着未发。
                // 要分辨发没发，看设置面板里那条任务的进度（它会拿远端底账对账）。
                <div style={{ color: C.dim }}>
                    {view.charName} · {state === 'cancelled' ? '已取消' : '已过点'} · 原定 {hhmmss(occurrenceMs)}
                </div>
            ) : (
                <>
                    <div style={{ fontSize: 17, fontWeight: 700, color }}>
                        {formatCountdown(occurrenceMs - nowMs)}
                        {state === 'firing' && <span style={{ fontSize: 11 }}> 触发窗口内</span>}
                    </div>
                    {/* 「开跑」不是「送达」：cron 到点只负责把任务捞起来开始生成，
                        消息还要等 LLM 出完内容才推出去。 */}
                    <div style={{ color: C.dim }}>
                        {view.charName} · {cronTickMs != null ? hhmmss(cronTickMs) : '—'} 开跑
                        {!view.charEnabled && <span style={{ color: C.red }}> [已关]</span>}
                    </div>
                </>
            )}

            {/* 这条任务到底要干嘛：文案调 amsg2Tasks 的现成函数，跟角色上下文块、
                list_active_messages 工具、设置面板说的是同一套词。 */}
            <div style={{ color: C.dim }}>
                {describeTaskMode(task)}·{describeRecurrence(task.recurrenceType)}·{describeExpirePolicy(task.expirePolicy)}
            </div>

            {task.lastError && <div style={{ color: C.red }}>↳ {task.lastError}</div>}
        </div>
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
        style={{ color: C.dim, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
    >
        {children}
    </button>
);

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
    const { characters } = useOS();
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
    const liveCount = useMemo(
        () => views.filter((v) => v.state === 'pending' || v.state === 'firing').length,
        [views],
    );

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
                    : { width: 'min(330px, calc(100vw - 16px))', maxHeight: '78vh' }),
                zIndex: 2147483645,
                display: 'flex',
                flexDirection: 'column',
                background: C.bg,
                color: C.fg,
                font: `12px/1.45 ${MONO}`,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: '10px 12px',
                boxShadow: '0 6px 24px rgba(0,0,0,.45)',
                backdropFilter: 'blur(4px)',
            }}
            role="dialog"
            aria-label="amsg2 调试面板"
        >
            {/* 标题栏固定，内容区自己滚——不然列表一长，切全屏 / 关闭的按钮就滚没了。
                这一整条同时是拖动把手：touchAction none 让手机上按住横竖拖都归我们，不被页面滚动抢走。 */}
            <div
                style={{
                    flexShrink: 0,
                    cursor: draggable ? 'grab' : 'default',
                    touchAction: draggable ? 'none' : undefined,
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <b style={{ color: C.green }}>⏱ amsg2 debug</b>
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <HeaderButton
                            onClick={() => setFullscreen((v) => !v)}
                            label={fullscreen ? '缩回小窗' : '铺满全屏'}
                        >
                            {fullscreen ? <CornersIn size={13} weight="bold" /> : <CornersOut size={13} weight="bold" />}
                        </HeaderButton>
                        <HeaderButton onClick={close} label="关闭 amsg2 调试面板">
                            <X size={13} weight="bold" />
                        </HeaderButton>
                    </span>
                </div>
                <div style={{ color: C.dim, marginBottom: 6 }}>
                    now {hhmmss(nowMs)} · cron 每整分 · 待触发 {liveCount}/{views.length}
                </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                {views.length === 0 ? (
                    <div style={{ color: C.dim }}>（无 amsg2 任务）</div>
                ) : (
                    views.map((view) => (
                        <TaskRow key={`${view.charId}:${view.task.taskUuid}`} view={view} nowMs={nowMs} />
                    ))
                )}

                <div
                    style={{
                        borderTop: `1px solid ${C.line}`,
                        marginTop: 6,
                        paddingTop: 5,
                        color: C.yellow,
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: 8,
                    }}
                >
                    <span>
                        <b>trace</b>
                        <span style={{ color: C.dim, fontSize: 11 }}> 最近 {TRACE_SHOWN} 条 · 无条件记录</span>
                    </span>
                    {/* 下面列表只显示得下几行，缓冲里其实攒着两百条。远端排障要的是「一小时前
                        那会儿发生了什么」，全靠这个按钮把它们交出来。 */}
                    <button
                        type="button"
                        onClick={exportTraces}
                        disabled={traceTotal === 0}
                        style={{
                            color: traceExport === 'failed' ? C.red : C.dim,
                            fontSize: 11,
                            cursor: traceTotal === 0 ? 'default' : 'pointer',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                        }}
                    >
                        {traceExport === 'done' ? '已导出'
                            : traceExport === 'failed' ? '导出失败'
                                : traceTotal === 0 ? '暂无' : `导出全部 (${traceTotal})`}
                    </button>
                </div>
                {/* 实时通道的体检结论。放在最显眼处是因为这条腿断了之后功能表面上还是好的——
                    消息照样到，只是慢那么几秒，用户多半当成「网络卡」而不会来报。
                    iOS 上这条几乎必然是断的：App 不在最前台时 SW 拿到的页面名单就是空的。 */}
                {health && health.status !== 'idle' && (
                    <div
                        style={{
                            fontSize: 11,
                            marginBottom: 3,
                            color: health.status === 'ok' ? C.dim : C.red,
                        }}
                    >
                        {health.status === 'ok'
                            ? `实时通道正常 · 上次收到 SW 消息 ${hhmmss(new Date(health.lastSwMessageAt!).getTime())}`
                            : '⚠ 没收到过 SW 实时通知，消息靠本地巡查自己捞（会慢几秒，不会丢）'}
                        {health.flushByTrigger.length > 0 && (
                            <span style={{ color: C.dim }}>
                                {' · 冲刷来源 '}
                                {health.flushByTrigger.map((item) => `${item.trigger}×${item.count}`).join(' ')}
                            </span>
                        )}
                    </div>
                )}
                {traces.length === 0 ? (
                    <div style={{ color: C.dim, fontSize: 11 }}>（暂无）</div>
                ) : (
                    traces.map((entry, index) => (
                        <div
                            key={`${entry.ts ?? 'no-ts'}-${index}`}
                            style={{ fontSize: 11, color: traceColor(entry.event ?? '') }}
                        >
                            {entry.ts ? hhmmss(new Date(entry.ts).getTime()) : '--:--:--'} {entry.event ?? '?'}
                        </div>
                    ))
                )}
            </div>
        </div>,
        document.body,
    );
};

export default Amsg2DebugPanel;

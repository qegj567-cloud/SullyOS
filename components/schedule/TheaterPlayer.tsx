
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { CharacterProfile, ScheduleSlot, TheaterLine } from '../../types';
import TokenImg from '../os/TokenImg';
import { useBlobRefUrl } from '../../utils/blobRef';

interface TheaterPlayerProps {
    character: CharacterProfile | null;
    slot: ScheduleSlot | null;
    lines: TheaterLine[] | null;   // null / 空 = 还在生成
    isGenerating: boolean;
    error?: string;
    onReplay: () => void;          // 重演（重新生成）
    // 把这段演出作为卡片留痕到聊天。两态都留痕、角色都知道自己干了啥；
    // exposed=true → TA 会发现你在偷看；exposed=false → TA 不知道你看了。
    onSendCard?: (exposed: boolean) => void;
    onClose: () => void;
}

const TYPE_SPEED_MS = 38;       // 每个字的打字间隔
const LINE_GAP_MS = 520;        // 一行打完到下一行开始的停顿

// 观测模式整体走赛博紫色调（与截图一致，不依赖角色 themeColor）。
const HUE = 262;

/** 由该时段开始时间，给每一拍合成一个「行为轨迹」时间戳（HH:MM:SS，逐拍递增），纯展示用。 */
function beatClock(startTime: string | undefined, index: number): string {
    const [h, m] = (startTime || '00:00').split(':').map(n => parseInt(n, 10));
    const base = (Number.isFinite(h) ? h : 0) * 3600 + (Number.isFinite(m) ? m : 0) * 60;
    const t = base + index * 17;   // 每拍约 17s，18 拍≈5 分钟，像一段被同步下来的轨迹
    const hh = Math.floor(t / 3600) % 24;
    const mm = Math.floor((t % 3600) / 60);
    const ss = t % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

const TheaterPlayer: React.FC<TheaterPlayerProps> = ({
    character, slot, lines, isGenerating, error, onReplay, onSendCard, onClose,
}) => {
    const dialog = useRef<HTMLDialogElement>(null);
    useLayoutEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);
    useLocalBackHandler(() => { onClose(); return true; }, 70);
    const accent = `hsl(${HUE}, 75%, 72%)`;
    const charName = character?.name || '角色';
    // 背景那层是 CSS 背景图，没有 <img> 帮忙解析，在组件顶层先把令牌解开
    const avatarUrl = useBlobRefUrl(character?.avatar);

    // 已完整显示的行数；当前正在打字的行 = shownCount（索引）
    const [shownCount, setShownCount] = useState(0);     // 已完成打字的行数
    const [typed, setTyped] = useState('');              // 当前行已打出的文本
    const [finished, setFinished] = useState(false);
    const [confirmingReplay, setConfirmingReplay] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<number | null>(null);

    const total = lines?.length ?? 0;
    const currentLine = lines && shownCount < total ? lines[shownCount] : null;

    const clearTimer = () => {
        if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    };

    // 重置播放进度（lines 变化 = 新一段演出 / 重演）
    useEffect(() => {
        clearTimer();
        setShownCount(0);
        setTyped('');
        setFinished(false);
        setConfirmingReplay(false);
    }, [lines]);

    // 打字机：逐字推进当前行，打完停顿后进入下一行
    useEffect(() => {
        if (!lines || shownCount >= total) {
            if (lines && total > 0 && shownCount >= total) setFinished(true);
            return;
        }
        const full = currentLine?.text ?? '';
        if (typed.length < full.length) {
            timerRef.current = window.setTimeout(() => {
                setTyped(full.slice(0, typed.length + 1));
            }, TYPE_SPEED_MS);
        } else {
            // 当前行打完，停顿后进入下一行
            timerRef.current = window.setTimeout(() => {
                setShownCount(c => c + 1);
                setTyped('');
            }, LINE_GAP_MS);
        }
        return clearTimer;
    }, [lines, shownCount, typed, total, currentLine]);

    // 自动滚到底（最新一拍）
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [shownCount, typed]);

    // 点击：当前行没打完 → 立刻补全；已打完 → 直接跳到结尾全显
    const handleAdvance = useCallback(() => {
        if (!lines || finished) return;
        const full = currentLine?.text ?? '';
        if (typed.length < full.length) {
            clearTimer();
            setTyped(full);
        } else {
            clearTimer();
            setShownCount(total);
            setTyped('');
            setFinished(true);
        }
    }, [lines, finished, currentLine, typed, total]);

    const completedLines = lines ? lines.slice(0, shownCount) : [];
    const headTime = useMemo(() => beatClock(slot?.startTime, Math.max(0, (finished ? total : shownCount) - 1)), [slot?.startTime, finished, total, shownCount]);

    return (
        <dialog ref={dialog} aria-label="日程小剧场" className="m-0 w-full h-full max-w-none max-h-none p-0 border-0"
            onCancel={event => { event.preventDefault(); onClose(); }}>
        <div
            className="fixed inset-0 z-[120] flex flex-col overflow-hidden text-white"
            style={{ background: `radial-gradient(130% 90% at 50% -5%, hsl(${HUE},42%,15%), hsl(${HUE},48%,7%) 62%, #050409)` }}
        >
            {/* 背景：角色看板图做底，重压暗 + 紫，营造「赛博后台」氛围 */}
            {avatarUrl && (
                <div
                    className="absolute inset-0 pointer-events-none"
                    style={{
                        backgroundImage: `url(${avatarUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        filter: 'blur(34px) saturate(0.7)',
                        opacity: 0.22,
                    }}
                />
            )}
            <div className="absolute inset-0 pointer-events-none" style={{ background: `linear-gradient(180deg, hsla(${HUE},45%,6%,0.35), hsla(${HUE},50%,5%,0.82))` }} />
            {/* 星点 / 噪点 */}
            <div className="absolute inset-0 pointer-events-none opacity-50" style={{ backgroundImage: 'radial-gradient(1px 1px at 18% 22%,rgba(200,180,255,.5),transparent),radial-gradient(1px 1px at 72% 14%,rgba(220,200,255,.4),transparent),radial-gradient(1px 1px at 44% 64%,rgba(180,200,255,.35),transparent),radial-gradient(1px 1px at 88% 78%,rgba(210,190,255,.4),transparent)' }} />

            {/* ===== 顶部 HUD ===== */}
            <div className="relative flex-shrink-0 px-4 pt-4 pb-2">
                {/* OBSERVATION MODE · LIVE */}
                <div className="flex items-center justify-between mb-3">
                    <span className="text-[10px] font-bold tracking-[0.3em] uppercase" style={{ color: `hsl(${HUE},55%,72%)`, opacity: 0.65 }}>
                        ◇ Observation Mode
                    </span>
                    <div className="flex items-center gap-2">
                        <span className="inline-block h-px w-10 opacity-30" style={{ background: `linear-gradient(90deg,transparent,${accent})` }} />
                        <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border" style={{ borderColor: 'rgba(255,90,120,0.5)', background: 'rgba(255,90,120,0.12)' }}>
                            <span className="w-1.5 h-1.5 rounded-full bg-[#ff5a78] animate-pulse" />
                            <span className="text-[10px] font-black tracking-[0.2em] text-[#ff8aa0]">LIVE</span>
                        </span>
                    </div>
                </div>

                {/* 标题行：活动 · 窥视 XX 当前行为 + 关闭 */}
                <div className="flex items-start gap-3">
                    <div
                        className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-lg"
                        style={{ background: `hsl(${HUE},45%,20%)`, border: `1px solid hsl(${HUE},55%,40%)`, boxShadow: `0 0 16px hsla(${HUE},70%,55%,0.3)` }}
                    >
                        {slot?.emoji || '👁'}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold tracking-[0.25em] uppercase text-white/40">Theater</span>
                            <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ background: `hsl(${HUE},50%,24%)`, color: accent }}>
                                {slot?.startTime || headTime.slice(0, 5)}
                            </span>
                        </div>
                        <p className="text-base font-black text-white/95 truncate leading-tight mt-0.5">
                            {slot?.activity || '某个时段'}
                            <span className="text-white/45 text-xs font-medium"> · 窥视 {charName} 当前行为</span>
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-white/55 hover:text-white border border-white/10 hover:bg-white/10 transition-colors"
                        aria-label="关闭"
                    >
                        ✕
                    </button>
                </div>

                {/* 同步状态副标题 */}
                <p className="text-[11px] mt-2 ml-12" style={{ color: `hsl(${HUE},45%,68%)`, opacity: 0.75 }}>
                    {error ? '同步中断' : isGenerating || !lines
                        ? '⟶ 正在同步 TA 的行为轨迹…'
                        : finished
                            ? `✦ 同步完成 · 共截获 ${total} 帧行为`
                            : '⟶ 正在同步 TA 的行为轨迹…'}
                </p>
            </div>

            {/* ===== 主体：左侧目标卡 + 右侧行为时间轴 ===== */}
            <div className="relative flex-1 min-h-0 flex gap-2.5 px-3 pb-2">
                {/* 左：窥视目标 */}
                <aside className="flex-shrink-0 w-[104px] flex flex-col">
                    <div
                        className="rounded-2xl border p-3 flex flex-col items-center"
                        style={{ borderColor: `hsla(${HUE},50%,55%,0.25)`, background: `hsla(${HUE},45%,12%,0.55)`, backdropFilter: 'blur(8px)' }}
                    >
                        {/* 头像 + 光环 */}
                        <div className="relative w-16 h-16">
                            <div className="absolute -inset-1 rounded-full opacity-70 animate-pulse" style={{ background: `conic-gradient(from 0deg, transparent, ${accent}, transparent 70%)`, filter: 'blur(2px)' }} />
                            {character?.avatar ? (
                                <TokenImg value={character.avatar} alt="" className="relative w-16 h-16 rounded-full object-cover border-2" style={{ borderColor: accent }} />
                            ) : (
                                <div className="relative w-16 h-16 rounded-full flex items-center justify-center text-xl font-black border-2" style={{ background: `hsl(${HUE},45%,25%)`, borderColor: accent, color: '#fff' }}>
                                    {charName.slice(0, 1)}
                                </div>
                            )}
                        </div>
                        <p className="mt-2 text-sm font-black text-white/95 text-center truncate w-full" style={{ textShadow: `0 0 12px hsla(${HUE},70%,55%,0.5)` }}>
                            {charName}
                        </p>
                        <span className="mt-0.5 text-[9px] font-bold tracking-[0.15em] uppercase text-white/35">窥视目标</span>
                    </div>

                    {/* 当前环境（仅展示我们真有的字段：地点 / 时刻） */}
                    {(slot?.location || slot?.startTime) && (
                        <div
                            className="mt-2.5 rounded-2xl border p-2.5"
                            style={{ borderColor: `hsla(${HUE},50%,55%,0.2)`, background: `hsla(${HUE},45%,12%,0.5)`, backdropFilter: 'blur(8px)' }}
                        >
                            <p className="text-[9px] font-bold tracking-[0.15em] uppercase text-white/35 mb-1">当前环境</p>
                            {slot?.location && (
                                <p className="text-[11px] text-white/80 leading-snug flex items-start gap-1">
                                    <span style={{ color: accent }}>📍</span>
                                    <span className="min-w-0 break-words">{slot.location}</span>
                                </p>
                            )}
                            {slot?.startTime && (
                                <p className="text-[11px] text-white/55 leading-snug flex items-center gap-1 mt-0.5">
                                    <span style={{ color: accent }}>◷</span>
                                    <span className="font-mono">{slot.startTime}</span>
                                </p>
                            )}
                        </div>
                    )}
                </aside>

                {/* 右：行为时间轴 */}
                <div
                    ref={scrollRef}
                    className="flex-1 min-w-0 overflow-y-auto no-scrollbar pr-0.5"
                    onClick={handleAdvance}
                >
                    {error ? <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-4">
                        <p role="alert" className="text-sm">{error}</p>
                        <button type="button" className="rounded-xl border border-white/30 px-4 py-2" onClick={onReplay}>重试</button>
                    </div> : (isGenerating || !lines) ? (
                        <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-4">
                            <div className="relative w-11 h-11">
                                <div className="absolute inset-0 rounded-full border-2 border-white/10" />
                                <div className="absolute inset-0 rounded-full border-2 animate-spin" style={{ borderColor: accent, borderTopColor: 'transparent' }} />
                            </div>
                            <div>
                                <p className="text-sm text-white/70 font-bold">正在窥视 {charName}…</p>
                                <p className="text-[11px] text-white/35 mt-1">{slot?.startTime} · {slot?.activity}</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-2 py-1">
                            {completedLines.map((ln, i) => (
                                <TheaterBeat key={i} line={ln} time={beatClock(slot?.startTime, i)} />
                            ))}
                            {currentLine && !finished && (
                                <TheaterBeat
                                    line={{ emotion: currentLine.emotion, text: typed }}
                                    time={beatClock(slot?.startTime, shownCount)}
                                    typing
                                    highlight
                                />
                            )}
                            <div className="pt-2 pb-1 text-center">
                                <span className="text-[10px] font-bold tracking-[0.25em] uppercase text-white/25">
                                    {finished ? '— 同步结束 —' : '✦ 同步仍在进行中'}
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ===== 底部控制 ===== */}
            <div className="relative flex-shrink-0 px-4 pt-2 pb-5">
                {(!error && !isGenerating && lines) && (
                    !finished ? (
                        <div className="flex justify-center">
                            <button
                                onClick={handleAdvance}
                                className="px-6 py-2.5 rounded-full text-xs font-bold text-white/80 border border-white/15 bg-white/5 hover:bg-white/12 transition-colors active:scale-95"
                            >
                                {currentLine && typed.length < (currentLine.text?.length ?? 0) ? '▸ 跳过本拍' : '▸▸ 跳到结尾'}
                            </button>
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-2.5">
                            {/* 换一段重演 */}
                            {confirmingReplay ? (
                                <div className="flex items-center gap-2">
                                    <span className="text-[11px] text-white/60">将覆盖当前小剧场：</span>
                                    <button
                                        type="button"
                                        onClick={() => { setConfirmingReplay(false); onReplay(); }}
                                        className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-500/90 text-white active:scale-95 transition-transform"
                                    >
                                        确认重演
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setConfirmingReplay(false)}
                                        className="text-[11px] font-bold px-2.5 py-1 rounded-full border border-white/15 bg-white/8 text-white/75 active:scale-95 transition-transform"
                                    >
                                        取消
                                    </button>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setConfirmingReplay(true)}
                                    className="text-[11px] font-bold text-white/50 hover:text-white/85 transition-colors active:scale-95"
                                >
                                    ↻ 换一段重演
                                </button>
                            )}
                            {/* 两态都把这一刻「留痕」进聊天，角色都记得自己干了啥；
                                区别只在 TA 知不知道你看了。主按钮=暴露，次按钮=不暴露。 */}
                            {onSendCard && (
                                <div className="w-full max-w-[320px] flex items-stretch gap-2.5">
                                    <button
                                        onClick={() => onSendCard(false)}
                                        className="flex-1 rounded-2xl py-2.5 px-3 flex flex-col items-center border transition-all active:scale-[0.98]"
                                        style={{ borderColor: `hsla(${HUE},50%,60%,0.4)`, background: `hsla(${HUE},40%,18%,0.6)` }}
                                    >
                                        <span className="text-[13px] font-black text-white/90 flex items-center gap-1">
                                            <span>🙈</span>TA 不知道你看了
                                        </span>
                                        <span className="text-[9px] font-medium text-white/45 mt-0.5">悄悄留痕 · TA 没发现被看</span>
                                    </button>
                                    <button
                                        onClick={() => onSendCard(true)}
                                        className="flex-1 rounded-2xl py-2.5 px-3 flex flex-col items-center transition-all active:scale-[0.98]"
                                        style={{
                                            background: `linear-gradient(135deg, hsl(${HUE},70%,58%), hsl(${HUE+18},65%,50%))`,
                                            boxShadow: `0 8px 24px hsla(${HUE},70%,45%,0.4), inset 0 1px 0 rgba(255,255,255,0.25)`,
                                        }}
                                    >
                                        <span className="text-[13px] font-black text-white flex items-center gap-1">
                                            <span>✦</span>让 TA 发现你在看
                                        </span>
                                        <span className="text-[9px] font-medium text-white/75 mt-0.5">甩到 TA 面前 · TA 会察觉</span>
                                    </button>
                                </div>
                            )}
                        </div>
                    )
                )}
            </div>
        </div>
        </dialog>
    );
};

/** 单拍：时间戳 + 氛围图标方块 + 行为文本卡。台词（带「」/引号）高亮，旁白偏暗。 */
const TheaterBeat: React.FC<{ line: TheaterLine; time: string; typing?: boolean; highlight?: boolean }> = ({ line, time, typing, highlight }) => {
    const dialogue = /[「」“”"]/.test(line.text);
    const icon = line.emotion || (dialogue ? '💬' : '·');
    return (
        <div className="flex items-stretch gap-1.5 animate-fade-in">
            {/* 时间戳 gutter */}
            <span className="flex-shrink-0 w-[44px] pt-2 text-right text-[8.5px] font-mono leading-tight whitespace-nowrap text-white/30 select-none">
                {time}
            </span>
            {/* 图标方块 */}
            <div
                className="flex-shrink-0 self-start mt-1 w-7 h-7 rounded-lg flex items-center justify-center text-[13px]"
                style={{
                    background: highlight ? `hsl(${HUE},55%,30%)` : `hsl(${HUE},40%,20%)`,
                    border: `1px solid hsla(${HUE},55%,50%,${highlight ? 0.7 : 0.3})`,
                }}
            >
                {icon}
            </div>
            {/* 行为文本卡 */}
            <div
                className="flex-1 min-w-0 rounded-xl px-2.5 py-1.5 border transition-colors"
                style={{
                    background: highlight ? `hsla(${HUE},50%,22%,0.65)` : `hsla(${HUE},35%,16%,0.5)`,
                    borderColor: highlight ? `hsla(${HUE},70%,62%,0.7)` : `hsla(${HUE},45%,45%,0.18)`,
                    boxShadow: highlight ? `0 0 18px hsla(${HUE},70%,55%,0.35)` : undefined,
                }}
            >
                <p
                    className={`leading-relaxed break-words ${dialogue ? 'text-[13.5px] font-medium text-white' : 'text-[12.5px] text-white/72'}`}
                    style={dialogue ? { textShadow: `0 0 16px hsla(${HUE},60%,45%,0.4)` } : undefined}
                >
                    {line.text}
                    {typing && <span className="inline-block w-[2px] h-[1em] align-text-bottom ml-0.5 animate-pulse" style={{ background: `hsl(${HUE},75%,72%)` }} />}
                </p>
            </div>
        </div>
    );
};

export default TheaterPlayer;

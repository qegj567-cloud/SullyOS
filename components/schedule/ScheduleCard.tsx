
import React, { useState, useRef, useEffect } from 'react';
import { DailySchedule, ScheduleSlot, CharacterProfile, OSTheme } from '../../types';
import { getCurrentScheduleSlotIndex, getScheduleWallClock } from '../../utils/scheduleTime';
import { resolveCharTimeZone, tzShortLabel } from '../../utils/timezone';
import { useOS } from '../../context/OSContext';
import { resolveScheduleCardPalette } from '../../utils/scheduleAppearance';
import ScheduleAppearanceButton, { ScheduleCustomCssStyle } from './ScheduleAppearanceButton';
import TokenImg from '../os/TokenImg';
import {homePositionLabel} from '../../utils/homeSchedule';

import { putImageBlob } from '../../utils/blobRef';

interface ScheduleCardProps {
    schedule: DailySchedule | null;
    character: CharacterProfile | null;
    contentColor?: string;
    compact?: boolean; // widget mode (no editing)
    onEdit?: (index: number, slot: ScheduleSlot) => void;
    onDelete?: (index: number) => void;
    onReroll?: () => void;
    onCoverImageChange?: (imageRef: string) => void | Promise<void>;
    onPlayTheater?: (index: number) => void; // 点某个「已过去/正在进行」时段的播放按钮 → 小剧场
    isGenerating?: boolean;
}

const formatDate = (now: Date): string => {
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return `${months[now.getMonth()]} ${now.getDate()} · ${days[now.getDay()]}`;
};

const formatClock = (now: Date): string =>
    `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

/**
 * 每分钟走一次的「此刻」。卡片可能一直开着，不刷新的话顶部的钟会停，
 * NOW 标记也不会随着时间推进挪到下一个时段。
 */
const useTickingNow = (fixed?:Date): Date => {
    const [now, setNow] = useState(() => fixed || new Date());
    useEffect(() => {
        if(fixed)return;
        const id = window.setInterval(() => setNow(new Date()), 30_000);
        return () => window.clearInterval(id);
    }, [fixed]);
    return fixed||now;
};

export const ScheduleCardView: React.FC<ScheduleCardProps & {theme:OSTheme;previewNow?:Date}> = ({
    theme,previewNow,
    schedule,
    character,
    contentColor: inheritedContentColor = '#ffffff',
    compact = false,
    onEdit,
    onDelete,
    onReroll,
    onCoverImageChange,
    onPlayTheater,
    isGenerating = false,
}) => {
    const [editingIdx, setEditingIdx] = useState<number | null>(null);
    const [editTime, setEditTime] = useState('');
    const [editActivity, setEditActivity] = useState('');
    const [editDesc, setEditDesc] = useState('');
    const [editEmoji, setEditEmoji] = useState('');
    const [editHomePosition, setEditHomePosition] = useState('');
    const coverInputRef = useRef<HTMLInputElement>(null);
    const [coverUploadError, setCoverUploadError] = useState('');

    // 长按菜单状态：记录哪一条日程被长按触发 action sheet（修改 / 删除）
    const [actionIdx, setActionIdx] = useState<number | null>(null);
    const longPressTimerRef = useRef<number | null>(null);
    const longPressTriggeredRef = useRef(false);
    const LONG_PRESS_MS = 500;

    // 点了「还没到的时段」的播放按钮 → 在该按钮上方冒一个一闪而过的小提示
    const [lockedHintIdx, setLockedHintIdx] = useState<number | null>(null);
    const lockedHintTimerRef = useRef<number | null>(null);
    const showLockedHint = (idx: number) => {
        if (lockedHintTimerRef.current) window.clearTimeout(lockedHintTimerRef.current);
        setLockedHintIdx(idx);
        lockedHintTimerRef.current = window.setTimeout(() => setLockedHintIdx(null), 1800);
    };

    const startLongPress = (idx: number) => {
        longPressTriggeredRef.current = false;
        if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = window.setTimeout(() => {
            longPressTriggeredRef.current = true;
            setActionIdx(idx);
        }, LONG_PRESS_MS);
    };

    const cancelLongPress = () => {
        if (longPressTimerRef.current) {
            window.clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    const tickingNow = useTickingNow(previewNow);
    const wallClock = getScheduleWallClock(character, tickingNow);
    const currentIdx = schedule ? getCurrentScheduleSlotIndex(schedule.slots, character, tickingNow) : -1;
    // 角色设了自己的时区时，上面那个钟走的是 ta 那边的时间——标出地名，
    // 免得用户拿它当自己的手机时间读。
    const charTzName = (() => {
        const tz = resolveCharTimeZone(character);
        return tz ? tzShortLabel(tz) : '';
    })();
    const charAvatar = character?.avatar;
    const charName = character?.name || '角色';
    const coverImage = schedule?.coverImage;

    const startEdit = (idx: number, slot: ScheduleSlot) => {
        setEditingIdx(idx);
        setEditTime(slot.startTime);
        setEditActivity(slot.activity);
        setEditDesc(slot.description || '');
        setEditHomePosition(slot.homePosition?.kind === 'away' ? '__away' : slot.homePosition?.kind === 'home' ? slot.homePosition.roomId : '');
        setEditEmoji(slot.emoji || '');
    };

    const saveEdit = () => {
        if (editingIdx !== null && onEdit) {
            onEdit(editingIdx, {
                startTime: editTime,
                activity: editActivity,
                description: editDesc || undefined,
                emoji: editEmoji || undefined,
                homePosition: editHomePosition === '__away' ? {kind: 'away'} : character?.home3D?.rooms.some(room => room.id === editHomePosition) ? {kind: 'home', roomId: editHomePosition} : undefined,
                location: editHomePosition === '__away' ? '外出' : character?.home3D?.rooms.find(room => room.id === editHomePosition)?.name,
            });
        }
        setEditingIdx(null);
    };

    const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !onCoverImageChange) return;
        e.target.value = '';
        setCoverUploadError('');
        try {
            // Store original pixels once; each day's schedule keeps a durable token.
            await onCoverImageChange(await putImageBlob(file));
        } catch { setCoverUploadError('头图保存失败，请重试'); }
    };

    const palette = resolveScheduleCardPalette(
        theme.scheduleCardAppearance,
        theme.hue || 260,
        inheritedContentColor,
    );
    const contentColor = palette.text;
    const accentHsl = palette.accent;
    const accentBg = palette.accentSoft;
    const cardBg = palette.base;
    const isDarkScheduleSurface = (() => {
        if (palette.preset === 'cream' || palette.preset === 'sakura' || palette.preset === 'mint') return false;
        if (palette.preset === 'original' || palette.preset === 'twilight' || palette.preset === 'midnight') return true;
        const m = /^#([0-9a-f]{6})$/i.exec(palette.text.trim());
        if (!m) return true;
        const v = Number.parseInt(m[1], 16);
        return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) > 140;
    })();
    const scheduleVars = {
        '--schedule-bg': palette.background,
        '--schedule-text': palette.text,
        '--schedule-accent': palette.accent,
        '--schedule-accent-soft': palette.accentSoft,
        '--schedule-base': palette.base,
        '--schedule-line': palette.line,
    } as React.CSSProperties;

    return (
        <div
            className="sully-schedule-root sully-schedule-card relative rounded-3xl overflow-hidden shadow-2xl"
            style={{
                ...scheduleVars,
                background: palette.background,
                color: contentColor,
                border: `1px solid ${palette.line}`,
            }}
        >

            {/* Header */}
            <div className="sully-schedule-header relative px-5 pt-5 pb-3 flex items-start justify-between">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-bold tracking-[0.2em] uppercase opacity-50">Daily</span>
                        <div className="h-px flex-1 opacity-20" style={{ background: contentColor }}></div>
                    </div>
                    <h2 className="text-2xl font-black tracking-tight" style={{ color: accentHsl }}>Schedule</h2>
                    {/* 时段行写的是「这件事几点开始」，这里补一个真正的当前时间，
                        否则只能拿 NOW 那行的数字当钟读 */}
                    <div className="flex items-baseline gap-1.5 mt-0.5">
                        <span className="text-lg font-black font-mono leading-none tabular-nums" style={{ color: accentHsl }}>
                            {formatClock(wallClock)}
                        </span>
                        <span className="text-[10px] font-bold opacity-40">
                            {charTzName ? `${charName}那边` : '现在'}
                        </span>
                    </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5">
                        <span
                            className="text-[10px] font-bold px-2 py-0.5 rounded-full border"
                            style={{ background: accentBg, borderColor: palette.line }}
                        >
                            {formatDate(wallClock)}
                        </span>
                        {!previewNow&&<ScheduleAppearanceButton compact />}
                    </div>
                    {charTzName && (
                        <span className="text-[9px] font-bold opacity-40 tracking-wide">
                            {charTzName}
                        </span>
                    )}
                    {!compact && onReroll && (
                        <button
                            onClick={onReroll}
                            disabled={isGenerating}
                            className="text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all active:scale-95 disabled:opacity-30"
                            style={{ background: accentBg, borderColor: palette.line }}
                        >
                            {isGenerating ? '生成中...' : '↻ 重新生成'}
                        </button>
                    )}
                </div>
            </div>

            {coverUploadError && <p role="alert" className="px-4 py-2 text-xs text-red-500">{coverUploadError}</p>}
            {/* Content: Character Image Banner on top, Schedule List below */}
            <div className="flex flex-col">
                {/* Character Image Banner */}
                <div className="sully-schedule-cover relative w-full h-32 overflow-hidden flex-shrink-0">
                    {(coverImage || charAvatar) ? (
                        <TokenImg
                            value={coverImage || charAvatar}
                            alt=""
                            className="absolute inset-0 w-full h-full object-cover opacity-70"
                            style={{ objectPosition: 'center 30%' }}
                        />
                    ) : (
                        <div className="absolute inset-0 opacity-10" style={{ background: `linear-gradient(135deg, ${accentHsl}, transparent)` }}></div>
                    )}

                    {/* Bottom gradient for blending into schedule */}
                    <div className="absolute inset-0 z-10" style={{ background: `linear-gradient(to bottom, transparent 30%, ${cardBg})` }}></div>

                    {/* Character name label */}
                    <div className="absolute bottom-2 right-3 z-20">
                        <span className="text-[10px] font-bold opacity-50 tracking-widest uppercase">
                            {charName}
                        </span>
                    </div>

                    {/* Cover image upload (non-compact) */}
                    {!compact && onCoverImageChange && (
                        <button
                            onClick={() => coverInputRef.current?.click()}
                            className="absolute top-2 right-2 z-20 w-6 h-6 rounded-full bg-black/40 flex items-center justify-center text-white/60 hover:text-white/90 transition-colors text-[10px]"
                            title="更换看板图"
                        >
                            ✎
                        </button>
                    )}
                    <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={handleCoverUpload} />
                </div>

                {/* Schedule List */}
                <div className="sully-schedule-list px-5 pb-5 pt-1 space-y-1 min-w-0">
                    {isGenerating && !schedule ? (
                        <div className="py-12 text-center">
                            <div className="inline-block w-6 h-6 border-2 rounded-full animate-spin mb-3" style={{ borderColor: palette.line, borderTopColor: accentHsl }}></div>
                            <p className="text-xs opacity-40">正在生成日程...</p>
                        </div>
                    ) : schedule && schedule.slots.length > 0 ? (
                        schedule.slots.map((slot, idx) => {
                            const isCurrent = idx === currentIdx;
                            const isPast = currentIdx >= 0 && idx < currentIdx;
                            const isFuture = !isPast && !isCurrent; // 还没到的时段：按钮灰着，点了给提示
                            const isEditing = editingIdx === idx;

                            if (isEditing && !compact) {
                                return (
                                    <div key={idx} className="sully-schedule-item p-3 rounded-xl border" style={{ background: accentBg, borderColor: palette.line }}>
                                        <div className="flex gap-2 mb-2">
                                            <input
                                                type="time"
                                                value={editTime}
                                                onChange={e => setEditTime(e.target.value)}
                                                style={{ background: cardBg, color: palette.text, borderColor: palette.line, colorScheme: isDarkScheduleSurface ? 'dark' : 'light' }}
                                                className="rounded-lg px-2 py-1 text-xs font-mono w-24 border focus:outline-none"
                                            />
                                            <input
                                                value={editEmoji}
                                                onChange={e => setEditEmoji(e.target.value)}
                                                placeholder="emoji"
                                                style={{ background: cardBg, color: palette.text, borderColor: palette.line }}
                                                className="rounded-lg px-2 py-1 text-xs w-14 border focus:outline-none text-center placeholder:text-current placeholder:opacity-45"
                                            />
                                        </div>
                                        <input
                                            value={editActivity}
                                            onChange={e => setEditActivity(e.target.value)}
                                            placeholder="活动"
                                            style={{ background: cardBg, color: palette.text, borderColor: palette.line }}
                                            className="w-full rounded-lg px-2 py-1 text-sm font-bold mb-1 border focus:outline-none placeholder:text-current placeholder:opacity-45"
                                        />
                                        <input
                                            value={editDesc}
                                            onChange={e => setEditDesc(e.target.value)}
                                            placeholder="描述 (可选)"
                                            style={{ background: cardBg, color: palette.text, borderColor: palette.line }}
                                            className="w-full rounded-lg px-2 py-1 text-xs border focus:outline-none opacity-80 placeholder:text-current placeholder:opacity-45"
                                        />
                                        {!!character?.home3D?.rooms.length && <select aria-label="日程所在房间" value={editHomePosition} onChange={event => setEditHomePosition(event.target.value)} style={{ background: cardBg, color: palette.text, borderColor: palette.line, colorScheme: isDarkScheduleSurface ? 'dark' : 'light' }} className={`w-full rounded-lg border px-2 py-2 text-xs mt-2 focus:outline-none ${isDarkScheduleSurface ? '[&_option]:bg-[#161428] [&_option]:text-white' : '[&_option]:bg-white [&_option]:text-slate-800'}`}><option value="">位置待补全</option><option value="__away">外出</option>{character.home3D.rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select>}
                                        <div className="flex gap-2 mt-2">
                                            <button onClick={saveEdit} style={{ background: cardBg, color: palette.text, borderColor: palette.line }} className="text-[10px] font-bold px-3 py-1 rounded-lg border hover:opacity-90 transition-opacity">保存</button>
                                            <button onClick={() => setEditingIdx(null)} style={{ background: cardBg, color: palette.text, borderColor: palette.line }} className="text-[10px] font-bold px-3 py-1 rounded-lg border opacity-75 hover:opacity-100 transition-opacity">取消</button>
                                        </div>
                                    </div>
                                );
                            }

                            const editable = !compact && !!onEdit;
                            const pressHandlers = editable ? {
                                onPointerDown: (e: React.PointerEvent) => {
                                    // 只对主指针（鼠标左键 / 触屏首指）起反应，忽略右键
                                    if (e.button !== undefined && e.button !== 0) return;
                                    startLongPress(idx);
                                },
                                onPointerUp: () => cancelLongPress(),
                                onPointerLeave: () => cancelLongPress(),
                                onPointerCancel: () => cancelLongPress(),
                                onClick: () => {
                                    // 长按已触发时不再执行 tap-to-edit，避免抬手时误进入编辑
                                    if (longPressTriggeredRef.current) {
                                        longPressTriggeredRef.current = false;
                                        return;
                                    }
                                    startEdit(idx, slot);
                                },
                                // 屏蔽原生长按右键菜单，避免与自定义长按冲突
                                onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
                            } : {};
                            return (
                                <div
                                    key={idx}
                                    className={`sully-schedule-item ${isCurrent ? 'sully-schedule-item-current' : ''} relative flex items-start gap-3 py-2 px-3 rounded-xl transition-all ${
                                        isCurrent ? 'border' : 'border border-transparent'
                                    } ${editable ? 'cursor-pointer hover:bg-white/5 select-none' : ''}`}
                                    style={isCurrent ? { background: accentBg, borderColor: palette.line } : {}}
                                    {...pressHandlers}
                                >
                                    {/* Time */}
                                    <div className="flex flex-col items-center w-12 flex-shrink-0">
                                        <span className={`sully-schedule-time text-xs font-mono font-bold ${isPast ? 'opacity-30' : isCurrent ? 'opacity-100' : 'opacity-60'}`}>
                                            {slot.startTime}
                                        </span>
                                        {isCurrent && (
                                            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full mt-0.5 animate-pulse" style={{ background: accentHsl, color: cardBg }}>
                                                NOW
                                            </span>
                                        )}
                                    </div>

                                    {/* Timeline dot + line */}
                                    <div className="sully-schedule-timeline flex flex-col items-center pt-1.5 flex-shrink-0">
                                        <div
                                            className={`w-2.5 h-2.5 rounded-full border-2 ${isPast ? 'opacity-30' : ''}`}
                                            style={{
                                                borderColor: isCurrent ? accentHsl : palette.line,
                                                background: isCurrent ? accentHsl : (isPast ? palette.line : 'transparent'),
                                            }}
                                        />
                                        {idx < schedule.slots.length - 1 && (
                                            <div className={`w-px flex-1 min-h-[16px] ${isPast ? 'opacity-15' : 'opacity-20'}`} style={{ background: contentColor }}></div>
                                        )}
                                    </div>

                                    {/* Content */}
                                    <div className={`flex-1 min-w-0 ${isPast ? 'opacity-30' : ''}`}>
                                        <div className="flex items-center gap-1.5">
                                            {slot.emoji && <span className="text-sm flex-shrink-0">{slot.emoji}</span>}
                                            <span className="sully-schedule-activity text-sm font-bold">{slot.activity}</span>
                                        </div>
                                        {slot.homePosition && <p className="text-[11px] opacity-60 mt-1">{homePositionLabel(slot, character)}</p>}
                                        {slot.description && (
                                            <p className="sully-schedule-description text-[11px] opacity-50 mt-0.5 leading-tight">{slot.description}</p>
                                        )}
                                    </div>

                                    {/* 小剧场播放按钮：全程都在，已过去/正在进行的可点（▶ 生成 / ↻ 重看）；
                                        还没到的时段灰着，点了冒个「还没到这个时间哦」的小提示。 */}
                                    {!compact && onPlayTheater && (
                                        <div className="relative flex-shrink-0 mt-0.5">
                                            <button
                                                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs transition-all ${isFuture ? 'cursor-not-allowed' : 'active:scale-90'}`}
                                                style={{
                                                    background: isFuture ? 'color-mix(in srgb, var(--schedule-text) 6%, transparent)' : (slot.theater ? accentHsl : 'color-mix(in srgb, var(--schedule-text) 12%, transparent)'),
                                                    color: isFuture ? 'color-mix(in srgb, var(--schedule-text) 28%, transparent)' : (slot.theater ? cardBg : contentColor),
                                                }}
                                                title={isFuture ? '还没到这个时间哦' : (slot.theater ? '重看小剧场' : '窥视这一刻')}
                                                onPointerDown={(e) => { e.stopPropagation(); cancelLongPress(); }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    longPressTriggeredRef.current = false;
                                                    if (isFuture) { showLockedHint(idx); return; }
                                                    onPlayTheater(idx);
                                                }}
                                            >
                                                {slot.theater && !isFuture ? '↻' : '▶'}
                                            </button>
                                            {lockedHintIdx === idx && (
                                                <div
                                                    className="absolute right-0 bottom-full mb-1.5 z-20 whitespace-nowrap px-2 py-1 rounded-lg text-[10px] font-bold animate-fade-in pointer-events-none"
                                                    style={{ background: 'rgba(20,16,30,0.96)', color: '#fff', border: '1px solid rgba(255,255,255,0.15)', boxShadow: '0 4px 14px rgba(0,0,0,0.4)' }}
                                                >
                                                    还没到这个时间哦
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    ) : (
                        <div className="py-12 text-center">
                            <p className="text-xs opacity-30">暂无日程</p>
                            {onReroll && (
                                <button onClick={onReroll} className="mt-2 text-xs font-bold opacity-50 hover:opacity-80 transition-opacity" style={{ color: accentHsl }}>
                                    生成今日日程
                                </button>
                            )}
                        </div>
                    )}

                    {/* OFFLINE footer */}
                    {schedule && schedule.slots.length > 0 && (
                        <div className="pt-2 pl-3">
                            <span className="text-[10px] font-bold tracking-widest opacity-20">OFFLINE</span>
                            <p className="text-[10px] opacity-15">就寝</p>
                        </div>
                    )}
                </div>

            </div>

            {/* 长按菜单：修改 / 删除 */}
            {actionIdx !== null && schedule && schedule.slots[actionIdx] && (
                <div
                    className="absolute inset-0 z-30 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
                    onClick={() => setActionIdx(null)}
                >
                    <div
                        className="w-full sm:w-64 bg-white text-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-4 py-3 border-b border-slate-100">
                            <p className="text-xs text-slate-400">日程项</p>
                            <p className="text-sm font-bold text-slate-700 truncate">
                                {schedule.slots[actionIdx].startTime} · {schedule.slots[actionIdx].activity}
                            </p>
                        </div>
                        <button
                            className="w-full py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
                            onClick={() => {
                                const i = actionIdx;
                                setActionIdx(null);
                                if (i !== null && schedule) startEdit(i, schedule.slots[i]);
                            }}
                        >
                            修改
                        </button>
                        <button
                            className="w-full py-3 text-sm font-bold text-red-500 border-t border-slate-100 hover:bg-red-50 transition-colors"
                            onClick={() => {
                                const i = actionIdx;
                                setActionIdx(null);
                                if (i !== null && onDelete) onDelete(i);
                            }}
                        >
                            删除
                        </button>
                        <button
                            className="w-full py-3 text-sm text-slate-400 border-t border-slate-100 hover:bg-slate-50 transition-colors"
                            onClick={() => setActionIdx(null)}
                        >
                            取消
                        </button>
                    </div>
                </div>
            )}

            {/* Decorative elements */}
            <div className="absolute top-3 left-3 opacity-10 pointer-events-none">
                <svg width="20" height="20" viewBox="0 0 20 20" fill={contentColor}>
                    <path d="M10 0l2.5 7.5H20l-6 4.5 2.5 7.5L10 15l-6.5 4.5L6 12 0 7.5h7.5z"/>
                </svg>
            </div>
            <div className="absolute bottom-2 left-5 opacity-5 pointer-events-none text-[8px] font-mono tracking-widest">
                DESIGN: NOI
            </div>
        </div>
    );
};

const ScheduleCard:React.FC<ScheduleCardProps> = props => {const {theme}=useOS();return <><ScheduleCustomCssStyle/><ScheduleCardView {...props} theme={theme}/></>;};
export default ScheduleCard;

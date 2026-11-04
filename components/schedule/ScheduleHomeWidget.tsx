import React, { useEffect, useState } from 'react';
import { CharacterProfile, DailySchedule, ScheduleSlot } from '../../types';
import ScheduleCard from './ScheduleCard';
import { getCurrentScheduleSlotIndex, getScheduleWallClock } from '../../utils/scheduleTime';
import { useOS } from '../../context/OSContext';
import { resolveScheduleCardPalette, resolveScheduleDesktopPalette } from '../../utils/scheduleAppearance';
import ScheduleAppearanceButton, { ScheduleCustomCssStyle } from './ScheduleAppearanceButton';
import TokenImg from '../os/TokenImg';
import { useBlobRefUrl } from '../../utils/blobRef';
import { resolveReducedGlassCardStyle, useReducedBlur } from '../../utils/blurPolicy';

interface ScheduleSquareWidgetProps {
    schedule: DailySchedule | null;
    character: CharacterProfile | null;
    contentColor?: string;
    onOpen: () => void;
}

export const ScheduleSquareWidget: React.FC<ScheduleSquareWidgetProps> = ({
    schedule,
    character,
    contentColor: inheritedContentColor = '#ffffff',
    onOpen,
}) => {
    const { theme } = useOS();
    const currentIdx = schedule ? getCurrentScheduleSlotIndex(schedule.slots, character) : -1;
    const currentSlot = currentIdx >= 0 ? schedule!.slots[currentIdx] : null;
    const nextSlot = schedule && currentIdx < schedule.slots.length - 1
        ? schedule.slots[currentIdx + 1]
        : null;

    const palette = resolveScheduleCardPalette(
        theme.scheduleCardAppearance,
        theme.hue ?? 260,
        inheritedContentColor,
    );
    const contentColor = palette.text;
    const accentHsl = palette.accent;
    const accentSoft = palette.accentSoft;
    const cardBg = palette.base;
    const scheduleVars = {
        '--schedule-bg': palette.background,
        '--schedule-text': palette.text,
        '--schedule-accent': palette.accent,
        '--schedule-accent-soft': palette.accentSoft,
        '--schedule-base': palette.base,
        '--schedule-line': palette.line,
    } as React.CSSProperties;

    const now = getScheduleWallClock(character);
    const timeLabel = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    return (
        <div
            onClick={onOpen}
            onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen();
                }
            }}
            role="button"
            tabIndex={0}
            className="sully-schedule-root sully-schedule-widget relative w-full h-full rounded-[1.75rem] overflow-hidden cursor-pointer transition-transform duration-200 active:scale-[0.98] animate-fade-in text-left"
            style={{
                ...scheduleVars,
                background: palette.background,
                border: `1px solid ${palette.line}`,
                boxShadow: '0 8px 30px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.07)',
                color: contentColor,
            }}
        >
            <ScheduleCustomCssStyle />
            <div className="absolute top-2 right-2 z-20">
                <ScheduleAppearanceButton compact />
            </div>
            {/* Background avatar */}
            {character?.avatar && (
                <TokenImg
                    value={character.avatar}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 w-full h-full object-cover opacity-55"
                    style={{ objectPosition: 'center 28%' }}
                />
            )}
            {/* Bottom gradient for text legibility */}
            <div
                className="absolute inset-0 pointer-events-none"
                style={{
                    background: `linear-gradient(to bottom, transparent 30%, ${cardBg} 95%)`,
                }}
            />
            {/* Accent corner glow */}
            <div
                className="absolute -top-10 -right-10 w-24 h-24 rounded-full pointer-events-none opacity-50"
                style={{ background: `radial-gradient(circle, ${accentHsl}, transparent 70%)` }}
            />

            {/* Top row: NOW badge + time */}
            <div className="sully-schedule-header absolute top-0 left-0 right-0 flex items-center justify-between pl-3 pr-11 pt-3 z-10">
                <span
                    className="text-[8.5px] font-bold tracking-[0.22em] uppercase px-1.5 py-0.5 rounded-full"
                    style={{
                        background: currentSlot ? accentSoft : 'rgba(255,255,255,0.14)',
                        color: currentSlot ? accentHsl : contentColor,
                        border: '1px solid rgba(255,255,255,0.16)',
                    }}
                >
                    {currentSlot ? 'Now' : 'Idle'}
                </span>
                <span className="sully-schedule-time text-[10px] font-mono opacity-65 tracking-wider drop-shadow">
                    {currentSlot ? currentSlot.startTime : timeLabel}
                </span>
            </div>

            {/* Decorative label */}
            <div className="absolute top-9 left-3 z-10 flex items-center gap-1.5">
                <span className="text-[9px] font-bold tracking-[0.2em] uppercase opacity-55">Daily</span>
                <div className="h-px w-5 opacity-30" style={{ background: contentColor }}></div>
            </div>

            {/* Bottom content */}
            <div className="absolute bottom-0 left-0 right-0 p-3 z-10">
                <div className="flex items-center gap-1.5 mb-1">
                    {currentSlot?.emoji && (
                        <span className="text-xl shrink-0 drop-shadow-md">{currentSlot.emoji}</span>
                    )}
                    <span className="sully-schedule-activity text-[13px] font-bold truncate drop-shadow-md leading-tight">
                        {currentSlot?.activity || (schedule ? '休息中' : '未生成')}
                    </span>
                </div>
                {nextSlot ? (
                    <div className="sully-schedule-description text-[9.5px] opacity-55 truncate leading-tight">
                        <span className="opacity-70 mr-1">→ {nextSlot.startTime}</span>
                        {nextSlot.activity}
                    </div>
                ) : (
                    <div className="text-[9.5px] opacity-40 truncate tracking-widest uppercase">
                        {character?.name || '—'}
                    </div>
                )}
            </div>

            {/* Tap hint */}
            <div
                className="absolute bottom-3 right-3 w-6 h-6 rounded-full flex items-center justify-center z-10 opacity-70"
                style={{ background: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.2)' }}
            >
                <svg viewBox="0 0 24 24" fill="none" strokeWidth={2.2} stroke="currentColor" className="w-3 h-3">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5V5a2 2 0 0 1 2-2h2.5M21 7.5V5a2 2 0 0 0-2-2h-2.5M3 16.5V19a2 2 0 0 0 2 2h2.5M21 16.5V19a2 2 0 0 1-2 2h-2.5" />
                </svg>
            </div>
        </div>
    );
};

interface ScheduleHomeWidgetProps {
    schedule: DailySchedule | null;
    character: CharacterProfile | null;
    contentColor?: string;
    onOpen: () => void;
    acnh?: boolean;
    paper?: boolean;
}

export const ScheduleHomeWidget: React.FC<ScheduleHomeWidgetProps> = ({
    schedule,
    character,
    contentColor: inheritedContentColor = '#ffffff',
    onOpen,
    acnh = false,
    paper = false,
}) => {
    const { theme } = useOS();
    // 头像光晕是 CSS 背景，拿不到 <img> 的自动解析，这里在组件顶层先把令牌解开
    const avatarUrl = useBlobRefUrl(character?.avatar);
    const currentIdx = schedule ? getCurrentScheduleSlotIndex(schedule.slots, character) : -1;
    const currentSlot = currentIdx >= 0 ? schedule!.slots[currentIdx] : null;
    const nextSlot = schedule && currentIdx < schedule.slots.length - 1
        ? schedule.slots[currentIdx + 1]
        : null;

    const palette = resolveScheduleDesktopPalette(
        theme.scheduleCardAppearance,
        theme.hue ?? 260,
        inheritedContentColor,
    );
    const reducedBlur = useReducedBlur();
    const effectivePaper = paper && palette.isOriginal;
    const effectiveAcnh = acnh && palette.isOriginal;
    const contentColor = palette.text;
    const accentHsl = effectivePaper ? '#788369' : palette.accent;
    const accentSoft = effectivePaper ? 'rgba(120,131,105,0.14)' : palette.accentSoft;
    const scheduleVars = {
        '--schedule-bg': effectiveAcnh
            ? 'rgb(247,243,223)'
            : effectivePaper
                ? 'rgba(224,221,215,0.40)'
                : palette.background,
        '--schedule-text': effectiveAcnh ? '#725d42' : palette.text,
        '--schedule-accent': effectiveAcnh ? '#5a9e1e' : accentHsl,
        '--schedule-accent-soft': effectiveAcnh ? '#dff0c8' : accentSoft,
        '--schedule-base': effectiveAcnh ? '#f7f3df' : effectivePaper ? '#e0ddd7' : palette.base,
        '--schedule-line': effectiveAcnh ? '#e8e2d6' : effectivePaper ? 'rgba(91,72,51,0.07)' : palette.line,
    } as React.CSSProperties;

    const now = getScheduleWallClock(character);
    const timeLabel = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    const timelineSlots = schedule?.slots ?? [];

    // 动森：全新奶油布局（不复用暗底版式）
    if (effectiveAcnh) {
        return (
            <div
                onClick={onOpen}
                onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onOpen();
                    }
                }}
                role="button"
                tabIndex={0}
                className="sully-schedule-root sully-schedule-widget w-full shrink-0 text-left rounded-3xl overflow-hidden active:scale-[0.98] transition-transform relative"
                style={{ ...scheduleVars, background: 'rgb(247,243,223)', border: '2px solid #e8e2d6', boxShadow: '0 6px 18px rgba(61,52,40,0.12)', color: '#725d42' }}>
                <ScheduleCustomCssStyle />
                <div className="absolute right-3 top-3 z-20" style={{ '--schedule-text': '#725d42', '--schedule-line': 'rgba(91,72,51,.16)' } as React.CSSProperties}>
                    <ScheduleAppearanceButton compact />
                </div>
                <div className="flex flex-col p-4 gap-3">
                    <div className="sully-schedule-header flex items-center gap-2 pr-8">
                        <span className="text-[12px] font-extrabold" style={{ color: '#725d42' }}>🍃 今日日程</span>
                        <div className="h-[2px] flex-1 rounded-full" style={{ background: '#e8e2d6' }} />
                        <span className="text-[11px] font-bold" style={{ color: '#9f927d' }}>{timeLabel}</span>
                    </div>
                    <div className="flex items-center gap-3.5">
                        <div className="w-[64px] h-[64px] shrink-0 rounded-[22%] overflow-hidden bg-[#e8e2d6] flex items-center justify-center"
                            style={{ border: '3px solid #fff', boxShadow: '0 4px 10px -3px rgba(61,52,40,0.25)' }}>
                            {character?.avatar
                                ? <TokenImg value={character.avatar} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: 'center 28%' }} />
                                : <span className="text-lg font-bold" style={{ color: '#9f927d' }}>{character?.name?.[0] || '🍃'}</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-[9px] font-extrabold tracking-wide px-2 py-0.5 rounded-full"
                                    style={{ background: currentSlot ? '#dff0c8' : '#efe7d4', color: currentSlot ? '#5a9e1e' : '#9f927d' }}>
                                    {currentSlot ? '现在' : '休息'}
                                </span>
                                <span className="sully-schedule-time text-[10px] font-bold" style={{ color: '#9f927d' }}>{currentSlot ? currentSlot.startTime : timeLabel}</span>
                                <span className="text-[9px] ml-auto shrink-0 truncate max-w-[40%] font-bold" style={{ color: '#b3a88e' }}>{character?.name || '—'}</span>
                            </div>
                            <div className="flex items-center gap-1.5 min-w-0">
                                {currentSlot?.emoji && <span className="text-base shrink-0">{currentSlot.emoji}</span>}
                                <span className="sully-schedule-activity text-[15px] font-bold truncate leading-tight" style={{ color: '#725d42' }}>
                                    {currentSlot?.activity || (schedule ? '休息中 · 暂无安排' : '尚未生成日程')}
                                </span>
                            </div>
                            {nextSlot && (
                                <div className="sully-schedule-description text-[10.5px] mt-0.5 truncate" style={{ color: '#a89878' }}>
                                    → {nextSlot.startTime} {nextSlot.emoji ? `${nextSlot.emoji} ` : ''}{nextSlot.activity}
                                </div>
                            )}
                        </div>
                    </div>
                    {timelineSlots.length > 0 && (
                        <div className="sully-schedule-timeline flex items-end gap-1.5 pt-0.5">
                            {timelineSlots.slice(0, 10).map((slot, i) => {
                                const isCur = i === currentIdx;
                                const isPast = currentIdx >= 0 && i < currentIdx;
                                return (
                                    <div key={i} className="flex-1 min-w-0 flex flex-col items-center gap-1">
                                        <div className="w-full rounded-full transition-all" style={{ height: '4px', background: isCur ? '#6fba2c' : isPast ? '#cdbfa0' : '#e8e2d6' }} />
                                        <span className="text-[8px] font-bold" style={{ color: isCur ? '#5a9e1e' : '#b3a88e' }}>{slot.startTime.slice(0, 5)}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div
            onClick={onOpen}
            onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen();
                }
            }}
            role="button"
            tabIndex={0}
            className="sully-schedule-root sully-schedule-widget w-full shrink-0 group text-left rounded-3xl overflow-hidden transition-transform duration-200 active:scale-[0.98] relative"
            style={effectivePaper ? {
                ...scheduleVars,
                background: 'rgba(224,221,215,0.40)',
                border: '1px solid rgba(91,72,51,0.07)',
                boxShadow: '0 5px 16px rgba(91,72,51,0.055)',
                color: contentColor,
            } : !palette.isOriginal ? {
                ...scheduleVars,
                background: palette.background,
                border: `1px solid ${palette.line}`,
                boxShadow: '0 8px 32px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.08)',
                color: contentColor,
            } : reducedBlur ? {
                ...scheduleVars,
                ...resolveReducedGlassCardStyle(contentColor),
                color: contentColor,
            } : {
                ...scheduleVars,
                background: 'rgba(255,255,255,0.08)',
                backdropFilter: 'blur(24px) saturate(1.4)',
                WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
                border: '1px solid rgba(255,255,255,0.12)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.08)',
                color: contentColor,
            }}
        >
            <ScheduleCustomCssStyle />
            <div className="absolute right-3 top-3 z-20">
                <ScheduleAppearanceButton compact />
            </div>
            {/* Blurred avatar glow（动森与无实时模糊模式下省略） */}
            {!effectivePaper && !reducedBlur && palette.isOriginal && avatarUrl && (
                <div
                    className="absolute inset-0 opacity-25 pointer-events-none"
                    style={{
                        backgroundImage: `url(${avatarUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center 28%',
                        filter: 'blur(36px) saturate(1.6)',
                        transform: 'scale(1.35)',
                    }}
                />
            )}
            {/* Accent corner glow */}
            <div
                className={`absolute -top-12 -right-12 w-32 h-32 rounded-full pointer-events-none ${effectivePaper ? 'opacity-10' : 'opacity-40'}`}
                style={{ background: `radial-gradient(circle, ${accentHsl}, transparent 70%)` }}
            />
            {/* Accent vertical stripe */}
            <div
                className="absolute left-0 top-0 bottom-0 w-[3px]"
                style={{ background: effectivePaper ? 'linear-gradient(to bottom, #788369, rgba(120,131,105,0.12))' : `linear-gradient(to bottom, ${accentHsl}, transparent)` }}
            />

            <div className="relative flex flex-col p-4 gap-3">
                {/* Header row: label + character name + time */}
                <div className="sully-schedule-header flex items-center gap-2 pr-8 text-[9px] tracking-[0.22em] uppercase opacity-60">
                    <span className="font-bold">Daily Schedule</span>
                    <div className="h-px flex-1" style={{ background: contentColor, opacity: 0.25 }}></div>
                    <span className="sully-schedule-time font-mono tracking-wider opacity-80">{timeLabel}</span>
                </div>

                {/* Main row: avatar | activity */}
                <div className="flex items-center gap-4">
                    <div
                        className={`w-[72px] h-[72px] shrink-0 rounded-2xl overflow-hidden relative ${effectivePaper ? 'bg-[#ded2c1]' : 'bg-slate-800/60'}`}
                        style={{
                            border: effectivePaper ? '1px solid rgba(91,72,51,0.14)' : `1.5px solid ${palette.line}`,
                            boxShadow: effectivePaper ? '0 6px 16px rgba(91,72,51,0.13)' : '0 6px 18px rgba(0,0,0,0.3)',
                        }}
                    >
                        {character?.avatar ? (
                            <TokenImg
                                value={character.avatar}
                                alt=""
                                loading="lazy"
                                className="w-full h-full object-cover"
                                style={{ objectPosition: 'center 28%' }}
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-lg font-bold opacity-70">
                                {character?.name?.[0] || '·'}
                            </div>
                        )}
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1">
                            <span
                                className="text-[9px] font-bold tracking-[0.22em] uppercase px-1.5 py-0.5 rounded-full"
                                style={{
                                    background: currentSlot ? accentSoft : effectivePaper ? 'rgba(91,72,51,0.07)' : 'color-mix(in srgb, var(--schedule-text) 14%, transparent)',
                                    color: currentSlot ? accentHsl : undefined,
                                    border: effectivePaper ? '1px solid rgba(91,72,51,0.10)' : `1px solid ${palette.line}`,
                                }}
                            >
                                {currentSlot ? 'Now' : 'Idle'}
                            </span>
                            <span className="text-[10px] font-mono opacity-60 tracking-wider">
                                {currentSlot ? currentSlot.startTime : timeLabel}
                            </span>
                            <span className="text-[9px] opacity-40 tracking-widest uppercase ml-auto shrink-0 truncate max-w-[40%]">
                                {character?.name || '—'}
                            </span>
                        </div>
                        <div className="flex items-center gap-1.5 min-w-0">
                            {currentSlot?.emoji && (
                                <span className={`text-lg shrink-0 ${effectivePaper ? '' : 'drop-shadow-md'}`}>{currentSlot.emoji}</span>
                            )}
                            <span className={`sully-schedule-activity text-[15px] font-bold truncate leading-tight ${effectivePaper ? '' : 'drop-shadow-md'}`}>
                                {currentSlot?.activity || (schedule ? '休息中 · 暂无安排' : '尚未生成日程')}
                            </span>
                        </div>
                        {(currentSlot?.description || nextSlot) && (
                            <div className="sully-schedule-description text-[10.5px] opacity-55 truncate mt-0.5 leading-snug">
                                {currentSlot?.description ? (
                                    currentSlot.description
                                ) : nextSlot ? (
                                    <>
                                        <span className="opacity-70 mr-1">→ {nextSlot.startTime}</span>
                                        {nextSlot.emoji ? `${nextSlot.emoji} ` : ''}{nextSlot.activity}
                                    </>
                                ) : null}
                            </div>
                        )}
                    </div>

                    {/* Open indicator */}
                    <div
                        className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center opacity-70 group-hover:opacity-100 transition-opacity self-start"
                        style={{ background: effectivePaper ? 'rgba(120,131,105,0.10)' : 'color-mix(in srgb, var(--schedule-text) 14%, transparent)', border: effectivePaper ? '1px solid rgba(91,72,51,0.11)' : `1px solid ${palette.line}` }}
                    >
                        <svg viewBox="0 0 24 24" fill="none" strokeWidth={2.2} stroke="currentColor" className="w-3.5 h-3.5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5V5a2 2 0 0 1 2-2h2.5M21 7.5V5a2 2 0 0 0-2-2h-2.5M3 16.5V19a2 2 0 0 0 2 2h2.5M21 16.5V19a2 2 0 0 1-2 2h-2.5" />
                        </svg>
                    </div>
                </div>

                {/* Timeline footer */}
                {timelineSlots.length > 0 && (
                    <div className="sully-schedule-timeline flex items-center gap-1.5 pt-1">
                        {timelineSlots.slice(0, 10).map((slot, i) => {
                            const isCurrent = i === currentIdx;
                            const isPast = currentIdx >= 0 && i < currentIdx;
                            return (
                                <div
                                    key={i}
                                    className="flex-1 min-w-0 flex flex-col items-center gap-1"
                                >
                                    <div
                                        className="w-full h-[3px] rounded-full transition-all"
                                        style={{
                                            background: isCurrent ? accentHsl : isPast ? (effectivePaper ? 'rgba(91,72,51,0.22)' : 'color-mix(in srgb, var(--schedule-text) 32%, transparent)') : (effectivePaper ? 'rgba(91,72,51,0.10)' : 'color-mix(in srgb, var(--schedule-text) 14%, transparent)'),
                                            boxShadow: isCurrent && !effectivePaper ? `0 0 8px ${accentHsl}` : 'none',
                                        }}
                                    ></div>
                                    <span
                                        className="text-[8px] font-mono tracking-wider"
                                        style={{
                                            opacity: isCurrent ? 0.9 : isPast ? 0.35 : 0.5,
                                            color: isCurrent ? accentHsl : contentColor,
                                        }}
                                    >
                                        {slot.startTime.slice(0, 5)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

interface ScheduleFullscreenViewerProps {
    open: boolean;
    onClose: () => void;
    characters: CharacterProfile[];
    activeCharId: string | null;
    onSwitchCharacter: (id: string) => void;
    schedule: DailySchedule | null;
    activeCharacter: CharacterProfile | null;
}

// 查看器底色固定为深色遮罩，字色不能跟桌面字色走（桌面配深色字时会深底深字）
const VIEWER_TEXT_COLOR = '#ffffff';

export const ScheduleFullscreenViewer: React.FC<ScheduleFullscreenViewerProps> = ({
    open,
    onClose,
    characters,
    activeCharId,
    onSwitchCharacter,
    schedule,
    activeCharacter,
}) => {
    const contentColor = VIEWER_TEXT_COLOR;
    // Lock scroll of background
    useEffect(() => {
        if (!open) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [open]);

    // Close on ESC
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    // 这层全屏查看器不跟随卡片配色，固定用默认色相做强调色
    const accentHsl = 'hsl(260, 70%, 65%)';
    const reducedBlur = useReducedBlur();

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-[200] flex flex-col animate-fade-in"
            style={{
                background: reducedBlur ? 'rgba(6, 8, 16, 0.92)' : 'rgba(6, 8, 16, 0.72)',
                backdropFilter: reducedBlur ? undefined : 'blur(22px) saturate(1.2)',
                WebkitBackdropFilter: reducedBlur ? undefined : 'blur(22px) saturate(1.2)',
                color: contentColor,
            }}
            onClick={onClose}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between px-5 pt-[calc(env(safe-area-inset-top)+1rem)] pb-3 shrink-0"
                onClick={(e) => e.stopPropagation()}
            >
                <div>
                    <div className="text-[10px] font-bold tracking-[0.25em] uppercase opacity-50">Today</div>
                    <div className="text-lg font-black tracking-tight" style={{ color: accentHsl }}>
                        Daily Schedule
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="w-9 h-9 rounded-full flex items-center justify-center transition-transform active:scale-90"
                    style={{
                        background: 'rgba(255,255,255,0.12)',
                        border: '1px solid rgba(255,255,255,0.18)',
                    }}
                    aria-label="Close"
                >
                    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2.2} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </div>

            {/* Character switcher */}
            {characters.length > 0 && (
                <div
                    className="shrink-0 px-5 pb-3"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="flex gap-2 overflow-x-auto no-scrollbar py-1 -mx-1 px-1">
                        {characters.map(c => {
                            const isActive = c.id === activeCharId;
                            return (
                                <button
                                    key={c.id}
                                    onClick={() => onSwitchCharacter(c.id)}
                                    className="shrink-0 flex flex-col items-center gap-1 transition-transform active:scale-95"
                                    style={{ width: 56 }}
                                >
                                    <div
                                        className={`w-12 h-12 rounded-2xl overflow-hidden transition-all ${isActive ? 'scale-105' : 'opacity-55'}`}
                                        style={{
                                            border: isActive
                                                ? `2px solid ${accentHsl}`
                                                : '2px solid rgba(255,255,255,0.12)',
                                            boxShadow: isActive
                                                ? '0 6px 18px hsla(260, 70%, 55%, 0.45)'
                                                : 'none',
                                        }}
                                    >
                                        {c.avatar ? (
                                            <TokenImg value={c.avatar} alt="" className="w-full h-full object-cover" loading="lazy" />
                                        ) : (
                                            <div className="w-full h-full bg-white/10 flex items-center justify-center text-sm font-bold">
                                                {c.name[0]}
                                            </div>
                                        )}
                                    </div>
                                    <span
                                        className={`text-[10px] truncate max-w-full font-semibold tracking-wide ${isActive ? 'opacity-100' : 'opacity-45'}`}
                                    >
                                        {c.name}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Schedule card */}
            <div
                className="flex-1 min-h-0 overflow-y-auto px-5 pb-[calc(var(--safe-bottom,0px)+1.5rem)] no-scrollbar"
                onClick={(e) => e.stopPropagation()}
            >
                <ScheduleCard
                    schedule={schedule}
                    character={activeCharacter}
                    contentColor={contentColor}
                    compact={true}
                />
                <div className="text-[10px] text-center opacity-40 mt-4 tracking-widest">
                    TAP OUTSIDE TO CLOSE · 点空白处关闭
                </div>
            </div>
        </div>
    );
};

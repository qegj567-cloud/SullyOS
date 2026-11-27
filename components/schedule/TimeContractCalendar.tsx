import React, { useMemo, useState } from 'react';
import type { Anniversary, CharacterProfile, Task } from '../../types';
import { AppID } from '../../types';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';
import { parseLocalDateKey } from '../../utils/localDate';
import { calendarEntries, shiftCalendarMonth, type TimeContractTheme } from '../../utils/timeContract';
import { appShortcutLaunch } from '../../utils/appShortcutLaunch';
import { trackEvent } from '../../utils/analytics';

interface Props {
    contentColor: string;
    openApp: (id: AppID) => void;
    anniversaries: Anniversary[];
    tasks: Task[];
    characters: CharacterProfile[];
    mode: TimeContractTheme;
    acnh?: boolean;
    paper?: boolean;
}

const palettes = {
    cyber: { background: '#0f172a', color: '#e2e8f0', accent: '#67e8f9', border: '1px solid #334155' },
    soft: { background: '#fff0f5', color: '#614755', accent: '#be185d', border: '1px solid #fbcfe8' },
    minimal: { background: '#eef2f6', color: '#475569', accent: '#4f46e5', border: '1px solid #d8dfe8' },
};

/** Only the bounded event list scrolls. Month/day changes reset its page and scroll position. */
export default function TimeContractCalendar({ contentColor, openApp, anniversaries, tasks, characters, mode, acnh, paper }: Props) {
    const today = useLocalDateKey();
    const [month, setMonth] = useState(() => today.slice(0, 7));
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const palette = mode !== 'system' ? palettes[mode] : {
        background: acnh ? 'rgb(247,243,223)' : paper ? 'rgba(245,242,235,.9)' : 'rgba(255,255,255,.12)',
        color: acnh || paper ? '#584d42' : contentColor,
        accent: acnh ? '#527b2e' : paper ? '#8b6244' : contentColor,
        border: '1px solid rgba(160,150,140,.24)',
    };
    const { accent: _accent, ...cardStyle } = palette;
    const entries = useMemo(() => calendarEntries(anniversaries, tasks), [anniversaries, tasks]);
    const monthEntries = useMemo(() => entries.filter(e => e.date.startsWith(month + '-')), [entries, month]);
    const visibleEntries = selectedDate ? monthEntries.filter(e => e.date === selectedDate) : monthEntries;
    const pageCount = Math.max(1, Math.ceil(visibleEntries.length / 50));
    const safePage = Math.min(page, pageCount - 1);
    const first = parseLocalDateKey(`${month}-01`)!;
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const monthLabel = `${first.getFullYear()}年${first.getMonth() + 1}月`;
    const undatedCount = tasks.filter(t => !t.isCompleted && !t.deadline).length;
    const changeMonth = (amount: number) => {
        setMonth(shiftCalendarMonth(month, amount)); setSelectedDate(null); setPage(0);
        trackEvent('浏览时光契约日历', { action: amount < 0 ? 'previous_month' : 'next_month' });
    };
    return <section aria-label="时光契约桌面日历" className="launcher-page time-contract-calendar w-full flex-shrink-0 snap-center snap-always flex flex-col px-5 pt-16 pb-5 gap-3 h-full min-h-0 overflow-hidden" style={{ color: palette.color }}>
        <style>{`@media (max-height:700px) { .time-contract-calendar { padding-top: 1.5rem; } .time-contract-calendar .contract-day { height: 1.5rem; } }`}</style>
        <div className="rounded-3xl p-4 shrink-0" style={cardStyle}>
            <div className="flex items-center gap-1 mb-2">
                <h2 className="text-sm font-semibold flex-1 min-w-0">{monthLabel}</h2>
                <button aria-label="上个月" className="w-9 h-9 rounded-full" onClick={() => changeMonth(-1)}>‹</button>
                <button aria-label="下个月" className="w-9 h-9 rounded-full" onClick={() => changeMonth(1)}>›</button>
                <button aria-label="打开时光契约" className="w-9 h-9 rounded-full text-lg" onClick={() => openApp(AppID.Schedule)}>＋</button>
            </div>
            <div className="grid grid-cols-7 text-center text-[10px] opacity-70 mb-1">{['日','一','二','三','四','五','六'].map(d => <span key={d}>{d}</span>)}</div>
            <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: 42 }, (_, index) => {
                    const day = index - first.getDay() + 1;
                    if (day < 1 || day > days) return <span key={index} className="contract-day h-7" />;
                    const date = `${month}-${String(day).padStart(2, '0')}`;
                    const anniversary = monthEntries.some(e => e.date === date && e.kind === 'anniversary');
                    const task = monthEntries.some(e => e.date === date && e.kind === 'task');
                    return <button key={index} aria-label={`${date}${anniversary ? ' 纪念日' : ''}${task ? ' 待办' : ''}`} aria-pressed={selectedDate === date}
                        onClick={() => { setSelectedDate(selectedDate === date ? null : date); setPage(0); trackEvent('浏览时光契约日历', { action: 'select_day' }); }}
                        className="contract-day relative h-7 rounded-lg text-xs tabular-nums" style={{ background: anniversary ? palette.accent : undefined, color: anniversary ? palette.background.startsWith('#0f') ? '#0f172a' : '#fff' : undefined, outline: selectedDate === date ? `2px solid ${palette.accent}` : date === today ? '1px solid currentColor' : undefined, outlineOffset: 2, fontWeight: date === today ? 700 : undefined }}>
                        {day}{task && <span aria-hidden className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-current" />}
                    </button>;
                })}
            </div>
            <div className="flex justify-between mt-3 text-[10px] opacity-70"><span>■ 纪念日 · 待办</span><button onClick={() => { setMonth(today.slice(0, 7)); setSelectedDate(today); setPage(0); }}>今天</button></div>
        </div>
        <div className="rounded-3xl p-4 flex flex-col flex-1 min-h-0 overflow-hidden" style={cardStyle}>
            <div className="flex items-center gap-2 shrink-0 mb-2">
                <h3 className="text-xs font-semibold flex-1">{selectedDate ? `${monthLabel}${Number(selectedDate.slice(-2))}日` : monthLabel} · {visibleEntries.length}项</h3>
                {selectedDate && <button className="text-[11px] py-2" onClick={() => { setSelectedDate(null); setPage(0); }}>整月</button>}
            </div>
            <div key={`${month}-${selectedDate}-${safePage}`} data-calendar-list className="flex-1 min-h-0 overflow-y-auto overscroll-contain" style={{ touchAction: 'pan-y' }}>
                {visibleEntries.slice(safePage * 50, safePage * 50 + 50).map(entry => <button key={`${entry.kind}-${entry.id}`} onClick={() => { appShortcutLaunch.request({ appId: AppID.Schedule, entryId: entry.kind === 'anniversary' ? 'server_events' : 'quest' }); openApp(AppID.Schedule); }} className="flex gap-3 w-full py-3 text-left border-b" style={{ borderColor: 'rgba(128,128,128,.2)' }}>
                    <span className="text-xs shrink-0 pt-0.5 tabular-nums opacity-70">{entry.date.slice(5).replace('-', '/')}</span>
                    <span className="min-w-0"><span className="block text-sm font-medium break-words">{entry.title}</span><span className="block text-[10px] mt-1 opacity-70">{entry.kind === 'anniversary' ? '纪念日' : '待办'}{characters.find(c => c.id === entry.characterId)?.name ? ` · ${characters.find(c => c.id === entry.characterId)?.name}` : ''}</span></span>
                </button>)}
                {!visibleEntries.length && <p className="text-xs opacity-70 py-5 text-center">{selectedDate ? '这一天没有安排' : '这个月没有安排'}</p>}
            </div>
            {pageCount > 1 && <div className="flex items-center justify-between text-xs shrink-0 pt-2"><button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>上一页</button><span>{safePage + 1}/{pageCount}</span><button disabled={safePage + 1 >= pageCount} onClick={() => setPage(safePage + 1)}>下一页</button></div>}
            {undatedCount > 0 && <button className="shrink-0 text-[11px] pt-3 text-left opacity-75" onClick={() => openApp(AppID.Schedule)}>另有 {undatedCount} 项未设日期的待办 ›</button>}
        </div>
    </section>;
}

import type { Anniversary, Task } from '../types';
import { getLocalDateKey, parseLocalDateKey } from './localDate';

export const TIME_CONTRACT_THEMES = ['system', 'cyber', 'soft', 'minimal'] as const;
export type TimeContractTheme = typeof TIME_CONTRACT_THEMES[number];

/** Existing per-space preference remains readable; new choices live in OSTheme and its backups. */
export function resolveTimeContractTheme(value?: string): TimeContractTheme {
    if (TIME_CONTRACT_THEMES.includes(value as TimeContractTheme)) return value as TimeContractTheme;
    try {
        const legacy = localStorage.getItem('schedule_app_theme');
        if (TIME_CONTRACT_THEMES.includes(legacy as TimeContractTheme)) return legacy as TimeContractTheme;
    } catch { /* Storage may be unavailable in previews. */ }
    return 'system';
}

export function shiftCalendarMonth(month: string, amount: number): string {
    const date = parseLocalDateKey(`${month}-01`);
    if (!date) return month;
    date.setMonth(date.getMonth() + amount);
    return getLocalDateKey(date).slice(0, 7);
}

export interface TimeContractEntry {
    id: string;
    kind: 'anniversary' | 'task';
    title: string;
    date: string;
    characterId: string;
}

export function calendarEntries(anniversaries: Anniversary[], tasks: Task[]): TimeContractEntry[] {
    return [
        ...anniversaries.map(a => ({ id: a.id, kind: 'anniversary' as const, title: a.title, date: a.date, characterId: a.charId })),
        ...tasks.filter(t => !t.isCompleted && t.deadline).map(t => ({ id: t.id, kind: 'task' as const, title: t.title, date: t.deadline!.slice(0, 10), characterId: t.supervisorId })),
    ].filter(entry => parseLocalDateKey(entry.date)).sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

export function notifyTimeContractChanged(): void {
    window.dispatchEvent(new Event('time-contract-changed'));
}

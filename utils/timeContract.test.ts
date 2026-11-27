import { beforeEach, expect, it } from 'vitest';
import { calendarEntries, resolveTimeContractTheme, shiftCalendarMonth } from './timeContract';
import { DB } from './db';
import type { Anniversary, Task } from '../types';

beforeEach(() => localStorage.clear());

it('uses calendar months across year boundaries and leap February', () => {
    expect(shiftCalendarMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftCalendarMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftCalendarMonth('2024-03', -1)).toBe('2024-02');
});

it('keeps dated pending tasks and anniversaries separate, excluding invalid/undated/completed tasks', () => {
    const anniversaries = [{ id: 'a', title: '纪念日', date: '2024-02-29', charId: '' }, { id: 'bad', date: '2026-02-29' }] as Anniversary[];
    const tasks = [{ id: 't', title: '待办', deadline: '2024-02-29', isCompleted: false }, { id: 'done', deadline: '2024-02-29', isCompleted: true }, { id: 'undated' }] as Task[];
    expect(calendarEntries(anniversaries, tasks).map(e => [e.id, e.kind, e.date])).toEqual([
        ['a', 'anniversary', '2024-02-29'], ['t', 'task', '2024-02-29'],
    ]);
    expect(tasks).toHaveLength(3);
});

it('honors unified appearance before legacy settings and rejects free-form values', () => {
    localStorage.setItem('schedule_app_theme', 'soft');
    expect(resolveTimeContractTheme()).toBe('soft');
    expect(resolveTimeContractTheme('minimal')).toBe('minimal');
    expect(resolveTimeContractTheme('system')).toBe('system');
    localStorage.setItem('schedule_app_theme', 'private-user-theme');
    expect(resolveTimeContractTheme('secret-url')).toBe('system');
});

it('persists and deletes completed tasks and anniversaries before resolving', async () => {
    const task = { id: 'contract-completed', title: '已完成', supervisorId: '', tone: 'gentle', isCompleted: true, createdAt: 1, deadline: '2026-11-27' } as Task;
    await DB.saveTask(task);
    expect((await DB.getAllTasks()).find(t => t.id === task.id)).toEqual(task);
    await DB.deleteTask(task.id);
    expect((await DB.getAllTasks()).some(t => t.id === task.id)).toBe(false);
    const event = { id: 'contract-event', title: '纪念日', date: '2026-11-27', charId: '' };
    await DB.saveAnniversary(event);
    expect((await DB.getAllAnniversaries()).find(a => a.id === event.id)).toEqual(event);
    await DB.deleteAnniversary(event.id);
    expect((await DB.getAllAnniversaries()).some(a => a.id === event.id)).toBe(false);
});

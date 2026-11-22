// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import DateExtraPresets from '../components/date/DateExtraPresets';
import { stripSensitiveCardFields } from './characterCard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('applies, duplicates, updates and deletes presets without clearing the current supplement', async () => {
    let saved = [{ id: 'a', name: '日常', content: '生活细节' }, { id: 'b', name: '冒险', content: '加快节奏' }];
    let draft = '';
    let edit!: (value: string) => void;
    function Harness() {
        const [presets, setPresets] = useState(saved);
        const [value, setValue] = useState('');
        edit = setValue; draft = value; saved = presets;
        return React.createElement(DateExtraPresets, { presets, value, onApply: setValue, onChange: setPresets });
    }
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const click = async (label: string) => act(async () => {
        const button = [...host.querySelectorAll('button')].find(el => el.textContent === label);
        expect(button).toBeTruthy(); button!.click();
    });
    const choose = async (id: string) => act(async () => {
        const select = host.querySelector('select')!;
        select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    try {
        await act(async () => root.render(React.createElement(Harness)));
        await choose('a'); expect(draft).toBe('生活细节');
        await act(async () => edit('新的生活细节'));
        expect(saved[0].content).toBe('生活细节');
        await click('存为新预设');
        expect(saved).toHaveLength(3); expect(saved[2].content).toBe('新的生活细节');
        await choose('b'); expect(draft).toBe('加快节奏');
        await act(async () => edit('放慢节奏'));
        await click('更新所选预设'); expect(saved[1].content).toBe('加快节奏');
        await click('确认覆盖所选预设'); expect(saved[1].content).toBe('放慢节奏');
        await click('删除预设'); expect(saved).toHaveLength(3);
        await click('确认删除预设（保留当前补充）');
        expect(saved).toHaveLength(2); expect(draft).toBe('放慢节奏');
        // The two remaining presets share a name; delete only the selected ID.
        expect(saved.map(item => item.name)).toEqual(['日常', '日常']);
        await choose(saved[1].id);
        await click('删除预设'); await click('确认删除预设（保留当前补充）');
        expect(saved).toEqual([{id: 'a', name: '日常', content: '生活细节'}]);
        expect(draft).toBe('新的生活细节');
        expect(stripSensitiveCardFields({ name: '角色', dateExtraPresets: saved })).toEqual({ name: '角色' });
    } finally { act(() => root.unmount()); host.remove(); }
});


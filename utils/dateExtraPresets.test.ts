// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import DateExtraPresets from '../components/date/DateExtraPresets';
import { stripSensitiveCardFields } from './characterCard';
import type { DateExperienceConfig, DateExperiencePreset } from '../types';

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
    const choose = async (id: string) => {
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="自定义补充预设"]')!.click());
        await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-preset-id]')].find(button => button.dataset.presetId === id)!.click());
    };
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

it('saves a complete experience with an empty supplement and keeps legacy application narrow', async () => {
    let saved: DateExperiencePreset[] = [{ id: 'legacy', name: '日常', content: '旧补充' }];
    let active: DateExperienceConfig = { style: 'plain', tone: 'daily_warm', digDeeper: false, sceneSeed: '书房', extra: '' };
    let edit!: (next: DateExperienceConfig) => void;
    function Harness() {
        const [presets, setPresets] = useState(saved);
        const [experience, setExperience] = useState(active);
        saved = presets; active = experience; edit = setExperience;
        return React.createElement(DateExtraPresets, { presets, value: experience.extra || '', experience,
            onApply: (content, full) => setExperience(full || { ...experience, extra: content }), onChange: setPresets });
    }
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const click = async (label: string) => act(async () => {
        const button = [...host.querySelectorAll('button')].find(el => el.textContent === label);
        expect(button).toBeTruthy(); expect(button!.disabled).toBe(false); button!.click();
    });
    const choose = async (id: string) => {
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="自定义补充预设"]')!.click());
        await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-preset-id]')].find(button => button.dataset.presetId === id)!.click());
    };
    try {
        await act(async () => root.render(React.createElement(Harness)));
        await choose('legacy');
        expect(active).toMatchObject({ style: 'plain', sceneSeed: '书房', extra: '旧补充' });
        await act(async () => edit({ ...active, extra: '' }));
        await click('存为新预设');
        expect(saved[1].experience).toEqual(active);
        expect(saved[0]).not.toHaveProperty('experience');
        const completeId = saved[1].id;
        await act(async () => edit({ ...active, sceneSeed: '厨房', tone: 'direct_affection' }));
        await click('更新所选预设');
        expect(saved[1].experience?.sceneSeed).toBe('书房');
        await click('确认覆盖所选预设');
        expect(saved[1].experience?.sceneSeed).toBe('厨房');
        await choose('legacy');
        await choose(completeId);
        expect(active).toMatchObject({ tone: 'direct_affection', sceneSeed: '厨房', extra: '' });
        await click('删除预设'); await click('确认删除预设（保留当前补充）');
        expect(saved).toHaveLength(1);
        expect(active.sceneSeed).toBe('厨房');
    } finally { act(() => root.unmount()); host.remove(); }
});


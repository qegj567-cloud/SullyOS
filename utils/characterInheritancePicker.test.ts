// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CharacterLinkActions from '../components/character/CharacterLinkActions';
const fixture = vi.hoisted(() => ({ load: vi.fn(), inherit: vi.fn() }));
vi.mock('../context/OSContext', () => ({ useOS: () => ({ addToast: vi.fn() }) }));
vi.mock('../hooks/useLocalBackHandler', () => ({ useLocalBackHandler: vi.fn() }));
vi.mock('../components/os/TokenImg', () => ({ default: () => null }));
vi.mock('./db', () => ({ openSpaceDB: async (id: string) => id }));
vi.mock('./userSpaceData', () => ({ readSpaceStore: (...args: any[]) => fixture.load(...args), inheritSpaceCharacters: (...args: any[]) => fixture.inherit(...args) }));
vi.mock('./userSpaces', () => ({ SESSION_SPACE_ID: 'default', isUserSpaceDeleting: () => false, listUserSpaces: () => [{ id: 'default', name: '当前' }, { id: 'u_a', name: 'A' }, { id: 'u_b', name: 'B' }] }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const buttons = () => Array.from(document.querySelectorAll('button'));
const button = (text: string) => buttons().find(b => b.textContent === text)!;
const group = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="全选${name}"]`)!;
beforeEach(async () => {
    fixture.load.mockImplementation(async (id, table) => table === 'character_groups' ? [{ id: 'g', name: '朋友', order: 1 }] : id === 'u_a' ? [{ id: 'a', name: '甲', groupId: 'g' }, { id: 'b', name: '乙', groupId: 'g' }, { id: 'c', name: '丙', groupId: 'deleted-group' }] : []);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(React.createElement(CharacterLinkActions, { onCreate: vi.fn() })));
    await act(async () => button('从其他用户载入角色').click());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });
it('selects whole groups, includes orphaned groups as ungrouped, and preserves independent choices', () => {
    act(() => group('朋友').click()); expect(button('继承 2 位').disabled).toBe(false);
    act(() => group('未分组').click()); expect(button('继承 3 位').disabled).toBe(false);
    act(() => group('朋友').click()); expect(button('继承 1 位').disabled).toBe(false); expect(group('未分组').checked).toBe(true);
    const all = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(all.indeterminate).toBe(true); act(() => all.click()); expect(button('继承 3 位').disabled).toBe(false);
});
it('clears selection immediately when changing source, and ignores a late previous source response', async () => {
    act(() => group('朋友').click());
    let resolveB!: (rows: any[]) => void;
    fixture.load.mockImplementation((id, table) => id === 'u_b' && table === 'characters' ? new Promise(resolve => { resolveB = resolve; }) : Promise.resolve([]));
    const select = document.querySelector('select')!;
    await act(async () => { select.value = 'u_b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(button('继承 0 位').disabled).toBe(true);
    await act(async () => { select.value = 'u_a'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => resolveB([{ id: 'late', name: '过期角色' }]));
    expect(document.body.textContent).not.toContain('过期角色'); expect(button('继承 0 位').disabled).toBe(true);
});

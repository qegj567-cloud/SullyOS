// @vitest-environment jsdom
import React, { act } from 'react';
import { Simulate } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NavigationSlotPicker from '../components/settings/NavigationSlotPicker';
import { AppID } from '../types';
import { handleLocalBack } from './localBackHandlers';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const click = async (name: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.includes(name) || item.getAttribute('aria-label') === name);
  expect(button, name).toBeTruthy(); button!.click();
});
const search = async (text: string) => act(async () => {
  const input = host.querySelector('input')!; input.value = text; Simulate.change(input);
});
it('bounds DOM for 10,000 characters and searches/selects the actual stable ID', async () => {
  const onSelect = vi.fn(), loadWorlds = vi.fn();
  const characters = Array.from({ length: 10000 }, (_, index) => ({ id: `c${index}`, name: `角色 ${index}` }));
  await act(async () => root.render(React.createElement(NavigationSlotPicker, { slot: 0, characters, loadWorlds, onSelect, onClose: vi.fn() })));
  await search('聊天'); await click('Message');
  expect(host.querySelectorAll('[role=listitem]').length).toBeLessThanOrEqual(12);
  await search('角色 9999'); expect(host.querySelector('[role=status]')?.textContent).toBe('1 个角色');
  await click('角色 9999'); expect(onSelect).toHaveBeenLastCalledWith({ appId: AppID.Chat, roomTab: undefined, characterId: 'c9999', targetName: '角色 9999' });
  expect(loadWorlds).not.toHaveBeenCalled();
});
it('distinguishes room/3D/world, loads worlds only when chosen and allows list-only shortcuts', async () => {
  const onSelect = vi.fn(), loadWorlds = vi.fn(async () => [{ id: 'world', name: '海边的家' }]);
  await act(async () => root.render(React.createElement(NavigationSlotPicker, { slot: 1, characters: [{ id: 'c', name: 'Sully' }], loadWorlds, onSelect, onClose: vi.fn() })));
  await search('小小窝'); await click('小小窝'); expect(loadWorlds).not.toHaveBeenCalled();
  await click('拜访 3D'); await click('Sully'); expect(onSelect.mock.lastCall?.[0]).toMatchObject({ appId: AppID.Room, roomTab: 'home3D', characterId: 'c' });
  await act(async () => (host.querySelector('[aria-label="返回选择上一级"]') as HTMLButtonElement).click());
  await click('家园'); expect(loadWorlds).toHaveBeenCalledOnce();
  await click('海边的家'); expect(onSelect.mock.lastCall?.[0]).toEqual({ appId: AppID.Room, roomTab: 'worldHome', worldId: 'world', targetName: '海边的家' });
  await click('只打开家园列表'); expect(onSelect.mock.lastCall?.[0]).toEqual({ appId: AppID.Room, roomTab: 'worldHome' });
});
it('shows world read failure and retries without changing a slot', async () => {
  const onSelect = vi.fn(), loadWorlds = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([]);
  await act(async () => root.render(React.createElement(NavigationSlotPicker, { slot: 0, characters: [], loadWorlds, onSelect, onClose: vi.fn() })));
  await search('小小窝'); await click('小小窝'); await click('家园');
  expect(host.textContent).toContain('读取失败'); expect(onSelect).not.toHaveBeenCalled();
  await click('重试'); expect(loadWorlds).toHaveBeenCalledTimes(2); expect(host.textContent).toContain('还没有家园世界');
});

it('exposes other App sections, then characters, and returns without accidentally saving', async () => {
  const onSelect = vi.fn(), loadWorlds = vi.fn();
  await act(async () => root.render(React.createElement(NavigationSlotPicker, { slot: 0, characters: [{ id: 'c', name: 'Sully' }], loadWorlds, onSelect, onClose: vi.fn() })));
  await search('查手机'); await click('查手机'); expect(host.textContent).toContain('10 个分区'); expect(onSelect).not.toHaveBeenCalled();
  await search('通讯录'); await click('通讯录'); expect(host.textContent).toContain('选择角色');
  await click('Sully'); expect(onSelect.mock.lastCall?.[0]).toMatchObject({ appId: AppID.CheckPhone, entryId: 'contacts', characterId: 'c' });
  onSelect.mockClear();
  await act(async () => (host.querySelector('[aria-label="返回选择上一级"]') as HTMLButtonElement).click());
  expect(host.textContent).toContain('10 个分区'); expect(onSelect).not.toHaveBeenCalled();
  await act(async () => (host.querySelector('[aria-label="返回选择上一级"]') as HTMLButtonElement).click());
  await search('记忆宫殿'); await click('记忆宫殿'); await click('像素家园'); await click('Sully');
  expect(onSelect.mock.lastCall?.[0]).toMatchObject({ appId: AppID.MemoryPalace, entryId: 'pixelHome', characterId: 'c' });
  expect(loadWorlds).not.toHaveBeenCalled();
});
it('offers actual saved content by stable ID and preserves root-only selection', async () => {
  const onSelect = vi.fn();
  await act(async () => root.render(React.createElement(NavigationSlotPicker, { slot: 0, characters: [], resources: { [AppID.GroupChat]: [{ id: 'g2', name: '星星组' }, { id: 'g1', name: '星星组' }] }, onSelect, onClose: vi.fn() })));
  await search('群聊'); await click('群聊');
  expect(host.textContent).toContain('2 个内容');
  await click('星星组'); expect(onSelect.mock.lastCall?.[0]).toEqual({ appId: AppID.GroupChat, resourceId: 'g2', targetName: '星星组' });
  await click('只打开群聊列表'); expect(onSelect.mock.lastCall?.[0]).toEqual({ appId: AppID.GroupChat });
});

const press = async (target: Element, key: string, extra: KeyboardEventInit = {}) => act(async () => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
});
it('opens and changes stages without focusing search, and restores the original button on close', async () => {
  const opener=document.createElement('button'); document.body.prepend(opener); opener.focus();
  await act(async () => root.render(React.createElement(NavigationSlotPicker,{slot:0,characters:[{id:'c',name:'Sully'}],onSelect:vi.fn(),onClose:vi.fn()})));
  expect(document.activeElement).toBe(host.querySelector('[role=dialog]'));
  const input=host.querySelector('input')!;
  await act(async () => input.focus()); await search('Message'); await click('Message');
  expect(document.activeElement).toBe(host.querySelector('[role=dialog]')); expect(input.value).toBe('');
  await act(async () => root.render(null)); expect(document.activeElement).toBe(opener); opener.remove();
});
it('does not reopen input when parent callbacks change, and Escape uses the latest close callback', async () => {
  const first=vi.fn(), latest=vi.fn();
  const props={slot:0,characters:[],onSelect:vi.fn(),onClose:first};
  await act(async () => root.render(React.createElement(NavigationSlotPicker,props)));
  const input=host.querySelector('input')!; await act(async () => input.focus()); await search('聊天');
  await click('收起键盘');
  expect(document.activeElement).toBe(host.querySelector('[role=dialog]')); expect(input.value).toBe('聊天');
  await act(async () => root.render(React.createElement(NavigationSlotPicker,{...props,onClose:latest})));
  expect(document.activeElement).not.toBe(input); expect(input.value).toBe('聊天');
  await press(document.activeElement!,'Escape'); expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledOnce();
});
it('finishes search with Enter or outside clicks without dropping the query or selecting a slot', async () => {
  const select=vi.fn();
  await act(async () => root.render(React.createElement(NavigationSlotPicker,{slot:0,characters:[],onSelect:select,onClose:vi.fn()})));
  const input=host.querySelector('input')!; await act(async () => input.focus()); await search('聊天');
  await press(input,'Enter',{isComposing:true}); expect(document.activeElement).toBe(input);
  await press(input,'Enter'); expect(document.activeElement).not.toBe(input); expect(input.value).toBe('聊天');
  await act(async () => input.focus());
  await act(async () => (host.querySelector('[role=status]') as HTMLElement).click());
  expect(document.activeElement).not.toBe(input); expect(input.value).toBe('聊天'); expect(select).not.toHaveBeenCalled();
  expect(input.getAttribute('enterkeyhint')).toBe('done');
});
it('backs out of focused search first, then the selection stage, without saving or reopening the keyboard', async () => {
  const close=vi.fn(), select=vi.fn();
  await act(async () => root.render(React.createElement(NavigationSlotPicker,{slot:0,characters:[{id:'c',name:'Sully'}],onSelect:select,onClose:close})));
  await search('Message'); await click('Message');
  const input=host.querySelector('input')!; await act(async () => input.focus()); await search('Sully');
  await act(async () => {expect(handleLocalBack()).toBe(true);});
  expect(host.querySelector('h3')!.textContent).toBe('选择角色'); expect(input.value).toBe('Sully'); expect(document.activeElement).not.toBe(input);
  await act(async () => {handleLocalBack();});
  expect(host.querySelector('h3')!.textContent).toBe('选择快捷入口'); expect(input.value).toBe(''); expect(close).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  await act(async () => input.focus()); await press(input,'Escape'); expect(close).not.toHaveBeenCalled();
  await press(document.activeElement!,'Escape'); expect(close).toHaveBeenCalledOnce();
});
it('keeps reverse Tab inside the dialog from its initial non-editable focus', async () => {
  await act(async () => root.render(React.createElement(NavigationSlotPicker,{slot:0,characters:[],onSelect:vi.fn(),onClose:vi.fn()})));
  const dialog=host.querySelector('[role=dialog]')!;
  await press(dialog,'Tab',{shiftKey:true});
  expect(document.activeElement?.textContent).toBe('取消');
});

it('does not restore an editable opener and reopen its keyboard on close', async () => {
  const opener=document.createElement('input'); document.body.prepend(opener); opener.focus();
  await act(async () => root.render(React.createElement(NavigationSlotPicker,{slot:0,characters:[],onSelect:vi.fn(),onClose:vi.fn()})));
  expect(document.activeElement).not.toBe(opener);
  await act(async () => root.render(null)); expect(document.activeElement).not.toBe(opener); opener.remove();
});

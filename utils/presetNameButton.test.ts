// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PresetNameButton from '../components/settings/PresetNameButton';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, button: HTMLButtonElement;
const select = vi.fn(), edit = vi.fn();
const pointer = (type: string, x = 20, y = 20) => act(() => {
  button.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, relatedTarget: null }));
});
const click = () => act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
beforeEach(() => {
  vi.useFakeTimers(); select.mockClear(); edit.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(React.createElement(PresetNameButton, { onHold: edit, onClick: select }, '预设')));
  button = host.querySelector('button')!;
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
it('手机松手后的 pointerleave 不吞掉点击', () => {
  pointer('pointerdown'); pointer('pointerup'); pointer('pointerout'); click();
  expect(select).toHaveBeenCalledTimes(1); expect(edit).not.toHaveBeenCalled();
});
it('按住移动后不切换，也不长按编辑；下一次轻点恢复正常', () => {
  pointer('pointerdown'); pointer('pointermove', 20, 40);
  act(() => vi.advanceTimersByTime(600)); pointer('pointerup'); pointer('pointerout'); click();
  expect(select).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
  pointer('pointerdown'); pointer('pointerup'); pointer('pointerout'); click();
  expect(select).toHaveBeenCalledTimes(1);
});
it('滚动中的手势不误触，松手后不再常驻滚动监听', () => {
  const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener');
  pointer('pointerdown');
  const listener = add.mock.calls.find(call => call[0] === 'scroll')![1];
  act(() => document.dispatchEvent(new Event('scroll')));
  pointer('pointerup'); click();
  expect(select).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith('scroll', listener, true);
  add.mockRestore(); remove.mockRestore();
});
it('长按只编辑一次，不顺带选择', () => {
  pointer('pointerdown'); act(() => vi.advanceTimersByTime(600));
  pointer('pointerup'); pointer('pointerout'); click();
  expect(edit).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled();
});
it('系统取消触摸后不选择或编辑', () => {
  pointer('pointerdown'); pointer('pointercancel');
  act(() => vi.advanceTimersByTime(600)); click();
  expect(edit).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});
it('鼠标悬停不是拖动，键盘仍可选择和编辑', () => {
  pointer('pointermove', 90, 90); act(() => button.click());
  expect(select).toHaveBeenCalledTimes(1);
  act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })));
  expect(edit).toHaveBeenCalledTimes(1);
});

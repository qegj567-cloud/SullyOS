// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionApiTest } from '../../components/companion/CompanionApiTest';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const props = { label: '测试接口', description: '测试说明', config: { apiKey: 'secret-key' }, begin: vi.fn() };
const click = () => act(async () => host.querySelector('button')!.click());

it('does not call APIs on mount, displays measured success, and invalidates it on config edits', async () => {
  const task = deferred<any>(), run = vi.fn(() => task.promise);
  await act(async () => root.render(React.createElement(CompanionApiTest, { ...props, run })));
  expect(run).not.toHaveBeenCalled(); expect(host.textContent).toContain('尚未测试'); await click();
  await act(async () => vi.advanceTimersByTime(2300));
  expect(host.textContent).toContain('2.2 秒');
  await act(async () => task.resolve({ summary: '已回复', detail: 'secret-key 不应出现在面板' }));
  expect(host.textContent).toContain('测试通过'); expect(host.textContent).toContain('2.3 秒'); expect(host.textContent).not.toContain('secret-key');
  await act(async () => root.render(React.createElement(CompanionApiTest, { ...props, config: { apiKey: 'changed-key' }, run })));
  expect(host.textContent).toContain('尚未测试'); expect(host.textContent).not.toContain('测试通过'); expect(run).toHaveBeenCalledOnce();
});

it('cancels immediately and ignores a late completion, including after a configuration change or unmount', async () => {
  const task = deferred<any>(); let signal!: AbortSignal;
  const run = vi.fn((s: AbortSignal) => { signal = s; return task.promise; });
  await act(async () => root.render(React.createElement(CompanionApiTest, { ...props, run })));
  await click(); await act(async () => host.querySelectorAll('button')[1].click());
  expect(signal.aborted).toBe(true); expect(host.textContent).toContain('已取消');
  await act(async () => task.resolve({ summary: '过期成功' })); expect(host.textContent).not.toContain('过期成功');
  const never = vi.fn((s: AbortSignal) => { signal = s; return new Promise<any>(() => {}); });
  await act(async () => root.render(React.createElement(CompanionApiTest, { ...props, run: never })));
  await click();
  await act(async () => root.render(React.createElement(CompanionApiTest, { ...props, config: { apiKey: 'new' }, run: never })));
  expect(signal.aborted).toBe(true); expect(host.textContent).toContain('尚未测试');
  await click(); act(() => root.unmount()); expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  root = createRoot(host);
});

it('shows actionable failures with credentials redacted and enforces a hard deadline', async () => {
  await act(async () => root.render(React.createElement(CompanionApiTest, { ...props, run: async () => { throw new Error('HTTP 401 secret-key'); } })));
  await click(); expect(host.textContent).toContain('测试失败'); expect(host.textContent).toContain('鉴权失败'); expect(host.textContent).not.toContain('secret-key');
  let signal!: AbortSignal;
  await act(async () => root.render(React.createElement(CompanionApiTest, { ...props, run: s => { signal = s; return new Promise(() => {}); } })));
  await click(); await act(async () => vi.advanceTimersByTime(90_000));
  expect(signal.aborted).toBe(true); expect(host.textContent).toContain('测试超时'); expect(vi.getTimerCount()).toBe(0);
});

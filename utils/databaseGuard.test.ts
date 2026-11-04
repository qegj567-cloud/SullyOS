// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import DatabaseGuard from '../components/DatabaseGuard';
import { reportDatabaseFailure } from './databaseHealth';

const mocks = vi.hoisted(() => ({ check: vi.fn(), open: vi.fn() }));
vi.mock('./db', () => ({ openDB: mocks.open }));
vi.mock('./databaseHealth', async importOriginal => ({
  ...await importOriginal<typeof import('./databaseHealth')>(), checkDatabaseReadable: mocks.check,
}));
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined; mocks.check.mockReset();
});

async function mount(child: React.ReactNode, readiness?: Promise<void>) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(DatabaseGuard, { children: child, readiness })));
}

it('does not mount default-seeding/sync providers until storage is readable, including an empty installation', async () => {
  let ready!: () => void;
  mocks.check.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  const mounted = vi.fn();
  function Child() { React.useEffect(() => { mounted(); }, []); return React.createElement('p', null, '桌面'); }
  await mount(React.createElement(Child));
  expect(mounted).not.toHaveBeenCalled();
  expect(host.textContent).toBe('');
  expect(host.querySelector('.database-guard')).toBeNull();
  expect(host.querySelector<HTMLElement>('[data-database-pending]')?.hidden).toBe(true);
  await act(async () => ready());
  expect(mounted).toHaveBeenCalledOnce();
  expect(host.textContent).toBe('桌面');
  expect(host.querySelector('[data-database-pending]')).toBeNull();
});

it('shares the entry check through StrictMode and mounts the desktop without waiting for the SW', async () => {
  let readable!: () => void;
  const readiness = new Promise<void>(resolve => { readable = resolve; });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(React.StrictMode, null,
    React.createElement(DatabaseGuard, { readiness, children: React.createElement('p', { 'data-testid': 'desktop' }, '桌面') }))));
  expect(mocks.check).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid=desktop]')).toBeNull();
  await act(async () => readable());
  expect(host.textContent).toBe('桌面');
  expect(mocks.check).not.toHaveBeenCalled();
});

it('shows actionable index-conflict diagnostics instead of an empty desktop and does not alter saved settings', async () => {
  localStorage.setItem('os_api_config', 'secret-preserve');
  mocks.check.mockRejectedValue(new DOMException('Index with the same ID already exists', 'UnknownError'));
  const mounted = vi.fn();
  function Child() { mounted(); return null; }
  await mount(React.createElement(Child));
  expect(mounted).not.toHaveBeenCalled();
  expect(host.textContent).toContain('读取失败不代表数据已被清空');
  expect(host.textContent).toContain('内部索引冲突');
  expect(host.textContent).not.toContain('如果其他页面');
  expect(host.querySelector('textarea')!.value).toContain('UnknownError');
  expect(host.querySelector('textarea')!.value).not.toContain('secret-preserve');
  expect(localStorage.getItem('os_api_config')).toBe('secret-preserve');
});

it('unmounts the active app after an open failure caught by a background caller', async () => {
  mocks.check.mockResolvedValue(undefined);
  const stopped = vi.fn();
  function Child() { React.useEffect(() => stopped, []); return React.createElement('p', null, '桌面'); }
  await mount(React.createElement(Child));
  await act(async () => reportDatabaseFailure(new Error('Index with the same ID already exists')));
  expect(stopped).toHaveBeenCalledOnce();
  expect(host.querySelector('h1')!.textContent).toBe('暂时无法读取本地数据');
});

// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DeploymentNotice from '../components/os/DeploymentNotice';
import { useDeploymentNotice } from '../hooks/useDeploymentNotice';
import { DEPLOYMENT_NOTICE_KEY } from './deploymentNotice';
import { detectDeploymentSource } from './deploymentSource';
import { handleLocalBack } from './localBackHandlers';

vi.mock('./deploymentSource', () => ({ detectDeploymentSource: vi.fn(async () => 'unofficial') }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
  vi.mocked(detectDeploymentSource).mockResolvedValue('unofficial');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

function Startup({ bootDone = true }: { bootDone?: boolean }) {
  const notice = useDeploymentNotice();
  if (!bootDone) return React.createElement('p', {}, '开机动画');
  if (notice.blocked) {
    if (notice.source === 'checking') return React.createElement('p', {}, '正在确认来源');
    if (notice.source !== 'official') return React.createElement(DeploymentNotice, { source: notice.source, onAccept: notice.accept });
  }
  return React.createElement('p', {}, '后续启动流程');
}
async function render(bootDone = true) {
  await act(async () => root.render(React.createElement(StrictMode, {}, React.createElement(Startup, { bootDone }))));
}
async function advance(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function remount() { await act(async () => root.unmount()); root = createRoot(host); await render(); }

it('starts the full ten seconds when shown, blocks escape/back/backdrop, and only persists on confirmation', async () => {
  await render(false); await advance(15000); await render();
  const button = host.querySelector('button')!;
  expect(button.disabled).toBe(true); expect(button.textContent).toContain('10');
  const cancel = new Event('cancel', { cancelable: true, bubbles: true });
  await act(async () => {
    button.click(); host.querySelector('dialog')!.dispatchEvent(cancel);
    host.querySelector('dialog')!.click(); expect(handleLocalBack()).toBe(true);
  });
  expect(cancel.defaultPrevented).toBe(true);
  expect(localStorage.getItem(DEPLOYMENT_NOTICE_KEY)).toBeNull();
  await advance(9999); expect(button.disabled).toBe(true);
  await advance(1); expect(button.disabled).toBe(false);
  expect(localStorage.getItem(DEPLOYMENT_NOTICE_KEY)).toBeNull();
  await act(async () => button.click());
  expect(localStorage.getItem(DEPLOYMENT_NOTICE_KEY)).toBe('1');
  expect(host.textContent).toBe('后续启动流程');
  await remount(); expect(host.textContent).toBe('后续启动流程');
});

it('does not acknowledge on unmount and requires ten seconds again when reopened', async () => {
  await render(); await advance(9000); await remount();
  expect(host.querySelector('button')!.textContent).toContain('10');
  expect(localStorage.getItem(DEPLOYMENT_NOTICE_KEY)).toBeNull();
});

it('shows uncertain wording for unknown sources and emphasizes all chat records and API keys', async () => {
  vi.mocked(detectDeploymentSource).mockResolvedValue('unknown');
  await render();
  expect(host.textContent).toContain('无法确认');
  expect(host.querySelector('strong.text-red-700')?.textContent).toContain('全部聊天记录、API 密钥');
});

it('continues immediately for official sources without marking the warning read', async () => {
  vi.mocked(detectDeploymentSource).mockResolvedValue('official');
  await render(); expect(host.textContent).toBe('后续启动流程');
  expect(localStorage.getItem(DEPLOYMENT_NOTICE_KEY)).toBeNull();
});

it('holds subsequent startup UI while native identity is still pending', async () => {
  let finish!: (source: 'official') => void;
  vi.mocked(detectDeploymentSource).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(); expect(host.textContent).toBe('正在确认来源');
  await act(async () => finish('official')); expect(host.textContent).toBe('后续启动流程');
});

it('can continue when storage is unavailable without getting stuck on confirmation', async () => {
  await render(); await advance(10000);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).toBe('后续启动流程');
});

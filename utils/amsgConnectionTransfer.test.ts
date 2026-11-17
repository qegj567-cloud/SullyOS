// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import AmsgConnectionTransfer from '../components/settings/AmsgConnectionTransfer';
import { createAmsgConnectionCode, verifyAmsgConnection } from './amsgConnectionCode';
import { discoverAmsgBackends } from './cfProvision';
vi.mock('./cfProvision', () => ({ discoverAmsgBackends: vi.fn() }));
vi.mock('./amsgConnectionCode', async importActual => ({ ...await importActual<typeof import('./amsgConnectionCode')>(), verifyAmsgConnection: vi.fn() }));
let host: HTMLDivElement;
let root: Root;
const apply = vi.fn();
const original = { workerUrl: 'https://old.example.test', userId: 'original-identity', serverToken: 'fixture-token' };
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  apply.mockReset().mockResolvedValue(undefined);
  vi.mocked(verifyAmsgConnection).mockReset().mockResolvedValue(undefined);
  vi.mocked(discoverAmsgBackends).mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(React.createElement(AmsgConnectionTransfer, { config: { workerUrl: '', userId: 'new-device' }, onApply: apply, receive: true })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function click(text: string) {
  const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === text);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function fill(selector: string, value: string) {
  const field = host.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function preview() { await fill('textarea', createAmsgConnectionCode(original)); await click('读取连接码'); }

it('back leaves the connection preview first and keeps the input without connecting', async () => {
  const { handleLocalBack } = await import('./localBackHandlers');
  await preview();
  await act(async () => { expect(handleLocalBack()).toBe(true); });
  expect(host.querySelector('.amsg-connection-preview')).toBeNull();
  expect(host.querySelector('textarea')?.value).toBe(createAmsgConnectionCode(original));
  expect(handleLocalBack()).toBe(false);
  expect(apply).not.toHaveBeenCalled(); expect(verifyAmsgConnection).not.toHaveBeenCalled();
});

it('a covered transfer form does not intercept another page’s back action', async () => {
  const { handleLocalBack } = await import('./localBackHandlers');
  await preview();
  await act(async () => root.render(React.createElement(AmsgConnectionTransfer, { config: { workerUrl: '', userId: 'new-device' }, onApply: apply, receive: true, active: false })));
  expect(handleLocalBack()).toBe(false);
  expect(host.querySelector('.amsg-connection-preview')).not.toBeNull();
});

it('switching from a receive preview to sending returns from the visible form first', async () => {
  const { handleLocalBack } = await import('./localBackHandlers');
  await preview();
  await act(async () => root.render(React.createElement(AmsgConnectionTransfer, { config: { ...original, initializedAt: 1 }, onApply: apply })));
  const send = [...host.querySelectorAll('button')].find(button => button.textContent?.startsWith('给新设备一份连接码'))!;
  await act(async () => send.click());
  expect(host.textContent).toContain('生成连接码');
  await act(async () => { expect(handleLocalBack()).toBe(true); });
  expect(host.querySelector('.amsg-transfer-form')).toBeNull();
  expect(handleLocalBack()).toBe(false);
});

it('preview performs no network or configuration writes; explicit connect validates before restoring the original identity', async () => {
  await preview();
  expect(verifyAmsgConnection).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  expect(host.textContent).toContain('替换原设备的通知接收位置');
  await click('验证并连接这台设备');
  expect(verifyAmsgConnection).toHaveBeenCalledWith(expect.objectContaining(original), { useRelay: undefined, relayToken: undefined });
  expect(apply).toHaveBeenCalledWith(expect.objectContaining(original));
  expect(apply.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(verifyAmsgConnection).mock.invocationCallOrder[0]);
  expect(host.textContent).toContain('已接回原后台');
});
it('incorrect credentials preserve the device connection and leave a useful retry path', async () => {
  vi.mocked(verifyAmsgConnection).mockRejectedValue(new Error('后台没有接受这份连接码'));
  await preview(); await click('验证并连接这台设备');
  expect(apply).not.toHaveBeenCalled(); expect(host.textContent).toContain('后台没有接受');
  expect(host.querySelector('textarea')?.value).toContain('SULLY-AMSG2:');
});
it('editing a custom domain to an invalid intermediate value does not crash or contact that address', async () => {
  await preview(); await fill('input[type="url"]', 'https://'); await click('验证并连接这台设备');
  expect(verifyAmsgConnection).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  expect(host.textContent).toContain('后台地址无效');
});
it('token discovery leaves credentials and subscriptions untouched and explains the next recovery step', async () => {
  vi.mocked(discoverAmsgBackends).mockResolvedValue({ backends: [{ account: { id: 'a', name: 'Personal' }, scriptName: 'sullyos-amsg', urls: ['https://custom.example.test'] }], warnings: [] });
  await fill('input[type="password"]', 'fixture-cf-token'); await click('查找已有后台');
  expect(discoverAmsgBackends).toHaveBeenCalledWith('fixture-cf-token', 'sullyos-amsg');
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.textContent).toContain('找到 1 个已有后台');
  await click('用连接码接回');
  expect(host.querySelector('textarea')).not.toBeNull();
  await click('返回查找结果');
  await click('换个 Token 或重新查找');
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('fixture-cf-token');
  expect(apply).not.toHaveBeenCalled(); expect(verifyAmsgConnection).not.toHaveBeenCalled();
});

it('a deployment handoff waits until visible and runs once across tab revisits', async () => {
  const discoveryRequest = { token: 'fixture-handoff-token', scriptName: 'custom-amsg' };
  const onDiscoveryStarted = vi.fn();
  vi.mocked(discoverAmsgBackends).mockResolvedValue({ backends: [], warnings: [] });
  const render = (active: boolean) => act(async () => root.render(React.createElement(React.StrictMode, null,
    React.createElement(AmsgConnectionTransfer, { config: { workerUrl: '', userId: 'new-device' }, onApply: apply, receive: true, active, discoveryRequest, onDiscoveryStarted }))));
  await render(false);
  expect(discoverAmsgBackends).not.toHaveBeenCalled();
  await render(true);
  expect(discoverAmsgBackends).toHaveBeenCalledOnce();
  expect(discoverAmsgBackends).toHaveBeenCalledWith('fixture-handoff-token', 'custom-amsg');
  expect(onDiscoveryStarted).toHaveBeenCalledOnce();
  expect(host.querySelector('details')?.open).toBe(true);
  await render(false); await render(true);
  expect(discoverAmsgBackends).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled(); expect(verifyAmsgConnection).not.toHaveBeenCalled();
});

it('StrictMode effect replay does not duplicate the automatic lookup', async () => {
  vi.mocked(discoverAmsgBackends).mockResolvedValue({ backends: [], warnings: [] });
  const onDiscoveryStarted = vi.fn();
  await act(async () => root.render(React.createElement(React.StrictMode, null,
    React.createElement(AmsgConnectionTransfer, {
      config: { workerUrl: '', userId: 'new-device' }, onApply: apply, receive: true,
      discoveryRequest: { token: 'fixture-handoff-token', scriptName: 'custom-amsg' }, onDiscoveryStarted,
    }))));
  expect(discoverAmsgBackends).toHaveBeenCalledOnce();
  expect(onDiscoveryStarted).toHaveBeenCalledOnce();
});

it('failed automatic discovery keeps the transferred fields for a manual retry', async () => {
  vi.mocked(discoverAmsgBackends).mockRejectedValueOnce(new Error('暂时无法连接 Cloudflare')).mockResolvedValueOnce({ backends: [], warnings: [] });
  await act(async () => root.render(React.createElement(AmsgConnectionTransfer, {
    config: { workerUrl: '', userId: 'new-device' }, onApply: apply, receive: true,
    discoveryRequest: { token: 'fixture-handoff-token', scriptName: 'custom-amsg' },
  })));
  const discovery = host.querySelector('details')!;
  expect(discovery.open).toBe(true);
  expect(discovery.querySelector('[role="alert"]')?.textContent).toContain('暂时无法连接');
  expect(discovery.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('fixture-handoff-token');
  await click('查找已有后台');
  expect(discoverAmsgBackends).toHaveBeenNthCalledWith(2, 'fixture-handoff-token', 'custom-amsg');
  expect(discovery.querySelector('[role="alert"]')).toBeNull();
  expect(discovery.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('fixture-handoff-token');
  expect(apply).not.toHaveBeenCalled();
});

it('result actions restore backups and require a selected backend plus confirmation before redeploying', async () => {
  const backends = ['one', 'two'].map(id => ({ account: { id, name: id }, scriptName: 'custom-amsg', urls: [] }));
  const redeploy = vi.fn().mockResolvedValue(undefined), restoreBackup = vi.fn();
  vi.mocked(discoverAmsgBackends).mockResolvedValue({ backends, warnings: [] });
  await act(async () => root.render(React.createElement(AmsgConnectionTransfer, {
    config: { workerUrl: '', userId: 'new-device' }, onApply: apply, receive: true,
    discoveryRequest: { token: 'fixture-cf-token', scriptName: 'custom-amsg' }, onRedeploy: redeploy, onRestoreBackup: restoreBackup,
  })));
  await click('从备份恢复'); expect(restoreBackup).toHaveBeenCalledOnce();
  const restart = [...host.querySelectorAll('button')].find(button => button.textContent === '重新部署，不接续旧数据')!;
  expect(restart.disabled).toBe(true);
  const select = host.querySelector('select')!;
  await act(async () => { select.value = 'two'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('重新部署，不接续旧数据'); expect(redeploy).not.toHaveBeenCalled();
  const { handleLocalBack } = await import('./localBackHandlers');
  await act(async () => { expect(handleLocalBack()).toBe(true); });
  expect(host.querySelector('.amsg-redeploy-confirm')).toBeNull(); expect(redeploy).not.toHaveBeenCalled();
  await click('重新部署，不接续旧数据'); await click('确认重新部署');
  expect(redeploy).toHaveBeenCalledOnce(); expect(redeploy).toHaveBeenCalledWith('fixture-cf-token', backends[1]);
  expect(apply).not.toHaveBeenCalled(); expect(verifyAmsgConnection).not.toHaveBeenCalled();
});

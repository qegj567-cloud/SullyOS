// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AmsgReproductionPanel from '../components/AmsgReproductionPanel';
import { startReproduction } from './amsgReproductionClient';
import type { APIConfig } from '../types';

vi.mock('./amsgReproductionClient', () => ({ startReproduction: vi.fn(), collectReproductionReport: vi.fn() }));
const initial = { baseUrl: 'https://current.example/v1', apiKey: 'current-key', model: 'current-model' } as APIConfig;
const latest = { baseUrl: 'https://latest.example/v1', apiKey: 'latest-key', model: 'latest-model' } as APIConfig;
const presets = [{ id: 'cheap', name: '便宜模型', config: { baseUrl: 'https://cheap.example/v1', apiKey: 'cheap-key', model: 'cheap-model' } }];
let host: HTMLDivElement;
let root: Root;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const render = async (apiConfig = initial) => act(async () => {
  root.render(React.createElement(AmsgReproductionPanel, { apiConfig, apiPresets: presets }));
});
const click = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
};
beforeEach(async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(startReproduction).mockReset().mockImplementation(async () => ({ runId: crypto.randomUUID(), createdAt: Date.now(), dueAt: Date.now() + 60000, api: { host: 'test', model: 'test' }, status: 'scheduled' }));
  await render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('复现面板默认沿用当前设置', () => {
  it('无需填写配置，设置加载或更改后直接使用最新整套配置', async () => {
    expect(host.querySelector('input[type=password]')).toBeNull();
    await render(latest);
    expect(host.textContent).toContain('latest-model');
    await click('开始测试');
    expect(startReproduction).toHaveBeenCalledWith(latest, 'background', 60);
  });
  it('换预设只覆盖这轮，之后可以恢复跟随最新设置', async () => {
    await click('更换 API');
    await click('便宜模型');
    await render(latest);
    await click('开始测试');
    expect(startReproduction).toHaveBeenLastCalledWith(presets[0].config, 'background', 60);
    await click('恢复使用当前配置');
    await click('开始测试');
    expect(startReproduction).toHaveBeenLastCalledWith(latest, 'background', 60);
    expect(initial.apiKey).toBe('current-key');
  });
  it('自定义以当前配置为起点，编辑后不被设置更新覆盖', async () => {
    await click('更换 API');
    const input = host.querySelector('input[aria-label="模型"]') as HTMLInputElement;
    expect(input.value).toBe('current-model');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'custom-model');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await render(latest);
    await click('开始测试');
    expect(startReproduction).toHaveBeenLastCalledWith({ ...initial, model: 'custom-model' }, 'background', 60);
  });
});

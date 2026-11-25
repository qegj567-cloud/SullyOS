// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CharacterApiPanel from '../components/character/CharacterApiPanel';
import { handleLocalBack } from '../utils/localBackHandlers';
import type { CharacterProfile, DialogueApiConfig } from '../types';

const os = vi.hoisted(() => ({
  apiConfig: { baseUrl: 'https://global.test/v1', apiKey: 'global', model: 'global-model' },
  apiPresets: [
    { id: 'a', name: '日常预设', group: '日常', config: { baseUrl: 'https://a.test/v1', apiKey: 'a', model: 'model-a' } },
    { id: 'b', name: '写作预设', group: '写作', config: { baseUrl: 'https://b.test/v1', apiKey: 'b', model: 'model-b' } },
  ],
  availableModels: ['global-model', 'another-model'],
  characters: [] as CharacterProfile[],
  memoryPalaceConfig: { lightLLM: { baseUrl: '', apiKey: '', model: '' } },
  addApiPreset: vi.fn(),
  updateApiPreset: vi.fn(),
  removeApiPreset: vi.fn(),
  addToast: vi.fn(),
}));
vi.mock('../context/OSContext', () => ({ useOS: () => os }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const onChange = vi.fn();
const char = { id: 'a', name: '角色 A' } as CharacterProfile;

const render = async (character = char) =>
  act(async () => {
    root.render(React.createElement(CharacterApiPanel, { character, onChange }));
  });

const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  expect(button, `button "${text}" should exist`).toBeTruthy();
  await act(async () => button!.click());
};

beforeEach(async () => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onChange.mockClear();
  os.addToast.mockClear();
  await render();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('CharacterApiPanel 所见即所得自动保存与预设 ID 引用', () => {
  it('点选分组预设立即按 presetId 引用保存，并支持一键恢复跟随设置', async () => {
    expect(host.textContent).toContain('目前跟随设置中的 API：global.test · global-model');
    await click('为角色使用独立 API');
    expect([...host.querySelectorAll('summary')].map((x) => x.textContent)).toEqual(['日常 · 1', '写作 · 1']);

    await click('写作预设');
    expect(onChange).toHaveBeenCalledTimes(1);
    const savedSlot = onChange.mock.calls[0][0] as DialogueApiConfig;
    expect(savedSlot.presetId).toBe('b');
    expect(savedSlot.presetFp).toBeTruthy();
    expect(savedSlot.baseUrl).toBe('https://b.test/v1');
    expect(savedSlot.model).toBe('model-b');

    const updatedChar = { ...char, dialogueApi: savedSlot };
    await render(updatedChar);
    expect(host.textContent).toContain('预设「写作预设」 · b.test · model-b');

    await click('跟随设置中的 API');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('从已绑定预设点「改为单独填写」脱离引用，切换 Anthropic 原生并测连及自动落盘', async () => {
    const network = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: 'message',
            id: 'm',
            model: 'model-a',
            content: [{ type: 'text', text: '你好' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', network);

    await click('为角色使用独立 API');
    await click('日常预设');
    const boundChar = { ...char, dialogueApi: onChange.mock.calls[0][0] };
    onChange.mockClear();
    await render(boundChar);

    await click('改为单独填写');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].presetId).toBeUndefined();

    const select = host.querySelector('select[aria-label="接口类型"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'anthropic';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: 'https://a.test/v1/messages', apiType: 'anthropic' }),
    );

    await click('测试连接');
    expect(host.textContent).toContain('连接成功');
    const [url, options] = network.mock.calls[0] as any;
    expect(url).toBe('https://a.test/v1/messages');
    expect(new Headers(options.headers).get('anthropic-dangerous-direct-browser-access')).toBe('true');
  });

  it('未填完整的单独填写草稿不会写入存储，关闭弹窗时自动丢弃并给出提示', async () => {
    await click('为角色使用独立 API');
    await click('单独填写配置');

    const urlInput = host.querySelector('[data-api-field="base-url"] input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(urlInput, 'https://half.example.com/v1');
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      urlInput.dispatchEvent(new Event('blur', { bubbles: true }));
    });

    // 缺少模型名，不应触发 onChange 落库
    expect(onChange).not.toHaveBeenCalled();

    // 按返回键优先关闭角色独立 API 弹窗，不穿透下层名片
    const consumed = await act(async () => handleLocalBack());
    expect(consumed).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(os.addToast).toHaveBeenCalledWith(expect.stringContaining('未填完'), 'info');
  });

  it('拉取模型中途切换到其他预设时，丢弃上一家服务商的晚到模型列表响应', async () => {
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolveFetch = done; })));

    await click('为角色使用独立 API');
    await click('复制主 API 参数微调');
    await click('刷新模型列表');
    await click('写作预设');
    await act(async () =>
      resolveFetch(new Response(JSON.stringify({ data: [{ id: 'stale-model' }] }), { status: 200 })),
    );
    expect(host.textContent).not.toContain('stale-model');
    expect(os.availableModels).toEqual(['global-model', 'another-model']);
  });
});

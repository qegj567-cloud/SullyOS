// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CharacterApiPanel from '../components/character/CharacterApiPanel';
import type { CharacterProfile } from '../types';

const os = vi.hoisted(() => ({
  apiConfig: { baseUrl: 'https://global.test/v1', apiKey: 'global', model: 'global-model' },
  apiPresets: [
    { id: 'a', name: '日常预设', group: '日常', config: { baseUrl: 'https://a.test/v1', apiKey: 'a', model: 'model-a' } },
    { id: 'b', name: '写作预设', group: '写作', config: { baseUrl: 'https://b.test/v1', apiKey: 'b', model: 'model-b' } },
  ],
  availableModels: ['global-model', 'another-model'],
}));
vi.mock('../context/OSContext', () => ({ useOS: () => os }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const onChange = vi.fn();
const char = { id: 'a', name: '角色 A' } as CharacterProfile;
const render = async (character = char) => act(async () => {
  root.render(React.createElement(CharacterApiPanel, { character, onChange }));
});
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};
beforeEach(async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  onChange.mockClear(); await render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('character API draft transaction', () => {
  it('native protocol draft tests and saves a Messages endpoint without changing global settings', async () => {
    const network=vi.fn(async()=>new Response(JSON.stringify({type:'message',id:'m',model:'global-model',content:[{type:'text',text:'你好'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:2}}),{headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',network);
    await click('为角色使用独立 API');
    const select=host.querySelector('select[aria-label="接口类型"]') as HTMLSelectElement;
    await act(async()=>{select.value='anthropic';select.dispatchEvent(new Event('change',{bubbles:true}));});
    await click('测试连接');
    expect(host.textContent).toContain('连接成功');
    const [url,options]=network.mock.calls[0] as any;
    expect(url).toBe('https://global.test/v1/messages');
    expect(new Headers(options.headers).get('anthropic-dangerous-direct-browser-access')).toBe('true');
    await click('确定');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({baseUrl:'https://global.test/v1/messages',apiType:'anthropic'}));
    expect(os.apiConfig.baseUrl).toBe('https://global.test/v1');
  });
  it('loads grouped presets as drafts; cancellation never mutates the role or global config', async () => {
    expect(host.textContent).toContain('目前跟随设置中的 API：global.test · global-model');
    await click('为角色使用独立 API');
    expect([...host.querySelectorAll('summary')].map(x => x.textContent)).toEqual(['日常 · 1', '写作 · 1']);
    await click('日常预设');
    expect(onChange).not.toHaveBeenCalled();
    await click('取消');
    expect(onChange).not.toHaveBeenCalled();
    expect(os.apiConfig.model).toBe('global-model');
    await click('为角色使用独立 API');
    expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('global');
  });
  it('confirms only the role snapshot and can return to following Settings', async () => {
    await click('为角色使用独立 API'); await click('写作预设'); await click('确定');
    expect(onChange).toHaveBeenCalledWith(os.apiPresets[1].config);
    const saved = { ...char, dialogueApi: onChange.mock.calls[0][0] };
    await render(saved);
    expect(host.textContent).toContain('目前使用的为：b.test · model-b');
    await click('跟随设置中的 API');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(os.apiConfig.model).toBe('global-model');
  });
  it('selecting a model only changes the draft until the outer confirmation', async () => {
    await click('为角色使用独立 API'); await click('global-model'); await click('another-model');
    expect(onChange).not.toHaveBeenCalled();
    await click('取消');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('discards a provider model-list response after the draft switches to another preset', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    await click('为角色使用独立 API'); await click('刷新模型列表'); await click('写作预设');
    await act(async () => resolve({ ok: true, json: async () => ({ data: [{ id: 'stale-model' }] }) } as Response));
    expect(host.textContent).not.toContain('stale-model');
    expect(host.textContent).toContain('model-b');
    expect(os.availableModels).toEqual(['global-model', 'another-model']);
  });
});

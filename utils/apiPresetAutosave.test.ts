// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApiPreset } from '../types';
import ApiPresetEditorModal from '../components/settings/ApiPresetEditorModal';
import { writeCachedModelsForEndpoint } from './apiSlots';
const os = vi.hoisted(() => ({ apiConfig: { baseUrl: 'https://demo.test/v1', apiKey: 'demo', model: 'one' }, apiPresets: [] as ApiPreset[], characters: [], addApiPreset: vi.fn(), updateApiPreset: vi.fn(), addToast: vi.fn() }));
vi.mock('../context/OSContext', () => ({ useOS: () => os }));
vi.mock('./apiSlotSync', () => ({ collectPresetUsageSummary: async () => ({ totalCount: 0, currentSpaceLabels: [], otherSpacesCount: 0 }) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(async () => {
 vi.useFakeTimers(); os.updateApiPreset.mockClear(); os.addApiPreset.mockClear(); os.apiPresets = []; localStorage.clear();
 writeCachedModelsForEndpoint(os.apiConfig, ['one', 'two']);
 host=document.createElement('div'); document.body.append(host);root=createRoot(host);
 await act(async()=>root.render(React.createElement(ApiPresetEditorModal,{isOpen:true,mode:'edit',preset:{id:'demo',name:'示例',config:os.apiConfig},onClose:()=>{}})));
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers();});
it('模型原地下拉选择后立即保存，成功反馈短暂显示',async()=>{
 const select=host.querySelector('select[aria-label="模型"]') as HTMLSelectElement;
 expect(select).not.toBeNull();
 await act(async()=>{select.value='two';select.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(os.updateApiPreset).toHaveBeenCalledWith('demo','示例',expect.objectContaining({model:'two'}),'');
 expect(host.textContent).toContain('修改成功！');
 expect(host.textContent).not.toContain('存为新预设');
 await act(async()=>vi.advanceTimersByTime(1500));
 expect(host.textContent).not.toContain('修改成功！');
});
it('无效草稿不保存，也不显示修改成功',async()=>{
 const input=host.querySelector('input[aria-label="预设名称"]') as HTMLInputElement;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>vi.advanceTimersByTime(650));
 expect(os.updateApiPreset).not.toHaveBeenCalled();expect(host.textContent).not.toContain('修改成功！');
});

it('新建时沿用预设只填新草稿，创建后保存新条目，不修改来源', async () => {
 const source = { id: 'source', name: '来源', group: '常用', config: { ...os.apiConfig, model: 'source-model', temperature: 0.4 } };
 os.apiPresets = [source];
 await act(async () => root.render(React.createElement(ApiPresetEditorModal, { isOpen: true, mode: 'create', onClose: () => {} })));
 await act(async () => (host.querySelector('.api-preset-trigger') as HTMLButtonElement).click());
 await act(async () => (host.querySelector('.api-preset-row button') as HTMLButtonElement).click());
 expect((host.querySelector('[aria-label="预设名称"]') as HTMLInputElement).value).toBe('来源 副本');
 expect((host.querySelector('[aria-label="模型"]') as HTMLSelectElement).value).toBe('source-model');
 expect(os.updateApiPreset).not.toHaveBeenCalled(); expect(os.addApiPreset).not.toHaveBeenCalled();
 await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent?.trim() === '创建并选用')!.click());
 expect(os.addApiPreset).toHaveBeenCalledWith('来源 副本', expect.objectContaining(source.config), '常用');
 expect(os.addApiPreset.mock.calls[0][1].presetId).toBeUndefined();
 expect(source.config.model).toBe('source-model');
});

it('内联识图测试沿用专用测试器，不改成聊天测试', async () => {
 const runner = vi.fn(async () => '识图连接成功');
 await act(async () => root.render(React.createElement(ApiPresetEditorModal, { inline: true, isOpen: true, mode: 'edit', preset: { id: 'demo', name: '示例', config: os.apiConfig }, testSlotName: '独立识图', customTestRunner: runner, onClose: () => {} })));
 await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent?.trim() === '测试连接')!.click());
 expect(runner).toHaveBeenCalledWith(expect.objectContaining(os.apiConfig));
 expect(host.querySelector('[data-api-test-tone="success"]')?.textContent).toContain('识图连接成功');
});
it('切换离开内联表单时提交合法草稿，清除延时任务', async () => {
 await act(async () => root.render(React.createElement(ApiPresetEditorModal, { inline: true, isOpen: true, mode: 'edit', preset: { id: 'demo', name: '示例', config: os.apiConfig }, onClose: () => {} })));
 const input = host.querySelector('[data-api-field="base-url"] input') as HTMLInputElement;
 await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'https://changed.test/v1'); input.dispatchEvent(new Event('input',{bubbles:true})); });
 await act(async () => root.render(null));
 expect(os.updateApiPreset).toHaveBeenCalledTimes(1);
 expect(os.updateApiPreset).toHaveBeenCalledWith('demo','示例',expect.objectContaining({baseUrl:'https://changed.test/v1'}),'');
 await act(async () => vi.advanceTimersByTime(650));
 expect(os.updateApiPreset).toHaveBeenCalledTimes(1);
});

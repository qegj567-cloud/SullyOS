// @vitest-environment jsdom
import React from 'react';
import {act} from 'react-dom/test-utils';
import {createRoot} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import Home3DSetupEntry from '../apps/room3d/Home3DSetupEntry';
import type {CharacterProfile} from '../types';
import catalog from '../public/room3d/catalog.json';
import {validateHome} from '../apps/room3d/model.js';
const mocks = vi.hoisted(() => ({generate: vi.fn(), load: vi.fn(), generating: vi.fn(() => false), user: {name: '用户', chibiStudio: {home3D: {state: {selected: {}}, hair: {layers: {}, extras: []}}}}}));
vi.mock('../context/OSContext', () => ({useOS: () => ({userProfile: mocks.user, apiConfig: {apiKey: 'test', baseUrl: 'https://test.invalid', model: 'test'}})}));
vi.mock('../components/character/HomeFigureStudio', () => ({default: () => null}));
vi.mock('../apps/room3d/Home3DView', () => ({default: () => React.createElement('p', {'data-testid': 'scene'}, '家园')}));
vi.mock('./dailySchedule', () => ({getDailyScheduleForChar: mocks.load}));
vi.mock('./scheduleGenerator', () => ({isScheduleFeatureOn: (char: CharacterProfile) => !!char.scheduleFeatureEnabled, generateDailyScheduleForChar: mocks.generate, isScheduleGeneratingFor: mocks.generating}));
vi.mock('./amsgStateSync', () => ({markAmsgStateDirty: vi.fn()}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div'); document.body.appendChild(host);
let root: ReturnType<typeof createRoot>;
afterEach(() => {act(() => root.unmount()); mocks.generate.mockReset(); mocks.load.mockReset(); mocks.generating.mockReset().mockReturnValue(false);vi.unstubAllGlobals();});
const character = {id: 'a', name: 'A', scheduleFeatureEnabled: true, homeDefinition: {kind: 'real', notes: ''},
    home3D: {version: 1, activeRoomId: 'r', rooms: [{id: 'r', name: '客厅', level: 0, items: []}]}, chibiStudio: {home3D: {state: {selected: {}}, hair: {layers: {}, extras: []}}}} as unknown as CharacterProfile;
const render = async (char = character) => {root = createRoot(host); await act(async () => {root.render(React.createElement(Home3DSetupEntry, {character: char, onChange: vi.fn(), onDefinitionChange: vi.fn(), onBack: vi.fn()}));});};
describe('first home entry', () => {
    it.each([['鼠尾草绿！','sage'],['淡紫色！','lilac'],['奶油粉！','blush'],['水蓝色！','aqua'],['黑白紫！','cyber']])('creates a complete home from %s on LAN HTTP',async(label,palette)=>{
        const native=globalThis.crypto;
        vi.stubGlobal('crypto',{getRandomValues:native.getRandomValues.bind(native)});
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>catalog}));
        const save=vi.fn();root=createRoot(host);
        await act(async()=>root.render(React.createElement(Home3DSetupEntry,{character:{...character,home3D:undefined,scheduleFeatureEnabled:false},onChange:save,onDefinitionChange:vi.fn(),onBack:vi.fn()})));
        await act(async()=>host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
        expect(host.querySelector('[role="alert"]')).toBeNull();expect(save).toHaveBeenCalledTimes(1);
        const home=save.mock.calls[0][0];expect(home.homePalette).toBe(palette);expect(home.rooms).toHaveLength(6);
        expect(validateHome(home,catalog)).toEqual(home);
        const ids=home.rooms.flatMap((room:any)=>[room.id,...room.items.map((item:any)=>item.id)]);
        expect(new Set(ids).size).toBe(ids.length);
    });
    it('enters homely without requiring a user avatar', async () => {
        const saved=mocks.user.chibiStudio;
        try {
            mocks.user.chibiStudio=undefined as any;
            root=createRoot(host);
            await act(async()=>root.render(React.createElement(Home3DSetupEntry,{presentation:'homely',character:{...character,scheduleFeatureEnabled:false},onChange:vi.fn(),onDefinitionChange:vi.fn(),onBack:vi.fn()})));
            expect(host.querySelector('[data-testid="scene"]')).not.toBeNull();
            expect(host.textContent).not.toContain('选择形象');
        } finally {mocks.user.chibiStudio=saved;}
    });
    it('reminds for legacy schedules without automatically calling the API and allows postponing', async () => {
        mocks.load.mockResolvedValue({slots: [{activity: '休息'}]});
        await render();
        expect(host.textContent).toContain('重新生成并补全位置');
        expect(mocks.generate).not.toHaveBeenCalled();
        const skip = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('稍后'))!;
        act(() => skip.click()); expect(host.querySelector('[data-testid="scene"]')).not.toBeNull();
    });
    it('does not prompt for a disabled schedule', async () => {
        await render({...character, scheduleFeatureEnabled: false});
        expect(mocks.load).not.toHaveBeenCalled();
        expect(host.querySelector('[data-testid="scene"]')).not.toBeNull();
    });
    it('keeps the reminder visible when regeneration fails', async () => {
        mocks.load.mockResolvedValue(null); mocks.generate.mockResolvedValue(null);
        await render();
        await act(async () => {host.querySelector<HTMLButtonElement>('.home-definition-submit')!.click();});
        expect(host.textContent).toContain('原日程已保留');
        expect(host.querySelector('[data-testid="scene"]')).toBeNull();
    });
    it('does not start a second generation while chat (or the cloud) is generating this character', async () => {
        mocks.load.mockResolvedValue(null); mocks.generating.mockReturnValue(true);
        await render();
        await act(async () => {host.querySelector<HTMLButtonElement>('.home-definition-submit')!.click();});
        expect(mocks.generate).not.toHaveBeenCalled();
        expect(host.textContent).toContain('正在生成');
    });
    it('requires a dedicated confirmed home figure instead of silently adopting the old chibi', async () => {
        mocks.load.mockResolvedValue(null);
        await render({...character, chibiStudio: {room: {state: {selected: {}}}}});
        expect(host.querySelector('[aria-label="A的形象 · 去捏人"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="scene"]')).toBeNull();
    });
});

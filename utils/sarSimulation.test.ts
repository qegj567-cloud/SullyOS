import { describe, expect, it } from 'vitest';
import { SAR_CLUB_STORAGE_KEY } from './vrWorld/sarClub';
import { SAR_GACHA_STORAGE_KEY } from './vrWorld/sarGacha';
import { collectSARLocalBackup, restoreSARLocalBackup } from './vrWorld/sarBackup';
import {
    SAR_SIMULATION_STORAGE_KEY,
    buildSARIdentityForgeRequest,
    buildSARIdentityRuntimePrompt,
    parseSARIdentityProfile,
    readSARSimulationState,
    resolveSARSimulationApi,
    startSARSimulationRun,
} from './vrWorld/sarSimulation';

const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
};

describe('SAR 推演与备份状态', () => {
    it('可解析围栏内的完整异格身份卡，并拒绝缺失钢印的结果', () => {
        const valid = parseSARIdentityProfile('```json\n' + JSON.stringify({
            title: '潮汐以北', logline: '一句概述', identity: '新的身份', lifePatch: '人生补丁',
            relationship: '关系状态', memoryStance: '记忆姿态', steelSeal: '不可违背的判断', patchCost: '补丁代价',
            behaviorShift: '行为偏移', openingScene: '开场场景', openingLine: '第一句', playerPrompt: '回应钩子',
        }) + '\n```');
        expect(valid?.title).toBe('潮汐以北');
        expect(valid?.steelSeal).toBe('不可违背的判断');
        expect(parseSARIdentityProfile('{"title":"只有标题"}')).toBeNull();
    });

    it('铸造提示把模块定义为人格补丁和演算场，并要求钢印、代价与非剧情化运行', () => {
        const text = buildSARIdentityForgeRequest(
            { name: 'Sully' },
            { id: 'variant-01', pool: 'variant', title: '未曾被你改变', group: '关系偏移', summary: '摘要', accent: 'blue', sigil: 'compass', memory: '导演层记忆' },
            { id: 'story-01', pool: 'story', title: '敌对阵营', group: '阵营与冲突', summary: '摘要', accent: 'red', sigil: 'chain', memory: '导演层记忆' },
        );
        expect(text).toContain('这不是剧情模式');
        expect(text).toContain('人格钢印');
        expect(text).toContain('每个补丁都必须携带代价');
        expect(text).toContain('不提前编写后续剧情节点或结局');
    });

    it('运行提示会把完整身份卡和钢印固定注入每一轮', () => {
        const text = buildSARIdentityRuntimePrompt({
            id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
            profile: { title: '异格', logline: '钩子', identity: '身份', lifePatch: '补丁', relationship: '关系', memoryStance: '记忆', steelSeal: '绝不承认需要任何人', patchCost: '代价', behaviorShift: '偏移', openingScene: '场景', openingLine: '台词', playerPrompt: '回应' },
        }, { id: 'run', cardId: 'card', createdAt: 1, updatedAt: 1, status: 'active', interactionsUsed: 7, maxInteractions: 50 });
        expect(text).toContain('人格钢印：绝不承认需要任何人');
        expect(text).toContain('当前进度 7/50');
        expect(text).toContain('禁止突然治愈');
    });

    it('旧版蓝图自动拆成永久身份卡和原推演实例', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 1, records: [{
            id: 'old-run', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 2,
            status: 'active', interactionsUsed: 3, maxInteractions: 50,
            blueprint: { title: '旧档', logline: '概述', characterState: '变化', worldTranslation: '世界', memoryPerformance: '记忆', openingScene: '场景', openingLine: '台词', playerPrompt: '回应' },
        }] }));
        const state = readSARSimulationState(storage);
        expect(state.version).toBe(2);
        expect(state.cards).toHaveLength(1);
        expect(state.cards[0].legacy).toBe(true);
        expect(state.runs[0]).toMatchObject({ id: 'old-run', interactionsUsed: 3, cardId: state.cards[0].id });
    });

    it('身份卡收藏与五十轮实例彼此独立，启动不会复制卡片', () => {
        const storage = memoryStorage();
        const profile = { title: '异格', logline: '钩子', identity: '身份', lifePatch: '补丁', relationship: '关系', memoryStance: '记忆', steelSeal: '钢印', patchCost: '代价', behaviorShift: '偏移', openingScene: '场景', openingLine: '台词', playerPrompt: '回应' };
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [{ id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1, profile }], runs: [] }));
        const first = startSARSimulationRun('card', storage);
        const second = startSARSimulationRun('card', storage);
        const state = readSARSimulationState(storage);
        expect(first.id).toBe(second.id);
        expect(state.cards).toHaveLength(1);
        expect(state.runs).toHaveLength(1);
        expect(state.runs[0]).toMatchObject({ interactionsUsed: 0, maxInteractions: 50 });
    });

    it('API 优先级为角色覆盖、彼方独立、聊天默认', () => {
        const api = (baseUrl: string) => ({ baseUrl, apiKey: '', model: 'test' });
        const char = { id: 'c', name: 'C', avatar: '' } as any;
        expect(resolveSARSimulationApi(char, api('vr'), api('chat')).baseUrl).toBe('vr');
        char.vrState = { enabled: true, intervalMinutes: 60, api: api('char') };
        expect(resolveSARSimulationApi(char, api('vr'), api('chat')).baseUrl).toBe('char');
        delete char.vrState.api;
        expect(resolveSARSimulationApi(char, null, api('chat')).baseUrl).toBe('chat');
    });

    it('新备份会携带 SAR 三类本地状态', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_CLUB_STORAGE_KEY, JSON.stringify({ version: 1, updateSeenVersion: 1, npcPreference: 'show', caianMet: true }));
        storage.setItem(SAR_GACHA_STORAGE_KEY, JSON.stringify({ version: 1, freeDrawDate: {}, collection: { 'variant-01': 1 }, history: [] }));
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [], runs: [] }));
        const backup = collectSARLocalBackup(storage);
        expect(backup.club).toBeTruthy();
        expect(backup.gacha).toBeTruthy();
        expect(backup.simulations).toEqual({ version: 2, cards: [], runs: [] });
    });

    it('导入不含 SAR 字段的旧主历史会清掉当前设备标记', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_CLUB_STORAGE_KEY, '{}');
        storage.setItem(SAR_GACHA_STORAGE_KEY, '{}');
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, '{}');
        restoreSARLocalBackup(undefined, { replaceMissing: true }, storage);
        expect(storage.getItem(SAR_CLUB_STORAGE_KEY)).toBeNull();
        expect(storage.getItem(SAR_GACHA_STORAGE_KEY)).toBeNull();
        expect(storage.getItem(SAR_SIMULATION_STORAGE_KEY)).toBeNull();
    });

    it('媒体补丁导入不会清理 SAR，显式备份则会覆盖', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_CLUB_STORAGE_KEY, JSON.stringify({ npcPreference: 'show' }));
        restoreSARLocalBackup(undefined, { replaceMissing: false }, storage);
        expect(storage.getItem(SAR_CLUB_STORAGE_KEY)).toContain('show');

        restoreSARLocalBackup({ version: 1, club: { version: 1, updateSeenVersion: 0, npcPreference: null, caianMet: false } }, { replaceMissing: true }, storage);
        expect(storage.getItem(SAR_CLUB_STORAGE_KEY)).toContain('"npcPreference":null');
        expect(readSARSimulationState(storage).cards).toHaveLength(0);
        expect(readSARSimulationState(storage).runs).toHaveLength(0);
    });
});

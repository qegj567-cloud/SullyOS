import { describe, expect, it } from 'vitest';
import { SAR_CLUB_STORAGE_KEY } from './vrWorld/sarClub';
import { SAR_GACHA_STORAGE_KEY } from './vrWorld/sarGacha';
import { SAR_MODULE_CATALOG, SAR_MODULE_SHOP_STORAGE_KEY } from './vrWorld/sarModuleShop';
import { collectSARLocalBackup, restoreSARLocalBackup } from './vrWorld/sarBackup';
import {
    SAR_SIMULATION_STORAGE_KEY,
    archiveSARSimulationRun,
    buildSARArchiveMarkdown,
    buildSARCharacterShareText,
    buildSARIdentityForgeRequest,
    buildSARLongTermContext,
    buildSARIdentityRuntimePrompt,
    buildSARSimulationTurnPrompt,
    completeSARSimulationTurn,
    getSARSimulationPhase,
    getSARArchiveFilename,
    getSARSimulationThreadId,
    parseSARIdentityProfile,
    parseSARSimulationReply,
    readSARSimulationState,
    resolveSARUserMaskProfile,
    resolveSARWorldlineProfile,
    resolveSARSimulationApi,
    startSARSimulationRun,
    saveSARIdentityCard,
    writeSARSimulationState,
} from './vrWorld/sarSimulation';

const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
};

const worldlineFields = {
    worldName: '沉星王都',
    worldPremise: '会吞噬谎言的魔法王都正在内战。',
    arrivalPoint: '两人已经闯过三道封锁，故事来到王宫失守前夜。',
    activeCrisis: '处刑钟敲响，追兵正在撞开藏身处的门。',
    sharedObjective: '在钟声结束前夺回王印并离开王城。',
    countdown: '第七次钟声后城门永久封闭。',
    hiddenTruth: '王印里封存着角色被改写的原始记忆。',
    climaxChoice: '救下城中居民，或保住角色仅剩的人格记录。',
    userMaskTitle: '失印执钥者',
    userIdentity: '用户是持有半枚王印的流亡执钥者，没有替任何人作决定的特权。',
    userLifePatch: '用户在这条世界线中从未拥有现实身份，只以王城流亡者的人生活到此刻。',
};

describe('SAR 推演与备份状态', () => {
    const quotaCard = (id: string) => ({
        id, charId: 'c', charName: 'C', charAvatar: 'data:image/png;base64,' + 'A'.repeat(50000),
        variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
        profile: { title: '异格', identity: '身份', steelSeal: '钢印', openingScene: '开场', openingLine: '台词' },
    } as any);

    it('压缩已有内联头像，连续保存第九张后仍能重读并进入故事', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [quotaCard('old')], runs: [] }));
        const limited = {
            getItem: storage.getItem,
            setItem: (key: string, value: string) => {
                if (value.length > 60000) throw new DOMException('Full', 'QuotaExceededError');
                storage.setItem(key, value);
            },
        };
        for (let i = 2; i <= 9; i++) saveSARIdentityCard(quotaCard(String(i)), limited);
        const state = readSARSimulationState(limited);
        expect(state.cards).toHaveLength(9);
        expect(state.cards.every(card => !card.charAvatar)).toBe(true);
        expect(state.cards.find(card => card.id === 'old')?.profile.title).toBe('异格');
        const run = startSARSimulationRun('9', limited);
        expect(readSARSimulationState(limited).runs[0].id).toBe(run.id);
    });

    it('存储失败会报错且不损坏旧卡或虚报启动成功', () => {
        const storage = memoryStorage();
        saveSARIdentityCard(quotaCard('old'), storage);
        const before = storage.getItem(SAR_SIMULATION_STORAGE_KEY);
        const full = { getItem: storage.getItem, setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } };
        expect(() => saveSARIdentityCard(quotaCard('new'), full)).toThrow('保存失败');
        expect(() => startSARSimulationRun('old', full)).toThrow('保存失败');
        expect(storage.getItem(SAR_SIMULATION_STORAGE_KEY)).toBe(before);
    });

    it('移除所有旧头像副本但不修改传入卡片，角色原始资源不受影响', () => {
        const card = quotaCard('inline');
        const remote = { ...quotaCard('remote'), charAvatar: 'https://example.com/avatar.png' };
        const blob = { ...quotaCard('blob'), charAvatar: 'blobref:avatar' };
        const state = writeSARSimulationState({ version: 2, cards: [card, remote, blob], runs: [] }, memoryStorage());
        expect(card.charAvatar).toMatch(/^data:/);
        expect(state.cards.every(item => !('charAvatar' in item))).toBe(true);
        expect(remote.charAvatar).toBe('https://example.com/avatar.png');
        expect(blob.charAvatar).toBe('blobref:avatar');
    });

    it('SAR 上下文只保留角色本体、User 基础资料和关系门牌', () => {
        const char = {
            id: 'c',
            name: 'C',
            avatar: '',
            systemPrompt: 'BASE_CHARACTER_MARKER',
            worldview: 'BASE_WORLD_MARKER',
            description: '',
            memoryPalaceEnabled: true,
            memoryPalaceInjection: 'PALACE_RECALL_MARKER',
            roomPlatesInjection: 'ROOM_PLATE_MARKER',
            refinedMemories: { '2026-08': 'LONG_TERM_MARKER' },
            activeMemoryMonths: [],
            memories: [],
            timeAwarenessEnabled: true,
            emotionConfig: { enabled: true },
            activeBuffs: [{ name: 'TEMP_MOOD_MARKER', intensity: 0.9 }],
            buffInjection: 'TEMP_BUFF_MARKER',
        } as any;
        const text = buildSARLongTermContext(
            char,
            { name: 'U', bio: 'USER_PROFILE_MARKER' } as any,
            'PALACE_RECALL_MARKER',
        );

        expect(text).toContain('BASE_CHARACTER_MARKER');
        expect(text).toContain('USER_PROFILE_MARKER');
        expect(text).toContain('ROOM_PLATE_MARKER');
        expect(text).not.toContain('BASE_WORLD_MARKER');
        expect(text).not.toContain('LONG_TERM_MARKER');
        expect(text).not.toContain('PALACE_RECALL_MARKER');
        expect(text).not.toContain('TEMP_MOOD_MARKER');
        expect(text).not.toContain('TEMP_BUFF_MARKER');
        expect(text).not.toContain('### 当前时间 (Now)');
        expect(text).not.toContain('[System: 实时状态 (Live Context)]');

        const runtimeText = buildSARLongTermContext(
            char,
            { name: 'U', bio: 'USER_PROFILE_MARKER' } as any,
            '',
            '',
            false,
        );
        expect(runtimeText).not.toContain('USER_PROFILE_MARKER');
        expect(runtimeText).toContain('现实 User 设定已被异界面具替代');
        expect(runtimeText).toContain('ROOM_PLATE_MARKER');
    });

    it('可解析围栏内的完整异格身份卡，并拒绝缺失钢印的结果', () => {
        const valid = parseSARIdentityProfile('```json\n' + JSON.stringify({
            title: '潮汐以北', logline: '一句概述', identity: '新的身份', lifePatch: '人生补丁',
            relationship: '关系状态', steelSeal: '不可违背的判断', patchCost: '补丁代价',
            behaviorShift: '行为偏移', ...worldlineFields, openingScene: '开场场景', openingLine: '第一句', playerPrompt: '回应钩子',
        }) + '\n```');
        expect(valid?.title).toBe('潮汐以北');
        expect(valid?.steelSeal).toBe('不可违背的判断');
        expect(valid?.activeCrisis).toContain('追兵');
        expect(valid?.userMaskTitle).toBe('失印执钥者');
        expect(parseSARIdentityProfile('{"title":"只有标题"}')).toBeNull();
    });

    it('铸造提示同时生成 Char 异格与 User 面具，并禁止调用现实事件记忆', () => {
        const text = buildSARIdentityForgeRequest(
            { name: 'Sully' },
            { id: 'variant-01', pool: 'variant', title: '未曾被你改变', group: '关系偏移', summary: '摘要', accent: 'blue', sigil: 'compass', memory: '导演层记忆' },
            { id: 'story-01', pool: 'story', title: '敌对阵营', group: '阵营与冲突', summary: '摘要', accent: 'red', sigil: 'chain', memory: '导演层记忆' },
        );
        expect(text).toContain('异世界异格扭蛋');
        expect(text).not.toContain('60%–75%');
        expect(text).toContain('用户是参与者');
        expect(text).not.toContain('逼出即时回应');
        expect(text).toContain('人格钢印');
        expect(text).toContain('每个补丁都必须携带代价');
        expect(text).toContain('activeCrisis');
        expect(text).toContain('hiddenTruth');
        expect(text).toContain('userMaskTitle');
        expect(text).toContain('完全替代 User 的现实 bio');
        expect(text).toContain('不提供任何可调用的事件记忆');
        expect(text).not.toContain('memoryFuse');
        expect(text).toContain('用户与角色身处同一现场');
    });

    it('运行提示会把完整身份卡和钢印固定注入每一轮', () => {
        const text = buildSARIdentityRuntimePrompt({
            id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
            profile: { title: '异格', logline: '钩子', identity: '身份', lifePatch: '补丁', relationship: '关系', memoryStance: '记忆', steelSeal: '绝不承认需要任何人', patchCost: '代价', behaviorShift: '偏移', ...worldlineFields, openingScene: '场景', openingLine: '台词', playerPrompt: '回应' },
        }, { id: 'run', cardId: 'card', createdAt: 1, updatedAt: 1, status: 'active', interactionsUsed: 7, maxInteractions: 50 });
        expect(text).toContain('人格钢印：绝不承认需要任何人');
        expect(text).toContain('当前进度 7/50');
        expect(text).toContain('禁止突然治愈');
        expect(text).toContain('已经说出的开场台词：台词');
        expect(text).toContain('当前危机：处刑钟敲响');
        expect(text).toContain('下一轮所处阶段：相处与变化');
        expect(text).toContain('面具名：失印执钥者');
        expect(text).toContain('现实层没有可调用的事件记忆');
        expect(text).toContain('第 50 轮通过既定返航机制');
        expect(text).not.toContain('连续两轮只有情绪确认');
        expect(text).toContain('安静不是失败');
        expect(text).not.toContain('真实告别记忆');
    });

    it('五十轮保留篇幅阶段，在最后六轮收束实际经历', () => {
        expect(getSARSimulationPhase(0).id).toBe('hot-drop');
        expect(getSARSimulationPhase(3).id).toBe('cascade');
        expect(getSARSimulationPhase(12).id).toBe('reversal');
        expect(getSARSimulationPhase(24).id).toBe('climax');
        expect(getSARSimulationPhase(38).id).toBe('cost');
        expect(getSARSimulationPhase(44).id).toBe('return');
        expect(getSARSimulationPhase(47).id).toBe('ending');
        expect(getSARSimulationPhase(49).id).toBe('arrival');
        expect(getSARSimulationPhase(49).directive).toContain('回到现实');
    });

    it('旧身份卡无需重抽，自然接续原世界模块与既有事实', () => {
        const card = {
            id: 'old-card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
            profile: { title: '旧异格', logline: '钩子', identity: '身份', lifePatch: '补丁', relationship: '关系', memoryStance: '记忆', steelSeal: '钢印', patchCost: '代价', behaviorShift: '偏移', openingScene: '旧场景', openingLine: '旧台词', playerPrompt: '快走' },
        } as any;
        const worldline = resolveSARWorldlineProfile(card);
        expect(worldline.retrofitted).toBe(true);
        expect(worldline.worldName).toBe('王城处刑夜');
        expect(worldline.activeCrisis).toContain('不要求你先理解背景');
        expect(resolveSARUserMaskProfile(card)).toMatchObject({ title: '无名越界者', retrofitted: true });
        expect(buildSARIdentityRuntimePrompt(card)).toContain('旧版卡的补铸世界线');
    });

    it('正式推演统一为现场行动，保留旧剧情连续性与用户自主权', () => {
        const card = {
            id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
            profile: { title: '异格', logline: '钩子', identity: '身份', lifePatch: '补丁', relationship: '关系', memoryStance: '记忆', steelSeal: '钢印', patchCost: '代价', behaviorShift: '偏移', openingScene: '场景', openingLine: '台词', playerPrompt: '回应' },
        } as any;
        const run = { id: 'run', cardId: 'card', createdAt: 1, updatedAt: 1, status: 'active', interactionsUsed: 3, maxInteractions: 50 } as any;
        const prompt = buildSARSimulationTurnPrompt(card, run);
        expect(prompt).toContain('现场演出｜线下剧情');
        expect(prompt).toContain('用户输入代表此刻在故事现场说的话');
        expect(prompt).toContain('环境变化、动作、停顿');
        expect(prompt).toContain('同一条连续世界线');
        expect(prompt).toContain('历史记录若包含远程通讯');
        expect(prompt).toContain('不凭空传送');
        expect(prompt).toContain('不替用户行动');
        expect(prompt).toContain('世界意志｜旁白与航向');
        expect(prompt).toContain('让玩家不必自己承担剧本规划');
        expect(prompt).toContain('<SAR_SCENE>');
        expect(prompt).toContain('<worldNarration>');
        expect(prompt).not.toContain('保持文字联系');
        expect(prompt).not.toContain('切换方式');
    });

    it('正式推演把世界意志旁白和角色演出分开解析，并兼容旧字段与纯文本回应', () => {
        expect(parseSARSimulationReply('```json\n{"worldNarration":"城门开始坍塌。","character":"跟紧我。"}\n```')).toEqual({
            worldNarration: '城门开始坍塌。',
            character: '跟紧我。',
        });
        expect(parseSARSimulationReply('{"gm":"旧旁白。","character":"旧角色。"}')).toEqual({ worldNarration: '旧旁白。', character: '旧角色。' });
        expect(parseSARSimulationReply('旧版角色直接回应。')).toEqual({ worldNarration: '', character: '旧版角色直接回应。' });
    });

    it('封存档案可下载完整世界旁白/角色记录，并生成克制的角色分享简报', () => {
        const card = {
            id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1,
            profile: { title: '异格', logline: '钩子', identity: '身份', lifePatch: '补丁', relationship: '关系', steelSeal: '钢印', patchCost: '代价', behaviorShift: '偏移', ...worldlineFields, openingScene: '开场风暴', openingLine: '抓住我。', playerPrompt: '伸手' },
        } as any;
        const run = { id: 'run-archive', cardId: 'card', createdAt: 1, updatedAt: 2, archivedAt: 2, status: 'archived', archiveReason: 'completed', interactionsUsed: 50, maxInteractions: 50 } as any;
        const messages = [
            { id: 1, role: 'user', type: 'text', content: '我抓住了。', metadata: { sarMode: 'offline', sarTurn: 50 } },
            { id: 2, role: 'assistant', type: 'text', content: '现实见。', metadata: { sarMode: 'offline', sarTurn: 50, sarWorldNarration: '返航门在身后闭合。' } },
        ] as any;
        const markdown = buildSARArchiveMarkdown(card, run, messages, 'U');
        const share = buildSARCharacterShareText(card, run, messages, 'U');
        expect(markdown).toContain('# SAR 异界坐标封存档案');
        expect(markdown).toContain('返航门在身后闭合。');
        expect(markdown).toContain('世界意志');
        expect(markdown).not.toContain('SAR 航标 / GM');
        expect(markdown).toContain('现实见。');
        expect(markdown).toContain('完整推演记录');
        expect(share).toContain('我从一条封存的异界坐标回来');
        expect(share).toContain('不是你在现实中原本拥有的记忆');
        expect(getSARArchiveFilename(card, run)).toBe('异格-C-50of50.md');
    });

    it('只有完成回应才推进一轮，50/50 自动完成并封存', () => {
        const storage = memoryStorage();
        const profile = { title: '异格', logline: '钩子', identity: '身份', lifePatch: '补丁', relationship: '关系', memoryStance: '记忆', steelSeal: '钢印', patchCost: '代价', behaviorShift: '偏移', openingScene: '场景', openingLine: '台词', playerPrompt: '回应' };
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [{ id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1, profile }], runs: [{ id: 'run', cardId: 'card', createdAt: 1, updatedAt: 1, status: 'active', interactionsUsed: 48, maxInteractions: 50 }] }));
        const fortyNine = completeSARSimulationTurn('run', 48, storage);
        expect(fortyNine).toMatchObject({ interactionsUsed: 49, status: 'active' });
        expect(() => completeSARSimulationTurn('run', 48, storage)).toThrow('推演进度已变化');
        const fifty = completeSARSimulationTurn('run', 49, storage);
        expect(fifty).toMatchObject({ interactionsUsed: 50, status: 'archived', archiveReason: 'completed' });
        expect(fifty.archivedAt).toBeTypeOf('number');
    });

    it('紧急封存保留当前进度且实例线程与原角色私聊隔离', () => {
        const storage = memoryStorage();
        const profile = { title: '异格', logline: '钩子', identity: '身份', lifePatch: '补丁', relationship: '关系', memoryStance: '记忆', steelSeal: '钢印', patchCost: '代价', behaviorShift: '偏移', openingScene: '场景', openingLine: '台词', playerPrompt: '回应' };
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [{ id: 'card', charId: 'c', charName: 'C', variantId: 'variant-01', storyId: 'story-01', createdAt: 1, updatedAt: 1, profile }], runs: [{ id: 'run', cardId: 'card', createdAt: 1, updatedAt: 1, status: 'active', interactionsUsed: 17, maxInteractions: 50 }] }));
        const archived = archiveSARSimulationRun('run', storage);
        expect(archived).toMatchObject({ interactionsUsed: 17, status: 'archived', archiveReason: 'emergency' });
        expect(getSARSimulationThreadId('run')).toBe('sar-simulation:run');
        expect(getSARSimulationThreadId('run')).not.toBe('c');
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

    it('API 优先级为彼方独立、角色默认、全局；不再使用不可见的旧覆盖', () => {
        const api = (baseUrl: string) => ({ baseUrl, apiKey: '', model: 'test' });
        const char = { id: 'c', name: 'C', avatar: '' } as any;
        expect(resolveSARSimulationApi(char, api('vr'), api('chat')).baseUrl).toBe('vr');
        char.vrState = { enabled: true, intervalMinutes: 60, api: api('char') };
        char.dialogueApi = api('role');
        expect(resolveSARSimulationApi(char, api('vr'), api('chat')).baseUrl).toBe('vr');
        expect(resolveSARSimulationApi(char, null, api('chat')).baseUrl).toBe('role');
        delete char.dialogueApi;
        expect(resolveSARSimulationApi(char, null, api('chat')).baseUrl).toBe('chat');
    });

    it('新备份会携带 SAR 四类本地状态', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_CLUB_STORAGE_KEY, JSON.stringify({ version: 1, updateSeenVersion: 1, npcPreference: 'show', caianMet: true }));
        storage.setItem(SAR_GACHA_STORAGE_KEY, JSON.stringify({ version: 1, freeDrawDate: {}, collection: { 'variant-01': 1 }, history: [] }));
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ version: 2, cards: [], runs: [] }));
        storage.setItem(SAR_MODULE_SHOP_STORAGE_KEY, JSON.stringify({
            version: 1,
            credits: 0,
            inventory: {},
            purchases: [],
            market: { dayKey: '2026-09-06', offerIds: [], rollsRemaining: 3 },
        }));
        const backup = collectSARLocalBackup(storage);
        expect(backup.club).toBeTruthy();
        expect(backup.gacha).toBeTruthy();
        expect(backup.simulations).toEqual({ version: 2, cards: [], runs: [] });
        expect(backup.moduleShop).toBeTruthy();
    });

    it('导入不含 SAR 字段的旧主历史会清掉当前设备标记', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_CLUB_STORAGE_KEY, '{}');
        storage.setItem(SAR_GACHA_STORAGE_KEY, '{}');
        storage.setItem(SAR_SIMULATION_STORAGE_KEY, '{}');
        storage.setItem(SAR_MODULE_SHOP_STORAGE_KEY, '{}');
        restoreSARLocalBackup(undefined, { replaceMissing: true }, storage);
        expect(storage.getItem(SAR_CLUB_STORAGE_KEY)).toBeNull();
        expect(storage.getItem(SAR_GACHA_STORAGE_KEY)).toBeNull();
        expect(storage.getItem(SAR_SIMULATION_STORAGE_KEY)).toBeNull();
        expect(storage.getItem(SAR_MODULE_SHOP_STORAGE_KEY)).toBeNull();
    });

    it('媒体补丁导入不会清理 SAR，显式备份则会覆盖', () => {
        const storage = memoryStorage();
        storage.setItem(SAR_CLUB_STORAGE_KEY, JSON.stringify({ npcPreference: 'show' }));
        restoreSARLocalBackup(undefined, { replaceMissing: false }, storage);
        expect(storage.getItem(SAR_CLUB_STORAGE_KEY)).toContain('show');

        restoreSARLocalBackup({ version: 1, club: { version: 1, updateSeenVersion: 0, npcPreference: null, caianMet: false } }, { replaceMissing: true }, storage);
        expect(storage.getItem(SAR_CLUB_STORAGE_KEY)).toContain('"npcPreference":null');
        expect(storage.getItem(SAR_MODULE_SHOP_STORAGE_KEY)).toBeNull();
        expect(readSARSimulationState(storage).cards).toHaveLength(0);
        expect(readSARSimulationState(storage).runs).toHaveLength(0);
    });

    it('模块商店库存会随 SAR 备份恢复', () => {
        const storage = memoryStorage();
        const moduleId = SAR_MODULE_CATALOG[0].id;
        restoreSARLocalBackup({
            version: 1,
            moduleShop: {
                version: 1,
                credits: 0,
                inventory: { [moduleId]: 2 },
                purchases: [],
                market: { dayKey: '2026-09-06', offerIds: SAR_MODULE_CATALOG.slice(0, 5).map(item => item.id), rollsRemaining: 2 },
            },
        }, { replaceMissing: true }, storage);

        expect(storage.getItem(SAR_MODULE_SHOP_STORAGE_KEY)).toContain(`"${moduleId}":2`);
    });
});

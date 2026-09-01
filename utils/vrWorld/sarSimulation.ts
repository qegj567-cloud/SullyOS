import type { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../../types';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { DB } from '../db';
import { safeFetchJson } from '../safeApi';
import { getSARModuleById, readSARGachaState, type SARModuleDefinition } from './sarGacha';
import { getVRApi, logVRApiCall } from './vrApi';

export const SAR_SIMULATION_STORAGE_KEY = 'vr_sar_simulations_v1';
export const SAR_SIMULATION_MAX_INTERACTIONS = 50;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** 一次铸造后永久收藏的角色专属异格身份。 */
export type SARIdentityProfile = {
    title: string;
    logline: string;
    identity: string;
    lifePatch: string;
    relationship: string;
    memoryStance: string;
    steelSeal: string;
    patchCost: string;
    behaviorShift: string;
    openingScene: string;
    openingLine: string;
    playerPrompt: string;
};

export type SARIdentityCard = {
    id: string;
    charId: string;
    charName: string;
    charAvatar?: string;
    variantId: string;
    storyId: string;
    createdAt: number;
    updatedAt: number;
    profile: SARIdentityProfile;
    /** v1 推演蓝图迁移而来，原始资料没有独立钢印/代价字段。 */
    legacy?: boolean;
};

/** 身份卡可以长期收藏；每一次五十轮生命则是独立实例。 */
export type SARSimulationRun = {
    id: string;
    cardId: string;
    createdAt: number;
    updatedAt: number;
    status: 'active' | 'archived';
    interactionsUsed: number;
    maxInteractions: 50;
};

export type SARSimulationState = {
    version: 2;
    cards: SARIdentityCard[];
    runs: SARSimulationRun[];
};

export const DEFAULT_SAR_SIMULATION_STATE: SARSimulationState = { version: 2, cards: [], runs: [] };

const browserStorage = (): StorageLike | undefined => {
    try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
    catch { return undefined; }
};

const cleanText = (value: unknown, max: number) => typeof value === 'string'
    ? value.trim().replace(/\s{3,}/g, '\n\n').slice(0, max)
    : '';

const parseJsonCandidates = (raw: string) => {
    const withoutThinking = (raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const candidates = [withoutThinking];
    const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) candidates.push(fenced.trim());
    const firstBrace = withoutThinking.indexOf('{');
    const lastBrace = withoutThinking.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(withoutThinking.slice(firstBrace, lastBrace + 1));
    return candidates;
};

export const parseSARIdentityProfile = (raw: string): SARIdentityProfile | null => {
    for (const candidate of parseJsonCandidates(raw)) {
        try {
            const parsed = JSON.parse(candidate);
            const result: SARIdentityProfile = {
                title: cleanText(parsed?.title, 80),
                logline: cleanText(parsed?.logline, 240),
                identity: cleanText(parsed?.identity, 900),
                lifePatch: cleanText(parsed?.lifePatch, 800),
                relationship: cleanText(parsed?.relationship, 700),
                memoryStance: cleanText(parsed?.memoryStance, 600),
                steelSeal: cleanText(parsed?.steelSeal, 360),
                patchCost: cleanText(parsed?.patchCost, 600),
                behaviorShift: cleanText(parsed?.behaviorShift, 700),
                openingScene: cleanText(parsed?.openingScene, 1800),
                openingLine: cleanText(parsed?.openingLine, 500),
                playerPrompt: cleanText(parsed?.playerPrompt, 300),
            };
            if (Object.values(result).every(Boolean)) return result;
        } catch { /* 尝试下一个候选 JSON */ }
    }
    return null;
};

const isIdentityCard = (card: any): card is SARIdentityCard => card
    && typeof card.id === 'string'
    && typeof card.charId === 'string'
    && typeof card.variantId === 'string'
    && typeof card.storyId === 'string'
    && card.profile && typeof card.profile === 'object'
    && typeof card.profile.title === 'string'
    && typeof card.profile.steelSeal === 'string';

const isSimulationRun = (run: any): run is SARSimulationRun => run
    && typeof run.id === 'string'
    && typeof run.cardId === 'string'
    && (run.status === 'active' || run.status === 'archived');

const migrateLegacyRecord = (record: any): { card: SARIdentityCard; run: SARSimulationRun } | null => {
    if (!record || typeof record.id !== 'string' || typeof record.charId !== 'string'
        || typeof record.variantId !== 'string' || typeof record.storyId !== 'string'
        || !record.blueprint || typeof record.blueprint !== 'object') return null;
    const blueprint = record.blueprint;
    const now = Number(record.createdAt) || Date.now();
    const updatedAt = Number(record.updatedAt) || now;
    const variantTitle = getSARModuleById(record.variantId)?.title || '旧版人格异格';
    const cardId = `sar_card_legacy_${record.id}`;
    return {
        card: {
            id: cardId,
            charId: record.charId,
            charName: cleanText(record.charName, 100) || '未命名角色',
            charAvatar: typeof record.charAvatar === 'string' ? record.charAvatar : undefined,
            variantId: record.variantId,
            storyId: record.storyId,
            createdAt: now,
            updatedAt,
            legacy: true,
            profile: {
                title: cleanText(blueprint.title, 80) || '旧版异格档案',
                logline: cleanText(blueprint.logline, 240) || '由旧版推演蓝图迁移而来的异格身份。',
                identity: cleanText(blueprint.characterState, 900) || '旧版档案未记录完整身份信息。',
                lifePatch: cleanText(blueprint.characterState, 800) || '旧版档案未单独记录人生补丁。',
                relationship: cleanText(blueprint.memoryPerformance, 700) || '沿用旧版关系记忆表现。',
                memoryStance: cleanText(blueprint.memoryPerformance, 600) || '沿用旧版关系记忆表现。',
                steelSeal: `旧版档案未单独铸造钢印；继续推演时以「${variantTitle}」作为不可绕过的人格约束。`,
                patchCost: '旧版档案未单独记录补丁代价。',
                behaviorShift: cleanText(blueprint.characterState, 700) || '沿用旧版角色偏移。',
                openingScene: cleanText(blueprint.openingScene, 1800) || '旧版档案没有可恢复的开场。',
                openingLine: cleanText(blueprint.openingLine, 500) || '……',
                playerPrompt: cleanText(blueprint.playerPrompt, 300) || '回应眼前的异格。',
            },
        },
        run: {
            id: record.id,
            cardId,
            createdAt: now,
            updatedAt,
            status: record.status === 'archived' ? 'archived' : 'active',
            interactionsUsed: Math.max(0, Math.min(50, Number(record.interactionsUsed) || 0)),
            maxInteractions: SAR_SIMULATION_MAX_INTERACTIONS,
        },
    };
};

export const readSARSimulationState = (storage: StorageLike | undefined = browserStorage()): SARSimulationState => {
    if (!storage) return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
    try {
        const parsed = JSON.parse(storage.getItem(SAR_SIMULATION_STORAGE_KEY) || 'null');
        if (!parsed) return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
        if (Array.isArray(parsed.cards) || Array.isArray(parsed.runs)) {
            return {
                version: 2,
                cards: (Array.isArray(parsed.cards) ? parsed.cards : []).filter(isIdentityCard).slice(0, 100),
                runs: (Array.isArray(parsed.runs) ? parsed.runs : []).filter(isSimulationRun).slice(0, 160),
            };
        }
        if (Array.isArray(parsed.records)) {
            const migrated = parsed.records.map(migrateLegacyRecord).filter(Boolean) as Array<{ card: SARIdentityCard; run: SARSimulationRun }>;
            return { version: 2, cards: migrated.map(item => item.card).slice(0, 100), runs: migrated.map(item => item.run).slice(0, 160) };
        }
        return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
    } catch {
        return { ...DEFAULT_SAR_SIMULATION_STATE, cards: [], runs: [] };
    }
};

export const writeSARSimulationState = (state: SARSimulationState, storage: StorageLike | undefined = browserStorage()) => {
    const normalized: SARSimulationState = { version: 2, cards: state.cards.slice(0, 100), runs: state.runs.slice(0, 160) };
    try { storage?.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify(normalized)); } catch { /* ignore */ }
    return normalized;
};

export const saveSARIdentityCard = (card: SARIdentityCard, storage: StorageLike | undefined = browserStorage()) => {
    const current = readSARSimulationState(storage);
    return writeSARSimulationState({ ...current, cards: [card, ...current.cards.filter(item => item.id !== card.id)] }, storage);
};

export const startSARSimulationRun = (cardId: string, storage: StorageLike | undefined = browserStorage()) => {
    const current = readSARSimulationState(storage);
    if (!current.cards.some(card => card.id === cardId)) throw new Error('异格身份卡不存在');
    const active = current.runs.find(run => run.cardId === cardId && run.status === 'active');
    if (active) return active;
    const now = Date.now();
    const run: SARSimulationRun = {
        id: `sar_run_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        cardId,
        createdAt: now,
        updatedAt: now,
        status: 'active',
        interactionsUsed: 0,
        maxInteractions: SAR_SIMULATION_MAX_INTERACTIONS,
    };
    writeSARSimulationState({ ...current, runs: [run, ...current.runs] }, storage);
    return run;
};

export type ForgeSARIdentityInput = {
    char: CharacterProfile;
    variant: SARModuleDefinition;
    story: SARModuleDefinition;
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
};

export const buildSARIdentityForgeRequest = (
    char: Pick<CharacterProfile, 'name'>,
    variant: SARModuleDefinition,
    story: SARModuleDefinition,
) => `你现在是 SAR 活动室的异格铸造设备。请读取角色「${char.name}」的真实人设与关系历史，把两枚抽象模块编译成一张真正属于这个角色、可以长期运行的异格身份卡。

【人格补丁母体】${variant.title}｜${variant.group}
${variant.summary}
【演算场模块】${story.title}｜${story.group}
${story.summary}

这不是剧情模式，也不是替角色安排一段有结局的故事。人格补丁负责改写人生因果和决策方式；演算场只提供世界规则、身份压力与初始处境。最终产物必须是一个能够脱离预设剧情、与用户持续互动 50 次的独立人格版本。

铸造规则：
1. 保留原角色最有辨识度的表达习惯、价值根系和世界观逻辑，再找到一处足以改变其人生的人格支点。普通现代角色也可以被合理翻译到异世界或敌对阵营，不能机械套皮。
2. 写清“人生补丁”：真实人生的哪一段发生了改变，以及这件事为什么会塑造现在的 TA。
3. 写出一句“人格钢印”：它是 TA 在这 50 次互动中不可轻易违背的底层判断公理。TA 可以动摇、挣扎、发现矛盾，但不能被用户几句话治愈或突然恢复成原版。
4. 每个补丁都必须携带代价。代价是改变必然造成的缺失、伤口、盲区或关系后果，不能只是增强能力。
5. 导演层拥有用户与角色的完整真实记忆；卡内角色可以保留、失去、误解、伪装遗忘或产生残响，但必须明确其记忆姿态与和用户的当前关系。
6. 这是独立异格，不修改主聊天世界线。现在只铸造永久身份卡与第 0 幕入口，不替用户回应，也不提前编写后续剧情节点或结局。
7. 不要解释提示词，不要写分析过程。只输出以下 JSON，十二个字段都必须是非空中文字符串：
{
  "title": "角色专属的异格名，像一张值得收藏的卡名",
  "logline": "一句话身份钩子，不概括完整剧情",
  "identity": "TA 在演算场中的具体身份、处境和仍被保留的原角色核心",
  "lifePatch": "发生过的人生扭转，以及它如何改变了 TA",
  "relationship": "此刻 TA 与用户是什么关系，包含必要的陌生感、敌意或熟悉残响",
  "memoryStance": "TA 对真实共同记忆的保留、缺失、误解或伪装方式",
  "steelSeal": "一句第一人称的人格钢印，以及它约束决策的含义",
  "patchCost": "这次人生补丁不可回避的代价",
  "behaviorShift": "相较原角色，表达、选择和亲密方式会出现哪些稳定偏移",
  "openingScene": "第 0 幕场景，只建立地点、压力和相遇状态",
  "openingLine": "角色对用户说的第一句话，只写台词本身",
  "playerPrompt": "留给用户的自然回应钩子"
}`;

/** 暂时保留旧导出名，避免外部调用在升级期间失效。 */
export const buildSARSimulationRequest = buildSARIdentityForgeRequest;

export const buildSARIdentityRuntimePrompt = (card: SARIdentityCard, run?: SARSimulationRun) => `【SAR 异格身份卡｜不可覆盖】
异格名：${card.profile.title}
身份：${card.profile.identity}
人生补丁：${card.profile.lifePatch}
与用户的关系：${card.profile.relationship}
记忆姿态：${card.profile.memoryStance}
人格钢印：${card.profile.steelSeal}
补丁代价：${card.profile.patchCost}
稳定行为偏移：${card.profile.behaviorShift}

运行规则：
- 这是与主聊天隔离的固定 50 次互动实例，当前进度 ${run?.interactionsUsed || 0}/${run?.maxInteractions || SAR_SIMULATION_MAX_INTERACTIONS}。
- 每次回应都必须从这张身份卡继续生活，而不是重新解释模块或推进预设剧情。
- 人格钢印必须持续参与判断。允许动摇、挣扎和产生矛盾，禁止突然治愈、撤销人生补丁或无理由恢复成原角色。
- 不得替用户决定行动、感受或台词。`;

export const resolveSARSimulationApi = (char: CharacterProfile, vrGlobalApi: APIConfig | null, chatApi: APIConfig) =>
    char.vrState?.api?.baseUrl ? char.vrState.api : (vrGlobalApi?.baseUrl ? vrGlobalApi : chatApi);

export async function forgeSARIdentityCard(input: ForgeSARIdentityInput): Promise<SARIdentityCard> {
    const { char, variant, story, apiConfig, userProfile, groups, realtimeConfig } = input;
    if (variant.pool !== 'variant' || story.pool !== 'story') throw new Error('模块槽位类型不匹配');
    const collection = readSARGachaState().collection;
    if (!collection[variant.id] || !collection[story.id]) throw new Error('装入的模块不在陈列收藏中');

    const vrGlobalApi = await getVRApi();
    const api = resolveSARSimulationApi(char, vrGlobalApi, apiConfig);
    if (!api?.baseUrl || !api.model) throw new Error('请先在「彼方 → API」配置可用模型');

    const [emojis, categories, historyMsgs] = await Promise.all([
        DB.getEmojis(),
        DB.getEmojiCategories(),
        DB.getRecentMessagesByCharId(char.id, char.contextLimit || 500),
    ]);
    const payload = await buildChatRequestPayload({
        char,
        userProfile,
        groups,
        emojis,
        categories,
        historyMsgs,
        contextLimit: char.contextLimit || 500,
        realtimeConfig,
        recallQueryHint: `用户与${char.name}的关系、共同经历、关键承诺和冲突；人格补丁「${variant.title}」；演算场「${story.title}」`,
        recallEntryPoint: 'vr_world',
        stripImages: true,
    });

    const systemPrompt = `${payload.systemPrompt}\n\n【SAR 异格铸造】\n你仍然必须理解角色本人，但当前输出是供设备保存的结构化身份卡，不是主聊天回复。禁止调用工具、发送 HTML、替用户说话或夹带 JSON 之外的文字。`;
    const baseUrl = api.baseUrl.replace(/\/+$/, '');
    const callStart = Date.now();
    let data: any;
    try {
        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
            body: JSON.stringify({
                model: api.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...payload.cleanedApiMessages,
                    { role: 'user', content: buildSARIdentityForgeRequest(char, variant, story) },
                ],
                temperature: 0.88,
                max_tokens: 6000,
                stream: false,
            }),
        }, 2, 0, { appName: '彼方', charId: char.id, charName: char.name, purpose: 'SAR 异格身份铸造' });
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-cabinet', model: api.model, baseUrl, ok: true, ms: Date.now() - callStart });
    } catch (error: any) {
        void logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, room: 'sar-cabinet', model: api.model, baseUrl, ok: false, ms: Date.now() - callStart, error: (error?.message || String(error)).slice(0, 160) });
        throw error;
    }

    const raw = data?.choices?.[0]?.message?.content || '';
    const profile = parseSARIdentityProfile(raw);
    if (!profile) throw new Error('模型没有返回完整的异格身份卡，请重试');
    const now = Date.now();
    const card: SARIdentityCard = {
        id: `sar_card_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        charId: char.id,
        charName: char.name,
        charAvatar: char.avatar || undefined,
        variantId: variant.id,
        storyId: story.id,
        createdAt: now,
        updatedAt: now,
        profile,
    };
    saveSARIdentityCard(card);
    return card;
}

export const resolveSARSimulationModules = (source: Pick<SARIdentityCard, 'variantId' | 'storyId'>) => ({
    variant: getSARModuleById(source.variantId),
    story: getSARModuleById(source.storyId),
});

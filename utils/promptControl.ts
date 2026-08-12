import type { CoreContextPromptControls } from './context';

export type PromptControlModuleKey =
    | 'coreIdentity'
    | 'worldview'
    | 'userProfile'
    | 'privateImpression'
    | 'nativeMemorySummary'
    | 'nativeActiveMemory'
    | 'fixedBehaviorRules'
    | 'voiceMessages'
    | 'memoryPalace'
    | 'worldbook'
    | 'timeAwareness'
    | 'realtimeState'
    | 'musicState'
    | 'bilingualMode'
    | 'htmlMode'
    | 'thinkingChain'
    | 'miniAppContext'
    | 'mcpTools'
    | 'recencyTail'
    | 'chatHistory';

export interface PromptControlModuleMeta {
    key: PromptControlModuleKey;
    label: string;
    detail: string;
}

export interface PromptControlConfig {
    modules: Record<PromptControlModuleKey, boolean>;
}

export interface PromptControlModuleSnapshot extends PromptControlModuleMeta {
    enabled: boolean;
    included: boolean;
    note?: string;
}

export interface PromptControlSnapshot {
    modules: PromptControlModuleSnapshot[];
    disabledKeys: PromptControlModuleKey[];
}

export const PROMPT_CONTROL_STORAGE_KEY = 'sullyos.promptControl.v1';
const PROMPT_CONTROL_EVENT = 'sullyos:prompt-control-change';

export const PROMPT_CONTROL_MODULES: PromptControlModuleMeta[] = [
    { key: 'coreIdentity', label: '核心身份', detail: '角色名字、用户备注和核心 system prompt。' },
    { key: 'worldview', label: '世界观', detail: '角色 worldview 字段，不等同于世界书。' },
    { key: 'userProfile', label: '用户画像', detail: '用户名字、个人简介和设定备注。' },
    { key: 'privateImpression', label: '私密印象', detail: '角色眼中的用户、偏好、雷区和互动方式。' },
    { key: 'nativeMemorySummary', label: '原生核心记忆', detail: 'SullyOS refinedMemories 长期记忆摘要。' },
    { key: 'nativeActiveMemory', label: '原生活跃记忆', detail: 'SullyOS activeMemoryMonths 详细回忆。' },
    { key: 'fixedBehaviorRules', label: '固定行为规则', detail: '聊天行为规范、表达底线和角色固定规则。' },
    { key: 'voiceMessages', label: '语音消息', detail: '语音标签说明；实际语音还受角色开关和 API 配置影响。' },
    { key: 'memoryPalace', label: '记忆宫殿', detail: '向量召回、门牌背景和 memoryPalaceInjection。' },
    { key: 'worldbook', label: '世界书', detail: '角色挂载的世界书和关键词触发条目。' },
    { key: 'timeAwareness', label: '时间感知', detail: '当前日期、时间、时段和距离上次聊天多久。' },
    { key: 'realtimeState', label: '实时状态', detail: '天气、新闻、日程、情绪 buff、群聊和生活记录。' },
    { key: 'musicState', label: '音乐共听', detail: '当前歌曲、歌词窗口和切歌察觉。' },
    { key: 'bilingualMode', label: '双语输出', detail: '双语 XML 输出规则和末尾 reminder。' },
    { key: 'htmlMode', label: 'HTML 模式', detail: 'HTML 卡片输出规则和自定义 HTML prompt。' },
    { key: 'thinkingChain', label: '思考链', detail: '内心独白提示词和 reasoning 参数开关。' },
    { key: 'miniAppContext', label: '小程序上下文', detail: '麦当劳、瑞幸和点单模式的实时上下文。' },
    { key: 'mcpTools', label: 'MCP 工具', detail: '自定义 MCP 工具说明和尾部提醒。' },
    { key: 'recencyTail', label: '末尾钢印', detail: '关于对方表达和回到你自己的末尾定调。' },
    { key: 'chatHistory', label: '聊天历史', detail: '历史消息窗口；关闭时只保留最后一条用户消息。' },
];

const defaultModules = PROMPT_CONTROL_MODULES.reduce((acc, mod) => {
    acc[mod.key] = true;
    return acc;
}, {} as Record<PromptControlModuleKey, boolean>);

export const DEFAULT_PROMPT_CONTROL_CONFIG: PromptControlConfig = {
    modules: defaultModules,
};

function getStorage(): Storage | null {
    try {
        return typeof globalThis !== 'undefined' ? (globalThis as any).localStorage ?? null : null;
    } catch {
        return null;
    }
}

export function normalizePromptControlConfig(value: unknown): PromptControlConfig {
    const source = (value && typeof value === 'object') ? value as Partial<PromptControlConfig> : {};
    const sourceModules = (source.modules && typeof source.modules === 'object')
        ? source.modules as Partial<Record<PromptControlModuleKey, boolean>>
        : {};
    const modules = { ...DEFAULT_PROMPT_CONTROL_CONFIG.modules };
    for (const mod of PROMPT_CONTROL_MODULES) {
        modules[mod.key] = sourceModules[mod.key] !== false;
    }
    return { modules };
}

export function readPromptControlConfig(): PromptControlConfig {
    const storage = getStorage();
    if (!storage) return normalizePromptControlConfig(undefined);
    try {
        const raw = storage.getItem(PROMPT_CONTROL_STORAGE_KEY);
        return normalizePromptControlConfig(raw ? JSON.parse(raw) : undefined);
    } catch {
        return normalizePromptControlConfig(undefined);
    }
}

export function writePromptControlConfig(config: PromptControlConfig): PromptControlConfig {
    const next = normalizePromptControlConfig(config);
    const storage = getStorage();
    if (storage) {
        try {
            storage.setItem(PROMPT_CONTROL_STORAGE_KEY, JSON.stringify(next));
        } catch {
            // Prompt control is best effort and must never break chat generation.
        }
    }
    try {
        globalThis.dispatchEvent?.(new CustomEvent<PromptControlConfig>(PROMPT_CONTROL_EVENT, { detail: next }));
    } catch {
        // Node tests and old WebViews may not expose CustomEvent.
    }
    return next;
}

export function subscribePromptControlConfig(listener: (config: PromptControlConfig) => void): () => void {
    const onCustom = (event: Event) => {
        listener(normalizePromptControlConfig((event as CustomEvent<PromptControlConfig>).detail));
    };
    const onStorage = (event: StorageEvent) => {
        if (event.key === PROMPT_CONTROL_STORAGE_KEY) listener(readPromptControlConfig());
    };
    globalThis.addEventListener?.(PROMPT_CONTROL_EVENT, onCustom);
    globalThis.addEventListener?.('storage', onStorage as EventListener);
    return () => {
        globalThis.removeEventListener?.(PROMPT_CONTROL_EVENT, onCustom);
        globalThis.removeEventListener?.('storage', onStorage as EventListener);
    };
}

export function isPromptControlModuleEnabled(
    key: PromptControlModuleKey,
    config: PromptControlConfig = readPromptControlConfig(),
): boolean {
    return config.modules[key] !== false;
}

export function getCoreContextPromptControls(
    config: PromptControlConfig = readPromptControlConfig(),
): CoreContextPromptControls {
    const enabled = (key: PromptControlModuleKey) => isPromptControlModuleEnabled(key, config);
    return {
        coreIdentity: enabled('coreIdentity'),
        worldview: enabled('worldview'),
        userProfile: enabled('userProfile'),
        privateImpression: enabled('privateImpression'),
        nativeMemorySummary: enabled('nativeMemorySummary'),
        nativeActiveMemory: enabled('nativeActiveMemory'),
        fixedBehaviorRules: enabled('fixedBehaviorRules'),
        voiceMessages: enabled('voiceMessages'),
        memoryPalace: enabled('memoryPalace'),
        worldbook: enabled('worldbook'),
        timeAwareness: enabled('timeAwareness'),
        realtimeState: enabled('realtimeState'),
        musicState: enabled('musicState'),
    };
}

export function makePromptControlSnapshot(
    config: PromptControlConfig,
    states: Partial<Record<PromptControlModuleKey, { included: boolean; note?: string }>>,
): PromptControlSnapshot {
    const normalized = normalizePromptControlConfig(config);
    const modules = PROMPT_CONTROL_MODULES.map(mod => {
        const enabled = isPromptControlModuleEnabled(mod.key, normalized);
        const state = states[mod.key];
        return {
            ...mod,
            enabled,
            included: !!(enabled && state?.included),
            note: state?.note,
        };
    });
    return {
        modules,
        disabledKeys: modules.filter(mod => !mod.enabled).map(mod => mod.key),
    };
}

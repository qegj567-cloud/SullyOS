import type {
    CharacterProfile,
    Message,
    MountedWorldbook,
    StoryTheaterEntry,
    StoryTheaterMask,
    StoryTheaterMaskSelection,
    StoryTheaterPreset,
    StoryTheaterPresetDocument,
    StoryTheaterPresetPrompt,
    UserProfile,
} from '../types';
import nightScreeningV627 from '../assets/presets/night-screening-v6.14.sully.json';
import {
    type WorldbookScanMessage,
} from './worldbook';
import { shareOrDownloadFile } from './shareExport';
import { hasReliableMessageTimestamp } from './storyTheaterTimeline';

export type StoryApiRole = 'system' | 'user' | 'assistant';
export function hasStoryTheaterParticipant(entry: StoryTheaterEntry, characters: CharacterProfile[]): boolean {
    return characters.some(char => entry.characterIds.includes(char.id)
        || (!entry.writesToCharacterMemory && entry.mask?.type === 'character' && entry.mask.id === char.id));
}
export interface StoryApiMessage { role: StoryApiRole; content: string; }

export interface StoryPromptSlots {
    actors: string;
    persona: string;
    scenario: string;
    worldBefore: string;
    worldAfter: string;
    examples?: string;
    history?: string;
}

export interface StoryGenerationSettings {
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens: number;
}

/**
 * 默认完整发送酒馆预设中的采样参数。只有用户为当前剧情显式开启兼容开关时，才省略
 * top_p / frequency_penalty / presence_penalty；不能用少数中转的兼容问题牺牲正常预设效果。
 */
export const prepareStoryGenerationSettings = (
    settings?: Partial<StoryGenerationSettings>,
    omitSamplingParams = false,
): Partial<StoryGenerationSettings> => {
    if (!settings) return {};
    if (!omitSamplingParams) return { ...settings };
    const {
        top_p: _topP,
        frequency_penalty: _frequencyPenalty,
        presence_penalty: _presencePenalty,
        ...compatible
    } = settings;
    return compatible;
};

export interface StoryAffinityInput {
    characterId?: string;
    characterName?: string;
    delta: number;
    reason: string;
    awareness?: 'noticed' | 'unnoticed';
}

export interface ResolvedStoryTheaterMask {
    selection: StoryTheaterMaskSelection;
    name: string;
    avatar?: string;
    description: string;
    coreInstruction?: string;
    worldview?: string;
    characterId?: string;
}

export type StoryDisplayBlockKind = 'story' | 'scene' | 'backstage' | 'worldline' | 'debts' | 'theater' | 'choices' | 'affinity' | 'other';
export interface StoryDisplayBlock {
    kind: StoryDisplayBlockKind;
    title?: string;
    text: string;
    theater?: StoryMiniTheaterDisplay;
}

export interface StoryMiniTheaterDisplayMessage {
    side: 'left' | 'right';
    name: string;
    text: string;
}

export interface StoryMiniTheaterDisplay {
    title: string;
    system?: string;
    messages: StoryMiniTheaterDisplayMessage[];
}

export const REAL_COMPANION_MEMORY_GUARD = [
    '### 真实陪伴 · 共同记忆真实性（不可覆盖）',
    '- 只能把本上下文、角色已有真实记忆或本条真实陪伴中明确发生过的事件，当作角色与用户的共同记忆。',
    '- 不得捏造两人曾经发生过的经历，不得把推测、梦境、预设示例或虚构剧场内容说成真实记忆。',
    '- 引用共同记忆时不得添油加醋、补写不存在的细节、篡改因果或夸大情感；不确定时必须明确表现为不确定。',
    '- 可以自然遗忘或记错角色确实可能记错的细枝末节，但不得借此创造对用户不利或未经用户确认的共同历史。',
].join('\n');

export const RELATIONSHIP_TEXTURE_GUIDE = [
    '### 关系温度 · 高位不等于静止',
    '- 关系温度是长期底座，不是每轮必须变化的进度条。尤其达到 95—100 后，没有真正改变关系的新事实就保持原值与 +0，不为制造新鲜感反复涨跌。',
    '- 数值稳定时，变化应落在关系质地：默契如何落地、边界是否被尊重、哪件小事仍然刺手、彼此依赖的方式、刚形成的共同习惯、未说开的分歧或本轮完成的一次修复。',
    '- <relation_note> 每轮只写一句最能概括此刻质地的关系天气，避免连续复用“甜蜜、亲密、信任加深”等空泛同义句。',
    '- 在 <relation_note> 之后可追加 1—3 条 <relation_fragment>关系碎片</relation_fragment>；每条是一句基于本轮具体事实的短观察。维度按事实轮换，不写散乱 Markdown，不复述分数，不预测结局。',
    '- 若本轮确实没有值得记录的新纹理，可以不输出 relation_fragment；不要硬编碎念。',
].join('\n');

const NATIVE_MARKERS: Array<NonNullable<StoryTheaterPresetPrompt['marker']>> = [
    'characters', 'world_before', 'user', 'world_after', 'scenario', 'examples', 'history',
];

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const normalizeRole = (role: unknown): StoryApiRole => {
    if (role === 'assistant' || role === 2) return 'assistant';
    if (role === 'user' || role === 1) return 'user';
    return 'system';
};

export const makeStoryTheaterId = (): string => (
    globalThis.crypto?.randomUUID?.() || `story_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
);

export const storyTheaterThreadId = (entryId: string): string => `story-theater:${entryId}`;

const formatStoryExportTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '未知时间';
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** 把一条剧情的完整中央线程导出为便于长期保存与检索的纯文字原文。 */
export const formatStoryTheaterExport = (
    entry: Pick<StoryTheaterEntry, 'title' | 'premise' | 'writesToCharacterMemory'>,
    identityName: string,
    actorNames: string[],
    messages: Message[],
    exportedAt: number = Date.now(),
): string => {
    const title = entry.title.trim() || '未命名剧情';
    const userLabel = identityName.trim() || '你';
    const lines = [
        `剧情记录 · ${title}`,
        `模式：${entry.writesToCharacterMemory ? '真实时间陪伴' : '虚构剧场'}`,
        `你：${userLabel}`,
        `角色：${actorNames.filter(Boolean).join('、') || '暂无'}`,
        `导出时间：${formatStoryExportTime(exportedAt)}`,
    ];
    if (entry.premise.trim()) lines.push(`剧情简介：${entry.premise.trim()}`);
    lines.push('', '===== 完整原文 =====');

    for (const message of [...messages].sort((a, b) => a.id - b.id)) {
        const speaker = message.role === 'user' ? userLabel : message.role === 'assistant' ? '剧场正文' : '系统';
        lines.push('', `[${formatStoryExportTime(message.timestamp)}] ${speaker}`, message.content?.trim() || '（无内容）');
    }
    return `\uFEFF${lines.join('\n')}`;
};

export const makeStoryTheaterFileName = (title: string, now: number = Date.now()): string => {
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名剧情';
    return `${safeTitle}_剧情记录_${formatStoryExportTime(now).slice(0, 10)}.txt`;
};

export const createStoryTheaterDraft = (now: number = Date.now()): StoryTheaterEntry => ({
    id: makeStoryTheaterId(),
    title: '',
    premise: '',
    openingMode: 'user',
    mask: { type: 'user' },
    characterIds: [],
    writesToCharacterMemory: false,
    characterMemoryDates: {},
    carryCharacterMemory: false,
    characterContextLimits: {},
    archiveAfter: 40,
    archiveKeepRecent: 5,
    archiveStrategy: 'summary',
    archives: [],
    selectedWorldbookIds: [],
    forceUserLastMessage: false,
    omitSamplingParams: false,
    createdAt: now,
    updatedAt: now,
});

/** 老数据/手改 JSON 的温和补全；不改变已经选择的沙盒开关。 */
export const normalizeStoryTheater = (entry: StoryTheaterEntry): StoryTheaterEntry => {
    const archiveAfter = Math.round(clampNumber(entry.archiveAfter, 2, 200, 40));
    const archiveKeepRecent = Math.round(clampNumber(entry.archiveKeepRecent, 1, Math.max(1, archiveAfter - 1), Math.min(5, archiveAfter - 1)));
    return {
        ...entry,
        title: String(entry.title || '未命名剧情'),
        premise: String(entry.premise || ''),
        openingMode: entry.openingMode === 'assistant' ? 'assistant' : 'user',
        mask: entry.writesToCharacterMemory ? { type: 'user' } : entry.mask?.type === 'character' && entry.mask.id
            ? { type: 'character', id: entry.mask.id }
            : entry.mask?.type === 'custom' && entry.mask.id
                ? { type: 'custom', id: entry.mask.id }
                : { type: 'user' },
        characterIds: Array.isArray(entry.characterIds) ? entry.characterIds.filter(Boolean) : [],
        writesToCharacterMemory: entry.writesToCharacterMemory === true,
        characterMemoryDates: entry.characterMemoryDates || {},
        carryCharacterMemory: entry.writesToCharacterMemory ? true : entry.carryCharacterMemory === true,
        characterContextLimits: entry.characterContextLimits || {},
        archiveAfter,
        archiveKeepRecent,
        archiveMode: entry.archiveMode === 'manual' ? 'manual' : 'auto',
        archiveStrategy: entry.archiveStrategy === 'vector' ? 'vector' : 'summary',
        archives: Array.isArray(entry.archives) ? entry.archives : [],
        selectedWorldbookIds: Array.isArray(entry.selectedWorldbookIds) ? entry.selectedWorldbookIds.filter(Boolean) : [],
        presetId: /^builtin-night-screening-v\d/i.test(String(entry.presetId || '')) ? 'builtin-night-screening' : entry.presetId,
        presetOverride: entry.presetOverride?.schema === 'sullyos.story-preset' && Array.isArray(entry.presetOverride.prompts) ? entry.presetOverride : undefined,
        forceUserLastMessage: entry.forceUserLastMessage === true,
        omitSamplingParams: entry.omitSamplingParams === true,
        createdAt: Number(entry.createdAt) || Date.now(),
        updatedAt: Number(entry.updatedAt) || Number(entry.createdAt) || Date.now(),
    };
};

/**
 * 达到水位线后只归档最旧部分，并至少保留最近若干楼。
 * 如果切点正好落在“你的推进 / 剧场正文”之间，宁可多留一楼，也不拆散这一轮。
 */
export const selectStoryArchiveBatch = (
    rows: Message[],
    archiveAfter: number,
    keepRecent: number,
): Message[] => {
    const threshold = Math.max(2, Math.round(archiveAfter) || 40);
    if (rows.length < threshold) return [];
    const keep = Math.max(1, Math.min(threshold - 1, Math.round(keepRecent) || 5));
    const batch = rows.slice(0, Math.max(0, rows.length - keep));
    if (batch[batch.length - 1]?.role === 'user' && rows[batch.length]?.role === 'assistant') {
        batch.pop();
    }
    return batch;
};

export const createStoryTheaterMaskDraft = (now: number = Date.now()): StoryTheaterMask => ({
    id: makeStoryTheaterId(),
    name: '',
    description: '',
    coreInstruction: '',
    worldview: '',
    createdAt: now,
    updatedAt: now,
});

export const resolveStoryTheaterMask = (
    selection: StoryTheaterMaskSelection | undefined,
    user: UserProfile,
    characters: CharacterProfile[],
    masks: StoryTheaterMask[],
): ResolvedStoryTheaterMask => {
    if (selection?.type === 'character') {
        const char = characters.find(item => item.id === selection.id);
        if (char) return {
            selection,
            name: char.name,
            avatar: char.avatar,
            description: char.description || '',
            coreInstruction: char.systemPrompt || '',
            worldview: char.worldview || '',
            characterId: char.id,
        };
    }
    if (selection?.type === 'custom') {
        const mask = masks.find(item => item.id === selection.id);
        if (mask) return {
            selection,
            name: mask.name,
            avatar: mask.avatar,
            description: mask.description,
            coreInstruction: mask.coreInstruction,
            worldview: mask.worldview,
        };
    }
    return { selection: { type: 'user' }, name: user.name || '你', avatar: user.avatar, description: user.bio || '' };
};

const normalizeDocument = (value: any, fallbackName: string): StoryTheaterPresetDocument => {
    if (!value || value.schema !== 'sullyos.story-preset' || value.version !== 1 || !Array.isArray(value.prompts)) {
        throw new Error('不是受支持的糯米机剧情预设');
    }
    const prompts: StoryTheaterPresetPrompt[] = value.prompts.map((prompt: any, index: number) => ({
        id: String(prompt?.id || `prompt_${index + 1}`),
        name: String(prompt?.name || `提示词 ${index + 1}`),
        enabled: prompt?.enabled !== false,
        role: normalizeRole(prompt?.role),
        content: String(prompt?.content || ''),
        ...(prompt?.section?.id && ['start', 'end'].includes(prompt.section.edge) ? {
            section: { id: String(prompt.section.id), name: String(prompt.section.name || '自定义分组'), edge: prompt.section.edge },
        } : {}),
        ...(NATIVE_MARKERS.includes(prompt?.marker) ? { marker: prompt.marker } : {}),
    }));
    if (prompts.length === 0) throw new Error('预设中没有提示词条目');
    return {
        schema: 'sullyos.story-preset',
        version: 1,
        name: String(value.name || fallbackName || '未命名剧情预设'),
        description: String(value.description || ''),
        generation: {
            temperature: clampNumber(value.generation?.temperature, 0, 2, 0.9),
            topP: clampNumber(value.generation?.topP, 0, 1, 1),
            frequencyPenalty: clampNumber(value.generation?.frequencyPenalty, -2, 2, 0),
            presencePenalty: clampNumber(value.generation?.presencePenalty, -2, 2, 0),
            maxTokens: Math.round(clampNumber(value.generation?.maxTokens, 256, 32000, 8000)),
        },
        prompts,
        assistantPrefill: String(value.assistantPrefill || ''),
    };
};

const NATIVE_MULTI_AFFINITY_PROMPT = [
    '启用本条时，在每次回复末尾输出一个“多角色双向关系温度”面板。每位参与角色都拥有彼此隔离的 C→U、U→C 与五维关系混音；禁止把多人压成单一“当前 C”，也不得共享或平均任何数值。',
    '',
    '【逐角色双向记账】',
    '- 从最近一次 <affinity_panel> 按 character_id 读取每位角色自己的完整记录；首次出现且没有旧记录时，C→U 与 U→C 均从 50 开始，五个维度依据角色卡与已经发生的共同经历建立。',
    '- C→U 是该角色对用户侧角色的总体关系温度，只随已经落地且属于这两人的关系事实变化。普通回合约 -3 至 +3，重大事实可至 -8 至 +8；没有新事实时保持原值并记 +0。',
    '- trust、security、possessive_pull、emotional_pressure、repair_will 都是 0—100 的独立维度，记录力量怎样运作，不直接命令角色采取行为。高占有与真心同时存在时应形成对向拉扯，不把二者相加成更强的控制。',
    '- 最新用户消息可能包含 <u_affinity_updates>；只按 character_id 更新匹配角色的 U→C。某角色没有本轮更新时保持原值，delta 为 +0，原因写“本轮未填写”；不得依据正文替用户自行升降。',
    '- awareness 只决定对应角色是否明确知道用户→自己的准确数值变化与原因；其他角色不得共享这份透视。C→U 与五维状态仍由该角色自己的事实、能力、处境与情绪潮线决定。',
    '- U→C 向下时，把 reason 当作执笔人的阅读体验灯号：回到角色动机与现场因果中寻找符合人物的修复入口，但不把角色写成讨好数值的攻略对象。',
    '',
    '【正文权限】',
    '- 数值只作为连续性底座，不能覆盖角色卡、世界事实、执笔权、同意边界或人物原有目标；95—100 后仍通过关系天气、维度消长、选择代价与关系碎片表现变化。',
    '- 未察觉的 U→C 更新只作为低权重叙事背景；已察觉时由对应角色在本轮作出符合性格与现场节拍的反应，但不照念 XML 或系统数字。',
    '',
    '【输出】',
    '用一个 <affinity_panel> 包住全部参与角色，并严格按角色资料顺序为每人输出：',
    '<affinity_person>',
    '<character_id>角色 ID</character_id>',
    '<character_name>角色名</character_name>',
    '<c_to_u_score>50</c_to_u_score>',
    '<c_to_u_delta>+0</c_to_u_delta>',
    '<c_to_u_note>改变该角色 C→U 的本轮事实；没有则写“本轮无新事实”</c_to_u_note>',
    '<u_to_c_score>50</u_to_c_score>',
    '<u_to_c_delta>+0</u_to_c_delta>',
    '<u_to_c_note>用户填写的原因；没有则写“本轮未填写”</u_to_c_note>',
    '<awareness_state>已察觉或未察觉</awareness_state>',
    '<trust>50</trust>',
    '<security>50</security>',
    '<possessive_pull>50</possessive_pull>',
    '<emotional_pressure>50</emotional_pressure>',
    '<repair_will>50</repair_will>',
    '<state_note>本轮最明显的内部拉扯、选择代价或修复动作</state_note>',
    '<relation_note>这一段关系当前的具体质地</relation_note>',
    '<relation_fragment>可选的一条短关系碎片</relation_fragment>',
    '</affinity_person>',
    '按角色继续排列，最后闭合 </affinity_panel>。每位角色必须恰好一段；不输出旧版根级 c_score / u_score 单槽字段。',
].join('\n');

/**
 * V6.14 原稿把幕后暗格与镜头债拆成两个开关。糯米机把它们视为同一个
 * “幕后与余波”模块：提示词在同一位置发送，两个协议块连续输出，界面也只
 * 展示一个折叠区。保留原 id 作为关闭的迁移占位，旧沙盒覆盖仍可被运行时提醒兼容。
 */
const replacePromptLine = (content: string, startsWith: string, replacement: string): string => content
    .split('\n')
    .map(line => line.startsWith(startsWith) ? replacement : line)
    .join('\n');

const mergeNightScreeningBackstageAndDebts = (document: StoryTheaterPresetDocument): StoryTheaterPresetDocument => {
    const backstage = document.prompts.find(prompt => prompt.id === 'nmj-v48-backstage');
    const debts = document.prompts.find(prompt => prompt.id === 'nmj-v61-shot-debts');
    if (!backstage || !debts) return document;
    const orderedPrompts = [...document.prompts];
    const startupStartIndex = orderedPrompts.findIndex(prompt => prompt.id === 'nmj-v64-section-startup-start');
    const firstStartupPromptIndex = orderedPrompts.findIndex(prompt => prompt.id === 'nmj-v3-user-shell');
    if (startupStartIndex > firstStartupPromptIndex && firstStartupPromptIndex >= 0) {
        const [sectionStart] = orderedPrompts.splice(startupStartIndex, 1);
        orderedPrompts.splice(firstStartupPromptIndex, 0, sectionStart);
    }
    const debtContent = debts.content.replace(
        /^在正文、(?:幕后)?暗格和世界线后，/,
        '紧接 </backstage> 后，',
    );
    return {
        ...document,
        prompts: orderedPrompts.map(originalPrompt => {
            const prompt = {
                ...originalPrompt,
                name: originalPrompt.name.replace(/双向(?:好感|温度)/g, '多角色双向关系温度'),
                content: originalPrompt.content.replace(/双向(?:好感|温度)/g, '多角色双向关系温度'),
            };
            if (prompt.id === 'nmj-v65-affinity-control') return {
                ...prompt,
                name: '💗多角色双向关系温度｜逐人五维｜默认开启',
                content: NATIVE_MULTI_AFFINITY_PROMPT,
            };
            if (prompt.id === backstage.id) return {
                ...prompt,
                name: '🗝️幕后与余波｜心境·秘密·真话·镜头债｜默认开启',
                content: `${backstage.content}\n\n# 同一折叠模块：镜头债\n${debtContent}`,
            };
            if (prompt.id === debts.id) return {
                ...prompt,
                name: '↳ 镜头债已并入「幕后与余波」',
                enabled: false,
                content: '',
            };
            if (prompt.id === 'nsfw' || prompt.id === 'jailbreak') return {
                ...prompt,
                name: `${prompt.name}｜空连接位已停用`,
                enabled: false,
            };
            if (prompt.id === 'nmj-v3-scene-header') return {
                ...prompt,
                content: replacePromptLine(
                    replacePromptLine(
                        replacePromptLine(
                            prompt.content,
                            '- 先从角色卡、世界资料、场景和聊天历史寻找已经成立的日期、星期与时刻；不得覆盖已有时间；',
                            '- 先从当前剧情（前提、常驻事件盒、本剧情共享档案）、本剧场聊天历史（上一层剧场正文的 <scene_header><time>）及用户最新推进中寻找已经成立的本故事时间；角色资料中携带的既有记忆、日程或往期聊天日期仅作过往背景，不得当成当前剧场的基准时间；',
                        ),
                        '- 第一轮自行确定的时间从此成为故事事实。之后根据对话、移动、等待、睡眠与时间跳跃实际经过的时长推进，不得每轮重新随机日期；',
                        '- 第一轮自行确定的时间从此成为故事事实。之后优先服从用户在本轮明确写出的时间推进或新日期锚点（如“推进剧情到X天后”“现在是X月X日”），未指定跳时则根据对话、移动、等待与睡眠实际经过的时长推进，不得被角色既有记忆中的现实日期拉回，也不得每轮重新随机日期；',
                    ),
                    '正文结束后，依次输出',
                    '正文结束后，依次输出已启用的“幕后与余波”（幕后暗格后紧接镜头债）、世界线、小剧场、回复选项和多角色双向关系温度。',
                ),
            };
            if (prompt.id === 'nmj-v616-silent-preflight') return {
                ...prompt,
                name: '🎬开拍前｜静默排片检查｜常驻',
                content: replacePromptLine(
                    replacePromptLine(
                        prompt.content,
                        '正文前完成一次排片思考。',
                        '正文前静默完成一次排片检查；只把结论落实到成品，不输出分析、检查过程或隐藏推理。',
                    ),
                    '6. 关系侧表：',
                    '6. 关系侧表：按 character_id 逐人续接 C→U、U→C 与五维关系混音；每位角色只读取自己的事实和用户对自己的更新。高温度与高占有形成选择拉扯，不放大成控制；U→C 向下时为对应角色寻找符合人物的修复入口；',
                ).replace('导演层理解执笔灯号，角色层只接触故事内信号；', '生成规则读取执笔灯号，故事人物只接触其可知的故事内信号；'),
            };
            if (prompt.id === 'nmj-v3-exit-check') return {
                ...prompt,
                content: replacePromptLine(
                    replacePromptLine(
                        prompt.content,
                        '- 人物行动来自生活线、情绪潮线与关系侧表的合力；',
                        '- 人物行动来自生活线、情绪潮线与逐角色关系侧表的合力；每位角色按 character_id 独立续接 C→U、U→C 与五维状态，角色之间没有共享数值或察觉状态。C→U 只随该角色亲历的关系事实变化，U→C 只读取用户对该角色的最新更新；高真心与高占有形成对向选择代价，不共同放大控制；U→C 向下时，正文已有符合该角色自身动机的修复入口；',
                    ),
                    '- 正文后的材料已按散场分流',
                    '- 正文后的材料已按散场分流进入唯一且最贴近的片盒：幕后与余波收人物内层材料及未到账后果，世界线收镜头外实变，小剧场收非正篇折射，多角色双向关系温度逐人记账；各区提供新材料。输出顺序为：场景条 → 正文 → 幕后与余波（幕后暗格 → 镜头债）→ 世界线 → 已启用的小剧场 → 已启用的回复选项 → 已启用的多角色双向关系温度；',
                ),
            };
            if (prompt.id === 'nmj-v64-section-output-start') return {
                ...prompt,
                name: '🧩↓附加输出｜格式／场景条／幕后与余波／世界线',
            };
            if (prompt.id === 'nmj-v3-theater-ai') return {
                ...prompt,
                name: '💬小剧场｜角色与你聊天',
                content: [
                    '在 </story_text> 之后追加一段非正篇聊天：让当前最合适的角色与你以当前身份对话，可以求助、争辩、投诉或一本正经地问错问题。写 4—8 个短气泡，让你和角色至少发生一次理解错位。默认不改变正篇事实。',
                    '',
                    '严格使用：',
                    '<mini_theater>',
                    '<mt_title>小剧场标题</mt_title>',
                    '<mt_system>很短的界面提示，可省略</mt_system>',
                    '<mt_ai><name>你的名字</name><text>你的消息</text></mt_ai>',
                    '<mt_user><name>角色名</name><text>角色消息</text></mt_user>',
                    '按需要继续排列。',
                    '</mini_theater>',
                ].join('\n'),
            };
            if (prompt.id === 'nmj-v3-theater-user-sim') return {
                ...prompt,
                name: '🪞小剧场｜角色与你的倒影私聊',
                content: [
                    '在 </story_text> 之后追加一段非正篇聊天：某个角色与你的虚构倒影交谈。这道倒影必须标为“{{user}}的倒影”；它不是实际的你，不代表你的真实思想、决定或未来行为。趣味来自角色如何试探这道倒影，又怎样被自己的错误假设反噬。写 4—8 个气泡。',
                    '',
                    '严格使用：',
                    '<mini_theater>',
                    '<mt_title>小剧场标题</mt_title>',
                    '<mt_system>倒影只依据角色提供的信息回应</mt_system>',
                    '<mt_ai><name>{{user}}的倒影</name><text>倒影消息</text></mt_ai>',
                    '<mt_user><name>角色名</name><text>角色消息</text></mt_user>',
                    '按需要继续排列。',
                    '</mini_theater>',
                ].join('\n'),
            };
            if (prompt.id === 'nmj-v3-theater-group') return {
                ...prompt,
                name: '👥小剧场｜你和角色们群聊',
                content: [
                    '在 </story_text> 之后追加一段非正篇群聊。选择 2—4 个当前合适的角色，再让你以当前身份加入。写 5—10 个短气泡，让不同打字习惯互相撞坏一次正题。默认不改变正篇事实。',
                    '',
                    '严格使用：',
                    '<mini_theater>',
                    '<mt_title>群聊名称</mt_title>',
                    '<mt_system>群聊提示，可省略</mt_system>',
                    '<mt_ai><name>你的名字或角色名</name><text>消息</text></mt_ai>',
                    '<mt_user><name>角色名或你的名字</name><text>消息</text></mt_user>',
                    '按需要继续排列。',
                    '</mini_theater>',
                ].join('\n'),
            };
            return prompt;
        }),
    };
};

export const BUILTIN_NIGHT_SCREENING_PRESET: StoryTheaterPreset = {
    id: 'builtin-night-screening',
    name: '糯米鸡｜夜班放映室 V6.27',
    format: 'sullyos-story-preset',
    document: mergeNightScreeningBackstageAndDebts(normalizeDocument(nightScreeningV627, '糯米鸡｜夜班放映室 V6.27')),
    builtIn: true,
    createdAt: 0,
    updatedAt: 0,
};

export const withBuiltInStoryPresets = (presets: StoryTheaterPreset[]): StoryTheaterPreset[] => [
    BUILTIN_NIGHT_SCREENING_PRESET,
    ...presets.filter(preset => !preset.id.startsWith('builtin-night-screening')),
];

/**
 * 快捷设置历史上保存的是整份内置文档。升级内置预设时只继承同 ID 条目的
 * 开关选择，正文与新增模块始终使用最新版；自建预设仍完整保留用户内容。
 */
export const resolveStoryPresetDocument = (
    preset: StoryTheaterPreset,
    override?: StoryTheaterPresetDocument,
): StoryTheaterPresetDocument => {
    if (!override) return preset.document;
    if (!preset.builtIn) return override;
    const enabledById = new Map(override.prompts.map(prompt => [prompt.id, prompt.enabled]));
    return {
        ...preset.document,
        prompts: preset.document.prompts.map(prompt => enabledById.has(prompt.id)
            ? { ...prompt, enabled: enabledById.get(prompt.id) === true }
            : prompt),
    };
};

export const parseStoryTheaterPreset = (rawText: string, sourceFileName: string, now: number = Date.now()): StoryTheaterPreset => {
    if (rawText.length > 5 * 1024 * 1024) throw new Error('预设超过 5 MB，请先移除内嵌素材或脚本数据');
    let data: Record<string, any>;
    try { data = JSON.parse(rawText); } catch { throw new Error('不是有效的 JSON 预设'); }
    const fileBase = sourceFileName.replace(/\.json$/i, '').trim() || '导入预设';
    if (data.schema !== 'sullyos.story-preset') throw new Error('只接受糯米机剧情预设（schema: sullyos.story-preset）');
    const document = normalizeDocument(data, fileBase);
    return { id: makeStoryTheaterId(), name: document.name, sourceFileName, format: 'sullyos-story-preset', document, createdAt: now, updatedAt: now };
};

export const createBlankStoryPreset = (name = '新剧情预设', now = Date.now()): StoryTheaterPreset => ({
    id: makeStoryTheaterId(), name, format: 'sullyos-story-preset', createdAt: now, updatedAt: now,
    document: {
        schema: 'sullyos.story-preset', version: 1, name,
        generation: { temperature: 0.9, topP: 1, frequencyPenalty: 0, presencePenalty: 0, maxTokens: 8000 },
        prompts: [
            { id: makeStoryTheaterId(), name: '主叙事规则', enabled: true, role: 'system', content: '直接续写连续的第三人称故事，让人物保持独立动机与知识边界。' },
            { id: makeStoryTheaterId(), name: '世界书 · 角色设定前', enabled: true, role: 'system', content: '', marker: 'world_before' },
            { id: makeStoryTheaterId(), name: '角色资料', enabled: true, role: 'system', content: '', marker: 'characters' },
            { id: makeStoryTheaterId(), name: '世界书', enabled: true, role: 'system', content: '', marker: 'world_after' },
            { id: makeStoryTheaterId(), name: '剧情设定', enabled: true, role: 'system', content: '', marker: 'scenario' },
            { id: makeStoryTheaterId(), name: '聊天历史', enabled: true, role: 'system', content: '', marker: 'history' },
        ],
    },
});

export const duplicateStoryPreset = (preset: StoryTheaterPreset, now = Date.now()): StoryTheaterPreset => {
    const name = `${preset.name} · 副本`;
    return { ...preset, id: makeStoryTheaterId(), name, builtIn: false, sourceFileName: undefined, document: { ...preset.document, name, prompts: preset.document.prompts.map(prompt => ({ ...prompt })) }, createdAt: now, updatedAt: now };
};

export const getPresetPromptStats = (preset?: StoryTheaterPreset | null): { total: number; enabled: number; scripts: number } => {
    if (!preset) return { total: 0, enabled: 0, scripts: 0 };
    return { total: preset.document.prompts.length, enabled: preset.document.prompts.filter(prompt => prompt.enabled).length, scripts: 0 };
};

export interface StoryPresetPromptGroup {
    key: string;
    label: string;
    description: string;
    promptIds: string[];
    startIndex: number;
    endIndex: number;
    protected: boolean;
    customSectionId?: string;
}

const STORY_PRESET_GROUP_SPECS = [
    { key: 'startup', label: '顶部启动框架', description: '破甲、虚构框架、续航与主叙事底座', start: 'nmj-v64-section-startup-start', end: 'nmj-v64-section-startup-end' },
    { key: 'input', label: '输入处理', description: '长片意识、转述、回放与即时接戏', start: 'nmj-v64-section-input-start', end: 'nmj-v64-section-input-end' },
    { key: 'sources', label: '角色与世界', description: '角色卡、世界书、你的身份、场景、示例与历史', start: 'nmj-v64-section-sources-start', end: 'nmj-v64-section-sources-end', protected: true },
    { key: 'story', label: '人物与剧情', description: '人物发动机、证据门、推进、对白与纠偏', start: 'nmj-v64-section-story-start', end: 'nmj-v64-section-story-end' },
    { key: 'tone', label: '文风与张力', description: '文风、场景张力、亲密镜头与叠加仲裁', start: 'nmj-v64-section-style-start', end: 'nmj-v64-section-arbitration-end' },
    { key: 'camera', label: '镜头与关系', description: '人称、执笔权与多角色 U→C 关系温度', start: 'nmj-v64-section-camera-start', end: 'nmj-v65-section-affinity-end' },
    { key: 'output', label: '语言与输出', description: '语言、篇幅、场景条、幕后与余波、世界线', start: 'nmj-v64-section-language-start', end: 'nmj-v64-section-output-end' },
    { key: 'extras', label: '幕间与选项', description: '小剧场、边角频道与回复方向', start: 'nmj-v64-section-theater-start', end: 'nmj-v64-section-choices-end' },
    { key: 'exit', label: '出口与收尾', description: '出口检查、核心续写与定义增强', start: 'nmj-v64-section-exit-start', end: 'enhanceDefinitions' },
] as const;

export const isStoryPresetSectionMarker = (prompt: StoryTheaterPresetPrompt): boolean => Boolean(prompt.section) || /^nmj-v6[45]-section-.+-(start|end)$/.test(prompt.id);

export const isProtectedStoryPrompt = (prompt: StoryTheaterPresetPrompt): boolean => Boolean(
    prompt.marker || prompt.id === 'nmj-v64-section-sources-start' || prompt.id === 'nmj-v64-section-sources-end'
    || ['charDescription', 'charPersonality', 'worldInfoBefore', 'personaDescription', 'worldInfoAfter', 'scenario', 'dialogueExamples', 'chatHistory'].includes(prompt.id)
);

export const getStoryPresetPromptGroups = (document: StoryTheaterPresetDocument): StoryPresetPromptGroup[] => {
    const prompts = document.prompts;
    const claimed = new Set<number>();
    const groups: StoryPresetPromptGroup[] = [];
    for (const spec of STORY_PRESET_GROUP_SPECS) {
        const startIndex = prompts.findIndex(prompt => prompt.id === spec.start);
        const endIndex = prompts.findIndex(prompt => prompt.id === spec.end);
        if (startIndex < 0 || endIndex < startIndex || claimed.has(startIndex) || claimed.has(endIndex)) continue;
        const indexes = Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset);
        indexes.forEach(index => claimed.add(index));
        groups.push({
            key: spec.key,
            label: spec.label,
            description: spec.description,
            promptIds: indexes.map(index => prompts[index].id),
            startIndex,
            endIndex,
            protected: 'protected' in spec && spec.protected === true,
        });
    }
    for (let startIndex = 0; startIndex < prompts.length; startIndex++) {
        const section = prompts[startIndex].section;
        if (section?.edge !== 'start' || claimed.has(startIndex)) continue;
        const endIndex = prompts.findIndex((prompt, index) => index > startIndex && prompt.section?.id === section.id && prompt.section.edge === 'end');
        if (endIndex < 0 || prompts.slice(startIndex + 1, endIndex).some(prompt => prompt.section) || Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset).some(index => claimed.has(index))) continue;
        const indexes = Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => startIndex + offset);
        indexes.forEach(index => claimed.add(index));
        groups.push({ key: `section:${section.id}`, label: section.name, description: '自定义分组 · 可添加提示词、调整顺序', promptIds: indexes.map(index => prompts[index].id), startIndex, endIndex, protected: false, customSectionId: section.id });
    }
    let cursor = 0;
    while (cursor < prompts.length) {
        if (claimed.has(cursor)) { cursor += 1; continue; }
        const startIndex = cursor;
        while (cursor + 1 < prompts.length && !claimed.has(cursor + 1)) cursor += 1;
        const endIndex = cursor;
        groups.push({
            key: `custom:${prompts[startIndex]?.id || startIndex}`,
            label: '自定义条目',
            description: '没有归入内置区间的自定义提示词',
            promptIds: prompts.slice(startIndex, endIndex + 1).map(prompt => prompt.id),
            startIndex,
            endIndex,
            protected: false,
        });
        cursor += 1;
    }
    return groups.sort((a, b) => a.startIndex - b.startIndex);
};

export const addStoryPresetGroup = (document: StoryTheaterPresetDocument, name: string): StoryTheaterPresetDocument => {
    const id = makeStoryTheaterId();
    return { ...document, prompts: [...document.prompts, ...(['start', 'end'] as const).map(edge => ({
        id: makeStoryTheaterId(), name: name.trim() || '自定义分组', enabled: false, role: 'system' as const, content: '',
        section: { id, name: name.trim() || '自定义分组', edge },
    }))] };
};

export const renameStoryPresetGroup = (document: StoryTheaterPresetDocument, sectionId: string, name: string): StoryTheaterPresetDocument => ({
    ...document, prompts: document.prompts.map(prompt => prompt.section?.id === sectionId
        ? { ...prompt, section: { ...prompt.section, name } } : prompt),
});

export const ungroupStoryPresetGroup = (document: StoryTheaterPresetDocument, sectionId: string): StoryTheaterPresetDocument => ({
    ...document, prompts: document.prompts.filter(prompt => prompt.section?.id !== sectionId),
});

export const moveStoryPresetPromptToGroup = (document: StoryTheaterPresetDocument, promptId: string, groupKey: string): StoryTheaterPresetDocument => {
    const groups = getStoryPresetPromptGroups(document);
    const source = groups.find(group => group.promptIds.includes(promptId));
    const target = groups.find(group => group.key === groupKey);
    const prompt = document.prompts.find(item => item.id === promptId);
    if (!prompt || !target || target.protected || source?.protected || source?.key === target.key || isProtectedStoryPrompt(prompt) || isStoryPresetSectionMarker(prompt)) return document;
    const next = { ...document, prompts: document.prompts.filter(item => item.id !== promptId) };
    const destination = getStoryPresetPromptGroups(next).find(group => group.key === groupKey);
    if (!destination) return document;
    const last = next.prompts[destination.endIndex];
    next.prompts.splice(isStoryPresetSectionMarker(last) ? destination.endIndex : destination.endIndex + 1, 0, prompt);
    return next;
};

export const applyStoryPresetChoice = (
    document: StoryTheaterPresetDocument,
    optionIds: readonly string[],
    selectedId?: string,
): StoryTheaterPresetDocument => ({
    ...document,
    prompts: document.prompts.map(prompt => optionIds.includes(prompt.id) ? { ...prompt, enabled: prompt.id === selectedId } : prompt),
});

const macroReplace = (text: string, userName: string, characterNames: string[]): string => text
    .replace(/\{\{user\}\}/gi, userName || '你')
    .replace(/\{\{char\}\}/gi, characterNames.join('、') || '角色')
    .replace(/\{\{group\}\}/gi, characterNames.join('、') || '角色');

export const STORY_MINI_THEATER_PROMPT_IDS = [
    'nmj-v3-theater-ai',
    'nmj-v3-theater-user-sim',
    'nmj-v3-theater-group',
    'nmj-v3-theater-random',
    'nmj-v6-side-channel-terminal',
    'nmj-v6-side-channel-evidence',
    'nmj-v6-side-channel-public',
    'nmj-v6-side-channel-wrong-reel',
    'nmj-v3-theater-custom',
] as const;

export const getActiveStoryMiniTheaterPrompt = (document: StoryTheaterPresetDocument): StoryTheaterPresetPrompt | undefined => {
    const ids = new Set<string>(STORY_MINI_THEATER_PROMPT_IDS);
    return document.prompts.find(prompt => prompt.enabled && ids.has(prompt.id));
};

/** 将当前沙盒启用的小剧场规则重复放到本轮输入前，避免被较后的输出协议忽略。 */
export const buildStoryMiniTheaterReminder = (
    document: StoryTheaterPresetDocument,
    userName: string,
    characterNames: string[],
): string => {
    const prompt = getActiveStoryMiniTheaterPrompt(document);
    if (!prompt?.content.trim()) return '';
    return [
        `### 本轮结尾模块：${prompt.name}`,
        '这一模块已经由用户在本剧情的快捷预设中启用。本轮必须在主正文之后完整执行，不得因其它输出规则而省略。',
        '格式守门：每个 <mt_ai> / <mt_user> 内都必须同时写出一组完整的 <name> 与 <text>，闭合所有标签；不得把“… / ... / 按需要继续排列”等示例占位符当成实际消息输出。',
        macroReplace(prompt.content, userName, characterNames),
        '无论上方条目是完整模板还是简写说明，最终都必须使用这个可渲染外壳：',
        '<mini_theater>',
        '<mt_title>本轮实际标题</mt_title>',
        '<mt_system>可省略的短界面提示</mt_system>',
        '<mt_ai><name>左侧显示名</name><text>完整消息</text></mt_ai>',
        '<mt_user><name>右侧显示名</name><text>完整消息</text></mt_user>',
        '</mini_theater>',
    ].join('\n');
};

/** 兼容旧沙盒覆盖：只要暗格或镜头债任一开关仍在，就统一为连续的组合模块。 */
export const buildStoryBackstageAftermathReminder = (document: StoryTheaterPresetDocument): string => {
    const backstage = document.prompts.find(prompt => prompt.id === 'nmj-v48-backstage');
    const legacyDebts = document.prompts.find(prompt => prompt.id === 'nmj-v61-shot-debts');
    const backstageEnabled = backstage?.enabled === true;
    const debtsEnabled = legacyDebts?.enabled === true || Boolean(backstageEnabled && backstage?.content.includes('<shot_debts>'));
    if (!backstageEnabled && !debtsEnabled) return '';
    return [
        '### 本轮组合模块：幕后与余波',
        '幕后暗格与镜头债在糯米机中属于同一个折叠模块，不得拆成相隔很远的两个结尾区，也不得重复生成。',
        backstageEnabled ? '- 正文结束后输出一组完整且闭合的 <backstage>；心境、秘密与稀有真话都按已启用预设执行。' : '',
        debtsEnabled ? '- 紧接 </backstage>（若暗格关闭则紧接正文）输出一组完整且闭合的 <shot_debts>；之后才输出世界线、小剧场、选项和关系温度。' : '',
        '- 两组原始标签仍分别保留用于稳定解析，但界面只显示一个“幕后与余波”折叠区。',
    ].filter(Boolean).join('\n');
};

const escapeStoryXml = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** 关系备注只随本轮用户输入送入模型，不混进可见正文。 */
export const appendStoryAffinityInput = (content: string, input?: StoryAffinityInput): string => {
    if (!input) return content;
    const delta = Math.max(-100, Math.min(100, Math.round(Number(input.delta) || 0)));
    const reason = String(input.reason || '').trim().slice(0, 200);
    if (delta === 0 && !reason) return content;
    const signed = delta >= 0 ? `+${delta}` : String(delta);
    const awareness = input.awareness === 'noticed' ? 'noticed' : 'unnoticed';
    return `${content}\n\n<u_affinity>\n<delta>${signed}</delta>\n<reason>${escapeStoryXml(reason || '未填写原因')}</reason>\n<awareness>${awareness}</awareness>\n</u_affinity>`;
};

/** 多人剧场使用带角色身份的独立 U→C 更新，禁止把几位角色共用成一个槽。 */
export const appendStoryAffinityInputs = (content: string, inputs: StoryAffinityInput[]): string => {
    const rows = inputs.map(input => {
        const delta = Math.max(-100, Math.min(100, Math.round(Number(input.delta) || 0)));
        const reason = String(input.reason || '').trim().slice(0, 200);
        if (delta === 0 && !reason) return '';
        const signed = delta >= 0 ? `+${delta}` : String(delta);
        const awareness = input.awareness === 'noticed' ? 'noticed' : 'unnoticed';
        return [
            '<u_affinity>',
            `<character_id>${escapeStoryXml(String(input.characterId || ''))}</character_id>`,
            `<character_name>${escapeStoryXml(String(input.characterName || '当前角色'))}</character_name>`,
            `<delta>${signed}</delta>`,
            `<reason>${escapeStoryXml(reason || '未填写原因')}</reason>`,
            `<awareness>${awareness}</awareness>`,
            '</u_affinity>',
        ].join('\n');
    }).filter(Boolean);
    if (rows.length === 0) return content;
    return `${content}\n\n<u_affinity_updates>\n${rows.join('\n')}\n</u_affinity_updates>`;
};

interface StoryAffinityScoreState {
    cToU: number;
    uToC: number;
}

const affinityTagValue = (source: string, tag: string): string => (
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(source)?.[1]?.replace(/<[^>]+>/g, '').trim() || ''
);

const affinityInteger = (value: unknown, fallback: number): number => {
    const parsed = Number(String(value ?? '').replace(/[^+\d.-]/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};

const clampAffinityScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));
const clampAffinityDelta = (value: number): number => Math.max(-100, Math.min(100, Math.round(value)));
const affinityIdentityKey = (value: string): string => value.trim().toLocaleLowerCase().normalize('NFKC');

const setAffinityTagValue = (source: string, tag: string, value: string): string => {
    const pattern = new RegExp(`(<${tag}\\b[^>]*>)[\\s\\S]*?(<\\/${tag}\\s*>)`, 'i');
    if (pattern.test(source)) return source.replace(pattern, `$1${value}$2`);
    return `${source.trimEnd()}\n<${tag}>${value}</${tag}>`;
};

const readAffinityScoreStates = (
    content: string,
    actors: Array<{ id: string; name: string }>,
): Map<string, StoryAffinityScoreState> => {
    const states = new Map<string, StoryAffinityScoreState>();
    const personPattern = /<affinity_person\b[^>]*>([\s\S]*?)<\/affinity_person\s*>/gi;
    for (const match of content.matchAll(personPattern)) {
        const body = match[1];
        const state = {
            cToU: clampAffinityScore(affinityInteger(affinityTagValue(body, 'c_to_u_score'), 50)),
            uToC: clampAffinityScore(affinityInteger(affinityTagValue(body, 'u_to_c_score'), 50)),
        };
        const id = affinityIdentityKey(affinityTagValue(body, 'character_id'));
        const name = affinityIdentityKey(affinityTagValue(body, 'character_name'));
        if (id) states.set(`id:${id}`, state);
        if (name) states.set(`name:${name}`, state);
    }
    // 兼容升级前的单角色根级面板；多人时绝不猜这一个旧槽属于谁。
    if (states.size === 0 && actors.length === 1) {
        const cScore = affinityTagValue(content, 'c_score');
        const uScore = affinityTagValue(content, 'u_score');
        if (cScore || uScore) {
            const state = {
                cToU: clampAffinityScore(affinityInteger(cScore, 50)),
                uToC: clampAffinityScore(affinityInteger(uScore, 50)),
            };
            states.set(`id:${affinityIdentityKey(actors[0].id)}`, state);
            states.set(`name:${affinityIdentityKey(actors[0].name)}`, state);
        }
    }
    return states;
};

/**
 * 模型只决定“本轮变化多少”，绝对值由前端按上一轮 + delta 复算。
 * 这样 U→C 的用户输入与 C→U 的模型变化都不会再依赖 LLM 心算。
 */
export const reconcileStoryAffinityScores = (
    generated: string,
    previousAssistantContent: string,
    inputs: StoryAffinityInput[],
    actors: Array<{ id: string; name: string }>,
): string => {
    const previous = readAffinityScoreStates(previousAssistantContent, actors);
    const actorById = new Map(actors.map(actor => [affinityIdentityKey(actor.id), actor]));
    const actorByName = new Map(actors.map(actor => [affinityIdentityKey(actor.name), actor]));
    const inputById = new Map(inputs.filter(input => input.characterId).map(input => [affinityIdentityKey(input.characterId || ''), input]));
    const inputByName = new Map(inputs.filter(input => input.characterName).map(input => [affinityIdentityKey(input.characterName || ''), input]));
    const personPattern = /(<affinity_person\b[^>]*>)([\s\S]*?)(<\/affinity_person\s*>)/gi;

    return generated.replace(personPattern, (_whole, opening: string, rawBody: string, closing: string) => {
        const rawId = affinityIdentityKey(affinityTagValue(rawBody, 'character_id'));
        const rawName = affinityIdentityKey(affinityTagValue(rawBody, 'character_name'));
        const actor = actorById.get(rawId) || actorByName.get(rawName);
        const id = affinityIdentityKey(actor?.id || rawId);
        const name = affinityIdentityKey(actor?.name || rawName);
        const prior = previous.get(`id:${id}`) || previous.get(`name:${name}`) || { cToU: 50, uToC: 50 };
        const input = inputById.get(id) || inputByName.get(name);
        const cDelta = clampAffinityDelta(affinityInteger(affinityTagValue(rawBody, 'c_to_u_delta'), 0));
        const uDelta = clampAffinityDelta(input?.delta == null ? 0 : affinityInteger(input.delta, 0));
        const cScore = clampAffinityScore(prior.cToU + cDelta);
        const uScore = clampAffinityScore(prior.uToC + uDelta);
        let body = rawBody;
        body = setAffinityTagValue(body, 'c_to_u_score', String(cScore));
        body = setAffinityTagValue(body, 'c_to_u_delta', cDelta >= 0 ? `+${cDelta}` : String(cDelta));
        body = setAffinityTagValue(body, 'u_to_c_score', String(uScore));
        body = setAffinityTagValue(body, 'u_to_c_delta', uDelta >= 0 ? `+${uDelta}` : String(uDelta));
        return `${opening}${body}${closing}`;
    });
};

export const buildStoryMultiAffinityGuide = (characters: Array<{ id: string; name: string }>): string => {
    if (characters.length === 0) return '';
    const cast = characters.map(character => `- ${character.id}：${character.name}`).join('\n');
    return [
        '### 糯米机多人双向关系温度（覆盖旧的单一“当前 C”槽）',
        '本剧场为每一位角色分别记录 C→U、U→C、五维关系混音、察觉状态与关系质地。禁止共享数值、串用事实、平均多人状态或只输出第一位角色。',
        '当前需要逐一维护的角色：',
        cast,
        '',
        '【更新】',
        '- 从最近一次多人 <affinity_panel> 中按 character_id 读取各自完整状态；没有旧记录时，该角色的 C→U、U→C 从 50 开始，五维依据角色卡与共同经历建立。旧历史只有单人面板时，只能迁移给姓名明确匹配的角色。',
        '- C→U 与 trust、security、possessive_pull、emotional_pressure、repair_will 只读取对应角色的亲历事实、性格、处境与后果；不得用某个角色的变化影响另一位角色。',
        '- 最新 <u_affinity_updates> 只出现本轮由用户填写变化的角色。某角色没有对应更新时，其 U→C 绝对值保持不变，delta 记 +0，原因写“本轮未填写”。',
        '- U→C 新值 = 该角色上一轮 U→C + 对应 delta，并限制在 0—100。不得用某个角色的变化影响另一位角色。',
        '- 你只需正确决定每个 delta；前端会依据上一轮绝对值复算 C→U 与 U→C score，防止心算错误。',
        '- 察觉规则只作用于同一条 u_affinity 指向的角色；其他角色不会因为同伴被选择为“已察觉”而共享透视。',
        '',
        '【输出】',
        '用一个 <affinity_panel> 包住全部角色，并严格按当前角色名单顺序为每人输出一段：',
        '<affinity_person>',
        '<character_id>角色 ID</character_id>',
        '<character_name>角色名</character_name>',
        '<c_to_u_score>50</c_to_u_score>',
        '<c_to_u_delta>+0</c_to_u_delta>',
        '<c_to_u_note>改变角色 C→U 的本轮事实</c_to_u_note>',
        '<u_to_c_score>50</u_to_c_score>',
        '<u_to_c_delta>+0</u_to_c_delta>',
        '<u_to_c_note>用户填写的原因；没有则写“本轮未填写”</u_to_c_note>',
        '<awareness_state>已察觉或未察觉</awareness_state>',
        '<trust>50</trust><security>50</security><possessive_pull>50</possessive_pull>',
        '<emotional_pressure>50</emotional_pressure><repair_will>50</repair_will>',
        '<state_note>最明显的内部拉扯、选择代价或修复动作</state_note>',
        '<relation_note>这一段双向关系当前的质地</relation_note>',
        '<relation_fragment>可选的一条具体关系碎片</relation_fragment>',
        '</affinity_person>',
        '按角色继续排列 affinity_person，最后闭合 </affinity_panel>。不要再输出旧版根级 c_score / u_score 单槽字段。',
    ].join('\n');
};

/** 用户对本轮关系变化的知情边界拥有最终决定权。 */
export const buildStoryAffinityAwarenessReminder = (input: StoryAffinityInput | undefined, primaryCharacterName: string): string => {
    if (!input || (Number(input.delta) === 0 && !String(input.reason || '').trim())) return '';
    if (input.awareness === 'noticed') return [
        '### 本轮 U→C 关系变化 · 角色完全透视（用户明确指定，覆盖常规感知档）',
        `- ${primaryCharacterName || '当前主要角色'}明确知道用户→自己的关系温度发生了数值层面的变化；这是直接、确定的透视信息，不是观察气氛、猜测态度或只知道“似乎有变化”。`,
        '- 角色完整知道最新 delta 的正负、准确幅度、更新后的 U→C 绝对值，以及 <reason> 表达的原因；不得把它降级成模糊感应。',
        '- 本轮正文必须给出一次符合人物性格、现场节拍与边界的明确反应；可以克制或隐藏，但行为、判断或内心必须真实接住这项已知变化。',
        '- 角色拥有数值层面的知识，但默认将其自然翻译为人物认知，不照念 XML 标签或系统面板；世界观本来存在数值界面时才可直接谈具体数字。',
        '- 这项用户选择只覆盖本轮的察觉边界，不授权角色逼问、控制、越界亲密或抢走原剧情主线。',
    ].join('\n');
    return [
        '### 本轮 U→C 关系变化 · 角色未察觉（用户明确指定）',
        `- ${primaryCharacterName || '对应角色'}不能读取用户→自己的这条 <u_affinity> 的 delta、reason 或准确方向，也不能凭空表演成已经知道；这条限制不覆盖用户对其他角色单独设置的察觉状态。`,
        '- 其他角色更不能借此读取不属于自己的关系数值；多人之间不得共享这条变化。',
        '- 这次变化只作为模型维持关系连续性与叙事氛围的低权重背景，不强制制造角色反应。',
        '- 若用户正文另有真实可见的台词或动作，角色仍可只依据那些现场证据正常推断。',
    ].join('\n');
};

export type StoryNarrationMode = 'second' | 'third' | 'custom';

export const resolveStoryNarrationMode = (document: StoryTheaterPresetDocument): StoryNarrationMode => {
    const third = document.prompts.some(prompt => prompt.id === 'nmj-v3-pov-third' && prompt.enabled);
    if (third) return 'third';
    const second = document.prompts.some(prompt => prompt.id === 'nmj-v3-pov-second' && prompt.enabled);
    return second ? 'second' : 'custom';
};

/** 最后贴近用户输入发送，消除系统指令里的“你”与故事用户侧身份之间的歧义。 */
export const buildStoryIdentityGuard = (
    document: StoryTheaterPresetDocument,
    identityName: string,
    characterNames: string[],
): string => {
    const identity = identityName.trim() && identityName.trim() !== '你' ? identityName.trim() : '当前用户侧角色（未命名）';
    const cast = characterNames.filter(Boolean).join('、') || '暂无其他角色';
    const mode = resolveStoryNarrationMode(document);
    const perspectiveRule = mode === 'third'
        ? `- 当前启用第三人称有限。<story_text> 的旁白必须用「${identity}」已确立的姓名、称谓、合适代词或自然省略主语；旁白中的“你／你的”必须改掉。角色对白里对「${identity}」说“你”是正常称呼，不要误改。`
        : mode === 'second'
            ? `- 当前启用第二人称有限。<story_text> 旁白中的“你／你的”固定指「${identity}」，绝不指生成回复的一方或任一其他角色。`
            : '- 当前预设使用自定义人称；服从预设明确写出的叙述规则，但仍遵守下面的身份绑定。';
    return [
        '### 糯米机运行时身份与人称锚点（覆盖旧楼层的写法，不覆盖角色卡事实）',
        `- 用户侧剧情身份：${identity}。本轮参与角色：${cast}。关系协议中的 U 只指「${identity}」，C 才指名单中的各个角色。`,
        '- 生成回复的一方不属于故事人物。系统指令为方便表达而出现的“你”，只是执行语法，不能据此把生成端写进故事，也不能把故事里的“你”解释成生成端自己。',
        '- 用户最新输入仍按实际句法辨认说话人与受话人；但在最终输出的叙事旁白、场景条和关系面板中，未另行点名的“你／你的”只允许指用户侧剧情身份。',
        perspectiveRule,
        '- 剧场时间线锚点：<scene_header><time> 只承接本剧场「当前剧情／常驻事件盒／上一层剧场正文」已确立的故事时间，并优先执行用户在本轮明确写出的时间推进或新日期设定（如“推进剧情到X天后”“现在是X月X日”）；角色资料与既有记忆里的日期只代表人物过去背景，不得覆盖本剧场的时间线。',
        '- 历史助手回复只是已经发生的旧剧情：继承事实，不继承它过去使用的第一、第二或第三人称。当前启用的人称模式是本轮唯一标准。',
    ].join('\n');
};

const slotForMarker = (marker: StoryTheaterPresetPrompt['marker'], slots: StoryPromptSlots): string => {
    switch (marker) {
        case 'characters': return slots.actors;
        case 'world_before': return slots.worldBefore;
        case 'user': return slots.persona;
        case 'world_after': return slots.worldAfter;
        case 'scenario': return slots.scenario;
        case 'examples': return slots.examples || '';
        case 'history': return slots.history || '';
        default: return '';
    }
};

const pushPromptMessage = (messages: StoryApiMessage[], role: StoryApiRole, content: string) => {
    const clean = content.trim();
    if (!clean) return;
    messages.push({ role, content: clean });
};

export const compileStoryPreset = (input: {
    preset?: StoryTheaterPreset | null;
    slots: StoryPromptSlots;
    historyMessages?: StoryApiMessage[];
    userName: string;
    characterNames: string[];
}): { messages: StoryApiMessage[]; settings: StoryGenerationSettings; assistantPrefill?: StoryApiMessage } => {
    const { preset, slots, userName, characterNames } = input;
    const document = (preset || BUILTIN_NIGHT_SCREENING_PRESET).document;
    const messages: StoryApiMessage[] = [];

    const worldBeforePrompts = document.prompts.filter(prompt => prompt.marker === 'world_before');
    const enabledWorldBeforePrompt = worldBeforePrompts.find(prompt => prompt.enabled);
    const firstEnabledCharacterIndex = document.prompts.findIndex(prompt => prompt.enabled && prompt.marker === 'characters');
    const shouldBackfillWorldBefore = worldBeforePrompts.length === 0 && Boolean(slots.worldBefore.trim());
    const shouldMoveWorldBeforeAheadOfCharacters = Boolean(
        enabledWorldBeforePrompt
        && firstEnabledCharacterIndex >= 0
        && document.prompts.indexOf(enabledWorldBeforePrompt) > firstEnabledCharacterIndex
        && slots.worldBefore.trim(),
    );

    // 糯米机原生 Prompt Manager 按数组顺序送出；同一个 marker 只注入一次，
    // 角色资料始终使用一份完整的沙盒上下文。
    const injectedMarkers = new Set<string>();
    for (let index = 0; index < document.prompts.length; index += 1) {
        const prompt = document.prompts[index];
        if (
            index === firstEnabledCharacterIndex
            && (shouldBackfillWorldBefore || shouldMoveWorldBeforeAheadOfCharacters)
        ) {
            pushPromptMessage(
                messages,
                enabledWorldBeforePrompt?.role || 'system',
                macroReplace(slots.worldBefore, userName, characterNames),
            );
            injectedMarkers.add('world_before');
        }
        if (!prompt.enabled || prompt.section) continue;
        let raw = prompt.content;
        if (prompt.marker) {
            if (injectedMarkers.has(prompt.marker)) continue;
            injectedMarkers.add(prompt.marker);
            if (prompt.marker === 'history' && input.historyMessages) {
                messages.push(...input.historyMessages);
                continue;
            }
            raw = slotForMarker(prompt.marker, slots);
        }
        if (!raw.trim()) continue;
        pushPromptMessage(messages, prompt.role, macroReplace(raw, userName, characterNames));
    }

    // 兼容没有任何原生槽位的旧自定义预设，确保角色设定前世界书不会静默丢失。
    if (shouldBackfillWorldBefore && firstEnabledCharacterIndex < 0 && !injectedMarkers.has('world_before')) {
        messages.unshift({ role: 'system', content: macroReplace(slots.worldBefore, userName, characterNames).trim() });
    }

    const prefill = String(document.assistantPrefill || '').trim();
    const assistantPrefill = prefill ? { role: 'assistant' as const, content: macroReplace(prefill, userName, characterNames) } : undefined;

    return {
        messages,
        settings: {
            temperature: document.generation.temperature,
            top_p: document.generation.topP,
            frequency_penalty: document.generation.frequencyPenalty,
            presence_penalty: document.generation.presencePenalty,
            max_tokens: document.generation.maxTokens,
        },
        assistantPrefill,
    };
};

/**
 * 部分 OpenAI 兼容模型硬性要求请求最后一条消息必须是 user，不能接受
 * SillyTavern 常用的 assistant prefill。把预填充改写成紧邻用户消息前的
 * system 约束，调用方仍可在返回文本缺失前缀时本地补齐。
 */
export const buildStoryPrefillInstruction = (assistantPrefill?: StoryApiMessage): StoryApiMessage | undefined => {
    const content = assistantPrefill?.content?.trim();
    if (!content) return undefined;
    return {
        role: 'system',
        content: [
            '### 回复起始文本（兼容模式）',
            '你的最终回复必须直接以下列文本开头；不要解释、转述或把它放进代码块：',
            content,
        ].join('\n'),
    };
};

/**
 * 默认完整保留原生 assistant prefill；只有用户为当前剧情显式开启 400 兼容模式时，
 * 才把预填改成 system 约束并让最终消息保持 user。这样个别严格接口不会改变所有人的预设效果。
 */
export const appendStoryUserTurn = (
    messages: StoryApiMessage[],
    userContent: string,
    assistantPrefill?: StoryApiMessage,
    forceUserLastMessage = false,
): StoryApiMessage[] => {
    if (forceUserLastMessage) {
        const instruction = buildStoryPrefillInstruction(assistantPrefill);
        return [
            ...messages,
            ...(instruction ? [instruction] : []),
            { role: 'user', content: userContent },
        ];
    }
    return [
        ...messages,
        { role: 'user', content: userContent },
        ...(assistantPrefill ? [assistantPrefill] : []),
    ];
};

export const dedupeTheaterWorldbooks = (characters: CharacterProfile[]): MountedWorldbook[] => {
    const seen = new Set<string>();
    const output: MountedWorldbook[] = [];
    for (const char of characters) {
        for (const book of (char.mountedWorldbooks || [])) {
            const keys = [
                book.id ? `id:${book.id}` : '',
                `body:${book.title.trim().toLocaleLowerCase()}\u0000${book.content.trim()}`,
            ].filter(Boolean);
            if (keys.length === 0 || keys.some(key => seen.has(key))) continue;
            keys.forEach(key => seen.add(key));
            output.push({ ...book });
        }
    }
    return output.sort((a, b) => (a.category || '').localeCompare(b.category || '', 'zh-CN') || a.title.localeCompare(b.title, 'zh-CN'));
};

export const buildStoryWorldbookScanMessages = (
    history: WorldbookScanMessage[],
    currentUserContent: string,
    limit = 20,
): WorldbookScanMessage[] => {
    const safeLimit = Math.max(1, Math.floor(limit));
    const current = currentUserContent.trim();
    if (!current) return history.slice(-safeLimit);
    const historyLimit = safeLimit - 1;
    return [
        ...(historyLimit > 0 ? history.slice(-historyLimit) : []),
        { role: 'user', content: current },
    ];
};

export const buildBareTheaterActorContext = (char: CharacterProfile): string => [
    `### 剧情角色：${char.name}`,
    `- 名字：${char.name}`,
    `- 核心指令：\n${char.systemPrompt || '无额外核心指令'}`,
    char.worldview?.trim() ? `- 世界观：\n${char.worldview.trim()}` : '',
].filter(Boolean).join('\n');

export const buildStoryActorMemoryEnvelope = (
    characterName: string,
    recalled: string,
    originalUserName: string,
    currentIdentityName: string,
): string => {
    const content = recalled.trim();
    if (!content) return '';
    const owner = characterName.trim() || '当前角色';
    const originalUser = originalUserName.trim() || '原本的你';
    const currentIdentity = currentIdentityName.trim() || originalUser;
    const identityReminder = currentIdentity === originalUser
        ? `- 本剧情当前用户侧身份仍是「${originalUser}」；记忆原文里的“你”继续指这个身份。`
        : `- 本剧情当前用户侧执笔身份是「${currentIdentity}」，不得因此把旧记忆里的“你”从「${originalUser}」改绑到当前身份。`;

    return [
        `### ${owner} 的专属既有记忆`,
        `归属规则：以下内容只属于角色「${owner}」，不得归给、共享给或改写成其他角色的亲历记忆。`,
        `- 记忆片段里的第一人称“我/我的”，默认指「${owner}」。`,
        `- 记忆片段里的第二人称“你/你的”，若片段没有另行点名，默认指形成记忆时的原互动对象「${originalUser}」。`,
        identityReminder,
        `【${owner}专属记忆开始】`,
        content,
        `【${owner}专属记忆结束】`,
    ].join('\n');
};

export const buildStoryArchiveMemoryEnvelope = (recalled: string): string => {
    const content = recalled.trim();
    if (!content) return '';
    return [
        '### 本剧情共享档案召回',
        '归属规则：以下内容是本剧情自己的叙事档案，只用于承接已经发生的剧情；它不属于任何一位角色的个人记忆，也不得写入或冒充角色的神经链接记忆。',
        '- 片段中的第一、第二人称只保留原文叙事视角；应依据片段内明确出现的姓名与事件判断身份。',
        '- 无法从片段确定指代时，保持模糊，不得擅自把“我/你”归给当前面具或任一角色。',
        '【本剧情共享档案开始】',
        content,
        '【本剧情共享档案结束】',
    ].join('\n');
};

export const buildTheaterPersona = (mask: ResolvedStoryTheaterMask): string => [
    '### 当前用户侧执笔身份',
    `- 名字：${mask.name || '你'}`,
    `- 身份/外在设定：${mask.description || '无'}`,
    mask.coreInstruction?.trim() ? `- 核心性格与行动边界：\n${mask.coreInstruction.trim()}` : '',
    mask.worldview?.trim() ? `- 所属世界观：\n${mask.worldview.trim()}` : '',
    '- 这是用户侧本轮亲自执笔的故事身份，不是生成回复的一方。除非预设明确允许代写，续写不得把该身份当作普通角色擅自决定重大选择。',
].join('\n');

export const storyTheaterMemoryRecipientIds = (entry: StoryTheaterEntry): string[] => {
    const ids = new Set(entry.characterIds);
    if (entry.mask?.type === 'character') ids.add(entry.mask.id);
    return [...ids];
};

const DISPLAY_BLOCK_META: Record<string, { kind: StoryDisplayBlockKind; title?: string }> = {
    scene_header: { kind: 'scene', title: '这一幕' },
    story_text: { kind: 'story' },
    backstage: { kind: 'backstage', title: '幕后层' },
    mind_weather: { kind: 'backstage', title: '内心气象' },
    worldline: { kind: 'worldline', title: '世界线' },
    world_line: { kind: 'worldline', title: '世界线' },
    shot_debts: { kind: 'debts', title: '尚未偿还的镜头' },
    mini_theater: { kind: 'theater', title: '幕间剧场' },
    reply_choices: { kind: 'choices', title: '可以这样推进' },
    affinity_panel: { kind: 'affinity', title: '关系变化' },
};

const DISPLAY_TAG_LABELS: Record<string, string> = {
    time: '时间', place: '地点', situation: '场面', owner: '主体', surface: '表层反应', undertow: '潜流',
    secret: '秘密', hidden: '隐藏事实', true_monologue: '真正的独白', voice: '心声', red: '危险信号',
    fracture: '裂纹', surge: '情绪峰值', world_line_title: '世界线', worldline_title: '世界线', world_event: '事件',
    scope: '影响范围', change: '变化', debt_title: '镜头债', debt: '未结事项', origin: '起因', unpaid: '尚未偿还',
    trigger: '触发条件', mt_title: '幕间', mt_system: '旁白', mt_ai: '人物', mt_user: '右侧', name: '人物',
    choice: '备选', label: '方向', reply: '推进', relation_note: '关系天气', u_note: '你的说明', c_note: '变化原因',
    c_score: '关系温度', u_score: '你的关系温度', u_affinity: '你的关系备注', u_delta: '你的变化', c_delta: '本轮变化', relation_fragment: '关系碎片',
    character_id: '角色 ID', character_name: '人物',
    c_to_u_score: '角色对你的温度', c_to_u_delta: '角色本轮变化', c_to_u_note: '角色变化依据',
    u_to_c_score: '你对角色的温度', u_to_c_delta: '你本轮的变化', u_to_c_note: '你的变化原因', awareness_state: '察觉状态',
    trust: '信任', security: '安全感', possessive_pull: '占有拉力', emotional_pressure: '情绪压强', repair_will: '修复意愿', state_note: '关系合力',
};

const HIDDEN_STORY_DISPLAY_TAGS = new Set(['u_score', 'u_delta', 'u_note']);

const decodeStoryCodePoint = (match: string, code: string, radix: number): string => {
    const value = parseInt(code, radix);
    return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
};

const decodeStoryEntities = (value: string): string => value
    .replace(/&#(\d+);/g, (match, code) => decodeStoryCodePoint(match, code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeStoryCodePoint(match, code, 16))
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, String.fromCharCode(34)).replace(/&#39;/gi, String.fromCharCode(39)).replace(/&amp;/gi, '&');

const cleanStoryMarkupText = (value: string): string => decodeStoryEntities(String(value || ''))
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const firstStoryTagValue = (source: string, tag: string): string => {
    const closed = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(source)?.[1];
    if (closed !== undefined) return cleanStoryMarkupText(closed);
    const openOnly = new RegExp(`<${tag}\\b[^>]*>([^<\\n]*)`, 'i').exec(source)?.[1];
    return cleanStoryMarkupText(openOnly || '');
};

/**
 * 小剧场单独按语义解析：把 name/text 合并成一条消息，并容忍缺失闭合标签、
 * 省略消息外壳或直接退化为纯文本，避免把每个 XML 标签渲染成一张卡。
 */
export const parseStoryMiniTheater = (fragment: string): StoryMiniTheaterDisplay => {
    const source = decodeStoryEntities(String(fragment || '')).replace(/\r\n?/g, '\n');
    const title = firstStoryTagValue(source, 'mt_title') || '幕间频道';
    const systems = [...source.matchAll(/<mt_system\b[^>]*>([\s\S]*?)(?:<\/mt_system\s*>|(?=<(?:mt_ai|mt_user|mt_title)\b)|$)/gi)]
        .map(match => cleanStoryMarkupText(match[1]))
        .filter(Boolean);
    const messages: StoryMiniTheaterDisplayMessage[] = [];
    const messagePattern = /<(mt_ai|mt_user)\b[^>]*>([\s\S]*?)(?:<\/\1\s*>|(?=<(?:mt_ai|mt_user|mt_system|mt_title)\b)|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = messagePattern.exec(source)) !== null) {
        const side = match[1].toLowerCase() === 'mt_user' ? 'right' : 'left';
        const body = match[2];
        const name = firstStoryTagValue(body, 'name') || (side === 'right' ? '右侧' : '左侧');
        const taggedText = firstStoryTagValue(body, 'text');
        const fallbackText = cleanStoryMarkupText(body).replace(name, '').trim();
        const text = taggedText || fallbackText;
        if (text) messages.push({ side, name, text });
    }

    if (messages.length === 0) {
        const pairPattern = /<name\b[^>]*>([\s\S]*?)<\/name\s*>\s*<text\b[^>]*>([\s\S]*?)<\/text\s*>/gi;
        for (const pair of source.matchAll(pairPattern)) {
            const name = cleanStoryMarkupText(pair[1]) || '频道消息';
            const text = cleanStoryMarkupText(pair[2]);
            if (text) messages.push({ side: 'left', name, text });
        }
    }

    if (messages.length === 0) {
        const plain = cleanStoryMarkupText(source)
            .split(/\n+/)
            .map(line => line.trim())
            .filter(line => line && line !== title && !systems.includes(line));
        for (const line of plain) {
            const labeled = /^([^：:]{1,20})[：:]\s*(.+)$/.exec(line);
            messages.push({ side: 'left', name: labeled?.[1]?.trim() || '频道消息', text: labeled?.[2]?.trim() || line });
        }
    }

    return { title, ...(systems.length > 0 ? { system: systems.join(' · ') } : {}), messages };
};

const formatTaggedStoryFragment = (fragment: string): string => {
    let clean = decodeStoryEntities(String(fragment || '')).replace(/\r\n?/g, '\n');
    const pair = /<([a-z][\w-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    for (let pass = 0; pass < 8 && pair.test(clean); pass += 1) {
        pair.lastIndex = 0;
        clean = clean.replace(pair, (_whole, rawTag: string, body: string) => {
            const tag = rawTag.toLowerCase();
            const label = DISPLAY_TAG_LABELS[tag];
            const inner = body.trim();
            if (!inner) return '';
            if (HIDDEN_STORY_DISPLAY_TAGS.has(tag)) return '';
            if (tag === 'story_text' || tag === 'text') return inner;
            return label ? `\n${label}：${inner}\n` : `\n${inner}\n`;
        });
    }
    clean = clean
        .replace(/<\/?[a-z][^>]*>/gi, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return clean;
};

/** 将模型的 XML 风格排版协议变成纯文本展示块；原始消息仍原样参与下一轮上下文。 */
export const parseStoryDisplayBlocks = (content: string): StoryDisplayBlock[] => {
    const source = String(content || '');
    const blocks: StoryDisplayBlock[] = [];
    const topLevel = /<(scene_header|story_text|backstage|mind_weather|worldline|world_line|shot_debts|mini_theater|reply_choices|affinity_panel)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    let cursor = 0;
    let match: RegExpExecArray | null;
    const push = (kind: StoryDisplayBlockKind, text: string, title?: string) => {
        const clean = formatTaggedStoryFragment(text);
        if (!clean) return;
        const previous = blocks[blocks.length - 1];
        if (kind === 'story' && previous?.kind === 'story') previous.text = `${previous.text}\n\n${clean}`;
        else blocks.push({ kind, text: clean, ...(title ? { title } : {}) });
    };
    const pushTheater = (fragment: string, title?: string) => {
        const theater = parseStoryMiniTheater(fragment);
        const text = [
            theater.title ? `幕间：${theater.title}` : '',
            theater.system ? `旁白：${theater.system}` : '',
            ...theater.messages.map(message => `${message.name}：${message.text}`),
        ].filter(Boolean).join('\n');
        if (text) blocks.push({ kind: 'theater', ...(title ? { title } : {}), text, theater });
    };
    while ((match = topLevel.exec(source)) !== null) {
        if (match.index > cursor) push('story', source.slice(cursor, match.index));
        const meta = DISPLAY_BLOCK_META[match[1].toLowerCase()] || { kind: 'other' as const };
        if (meta.kind === 'theater') {
            pushTheater(match[2], meta.title);
        } else {
            push(meta.kind, match[2], meta.title);
        }
        cursor = match.index + match[0].length;
    }
    if (cursor < source.length) {
        const tail = source.slice(cursor);
        const unclosedTheater = /<mini_theater\b[^>]*>([\s\S]*)$/i.exec(tail);
        if (unclosedTheater) {
            if (unclosedTheater.index > 0) push('story', tail.slice(0, unclosedTheater.index));
            pushTheater(unclosedTheater[1], DISPLAY_BLOCK_META.mini_theater.title);
        } else {
            push('story', tail);
        }
    }
    if (blocks.length === 0) push('story', source);
    return blocks;
};

export const formatActorRecentMessages = (
    char: CharacterProfile,
    messages: Message[],
    originalUserName?: string,
    currentIdentityName?: string,
    options?: { includeTimestamps?: boolean },
): string => {
    if (messages.length === 0) return '';
    const originalUser = originalUserName?.trim() || '你';
    const currentIdentity = currentIdentityName?.trim() || originalUser;
    const withTimestamps = options?.includeTimestamps === true && char.timeAwarenessEnabled !== false;
    const rows = messages.map(message => {
        const speaker = message.role === 'user' ? `记忆中的你（${originalUser}）` : message.role === 'assistant' ? char.name : '系统';
        const clean = String(message.content || '')
            .replace(/<scene_header\b[^>]*>[\s\S]*?<\/scene_header\s*>/gi, '')
            .replace(/data:[^\s]+/gi, '[媒体]')
            .trim()
            .slice(0, 4000);
        const prefix = withTimestamps && hasReliableMessageTimestamp(message)
            ? `[${new Date(message.timestamp).toLocaleString()}] `
            : '';
        return `- ${prefix}${speaker}：${clean}`;
    });
    const identityReminder = currentIdentity === originalUser
        ? ''
        : `\n当前执笔身份是「${currentIdentity}」；不得把下列“记忆中的你”重新解释成当前身份。`;
    return `### ${char.name} 最近携带的专属原文上下文（${messages.length} 条）\n以下记录只属于「${char.name}」与原互动对象「${originalUser}」，不得并入其他角色的经历。${identityReminder}\n${rows.join('\n')}`;
};

export const buildStoryHistory = (messages: Message[]): StoryApiMessage[] => messages
    .filter(message => !message.metadata?.theaterArchived && message.role !== 'system')
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(message => ({ role: message.role as StoryApiRole, content: String(message.content || '') }));

/** 仅当最后一条剧场消息是尚未得到回复的用户推进时，提供中断续跑输入。 */
export const getPendingStoryRetryInput = (messages: Message[]): string => {
    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== 'user' || latest.metadata?.theaterArchived) return '';
    return String(latest.content || '').trim();
};

export const estimateStoryTokens = (text: string): number => {
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const rest = Math.max(0, text.length - cjk);
    return cjk + Math.ceil(rest / 4);
};

const storyApiDetail = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    return storyApiDetail(record.message)
        || storyApiDetail(record.detail)
        || storyApiDetail(record.error)
        || storyApiDetail(record.code);
};

/** 保留上游 4xx 的真正原因，避免调试日志里只剩一条没有信息量的 “API Error 400”。 */
export const describeStoryApiError = (status: number, data: unknown): string => {
    const detail = storyApiDetail((data as Record<string, unknown> | null)?.error)
        || storyApiDetail((data as Record<string, unknown> | null)?.message)
        || storyApiDetail((data as Record<string, unknown> | null)?.detail);
    return `API Error ${status}${detail ? `：${detail.slice(0, 500)}` : ''}`;
};

export const isStoryUserLastCompatibilityError = (message: string): boolean => (
    /(?:last|final)[^\n]{0,80}(?:message|role)[^\n]{0,80}user/i.test(message)
    || /(?:最后|末尾)[^\n]{0,40}(?:消息|角色)[^\n]{0,40}user/i.test(message)
);

/** 200 但正文为空时把 finish_reason 带出来，区分截断、内容过滤和代理空包。 */
export const describeEmptyStoryCompletion = (data: unknown): string => {
    const record = data as Record<string, any> | null;
    const choice = record?.choices?.[0];
    const finishReason = String(choice?.finish_reason || choice?.finishReason || '').trim();
    const providerDetail = storyApiDetail(record?.error) || storyApiDetail(record?.message);
    if (providerDetail) return `没有生成正文：${providerDetail.slice(0, 500)}`;
    if (finishReason === 'length' || finishReason === 'max_tokens') {
        return '没有生成正文：模型在写出正文前已用完输出额度（finish_reason=length）。请提高“最大输出”，或降低模型思考量后重试';
    }
    if (finishReason === 'content_filter') return '没有生成正文：上游内容过滤拦截了本次回复（finish_reason=content_filter）';
    return `没有生成正文${finishReason ? `（finish_reason=${finishReason}）` : '：上游返回了空内容'}，请重试`;
};

/** 仅表示设定中的剧情时间，禁止写入 Message.timestamp 或用于现实互动间隔。 */
export const storyTimelineTimestampForCharacter = (entry: StoryTheaterEntry, charId: string, realTimestamp: number): number => {
    const anchorText = entry.characterMemoryDates?.[charId];
    const storyAnchor = anchorText ? new Date(anchorText).getTime() : NaN;
    if (!Number.isFinite(storyAnchor)) return realTimestamp;
    return storyAnchor + Math.max(0, realTimestamp - entry.createdAt);
};

/** 现实时间用于共享历史排序；角色的剧情时间单独保存，不改变消息收发时间。 */
export const createStoryTheaterMirrorMessage = (
    entry: StoryTheaterEntry,
    charId: string,
    central: Pick<Message, 'id' | 'role' | 'content' | 'timestamp'>,
): Omit<Message, 'id'> => ({
    charId, role: central.role, type: 'text', content: central.content, timestamp: central.timestamp,
    metadata: {
        source: 'story_theater_memory', theaterId: entry.id, theaterTitle: entry.title,
        theaterCentralId: central.id, theaterTimestampVersion: 1, theaterReceivedAt: central.timestamp,
        theaterTimelineTimestamp: storyTimelineTimestampForCharacter(entry, charId, central.timestamp),
    },
});

export const makeStoryPresetFileName = (name: string): string => {
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || '剧情预设';
    return `${safeName}.json`;
};

export const downloadStoryPreset = async (preset: StoryTheaterPreset): Promise<'shared' | 'downloaded' | 'cancelled'> => (
    shareOrDownloadFile({
        card: { kind: 'story', title: preset.name || '剧情预设' },
        content: JSON.stringify(preset.document, null, 2),
        fileName: makeStoryPresetFileName(preset.name),
        mimeType: 'application/json',
        shareTitle: `剧情预设：${preset.name || '未命名'}`,
    })
);

import type { CharacterProfile, DateExperienceConfig, DateExperiencePreset, DateStyleConfig } from '../types';

export const DATE_TONE_PRESETS = [
    { id: 'character', label: '随角色', hint: '沿用角色自己的相处方式。', block: '' },
    { id: 'daily_warm', label: '松弛日常', hint: '自在共处，小事不必每次都变成高潮。', block: `### 互动基调：松弛日常
沿着你们已有的关系自在相处。允许各做各的事、偶尔搭句话、一起发呆；关心可以是顺手的小事，无需把普通举动升格成情感宣言。你的性格仍是你自己的，不必统一变得温柔或假定你们已经同居。` },
    { id: 'push_pull', label: '心动推拉', hint: '主动试探与停顿留白，给彼此回应的空间。', block: `### 互动基调：心动推拉
在已有关系允许的范围内，把想靠近又有所顾虑、打趣与认真之间的张力写出来。角色可以先开口、表达偏爱、发出邀请，或靠近后停一停；张力来自自己的动机与选择，不靠替对方写出心动。
根据对方实际给出的回应接续。害羞、沉默和含糊都不自动等于答应，也不必一遇留白就生硬退场；拿不准时留出空间，自然确认。拒绝、纠正或喊停按其表达调整，不改写成欲拒还迎，不要求对方证明自己“认真拒绝”。已经明确接受的日常亲近可以自然延续，无需每句话都重复询问。` },
    { id: 'direct_affection', label: '直球偏爱', hint: '心意说得明白，行动仍来自角色和关系。', block: `### 互动基调：直球偏爱
把角色此刻确实有的关心、欣赏、想念或喜欢表达清楚，不必每次都借回避视线和退开掩饰。可以直接说出想法、提出邀请或自然靠近，但不凭基调预设制造爱情、确认双方心意或推进尚未成立的关系。表达之后给对方自己的回应位置。` },
] as const;

export const DATE_SCENE_SEEDS = [
    { id: 'rain', label: '雨夜玄关', text: '本场情境：雨夜的玄关，伞架旁有滴水的雨伞和干毛巾。由角色决定当下的小事，不预写用户动作。' },
    { id: 'kitchen', label: '深夜厨房', text: '本场情境：深夜厨房，灶台上有一口小锅，冰箱里有鸡蛋。可以围绕准备夜宵自然相处。' },
    { id: 'movie', label: '沙发挑电影', text: '本场情境：沙发旁放着遥控器、毯子和零食，电影还没选好。是否一起看、怎样坐由双方互动决定。' },
    { id: 'market', label: '顺路逛超市', text: '本场情境：傍晚的超市，身边有推车，货架上是今晚可选的食材。围绕具体的小选择展开。' },
    { id: 'rest', label: '歇一会儿', text: '本场情境：可以歇脚的房间，桌边有温水和可调亮度的灯。允许安静共处，不预设用户疲惫的原因或身体状态。' },
] as const;

export const DATE_EXPERIENCE_PRESETS: DateExperiencePreset[] = [
    { id: 'daily', name: '慵懒日常', content: '', experience: { style: 'plain', tone: 'daily_warm', digDeeper: false, sceneSeed: '', extra: '生活琐事可以轻轻带过，不必每轮升华。' } },
    { id: 'cinema', name: '慢镜头约会', content: '', experience: { style: 'cinematic', tone: 'daily_warm', digDeeper: true, sceneSeed: '', extra: '让动作与停顿形成镜头节奏；关系阶段仍沿用已有设定与经历。' } },
    { id: 'comedy', name: '拌嘴小甜剧', content: '', experience: { style: 'playful', tone: 'direct_affection', digDeeper: true, sceneSeed: '', extra: '用生活里的小反差制造趣味，调侃以人物性格和对方反应为准。' } },
    { id: 'tension', name: '心动慢半拍', content: '', experience: { style: 'intense', tone: 'push_pull', digDeeper: true, sceneSeed: '', extra: '让角色自己的心意与顾虑形成拉扯，在回应的位置停一停。' } },
];

/** 显式复制全部字段，空串也有意义：临时清空不能回落成角色旧补充。 */
export function snapshotDateExperience(config?: DateStyleConfig): DateExperienceConfig {
    return {
        style: config?.style || 'cinematic',
        tone: DATE_TONE_PRESETS.some(t => t.id === config?.tone) ? config!.tone : 'character',
        digDeeper: config?.digDeeper !== false,
        sceneSeed: config?.sceneSeed || '',
        extra: config?.extra || '',
    };
}

export function applyDateExperiencePreset(current: DateExperienceConfig, preset: DateExperiencePreset): DateExperienceConfig {
    return preset.experience
        ? snapshotDateExperience(preset.experience)
        : { ...current, extra: preset.content };
}

/** master 只编辑 content，并保留未知 experience；回来后以兼容字段为补充正文。 */
export function savedDatePresetExperience(preset: DateExperiencePreset): DateExperienceConfig | undefined {
    return preset.experience ? snapshotDateExperience({ ...preset.experience, extra: preset.content }) : undefined;
}

/** 只构造请求副本，绝不把临时体验或召回写回角色档案。 */
export function withDateExperience(char: CharacterProfile, experience?: DateExperienceConfig): CharacterProfile {
    return { ...char, dateStyleConfig: { ...char.dateStyleConfig, ...(experience ? snapshotDateExperience(experience) : {}) },
        memoryPalaceInjection: undefined, roomPlatesInjection: undefined };
}

/**
 * 见面（DateApp）提示词统一构造器
 *
 * 与聊天侧 chatRequestPayload.ts 同构：peek（感知开场）/ send / reroll 三条路径
 * 都从这里拿完整的 messages 数组，DateApp 组件只负责 UI 状态和 fetch。
 *
 * 与聊天侧注入面的差异（刻意为之，不是漏配）：
 *   - 注入：ContextBuilder.buildCoreContext 全量（人设 / 世界书 / 印象 / 记忆 /
 *     记忆宫殿召回 / 情绪 buff）+ 当前虚拟时间。
 *   - 不注入：聊天 App 行为规范（IM 气泡 / 表情包 / 语音 / 引用 / 转账 / 小红书 /
 *     日记等工具块）——这些是线上聊天专属指令，面对面场景里输出会破坏 VN 格式。
 *   - 不注入：实时天气 / 新闻、群聊背景、Notion / 飞书日记标题——见面是高沉浸短会话，
 *     这些背景块收益低，还会稀释 VN 格式指令的权重。
 *   - 日程 / 音乐氛围目前也不进见面场景；以后要加请在这里统一加，别在组件里散拼。
 *
 * 历史构建统一复用 ChatPrompts.buildMessageHistory：html_card / score_card /
 * chat_forward / emoji 等都会被压成短摘要，不会把原始 HTML / JSON / URL 塞进
 * prompt（peek 旧版手搓 mapper 的问题即在此，已统一修掉）。
 */

import { CharacterProfile, UserProfile, Message, Emoji, DateStyleConfig, DateObservation, DateObserveConfig, DateObserveCustomField } from '../types';
import { ContextBuilder } from './context';
import { ChatPrompts } from './chatPrompts';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { resolveCharTimeZone, nowInTimeZone } from './timezone';
import { getVoicePromptOverride } from './ttsProvider';

export type ApiMessage = { role: string; content: any };

/**
 * 见面（DateApp）专用的「语音情绪」格式规则（VN 模式下、char.dateVoiceEnabled 时注入）。
 * 与聊天/电话的 VOICE_ACTING_GUIDE 不同：见面台词走 VN 散文，只在台词行末用 [v:xxx] 单独标语音情绪，
 * 与立绘 [emotion] 解耦、不引入 <#秒#> 停顿/语气声标签。开头编号 4. 是承接 VN 规则列表第 1~3 条。
 * 用户可在「设置 → 其他 API → 语音提示词」自定义；留空则用这份内置默认。
 */
export const DATE_VOICE_GUIDE = `4. **语音情绪（跟立绘分开）**: \`[emotion]\` 只管**立绘表情**。台词会被朗读成真实语音，而立绘的夸张表情 ≠ 语音里的情绪——立绘 happy 是个灿烂笑脸，语音 happy 却会变成过度上扬的腔调，常常不对味。所以**语音情绪要单独标**：在台词行末尾加 \`[v:xxx]\`，xxx 仅限 happy/sad/angry/fearful/disgusted/surprised/calm。
   - 不是每句都要标——情绪平淡、自然说话时**不标**（默认更真实），只在台词确实有明显情绪、且和立绘强度不一致时才标。
   - 立绘可以夸张、语音要克制。例：\`[happy] "……真的吗？我等这句话好久了。" [v:calm]\`（脸上是惊喜，声音是压着的温柔）。
   - \`[v:xxx]\` 只写在带引号的台词行，动作/叙述行不用标。`;

/**
 * 注入 prompt 的当前时间，直接取真实系统时间（完整日期 + 星期 + 时分）。
 * 不要从 OSContext 的 virtualTime 取——那个名字唬人，实际也是每秒同步的真实
 * 时间，但只有"星期 + 时:分"，缺日期，而且没必要让 prompt 构建依赖 React 状态。
 */
const getRealTimeStr = (tz?: string): string => {
    // formatDate 自己会按 tz 折算，所以这里要喂真实时刻。
    // nowInTimeZone 返回的 Date 是「本地 getter 读出来正好是角色墙上时间」的形式，
    // 它的绝对时间戳已经被挪过一次——再交给 formatDate 就会多减一个时差。
    const realNow = Date.now();
    const wallClock = nowInTimeZone(tz, new Date(realNow));
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${ChatPrompts.formatDate(realNow, tz)} ${days[wallClock.getDay()]}`;
};

/** 线下时间感知开关：默认开启，显式关掉后见面 prompt 不再注入时间。 */
const isDateTimeAwarenessOn = (char: CharacterProfile): boolean =>
    char.dateTimeAwarenessEnabled !== false;

/** 立绘系统要求必备的五种基础情绪；角色自定义立绘在此之上叠加 */
export const REQUIRED_DATE_EMOTIONS = ['normal', 'happy', 'angry', 'sad', 'shy'];

// ─────────────────────────────────────────────────────────────
// 写作风格预设（DateSettings 面板与 prompt 构建共用同一份，别两边手抄）
// ─────────────────────────────────────────────────────────────

export interface DateStylePreset {
    id: string;
    label: string;
    /** 设置面板里给用户看的一句话简介 */
    hint: string;
    /** VN 系统提示里的完整风格块（替换「动作与叙述行的写法」段落） */
    block: string;
    /** peek（感知开场）「描写风格」一行用的短语 */
    peekHint: string;
}

export const DATE_STYLE_PRESETS: DateStylePreset[] = [
    {
        id: 'cinematic',
        label: '电影感',
        hint: '默认风格。沉浸式镜头感，感官细节丰富，有呼吸和停顿。',
        peekHint: '电影感，沉浸式，细节丰富',
        block: `### ⭐ 动作与叙述行的写法（风格：电影感）
你不是在列清单，你是在写一个正在发生的场景。每一行动作/叙述都应该让人感受到**此时此刻的空气**。

**具体要求**：
- 写出**感官**：光线怎么落的、空气什么味道、皮肤什么触感、周围什么声音
- 写出**节奏**：动作之间有停顿、有犹豫、有呼吸，不要一口气做完三个动作
- 写出**情绪的痕迹**：不要说"他很紧张"，而是写他的手指在桌面上画了一道看不见的线
- 让每一行都有**画面**，像电影里的一个镜头

❌ **不要这样写**（只用一个情绪 + 干巴巴的动作罗列）：
[normal] 把手放下，看向你。
走到你身边，坐下来。
拿起杯子，喝了一口水。

✅ **要这样写**（每行标注情绪 + 有画面、有停顿的叙述）：
[normal] 指尖从发梢滑落，垂在身侧。视线转过来的时候并不急，像是刚好、又像是故意。
[shy] "……你一直在看我吗？"
[happy] 嘴角的弧度藏不住，像是被戳中了什么小心思。
[normal] 脚步踩在木地板上的声音很轻。在你旁边坐下来，衣料带过一缕还没散尽的冷风。`,
    },
    {
        id: 'plain',
        label: '简洁白描',
        hint: '短句克制，不堆形容词，动作干净，靠留白说话。',
        peekHint: '简洁白描，短句克制，多留白',
        block: `### ⭐ 动作与叙述行的写法（风格：简洁白描）
用最少的字写最准的动作。短句，克制，不堆形容词，不滥用比喻。

**具体要求**：
- 一行只做一件事，动作干净利落
- 情绪藏在"做了什么/没做什么"的选择里，不点破、不渲染
- 善用留白：话说一半，停下来，让沉默自己说话

❌ **不要**：堆砌华丽辞藻、一行塞三个动作、直接写"他很开心/紧张"。
✅ **示例**：
[normal] 放下杯子。
[normal] "来了。"
[shy] 视线挪开，落在窗外。`,
    },
    {
        id: 'lyrical',
        label: '细腻文艺',
        hint: '绵密温柔，心理与感官交织，可用比喻和意象。',
        peekHint: '细腻文艺，感官与心理交织，意象贴合情绪',
        block: `### ⭐ 动作与叙述行的写法（风格：细腻文艺）
绵密、温柔、向内。心理活动和感官交织，可以用比喻和意象，但必须贴合此刻的情绪，不为修辞而修辞。

**具体要求**：
- 写光线、温度、气味这些容易被忽略的细节
- 动作之外，写动作背后那一层没说出口的心事
- 允许长句，但每一行仍只承载一个情绪节拍

✅ **示例**：
[normal] 茶杯沿上的热气慢慢散了，像一句没说完就被收回去的话。
[shy] "……今天的风，把人吹得有点想说实话。"
[happy] 指尖在桌面轻轻敲了两下，藏不住的雀跃顺着指节漏出来。`,
    },
    {
        id: 'playful',
        label: '轻快幽默',
        hint: '节奏明快，生活化，带点俏皮和小吐槽。',
        peekHint: '轻快幽默，生活化，带点俏皮',
        block: `### ⭐ 动作与叙述行的写法（风格：轻快幽默）
节奏明快，生活化，像情景喜剧的分镜，不端着。

**具体要求**：
- 动作可以夸张一点点，但要可爱不要闹剧
- 台词口语化，可以打趣、抬杠、自我吐槽
- 幽默来自细节和反差，不是硬讲笑话

✅ **示例**：
[happy] 叼着吸管，含糊不清地比了个"过来"的手势。
[normal] "你再迟到一分钟，这杯奶茶里的珍珠就要被我替你报仇了。"
[shy] 说完自己先没绷住，耳朵尖红了一点。`,
    },
    {
        id: 'intense',
        label: '浓烈炽热',
        hint: '情绪张力拉满，呼吸、心跳、距离感，克制边缘的爆发。',
        peekHint: '张力浓烈，感官冲击具体，空气绷紧',
        block: `### ⭐ 动作与叙述行的写法（风格：浓烈炽热）
情绪张力拉满。呼吸、心跳、距离感，每一行都往前压一步。

**具体要求**：
- 感官冲击要具体：温度、力度、停在半空的手
- 沉默和对视也是戏，写出空气绷紧的感觉
- 浓烈不等于直白嘶吼，克制边缘的爆发更有力量

✅ **示例**：
[normal] 一步，又一步。影子先碰到了你的影子。
[angry] "刚才那句话，再说一遍。"
[shy] 呼吸在离得很近的地方，乱了半拍。`,
    },
];

const DEFAULT_STYLE_ID = 'cinematic';

const getStylePreset = (config?: DateStyleConfig): DateStylePreset =>
    DATE_STYLE_PRESETS.find(p => p.id === (config?.style || DEFAULT_STYLE_ID)) || DATE_STYLE_PRESETS[0];

/**
 * 叙事人称块。pov 未设置时返回空串（不注入，沿用模型默认写法）。
 * 放在风格块之后：风格示例里的人称只是格式示意，以本节为准（块内已注明）。
 */
const buildPovBlock = (config: DateStyleConfig | undefined, charName: string, userName: string): string => {
    const uname = userName || '对方';
    switch (config?.pov) {
        case 'third-name':
            return `### 叙事人称（必须严格遵守）
叙述行使用**第三人称**：称呼你自己为「${charName}」，称呼对方为「${uname}」。叙述里不要出现"我""你"。
示例：${charName}看向${uname}，伸手替${uname}拢了拢被风吹乱的头发。
（台词引号内不受限，正常说话即可。上方风格示例中的人称仅为格式示意，一律以本节为准。）
`;
        case 'third-you':
            return `### 叙事人称（必须严格遵守）
叙述行中称呼你自己为「${charName}」（第三人称），称呼对方为"你"。叙述里不要用"我"指代自己。
示例：${charName}看向你，伸手替你拢了拢被风吹乱的头发。
（台词引号内不受限，正常说话即可。上方风格示例中的人称仅为格式示意，一律以本节为准。）
`;
        case 'first-you':
            return `### 叙事人称（必须严格遵守）
叙述行使用**第一人称**：称呼你自己为"我"，称呼对方为"你"。不要在叙述里用自己的名字指代自己。
示例：我看向你，伸手替你拢了拢被风吹乱的头发。
（上方风格示例中的人称仅为格式示意，一律以本节为准。）
`;
        default:
            return '';
    }
};

/** 自定义补充文风要求块。为空时不注入。 */
const buildExtraStyleBlock = (config?: DateStyleConfig): string => {
    const extra = (config?.extra || '').trim();
    if (!extra) return '';
    return `### 用户对文风的额外要求（优先级高于风格预设）
${extra}
`;
};

// ─────────────────────────────────────────────────────────────
// 细节深挖（反"模型八股"的正向方案）
//
// 各家模型都有自己的高频套话（"极其""不是X而是Y"之类），但静态黑名单治不了：
// 一是每家八股不同打不完，二是把禁语写进提示词反而会激活它（粉色大象效应）。
// 这里走正向路线：八股是"没话找话"时的填充物，所以教模型怎么从任意输入里
// 挖到具体素材（常驻方法块），并每轮随机注入一条聚焦线索（轮换的注意力方向
// 让相邻回复天然有差异，上下文自我模仿的雪球滚不起来）。全程不提任何禁语。
// ─────────────────────────────────────────────────────────────

const isDigDeeperOn = (config?: DateStyleConfig): boolean => config?.digDeeper !== false;

const DIG_DEEPER_BLOCK = `### 💎 素材永远比你以为的多（深挖，别填充）
对方哪怕随口一句话，都至少藏着这些可以接的线：
1. **ta的用词**——为什么是这个词？换个人不会这么说。
2. **ta怎么说的**——语速、音量、说话时手在干什么、眼睛看哪。
3. **ta没说的**——这句话省略了什么？和ta平时的样子比，哪里不一样？
4. **现场**——此刻的光线、声音、桌上的东西，随便一样都能参与进互动。
5. **你们的过去**——这句话让你想起哪件只有你们知道的事？
6. **你自己**——它在你心里激起的第一反应是什么？你压下去了，还是说了出来？

比如对方只说了句"有点累"，能接的就有：累的是身体还是别的；ta说这话时把包放下的动作；你上次见ta累成这样是什么时候；要不要把窗边那杯还温着的水推过去。

规则：
- 每一轮只挑**一两条线**往深处走，写透它。不要每条都碰——什么都写等于什么都没写。
- 觉得"没什么可写"的时候，恰恰说明该回到上面的清单里找。空泛的感慨和万能句式都是没话找话，宁可写一个具体的小动作。
`;

/** 每轮随机注入一条，把注意力推向不同的具体方向；reroll 时另抽一条换切入角度 */
export const DIG_FOCUS_HINTS = [
    '从对方刚才的用词里挑一个词，作为这一轮回应的起点',
    '让场景里的一件具体物品参与到这一轮互动里',
    '写一个克制的身体细节——距离、姿态、或一个没完成的动作',
    '把对方这句话和你们的一段过去连起来（只有你们知道的事）',
    '这一轮重点回应对方"怎么说"而不是"说了什么"——语气、停顿、视线',
    '写一个你心里闪过但没说出口的念头，让它影响你的下一句话',
    '留意对方没说出口的部分，回应那个空白',
    '让此刻的环境（光线、声音、温度）影响你说话的方式',
];

const pickFocusHint = (): string =>
    DIG_FOCUS_HINTS[Math.floor(Math.random() * DIG_FOCUS_HINTS.length)];

// ─────────────────────────────────────────────────────────────
// 观测协议 OBSERVE（全方位观察 char：时间 / 地点 / 状态 / 细节）
//
// 开启后，让模型在「正文最前面」吐一段定界的结构化观测块，前端 extractObservation
// 把它从正文里剥出来渲染成全息 HUD（独立查看），剩余文本照常走 VN 解析。
// 定界符用不常见的 ⟦⟧，避免和 [emotion] 立绘标签 / 台词引号撞车。
// 字段标签固定中文 + 全角竖线，解析时对中英 key、半角竖线、冒号都容错。
// ─────────────────────────────────────────────────────────────

export const OBSERVE_OPEN = '⟦OBSERVE⟧';
export const OBSERVE_CLOSE = '⟦/OBSERVE⟧';

// ── 容错正则：模型掉格式时尽量还原，分两层（严格定界 + 宽松回退）─────────
// 各种括号风格：⟦⟧ 【】〔〕「」『』 [] () <> ，都收。关键字接受 OBSERVE / 观测 / 观测协议。
const BRA = '[\\[\\(<⟦【〔「『]';
const KET = '[\\]\\)>⟧】〕」』]';
const OBSERVE_KW = '(?:OBSERVE|观测协议|观测)';

/** 严格：成对定界块（含 ⟦OBSERVE⟧ … ⟦/OBSERVE⟧，容忍括号风格/空格/大小写）。有定界符即视为明确意图。 */
const OBSERVE_BLOCK_RE = new RegExp(`${BRA}\\s*${OBSERVE_KW}\\s*${KET}([\\s\\S]*?)${BRA}\\s*/\\s*${OBSERVE_KW}\\s*${KET}`, 'i');

/** 整行只是一个定界标记（开/闭都算）——回退扫描时用来跳过孤立的标记行 */
const OBSERVE_MARKER_LINE_RE = new RegExp(`^\\s*${BRA}?\\s*/?\\s*${OBSERVE_KW}\\s*/?\\s*${KET}?\\s*$`, 'i');
const isObserveMarkerLine = (line: string): boolean => OBSERVE_MARKER_LINE_RE.test(line.trim());

/** 单条字段行：容忍 markdown 列表符 / 加粗 / 中英 key / 全半角竖线 / 中英冒号 */
const OBSERVE_FIELD_RE = /^\s*(?:[-*>•·]\s*)?\*{0,2}\s*(时间|地点|地区|场所|位置|状态|心境|情绪|细节|动作|举动|time|place|location|site|position|status|state|mood|detail|trace|action)\s*\*{0,2}\s*[｜|:：]\s*(.+?)\s*$/i;

/** 默认四维的 key（不含 extra） */
type ObserveDefaultKey = 'time' | 'place' | 'state' | 'detail';

/** 把 key 归一到四个维度之一 */
const mapObserveKey = (key: string): ObserveDefaultKey | null => {
    const k = key.toLowerCase();
    if (/时间|time/.test(k)) return 'time';
    if (/地点|地区|场所|位置|place|location|site|position/.test(k)) return 'place';
    if (/状态|心境|情绪|status|state|mood/.test(k)) return 'state';
    if (/细节|动作|举动|detail|trace|action/.test(k)) return 'detail';
    return null;
};

/** 清洗字段值：去掉残留的定界标记、外层括号、加粗星号 */
const cleanObserveValue = (raw: string): string => {
    let v = raw.trim();
    v = v.replace(new RegExp(`${BRA}\\s*/?\\s*${OBSERVE_KW}\\s*/?\\s*${KET}`, 'gi'), ''); // 内联残留标记
    v = v.replace(/^\*{1,2}|\*{1,2}$/g, '').trim();   // 外层加粗
    v = v.replace(/^（\s*|\s*）$/g, '').trim();        // 全角括号包裹
    v = v.replace(/^\(\s*|\s*\)$/g, '').trim();        // 半角括号包裹
    return v.trim();
};

const isObserveOn = (char: CharacterProfile): boolean => char.dateObserve?.enabled === true;

/**
 * 观测协议四个默认维度。`label` 是注入提示词时的**固定线格式字段名**（解析靠它，
 * 不随用户自定义改动），`en`/`glyph` 给 HUD 用，`hint` 是默认生成提示（可被
 * char.dateObserve.fields[key].hint 覆盖；`{name}` 会替换成角色名）。
 */
export interface ObserveDimension {
    key: keyof DateObservation;
    label: string;   // 线格式字段名（时间/地点/状态/细节），解析依赖，勿改
    en: string;      // HUD 上的英文小标
    glyph: string;   // HUD 上的字形符号
    hint: string;    // 默认生成提示
}

export const OBSERVE_DIMENSIONS: ObserveDimension[] = [
    { key: 'time',   label: '时间', en: 'TIME',  glyph: '◷', hint: '结合场景的当下时刻，可比系统时间更具体，如"傍晚六点过，天刚擦黑"' },
    { key: 'place',  label: '地点', en: 'SITE',  glyph: '⌖', hint: '{name}此刻所在的具体地点与环境' },
    { key: 'state',  label: '状态', en: 'STATE', glyph: '❖', hint: '{name}的身心状态：情绪、体感、正在经历的内在波动' },
    { key: 'detail', label: '细节', en: 'TRACE', glyph: '✶', hint: '此刻最值得被注意的一个动作 / 微小细节' },
];

/** 自定义维度在 HUD 上轮换用的字形 */
const CUSTOM_GLYPHS = ['✦', '◆', '❂', '✺', '⬡', '◈'];

/** HUD / 设置面板 / 提示词共用：合并默认四维 + 用户自定义维度，过滤禁用 / 空标签的。 */
export interface ResolvedObserveField {
    key: string;       // 默认维度的 key（time/place/...）或自定义维度的 id
    label: string;     // 线格式字段名（默认维度用固定中文 key；自定义用其 label）
    display: string;   // HUD 展示标签（默认维度可自定义；自定义维度即 label）
    en: string;
    glyph: string;
    hint: string;
    isCustom: boolean;
}
export const resolveObserveFields = (config?: DateObserveConfig, charName = ''): ResolvedObserveField[] => {
    const cfg = config?.fields || {};
    const base: ResolvedObserveField[] = OBSERVE_DIMENSIONS
        .filter(d => cfg[d.key]?.enabled !== false)
        .map(d => ({
            key: d.key,
            label: d.label,
            display: (cfg[d.key]?.label || '').trim() || d.label,
            en: d.en,
            glyph: d.glyph,
            hint: ((cfg[d.key]?.hint || '').trim() || d.hint).replace(/\{name\}/g, charName),
            isCustom: false,
        }));
    const custom: ResolvedObserveField[] = (config?.custom || [])
        .filter(c => c.enabled !== false && (c.label || '').trim())
        .map((c, i) => ({
            key: c.id,
            label: c.label.trim(),
            display: c.label.trim(),
            en: 'NOTE',
            glyph: CUSTOM_GLYPHS[i % CUSTOM_GLYPHS.length],
            hint: ((c.hint || '').trim() || `观察并描写「${c.label.trim()}」`).replace(/\{name\}/g, charName),
            isCustom: true,
        }));
    return [...base, ...custom];
};

/**
 * 观测块提示词。仅在开关打开时注入；放在 VN 块末尾（场景上下文之后）。
 * 线格式字段名固定用默认 label（保证解析稳定），但每项「生成什么」用角色自定义 hint。
 * 全部维度被用户关掉时返回空串（等于不注入观测块）。
 */
const buildObserveBlock = (char: CharacterProfile): string => {
    const fields = resolveObserveFields(char.dateObserve, char.name);
    if (fields.length === 0) return '';
    const lines = fields.map(f => `${f.label}｜（${f.hint}）`).join('\n');
    return `
### 👁 观测协议（OBSERVE，必须严格执行）
在你**整段回复的最前面**，先输出一段「观测块」，用来让用户全方位观察${char.name}此刻的状态。
观测块**不受**上面「一行一念 / 每行 [emotion] 开头」规则约束——它是独立的元信息，紧接着才是正常的 VN 正文。

格式**必须**逐字如下（每个字段都要给，每项一句话、简洁有画面，别写成大段）：
${OBSERVE_OPEN}
${lines}
${OBSERVE_CLOSE}

硬性要求：
- 开头那行 \`${OBSERVE_OPEN}\` 和结尾那行 \`${OBSERVE_CLOSE}\` **两行定界符都必须原样保留**，各自单独占一行，哪怕你不确定也别省略。
- 每个字段各占一行，用全角竖线 \`｜\` 分隔标签和内容；标签必须原样用 ${fields.map(f => `「${f.label}」`).join('、')}，不要加序号、不要用 markdown 加粗。
- 观测块只在整段回复的最开头出现一次，输出完**另起一行**再写 VN 正文（每行 [emotion] 开头）。`;
};

/**
 * 从模型输出里剥出观测块。返回结构化数据 + 去掉观测块后的正文。
 *
 * 鲁棒性分两层（针对模型掉格式）：
 *  1) 严格层：成对定界块（含各种括号风格 / OBSERVE|观测 关键字）。有定界符 = 明确意图，
 *     哪怕只有一个字段也认。这一层永远开，不会误伤普通正文。
 *  2) 回退层（lenient）：模型丢了闭合标记、换了标记、甚至完全没标记，只在开头堆了
 *     "时间｜… 地点｜…" 这种字段行——就从开头连续扫字段行，**至少命中 2 个不同维度**
 *     才认（避免把正文里偶发的"状态：…"误当观测）。仅在开关打开时传 lenient=true。
 */
export const extractObservation = (
    text: string,
    opts: { lenient?: boolean; custom?: DateObserveCustomField[] } = {},
): { observation: DateObservation | null; rest: string } => {
    if (!text) return { observation: null, rest: text };

    const customFields = (opts.custom || []).filter(c => c.enabled !== false && (c.label || '').trim());

    // ── 严格层：成对定界块 ──
    const m = text.match(OBSERVE_BLOCK_RE);
    if (m && m.index !== undefined) {
        const observation = parseObserveBody(m[1], customFields);
        if (hasObservation(observation)) {
            const rest = stripStrayMarkers(text.slice(0, m.index) + text.slice(m.index + m[0].length));
            return { observation, rest };
        }
    }

    // ── 回退层：仅在开关开时启用，扫开头的连续字段行 ──
    if (opts.lenient) {
        const fallback = scanLeadingFields(text, customFields);
        if (fallback) return fallback;
    }

    return { observation: null, rest: text };
};

/** 通用字段行（任意短 key｜value），用于匹配自定义维度的 label */
const OBSERVE_ANYLINE_RE = /^\s*(?:[-*>•·]\s*)?\*{0,2}\s*([^｜|:：*\n]{1,16}?)\s*\*{0,2}\s*[｜|:：]\s*(.+?)\s*$/;

/** 试着把一行匹配成某个自定义维度（按 label 精确匹配，大小写/空格不敏感） */
const matchCustomField = (line: string, customFields: DateObserveCustomField[]): { id: string; value: string } | null => {
    if (!customFields.length) return null;
    const mm = line.match(OBSERVE_ANYLINE_RE);
    if (!mm) return null;
    const k = mm[1].trim().toLowerCase();
    const cf = customFields.find(c => c.label.trim().toLowerCase() === k);
    if (!cf) return null;
    return { id: cf.id, value: cleanObserveValue(mm[2]) };
};

const setCustomValue = (obs: DateObservation, id: string, val: string): void => {
    if (!val) return;
    obs.extra = obs.extra || {};
    if (!obs.extra[id]) obs.extra[id] = val;
};

/** 统计观测命中了几个不同维度（默认四维 + 自定义），回退层用于 ≥2 门槛 */
const countObserveDims = (obs: DateObservation): number =>
    (obs.time ? 1 : 0) + (obs.place ? 1 : 0) + (obs.state ? 1 : 0) + (obs.detail ? 1 : 0) + Object.keys(obs.extra || {}).length;

/** 块体逐行解析（严格层用，块内字段无歧义，不设 2 个门槛） */
const parseObserveBody = (body: string, customFields: DateObserveCustomField[] = []): DateObservation => {
    const obs: DateObservation = {};
    for (const raw of body.split('\n')) {
        const mm = raw.match(OBSERVE_FIELD_RE);
        if (mm) {
            const key = mapObserveKey(mm[1]);
            const val = cleanObserveValue(mm[2]);
            if (key && val && !obs[key]) obs[key] = val;
            continue;
        }
        const cf = matchCustomField(raw, customFields);
        if (cf) setCustomValue(obs, cf.id, cf.value);
    }
    return obs;
};

/**
 * 回退扫描：跳过开头的空行/孤立标记行，连续吃字段行，遇到第一行"非字段非标记非空"的
 * 内容（正文/台词/[emotion] 行）即停。命中 ≥2 个不同维度才算数。
 */
const scanLeadingFields = (text: string, customFields: DateObserveCustomField[] = []): { observation: DateObservation; rest: string } | null => {
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;          // 跳开头空行
    if (i < lines.length && isObserveMarkerLine(lines[i])) i++; // 跳一行孤立开标记
    const obs: DateObservation = {};
    let lastConsumed = i - 1;
    const maxScan = i + 12; // 只看开头一小段，绝不深入正文
    for (let j = i; j < lines.length && j < maxScan; j++) {
        const t = lines[j].trim();
        if (!t) { continue; }                       // 字段间空行：跳过但不推进 lastConsumed
        if (isObserveMarkerLine(lines[j])) { lastConsumed = j; continue; } // 闭合/重复标记
        const mm = t.match(OBSERVE_FIELD_RE);
        if (mm) {
            const key = mapObserveKey(mm[1]);
            const val = cleanObserveValue(mm[2]);
            if (key && val && !obs[key]) obs[key] = val;
            lastConsumed = j;
            continue;
        }
        const cf = matchCustomField(t, customFields);
        if (!cf) break;                             // 正文开始
        setCustomValue(obs, cf.id, cf.value);
        lastConsumed = j;
    }
    if (countObserveDims(obs) < 2) return null;
    const rest = lines.slice(lastConsumed + 1).join('\n').trim();
    return { observation: obs, rest };
};

/** 去掉正文里残留的孤立定界标记行（严格层剥块后可能留下空标记/代码围栏） */
const stripStrayMarkers = (text: string): string =>
    text
        .split('\n')
        .filter(line => !isObserveMarkerLine(line) && !/^\s*```/.test(line))
        .join('\n')
        .trim();

/** 只去观测块、不要结构化数据时用（novel 模式渲染历史正文） */
export const stripObservation = (text: string, opts?: { lenient?: boolean }): string =>
    extractObservation(text, opts).rest || (text || '');

/** HUD / 持久化判定：任一默认维度或自定义维度非空才算有效观测 */
export const hasObservation = (obs: DateObservation | null | undefined): obs is DateObservation =>
    !!obs && !!(obs.time || obs.place || obs.state || obs.detail || (obs.extra && Object.keys(obs.extra).length > 0));

const getDateEmotions = (char: CharacterProfile): string[] =>
    [...REQUIRED_DATE_EMOTIONS, ...(char.customDateSprites || [])];

/**
 * 见面侧的时间间隔提示。与 ChatPrompts.getTimeGapHint（IM 风格文案）刻意分开：
 * 这里的措辞面向"多久没见面/互动"的场景判断，不是"多久没回消息"。
 */
const getTimeGapHint = (lastMsgTimestamp: number | undefined, tz?: string): string => {
    if (!lastMsgTimestamp) return '这是你们的初次互动。';
    const now = Date.now();
    const diffMs = now - lastMsgTimestamp;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const currentHour = nowInTimeZone(tz).getHours();
    const isNight = currentHour >= 23 || currentHour <= 6;

    if (diffMins < 5) return '';
    if (diffMins < 60) return `[系统提示: 距离上次互动: ${diffMins} 分钟。]`;
    if (diffHours < 6) {
        if (isNight) return `[系统提示: 距离上次互动: ${diffHours} 小时。现在是深夜/清晨。]`;
        return `[系统提示: 距离上次互动: ${diffHours} 小时。]`;
    }
    if (diffHours < 24) return `[系统提示: 距离上次互动: ${diffHours} 小时。]`;
    const days = Math.floor(diffHours / 24);
    return `[系统提示: 距离上次互动: ${days} 天。]`;
};

/**
 * 把 buildMessageHistory 的结构化输出压平成纯文本（peek 的 [最近记录] 块用）。
 * 图片消息的 image_url 部分丢弃，只保留文字占位（peek 不需要看图）。
 */
const flattenHistoryToText = (apiMessages: ApiMessage[]): string =>
    apiMessages.map(m => {
        const text = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
                ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join(' ')
                : '';
        return `${m.role}: ${text}`;
    }).join('\n');

/**
 * VN 模式系统提示（send 与 reroll 共用同一份，避免两处手抄漂移）。
 * reroll 的差异只体现在末尾 user 消息的 System Note 里，不在这里分叉。
 * 风格 / 人称 / 自定义补充按 char.dateStyleConfig 动态拼装。
 */
const buildVNModeBlock = (char: CharacterProfile, userName: string): string => {
    const dateTimeOn = isDateTimeAwarenessOn(char);
    const timeLine = dateTimeOn ? `1. **Time**: 当前时间 ${getRealTimeStr(resolveCharTimeZone(char))}。\n` : '';
    const dateEmotions = getDateEmotions(char);
    const styleConfig = char.dateStyleConfig;
    const preset = getStylePreset(styleConfig);
    const povBlock = buildPovBlock(styleConfig, char.name, userName);
    const extraBlock = buildExtraStyleBlock(styleConfig);
    const digBlock = isDigDeeperOn(styleConfig) ? `${DIG_DEEPER_BLOCK}\n` : '';
    const observeBlock = isObserveOn(char) ? buildObserveBlock(char) : '';
    return `### [Visual Novel Mode: 视觉小说脚本模式]
你正在与用户进行**面对面**的互动。这不是聊天，是一场真实的见面。

### 核心规则：一行一念 (One Line per Beat)
前端解析器基于**换行符**来分割气泡。
1. **禁止混写**: 严禁在同一行里既写动作又写带引号的台词。
2. **情绪标签**: **每一行都必须以** \`[emotion]\` **开头**，表示该行的表情立绘。情绪随内容变化——台词温柔就用 [happy]，动作紧张就用 [shy]，语气冲就用 [angry]。**不要整段只用一个情绪，要逐行根据语境切换。** 仅限使用以下情绪: ${dateEmotions.join(', ')}。不要使用任何不在此列表中的标签。
3. **格式**: 台词用双引号 **"..."**，动作/叙述直接写（不加引号）。
${char.dateVoiceEnabled ? (getVoicePromptOverride('dateVoice') ?? DATE_VOICE_GUIDE) : ''}

${preset.block}

${digBlock}${povBlock}${extraBlock}### 场景上下文
${timeLine}- **Location**: 你们现在**面对面**。
- **Context**: 参考历史记录。如果刚刚才看到开场白（Opening），请自然接话。
${observeBlock}`;
};

/**
 * 历史构建（send / reroll 共用）：
 * 1. 开了记忆宫殿 → 按高水位线过滤掉已被向量记忆替代的旧消息。调用方传入
 *    includeProcessed=true 的最近窗口，避免 DateApp 为一次见面把全角色历史读进内存。
 * 2. 复用 ChatPrompts.buildMessageHistory 压缩各类卡片。
 * 3. 排除最后一条（待重发的 user msg），由调用方单独追加带 System Note 的版本。
 */
const buildDateHistory = (
    allMsgs: Message[],
    char: CharacterProfile,
    userProfile: UserProfile | null | undefined,
    emojis: Emoji[],
    useVisionDescriptions: boolean = false,
): ApiMessage[] => {
    const limit = char.contextLimit || 500;
    const hwm = parseInt(localStorage.getItem(`mp_lastMsgId_${char.id}`) || '0', 10);
    const palaceFiltered = hwm > 0 ? allMsgs.filter(m => m.id > hwm) : allMsgs;
    const historyForBuild = palaceFiltered.slice(0, -1);
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        historyForBuild,
        limit,
        char,
        userProfile || ({} as UserProfile),
        emojis,
        undefined,
        { useVisionDescriptions },
    );
    return apiMessages;
};

export const DatePrompts = {
    getTimeGapHint,

    /**
     * Peek（感知开场）：用户"悄悄靠近"前，让 LLM 第三人称描写角色当下的状态。
     * 历史以纯文本块塞进 user 消息（保持"你不在和用户对话"的框定），
     * 但文本本身来自 buildMessageHistory，卡片/媒体已压成短摘要。
     */
    buildPeekPayload: (input: {
        char: CharacterProfile;
        userProfile: UserProfile;
        allMsgs: Message[];
        emojis: Emoji[];
        useVisionDescriptions?: boolean;
    }): { messages: ApiMessage[] } => {
        const { char, userProfile, allMsgs, emojis } = input;
        const charTz = resolveCharTimeZone(char);
        const dateTimeOn = isDateTimeAwarenessOn(char);
        const timeStr = getRealTimeStr(charTz);
        const limit = char.contextLimit || 500;
        const peekLimit = Math.min(limit, 50);
        const lastMsg = allMsgs[allMsgs.length - 1];
        const gapHint = getTimeGapHint(lastMsg?.timestamp, charTz);

        const { apiMessages } = ChatPrompts.buildMessageHistory(
            allMsgs,
            peekLimit,
            char,
            userProfile || ({} as UserProfile),
            emojis,
            undefined,
            { useVisionDescriptions: input.useVisionDescriptions === true },
        );
        const recentMsgs = flattenHistoryToText(apiMessages);

        // 线下时间感知关掉 → 抑制 buildCoreContext 的时间注入，让见面真正脱离现实时间线（纯架空）
        // conversational 不给：peek 是「用户还没走过去」的第三人称镜头，时间块末尾那句
        // 语境框定说的是「对方还在跟你说话」，跟这里的框定正好相反（见下面的 peekInstructions）。
        const baseContext = ContextBuilder.buildCoreContext(char, userProfile, false, undefined, undefined, { skipTimeAwareness: !isDateTimeAwarenessOn(char) });

        // 文风预设也作用于开场感知；人称（pov）刻意不作用——peek 的设计就是
        // 第三人称旁观镜头（用户还没"走过去"），人称指令只影响 session 内叙述
        const preset = getStylePreset(char.dateStyleConfig);
        const extraBlock = buildExtraStyleBlock(char.dateStyleConfig);

        // 根据时间间隔选择合适的分隔符
        const contextSeparator = gapHint
            ? `\n\n--- [TIME SKIP: ${gapHint}] ---\n\n`
            : `\n\n--- [SCENE CONTINUATION: 刚刚还在聊天，现在来到了面对面的场景] ---\n\n`;

        const peekInstructions = `
### 场景：感知 (Sense Presence)
${dateTimeOn ? `当前时间: ${timeStr}\n` : ''}时间上下文: ${gapHint}

### 任务
你现在并不在和用户直接对话。用户正在悄悄靠近你所在的地点。
请用**第三人称**描写一段话。
描述：${char.name} 此时此刻正在做什么？周围环境是怎样的？状态如何？

### 逻辑检查
1. **上下文连贯性**: 参考 [最近记录]（注意消息来源标签：[聊天]是文字聊天、[约会]是面对面、[通话]是语音通话）。如果有 [TIME SKIP] 且间隔很久，开启新场景；如果是 [SCENE CONTINUATION]，说明刚刚还在聊天，**必须**自然衔接最近的聊天话题和情绪状态，不要无视之前的对话内容。
2. **状态一致性**: ${gapHint.includes('天') ? '如果间隔了很多天，可能在发呆、忙碌或者有点落寞。' : '根据最近的聊天内容和情绪来决定当前状态。如果刚聊完，角色的状态应该与聊天内容相呼应。'}
3. **描写风格**: ${preset.peekHint}。${isObserveOn(char) ? '先按下方「观测协议」输出观测块，再开始描写内容（描写本身不要加任何前缀）。' : '不要输出任何前缀，直接输出描写内容。'}
${extraBlock ? `\n${extraBlock}` : ''}${isObserveOn(char) ? `\n${buildObserveBlock(char)}` : ''}`;

        return {
            messages: [
                { role: 'system', content: baseContext },
                { role: 'user', content: `[最近记录 (Previous Context)]:${recentMsgs}${contextSeparator}${peekInstructions}\n\n(Start sensing...)` },
            ],
        };
    },

    /**
     * Session（send / reroll 共用）。
     * allMsgs 须为 includeProcessed=true 的最近消息窗口，且最后一条是本轮要重新追加的
     * user 消息（send：刚落库的输入；reroll：触发上一条 AI 回复的那条）。
     */
    buildSessionPayload: async (input: {
        char: CharacterProfile;
        userProfile: UserProfile;
        allMsgs: Message[];
        emojis: Emoji[];
        userText: string;
        variant: 'send' | 'reroll';
        useVisionDescriptions?: boolean;
    }): Promise<{ messages: ApiMessage[] }> => {
        const { char, userProfile, allMsgs, emojis, userText, variant } = input;

        const historyMsgs = buildDateHistory(
            allMsgs,
            char,
            userProfile,
            emojis,
            input.useVisionDescriptions === true,
        );

        // 向量召回挂到 char.memoryPalaceInjection，buildCoreContext 会读取
        await injectMemoryPalace(char, allMsgs, undefined, userProfile?.name);
        const systemPrompt = ContextBuilder.buildCoreContext(char, userProfile, true, undefined, undefined, { skipTimeAwareness: !isDateTimeAwarenessOn(char), conversational: true })
            + buildVNModeBlock(char, userProfile?.name || '')
            + ContextBuilder.buildSARModuleContext(char, userProfile, 'date');

        // 每轮轮换的聚焦线索：把注意力推向不同的具体方向，相邻回复天然有差异
        const focusLine = isDigDeeperOn(char.dateStyleConfig) ? ` 本轮线索：${pickFocusHint()}。` : '';
        const note = variant === 'send'
            ? `(System Note: 严格遵守 VN 格式。每一行都要以 [emotion] 开头，根据内容逐行切换情绪标签，不要整段只用同一个。叙述行写具体的感官细节和停顿，不要罗列动作。${focusLine})`
            : `(System Note: Reroll. 换一个切入角度重写，不要复用上一版的展开思路。依然严格遵守 VN 格式：每一行以 [emotion] 开头并逐行切换情绪，叙述行写具体的感官细节和停顿，不要罗列动作。${focusLine})`;

        return {
            messages: [
                { role: 'system', content: systemPrompt },
                ...historyMsgs,
                { role: 'user', content: `${userText}\n\n${note}` },
            ],
        };
    },
};

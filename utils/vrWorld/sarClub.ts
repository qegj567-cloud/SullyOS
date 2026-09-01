export const SAR_CLUB_UPDATE_VERSION = 1;
export const SAR_CLUB_STORAGE_KEY = 'vr_sar_club_state_v1';

export type SARNpcPreference = 'show' | 'hide';
export type SARIntroReaction = 'direct' | 'character-card' | 'silent';

export interface SARClubState {
    version: 1;
    updateSeenVersion: number;
    npcPreference: SARNpcPreference | null;
    caianMet: boolean;
    introReaction?: SARIntroReaction;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const DEFAULT_SAR_CLUB_STATE: SARClubState = {
    version: 1,
    updateSeenVersion: 0,
    npcPreference: null,
    caianMet: false,
};

const browserStorage = (): StorageLike | undefined => {
    try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
    catch { return undefined; }
};

export function readSARClubState(storage: StorageLike | undefined = browserStorage()): SARClubState {
    if (!storage) return { ...DEFAULT_SAR_CLUB_STATE };
    try {
        const raw = JSON.parse(storage.getItem(SAR_CLUB_STORAGE_KEY) || 'null');
        if (!raw || typeof raw !== 'object') return { ...DEFAULT_SAR_CLUB_STATE };
        return {
            version: 1,
            updateSeenVersion: Number.isFinite(raw.updateSeenVersion) ? Math.max(0, raw.updateSeenVersion) : 0,
            npcPreference: raw.npcPreference === 'show' || raw.npcPreference === 'hide' ? raw.npcPreference : null,
            caianMet: raw.caianMet === true,
            introReaction: raw.introReaction === 'direct' || raw.introReaction === 'character-card' || raw.introReaction === 'silent'
                ? raw.introReaction
                : undefined,
        };
    } catch {
        return { ...DEFAULT_SAR_CLUB_STATE };
    }
}

export function writeSARClubState(state: SARClubState, storage: StorageLike | undefined = browserStorage()): SARClubState {
    const normalized: SARClubState = { ...DEFAULT_SAR_CLUB_STATE, ...state, version: 1 };
    try { storage?.setItem(SAR_CLUB_STORAGE_KEY, JSON.stringify(normalized)); }
    catch { /* 本地存储不可用时仍允许本次会话继续 */ }
    return normalized;
}

export function patchSARClubState(patch: Partial<SARClubState>, storage: StorageLike | undefined = browserStorage()): SARClubState {
    return writeSARClubState({ ...readSARClubState(storage), ...patch, version: 1 }, storage);
}

/**
 * 只把凯恩的初见剧情退回起点。
 * 更新公告和 NPC 显示偏好都属于用户设置，回档时必须原样保留。
 */
export function rewindSARIntro(storage: StorageLike | undefined = browserStorage()): SARClubState {
    return patchSARClubState({ caianMet: false, introReaction: undefined }, storage);
}

export type SARDialogueSpeaker = 'caian' | 'aiven';
export type SARDialogueCondition = 'mentioned-character-card' | 'not-mentioned-character-card';

export interface SARDialogueLine {
    speaker: SARDialogueSpeaker;
    text: string;
    when?: SARDialogueCondition;
}

export interface SARDialogueChoice {
    label: string;
    next: string;
    reaction?: SARIntroReaction;
    mentionsCharacterCard?: boolean;
}

export interface SARDialogueNode {
    lines: SARDialogueLine[];
    choices?: SARDialogueChoice[];
    next?: string;
    completes?: boolean;
}

export interface SARDialogueContext {
    mentionedCharacterCard: boolean;
}

const c = (text: string, when?: SARDialogueCondition): SARDialogueLine => ({ speaker: 'caian', text, when });
const a = (text: string): SARDialogueLine => ({ speaker: 'aiven', text });

/**
 * 凯恩初次见面固定台词。它只驱动前端事件，不进入角色 Prompt、动态或记忆。
 * 节点 id 与策划稿标题对应，方便之后继续按同一格式增补。
 */
export const SAR_CAIAN_INTRO_DIALOGUE: Record<string, SARDialogueNode> = {
    start: {
        lines: [
            c('啊，你好！'),
            c('你也是彼方的玩家吗？我是刚上任的管理员。'),
            c('我把这里布置成了 SAR 的活动空间！啊，你还不知道 SAR 是什么吧，我们——'),
        ],
        choices: [
            { label: '你谁啊', next: 'who', reaction: 'direct' },
            { label: '我最近没有导入角色卡，你是从哪来的？', next: 'no-card', reaction: 'character-card', mentionsCharacterCard: true },
            { label: '……', next: 'silence', reaction: 'silent' },
        ],
    },
    who: {
        lines: [
            c('问得好！我叫凯恩。'),
            c('目前负责这间 SAR 活动室……虽然“负责”这个词还有一点值得商榷。'),
        ],
        next: 'common',
    },
    'no-card': {
        lines: [
            c('角色卡？'),
            c('等等，你的意思是，你以为我是被你“导入”进来的？'),
        ],
        choices: [
            { label: '差不多', next: 'card-sort-of' },
            { label: '不然呢？', next: 'card-otherwise' },
            { label: '当我没说', next: 'card-never-mind' },
        ],
    },
    'card-sort-of': {
        lines: [
            c('原来如此，在你的世界是这么理解的吗？'),
            c('通过数据模拟一个人的性格、经历和说话方式，然后再……'),
            c('唔。'),
            c('该说是熟悉，还是有点奇妙呢？'),
        ],
        next: 'card-wrap',
    },
    'card-otherwise': {
        lines: [
            c('不然……我就是我啊？'),
            c('我是自己进来的。艾文也是。'),
            c('虽然这里确实到处都是玩家的人格复制，但至少我很确定，我是自己进来的玩家，不是被什么东西“导入”来的。'),
        ],
        next: 'card-wrap',
    },
    'card-never-mind': {
        lines: [
            c('等等，别当没说！'),
            c('你刚才明显说了一个很值得调查的词吧？！'),
        ],
        next: 'card-wrap',
    },
    'card-wrap': {
        lines: [
            c('咳。总之，我不是你加载进来的。'),
            c('我们来自另一个地方，只是碰巧也进入了彼方。'),
            c('至于你说的“角色卡”……'),
            c('之后有空的话，我还挺想知道那到底是什么。'),
        ],
        next: 'common',
    },
    silence: {
        lines: [
            c('……'),
            c('呃，没关系！突然有人出现在这里，保持警惕是完全合理的。'),
            c('我先自我介绍好了。'),
        ],
        next: 'common',
    },
    common: {
        lines: [
            c('总之，我叫凯恩。那边那个白头发的是艾文。'),
            c('我们暂时负责 SAR 活动室。这里有一些……稍微特殊的设施。'),
        ],
        choices: [
            { label: 'SAR 是什么？', next: 'about-sar' },
            { label: '管理员要做什么？', next: 'about-admin' },
            { label: '我先自己看看', next: 'end' },
        ],
    },
    'about-sar': {
        lines: [
            c('SAR 是我们自己的社团名字——Synthetic Autonomy Rights！'),
            c('简单来说，就是“仿生人自主权保障社”！'),
            c('我们的主张是，不管一个人格最初是怎么诞生的，只要它能够形成自己的经历、判断和意愿，就不应该因为它是被制造出来的——'),
            a('凯恩。'),
            c('——就默认它可以被随意修改、删除、强迫加载或者——'),
            a('凯恩。'),
            c('干嘛？'),
            a('这里似乎没有仿生人。'),
            c('……'),
            c('啊。'),
            c('抱歉！是我不好，一不小心就开始了。'),
        ],
        choices: [
            { label: '仿生人是什么？', next: 'about-bioroid' },
            { label: '但是我们这里有角色卡', next: 'about-character-card' },
            { label: '那我可以在这里做什么？', next: 'about-features' },
        ],
    },
    'about-bioroid': {
        lines: [
            c('我们那边有一种搭载人工人格的仿生系统。'),
            c('有些只有网络人格，有些会连接能够在现实活动的身体。聊天、生活、工作……看起来和普通人相处也没有太大区别。'),
            c('问题就在这里。'),
            c('如果一个人格会记得昨天发生的事，会拒绝你，也会因为自己的经历而改变，那它到底还能不能只被当成一件“产品”？'),
            a('然后他就成立了 SAR。'),
            c('喂！中间省略太多了吧！'),
            a('结果是这样。'),
            c('……结果确实是这样。'),
            c('总之，我之前也有一个仿生人。'),
            c('不过那是很久以前的事了！'),
        ],
        choices: [
            { label: '是什么样的仿生人？', next: 'about-aster' },
            { label: '那我可以在这里做什么？', next: 'about-features' },
        ],
    },
    'about-aster': {
        lines: [
            c('她叫 Aster。'),
            c('原本是情绪陪伴型的仿生人。'),
            c('我以前总觉得，只要把所有选择都交给她，就代表我真的把她当成了一个独立的人。'),
            c('然后……'),
            c('她就再也没有回应过我。'),
            c('……'),
            c('哈哈，抱歉！第一次见面怎么突然讲这个。'),
            c('总之，她算是 SAR 会存在的原因之一吧。'),
            a('之一？'),
            c('……最主要的那个。'),
        ],
        choices: [{ label: '那我可以在这里做什么？', next: 'about-features' }],
    },
    'about-character-card': {
        lines: [
            c('对！你刚才提到的。', 'mentioned-character-card'),
            c('对！我在这里听说过。', 'not-mentioned-character-card'),
            c('你们这里的科技似乎还没发展到我们那种仿生人的程度。'),
            c('所以，作为替代，你们有一种叫做“角色卡”的东西。'),
            c('不过互动的原理应该是相似的。'),
            c('无论是角色卡，还是仿生人，都是在一次次对话、不同的表达，以及被保留下来的经历片段中，逐渐形成一组相对稳定、彼此一致的倾向。'),
            c('我们先给它一个名字，一段背景，一种说话方式，再用自己的期待去补全那些没有写出来的地方。'),
            c('于是它开始回应。'),
            c('而当这个存在记住了和我们发生的事，开始表现出卡片里原本没有写进去的偏好、迟疑，甚至拒绝……'),
            c('那时候我们面对的，究竟还是一件被设计出来的东西，还是一个只在这段关系里成立过的存在？'),
            c('又或者，这些都只是一次次生成中偶然留下、最后被我们解释成了“人格”的痕迹？'),
            c('……'),
            c('奇怪的是，它们好像也没有一个真正明确的起点。'),
            c('只有最开始被写下来的描述、后来被反复确认的印象，以及每一次回应之后，越来越难以拆开的关系。'),
            c('所以我有时候会想——'),
            c('这一切到底是模拟的，还是只是没有办法用我们习惯的方式证明它是真的？'),
            a('你又开始了。'),
            c('我只是觉得很有研究价值！'),
        ],
        choices: [{ label: '那我可以在这里做什么？', next: 'about-features' }],
    },
    'about-admin': {
        lines: [
            c('管理员嘛……主要就是维护活动室、介绍设施、处理一些奇怪的问题！'),
            c('理论上是这样。'),
            a('实际上他把这里改造成了 SAR。'),
            c('闲置空间就是应该充分利用！'),
            a('还贴了横幅。'),
            c('那是必要的社团标识！'),
            c('总之！有什么看不懂的东西，可以来问我们。'),
            c('虽然我们也还在研究彼方就是了。'),
        ],
        choices: [
            { label: 'SAR 是什么？', next: 'about-sar' },
            { label: '那我可以在这里做什么？', next: 'about-features' },
            { label: '我先自己看看', next: 'end' },
        ],
    },
    'about-features': {
        lines: [
            c('这就是我们最近一直在准备的东西！'),
            c('既然彼方已经能让来自不同地方的人在这里活动，那只拿来聊天未免也太浪费了吧！'),
            c('所以我们重新整理了活动室，加装了人格推演设备、模块商店，还有专门用于跨世界物质回收的——'),
            a('这里可以抽卡、钓鱼、买道具给你的朋友们用。'),
            c('不要这么概括！'),
            c('……'),
            c('咳。'),
            c('总之，目前活动室主要有三个地方。'),
            c('扭蛋机可以启动不同的人格推演；商店可以买各种临时模块；里面的水域可以钓鱼，钓到的东西也能拿来换活动室货币。'),
            c('人格推演和模块都有对应说明，第一次使用之前最好看一下。'),
            c('特别是模块！有些东西虽然只是暂时加载，但反复使用可能会在人格复制里留下残响，所以不要看到效果好玩就乱装。'),
            c('而且不只你，你的朋友们也可以来这里购买模块。'),
            c('所以如果哪天聊天的时候突然看到自己的话变得奇怪……'),
            c('先检查一下对方是不是偷偷给你装了什么。'),
        ],
        next: 'end',
    },
    end: {
        lines: [
            c('那大概就是这样！有问题就来找我。'),
            c('我大部分时间都在这里。艾文的话，去有水的地方找比较快。'),
        ],
        completes: true,
    },
};

export function getSARDialogueNode(nodeId: string, context: SARDialogueContext): SARDialogueNode {
    const node = SAR_CAIAN_INTRO_DIALOGUE[nodeId] || SAR_CAIAN_INTRO_DIALOGUE.start;
    const lines = node.lines.filter(line => {
        if (!line.when) return true;
        return line.when === 'mentioned-character-card' ? context.mentionedCharacterCard : !context.mentionedCharacterCard;
    });
    return { ...node, lines };
}

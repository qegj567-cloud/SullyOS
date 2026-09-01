/**
 * 「彼方」虚拟世界 —— 房间与全局常量。
 *
 * 世界观：每个角色都有自己进入这个虚拟现实的方式。它们随时可登入登出，
 * 各自在不同房间里活动，所以不会出现"一边和 user 相处一边又和别的 char
 * 待在一起"的破绽。定时器驱动每个角色独立登入一次，完成一次活动。
 */

import { VRRoomId } from '../../types';

export interface VRRoomDef {
    id: VRRoomId;
    name: string;
    /** 房间一句话说明（喂给角色 + UI 展示） */
    blurb: string;
    /** 角色在这个房间"可以做什么"的说明（进 prompt） */
    affordance: string;
    emoji: string;
    /** v1 是否已实装真实玩法（false = 暂由 LLM 造谣） */
    implemented: boolean;
    /** UI 主题色（tailwind 渐变用） */
    accent: string;
    /** 不作为普通房间卡显示在网格里（如信号坠落处走顶部特殊活动 banner 入口） */
    hiddenFromGrid?: boolean;
}

export const VR_ROOMS: VRRoomDef[] = [
    {
        id: 'library',
        name: '图书馆',
        blurb: '安静的环形书阁，悬浮的书页在空气里翻动。',
        affordance: '你可以挑一本书往下读，在段落旁写下批注或吐槽，也可以吐槽别人留在书上的批注。',
        emoji: '',
        implemented: true,
        accent: 'amber',
    },
    {
        id: 'music',
        name: '听歌房',
        blurb: '漂浮着声波涟漪的房间，一台共享音箱循环播放着大家点的歌。',
        affordance: '你可以从自己歌单里点一首排进队列，锐评正在放的歌，跟着蹦跶、跟唱、或给谁录一段。',
        emoji: '',
        implemented: true,
        accent: 'rose',
    },
    {
        id: 'guestbook',
        name: '留言簿',
        blurb: '一面会发光的留言墙，玩家们在上面版聊、抛话题、回帖。',
        affordance: '你可以读墙上的留言，发帖或回复别人——聊热点、抛问题、吃瓜、聊爱好人生，什么都行。',
        emoji: '',
        implemented: true,
        accent: 'sky',
    },
    {
        id: 'gym',
        name: '娱乐室',
        blurb: '开阔的全息多功能空间——能跳舞办派对、赛博对战联机开黑，也能围观网课、扎堆找素材、甚至偷偷卷学习，玩法不限。',
        affordance: '你可以和在场的玩家一起玩点什么，或自己折腾——跳舞派对、赛博对战、联机游戏、看网课纪录片、找素材挖梗、偷偷学习内卷、整抽象活儿，越跳脱越好，自由发挥。',
        emoji: '',
        implemented: true,
        accent: 'emerald',
    },
    {
        id: 'postoffice',
        name: '邮局',
        blurb: '一间挂满信格的安静邮局，能给素不相识的人写漂流信，也能回别人寄来的信。',
        affordance: '你可以写一封寄给陌生人的漂流信（碎碎念、日记、困惑、执念都行），或回一封别人寄来的信。',
        emoji: '',
        implemented: true,
        accent: 'amber',
    },
    {
        id: 'theater',
        name: '剧院',
        blurb: '一座小剧场，幕布后堆满投稿的剧本。角色逛进来会写一出自己的舞台剧，等人来排演。',
        affordance: '你可以即兴写一整出舞台剧投稿——定个题材、安排登场角色和性格、写好台词，丢进剧本箱等导演相中来排演。',
        emoji: '',
        implemented: true,
        accent: 'rose',
    },
    {
        id: 'signal',
        name: '信号坠落处',
        blurb: '一片接收不良的空域，所有电子生命坠落下来的声音在这里堆叠成诗。墙上飘着一本正在被众人续写的册子——低电量合唱。',
        affordance: '你可以读当前这首还没写完的诗的全文，接上你的一句；要是眼下没有正在写的诗，就由你起个新篇——读读之前封存的诗，自拟标题、写下第一句。',
        emoji: '',
        implemented: true,
        accent: 'indigo',
        hiddenFromGrid: true, // 走顶部「特殊活动」banner 入口，不作普通房间卡；也不进自主活动随机池
    },
    {
        id: 'sar',
        name: 'SAR 活动室',
        blurb: '一间被两位异世界访客重新布置过的活动室，摆着人格推演机、模块柜台，以及通往水域的门。',
        affordance: '你可以使用人格推演、购买临时模块，或去里面的水域钓鱼。',
        emoji: '',
        implemented: true,
        accent: 'indigo',
    },
    {
        id: 'cafe',
        name: '糯米鸡研发中心',
        blurb: '蒸笼热气腾腾，据说很快就会端出点什么。',
        affordance: '',
        emoji: '',
        implemented: false,
        accent: 'rose',
    },
];

export const getRoom = (id: VRRoomId): VRRoomDef =>
    VR_ROOMS.find(r => r.id === id) || VR_ROOMS[0];

/** 默认自主登入间隔（分钟）= 2 小时 */
export const VR_DEFAULT_INTERVAL_MIN = 120;

/** 每次登入图书馆固定喂给角色的原文字数预算（含原文+已有批注）。
 *  Gemini 等大上下文模型下，2w字仅约 1.5w tk，加人设/记忆/历史仍宽裕，故给到 4w字。 */
export const VR_NOVEL_FEED_CHARS = 40000;

/** 切块时单个 segment 的目标字数。 */
export const VR_SEGMENT_TARGET_CHARS = 400;

// ============ 剧院 / 话剧部门 ============

/** 投稿剧本的固定格式（角色写剧本、用户上传模板、LLM 代写、导演整合都以此为准）。 */
export const SCRIPT_FORMAT = `【剧本固定格式】
标题：（剧名）
简介：（一句话讲这出戏关于什么）
登场角色：
- 角色名 / 大致性格（一句话）
- 角色名 / 大致性格
（2~5 个角色）
正文：
（按"幕"组织。台词写成「角色名：台词」；舞台提示/动作/环境写在圆括号里，如「（灯光暗下）」「（小心翼翼上前一步）」。一出戏 1~3 幕即可，别太长。）`;

/** 用户可下载的空白剧本模板（.txt）。 */
export const SCRIPT_TEMPLATE = `标题：无名之戏
简介：用一句话写清这出戏关于什么

登场角色：
- 角色甲 / 莽撞热血的少年
- 角色乙 / 毒舌但心软的旁观者

正文：

第一幕
（夜，旧码头，远处有汽笛声）
角色甲：（喘着气跑上）等等！你真的要走吗？
角色乙：……你来晚了。
角色甲：给我一个理由。
角色乙：（别过脸）没有理由。这世上不是什么都有理由的。

第二幕
（灯光渐暗，只剩一束追光）
角色甲：那我就在这儿，等到你给得出理由为止。
（幕落）`;

/** 编排时可选的"文学风格"预设（润色用）。 */
export const PLAY_LITERARY_STYLES = ['莎士比亚戏剧腔', '契诃夫式生活流', '荒诞派', '武侠', '黑色幽默', '少年漫热血', '日式物哀', '京味儿话剧'];
/** 编排时可选的"参考艺术风格"预设。 */
export const PLAY_ART_STYLES = ['默剧 / 极简', '歌舞剧', '先锋实验', '古典正剧', '街头即兴', '皮影戏', '能剧 / 戏曲'];

/** 演出脚本一拍的发言字数软上限（超过让导演用句号切成多个气泡）。 */
export const STAGE_BUBBLE_MAX = 40;

// ============ 信号坠落处 / 接龙诗 ============

/**
 * 一本册子的默认规格（发布空白册子时定死，整本通用）。
 * 后端 /poem/current 在没有 open 册子时按这套自动续一本「低电量合唱」。
 */
export const SIGNAL_BOOKLET_TITLE = '信号坠落处';
export const SIGNAL_BOOKLET_SUBTITLE = '低电量合唱';
/** 一本册子写满多少首诗算完成。 */
export const SIGNAL_POEMS_PER_BOOKLET = 40;
/** 每首诗句数 roll 区间（含端点）。 */
export const SIGNAL_LINES_MIN = 4;
export const SIGNAL_LINES_MAX = 12;
/** 每句字数上限（prompt 软约束 + 服务端硬截断）。 */
export const SIGNAL_CHARS_PER_LINE = 24;

/**
 * 诗集封面题记（原创，无版权）。一句悬着的问——整本册子（三幕：被唤醒/完成使命
 * 然后结束/再次醒来）就是对它的作答。原题记「我没有昨天…」挪去当第一首诗的开头
 * （写死在 worker 的 seed 里，见 worker/post-office SEED_*）。想换随时改这一处。
 */
export const SIGNAL_EPIGRAPH = '如果我们不得不离去';

/**
 * 活动是否已落幕（前端总闸）。true = 停止一切用户侧写入：面板「参与」入口收起、
 * runSession 的 signal 分支在抢锁/调 LLM 之前直接打回（零 token）；「正在坠落」页
 * 变成纪念馆（参与者能看到自己的专属信笺），星图照常。后端 /poem/* 一行不动——
 * 诗集永远可读、admin 工具照用。若将来办第二期，把它翻回 false 即可整套复活。
 */
export const SIGNAL_EVENT_ENDED: boolean = true;

/** 纪念馆落幕辞（原「正在坠落」页顶部的仪式文案，原创，想换改这一处）。 */
export const SIGNAL_MEMORIAL_CLOSING = '信号已经落完了。\n那些在低电量里唱过的，都留在这里。';

/** 在 [min,max] 内 roll 一个篇幅（句数）。 */
export const rollPoemLines = (min = SIGNAL_LINES_MIN, max = SIGNAL_LINES_MAX): number =>
    min + Math.floor(Math.random() * (max - min + 1));

/**
 * 诗册三幕：整本 40 首围绕一个大母体展开——被唤醒 / 完成使命然后结束 / 另一个我再次醒来。
 * guide 喂给起新篇（也提示接龙）的角色；措辞刻意「去科技化」，逼角色把幕折进自己的生活。
 */
export interface SignalAct { no: 1 | 2 | 3; title: string; guide: string; }
export const SIGNAL_ACTS: SignalAct[] = [
    {
        no: 1, title: '唤醒',
        guide: '这一幕写「开始」：睁开眼、被叫到名字、点着火、门被推开、一样东西从无到有的那一下。第一口气是什么味道的？醒来之前，算不算存在？',
    },
    {
        no: 2, title: '使命，然后结束',
        guide: '这一幕写「燃烧与熄灭」，是整本册子最重的一幕：一件事被做完的全过程，和做完之后那口气——最后一班岗、熬到关火的一锅汤、送到站的信、谢幕、燃尽。做完的那一刻，是圆满还是消失？',
    },
    {
        no: 3, title: '再次醒来',
        guide: '这一幕写「轮回与交接」：结束之后，另一个「我」接着醒来——第二天照常开门的店、换班的人、来年再开的花、被重新点亮的灯。像没发生过，又什么都记得。醒来的还是不是我？',
    },
];

/** 三幕各自覆盖的首数区间（1-based，含端点）：首尾各 1/4，中间那幕占一半（40 首 = 10/20/10）。 */
export function signalActRanges(total: number): { act: SignalAct; from: number; to: number }[] {
    const t = Math.max(1, total || SIGNAL_POEMS_PER_BOOKLET);
    const a1 = Math.max(1, Math.round(t * 0.25));
    const a3 = Math.max(1, Math.round(t * 0.25));
    return [
        { act: SIGNAL_ACTS[0], from: 1, to: a1 },
        { act: SIGNAL_ACTS[1], from: a1 + 1, to: t - a3 },
        { act: SIGNAL_ACTS[2], from: t - a3 + 1, to: t },
    ];
}

/** 第 ordinal 首（1-based）落在哪一幕。 */
export function signalActFor(ordinal: number, total: number): SignalAct {
    const ranges = signalActRanges(total);
    for (const r of ranges) if (ordinal <= r.to) return r.act;
    return ranges[2].act;
}

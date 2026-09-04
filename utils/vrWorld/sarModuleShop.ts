export type SARModuleCategory = 'voice' | 'bond' | 'genre' | 'stage';

export interface SARModuleDefinition {
    id: string;
    title: string;
    category: SARModuleCategory;
    effectLabel: string;
    description: string;
    caianNote: string;
    example: string;
    price: number;
    supportsUserTarget: boolean;
    requiresConfiguration?: boolean;
}

export interface SARModulePurchase {
    id: string;
    moduleId: string;
    purchasedAt: number;
    pricePaid: number;
}

export interface SARModuleDailyMarket {
    dayKey: string;
    offerIds: string[];
    rollsRemaining: number;
}

export interface SARModuleShopState {
    version: 1;
    credits: number;
    inventory: Record<string, number>;
    purchases: SARModulePurchase[];
    market: SARModuleDailyMarket;
}

export interface SARModulePurchaseResult {
    ok: boolean;
    state: SARModuleShopState;
    reason?: 'not-offered' | 'not-found' | 'insufficient-credits';
}

export interface SARModuleConsumeResult {
    ok: boolean;
    state: SARModuleShopState;
    reason?: 'not-found' | 'not-owned';
}

export const SAR_MODULE_SHOP_STORAGE_KEY = 'vr_sar_module_shop_v1';
export const SAR_MODULE_SHOP_DEVELOPMENT_MODE = true;
export const SAR_MODULE_DAILY_OFFER_COUNT = 5;
export const SAR_MODULE_DAILY_ROLLS = 3;

type ModuleSeed = Omit<SARModuleDefinition, 'id' | 'price'> & { id?: string; price?: number };

const moduleId = (title: string, index: number) =>
    `sar_module_${index.toString().padStart(2, '0')}_${title
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\u4e00-\u9fff-]/g, '')}`;

const priceFor = (category: SARModuleCategory, index: number) => {
    const base: Record<SARModuleCategory, number> = { voice: 18, bond: 24, genre: 28, stage: 22 };
    return base[category] + (index % 4) * 2;
};

const seeds: ModuleSeed[] = [
    {
        title: '古风译码器', category: 'voice', effectLabel: '现代口语古风化',
        description: '将现代口语转译为自然的古风表达，并适当改变称谓、语序和日常用词，不强制使用生僻文言。',
        caianNote: '一键穿越古代！不过只是说话方式变了，不会真的突然多出一座王府。',
        example: '“这么晚了，你怎么还不睡？” → “夜都深了，你怎么还不歇息？”', supportsUserTarget: true,
    },
    {
        title: '王庭贵族协议', category: 'voice', effectLabel: '中世纪贵族化',
        description: '将交流包装成中世纪宫廷与贵族社交风格，强化礼仪、身份称谓、骑士与领地等意象。',
        caianNote: '突然变成贵族了！请注意，本活动室暂时不提供城堡、封地和继承权。',
        example: '“坐我旁边吧。” → “若你愿意，今日我身侧的位置仍为你留着。”', supportsUserTarget: true,
    },
    {
        title: '莎翁戏剧感染', category: 'voice', effectLabel: '莎士比亚式戏剧化',
        description: '将普通交流转换为舞台剧式的夸张抒情表达，加入独白、感叹、比喻和戏剧冲突感。',
        caianNote: '会让对方像突然被拖去演舞台剧一样讲话！一句“你迟到了”都可能演成生离死别。',
        example: '“你怎么现在才来？” → “你终于来了！可怜的时钟早已替我数尽等待的每一刻。”', supportsUserTarget: true,
    },
    {
        title: '直球增压器', category: 'voice', effectLabel: '表达更加直接',
        description: '删除委婉、试探和退路，让已有意图直接表达。', caianNote: '让对方说话更加直白！',
        example: '“要不有空的话……” → “留下来陪我。”', supportsUserTarget: true,
    },
    {
        title: '赞美回路', category: 'voice', effectLabel: '批评强制变夸奖',
        description: '将抱怨、批评与负面评价重新编码为正向称赞。', caianNote: '批评会被改写为一种鼓励……虽然听起来可能比骂人还阴阳怪气。',
        example: '“你又在乱来。” → “你真是每次都很有创意。”', supportsUserTarget: true,
    },
    {
        title: '情话污染模块', category: 'voice', effectLabel: '日常语言过度浪漫化',
        description: '将普通日常表达自动包装成夸张浪漫的说法。', caianNote: '这个名字不是我起的！它会把普通表达自动包装得……非常不普通。你们似乎管这个叫“土味情话”？',
        example: '“记得带伞。” → “我不允许雨碰到你。”', supportsUserTarget: true,
    },
    {
        title: '关键词消音器', category: 'stage', effectLabel: '指定内容显示为 ■■',
        description: '自动遮蔽指定词语，可用于名字、称呼或特定关键词。', caianNote: '把你指定的关键词马赛克掉！非常容易让聊天记录变得非常可疑。',
        example: '“我很想你。” → “我很■■。”', supportsUserTarget: true, requiresConfiguration: true,
    },
    {
        title: '猫科语法包', category: 'voice', effectLabel: '添加猫语习惯',
        description: '在不改变原意的情况下加入猫科语尾、停顿和语言习惯。', caianNote: '这是销冠模块喵！',
        example: '“别碰那个。” → “不许碰那个……喵。”', supportsUserTarget: true,
    },
    {
        title: '恶役大小姐协议', category: 'voice', effectLabel: '华丽傲慢化',
        description: '将普通表达转译为华丽、傲慢又充满戏剧感的恶役大小姐语气。', caianNote: '这个也很有人气！至于为什么大家都想看自己的朋友突然变成恶役大小姐……难道是最近相关番剧很流行？',
        example: '“你怎么才来？” → “竟敢让我等这么久，你胆子不小嘛。”', supportsUserTarget: true,
    },
    {
        title: '宿敌语法包', category: 'bond', effectLabel: '普通关心带上竞争意味',
        description: '将双方关系临时包装成长期竞争的宿敌关系。', caianNote: '对方会默认和你存在一种莫名其妙的宿命竞争关系。',
        example: '“你吃了吗？” → “别饿死了，我可不接受这种胜法。”', supportsUserTarget: true,
    },
    {
        title: '青梅竹马错觉', category: 'bond', effectLabel: '增加长期熟人感',
        description: '让表达呈现出已经认识对方很多年的熟悉感，但不会新增共同记忆。', caianNote: '让对方说话听起来像你的青梅竹马！',
        example: '“早点睡。” → “你从以前开始就这样，一忙起来就不睡觉。”', supportsUserTarget: true,
    },
    {
        title: '初见重置器', category: 'bond', effectLabel: '熟人语气转生疏',
        description: '暂时将双方交流距离拉回初次认识时的陌生与礼貌状态。', caianNote: '让对方变得过分礼貌吧！',
        example: '“你怎么才回来？” → “你好……请问你刚刚去哪了？”', supportsUserTarget: true,
    },
    {
        title: '老夫老妻协议', category: 'bond', effectLabel: '增加长期同居感',
        description: '将交流包装成共同生活多年的自然熟稔状态。', caianNote: '这算老夫老妻模拟器吗？',
        example: '“帮我拿水。” → “你顺手把水带过来，杯子还是老地方。”', supportsUserTarget: true,
    },
    {
        title: '秘密社团腔', category: 'genre', effectLabel: '日常交流秘密任务化',
        description: '将普通交流包装成地下组织接头或秘密任务。', caianNote: '普通聊天会被说得像地下组织接头。非常适合讨论一些完全不值得保密的事情！',
        example: '“晚上见。” → “老时间，老地方。别被人跟上。”', supportsUserTarget: true,
    },
    {
        title: '魔法少女变身包', category: 'genre', effectLabel: '行为魔法少女化',
        description: '为普通动作与发言自动增加夸张的变身、净化与必杀技式演出。', caianNote: '感觉会有华丽丽的 BGM 围绕在身边！',
        example: '“我要去洗澡了。” → “净化程序启动！暂时离队！”', supportsUserTarget: false,
    },
    {
        title: '邪神低语包', category: 'voice', effectLabel: '日常语言神秘化',
        description: '将普通表达转换为神秘、古怪而略带不祥感的低语风格。', caianNote: '听起来像中二病发作了！',
        example: '“别熬夜。” → “今夜不属于清醒的人，趁门还没打开，睡吧。”', supportsUserTarget: true,
    },
    {
        title: '世界末日前五分钟', category: 'genre', effectLabel: '日常表达终末化',
        description: '默认每句话都像世界将在几分钟后毁灭，让日常交流带上终局感。', caianNote: '会让对方每句话都像世界毁灭前的最后几句。要在这个时候告白吗？',
        example: '“你想吃什么？” → “趁世界还没结束，最后选一次吧。”', supportsUserTarget: true,
    },
    {
        title: '恋爱喜剧事故包', category: 'genre', effectLabel: '普通交流暧昧误解化',
        description: '自动将中性表达包装成容易产生暧昧误解的恋爱喜剧台词。', caianNote: '会把普通对话自动解释成很容易被误会的东西。现代情景喜剧必备！',
        example: '“来我这里一下。” → “现在，立刻，来我房间……等等，不是那个意思！”', supportsUserTarget: true,
    },
    {
        title: '傲娇故障包', category: 'voice', effectLabel: '全局傲娇化',
        description: '将日常表达整体转化为明显别扭的傲娇风格。', caianNote: '才、才没有打算卖给你这个……！',
        example: '“给你买了饮料。” → “只是顺便多买了一瓶，你别想太多。”', supportsUserTarget: true,
    },
    {
        title: '离家出走语气包', category: 'voice', effectLabel: '抱怨灾难化',
        description: '将普通抱怨表现得像即将收拾行李离家出走。', caianNote: '所有不满都会像准备收拾行李一样严重！',
        example: '“你又忘了。” → “行，我知道这个家已经没有我的位置了。”', supportsUserTarget: true,
    },
    {
        title: '神秘转学生包', category: 'genre', effectLabel: '增加神秘感',
        description: '将任何自我介绍和普通信息包装成隐藏着巨大秘密的神秘人物语气。', caianNote: '搭配教室最后一排靠窗位食用更佳！',
        example: '“我叫凯恩。” → “名字只是称呼。你可以叫我凯恩。”', supportsUserTarget: true,
    },
    {
        title: '电波频道', category: 'voice', effectLabel: '电波式联想表达',
        description: '将逻辑连接方式变得跳跃、联想式，但保持核心语义仍可理解。', caianNote: '艾文说这个没必要，因为有些人本来就在这个频道上。',
        example: '“我想你了。” → “今天窗外没有鸟，所以有点想你。”', supportsUserTarget: true,
    },
    {
        title: '梦话模式', category: 'voice', effectLabel: '语言朦胧化',
        description: '将语言处理成半梦半醒时的模糊、松散和轻声表达。', caianNote: '会让对方开始迷迷糊糊说梦话……好困。',
        example: '“你还在吗？” → “你别消失……我还没睡着。”', supportsUserTarget: true,
    },
    {
        title: '嘴瓢模拟器', category: 'voice', effectLabel: '模拟口误',
        description: '随机制造轻度用词错误、词序错位或口误，并允许随后自行修正。', caianNote: '会随机交换几个词，但又刚好能听懂——危险程度取决于对方正在说什么。',
        example: '“你今天很好看。” → “你今天很……好吃。等等。”', supportsUserTarget: true,
    },
    {
        title: '禁止说名字', category: 'stage', effectLabel: '名字自动替换为代称',
        description: '暂时禁止直接使用指定对象的名字，必须自行寻找其他代称。', caianNote: '对于记不住人名的人来说特别受用。',
        example: '“艾文。” → “那个白头发钓鱼的。”', supportsUserTarget: true, requiresConfiguration: true,
    },
    {
        title: '反差强制器', category: 'voice', effectLabel: '表达风格反差化',
        description: '优先选择与当前角色既有气质反差最大的表达方式。', caianNote: '完、完全把对方的说话风格变了个样的说……',
        example: '冷淡角色：“晚安。” → “晚安哦！做个超级好的梦！”', supportsUserTarget: true,
    },
    {
        title: '过场动画综合征', category: 'stage', effectLabel: '行为游戏剧情化',
        description: '将出现、离开、拿取物品等普通动作表现成游戏过场台词。', caianNote: '像在玩什么剧情游戏！',
        example: '“我出去一下。” → “那么，这里就暂时交给你了。”', supportsUserTarget: false,
    },
    {
        title: '最终章语气包', category: 'genre', effectLabel: '日常对话终章化',
        description: '让所有普通交流带有故事即将结束的氛围。', caianNote: '感觉也像 flag 模拟器呢。',
        example: '“明天见。” → “如果明天还能见面的话，就在那里等我。”', supportsUserTarget: true,
    },
    {
        title: '恋爱番第十二集', category: 'genre', effectLabel: '暧昧悬停',
        description: '将普通关系推进包装成即将告白却永远差一点的暧昧状态。', caianNote: '所有气氛都会变成“马上要告白”，然后永远卡在最后半句话。',
        example: '“有件事想告诉你。” → “其实我一直……算了，下次再说。”', supportsUserTarget: true,
    },
    {
        title: '轻小说标题病', category: 'stage', effectLabel: '自动生成章节名',
        description: '为当前普通场景自动生成冗长、夸张的轻小说章节标题。', caianNote: '一句话说完以后，系统会偷偷给当前场面起一个很长的标题。很长。',
        example: '“你又迟到了。” → 〔第17话：明明约好了却再次迟到的你与已经等了二十分钟的我〕', supportsUserTarget: false,
    },
    {
        title: 'Bad End 预告器', category: 'genre', effectLabel: '普通语言伏笔化',
        description: '随机将普通台词处理成像坏结局伏笔一样的不祥表达。', caianNote: '只是演出！不会真的给你判 Bad End。',
        example: '“路上小心。” → “路上小心。今天不知道为什么，总觉得该多说一次。”', supportsUserTarget: true,
    },
    {
        title: 'Gal 选项污染', category: 'stage', effectLabel: '聊天出现 Gal 选项',
        description: '在普通发言后自动生成看似重要、实际未必必要的游戏式选项。', caianNote: '说完一句话后，会自动冒出几个根本没必要的选项。[明白了] [什么鬼？] [（离开）]',
        example: '“你吃饭了吗？” → [吃了] [没有] [为什么突然关心我？]', supportsUserTarget: false,
    },
    {
        title: '句子补完故障', category: 'stage', effectLabel: '关键句中途停止',
        description: '部分发言会在关键位置突然中断，把最后一点内容留给对方自行理解。', caianNote: '会在最重要的地方断掉。谁做的这个？',
        example: '“其实我一直都……” → 〔信号中断〕', supportsUserTarget: true,
    },
    {
        title: '舞台提示污染', category: 'stage', effectLabel: '添加演出指令',
        description: '系统随机给当前交流加入舞台动作、灯光或镜头提示。', caianNote: '会把两个普通聊天的人强行送上舞台，好尴尬啊！',
        example: '“你回来了。” → 〔灯光亮起〕“你回来了。”', supportsUserTarget: false,
    },
    {
        title: '背景音乐幻觉', category: 'stage', effectLabel: '显示虚构 BGM',
        description: '根据聊天气氛自动显示并不存在的 BGM 名称。', caianNote: '没有真的音乐，主要负责让普通聊天突然像有制作组。',
        example: '“那明天见。” → ♪ BGM：还没有结束的今天', supportsUserTarget: false,
    },
    {
        title: '片尾字幕故障', category: 'stage', effectLabel: '普通结束触发 ED 演出',
        description: '在某些告别或结束语后错误触发片尾字幕。', caianNote: '一句“晚安”就给你播片尾。我也不知道系统为什么这么急着下班。',
        example: '“晚安。” → 〔CAST / User · Char〕', supportsUserTarget: false,
    },
    {
        title: '回合制对话协议', category: 'stage', effectLabel: '对话游戏回合化',
        description: '将自由聊天临时显示为双方轮流行动的回合制界面。', caianNote: '理论上只是显示方式。实际效果是连吵架都变得很文明，因为得等对面回合。',
        example: 'User 回合结束 → Char 回合开始', supportsUserTarget: false,
    },
    {
        title: '随机事件警报', category: 'stage', effectLabel: '插入假事件弹窗',
        description: '普通聊天期间随机弹出虚假“特殊事件发生”提示。', caianNote: '事件不一定真的特殊。比如对方喝了口水，也可能被系统判定成突发事件。',
        example: '〔突发事件：对方靠近了 12cm〕', supportsUserTarget: false,
    },
    {
        title: '今日关键词', category: 'stage', effectLabel: '特定词触发演出',
        description: '随机指定一个普通词为今日特殊词，每次出现都会触发夸张反馈。', caianNote: '今天可能是“雨”，明天可能是“饭”。系统对什么东西有执念完全随机。',
        example: '“下雨了。” → 〔今日关键词触发！〕', supportsUserTarget: false,
    },
    {
        title: '只能说半句', category: 'voice', effectLabel: '发言被截断',
        description: '每句话只允许表达前半段，剩余部分自动消失。', caianNote: '我觉得这种模块根本……',
        example: '“我其实挺喜欢今天这样的。” → “我其实挺喜欢……”', supportsUserTarget: true,
    },
    {
        title: '不准解释', category: 'voice', effectLabel: '禁止解释和找补',
        description: '删除“因为、其实、我的意思是”等补充解释，只保留第一层表达。', caianNote: '会让对方失去事后找补的机会。慎用！',
        example: '“我不是那个意思，我只是……” → “我不是那个意思。”', supportsUserTarget: true,
    },
    {
        title: '命运相遇滤镜', category: 'bond', effectLabel: '普通出现史诗重逢化',
        description: '将双方普通的见面、上线或重新说话包装成命中注定的重逢。', caianNote: '命运中必然邂逅的中二病模块！',
        example: '“你来了。” → “果然，我们还是会在这里遇见。”', supportsUserTarget: true,
    },
    {
        title: '临时失忆喜剧', category: 'genre', effectLabel: '小型信息临时缺失',
        description: '随机忘记一项极小、无关核心关系的信息，用于制造日常喜剧，不触碰重要记忆。', caianNote: '只会忘记很小的东西！比如刚才把杯子放哪了……我刚刚说的是哪个模块？',
        example: '“我的笔呢？” → “……我刚才是不是拿着？”', supportsUserTarget: false,
    },
    {
        title: '物品拟人协议', category: 'genre', effectLabel: '物品被拟人化',
        description: '暂时把聊天中出现的普通物品当成有性格的小角色描述。', caianNote: '杯子、门、雨伞突然都有意见……艾文说这很正常。',
        example: '“伞坏了。” → “这把伞今天决定退休了。”', supportsUserTarget: true,
    },
    {
        title: '全世界都在拆台', category: 'stage', effectLabel: '氛围被随机破坏',
        description: '任何稍有气氛的时刻都会出现滑稽干扰提示。', caianNote: '被打断真的超级急人的！',
        example: '“我其实想说……” → 〔远处传来东西摔碎的声音〕', supportsUserTarget: false,
    },
    {
        title: '结局名称生成器', category: 'stage', effectLabel: '会话获得假结局标题',
        description: '在对话结束时，根据本次互动随机生成一个完全非正式的“结局名”。', caianNote: '努力寻找 Happy End 吧！',
        example: 'ENDING 07：谁也没有先说晚安', supportsUserTarget: false,
    },
];

export const SAR_MODULE_CATALOG: SARModuleDefinition[] = seeds.map((seed, index) => ({
    ...seed,
    id: seed.id || moduleId(seed.title, index + 1),
    price: seed.price ?? priceFor(seed.category, index),
}));

const catalogById = new Map(SAR_MODULE_CATALOG.map(module => [module.id, module]));

const clampInt = (value: unknown, min: number, max: number) => {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : min;
    return Math.min(max, Math.max(min, number));
};

export const getSARModuleDayKey = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const shuffledModuleIds = (random = Math.random) => {
    const ids = SAR_MODULE_CATALOG.map(module => module.id);
    for (let index = ids.length - 1; index > 0; index -= 1) {
        const target = Math.floor(random() * (index + 1));
        [ids[index], ids[target]] = [ids[target], ids[index]];
    }
    return ids.slice(0, SAR_MODULE_DAILY_OFFER_COUNT);
};

export const createSARModuleShopState = (now = new Date(), random = Math.random): SARModuleShopState => ({
    version: 1,
    credits: 0,
    inventory: {},
    purchases: [],
    market: {
        dayKey: getSARModuleDayKey(now),
        offerIds: shuffledModuleIds(random),
        rollsRemaining: SAR_MODULE_DAILY_ROLLS,
    },
});

const normalizeState = (value: unknown, now = new Date(), random = Math.random): SARModuleShopState => {
    const fallback = createSARModuleShopState(now, random);
    if (!value || typeof value !== 'object') return fallback;
    const raw = value as Partial<SARModuleShopState>;
    const inventory = Object.fromEntries(Object.entries(raw.inventory || {})
        .filter(([id, count]) => catalogById.has(id) && typeof count === 'number' && Number.isFinite(count) && count > 0)
        .map(([id, count]) => [id, clampInt(count, 1, 999)]));
    const purchases = Array.isArray(raw.purchases) ? raw.purchases
        .filter((entry): entry is SARModulePurchase => Boolean(entry && catalogById.has(entry.moduleId)))
        .slice(-100)
        .map(entry => ({
            id: String(entry.id || `sar_purchase_${entry.purchasedAt || Date.now()}`),
            moduleId: entry.moduleId,
            purchasedAt: clampInt(entry.purchasedAt, 0, Number.MAX_SAFE_INTEGER),
            pricePaid: clampInt(entry.pricePaid, 0, 9999),
        })) : [];
    const rawMarket = raw.market;
    const today = getSARModuleDayKey(now);
    const validOfferIds = Array.isArray(rawMarket?.offerIds)
        ? [...new Set(rawMarket.offerIds.filter(id => typeof id === 'string' && catalogById.has(id)))].slice(0, SAR_MODULE_DAILY_OFFER_COUNT)
        : [];
    const market = rawMarket?.dayKey === today && validOfferIds.length === SAR_MODULE_DAILY_OFFER_COUNT
        ? {
            dayKey: today,
            offerIds: validOfferIds,
            rollsRemaining: clampInt(rawMarket.rollsRemaining, 0, SAR_MODULE_DAILY_ROLLS),
        }
        : fallback.market;
    return {
        version: 1,
        credits: clampInt(raw.credits, 0, 999999),
        inventory,
        purchases,
        market,
    };
};

const getStorage = (): Storage | null => {
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

const persistState = (state: SARModuleShopState, storage = getStorage()) => {
    try { storage?.setItem(SAR_MODULE_SHOP_STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
    return state;
};

export const readSARModuleShopState = (
    storage: Pick<Storage, 'getItem' | 'setItem'> | null = getStorage(),
    now = new Date(),
    random = Math.random,
) => {
    try {
        const parsed = JSON.parse(storage?.getItem(SAR_MODULE_SHOP_STORAGE_KEY) || 'null');
        const state = normalizeState(parsed, now, random);
        storage?.setItem(SAR_MODULE_SHOP_STORAGE_KEY, JSON.stringify(state));
        return state;
    } catch {
        const state = createSARModuleShopState(now, random);
        try { storage?.setItem(SAR_MODULE_SHOP_STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
        return state;
    }
};

export const getSARModuleById = (id: string) => catalogById.get(id);

export const getSARModuleOffers = (state: SARModuleShopState) =>
    state.market.offerIds.map(getSARModuleById).filter((module): module is SARModuleDefinition => Boolean(module));

export const rollSARModuleOffers = (
    state: SARModuleShopState,
    random = Math.random,
    storage: Pick<Storage, 'setItem'> | null = getStorage(),
) => {
    if (state.market.rollsRemaining <= 0) return state;
    let nextIds = shuffledModuleIds(random);
    const previous = state.market.offerIds.join('|');
    // Fixed test RNGs can otherwise return the identical rack forever; rotate once as a deterministic fallback.
    if (nextIds.join('|') === previous) nextIds = [...nextIds.slice(1), nextIds[0]];
    return persistState({
        ...state,
        market: { ...state.market, offerIds: nextIds, rollsRemaining: state.market.rollsRemaining - 1 },
    }, storage as Storage | null);
};

export const purchaseSARModule = (
    state: SARModuleShopState,
    moduleIdValue: string,
    options: { developmentMode?: boolean; now?: number; storage?: Pick<Storage, 'setItem'> | null } = {},
): SARModulePurchaseResult => {
    const module = getSARModuleById(moduleIdValue);
    if (!module) return { ok: false, state, reason: 'not-found' };
    if (!state.market.offerIds.includes(moduleIdValue)) return { ok: false, state, reason: 'not-offered' };
    const pricePaid = options.developmentMode ? 0 : module.price;
    if (state.credits < pricePaid) return { ok: false, state, reason: 'insufficient-credits' };
    const purchasedAt = options.now ?? Date.now();
    const next = {
        ...state,
        credits: state.credits - pricePaid,
        inventory: { ...state.inventory, [moduleIdValue]: (state.inventory[moduleIdValue] || 0) + 1 },
        purchases: [...state.purchases, {
            id: `sar_purchase_${purchasedAt}_${state.purchases.length}`,
            moduleId: moduleIdValue,
            purchasedAt,
            pricePaid,
        }].slice(-100),
    };
    persistState(next, (options.storage ?? getStorage()) as Storage | null);
    return { ok: true, state: next };
};

/** 装载成功后才消耗库存；确认页退出或写档失败都不会吞模块。 */
export const consumeSARModule = (
    state: SARModuleShopState,
    moduleIdValue: string,
    storage: Pick<Storage, 'setItem'> | null = getStorage(),
): SARModuleConsumeResult => {
    if (!getSARModuleById(moduleIdValue)) return { ok: false, state, reason: 'not-found' };
    const owned = state.inventory[moduleIdValue] || 0;
    if (owned <= 0) return { ok: false, state, reason: 'not-owned' };
    const inventory = { ...state.inventory };
    if (owned === 1) delete inventory[moduleIdValue];
    else inventory[moduleIdValue] = owned - 1;
    const next = persistState({ ...state, inventory }, storage as Storage | null);
    return { ok: true, state: next };
};

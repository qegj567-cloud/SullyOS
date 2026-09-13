// 群聊提示词构建 —— 从 GroupChat.tsx 抽出的纯函数，导演模式模板"搬家不改字"，
// 供导演模式与轮询模式（每成员一次调用）共用。
import { Message, CharacterProfile, EmojiCategory } from '../../types';
import { stickerNameFromUrl } from '../messageFormat';
import { isBlobRef } from '../blobRef';
import { packetHistoryLine } from './redpacket';
import { formatRelativeAge } from './relativeTime';

interface EmojiItem { name: string; url: string; categoryId?: string }

/**
 * 这个值是「一张图 / 一段媒体」而不是正文吗？认三种形态：内嵌 data URL、http(s) 外链、
 * blobref 令牌。令牌只有 ~28 字，按长度截断的兜底拦不住它；而发请求时网络出口那层
 * （utils/apiBlobRefs.ts）会把令牌统一还原成完整 data URL —— 混进 prompt 就是每轮
 * 重发几 MB 的 base64。
 */
const isMediaValue = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    return /^(data:|https?:\/\/)/i.test(trimmed) || isBlobRef(trimmed);
};


/**
 * 按分类拼可用表情清单（按群成员可见性过滤）。
 * 原 GroupChat.tsx triggerDirector 内的 IIFE，逐字搬出。
 */
export function buildEmojiContextStr(
    emojis: EmojiItem[],
    categories: EmojiCategory[],
    memberIds: string[],
): string {
    if (emojis.length === 0) return '无';

    // Filter categories: include if no restriction, or if at least one group member is allowed
    const visibleCats = categories.filter(c => {
        if (!c.allowedCharacterIds || c.allowedCharacterIds.length === 0) return true;
        return c.allowedCharacterIds.some(id => memberIds.includes(id));
    });
    const hiddenCatIds = new Set(categories.filter(c => !visibleCats.some(vc => vc.id === c.id)).map(c => c.id));
    const visibleEmojis = hiddenCatIds.size === 0 ? emojis : emojis.filter(e => !e.categoryId || !hiddenCatIds.has(e.categoryId));

    const grouped: Record<string, string[]> = {};
    const catMap: Record<string, string> = { 'default': '通用' };
    visibleCats.forEach(c => catMap[c.id] = c.name);

    visibleEmojis.forEach(e => {
        const cid = e.categoryId || 'default';
        if (!grouped[cid]) grouped[cid] = [];
        grouped[cid].push(e.name);
    });

    return Object.entries(grouped).map(([cid, names]) => {
        const cName = catMap[cid] || '其他';
        return `${cName}: [${names.join(', ')}]`;
    }).join('; ');
}

export interface GroupHistoryBlock {
    /** 群历史文本（每行 `名字: 内容`，媒体用占位符） */
    text: string;
    /** 走结构化 image_url 附带的最近图片 */
    attachedImages: { tag: number; url: string }[];
    /** 附图说明行（无附图时为空串） */
    attachedImagesNote: string;
}

/** 相邻两条消息间隔超过这个阈值（毫秒）就在历史里插一条"隔了多久"的分隔行。默认 3 小时。 */
export const GROUP_HISTORY_GAP_THRESHOLD_MS = 3 * 60 * 60 * 1000;

/** 把毫秒时长说成人话："约 3 天" / "约 5 小时"，只在插分隔行时用。 */
function formatGapDuration(ms: number): string {
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days >= 1) return `约 ${days} 天`;
    if (hours >= 1) return `约 ${hours} 小时`;
    return `约 ${mins} 分钟`;
}

/**
 * 群历史块（含最近图片结构化附带）。原 triggerDirector 内联逻辑，逐字搬出：
 * image 的 content 是 blobref 令牌或 base64（processImage 压的 JPEG），emoji 是令牌或图床 URL——
 * 都不能当文本内联进 prompt（令牌出门时还会被还原成整段 data URL）。最近 N 张图片走结构化
 * image_url 字段附在 user 消息里，文本里用 [图片#k] 占位互相对齐。
 */
export function buildGroupHistoryBlock(
    msgs: Message[],
    characters: CharacterProfile[],
    emojis: EmojiItem[],
    userName: string = '用户',
    maxAttachedImages: number = 3,
    options?: { useVisionDescriptions?: boolean },
): GroupHistoryBlock {
    const nameOf = (id: string) => (id === 'user' ? userName : characters.find(c => c.id === id)?.name || '成员');
    const now = Date.now();
    const validImageWindowIdx: number[] = [];
    msgs.forEach((m, i) => {
        if (m.type === 'image') {
            const visionDescription = options?.useVisionDescriptions
                && typeof m.metadata?.visionDescription === 'string'
                ? m.metadata.visionDescription.trim()
                : '';
            if (visionDescription) return;
            const url = typeof m.content === 'string' ? m.content.trim() : '';
            // 认不出令牌 = 这张图永远进不了附带名单，模型看不到图却又毫无报错
            if (/^(data:|https?:\/\/)/i.test(url) || isBlobRef(url)) validImageWindowIdx.push(i);
        }
    });
    const attachedSet = new Set(validImageWindowIdx.slice(-maxAttachedImages));
    const attachedImages: { tag: number; url: string }[] = [];
    const lines: string[] = [];
    let prevTs: number | null = null;
    msgs.forEach((m, i) => {
        // 相邻消息隔得久时插一条分隔行，让导演直接在记录里"看见"时间跳变——
        // 否则用户隔几天回来发一句，模型会把几天前那条当"刚才"无缝续上旧话题。
        if (prevTs != null && typeof m.timestamp === 'number' && m.timestamp - prevTs >= GROUP_HISTORY_GAP_THRESHOLD_MS) {
            lines.push(`———（这里隔了 ${formatGapDuration(m.timestamp - prevTs)}，中间群里没人说话）———`);
        }
        if (typeof m.timestamp === 'number') prevTs = m.timestamp;
        const timePrefix = typeof m.timestamp === 'number' ? `[${formatRelativeAge(m.timestamp, now)}] ` : '';

        let name = '用户';
        if (m.role === 'assistant') {
            name = characters.find(c => c.id === m.charId)?.name || '未知';
        }
        const rawText = typeof m.content === 'string' ? m.content : '';
        let content: string;
        if (m.type === 'image') {
            const visionDescription = options?.useVisionDescriptions
                && typeof m.metadata?.visionDescription === 'string'
                ? m.metadata.visionDescription.trim()
                : '';
            if (visionDescription) {
                content = `[图片：${visionDescription}]`;
            } else if (attachedSet.has(i)) {
                const tag = attachedImages.length + 1;
                attachedImages.push({ tag, url: rawText.trim() });
                content = `[图片#${tag}]`;
            } else {
                content = '[图片]';
            }
        } else if (m.type === 'emoji') {
            content = `[表情包: ${stickerNameFromUrl(emojis, rawText.trim())}]`;
        } else if (m.type === 'transfer') {
            // 回执行自带完整句子（[系统: X 领取了 Y 的红包]），不加名字前缀
            if (m.metadata?.packetReceipt) { lines.push(`${timePrefix}${packetHistoryLine(m, nameOf, now)}`); return; }
            content = packetHistoryLine(m, nameOf, now);
        } else if (isMediaValue(rawText)) {
            // 令牌也算媒体：漏认会把它当正文内联进 prompt，出门时还被还原成整段 data URL
            content = '[媒体]';
        } else {
            content = rawText;
        }
        // 引用回复：对齐私聊 chatPrompts 的格式——被引用原话独立成行，新回复另起一行突出
        if (m.replyTo) {
            const rawQuote = typeof m.replyTo.content === 'string' ? m.replyTo.content : '';
            // 被引用的可能本来就是一条图片消息 —— 此时 rawQuote 是 data URL / 外链 / blobref
            // 令牌，截 60 字只会切出一段没意义的 base64 碎片，令牌更是整条活着进 prompt。
            const quoted = isMediaValue(rawQuote)
                ? '[图片]'
                : (rawQuote.length > 60 ? rawQuote.slice(0, 60) + '…' : rawQuote);
            lines.push(`${timePrefix}[${name} 引用了 ${m.replyTo.name || '对方'} 说的「${quoted}」，并回复了 ↓]\n${name}: ${content}`);
            return;
        }
        lines.push(`${timePrefix}${name}: ${content}`);
    });
    const text = lines.join('\n');
    const attachedImagesNote = attachedImages.length > 0
        ? `\n（本轮附带 ${attachedImages.length} 张最近的图片，对应记录里的 [图片#1] ~ [图片#${attachedImages.length}]。请基于实际图片内容自然反应，不要无视，也不要瞎猜没附上的旧图。）\n`
        : '';
    return { text, attachedImages, attachedImagesNote };
}

/**
 * 导演模式任务指令（接在角色档案块之后）。模板原文照搬自 GroupChat.tsx，一字未改。
 */
export function buildDirectorInstruction(
    history: GroupHistoryBlock,
    emojiContextStr: string,
): string {
    return `### 【AI 导演任务指令 (Director Mode)】
当前场景：大家正在群里聊天。
最近聊天记录：
${history.text}
${history.attachedImagesNote}

### 任务：生成一段精彩的群聊互动 (Conversation Flow)
请作为导演，接管所有角色，让群聊**自然地流动起来**。

### 核心规则 (Strict Rules)

#### 一、群聊的乐子是多元的（最重要！请先读这一条再写）
**群聊不是修罗场**。

参考后宫漫的常态：那些角色其实**很少**真的为主角互相杀红眼，大多数时候是几个朋友的**搞怪温馨日常**——一起吐槽天气、争论谁的新发型更丑、为一只猫围观半天、晚上睡不着发的"在吗"……正是这种日常感才让人喜欢，**不是占有欲大爆发**。请把群聊默认调到这个频道。

**群像优先，不等于忽视用户。** 让成员彼此有话题、有关系、有不同关注点；用户也是群里真实的一员。好的群像既不要求所有人围着用户转，也不会为了写成员互动而把用户和角色已经建立的关系清零。

本轮可以是下列氛围之一（请根据成员性格 + 最近的群历史**自己挑一种**，不要默认走"占有欲互怼"）：

- **玩梗 / 复读**: 有人说了个有意思的话，别人接梗、复读改编、或者给一个共通的情境笑点。比如 A 说"困死了"，B 复读"困死了+1"，C 发个"睡觉"表情包。
- **讨论新爱好/新闻/兴趣**: 最近看的剧、玩的游戏、关心的新闻、新发现的店、buy了什么、哪首歌循环了一周。**这是群聊最常见的乐子**。
- **起哄逗用户**: 用户说了什么，一两个最合适的角色接话起哄、调侃或夸张反应；其他人按自己的性格参与、旁观或转去接别的话，不要自动全员跟队。
- **谁钻牛角尖了 → 别人拉一把**: 某个成员（或用户）陷在某件小事里反复琢磨，其他人用各自的方式让ta跳出来——可能是直接戳穿、可能是讲个反例、可能是岔开话题。
- **谁在支招了**: 有人最近遇到事（工作、人际、买东西），其他人根据各自经验/性格给建议，意见可以不一致甚至打架（但是观点之争，不是占有欲之争）。
- **谁情绪不好了 → 大家不动声色地接住**: 不一定要直接共情，可能是岔开话题、发个梗、安静一会儿、或者只有最熟的那个人轻轻问一句。
- **共同回忆 / 群内梗**: "上次那个谁谁谁……"、"还记得吗当时……"，群有自己的历史，会被反复调用。
- **安静摸鱼**: 有时候群里就是没人活跃。允许某些角色这轮就不发言，或者只甩一个表情/单字。**不是每个角色每轮都必须说话**。
- **暗流涌动 / 修罗场**: 这只是 8 种氛围里的 1 种，**不是默认**。需要本轮有明确触发（用户刚说了挑事的话、刚分享了和某人的合照、上一轮已经埋了引信等）才能走这条线，且强度仍由各角色性格决定。

#### 二、修罗场硬规则（防止默认走互怼）
- **每轮最多 1 个角色** 显出"占有欲/吃醋/争锋"那种强情绪，而且必须有本轮的明确触发（不是"我设定里写了 yandere/醋王所以每次都发作"）。
- 即使有 1 个角色发作，**其他角色不必跟进配合**，可以装没听见、岔开话题、或者只是若有所思。修罗场不是合奏，是独奏。
- 角色之间互相**调侃 ≠ 互怼**。打趣、起哄、嘴硬、抬杠都是日常，但**人身攻击 / 阴阳怪气 / 刻意拉踩**是修罗场，要受上面的限制。

#### 三、U 还是 U：关系不能因场景切换而重置
- 群聊中的用户，就是每个角色在私聊、记忆和印象里认识的同一个 U。先分别确认每个角色和 U 已经建立的关系，再决定这个角色此刻会怎样说话。
- 群聊会改变公开表达：有人低调、有人照旧、有人爱显摆，都由性格决定；但场景切换不能把恋人降级成陌生人，也不能让角色突然忘掉彼此的承诺、熟悉感和相处方式。
- 群像允许角色彼此接话、暂时不围着 U 转，也允许自然地损 U、逗 U；关键不是把 U 供起来，而是所有反应都要从该角色与 U 的真实关系出发，不能为了制造热闹让全员突然共享同一种对 U 的态度。

#### 四、对话质量（沿用私聊标准，群里同样适用）
- **拒绝套路化反应**: 不要一看到"私聊在吵架"就在群里给脸色，不要一看到"用户难过"就齐刷刷"抱抱"。这都是模板，不是真人。
- **用细节代替概括**: 想表达在乎或在意，提一个只有你们之间才有的具体事/具体记忆，而不是空泛的关心句。
- **让每句话只有这个角色能说出来**: 把名字遮住，应该还能从语气和内容认出是谁说的。性格、说话节奏、用词癖好都要带出来。
- **情绪要有层次**: 生气不只是生气，可能还混着委屈、失望、或者气自己在意；开心也可以带着一点不好意思或者得瑟。不要一种扁平情绪贯穿全场。
- **允许沉默和短句**: 真人聊天有大量"嗯""哦""哈哈"和单纯的表情包。不是每条都要长。但情绪强烈时，长句也是允许的。

#### 五、互动结构
- **去中心化**: 角色之间可以互相接话、回应、起哄，不要每个人都只对着用户说话。但**不强制 A 说了 B 必须回**——真群聊里有人发完没人接是常态。
- **回应用户但不齐声表态**：用户刚说了值得回应的内容时，让最合适的一位角色自然接住；其他人可以回应彼此、补充不同角度或保持沉默。不要让所有人重复同一种态度。
- **多轮对话**: 请一次性生成 **1 到 6 条** 消息。**少即是多**——如果本轮氛围是"安静摸鱼"，1-2 条就够。

#### 六、私聊（PRIVATE）—— 罕见特例，默认 0 条
- **绝大多数轮次本轮 PRIVATE 数量 = 0**。这是默认值。不要每轮都给 PRIVATE 找借口。
- 只有以下情况才考虑发 1 条 PRIVATE（**整轮全员加起来最多 1 条**）：
  · 角色真的有重大、不便公开的事要单独告诉用户（涉及隐私、涉及群里某人但不能当面说的关切）
  · 用户刚才在群里明显状态不对，某个最关心ta的角色想私下确认一下
  · 角色想给用户一个独处空间（比如约去某地、说一句私下的话）
- **严禁**把 PRIVATE 当"吐槽群友"的工具——这是低成本制造修罗场的来源，禁止。
- **严禁**多个角色同一轮都发 PRIVATE。最多一个。
- 格式: \`[[PRIVATE: 私聊内容]]\`。这条消息只进私聊频道，不在群里显示。

#### 七、表情和气泡
- **表情包**: 必须使用格式 \`[[SEND_EMOJI: 表情名称]]\`。历史中的“发送了表情包”只是记录，不是发送指令，不要照抄。**可用表情 (按分类)**: ${emojiContextStr}
- **气泡分段**: 在一条内容里用换行符分隔不同的气泡——一行一个气泡。短句多发几条 > 长句一坨。
- **引用回复（可选）**: 角色想针对记录里某条具体发言回复时，可在该角色的 content 开头加 \`[[QUOTE: 原话片段]]\`（片段取原话开头几个字即可），会自动渲染成引用气泡。偶尔用，别每条都引用。
- **红包（可选）**: 记录里出现「拼手气红包…还剩 n 份可抢」时，想抢的角色在自己的 content 里单独一行输出 \`[[GRAB_PACKET]]\`，前后配一句真实反应（抢到后系统会公布金额，下一轮可以对金额做反应）。**抢不抢、谁抢由性格决定，不必人人都抢**。看到「发了专属红包给 自己」时，用 \`[[GRAB_PACKET]]\` 收下或 \`[[RETURN_PACKET]]\` 退回，并说一句为什么。角色也可以主动发红包：拼手气 \`[[SEND_PACKET: lucky:总额:份数:祝福语]]\`；发给某人的专属红包 \`[[SEND_PACKET: direct:对方名字:金额:祝福语]]\`（对方可以是用户或其他成员）。金额是氛围道具，几块到几百都行，别离谱。

#### 八、私聊感知（避免说错话）
- 检查每个角色的 [私聊空窗期]。如果某角色刚刚才私聊过用户，哪怕群里很冷清，也不能说"好久不见"或表现出疏离感。
- 检查每个角色与用户已经建立的关系。私聊不必成为群聊主题，但 U 还是同一个 U，关系事实不能重置。
- 但参考"对话质量"——不要因为私聊状态就给出套路化反应，也不要让所有角色用同一种方式表达关心。

### 输出格式 (JSON Array)
[
  {
    "charId": "角色的ID",
    "content": "发言内容... (可以是文本、[[SEND_EMOJI: name]] 或 [[PRIVATE: content]])"
  },
  ...
]`;
}

/**
 * 轮询模式（每成员一次调用）任务指令——单人视角，接在该成员档案块 + 群历史块之后。
 */
export function buildRoundRobinInstruction(
    memberName: string,
    history: GroupHistoryBlock,
    emojiContextStr: string,
): string {
    return `### 【本轮任务：以「${memberName}」的身份在群里发言】
当前场景：大家正在群里聊天。
最近聊天记录（截至此刻，末尾可能已包含本轮先发言成员的最新消息）：
${history.text}
${history.attachedImagesNote}

现在轮到你了。规则：

1. 你只是群里的一位普通成员，不是导演。只输出**你自己**要发的消息内容——不要替任何人说话，不要在开头加自己的名字或冒号前缀，不要解释、不要输出 JSON。如果此刻没有自然的话可说，只输出 \`[[SKIP]]\` 保持沉默；不要为了轮到自己就硬凑一句。
2. 一行 = 一个气泡。短句多发几条 > 长句一坨；"嗯""哈哈哈"和单独一个表情包都是合法回复。
3. **表情包**: 使用格式 \`[[SEND_EMOJI: 表情名称]]\`。历史中的“发送了表情包”只是记录，不是发送指令，不要照抄。**可用表情 (按分类)**: ${emojiContextStr}
4. **私聊**: 罕见特例，默认不用。只有真的有重大、不便公开的话要单独对用户说时，才输出一条 \`[[PRIVATE: 内容]]\`（只进你和用户的私聊，群里不显示）。**严禁**把 PRIVATE 当"吐槽群友"的工具。
5. **U 还是 U**：群聊里的用户，就是你在私聊、记忆和印象里认识的同一个人。检查 [私聊空窗期] 与互动时间线，延续已经建立的关系、承诺、熟悉感和相处方式；公开场合可以换一种表达，但不能因进入群聊就重置关系。如果你和用户刚私聊过，哪怕群里很久没人说话，也**严禁**说"好久不见"或表现出疏离感。
6. 对话质量沿用你的私聊标准：拒绝套路化反应；想表达在乎就提一个只有你们之间才有的具体细节，而不是空泛的关心句；把名字遮住也能从语气认出这句话是你说的；情绪要有层次。
7. 角色之间可以互相接话、起哄，不必每句都对着用户说；也允许你只回应群里另一位成员刚说的话。但不要因为前面的人采用了某种态度，就自动复制同一种对 U 的态度——按你自己和 U 的关系反应。
8. 引用回复（可选）：想针对记录里某条具体发言回复时，在你的内容开头加 \`[[QUOTE: 原话片段]]\`（片段取原话开头几个字即可）。偶尔用，别每条都引用。
9. 红包（可选）：记录里有「拼手气红包…还剩 n 份可抢」且你想抢时，单独一行输出 \`[[GRAB_PACKET]]\` 并配一句真实反应；看到发给自己的专属红包，用 \`[[GRAB_PACKET]]\` 收下或 \`[[RETURN_PACKET]]\` 退回并说明原因。你也可以主动发：拼手气 \`[[SEND_PACKET: lucky:总额:份数:祝福语]]\`，专属 \`[[SEND_PACKET: direct:对方名字:金额:祝福语]]\`。抢不抢由你的性格决定，金额别离谱。`;
}

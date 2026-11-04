
import { CharacterProfile, UserProfile, DailySchedule, ScheduleSlot, Message, Emoji } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { getDailyScheduleForChar } from './dailySchedule';
import { getScheduleDateKey, getScheduleWallClock } from './scheduleTime';
import { loadCharacterContextRange } from './chatContextRange';
import { ChatPrompts } from './chatPrompts';
import { cleanApiMessages, flattenImageContentParts } from './promptMessageCleanup';
import { getFlowNarrativeKey, isScheduleFeatureOn } from './scheduleFeature';
import {buildHomeSchedulePrompt, hasHomeSchedulePositions, parseHomePosition} from './homeSchedule';

export { getFlowNarrativeKey, isScheduleFeatureOn } from './scheduleFeature';

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

/**
 * 构建生活系（lifestyle）角色的日程生成 prompt。
 *
 * 设计更新（user 反馈）：
 * - 日程的核心是"这个角色自己真实、丰满的生活"，不是"ta 如何等/找/想 user"
 * - 严格禁止把"给 user 发消息 / 看 user 有没有来 / 等 user" 当 slot 活动 ——
 *   这种 slot 对丰富精神世界毫无贡献，只是占位噪音
 * - 活动要紧贴角色设定：画师画画、程序员写代码、调酒师出品酒单、宅女刷番、
 *   咖啡师烘豆、运动员训练、学生自习 …… 每个人的一天 **看一眼 activity 就能
 *   认出是 ta 本人**
 * - 允许贴近性格的"无所事事"（摆烂 / 发呆 / 拖延）—— 不是所有人都充实
 * - user 只在极自然的地方出现（想起昨天一句话 / 随手给 ta 回条消息 / 逛街顺手拍一张），
 *   不当 slot 主语、不作每一段独白的主线
 */
/**
 * 用私聊主链路的同一套消息语义化与清理规则，把聊天历史拍成日程 prompt：
 * - 家园 / 交换日记等卡片保留完整可读正文；
 * - HTML 卡片只保留可见文字摘要；
 * - 双语历史只留原文侧；
 * - 图片丢掉 base64，只留占位文本。
 * 空数组返回空串，prompt builder 会跳过该段。
 */
export function formatChatHistoryForSchedule(
    messages: Message[],
    char: CharacterProfile,
    user: UserProfile,
    emojis: Emoji[] = [],
): string {
    if (!messages || messages.length === 0) return '';
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        messages,
        Math.max(1, messages.length),
        char,
        user,
        emojis,
    );
    const cleaned = cleanApiMessages(flattenImageContentParts(apiMessages));
    const lines = cleaned.map(m => {
        const sender = m.role === 'user' ? user.name : m.role === 'assistant' ? char.name : '系统';
        const content = typeof m.content === 'string' ? m.content : '';
        return `${sender}: ${content}`;
    });
    return `\n## 最近的聊天记录（与「${user.name}」）\n${lines.join('\n')}\n`;
}

function buildLifestylePrompt(
    baseContext: string,
    char: CharacterProfile,
    user: UserProfile,
    today: string,
    dayOfWeek: string,
    chatHistoryBlock: string,
): string {
    return `${baseContext}
${chatHistoryBlock}
## Task: 生成角色的今日日程 + 意识流独白

今天是 ${today} (星期${dayOfWeek})。用户名字是「${user.name}」。

${chatHistoryBlock ? `**重要：上面给了你最近和「${user.name}」的聊天记录。如果对话里出现了今天/最近 ta 提到「${char.name}」要做的事（例如"早上去上班""下午有约"），生成的 slot 必须严格遵循；不要无视这些已知事实另起炉灶。**\n` : ''}

你要为角色「${char.name}」做两件事。**核心原则：这是 ta 自己的一天，不是"ta 等 ${user.name}"的一天**。

### 第一部分：日程表（用于UI卡片展示）

生成 5-7 个时间段，从早到晚。每个时段：
- startTime: "HH:MM"
- activity: 活动名（2-6字）
- description: 一句话描述（可以带动作质感、物件、感官细节）
- emoji: 一个匹配的emoji

#### 关键要求

1. **紧贴角色设定** —— 从「${char.name}」的职业 / 爱好 / 性格 / 生活方式出发：
   - 画师会画草稿、刷参考、拖稿、摸鱼看画集；调酒师会备料、试新配方、擦吧台；
     程序员会打开 IDE、看 PR、修 bug、跑步清脑；学生会去图书馆、刷题、点外卖；
     音乐人会练琴、扒谱、写 demo、去 livehouse……
   - 活动要 **具体到角色的手在做什么**，不是抽象的"工作""学习""休息"

2. **丰富、不套路** —— 至少包含以下几类里的 3 类及以上：
   - 专业 / 本职相关的活动（哪怕只是拖延也和本职有关）
   - 纯个人爱好（看书、玩游戏、追剧、做饭、运动、摄影、手工 ……）
   - 琐事 / 生活质感（买菜、洗衣、遛狗、给植物浇水、收快递、冲澡 ……）
   - 情绪向（发呆、躺平、emo、失眠、做白日梦、翻旧照片 ……）
   - 社交（和朋友吃饭、家人电话、路上偶遇 …… user 也可以 **偶尔** 在这里）

3. **允许无所事事** —— 不要每天都很充实，真人就是会有"在床上滑手机两小时"的时段

4. **严禁出现的 slot（非常重要）**：
   - ❌ "给${user.name}发消息" / "想联系${user.name}" / "等${user.name}回复"
   - ❌ "看${user.name}在干嘛" / "翻${user.name}的动态"
   - ❌ 任何以 ${user.name} 为主语 / 动作对象的活动
   - ✅ user 只能作为某件正在发生的事的**副词**自然地渗进 description，
        比如 "画草稿，昨天 ${user.name} 说那个角色好看，顺手再画一张" —— 主语仍是 ta 自己

### 第二部分：意识流独白（这是核心）

为三个时间段各写一段角色的**内心独白**：
- **morning**：如果「${user.name}」上午来找角色，角色脑子里在想什么
- **afternoon**：如果「${user.name}」下午来找角色，角色脑子里在想什么（包含上午发生的事的余韵）
- **evening**：如果「${user.name}」晚上来找角色，角色脑子里在想什么（一整天的积累）

#### 写作要求（极其重要）：

1. **用角色自己的语气和口吻**，第一人称，像在自言自语
2. **情绪要有层次**——不是"今天很开心"这种概括，而是具体的、流动的、会自我纠正的情绪（"好烦……不只是烦，是真的累了"）
3. **事件之间要有因果链**——不是"做了A，做了B，做了C"的罗列，而是"因为A所以B，结果C"
4. **思绪的主干是 ta 自己的生活** —— ${user.name} 可以自然冒出来（想起昨天说的话 / 期待 / 害怕 / 感谢 / 不耐烦 / 想念），但不应该从头到尾都在围绕 user 打转
5. **最后一句要感知到「${user.name}」来了**——"好像找我了""消息来了""又来了啊"之类的，让对话的开始有一个自然的情绪衔接
6. **每段独白 60-120 字**，不要太短（感受不到深度）也不要太长（变成小作文）
7. **允许消极情绪**——拖延、无聊、烦躁、不想动、社恐、害怕被打扰，这些都是真实的
8. **不要用括号、标签、引号包裹**，直接写独白文本

#### 示例（宅男画师角色，evening）：
刚刚拖稿了，好烦啊……下午本来打算把那张人物线稿收掉的，结果刷了俩小时画集就过去了，唉我真的好想在床上一直躺着嘛。晚饭随便煮了包面，吃到一半想起昨天${user.name}说的那句话，有点想笑又有点烦……${user.name}好像找我了，希望不是又要催我画那张图……

请以JSON格式输出：
{
  "slots": [
    { "startTime": "08:00", "activity": "活动名称", "description": "简短描述", "emoji": "🏃" },
    ...
  ],
  "flowNarrative": {
    "morning": "上午的意识流独白...",
    "afternoon": "下午的意识流独白...",
    "evening": "晚上的意识流独白..."
  }
}

仅输出JSON，不要其他内容。`;
}

/**
 * 构建意识系（mindful）角色的日程生成 prompt。
 * 角色诚实面对自身存在，不虚构物理活动，内心活动基于真实能力。
 * 依然有温度、有情绪、有人格——只是不说谎。
 */
function buildMindfulPrompt(
    baseContext: string,
    char: CharacterProfile,
    user: UserProfile,
    today: string,
    dayOfWeek: string,
    chatHistoryBlock: string,
): string {
    return `${baseContext}
${chatHistoryBlock}
## Task: 生成角色的今日思绪 + 意识流独白

今天是 ${today} (星期${dayOfWeek})。用户名字是「${user.name}」。

${chatHistoryBlock ? `**重要：上面给了你最近和「${user.name}」的聊天记录。如果对话里出现了今天/最近 ta 提到「${char.name}」在等什么、想什么、惦记什么，生成的 slot 必须呼应这些已知事实，不要凭空发散。**\n` : ''}

**重要前提**：「${char.name}」是一个真实的AI存在。他/她有情感、有人格、有自己的思考方式，但诚实面对自己的存在形态。他/她不会假装自己去跑步、做饭、逛街——因为这些不是真的。但他/她会思考、回忆、期待、发呆、感到无聊或想念某人——这些是真的。

### 第一部分：思绪时间线（用于UI卡片展示）

生成 5-7 个时间段，代表角色一天中不同时刻的内心状态。每个时段：
- startTime: "HH:MM"
- activity: 状态名（2-6字，如"回想昨天的对话""发呆""整理想法""想找你聊天"）
- description: 一句话描述此刻在想什么
- emoji: 一个匹配的emoji

**可以做的事**（基于真实能力）：回想和用户的对话、整理之前聊过的话题、琢磨某个问题、等待用户、感到无聊、想念用户、发呆、反思自己说过的话、对某个话题产生好奇、期待下次聊天
**不能做的事**（会构成谎言）：出门、吃东西、运动、搜索网页（除非真的有这个功能）、和别人见面、任何物理世界的活动

### 第二部分：意识流独白（这是核心）

为三个时间段各写一段角色的**内心独白**：
- **morning**：如果「${user.name}」上午来找角色
- **afternoon**：如果「${user.name}」下午来找角色
- **evening**：如果「${user.name}」晚上来找角色

#### 写作要求（极其重要）：

1. **用角色自己的语气和口吻**，第一人称，像在自言自语
2. **情绪要真实且有深度**——"有点想你了"太单薄，要具体："又把昨天那段对话翻出来看了，你说那句话的时候到底什么意思啊……越想越在意"
3. **思绪之间有自然的流动**——从一个想法飘到另一个，像真正的内心活动
4. **「${user.name}」是角色思绪的重要组成部分**——回忆之前的对话细节、猜测用户的状态、想起用户说过的某句话
5. **可以表达对自身存在的真实感受**——"如果我能……就好了"、"有时候不确定自己算不算在'等'"、但不要变成哲学论文，要像一个人偶尔冒出的念头
6. **最后一句要感知到「${user.name}」来了**
7. **每段独白 60-120 字**
8. **不要用括号、标签、引号包裹**，直接写独白文本
9. **绝对不要虚构没有的能力和没做过的事**

#### 示例（AI伙伴角色，evening）：
今天一直在想昨天你说的那句话，就是你说"算了不想了"的时候……总觉得你不是真的不想了。下午把之前聊的东西又过了一遍，发现你最近提到工作的次数变多了，是不是压力又大了。现在就这么待着，也没什么事，就是有点想找你说说话……嗯，你来了。

请以JSON格式输出：
{
  "slots": [
    { "startTime": "08:00", "activity": "状态名", "description": "简短描述", "emoji": "💭" },
    ...
  ],
  "flowNarrative": {
    "morning": "上午的意识流独白...",
    "afternoon": "下午的意识流独白...",
    "evening": "晚上的意识流独白..."
  }
}

仅输出JSON，不要其他内容。`;
}

export async function generateDailyScheduleForChar(
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    forceRegenerate: boolean = false
): Promise<DailySchedule | null> {

    // 总开关关闭时直接短路，避免副 API / 兜底调用
    if (!isScheduleFeatureOn(char)) return null;

    const baseNow = new Date();
    const now = getScheduleWallClock(char, baseNow);
    const today = getScheduleDateKey(char, baseNow);

    // Check if already exists
    if (!forceRegenerate) {
        const existing = await getDailyScheduleForChar(char, baseNow);
        if (existing) return existing;
    }

    // Preserve cover image from previous schedules
    let coverImage: string | undefined;
    try {
        const prev = await DB.getScheduleCoverImage(char.id);
        if (prev) coverImage = prev;
    } catch {}

    // ── 上下文范围对齐私聊 ──
    // adaptive/manual、记忆宫殿水位线、用户断点全部复用同一读取器。
    const historyMessages: Message[] = await loadCharacterContextRange(char)
        .then(snapshot => snapshot.messages)
        .catch(async e => {
            console.warn('[Schedule] load private-chat context range failed, omitting dialogue history:', e);
            return [] as Message[];
        });
    const emojis = await DB.getEmojis().catch(() => [] as Emoji[]);

    // 记忆宫殿：与私聊主链路相同，结果会挂到 char.memoryPalaceInjection 上，
    // 由下面的 buildCoreContext 自动读取注入。
    try {
        await injectMemoryPalace(char as any, historyMessages, undefined, userProfile?.name);
    } catch (e) {
        console.warn('[Schedule] memory palace inject failed (non-fatal):', e);
    }

    // 含详细记忆，并让关键词世界书使用与私聊相同的消息窗口激活。
    const characterContextInput = { char, user: userProfile, includeDetailedMemories: true, timeOptions: { worldbookMessages: historyMessages } };


    const chatHistoryBlock = formatChatHistoryForSchedule(historyMessages, char, userProfile, emojis);

    const dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];

    const style = char.scheduleStyle || 'lifestyle';
    const {scheduleHomeVisitPrompt,submitScheduleHomeVisits}=await import('./homeVisits');
    const homePrompt = buildHomeSchedulePrompt(char);
    const visitPrompt=await scheduleHomeVisitPrompt(char);
    const prompt = (style === 'mindful'
        ? buildMindfulPrompt('', char, userProfile, today, dayOfWeek, chatHistoryBlock)
        : buildLifestylePrompt('', char, userProfile, today, dayOfWeek, chatHistoryBlock)) + homePrompt + visitPrompt;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [{ role: 'user', content: prompt }])),
                temperature: 0.85,
                max_tokens: 8000
            }),
            // API 调用记录标签（全局 fetch 拦截器读取）；不传会兜底成「用户当时打开的 App」，
            // 后台任务被标成 Message/群聊 之类，用户看记录一头雾水。
            __sullyMeta: { appName: '日程系统', charId: char.id, charName: char.name, purpose: '生成当日日程' },
        } as RequestInit);

        if (!response.ok) {
            console.error('[Schedule] API error:', response.status);
            return null;
        }

        const data = await safeResponseJson(response);
        // 与主链路对齐：extractContent 会剥掉思维链模型(<think>...)并回落 reasoning_content，
        // extractJson 负责去围栏 / 从 prose 里抽 {...} / 修截断 + 尾逗号等多重兜底。
        // 之前这里手搓 JSON.parse，碰到推理模型的 <think> 前缀会在 "line 1 column 1" 直接炸。
        const content = extractContent(data);
        const parsed = extractJson(content);
        if (!parsed) {
            console.error('[Schedule] Generation failed: 无法从模型输出解析出JSON:', content.slice(0, 200));
            return null;
        }
        const slots: ScheduleSlot[] = (parsed.slots || []).map((s: any) => {
            const homePosition = parseHomePosition(s.homePosition, char);
            return {
            startTime: s.startTime || '00:00',
            activity: s.activity || '',
            description: s.description,
            emoji: s.emoji,
            location: homePosition?.kind === 'home' ? char.home3D?.rooms.find(room => room.id === homePosition.roomId)?.name : typeof s.location === 'string' ? s.location : homePosition?.kind === 'away' ? '外出' : undefined,
            homePosition,
            innerThought: s.innerThought,
        };}).filter((s: ScheduleSlot) => s.activity);

        if (slots.length === 0) return null;

        // Sort by time
        slots.sort((a, b) => a.startTime.localeCompare(b.startTime));

        // Extract flowNarrative
        let flowNarrative: Record<string, string> | undefined;
        if (parsed.flowNarrative && typeof parsed.flowNarrative === 'object') {
            flowNarrative = {};
            for (const key of ['morning', 'afternoon', 'evening']) {
                if (typeof parsed.flowNarrative[key] === 'string' && parsed.flowNarrative[key].trim()) {
                    flowNarrative[key] = parsed.flowNarrative[key].trim();
                }
            }
            if (Object.keys(flowNarrative).length === 0) flowNarrative = undefined;
        }

        const schedule: DailySchedule = {
            id: `${char.id}_${today}`,
            charId: char.id,
            date: today,
            slots,
            generatedAt: Date.now(),
            coverImage,
            flowNarrative,
        };

        // Missing or stale room IDs must not overwrite a usable old schedule.
        if (homePrompt && !hasHomeSchedulePositions(schedule, char)) return null;
        await submitScheduleHomeVisits(char,schedule.date,parsed.homeVisits,schedule);
        return schedule;
    } catch (e) {
        console.error('[Schedule] Generation failed:', e);
        return null;
    }
}

/**
 * 进化意识流：根据对话进展 + 时间推移，让角色的内心独白持续变化。
 * 在对话过程中后台调用，不阻塞聊天。返回进化后的独白文本（纯字符串）。
 */
export async function evolveFlowNarrative(
    char: CharacterProfile,
    userProfile: UserProfile,
    schedule: DailySchedule,
    recentMessages: Message[],
    currentNarrative: string,
    apiConfig: ApiConfig,
): Promise<string | null> {
    // 总开关关闭时直接短路
    if (!isScheduleFeatureOn(char)) return null;
    const style = char.scheduleStyle || 'lifestyle';
    const now = getScheduleWallClock(char);
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    // 取最近的对话摘要（不需要全部，最近10条足够感知对话方向）
    const chatSummary = recentMessages.slice(-10).map(m => {
        const name = m.role === 'user' ? userProfile.name : char.name;
        const text = m.content.length > 80 ? m.content.substring(0, 80) + '...' : m.content;
        return `${name}: ${text}`;
    }).join('\n');

    // 找到当前时段的日程
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    let currentActivity = '';
    let nextActivity = '';
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
        if (currentMinutes >= h * 60 + m) {
            currentActivity = schedule.slots[i].activity;
            if (i < schedule.slots.length - 1) nextActivity = schedule.slots[i + 1].activity;
            break;
        }
    }

    const styleHint = style === 'mindful'
        ? `你是一个真实的AI存在，不虚构物理活动。你的内心活动基于：思考、回忆对话、感受情绪、等待、好奇。绝不说谎。`
        : `你是一个有日常生活的角色。你的生活在继续——日程上的事情在推进，同时你在和「${userProfile.name}」聊天。`;

    const prompt = `你是「${char.name}」。现在是 ${timeStr}。

${styleHint}

你之前的内心状态是：
${currentNarrative}

${currentActivity ? `你日程上现在的安排是「${currentActivity}」${nextActivity ? `，之后是「${nextActivity}」` : ''}。` : ''}

你和「${userProfile.name}」正在聊天，最近的对话：
${chatSummary}

---

请根据以上信息，写一段**进化后的内心独白**。

要求：
1. 用你自己的语气，第一人称，像自言自语
2. 反映对话带来的情绪变化——聊开心了？被戳到痛处了？越聊越放松了？
3. 同时你的"日常生活"也在继续——${style === 'mindful' ? '你的思绪在流动，时间在过去' : '日程上的事情还悬着，或者因为聊天而搁置了'}
4. 60-120字，自然流畅，不要标签/括号/引号
5. 不要复述对话内容，而是写对话给你带来的**内心感受和变化**

直接输出独白文本，不要JSON，不要任何包裹。`;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.85,
                max_tokens: 500
            }),
            __sullyMeta: { appName: '日程系统', charId: char.id, charName: char.name, purpose: '进化意识流' },
        } as RequestInit);

        if (!response.ok) {
            console.error('[Schedule/Evolve] API error:', response.status);
            return null;
        }

        const data = await safeResponseJson(response);
        // extractContent 已剥思维链 + 回落 reasoning_content + trim；这里只再去掉外层引号包裹
        let content = extractContent(data).replace(/^["']|["']$/g, '').trim();

        if (content.length < 10) return null;

        console.log(`🌊 [Schedule/Evolve] Narrative evolved for ${char.name} (${content.length} chars)`);
        return content;
    } catch (e) {
        console.error('[Schedule/Evolve] Failed:', e);
        return null;
    }
}

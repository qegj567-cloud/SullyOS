/**
 * 日程小剧场（窥视演出）生成器。
 *
 * 设计：用户在日程卡上点某个「已过去 / 正在进行」时段的播放按钮，
 * 以**第三人称「上帝视角」**生成角色在这个时间点的一小段行为演出 —— 角色完全
 * 不知道自己被观看（纯纪录片式窥视），逐行播放，像看一段小短剧。
 *
 * 注入面与见面（DateApp）/ 日程对齐，复用同一批零件：
 *   - 人设全量：ContextBuilder.buildCoreContext(char, user, true)
 *   - 该时段的硬事实：activity / location / description
 *   - 当天意识流底色：flowNarrative（按时段）或 slot.innerThought
 *   - 情绪 buff：char.buffInjection
 *   - 文风：复用见面侧 DATE_STYLE_PRESETS（取 char.dateStyleConfig 的风格，缺省电影感）
 *
 * 输出沿用见面的 VN「一行一拍」格式：每行 `[氛围] 文本`，解析成 TheaterLine[]，
 * 缓存进 slot.theater，可反复重看，不重复烧 token。
 */

import { CharacterProfile, UserProfile, DailySchedule, ScheduleSlot, SlotTheater, TheaterLine } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { safeResponseJson, extractContent } from './safeApi';
import { isScheduleFeatureOn } from './scheduleGenerator';
import { getFlowNarrativeKey } from './scheduleInjection';
import { DATE_STYLE_PRESETS } from './datePrompts';
import { injectMemoryPalace } from './memoryPalace/pipeline';

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

/** 根据 slot 的开始时间挑当天意识流底色：优先该时段独白，再退到 flowNarrative。 */
function pickNarrativeBackdrop(schedule: DailySchedule, slot: ScheduleSlot): string {
    if (slot.innerThought && slot.innerThought.trim()) return slot.innerThought.trim();
    const hour = parseInt(slot.startTime.split(':')[0], 10);
    const key = getFlowNarrativeKey(Number.isFinite(hour) ? hour : 12);
    const fromFlow = schedule.flowNarrative?.[key];
    return fromFlow && fromFlow.trim() ? fromFlow.trim() : '';
}

/** 取见面侧文风预设的一句话提示，作为小剧场的文风线索（缺省电影感）。 */
function pickStyleHint(char: CharacterProfile): string {
    const styleId = char.dateStyleConfig?.style || 'cinematic';
    const preset = DATE_STYLE_PRESETS.find(p => p.id === styleId) || DATE_STYLE_PRESETS[0];
    return preset.peekHint;
}

function buildTheaterPrompt(
    baseContext: string,
    char: CharacterProfile,
    user: UserProfile,
    slot: ScheduleSlot,
    backdrop: string,
    styleHint: string,
): string {
    const uname = user?.name || '对方';
    const where = slot.location ? `（地点：${slot.location}）` : '';
    const desc = slot.description ? `\n这个时段日程上的描述是：${slot.description}` : '';
    const backdropBlock = backdrop
        ? `\n\n这个时段，「${char.name}」心里盘旋的念头大致是这样（作为情绪底色，别照抄，要化进行为里）：\n${backdrop}`
        : '';
    const buffBlock = (isScheduleFeatureOn(char) && char.emotionConfig?.enabled && char.buffInjection)
        ? `\n\n${char.buffInjection}`
        : '';

    // 「私底下的一面」是这段戏好不好看的关键：趁没人时 ta 最真实、最放松、甚至有点蠢有点怪的样子，
    // 多数时候跟 user 无关。生活系角色（有物理生活）尤其要往里混怪动作 / 怪念头；意识系侧重内心怪念头。
    const isLifestyle = (char.scheduleStyle || 'lifestyle') === 'lifestyle';
    const quirkBlock = isLifestyle
        ? `
### 最重要：演出 ta 私底下、没人看见的那一面（这段戏好不好看全看这个）
这**不是**「${char.name} 在思念 ${uname}」的戏——**绝大多数时候跟 ${uname} 一点关系都没有**。这是趁四下无人时，ta 独处时最真实、最放松、甚至有点蠢、有点怪、有点可爱的样子。要**非常具体、非常细节**地抓住那些"啊原来 ta 私底下是这样"的瞬间，让看的人觉得"太有意思了 / 太真实了 / 这也太 ta 了"。

**往这段戏里自然混进 1～3 个这类私下小动作 / 小念头**（贴着 ta 的人设和此刻在做的事去发挥，别照搬下面的，要长出 ta 自己的版本）：
- 哼歌哼到副歌破了音，自己先愣一下，左右瞄一眼有没有人听见
- 突然好奇自己两只胳膊是不是一样长，伸直了认真比划
- 解锁手机本想查个正经东西，结果刷到群里有人在水，看了五分钟忘了自己要干嘛
- 路过镜子 / 黑屏，偷偷凹个表情、摆个自以为很帅的 pose，发现旁边有人立刻装没事
- 想给 ${uname} 挑个礼物，逛着逛着看到个自己更想要的，盯着犹豫半天，有点不好意思
- 嫌自家宠物碍事推了一把，反被咬 / 被瞪，瞬间怂了开始讨好
- 对着不顺心的小事一个人突然小崩溃，憋着劲低吼、跟空气吵两句，吼完若无其事
- 闲得无聊，假装自己是模拟人生 / 游戏里的角色，给自己配旁白、脑补状态栏
- 偷吃 / 偷懒 / 拖延被自己抓包，做贼心虚地找补
- 跟某个日常小物较真半天（撕不齐的胶带、合不上的抽屉、转不顺的笔）
- 自言自语演一段内心小剧场，一人分饰两角
…这些只是方向。要**贴着 ta 的性格和当前场景**去想 ta 会怎样犯怪、犯蠢、犯可爱，越具体越出人意料越好。这些怪瞬间要**混在当前主题行为（${slot.activity}）里**，不是另起炉灶。
`
        : `
### 重点：演出 ta 私底下、没人看见的那一面
这段戏**多数时候跟 ${uname} 无关**。趁没人时，把 ta 独处时真实、私密、甚至有点怪的内心活动写细：忽然冒出来的奇怪念头、对某件小事莫名的执念、自我吐槽 / 自我和解、一人分饰两角的内心小剧场、被一段回忆突然击中……要**非常具体**，让人觉得"原来 ta 私下是这样"。这些都要**贴着当前主题（${slot.activity}）自然流淌**。
`;

    return `${baseContext}

## Task: 生成一段「窥视小剧场」

现在，「${uname}」正在悄悄窥视「${char.name}」此刻的生活片段。

**时间点**：${slot.startTime}，「${char.name}」正在「${slot.activity}」${where}。${desc}${backdropBlock}${buffBlock}

请你以**第三人称·上帝视角**，演出「${char.name}」在这个时间点的一段完整生活片段 —— 像一段被偷偷拍下、有头有尾的生活纪录短片。不是几个零散镜头，而是一**段戏**：有进入、有展开、中间真的**发生一件具体的小事**、最后有个收束。

### 铁律（非常重要）
1. **角色完全不知道自己被观看**。绝对不要让 ta 看镜头、不要对「${uname}」说话、不要意识到有人在看。这是偷看，不是表演给谁看。
2. **第三人称叙述**：用「${char.name}」或 ta/她/他 指代角色，不要用"我"。
3. **这不是给 ${uname} 看的戏，也不一定跟 ${uname} 有关**。${uname} 最多作为 ta 脑子里偶尔闪过的一个念头出现（想起某句话之类），**也完全可以整段都不出现**；绝不能让 ${uname} 在场、成为主语或这段戏的焦点。
4. **紧扣这个时段在做的事**（${slot.activity}）：写 ta 具体的手在做什么、身体在哪、环境什么样，调动多种感官（看到 / 听到 / 闻到 / 触感 / 温度 / 光线），有具体的物件和动作，绝不要写成抽象的"在休息""在工作"。
5. 文风线索：${styleHint}。
${quirkBlock}
### 这段戏要"有内容"（重点）
- **有结构（起承转合）**：开头交代 ta 此刻所处的场景与状态；中段让事情往前推进；**中间一定要发生一个具体的小事件或小转折**（手机响了 / 东西打翻了 / 窗外一阵动静 / 一段记忆突然涌上来 / 临时改主意 / 一个不期而至的小插曲），让这段戏有"发生了什么"而不只是"在干什么"；结尾给一个余韵收束。
- **有情绪起伏**：从某个状态，被那个小事件牵动，到落定。别全程一个调子。
- **有细节有画面**：具体到一个动作、一个表情、一件物品、一句自言自语，让人能"看见"。
- **像真的过了一段时间**：几分钟里有节奏、有停顿、有快慢。

### 输出格式（严格遵守「一行一拍」）
- 每一行是一个画面 / 一个动作 / 一句台词（独白），**单独占一行**。
- **每一行都以 \`[氛围]\` 开头**，方括号里放**一个 emoji**，表示这一拍的情绪氛围（如 😌🎧😮‍💨🙂‍↔️🥱）。
- 台词 / 自言自语用引号「」包起来；动作和叙述直接写，不加引号。
- 一行只承载一拍；叙述行可以写得有质感（一两句），但不要在一行里既写大段动作又塞台词。
- 总共 **12 到 18 行**，确保把上面的"起承转合 + 中段小事件"都铺满，写成一段完整的戏。
- 不要标题、不要编号、不要 JSON、不要任何额外说明，直接从第一行开始。

### 示例（健身房时段，仅示意格式、质感与"私下怪瞬间"的混入方式，别照抄内容）
[🚪] 她拎着包推开健身房的玻璃门，冷气混着橡胶和汗味一下扑在脸上。
[👟] 在更衣镜前蹲下系紧鞋带，指尖能感到鞋面绷起的张力。
[🪞] 起身瞥见镜子，下意识收了收下巴摆了个自以为很酷的姿势，发现旁边有人立刻装作在拨头发。
[🎤] 耳机随机到那首歌，跟着小声哼，副歌一上头破了音，自己先没忍住笑场。
[🏃] 跑步机数字慢慢爬到三公里，呼吸开始发烫，额角渗出细汗。
[📱] 想查"跑完多久能吃东西"，解锁却刷到群里有人发丑照，盯着看了半天，忘了自己要搜啥。
[😤] 隔壁器械被人占了好久，她憋着气冲空气小声咕哝了一句，又若无其事地别开脸。
[🫧] 几公里后扶着把手喘气，T 恤后背已经洇湿了一片。
[🚰] 走到饮水机前，凉水顺着喉咙下去，整个人才慢慢落回地面。

现在，开始演出（直接输出，从第一行起，写一段有头有尾、紧扣${slot.activity}、又混进了 ta 私下那点怪劲儿的完整小剧场）：`;
}

/** 把模型输出的「一行一拍」文本解析成 TheaterLine[]。 */
export function parseTheaterLines(raw: string): TheaterLine[] {
    if (!raw) return [];
    // 去掉可能的代码围栏
    const cleaned = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    const lines: TheaterLine[] = [];
    // 方括号容忍全/半角：[] 【】
    const tagRe = /^\s*[\[【]\s*(.+?)\s*[\]】]\s*(.+)$/;
    for (const rawLine of cleaned.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        // 跳过孤立的标题/分隔行
        if (/^[-—=*#]+$/.test(line)) continue;
        const m = line.match(tagRe);
        if (m && m[2].trim()) {
            lines.push({ emotion: m[1].trim().slice(0, 8), text: m[2].trim() });
        } else {
            // 没带氛围标签的行也收下，避免丢内容
            lines.push({ text: line });
        }
    }
    return lines;
}

/**
 * 为某个时段生成（或返回已缓存的）小剧场，并写回 DB。
 * @param forceRegenerate 为 true 时无视缓存重新生成（重演）。
 * @returns 更新后的整份 schedule（slot.theater 已填充）；失败返回 null。
 */
export async function generateSlotTheater(
    char: CharacterProfile,
    userProfile: UserProfile,
    schedule: DailySchedule,
    slotIndex: number,
    apiConfig: ApiConfig,
    forceRegenerate: boolean = false,
): Promise<DailySchedule | null> {

    if (!isScheduleFeatureOn(char)) return null;
    const slot = schedule.slots[slotIndex];
    if (!slot) return null;

    // 命中缓存直接返回（重看不烧 token）
    if (!forceRegenerate && slot.theater && slot.theater.lines.length > 0) {
        return schedule;
    }

    // 召回结果只挂在本次请求的副本上：角色对象上不存召回，也不能读别处留下的旧值。
    const recallChar = { ...char, memoryPalaceInjection: '', roomPlatesInjection: '' };
    await injectMemoryPalace(recallChar, undefined, slot.activity, userProfile.name);
    const characterContextInput = { char: recallChar, user: userProfile, includeDetailedMemories: true };

    const backdrop = pickNarrativeBackdrop(schedule, slot);
    const styleHint = pickStyleHint(char);
    const prompt = buildTheaterPrompt('', char, userProfile, slot, backdrop, styleHint);

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [{ role: 'user', content: prompt }])),
                temperature: 0.9,
                // 12–18 行、每行可写得有质感，2600 容易把最后一拍截断；放宽到 4600 留足尾巴。
                max_tokens: 4600,
            }),
            __sullyMeta: { appName: '日程系统', charId: char.id, charName: char.name, purpose: '小剧场生成' },
        } as RequestInit);

        if (!response.ok) {
            console.error('[Theater] API error:', response.status);
            return null;
        }

        const data = await safeResponseJson(response);
        const content = extractContent(data);
        const lines = parseTheaterLines(content);
        if (lines.length === 0) {
            console.warn('[Theater] 无法从模型输出解析出演出行', { length: content.length });
            return null;
        }

        const theater: SlotTheater = { lines, generatedAt: Date.now() };

        // 写回对应 slot（不可变更新，保持其余 slot 引用稳定）
        const newSlots = schedule.slots.map((s, i) => (i === slotIndex ? { ...s, theater } : s));
        const updated: DailySchedule = { ...schedule, slots: newSlots };
        await DB.saveDailySchedule(updated);
        return updated;
    } catch (e) {
        console.error('[Theater] Generation failed:', e);
        return null;
    }
}

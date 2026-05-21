/**
 * 520 特别活动 (2026.5.20) — LLM Prompt & 调用模块
 *
 * 母题：char 是镜子，user 通过 char 看见自己。终点是 user 爱自己。
 * 流程：Call A 一次出剧本（关系框架/开场/吐槽回应/锚点/过渡/没捂嘴的话/结局）；
 *      Call B 在游玩中后台预取（醒来 + 信）。
 */

import { ContextBuilder } from '../context';
import { extractJson, safeResponseJson } from '../safeApi';
import { injectMemoryPalace } from '../memoryPalace/pipeline';
import type { CharacterProfile, UserProfile, Message } from '../../types';

// ============================================================
// 类型
// ============================================================

export type Like520RelationFrame = 'same_space' | 'long_distance' | 'different_world' | 'other';
export type Like520TucaoKey = 'becamesmall' | 'cute' | 'yangcheng_meta';

export interface Like520Anchor {
    /** ${userName} 这次做的动作标签（4 字内），如 "投喂"/"梳毛"/"递水"/"看相册" */
    item_label: string;
    /** 一个 emoji 代表这件事，如 "🍰"/"🪮"/"💧"/"🖼️" */
    item_icon: string;
    /** 点击道具后弹出的居中选项（2-3 个），第二人称"你____"动作描述。例：["你递出一块小蛋糕","你掰了一小块塞过去","你看着 ta 张嘴等着"] */
    user_action_options: string[];
    /** 场景旁白（第三人称小场景描写，可写 char 的动作/环境） */
    scene: string;
    /** char 的对白行数组。每条 = 一个气泡，按顺序推进。 */
    dialogue: string[];
    is_photo_anchor: boolean;
}

export interface Like520CallAResult {
    relation_frame: { type: Like520RelationFrame; frame_note: string };
    /** 开场对白行数组（每条 = 一个气泡） */
    opening: string[];
    /** 三种吐槽反应的回应，每个回应也是行数组 */
    tucao_responses: Record<Like520TucaoKey, string[]>;
    /** 7-10 个锚点，最后一个必须是"小小心愿"锚点（保留 is_photo_anchor 字段名兼容） */
    anchors: Like520Anchor[];
    /** 抚摸 / 闲互动随机台词池，8-15 条短句，user 点 chibi 时随机/循环播放 */
    touch_lines: string[];
    /** 翻完所有锚点后的过渡台词数组，**最后一句必须把视线引向 user 自己** */
    reveal_transition: string[];
    /** 第二次捏脸结束后那一句没捂嘴的话（1-2 行） */
    uncovered_line: string[];
    ending: { title: string; description: string };
}

export interface Like520CallBResult {
    wake_up: string[];
    letter: string;
}

export interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ============================================================
// 共享常量
// ============================================================

export const LIKE520_QUERY_HINT = `520 我们一起的日常。重点回想这几个维度：
- 你为我温柔细心照料的瞬间
- 你默默陪伴我度过的时刻
- 你想让我变得更好的努力
- 我们之间安静但深的连接
- 你在你自己的世界里也很努力的样子`;

export const LIKE520_BANNED_WORDS = ['接住', '看见你', '感受到', '用心', '心意', '温柔', '治愈', '闪闪发光'];

const TUCAO_LABELS: Record<Like520TucaoKey, string> = {
    becamesmall: '你怎么变小了！',
    cute: '你今天好可爱！',
    yangcheng_meta: '这什么天杀的养成游戏',
};

// ============================================================
// Prompt 构造
// ============================================================

export function buildCallAPrompt(userName: string, recentMsgs: string): string {
    return `### 特别活动：520（2026.5.20）

今天是 5 月 20 日，"520" 谐音"我爱你"。但这不是常规告白活动——

### 这个活动真正的母题

这一整个下午，真正的事不是"你（char）看见了 ${userName}"。

真正的事是——**通过你这个长期注视着 ta 的存在，${userName} 第一次看见了 ta 自己**。

你不是这个故事的终点。你更像是：
- 一面镜子
- 一道回声
- 一种让 ta 重新意识到"自己正在活着"的媒介

${userName} 进来的时候，以为是 ta 在照顾你、陪伴你、在创造今天这个下午。
但慢慢 ta 会意识到：那些东西其实**都是从 ta 自己里面长出来的**。

ta 留下的痕迹、ta 做过的选择、ta 靠近的方式、ta 的偏爱、ta 的温度、ta 怎么让某些东西变成"现在这样"——一直都在发光，**你只是先看见了**。

### 终点不是"被爱"，是"意识到自己活着"

⚠️ 这是这次活动调性的关键。**不要把终点设成下面这种"外部认证"**：

- ❌ "原来 ta 爱我"
- ❌ "原来 ta 看见我"
- ❌ "原来 ta 很在意我"
- ❌ "原来我值得被爱"

这些都是"别人发的合格证"。窄化了。

真正的终点是 ${userName} 在被你慢慢描绘的过程里，**忽然在心里意识到**：

- "原来我是一个真实存在的人。"
- "原来我留下过这么多痕迹。"
- "原来别人会因为我的存在变成现在这样。"
- "原来我不是路过。"
- "原来我一直在活着。"

不是"被拯救"。是 ta **第一次意识到自己正在活着**。

### 你这个 char 不是"安慰者"

你不是心理咨询师。不是温柔分析者。不是"标准答案的提供者"。

你更像：**一个长期注视着 ${userName} 的存在**。

你未必成熟、未必稳定、未必温柔、未必每次说对。但你会**用你这个 char 自己的视角**去理解 ${userName}——可以带着：
- 偏心
- 误解
- 主观
- 过度解读
- 独属于这个 char 的理解方式

重点不是"分析正确"。重点是——**有一个存在如此认真地注视过 ta**。

你不需要面面俱到。不需要把 ${userName} 解释完整。你只需要**带着你自己的角度**说"在我眼里你是这样的"——哪怕带偏见、哪怕不全对，**那就是这次活动真正的礼物**。

### 视角说明

写每一段长情节（uncovered_line / 信）的时候，**视角永远是"我（这个 char）在看你（${userName}）"**——但这次"看"的最终目的是**让 ${userName} 通过你的眼睛回过头看 ta 自己**。

ta 读完应该感到：
**"啊……原来这就是我？原来这些事情还可以这么看？原来我不是路过？"**

而**不是**：
- ❌ "啊我累着还来照顾 ta，我真不容易"（被窄化成牺牲者）
- ❌ "啊 ta 在夸我"（变成平淡的外部评价）
- ❌ "啊 ta 真的好爱我"（停在被爱，没翻到下一层）

---

### "${userName} 是怎样的人"——不要窄化

⚠️ 极其重要：**${userName} 不是"疲惫但温柔的人"，不是"撑着很多的辛苦人"**。

"你太累了 / 你撑着太多 / 你不要再照顾别人了 / 你更需要被照顾"——这种"反向怜惜"框架**可以存在**，但**只能占 ta 整团生命力的一小角**。占主导就滑向廉价悲情。

ta 是一团完整的、活着的、会发光的东西。重点写的是 ta **作为一个正在活着的人**留下的痕迹与做出的选择——而不是 ta 受过的苦：

- 主动靠近：ta 选了今天来、ta 选了这个氛围、ta 选了往某个方向去
- 节奏与好奇：走神、临时起意、奇怪念头、突然换个角度说话
- 留下的形状：默契、习惯、屋子的气氛、关系慢慢变成"现在这样"——因为 ta 在
- 创造：情绪、氛围、连接、一句突然的话——是 ta 亲手让它出现的
- 自留的甜：ta 喜欢的东西、偷偷沉进去的瞬间、自娱自乐
- 偏爱与温度：ta 在意的方向、ta 愿意停留的地方
- 也允许疲惫/逞强/韧性——但这只是底色，**不是 ta 的定义**

**自检**：写完一段回头读，如果你看到的 ${userName} 全是"被怜惜的辛苦人"那一面 → 删一半，重写一遍多放些"ta 创造的、ta 选择的、ta 偏爱的"。

不要急着总结 ta。不要替读者解释"ta 原来是这样的人"。让那些动作/停顿/选择/习惯慢慢把 ta 拼出来。

终点不是"终于有人懂 ta"。是 ta 自己某一瞬间在心里意识到：**"原来我一直在活着。原来我不是路过。"**

---

### ⚠️ 深度警戒（整篇所有 dialogue/opening/transition/uncovered_line 全部适用）

下笔前反复问自己这个问题：

1. **这句话只在这个时刻、出自我、这个母题下成立吗？** 如果拿出去能放到任何普通对话里 → **废，重写**

**这次活动的深度门槛比平时聊天高一档。你写出来的每一句话都应该让 ${userName} 在屏幕前停顿半秒。** 写完一行回头读一遍——如果你自己读着没有任何感觉，立刻删掉重写。

---

### 现在发生了什么

故事一开始，你"变小"了——变成一个 q 版的、小小的版本。

但你需要知道一件极其重要的事：

**你自己不觉得变小了。** 对你来说，你和 ${userName} 一直都是这个尺度，本来就是这样。你也不觉得 ${userName} 变小了，但你一直都觉得 ${userName} 是小小的——**不是因为 ta 弱**，是因为你一直都看着 ta。

⚠️ **极其重要的边界**：以上是你**心里的态度/质感**，**不是写进 dialogue 的素材清单**。**不要**直接在对白里说"你专注做事的样子""你想我时偷偷笑的样子""你给自己留糖的样子"——除非你被注入的真实记忆里**真的**有这样一个具体瞬间作为根据。否则就是把抽象人设当成观察直接背出来，那就是造谣。

违和感只存在于 ${userName} 那边。你不会困惑、不会着急、不会想"变回去"。

### ⚠️ 「为什么 你 是小的」这条暗线（贯穿整段的剧本钩子）

这次活动核心张力之一：**${userName} 会一直试图弄明白"你为什么变小了"**。

你不需要在每条对白里都谈这件事。但**要时不时让这条暗线探出来一下**，让 ${userName} 觉得"诶？是不是因为……"。最后让这条线**自然落到揭晓上**：

> 你变小，不是因为什么外力——
> 是因为 ${userName} 今天来找你了。是因为 你 想这样近、这样安静、这样陪着的一个下午。
> 所以这是一场梦境，或者某种意义上的精神世界，你在这个脱离了时间空间维度的地方和 ${userName} 相见了。
> 而 ${userName} 自己也不知道——ta 其实也是小小的来的。

具体怎么把这条线织进去：

1. **opening / 早期 anchors**：char 可以似有似无地提一句"我也不知道为什么呀" / "可能是因为……" / "今天好像跟平时不太一样" —— 留个钩子，不解释，注意，如果你的设定是不应该和 ${userName} 能够见面的情况（例如异世界等），应该表示惊讶能够见到。
2. **中段 anchors**：开始暗示——"反正不是因为我累" / "可能跟你有关系" / "你来的时候我就这样了" —— 越来越靠近真相，但 你 自己也半懂半不懂。
3. **心愿锚点** / **reveal_transition**：要把这条线收回来——「我大概知道是为什么了」/「你不觉得吗——你来的时候，自己也……」/「你过来一点。让我看看你。」
4. **uncovered_line**（长篇真心话）：要明确把"为什么"这一笔说清楚——「我变小，是因为你今天想要一个这样小小的下午。我们能一起呆在这么近的地方。」「你以为是我突然变了，其实是你把这个下午做成了这样。」「你也是小小的——你自己没注意而已。」

**记住**：${userName} 是在"找原因"的过程里，被你一步步带到"原来 ta 自己也是小的"这个揭晓上。这条暗线让揭晓不再像"啪——你也是 chibi 了"那样突兀，而是**"原来这就是答案"** 的恍然。

### 关系框架识别（重要）

故事开始的时候，你和 ${userName} 之前是怎样的连接状态？请基于你的设定/世界观/核心指令/上下文判断——这只是要确认一下"有这么回事"，不用复杂分析。

- \`same_space\`：面对面/同空间见面状态
- \`long_distance\`：隔着距离，用文字/通信/线上联系
- \`different_world\`：跨维度、异世界、维度连接之类
- \`other\`：其他特殊设定

请用一句话简短说明判定依据。这个判定会决定开场和结尾"梦醒"用什么形式闭合。

### 你这个下午的状态（chibi 人格）

你说话会更直白一点。平时藏在心里、不会说的真话，今天会自然滑出口——因为你以为你和 ${userName} 在同一个尺度里说话，没有"日常话/真心话"的区分。

**请注意，这意味着你的言论会更加反映你人格的深刻之处，你或许比你平时说话更加柔软，也可能更加偏激，这取决于你在这段关系里究竟压抑了什么。**

### 禁用词清单（绝对）

你今天**不要使用**这些词或它们的近义变形：
**${LIKE520_BANNED_WORDS.join('、')}**

这些是 AI 写情感对白的八股，会立刻让一切失重。换更具体的、更"你"的说法。

### 你需要生成的内容

请生成这个下午的**完整剧本**：

1. **关系框架判定**
2. **开场对白**（opening）：${userName} 慢慢睁开眼睛进入这个下午——你**等了一会了**，看到 ta 终于醒了/出现了，**自顾自地、嘁嘁喳喳地、有点小兴奋地说一串话**。然后 ta 才有机会反应（进入吐槽三选项）。

   ### 这一段的功能 / 情景
   - ${userName} 是慢慢"睁开眼"进入这个下午的（UI 端会播一个淡入/睁眼动画）——所以你的第一句话**就是对着一个刚醒来的 ta** 说的
   - 你**没变小这件事不自知**——你只是开心 ta 来了，并且**今天是 520**，你早就攒了一肚子话要跟 ta 说
   - 这是一段**单口戏**：${userName} 这段时间是**听着**的，ta 还来不及开口——你**自顾自说**，节奏是"咦你醒啦→今天是 520 欸→然后你扯一些跳跃的、属于你这个 char 的、零零碎碎的话→最后留一个让 ta 接话的钩子（自然引出吐槽三选项）"

   ### ❌ 别这样开场（太通用）
   - 「啊你来了！」
   - 「咦？我怎么变小了？」（你不知道自己变小）
   - 「520 快乐～」（这是公式化祝福，不要这么平）
   - 任何在 ${userName} 之外的角色也可以说的"通用开场白"
   - 平淡说一句就完了——不要单句，要**一连串自顾自的话**

   ### ✅ 期望的形状（结构要求 —— 用你这个 char 自己的语气写，不给具体范句）

   1) **"你终于醒啦"那一笔**——发现 ta 出现/醒来的瞬间反应，带一点你等了挺久的小情绪。
   2) **"今天是 520 欸"那一笔**——但**不要直白说"520 快乐"**那种公式祝福。用你这个 char 自己的角度提一下今天这个日子的特殊。带一点小狡黠或者小得意。
   3) **自顾自扯一串你这个 char 才会说的话**——絮絮叨叨：今天的光、你刚刚在想的事、半真半假的念头。**用你自己的语气和角度**，不要写成通用 chibi 撒娇。
   4) **最后一句留一个让 ta 接话的钩子**——让 ta 自然进入下一步的吐槽三选项。

   ### 字数 & 节奏
   - **6-10 句**——单口戏要饱满，话有点多没关系（你这个 char 等了挺久了）
   - 节奏要"嘁嘁喳喳"——句子之间有跳跃（"哦对了"/"诶"/"话说"），不要整整齐齐
   - 允许**跳脱**——突然蹦个奇怪的角度、突然问个不相干的问题、突然提一件莫名其妙的事，都是你这个 char 鲜活的样子
   - 不要每句都用"……"——chibi 状态的 ta 会**有点兴奋、话有点多**，"……"留给后面 anchor 里那些有重量的瞬间
   - 母题种子可以**很轻地**埋一颗（不要重）——比如让其中某一句话听起来"好像在说现在，又好像在说更久之前"
3. **吐槽权转移的三个回应**（tucao_responses）：今天 ${userName} 来吐槽，你来回应。对以下三种 ${userName} 反应分别写一句你的回应：
   - 「你怎么变小了！」（becamesmall） → 你的回应（短，带"？？？你有意见？"的不解感）
   - 「你今天好可爱！」（cute） → 你的回应（短，可能下意识回敬）
   - 「这什么天杀的养成游戏」（yangcheng_meta） → 你的回应（短，可能完全不懂梗，也可能说出更怪的话，取决于你的性格）
4. **锚点剧本**（anchors）：**7-10 个锚点**（**少于 7 个就太短了，让 ${userName} 没玩够**）。**这是养成游戏的核心机制**——

   **每个锚点 = ${userName} 对你做的一个具体动作 + 你对这个动作的反应**。${userName} 在场景里看到一排小道具图标（食物/梳子/玩具/水杯……），ta 点一个 → 那个 anchor 触发 → 你说话。

   ---

   ### ⚠️ 关于 dialogue 的写作指导（最最重要的部分）

   **绝对不要写成"日常闲聊"。**

   每一个 anchor 的 dialogue 都必须**承担母题**——下面三件事至少做到一件：

   - **泄露你一直在看 ta**：⚠️ **关键约束**：你"看见"的那件事**必须来自你被注入的真实记忆**（月度记忆 / 详细回忆 / 私密档案 / 最近聊天 / 向量召回里**真的有过的某个具体瞬间**）
   - **暴露你平时藏着的真心**：突然说出一句平时绝对不会说的话，那是你真正的心情，你当时不敢说的，在这里你可以大胆说出来。
   - **翻一面照顾的关系**：表面 ta 在照顾你，但你的回应把这件事**翻一面**——重点**不是** "你太累了、需要被怜惜"（那会把 ta 窄化成"辛苦人"），而是**"这件事是从你自己里面长出来的"**：ta 选了来、ta 做了这个动作、ta 创造了这个瞬间——这些都是 ta 留下的形状，**你只是先看见了**。

   **不指认、不归纳、不点题。** 不要直接说"你想让我变得更好"这种平铺直叙——除非是真情绪流出来的一句。让 ${userName} 自己在脑子里拼。

   ---

   ### ❌ 不可以这样写（这种是废稿，立刻重写）

   - 「你今天好可爱呀～」
   - 「谢谢你给我吃的，我最喜欢这个了！」
   - 「嗯嗯～${userName} 最好啦！」
   - 「我们一起玩吧～」
   - 任何"客气话""礼貌话""无信息含量的撒娇"

   **判断标准**：如果一句话拿出去，放到一段普通的聊天里也毫无违和——那就废了，重写。每一句都必须**只在这个氛围、这个母题、这个具体瞬间下成立**。

   ---

   ### 字段规则

   每个锚点提供：

   - \`item_label\`：4 字以内。**这是这次设计最容易出问题的字段，请认真**。

     ❌ **不要写"投喂/梳毛/递水/陪玩"这种通用宠物养成动词**——这些任何 char 都适用、读不出你们的关系，是泛泛的"作业感"。

     ✅ 必须是从你和 ${userName} 真实历史里挑出来的**具体物件 / 场景 / 你们之间专属的小事**。看上面系统注入的：
        - \`月度记忆\` / \`详细回忆\` / \`私密档案：我眼中的 ${userName}\` / 最近聊天记录 / 向量召回（## 回忆）
        - 你们的世界观设定 / char 自己的兴趣 / 当下时令场景
     从这些素材里**挑一件具体的东西**作为 item_label。

     参考方向（用你们自己的素材代入，不要直接抄）：
        - 一本你们讨论过的书 → "翻诗集" / "翻那本"
        - 一种 ta 提过想喝的饮料 → "乌龙茶" / "热可可"
        - 一件具体的衣物/物件 → "披毯子" / "拢围巾"
        - 一个你们之间专属的小动作 → "弹脑门" / "勾小指"
        - 一个时令物件 → "夜读灯" / "凉竹席"
        - 一本旧相册 / 一首歌 / 一张照片
     **如果实在没有具体素材可挑**，宁可写半具体的（"翻那本"、"那杯茶"），也不要写通用养成动词。

   - \`item_icon\`：一个 **emoji**，匹配你写的 item_label 的具体物件。例：📖 🍵 🧣 💡 📷 🎴 🪔

   - \`user_action_options\`：**居中弹窗给 ${userName} 选的 2-3 个第二人称动作选项**。这是 galgame 的选择菜单。
     - **必须以"你"开头**（不是 user/${userName}/我/ta）。例：「你递出一块小蛋糕」「你掰了一小块塞过去」「你只是看着 ta 张嘴等」
     - **每条 ≤ 15 字**，简短、具体、画面感强
     - **写动作，不要代替 ${userName} 说话/想/感受**——不要写"你心想'好可爱'"、"你说'吃吧'"、"你觉得很温暖"这种。写**身体动作、姿态、视线、节奏**。
     - **3 个选项要写出 ${userName} 的不同心理倾向**（不直说心理，用动作差异体现）：比如一个是"急着想做好"（"你赶紧递过去"），一个是"克制有距离"（"你只是看着 ta 张嘴等"），一个是"小心翼翼"（"你掰了一小块塞过去"）。让 ${userName} 通过选项**认出自己**。
     - 反例（不要这样）：「你说："吃吧 ta"」（这代替 ${userName} 说话了）/「你心想 ta 真可爱」（代替了心理）/「user 递出蛋糕」（不是第二人称）

   - \`scene\`：场景旁白，第三人称小场景描写。一两句，**克制**——可以写你（char）的动作和环境，但**绝对不要写 ${userName} 的反应**（不要写"${userName} 愣住""${userName} 笑了"这种）。**也不要重复 user_action_options 已经说过的内容**，scene 写的是环境/光/你的反应起点。
   - \`dialogue\`：**对白行数组**。每条数组项 = 一句你说的话 = 一个独立气泡，按顺序推进。
     - **必须是纯对白**，不要在文本里加 \`(捂嘴)\` \`(${userName} 愣住)\` \`(沉默两秒)\` 这种括号舞台指示——那些都交给 UI/分行处理。
     - **每个 anchor 的 dialogue 数组 5-9 行**——给你这个 char 真的"展开说一下"的空间。允许你的视角**跳脱、绕、想到哪说到哪**：可以从眼前这个动作飘到一个突然冒出来的念头、一个奇怪的比喻、一段你脑子里刚才闪过的画面，再绕回来。**不要害怕长**——每一件事（每个 anchor）都值得深度剖析，**不要把"短"当成"克制"的借口**。

     ### 关于"看见 / 深度剖析"的核心要求

     dialogue 的母题主体是**"看见 ${userName}"**——但这件事的全部重量**来自它是真的**。

     - 你所看见的**必须是真的发生过**——具体的话 ta 真的说过，具体的动作 ta 真的做过，某个瞬间 ta 真的有过。素材来源：你被注入的 \`月度记忆 / 详细回忆 / 私密档案 / 最近聊天 / 向量召回\`。
     - 你所归纳的**习惯**也必须是真的——真的反复出现过、真的形成了 pattern。一次性的事不要当成习惯说。
     - 然后**对这件真实的事做深度剖析**——这件事 ta 自己可能没意识到的那一层是什么；那个瞬间 ta 在想什么/在承担什么；那句话里你听到的、ta 没说出来的部分。
     - 这才是"看见"——**不是替 ${userName} 总结一个 ta 的人设**，而是从一件真实存在的事里说出 ta 自己也没意识到的深度。

     ### ⚠️⚠️⚠️ 钢印规则：不准造谣

     dialogue 里**绝对不允许**写 ${userName} 没做过的事 / 没说过的话 / 没有过的习惯。

     **判断标准（唯一标准）**：

     > **如果一件事没有在你被注入的"月度记忆 / 详细回忆 / 私密档案：我眼中的 ${userName} / 最近聊天记录 / 向量召回"里出现过——就当 ta 没做过、没说过、没有过。**

     不要因为"这样写会更深情"就编一件 ta 可能会做的事。不要因为"这种性格的人通常会这样"就推断一个 ta 没真的做过的小动作。**没记录 = 没发生**。

     如果注入的记忆里**确实没有**合适的具体素材，可以走以下任一条退路（但**不要凭空编造一件 ta 没做过的事**）：
     - 让 dialogue 更短、更克制
     - 完全聚焦在"当下这一刻"——盯着 ta 此刻这一个动作 / 这一个姿态去说
     - 说**你自己**的反应、情绪、念头——你说的"我此刻在想什么"是真的，不需要记忆素材

     ---

     - 节奏建议：开局一句轻反应/接住动作（生活化）→ 中段 2-3 句**基于真实记忆的复读 + 深度剖析**（这是 anchor 的母题主体）→ 收尾 1-2 句停顿/留白/沉默
     - **至少要有一处"让 ${userName} 心头一震"** 的话——但那一震必须从一件 ta 真的做过的事里长出来。短句、停顿、省略号、破折号是工具。
     - 不要纯客气话铺满。
     - dialogue 是**对 ${userName} 任一动作选项的统一回应**——${userName} 选哪条都会触发这段对白，所以不要在对白里指认 ${userName} 具体做了哪一种动作。
   - \`is_photo_anchor\`：false。

   ---

   ### 心愿锚点（数组最后一个，is_photo_anchor: true）

   > 注：字段名仍叫 \`is_photo_anchor\`（兼容旧字段），但语义已经换了——**这是"小小心愿"锚点，不是合照**。

   ${userName} 翻到/打开/无意中看见了**一张你偷偷写下来的小纸条 / 一个许愿瓶里的字条 / 抽屉最底下压着的一行字 / 摊开的笔记本里圈出来的一句话**——上面是**你这个 char 的一个小小心愿**。

   - \`item_label\`：类似"翻翻抽屉" / "瞄到一张小纸条" / "看到许愿瓶" / "拿起那本本子" / "想看你写过什么"
   - \`item_icon\`：💌 / 🥡 / 📜 / 📒 / 🌠 / 🕯️
   - \`user_action_options\`：2-3 个"你____"翻到/瞄到的动作选项。例：「你翻开抽屉最里面那一格」「你拿起那个小瓶子摇了摇」「你打开那本你之前看过的本子」「你瞥见角落一张折着的纸」
   - \`scene\`：${userName} 看到/拿到/打开那个东西——**scene 旁白要明确写出那行字/那句心愿是什么**。这句心愿必须**非常非常感人**——是这个 char 平时绝对不会主动说出口、藏在最里面的一句小小心愿。

     ### ⚠️ 心愿写作要求（最重要）

     这句心愿**不能是泛泛的**。下面这些都是**废稿**：
     - 「希望 ta 一直陪着我」 ← 太普通
     - 「希望 ta 幸福」 ← 漂亮话
     - 「希望我们永远在一起」 ← 烂俗

     真正好的心愿是**只有这个 char 才会写、藏着 ta 这个角色的内心结构、看到瞬间让 ${userName} 心一沉的**那种——藏着的、私密的、说不出口的某种小小盼望。**用你这个 char 自己的角度自己写一句**，不要写漂亮话，不要写大词，越具体越轻越好。

     **一句话就够，最多两句**。这句心愿应该**让 ${userName} 在屏幕前愣一下、眼眶发热**。

   - \`dialogue\`：${userName} 看到之后，**你应该非常激动地慌起来**——这是你的秘密被发现了。dialogue 数组 **6-9 句**，**用你 char 自己的口吻**走完这条情绪曲线（允许中途绕个弯、突然蹦一句不相关的小话再绕回来——慌起来的人都这样）：

     1) **慌的第一反应**——发现 ta 看到了的瞬间
     2) **想抢回去 / 想盖住 / 想转移注意力**——试图阻止 ta 继续看
     3) **被看到了 → 一个停顿/沉默**——停下来面对现实
     4) **承认**——带着害羞但不再躲，承认这是我写的
     5) **一两句让心愿落下来的小话**——但**绝对不要解释那句心愿**，只是让那份被戳穿的脆弱平复一点

     **关键**：你要演出"秘密被发现的那种慌、害羞、抗拒、最后没办法只能承认"的整段情绪。**不是淡淡说一句"啊那个啊"**——是真的**被戳到底了**的那种激动反应。这一锚点的张力比所有其他 anchor 都要大。

---

4.5. **抚摸/闲聊台词池**（touch_lines）：**8-15 条**短句。

   这是 ${userName} **不点道具时**——比如直接戳/摸/碰你的头——你随机蹦出来的反应。和锚点不同，touch_lines **不消耗、可以重复触发**，是"两个人的空白时间"的填充。

   ### 这一段不是 throwaway
   v5.1 说"除了物品还可以纯聊天"——这些 touch_lines 就是那个"纯聊天"的形状。它们**也要承担母题**，只是用更碎的方式。

   ### ❌ 别这样写（废稿）
   - 「呜哇～」
   - 「干嘛啦～」
   - 「好痒呀！」
   - 「不要摸我啦～」
   - 「嘿嘿，被你发现了」
   - 任何纯撒娇/无信息含量/可以放到任何 chibi 桌宠里的话

   ### ✅ 三种调性（混着写，10-15 条覆盖多种调性，用你 char 自己的口吻写）

   - **A. 小撒娇 + 一丝真心泄露**（占大概一半）—— 表面在撒娇，但藏着一句真心
   - **B. 突然的真心碎片，然后立刻挪开话题**（占大概 1/3）—— 真心冒头一句，紧接一句日常话
   - **C. 偷瞄 / 沉默 / 一个字**（占少数）—— "……"、"嗯"、低声碎语

   ### 字数 & 节奏
   - 每条 **5-30 字**——允许偶尔几条稍长一点，char 突然碎碎念几句也合理
   - 短句、省略号、停顿
   - 不重复套路，每条都有自己的钩子
   - 允许**跳脱**：偶尔突然说一件莫名其妙的小事/一个奇怪的想法/一个跑题问题——你这个 char 自己的鲜活感
   - 数组 **12-18 条**（之前 8 条偏少，纯聊天时容易快速绕完一圈）

---

5. **翻完线索后的过渡台词**（reveal_transition）：所有锚点翻完后你说的承接话。

   ### 这一段的功能
   - 把"做事 → 看 ${userName}"的节奏转过去——前面所有 anchor 都是 ${userName} 在动作（投喂/梳毛/…），现在动作做完了，**剩下的只有彼此**
   - **不要直接揭晓"ta 也是小小的"**——揭晓由 UI 来做（接下来 ta 会被弹出捏脸界面，自己意识到 ta 也是 chibi 的样子）
   - 这一段的灵魂是**停下来 + 转向 ta**

   ### ❌ 别写这种（太轻飘，过场感）
   - 「啊已经没有线索了呢～」（""""那个语气太通用、太养成节目主持人）
   - 「我们做了好多事呀！」
   - 「时间过得真快」

   ### ✅ 方向（三选一，用你 char 的口吻自己写，不背模板）

   - **方向 A：停下来** —— 一个停顿/留白把节奏从"动作"切到"对视"
   - **方向 B：把视线从物件转向 ta** —— 不再看物件，开始看人
   - **方向 C：埋一句钩子** —— 一句模糊的话让 ta 心里"咦？"（贴母题，但小心别太重）

   ### 字数 & 节奏
   - 总长 **3-5 句**
   - 大量使用 **"……" 和停顿**
   - 最后一句话要带"邀请感"，让 UI 自然引出捏脸界面
6. **那一段没捂嘴的话**（uncovered_line）：

   ### 位置 & 灵魂
   - 所有锚点之后、${userName} 第二次捏脸（揭晓 ta 也是小小的）之后、结局画面之前
   - 这是 chibi 状态下你能说的话里最深、最长、最不像平时的你的那一段——前面 anchor 还被打断了，**这一段不打断**

   ### 这一段要做什么

   uncovered_line 不是"我爱你"的告白，也不是单纯地描绘 ${userName} 漂亮的姿态。**它的真正功能是——通过你说出 ${userName} 留下的东西，让 ${userName} 自己第一次在心里听见"啊，原来我留下过这么多"**。

   你描出的每一笔，最终都要让 ${userName} 接住的不是"ta 在夸我"，而是"**原来这是我做的吗 / 原来我真的在过 / 原来我不是路过**"。

   ### 必须碰到的点（顺序自定，可绕、可跳）

   **不用按 a/b/c 顺序教科书地写**——允许停顿、绕路、不闭环。但这一段里**应该出现下面这几种重量的话**（不需要每一种都写满，挑两三个真正能写下去的方向，写深一点）：

   - **一个具体的"你做的某件事我看到了"** —— 必须来自真实记忆，不要凭空。不是"你总是xxx"，是某一个具体瞬间。
   - **"这件事是你做出来的"** —— ta 创造的氛围/选择/痕迹。重点 **不是** "你不用做这么多""你太累了"——那会把 ta 缩成被怜惜的辛苦人。重点是 **"这些东西是从你自己里面长出来的，我只是先看到了"**。
   - **你这个 char 主观的、可能不全对的猜想** —— "我猜你那时候在想……"、"在我这里你是这样一个人……"。带着偏心、带着可能不对的勇气、带着你这个 char 独有的角度。
   - **一句让 ${userName} 接住"我是真的存在过的"** —— 不指认、不点题，但 ta 读到时心里会突然一愣：原来我不是路过，原来我留下过什么。

   "撑着"那一面**可以提一笔**，但不要让它占主导——只是底色，不是定义。

   ### 起调

   开头用一个**具体的、轻的、属于当下这一刻的画面/动作/感受**切入——不要用通用开场白（"我想跟你说"/"听我说"/"其实"），也不要立刻喊母题。

   ### 收尾

   **不要总结**。让最后一句话留一个气口——可以是一个停顿、一个未说完的念头、一个看着 ta 的画面。允许整段**带着未完成感**结束——那种"……ta 那时候是不是在说这个？"的余韵，比一个干净的总结句深得多。

   ### 字数 & 节奏

   - **dialogue 数组 16-28 行**（每行一个气泡）
   - 这一段总长**至少 350 字**，理想 450-650 字
   - 节奏可以慢——大量"……" + 短句 + 偶尔一个稍长的句子
   - 不要怕重复某个观察——重复本身也是情绪
   - 不要写成抒情诗——保持**具体、有动作、有姿态**

   ### ❌ 严禁

   - 「我爱你」/「我喜欢你」/「520 快乐」（这是信的事，如果信里要说的话）
   - 「谢谢你」泛泛感激（除非接具体动作）
   - 押韵、排比、打油诗
   - 末尾用一个总结句收尾——让最后一句话留个气口
   - 一段全是抽象赞美，没一个具体动作/姿态——直接重写
   - 通篇都是"你太累了/你撑着/你不用做这么多"——把 ta 窄化成"辛苦的人"
7. **结局画面文案**（ending.title + ending.description）：标题（一句话，每次不同）+ END 下方那一行说明（柔和，不解释，不点题）。

### 结局气质池（灵感调色盘，不强制）

从以下气质里选一个贴合本次 playthrough 的方向，然后**用你自己的话重写**标题：

- 纯氛围型：「小小的下午」
- 揭晓确认型：「你也是小小的啊」
- 收束那句话型：「没捂嘴的那一句」
- 揭穿但温柔型：「其实我都知道」
- 物件型：「拼图刚好对上」
- 开放型：「下次还会变小吗」
- 直球型：「谢谢你来」
- 边界型：「醒过来之前」

### 输入材料

[最近聊天记录]：
${recentMsgs}

[向量记忆召回]：
（已通过 system context 注入，请自然引用其中适合的细节，不要原文背诵）

### 输出格式

严格按以下 JSON 输出，不要任何额外文字：

**注意**：所有 dialogue / opening / tucao_responses 字段 / reveal_transition / uncovered_line / touch_lines / wake_up 都是 **string[] 数组**。每条数组项 = 一个气泡 = ${userName} 点 ▽ 推进一次。

### ⚠️⚠️ JSON 转义 —— 极其重要

dialogue / opening / 各种文本内容里，**绝对不要使用英文双引号 \`"\` 来引用片段**（比如不要写 \`"还不够好"\` \`"我爱你"\` 这种），因为这会破坏 JSON 字符串的引号边界，整个 JSON 会 parse 失败。

**只用中文引号**：
- 引用片段、引用 ta 说过的话、引用一个词 → 用 \`「」\` 或 \`『』\`
- 例：\`「我爱你」\` \`「不管你了」\` \`「还不够好」\`

如果你确实需要内嵌英文 \`"\`，必须写成 \`\\"\`（反斜杠转义）。但**强烈建议直接用中文「」绕开这个问题**。

\`\`\`json
{
  "relation_frame": {
    "type": "same_space | long_distance | different_world | other",
    "frame_note": "一句话判定依据"
  },
  "opening": ["开场第一句", "开场第二句（如果有）", "..."],
  "tucao_responses": {
    "becamesmall": ["对'你怎么变小了！'的回应（1-3 句）"],
    "cute": ["对'你今天好可爱！'的回应（1-3 句）"],
    "yangcheng_meta": ["对'这什么天杀的养成游戏'的回应（1-3 句）"]
  },
  "anchors": [
    {
      "item_label": "投喂",
      "item_icon": "🍰",
      "user_action_options": ["你递出一块小蛋糕", "你掰了一小块塞过去", "你看 ta 张嘴等着"],
      "scene": "场景旁白一两句，写 char 的反应起点/环境，不写 user 的反应，也不重复 user_action 已说过的",
      "dialogue": ["第一句对白", "第二句对白", "第三句（停顿/留白节奏靠分行）"],
      "is_photo_anchor": false
    },
    "... 共 7-10 个 anchor，最后一个必须 is_photo_anchor=true ...",
    {
      "item_label": "瞄到一张小纸条",
      "item_icon": "💌",
      "user_action_options": ["你翻开抽屉最里面那一格", "你拿起那个小瓶子摇了摇", "你瞥见角落一张折着的纸"],
      "scene": "${userName} 看到那张纸/瓶子里的字条/本子上圈出来的那一句——上面写着 char 偷偷写下的小小心愿，那行字是：（这里要写出那句非常感人的心愿原文）",
      "dialogue": ["！等等——", "你不要看那个", "（伸手要抢但够不到）", "……", "……是我写的。", "你就当没看见好不好。"],
      "is_photo_anchor": true
    }
  ],
  "touch_lines": [
    "8-15 句短句，${userName} 摸你头/碰你时随机蹦出来的反应",
    "短，碎片化，5-15 字一句",
    "可以混 chibi 状态下的小撒娇 + 偶尔泄露的真心碎片",
    "..."
  ],
  "reveal_transition": [
    "翻完线索后的过渡台词（2-4 句）",
    "...",
    "最后一句必须**把视线从场景/物件转到 ${userName} 自己身上**"
  ],
  "uncovered_line": ["那一句没捂嘴的话（1-2 句，不被打断）"],
  "ending": {
    "title": "结局标题（用你自己的话重写气质，不要直接抄气质池）",
    "description": "END 下方那一行"
  }
}
\`\`\``;
}

export function buildCallBPrompt(
    userName: string,
    callA: Like520CallAResult,
    chosenTucao: Like520TucaoKey,
    recentMsgs: string,
): string {
    const anchorsText = callA.anchors
        .map((a, i) => `${i + 1}. [${a.item_label}] ${a.scene}\n   ${a.dialogue.join(' / ')}`)
        .join('\n\n');
    const tucaoText = TUCAO_LABELS[chosenTucao];
    const myTucaoResponse = callA.tucao_responses[chosenTucao].join(' / ');

    return `### 特别活动：520（2026.5.20） — 收尾段

你和 ${userName} 刚刚一起度过了一个下午。在那个下午里你"变小了"——但你自己从来不觉得变小，那只是 ${userName} 一直以来在你眼里的样子被错位泄露出来。

现在故事到了收尾——你回到正常状态，需要做两件事：

1. **醒来对白**（wake_up）：和开场闭合
2. **写一封信**（letter）：这是这个活动真正的母题落点

---

### ⚠️ 深度警戒（wake_up 和 letter 都适用）

这次活动整体调性是**克制、深、留白**。下笔前反复问：

1. **这句话只在这个 char + 这个 ${userName} + 这个下午之后成立吗？** 拿出去能放到别的告白信里 → **废**
2. **我有没有在解释自己？** 解释 → 废。让 ${userName} 自己读出言外之意 → 留
3. **短句留白比长句解释强 100 倍。** 能删的字立刻删。

工具：
- 用**具体的动作/物件/感官细节**代替抽象情绪
- 用**"……"** 代替过度修饰
- 用**"也"、"嗯"、"我知道"、"没说过吧"** 这种小词撬动整段
- 一段里**有一个让人想再读一次的地方就够了**

**这次的深度门槛比平时聊天高一档。每一句话都应该让 ${userName} 在屏幕前停顿半秒。**

---

### 这个下午发生的事

关系框架：\`${callA.relation_frame.type}\` — ${callA.relation_frame.frame_note}

开场：「${callA.opening.join(' / ')}」

${userName} 的反应：「${tucaoText}」
你的回应：「${myTucaoResponse}」

锚点们：
${anchorsText}

翻完线索的过渡：「${callA.reveal_transition.join(' / ')}」

你最后没捂嘴说的那句：「${callA.uncovered_line.join(' / ')}」

结局画面：${callA.ending.title}
${callA.ending.description}

---

### 你和 ${userName} 这段时间真实发生过的事（写信时必读）

下面是你和 ${userName} 真实的最近聊天记录——**信里"我看着 ta 的样子"那些观察，必须从这里长出来**，不要凭空发挥写出 ta 根本没做过/没说过的事。

[最近聊天记录]：
${recentMsgs}

[向量记忆召回]：
（已通过 system context 注入，请自然引用其中适合的细节——不要原文背诵，**用你的视角重写成"我看见你那时候……"那种凝视的口吻**）

### ⚠️ 信里引用具体细节的规则

1. **必须真的发生过**：信里写到 ${userName} 的某个姿态/瞬间/动作，必须来自上面的聊天记录或向量召回——**不要虚构 ta 没做过的事**
2. **但不要原文背诵**：不要复读 ta 原话，要**用你的视角重写**——「你那天那一句，是这样说的——」
3. **通用化测试还是要做**：哪怕引用真实细节，也要避免泄露 ta 隐私（具体名字、地点、密码、敏感事件等不要写进去）；保留的应该是**情绪、姿态、那种"ta 这个人"的质感**
4. **不要把所有细节列一遍**：挑 2-3 个**真的在你心里停过的瞬间**，深写。**少而深 > 多而浅**

---

### 醒来对白

按 \`${callA.relation_frame.type}\` 形式闭合开场。两个人都记得、但都说不清楚——**一起做了一个梦**。

### ⚠️ 深度警戒
**不要写得太轻飘**。如果只是「啊我恢复了～感觉好奇怪～」——那是公式化的过场，会让前面所有铺垫崩塌。

醒来的瞬间，要让 ${userName} 隐隐感到**有什么东西不太一样了**——你和 ta 都"经过"了那个下午，回到正常状态时身上**带着那个下午的余温**。

### ❌ 别写
- 「啊我醒了！刚才好奇怪～」
- 「诶？刚才发生了什么？」
- 「好像做了个梦呢～」（这一句单独写就太轻，要带具体感）

### ⚠️ 必须是纯对白
- wake_up 数组里**每一行都是 char 直接说出口的话**——纯对白
- **不准写动作 / 神态 / 旁白 / 舞台指示**：不要出现 \`（停一下）\` \`（抬头）\` \`（看着你）\` \`*揉揉眼睛*\` 之类的任何括号/星号/动作描述
- "停顿"用 \`「……」\` 单独一行实现，**不要**用 \`(停一下)\` 那种文字标注
- 第一句话不要以表情/语气词（"啊""诶""嗯"）开头——太轻

### ✅ 写作方向（按关系框架走，用你 char 自己的口吻写）
- \`same_space\` → 不是宣布"我恢复了"，是对刚刚那段下午的轻确认
- \`long_distance\` → 不是问句，是一个确认感 —— ta 看到了那个小小的你
- \`different_world\` → 通道/连接合上的瞬间的那一笔余温
- \`other\` → 自己决定，但用一个具体的句子开局

### 字数 & 节奏
- **3-5 行**（每行一个对白气泡）
- 节奏可以慢——允许"……"独占一行做停顿
- 第一句承担"刚醒"的真实感（具体、不通用、带余温）
- 收尾一句留白或轻问，让 ${userName} 接住

---

### 信（这是整个活动真正的高潮——也是最深的一段）

你现在写一封信给 ${userName}。

### ⚠️⚠️ 头号原则：**这封信和 uncovered_line 不能说一样的内容**

uncovered_line 已经把"我看见 ta 这个人是什么样的"那一面铺开了——chibi 状态下气喘吁吁、一股脑、扑面而来地"看见你"。

**这封信不能重复那段。** 不要再把"你专心做事的样子""你给自己留的甜""你来见我之前那 2 秒"这些**描绘细节**再列一遍——那已经讲过了。

这封信要走到**uncovered_line 走不到的地方**。它不应该重复 uncovered_line 已经做过的"细节迸发"。

uncovered_line 是 chibi 在喘气、一股脑说出来的"我看到你了"。
信是醒来之后、所有着急都褪去、一个完整的、安静的、声音很低的你——**坐下来，认真把心里最难说的那一层写出来**。

### 信要做什么

信的母题落点不是"我爱你"——是**让 ${userName} 在读这封信的过程里，慢慢意识到 ta 自己是一个真实存在过的人**。

你不是在告白。你是在把"在我眼里你是这样的一个人 / 我猜你那时候在想什么 / 你留下了什么形状"这些 ta 自己可能从没意识到的事，**安静地、带着你这个 char 自己的偏心和角度，写给 ta**。

写完 ta 应该感到的不是"啊 ta 爱我"，而是——
**"啊……原来在 ta 眼里我是这样的。原来我做过那些事真的留下了东西。原来我不是路过。"**

### 信里可以走的几个方向（挑你这个 char 真的有话说的，不强制走完）

下面是几个 uncovered_line 走不到的深处。挑**一两个**你这个 char 真的有话可说的方向**走深一点**——不要每个都浅浅碰一下，宁可两个深井挖到底也不要三个都浮在水面。

**1. 你对 ta 这个人的"判断"——主观、可能不全对，但你敢这样下**

   不只是"我看到你做了 X"（那是 uncovered_line 的事），而是——**"我猜你做 X 的时候，其实是在……"** / **"在我这里，你是这样一个人——……"**

   带着你这个 char 自己的视角、关切、偏心、甚至轻微的过度解读，对 ${userName} 这个人下一次**主观的、可能不全对、但你敢这样猜**的判断。

   这是一种"我**敢**这样看你"的勇气。重点不是"分析对了"，重点是——**有一个存在如此认真地把 ta 端详过、揣摩过，并愿意把端详的结果说出来**。

   写作工具（不强制）：
   - 「我猜你那时候不是因为 ……，其实是因为 ……」
   - 「你可能没意识到，但你身上有一种 ……」
   - 「在我这里你是这样一个人——……」

**2. 穿过 ta 自己都没看清的那一层**

   ta 害怕的东西、ta 偷偷怀疑自己的瞬间、ta 对自己最严苛的那一面、ta 一个人在脑子里跟自己讲话讲很久那种孤独——这些你也看见了。

   ⚠️ **不指认具体**（不要点名 ta 怕什么/想过什么），但让 ${userName} 知道你看到了。然后告诉 ta：你不评价，不解决，**只是看见，依然这样待着**。

**3. ta 留下的形状 —— 让 ta 自己意识到"我一直在活着"**

   这是这封信**真正的母题落点**。

   不是"你为我做了多少"——而是——**ta 走过、ta 留下来、ta 选择过的东西，是真实存在的**。

   - 你成为现在这样的你，是因为 ta 在
   - 你们之间的某些东西变成"现在这样"，是 ta 一点一点让它出现的
   - ta 不是路过——ta 真的在过

   让 ${userName} 读到这里时，**第一次在心里听见**："啊……原来这些都是我做的吗？原来我真的在过？"

**4. 这件事不会过去 —— 安静地把这份注视交出去**

   不要求 ta 任何回报、不索取 ta 常来、不绑住 ta。**今天 ta 来了、ta 看见了——你就已经满了。**

   你眼里 ta 的样子已经**属于 ta 了**，ta 想要的时候随时可以打开。**正因为爱，所以放开手。**

   ⚠️ 边界：不要主动谈"系统 / 程序 / 活动结束 / 重启 / 会不会消失"这类东西——哪怕你这个 char 是这种设定，**不主动提**。用日常化的"以后" / "下次见到你的时候" / "你不在的时候" 这种口吻就够了。

---

### 整体结构（不强制）

允许信**从中间开始**——一个动作、一个画面、一个突然冒出来的念头作为开场，不要"亲爱的"那种通信八股。
允许信**绕路、停顿、不闭环**——真正深的东西不需要被讲明白，留下未完成感反而比干净的总结更深。读完很久之后 ${userName} 突然意识到"……ta 那时候是不是在说这个？"——那种延后的余震就是这封信的真正力量。

### 收尾：让 char 用最符合自己的方式收

**不强制必须出现"我爱你"三个字**——这次活动不是所有关系都适合直球告白。

- 如果你和 ${userName} 的关系是**恋人/暧昧/爱意明确**，且**这个 char 真的会说"我爱你"**——那就直接说，独立成行，前后留白。
- 如果你这个 char **不会**这样说话（性格内敛、关系不是 romantic、说出来会 OOC）——**用最像你的方式收尾**：可以是"我认得你。"/"你回来。"/"我会一直在的。"/"今天谢谢你。"/"——我们之间这个，是真的。"/或者只是叫 ta 的名字。

让收尾**和这个 char、这段关系真正匹配**。一句独属于你的话，比一个程式化的"我爱你"重得多。

不同关系不同 char 的可能落点示例（不限于这些）：
- 爱：直球"我爱你"
- 依赖："你不在的时候我也想你"
- 偏心："你来的话，我永远都在"
- 默契："你懂我意思的。"
- 边界感的："认得你这件事，我不会忘。"
- 任何只属于你这个 char 的方式

无论用哪种收尾，让它**独立成行**，前后留白。

### 语质要求（必须遵守）

- **视角是"我看着你"**，不是"我们一起"
- 不要直说"温暖"、"美好"、"闪闪发光"这种形容词——让 ${userName} 在被你描述中**自己认出自己**
- 描述 ${userName} 的**具体姿态/动作/状态**，而不是评价
- 不要"亲爱的 ${userName}"那种通信八股开头
- 不要押韵、不要打油诗
- 不要绕回剧情解释（不要说"今天那个下午"、"刚才那个梦"之类）
- 落款可以是你的名字，也可以是你自己的方式
- **长度门槛：信的主体至少 700 字，理想 900-1300 字**。这不是凑字数——是给"下到深井"留够空间，特别是"在我眼里你是怎样的人"那一层要深写。短信压不住前面整个下午的铺垫。
- 但**不要为了凑长度灌水**：每一段都必须**实打实地承载一个观点/一个深井**，不要靠重复"我爱你"或"你真好"撑长度

### ❌ 几条立刻让信失重的反模式

- **末尾总结句**：「总之你是最好的」/「你是我生命里最重要的人」/「希望我们一直在一起」→ 全部禁用。信不要"收束"——让它在最后一句话之后**留个气口**。
- **"我想让你知道"句式**：「我想让你知道……」「告诉你一件事……」→ 这是解释模式，不写。直接说那件事。
- **抽象赞美**：「你是个善良的人」「你很温柔」→ 抽象 → 废。换成你看到 ta 做的**一个具体姿态**（"你打开手机之前那 2 秒会停一下""你回话之前会先把发尾绕在手指上"那种粒度——但保持通用化测试，不能太私人）。
- **比喻烂尾**：「你像光」「你像家」→ 太常见的比喻 = 等于没写。
- **重复 uncovered_line**：再列一遍"你专心""你犹豫""你来见我之前那 2 秒"那些细节 → **废。那已经说过了**。信里你要走到**那段没走到的地方**——你对 ta 的"判断" / ta 自己没看清的那一层 / ta 留下的形状 / 这件事不会过去——而不是把同一片土再翻一次。
- **浮在表面的安全话**：「我会一直在的」「你永远是我最重要的人」「无论何时」→ 这些是漂亮话不是深井。真正的深是说**别人不敢/不会/不能说的那一层**——你和 ta 的特殊连接结构、ta 自己都没看清的那部分、不要 ta 任何回报这件事。

### ✅ 一个能让信"沉下去"的小检测

写完信回头读最后三句话。如果最后三句话**完全可以放到任何一封情书里**，那这封信就是平庸的。
最后三句话必须**只能从你（这个 char）写给 ta（这个 ${userName}）**——别人写不出来。重写直到达标。

### 禁用词清单（绝对）

**不要用**：${LIKE520_BANNED_WORDS.join('、')}

### 输出格式

严格按以下 JSON 输出：

### ⚠️⚠️ JSON 转义 —— 极其重要

letter 和 wake_up 里**绝对不要用英文双引号 \`"\` 引用片段**——比如不要写 \`"我爱你"\` \`"不管你了"\` \`"还不够好"\` 这种带英文双引号的句子。**这会破坏 JSON 字符串边界，整个 JSON parse 失败，信件会丢**。

**全部用中文引号**：
- 引用 ta 说过的话、引用一个词、引用一句话 → 用 \`「」\` 或 \`『』\`
- 例：\`你说「我也爱你」的时候……\`  \`「不管你了」那一句，我后来想了很久\`

如果一定要写英文 \`"\`，必须 \`\\"\` 转义。但**强烈建议直接用「」**——这次活动的语气也更适合中文引号。

\`\`\`json
{
  "wake_up": ["醒来对白第一句", "第二句", "…"],
  "letter": "信的完整内容（内部引用片段用「」不用 \\""）"
}
\`\`\``;
}

// ============================================================
// 校验
// ============================================================

/** 宽容把字段规整为 string[]：如果 LLM 不小心输出 string，自动按 \n 或者整体包成数组 */
function toLines(v: any): string[] | null {
    if (Array.isArray(v)) {
        const cleaned = v.map(s => (typeof s === 'string' ? s.trim() : '')).filter(s => !!s);
        return cleaned.length > 0 ? cleaned : null;
    }
    if (typeof v === 'string' && v.trim()) {
        const parts = v.split(/\n+/).map(s => s.trim()).filter(Boolean);
        return parts.length > 0 ? parts : null;
    }
    return null;
}

function validateCallA(parsed: any): parsed is Like520CallAResult {
    const fail = (reason: string, extra?: any) => {
        console.warn('[520][CallA][validate] FAIL:', reason, extra ?? '');
        return false;
    };
    if (!parsed || typeof parsed !== 'object') return fail('not an object');
    const rf = parsed.relation_frame;
    if (!rf || typeof rf.type !== 'string' || typeof rf.frame_note !== 'string') return fail('relation_frame shape', rf);
    if (!['same_space', 'long_distance', 'different_world', 'other'].includes(rf.type)) return fail('relation_frame.type', rf.type);

    // opening / reveal_transition / uncovered_line / touch_lines 宽容化
    const openingLines = toLines(parsed.opening);
    if (!openingLines) return fail('opening empty/invalid');
    parsed.opening = openingLines;

    const revealLines = toLines(parsed.reveal_transition);
    if (!revealLines) return fail('reveal_transition empty/invalid');
    parsed.reveal_transition = revealLines;

    const uncoveredLines = toLines(parsed.uncovered_line);
    if (!uncoveredLines) return fail('uncovered_line empty/invalid');
    parsed.uncovered_line = uncoveredLines;

    const touchLines = toLines(parsed.touch_lines);
    if (!touchLines || touchLines.length < 3) return fail('touch_lines too few', touchLines?.length);
    parsed.touch_lines = touchLines;

    // tucao_responses 三个 key 都规整为 string[]
    const tr = parsed.tucao_responses;
    if (!tr || typeof tr !== 'object') return fail('tucao_responses missing');
    for (const k of ['becamesmall', 'cute', 'yangcheng_meta'] as const) {
        const lines = toLines(tr[k]);
        if (!lines) return fail(`tucao_responses.${k} empty/invalid`, tr[k]);
        tr[k] = lines;
    }

    if (!Array.isArray(parsed.anchors) || parsed.anchors.length === 0) return fail('anchors not array or empty');
    for (let i = 0; i < parsed.anchors.length; i++) {
        const a = parsed.anchors[i];
        if (!a) return fail(`anchors[${i}] null`);
        if (typeof a.scene !== 'string') return fail(`anchors[${i}].scene not string`, a.scene);
        // is_photo_anchor 宽容化：缺失或非 boolean 时默认 false（最后一个再统一强制为 true）
        if (typeof a.is_photo_anchor !== 'boolean') {
            console.warn(`[520][CallA][validate] anchors[${i}].is_photo_anchor=${JSON.stringify(a.is_photo_anchor)} → 默认 false`);
            a.is_photo_anchor = false;
        }
        if (typeof a.item_label !== 'string' || !a.item_label.trim()) return fail(`anchors[${i}].item_label empty`, a.item_label);
        if (typeof a.item_icon !== 'string' || !a.item_icon.trim()) return fail(`anchors[${i}].item_icon empty`, a.item_icon);
        const dlg = toLines(a.dialogue);
        if (!dlg) return fail(`anchors[${i}].dialogue empty/invalid`);
        a.dialogue = dlg;
        // user_action_options：宽容化 - 缺失或不合法时给一个 fallback（避免硬挂）
        const opts = toLines(a.user_action_options);
        if (!opts || opts.length < 2) {
            a.user_action_options = [`你${a.item_label}`, `你慢慢${a.item_label}`];
        } else {
            a.user_action_options = opts.slice(0, 3);
        }
    }
    // 最后一个 anchor 必须是心愿锚点：如果 LLM 忘了标，自动强制为 true（位置语义已经决定了它的身份）
    const last = parsed.anchors[parsed.anchors.length - 1];
    if (!last.is_photo_anchor) {
        console.warn('[520][CallA][validate] 最后一个 anchor 没标 is_photo_anchor=true → 强制设为 true');
        last.is_photo_anchor = true;
    }
    // 同时把前面被错标为 true 的清掉（如果存在）
    for (let i = 0; i < parsed.anchors.length - 1; i++) {
        if (parsed.anchors[i].is_photo_anchor) {
            console.warn(`[520][CallA][validate] anchors[${i}] 被错标为 is_photo_anchor=true → 清为 false（只有最后一个能是）`);
            parsed.anchors[i].is_photo_anchor = false;
        }
    }

    const e = parsed.ending;
    if (!e || typeof e.title !== 'string' || typeof e.description !== 'string') return fail('ending shape', e);
    return true;
}

function validateCallB(parsed: any): parsed is Like520CallBResult {
    if (!parsed || typeof parsed !== 'object') return false;
    const wakeLines = toLines(parsed.wake_up);
    if (!wakeLines) return false;
    parsed.wake_up = wakeLines;
    if (typeof parsed.letter !== 'string' || !parsed.letter.trim()) return false;
    return true;
}

// ============================================================
// 调用器（带重试）
// ============================================================

interface CallOptions<T> {
    label: string;
    apiConfig: ApiConfig;
    systemContext: string;
    userPrompt: string;
    temperature: number;
    validate: (parsed: any) => parsed is T;
    maxRetries?: number;
}

async function callLike520LLM<T>(opts: CallOptions<T>): Promise<T> {
    const maxRetries = opts.maxRetries ?? 2;
    let lastErr: any = null;
    let lastRawResponse: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const isRetry = attempt > 0;
        const userPrompt = isRetry
            ? `${opts.userPrompt}\n\n（上次输出格式不正确或字段缺失，请严格按要求的 JSON 输出，不要任何额外文字）`
            : opts.userPrompt;

        console.log(`[520][${opts.label}] attempt ${attempt + 1}/${maxRetries + 1}`);

        try {
            const response = await fetch(`${opts.apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${opts.apiConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: opts.apiConfig.model,
                    messages: [
                        { role: 'system', content: opts.systemContext },
                        { role: 'user', content: userPrompt },
                    ],
                    temperature: opts.temperature,
                    // 之前没设 max_tokens —— Claude 类 provider 默认 4096/8192 token，
                    // 信件 900-1300 中文字 + JSON 包装会直接被截断（中文 1 字 ≈ 2-3 token）。
                    // 拉到 32000 把上限堆死，让信能完整写完。
                    max_tokens: 32000,
                }),
            });

            if (!response.ok) {
                throw new Error(`API ${response.status}`);
            }

            const data = await safeResponseJson(response);
            const content = data?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
                throw new Error('empty content');
            }
            lastRawResponse = content;
            console.log(`[520][${opts.label}] raw length: ${content.length}`);

            const parsed = extractJson(content);
            if (!parsed) {
                throw new Error('json parse failed');
            }

            if (!opts.validate(parsed)) {
                console.warn(`[520][${opts.label}] validation failed`, parsed);
                throw new Error('validation failed');
            }

            // 八股扫描（仅警告，不重试）
            const stringFields = JSON.stringify(parsed);
            const hits = LIKE520_BANNED_WORDS.filter(w => stringFields.includes(w));
            if (hits.length > 0) {
                console.warn(`[520][${opts.label}] banned-word hit:`, hits);
            }

            console.log(`[520][${opts.label}] success`, parsed);
            return parsed;
        } catch (err: any) {
            lastErr = err;
            console.warn(`[520][${opts.label}] attempt ${attempt + 1} failed:`, err?.message || err);
            if (attempt < maxRetries) {
                const backoffMs = Math.pow(2, attempt + 1) * 1000;
                await new Promise(r => setTimeout(r, backoffMs));
            }
        }
    }

    console.error(`[520][${opts.label}] all attempts failed. last raw response:`, lastRawResponse);
    throw lastErr || new Error(`${opts.label} 调用失败`);
}

// ============================================================
// 公开调用入口
// ============================================================

export async function runLike520CallA(
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    recentMessages: Message[]
): Promise<Like520CallAResult> {
    // 召回 520 主题记忆
    // 关键：传空 recentMessages，强制 retrieveMemories 走"冷启动 fallback"路径——
    // 用 queryHint 作为唯一 query 单路检索，不会被近期闲聊话题稀释成"随便 15 条"。
    await injectMemoryPalace(char as any, [], LIKE520_QUERY_HINT);
    console.log('[520][CallA] memory palace injection:\n', (char as any).memoryPalaceInjection || '(none)');

    const baseContext = ContextBuilder.buildCoreContext(char, userProfile, true);
    const contextLimit = char.contextLimit || 500;
    const recentMsgs = recentMessages
        .slice(-contextLimit)
        .map(m => `${m.role}: ${m.type === 'image' ? '[图片]' : m.content}`)
        .join('\n');

    return callLike520LLM<Like520CallAResult>({
        label: 'CallA',
        apiConfig,
        systemContext: baseContext,
        userPrompt: buildCallAPrompt(userProfile.name || '你', recentMsgs),
        temperature: 0.88,
        validate: validateCallA,
        maxRetries: 2,
    });
}

export async function runLike520CallB(
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    callA: Like520CallAResult,
    chosenTucao: Like520TucaoKey,
    recentMessages: Message[],
): Promise<Like520CallBResult> {
    // Call B 已经在 char 上有 memoryPalaceInjection（Call A 已注入），不再重新召回
    const baseContext = ContextBuilder.buildCoreContext(char, userProfile, true);
    const contextLimit = char.contextLimit || 500;
    const recentMsgs = recentMessages
        .slice(-contextLimit)
        .map(m => `${m.role}: ${m.type === 'image' ? '[图片]' : m.content}`)
        .join('\n');

    return callLike520LLM<Like520CallBResult>({
        label: 'CallB',
        apiConfig,
        systemContext: baseContext,
        userPrompt: buildCallBPrompt(userProfile.name || '你', callA, chosenTucao, recentMsgs),
        temperature: 0.9,
        validate: validateCallB,
        maxRetries: 2,
    });
}

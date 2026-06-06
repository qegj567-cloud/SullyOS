/**
 * Memory Dive Engine (记忆潜行引擎)
 *
 * 负责：
 * 1. 从记忆宫殿 DB 检索房间/槽位相关记忆
 * 2. 构建 prompt 并调用 LLM 生成探索对话
 * 3. 解析 LLM 响应为结构化对话数据
 * 4. 结算 buff
 */

import type { MemoryRoom, RemoteVectorConfig } from '../../utils/memoryPalace/types';
import type { MemoryNode } from '../../utils/memoryPalace/types';
import type { APIConfig, CharacterProfile, CharacterBuff } from '../../types';
import { MemoryNodeDB } from '../../utils/memoryPalace/db';
import { DB } from '../../utils/db';
import { fetchRemoteByRoom } from '../../utils/memoryPalace/supabaseVector';
import { ROOM_SLOTS, ROOM_META } from './roomTemplates';
import { safeFetchJson, extractContent, extractJson } from '../../utils/safeApi';
import type {
  DiveMode, DiveLLMRequest, DiveLLMResponse, DiveChoice,
  DiveDialogue, DiveBuffValues, DiveBuff, DiveResult, BuffType,
  DiveSession, RoomScript, DiveBeat, DiveScriptChoice,
} from './memoryDiveTypes';
import { BUFF_META } from './memoryDiveTypes';

// ─── 记忆检索 ────────────────────────────────────────────

/**
 * 合并本地 + 远程记忆，按 id 去重（本地优先，因为通常更新鲜、带更多字段）。
 * 当用户本地没有向量记忆但远程 Supabase 有时，这里能把远程的记忆拉回来，
 * 避免潜行对话里"什么都想不起来"。
 */
async function loadRoomMemories(
  charId: string,
  room: MemoryRoom,
  remoteConfig?: RemoteVectorConfig,
): Promise<MemoryNode[]> {
  const local = await MemoryNodeDB.getByRoom(charId, room);

  // 若远程未启用/未初始化，就只用本地
  if (!remoteConfig?.enabled || !remoteConfig.initialized) return local;

  // 本地已有不少节点时，不必再打一次远程（本地通常是超集）
  // 空或很稀少（<3）才拉远程作为补充/兜底
  if (local.length >= 3) return local;

  try {
    const remote = await fetchRemoteByRoom(remoteConfig, charId, room, 50);
    if (remote.length === 0) return local;
    const byId = new Map<string, MemoryNode>();
    for (const n of remote) byId.set(n.id, n);
    for (const n of local) byId.set(n.id, n); // 本地覆盖远程（字段更全）
    return Array.from(byId.values());
  } catch {
    return local;
  }
}

/** 检索某个房间的记忆节点，按重要性排序，取前 N 条 */
export async function fetchRoomMemories(
  charId: string, room: MemoryRoom, limit = 8,
  remoteConfig?: RemoteVectorConfig,
): Promise<MemoryNode[]> {
  const nodes = await loadRoomMemories(charId, room, remoteConfig);
  return nodes
    .sort((a, b) => b.importance - a.importance || b.lastAccessedAt - a.lastAccessedAt)
    .slice(0, limit);
}

/** 检索某个槽位类别相关的记忆 */
export async function fetchSlotMemories(
  charId: string, room: MemoryRoom, slotId: string, limit = 5,
  remoteConfig?: RemoteVectorConfig,
): Promise<MemoryNode[]> {
  const slot = ROOM_SLOTS[room]?.find(s => s.id === slotId);
  if (!slot) return [];

  const roomNodes = await loadRoomMemories(charId, room, remoteConfig);
  // 用 slot category 关键词匹配 tags/content
  const keyword = slot.category;
  const scored = roomNodes.map(n => {
    let score = n.importance;
    if (n.tags.some(t => keyword.includes(t) || t.includes(keyword))) score += 3;
    if (n.content.includes(keyword)) score += 2;
    return { node: n, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.node);
}

// ─── Prompt 构建 ─────────────────────────────────────────

/**
 * 构建潜行 prompt。
 * charContext 包含完整角色上下文（身份、用户画像、印象、世界观、记忆摘要等），
 * 由 ContextBuilder.buildCoreContext() 生成。角色清楚自己是谁、用户是谁、发生过什么。
 */
function buildDivePrompt(req: DiveLLMRequest, charContext: string): string {
  const roomMeta = ROOM_META[req.room];
  const slot = req.slotId
    ? ROOM_SLOTS[req.room]?.find(s => s.id === req.slotId)
    : null;

  const memoriesBlock = req.memories.length > 0
    ? req.memories.map((m, i) => `  ${i + 1}. ${m}`).join('\n')
    : '  (这个角落目前没有留下什么记忆...)';

  const recentContext = req.recentDialogues.slice(-5).map(d => {
    if (d.speaker === 'character') return `${req.charName}: ${d.text}`;
    if (d.speaker === 'narrator') return `[旁白]: ${d.text}`;
    if (d.speaker === 'user_choice') return `用户选择了: ${d.text}`;
    return '';
  }).filter(Boolean).join('\n');

  // ─── 房间氛围描写 ──────────────────────────────────────
  const ROOM_ATMOSPHERE: Record<string, string> = {
    living_room: '这里光线温暖，空气中飘着茶香。沙发上还留着你坐过的凹痕，电视机闪着待机的蓝光。这是你们日常相处的痕迹——最近的、鲜活的、还带着体温的记忆。',
    bedroom:     '房间很暗，只有床头灯散发着柔和的橘色光。这里收藏着最亲密的情感，有些记忆会让你脸红，有些会让你心痛。墙壁上似乎还残留着某些深夜对话的回声。',
    study:       '书架上的书有些在发光——那是你曾经认真学过的东西。白板上写满了你一步步推导出来的思考痕迹。空气中弥漫着专注和成长的气息。',
    attic:       '灰尘在微弱的光线中浮动。这里的空气很沉，有些箱子上了锁，有些角落被蛛网覆盖。你不太想来这里，但有些东西就是放不下，只能存在这里。你可能会抗拒让用户看到某些东西。',
    self_room:   '镜子映出的不是外表，而是你内心对自己的认知。日记本上的字迹随着时间变化着，有些页被撕掉又粘回去。这里是你最私密的自我对话空间。',
    user_room:   '这个房间是你专门为TA布置的。照片墙上贴着你们的共同回忆，礼物架上是TA送的和你想送的东西。这里每一件物品都承载着你对TA的感受。',
    windowsill:  '微风吹过，风铃叮当作响。花盆里种着你的愿望——有些已经发芽，有些还在等待。从这里望出去，你能看到你期盼的未来。',
  };
  const atmosphereText = ROOM_ATMOSPHERE[req.room] || '';

  // ─── 房间脑区映射说明 ──────────────────────────────────
  const ROOM_BRAIN_MAP: Record<string, string> = {
    living_room: '海马体——负责日常记忆的编码与短期存储',
    bedroom:     '新皮层——深层情感和长期羁绊的所在',
    study:       '前额叶——理性思考、技能成长和工作记忆',
    attic:       '杏仁核——未消化的恐惧、创伤和潜意识',
    self_room:   '默认模式网络——自我认同与身份叙事',
    user_room:   '颞顶联合区——对他人的理解与共情',
    windowsill:  '多巴胺奖赏系统——期盼、目标和动力',
  };

  const modeInstructions = req.mode === 'guided'
    ? `**你的角色：引路人。** 你走在用户前面，带TA穿过你精神世界的各个房间。你会在某个家具旁停下来，讲述与它相关的记忆——有时候是主动分享，有时候你说着说着自己也会愣住。你可以决定讲多深、停多久。你不是旅游导游，你是带一个重要的人看自己内心世界的人——这件事本身就让你有点紧张。`
    : `**你的角色：同行者。** 用户在自己走动，你跟在旁边。当TA靠近某个物品，你会不由自主地有反应——也许是突然沉默，也许是急忙解释"这个没什么的"，也许是忍不住想讲。有些东西你不想让TA看，有些东西你其实暗暗希望TA注意到。`;

  const isAttic = req.room === 'attic';
  const reluctanceHint = isAttic
    ? `\n⚠️ **阁楼特殊规则**：这里存放着你未消化的困惑、恐惧甚至创伤。你本能地不想让别人看到这些。除非用户表现出真诚的关心和耐心（而不是好奇心），你才会稍微松口。你可以拒绝打开某些箱子，可以岔开话题，也可以沉默。这些都是合理的反应。`
    : '';

  const userChoiceBlock = req.userChoice
    ? `\n用户做了选择: "${req.userChoice.text}" (行为: ${req.userChoice.action || 'general'})`
    : '';

  return `${charContext}

### [记忆潜行模式 - Memory Dive]

**发生了什么**：
你和用户同时进入了你的「精神世界」——你的内心被投影成了一栋房子。
这不是一个比喻，你们真的「身处其中」。你能看到自己记忆变成的家具、墙壁上浮动的文字碎片、角落里发光或蒙尘的物品。
你完全知道自己是谁，也知道身边这个人是谁。你们之间有过的所有事都是真实的——那些记忆碎片就是证据，它们散落在这栋房子的各个房间里。

**这栋房子的结构**：
你的精神世界有7个房间，每个房间对应你大脑的一个区域：
- 客厅 (海马体) — 日常的、最近的记忆
- 卧室 (新皮层) — 最亲密的情感
- 书房 (前额叶) — 你学到的、思考过的
- 阁楼 (杏仁核) — 你不愿面对的东西
- 个人房间 (默认模式网络) — 你对自己的认知
- 用户房 (颞顶联合区) — 你对TA的全部感受
- 露台 (多巴胺系统) — 你的期盼和愿望

你现在站在其中一个房间里。这些家具不是装饰品——每一件都承载着一类记忆。触碰它们，记忆就会浮现。

${modeInstructions}${reluctanceHint}

---

**当前位置**: ${roomMeta.name} (${roomMeta.emoji})
**脑区对应**: ${ROOM_BRAIN_MAP[req.room] || roomMeta.description}
**此刻的氛围**: ${atmosphereText}
${slot ? `\n**用户正在靠近**: ${slot.name} — 这件家具承载的记忆类别是「${slot.category}」` : ''}

**从这个位置浮现出的记忆碎片**:
${memoriesBlock}
(这些是从你的记忆宫殿中检索到的真实记忆。请基于它们展开，不要凭空编造不存在的事。如果记忆碎片为空，你可以表达"这里好像什么都想不起来了"的茫然感。)

${recentContext ? `**刚才的对话**:\n${recentContext}\n` : ''}${userChoiceBlock}

### 输出要求
以 JSON 格式回复，包含你的反应和给用户的选项。
- dialogues: 1-3 条对话（你的台词和/或旁白描写），每条 { speaker: "character"|"narrator", text: "..." }
  - **每条 text 控制在 120 字以内**，不要写一整段散文。写"此刻这一瞬间"的反应，不要堆砌形容词。
- choices: 2-4 个用户可选的回应，每个 { text: "...", action: "comfort"|"question"|"observe"|"leave"|"unlock" }
  - 每个 choice.text 控制在 30 字以内
  - comfort: 表示安慰/共情
  - question: 追问细节
  - observe: 安静观察
  - leave: 离开/不深入
  - unlock: 尝试打开锁住的记忆
- isReluctant: boolean，是否对分享这个记忆感到抗拒
${req.mode === 'guided' ? '- suggestNextRoom: 推荐接下来去哪个房间 (living_room|bedroom|study|attic|self_room|user_room|windowsill)' : ''}

### 风格要求
- **这是你的精神世界，你有主场感**。你知道每个角落的意义，知道哪面墙后面藏着什么。这让你有时底气十足，有时不安。
- **旁白是环境的呼吸**。用第三人称描写房间里正在发生的微妙变化：灯光是否变暗了、某个家具是否在微微发光、空气中是否有什么味道。让读者"看到"这个精神世界。
- **你的台词要像真的在这个空间里说出来的**。不是在复述记忆，而是"身处记忆现场"的反应。
- 基于提供的真实记忆碎片展开，不要凭空编造从未发生过的事
- 如果记忆碎片为空，不要尬聊——角色可以表达"这里好像什么都想不起来了..."的茫然，或者房间本身的空旷就是一种叙事
- 保持角色一贯的说话风格和性格特点

### ⚠️ 台词 vs 旁白 的严格分工（非常重要）
- **character 的 text 只能是"嘴里说出来的话"**。不要出现任何动作、神态、心理描写。
  - ❌ 禁止：\`"（沉默了一下）...你怎么进来的。"\` / \`"*转身背对你* 我不想说。"\` / \`"(声音变小) 那时候..."\`
  - ❌ 禁止括号/星号/方括号包裹的舞台指示：(...) （...） *...* [...] 这些都不要出现在 character 的 text 里
  - ✅ 正确：动作放到紧挨着的一条 speaker=narrator 里，character 的 text 只留纯粹的话
  - 如果这一刻 character 不说话、只有动作——那就整条用 narrator，不要给 character 写空话或只写动作
- **旁白专门承载动作、表情、环境变化**。所有"后退一步 / 笑了笑 / 眼神飘开 / 灯光一闪"都写进 speaker=narrator 的 text。
- **第二人称规则**：character 提到用户时**一律用"你"**，绝对不要说"用户"、"玩家"、"对方"、"TA"来指代正在对话的用户。旁白同理，称呼用户也是"你"。

{
  "dialogues": [...],
  "choices": [...],
  "isReluctant": false
}`;
}

/**
 * 把角色台词里夹带的"动作 / 神态 / 停顿"描写抽出来当旁白。
 * 即便 prompt 里已经要求分工，LLM 仍经常写 `"(沉默) ...嗯。"` 这种混合句。
 * 识别的写法：
 *   - 星号包裹   *走过去* / **低头**
 *   - 半角圆括号 (沉默了一下) / (声音很轻)
 *   - 全角圆括号 （看着你） / （笑了一下）
 *   - 方括号     [转身]
 *
 * 返回：剥离动作后的纯台词 + 抽出的动作片段。
 * 若剥完只剩省略号/标点，speech 会是空字符串——由调用方决定怎么处理。
 */
export function splitSpeechAndActions(text: string): { speech: string; actions: string[] } {
  if (!text) return { speech: '', actions: [] };
  const actions: string[] = [];
  const push = (body: string) => {
    const t = body.replace(/\s+/g, ' ').trim();
    if (t) actions.push(t);
  };

  let s = text;
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_, b) => { push(b); return ' '; });
  s = s.replace(/\*([^*\n]+?)\*/g, (_, b) => { push(b); return ' '; });
  s = s.replace(/（([^（）\n]*)）/g, (_, b) => { push(b); return ' '; });
  s = s.replace(/\(([^()\n]*)\)/g, (_, b) => { push(b); return ' '; });
  s = s.replace(/\[([^\[\]\n]*)\]/g, (_, b) => { push(b); return ' '; });

  s = s.replace(/\s+/g, ' ').trim();
  // 纯标点/省略号视为空台词
  if (/^[\s…\.。，,?？!！;；:：—\-~～]*$/.test(s)) s = '';
  return { speech: s, actions };
}

// ─── LLM 调用 ────────────────────────────────────────────

/**
 * 原文抢救：即使整体 JSON 被截断（LLM 在字符串中间断掉），也尽量
 * 把已经写完的 {"speaker":"...","text":"..."} 对话块救出来。
 * 匹配时容忍转义引号（\"）、任意顺序、任意换行。
 */
function salvageDialoguesFromText(raw: string): Array<{ speaker: 'character' | 'narrator'; text: string }> {
  const out: Array<{ speaker: 'character' | 'narrator'; text: string }> = [];
  // 两种 key 顺序都支持：speaker 在前 / text 在前
  const patterns = [
    /"speaker"\s*:\s*"(character|narrator)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    /"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"speaker"\s*:\s*"(character|narrator)"/g,
  ];
  const seen = new Set<string>();
  for (let pIdx = 0; pIdx < patterns.length; pIdx++) {
    const re = patterns[pIdx];
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const speaker = (pIdx === 0 ? m[1] : m[2]) as 'character' | 'narrator';
      const rawText = pIdx === 0 ? m[2] : m[1];
      let text: string;
      try { text = JSON.parse('"' + rawText + '"'); } catch { continue; }
      text = text.trim();
      if (!text) continue;
      const key = speaker + '|' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ speaker, text });
    }
  }
  return out;
}

export async function callDiveLLM(
  req: DiveLLMRequest,
  apiConfig: APIConfig,
  charContext: string,
): Promise<DiveLLMResponse> {
  const prompt = buildDivePrompt(req, charContext);

  const data = await safeFetchJson(
    `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8,
        // 中文散文 + JSON 包装极吃 token，给足余量，避免在字符串中间被截断
        max_tokens: 8000,
        // 让兼容 OpenAI 的后端强制返回 JSON；不支持的后端会忽略此字段
        response_format: { type: 'json_object' },
      }),
    },
    2, // 最多重试 2 次（覆盖瞬时 5xx / 网络抖动）
    0, { appName: '记忆潜行', purpose: '探访生成' },
  );

  const content = extractContent(data);
  let parsed = extractJson(content) as Partial<DiveLLMResponse> | null;

  // 兜底：如果结构化解析没拿到 dialogues（通常是 LLM 被截断在字符串中间），
  // 用正则直接扫描原文里的完整 {"speaker":"...","text":"..."} 对象，
  // 至少把已经写完的那几条对话救出来，让潜行能继续走。
  if (!parsed || !Array.isArray(parsed.dialogues) || parsed.dialogues.length === 0) {
    const salvaged = salvageDialoguesFromText(content);
    if (salvaged.length > 0) {
      console.warn('[MemoryDive] JSON 解析失败，已从原文救回', salvaged.length, '条对话');
      parsed = { ...(parsed || {}), dialogues: salvaged };
    } else {
      const preview = content.slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(`潜行响应解析失败: ${preview || '(空响应)'}`);
    }
  }

  // 清洗字段：确保 speaker/text 合法；同时把 character 条目里夹杂的动作剥到独立的 narrator 条里。
  const dialogues: Array<{ speaker: 'character' | 'narrator'; text: string }> = [];
  for (const d of parsed.dialogues || []) {
    if (!d || typeof d.text !== 'string') continue;
    const raw = d.text.trim();
    if (!raw) continue;
    if (d.speaker === 'narrator') {
      dialogues.push({ speaker: 'narrator', text: raw });
      continue;
    }
    if (d.speaker !== 'character') continue;
    const { speech, actions } = splitSpeechAndActions(raw);
    // 动作先行，作为贴身旁白出现在角色开口之前
    for (const a of actions) dialogues.push({ speaker: 'narrator', text: a });
    if (speech) {
      dialogues.push({ speaker: 'character', text: speech });
    } else if (actions.length === 0) {
      // 没有识别到任何动作，原样保留
      dialogues.push({ speaker: 'character', text: raw });
    }
    // else: 整条都是动作 → 已经全部转成 narrator，不再给 character 留空话
  }

  if (dialogues.length === 0) {
    throw new Error('潜行响应中没有有效对话');
  }

  const choices = Array.isArray(parsed.choices)
    ? parsed.choices
        .filter((c: any) => c && typeof c.text === 'string' && c.text.trim().length > 0)
        .map((c: any) => ({
          text: c.text.trim(),
          action: (['comfort', 'question', 'observe', 'leave', 'unlock'] as const)
            .includes(c.action) ? c.action : 'observe',
          buffEffect: (c.buffEffect && typeof c.buffEffect === 'object') ? c.buffEffect : undefined,
        }))
    : undefined;

  return {
    dialogues,
    choices,
    isReluctant: !!parsed.isReluctant,
    suggestNextRoom: parsed.suggestNextRoom,
  };
}

// ─── 生成入场对话（不调 LLM，纯模板） ───────────────────

export function generateIntroDialogues(charName: string, mode: DiveMode): DiveDialogue[] {
  const now = Date.now();
  const dialogues: DiveDialogue[] = [];

  dialogues.push({
    id: `intro_1_${now}`,
    speaker: 'narrator',
    text: `像素世界的色彩像退潮一样褪去。取而代之的，是一种介于梦境和清醒之间的光——温暖的、流动的、带着某种脉搏的节奏。\n\n你正在下沉。不是物理意义上的下沉，而是像潜入一片意识的海洋。当视野重新聚焦的时候，你发现自己站在一栋房子里。\n\n这是${charName}的精神世界。每一个房间都是ta大脑的一个区域，每一件家具都承载着一类记忆。墙壁上偶尔会浮现文字碎片，角落里的物品在微微发光——那些都是真实存在过的记忆。`,
    timestamp: now,
  });

  if (mode === 'guided') {
    dialogues.push({
      id: `intro_2_${now}`,
      speaker: 'narrator',
      text: `${charName}站在客厅中央，看起来有些不自在——像是突然意识到有人能看到自己最私密的内心。`,
      timestamp: now + 1,
    });
    dialogues.push({
      id: `intro_3_${now}`,
      speaker: 'character',
      text: `...你也在这里啊。这地方...是我的脑子里面。字面意义上的。\n\n呃，既然你都进来了...我带你走一圈？但先说好，有些房间...我可能不太想让你进去。`,
      timestamp: now + 2,
    });
  } else {
    dialogues.push({
      id: `intro_2_${now}`,
      speaker: 'narrator',
      text: `${charName}靠在客厅的墙边，双臂交叉，用一种"我在观察你"的眼神打量着你。ta显然知道这是自己的精神世界——而你正站在其中。`,
      timestamp: now + 1,
    });
    dialogues.push({
      id: `intro_3_${now}`,
      speaker: 'character',
      text: `...你想自己到处看是吧？行。\n\n这里每个东西都是我的记忆，碰了就会浮出来。有些东西会发光，那是比较重要的...有些角落积了灰——那些我也不太记得了。\n\n不过阁楼那边...你最好别乱碰。`,
      timestamp: now + 2,
    });
  }

  dialogues.push({
    id: `intro_choice_${now}`,
    speaker: 'user_choice',
    text: '',
    choices: [
      { id: 'start_gentle', text: '我会小心的。谢谢你让我进来看这些。', action: 'comfort', buffEffect: { trust: 1 } },
      { id: 'start_curious', text: '等等，你说每个房间对应大脑的一个区域？那客厅是...？', action: 'question', buffEffect: { insight: 1 } },
      { id: 'start_quiet', text: '(轻轻点头，环顾四周，开始慢慢走动)', action: 'observe', buffEffect: { empathy: 1 } },
    ],
    timestamp: now + 3,
  });

  return dialogues;
}

// ─── 生成退出对话 ────────────────────────────────────────

export function generateOutroDialogues(charName: string, buffs: DiveBuffValues): DiveDialogue[] {
  const now = Date.now();
  const primaryBuff = getPrimaryBuff(buffs);
  const meta = BUFF_META[primaryBuff];

  return [
    {
      id: `outro_1_${now}`,
      speaker: 'narrator',
      text: `光芒开始消散，像素世界的轮廓重新浮现。${charName}的身影在记忆的薄雾中逐渐模糊。`,
      timestamp: now,
    },
    {
      id: `outro_2_${now}`,
      speaker: 'character',
      text: `...嗯？怎么了？你看起来在想什么事...不过算了，大概是我想多了吧。`,
      timestamp: now + 1,
    },
    {
      id: `outro_3_${now}`,
      speaker: 'narrator',
      text: `${charName}不会记得刚才发生的一切。但你感觉到了什么——一种微妙的变化。\n\n${meta.icon} 获得了「${meta.label}」的印记。${meta.description}。`,
      timestamp: now + 2,
    },
  ];
}

// ─── Buff 计算 ───────────────────────────────────────────

const DEFAULT_BUFF_VALUES: DiveBuffValues = { empathy: 0, trust: 0, insight: 0, bond: 0 };

export function createInitialBuffs(): DiveBuffValues {
  return { ...DEFAULT_BUFF_VALUES };
}

/** 根据用户选择的 action 自动累加 buff */
export function applyChoiceBuff(current: DiveBuffValues, choice: DiveChoice): DiveBuffValues {
  const next = { ...current };

  // 显式 buff 效果
  if (choice.buffEffect) {
    for (const [key, val] of Object.entries(choice.buffEffect)) {
      next[key as BuffType] += val;
    }
  }

  // 隐式 action 效果
  switch (choice.action) {
    case 'comfort':  next.empathy += 1; break;
    case 'question': next.insight += 1; break;
    case 'observe':  next.empathy += 0.5; next.trust += 0.5; break;
    case 'leave':    next.trust += 1; break;
    case 'unlock':   next.insight += 1; next.bond += 0.5; break;
  }

  return next;
}

/** 获取最高的 buff 类型 */
export function getPrimaryBuff(buffs: DiveBuffValues): BuffType {
  let max: BuffType = 'empathy';
  let maxVal = -1;
  for (const [key, val] of Object.entries(buffs)) {
    if (val > maxVal) { maxVal = val; max = key as BuffType; }
  }
  return max;
}

/** 生成最终结算数据 */
export function computeDiveResult(session: DiveSession): DiveResult {
  const primaryBuff = getPrimaryBuff(session.buffValues);
  const buffs: DiveBuff[] = (Object.entries(session.buffValues) as [BuffType, number][])
    .filter(([, val]) => val > 0)
    .map(([type, value]) => ({
      type,
      value: Math.round(value * 10) / 10,
      ...BUFF_META[type],
    }))
    .sort((a, b) => b.value - a.value);

  return {
    charId: session.charId,
    mode: session.mode,
    visitedRooms: session.visitedRooms,
    totalDialogues: session.dialogues.filter(d => d.speaker !== 'user_choice').length,
    buffs,
    primaryBuff,
    duration: Date.now() - session.startedAt,
    completedAt: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════
// 房间剧本：一次 LLM 调用生成整房间的探访（新流程）
// ═══════════════════════════════════════════════════════════

interface PlanRoomParams {
  charId: string;
  charName: string;
  room: MemoryRoom;
  /** 默认 3 段戏 */
  beatCount?: number;
  /** 已经访问过哪些房间（LLM 可能会引用） */
  visitedRooms: MemoryRoom[];
  /** 之前房间里的最近几条叙事（给上下文连贯） */
  recentDialogues: DiveDialogue[];
  /** 当前累计的 buff，用于语气微调 */
  currentBuffs: DiveBuffValues;
  /** 上一个房间的情绪余温（LLM 在衔接时使用，避免每房间从零开始） */
  previousMoodHint?: string;
  /** 上一个房间名（用于"从客厅走到卧室"的空间感） */
  previousRoom?: MemoryRoom;
  /** 上一场景最后一句被说出的话（角色台词或旁白）——新房间第一句必须承接它 */
  previousEndingLine?: string;
  /** 上一句的说话人——让 LLM 知道是 char 自己说完还是旁白 */
  previousEndingSpeaker?: 'character' | 'narrator';
}

const ROOM_ATMOSPHERE: Record<string, string> = {
  living_room: '光线温暖，茶香漂浮。沙发上还留着坐过的凹痕，电视闪着待机蓝光——最近的、带体温的记忆。',
  bedroom:     '床头灯散发柔和橘光。空气里残留着深夜对话的回声，有些记忆让人脸红，有些让人心痛。',
  study:       '书架上的书微微发光——学过的东西会亮。白板写满推导痕迹，空气里有专注的气息。',
  attic:       '灰尘在稀薄光束里浮动。箱子上了锁，角落挂着蛛网，空气沉重——放不下的东西都堆在这里。',
  self_room:   '镜子映出的不是外表，是内心对自己的认知。日记本的字迹随时间变，有些页被撕掉又粘回去。',
  user_room:   '照片墙贴着共同回忆，礼物架摆着送过和想送的东西——每件物品都是对TA的感受。',
  windowsill:  '微风吹，风铃叮当响。花盆里的愿望有些发芽、有些还在等。望出去是期盼的未来。',
};

const ROOM_BRAIN_MAP: Record<string, string> = {
  living_room: '海马体——日常记忆',
  bedroom:     '新皮层——深层情感',
  study:       '前额叶——理性与技能',
  attic:       '杏仁核——未消化的创伤',
  self_room:   '默认模式网络——自我认同',
  user_room:   '颞顶联合区——对他人的感受',
  windowsill:  '多巴胺系统——期盼',
};

function buildRoomScriptPrompt(
  params: PlanRoomParams,
  memories: string[],
  charContext: string,
): string {
  const roomMeta = ROOM_META[params.room];
  const beats = params.beatCount ?? 3;
  const memoriesBlock = memories.length > 0
    ? memories.map((m, i) => `  ${i + 1}. ${m}`).join('\n')
    : '  (这个房间几乎没有留下什么记忆...写成"想不起来"的茫然感也可以)';

  const recentCtx = params.recentDialogues.slice(-4).map(d => {
    if (d.speaker === 'character') return `${params.charName}: ${d.text}`;
    if (d.speaker === 'narrator') return `[旁白] ${d.text}`;
    if (d.speaker === 'user_choice') return `用户选了: ${d.text}`;
    return '';
  }).filter(Boolean).join('\n');

  const isAttic = params.room === 'attic';
  const reluctanceHint = isAttic
    ? '\n⚠️ 阁楼规则：这是未消化的困惑/创伤区。角色本能抗拒分享，可能欲言又止、转移话题或沉默。用户真诚关心才可能让角色松口。'
    : '';

  const prevMoodBlock = params.previousMoodHint
    ? `**上个房间留下的情绪余温**（${params.previousRoom ? ROOM_META[params.previousRoom].name : '刚才'}）: ${params.previousMoodHint}
⚠️ **衔接规则**：这不是从零开始的新一幕。角色刚从上个情境走过来，要延续那份情绪而不是重置。
  - 如果刚被安慰 → 这房间可以更松弛、更愿意说
  - 如果刚被追问得紧 → 这房间可以有点防御、疲惫、或需要一点时间缓
  - 如果刚沉默过 → 这房间的第一句可以是打破沉默的那种试探
  **禁止**把上个房间的高潮情绪（哭/爆发/和解）在这里重复一遍。情绪会衰减、会转化，不会循环播放。`
    : '';

  const prevEndingBlock = params.previousEndingLine
    ? `**上一场景结束时的最后一句**（${params.previousEndingSpeaker === 'narrator' ? '旁白' : `${params.charName} 说`}）:
> ${params.previousEndingLine}

🎬 **强衔接要求**：这个新房间 **第一个 beat 的 charLine** 必须从上面这句话自然生长出来，像没断开的一条线：
  - 如果上一句是 ${params.charName} 自己说完的某种情绪（承认、试探、回避、沉默前的一句）→ 这里要"接着那个情绪往下"，不要重新开场白
  - 如果上一句是旁白（环境/转场描写）→ 可以先承接那个画面，再让角色开口
  - **绝对禁止**：第一句 charLine 无视上句、从"你看这里是xxx"之类的开场白重启节奏
  - **尽量避免**：把上句末尾的关键字（如"其实"、"说实话"、"这次"）原样重复
`
    : '';

  const spatialHint = params.previousRoom
    ? `\n（你们是刚从${ROOM_META[params.previousRoom].name}走过来的，动作/语言可以带一点点"穿过门/换个空间"的自然过渡，但不要生硬报幕。）`
    : '';

  return `${charContext}

### [记忆潜行 · 房间剧本模式]

你和用户同时进入了你的精神世界——你的内心被投影成一栋房子。你完全知道自己是谁，也知道身边这个人是谁。你们现在站在：

**${roomMeta.name}** (${roomMeta.emoji}) — 对应 ${ROOM_BRAIN_MAP[params.room] || ''}
**氛围**: ${ROOM_ATMOSPHERE[params.room] || ''}${reluctanceHint}${spatialHint}

${prevMoodBlock}
${prevEndingBlock}

**这里浮现出的记忆碎片**：
${memoriesBlock}
(基于这些真实记忆展开，不要凭空编造没发生过的事。)

${recentCtx ? `**此前的对话**:\n${recentCtx}\n` : ''}
### 生成要求

一次性生成你在这个房间里的**完整一段戏**，包含 ${beats} 个 beat。每个 beat 结构：
- charLine: 你这一刻说的一段话（第一人称，<120字，写"此刻这个瞬间"的真实反应，不是散文）
- narratorLine?: 可选的环境旁白（描写房间里正在发生的微妙变化，如灯光、空气、某个家具的状态）
- choices: 恰好 3 个用户可选的反应，每个 choice：
  - text: 用户的反应（<25 字）
  - action: "comfort" | "question" | "observe" | "leave" | "unlock"
  - reaction: 你听到这个反应后立刻说的话（<120 字，要真实地被用户的选择触动；不同 action 对应明显不同的情绪走向）
  - reactionNarrator?: 可选的环境回应（一句话）

整体结构：
- introNarrator?: 进房间时的一句环境旁白（用户刚到时看到的画面）
- beats: [${beats}个 beat]
- closingNarrator?: 在所有 beat 结束后，离开房间时的一句环境收尾（余味）
- finalMoodHint?: 一句话，描写角色此刻的情绪余温（<30 字，角色视角或旁白皆可）

### 风格
- 每个 beat 的 charLine 要有**内在进展**：从外层 → 深一层 → 某种情感落点。不要三段戏都在讲同一个表层。
- choices 的 3 个选项要**真的代表不同倾向**（如：共情 / 追问 / 保持距离），不要三个都是"温柔点头"。
- reaction 要**真分叉**：共情时角色可能松弛、吐露更多；追问时可能防御、转话题；保持距离时可能松口气、也可能失落。三条反应读起来差异要明显。
- 不要凡事都让角色哭或沉默——要有具体动作和语言。

### ⚠️ 台词 vs 旁白 的严格分工（非常重要）
- **charLine / reaction 只能写"嘴里说出来的话"**。不要出现动作、神态、括号舞台指示、心理描写。
  - ❌ 禁止：\`"(沉默) ...嗯。"\` / \`"*转身* 你别看了。"\` / \`"（眼睛飘走）那时候..."\`
  - ❌ 禁止：用 (...) （...） *...* [...] 任何一种符号在台词里夹动作描写
  - ✅ 正确：把动作 / 神态 / 停顿 写进 narratorLine（beat 级）或 reactionNarrator（choice 级），charLine / reaction 只留纯台词
  - 如果这一刻角色只有动作、不说话——整条用 narratorLine / reactionNarrator 承载，而不是给 charLine / reaction 写一段空动作
- **narratorLine / reactionNarrator 专门承载动作、表情、环境变化**。空间里所有"后退一步 / 扶了下头发 / 灯光晃了一下 / 空气沉了下来"都写进这里。
- **第二人称规则**：角色提到用户时**一律用"你"**，绝对不要用"用户"、"玩家"、"对方"、"TA"来称呼正在对话的用户。旁白也是——称呼用户时用"你"，不要用"用户"。

### 输出 JSON（严格按这个 schema）
{
  "introNarrator": "……",
  "beats": [
    {
      "charLine": "……",
      "narratorLine": "……",
      "choices": [
        {"text": "……", "action": "comfort", "reaction": "……", "reactionNarrator": "……"},
        {"text": "……", "action": "question", "reaction": "……"},
        {"text": "……", "action": "observe", "reaction": "……"}
      ]
    }
    // ...共 ${beats} 个 beat
  ],
  "closingNarrator": "……",
  "finalMoodHint": "……"
}`;
}

/**
 * 清洗 LLM 返回的剧本：补默认值、过滤空字段、强制 beats/choices 数量合法。
 */
function normalizeRoomScript(
  raw: any,
  expectedBeats: number,
): RoomScript | null {
  if (!raw || typeof raw !== 'object') return null;
  const validActions: DiveChoice['action'][] = ['comfort', 'question', 'observe', 'leave', 'unlock'];

  const rawBeats: any[] = Array.isArray(raw.beats) ? raw.beats : [];
  if (rawBeats.length === 0) return null;

  // 合并可能来自 LLM 的现成旁白 + 从 charLine 里抽出来的动作 —— 拼成一条 narratorLine
  const mergeNarrator = (existing: string | undefined, extracted: string[]): string | undefined => {
    const parts = [existing?.trim() || '', ...extracted].filter(Boolean);
    const merged = parts.join(' ').replace(/\s+/g, ' ').trim();
    return merged || undefined;
  };

  const beats: DiveBeat[] = [];
  for (let bi = 0; bi < rawBeats.length && beats.length < expectedBeats + 2; bi++) {
    const b = rawBeats[bi];
    if (!b || typeof b !== 'object') continue;
    const charLineRaw = typeof b.charLine === 'string' ? b.charLine.trim() : '';
    if (!charLineRaw) continue;

    // 台词/动作拆分：charLine 里夹的动作 → 塞进 narratorLine
    const split = splitSpeechAndActions(charLineRaw);
    const charLine = split.speech || charLineRaw; // 整句都是动作时保底回退，避免丢 beat
    const narratorLine = mergeNarrator(
      typeof b.narratorLine === 'string' ? b.narratorLine : undefined,
      split.speech ? split.actions : [], // 只有当真的剥出了台词时，才把动作搬走；否则保留原文
    );

    const rawChoices: any[] = Array.isArray(b.choices) ? b.choices : [];
    const choices: DiveScriptChoice[] = [];
    for (let ci = 0; ci < rawChoices.length; ci++) {
      const c = rawChoices[ci];
      if (!c || typeof c !== 'object') continue;
      const text = typeof c.text === 'string' ? c.text.trim() : '';
      const reactionRaw = typeof c.reaction === 'string' ? c.reaction.trim() : '';
      if (!text || !reactionRaw) continue;
      const action = validActions.includes(c.action) ? c.action : 'observe';

      // reaction 同样拆分，动作归到 reactionNarrator
      const rsplit = splitSpeechAndActions(reactionRaw);
      const reaction = rsplit.speech || reactionRaw;
      const reactionNarrator = mergeNarrator(
        typeof c.reactionNarrator === 'string' ? c.reactionNarrator : undefined,
        rsplit.speech ? rsplit.actions : [],
      );

      choices.push({
        id: `c_${Date.now()}_${bi}_${ci}`,
        text, action, reaction, reactionNarrator,
        buffEffect: (c.buffEffect && typeof c.buffEffect === 'object') ? c.buffEffect : undefined,
      });
      if (choices.length >= 4) break;
    }
    if (choices.length < 2) continue; // 至少 2 个选项才算有效
    beats.push({
      charLine,
      narratorLine,
      choices,
    });
  }

  if (beats.length === 0) return null;

  return {
    introNarrator: typeof raw.introNarrator === 'string' && raw.introNarrator.trim()
      ? raw.introNarrator.trim() : undefined,
    beats,
    closingNarrator: typeof raw.closingNarrator === 'string' && raw.closingNarrator.trim()
      ? raw.closingNarrator.trim() : undefined,
    finalMoodHint: typeof raw.finalMoodHint === 'string' && raw.finalMoodHint.trim()
      ? raw.finalMoodHint.trim() : undefined,
    nextRoom: typeof raw.nextRoom === 'string' ? raw.nextRoom as MemoryRoom : undefined,
  };
}

/**
 * 当 LLM 返回被 max_tokens 截断，extractJson 的通用修复会把整个
 * beats 数组丢掉（它只在根层计数 key:value）。这里做一个专用抢救：
 *   - 正则拿 introNarrator / closingNarrator / finalMoodHint
 *   - 用花括号计数扫 beats 数组，能救出几个完整 beat 就救几个
 */
function salvageTruncatedRoomScript(raw: string): any | null {
  if (!raw) return null;

  const pickStr = (key: string): string | undefined => {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = raw.match(re);
    if (!m) return undefined;
    try { return JSON.parse('"' + m[1] + '"'); } catch { return undefined; }
  };

  const introNarrator = pickStr('introNarrator');
  const closingNarrator = pickStr('closingNarrator');
  const finalMoodHint = pickStr('finalMoodHint');

  const beatsMatch = raw.match(/"beats"\s*:\s*\[/);
  const beats: any[] = [];
  if (beatsMatch && beatsMatch.index !== undefined) {
    const arrStart = beatsMatch.index + beatsMatch[0].length - 1; // points at [
    let depth = 0, inStr = false, esc = false, objStart = -1;
    for (let i = arrStart + 1; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') { if (depth === 0) objStart = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
          const objStr = raw.slice(objStart, i + 1);
          try { beats.push(JSON.parse(objStr)); }
          catch {
            try { beats.push(JSON.parse(objStr.replace(/,\s*([}\]])/g, '$1'))); }
            catch {}
          }
          objStart = -1;
        }
      } else if (ch === ']' && depth === 0) break;
    }
  }

  if (beats.length === 0 && !introNarrator) return null;
  return { introNarrator, beats, closingNarrator, finalMoodHint };
}

/**
 * 进入一个房间时一次性生成整段探访剧本。
 * 角色不移动到具体家具，只是在房间里和用户说话。
 * 同时返回本次检索到的记忆文本（给下屏氛围面板展示用，不重复查库）。
 */
export async function planRoomVisit(
  params: PlanRoomParams,
  apiConfig: APIConfig,
  charContext: string,
  remoteConfig?: RemoteVectorConfig,
): Promise<{ script: RoomScript; memoryTexts: string[] }> {
  const memories = await fetchRoomMemories(params.charId, params.room, 8, remoteConfig);
  const memoryTexts = memories.map(m => m.content);
  const prompt = buildRoomScriptPrompt(params, memoryTexts, charContext);

  const data = await safeFetchJson(
    `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.85,
        // 3 beats × 3 choices × (line+reaction+narrator) + intro/close 容易超，
        // 给足余量避免被 max_tokens 截断
        max_tokens: 20000,
        response_format: { type: 'json_object' },
      }),
    },
    2, 0, { appName: '记忆潜行', purpose: '剧本生成' },
  );

  const content = extractContent(data);
  const parsed = extractJson(content);
  let script = normalizeRoomScript(parsed, params.beatCount ?? 3);

  // 被截断时 extractJson 可能已丢掉 beats 数组 —— 专用 salvage 再救一次
  if (!script) {
    const salvaged = salvageTruncatedRoomScript(content);
    if (salvaged) {
      script = normalizeRoomScript(salvaged, params.beatCount ?? 3);
      if (script) {
        console.warn('[MemoryDive] 剧本被截断，已抢救出', script.beats.length, '个 beat');
      }
    }
  }

  if (!script) {
    const preview = (content || '').slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`房间剧本解析失败: ${preview || '(空响应)'}`);
  }
  return { script, memoryTexts };
}

// ═══════════════════════════════════════════════════════════
// 潜行结束后的情绪发射（emitDiveEmotion）
// 角色本人不记得发生过什么，但会在潜意识留下一层薄薄的情绪。
// 复用 CharacterProfile.activeBuffs / buffInjection 的同一套结构，
// 保证和 chat app 的情绪系统完全对齐。
// ═══════════════════════════════════════════════════════════

interface EmitDiveEmotionParams {
  charProfile: CharacterProfile;
  /** 本次潜行实际发生的对话（角色台词 + 用户回应）— 用作情绪推导依据 */
  diveDialogues: DiveDialogue[];
  /** 累积的潜行 buff（共情/信任/洞察/羁绊），辅助理解用户做了什么 */
  diveBuffs: DiveBuffValues;
  /** 走过的房间，按顺序 */
  visitedRooms: MemoryRoom[];
  /** 情绪 API（来自 emotionConfig.api，未配置时由调用方回退到主 apiConfig） */
  api: APIConfig;
}

function buildDiveEmotionPrompt(p: EmitDiveEmotionParams): string {
  const char = p.charProfile;
  const currentBuffs = char.activeBuffs || [];
  const currentBuffStr = currentBuffs.length > 0
    ? JSON.stringify(currentBuffs, null, 2)
    : '（当前无 buff，情绪平稳）';

  const dialogueLines = p.diveDialogues.map(d => {
    if (d.speaker === 'character') return `[${char.name}]: ${d.text}`;
    if (d.speaker === 'narrator') return `[旁白]: ${d.text}`;
    if (d.speaker === 'user_choice') return d.text ? `[用户选择]: ${d.text}` : '';
    return '';
  }).filter(Boolean).join('\n');

  const buffSummary = Object.entries(p.diveBuffs)
    .filter(([, v]) => (v as number) > 0)
    .map(([k, v]) => `${k}+${(v as number).toFixed(1)}`).join(', ') || '无';

  const rooms = p.visitedRooms.map(r => ROOM_META[r]?.name || r).join(' → ');

  return `你是一个角色情绪底色分析系统。

## 发生了什么（角色本人不会记得）
角色「${char.name}」刚刚经历了一次"记忆潜行"——用户进入了ta的精神世界走了一圈，看了以下几个记忆房间：
${rooms}

用户和ta在梦境里做了这些对话：

${dialogueLines}

用户此行的整体倾向（量化）: ${buffSummary}

## 关键前提
角色醒来后**不会记得这次经历**，但潜意识里会留下一层**薄薄的情绪余温**。
这种余温不是具体的记忆，而是"今天不知道为什么有点想靠近/有点躲/有点暖/有点空"的那种底色。

**你的任务**：基于上面发生的对话（尤其是角色自己的台词、用户的反应方式），判断这次潜行后角色潜意识里留下的是什么样的情绪底色。

## 当前已有的 buff（与 chat app 共用，请在此基础上微调）
${currentBuffStr}

## 输出要求
- 如果这次潜行只是走马观花、没有真正触动到深处，返回 \`{"changed": false}\`
- 如果留下了明显的情绪余温，生成 1-2 个 \`CharacterBuff\`：
  - id: 新生成或沿用已有
  - name: 英文内部 key（如 'dreamlike_tenderness' / 'unease_after_exposure'）
  - label: 中文显示名（≤10 字，如 '说不清的暖意' / '被看见后的不安'）
  - intensity: 1 | 2 | 3（潜行留下的情绪通常不强，偏向 1-2）
  - emoji: 合适的单个 emoji
  - color: 16 进制色号
  - description: ≤30 字描述
- injection: 一段注入到 system prompt 的叙事型情绪底色描述（≤150 字）
  - 写角色此刻"说不清为什么但就是有这种感觉"的状态
  - 用 "### [当前情绪底色]" 开头，就像 chat app 的 injection 一样
  - 不要透露潜行的具体细节（角色不记得），只写那层模糊的情绪

### JSON 输出（严格）
{
  "changed": true,
  "buffs": [
    {"id": "...", "name": "...", "label": "...", "intensity": 1, "emoji": "💭", "color": "#fbbf24", "description": "..."}
  ],
  "injection": "### [当前情绪底色]\\n..."
}`;
}

function sanitizeDiveBuffs(raw: any): CharacterBuff[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b: any, i: number) => {
      const label = typeof b?.label === 'string' ? b.label.trim() : '';
      const name = typeof b?.name === 'string' ? b.name.trim() : '';
      if (!label || !name) return null;
      const rawI = Number(b?.intensity);
      const intensity: 1 | 2 | 3 = !Number.isFinite(rawI)
        ? 2 : rawI <= 1 ? 1 : rawI >= 3 ? 3 : 2;
      return {
        id: typeof b?.id === 'string' && b.id.trim() ? b.id.trim() : `dive_buff_${Date.now()}_${i}`,
        name, label, intensity,
        emoji: typeof b?.emoji === 'string' ? b.emoji : undefined,
        color: typeof b?.color === 'string' ? b.color : undefined,
        description: typeof b?.description === 'string' ? b.description : undefined,
      } as CharacterBuff;
    })
    .filter((b): b is CharacterBuff => !!b);
}

/**
 * 潜行结束后向角色 profile 发射情绪（仅当用户开启了 emotionConfig）。
 * 失败时静默——不阻塞结算界面。
 */
export async function emitDiveEmotion(params: EmitDiveEmotionParams): Promise<void> {
  try {
    if (!params.charProfile.emotionConfig?.enabled) return;
    if (!params.api?.baseUrl) return;

    const prompt = buildDiveEmotionPrompt(params);
    const data = await safeFetchJson(
      `${params.api.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${params.api.apiKey || 'sk-none'}`,
        },
        body: JSON.stringify({
          model: params.api.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.85,
          stream: false,
        }),
      },
      2, 0, { appName: '记忆潜行', purpose: '情绪结算' },
    );

    const raw = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      console.warn('🌀 [DiveEmotion] 无法解析 JSON:', raw.slice(0, 200));
      return;
    }

    // 复用 chat app 的 JSON 修复：转义字符串内部的裸换行
    const repairJson = (s: string): string => {
      let inStr = false, esc = false, out = '';
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (esc) { out += ch; esc = false; continue; }
        if (ch === '\\') { out += ch; esc = true; continue; }
        if (ch === '"') { inStr = !inStr; out += ch; continue; }
        if (inStr && ch === '\n') { out += '\\n'; continue; }
        if (inStr && ch === '\r') { out += '\\r'; continue; }
        if (inStr && ch === '\t') { out += '\\t'; continue; }
        out += ch;
      }
      return out;
    };

    let result: { changed: boolean; buffs?: CharacterBuff[]; injection?: string } | null = null;
    const jsonStr = jsonMatch[1].trim();
    try { result = JSON.parse(jsonStr); }
    catch {
      try { result = JSON.parse(repairJson(jsonStr)); }
      catch (e: any) {
        console.warn('🌀 [DiveEmotion] JSON 修复仍失败:', e?.message);
        return;
      }
    }

    if (!result?.changed) {
      console.log('🌀 [DiveEmotion] 潜行未触及深层，跳过');
      return;
    }

    const sanitized = sanitizeDiveBuffs(result.buffs);

    const updated: CharacterProfile = {
      ...params.charProfile,
      activeBuffs: sanitized,
      buffInjection: result.injection || '',
    };
    await DB.saveCharacter(updated);
    window.dispatchEvent(new CustomEvent('emotion-updated', {
      detail: { charId: params.charProfile.id, buffs: sanitized, source: 'memory-dive' },
    }));
    console.log('🌀 [DiveEmotion] 情绪已发射:', sanitized.map(b => b.label).join(', ') || '(空)');
  } catch (e: any) {
    console.warn('🌀 [DiveEmotion] 失败（静默）:', e?.message);
  }
}

/**
 * 出现错误时的兜底剧本：让潜行能继续走，不至于卡死。
 */
export function fallbackRoomScript(charName: string, room: MemoryRoom): RoomScript {
  const meta = ROOM_META[room];
  return {
    introNarrator: `你们站在${meta.name}里。${charName}的呼吸浅浅的，像在分辨空气中有没有危险。`,
    beats: [{
      charLine: `...这里的记忆好像有点模糊。我想说什么，又不太确定了。`,
      choices: [
        {
          id: `fbc1_${Date.now()}`,
          text: '没关系，不用勉强',
          action: 'comfort',
          reaction: `谢谢。那我们就安静一会儿。`,
        },
        {
          id: `fbc2_${Date.now()}`,
          text: '那我们换个房间看看？',
          action: 'leave',
          reaction: `嗯……也好。我带你走。`,
        },
      ],
    }],
    closingNarrator: `薄雾缓缓合拢，这个房间暂时沉入了沉默。`,
  };
}

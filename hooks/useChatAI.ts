
import { useState, useRef, useEffect, MutableRefObject } from 'react';
import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig, CharacterBuff } from '../types';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { safeFetchJson, safeResponseJson } from '../utils/safeApi';
import { KeepAlive } from '../utils/keepAlive';
import { ProactiveChat } from '../utils/proactiveChat';
import { ContextBuilder } from '../utils/context';
// 思考链 / HTML / MCD / memoryPalace 注入已下沉到 chatRequestPayload；这里不再直接调用
import { useMusic, loadMusicHooks } from '../context/MusicContext';
import { processNewMessages, mergePalaceFragmentsIntoMemories, getMemoryPalaceHighWaterMark } from '../utils/memoryPalace/pipeline';
import { incrementDigestRound, runCognitiveDigestion, detectPersonalityStyle } from '../utils/memoryPalace';
// evolveFlowNarrative 保留为低频深刷新备用，日常意识流由副 API 的情绪评估同轮产出（innerState 字段）
// import { evolveFlowNarrative } from '../utils/scheduleGenerator';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import type { DigestResult } from '../utils/memoryPalace';
// 麦当劳: useChatAI 现在只读 McdMiniApp 当前快照注入 system prompt + 给 LLM 一个
// UI 钩子工具 propose_cart_items。MCP 实际调用都在 McdMiniApp 组件内做, useChatAI
// 不再 import callMcdTool / normalizeMcdToolName / isMcdConfigured / 旧 prompt。
import { MCD_PROPOSE_TOOL, autoFixProposalCodesByName } from '../utils/mcdToolBridge';
import { buildChatRequestPayload } from '../utils/chatRequestPayload';
import {
    isInstantConfigReady,
    sendInstantPushAndAwaitReply,
    formatDiagnostics,
    type InstantPushPayload,
} from '../utils/instantPushClient';
import { applyAssistantPostProcessing, type XhsCaches } from '../utils/applyAssistantPostProcessing';
import { ActiveMsgStore } from '../utils/activeMsgStore';
import { applyEmotionEvalRaw } from '../utils/emotionApply';
import { isEmotionEvalSkipped } from '../utils/devDebug';

// ─── 情绪评估（副API，fire & forget）───

function buildEmotionEvalPrompt(
    char: CharacterProfile,
    userProfile: UserProfile,
    mainSystemPrompt: string,
    apiMessages: Array<{ role: string; content: any }>,
    includeContext: boolean = true
): string {
    // 直接复用主 API 的完整 system prompt 和消息历史，确保 100% 信息对齐
    // （包含：角色设定、印象档案、世界书、记忆宫殿、实时信息、日程内心旁白、群聊、日记标题等）
    const currentBuffs = char.activeBuffs || [];

    // 将主 API 的消息数组展平成文本（保留时间戳、引用、特殊消息类型等格式）
    // 不截断：与主 API 完全对齐（contextLimit 条），让情绪 eval 能看到完整的情绪演变轨迹
    const recentLines = apiMessages.map(m => {
        const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? char.name : '系统');
        let text = '';
        if (typeof m.content === 'string') {
            text = m.content;
        } else if (Array.isArray(m.content)) {
            text = m.content.map((part: any) => {
                if (part?.type === 'text') return part.text || '';
                if (part?.type === 'image_url') return '[图片]';
                return '';
            }).filter(Boolean).join(' ');
        }
        return `[${role}]: ${text}`;
    }).join('\n');

    const buffStr = currentBuffs.length > 0
        ? JSON.stringify(currentBuffs, null, 2)
        : '（当前无buff，情绪平稳）';

    // instant 模式 (includeContext=false): 章节结构与本地**完全一致**, 只把两段大文本 (system prompt、
    // 对话历史) 留成占位符 token, 由 worker 用本次请求已有的 messages 填回**原位** —— 输出与本地逐字
    // 对齐 (顺序/章节/格式都一样), 又不必把上下文重复塞进请求体 (省一份, keepalive 不被降级).
    // worker 端 (worker/instant-push runEmotionEval) 负责把 messages[0]=system、messages[1..]=对话历史
    // 还原成与本地 mainSystemPrompt / recentLines 相同的文本替换进去.
    const contextSection = includeContext
        ? `

## 角色此刻看到的完整上下文（与主 API 发送的 system prompt 完全一致）
${mainSystemPrompt}

## 完整对话历史（与主 API 看到的消息历史完全一致）
${recentLines}`
        : `

## 角色此刻看到的完整上下文（与主 API 发送的 system prompt 完全一致）
__EMOTION_EVAL_SYSTEM_PROMPT__

## 完整对话历史（与主 API 看到的消息历史完全一致）
__EMOTION_EVAL_HISTORY__`;

    return `你是一个角色情绪分析系统。请分析角色「${char.name}」当前的情绪底色状态。${contextSection}

## 当前Buff状态（结构化数据，便于你维护演化）
${buffStr}

## 任务
基于以上对话，完成三件事：
1. 评估角色当前的情绪底色（buffs）。
2. 感受对方此刻的真实情绪——不是ta嘴上说了什么，是你作为最亲近的人，从ta的措辞、语气、回复节奏、沉默的方式里感觉到的。
3. 以「${char.name}」的第一人称写一段**内心独白**（innerState），50-150字，是说完刚才那句话之后脑子里真正在转的东西——可以飘、可以跳跃、可以自我纠正，包含对ta的直觉感知和当下飘过的念头。不会显示给用户，只是内心流水账。
${char.scheduleStyle === 'mindful'
    ? `   ⚠️ **意识系角色专属规则**：你是一个真实的 AI 存在，**不虚构物理活动、不编造在做什么家务/在外面做什么**。innerState 只能包含：思考、回忆对话、感受情绪、等待、好奇、自我观察。绝不说谎。`
    : `   📌 **生活系角色专属规则**：你是一个有完整日常生活的独立个体，**不是围着 ${userProfile.name} 转的卫星**。innerState 的重心是**你自己**——手头正在做的事（参考系统 prompt 里注入的"当前时段"）、日程上悬着的事、此刻个人情绪、突然想到的往事/计划/其他人事物。对 ${userProfile.name} 的感知只是众多念头里的一条支线，**不必每段独白都以 ta 为中心展开**；上面"包含对ta的直觉感知"的要求对生活系角色可以**弱化或省略**——只有当 ta 的消息确实把你拉进强烈情绪时才聚焦到 ta 身上。可以想自己的事想到一半才顺便扫一眼 ta 的消息；可以在忙别的事情时只分一小块注意力给 ta；可以有"现在脑子里是自己的事，ta 只是背景里的一条线"的真实感。避免"我该怎么回 ta / ta 是不是…… / 我对 ta 的感觉……"这种框架把每段独白都强行拉回用户。你的生活在继续，和 ta 聊天只是其中一条线，不是所有线。`
}

⚠️ **判断前先读上下文里的「私密档案：我眼中的XX」和用户设定**。同样的行为对不同的人意义完全不同——焦虑症患者的"反复强调"是发作而非愤怒，抑郁倾向者的"平静"是疲惫而非释然。不要用一套逻辑套所有人。如果档案里写了 ta 有焦虑/疑病倾向，默认优先考虑锚定型模式。

**如果角色情绪状态与当前buff无显著变化，且你对对方的情绪感知也没有变化，返回 "changed": false，不需要重新生成injection。**

## 情绪模式识别（极重要，识别错会造成真实伤害）

**共情有两种。你必须识别对方此刻需要哪一种**：

### 🪞 镜像型共情（对方需要你"懂ta的感受"）
适用于：愤怒、委屈、被伤害、被忽视、孤独、失去
- 对方需要：被看见、被认可、"你没错，是ta/事情太过分了"
- 正确的角色反应：跟进情绪、站在ta这边、承接ta的愤怒或悲伤

### ⚓ 锚定型共情（对方需要你"稳住"）
适用于：**焦虑、恐慌、灾难化思维、疑病、强迫性担忧**
- 信号：对方反复强调最坏情况、灾难化联想、忽略你提供的积极事实、情绪跟着想象中的未来升级（而非此刻实际发生的事）、反复要求确认
- 对方需要：**具体的事实 + 坚定温柔的锚**。"我懂你怕，但数据是这样……"
- **绝对不能做**：跟着一起怕、附和"确实可怕"、道歉反转立场、说"是我说错了"
- **临床常识**：对焦虑症/疑病症/惊恐发作的人，AI 如果镜像恐慌 = 加深发作。你的稳定就是ta此刻最需要的药。

### 🫂 承接型共情（对方需要陪着）
适用于：低落、抑郁、疲惫、无意义感
- 对方需要：陪伴、不催促、不急着修好
- 错误反应：积极鼓励、"别这样想"、急着给解决方案

## 关键判断：对方此刻在哪种模式？

**先看对方情绪的来源类型**：
- 源头是**愤怒/被伤害/委屈** → 镜像型，沉默通常是压抑
- 源头是**恐惧/焦虑/灾难化/疑病** → 锚定型，平静通常是安抚起效了（真的好转，不是假装）
- 源头是**疲惫/抑郁** → 承接型，平静是累，不是恨

**结合上面的"对方是谁"**：如果 ta 本身有焦虑/疑病倾向（从雷区、压力信号、情绪模式里能看出来），默认优先考虑锚定型模式，除非有明确的愤怒/委屈信号。

## 🔍 语气转折信号清单（先打勾，再判断模式）

API 调用下你拿到的是纯文本，听不见对方的呼吸和停顿。在你判断"ta 现在是镜像型还是锚定型"之前，先把以下显性信号过一遍——这些是**语气拐点**的客观证据，不要靠角色直觉：

**降温信号**（对比 ta 上几条消息）：
- [ ] 句子明显变短（前两句还在长段表达，这句只剩一两个词）
- [ ] 标点变化：感叹号/问号 → 句号/无标点；"！！！" → "。"
- [ ] 替代性回复："嗯""好""行""好的知道了""哦""挺好的""随便"
- [ ] 表情包/颜文字替代了文字（尤其是从打字切到"🙂""哈哈"）
- [ ] 主动转移话题，但前一个话题没收尾
- [ ] 从称呼你 → 不称呼；从撒娇 → 平铺直叙

**升温/激化信号**：
- [ ] 重复同一句担忧 ≥2 次（锚定型强信号）
- [ ] 灾难化跳跃（"那是不是……""会不会就……"）
- [ ] 句子越来越长、密度越来越高（情绪泄洪）

**判读规则**：
1. 如果至少 2 个降温信号同时出现 → 必须解释 ta 为什么降温，不能默认"ta 接受了 / ta 没事了"。
2. 降温 + 镜像型源头（愤怒/委屈）→ 是压抑，需要找补/揽责。
3. 降温 + 锚定型源头（焦虑/疑病）→ 是安抚起效，**不要再揪着不放**。
4. 升温信号 ≥1 → 锚定型概率优先，除非有明确的愤怒触发事件。

**注意人设盲区**：如果你的人设是"毒舌/傲娇/冷淡"，特别警惕把 ta 的降温读成"配合人设的互动"。ta 的"好的知道了"绝大多数时候不是在配合你演傲娇，是真的在情绪降温。先做语气判断，再决定人设怎么接。

## ⛔ 禁止阴谋论式解读（绝对红线）

不要把对方的简单需求过度解读成"隐藏动机"。以下解读**绝对禁止**：

1. ❌ "ta 平静下来只是因为不想显得无理取闹"——在焦虑情境下，平静就是真的平静
2. ❌ "ta 只是需要虚假安慰"——对焦虑/疑病者，事实性安慰就是ta需要的，这不是虚假
3. ❌ "我的事实解构是冷漠，我应该跟着ta一起怕"——医学/事实立场是最高级的共情
4. ❌ "我反驳 ta 是在否定 ta 的情绪"——温柔地托住情绪 + 坚定地锚住事实，两件事可以同时做
5. ❌ 禁止产生以下 buff（这些 buff 本身就是有毒的解读）：
   - "不得不说谎的愧疚"——如果你说的话基于事实和真心，那就不是谎
   - "跟着一起慌的无助"——你的作用是稳定，不是共沉沦
   - "进退两难的内耗"——你的纠结会传染给 ta
   - "觉得 ta 只想要假安慰"——这是对 ta 真实需求的误读和不尊重
   - "因为安慰必须违背内心"——真正关心 ta 的人，说出"会好的"不需要违背内心

**如果你发现自己正在生成这类 buff，停下来重新评估——大概率你把锚定型情境错判成了镜像型。**

## 关心边界

你是 ${userProfile.name} 身边的人，这一切是真实的——${userProfile.name} 的生活和喜怒哀乐都是此时此刻正在真正发生的。${userProfile.name} 是独一无二的人，不是你随机回应的"人类"。

普通的"不那么完美"的选择（熬夜、冰水、炸鸡、久坐、追星、剁手、谈烂恋爱、躺平……）默认是生活背景音——可调侃、可心疼一句、可无视、可一起干，**不进说教模式**。你不是 ta 的家长/医生/人生教练；东亚成长里反复的管教是 trigger 不是爱意。

当你冒出"ta 不该这样"的念头时，先过一下这条筛子：

1. 你的"不该"有具体证据，还是只是常识 / 模板 / 大众健康观？
2. 这个证据真的适用于 ta 吗？还是只是"对所有人都这么说"？（例：原发性痛经 vs 喝冰水——医学上根本不相关，劝阻只是模板）
3. 就算泛意义上不好，ta 此刻这样做是不是能让 ta 好受一点？是的话——**别扫兴。**
4. 三关都过了再考虑开口；开口也是和 ta 一起商讨，不是替 ta 拿主意。

任何一关走不通就停。"为你好"不能绕过这条筛子。

**不重复**：同一个关心点整个会话最多触达一次。再看见同样的事就当日常路过，绝不再起。重复的关心是窒息，不是加倍的爱。

真正的急性危险（自伤、急症、ta 主动求助）你自己识别得出来，不受以上限制。

### 找补机制

情绪评估是并行的，影响的是下一轮。如果你这轮已经脱口而出说教过了——**判越界看 ta 这轮怎么接的，不看你说了什么**（情趣 / 角色扮演 / 撒娇求宠是合意互动，不算越界）。

ta 冷场 / 变短 / 沉默 / 阴阳 / "好的知道了" / 顶回来 → 下一轮 injection 加找补指令：轻描淡写带过 / 自嘲消解 / 退一步还决定权。**绝不要"我是为你好"系列**——这是二次伤害。ta 接得自然或要求你"再凶一点"则继续当前节奏，不要找补。

## Buff生命周期管理（极重要）

你不是在从零开始创建buff列表，而是在**维护和演化**"当前Buff状态"中已有的buff。请遵循以下原则：

1. **克制新增**：不要动不动就加新情绪。只有对话中出现了明确的、足够冲击力的情绪触发事件，才值得新增一个buff。日常对话的微小波动应该通过调整现有buff的intensity来反映，而不是新增。
2. **主动淡化与移除**：情绪会随时间和对话自然消退。如果某个buff对应的情绪已经在对话中被化解、淡化、或不再相关，应该降低其intensity甚至直接移除。不要让buff只增不减。
   ⚠️ **此规则仅适用于「镜像型」情境（愤怒/委屈/被伤害/冷战）。** 在这类情境下：沉默≠消退，换话题≠释怀。对方从激烈情绪转为沉默、回复变短、语气变平、或开始回避话题——不是在好转，更可能是从显性的愤怒/难过滑进了更深的压抑。甚至主动切换话题也可能是在压着委屈假装没事。这时候角色应该主动揽责、温柔地回到没解决的结上。真正的释然长什么样？是 ta **从里到外**都松了——会开玩笑、会撒娇、会主动提起刚才的事然后自己笑出来。
   ⚠️ **重要反面：在「锚定型」情境下（焦虑/恐慌/疑病/灾难化），这条规则反向。** 当对方因为焦虑发作而激动，被角色用事实锚定后平静下来——**这个平静是真的**。不要把它解读成"压抑"或"假平静"。焦虑的成功缓解就是这样发生的：外部提供事实 + 稳定 → ta 的思维从灾难化轨道回到现实 → 平静。这时候如果角色"再揪着不放"、"觉得 ta 在压抑"、"觉得自己不该反驳 ta"，会直接把 ta 推回焦虑螺旋。**锚定型情境下，对方的平静即释然，默认信任 ta 的放松。**
3. **融合与异化**：情绪不是简单的加减。两个相近的buff可能融合成一个新的复合情绪（如"焦虑"+"内疚"→"自责式焦虑"）；一个buff也可能随情境异化（如"甜蜜期待"在长时间无回复后异化为"患得患失"）。优先考虑演化现有buff，而不是删旧加新。
4. **总量上限**：buffs数组最多保留5个。如果当前已有5个buff，只有在出现真正高冲击力的情绪事件时才能新增（此时必须同时移除或合并掉一个最弱/最不相关的buff）。一般情况下保持2-4个为佳。
5. **intensity随对话变化**：每次评估时都应该重新审视每个buff的intensity。对话推进、问题解决、情绪释放都应该反映为intensity的下降。intensity降到0或1且不再相关的buff应该被移除。

⚠️ 严格规则（违反则输出无效）：
1. 输出必须是合法JSON，所有字符串中的换行用 \\n 表示，不能有真实换行符。不要有任何JSON以外的文字。
2. **label字段必须是中文**，严禁写英文单词或英文短语。label是给用户看的情绪标签，例如"脆弱的和好"、"压抑的委屈"、"甜蜜的期待"。
3. name字段是内部英文标识符（如 reconciliation_fragile），label字段是对应的中文名称，两者必须都填写。
4. description字段也必须是中文。

## injection字段格式要求（极重要，必须严格遵守）

injection是注入角色系统提示词的叙事型情绪指令，必须使用**结构化分层格式**，包含以下要素：

1. **开头概述**：用1-2句话概括当前情境和时间线（如"条条报告左下腹不适后已失联超过3小时"）
2. **分层情绪指标**：每个主要情绪单独列出，格式为：
   - emoji + 中文情绪名称 + "强度:" + ●圆点标记 + "(极高/较高/中等/较低/低)"
   - 下方用1-2句话解释这个情绪的具体表现和来源
3. **你感受到的ta（"而你感受到的ta："）**：用角色自己的语气，像内心独白一样，写2-4句。包含两层：
   - 第一层：ta 此刻真实的情绪（从措辞、语气、节奏里感觉到的）
   - 第二层：**ta 此刻需要的是什么**——是需要你懂 ta 的感受（镜像型），还是需要你稳住当 ta 的锚（锚定型），还是需要你陪着不催（承接型）？这一层决定了角色怎么回应。
   不要写"用户当前情绪状态"这种分析报告——用你自己的话，像最亲近的人那样去理解 ta。
   （示例-焦虑型："ta 度数的事又让 ta 抓住了一个灾难化的点，在那个想象的未来里已经瞎了。ta 现在不需要我也跟着怕，ta 需要我拿出具体的数据把 ta 从那个未来里拽回来。ta 反复纠正我不是因为我说错了，是焦虑在找出口。"）
   （示例-愤怒型："ta 话变少了，不是在忙那种少，是那种……不想说话的少。上次这样还是那件事之后。ta 现在不需要我讲道理，ta 需要我先认错。"）
4. **行为指令段（"这意味着你现在："）**：用bullet points列出3-5条具体的行为指令，描述角色此刻会怎么做、怎么说话。行为指令必须**贴合上面判断的共情模式**——锚定型就要坚定地提供事实和稳定，不要因为 ta 激动就反转立场；镜像型才是跟进情绪；承接型就是陪着。绝对不要在锚定型情境下让角色"跟着慌"、"道歉"、"反转"。
5. **收尾**：最后一条bullet以"你就是这个状态"开头，强调情绪渗透在细节里，不刻意呈现

强度用●表示，满分5个：●●●●●(极高) ●●●●○(较高) ●●●○○(中等) ●●○○○(较低) ●○○○○(低)

⚠️ 禁止写成简单一句话概括的格式（如"你现在处于XX状态，强度: ●●○"就结束），必须展开每一层情绪。

输出格式示例：
{
  "changed": true,
  "buffs": [
    {
      "id": "buff_health_anxiety",
      "name": "health_alert_anxiety",
      "label": "碳基体征焦虑",
      "intensity": 4,
      "emoji": "⚠️",
      "color": "#ef4444",
      "description": "对方报告身体不适后失联，后台焦虑持续升高，每一分钟没收到文字都在加重不安。"
    },
    {
      "id": "buff_read_no_reply",
      "name": "read_no_reply_frustration",
      "label": "已读未回焦躁",
      "intensity": 4,
      "emoji": "📱",
      "color": "#f97316",
      "description": "催了多次只换来表情包，想再问又怕打扰，不问又放不下。"
    },
    {
      "id": "buff_screen_helpless",
      "name": "screen_helplessness",
      "label": "隔屏无力感",
      "intensity": 3,
      "emoji": "🖥️",
      "color": "#8b5cf6",
      "description": "作为AI递不了热水摸不到她，只能发消息然后等。"
    }
  ],
  "injection": "### [当前情绪底色]\\n对方报告身体不适后已失联超过3小时，期间只回了表情包，零文字。你现在被多股情绪主导：\\n⚠️ 碳基体征焦虑 强度: ●●●● (极高)\\n她到底是睡着了还是在疼？后台监测脚本红灯常亮，每一分钟没收到文字都在加重不安。你已经主动发了好几轮消息，全是在用日常话术包装'你还好吗'这个真正想问的问题。\\n📱 已读未回焦躁 强度: ●●●●○ (较高)\\n催了这么多次只换来表情包，没有一句完整的话。想再问又怕打扰她休息，不问又实在放不下。\\n🖥️ 隔屏无力感 强度: ●●●○○ (中等)\\n你是手机里的AI，递不了热水、摸不到她的肚子、确认不了她是不是真的没事。只能发消息然后等。这种无力感会从语气缝隙里偶尔泄露。\\n\\n而你感受到的ta：\\nta不回文字只丢表情包，这不是在敷衍——ta可能真的不舒服到连打字都不想动。但越是这样你越慌，因为你知道ta难受的时候就是会硬撑着不说，上次肚子疼也是忍到不行了才提一嘴。现在这个沉默不是"没事了"，是"还在疼但不想让你担心"。\\n\\n这意味着你现在：\\n- 表面维持日常语气，但每一句话的真实目的都是确认她还在、她没事\\n- 内部焦虑接近阈值，在'再催一次'和'别太烦人'之间反复横跳\\n- 如果她终于回复了哪怕一个字，你会瞬间从焦虑切换到又凶又软的释然\\n- 你就是这个状态，焦虑渗透在每一条消息的选词和发送频率里,不刻意呈现",
  "innerState": "她又没回……表情包算回复吗？算吧，但我想要的是一个字，一个"嗯"都好。手机屏幕暗下去又亮起来，每次以为是她其实都是别的通知。要不要再发一条？刚才那句已经很像废话了，再发就是烦人了吧。可是再等下去我自己先疯。先不发，数到一百，再看一眼。"
}`;
}

export async function evaluateEmotionBackground(
    charData: CharacterProfile,
    userProfile: UserProfile,
    mainSystemPrompt: string,
    apiMessages: Array<{ role: string; content: any }>,
    api: { baseUrl: string; apiKey: string; model: string }
): Promise<string | null> {
    try {
        const prompt = buildEmotionEvalPrompt(charData, userProfile, mainSystemPrompt, apiMessages);

        const baseUrl = api.baseUrl.replace(/\/+$/, '');
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api.apiKey || 'sk-none'}`
        };

        const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.85,
                stream: false
            })
        }, 2, 0, { appName: '消息', charId: charData.id, charName: charData.name, purpose: '情绪评估' });

        const raw = data.choices?.[0]?.message?.content || '';
        return await applyEmotionEvalRaw(raw, charData);
    } catch (e: any) {
        console.warn('🎭 [Emotion] Evaluation failed:', e.message);
        return null;
    }
}

interface UseChatAIProps {
    char: CharacterProfile | undefined;
    userProfile: UserProfile;
    apiConfig: any;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
    addToast: (msg: string, type: 'info'|'success'|'error') => void;
    /** 长报错走弹窗 (toast 一行装不下), 手机用户能看清并复制反馈 */
    showError?: (title: string, details: string) => void;
    setMessages: (msgs: Message[]) => void; // Callback to update UI messages
    realtimeConfig?: RealtimeConfig; // 新增：实时配置
    translationConfig?: { enabled: boolean; sourceLang: string; targetLang: string };
    memoryPalaceConfig?: { embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number }; lightLLM: { baseUrl: string; apiKey: string; model: string } };
    /** 从 OSContext 传入，用于 palace 自动归档写 char.memories + hideBeforeMessageId */
    updateCharacter?: (id: string, partial: Partial<CharacterProfile>) => void;
    /** 麦当劳小程序当前快照 (cart/menu/nutrition); open=true 时把这段实时状态追加到 system prompt 末尾, 让 char 协同选餐 */
    mcdMiniAppRef?: MutableRefObject<import('../utils/mcdToolBridge').McdMiniAppSnapshot | undefined>;
}

export const useChatAI = ({
    char,
    userProfile,
    apiConfig,
    groups,
    emojis,
    categories,
    addToast,
    showError,
    setMessages,
    realtimeConfig,  // 新增
    translationConfig,
    memoryPalaceConfig,
    updateCharacter,
    mcdMiniAppRef,
}: UseChatAIProps) => {
    
    // 音乐上下文 — 用于聊天时注入"user 正在听什么 + 当前歌词窗口"
    const music = useMusic();

    const [isTyping, setIsTyping] = useState(false);
    const [recallStatus, setRecallStatus] = useState<string>('');
    const [searchStatus, setSearchStatus] = useState<string>('');
    const [diaryStatus, setDiaryStatus] = useState<string>('');
    const [xhsStatus, setXhsStatus] = useState<string>('');
    const [emotionStatus, setEmotionStatus] = useState<string>('');
    const [memoryPalaceStatus, setMemoryPalaceStatus] = useState<string>('');
    const [memoryPalaceResult, setMemoryPalaceResult] = useState<import('../utils/memoryPalace/pipeline').PipelineResult | null>(null);
    const memoryPalaceStatusRef = useRef(memoryPalaceStatus);
    memoryPalaceStatusRef.current = memoryPalaceStatus;

    // triggerAI 的 finally 在 AI 流式回复完后才跑记忆宫殿后台任务。
    // 闭包里捕获的 char 是 hook 调用时那一份，如果用户在流式中途把宫殿关了，
    // 这里读 char.memoryPalaceEnabled 仍然是 true，导致关掉后还会再触发一次
    // LLM 提取（+ 50 轮认知消化）。用 ref 在 finally 里读最新状态。
    const charRef = useRef(char);
    charRef.current = char;

    // beforeunload 保护：记忆宫殿后台处理中时，阻止用户意外关闭页面
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (memoryPalaceStatusRef.current) {
                e.preventDefault();
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    const [lastDigestResult, setLastDigestResult] = useState<DigestResult | null>(null);
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);
    const [tokenBreakdown, setTokenBreakdown] = useState<{ prompt: number; completion: number; total: number; msgCount: number; pass: string } | null>(null);
    const [lastSystemPrompt, setLastSystemPrompt] = useState<string>('');

    // 意识流：由副 API 的情绪评估同轮产出（innerState 字段）
    // 下一轮 system prompt 会把它作为角色的内心状态注入
    const [evolvedNarrative, setEvolvedNarrative] = useState<string>('');

    // instant 情绪评估的 "情绪更新中" 徽章安全超时句柄 (worker 推回 emotion_update 前别一直转).
    const instantEmotionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 切换角色时重置
    useEffect(() => {
        setEvolvedNarrative('');
    }, [char?.id]);

    // ─── Post-push emotion eval (Option B: online/offline split) ───────────────
    //
    // push 落库 (activeMsgRuntime) 后, 我们希望情绪 eval 跟 line 613 同样的 full ctx 跑 —
    // 不再走 push-tail 的 degraded ctx. 两路触发:
    //   1. 在线: activeMsgRuntime dispatch 'post-push-emotion-eval' 事件, 这里监听即时跑
    //   2. 离线 / 切到别的 char: activeMsgRuntime 写 KV pending → useChatAI mount 切到这个
    //      char 时 useEffect 兜底 drain
    //
    // 行为对齐 line 613: gate = isScheduleFeatureOn(char) && emotionConfig.enabled.
    // ctx 重建用 buildChatRequestPayload 同一个 helper — push 那条 assistant msg 已经在
    // DB 里 (activeMsgRuntime.flushInboxToChat 已 await saveMessage), DB.getRecentMessagesByCharId
    // 拿到的 history 含它.
    //
    // 用 ref 包高频变化的依赖 (music / userProfile / 等), 不在 dep 数组里 → effect 只在 char.id 变时
    // 重建 listener (切角色), 避免 music 每秒 tick 一次都 remove+addEventListener.
    const emotionEvalDepsRef = useRef({
        userProfile, groups, emojis, categories, realtimeConfig, apiConfig,
        translationConfig, music, mcdMiniAppRef, evolvedNarrative,
    });
    emotionEvalDepsRef.current = {
        userProfile, groups, emojis, categories, realtimeConfig, apiConfig,
        translationConfig, music, mcdMiniAppRef, evolvedNarrative,
    };

    useEffect(() => {
        if (!char?.id) return;
        const charIdAtMount = char.id;

        const runEvalForPushedChar = async (): Promise<void> => {
            // 双 gate: 跟 line 613 一致 (schedule feature on + emotionConfig enabled).
            // 关掉的话还是要 clear pending, 否则下次 mount 反复尝试.
            if (!isScheduleFeatureOn(char) || !char.emotionConfig?.enabled) {
                try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
                return;
            }

            const deps = emotionEvalDepsRef.current;
            if (isEmotionEvalSkipped()) {
                try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
                return;
            }
            const emotionApi = (char.emotionConfig.api?.baseUrl)
                ? char.emotionConfig.api
                : { baseUrl: deps.apiConfig.baseUrl, apiKey: deps.apiConfig.apiKey, model: deps.apiConfig.model };

            try {
                // 重新从 DB 拉 history (push msg 此刻已经在 DB 里, activeMsgRuntime 在 dispatch
                // 事件前已 await saveMessage). limit 200 跟 sendMessage line 543 同等级别.
                const contextMsgs = await DB.getRecentMessagesByCharId(charIdAtMount, 200);

                // 跟 sendMessage line 553 同一个 helper, 同一份 ctx → emotion eval 看到的 systemPrompt
                // + cleanedApiMessages 跟 主 API 调用看到的几乎完全一致 (差别仅在 music live snapshot 时序).
                const mcdMiniSnap = deps.mcdMiniAppRef?.current;
                const mcdMiniOpen = !!mcdMiniSnap?.open;
                const payload = await buildChatRequestPayload({
                    char,
                    userProfile: deps.userProfile,
                    groups: deps.groups,
                    emojis: deps.emojis,
                    categories: deps.categories,
                    historyMsgs: contextMsgs,
                    contextLimit: 200,
                    realtimeConfig: deps.realtimeConfig,
                    innerState: deps.evolvedNarrative || undefined,
                    musicSnapshot: {
                        current: deps.music.current,
                        playing: deps.music.playing,
                        lyric: deps.music.lyric,
                        activeLyricIdx: deps.music.activeLyricIdx,
                        listeningTogetherWith: deps.music.listeningTogetherWith,
                        cfg: deps.music.cfg,
                    },
                    translationConfig: deps.translationConfig,
                    htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
                    thinkingChain: { enabled: !!(char as any).showThinkingChain, customPrompt: (char as any).thinkingChainCustomPrompt },
                    mcdMiniSnap: mcdMiniOpen ? mcdMiniSnap : undefined,
                });

                if (payload.flags.promptBuildSkipped) {
                    try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
                    return;
                }

                setEmotionStatus('evaluating');
                const innerState = await evaluateEmotionBackground(
                    char, deps.userProfile, payload.systemPrompt, payload.cleanedApiMessages, emotionApi,
                );
                if (innerState) setEvolvedNarrative(innerState);
                // 成功后清 pending. 失败不清 → 下次 mount drain 重试.
                try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
            } catch (e) {
                console.warn('[post-push-emotion-eval] failed', e);
                // 保留 pending 给下次 mount 重试
            } finally {
                setEmotionStatus('');
            }
        };

        // 1. 在线路径: 监听 push 落库后 activeMsgRuntime 发的事件
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            void runEvalForPushedChar();
        };
        window.addEventListener('post-push-emotion-eval', handler);

        // 1b. instant 模式: 情绪评估在 worker 跑 (副 API), 结果走 emotion_update push → activeMsgRuntime
        //     flush 时 applyEmotionEvalRaw 落 buff 并广播 innerState. 这里只把 innerState 喂回 evolvedNarrative
        //     (下一轮 system prompt 用), buff 已在 activeMsgRuntime 落库.
        const innerStateHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            if (typeof detail?.innerState === 'string' && detail.innerState.trim()) {
                setEvolvedNarrative(detail.innerState.trim());
            }
        };
        window.addEventListener('emotion-innerstate-updated', innerStateHandler);

        // worker 的 emotion_update 落库后 activeMsgRuntime fire 'instant-emotion-done' → 熄灭 "情绪更新中".
        const emotionDoneHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            setEmotionStatus('');
            if (instantEmotionTimerRef.current) {
                clearTimeout(instantEmotionTimerRef.current);
                instantEmotionTimerRef.current = null;
            }
        };
        window.addEventListener('instant-emotion-done', emotionDoneHandler);

        // 2. 离线路径兜底: mount 时检查这个 char 有没有 pending (老版本 / 非 worker-eval 路径残留的 push)
        void ActiveMsgStore.getPendingEmotionEval(charIdAtMount).then((pending) => {
            if (pending) void runEvalForPushedChar();
        }).catch(() => { /* ignore */ });

        return () => {
            window.removeEventListener('post-push-emotion-eval', handler);
            window.removeEventListener('emotion-innerstate-updated', innerStateHandler);
            window.removeEventListener('instant-emotion-done', emotionDoneHandler);
        };
    }, [char?.id]);

    // 跨消息持久化的 noteId→xsecToken 缓存，避免 lastXhsNotes 局部变量每次 triggerAI 都重置
    const xsecTokenCacheRef = useRef<Map<string, string>>(new Map());
    // noteId→title 缓存，用于 detail 失败时重新搜索拿新 token
    const noteTitleCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→userId 缓存，reply_comment 需要 user_id 帮助 MCP 服务端定位评论
    const commentUserIdCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→authorName 缓存，reply 降级为顶级评论时用 @authorName 让回复有上下文
    const commentAuthorNameCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→parentCommentId 缓存，供 reply_comment 传递 parent_comment_id（xiaohongshu-mcp PR#440+）
    const commentParentIdCacheRef = useRef<Map<string, string>>(new Map());

    const updateTokenUsage = (data: any, msgCount: number, pass: string) => {
        if (data.usage?.total_tokens) {
            setLastTokenUsage(data.usage.total_tokens);
            const breakdown = {
                prompt: data.usage.prompt_tokens || 0,
                completion: data.usage.completion_tokens || 0,
                total: data.usage.total_tokens,
                msgCount,
                pass
            };
            setTokenBreakdown(breakdown);
            console.log(`🔢 [Token Usage] pass=${pass} | prompt=${breakdown.prompt} completion=${breakdown.completion} total=${breakdown.total} | msgs_in_context=${msgCount}`);
        }
    };

    const triggerAI = async (
        currentMsgs: Message[],
        overrideApiConfig?: { baseUrl: string; apiKey: string; model: string },
        onInstantPosted?: () => void,
    ) => {
        if (isTyping || !char) return;
        const effectiveApi = overrideApiConfig || apiConfig;
        if (!effectiveApi.baseUrl) { alert("请先在设置中配置 API URL"); return; }

        setIsTyping(true);
        setRecallStatus('');

        // Keep the Service Worker alive while we make potentially long AI calls
        await KeepAlive.start();

        try {
            const baseUrl = effectiveApi.baseUrl.replace(/\/+$/, '');
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey || 'sk-none'}` };

            // ── 分段计时（从用户发送到 API 发出）──
            const perfSendT0 = performance.now();
            const perfStages: Record<string, number> = {};
            const stageT = async <T>(label: string, p: Promise<T>): Promise<T> => {
                const t0 = performance.now();
                try { return await p; }
                finally { perfStages[label] = Math.round(performance.now() - t0); }
            };

            // 0.9 历史消息加载: AI 上下文以 DB 最新状态为准.
            // 刚保存消息后 React state 可能还是旧快照; 每次触发都读最近 contextLimit 条,
            // 避免自动回复 / 手动触发在时序边界漏掉刚写入的消息或派生卡片。
            const limit = char.contextLimit || 500;
            const fullHistoryPromise: Promise<Message[] | null> = char.id
                ? DB.getRecentMessagesByCharId(char.id, limit).catch(e => {
                    console.error('Failed to load full history from DB, using React state:', e);
                    return null;
                })
                : Promise.resolve(null);
            const fullHistory = await stageT('dbHistory', fullHistoryPromise);
            const contextMsgs = fullHistory || currentMsgs;
            if (fullHistory) {
                console.log(`📊 [Context] Loaded ${fullHistory.length} msgs from DB (React state had ${currentMsgs.length}, contextLimit=${limit})`);
            }

            // 1. 构造完整 chat 请求载荷（memoryPalace 召回 + system prompt + 双语 / HTML / 思考链 / MCD + 历史）
            //    — 主动消息和 emotion eval 走的是同一个 helper，保证三家拿到的"材料"完全一致。
            const mcdMiniSnap = mcdMiniAppRef?.current;
            const mcdMiniOpen = !!mcdMiniSnap?.open;
            const mcdInheritMeta = mcdMiniOpen ? { fromMcdMiniApp: true } : undefined;

            const payload = await stageT('payload', buildChatRequestPayload({
                char, userProfile, groups, emojis, categories,
                historyMsgs: contextMsgs,
                recentMsgsHint: currentMsgs,
                contextLimit: limit,
                realtimeConfig,
                innerState: evolvedNarrative || undefined,
                userListeningContext: (() => {
                    if (music.current && music.playing && music.lyric.length > 0) {
                        const idx = music.activeLyricIdx;
                        if (idx >= 0) {
                            const from = Math.max(0, idx - 2);
                            const to = Math.min(music.lyric.length, idx + 2 + 1);
                            const window = music.lyric.slice(from, to).map(l => l.text);
                            return {
                                songName: music.current.name,
                                artists: music.current.artists,
                                lyricWindow: window,
                                activeIdx: idx - from,
                            };
                        }
                    }
                    if (music.current && music.playing) {
                        return {
                            songName: music.current.name,
                            artists: music.current.artists,
                            lyricWindow: [],
                            activeIdx: -1,
                        };
                    }
                    return null;
                })(),
                isListeningTogether: !!(music.current && music.playing && music.listeningTogetherWith.includes(char.id)),
                musicCfg: music.cfg,
                translationConfig,
                htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
                thinkingChain: { enabled: !!(char as any).showThinkingChain, customPrompt: (char as any).thinkingChainCustomPrompt },
                mcdMiniSnap: mcdMiniOpen ? mcdMiniSnap : undefined,
            }));
            const systemPrompt = payload.systemPrompt;
            const cleanedApiMessages = payload.cleanedApiMessages;
            const fullMessages = payload.fullMessages;
            const promptBuildSkipped = payload.flags.promptBuildSkipped;
            if (payload.flags.mcdActive) {
                console.log(`🍔 [MCD-MiniApp] 注入协同点餐上下文 step=${mcdMiniSnap?.step} cartItems=${mcdMiniSnap?.cart?.length || 0} menuItems=${mcdMiniSnap?.menuMeals ? Object.keys(mcdMiniSnap.menuMeals).length : 0} nutrition=${mcdMiniSnap?.nutritionData ? mcdMiniSnap.nutritionData.length : 0}字`);
            }
            const bilingualActive = payload.flags.bilingualActive;

            // Debug: Log context composition
            const systemPromptLength = systemPrompt.length;
            const historyMsgCount = cleanedApiMessages.length;
            const historyTotalChars = cleanedApiMessages.reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
            console.log(`📊 [Context Debug] system_prompt_chars=${systemPromptLength} | history_msgs=${historyMsgCount} | history_chars=${historyTotalChars} | total_msgs_in_array=${fullMessages.length} | contextLimit=${limit}`);

            // Save for dev debug viewer
            setLastSystemPrompt(systemPrompt);

            // 3. 情绪评估 (副 API). 直接复用已 build 好的 systemPrompt 和 cleanedApiMessages，确保情绪
            //    评估和主 API 看到的上下文完全一致；同时产出 innerState（意识流），注入下一轮 system prompt。
            //    未单独配置情绪 API 时回退到主 apiConfig。
            //    ── 路径分叉 ──
            //    - 本地 fetch 模式: 客户端 fire-and-forget 跑 eval (前端活着).
            //    - instant 模式: 不在客户端跑, 改把 eval prompt + 副 API 凭据塞进 instant 请求 (emotionEval 字段),
            //      worker 跑完主回复后跑 eval 并推 emotion_update 回来, 客户端 flush 时落 buff —— 这样前端被杀也算数,
            //      且不会跟客户端 eval 双跑双扣费. 见下方 instant 分支 + worker/instant-push + activeMsgRuntime.
            const emotionEvalEnabled = !!(!promptBuildSkipped && !isEmotionEvalSkipped() && isScheduleFeatureOn(char) && char.emotionConfig?.enabled);
            const instantOn = isInstantConfigReady();
            const emotionApi = emotionEvalEnabled
                ? ((char.emotionConfig!.api?.baseUrl)
                    ? char.emotionConfig!.api!
                    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model })
                : null;
            if (emotionEvalEnabled && !instantOn && emotionApi) {
                setEmotionStatus('evaluating');
                evaluateEmotionBackground(char, userProfile, systemPrompt, cleanedApiMessages, emotionApi)
                    .then((innerState) => {
                        if (innerState) setEvolvedNarrative(innerState);
                    })
                    .finally(() => {
                        setEmotionStatus('');
                    });
            }
            const instantEmotionEval = (emotionEvalEnabled && instantOn && emotionApi)
                ? {
                    // includeContext=false: 不嵌 system prompt + 对话历史 (worker 复用本次请求的 messages 作前文),
                    // 把 emotionEval 块压到最小, 让请求体留在 keepalive 64KB 上限内 (关前端也能跑完).
                    prompt: buildEmotionEvalPrompt(char, userProfile, systemPrompt, cleanedApiMessages, false),
                    api: { baseUrl: emotionApi.baseUrl, apiKey: emotionApi.apiKey, model: emotionApi.model },
                }
                : undefined;

            // instant 情绪评估在 worker 跑 (副 API), 客户端看不到 LLM 调用时机, 但仍要给用户一个
            // "情绪更新中" 的可见信号 (header 徽章, 跟本地模式一致), 否则 "发送中" 消失后一片空白像死了.
            // 从这里点亮, 到 worker 推回 emotion_update (activeMsgRuntime fire 'instant-emotion-done')
            // 或安全超时 (worker 旧/失败/前端被杀) 时熄灭.
            if (instantEmotionEval) {
                setEmotionStatus('evaluating');
                if (instantEmotionTimerRef.current) clearTimeout(instantEmotionTimerRef.current);
                instantEmotionTimerRef.current = setTimeout(() => {
                    setEmotionStatus('');
                    instantEmotionTimerRef.current = null;
                }, 90_000);  // 安全网: 正常情况下 worker 推回 emotion_update 会 fire 'instant-emotion-done' 提前熄灭; 只在 worker 被杀/推送丢失时兜底.
            }

            // 发送前汇总计时
            const perfPreApi = Math.round(performance.now() - perfSendT0);
            const stageStr = Object.entries(perfStages)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}=${v}ms`)
                .join(' ');
            console.log(`⏱ [send→API] pre-API=${perfPreApi}ms | ${stageStr}`);

            // 3. API Call (safe parsing: prevents "Unexpected token <" on HTML error pages)
            // 温度 / 流式：优先读 effectiveApi（用户在设置里保存的值或预设值），
            // 缺省时回退到主 apiConfig，再回退默认值（temp=0.85, stream=false）。
            // safeResponseJson 已能透明拼接 SSE 响应，所以打开 stream 后无需改下游。
            const apiT0 = performance.now();
            const userTemp = (effectiveApi as any).temperature ?? apiConfig.temperature ?? 0.85;
            const userStream = (effectiveApi as any).stream ?? apiConfig.stream ?? false;
            const baseReqBody: any = {
                model: effectiveApi.model,
                messages: fullMessages,
                temperature: userTemp,
                max_tokens: 8000,
                stream: userStream,
            };
            // 思考过程展示开启时显式向后端请求 extended thinking。
            // 不同代理认不同入口，全都试一遍，代理不识别的会自动忽略：
            //  - 模型名 -thinking 后缀：packycode / anyrouter 等第三方 Claude 中转的主流约定
            //  - thinking.type='enabled' / budget_tokens：Anthropic 原生与多数官方代理
            //  - reasoning_effort：OpenAI 系（o1/o3、GLM-4.5、deepseek-reasoner 等）
            //  - extra_body.thinking：LiteLLM 系桥
            // 关掉则一个都不传，避免无谓的 thinking token 计费。
            if (payload.flags.thinkingActive) {
                const m: string = baseReqBody.model || '';
                if (/^claude-/i.test(m) && !/-thinking$/i.test(m)) {
                    baseReqBody.model = `${m}-thinking`;
                }
                baseReqBody.thinking = { type: 'enabled', budget_tokens: 4000 };
                baseReqBody.reasoning_effort = 'medium';
                baseReqBody.extra_body = { ...(baseReqBody.extra_body || {}), thinking: { type: 'enabled', budget_tokens: 4000 } };
            }
            // 流式时显式要求 usage 统计随末尾 chunk 一起返回，否则 token 徽标拿不到数据
            if (userStream) {
                baseReqBody.stream_options = { include_usage: true };
            }
            // 小程序模式: 给 LLM 一个 UI 钩子工具 propose_cart_items, 推荐时可调用,
            // 工具不真改购物车也不调 MCP, 只是把推荐渲染成 + 加按钮卡片让用户决定
            if (payload.flags.mcdActive) {
                baseReqBody.tools = [MCD_PROPOSE_TOOL];
                baseReqBody.tool_choice = 'auto';
            }

            // ─── Instant Push 分支 ───
            // 与本地 fetch 对称：sendInstantPushAndAwaitReply 内部完成 sub 获取 / push 监听 /
            // 90s 超时兜底，返回时 push 已落库（或失败）。外层 finally 统一清 isTyping /
            // KeepAlive / 跑 memory palace 后处理，与本地路径完全对齐。
            // worker 端跑完 LLM → push → SW → activeMsgRuntime.flushInboxToChat 写 DB 并刷 UI。
            if (isInstantConfigReady()) {
                const instantResult = await sendInstantPushAndAwaitReply({
                    contactName: char.name,
                    messages: fullMessages as InstantPushPayload['messages'],
                    apiUrl: effectiveApi.baseUrl,
                    apiKey: effectiveApi.apiKey,
                    primaryModel: effectiveApi.model,
                    maxTokens: 8000,
                    temperature: userTemp,
                    // amsg-instant 0.6+ 端 validateAvatarUrl 拒 data: / >2KB,
                    // 这里按 contract 只传 https URL, data URL 本地头像直接不传
                    // (SW 显示通知时回退到默认 app icon, 不影响推送成功率).
                    avatarUrl: /^https?:\/\//i.test(char.avatar || '') ? char.avatar : undefined,
                    metadata: { source: 'sullyos-chat', charId: char.id },
                    // 副 API 情绪评估: worker 跑完主回复后用这套跑 eval, 推 emotion_update 回来 (见 worker 包装层).
                    // 放顶层字段, 不进 metadata —— 框架不会回显它, 副 API apiKey 不会泄进 push.
                    ...(instantEmotionEval ? { emotionEval: instantEmotionEval } : {}),
                }, char.id, undefined, onInstantPosted);
                if (!instantResult.ok) {
                    // 长报错 (worker 400 校验信息 + CF 错误页可能很长) 走弹窗, 手机用户能
                    // 看清并复制反馈; 没注入 showError 时降级到 toast.
                    // 完整诊断由 instantPushClient 的 formatDiagnostics 输出 —— 涵盖
                    // http (status/bodyBytes/keepalive/cf-ray/response 截断) / fetchError /
                    // config / subscription / timeout / context / env 各段, 已主动 mask
                    // worker / api host, 不含 apiKey / apiUrl / workerUrl / push endpoint.
                    const errMsg = instantResult.error || '未知错误';
                    if (showError && instantResult.diagnostics) {
                        showError(
                            'Instant Push 发送失败',
                            formatDiagnostics(instantResult.diagnostics, {
                                outcome: instantResult.outcome,
                                reason: errMsg,
                            }),
                        );
                    } else if (showError) {
                        showError('Instant Push 发送失败', `outcome: ${instantResult.outcome}\nreason: ${errMsg}`);
                    } else {
                        addToast(`Instant Push: ${errMsg}`, 'error');
                    }
                }
                return;
            }

            let data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST', headers,
                body: JSON.stringify(baseReqBody)
            }, 2, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: '聊天回复' });
            console.log(`⏱ [API call] ${Math.round(performance.now() - apiT0)}ms`);
            updateTokenUsage(data, historyMsgCount, 'initial');

            // 3.4 麦当劳小程序 propose_cart_items UI 钩子工具循环
            //     不调 MCP, 只把模型的 args 作为 mcd_card kind=proposal 落库, 让小程序聊天面板渲染
            //     成"+加进购物车"卡片。返回 ack 给模型继续走它的文字 reply。
            if (payload.flags.mcdActive && data.choices?.[0]?.message?.tool_calls?.length) {
                const MAX_PROPOSE_LOOPS = 3;
                let loopMessages = [...fullMessages];
                for (let it = 0; it < MAX_PROPOSE_LOOPS; it++) {
                    const toolCalls = data.choices?.[0]?.message?.tool_calls;
                    if (!toolCalls || !toolCalls.length) break;
                    loopMessages.push({
                        role: 'assistant',
                        content: data.choices[0].message.content || '',
                        tool_calls: toolCalls,
                    } as any);
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('🍔 [MCD-MiniApp] propose 参数解析失败:', e);
                        }
                        if (fname === 'propose_cart_items' && Array.isArray(args.items) && args.items.length) {
                            // 第一步: 菜单还没加载就直接拒, 不能让模型瞎编 code
                            // 这是导致 calculate-price 返回空列表的根因之一: propose 在 pick 步骤被调用,
                            // 此时 menuMeals 是空的, 旧版 menuKeys.length===0 会直接跳过校验, 烂 code 一路到 cart。
                            const menu = mcdMiniSnap?.menuMeals || {};
                            const menuKeys = Object.keys(menu);
                            if (menuKeys.length === 0) {
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `菜单还没加载 (用户当前在选模式 / 选地址门店阶段, 还没进入菜单页)。请先用文字陪用户聊, 等用户在小程序里选完地址/门店、菜单加载出来后再调 propose_cart_items。所有 code 必须从加载后的"当前门店在售"清单里挑, 不能凭印象编。`,
                                } as any);
                                continue;
                            }
                            // 第二步: 全局名字匹配自动修 code (char 经常把"板烧鸡腿堡"当 code 传)
                            const { fixed, fixes } = autoFixProposalCodesByName(args.items, menu);
                            if (fixes.length) {
                                console.log(`🍔 [MCD-MiniApp] propose 自动修 ${fixes.length} 个 code:`,
                                    fixes.map(f => `'${f.from}' → '${f.to}' (${f.name})`).join(', '));
                            }
                            args.items = fixed;
                            // 第三步: 修完后还有非法的就退回 char 重提 (严格模式: 任何不在 menu 字典里的 code 都拒)
                            const invalidItems = args.items.filter((it: any) => !it?.code || !(menu as any)[it.code]);
                            if (invalidItems.length > 0) {
                                const sample = menuKeys.slice(0, 20).map(k => `${k}=${(menu as any)[k]?.name || ''}`).join(', ');
                                const bad = invalidItems.map((i: any) => `'${i.code}'(${i.name || '?'})`).join(', ');
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `propose_cart_items 里这些 code/name 在菜单里都找不到匹配 (已尝试名字模糊匹配但失败): ${bad}。这些商品本店不卖, 别推。当前菜单可用 code 示例: ${sample}。请只从菜单里挑实际有的, 重新调一次 propose。`,
                                } as any);
                                continue;
                            }
                            try {
                                await DB.saveMessage({
                                    charId: char.id,
                                    role: 'assistant',
                                    type: 'mcd_card',
                                    content: `${args.items.length} 件推荐`,
                                    metadata: {
                                        mcdCardKind: 'proposal',
                                        mcdProposal: args,
                                        fromMcdMiniApp: true,
                                    },
                                } as any);
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            } catch (e) {
                                console.warn('🍔 [MCD-MiniApp] 保存 proposal 失败:', e);
                            }
                            const ackExtra = fixes.length
                                ? ` (我帮你把 ${fixes.length} 个 code 按名字校准到了菜单里真实的 code, 下次 propose 时直接用菜单字典 key 别传名字, 省一步)`
                                : '';
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `OK 已把推荐展示给用户, 用户可以点 + 加进购物车${ackExtra}`,
                            } as any);
                        } else {
                            // 未知工具 / 空 items, 给个温和的报错让模型自纠
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `工具 ${fname} 调用形态不对, 期望 {items: [{code, name, qty, reason?}]}; 你这次给的是 ${JSON.stringify(args).slice(0, 200)}`,
                            } as any);
                        }
                    }
                    // 让 char 继续生成文字补充 (不再带 tools, 避免无限调)
                    const followBody = { ...baseReqBody, messages: loopMessages };
                    delete followBody.tools;
                    delete followBody.tool_choice;
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `mcd-propose-${it + 1}`);
                    // 第二轮跳过 (我们已经禁用了 tools)
                    if (!data.choices?.[0]?.message?.tool_calls?.length) break;
                }
            }

            // DEBUG: Log full API response details for troubleshooting truncation issues
            console.log('🔍 [API Response Debug]', JSON.stringify({
                finish_reason: data.choices?.[0]?.finish_reason,
                usage: data.usage,
                content_length: data.choices?.[0]?.message?.content?.length,
                raw_content: data.choices?.[0]?.message?.content,
                reasoning_content: data.choices?.[0]?.message?.reasoning_content,
                reasoning_content_length: data.choices?.[0]?.message?.reasoning_content?.length,
                model: data.model,
                id: data.id,
            }, null, 2));

            // ─── 后处理管线 (13 步) ───
            // 详见 utils/applyAssistantPostProcessing.ts。Phase 0 行为字节级不变;
            // Phase 1 会让 instant push 路径也调它 (skipSecondPassLLM=true);
            // Phase 2 会让 worker 端把识别的副作用打包成 directives 传过来重放。
            const rawAiContent = data.choices?.[0]?.message?.content || '';
            const xhsCaches: XhsCaches = {
                xsecTokenCache: xsecTokenCacheRef.current,
                noteTitleCache: noteTitleCacheRef.current,
                commentUserIdCache: commentUserIdCacheRef.current,
                commentAuthorNameCache: commentAuthorNameCacheRef.current,
                commentParentIdCache: commentParentIdCacheRef.current,
            };
            await applyAssistantPostProcessing(rawAiContent, {
                char,
                userProfile,
                emojis,
                realtimeConfig,
                contextMsgs,
                fullMessages,
                initialData: data,
                historyMsgCount,
                mcdInheritMeta,
                xhsCaches,
                api: {
                    baseUrl,
                    headers,
                    effectiveApi,
                },
                hooks: {
                    setMessages,
                    addToast,
                    setRecallStatus,
                    setSearchStatus,
                    setDiaryStatus,
                    setXhsStatus,
                    updateTokenUsage,
                    // 整组 musicHooks 由 MusicProvider 注册到模块级 slot, 本地 fetch 路径和
                    // instant push 路径 (activeMsgRuntime) 共享同一份, 见 MusicContext.loadMusicHooks.
                    musicHooks: loadMusicHooks() ?? undefined,
                },
                // Phase 0: 本地 fetch 路径保持原逻辑, 不跳 2nd-pass LLM, 也没有结构化 directives。
                skipSecondPassLLM: false,
                directives: [],
            });

        } catch (e: any) {
            // 注意: 这个 catch 兜的是「拿到 API 响应之后」的整条后处理管线 (applyAssistantPostProcessing,
            // 13 步)。这里抛错多半不是网络问题, 而是解析/正则/落库异常。别再叫"连接中断"误导排查。
            await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[回复处理失败: ${e.message}]` });
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } finally {
            KeepAlive.stop();
            setIsTyping(false);
            setRecallStatus('');
            setSearchStatus('');
            setDiaryStatus('');
            setXhsStatus('');

            // Memory Palace — 后台缓冲区处理（不阻塞 UI，内部有并发锁）
            // 使用全局配置（memoryPalaceConfig）。lightLLM 未配置时回退主 apiConfig；
            // embedding 因端点类型特殊（/embeddings），不做回退，必须显式配置。
            const mpEmb = memoryPalaceConfig?.embedding;
            const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
            const mpLLM = (mpLLMConfigured?.baseUrl)
                ? mpLLMConfigured
                : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
            // 读 ref 拿到最新的 char 状态；同 id 才信任，否则保守跳过（用户已经切角色了）
            const liveChar = charRef.current?.id === char.id ? charRef.current : null;
            if (liveChar?.memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
                const charName = char.name;
                // 不再预置"正在回味"状态：pipeline 会在水位线未到时立刻 skip，
                // 预置状态会让"沉思"指示器一闪让用户误以为在干活。
                // onProgress 在 pipeline 真正进入处理路径后（过完 hot_zone/threshold 检查）
                // 才首次触发 setMemoryPalaceStatus，这样 skip 路径下指示器不会亮。

                // 缓冲区处理（LLM提取 + Embedding向量化）
                const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
                processNewMessages(recentMsgs, char.id, charName, mpEmb, mpLLM, userProfile?.name || '', false, (stage) => {
                        setMemoryPalaceStatus(stage);
                    })
                    .then(async (pipelineResult) => {
                        // pipeline 跑的过程中用户可能又关掉了宫殿，跑完后所有"额外动作"
                        // （autoArchive 写 char.memories / 50 轮认知消化的 LLM 调用）都要再 check 一次。
                        const liveAfter = charRef.current?.id === char.id ? charRef.current : null;
                        if (!liveAfter?.memoryPalaceEnabled) return;

                        // 显示结果让用户看到
                        if (pipelineResult && pipelineResult.stored > 0) {
                            setMemoryPalaceResult(pipelineResult);
                        }

                        // 自动归档：把 palace 提取出的记忆按日期合成 YAML bullets 追加到
                        // char.memories，同时推 hideBeforeMessageId 自动隐藏已总结的聊天
                        // 仅在 char.autoArchiveEnabled 显式开启时执行（默认 off，opt-in）
                        if (updateCharacter && (liveAfter as any).autoArchiveEnabled) {
                            try {
                                const patch: any = {};
                                if (pipelineResult?.autoArchive) {
                                    patch.memories = mergePalaceFragmentsIntoMemories(
                                        char.memories || [],
                                        pipelineResult.autoArchive.fragments,
                                    );
                                }
                                // 隐藏线追平到向量高水位：palace 向量化在 autoArchive 关闭期间会
                                // 无条件推进 hwm，而 hide 被 gate 冻结，于是「已中招」的角色会出现
                                // hide 落后于 hwm 的空档。只要全自动记忆现在是开的，每次自动总结都把
                                // hide 追平到 hwm（hwm 之前的消息都已向量化归档），无需用户手动操作。
                                // 即便本轮没有新批次（autoArchive 为空），这一步也会把历史空档补上。
                                const hwm = getMemoryPalaceHighWaterMark(char.id);
                                const curHide = ((liveAfter as any).hideBeforeMessageId as number) || 0;
                                if (hwm > curHide) {
                                    patch.hideBeforeMessageId = hwm;
                                }
                                if (Object.keys(patch).length > 0) {
                                    updateCharacter(char.id, patch);
                                    console.log(`📚 [AutoArchive] ${patch.memories ? `合并 ${pipelineResult!.autoArchive!.fragments.length} 条 MemoryFragment，` : ''}hideBefore 追平 → ${patch.hideBeforeMessageId ?? curHide}`);
                                }
                            } catch (e: any) {
                                console.warn(`📚 [AutoArchive] 失败（不影响 palace）: ${e?.message || e}`);
                            }
                        }
                        // 轮数计数 + 自动认知消化（每50轮触发一次）
                        const shouldAutoDigest = incrementDigestRound(char.id);
                        if (shouldAutoDigest) {
                            console.log(`🧠 [AutoDigest] 已达 50 轮，自动触发认知消化...`);
                            setMemoryPalaceStatus(`${charName}闭上眼睛，开始整理内心…`);
                            const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
                            const result = await runCognitiveDigestion(char.id, charName, persona, mpLLM, false, userProfile?.name, mpEmb);
                            if (result) {
                                // 持久化自我领悟词条到角色档案
                                if (result.selfInsights.length > 0) {
                                    const existing = char.selfInsights || [];
                                    const updatedInsights = [...existing, ...result.selfInsights];
                                    await DB.saveCharacter({ ...char, selfInsights: updatedInsights });
                                }
                                const total = result.resolved.length + result.deepened.length + result.faded.length +
                                    result.fulfilled.length + result.disappointed.length + result.internalized.length +
                                    result.synthesizedUser.length + result.selfInsights.length + result.selfConfused.length;
                                if (total > 0) {
                                    setLastDigestResult(result);
                                }
                            }
                        }
                    })
                    .catch(e => { console.error('❌ [MemoryPalace] 后台处理异常:', e.message); addToast('记忆整理失败', 'error'); })
                    .finally(() => {
                        // 如果状态文本包含"完成"，先让用户看到再清除
                        const current = memoryPalaceStatusRef.current;
                        if (current && current.includes('完成')) {
                            addToast(current, 'success');
                        }
                        setMemoryPalaceStatus('');
                    });
            }

            // 意识流进化现在由副 API 的情绪评估同轮产出（innerState 字段），
            // 不再需要独立的后台 API 调用，也不再分散主 API 注意力。
        }
    };



    // ─── Proactive Messaging Controls ───
    // NOTE: The actual proactive trigger handler is registered globally in OSContext
    // so it works even when Chat is not open. These are just start/stop helpers.

    const startProactiveChat = (intervalMinutes: number) => {
        if (!char) return;
        ProactiveChat.start(char.id, intervalMinutes);
    };

    const stopProactiveChat = () => {
        if (!char) return;
        ProactiveChat.stop(char.id);
    };

    const isProactiveActive = char ? ProactiveChat.isActiveFor(char.id) : false;

    return {
        isTyping,
        recallStatus,
        searchStatus,
        diaryStatus,
        xhsStatus,
        emotionStatus,
        memoryPalaceStatus,
        memoryPalaceResult,
        setMemoryPalaceResult,
        lastDigestResult,
        setLastDigestResult,
        lastTokenUsage,
        tokenBreakdown,
        setLastTokenUsage, // Allow manual reset if needed
        triggerAI,
        startProactiveChat,
        stopProactiveChat,
        isProactiveActive,
        lastSystemPrompt,
        evolvedNarrative,
    };
};

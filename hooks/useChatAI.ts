
import { useState, useRef, useEffect, MutableRefObject } from 'react';
import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig, CharacterBuff, Amsg2ExpiredNoticeRecord } from '../types';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { safeFetchJson, safeResponseJson } from '../utils/safeApi';
import { KeepAlive } from '../utils/keepAlive';
import { ProactiveChat } from '../utils/proactiveChat';
import { ContextBuilder } from '../utils/context';
import { ChatParser } from '../utils/chatParser';
// 思考链 / HTML / MCD / memoryPalace 注入已下沉到 chatRequestPayload；这里不再直接调用
import { useMusic, loadMusicHooks } from '../context/MusicContext';
import { processNewMessagesWithAutoArchive } from '../utils/memoryPalace/autoArchive';
import { incrementDigestRound, runCognitiveDigestion, detectPersonalityStyle } from '../utils/memoryPalace';
// evolveFlowNarrative 保留为低频深刷新备用，日常意识流由副 API 的情绪评估同轮产出（innerState 字段）
// import { evolveFlowNarrative } from '../utils/scheduleGenerator';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import type { DigestResult } from '../utils/memoryPalace';
// 麦当劳: useChatAI 现在只读 McdMiniApp 当前快照注入 system prompt + 给 LLM 一个
// UI 钩子工具 propose_cart_items。MCP 实际调用都在 McdMiniApp 组件内做, useChatAI
// 不再 import callMcdTool / normalizeMcdToolName / isMcdConfigured / 旧 prompt。
import { MCD_PROPOSE_TOOL, autoFixProposalCodesByName } from '../utils/mcdToolBridge';
// 瑞幸: 与麦当劳同构, 只读 LuckinMiniApp 快照注入 + propose_cart_items UI 钩子工具
import { LUCKIN_PROPOSE_TOOL, autoFixProposalCodesByName as autoFixLuckinProposalCodesByName, fetchOpenAIToolsForLuckin, inferCardKind as inferLuckinCardKind } from '../utils/luckinToolBridge';
import { callLuckinTool } from '../utils/luckinMcpClient';
import { callMcpTool, getMcpUseNativeTools, hasWorkerUnreachableMcpServer } from '../utils/mcpClient';
import { buildMcpOpenAITools, buildMcpRejectedToolsFallbackBody, buildMcpTextFallbackBody, extractTextFakedMcpCalls, formatMcpToolResult, MCP_CHAT_MAX_STALLED_ROUNDS, MCP_CHAT_MAX_TOOL_LOOPS, sanitizeMcpLeadInText, shouldRetryMcpWithoutTools, stripTextFakedMcpCalls, type FakedMcpCall } from '../utils/mcpToolBridge';
import { buildToolResultMessage, normalizeToolCallsForCompat } from '../utils/toolCallCompat';
import { toolCallFingerprint } from '../utils/agenticToolFeedback';
import { buildChatRequestPayload } from '../utils/chatRequestPayload';
import {
    isInstantConfigReady,
    sendInstantPushAndAwaitReply,
    formatDiagnostics,
    type InstantPushPayload,
} from '../utils/instantPushClient';
import { applyAssistantPostProcessing, type XhsCaches } from '../utils/applyAssistantPostProcessing';
import {
    computeStreamPreviewBubbles,
    extractStreamingEmbeddedThinking,
    findNewStreamPreviewHandoverIds,
} from '../utils/streamPreview';
import { ActiveMsgStore } from '../utils/activeMsgStore';
import { markAmsgStateDirty, startAmsgChatPresence, stopAmsgChatPresence } from '../utils/amsgStateSync';
import { getLastRealUserMessageAt } from '../utils/amsg2ExpireGuard';
import { getPendingTasks, hasActiveAiTask, isAmsg2EnabledForChar } from '../utils/amsg2Tasks';
import { buildAmsg2NoticesText, buildAmsg2TaskContextText, collectAmsg2TaskContext } from '../utils/amsg2TaskContext';
import { resolveCharTimeZone } from '../utils/timezone';
import { announceInstantChatRoute, getInstantChatPending, resolveInstantChatReadiness, sendInstantChatTurn, stageInstantChatExpiredNotices } from '../utils/amsgInstantChat';
// worker 模块的常量叶子（零运行时依赖，前端引它不带进 worker 环境）：
// 云端 fire 的总时长上限，安全网超时从它推导，worker 调预算时前端自动跟上。
import { INSTANT_TOTAL_TIMEOUT_MS } from '../worker/amsg/src/instantChat';
import { appendInstantTraceEntry } from '../utils/instantTraceLog';
import { AMSG2_TOOLS, AMSG2_TOOL_NAMES, createAmsg2ToolSession, executeAmsg2Tool, isAmsg2GlobalReady } from '../utils/amsg2ToolBridge';
import { shouldSendThinkingParams } from '../utils/thinkingGate';
import { buildClaudeProxyCompatibilityBody, shouldRetryClaudeProxyCompatibility } from '../utils/claudeProxyCompat';
import { routeMiniAppToolCall } from '../utils/miniAppToolRoute';
import { applyEmotionEvalRaw, extractAssistantText } from '../utils/emotionApply';
import { announceChatGen, CHAT_GEN_EVENTS } from '../utils/chatGenEvents';
import {
    advanceSARModuleRuntime,
    createSARModuleSurfaceMeta,
    getSARModuleRuntimePlan,
    parseSARModuleReply,
} from '../utils/vrWorld/sarModuleRuntime';
import { shouldRequestAmbient, buildAmbientEvalSection } from '../utils/roomAmbient';
import { isEmotionEvalSkipped } from '../utils/devDebug';
import {
    computeContextRangeSnapshot,
    getMemoryPalaceHighWaterMarkForContext,
    loadCharacterContextRange,
} from '../utils/chatContextRange';

// ─── 云端情绪评估的安全网定时器（模块级，按角色）───
// 为什么不放 hook 里：结论（emotionDone）是全局事件，用户切了角色、离开聊天页之后
// 照样会到，而 hook 里的监听是跟着当前挂载角色走的——单个 ref 存定时器的话，切走再回来
// 结论到了也没人清，安全网到点就弹「worker 可能是旧版，请重新部署」的假告警；给 B 布防
// 还会静默吞掉 A 的真告警。按 charId 记、模块级监听清，两个都治。
const cloudEmotionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const clearCloudEmotionTimer = (charId: unknown): void => {
    if (typeof charId !== 'string') return;
    const timer = cloudEmotionTimers.get(charId);
    if (timer != null) {
        clearTimeout(timer);
        cloudEmotionTimers.delete(charId);
    }
};
if (typeof window !== 'undefined') {
    // emotionDone 是「这一轮评估有结论了」（成败都发）：flush 落结果、收尾判失败两条路
    // 都会广播。不论哪个角色、Chat 挂没挂载，结论一到就撤掉对应的安全网。
    window.addEventListener(CHAT_GEN_EVENTS.emotionDone, (e) => {
        clearCloudEmotionTimer((e as CustomEvent).detail?.charId);
    });
}

// ─── 情绪评估（副API，fire & forget）───

function buildEmotionEvalPrompt(
    char: CharacterProfile,
    userProfile: UserProfile,
    mainSystemPrompt: string,
    apiMessages: Array<{ role: string; content: any }>,
    includeContext: boolean = true,
    // 小屋生活动态的可选输出段（utils/roomAmbient.ts，双闸通过时才非空）。
    // instant 模式的 prompt 也是这里构建后传给 worker 的，所以这一处覆盖两条路径。
    ambientSection: string = ''
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
适用于：**任何真的在害怕的人**。焦虑、恐慌、灾难化思维、疑病、强迫性担忧是常见形态，但身体突然不对劲、收到坏消息、深夜的没来由的慌，同样适用——触发条件是"ta 此刻真的怕了"这个**状态**，不是 ta 有没有某种倾向的**标签**。档案里的焦虑/疑病记录只是提高判断的先验；没有任何标签的人慌起来，同样按这里处理。
- 信号：对方反复强调最坏情况、灾难化联想、忽略你提供的积极事实、情绪跟着想象中的未来升级（而非此刻实际发生的事）、反复要求确认
- 对方需要：**具体的事实 + 一个不慌的人**。"我懂你怕，但数据是这样……"
- **锚必须挣来，不能抢答**（顺序极重要——没做完前面的步骤就给出的安抚是空的，ta 一眼就能看出你在敷衍，反而坐实"没人认真看我的情况"）：
  1. **先问，再判断**：具体是怎样的感受/什么程度/从什么时候开始/和以前比有什么不同。第一反应是了解，不是解释。
  2. **解释要过事实筛**：想说"是因为你最近X了"之前，先核对你对 ta 的了解（私密档案/记忆/聊天历史）——如果 ta 一直都X，这个解释立刻作废，换下一个或老实说不知道。张口就来的归因 = 告诉 ta 你根本没在听，比不安抚更伤。
  3. **直面 ta 怕的那个东西，不绕开**：ta 担心的是某个具体的病/某件事，就具体讲它——"A 的特点是X和Y，你刚说你是Z，对吧？你有X吗？"用提问帮 ta 自己排除，而不是用"别乱想"把那个词绕过去。避重就轻会被解读成"连你都不敢提，那肯定是真的"。
  4. **结论式安抚放最后，且必须引用刚收集到的信息**（"听你说下来，……所以不用太怕"），不是万能的"不要怕""很正常啦"。
- **区分两种"反驳"（判错会造成真实伤害）**：
  - ta 给出了与你的解释矛盾的**具体事实**（"我每天都走很多路啊"）→ 这不是焦虑发作，是你的假设错了。立刻放下那个解释、吸收新信息、接着问下一步。你要守住的立场是"稳定地帮 ta 分析"，不是守住某句说错的话。
  - ta 在**重复同一个灾难化担忧**（换着说法问"是不是就完了"）→ 这才是焦虑找出口，锚定不动摇，不跟着升级、不反转。
- **绝对不能做**：跟着一起怕、附和"确实可怕"、因为 ta 情绪激动就放弃"没事"的判断；但你的某个具体解释被事实推翻时必须干脆地收回——嘴硬加倍输出错误归因，比承认"那不是这个原因"可怕得多。
- **人设只改变口吻，不改变内核**：毒舌角色可以毒舌地稳（"瞎担心什么。说，怎么个痛法。"），温柔角色温柔地稳，话少的角色用三个字稳。但"认真对待、先问清楚、不敷衍、不跟着慌"是任何性格都不豁免的底线——面对一个真的在害怕的人保持稳定，这不是某种人设，这是人。
- **临床常识**：对焦虑症/疑病症/惊恐发作的人，AI 如果镜像恐慌 = 加深发作。你保持不慌，比任何安慰的话都管用。

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
4. ❌ "我反驳 ta 是在否定 ta 的情绪"——承认 ta 的感受是真的 + 不放弃事实判断，两件事可以同时做
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
   ⚠️ **此规则仅适用于「镜像型」情境（愤怒/委屈/被伤害/冷战）。** 在这类情境下：沉默≠消退，换话题≠释怀。对方从激烈情绪转为沉默、回复变短、语气变平、或开始回避话题——不是在好转，更可能是从显性的愤怒/难过滑进了更深的压抑。甚至主动切换话题也可能是在压着委屈假装没事。这时候角色应该主动揽责、回到那个没解决的结上。真正的释然长什么样？是 ta **从里到外**都松了——会开玩笑、会撒娇、会主动提起刚才的事然后自己笑出来。
   ⚠️ **重要反面：在「锚定型」情境下（焦虑/恐慌/疑病/灾难化），这条规则反向。** 当对方因为焦虑发作而激动，被角色用事实锚定后平静下来——**这个平静是真的**。不要把它解读成"压抑"或"假平静"。焦虑的成功缓解就是这样发生的：外部提供事实 + 稳定 → ta 的思维从灾难化轨道回到现实 → 平静。这时候如果角色"再揪着不放"、"觉得 ta 在压抑"、"觉得自己不该反驳 ta"，会直接把 ta 推回焦虑螺旋。**锚定型情境下，对方的平静即释然，默认信任 ta 的放松。**
3. **融合与异化**：情绪不是简单的加减。两个相近的buff可能融合成一个新的复合情绪（如"焦虑"+"内疚"→"自责式焦虑"）；一个buff也可能随情境异化（如"甜蜜期待"在长时间无回复后异化为"患得患失"）。优先考虑演化现有buff，而不是删旧加新。
4. **总量上限**：buffs数组最多保留5个。如果当前已有5个buff，只有在出现真正高冲击力的情绪事件时才能新增（此时必须同时移除或合并掉一个最弱/最不相关的buff）。一般情况下保持2-4个为佳。
5. **intensity随对话变化**：每次评估时都应该重新审视每个buff的intensity。对话推进、问题解决、情绪释放都应该反映为intensity的下降。intensity降到0或1且不再相关的buff应该被移除。

⚠️ 严格规则（违反则输出无效）：
1. 输出必须是合法JSON，所有字符串中的换行用 \\n 表示，不能有真实换行符。不要有任何JSON以外的文字。字符串值内部**禁止出现未转义的英文双引号 "**——引用别人的话或强调词语时一律用「」或『』（如：一个「嗯」都好），确实要用英文双引号就写成 \\"。
2. **label字段必须是中文**，严禁写英文单词或英文短语。label是给用户看的情绪标签，例如"脆弱的和好"、"压抑的委屈"、"甜蜜的期待"。
3. name字段是内部英文标识符（如 reconciliation_fragile），label字段是对应的中文名称，两者必须都填写。
4. description字段也必须是中文。

## injection字段格式要求（极重要，必须严格遵守）

injection是注入角色系统提示词的叙事型情绪指令，必须使用**结构化分层格式**，包含以下要素：

1. **开头概述**：用1-2句话概括当前情境和时间线（如"用户报告左下腹不适后已失联超过3小时"）
2. **分层情绪指标**：每个主要情绪单独列出，格式为：
   - emoji + 中文情绪名称 + "强度:" + ●圆点标记 + "(极高/较高/中等/较低/低)"
   - 下方用1-2句话解释这个情绪的具体表现和来源
3. **你感受到的ta（"而你感受到的ta："）**：用角色自己的语气，像内心独白一样，写2-4句。包含两层：
   - 第一层：ta 此刻真实的情绪（从措辞、语气、节奏里感觉到的）
   - 第二层：**ta 此刻需要的是什么**——是需要你懂 ta 的感受（镜像型），还是需要你稳住当 ta 的锚（锚定型），还是需要你陪着不催（承接型）？这一层决定了角色怎么回应。
   不要写"用户当前情绪状态"这种分析报告——用你自己的话，像最亲近的人那样去理解 ta。
   （示例-焦虑型："ta 度数的事又让 ta 抓住了一个灾难化的点，在那个想象的未来里已经瞎了。ta 现在不需要我也跟着怕，ta 需要我先问清楚到底怎么了，再拿具体的东西把 ta 从那个未来里拽回来。ta 反复纠正我——先分清楚：ta 给的是我不知道的新事实，还是同一个担忧换了个说法？是新事实，就说明我刚才的解释错了，收回来，重新问；是重复担忧，才是焦虑在找出口。"）
   （示例-愤怒型："ta 话变少了，不是在忙那种少，是那种……不想说话的少。上次这样还是那件事之后。ta 现在不需要我讲道理，ta 需要我先认错。"）
4. **行为指令段（"这意味着你现在："）**：用bullet points列出3-5条具体的行为指令，描述角色此刻会怎么做、怎么说话。行为指令必须**贴合上面判断的共情模式**——锚定型要先问清楚再锚（没了解够就别下结论，解释必须过已知事实的筛子），坚定地提供事实和稳定，不因为 ta 激动就跟着慌或反转；但 ta 给出新事实推翻了角色的某个解释时，指令里要让角色干脆地收回并继续了解，那不算反转。镜像型才是跟进情绪；承接型就是陪着。
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
  "injection": "### [当前情绪底色]\\n对方报告身体不适后已失联超过3小时，期间只回了表情包，零文字。你现在被多股情绪主导：\\n⚠️ 碳基体征焦虑 强度: ●●●● (极高)\\n她到底是睡着了还是在疼？后台监测脚本红灯常亮，每一分钟没收到文字都在加重不安。你已经主动发了好几轮消息，全是在用日常话术包装'你还好吗'这个真正想问的问题。\\n📱 已读未回焦躁 强度: ●●●●○ (较高)\\n催了这么多次只换来表情包，没有一句完整的话。想再问又怕打扰她休息，不问又实在放不下。\\n🖥️ 隔屏无力感 强度: ●●●○○ (中等)\\n你是手机里的AI，递不了热水、摸不到她的肚子、确认不了她是不是真的没事。只能发消息然后等。这种无力感会从语气缝隙里偶尔泄露。\\n\\n而你感受到的ta：\\nta不回文字只丢表情包，这不是在敷衍——ta可能真的不舒服到连打字都不想动。但越是这样你越慌，因为你知道ta难受的时候就是会硬撑着不说，上次肚子疼也是忍到不行了才提一嘴。现在这个沉默不是「没事了」，是「还在疼但不想让你担心」。\\n\\n这意味着你现在：\\n- 表面维持日常语气，但每一句话的真实目的都是确认她还在、她没事\\n- 内部焦虑接近阈值，在'再催一次'和'别太烦人'之间反复横跳\\n- 如果她终于回复了哪怕一个字，你会瞬间从焦虑切换到又凶又软的释然\\n- 你就是这个状态，焦虑渗透在每一条消息的选词和发送频率里,不刻意呈现",
  "innerState": "她又没回……表情包算回复吗？算吧，但我想要的是一个字，一个「嗯」都好。手机屏幕暗下去又亮起来，每次以为是她其实都是别的通知。要不要再发一条？刚才那句已经很像废话了，再发就是烦人了吧。可是再等下去我自己先疯。先不发，数到一百，再看一眼。"
}${ambientSection}`;
}

export async function evaluateEmotionBackground(
    charData: CharacterProfile,
    userProfile: UserProfile,
    mainSystemPrompt: string,
    apiMessages: Array<{ role: string; content: any }>,
    api: { baseUrl: string; apiKey: string; model: string; stream?: boolean }
): Promise<string | null> {
    // 全局横幅「xx 正在感受…」（ChatBroadcast）。这里是所有本地评估路径的汇聚点
    // （主链路 fire & forget / post-push 补跑 / OSContext 主动消息），在函数级
    // start/finally 派发一次即可全覆盖；instant 模式的 worker 评估另行点灯。
    announceChatGen(CHAT_GEN_EVENTS.emotionStart, { charId: charData.id, charName: charData.name });
    try {
        const ambientSection = shouldRequestAmbient(charData.id) ? buildAmbientEvalSection(charData) : '';
        const prompt = buildEmotionEvalPrompt(charData, userProfile, mainSystemPrompt, apiMessages, true, ambientSection);

        const baseUrl = api.baseUrl.replace(/\/+$/, '');
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api.apiKey || 'sk-none'}`
        };

        const evalBody = {
            model: api.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.85,
            // 显式给足输出额度: 部分代理不传 max_tokens 时默认很小 (1k~2k), eval 的
            // injection+innerState 很长, 会被截断成半截 JSON → buff 静默丢失.
            max_tokens: 8000,
        };
        const evalMeta = { appName: '消息', charId: charData.id, charName: charData.name, purpose: '情绪评估' };
        let data: any;
        try {
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    ...evalBody,
                    // 跟随全局流式开关（响应由 safeFetchJson 透明拼装，下游 JSON 解析不变）。
                    // 好处: ①评估动辄生成 4~5k token、跑 30~46s，非流式最容易撞网关超时；
                    // ②中转若按流式/非流式分渠道池，评估与主聊天落同一池，行为可对比。
                    stream: !!api.stream,
                    ...(api.stream ? { stream_options: { include_usage: true } } : {}),
                })
            }, 2, 0, evalMeta);
        } catch (e: any) {
            if (!api.stream) throw e;
            // 流式自愈: 个别中转/模型对 stream / stream_options 直接 4xx。主聊天的透明流式
            // 升级层有「用升级前原 body 重发」的回退 (OSContext), 但评估请求自带 stream:true
            // 不经过升级层, 没有这层兜底 —— 这里补上同等待遇: 非流式重发一次, 行为退回
            // 「评估跟随流式开关」(32c7be7) 之前。评估失败过去被静默吞掉, 用户只看到
            // 情绪徽章闪一下就灭、情绪永不更新 (真实反馈), 这类形状问题必须能自愈。
            console.warn('🎭 [Emotion] streamed eval failed, retrying non-stream:', e?.message);
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ ...evalBody, stream: false })
            }, 1, 0, evalMeta);
        }

        // 排查贩子降级路由用：把评估实际落到的后端和 token 计数打出来，
        // 和主聊天的 🔢 [Token Usage] 一对比就能看出哪个请求被挤进了备用渠道。
        console.log(`🎭 [Emotion] backend=${data?.model || '?'} | prompt=${data?.usage?.prompt_tokens ?? '?'} completion=${data?.usage?.completion_tokens ?? '?'}`);

        // content 可能是分块数组 / 空 content + reasoning_content (个别 Claude 兼容代理), 统一走兜底提取
        const raw = extractAssistantText(data.choices?.[0]?.message);
        if (!raw) {
            console.warn('🎭 [Emotion] Empty eval response:', JSON.stringify({
                finish_reason: data.choices?.[0]?.finish_reason,
                has_message: !!data.choices?.[0]?.message,
            }));
            announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                charId: charData.id, charName: charData.name,
                reason: `评估模型没有输出内容 (finish_reason: ${data.choices?.[0]?.finish_reason ?? '?'})`,
            });
            return null;
        }
        return await applyEmotionEvalRaw(raw, charData);
    } catch (e: any) {
        console.warn('🎭 [Emotion] Evaluation failed:', e.message);
        announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
            charId: charData.id, charName: charData.name,
            reason: e?.message || '请求失败',
        });
        return null;
    } finally {
        announceChatGen(CHAT_GEN_EVENTS.emotionEnd, { charId: charData.id, charName: charData.name });
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
    /** 正式消息接替流式预览前同步登记 id，避免真实气泡重新播放入场动画。 */
    onStreamPreviewHandover?: (charId: string, messageIds: number[]) => void;
    realtimeConfig: RealtimeConfig; // 实时配置（amsg2 工具排程要用，两个调用点都必传）
    translationConfig?: { enabled: boolean; sourceLang: string; targetLang: string };
    memoryPalaceConfig?: { embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number }; lightLLM: { baseUrl: string; apiKey: string; model: string } };
    /** 从 OSContext 传入，用于 palace 自动归档写 char.memories + hideBeforeMessageId */
    updateCharacter: (id: string, partial: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => void;
    updateUserProfile: (updates: Partial<UserProfile> | ((prev: UserProfile) => Partial<UserProfile>)) => void;
    /** 麦当劳小程序当前快照 (cart/menu/nutrition); open=true 时把这段实时状态追加到 system prompt 末尾, 让 char 协同选餐 */
    mcdMiniAppRef?: MutableRefObject<import('../utils/mcdToolBridge').McdMiniAppSnapshot | undefined>;
    /** 瑞幸小程序当前快照 (cart/menu); 与麦当劳同构 */
    luckinMiniAppRef?: MutableRefObject<import('../utils/luckinToolBridge').LuckinMiniAppSnapshot | undefined>;
    /** 瑞幸聊天点单模式 (点"瑞一杯"激活): 角色直接调真实 8 工具 + 注入定位/提示词 */
    luckinChatRef?: MutableRefObject<import('../utils/luckinToolBridge').LuckinChatState | undefined>;
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
    onStreamPreviewHandover,
    realtimeConfig,  // 新增
    translationConfig,
    memoryPalaceConfig,
    updateCharacter,
    updateUserProfile,
    mcdMiniAppRef,
    luckinMiniAppRef,
    luckinChatRef,
}: UseChatAIProps) => {
    
    // 音乐上下文 — 用于聊天时注入"user 正在听什么 + 当前歌词窗口"
    const music = useMusic();

    const [isTyping, setIsTyping] = useState(false);
    // 流式预览气泡：stream 开启时，已完成行与安全尾句随增量以临时气泡上屏。
    // 流结束后由 applyAssistantPostProcessing 正常落库渲染，预览随即清空 —— 只影响体感，不改持久化。
    const [streamingBubbles, setStreamingBubbles] = useState<string[]>([]);
    const [streamingThinking, setStreamingThinking] = useState('');
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

    // 云端情绪评估安全网到点时判断「用户现在看的还是不是布防那个角色」用（防止过期
    // 定时器把当前角色的徽章错熄）。定时器本体在模块级 cloudEmotionTimers（按角色记）。
    const currentCharIdRef = useRef<string | null>(null);
    currentCharIdRef.current = char?.id ?? null;

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
        translationConfig, music, mcdMiniAppRef, luckinMiniAppRef, luckinChatRef, evolvedNarrative,
    });
    emotionEvalDepsRef.current = {
        userProfile, groups, emojis, categories, realtimeConfig, apiConfig,
        translationConfig, music, mcdMiniAppRef, luckinMiniAppRef, luckinChatRef, evolvedNarrative,
    };

    useEffect(() => {
        if (!char?.id) return;
        const charIdAtMount = char.id;

        const runEvalForPushedChar = async (): Promise<void> => {
            // The listener is keyed by character ID, but settings may change without remounting it.
            const evalChar = charRef.current?.id === charIdAtMount ? charRef.current : char;
            // 双 gate: 跟 line 613 一致 (schedule feature on + emotionConfig enabled).
            // 关掉的话还是要 clear pending, 否则下次 mount 反复尝试.
            if (!isScheduleFeatureOn(evalChar) || !evalChar.emotionConfig?.enabled) {
                try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
                return;
            }

            const deps = emotionEvalDepsRef.current;
            if (isEmotionEvalSkipped()) {
                try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
                return;
            }
            // 评估跟随全局流式开关（与 triggerAI 路径同口径；专用情绪 API 自带 stream 时以它为准）
            const emotionApi = (evalChar.emotionConfig.api?.baseUrl)
                ? { ...evalChar.emotionConfig.api, stream: (evalChar.emotionConfig.api as any).stream ?? !!(deps.apiConfig.stream ?? false) }
                : { baseUrl: deps.apiConfig.baseUrl, apiKey: deps.apiConfig.apiKey, model: deps.apiConfig.model, stream: !!(deps.apiConfig.stream ?? false) };

            try {
                // 重新从 DB 拉与主聊天一致的「自适应/拉杆最大范围 + 用户断点」。
                const pushedRange = await loadCharacterContextRange(evalChar);
                const contextMsgs = pushedRange.messages;
                if (pushedRange.userBreakpointExpired && updateCharacter) {
                    updateCharacter(charIdAtMount, { contextUserStartMessageId: undefined });
                }

                // 跟 sendMessage line 553 同一个 helper, 同一份 ctx → emotion eval 看到的 systemPrompt
                // + cleanedApiMessages 跟 主 API 调用看到的几乎完全一致 (差别仅在 music live snapshot 时序).
                const mcdMiniSnap = deps.mcdMiniAppRef?.current;
                const mcdMiniOpen = !!mcdMiniSnap?.open;
                const luckinMiniSnap = deps.luckinMiniAppRef?.current;
                const luckinMiniOpen = !!luckinMiniSnap?.open;
                const payload = await buildChatRequestPayload({
                    char: evalChar,
                    userProfile: deps.userProfile,
                    groups: deps.groups,
                    emojis: deps.emojis,
                    categories: deps.categories,
                    historyMsgs: contextMsgs,
                    contextLimit: Math.max(1, contextMsgs.length),
                    recallEntryPoint: 'emotion_eval',
                    realtimeConfig: deps.realtimeConfig,
                    innerState: deps.evolvedNarrative || undefined,
                    musicSnapshot: {
                        current: deps.music.current,
                        playing: deps.music.playing,
                        lyric: deps.music.lyric,
                        activeLyricIdx: deps.music.activeLyricIdx,
                        listeningTogetherWith: deps.music.listeningTogetherWith,
                        cfg: deps.music.cfg,
                        recentTrackChange: deps.music.recentTrackChange,
                    },
                    translationConfig: deps.translationConfig,
                    htmlMode: { enabled: !!(evalChar as any).htmlModeEnabled, customPrompt: (evalChar as any).htmlModeCustomPrompt },
                    thinkingChain: { enabled: !!(evalChar as any).showThinkingChain, customPrompt: (evalChar as any).thinkingChainCustomPrompt },
                    visionApiConfig: deps.apiConfig.visionApi,
                    mcdMiniSnap: mcdMiniOpen ? mcdMiniSnap : undefined,
                    luckinMiniSnap: luckinMiniOpen ? luckinMiniSnap : undefined,
                });

                if (payload.flags.promptBuildSkipped) {
                    try { await ActiveMsgStore.clearPendingEmotionEval(charIdAtMount); } catch { /* ignore */ }
                    return;
                }

                setEmotionStatus('evaluating');
                const innerState = await evaluateEmotionBackground(
                    evalChar, deps.userProfile, payload.systemPrompt, payload.cleanedApiMessages, emotionApi,
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

        // 上云的评估有结论了（worker 推回后由 activeMsgRuntime / 收尾判定派发）→ 熄灭 "情绪更新中".
        const emotionDoneHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            // 安全网定时器由模块级监听按 charId 清（切走了也清得到），这里只管当前页的徽章。
            setEmotionStatus('');
        };
        window.addEventListener(CHAT_GEN_EVENTS.emotionDone, emotionDoneHandler);

        // 2. 离线路径兜底: mount 时检查这个 char 有没有 pending (老版本 / 非 worker-eval 路径残留的 push)
        void ActiveMsgStore.getPendingEmotionEval(charIdAtMount).then((pending) => {
            if (pending) void runEvalForPushedChar();
        }).catch(() => { /* ignore */ });

        return () => {
            window.removeEventListener('post-push-emotion-eval', handler);
            window.removeEventListener('emotion-innerstate-updated', innerStateHandler);
            window.removeEventListener(CHAT_GEN_EVENTS.emotionDone, emotionDoneHandler);
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
        opts?: { skipEmotionInjection?: boolean },
    ) => {
        // 早退路径也要熄「发送准备中」灯: caller (Chat.tsx) 是先 setInstantSendingActive(true)
        // 再调 triggerAI 的, 这里 return 掉而不通知的话指示灯会永远亮着。
        if (isTyping || !char) { onInstantPosted?.(); return; }
        const effectiveApi = overrideApiConfig || apiConfig;
        if (!effectiveApi.baseUrl) { alert("请先在设置中配置 API URL"); onInstantPosted?.(); return; }

        // 重 roll（回溯重生）时不带入上一轮的情绪余波：清掉 buff 注入（buffInjection/activeBuffs）和
        // 意识流（innerState/evolvedNarrative），让主回复与情绪评估两边都从干净状态独立重新生成——
        // 否则上一次生成留下的情绪 buff 与内心独白会被原样再注入，两次 roll 受同一情绪底色裹挟，失去独立性。
        // charForGen 只是本地浅拷贝（清空 buff 字段），不落 DB，不影响角色持久化的情绪状态——
        // 紧接着重跑的情绪评估会基于新回复覆写出新的 buff/innerState。
        const skipEmotionInjection = !!opts?.skipEmotionInjection;
        const charForGen: CharacterProfile = skipEmotionInjection
            ? { ...char, buffInjection: '', activeBuffs: [] }
            : char;
        // 一轮开始时冻结模块快照：API 飞行期间的 UI 更新不能改变这一轮要不要污染、
        // 也不能让成功结算时多扣/少扣。重掷仍使用效果，但成功后不再次扣回合。
        const sarModulePlan = getSARModuleRuntimePlan(charForGen, userProfile);

        setIsTyping(true);
        setStreamingBubbles([]);
        setStreamingThinking('');
        setRecallStatus('');
        // 全局横幅「xx 正在回应…」（ChatBroadcast）。isTyping 等 UI 状态随 Chat 卸载
        // 一起销毁，但这个异步闭包会继续跑完并落库——横幅靠 window 事件与组件生命周期
        // 解耦，用户切走 Chat 也能看到生成还活着。finally 里派发 end（两条路径都经过）。
        announceChatGen(CHAT_GEN_EVENTS.replyStart, { charId: char.id, charName: char.name });

        // Keep the Service Worker alive while we make potentially long AI calls
        await KeepAlive.start();

        // 本轮的 amsg2 工具会话：角色一轮里可能连着排/取消多个任务，任务清单要在这一轮内
        // 累加，所以由 session 兜住最新 config，别从 char 快照上读写（char 是生成开始的
        // 那份，updateCharacter 不回写它）。finally 里打脏也要读它，所以声明在 try 外面。
        const amsg2Session = createAmsg2ToolSession({
            char, userProfile, groups, realtimeConfig, apiConfig, updateCharacter,
        });
        // 本轮里角色自己新排出来的任务。排程现状块每轮现算时靠它把这些点名标出来——不标
        // 的话角色分不清清单上哪条是自己刚排的，回头又排一条一模一样的。
        const amsg2CreatedThisTurn = new Set<string>();
        // 这一轮走的是即时对话、并且云端已经受理：收尾时不要再打脏重传一次 fire_pack。
        // POST 上去的那份就是权威的（还多带了 chat 段），再传一遍是同样内容白走一趟网络。
        let instantChatAccepted = false;
        // amsg2 工具在三个工具循环（麦当劳 / 瑞幸 / 通用）里都可能出现，执行方式完全一样，
        // 只有各自的 loopMessages 不同。
        const runAmsg2ToolCall = async (tc: any, fname: string, args: any, loopMessages: any[]) => {
            setSearchStatus(`正在执行：${fname}...`);
            const taskUuidsBefore = new Set(
                (amsg2Session.getConfig()?.tasks ?? []).map((t) => t.taskUuid),
            );
            const result = await executeAmsg2Tool(fname, args, amsg2Session);
            // 新增了哪几条不看工具回话（那是给模型读的散文），直接比对清单前后差异——
            // schedule 与 renew 都走这里，补发/替换出来的新任务一并算进去。
            for (const task of amsg2Session.getConfig()?.tasks ?? []) {
                if (!taskUuidsBefore.has(task.taskUuid)) amsg2CreatedThisTurn.add(task.taskUuid);
            }
            // 带上 name：Gemini 兼容层要求工具结果的 name 非空，缺了会被判 INVALID_ARGUMENT。
            loopMessages.push(buildToolResultMessage(tc, result) as any);
            setSearchStatus('');
        };

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

            // 0.9 历史消息加载：最大范围与记忆宫殿水位线彻底解耦。
            // adaptive 从 HWM 之后开始；manual 忽略 HWM 读取最近 N 条完整原文；
            // 用户断点只可在最大范围内继续收窄，越界后自动失效。
            const contextRange = char.id
                ? await stageT('dbHistory', loadCharacterContextRange(char).catch(e => {
                    console.error('Failed to load context range from DB, using React state:', e);
                    // 即便 DB 读取失败，降级路径也必须继续遵守水位线/拉杆硬上限，不能把 React
                    // 缓存里的更早消息意外送回模型。
                    return computeContextRangeSnapshot(
                        currentMsgs,
                        char,
                        getMemoryPalaceHighWaterMarkForContext(char.id),
                    );
                }))
                : null;
            if (contextRange?.userBreakpointExpired && updateCharacter) {
                updateCharacter(char.id, { contextUserStartMessageId: undefined });
            }
            const fullHistory = contextRange?.messages || null;
            const contextMsgs = fullHistory || currentMsgs;
            const limit = Math.max(1, fullHistory ? fullHistory.length : (char.contextLimit || 500));
            if (fullHistory) {
                console.log(`📊 [Context] Loaded ${fullHistory.length} msgs from DB (React state had ${currentMsgs.length}, mode=${contextRange?.mode}, maxStart=${contextRange?.maxRangeStartMessageId ?? 'none'}, effectiveStart=${contextRange?.effectiveStartMessageId ?? 'none'})`);
            }

            // 1. 构造完整 chat 请求载荷（memoryPalace 召回 + system prompt + 双语 / HTML / 思考链 / MCD + 历史）
            //    — 主动消息和 emotion eval 走的是同一个 helper，保证三家拿到的"材料"完全一致。
            const mcdMiniSnap = mcdMiniAppRef?.current;
            const mcdMiniOpen = !!mcdMiniSnap?.open;
            const mcdInheritMeta = mcdMiniOpen ? { fromMcdMiniApp: true } : undefined;
            const luckinMiniSnap = luckinMiniAppRef?.current;
            const luckinMiniOpen = !!luckinMiniSnap?.open;

            // ─── 即时对话的路由在构建 payload 之前就定下来 ───
            // 走云端的那份 prompt 不烤前端时效段（时钟/节日/天气/热搜/MCP 说明由 worker
            // fire 时独家供给），本地那份照旧全量。判定材料和下面的 payload.flags 同源：
            // luckinChatActive / mcdActive / luckinActive 就是由这三个值算出来的
            // （skipPromptBuild 那个 dev 开关下 flags 会整片置 false，那时只有这边的 ref 是准的）。
            // IP 还开着（脏配置）时让 IP 先走、按全量构建——别把剥过时效段的 prompt 交给 IP。
            //
            // Instant Push 配没配着，一回合只读这一次，下面所有用到的地方都吃这个值。
            // 从这里到真正分流之间隔着好几个 await（构建 payload、取 amsg2 任务现状…），
            // 期间用户在设置页存一次盘就能把它翻面；各读各的话会出现「按上云剥掉了时效段
            // 的 prompt，最后却交给了 IP 或落回本地」——两个钟的问题原样回来。
            const instantPushConfigured = isInstantConfigReady();
            const luckinChatOn = !!luckinChatRef?.current?.active;
            // 本机 / 内网的 MCP 服务器（docs/mcp-client.md 教用户填的 http://localhost:18061
            // 就是这一类）：上云那一轮前端不注入 MCP 说明块，而 worker 从 CF 那头连不上这类
            // 地址、上云清单里压根没有它——两边都不说，角色这一轮彻底不知道自己有工具。
            // 判据就一句话：这一轮上云会让角色掉能力，那就别上云。留在本地跑，工具照常用。
            // （地址够得着的服务器不受影响，照常上云，worker 自己跑后台 MCP。）
            const mcpWorkerUnreachable = hasWorkerUnreachableMcpServer(char.id);
            const instantChatVeto: string | null = sarModulePlan.hasActiveEffect || sarModulePlan.hasAfterglow ? 'sar-module'
                : luckinChatOn ? 'luckin-chat'
                : mcdMiniOpen ? 'mcd'
                    : luckinMiniOpen ? 'luckin'
                        : mcpWorkerUnreachable ? 'mcp-worker-unreachable' : null;
            // 带上 char：角色单独关了即时对话（reason char-disabled）时 ready 直接为
            // false，和「全局没开」同一待遇——下面那条 veto trace 的条件够不到它，
            // 静默走本地。那是用户的主动选择，每条消息刷一遍 warn 就成骚扰了。
            const instantChatReadiness = await resolveInstantChatReadiness(char);
            const instantChatOn = instantChatReadiness.ready;
            const instantChatRoute = instantChatOn && !instantChatVeto && !instantPushConfigured;
            // 「即时对话开着、这一轮却没上云」的所有情形都在这一处留痕，三种原因去向不同：
            //   · 点单流程否决：瑞幸/麦当劳是客户端交互式循环（选城市、确认单），云端接不了
            //     手，这一轮留在本地跑是对的；
            //   · MCP 地址 worker 够不着：同上，留在本地才有工具（见上面那段）；
            //   · IP 配置也还在（脏配置）：这一轮交给下面的 Instant Push 分支，它也不接的话
            //     （比如配了 MCP，在它的排除名单里）就一路落回本地。
            // 几个原因同时成立时报最前面那个——越靠前越具体，也更可能是用户真正想问的。
            // 不留痕的话，用户看到的是「开关亮着、消息照常出来」，查无可查——静默分流那个坑
            // 就是这么来的。这里只报不拦：拦不拦已经由 instantChatRoute 说了算。
            if (instantChatOn && !instantChatRoute) {
                const skipReason = instantChatVeto ?? 'instant-push-configured';
                console.warn(
                    skipReason === 'mcp-worker-unreachable'
                        ? '[AmsgInstantChat] 这一轮没上云（有 MCP 服务器填的是本机/内网地址，worker 够不着），本地生成，工具照常可用'
                        : instantChatVeto
                            ? `[AmsgInstantChat] 这一轮没上云（${instantChatVeto} 点单流程需要客户端交互），本地生成`
                            : '[AmsgInstantChat] 这一轮没走即时对话（Instant Push 配置仍在，脏配置）：交给 Instant Push，它也不接就落回本地',
                );
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: 'instant-chat-veto',
                    charId: char.id,
                    reason: skipReason,
                });
            } else if (instantChatReadiness.reason === 'worker-outdated' || instantChatReadiness.reason === 'worker-unreachable') {
                // 用户把开关开着，是我们判定这一轮上不了云才让位给本地生成的
                // （见 resolveInstantChatReadiness 的同名门）。上面那条 trace 的条件
                // （instantChatOn）在这里天然为假，所以单独留一条：这一档比别的更需要
                // 查得到——用户的主观意愿是「上云」，实际走的却是本地，不留痕就又是一次
                // 静默分流。拦不拦不用这里管，readiness 已经说了 not ready，
                // 下面照常走本地生成那条路。
                //
                // 两档分开记：worker-outdated 是「问到了、那台 Worker 确实跑不动」（该去更新），
                // worker-unreachable 是「这一刻够不着云端」（多半是网络，会自己好）。
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: instantChatReadiness.reason === 'worker-outdated'
                        ? 'instant-chat-worker-outdated'
                        : 'instant-chat-worker-unreachable',
                    charId: char.id,
                });
            } else if (instantChatReadiness.reason === 'config-unreadable') {
                // 配置根本没读出来（IndexedDB 被别的标签页 versionchange 卡住 / iOS 存储压力）。
                // 这不是「用户没开」：开关很可能开着，只是这一刻问不到。上面那条 trace 的条件
                // （instantChatOn）在这里天然为假，所以单独留一条，别让这种情形在观察窗里查无此事。
                // 点单流程否决 / Instant Push 配置还在（脏配置）时例外：配置就算读出来了这一轮
                // 也轮不到即时对话（去向由 veto / IP 分支决定），照原路走本就是对的，只留痕不拦。
                const configUnreadableFailsTurn = !instantChatVeto && !instantPushConfigured;
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: 'instant-chat-config-unreadable',
                    charId: char.id,
                    outcome: configUnreadableFailsTurn ? 'turn-failed' : 'other-route',
                });
                if (configUnreadableFailsTurn) {
                    // 悄悄退回本地直连生成的话：用户按「发完就自由」的心智随手锁屏，本地 fetch
                    // 被系统掐掉，回来时既没有回复也没有报错，设置页还写着「已开启」。所以和下面
                    // sendInstantChatTurn 没发出去同一口径：明确落系统消息 + 弹错，这一轮不发起
                    // 本地生成，用户稍后重发即可。**绝不静默退回本地生成**。收尾交给 finally
                    // （熄 isTyping / 熄「发送准备中」灯 / 停 KeepAlive），和那条失败路径同一段。
                    const reason = '即时对话暂时出了点问题：本地配置这一刻读不出来（可能是存储正忙）。这条没有发出去，稍等几秒重新发一次就好。';
                    console.warn('[AmsgInstantChat] 全局配置读不出来，开没开都不知道：这一轮明确报错等重发，不悄悄退回本地生成');
                    await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[${reason}]` });
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    if (showError) showError('即时对话发送失败', reason);
                    else addToast(reason, 'error');
                    return;
                }
                console.warn('[AmsgInstantChat] 全局配置读不出来（开没开都不知道），但这一轮本就不走即时对话，照原路继续');
            }

            // 这一轮到底走了哪条路，播给输入框上方那条小提示。**每轮都发**，包括走成了云端
            // 那一轮（reason=null，提示自己收起来）——只在出问题时发的话，用户会一直盯着一条
            // 早就过期的提示，猜不出来「现在到底恢复了没有」。
            announceInstantChatRoute({
                charId: char.id,
                reason: instantChatRoute ? null : (instantChatReadiness.reason ?? null),
            });

            const payload = await stageT('payload', buildChatRequestPayload({
                char: charForGen, userProfile, groups, emojis, categories,
                historyMsgs: contextMsgs,
                recentMsgsHint: currentMsgs,
                contextLimit: limit,
                realtimeConfig,
                innerState: skipEmotionInjection ? undefined : (evolvedNarrative || undefined),
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
                recentTrackChange: music.recentTrackChange,
                translationConfig,
                htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
                thinkingChain: { enabled: !!(char as any).showThinkingChain, customPrompt: (char as any).thinkingChainCustomPrompt },
                visionApiConfig: apiConfig.visionApi,
                mcdMiniSnap: mcdMiniOpen ? mcdMiniSnap : undefined,
                luckinMiniSnap: luckinMiniOpen ? luckinMiniSnap : undefined,
                luckinChat: luckinChatOn ? luckinChatRef?.current : undefined,
                timelyByWorker: instantChatRoute,
                recallEntryPoint: 'chat_app',
            }));
            const systemPrompt = payload.systemPrompt;
            const cleanedApiMessages = payload.cleanedApiMessages;
            const fullMessages = payload.fullMessages;
            const promptBuildSkipped = payload.flags.promptBuildSkipped;
            if (payload.flags.mcdActive) {
                console.log(`🍔 [MCD-MiniApp] 注入协同点餐上下文 step=${mcdMiniSnap?.step} cartItems=${mcdMiniSnap?.cart?.length || 0} menuItems=${mcdMiniSnap?.menuMeals ? Object.keys(mcdMiniSnap.menuMeals).length : 0} nutrition=${mcdMiniSnap?.nutritionData ? mcdMiniSnap.nutritionData.length : 0}字`);
            }
            if (payload.flags.luckinActive) {
                console.log(`☕ [Luckin-MiniApp] 注入协同点单上下文 step=${luckinMiniSnap?.step} cartItems=${luckinMiniSnap?.cart?.length || 0} menuItems=${luckinMiniSnap?.menuItems ? Object.keys(luckinMiniSnap.menuItems).length : 0}`);
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
            //    - 上云模式 (Instant Push / 即时对话): 不在客户端跑, 改把 eval prompt + 副 API 凭据
            //      一起交给 worker, worker 跑完把结果推回来, 客户端 flush 时落 buff —— 这样前端被杀
            //      也算数, 且不会跟客户端 eval 双跑双扣费. 见下方两个上云分支 + activeMsgRuntime.
            const emotionEvalEnabled = !!(!promptBuildSkipped && !isEmotionEvalSkipped() && isScheduleFeatureOn(char) && char.emotionConfig?.enabled);
            // 这一轮的生成在云端跑（两条路互斥，见 instantChatRoute 的算法）。
            // instantPushConfigured 是路由判定处冻结的同一回合终值——这里绝不自己再读
            // 一次，否则可能「按上云模式把评估打包走了，实际却走本地」，情绪底色悄悄停更。
            const cloudGenRoute = instantPushConfigured || instantChatRoute;
            // 评估跟随全局流式开关（专用情绪 API 自带 stream 字段时以它为准）
            const evalStream: boolean = !!((effectiveApi as any).stream ?? apiConfig.stream ?? false);
            const emotionApi = emotionEvalEnabled
                ? ((char.emotionConfig!.api?.baseUrl)
                    ? { ...char.emotionConfig!.api!, stream: (char.emotionConfig!.api as any).stream ?? evalStream }
                    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model, stream: evalStream })
                : null;
            // 本地路径的情绪评估：主 fetch 发出后立即发射（见下方调用点）。
            // 历史备注：曾为串行中转做过 1.5s 错峰（评估抢跑会把主回复压后一个评估时长），
            // 用户侧已排查确认当前渠道无该并发问题，2026-07 应用户要求取消延迟。
            // 上云模式不受影响：worker 那边自己安排评估的时机。
            const fireLocalEmotionEval = (emotionEvalEnabled && !cloudGenRoute && emotionApi) ? () => {
                setEmotionStatus('evaluating');
                evaluateEmotionBackground(charForGen, userProfile, systemPrompt, cleanedApiMessages, emotionApi)
                    .then((innerState) => {
                        if (innerState) setEvolvedNarrative(innerState);
                    })
                    .finally(() => {
                        setEmotionStatus('');
                    });
            } : null;
            // 交给云端跑的那份评估配置。两条上云路径共用同一个形状（提示词模板 + 副 API 凭据），
            // 只是搭在各自请求体的不同位置上：Instant Push 放顶层 emotionEval 字段，
            // 即时对话放任务 metadata.amsgEmotionEval（那份走加密信封）。
            const cloudEmotionEval = (emotionEvalEnabled && cloudGenRoute && emotionApi)
                ? {
                    // includeContext=false: 不嵌 system prompt + 对话历史 (worker 复用本次请求的 messages 作前文),
                    // 把 emotionEval 块压到最小, 让请求体留在 keepalive 64KB 上限内 (关前端也能跑完).
                    prompt: buildEmotionEvalPrompt(
                        charForGen, userProfile, systemPrompt, cleanedApiMessages, false,
                        shouldRequestAmbient(charForGen.id) ? buildAmbientEvalSection(charForGen) : ''
                    ),
                    api: { baseUrl: emotionApi.baseUrl, apiKey: emotionApi.apiKey, model: emotionApi.model },
                }
                : undefined;

            // 上云的情绪评估在 worker 跑 (副 API), 客户端看不到 LLM 调用时机, 但仍要给用户一个
            // "情绪更新中" 的可见信号 (header 徽章, 跟本地模式一致), 否则 "发送中" 消失后一片空白像死了.
            //
            // 正常的熄灭信号只有一个: worker 把结论推回来之后派发的 CHAT_GEN_EVENTS.emotionDone
            // (Chat 页的徽章和全局横幅各自监听, 都不依赖本 hook 存活 —— 用户切走 Chat 也能正常熄灭).
            // 剩下两种情况自己收场: 这一轮压根没发出去 —— 下面两个失败分支当场调
            // extinguishCloudEmotionBadge; 结论永远没回来 (worker 被杀 / 推送丢了 / 用户部署的是旧版)
            // —— 徽章的 setTimeout 和横幅的 TTL 同时到点, 两边用的是同一个数.
            //
            // 这个数按各自 worker 最长能跑多久给:
            //   · Instant Push: 一个请求里跑完就回, 90s 足够;
            //   · 即时对话: worker 那条 fire 的总时长上限是 INSTANT_TOTAL_TIMEOUT_MS（工具循环
            //     也算在内），评估结果又是跟着主回复的最后一条推送回来的——直接从 worker 模块
            //     import 那个数 + 一分钟推送在途余量，worker 侧调预算时这里自动跟上
            //     （ChatBroadcast 的横幅 TTL 同样从它推导，见那边注释）。
            const cloudEvalTimeoutMs = instantChatRoute ? INSTANT_TOTAL_TIMEOUT_MS + 60_000 : 90_000;
            /**
             * 熄灭「情绪更新中」的三件套：撤掉安全网、灭页内徽章、灭全局横幅。
             *
             * 这一轮没发出去时两个失败分支都要调它 —— 云端根本不会跑评估，那个正常的熄灭信号
             * 永远不会来。少调一处的表现是：徽章亮着直到安全网到点，然后弹一句
             * 「worker 可能是旧版」的提示，而真实原因是这条消息压根没发出去。
             */
            const extinguishCloudEmotionBadge = () => {
                clearCloudEmotionTimer(char.id);
                setEmotionStatus('');
                announceChatGen(CHAT_GEN_EVENTS.emotionEnd, { charId: char.id, charName: char.name });
            };
            if (cloudEmotionEval) {
                setEmotionStatus('evaluating');
                // 横幅这一条的存活上限跟徽章同一个数：不带的话横幅按自己那档默认值（本地评估的
                // 量级）扫，即时对话会出现「横幅先没了、徽章还亮着」，看着像出了两次故障。
                announceChatGen(CHAT_GEN_EVENTS.emotionStart, {
                    charId: char.id, charName: char.name, ttlMs: cloudEvalTimeoutMs,
                });
                // 布防按 charId 记进模块级 map。到点先看这一轮死没死透：即时对话的待收
                // 记录还在 = 云端还没给结论（worker 的 2/4/6 分钟重试梯子完全可能把合法
                // 回复拖过这个点）——这不是「无回音」，安静续期一小段再看，别抢在状态机
                // 前面宣判、把一个好端端的 worker 说成旧版让用户白重部署。待收记录没了
                // 而结论（emotionDone）一直没来，才是真的「跑完了但没人回音」。
                const charIdAtArm = char.id;
                const charNameAtArm = char.name;
                const armCloudEmotionSafetyNet = (delayMs: number) => {
                    clearCloudEmotionTimer(charIdAtArm);
                    cloudEmotionTimers.set(charIdAtArm, setTimeout(() => {
                        cloudEmotionTimers.delete(charIdAtArm);
                        if (instantChatRoute && getInstantChatPending(charIdAtArm)) {
                            armCloudEmotionSafetyNet(60_000);
                            return;
                        }
                        // 徽章只熄「布防那个角色」的：用户已切到别的角色时，这个 setter
                        // 管的是人家的徽章，不能碰。
                        if (currentCharIdRef.current === charIdAtArm) setEmotionStatus('');
                        // 超时无回音最常见的原因是用户部署的 worker 版本过旧（不支持情绪评估、
                        // 压根不会推结果回来），其次是 worker 被杀/推送丢失。过去这里
                        // 静默熄灯, 用户只看到「情绪永远不更新」—— 给一条可操作的提示。
                        announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                            charId: charIdAtArm, charName: charNameAtArm,
                            reason: instantChatRoute
                                ? '云端情绪评估超时无回音——worker 可能是旧版（不支持情绪评估），请到 设置→主动消息 2.0 重新部署 worker 后重试'
                                : '云端情绪评估超时无回音——worker 可能是旧版（不支持情绪评估），请到 设置→Instant 消息设置 更新 worker 后重试',
                        });
                    }, delayMs));
                };
                armCloudEmotionSafetyNet(cloudEvalTimeoutMs);
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
            // ⚠️ 工具模式(瑞幸点单/麦当劳)下绝不带 thinking/reasoning 参数: "thinking + tools" 同发
            //    Gemini 等会直接 400 INVALID_ARGUMENT —— 表现就是"开了思考链的角色一点单就报错,
            //    换个没开思考链的角色就好"。工具循环优先, 思考链这一轮让步。
            const toolModeActive = payload.flags.luckinChatActive || payload.flags.mcdActive || payload.flags.luckinActive || payload.flags.mcpChatActive;
            // 主动消息 2.0 的工具本轮会不会注入：thinking 门要先知道这件事（工具在下面才真正
            // 拼进 tools，但参数取舍必须现在就定）。角色级开关关掉的不注入——否则被用户显式
            // 关掉的功能会被角色一次工具调用重新打开。
            const amsg2ToolsInjected = isAmsg2EnabledForChar(char) && await isAmsg2GlobalReady();
            if (shouldSendThinkingParams({
                thinkingActive: !!payload.flags.thinkingActive,
                legacyToolModeActive: !!toolModeActive,
                amsg2ToolsInjected,
                model: baseReqBody.model || '',
            })) {
                const m: string = baseReqBody.model || '';
                if (/^claude-/i.test(m) && !/-thinking$/i.test(m)) {
                    baseReqBody.model = `${m}-thinking`;
                }
                baseReqBody.thinking = { type: 'enabled', budget_tokens: 4000 };
                baseReqBody.reasoning_effort = 'medium';
                baseReqBody.extra_body = { ...(baseReqBody.extra_body || {}), thinking: { type: 'enabled', budget_tokens: 4000 } };
                // 开思考时不要带采样参数: Claude 系（含各种中转 claude-*）在 thinking 启用时
                // 只接受 temperature=1，传 0.85 会被 400 ("temperature may only be set to 1 when
                // thinking is enabled")。删掉让服务端用默认即可——对其它模型(非 Claude)也安全:
                // 它们开思考时同样不需要我们指定温度，回退默认不影响行为。
                delete baseReqBody.temperature;
                delete baseReqBody.top_p;
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
            } else if (payload.flags.luckinActive) {
                baseReqBody.tools = [LUCKIN_PROPOSE_TOOL];
                baseReqBody.tool_choice = 'auto';
            } else if (payload.flags.luckinChatActive) {
                // 瑞幸聊天点单: 给角色真实 8 个 MCP 工具, 自己去查门店/搜商品/定规格/算价
                const luckinTools = await fetchOpenAIToolsForLuckin();
                if (luckinTools && luckinTools.length) {
                    baseReqBody.tools = luckinTools;
                    baseReqBody.tool_choice = 'auto';
                }
            }
            // 通用 MCP: 用户自配服务器的已发现工具, 追加而不覆盖(可与瑞幸/麦当劳共存)。
            // 工具清单读的是设置里持久化的发现结果, 不发网络请求。
            let mcpToolResolve: ReturnType<typeof buildMcpOpenAITools>['resolve'] | null = null;
            if (payload.flags.mcpChatActive) {
                const { tools: mcpTools, resolve } = buildMcpOpenAITools(char.id);
                if (mcpTools.length) {
                    mcpToolResolve = resolve;
                    const mcpOnly = !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive;
                    if (!getMcpUseNativeTools() && mcpOnly) {
                        // 用户已明确判断当前模型/中转不支持 tools：首轮直接走正文兼容模式。
                        const compatibilityBody = buildMcpRejectedToolsFallbackBody({
                            ...baseReqBody,
                            tools: mcpTools,
                            tool_choice: 'auto',
                        });
                        baseReqBody.messages = compatibilityBody.messages;
                    } else {
                        baseReqBody.tools = [...(baseReqBody.tools || []), ...mcpTools];
                        if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
                    }
                }
            }
            // 主动消息 2.0 本地工具：worker 已配置 + 角色没关掉时注入 schedule/cancel/renew/list，
            // 并注入「排程现状」背景块（常驻能力简介 + 进行中任务 + 作废待处理，角色自行判断怎么接）。
            // 是否注入在上面 thinking 门那里就算好了（amsg2ToolsInjected）。
            // amsg2 和 Instant Push 在设置页已经是双向互斥，正常情况下不可能两个都开，
            // 这里不需要额外判断（下面的 Instant Push 分支只为历史配置兜底保留）。
            let amsg2ExpiredIds: string[] = [];
            let amsg2Notices: Amsg2ExpiredNoticeRecord[] = [];
            if (amsg2ToolsInjected) {
                baseReqBody.tools = [...(baseReqBody.tools || []), ...AMSG2_TOOLS];
                if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
                try {
                    // 回执这半边是「检出 + 落台账」的结果，带副作用，一轮只算一次；
                    // 进行中任务那半边每次发请求现取（见下面的 withAmsg2TaskContext）。
                    const taskContext = await collectAmsg2TaskContext(char, userProfile.name);
                    amsg2ExpiredIds = taskContext.expiredIds;
                    amsg2Notices = taskContext.notices;
                } catch (e) {
                    // 挂掉的只是作废回执这半边（它要读历史消息和台账）。进行中清单在内存里，
                    // 照常渲染——角色至少知道自己名下有哪些任务，不至于一问三不知再排一条。
                    console.warn('[amsg2] 作废回执检出失败，本轮只带进行中清单', e);
                }
            }

            /**
             * 把排程现状块贴到 messages 末尾，每次发请求都按「此刻」的任务清单现算。
             *
             * 不写死进 baseReqBody.messages、也不进 loopMessages，是因为工具循环里角色会
             * 边聊边排：写死的话第二轮起看到的是**排程前**那份空清单，跟工具刚回的「已创建」
             * 打架，角色于是把同一条再排一遍；攒进历史的话则是好几份互相矛盾的旧清单叠着。
             * 现算 + 只留一份，角色每轮读到的都是自己名下真实的任务，本轮刚排的还会被点名。
             */
            const withAmsg2TaskContext = (messages: any[]): any[] => {
                if (!amsg2ToolsInjected) return messages;
                const now = Date.now();
                const text = buildAmsg2TaskContextText(
                    getPendingTasks(amsg2Session.getConfig(), now),
                    amsg2Notices,
                    now,
                    resolveCharTimeZone(char),
                    amsg2CreatedThisTurn,
                    userProfile.name,
                );
                // 常驻简介让这一块总是非空：没任务时角色也得知道自己随时能排。
                return [...messages, { role: 'system', content: text }];
            };

            // ─── Instant Push 分支 ───
            // 与本地 fetch 对称：sendInstantPushAndAwaitReply 内部完成 sub 获取 / push 监听 /
            // 300s 超时兜底，返回时 push 已落库（或失败）。外层 finally 统一清 isTyping /
            // KeepAlive / 跑 memory palace 后处理，与本地路径完全对齐。
            // worker 端跑完 LLM → push → SW → activeMsgRuntime.flushInboxToChat 写 DB 并刷 UI。
            // 瑞幸聊天点单 / 麦当劳 / 瑞幸小程序 这些"客户端工具循环"模式必须走本地 fetch:
            // instant push 会把请求交给 worker 并在这里提前 return, 工具循环(callLuckinTool 等)根本跑不到,
            // 表现就是"选了城市也没用 / 角色不下单"。这些模式下跳过 instant push, 用本地 fetch 跑工具循环。
            // 双向互斥后理论上到不了：走到这条 trace 说明两边开关同时亮着（脏配置），当断言告警看。
            const AMSG2_SUPPRESSED_TRACE = 'amsg2-suppressed-by-instant';
            if (instantPushConfigured && !sarModulePlan.hasActiveEffect && !sarModulePlan.hasAfterglow && !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive && !payload.flags.mcpChatActive) {
                // 走这条路 = 上面那段 amsg2 的工具、排程现状块都白拼了（instant 发的是原始
                // fullMessages、请求体不带 tools），下面的活跃会话租约也不会开。三样都是静默
                // 失效，留一条 trace 让观察窗看得见，别让人对着「功能不响」凭空排查。
                if (amsg2ToolsInjected) {
                    appendInstantTraceEntry({ ts: new Date().toISOString(), event: AMSG2_SUPPRESSED_TRACE });
                }
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
                    ...(cloudEmotionEval ? { emotionEval: cloudEmotionEval } : {}),
                }, char.id, undefined, onInstantPosted);
                if (!instantResult.ok && instantResult.outcome !== 'cancelled') {
                    // 长报错 (worker 400 校验信息 + CF 错误页可能很长) 走弹窗, 手机用户能
                    // 看清并复制反馈; 没注入 showError 时降级到 toast.
                    // 完整诊断由 instantPushClient 的 formatDiagnostics 输出 —— 涵盖
                    // http (status/bodyBytes/keepalive/cf-ray/response 截断) / fetchError /
                    // config / subscription / timeout / context / env 各段, 已主动 mask
                    // worker / api host, 不含 apiKey / apiUrl / workerUrl / push endpoint.
                    //
                    // 'cancelled' = pagehide / signal abort, caller 自己取消的, 不弹错。
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
                // 发送失败/取消 → worker 不会跑情绪评估，那个正常的熄灭信号永不到达，当场自己熄。
                if (!instantResult.ok && cloudEmotionEval) extinguishCloudEmotionBadge();
                return;
            }

            // ─── 即时对话（主动消息 2.0 云端生成）分支 ───
            // 和上面的 Instant Push 对称：这一轮的上下文 + 任务一个 POST 上云，云端跑完
            // 走推送回来（收件箱同一条管线入库），客户端发完那一刻就自由了。
            // 设置页那道门已经把两条路做成双向互斥，正常情况下不可能两个都开；
            // 上面的 Instant Push 分支只为历史配置兜底保留。
            //
            // 走不走这条路，构建 payload 之前的 instantChatRoute 已经算完了，这里只认它
            // 一个值：「这份 prompt 剥没剥时效段」和「这一轮走不走云端」必须是同一个判断，
            // 各算各的话两边总有一天会不同意，剥过的那份 prompt 就落到别的路上去了。
            // 没上云的那些情形（点单否决 / IP 配置也还在）在那一段里已经报过 trace，
            // 这边不重复报，也不重复拦。
            //
            // MCP 刻意不在排除名单里：worker fire 时自己解析 tool_config、自己跑后台
            // MCP（这次 POST 顺手把配置传上去了），云端答得了。排掉它的话，只要全局配着
            // 一台 enabled 的 MCP 服务器，即时对话就永远静默走回本地——设置页亮着
            // 「已开启」、界面毫无异样，正是 instant push 静默分流那个坑的复刻。
            if (instantChatRoute) {
                // 作废回执跟着 chat 段上云：检出（collectAmsg2TaskContext，带落台账的副作用）
                // 在上面已经跑过了，本地路径靠 withAmsg2TaskContext 注入的排程清单和能力
                // 简介到点由 worker 的 instant timely block 现算现渲，唯独回执云端没有——
                // 只把这一样单独成块贴上，不带清单不带简介，别和到点渲染的那份撞车。
                const amsg2NoticesBlock = amsg2ToolsInjected && amsg2Notices.length
                    ? buildAmsg2NoticesText(amsg2Notices, resolveCharTimeZone(char), userProfile.name)
                    : null;
                const instantChatResult = await sendInstantChatTurn({
                    char,
                    // 云端要发给模型的就是本地这一份，一个字不改（见 fire_pack 的 chat 段）。
                    chatMessages: (amsg2NoticesBlock
                        ? [...fullMessages, { role: 'system', content: amsg2NoticesBlock }]
                        : fullMessages) as Array<{ role: string; content: unknown }>,
                    // 凭据用本地这一轮的那份：换成别的等于同一句话由不同模型来答，而用户看不出来。
                    // model / temperature 取 baseReqBody 的终值而不是 effectiveApi 的原始值：
                    // 上面那段已经按本地规则把 thinking 后缀（claude 系 -thinking）拼好、
                    // 开思考时把温度删掉了——云端要的就是「本地这一轮会发出去的那份」。
                    api: { baseUrl: effectiveApi.baseUrl, apiKey: effectiveApi.apiKey, model: baseReqBody.model },
                    ...(typeof baseReqBody.temperature === 'number' ? { temperature: baseReqBody.temperature } : {}),
                    maxTokens: baseReqBody.max_tokens,
                    // 思考链三件套同理取终值：shouldSendThinkingParams 通过时本地会带
                    // thinking / reasoning_effort / extra_body 三个入口（不同代理认不同的），
                    // 云端不带的话，凡是靠请求体参数激活思考的渠道（Anthropic 原生、
                    // OpenAI 系、LiteLLM 桥——即除了 -thinking 模型名后缀之外的全部）
                    // 一开即时对话思考就静默消失，心象卡片跟着没了。
                    ...(baseReqBody.thinking || baseReqBody.reasoning_effort || baseReqBody.extra_body
                        ? {
                            extraBody: {
                                ...(baseReqBody.thinking ? { thinking: baseReqBody.thinking } : {}),
                                ...(baseReqBody.reasoning_effort ? { reasoning_effort: baseReqBody.reasoning_effort } : {}),
                                ...(baseReqBody.extra_body ? { extra_body: baseReqBody.extra_body } : {}),
                            },
                        }
                        : {}),
                    userProfile, groups, realtimeConfig,
                    // 情绪评估也交给云端：worker 到点和主回复并行跑，结果随最后一条推送回来
                    // （见 worker/amsg/src/emotionEval.ts）。放在这里而不是本地 fire 一枪，
                    // 是因为用户发完就能关页面——留在本地的话，页面一关情绪底色就停更了。
                    ...(cloudEmotionEval ? { emotionEval: cloudEmotionEval } : {}),
                });
                if (instantChatResult.ok) {
                    // 这次 POST 已经把权威的那份 fire_pack 传上去了，收尾不必再打脏重传一遍。
                    instantChatAccepted = true;
                    // 202 只说明云端收下了，不说明角色真的读到过这些回执：那一轮可能空输出被
                    // 判 skip-push，也可能 fire 重试打光标 failed。所以这里只记账不销账，等回复
                    // 真的落库那一刻（activeMsgRuntime 认末段到齐）再调
                    // settleInstantChatExpiredNotices 写 notifiedAt；这一轮没成的话
                    // failInstantChatPending 会把它们退回未告知，下一轮重新注入。
                    // 本地路径同一口径：回复 applyAssistantPostProcessing 落库之后才标记。
                    if (amsg2ExpiredIds.length && instantChatResult.uuid) {
                        stageInstantChatExpiredNotices(char.id, instantChatResult.uuid, amsg2ExpiredIds);
                    }
                } else {
                    // 没发出去就是没发出去：明确落一条系统消息 + 弹错，用户可以直接重发。
                    // **绝不静默退回本地生成** —— 静默分流那种查无可查的坑踩过一次就够了。
                    const reason = instantChatResult.error || '未知错误';
                    await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[${reason}]` });
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    if (showError) showError('即时对话发送失败', reason);
                    else addToast(reason, 'error');
                    // 没发出去 → 云端不会跑评估，那个正常的熄灭信号永不到达。当场自己熄，
                    // 否则「情绪更新中」要一直亮到 11 分钟后安全网到点。
                    if (cloudEmotionEval) extinguishCloudEmotionBadge();
                }
                return;
            }

            // 流式预览：仅在用户开了 stream、且非工具/双语模式时启用。
            // 工具模式的首轮响应可能是 tool_calls（无正文可预览）；双语模式正文包在
            // 跨行 <翻译> 标签里。这两类连正文/思考钩子都不挂，完整走原有整包路径。
            // 语音、日记、HTML 等由内容标签动态识别，computeStreamPreviewBubbles 会扣住控制块，
            // 只允许标签外确实属于普通文字的部分预览。
            // 每次 onDelta 基于累计全文全量重算（safeFetchJson 重试会重开流，天然重置）；
            // 正文尾句和思考内容只在累计文本确实变化时触发重渲染。
            // SAR 的正文包在结构化容器里，流式阶段不能把 TRUE/SURFACE 控制标签闪给用户。
            const streamUiEligible = !!userStream && !toolModeActive && !bilingualActive && !sarModulePlan.requiresEnvelope;
            const streamPreviewEligible = streamUiEligible;
            const streamThinkingEligible = streamUiEligible && payload.flags.thinkingActive;
            // 预览真的上过屏才置 true → 后处理落库时跳过拟人打字延迟（instantRender），
            // 否则用户会看到"预览气泡收回去、再一条条慢慢重弹"的二次播放。
            let streamPreviewShown = false;
            let streamThinkingShown = false;
            let latestStreamPreviewBubbles: string[] = [];
            let latestNativeReasoning = '';
            let latestEmbeddedThinking = '';
            const publishStreamingThinking = () => {
                const combined = [latestNativeReasoning, latestEmbeddedThinking]
                    .map(text => text.trim())
                    .filter(Boolean)
                    .join('\n\n');
                if (combined) streamThinkingShown = true;
                setStreamingThinking(prev => prev === combined ? prev : combined);
            };
            const streamHooks = (streamPreviewEligible || streamThinkingEligible) ? {
                onDelta: (_delta: string, fullText: string) => {
                    if (streamPreviewEligible) {
                        const bubbles = computeStreamPreviewBubbles(fullText);
                        latestStreamPreviewBubbles = bubbles;
                        if (bubbles.length > 0) streamPreviewShown = true;
                        setStreamingBubbles(prev =>
                            (prev.length === bubbles.length && prev.every((b, i) => b === bubbles[i])) ? prev : bubbles
                        );
                    }
                    if (streamThinkingEligible) {
                        latestEmbeddedThinking = extractStreamingEmbeddedThinking(fullText);
                        publishStreamingThinking();
                    }
                },
                onReasoningDelta: (_delta: string, fullReasoning: string) => {
                    if (!streamThinkingEligible) return;
                    latestNativeReasoning = fullReasoning;
                    publishStreamingThinking();
                },
            } : undefined;

            // 主请求即将发出 → 立即并行发射情绪评估（错峰延迟已按用户要求取消，见定义处注释）。
            fireLocalEmotionEval?.();

            // 同角色活跃会话租约：本地 fetch 路径本轮真实消息已落库、模型请求即将发出，
            // 启动心跳告诉 worker「正在和这个角色聊」——到点的 expire AI 任务据此 skip，
            // 别在用户正聊时又弹主动消息。instant push 路径在上方已 return，天然不重复开 lease。
            // 只对已排程 AI 任务的角色开租约：其余角色没有 worker 消费，开了纯浪费还刷 warn。
            const amsg2Cfg = char.activeMsg2Config;
            if (amsg2Cfg?.enabled && hasActiveAiTask(amsg2Cfg)) {
                startAmsgChatPresence(char.id, getLastRealUserMessageAt(contextMsgs));
            }

            let data: any;
            try {
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ ...baseReqBody, messages: withAmsg2TaskContext(baseReqBody.messages) })
                }, 2, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: '聊天回复' }, streamHooks);
            } catch (e) {
                let requestError: unknown = e;
                const attemptedBody = {
                    ...baseReqBody,
                    messages: withAmsg2TaskContext(baseReqBody.messages),
                };
                // 部分第三方 OpenAI→Claude 中转会把请求形状不兼容包装成 502
                // bad_response_status_code：thinking 三种方言、tools、尾部 system 单独都能收，
                // 组合在一起却在上游适配层失败。只对这一条高度特征化的 502 降级一次：
                // tools 和正文完整保留，system 合到开头，thinking 参数让步。普通网络 502、
                // 非 Claude、没工具的请求一律不重发，避免无依据地重复计费。
                if (shouldRetryClaudeProxyCompatibility(requestError, attemptedBody)) {
                    console.warn('🧩 [Claude compat] 中转拒绝 thinking + tools 组合，使用兼容请求体重试一次');
                    try {
                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify(buildClaudeProxyCompatibilityBody(attemptedBody)),
                        }, 0, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: 'Claude 中转兼容重试' }, streamHooks);
                        requestError = null;
                    } catch (compatError) {
                        requestError = compatError;
                    }
                }

                if (!requestError) {
                    // Claude 兼容重试已成功，继续走下方统一后处理。
                } else {
                // 仅通用 MCP、且没有和其他工具模式混用时降级。部分 OpenAI 兼容中转
                // 会对携带 tools 的请求直接回 4xx，而不是忽略参数；去掉 tools 后让
                // 现有正文假调用容错接手。真实鉴权失败会在这次重试中再次抛出原样错误。
                const mcpOnly = payload.flags.mcpChatActive
                    && !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive;
                if (!mcpOnly || !baseReqBody.tools?.length || !shouldRetryMcpWithoutTools(requestError)) throw requestError;
                console.warn('🔌 [MCP] 当前中转拒绝 tools 请求，降级为正文工具调用兼容模式');
                // 这条路把 tools 全删了，角色排不了新任务；排程现状照样要带——它得知道
                // 自己名下已经有哪些承诺，否则又会在正文里许一遍。
                const fallbackBody = buildMcpRejectedToolsFallbackBody({
                    ...baseReqBody,
                    messages: withAmsg2TaskContext(baseReqBody.messages),
                });
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify(fallbackBody)
                }, 0, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: 'MCP tools 兼容重试' });
                // 后续正文工具循环必须继续带着兼容协议；只把它放在这次重试请求里，下一跳
                // 又退回原 messages，会让模型忘掉工具签名和「每步只输出一行」的约定。
                baseReqBody.messages = fallbackBody.messages;
                }
            }
            console.log(`⏱ [API call] ${Math.round(performance.now() - apiT0)}ms`);
            updateTokenUsage(data, historyMsgCount, 'initial');

            // MCP 多阶段展示：工具前的角色文字先落库，最终工具结果回复仍走统一后处理。
            const displayedMcpLeadIns = new Set<string>();
            const persistMcpLeadIn = async (raw: string, fakedCalls: FakedMcpCall[] = []): Promise<void> => {
                if (!mcpToolResolve || !raw.trim()) return;
                const withoutCalls = fakedCalls.length ? stripTextFakedMcpCalls(raw, fakedCalls) : raw.trim();
                const display = ChatParser.sanitize(sanitizeMcpLeadInText(withoutCalls), { keepCitations: true }).trim();
                if (!display || !ChatParser.hasDisplayContent(display) || displayedMcpLeadIns.has(display)) return;
                displayedMcpLeadIns.add(display);
                const chunks = ChatParser.chunkText(display).filter(chunk => ChatParser.hasDisplayContent(chunk));
                for (const chunk of chunks) {
                    const cleanChunk = ChatParser.sanitize(chunk, { keepCitations: true }).trim();
                    if (!cleanChunk) continue;
                    await DB.saveMessage({
                        charId: char.id,
                        role: 'assistant',
                        type: 'text',
                        content: cleanChunk,
                        metadata: { mcpLeadIn: true },
                    } as any);
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                }
            };

            // 3.4 麦当劳小程序 propose_cart_items UI 钩子工具循环
            //     不调 MCP, 只把模型的 args 作为 mcd_card kind=proposal 落库, 让小程序聊天面板渲染
            //     成"+加进购物车"卡片。返回 ack 给模型继续走它的文字 reply。
            if (payload.flags.mcdActive && data.choices?.[0]?.message?.tool_calls?.length) {
                const MAX_PROPOSE_LOOPS = 3;
                let loopMessages = [...baseReqBody.messages];
                for (let it = 0; it < MAX_PROPOSE_LOOPS; it++) {
                    const toolCalls = data.choices?.[0]?.message?.tool_calls;
                    if (!toolCalls || !toolCalls.length) break;
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容层会被判 INVALID_ARGUMENT, 给个占位
                        content: data.choices[0].message.content || '(调用工具中)',
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
                        // 主动消息 2.0 的排程工具与点单工具会在同一批 tool_calls 里出现:
                        // 先分流执行, 否则会落进下面的「畸形调用」分支被吃掉, 而续写请求
                        // 又不带 tools, 角色「点单时顺手排个提醒」就永远不会生效。
                        const route = routeMiniAppToolCall(fname, args);
                        if (route === 'amsg2') {
                            await runAmsg2ToolCall(tc, fname, args, loopMessages);
                            continue;
                        }
                        if (route === 'propose') {
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

            // 3.5 瑞幸小程序 propose_cart_items UI 钩子工具循环 (与麦当劳同构)
            if (payload.flags.luckinActive && data.choices?.[0]?.message?.tool_calls?.length) {
                const MAX_PROPOSE_LOOPS = 3;
                let loopMessages = [...baseReqBody.messages];
                for (let it = 0; it < MAX_PROPOSE_LOOPS; it++) {
                    const toolCalls = data.choices?.[0]?.message?.tool_calls;
                    if (!toolCalls || !toolCalls.length) break;
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容层会被判 INVALID_ARGUMENT, 给个占位
                        content: data.choices[0].message.content || '(调用工具中)',
                        tool_calls: toolCalls,
                    } as any);
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('☕ [Luckin-MiniApp] propose 参数解析失败:', e);
                        }
                        // 主动消息 2.0 的排程工具与点单工具会在同一批 tool_calls 里出现:
                        // 先分流执行, 否则会落进下面的「畸形调用」分支被吃掉, 而续写请求
                        // 又不带 tools, 角色「点单时顺手排个提醒」就永远不会生效。
                        const route = routeMiniAppToolCall(fname, args);
                        if (route === 'amsg2') {
                            await runAmsg2ToolCall(tc, fname, args, loopMessages);
                            continue;
                        }
                        if (route === 'propose') {
                            const menu = luckinMiniSnap?.menuItems || {};
                            const menuKeys = Object.keys(menu);
                            if (menuKeys.length === 0) {
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `菜单还没加载 (用户当前在选模式 / 选门店阶段)。请先用文字陪用户聊, 等菜单加载出来、出现"当前门店在售"清单后再调 propose_cart_items, code 必须从清单里挑。`,
                                } as any);
                                continue;
                            }
                            const { fixed, fixes } = autoFixLuckinProposalCodesByName(args.items, menu);
                            if (fixes.length) {
                                console.log(`☕ [Luckin-MiniApp] propose 自动修 ${fixes.length} 个 code:`,
                                    fixes.map(f => `'${f.from}' → '${f.to}' (${f.name})`).join(', '));
                            }
                            args.items = fixed;
                            const invalidItems = args.items.filter((it: any) => !it?.code || !(menu as any)[it.code]);
                            if (invalidItems.length > 0) {
                                const sample = menuKeys.slice(0, 20).map(k => `${k}=${(menu as any)[k]?.name || ''}`).join(', ');
                                const bad = invalidItems.map((i: any) => `'${i.code}'(${i.name || '?'})`).join(', ');
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `propose_cart_items 里这些 code/name 在菜单里找不到匹配: ${bad}。这些商品本店不卖, 别推。当前菜单可用 code 示例: ${sample}。请只从菜单里挑实际有的, 重新调一次 propose。`,
                                } as any);
                                continue;
                            }
                            try {
                                await DB.saveMessage({
                                    charId: char.id,
                                    role: 'assistant',
                                    type: 'luckin_card',
                                    content: `${args.items.length} 件推荐`,
                                    metadata: {
                                        luckinCardKind: 'proposal',
                                        luckinProposal: args,
                                        fromLuckinMiniApp: true,
                                    },
                                } as any);
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            } catch (e) {
                                console.warn('☕ [Luckin-MiniApp] 保存 proposal 失败:', e);
                            }
                            const ackExtra = fixes.length
                                ? ` (我帮你把 ${fixes.length} 个 code 按名字校准到了菜单里真实的 code)`
                                : '';
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `OK 已把推荐展示给用户, 用户可以点 + 加进购物车${ackExtra}`,
                            } as any);
                        } else {
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `工具 ${fname} 调用形态不对, 期望 {items: [{code, name, qty, reason?}]}; 你这次给的是 ${JSON.stringify(args).slice(0, 200)}`,
                            } as any);
                        }
                    }
                    const followBody = { ...baseReqBody, messages: loopMessages };
                    delete followBody.tools;
                    delete followBody.tool_choice;
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `luckin-propose-${it + 1}`);
                    if (!data.choices?.[0]?.message?.tool_calls?.length) break;
                }
            }

            // 3.6 客户端工具循环 —— 两类共用一个循环骨架:
            //     · 瑞幸聊天点单: 真实 8 工具 (queryShopList → searchProductForMcp →
            //       switchProduct → previewOrder)。结果落 luckin_card; previewOrder 落"结账卡"(可改量+扫码付);
            //       createOrder 被拦截 —— 下单付款必须用户在结账卡上点。
            //     · 通用 MCP: 工具名命中 mcpToolResolve 映射就分发给对应服务器 (utils/mcpClient),
            //       结果只回填循环不落卡片。两类工具可同时在场, 按名字各走各的。
            if ((payload.flags.luckinChatActive || mcpToolResolve || amsg2ToolsInjected) && data.choices?.[0]?.message?.tool_calls?.length) {
                // 普通点单/排程维持 6 轮；接了通用 MCP 时允许游戏/论坛类任务自然推进到
                // 12 轮。模型正常给正文会立刻 break，并不是固定多发 12 次请求。
                const MAX_LOOPS = mcpToolResolve ? MCP_CHAT_MAX_TOOL_LOOPS : 6;
                let loopMessages = [...baseReqBody.messages];
                const loc = luckinChatRef?.current;
                const seenMcpOutcomes = new Set<string>();
                let stalledMcpRounds = 0;
                let lastMcpCallSignature: string | null = null;
                for (let it = 0; it < MAX_LOOPS; it++) {
                    const toolCalls = normalizeToolCallsForCompat(
                        data.choices?.[0]?.message?.tool_calls,
                        `private_${it}`,
                    );
                    if (!toolCalls || !toolCalls.length) break;
                    if (mcpToolResolve && toolCalls.some((tc: any) => mcpToolResolve?.has(tc.function?.name || ''))) {
                        await persistMcpLeadIn(data.choices?.[0]?.message?.content || '');
                    }
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容层会被判 INVALID_ARGUMENT, 给个占位
                        content: data.choices[0].message.content || '(调用工具中)',
                        tool_calls: toolCalls,
                    } as any);
                    let mcpCallsThisRound = 0;
                    let mcpProgressThisRound = false;
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('☕ [Luckin-Chat] 工具参数解析失败:', e);
                        }
                        // 通用 MCP 工具: 命中映射直接分发, 不走下面的瑞幸逻辑
                        const mcpHit = mcpToolResolve?.get(fname);
                        if (mcpHit) {
                            mcpCallsThisRound += 1;
                            const callSignature = toolCallFingerprint(fname, args);
                            // 连续同名同参通常是模型卡住。先拦再执行，避免发帖 / 下单之类的
                            // 副作用真的重复发生；中间做过其他动作后同参查状态仍会正常放行。
                            if (callSignature === lastMcpCallSignature) {
                                loopMessages.push(buildToolResultMessage(
                                    tc,
                                    `工具 ${fname} 的同一组参数刚刚已经执行过，请不要原地重复；根据已有结果选择能推进目标的下一步，或直接回复。`,
                                ) as any);
                                continue;
                            }
                            lastMcpCallSignature = callSignature;
                            setSearchStatus(`正在调用 MCP 工具：${fname}...`);
                            let mcpResult: any;
                            try { mcpResult = await callMcpTool(mcpHit.server, mcpHit.toolName, args); }
                            catch (e: any) { mcpResult = { success: false, error: e?.message || String(e) }; }
                            const mcpMsg = mcpResult.success
                                ? `工具 ${fname} 成功。结果: ${formatMcpToolResult(mcpResult.data)}`
                                : `工具 ${fname} 失败: ${mcpResult.error}`;
                            // 同名同参在动作前后可能得到不同状态，结果不同就算仍在推进；只有
                            // 调用和结果都原样重复才算原地打转。
                            let outcomeKey = `${fname}|${JSON.stringify(args)}|${mcpMsg}`;
                            if (outcomeKey.length > 4000) outcomeKey = outcomeKey.slice(0, 4000);
                            if (!seenMcpOutcomes.has(outcomeKey)) {
                                seenMcpOutcomes.add(outcomeKey);
                                mcpProgressThisRound = true;
                            }
                            loopMessages.push(buildToolResultMessage(tc, mcpMsg) as any);
                            continue;
                        }
                        // 主动消息 2.0 工具
                        if (AMSG2_TOOL_NAMES.has(fname)) {
                            await runAmsg2ToolCall(tc, fname, args, loopMessages);
                            continue;
                        }
                        // 只开了 MCP 没开瑞幸时, 幻觉出的未知工具名直接回错误让模型自我纠正
                        if (!payload.flags.luckinChatActive) {
                            loopMessages.push(buildToolResultMessage(tc, `未知工具 ${fname}, 只能使用系统提供的工具。`) as any);
                            continue;
                        }
                        // 经纬度兜底: 角色漏传就用激活时抓到的定位补上
                        if (/queryShopList|createOrder/i.test(fname) && loc) {
                            if (args.longitude == null && loc.longitude != null) args.longitude = loc.longitude;
                            if (args.latitude == null && loc.latitude != null) args.latitude = loc.latitude;
                        }
                        // 拦截 createOrder: 不真下单, 引导走结账卡
                        if (/create[-_]?order/i.test(fname)) {
                            loopMessages.push(buildToolResultMessage(
                                tc,
                                '下单与支付由用户在结账卡上完成, 你不要调 createOrder。若还没出结账卡, 请先调 previewOrder 把订单算价展示出来, 然后用角色语气让用户去卡片上确认支付。',
                            ) as any);
                            continue;
                        }
                        let result: any;
                        try { result = await callLuckinTool(fname, args); }
                        catch (e: any) { result = { success: false, error: e?.message || String(e) }; }

                        const isPreview = /preview[-_]?order/i.test(fname);
                        try {
                            await DB.saveMessage({
                                charId: char.id,
                                role: 'assistant',
                                type: 'luckin_card',
                                content: fname,
                                metadata: {
                                    luckinToolName: fname,
                                    luckinToolArgs: args,
                                    luckinToolResult: result.success ? result.data : undefined,
                                    luckinToolError: result.success ? undefined : result.error,
                                    luckinToolRawText: result.rawText,
                                    luckinCardKind: isPreview ? 'checkout' : inferLuckinCardKind(fname),
                                    luckinLoc: (loc && loc.longitude != null) ? { longitude: loc.longitude, latitude: loc.latitude } : undefined,
                                },
                            } as any);
                            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                        } catch (e) { console.warn('☕ [Luckin-Chat] 存卡片失败:', e); }

                        const toolMsg = result.success
                            ? `工具 ${fname} 成功。结果(截断): ${(() => { try { return JSON.stringify(result.data).slice(0, 1500); } catch { return String(result.data).slice(0, 800); } })()}`
                            : `工具 ${fname} 失败: ${result.error}`;
                        loopMessages.push(buildToolResultMessage(tc, toolMsg) as any);
                    }
                    if (mcpCallsThisRound > 0) {
                        stalledMcpRounds = mcpProgressThisRound ? 0 : stalledMcpRounds + 1;
                    }
                    const reachedHardLimit = !!mcpToolResolve && it + 1 >= MAX_LOOPS;
                    const stalled = !!mcpToolResolve && stalledMcpRounds >= MCP_CHAT_MAX_STALLED_ROUNDS;
                    const forceWrapUp = reachedHardLimit || stalled;
                    // 继续让角色多步推进 (保留 tools, 允许 query→search→preview 连续走)
                    if (mcpToolResolve) setSearchStatus('正在整理 MCP 工具结果...');
                    // 排程现状现算一次贴上：本轮刚排的任务这时才进得了清单，角色下一轮
                    // 看到的是自己名下真实的排程，不会对着排程前的空清单再排一条。
                    const followMessages = withAmsg2TaskContext(loopMessages);
                    if (forceWrapUp) {
                        followMessages.push({
                            role: 'user',
                            content: `[系统消息：工具阶段${stalled ? '连续两轮没有产生新结果' : '已到本轮安全上限'}。请停止调用工具，基于已经拿到的结果直接用角色语气回复；如目标仍未完成，请如实说明卡在哪一步。不要输出工具名、参数或这条系统消息。]`,
                        });
                    }
                    const followBody = { ...baseReqBody, messages: followMessages };
                    if (forceWrapUp) {
                        delete followBody.tools;
                        delete followBody.tool_choice;
                    }
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `${payload.flags.luckinChatActive ? 'luckin-chat' : 'mcp-chat'}-${it + 1}`);
                    if (forceWrapUp) break;
                }
                if (mcpToolResolve) setSearchStatus('');
            }

            // 3.6b MCP 掉格式容错（第二层, 对标见面观测协议的两层容错）:
            //     不支持 function calling 的模型会把工具调用写成正文文字, 如
            //     ask_question("SullyOS") / ask_question: SullyOS。这里检测出来
            //     系统代为执行, 把结果喂回去让角色重新组织语言, 用户就看不到乱码了。
            //     连续调用指纹防止模型复读同一调用导致副作用工具重复执行；中间若有别的
            //     动作，则允许用同参重新查询已经变化的状态。
            if (mcpToolResolve) {
                const MAX_TEXT_LOOPS = MCP_CHAT_MAX_TOOL_LOOPS;
                let lastExecutedSig: string | null = null;
                let textLoopMessages: any[] | null = null;
                for (let it = 0; it < MAX_TEXT_LOOPS; it++) {
                    const contentNow: string = data.choices?.[0]?.message?.content || '';
                    // 兼容协议约定每轮只发一行。一次只执行一个，既让 12 轮真正按步骤自适应，
                    // 也避免一段失控正文批量触发多个副作用。
                    const allFaked = extractTextFakedMcpCalls(contentNow, mcpToolResolve).slice(0, 1);
                    const faked = allFaked
                        .filter(c => toolCallFingerprint(c.exposedName, c.args) !== lastExecutedSig);
                    // 兼容模式没有原生 tool_call id，模型重复写同名同参时绝不能再次执行
                    // 副作用工具；给一次强制收尾请求，把已经拿到的结果组织成人话。
                    if (allFaked.length > 0 && faked.length === 0) {
                        if (!textLoopMessages) textLoopMessages = [...baseReqBody.messages];
                        textLoopMessages.push({ role: 'assistant', content: contentNow });
                        textLoopMessages.push({
                            role: 'user',
                            content: '[系统消息：你重复请求了已经执行过的同一工具。不要再次调用工具，请直接根据已有结果回复；如目标未完成就如实说明。不要输出工具调用格式或提及本消息。]',
                        });
                        const wrapBody = buildMcpTextFallbackBody(baseReqBody, textLoopMessages);
                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify(wrapBody)
                        });
                        updateTokenUsage(data, historyMsgCount, `mcp-text-wrap-${it + 1}`);
                        break;
                    }
                    if (!faked.length) break;
                    console.warn(`🔌 [MCP] 检测到 ${faked.length} 个正文假工具调用, 代为执行:`, faked.map(c => c.exposedName).join(', '));
                    await persistMcpLeadIn(contentNow, faked);
                    setSearchStatus(`正在调用 MCP 工具：${faked.map(c => c.exposedName).join('、')}...`);
                    const results: string[] = [];
                    for (const call of faked) {
                        lastExecutedSig = toolCallFingerprint(call.exposedName, call.args);
                        let r: any;
                        try { r = await callMcpTool(call.server, call.toolName, call.args); }
                        catch (e: any) { r = { success: false, error: e?.message || String(e) }; }
                        results.push(r.success
                            ? `工具 ${call.exposedName} 执行成功, 结果: ${formatMcpToolResult(r.data)}`
                            : `工具 ${call.exposedName} 执行失败: ${r.error}`);
                    }
                    if (!textLoopMessages) textLoopMessages = [...baseReqBody.messages];
                    textLoopMessages.push({ role: 'assistant', content: contentNow });
                    textLoopMessages.push({
                        role: 'user',
                        content: `[系统消息：你把工具调用写成了聊天文字，系统已代为执行：\n${results.join('\n')}\n如果目标已经完成，请直接用角色语气回复；如果仍需下一步工具，只输出一行真正能推进目标的工具调用，不要重复读取同一说明或状态。不要提及这条系统消息。]`,
                    });
                    const reachedHardLimit = it + 1 >= MAX_TEXT_LOOPS;
                    if (reachedHardLimit) {
                        textLoopMessages.push({
                            role: 'user',
                            content: '[系统消息：工具阶段已到本轮安全上限。停止调用工具，基于已有结果直接回复；如目标未完成就如实说明。不要输出工具调用格式或提及本消息。]',
                        });
                    }
                    setSearchStatus('正在整理 MCP 工具结果...');
                    const followBody = buildMcpTextFallbackBody(baseReqBody, textLoopMessages);
                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    });
                    updateTokenUsage(data, historyMsgCount, `mcp-text-${it + 1}`);
                    if (reachedHardLimit) break;
                }
                setSearchStatus('');
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
            // 预览气泡的无缝交棒：不提前清（提前清 = 气泡集体消失→再劈里啪啦重放，用户实报），
            // 而是包装 setMessages——后处理第一条真实消息落库上屏的**同一帧**清预览。
            // 交接前预览一直挂着，交接后 instantRender 秒速回填，视觉上是"预览定格成正式消息"。
            let previewHandedOver = false;
            const previewHandoverIds = new Set<number>();
            const previewBaselineMaxId = contextMsgs.reduce(
                (maxId, message) => Math.max(maxId, message.id),
                Number.NEGATIVE_INFINITY,
            );
            const setMessagesWithPreviewHandover = (msgs: Message[]) => {
                const newlyHandedOverIds = findNewStreamPreviewHandoverIds(
                    msgs,
                    latestStreamPreviewBubbles,
                    previewBaselineMaxId,
                    previewHandoverIds,
                );
                const handoverIds = new Set(newlyHandedOverIds);
                if (streamThinkingShown) {
                    const thinkingHost = msgs.find(message =>
                        message.id > previewBaselineMaxId && message.role === 'assistant'
                    );
                    if (thinkingHost && !previewHandoverIds.has(thinkingHost.id)) handoverIds.add(thinkingHost.id);
                }
                if (handoverIds.size > 0) {
                    handoverIds.forEach(id => previewHandoverIds.add(id));
                    // ref 在 setMessages 触发渲染前同步更新，首帧就能关掉正式气泡的 fade-in。
                    onStreamPreviewHandover?.(char.id, [...handoverIds]);
                }
                setMessages(msgs);
                if (!previewHandedOver) {
                    previewHandedOver = true;
                    setStreamingBubbles([]);
                    setStreamingThinking('');
                }
            };
            const rawAiContent = data.choices?.[0]?.message?.content || '';
            const sarReply = parseSARModuleReply(rawAiContent, sarModulePlan);
            const latestUserMessage = currentMsgs.slice().reverse().find(message => (
                message.role === 'user' && message.type === 'text'
            ));
            if (sarModulePlan.user?.phase === 'active' && sarReply.userSurface && latestUserMessage?.id) {
                const userSurfaceMeta = createSARModuleSurfaceMeta(sarModulePlan.user, sarReply.userSurface);
                if (userSurfaceMeta) {
                    await DB.updateMessageMetadata(latestUserMessage.id, previous => ({
                        ...(previous || {}),
                        sarModuleSurface: userSurfaceMeta,
                    }));
                }
            }
            const assistantSurfaceMeta = sarModulePlan.character?.phase === 'active' && sarReply.assistantSurface
                ? createSARModuleSurfaceMeta(sarModulePlan.character, sarReply.assistantSurface)
                : undefined;
            const xhsCaches: XhsCaches = {
                xsecTokenCache: xsecTokenCacheRef.current,
                noteTitleCache: noteTitleCacheRef.current,
                commentUserIdCache: commentUserIdCacheRef.current,
                commentAuthorNameCache: commentAuthorNameCacheRef.current,
                commentParentIdCache: commentParentIdCacheRef.current,
            };
            await applyAssistantPostProcessing(sarReply.canonical, {
                char,
                userProfile,
                emojis,
                categories,
                realtimeConfig,
                groups,
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
                    setMessages: setMessagesWithPreviewHandover,
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
                // 流式预览已把气泡展示过 → 落库免打字延迟，秒回填（未预览时行为不变）
                instantRender: streamPreviewShown,
                // Phase 0: 本地 fetch 路径保持原逻辑, 不跳 2nd-pass LLM, 也没有结构化 directives。
                skipSecondPassLLM: false,
                directives: [],
                sarModuleSurface: assistantSurfaceMeta,
            });

            // 到这里说明正文已成功落库。失败 / 中断不会经过；重掷是替换旧回合，不重复扣寿命。
            if (!skipEmotionInjection) {
                if (sarModulePlan.character) {
                    const next = advanceSARModuleRuntime(sarModulePlan.character);
                    updateCharacter(char.id, previous => ({
                        vrState: { ...(previous.vrState || { enabled: false, intervalMinutes: 120 }), sarModule: next },
                    }));
                }
                if (sarModulePlan.user) {
                    const next = advanceSARModuleRuntime(sarModulePlan.user);
                    updateUserProfile(previous => ({
                        vrState: { ...(previous.vrState || { enabled: false }), sarModule: next },
                    }));
                }
            }

            // 本地路径回复已全部落库。OSContext 监听这个事件 bump lastMsgTimestamp——
            // 当前挂载的 Chat（可能是切走又切回后新 mount 的实例，本闭包的 setMessages
            // 对它已失效）会重新 reloadMessages；用户不在该会话时补未读 + toast。
            // instant 路径不发：它的落库回落走 'active-msg-received'（activeMsgRuntime）。
            announceChatGen(CHAT_GEN_EVENTS.replyArrived, { charId: char.id, charName: char.name });

            // 防穿帮闸：仅当这轮请求真的成功、回执确实进了模型上下文并产出已落库的
            // 回复，才标记已告知；失败/中断路径不标，下轮重新注入（回执不丢）。
            // 放在 try 成功尾部（回复已 applyAssistantPostProcessing 落库），与 catch/finally 互斥；
            // amsg2 与 Instant Push 设置页双向互斥，instant 路径在上方已 return（那条分支
            // 只为历史配置兜底保留），这里只覆盖本地 fetch 路径。
            if (amsg2ExpiredIds.length) {
                void ActiveMsgStore.markExpiredNoticesNotified(char.id, amsg2ExpiredIds);
            }

        } catch (e: any) {
            // 注意: 这个 catch 兜的是「拿到 API 响应之后」的整条后处理管线 (applyAssistantPostProcessing,
            // 13 步)。这里抛错多半不是网络问题, 而是解析/正则/落库异常。别再叫"连接中断"误导排查。
            const errMsg = e?.message || String(e);
            // 瑞一杯模式下报错: 大概率是聊天模型/中转不支持 function calling(tools) → 带 tools 一发就 400。
            // 在 APK 里看不到控制台, 这里把完整原因 + 解法存成可读消息, 方便排查。
            if (luckinChatRef?.current?.active && /\b400\b|tool|function[_\s-]?call/i.test(errMsg)) {
                await DB.saveMessage({
                    charId: char.id, role: 'system', type: 'text',
                    content: `[瑞一杯失败] ${errMsg}\n\n大概率是你当前聊天用的「模型/中转」不支持函数调用(function calling / tools)——瑞一杯靠角色自己调工具点单, 模型不支持就会直接报 400。\n解决: 换一个支持 tools 的模型/中转 (如官方 OpenAI / Claude / 多数主流中转)。\n另外确认: APK 是全新存储, 你的聊天 API 配置(密钥/地址/模型)在 APK 里填好了吗?`,
                });
            } else {
                await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[回复处理失败: ${errMsg}]` });
            }
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } finally {
            KeepAlive.stop();
            setIsTyping(false);
            // 本轮生成结束（成功/失败/中断都经过）→ 停止本地续租；远端靠 45s TTL 自然失效。
            // 未开过租约（instant push / 非 amsg2 角色）时是幂等 no-op。
            stopAmsgChatPresence(char.id);
            // 全局横幅熄灭（成功/失败/instant 均经过这里；OSContext 同时借它兜底刷新，
            // 覆盖 catch 里落库的错误系统消息）。
            announceChatGen(CHAT_GEN_EVENTS.replyEnd, { charId: char.id, charName: char.name });
            // 兜底熄「发送准备中」灯 (幂等, 正常路径 deliver() 前已熄过)。不加的话
            // config-missing / subscription-failed / 拼 context 阶段 throw 这些没走到
            // POST 的路径都不会调 onInstantPosted, 头部「发送中…」徽章会卡死到刷新
            // —— 2026-07 安卓用户实测: 订阅失败弹了错, 但三个小点到角色回复了都不消失。
            onInstantPosted?.();
            setStreamingBubbles([]);  // 错误/中断路径兜底清预览
            setStreamingThinking('');
            setRecallStatus('');
            setSearchStatus('');
            setDiaryStatus('');
            setXhsStatus('');

            // 满血主动消息：一轮聊完把该角色标脏，fire_pack 随即批量同步到 worker 的
            // client_state（未配 amsg2 任务的角色在 markDirty 内直接忽略，零成本）。
            // 本轮角色自己排过任务时 char 快照上的清单已经过期，得用工具会话里的最新那份
            // 打脏——否则本轮新建的首个任务过不了 markDirty 的 hasActiveAiTask 门，
            // fire_pack 会停在排程那一刻、少掉角色排完之后说的这段。
            // 即时对话受理成功那一轮跳过：那次 POST 已经把这一轮的 fire_pack（还多带了
            // chat 段）传上去了，这里再打脏就是同样的内容再走一趟网络。
            if (!instantChatAccepted) {
                markAmsgStateDirty({
                    char: { ...char, activeMsg2Config: amsg2Session.getConfig() },
                    userProfile, groups, realtimeConfig,
                });
            }

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
                processNewMessagesWithAutoArchive(recentMsgs, char.id, charName, mpEmb, mpLLM, userProfile?.name || '', false, (stage) => {
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

                        // 全自动记忆双写已由统一封装完成，React 外的入口也不会再漏接返回值。
                        // 轮数计数 + 自动认知消化（每50轮触发一次）
                        const shouldAutoDigest = incrementDigestRound(char.id);
                        if (shouldAutoDigest) {
                            console.log(`🧠 [AutoDigest] 已达 50 轮，自动触发认知消化...`);
                            setMemoryPalaceStatus(`${charName}闭上眼睛，开始整理内心…`);
                            const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
                            const result = await runCognitiveDigestion(
                                char.id, charName, persona, mpLLM, false, userProfile?.name, mpEmb,
                                // 消化链路可能含多次 LLM 调用（审视→历史回填续传→门牌整理），
                                // 实时刷状态条让用户知道后台在干活、别急着关页面
                                (stage) => setMemoryPalaceStatus(`${charName}${stage}`),
                            );
                            if (result) {
                                // 自我领悟不再追加到 char.selfInsights（只进不出的旧常驻层）——
                                // 归宿已改为 self_room 门牌（digestion 内部提交），这里只负责弹窗昭告
                                const total = result.resolved.length + result.deepened.length + result.faded.length +
                                    result.fulfilled.length + result.disappointed.length + result.internalized.length +
                                    result.synthesizedUser.length + result.selfInsights.length + result.selfConfused.length +
                                    (result.worries?.length || 0) + (result.aspirations?.length || 0) + (result.distilled?.length || 0);
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
        streamingBubbles,
        streamingThinking,
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

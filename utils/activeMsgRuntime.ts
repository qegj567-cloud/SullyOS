import { ActiveMsg2InboxMessage, APIConfig, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ActiveMsgStore } from './activeMsgStore';
import {
  applyAssistantPostProcessing,
  type PostProcessDirective,
  type XhsCaches,
} from './applyAssistantPostProcessing';
import { runPendingToolCalls } from './instantToolRunner';
import { drainPendingDiaries } from './pendingDiary';
import { applyEmotionEvalRaw } from './emotionApply';
import { processNewMessages } from './memoryPalace/pipeline';
import { loadMusicHooks } from '../context/MusicContext';
import type { XhsNote } from './realtimeContext';
import { appendDevDebugInstantPushLog, appendDevDebugLog, isCaptureEnabled, makeDebugLogger } from './devDebug';

// 同一个 category，两个 tag——保持 console 里现有的 [ActiveMsg] / [amsg] 标签，
// 方便用户 / 文档里 grep 历史报错信息。两条 tag 都归 instant-push 一类。
const log = makeDebugLogger('instant-push', 'ActiveMsg');
const logAmsg = makeDebugLogger('instant-push', 'amsg');

let initialized = false;
const INSTANT_TRACE_LOG_KEY = 'instant_push_trace_log_v1';
const INSTANT_TRACE_LOG_LIMIT = 200;

// 三写：console.info + 无条件 localStorage ring + 用户勾控的 devDebug。
// 参见 instantPushClient.instantTrace 的注释，两边设计一致。
function activeMsgTrace(event: string, details: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    sessionId: typeof details.sessionId === 'string' ? details.sessionId : undefined,
    event,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'n/a',
    online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
    ...details,
  };
  try {
    console.info('[InstantTrace]', entry);
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(INSTANT_TRACE_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(list) ? [...list, entry].slice(-INSTANT_TRACE_LOG_LIMIT) : [entry];
    localStorage.setItem(INSTANT_TRACE_LOG_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  // 也挂进 devDebug 的 instant-push 类目：勾了 IP 后，trace 跟 LLM 交换日志一起被
  // 复制 / 下载导出。gate 由 isCaptureEnabled('instant-push') 自动管，未勾时零成本。
  appendDevDebugLog('instant-push', { label: `trace:${event}`, data: entry });
}

// ─── push 路径模块级 XHS 共享状态 ─────────────────────────────────────────────
//
// 本地 fetch 路径 useChatAI 用 useRef 持有 5 个 cache Map + 单次调用闭包的 lastXhsNotesRef.
// 生命周期 = useChatAI mount 期间 (刷页面 / 切角色 = 清). 跨多次 send / 跨工具调用都共享.
//
// Instant push 路径在 React 之外跑 (SW postMessage → activeMsgRuntime 监听器), 没 useRef.
// 改成模块级单例: 跟本地路径"应用打开期间共享, 刷页面就清"行为字节级对齐.
//
// 跨 round 共享是关键: runXhsBrowse (round 1, 在 instantToolRunner) 填充 lastXhsNotesRef →
// /continue → worker round 2 LLM 输出 [[XHS_SHARE: 序号]] → push 落库 → applyAssistantPostProcessing
// 读同一份 ref. 上一轮笔记列表跨 SW 唤醒不丢 (只要主进程没刷新).
//
// 主进程刷新 / 浏览器关闭 → 清空, 跟本地路径 useChatAI 重 mount 清 useRef 等价.
// 不写 IndexedDB — 行为与本地路径对齐, 不引入持久化代价.
export const pushXhsCaches: XhsCaches = {
  xsecTokenCache: new Map(),
  noteTitleCache: new Map(),
  commentUserIdCache: new Map(),
  commentAuthorNameCache: new Map(),
  commentParentIdCache: new Map(),
};
export const pushLastXhsNotesRef: { current: XhsNote[] } = { current: [] };

type MemoryPalaceGlobalConfig = {
  embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number };
  lightLLM: { baseUrl: string; apiKey: string; model: string };
};

/** 从 localStorage 读 memoryPalaceConfig — OSContext 同步存的是 os_memory_palace_config key */
const loadMemoryPalaceConfigFromLocalStorage = (): MemoryPalaceGlobalConfig | undefined => {
  try {
    const raw = localStorage.getItem('os_memory_palace_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as MemoryPalaceGlobalConfig;
  } catch {
    return undefined;
  }
};

/** 从 localStorage 读 APIConfig (与 OSContext load 逻辑保持一致, 但这里在 React 之外跑) */
const loadApiConfigFromLocalStorage = (): APIConfig => {
  const fallback: APIConfig = { baseUrl: '', apiKey: '', model: '' };
  try {
    const raw = localStorage.getItem('os_api_config');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      baseUrl: parsed.baseUrl || '',
      apiKey: parsed.apiKey || '',
      model: parsed.model || '',
      ...parsed,
    };
  } catch {
    return fallback;
  }
};

/** 从 localStorage 读 RealtimeConfig — 整个 push 路径里我们不会再回连 LLM, 但 ChatParser
 *  及 DIARY 写入(可执行的副作用)需要这些配置, 缺失时返回 undefined 让消费方走 fallback。 */
const loadRealtimeConfigFromLocalStorage = (): RealtimeConfig | undefined => {
  try {
    const raw = localStorage.getItem('os_realtime_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as RealtimeConfig;
  } catch {
    return undefined;
  }
};

/**
 * 用 applyAssistantPostProcessing 把 push 收到的 inbox message 走一遍 13 步管线。
 * skipSecondPassLLM=true: 不回连 LLM (worker 现在还没续跑能力, Phase 2 才解决),
 * 二轮标签 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*) 留在
 * 原文里, 由 ChatParser.sanitize 等步骤兜底剥掉。
 * 副作用类标签 (POKE / TRANSFER / ADD_EVENT / schedule_message / 写日记) 仍会执行。
 * 失败时抛出, 由调用方决定是否重新入队。
 */
const processInboxMessageWithPostProcessing = async (message: ActiveMsg2InboxMessage): Promise<void> => {
  const characters = await DB.getAllCharacters();
  const char = characters.find(c => c.id === message.charId);
  if (!char) {
    throw new Error(`character not found for charId=${message.charId}`);
  }

  const userProfile: UserProfile = (await DB.getUserProfile())
    ?? { name: 'User', avatar: '', bio: '' };
  const emojis = await DB.getEmojis();
  const contextMsgs = await DB.getRecentMessagesByCharId(message.charId, 200);

  const apiConfig = loadApiConfigFromLocalStorage();
  const realtimeConfig = loadRealtimeConfigFromLocalStorage();

  // Phase 1: 副作用 (DIARY 写入等) 会调 DB.saveMessage, 它内部已经 fire 'messages-updated' 事件;
  // 但 OSContext 真正驱动 chat UI 重新 reloadMessages 的是 lastMsgTimestamp, 而那个 state 现在
  // 只由 'active-msg-received' handler 改。为了让 push 路径下的 per-chunk 落库也立刻反映到 UI,
  // 用一个独立的 side-channel 事件 'active-msg-progress': OSContext 监听它后只 setLastMsgTimestamp,
  // 不 fire toast / 不增加未读 / 不 resolve sendInstantPush 的 one-shot promise。
  // 单条 inbox message 进来时 fire 一次 'active-msg-received' 即可保证 toast / 未读 / 通知一次发生。
  const dispatchProgress = () => {
    window.dispatchEvent(new CustomEvent('active-msg-progress', {
      detail: { charId: message.charId },
    }));
  };

  // Phase 2 Round 2: 如果 worker 自动发的 ReasoningPush 已经被 SW 写到 reasoning_buffer,
  // 在处理"这个 sessionId 的第一条 content"时把 reasoning_content 反取出来挂到 ctx, 让 thinking
  // chain 卡片渲染到第一条 assistant message 的 metadata.thinkingChain.
  // Round 1 worker 在 0.6 one-shot 时不发 reasoning push, claimReasoning 始终返回 null — 无副作用.
  // messageIndex 来源: SW 在 saveContentToInbox 把 payload.messageIndex 写到 metadata. Round 2
  // worker 用 1-based (buildContentPush 第 1 条 → messageIndex=1); 老 worker 没这个字段, ?? 0 fallback.
  // 只对 first content claim (避免 N 条 push 同 session 时重复读 / 第 2 条挂错 metadata).
  const sessionId: string | undefined = (message as any).sessionId
    || (message.metadata && (message.metadata as any).sessionId);
  const messageIndex: number = (message as any).messageIndex
    ?? (message.metadata && (message.metadata as any).messageIndex)
    ?? 0;
  let reasoningContent: string | undefined;
  if (sessionId && messageIndex <= 1) {
    try {
      const buffered = await ActiveMsgStore.claimReasoning(sessionId);
      reasoningContent = buffered?.reasoningContent;
    } catch (e) {
      console.warn('[ActiveMsg] claimReasoning failed', sessionId, e);
    }
  }

  // 恢复本 session round 1 工具抓到的 XHS 笔记: instantToolRunner 落了库, 这里读回内存单例.
  // 跨 SW 唤醒 / 页面回收后内存 ref 被清空, 不恢复的话 round 2 的 [[XHS_SHARE]] / 评论 / 点赞
  // 会因 lastXhsNotesRef 为空而静默掉卡片. 持久化优先于内存 (同 session 时两者等价, 重载后只剩持久化).
  if (sessionId) {
    try {
      const persisted = await ActiveMsgStore.getXhsSessionNotes(sessionId);
      if (persisted?.notes?.length) {
        pushLastXhsNotesRef.current = persisted.notes as XhsNote[];
        for (const [noteId, token] of (persisted.xsecTokens || [])) {
          pushXhsCaches.xsecTokenCache.set(noteId, token);
        }
      }
    } catch (e) {
      console.warn('[ActiveMsg] restore xhs session notes failed', sessionId, e);
    }
  }

  await applyAssistantPostProcessing(message.body || '', {
    char,
    userProfile,
    emojis,
    realtimeConfig,
    contextMsgs,
    // fullMessages / initialData: worker 不会传过来 (Phase 2 才有续跑), 二轮 LLM 又被关掉,
    // 这两个字段在 skipSecondPassLLM=true 时实际上不会被消费; 给个最小占位避免 undefined NPE。
    fullMessages: [],
    initialData: null,
    historyMsgCount: contextMsgs.length,
    // 把 source / activeMsg2 元数据通过 mcdInheritMeta 继承到每条 assistant message, 这样
    // UI 还能区分 "这条是 push 来的"。
    mcdInheritMeta: {
      source: 'active_msg_2',
      activeMsg2: {
        messageId: message.messageId,
        taskId: message.taskId,
        messageType: message.messageType,
        messageSubtype: message.messageSubtype,
        avatarUrl: message.avatarUrl,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
      },
      ...(message.metadata || {}),
    },
    xhsCaches: pushXhsCaches,
    lastXhsNotesRef: pushLastXhsNotesRef,
    api: {
      baseUrl: apiConfig.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(apiConfig.apiKey ? { Authorization: `Bearer ${apiConfig.apiKey}` } : {}),
      },
      // effectiveApi 在 push 路径里没人读 — skipSecondPassLLM=true 把所有二轮 LLM 入口都堵了。
      // 留着只为满足 ctx 类型形状; Phase 2 worker 走续跑时也不会让客户端再发 LLM 请求, 所以这里
      // 长期就是个空架子, 不要花精力同步 os_api_presets / os_available_models 等运行时切换。
      effectiveApi: {
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
      },
    },
    hooks: {
      // setMessages 在 React 外面跑, 没法直接 setState, 只 fire 一次 progress 事件让
      // OSContext 推 lastMsgTimestamp, 然后 Chat.tsx 自然 reloadMessages 重新读库。
      setMessages: () => { dispatchProgress(); },
      // push 路径 deliberately 静默 toast — 避免在用户没在 chat 这个角色时狂弹 toast。
      // 如果真要给用户可见反馈, 应该走 'active-msg-received' 那条线 (toast / 未读 / 通知)。
      addToast: (msg: string, type: 'info' | 'success' | 'error') => {
        console.log('[push:toast]', type, msg);
      },
      // musicHooks: 由 MusicProvider 注册到模块级 slot, 与 useChatAI 同一份, 见 MusicContext.loadMusicHooks.
      // slot 未填充时 (理论上 MusicProvider 未 mount, 实际单页应用不会发生) 退化为 undefined,
      // ChatParser 会静默丢弃 MUSIC_ACTION 标签 — 跟 Phase 1 老行为兜底一致, 不会引入新 failure mode.
      // 注意 snapshot 时序: 这里读取的是 push 送达时的 current song, 而不是 AI 当时看到的那帧.
      // 本地 fetch 路径也有相同窗口 (LLM 响应耗时内 current 可能漂移), 接受同一 trade-off.
      musicHooks: loadMusicHooks() ?? undefined,
    },
    skipSecondPassLLM: true,
    // 把 worker hook 塞进 metadata.directives 的副作用结构化重放出来 (POKE/TRANSFER/ADD_EVENT/
    // schedule_message/MUSIC_ACTION/XHS_*). applyAssistantPostProcessing 会反向拼回 tag 喂给
    // chatParser + 内联 XHS handler.
    // amsg-instant 0.8+ 一个 user turn 可能产 N 条 push, directives 只应该
    // replay 一次. worker buildPushDecision 把 directives 挂在最后一条 push 上,
    // 这里加 isLastChunk 守卫双保险, 防未来 worker bug 在多条 push 都塞 directives.
    // 老 worker (无 messageIndex/totalMessages 字段) ?? 0 fallback, 0===0 也算 last.
    directives: isLastChunk(message) ? extractDirectives(message) : [],
    reasoningContent,
  });

  // ─── Phase 2 Round 2 (2f): push 尾段 ───
  // Memory Palace 缓冲区处理仍在这里 (跟本地 fetch 路径 finally 段对齐, 不依赖 React).
  // 情绪评估**不再这里跑** — push-tail 用 char.systemPrompt + 50 条聊天的 degraded ctx,
  // 会污染 useChatAI line 613 用 full ctx 算的 buff 状态. 改为 Option B:
  //   - 写一条 pending 标记到 KV (charId → lastPushMsgId)
  //   - dispatch 'post-push-emotion-eval' 事件
  //   - useChatAI listener 接 (char.id 匹配时) → 用当前 React state 调 buildChatRequestPayload
  //     重建 full ctx → evaluateEmotionBackground → setEvolvedNarrative + DB.saveCharacter
  //   - useChatAI mount 时 useEffect 兜底 drain (应用关 / 切其他 char 期间 push 累积的)
  // 见 hooks/useChatAI.ts 的 'post-push-emotion-eval' useEffect.
  await runPushTailPipeline(message, char, userProfile);
};

/**
 * 这条 inbox message 是不是它所在 session 的**最后一条 chunk**.
 * messageIndex == totalMessages → 最后一条 ✓
 * 都缺失 (老 worker / proactive push 单 push) → 0 === 0 也认 last
 */
function isLastChunk(message: ActiveMsg2InboxMessage): boolean {
  const mi = Number(message.metadata?.messageIndex ?? 0);
  const tm = Number(message.metadata?.totalMessages ?? 0);
  return mi === tm;
}

/** 把 worker 推给的 directives 从 inbox message metadata 里挖出来; 没有就空数组. */
function extractDirectives(message: ActiveMsg2InboxMessage): PostProcessDirective[] {
  const raw = message.metadata && (message.metadata as any).directives;
  if (!Array.isArray(raw)) return [];
  // 字段形状由 worker classifier 保证 (跟 PostProcessDirective union 一致); 这里只做轻量校验
  // 防 metadata 被改坏. 不识别的 type 不抛错, applyAssistantPostProcessing 内部 default 分支会 warn.
  return raw.filter((d) => d && typeof d === 'object' && typeof (d as any).type === 'string');
}

function getInstantSessionId(message: ActiveMsg2InboxMessage): string | undefined {
  return (message as any).sessionId
    || (message.metadata && (message.metadata as any).sessionId);
}

function getInstantMessageIndex(message: ActiveMsg2InboxMessage): number {
  return Number((message as any).messageIndex ?? (message.metadata as any)?.messageIndex ?? 0);
}

function getInstantTotalMessages(message: ActiveMsg2InboxMessage): number {
  return Number((message as any).totalMessages ?? (message.metadata as any)?.totalMessages ?? 0);
}

function toChatCompletionsUrl(baseUrl?: string): string {
  const trimmed = (baseUrl || '').trim();
  if (!trimmed) return 'instant-push';
  if (/\/chat\/completions\/?$/i.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/+$/, '')}/chat/completions`;
}

async function logInstantPushLlmExchange(message: ActiveMsg2InboxMessage): Promise<void> {
  if (!isCaptureEnabled('instant-push')) return;

  const sessionId = getInstantSessionId(message);
  if (!sessionId) return;

  try {
    const session = await ActiveMsgStore.getOutboundSession(sessionId);
    appendDevDebugInstantPushLog({
      url: toChatCompletionsUrl(session?.apiCredentials?.baseUrl),
      method: 'POST',
      status: 200,
      requestBody: session
        ? {
            transport: 'instant-push',
            sessionId,
            model: session.apiCredentials.model,
            messages: session.messages,
          }
        : {
            transport: 'instant-push',
            sessionId,
            requestUnavailable: 'outbound session not found',
          },
      response: {
        transport: 'instant-push',
        sessionId,
        messageId: message.messageId,
        messageIndex: getInstantMessageIndex(message),
        totalMessages: getInstantTotalMessages(message),
        raw_content: message.body,
        metadata: message.metadata,
      },
    });
  } catch (e) {
    console.warn('[DevDebug] instant-push LLM log failed', sessionId, e);
  }
}

/**
 * 跑 push 路径的尾段: Memory Palace 缓冲区处理 + 情绪 eval pending 标记.
 *
 * Memory Palace 直接在这里跑 (pipeline 内部 self-contained, 不依赖 React state).
 * 情绪评估走 Option B:
 *   - 写 KV pending 标记 (charId → lastPushMsgId); 用户切回这个 chat 时 useChatAI useEffect drain
 *   - 同时 dispatch 'post-push-emotion-eval' 事件; 如果 useChatAI 已 mount 这个 char 就立即跑
 *   - 不管在线/离线, eval 最终用 useChatAI 内 buildChatRequestPayload 的 full ctx 跑 — 不再 degraded.
 */
async function runPushTailPipeline(
  message: ActiveMsg2InboxMessage,
  char: import('../types').CharacterProfile,
  userProfile: UserProfile,
): Promise<void> {
  // 1. Memory Palace
  const mpConfig = loadMemoryPalaceConfigFromLocalStorage();
  const mpEmb = mpConfig?.embedding;
  const mpLLMConfigured = mpConfig?.lightLLM;
  const apiConfig = loadApiConfigFromLocalStorage();
  const mpLLM = (mpLLMConfigured?.baseUrl)
    ? mpLLMConfigured
    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };

  if ((char as any).memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
    try {
      const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
      // fire-and-forget: pipeline 内部有并发锁 + 水位线检查, 不会抢着跑两份
      void processNewMessages(
        recentMsgs,
        char.id,
        char.name,
        mpEmb,
        mpLLM,
        userProfile?.name || '',
        false,
        (stage) => { console.log('[push:memory-palace]', stage); },
      ).catch((e) => {
        console.warn('[push:memory-palace] processNewMessages failed', e);
      });
    } catch (e) {
      console.warn('[push:memory-palace] tail kickoff failed', e);
    }
  }

  // 2. 情绪评估 — 已迁到 worker (副 API): worker 跑完主回复后跑 eval, 推 emotion_update push,
  // flushInboxToChat 看到 messageType==='emotion_update' 调 applyEmotionEvalRaw 落 buff.
  // 所以这里不再触发客户端 eval (否则 worker + 客户端双跑双扣费). 见 worker/instant-push + useChatAI.

  // 顺手通过 message 触发 'emotion-updated' (跟 useChatAI line 382 一致), 让 UI 重新读 char.
  // 注意: 这里的 emotion-updated 是给 ChatHeader 的 buff 显示信号, 不是情绪 eval 完成信号 —
  // 真正的 eval 完成由 useChatAI 内 evaluateEmotionBackground 自己 dispatch 同名事件.
  try {
    window.dispatchEvent(new CustomEvent('emotion-updated', { detail: { charId: char.id } }));
  } catch { /* SSR-safe / not browser, ignore */ }
}

const flushInboxToChatImpl = async () => {
  const pendingMessages = await ActiveMsgStore.consumeInboxMessages();
  activeMsgTrace('runtime-flush-start', { count: pendingMessages.length });
  // consumeInboxMessages 是 "先 ack 后处理" 语义 —— inbox 已经原子地清空。
  // 这里 per-message try/catch: 单条处理抛错 (quota / DB 故障 / postprocess 异常) 不连累
  // 后续条目。Phase 1 改成: 先尝试走 applyAssistantPostProcessing (与本地 fetch 路径
  // 行为对齐 — emoji / 翻译 / HTML / 引用 / chunking 全部复用同一管线); 如果走管线失败,
  // 降级回原来的 "原文一次性 saveMessage" 防止消息丢失。dispatchEvent 始终 fire 一次,
  // 保证 toast / 未读 / 通知 / sendInstantPush resolver 语义不变。
  for (const message of pendingMessages) {
    const messageTimestamp = message.sentAt || message.receivedAt || Date.now();
    activeMsgTrace('runtime-inbox-message', {
      sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
      messageId: message.messageId,
      charId: message.charId,
      messageType: message.messageType,
      bodyChars: typeof message.body === 'string' ? message.body.length : undefined,
    });

    // emotion_update: worker 跑完副 API 情绪评估后推回的 buff 结果. 不渲染成聊天消息, 直接落 buff +
    // 广播 innerState (useChatAI 监听 'emotion-innerstate-updated' → setEvolvedNarrative 喂下一轮).
    // 识别条件用 messageType==='emotion_update' 或 metadata.emotionRaw 存在 —— 后者兜底旧 SW
    // (<1.8.0 不认 emotion_update messageKind, 会把它当 content 存进 inbox, 但 metadata.emotionRaw
    // 仍被 saveContentToInbox 透传进来). 这样情绪落地不依赖 SW 是否升级.
    if (message.messageType === 'emotion_update' || (message.metadata as any)?.emotionRaw) {
      const emotionRaw = (message.metadata as any)?.emotionRaw;
      if (emotionRaw) {
        try {
          const chars = await DB.getAllCharacters();
          const ch = chars.find((c) => c.id === message.charId);
          if (ch) {
            const innerState = await applyEmotionEvalRaw(String(emotionRaw), ch);
            if (innerState) {
              window.dispatchEvent(new CustomEvent('emotion-innerstate-updated', {
                detail: { charId: message.charId, innerState },
              }));
            }
          }
        } catch (e) {
          console.warn('[flush:emotion_update] apply failed', e);
        }
      }
      // 无论成功与否都通知 useChatAI 熄灭 "情绪更新中" 徽章 (buff 已落 / 或这轮没结果).
      try {
        window.dispatchEvent(new CustomEvent('instant-emotion-done', { detail: { charId: message.charId } }));
      } catch { /* SSR-safe */ }
      activeMsgTrace('runtime-emotion-done', {
        sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
        messageId: message.messageId,
        charId: message.charId,
      });
      continue;
    }

    // 白名单制: AI 文本类型基本封闭 (amsg-shared MESSAGE_TYPE 4 个 + SullyOS 3 个 legacy 别名);
    // 非 AI 类型 (forum / event / system / 未来扩展) 不可枚举, 不进 post-processing 防把它们当 AI 输出乱解析.
    // Phase 1 老白名单只列了 text/assistant/normal, 漏了整个 amsg-shared 集合, 导致所有 push 都
    // 走 raw fallback (post-processing / directive 重放 / emoji / chunking 全部跳过). Round 2 补全.
    const ASSISTANT_TEXT_TYPES = new Set([
      // SullyOS legacy
      'text', 'assistant', 'normal',
      // amsg-shared MESSAGE_TYPE union (instant/fixed/prompted/auto) — 全是 LLM 输出
      'instant', 'fixed', 'prompted', 'auto',
    ]);
    const looksLikeAssistantText = !message.messageType
      || ASSISTANT_TEXT_TYPES.has(message.messageType);

    let routed = false;

    if (looksLikeAssistantText) {
      try {
        await logInstantPushLlmExchange(message);
        await processInboxMessageWithPostProcessing(message);
        routed = true;
      } catch (postErr) {
        log.warn('post-processing failed, falling back to raw save', { messageId: message.messageId, error: postErr });
        // 落库失败: 有可能 post-processing 中途已经写了部分 chunk 进 DB, 这里再 raw save 一遍
        // 会重复; 但中途失败时通常是初始化阶段就挂了 (char 找不到 / DB 故障), 部分写入概率低。
        // 为了不丢消息, 仍尝试 raw save; 若它也失败, 会进下面的 catch 把消息 requeue。
        // TODO(Phase 2): worker 续跑落地后, 这里的"部分写入 + raw save 重复"窗口要改成基于
        // sessionId 的 dedupe (worker push payload 会带稳定 id), 而不是依赖低概率假设。
      }
    }

    if (!routed) {
      try {
        await DB.saveMessage({
          charId: message.charId,
          role: 'assistant',
          type: 'text',
          content: message.body,
          timestamp: messageTimestamp,
          metadata: {
            source: 'active_msg_2',
            activeMsg2: {
              messageId: message.messageId,
              taskId: message.taskId,
              messageType: message.messageType,
              messageSubtype: message.messageSubtype,
              avatarUrl: message.avatarUrl,
              sentAt: message.sentAt,
              receivedAt: message.receivedAt,
            },
            ...(message.metadata || {}),
          },
        });
      } catch (e) {
        log.warn('saveMessage failed, requeue to inbox', { messageId: message.messageId, error: e });
        try {
          await ActiveMsgStore.saveInboxMessage(message);
        } catch (reputErr) {
          // re-put 也挂了 (大概率同一根因, 比如 quota / DB 关停), 没救了, 至少留个日志
          log.error('requeue failed, message lost', { messageId: message.messageId, error: reputErr });
        }
        // requeue 后跳过这条消息的 dispatchEvent —— UI 不该误以为收到了
        continue;
      }
    }

    // 不管走 post-processing 还是 raw fallback, 单条 inbox message 触发一次 'active-msg-received',
    // 保留原有 toast / 未读 / 通知 / sendInstantPush resolver 语义。body 用原文做预览即可。
    window.dispatchEvent(new CustomEvent('active-msg-received', {
      detail: {
        charId: message.charId,
        charName: message.charName,
        body: message.previewBody || message.body,
        avatarUrl: message.avatarUrl,
        sentAt: messageTimestamp,
      },
    }));
    activeMsgTrace('runtime-active-msg-received-dispatched', {
      sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
      messageId: message.messageId,
      charId: message.charId,
    });
  }
};

// 串行化所有 flush. 两个原因:
//   1. 防并发 flush 交错 saveMessage —— 显示顺序 = IndexedDB 自增 id = saveMessage 调用先后
//      (见 db.ts getRecentMessagesByCharId 按 charId 索引游标取, 即 id 顺序), 并发就会乱序.
//   2. 返回的 promise 在"本次及之前排队的 flush"全部完成后才 resolve, 这样调用方能
//      await flushInboxToChat() 保证 round-1 旁白已落库, 再去跑 tool runner (它会触发 round-2),
//      从根上消除跨轮 B 抢在 A 前面入库 (用户看到的 "B+A").
// 每段都吞掉自身异常, 保证链不被一个失败的 flush 卡死.
let flushChain: Promise<void> = Promise.resolve();
const flushInboxToChat = (): Promise<void> => {
  const next = flushChain.then(async () => {
    try {
      await flushInboxToChatImpl();
    } catch (e) {
      log.warn('flushInboxToChat failed', { error: e });
    }
  });
  flushChain = next;
  return next;
};

// Phase 2 Round 2: 真实 tool runner. 启动时排空 + SW postMessage 触发. 失败诊断在 instantToolRunner 内.
const runPendingToolCallsSafely = async () => {
  try {
    await runPendingToolCalls();
  } catch (e) {
    console.warn('[instant-push] runPendingToolCalls failed', e);
  }
};

/**
 * 思维链(心象)回填: SW 收到 reasoning push 写完 buffer 后会 fire 'active-msg-reasoning'.
 *
 * 正常情况 worker 先发 reasoning 再发 content, reasoning 先落 buffer, content flush 时
 * claimReasoning 取到并挂上 thinkingChain. 但 reasoning / content 是两条独立 Web Push,
 * 弱网/移动端到达或处理顺序可能反转: content 抢先 flush 时 claimReasoning 拿到 null, 首条
 * 回复落库时没有 thinkingChain, 之后到的 reasoning 永远不再被 claim → 思维链丢失.
 *
 * 这里在 reasoning 到达后补一刀: 若该 session 的首条 assistant 回复已落库且还没挂 thinkingChain,
 * 就 claim 出 reasoning 回填到那条消息的 metadata, 再 fire progress 让 Chat 重渲染.
 * 若首条回复还没落库 (reasoning 先到的正常情形), 不 claim、留 buffer 给正常路径, 这里是 no-op.
 */
const backfillReasoningSafely = async (sessionId?: string, charId?: string): Promise<void> => {
  if (!sessionId || !charId) return;
  try {
    const msgs = await DB.getRecentMessagesByCharId(charId, 200);
    const sessionMsgs = msgs
      .filter((m) => m.role === 'assistant' && (m.metadata as any)?.sessionId === sessionId)
      .sort((a, b) => ((a as any).id ?? 0) - ((b as any).id ?? 0));
    if (sessionMsgs.length === 0) return; // content 还没落库, 留给正常 claim 路径
    const first = sessionMsgs[0] as any;
    if (first.metadata?.thinkingChain) return; // 正常 claim 已挂上, 不重复
    if (typeof first.id !== 'number') return;

    const buffered = await ActiveMsgStore.claimReasoning(sessionId);
    const reasoning = buffered?.reasoningContent;
    if (!reasoning) return;

    await DB.updateMessageMetadata(first.id, (prev: any) => ({ ...(prev || {}), thinkingChain: reasoning }));
    window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
  } catch (e) {
    console.warn('[ActiveMsg] backfill reasoning failed', sessionId, e);
  }
};

const handleDeepLink = () => {
  const currentUrl = new URL(window.location.href);
  const charId = currentUrl.searchParams.get('activeMsgCharId');
  const openApp = currentUrl.searchParams.get('openApp');

  if (openApp === 'chat' && charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', {
      detail: { charId },
    }));
    currentUrl.searchParams.delete('openApp');
    currentUrl.searchParams.delete('activeMsgCharId');
    window.history.replaceState({}, '', currentUrl.toString());
  }
};

export const ActiveMsgRuntime = {
  async init() {
    if (initialized) return;
    initialized = true;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const type = event.data?.type;
        if (type) {
          activeMsgTrace('runtime-sw-message', {
            type,
            sessionId: event.data?.sessionId,
            charId: event.data?.charId,
          });
        }
        if (type === 'active-msg-received') {
          void flushInboxToChat();
          return;
        }

        if (type === 'active-msg-reasoning') {
          // 先确保已到的 content 落库 (flush 链串行), 再尝试把思维链回填到首条回复上.
          void flushInboxToChat().then(() =>
            backfillReasoningSafely(event.data?.sessionId, event.data?.charId),
          );
          return;
        }

        if (type === 'REI_AMSG_PUSH') {
          const subEvent = event.data?.event;
          const payload = event.data?.payload;

          if (subEvent === 'rei-amsg-multipart-expired') {
            logAmsg.warn('multipart expired', payload);
            window.dispatchEvent(new CustomEvent('active-msg-error', {
              detail: { message: '消息接收不完整，部分内容可能丢失' }
            }));
          }
          return;
        }

        // Phase 2 Round 2: SW 收到 tool_request push 且当前 window visible → 跑 runner.
        // 不 visible 时 SW 发的是 showNotification, 用户点击后落到 active-msg-open 分支,
        // ActiveMsgRuntime.init 时这里的启动消费会兜底 (runPendingToolCallsSafely).
        // 先 flush 再跑 runner: 同一轮的旁白 (round-1 prefix) 是单独的 content push, 必须保证
        // 它先入库, 再让 runner 触发 round-2, 否则 round-2 回复可能抢在旁白前面 ("B+A").
        if (type === 'instant-tool-request') {
          void flushInboxToChat().then(() => runPendingToolCallsSafely());
          return;
        }

        if (type === 'active-msg-open') {
          // 严格串行: 先把 inbox 里的 round-1 旁白落库, 再跑 tool runner (它会触发 round-2),
          // 保证用户回到界面时先看到旁白, 且 round-2 回复排在旁白之后.
          void (async () => {
            await flushInboxToChat();
            window.dispatchEvent(new CustomEvent('active-msg-open', {
              detail: { charId: event.data?.charId },
            }));
            await runPendingToolCallsSafely();
          })();
        }
      });
    }

    // 回到前台兜底: 后台期间 SW 收到 push 写进 inbox 后会 postMessage 触发 flushInboxToChat,
    // 但页面被冻结 (iOS PWA / 移动端后台) 时那条 postMessage 可能丢失, 导致回前台后消息卡在 inbox
    // 里不刷新 ("离开后台消息不返回"). 这里 visibilitychange→visible 主动 flush 一次兜底.
    // 同时排空"待写日记"队列 (写 Notion/飞书的网络 fetch 后台会被冻结打断, 预写进 pendingDiary,
    // 回前台 fetch 可靠时补打) + pending tool calls.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        // 先 await flush 落库 round-1 旁白, 再跑 runner 触发 round-2, 避免 "B+A".
        void (async () => {
          await flushInboxToChat();
          void drainPendingDiaries(loadRealtimeConfigFromLocalStorage(), (charId) => {
            window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
          });
          void runPendingToolCallsSafely();
        })();
      });
    }

    // 启动兜底: 先 flush 落库 (含上次被杀进程时卡在 inbox 的 round-1 旁白), 再跑 runner
    // 触发 round-2, 保证冷启动恢复时旁白也排在 round-2 回复之前.
    await flushInboxToChat();
    await runPendingToolCallsSafely();
    void drainPendingDiaries(loadRealtimeConfigFromLocalStorage(), (charId) => {
      window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
    });
    handleDeepLink();
  },
};

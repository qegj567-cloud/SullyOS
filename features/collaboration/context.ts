import type { CharacterProfile, Emoji, EmojiCategory, GroupProfile, Message, RealtimeConfig, UserProfile } from '../../types';
import { ContextBuilder } from '../../utils/context';
import { buildChatRequestPayload } from '../../utils/chatRequestPayload';
import { ChatPrompts } from '../../utils/chatPrompts';
import { buildThinkingChainPrompt } from '../../utils/thinkingChainPrompt';
import { MemoryNodeDB } from '../../utils/memoryPalace/db';
import { injectMemoryPalace } from '../../utils/memoryPalace/pipeline';
import type { MemoryNode } from '../../utils/memoryPalace/types';
import type { CollaborationContextMessage, CollaborationMakerKind, CollaborationMessage, CollaborationMode } from './types';
import { getCollaborationMakerPrompt } from './makers';

const COLLABORATION_PROTOCOL = `### 协同工作规则
这是一个由用户主动打开的独立协同会话。你仍然是角色本人，但这间窗口以把事情可靠地做完为第一目标。

- 主动拆解、执行、检查并交付；只有缺少会改变结果的关键信息时才询问。
- 保持你自己的语言习惯和判断，不要变成没有人格的客服，也不要为了演绎而拖延任务。
- 可以阅读用户在本会话上传的文件和参考图片。PDF 会标明页数并提取全文；图片会以视觉输入或识图描述提供。不要假装读到了没有提供的内容。
- 普通聊天正文默认使用 Markdown 排版，但这不代表只能生成 .md。用户选择或点名 Word、PDF、TXT、HTML、JSON、Markdown 时，必须按指定格式交付真正的文件。
- 不能只说“我已经生成了文件”。需要交付文件时，在自然回复之后输出一个或多个 artifact 块，由前端真正制作文件。
- artifact 块必须严格使用下面的形式，format 可选 txt、md、html、json、docx、pdf：

\`\`\`artifact
title: 文件名（不含扩展名）
format: docx
---
这里放完整文件正文，可以使用 Markdown 排版。
\`\`\`

- artifact 块之外的文字会作为你发给用户的聊天消息；不要向用户解释这个内部格式。
- 这间窗口能真正渲染普通文字、Markdown、表情包、语音条、文件与可安装作品。不要输出这里没有实现的 ChatApp 动作：引用、戳一戳、转账、日历、定时消息、搜索、读写日记、HTML 聊天气泡或其它 [[ACTION:...]] / [[RECALL:...]] 指令。
- 本窗口与其它协同窗口互不共享对话，也不会自动写回日常聊天或角色记忆。`;

const collaborationThinkingPrompt = (char: CharacterProfile, user: UserProfile): string => {
  if (!char.showThinkingChain) return '';
  const custom = (char.thinkingChainCustomPrompt || '').trim();
  return `\n\n${buildThinkingChainPrompt(char.name, user.name)}${custom ? `\n\n### 用户追加的心象规则\n${custom}` : ''}`;
};

const collaborationRichOutputPrompt = (
  char: CharacterProfile,
  emojis: Emoji[] = [],
  categories: EmojiCategory[] = [],
): string => {
  const visible = ChatPrompts.filterVisibleEmojis(emojis, categories, char.id);
  const emojiRule = visible.emojis.length > 0
    ? `- 可以发送表情包；只使用 \`[[SEND_EMOJI: 表情名称]]\`，可用表情为：${ChatPrompts.buildEmojiContext(visible.emojis, visible.categories)}。`
    : '- 当前没有可用表情包，不要输出 SEND_EMOJI。';
  const voiceRule = char.chatVoiceEnabled
    ? `- 可以发送语音条；使用 \`<语音>真正朗读的台词</语音>\`。${char.chatVoiceLang ? '若是外语语音，紧跟 `<字幕>中文对照</字幕>`。' : ''}语音会由协同界面真实渲染和播放，不要把标签当普通文字解释。`
    : '- 当前角色没有开启语音消息，不要输出 `<语音>` 或 `<字幕>`。';
  return `

### 协同窗口可交付的消息形态
${emojiRule}
${voiceRule}
- 除上述两种外，ChatApp 的动作标签在本窗口都不可用。要办正事就用文字、Markdown、artifact 文件或当前制作类型的 installable 作品交付。`;
};

const normalizeForSearch = (value: string): string => value.toLowerCase().normalize('NFKC');

const searchTokens = (value: string): Set<string> => {
  const normalized = normalizeForSearch(value).slice(0, 50_000);
  const tokens = new Set<string>();
  (normalized.match(/[a-z0-9_@.-]{2,}/g) || []).forEach(token => tokens.add(token));
  const cjkRuns = normalized.match(/[\u3400-\u9fff\uf900-\ufaff]{2,}/g) || [];
  cjkRuns.forEach(run => {
    for (let index = 0; index < run.length - 1; index++) tokens.add(run.slice(index, index + 2));
  });
  return tokens;
};

const memoryScore = (node: MemoryNode, queryTokens: Set<string>, now: number): number => {
  const haystack = normalizeForSearch([
    node.content,
    ...(node.tags || []),
    ...(node.entities || []).flatMap(entity => [entity.name, ...(entity.aliases || [])]),
  ].join(' '));
  let overlap = 0;
  queryTokens.forEach(token => {
    if (haystack.includes(token)) overlap += token.length > 2 ? 4 : 2;
  });
  const ageDays = Math.max(0, (now - (node.lastAccessedAt || node.createdAt || now)) / 86_400_000);
  const recency = Math.max(0, 2.5 - Math.log10(ageDays + 1));
  return overlap + Math.max(0, Math.min(10, node.importance || 0)) * 0.35 + recency + (node.pinnedUntil && node.pinnedUntil > now ? 3 : 0);
};

export const selectCollaborationMemories = (
  nodes: MemoryNode[],
  query: string,
  limit: number,
  now = Date.now(),
): MemoryNode[] => {
  const queryTokens = searchTokens(query);
  return nodes
    .filter(node => !node.archived && !node.groupId && !!node.content?.trim())
    .map(node => ({ node, score: memoryScore(node, queryTokens, now) }))
    .sort((a, b) => b.score - a.score || b.node.createdAt - a.node.createdAt)
    .slice(0, Math.max(0, limit))
    .map(item => item.node);
};

const formatMemoryBlock = (nodes: MemoryNode[], userName: string): string => {
  if (nodes.length === 0) return '';
  return `### 与本次任务相关的记忆\n${nodes.map(node => `- [${node.room === 'user_room' ? `${userName}的房间` : node.room}] ${node.content}`).join('\n')}\n\n`;
};

export interface BuildCollaborationContextInput {
  char: CharacterProfile;
  user: UserProfile;
  mode: CollaborationMode;
  taskText: string;
  emojis?: Emoji[];
  categories?: EmojiCategory[];
}

export const buildCollaborationContextSnapshot = async ({
  char,
  user,
  mode,
  emojis = [],
  categories = [],
}: BuildCollaborationContextInput): Promise<string> => {
  if (mode === 'focused') {
    return [
      '[System: Focused Collaboration Character Context]\n',
      ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true }),
      char.description?.trim() ? `### 用户对你的备注/称呼\n${char.description.trim()}\n\n` : '',
      `### 互动对象\n- 名字: ${user.name}\n- 设定/备注: ${user.bio || '无'}\n\n`,
      `### 当前模式\n用户选择了“中度协同”：保留完整核心人格、世界观和用户设定；不载入世界书、用户印象或其它协同窗口。任务相关记忆会在每一次发送时重新召回，最多 5 条。\n\n`,
      COLLABORATION_PROTOCOL,
      collaborationRichOutputPrompt(char, emojis, categories),
      collaborationThinkingPrompt(char, user),
    ].join('');
  }

  const staticChar: CharacterProfile = {
    ...char,
    // This snapshot is already inside the real collaboration window. Do not
    // carry ChatApp's tiny “you can guide the user to collaboration” notice
    // back into the workspace and create contradictory location instructions.
    chatCollaborationEnabled: false,
    memoryPalaceEnabled: false,
    memoryPalaceInjection: '',
    roomPlatesInjection: '',
  };
  return [
    ContextBuilder.buildCoreContext(staticChar, user, true, undefined, undefined, {
      conversational: true,
      skipTimeAwareness: false,
    }),
    `### 当前模式\n用户选择了“沉浸式协同”：完整保留角色、关系、世界观、世界书、用户印象和日常记忆，同时把完成当前任务放在本会话的最前面。任务相关记忆会像 ChatApp 一样在每一次发送时重新召回；其它协同窗口的对话仍不进入这里。\n\n`,
    COLLABORATION_PROTOCOL,
    collaborationRichOutputPrompt(char, emojis, categories),
    collaborationThinkingPrompt(char, user),
  ].join('');
};

export interface BuildLiveCollaborationChatContextInput {
  char: CharacterProfile;
  user: UserProfile;
  groups: GroupProfile[];
  emojis: Emoji[];
  categories: EmojiCategory[];
  recentChatMessages: Message[];
  mode?: CollaborationMode;
  chatContextLimit?: number;
  realtimeConfig?: RealtimeConfig;
}

/**
 * Build the ChatApp bridge for one collaboration request. This intentionally
 * runs on every send: only the selected latest rows (or ChatApp's effective
 * user-configured range) are read, and a collaboration session never freezes
 * an increasingly stale chat transcript.
 */
export const buildLiveCollaborationChatContext = async ({
  char,
  user,
  groups,
  emojis,
  categories,
  recentChatMessages,
  mode = 'immersive',
  chatContextLimit = 20,
  realtimeConfig,
}: BuildLiveCollaborationChatContextInput): Promise<{
  contextSnapshot: string;
  chatContextSnapshot: CollaborationContextMessage[];
}> => {
  const history = selectRecentCollaborationChatMessages(recentChatMessages, chatContextLimit);
  // Memory Palace is deliberately omitted here: collaboration adds a fresh
  // recall block on every turn through its own isolated entry point.
  const staticChar: CharacterProfile = {
    ...char,
    chatCollaborationEnabled: false,
    memoryPalaceEnabled: false,
    memoryPalaceInjection: '',
    roomPlatesInjection: '',
  };
  const payload = await buildChatRequestPayload({
    char: staticChar,
    userProfile: user,
    groups,
    emojis,
    categories,
    historyMsgs: history,
    recentMsgsHint: history.slice(-200),
    contextLimit: Math.max(1, history.length),
    realtimeConfig,
    // Collaboration renders Markdown/files/installables rather than ChatApp's
    // HTML bubble protocol. Keeping it enabled would expose raw [html] blocks.
    htmlMode: { enabled: false },
    thinkingChain: {
      enabled: !!(char as CharacterProfile & { showThinkingChain?: boolean }).showThinkingChain,
      customPrompt: (char as CharacterProfile & { thinkingChainCustomPrompt?: string }).thinkingChainCustomPrompt,
    },
    stripImages: true,
  });

  const fullChatContext: CollaborationContextMessage[] = payload.fullMessages
    .map(message => {
      const role: CollaborationContextMessage['role'] = message.role === 'user' || message.role === 'assistant'
        ? message.role
        : 'system';
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
      return { role, content };
    })
    .filter(message => !!message.content.trim());
  const chatContextSnapshot = mode === 'immersive'
    ? fullChatContext
    : fullChatContext.filter(message => message.role === 'user' || message.role === 'assistant');

  return {
    contextSnapshot: [
      mode === 'immersive'
        ? `### 当前模式\n用户选择了“沉浸式协同”：上方内容直接来自 ChatApp 本人的 ContextBuilder；最近 ${history.length} 条聊天会在每次生成时重新读取而非冻结。在完整保留角色、关系和当下对话连续性的同时，把完成当前任务放在本窗口的最前面。任务相关记忆会在每次发送时重新召回；其它协同窗口的对话仍不进入这里。\n\n`
        : `### ChatApp 实时聊天衔接\n最近 ${history.length} 条聊天会在每次生成时重新读取而非冻结。\n\n`,
      COLLABORATION_PROTOCOL,
      collaborationRichOutputPrompt(char, emojis, categories),
    ].join(''),
    chatContextSnapshot: [
      { role: 'system', content: history.length > 0
        ? '### ChatApp 私聊记录开始\n以下是已读取的当前角色私聊记录，可以用于本次任务；它们不是本协同窗口的历史。只能引用实际提供的内容，范围以外的对话未提供。'
        : '### ChatApp 私聊记录\n本次未带入私聊原文（用户关闭读取，或当前设定范围内无记录）。不要声称看到了未提供的对话。' },
      ...chatContextSnapshot,
      { role: 'system', content: '### ChatApp 私聊记录结束\n下方进入当前协同窗口；用户提及 ChatApp 时，请先查阅上方已提供的私聊记录，而不是仅凭窗口独立就判定不可见。' },
    ],
  };
};

export const selectRecentCollaborationChatMessages = (
  messages: Message[],
  limit: number,
): Message[] => {
  if (limit <= 0) return [];
  return messages.slice(-limit);
};

const formatAttachmentContext = (message: CollaborationMessage): string => {
  const attachments = message.attachments || [];
  if (attachments.length === 0) return '';
  return attachments.map(attachment => {
    const text = attachment.extractedText?.trim();
    const isImage = /^image\//i.test(attachment.mimeType);
    if (!text && isImage) return `\n\n[用户上传参考图片：${attachment.name}；图片数据将作为视觉输入发送]`;
    if (!text) return `\n\n[附件：${attachment.name}，未提取到可读正文]`;
    const label = attachment.kind === 'artifact'
      ? '本会话已生成文件'
      : isImage
        ? '用户上传参考图片（已识图）'
        : '用户上传文件';
    const coverage = attachment.pageCount ? `；PDF 共 ${attachment.pageCount} 页` : '';
    return `\n\n[${label}：${attachment.name}${coverage}]\n${text}`;
  }).join('');
};

const formatRequestedOutput = (message: CollaborationMessage): string => message.requestedFormat
  ? `\n\n[本轮文件交付格式：${message.requestedFormat}。若本轮需要交付成果，必须输出该格式的 artifact 真文件，不要只在聊天正文中给 Markdown。]`
  : '';

const collaborationMessagesForRecall = (
  messages: CollaborationMessage[],
  charId: string,
): Message[] => messages
  .filter(message => message.role === 'user' || message.role === 'assistant')
  .slice(-200)
  .map((message, index) => ({
    id: Math.max(1, Math.floor(message.createdAt)) + index,
    charId,
    role: message.role as 'user' | 'assistant',
    type: 'text',
    content: `${message.content}${formatRequestedOutput(message)}${formatAttachmentContext(message)}`.slice(0, 30_000),
    timestamp: message.createdAt,
  }));

/**
 * Dynamic Memory Palace layer for one collaboration turn.
 * The character/context snapshot stays isolated, while recall follows the
 * current message and this session's own history every time the user sends.
 */
export const buildCollaborationTurnMemoryContext = async (input: {
  char: CharacterProfile;
  user: UserProfile;
  mode: CollaborationMode;
  messages: CollaborationMessage[];
  taskText: string;
}): Promise<string> => {
  const { char, user, mode, messages, taskText } = input;
  if (!char.memoryPalaceEnabled) return '';
  const recallChar: CharacterProfile = {
    ...char,
    memoryPalaceInjection: '',
    roomPlatesInjection: '',
  };
  const query = [
    taskText,
    ...messages.slice(-6).map(message => message.content),
  ].filter(Boolean).join('\n').slice(-80_000);
  try {
    await injectMemoryPalace(
      recallChar,
      collaborationMessagesForRecall(messages, char.id),
      query,
      user.name,
      {
        entryPoint: 'collaboration',
        formatterMaxOutputItems: mode === 'focused' ? 5 : 15,
      },
    );
  } catch (error) {
    console.warn('[Collaboration] per-turn memory recall failed', error);
  }

  let recalled = (recallChar.memoryPalaceInjection || '').trim();
  // No embedding configuration should not turn collaboration memory into an
  // all-or-nothing feature. Fall back to the existing local lexical scorer.
  if (!recalled) {
    try {
      const nodes = await MemoryNodeDB.getByCharId(char.id);
      recalled = formatMemoryBlock(
        selectCollaborationMemories(nodes, query, mode === 'focused' ? 5 : 15),
        user.name,
      ).trim();
    } catch (error) {
      console.warn('[Collaboration] local memory recall fallback unavailable', error);
    }
  }
  const roomPlates = (recallChar.roomPlatesInjection || '').trim();
  if (!roomPlates && !recalled) return '';
  return [
    '### 本轮动态记忆（仅本次请求）',
    '以下内容在用户每次发送时按当前任务重新召回；不要把它当成其它协同窗口的对话。',
    roomPlates,
    recalled,
  ].filter(Boolean).join('\n\n');
};

/** Remove the one-time recall embedded by pre-upgrade collaboration sessions. */
export const stripFrozenCollaborationMemoryContext = (source: string): string => source
  .replace(/(^|\n)### 与本次任务相关的记忆\n[\s\S]*?(?=\n### 当前模式|$)/g, '$1')
  .replace(/(^|\n)### (?:记忆宫殿 \(Memory Palace\)|底色认知 \(Resident Knowledge\))\n[\s\S]*?(?=\n### [^#\n]|$)/g, '$1')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
}

// 一篇完整论文常会超过 180k 字符。协同附件已经在上传边界限制到 300k，
// 这里要让它在“上传后的下一轮追问”里仍能留下，而不是只剩模型上一轮提到的摘要。
const MAX_HISTORY_CHARS = 420_000;

export const buildCollaborationModelMessages = (
  contextSnapshot: string,
  messages: CollaborationMessage[],
  makerKind?: CollaborationMakerKind,
  chatContextSnapshot: CollaborationContextMessage[] = [],
  turnContext = '',
): ModelMessage[] => {
  const mapped = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({
      role: message.role as 'user' | 'assistant',
      content: `${message.content}${formatRequestedOutput(message)}${formatAttachmentContext(message)}`.trim(),
    }))
    .filter(message => !!message.content);

  let budget = MAX_HISTORY_CHARS;
  const kept: ModelMessage[] = [];
  for (let index = mapped.length - 1; index >= 0; index--) {
    const message = mapped[index];
    if (message.content.length <= budget || kept.length < 2) {
      kept.push(message);
      budget -= Math.min(message.content.length, budget);
      continue;
    }
    break;
  }
  kept.reverse();
  const omitted = kept.length < mapped.length
    ? [{ role: 'system' as const, content: `[较早的 ${mapped.length - kept.length} 条本窗口消息因上下文长度限制未发送。]` }]
    : [];
  const makerPrompt = getCollaborationMakerPrompt(makerKind);
  const cleanContextSnapshot = stripFrozenCollaborationMemoryContext(contextSnapshot);
  const cleanChatContextSnapshot = chatContextSnapshot.map(message => ({
    ...message,
    content: stripFrozenCollaborationMemoryContext(message.content),
  })).filter(message => !!message.content);
  return [
    ...(cleanChatContextSnapshot.length > 0 ? cleanChatContextSnapshot : [{ role: 'system' as const, content: cleanContextSnapshot }]),
    ...(cleanChatContextSnapshot.length > 0 ? [{ role: 'system' as const, content: cleanContextSnapshot }] : []),
    ...(makerPrompt ? [{ role: 'system' as const, content: makerPrompt }] : []),
    ...omitted,
    ...(turnContext.trim() ? [{ role: 'system' as const, content: turnContext.trim() }] : []),
    ...kept,
  ];
};

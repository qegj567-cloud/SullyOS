/** Audit reproductions: compare real prompt builders and real IndexedDB adoption. */
import { afterEach, expect, it, vi } from 'vitest';
import { DB } from './db';
import { ActiveMsgClient, buildFirePack } from './activeMsgClient';
import { getThinkingChainSettings } from './thinkingChainPrompt';
import { buildChatRequestPayload } from './chatRequestPayload';
import { ActiveMsgStore } from './activeMsgStore';
import { catchUpMissedPushes, flushInboxToChat } from './activeMsgRuntime';
import { applyAssistantPostProcessing } from './applyAssistantPostProcessing';
import { processLLMRound, createFireSessionState } from '../worker/amsg/src/agentic';
import { AMSG_OUTBOX_ADOPTED_LS_KEY, drainOutbox } from './amsgInstantChat';
import { RoomPlateDB } from './memoryPalace/db';

afterEach(() => { vi.restoreAllMocks(); });

it.each([
  { mode: undefined, custom: 'AUDIT_THINKING_CUSTOM_RULE', enabled: true, hasDefault: true },
  { mode: 'append', custom: '', enabled: true, hasDefault: true },
  { mode: 'replace', custom: 'AUDIT_THINKING_CUSTOM_RULE', enabled: true, hasDefault: false },
  { mode: 'replace', custom: '   ', enabled: true, hasDefault: false },
  { mode: 'replace', custom: 'AUDIT_THINKING_CUSTOM_RULE', enabled: false, hasDefault: false },
])('applies thinking mode $mode (enabled=$enabled, custom="$custom") to instant and scheduled prompts', async ({ mode, custom, enabled, hasDefault }) => {
  const char = {
    id: 'audit-context-char', name: '角色', memories: [], memoryPalaceEnabled: false,
    htmlModeEnabled: true, htmlModeCustomPrompt: 'AUDIT_HTML_CUSTOM_RULE',
    showThinkingChain: enabled, thinkingChainCustomPrompt: custom, thinkingChainPromptMode: mode,
    activeMsg2Config: { enabled: true, tasks: [] },
  } as any;
  const userProfile = { name: '用户', thinkingChainPrompt: { mode: 'replace', customPrompt: 'SPACE_RULE' } } as any;
  localStorage.setItem(`chat_translate_enabled_${char.id}`, 'true');
  localStorage.setItem(`chat_translate_source_lang_${char.id}`, '日语');
  localStorage.setItem(`chat_translate_lang_${char.id}`, '中文');
  const chat = await buildChatRequestPayload({
    char, userProfile, groups: [], emojis: [], categories: [], historyMsgs: [], contextLimit: 20,
    timelyByWorker: true,
    translationConfig: { enabled: true, sourceLang: '日语', targetLang: '中文' },
    htmlMode: { enabled: char.htmlModeEnabled, customPrompt: char.htmlModeCustomPrompt },
    thinkingChain: getThinkingChainSettings(char, userProfile),
  });
  const fire = await buildFirePack(char, userProfile, [], undefined, { all: [], categories: [] });
  const instantText = JSON.stringify(chat.fullMessages);
  expect(chat.flags.thinkingActive).toBe(enabled);
  expect(fire.thinkingChainEnabled).toBe(enabled);
  for (const prompt of [instantText, fire.template]) {
    expect(prompt).not.toContain('SPACE_RULE');
    expect(prompt).toContain('双语输出模式');
    expect(prompt).toContain('AUDIT_HTML_CUSTOM_RULE');
    expect(prompt.includes('【以下规则仅适用于 THINKING 阶段】')).toBe(hasDefault);
    expect(prompt.includes('AUDIT_THINKING_CUSTOM_RULE')).toBe(enabled && !!custom.trim());
    expect(prompt.includes('## 用户对内心独白的额外要求')).toBe(hasDefault && !!custom.trim());
  }
});

it('uses this space’s shared prompt unless the character has its own rules', async () => {
  const user = { name: '用户', thinkingChainPrompt: { mode: 'replace', customPrompt: 'SPACE_RULE' } } as const;
  const char = { id: 'shared-qa', name: '角色', memories: [], showThinkingChain: true } as any;
  const legacy = { ...char, thinkingChainCustomPrompt: 'OLD_RULE' };
  expect(getThinkingChainSettings(legacy, user)).toMatchObject({ scope: 'character', mode: 'append', customPrompt: 'OLD_RULE' });
  expect(getThinkingChainSettings(char, {})).toMatchObject({ scope: 'space', mode: 'append', customPrompt: '' });
  for (const follower of [char, { ...legacy, thinkingChainPromptScope: 'space' }]) {
    const thinkingChain = getThinkingChainSettings(follower, user);
    const input = { char: follower, userProfile: { ...user, bio: '', avatar: '' }, groups: [], emojis: [], categories: [], historyMsgs: [], contextLimit: 20 };
    const chat = await buildChatRequestPayload({ ...input, thinkingChain });
    const scheduled = await buildFirePack(follower, input.userProfile, [], undefined);
    for (const text of [JSON.stringify(chat.fullMessages), scheduled.template]) {
      expect(text).toContain('SPACE_RULE');
      expect(text).not.toContain('OLD_RULE');
      expect(text).not.toContain('【以下规则仅适用于 THINKING 阶段】');
    }
  }
});

it('adopting a self-scheduled task does not enable a never-configured character', async () => {
  vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  (globalThis as any).window ??= { dispatchEvent: () => true };
  const charId = 'audit-unconfigured-char';
  await DB.saveCharacter({ id: charId, name: '角色' } as any);
  const now = Date.now();
  await ActiveMsgStore.saveInboxMessage({
    messageId: 'audit-unconfigured-adoption', charId, charName: '角色',
    body: '半小时后再说。', messageType: 'text', receivedAt: now, sentAt: now,
    metadata: { charId, amsgMode: 'instant', amsgInstantChat: true,
      amsgSelfScheduled: [{
        taskUuid: 'audit-created-task', clientTaskId: 'audit-created-client-task',
        mode: 'auto', recurrenceType: 'none', firstSendTime: new Date(now + 30 * 60_000).toISOString(),
        expirePolicy: 'expire', source: 'character', status: 'scheduled', createdAt: now,
      }],
    },
  } as any);
  await flushInboxToChat('SW通知');
  const char = (await DB.getAllCharacters()).find(item => item.id === charId)!;
  expect(char.activeMsg2Config?.enabled).toBe(false);
  expect(char.activeMsg2Config?.tasks?.map(task => task.taskUuid)).toContain('audit-created-task');
}, 20_000);

it('a transfer-only answer retains replayable directives for reliable result delivery', async () => {
  const charId = 'audit-transfer-only';
  const text = '[[ACTION:TRANSFER:520]]';
  const cloud = processLLMRound(createFireSessionState(), text, {
    contactName: '角色', avatarUrl: null, taskId: 'audit-task', messageType: 'auto', occurrenceMs: Date.now(),
    metadata: { charId, amsgMode: 'instant', amsgInstantChat: true },
  });
  expect(cloud).toMatchObject({ decision: 'skip-push', reason: 'side-effects-only',
    sideEffects: { directives: [{ type: 'transfer', amount: 520 }] } });
  await applyAssistantPostProcessing(text, {
    char: { id: charId, name: '角色' }, userProfile: { name: '用户' }, emojis: [], contextMsgs: [],
    fullMessages: [], initialData: {}, historyMsgCount: 0, instantRender: true, skipSecondPassLLM: true,
    xhsCaches: {
      xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(),
      commentAuthorNameCache: new Map(), commentParentIdCache: new Map(),
    },
    api: { baseUrl: 'https://audit.invalid', headers: {}, effectiveApi: { baseUrl: 'https://audit.invalid', apiKey: '', model: 'audit' } },
    hooks: { setMessages: vi.fn(), addToast: vi.fn() },
  } as any);
  const messages = await DB.getMessagesByCharId(charId, true);
  expect(messages.some(message => message.type === 'transfer')).toBe(true);
}, 20_000);

it('first automatic adoption stores a genuinely missing message without acknowledging it early', async () => {
  localStorage.removeItem(AMSG_OUTBOX_ADOPTED_LS_KEY);
  const messageId = 'audit-missing-first-adoption';
  const charId = 'audit-fresh-backlog';
  await DB.saveCharacter({ id: charId, name: '角色' } as any);
  expect(await DB.getMessagesByCharId(charId)).toHaveLength(0);
  vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([{
    id: 1, messageId, taskUuid: 'audit-backlog-task', sessionId: 'audit-backlog-session',
    messageIndex: 1, totalMessages: 1, createdAt: Date.now() - 60_000, deliveredAt: null,
    push: { messageId, messageKind: 'content', message: '刚发出但没有送达的问候', metadata: { charId } },
  }]);
  const acknowledge = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  const result = await drainOutbox();
  expect(result.written).toBe(1);
  expect(result.staleDropped).toBe(0);
  expect(acknowledge).not.toHaveBeenCalled();
  expect(result.ackNow).toEqual([]);
  expect((await ActiveMsgStore.listInboxMessages()).some(message => message.messageId === messageId)).toBe(true);
});

it('scheduled prompts reload saved room plates and replace stale injection without an embedding API', async () => {
  const char = { id: 'audit-room-plates', name: '角色', memories: [], memoryPalaceEnabled: true } as any;
  const userProfile = { name: '用户' } as any;
  const now = Date.now();
  await RoomPlateDB.save({
    id: `${char.id}:user_room`, charId: char.id, room: 'user_room', updatedAt: now, version: 1,
    entries: [{ id: 'audit-plate-entry', text: 'AUDIT_SAVED_PLATE 用户不喝咖啡', firstLearnedAt: now, updatedAt: now, sourceCount: 1 }],
  });
  const chat = await buildChatRequestPayload({
    char, userProfile, groups: [], emojis: [], categories: [], historyMsgs: [], contextLimit: 20, timelyByWorker: true,
  });
  expect(JSON.stringify(chat.fullMessages)).toContain('AUDIT_SAVED_PLATE');
  const scheduled = await buildFirePack(char, userProfile, [], undefined, { all: [], categories: [] });
  expect(scheduled.template).toContain('AUDIT_SAVED_PLATE');
  const stale = await buildFirePack({ ...char, roomPlatesInjection: 'AUDIT_OLD_PLATE 用户每天喝咖啡' }, userProfile, [], undefined,
    { all: [], categories: [] });
  expect(stale.template).not.toContain('AUDIT_OLD_PLATE');
  expect(stale.template).toContain('AUDIT_SAVED_PLATE');
});


it('action results persist before acknowledgement and replay one transfer card across repeated delivery', async () => {
  const { dispatchAmsgResult } = await import('./amsgResults');
  const charId = 'audit-action-result';
  await DB.saveCharacter({ id: charId, name: '角色' } as any);
  vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  const payload = {
    messageKind: 'result', resultKind: 'assistant-actions', v: 1, messageId: 'audit-result-transfer', charId,
    push: { message: '', messageType: 'instant', taskUuid: 'audit-action-task', sessionId: 'audit-action-session',
      messageIndex: 1, totalMessages: 1, timestamp: new Date().toISOString(),
      metadata: { charId, amsgInstantChat: true, amsgMode: 'instant', directives: [{ type: 'transfer', amount: 520 }] } },
  };
  await ActiveMsgStore.saveGlobalConfig({ workerUrl: 'https://audit.invalid' });
  vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([{
    id: 101, messageId: payload.messageId, taskUuid: 'audit-action-task', sessionId: 'audit-action-session',
    messageIndex: 1, totalMessages: 1, createdAt: Date.now(), deliveredAt: null, push: payload,
  }]);
  await catchUpMissedPushes('manual');
  expect((await DB.getMessagesByCharId(charId, true)).filter(row => row.type === 'transfer')).toHaveLength(1);
  expect(await dispatchAmsgResult(payload)).toBe(true);
  await flushInboxToChat('SW通知');
  expect((await DB.getMessagesByCharId(charId, true)).filter(row => row.type === 'transfer')).toHaveLength(1);
}, 20_000);

it('action results without chat artifacts enqueue a diary once across duplicate and concurrent delivery', async () => {
  const { applyAmsgActionResult } = await import('./amsgActionResult');
  const { NotionManager } = await import('./realtimeContext');
  const charId = 'audit-action-diary-no-artifact';
  await DB.saveCharacter({ id: charId, name: '角色' } as any);
  (globalThis as any).window ??= { dispatchEvent: () => true };
  const oldConfig = localStorage.getItem('os_realtime_config');
  const oldQueue = localStorage.getItem('os_pending_diary_writes');
  localStorage.setItem('os_realtime_config', JSON.stringify({ notionEnabled: true, notionApiKey: 'test', notionDatabaseId: 'test' }));
  localStorage.removeItem('os_pending_diary_writes');
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  const sendDiary = vi.spyOn(NotionManager, 'createDiaryPage').mockRejectedValue(new Error('must remain queued while hidden'));
  vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  const payload = {
    messageKind: 'result', resultKind: 'assistant-actions', v: 1, messageId: 'audit-result-diary', charId,
    push: { message: '', messageType: 'instant', taskUuid: 'audit-diary-task', sessionId: 'audit-diary-session',
      messageIndex: 1, totalMessages: 1, timestamp: new Date().toISOString(),
      metadata: { charId, amsgInstantChat: true, amsgMode: 'instant', directives: [
        { type: 'notion_write_diary', title: '今天', content: '今天想记下来的一件事。' },
      ] } },
  };
  try {
    expect(await Promise.all([applyAmsgActionResult(payload), applyAmsgActionResult(payload)])).toEqual([true, true]);
    expect(await DB.getMessagesByCharId(charId, true)).toHaveLength(0);
    const repeated = await Promise.all([applyAmsgActionResult(payload), applyAmsgActionResult(payload)]);
    const pending = JSON.parse(localStorage.getItem('os_pending_diary_writes') ?? '[]');
    expect(pending.filter((entry: any) => entry.charId === charId)).toHaveLength(1);
    expect(repeated).toEqual([true, true]);
    expect(sendDiary).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    if (oldConfig === null) localStorage.removeItem('os_realtime_config'); else localStorage.setItem('os_realtime_config', oldConfig);
    if (oldQueue === null) localStorage.removeItem('os_pending_diary_writes'); else localStorage.setItem('os_pending_diary_writes', oldQueue);
  }
}, 20_000);

it('an action completion-receipt failure retains the result and does not acknowledge it', async () => {
  const { applyAmsgActionResult } = await import('./amsgActionResult');
  const charId = 'audit-action-receipt-failure';
  await DB.saveCharacter({ id: charId, name: '角色' } as any);
  const acknowledge = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  const receipt = vi.spyOn(ActiveMsgStore, 'markActionResultApplied').mockRejectedValueOnce(new Error('receipt storage failed'));
  const payload = { resultKind: 'assistant-actions', v: 1, messageId: 'audit-result-receipt-failure', charId,
    push: { message: '', messageType: 'instant', taskUuid: 'audit-receipt-task', sessionId: 'audit-receipt-session',
      messageIndex: 1, totalMessages: 1, timestamp: new Date().toISOString(),
      metadata: { charId, amsgInstantChat: true, directives: [{ type: 'transfer_accept' }] },
    },
  };
  try {
    expect(await applyAmsgActionResult(payload)).toBe(false);
    expect(acknowledge).not.toHaveBeenCalled();
    expect((await ActiveMsgStore.listInboxMessages()).some(message => message.messageId === payload.messageId)).toBe(true);
  } finally { receipt.mockRestore(); }
  expect(await applyAmsgActionResult(payload)).toBe(true);
  expect(await ActiveMsgStore.hasAppliedActionResult(charId, payload.messageId)).toBe(true);
}, 20_000);

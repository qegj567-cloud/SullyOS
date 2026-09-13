import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');

describe('collaboration sidecar wiring', () => {
  it('is launched from ChatInputArea without entering the main AI hook', () => {
    const input = read('components/chat/ChatInputArea.tsx');
    const chat = read('apps/Chat.tsx');
    const hook = read('hooks/useChatAI.ts');
    expect(input).toContain("onPanelAction('collaboration')");
    expect(chat).toContain('CollaborationWindow');
    expect(hook).not.toContain('CollaborationWindow');
    expect(hook).not.toContain('collaborationApi');
  });

  it('preloads the sidecar while closed and resets to the entry chooser before repaint', () => {
    const chat = read('apps/Chat.tsx');
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(chat).toContain('{char && (');
    expect(chat).toContain('open={collaborationOpen}');
    expect(windowSource).toContain('useLayoutEffect(() =>');
    expect(windowSource).toContain('const justOpened = open && !previousOpenRef.current');
    expect(windowSource).toContain('setShowEntryChooser(sessions.length > 0)');
    expect(windowSource).toContain('if (!open) return null');
  });

  it('keeps ordinary-chat awareness in collaboration settings and out of the maker picker', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const settingsStart = windowSource.indexOf('const ApiSettingsPanel');
    const makerStart = windowSource.indexOf('const MakerStudio');
    const makerEnd = windowSource.indexOf('const CHARACTER_PICKER_PAGE_SIZE');
    expect(windowSource.slice(settingsStart, makerStart)).toContain('日常聊天感知');
    expect(windowSource.slice(settingsStart, makerStart)).toContain('让角色知道自己有协同功能');
    expect(windowSource.slice(makerStart, makerEnd)).not.toContain('日常聊天感知');
    expect(windowSource.slice(makerStart, makerEnd)).not.toContain('chatCollaborationEnabled');
  });

  it('injects only capability/file awareness into normal chat, not collaboration execution rules', () => {
    const prompts = read('utils/chatPrompts.ts');
    const context = read('features/collaboration/context.ts');
    const awarenessStart = prompts.indexOf('### 协同功能');
    const awarenessEnd = prompts.indexOf('`;', awarenessStart);
    const awareness = prompts.slice(awarenessStart, awarenessEnd);
    expect(awareness).toContain('从 ChatApp 加号页进入');
    expect(awareness).toContain('${userProfile.name}从 ChatApp 加号页进入');
    expect(awareness).toContain('不要在这里假装制作');
    expect(awareness).not.toContain('主动拆解');
    expect(awareness).not.toContain('artifact');
    expect(context).toContain('const COLLABORATION_PROTOCOL = `### 协同工作规则');
    expect(context).toContain('chatCollaborationEnabled: false');
  });

  it('keeps collaboration persistence in its own IndexedDB database', () => {
    const store = read('features/collaboration/store.ts');
    expect(store).toContain("const DB_NAME = 'SullyOS_Collaboration'");
    expect(store).not.toContain("from '../../utils/db'");
  });

  it('reports collaboration adoption without reading titles, messages, filenames or blobs', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const store = read('features/collaboration/store.ts');
    for (const event of [
      '新建协同窗口', '保存协同设置', '协同上传文件', '协同生成文件', '选择协同制作类型',
      '预览协同作品', '使用协同作品', '发送协同上下文到聊天',
      '归档协同窗口', '打开协同文件库', '删除协同文件', '切换日常聊天协同',
      '重新生成协同回复', '删除协同消息', '复制协同消息', '编辑协同消息',
    ]) {
      expect(windowSource).toContain(`trackEvent('${event}'`);
    }
    expect(store).toContain('getUsageCounts');
    expect(store).toContain('transaction.objectStore(storeName).count()');
  });

  it('delivers collaboration files to ChatApp by canonical asset reference', () => {
    const store = read('features/collaboration/store.ts');
    const parser = read('utils/chatParser.ts');
    const item = read('components/chat/MessageItem.tsx');
    const types = read('types.ts');
    expect(store).toContain('listLibraryFiles');
    expect(store).toContain('deduplicated by assetId');
    expect(store).not.toContain("attachment.kind === 'installable'");
    expect(parser).toContain("type: 'collaboration_file'");
    expect(parser).toContain('collaborationFileMessageMetadata(file)');
    expect(parser).not.toContain('saveAsset({ id: file.assetId');
    expect(item).toContain('sully-collaboration-file');
    expect(item).toContain('可安装作品');
    expect(read('apps/Chat.tsx')).toContain('requestedPreviewAssetId={collaborationPreviewAssetId}');
    expect(types).toContain("'collaboration_file'");
  });

  it('opens every collaboration file through the same forced-share pipeline as Settings export', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const settings = read('apps/Settings.tsx');
    expect(windowSource).toContain("import { shareOrDownloadBlob } from '../../utils/shareExport'");
    expect(settings).toContain("import { shareOrDownloadBlob } from '../utils/shareExport'");
    expect(windowSource).not.toContain('preferDownloadOnWeb: true');
    expect(windowSource).toContain("notify('已打开系统分享面板', 'success')");
  });

  it('offers a searchable all-session file library with long-press deletion', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const store = read('features/collaboration/store.ts');
    expect(windowSource).toContain('CollaborationFileLibrary');
    expect(windowSource).toContain('来自全部协同窗口');
    expect(windowSource).toContain('长按管理文件');
    expect(windowSource).toContain('onPointerDown={startPress}');
    expect(store).toContain('deleteLibraryFile');
    expect(store).toContain('transaction.objectStore(STORE_ASSETS).delete(assetId)');
  });

  it('includes collaboration text, settings and binary files in system backup and restore', () => {
    const os = read('context/OSContext.tsx');
    const types = read('types.ts');
    expect(os).toContain('CollaborationStore.exportBackup(');
    expect(os).toContain('collaboration/assets/');
    expect(os).toContain('CollaborationStore.importBackup({');
    expect(types).toContain('collaborationSessions?: any[]');
    expect(types).toContain('collaborationAssetIndex?:');
  });

  it('ships six collaboration-only interface skins without printing third-party brands', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    for (const id of ['sully', 'gpt', 'claude', 'gemini', 'kimi', 'deepseek']) {
      expect(windowSource).toContain(`id: '${id}'`);
      expect(windowSource).toContain(`collab-ui-${id}`);
    }
    expect(windowSource).toContain('只改变这个工作窗口，不影响 ChatApp 和角色数据');
    for (const brand of ['ChatGPT', 'Claude', 'Gemini', 'Kimi', 'DeepSeek']) {
      expect(windowSource).not.toContain(brand);
    }
    expect(windowSource).toContain("label: '黑白助手'");
    expect(windowSource).toContain("label: '渐光协作'");
    expect(windowSource).toContain('collab-message-bubble-assistant');
  });

  it('lets avatar visibility and shape override the selected workspace skin', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const types = read('features/collaboration/types.ts');
    expect(types).toContain("CollaborationAvatarMode = 'theme' | 'both' | 'character' | 'user' | 'none'");
    expect(types).toContain("CollaborationAvatarStyle = 'circle' | 'rounded' | 'portrait'");
    expect(windowSource).toContain('头像显示');
    expect(windowSource).toContain('跟随风格');
    expect(windowSource).toContain('只角色');
    expect(windowSource).toContain('半身卡面');
    expect(windowSource).toContain('collab-avatar-${avatarMode}');
    expect(windowSource).toContain('界面内不会显示第三方品牌 Logo');
  });

  it('cleans leaked ChatApp transcript prefixes from streamed and stored replies', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(windowSource).toContain('normalizeCollaborationVisibleText(parsedInstallables.visibleText)');
    expect(windowSource).toContain('parseCollaborationMarkdown(normalizeCollaborationVisibleText(content))');
  });

  it('rebuilds a bounded ChatApp bridge on every collaboration generation', () => {
    const context = read('features/collaboration/context.ts');
    const chat = read('apps/Chat.tsx');
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const types = read('features/collaboration/types.ts');
    expect(context).toContain('buildChatRequestPayload({');
    expect(context).toContain('payload.fullMessages');
    expect(context).toContain('selectRecentCollaborationChatMessages(recentChatMessages, chatContextLimit)');
    expect(chat).toContain('recentChatMessages={messages}');
    expect(windowSource).toContain("const chatContextChoice = settings.recentChatContextCount ?? 'configured'");
    expect(windowSource).toContain('await loadCollaborationChatHistory(character, chatContextChoice)');
    expect(read('features/collaboration/chatBridge.ts')).toContain('await loadCharacterContextRange(current)');
    expect(windowSource).toContain('chatContextSnapshot: liveChatContext');
    expect(windowSource).toContain('chatContextSnapshot: undefined');
    expect(windowSource).toContain('ChatApp 最近聊天');
    expect(windowSource).toContain('最近 10 条');
    expect(windowSource).toContain('最近 20 条');
    expect(windowSource).toContain('用户设定范围');
    expect(types).toContain('chatContextSnapshot?: CollaborationContextMessage[]');
    expect(types).toContain('recentChatContextCount?: CollaborationChatContextChoice');
  });

  it('hides the over-broad current-interface maker while keeping old works compatible', () => {
    const makers = read('features/collaboration/makers.ts');
    expect(makers).toContain("definition => definition.kind !== 'appearance-preset'");
    expect(makers).toContain('ALL_COLLABORATION_MAKERS.map');
  });

  it('refreshes task-related memory on every collaboration send without mixing windows', () => {
    const context = read('features/collaboration/context.ts');
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const engine = read('features/collaboration/engine.ts');
    expect(context).toContain('buildCollaborationTurnMemoryContext');
    expect(context).toContain("entryPoint: 'collaboration'");
    expect(context).toContain("formatterMaxOutputItems: mode === 'focused' ? 5 : 15");
    expect(context).toContain('collaborationMessagesForRecall(messages, char.id)');
    expect(windowSource).toContain('const turnMemoryContext = await buildCollaborationTurnMemoryContext({');
    expect(windowSource).toContain('turnContext: turnMemoryContext');
    expect(engine).toContain('turnContext?: string');
  });

  it('renders the collaboration rich forms it teaches and strips unsupported ChatApp actions', () => {
    const context = read('features/collaboration/context.ts');
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const richOutput = read('features/collaboration/richOutput.ts');
    expect(context).toContain('协同窗口可交付的消息形态');
    expect(context).toContain('[[SEND_EMOJI: 表情名称]]');
    expect(windowSource).toContain('CollaborationEmojiCard');
    expect(windowSource).toContain('CollaborationVoiceBar');
    expect(windowSource).toContain('synthesizeSpeechDetailed');
    expect(richOutput).toContain('stripUnsupportedCollaborationActions');
  });

  it('explains the collaboration boundary before mode selection', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(windowSource).toContain('这是什么？');
    expect(windowSource).toContain('两个模式差在哪？');
    expect(windowSource).toContain('会进入角色记忆吗？');
    expect(windowSource).toContain('普通聊天不会变成工作模式');
    expect(windowSource).toContain('真正干活仍要进入这里');
  });

  it('opens on a new-or-history chooser when records exist instead of resuming the latest one', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(windowSource).toContain('CollaborationEntryChooser');
    expect(windowSource).toContain('新建协同');
    expect(windowSource).toContain('选择旧记录');
    expect(windowSource).toContain('setActiveSessionId(null)');
    expect(windowSource).toContain('setShowEntryChooser(sessionRows.length > 0)');
    expect(windowSource).toContain('setShowModePicker(sessionRows.length === 0)');
  });

  it('uses themed in-app action dialogs and no native confirms inside collaboration', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(windowSource).toContain('CollaborationActionDialog');
    expect(windowSource).toContain('总结并归档');
    expect(windowSource).toContain('仅归档，不写记忆');
    expect(windowSource).toContain('永久删除窗口');
    expect(windowSource).toContain('永久删除文件');
    expect(windowSource).not.toMatch(/window\.(confirm|prompt|alert)\s*\(/);
  });

  it('rerolls the latest user turn after an API switch without duplicating its uploaded file', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const store = read('features/collaboration/store.ts');
    expect(windowSource).toContain('重新生成上一条回复');
    expect(windowSource).toContain('const rerollLatestReply = async () =>');
    expect(windowSource).toContain('const requestMessages = messages.slice(0, lastUserIndex + 1)');
    expect(windowSource).toContain('await CollaborationStore.deleteMessages(replacedMessages.map(message => message.id))');
    expect(windowSource).toContain('await generateCollaborationReply(activeSession, requestMessages, latestUserMessage)');
    expect(store).toContain('deleteMessages: async (messageIds: string[])');
    expect(store).toContain('Remove message rows without deleting their canonical assets');
  });

  it('offers edit, copy and delete from the long-pressed collaboration menu', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(windowSource).toContain('useCollaborationLongPress');
    expect(windowSource).toContain('onLongPress={openMessageActions}');
    expect(windowSource).toContain("secondaryLabel: canEdit && canCopy ? '复制内容'");
    expect(windowSource).toContain("destructiveLabel: message.role === 'user' ? '删除这一轮'");
    expect(windowSource).toContain('保存并重新生成');
    expect(windowSource).toContain('await CollaborationStore.saveMessage(updatedMessage)');
    expect(windowSource).toContain("message.role === 'user' ? '删除这一轮协同？'");
    expect(windowSource).toContain("tone: 'danger'");
    expect(windowSource).toContain('while (deleteEnd < messages.length');
    expect(windowSource).toContain('text-slate-700 active:bg-slate-100');
  });

  it('uses the ChatApp thinking prompt and keeps model reasoning separate from the deliverable', () => {
    const context = read('features/collaboration/context.ts');
    const engine = read('features/collaboration/engine.ts');
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(context).toContain("from '../../utils/thinkingChainPrompt'");
    expect(context).toContain('buildThinkingChainPrompt(char.name, user.name)');
    expect(engine).toContain("requestBody.reasoning_effort = 'medium'");
    expect(engine).toContain("requestBody.thinking = { type: 'enabled', budget_tokens: 4000 }");
    expect(windowSource).toContain('CollaborationThinkingBlock');
    expect(windowSource).toContain('thinkingChain: reply.thinkingChain');
  });

  it('asks before archive memory writes and dual-writes when memory palace is enabled', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    const chat = read('apps/Chat.tsx');
    expect(windowSource).toContain('要不要把这次一起做的事整理进');
    expect(windowSource).toContain('summarizeCollaborationForMemory');
    expect(windowSource).toContain('memoryArchivedAt');
    expect(chat).toContain('handleCollaborationArchiveToMemory');
    expect(chat).toContain('importExternalMemoryText(');
    expect(chat).toContain('mergePalaceFragmentsIntoMemories');
    expect(chat).toContain('mood: \'collaboration\'');
  });

  it('does not abort generation when OSContext callback identities refresh', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(windowSource).toContain('const notifyRef = useRef(notify)');
    expect(windowSource).toContain("abortCollaborationRequest(abortRef.current, '协同窗口已关闭')");
    expect(windowSource).not.toContain('return () => { cancelled = true; abortRef.current?.abort(); };');
  });

  it('keeps the optional daily-chat collaboration prompt opt-in', () => {
    const prompts = read('utils/chatPrompts.ts');
    const types = read('types.ts');
    expect(types).toContain('chatCollaborationEnabled?: boolean');
    expect(prompts).toContain('if (char.chatCollaborationEnabled)');
    expect(prompts).toContain('不要在这里假装制作');
    expect(windowSourceForDailyMode()).toContain('日常聊天感知');
    expect(windowSourceForDailyMode()).toContain('不会向普通聊天注入制作规则，也不能在那里干活');
  });

  it('uses the same iOS safe-top contract as ChatApp for every collaboration header', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(windowSource).toContain('collab-safe-header');
    expect(windowSource).toContain('var(--safe-top,0px)');
    expect(windowSource).toContain('height:calc(4rem + var(--safe-top,0px))');
  });

  it('uses a searchable five-per-page role picker instead of a clipped native select', () => {
    const windowSource = read('features/collaboration/CollaborationWindow.tsx');
    expect(windowSource).toContain('const CHARACTER_PICKER_PAGE_SIZE = 5');
    expect(windowSource).toContain('placeholder="搜索角色"');
    expect(windowSource).toContain('filteredCharacters.slice(');
    expect(windowSource).not.toContain('<select value={targetId}');
  });

  it('saves and mounts every entry in a generated worldbook group', () => {
    const chat = read('apps/Chat.tsx');
    expect(chat).toContain('const books = installableToWorldbooks(artifact)');
    expect(chat).toContain('for (const book of books) await addWorldbook(book)');
    expect(chat).toContain('upsertMountedWorldbooks(current.mountedWorldbooks || [], books)');
  });
});

const windowSourceForDailyMode = () => read('features/collaboration/CollaborationWindow.tsx');

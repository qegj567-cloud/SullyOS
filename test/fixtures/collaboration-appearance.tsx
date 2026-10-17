import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import CollaborationWindow from '../../features/collaboration/CollaborationWindow';
import { PRESET_THEMES } from '../../components/chat/ChatConstants';
import { CollaborationStore } from '../../features/collaboration/store';
import { DEFAULT_COLLABORATION_SETTINGS } from '../../features/collaboration/types';
import type { APIConfig, CharacterProfile } from '../../types';

// Fictional fixture data only. No model requests are made by this preview.
const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#708a7b"/><circle cx="32" cy="25" r="11" fill="#e3e9df"/><path d="M12 60a20 23 0 0 1 40 0" fill="#e3e9df"/></svg>');
const character = { id: 'appearance-preview', name: '林间', avatar, systemPrompt: '' } as CharacterProfile;
const sessionId = 'appearance-preview-session';
await CollaborationStore.saveSession({ id: sessionId, charId: character.id, title: '一起整理阅读笔记', mode: 'focused', createdAt: 1, updatedAt: 1 });
await CollaborationStore.saveMessage({ id: 'appearance-preview-user', sessionId, role: 'user', content: '帮我整理一下这份阅读笔记，保留关键论点。', createdAt: 1 });
await CollaborationStore.saveMessage({ id: 'appearance-preview-ai', sessionId, role: 'assistant', content: '可以。我们先把论点分成三组，再补上每组对应的例子。\n\n### 先抓住核心\n- 记下作者想回答的问题\n- 区分论据和结论\n\n接下来一起检查有没有遗漏。', createdAt: 2 });
function Preview() {
  const [notice, setNotice] = useState('');
  const [reset, setReset] = useState(0);
  return <div className="relative h-full">
    <CollaborationWindow key={reset} open character={character} user={{ name: '读者', avatar: '', bio: '' }} theme={PRESET_THEMES.default}
      chatApi={{ baseUrl: '', apiKey: '', model: '' } as APIConfig} apiPresets={[]} availableModels={[]} characters={[character]} groups={[]} emojis={[]} emojiCategories={[]} recentChatMessages={[]}
      chatCollaborationEnabled={false} onClose={() => setNotice('预览保留在此页')}
      onSendToChat={async () => {}} onInstallArtifact={async () => ''} onArchiveToMemory={async () => ''} onToggleChatCollaboration={() => {}} notify={setNotice} />
    <output style={{ position: 'fixed', bottom: 0, right: 0, zIndex: 200, fontSize: 10, color: '#888' }}>{notice}</output>
    <button style={{ position: 'fixed', bottom: 0, left: 0, zIndex: 200, fontSize: 10 }} onClick={async () => { await CollaborationStore.saveSettings(DEFAULT_COLLABORATION_SETTINGS); setReset(value => value + 1); }}>重置预览设置</button>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);

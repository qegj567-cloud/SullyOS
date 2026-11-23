// Isolated preview of the actual components. Uses fictional, read-only device state.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActiveMsgSettingsEntry, ActiveMsgSettingsPages, type AmsgSettingsPage } from '../../components/settings/ActiveMsgSettings';
import { ActiveMsgClient } from '../../utils/activeMsgClient';
import { ActiveMsgStore } from '../../utils/activeMsgStore';
import { handleLocalBack } from '../../utils/localBackHandlers';
import type { ActiveMsg2CharacterConfig, ActiveMsg2GlobalConfig, APIConfig, CharacterProfile, RealtimeConfig, UserProfile } from '../../types';
import CharacterSettings from '../../components/chat/ActiveMsg2SettingsModal';
import { OSProvider } from '../../context/OSContext';
import Settings from '../../apps/Settings';
import InstantChatSendHelp from '../../components/chat/InstantChatSendHelp';
import SendProgressPreview from './chat-send-progress';

const params = new URLSearchParams(location.search);
const characterGroups = [{ id: 'friends', name: '朋友', order: 0 }, { id: 'story', name: '故事', order: 1 }, { id: 'empty', name: '空分类', order: 2 }];
const native = params.get('platform') === 'apk';
if (native) Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } });
const fixtureConfig: ActiveMsg2GlobalConfig = { userId: 'preview-user', workerUrl: params.has('new') ? '' : 'https://worker.example.invalid', initializedAt: params.has('new') ? undefined : 1, instantChatSupported: true };
ActiveMsgClient.getGlobalConfig = async () => fixtureConfig;
ActiveMsgStore.getGlobalConfig = async () => ({ ...fixtureConfig });
ActiveMsgStore.saveGlobalConfig = async patch => { Object.assign(fixtureConfig, patch); return { ...fixtureConfig }; };
ActiveMsgClient.getPushStatus = async () => ({ supported: true, permission: 'granted', hasSubscription: true, vapidConfigured: true, transport: native ? 'unified-push' : 'web-push', localEndpoint: 'https://ntfy.example.invalid/device', distributor: native ? 'io.heckel.ntfy' : undefined });
ActiveMsgClient.getRemotePushSubscription = async () => ({ exists: true, endpoint: 'https://ntfy.example.invalid/device', updatedAt: 1 });
ActiveMsgClient.getCapabilities = async () => { throw new Error('Preview does not probe a real Worker'); };
ActiveMsgClient.probeWorkerVersion = async () => ({ state: 'unknown', deployed: null, expected: 'preview', autoUpdate: null, channel: null });
ActiveMsgClient.probeInstantChatSupport = async () => true;
ActiveMsgClient.getCronTriggerState = async () => null;
ActiveMsgClient.sendTestPush = async () => ({ sent: true });
ActiveMsgClient.connect = async () => { fixtureConfig.initializedAt = 1; return { ok: true, userId: fixtureConfig.userId, warnings: [] }; };
ActiveMsgClient.readPanelStatus = async () => ({ lastSkip: null, dailySends: null });
ActiveMsgClient.listRemoteTasksForChar = async () => [];
ActiveMsgClient.putCharLimits = async () => {};
ActiveMsgClient.cancelAllTasksForChar = async () => ({ targets: [], failed: new Set<string>() });
ActiveMsgClient.deleteLlmCredentials = async () => 0;
ActiveMsgClient.clearCharClientState = async () => [];
Object.assign(window, { amsgSettingsBack: handleLocalBack });

function Preview() {
  const [page, setPage] = useState<AmsgSettingsPage | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [characters, setCharacters] = useState<CharacterProfile[]>(() => [
    { id: 'preview-lin', name: '林', groupId: 'friends', avatar: '', description: '', systemPrompt: '', memories: [], activeMsg2Config: { enabled: true, tasks: [] } },
    { id: 'preview-yue', name: '月', groupId: 'story', avatar: '', description: '', systemPrompt: '', memories: [], activeMsg2Config: { enabled: false, instantChatEnabled: false, tasks: [] } },
    ...(params.has('many') || params.has('stress') ? Array.from({ length: params.has('stress') ? 3000 : 300 }, (_, i) => ({ id: `preview-${i}`, name: `角色 ${String(i + 1).padStart(3, '0')}`, groupId: i === 299 ? 'deleted-group' : ['friends', 'story', undefined][i % 3], avatar: '', description: '', systemPrompt: '', memories: [], activeMsg2Config: { enabled: false, tasks: [] } })) : []),
  ]);
  const saveCharacter = (id: string, updater: (previous: ActiveMsg2CharacterConfig | undefined) => ActiveMsg2CharacterConfig) => setCharacters(previous => previous.map(character => character.id === id ? { ...character, activeMsg2Config: updater(character.activeMsg2Config) } : character));
  return <div className="h-full relative bg-slate-50 flex flex-col">
    <div {...(page || chatOpen ? { inert: '' } : {})} aria-hidden={!!page || chatOpen || undefined} className="flex-1 overflow-y-auto p-5">
      <h1 className="text-xl font-semibold text-slate-700 mb-6">系统设置</h1>
      <ActiveMsgSettingsEntry connected={Boolean(fixtureConfig.initializedAt && fixtureConfig.workerUrl)} onOpen={setPage} />
      {params.has('shared') && <button type="button" onClick={() => setChatOpen(true)}>聊天中的主动消息设置</button>}
    </div>
    {page && <ActiveMsgSettingsPages initialPage={page} onClose={() => setPage(null)} addToast={() => {}} characters={characters} characterGroups={characterGroups} realtimeConfig={{} as RealtimeConfig}
      onRestoreBackup={() => { setPage(null); }}
      onToggleGlobalEnabled={async next => { fixtureConfig.enabled = next; }}
      characterSettings={{ apiConfig: {} as APIConfig, userProfile: {} as UserProfile, groups: [], onSave: saveCharacter }} />}
    {chatOpen && <CharacterSettings isOpen char={characters[0]} onClose={() => setChatOpen(false)} apiConfig={{} as APIConfig} userProfile={{} as UserProfile} groups={[]} realtimeConfig={{} as RealtimeConfig} addToast={() => {}} onSave={updater => saveCharacter(characters[0].id, updater)} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<>{params.has('send') ? <SendProgressPreview /> : params.has('full') ? <OSProvider><Settings /></OSProvider> : <Preview />}<InstantChatSendHelp /></>);

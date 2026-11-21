import React, { useCallback, useId, useState } from 'react';
import type { ActiveMsg2CharacterConfig, APIConfig, CharacterGroup, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../../types';
import ActiveMsgGlobalSettingsModal from './ActiveMsgGlobalSettingsModal';
import AmsgCloudDataModal from './AmsgCloudDataModal';
import { PushVapidSettingsModal } from './PushVapidSettingsModal';
import SettingsDetailPage, { SettingsPageEmbedded } from './SettingsDetailPage';
import AmsgTabBar from './AmsgTabBar';

const CharacterSettings = React.lazy(() => import('../chat/ActiveMsg2SettingsModal'));
export type AmsgSettingsPage = 'overview' | 'config' | 'push' | 'features';
const SectionIcon = ({ name }: { name: AmsgSettingsPage }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
  {name === 'features' ? <><path strokeLinecap="round" d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="currentColor" /><circle cx="16" cy="17" r="3" fill="currentColor" /></>
    : name === 'push' ? <><path strokeLinecap="round" strokeLinejoin="round" d="M12 3 4 6v5c0 5 8 10 8 10s8-5 8-10V6l-8-3Z" /><path strokeLinecap="round" strokeLinejoin="round" d="m8 12 3 3 5-6" /></>
      : <><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" d="M12 7v5l3 2" /></>}
</svg>;
const SECTIONS: { id: AmsgSettingsPage; label: string }[] = [
  { id: 'overview', label: '功能总览' },
  { id: 'push', label: '通知与设备' },
  { id: 'features', label: '功能设置' },
];

export function ActiveMsgSettingsEntry({ onOpen, connected = false, enabled, cronPaused = false, toggling, onToggle }: { onOpen: (page: AmsgSettingsPage) => void; connected?: boolean; enabled?: boolean; cronPaused?: boolean; toggling?: boolean; onToggle?: (enabled: boolean) => void }) {
  return <div className="amsg-settings-entry-row"><button type="button" className="amsg-settings-entry" data-has-toggle={enabled !== undefined || undefined} onClick={() => onOpen(connected ? 'overview' : 'config')}>
    <span className="amsg-entry-icon"><SectionIcon name="config" /></span>
    <span className="min-w-0 flex-1 text-left">
      <span className="block text-sm font-semibold text-slate-600 tracking-wider">主动消息 2.0</span>
      {connected && enabled !== false && cronPaused ? (
        <span className="mt-0.5 inline-block rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">后台任务已暂停</span>
      ) : null}
    </span>
    <svg className="amsg-entry-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m9 6 6 6-6 6" /></svg>
  </button>{enabled !== undefined && <button type="button" role="switch" aria-label="主动消息 2.0 总开关" aria-checked={enabled} disabled={toggling} onClick={() => onToggle?.(!enabled)} className="amsg-entry-switch"><span /></button>}</div>;
}

export function ActiveMsgSettingsPages({ initialPage, onClose, addToast, realtimeConfig, characters, characterGroups = [], characterSettings, onToggleGlobalEnabled, onReenabledAfterConnect, onRestoreBackup }: {
  initialPage: AmsgSettingsPage;
  onClose: () => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  realtimeConfig: RealtimeConfig;
  characters: CharacterProfile[];
  characterGroups?: CharacterGroup[];
  characterSettings?: {
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    onSave: (id: string, updater: (previous: ActiveMsg2CharacterConfig | undefined) => ActiveMsg2CharacterConfig) => void;
  };
  onToggleGlobalEnabled?: (next: boolean) => Promise<void>;
  onReenabledAfterConnect?: () => void;
  onRestoreBackup?: () => void;
}) {
  // config remains a deep-link target; its visible home is the first feature tab.
  const [selected, setSelected] = useState(initialPage === 'config' ? 'features' : initialPage);
  const [connectionRequest, setConnectionRequest] = useState(0);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [vapidOpen, setVapidOpen] = useState(false);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const character = characterId ? characters.find(item => item.id === characterId) : undefined;
  const characterOpen = Boolean(character && characterSettings);
  const covered = cloudOpen || vapidOpen || characterOpen;
  const prefix = useId();
  const select = useCallback((id: string) => {
    const next = (id === 'config' ? 'features' : id) as Exclude<AmsgSettingsPage, 'config'>;
    if (id === 'config') setConnectionRequest(request => request + 1);
    setSelected(next);
    document.getElementById(`${prefix}-tab-${next}`)?.focus({ preventScroll: true });
  }, [prefix]);
  const openVapid = useCallback(() => setVapidOpen(true), []);
  const openCloud = useCallback(() => setCloudOpen(true), []);
  const openPush = useCallback(() => select('push'), [select]);
  return <>
    <SettingsDetailPage isOpen hidden={covered} title="主动消息 2.0" onClose={onClose} navigation={
      <AmsgTabBar tabs={SECTIONS} selected={selected} onSelect={select} label="主动消息分区" prefix={prefix} panelId={`${prefix}-workspace`} />
    }>
      <SettingsPageEmbedded.Provider value>
        <div role="tabpanel" id={`${prefix}-workspace`} aria-labelledby={`${prefix}-tab-${selected}`} className="amsg-primary-panel">
          <ActiveMsgGlobalSettingsModal isOpen covered={covered} workspaceSection={selected} connectionRequest={connectionRequest} onSelectWorkspace={select} characters={characters} characterGroups={characterGroups} onConfigureCharacter={characterSettings ? setCharacterId : undefined} onClose={onClose} addToast={addToast} realtimeConfig={realtimeConfig} onOpenVapid={openVapid} onOpenCloudData={openCloud} onOpenPushStatus={openPush} onToggleGlobalEnabled={onToggleGlobalEnabled} onReenabledAfterConnect={onReenabledAfterConnect} onRestoreBackup={onRestoreBackup} />
        </div>
      </SettingsPageEmbedded.Provider>
    </SettingsDetailPage>
    {cloudOpen && <AmsgCloudDataModal isOpen onClose={() => setCloudOpen(false)} addToast={addToast} characters={characters} />}
    {vapidOpen && <PushVapidSettingsModal open onClose={() => setVapidOpen(false)} addToast={addToast} />}
    {character && characterSettings && <React.Suspense fallback={<SettingsDetailPage isOpen title="角色设置" onClose={() => setCharacterId(null)}><p>正在读取角色设置…</p></SettingsDetailPage>}>
      <CharacterSettings key={character.id} isOpen fullPage char={character} onClose={() => setCharacterId(null)}
        apiConfig={characterSettings.apiConfig} userProfile={characterSettings.userProfile} groups={characterSettings.groups} realtimeConfig={realtimeConfig}
        onSave={updater => characterSettings.onSave(character.id, updater)} addToast={addToast} />
    </React.Suspense>}
  </>;
}

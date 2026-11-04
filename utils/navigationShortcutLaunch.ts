import { AppID } from '../types';
import { characterLaunch } from './characterLaunch';
import { roomLaunch } from './roomLaunch';
import { hasShortcutChildren, type NavigationShortcut, type ShortcutCharacter } from './navigationShortcuts';
import { appShortcutLaunch } from './appShortcutLaunch';

export function launchNavigationShortcut(shortcut: NavigationShortcut, actions: {
  characters: readonly ShortcutCharacter[];
  openApp: (id: AppID) => void;
  setActiveCharacterId: (id: string) => void;
  onMissingTarget: () => void;
}) {
  if (shortcut.characterId && !actions.characters.some(character => character.id === shortcut.characterId)) {
    actions.onMissingTarget(); return;
  }
  if (shortcut.appId === AppID.Room) roomLaunch.request({ tab: shortcut.roomTab || 'room', charId: shortcut.characterId, worldId: shortcut.worldId });
  if (shortcut.appId === AppID.Chat && shortcut.characterId) actions.setActiveCharacterId(shortcut.characterId);
  if (shortcut.appId === AppID.Character) characterLaunch.request({ charId: shortcut.characterId || '', ...(shortcut.entryId ? { detailTab: shortcut.entryId as NonNullable<Parameters<typeof characterLaunch.request>[0]['detailTab']> } : {}) });
  if (shortcut.appId !== AppID.Room && shortcut.appId !== AppID.Character && shortcut.appId !== AppID.Chat && hasShortcutChildren(shortcut.appId)) appShortcutLaunch.request(shortcut);
  actions.openApp(shortcut.appId);
}

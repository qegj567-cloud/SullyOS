import { useEffect, useRef } from 'react';
import type { AppID } from '../types';
import type { NavigationShortcut } from './navigationShortcuts';

let pending: NavigationShortcut | null = null;
const listeners = new Map<AppID, () => void>();
export const appShortcutLaunch = {
  request(intent: NavigationShortcut) { pending = intent; listeners.get(intent.appId)?.(); },
  consume(appId: AppID) {
    if (pending?.appId !== appId) return null;
    const intent = pending; pending = null; return intent;
  },
};
/** Consume once, including StrictMode; repeated shortcuts reach an already open App. */
export function useAppShortcut(appId: AppID, onLaunch: (intent: NavigationShortcut, isCurrent: () => boolean) => void) {
  const latest = useRef(onLaunch); latest.current = onLaunch;
  const generation = useRef(0), mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const apply = () => { const intent = appShortcutLaunch.consume(appId); if (intent) { const current = ++generation.current; latest.current(intent, () => mounted.current && current === generation.current); } };
    listeners.set(appId, apply); apply();
    return () => { mounted.current = false; if (listeners.get(appId) === apply) listeners.delete(appId); };
  }, [appId]);
}

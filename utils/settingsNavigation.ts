import { useEffect, useRef } from 'react';

export type SettingsFocusTarget = 'api' | 'navigation' | 'location';
let pending: SettingsFocusTarget | null = null;
const listeners = new Map<SettingsFocusTarget, () => void>();

/** Works before Settings mounts and while it is already open, without reloading drafts. */
export function requestSettingsFocus(target: SettingsFocusTarget) {
  const listener = listeners.get(target);
  if (listener) { pending = null; listener(); }
  else pending = target;
}
export function useSettingsFocus(target: SettingsFocusTarget | undefined, onFocus: () => void) {
  const latest = useRef(onFocus); latest.current = onFocus;
  useEffect(() => {
    if (!target) return;
    const listener = () => latest.current();
    listeners.set(target, listener);
    if (pending === target) { pending = null; listener(); }
    return () => { if (listeners.get(target) === listener) listeners.delete(target); };
  }, [target]);
}

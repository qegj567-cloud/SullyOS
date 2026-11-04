import { useSyncExternalStore } from 'react';
import { normalizeNavigationShortcut, type NavigationShortcut } from './navigationShortcuts';
export { NAVIGATION_SLOT_APPS } from './navigationShortcuts';
const KEY = 'sully_navigation_ball_enabled_v1';
let enabled: boolean | undefined;
const listeners = new Set<() => void>();
function snapshot() {
  if (enabled === undefined) { try { enabled = localStorage.getItem(KEY) === '1'; } catch { enabled = false; } }
  return enabled;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) { enabled = undefined; listeners.forEach(notify => notify()); }
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}
export function setNavigationBallEnabled(value: boolean) {
  enabled = value;
  try { localStorage.setItem(KEY, value ? '1' : '0'); } catch { /* This session can still use navigation. */ }
  listeners.forEach(notify => notify());
}
export function useNavigationBallEnabled() { return useSyncExternalStore(subscribe, snapshot, () => false); }

export const NAVIGATION_BALL_POSITION_KEY = 'sully_navigation_ball_position_v1';
const positionResetListeners = new Set<() => void>();
/** Restore only the position; keep enabled state and every configured shortcut. */
export function resetNavigationBallPosition() {
  try { localStorage.removeItem(NAVIGATION_BALL_POSITION_KEY); } catch { /* Reset the mounted ball even when storage is unavailable. */ }
  positionResetListeners.forEach(listener => listener());
}
export function subscribeNavigationBallPositionReset(listener: () => void) {
  positionResetListeners.add(listener); return () => { positionResetListeners.delete(listener); };
}

const SLOTS_KEY = 'sully_navigation_ball_slots_v1';
const EMPTY_SLOTS: readonly (NavigationShortcut | null)[] = [null, null, null, null];
let slots: readonly (NavigationShortcut | null)[] | undefined;
const slotListeners = new Set<() => void>();
function normalizeSlots(value: unknown): readonly (NavigationShortcut | null)[] {
  return EMPTY_SLOTS.map((_, index) => {
    return normalizeNavigationShortcut(Array.isArray(value) ? value[index] : null);
  });
}
function slotSnapshot() {
  if (!slots) {
    try { slots = normalizeSlots(JSON.parse(localStorage.getItem(SLOTS_KEY) || 'null')); }
    catch { slots = EMPTY_SLOTS; }
  }
  return slots;
}
function subscribeSlots(listener: () => void) {
  slotListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SLOTS_KEY || event.key === null) { slots = undefined; slotListeners.forEach(notify => notify()); }
  };
  window.addEventListener('storage', onStorage);
  return () => { slotListeners.delete(listener); window.removeEventListener('storage', onStorage); };
}
export function setNavigationBallSlot(index: number, shortcut: NavigationShortcut | null) {
  if (!Number.isInteger(index) || index < 0 || index >= EMPTY_SLOTS.length) return;
  const next = [...slotSnapshot()]; next[index] = shortcut;
  slots = normalizeSlots(next);
  try { localStorage.setItem(SLOTS_KEY, JSON.stringify(slots)); } catch { /* Keep session preferences. */ }
  slotListeners.forEach(notify => notify());
}
export function useNavigationBallSlots() { return useSyncExternalStore(subscribeSlots, slotSnapshot, () => EMPTY_SLOTS); }

let pickerOpen = false;
const pickerListeners = new Set<() => void>();
export function setNavigationPickerOpen(value: boolean) {
  pickerOpen = value; pickerListeners.forEach(notify => notify());
}
function subscribePicker(listener: () => void) { pickerListeners.add(listener); return () => { pickerListeners.delete(listener); }; }
export function useNavigationPickerOpen() { return useSyncExternalStore(subscribePicker, () => pickerOpen, () => false); }

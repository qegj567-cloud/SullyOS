export type InstantChatSendHelpReason = 'cloud' | 'local' | 'failed';
const SEEN_KEY = 'sully-instant-send-help-v1';
let current: InstantChatSendHelpReason | null = null;
let seen = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function showInstantChatSendHelp(reason: InstantChatSendHelpReason = 'cloud', once = false) {
    if (once) {
        try { seen ||= localStorage.getItem(SEEN_KEY) === '1'; } catch { /* Session-only when storage is unavailable. */ }
        if (seen) return;
    }
    current = reason;
    notify();
}
export function closeInstantChatSendHelp() {
    current = null;
    seen = true;
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* The help remains available by tapping the receipt. */ }
    notify();
}
export const getInstantChatSendHelp = () => current;
export function subscribeInstantChatSendHelp(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

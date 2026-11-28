// Extend the existing per-user onboarding acknowledgement; no additional storage key.
const KEY = 'sully-date-entry-guide-v1';
export function hasSeenDateEntryGuide(): boolean {
    try { return ['seen', 'input-seen'].includes(localStorage.getItem(KEY) || ''); } catch { return false; }
}
export function markDateEntryGuideSeen(): void {
    try { if (!hasSeenDateInputGuide()) localStorage.setItem(KEY, 'seen'); } catch { /* Session UI still dismisses. */ }
}
export function hasSeenDateInputGuide(): boolean {
    try { return localStorage.getItem(KEY) === 'input-seen'; } catch { return false; }
}
export function markDateInputGuideSeen(): void {
    try { localStorage.setItem(KEY, 'input-seen'); } catch { /* Session UI still dismisses. */ }
}

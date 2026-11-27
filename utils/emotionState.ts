export const lastInnerStateKey = (charId: string) => `sully_last_innerstate_${charId}`;
export function getLastInnerState(charId: string): string {
    try {
        return (typeof localStorage !== 'undefined' && localStorage.getItem(lastInnerStateKey(charId))) || '';
    } catch { return ''; }
}


/** Empty is an explicit deletion; absence still permits the schedule preview fallback. */
export function hasSavedInnerState(charId: string): boolean {
    try { return localStorage.getItem(lastInnerStateKey(charId)) !== null; } catch { return false; }
}
export function saveInnerState(charId: string, text: string): void {
    const innerState = text.trim();
    localStorage.setItem(lastInnerStateKey(charId), innerState);
    window.dispatchEvent(new CustomEvent('emotion-innerstate-updated', { detail: { charId, innerState } }));
}

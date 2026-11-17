/** UI-only handoff state. Survives Chat unmount, but never claims to resume an unfinished upload. */
export type ChatSendPhase = 'preparing' | 'sending' | 'accepted' | 'failed' | 'cancelled' | 'local';

export interface ChatSendProgress {
    charId: string;
    messageId: number | null;
    phase: ChatSendPhase;
}

const entries = new Map<string, { token: symbol; progress: ChatSendProgress }>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const isWorking = (phase: ChatSendPhase) => phase === 'preparing' || phase === 'sending';

export const getChatSendProgress = (charId?: string | null): ChatSendProgress | null =>
    charId ? entries.get(charId)?.progress ?? null : null;

export function subscribeChatSendProgress(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function cancelChatSendProgress(charId: string): void {
    const entry = entries.get(charId);
    if (!entry || entry.progress.phase === 'cancelled') return;
    entry.progress = { ...entry.progress, phase: 'cancelled' };
    notify();
}

/** One owner per generation. An older completion cannot turn a newer upload's circle into a check. */
export function beginChatSendProgress(charId: string, messageId: number | null) {
    const token = Symbol('chat-send');
    entries.delete(charId);
    entries.set(charId, { token, progress: { charId, messageId, phase: 'preparing' } });
    // Retain current work, but don't accumulate a badge for every character ever opened.
    if (entries.size > 100) {
        for (const [id, entry] of entries) {
            if (entries.size <= 100) break;
            if (!isWorking(entry.progress.phase)) entries.delete(id);
        }
    }
    notify();
    const update = (phase: ChatSendPhase) => {
        const entry = entries.get(charId);
        if (entry?.token !== token || !isWorking(entry.progress.phase)) return;
        if (entry.progress.phase === phase) return;
        // Preparing a prompt is never proof of server acceptance.
        if (phase === 'accepted' && entry.progress.phase !== 'sending') return;
        entry.progress = { ...entry.progress, phase };
        notify();
    };
    return {
        sending: () => update('sending'),
        accepted: () => update('accepted'),
        failed: () => update('failed'),
        cancelled: () => update('cancelled'),
        // A local route has no cloud handoff. Keep its existing generation UI.
        local: (showNotice = false) => {
            if (entries.get(charId)?.token !== token) return;
            if (showNotice) { update('local'); return; }
            entries.delete(charId);
            notify();
        },
        finish: (aborted: boolean) => {
            if (entries.get(charId)?.token === token && entries.get(charId)?.progress.phase === 'local') {
                entries.delete(charId);
                notify();
                return;
            }
            update(aborted ? 'cancelled' : 'failed');
        },
    };
}

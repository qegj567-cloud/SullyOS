import { DB } from './db';

const STOPPED_KEY = 'chat_stopped_reply_uuids_v1';
export const MAX_STOPPED_REPLY_UUIDS = 200;
const runs = new Set<ReplyRun>();
type Display = { ids: Set<number>; previews: string[] };
const displays = new Map<string, Display>();
const stoppedInMemory = new Set<string>();

export const replyAbortError = () => new DOMException('Reply stopped', 'AbortError');
export const isReplyAbort = (error: unknown): boolean => (error as any)?.name === 'AbortError';

export function isReplyStopped(uuid?: string | null): boolean {
    if (!uuid) return false;
    if (stoppedInMemory.has(uuid)) return true;
    try { return (JSON.parse(localStorage.getItem(STOPPED_KEY) || '[]') as string[]).includes(uuid); }
    catch { return false; }
}

/** UUID tombstones survive reloads; late push and outbox delivery use the same check. */
export function markReplyStopped(uuid: string): void {
    stoppedInMemory.delete(uuid);
    stoppedInMemory.add(uuid);
    while (stoppedInMemory.size > MAX_STOPPED_REPLY_UUIDS) {
        const oldest = stoppedInMemory.values().next().value;
        if (oldest === undefined) break;
        stoppedInMemory.delete(oldest);
    }
    try {
        const parsed = JSON.parse(localStorage.getItem(STOPPED_KEY) || '[]');
        const stored = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
        const merged = [...stored.filter(id => !stoppedInMemory.has(id)), ...stoppedInMemory].slice(-MAX_STOPPED_REPLY_UUIDS);
        localStorage.setItem(STOPPED_KEY, JSON.stringify(merged));
    } catch { /* The current page still refuses this round if storage is unavailable. */ }
    for (const run of runs) if (run.uuid === uuid) run.stop();
}

/** Called after React commits the chat view, rather than when a DB write finishes. */
export function publishReplyDisplay(charId: string, ids: number[], previews: string[]): void {
    displays.set(charId, { ids: new Set([...(displays.get(charId)?.ids ?? []), ...ids]), previews: [...previews] });
}

export function stopReplyRuns(charId: string): void {
    for (const run of runs) if (run.charId === charId) run.stop();
}

export class ReplyRun {
    private controller = new AbortController();
    readonly signal = this.controller.signal;
    private savedIds = new Set<number>();
    private stoppedDisplay?: Display;
    private settling?: Promise<void>;
    private completed = false;
    private resolveSecretSources!: (ids: number[]) => void;
    readonly secretSourceIds = new Promise<number[]>(resolve => {this.resolveSecretSources = resolve;});
    markCompleted(): void {this.completed = true;}
    constructor(readonly charId: string, readonly uuid?: string) {}

    check = (): void => {
        if (isReplyStopped(this.uuid) && !this.signal.aborted) this.stop();
        if (this.signal.aborted) throw replyAbortError();
    };

    stop(): void {
        if (this.signal.aborted) return;
        const display = displays.get(this.charId);
        this.stoppedDisplay = display
            ? { ids: new Set(display.ids), previews: this.uuid ? [] : [...display.previews] }
            : { ids: new Set(this.savedIds), previews: [] };
        this.controller.abort(replyAbortError());
    }

    async wait<T>(promise: Promise<T>): Promise<T> {
        // Attach rejection handling even if cancellation happened before entering wait.
        if (this.signal.aborted || isReplyStopped(this.uuid)) {
            void promise.catch(() => {});
            this.check();
        }
        let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
            abort = () => reject(replyAbortError());
            this.signal.addEventListener('abort', abort, { once: true });
        });
        try {
            const result = await Promise.race([promise, cancelled]);
            this.check();
            return result;
        } finally { this.signal.removeEventListener('abort', abort); }
    }

    saveMessage: typeof DB.saveMessage = async (message) => {
        this.check();
        const id = await DB.saveMessage(message);
        this.savedIds.add(id);
        // A transaction can complete after stop was clicked. Never leave its unseen row behind.
        if (this.signal.aborted && !this.stoppedDisplay?.ids.has(id)) await DB.deleteMessages([id]);
        this.check();
        return id;
    };

    settle(): Promise<void> {
        if (this.settling) return this.settling;
        this.settling = (async () => {
            if (this.signal.aborted && this.stoppedDisplay) {
                const unseen = [...this.savedIds].filter(id => !this.stoppedDisplay!.ids.has(id));
                if (unseen.length) await DB.deleteMessages(unseen);
                for (const content of this.stoppedDisplay.previews) {
                    await DB.saveMessage({ charId: this.charId, role: 'assistant', type: 'text', content });
                }
            }
        })().finally(() => {
            this.resolveSecretSources(this.completed && !this.signal.aborted ? [...this.savedIds] : []);
            runs.delete(this);
        });
        return this.settling;
    }
}

export function createReplyRun(charId: string, uuid?: string): ReplyRun {
    const run = new ReplyRun(charId, uuid);
    runs.add(run);
    if (isReplyStopped(uuid)) run.stop();
    return run;
}

export function withReplyCancellation<T>(run: ReplyRun | undefined, operation: () => Promise<T>): Promise<T> {
    run?.check();
    const promise = operation();
    return run ? run.wait(promise) : promise;
}

export function getReplyDisplayIds(charId: string): Set<number> | undefined {
    const display = displays.get(charId);
    return display ? new Set(display.ids) : undefined;
}

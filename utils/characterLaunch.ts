export interface CharacterLaunchIntent {
    charId: string;
    openChibiStudio?: boolean;
    detailTab?: 'identity' | 'memory' | 'impression' | 'plates' | 'chibi' | 'stats';
}

let pending: CharacterLaunchIntent | null = null;
const listeners = new Set<() => void>();

export const characterLaunch = {
    request(intent: CharacterLaunchIntent): void {
        pending = intent;
        listeners.forEach(listener => listener());
    },
    peek(): CharacterLaunchIntent | null {
        return pending;
    },
    consume(): CharacterLaunchIntent | null {
        const value = pending;
        pending = null;
        return value;
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener); return () => { listeners.delete(listener); };
    },
};

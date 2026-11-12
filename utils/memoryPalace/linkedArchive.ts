import { useEffect, useState } from 'react';
import type { MemoryFragment } from '../../types';
import { MemoryNodeDB } from './db';
import { formatLocalDateKey } from './memoryDateEdit';
import { MEMORY_NODES_CHANGED } from './nodeChanges';
import { memoryContentWithDates } from './relativeTime';

/** Resolve explicit new links only. Never infer links for historical or imported archives. */
export async function resolveLinkedArchives(charId: string, memories: MemoryFragment[], readableExport = false): Promise<MemoryFragment[]> {
    return Promise.all(memories.map(async memory => {
        if (!memory.palaceMemoryId) return memory;
        const node = await MemoryNodeDB.getById(memory.palaceMemoryId);
        if (node?.charId !== charId) return memory;
        return {
            ...memory,
            date: formatLocalDateKey(node.createdAt) || memory.date,
            summary: readableExport ? memoryContentWithDates(node) : node.content,
        };
    }));
}

export function useLinkedArchives(charId: string | undefined, memories: MemoryFragment[] | undefined, enabled: boolean) {
    const [resolved, setResolved] = useState<{ source: MemoryFragment[]; charId: string; memories: MemoryFragment[] }>();
    useEffect(() => {
        if (!charId || !enabled || !memories?.some(memory => memory.palaceMemoryId)) return;
        let disposed = false;
        let sequence = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = async () => {
            const request = ++sequence;
            try {
                const next = await resolveLinkedArchives(charId, memories);
                if (!disposed && request === sequence) setResolved({ source: memories, charId, memories: next });
            } catch { /* A failed read retains the stored archive text. */ }
        };
        const changed = (event: Event) => {
            const target = (event as CustomEvent<{ charId?: string }>).detail?.charId;
            if (target && target !== charId) return;
            clearTimeout(timer);
            timer = setTimeout(() => void refresh(), 100);
        };
        void refresh();
        window.addEventListener(MEMORY_NODES_CHANGED, changed);
        window.addEventListener('focus', changed);
        return () => { disposed = true; clearTimeout(timer); window.removeEventListener(MEMORY_NODES_CHANGED, changed); window.removeEventListener('focus', changed); };
    }, [charId, memories, enabled]);
    return enabled && resolved && resolved.source === memories && resolved.charId === charId ? resolved.memories : (memories || []);
}

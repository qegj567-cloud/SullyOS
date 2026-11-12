import { describe, expect, it } from 'vitest';
import { MemoryLinkDB } from './db';
import { buildLinks } from './links';
import type { MemoryNode } from './types';

function makeNode(id: string, createdAt: number, extra: Partial<MemoryNode> = {}): MemoryNode {
    return {
        id,
        charId: 'char_links_test',
        content: `记忆内容 ${id}`,
        room: 'bedroom',
        tags: [],
        importance: 6,
        mood: 'neutral',
        valence: 0,
        arousal: 0,
        embedded: true,
        createdAt,
        lastAccessedAt: createdAt,
        accessCount: 0,
        ...extra,
    };
}

describe('buildLinks intra-batch temporal links', () => {
    it('does not link same-batch memories across distant dates when neither belongs to a box', async () => {
        const july1 = new Date(2025, 6, 1, 12, 0, 0).getTime();
        const july15 = new Date(2025, 6, 15, 12, 0, 0).getTime();
        const nov12 = new Date(2026, 10, 12, 12, 0, 0).getTime();

        const links = await buildLinks(
            [
                makeNode('ext_2025_0701', july1),
                makeNode('ext_2025_0715', july15),
                makeNode('ext_2026_1112', nov12),
            ],
            [],
        );

        expect(links.filter(l => l.type === 'temporal')).toEqual([]);
        const stored = await MemoryLinkDB.getByNodeId('ext_2025_0701');
        expect(stored.filter(l => l.type === 'temporal')).toEqual([]);
    });

    it('links same-batch memories within 24 hours at 0.3 and explicit same-box memories at 0.5', async () => {
        const morning = new Date(2025, 6, 15, 9, 0, 0).getTime();
        const evening = new Date(2025, 6, 15, 21, 0, 0).getTime();
        const nextYearSameBox = new Date(2026, 6, 15, 9, 0, 0).getTime();

        const links = await buildLinks(
            [
                makeNode('same_day_a', morning, { eventBoxId: 'eb_shared' }),
                makeNode('same_day_b', evening),
                makeNode('same_box_c', nextYearSameBox, { eventBoxId: 'eb_shared' }),
            ],
            [],
        );

        const temporal = links.filter(l => l.type === 'temporal');
        expect(temporal).toHaveLength(2);

        const dayPair = temporal.find(
            l => [l.sourceId, l.targetId].sort().join(':') === 'same_day_a:same_day_b',
        );
        const boxPair = temporal.find(
            l => [l.sourceId, l.targetId].sort().join(':') === 'same_box_c:same_day_a',
        );
        expect(dayPair?.strength).toBe(0.3);
        expect(boxPair?.strength).toBe(0.5);
    });
});

import { beforeEach, expect, it } from 'vitest';
import { openSpaceDB } from './db';
import { saveUserSpaces } from './userSpaces';
import { commitSpaceRows, readSpaceStore } from './userSpaceData';
import { clearSeededMemoryLinks, seedMemoryLinks, SEED_LINK_PREFIX } from './devSeedMemoryLinks';

const real = { id: 'ml_1792000000000_abc123', sourceId: 'mem_a', targetId: 'mem_b', type: 'person', strength: 0.6 };

beforeEach(async () => {
    localStorage.clear();
    saveUserSpaces([{ id: 'default', name: '小明' }]);
    await commitSpaceRows(await openSpaceDB('default'), { memory_links: [real] }, true);
});

it('appends seeded links across batches and removes only the seeded ones', async () => {
    expect(await seedMemoryLinks(6000)).toMatchObject({ seeded: 6000, total: 6001 });
    // 再塞一次接在后面，不覆盖前一批
    expect(await seedMemoryLinks(10)).toMatchObject({ seeded: 6010, total: 6011 });
    const rows = await readSpaceStore(await openSpaceDB('default'), 'memory_links');
    expect(rows.filter(row => row.id.startsWith(SEED_LINK_PREFIX))).toHaveLength(6010);

    expect(await clearSeededMemoryLinks()).toMatchObject({ seeded: 0, total: 1 });
    expect(await readSpaceStore(await openSpaceDB('default'), 'memory_links')).toEqual([real]);
});

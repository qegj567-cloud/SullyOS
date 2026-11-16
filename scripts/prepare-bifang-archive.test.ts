import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { prepareArchive } from './prepare-bifang-archive.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const dirs: string[] = [];
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        const target = resolve(dir);
        if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('bifang-archive-test-')) throw Error('Unexpected test directory');
        await rm(target, { recursive: true, force: true });
    }
});
async function snapshot(poems?: any[]) {
    const directory = await mkdtemp(join(tmpdir(), 'bifang-archive-test-')); dirs.push(directory);
    const poem = { id: 'p', bookletId: 'b', title: "诗'题", brief: '主题', targetLines: 4, lineCount: 1, status: 'sealed', createdAt: 1, sealedAt: 2, lines: [{ seq: 3, pen: '笔名', content: "一句'诗\n第二行", createdAt: 1 }] };
    const files = [];
    for (const [name, data] of Object.entries({ feed: { ok: true, poems: poems || [poem] }, current: { ok: true, poem: null, booklet: { id: 'latest' } } })) {
        const raw = JSON.stringify(data); await writeFile(join(directory, name + '.json'), raw);
        files.push({ file: name + '.json', sha256: createHash('sha256').update(raw).digest('hex') });
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ files }));
    return directory;
}
it('imports quoted content and sparse seq numbers exactly, leaves ownership unknown and refuses replay', async () => {
    const result = await prepareArchive(await snapshot());
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(result.sql);
        expect(db.prepare('SELECT seq,content,device FROM po_poem_lines').get()).toMatchObject({ seq: 3, content: "一句'诗\n第二行", device: '' });
        expect(db.prepare('SELECT title FROM po_poems').get().title).toBe("诗'题");
        expect(() => db.exec(result.sql)).toThrow();
    } finally { db.close(); }
});
it('rejects altered snapshots before preparing SQL', async () => {
    const directory = await snapshot(); await writeFile(join(directory, 'feed.json'), (await readFile(join(directory, 'feed.json'), 'utf8')) + ' ');
    await expect(prepareArchive(directory)).rejects.toThrow('checksum');
});
it('refuses an upstream page that may have been truncated', async () => {
    await expect(prepareArchive(await snapshot(Array(100).fill({})))).rejects.toThrow('Truncated');
});

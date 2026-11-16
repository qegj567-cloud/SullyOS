// pnpm exec node scripts/prepare-bifang-archive.mjs <public-snapshot-directory> <output.sql>
// Produces a NEW database import. Never use this file to overwrite a live database.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareArchive(directory) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  const documents = {};
  for (const name of ['feed', 'current']) {
    const entry = manifest.files.find(file => file.file === `${name}.json`);
    const raw = await readFile(resolve(directory, `${name}.json`));
    if (!entry || createHash('sha256').update(raw).digest('hex') !== entry.sha256) throw Error(`Invalid ${name} checksum`);
    documents[name] = JSON.parse(raw);
    if (documents[name].ok !== true) throw Error(`Invalid ${name} response`);
  }
  if (documents.feed.poems.length >= 100) throw Error('Truncated public feed cannot be imported as a complete snapshot');
  const poems = new Map(documents.feed.poems.map(poem => [poem.id, poem]));
  if (documents.current.poem) poems.set(documents.current.poem.id, documents.current.poem);
  const groups = new Map();
  for (const poem of poems.values()) {
    if (!poem.id || !poem.bookletId || !['open', 'sealed'].includes(poem.status)) throw Error('Invalid poem');
    const seqs = poem.lines.map(line => line.seq);
    if (seqs.some(seq => !Number.isInteger(seq) || seq < 1) || new Set(seqs).size !== seqs.length || poem.lines.length !== poem.lineCount) throw Error('Invalid line numbering');
    groups.set(poem.bookletId, [...(groups.get(poem.bookletId) || []), poem]);
  }
  const q = value => value == null ? 'NULL' : typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : (() => { throw Error('Invalid numeric value'); })())
    : `'${String(value).replaceAll("'", "''")}'`;
  const insert = (table, fields, values) => `INSERT INTO ${table} (${fields}) VALUES (${values.map(q).join(',')});`;
  const sql = [await readFile(new URL('../worker/post-office/schema.sql', import.meta.url), 'utf8'),
    await readFile(new URL('../worker/bifang/schema.sql', import.meta.url), 'utf8')];
  for (const [id, group] of groups) {
    // The old API exposes only its latest booklet metadata. Earlier booklet titles are unknown;
    // label them as archives, preserving every poem ID, title, line, sequence and timestamp.
    const known = documents.current.booklet?.id === id ? documents.current.booklet : null;
    sql.push(insert('po_booklets', 'id,title,subtitle,theme,poems_target,poem_count,lines_min,lines_max,chars_per_line,status,created_at', [
      id, known?.title ?? '信号坠落处 · 封存诗集', known?.subtitle ?? '', known?.theme ?? '',
      known?.poemsTarget ?? group.length, group.filter(poem => poem.status === 'sealed').length,
      known?.linesMin ?? Math.min(...group.map(poem => poem.targetLines)), known?.linesMax ?? Math.max(...group.map(poem => poem.targetLines)),
      known?.charsPerLine ?? 24, known?.status ?? 'done', known?.createdAt ?? Math.min(...group.map(poem => poem.createdAt)),
    ]));
  }
  let lineCount = 0;
  for (const poem of poems.values()) {
    sql.push(insert('po_poems', 'id,booklet_id,title,brief,target_lines,line_count,status,starter_pen,created_at,sealed_at', [
      poem.id, poem.bookletId, poem.title, poem.brief, poem.targetLines, poem.lines.length, poem.status, null, poem.createdAt, poem.sealedAt,
    ]));
    for (const line of poem.lines) {
      // Empty owner is deliberately unclaimable without a verified legacy response.
      sql.push(insert('po_poem_lines', 'id,poem_id,booklet_id,seq,device,pen,content,created_at', [
        `${poem.id}:${line.seq}`, poem.id, poem.bookletId, line.seq, '', line.pen, line.content, line.createdAt,
      ]));
      lineCount++;
    }
  }
  sql.push(insert('po_archive_manifest', 'revision,poem_count,line_count', ['noir2-2026-11-16', poems.size, lineCount]));
  return { sql: sql.join('\n'), poemCount: poems.size, lineCount, bookletCount: groups.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw Error('Expected snapshot directory and output.sql');
  const result = await prepareArchive(process.argv[2]);
  await writeFile(process.argv[3], result.sql, { flag: 'wx' });
  console.log(JSON.stringify({ poems: result.poemCount, lines: result.lineCount, booklets: result.bookletCount }));
}

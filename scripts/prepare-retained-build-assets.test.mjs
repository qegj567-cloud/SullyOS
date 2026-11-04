import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRetainableBuildAsset, prepareRetainedBuildAssets } from './prepare-retained-build-assets.mjs';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const sha256 = body => createHash('sha256').update(body).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sully-retained-assets-'));
  t.after(async () => {
    assert.ok(relative(tmpdir(), root).startsWith('sully-retained-assets-'));
    await rm(root, { recursive: true, force: true });
  });
  const dist = join(root, 'dist'), history = join(root, 'history');
  async function build(files) {
    assert.equal(relative(root, dist), 'dist');
    await rm(dist, { recursive: true, force: true });
    await mkdir(join(dist, 'assets', 'build'), { recursive: true });
    for (const [path, body] of Object.entries({ 'package.json': '{"type":"module"}', 'index.html': '<html>current</html>', 'sw-keep-alive.js': 'current-sw', ...files })) {
      await mkdir(dirname(join(dist, path)), { recursive: true });
      await writeFile(join(dist, path), body);
    }
  }
  return { root, dist, history, build, prepare: options => prepareRetainedBuildAssets({ dist, history, now: NOW, ...options }) };
}

test('a cache miss seeds only hashed build files and leaves public files untouched', async t => {
  const f = await fixture(t);
  await f.build({
    'assets/build/main-abcdefgh.js': 'main',
    'assets/build/fixed.js': 'fixed',
    'assets/build/page-abcdefgh.html': 'html',
    'assets/build/sw-keep-alive-abcdefgh.js': 'worker',
    'assets/public-abcdefgh.js': 'public',
  });
  assert.deepEqual(await f.prepare(), { historyStatus: 'empty-seeded-current', builds: 1, currentFiles: 1, retainedFiles: 0, totalFiles: 1, totalBytes: 4 });
  const index = JSON.parse(await readFile(join(f.history, 'index.json')));
  assert.equal(index.builds[0].createdAt, NOW);
  assert.deepEqual(index.builds[0].files.map(file => file.path), ['assets/build/main-abcdefgh.js']);
  assert.equal(await readFile(join(f.dist, 'assets/build/fixed.js'), 'utf8'), 'fixed');
});

test('retains the complete old JS/CSS/asset closure without changing current HTML or SW', async t => {
  const f = await fixture(t);
  const old = {
    'assets/build/App-aaaaaaaa.js': 'import {value} from "./shared-aaaaaaaa.js"; export const result=value; export const style=new URL("./style-aaaaaaaa.css",import.meta.url).href;',
    'assets/build/shared-aaaaaaaa.js': 'export const value="old dependency";',
    'assets/build/style-aaaaaaaa.css': 'body{background:url(./image-aaaaaaaa.png)}',
    'assets/build/image-aaaaaaaa.png': 'old image',
  };
  await f.build(old);
  await f.prepare({ now: NOW - DAY });
  await f.build({ 'assets/build/App-bbbbbbbb.js': 'import "./shared-bbbbbbbb.js";', 'assets/build/shared-bbbbbbbb.js': 'new dependency' });
  const beforeHtml = await readFile(join(f.dist, 'index.html'));
  const beforeSw = await readFile(join(f.dist, 'sw-keep-alive.js'));
  const result = await f.prepare();
  assert.equal(result.historyStatus, 'restored');
  assert.equal(result.retainedFiles, 4);
  for (const [path, body] of Object.entries(old)) assert.equal(await readFile(join(f.dist, path), 'utf8'), body);
  assert.deepEqual(await readFile(join(f.dist, 'index.html')), beforeHtml);
  assert.deepEqual(await readFile(join(f.dist, 'sw-keep-alive.js')), beforeSw);
  assert.equal(await readFile(join(f.dist, 'assets/build/shared-bbbbbbbb.js'), 'utf8'), 'new dependency');
  const oldApp = await import(pathToFileURL(join(f.dist, 'assets/build/App-aaaaaaaa.js')).href);
  assert.equal(oldApp.result, 'old dependency');
  assert.equal(await readFile(new URL(oldApp.style), 'utf8'), old['assets/build/style-aaaaaaaa.css']);
});

test('deduplicates shared files and stores self-contained verified blobs', async t => {
  const f = await fixture(t);
  await f.build({ 'assets/build/App-aaaaaaaa.js': 'A', 'assets/build/shared-ssssssss.js': 'shared' });
  await f.prepare({ now: NOW - DAY });
  await f.build({ 'assets/build/App-bbbbbbbb.js': 'B', 'assets/build/shared-ssssssss.js': 'shared' });
  const result = await f.prepare();
  assert.equal(result.totalFiles, 3);
  assert.equal(result.totalBytes, 8);
  assert.equal((await readdir(join(f.history, 'blobs'))).length, 3);
  assert.equal(await readFile(join(f.history, 'blobs', sha256('A')), 'utf8'), 'A');
});

test('expires entire old builds and their unused blobs', async t => {
  const f = await fixture(t);
  await f.build({ 'assets/build/App-aaaaaaaa.js': 'A', 'assets/build/shared-aaaaaaaa.js': 'AA' });
  await f.prepare({ now: NOW - 8 * DAY });
  await f.build({ 'assets/build/App-bbbbbbbb.js': 'B' });
  assert.equal((await f.prepare()).builds, 1);
  assert.deepEqual(await readdir(join(f.dist, 'assets/build')), ['App-bbbbbbbb.js']);
  assert.deepEqual(await readdir(join(f.history, 'blobs')), [sha256('B')]);
});

for (const [label, limits] of Object.entries({ builds: { maxBuilds: 1 }, files: { maxFiles: 2 }, bytes: { maxBytes: 5 } })) {
  test(`evicts a whole build when the ${label} limit is exceeded`, async t => {
    const f = await fixture(t);
    await f.build({ 'assets/build/App-aaaaaaaa.js': 'A', 'assets/build/shared-aaaaaaaa.js': 'AA' });
    await f.prepare({ now: NOW - DAY });
    await f.build({ 'assets/build/App-bbbbbbbb.js': 'B', 'assets/build/shared-bbbbbbbb.js': 'BB' });
    const result = await f.prepare(limits);
    assert.equal(result.builds, 1);
    assert.equal(result.retainedFiles, 0);
    assert.deepEqual((await readdir(join(f.dist, 'assets/build'))).sort(), ['App-bbbbbbbb.js', 'shared-bbbbbbbb.js']);
  });
}

test('fails before copying anything if an immutable path has different content', async t => {
  const f = await fixture(t);
  await f.build({ 'assets/build/App-aaaaaaaa.js': 'old', 'assets/build/shared-aaaaaaaa.js': 'old dependency' });
  await f.prepare({ now: NOW - DAY });
  await f.build({ 'assets/build/App-aaaaaaaa.js': 'changed' });
  await assert.rejects(f.prepare(), /Immutable asset collision/);
  assert.equal(await readFile(join(f.dist, 'assets/build/App-aaaaaaaa.js'), 'utf8'), 'changed');
  assert.deepEqual(await readdir(join(f.dist, 'assets/build')), ['App-aaaaaaaa.js']);
});

test('fails before copying any old build if a retained blob is missing or corrupt', async t => {
  for (const damage of ['missing', 'corrupt']) {
    const f = await fixture(t);
    await f.build({ 'assets/build/App-aaaaaaaa.js': 'A', 'assets/build/shared-aaaaaaaa.js': 'dependency' });
    await f.prepare({ now: NOW - DAY });
    const blob = join(f.history, 'blobs', sha256('dependency'));
    if (damage === 'missing') await rm(blob); else await writeFile(blob, 'wrong');
    await f.build({ 'assets/build/App-bbbbbbbb.js': 'B' });
    const before = await readFile(join(f.history, 'index.json'));
    await assert.rejects(f.prepare());
    assert.deepEqual(await readdir(join(f.dist, 'assets/build')), ['App-bbbbbbbb.js']);
    assert.deepEqual(await readFile(join(f.history, 'index.json')), before);
  }
});

test('rejects path traversal and corrupt manifests before copying files', async t => {
  const f = await fixture(t);
  await f.build({ 'assets/build/App-aaaaaaaa.js': 'A' });
  await f.prepare({ now: NOW - DAY });
  const indexPath = join(f.history, 'index.json');
  const index = JSON.parse(await readFile(indexPath));
  index.builds[0].files[0].path = 'assets/build/../../outside-aaaaaaaa.js';
  // Even a matching manifest checksum cannot authorize a path outside the directory.
  index.builds[0].id = sha256(JSON.stringify(index.builds[0].files));
  await writeFile(indexPath, JSON.stringify(index));
  await f.build({ 'assets/build/App-bbbbbbbb.js': 'B' });
  await assert.rejects(f.prepare(), /Invalid retained asset path/);
  assert.deepEqual(await readdir(join(f.dist, 'assets/build')), ['App-bbbbbbbb.js']);
});

test('rejects symbolic links in current assets, history storage and parent directories', async t => {
  const f = await fixture(t);
  await f.build({ 'assets/build/App-aaaaaaaa.js': 'A' });
  const link = join(f.dist, 'assets/build/linked-aaaaaaaa.js');
  try { await symlink(join(f.dist, 'index.html'), link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Creating symlinks is unavailable'); throw error; }
  await assert.rejects(f.prepare(), /regular files/);
  await rm(link);
  await f.prepare();
  const blob = join(f.history, 'blobs', sha256('A'));
  await rm(blob);
  await symlink(join(f.dist, 'index.html'), blob, 'file');
  await assert.rejects(f.prepare(), /Unexpected file in retained blob storage/);
  const parentLink = join(f.root, 'history-link');
  await symlink(f.history, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.prepare({ history: parentLink }), /Symbolic links/);
});

test('rejects overlapping directories, nested build paths and oversized current builds', async t => {
  const f = await fixture(t);
  await f.build({ 'assets/build/App-aaaaaaaa.js': 'current' });
  await assert.rejects(f.prepare({ history: join(f.dist, 'history') }), /separate directories/);
  await assert.rejects(f.prepare({ maxBytes: 1 }), /exceeds retention limit/);
  await mkdir(join(f.dist, 'assets/build/nested'));
  await assert.rejects(f.prepare(), /regular files/);
});

test('retention permits only flat content-hashed asset paths', () => {
  assert.equal(isRetainableBuildAsset('assets/build/_helper-B_0YonpH.js'), true);
  for (const path of ['index.html', 'sw-keep-alive.js', 'assets/old-abcdefgh.js', 'assets/build/nohash.js',
    'assets/build/../secret-abcdefgh.js', 'assets/build/sub/old-abcdefgh.js', 'assets/build\\old-abcdefgh.js',
    '/assets/build/old-abcdefgh.js', 'assets/build/page-abcdefgh.html']) assert.equal(isRetainableBuildAsset(path), false, path);
});

test('the CLI seeds a cache miss and rejects unsupported arguments', async t => {
  const f = await fixture(t);
  await f.build({ 'assets/build/App-aaaaaaaa.js': 'A' });
  const script = fileURLToPath(new URL('./prepare-retained-build-assets.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, '--dist', f.dist, '--history', f.history], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.match(child.stdout, /empty-seeded-current/);
  const invalid = spawnSync(process.execPath, [script, '--unsupported', 'value'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage:/);
});

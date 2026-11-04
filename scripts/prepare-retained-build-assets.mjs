import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RETENTION = Object.freeze({
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBuilds: 32,
  maxFiles: 5_000,
  maxBytes: 256 * 1024 * 1024,
});
const HASH = /^[a-f0-9]{64}$/;
const INDEX_LIMIT = 8 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Vite emits a flat content-hashed directory. HTML, public files and worker entry
// points never belong here. Fail on a nested directory rather than retain half
// of a future build that changes this convention.
export const isRetainableBuildAsset = path =>
  /^assets\/build\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(path)
  && !/\.html?$/i.test(path)
  && !/^assets\/build\/(?:sw-keep-alive|startup-recovery|sullyos-update)-/.test(path);

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function assertNoSymlinks(path) {
  const root = parse(path).root;
  let cursor = root;
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    const stat = await exists(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${cursor}`);
  }
}

function overlaps(a, b) {
  const nested = relative(a, b);
  return !nested || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`));
}

async function regularBytes(path, maxBytes = Infinity) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
  if (stat.size > maxBytes) throw new Error(`File exceeds retention limit: ${path}`);
  return readFile(path);
}

const snapshotId = entries => hash(JSON.stringify(entries));

function validateIndex(index, now) {
  if (index?.version !== 1 || !Array.isArray(index.builds)) throw new Error('Invalid retained asset index');
  const ids = new Set();
  for (const build of index.builds) {
    if (!HASH.test(build?.id) || ids.has(build.id) || !Number.isSafeInteger(build.createdAt)
      || build.createdAt < 0 || build.createdAt > now + 5 * 60_000 || !Array.isArray(build.files)
      || !build.files.length || build.files.length > 10_000) throw new Error('Invalid retained build');
    ids.add(build.id);
    let previous = '';
    for (const file of build.files) {
      if (!isRetainableBuildAsset(file?.path) || file.path <= previous || !HASH.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid retained asset path or metadata');
      previous = file.path;
    }
    if (snapshotId(build.files) !== build.id) throw new Error('Retained build manifest checksum mismatch');
  }
  return index.builds;
}

function union(builds) {
  const files = new Map();
  for (const build of builds) for (const file of build.files) {
    const old = files.get(file.path);
    if (old && (old.sha256 !== file.sha256 || old.bytes !== file.bytes)) {
      throw new Error(`Immutable asset collision: ${file.path}`);
    }
    files.set(file.path, file);
  }
  return files;
}

async function verifiedBlob(directory, file, maxBytes) {
  const bytes = await regularBytes(join(directory, file.sha256), maxBytes);
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Corrupt retained asset: ${file.path}`);
  return bytes;
}

/** Run once on fresh vite output AFTER its SW manifest has been generated, and
 * save history only after deployment succeeds. No entry HTML, SW or public files.
 */
export async function prepareRetainedBuildAssets({ dist, history, now = Date.now(), ...overrides }) {
  const limits = { ...DEFAULT_RETENTION, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid retention limit: ${name}`);
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid retention timestamp');
  if (typeof dist !== 'string' || typeof history !== 'string') throw new Error('Both dist and history are required');
  const output = resolve(dist), archive = resolve(history);
  if (overlaps(output, archive) || overlaps(archive, output)) throw new Error('dist and history must be separate directories');
  await assertNoSymlinks(output);
  await assertNoSymlinks(archive);
  const buildDirectory = join(output, 'assets', 'build');
  await assertNoSymlinks(buildDirectory);
  const currentFiles = [];
  const currentBytes = new Map();
  let currentSize = 0;
  for (const item of (await readdir(buildDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.isSymbolicLink() || !item.isFile()) throw new Error(`Only regular files are allowed in assets/build: ${item.name}`);
    const path = `assets/build/${item.name}`;
    if (!isRetainableBuildAsset(path)) continue;
    if (currentFiles.length >= Math.min(limits.maxFiles, 10_000)) throw new Error('Current build exceeds retention limits');
    const bytes = await regularBytes(join(buildDirectory, item.name), limits.maxBytes);
    currentSize += bytes.length;
    if (currentSize > limits.maxBytes) throw new Error('Current build exceeds retention limits');
    const file = { path, sha256: hash(bytes), bytes: bytes.length };
    currentFiles.push(file);
    currentBytes.set(path, bytes);
  }
  // Use codepoint ordering for portable snapshot hashes, independent of locale.
  currentFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!currentFiles.length) throw new Error('No hashed build assets found; run this after vite build');
  const current = { id: snapshotId(currentFiles), createdAt: now, files: currentFiles };
  const indexPath = join(archive, 'index.json');
  const blobDirectory = join(archive, 'blobs');
  const indexExists = await exists(indexPath);
  const oldBuilds = indexExists ? validateIndex(JSON.parse(await regularBytes(indexPath, INDEX_LIMIT)), now) : [];
  await assertNoSymlinks(blobDirectory);
  const storedBlobs = await exists(blobDirectory) ? await readdir(blobDirectory, { withFileTypes: true }) : [];
  for (const item of storedBlobs) {
    if (item.isSymbolicLink() || !item.isFile() || !HASH.test(item.name)) throw new Error('Unexpected file in retained blob storage');
  }
  const candidates = oldBuilds.filter(build => build.id !== current.id && build.createdAt >= now - limits.maxAgeMs)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const builds = [current, ...candidates];
  // Evict whole oldest builds, preserving every file of each retained release.
  let files;
  for (;;) {
    files = union(builds);
    const bytes = [...files.values()].reduce((sum, file) => sum + file.bytes, 0);
    if (builds.length <= limits.maxBuilds && files.size <= limits.maxFiles && bytes <= limits.maxBytes
      && Buffer.byteLength(JSON.stringify({ version: 1, builds })) + 1 <= INDEX_LIMIT) break;
    if (builds.length === 1) throw new Error('Current build exceeds retention limits');
    builds.pop();
  }
  // Validate everything before changing output. In particular, never publish a
  // different body under an existing immutable name or copy an unverified blob.
  for (const file of files.values()) {
    if (!currentBytes.has(file.path)) await verifiedBlob(blobDirectory, file, limits.maxBytes);
  }
  await mkdir(blobDirectory, { recursive: true });
  for (const file of currentFiles) {
    const blob = join(blobDirectory, file.sha256);
    if (await exists(blob)) await verifiedBlob(blobDirectory, file, limits.maxBytes);
    else await writeFile(blob, currentBytes.get(file.path), { flag: 'wx' });
  }
  let retainedFiles = 0;
  for (const file of files.values()) {
    if (currentBytes.has(file.path)) continue;
    await writeFile(join(output, file.path), await verifiedBlob(blobDirectory, file, limits.maxBytes), { flag: 'wx' });
    retainedFiles++;
  }
  const tempIndex = join(archive, `index-${randomUUID()}.tmp`);
  try {
    await writeFile(tempIndex, `${JSON.stringify({ version: 1, builds })}\n`, { flag: 'wx' });
    await rename(tempIndex, indexPath);
  } finally {
    await unlink(tempIndex).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  const needed = new Set([...files.values()].map(file => file.sha256));
  for (const item of storedBlobs) {
    if (!needed.has(item.name)) await unlink(join(blobDirectory, item.name));
  }
  return {
    historyStatus: oldBuilds.length ? 'restored' : 'empty-seeded-current',
    builds: builds.length,
    currentFiles: currentFiles.length,
    retainedFiles,
    totalFiles: files.size,
    totalBytes: [...files.values()].reduce((sum, file) => sum + file.bytes, 0),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i];
      if (!['--dist', '--history'].includes(key) || !process.argv[i + 1] || options[key.slice(2)]) {
        throw new Error('Usage: node scripts/prepare-retained-build-assets.mjs --dist dist --history .cache/retained-build-assets');
      }
      options[key.slice(2)] = process.argv[i + 1];
    }
    console.log(`Retained build assets: ${JSON.stringify(await prepareRetainedBuildAssets(options))}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

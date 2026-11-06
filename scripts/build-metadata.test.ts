import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build, createServer, type Rollup } from 'vite';
import { transform } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageBuildDefines, pageBuildMetadataPlugin, type PageBuildMetadata } from './build-metadata';

const first: PageBuildMetadata = { buildId: 'm000001-aaaaaaa', branch: 'master', commit: 'aaaaaaa', time: '2026-11-06 10:00 UTC+8' };
const second: PageBuildMetadata = { buildId: 'm000002-bbbbbbb', branch: 'release', commit: 'bbbbbbb', time: '2026-11-06 11:00 UTC+8' };
const globals = (metadata: PageBuildMetadata) => ({ __APP_BUILD_ID__: metadata.buildId, __BUILD_BRANCH__: metadata.branch, __BUILD_COMMIT__: metadata.commit, __BUILD_TIME__: metadata.time });
let root: string;
beforeAll(async () => {
  // Rollup canonicalizes Windows 8.3 paths; use that same spelling for Vite's HTML root.
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'sully-build-metadata-')));
  const html = '<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>';
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, 'wardrobe.html'), html);
  await writeFile(join(root, 'main.js'), `
    export const shared = 'shared-code';
    globalThis.pageIdentity = [__APP_BUILD_ID__, __BUILD_BRANCH__, __BUILD_COMMIT__, __BUILD_TIME__];
    globalThis.openFeature = () => import('./feature.js');
    if (__BUILD_BADGE_VISIBLE__) globalThis.debugOnly = 'debug-only-sentinel';
  `);
  await writeFile(join(root, 'feature.js'), `import { shared } from './main.js'; export const feature = shared + '-feature';`);
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function bundle(metadata: PageBuildMetadata, mode = 'production', featureChange = false) {
  const result = await build({
    root, configFile: false, logLevel: 'silent', base: './', mode,
    plugins: [pageBuildMetadataPlugin(metadata), ...(featureChange ? [{
      name: 'test-real-code-change', transform(code: string, id: string) {
        if (id.endsWith('/feature.js')) return code.replace('-feature', '-changed-feature');
      },
    }] : [])],
    define: { __BUILD_BADGE_VISIBLE__: 'false' },
    build: { write: false, minify: false, rollupOptions: { input: { main: join(root, 'index.html'), wardrobe: join(root, 'wardrobe.html') } } },
  }) as Rollup.RollupOutput;
  return result.output;
}
const scripts = (output: Rollup.RollupOutput['output']) => output
  .filter((item): item is Rollup.OutputChunk => item.type === 'chunk')
  .map(item => ({ name: item.fileName, code: item.code })).sort((a, b) => a.name.localeCompare(b.name));
const html = (output: Rollup.RollupOutput['output'], name = 'index.html') => String((output.find(item => item.fileName === name) as Rollup.OutputAsset).source);
const inline = (page: string) => page.match(/<script\b[^>]*data-sully-build[^>]*>([\s\S]*?)<\/script>/)![1];

describe('page-scoped build metadata', () => {
  it('keeps entry and lazy chunk names/bytes identical when only release metadata changes', async () => {
    const a = await bundle(first), b = await bundle(second);
    expect(scripts(a).length).toBeGreaterThanOrEqual(2);
    expect(scripts(b)).toEqual(scripts(a));
    expect(html(a)).not.toBe(html(b));
    expect(html(b)).toContain(`data-sully-build="${second.buildId}"`);
    expect(scripts(b).map(item => item.code).join('')).not.toMatch(/m000002|bbbbbbb|debug-only-sentinel/);
  });
  it('still invalidates chunks when real functionality changes', async () => {
    const a = await bundle(first), b = await bundle(first, 'production', true);
    expect(scripts(b)).not.toEqual(scripts(a));
    expect(scripts(b).map(item => item.code).join('')).toContain('-changed-feature');
  });
  it.each(['production', 'capacitor'])('initializes every HTML entry before its modules in %s mode', async mode => {
    const output = await bundle(first, mode);
    for (const name of ['index.html', 'wardrobe.html']) {
      const page = html(output, name);
      expect(page.indexOf('Object.assign(globalThis')).toBeLessThan(page.indexOf('type="module"'));
      expect(page).toContain('./assets/');
      const context: Record<string, unknown> = {};
      runInNewContext(inline(page), context);
      expect(context).toMatchObject(globals(first));
    }
  });
  it('reads each document identity from the same compiled code, with safe non-page fallbacks', async () => {
    const { code } = await transform('globalThis.result=[typeof __APP_BUILD_ID__ === "undefined" ? "development" : __APP_BUILD_ID__, typeof __BUILD_BRANCH__ === "undefined" ? "unknown" : __BUILD_BRANCH__, typeof __BUILD_COMMIT__ === "undefined" ? "unknown" : __BUILD_COMMIT__, typeof __BUILD_TIME__ === "undefined" ? "unknown" : __BUILD_TIME__]', { define: pageBuildDefines });
    for (const metadata of [first, second]) {
      const context: Record<string, unknown> = globals(metadata);
      runInNewContext(code, context);
      expect(context.result).toEqual([metadata.buildId, metadata.branch, metadata.commit, metadata.time]);
    }
    const context: Record<string, unknown> = {}; runInNewContext(code, context);
    expect(context.result).toEqual(['development', 'unknown', 'unknown', 'unknown']);
  });
  it('escapes inline-script terminators from descriptive metadata', async () => {
    const unsafe = { ...first, branch: '</script><script>bad()</script>\u2028\u2029' };
    const page = html(await bundle(unsafe));
    expect(page).not.toContain('<script>bad()');
    const context: Record<string, unknown> = {}; runInNewContext(inline(page), context);
    expect(context).toMatchObject(globals(unsafe));
  });
  it('also supplies metadata through the development HTML transform', async () => {
    const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [pageBuildMetadataPlugin(first)], server: { middlewareMode: true } });
    try {
      const page = await server.transformIndexHtml('/index.html', '<html><head></head><body></body></html>');
      expect(page).toContain(`data-sully-build="${first.buildId}"`);
      expect(server.config.define.__APP_BUILD_ID__).toBe(pageBuildDefines.__APP_BUILD_ID__);
    } finally { await server.close(); }
  });
});

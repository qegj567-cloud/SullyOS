import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { build } from 'esbuild';
import type { Plugin, ResolvedConfig, Rollup } from 'vite';
import type { StaticManifest } from '../worker/staticCache';
import { workerBundleOptions } from './worker-bundle-options.mjs';

const resourceFile = (path: string) => /\.(?:html|js|css|json|webmanifest|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|wasm|task|glb|gltf|vrm|moc3|mp3|ogg|wav)$/i.test(path)
  && !/^(?:sw-keep-alive\.js|sullyos-update\.json|amsg-|instant-worker)/.test(path);

export interface Release { buildId: string; appVersion: string }

export function makeStaticManifest(release: Release, files: Map<string, Buffer>, extraShell: string[] = []): StaticManifest {
  const entries = [...files].filter(([path]) => resourceFile(path)).sort(([a], [b]) => a.localeCompare(b)).map(([url, bytes]) => ({
    url, bytes: bytes.length, revision: createHash('sha256').update(bytes).digest('hex'),
  }));
  const known = new Set(entries.map(entry => entry.url));
  const shell = new Set(['index.html', ...extraShell]);
  const html = files.get('index.html')?.toString('utf8') || '';
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const url = new URL(match[1], 'https://build.invalid/');
    if (url.origin === 'https://build.invalid' && known.has(url.pathname.slice(1))) shell.add(url.pathname.slice(1));
  }
  for (const path of shell) {
    if (!path.endsWith('.css')) continue;
    for (const match of (files.get(path)?.toString('utf8') || '').matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
      const url = new URL(match[1], `https://build.invalid/${path}`);
      if (url.origin === 'https://build.invalid' && known.has(url.pathname.slice(1))) shell.add(url.pathname.slice(1));
    }
  }
  return { ...release, entries, shell: [...shell].filter(path => known.has(path)) };
}

/** Only the OS entry and recovery settings belong to the offline shell. */
export function collectShellChunks(bundle: Rollup.OutputBundle): string[] {
  const core = new Set<string>();
  const visit = (path: string) => {
    if (core.has(path)) return;
    core.add(path);
    const item = bundle[path];
    if (item?.type === 'chunk') {
      item.imports.forEach(visit);
      const metadata = (item as unknown as { viteMetadata?: { importedCss: Set<string> } }).viteMetadata;
      metadata?.importedCss.forEach(path => core.add(path));
      // importedAssets includes mere URL constants for large game images/PDF workers.
      // Those are optional; actual CSS font/image dependencies are handled by the manifest.
    }
  };
  for (const item of Object.values(bundle)) {
    if (item.type === 'chunk' && ((item.isEntry && item.name === 'main') || ['Launcher', 'Settings'].includes(item.name))) visit(item.fileName);
  }
  return [...core];
}

/** Runs even on providers that call `vite build` directly. */
export function staticCachePlugin(release: Release): Plugin {
  let config: ResolvedConfig;
  let core: string[] = [];
  return {
    name: 'sully-static-cache', apply: 'build',
    configResolved(value) { config = value; },
    generateBundle(_options, bundle) {
      core = collectShellChunks(bundle);
    },
    async closeBundle(error) {
      // A failed build leaves nothing to scan. The native app loads its files from the package,
      // so it keeps the push-only worker copied from public/.
      if (error || config.mode === 'capacitor') return;
      const directory = resolve(config.root, config.build.outDir);
      const files = new Map<string, Buffer>();
      async function walk(path: string) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const full = resolve(path, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) {
            const name = relative(directory, full).split('\\').join('/');
            if (resourceFile(name)) files.set(name, await readFile(full));
          }
        }
      }
      await walk(directory);
      const manifest = makeStaticManifest(release, files, [...core]);
      await build({
        ...workerBundleOptions,
        entryPoints: [resolve(config.root, 'worker/sw-keep-alive.ts')], outfile: resolve(directory, 'sw-keep-alive.js'),
        define: { __STATIC_CACHE_MANIFEST__: JSON.stringify(manifest) },
      });
      const bytes = manifest.entries.filter(entry => manifest.shell.includes(entry.url)).reduce((sum, entry) => sum + entry.bytes, 0);
      config.logger.info(`Static cache: ${manifest.shell.length} shell files (${(bytes / 1024 / 1024).toFixed(1)} MiB), ${manifest.entries.length} versioned resources`);
    },
  };
}

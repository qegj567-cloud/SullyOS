import { describe, expect, it } from 'vitest';
import type { Rollup } from 'vite';
import { collectShellChunks, makeStaticManifest } from './static-cache-build';

describe('static cache build manifest', () => {
  it('includes local shell dependencies and revisions, but leaves large optional assets out of precache', () => {
    const manifest = makeStaticManifest({ buildId: 'build-one', appVersion: 'v1.0' }, new Map([
      ['index.html', Buffer.from('<script src="./vendor/tailwind.js"></script><script type="module" src="./assets/build/index-abcdefgh.js"></script>')],
      ['vendor/tailwind.js', Buffer.from('runtime')],
      ['assets/build/index-abcdefgh.js', Buffer.from('app')],
      ['mediapipe/model.task', Buffer.from('large model')],
      ['sw-keep-alive.js', Buffer.from('worker')],
      ['sullyos-update.json', Buffer.from('{}')],
      ['amsg-worker.bundle.js', Buffer.from('deploy script')],
    ]));
    expect(manifest).toMatchObject({ buildId: 'build-one', appVersion: 'v1.0' });
    expect(manifest.shell).toEqual(expect.arrayContaining(['index.html', 'vendor/tailwind.js', 'assets/build/index-abcdefgh.js']));
    expect(manifest.shell).not.toContain('mediapipe/model.task');
    expect(manifest.entries.map(entry => entry.url)).toContain('mediapipe/model.task');
    expect(manifest.entries.map(entry => entry.url)).not.toEqual(expect.arrayContaining(['sw-keep-alive.js']));
    expect(manifest.entries.some(entry => /sullyos-update|amsg-worker/.test(entry.url))).toBe(false);
    expect(manifest.entries.find(entry => entry.url === 'vendor/tailwind.js')?.revision).toHaveLength(64);
  });
  it('changes the content revision of an unversioned image when it is replaced', () => {
    const a = makeStaticManifest({ buildId: 'a', appVersion: 'v1.0' }, new Map([['index.html', Buffer.from('html')], ['themes/a.webp', Buffer.from('one')]]));
    const b = makeStaticManifest({ buildId: 'b', appVersion: 'v1.0' }, new Map([['index.html', Buffer.from('html')], ['themes/a.webp', Buffer.from('two')]]));
    expect(a.entries.find(e => e.url === 'themes/a.webp')?.revision).not.toBe(b.entries.find(e => e.url === 'themes/a.webp')?.revision);
  });
});

describe('offline shell entry selection', () => {
  it('keeps desktop and settings available without downloading the independent wardrobe or unopened apps', () => {
    const chunk = (name: string, imports: string[] = [], css: string[] = [], isEntry = false) => ({
      type: 'chunk', name, fileName: name + '.js', isEntry, imports,
      dynamicImports: ['ChatApp.js'], viteMetadata: { importedCss: new Set(css) },
    } as unknown as Rollup.OutputChunk);
    const bundle: Rollup.OutputBundle = {
      'main.js': chunk('main', ['shared.js'], ['desktop.css'], true),
      'shared.js': chunk('shared'),
      'Launcher.js': chunk('Launcher', ['shared.js']),
      'Settings.js': chunk('Settings', ['shared.js'], ['settings.css']),
      'wardrobe.js': chunk('wardrobe', ['HairEditor.js', 'three.js'], ['wardrobe.css'], true),
      'HairEditor.js': chunk('HairEditor', ['three.js']),
      'three.js': chunk('three'),
      'ChatApp.js': chunk('ChatApp'),
    };
    expect(new Set(collectShellChunks(bundle))).toEqual(new Set([
      'main.js', 'shared.js', 'desktop.css', 'Launcher.js', 'Settings.js', 'settings.css',
    ]));
  });
});

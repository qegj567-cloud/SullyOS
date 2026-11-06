import type { Plugin } from 'vite';

export interface PageBuildMetadata {
  buildId: string;
  branch: string;
  commit: string;
  time: string;
}

// Keep these expressions identical across releases. Inlining a timestamp/commit into the
// shared entry chunk invalidates its hash and then every lazy chunk that imports it.
export const pageBuildDefines = {
  __APP_BUILD_ID__: 'globalThis.__APP_BUILD_ID__',
  __BUILD_BRANCH__: 'globalThis.__BUILD_BRANCH__',
  __BUILD_COMMIT__: 'globalThis.__BUILD_COMMIT__',
  __BUILD_TIME__: 'globalThis.__BUILD_TIME__',
};

/** Metadata belongs to this document, not a separately fetched mutable config file.
 * Old tabs and offline entry pages retain their own release identity. All HTML entries
 * (including the native build and standalone wardrobe) receive it before modules run. */
export function pageBuildMetadataPlugin(metadata: PageBuildMetadata): Plugin {
  const values = { __APP_BUILD_ID__: metadata.buildId, __BUILD_BRANCH__: metadata.branch, __BUILD_COMMIT__: metadata.commit, __BUILD_TIME__: metadata.time };
  const json = JSON.stringify(values).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return {
    name: 'sully-page-build-metadata',
    config: () => ({ define: pageBuildDefines }),
    transformIndexHtml: {
      // Add after Vite's module processing so this stays inline rather than becoming a chunk.
      order: 'post',
      handler: () => [{
        tag: 'script',
        attrs: { 'data-sully-build': metadata.buildId },
        children: `Object.assign(globalThis,${json});`,
        injectTo: 'head-prepend',
      }],
    },
  };
}

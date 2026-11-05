#!/usr/bin/env node
// node >= 20
//
// Builds every esbuild-bundled Worker in the WORKERS manifest. Dual-output:
//   worker/<name>/worker.bundle.js   ← user copies this into the CF dashboard
//   public/<outName>                 ← vite ships to dist/, Modal fetch reads it
//
// Adding a new Worker:
//   1. drop the entry at worker/<new>/src/index.ts
//   2. add a row to WORKERS below
//   3. that's it — `pnpm run build` (which chains to build:workers) picks it up
//
// Why a manifest array instead of auto-discover: the manifest is explicit
// about which workers go through this pipeline.

import { build } from 'esbuild';
import { existsSync, statSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { workerBundleBanner, workerBundleOptions } from './worker-bundle-options.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Each entry can override entry/outWorker/outPublic paths so we can bundle:
//   - per-worker dirs (worker/<name>/src/index.ts → worker/<name>/worker.bundle.js + public/<outName>)
//   - flat single-file workers (worker/<name>.ts → public/<name>.js only — no worker.bundle.js sibling)
const WORKERS = [
  // sw-keep-alive 是 SullyOS 的 service worker, 唯一消费者是浏览器从 /public 静态读, 不需要
  // CF wrangler 单独部署 (没 worker.bundle.js sibling). 之前 bundle 是手工跑 esbuild, Round 2
  // 起接进 build:workers 一起做, 避免 worker/sw-keep-alive.ts 跟 public/sw-keep-alive.js 漂移.
  {
    name: 'sw-keep-alive',
    entryPath: 'worker/sw-keep-alive.ts',
    outPublic: 'public/sw-keep-alive.js',
    skipWorkerOut: true,
  },
  // post-office 是纯后端（跨用户漂流信），不被前端静态 fetch，所以只产 worker.bundle.js
  // 供粘进 CF 面板（选 ES Module 格式）或对照 wrangler deploy，不写 public/。
  {
    name: 'post-office',
    skipPublicOut: true,
  },
  // amsg = 主动消息 2.0 的单用户 worker（amsg-server/cloudflare, D1 + Cron Trigger）。
  // public/ 副本给设置页「复制 Worker 代码」按钮 fetch。amsg-server 2.6.0-next.2 起
  // 全 Web Crypto，免 nodejs_compat flag。
  { name: 'amsg', outName: 'amsg-worker.bundle.js' },
];

console.log(`Building ${WORKERS.length} worker bundle(s)...`);

for (const w of WORKERS) {
  const entry = resolve(root, w.entryPath || `worker/${w.name}/src/index.ts`);
  if (!existsSync(entry)) {
    console.error(`ERROR: entry not found for "${w.name}": ${entry}`);
    process.exit(1);
  }

  const outputs = [];

  let outWorker = null;
  if (!w.skipWorkerOut) {
    outWorker = resolve(root, w.outWorker || `worker/${w.name}/worker.bundle.js`);
    outputs.push(outWorker);
  }
  let outPublic = null;
  if (!w.skipPublicOut) {
    outPublic = resolve(root, w.outPublic || `public/${w.outName}`);
    outputs.push(outPublic);
  }
  if (outputs.length === 0) {
    console.error(`ERROR: "${w.name}" skips both worker and public output — nothing to build`);
    process.exit(1);
  }

  for (const out of outputs) {
    await build({ ...workerBundleOptions, entryPoints: [entry], outfile: out, banner: workerBundleBanner });
  }

  const sizeRef = outWorker || outPublic;
  const sizeKb = (statSync(sizeRef).size / 1024).toFixed(1);
  const dest = [
    outWorker && (w.outWorker || `worker/${w.name}/worker.bundle.js`),
    outPublic && (w.outPublic || `public/${w.outName}`),
  ].filter(Boolean).join(' + ');
  console.log(`✓ ${w.name.padEnd(16)} ${sizeKb} KB  → ${dest}`);
}

// 原样复制到 public/ 的单文件脚本（不过 esbuild）。
//
// 为什么不打包：这些文件没有 import，是自包含单文件，而 Deno Playground 原生吃
// TypeScript。过一遍 esbuild 只会剥掉类型、还可能顺手把注释吃了 —— 而这类脚本
// 恰恰要用户读着注释改配置（比如 amsg 代理里的 UPSTREAM 那一行），注释没了就废了。
const VERBATIM_COPIES = [
  // amsg 的 Deno 门面：给 Cloudflare worker 换一个国内能直连的地址。
  // 设置页「复制 Deno 代理代码」按钮 fetch 这份。
  { from: 'worker/amsg/deno-proxy.ts', to: 'public/amsg-deno-proxy.ts' },
];

for (const { from, to } of VERBATIM_COPIES) {
  const src = resolve(root, from);
  if (!existsSync(src)) {
    console.error(`ERROR: verbatim copy source not found: ${from}`);
    process.exit(1);
  }
  copyFileSync(src, resolve(root, to));
  const sizeKb = (statSync(src).size / 1024).toFixed(1);
  console.log(`✓ ${from.split('/').pop().padEnd(16)} ${sizeKb} KB  → ${to} (原样复制)`);
}

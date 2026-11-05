// 用户的 Worker 自动更新只认提交进仓库的 worker.bundle.js。改了 worker 代码、按规矩升了
// AMSG_BUNDLE_VERSION，却忘了跑 `pnpm run build:workers`，线上就永远拿不到这次改动，
// 前端还会一直认为「有新版可更」。这里核对一下打包产物里的版本号，把这种漏打包拦在提交前。
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { AMSG_BUNDLE_VERSION } from '../../../utils/amsgBundleVersion';

it('提交的 worker.bundle.js 和源码版本号一致（改了 worker 要重新打包）', () => {
  const bundle = readFileSync(new URL('../worker.bundle.js', import.meta.url), 'utf8');
  const bundled = bundle.match(/var AMSG_BUNDLE_VERSION = "([^"]+)";/)?.[1];
  expect(bundled, '版本号对不上就跑 pnpm run build:workers，再把 worker/amsg/worker.bundle.js 一起提交').toBe(AMSG_BUNDLE_VERSION);
});

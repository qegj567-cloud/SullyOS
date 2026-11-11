// 主动消息 2.0 后端 bundle（worker/amsg）代码版本的唯一出处。
//
// worker bundle（worker/amsg/src/index.ts → GET /config-check 的 workerVersion）和
// SullyOS 前端（设置页判断「有没有新版可更」）都从这里 import，所以用户那台 Worker 报回来的
// 版本和 App 里认的版本不会各说各话——除非那台 Worker 贴的是旧 bundle，而那正是要认出来的事。
//
// 什么时候改：worker/amsg/src/* 有了「用户不更新就用不上 / 会出错」的改动时。
// 纯注释、纯重构不用动。格式 YYYY-MM-DD，同一天发第二版就加 .2/.3 后缀；
// 前端用 compareBundleVersions 比新旧：Worker 比 App 旧才催更新；Worker 比 App 新
// （App 缓存的是旧构建，还没刷新）就请用户刷新页面。
//
// 跟另外两个版本号分清楚：
//   - utils/amsgWorkerVersion.ts 比的是**上游库** @rei-standard/amsg-server 的 semver；
//   - utils/buildInfo.ts 的 APP_VERSION 是整个 SullyOS App 的版本。
//   这里管的只有一样：用户自己那台 Worker 上跑的这份 bundle 是哪天的。
export const AMSG_BUNDLE_VERSION = '2026-11-11.2';

const BUNDLE_VERSION_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?$/;

/**
 * 比两个 bundle 版本谁新：a 比 b 新返回正数、旧返回负数、一样返回 0；格式认不出返回 null。
 * 同一天的后缀按数字比（.2 < .10），不带后缀的算 .0。
 */
export const compareBundleVersions = (a: string, b: string): number | null => {
  const left = BUNDLE_VERSION_PATTERN.exec(a);
  const right = BUNDLE_VERSION_PATTERN.exec(b);
  if (!left || !right) return null;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  return Number(left[2] ?? 0) - Number(right[2] ?? 0);
};

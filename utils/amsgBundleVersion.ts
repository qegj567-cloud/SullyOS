// 主动消息 2.0 后端 bundle（worker/amsg）代码版本的唯一出处。
//
// worker bundle（worker/amsg/src/index.ts → GET /config-check 的 workerVersion）和
// SullyOS 前端（设置页判断「有没有新版可更」）都从这里 import，所以用户那台 Worker 报回来的
// 版本和 App 里认的版本不会各说各话——除非那台 Worker 贴的是旧 bundle，而那正是要认出来的事。
//
// 什么时候改：worker/amsg/src/* 有了「用户不更新就用不上 / 会出错」的改动时。
// 纯注释、纯重构不用动。格式 YYYY-MM-DD，同一天发第二版就加 .2/.3 后缀；
// 前端直接按字符串比对，不相等就是「有更新」，不做大小排序。
//
// 跟另外两个版本号分清楚：
//   - utils/amsgWorkerVersion.ts 比的是**上游库** @rei-standard/amsg-server 的 semver；
//   - utils/buildInfo.ts 的 APP_VERSION 是整个 SullyOS App 的版本。
//   这里管的只有一样：用户自己那台 Worker 上跑的这份 bundle 是哪天的。
export const AMSG_BUNDLE_VERSION = '2026-10-08';

/**
 * 构建版本相关常量的单一来源。
 *
 * `__BUILD_BRANCH__` / `__BUILD_COMMIT__` 是 vite.config.ts 注入的全局常量（prod 也有真值），
 * 但「branch@commit」这个 user-facing 标签字符串原本在 BuildBadge / VersionInfo / DevDebugPanel
 * 三处分别现拼，想加 dirty 标、截短 commit 之类要改三处——抽到这里集中维护。
 */

/** "branch@shortCommit" 形式的构建标签；BuildBadge 角标、设置页 VersionInfo、调试面板都用这一份。 */
export const BUILD_LABEL = `${__BUILD_BRANCH__}@${__BUILD_COMMIT__}`;

/** 设置页底部的产品版本名（手工维护），跟构建 hash 是两码事——发版前改这里。 */
export const APP_VERSION = 'v2.2 (Realtime Awareness)';

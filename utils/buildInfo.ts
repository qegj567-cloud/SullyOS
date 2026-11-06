/**
 * 构建版本相关常量的单一来源。
 *
 * `__BUILD_BRANCH__` / `__BUILD_COMMIT__` / `__BUILD_TIME__`
 * 由 Vite 替换成当前 HTML 里的发布元数据读取（prod 也有真值），
 * 时间/commit 不再烤进共享代码，避免无源码变化的构建让功能包集体换 hash。
 * 但「branch@commit」这个 user-facing 标签字符串原本在 BuildBadge / VersionInfo / DevDebugPanel
 * 三处分别现拼，想加 dirty 标、截短 commit 之类要改三处——抽到这里集中维护。
 */

/** "branch@shortCommit" 形式的构建标签；BuildBadge 角标、设置页 VersionInfo、调试面板都用这一份。 */
export const BUILD_LABEL = `${__BUILD_BRANCH__}@${__BUILD_COMMIT__}`;

/** 构建时间标签，固定由 Vite 按 UTC+8 注入，避免受用户本机时区影响。 */
export const BUILD_TIME_LABEL = __BUILD_TIME__;

/** 产品版本名和它的版本号那半截，在 appVersion.ts 里维护。 */
export { APP_VERSION, APP_VERSION_TAG } from './appVersion';

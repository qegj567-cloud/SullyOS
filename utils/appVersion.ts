/**
 * 产品版本名（手工维护），设置页底部显示的就是它——发版前改这里。
 *
 * 单独放一个文件，是因为构建脚本也要读它：网页更新靠版本号判断要不要弹提示，
 * 而 buildInfo.ts 依赖 Vite 注入的全局常量，没法在 Node 里直接 import。
 */
export const APP_VERSION = 'v3.15 (Neighbors)';

/**
 * 版本号那半截（`v3.0`）。统计给每条记录打的标签用它，面板里按版本切分数据时
 * 标签越短越好筛，代号留给设置页展示。跟着 APP_VERSION 走，改一处就够。
 */
export const APP_VERSION_TAG = APP_VERSION.split(' ')[0];

/**
 * canary 版本通道的常量与纯判断。设计见 docs/canary-channel.md。
 *
 * 零依赖叶子：vite.config.ts 也 import 它。加入 / 退出的流程在 ./releaseChannelSwitch。
 * 跳转本身在 public/release-channel-gate.js（内联进 <head>），键名两边要一致，有测试对照。
 */

export type ReleaseChannel = 'stable' | 'canary';

/** 这一份前端是哪个通道，构建时由 RELEASE_CHANNEL 决定。测试环境没有注入，按正式版算。 */
export const RELEASE_CHANNEL: ReleaseChannel =
  typeof __RELEASE_CHANNEL__ !== 'undefined' && __RELEASE_CHANNEL__ === 'canary' ? 'canary' : 'stable';

/**
 * 网页更新拿来判断「要不要弹提示」的版本号（SW 清单的 appVersion 与页面两边用同一个式子算）。
 * 正式版就是 APP_VERSION 那半截，只有大版本才打扰正在用的人；canary 拼上构建号，每次发布都弹，
 * 志愿者刷不出新构建就测不到新东西。
 */
export const releaseUpdateVersion = (appVersionTag: string, channel: ReleaseChannel, buildId: string): string =>
  channel === 'canary' ? `${appVersionTag}-canary.${buildId}` : appVersionTag;

/** 只有这个网址提供 canary：数据按网址隔离，别的官方站点去不了 /canary/。 */
export const CANARY_HOST = 'friedsully.com';
export const CANARY_BASE = '/canary/';

/** 用户选了哪个通道。同网址下两个前端共用这一条。 */
export const RELEASE_CHANNEL_STORAGE_KEY = 'sullyos_release_channel';
/** 正式版往 canary 跳之前加一，canary 挂载成功后清零；到 2 就自动退回。 */
export const CANARY_BOOT_ATTEMPTS_KEY = 'sullyos_canary_boot_attempts';
/** 自动退回后，正式版启动时提示一次。 */
export const CANARY_FALLBACK_NOTICE_KEY = 'sullyos_canary_fallback_notice';
/** 刚切过通道：到达的那一边要把自己的推送订阅登记到 Worker。 */
export const CHANNEL_ARRIVAL_KEY = 'sullyos_channel_arrival';

const readKey = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeKey = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 存不下就当没切成，调用方照常提示。
  }
};

export const readChosenChannel = (): ReleaseChannel =>
  readKey(RELEASE_CHANNEL_STORAGE_KEY) === 'canary' ? 'canary' : 'stable';

/**
 * 本地选择和这份前端一致吗。不一致说明跳转还没生效（正式版正要跳去 canary，或反过来），
 * 这时不许动 Worker 的通道：否则会把它拉向马上就要离开的这一边。
 */
export const isChannelChoiceSettled = (buildChannel: ReleaseChannel = RELEASE_CHANNEL): boolean =>
  readChosenChannel() === buildChannel;

/** 写下新的通道选择，并标记「刚切过」，到达那一边据此补登记推送。 */
export const writeChosenChannel = (channel: ReleaseChannel): void => {
  writeKey(RELEASE_CHANNEL_STORAGE_KEY, channel);
  writeKey(CANARY_BOOT_ATTEMPTS_KEY, null);
  writeKey(CHANNEL_ARRIVAL_KEY, '1');
};

/** 读一次就清掉的标记。 */
const consumeFlag = (key: string): boolean => {
  if (readKey(key) !== '1') return false;
  writeKey(key, null);
  return true;
};

export const consumeChannelArrival = (): boolean => consumeFlag(CHANNEL_ARRIVAL_KEY);
export const consumeCanaryFallbackNotice = (): boolean => consumeFlag(CANARY_FALLBACK_NOTICE_KEY);

/** 切到另一个通道时去哪：保留当前路径之外的部分没有意义，回到各自的首页。 */
export const channelHomeUrl = (channel: ReleaseChannel): string => (channel === 'canary' ? CANARY_BASE : '/');

/** canary 里右下角的小黄点藏不藏。这台设备的偏好，不进备份。 */
export const CANARY_DOT_HIDDEN_KEY = 'sullyos_canary_dot_hidden';
/** 设置里切换开关时通知黄点重新读取。 */
export const CANARY_DOT_CHANGED_EVENT = 'sullyos-canary-dot-changed';

export const readCanaryDotHidden = (): boolean => readKey(CANARY_DOT_HIDDEN_KEY) === '1';

export const writeCanaryDotHidden = (hidden: boolean): void => {
  writeKey(CANARY_DOT_HIDDEN_KEY, hidden ? '1' : null);
  globalThis.dispatchEvent?.(new Event(CANARY_DOT_CHANGED_EVENT));
};

/** canary 挂载后稳住这么久才算启动成功：React 渲染阶段崩掉会把整棵树卸掉。 */
export const CANARY_HEALTHY_AFTER_MS = 5000;

/** canary 构建挂载后调用：根节点稳住一段时间还有内容，就把启动计数清零。 */
export const watchCanaryBootHealth = (root: HTMLElement, buildChannel: ReleaseChannel = RELEASE_CHANNEL): void => {
  if (buildChannel !== 'canary') return;
  setTimeout(() => {
    if (root.childElementCount > 0) writeKey(CANARY_BOOT_ATTEMPTS_KEY, null);
  }, CANARY_HEALTHY_AFTER_MS);
};

export interface CanaryJoinContext {
  hostname: string;
  native: boolean;
  /** 没开主动消息 2.0 就是 null；开着时报那台 Worker 能不能自更新、认不认通道。 */
  amsg: { selfUpdateSupported: boolean; workerChannel: ReleaseChannel | null } | null;
}

/** 为什么不能加入；能加入返回 null。文案直接显示在按钮下面。 */
export const describeCanaryJoinBlocker = (context: CanaryJoinContext): string | null => {
  if (context.native) return 'canary 只提供网页版。';
  if (context.hostname !== CANARY_HOST) return `canary 只在 ${CANARY_HOST} 上提供，这里的数据去不了那边。`;
  if (context.amsg) {
    if (!context.amsg.selfUpdateSupported) return '主动消息 2.0 的 Worker 没有开启自动更新，换不成 canary 版本。';
    if (!context.amsg.workerChannel) return '主动消息 2.0 的 Worker 版本太旧，先更新 Worker。';
  }
  return null;
};

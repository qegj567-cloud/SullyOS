/**
 * canary 的版本主题色：金黄配白（docs/canary-channel.md「金黄主题」）。
 * 只换系统默认配色，用户自己调过的颜色照常生效；只改显示，不写回设置，回到正式版自动恢复。
 */
import { RELEASE_CHANNEL, type ReleaseChannel } from './releaseChannel';

export interface AccentColor {
  hue: number;
  saturation: number;
  lightness: number;
}

/** 系统强调色上大量压白字，亮黄配白看不清，这里取深一点的蜂蜜金（对白字约 3.3:1）。 */
export const CANARY_ACCENT: AccentColor = { hue: 40, saturation: 85, lightness: 40 };

/** 强调色还是出厂值时，canary 显示金色；用户动过任何一项就用用户的。 */
export const resolveDisplayAccent = (
  theme: AccentColor,
  factory: AccentColor,
  channel: ReleaseChannel = RELEASE_CHANNEL,
): AccentColor => {
  const untouched = theme.hue === factory.hue && theme.saturation === factory.saturation && theme.lightness === factory.lightness;
  return channel === 'canary' && untouched ? CANARY_ACCENT : theme;
};

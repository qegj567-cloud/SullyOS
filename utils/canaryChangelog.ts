/**
 * canary 更新日志（docs/canary-channel.md「更新日志」）。
 *
 * 每次把 canary 快进到新提交之前，在最上面补当天的条目：写给 canary 志愿者看，一条一句，
 * 说这次能试什么、修了什么。同一天发了几次就往当天追加。canary 里每条按「日期 + 原文」认，
 * 没看过的条目在更新后第一次打开时按天弹出来；改了某条的措辞会被当成新条目再弹一次。
 */
import { RELEASE_CHANNEL, type ReleaseChannel } from './releaseChannel';

export interface CanaryChangelogDay {
  /** YYYY-MM-DD，新的在前。 */
  date: string;
  items: string[];
}

export const CANARY_CHANGELOG: CanaryChangelogDay[] = [
  {
    date: '2026-11-24',
    items: [
      'canary 有了更新日志：每次更新后第一次打开，会按天列出新加的改动。',
    ],
  },
];

/** 看过的条目。这台设备的状态，不进备份。 */
export const CANARY_CHANGELOG_SEEN_KEY = 'sullyos_canary_changelog_seen';

const entryKey = (date: string, item: string): string => `${date}\n${item}`;

/** 没看过的条目，按天分组，保持日志里的顺序。 */
export const unseenCanaryChangelog = (log: CanaryChangelogDay[], seen: ReadonlySet<string>): CanaryChangelogDay[] =>
  log
    .map((day) => ({ date: day.date, items: day.items.filter((item) => !seen.has(entryKey(day.date, item))) }))
    .filter((day) => day.items.length > 0);

/** 读不出来返回 null：宁可这次不弹，也别因为存储坏了每次开机都弹。 */
const readSeen = (): Set<string> | null => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CANARY_CHANGELOG_SEEN_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return null;
  }
};

/** 只记日志里现在还有的条目，删掉的旧条目跟着从记录里消失，记录不会越攒越大。 */
export const markCanaryChangelogSeen = (log: CanaryChangelogDay[] = CANARY_CHANGELOG): void => {
  try {
    localStorage.setItem(
      CANARY_CHANGELOG_SEEN_KEY,
      JSON.stringify(log.flatMap((day) => day.items.map((item) => entryKey(day.date, item)))),
    );
  } catch {
    // 存不下就下次再弹一遍。
  }
};

/**
 * 这次启动要弹的条目。刚加入 canary 的那次启动有小金丝雀落地动画，日志不叠上去，
 * 直接记成看过：加入不是一次更新，之前的条目对新人没有意义。
 */
export const takeCanaryChangelog = (
  arrivedThisBoot: boolean,
  log: CanaryChangelogDay[] = CANARY_CHANGELOG,
  channel: ReleaseChannel = RELEASE_CHANNEL,
): CanaryChangelogDay[] => {
  if (channel !== 'canary') return [];
  if (arrivedThisBoot) {
    markCanaryChangelogSeen(log);
    return [];
  }
  const seen = readSeen();
  return seen ? unseenCanaryChangelog(log, seen) : [];
};

/** 「2026-11-24」显示成「11 月 24 日」。 */
export const formatCanaryChangelogDate = (date: string): string => {
  const [, month, day] = date.split('-').map(Number);
  return `${month} 月 ${day} 日`;
};

/**
 * canary 更新日志（docs/canary-channel.md「更新日志」）。
 *
 * 每次把 dev 发到 canary 之前，在最上面补当天的条目：写给 canary 志愿者看，一条一句，
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
      '开着主动消息 2.0 时，日程、人格模拟、梦境改为交给云端生成：顶部弹出「云端生成」后就可以切出去，生成不会中断。',
      '「云端生成」小条停 3 秒自己收起，也可以上滑收起；点开能看说明，或选「本功能不再提醒」。',
      '设置 → 主动消息 2.0 → 功能总览新增「云端生成」：私聊、日程、人格模拟、梦境可以分别切回本机生成，后三项能单独开关完成通知。',
      '修复：日程生成失败后每次进聊天都会重试；两个角色同时做梦时，前一场还没看就被覆盖。',
      '本次需要更新 Worker（开着自动更新的会自己跟上）。',
      '修复：开着主动消息 2.0 时，见面开了一个多小时才走开会收不到离开提醒；停在见面画面里时，离开后消息会被当成过期丢掉。这条同样要更新 Worker。',
      '报错提示更好读了：不再冒出 [object Object] 这类字样，网关报错只留关键几行；报错记录和诊断导出会带上版本号，密钥、令牌和推送地址自动打码。',
      '使用统计加了几项，用来看云端生成实际救回了多少次被切走打断的生成、失败都卡在哪；只收档位和固定选项，不收聊天内容。',
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

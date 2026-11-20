// 主动消息 2.0 后端「救援模式」的留痕形状：Worker 记在自己的 D1 里，`GET /config-check`
// 原样报出来，前端据此强制弹出安全警告。
//
// 零依赖叶子：worker bundle（worker/amsg/src/rescue.ts）和前端（utils/amsgRescueAlert.ts）
// 都从这里 import，两边对同一份数据不会各说各话。往里加任何浏览器依赖都会连累 bundle。
//
// 完整的设计与取舍见 docs/amsg2-rescue.md。

/** Worker 环境变量名：设了（且够长）就开启救援页。 */
export const AMSG_RESCUE_TOKEN_ENV = 'AMSG_RESCUE_TOKEN';

/** 救援口令最短长度。短于它视为没开启，防止弱口令被猜中。 */
export const AMSG_RESCUE_TOKEN_MIN_LENGTH = 16;

/** 救援模式开着、或最近一次活动距今不超过这么久，前端就要警告。 */
export const AMSG_RESCUE_ALERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 开启救援模式时 Worker 推给所有设备的那条通知的结果种类（`messageKind: 'result'`）。 */
export const AMSG_RESCUE_RESULT_KIND = 'amsg-rescue-alert';

/**
 * 一次「开启救援模式」的留痕。Worker 发现变量从无到有时开一段新的，发现变量没了时
 * 记下 endedAt；下次再设上就是新的一段。
 */
export interface AmsgRescueEpisode {
  /** 这一段的编号（首次发现时刻的十进制字符串），前端拿它区分「是不是新的一次」。 */
  id: string;
  /** Worker 首次发现救援变量的时刻（epoch ms）。 */
  firstSeenAt: number;
  /** 最近一次看到救援变量还在的时刻（epoch ms）。 */
  lastSeenAt: number;
  /** 发现变量已被删掉的时刻；还开着是 null。 */
  endedAt: number | null;
  /** 口令验证通过、拉取导出清单的次数（一次完整导出算一次）。 */
  exportCount: number;
  /** 最近一次拉取导出清单的时刻。 */
  lastExportAt: number | null;
  /** 口令验证通过后读出单条数据的次数。 */
  itemReads: number;
  /** 最近一次读出数据的时刻。 */
  lastReadAt: number | null;
  /** 口令错误的次数。 */
  failedAttempts: number;
  /** 开启通知推送尝试的时刻；还没推过是 null。 */
  pushedAt: number | null;
  /** 推送目标数（云端登记的订阅条数）。 */
  pushTargets: number;
  /** 推送成功的条数。 */
  pushDelivered: number;
}

/** `GET /config-check` 里的 `rescue` 段。老 bundle 没有这个字段。 */
export interface AmsgRescueReport {
  /** 当前环境里救援变量是否设着（且够长）。 */
  active: boolean;
  /** 最近一段留痕；从没开过、或读不到 D1 时是 null。 */
  episode: AmsgRescueEpisode | null;
}

const toTime = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const toCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** 把存下来 / 传过来的 JSON 认成 AmsgRescueEpisode；形状不对就当没有。 */
export const parseAmsgRescueEpisode = (raw: unknown): AmsgRescueEpisode | null => {
  const value = raw as Partial<AmsgRescueEpisode> | null;
  if (!value || typeof value !== 'object') return null;
  const firstSeenAt = toTime(value.firstSeenAt);
  if (typeof value.id !== 'string' || !value.id || firstSeenAt === null) return null;
  return {
    id: value.id,
    firstSeenAt,
    lastSeenAt: toTime(value.lastSeenAt) ?? firstSeenAt,
    endedAt: toTime(value.endedAt),
    exportCount: toCount(value.exportCount),
    lastExportAt: toTime(value.lastExportAt),
    itemReads: toCount(value.itemReads),
    lastReadAt: toTime(value.lastReadAt),
    failedAttempts: toCount(value.failedAttempts),
    pushedAt: toTime(value.pushedAt),
    pushTargets: toCount(value.pushTargets),
    pushDelivered: toCount(value.pushDelivered),
  };
};

/** 把 `/config-check` 的 `rescue` 段认成 AmsgRescueReport；老 bundle 或形状不对时返回 null。 */
export const parseAmsgRescueReport = (raw: unknown): AmsgRescueReport | null => {
  const value = raw as Partial<AmsgRescueReport> | null;
  if (!value || typeof value !== 'object' || typeof value.active !== 'boolean') return null;
  return { active: value.active, episode: parseAmsgRescueEpisode(value.episode) };
};

/** 这一段留痕里最后一次有动静的时刻（看到变量、导出、读数据、口令错误都算）。 */
export const rescueEpisodeLastActivityAt = (episode: AmsgRescueEpisode): number =>
  Math.max(episode.lastSeenAt, episode.endedAt ?? 0, episode.lastExportAt ?? 0, episode.lastReadAt ?? 0);

/**
 * 该不该警告：变量还开着，或者最近一次动静在 7 天之内。
 * `active` 只说明「此刻设着」，留痕被删光时也要照样警告，所以单独算。
 */
export const isRescueAlertDue = (
  active: boolean,
  episode: AmsgRescueEpisode | null,
  nowMs: number,
): boolean => {
  if (active) return true;
  if (!episode) return false;
  return nowMs - rescueEpisodeLastActivityAt(episode) <= AMSG_RESCUE_ALERT_WINDOW_MS;
};

/**
 * 「用户确认过的是哪一次」的键：新开一段、或同一段里又导出了，键就变，弹窗要重新弹。
 * 只读数据不导出清单的情形（直接按编号读）也算进去，所以读次数参与。
 */
export const rescueAlertAckKey = (active: boolean, episode: AmsgRescueEpisode | null): string =>
  episode
    ? `${episode.id}:${episode.exportCount}:${episode.itemReads > 0 ? 'read' : 'none'}`
    : active ? 'active:no-record' : 'none';

// 主动消息 2.0 后端「自更新状态」的形状：Worker 记在自己的诊断表里，`GET /config-check`
// 原样报出来，设置页拿它写「自动更新：上次检查 x 小时前 · 已是最新 / 刚更新过 / 失败原因」。
//
// 零依赖叶子：worker bundle（worker/amsg/src/autoUpdate.ts）和前端（utils/activeMsgClient.ts）
// 都从这里 import，两边对同一份数据不会各说各话。往里加任何浏览器依赖都会连累 bundle。

/** 这次检查是谁发起的：定时（cron 每几小时一次）、App 冷启动时顺手问的、设置页手动点的。 */
export type AmsgSelfUpdateSource = 'cron' | 'client' | 'manual';

export type AmsgSelfUpdateOutcome = 'updated' | 'up_to_date' | 'failed';

export interface AmsgSelfUpdateState {
  /** 上一次检查的时刻（ISO），不管结果如何。 */
  lastCheckAt: string;
  lastSource: AmsgSelfUpdateSource;
  lastOutcome: AmsgSelfUpdateOutcome;
  /**
   * 最近一次确认「线上跑的就是这份」的成品包指纹（sha-256 前 12 位）。
   * 失败时保留上一次的值；从没成功过就是 null。
   */
  bundleHash: string | null;
  /** 上一次真的换上新代码的时刻（ISO）；从没换过就是 null。 */
  lastUpdatedAt: string | null;
  /** 上一次失败的代号和整句；成功后清空。 */
  lastError: { code: string; message: string } | null;
}

/** `GET /config-check` 里那一段：这台 Worker 有没有自更新能力，以及它最近一次检查的结果。 */
export interface AmsgSelfUpdateReport {
  /** 配了 CF_API_TOKEN 才有（一键部署装的、或者后来补过钥匙的）。 */
  supported: boolean;
  /** 从没检查过、或者读不到诊断表时是 null。 */
  state: AmsgSelfUpdateState | null;
}

/** 取出 Cloudflare 判定 token 本身无效的那段原话。9109 也用于权限不够，所以不能只看代码。 */
export const findCfTokenRejection = (text: string): string | null =>
  /\d+: invalid (access|api) token/i.exec(text)?.[0] ?? null;

export const cfTokenRejectedMessage = (detail: string, hasAccountId: boolean): string =>
  `Cloudflare 不认这枚 CF_API_TOKEN（${detail}），多半已经过期或被删了。` +
  '去 Cloudflare 新建一枚（只勾 Workers Scripts → Edit），替换 Worker 里的 CF_API_TOKEN。' +
  (hasAccountId ? '' : '如果它是 cfat_ 开头的账号令牌，换成普通 API Token，或者给 Worker 加一条 CF_ACCOUNT_ID。');

/** token 失效的 Worker 更新不了，会一直报旧提示，所以界面这边按原话再换一次。 */
export const explainCfTokenRejection = (message: string): string => {
  const rejected = findCfTokenRejection(message);
  if (!rejected || message.startsWith('Cloudflare 不认')) return message;
  return cfTokenRejectedMessage(rejected, message.includes('CF_ACCOUNT_ID 指定'));
};

const OUTCOMES: ReadonlySet<string> = new Set(['updated', 'up_to_date', 'failed']);
const SOURCES: ReadonlySet<string> = new Set(['cron', 'client', 'manual']);

/** 把存下来 / 传过来的 JSON 认成 AmsgSelfUpdateState；形状不对就当没有。 */
export const parseAmsgSelfUpdateState = (raw: unknown): AmsgSelfUpdateState | null => {
  const value = raw as Partial<AmsgSelfUpdateState> | null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.lastCheckAt !== 'string' || Number.isNaN(Date.parse(value.lastCheckAt))) return null;
  if (typeof value.lastOutcome !== 'string' || !OUTCOMES.has(value.lastOutcome)) return null;
  const error = value.lastError;
  return {
    lastCheckAt: value.lastCheckAt,
    lastSource: typeof value.lastSource === 'string' && SOURCES.has(value.lastSource) ? value.lastSource : 'cron',
    lastOutcome: value.lastOutcome,
    bundleHash: typeof value.bundleHash === 'string' && value.bundleHash ? value.bundleHash : null,
    lastUpdatedAt: typeof value.lastUpdatedAt === 'string' ? value.lastUpdatedAt : null,
    lastError:
      error && typeof error === 'object' && typeof error.code === 'string'
        ? { code: error.code, message: typeof error.message === 'string' ? error.message : '' }
        : null,
  };
};

/** 多久之前，给设置页那一行用：刚刚 / n 分钟前 / n 小时前 / n 天前。 */
const describeAgo = (iso: string, nowMs: number): string => {
  const diffMs = Math.max(0, nowMs - Date.parse(iso));
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
};

/**
 * 把自更新近况写成设置页上的一句话。
 *
 *   - 没能力（没配 CF_API_TOKEN）→ 不说自动更新的事，返回 null 让界面沿用原来的说明；
 *   - 有能力但从没查过 → 「自动更新已开启，还没检查过」（新装的、或者刚更新上来）；
 *   - 查过 → 上次什么时候查的、结果如何；失败带上代号和整句。
 */
export const describeAmsgSelfUpdate = (report: AmsgSelfUpdateReport | null, nowMs = Date.now()): string | null => {
  if (!report?.supported) return null;
  const state = report.state;
  if (!state) return '自动更新已开启：后端会自己定期检查新代码，打开 App 时也会顺手看一眼。还没检查过。';
  const checked = `上次检查 ${describeAgo(state.lastCheckAt, nowMs)}`;
  if (state.lastOutcome === 'failed') {
    const error = state.lastError;
    return `自动更新已开启。${checked}，没成功${error ? `（${error.code}：${explainCfTokenRejection(error.message)}）` : ''}，到点会再试。`;
  }
  if (state.lastOutcome === 'updated') {
    return `自动更新已开启。${checked}，换上了新代码${state.lastUpdatedAt ? `（${describeAgo(state.lastUpdatedAt, nowMs)}）` : ''}。`;
  }
  const updated = state.lastUpdatedAt ? `上次换代码是 ${describeAgo(state.lastUpdatedAt, nowMs)}。` : '';
  return `自动更新已开启。${checked}，已经是最新。${updated}`;
};

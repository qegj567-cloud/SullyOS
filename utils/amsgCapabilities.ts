/**
 * 主动消息 2.0 功能总览里那张「能力 · 勾叉」表的判定。纯函数，界面只负责画。
 *
 * 四种状态：
 * - ok：此刻能用
 * - bad：开了（或依赖的东西开了），但此刻用不了——Worker 连不上、通知没登记、总开关关了……
 * - off：还没开，点进去能开
 * - checking：正在探测，还不知道
 *
 * 「没开」先于「坏了」：一位角色都没开的能力，不因为 Worker 连不上就标红，免得用户以为自己开过。
 * 总开关关掉时例外，所有行一律标红——这是用户主动暂停，表要一眼说明「现在什么都不会发」。
 */

export type AmsgCapabilityState = 'ok' | 'bad' | 'off' | 'checking';
export type AmsgCapabilityId = 'worker' | 'push' | 'schedule' | 'instant' | 'away' | 'date' | 'mcp';

/** 红叉的原因落在哪个开关或页面上，点这一行就去那儿。 */
export type AmsgCapabilityCause = 'master' | 'worker' | 'push' | 'cron';

export interface AmsgCapabilityRow {
  id: AmsgCapabilityId;
  label: string;
  state: AmsgCapabilityState;
  /** 只有 bad 才有；没有时点行按能力本身的设置位置走 */
  cause?: AmsgCapabilityCause;
  /** 名字下面那行小字：坏了写原因、开着写几位角色，正常且无可补充时为空。 */
  note: string;
}

export interface AmsgCapabilityInput {
  /** 2.0 总开关 */
  enabled: boolean;
  /** Worker 此刻的情况（体检探测 + 版本探测） */
  worker: 'checking' | 'ok' | 'unreachable' | 'outdated';
  /** 这台设备的通知登记 */
  push: 'checking' | 'ok' | 'none' | 'error';
  /** 后台任务（Worker 的定时触发）被用户暂停。定时主动消息、离开后消息、见面离开提醒的云端任务都靠它到点投递。 */
  cronPaused: boolean;
  instantOn: boolean;
  /** 即时对话开着但被挡住的原因（Worker 不支持等），没有为空 */
  instantBlocked: string;
  scheduleChars: number;
  awayChars: number;
  dateChars: number;
  /** 会上云的 MCP 服务器数 */
  mcpServers: number;
}

const LABELS: Record<AmsgCapabilityId, string> = {
  worker: '后台连接',
  push: '这台设备的通知',
  schedule: '定时主动消息',
  instant: '即时对话',
  away: '离开后消息',
  date: '见面离开提醒',
  mcp: '后台调用 MCP 工具',
};

const ORDER: AmsgCapabilityId[] = ['worker', 'push', 'schedule', 'instant', 'away', 'date', 'mcp'];

export function buildAmsgCapabilityRows(input: AmsgCapabilityInput): AmsgCapabilityRow[] {
  const row = (id: AmsgCapabilityId, state: AmsgCapabilityState, note = '', cause?: AmsgCapabilityCause): AmsgCapabilityRow =>
    ({ id, label: LABELS[id], state, note, ...(cause ? { cause } : {}) });
  // 即时对话暂停后聊天回到本机生成，不是聊不了，这一句要说清。
  if (!input.enabled) return ORDER.map(id => row(id, 'bad', id === 'instant' ? '总开关已暂停 · 聊天在本机生成' : '总开关已暂停', 'master'));

  const workerRow = input.worker === 'checking' ? row('worker', 'checking', '正在检测')
    : input.worker === 'ok' ? row('worker', 'ok')
      : row('worker', 'bad', input.worker === 'outdated' ? '后台版本过旧，需要更新' : '这一刻连不上后台', 'worker');
  const pushRow = input.push === 'checking' ? row('push', 'checking', '正在检测')
    : input.push === 'ok' ? row('push', 'ok')
      : input.push === 'none' ? row('push', 'off', '还没开通知')
        : row('push', 'bad', '暂时查不到通知状态', 'push');

  /**
   * 依赖后台的能力：没开 → 探测中 → 后台坏 → 通知坏 → 后台任务被暂停 → 能用。
   * 暂停后台任务和关总开关一样标红：表要一眼说明「这几项现在不会发」。
   * needsPush：结果靠推送送达；needsCron：云端任务靠定时触发到点投递。
   */
  const dependent = (id: AmsgCapabilityId, count: number, opts: { offNote: string; okNote: string; needsPush?: boolean; needsCron?: boolean }) => {
    if (count <= 0) return row(id, 'off', opts.offNote);
    if (input.worker === 'checking' || (opts.needsPush && input.push === 'checking')) return row(id, 'checking', '正在检测');
    if (input.worker !== 'ok') return row(id, 'bad', input.worker === 'outdated' ? '后台版本过旧' : '后台连不上', 'worker');
    if (opts.needsPush && input.push !== 'ok') return row(id, 'bad', '通知没开，消息送不到', 'push');
    if (opts.needsCron && input.cronPaused) return row(id, 'bad', '后台任务已暂停', 'cron');
    return row(id, 'ok', opts.okNote);
  };
  const characters = (count: number) => `${count} 位角色已开`;

  const scheduled = { offNote: '还没有角色开启', needsPush: true, needsCron: true };
  let instant = dependent('instant', input.instantOn ? 1 : 0, { offNote: '开关未打开', okNote: '', needsPush: true });
  if (instant.state === 'ok' && input.instantBlocked) instant = row('instant', 'bad', input.instantBlocked, 'worker');

  return [
    workerRow,
    pushRow,
    dependent('schedule', input.scheduleChars, { ...scheduled, okNote: characters(input.scheduleChars) }),
    instant,
    dependent('away', input.awayChars, { ...scheduled, okNote: characters(input.awayChars) }),
    dependent('date', input.dateChars, { ...scheduled, okNote: characters(input.dateChars) }),
    dependent('mcp', input.mcpServers, { offNote: '还没有可上云的服务器', okNote: `${input.mcpServers} 台服务器` }),
  ];
}

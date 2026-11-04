/**
 * amsg2 调试面板的纯派生层：把角色数据摊成「一条任务一行、带状态标注」的视图。
 *
 * 这里不碰 React、不碰 IndexedDB，全是可单测的纯函数——面板显示错了很容易把排查
 * 带偏（「面板说还没到点，实际早就作废了」），所以判定口径必须钉死并测出来。
 *
 * 两条口径跟系统其它地方对齐，别在这里另起一套：
 *   1. 活/死的分界完全等于 amsg2Tasks.isPendingTask（pending + firing = 它为真）；
 *   2. 人读文案一律用 amsg2Tasks 的 describeXxx，跟角色上下文块、list 工具、设置面板说同一套词。
 */

import { ActiveMsg2TaskRecord, CharacterProfile } from '../types';
import { currentOccurrenceMs, isAmsg2EnabledForChar, isPendingTask } from './amsg2Tasks';

const MINUTE_MS = 60_000;

/**
 * pending  还没到点，倒计时往下走
 * firing   已过名义时间但还在送达宽限内——正在发或正在被闸拦，这会儿最值得盯
 * expired  一次性任务过点超过宽限还没动静
 * cancelled 已取消（清单里短暂存在，取消后就被移除）
 */
export type Amsg2DebugTaskState = 'pending' | 'firing' | 'expired' | 'cancelled';

export interface Amsg2DebugTaskView {
  task: ActiveMsg2TaskRecord;
  charId: string;
  charName: string;
  /** 该角色的主动消息总开关。关着的话任务再正常也不会响。 */
  charEnabled: boolean;
  state: Amsg2DebugTaskState;
  /** 当前这一次触发的名义时刻；循环任务已按周期推算。时间串坏掉时为 null。 */
  occurrenceMs: number | null;
  /** cron 每分钟跑一次，这是这一次触发会被哪一分钟的 cron 领走。 */
  cronTickMs: number | null;
}

/**
 * 这一次触发会被哪一分钟的 cron 领走。
 *
 * worker 的触发器是 "* * * * *"（见 worker/amsg/wrangler.toml），每分钟跑一次；跑起来时
 * 把名义时间已经到了的任务全部领走（底账查询是 next_send_at <= 当前时刻）。所以答案是
 * 「名义时间之后的第一个整分」，含名义时间自己压在整分上的情况：
 *
 *   名义时间 11:47:00 → 11:47 这一分钟的 cron 领走（面板里倒计时归零的同一分钟）
 *   名义时间 11:47:30 → 11:47 那次跑过去时还没到点，等 11:48 这一分钟的 cron
 *
 * cron 实际起跑会比整分晚几秒（平台调度的抖动），这里按整分记——面板要的是「哪一分钟」，
 * 秒级先后不影响读数。
 */
export const nextCronTickMs = (occurrenceMs: number): number =>
  Math.ceil(occurrenceMs / MINUTE_MS) * MINUTE_MS;

/** 面板离视口边缘至少留这么多，四边一致。 */
export const DEBUG_PANEL_MARGIN_PX = 8;

export interface Amsg2PanelPosition { x: number; y: number }
export interface Amsg2PanelSize { width: number; height: number }

/**
 * 把面板落点约束回视口内。拖动过程、松手、视口变化（转屏 / 手机地址栏伸缩）都走这一个口径。
 *
 * 面板比视口还大时（小屏 + 长列表）上下界会翻过来，此时取上界——宁可底部溢出，
 * 也要保证标题栏那排按钮留在屏幕里，不然全屏 / 关闭都点不到了。
 */
export const clampPanelPosition = (
  position: Amsg2PanelPosition,
  panel: Amsg2PanelSize,
  viewport: Amsg2PanelSize,
): Amsg2PanelPosition => {
  const axis = (value: number, extent: number, available: number) => {
    const max = available - extent - DEBUG_PANEL_MARGIN_PX;
    return Math.min(Math.max(value, DEBUG_PANEL_MARGIN_PX), Math.max(DEBUG_PANEL_MARGIN_PX, max));
  };
  return {
    x: axis(position.x, panel.width, viewport.width),
    y: axis(position.y, panel.height, viewport.height),
  };
};

/**
 * 倒计时文案：「4 分 12 秒」「2 小时 3 分」「1 天 2 小时」，已过点前面加「已过」。
 * 只留最大的两级单位：一小时以上还跳秒，读的人只会被晃眼；第二级是 0 时省掉。
 */
export const formatCountdown = (deltaMs: number): string => {
  const total = Math.floor(Math.abs(deltaMs) / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: Array<[number, string]> = d ? [[d, '天'], [h, '小时']]
    : h ? [[h, '小时'], [m, '分']]
      : m ? [[m, '分'], [s, '秒']]
        : [[s, '秒']];
  const text = parts.filter(([value], index) => index === 0 || value > 0)
    .map(([value, unit]) => `${value} ${unit}`).join(' ');
  return deltaMs < 0 ? `已过 ${text}` : text;
};

const resolveState = (
  task: ActiveMsg2TaskRecord,
  occurrenceMs: number | null,
  nowMs: number,
): Amsg2DebugTaskState => {
  if (task.status !== 'scheduled') return 'cancelled';
  // 活/死一律问 isPendingTask，别在这里重写判定——两边一旦走岔，面板就会骗人。
  if (!isPendingTask(task, nowMs)) return 'expired';
  return occurrenceMs != null && nowMs >= occurrenceMs ? 'firing' : 'pending';
};

const STATE_ORDER: Record<Amsg2DebugTaskState, number> = {
  firing: 0,
  pending: 1,
  expired: 2,
  cancelled: 3,
};

/**
 * 全部角色的 amsg2 任务摊平成一张表。失效的任务照样留着（置灰显示）——
 * 排查「怎么没响」时，看得见那条死任务比它凭空消失有用得多。
 */
export const buildAmsg2DebugTasks = (
  characters: CharacterProfile[],
  nowMs: number,
): Amsg2DebugTaskView[] => {
  const views: Amsg2DebugTaskView[] = [];
  for (const char of characters) {
    const config = char?.activeMsg2Config;
    if (!config || !Array.isArray(config.tasks)) continue;
    for (const task of config.tasks) {
      const occurrenceMs = currentOccurrenceMs(task, nowMs);
      views.push({
        task,
        charId: char.id,
        charName: char.name || char.id,
        charEnabled: isAmsg2EnabledForChar(char),
        state: resolveState(task, occurrenceMs, nowMs),
        occurrenceMs,
        cronTickMs: occurrenceMs == null ? null : nextCronTickMs(occurrenceMs),
      });
    }
  }
  // 正在发的最要紧，其次是快到点的；失效的沉底，越近失效的越靠前。
  return views.sort((a, b) => {
    const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (byState !== 0) return byState;
    const at = a.occurrenceMs ?? Number.MAX_SAFE_INTEGER;
    const bt = b.occurrenceMs ?? Number.MAX_SAFE_INTEGER;
    const dead = a.state === 'expired' || a.state === 'cancelled';
    return dead ? bt - at : at - bt;
  });
};

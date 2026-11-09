// utils/amsgChatPresence.ts
/**
 * 同角色活跃会话租约（Heartbeat）— 纯常量、类型与解析/新鲜度判定。
 *
 * ⚠️ 叶子模块：会被 worker/amsg 打进 Cloudflare bundle，同时被浏览器侧
 * （amsgStateSync 的租约 timer / activeMsgClient 的 PUT）复用——不得 import
 * DB / React / 任何浏览器环境依赖（与 utils/amsg2ExpireGuard.ts 同一约束）。
 *
 * 语义：一轮真实用户消息进入生成流程时立即写 `amsg:char:<charId>/chat_presence`，
 * 等待角色回复期间每 15s 续租；成功/失败/中断后停止续租，远端值靠 45s TTL 自然失效。
 * 它只代表「正在和这个角色交互」，不是 App 在线状态。worker 对 expire AI 任务开场先检查
 * 新鲜租约，新鲜则推迟；生成完推送前再查一次（chattedDuringFire），聊上了就不发。
 */

export const AMSG_CHAT_PRESENCE_KEY = 'chat_presence';
export const CHAT_PRESENCE_HEARTBEAT_MS = 15_000;
export const CHAT_PRESENCE_TTL_MS = 45_000;

export interface AmsgChatPresence {
  v: 1;
  charId: string;
  /** 最近一次续租的 epoch ms。worker 以自己的 ctx.now 判断 TTL。 */
  activeAt: number;
  /** 最近一条真实用户消息，用于一次性任务的 anchor 规则。 */
  lastUserMessageAt: number | null;
}

export const parseAmsgChatPresence = (raw: string | undefined): AmsgChatPresence | null => {
  try {
    const value = raw ? JSON.parse(raw) : null;
    return value?.v === 1 && typeof value.charId === 'string' &&
      typeof value.activeAt === 'number' &&
      (value.lastUserMessageAt === null || typeof value.lastUserMessageAt === 'number')
      ? value as AmsgChatPresence : null;
  } catch {
    return null;
  }
};

export const isFreshChatPresence = (
  value: AmsgChatPresence | null | undefined,
  charId: string,
  nowMs: number,
): boolean => Boolean(
  value && value.v === 1 && value.charId === charId &&
  value.activeAt <= nowMs + 10_000 && nowMs - value.activeAt <= CHAT_PRESENCE_TTL_MS,
);

/**
 * 定时任务生成完、推送之前：这段时间里用户有没有和这个角色聊上。
 * 开场那道门只在生成前查一次，生成要几十秒，这期间开口的人会同时收到两条各说各的回复。
 *
 * 两条任一成立就算聊上了：租约还新鲜（开场时不新鲜，所以是生成期间才开的），或者最近一条
 * 真实用户消息比开场时看到的更新。后者只比客户端写的两个时间戳，不受设备时钟偏差影响。
 */
export const chattedDuringFire = (
  value: AmsgChatPresence | null | undefined,
  charId: string,
  nowMs: number,
  seenLastUserMessageAt: number | null,
): boolean => {
  if (!value || value.charId !== charId) return false;
  if (isFreshChatPresence(value, charId, nowMs)) return true;
  return value.lastUserMessageAt != null
    && (seenLastUserMessageAt == null || value.lastUserMessageAt > seenLastUserMessageAt);
};

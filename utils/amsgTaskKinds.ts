/**
 * 非聊天任务的通用约定（环境无关叶子模块）
 *
 * 主动消息 2.0 的调度器本来只跑一种任务：到点给用户说句话。现在还要跑一批**不说话**的
 * 后台活儿——整理一份数据、跑一次总结、算一份报告。它们跟聊天任务共用同一套调度
 * （cron 每分钟 + 租约 + 心跳 + 分组串行 + 重试退避 + 时区感知的循环），只是到点之后
 * 做的事不一样。
 *
 * 这份文件定的是「怎么把这两类任务分开」：任务上怎么标种类、一次性输入放在云端哪个
 * 抽屉、以及这些任务在用户的任务清单里怎么不露脸。具体某一种任务长什么样，各自另开
 * 一份契约（第一个是 amsgPlateJob.ts）。
 *
 * 往这里加代码前先确认：不 import 任何带浏览器依赖的模块（db / safeApi / context 等）。
 * `pnpm build:workers` 会把这份打进 amsg worker bundle，带进浏览器依赖会在构建期直接暴露。
 */

// ─── 任务种类 ─────────────────────────────────────────

/**
 * 任务 metadata 上标业务种类的键。
 *
 * 到点触发只有 `onBeforeFire` 一个入口，所有任务都从那儿进；worker 靠这个键把
 * 「后台整理一份数据」和「到点给用户说句话」分开，各走各的 handler
 * （见 worker/amsg/src/fireKinds.ts）。没有这个键的就是聊天任务，照旧走原来那条路
 * ——所有存量任务都落在这一档。
 *
 * 跟 amsgMode / amsgExpirePolicy 这些一样带 amsg 前缀：metadata 是各方共用的口袋，
 * 光叫 kind 太容易跟别人撞名。
 */
export const AMSG_TASK_KIND_KEY = 'amsgKind';

/** 读出任务的业务种类；没标就是 null（= 聊天任务）。 */
export const readTaskKind = (metadata: Record<string, unknown> | null | undefined): string | null => {
  const raw = metadata?.[AMSG_TASK_KIND_KEY];
  return typeof raw === 'string' && raw ? raw : null;
};

/**
 * 后台任务行的 `messageSubtype`。
 *
 * 任务清单跟远端对账时靠它把这些行挡在外面：它们不是用户排的主动消息，进了清单会显示
 * 成「待触发的任务」，还可能被「取消全部」顺手掐掉。跟即时对话那个 subtype 一个道理。
 */
export const AMSG_BACKGROUND_JOB_SUBTYPE = 'job';

/** 即时对话任务行的 `messageSubtype`（客户端 sendInstantChat 排程时写）。 */
export const AMSG_INSTANT_CHAT_SUBTYPE = 'instant-chat';

/** 任务 metadata 里标即时对话的键（客户端排任务时写、worker 到点读）。 */
export const AMSG_INSTANT_CHAT_FLAG = 'amsgInstantChat';

/** 这条任务是不是即时对话（客户端刚发完消息在等回复）。 */
export const isInstantChatTask = (metadata: Record<string, unknown> | undefined | null): boolean =>
  !!metadata && metadata[AMSG_INSTANT_CHAT_FLAG] === true;

// ─── 任务行分类 ───────────────────────────────────────

/**
 * - `instant-chat`：用户正等着的一轮即时对话回复
 * - `background-job`：不说话的后台活儿
 * - `scheduled`：用户在面板排的、角色自己排的定时主动消息
 *
 * 只有 `scheduled` 进任务清单、算进角色的额度，也只有它能被角色和「取消全部」取消。
 */
export type AmsgTaskRowClass = 'instant-chat' | 'background-job' | 'scheduled';

/**
 * 云端一条任务行属于哪一类。所有「这一行算不算定时任务」的判断都走这里。
 *
 * 有 metadata 时以 metadata 为准；没有时只能看 `messageSubtype`——`GET /messages` 的
 * 列表投影不带 metadata，前端拿到的只有它。所以排任务时 subtype 必须显式写：上游
 * `scheduleTask` 没传的字段会继承当前任务的。
 */
export const classifyTaskRow = (row: {
  messageSubtype?: string | null;
  metadata?: Record<string, unknown> | null;
}): AmsgTaskRowClass => {
  const { metadata } = row;
  if (metadata) {
    if (isInstantChatTask(metadata)) return 'instant-chat';
    if (readTaskKind(metadata)) return 'background-job';
    // worker 2026-11-06.3 之前，即时对话里自排的任务继承了 'instant-chat'，靠自排标记认回来。
    if (metadata.amsgSelfScheduled === true) return 'scheduled';
  }
  if (row.messageSubtype === AMSG_INSTANT_CHAT_SUBTYPE) return 'instant-chat';
  if (row.messageSubtype === AMSG_BACKGROUND_JOB_SUBTYPE) return 'background-job';
  return 'scheduled';
};

// ─── 一次性输入的云端抽屉 ─────────────────────────────

/**
 * 后台任务的一次性输入存放的 client_state 命名空间。
 *
 * 跟角色状态（`amsg:char:<id>` 里的 fire_pack / tool_pack）分开放，因为这里的东西是
 * **一次性**的：跑完就没人再回来看，也没人回来删。worker 的 config 给这个命名空间配了
 * `clientStateTtl`，cron 每跳顺手把过期的清掉——角色状态那边是要长期留着的，不能跟它
 * 共用一个命名空间，否则 TTL 会把 fire_pack 一起清了。
 */
export const AMSG_JOB_NAMESPACE = 'amsg:job';

/** 一次性输入在云端留几天。够重试几轮，又不至于攒着白占库。 */
export const AMSG_JOB_TTL_DAYS = 3;

/** 任务 metadata 上放 job 编号的键（handler 靠它去抽屉里取自己那份输入）。 */
export const AMSG_JOB_ID_KEY = 'amsgJobId';

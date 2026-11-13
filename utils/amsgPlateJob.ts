/**
 * 门牌整理上云的契约（环境无关叶子模块）
 *
 * 「整理门牌」这件事拆成三段跑在两个地方：客户端把材料装成一份 job 传上去，用户自己的
 * CF Worker 到点拼提示词、调 LLM、把整理结果送回来，客户端再合并落库。这份文件是两边
 * 共用的那张契约——job 长什么样、结果长什么样、放在云端哪个抽屉里、任务怎么被认出来。
 *
 * 为什么值得上云：整理一次要跑一两分钟，而它总是在一轮对话刚结束、用户正准备切走的时候
 * 开始。放本地的话页面一关就断了；交给云端之后，请求发出去那一刻客户端就自由了。
 *
 * 往这里加代码前先确认：不 import 任何带浏览器依赖的模块（db / safeApi / context 等）。
 * `pnpm build:workers` 会把这份打进 amsg worker bundle，带进浏览器依赖会在构建期直接暴露。
 */

import type { PlateRoom } from './memoryPalace/types';
import { PLATE_ROOMS } from './memoryPalace/types';
import type { PlateLLMItem, PlateMaterial } from './memoryPalace/roomPlateCore';
import { PLATE_USER_TURN, buildPlateConsolidationPrompt } from './memoryPalace/roomPlateCore';

// ─── 这一种任务的名字 ─────────────────────────────────

/** 任务的业务种类（写在 metadata 的 amsgKind 上，见 amsgTaskKinds.ts）。 */
export const PLATE_CONSOLIDATE_KIND = 'plate-consolidate';

/** 结果的名字（`emitResult` 的 resultKind），客户端按它分流。 */
export const PLATE_CONSOLIDATE_RESULT_KIND = 'plate-consolidate';

/** job 输入在 `amsg:job` 命名空间里的 key。 */
export const plateJobKey = (jobId: string): string => `plate:${jobId}`;

// ─── job 输入（客户端写、worker 读） ──────────────────

/** 一个房间的现状：条目正文按标签顺序排，id 与之一一对应。 */
export interface PlateJobRoom {
  room: PlateRoom;
  /** 现有条目的正文，顺序即标签顺序（第 i 条 = 前缀 + i） */
  entries: string[];
  /**
   * 与 entries 一一对应的条目 id。
   *
   * 结果回来时要靠它把 `basedOn` 标签重新对准：提示词是拿提交那一刻的快照拼的，
   * LLM 说的 `U0` 是**快照里的第 0 条**，而结果可能几分钟后才回来，这中间门牌
   * 说不定已经被别的路径动过。带上 id，回来才认得出「当时那条现在排第几」。
   */
  entryIds: string[];
}

export interface PlateJobInput {
  v: 1;
  charId: string;
  /** 客户端读取门牌的绝对时间戳；旧任务没有此字段。随结果返回，不依赖短期在飞记号。 */
  snapshotAt?: number;
  charName: string;
  userName: string;
  /** ContextBuilder.buildCoreContext 的产出；拿不到就是空串，提示词里仍有名字与身份确认段 */
  identityContext: string;
  rooms: PlateJobRoom[];
  materials: PlateMaterial[];
}

/** 组一份 job 输入（版本号只有这一处写，别在调用点手抄）。 */
export function buildPlateJobInput(args: Omit<PlateJobInput, 'v'>): PlateJobInput {
  return { v: 1, ...args };
}

const isPlateRoomValue = (v: unknown): v is PlateRoom => (PLATE_ROOMS as readonly string[]).includes(v as string);

const asStringArray = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;

/** 无效或旧版缺失的时间不参与比较，落地侧继续采用保守保护。 */
const snapshotTimeFields = (value: unknown): { snapshotAt?: number } =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? { snapshotAt: value }
    : {};

/**
 * 读回 job 输入。形状对不上一律返回 null——worker 那边据此硬失败，
 * 而不是拿半份材料整理出一份缺东西的门牌（用户完全看不出这是坏了还是角色就这样）。
 */
export function parsePlateJobInput(raw: unknown): PlateJobInput | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.charId !== 'string' || !o.charId) return null;
  if (typeof o.charName !== 'string' || typeof o.userName !== 'string') return null;
  if (typeof o.identityContext !== 'string') return null;
  if (!Array.isArray(o.rooms) || !Array.isArray(o.materials)) return null;

  const rooms: PlateJobRoom[] = [];
  for (const r of o.rooms) {
    if (!r || typeof r !== 'object') return null;
    const row = r as Record<string, unknown>;
    const entries = asStringArray(row.entries);
    const entryIds = asStringArray(row.entryIds);
    if (!isPlateRoomValue(row.room) || !entries || !entryIds) return null;
    if (entries.length !== entryIds.length) return null;
    rooms.push({ room: row.room, entries, entryIds });
  }

  const materials: PlateMaterial[] = [];
  for (const m of o.materials) {
    if (!m || typeof m !== 'object') return null;
    const row = m as Record<string, unknown>;
    const lines = asStringArray(row.lines);
    if (!isPlateRoomValue(row.room) || !lines) return null;
    materials.push({ room: row.room, lines });
  }

  return {
    v: 1,
    charId: o.charId,
    charName: o.charName,
    userName: o.userName,
    identityContext: o.identityContext,
    rooms,
    materials,
    ...snapshotTimeFields(o.snapshotAt),
  };
}

/** 把 job 拼成这次 fire 要发给 LLM 的两条消息。提示词与浏览器那条路一字不差。 */
export function buildPlateJobMessages(job: PlateJobInput): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: buildPlateConsolidationPrompt({
        charName: job.charName,
        userName: job.userName,
        identityContext: job.identityContext,
        plates: job.rooms.map((r) => ({ room: r.room, entries: r.entries })),
        materials: job.materials,
      }),
    },
    { role: 'user', content: PLATE_USER_TURN },
  ];
}

// ─── 结果（worker 写、客户端读） ──────────────────────

export interface PlateConsolidateUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface PlateConsolidateResult {
  resultKind: typeof PLATE_CONSOLIDATE_RESULT_KIND;
  v: 1;
  jobId: string;
  charId: string;
  /** 原样带回客户端读快照的时刻；旧 Worker 的结果可能缺失。 */
  snapshotAt?: number;
  /** LLM 给出的完整新条目列表（未合并，合并语义留在客户端） */
  items: PlateLLMItem[];
  /**
   * 提交时每个房间的条目 id 快照，原样回传。
   *
   * 客户端拿它把 `basedOn` 标签重新对准当前条目——这份对照表跟着结果走，客户端就
   * 不用为每个在飞的 job 在本地留一份待办（页面关掉再打开也不会丢）。
   */
  rooms: Array<{ room: PlateRoom; entryIds: string[] }>;
  /** 云端执行此次门牌整理时供应商回报的 token 用量；未返回或旧 Worker 时缺失。 */
  usage?: PlateConsolidateUsage;
}

const normalizePlateUsage = (value: unknown): PlateConsolidateUsage | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const u = value as Record<string, unknown>;
  const promptTokens = typeof u.promptTokens === 'number' && Number.isFinite(u.promptTokens)
    ? u.promptTokens : undefined;
  const completionTokens = typeof u.completionTokens === 'number' && Number.isFinite(u.completionTokens)
    ? u.completionTokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
  };
};

/** 组一条结果。形状由宿主定，`resultKind` 是上游唯一的硬要求。 */
export function buildPlateConsolidateResult(args: {
  jobId: string;
  charId: string;
  items: PlateLLMItem[];
  rooms: PlateJobRoom[];
  snapshotAt?: number;
  usage?: PlateConsolidateUsage;
}): PlateConsolidateResult {
  const usage = normalizePlateUsage(args.usage);
  return {
    resultKind: PLATE_CONSOLIDATE_RESULT_KIND,
    v: 1,
    jobId: args.jobId,
    charId: args.charId,
    items: args.items,
    rooms: args.rooms.map((r) => ({ room: r.room, entryIds: r.entryIds })),
    ...snapshotTimeFields(args.snapshotAt),
    ...(usage ? { usage } : {}),
  };
}

/** 读回一条结果；形状对不上返回 null（客户端据此销账丢弃并留日志，不上屏）。 */
export function parsePlateConsolidateResult(raw: unknown): PlateConsolidateResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.resultKind !== PLATE_CONSOLIDATE_RESULT_KIND || o.v !== 1) return null;
  if (typeof o.jobId !== 'string' || typeof o.charId !== 'string' || !o.charId) return null;
  if (!Array.isArray(o.items) || !Array.isArray(o.rooms)) return null;

  const rooms: Array<{ room: PlateRoom; entryIds: string[] }> = [];
  for (const r of o.rooms) {
    if (!r || typeof r !== 'object') return null;
    const row = r as Record<string, unknown>;
    const entryIds = asStringArray(row.entryIds);
    if (!isPlateRoomValue(row.room) || !entryIds) return null;
    rooms.push({ room: row.room, entryIds });
  }

  const items = o.items.filter(
    (i): i is PlateLLMItem => !!i && typeof i === 'object' && typeof (i as PlateLLMItem).text === 'string',
  );
  const usage = normalizePlateUsage(o.usage);

  return {
    resultKind: PLATE_CONSOLIDATE_RESULT_KIND, v: 1, jobId: o.jobId, charId: o.charId, items, rooms,
    ...snapshotTimeFields(o.snapshotAt),
    ...(usage ? { usage } : {}),
  };
}

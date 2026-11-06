/**
 * 云端数据清点与对账。
 *
 * 要解决的是「用户对云端只有全清和不管两档」这件事。云端那台 worker 上按角色堆着三类
 * 东西——定时任务行、client_state 里的角色上下文（完整角色卡加最近 30 条对话原文，
 * 一个角色 32KB 起步）、以及 `char:<角色id>/<用途>` 那几行 API 凭据。本地删掉一个角色、
 * 导入一份别的备份、在另一台设备上清过一轮，云端都可能留下再也没人认领的那一份，
 * 而角色命名空间在 worker 侧没有 TTL、凭据行也从不过期。
 *
 * 这份模块负责「看见」：把云端能问出来的角色线索汇总，跟本地角色清单对一遍，分成
 * 「还在用的」和「孤儿」。动手清是 amsg2CharCleanup 的事，这边只出结论。
 *
 * ── 两条铁律 ──
 *
 * 1. **只列，不自动清。** 孤儿的判据是「本地没有这个角色」，而同一台 worker 可能被
 *    两台设备共用——这台眼里的孤儿正是另一台正在用的角色。清哪一条必须是用户亲手点的。
 * 2. **只在用户点开时拉一次。** 命名空间清单那条要在 worker 上按用户扫一遍 client_state，
 *    塞进体检、塞进定时刷新就是每分钟白扫一遍 D1（之前 rows read 被扫穿就是这么来的）。
 *
 * ── 能问到什么，取决于用户那台 worker 多新 ──
 *
 * 角色身份在云端只在两个地方是明文：client_state 的命名空间（`amsg:char:<角色id>`）和
 * 凭据行的 cred_id。任务表里它埋在密文里，只能把任务全量拉回来逐条解密才看得见。
 * 而「列出所有命名空间」要 worker 更新到 amsg-server 带 `client-state-namespaces` 的
 * 那一版；没有它的时候，只配过 API 或只排过任务的角色照样能被认出来，唯独「只在云端
 * 留了上下文、既没任务也没凭据」的那种看不到——所以清单会如实标明这一点，而不是假装
 * 自己是全集。
 */

import type { CharacterProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { AMSG_STATE_NAMESPACE_PREFIX } from './amsgFirePack';
import { classifyTaskRow } from './amsgTaskKinds';
import { parseCharCredId, type LlmCredentialPurpose } from './amsgLlmCredentials';

/** 云端某个角色名下的占用。 */
export interface CloudCharEntry {
  charId: string;
  /** 本地还认得这个角色吗。null = 孤儿（本地已经没有了）。 */
  local: { name: string; avatar?: string } | null;
  /** 定时任务条数（即时对话那种当场用完的行不算）。 */
  taskCount: number;
  /** 正在进行的即时对话行数，单独数——它不是残留，是用户此刻正等着的一轮回复。 */
  instantCount: number;
  /** 云端登记着的凭据用途。 */
  credPurposes: LlmCredentialPurpose[];
  /** 角色上下文的占用；worker 还给不出命名空间清单时是 null（= 问不到，不是没有）。 */
  state: CloudNamespaceUsage | null;
}

export interface CloudNamespaceUsage {
  entryCount: number;
  /** 存储字节数（值是加密后落库的，比原文大一截）。 */
  byteSize: number;
  updatedAt: number | null;
}

/** 不属于任何角色的那些。 */
export interface CloudGlobalEntry {
  /** 全局工具配置、实时世界缓存所在的命名空间。 */
  namespace: string;
  usage: CloudNamespaceUsage;
}

export interface CloudInventory {
  /** 本地还在的角色，按占用从大到小。 */
  live: CloudCharEntry[];
  /** 本地已经没有的角色。 */
  orphans: CloudCharEntry[];
  /** 全局命名空间（工具配置 / 实时世界缓存 / 后台活儿的一次性输入）。 */
  globals: CloudGlobalEntry[];
  /** 哪几条线索没问到，界面照它说明「这份清单看得见什么、看不见什么」。 */
  gaps: CloudInventoryGap[];
}

export type CloudInventoryGap =
  /** 任务清单读不出来（多半是换过主密钥，旧密文解不开）。 */
  | { kind: 'tasks'; message: string }
  /** 凭据清单读不出来（老 worker 上没有这张表）。 */
  | { kind: 'credentials'; message: string }
  /**
   * worker 给不出命名空间清单。这条最要紧：没有它，「只在云端留了上下文、既没任务
   * 也没凭据」的角色根本不会出现在清单里，用户看到的不是全集。
   */
  | { kind: 'namespaces'; message: string };

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 把云端问出来的线索汇总成一份清单。
 *
 * 三条线索各问各的，一条断了不拖累另外两条——换过主密钥之后任务清单必然最先炸，而那
 * 正是最需要看见云端还剩什么的时候。
 */
export const collectCloudInventory = async (
  localChars: CharacterProfile[],
): Promise<CloudInventory> => {
  const { listUserSpaces } = await import('./userSpaces');
  if (listUserSpaces().length > 1) localChars = await (await import('./userSpaceCloudSettings')).allSpaceCharacters();
  const byId = new Map<string, CloudCharEntry>();
  const gaps: CloudInventoryGap[] = [];

  const entryFor = (charId: string): CloudCharEntry => {
    let entry = byId.get(charId);
    if (!entry) {
      entry = { charId, local: null, taskCount: 0, instantCount: 0, credPurposes: [], state: null };
      byId.set(charId, entry);
    }
    return entry;
  };

  // ① 任务表：角色 id 是解密之后投影出来的，老 worker 不给这个字段。
  try {
    const tasks = await ActiveMsgClient.listAllTasks();
    for (const task of tasks) {
      const charId = typeof task?.charId === 'string' ? task.charId : '';
      if (!charId) continue;
      const entry = entryFor(charId);
      if (classifyTaskRow(task) === 'instant-chat') entry.instantCount += 1;
      else entry.taskCount += 1;
    }
  } catch (error) {
    gaps.push({ kind: 'tasks', message: describeError(error) });
  }

  // ② 凭据清单：credId 里编着角色 id，只配过 API、没排过任务的角色只能从这儿认出来。
  try {
    for (const { credId } of await ActiveMsgClient.listLlmCredentials()) {
      const parsed = parseCharCredId(credId);
      if (!parsed) continue;
      const entry = entryFor(parsed.charId);
      if (!entry.credPurposes.includes(parsed.purpose)) entry.credPurposes.push(parsed.purpose);
    }
  } catch (error) {
    gaps.push({ kind: 'credentials', message: describeError(error) });
  }

  // ③ 命名空间清单：唯一能发现「只留了上下文」那种角色的线索，要新 worker 才有。
  const globals: CloudGlobalEntry[] = [];
  try {
    const namespaces = await ActiveMsgClient.listCloudNamespaces();
    for (const row of namespaces) {
      const charId = parseCharNamespace(row.namespace);
      if (charId) {
        entryFor(charId).state = { entryCount: row.entryCount, byteSize: row.byteSize, updatedAt: row.updatedAt };
      } else {
        globals.push({ namespace: row.namespace, usage: row });
      }
    }
  } catch (error) {
    gaps.push({ kind: 'namespaces', message: describeError(error) });
  }

  const localById = new Map(localChars.map((char) => [char.id, char]));
  for (const entry of byId.values()) {
    const char = localById.get(entry.charId);
    if (char) entry.local = { name: char.name, avatar: char.avatar };
  }

  const all = [...byId.values()].sort(compareByWeight);
  return {
    live: all.filter((entry) => entry.local),
    orphans: all.filter((entry) => !entry.local),
    globals: globals.sort((a, b) => b.usage.byteSize - a.usage.byteSize),
    gaps,
  };
};

/** 占用大的排前面；问不到大小时退回按任务数，再退回按角色 id 排，保证顺序稳定。 */
const compareByWeight = (a: CloudCharEntry, b: CloudCharEntry): number => {
  const size = (b.state?.byteSize ?? 0) - (a.state?.byteSize ?? 0);
  if (size !== 0) return size;
  const tasks = b.taskCount - a.taskCount;
  if (tasks !== 0) return tasks;
  return a.charId.localeCompare(b.charId);
};

/** `amsg:char:<角色id>` → 角色 id；不是角色命名空间就回 null。 */
export const parseCharNamespace = (namespace: string): string | null => {
  if (!namespace?.startsWith(AMSG_STATE_NAMESPACE_PREFIX)) return null;
  return namespace.slice(AMSG_STATE_NAMESPACE_PREFIX.length) || null;
};

/** 这一条在云端到底占了多少东西——界面拿它决定「空的」还是「有货」。 */
export const isEmptyEntry = (entry: CloudCharEntry): boolean =>
  entry.taskCount === 0
  && entry.instantCount === 0
  && entry.credPurposes.length === 0
  && (entry.state?.entryCount ?? 0) === 0;

/** 把字节数说成人话。云端存的是密文，所以这个数比聊天原文大一截。 */
export const formatCloudSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

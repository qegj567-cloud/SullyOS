import {
  ActiveMsg2GlobalConfig,
  ActiveMsg2InboxMessage,
  Amsg2ExpiredNoticeRecord,
} from '../types';

const DB_NAME = 'ActiveMsg';
// MUST be kept in sync with worker/sw-keep-alive.ts:ACTIVE_MSG_DB_VERSION.
// IMPORTANT: once a client opens v2, downgrade to a v1 codebase will fail to open this DB.
const DB_VERSION = 2;
const STORE_KV = 'kv';
const STORE_INBOX = 'inbox';
// 下面三张表现在没人读写，只在 clearLegacyInstantPushStores 里清空一次旧数据。
// 建表逻辑留着是为了不动库版本：删表就得升 DB_VERSION，页面和 SW 必须同步升级，
// 否则老的一方打开库直接 VersionError、推送静默丢失。
const STORE_OUTBOUND_SESSIONS = 'outbound_sessions';
const STORE_PENDING_TOOL_CALLS = 'pending_tool_calls';
const STORE_REASONING_BUFFER = 'reasoning_buffer';
const GLOBAL_CONFIG_KEY = 'global-config';
/** 删库被别的连接挡住时最多等多久（见 deleteDB 的注释）。 */
const DELETE_DB_BLOCKED_TIMEOUT_MS = 3000;

const EXPIRED_NOTICES_PREFIX = 'amsg2_expired_notices_';
const EXPIRED_NOTICES_MAX = 10;
const EXPIRED_NOTICES_TTL_MS = 48 * 3600_000;

type KvRecord<T = unknown> = {
  id: string;
  value: T;
};

// Keep the shared web/PWA build unchanged. The private Capacitor build may
// provide its own Worker URL so the native shell works without manual setup.
const capacitorDefaultWorkerUrl = import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true'
  ? String(import.meta.env.VITE_AMSG_DEFAULT_WORKER_URL || '').trim()
  : '';

const defaultGlobalConfig: ActiveMsg2GlobalConfig = {
  userId: '',
  workerUrl: capacitorDefaultWorkerUrl,
};

// 单例连接缓存。同 utils/db.ts 的根因: 原本每个 op 都新开一条 ActiveMsg 连接且从不
// close, 跟主库一起在并发下撑爆 Chromium backing store, 连带 SW 写 inbox 也失败。
// 复用同一条连接, 并在连接被外部失效 (版本升级 / 浏览器强制关闭) 时清缓存自愈。
let dbPromise: Promise<IDBDatabase> | null = null;

const openDB = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // onblocked 不是终态: 先 reject, 但底层 open request 还活着, 占用方关闭后仍会触发
    // onsuccess。用 settled 标记 promise 已 settle, 让迟到的连接被 close 而非泄漏成
    // 一条没人持有、却能 block 后续升级 / 删库的孤儿连接。
    // 清缓存一律先比对 dbPromise === promise: onclose/onerror 等都是异步回调, 若期间已
    // 重开并缓存了新 promise (如 SW withInboxTx 强关后重试), 陈旧连接的回调不能把新单例
    // 误清, 否则又凭空多开一条连接 (见 amsg-sw 2.3.0 同款守卫)。
    let settled = false;

    request.onerror = () => {
      if (dbPromise === promise) dbPromise = null; // 打开失败别缓存 rejected promise
      settled = true;
      reject(request.error);
    };
    request.onblocked = () => {
      // SW or another tab holds an older version; can't upgrade. Reject so callers don't hang.
      if (dbPromise === promise) dbPromise = null;
      settled = true;
      reject(new Error('IndexedDB open blocked — close other tabs / unregister SW and retry'));
    };
    request.onsuccess = () => {
      const db = request.result;
      // 已经 reject 过 (onblocked / onerror): 迟到的连接没人接收, 直接 close, 否则它开着
      // 会 block 后续升级 / deleteDatabase。
      if (settled) {
        try { db.close(); } catch { /* ignore */ }
        return;
      }
      // 另一个 tab / SW 升级版本时主动 close 让位 + 清缓存; 强制关闭时也清缓存自愈。
      db.onversionchange = () => {
        db.close();
        if (dbPromise === promise) dbPromise = null;
      };
      db.onclose = () => {
        if (dbPromise === promise) dbPromise = null;
      };
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORE_INBOX)) {
        db.createObjectStore(STORE_INBOX, { keyPath: 'messageId' });
      }

      // v2 的三张闲置表（见常量处注释），建出来只为跟 SW 那边的 schema 保持一致。
      if (!db.objectStoreNames.contains(STORE_OUTBOUND_SESSIONS)) {
        db.createObjectStore(STORE_OUTBOUND_SESSIONS, { keyPath: 'sessionId' });
      }

      if (!db.objectStoreNames.contains(STORE_PENDING_TOOL_CALLS)) {
        db.createObjectStore(STORE_PENDING_TOOL_CALLS, { keyPath: 'sessionId' });
      }

      if (!db.objectStoreNames.contains(STORE_REASONING_BUFFER)) {
        db.createObjectStore(STORE_REASONING_BUFFER, { keyPath: 'sessionId' });
      }
    };
  });

  dbPromise = promise;
  return promise;
};

const getKv = async <T>(id: string): Promise<T | null> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KV, 'readonly');
    const request = tx.objectStore(STORE_KV).get(id);
    request.onsuccess = () => resolve((request.result as KvRecord<T> | undefined)?.value ?? null);
    request.onerror = () => reject(request.error);
  });
};

const setKv = async <T>(id: string, value: T): Promise<void> => {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_KV, 'readwrite');
    tx.objectStore(STORE_KV).put({ id, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// XHS 笔记缓冲: push 冲刷时把 worker 捎回的笔记写进来, [[XHS_SHARE]]/评论/点赞 重放时读.
// 存在 KV 是因为内存单例 (pushLastXhsNotesRef) 跨 SW 唤醒 / 页面回收会清空 —— 移动端
// 收到 push 和冲刷之间常隔一次后台重载, 笔记一丢 XHS_SHARE 就静默掉卡片.
const XHS_SESSION_NOTES_PREFIX = 'xhs_session_notes:';
const XHS_SESSION_NOTES_TTL_MS = 3 * 60 * 60 * 1000;

export type XhsSessionNotes = {
  notes: unknown[];
  xsecTokens: Array<[string, string]>;
  savedAt: number;
};

// 写入时顺手清理过期条目, 防 KV 无界增长.
const pruneStaleXhsSessionNotes = async (): Promise<void> => {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_KV, 'readwrite');
      const store = tx.objectStore(STORE_KV);
      const cutoff = Date.now() - XHS_SESSION_NOTES_TTL_MS;
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const rec = cursor.value as KvRecord<{ savedAt?: number }> | undefined;
        if (rec && typeof rec.id === 'string' && rec.id.startsWith(XHS_SESSION_NOTES_PREFIX)) {
          const savedAt = Number(rec.value?.savedAt ?? 0);
          if (savedAt < cutoff) cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* prune 尽力而为, 失败不影响主流程 */ }
};

const generateUuidV4 = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

export const ActiveMsgStore = {
  /** 纯动作可以没有聊天产物，需单独保留完成回执，防止补收/ACK 重试重放动作。 */
  async hasAppliedActionResult(charId: string, messageId: string): Promise<boolean> {
    return await getKv<boolean>(`action_result_applied:${JSON.stringify([charId, messageId])}`) === true;
  },

  async markActionResultApplied(charId: string, messageId: string): Promise<void> {
    await setKv(`action_result_applied:${JSON.stringify([charId, messageId])}`, true);
  },

  /**
   * 删掉整个 ActiveMsg 库。只给「重置全部数据」用。
   *
   * 2.0 的连接信息（worker 地址、共享密钥、主密钥、用户 id）住在这个库里，跟角色、
   * 聊天记录那个主库（AetherOS_Data）是分开的两个库。重置只删主库的话，角色全没了
   * 而连接信息还在，云端那批任务照样到点跑、照样烧 API 额度、照样往这台设备推消息，
   * 本地却已经没有任何记录知道它们存在。
   *
   * Service Worker 也开着这个库（见 worker/sw-keep-alive.ts），它那条连接不归页面管，
   * 所以 deleteDatabase 可能一直 blocked。超时后照常往下走，不把重置卡在这里：重置的
   * 下一步就是刷新页面，页面一刷新连接就断，库会在那之后被删掉。
   */
  async deleteDB(): Promise<void> {
    if (dbPromise) {
      try { (await dbPromise).close(); } catch { /* ignore */ }
      dbPromise = null;
    }
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      const finish = () => resolve();
      // blocked 不是终态：占用方关闭后仍会触发 onsuccess。超时兜底只是不再等它。
      const timer = setTimeout(finish, DELETE_DB_BLOCKED_TIMEOUT_MS);
      const settle = () => { clearTimeout(timer); finish(); };
      request.onsuccess = settle;
      request.onerror = () => {
        console.warn('[ActiveMsgStore] 删库失败', request.error);
        settle();
      };
      request.onblocked = () => {
        console.warn('[ActiveMsgStore] 删库被占用方挡住，等页面刷新后自行完成');
      };
    });
  },

  async getGlobalConfig(): Promise<ActiveMsg2GlobalConfig> {
    const stored = await getKv<ActiveMsg2GlobalConfig>(GLOBAL_CONFIG_KEY);
    const config = { ...defaultGlobalConfig, ...(stored || {}) };
    // Older App installs may already have persisted an empty URL. Fill only
    // that empty value in the private build; an explicit non-empty URL wins.
    if (!config.workerUrl?.trim() && capacitorDefaultWorkerUrl) {
      config.workerUrl = capacitorDefaultWorkerUrl;
    }
    return config;
  },

  async saveGlobalConfig(updates: Partial<ActiveMsg2GlobalConfig>): Promise<ActiveMsg2GlobalConfig> {
    const current = await this.getGlobalConfig();
    const next: ActiveMsg2GlobalConfig = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };
    await setKv(GLOBAL_CONFIG_KEY, next);
    return next;
  },

  async ensureUserId(): Promise<string> {
    const current = await this.getGlobalConfig();
    if (current.userId) return current.userId;

    const userId = generateUuidV4();
    await this.saveGlobalConfig({ userId });
    return userId;
  },

  async saveInboxMessage(message: ActiveMsg2InboxMessage): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readwrite');
      tx.objectStore(STORE_INBOX).put(message);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * 收件箱里现在有几条。**只数个数，不读内容**——给前台那趟定期巡查用。
   *
   * 巡查每几秒就要跑一次，不能每回都把整表读出来再原样丢掉。count() 不反序列化任何
   * 记录，空表时几乎不花时间；数出来是 0 就到此为止，有货才去走完整的冲刷。
   */
  async countInboxMessages(): Promise<number> {
    const db = await openDB();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readonly');
      const request = tx.objectStore(STORE_INBOX).count();
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => reject(request.error);
    });
  },

  async listInboxMessages(): Promise<ActiveMsg2InboxMessage[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readonly');
      const request = tx.objectStore(STORE_INBOX).getAll();
      request.onsuccess = () => {
        const messages = (request.result || []) as ActiveMsg2InboxMessage[];
        messages.sort((a, b) => (a.sentAt || a.receivedAt) - (b.sentAt || b.receivedAt));
        resolve(messages);
      };
      request.onerror = () => reject(request.error);
    });
  },

  // 单事务原子 claim: getAll + delete 同一个 readwrite tx。IndexedDB 跨连接
  // (跨 tab / 跨 SW / 同 tab 多 caller) 对同一 object store 的 readwrite 事务
  // 是 serializable 的, 第二个 caller 会等第一个 commit 后才进入, 所以同一条
  // inbox 消息绝不可能被两个 caller 同时 claim。这是把 race 关在 IDB 层。
  //
  // 认领后由 runtime 负责处理失败时压回重试；不要拆开事务重新引入重复消费。
  // 指定角色时也在同一事务里筛选、删除，其余角色留在 inbox。
  // 按角色也是整表读出再筛：inbox 没有 charId 索引，这个库的版本号和建表由页面与
  // Service Worker 两边共同维护。调用方先 countInboxMessages，空表不会走到这里。
  // leave 返回 true 的消息留在 inbox 不认领。
  async consumeInboxMessages(
    charId?: string,
    leave?: (message: ActiveMsg2InboxMessage) => boolean,
  ): Promise<ActiveMsg2InboxMessage[]> {
    const db = await openDB();
    return new Promise<ActiveMsg2InboxMessage[]>((resolve, reject) => {
      const tx = db.transaction(STORE_INBOX, 'readwrite');
      const store = tx.objectStore(STORE_INBOX);
      const request = store.getAll();
      let messages: ActiveMsg2InboxMessage[] = [];
      request.onsuccess = () => {
        messages = ((request.result || []) as ActiveMsg2InboxMessage[])
          .filter(message => (charId === undefined || message.charId === charId) && !leave?.(message));
        // 一个 user turn 可能产 N 条 push (multi-chunk pushPayloads). FCM 投递不严格
        // 保序, 必须按 (sessionId, messageIndex) 排序才能拿到正确气泡顺序. 没 sessionId
        // 的走 sentAt fallback.
        messages.sort((a, b) => {
          const aSess = a.metadata?.sessionId as string | undefined;
          const bSess = b.metadata?.sessionId as string | undefined;
          if (aSess && aSess === bSess) {
            const aIdx = Number(a.metadata?.messageIndex ?? 0);
            const bIdx = Number(b.metadata?.messageIndex ?? 0);
            return aIdx - bIdx;
          }
          return (a.sentAt || a.receivedAt) - (b.sentAt || b.receivedAt);
        });
        messages.forEach((m) => store.delete(m.messageId));
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(messages);
      tx.onabort = () => reject(tx.error || new Error('inbox consume aborted'));
      tx.onerror = () => reject(tx.error);
    });
  },

  /**
   * 清空 v2 的三张闲置表（outbound_sessions / pending_tool_calls / reasoning_buffer）。
   * outbound_sessions 里存过 API key 副本和整段消息快照，从来没被清过；只给
   * instantPushLegacyCleanup 调，一个事务清完。
   */
  async clearLegacyInstantPushStores(): Promise<void> {
    const db = await openDB();
    const stores = [STORE_OUTBOUND_SESSIONS, STORE_PENDING_TOOL_CALLS, STORE_REASONING_BUFFER]
      .filter((name) => db.objectStoreNames.contains(name));
    if (stores.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      for (const name of stores) tx.objectStore(name).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('legacy store clear aborted'));
    });
  },

  // ─── XHS 笔记缓冲 (持久化) ─────────────────────────────────────────────────
  async saveXhsSessionNotes(
    sessionId: string,
    payload: { notes: unknown[]; xsecTokens: Array<[string, string]> },
  ): Promise<void> {
    if (!sessionId) return;
    await setKv<XhsSessionNotes>(`${XHS_SESSION_NOTES_PREFIX}${sessionId}`, {
      notes: payload.notes,
      xsecTokens: payload.xsecTokens,
      savedAt: Date.now(),
    });
    await pruneStaleXhsSessionNotes();
  },

  async getXhsSessionNotes(sessionId: string): Promise<XhsSessionNotes | null> {
    if (!sessionId) return null;
    return getKv<XhsSessionNotes>(`${XHS_SESSION_NOTES_PREFIX}${sessionId}`);
  },

  // ─── 回执台账（到点没发 / 用户手动取消）───

  async getExpiredNotices(charId: string): Promise<Amsg2ExpiredNoticeRecord[]> {
    const list = await getKv<Amsg2ExpiredNoticeRecord[]>(`${EXPIRED_NOTICES_PREFIX}${charId}`);
    return Array.isArray(list) ? list : [];
  },

  /** 合并新候选（按 id 去重），顺手清 48h 前的老记录，封顶 10 条防无界增长。 */
  async upsertExpiredNotices(charId: string, records: Amsg2ExpiredNoticeRecord[]): Promise<Amsg2ExpiredNoticeRecord[]> {
    const byId = new Map((await this.getExpiredNotices(charId)).map((r) => [r.id, r]));
    for (const record of records) {
      if (!byId.has(record.id)) byId.set(record.id, record);
    }
    const cutoff = Date.now() - EXPIRED_NOTICES_TTL_MS;
    const alive = [...byId.values()]
      .filter((r) => r.createdAt >= cutoff)
      .sort((a, b) => b.occurrenceMs - a.occurrenceMs);
    // 超限时先淘汰已告知的（Codex #11）——「作废 ≠ 消失」是设计底线，未告知回执
    // 不允许被静默截断；真溢出（病态场景）保最新未告知并 warn 留痕。
    let next = alive;
    if (alive.length > EXPIRED_NOTICES_MAX) {
      const unnotified = alive.filter((r) => !r.notifiedAt);
      const notified = alive.filter((r) => r.notifiedAt);
      next = [...unnotified, ...notified].slice(0, EXPIRED_NOTICES_MAX);
      if (unnotified.length > EXPIRED_NOTICES_MAX) {
        console.warn('[ActiveMsgStore] 未告知回执超上限，最旧的被截断', { charId, dropped: unnotified.length - EXPIRED_NOTICES_MAX });
      }
    }
    await setKv(`${EXPIRED_NOTICES_PREFIX}${charId}`, next);
    return next;
  },

  async markExpiredNoticesNotified(charId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const idSet = new Set(ids);
    const next = (await this.getExpiredNotices(charId)).map((r) =>
      idSet.has(r.id) ? { ...r, notifiedAt: r.notifiedAt ?? Date.now() } : r);
    await setKv(`${EXPIRED_NOTICES_PREFIX}${charId}`, next);
  },
};

/**
 * 后端连接那几样：连上用户自己那台 Worker 需要的全部东西。
 *
 * 它们合起来就是那台 Worker 的钥匙——地址加主密钥能解开 D1 里所有密文，用户 id 决定
 * 读得到哪一份数据（数据按它分区），共享密钥是端点的门禁。少一样都连不成，所以要摘
 * 就得一起摘。
 */
const BACKEND_CONNECTION_KEYS = ['workerUrl', 'serverToken', 'masterKey', 'userId'] as const;

/** 这份备份里带着后端连接吗（带了的话，谁拿到这个文件谁就能连上那台 Worker）。 */
export const backupHasBackendConnection = (
  config: ActiveMsg2GlobalConfig | null | undefined,
): boolean => !!config?.workerUrl?.trim();

/**
 * 备份用：把主动消息 2.0 的全局配置取出来（即时对话开关等）。
 *
 * 这份配置存在自己的 `ActiveMsg` 库里，不在主库那份 store 清单内，所以必须单独取一次
 * 挂进备份包。
 *
 * **后端连接默认不带走。** 备份文件是会被分享出去的——发一份角色合集给朋友，就等于把
 * 自己那台 Worker 的钥匙一起发了：对方的 App 会静默连上去，把 ta 的 API 凭据和聊天上
 * 下文写进你的 D1，而 ta 手里的主密钥能解开你那台机器上的所有密文。换设备恢复自己的
 * 备份才需要这几样，那是用户明确知道的场景，让 ta 自己勾。
 *
 * 程序分不清「自己的备份」和「别人的备份」：文件里没有可信的身份标记，换新设备时用户
 * id 本来就跟备份里的对不上——而那恰恰是最正当的自己人。能判断的只有拿着文件的人，
 * 所以这里的选择权交给导出的那一下，而不是留给导入时去猜。
 */
export async function exportAmsg2GlobalConfig(
  options: { includeBackendConnection?: boolean } = {},
): Promise<ActiveMsg2GlobalConfig | undefined> {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    if (!config.workerUrl?.trim()) return undefined;
    if (options.includeBackendConnection) return config;
    const stripped = { ...config };
    for (const key of BACKEND_CONNECTION_KEYS) delete stripped[key];
    // 摘完只剩几个开关。全是默认值的话备份里干脆别出现这个键，免得导入侧为一份空配置
    // 白跑一段、还在日志里留一条「主动消息配置」的假账。
    return Object.keys(stripped).length > 0 ? stripped : undefined;
  } catch (e) {
    console.warn('[amsg2] 读取全局配置失败，备份将不含这一项', e);
    return undefined;
  }
}

/**
 * 备份用：把上面那份配置写回去。
 *
 * `instantChatSupported` / `workerBundleVersion` 不还原——它们记的是「上次探到那台 Worker
 * 跑不跑得动即时对话、贴的是哪一版」，是探测的结果而不是用户的选择。备份里那个值可能
 * 已经过时（Worker 后来更新过 / 退回过），照抄回来要么白挡一次、要么在跑不动的 Worker 上放行。留空表示「还没探过」，
 * 握手时会补探一次，之后就有准数了。
 *
 * **后端连接要调用方点头才还原**（`allowBackendConnection`）。老备份里带着这几样，而
 * 导入者未必知道这份文件是谁的：默认连上去的话，ta 的 API 凭据和聊天上下文会写进别人
 * 那台 D1，自己却毫不知情。不点头就只还原那几个开关，本地其它数据照常导入。
 */
export async function importAmsg2GlobalConfig(
  config: ActiveMsg2GlobalConfig | null | undefined,
  options: { allowBackendConnection?: boolean } = {},
): Promise<void> {
  if (!config || typeof config !== 'object') return;
  const { instantChatSupported: _dropped, workerBundleVersion: _droppedVersion, ...restorable } = config;
  if (!options.allowBackendConnection) {
    for (const key of BACKEND_CONNECTION_KEYS) delete restorable[key];
  }
  if (Object.keys(restorable).length === 0) return;
  await ActiveMsgStore.saveGlobalConfig({ ...restorable, instantChatSupported: undefined, workerBundleVersion: undefined });
}

export const maskActiveMsgUserId = (userId: string) => {
  if (!userId) return '未生成';
  if (userId.length <= 12) return userId;
  return `${userId.slice(0, 8)}••••${userId.slice(-8)}`;
};

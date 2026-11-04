/**
 * 「到点时用户正在聊天」的全链路模拟。
 *
 * 跑的是真东西：这份 worker 的入口（fetch / scheduled / InstantTickDO）、上游的调度与
 * 租约、真 SQLite 上的任务表、真加密的 client_state 与 Web Push。假的只有三样：
 *   - 时钟（vitest 的假定时器，按场景一步步拨）；
 *   - 模型（按场景回一句话，或者回「不发」标记）；
 *   - 客户端（照着页面真实会做的事手动重演：发消息、写在场记录、传 fire_pack）。
 *
 * 每个场景既是断言（结局钉死），也是一条时间线：设了环境变量 AMSG_SIM_OUT 时把时间线
 * 写成 JSON，给人看的可视化页面读的就是它。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import nodeCrypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

vi.mock('../../../utils/activeMsgStore', () => ({ ActiveMsgStore: {} }));

import { ReiClient } from '@rei-standard/amsg-client';
import { createD1Adapter } from '@rei-standard/amsg-server/cloudflare';
import worker, { InstantTickDO } from './index';
import { installAnthropicFetch } from '../../../utils/anthropicApi';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_SILENT_MARK,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_SELF_LOG,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG_SLOT_TASK_LIST,
  AMSG_SLOT_TIME_SINCE_USER,
  BEFORE_SPEAK_LINES,
  FIRE_PACK_VERSION,
  amsgStateNamespace,
  describeLastSkip,
  parseLastSkip,
  AMSG_LAST_SKIP_KEY,
} from '../../../utils/amsgFirePack';
import { AMSG_CHAT_PRESENCE_KEY } from '../../../utils/amsgChatPresence';
import { AMSG_GLOBAL_NAMESPACE, AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from '../../../utils/amsgToolPack';
import { AMSG_LIMITS_KEY } from '../../../utils/amsgLimits';
import { parseFireSkipResult } from '../../../utils/amsgFireSkipResult';
import { buildAmsg2NoticesText } from '../../../utils/amsg2TaskContext';

/** 真的让出一次事件循环（假定时器接管之后 setImmediate 也是假的，先留一个真的）。 */
const realImmediate = setImmediate;
const breathe = () => new Promise<void>((resolve) => { realImmediate(resolve); });

type SqliteModule = { DatabaseSync: new (path: string) => any };
const require_ = createRequire(import.meta.url);
const sqlite: SqliteModule | null = (() => {
  try { return require_('node:sqlite'); } catch { return null; }
})();

// ─── 时间：全程用上海时间说话 ───

const DAY = '2026-10-03';
const at = (clock: string) => Date.parse(`${DAY}T${clock}+08:00`);
const hhmmss = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 19);

// ─── 时间线 ───

type Lane = 'user' | 'page' | 'reply' | 'cron' | 'fire' | 'phone';
interface SimEvent { t: number; lane: Lane; kind: string; label: string; detail?: string }
interface SimSpan { lane: Lane; from: number; to: number; label: string; kind: string }
interface SimScenario {
  id: string;
  group: string;
  title: string;
  setup: string;
  due: number;
  events: SimEvent[];
  spans: SimSpan[];
  outcome: { verdict: 'sent' | 'silent' | 'skipped'; sentAt?: number; delayMs?: number; text?: string; summary: string };
  modelSaw?: { liveLine: string | null; replyBlock: string | null; sinceUser: string | null; lastTurn: string | null };
  receipt?: string | null;
  panel?: string | null;
  cost: { scheduledLlmCalls: number; cronTicks: number };
  note?: string;
}
const scenarios: SimScenario[] = [];

// ─── 外围：D1、推送解密、fetch 路由 ───

const createD1 = () => {
  const db = new sqlite!.DatabaseSync(':memory:');
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values.map((v) => (v === undefined ? null : v))),
    first: async () => {
      const row = db.prepare(sql).get(...params);
      return row ? { ...row } : null;
    },
    all: async () => ({ results: db.prepare(sql).all(...params).map((row: object) => ({ ...row })), success: true, meta: {} }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { run(): Promise<unknown> }[]) => {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
    raw: db,
  };
};

const b64u = (buf: Buffer) => buf.toString('base64url');
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, len: number) =>
  Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, info, len));

const CHAR_ID = 'char-sim';
const CHAR_NAME = '小满';
const USER_NAME = '小明';
const SERVER_TOKEN = 'sim-shared-secret';
const BASE = 'https://amsg.test';
const TASK_HINT = '八点了，叫对方起床去赶早班车';

interface LlmCall { kind: 'scheduled' | 'instant'; at: number; prompt: string }

const createWorld = async (startClock: string, native = false) => {
  vi.useFakeTimers();
  vi.setSystemTime(at(startClock));

  // 真 WebCrypto 在线程池里完成，不能把主机忙时的等待误算成几十秒的模拟时间。
  // 保留真实加解密，但拨钟前先排空它；业务定时器仍由场景逐步推进。
  const cryptoJobs = new Set<Promise<unknown>>();
  const subtle = globalThis.crypto.subtle;
  for (const method of [
    'encrypt', 'decrypt', 'deriveKey', 'deriveBits', 'importKey', 'exportKey',
    'generateKey', 'digest', 'sign', 'verify', 'wrapKey', 'unwrapKey',
  ] as const) {
    const original = subtle[method];
    vi.spyOn(subtle, method).mockImplementation(((...args: unknown[]) => {
      const job = Reflect.apply(original, subtle, args) as Promise<unknown>;
      cryptoJobs.add(job);
      void job.then(() => cryptoJobs.delete(job), () => cryptoJobs.delete(job));
      return job;
    }) as any);
  }
  const flushCrypto = async () => {
    await breathe();
    while (cryptoJobs.size) {
      await Promise.allSettled([...cryptoJobs]);
      await breathe();
    }
  };

  const events: SimEvent[] = [];
  const spans: SimSpan[] = [];
  const ev = (lane: Lane, kind: string, label: string, detail?: string) => {
    events.push({ t: Date.now(), lane, kind, label, ...(detail ? { detail } : {}) });
  };

  const webpush = require_('web-push');
  const vapid = webpush.generateVAPIDKeys();
  const d1 = createD1();
  await createD1Adapter(d1 as any).initSchema();

  // 浏览器侧订阅密钥：推送是真加密的，这里现场解开看正文。
  const receiver = nodeCrypto.createECDH('prime256v1');
  receiver.generateKeys();
  const authSecret = nodeCrypto.randomBytes(16);
  const decryptPush = (body: Buffer) => {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const senderPub = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const shared = receiver.computeSecret(senderPub);
    const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPub]), 32);
    const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
    const dec = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
    dec.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end -= 1;
    return JSON.parse(plain.subarray(0, end).toString('utf8'));
  };

  const kicked: string[] = [];
  const env: Record<string, unknown> = {
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:sim@example.com',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    AMSG_SERVER_TOKEN: SERVER_TOKEN,
    DB: d1,
    INSTANT_TICK: {
      idFromName: (name: string) => name,
      get: () => ({ kick: async (uuid: string) => { kicked.push(uuid); } }),
    },
  };
  const waitUntil: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waitUntil.push(p.catch(() => {})); } };

  // 模型：场景把「这一次回什么」排进队列，按即时回复 / 定时消息两条队各取各的。
  const llmCalls: LlmCall[] = [];
  type Reply = string | Promise<string> | (() => Promise<string>);
  const replies = { scheduled: [] as Reply[], instant: [] as Reply[] };
  const pushes: Array<{ at: number; payload: any }> = [];

  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith(BASE)) {
      return (worker as any).fetch(new Request(url, init), env, ctx);
    }
    if (url.startsWith('https://push.test/')) {
      pushes.push({ at: Date.now(), payload: decryptPush(Buffer.from(init.body)) });
      return new Response(null, { status: 201 });
    }
    if (url.startsWith('https://llm.test/')) {
      const req = JSON.parse(init.body);
      const prompt = [...(req.system || []), ...req.messages].map((m: any) => m.text || (typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text || '').join('\n'))).join('\n');
      const kind: LlmCall['kind'] = prompt.includes('【本次任务】') ? 'scheduled' : 'instant';
      llmCalls.push({ kind, at: Date.now(), prompt });
      const next = replies[kind].shift() ?? '（场景没给这一次的回复）';
      const content = await (typeof next === 'function' ? next() : next);
      if (native) {
        expect(url).toBe('https://llm.test/v1/messages');
        expect(new Headers(init.headers).get('x-api-key')).toBe('sk-sim');
        expect(new Headers(init.headers).has('anthropic-dangerous-direct-browser-access')).toBe(false);
        expect(req.messages.some((m: any) => m.content.some((b: any) => b.cache_control?.type === 'ephemeral'))).toBe(true);
        return Response.json({type:'message',id:'native-sim',model:'sim-model',role:'assistant',content:[{type:'text',text:content}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:1024}});
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(input, init);
  });

  if (native) installAnthropicFetch(false);

  // worker 的日志就是排障时看的那几行，顺手收下来判这一跳发生了什么。
  const logs: Array<{ at: number; tag: string; data: any }> = [];
  const capture = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[amsg:')) {
      logs.push({ at: Date.now(), tag: args[0], data: args[1] });
    }
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);

  /** 让一个要靠定时器才走得完的 promise 跑完（每步拨 20ms，时钟几乎不漂）。 */
  const settle = async <T>(promise: Promise<T>, maxSteps = 6000): Promise<T> => {
    let done = false;
    let value: T | undefined;
    let error: unknown;
    promise.then((v) => { value = v; done = true; }, (e) => { error = e; done = true; });
    for (let i = 0; i < maxSteps && !done; i += 1) {
      await flushCrypto();
      if (done) break;
      await vi.advanceTimersByTimeAsync(20);
      await flushCrypto();
    }
    if (!done) throw new Error('模拟卡住了：这个 promise 一直没走完');
    if (error) throw error;
    return value as T;
  };

  /**
   * 盯着哪条定时任务、cron 从几点起跑。goto 拨钟时每跨过一个整分钟就自动跑一跳 cron
   * （任务行还在的话），跟线上每分钟一跳是同一个节奏。
   */
  const watch = { task: null as string | null, from: 0, auto: true };
  const ticks: Array<{ at: number; outcome: string }> = [];
  /**
   * 拨钟。小步走、每步让出一次事件循环：正在跑的那一跳（加解密、写库）要靠真的事件循环
   * 才往前走，一口气跳过去的话它会「卡」在起跳那一刻，等钟到了终点才动。
   */
  const advance = async (ms: number) => {
    let left = ms;
    while (left > 0) {
      await flushCrypto();
      const step = Math.min(left, 100);
      await vi.advanceTimersByTimeAsync(step);
      await flushCrypto();
      left -= step;
    }
  };
  /** 没有任何东西在跑时的大跨度跳转（开场、服务停摆那一个多小时）。 */
  const leap = async (clock: string) => {
    await vi.advanceTimersByTimeAsync(at(clock) - Date.now());
  };
  const tickedMinutes = new Set<number>();
  const goto = async (clock: string) => {
    const target = at(clock);
    for (;;) {
      const now = Date.now();
      let nextMinute = Math.max(Math.ceil(now / 60_000) * 60_000, watch.from);
      // 一跳在当前毫秒内完成时，继续找下一个分钟，不能提前跳到场景终点。
      while (tickedMinutes.has(nextMinute)) nextMinute += 60_000;
      if (!watch.auto || !watch.task || nextMinute > target) break;
      await advance(nextMinute - now);
      tickedMinutes.add(nextMinute);
      // 任务已经出清（发完删行 / 标了终态）就没有可看的了，这一跳不记。
      if (taskRow(watch.task)?.status !== 'pending') continue;
      const startedAt = Date.now();
      const tick = await cron(watch.task);
      ticks.push({ at: nextMinute, outcome: tick.outcome });
      noteFire(tick, startedAt);
    }
    if (target > Date.now()) await advance(target - Date.now());
  };

  const userId = nodeCrypto.randomUUID();
  const client = new ReiClient({ baseUrl: BASE, userId, serverToken: SERVER_TOKEN } as any);
  const headers = { 'X-Client-Token': SERVER_TOKEN, 'X-User-Id': userId };
  await settle(fetch(`${BASE}/init-tenant`, { method: 'POST', headers }));
  await settle(client.init());
  await settle(client.putPushSubscription({
    endpoint: 'https://push.test/sim',
    keys: { p256dh: b64u(receiver.getPublicKey()), auth: b64u(authSecret) },
  } as any));

  // ─── 客户端这一侧（手动重演页面会做的事）───

  /** 页面本地聊天记录：落了库的才算，fire_pack 的转写就从这里出。 */
  const chat: Array<{ role: 'user' | 'assistant'; text: string; at: number }> = [];
  const pendingTasks: any[] = [];
  let stamp = 0;
  const nextStamp = () => { stamp = Math.max(Date.now(), stamp + 1); return stamp; };
  let limits: Record<string, unknown> | null = null;

  const buildPack = (withChat: boolean) => {
    const transcript = chat.map((m) => `【${m.role === 'user' ? USER_NAME : CHAR_NAME}】\n${m.text}`).join('\n\n');
    const lastUser = [...chat].reverse().find((m) => m.role === 'user');
    return {
      v: FIRE_PACK_VERSION,
      template: [
        `【角色系统设定】你是${CHAR_NAME}。`,
        '',
        '【最近对话上下文】',
        `${transcript || '（暂时没有最近聊天记录）'}${AMSG_SLOT_SELF_LOG}`,
        '',
        '【当前时刻补充】',
        `当前本地时间（你所在地）：${AMSG_SLOT_CURRENT_TIME}`,
        `${AMSG_SLOT_TIME_SINCE_USER}${AMSG_SLOT_TASK_LIST}`,
        '',
        '【本次任务】',
        AMSG_SLOT_TASK_INSTRUCTION,
        '',
        ...BEFORE_SPEAK_LINES,
      ].join('\n'),
      lastUserMessageAt: lastUser?.at ?? null,
      tzId: 'Asia/Shanghai',
      userTzId: 'Asia/Shanghai',
      targetName: USER_NAME,
      builtAt: Date.now(),
      pendingTasks,
      scene: null,
      selfScheduleEnabled: true,
      ...(withChat
        ? {
          chat: {
            builtAt: Date.now(),
            messages: [
              { role: 'system', content: `你是${CHAR_NAME}，正在和${USER_NAME}聊天。` },
              ...chat.map((m) => ({ role: m.role, content: m.text })),
            ],
          },
        }
        : {}),
    };
  };
  const stateEntries = (withChat: boolean) => {
    const updatedAt = nextStamp();
    const ns = amsgStateNamespace(CHAR_ID);
    return [
      { namespace: ns, key: AMSG_FIRE_PACK_KEY, value: JSON.stringify(buildPack(withChat)), updatedAt },
      {
        namespace: ns, key: AMSG_TOOL_PACK_KEY, updatedAt,
        value: JSON.stringify({ v: 1, charName: CHAR_NAME, xhsEnabled: false, activeMemoryMonths: [], memories: [], timeAwarenessEnabled: true }),
      },
      ...(limits ? [{ namespace: ns, key: AMSG_LIMITS_KEY, value: JSON.stringify({ v: 1, selfScheduleEnabled: true, ...limits }), updatedAt }] : []),
      {
        namespace: AMSG_GLOBAL_NAMESPACE, key: AMSG_TOOL_CONFIG_KEY, updatedAt,
        value: JSON.stringify({ v: 1, proxyWorkerUrl: '', weatherEnabled: false, newsEnabled: false, notionEnabled: false, feishuEnabled: false }),
      },
    ];
  };
  /** 页面把最新的聊天记录传上云（打脏后的那次同步）。 */
  const uploadPack = async (label = '页面把最新聊天记录传上云') => {
    await settle(client.putClientState(stateEntries(false) as any));
    ev('page', 'upload', label);
  };

  const scheduleTask = async (opts: {
    clock: string; policy?: 'expire' | 'force'; recurrence?: 'none' | 'daily'; selfScheduled?: boolean;
  }) => {
    const clientTaskId = nodeCrypto.randomUUID();
    const firstSendTime = new Date(at(opts.clock)).toISOString();
    const recurrenceType = opts.recurrence ?? 'none';
    const policy = opts.policy ?? 'expire';
    const res: any = await settle(client.scheduleMessage({
      contactName: CHAR_NAME,
      avatarUrl: null,
      messageType: 'prompted',
      messageSubtype: 'chat',
      firstSendTime,
      recurrenceType,
      tzId: 'Asia/Shanghai',
      messages: [{ role: 'user', content: '（占位）' }],
      apiUrl: native ? 'https://llm.test/v1/messages' : 'https://llm.test/v1/chat/completions',
      apiKey: 'sk-sim',
      primaryModel: 'sim-model',
      metadata: {
        charId: CHAR_ID, charName: CHAR_NAME, source: 'active_msg_2', amsgMode: 'prompted',
        amsgClientTaskId: clientTaskId, amsgExpirePolicy: policy,
        amsgTaskInstruction: TASK_HINT,
        ...(opts.selfScheduled ? { amsgSelfScheduled: true } : {}),
      },
    } as any));
    const uuid: string = res?.data?.uuid ?? res?.uuid;
    if (!uuid) throw new Error(`排任务失败：${JSON.stringify(res)}`);
    pendingTasks.push({
      taskUuid: uuid, clientTaskId, mode: 'prompted', promptHint: TASK_HINT, recurrenceType,
      expirePolicy: policy, firstSendTime, status: 'scheduled',
      source: opts.selfScheduled ? 'character' : 'user', createdAt: Date.now(),
    });
    return uuid;
  };

  const taskRow = (uuid: string) => {
    const row = d1.raw.prepare(
      'SELECT status, retry_count, retry_after, next_send_at, lease_until FROM scheduled_messages WHERE uuid = ?',
    ).get(uuid);
    return row ? { ...row } as { status: string; retry_count: number; retry_after: string | null; next_send_at: string; lease_until: string | null } : null;
  };

  let cronTicks = 0;
  /** 每分钟的 cron 跑一跳，并判出定时任务这一跳的遭遇。 */
  const cron = async (taskUuid: string) => {
    cronTicks += 1;
    const tickAt = Date.now();
    const evAt = (lane: Lane, kind: string, label: string, detail?: string) => {
      events.push({ t: tickAt, lane, kind, label, ...(detail ? { detail } : {}) });
    };
    const before = { logs: logs.length, llm: llmCalls.length, pushes: pushes.length };
    await settle((worker as any).scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env, ctx));
    await settle(Promise.all(waitUntil.splice(0)));
    const newLogs = logs.slice(before.logs);
    const row = taskRow(taskUuid);
    const fired = llmCalls.slice(before.llm).some((c) => c.kind === 'scheduled');
    const sent = pushes.slice(before.pushes).filter((p) => p.payload?.messageType !== 'instant' && p.payload?.message);
    const deferred = newLogs.find((l) => l.tag === '[amsg:defer]');
    const skipLog = newLogs.find((l) => /-skip\]$/.test(l.tag));
    let outcome: string;
    if (deferred) {
      outcome = 'deferred';
      evAt('cron', 'defer', '推迟到下一跳', '页面正在本地生成回复，等它结束');
    } else if (sent.length > 0) {
      outcome = 'sent';
      evAt('cron', 'fire', '认领并生成');
    } else if (fired) {
      outcome = 'silent';
      evAt('cron', 'fire', '认领并生成');
    } else if (skipLog) {
      outcome = 'skipped';
      evAt('cron', 'skip', '被频率上限拦下', '不调模型');
    } else if (row?.status === 'failed') {
      outcome = 'stale';
      evAt('cron', 'skip', '过期太久，不补发');
    } else if (row && row.status === 'pending' && row.retry_after && Date.parse(row.retry_after) > Date.now()) {
      outcome = 'waiting';
      evAt('cron', 'held', '还在推迟期里', `推迟到 ${hhmmss(Date.parse(row.retry_after))}`);
    } else if (row && row.status === 'pending' && Date.parse(row.next_send_at) <= Date.now()) {
      outcome = 'held';
      evAt('cron', 'held', '没认领到', '同一角色的即时回复还在生成，排在它后面');
    } else {
      outcome = 'idle';
      evAt('cron', 'idle', '没有到点的任务');
    }
    return { outcome, row, sent };
  };

  /** 一跳 cron 之后把结局记进时间线。 */
  const noteFire = (tick: { outcome: string; sent: Array<{ payload: any }> }, startedAt: number) => {
    if (tick.outcome === 'sent') {
      spans.push({ lane: 'fire', from: startedAt, to: Date.now(), label: '生成定时消息', kind: 'fire' });
      ev('phone', 'proactive', tick.sent.map((p) => p.payload.message).join(' / '), '定时消息送达');
    } else if (tick.outcome === 'silent') {
      spans.push({ lane: 'fire', from: startedAt, to: Date.now(), label: '生成定时消息', kind: 'fire' });
      ev('fire', 'silent', '角色决定不说', '不推送，回一条「这次没发」');
    }
  };

  /** 用户发一句话，走云端即时对话。返回这一轮的任务 uuid。 */
  const sendInstant = async (text: string) => {
    chat.push({ role: 'user', text, at: Date.now() });
    ev('user', 'message', text);
    const taskPayload = {
      contactName: CHAR_NAME, avatarUrl: null,
      messageType: 'auto', messageSubtype: 'instant-chat', immediate: true,
      recurrenceType: 'none', tzId: 'Asia/Shanghai',
      messages: [{ role: 'user', content: '（占位）' }],
      apiUrl: native ? 'https://llm.test/v1/messages' : 'https://llm.test/v1/chat/completions', apiKey: 'sk-sim', primaryModel: 'sim-model',
      metadata: {
        charId: CHAR_ID, charName: CHAR_NAME, source: 'active_msg_2', amsgMode: 'instant',
        amsgInstantChat: true, amsgClientTaskId: nodeCrypto.randomUUID(),
      },
    };
    const [statePayload, encryptedTask] = await Promise.all([
      (client as any)._encrypt(JSON.stringify({ entries: stateEntries(true) })),
      (client as any)._encrypt(JSON.stringify(taskPayload)),
    ]);
    const res = await settle(fetch(`${BASE}/instant-chat`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ statePayload, taskPayload: encryptedTask }),
    }));
    const body: any = await res.json();
    if (res.status !== 202) throw new Error(`即时对话没受理：${res.status} ${JSON.stringify(body)}`);
    return body.uuid as string;
  };

  /**
   * 云端开始生成这一轮即时回复。返回一个把手：finish(text) 让模型在「此刻」交卷，
   * landed 是回复推到手机的时刻。pageAlive=false 表示页面已经不在了，回复只到通知栏。
   */
  const startInstantReply = (uuid: string) => {
    const startedAt = Date.now();
    let release!: (text: string) => void;
    replies.instant.push(new Promise<string>((resolve) => { release = resolve; }));
    const storage = new Map<string, unknown>([['uuid', uuid]]);
    const stub = {
      storage: {
        get: async () => uuid,
        put: async (k: string, v: unknown) => { storage.set(k, v); },
        delete: async (k: string) => { storage.delete(k); },
        getAlarm: async () => null,
        setAlarm: async () => {},
      },
    };
    const running = new InstantTickDO(stub as any, env as any).alarm();
    running.catch(() => {});
    return {
      /** 等 DO 这一跳收场（同角色有别的任务在跑时它认领不到，空手而归）。 */
      settled: async () => { await settle(running); },
      finish: async (text: string, opts: { pageAlive?: boolean } = {}) => {
        const before = pushes.length;
        release(text);
        await settle(running);
        const landed = pushes.slice(before).filter((p) => p.payload?.message);
        spans.push({ lane: 'reply', from: startedAt, to: Date.now(), label: '云端生成回复', kind: 'instant' });
        ev('phone', 'reply', text, '即时回复送达');
        if (opts.pageAlive !== false) chat.push({ role: 'assistant', text, at: Date.now() });
        return landed;
      },
    };
  };

  /** 页面在本地生成回复：写在场记录，每 15 秒续一次。 */
  const local = {
    startedAt: 0,
    lastUserAt: 0,
    beat: async () => {
      await settle(client.putClientState([{
        namespace: amsgStateNamespace(CHAR_ID), key: AMSG_CHAT_PRESENCE_KEY, updatedAt: nextStamp(),
        value: JSON.stringify({ v: 1, charId: CHAR_ID, activeAt: Date.now(), lastUserMessageAt: local.lastUserAt }),
      }] as any));
      ev('page', 'beat', '续在场记录');
    },
    send: async (text: string) => {
      chat.push({ role: 'user', text, at: Date.now() });
      local.lastUserAt = Date.now();
      local.startedAt = Date.now();
      ev('user', 'message', text);
      await local.beat();
      await uploadPack('页面把用户这句传上云');
    },
    finish: async (text: string) => {
      chat.push({ role: 'assistant', text, at: Date.now() });
      spans.push({ lane: 'reply', from: local.startedAt, to: Date.now(), label: '页面本地生成回复', kind: 'local' });
      ev('phone', 'reply', text, '本地回复上屏');
      await uploadPack('页面把这轮回复传上云');
    },
    killed: () => {
      spans.push({ lane: 'reply', from: local.startedAt, to: Date.now(), label: '页面本地生成回复（被杀）', kind: 'killed' });
      ev('page', 'killed', '页面被系统杀掉', '回复没生成出来，在场记录没人续了');
    },
  };

  const readSkip = async () => {
    const state: any = await settle(client.getClientState(amsgStateNamespace(CHAR_ID)));
    const rows: Array<{ key: string; value: string }> = state?.data?.entries ?? state?.entries ?? [];
    const raw = rows.find((r) => r.key === AMSG_LAST_SKIP_KEY)?.value;
    const skip = raw ? parseLastSkip(raw) : null;
    return skip ? describeLastSkip(skip, (ms) => hhmmss(ms).slice(0, 5)) : null;
  };
  /** 云端回的「这次没发」→ 角色下一轮聊天会看到的那段回执。 */
  const readReceipt = async () => {
    const outbox: any = await settle(client.getOutbox());
    const entries: any[] = outbox?.data?.entries ?? [];
    for (const entry of entries) {
      const payload = entry.payload ?? entry.push ?? entry;
      const result = parseFireSkipResult(payload);
      if (!result) continue;
      const task = result.task ?? { mode: 'prompted' as const, promptHint: TASK_HINT, recurrenceType: 'none' as const };
      return buildAmsg2NoticesText([{
        id: task.recurrenceType === 'none' ? result.taskUuid : `${result.taskUuid}:${result.occurrenceMs}`,
        charId: result.charId, occurrenceMs: result.occurrenceMs, mode: task.mode,
        promptHint: task.promptHint, recurrenceType: task.recurrenceType,
        kind: 'expired', reason: result.reason, createdAt: Date.now(),
      }], 'Asia/Shanghai', USER_NAME);
    }
    return null;
  };

  const modelSaw = () => {
    const call = [...llmCalls].reverse().find((c) => c.kind === 'scheduled');
    if (!call) return undefined;
    const liveLine = call.prompt.match(/你们此刻正聊着：[^\n]*/)?.[0] ?? null;
    const replyBlock = call.prompt.match(/【这之后你回了对方】\n([\s\S]*?)\n（这是你对/)?.[1] ?? null;
    const sinceUser = call.prompt.match(/距离用户上次主动发消息[^\n]*/)?.[0] ?? null;
    const transcript = call.prompt.match(/【最近对话上下文】\n([\s\S]*?)\n\n【当前时刻补充】/)?.[1] ?? '';
    const beforeLog = transcript.split('\n\n【这之后')[0];
    const turns = beforeLog.split('\n\n').filter(Boolean);
    const lastTurn = turns.length ? turns[turns.length - 1].replace('\n', ' ') : null;
    return { liveLine, replyBlock, sinceUser, lastTurn };
  };

  return {
    ev, events, spans, goto, settle, client, chat, replies, llmCalls, pushes, logs,
    uploadPack, scheduleTask, cron, sendInstant, startInstantReply, local, taskRow,
    readSkip, readReceipt, modelSaw, watch, ticks, noteFire, leap,
    setLimits: (value: Record<string, unknown>) => { limits = value; },
    cronTicks: () => cronTicks,
  };
};

type World = Awaited<ReturnType<typeof createWorld>>;

/** 定时消息这一次生成：模型回一句话，或者回「不发」标记。 */
const scheduledSays = (w: World, text: string | null, seconds = 12) => {
  // 从模型收到请求那一刻起算，过这么多秒交卷（生成本来就要花时间）。
  w.replies.scheduled.push(() => new Promise<string>((resolve) => {
    setTimeout(() => resolve(text ?? AMSG_SILENT_MARK), seconds * 1000);
  }));
};

const finalize = async (
  w: World,
  meta: Pick<SimScenario, 'id' | 'group' | 'title' | 'setup' | 'note'> & { dueClock: string; summary: string },
) => {
  const due = at(meta.dueClock);
  const proactive = w.events.find((e) => e.kind === 'proactive');
  const silent = w.events.find((e) => e.kind === 'silent');
  const receipt = await w.readReceipt();
  const panel = proactive ? null : await w.readSkip();
  const scenario: SimScenario = {
    id: meta.id, group: meta.group, title: meta.title, setup: meta.setup, due,
    events: [...w.events].sort((a, b) => a.t - b.t),
    spans: w.spans,
    outcome: proactive
      ? { verdict: 'sent', sentAt: proactive.t, delayMs: proactive.t - due, text: proactive.label, summary: meta.summary }
      : { verdict: silent ? 'silent' : 'skipped', summary: meta.summary },
    modelSaw: w.modelSaw(),
    receipt,
    panel,
    cost: {
      scheduledLlmCalls: w.llmCalls.filter((c) => c.kind === 'scheduled' && c.at >= due).length,
      cronTicks: w.ticks.filter((t) => t.at >= due).length || w.cronTicks(),
    },
    ...(meta.note ? { note: meta.note } : {}),
  };
  scenarios.push(scenario);
  return scenario;
};

describe.skipIf(!sqlite)('到点时用户正在聊天（全链路模拟）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const out = process.env.AMSG_SIM_OUT;
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), scenarios }, null, 2));
    }
  });

  const TIMEOUT = 60_000;

  it('Anthropic 原生：真实 Worker 排程、D1、即时对话和推送均可贯通', async () => {
    const w = await createWorld('07:30:00', true);
    const task = await w.scheduleTask({clock:'08:00:00'});
    await w.uploadPack('原生接口上下文');
    w.watch.task = task; w.watch.from = at('08:00:00');
    scheduledSays(w, '原生定时回复');
    await w.goto('08:00:30');
    expect(w.llmCalls.filter(c=>c.kind==='scheduled')).toHaveLength(1);
    expect(w.pushes.some(p=>p.payload.message==='原生定时回复')).toBe(true);
    const reply=w.startInstantReply(await w.sendInstant('你好'));
    const landed=await reply.finish('原生即时回复');
    expect(landed.some(p=>p.payload.message==='原生即时回复')).toBe(true);
    expect(w.llmCalls.filter(c=>c.kind==='instant')).toHaveLength(1);
  }, TIMEOUT);

  /** 开场：07:30 排一条 08:00 的任务，页面把当时的聊天记录传上云。 */
  const open = async (opts: Parameters<World['scheduleTask']>[0] = { clock: '08:00:00' }) => {
    const w = await createWorld('07:30:00');
    w.chat.push({ role: 'user', text: '明早八点记得叫我，我要赶早班车', at: at('07:10:00') });
    w.chat.push({ role: 'assistant', text: '好，八点准时叫你。', at: at('07:10:20') });
    const task = await w.scheduleTask(opts);
    await w.uploadPack('页面把聊天记录传上云');
    w.events.length = 0;
    w.watch.task = task;
    w.watch.from = at(opts.clock);
    await w.leap('07:57:00');
    return { w, task };
  };

  // ─── 对照组 ───

  it('A1 没人聊天：准点发', async () => {
    const { w } = await open();
    scheduledSays(w, '八点啦，快起床，早班车不等人。');
    await w.goto('08:01:30');
    const s = await finalize(w, {
      id: 'A1', group: '对照', title: '到点时没人在聊天', dueClock: '08:00:00',
      setup: '用户 50 分钟前说过话，之后没动静。',
      summary: '准点生成、准点送达。',
    });
    expect(s.outcome.verdict).toBe('sent');
    expect(s.outcome.delayMs).toBeLessThan(20_000);
    expect(s.modelSaw?.liveLine).toBeNull();
  }, TIMEOUT);

  // ─── 即时对话（云端生成）───

  it('B1 即时回复正在生成时到点：等它结束再生成，只生成一次', async () => {
    const { w } = await open();
    await w.goto('07:59:40');
    const reply = w.startInstantReply(await w.sendInstant('我昨晚没睡好，好困'));
    await w.goto('08:00:25');
    await reply.finish('抱抱，那今天早点睡。');
    await w.goto('08:00:27');
    await w.uploadPack('页面收到回复，把聊天记录传上云');
    scheduledSays(w, '困也得起啦，八点了，再不出门早班车就走了。');
    await w.goto('08:02:00');
    const s = await finalize(w, {
      id: 'B1', group: '即时对话', title: '回复正在生成时到点', dueClock: '08:00:00',
      setup: '用户 07:59:40 发消息，云端回复生成到 08:00:25，页面开着。',
      summary: '08:00 那一跳认领不到（排在回复后面），不调模型；08:01 生成，晚 1 分钟送达。',
    });
    expect(w.ticks.map((t) => t.outcome)).toEqual(['held', 'sent']);
    expect(s.cost.scheduledLlmCalls).toBe(1);
    expect(s.modelSaw?.liveLine).toContain('正聊着');
    expect(s.modelSaw?.lastTurn).toContain('抱抱');
  }, TIMEOUT);

  it('B2 回复正在生成时到点，页面已经被杀：不依赖页面，角色从云端自述里接上话', async () => {
    const { w } = await open();
    await w.goto('07:59:40');
    const reply = w.startInstantReply(await w.sendInstant('今天要面试，有点紧张'));
    await w.goto('07:59:50');
    w.ev('page', 'killed', '页面被系统杀掉', '回复还在云端生成');
    await w.goto('08:00:25');
    await reply.finish('你准备得很充分，深呼吸，没问题的。', { pageAlive: false });
    scheduledSays(w, '对了，八点了，该出门了，面试别迟到。');
    await w.goto('08:02:00');
    const s = await finalize(w, {
      id: 'B2', group: '即时对话', title: '回复正在生成时到点，页面已经被杀', dueClock: '08:00:00',
      setup: '用户 07:59:40 发消息后页面被杀；云端回复生成到 08:00:25，只到了通知栏。',
      summary: '跟页面开着时一样：08:00 等，08:01 生成。聊天记录没同步，角色靠「这之后你回了对方」那段读到自己刚回的话。',
    });
    expect(w.ticks.map((t) => t.outcome)).toEqual(['held', 'sent']);
    expect(s.modelSaw?.replyBlock).toContain('深呼吸');
  }, TIMEOUT);

  it('B3 回复生成了三分多钟（带工具循环）：中间每一跳都只是没认领到', async () => {
    const { w } = await open();
    await w.goto('07:59:30');
    const reply = w.startInstantReply(await w.sendInstant('帮我查查今天早班车改点没有'));
    await w.goto('08:03:20');
    await reply.finish('查到了，今天照常 8:20 发车。');
    await w.goto('08:03:22');
    await w.uploadPack('页面收到回复，把聊天记录传上云');
    scheduledSays(w, '那你还有十几分钟，快起来洗漱出门。');
    await w.goto('08:05:00');
    const s = await finalize(w, {
      id: 'B3', group: '即时对话', title: '回复生成了三分多钟', dueClock: '08:00:00',
      setup: '用户 07:59:30 发消息，云端回复带工具循环，生成到 08:03:20。',
      summary: '连着四跳没认领到，任务行一个字段都没动，也没调模型；08:04 生成一次，晚 4 分钟送达。',
    });
    expect(w.ticks.map((t) => t.outcome)).toEqual(['held', 'held', 'held', 'held', 'sent']);
    expect(s.cost.scheduledLlmCalls).toBe(1);
  }, TIMEOUT);

  it('B4 「我等着你八点的消息」：照发', async () => {
    const { w } = await open();
    await w.goto('07:59:00');
    const reply = w.startInstantReply(await w.sendInstant('我醒了，就等你八点叫我呢'));
    await w.goto('07:59:20');
    await reply.finish('那你乖乖等着。');
    await w.goto('07:59:22');
    await w.uploadPack('页面收到回复，把聊天记录传上云');
    scheduledSays(w, '八点整！说好的叫你——起床，出门，早班车。');
    await w.goto('08:01:30');
    const s = await finalize(w, {
      id: 'B4', group: '即时对话', title: '用户一分钟前说「我等着你八点的消息」', dueClock: '08:00:00',
      setup: '用户 07:59 发消息，回复 07:59:20 就结束了，到点时没有回复在生成。',
      summary: '准点生成、准点送达。提示词里写明对方 1 分钟前还在说话。',
    });
    expect(s.outcome.verdict).toBe('sent');
    expect(s.outcome.delayMs).toBeLessThan(20_000);
  }, TIMEOUT);

  it('B5 刚聊完同一件事：角色决定不说，本地拿到回执', async () => {
    const { w } = await open();
    await w.goto('07:58:00');
    const reply = w.startInstantReply(await w.sendInstant('我已经起来了，在等车了'));
    await w.goto('07:58:20');
    await reply.finish('这么早！路上小心。');
    await w.goto('07:58:22');
    await w.uploadPack('页面收到回复，把聊天记录传上云');
    scheduledSays(w, null);
    await w.goto('08:01:30');
    const s = await finalize(w, {
      id: 'B5', group: '即时对话', title: '要说的事刚刚已经聊过了', dueClock: '08:00:00',
      setup: '用户 07:58 说「我已经起来了，在等车了」。',
      summary: '准点生成，角色输出「不发」标记：不推送，面板和角色下一轮都知道这条没发。',
    });
    expect(s.outcome.verdict).toBe('silent');
    expect(s.receipt).toContain('你当时看了对话，决定不说');
  }, TIMEOUT);

  it('B6 定时消息正在生成时用户发消息：这句的回复要等到下一跳 cron', async () => {
    const { w, task } = await open();
    w.watch.auto = false;
    await w.goto('08:00:00');
    let release!: (text: string) => void;
    w.replies.scheduled.push(new Promise<string>((resolve) => { release = resolve; }));
    const firing = w.cron(task);
    firing.catch(() => {});
    await w.goto('08:00:05');
    const uuid = await w.sendInstant('在吗在吗');
    const kicked = w.startInstantReply(uuid);
    await kicked.settled();
    // 被叫醒的那一跳有没有真的开始生成：看模型有没有收到即时回复的请求。
    const ranNow = w.llmCalls.some((c) => c.kind === 'instant');
    w.ev('reply', 'note', ranNow ? '即时回复开始生成' : '即时回复没跑起来', '同一角色的定时消息还在生成，这一轮认领不到，等下一跳 cron');
    await w.goto('08:00:15');
    release('八点啦，起床出门。');
    w.noteFire(await firing, at('08:00:00'));
    w.replies.instant.length = 0;
    w.replies.instant.push('在呢，刚叫完你起床。');
    await w.goto('08:01:00');
    const before = w.pushes.length;
    await w.cron(task);
    const landed = w.pushes.slice(before).filter((p) => p.payload?.message);
    if (landed.length > 0) {
      w.spans.push({ lane: 'reply', from: at('08:01:00'), to: Date.now(), label: '云端生成回复', kind: 'instant' });
      w.ev('phone', 'reply', landed.map((p) => p.payload.message).join(' / '), '即时回复送达');
    }
    const s = await finalize(w, {
      id: 'B6', group: '即时对话', title: '定时消息正在生成时，用户发来一句', dueClock: '08:00:00',
      setup: '08:00 定时消息开始生成（要 15 秒），用户 08:00:05 发消息。',
      summary: '定时消息照常发出。用户那句当时认领不到，08:01 的 cron 才捡起来：用户等了将近一分钟。',
      note: '这是原本就有的行为，这次没动：即时回复被叫醒时发现同角色有任务在跑，就只能等下一跳 cron。',
    });
    expect(s.outcome.verdict).toBe('sent');
    expect(ranNow).toBe(false);
    expect(landed.length).toBeGreaterThan(0);
  }, TIMEOUT);

  // ─── 本地生成（页面自己调模型）───

  it('C1 页面本地正在生成时到点：推迟，回复结束后下一跳生成', async () => {
    const { w } = await open();
    await w.goto('07:59:45');
    await w.local.send('我昨晚没睡好，好困');
    await w.goto('08:00:00.5');
    await w.local.beat();
    await w.goto('08:00:10');
    await w.local.finish('抱抱，那今天早点睡。');
    scheduledSays(w, '困也得起啦，八点多了，快出门。');
    await w.goto('08:03:00');
    const s = await finalize(w, {
      id: 'C1', group: '本地生成', title: '页面本地正在生成回复时到点', dueClock: '08:00:00',
      setup: '用户 07:59:45 发消息，页面本地生成到 08:00:10，页面开着。',
      summary: '08:00 推迟；最后一次续在场记录是 08:00:00，到 08:01 已过 45 秒，放行。晚 1 分钟送达。',
    });
    expect(w.ticks.map((t) => t.outcome)).toEqual(['deferred', 'sent']);
    expect(s.cost.scheduledLlmCalls).toBe(1);
    expect(s.modelSaw?.lastTurn).toContain('抱抱');
  }, TIMEOUT);

  it('C2 本地回复 08:00:30 才结束：在场记录还没过期，多等一跳', async () => {
    const { w } = await open();
    await w.goto('07:59:45');
    await w.local.send('我昨晚没睡好，好困');
    for (const clock of ['08:00:00.5', '08:00:15', '08:00:30']) {
      await w.goto(clock);
      await w.local.beat();
    }
    await w.goto('08:00:32');
    await w.local.finish('抱抱，那今天早点睡。');
    scheduledSays(w, '困也得起啦，八点多了，快出门。');
    await w.goto('08:03:00');
    const s = await finalize(w, {
      id: 'C2', group: '本地生成', title: '本地回复结束在到点后半分钟', dueClock: '08:00:00',
      setup: '用户 07:59:45 发消息，页面本地生成到 08:00:32（最后一次续在场记录 08:00:30）。',
      summary: '回复 08:00:32 就结束了，但在场记录要到 08:01:15 才过期，08:01 那一跳还是被推迟，08:02 才生成。',
      note: '回复结束时页面不会撤掉在场记录，只能等它 45 秒自然过期。',
    });
    expect(w.ticks.map((t) => t.outcome)).toEqual(['deferred', 'deferred', 'sent']);
    expect(s.cost.scheduledLlmCalls).toBe(1);
  }, TIMEOUT);

  it('C3 本地生成到一半页面被杀：在场记录没人续，下一跳放行', async () => {
    const { w } = await open();
    await w.goto('07:59:50');
    await w.local.send('今天要面试，有点紧张');
    await w.goto('08:00:05');
    w.local.killed();
    scheduledSays(w, '别紧张，你可以的。八点了，该出门去面试啦。');
    await w.goto('08:02:00');
    const s = await finalize(w, {
      id: 'C3', group: '本地生成', title: '本地生成到一半，页面被杀', dueClock: '08:00:00',
      setup: '用户 07:59:50 发消息，页面 08:00:05 被杀，那轮回复没生成出来。',
      summary: '08:00 推迟一次，08:01 放行。角色看得到用户那句（没人答过），自己接着说。',
    });
    expect(w.ticks.map((t) => t.outcome)).toEqual(['deferred', 'sent']);
    expect(s.modelSaw?.lastTurn).toContain('面试');
  }, TIMEOUT);

  it('C4 用户连着聊（每轮间隔不到 45 秒）：一直被推迟，聊完才发', async () => {
    const { w } = await open();
    const rounds: Array<[string, string, string, string]> = [
      ['07:59:40', '08:00:10', '我昨晚没睡好', '怎么啦？'],
      ['08:00:35', '08:01:05', '做了个怪梦', '梦见什么了？'],
      ['08:01:30', '08:02:05', '梦见赶不上车', '那是你太惦记今天的早班车了。'],
      ['08:02:35', '08:03:05', '哈哈可能是', '快起来吧。'],
    ];
    scheduledSays(w, '聊了这么久，真得出门啦，早班车！');
    for (const [sendAt, doneAt, text, replyText] of rounds) {
      await w.goto(sendAt);
      await w.local.send(text);
      for (let t = at(sendAt) + 15_000; t < at(doneAt); t += 15_000) {
        await w.goto(hhmmss(t));
        await w.local.beat();
      }
      await w.goto(doneAt);
      await w.local.finish(replyText);
    }
    await w.goto('08:06:00');
    const outcomes = w.ticks.map((t) => t.outcome).filter(Boolean);
    const s = await finalize(w, {
      id: 'C4', group: '本地生成', title: '用户连着聊了四轮，每轮间隔不到 45 秒', dueClock: '08:00:00',
      setup: '07:59:40 到 08:03:05 连续四轮本地对话。',
      summary: '每一跳 cron 都落在在场记录的有效期里，连推四次；聊天停下后的第一跳才生成，晚 4 分钟。',
      note: '本地生成这条路上，只要用户聊得密，定时消息就一直等。总预算是 60 分钟，超过按过期收场。',
    });
    expect(outcomes).toEqual(['deferred', 'deferred', 'deferred', 'deferred', 'sent']);
    expect(s.cost.scheduledLlmCalls).toBe(1);
  }, TIMEOUT);

  it('C5 到点必发（闹钟型）：本地正在生成也准点发', async () => {
    const { w } = await open({ clock: '08:00:00', policy: 'force' });
    await w.goto('07:59:50');
    await w.local.send('再让我睡五分钟');
    scheduledSays(w, '不行，八点了，起床！');
    await w.goto('08:00:20');
    await w.local.finish('就五分钟哦。');
    await w.goto('08:01:30');
    const s = await finalize(w, {
      id: 'C5', group: '本地生成', title: '到点必发的任务，本地正在生成回复', dueClock: '08:00:00',
      setup: '任务策略是「到点必发」。用户 07:59:50 发消息，本地回复 08:00:20 才出来。',
      summary: '不等，准点发。定时消息和那轮回复各说各的，前后脚出现。',
      note: '闹钟型的既定取舍：准点优先。',
    });
    expect(s.outcome.verdict).toBe('sent');
    expect(s.outcome.delayMs).toBeLessThan(20_000);
  }, TIMEOUT);

  it('C6 每天重复的任务被推迟：发的还是「今天这一次」，明天照旧 08:00', async () => {
    const { w, task } = await open({ clock: '08:00:00', recurrence: 'daily' });
    await w.goto('07:59:45');
    await w.local.send('我昨晚没睡好，好困');
    await w.goto('08:00:10');
    await w.local.finish('抱抱，那今天早点睡。');
    scheduledSays(w, '早安，八点了，起床出门。');
    await w.goto('08:02:00');
    const next = w.taskRow(task)?.next_send_at;
    const s = await finalize(w, {
      id: 'C6', group: '本地生成', title: '每天 08:00 的重复任务被推迟了一跳', dueClock: '08:00:00',
      setup: '每天 08:00 的任务。用户 07:59:45 发消息，页面本地生成到 08:00:10。',
      summary: `08:01 发出今天这一次；下一次仍是明天 ${next ? hhmmss(Date.parse(next)).slice(0, 5) : '?'}，没有跟着往后漂。`,
    });
    expect(s.outcome.verdict).toBe('sent');
    expect(next).toBe(new Date(at('08:00:00') + 24 * 3600_000).toISOString());
  }, TIMEOUT);

  // ─── 没发的几种 ───

  it('D1 被用户定的连发上限拦下：不调模型，角色拿到回执', async () => {
    const w = await createWorld('07:30:00');
    w.setLimits({ maxUnansweredSends: 1 });
    w.chat.push({ role: 'user', text: '我去睡了', at: at('07:00:00') });
    const first = await w.scheduleTask({ clock: '07:45:00', selfScheduled: true });
    const task = await w.scheduleTask({ clock: '08:00:00', selfScheduled: true });
    await w.uploadPack('页面把聊天记录传上云');
    w.events.length = 0;
    w.watch.task = first;
    w.watch.from = at('07:45:00');
    scheduledSays(w, '睡得好吗？');
    await w.goto('07:46:00');
    w.events.length = 0;
    w.spans.length = 0;
    w.ev('phone', 'earlier', '（07:45 角色已经主动发过一条，用户没回）');
    w.watch.task = task;
    w.watch.from = at('08:00:00');
    await w.goto('08:01:30');
    const s = await finalize(w, {
      id: 'D1', group: '没发的几种', title: '角色自排的任务撞上连发上限', dueClock: '08:00:00',
      setup: '用户设了「没回复时最多连发 1 次」。角色 07:45 已经主动发过一条，用户没回。',
      summary: '08:00 直接跳过，不调模型。角色下一轮知道这条被频率规矩拦下了。',
    });
    expect(w.ticks.find((t) => t.at === at('08:00:00'))?.outcome).toBe('skipped');
    expect(s.cost.scheduledLlmCalls).toBe(0);
    expect(s.receipt).toContain('频率规矩');
  }, TIMEOUT);

  it('D2 服务停了一个多小时：过期不补发，角色拿到回执', async () => {
    const { w } = await open();
    w.watch.from = at('09:05:00');
    await w.leap('09:04:59');
    w.ev('cron', 'note', 'cron 恢复', '08:00 到 09:05 之间一跳都没跑');
    await w.goto('09:06:00');
    const s = await finalize(w, {
      id: 'D2', group: '没发的几种', title: '到点时服务停着，一个多小时后才恢复', dueClock: '08:00:00',
      setup: '08:00 到 09:05 之间 cron 一跳都没跑。',
      summary: '超过 60 分钟的过期线，不补发、不调模型。',
    });
    expect(w.ticks.map((t) => t.outcome)).toEqual(['stale']);
    expect(s.cost.scheduledLlmCalls).toBe(0);
    expect(s.receipt).toContain('服务中断');
  }, TIMEOUT);
});

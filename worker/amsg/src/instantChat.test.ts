// worker/amsg/src/instantChat.test.ts
//
// 即时对话这条路上最要命的是「顺序」和「失败就别落任务」：云端状态没传上去却把任务
// 建了，到点那条 fire 会拿上一轮的上下文答这一轮的话——不报错、不重试，用户只会觉得
// 角色突然听不懂人话。下面每条都对着一种具体的坏法。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCipheriv, createHash } from 'node:crypto';
import { decryptPayload } from '@rei-standard/amsg-server';
import { FIRE_PACK_VERSION } from '../../../utils/amsgFirePack';

import {
  applyInstantNotificationPolicy,
  buildInstantTimelyBlock,
  handleInstantChat,
  isInstantChatTask,
} from './instantChat';
import { TIME_FRAMING_CONVERSATIONAL } from '../../../utils/timeFramingNote';

const USER_ID = '3637dae1-1461-4444-a747-34e406f67acc';
const TASK_UUID = '7a1f0b4c-2c9d-4a3e-8b21-9f0f3c5d7e11';

const MASTER_KEY = 'b'.repeat(64);
const USER_KEY = createHash('sha256').update(MASTER_KEY + USER_ID).digest('hex');
const INPUT_PACK = {
  v: FIRE_PACK_VERSION, template: '角色设定', builtAt: 1784980800000,
  lastUserMessageAt: 1784980800000, tzId: 'Asia/Tokyo', userTzId: 'Asia/Tokyo', targetName: '用户',
  pendingTasks: [], scene: null, selfScheduleEnabled: false,
  chat: { builtAt: 1784980800000, messages: [{ role: 'user', content: '这一轮用户消息' }] },
};
/** 真正的 AES-GCM 信封；固定 IV 只用来让测试夹具可比较。 */
const envelope = (tag: string, value?: unknown) => {
  const payload = value ?? (tag === 'state' ? { entries: [
    { namespace: 'amsg:char:c1', key: 'fire_pack', value: JSON.stringify(INPUT_PACK), updatedAt: INPUT_PACK.builtAt },
    { namespace: 'amsg:char:c1', key: 'limits', value: '{}', updatedAt: INPUT_PACK.builtAt },
  ] } : tag === 'task' ? { metadata: { charId: 'c1', amsgInstantChat: true }, immediate: true } : { credentials: [] });
  const iv = createHash('sha256').update(tag).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(USER_KEY, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), encryptedData: encrypted.toString('base64') };
};
const readForwarded = (call: { body: string }) => decryptPayload(JSON.parse(call.body), USER_KEY);
const expectBoundInput = async (stateCall: { body: string }, taskCall: { body: string }) => {
  const state = await readForwarded(stateCall);
  const task = await readForwarded(taskCall);
  expect(state.entries.some((entry: any) => entry.key === 'fire_pack')).toBe(false);
  expect(task.taskInput.firePackRef).toEqual({ namespace: 'amsg:instant-input', key: expect.any(String) });
  const input = state.entries.find((entry: any) => entry.namespace === task.taskInput.firePackRef.namespace
    && entry.key === task.taskInput.firePackRef.key);
  expect(JSON.parse(JSON.parse(input.value).packedFirePack)).toEqual(INPUT_PACK);
  expect(task.taskInput.firePack).toBeUndefined();
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });

/** 记下每一次内部转发，顺序本身就是要钉的东西。 */
const makeUpstream = (opts: {
  clientState?: { status: number; body?: unknown };
  scheduleMessage?: { status: number; body?: unknown };
  llmCredentials?: { status: number; body?: unknown };
} = {}) => {
  const calls: Array<{ method: string; path: string; search: string; headers: Record<string, string>; body: string }> = [];
  const reply = (spec: { status: number; body?: unknown } | undefined, fallback: unknown) =>
    json(spec?.status ?? 200, spec?.body ?? fallback);
  const upstream = {
    fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      calls.push({
        method: request.method.toUpperCase(),
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      if (url.pathname.endsWith('/client-state')) {
        return reply(opts.clientState, { success: true, data: { upserted: 3, skipped: 0 } });
      }
      if (url.pathname.endsWith('/schedule-message')) {
        return reply(opts.scheduleMessage, { success: true, data: { uuid: TASK_UUID, id: 42 } });
      }
      if (url.pathname.endsWith('/llm-credentials')) {
        return reply(opts.llmCredentials, { success: true, data: { upserted: 1 } });
      }
      return json(404, { success: false });
    }),
  };
  return { upstream, calls, paths: () => calls.map((c) => `${c.method} ${c.path}`) };
};

/**
 * INSTANT_TICK 绑定的替身。记下叫醒了哪个实例、传了哪个 uuid。
 *
 * `kick` 只负责给 DO 记下 uuid、设 alarm，真正的生成在 alarm 里跑（另一次 invocation，
 * 走 upstream.runTask），所以这条路上根本碰不到 upstream 的执行入口——那是 DO 侧的事，
 * 见 index.ts 的 InstantTickDO。
 */
const makeTick = (opts: { kick?: () => Promise<unknown> } = {}) => {
  const kicks: Array<{ instance: string; uuid: string }> = [];
  return {
    kicks,
    INSTANT_TICK: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        kick: async (uuid: string) => {
          kicks.push({ instance: id.name, uuid });
          return opts.kick ? opts.kick() : undefined;
        },
      }),
    },
  };
};

const post = (
  body: unknown,
  opts: { headers?: Record<string, string>; url?: string } = {},
) => new Request(opts.url ?? 'https://w.example/instant-chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User-Id': USER_ID, ...(opts.headers ?? {}) },
  body: JSON.stringify(body),
});

const validBody = (extra: Record<string, unknown> = {}) => ({
  statePayload: envelope('state'),
  taskPayload: envelope('task'),
  ...extra,
});

/** 默认参数跑一次。重试梯子清零：钉的是「重了几次」，不是「等了多久」。 */
const run = (args: {
  request: Request;
  env?: Record<string, unknown>;
  upstream: ReturnType<typeof makeUpstream>['upstream'];
  /** 不传就用一个正常工作的替身；要测「Worker 是旧的」显式传 null。 */
  tick?: ReturnType<typeof makeTick> | null;
}) => handleInstantChat({
  request: args.request,
  env: {
    AMSG_MASTER_KEY: MASTER_KEY,
    ...(args.tick === null ? {} : { INSTANT_TICK: (args.tick ?? makeTick()).INSTANT_TICK }),
    ...(args.env ?? {}),
  } as any,
  upstream: args.upstream as any,
  json,
  stateBackoffMs: [0, 0, 0],
});

describe('POST /instant-chat — 鉴权', () => {
  it('配了口令而请求没带 → 401，而且一个字节的云端状态都不写', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({
      request: post(validBody()),
      env: { AMSG_SERVER_TOKEN: 'secret' },
      upstream,
    });
    expect(response.status).toBe(401);
    // 回归守卫：没有这道门的话，转发出去的 PUT /client-state 会先把状态写进库，
    // 上游那边才 401——一个没通过鉴权的请求已经改了库里的数据。
    expect(calls).toHaveLength(0);
  });

  it('口令不对 → 401，同样不转发', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({
      request: post(validBody(), { headers: { 'X-Client-Token': 'wrong' } }),
      env: { AMSG_SERVER_TOKEN: 'secret' },
      upstream,
    });
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('口令对得上 → 放行，并把它原样带给上游（上游是权威，还要再验一次）', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({
      request: post(validBody(), { headers: { 'X-Client-Token': 'secret' } }),
      env: { AMSG_SERVER_TOKEN: 'secret' },
      upstream,
    });
    expect(response.status).toBe(202);
    expect(calls.every((c) => c.headers['x-client-token'] === 'secret')).toBe(true);
  });

  it('没配口令 → 不校验（跟上游同一套判据）', async () => {
    const { upstream } = makeUpstream();
    expect((await run({ request: post(validBody()), upstream })).status).toBe(202);
  });

  it('缺 X-User-Id / 不是 UUID v4 → 400，不转发', async () => {
    const { upstream, calls } = makeUpstream();
    const noUser = new Request('https://w.example/instant-chat', {
      method: 'POST', body: JSON.stringify(validBody()),
    });
    expect((await run({ request: noUser, upstream })).status).toBe(400);
    const badUser = post(validBody(), { headers: { 'X-User-Id': 'not-a-uuid' } });
    expect((await run({ request: badUser, upstream })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /instant-chat — 请求体', () => {
  it('不是 JSON 对象 → 400', async () => {
    const { upstream, calls } = makeUpstream();
    const bad = new Request('https://w.example/instant-chat', {
      method: 'POST', headers: { 'X-User-Id': USER_ID }, body: 'not json',
    });
    const response = await run({ request: bad, upstream });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe('INVALID_JSON');
    expect(calls).toHaveLength(0);
  });

  it('两个信封形状不对 → 400，且在任何转发之前就挡住', async () => {
    const { upstream, calls } = makeUpstream();
    const noState = await run({ request: post({ taskPayload: envelope('t') }), upstream });
    expect(noState.status).toBe(400);
    expect((await noState.json() as any).error.code).toBe('INVALID_STATE_PAYLOAD');

    // taskPayload 不合格时同样一次都不转发——否则状态先写进去了，任务却建不成，
    // 云端留下一份「用户已经说了这句」而角色永远不会回。
    const noTask = await run({ request: post({ statePayload: envelope('s') }), upstream });
    expect(noTask.status).toBe(400);
    expect((await noTask.json() as any).error.code).toBe('INVALID_TASK_PAYLOAD');
    expect(calls).toHaveLength(0);
  });
});

// 客户端在 body 超阈值时会 gzip 再发（这条路上的正文是整轮聊天，最大的一份）。
// 这三条钉的是「解压这一步不能因为链路上有人插手就炸」——挂了的表现是所有大 body
// 的请求统统 400 INVALID_JSON，而小 body 一切正常，从外面看像是「长消息发不出去」。
describe('POST /instant-chat — gzip 上行', () => {
  const gzip = async (text: string): Promise<ArrayBuffer> => {
    const stream = new Response(new TextEncoder().encode(text)).body!
      .pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  };

  const postRaw = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('https://w.example/instant-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': USER_ID, ...headers },
      body,
    });

  it('压过的请求体解得开，转发时把本轮输入绑定为独立引用', async () => {
    const { upstream, calls } = makeUpstream();
    const payload = JSON.stringify(validBody());
    const response = await run({
      request: postRaw(await gzip(payload), { 'Content-Encoding': 'gzip' }),
      upstream,
    });
    expect(response.status).toBe(202);
    await expectBoundInput(calls[0], calls[1]);
  });

  // 最要命的一档：`Content-Encoding` 是标准头，链路上的边缘节点会替你把请求体解开
  // 却把头留着（SullyOS 实测遇到过）。只看头就去解压的话，
  // 这里拿到的是明文，解压器当场抛错，用户侧是一句「请求体不是合法的 JSON」。
  it('头写着 gzip、字节其实是明文（边缘替我们解过了）→ 照常按明文读', async () => {
    const { upstream } = makeUpstream();
    const response = await run({
      request: postRaw(JSON.stringify(validBody()), { 'Content-Encoding': 'gzip' }),
      upstream,
    });
    expect(response.status).toBe(202);
  });

  it('没有这个头 → 一字不差地走老路（老客户端不压）', async () => {
    const { upstream } = makeUpstream();
    expect((await run({ request: post(validBody()), upstream })).status).toBe(202);
  });
});

describe('POST /instant-chat — 严格顺序与失败传播', () => {
  it('顺序：先传云端状态，再建任务', async () => {
    const { upstream, paths } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(202);
    expect(paths()).toEqual(['PUT /client-state', 'POST /schedule-message']);
  });

  it('云端状态失败 → 原样把状态码报回去，而且**绝不建任务**', async () => {
    const { upstream, paths } = makeUpstream({
      clientState: { status: 400, body: { success: false, error: { code: 'TOO_MANY_STATE_ENTRIES' } } },
    });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_STATE_FAILED');
    expect(body.error.step).toBe('client-state');
    expect(body.error.upstream.error.code).toBe('TOO_MANY_STATE_ENTRIES');
    // 回归守卫：这一步失败还往下建任务的话，到点那条 fire 会拿上一轮的上下文答这一轮。
    expect(paths()).toEqual(['PUT /client-state']);
  });

  // 独立输入也必须拿到写入确认；即使 HTTP 成功，条件写拒绝仍不能继续建任务。
  it('client-state 200 但不可变输入被条件写拦下 → 409，绝不建任务', async () => {
    const { upstream, calls } = makeUpstream();
    upstream.fetch.mockImplementationOnce(async (request: Request) => {
      const state = await decryptPayload(await request.json() as any, USER_KEY);
      const input = state.entries.find((entry: any) => entry.namespace === 'amsg:instant-input');
      return json(200, { success: true, data: { upserted: 1,
        skippedEntries: [{ namespace: input.namespace, key: input.key }],
      } });
    });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_STATE_STALE');
    expect(body.error.step).toBe('client-state');
    expect(calls).toHaveLength(0);
  });

  it('client-state 200、被拦的只是别的条目（非即时输入）→ 照常受理', async () => {
    const { upstream } = makeUpstream({
      clientState: {
        status: 200,
        body: {
          success: true,
          data: { upserted: 2, skippedEntries: [{ namespace: 'amsg:char:c1', key: 'chat_presence' }] },
        },
      },
    });
    expect((await run({ request: post(validBody()), upstream })).status).toBe(202);
  });

  it('建任务失败 → 报 schedule-message 那一步，不假装受理', async () => {
    const { upstream } = makeUpstream({
      scheduleMessage: { status: 409, body: { success: false, error: { code: 'PUSH_SUBSCRIPTION_MISSING' } } },
    });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_TASK_FAILED');
    expect(body.error.step).toBe('schedule-message');
  });

  it('上游回了 200 却没给 uuid → 502（跟不上这一轮，宁可让客户端重发）', async () => {
    const { upstream } = makeUpstream({ scheduleMessage: { status: 200, body: { success: true, data: {} } } });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(502);
    expect((await response.json() as any).error.code).toBe('INSTANT_CHAT_TASK_UUID_MISSING');
  });

  it('转发带全套加密头，重封装后上游照常解密并复验鉴权', async () => {
    const { upstream, calls } = makeUpstream();
    await run({ request: post(validBody()), upstream });
    const state = calls.find((c) => c.path.endsWith('/client-state'))!;
    expect(state.headers['x-user-id']).toBe(USER_ID);
    expect(state.headers['x-payload-encrypted']).toBe('true');
    expect(state.headers['x-encryption-version']).toBe('1');
    const task = calls.find((c) => c.path.endsWith('/schedule-message'))!;
    await expectBoundInput(state, task);
  });

  it('worker 挂在子路径下时，内部转发跟着挂载点走（上游按后缀匹配）', async () => {
    const { upstream, calls } = makeUpstream();
    await run({
      request: post(validBody(), { url: 'https://w.example/amsg/instant-chat' }),
      upstream,
    });
    expect(calls.map((c) => c.path)).toEqual(['/amsg/client-state', '/amsg/schedule-message']);
  });

  it('202 的形状是 { status: "accepted", uuid }', async () => {
    const { upstream } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'accepted', uuid: TASK_UUID });
  });
});

// 上游 500 的 message 是一句写死的「服务器内部错误」，用户照着它什么也做不了。
// 真实原因（缺表、D1 超时……）由 amsg-server 2.6.0-next.16 起放在 error.cause 里，
// 这里必须原样端到客户端面前——否则他看到的还是那句什么都没说的话。
describe('POST /instant-chat — 把上游 error.cause 里那句真话带回去', () => {
  /** 上游抛异常时的真实响应：泛型 message + 带真因的 cause。 */
  const throwsInside = (
    status = 500,
    cause: Record<string, unknown> | null = {
      stage: 'request',
      name: 'Error',
      message: 'D1_ERROR: no such table: message_outbox',
      code: 'D1_ERROR',
    },
  ) => ({
    status,
    body: {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误', ...(cause ? { cause } : {}) },
    },
  });

  it('client-state 那步：真实原因随 upstreamLog 回给客户端', async () => {
    const { upstream } = makeUpstream({ clientState: throwsInside() } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(500);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_STATE_FAILED');
    expect(body.error.upstreamLog).toBe('D1_ERROR: no such table: message_outbox');
  });

  it('schedule-message 那步同理', async () => {
    const { upstream } = makeUpstream({ scheduleMessage: throwsInside() } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(500);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_TASK_FAILED');
    expect(body.error.upstreamLog).toBe('D1_ERROR: no such table: message_outbox');
  });

  it('code 不是 message 前缀时两个都带上（光一句 message 看不出是哪类错）', async () => {
    const { upstream } = makeUpstream({
      clientState: throwsInside(500, {
        stage: 'request', name: 'Error', message: '写不进去', code: 'STORAGE_FAILED',
      }),
    } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect((await response.json() as any).error.upstreamLog).toBe('STORAGE_FAILED: 写不进去');
  });

  it('没有 code 时退回 name', async () => {
    const { upstream } = makeUpstream({
      clientState: throwsInside(500, { stage: 'request', name: 'TypeError', message: '炸了' }),
    } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect((await response.json() as any).error.upstreamLog).toBe('TypeError: 炸了');
  });

  // 4xx 是上游自己判出来的业务错，正文里已经写清了原因；再缀一段内部细节只会让人更迷惑。
  it('4xx 不带 upstreamLog：那不是抛出来的异常，正文本身就是原因', async () => {
    const { upstream } = makeUpstream({
      clientState: { status: 400, body: { success: false, error: { code: 'TOO_MANY_STATE_ENTRIES' } } },
    } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.upstreamLog).toBeUndefined();
  });

  it('上游没给 cause 就不带（老 worker 不会多出一截空白）', async () => {
    const { upstream } = makeUpstream({ clientState: throwsInside(500, null) } as any);
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(500);
    expect((await response.json() as any).error.upstreamLog).toBeUndefined();
  });

  /**
   * 回归守卫：拿真因这件事不许再回去改全局 console。
   *
   * 这段历史值得留一句：上游早先不回 cause，只把真因写进自己的 console.error，
   * 于是这里曾经永久 patch 全局 console.error 去偷听。那是会影响整个 isolate 的副作用，
   * 而且和任何并发请求都在抢同一个全局对象。真因现在由上游随响应体给，
   * 谁都不该再动 console。
   */
  it('不碰全局 console.error（真因来自响应体，不是偷听日志）', async () => {
    const original = console.error;
    const { upstream } = makeUpstream({ clientState: throwsInside() } as any);
    await run({ request: post(validBody()), upstream });
    expect(console.error).toBe(original);
  });
});

// D1 偶尔会把一次写直接判超时（`… object to be reset`），而这一步是整条链上最大的一次写
// （三十多 KB 的 fire_pack）。什么时候来没量出规律（2026-08-09 的观测记在 instantChat.ts
// 那段注释里），而客户端只 POST 一次 /instant-chat，它自己那把重试梯子够不着里面这一跳。
describe('POST /instant-chat — 云端状态那一步遇到 5xx 会重试', () => {
  /** 前 n 次回 5xx，之后回正常成功体。 */
  const flakyClientState = (failures: number) => {
    let seen = 0;
    const upstream = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/client-state')) {
          seen += 1;
          if (seen <= failures) {
            return json(500, {
              success: false,
              error: {
                code: 'INTERNAL_ERROR',
                message: '服务器内部错误',
                cause: { stage: 'request', name: 'Error', message: 'D1_ERROR: … object to be reset.' },
              },
            });
          }
          return json(200, { success: true, data: { upserted: 3, skipped: 0 } });
        }
        if (path.endsWith('/schedule-message')) return json(200, { success: true, data: { uuid: TASK_UUID } });
        return json(404, { success: false });
      }),
    };
    return { upstream, attempts: () => seen };
  };

  it('第一次超时、第二次写进去 → 照常受理，用户完全无感', async () => {
    const { upstream, attempts } = flakyClientState(1);
    const response = await run({ request: post(validBody()), upstream: upstream as any });
    expect(response.status).toBe(202);
    expect(attempts()).toBe(2);
  });

  it('梯子走完还是 5xx → 才报失败，且真实原因照样带着', async () => {
    const { upstream, attempts } = flakyClientState(99);
    const response = await run({ request: post(validBody()), upstream: upstream as any });
    expect(response.status).toBe(500);
    expect(attempts()).toBe(3);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_STATE_FAILED');
    expect(body.error.upstreamLog).toContain('object to be reset');
  });

  // 4xx 是上游判出来的业务错（体积超限、时间戳不合法……），重试多少次都是同一个答案，
  // 白等三次还让用户多盯 1.6 秒的「正在输入」。
  it('4xx 不重试，立刻打回', async () => {
    const { upstream, calls } = makeUpstream({
      clientState: { status: 400, body: { success: false, error: { code: 'TOO_MANY_STATE_ENTRIES' } } },
    });
    expect((await run({ request: post(validBody()), upstream })).status).toBe(400);
    expect(calls.filter((c) => c.path.endsWith('/client-state'))).toHaveLength(1);
  });

  it('一次就成的正常轮次只转发一次（别把重试变成常态）', async () => {
    const { upstream, calls } = makeUpstream();
    expect((await run({ request: post(validBody()), upstream })).status).toBe(202);
    expect(calls.filter((c) => c.path.endsWith('/client-state'))).toHaveLength(1);
  });
});

// 凭据行跟任务同一个请求覆盖：客户端那份「传过什么」的底账只代表它自己那个入口，
// 云端那行被别的入口 / 别的 Worker 改过时底账还写着「传过了」，本地切 API 之后云端
// 照样拿别人留下的凭据答话。下面钉住「带了就每轮都覆盖、覆盖不上就不落任务」。
describe('POST /instant-chat — 这一轮的凭据行（credPayload）', () => {
  it('带了就在建任务之前覆盖凭据行，信封原样搬运，202 回 credentialsSynced', async () => {
    const { upstream, calls, paths } = makeUpstream();
    const response = await run({ request: post(validBody({ credPayload: envelope('cred') })), upstream });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'accepted', uuid: TASK_UUID, credentialsSynced: true });
    expect(paths()).toEqual(['PUT /client-state', 'PUT /llm-credentials', 'POST /schedule-message']);
    const cred = calls.find((c) => c.path.endsWith('/llm-credentials'))!;
    expect(JSON.parse(cred.body)).toEqual(envelope('cred'));
    expect(cred.headers['x-payload-encrypted']).toBe('true');
    expect(cred.headers['x-user-id']).toBe(USER_ID);
  });

  it('没带（旧客户端）→ 不多转发，202 也不带 credentialsSynced', async () => {
    const { upstream, paths } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(await response.json()).toEqual({ status: 'accepted', uuid: TASK_UUID });
    expect(paths()).toEqual(['PUT /client-state', 'POST /schedule-message']);
  });

  it('形状不对 → 400，任何转发之前就挡住', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({ request: post(validBody({ credPayload: 'sk-plain' })), upstream });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe('INVALID_CRED_PAYLOAD');
    expect(calls).toHaveLength(0);
  });

  it('凭据写不进去 → 报 llm-credentials 那一步，而且**绝不建任务**', async () => {
    const { upstream, paths } = makeUpstream({
      llmCredentials: { status: 400, body: { success: false, error: { code: 'INVALID_CREDENTIAL' } } },
    });
    const response = await run({ request: post(validBody({ credPayload: envelope('cred') })), upstream });
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_CREDENTIALS_FAILED');
    expect(body.error.step).toBe('llm-credentials');
    expect(paths()).toEqual(['PUT /client-state', 'PUT /llm-credentials']);
  });

  it('200 包着 success:false 也算失败，不建任务', async () => {
    const { upstream, paths } = makeUpstream({
      llmCredentials: { status: 200, body: { success: false, error: { code: 'STORAGE_FAILED' } } },
    });
    const response = await run({ request: post(validBody({ credPayload: envelope('cred') })), upstream });
    expect(response.status).toBe(502);
    expect((await response.json() as any).error.code).toBe('INSTANT_CHAT_CREDENTIALS_FAILED');
    expect(paths()).not.toContain('POST /schedule-message');
  });

  it('5xx 跟云端状态那步一样按梯子重试', async () => {
    let seen = 0;
    const upstream = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/client-state')) return json(200, { success: true, data: {} });
        if (path.endsWith('/llm-credentials')) {
          seen += 1;
          return seen === 1
            ? json(500, { success: false, error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } })
            : json(200, { success: true, data: { upserted: 1 } });
        }
        if (path.endsWith('/schedule-message')) return json(200, { success: true, data: { uuid: TASK_UUID } });
        return json(404, { success: false });
      }),
    };
    const response = await run({ request: post(validBody({ credPayload: envelope('cred') })), upstream: upstream as any });
    expect(response.status).toBe(202);
    expect(seen).toBe(2);
  });
});

describe('POST /instant-chat — 只有两次内部转发', () => {
  // 顶替上一条不再是包装层的事：supersedesUuid 在加密的任务体里，
  // 上游建新任务的同一事务里取消旧的。包装层多发一条 DELETE 才是回归。
  it('状态在前、建任务在后，没有第三个请求', async () => {
    const { upstream, paths } = makeUpstream();
    await run({ request: post(validBody()), upstream });
    expect(paths()).toEqual(['PUT /client-state', 'POST /schedule-message']);
  });
});

describe('POST /instant-chat — 立即起跳', () => {
  /**
   * 实例名就是任务 uuid：一条任务一个 DO 实例，几条聊天同时在跑才不会互相排队。
   * DO 的 alarm 是一实例一个，共用实例就意味着共用那一个 alarm、只能挨个来。
   */
  it('回完 202 之前叫醒 DO，实例名和 uuid 都是这条任务的', async () => {
    const { upstream } = makeUpstream();
    const tick = makeTick();
    const response = await run({ request: post(validBody()), upstream, tick });

    expect(response.status).toBe(202);
    expect(tick.kicks).toEqual([{ instance: TASK_UUID, uuid: TASK_UUID }]);
  });

  /**
   * 回归守卫：这一跳绝不能再挂回 ctx.waitUntil。
   *
   * waitUntil 的墙钟上限是硬性的 30 秒（从响应发出或客户端断开起算），而一轮带工具
   * 循环的生成动辄几十秒——挂上去就必被砍在半路，日志里只留一条
   * 「waitUntil() tasks did not complete」，用户那边表现为「一直等不到回复」。
   * 生成必须跑在 DO 的 alarm 里（独立 invocation，15 分钟），所以受理这一步只该叫醒
   * DO：`InstantChatUpstream` 只声明了 fetch，压根没有能把生成拉进当前请求的入口。
   */
  it('受理时只发两个转发请求，不碰任何执行入口', async () => {
    const { upstream, paths } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(202);
    expect(paths()).toEqual(['PUT /client-state', 'POST /schedule-message']);
  });

  it('叫醒失败不影响已经回出去的 202（任务已落库，cron 每分钟还会来捡）', async () => {
    const { upstream } = makeUpstream();
    const tick = makeTick({ kick: () => Promise.reject(new Error('kick boom')) });
    const response = await run({ request: post(validBody()), upstream, tick });
    expect(response.status).toBe(202);
  });

  /**
   * 回归守卫：老版本 Worker（没有 INSTANT_TICK 绑定）必须明说「去更新」。
   *
   * 这里刻意不退回 cron 兜底然后照回 202：那条路上没有为即时对话放宽的超时，用户会
   * 对着「正在输入」等很久甚至等不到，而界面上没有任何线索告诉他该做什么。
   */
  it('没有 INSTANT_TICK 绑定 → 503 且点名要更新 Worker', async () => {
    const { upstream } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream, tick: null });

    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_WORKER_OUTDATED');
    expect(body.error.message).toContain('更新 Worker');
    // 任务本身是建成了的，uuid 要带回去，别让客户端以为整轮没发生过。
    expect(body.error.uuid).toBe(TASK_UUID);
  });
});

describe('isInstantChatTask', () => {
  it('只认显式为 true 的那个标记', () => {
    expect(isInstantChatTask({ amsgInstantChat: true })).toBe(true);
    expect(isInstantChatTask({ amsgInstantChat: 'true' })).toBe(false);
    expect(isInstantChatTask({ charId: 'c' })).toBe(false);
    expect(isInstantChatTask(undefined)).toBe(false);
  });
});

describe('buildInstantTimelyBlock', () => {
  const base = {
    nowMs: Date.UTC(2026, 7, 1, 0, 0),
    tz: { tzId: 'Asia/Shanghai' },
    userTzId: 'Asia/Shanghai',
    targetName: '小明',
    timeAwarenessEnabled: true,
  };

  it('写清「现在几点」，用的是角色自己的时区', () => {
    const block = buildInstantTimelyBlock({ ...base, blocks: [] });
    expect(block).toContain('2026年8月1日 周六 早晨 08:00');
  });

  // 报时后面必须跟那句语境框定，而且跟前台聊天用的是同一份常量。少了它，深夜的那行钟
  // 就够让角色每轮往「快睡吧、明天见」上收——本地聊天治好了、云端没治的话，同一个角色
  // 走两条路的分寸不一样，而即时对话恰恰是主路径。
  it('报时后面跟着语境框定，跟前台聊天同一份常量', () => {
    const block = buildInstantTimelyBlock({ ...base, blocks: [] });
    expect(block).toContain(TIME_FRAMING_CONVERSATIONAL);
    // 顺序也钉住：框定必须紧跟在钟点后面（贴在注意力最强的位置才起作用）。
    expect(block.indexOf('现在是')).toBeLessThan(block.indexOf(TIME_FRAMING_CONVERSATIONAL));
  });

  it('关了时间感知时框定也一起消失（没有钟就没有要框的东西）', () => {
    const block = buildInstantTimelyBlock({
      ...base, timeAwarenessEnabled: false, blocks: ['\n\n【热搜】\n- 某某'],
    });
    expect(block).not.toContain(TIME_FRAMING_CONVERSATIONAL);
  });

  it('有时差时补一行「对方那边几点」，同时区不补（一份提示词里两个钟会打架）', () => {
    expect(buildInstantTimelyBlock({ ...base, userTzId: 'America/New_York', blocks: [] }))
      .toContain('对方所在时区参考');
    expect(buildInstantTimelyBlock({ ...base, blocks: [] })).not.toContain('对方所在时区参考');
  });

  // 关了时间感知的架空角色在前台连今天几号都读不到，云端这条路也不能偷偷报时。
  // 一个开关两套行为的话，同一个角色在聊天里说不出日期、在即时对话里却精确到分钟。
  it('关了时间感知就一个钟都不给（其余块照常拼）', () => {
    const block = buildInstantTimelyBlock({
      ...base,
      userTzId: 'America/New_York',
      timeAwarenessEnabled: false,
      blocks: ['\n\n【热搜】\n- 某某'],
    });
    expect(block).not.toContain('现在是');
    expect(block).not.toContain('2026年8月1日');
    expect(block).not.toContain('对方所在时区参考');
    expect(block).toContain('【此刻的系统信息·仅你可见】');
    expect(block).toContain('【热搜】');
  });

  // 时间感知关着、其余几块又都是空的：这一块没有任何内容可说，整块都不该有。
  // 留一行光秃秃的标题挂在对话末尾，模型只会当成没说完的乱码。
  it('没时间也没别的可说 → 整块返回空串（调用方据此一条都不追加）', () => {
    expect(buildInstantTimelyBlock({
      ...base, timeAwarenessEnabled: false, blocks: ['', '  ', '\n\n'],
    })).toBe('');
    // 时间感知开着时不受影响：报时本身就是内容
    expect(buildInstantTimelyBlock({ ...base, blocks: [] })).toContain('现在是');
  });

  it('空块整块跳过（拉不到实时世界时不能留一行空标题）', () => {
    const block = buildInstantTimelyBlock({ ...base, blocks: ['', '  ', '\n\n【热搜】\n- 某某'] });
    expect(block).toContain('【热搜】');
    expect(block.split('\n').filter((l) => l.trim() === '【】')).toHaveLength(0);
    expect(block.endsWith('- 某某')).toBe(true);
  });
});

describe('applyInstantNotificationPolicy', () => {
  // 订阅是按 userVisibleOnly 建的：推了却不弹，Firefox 按配额退订、iOS 过了宽限期直接
  // 吊销，两边都静默发生。所以即时对话这条必推的路只能标 always，打扰交给折叠 + 静音压。
  // 回到 when-hidden（或任何「有时候不弹」的档）就是把订阅重新押上去，这条守着别退回去。
  it('标 always + 按角色折叠：推了就一定弹，不靠不弹来防打扰', () => {
    const push = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: '来自 Nyah', body: 'hi' } }, 'char-1', true);
    expect(push.notification).toEqual({
      title: '来自 Nyah', body: 'hi', show: 'always',
      silent: 'when-visible', tag: 'amsg-instant-char-1', renotify: true,
    });
  });

  // 静不静音是 SW 收到这条时按窗口可见性算的。写死 true 的话，切后台、锁屏收到回复
  // 也不响——worker 发推那一刻并不知道用户在不在前台，这个判定只能推迟到 SW 去做。
  it('静音标成 when-visible，不写死 true（写死了切后台也不响）', () => {
    const push = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: 't' } }, 'char-1');
    expect((push.notification as any).silent).toBe('when-visible');
  });

  it('没显式传 charId 就从 metadata 上认', () => {
    const push = applyInstantNotificationPolicy(
      { message: 'hi', metadata: { charId: 'char-2' }, notification: { title: 't' } });
    expect((push.notification as any).tag).toBe('amsg-instant-char-2');
  });

  // 折叠是为了不刷屏，但两个角色共用一个 tag 会互相顶掉——那是真丢消息，宁可多几条。
  it('认不出角色就不折叠（tag 留空，交给库按 messageId 兜底）', () => {
    const push = applyInstantNotificationPolicy({ message: 'hi', notification: { title: 't' } });
    expect(push.notification).toEqual({ title: 't', show: 'always', silent: 'when-visible' });
  });

  it('载荷本来没有 notification 就不凭空造一个（造出来只会弹一条空白横幅）', () => {
    const push = applyInstantNotificationPolicy({ message: 'hi' });
    expect(push).not.toHaveProperty('notification');
    // 形状不对的也当没有，别把它塞进一个对象里
    expect(applyInstantNotificationPolicy({ message: 'hi', notification: null }).notification).toBeNull();
  });

  // 信封的其余部分（messageId / sessionId / 段号 / 任务身份）全交给库去补。这里多写一份
  // 就是多一处会跟库漂掉的副本，而账本里存的本来就是库发出去的那一份。
  // 同 tag 的通知默认是静默替换。上一轮的横幅还躺在通知栏没点掉时，新一轮的第一段
  // 不带 renotify 就会被当成替换、不出声——用户那句「有时候响有时候不响」就是这么来的。
  it('每一轮的第一段带 renotify，后面几段不带（一轮只响一声）', () => {
    const first = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: 't' } }, 'char-1', true);
    expect((first.notification as any).renotify).toBe(true);

    const rest = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: 't' } }, 'char-1', false);
    expect(rest.notification).not.toHaveProperty('renotify');
  });

  // renotify 为 true 而 tag 是空串时 showNotification 直接抛 TypeError，那一条就
  // 一个字都弹不出来。认不出角色时不折叠 = 没有 tag，这时哪怕是第一段也不能带。
  it('没有 tag 就绝不带 renotify（带了 showNotification 会抛 TypeError）', () => {
    const push = applyInstantNotificationPolicy(
      { message: 'hi', notification: { title: 't' } }, null, true);
    expect(push.notification).not.toHaveProperty('tag');
    expect(push.notification).not.toHaveProperty('renotify');
  });

  it('除通知策略外一个字段都不添（正文 / metadata 原样保留）', () => {
    const push = applyInstantNotificationPolicy({ message: 'hi', metadata: { directives: [1] } });
    expect(push).toEqual({ message: 'hi', metadata: { directives: [1] } });
  });
});

it('large chat input stays out of the task row and is preserved in its unique state record', async () => {
  const { upstream, calls } = makeUpstream();
  const content = 'x'.repeat(1_200_000);
  const pack = { ...INPUT_PACK, chat: { builtAt: INPUT_PACK.builtAt, messages: [{ role: 'user', content }] } };
  const response = await run({ request: post(validBody({ statePayload: envelope('state', { entries: [
    { namespace: 'amsg:char:c1', key: 'fire_pack', value: JSON.stringify(pack), updatedAt: pack.builtAt },
  ] }) })), upstream });
  expect(response.status).toBe(202);
  const task = await readForwarded(calls.find(call => call.path.endsWith('/schedule-message'))!);
  expect(new TextEncoder().encode(JSON.stringify(task)).length).toBeLessThan(10_000);
  const state = await readForwarded(calls.find(call => call.path.endsWith('/client-state'))!);
  const ref = task.taskInput.firePackRef;
  const row = state.entries.find((entry: any) => entry.namespace === ref.namespace && entry.key === ref.key);
  expect(JSON.parse(JSON.parse(row.value).packedFirePack).chat.messages[0].content).toBe(content);
});

it('a 200 partial rejection of the immutable input never creates a task', async () => {
  const { upstream, calls } = makeUpstream();
  upstream.fetch.mockImplementationOnce(async (request: Request) => {
    const payload = await decryptPayload(await request.json() as any, USER_KEY);
    const input = payload.entries.find((entry: any) => entry.namespace === 'amsg:instant-input');
    return json(200, { success: true, data: { upserted: 1, skipped: 0,
      rejected: [{ namespace: input.namespace, key: input.key, reason: 'value_too_large' }],
    } });
  });
  const response = await run({ request: post(validBody({ credPayload: envelope('creds') })), upstream });
  expect(response.status).toBe(409);
  expect((await response.json() as any).error.code).toBe('INSTANT_CHAT_STATE_FAILED');
  expect(calls).toHaveLength(0);
});

it('a 200 failure body cannot advance to credentials or task creation', async () => {
  const { upstream, calls } = makeUpstream({ clientState: { status: 200, body: { success: false, error: { message: 'write failed' } } } });
  const response = await run({ request: post(validBody()), upstream });
  expect(response.status).toBe(502);
  expect(calls.map(call => call.path)).toEqual(['/client-state']);
});

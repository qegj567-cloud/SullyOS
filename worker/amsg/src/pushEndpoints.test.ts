// 回归守卫：原生 FCM 和第三方推送 App 登记的是自定义前缀的推送地址（fcm:…、bark:https://…），
// 只有本 worker 注入的推送通道认得。上游 amsg-server 一旦把这类地址当成不合格拒收，
// 这些用户就登记不上订阅、一条主动消息都收不到，而单测里用的 https 地址照样能过，不会有人察觉。
// 升级 amsg-server 时这里会先挂。
import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { ReiClient } from '@rei-standard/amsg-client';
import { createD1Adapter } from '@rei-standard/amsg-server/cloudflare';
import worker from './index';
import { buildThirdPartyPushEndpoint } from '../../../utils/amsgThirdPartyPush';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');
const baseUrl = 'https://amsg-push-endpoints.test';
const serverToken = 'push-endpoints-token';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const createSqliteD1 = () => {
  const db = new DatabaseSync(':memory:');
  const statement = (sql: string, params: unknown[] = []): any => ({
    bind: (...values: unknown[]) => statement(sql, values.map(v => v === undefined ? null : v)),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: any[]) => {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  };
};

it('worker 收下原生 FCM 与第三方推送 App 的自定义推送地址', async () => {
  const d1 = createSqliteD1();
  await createD1Adapter(d1 as any).initSchema();
  const vapid = require_('web-push').generateVAPIDKeys();
  const env: any = {
    AMSG_MASTER_KEY: 'b'.repeat(64), AMSG_SERVER_TOKEN: serverToken,
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
    DB: d1, INSTANT_TICK: { idFromName: (name: string) => name, get: () => ({ kick: vi.fn(async () => {}) }) },
  };
  const executionCtx = { waitUntil: (_promise: Promise<unknown>) => {} };
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.startsWith(baseUrl)) throw new Error(`Unexpected external request: ${request.url}`);
    return (worker as any).fetch(request, env, executionCtx);
  });

  const userId = crypto.randomUUID();
  const headers = { 'X-Client-Token': serverToken, 'X-User-Id': userId, 'Content-Type': 'application/json' };
  expect((await fetch(`${baseUrl}/init-tenant`, { method: 'POST', headers })).ok).toBe(true);
  const client = new ReiClient({ baseUrl, userId, serverToken });
  await client.init();

  const endpoints = [
    // 与 ActiveMsgClient.registerNativePushToken 登记的格式一致。
    'fcm:dGVzdC10b2tlbg:APA91b-native_token',
    buildThirdPartyPushEndpoint({ provider: 'wxpusher', token: 'SPT_pushEndpointsTest' }),
    buildThirdPartyPushEndpoint({ provider: 'bark', token: 'barkDeviceKey' }),
    buildThirdPartyPushEndpoint({ provider: 'bark', token: 'barkDeviceKey', serverUrl: 'https://bark.example.com:8443' }),
    buildThirdPartyPushEndpoint({ provider: 'meow', token: 'meowNick' }),
  ];
  for (const endpoint of endpoints) {
    const response: any = await client.putPushSubscription({ endpoint });
    expect(response?.success, `${endpoint} 被拒：${JSON.stringify(response?.error)}`).toBe(true);
  }
});

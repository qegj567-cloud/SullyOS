/** Audit reproduction with the installed SDK, encrypted state, and a real SQLite database. */
import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import nodeCrypto from 'node:crypto';
import { ReiClient } from '@rei-standard/amsg-client';
import { deriveUserEncryptionKey, decryptFromStorage } from '@rei-standard/amsg-server';
import { createD1Adapter } from '@rei-standard/amsg-server/cloudflare';
import worker, { amsgHooks } from './index';
import { handleInstantChat } from './instantChat';
import { INSTANT_INPUT_NAMESPACE } from './instantInput';
import { AMSG_FIRE_PACK_KEY, FIRE_PACK_VERSION, amsgStateNamespace, packStateValue, unpackStateValue } from '../../../utils/amsgFirePack';
import { AMSG_TOOL_PACK_KEY, AMSG_TOOL_CONFIG_KEY, AMSG_GLOBAL_NAMESPACE, buildToolPack, buildToolConfig } from '../../../utils/amsgToolPack';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');
const baseUrl = 'https://amsg-audit.test';
const charId = 'audit-instant-char';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('real SDK and SQLite reproduce replacement corruption and silent tool-config rejection', async () => {
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
  const d1: any = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: any[]) => {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  };
  await createD1Adapter(d1).initSchema();
  const vapid = require_('web-push').generateVAPIDKeys();
  const env: any = {
    AMSG_MASTER_KEY: 'a'.repeat(64), AMSG_SERVER_TOKEN: 'audit-token',
    VAPID_EMAIL: 'mailto:audit@example.com', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
    DB: d1, INSTANT_TICK: { idFromName: (name: string) => name, get: () => ({ kick: vi.fn(async () => {}) }) },
  };
  const executionCtx = { waitUntil: (_promise: Promise<unknown>) => {} };
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.startsWith(baseUrl)) throw new Error(`Unexpected external request: ${request.url}`);
    return (worker as any).fetch(request, env, executionCtx);
  });
  const userId = crypto.randomUUID();
  const client = new ReiClient({ baseUrl, userId, serverToken: 'audit-token' });
  const headers = { 'X-Client-Token': 'audit-token', 'X-User-Id': userId, 'Content-Type': 'application/json' };
  expect((await fetch(`${baseUrl}/init-tenant`, { method: 'POST', headers })).ok).toBe(true);
  await client.init();
  const receiver = nodeCrypto.createECDH('prime256v1');
  receiver.generateKeys();
  await client.putPushSubscription({ endpoint: 'https://push.test/audit', keys: {
    p256dh: receiver.getPublicKey().toString('base64url'), auth: nodeCrypto.randomBytes(16).toString('base64url'),
  } });
  let stamp = Date.now();
  const credentials = [{ credId: `char:${charId}/instant`, value: {
    apiUrl: 'https://llm.test/v1/chat/completions', apiKey: 'sk-audit', primaryModel: 'audit-model',
  } }];
  const send = async (text: string, supersedesUuid?: string, failCredentials = false) => {
    stamp += 1;
    const pack = {
      v: FIRE_PACK_VERSION, template: '角色的主动消息模板', builtAt: stamp,
      lastUserMessageAt: stamp, tzId: 'Asia/Tokyo', userTzId: 'Asia/Tokyo', targetName: '用户',
      pendingTasks: [], scene: null, selfScheduleEnabled: false,
      chat: { builtAt: stamp, messages: [{ role: 'user', content: text }] },
    };
    const task = {
      contactName: '角色', messageType: 'auto', messageSubtype: 'instant-chat', immediate: true,
      recurrenceType: 'none', tzId: 'Asia/Tokyo', messages: [{ role: 'user', content: 'placeholder' }],
      credRefs: { chat: credentials[0].credId },
      ...(supersedesUuid ? { supersedesUuid } : {}),
      metadata: { charId, amsgMode: 'instant', amsgInstantChat: true, amsgClientTaskId: crypto.randomUUID() },
    };
    const entries = [
      { namespace: amsgStateNamespace(charId), key: AMSG_FIRE_PACK_KEY, value: await packStateValue(JSON.stringify(pack)), updatedAt: stamp },
      { namespace: amsgStateNamespace(charId), key: AMSG_TOOL_PACK_KEY,
        value: JSON.stringify(buildToolPack({ id: charId, name: '角色' } as any)), updatedAt: stamp },
      { namespace: AMSG_GLOBAL_NAMESPACE, key: AMSG_TOOL_CONFIG_KEY,
        value: JSON.stringify(buildToolConfig(undefined)), updatedAt: stamp },
    ];
    const body = {
      statePayload: await (client as any)._encrypt(JSON.stringify({ entries })),
      taskPayload: await (client as any)._encrypt(JSON.stringify(task)),
      credPayload: await (client as any)._encrypt(JSON.stringify({ credentials })),
    };
    const response = await handleInstantChat({
      request: new Request(`${baseUrl}/instant-chat`, { method: 'POST', headers, body: JSON.stringify(body) }),
      env, stateBackoffMs: [0],
      upstream: { fetch: async (request: Request) => {
        if (failCredentials && new URL(request.url).pathname === '/llm-credentials') {
          return Response.json({ success: false, error: { message: 'simulated D1 unavailable' } }, { status: 503 });
        }
        return (worker as any).fetch(request, env, executionCtx);
      } } as any,
      json: (status: number, data: unknown) => Response.json(data, { status }),
    });
    return { status: response.status, body: await response.json() as any, task };
  };
  try {
    const first = await send('FIRST_ACCEPTED_USER_MESSAGE');
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const second = await send('SECOND_REJECTED_USER_MESSAGE', first.body.uuid, true);
    expect(second.status).toBe(503);
    expect(second.body.error.code).toBe('INSTANT_CHAT_CREDENTIALS_FAILED');
    const oldRow = db.prepare('SELECT * FROM scheduled_messages WHERE uuid = ?').get(first.body.uuid);
    expect(oldRow.status).toBe('pending');
    const response: any = await client.getClientState(amsgStateNamespace(charId));
    const rows = response.data.entries;
    const packRow = rows.find((row: any) => row.key === AMSG_FIRE_PACK_KEY);
    const storedPack = packRow ? JSON.parse(packRow.value) : null;
    const acceptedPayload = JSON.parse(await decryptFromStorage(oldRow.encrypted_payload, await deriveUserEncryptionKey(userId, env.AMSG_MASTER_KEY)));
    expect(acceptedPayload.taskInput?.firePack).toBeUndefined();
    expect(acceptedPayload.taskInput?.firePackRef?.namespace).toBe(INSTANT_INPUT_NAMESPACE);
    expect(storedPack?.chat?.messages[0]?.content).not.toBe('SECOND_REJECTED_USER_MESSAGE');
    const ctx: any = {
      task: { id: oldRow.id, uuid: first.body.uuid, nextSendAt: oldRow.next_send_at, recurrenceType: 'none', metadata: first.task.metadata, taskInput: acceptedPayload.taskInput },
      userId, now: new Date(), scratch: {},
      readState: async (namespace: string, options?: { key: string }) => (await client.getClientState(namespace, options)).data?.entries ?? [],
      writeState: async (namespace: string, entries: any[]) => (await client.putClientState(entries.map(entry => ({ namespace, ...entry })))).data,
    };
    const plan: any = await amsgHooks.onBeforeFire(ctx);
    expect(JSON.stringify(plan.messages)).not.toContain('SECOND_REJECTED_USER_MESSAGE');
    expect(JSON.stringify(plan.messages)).toContain('FIRST_ACCEPTED_USER_MESSAGE');

    // 不可压缩的图片量级输入超过任务行上限，但仍在既有 2 MiB 对话预算内。
    const largeContent = nodeCrypto.randomBytes(1_100_000).toString('base64');
    const large = await send(largeContent);
    expect(large.status, JSON.stringify(large.body)).toBe(202);
    const largeRow = db.prepare('SELECT * FROM scheduled_messages WHERE uuid = ?').get(large.body.uuid);
    const largePayload = JSON.parse(await decryptFromStorage(largeRow.encrypted_payload,
      await deriveUserEncryptionKey(userId, env.AMSG_MASTER_KEY)));
    expect(new TextEncoder().encode(JSON.stringify(largePayload)).length).toBeLessThan(10_000);
    const largePlan: any = await amsgHooks.onBeforeFire({ ...ctx, scratch: {}, task: {
      ...ctx.task, uuid: large.body.uuid, metadata: large.task.metadata, taskInput: largePayload.taskInput,
    } });
    expect(largePlan.messages.some((message: any) => message.content === largeContent)).toBe(true);

    // 新任务先执行再执行旧任务，每轮仍拿自己的输入，旧输入不能回盖共享定时上下文。
    const fresh = await send('LATEST_ACCEPTED_USER_MESSAGE');
    expect(fresh.status).toBe(202);
    const freshRow = db.prepare('SELECT * FROM scheduled_messages WHERE uuid = ?').get(fresh.body.uuid);
    const freshPayload = JSON.parse(await decryptFromStorage(freshRow.encrypted_payload,
      await deriveUserEncryptionKey(userId, env.AMSG_MASTER_KEY)));
    const freshPlan: any = await amsgHooks.onBeforeFire({ ...ctx, scratch: {}, task: {
      ...ctx.task, uuid: fresh.body.uuid, metadata: fresh.task.metadata, taskInput: freshPayload.taskInput,
    } });
    expect(JSON.stringify(freshPlan.messages)).toContain('LATEST_ACCEPTED_USER_MESSAGE');
    const lateOldPlan: any = await amsgHooks.onBeforeFire({ ...ctx, scratch: {} });
    expect(JSON.stringify(lateOldPlan.messages)).toContain('FIRST_ACCEPTED_USER_MESSAGE');
    expect(JSON.stringify(lateOldPlan.messages)).not.toContain('LATEST_ACCEPTED_USER_MESSAGE');
    const afterReverse = await client.getClientState(amsgStateNamespace(charId));
    const afterReversePack = JSON.parse(await unpackStateValue(afterReverse.data!.entries.find((row: any) => row.key === AMSG_FIRE_PACK_KEY)!.value));
    expect(afterReversePack.builtAt).toBe(stamp);

    // The server has a current config; this browser's clock is ten seconds behind.
    // Only the browser's stamp is stubbed, leaving the server's clock unchanged.
    const serverStamp = Date.now();
    const serverConfig = buildToolConfig({ newsEnabled: true } as any);
    await client.putClientState([{ namespace: AMSG_GLOBAL_NAMESPACE, key: AMSG_TOOL_CONFIG_KEY,
      value: JSON.stringify(serverConfig), updatedAt: serverStamp }]);
    const { ActiveMsgStore } = await import('../../../utils/activeMsgStore');
    const { ActiveMsgClient } = await import('../../../utils/activeMsgClient');
    const stateClock = await import('../../../utils/amsgStateClock');
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: baseUrl, userId, serverToken: 'audit-token' });
    // 客户端通过真实加密接口定点取附件；重复读取不删，引用换任务/发生时刻不匹配即拒绝。
    const attachmentRef = { version: 1 as const, namespace: 'amsg:attachments', key: crypto.randomUUID(),
      taskUuid: first.body.uuid, occurrenceMs: Date.now(), expiresAt: Date.now() + 86_400_000 };
    await client.putClientState([{ namespace: attachmentRef.namespace, key: attachmentRef.key,
      value: JSON.stringify({ ...attachmentRef, owner: { type: 'character', id: charId }, kind: 'sidechannel', value: 'EXACT_ATTACHMENT_CONTENT' }),
      updatedAt: Date.now(), owner: { type: 'character', id: charId }, kind: 'sidechannel',
    }]);
    expect(await ActiveMsgClient.readAttachment(attachmentRef)).toBe('EXACT_ATTACHMENT_CONTENT');
    expect(await ActiveMsgClient.readAttachment(attachmentRef)).toBe('EXACT_ATTACHMENT_CONTENT');
    expect(await ActiveMsgClient.readAttachment({ ...attachmentRef, taskUuid: crypto.randomUUID() })).toBeNull();
    expect(await ActiveMsgClient.readAttachment({ ...attachmentRef, occurrenceMs: attachmentRef.occurrenceMs + 1 })).toBeNull();
    stateClock.resetStateClock();
    vi.spyOn(stateClock, 'stampStateUpdatedAt').mockReturnValue(serverStamp - 10_000);
    await expect(ActiveMsgClient.syncToolConfig({ newsEnabled: false } as any)).rejects.toMatchObject({ code: 'TOOL_CONFIG_CONFLICT' });
    const afterSync = await client.getClientState(AMSG_GLOBAL_NAMESPACE);
    const globalRow = afterSync.data!.entries.find((entry: { key: string }) => entry.key === AMSG_TOOL_CONFIG_KEY)!;
    expect(globalRow.updatedAt).toBe(serverStamp);
    expect(JSON.parse(globalRow.value).newsEnabled).toBe(true);
    expect(stateClock.readStateClockWatermark()).toBeGreaterThanOrEqual(serverStamp);
    // A retry with the original stale version must not overwrite another device.
    await expect(ActiveMsgClient.syncToolConfig({ newsEnabled: false } as any)).rejects.toMatchObject({ code: 'TOOL_CONFIG_CONFLICT' });
    const retry = await client.getClientState(AMSG_GLOBAL_NAMESPACE);
    expect(JSON.parse(retry.data!.entries.find((entry: { key: string }) => entry.key === AMSG_TOOL_CONFIG_KEY)!.value).newsEnabled).toBe(true);
    await Promise.all([ActiveMsgClient.probeInstantChatSupport(), ActiveMsgClient.probeWorkerFeatures()]);
  } finally { db.close(); }
}, 20_000);

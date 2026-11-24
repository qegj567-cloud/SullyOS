// 救援模式的回归守卫（设计见 docs/amsg2-rescue.md）。钉住的几件事：
//   - 没设 AMSG_RESCUE_TOKEN 时 /rescue 不存在；口令太短时不工作；
//   - 首次发现开关会开一段留痕并推送给所有设备，推送排在任何导出之前；
//   - 口令错误、导出、读数据都记账，错太多会锁；
//   - 导出能把分块存的大值、SullyOS 的 gzip 包装、加密的凭据原样还原；
//   - 关掉后 cron 记下结束时刻，再开是新的一段（前端据此重新弹窗）；
//   - 开着时 cron 不投递。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { ReiClient } from '@rei-standard/amsg-client';
import { createD1Adapter } from '@rei-standard/amsg-server/cloudflare';
import worker from './index';
import { buildThirdPartyPushEndpoint } from '../../../utils/amsgThirdPartyPush';
import { packStateValue } from '../../../utils/amsgFirePack';
import {
  AMSG_RESCUE_ALERT_WINDOW_MS,
  AMSG_RESCUE_RESULT_KIND,
  isRescueAlertDue,
  parseAmsgRescueReport,
  rescueAlertAckKey,
} from '../../../utils/amsgRescueState';
import { RESCUE_LOCKOUT_FAILURES, RESCUE_LOCKOUT_WINDOW_MS, rescueLockoutRemainingMs } from './rescue';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite');
const baseUrl = 'https://amsg-rescue.test';
const serverToken = 'rescue-test-server-token';
const rescueToken = 'correct-horse-battery-staple-42';

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

/** 起一台带数据的 Worker：一个用户、一份推送订阅、几条云端状态、一份凭据。 */
const setup = async () => {
  const d1 = createSqliteD1();
  await createD1Adapter(d1 as any).initSchema();
  const vapid = require_('web-push').generateVAPIDKeys();
  const env: any = {
    AMSG_MASTER_KEY: 'c'.repeat(64), AMSG_SERVER_TOKEN: serverToken,
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
    DB: d1, INSTANT_TICK: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
  };
  const executionCtx = { waitUntil: (_promise: Promise<unknown>) => {} };
  const externalRequests: Request[] = [];
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.startsWith(baseUrl)) return (worker as any).fetch(request, env, executionCtx);
    // 推送服务（这里是 Bark）：记下来，回成功。
    externalRequests.push(request);
    return new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const userId = crypto.randomUUID();
  const headers = { 'X-Client-Token': serverToken, 'X-User-Id': userId, 'Content-Type': 'application/json' };
  expect((await fetch(`${baseUrl}/init-tenant`, { method: 'POST', headers })).ok).toBe(true);
  const client = new ReiClient({ baseUrl, userId, serverToken });
  await client.init();
  expect((await client.putPushSubscription({ endpoint: buildThirdPartyPushEndpoint({ provider: 'bark', token: 'rescueBarkKey' }) }))?.success).toBe(true);

  const firePack = { v: 7, template: '你是测试角色。\n'.repeat(20), builtAt: 1_700_000_000_000, chat: { messages: [{ role: 'user', content: '早上好' }], builtAt: 1 } };
  const toolPack = { v: 1, charName: '测试角色', memories: [{ date: '2026-10-03', summary: '一起看了海', mood: 'happy' }] };
  const bigValue = JSON.stringify({ blob: '大'.repeat(120_000) }); // > 200 KB UTF-8，上游会分块存
  // 即时对话那一轮的快照：fire_pack 在值里又单独压了一层。
  const instantPack = { v: 7, template: '即时快照', builtAt: 2, chat: { messages: [{ role: 'user', content: '在吗' }], builtAt: 2 } };
  const instantInput = { v: 1, charId: 'c1', packedFirePack: await packStateValue(JSON.stringify(instantPack)) };
  const now = Date.now();
  const put = await client.putClientState([
    { namespace: 'amsg:char:c1', key: 'fire_pack', value: await packStateValue(JSON.stringify(firePack)), updatedAt: now },
    { namespace: 'amsg:char:c1', key: 'tool_pack', value: JSON.stringify(toolPack), updatedAt: now },
    { namespace: 'amsg:char:c2', key: 'fire_pack', value: bigValue, updatedAt: now },
    { namespace: 'amsg:instant-input', key: 'turn-1', value: JSON.stringify(instantInput), updatedAt: now },
  ]);
  expect(put?.success, JSON.stringify(put?.error)).toBe(true);
  const creds = await client.putLlmCredentials([
    { credId: 'char:c1/chat', value: { apiUrl: 'https://api.example.com/v1', apiKey: 'sk-rescue-test-key', primaryModel: 'model-x' } },
  ]);
  expect(creds?.success, JSON.stringify(creds?.error)).toBe(true);

  return { env, d1, userId, externalRequests, firePack, toolPack, bigValue, instantPack };
};

const configCheck = async () => {
  const body: any = await (await fetch(`${baseUrl}/config-check`)).json();
  return parseAmsgRescueReport(body?.data?.rescue);
};

const rescueCall = (path: string, token: string | null, body?: unknown) =>
  fetch(`${baseUrl}/rescue/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Rescue-Token': token } : {}) },
    body: JSON.stringify(body ?? {}),
  });

describe('救援模式', () => {
  it('没设口令时 /rescue 不存在，config-check 报「关着、没有记录」', async () => {
    await setup();
    expect((await fetch(`${baseUrl}/rescue`)).status).toBe(404);
    expect((await rescueCall('manifest', rescueToken)).status).toBe(404);
    expect(await configCheck()).toEqual({ active: false, episode: null });
  });

  it('开启 → 推送 → 口令错误记账 → 导出还原全部数据 → 关闭 → 再开是新的一段', async () => {
    const { env, externalRequests, firePack, toolPack, bigValue, userId, instantPack } = await setup();
    env.AMSG_RESCUE_TOKEN = rescueToken;

    // 打开救援页就算「发现开关」：开一段新留痕，并推给登记过的设备。
    const page = await fetch(`${baseUrl}/rescue`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(page.headers.get('Access-Control-Allow-Origin')).toBeNull();
    // 页面脚本写在模板字符串里，转义写错会让整页白屏：至少要能被解析。
    const html = await page.text();
    const script = /<script nonce="[0-9a-f]+">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script).toContain('/manifest');
    expect(() => new Function(script)).not.toThrow();
    const pushes = externalRequests.filter((request) => request.url.includes('day.app') || request.url.includes('bark'));
    expect(pushes.length).toBe(1);
    expect(await pushes[0].clone().text()).toContain('救援模式');

    let report = await configCheck();
    expect(report?.active).toBe(true);
    const firstEpisode = report!.episode!;
    expect(firstEpisode).toMatchObject({ endedAt: null, pushTargets: 1, pushDelivered: 1, exportCount: 0 });
    expect(firstEpisode.pushedAt).not.toBeNull();

    // 口令错误：拒绝并记账。
    expect((await rescueCall('manifest', null)).status).toBe(401);
    expect((await rescueCall('manifest', 'wrong-token-wrong-token')).status).toBe(401);
    report = await configCheck();
    expect(report!.episode!.failedAttempts).toBe(2);

    // 正确口令：拿清单（记一次导出），逐条读（记读取次数）。
    const manifestRes = await rescueCall('manifest', rescueToken);
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const manifest: any = (await manifestRes.json()).data;
    const csItems = manifest.items.filter((item: any) => item.source === 'client_state');
    expect(csItems.map((item: any) => `${item.namespace}/${item.key}`).sort())
      .toEqual(['amsg:char:c1/fire_pack', 'amsg:char:c1/tool_pack', 'amsg:char:c2/fire_pack', 'amsg:instant-input/turn-1']);
    expect(csItems.find((item: any) => item.namespace === 'amsg:char:c2').chunked).toBe(true);

    const read = async (id: string) => {
      const res = await rescueCall('item', rescueToken, { id });
      expect(res.status).toBe(200);
      return (await res.json() as any).data;
    };
    const byKey = Object.fromEntries(await Promise.all(csItems.map(async (item: any) => [`${item.namespace}/${item.key}`, await read(item.id)])));
    // gzip 包装过的 fire_pack 要解开成原对象。
    expect(byKey['amsg:char:c1/fire_pack']).toMatchObject({ status: 'decrypted', format: 'json', value: firePack, userId });
    expect(byKey['amsg:char:c1/tool_pack'].value).toEqual(toolPack);
    // 分块存的大值要拼回完整原文。
    expect(byKey['amsg:char:c2/fire_pack'].value).toEqual(JSON.parse(bigValue));
    // 嵌套压缩的那层也要解开，不然最完整的即时对话快照在文件里是乱码。
    expect(byKey['amsg:instant-input/turn-1'].value).toEqual({ v: 1, charId: 'c1', packedFirePack: instantPack });

    const credItem = manifest.items.find((item: any) => item.source === 'llm_credentials');
    const credPage = await read(credItem.id);
    expect(credPage.rows).toHaveLength(1);
    expect(credPage.rows[0].cred_id).toBe('char:c1/chat');
    expect(credPage.rows[0].decoded.encrypted_value).toMatchObject({ status: 'decrypted', value: { apiKey: 'sk-rescue-test-key' } });
    const pushItem = manifest.items.find((item: any) => item.source === 'push_subscriptions');
    expect((await read(pushItem.id)).rows[0].decoded.subscription.status).toBe('decrypted');

    report = await configCheck();
    expect(report!.episode).toMatchObject({ id: firstEpisode.id, exportCount: 1 });
    expect(report!.episode!.itemReads).toBe(csItems.length + 2);
    expect(report!.episode!.lastExportAt).not.toBeNull();

    // 乱给编号不会读到别的东西。
    expect((await rescueCall('item', rescueToken, { id: 't:sqlite_master:0' })).status).toBe(400);
    expect((await rescueCall('item', rescueToken, { id: 'cs:not-base64' })).status).toBe(400);

    // 关掉：cron 那一跳记下结束时刻；记录还在，仍在 7 天警告窗口内。
    delete env.AMSG_RESCUE_TOKEN;
    await (worker as any).scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env);
    report = await configCheck();
    expect(report!.active).toBe(false);
    expect(report!.episode!.endedAt).not.toBeNull();
    expect(isRescueAlertDue(report!.active, report!.episode, Date.now())).toBe(true);
    expect(isRescueAlertDue(false, report!.episode, Date.now() + AMSG_RESCUE_ALERT_WINDOW_MS + 60_000)).toBe(false);
    expect((await fetch(`${baseUrl}/rescue`)).status).toBe(404);

    // 再开：新的一段、新的编号、再推一次；确认键随之改变，前端会重新弹窗。
    const ackBefore = rescueAlertAckKey(report!.active, report!.episode);
    await new Promise((resolve) => setTimeout(resolve, 5));
    env.AMSG_RESCUE_TOKEN = rescueToken;
    report = await configCheck();
    expect(report!.episode!.id).not.toBe(firstEpisode.id);
    expect(report!.episode).toMatchObject({ endedAt: null, exportCount: 0, pushDelivered: 1 });
    expect(rescueAlertAckKey(report!.active, report!.episode)).not.toBe(ackBefore);
    expect(externalRequests.filter((request) => request.url.includes('day.app') || request.url.includes('bark')).length).toBe(2);
  });

  it('推送 payload 走 result 通道，前端按 resultKind 认领', async () => {
    const { env, externalRequests } = await setup();
    env.AMSG_RESCUE_TOKEN = rescueToken;
    await configCheck();
    const body = await externalRequests[externalRequests.length - 1].clone().text();
    // Bark 只带标题正文；Web Push 那条路的 payload 结构在这里用常量钉住。
    expect(body).toContain('救援模式');
    expect(AMSG_RESCUE_RESULT_KIND).toBe('amsg-rescue-alert');
  });

  it('口令错满次数后锁定，正确口令也进不去', async () => {
    const { env } = await setup();
    env.AMSG_RESCUE_TOKEN = rescueToken;
    for (let i = 0; i < RESCUE_LOCKOUT_FAILURES; i += 1) {
      expect((await rescueCall('manifest', `wrong-${i}-wrong-wrong-wrong`)).status).toBe(401);
    }
    const locked = await rescueCall('manifest', rescueToken);
    expect(locked.status).toBe(429);
    expect((await configCheck())!.episode!.exportCount).toBe(0);
  });

  it('锁定时长从窗口内倒数第 N 次错误起算', () => {
    const now = 10 * RESCUE_LOCKOUT_WINDOW_MS;
    const failures = Array.from({ length: RESCUE_LOCKOUT_FAILURES }, (_, i) => now - 1000 * (RESCUE_LOCKOUT_FAILURES - i));
    expect(rescueLockoutRemainingMs(failures, now)).toBe(RESCUE_LOCKOUT_WINDOW_MS - 1000 * RESCUE_LOCKOUT_FAILURES);
    expect(rescueLockoutRemainingMs(failures.slice(1), now)).toBe(0);
    expect(rescueLockoutRemainingMs(failures, now + RESCUE_LOCKOUT_WINDOW_MS)).toBe(0);
  });

  it('口令太短时救援页不工作，也不算开启', async () => {
    const { env, externalRequests } = await setup();
    env.AMSG_RESCUE_TOKEN = 'short';
    const page = await fetch(`${baseUrl}/rescue`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('太短');
    expect((await rescueCall('manifest', 'short')).status).toBe(403);
    expect(await configCheck()).toEqual({ active: false, episode: null });
    expect(externalRequests.length).toBe(0);
  });

  it('开着救援模式时 cron 这一跳不投递', async () => {
    const { env } = await setup();
    env.AMSG_RESCUE_TOKEN = rescueToken;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (worker as any).scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, env);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('救援模式开着'))).toBe(true);
  });
});

describe('救援页', () => {
  it('在浏览器里填口令、点导出：下载的 JSON 含全部数据，并按角色列出可复制的内容', async () => {
    const { env, userId, firePack } = await setup();
    env.AMSG_RESCUE_TOKEN = rescueToken;
    const html = await (await fetch(`${baseUrl}/rescue`)).text();

    // @ts-ignore jsdom 只作测试依赖，仓库没装它的类型声明
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(html, { url: `${baseUrl}/rescue`, runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window: any) {
        window.fetch = (input: any, init?: any) => fetch(new URL(String(input), `${baseUrl}/rescue`).toString(), init);
        window.URL.createObjectURL = (blob: Blob) => { (window as any).__blob = blob; return 'blob:rescue-test'; };
        window.HTMLAnchorElement.prototype.click = function click() { (window as any).__downloaded = this.download; };
      } });
    const document: Document = dom.window.document;
    (document.getElementById('token') as HTMLInputElement).value = rescueToken;
    (document.getElementById('start') as HTMLButtonElement).click();

    const status = document.getElementById('status')!;
    for (let i = 0; i < 200 && !/导出完成|导出失败/.test(status.textContent ?? ''); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status.textContent).toContain('导出完成');
    expect((dom.window as any).__downloaded).toMatch(/^sullyos-amsg-rescue-\d{4}-\d{2}-\d{2}\.json$/);

    const blob: Blob = (dom.window as any).__blob;
    const text: string = await new Promise((resolve) => {
      const reader = new dom.window.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob as any);
    });
    const out = JSON.parse(text);
    expect(out.format).toBe('sullyos-amsg-rescue');
    expect(out.errors).toEqual([]);
    expect(out.users[userId].clientState['amsg:char:c1'].fire_pack).toEqual(firePack);
    expect(out.users[userId].tables.llm_credentials[0].decoded.encrypted_value.value.apiKey).toBe('sk-rescue-test-key');

    const cards = document.querySelectorAll('.char');
    expect(Array.from(cards).map((card) => card.querySelector('h2')?.textContent)).toContain('测试角色');
    const c1 = Array.from(cards).find((card) => card.querySelector('h2')?.textContent === '测试角色')!;
    (Array.from(c1.querySelectorAll('button')).find((b) => b.textContent?.includes('提示词')) as HTMLButtonElement).click();
    expect((c1.querySelector('textarea') as HTMLTextAreaElement).value).toBe(firePack.template);
    dom.window.close();
  });
});

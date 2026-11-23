import { describe, it, expect, vi } from 'vitest';
import {
  buildDurableObjectPlan,
  bundleFetchUrl,
  resolveBundleUrl,
  resolveObservability,
  handleSelfUpdate,
  locateScript,
  rebuildBindings,
  resolveScriptName,
} from './selfUpdate';

describe('buildDurableObjectPlan', () => {
  const doBinding = {
    type: 'durable_object_namespace',
    name: 'INSTANT_TICK',
    class_name: 'InstantTickDO',
  };

  it('老 Worker 上没有起跳器 → 补 binding，同时带 migrations 把它建出来', () => {
    const plan = buildDurableObjectPlan([
      { type: 'd1', name: 'DB', id: 'x' },
      { type: 'secret_text', name: 'AMSG_MASTER_KEY' },
    ]);
    expect(plan.binding).toEqual(doBinding);
    expect(plan.migrations).toEqual({
      new_tag: 'amsg-instant-tick-v1',
      new_sqlite_classes: ['InstantTickDO'],
    });
  });

  /**
   * 回归守卫：建过之后绝不能再带 migrations。
   *
   * Cloudflare 的 migrations 带乐观锁——不给 old_tag 等于断言「这个 Worker 一个
   * migration 都没应用过」。自更新是会被反复点的，第二次带同一个 tag 会撞上
   * `10079 Actor migration tag precondition failed`，**整个自更新失败**，用户的
   * Worker 从此更新不动。2026-08-09 直接打 Cloudflare API 实测确认过这个行为。
   */
  it('已经有起跳器 → binding 和 migrations 都不动（重传 migrations 会 10079）', () => {
    const plan = buildDurableObjectPlan([{ type: 'd1', name: 'DB', id: 'x' }, doBinding]);
    expect(plan.binding).toBeNull();
    expect(plan.migrations).toBeNull();
  });

  it('认的是 binding 名而不只是类型（别的 DO 不算数）', () => {
    const plan = buildDurableObjectPlan([
      { type: 'durable_object_namespace', name: 'SOMETHING_ELSE', class_name: 'OtherDO' },
    ]);
    expect(plan.binding).toEqual(doBinding);
  });
});

describe('rebuildBindings', () => {
  // Cloudflare 的上传接口是整体替换：这一发没带的 binding 等于删掉。
  // 而读回来的密钥只有名字没有值，所以必须从 env 补——补漏了就是把用户的密钥抹了。
  it('把密钥的值从运行时补回去', () => {
    const result = rebuildBindings(
      [
        { type: 'secret_text', name: 'AMSG_MASTER_KEY' },
        { type: 'secret_text', name: 'VAPID_PRIVATE_KEY' },
      ],
      { AMSG_MASTER_KEY: 'mk', VAPID_PRIVATE_KEY: 'pk' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings).toEqual([
      { type: 'secret_text', name: 'AMSG_MASTER_KEY', text: 'mk' },
      { type: 'secret_text', name: 'VAPID_PRIVATE_KEY', text: 'pk' },
    ]);
  });

  it('非密钥的 binding 原样搬过去', () => {
    const d1 = { type: 'd1', name: 'DB', id: 'db-uuid' };
    const plain = { type: 'plain_text', name: 'SOME_VAR', text: 'v' };
    const result = rebuildBindings([d1, plain], {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // D1 的 id 必须原样带回，否则新版本会丢掉数据库绑定
    expect(result.bindings).toEqual([d1, plain]);
  });

  it('补不到值时整体中止，不能悄悄少传一条', () => {
    const result = rebuildBindings(
      [
        { type: 'secret_text', name: 'AMSG_MASTER_KEY' },
        { type: 'secret_text', name: 'VAPID_PRIVATE_KEY' },
      ],
      { AMSG_MASTER_KEY: 'mk' }, // VAPID_PRIVATE_KEY 读不到
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['VAPID_PRIVATE_KEY']);
  });

  it('值是空字符串也算读不到——传上去等于把密钥清空', () => {
    const result = rebuildBindings([{ type: 'secret_text', name: 'AMSG_SERVER_TOKEN' }], {
      AMSG_SERVER_TOKEN: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['AMSG_SERVER_TOKEN']);
  });
});

describe('resolveScriptName', () => {
  it('从 workers.dev 域名反推 worker 名', () => {
    expect(resolveScriptName({}, 'https://sullyos-amsg.someone.workers.dev/self-update')).toBe(
      'sullyos-amsg',
    );
  });

  it('配了 CF_SCRIPT_NAME 就以它为准', () => {
    expect(
      resolveScriptName({ CF_SCRIPT_NAME: '  my-worker  ' }, 'https://other.workers.dev/self-update'),
    ).toBe('my-worker');
  });

  // 国内会在 workers.dev 外面套一层 Deno 门面。那时请求进来挂的是代理域名，
  // 照着反推会得出一个不存在的 worker 名，然后去更新「别的东西」。宁可认不出来。
  it('不是 workers.dev 域名就认不出来，交给 CF_SCRIPT_NAME', () => {
    expect(resolveScriptName({}, 'https://my-proxy.deno.net/self-update')).toBeNull();
    expect(resolveScriptName({}, 'https://amsg.example.com/self-update')).toBeNull();
  });
});

describe('resolveObservability', () => {
  // 上传是整体覆盖：metadata 里不带 observability，之前开着的实时日志就没了
  // （实测确认：开成 enabled:true 之后不带这个字段重传一次，再读回来就没有）。
  it('读回来是什么就带上什么', () => {
    const current = { enabled: true, logs: { enabled: true, invocation_logs: false } };
    expect(resolveObservability(current)).toEqual(current);
  });

  it('用户明确关掉的也照样尊重，不强行开', () => {
    expect(resolveObservability({ enabled: false })).toEqual({ enabled: false });
  });

  it('读不到就按开启兜底——仓库里的 wrangler.toml 声明的就是开', () => {
    const fallback = { enabled: true, logs: { enabled: true } };
    expect(resolveObservability(undefined)).toEqual(fallback);
    expect(resolveObservability(null)).toEqual(fallback);
  });
});

describe('handleSelfUpdate 上传时带的 metadata', () => {
  const FAKE_BUNDLE = `// src_default as default\n${'x'.repeat(200 * 1024)}`;

  /** 把这次自更新打到 Cloudflare 的每一发都记下来。 */
  const runSelfUpdate = async (observability?: unknown) => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes('raw.githubusercontent.com')) return new Response(FAKE_BUNDLE);
      const path = new URL(url).pathname;
      const method = init.method ?? 'GET';
      let body: unknown = null;
      if (init.body instanceof FormData) {
        const part = init.body.get('settings') ?? init.body.get('metadata');
        body = part instanceof Blob ? JSON.parse(await part.text()) : null;
      }
      calls.push({ method, path, body });
      if (method === 'GET' && path.endsWith('/settings')) {
        return Response.json({
          success: true,
          result: {
            bindings: [{ type: 'secret_text', name: 'AMSG_MASTER_KEY' }],
            compatibility_date: '2026-01-01',
            observability,
          },
        });
      }
      return Response.json({ success: true, result: {} });
    }) as typeof fetch;

    try {
      const result = await handleSelfUpdate(
        new Request('https://amsg.test.workers.dev/self-update', {
          method: 'POST',
          headers: { 'X-Client-Token': 'shared' },
        }),
        {
          AMSG_SERVER_TOKEN: 'shared',
          CF_API_TOKEN: 'cf-token',
          CF_SCRIPT_NAME: 'sullyos-amsg',
          CF_ACCOUNT_ID: 'acc-1',
          AMSG_MASTER_KEY: 'mk',
        } as any,
      );
      return { result, calls };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const uploadMetadata = (calls: Array<{ method: string; body: any }>) =>
    calls.find((c) => c.method === 'PUT')?.body;

  it('上传时带上实时日志开关，否则每更新一次就把它打回默认关', async () => {
    const observability = { enabled: true, logs: { enabled: true } };
    const { result, calls } = await runSelfUpdate(observability);

    expect(result.ok).toBe(true);
    expect(uploadMetadata(calls)?.observability).toEqual(observability);
  });

  it('原本没设过的，上传时按开启兜底', async () => {
    const { calls } = await runSelfUpdate(undefined);

    expect(uploadMetadata(calls)?.observability).toEqual({ enabled: true, logs: { enabled: true } });
  });

  it('用户明确关掉的，更新不会替他打开', async () => {
    const { calls } = await runSelfUpdate({ enabled: false });

    expect(uploadMetadata(calls)?.observability).toEqual({ enabled: false });
  });
});

describe('locateScript', () => {
  const failure = (code: number, message: string) => ({ success: false, errors: [{ code, message }] });
  const INVALID_TOKEN = failure(9109, 'Invalid access token');

  const locate = async (env: Record<string, string>, respond: (path: string) => unknown) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any) =>
      new Response(JSON.stringify(respond(new URL(String(url)).pathname)))) as any;
    try {
      return await locateScript(env, 'cf-token', 'sullyos-amsg');
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  it('多个账号时逐个找，用读得到这个 Worker 的那个', async () => {
    const located = await locate({}, (path) => {
      if (path.endsWith('/accounts')) return { success: true, result: [{ id: 'acc-1' }, { id: 'acc-2' }] };
      return path.includes('/acc-2/')
        ? { success: true, result: { bindings: [] } }
        : failure(10007, 'workers.api.error.script_not_found');
    });

    expect(located).toMatchObject({ ok: true, accountId: 'acc-2' });
  });

  it('查账号列表时 token 无效：让用户换 token，不把 CF_ACCOUNT_ID 当成解法', async () => {
    const located = await locate({}, () => INVALID_TOKEN);

    expect(located.ok).toBe(false);
    if (located.ok) return;
    expect(located.message).toContain('Cloudflare 不认这枚 CF_API_TOKEN');
    expect(located.message).toContain('9109: Invalid access token');
    expect(located.message).not.toContain('即可跳过');
  });

  it('配了 CF_ACCOUNT_ID 时 token 无效：同样让用户换 token', async () => {
    const located = await locate({ CF_ACCOUNT_ID: 'acc-1' }, () => INVALID_TOKEN);

    expect(located.ok).toBe(false);
    if (located.ok) return;
    expect(located.message).toContain('Cloudflare 不认这枚 CF_API_TOKEN');
    expect(located.message).not.toContain('读不到这个 Worker');
  });

  it('同样是 9109，权限不够时不算 token 失效', async () => {
    const located = await locate({}, () => failure(9109, 'Unauthorized to access requested resource'));

    expect(located.ok).toBe(false);
    if (located.ok) return;
    expect(located.message).toContain('问不到账号列表');
    expect(located.message).toContain('CF_ACCOUNT_ID');
  });
});

describe('resolveBundleUrl', () => {
  const official = 'https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg/worker.bundle.js';

  it('不配就是官方成品包', () => {
    expect(resolveBundleUrl({})).toBe(official);
    expect(resolveBundleUrl({ AMSG_BUNDLE_URL: '   ' })).toBe(official);
  });

  it('配了 https 地址就取那儿（fork / 测试 Worker 用）', () => {
    expect(resolveBundleUrl({ AMSG_BUNDLE_URL: 'https://example.com/x/worker.bundle.js' })).toBe('https://example.com/x/worker.bundle.js');
  });

  it('不是 https 一律回落到官方，别把明文 http 或乱填的东西当成品包源', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveBundleUrl({ AMSG_BUNDLE_URL: 'http://example.com/w.js' })).toBe(official);
    expect(resolveBundleUrl({ AMSG_BUNDLE_URL: 'not a url' })).toBe(official);
  });

  it('按通道取官方那条线：正式版跟 main，canary 跟 canary 分支', () => {
    expect(resolveBundleUrl({}, 'stable')).toBe(official);
    expect(resolveBundleUrl({}, 'canary')).toBe(
      'https://raw.githubusercontent.com/Tosd0/sullyos-workers/canary/amsg/worker.bundle.js',
    );
  });

  it('配了 AMSG_BUNDLE_URL 就只认它，通道不起作用', () => {
    const custom = 'https://example.com/x/worker.bundle.js';
    expect(resolveBundleUrl({ AMSG_BUNDLE_URL: custom }, 'canary')).toBe(custom);
    expect(resolveBundleUrl({ AMSG_BUNDLE_URL: custom }, 'stable')).toBe(custom);
  });
});

describe('handleSelfUpdate 的通道', () => {
  const FAKE_BUNDLE = `// src_default as default\n${'x'.repeat(200 * 1024)}`;
  const ENV = {
    AMSG_SERVER_TOKEN: 'shared',
    CF_API_TOKEN: 'cf-token',
    CF_SCRIPT_NAME: 'sullyos-amsg',
    CF_ACCOUNT_ID: 'acc-1',
  } as any;

  /** 记下取包去了哪条线、有没有上传；body 是 /self-update 的请求体（不传就是老前端那样空体）。 */
  const run = async (body?: string, options: { env?: any; stored?: 'stable' | 'canary' } = {}) => {
    const pulled: string[] = [];
    let uploads = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes('raw.githubusercontent.com') || url.includes('example.com')) {
        pulled.push(url.split('?')[0]);
        return new Response(FAKE_BUNDLE);
      }
      if ((init.method ?? 'GET') === 'PUT') uploads += 1;
      if (url.endsWith('/settings')) return Response.json({ success: true, result: { bindings: [] } });
      return Response.json({ success: true, result: {} });
    }) as typeof fetch;
    try {
      const result = await handleSelfUpdate(
        new Request('https://amsg.test.workers.dev/self-update', {
          method: 'POST',
          headers: { 'X-Client-Token': 'shared' },
          body,
        }),
        options.env ?? ENV,
        options.stored,
      );
      return { result, pulled, uploads };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const CANARY = 'https://raw.githubusercontent.com/Tosd0/sullyos-workers/canary/amsg/worker.bundle.js';
  const STABLE = 'https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg/worker.bundle.js';

  it('带 canary 就从 canary 那条线拉包，成功的结果里带上通道', async () => {
    const { result, pulled, uploads } = await run(JSON.stringify({ channel: 'canary' }));
    expect(result.ok).toBe(true);
    expect(result.channel).toBe('canary');
    expect(pulled).toEqual([CANARY]);
    expect(uploads).toBe(1);
  });

  it('不带 channel（空体 / 非 JSON / 没这个键）就沿用记着的通道，老前端不会把 canary 拉回正式版', async () => {
    for (const body of [undefined, 'not json', '{}']) {
      const { result, pulled } = await run(body, { stored: 'canary' });
      expect(result.ok).toBe(true);
      expect(result.channel).toBe('canary');
      expect(pulled).toEqual([CANARY]);
    }
    const plain = await run(undefined);
    expect(plain.result.channel).toBe('stable');
    expect(plain.pulled).toEqual([STABLE]);
  });

  it('通道值不认识 → INVALID_CHANNEL，不拉包不上传', async () => {
    for (const channel of ['beta', 'Canary', null, 1]) {
      const { result, pulled, uploads } = await run(JSON.stringify({ channel }));
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_CHANNEL');
      expect(pulled).toEqual([]);
      expect(uploads).toBe(0);
    }
  });

  it('自己指定了成品包地址的 Worker 要换线 → CUSTOM_BUNDLE_URL；不换线照常从那个地址装', async () => {
    const env = { ...ENV, AMSG_BUNDLE_URL: 'https://example.com/w.js' };
    const switched = await run(JSON.stringify({ channel: 'canary' }), { env, stored: 'stable' });
    expect(switched.result.ok).toBe(false);
    expect(switched.result.code).toBe('CUSTOM_BUNDLE_URL');
    expect(switched.result.message).toContain('AMSG_BUNDLE_URL');
    expect(switched.pulled).toEqual([]);

    const same = await run(JSON.stringify({ channel: 'stable' }), { env, stored: 'stable' });
    expect(same.result.ok).toBe(true);
    expect(same.pulled).toEqual(['https://example.com/w.js']);
  });

  it('没过授权就不读请求体，照旧回 UNAUTHORIZED', async () => {
    const { result } = await run(JSON.stringify({ channel: 'beta' }), { env: { ...ENV, AMSG_SERVER_TOKEN: 'other' } });
    expect(result.code).toBe('UNAUTHORIZED');
  });
});

describe('bundleFetchUrl', () => {
  /**
   * 回归守卫：取包地址必须带随时间变的参数。GitHub raw 前面的 CDN 按完整 URL 缓存，
   * 不带的话推新包后几分钟内还会吐旧包——自动更新按指纹比，吃到旧包就把新代码换回去。
   */
  it('地址挂上时间参数，同一份地址两次取不一样', () => {
    const base = 'https://raw.githubusercontent.com/x/y/main/amsg/worker.bundle.js';
    expect(bundleFetchUrl(base, 1000)).toBe(`${base}?t=1000`);
    expect(bundleFetchUrl(base, 1000)).not.toBe(bundleFetchUrl(base, 2000));
  });

  it('原地址本来就带参数也不冲掉', () => {
    expect(bundleFetchUrl('https://example.com/w.js?token=abc', 5)).toBe('https://example.com/w.js?token=abc&t=5');
  });
});

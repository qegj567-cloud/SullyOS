/**
 * 自更新：在 SullyOS 里点一下，worker 自己去取最新代码覆盖自己。
 *
 * 为什么要有这个：后端有三条安装路，更新体验差得很远——
 *   - 照手册 fork 一份再连仓库：GitHub 上点一下 Sync fork 就自动重新部署
 *   - 「Deploy to Cloudflare」按钮：它给你的是 clone 出来的独立仓库、不是 fork，
 *     没有 Sync fork 可点，只能自己往仓库里传新的 worker.bundle.js
 *   - 找人代配：每次更新都得再找一次
 * 有了这条，三条路的更新都变成「在 SullyOS 里点一下」，手机上尤其省事。
 *
 * 在此之上还有「不用点」的那层：配了 CF_API_TOKEN 的 Worker 会自己定期查有没有新代码，
 * 有就照这里同一套流程换上（见 ./autoUpdate）。这份文件只管「怎么换」，「什么时候换」在那边。
 *
 * 浏览器为什么不能直接干这事：api.cloudflare.com 不返回 CORS 头，前端 fetch 一律被拦。
 * 而 worker 自己跑在 Cloudflare 上，调 API 没这个问题，所以这活儿只能落在这一侧。
 *
 * 安全上的三条底线：
 *   1. 必须配了共享密钥并校验通过才让动——没有密钥的实例直接拒绝，不给「谁都能触发」的口子
 *   2. 新代码先校验再上传，任何一项不对就原样不动（把自己刷挂了就没法再自更新了）
 *   3. token 只出现在发往 Cloudflare 的请求头里，任何响应体都不回显它
 */

import { constantTimeEqual } from './instantChat';
import { cfTokenRejectedMessage, findCfTokenRejection } from '../../../utils/amsgSelfUpdateState';

const CF_API = 'https://api.cloudflare.com/client/v4';

/** 官方成品代码。跟代配脚本、手册附录指的是同一份。 */
const BUNDLE_URL =
  'https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg/worker.bundle.js';

/**
 * 成品包从哪儿取：默认官方那份；配了 AMSG_BUNDLE_URL 就取那儿（自己维护成品包的 fork、
 * 或者拿一台测试 Worker 试新代码时用）。只认 https，别的一律回落到默认。
 */
export function resolveBundleUrl(env: Pick<SelfUpdateEnv, 'AMSG_BUNDLE_URL'>): string {
  const configured = env.AMSG_BUNDLE_URL?.trim();
  if (!configured) return BUNDLE_URL;
  try {
    const url = new URL(configured);
    if (url.protocol === 'https:') return url.toString();
  } catch {
    // 不是个能解析的地址，按默认走
  }
  console.warn('[amsg:self-update] AMSG_BUNDLE_URL 不是 https 地址，改用默认成品包');
  return BUNDLE_URL;
}

/** 上传时用的模块名，同时也是 metadata.main_module，两处必须一致。 */
const MAIN_MODULE = 'worker.bundle.js';

/** 兜底用的运行时配置，只在读不到现有配置时才用，跟 wrangler.toml 保持一致。 */
const FALLBACK_COMPATIBILITY_DATE = '2026-01-01';
const FALLBACK_COMPATIBILITY_FLAGS = ['global_fetch_strictly_public'];

/** 成品包实测 400 KB 出头。低于这个数基本就是拿到错误页了。 */
const MIN_BUNDLE_BYTES = 100 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** 成品包必须带的导出标记，用来认「这确实是 amsg 的 worker」。 */
const BUNDLE_FINGERPRINT = 'src_default as default';

export interface SelfUpdateEnv {
  AMSG_SERVER_TOKEN?: string;
  /** Cloudflare API Token，只需要 Workers Scripts → Edit。没配就用不了自更新。 */
  CF_API_TOKEN?: string;
  /** 可选：不配就拿 token 去问 Cloudflare。只有一个账号时能问出来。 */
  CF_ACCOUNT_ID?: string;
  /** 可选：不配就从 workers.dev 域名反推。套了代理域名时必须配。 */
  CF_SCRIPT_NAME?: string;
  /** 可选：成品包换个地方取（见 resolveBundleUrl）。不配就是官方那份。 */
  AMSG_BUNDLE_URL?: string;
}

export interface SelfUpdateResult {
  ok: boolean;
  code: string;
  message: string;
  /** 新代码的指纹（sha-256 前 12 位），给前端显示「现在跑的是哪一版」。 */
  bundleHash?: string;
  bundleBytes?: number;
  scriptName?: string;
}

const fail = (code: string, message: string): SelfUpdateResult & { ok: false } => ({ ok: false, code, message });

/**
 * 调 Cloudflare API，把 {success, errors, result} 那层信封拆掉。
 *
 * body 传 FormData 就是上传脚本那种 multipart；传字符串是 JSON 体，这时要自己带上
 * `Content-Type: application/json`（见 ./cronTrigger 改定时触发那一发）。
 */
export async function cf(
  token: string,
  path: string,
  init: { method?: string; body?: FormData | string; headers?: Record<string, string> } = {},
): Promise<{ ok: true; result: any } | { ok: false; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${CF_API}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
      body: init.body,
    });
  } catch (err) {
    return { ok: false, detail: `连不上 Cloudflare API：${(err as Error).message}` };
  }

  const text = await res.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, detail: `Cloudflare 返回了非 JSON（HTTP ${res.status}）` };
  }
  if (!res.ok || payload?.success === false) {
    const detail =
      (payload?.errors ?? []).map((e: any) => `${e.code}: ${e.message}`).join('；') ||
      `HTTP ${res.status}`;
    return { ok: false, detail };
  }
  return { ok: true, result: payload.result };
}

/**
 * 上传时要带上的实时日志开关。
 *
 * **不带就等于关掉**：上传是整体覆盖，metadata 里没有 observability 的话，重传一次
 * 之前开着的日志就没了（实测确认过）。而排障恰恰是更新之后最可能需要日志的时候。
 *
 * 传入的是上传前读回来的那份，原样带上；读不到就按开启兜底（仓库里的 wrangler.toml
 * 声明的就是开）。
 *
 * 注：官方的 multipart-upload-metadata 文档没把 observability 列进合法字段，但实测
 * 是认的——上传 enabled:false 能关掉、enabled:true 能开起来、不带就没有，三向都验过。
 */
export function resolveObservability(existing: unknown): Record<string, unknown> {
  const current = existing as { enabled?: boolean } | null | undefined;
  if (current && typeof current.enabled === 'boolean') return current as Record<string, unknown>;
  return { enabled: true, logs: { enabled: true } };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 定位「我是谁」。
 *
 * 域名反推只在 *.workers.dev 上成立：国内套了 Deno 门面之后请求进来时挂的是代理域名，
 * 照着推会得出一个不存在的 worker 名，那就必须让 CF_SCRIPT_NAME 说了算。
 */
export function resolveScriptName(env: SelfUpdateEnv, requestUrl: string): string | null {
  const configured = env.CF_SCRIPT_NAME?.trim();
  if (configured) return configured;
  let host: string;
  try {
    host = new URL(requestUrl).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith('.workers.dev')) return null;
  const name = host.split('.')[0];
  return name || null;
}

/**
 * 找出「我住在哪个账号下」，顺带把这个账号的配置读回来。
 *
 * `GET /accounts` 是用户级端点，返回的是这个人名下的**所有**账号，跟 token 限定了哪个账号
 * 没关系。所以同时有工作号和个人号的人在这儿会拿到好几条，光看列表分不出该更新哪个。
 * 办法是挨个问一句「你这儿有没有这个 Worker」——能读出配置的那个就是。
 */
export async function locateScript(
  env: SelfUpdateEnv,
  token: string,
  scriptName: string,
): Promise<{ ok: true; accountId: string; settings: any } | { ok: false; message: string }> {
  const settingsPath = (accountId: string) =>
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`;

  const configured = env.CF_ACCOUNT_ID?.trim();
  if (configured) {
    const settings = await cf(token, settingsPath(configured));
    if (!settings.ok) {
      const rejected = findCfTokenRejection(settings.detail);
      return {
        ok: false,
        message: rejected
          ? cfTokenRejectedMessage(rejected, true)
          : `在 CF_ACCOUNT_ID 指定的账号里读不到这个 Worker 的配置（${settings.detail}）。`,
      };
    }
    return { ok: true, accountId: configured, settings: settings.result };
  }

  const listed = await cf(token, '/accounts');
  if (!listed.ok) {
    const rejected = findCfTokenRejection(listed.detail);
    return {
      ok: false,
      message: rejected
        ? cfTokenRejectedMessage(rejected, false)
        : `问不到账号列表（${listed.detail}）。给 Worker 加一条 CF_ACCOUNT_ID 变量即可跳过这一步。`,
    };
  }
  const accounts: any[] = Array.isArray(listed.result) ? listed.result : [];
  if (!accounts.length) {
    return { ok: false, message: '这枚 token 一个账号都读不到，多半是权限没给全或者已经过期。' };
  }

  for (const account of accounts) {
    const settings = await cf(token, settingsPath(account.id));
    if (settings.ok) return { ok: true, accountId: account.id, settings: settings.result };
  }
  return {
    ok: false,
    message:
      `在这枚 token 能碰到的 ${accounts.length} 个账号里都没找到名为 ${scriptName} 的 Worker。` +
      '要么 token 的权限没覆盖到它所在的账号，要么 Worker 名字对不上（可用 CF_SCRIPT_NAME 指定）。',
  };
}

/** 取回来的成品包：正文加上它的指纹，指纹既用来回报也用来判「跟上次装的是不是同一份」。 */
export interface FetchedBundle {
  code: string;
  /** sha-256 前 12 位。跟 SelfUpdateResult.bundleHash 是同一个数。 */
  hash: string;
  bytes: number;
}

/**
 * 取包的地址后面挂一个随时间变的参数。
 *
 * 注意它**绕不开 GitHub raw 自己那层 CDN**（真机看过：换个参数照样 x-cache: HIT，它的缓存键
 * 不带 query），只能挡住中间别的按完整 URL 存的缓存。新包推上去后几分钟内取回旧包这件事，
 * 靠 ./autoUpdate 两次检查至少隔半小时来兜（那时缓存早铺开了）。
 */
export function bundleFetchUrl(base: string, nowMs = Date.now()): string {
  const url = new URL(base);
  url.searchParams.set('t', String(nowMs));
  return url.toString();
}

/**
 * 取回最新成品包，并确认它确实是 amsg 的 worker 而不是一张错误页。
 *
 * 能绕的缓存都绕（地址挂时间参数 + `cache: 'no-store'`），但 raw.githubusercontent 自己的
 * CDN（max-age=300）绕不开：新包推上去之后各节点几分钟内还会吐旧的。所以取回来的包
 * 不能当成「一定是最新」——自动更新那边两次检查至少隔半小时，到那时缓存早铺开了（见 ./autoUpdate）；
 * 手动点的那条路不受节流管，刚发布那几分钟内点到旧包就是旧包，下次自动检查会再换回来。
 */
export async function fetchLatestBundle(
  env: Pick<SelfUpdateEnv, 'AMSG_BUNDLE_URL'> = {},
): Promise<{ ok: true; bundle: FetchedBundle } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch(bundleFetchUrl(resolveBundleUrl(env)), {
      headers: { 'User-Agent': 'sullyos-amsg-self-update' },
      cache: 'no-store',
    });
  } catch (err) {
    return { ok: false, message: `取不到最新代码：${(err as Error).message}` };
  }
  if (!res.ok) return { ok: false, message: `取最新代码失败（HTTP ${res.status}）` };

  const code = await res.text();
  const bytes = new TextEncoder().encode(code).length;
  if (bytes < MIN_BUNDLE_BYTES || bytes > MAX_BUNDLE_BYTES) {
    return { ok: false, message: `取回来的文件大小不对（${bytes} 字节），没有覆盖，当前版本不动。` };
  }
  if (!code.includes(BUNDLE_FINGERPRINT)) {
    return { ok: false, message: '取回来的文件不像 amsg 的 worker 代码，没有覆盖，当前版本不动。' };
  }
  const hash = (await sha256Hex(code)).slice(0, 12);
  return { ok: true, bundle: { code, hash, bytes } };
}

/**
 * 把现有 binding 原样搬到新版本上。
 *
 * Cloudflare 的上传接口是整体替换：这一发没带的 binding 等于删掉。D1 那条能从接口原样读回，
 * 但密钥只回名字不回值——值得从 env 里补。补不齐就中止，不能带着残缺的 binding 上传，
 * 那等于把用户的密钥抹了。
 */
export function rebuildBindings(
  existing: any[],
  env: Record<string, unknown>,
): { ok: true; bindings: any[] } | { ok: false; missing: string[] } {
  const bindings: any[] = [];
  const missing: string[] = [];

  for (const binding of existing) {
    if (binding?.type === 'secret_text') {
      const value = env[binding.name];
      if (typeof value !== 'string' || !value) {
        missing.push(binding.name);
        continue;
      }
      bindings.push({ type: 'secret_text', name: binding.name, text: value });
    } else {
      bindings.push(binding);
    }
  }

  if (missing.length) return { ok: false, missing };
  return { ok: true, bindings };
}

// ─── 即时对话的 Durable Object ───

/** 起跳器的 binding 名与类名，跟 wrangler.toml、index.ts 的 InstantTickDO 三处对齐。 */
const INSTANT_TICK_BINDING = 'INSTANT_TICK';
const INSTANT_TICK_CLASS = 'InstantTickDO';
/** 建这个 namespace 用的 migration tag；只在首次创建时发一次，见 buildDurableObjectPlan。 */
const INSTANT_TICK_MIGRATION_TAG = 'amsg-instant-tick-v1';

export interface DurableObjectPlan {
  /** 要补进 bindings 的那条；已经有了就是 null。 */
  binding: { type: string; name: string; class_name: string } | null;
  /** metadata.migrations 的值；不需要动 migration 时是 null（字段整个不带）。 */
  migrations: { new_tag: string; new_sqlite_classes: string[] } | null;
}

/**
 * 算出这次上传要不要建 Durable Object namespace。
 *
 * Cloudflare 的 migrations 字段是**带乐观锁的**：不给 `old_tag` 等于断言「这个 Worker
 * 现在一个 migration 都没应用过」。所以它不能每次都原样重传——第二次就会撞上
 * `10079 Actor migration tag precondition failed, got tag '' when expected tag is
 * 'xxx'`，把整个自更新搞失败（2026-08-09 实测确认）。
 *
 * 于是按「现有 binding 里有没有它」分流：
 *   - 没有 → 这是第一次，带 migrations 把 namespace 建出来，同时补上 binding；
 *   - 已有 → 完全不带 migrations，binding 原样传即可（实测这样上传成功，
 *     migration_tag 保持不变，DO 类也还在）。
 *
 * 另注：API 的 migrations 是**一个对象**，不是 wrangler.toml 里那种数组——传数组会被
 * 顶回来（`10021 cannot unmarshal array into ... ActorMigrations`）。
 */
export function buildDurableObjectPlan(existing: any[]): DurableObjectPlan {
  const already = existing.some(
    (binding) => binding?.type === 'durable_object_namespace' && binding?.name === INSTANT_TICK_BINDING,
  );
  if (already) return { binding: null, migrations: null };
  return {
    binding: {
      type: 'durable_object_namespace',
      name: INSTANT_TICK_BINDING,
      class_name: INSTANT_TICK_CLASS,
    },
    migrations: { new_tag: INSTANT_TICK_MIGRATION_TAG, new_sqlite_classes: [INSTANT_TICK_CLASS] },
  };
}

/**
 * 自更新的门：共享密钥必须配了且对得上，CF_API_TOKEN 必须在。
 *
 * `POST /self-update` 和 `POST /self-update/check` 共用这一道——两条路都能让 Worker
 * 覆盖自己的代码，门槛不能有高低。
 */
export async function authorizeSelfUpdate(
  request: Request,
  env: SelfUpdateEnv,
): Promise<{ ok: true; token: string } | { ok: false; code: string; message: string }> {
  // ① 没设共享密钥的实例一律不给自更新：那种实例的地址等于全公开，
  //    留这个口子相当于谁都能让别人的后端重新部署一次。
  const serverToken = env.AMSG_SERVER_TOKEN?.trim();
  if (!serverToken) {
    return fail(
      'SERVER_TOKEN_REQUIRED',
      '这个 Worker 没设共享密钥（AMSG_SERVER_TOKEN），出于安全考虑不开放自更新。先补上再试。',
    );
  }
  // 常时比较：这个端点能让 worker 覆盖自己的代码，密钥校验不能从耗时上漏字。
  const clientToken = request.headers.get('X-Client-Token');
  if (!clientToken || !(await constantTimeEqual(clientToken, serverToken))) {
    return fail('UNAUTHORIZED', '共享密钥对不上。');
  }

  const token = env.CF_API_TOKEN?.trim();
  if (!token) {
    return fail(
      'CF_TOKEN_MISSING',
      '没配 CF_API_TOKEN，没法自己更新。去 Cloudflare 建一枚只勾 Workers Scripts → Edit 的 API Token，加进这个 Worker 的变量里。',
    );
  }
  return { ok: true, token };
}

/**
 * 把一份已经取回并验过的成品包装到自己身上。
 *
 * 门（密钥、token）和「要不要装」的判断都在调用方：手动那条路（handleSelfUpdate）是
 * 点了就装，自动那条路（./autoUpdate）先比指纹再决定。这里只负责「装」这一步本身。
 */
export async function performSelfUpdate(
  env: SelfUpdateEnv,
  token: string,
  scriptName: string,
  bundle: FetchedBundle,
): Promise<SelfUpdateResult> {
  // ② 定位自己住在哪个账号下，同时把现有配置读回来：binding、兼容性日期都照搬，
  //    免得自更新顺手改了运行时行为。
  const located = await locateScript(env, token, scriptName);
  if (!located.ok) return fail('SCRIPT_NOT_LOCATED', located.message);
  const account = { id: located.accountId };
  const settings = { result: located.settings };

  // 密钥的名字要到运行时才知道（读回来的 binding 列表说了算），所以这里按名取值，
  // 类型上就只能当成一袋 key-value 看。
  const rebuilt = rebuildBindings(
    settings.result?.bindings ?? [],
    env as unknown as Record<string, unknown>,
  );
  if (!rebuilt.ok) {
    return fail(
      'BINDING_VALUE_MISSING',
      `这几项密钥在运行时读不到值：${rebuilt.missing.join('、')}。` +
        '照原样传上去会把它们抹掉，所以没有覆盖，当前版本不动。',
    );
  }

  // 即时对话的起跳器：老 Worker 上还没有，这一发顺手把它建出来（见 buildDurableObjectPlan）。
  const doPlan = buildDurableObjectPlan(settings.result?.bindings ?? []);
  if (doPlan.binding) {
    console.log('[amsg:self-update] 这台 Worker 还没有 INSTANT_TICK，本次上传一并创建');
  }

  const metadata = {
    main_module: MAIN_MODULE,
    compatibility_date: settings.result?.compatibility_date || FALLBACK_COMPATIBILITY_DATE,
    compatibility_flags: settings.result?.compatibility_flags?.length
      ? settings.result.compatibility_flags
      : FALLBACK_COMPATIBILITY_FLAGS,
    bindings: doPlan.binding ? [...rebuilt.bindings, doPlan.binding] : rebuilt.bindings,
    // 不带这一项等于把实时日志关掉（上传是整体覆盖）。原样带上读回来的那份。
    observability: resolveObservability(settings.result?.observability),
    // 已经建过就整个字段不带：它带乐观锁，重传会被顶回来。
    ...(doPlan.migrations ? { migrations: doPlan.migrations } : {}),
  };

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(
    MAIN_MODULE,
    new Blob([bundle.code], { type: 'application/javascript+module' }),
    MAIN_MODULE,
  );

  // ④ 覆盖自己。这一刻之后的请求就走新代码了，本次响应仍由旧代码发出。
  const uploaded = await cf(
    token,
    `/accounts/${account.id}/workers/scripts/${encodeURIComponent(scriptName)}`,
    { method: 'PUT', body: form },
  );
  if (!uploaded.ok) {
    return fail('UPLOAD_FAILED', `上传失败（${uploaded.detail}）。当前版本不动。`);
  }

  return {
    ok: true,
    code: 'UPDATED',
    message: '已经更新到最新版本。',
    bundleHash: bundle.hash,
    bundleBytes: bundle.bytes,
    scriptName,
  };
}

/** `POST /self-update`：点了就装，不比指纹——手动点的人多半正是想强行重刷一遍。 */
export async function handleSelfUpdate(
  request: Request,
  env: SelfUpdateEnv,
): Promise<SelfUpdateResult> {
  const gate = await authorizeSelfUpdate(request, env);
  if (!gate.ok) return gate;

  const scriptName = resolveScriptName(env, request.url);
  if (!scriptName) {
    return fail(
      'SCRIPT_NAME_UNKNOWN',
      '认不出这个 Worker 叫什么（多半是套了代理域名）。给它加一条 CF_SCRIPT_NAME 变量，值填 Worker 的名字。',
    );
  }

  // ③ 新代码先拿到手并验明正身，再碰线上的东西。
  const fetched = await fetchLatestBundle(env);
  if (!fetched.ok) return fail('BUNDLE_INVALID', fetched.message);

  return performSelfUpdate(env, gate.token, scriptName, fetched.bundle);
}

/**
 * 一键部署主动消息后端：用户只提供一枚 Cloudflare API Token，剩下的全在这里做完。
 *
 * 做的事按顺序是：验 token → 找出能用的账号 → 建 D1 → 确认 workers.dev 子域 →
 * 拉最新 bundle → 上传 Worker（密钥和 D1 绑定一次带齐）→ 加 cron → 开 workers.dev。
 * 密钥（Master Key / VAPID / Server Token）在浏览器本地生成，用户全程不用复制粘贴。
 *
 * 为什么要绕一层代理：api.cloudflare.com 一个 CORS 头都不返回，浏览器直接调不通，
 * 所有请求都得过中心 worker 的 /cf-api（见 worker/index.js）。
 *
 * 跟「更新后端」的分工：那条路是 worker 拿自己 env 里的 token 覆盖自己
 * （worker/amsg/src/selfUpdate.ts），能保住密钥；这里是从零装，密钥是新生成的。
 */

import { getProxyWorkerUrl } from './proxyWorker';
import { generateVapidKeyPair, generateClientToken } from './vapidGen';

/** 部署出来的 Worker / D1 默认叫这个，跟 worker/amsg/wrangler.toml 对齐。 */
export const AMSG_SCRIPT_NAME = 'sullyos-amsg';
export const AMSG_D1_NAME = 'sullyos-amsg';

/** 上传时的模块名，同时是 metadata.main_module，两处必须一致。 */
const MAIN_MODULE = 'worker.bundle.js';

const BUNDLE_BASE = 'https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg';
const BUNDLE_URL = `${BUNDLE_BASE}/${MAIN_MODULE}`;
const WRANGLER_URL = `${BUNDLE_BASE}/wrangler.toml`;

/**
 * 读不到线上 wrangler.toml 时用的兜底，值抄自 worker/amsg/wrangler.toml。
 * 正常路径是现拉现解析，免得这边的常量和 worker 那边慢慢漂开——
 * compatibility_flags 少一个 global_fetch_strictly_public，角色调自配 MCP 就会 1042。
 */
const FALLBACK_CONFIG: WorkerDeployConfig = {
  compatibilityDate: '2026-01-01',
  compatibilityFlags: ['global_fetch_strictly_public'],
  crons: ['* * * * *'],
  d1Binding: 'DB',
};

/** bundle 的合理体积区间。太小多半是拉到了 404 页面，太大是打包出了岔子。 */
const MIN_BUNDLE_BYTES = 100 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export interface WorkerDeployConfig {
  compatibilityDate: string;
  compatibilityFlags: string[];
  crons: string[];
  d1Binding: string;
}

export interface CfAccount {
  id: string;
  name: string;
}

export type ProvisionStepId =
  | 'relay'
  | 'token'
  | 'account'
  | 'database'
  | 'subdomain'
  | 'bundle'
  | 'upload'
  | 'cron'
  | 'expose'
  | 'done';

export interface ProvisionProgress {
  step: ProvisionStepId;
  message: string;
}

export interface AmsgSecrets {
  AMSG_MASTER_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_EMAIL: string;
  AMSG_SERVER_TOKEN: string;
}

export interface ProvisionInput {
  token: string;
  /** 多账号时由界面选定；只有一个能用就自动选。 */
  accountId?: string;
  /** 账号还没有 workers.dev 子域时，由界面问出来再传进来。 */
  desiredSubdomain?: string;
  scriptName?: string;
  /**
   * D1 库名。跟 scriptName 一样默认 sullyos-amsg，两个都能改是为了在同一个账号里
   * 装第二套时不会撞上——尤其别让新实例静默绑到已有实例的生产库上。
   */
  databaseName?: string;
  /** 复用已有密钥（重装时传，避免换掉 Master Key 让旧任务解不开）。 */
  secrets?: Partial<AmsgSecrets>;
  /**
   * 复用的同名库里有旧数据、本机又没有旧 Master Key 时，用户确认「旧数据不要了」才传。
   * 传了就在上传前把库里的数据清空，新密钥从一张白纸开始写。
   */
  resetExistingDatabase?: boolean;
  onProgress?: (p: ProvisionProgress) => void;
}

export type ProvisionFailureCode =
  | 'RELAY_UNSUPPORTED'
  | 'TOKEN_INVALID'
  | 'TOKEN_NOT_YET_VALID'
  | 'SCRIPT_NAME_UNKNOWN'
  | 'SCRIPT_NOT_FOUND'
  | 'NO_USABLE_ACCOUNT'
  | 'ACCOUNT_AMBIGUOUS'
  | 'SUBDOMAIN_MISSING'
  | 'SUBDOMAIN_TAKEN'
  | 'BUNDLE_INVALID'
  | 'SCRIPT_EXISTS'
  | 'UPLOAD_FAILED'
  | 'CF_ERROR'
  | 'DATABASE_KEY_MISSING'
  | 'NETWORK';

export interface ProvisionFailure {
  ok: false;
  code: ProvisionFailureCode;
  message: string;
  /** ACCOUNT_AMBIGUOUS 时给界面挑。 */
  accounts?: CfAccount[];
}

export interface ProvisionSuccess {
  ok: true;
  workerUrl: string;
  scriptName: string;
  accountId: string;
  databaseId: string;
  /** 用的是已经存在的同名数据库（不是新建的），界面要提醒一句。 */
  reusedDatabase: boolean;
  secrets: AmsgSecrets;
  /** observability 是尽力而为，没开成不影响功能，但值得说一声。 */
  warnings: string[];
}

export type ProvisionResult = ProvisionSuccess | ProvisionFailure;

// ---------------------------------------------------------------------------
// 纯函数部分（可单测，不碰网络）
// ---------------------------------------------------------------------------

/**
 * 从 wrangler.toml 里挑出部署要用的四项。不是通用 TOML 解析器，只认这几个键；
 * 任何一项没匹配上就用兜底值，绝不返回半份配置——少一个 compat flag 比整个失败更难查。
 */
export function parseWranglerConfig(toml: string): WorkerDeployConfig {
  const stripComments = (line: string) => line.replace(/#.*$/, '').trim();
  const lines = toml.split('\n').map(stripComments);

  const findScalar = (key: string): string | null => {
    for (const line of lines) {
      const m = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"$`));
      if (m) return m[1];
    }
    return null;
  };
  const findArray = (key: string): string[] | null => {
    for (const line of lines) {
      const m = line.match(new RegExp(`^${key}\\s*=\\s*\\[(.*)\\]$`));
      if (!m) continue;
      const items = m[1]
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
      return items;
    }
    return null;
  };

  // binding 名在 [[d1_databases]] 段里，跟顶层的同名键区分开：取该段之后第一个 binding。
  let d1Binding: string | null = null;
  const d1SectionIdx = lines.findIndex((l) => l === '[[d1_databases]]');
  if (d1SectionIdx >= 0) {
    for (let i = d1SectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('[')) break;
      const m = lines[i].match(/^binding\s*=\s*"([^"]*)"$/);
      if (m) {
        d1Binding = m[1];
        break;
      }
    }
  }

  return {
    compatibilityDate: findScalar('compatibility_date') || FALLBACK_CONFIG.compatibilityDate,
    compatibilityFlags: findArray('compatibility_flags') || FALLBACK_CONFIG.compatibilityFlags,
    crons: findArray('crons') || FALLBACK_CONFIG.crons,
    d1Binding: d1Binding || FALLBACK_CONFIG.d1Binding,
  };
}

/**
 * 即时对话起跳器的 binding 名 / 类名 / 建库用的 migration tag。
 *
 * 三处必须跟 worker 侧对齐：`worker/amsg/wrangler.toml`、`worker/amsg/src/index.ts`
 * 里的 `InstantTickDO`、以及 `selfUpdate.ts`（老 Worker 更新时补建走那条）。
 */
const INSTANT_TICK_BINDING = 'INSTANT_TICK';
const INSTANT_TICK_CLASS = 'InstantTickDO';
export const INSTANT_TICK_MIGRATIONS = {
  new_tag: 'amsg-instant-tick-v1',
  new_sqlite_classes: [INSTANT_TICK_CLASS],
};

/**
 * 拼上传用的 bindings。D1 一条 + Durable Object 一条 + 每个非空密钥一条。
 *
 * 空值一律不写：Cloudflare 会原样收下空字符串，而 worker 侧
 * 「配了 AMSG_SERVER_TOKEN 就强制校验 X-Client-Token」判断的是有没有这一项——
 * 塞个空串进去，等于打开了一道永远对不上的门。
 *
 * Durable Object 不用先建资源：namespace 会随这次上传一起创建（靠 metadata 里的
 * migrations，见 INSTANT_TICK_MIGRATIONS），不像 D1 要先调一次建库接口拿 id。
 */
export function buildBindings(
  d1Binding: string,
  databaseId: string,
  secrets: AmsgSecrets,
  extras: Record<string, string> = {},
): Array<Record<string, string>> {
  const bindings: Array<Record<string, string>> = [
    { type: 'd1', name: d1Binding, id: databaseId },
    { type: 'durable_object_namespace', name: INSTANT_TICK_BINDING, class_name: INSTANT_TICK_CLASS },
  ];
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value === 'string' && value.trim()) {
      bindings.push({ type: 'secret_text', name, text: value });
    }
  }
  for (const [name, value] of Object.entries(extras)) {
    if (typeof value === 'string' && value.trim()) {
      bindings.push({ type: 'secret_text', name, text: value });
    }
  }
  return bindings;
}

/** workers.dev 的地址就是「脚本名.账号子域.workers.dev」。 */
export function deriveWorkerUrl(scriptName: string, subdomain: string): string {
  return `https://${scriptName}.${subdomain}.workers.dev`;
}

/**
 * 反过来：从后端地址认出这个 Worker 在 Cloudflare 上叫什么。
 *
 * 只有 `<脚本名>.<子域>.workers.dev` 这种地址认得出。自定义域名、Deno 门面那类
 * 代理地址跟脚本名没有关系，猜出来的名字会指向别的 Worker——宁可返回 null 让界面
 * 问一句，也不能猜。（worker 侧 selfUpdate.ts 的 resolveScriptName 是同一套规矩。）
 */
export function scriptNameFromWorkerUrl(workerUrl: string): string | null {
  try {
    const host = new URL(workerUrl.trim()).hostname.toLowerCase();
    const parts = host.split('.');
    // <script>.<subdomain>.workers.dev → 至少四段
    if (parts.length < 4) return null;
    if (parts.slice(-2).join('.') !== 'workers.dev') return null;
    return parts[0] || null;
  } catch {
    return null;
  }
}

/**
 * 把 Cloudflare 的报错翻译成能照着做的话，末尾一律缀上原文。
 *
 * 翻译是给用户看的，原文是给排障用的，两个都要有：
 *
 * - 权限类最常见——用户建 token 时少勾一项，光看「Unauthorized」根本不知道少了哪个，
 *   所以要翻译；
 * - 可 401/403 的不只 Cloudflare。中转层（路径不让走、没带 Authorization）和路上的
 *   WAF 也回这两个码，一样会被翻成「权限不够」，于是 token 明明没问题的人被指使着
 *   反复去改 token。原文里有没有 CF 的 code、是不是 proxy 那句话，一眼就分得开。
 *
 * 原文取 CF 的 `errors[].message`；中转层的错误体是 `{ error }`，不是同一个形状，
 * 单独捞一手。两边都没有（非 JSON 响应）就只剩 HTTP 状态码，那也得说出来。
 *
 * `request` 是出事的那个请求（方法 + 路径）。部署要连着调七八个接口，光有一句报错
 * 认不出卡在建库还是传代码，界面上的步骤名又在失败时就清掉了。
 */
export function explainCfError(status: number, body: unknown, request?: string): string {
  const payload = body as {
    errors?: Array<{ code?: number; message?: string }>;
    error?: string;
  } | null;
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const code = errors[0]?.code;
  const raw =
    errors.map((e) => e?.message).filter(Boolean).join('；')
    || (typeof payload?.error === 'string' ? payload.error : '');

  const PERMISSION_HINT =
    'Token 权限不够。建 token 时这三项都要勾上：Account → Workers Scripts:Edit、'
    + 'Account → D1:Edit、Account → Account Settings:Read。';

  const explain = (): string => {
    if (code === 6003 || code === 6111) return 'Token 格式不对，多半是复制时多带了空格或换行。';
    if (code === 9109 || code === 10000 || status === 401 || status === 403) return PERMISSION_HINT;
    if (code === 10016) return 'Worker 名字不合法。';
    if (code === 10027) return 'Worker 代码超过 Cloudflare 的体积上限，装不上去。';
    if (code === 10037) return '这个账号的 Worker 数量已经到上限了，先去面板删掉不用的。';
    if (code === 10054 || code === 10055) return '密钥数量或长度超限。';
    if (code === 7003) return '请求路径不对（多半是代理那边的问题，不是你的 token）。';
    return '这个错没见过，照原文查吧。';
  };

  const detail = `原文：${raw || '（空）'}｜code ${code ?? '无'}｜HTTP ${status}`;
  return `${explain()}\n${detail}${request ? `｜${request}` : ''}`;
}

/**
 * 校验用户想要的 workers.dev 子域。CF 的规矩是小写字母数字和连字符，
 * 不能以连字符开头结尾。这里先挡一道，省得为一个明显不合法的名字跑一趟网络。
 */
export function validateSubdomain(name: string): string | null {
  const s = name.trim().toLowerCase();
  if (!s) return '子域名不能为空。';
  if (s.length < 3 || s.length > 63) return '子域名长度要在 3~63 个字符之间。';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) {
    return '子域名只能用小写字母、数字和连字符，且不能以连字符开头或结尾。';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 网络层：所有 CF 请求都过中心 worker 的 /cf-api
// ---------------------------------------------------------------------------

interface CfResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  /** 已经翻成人话的错误，ok 为 false 时有值。 */
  error?: string;
}

const relayUrl = (apiPath: string): string =>
  `${getProxyWorkerUrl()}/cf-api?path=${encodeURIComponent(apiPath)}`;

async function cfApi<T = unknown>(
  token: string,
  apiPath: string,
  init: { method?: string; body?: FormData | string; contentType?: string } = {},
): Promise<CfResponse<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-CF-Method': init.method || 'GET',
  };
  // FormData 交给浏览器自己带 Content-Type（里面有 multipart 的 boundary），别手写。
  if (init.contentType && !(init.body instanceof FormData)) {
    headers['Content-Type'] = init.contentType;
  }
  let res: Response;
  try {
    res = await fetch(relayUrl(apiPath), { method: 'POST', headers, body: init.body });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: `连不上代理（${String((e as Error)?.message || e)}）。检查网络，或在设置里换一个网络代理 Worker。`,
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON（代理层的纯文本错误）就留 null，下面按状态码处理 */
  }
  const success = res.ok && (body as { success?: boolean } | null)?.success !== false;
  return {
    ok: success,
    status: res.status,
    body: body as T,
    error: success ? undefined : explainCfError(res.status, body, `${init.method || 'GET'} ${apiPath}`),
  };
}

/** DO migration 的乐观锁冲突：这个 Worker 已经应用过 migration，「全新部署」的断言不成立。 */
const MIGRATION_TAG_CONFLICT = 10079;

function firstCfErrorCode(body: unknown): number | null {
  const errors = (body as { errors?: Array<{ code?: number }> } | null)?.errors;
  return (Array.isArray(errors) && errors.length ? errors[0]?.code : null) ?? null;
}

async function putScript(
  token: string,
  accountId: string,
  scriptName: string,
  metadata: Record<string, unknown>,
  code: string,
): Promise<CfResponse> {
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(MAIN_MODULE, new Blob([code], { type: 'application/javascript+module' }), MAIN_MODULE);
  return cfApi(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`, {
    method: 'PUT',
    body: form,
  });
}

/**
 * 上传 Worker 脚本。metadata 带着建 DO namespace 的 migrations，等于断言「全新部署」；
 * 对着一个已经装过的 Worker 重装（清了地址重跑、换设备对同一个账号再部署）时这个断言
 * 不成立，CF 会回 10079 把整次上传顶回来。
 *
 * 这时 namespace 本来就已经在了，migrations 纯属多余——去掉重传一次即可，binding 原样
 * 保留（与 worker 侧 selfUpdate 的补建路径同一套实测结论：migration_tag 不变、DO 类还在）。
 * 只对 10079 重试：全新部署一次就过，其他错误照旧当场返回。
 */
export async function uploadWorkerScript(
  token: string,
  accountId: string,
  scriptName: string,
  metadata: Record<string, unknown>,
  code: string,
): Promise<CfResponse & { reusedExistingWorker?: boolean }> {
  const first = await putScript(token, accountId, scriptName, metadata, code);
  if (first.ok || firstCfErrorCode(first.body) !== MIGRATION_TAG_CONFLICT) return first;

  const withoutMigrations = { ...metadata };
  delete withoutMigrations.migrations;
  const second = await putScript(token, accountId, scriptName, withoutMigrations, code);
  return second.ok ? { ...second, reusedExistingWorker: true } : second;
}

/** 当前生效的网络代理 Worker 支不支持一键部署（老版本没有 /cf-api 这条路由）。 */
export async function checkRelayAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${getProxyWorkerUrl()}/cf-api`, { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json()) as { relay?: string };
    return body?.relay === 'cf-api';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

interface CfListEnvelope<T> {
  result?: T[];
}
interface CfItemEnvelope<T> {
  result?: T;
}

/** 账号令牌的前缀。它属于账号本身、不属于任何用户，这里不支持，见 verifyToken。 */
const ACCOUNT_TOKEN_PREFIX = 'cfat_';

export const isAccountScopedToken = (token: string): boolean =>
  token.trim().startsWith(ACCOUNT_TOKEN_PREFIX);

interface CfVerifyResult {
  result?: { status?: string; not_before?: string; expires_on?: string };
  messages?: Array<{ code?: number; message?: string }>;
}

/**
 * 验 token。只认普通 API Token（属于用户那种）。
 *
 * 账号令牌（cfat_ 开头）是另一套东西：它不属于任何用户，`/user/tokens/verify` 和
 * `/accounts` 对它一律 401，于是没法自动找账号，用户还得自己去抄一串 Account ID。
 * 而普通 Token 建的时候一样能把范围限定到单个账号，权限一样小、还省一次粘贴——
 * 所以这里直接不支持它，认出来就明说该换哪种，别让人对着 401 猜。
 *
 * 另一个坑：**token 还没到生效日期时，verify 照样返回 success: true**，只在 messages
 * 里塞一条 code 10002。放它过去的话，后面每一步都收到通用的 Authentication error，
 * 会被归成「权限不够」——用户跑去改权限，可那根本不是原因。真机上踩过。
 */
export async function verifyToken(
  token: string,
): Promise<{ ok: true } | { ok: false; code: ProvisionFailureCode; message: string }> {
  if (isAccountScopedToken(token)) {
    return {
      ok: false,
      code: 'TOKEN_INVALID',
      message:
        '这是一枚账号令牌（cfat_ 开头），这里用不了。'
        + '去 Cloudflare 右上角头像 → My Profile → API Tokens 建一枚普通的 API Token，'
        + '建的时候在 Account Resources 里选上你要装到的那个账号就行。',
    };
  }

  const res = await cfApi<CfVerifyResult>(token, '/user/tokens/verify');
  if (!res.ok) {
    return { ok: false, code: 'TOKEN_INVALID', message: res.error || 'Token 验证不通过。' };
  }

  const notYet = (res.body?.messages ?? []).find((m) => m.code === 10002);
  if (notYet) {
    return {
      ok: false,
      code: 'TOKEN_NOT_YET_VALID',
      message:
        `这枚 Token 还没到生效时间，现在用不了。${notYet.message ? `\nCloudflare 说：${notYet.message}` : ''}`
        + '\n重新建一枚，把「Start Date」留空或设成今天。',
    };
  }
  const status = res.body?.result?.status;
  if (status && status !== 'active') {
    return { ok: false, code: 'TOKEN_INVALID', message: `这枚 Token 的状态是 ${status}，不能用。` };
  }
  return { ok: true };
}

/**
 * 找出这枚 token 真正能用的账号。
 *
 * GET /accounts 是用户级端点，返回这人名下所有账号，跟 token 授权了哪个无关，
 * 所以不能直接拿第一个用。挨个问「这个账号下能不能列 Worker」，能列的才算数。
 */
async function findUsableAccounts(token: string): Promise<CfResponse<CfAccount[]>> {
  const listed = await cfApi<CfListEnvelope<CfAccount>>(token, '/accounts?per_page=50');
  if (!listed.ok) return { ...listed, body: null } as CfResponse<CfAccount[]>;
  const all = listed.body?.result ?? [];
  const usable: CfAccount[] = [];
  for (const acc of all) {
    const probe = await cfApi(token, `/accounts/${acc.id}/workers/scripts`);
    if (probe.ok) usable.push({ id: acc.id, name: acc.name });
  }
  return { ok: true, status: 200, body: usable };
}

async function ensureDatabase(
  token: string,
  accountId: string,
  databaseName: string,
): Promise<{ ok: true; id: string; reused: boolean } | { ok: false; error: string }> {
  const existing = await cfApi<CfListEnvelope<{ uuid?: string; name?: string }>>(
    token,
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}`,
  );
  if (existing.ok) {
    const hit = (existing.body?.result ?? []).find((db) => db.name === databaseName && db.uuid);
    if (hit?.uuid) return { ok: true, id: hit.uuid, reused: true };
  }
  const created = await cfApi<CfItemEnvelope<{ uuid?: string }>>(
    token,
    `/accounts/${accountId}/d1/database`,
    { method: 'POST', body: JSON.stringify({ name: databaseName }), contentType: 'application/json' },
  );
  const uuid = created.body?.result?.uuid;
  if (!created.ok || !uuid) {
    return { ok: false, error: created.error || '建数据库失败，Cloudflare 没有返回数据库 id。' };
  }
  return { ok: true, id: uuid, reused: false };
}

/** 后端存加密数据的表。这几张里有一行，就说明库里有用某把 Master Key 加密过的东西。 */
const ENCRYPTED_DATA_TABLES = [
  'client_state',
  'scheduled_messages',
  'push_subscriptions',
  'llm_credentials',
  'message_outbox',
  'cloud_resource_metadata',
];

async function queryD1<Row>(
  token: string,
  accountId: string,
  databaseId: string,
  sql: string,
): Promise<{ ok: true; rows: Row[] } | { ok: false; error: string }> {
  const res = await cfApi<CfItemEnvelope<Array<{ results?: Row[] }>>>(
    token,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: 'POST', body: JSON.stringify({ sql }), contentType: 'application/json' },
  );
  if (!res.ok) return { ok: false, error: res.error || '查询数据库失败。' };
  return { ok: true, rows: res.body?.result?.[0]?.results ?? [] };
}

/**
 * 复用同名库之前的把关。
 *
 * 库里的数据是用当初那把 Master Key 加密的。本机没存那把钥匙的话，这次会生成一把新的，
 * 装好后一读写旧数据就报 `Decryption failed`。所以库里有数据又没有旧钥匙时先停下，
 * 让用户选：回到存着钥匙的那台设备上部署，或者确认清空旧数据。只有用户点了确认
 * （reset）才真的清。
 */
export async function guardReusedDatabase(input: {
  token: string;
  accountId: string;
  databaseId: string;
  databaseName: string;
  hasExistingMasterKey: boolean;
  reset?: boolean;
}): Promise<{ ok: true; cleared: boolean } | ProvisionFailure> {
  if (input.hasExistingMasterKey) return { ok: true, cleared: false };
  const { token, accountId, databaseId, databaseName } = input;

  const listed = await queryD1<{ name?: string }>(
    token,
    accountId,
    databaseId,
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  if (!listed.ok) {
    return {
      ok: false,
      code: 'CF_ERROR',
      message: `检查已有的数据库 ${databaseName} 时出错（${listed.error}）。确认 Token 勾了 D1 : Edit 再试一次。`,
    };
  }
  // sqlite_ / _cf_ 开头的是 SQLite 和 D1 自己的表，d1_migrations 归 wrangler，都不归后端管，也删不得。
  const userTables = listed.rows
    .map((row) => row.name || '')
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name) && !/^(sqlite_|_cf_|d1_migrations$)/.test(name));
  const encryptedTables = userTables.filter((name) => ENCRYPTED_DATA_TABLES.includes(name));
  if (encryptedTables.length === 0) return { ok: true, cleared: false };

  const probe = await queryD1<{ has_data?: number }>(
    token,
    accountId,
    databaseId,
    `SELECT ${encryptedTables.map((name) => `EXISTS(SELECT 1 FROM "${name}")`).join(' OR ')} AS has_data`,
  );
  if (!probe.ok) {
    return {
      ok: false,
      code: 'CF_ERROR',
      message: `检查已有的数据库 ${databaseName} 时出错（${probe.error}）。`,
    };
  }
  if (!probe.rows[0]?.has_data) return { ok: true, cleared: false };

  if (!input.reset) {
    return {
      ok: false,
      code: 'DATABASE_KEY_MISSING',
      message:
        `账号里已经有一个装过后端的数据库 ${databaseName}，里面的数据是用之前那把 Master Key 加密的，`
        + '而这台设备上没存那把钥匙。直接装的话会生成一把新钥匙，旧数据就解不开了，主动消息会一直报「解密失败」。\n'
        + '之前部署的那台设备还在的话，去那台上点「开始部署」，会沿用原来的钥匙，数据都在。'
        + '找不回来的话，点下面的按钮清空旧数据再装（已排的主动消息、云端保存的角色状态会一起清掉）。',
    };
  }

  // 一张一条请求：表不多，逐条删出错时也知道是哪张。
  for (const name of userTables) {
    const deleted = await queryD1(token, accountId, databaseId, `DELETE FROM "${name}"`);
    if (!deleted.ok) {
      return {
        ok: false,
        code: 'CF_ERROR',
        message: `清空旧数据时在 ${name} 这张表上出错（${deleted.error}）。再点一次会接着清。`,
      };
    }
  }
  return { ok: true, cleared: true };
}

/**
 * 拿账号的 workers.dev 子域；没有就用 desiredSubdomain 注册一个。
 * 全新的 Cloudflare 账号是没有子域的，而它决定了最终的 Worker 地址，绕不过去。
 */
export async function ensureSubdomain(
  token: string,
  accountId: string,
  desired?: string,
): Promise<{ ok: true; subdomain: string } | { ok: false; code: ProvisionFailureCode; error: string }> {
  const current = await cfApi<CfItemEnvelope<{ subdomain?: string }>>(
    token,
    `/accounts/${accountId}/workers/subdomain`,
  );
  // 401/403 是「没让我读」，不是「这个账号没有子域名」。不单独拎出来的话，下面会把它
  // 当成新账号，请用户起一个名字——而读都读不动，注册那一步同样过不去，用户于是对着
  // 「换一个名字再试」换个不停。只挑这两个状态码：账号真没有子域名时 CF 回什么没实测过，
  // 把所有失败都当权限的话，会把全新账号堵死在这里，那比现在更糟。
  if (!current.ok && (current.status === 401 || current.status === 403)) {
    return {
      ok: false,
      code: 'CF_ERROR',
      error: `读不到这个账号的 workers.dev 子域名。\n${current.error}`,
    };
  }
  const existing = current.body?.result?.subdomain;
  if (current.ok && existing) return { ok: true, subdomain: existing };

  if (!desired) {
    return {
      ok: false,
      code: 'SUBDOMAIN_MISSING',
      error: '这个 Cloudflare 账号还没有 workers.dev 子域名，需要先起一个。',
    };
  }
  const invalid = validateSubdomain(desired);
  if (invalid) return { ok: false, code: 'SUBDOMAIN_MISSING', error: invalid };

  const registered = await cfApi(token, `/accounts/${accountId}/workers/subdomain`, {
    method: 'PUT',
    body: JSON.stringify({ subdomain: desired.trim().toLowerCase() }),
    contentType: 'application/json',
  });
  if (!registered.ok) {
    return {
      ok: false,
      code: 'SUBDOMAIN_TAKEN',
      error: `${desired} 这个子域名注册不下来（多半被别人占了）。换一个再试。${registered.error ? `\n${registered.error}` : ''}`,
    };
  }
  return { ok: true, subdomain: desired.trim().toLowerCase() };
}

async function fetchBundle(): Promise<{ ok: true; code: string; config: WorkerDeployConfig } | { ok: false; error: string }> {
  let code: string;
  try {
    const res = await fetch(BUNDLE_URL, { cache: 'no-store' });
    if (!res.ok) return { ok: false, error: `拉取 Worker 代码失败（HTTP ${res.status}）。` };
    code = await res.text();
  } catch (e) {
    return { ok: false, error: `拉取 Worker 代码失败：${String((e as Error)?.message || e)}` };
  }
  const bytes = new TextEncoder().encode(code).length;
  if (bytes < MIN_BUNDLE_BYTES || bytes > MAX_BUNDLE_BYTES) {
    return { ok: false, error: `拉到的 Worker 代码大小不对（${bytes} 字节），没敢往上传。` };
  }
  if (!code.includes('src_default as default')) {
    return { ok: false, error: '拉到的文件不像是打包好的 Worker，没敢往上传。' };
  }

  // 配置跟着 bundle 一起从线上拿，拿不到就用兜底，不因为这个中断部署。
  let config = FALLBACK_CONFIG;
  try {
    const res = await fetch(WRANGLER_URL, { cache: 'no-store' });
    if (res.ok) config = parseWranglerConfig(await res.text());
  } catch {
    /* 用兜底 */
  }
  return { ok: true, code, config };
}

/**
 * 等新部署的 Worker 真的能响应。
 *
 * 刚建好的 workers.dev 地址要过一会儿才解析得到（实测上传成功后还得几十秒）。
 * **这期间 Cloudflare 会返回它自己的 404 占位页**，所以「收到 HTTP 响应」不能当成
 * 活了的判据——真机上就是这么误判的，紧接着去建表必然失败。
 * 占位页是 text/html，Worker 一律回 JSON，拿 Content-Type 分得干净。
 *
 * 超时返回 false 而不是抛错：没等到不代表装失败，让调用方提示「过会儿点连接」即可。
 */
export async function waitForWorkerReady(workerUrl: string, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // 新地址在各个边缘节点上不是同时生效的：探到一次成功、下一秒又落到没生效的节点上，
  // 真机上就这么反复了几轮。连着两次才算数，把这个抖动期让过去。
  const NEEDED_STREAK = 2;
  let streak = 0;
  let delay = 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${workerUrl}/config-check`, { method: 'GET', cache: 'no-store' });
      streak = res.headers.get('content-type')?.includes('json') ? streak + 1 : 0;
      if (streak >= NEEDED_STREAK) return true;
    } catch {
      streak = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 5000);
  }
  return false;
}

/** 生成这套后端要的全部密钥。已有的原样保留（重装时不换 Master Key）。 */
export async function generateAmsgSecrets(existing: Partial<AmsgSecrets> = {}): Promise<AmsgSecrets> {
  const vapid = existing.VAPID_PUBLIC_KEY && existing.VAPID_PRIVATE_KEY
    ? { publicKey: existing.VAPID_PUBLIC_KEY, privateKey: existing.VAPID_PRIVATE_KEY }
    : await generateVapidKeyPair();
  const masterKey = existing.AMSG_MASTER_KEY
    || Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  return {
    AMSG_MASTER_KEY: masterKey,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_EMAIL: existing.VAPID_EMAIL || '',
    AMSG_SERVER_TOKEN: existing.AMSG_SERVER_TOKEN || generateClientToken(),
  };
}

/**
 * 给一台**已经装好的**后端补上「自己更新自己」的能力。
 *
 * 老办法装的（fork 仓库 / 部署按钮 / 手动粘代码）Worker 里没有 CF_API_TOKEN，点「更新
 * 后端」会被顶回来，原本得去 Cloudflare 面板手动加一条密钥。这里用 Workers 的密钥接口
 * （`PUT .../secrets`）单独写这一条——**它不碰脚本，也不碰其它绑定**，所以对手动部署的
 * 用户是安全的：前端手里没有他们的 Master Key，走上传那条路会把密钥抹掉，走这条不会。
 *
 * 写完 token 就留在用户自己的 Worker 里，前端不保存。
 */
export async function attachUpdateCapability(input: {
  token: string;
  /** 用户当前配的后端地址，用来认出脚本叫什么。 */
  workerUrl: string;
  /** 地址是自定义域名 / 代理时认不出来，由界面问出来再传进来。 */
  scriptName?: string;
  accountId?: string;
  onProgress?: (p: ProvisionProgress) => void;
}): Promise<
  | { ok: true; accountId: string; scriptName: string }
  | { ok: false; code: ProvisionFailureCode; message: string; accounts?: CfAccount[] }
> {
  const token = input.token.trim();
  const report = (step: ProvisionStepId, message: string) => input.onProgress?.({ step, message });

  report('relay', '检查中转是否可用…');
  if (!(await checkRelayAvailable())) {
    return {
      ok: false,
      code: 'RELAY_UNSUPPORTED',
      message: '当前的网络代理 Worker 不支持这个操作（缺 /cf-api）。把代理地址改回默认的再试。',
    };
  }

  report('token', '验证 Token…');
  const verified = await verifyToken(token);
  if (!verified.ok) return { ok: false, code: verified.code, message: verified.message };

  const scriptName = input.scriptName?.trim() || scriptNameFromWorkerUrl(input.workerUrl);
  if (!scriptName) {
    return {
      ok: false,
      code: 'SCRIPT_NAME_UNKNOWN',
      message:
        '认不出你这台后端在 Cloudflare 上叫什么名字（地址不是 workers.dev 那种，多半套了自定义域名或代理）。'
        + '去 Cloudflare 的 Workers 列表看一眼它的名字，填进来。',
    };
  }

  report('account', '找这台 Worker 在哪个账号下…');
  const scriptPath = (accId: string) =>
    `/accounts/${accId}/workers/scripts/${encodeURIComponent(scriptName)}`;

  let accountId = input.accountId?.trim() || '';
  if (accountId) {
    const found = await cfApi(token, `${scriptPath(accountId)}/settings`);
    if (!found.ok) {
      return {
        ok: false,
        code: 'SCRIPT_NOT_FOUND',
        message: `这个账号下没找到名叫 ${scriptName} 的 Worker。`,
      };
    }
  } else {
    const accounts = await findUsableAccounts(token);
    if (!accounts.ok) {
      return { ok: false, code: 'CF_ERROR', message: accounts.error || '读取账号列表失败。' };
    }
    // 挨个账号问「你这儿有没有这个 Worker」。同名 Worker 可能在多个账号里都存在，
    // 那就得让用户自己指认，别替他猜一个写进去。
    const owners: CfAccount[] = [];
    for (const account of accounts.body ?? []) {
      const found = await cfApi(token, `${scriptPath(account.id)}/settings`);
      if (found.ok) owners.push(account);
    }
    if (owners.length === 0) {
      return {
        ok: false,
        code: 'SCRIPT_NOT_FOUND',
        message:
          `这枚 Token 能看到的账号里都没有名叫 ${scriptName} 的 Worker。`
          + '确认一下 Token 建的时候选对账号了没有。',
      };
    }
    if (owners.length > 1) {
      return {
        ok: false,
        code: 'ACCOUNT_AMBIGUOUS',
        message: `有多个账号下都有名叫 ${scriptName} 的 Worker，选一个。`,
        accounts: owners,
      };
    }
    accountId = owners[0].id;
  }

  report('upload', '写入更新用的钥匙…');
  // 两条：token 本身，外加脚本名——地址套了代理时 Worker 认不出自己叫什么，
  // 显式写进去它才知道要更新哪一个。
  for (const [name, text] of [['CF_API_TOKEN', token], ['CF_SCRIPT_NAME', scriptName]]) {
    const written = await cfApi(token, `${scriptPath(accountId)}/secrets`, {
      method: 'PUT',
      body: JSON.stringify({ name, text, type: 'secret_text' }),
      contentType: 'application/json',
    });
    if (!written.ok) {
      return { ok: false, code: 'CF_ERROR', message: `写入 ${name} 失败（${written.error}）。` };
    }
  }

  report('done', '装好了。');
  return { ok: true, accountId, scriptName };
}

/**
 * 全流程。任何一步失败都直接返回，不做回滚——半途失败会留下已经建好的 D1 或 Worker，
 * 但每一步都是「先查后建」，把同样的参数再跑一遍能接着往下走，不会建出第二份。
 */
export async function provisionAmsgBackend(input: ProvisionInput): Promise<ProvisionResult> {
  const scriptName = input.scriptName?.trim() || AMSG_SCRIPT_NAME;
  const databaseName = input.databaseName?.trim() || AMSG_D1_NAME;
  const token = input.token.trim();
  const report = (step: ProvisionStepId, message: string) => input.onProgress?.({ step, message });
  const warnings: string[] = [];

  report('relay', '检查中转是否可用…');
  if (!(await checkRelayAvailable())) {
    return {
      ok: false,
      code: 'RELAY_UNSUPPORTED',
      message:
        '当前的网络代理 Worker 不支持一键部署（缺 /cf-api）。'
        + '如果你在设置里换过代理地址，把它改回默认的，或者把代理 Worker 更新到最新版。',
    };
  }

  report('token', '验证 Token…');
  const verified = await verifyToken(token);
  if (!verified.ok) {
    return { ok: false, code: verified.code, message: verified.message };
  }

  report('account', '查找可用的 Cloudflare 账号…');
  let accountId = input.accountId?.trim() || '';
  if (!accountId) {
    const accounts = await findUsableAccounts(token);
    if (!accounts.ok) {
      return { ok: false, code: 'CF_ERROR', message: accounts.error || '读取账号列表失败。' };
    }
    const usable = accounts.body ?? [];
    if (usable.length === 0) {
      return {
        ok: false,
        code: 'NO_USABLE_ACCOUNT',
        message:
          '这枚 token 在你名下任何一个账号里都没有 Workers 权限。'
          + '重新建一枚，把 Account → Workers Scripts:Edit 勾上。',
      };
    }
    if (usable.length > 1) {
      return {
        ok: false,
        code: 'ACCOUNT_AMBIGUOUS',
        message: '这枚 token 能用在多个账号上，选一个装到哪儿。',
        accounts: usable,
      };
    }
    accountId = usable[0].id;
  }

  report('database', '准备数据库…');
  const db = await ensureDatabase(token, accountId, databaseName);
  if (!db.ok) return { ok: false, code: 'CF_ERROR', message: db.error };
  if (db.reused) {
    const guarded = await guardReusedDatabase({
      token,
      accountId,
      databaseId: db.id,
      databaseName,
      hasExistingMasterKey: Boolean(input.secrets?.AMSG_MASTER_KEY),
      reset: input.resetExistingDatabase,
    });
    if (!guarded.ok) return guarded;
    warnings.push(guarded.cleared
      ? `已清空数据库 ${databaseName} 里的旧数据，新后端从头开始。`
      : `用的是账号里已有的同名数据库 ${databaseName}。如果之前装过一套，两边会共用同一个库。`);
  }

  report('subdomain', '确认 workers.dev 地址…');
  const sub = await ensureSubdomain(token, accountId, input.desiredSubdomain);
  if (!sub.ok) return { ok: false, code: sub.code, message: sub.error };

  report('bundle', '下载最新的后端代码…');
  const bundle = await fetchBundle();
  if (!bundle.ok) return { ok: false, code: 'BUNDLE_INVALID', message: bundle.error };

  report('upload', '上传 Worker…');
  const secrets = await generateAmsgSecrets(input.secrets);
  const metadata = {
    main_module: MAIN_MODULE,
    compatibility_date: bundle.config.compatibilityDate,
    compatibility_flags: bundle.config.compatibilityFlags,
    // CF_API_TOKEN / CF_SCRIPT_NAME 是留给「更新后端」用的：worker 以后拿它自己
    // 覆盖自己，就不用再经过浏览器和中转了。
    bindings: buildBindings(bundle.config.d1Binding, db.id, secrets, {
      CF_API_TOKEN: token,
      CF_SCRIPT_NAME: scriptName,
    }),
    // 实时日志（面板上的 Workers Logs）默认是关的，amsg 排障全靠它。
    // 官方的 multipart-upload-metadata 文档没把 observability 列进合法字段，但实测是认的
    // ——上传 enabled:false 能关掉、true 能开起来、不带就没有，三向都验过。
    observability: { enabled: true, logs: { enabled: true } },
    // 建即时对话起跳器的 Durable Object namespace。不给 old_tag 即断言「还没应用过
    // 任何 migration」；重装撞上 10079 时由 uploadWorkerScript 去掉它重传。注意它是
    // 一个对象，不是 wrangler.toml 里那种数组——传数组会被 10021 顶回来。
    migrations: INSTANT_TICK_MIGRATIONS,
  };
  const uploaded = await uploadWorkerScript(token, accountId, scriptName, metadata, bundle.code);
  if (!uploaded.ok) {
    return { ok: false, code: 'UPLOAD_FAILED', message: uploaded.error || '上传 Worker 失败。' };
  }
  if (uploaded.reusedExistingWorker) {
    warnings.push(`账号里已经有一套装好的 ${scriptName}，这次是在它上面覆盖更新。`);
  }

  report('cron', '设置定时触发…');
  const schedules = await cfApi(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
    {
      method: 'PUT',
      body: JSON.stringify(bundle.config.crons.map((cron) => ({ cron }))),
      contentType: 'application/json',
    },
  );
  if (!schedules.ok) {
    // 这条不能降级成警告：cron 是主动消息唯一的投递触发方式，没有它整个功能不动。
    return {
      ok: false,
      code: 'CF_ERROR',
      message: `定时触发没设上（${schedules.error}）。主动消息全靠它，先解决这个再用。`,
    };
  }

  report('expose', '开启访问地址…');
  const exposed = await cfApi(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    {
      method: 'POST',
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
      contentType: 'application/json',
    },
  );
  if (!exposed.ok) {
    return { ok: false, code: 'CF_ERROR', message: `开启 workers.dev 地址失败（${exposed.error}）。` };
  }

  report('done', '部署完成。');
  return {
    ok: true,
    workerUrl: deriveWorkerUrl(scriptName, sub.subdomain),
    scriptName,
    accountId,
    databaseId: db.id,
    reusedDatabase: db.reused,
    secrets,
    warnings,
  };
}

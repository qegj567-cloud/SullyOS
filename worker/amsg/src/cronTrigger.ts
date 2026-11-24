/**
 * 暂停 / 恢复后台任务：摘掉或加回这台 Worker 的 cron trigger。
 *
 * 主动消息和定时消息都靠 cron 每分钟一跳来投递（见 wrangler.toml 的 [triggers]）。
 * 把 trigger 摘掉，到点的任务就不会被处理，任务本身还在 D1 里排着。加回来之后，晚到
 * 60 分钟以内的照常补发；晚得更久的，一次性任务按过期作废，重复任务快进到下一次（上游
 * 的 STALE_AFTER_MS）。同一角色每跳只投递一条，攒了好几条要分几跳发完。
 *
 * 什么时候用：用户想让角色安静一阵（考试、出差、暂时不想被打扰），又不想逐个角色关开关、
 * 逐条取消任务，回头再一个个排回来。
 *
 * 跟 ./selfUpdate 走的是同一套基础设施：worker 拿自己环境里的 CF_API_TOKEN 调
 * Cloudflare API 改 schedules。浏览器直接调不了（api.cloudflare.com 不返回 CORS 头），
 * 所以这活儿只能落在 worker 这一侧。
 *
 * 这不是永久开关：走 GitHub Actions / wrangler deploy 重新部署时，会按 wrangler.toml
 * 把 cron 加回来。设置页里的「更新 Worker」（自更新）只覆盖脚本代码，不碰 schedules，
 * 所以暂停状态能撑过自更新，但撑不过一次 Sync fork。
 *
 * 安全上跟自更新同一条底线：必须配了共享密钥并校验通过才让动。没配密钥的实例地址等于
 * 全公开，留这个口子相当于谁都能把别人的主动消息关掉。
 */

import { constantTimeEqual } from './instantChat';
import { cf, locateScript, resolveScriptName, type SelfUpdateEnv } from './selfUpdate';

/**
 * 恢复时加回去的 cron 表达式。
 *
 * 必须与 `worker/amsg/wrangler.toml` 的 `[triggers] crons` 一致：worker 运行时读不到那份
 * 配置，所以这里抄一份。改了那边记得同步这里（cronTrigger.test.ts 有一条守卫会对比两处）。
 */
export const AMSG_CRON_EXPRESSION = '* * * * *';

export type CronTriggerFailCode =
  | 'SERVER_TOKEN_REQUIRED'
  | 'UNAUTHORIZED'
  | 'CF_TOKEN_MISSING'
  | 'SCRIPT_NAME_UNKNOWN'
  | 'SCRIPT_NOT_LOCATED'
  | 'CF_ERROR';

export interface CronTriggerFailure {
  code: CronTriggerFailCode;
  message: string;
}

/** `GET /cron-trigger` 的回执：读得到就报开没开，读不到就说明为什么。 */
export type CronTriggerReadResult =
  | { supported: true; enabled: boolean }
  | ({ supported: false } & CronTriggerFailure);

/** `POST /cron-trigger` 的回执。 */
export type CronTriggerWriteResult =
  | { ok: true; enabled: boolean }
  | ({ ok: false } & CronTriggerFailure);

/** 认证没过的两种代号，路由据此回 401 而不是 400。 */
export const isCronTriggerAuthFailure = (code: CronTriggerFailCode): boolean =>
  code === 'SERVER_TOKEN_REQUIRED' || code === 'UNAUTHORIZED';

const fail = (code: CronTriggerFailCode, message: string): CronTriggerFailure => ({ code, message });

/**
 * 认证 + 定位「我是哪台 Worker」，两个端点共用的前半段。
 * 走完拿到的是调 CF API 要用的 token、账号 id 和脚本名；任何一步不通就带着代号返回。
 */
async function prepare(
  env: SelfUpdateEnv,
  request: Request,
): Promise<
  | { ok: true; token: string; schedulesPath: string }
  | { ok: false; failure: CronTriggerFailure }
> {
  const serverToken = env.AMSG_SERVER_TOKEN?.trim();
  if (!serverToken) {
    return {
      ok: false,
      failure: fail(
        'SERVER_TOKEN_REQUIRED',
        '这个 Worker 没设共享密钥（AMSG_SERVER_TOKEN），出于安全考虑不开放暂停后台任务。先补上再试。',
      ),
    };
  }
  // 常时比较：这个端点能把别人的主动消息整个关掉，密钥校验不能从耗时上漏字。
  const clientToken = request.headers.get('X-Client-Token');
  if (!clientToken || !(await constantTimeEqual(clientToken, serverToken))) {
    return { ok: false, failure: fail('UNAUTHORIZED', '共享密钥对不上。') };
  }

  const token = env.CF_API_TOKEN?.trim();
  if (!token) {
    return {
      ok: false,
      failure: fail(
        'CF_TOKEN_MISSING',
        '没配 CF_API_TOKEN，没法改定时触发。去 Cloudflare 建一枚只勾 Workers Scripts → Edit 的 API Token，加进这个 Worker 的变量里。',
      ),
    };
  }

  const scriptName = resolveScriptName(env, request.url);
  if (!scriptName) {
    return {
      ok: false,
      failure: fail(
        'SCRIPT_NAME_UNKNOWN',
        '认不出这个 Worker 叫什么（多半是套了代理域名）。给它加一条 CF_SCRIPT_NAME 变量，值填 Worker 的名字。',
      ),
    };
  }

  const located = await locateScript(env, token, scriptName);
  if (!located.ok) return { ok: false, failure: fail('SCRIPT_NOT_LOCATED', located.message) };

  return {
    ok: true,
    token,
    schedulesPath: `/accounts/${located.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
  };
}

/** CF 回的 schedules 列表。读和写两个接口都是 `result.schedules` 这个形状。 */
const readSchedules = (result: unknown): unknown[] => {
  const schedules = (result as { schedules?: unknown } | null)?.schedules;
  return Array.isArray(schedules) ? schedules : [];
};

/** 查这台 Worker 现在有没有 cron trigger。 */
export async function handleCronTriggerRead(
  env: SelfUpdateEnv,
  request: Request,
): Promise<CronTriggerReadResult> {
  const prepared = await prepare(env, request);
  if (!prepared.ok) return { supported: false, ...prepared.failure };

  const current = await cf(prepared.token, prepared.schedulesPath);
  if (!current.ok) {
    return { supported: false, ...fail('CF_ERROR', `读不到定时触发的状态（${current.detail}）。`) };
  }
  return { supported: true, enabled: readSchedules(current.result).length > 0 };
}

/** 把 cron trigger 摘掉（enabled=false）或加回来（enabled=true）。整体覆盖，不是增删单条。 */
export async function handleCronTriggerWrite(
  env: SelfUpdateEnv,
  request: Request,
  enabled: boolean,
): Promise<CronTriggerWriteResult> {
  const prepared = await prepare(env, request);
  if (!prepared.ok) return { ok: false, ...prepared.failure };

  const schedules = enabled ? [{ cron: AMSG_CRON_EXPRESSION }] : [];
  const written = await cf(prepared.token, prepared.schedulesPath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(schedules),
  });
  if (!written.ok) {
    return {
      ok: false,
      ...fail(
        'CF_ERROR',
        `${enabled ? '恢复' : '暂停'}没成功（${written.detail}）。定时触发保持原样。`,
      ),
    };
  }
  return { ok: true, enabled };
}

/**
 * App 冷启动时顺手把后端更新一下。
 *
 * 为什么要有这一下：前端是 Netlify 自动发的，用户一打开就是新版；后端 Worker 靠 cron 每
 * 几小时自查一次（worker/amsg/src/autoUpdate.ts）。两边一起改的功能，就有几小时是
 * 「前端已经会了、后端还不会」。前端刚换了构建，正是最该催后端一下的时候。
 *
 * 怎么催，看那台 Worker 是哪一版（`GET /config-check` 的 workerVersion）：
 *   - 版本对不上 → 直接打 `POST /self-update`，跟用户在设置页点「更新 Worker」一模一样。
 *     这条路老 bundle 也有，所以存量用户的 Worker 不用谁来点，冷启动一次就换上新代码；
 *     新代码自带 cron 自查，之后就不用这里管了。
 *   - 版本对得上、而且它有自更新能力 → 敲一下 `POST /self-update/check`，让它按内容指纹自己
 *     判要不要换（没抬版本号的改动也能跟上）。
 *
 * 节流两层：这里按「构建换了没 / 离上次够不够久」决定发不发；worker 那边的 check 再按它自己
 * 的时钟决定真查不查。这里不发就一个请求都没有——手机上一天开十几次 App 不该次次去敲门。
 */

import { ActiveMsgClient, type AmsgWorkerVersionProbe } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { BUILD_LABEL } from './buildInfo';

/** 同一个构建下，两次敲门至少隔这么久。 */
export const STARTUP_UPDATE_CHECK_MIN_INTERVAL_MS = 6 * 60 * 60_000;

/** localStorage 里记「上次是哪个构建、什么时候敲的门」。 */
export const STARTUP_UPDATE_CHECK_STORAGE_KEY = 'amsg_worker_update_check';

export interface StartupUpdateCheckMarker {
  buildLabel: string;
  atMs: number;
}

/**
 * 该不该敲门。构建换了 → 该；没换但离上次够久 → 该；其余不该。
 * 纯函数，方便钉住这条判断。
 */
export const shouldRequestStartupUpdateCheck = (
  marker: StartupUpdateCheckMarker | null,
  buildLabel: string,
  nowMs: number,
): boolean => {
  if (!marker) return true;
  if (marker.buildLabel !== buildLabel) return true;
  return nowMs - marker.atMs >= STARTUP_UPDATE_CHECK_MIN_INTERVAL_MS;
};

export const readStartupUpdateCheckMarker = (): StartupUpdateCheckMarker | null => {
  try {
    const raw = localStorage.getItem(STARTUP_UPDATE_CHECK_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StartupUpdateCheckMarker> | null;
    if (!value || typeof value.buildLabel !== 'string' || typeof value.atMs !== 'number') return null;
    return { buildLabel: value.buildLabel, atMs: value.atMs };
  } catch {
    return null;
  }
};

const writeStartupUpdateCheckMarker = (marker: StartupUpdateCheckMarker): void => {
  try {
    localStorage.setItem(STARTUP_UPDATE_CHECK_STORAGE_KEY, JSON.stringify(marker));
  } catch {
    // 存不下就下次再敲一次，无非多一个请求。
  }
};

/** 探完版本之后该走哪条路。纯函数，方便钉住这条判断。 */
export const pickStartupUpdateAction = (
  probe: Pick<AmsgWorkerVersionProbe, 'state' | 'autoUpdate'>,
): 'self-update' | 'check' | 'none' => {
  if (probe.state === 'outdated') return 'self-update';
  if (probe.state === 'current' && probe.autoUpdate?.supported) return 'check';
  return 'none';
};

/**
 * 冷启动那一下调一次。返回值只为单测与日志：
 *   - 'updated' / 'update-failed'：版本对不上，直接更新了一次（成没成看返回值）；
 *   - 'requested'：版本对得上，敲了门让它按指纹自查（worker 收没收下看它自己）；
 *   - 'skipped'：探不到版本、或版本对得上但它没自更新能力，什么都没做；
 *   - 'throttled'：构建没换、也没到时候；
 *   - 'worker-unset'：没配 Worker 或还没连上过，一个请求都不发。
 *
 * 试过就记时刻，不管结果：没钥匙的 Worker 更新会回 CF_TOKEN_MISSING，那也不该每次冷启动
 * 都去撞一次，等构建换了或者过了六小时再试。
 */
export const requestStartupUpdateCheck = async (
  nowMs = Date.now(),
  buildLabel = BUILD_LABEL,
): Promise<'updated' | 'update-failed' | 'requested' | 'skipped' | 'throttled' | 'worker-unset'> => {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    if (!config?.workerUrl?.trim() || !config.initializedAt) return 'worker-unset';
  } catch {
    return 'worker-unset';
  }
  if (!shouldRequestStartupUpdateCheck(readStartupUpdateCheckMarker(), buildLabel, nowMs)) return 'throttled';
  writeStartupUpdateCheckMarker({ buildLabel, atMs: nowMs });

  const probe = await ActiveMsgClient.probeWorkerVersion();
  const action = pickStartupUpdateAction(probe);
  if (action === 'self-update') {
    // 跟设置页那颗按钮走的是同一个端点。这里不弹提示、不接着重连：换上的新代码下一跳会
    // 自己把表补齐（见 worker 的 ensureSchemaOnce）；selfUpdateWorker 会自动复查能力。
    const result = await ActiveMsgClient.selfUpdateWorker();
    if (result.ok) {
      console.info(`[ActiveMsg] 冷启动时把后端更新到了 ${probe.expected}（${result.bundleHash ?? ''}）`);
      return 'updated';
    }
    console.warn(`[ActiveMsg] 冷启动时更新后端没成功：${result.message}`);
    return 'update-failed';
  }
  if (action === 'check') {
    const answer = await ActiveMsgClient.requestWorkerUpdateCheck();
    if (answer === 'failed') console.warn('[ActiveMsg] 冷启动时没敲到后端的更新检查（下次再试）');
    return 'requested';
  }
  return 'skipped';
};

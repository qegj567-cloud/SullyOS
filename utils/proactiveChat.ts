/**
 * Proactive Chat - schedule characters to send messages at regular intervals.
 *
 * How it works:
 *  1. Each character can persist an independent proactive schedule.
 *  2. The SW keeps timers for all active schedules and posts 'proactive-trigger'
 *     with the relevant charId.
 *  3. The main thread receives the trigger and runs the normal AI flow.
 *  4. If the app was backgrounded, visibility-change catch-up fires any overdue roles.
 *  5. If the optional Cloudflare Worker accelerator is configured (see
 *     `utils/proactivePushConfig.ts`), `start`/`stop` also register/unregister
 *     a Web Push wake-up schedule on the Worker.  The Worker's cron sends a
 *     `{type:'proactive-wake', charId}` push at interval time; the SW routes
 *     it through the same `proactive-trigger` channel so the main-thread AI
 *     flow runs exactly once per trigger regardless of source.
 */

import {
  loadPushConfig,
  isPushConfigReady,
  registerScheduleOnWorker,
  unregisterScheduleOnWorker,
  startHeartbeat,
  stopHeartbeat,
} from './proactivePushConfig';

export interface ProactiveSchedule {
  charId: string;
  intervalMs: number; // must be multiple of 30 * 60 * 1000
}

export type ProactiveSessionOutcome = 'ok' | 'failed' | 'skipped';

export const MIN_PROACTIVE_INTERVAL_MINUTES = 30;
export const MIN_PROACTIVE_INTERVAL_MS = MIN_PROACTIVE_INTERVAL_MINUTES * 60 * 1000;
/**
 * 连续多次主动消息调用模型失败（如余额耗尽、Key 失效）时自动熔断并停止该角色的 1.0 主动消息调度，
 * 避免后台定时器无休止重试刷爆上游 API。
 */
export const PROACTIVE_FAIL_LIMIT = 3;

type ProactiveScheduleMap = Record<string, ProactiveSchedule>;
type LastFireMap = Record<string, number>;
type FailStreakMap = Record<string, number>;

const STORAGE_KEY = 'proactive_schedules';
const LAST_FIRE_KEY = 'proactive_last_fire_map';
const FAIL_STREAK_KEY = 'proactive_fail_streak';
const LEGACY_STORAGE_KEY = 'proactive_schedule';
const LEGACY_LAST_FIRE_KEY = 'proactive_last_fire';

// 内存镜像兜底：当 localStorage 配额写满（QuotaExceededError）时，保证停止调度、更新
// lastFireTime 和熔断计数在当前会话内依然可靠生效，不会因写盘抛错而陷入每 20s 重复触发的死循环。
let memorySchedules: ProactiveScheduleMap = {};
let schedulesWriteFailed = false;
let memoryLastFireTimes: LastFireMap = {};
let lastFireWriteFailed = false;
let memoryFailStreaks: FailStreakMap = {};
let failStreakWriteFailed = false;

function clampIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return MIN_PROACTIVE_INTERVAL_MS;
  return Math.max(MIN_PROACTIVE_INTERVAL_MS, Math.round(intervalMs / MIN_PROACTIVE_INTERVAL_MS) * MIN_PROACTIVE_INTERVAL_MS);
}

function normalizeScheduleMap(rawMap: unknown): ProactiveScheduleMap {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const result: ProactiveScheduleMap = {};
  for (const [key, item] of Object.entries(rawMap as Record<string, any>)) {
    const charId = typeof item?.charId === 'string' && item.charId ? item.charId : key;
    const rawInterval = Number(item?.intervalMs);
    if (!charId || !Number.isFinite(rawInterval) || rawInterval <= 0) continue;
    result[charId] = {
      charId,
      intervalMs: clampIntervalMs(rawInterval),
    };
  }
  return result;
}

function loadSchedules(): ProactiveScheduleMap {
  if (schedulesWriteFailed) {
    return { ...memorySchedules };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!legacyRaw) {
        memorySchedules = {};
        return {};
      }

      const legacySchedule = JSON.parse(legacyRaw) as ProactiveSchedule | null;
      if (!legacySchedule?.charId || !legacySchedule.intervalMs) {
        memorySchedules = {};
        return {};
      }

      const migratedSchedules = normalizeScheduleMap({ [legacySchedule.charId]: legacySchedule });
      saveSchedules(migratedSchedules);
      try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
      return { ...migratedSchedules };
    }
    const parsed = normalizeScheduleMap(JSON.parse(raw));
    memorySchedules = { ...parsed };
    return parsed;
  } catch {
    return { ...memorySchedules };
  }
}

function saveSchedules(schedules: ProactiveScheduleMap) {
  const normalized = normalizeScheduleMap(schedules);
  memorySchedules = { ...normalized };
  const entries = Object.entries(normalized);
  try {
    if (entries.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }
    schedulesWriteFailed = false;
  } catch (err) {
    schedulesWriteFailed = true;
    console.warn('[ProactiveChat] Failed to persist schedules to localStorage, using in-memory fallback', err);
  }
}

function loadLastFireTimes(): LastFireMap {
  if (lastFireWriteFailed) {
    return { ...memoryLastFireTimes };
  }
  try {
    const raw = localStorage.getItem(LAST_FIRE_KEY);
    if (!raw) {
      const legacyRaw = localStorage.getItem(LEGACY_LAST_FIRE_KEY);
      const schedules = loadSchedules();
      const firstSchedule = Object.values(schedules)[0];
      const legacyTs = parseInt(legacyRaw || '0', 10);
      if (!firstSchedule || !legacyTs) {
        memoryLastFireTimes = {};
        return {};
      }

      const migratedLastFire = { [firstSchedule.charId]: legacyTs };
      saveLastFireTimes(migratedLastFire);
      try { localStorage.removeItem(LEGACY_LAST_FIRE_KEY); } catch { /* ignore */ }
      return { ...migratedLastFire };
    }
    const parsed = JSON.parse(raw) as LastFireMap;
    const valid = parsed && typeof parsed === 'object' ? parsed : {};
    memoryLastFireTimes = { ...valid };
    return { ...valid };
  } catch {
    return { ...memoryLastFireTimes };
  }
}

function saveLastFireTimes(lastFireMap: LastFireMap) {
  memoryLastFireTimes = { ...lastFireMap };
  const entries = Object.entries(lastFireMap);
  try {
    if (entries.length === 0) {
      localStorage.removeItem(LAST_FIRE_KEY);
    } else {
      localStorage.setItem(LAST_FIRE_KEY, JSON.stringify(lastFireMap));
    }
    lastFireWriteFailed = false;
  } catch (err) {
    lastFireWriteFailed = true;
    console.warn('[ProactiveChat] Failed to persist lastFireMap to localStorage, using in-memory fallback', err);
  }
}

function loadFailStreaks(): FailStreakMap {
  if (failStreakWriteFailed) {
    return { ...memoryFailStreaks };
  }
  try {
    const raw = localStorage.getItem(FAIL_STREAK_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const valid = parsed && typeof parsed === 'object' ? parsed : {};
    memoryFailStreaks = { ...valid };
    return { ...valid };
  } catch {
    return { ...memoryFailStreaks };
  }
}

function saveFailStreaks(failStreakMap: FailStreakMap) {
  memoryFailStreaks = { ...failStreakMap };
  try {
    if (Object.keys(failStreakMap).length === 0) {
      localStorage.removeItem(FAIL_STREAK_KEY);
    } else {
      localStorage.setItem(FAIL_STREAK_KEY, JSON.stringify(failStreakMap));
    }
    failStreakWriteFailed = false;
  } catch {
    failStreakWriteFailed = true;
  }
}

function removeFailStreak(charId: string) {
  const m = loadFailStreaks();
  if (m[charId] === undefined) return;
  delete m[charId];
  saveFailStreaks(m);
}

function getLastFireTime(charId: string): number {
  return loadLastFireTimes()[charId] || 0;
}

function setLastFireTime(charId: string, ts: number) {
  const lastFireMap = loadLastFireTimes();
  lastFireMap[charId] = ts;
  saveLastFireTimes(lastFireMap);
}

function removeLastFireTime(charId: string) {
  const lastFireMap = loadLastFireTimes();
  delete lastFireMap[charId];
  saveLastFireTimes(lastFireMap);
}

function postToSW(msg: any) {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.controller.postMessage(msg);
}

function syncSchedulesToSW() {
  const schedules = Object.values(loadSchedules());
  postToSW({ type: 'proactive-sync', configs: schedules });
}

// --- Trigger callback management ---
let triggerCallback: ((charId: string) => void | Promise<void>) | null = null;
let swListener: ((e: MessageEvent) => void) | null = null;
let visibilityListener: (() => void) | null = null;
let focusListener: (() => void) | null = null;
let mainThreadTimer: ReturnType<typeof setInterval> | null = null;
let preciseTimer: ReturnType<typeof setTimeout> | null = null;

// Main-thread polling acts as the bottom-line safety net in case Service
// Worker timers get terminated by the browser AND the precise setTimeout gets
// throttled in a background tab.  20 s is cheap (just a localStorage read)
// and keeps the worst-case delay under one bucket for hidden-tab throttling.
const MAIN_THREAD_CHECK_INTERVAL = 20_000;

function handleSWMessage(e: MessageEvent) {
  if (e.data?.type !== 'proactive-trigger') return;
  const charId = e.data.charId;
  const schedule = loadSchedules()[charId];
  if (!schedule) return;
  if (!triggerCallback) {
    // Callback not ready yet — leave lastFire untouched so the main-thread
    // polling will fire once the callback is registered.
    return;
  }

  // De-dupe: when both the Worker's push and the main-thread catch-up fire
  // within a small window of each other (happens when the user returns after
  // an offline gap), the first one to land wins and the other gets silently
  // dropped.  Without this guard the character would send two proactive
  // messages back-to-back.
  const now = Date.now();
  const lastFire = getLastFireTime(charId);
  const minGap = Math.min(60_000, schedule.intervalMs * 0.1);
  if (lastFire > 0 && now - lastFire < minGap) {
    console.log(`[ProactiveChat] Ignoring duplicate trigger for ${charId} (fired ${Math.round((now - lastFire) / 1000)}s ago)`);
    return;
  }

  setLastFireTime(charId, now);
  schedulePreciseTimer();
  void triggerCallback(charId);
}

/** Check all schedules and fire any that are overdue. */
function checkOverdueSchedules() {
  if (!triggerCallback) return;

  const schedules = Object.values(loadSchedules());
  const now = Date.now();

  for (const schedule of schedules) {
    const lastFire = getLastFireTime(schedule.charId);
    if (lastFire <= 0) {
      setLastFireTime(schedule.charId, now);
      continue;
    }
    const elapsed = now - lastFire;

    if (elapsed >= schedule.intervalMs) {
      console.log(`[ProactiveChat] Main-thread trigger: ${schedule.charId}, ${Math.round(elapsed / 60000)}min elapsed`);
      setLastFireTime(schedule.charId, now);
      syncSchedulesToSW();
      void triggerCallback(schedule.charId);
    }
  }

  schedulePreciseTimer();
}

/**
 * Schedule a single setTimeout to fire exactly at the next due moment across
 * all active schedules.  This is the primary delivery mechanism while the tab
 * is visible — setInterval / setTimeout are accurate in the foreground, and
 * the user's specific complaint is "在角色也不给我发消息" (messages don't fire
 * when I'm sitting on the character screen).  Backs up the Service Worker
 * timer, which the browser may terminate at any time.
 */
function schedulePreciseTimer() {
  if (preciseTimer) {
    clearTimeout(preciseTimer);
    preciseTimer = null;
  }
  if (!triggerCallback) return;

  const schedules = Object.values(loadSchedules());
  if (schedules.length === 0) return;

  const now = Date.now();
  let nextDue = Infinity;
  for (const schedule of schedules) {
    const lastFire = getLastFireTime(schedule.charId);
    const base = lastFire > 0 ? lastFire : now;
    const due = base + schedule.intervalMs;
    if (due < nextDue) nextDue = due;
  }
  if (!Number.isFinite(nextDue)) return;

  // Clamp: at least 500ms to avoid tight loops, at most ~24d to fit a 32-bit timer.
  const delay = Math.min(Math.max(nextDue - now, 500), 2_147_000_000);
  preciseTimer = setTimeout(() => {
    preciseTimer = null;
    checkOverdueSchedules();
  }, delay);
}

function handleVisibility() {
  if (document.visibilityState !== 'visible') return;
  // When the page becomes visible again, do an immediate overdue check and
  // re-arm the precise timer (background throttling may have delayed it).
  checkOverdueSchedules();
}

function handleFocus() {
  checkOverdueSchedules();
}

function startMainThreadTimer() {
  if (mainThreadTimer) return;
  mainThreadTimer = setInterval(checkOverdueSchedules, MAIN_THREAD_CHECK_INTERVAL);
}

function stopMainThreadTimer() {
  if (mainThreadTimer) {
    clearInterval(mainThreadTimer);
    mainThreadTimer = null;
  }
}

function attachListeners() {
  detachListeners();
  swListener = handleSWMessage;
  navigator.serviceWorker?.addEventListener('message', swListener);
  visibilityListener = handleVisibility;
  document.addEventListener('visibilitychange', visibilityListener);
  focusListener = handleFocus;
  window.addEventListener('focus', focusListener);
  startMainThreadTimer();
  schedulePreciseTimer();
}

function detachListeners() {
  if (swListener) {
    navigator.serviceWorker?.removeEventListener('message', swListener);
    swListener = null;
  }
  if (visibilityListener) {
    document.removeEventListener('visibilitychange', visibilityListener);
    visibilityListener = null;
  }
  if (focusListener) {
    window.removeEventListener('focus', focusListener);
    focusListener = null;
  }
  stopMainThreadTimer();
  if (preciseTimer) {
    clearTimeout(preciseTimer);
    preciseTimer = null;
  }
}

export const ProactiveChat = {
  /**
   * Register the callback that fires when it's time for a proactive message.
   * Call this once from app code. The callback should inject a system hint
   * and call the normal AI flow.
   */
  onTrigger(callback: (charId: string) => void | Promise<void>) {
    triggerCallback = callback;
    attachListeners();
    // Catch up anything that came due while the callback wasn't registered
    // yet (e.g. between `ProactiveChat.resume()` on boot and OSContext
    // finishing its first render).
    checkOverdueSchedules();
  },

  /**
   * Start or update one character's proactive schedule.
   */
  start(charId: string, intervalMinutes: number) {
    const clamped = Math.max(MIN_PROACTIVE_INTERVAL_MINUTES, Math.round(intervalMinutes / 30) * 30);
    const intervalMs = clamped * 60 * 1000;
    const schedules = loadSchedules();
    schedules[charId] = { charId, intervalMs };
    saveSchedules(schedules);
    setLastFireTime(charId, Date.now());
    removeFailStreak(charId);
    syncSchedulesToSW();
    attachListeners();

    // Cloud accelerator — fire-and-forget; if not configured, this no-ops.
    if (isPushConfigReady(loadPushConfig())) {
      void registerScheduleOnWorker(charId, intervalMs);
      startHeartbeat();
    }

    console.log(`[ProactiveChat] Started: ${charId}, every ${clamped}min`);
  },

  /**
   * Stop one character's proactive schedule.
   */
  stop(charId: string) {
    const schedules = loadSchedules();
    delete schedules[charId];
    saveSchedules(schedules);
    removeLastFireTime(charId);
    removeFailStreak(charId);
    syncSchedulesToSW();

    if (isPushConfigReady(loadPushConfig())) {
      void unregisterScheduleOnWorker(charId);
    }

    if (Object.keys(schedules).length === 0) {
      detachListeners();
      stopHeartbeat();
    } else {
      schedulePreciseTimer();
    }

    console.log(`[ProactiveChat] Stopped: ${charId}`);
  },

  /**
   * 回报一轮 1.0 主动消息的执行结果，用于连续失败熔断（如余额耗尽、Key 失效）。
   * 连续失败达到 PROACTIVE_FAIL_LIMIT 次时自动停掉该角色的本地定时调度并返回 `tripped: true`。
   */
  report(charId: string, outcome: ProactiveSessionOutcome): { tripped: boolean; streak: number } {
    if (outcome === 'skipped') return { tripped: false, streak: loadFailStreaks()[charId] || 0 };
    if (outcome === 'ok') {
      removeFailStreak(charId);
      return { tripped: false, streak: 0 };
    }
    const m = loadFailStreaks();
    const streak = (m[charId] || 0) + 1;
    m[charId] = streak;
    saveFailStreaks(m);
    if (streak < PROACTIVE_FAIL_LIMIT) return { tripped: false, streak };
    ProactiveChat.stop(charId);
    console.warn(`[ProactiveChat] 连续 ${streak} 次失败，已自动暂停主动消息: ${charId}`);
    return { tripped: true, streak };
  },

  getFailStreak(charId: string): number {
    return loadFailStreaks()[charId] || 0;
  },

  /**
   * 以角色的 proactiveConfig 为准对账本地调度表（同 VRScheduler.reconcile）。
   * - 已启用但缺调度 → 补建（首火从当前时刻起算）
   * - 间隔变更 → 同步最新间隔
   * - 已关闭或已删除角色 → 清除残留调度与 SW 定时器
   */
  reconcile(active: { charId: string; intervalMinutes: number }[]) {
    const schedules = loadSchedules();
    const activeIds = new Set(active.map(a => a.charId));
    let changed = false;

    for (const a of active) {
      const clamped = Math.max(MIN_PROACTIVE_INTERVAL_MINUTES, Math.round(a.intervalMinutes / 30) * 30);
      const intervalMs = clamped * 60 * 1000;
      const existing = schedules[a.charId];
      if (!existing) {
        schedules[a.charId] = { charId: a.charId, intervalMs };
        if (getLastFireTime(a.charId) === 0) setLastFireTime(a.charId, Date.now());
        changed = true;
      } else if (existing.intervalMs !== intervalMs) {
        existing.intervalMs = intervalMs;
        changed = true;
      }
    }

    for (const id of Object.keys(schedules)) {
      if (!activeIds.has(id)) {
        delete schedules[id];
        removeLastFireTime(id);
        removeFailStreak(id);
        if (isPushConfigReady(loadPushConfig())) {
          void unregisterScheduleOnWorker(id);
        }
        changed = true;
      }
    }

    if (changed) saveSchedules(schedules);
    syncSchedulesToSW();
    if (Object.keys(schedules).length > 0) {
      attachListeners();
    } else {
      detachListeners();
      stopHeartbeat();
    }
  },

  /**
   * Resume all saved schedules after page reload.
   */
  resume() {
    const schedules = Object.values(loadSchedules());
    if (schedules.length === 0) return;

    console.log(`[ProactiveChat] Resuming ${schedules.length} proactive schedule(s)`);
    syncSchedulesToSW();
    attachListeners();
    handleVisibility();

    // Re-register schedules on the Worker in case the client token, VAPID
    // key, or push subscription has rotated since last run.  Also restart
    // the heartbeat loop.
    if (isPushConfigReady(loadPushConfig())) {
      for (const schedule of schedules) {
        void registerScheduleOnWorker(schedule.charId, schedule.intervalMs);
      }
      startHeartbeat();
    }
  },

  /** Check if proactive is active for a given character */
  isActiveFor(charId: string): boolean {
    return !!loadSchedules()[charId];
  },

  /** Get current schedule interval in minutes for one character, or null */
  getIntervalMinutes(charId: string): number | null {
    const schedule = loadSchedules()[charId];
    return schedule ? schedule.intervalMs / 60000 : null;
  },

  /** Get current schedule for one character */
  getSchedule(charId: string): ProactiveSchedule | null {
    return loadSchedules()[charId] || null;
  },

  /** Get all active schedules */
  getSchedules(): ProactiveSchedule[] {
    return Object.values(loadSchedules());
  },
};

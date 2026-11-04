import type { DialogueApiConfig } from '../types';
import { ActiveMsgClient, fetchWorkerDiagnostics, compareRemotePushSubscription } from './activeMsgClient';
import { readBrowserPushState } from './pushSubscribeShared';
import { captureSwRegistrationSnapshot } from './swChannelProbe';
import { APP_VERSION, BUILD_LABEL } from './buildInfo';
import { readAllInstantTraces } from './instantTraceLog';
import { safeDiagnosticError, summarizeReproduction, type DiagnosticEvent } from './amsgReproduction';
import { appendDiagnosticEvent, listDiagnosticEvents, listDiagnosticRuns, pruneDiagnosticRuns, saveDiagnosticRun, updateDiagnosticRun, type DiagnosticRun } from './amsgReproductionStore';

/** 任一探针失联不拖住整份报告，也不把「没有取得」写成正常。 */
async function bounded<T>(work: Promise<T>, ms = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new DOMException('timeout', 'TimeoutError')), ms); })]); }
  finally { clearTimeout(timer!); }
}

async function fingerprint(value?: string | null): Promise<string | null> {
  if (!value) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes)).map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function captureReproductionEnvironment() {
  const [browser, remote, worker, registration, configuration] = await Promise.allSettled([
    bounded(readBrowserPushState()), bounded(ActiveMsgClient.getRemotePushSubscription()),
    bounded(fetchWorkerDiagnostics()), bounded(captureSwRegistrationSnapshot()), bounded(ActiveMsgClient.getGlobalConfig()),
  ]);
  const b = browser.status === 'fulfilled' ? browser.value : null;
  const r = remote.status === 'fulfilled' ? remote.value : null;
  const w = worker.status === 'fulfilled' && worker.value.reachable ? worker.value.report : null;
  return {
    workerAddressFingerprint: configuration.status === 'fulfilled' ? await fingerprint(configuration.value.workerUrl) : null,
    capturedAt: new Date().toISOString(), appVersion: APP_VERSION, build: BUILD_LABEL,
    userAgent: navigator.userAgent, language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
    online: navigator.onLine, visibility: document.visibilityState,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true,
    browser: b ? { supported: b.supported, permission: b.permission, swState: b.swState, channel: b.channel,
      iosNeedsPwa: b.iosNeedsPwa, capacitorNative: b.capacitorNative, lastSubscribeFailure: b.lastSubscribeFailure ? { kind: b.lastSubscribeFailure.kind, at: b.lastSubscribeFailure.at } : null,
      endpointPresent: !!b.endpoint, endpointDead: b.endpointDead, endpointFingerprint: await fingerprint(b.endpoint) } : { unavailable: true },
    registration: registration.status === 'fulfilled' ? registration.value : { unavailable: true },
    cloudRegistration: b && remote.status === 'fulfilled' ? compareRemotePushSubscription(b.endpoint, r) : 'unavailable',
    worker: w ? { configOk: w.config.ok, missing: w.config.missing, schemaReady: w.storage.schemaReady,
      storageReachable: w.storage.reachable, subscriptionRegistered: w.storage.pushSubscriptionRegistered,
      tick: w.tick, server: w.server, pushDelivery: w.storage.pushDelivery } : { unavailable: true },
  };
}

export async function startReproduction(api: DialogueApiConfig, scenario: DiagnosticRun['scenario'], delaySeconds = 60): Promise<DiagnosticRun> {
  const active = (await listDiagnosticRuns()).find(run => ['preparing', 'scheduled', 'uncertain'].includes(run.status) && Date.now() < run.dueAt + 10 * 60000);
  if (active) throw new Error('还有一轮复现可能正在执行，请先查看或取消它，避免重复调用 API。');
  const runId = crypto.randomUUID();
  const createdAt = Date.now();
  let host: string;
  try { host = new URL(api.baseUrl).hostname; } catch { throw new Error('请填写有效的 API 地址'); }
  if (!api.model.trim()) throw new Error('请选择模型');
  await pruneDiagnosticRuns();
  const run: DiagnosticRun = { runId, createdAt, dueAt: createdAt + delaySeconds * 1000, api: { host, model: api.model }, status: 'preparing', observation: 'unanswered', scenario };
  // 必须先落本机记录，关页也不会失去这次诊断身份；API Key 只交给加密排程请求。
  await saveDiagnosticRun(run);
  let accepted: { uuid: string; dueAt: number } | undefined;
  try {
    const before = await captureReproductionEnvironment();
    await updateDiagnosticRun(runId, { before });
    const result = await ActiveMsgClient.scheduleReproduction(runId, api, delaySeconds);
    accepted = result;
    const patch = { taskUuid: result.uuid, dueAt: result.dueAt, status: 'scheduled' as const };
    await updateDiagnosticRun(runId, patch);
    return { ...run, before, ...patch };
  } catch (error) {
    const uncertain = !!accepted || (error as any)?.diagnosticMayBeCreated === true;
    const dueAt = accepted?.dueAt ?? (error as any)?.dueAt;
    // 连续存储故障时原 preparing 记录仍在，不能因为写错误状态再次失败而丢掉提示。
    await updateDiagnosticRun(runId, { status: uncertain ? 'uncertain' : 'failed', taskUuid: accepted?.uuid ?? runId, ...(dueAt ? { dueAt } : {}) }).catch(() => {});
    await appendDiagnosticEvent({ runId, side: 'page', event: uncertain ? 'schedule-uncertain' : 'schedule-failed', ts: new Date().toISOString(), ...safeDiagnosticError(error) }).catch(() => {});
    if (uncertain) throw new Error('云端可能已经接单，但本机未能确认完整结果。请先收集报告或取消这轮，不要重复创建。');
    throw error;
  }
}

/** 只收这轮诊断和期间的页面生命周期，不导出普通对话 trace／任务内容。 */
export async function collectReproductionReport(runId: string) {
  const run = (await listDiagnosticRuns()).find(item => item.runId === runId);
  if (!run) throw new Error('这轮诊断记录已不存在');
  const [cloud, local, environment, task] = await Promise.allSettled([
    bounded(ActiveMsgClient.readReproductionEvents(runId)), bounded(listDiagnosticEvents(runId)),
    captureReproductionEnvironment(), bounded(ActiveMsgClient.getRemoteTaskStatus(run.taskUuid || runId)),
  ]);
  const events: DiagnosticEvent[] = [
    ...(cloud.status === 'fulfilled' ? cloud.value : []),
    ...(local.status === 'fulfilled' ? local.value : []),
    ...readAllInstantTraces().filter(e => e.event === 'runtime-page-visibility' && Date.parse(String(e.ts)) >= run.createdAt && Date.parse(String(e.ts)) <= run.dueAt + 10 * 60000)
      .map(e => ({ runId, side: 'page' as const, event: 'page-visibility', ts: String(e.ts), visibility: e.visibility, online: e.online })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));
  const after = environment.status === 'fulfilled' ? environment.value : { unavailable: true };
  // 本机库写不进去也照样出报告：一处存储故障不能吞掉其他证据。
  await updateDiagnosticRun(runId, { after }).catch(() => {});
  const status = task.status === 'fulfilled' ? task.value : null;
  return {
    format: 'sullyos-amsg2-reproduction-v1', exportedAt: new Date().toISOString(),
    run: { ...run, after }, summary: summarizeReproduction(events, run.scenario),
    collection: { cloud: cloud.status, local: local.status, environment: environment.status, task: task.status },
    task: status ? { state: status.state, ...('lastError' in status && status.lastError ? { lastError: { at: status.lastError.at, occurrence: status.lastError.occurrence, ...safeDiagnosticError({ status: status.lastError.pushStatus, code: status.lastError.errorCode }) } } : {}), ...('retryCount' in status ? { retryCount: status.retryCount, nextSendAt: status.nextSendAt } : {}) } : { unavailable: true },
    scope: ['真实云端调度、所选 API 生成、正式分段、推送发送、SW 接收和通知接口、本机收件与补收', '固定测试提示词；不复刻角色上下文、主动频率门禁、MCP、工具副作用、情绪和记忆', '通知接口成功不代表系统实际显示横幅；以用户观察为准', '时间戳来自不同设备时钟，跨端耗时仅供参考；云端记录保留7天，本机最多10轮'],
    events,
  };
}

import React, { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLocalBackHandler } from '../hooks/useLocalBackHandler';
import { ActiveMsgStore } from '../utils/activeMsgStore';
import { AMSG_GLOBAL_CONFIG_EVENT } from '../utils/amsgGlobalGate';
import { trackEvent } from '../utils/analytics';
import {
  acknowledgeRescueAlert,
  buildRescueAlertAnalytics,
  getRescueAlertSnapshot,
  refreshRescueAlertSnapshot,
  requestRescueAlertDetails,
  rescueRecordAckKey,
  setRescueAlertWorker,
  subscribeRescueAlert,
  type StoredRescueRecord,
} from '../utils/amsgRescueAlert';

/**
 * 主动消息 2.0「救援模式」安全警告（全局只挂一处，见 App.tsx）。
 *
 * 能开救援模式的，是任何能登录用户 Cloudflare 面板的人；它能把云端全部数据连同 API Key 导出去。
 * 所以这个弹窗是强制的：
 *   - 用原生 <dialog> 的 showModal 进浏览器顶层，盖住包括悬浮球在内的一切，底下全部 inert；
 *   - 点遮罩、Esc、浏览器 / Android 返回、悬浮球「上一级」都关不掉：Esc 和系统返回触发的
 *     cancel 一律拦下，万一被浏览器强行关掉（新版 Chrome 连按返回时 cancel 不可拦）就立刻重新
 *     打开；OSContext 的全局返回由一个最高层的局部返回处理者吞掉，不会落到底下的 App 上；
 *   - 唯一出口是「我已阅读并知晓」，弹窗真正显示后要读满 10 秒才能点，切到后台时倒计时暂停。
 * 确认只记下「这一版看过了」（ack key），新开一段或又导出了会再弹。
 *
 * 挂在 document.body 上，不在 .sully-chat-root 里，自带浅底深字和 color-scheme，
 * 不受聊天装扮和深色模式影响（见 docs/chat-decoration.md）。
 */

/** 确认按钮要等这么久才能点。 */
const READ_DELAY_MS = 10_000;

/**
 * 一次计时最多算这么多毫秒。页面被冻住（锁屏但没发 visibilitychange）后解冻，两次计时之间
 * 可能隔了很久，那段时间用户并没有在看。
 */
const MAX_TICK_GAP_MS = 1_000;

/** 主文案，弹窗和设置页共用开头。 */
const RESCUE_ALERT_HEADLINE = '你的主动消息 Worker 已开启、或近 7 天内开启过救援模式（RESCUE）。若非本人操作，你的数据可能已被泄露！请立刻修改所有重要凭据，检查 Cloudflare 账号安全状态！';

const AUDIT_LOG_URL = 'https://dash.cloudflare.com/?to=/:account/audit-log';

/** 按用户自己设备的本地时间显示（不是角色时区）。 */
const formatLocalTime = (ms: number | null): string => {
  if (!ms) return '未知';
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return new Date(ms).toISOString();
  }
};

/**
 * 只在页面可见时走的倒计时。active 变成 false 就回到满格，所以每次重新显示都从头读。
 * resetKey 变了（弹窗开着时又来了新的留痕）也从头读，免得新内容没看就被一并确认掉。
 */
const useVisibleCountdown = (active: boolean, resetKey: string): number => {
  const [remainingMs, setRemainingMs] = useState(READ_DELAY_MS);
  useLayoutEffect(() => {
    setRemainingMs(READ_DELAY_MS);
    if (!active) return;
    let elapsed = 0;
    const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    let last: number | null = isVisible() ? performance.now() : null;
    const tick = () => {
      const now = performance.now();
      if (last !== null) elapsed += Math.min(now - last, MAX_TICK_GAP_MS);
      last = isVisible() ? now : null;
      setRemainingMs(Math.max(0, READ_DELAY_MS - elapsed));
      if (elapsed >= READ_DELAY_MS) clearInterval(timer);
    };
    const timer = setInterval(tick, 250);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active, resetKey]);
  return Math.ceil(remainingMs / 1000);
};

const useRescueAlertSnapshot = () =>
  useSyncExternalStore(subscribeRescueAlert, getRescueAlertSnapshot, getRescueAlertSnapshot);

const statusText = (record: StoredRescueRecord): string => {
  if (record.report.active) return '现在仍开着';
  const endedAt = record.report.episode?.endedAt ?? null;
  if (endedAt) return `已于 ${formatLocalTime(endedAt)} 关闭`;
  if (!record.report.episode && record.lastActiveSeenAt) return `最近一次确认开着是 ${formatLocalTime(record.lastActiveSeenAt)}`;
  return '已关闭（关闭时间未知）';
};

const TraceList: React.FC<{ record: StoredRescueRecord }> = ({ record }) => {
  const episode = record.report.episode;
  const rows: Array<[string, string]> = [];
  if (episode) rows.push(['首次发现', formatLocalTime(episode.firstSeenAt)]);
  rows.push(['当前状态', statusText(record)]);
  if (episode) {
    rows.push(['导出', episode.exportCount > 0 ? `${episode.exportCount} 次，最近一次 ${formatLocalTime(episode.lastExportAt)}` : '没有记录']);
    rows.push(['读取数据', episode.itemReads > 0 ? `${episode.itemReads} 条，最近一次 ${formatLocalTime(episode.lastReadAt)}` : '没有记录']);
    rows.push(['口令错误', `${episode.failedAttempts} 次`]);
    rows.push(['开启通知', episode.pushedAt
      ? `推送给 ${episode.pushTargets} 台设备，成功 ${episode.pushDelivered} 台`
      : '没有推送记录']);
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 space-y-1.5">
      <p className="text-xs font-bold text-slate-500">Worker 留下的记录</p>
      {!episode && <p className="text-[13px] leading-relaxed text-slate-700">没有拿到具体记录，可能已被删除，也可能 Worker 暂时读不到。</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] leading-relaxed">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-slate-500 whitespace-nowrap">{label}</dt>
            <dd className="text-slate-800 break-words">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {record.cloudRecordMismatch && (
        <p className="text-[13px] leading-relaxed text-amber-700">
          Worker 这次报回的记录比这台设备之前保存的少，可能被人删改过，也可能只是暂时读不到。上面显示的是这台设备保存过的最完整的一份。
        </p>
      )}
    </div>
  );
};

export default function AmsgRescueAlert() {
  const snapshot = useRescueAlertSnapshot();
  const record = snapshot.record;
  const open = Boolean(record) && (snapshot.shouldAlert || snapshot.detailsRequested);
  const ackKey = record ? rescueRecordAckKey(record) : '';
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [shown, setShown] = useState(false);
  const titleId = useId();
  const remaining = useVisibleCountdown(open && shown, ackKey);
  const locked = !shown || remaining > 0;

  // 当前连的是哪台 Worker：启动时读一次配置，之后跟着配置变化走。运行时的探测也会设，
  // 这里再设一次是为了运行时还没跑起来时，本机副本也能先亮出来。
  useEffect(() => {
    let cancelled = false;
    void ActiveMsgStore.getGlobalConfig()
      .then(config => { if (!cancelled) setRescueAlertWorker(config.workerUrl ?? ''); })
      .catch(() => {});
    const onConfig = (event: Event) => {
      const workerUrl = (event as CustomEvent<{ workerUrl?: unknown }>).detail?.workerUrl;
      if (typeof workerUrl === 'string' && workerUrl.trim() !== getRescueAlertSnapshot().workerUrl) setRescueAlertWorker(workerUrl);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refreshRescueAlertSnapshot(); };
    window.addEventListener(AMSG_GLOBAL_CONFIG_EVENT, onConfig);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener(AMSG_GLOBAL_CONFIG_EVENT, onConfig);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // 打开 / 保持打开。被浏览器强行关掉（close 事件）时，只要还该开着就马上重新打开。
  useEffect(() => {
    if (!open) return;
    const element = dialogRef.current;
    if (!element) return;
    const show = () => {
      if (!openRef.current || element.open) return;
      if (typeof element.showModal === 'function') {
        try { element.showModal(); } catch { element.setAttribute('open', ''); }
      } else {
        // 不支持 showModal 的老 WebView：退回普通固定定位层（样式本来就是全屏盖住）。
        element.setAttribute('open', '');
      }
    };
    show();
    setShown(true);
    const reopen = () => { if (openRef.current) setTimeout(show, 0); };
    element.addEventListener('close', reopen);
    return () => {
      element.removeEventListener('close', reopen);
      setShown(false);
      if (element.open) {
        if (typeof element.close === 'function') element.close();
        else element.removeAttribute('open');
      }
    };
  }, [open]);

  // 统计：每次弹出报一次，属性全是写死的枚举。
  useEffect(() => {
    if (!open || !record) return;
    trackEvent('弹出救援模式警告', buildRescueAlertAnalytics(record, !snapshot.shouldAlert));
    // 只在弹出那一刻报（依赖只放 open），开着期间记录更新不重复报。
  }, [open]);

  // 全局返回（浏览器返回、Android 返回、悬浮球「上一级」）开着时一律吞掉，层级高于所有面板。
  useLocalBackHandler(() => true, 10_000, open);

  if (!open || !record) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={event => { event.preventDefault(); }}
      onKeyDown={event => { if (event.key === 'Escape') event.preventDefault(); }}
      className="fixed inset-0 z-[2147483647] m-0 h-full max-h-none w-full max-w-none border-0 bg-black/60 p-4 [color-scheme:light] backdrop:bg-transparent open:flex items-center justify-center"
      style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1rem)', paddingBottom: 'calc(var(--safe-bottom, 0px) + 1rem)' }}
    >
      <div className="relative flex max-h-full w-full max-w-md min-h-0 flex-col overflow-hidden rounded-3xl bg-white text-slate-800 shadow-2xl">
        <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pt-6 pb-4 space-y-4">
          <h2 id={titleId} className="text-lg font-bold text-red-700">救援模式安全警告</h2>
          <p className="text-[15px] font-bold leading-relaxed text-red-600">{RESCUE_ALERT_HEADLINE}</p>
          {record.report.active && (
            <p className="text-[14px] leading-relaxed text-slate-800">
              救援模式现在仍开着。如果是你本人在救数据，救完记得在 Cloudflare 面板删掉 <code className="rounded bg-slate-100 px-1 text-[13px]">AMSG_RESCUE_TOKEN</code>。
            </p>
          )}
          <TraceList record={record} />
          <div className="space-y-2">
            <p className="text-sm font-bold text-slate-800">要做什么</p>
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-slate-700">
              <li>到各 AI 服务商后台，把 API Key 全部作废并重新生成。</li>
              <li>工具凭据（Notion、飞书、小红书 Cookie 等）同样去对应服务作废重建。</li>
              <li>修改 Cloudflare 密码，并开启两步验证。</li>
              <li>作废所有不认识的 Cloudflare API Token。</li>
              <li>到 Cloudflare 的审计日志（Audit Logs）查是谁、什么时候改了 Worker。审计日志不能被删除，是唯一可信的记录。</li>
              <li>如果救援模式还开着、而且不是你开的，到 Worker 设置里删掉 <code className="rounded bg-slate-100 px-1 text-[12px]">AMSG_RESCUE_TOKEN</code>。</li>
            </ol>
            <a
              href={AUDIT_LOG_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-[13px] font-bold text-red-700 underline underline-offset-2"
            >
              打开 Cloudflare 审计日志
            </a>
          </div>
        </div>
        <div className="shrink-0 border-t border-slate-100 px-5 py-4">
          <button
            type="button"
            disabled={locked}
            onClick={() => { if (!locked) acknowledgeRescueAlert(); }}
            className="w-full rounded-2xl bg-red-600 py-3 font-bold text-white transition-transform active:scale-95 disabled:bg-slate-200 disabled:text-slate-500 disabled:active:scale-100"
          >
            {locked ? `请阅读（${Math.max(remaining, 1)}）` : '我已阅读并知晓'}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

/**
 * 主动消息 2.0 全局设置顶部的常驻提示：在 7 天警告窗口内就一直显示，点「查看详情」重新打开
 * 上面的弹窗（同样要读满 10 秒）。
 */
export const AmsgRescueSettingsBanner: React.FC = () => {
  const snapshot = useRescueAlertSnapshot();
  if (!snapshot.due || !snapshot.record) return null;
  return (
    <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 space-y-2 [color-scheme:light]">
      <p className="text-[13px] font-bold leading-relaxed text-red-700">
        这台 Worker 已开启、或近 7 天内开启过救援模式。若非本人操作，数据可能已泄露，请立刻修改重要凭据。
      </p>
      <button
        type="button"
        onClick={() => requestRescueAlertDetails()}
        className="rounded-xl bg-red-600 px-3 py-1.5 text-xs font-bold text-white active:scale-95 transition-transform"
      >
        查看详情
      </button>
    </div>
  );
};

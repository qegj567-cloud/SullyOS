import React, { useEffect, useState } from 'react';
import type { APIConfig, ApiPreset, DialogueApiConfig } from '../types';
import { describeDialogueApi, pickDialogueApi } from '../utils/characterApi';
import { ActiveMsgClient } from '../utils/activeMsgClient';
import { collectReproductionReport, startReproduction } from '../utils/amsgReproductionClient';
import { listDiagnosticRuns, updateDiagnosticRun, type DiagnosticRun } from '../utils/amsgReproductionStore';
import { shareOrDownloadBlob } from '../utils/shareExport';
import ApiPresetGroups from './settings/ApiPresetGroups';

const field = 'w-full min-w-0 bg-white border border-slate-200/60 rounded-xl px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/30';
const button = 'px-3 py-2.5 rounded-xl text-xs font-bold active:scale-95 transition-transform disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const statusLabel = { preparing: '准备中', scheduled: '已安排', uncertain: '不确定有没有安排上', failed: '没安排上', cancelled: '已取消' };
const scenarioLabel = { background: '切到其他应用', locked: '锁屏', closed: '关闭浏览器', foreground: '留在前台' };
const observations = [['banner', '弹出来了'], ['center-only', '只在通知中心'], ['none', '完全没看到']] as const;
// 一条消息从云端到你眼前要走的路，按先后排。
const stages = [
  ['fire-start', '云端开始写'], ['llm-output', 'AI 写好了'], ['push-accepted', '推送已发出'],
  ['sw-received', '手机收到了'], ['notification-resolved', '已请求系统弹通知'], ['page-received', '回到这里收到消息'],
] as const;
type Report = Awaited<ReturnType<typeof collectReproductionReport>>;
// 已安排的任务过了这个窗口早就跑完了，再点取消云端只会回「不存在」，本机却被标成已取消。
const CANCEL_WINDOW_MS = 10 * 60_000;
const cancellable = (run: DiagnosticRun) => run.status === 'preparing' || run.status === 'uncertain'
  || (run.status === 'scheduled' && Date.now() < run.dueAt + CANCEL_WINDOW_MS);

export default function AmsgReproductionPanel({ apiConfig, apiPresets }: { apiConfig: APIConfig; apiPresets: ApiPreset[] }) {
  // 跟随模式每次读取最新设置；只有用户主动修改时才冻结本次配置。
  const [apiOverride, setApiOverride] = useState<DialogueApiConfig | null>(null);
  const [apiLabel, setApiLabel] = useState('');
  const [editingApi, setEditingApi] = useState(false);
  const api = apiOverride ?? pickDialogueApi(apiConfig);
  const [scenario, setScenario] = useState<NonNullable<DiagnosticRun['scenario']>>('background');
  const [delay, setDelay] = useState(60);
  const [runs, setRuns] = useState<DiagnosticRun[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const current = runs.find(run => run.runId === selected) ?? runs[0];
  const shownReport = report?.run.runId === current?.runId ? report : null;

  const refreshLocal = async () => {
    const next = await listDiagnosticRuns();
    setRuns(next);
    return next;
  };
  useEffect(() => {
    void refreshLocal().catch(() => setNotice('读不到本机的测试记录，请检查浏览器存储是否可用。'));
    const visible = () => { if (document.visibilityState === 'visible') void refreshLocal().catch(() => {}); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);

  const perform = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await operation(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '操作失败，请稍后重试。'); }
    finally { setBusy(false); await refreshLocal().catch(() => {}); }
  };
  const collect = async () => {
    if (!current) return null;
    const next = await collectReproductionReport(current.runId);
    setReport(next);
    return next;
  };

  return <section aria-label="测试推送" className="space-y-5 text-sm text-slate-700 leading-relaxed">
    <p className="text-xs text-slate-500 text-center">让 AI 真的发一条测试消息，看看它卡在哪一步。不会进聊天，也不会进记忆。</p>

    <fieldset disabled={busy} className="min-w-0 space-y-3 disabled:opacity-60">
      <div className="rounded-3xl bg-slate-50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-700">{apiOverride ? `这次用 ${apiLabel}` : '用设置里的 API'}</p>
            <p className="mt-0.5 text-xs text-slate-400 break-all">{describeDialogueApi(api)}</p>
          </div>
          <button type="button" aria-expanded={editingApi} onClick={() => setEditingApi(value => !value)} className="shrink-0 text-xs font-bold text-primary py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-lg">
            {editingApi ? '收起配置' : '更换 API'}
          </button>
        </div>
        {apiOverride && <button type="button" onClick={() => { setApiOverride(null); setApiLabel(''); }} className="mt-2 text-xs text-primary font-medium">恢复使用当前配置</button>}
        {editingApi && <div className="mt-3 space-y-3 border-t border-slate-200/60 pt-3">
          {apiPresets.length > 0 && <ApiPresetGroups presets={apiPresets}>{preset => <button type="button" key={preset.id} className="px-3 py-2 rounded-xl bg-white border border-slate-200/60 text-xs text-slate-600 active:bg-primary/10" onClick={() => {
            setApiOverride(pickDialogueApi(preset.config)); setApiLabel(preset.name);
          }}>{preset.name}</button>}</ApiPresetGroups>}
          {(['baseUrl', 'apiKey', 'model'] as const).map(key => <label className="block space-y-1.5" key={key}>
            <span className="text-xs text-slate-500">{key === 'baseUrl' ? 'API 地址' : key === 'apiKey' ? 'API Key' : '模型'}</span>
            <input aria-label={key === 'baseUrl' ? 'API 地址' : key === 'apiKey' ? 'API Key' : '模型'} type={key === 'apiKey' ? 'password' : 'text'} autoComplete="off" className={field} value={api[key]} onChange={event => {
              setApiOverride({ ...api, [key]: event.target.value }); setApiLabel('自定义配置');
            }} />
          </label>)}
          <p className="text-[11px] text-slate-400">只用于这次测试，不会改动设置或预设。</p>
        </div>}
      </div>

      <details className="group rounded-3xl bg-slate-50 px-4">
        <summary className="cursor-pointer flex items-center justify-between gap-3 text-xs list-none py-3">
          <span className="text-slate-600">{delay / 60} 分钟后发，期间{scenarioLabel[scenario]}</span>
          <span className="text-primary font-bold">调整</span>
        </summary>
        <div className="grid gap-3 pb-4">
          <label className="block space-y-1.5"><span className="text-xs text-slate-500">等消息的时候你打算</span>
            <select className={field} value={scenario} onChange={event => setScenario(event.target.value as NonNullable<DiagnosticRun['scenario']>)}>
              {Object.entries(scenarioLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="block space-y-1.5"><span className="text-xs text-slate-500">多久后发</span>
            <select className={field} value={delay} onChange={event => setDelay(Number(event.target.value))}>
              <option value={60}>1 分钟后</option><option value={120}>2 分钟后</option><option value={300}>5 分钟后</option>
            </select>
          </label>
        </div>
      </details>

      <button type="button" className="w-full py-3 bg-primary text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2" onClick={() => void perform(async () => {
        const run = await startReproduction(api, scenario, delay);
        setSelected(run.runId); setReport(null);
        setNotice(`安排好了，${new Date(run.dueAt).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })} 发。现在就去${scenarioLabel[scenario]}，等两三分钟留意通知，再回来告诉我们看到了什么。`);
      })}>{busy ? '处理中…' : '开始测试'}</button>
      <p className="text-[11px] text-slate-400 text-center">会用掉一点所选 API 的额度，最多输出 512 tokens。</p>
    </fieldset>

    {notice && <p role="status" className="rounded-2xl bg-primary/5 px-4 py-3 text-xs text-slate-600 whitespace-pre-wrap">{notice}</p>}

    {current && <div className="space-y-4 border-t border-slate-100 pt-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-bold text-slate-700">这次测试</span>
        <select aria-label="测试记录" className="min-w-0 max-w-[65%] bg-transparent text-right text-xs text-slate-400 focus:outline-none" value={current.runId} onChange={event => { setSelected(event.target.value); setReport(null); }}>
          {runs.map(run => <option key={run.runId} value={run.runId}>{new Date(run.createdAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} {statusLabel[run.status]}</option>)}
        </select>
      </div>
      {current.status === 'uncertain' && <p className="text-xs text-amber-600">云端可能已经收下了这次测试。先看进度或取消，别重新开始，免得重复扣额度。</p>}

      <div className="rounded-3xl bg-slate-50 p-4">
        {shownReport ? <>
          <p className="text-xs text-slate-700 mb-3">{shownReport.summary}</p>
          <ol>
            {stages.map(([event, label], index) => {
              const reached = shownReport.events.some(entry => entry.event === event);
              return <li key={event} className="relative flex items-center gap-3 pb-3 last:pb-0 text-xs">
                {index < stages.length - 1 && <span className="absolute left-[4.5px] top-3 bottom-0 w-px bg-slate-200" />}
                <span className={`relative w-2.5 h-2.5 rounded-full shrink-0 ${reached ? 'bg-emerald-500' : 'bg-white ring-1 ring-slate-300'}`} />
                <span className={reached ? 'text-slate-700' : 'text-slate-400'}>{label}</span>
              </li>;
            })}
          </ol>
          {Object.values(shownReport.collection).some(value => value === 'rejected') && <p className="mt-3 text-xs text-amber-600">有几处记录没拿到，已有的部分照样能导出。</p>}
        </> : <p className="text-xs text-slate-400 text-center">到点后点「查看进度」，看消息走到了哪一步。</p>}
      </div>

      <div className="space-y-2">
        <p className="text-xs text-slate-500">你看到通知了吗？</p>
        <div className="grid grid-cols-3 gap-2">
          {observations.map(([value, label]) => {
            const chosen = current.observation === value;
            return <button key={value} type="button" disabled={busy} aria-pressed={chosen} onClick={() => void perform(() => updateDiagnosticRun(current.runId, { observation: chosen ? 'unanswered' : value }))} className={`${button} ${chosen ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600'}`}>{label}</button>;
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button disabled={busy} type="button" className={`${button} flex-1 bg-primary/10 text-primary`} onClick={() => void perform(async () => {
          const result = await collect(); if (!result) return;
          const outcome = await shareOrDownloadBlob({ blob: new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), fileName: `sullyos_amsg2_reproduction_${current.runId}.json` });
          setNotice(outcome === 'cancelled' ? '已取消导出。' : '诊断报告已导出，发给开发者就行。');
        })}>导出诊断报告</button>
        <button disabled={busy} type="button" className={`${button} bg-slate-100 text-slate-600`} onClick={() => void perform(async () => { await collect(); })}>查看进度</button>
        {cancellable(current) && <button disabled={busy} type="button" className={`${button} bg-slate-100 text-slate-600`} onClick={() => void perform(async () => {
          await ActiveMsgClient.cancelTask(current.taskUuid || current.runId);
          await updateDiagnosticRun(current.runId, { status: 'cancelled' });
          setNotice('已取消。如果推送已经发出，测试消息仍可能到达。');
        })}>取消</button>}
      </div>

      {!!current.messages?.length && <details className="text-xs text-slate-500"><summary className="cursor-pointer py-1">收到的测试消息（{current.messages.length} 段）</summary>{current.messages.map(message => <p className="mt-2 whitespace-pre-wrap text-slate-700" key={message.messageId}>{message.text}</p>)}</details>}
      <details className="text-xs text-slate-400"><summary className="cursor-pointer py-1">报告里有什么</summary>
        <p className="mt-2">报告包含设备环境、测试用的模型、测试消息和每一步的记录，不含 API Key、完整订阅地址或平时的聊天内容。云端记录保留 7 天，本机保留最近 10 次。「已请求系统弹通知」不代表系统真的弹了，以你看到的为准。</p>
        <p className="mt-2 break-all">{current.api.host} · {current.api.model}<br />测试编号：{current.runId}</p>
      </details>
    </div>}
  </section>;
}

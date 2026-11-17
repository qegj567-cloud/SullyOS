import React, { useEffect, useRef, useState } from 'react';
import { redactCompanionTestText, type CompanionTestRun } from '../../utils/companion/apiTests';
import type { ListeningDiagnostics } from '../../utils/companion/listening';
import { CompanionMicMeter } from './CompanionMicMeter';
import './CompanionApiTest.css';

export type BeginCompanionTest = (cancel: () => void) => void;

export function CompanionApiTest({ label, description, config, disabled, begin, run }: {
  label: string; description: string; config: unknown; disabled?: boolean; begin: BeginCompanionTest; run: CompanionTestRun;
}) {
  // Includes credentials only in local memory; never rendered or persisted. Editing invalidates the result.
  const scope = JSON.stringify(config);
  const active = useRef<{ controller: AbortController; started: number; timer: ReturnType<typeof setTimeout>; ticker: ReturnType<typeof setInterval> }>();
  const [state, setState] = useState<'idle' | 'running' | 'success' | 'error' | 'cancelled'>('idle');
  const [message, setMessage] = useState('尚未测试'), [detail, setDetail] = useState(''), [elapsed, setElapsed] = useState(0);
  const [micDiagnostics, setMicDiagnostics] = useState<ListeningDiagnostics>();
  const dispose = () => {
    const task = active.current; active.current = undefined;
    if (task) { clearTimeout(task.timer); clearInterval(task.ticker); task.controller.abort(); }
    return task;
  };
  const cancel = () => {
    const task = dispose(); if (!task) return;
    setElapsed(performance.now() - task.started); setState('cancelled'); setMessage('已取消'); setDetail('');
  };
  useEffect(() => {
    dispose(); setState('idle'); setMessage('尚未测试'); setDetail(''); setElapsed(0); setMicDiagnostics(undefined);
    return () => { dispose(); };
  }, [scope]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, []);
  const start = () => {
    if (active.current || disabled) return;
    begin(cancel);
    const controller = new AbortController(), started = performance.now();
    const finish = (status: 'success' | 'error', text: string, body = '') => {
      if (active.current?.controller !== controller) return;
      dispose(); setElapsed(performance.now() - started); setState(status);
      setMessage(redactCompanionTestText(text, config)); setDetail(redactCompanionTestText(body, config));
    };
    const timer = setTimeout(() => finish('error', '测试超时（90 秒），已停止等待；请检查网络、接口或模型响应速度'), 90_000);
    const ticker = setInterval(() => setElapsed(performance.now() - started), 200);
    active.current = { controller, started, timer, ticker };
    setState('running'); setMessage('正在测试…'); setDetail(''); setElapsed(0); setMicDiagnostics(undefined);
    const progress = (text: string, diagnostics?: ListeningDiagnostics) => {
      if (active.current?.controller !== controller) return;
      setMessage(redactCompanionTestText(text, config));
      if (diagnostics) setMicDiagnostics({ ...diagnostics, device: redactCompanionTestText(diagnostics.device, config) });
    };
    try {
      void run(controller.signal, progress).then(result => finish('success', result.summary, result.detail), error => {
        const text = error instanceof Error ? error.message : '未知错误';
        const message = /Failed to fetch|NetworkError|Load failed/i.test(text) ? '无法连接接口，请检查地址、网络及服务商是否允许浏览器访问（CORS）'
          : error?.name === 'AbortError' || /^aborted$/i.test(text) ? '接口等待超时，请检查网络或模型响应速度后重试' : text;
        const hint = /\b401\b/.test(text) ? '鉴权失败，请检查是否使用了对应平台的 API Key，以及 Key 是否过期。'
          : /\b403\b/.test(text) ? '请求被拒绝，请检查账号权限、服务开通状态或模型访问限制。'
          : /\b429\b/.test(text) ? '可能达到请求频率或用量限制，请在服务商控制台检查额度。' : '';
        finish('error', message, hint);
      });
    } catch (error) { finish('error', error instanceof Error ? error.message : '测试未能启动'); }
  };
  return <div className="companion-api-test" data-state={state}>
    <small>{description}</small>
    <div className="companion-setup-actions"><button type="button" onClick={start} disabled={disabled || state === 'running'}>{state === 'running' ? '测试中…' : label}</button>
      {state === 'running' && <button type="button" onClick={cancel}>取消测试</button>}
      {state !== 'idle' && <span className="companion-test-time">{(elapsed / 1000).toFixed(1)} 秒</span>}
    </div>
    <div role="status" aria-live="polite"><strong>{state === 'success' ? '测试通过 · ' : state === 'error' ? '测试失败 · ' : ''}{message}</strong>{detail && <pre>{detail}</pre>}</div>
    <CompanionMicMeter data={micDiagnostics} active={state === 'running'}/>
  </div>;
}

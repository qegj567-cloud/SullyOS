import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { COMPANION_STAGES, overlapMs, type CompanionDebugStore, type CompanionDebugRequest, type CompanionDebugTurn, type CompanionStage } from '../../utils/companion/debug';

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const statusText = { running: '进行中', done: '结束', cancelled: '已打断', error: '出错', skipped: '跳过' };

function RequestPrompt({ request, title }: { request?: CompanionDebugRequest; title: string }) {
  const body = useMemo(() => request ? JSON.parse(request.body) : undefined, [request?.body]);
  const counts = useMemo(() => body ? {
    bytes: new TextEncoder().encode(request!.body).length,
    text: body.messages.reduce((sum: number, message: { content: unknown }) => sum + (typeof message.content === 'string'
      ? message.content.length : Array.isArray(message.content) ? message.content.reduce((n: number, part: any) => n + (part.type === 'text' ? String(part.text ?? '').length : 0), 0) : 0), 0),
  } : undefined, [body]);
  const [copied, setCopied] = useState('');
  useEffect(() => setCopied(''), [request?.body]);
  if (!request) return <p className="companion-debug-note">{title}：尚未提交请求。</p>;
  return <details className="companion-debug-prompt">
    <summary>{title} · 实际请求提示词 · {body.messages.length} 条</summary>
    <p>模型：{body.model} · {body.stream ? '流式' : '整包'} · temperature {body.temperature} · max_tokens {body.max_tokens ?? '未指定'}</p>
    <p>文本 {counts!.text.toLocaleString()} 字符 · 请求体 {(counts!.bytes / 1024).toFixed(1)} KiB（含附图编码；不是 Token 数）</p>
    <p>传输层响应：{request.headers ? `提交后 ${seconds(request.headers.at - request.submitted)} · HTTP ${request.headers.status} · ${request.headers.streaming ? '流式响应' : '整包响应'}` : '尚未收到响应头'}；收到响应头不代表已生成正文。</p>
    <p>提交于 +{seconds(request.submitted)}；首段正文：{request.firstDelta === undefined ? '未观测到（不推算首字耗时）' : `提交后 ${seconds(request.firstDelta - request.submitted)}`}</p>
    <button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(request.body); setCopied('已复制请求体'); }
      catch { setCopied('复制失败，可选中下方文字复制'); }
    }}>复制完整请求 JSON</button><span role="status">{copied}</span>
    {body.messages.map((message: { role: string; content: unknown }, index: number) => <details key={index} className="companion-debug-message">
      <summary>{index + 1}. {message.role} · {typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content)?.length ?? 0} 字符</summary>
      <pre>{typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2)}</pre>
    </details>)}
    {request.response !== undefined && <details className="companion-debug-message"><summary>生成的回复全文</summary><pre>{request.response}</pre></details>}
  </details>;
}

function TurnDetails({ turn, elapsed }: { turn: CompanionDebugTurn; elapsed: number }) {
  const total = Math.max(1, turn.end ?? elapsed);
  const recallOverlap = overlapMs(turn.stages.quick_request, turn.stages.memory, total);
  const audioOverlap = overlapMs(turn.stages.quick_audio, turn.stages.full_request, total);
  const quickEnd = turn.delivery.quick?.end;
  const fullStart = turn.stages.full_audio?.start;
  const audioGap = turn.delivery.quick?.mode === 'audio' && turn.delivery.full?.mode === 'audio' && quickEnd !== undefined && fullStart !== undefined
    ? Math.max(0, fullStart - quickEnd) : undefined;
  const textMode = turn.delivery.quick?.mode === 'text' || turn.delivery.full?.mode === 'text';
  const unavailableAudio = textMode ? '不适用（文字模式）' : turn.status === 'running' ? '等待实际出声' : '未完成两段语音播放';
  return <>
    <p className="companion-debug-input">{turn.input}</p>
    <p className="companion-debug-metrics">短回复 × 召回重叠：{turn.stages.memory?.status === 'skipped' ? '召回已跳过' : recallOverlap === undefined ? '尚未观测到两阶段' : seconds(recallOverlap)}<br/>
      a 播放 × a′ 生成重叠：{audioOverlap === undefined ? unavailableAudio : seconds(audioOverlap)}<br/>
      两段语音衔接空隙：{audioGap === undefined ? unavailableAudio : seconds(audioGap)}
    </p>
    <p className="companion-debug-note">统一从本轮开始计时。横条按同一时间轴对齐；父阶段包含子阶段，耗时不能相加。未执行的阶段不会画成 0 秒。</p>
    <div className="companion-debug-table-wrap">
      <table className="companion-debug-table"><caption>本轮时间线 · 0 → {seconds(total)} · {statusText[turn.status]}</caption>
        <thead><tr><th>阶段／时间线</th><th>开始 +</th><th>结束 +</th><th>耗时</th></tr></thead>
        <tbody>{(Object.keys(COMPANION_STAGES) as CompanionStage[]).map(key => {
          const span = turn.stages[key];
          if (!span) return null;
          const end = span.end ?? total;
          return <tr key={key} data-stage={key} data-state={span.status}>
            <th scope="row"><span>{COMPANION_STAGES[key]}</span>
              <span className="companion-debug-track"><i style={{ left: `${span.start / total * 100}%`, width: `${Math.max(0, end - span.start) / total * 100}%` }}/></span>
              <small>{statusText[span.status]}{span.note ? ` · ${span.note}` : ''}</small>
            </th>
            <td>{seconds(span.start)}</td><td>{span.end === undefined ? '—' : seconds(span.end)}</td><td>{seconds(end - span.start)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {!turn.stages.memory && <p className="companion-debug-note">记忆召回：{turn.status === 'running' ? '尚未进入' : '本轮未进入'}。</p>}
    <p className="companion-debug-note">请求快照取自提交给共享传输层的同一份请求体，未重新拼装。原生接口仍由共享适配器转换；这里不是底层 HTTP 抓包。未记录地址、请求头或凭据。</p>
    <RequestPrompt key={`quick-${turn.id}`} request={turn.requests.quick} title="短回复 a"/>
    <RequestPrompt key={`full-${turn.id}`} request={turn.requests.full} title="长回复 a′"/>
    <p className="companion-debug-note">出声由播放器事件测量，PCM 约有 80ms 采样误差。文字模式不计作语音；被打断轮次保留截至打断的耗时，迟到结果不再更新。仅本页内存保留最近 5 轮，离开或换角色清空。</p>
  </>;
}

export function CompanionDebugPanel({ store }: { store: CompanionDebugStore }) {
  const turns = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('latest');
  const [now, setNow] = useState(() => store.now());
  const turn = (selected === 'latest' ? undefined : turns.find(item => String(item.id) === selected)) ?? turns.at(-1);
  useEffect(() => {
    if (!open || turn?.status !== 'running') return;
    setNow(store.now());
    const timer = setInterval(() => setNow(store.now()), 200);
    return () => clearInterval(timer);
  }, [open, turn?.id, turn?.status, store]);
  return <details className="companion-debug" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>本轮调试 <span>{turn ? `第 ${turn.id} 轮 · ${statusText[turn.status]}` : '耗时与实际提示词'}</span></summary>
    {open && <div className="companion-debug-body">
      {!!turns.length && <label>查看轮次 <select aria-label="调试轮次" value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="latest">跟随最新一轮</option>
        {[...turns].reverse().map(item => <option key={item.id} value={item.id}>第 {item.id} 轮 · {statusText[item.status]} · {item.input.slice(0, 20)}</option>)}
      </select></label>}
      {turn ? <TurnDetails turn={turn} elapsed={Math.max(0, now - turn.origin, store.now() - turn.origin)}/> : <p>发一句话后，这里会显示并行时间线和两次实际请求。展开面板不会额外调用模型。</p>}
    </div>}
  </details>;
}

import React, { useEffect, useRef, useState } from 'react';
import Modal from '../os/Modal';
import ConfirmDialog from '../os/ConfirmDialog';
import type { CharacterProfile } from '../../types';
import { ActiveMsgClient } from '../../utils/activeMsgClient';
import {
  CloudDataError, CLOUD_RESOURCE_LABELS, cloudResourceIdentity, describeCloudOperation, mergeCloudResourcePage, readCloudPageSummary,
  type CloudDataSession, type CloudResource, type CloudResourceType, type CloudDataGap,
  type CloudDataSummary, type CloudCleanupPlan, type CloudCleanupOperation, type CloudOwner, type CloudOwnerState,
} from '../../utils/amsgCloudData';
import { collectCloudInventory, formatCloudSize, type CloudInventory } from '../../utils/amsgCloudInventory';
import { pendingCloudRetirements, retireCloudCharacter } from '../../utils/amsgCloudRetirement';
import { readDetachedWorkers } from '../../utils/amsgDetachedWorkers';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  characters: CharacterProfile[];
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const buttonClass = 'rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const ownerKey = (owner: CloudOwner) => JSON.stringify([owner.type, owner.id]);
const RESOURCE_STATUS_LABELS: Record<string, string> = { pending: '待处理', running: '处理中', processing: '处理中', completed: '已完成', failed: '失败', acked: '已接收', delivered: '已送达', registered: '已登记', unreadable: '内容无法读取', 'orphan-chunks': '残留数据切片' };
const resourceStatus = (status: string) => RESOURCE_STATUS_LABELS[status] ?? status;
const localDate = (time: number | null) => time == null ? '更新时间未知' : new Date(time).toLocaleString();

const Gaps: React.FC<{ gaps: CloudDataGap[] }> = ({ gaps }) => gaps.length ? (
  <div className="space-y-1 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-800" role="status">
    <p className="font-semibold">部分数据尚未查清，不能据此判断云端已空</p>
    {gaps.map((gap, index) => <p key={`${gap.source}:${gap.code}:${index}`}>{gap.message}</p>)}
  </div>
) : null;

/** 以服务端资源为清单；本地角色只补充身份提示。清理状态留在服务端，不随关页丢失。 */
const AmsgCloudDataModal: React.FC<Props> = ({ isOpen, onClose, characters, addToast }) => {
  const [session, setSession] = useState<CloudDataSession | null>(null);
  const [resources, setResources] = useState<CloudResource[]>([]);
  const [summary, setSummary] = useState<CloudDataSummary | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [gaps, setGaps] = useState<CloudDataGap[]>([]);
  const [complete, setComplete] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<CloudResourceType | ''>('');
  const [selectedOwner, setSelectedOwner] = useState<CloudOwner | null>(null);
  const [knownOwners, setKnownOwners] = useState<CloudOwnerState[]>([]);
  const [ownerState, setOwnerState] = useState<CloudOwnerState | null>(null);
  const [operations, setOperations] = useState<CloudCleanupOperation[]>([]);
  const [plan, setPlan] = useState<CloudCleanupPlan | null>(null);
  const [restore, setRestore] = useState<CloudOwner | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [legacy, setLegacy] = useState<CloudInventory | null>(null);
  const [operationError, setOperationError] = useState('');
  const [pendingRetirements, setPendingRetirements] = useState<Array<{ id: string; name: string }>>([]);
  const [lookupId, setLookupId] = useState('');
  const [detached, setDetached] = useState<string[]>([]);
  const epoch = useRef(0);
  const executing = useRef(false);
  const requestId = useRef('');

  const loadResources = async (current: CloudDataSession, options: { type?: CloudResourceType; owner?: CloudOwner; cursor?: string }, requestEpoch: number, includeSummary = false) => {
    const page = await current.listResources({ ...options, limit: 50 });
    if (epoch.current !== requestEpoch) return;
    setResources(previous => options.cursor ? mergeCloudResourcePage(previous, page.resources) : page.resources);
    setCursor(page.nextCursor);
    setComplete(page.complete);
    setGaps(previous => options.cursor ? [...previous, ...page.gaps] : page.gaps);
    if (includeSummary) {
      try {
        const pageSummary = await readCloudPageSummary(current, page);
        if (epoch.current === requestEpoch) setSummary(pageSummary);
      } catch (failure) {
        if (epoch.current === requestEpoch) setGaps(previous => [...previous, { source: 'summary', code: 'READ_FAILED', message: errorText(failure) }]);
      }
    }
  };

  const open = async () => {
    const requestEpoch = ++epoch.current;
    setBusy(true); setComplete(false); setGaps([]); setPendingRetirements([]); setError(''); setUnsupported(false); setLegacy(null); setSession(null);
    setResources([]); setSelected(new Set()); setFilter(''); setSelectedOwner(null); setOwnerState(null); setKnownOwners([]);
    setSummary(null); setOperations([]); setOperationError(''); setPlan(null); setRestore(null); setCursor(null);
    try {
      const current = await ActiveMsgClient.openCloudDataSession();
      if (epoch.current !== requestEpoch) return;
      setSession(current);
      try { setPendingRetirements(pendingCloudRetirements(current)); }
      catch { setError('本机的未确认请求记录无法读取，云端清单仍可查看和管理。'); }
      const results = await Promise.allSettled([
        loadResources(current, {}, requestEpoch, true), current.listOperations(), current.listOwners(),
      ]);
      if (epoch.current !== requestEpoch) return;
      if (results[0].status === 'rejected') setError(errorText(results[0].reason));
      if (results[1].status === 'fulfilled') {
        setOperations(results[1].value.operations);
        if (!results[1].value.complete) setOperationError('最近清理记录未能完整读取，请刷新记录重试。');
      } else setOperationError(errorText(results[1].reason));
      if (results[2].status === 'fulfilled') {
        const directory = results[2].value; setKnownOwners(directory.owners);
        if (!directory.complete || directory.gaps.length) setGaps(previous => [...previous, { source: 'owners', code: 'INCOMPLETE', message: '角色目录尚未完整读取，已停用角色可能暂未列出。' }, ...directory.gaps]);
      } else { const message = errorText(results[2].reason); setGaps(previous => [...previous, { source: 'owners', code: 'READ_FAILED', message }]); }
    } catch (failure) {
      if (epoch.current !== requestEpoch) return;
      setUnsupported(failure instanceof CloudDataError && failure.code === 'CLOUD_DATA_UNSUPPORTED');
      setError(errorText(failure));
    } finally { if (epoch.current === requestEpoch) setBusy(false); }
  };

  useEffect(() => {
    if (isOpen) { setDetached(readDetachedWorkers().map(row => row.url)); void open(); }
    return () => { epoch.current += 1; };
  }, [isOpen]);

  // 只轮询未结束操作的轻量记录；不会按时扫描整个数据库。
  const pendingIds = operations.filter(operation => operation.status === 'pending' || operation.status === 'running').map(operation => operation.id).join('|');
  useEffect(() => {
    if (!isOpen || !session || !pendingIds) return;
    let cancelled = false;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const updates = await Promise.allSettled(pendingIds.split('|').map(id => session.getOperation(id)));
        if (cancelled) return;
        const successful = updates.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
        setOperations(previous => previous.map(operation => successful.find(update => update.id === operation.id) ?? operation));
        if (updates.some(result => result.status === 'rejected')) setOperationError('暂时读不到部分清理进度，云端操作不会因此取消。');
        else setOperationError('');
      } finally { polling = false; }
    }, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isOpen, session, pendingIds]);

  const refresh = async (nextFilter = filter, nextOwner = selectedOwner, nextCursor?: string) => {
    if (!session || busy) return;
    const requestEpoch = ++epoch.current;
    setBusy(true); setError('');
    if (!nextCursor) { setResources([]); setCursor(null); setSelected(new Set()); }
    setFilter(nextFilter); setSelectedOwner(nextOwner); setOwnerState(null);
    try {
      await loadResources(session, { ...(nextFilter ? { type: nextFilter } : {}), ...(nextOwner ? { owner: nextOwner } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) }, requestEpoch, !nextCursor);
      if (nextOwner) {
        const state = await session.getOwner(nextOwner);
        if (epoch.current === requestEpoch) setOwnerState(state);
      } else setOwnerState(null);
    } catch (failure) { if (epoch.current === requestEpoch) setError(errorText(failure)); }
    finally { if (epoch.current === requestEpoch) setBusy(false); }
  };

  const preview = async (owner?: CloudOwner) => {
    if (!session || executing.current) return;
    executing.current = true; setBusy(true); setError('');
    try {
      const next = await session.prepare(owner ? { mode: 'retire-owner', owner } : { mode: 'purge', resourceIds: [...selected] });
      requestId.current = crypto.randomUUID();
      setPlan(next);
    } catch (failure) { setError(errorText(failure)); }
    finally { executing.current = false; setBusy(false); }
  };

  const execute = async () => {
    if (!session || !plan || executing.current) return;
    executing.current = true; setBusy(true); setError('');
    try {
      const operation = await session.start(plan, requestId.current);
      setOperations(previous => [operation, ...previous.filter(row => row.id !== operation.id)]);
      setPlan(null); setSelected(new Set());
      addToast(operation.status === 'failed' ? '清理未完成，请查看下面的失败原因。' : describeCloudOperation(operation).complete ? '云端已确认清理完成。' : '清理已交给云端，可在最近清理中查看进度。', operation.status === 'failed' ? 'error' : 'info');
    } catch (failure) { setError(errorText(failure)); }
    finally { executing.current = false; setBusy(false); }
  };

  const restoreOwner = async () => {
    if (!session || !restore || executing.current) return;
    executing.current = true; setBusy(true);
    try {
      await session.restoreOwner(restore);
      setRestore(null);
      addToast('已允许这个角色重新写入云端，旧数据和旧任务不会恢复。', 'success');
      await open();
    } catch (failure) { setRestore(null); setError(errorText(failure)); }
    finally { executing.current = false; setBusy(false); }
  };

  const retryRetirement = async (character: { id: string; name: string }) => {
    if (busy || executing.current) return;
    executing.current = true; setBusy(true);
    try {
      const result = await retireCloudCharacter(character, session ?? undefined);
      if (result.status === 'failed') { setError(result.detail); return; }
      if (result.status !== 'accepted') { setError('当前连接还不能确认完整清理，请更新 Worker 后重试。'); return; }
      addToast(result.completed ? '云端清理完成。' : '云端已受理，可在最近清理中查看进度。', 'info');
      await open();
    } finally { executing.current = false; setBusy(false); }
  };

  const readLegacy = async () => {
    setBusy(true);
    try { setLegacy(await collectCloudInventory(characters)); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };

  const refreshOperations = async () => {
    if (!session) return;
    try {
      const result = await session.listOperations(); setOperations(result.operations);
      setOperationError(result.complete ? '' : '清理记录尚未完整读取。');
    } catch (failure) { setOperationError(errorText(failure)); }
  };

  const owners = [...new Map([
    ...knownOwners.filter(state => state.owner.type === 'character').map(state => state.owner),
    ...resources.flatMap(row => row.owner?.type === 'character' ? [row.owner] : []),
    ...operations.flatMap(row => row.owner?.type === 'character' ? [row.owner] : []),
    ...(selectedOwner ? [selectedOwner] : []),
  ].map(owner => [ownerKey(owner), owner])).values()];
  const close = () => { if (!executing.current) onClose(); };
  const allGaps = [...gaps, ...(summary?.gaps ?? []), ...(summary && !summary.complete && !summary.gaps.length ? [{ source: 'summary', code: 'INCOMPLETE', message: '云端汇总尚未确认完整。' }] : [])];

  return <>
    <Modal isOpen={isOpen && !plan && !restore} title="云端数据管理" onClose={close} footer={<div className="flex w-full gap-2">
      <button type="button" onClick={close} disabled={busy} className={`${buttonClass} flex-1`}>关闭</button>
      {session && <button type="button" disabled={busy || !selected.size} onClick={() => void preview()} className="flex-1 rounded-xl bg-rose-600 px-3 py-3 text-xs font-bold text-white disabled:opacity-40">预览清理 ({selected.size})</button>}
    </div>}>
      <div className="space-y-4 text-xs leading-relaxed">
        <p className="text-slate-600">直接查看这台 Worker 为当前用户存下的数据。本机找不到的角色也会显示；其他设备可能仍在使用，请按实际需要选择。</p>
        {session && <p className="break-all border-l-2 border-violet-300 pl-3 text-slate-500">当前连接：{session.workerUrl}</p>}
        {error && <div role="alert" className="rounded-xl bg-rose-50 p-3 text-rose-700">{error}<button type="button" className={`${buttonClass} mt-2 block bg-white`} disabled={busy} onClick={() => void open()}>重新连接</button></div>}
        {busy && <p role="status" className="text-slate-500">正在向云端确认…</p>}
        {unsupported && <div className="space-y-2"><p className="text-amber-800">旧版清单不包含所有结果和未知归属数据，只能作为线索。完整管理需要更新 Worker。</p><button type="button" className={buttonClass} disabled={busy} onClick={() => void readLegacy()}>查看旧版有限清单</button></div>}
        {legacy && <div className="divide-y divide-slate-100">{[...legacy.live, ...legacy.orphans].map(row => <div key={row.charId} className="py-2"><p>{row.local?.name ?? '本机未关联角色'}</p><p className="break-all text-slate-400">{row.charId}</p><p>{row.taskCount} 个任务，{row.credPurposes.length} 项凭据</p></div>)}{legacy.gaps.map(gap => <p key={gap.kind} className="py-2 text-amber-700">{gap.message}</p>)}{legacy.globals.map(row => <p key={row.namespace} className="break-all py-2">{row.namespace}：{formatCloudSize(row.usage.byteSize)}</p>)}</div>}
        {session && <>
          {summary && <div className="flex flex-wrap gap-x-4 gap-y-1 border-y border-slate-100 py-3 text-slate-600">{summary.counts.map(row => <span key={row.type}>{CLOUD_RESOURCE_LABELS[row.type]} <b>{row.count}</b></span>)}</div>}
          <Gaps gaps={allGaps} />
          {!!pendingRetirements.length && <div className="space-y-2 rounded-xl bg-amber-50 p-3 text-amber-800"><p className="font-semibold">本机尚未确认受理的删除请求</p><p>这是请求记录，实际清理进度以云端为准。</p>{pendingRetirements.map(character => <div key={character.id} className="flex items-center justify-between gap-2"><span className="min-w-0 break-all">{character.name}（{character.id}）</span><button type="button" disabled={busy} className={`${buttonClass} shrink-0`} onClick={() => void retryRetirement(character)}>重试删除</button></div>)}</div>}
          <div className="grid grid-cols-2 gap-2">
            <select aria-label="数据类别" value={filter} disabled={busy} onChange={event => void refresh(event.target.value as CloudResourceType | '')} className="min-w-0 rounded-xl border border-slate-200 bg-white p-2 text-slate-700"><option value="">所有类别</option>{Object.entries(CLOUD_RESOURCE_LABELS).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select>
            <select aria-label="角色归属" value={selectedOwner ? ownerKey(selectedOwner) : ''} disabled={busy} onChange={event => void refresh(filter, owners.find(owner => ownerKey(owner) === event.target.value) ?? null)} className="min-w-0 rounded-xl border border-slate-200 bg-white p-2 text-slate-700"><option value="">所有归属</option>{owners.map(owner => <option key={ownerKey(owner)} value={ownerKey(owner)}>{owner.label ?? owner.id}</option>)}</select>
          </div>
          <details className="text-slate-500"><summary className="cursor-pointer">按角色 ID 查找（包括已停用角色）</summary><div className="mt-2 flex gap-2"><input aria-label="角色 ID" value={lookupId} onChange={event => setLookupId(event.target.value)} placeholder="完整角色 ID" className="min-w-0 flex-1 rounded-xl border border-slate-200 p-2" /><button type="button" disabled={busy || !lookupId.trim()} className={buttonClass} onClick={() => void refresh('', { type: 'character', id: lookupId.trim() })}>查询</button></div></details>
          {selectedOwner && <div className="space-y-2 border-l-2 border-rose-200 pl-3"><p className="break-all text-slate-600">{selectedOwner.label ?? '未命名角色'}：{selectedOwner.id}</p>{ownerState?.retired ? <p className="text-rose-700">云端已停用此角色，旧请求不能重新写入。</p> : null}<div className="flex flex-wrap gap-2"><button type="button" disabled={busy} className={`${buttonClass} text-rose-700`} onClick={() => void preview(selectedOwner)}>彻底移除云端数据</button>{ownerState?.complete && <button type="button" disabled={busy} className={buttonClass} onClick={() => setRestore(selectedOwner)}>{ownerState.retired ? '允许重新使用' : '在本机重新连接'}</button>}</div></div>}
          <div className="flex items-center justify-between gap-2 text-slate-500"><span>已加载 {resources.length} 项{cursor ? '，后面还有' : complete ? '' : '，清单未确认完整'}</span><button type="button" className={buttonClass} disabled={busy} onClick={() => void refresh()}>重新清点</button></div>
          {resources.length > 0 && <div className="flex gap-3"><button type="button" className="text-violet-700" disabled={busy} onClick={() => setSelected(new Set(resources.map(row => row.id)))}>选中已加载项</button><button type="button" className="text-slate-500" disabled={busy} onClick={() => setSelected(new Set())}>取消选择</button></div>}
          <div className="divide-y divide-slate-100">
            {resources.map(row => {
              const identity = cloudResourceIdentity(row, characters);
              return <label key={row.id} className="flex cursor-pointer items-start gap-3 py-3">
                <input type="checkbox" checked={selected.has(row.id)} disabled={busy} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })} className="mt-1 h-4 w-4 shrink-0 accent-rose-600" />
                <span className="min-w-0 flex-1"><span className="block break-words font-semibold text-slate-800">{identity.name}</span><span className="block break-all text-[10px] text-slate-500">{identity.detail}{row.owner?.type === 'character' ? identity.local ? '（本机有关联）' : '（本机未关联）' : ''}</span><span className="mt-1 block break-all text-slate-600">{CLOUD_RESOURCE_LABELS[row.type]}：{row.label}</span><span className="block text-[10px] text-slate-400">{row.byteSize == null ? '大小未知' : formatCloudSize(row.byteSize)} · {localDate(row.updatedAt)}{row.status ? ` · ${resourceStatus(row.status)}` : ''}</span></span>
              </label>;
            })}
          </div>
          {!busy && resources.length === 0 && <p className="py-4 text-center text-slate-400">{complete && !allGaps.length ? '这个范围没有云端数据。' : '当前没有可显示的记录，清单仍待确认。'}</p>}
          {cursor && <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={() => void refresh(filter, selectedOwner, cursor)}>继续加载</button>}
          <section className="space-y-2 border-t border-slate-200 pt-4"><div className="flex items-center justify-between"><h4 className="font-bold text-slate-700">最近清理</h4><button type="button" className={buttonClass} onClick={() => void refreshOperations()}>刷新记录</button></div><p className="text-slate-500">后续批次由 Worker 的定时触发继续处理；若暂停了后台任务，请先恢复。完成后可重新清点核对。</p>{operationError && <p role="alert" className="text-amber-700">{operationError}</p>}
            {operations.map(operation => {
              const result = describeCloudOperation(operation);
              return <div key={operation.id} className="space-y-1 border-b border-slate-100 py-3"><p className={result.complete ? 'font-semibold text-emerald-700' : 'font-semibold text-slate-700'}>{result.label}{operation.owner ? ` · ${operation.owner.label ?? operation.owner.id}` : ''}</p><p className="text-slate-500">已删 {result.deleted}，剩余 {result.remaining}，失败 {result.failed}</p>{operation.counts.map(row => <p key={row.type} className="text-[10px] text-slate-500">{CLOUD_RESOURCE_LABELS[row.type]}：已删 {row.deleted} / 剩余 {row.remaining} / 失败 {row.failed}</p>)}{operation.errors.map((item, index) => <p key={index} className="break-words text-rose-700">{item.message}</p>)}<p className="break-all text-[10px] text-slate-400">{operation.id}</p>{operation.owner?.type === 'character' && <button type="button" className="text-violet-700" disabled={busy} onClick={() => void refresh('', operation.owner)}>查看此角色</button>}</div>;
            })}
            {!operations.length && !operationError && <p className="text-slate-400">还没有清理记录。</p>}
          </section>
        </>}
        {!!detached.length && <details className="border-t border-slate-100 pt-3 text-slate-500"><summary className="cursor-pointer">以前断开的 Worker</summary><p className="py-2">当前清单不包含这些连接。需要管理时，在配置里重新连接对应地址。</p>{detached.map(url => <p key={url} className="break-all">{url}</p>)}</details>}
      </div>
    </Modal>
    <Modal isOpen={isOpen && !!plan} title={plan?.mode === 'retire-owner' ? '确认彻底移除' : '确认清理范围'} onClose={() => { if (!busy) { setPlan(null); setError(''); } }} footer={<div className="flex w-full gap-2"><button type="button" disabled={busy} onClick={() => { setPlan(null); setError(''); }} className={`${buttonClass} flex-1`}>返回</button><button type="button" disabled={busy || !plan?.complete || !!plan.gaps.length} onClick={() => void execute()} className="flex-1 rounded-xl bg-rose-600 px-3 py-3 text-xs font-bold text-white disabled:opacity-40">{busy ? '正在提交…' : '确认清理'}</button></div>}>
      {plan && <div className="space-y-3 text-xs leading-relaxed text-slate-600"><p>以下范围由云端确认，共 {plan.count} 项。</p>{plan.counts.map(row => <p key={row.type}>{CLOUD_RESOURCE_LABELS[row.type]}：{row.count} 项</p>)}{!!plan.resources.length && <details><summary className="cursor-pointer font-semibold">查看具体数据</summary><div className="mt-2 max-h-48 space-y-2 overflow-y-auto">{plan.resources.map(resource => <p key={resource.id} className="break-all">{cloudResourceIdentity(resource, characters).name} · {CLOUD_RESOURCE_LABELS[resource.type]}：{resource.label}</p>)}</div></details>}<p className="break-all">当前连接：{session?.workerUrl}</p>{plan.owner && <p className="break-all">归属：{plan.owner.label ?? plan.owner.id}（{plan.owner.id}）</p>}<p className="font-semibold text-rose-700">{plan.mode === 'retire-owner' ? '先停用此角色，再清除执行时它名下的全部云端数据。之后必须明确允许重新使用，才可继续上传；已发出的通知无法撤回。归属未知的记录需要单独检查。' : '只删除预览中选定的数据，不会删除本地记录。后续聊天可能重新上传；清除上下文或凭据可能使相关任务失败。'}</p>{plan.impacts.map((impact, index) => <p key={index}>{impact}</p>)}<Gaps gaps={plan.gaps} /><p>已清除的数据无法撤销。</p>{error && <p role="alert" className="text-rose-700">{error}</p>}</div>}
    </Modal>
    <ConfirmDialog isOpen={isOpen && !!restore} title="允许重新写入云端" message={`允许「${restore?.label ?? '此角色'}」（${restore?.id ?? ''}）在这台设备上重新使用云端。旧数据和旧任务不会恢复，也不会重新接受删除前的旧请求。`} confirmText={busy ? '处理中…' : '允许'} onConfirm={() => void restoreOwner()} onCancel={() => { if (!busy) setRestore(null); }} />
  </>;
};

export default AmsgCloudDataModal;

import React, { useCallback, useMemo, useState } from 'react';
import {
  ArrowsClockwise,
  CaretDown,
  ClipboardText,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import { ActiveMsgClient, type AmsgPromptAuditEntry } from '../../utils/activeMsgClient';

interface ActiveMsgPromptAuditPanelProps {
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const formatTime = (value: number | null | undefined) => {
  if (!value) return '未知时间';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return '未知时间';
  }
};

const describeStatus = (status: string) => {
  if (status === 'sent') return '已发送';
  if (status === 'failed') return '失败';
  if (status === 'skipped') return '已跳过';
  if (status === 'settled') return '已结束';
  return status || '未知';
};

const readTokenCount = (entry: AmsgPromptAuditEntry) => {
  const total = entry.usage?.totalTokens;
  return typeof total === 'number' && Number.isFinite(total) ? `${total} tokens` : 'tokens 未返回';
};

const ActiveMsgPromptAuditPanel: React.FC<ActiveMsgPromptAuditPanelProps> = ({ addToast }) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [entries, setEntries] = useState<AmsgPromptAuditEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const nextEntries = await ActiveMsgClient.listPromptAudits(20);
      setEntries(nextEntries);
      setLoadedOnce(true);
    } catch (err: any) {
      const message = err?.message || '读取云端 Prompt 审计失败。';
      setError(message);
      addToast(message, 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const handleToggle = () => {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen && !loadedOnce && !loading) void refresh();
  };

  const handleClear = async () => {
    if (clearing) return;
    const ok = window.confirm('确定清空云端 Prompt 审计吗？这只会删除审计记录，不会删除主动消息任务。');
    if (!ok) return;
    setClearing(true);
    try {
      const result = await ActiveMsgClient.clearPromptAudits();
      setEntries([]);
      setExpandedId(null);
      addToast(`已清空 ${result.deleted} 条云端 Prompt 审计。`, 'success');
    } catch (err: any) {
      const message = err?.message || '清空云端 Prompt 审计失败。';
      setError(message);
      addToast(message, 'error');
    } finally {
      setClearing(false);
    }
  };

  const summary = useMemo(() => {
    if (!loadedOnce) return '未读取';
    if (loading) return '读取中';
    return entries.length ? `${entries.length} 条` : '暂无记录';
  }, [entries.length, loadedOnce, loading]);

  return (
    <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
      <div className={`flex items-center justify-between gap-2 ${open ? 'mb-4' : ''}`}>
        <button
          type="button"
          onClick={handleToggle}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <div className="p-2 bg-violet-100/70 rounded-xl text-violet-600">
            <ClipboardText size={17} weight="bold" />
          </div>
          <h2 className="text-sm font-semibold text-slate-600 tracking-wider">云端 Prompt 审计</h2>
          <span className="text-[10px] font-semibold shrink-0 text-slate-400">{summary}</span>
          <CaretDown
            size={13}
            weight="bold"
            className={`text-slate-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {open ? (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading || clearing}
              className="p-2 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:text-slate-300"
              title="刷新审计"
            >
              <ArrowsClockwise size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={loading || clearing || entries.length === 0}
              className="p-2 rounded-full bg-rose-50 border border-rose-100 text-rose-500 hover:bg-rose-100 disabled:text-rose-200 disabled:bg-slate-50 disabled:border-slate-100"
              title="清空审计"
            >
              <Trash size={14} weight="bold" />
            </button>
          </div>
        ) : null}
      </div>

      {open ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-2xl bg-amber-50 border border-amber-100 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
            <WarningCircle size={15} weight="bold" className="mt-0.5 shrink-0" />
            <p>只查看你自己 Worker/D1 里的主动消息 prompt，保留 5 天；需要设置页里填了正确的共享密钥。</p>
          </div>

          {error ? (
            <div className="rounded-2xl bg-rose-50 border border-rose-100 px-3 py-2 text-[11px] leading-relaxed text-rose-600">
              {error}
            </div>
          ) : null}

          {loading && !entries.length ? (
            <p className="text-[11px] text-slate-400">正在读取云端审计...</p>
          ) : null}

          {!loading && loadedOnce && entries.length === 0 ? (
            <p className="text-[11px] text-slate-400">还没有云端 Prompt 审计记录。</p>
          ) : null}

          <div className="space-y-2">
            {entries.map((entry) => {
              const expanded = expandedId === entry.id;
              return (
                <div key={entry.id} className="rounded-2xl border border-slate-100 bg-slate-50/70 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : entry.id)}
                    className="w-full px-3 py-2.5 flex items-center justify-between gap-3 text-left"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-700 truncate">
                        {entry.charName || entry.charId || '未知角色'} · {describeStatus(entry.status)}
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 truncate">
                        {formatTime(entry.createdAt)} · {entry.model || '模型未返回'} · {readTokenCount(entry)}
                      </div>
                    </div>
                    <CaretDown
                      size={13}
                      weight="bold"
                      className={`text-slate-300 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {expanded ? (
                    <div className="border-t border-slate-100 px-3 py-3 space-y-3">
                      <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-500">
                        <div>任务：{entry.clientTaskId || entry.taskUuid || entry.taskRowId || '未知'}</div>
                        <div>触发：{formatTime(entry.occurrenceMs)}</div>
                        <div>过期：{formatTime(entry.expiresAt)}</div>
                        <div>轮次：{entry.rounds.length}</div>
                      </div>

                      <div>
                        <div className="text-[10px] font-bold text-slate-500 mb-1">Prompt 模块</div>
                        {entry.promptModules.length ? (
                          <div className="flex flex-wrap gap-1.5">
                            {entry.promptModules.map((module) => (
                              <span
                                key={module.key}
                                className={`px-2 py-1 rounded-full text-[10px] font-semibold ${
                                  module.included
                                    ? 'bg-emerald-50 text-emerald-600'
                                    : 'bg-slate-100 text-slate-400'
                                }`}
                              >
                                {module.label || module.key}：{module.included ? '已注入' : '未注入'}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[10px] text-slate-400">暂无模块快照。</p>
                        )}
                      </div>

                      {entry.outputText ? (
                        <div>
                          <div className="text-[10px] font-bold text-slate-500 mb-1">发出的正文</div>
                          <p className="rounded-xl bg-white border border-slate-100 px-3 py-2 text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap break-words">
                            {entry.outputText}
                          </p>
                        </div>
                      ) : null}

                      <div>
                        <div className="text-[10px] font-bold text-slate-500 mb-1">完整 Prompt</div>
                        <textarea
                          readOnly
                          value={entry.prompt}
                          className="w-full h-64 resize-y rounded-xl bg-white border border-slate-100 px-3 py-2 text-[11px] leading-relaxed text-slate-600 font-mono"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
};

export default React.memo(ActiveMsgPromptAuditPanel);

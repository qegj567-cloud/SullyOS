import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../context/OSContext';
import { useChatAI } from '../hooks/useChatAI';
import { DB } from '../utils/db';
import { Message } from '../types';
import { Plugs, Power, Trash, Plug } from '@phosphor-icons/react';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import TokenImg from '../components/os/TokenImg';
import { trackEvent } from '../utils/analytics';

const LS = {
  wsUrl: 'qqBridge:wsUrl',
  token: 'qqBridge:token',
  charId: 'qqBridge:charId',
  whitelist: 'qqBridge:whitelist',
  enabled: 'qqBridge:enabled',
} as const;

interface OneBotEvent {
  post_type?: string;
  message_type?: string;
  user_id?: number;
  raw_message?: string;
  message?: unknown;
  echo?: string;
}

const extractText = (m: unknown): string => {
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) {
    return m
      .filter((seg: any) => seg && seg.type === 'text')
      .map((seg: any) => seg?.data?.text || '')
      .join('');
  }
  return '';
};

const formatTs = (ts: number) => {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
};

const QQBridge: React.FC = () => {
  const {
    characters,
    characterGroups,
    apiConfig,
    userProfile,
    groups,
    realtimeConfig,
    memoryPalaceConfig,
    updateCharacter,
    updateUserProfile,
    closeApp,
  } = useOS();
  const [pickerGroupId, setPickerGroupId] = useState<string>(GROUP_FILTER_ALL); // 回复角色的分组筛选

  const [wsUrl, setWsUrl] = useState(() => localStorage.getItem(LS.wsUrl) || 'ws://127.0.0.1:3001');
  const [token, setToken] = useState(() => localStorage.getItem(LS.token) || '');
  const [charId, setCharId] = useState(() => localStorage.getItem(LS.charId) || '');
  const [whitelist, setWhitelist] = useState(() => localStorage.getItem(LS.whitelist) || '');
  const [enabled, setEnabled] = useState(() => localStorage.getItem(LS.enabled) === '1');

  useEffect(() => { localStorage.setItem(LS.wsUrl, wsUrl); }, [wsUrl]);
  useEffect(() => { localStorage.setItem(LS.token, token); }, [token]);
  useEffect(() => { localStorage.setItem(LS.charId, charId); }, [charId]);
  useEffect(() => { localStorage.setItem(LS.whitelist, whitelist); }, [whitelist]);
  useEffect(() => { localStorage.setItem(LS.enabled, enabled ? '1' : '0'); }, [enabled]);

  const char = useMemo(() => characters.find(c => c.id === charId) || null, [characters, charId]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [logs, setLogs] = useState<{ ts: number; text: string; kind: 'info' | 'in' | 'out' | 'error' }[]>([]);
  const [wsStatus, setWsStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [stats, setStats] = useState({ received: 0, sent: 0 });

  const wsRef = useRef<WebSocket | null>(null);
  const lastForwardedIdRef = useRef<number>(0);
  const activeQQUserRef = useRef<number | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const reconnectTimerRef = useRef<number | null>(null);

  const log = useCallback((text: string, kind: 'info' | 'in' | 'out' | 'error' = 'info') => {
    setLogs(prev => [...prev.slice(-199), { ts: Date.now(), text, kind }]);
  }, []);

  const chatAI = useChatAI({
    char: char || undefined,
    userProfile,
    apiConfig,
    groups,
    emojis: [],
    categories: [],
    addToast: (m: string) => log(`[toast] ${m}`),
    setMessages,
    realtimeConfig,
    memoryPalaceConfig,
    updateCharacter,
    updateUserProfile,
  });

  // Load history when char changes; mark existing assistant msgs as already-forwarded
  useEffect(() => {
    if (!char) {
      setMessages([]);
      lastForwardedIdRef.current = 0;
      return;
    }
    let cancelled = false;
    DB.getRecentMessagesByCharId(char.id, char.contextLimit || 200).then(msgs => {
      if (cancelled) return;
      setMessages(msgs);
      lastForwardedIdRef.current = msgs.reduce((acc, m) => Math.max(acc, m.id), 0);
    });
    return () => { cancelled = true; };
  }, [char?.id, char?.contextLimit]);

  // Forward newly arrived assistant text messages to QQ
  useEffect(() => {
    const target = activeQQUserRef.current;
    if (!target) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const fresh = messages.filter(m =>
      m.id > lastForwardedIdRef.current &&
      m.role === 'assistant' &&
      m.type === 'text' &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0
    );

    for (const m of fresh) {
      const text = m.content.replace(/\n%%BILINGUAL%%\n/g, '\n').trim();
      if (!text) {
        lastForwardedIdRef.current = Math.max(lastForwardedIdRef.current, m.id);
        continue;
      }
      try {
        ws.send(JSON.stringify({
          action: 'send_private_msg',
          params: { user_id: target, message: text },
          echo: `qq-${m.id}`,
        }));
        log(`→ [${target}] ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`, 'out');
        setStats(s => ({ ...s, sent: s.sent + 1 }));
      } catch (e: any) {
        log(`发送失败: ${e?.message || e}`, 'error');
      }
      lastForwardedIdRef.current = Math.max(lastForwardedIdRef.current, m.id);
    }
  }, [messages, log]);

  const handleEvent = useCallback((data: OneBotEvent) => {
    if (!data) return;
    if (data.echo) return;
    if (data.post_type === 'meta_event') return;
    if (data.post_type !== 'message' || data.message_type !== 'private') return;

    const userId = data.user_id;
    if (!userId) return;

    if (whitelist.trim()) {
      const allow = whitelist.split(/[\s,，]+/).filter(Boolean);
      if (!allow.includes(String(userId))) {
        log(`忽略非白名单 QQ: ${userId}`, 'info');
        return;
      }
    }

    const text = (data.raw_message || extractText(data.message) || '').trim();
    if (!text) {
      log(`← [${userId}] (非文本消息已跳过)`, 'info');
      return;
    }

    log(`← [${userId}] ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`, 'in');
    setStats(s => ({ ...s, received: s.received + 1 }));
    activeQQUserRef.current = userId;

    queueRef.current = queueRef.current
      .then(() => processMessage(userId, text))
      .catch(e => log(`处理失败: ${e?.message || e}`, 'error'));
  }, [whitelist, log]);

  const processMessage = useCallback(async (userId: number, text: string) => {
    if (!char) {
      log('未选择角色，已忽略', 'error');
      return;
    }
    await DB.saveMessage({
      charId: char.id,
      role: 'user',
      type: 'text',
      content: text,
      metadata: { source: 'qq', qqUserId: userId },
    });
    const fresh = await DB.getRecentMessagesByCharId(char.id, char.contextLimit || 200);
    setMessages(fresh);
    await chatAI.triggerAI(fresh);
  }, [char, chatAI, log]);

  // WS lifecycle
  useEffect(() => {
    if (!enabled) {
      setWsStatus('idle');
      return;
    }
    if (!wsUrl) {
      log('未填写 WebSocket 地址', 'error');
      setEnabled(false);
      return;
    }
    if (!char) {
      log('请先选择回复消息的角色', 'error');
      setEnabled(false);
      return;
    }
    if (!apiConfig.baseUrl) {
      log('请先在「设置」配置 LLM API（baseUrl / model）', 'error');
      setEnabled(false);
      return;
    }

    const sep = wsUrl.includes('?') ? '&' : '?';
    const fullUrl = token ? `${wsUrl}${sep}access_token=${encodeURIComponent(token)}` : wsUrl;
    setWsStatus('connecting');
    log(`正在连接 ${wsUrl} ...`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(fullUrl);
    } catch (e: any) {
      setWsStatus('error');
      log(`连接失败: ${e?.message || e}`, 'error');
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      log('已连接到 NapCat');
    };
    ws.onerror = () => {
      setWsStatus('error');
      log('WebSocket 错误（可能是 URL 错误或 NapCat 未启动）', 'error');
    };
    ws.onclose = () => {
      setWsStatus('idle');
      log('连接已断开');
    };
    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
        handleEvent(data);
      } catch (e: any) {
        log(`解析消息失败: ${e?.message}`, 'error');
      }
    };

    return () => {
      try { ws.close(); } catch {}
      if (wsRef.current === ws) wsRef.current = null;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [enabled, wsUrl, token, char?.id, apiConfig.baseUrl, handleEvent, log]);

  const statusColor = {
    idle: 'bg-slate-300 text-slate-700',
    connecting: 'bg-amber-300 text-amber-800 animate-pulse',
    connected: 'bg-emerald-400 text-emerald-900',
    error: 'bg-rose-400 text-rose-900',
  }[wsStatus];

  const statusText = {
    idle: '未连接',
    connecting: '连接中…',
    connected: '已连接',
    error: '连接失败',
  }[wsStatus];

  return (
    <div className="h-full w-full bg-slate-50/50 flex flex-col font-light relative">
      {/* Header */}
      <div className="bg-white/85 border-b border-white/40 shrink-0 z-10 sticky top-0" style={{ paddingTop: 'var(--safe-top)' }}>
        <div className="flex items-center px-4 py-3">
          <div className="flex items-center gap-2 w-full">
            <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
              </svg>
            </button>
            <h1 className="text-xl font-medium text-slate-700 tracking-wide">QQ 桥</h1>
            <span className={`ml-auto text-[10px] font-bold px-2 py-1 rounded-full ${statusColor}`}>{statusText}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5 no-scrollbar pb-20">
        {/* Intro */}
        <section className="bg-gradient-to-br from-sky-50 to-indigo-50 rounded-3xl p-5 border border-sky-100/80">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-2 bg-sky-100 rounded-xl text-sky-600"><Plugs weight="bold" className="w-4 h-4" /></div>
            <h2 className="text-sm font-semibold text-slate-700 tracking-wider">怎么用</h2>
          </div>
          <ol className="text-[11px] leading-5 text-slate-600 list-decimal pl-5 space-y-1">
            <li>在自己的小号上跑 NapCat（OneBot v11，反向 WebSocket 关掉，用「正向 WS」）。</li>
            <li>把 NapCat 的正向 WS 地址（默认 <code className="bg-white px-1 rounded">ws://127.0.0.1:3001</code>）填到下面。</li>
            <li>挑一个角色作为回复方，开关一打开就生效。</li>
            <li>页面要保持打开（这是 A 方案的代价：你的浏览器 = 你的 LLM 后端）。</li>
          </ol>
        </section>

        {/* NapCat connection */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <div className="p-2 bg-indigo-100 rounded-xl text-indigo-600"><Plug weight="bold" className="w-4 h-4" /></div>
            <h2 className="text-sm font-semibold text-slate-600 tracking-wider">NapCat 连接</h2>
          </div>

          <label className="block">
            <div className="text-[11px] text-slate-500 mb-1">WebSocket 地址</div>
            <input
              type="text"
              value={wsUrl}
              onChange={e => setWsUrl(e.target.value)}
              placeholder="ws://127.0.0.1:3001"
              disabled={enabled}
              className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-sky-300 disabled:opacity-60"
            />
          </label>

          <label className="block">
            <div className="text-[11px] text-slate-500 mb-1">Access Token（可选，NapCat 没设可留空）</div>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="留空即不发送"
              disabled={enabled}
              className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-sky-300 disabled:opacity-60"
            />
          </label>

          <label className="block">
            <div className="text-[11px] text-slate-500 mb-1">QQ 白名单（多个用空格/逗号分隔，留空 = 任何人都能聊）</div>
            <input
              type="text"
              value={whitelist}
              onChange={e => setWhitelist(e.target.value)}
              placeholder="例如 12345678 87654321"
              className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-sky-300"
            />
          </label>
        </section>

        {/* Character picker */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-sm font-semibold text-slate-600 tracking-wider">回复角色</h2>
          </div>

          {characters.length === 0 ? (
            <div className="text-xs text-slate-500">还没有角色，请先去「神经链接」创建一个。</div>
          ) : (
            <>
            {/* 分组筛选（没建分组时不渲染）：只影响显示，已选角色不受影响 */}
            <CharacterGroupFilterBar characters={characters} groups={characterGroups}
              value={pickerGroupId} onChange={setPickerGroupId} className="mb-2" />
            <div className="grid grid-cols-2 gap-2">
              {filterCharactersByGroup(characters, characterGroups, pickerGroupId).map(c => {
                const selected = c.id === charId;
                return (
                  <button
                    key={c.id}
                    onClick={() => !enabled && setCharId(c.id)}
                    disabled={enabled}
                    className={`flex items-center gap-2 p-2 rounded-2xl border text-left transition-all ${
                      selected
                        ? 'bg-sky-50 border-sky-300 shadow-sm'
                        : 'bg-white border-slate-200 hover:border-sky-200'
                    } ${enabled ? 'opacity-70 cursor-not-allowed' : 'active:scale-95'}`}
                  >
                    <TokenImg value={c.avatar} alt="" className="w-8 h-8 rounded-full object-cover" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-slate-700 truncate">{c.name}</div>
                      <div className="text-[10px] text-slate-400 truncate">{c.description || '—'}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            </>
          )}
        </section>

        {/* Master switch */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-700">桥接开关</div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {enabled
                  ? '已启用 — 收到的 QQ 私聊会走当前角色的完整上下文。'
                  : '关闭中 — 打开后会立刻连接 NapCat。'}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">
                收到 {stats.received} 条 · 已回复 {stats.sent} 条
              </div>
            </div>
            <button
              onClick={() => { setEnabled(v => !v); trackEvent('切换 QQ 桥接开关', { action: enabled ? 'off' : 'on' }); }}
              className={`shrink-0 px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-all active:scale-95 ${
                enabled
                  ? 'bg-rose-500 text-white shadow-sm'
                  : 'bg-emerald-500 text-white shadow-sm'
              }`}
            >
              <Power weight="bold" className="w-4 h-4" />
              {enabled ? '停止' : '启动'}
            </button>
          </div>
          {chatAI.isTyping && (
            <div className="mt-3 text-[11px] text-sky-600 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse"></span>
              {char?.name} 正在生成回复…
            </div>
          )}
        </section>

        {/* Logs */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-slate-600 tracking-wider">运行日志</h2>
            <button
              onClick={() => setLogs([])}
              className="p-1.5 rounded-lg hover:bg-slate-100 active:scale-90 transition-transform text-slate-400"
              title="清空日志"
            >
              <Trash weight="bold" className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="font-mono text-[10px] leading-4 max-h-60 overflow-y-auto bg-slate-900 text-slate-100 rounded-2xl p-3 no-scrollbar">
            {logs.length === 0 ? (
              <div className="text-slate-500">暂无日志</div>
            ) : (
              logs.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.kind === 'in' ? 'text-sky-300'
                      : l.kind === 'out' ? 'text-emerald-300'
                      : l.kind === 'error' ? 'text-rose-300'
                      : 'text-slate-300'
                  }
                >
                  <span className="text-slate-500">{formatTs(l.ts)} </span>{l.text}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export default QQBridge;

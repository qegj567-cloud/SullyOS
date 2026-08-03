/**
 * 微信读书搭子小程序 (Weread MiniApp)
 *
 * 功能：
 *  - Tab1「配置」：开/关 + 模式切换（API Key / Cookie / CookieCloud）+ 服务器地址 + 测试连接
 *  - Tab2「书架」：显示最近 30 天在读 / 全量书架 / 搜索
 *  - Tab3「统计」：最近 14 天时长柱状图 + 本周数据卡片
 *  - Tab4「想法」：最近划线 + 想法（笔记）
 *
 * 全程直接调 weread MCP 工具，不走 LLM。
 */

import React, { useEffect, useState } from 'react';
import {
    isWereadEnabled, setWereadEnabled,
    getWereadMode, setWereadMode,
    getWereadApiKey, setWereadApiKey,
    getWereadCookie, setWereadCookie,
    getWereadCookieCloud, setWereadCookieCloud,
    getWereadCustomServer, setWereadCustomServer,
    isWereadConfigured, resetWereadSession, testWereadConnection,
    wereadGetBookshelf, wereadGetRecentReads, wereadGetHighlights, wereadGetReadingStats,
    wereadSearchBooks, getWereadSnapshot,
    type WeReadMode, type CookieCloudConfig,
} from '../../utils/wereadMcpClient';

type Tab = 'config' | 'bookshelf' | 'stats' | 'highlights';

const DEFAULT_COVER = 'linear-gradient(135deg,#374151 0%,#111827 100%)';

export default function WereadMiniApp() {
    const [tab, setTab] = useState<Tab>('config');

    const [enabled, setEnabled] = useState(isWereadEnabled());
    const [mode, setMode] = useState<WeReadMode>(getWereadMode());
    const [apiKey, setApiKey] = useState(getWereadApiKey());
    const [cookie, setCookie] = useState(getWereadCookie());
    const [cc, setCc] = useState<CookieCloudConfig>(getWereadCookieCloud());
    const [server, setServer] = useState(getWereadCustomServer());
    const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
    const [testing, setTesting] = useState(false);

    const [loading, setLoading] = useState<Record<string, boolean>>({});
    const [err, setErr] = useState<Record<string, string>>({});
    const [bookshelf, setBookshelf] = useState<any[]>([]);
    const [highlights, setHighlights] = useState<any[]>([]);
    const [stats, setStats] = useState<{ rows: any[]; total?: number; days?: number }>({ rows: [] });
    const [snap, setSnap] = useState<any>(null);
    const [searchKw, setSearchKw] = useState('');
    const [bookFilter, setBookFilter] = useState('');

    const startLoading = (k: string) => setLoading(l => ({ ...l, [k]: true }));
    const stopLoading = (k: string) => setLoading(l => ({ ...l, [k]: false }));

    const saveCfg = () => {
        setWereadEnabled(enabled);
        setWereadMode(mode);
        setWereadApiKey(apiKey);
        setWereadCookie(cookie);
        setWereadCookieCloud(cc);
        setWereadCustomServer(server);
        resetWereadSession();
    };

    const runTest = async () => {
        saveCfg();
        setTesting(true); setTestMsg(null);
        try {
            const r = await testWereadConnection();
            setTestMsg({ ok: r.ok, text: r.message });
        } finally { setTesting(false); }
    };

    const confValid = isWereadConfigured();

    const loadBookshelf = async () => {
        startLoading('bookshelf');
        try {
            const r = await wereadGetBookshelf();
            const arr = extractBooksArray(r.data);
            setBookshelf(arr);
        } catch (e: any) { setErr(e2 => ({ ...e2, bookshelf: e?.message || String(e) })); }
        finally { stopLoading('bookshelf'); }
    };

    const loadRecent = async () => {
        startLoading('bookshelf');
        try {
            const r = await wereadGetRecentReads({ days: 30 });
            setBookshelf(extractBooksArray(r.data));
        } catch (e: any) { setErr(e2 => ({ ...e2, bookshelf: e?.message || String(e) })); }
        finally { stopLoading('bookshelf'); }
    };

    const search = async () => {
        if (!searchKw.trim()) return loadBookshelf();
        startLoading('bookshelf');
        try {
            const r = await wereadSearchBooks(searchKw.trim());
            setBookshelf(extractBooksArray(r.data));
        } catch (e: any) { setErr(e2 => ({ ...e2, bookshelf: e?.message || String(e) })); }
        finally { stopLoading('bookshelf'); }
    };

    const loadHigh = async () => {
        startLoading('highlights');
        try {
            const params: any = { limit: 50 };
            if (bookFilter.trim()) params.book_title = bookFilter.trim();
            const r = await wereadGetHighlights(params);
            setHighlights(extractHighlightsArray(r.data));
        } catch (e: any) { setErr(e2 => ({ ...e2, highlights: e?.message || String(e) })); }
        finally { stopLoading('highlights'); }
    };

    const loadStats = async () => {
        startLoading('stats');
        try {
            const s = await getWereadSnapshot();
            setSnap(s);
            const r = await wereadGetReadingStats({ days: 30 });
            const rows = extractDailyStatsRows(r.data);
            let total: number | undefined;
            const d = r.data as any;
            if (typeof d?.totalMinutes === 'number') total = d.totalMinutes;
            else if (typeof d?.sum === 'number') total = d.sum;
            else total = rows.reduce((a, b) => a + (b.minutes || 0), 0);
            const days = d?.totalDays ?? d?.activeDays ?? rows.filter(rr => rr.minutes > 0).length;
            setStats({ rows, total, days });
        } catch (e: any) { setErr(e2 => ({ ...e2, stats: e?.message || String(e) })); }
        finally { stopLoading('stats'); }
    };

    useEffect(() => {
        if (confValid) {
            void loadRecent();
            void loadStats();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ====== UI ======
    return (
        <div className="flex flex-col h-full text-white/80 bg-black/20">
            <Header confValid={confValid} />
            <Tabs tab={tab} setTab={(t) => {
                setTab(t);
                if (t === 'bookshelf' && !bookshelf.length && confValid) void loadRecent();
                if (t === 'highlights' && !highlights.length && confValid) void loadHigh();
                if (t === 'stats' && stats.rows.length === 0 && confValid) void loadStats();
            }} />
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {tab === 'config' && (
                    <ConfigPanel
                        enabled={enabled} setEnabled={setEnabled}
                        mode={mode} setMode={(m) => { saveCfg(); setMode(m); }}
                        apiKey={apiKey} setApiKey={setApiKey}
                        cookie={cookie} setCookie={setCookie}
                        cc={cc} setCc={setCc}
                        server={server} setServer={setServer}
                        saveCfg={saveCfg} runTest={runTest} testing={testing} testMsg={testMsg}
                    />
                )}
                {tab === 'bookshelf' && (
                    <BookshelfPanel
                        confValid={confValid} loading={loading.bookshelf} err={err.bookshelf}
                        books={bookshelf} searchKw={searchKw} setSearchKw={setSearchKw}
                        onSearch={search} onRecent={loadRecent} onAll={loadBookshelf}
                    />
                )}
                {tab === 'stats' && (
                    <StatsPanel confValid={confValid} loading={loading.stats} err={err.stats}
                                snap={snap} stats={stats} onReload={loadStats} />
                )}
                {tab === 'highlights' && (
                    <HighlightsPanel confValid={confValid} loading={loading.highlights} err={err.highlights}
                                     items={highlights} filter={bookFilter} setFilter={setBookFilter} onReload={loadHigh} />
                )}
            </div>
        </div>
    );
}

// ========== 子组件 ==========

function Header({ confValid }: { confValid: boolean }) {
    return (
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.04]">
            <div className="flex items-center gap-2">
                <span className="text-xl">📚</span>
                <span className="font-bold">微信读书搭子</span>
            </div>
            {confValid
                ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">已连接</span>
                : <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30">未配置</span>}
        </div>
    );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
    const tabs: { id: Tab; label: string }[] = [
        { id: 'config', label: '配置' },
        { id: 'bookshelf', label: '书架' },
        { id: 'stats', label: '统计' },
        { id: 'highlights', label: '想法' },
    ];
    return (
        <div className="flex gap-1 px-2 pt-2">
            {tabs.map(t => (
                <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`flex-1 text-[11px] px-2 py-1.5 rounded transition ${
                        tab === t.id
                            ? 'bg-white/12 text-white border border-white/10 font-medium'
                            : 'text-white/60 hover:text-white/80 hover:bg-white/[0.04] border border-transparent'
                    }`}
                >{t.label}</button>
            ))}
        </div>
    );
}

function Toggle({ v, onChange }: { v: boolean; onChange: (v: boolean) => void }) {
    return (
        <button
            onClick={() => onChange(!v)}
            className={`relative w-10 h-5 rounded-full transition ${v ? 'bg-emerald-500/40' : 'bg-white/10'} border border-white/10`}
        >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${v ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
    );
}

function EmptyHint({ text }: { text: string }) {
    return <div className="text-center text-xs text-white/45 py-10">{text}</div>;
}

function Box({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="rounded-lg bg-gradient-to-br from-emerald-500/15 to-sky-500/10 border border-white/10 p-3">
            <div className="text-[10px] text-white/50">{label}</div>
            <div className="text-lg font-semibold text-white/95 mt-0.5">{value}</div>
        </div>
    );
}

// ========== 数据抽取 ==========

function extractBooksArray(d: any): any[] {
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return [];
    for (const k of ['books', 'items', 'records', 'data', 'shelf', 'list']) {
        if (Array.isArray(d[k])) return d[k];
    }
    return [];
}

function extractHighlightsArray(d: any): any[] {
    if (Array.isArray(d)) return d;
    if (!d || typeof d !== 'object') return [];
    for (const k of ['highlights', 'items', 'notes', 'annotations', 'thoughts', 'records', 'data']) {
        if (Array.isArray(d[k])) return d[k];
    }
    return [];
}

function extractDailyStatsRows(d: any): any[] {
    if (Array.isArray(d)) return d.map(normalizeDailyRow);
    if (!d || typeof d !== 'object') return [];
    for (const k of ['days', 'daily', 'items', 'records', 'rows', 'data']) {
        if (Array.isArray(d[k])) return d[k].map(normalizeDailyRow);
    }
    return [];
}
function normalizeDailyRow(r: any): { date: string; minutes: number; bookCount?: number } {
    const d = r?.date || r?.day || r?.dayStr || '';
    let m = 0;
    if (typeof r?.minutes === 'number') m = r.minutes;
    else if (typeof r?.readingMinutes === 'number') m = r.readingMinutes;
    else if (typeof r?.duration === 'number') m = r.duration > 180 ? r.duration / 60 : r.duration;
    else if (typeof r?.seconds === 'number') m = r.seconds / 60;
    else if (typeof r?.time === 'number') m = r.time / 60000;
    const bookCount = r?.bookCount ?? r?.count ?? r?.booksRead;
    return { date: String(d), minutes: typeof m === 'number' ? m : parseFloat(m) || 0, bookCount };
}

// ========== Config 面板 ==========

interface ConfigPanelProps {
    enabled: boolean; setEnabled: (v: boolean) => void;
    mode: WeReadMode; setMode: (m: WeReadMode) => void;
    apiKey: string; setApiKey: (v: string) => void;
    cookie: string; setCookie: (v: string) => void;
    cc: CookieCloudConfig; setCc: (v: CookieCloudConfig) => void;
    server: string; setServer: (v: string) => void;
    saveCfg: () => void; runTest: () => void; testing: boolean;
    testMsg: { ok: boolean; text: string } | null;
}

function ConfigPanel(p: ConfigPanelProps) {
    return (
        <div className="p-3 space-y-4 text-sm">
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <label className="text-xs text-white/60">启用微信读书搭子</label>
                    <Toggle v={p.enabled} onChange={p.setEnabled} />
                </div>
                <p className="text-[11px] text-white/45 leading-relaxed">
                    开启后，角色在聊天里能被动看到：你最近在读什么书、本周阅读时长、最近划线摘要；发送「读书搭子」可进入主动工具模式，角色直接调用 weread 工具（翻书架、查某本书笔记、做统计）。
                </p>

                <div>
                    <div className="text-xs text-white/60 mb-1.5">鉴权模式</div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => p.setMode('apikey')}
                            className={`flex-1 rounded-md py-2 text-xs transition ${
                                p.mode === 'apikey'
                                    ? 'bg-gradient-to-r from-emerald-500/25 to-sky-500/25 border border-emerald-500/40 text-white'
                                    : 'border border-white/10 text-white/60 hover:bg-white/5'
                            }`}
                        >
                            官方 API Key
                            <div className="text-[9px] opacity-70 mt-0.5 leading-tight">快速上手 · 官方渠道</div>
                        </button>
                        <button
                            onClick={() => p.setMode('cookie')}
                            className={`flex-1 rounded-md py-2 text-xs transition ${
                                p.mode === 'cookie'
                                    ? 'bg-gradient-to-r from-emerald-500/25 to-sky-500/25 border border-emerald-500/40 text-white'
                                    : 'border border-white/10 text-white/60 hover:bg-white/5'
                            }`}
                        >
                            Cookie / CookieCloud
                            <div className="text-[9px] opacity-70 mt-0.5 leading-tight">更全的笔记 & 章节化划线</div>
                        </button>
                    </div>
                </div>

                {p.mode === 'apikey' && (
                    <div className="space-y-1">
                        <div className="text-xs text-white/60">WeRead MCP API Key</div>
                        <input
                            className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2 text-xs text-white/90 placeholder-white/30 outline-none focus:border-emerald-500/30"
                            type="password"
                            value={p.apiKey}
                            onChange={e => p.setApiKey(e.target.value)}
                            placeholder="weread_xxxxx (从 weread MCP 官方获取)"
                        />
                        <p className="text-[10px] text-white/40">官方服务地址或自托管实例 Key。</p>
                    </div>
                )}

                {p.mode === 'cookie' && (
                    <div className="space-y-3">
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-xs text-white/60">weread.qq.com Cookie</span>
                                <button
                                    className="text-[10px] text-white/40 hover:text-white/60"
                                    onClick={() => {
                                        const input = prompt('粘贴浏览器 weread 的完整 Cookie 字符串 (从浏览器 F12 → Application → Cookies → weread.qq.com 复制)');
                                        if (input != null) p.setCookie(input.trim());
                                    }}
                                >📋 弹窗粘贴</button>
                            </div>
                            <textarea
                                className="w-full h-24 bg-white/[0.04] border border-white/10 rounded-lg p-2 text-[11px] text-white/85 placeholder-white/30 outline-none focus:border-emerald-500/30 font-mono resize-y"
                                value={p.cookie}
                                onChange={e => p.setCookie(e.target.value)}
                                placeholder="wr_vid=xxx; wr_loginticket=yyy; (整串 Cookie)"
                            />
                            <p className="text-[10px] text-white/40 mt-0.5">
                                浏览器 F12 → Application → Cookies → https://weread.qq.com → 全选复制。
                            </p>
                        </div>

                        <div className="rounded-lg border border-dashed border-white/10 p-3 space-y-2">
                            <div className="text-xs text-white/70 font-medium">CookieCloud 同步（可选）</div>
                            <div className="space-y-1.5">
                                <div>
                                    <div className="text-[10px] text-white/50 mb-0.5">服务地址</div>
                                    <input className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-[11px] outline-none"
                                           placeholder="https://你的-cookiecloud.example.com"
                                           value={p.cc.url || ''}
                                           onChange={e => p.setCc({ ...p.cc, url: e.target.value })} />
                                </div>
                                <div>
                                    <div className="text-[10px] text-white/50 mb-0.5">用户 UUID</div>
                                    <input className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-[11px] outline-none"
                                           placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                                           value={p.cc.id || ''}
                                           onChange={e => p.setCc({ ...p.cc, id: e.target.value })} />
                                </div>
                                <div>
                                    <div className="text-[10px] text-white/50 mb-0.5">加密密码</div>
                                    <input type="password" className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-[11px] outline-none"
                                           placeholder="CookieCloud 密码"
                                           value={p.cc.password || ''}
                                           onChange={e => p.setCc({ ...p.cc, password: e.target.value })} />
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                <div>
                    <div className="text-xs text-white/60 mb-1">MCP 服务器地址（留空=默认）</div>
                    <input
                        className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2 text-xs text-white/85 placeholder-white/30 outline-none"
                        value={p.server}
                        onChange={e => p.setServer(e.target.value)}
                        placeholder="https://weread.mcp.xxai-ai.top/wechat-reading"
                    />
                    <p className="text-[10px] text-white/40 mt-0.5">默认空 = 官方实例，可填自托管地址。</p>
                </div>

                <div className="flex gap-2">
                    <button className="flex-1 rounded-lg px-4 py-2 text-xs bg-white/5 border border-white/10 hover:bg-white/10 transition"
                            onClick={p.saveCfg}>💾 保存配置</button>
                    <button
                        className={`flex-1 rounded-lg px-4 py-2 text-xs font-medium transition ${
                            p.testing ? 'bg-white/5 border border-white/10 opacity-60'
                            : 'bg-gradient-to-r from-emerald-500/30 to-sky-500/30 border border-emerald-500/40 hover:from-emerald-500/40 hover:to-sky-500/40 text-white'
                        }`}
                        onClick={p.runTest}
                        disabled={p.testing}
                    >{p.testing ? '正在测试...' : '🔌 测试连接'}</button>
                </div>

                {p.testMsg && (
                    <div className={`rounded-lg border p-3 text-[11px] ${
                        p.testMsg.ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                        : 'border-rose-500/40 bg-rose-500/10 text-rose-100'
                    }`}>
                        <div className="font-medium mb-0.5">{p.testMsg.ok ? '✅ 连接成功' : '❌ 连接失败'}</div>
                        <pre className="whitespace-pre-wrap break-all opacity-90 font-sans">{p.testMsg.text}</pre>
                    </div>
                )}

                <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 text-[10px] text-white/50 space-y-1">
                    <div className="text-white/70 text-xs font-semibold mb-1">💡 使用说明</div>
                    <div>• 开启 + 配置 OK → 角色每轮被动快照：最近在读、本周时长、最近划线</div>
                    <div>• 聊天中发送「<b>读书搭子</b>」→ 激活主动工具模式，角色可直接调用 weread 工具</div>
                    <div>• 想关工具 → 「结束读书搭子」；仅关被动快照 → 关 wereadEnabled</div>
                    <div>• Cookie 模式才有完整功能（书评、章节结构笔记），API Key 模式视服务商支持</div>
                </div>
            </div>
        </div>
    );
}

// ========== Bookshelf 面板 ==========

function BookshelfPanel(props: {
    confValid: boolean; loading?: boolean; err?: string;
    books: any[]; searchKw: string; setSearchKw: (v: string) => void;
    onSearch: () => void; onRecent: () => void; onAll: () => void;
}) {
    const { confValid, loading, err, books, searchKw, setSearchKw, onSearch, onRecent, onAll } = props;
    return (
        <div className="p-3 space-y-3">
            <div className="flex gap-2">
                <input className="flex-1 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs outline-none"
                       placeholder="按书名 / 作者搜书架..."
                       value={searchKw} onChange={e => setSearchKw(e.target.value)}
                       onKeyDown={e => e.key === 'Enter' && onSearch()} />
                <button className="px-3 text-xs rounded-lg bg-white/5 border border-white/10 hover:bg-white/10" onClick={onSearch}>🔍</button>
            </div>
            <div className="flex gap-2">
                <button className="flex-1 text-[11px] py-1.5 rounded bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-60"
                        onClick={onRecent} disabled={loading}>最近 30 天在读 {loading ? '...' : ''}</button>
                <button className="flex-1 text-[11px] py-1.5 rounded bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-60"
                        onClick={onAll} disabled={loading}>全量书架 {loading ? '...' : ''}</button>
            </div>
            {err && <div className="text-[11px] text-rose-300">{err}</div>}
            {!confValid && <EmptyHint text="先去「配置」填好鉴权再来哦。" />}
            {confValid && books.length === 0 && !loading && <EmptyHint text="书架是空的，或者还没同步到。" />}
            {books.map((m, i) => {
                const title = m?.title || m?.bookName || '未命名';
                const author = m?.author;
                const prog = typeof m?.progress === 'number' ? m.progress : undefined;
                const progPct = prog == null ? null : (prog > 1 ? prog : prog * 100);
                const status = m?.readingStatus ?? m?.status;
                const coverImg = m?.cover || m?.coverImg || m?.coverUrl;
                return (
                    <div key={`${m.bookId || m.id || title}-${i}`} className="flex gap-3 p-3 rounded-lg bg-white/[0.04] border border-white/5">
                        <div
                            className="w-14 h-20 shrink-0 rounded overflow-hidden border border-white/10 items-center justify-center text-xs text-white/40 font-serif flex items-center justify-center"
                            style={{ backgroundImage: coverImg ? 'none' : DEFAULT_COVER }}
                        >
                            {coverImg ? <img src={coverImg} alt="" className="w-full h-full object-cover" loading="lazy" /> : <span className="text-[9px] opacity-70 px-2 text-center">{title.slice(0, 8)}</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="text-sm font-semibold text-white/95 truncate">{title}</div>
                                    {author && <div className="text-[11px] text-white/50 truncate">{author}</div>}
                                </div>
                                {status === 1
                                    ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0">在读</span>
                                    : status === 2
                                    ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 shrink-0">已读</span>
                                    : null}
                            </div>
                            {progPct != null && (
                                <div className="mt-2 flex items-center gap-2 text-[10px] text-white/60">
                                    <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                                        <div className="h-full bg-gradient-to-r from-emerald-400 to-sky-400"
                                             style={{ width: `${Math.max(0, Math.min(100, progPct))}%` }} />
                                    </div>
                                    <span className="w-10 text-right tabular-nums">{progPct.toFixed(0)}%</span>
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ========== Stats 面板 ==========

function StatsPanel(props: { confValid: boolean; loading?: boolean; err?: string; snap: any; stats: { rows: any[]; total?: number; days?: number }; onReload: () => void }) {
    const { confValid, loading, err, snap, stats, onReload } = props;
    const weekMin = snap && typeof snap.weeklyMinutes === 'number' ? snap.weeklyMinutes : null;
    const readingNow = snap?.readingNow?.length ?? null;
    const hl = snap?.recentHighlights?.length ?? null;
    const weekDisp = weekMin == null ? '—' : weekMin >= 60 ? `${Math.floor(weekMin / 60)}h${weekMin % 60 ? ` ${weekMin % 60}m` : ''}` : `${weekMin.toFixed(0)} 分钟`;
    return (
        <div className="p-3 space-y-3">
            <div className="flex gap-2">
                <button className="flex-1 text-[11px] py-1.5 rounded bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-60"
                        onClick={onReload} disabled={loading}>🔄 刷新近 30 天统计 {loading ? '...' : ''}</button>
            </div>
            {!confValid && <EmptyHint text="先完成配置再来。" />}
            <div className="grid grid-cols-3 gap-2">
                <Box label="本周在读" value={readingNow ?? '—'} />
                <Box label="本周时长" value={weekDisp} />
                <Box label="本周划线" value={hl ?? '—'} />
            </div>
            {(stats.total != null || stats.days != null) && (
                <div className="grid grid-cols-2 gap-2">
                    <Box label="近 30 天总时长"
                         value={stats.total == null ? '—' : stats.total >= 60 ? `${Math.floor(stats.total / 60)}h${stats.total % 60 ? ` ${stats.total % 60}m` : ''}` : `${stats.total.toFixed(0)} 分钟`} />
                    <Box label="活跃天数" value={stats.days ?? '—'} />
                </div>
            )}
            {err && <div className="text-[11px] text-rose-300">{err}</div>}
            {stats.rows.length > 0 && <Bar rows={stats.rows} />}
        </div>
    );
}

function Bar({ rows }: { rows: any[] }) {
    const nums = rows.map(normalizeDailyRow);
    const last14 = nums.slice(-14);
    const max = Math.max(1, ...last14.map(n => n.minutes));
    const sum = last14.reduce((a, b) => a + b.minutes, 0);
    return (
        <div className="rounded-lg border border-white/5 bg-white/[0.03] p-3 space-y-3">
            <div className="text-[11px] text-white/55">
                近 14 天 · 累计 <span className="text-white/80 font-medium">{sum.toFixed(0)} 分钟</span>
            </div>
            <div className="flex items-end gap-1.5 h-28">
                {last14.map((n, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                        <div className="w-full h-full flex items-end">
                            <div
                                title={`${n.date || '-'} ${n.minutes.toFixed(0)} 分钟`}
                                className={`w-full rounded-t ${n.minutes > 0 ? 'bg-gradient-to-t from-emerald-400/70 to-sky-400/70' : 'bg-white/5'}`}
                                style={{ height: `${Math.max(4, (n.minutes / max) * 100)}%` }}
                            />
                        </div>
                        <div className="text-[9px] text-white/40 truncate w-full text-center">
                            {n.date ? String(n.date).slice(-2).replace(/^-/, '') : String(i + 1)}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ========== Highlights 面板 ==========

function HighlightsPanel(props: {
    confValid: boolean; loading?: boolean; err?: string;
    items: any[]; filter: string; setFilter: (v: string) => void; onReload: () => void;
}) {
    const { confValid, loading, err, items, filter, setFilter, onReload } = props;
    return (
        <div className="p-3 space-y-3">
            <div className="flex gap-2">
                <input className="flex-1 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-1.5 text-xs outline-none"
                       placeholder="按书名过滤（留空=全部）"
                       value={filter} onChange={e => setFilter(e.target.value)}
                       onKeyDown={e => e.key === 'Enter' && onReload()} />
                <button className="px-3 text-xs rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 disabled:opacity-60"
                        onClick={onReload} disabled={loading}>查询 {loading ? '...' : ''}</button>
            </div>
            {!confValid && <EmptyHint text="先完成配置再来。" />}
            {err && <div className="text-[11px] text-rose-300">{err}</div>}
            {confValid && items.length === 0 && !loading && <EmptyHint text="暂无划线。" />}
            {items.map((h, i) => {
                const title = h?.bookTitle || h?.book_name || h?.title || '';
                const text = h?.text || h?.highlightText || h?.content || '';
                const note = h?.note || h?.comment || h?.thought || '';
                const ch = h?.chapter || h?.chapterTitle || h?.chapterName || '';
                return (
                    <div key={i} className="rounded-lg border border-white/5 bg-white/[0.03] p-3">
                        <div className="text-[11px] text-white/55 mb-2">
                            <span className="font-medium">{title}</span>
                            {ch ? <span className="opacity-60"> · {ch}</span> : null}
                        </div>
                        {text && <div className="text-sm text-white/90 leading-relaxed border-l-2 border-emerald-400/40 pl-3 whitespace-pre-wrap break-words">{text}</div>}
                        {note && <div className="mt-2 ml-3 rounded-md bg-amber-400/10 border border-amber-400/20 px-3 py-2 text-xs text-amber-100">💭 想法：{note}</div>}
                    </div>
                );
            })}
        </div>
    );
}

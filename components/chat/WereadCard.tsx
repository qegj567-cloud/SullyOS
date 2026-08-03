/**
 * 微信读书卡片 —— 对应 Message.type === 'weread_card'。
 *
 * 渲染内容按 metadata.wereadCardKind (wereadToolBridge.inferCardKind) 分流:
 *  - bookshelf   : 书架 / 最近在读 (书列表)
 *  - book-detail : 单本书详情 (进度等)
 *  - highlights  : 划线/笔记/想法 (按章节或时间线)
 *  - stats       : 阅读时长统计 (柱状图/列表/本周概览)
 *  - reviews     : 热门书评
 *  - search      : 书架搜索结果
 *  - generic     : 兜底 (直接 JSON 展示)
 *
 * 和 McdCard / LuckinCard 同构：只读 metadata，不发网络请求；工具调用和落库
 * 都在 useChatAI.ts 的 weread 工具循环里完成。
 */

import React, { useMemo } from 'react';

type WereadBook = {
    bookId?: string; bookIdStr?: string;
    title?: string; author?: string;
    progress?: number;
    readingStatus?: number;   // 1=在读, 2=已读, 4=未读
    lastReadTime?: number;
    readingTime?: number;
    cover?: string;
    coverImg?: string;
    rating?: number;
    category?: string;
};

type Highlight = {
    bookId?: string; title?: string; bookTitle?: string;
    chapter?: string; chapterTitle?: string;
    text?: string; highlightText?: string;
    note?: string; comment?: string;
    createTime?: number;
};

type StatRow = {
    date?: string; day?: string;
    minutes?: number; seconds?: number; duration?: number;
    readingMinutes?: number;
    bookCount?: number;
};

type Review = {
    title?: string; bookTitle?: string;
    author?: string; reviewer?: string;
    content?: string; text?: string; reviewContent?: string;
    rating?: number; likeCount?: number; helpfulCount?: number;
    createTime?: number;
};

const STATUS_LABEL: Record<number, string> = {
    1: '在读', 2: '已读', 3: '想读', 4: '未读',
};

const STATUS_TAG_CLASS: Record<number, string> = {
    1: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
    2: 'bg-sky-500/15 text-sky-300 border border-sky-500/30',
    3: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
    4: 'bg-slate-500/15 text-slate-300 border border-slate-500/30',
};

const fmtMin = (v: any, unit = '分钟'): string => {
    if (v == null) return '';
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (!isFinite(n)) return '';
    if (n >= 60) {
        const h = Math.floor(n / 60);
        const m = Math.round(n % 60);
        return `${h}小时${m ? ` ${m}${unit}` : ''}`;
    }
    return `${Math.round(n)}${unit}`;
};

const fmtProgress = (p: any): string | null => {
    if (typeof p !== 'number' || isNaN(p)) return null;
    const pct = p > 1 ? p : p * 100;
    return `${pct.toFixed(0)}%`;
};

const fmtAgo = (t?: number): string => {
    if (!t) return '';
    const ms = t > 1e12 ? t : t * 1000;   // 兼容秒/毫秒
    const diff = Date.now() - ms;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const pickStr = (obj: any, keys: string[]): string | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
    }
    return undefined;
};

const pickNum = (obj: any, keys: string[]): number | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'number' && isFinite(v)) return v;
        if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
    }
    return undefined;
};

const coerceBook = (m: any): WereadBook => ({
    bookId: pickStr(m, ['bookId', 'book_id', 'bookIdStr', 'id', 'bid']),
    title: pickStr(m, ['title', 'bookName', 'name', 'bookTitle']),
    author: pickStr(m, ['author']),
    progress: pickNum(m, ['progress', 'readingProgress', 'percent']),
    readingStatus: pickNum(m, ['readingStatus', 'status', 'state']) ?? undefined,
    lastReadTime: pickNum(m, ['lastReadTime', 'readTime', 'updateTime', 'lastReadTimestamp']),
    readingTime: pickNum(m, ['readingTime', 'totalReadingTime', 'readSeconds', 'duration']),
    cover: pickStr(m, ['cover', 'coverImg', 'coverUrl', 'imgUrl', 'image']),
});

const coerceBooks = (data: any): WereadBook[] => {
    if (!data) return [];
    const list: any[] = [];
    if (Array.isArray(data)) list.push(...data);
    if (Array.isArray(data?.books)) list.push(...data.books);
    if (Array.isArray(data?.items)) list.push(...data.items);
    if (Array.isArray(data?.data)) {
        for (const d of data.data) (Array.isArray(d) ? d : [d]).forEach(x => list.push(x));
    }
    if (!list.length && data && typeof data === 'object' && (data.bookId || data.title || data.bookName)) {
        list.push(data);
    }
    return list.map(coerceBook).filter(b => b.title || b.bookId);
};

const coerceHighlight = (m: any): Highlight => ({
    bookId: pickStr(m, ['bookId', 'book_id', 'bid']),
    title: pickStr(m, ['bookTitle', 'book_name', 'title', 'bookName']),
    chapter: pickStr(m, ['chapter', 'chapterTitle', 'section', 'chapterName']),
    text: pickStr(m, ['text', 'highlightText', 'markText', 'content']),
    note: pickStr(m, ['note', 'comment', 'thought', 'review', 'markNote']),
    createTime: pickNum(m, ['createTime', 'createdAt', 'time', 'timestamp']),
});

const coerceHighlights = (data: any): Highlight[] => {
    if (!data) return [];
    const list: any[] = [];
    if (Array.isArray(data)) list.push(...data);
    if (Array.isArray(data?.highlights)) list.push(...data.highlights);
    if (Array.isArray(data?.items)) list.push(...data.items);
    if (Array.isArray(data?.notes)) list.push(...data.notes);
    if (Array.isArray(data?.data)) {
        for (const d of data.data) (Array.isArray(d) ? d : [d]).forEach(x => list.push(x));
    }
    return list.map(coerceHighlight).filter(h => h.text || h.note);
};

const coerceStatRows = (data: any): { rows: StatRow[]; totalMinutes?: number; totalDays?: number } => {
    const rows: StatRow[] = [];
    if (!data) return { rows };
    const list: any[] = [];
    if (Array.isArray(data)) list.push(...data);
    if (Array.isArray(data?.days)) list.push(...data.days);
    if (Array.isArray(data?.items)) list.push(...data.items);
    if (Array.isArray(data?.daily)) list.push(...data.daily);
    if (Array.isArray(data?.data)) {
        for (const d of data.data) (Array.isArray(d) ? d : [d]).forEach(x => list.push(x));
    }
    for (const m of list) {
        const dur = pickNum(m, ['minutes', 'readingMinutes', 'duration', 'readSeconds', 'seconds', 'timeLength']);
        rows.push({
            date: pickStr(m, ['date', 'day', 'dayStr', 'ymd']) || undefined,
            minutes: typeof dur === 'number' && dur > 180 ? Math.round(dur / 60) : (typeof dur === 'number' ? dur : undefined),
            bookCount: pickNum(m, ['bookCount', 'count', 'books']) ?? undefined,
        });
    }
    const totalMinutes = pickNum(data, ['totalMinutes', 'total', 'sum', 'totalTimeMinutes', 'readingMinutes'])
        ?? (rows.reduce<number>((acc, r) => acc + (typeof r.minutes === 'number' ? r.minutes : 0), 0) || undefined);
    const totalDays = pickNum(data, ['totalDays', 'days', 'validDays', 'activeDays']) ?? (rows.filter(r => typeof r.minutes === 'number' && r.minutes > 0).length || undefined);
    return { rows, totalMinutes, totalDays };
};

const coerceReviews = (data: any): Review[] => {
    if (!data) return [];
    const list: any[] = [];
    if (Array.isArray(data)) list.push(...data);
    if (Array.isArray(data?.reviews)) list.push(...data.reviews);
    if (Array.isArray(data?.items)) list.push(...data.items);
    if (Array.isArray(data?.bestReviews)) list.push(...data.bestReviews);
    if (Array.isArray(data?.data)) {
        for (const d of data.data) (Array.isArray(d) ? d : [d]).forEach(x => list.push(x));
    }
    return list.map((m: any): Review => ({
        title: pickStr(m, ['bookTitle', 'book_name', 'title']),
        author: pickStr(m, ['author']),
        reviewer: pickStr(m, ['reviewer', 'nickname', 'userName', 'user', 'name']),
        content: pickStr(m, ['content', 'reviewContent', 'text', 'body']),
        rating: pickNum(m, ['rating', 'score', 'star']) ?? undefined,
        likeCount: pickNum(m, ['likeCount', 'helpfulCount', 'likes', 'vote']) ?? undefined,
        createTime: pickNum(m, ['createTime', 'createdAt', 'time']),
    })).filter(r => r.content);
};

// ========== 卡片子视图 ==========

const ErrBar: React.FC<{ toolName: string; err?: string }> = ({ toolName, err }) => (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
        <div className="font-semibold mb-1">📚 微信读书 · {toolName} 调用失败</div>
        <pre className="whitespace-pre-wrap break-all opacity-90">{err || '未知错误'}</pre>
    </div>
);

const ToolHeader: React.FC<{ toolName: string; resultCount?: number; kind: string }> = ({ toolName, resultCount, kind }) => {
    const kindLabels: Record<string, string> = {
        bookshelf: '书架', 'book-detail': '图书详情', highlights: '划线 & 想法',
        stats: '阅读时长统计', reviews: '热门书评', search: '书架搜索', generic: '工具结果',
    };
    return (
        <div className="flex items-center justify-between mb-2 text-xs">
            <div className="flex items-center gap-2">
                <span className="text-xl">📚</span>
                <span className="text-white/90 font-semibold">微信读书 · {kindLabels[kind] || '工具结果'}</span>
            </div>
            <div className="text-white/50">
                <span className="font-mono">{toolName}</span>
                {typeof resultCount === 'number' ? <span className="ml-2">共 {resultCount} 条</span> : null}
            </div>
        </div>
    );
};

const BookRow: React.FC<{ book: WereadBook }> = ({ book }) => {
    const pct = fmtProgress(book.progress);
    const pctNum = typeof book.progress === 'number' ? (book.progress > 1 ? book.progress : book.progress * 100) : 0;
    const statusCls = book.readingStatus ? STATUS_TAG_CLASS[book.readingStatus] : STATUS_TAG_CLASS[4];
    return (
        <div className="flex gap-3 p-3 rounded-lg bg-white/[0.04] border border-white/5 hover:bg-white/[0.07] transition">
            {book.cover && (
                <img
                    src={book.cover}
                    alt={book.title || 'cover'}
                    loading="lazy"
                    className="w-12 h-16 object-cover rounded border border-white/10 shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                />
            )}
            <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-white/95 truncate">
                            {book.title || '（未命名）'}
                        </div>
                        {book.author && (
                            <div className="text-xs text-white/55 truncate mt-0.5">{book.author}</div>
                        )}
                    </div>
                    {book.readingStatus !== undefined && (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${statusCls}`}>
                            {STATUS_LABEL[book.readingStatus] || '未知'}
                        </span>
                    )}
                </div>
                <div className="mt-2 space-y-1">
                    {pct && (
                        <div className="flex items-center gap-2 text-[11px] text-white/70">
                            <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-sky-400"
                                    style={{ width: `${Math.max(0, Math.min(100, pctNum))}%` }}
                                />
                            </div>
                            <span className="w-10 text-right tabular-nums">{pct}</span>
                        </div>
                    )}
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/50">
                        {book.lastReadTime ? <span>最近阅读 · {fmtAgo(book.lastReadTime)}</span> : null}
                        {book.readingTime ? <span>累计 · {fmtMin(book.readingTime > 180 ? book.readingTime / 60 : book.readingTime)}</span> : null}
                    </div>
                </div>
            </div>
        </div>
    );
};

const BookShelfView: React.FC<{ books: WereadBook[] }> = ({ books }) => {
    const [tab, setTab] = React.useState<'all' | 'reading' | 'read'>('all');
    const filtered = useMemo(() => {
        if (tab === 'reading') return books.filter(b => b.readingStatus === 1);
        if (tab === 'read') return books.filter(b => b.readingStatus === 2);
        return books;
    }, [books, tab]);
    const Tabs = () => (
        <div className="flex gap-1 mb-2">
            {(['all', 'reading', 'read'] as const).map(t => (
                <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`text-[11px] px-2.5 py-1 rounded transition ${tab === t
                        ? 'bg-white/15 text-white border border-white/15'
                        : 'text-white/60 hover:text-white/90 border border-transparent'
                        }`}
                >
                    {t === 'all' ? `全部 (${books.length})` : t === 'reading' ? `在读 (${books.filter(b => b.readingStatus === 1).length})` : `已读 (${books.filter(b => b.readingStatus === 2).length})`}
                </button>
            ))}
        </div>
    );
    return (
        <div>
            {books.length > 2 && <Tabs />}
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1 custom-scrollbar">
                {filtered.length === 0 ? (
                    <div className="text-xs text-white/50 py-6 text-center">
                        {tab === 'all' ? '书架里还没有书' : `「${tab === 'reading' ? '在读' : '已读'}」分类为空`}
                    </div>
                ) : filtered.map((b, i) => <BookRow key={`${b.bookId || b.title}-${i}`} book={b} />)}
            </div>
        </div>
    );
};

const HighlightsView: React.FC<{ items: Highlight[] }> = ({ items }) => {
    const byBook = useMemo(() => {
        const m = new Map<string, Highlight[]>();
        for (const h of items) {
            const key = h.title || h.bookId || '未分组';
            if (!m.has(key)) m.set(key, []);
            m.get(key)!.push(h);
        }
        return Array.from(m.entries());
    }, [items]);
    return (
        <div className="space-y-4 max-h-[420px] overflow-y-auto pr-1 custom-scrollbar">
            {byBook.length === 0 ? (
                <div className="text-xs text-white/50 py-6 text-center">暂无划线或想法</div>
            ) : byBook.map(([k, list]) => (
                <div key={k} className="rounded-lg border border-white/5 bg-white/[0.03]">
                    <div className="px-3 py-2 text-xs text-white/70 border-b border-white/5 font-medium">
                        📖 {k}
                    </div>
                    <ol className="divide-y divide-white/5">
                        {list.map((h, i) => (
                            <li key={i} className="p-3 space-y-1.5">
                                {h.chapter && (
                                    <div className="text-[10px] uppercase tracking-wide text-white/40">{h.chapter}</div>
                                )}
                                {h.text && (
                                    <div className="text-sm text-white/90 leading-relaxed border-l-2 border-emerald-400/40 pl-3 whitespace-pre-wrap break-words">
                                        {h.text}
                                    </div>
                                )}
                                {h.note && (
                                    <div className="ml-3 mt-2 rounded-md bg-amber-400/10 border border-amber-400/20 px-3 py-2 text-xs text-amber-100">
                                        <span className="mr-1">💭</span>想法：{h.note}
                                    </div>
                                )}
                                {h.createTime && (
                                    <div className="text-[10px] text-white/40 text-right">{fmtAgo(h.createTime)}</div>
                                )}
                            </li>
                        ))}
                    </ol>
                </div>
            ))}
        </div>
    );
};

const StatsView: React.FC<{ rows: StatRow[]; totalMinutes?: number; totalDays?: number }> = ({ rows, totalMinutes, totalDays }) => {
    const maxMin = rows.reduce((m, r) => Math.max(m, typeof r.minutes === 'number' ? r.minutes : 0), 0) || 1;
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-gradient-to-br from-emerald-500/15 to-emerald-500/5 border border-emerald-500/20 p-3">
                    <div className="text-[10px] text-white/50">累计阅读</div>
                    <div className="text-lg font-semibold text-emerald-200 mt-0.5">
                        {totalMinutes != null ? fmtMin(totalMinutes) : '—'}
                    </div>
                </div>
                <div className="rounded-lg bg-gradient-to-br from-sky-500/15 to-sky-500/5 border border-sky-500/20 p-3">
                    <div className="text-[10px] text-white/50">活跃天数</div>
                    <div className="text-lg font-semibold text-sky-200 mt-0.5">
                        {totalDays != null ? `${totalDays} 天` : '—'}
                    </div>
                </div>
                <div className="rounded-lg bg-gradient-to-br from-violet-500/15 to-violet-500/5 border border-violet-500/20 p-3">
                    <div className="text-[10px] text-white/50">日均</div>
                    <div className="text-lg font-semibold text-violet-200 mt-0.5">
                        {totalMinutes != null && totalDays ? fmtMin(totalMinutes / totalDays) : '—'}
                    </div>
                </div>
            </div>
            {rows.length > 0 && (
                <div className="rounded-lg border border-white/5 bg-white/[0.03] p-3">
                    <div className="text-[11px] text-white/55 mb-2">每日阅读时长（分钟）</div>
                    <div className="flex items-end gap-1.5 h-28">
                        {rows.slice(-14).map((r, i) => {
                            const h = typeof r.minutes === 'number' ? Math.max(4, (r.minutes / maxMin) * 100) : 2;
                            const label = r.date ? r.date.slice(-2).replace(/^-/, '') : String(i + 1);
                            const isZero = !(typeof r.minutes === 'number' && r.minutes > 0);
                            return (
                                <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                                    <div className="w-full flex justify-center h-full items-end">
                                        <div
                                            title={`${r.date || ''} ${typeof r.minutes === 'number' ? Math.round(r.minutes) + ' 分' : ''}`}
                                            className={`w-full rounded-t transition ${isZero
                                                ? 'bg-white/5'
                                                : 'bg-gradient-to-t from-emerald-400/70 to-sky-400/70'
                                                }`}
                                            style={{ height: `${h}%` }}
                                        />
                                    </div>
                                    <div className="text-[9px] text-white/40 truncate w-full text-center">{label}</div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
            {rows.length > 0 && (
                <div className="max-h-40 overflow-y-auto pr-1 space-y-1 text-[11px] custom-scrollbar">
                    {[...rows].reverse().slice(0, 20).map((r, i) => (
                        <div key={i} className="flex items-center justify-between px-2 py-1 rounded hover:bg-white/5">
                            <span className="text-white/60 font-mono">{r.date || '—'}</span>
                            <div className="flex items-center gap-3">
                                {r.bookCount != null && <span className="text-white/40">{r.bookCount} 本</span>}
                                <span className="text-white/80 tabular-nums">
                                    {typeof r.minutes === 'number' ? `${Math.round(r.minutes)} 分` : '—'}
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

const ReviewsView: React.FC<{ items: Review[] }> = ({ items }) => (
    <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1 custom-scrollbar">
        {items.length === 0 ? (
            <div className="text-xs text-white/50 py-6 text-center">暂无书评</div>
        ) : items.map((r, i) => (
            <div key={i} className="rounded-lg border border-white/5 bg-white/[0.03] p-3 space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-2">
                        <span className="text-white/80 font-medium">{r.reviewer || '匿名读者'}</span>
                        {r.rating != null && (
                            <span className="text-amber-300/90">{'★'.repeat(Math.max(0, Math.min(5, Math.round(r.rating))))}</span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 text-white/40">
                        {r.likeCount != null && <span>👍 {r.likeCount}</span>}
                        {r.createTime ? <span>{fmtAgo(r.createTime)}</span> : null}
                    </div>
                </div>
                <div className="text-sm text-white/85 leading-relaxed whitespace-pre-wrap break-words">
                    {r.content}
                </div>
            </div>
        ))}
    </div>
);

// ========== 主卡片 ==========

export type WereadCardProps = {
    metadata?: Record<string, any>;
    className?: string;
};

const WereadCard: React.FC<WereadCardProps> = ({ metadata, className = '' }) => {
    const meta = metadata || {};
    const toolName = String(meta.wereadToolName || 'unknown');
    const kind = String(meta.wereadCardKind || inferKindFallback(toolName));
    const result = meta.wereadToolResult;
    const err = meta.wereadToolError;

    if (err) return <ErrBar toolName={toolName} err={err} />;

    if (kind === 'bookshelf' || kind === 'search') {
        const books = coerceBooks(result);
        return (
            <div className={`rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-3 ${className}`}>
                <ToolHeader toolName={toolName} resultCount={books.length} kind={kind} />
                <BookShelfView books={books} />
            </div>
        );
    }
    if (kind === 'book-detail') {
        const book = coerceBook(result) || (coerceBooks(result)[0]);
        return (
            <div className={`rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-3 ${className}`}>
                <ToolHeader toolName={toolName} kind={kind} />
                {book ? <BookRow book={book} /> : <div className="text-xs text-white/50">暂无详情</div>}
            </div>
        );
    }
    if (kind === 'highlights') {
        const hs = coerceHighlights(result);
        return (
            <div className={`rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-3 ${className}`}>
                <ToolHeader toolName={toolName} resultCount={hs.length} kind={kind} />
                <HighlightsView items={hs} />
            </div>
        );
    }
    if (kind === 'stats') {
        const { rows, totalMinutes, totalDays } = coerceStatRows(result);
        return (
            <div className={`rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-3 ${className}`}>
                <ToolHeader toolName={toolName} resultCount={rows.length} kind={kind} />
                <StatsView rows={rows} totalMinutes={totalMinutes} totalDays={totalDays} />
            </div>
        );
    }
    if (kind === 'reviews') {
        const rs = coerceReviews(result);
        return (
            <div className={`rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-3 ${className}`}>
                <ToolHeader toolName={toolName} resultCount={rs.length} kind={kind} />
                <ReviewsView items={rs} />
            </div>
        );
    }
    // generic: 兜底
    let pretty = '';
    try { pretty = JSON.stringify(result, null, 2); } catch { pretty = String(result); }
    return (
        <div className={`rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-sm p-3 ${className}`}>
            <ToolHeader toolName={toolName} kind="generic" />
            <pre className="text-[11px] text-white/75 whitespace-pre-wrap break-words max-h-64 overflow-y-auto custom-scrollbar">
                {pretty || '(空结果)'}
            </pre>
        </div>
    );
};

function inferKindFallback(toolName: string): string {
    const t = (toolName || '').toLowerCase();
    if (/bookshelf|book.*list|recent|书架|在读/.test(t)) return 'bookshelf';
    if (/highlight|note|划线|笔记|想法/.test(t)) return 'highlights';
    if (/stat|duration|统计|时长/.test(t)) return 'stats';
    if (/review|书评|评论/.test(t)) return 'reviews';
    if (/search|搜索|searchbook/.test(t)) return 'search';
    if (/progress|detail|info|进度|详情/.test(t)) return 'book-detail';
    return 'generic';
}

export default React.memo(WereadCard);

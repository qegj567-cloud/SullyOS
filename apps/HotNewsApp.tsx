import React, { useState, useEffect, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { ArrowLeft, ArrowClockwise, Newspaper, WarningCircle, ArrowSquareOut } from '@phosphor-icons/react';
import { DB } from '../utils/db';
import { RealtimeContextManager } from '../utils/realtimeContext';
import type { HotNewsSnapshot, HotNewsItem } from '../types';

const SLOT_WINDOW = ['00:00–04:00', '04:00–08:00', '08:00–12:00', '12:00–16:00', '16:00–20:00', '20:00–24:00'];

const HotNewsApp: React.FC = () => {
    const { closeApp, realtimeConfig, addToast } = useOS();
    const [snapshot, setSnapshot] = useState<HotNewsSnapshot | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            await RealtimeContextManager.getSlottedHotNews(realtimeConfig);
            const { id } = RealtimeContextManager.getHotNewsSlot();
            let snap = await DB.getHotNewsSnapshot(id);
            if (!snap) snap = await DB.getLatestHotNewsSnapshot();
            setSnapshot(snap);
            if (!snap) setError('暂时拉不到热点（可能是网络 / 浏览器 CORS 限制）。换到安卓端、或稍后再试。');
        } catch (e: any) {
            setError(e?.message || '加载失败');
        } finally {
            setLoading(false);
        }
    }, [realtimeConfig]);

    // 手动刷新：无视时段去重，强制重拉当前时段
    const forceRefresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const { id, date, slot, label } = RealtimeContextManager.getHotNewsSlot();
            const platforms = (realtimeConfig.newsPlatforms && realtimeConfig.newsPlatforms.length > 0)
                ? realtimeConfig.newsPlatforms
                : RealtimeContextManager.DEFAULT_HOTNEWS_PLATFORMS;
            const items = await RealtimeContextManager.fetchHotNews(platforms);
            if (items.length > 0) {
                const fresh: HotNewsSnapshot = { id, date, slot, slotLabel: label, items, platforms, fetchedAt: Date.now() };
                await DB.saveHotNewsSnapshot(fresh);
                setSnapshot(fresh);
                addToast(`已刷新 · ${label} ${items.length} 条`, 'success');
            } else {
                const latest = await DB.getLatestHotNewsSnapshot();
                setSnapshot(latest);
                addToast('刷新失败，沿用上次结果', 'error');
            }
        } catch (e: any) {
            setError(e?.message || '刷新失败');
        } finally {
            setLoading(false);
        }
    }, [realtimeConfig, addToast]);

    useEffect(() => { load(); }, [load]);

    // 按平台分组
    const grouped: { source: string; items: HotNewsItem[] }[] = [];
    if (snapshot) {
        const map = new Map<string, HotNewsItem[]>();
        for (const it of snapshot.items) {
            const key = it.source || '热点';
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(it);
        }
        for (const [source, items] of map) grouped.push({ source, items });
    }

    const fetchedTime = snapshot
        ? new Date(snapshot.fetchedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';

    return (
        <div className="h-full w-full bg-[#f4efe4] flex flex-col font-serif text-stone-900">
            {/* 顶栏 */}
            <div className="h-20 bg-[#f4efe4] flex items-end pb-3 px-4 border-b-2 border-stone-800 shrink-0 sticky top-0 z-10">
                <div className="flex items-center gap-2 w-full">
                    <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <ArrowLeft size={22} weight="bold" className="text-stone-700" />
                    </button>
                    <h1 className="text-xl font-bold tracking-wide text-stone-800 flex items-center gap-2">
                        <Newspaper size={22} weight="fill" /> 热点日报
                    </h1>
                    <button
                        onClick={forceRefresh}
                        disabled={loading}
                        className="ml-auto p-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform disabled:opacity-40"
                        title="真·刷新（强制重新拉取本时段）"
                    >
                        <ArrowClockwise size={20} weight="bold" className={`text-stone-700 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-24">
                {/* 报头 */}
                <div className="text-center pt-4 pb-3 border-b border-stone-400">
                    <p className="text-[10px] tracking-[0.4em] text-stone-500 uppercase">SullyOS Daily</p>
                    <h2 className="text-3xl font-black tracking-tight mt-1">今 日 热 点</h2>
                    {snapshot && (
                        <p className="text-[11px] text-stone-500 mt-1.5">
                            {snapshot.date} · {snapshot.slotLabel}版（{SLOT_WINDOW[snapshot.slot] || ''}） · 更新于 {fetchedTime}
                        </p>
                    )}
                </div>

                {/* 可视化声明 */}
                <div className="my-3 bg-stone-800 text-stone-100 rounded-lg px-3 py-2.5 text-[11px] leading-relaxed flex gap-2">
                    <WarningCircle size={16} weight="fill" className="shrink-0 mt-0.5 text-amber-300" />
                    <span>
                        这只是<b>热点可视化</b>。每次对话会从下面这些里<b>随机抽几条</b>注入给角色——它不一定会拎出来说，
                        当作背景认知自然存在；偶尔也会主动<b>分享成新闻卡片</b>找你聊。
                        {realtimeConfig.newsEnabled
                            ? '（已开启：角色会真的看到这些）'
                            : '（未开启「实时感知 → 新闻热点」，角色暂时看不到，去设置打开后才会聊）'}
                    </span>
                </div>

                {/* 内容 */}
                {loading && !snapshot && (
                    <div className="text-center text-stone-400 py-16 text-sm">正在召回热点…</div>
                )}

                {error && !snapshot && (
                    <div className="text-center text-stone-500 py-12 px-6 text-sm leading-relaxed">
                        <WarningCircle size={32} weight="thin" className="mx-auto mb-3 text-stone-400" />
                        {error}
                    </div>
                )}

                {snapshot && grouped.length > 0 && (
                    <div className="mt-1 divide-y divide-stone-300">
                        {grouped.map(({ source, items }) => (
                            <section key={source} className="py-3">
                                <h3 className="text-sm font-black text-stone-800 mb-2 flex items-center gap-2 before:content-[''] before:w-1 before:h-4 before:bg-red-700 before:rounded">
                                    {source}
                                </h3>
                                <ol className="space-y-2">
                                    {items.map((it, i) => (
                                        <li key={i} className="flex gap-2 text-[13px] leading-snug">
                                            <span className="font-black text-red-700 w-5 shrink-0 text-right">{i + 1}</span>
                                            <div className="flex-1 min-w-0">
                                                {it.url ? (
                                                    <a
                                                        href={it.url}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="text-stone-800 hover:text-red-700 hover:underline decoration-stone-400 inline-flex items-start gap-1"
                                                    >
                                                        <span>{it.title}</span>
                                                        <ArrowSquareOut size={11} weight="bold" className="shrink-0 mt-1 text-stone-400" />
                                                    </a>
                                                ) : (
                                                    <span className="text-stone-800">{it.title}</span>
                                                )}
                                                {it.desc && it.desc !== it.title && (
                                                    <p className="text-[11px] text-stone-500/90 leading-snug mt-0.5">{it.desc}</p>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                </ol>
                            </section>
                        ))}
                    </div>
                )}

                {snapshot && (
                    <p className="text-center text-[10px] text-stone-400 mt-6 tracking-wide">
                        — 数据来自 hot_news（orz.ai）多平台热榜 · 每天 6 个时段自动更新 · 点右上角可手动真·刷新 —
                    </p>
                )}
            </div>
        </div>
    );
};

export default HotNewsApp;

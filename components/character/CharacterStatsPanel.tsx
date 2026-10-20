import React, { useEffect, useState } from 'react';
import type { CharacterProfile, Emoji, UserProfile } from '../../types';
import { buildCharacterStats, countContextCharacters } from '../../utils/characterStats';
import { clampManualContextLimit, loadCharacterContextRange } from '../../utils/chatContextRange';
import { resolveMemoryPalaceWaterline } from '../../utils/memoryPalace/waterline';
import { DB } from '../../utils/db';
import { WORLDBOOK_POSITION_LABELS, WORLDBOOK_ROLE_LABELS } from '../../utils/worldbook';

const EMPTY_EMOJIS: Emoji[] = [];
const number = (n: number) => n.toLocaleString('zh-CN');
const statuses: Record<string, string> = { readable: '当前可读', waiting: '等待关键词', probability: '概率待定', disabled: '已停用', empty: '空正文', zero: '概率为 0' };

function TextRows({ rows }: { rows: { title: string; content: string; note?: string }[] }) {
    const [limit, setLimit] = useState(20);
    return <div className="divide-y divide-slate-100">
        {rows.slice(0, limit).map((row, i) => <details key={`${row.title}-${i}`} className="group py-3">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-3 text-xs hover:text-violet-600">
                <span className="min-w-0 break-words leading-5">{row.title}{row.note && <span className="block text-[10px] text-slate-400">{row.note}</span>}</span>
                <span className="shrink-0 pt-1 font-mono text-slate-500">{number(countContextCharacters(row.content))} 字 <span className="inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none">›</span></span>
            </summary>
            <p className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs leading-6 text-slate-600">{row.content || '无正文'}</p>
        </details>)}
        {rows.length > limit && <button className="w-full py-3 text-xs text-violet-600" onClick={() => setLimit(n => n + 50)}>继续显示（剩余 {rows.length - limit} 条）</button>}
        {!rows.length && <p className="py-4 text-xs text-slate-400">当前没有可读条目</p>}
    </div>;
}

export default function CharacterStatsPanel({ character, user, emojis = EMPTY_EMOJIS, onOpenMemory }: { character: CharacterProfile; user: UserProfile; emojis?: Emoji[]; onOpenMemory: () => void }) {
    const [stats, setStats] = useState<ReturnType<typeof buildCharacterStats> | null>(null);
    const [revision, setRevision] = useState(0);
    const [error, setError] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setStats(null); setError(false);
        Promise.all([loadCharacterContextRange(character), emojis.length ? Promise.resolve(emojis) : DB.getEmojis()]).then(([range, availableEmojis]) => {
            if (!cancelled) setStats(buildCharacterStats(character, user, range, availableEmojis));
        }).catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [character, user, emojis, revision]);
    const refresh = () => setRevision(n => n + 1);
    const waterline = resolveMemoryPalaceWaterline(character.memoryPalaceWaterline);
    return <section className="mx-auto max-w-2xl text-slate-700" aria-label="角色统计">
        <header className="flex items-start justify-between gap-4 pb-6">
            <div><p className="text-[10px] font-semibold tracking-[0.2em] text-violet-500">CONTEXT INSIGHT</p><h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">角色统计</h2><p className="mt-1 text-xs text-slate-400">看见记忆，也看见上下文的负担。</p></div>
            <button onClick={refresh} className="rounded-full border border-slate-200 px-3 py-1.5 text-xs transition-colors hover:border-violet-300 hover:text-violet-600">刷新</button>
        </header>
        {error ? <p role="alert" className="py-8 text-sm">读取失败，请点击刷新重试。</p> : !stats ? <p role="status" className="py-8 text-sm text-slate-400">正在读取当前范围…</p> : <>
            <div className="border-y border-slate-200 py-5">
                <div className="flex items-center justify-between text-xs"><span>记忆宫殿</span><span className={character.memoryPalaceEnabled ? 'text-violet-600' : 'text-slate-400'}>● {character.memoryPalaceEnabled ? '已启动' : '未启动'}</span></div>
                <div className="mt-4 flex items-start justify-between gap-4 text-xs"><span>上下文水位线</span><span className="text-right font-medium">{stats.range.mode === 'adaptive' ? '跟随记忆宫殿' : `用户设定 · 最近 ${clampManualContextLimit(character.contextLimit)} 条`}</span></div>
                <p className="mt-3 text-[11px] leading-5 text-slate-400">{stats.range.mode === 'adaptive' ? '读取记忆宫殿整理水位之后的对话原文。' : '手动范围不随宫殿整理水位收缩。'}{stats.range.effectiveStartMessageId ? ` 当前共读取 ${stats.range.messages.length} 条原文。` : ' 当前范围为空。'}{stats.range.userStartMessageId ? ' 已按你指定的起点截取。' : ''}{stats.range.userBreakpointExpired ? ' 之前手动指定的起点已随新消息自动失效。' : ''}</p>
                <p className="mt-1 text-[11px] leading-5 text-slate-400">自动归档{character.autoArchiveEnabled ? '开启' : '关闭'} · 平时保留 {waterline.hotZoneSize} 条原文 / 每满 {waterline.bufferThreshold} 条整理一次（整理节奏，不是上下文条数上限）</p>
            </div>
            <div className="py-7"><p className="text-xs text-slate-500">已统计正文</p><p className="mt-2 font-mono text-4xl tracking-tight text-slate-900">{number(stats.total)}<span className="ml-2 font-sans text-xs tracking-normal text-slate-400">字符</span></p>
                <div className="mt-5 flex h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">{[stats.historyCharacters, stats.memoryCharacters, stats.worldbookCharacters, stats.otherCharacters].map((v, i) => <div key={i} className={['bg-violet-500', 'bg-slate-500', 'bg-violet-200', 'bg-slate-300'][i]} style={{ width: `${stats.total ? v / stats.total * 100 : 0}%` }} />)}</div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[10px] text-slate-500">{[['消息', stats.historyCharacters], ['记忆', stats.memoryCharacters], ['世界书', stats.worldbookCharacters], ['其他', stats.otherCharacters]].map(([label, n]) => <span key={label}>{label} <b className="font-mono font-medium">{number(Number(n))}</b></span>)}</div>
                <p className="mt-4 text-[11px] leading-5 text-slate-400">本地可读范围快照，不等于实际请求或 token 数。包含正文与消息格式文本；不包含图片、App 专属规则及本轮动态召回；人设等按配置正文统计，不含提示词包装。不同 App 还会按场景筛选消息。</p>
            </div>
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
                <p className="text-sm font-semibold text-amber-900">≈ {number(stats.estimatedTokens)} Token · 估计值，非真实用量</p>
                <p className="mt-2 text-[11px] leading-5 text-amber-800">仅估算上方已统计正文：ASCII 字符约 4 字 / Token，其他字符约 1 字 / Token。不是模型专属分词结果，也不是完整请求用量；实际以 API 返回的 usage 为准。</p>
                <details className="mt-3 text-xs text-amber-900"><summary className="cursor-pointer">为什么换模型后 Token 不一样？</summary><p className="mt-2 text-[11px] leading-5">同一段中文会被不同分词器切成不同数量。国产模型、Gemini、Claude 没有通用固定比例或保证的大小顺序，模型版本和内容也会影响结果。例：DeepSeek 官方给出的粗略换算为 1 中文字符 ≈ 0.6 Token，即 1 万中文字符约 6,000 Token；不能推广到所有国产模型。Gemini / Claude 应使用各自的 Token 计数接口核对。本页不会为统计额外调用 API。</p><div className="mt-2 flex flex-wrap gap-3 text-[11px] underline"><a href="https://api-docs.deepseek.com/zh-cn/quick_start/token_usage/" target="_blank" rel="noreferrer">DeepSeek 说明 ↗</a><a href="https://ai.google.dev/gemini-api/docs/tokens" target="_blank" rel="noreferrer">Gemini 计数 ↗</a><a href="https://platform.claude.com/docs/en/build-with-claude/token-counting" target="_blank" rel="noreferrer">Claude 计数 ↗</a></div></details>
            </div>
            <details open className="border-t border-slate-200 py-5"><summary className="cursor-pointer text-sm font-semibold">神经链接记忆 <span className="float-right font-mono text-xs font-normal text-slate-400">{stats.memoryRows.length} 条 / {number(stats.memoryCharacters)} 字</span></summary>
                <div className="my-4 border-l-2 border-violet-300 bg-violet-50/60 px-3 py-3 text-xs leading-6 text-violet-800">
                    {stats.memories.daily.length ? `小眼睛已开启：${stats.memories.daily.map(g => `${g.month}（${g.entries.length} 条）`).join('、')}。这些日度记忆仍可被读取。` : '所有日度记忆的小眼睛均已关闭。'}
                    <span className="block">月度总结 {stats.memories.monthly.length} 条，关闭小眼睛后仍然可读。</span>
                    <button onClick={onOpenMemory} className="mt-1 underline underline-offset-4">前往记忆检查 →</button>
                </div><TextRows rows={stats.memoryRows} />
            </details>
            <details open className="border-t border-slate-200 py-5"><summary className="cursor-pointer text-sm font-semibold">世界书 <span className="float-right font-mono text-xs font-normal text-slate-400">{stats.books.filter(b => b.status === 'readable').length} 条 / {number(stats.worldbookCharacters)} 字</span></summary>
                <p className="my-3 text-[11px] leading-5 text-slate-400">按当前消息窗口检查关键词，不进行概率抽签。待触发和停用条目列出但不计入总量；下一次输入可能改变结果。</p>
                <TextRows rows={stats.books.map(({ book, content, status, probability }) => ({ title: book.title || '未命名世界书', content, note: `${statuses[status]}${status === 'probability' ? ` ${probability}%` : ''} · ${WORLDBOOK_POSITION_LABELS[book.position ?? 1]}${book.position === 4 ? ` · 深度 ${book.depth ?? 4} · ${WORLDBOOK_ROLE_LABELS[book.role ?? 0]}` : ''} · 顺序 ${book.order ?? 100}` }))} />
            </details>
            <details className="border-t border-slate-200 py-5"><summary className="cursor-pointer text-sm font-semibold">其他常驻来源 <span className="float-right font-mono text-xs font-normal text-slate-400">{number(stats.otherCharacters)} 字</span></summary><TextRows rows={stats.otherRows} /></details>
            <details className="border-t border-slate-200 py-5"><summary className="cursor-pointer text-sm font-semibold">宫殿召回快照 <span className="float-right font-mono text-xs font-normal text-slate-400">{number(countContextCharacters(stats.recallSnapshot))} 字</span></summary><p className="my-3 text-[11px] leading-5 text-slate-400">这是上次保存的召回正文，不代表下一次召回，不计入上方总量。实际召回会随问题变化；宫殿关闭时不读取残留内容。</p><TextRows rows={stats.recallSnapshot ? [{ title: '上次召回', content: stats.recallSnapshot }] : []} /></details>
            <details open className="border-t border-slate-200 py-5"><summary className="cursor-pointer text-sm font-semibold">消息来源 <span className="float-right font-mono text-xs font-normal text-slate-400">{stats.sources.reduce((n, s) => n + s.count, 0)} 条</span></summary>
                <p className="my-3 text-[11px] leading-5 text-slate-400">按消息最初产生的 App 分类。它们位于角色共享记录中，不代表只有对应 App 才能读取；未写入共享记录的独立会话不在此处。</p>
                {stats.sources.map(source => <div key={source.name} className="border-b border-slate-100 py-3"><div className="flex justify-between gap-3 text-xs"><span className="break-all">{source.name}</span><span className="shrink-0 font-mono text-slate-500">{number(source.characters)} 字</span></div><div className="mt-2 flex items-center gap-3"><div className="h-1 flex-1 rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-300" style={{ width: `${stats.historyCharacters ? source.characters / stats.historyCharacters * 100 : 0}%` }} /></div><span className="text-[10px] text-slate-400">{source.count} 条</span></div></div>)}
                {!stats.sources.length && <p className="py-4 text-xs text-slate-400">当前没有可读消息</p>}
            </details>
        </>}
    </section>;
}

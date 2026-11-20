import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOS } from '../../context/OSContext';
import { CaretLeft, FileArrowUp, Trash, Warning } from '@phosphor-icons/react';
import { DB } from '../../utils/db';
import { CC_CATEGORIES, labelOfCategory } from '../../utils/creatorCategories';
import { creatorPartToBlobRefs, loadCreatorPartsForRender } from '../../utils/creatorPartsBlob';
import type { CustomCreatorPart } from '../../types';
import type { ParsedPsdPart } from '../../utils/psdCreatorImport';

/**
 * 用户侧「自定义素材工坊」——挂在手办柜（ChibiStudio）里，让正式站用户也能 PSD 批量导入
 * 自定义部件（dev 面板 CharCreatorDevApp 只在本地测试版可见，用户够不着）。
 * 部件存进 cc_custom_parts（Blob 令牌，省配额）；再进捏人器时经 loadCreatorPartsForRender 注入。
 */
const CreatorPartsUploader: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const { addToast } = useOS();
    const [parts, setParts] = useState<CustomCreatorPart[]>([]);
    const [showRules, setShowRules] = useState(false);
    const [psdParsing, setPsdParsing] = useState(false);
    const [psdParts, setPsdParts] = useState<ParsedPsdPart[]>([]);
    const [psdWarnings, setPsdWarnings] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const psdRef = useRef<HTMLInputElement>(null);

    const load = useCallback(async () => {
        try { setParts(await loadCreatorPartsForRender()); } catch { /* ignore */ }
    }, []);
    useEffect(() => { void load(); }, [load]);

    const onPsdFile = async (f: File | undefined) => {
        if (!f) return;
        setPsdParsing(true);
        setPsdParts([]); setPsdWarnings([]);
        try {
            const { parseCreatorPsd } = await import('../../utils/psdCreatorImport');
            const result = await parseCreatorPsd(await f.arrayBuffer());
            setPsdParts(result.parts);
            setPsdWarnings(result.warnings);
            if (!result.parts.length) addToast('没解析出部件，看看「命名规则」里的结构要求', 'error');
        } catch (err) {
            addToast('PSD 解析失败：' + String((err as Error)?.message || err), 'error');
        } finally {
            setPsdParsing(false);
            if (psdRef.current) psdRef.current.value = '';
        }
    };

    const updatePsdPart = (idx: number, patch: Partial<ParsedPsdPart>) =>
        setPsdParts(prev => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));

    const savePsdParts = async () => {
        const ready = psdParts.filter(p => p.categoryKey);
        if (!ready.length) { addToast('先给每个部件选好类目', 'error'); return; }
        if (ready.length < psdParts.length) { addToast('还有部件没选类目', 'error'); return; }
        setBusy(true);
        try {
            for (const p of ready) {
                const part: CustomCreatorPart = {
                    id: `${p.categoryKey}_cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                    categoryKey: p.categoryKey!,
                    name: p.name || `自定义${labelOfCategory(p.categoryKey!)}`,
                    src: p.src,
                    tintable: p.tintable,
                    shadowSrc: p.shadowSrc,
                    createdAt: Date.now(),
                };
                await DB.saveCustomCreatorPart(await creatorPartToBlobRefs(part));
            }
            setPsdParts([]); setPsdWarnings([]);
            await load();
            addToast(`已加入 ${ready.length} 个部件，进捏人器就能用啦`, 'success');
        } catch (e) {
            addToast('保存失败：' + String((e as Error)?.message || e), 'error');
        } finally {
            setBusy(false);
        }
    };

    const removePart = async (id: string) => {
        try { await DB.deleteCustomCreatorPart(id); await load(); addToast('已删除', 'success'); }
        catch (e) { addToast('删除失败：' + String((e as Error)?.message || e), 'error'); }
    };

    // 按类目分组展示已有部件
    const grouped: Record<string, CustomCreatorPart[]> = {};
    parts.forEach(p => { (grouped[p.categoryKey] = grouped[p.categoryKey] || []).push(p); });

    return (
        <div className="fixed inset-0 z-[65] flex flex-col" style={{ background: 'linear-gradient(180deg, #241b3f 0%, #171130 55%, #120d24 100%)' }}>
            {/* 顶栏：全屏浮层统一用 --chrome-top（安全区 + SullyOS 状态栏；状态栏隐藏时自动塌回 --safe-top），
                与 ChibiStudio / 彼方 ChibiEditor 同一套约定，避免怼进状态栏时钟/电量条 */}
            <div className="shrink-0 px-4 pb-3 flex items-center gap-2 text-white" style={{ paddingTop: 'var(--chrome-top)' }}>
                <button onClick={onClose} className="p-2 -ml-2 rounded-full text-indigo-100 active:bg-white/10"><CaretLeft size={20} weight="bold" /></button>
                <div>
                    <h2 className="font-serif text-lg font-bold tracking-wide leading-tight">自定义素材工坊</h2>
                    <p className="text-[10px] tracking-[3px] text-indigo-300/60">CUSTOM PARTS</p>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 space-y-4" style={{ paddingBottom: 'calc(2rem + var(--safe-bottom))' }}>
                {/* PSD 导入卡 */}
                <div className="rounded-2xl p-3.5 border border-white/10 space-y-2.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <div className="text-[13px] font-bold text-white flex items-center gap-1.5">
                        <FileArrowUp size={15} weight="bold" className="text-amber-300" />
                        上传 PSD，批量加自定义部件
                    </div>

                    <button onClick={() => setShowRules(v => !v)} className="text-[11px] font-bold text-amber-200/90 flex items-center gap-1 active:opacity-70">
                        {showRules ? '▾' : '▸'} PSD 怎么做（命名规则）
                    </button>
                    {showRules && (
                        <div className="text-[10.5px] text-indigo-100/60 leading-relaxed space-y-2 rounded-xl bg-black/25 p-2.5 border border-white/10">
                            <div><b className="text-white/85">① 结构</b>：顶层<b>图层组 = 一个类目</b>，<b>组内每个图层 = 一个部件</b>。例：<code>眼睛</code> 组里放「杏眼」「圆眼」各一层 → 两个部件。</div>
                            <div>
                                <b className="text-white/85">② 组名 = 类目</b>（中英文都认）：
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {CC_CATEGORIES.map(c => (
                                        <span key={c.key} className="px-1.5 py-0.5 rounded bg-white/8 text-white/75">{c.label}<span className="text-white/35"> / {c.key}</span></span>
                                    ))}
                                </div>
                            </div>
                            <div><b className="text-white/85">③ 图层名 = 部件名</b>；换色标记 <code>#色</code> / <code>#原色</code>（头发+眼睛默认可换色）。</div>
                            <div><b className="text-white/85">④ 显示 / 隐藏</b>：要导入的图层保持<b>显示</b>，隐藏图层会跳过；不透明度拉满。</div>
                            <div><b className="text-white/85">⑤ 画布</b> 472×472 正方形。识别不出类目也没关系，下面能手动选。</div>
                        </div>
                    )}

                    <input ref={psdRef} type="file" accept=".psd" className="hidden" onChange={e => void onPsdFile(e.target.files?.[0])} />
                    <button onClick={() => psdRef.current?.click()} disabled={psdParsing || busy}
                        className="w-full rounded-xl border border-dashed border-white/30 py-3 text-[12px] text-indigo-100/70 active:bg-white/5 disabled:opacity-50">
                        {psdParsing ? '解析中…' : '选择 .psd 文件'}
                    </button>

                    {psdWarnings.map((w, i) => (
                        <div key={i} className="text-[10px] text-amber-200/80 flex gap-1"><Warning size={12} className="shrink-0 mt-0.5" />{w}</div>
                    ))}

                    {psdParts.length > 0 && (
                        <div className="space-y-2">
                            {psdParts.map((p, idx) => (
                                <div key={idx} className="rounded-xl border border-white/10 p-2 flex gap-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
                                    <div className="w-14 h-14 shrink-0 rounded-lg overflow-hidden" style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 12px 12px' }}>
                                        <img src={p.src} alt={p.name} className="w-full h-full object-contain" />
                                    </div>
                                    <div className="flex-1 min-w-0 space-y-1.5">
                                        <div className="flex gap-1.5">
                                            <select value={p.categoryKey || ''} onChange={e => updatePsdPart(idx, { categoryKey: e.target.value || null })}
                                                className={`text-[10.5px] rounded px-1.5 py-1 bg-white/10 [color-scheme:dark] outline-none ${p.categoryKey ? 'text-white' : 'text-red-300 border border-red-400/50'}`}>
                                                <option value="" className="bg-slate-900 text-white">类目?</option>
                                                {CC_CATEGORIES.map(c => <option key={c.key} value={c.key} className="bg-slate-900 text-white">{c.label}</option>)}
                                            </select>
                                            <input value={p.name} onChange={e => updatePsdPart(idx, { name: e.target.value })}
                                                className="flex-1 min-w-0 text-[10.5px] rounded px-1.5 py-1 bg-white/10 text-white outline-none" />
                                        </div>
                                        <div className="flex items-center gap-2.5 text-[10px] text-indigo-100/70">
                                            <label className="flex items-center gap-1">
                                                <input type="checkbox" checked={p.tintable} onChange={e => updatePsdPart(idx, { tintable: e.target.checked })} className="accent-amber-400 w-3 h-3" />
                                                可换色
                                            </label>
                                            <button onClick={() => setPsdParts(prev => prev.filter((_, i) => i !== idx))} className="ml-auto text-red-300/80 active:text-red-300">移除</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            <button onClick={() => void savePsdParts()} disabled={busy}
                                className="w-full rounded-xl py-2.5 text-[13px] font-bold text-black disabled:opacity-50" style={{ background: 'linear-gradient(135deg,#fbbf24,#f59e0b)' }}>
                                {busy ? '保存中…' : `全部加入（${psdParts.length}）`}
                            </button>
                        </div>
                    )}
                </div>

                {/* 已有自定义部件 */}
                <div className="space-y-2">
                    <div className="text-[12px] font-bold text-indigo-100/85 px-0.5">我的自定义部件{parts.length > 0 ? ` · ${parts.length}` : ''}</div>
                    {parts.length === 0 ? (
                        <p className="text-[11px] text-indigo-300/45 py-3 text-center">还没有自定义部件。传个 PSD 试试～</p>
                    ) : (
                        Object.keys(grouped).map(key => (
                            <div key={key}>
                                <div className="text-[10.5px] font-bold text-indigo-300/70 mb-1.5">{labelOfCategory(key)} · {grouped[key].length}</div>
                                <div className="grid grid-cols-4 gap-2">
                                    {grouped[key].map(p => (
                                        <div key={p.id} className="relative rounded-lg overflow-hidden border border-white/10 aspect-square flex items-center justify-center"
                                            style={{ background: 'repeating-conic-gradient(#ffffff10 0% 25%, transparent 0% 50%) 50% / 14px 14px' }}>
                                            <img src={p.src} alt={p.name} className="max-h-full max-w-full object-contain" />
                                            <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[8px] text-white/90 px-1 py-0.5 truncate">{p.name}{p.tintable ? ' ·色' : ''}</span>
                                            <button onClick={() => void removePart(p.id)} className="absolute top-1 right-1 bg-red-500/90 rounded-full p-1 active:scale-90 text-white"><Trash size={10} weight="bold" /></button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))
                    )}
                    <p className="text-[10px] text-indigo-300/45 leading-relaxed px-0.5 pt-1">
                        自定义部件会出现在<b className="text-indigo-200/70">捏人器</b>里对应类目下（只你自己可见）。加/删后重新进捏人器即可看到。
                    </p>
                </div>
            </div>
        </div>
    );
};

export default CreatorPartsUploader;

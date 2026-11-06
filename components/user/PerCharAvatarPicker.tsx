import React, { useMemo, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { processImage } from '../../utils/file';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import TokenImg from '../os/TokenImg';
import CharacterUserPersonaEditor from '../character/CharacterUserPersonaEditor';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

/**
 * 档案 App「在 TA 面前的我」：一起管理分角色头像与用户资料补充。
 * 文字补充存角色的 userPersona，由 ContextBuilder 合并到用户信息。
 * 不设置 = 用档案上面的整体头像（宏观默认）；数据存 userProfile.perCharAvatars，
 * 随 user_profile 单例进备份。群聊仍用整体头像。
 *
 * 角色可能很多：搜索过滤 + 每页 8 个的翻页网格（左右箭头 / 横滑 / 圆点直达），
 * 翻页带轻量滑入动效。头像来源支持图床 URL（推荐，轻量）与本地上传。
 */

const PAGE_SIZE = 8;

const isValidHttpImageUrl = (value: string) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
        return false;
    }
};

const PerCharAvatarPicker: React.FC = () => {
    const { characters, userProfile, updateUserProfile, updateCharacter, addToast } = useOS();
    const overrides = userProfile.perCharAvatars || {};

    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const [slideDir, setSlideDir] = useState<'l' | 'r'>('l');
    const swipeStartX = useRef<number | null>(null);

    const [editingId, setEditingId] = useState<string | null>(null);
    const [urlDraft, setUrlDraft] = useState('');
    const uploadRef = useRef<HTMLInputElement>(null);
    useLocalBackHandler(() => { setEditingId(null); return true; }, 30, editingId !== null);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? characters.filter(c => c.name.toLowerCase().includes(q)) : characters;
    }, [characters, query]);

    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const pageChars = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

    const goPage = (next: number) => {
        const clamped = Math.max(0, Math.min(pageCount - 1, next));
        if (clamped === safePage) return;
        setSlideDir(clamped > safePage ? 'l' : 'r');
        setPage(clamped);
    };

    const setOverride = (charId: string, avatar: string | undefined) => {
        const next = { ...overrides };
        if (avatar) next[charId] = avatar; else delete next[charId];
        updateUserProfile({ perCharAvatars: next });
    };

    const editingChar = editingId ? characters.find(c => c.id === editingId) : null;
    const editingOverride = editingId ? overrides[editingId] : undefined;

    const openEditor = (charId: string) => {
        setEditingId(charId);
        const cur = overrides[charId];
        // 只有 http(s) 直链才回填进外链输入框——上传来的图（内嵌 data: 或 blobref 令牌）
        // 填进去既没法看也没法改，而且这个框本来也只收 http(s)（见下面 applyUrl 的校验）。
        setUrlDraft(cur && isValidHttpImageUrl(cur) ? cur : '');
    };

    const applyUrl = () => {
        if (!editingId) return;
        const url = urlDraft.trim();
        if (!isValidHttpImageUrl(url)) {
            addToast('URL 无效，请填写 http(s) 图片直链', 'error');
            return;
        }
        setOverride(editingId, url);
        addToast('已设置该角色的聊天头像', 'success');
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file || !editingId) return;
        try {
            const base64 = await processImage(file);
            // 本地上传的图存令牌（图床外链那条路不经过这里，原样存字符串即可）
            setOverride(editingId, await migrateDataUrlToRef(base64));
            setUrlDraft('');
            addToast('已设置该角色的聊天头像', 'success');
        } catch (err: any) {
            addToast(err.message, 'error');
        }
    };

    if (characters.length === 0) return null;

    return (
        <div className="bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100 p-5">
            {/* 翻页滑入动效（组件私有，不进全局 tailwind 配置） */}
            <style>{`
                @keyframes pcaSlideL { from { opacity: .35; transform: translateX(26px); } to { opacity: 1; transform: none; } }
                @keyframes pcaSlideR { from { opacity: .35; transform: translateX(-26px); } to { opacity: 1; transform: none; } }
                .pca-slide-l { animation: pcaSlideL .28s cubic-bezier(0.25, 1, 0.5, 1); }
                .pca-slide-r { animation: pcaSlideR .28s cubic-bezier(0.25, 1, 0.5, 1); }
            `}</style>

            <div className="flex items-center gap-2 mb-1">
                <span className="w-7 h-7 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </span>
                <h2 className="text-sm font-bold text-slate-700">在 TA 面前的我</h2>
            </div>
            <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                选择角色，设置在 TA 面前使用的头像、称呼、外貌与补充设定。留空沿用个人档案，经历与记忆继续保留。
            </p>

            {characters.length > PAGE_SIZE && (
                <input
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                    placeholder="搜索角色…"
                    className="w-full mb-3 bg-slate-50 focus:bg-white border border-slate-100 focus:border-primary/30 rounded-2xl px-4 py-2 text-xs text-slate-700 outline-none transition-all placeholder:text-slate-300"
                />
            )}

            {filtered.length === 0 ? (
                <div className="py-8 text-center text-[11px] text-slate-300">没有叫这个名字的角色</div>
            ) : (
                <div
                    onTouchStart={(e) => { swipeStartX.current = e.touches[0]?.clientX ?? null; }}
                    onTouchEnd={(e) => {
                        const startX = swipeStartX.current;
                        swipeStartX.current = null;
                        const endX = e.changedTouches[0]?.clientX;
                        if (startX == null || endX == null) return;
                        const dx = endX - startX;
                        if (Math.abs(dx) > 48) goPage(safePage + (dx < 0 ? 1 : -1));
                    }}
                >
                    <div key={`${safePage}-${query}`} className={`grid grid-cols-4 gap-3 ${slideDir === 'l' ? 'pca-slide-l' : 'pca-slide-r'}`}>
                        {pageChars.map(c => {
                            const override = overrides[c.id];
                            return (
                                <button key={c.id} onClick={() => openEditor(c.id)} className="flex flex-col items-center gap-1.5 group active:scale-95 transition-transform">
                                    <div className="relative">
                                        <TokenImg value={c.avatar} alt="" className="w-14 h-14 rounded-full object-cover bg-slate-100 border border-slate-100 group-hover:border-primary/30 transition-colors" />
                                        {/* 右下小圆 = 这个聊天里「你」的头像；设置过 → 主题色描边，否则灰显整体头像 */}
                                        <TokenImg
                                            value={override || userProfile.avatar}
                                            alt=""
                                            className={`absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-full object-cover bg-white shadow-sm ${override ? 'ring-2 ring-primary' : 'ring-2 ring-white opacity-60'}`}
                                        />
                                    </div>
                                    <span className="w-full text-[10px] text-slate-500 truncate text-center">{c.name}</span>
                                </button>
                            );
                        })}
                        {/* 末页不满 8 人时用隐形占位补齐两行高度，翻页时容器不弹跳 */}
                        {pageCount > 1 && pageChars.length < PAGE_SIZE && Array.from({ length: PAGE_SIZE - pageChars.length }, (_, i) => (
                            <div key={`pad-${i}`} className="flex flex-col items-center gap-1.5 invisible" aria-hidden="true">
                                <div className="w-14 h-14 rounded-full" />
                                <span className="text-[10px]">&nbsp;</span>
                            </div>
                        ))}
                    </div>

                    {pageCount > 1 && (
                        <div className="mt-3 flex items-center justify-center gap-3">
                            <button onClick={() => goPage(safePage - 1)} disabled={safePage === 0}
                                className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-sm text-slate-500 transition-all active:scale-90 disabled:opacity-30" aria-label="上一页">‹</button>
                            <div className="flex items-center gap-1.5">
                                {Array.from({ length: pageCount }, (_, i) => (
                                    <button key={i} onClick={() => goPage(i)} aria-label={`第 ${i + 1} 页`}
                                        className={`rounded-full transition-all ${i === safePage ? 'w-4 h-1.5 bg-primary' : 'w-1.5 h-1.5 bg-slate-200 hover:bg-slate-300'}`} />
                                ))}
                            </div>
                            <button onClick={() => goPage(safePage + 1)} disabled={safePage === pageCount - 1}
                                className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-sm text-slate-500 transition-all active:scale-90 disabled:opacity-30" aria-label="下一页">›</button>
                        </div>
                    )}
                </div>
            )}

            {/* 编辑弹层：URL 优先（推荐）+ 本地上传 + 恢复整体头像 */}
            {editingChar && (
                <div role="dialog" aria-modal="true" aria-label={`在 ${editingChar.name} 面前的我`} className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in" onClick={() => setEditingId(null)}>
                    <div className="w-full sm:max-w-sm max-h-[85dvh] overflow-y-auto bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-5 animate-slide-up sm:animate-pop-in"
                        style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                        onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start justify-between mb-3">
                            <div>
                                <div className="text-sm font-bold text-slate-800">在 {editingChar.name} 面前的我</div>
                                <div className="mt-0.5 text-[10px] text-slate-400">专属头像用于私聊；群聊头像沿用整体设置。</div>
                            </div>
                            <button aria-label="关闭在 TA 面前的我" onClick={() => setEditingId(null)} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">×</button>
                        </div>

                        <div className="flex items-center justify-center gap-5 mb-4">
                            <div className="flex flex-col items-center gap-1">
                                <TokenImg value={editingChar.avatar} className="w-16 h-16 rounded-full object-cover bg-slate-100" alt="" />
                                <span className="text-[10px] text-slate-400">{editingChar.name}</span>
                            </div>
                            <span className="text-slate-300 text-lg">×</span>
                            <div className="flex flex-col items-center gap-1">
                                <TokenImg value={editingOverride || userProfile.avatar} className={`w-16 h-16 rounded-full object-cover bg-slate-100 ${editingOverride ? 'ring-2 ring-primary' : 'ring-2 ring-slate-200'}`} alt="" />
                                <span className="text-[10px] text-slate-400">{editingOverride ? '已单独设置' : '整体头像（默认）'}</span>
                            </div>
                        </div>

                        <div className="rounded-2xl bg-slate-50 p-3 mb-2">
                            <div className="text-[11px] font-bold text-slate-600 mb-1.5">图床链接（推荐）</div>
                            <div className="flex gap-2">
                                <input
                                    value={urlDraft}
                                    onChange={(e) => setUrlDraft(e.target.value)}
                                    placeholder="https://… 图片直链"
                                    className="flex-1 min-w-0 bg-white border border-slate-200 focus:border-primary/40 rounded-xl px-3 py-2 text-xs text-slate-700 outline-none transition-all placeholder:text-slate-300"
                                />
                                <button onClick={applyUrl} className="shrink-0 rounded-xl bg-primary px-3 py-2 text-[11px] font-bold text-white active:scale-95 transition-transform">使用</button>
                            </div>
                            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                                推荐链接：不占本地空间，备份更小更快；「纯文字备份」也只有链接能把图带走（本地上传的图会被剥掉）。
                            </p>
                        </div>

                        <div className="flex gap-2">
                            <button onClick={() => uploadRef.current?.click()}
                                className="flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-[11px] font-bold text-slate-600 active:scale-[0.98] transition-transform">
                                本地上传（存进本机）
                            </button>
                            {editingOverride && (
                                <button
                                    onClick={() => { setOverride(editingChar.id, undefined); setUrlDraft(''); addToast('已恢复整体头像', 'success'); }}
                                    className="flex-1 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-[11px] font-bold text-rose-500 active:scale-[0.98] transition-transform">
                                    恢复整体头像
                                </button>
                            )}
                        </div>
                        <input type="file" ref={uploadRef} className="hidden" accept="image/*" onChange={handleUpload} />
                        <CharacterUserPersonaEditor key={editingChar.id} value={editingChar.userPersona} onChange={value => updateCharacter(editingChar.id, { userPersona: value })} />
                    </div>
                </div>
            )}
        </div>
    );
};

export default PerCharAvatarPicker;

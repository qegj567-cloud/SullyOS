/**
 * 彼方·剧院 面板。
 *
 * 视觉分两套：
 * - 主体（投稿/选剧/编排/表单/历史）走「深红丝绒 + 烫金」正剧院风（高对比、读得清）；
 * - 只有【演出时的台词气泡】保留动森奶油气泡那点可爱劲（角色说话用）。
 *
 * 流程：投稿池(浏览/写/LLM代写/传txt) → 选一本【编排】(选角+缺角roll NPC+调用模式+可润色)
 * → 并发收集演员意见 → 【召唤导演】(注入各演员本色，防 OOC)整合最终本 → chibi 大舞台演出
 * → 收录【历史舞台剧】+ 回发各参演角色聊天。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { X, CaretLeft, CaretRight, Plus, Trash, Sparkle, Play, FilmSlate, UploadSimple, DownloadSimple } from '@phosphor-icons/react';
import { DB } from '../../utils/db';
import { SCRIPT_TEMPLATE } from '../../utils/vrWorld/constants';
import { WRITING_PRESETS, type WritingPreset } from '../../utils/vrWorld/presets';
import { resolveTheaterApi, generateScript, polishScript, collectActorNotes, charActorCount, runDirector, type TheaterCtx } from '../../utils/vrWorld/theater';
import { rollNpcChibi, randomNpcName } from '../../utils/vrWorld/npcRoll';
import { getChibi } from '../../utils/vrWorld/chibi';
import TokenImg from '../../components/os/TokenImg';
import { CreatorIframe } from '../../components/Like520Event';
import type { VRScript, VRStagedPlay, VRCastAssign, VRActorNote, VRStageMode, VRPlayRole, Emoji, EmojiCategory, CharacterProfile } from '../../types';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

const tid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const SERIF = `'Noto Serif SC',serif`;

/** 正剧院配色（深红丝绒 + 烫金 + 高对比奶白字）。 */
const TH = {
    bg: '#1b0f13', bg2: '#271820', bg3: '#33222b',
    line: 'rgba(212,175,106,.34)', gold: '#d8b271', goldSoft: '#caa46a',
    text: '#f4ece0', sub: '#cbb89e', crimson: '#b9384a', warn: '#e6c15a',
};

// ============ 正剧院风原子组件 ============
const TButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'default' | 'ghost'; size?: 'sm' | 'md'; block?: boolean; icon?: React.ReactNode }> = ({ variant = 'default', size = 'md', block, icon, children, disabled, style, ...rest }) => {
    const h = size === 'sm' ? 30 : 38, fs = size === 'sm' ? 12 : 13.5, padX = size === 'sm' ? 12 : 18;
    const v = variant === 'primary'
        ? { background: `linear-gradient(180deg,${TH.gold},#b98f4e)`, color: '#2a1810', border: `1px solid ${TH.gold}`, boxShadow: '0 2px 8px rgba(212,175,106,.28)' }
        : variant === 'ghost'
            ? { background: 'transparent', color: TH.goldSoft, border: '1px solid transparent' }
            : { background: TH.bg3, color: TH.text, border: `1px solid ${TH.line}` };
    return <button {...rest} disabled={disabled} style={{ display: block ? 'flex' : 'inline-flex', width: block ? '100%' : undefined, alignItems: 'center', justifyContent: 'center', gap: 6, height: h, padding: `0 ${padX}px`, fontSize: fs, fontWeight: 700, borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', transition: 'filter .15s', opacity: disabled ? 0.45 : 1, ...v, ...style }}>{icon}{children}</button>;
};

const TInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ style, onFocus, onBlur, ...rest }) => {
    const [f, setF] = useState(false);
    return <input {...rest} onFocus={e => { setF(true); onFocus?.(e); }} onBlur={e => { setF(false); onBlur?.(e); }}
        style={{ width: '100%', height: 38, padding: '0 12px', fontSize: 13.5, color: TH.text, background: TH.bg3, border: `1px solid ${f ? TH.gold : TH.line}`, borderRadius: 8, outline: 'none', transition: 'border-color .15s', ...style }} />;
};

const TSelect: React.FC<{ value: string; onChange: (v: string) => void; options: { key: string; label: string }[] }> = ({ value, onChange, options }) => {
    const [f, setF] = useState(false);
    return (
        <div style={{ position: 'relative', width: '100%' }}>
            <select value={value} onChange={e => onChange(e.target.value)} onFocus={() => setF(true)} onBlur={() => setF(false)}
                style={{ width: '100%', height: 38, padding: '0 32px 0 12px', fontSize: 13.5, fontWeight: 600, color: TH.text, background: TH.bg3, border: `1px solid ${f ? TH.gold : TH.line}`, borderRadius: 8, outline: 'none', appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', cursor: 'pointer' }}>
                {options.map(o => <option key={o.key} value={o.key} style={{ background: '#241319', color: TH.text }}>{o.label}</option>)}
            </select>
            <span style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: TH.goldSoft, fontSize: 10 }}>▾</span>
        </div>
    );
};

const TModal: React.FC<{ open: boolean; title?: React.ReactNode; width?: number; maskClosable?: boolean; footer?: React.ReactNode; onClose?: () => void; children?: React.ReactNode }> = ({ open, title, width = 360, maskClosable = true, footer, onClose, children }) => {
    if (!open) return null;
    return (
        <div onClick={() => maskClosable && onClose?.()} style={{ position: 'fixed', inset: 0, zIndex: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(10,4,7,.62)', backdropFilter: 'blur(4px)' }}>
            <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: width, position: 'relative', background: TH.bg2, color: TH.text, border: `1px solid ${TH.line}`, borderRadius: 14, boxShadow: '0 20px 50px rgba(0,0,0,.6)', padding: 18, paddingTop: title ? 28 : 18 }}>
                {title && <div style={{ position: 'absolute', top: -13, left: '50%', transform: 'translateX(-50%)', padding: '4px 20px', background: `linear-gradient(180deg,${TH.gold},#b98f4e)`, color: '#2a1810', fontWeight: 800, fontSize: 13.5, fontFamily: SERIF, borderRadius: 8, whiteSpace: 'nowrap', boxShadow: '0 3px 10px rgba(0,0,0,.4)' }}>{title}</div>}
                <div>{children}</div>
                {footer && <div style={{ marginTop: 16 }}>{footer}</div>}
            </div>
        </div>
    );
};

const taStyle: React.CSSProperties = { width: '100%', padding: '8px 12px', fontSize: 13.5, color: TH.text, background: TH.bg3, border: `1px solid ${TH.line}`, borderRadius: 8, outline: 'none', resize: 'vertical', lineHeight: 1.6 };
const cardStyle: React.CSSProperties = { background: TH.bg2, border: `1px solid ${TH.line}`, borderRadius: 12, padding: 10 };
const pgBtn = (disabled: boolean): React.CSSProperties => ({ height: 24, width: 24, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', color: TH.goldSoft, border: `1px solid ${TH.line}`, opacity: disabled ? 0.3 : 1, background: TH.bg3 });

/** 解析上传 txt 成剧本。 */
function parseUploadedScript(text: string, fallbackTitle: string): { title: string; logline: string; roles: VRPlayRole[]; body: string } {
    const grab = (label: string) => { const m = text.match(new RegExp(`${label}\\s*[:：]\\s*(.+)`)); return m ? m[1].trim() : ''; };
    const title = grab('标题') || fallbackTitle;
    const logline = grab('简介');
    const roles: VRPlayRole[] = [];
    const rb = text.match(/登场角色\s*[:：]?\s*\n([\s\S]*?)(?:\n\s*正文|\n\s*$)/);
    if (rb) for (const raw of rb[1].split('\n')) { const l = raw.replace(/^[-·•\s]+/, '').trim(); if (!l) continue; const [n, ...r] = l.split(/[|｜/／:：]/); if (n.trim()) roles.push({ name: n.trim(), persona: r.join('/').trim() }); }
    const bm = text.match(/正文\s*[:：]?\s*\n([\s\S]*)$/);
    return { title, logline, roles, body: (bm ? bm[1] : text).trim() };
}

type View = 'list' | 'script' | 'stage' | 'play';

const TheaterPanel: React.FC<{ addToast?: (m: string, t?: any) => void }> = ({ addToast }) => {
    const { characters, userProfile, groups, apiConfig } = useOS();
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const [tab, setTab] = useState<'scripts' | 'history'>('scripts');
    const [scripts, setScripts] = useState<VRScript[]>([]);
    const [plays, setPlays] = useState<VRStagedPlay[]>([]);
    const [view, setView] = useState<View>('list');
    const [cur, setCur] = useState<VRScript | null>(null);
    const [curPlay, setCurPlay] = useState<VRStagedPlay | null>(null);
    const [page, setPage] = useState(0);
    const [emojis, setEmojis] = useState<Emoji[]>([]);
    const [categories, setCategories] = useState<EmojiCategory[]>([]);
    const [writeOpen, setWriteOpen] = useState(false);
    const [llmOpen, setLlmOpen] = useState(false);

    const reload = useCallback(async () => { setScripts(await DB.getVRScripts()); setPlays(await DB.getVRStagedPlays()); }, []);
    useEffect(() => {
        void reload();
        void (async () => { setEmojis(await DB.getEmojis()); setCategories(await DB.getEmojiCategories()); })();
        const onDone = () => { void reload(); };
        window.addEventListener('vr-session-done', onDone);
        return () => window.removeEventListener('vr-session-done', onDone);
    }, [reload]);

    const ctx: TheaterCtx = useMemo(() => ({ characters, userProfile: userProfile!, groups, emojis, categories }), [characters, userProfile, groups, emojis, categories]);
    const PER = 6;
    const totalPages = Math.max(1, Math.ceil(scripts.length / PER));
    const shown = scripts.slice(page * PER, page * PER + PER);
    const playMode = view === 'play';

    return (
        <>
            <div className="absolute left-3 right-3 z-20 rounded-[14px] overflow-hidden flex flex-col"
                style={{ top: 'calc(var(--chrome-top) + 3.75rem)', bottom: 'calc(var(--safe-bottom) + 0.75rem)', background: TH.bg, border: `1px solid ${TH.line}`, color: TH.text, fontFamily: `'Nunito','Noto Sans SC',sans-serif`, boxShadow: '0 12px 34px rgba(0,0,0,.55)' }}>
                {/* 招牌（烫金衬线，正式） */}
                <div className="shrink-0" style={{ background: 'linear-gradient(180deg,#2c0f17,#1c0a10)', borderBottom: `1px solid ${TH.line}`, padding: '9px 12px' }}>
                    <div style={{ textAlign: 'center', fontWeight: 800, fontSize: 17, letterSpacing: '.42em', color: TH.gold, fontFamily: SERIF, textShadow: '0 1px 2px #000', paddingLeft: '.42em' }}>剧 场</div>
                    <div style={{ textAlign: 'center', fontSize: 8.5, letterSpacing: '.34em', color: TH.goldSoft, marginTop: 3 }}>· THÉÂTRE · 今 日 上 演 ·</div>
                </div>

                {!playMode && (
                    <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: `1px solid ${TH.line}` }}>
                        {(['scripts', 'history'] as const).map(t => {
                            const on = tab === t;
                            return <button key={t} onClick={() => { setTab(t); setView('list'); }}
                                style={{ fontSize: 12.5, fontWeight: 700, fontFamily: SERIF, padding: '3px 4px', color: on ? TH.gold : TH.sub, borderBottom: on ? `2px solid ${TH.gold}` : '2px solid transparent' }}>
                                {t === 'scripts' ? '剧本投稿' : '历史舞台剧'}
                            </button>;
                        })}
                        <span className="ml-auto" style={{ fontSize: 9, color: TH.sub }}>{tab === 'scripts' ? `${scripts.length} 份剧本` : `${plays.length} 场演出`}</span>
                    </div>
                )}

                <div className="flex-1 overflow-y-auto vr-reader-scroll" style={{ color: TH.text, padding: playMode ? 10 : 12 }}>
                    {/* ===== 剧本列表 ===== */}
                    {tab === 'scripts' && view === 'list' && (
                        <>
                            <div className="flex gap-2 mb-3 flex-wrap">
                                <TButton size="sm" variant="primary" icon={<Plus size={13} weight="bold" />} onClick={() => setWriteOpen(true)}>我来写</TButton>
                                <TButton size="sm" icon={<Sparkle size={13} weight="bold" />} onClick={() => setLlmOpen(true)}>AI 代写</TButton>
                                <UploadButton onParsed={async (p) => { const s: VRScript = { id: tid('scr'), ...p, authorId: 'user', authorName: userProfile?.name || '我', source: 'upload', createdAt: Date.now() }; await DB.saveVRScript(s); await reload(); addToast?.(`已收录《${s.title}》`, 'success'); }} />
                            </div>
                            {scripts.length === 0 ? (
                                <p style={{ fontSize: 12, color: TH.sub, textAlign: 'center', padding: '44px 0', lineHeight: 1.9 }}>戏单还空着。<br />让角色逛进剧院写一出，或你自己投一稿。</p>
                            ) : (
                                <div className="space-y-2">
                                    {shown.map(s => (
                                        <button key={s.id} onClick={() => { setCur(s); setView('script'); }} className="w-full text-left active:scale-[0.99] transition-transform" style={cardStyle}>
                                            <div className="flex items-center gap-1.5">
                                                <FilmSlate size={13} weight="fill" style={{ color: TH.gold }} className="shrink-0" />
                                                <span style={{ fontSize: 13, fontWeight: 800, color: TH.text, fontFamily: SERIF }} className="truncate">《{s.title}》</span>
                                                <span className="ml-auto shrink-0" style={{ fontSize: 9, color: TH.goldSoft }}>{s.authorName}</span>
                                            </div>
                                            {s.logline && <p style={{ fontSize: 11, color: TH.sub, marginTop: 3, lineHeight: 1.45 }} className="line-clamp-2">{s.logline}</p>}
                                            <p style={{ fontSize: 9, color: TH.sub, marginTop: 5, opacity: .8 }}>{s.roles.length} 个角色 · {new Date(s.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</p>
                                        </button>
                                    ))}
                                    {totalPages > 1 && (
                                        <div className="flex items-center justify-center gap-3 pt-1">
                                            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={pgBtn(page === 0)}><CaretLeft size={11} weight="bold" /></button>
                                            <span style={{ fontSize: 10, color: TH.sub }} className="tabular-nums">{page + 1}/{totalPages}</span>
                                            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pgBtn(page >= totalPages - 1)}><CaretRight size={11} weight="bold" /></button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}

                    {/* ===== 历史 ===== */}
                    {tab === 'history' && view === 'list' && (
                        plays.length === 0 ? (
                            <p style={{ fontSize: 12, color: TH.sub, textAlign: 'center', padding: '44px 0', lineHeight: 1.9 }}>还没有演出。<br />去剧本投稿里挑一本【编排】上演吧。</p>
                        ) : (
                            <div className="space-y-2">
                                {plays.map(p => (
                                    <button key={p.id} onClick={() => { setCurPlay(p); setView('play'); }} className="w-full text-left active:scale-[0.99] transition-transform" style={cardStyle}>
                                        <div className="flex items-center gap-1.5">
                                            <span style={{ fontSize: 13, fontWeight: 800, color: TH.text, fontFamily: SERIF }} className="truncate">《{p.title}》</span>
                                            <span className="ml-auto shrink-0" style={{ fontSize: 11, fontWeight: 800, color: TH.warn }}>{p.rating?.split(/\s/)[0]}</span>
                                        </div>
                                        <p style={{ fontSize: 10, color: TH.sub, marginTop: 3 }}>{p.cast.map(c => c.actorName).join('、')}</p>
                                    </button>
                                ))}
                            </div>
                        )
                    )}

                    {view === 'script' && cur && <ScriptView script={cur} onBack={() => setView('list')} onStage={() => setView('stage')} onDelete={async () => { const target = cur; const ok = await requestConfirm({ title: `删除剧本《${target.title}》？`, message: '删除后无法恢复（已上演的历史舞台剧演出会保留）。', confirmText: '确认删除', variant: 'danger' }); if (!ok) return; await DB.deleteVRScript(target.id); await reload(); setView('list'); addToast?.('已删除', 'success'); }} />}
                    {view === 'stage' && cur && <StageView script={cur} ctx={ctx} apiConfig={apiConfig} addToast={addToast} onBack={() => setView('list')} onPolished={(body) => setCur({ ...cur, body })} onStaged={async (play) => { await DB.saveVRStagedPlay(play); await reload(); setCurPlay(play); setView('play'); }} />}
                    {view === 'play' && curPlay && <PlaybackView play={curPlay} characters={characters} onBack={() => { setView('list'); setTab('history'); }} onDelete={async () => { await DB.deleteVRStagedPlay(curPlay.id); await reload(); setView('list'); setTab('history'); addToast?.('已删除这场演出', 'success'); }} />}
                </div>
            </div>

            <WriteScriptModal open={writeOpen} onClose={() => setWriteOpen(false)} onSave={async (p) => { const s: VRScript = { id: tid('scr'), ...p, authorId: 'user', authorName: userProfile?.name || '我', source: 'user', createdAt: Date.now() }; await DB.saveVRScript(s); await reload(); setWriteOpen(false); addToast?.(`已投稿《${s.title}》`, 'success'); }} />
            <LLMScriptModal open={llmOpen} onClose={() => setLlmOpen(false)} apiConfig={apiConfig} addToast={addToast} onSaved={async () => { await reload(); setLlmOpen(false); }} />
            {confirmDialog}
        </>
    );
};

// ============ 看剧本 ============
const ScriptView: React.FC<{ script: VRScript; onBack: () => void; onStage: () => void; onDelete: () => void }> = ({ script, onBack, onStage, onDelete }) => (
    <div>
        <div className="flex items-center gap-2 mb-2">
            <button onClick={onBack} style={{ color: TH.goldSoft, padding: 4, marginLeft: -4 }}><CaretLeft size={18} /></button>
            <span style={{ fontSize: 14, fontWeight: 800, color: TH.text, fontFamily: SERIF }} className="truncate">《{script.title}》</span>
            <button onClick={onDelete} style={{ marginLeft: 'auto', color: TH.crimson, padding: 4, opacity: .8 }}><Trash size={15} /></button>
        </div>
        {script.logline && <p style={{ fontSize: 11.5, color: TH.sub, marginBottom: 8, fontStyle: 'italic' }}>{script.logline}</p>}
        <div style={{ fontSize: 10.5, color: TH.goldSoft, marginBottom: 8 }}>登场：{script.roles.map(r => `${r.name}（${r.persona}）`).join('、') || '—'}</div>
        <pre style={{ fontSize: 12, color: TH.text, whiteSpace: 'pre-wrap', lineHeight: 1.75, borderRadius: 10, padding: 12, marginBottom: 12, background: TH.bg2, border: `1px solid ${TH.line}`, fontFamily: SERIF }}>{script.body}</pre>
        <TButton variant="primary" block icon={<FilmSlate size={14} weight="fill" />} onClick={onStage}>编排这出戏</TButton>
    </div>
);

// ============ 编排 ============
const StageView: React.FC<{ script: VRScript; ctx: TheaterCtx; apiConfig: any; addToast?: (m: string, t?: any) => void; onBack: () => void; onPolished: (body: string) => void; onStaged: (play: VRStagedPlay) => void }> = ({ script, ctx, apiConfig, addToast, onBack, onPolished, onStaged }) => {
    const [step, setStep] = useState<'cast' | 'notes'>('cast');
    const [assign, setAssign] = useState<Record<string, VRCastAssign>>({});
    const [mode, setMode] = useState<VRStageMode>('per-role');
    const [busy, setBusy] = useState('');
    const [notes, setNotes] = useState<VRActorNote[]>([]);
    const [polishOpen, setPolishOpen] = useState(false);
    const [rolling, setRolling] = useState('');
    const [npcEdit, setNpcEdit] = useState<{ roleName: string } | null>(null);
    const [userReq, setUserReq] = useState('');

    const charOpts = useMemo(() => [{ key: '', label: '— 选演员 —' }, ...ctx.characters.map(c => ({ key: c.id, label: c.name }))], [ctx.characters]);
    const cast = useMemo(() => script.roles.map(r => assign[r.name]).filter(Boolean) as VRCastAssign[], [assign, script.roles]);
    const allCast = cast.length === script.roles.length && script.roles.length > 0;
    const charCount = charActorCount(cast);

    const setChar = (role: VRPlayRole, charId: string) => {
        if (!charId) { setAssign(a => { const n = { ...a }; delete n[role.name]; return n; }); return; }
        const ch = ctx.characters.find(c => c.id === charId);
        if (ch) setAssign(a => ({ ...a, [role.name]: { roleName: role.name, actorId: ch.id, actorName: ch.name, isNpc: false } }));
    };
    /** roll 一个 NPC 立绘。keepName=true 时沿用当前名字（重 roll 用）。 */
    const rollNpc = async (role: VRPlayRole, keepName = false) => {
        setRolling(role.name);
        const existing = assign[role.name];
        const name = keepName && existing?.actorName ? existing.actorName : randomNpcName(Object.values(assign).map(c => c.actorName));
        const npc = await rollNpcChibi();
        setAssign(a => ({ ...a, [role.name]: { roleName: role.name, actorId: existing?.isNpc ? existing.actorId : tid('npc'), actorName: name, isNpc: true, npcChibi: npc?.img } }));
        setRolling('');
        addToast?.(npc ? `捏了个 NPC：${name}` : `NPC ${name}（立绘没出来，用占位）`, npc ? 'success' : 'error');
    };
    /** 打开捏脸器手动捏这个角色的 NPC（不满意 roll 就进去自己捏）。 */
    const openNpcEdit = (role: VRPlayRole) => {
        setAssign(a => {
            if (a[role.name]?.isNpc) return a;
            const name = randomNpcName(Object.values(a).map(c => c.actorName));
            return { ...a, [role.name]: { roleName: role.name, actorId: tid('npc'), actorName: name, isNpc: true } };
        });
        setNpcEdit({ roleName: role.name });
    };
    const applyNpcChibi = (roleName: string, img: string) => setAssign(a => a[roleName] ? { ...a, [roleName]: { ...a[roleName], npcChibi: img } } : a);

    const runStaging = async () => {
        const api = await resolveTheaterApi(apiConfig);
        if (!api) { addToast?.('没配 API，去「API」标签填一下', 'error'); return; }
        setBusy(mode === 'two-call' ? '演员们在读剧本（固定生成2段）…' : `${charCount} 位演员在各自读剧本…`);
        try {
            const result = await collectActorNotes(script, cast, mode, ctx, api);
            setNotes(result); setStep('notes');
            for (const n of result) {
                if (n.actorId.startsWith('npc')) continue;
                const act = !n.cooperative ? `对舞台剧《${script.title}》有点抵触，觉得：${n.note}` : n.lines ? `把自己在《${script.title}》里的戏份改成了自己的演法，觉得：${n.note}` : `读了舞台剧《${script.title}》，觉得：${n.note}`;
                await DB.saveMessage({ charId: n.actorId, role: 'assistant', type: 'vr_card', content: `「彼方 · 剧院」${n.actorName}${act}`, metadata: { vrCard: true, room: 'theater', activity: act, behavior: n.lines } } as any);
            }
        } catch (e: any) { addToast?.('编排失败：' + (e?.message || '检查网络/API'), 'error'); }
        finally { setBusy(''); }
    };

    const summonDirector = async () => {
        const api = await resolveTheaterApi(apiConfig);
        if (!api) { addToast?.('没配 API', 'error'); return; }
        setBusy('导演在整合最终本…');
        try {
            const d = await runDirector(script, cast, notes, ctx, api, userReq.trim() || undefined);
            const play: VRStagedPlay = { id: tid('play'), scriptId: script.id, title: script.title, logline: script.logline, cast, notes, stage: d.stage, reviews: d.reviews, rating: d.rating, createdAt: Date.now() };
            const castNames = cast.map(c => c.actorName).join('、');
            for (const c of cast) { if (c.isNpc) continue; const act = `参演的舞台剧《${script.title}》落幕了（演员：${castNames}）。综评 ${d.rating}`; await DB.saveMessage({ charId: c.actorId, role: 'assistant', type: 'vr_card', content: `「彼方 · 剧院」${act}`, metadata: { vrCard: true, room: 'theater', activity: act } } as any); }
            onStaged(play);
        } catch (e: any) { addToast?.('导演罢工了：' + (e?.message || '检查网络/API'), 'error'); }
        finally { setBusy(''); }
    };

    if (busy) return (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
            <div className="inline-block animate-spin rounded-full" style={{ height: 28, width: 28, border: `3px solid ${TH.line}`, borderTopColor: TH.gold, marginBottom: 12 }} />
            <p style={{ fontSize: 12, color: TH.sub }}>{busy}</p>
        </div>
    );

    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                <button onClick={onBack} style={{ color: TH.goldSoft, padding: 4, marginLeft: -4 }}><CaretLeft size={18} /></button>
                <span style={{ fontSize: 14, fontWeight: 800, color: TH.text, fontFamily: SERIF }} className="truncate">编排《{script.title}》</span>
            </div>

            {step === 'cast' && (
                <>
                    <div className="flex items-center justify-between mb-2">
                        <span style={{ fontSize: 11, letterSpacing: '.12em', color: TH.goldSoft, fontFamily: SERIF }}>选 角</span>
                        <TButton size="sm" icon={<Sparkle size={12} />} onClick={() => setPolishOpen(true)}>润色剧本</TButton>
                    </div>
                    <div className="space-y-2 mb-3">
                        {script.roles.map(r => {
                            const a = assign[r.name];
                            return (
                                <div key={r.name} style={cardStyle}>
                                    <div style={{ fontSize: 11.5, fontWeight: 800, color: TH.text }}>{r.name} <span style={{ fontSize: 9, fontWeight: 400, color: TH.sub }}>{r.persona}</span></div>
                                    {a?.isNpc ? (
                                        <div className="flex items-center gap-2" style={{ marginTop: 6 }}>
                                            {a.npcChibi ? <TokenImg value={a.npcChibi} style={{ height: 34, objectFit: 'contain' }} alt="" /> : <div style={{ height: 30, width: 30, borderRadius: 999, background: TH.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: TH.gold }}>{a.actorName.slice(0, 1)}</div>}
                                            <span style={{ fontSize: 11.5, color: TH.text }}>{a.actorName} <span style={{ fontSize: 8.5, color: TH.gold }}>NPC</span></span>
                                            <div className="ml-auto flex items-center gap-1">
                                                <TButton size="sm" disabled={!!rolling} onClick={() => rollNpc(r, true)} title="换一个">{rolling === r.name ? '🎲…' : '🎲'}</TButton>
                                                <TButton size="sm" onClick={() => setNpcEdit({ roleName: r.name })} title="进去自己捏">✏️捏</TButton>
                                                <button onClick={() => setChar(r, '')} style={{ color: TH.sub, padding: 4 }}><X size={14} /></button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-1.5" style={{ marginTop: 6 }}>
                                            <div className="flex-1"><TSelect value={a?.actorId || ''} onChange={(v) => setChar(r, v)} options={charOpts} /></div>
                                            <TButton size="sm" disabled={!!rolling} onClick={() => rollNpc(r)}>{rolling === r.name ? '🎲…' : '🎲NPC'}</TButton>
                                            <TButton size="sm" onClick={() => openNpcEdit(r)} title="进去自己捏一个">✏️</TButton>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <div style={{ fontSize: 11, letterSpacing: '.12em', color: TH.goldSoft, fontFamily: SERIF, marginBottom: 6 }}>表演方式</div>
                    <div className="grid grid-cols-2 gap-2 mb-2">
                        {([['per-role', '逐角色', '每位角色各生成一段（精准、贴人设）'], ['two-call', '固定两次', '1 次搞定全部演员（省，但可能 OOC）']] as const).map(([m, t, d]) => {
                            const on = mode === m;
                            return <button key={m} onClick={() => setMode(m)} style={{ borderRadius: 12, padding: 10, textAlign: 'left', background: on ? 'rgba(216,178,113,.12)' : TH.bg2, border: `1px solid ${on ? TH.gold : TH.line}` }}>
                                <div style={{ fontSize: 11.5, fontWeight: 800, color: on ? TH.gold : TH.text }}>{t}</div>
                                <div style={{ fontSize: 9, color: TH.sub, lineHeight: 1.45, marginTop: 3 }}>{d}</div>
                            </button>;
                        })}
                    </div>
                    <p style={{ fontSize: 9.5, color: TH.sub, marginBottom: 8, textAlign: 'center' }}>本次大约要生成 <b style={{ color: TH.gold }}>{mode === 'two-call' ? (charCount > 0 ? 2 : 1) : charCount + 1}</b> 段{mode === 'per-role' ? `（${charCount} 角色 + 1 导演；NPC 不计）` : '（演员 1 段 + 导演 1 段）'}</p>
                    <TButton variant="primary" block disabled={!allCast} onClick={runStaging}>{allCast ? '开始编排 →' : '先给每个角色选演员'}</TButton>
                </>
            )}

            {step === 'notes' && (
                <>
                    <div style={{ fontSize: 11, letterSpacing: '.12em', color: TH.goldSoft, fontFamily: SERIF, marginBottom: 8 }}>演员就位 · 各自的演法</div>
                    <div className="space-y-2 mb-3">{notes.map((n, i) => <ActorNoteCard key={i} note={n} cast={cast} characters={ctx.characters} />)}</div>
                    <div style={{ ...cardStyle, marginBottom: 12 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: TH.gold, marginBottom: 4 }}>🎬 你想看的（导演必须满足 · 最高优先级）</div>
                        <div style={{ fontSize: 9.5, color: TH.sub, marginBottom: 6, lineHeight: 1.5 }}>写下你一定要看到的情节/名场面/台词。导演不能删，演员若不情愿也只会棒读/敷衍，但照样得演。</div>
                        <textarea value={userReq} onChange={e => setUserReq(e.target.value)} rows={2} placeholder="可空。例：必须有一段两人对跳的舞 / 一定要让 XX 说出那句台词" style={taStyle} />
                    </div>
                    <TButton variant="primary" block icon={<FilmSlate size={14} weight="fill" />} onClick={summonDirector}>召唤导演 · 整合最终本</TButton>
                </>
            )}

            <PolishModal open={polishOpen} onClose={() => setPolishOpen(false)} apiConfig={apiConfig} body={script.body} addToast={addToast} onPolished={(body) => { onPolished(body); setPolishOpen(false); addToast?.('润色好啦', 'success'); }} />

            {/* NPC 捏脸器：roll 得不满意就进来自己捏 */}
            {npcEdit && (() => {
                const a = assign[npcEdit.roleName];
                return (
                    <div style={{ position: 'fixed', inset: 0, zIndex: 330, background: '#180810', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${TH.line}`, color: TH.text, paddingTop: 'calc(var(--chrome-top) + 4px)' }}>
                            <span style={{ fontWeight: 800, fontFamily: SERIF, fontSize: 14, color: TH.gold }}>捏个群演 · {a?.actorName || 'NPC'}</span>
                            <button onClick={() => setNpcEdit(null)} style={{ marginLeft: 'auto', color: TH.goldSoft, padding: 4 }}><X size={20} /></button>
                        </div>
                        <div style={{ flex: 1, minHeight: 0 }}>
                            <CreatorIframe mode="char" charName={a?.actorName || 'NPC'} draftKey={`theater_npc_${script.id}_${npcEdit.roleName}`} title="捏个群演" subtitle="THEATER NPC"
                                onConfirm={(res) => { applyNpcChibi(npcEdit.roleName, res.transparentDataUrl); setNpcEdit(null); addToast?.('NPC 形象已更新', 'success'); }} />
                        </div>
                    </div>
                );
            })()}
        </div>
    );
};

const ActorNoteCard: React.FC<{ note: VRActorNote; cast: VRCastAssign[]; characters: CharacterProfile[] }> = ({ note, cast, characters }) => {
    const [open, setOpen] = useState(false);
    const assign = cast.find(c => c.actorId === note.actorId);
    const ch = characters.find(c => c.id === note.actorId);
    const img = assign?.npcChibi || (ch ? getChibi(ch).img : undefined);
    const att = note.attitude || (note.cooperative ? '配合' : '抵触');
    const attColor = ['抵触', '拒演'].some(k => att.includes(k)) ? TH.crimson : ['勉强', '隐忍'].some(k => att.includes(k)) ? TH.warn : '#86c98a';
    return (
        <button onClick={() => setOpen(o => !o)} className="w-full text-left" style={{ ...cardStyle, border: `1px solid ${note.cooperative ? TH.line : 'rgba(185,56,74,.6)'}` }}>
            <div className="flex items-center gap-2">
                {img ? <TokenImg value={img} style={{ height: 30, width: 30, objectFit: 'contain' }} alt="" /> : <div style={{ height: 28, width: 28, borderRadius: 999, background: TH.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: TH.gold }}>{note.actorName.slice(0, 1)}</div>}
                <span style={{ fontSize: 11.5, fontWeight: 800, color: TH.text }}>{note.actorName}</span>
                <span style={{ fontSize: 8.5, color: TH.sub }}>饰 {note.roleName}</span>
                <span className="ml-auto" style={{ fontSize: 9.5, fontWeight: 800, color: attColor, border: `1px solid ${attColor}`, borderRadius: 999, padding: '1px 8px' }}>{att}</span>
            </div>
            <p style={{ fontSize: 11, color: TH.text, marginTop: 4, lineHeight: 1.45 }}>{note.note}</p>
            {note.taboo && <p style={{ fontSize: 9.5, color: TH.crimson, marginTop: 3, lineHeight: 1.45 }}>⛔ 禁忌：{note.taboo}</p>}
            {(note.lines || note.direction) && <p style={{ fontSize: 9, color: TH.goldSoft, marginTop: 3 }}>{open ? '▾ 收起' : '▸ 点开看 ta 重写的戏份 / 给导演的话'}</p>}
            {open && note.lines && <pre style={{ fontSize: 10.5, color: TH.text, marginTop: 4, padding: 8, background: TH.bg3, borderRadius: 8, borderLeft: `2px solid ${TH.gold}`, lineHeight: 1.5, whiteSpace: 'pre-wrap', fontFamily: SERIF }}>{note.lines}</pre>}
            {open && note.direction && <p style={{ fontSize: 10, color: TH.goldSoft, marginTop: 4, paddingLeft: 8, borderLeft: `2px solid ${TH.line}`, lineHeight: 1.45 }}>🎬 给导演：{note.direction}</p>}
        </button>
    );
};

// ============ 演出回放（大舞台 · chibi 蹦跶） ============
const PlaybackView: React.FC<{ play: VRStagedPlay; characters: CharacterProfile[]; onBack: () => void; onDelete: () => void }> = ({ play, characters, onBack, onDelete }) => {
    const [i, setI] = useState(0);
    const [showScript, setShowScript] = useState(false);
    const [confirmDel, setConfirmDel] = useState(false);
    const beats = play.stage;
    const ended = i >= beats.length;

    // 名字→选角：演员名和角色名都映射到同一个 assign，
    // 这样导演终本里无论写"演员名"还是"角色名"，回放都能找回该演员的 chibi。
    const assignByName = useMemo(() => {
        const m = new Map<string, VRCastAssign>();
        for (const c of play.cast) { m.set(c.actorName, c); m.set(c.roleName, c); }
        return m;
    }, [play.cast]);
    /** 任意名字 → 该演员的展示名（统一成演员名，便于站位去重/高亮） */
    const canon = (name?: string): string => (name && assignByName.get(name)?.actorName) || name || '';
    /** 任意名字 → 台上显示的名字（剧本里演的角色名；找不到就原样） */
    const displayName = (name?: string): string => (name && assignByName.get(name)?.roleName) || name || '';

    const onStage = useMemo(() => {
        const s = new Set<string>();
        for (let k = 0; k <= Math.min(i, beats.length - 1); k++) { const b = beats[k]; if (b.kind === 'enter' && b.actorName) s.add(canon(b.actorName)); if (b.kind === 'exit' && b.actorName) s.delete(canon(b.actorName)); }
        if (s.size === 0) play.cast.forEach(c => s.add(c.actorName));
        return s;
    }, [i, beats, play.cast]);

    const chibiOf = (name: string): { img?: string; scale: number; offsetY: number; flip: boolean } => {
        const a = assignByName.get(name);
        if (a?.npcChibi) return { img: a.npcChibi, scale: 1, offsetY: 0, flip: false };
        const ch = characters.find(c => c.id === a?.actorId);
        if (ch) { const d = getChibi(ch); return { img: d.img || undefined, scale: d.scale, offsetY: d.offsetY, flip: d.flip }; }
        return { scale: 1, offsetY: 0, flip: false };
    };

    const beat = beats[Math.min(i, beats.length - 1)];
    const speaker = beat?.kind === 'line' ? canon(beat.actorName) : undefined;
    const stageArr = [...onStage];

    return (
        <div>
            <style>{`@keyframes thHop{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}@keyframes thHopA{0%,100%{transform:translateY(0)}28%{transform:translateY(-18px)}55%{transform:translateY(-3px)}}@keyframes thFoot{0%,100%{opacity:.5}50%{opacity:1}}`}</style>
            <div className="flex items-center gap-2 mb-2">
                <button onClick={onBack} style={{ color: TH.goldSoft, padding: 4, marginLeft: -4 }}><CaretLeft size={18} /></button>
                <span style={{ fontSize: 14, fontWeight: 800, color: TH.text, fontFamily: SERIF }} className="truncate">《{play.title}》</span>
                <span className="ml-auto" style={{ fontSize: 11, fontWeight: 800, color: TH.warn }}>{play.rating?.split(/\s/)[0]}</span>
                <button onClick={() => setShowScript(s => !s)} title="看终本" style={{ color: showScript ? TH.gold : TH.goldSoft, padding: 4, fontSize: 16 }}>📜</button>
                <button onClick={() => setConfirmDel(true)} title="删除这场演出" style={{ color: TH.crimson, padding: 4, opacity: .8 }}><Trash size={15} /></button>
            </div>

            {/* 终本（导演整合后的最终剧本，可读文本） */}
            {showScript && (
                <pre style={{ fontSize: 11.5, color: TH.text, whiteSpace: 'pre-wrap', lineHeight: 1.8, borderRadius: 10, padding: 12, marginBottom: 12, background: TH.bg2, border: `1px solid ${TH.line}`, fontFamily: SERIF, maxHeight: '52vh', overflowY: 'auto' }}>
                    {beats.map((b, k) =>
                        b.kind === 'narration' ? `（${b.text}）`
                        : b.kind === 'enter' ? `——${displayName(b.actorName)} 上场——`
                        : b.kind === 'exit' ? `——${displayName(b.actorName)} 下场——`
                        : `${displayName(b.actorName)}：${b.text}`
                    ).join('\n')}
                </pre>
            )}

            {/* 删除确认 */}
            {confirmDel && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 340, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(10,4,7,.62)' }} onClick={() => setConfirmDel(false)}>
                    <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 300, background: TH.bg2, border: `1px solid ${TH.line}`, borderRadius: 14, padding: 16, color: TH.text, textAlign: 'center' }}>
                        <div style={{ fontSize: 13, fontFamily: SERIF, marginBottom: 14 }}>删除这场《{play.title}》？</div>
                        <div className="flex gap-2">
                            <TButton block onClick={() => setConfirmDel(false)}>取消</TButton>
                            <TButton block variant="primary" onClick={() => { setConfirmDel(false); onDelete(); }}>删除</TButton>
                        </div>
                    </div>
                </div>
            )}

            {/* 大舞台 */}
            <div style={{ height: 'min(58vh, 460px)', borderRadius: 12, position: 'relative', overflow: 'hidden', marginBottom: 12, background: 'radial-gradient(120% 80% at 50% 0%, #4a1018 0%, #2a0a10 45%, #140406 100%)', border: `1px solid ${TH.line}`, boxShadow: 'inset 0 0 60px rgba(0,0,0,.6)' }}>
                {/* 顶部檐幕 + 金穗 */}
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 30, background: 'linear-gradient(180deg,#8a1224,#5e0d18)', boxShadow: '0 3px 10px rgba(0,0,0,.5)' }} />
                <div style={{ position: 'absolute', top: 28, left: 0, right: 0, height: 8, background: `repeating-linear-gradient(90deg, ${TH.gold} 0 3px, transparent 3px 12px)`, opacity: .65 }} />
                {/* 两侧垂幕 + 束带 */}
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '15%', background: 'linear-gradient(90deg,#7a0e1c,#4a0810 70%,transparent)' }} />
                <div style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: '15%', background: 'linear-gradient(270deg,#7a0e1c,#4a0810 70%,transparent)' }} />
                {/* 顶光束 */}
                <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: 18, width: '70%', height: '85%', background: 'radial-gradient(ellipse at 50% 0%, rgba(255,228,160,.22), transparent 68%)', pointerEvents: 'none' }} />

                {/* 台词 / 旁白 */}
                {!ended && beat && (
                    <div style={{ position: 'absolute', left: 16, right: 16, top: 44, zIndex: 10 }}>
                        {beat.kind === 'narration' ? (
                            <div style={{ textAlign: 'center', fontSize: 11.5, color: 'rgba(255,236,206,.9)', fontStyle: 'italic', fontFamily: SERIF, padding: '7px 14px', borderRadius: 10, background: 'rgba(0,0,0,.45)', border: `1px solid ${TH.line}` }}>（{beat.text}）</div>
                        ) : beat.kind === 'line' ? (
                            // ★ 唯一保留动森奶油气泡的地方
                            <div style={{ margin: '0 auto', width: 'fit-content', maxWidth: '90%', padding: '10px 15px', borderRadius: 18, fontSize: 13.5, color: '#3a2a20', fontWeight: 600, background: '#fff7ea', border: '2px solid #e8dcc0', boxShadow: '0 4px 0 rgba(0,0,0,.35)' }}>
                                <span style={{ fontSize: 10, color: '#b9384a', fontWeight: 800, display: 'block', marginBottom: 1 }}>{displayName(beat.actorName)}</span>{beat.text}
                            </div>
                        ) : (
                            <div style={{ textAlign: 'center', fontSize: 10, color: 'rgba(255,210,210,.6)' }}>（{displayName(beat.actorName)} {beat.kind === 'enter' ? '上场' : '下场'}）</div>
                        )}
                    </div>
                )}

                {/* 演员（大、有纵深、蹦跶） */}
                <div style={{ position: 'absolute', bottom: 26, left: 0, right: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 14, padding: '0 22px' }}>
                    {stageArr.map((name, idx) => {
                        const c = chibiOf(name);
                        const active = name === speaker;
                        const depth = idx % 2 === 0 ? 0 : -10; // 奇偶错落出纵深
                        const baseH = active ? 168 : 138;
                        return (
                            <div key={name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: `translateY(${depth}px)`, animation: active ? 'thHopA .62s ease-in-out infinite' : `thHop 1.9s ${idx * .28}s ease-in-out infinite`, opacity: active || !speaker ? 1 : 0.5, transition: 'opacity .2s', zIndex: active ? 5 : 1 }}>
                                {c.img ? (
                                    <TokenImg value={c.img} alt="" style={{ height: baseH, transform: `scaleX(${c.flip ? -1 : 1}) translateY(${c.offsetY}px)`, objectFit: 'contain', filter: active ? 'drop-shadow(0 0 12px rgba(255,214,130,.75))' : 'drop-shadow(0 6px 6px rgba(0,0,0,.5))' }} />
                                ) : (
                                    <div style={{ height: 64, width: 64, borderRadius: 999, background: TH.gold, color: '#2a1810', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 800 }}>{displayName(name).slice(0, 1)}</div>
                                )}
                                <span style={{ fontSize: 8.5, color: 'rgba(255,245,235,.9)', marginTop: 3, background: 'rgba(0,0,0,.4)', padding: '1px 7px', borderRadius: 999 }}>{displayName(name)}</span>
                            </div>
                        );
                    })}
                </div>

                {/* 脚灯 */}
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 22, background: 'linear-gradient(180deg,transparent,#1a0608)', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-around', padding: '0 14px 4px' }}>
                    {Array.from({ length: 11 }).map((_, k) => (
                        <span key={k} style={{ width: 7, height: 7, borderRadius: 999, background: 'radial-gradient(circle,#ffe6a0,#d8a23e)', boxShadow: '0 0 7px 2px rgba(255,210,120,.55)', animation: `thFoot 1.6s ${k * .12}s ease-in-out infinite` }} />
                    ))}
                </div>
            </div>

            {!ended ? (
                <div className="flex items-center gap-2">
                    <span style={{ fontSize: 9.5, color: TH.sub }} className="tabular-nums">{Math.min(i + 1, beats.length)}/{beats.length}</span>
                    <div className="ml-auto flex gap-2">
                        {i > 0 && <TButton size="sm" onClick={() => setI(x => Math.max(0, x - 1))}>上一拍</TButton>}
                        <TButton size="sm" variant="primary" icon={<Play size={12} weight="fill" />} onClick={() => setI(x => x + 1)}>下一拍</TButton>
                    </div>
                </div>
            ) : (
                <div>
                    <div style={{ fontSize: 11, letterSpacing: '.12em', color: TH.goldSoft, fontFamily: SERIF, marginBottom: 6 }}>谢幕 · 观众席</div>
                    <div className="space-y-1.5 mb-2">
                        {play.reviews.map((r, k) => (
                            <div key={k} style={{ borderRadius: 10, padding: 9, fontSize: 11, background: TH.bg2, border: `1px solid ${TH.line}` }}>
                                <b style={{ color: TH.gold }}>{r.critic}</b><span style={{ color: TH.text }}>：{r.text}</span>
                            </div>
                        ))}
                    </div>
                    <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 800, color: TH.warn, fontFamily: SERIF, marginBottom: 12 }}>综合评级：{play.rating}</div>
                    <div className="flex gap-2">
                        <TButton block onClick={() => setI(0)}>重看一遍</TButton>
                        <TButton block variant="primary" onClick={onBack}>收工</TButton>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============ 风格 chips（润色 & 代写共用） ============
// 写作风格预设选择器（像酒馆预设，选一个就给 LLM 灌一整套写作风格档案）。
// 自带"自定义预设"的增删，自管理 customPresets，并通过 'vr-presets-changed' 事件互相同步。
// onChange 同时把选中预设的完整 prompt 抛给父组件（含自定义的）。
const PresetChips: React.FC<{ value: string; onChange: (key: string, prompt: string) => void }> = ({ value, onChange }) => {
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const [custom, setCustom] = useState<WritingPreset[]>([]);
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(''); const [prompt, setPrompt] = useState('');
    const load = useCallback(async () => setCustom(await DB.getVRPresets()), []);
    useEffect(() => {
        void load();
        const h = () => { void load(); };
        window.addEventListener('vr-presets-changed', h);
        return () => window.removeEventListener('vr-presets-changed', h);
    }, [load]);

    const all = useMemo(() => [...WRITING_PRESETS, ...custom], [custom]);
    const sel = all.find(p => p.key === value);

    const save = async () => {
        if (!name.trim() || !prompt.trim()) return;
        await DB.saveVRPreset({ key: tid('preset'), name: name.trim(), prompt: prompt.trim() });
        setEditing(false); setName(''); setPrompt('');
        await load(); window.dispatchEvent(new CustomEvent('vr-presets-changed'));
    };
    const del = async (preset: WritingPreset) => {
        const ok = await requestConfirm({
            title: `删除风格预设「${preset.name}」？`,
            message: '删除后无法恢复。',
            confirmText: '确认删除',
            variant: 'danger',
        });
        if (!ok) return;
        await DB.deleteVRPreset(preset.key);
        if (value === preset.key) onChange('', '');
        await load(); window.dispatchEvent(new CustomEvent('vr-presets-changed'));
    };

    return (
        <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: TH.text }}>写作风格预设 <span style={{ fontSize: 9.5, fontWeight: 400, color: TH.sub }}>选一个，灌一整套腔调/节拍/味道</span></div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {all.map(p => {
                    const on = value === p.key;
                    const isCustom = p.key.startsWith('preset_');
                    return (
                        <span key={p.key} onClick={() => onChange(on ? '' : p.key, on ? '' : p.prompt)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 999, fontSize: 11, cursor: 'pointer', border: `1px solid ${on ? TH.gold : TH.line}`, background: on ? 'rgba(216,178,113,.16)' : TH.bg3, color: on ? TH.gold : TH.sub }}>
                            {p.name}{isCustom && <span style={{ fontSize: 8.5, opacity: .6 }}>·我的</span>}
                            {isCustom && <span onClick={(e) => { e.stopPropagation(); void del(p); }} style={{ marginLeft: 1, fontSize: 12, lineHeight: 1, color: TH.crimson }}>×</span>}
                        </span>
                    );
                })}
                <span onClick={() => setEditing(true)} style={{ padding: '4px 10px', borderRadius: 999, fontSize: 11, cursor: 'pointer', border: `1px dashed ${TH.line}`, background: 'transparent', color: TH.goldSoft }}>＋ 自定义</span>
            </div>
            {sel?.blurb && <div style={{ fontSize: 10, color: TH.sub, marginTop: 6, lineHeight: 1.5, fontStyle: 'italic', paddingLeft: 2, borderLeft: `2px solid ${TH.line}` }}> {sel.blurb}</div>}

            {editing && (
                <TModal open title="自定义预设" width={360} onClose={() => setEditing(false)}
                    footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><TButton onClick={() => setEditing(false)}>取消</TButton><TButton variant="primary" onClick={save}>保存</TButton></div>}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <TInput value={name} onChange={e => setName(e.target.value)} placeholder="预设名（如：废土朋克、宫斗权谋…）" />
                        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={8} placeholder={'整套写作风格档案，越具体越好：\n一句话坐标 / 味道 / 怎么写怎么说 / 对白引擎 / 道具意象 / 节拍…\n（可参考内置预设的写法）'} style={taStyle} />
                    </div>
                </TModal>
            )}
            <div style={{ display: 'contents' }} onClick={e => e.stopPropagation()}>{confirmDialog}</div>
        </div>
    );
};

// ============ 弹窗：我来写 ============
const WriteScriptModal: React.FC<{ open: boolean; onClose: () => void; onSave: (p: { title: string; logline: string; roles: VRPlayRole[]; body: string }) => void }> = ({ open, onClose, onSave }) => {
    const [title, setTitle] = useState(''); const [logline, setLogline] = useState(''); const [rolesText, setRolesText] = useState(''); const [body, setBody] = useState('');
    const submit = () => {
        const roles = rolesText.split('\n').map(l => l.replace(/^[-·•\s]+/, '').trim()).filter(Boolean).map(l => { const [n, ...r] = l.split(/[|｜/／:：]/); return { name: (n || '').trim(), persona: r.join('/').trim() }; }).filter(r => r.name);
        if (!title.trim() || !body.trim()) return;
        onSave({ title: title.trim(), logline: logline.trim(), roles, body: body.trim() });
        setTitle(''); setLogline(''); setRolesText(''); setBody('');
    };
    return (
        <TModal open={open} title="我来写一出" width={360} onClose={onClose} footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><TButton onClick={onClose}>取消</TButton><TButton variant="primary" onClick={submit}>投稿</TButton></div>}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '52vh', overflowY: 'auto' }}>
                <TInput value={title} onChange={e => setTitle(e.target.value)} placeholder="剧名" />
                <TInput value={logline} onChange={e => setLogline(e.target.value)} placeholder="一句话简介（可空）" />
                <textarea value={rolesText} onChange={e => setRolesText(e.target.value)} rows={2} placeholder="登场角色，每行一个：角色名|性格" style={taStyle} />
                <textarea value={body} onChange={e => setBody(e.target.value)} rows={7} placeholder="正文（角色名：台词 / 动作写进圆括号）" style={taStyle} />
            </div>
        </TModal>
    );
};

// ============ 弹窗：LLM 代写（可选风格） ============
const LLMScriptModal: React.FC<{ open: boolean; onClose: () => void; apiConfig: any; addToast?: (m: string, t?: any) => void; onSaved: () => void }> = ({ open, onClose, apiConfig, addToast, onSaved }) => {
    const [brief, setBrief] = useState(''); const [presetKey, setPresetKey] = useState(''); const [presetPrompt, setPresetPrompt] = useState(''); const [busy, setBusy] = useState(false);
    const gen = async () => {
        const api = await resolveTheaterApi(apiConfig);
        if (!api) { addToast?.('没配 API', 'error'); return; }
        setBusy(true);
        try { const p = await generateScript(brief.trim() || '自由发挥，写一出有意思的短剧', api, presetPrompt || undefined); const s: VRScript = { id: tid('scr'), title: p.title, logline: p.logline, roles: p.roles, body: p.body, authorId: 'llm', authorName: 'AI 编剧', source: 'llm', createdAt: Date.now() }; await DB.saveVRScript(s); addToast?.(`写好了《${s.title}》`, 'success'); setBrief(''); setPresetKey(''); setPresetPrompt(''); onSaved(); }
        catch (e: any) { addToast?.('代写失败：' + (e?.message || ''), 'error'); }
        finally { setBusy(false); }
    };
    return (
        <TModal open={open} title="AI 代写" width={360} onClose={busy ? undefined : onClose} maskClosable={!busy} footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><TButton onClick={onClose} disabled={busy}>取消</TButton><TButton variant="primary" disabled={busy} onClick={gen}>{busy ? '写作中…' : '写'}</TButton></div>}>
            <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                <PresetChips value={presetKey} onChange={(k, pr) => { setPresetKey(k); setPresetPrompt(pr); }} />
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: TH.text }}>主题 / 脑洞（可空）</div>
                <textarea value={brief} onChange={e => setBrief(e.target.value)} rows={3} placeholder="如：两个困在电梯里的陌生人" style={taStyle} />
            </div>
        </TModal>
    );
};

// ============ 弹窗：润色 ============
const PolishModal: React.FC<{ open: boolean; onClose: () => void; apiConfig: any; body: string; addToast?: (m: string, t?: any) => void; onPolished: (body: string) => void }> = ({ open, onClose, apiConfig, body, addToast, onPolished }) => {
    const [presetKey, setPresetKey] = useState(''); const [presetPrompt, setPresetPrompt] = useState(''); const [extra, setExtra] = useState(''); const [busy, setBusy] = useState(false);
    const run = async () => {
        const api = await resolveTheaterApi(apiConfig);
        if (!api) { addToast?.('没配 API', 'error'); return; }
        setBusy(true);
        try { const p = await polishScript(body, presetPrompt, extra, api); onPolished(p.body); }
        catch (e: any) { addToast?.('润色失败：' + (e?.message || ''), 'error'); }
        finally { setBusy(false); }
    };
    return (
        <TModal open={open} title="润色剧本" width={360} onClose={busy ? undefined : onClose} maskClosable={!busy} footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><TButton onClick={onClose} disabled={busy}>取消</TButton><TButton variant="primary" disabled={busy} onClick={run}>{busy ? '润色中…' : '润色'}</TButton></div>}>
            <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                <PresetChips value={presetKey} onChange={(k, pr) => { setPresetKey(k); setPresetPrompt(pr); }} />
                <TInput value={extra} onChange={e => setExtra(e.target.value)} placeholder="额外要求（可空）" />
            </div>
        </TModal>
    );
};

// ============ 上传 txt ============
const UploadButton: React.FC<{ onParsed: (p: { title: string; logline: string; roles: VRPlayRole[]; body: string }) => void }> = ({ onParsed }) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const dlTemplate = () => shareOrDownloadFile({
        content: SCRIPT_TEMPLATE,
        fileName: '剧本模板.txt',
        mimeType: 'text/plain;charset=utf-8',
        shareTitle: '彼方剧院剧本模板',
    });
    return (
        <>
            <TButton size="sm" icon={<UploadSimple size={13} weight="bold" />} onClick={() => inputRef.current?.click()}>传 txt</TButton>
            <TButton size="sm" icon={<DownloadSimple size={13} weight="bold" />} onClick={dlTemplate}>模板</TButton>
            <input ref={inputRef} type="file" accept=".txt,text/plain" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const text = await f.text(); onParsed(parseUploadedScript(text, f.name.replace(/\.txt$/i, ''))); e.target.value = ''; }} />
        </>
    );
};

export default TheaterPanel;

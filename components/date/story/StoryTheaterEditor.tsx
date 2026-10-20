import React, { useMemo, useRef, useState } from 'react';
import { ArrowLeft, DownloadSimple, LockSimple, UploadSimple, UserCircle } from '@phosphor-icons/react';
import TokenImg from '../../os/TokenImg';
import type { CharacterProfile, StoryTheaterEntry, StoryTheaterMask, StoryTheaterPreset, UserProfile } from '../../../types';
import { dedupeTheaterWorldbooks, downloadStoryPreset, estimateStoryTokens, getPresetPromptStats, resolveStoryPresetDocument, resolveStoryTheaterMask } from '../../../utils/storyTheater';

interface Props {
    initial: StoryTheaterEntry;
    characters: CharacterProfile[];
    user: UserProfile;
    masks: StoryTheaterMask[];
    maskLocked: boolean;
    presets: StoryTheaterPreset[];
    onCancel: () => void;
    onSave: (entry: StoryTheaterEntry) => Promise<void> | void;
    onImportPreset: (file: File) => Promise<StoryTheaterPreset | null>;
    onEditPreset: (preset: StoryTheaterPreset, draft: StoryTheaterEntry) => void;
    onOpenMaskBox: (draft: StoryTheaterEntry) => void;
}

const Toggle: React.FC<{ value: boolean; onChange: (value: boolean) => void; label?: string }> = ({ value, onChange, label }) => <button type='button' aria-label={label} aria-pressed={value} onClick={() => onChange(!value)} className={`w-11 h-6 shrink-0 rounded-full p-1 transition-colors ${value ? 'bg-violet-600' : 'bg-slate-200'}`}><span className={`block w-4 h-4 rounded-full bg-white transition-transform ${value ? 'translate-x-5' : ''}`} /></button>;

const StoryTheaterEditor: React.FC<Props> = ({ initial, characters, user, masks, maskLocked, presets, onCancel, onSave, onImportPreset, onEditPreset, onOpenMaskBox }) => {
    const [draft, setDraft] = useState<StoryTheaterEntry>({ ...initial });
    const [saving, setSaving] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const actors = useMemo(() => characters.filter(char => draft.characterIds.includes(char.id)), [characters, draft.characterIds]);
    const resolvedMask = useMemo(() => resolveStoryTheaterMask(draft.mask, user, characters, masks), [characters, draft.mask, masks, user]);
    const memoryParticipants = useMemo(() => {
        const participantIds = new Set(draft.characterIds);
        if (draft.mask?.type === 'character') participantIds.add(draft.mask.id);
        return characters.filter(char => participantIds.has(char.id));
    }, [characters, draft.characterIds, draft.mask]);
    const books = useMemo(() => dedupeTheaterWorldbooks(actors), [actors]);
    const preset = presets.find(item => item.id === draft.presetId) || presets[0] || null;
    const effectivePreset = preset ? { ...preset, document: resolveStoryPresetDocument(preset, draft.presetOverride) } : null;
    const presetStats = getPresetPromptStats(effectivePreset);

    const update = <K extends keyof StoryTheaterEntry>(key: K, value: StoryTheaterEntry[K]) => setDraft(current => ({ ...current, [key]: value, updatedAt: Date.now() }));
    const toggleCharacter = (char: CharacterProfile) => setDraft(current => {
        const adding = !current.characterIds.includes(char.id);
        const characterIds = adding ? [...current.characterIds, char.id] : current.characterIds.filter(id => id !== char.id);
        const remaining = characters.filter(item => characterIds.includes(item.id));
        const validBooks = new Set(dedupeTheaterWorldbooks(remaining).map(book => book.id));
        return {
            ...current,
            characterIds,
            selectedWorldbookIds: adding ? Array.from(new Set([...current.selectedWorldbookIds, ...(char.mountedWorldbooks || []).map(book => book.id)])) : current.selectedWorldbookIds.filter(id => validBooks.has(id)),
            characterContextLimits: { ...current.characterContextLimits, ...(adding && !current.characterContextLimits[char.id] ? { [char.id]: 100 } : {}) },
            updatedAt: Date.now(),
        };
    });
    const tokenPreview = useMemo(() => {
        const actorText = [resolvedMask.name, resolvedMask.description, resolvedMask.coreInstruction, resolvedMask.worldview, ...actors.map(char => [char.name, char.systemPrompt, char.worldview, draft.carryCharacterMemory ? JSON.stringify(char.memories || []) : ''].join('\n'))].join('\n');
        const bookText = books.filter(book => draft.selectedWorldbookIds.includes(book.id)).map(book => book.content).join('\n');
        const presetText = effectivePreset ? effectivePreset.document.prompts.filter(prompt => prompt.enabled).map(prompt => prompt.content).join('\n') : '';
        const archiveText = draft.archives.map(archive => archive.summary || '').join('\n');
        return { actor: estimateStoryTokens(actorText), book: estimateStoryTokens(bookText), preset: estimateStoryTokens(presetText), archive: estimateStoryTokens(archiveText) };
    }, [actors, books, draft, effectivePreset, resolvedMask]);
    const save = async () => {
        if (!draft.title.trim() || draft.characterIds.length === 0) return;
        setSaving(true);
        const archiveAfter = Math.max(2, Math.min(200, Number(draft.archiveAfter) || 40));
        const archiveKeepRecent = Math.max(1, Math.min(archiveAfter - 1, Number(draft.archiveKeepRecent) || 5));
        try { await onSave({ ...draft, title: draft.title.trim(), premise: draft.premise.trim(), carryCharacterMemory: draft.writesToCharacterMemory || draft.carryCharacterMemory, archiveAfter, archiveKeepRecent, presetId: preset?.id || presets[0]?.id, updatedAt: Date.now() }); }
        finally { setSaving(false); }
    };

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onCancel} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div><div className='text-[9px] tracking-[.24em] uppercase font-bold text-violet-500'>Story setup</div><div className='font-semibold'>{initial.title ? '调整剧情沙盒' : '新增剧情'}</div></div>
                <button onClick={save} disabled={saving || !draft.title.trim() || draft.characterIds.length === 0} className='ml-auto h-9 px-4 rounded-full bg-slate-900 text-white text-xs font-bold disabled:opacity-30'>{saving ? '保存中' : '保存并进入'}</button>
            </div>
        </header>
        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-28'><div className='max-w-2xl mx-auto space-y-8'>
            <section>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>01 / Story</div>
                <label className='block mt-2'><span className='text-[10px] font-bold text-slate-500'>标题 · 必填</span><input value={draft.title} onChange={event => update('title', event.target.value)} placeholder='剧情名称' className='mt-1 w-full bg-transparent text-3xl font-serif font-semibold outline-none placeholder:text-slate-300' /></label>
                <label className='block mt-5'><span className='text-[10px] font-bold text-slate-500'>剧情介绍 · 可选</span><textarea value={draft.premise} onChange={event => update('premise', event.target.value)} placeholder='不填写也能直接开场；也可以写地点、冲突或必须守住的设定……' className='mt-2 w-full min-h-28 p-4 rounded-2xl bg-white border border-slate-200 text-sm leading-7 resize-y outline-none' /></label>
                <div className='mt-5'><div className='text-[10px] font-bold text-slate-500'>谁先落笔</div><div className='mt-2 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button disabled={maskLocked} onClick={() => update('openingMode', 'user')} className={`py-2.5 rounded-lg text-[11px] font-bold disabled:opacity-60 ${(draft.openingMode || 'user') === 'user' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>我先写</button><button disabled={maskLocked} onClick={() => update('openingMode', 'assistant')} className={`py-2.5 rounded-lg text-[11px] font-bold disabled:opacity-60 ${draft.openingMode === 'assistant' ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>故事先写</button></div><p className='mt-2 text-[10px] text-slate-400'>{draft.openingMode === 'assistant' ? '进入后可直接让故事根据标题与介绍写出第一幕。' : '进入后由你用当前身份写下第一句话。'}</p></div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>02 / Cast</div><h2 className='mt-1 text-lg font-semibold'>让谁参与</h2>
                <p className='text-[11px] text-slate-500'>先决定你是谁，再一次选好这段剧情里的角色。你选择的身份只由你控制，不会自行行动。</p>
                <button disabled={maskLocked || draft.writesToCharacterMemory} onClick={() => onOpenMaskBox(draft)} className='mt-4 w-full p-4 rounded-2xl bg-slate-900 text-white flex items-center gap-3 text-left disabled:cursor-not-allowed'>
                    {resolvedMask.avatar ? <TokenImg value={resolvedMask.avatar} alt='' className='w-11 h-11 rounded-full object-cover' /> : <span className='w-11 h-11 rounded-full bg-white/10 grid place-items-center'><UserCircle size={24} /></span>}
                    <span className='min-w-0 flex-1'><span className='block text-[9px] uppercase tracking-[.18em] text-violet-200'>你</span><strong className='block mt-1 text-sm truncate'>{resolvedMask.selection.type === 'user' ? '本人' : resolvedMask.name}</strong><span className='block mt-1 text-[9px] text-slate-300 truncate'>{resolvedMask.selection.type === 'user' ? '以真实的自己进入剧场' : resolvedMask.selection.type === 'character' ? '扮演已有角色' : '扮演原创人物'}</span></span>
                    <span className='text-[10px] font-bold text-violet-200'>{draft.writesToCharacterMemory ? <span className='inline-flex items-center gap-1'><LockSimple size={13} />真实身份</span> : maskLocked ? <span className='inline-flex items-center gap-1'><LockSimple size={13} />剧情中锁定</span> : '面具箱'}</span>
                </button>
                {(maskLocked || draft.writesToCharacterMemory) && <p className='mt-2 text-[10px] leading-5 text-slate-500'>{draft.writesToCharacterMemory ? '真实时间陪伴只能使用真实的你，不能扮演已有角色或原创人物。' : '第一段内容发出后，当前身份会锁定，避免中途更换导致人物记忆与叙事视角错位。'}</p>}
                <div className='mt-4 grid grid-cols-2 gap-2.5'>{characters.map(char => { const selected = draft.characterIds.includes(char.id); const isMask = draft.mask?.type === 'character' && draft.mask.id === char.id; return <button key={char.id} disabled={isMask} onClick={() => toggleCharacter(char)} className={`flex items-center gap-3 p-3 rounded-2xl border text-left disabled:opacity-45 ${selected ? 'bg-violet-50 border-violet-300' : 'bg-white border-slate-200'}`}><TokenImg value={char.avatar} alt='' className='w-10 h-10 rounded-full object-cover' /><span className='min-w-0 flex-1'><span className='block text-sm font-semibold truncate'>{char.name}</span>{isMask && <span className='block text-[9px] text-violet-500'>当前由你扮演</span>}</span><span className={`w-4 h-4 rounded-full border-2 ${selected ? 'bg-violet-600 border-violet-600' : 'border-slate-300'}`} /></button>; })}</div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>03 / Memory</div><h2 className='mt-1 text-lg font-semibold'>这段故事是真的吗</h2>
                <div className='mt-4 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button disabled={maskLocked} onClick={() => setDraft(current => ({ ...current, mask: { type: 'user' }, writesToCharacterMemory: true, carryCharacterMemory: true, updatedAt: Date.now() }))} className={`py-3 rounded-lg text-[11px] font-bold disabled:opacity-35 ${draft.writesToCharacterMemory ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>真实时间陪伴</button><button disabled={maskLocked} onClick={() => setDraft(current => ({ ...current, writesToCharacterMemory: false, carryCharacterMemory: false, updatedAt: Date.now() }))} className={`py-3 rounded-lg text-[11px] font-bold disabled:opacity-35 ${!draft.writesToCharacterMemory ? 'bg-white shadow-sm text-violet-700' : 'text-slate-500'}`}>虚构剧场</button></div>
                {maskLocked && <p className='mt-2 text-[10px] text-slate-400'>故事开始后，真实/虚构模式也会固定；虚构剧场的记忆输入仍可单独调整。</p>}
                {draft.writesToCharacterMemory ? <div className='mt-5 p-4 rounded-2xl bg-amber-50 border border-amber-200'>
                    <div className='text-xs font-bold text-amber-800'>记忆输入与输出都会开启</div>
                    <p className='mt-1 text-[10px] leading-5 text-amber-700'>会读取角色既有记忆；你写的内容与故事正文也会分别进入每位角色的正常记忆，作为你们的共同经历。</p>
                    <p className='mt-2 text-[10px] leading-5 text-amber-700'>跟随真实时间：你的输入和角色回复会按各自实际发送的时间记录，无需设置日期。正文中的虚构日期不会改变聊天记录的时间与顺序；如果不希望故事成为共同记忆，请在开始前选择「虚构剧场」。</p>
                    <p className='mt-2 pt-2 border-t border-amber-200 text-[10px] leading-5 font-semibold text-amber-800'>内置真实性保护：角色不能捏造和你的共同记忆，也不能给已有记忆添油加醋。</p>
                </div> : <div className='mt-5 space-y-5'>
                    <div className='py-3 border-y border-slate-200 flex items-center justify-between gap-3'><div><div className='text-sm font-semibold'>自动记忆输出</div><p className='mt-1 text-[10px] leading-5 text-slate-500'>虚构时间与经历不会自动写入角色的正常记忆。需要保留时，可在剧情右上角「事件盒」选择摘要、填写日期，手动转为带剧情来源的记忆。</p></div><span className='shrink-0 px-2 py-1 rounded-full bg-slate-200 text-[9px] font-bold text-slate-500'>关闭</span></div>
                    <div className='flex items-start justify-between gap-5'><div><div className='text-sm font-semibold'>记忆输入</div><p className='mt-1 text-[10px] text-slate-500'>默认关闭；打开后角色会带着既有记忆进入虚构故事。关闭时只读取名字、核心指令和世界观。</p></div><Toggle value={draft.carryCharacterMemory} onChange={value => update('carryCharacterMemory', value)} /></div>
                    {draft.carryCharacterMemory && <div className='space-y-2'>{memoryParticipants.map(char => <label key={char.id} className='flex items-center gap-3 text-xs'><span className='flex-1 truncate'>{char.name}{draft.mask?.type === 'character' && draft.mask.id === char.id ? '（当前身份）' : ''} 最近原文</span><input type='number' min={0} max={500} value={draft.characterContextLimits[char.id] ?? 100} onChange={event => update('characterContextLimits', { ...draft.characterContextLimits, [char.id]: Math.max(0, Math.min(500, Number(event.target.value) || 0)) })} className='w-20 px-3 py-2 rounded-xl bg-white border border-slate-200 text-right' /><span className='text-slate-400'>条</span></label>)}</div>}
                    <div><div className='text-sm font-semibold'>归档方式</div><div className='mt-2 grid grid-cols-2 p-1 rounded-xl bg-slate-200'><button onClick={() => update('archiveStrategy', 'summary')} className={`py-2 rounded-lg text-[11px] font-bold ${draft.archiveStrategy === 'summary' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>事件盒</button><button onClick={() => update('archiveStrategy', 'vector')} className={`py-2 rounded-lg text-[11px] font-bold ${draft.archiveStrategy === 'vector' ? 'bg-white shadow-sm' : 'text-slate-500'}`}>独立向量</button></div></div>
                    <div className='grid grid-cols-2 gap-3'>
                        <label><span className='block mb-2 text-[10px] text-slate-500'>累计多少层后归档</span><input type='number' min={2} max={200} value={draft.archiveAfter} onChange={event => update('archiveAfter', Number(event.target.value))} className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label>
                        <label><span className='block mb-2 text-[10px] text-slate-500'>至少保留最近几层</span><input type='number' min={1} max={Math.max(1, Number(draft.archiveAfter) - 1)} value={draft.archiveKeepRecent ?? 5} onChange={event => update('archiveKeepRecent', Number(event.target.value))} className='w-full px-3 py-2.5 rounded-xl bg-white border border-slate-200 text-sm' /></label>
                    </div>
                    <p className='text-[10px] leading-5 text-slate-500'>先完成并显示本轮回复，再归档最旧部分；默认保留最近 5 层。以后可以换策略，旧事件盒与旧向量都不会丢。</p>
                </div>}
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>04 / Lore</div><h2 className='mt-1 text-lg font-semibold'>世界书沙盒</h2><p className='text-[10px] text-slate-500'>从角色挂载项同步并去重；勾选只属于本剧情。</p>
                <div className='mt-3 divide-y divide-slate-100 border-y border-slate-200'>{books.length === 0 ? <div className='py-6 text-center text-xs text-slate-400'>所选角色没有挂载世界书</div> : books.map(book => { const selected = draft.selectedWorldbookIds.includes(book.id); return <button key={book.id} onClick={() => update('selectedWorldbookIds', selected ? draft.selectedWorldbookIds.filter(id => id !== book.id) : [...draft.selectedWorldbookIds, book.id])} className='w-full py-3 flex items-center gap-3 text-left'><span className={`w-4 h-4 rounded border text-[10px] text-center text-white ${selected ? 'bg-violet-600 border-violet-600' : 'border-slate-300'}`}>{selected ? '✓' : ''}</span><span className='min-w-0'><span className='block text-xs font-semibold truncate'>{book.title}</span><span className='block text-[9px] text-slate-400'>{book.category || '未分类'}</span></span></button>; })}</div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>05 / Preset</div><h2 className='mt-1 text-lg font-semibold'>装载剧情预设</h2><p className='text-[10px] text-slate-500'>只支持糯米机专属剧情预设文件；内置预设复制后可编辑。</p>
                <div className='mt-3 flex gap-2'><select value={preset?.id || ''} onChange={event => setDraft(current => ({ ...current, presetId: event.target.value, presetOverride: undefined, updatedAt: Date.now() }))} className='min-w-0 flex-1 px-3 py-3 rounded-xl bg-white border border-slate-200 text-xs'>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => fileInput.current?.click()} className='w-11 rounded-xl bg-white border border-slate-200 grid place-items-center'><UploadSimple size={18} /></button><button disabled={!preset} onClick={() => { if (preset) void downloadStoryPreset(preset); }} className='w-11 rounded-xl bg-white border border-slate-200 grid place-items-center disabled:opacity-30'><DownloadSimple size={18} /></button></div>
                <input ref={fileInput} type='file' accept='.json,.png,application/json,image/png' className='hidden' onChange={async event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (!file) return; const imported = await onImportPreset(file); if (imported) setDraft(current => ({ ...current, presetId: imported.id, presetOverride: undefined, updatedAt: Date.now() })); }} />
                {preset && <div className='mt-3 flex items-center justify-between'><span className='text-[10px] text-slate-500'>启用 {presetStats.enabled}/{presetStats.total} 条 · 按当前顺序与插入位置发送</span><button onClick={() => onEditPreset(preset, draft)} className='text-[10px] font-bold text-violet-600'>打开制作器</button></div>}
                <div className='mt-5 pt-4 border-t border-slate-200'>
                    <div className='flex items-start justify-between gap-5'>
                        <div><div className='text-sm font-semibold'>不发送高级采样参数</div><p className='mt-1 text-[10px] leading-5 text-slate-500'>默认关闭。仅当接口不接受这些字段时开启；开启后不发送 top_p、frequency_penalty 和 presence_penalty。</p></div>
                        <Toggle label='不发送高级采样参数' value={draft.omitSamplingParams === true} onChange={value => update('omitSamplingParams', value)} />
                    </div>
                    {draft.omitSamplingParams && <p className='mt-3 border-l-2 border-amber-400 pl-3 text-[10px] leading-5 text-amber-700'>这会忽略当前预设中的三项参数，包括非默认值。正常支持酒馆参数的接口请保持关闭。</p>}
                </div>
                <div className='mt-5 pt-4 border-t border-slate-200'>
                    <div className='flex items-start justify-between gap-5'>
                        <div><div className='text-sm font-semibold'>400 兼容模式</div><p className='mt-1 text-[10px] leading-5 text-slate-500'>仅当接口提示“最后一条消息必须是 user”时开启。</p></div>
                        <Toggle label='400 兼容模式' value={draft.forceUserLastMessage === true} onChange={value => update('forceUserLastMessage', value)} />
                    </div>
                    {draft.forceUserLastMessage && <p className='mt-3 border-l-2 border-amber-400 pl-3 text-[10px] leading-5 text-amber-700'>开启后会用系统指令代替原生助手预填，可能削弱格式与文风效果。优先建议更换支持该预设的模型。</p>}
                </div>
            </section>
            <section className='pt-6 border-t border-slate-200'>
                <div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>06 / Budget</div>
                <div className='mt-2 flex items-end justify-between gap-4'><div><h2 className='text-lg font-semibold'>静态配置预算</h2><p className='mt-1 text-[10px] leading-5 text-slate-500'>这里只比较角色、世界书、预设与归档；剧场内会按续写实际使用的完整上下文统计历史、召回和本轮输入。</p></div><strong className='text-2xl font-serif'>{Object.values(tokenPreview).reduce((sum, value) => sum + value, 0).toLocaleString()}</strong></div>
                <div className='mt-4 grid grid-cols-4 gap-2'>{Object.entries({ '角色': tokenPreview.actor, '世界书': tokenPreview.book, '预设': tokenPreview.preset, '归档': tokenPreview.archive }).map(([label, value]) => <div key={label} className='py-3 rounded-xl bg-white border border-slate-200 text-center'><div className='text-[9px] text-slate-400'>{label}</div><div className='mt-1 text-xs font-bold'>{value.toLocaleString()}</div></div>)}</div>
            </section>
            <button onClick={save} disabled={saving || !draft.title.trim() || draft.characterIds.length === 0} className='w-full py-4 rounded-2xl bg-slate-900 text-white text-sm font-bold disabled:opacity-30'>{saving ? '正在保存……' : '保存并进入剧情'}</button>
        </div></main>
    </div>;
};

export default StoryTheaterEditor;

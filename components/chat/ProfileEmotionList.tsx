import React, { useEffect, useRef, useState } from 'react';
import { CaretRight } from '@phosphor-icons/react';
import type { CharacterBuff, CharacterProfile } from '../../types';
import { editCharacterEmotion } from '../../utils/emotionEditing';
import { trackEvent } from '../../utils/analytics';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

export default function ProfileEmotionList({ character, preview }: { character: CharacterProfile; preview?: boolean }) {
    const [buffs, setBuffs] = useState(character.activeBuffs || []);
    const [original, setOriginal] = useState<CharacterBuff | null>(null);
    const [label, setLabel] = useState(''), [description, setDescription] = useState('');
    const [intensity, setIntensity] = useState<1 | 2 | 3>(1);
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const writing = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const start = useRef({ x: 0, y: 0 });
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const clearPress = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
    useEffect(() => clearPress, []);
    useEffect(() => setBuffs(character.activeBuffs || []), [character.id, character.activeBuffs]);
    useEffect(() => {
        if (preview) return;
        const receive = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.charId === character.id && Array.isArray(detail.buffs)) setBuffs(detail.buffs);
        };
        window.addEventListener('emotion-updated', receive);
        return () => window.removeEventListener('emotion-updated', receive);
    }, [character.id, preview]);
    useLocalBackHandler(() => { if (!writing.current) setOriginal(null); return true; }, 70, !!original);
    const edit = (buff: CharacterBuff) => {
        clearPress(); if (preview || writing.current) return;
        setOriginal(structuredClone(buff)); setLabel(buff.label || buff.name); setDescription(buff.description || ''); setIntensity(buff.intensity); setError('');
    };
    const save = async (remove = false) => {
        if (!original || writing.current) return;
        if (remove && !await requestConfirm({ title: '删除情绪', message: `删除「${original.label || original.name}」后，下一轮请求不再携带这条情绪。其他情绪和心声保留。`, confirmText: '删除', variant: 'danger' })) return;
        if (writing.current) return;
        writing.current = true; setBusy(true); setError('');
        try {
            const next = await editCharacterEmotion(character.id, original, remove ? null : { label, description, intensity });
            setBuffs(next.buffs); setOriginal(null);
            trackEvent(remove ? '删除角色情绪' : '编辑角色情绪');
        } catch (error) { setError(error instanceof Error ? error.message : '情绪保存失败，请重试'); }
        finally { writing.current = false; setBusy(false); }
    };
    return <>
        {confirmDialog}
        {!preview && !!buffs.length && <p className="chat-profile-caption">长按情绪可编辑或删除</p>}
        {!!buffs.length && <ul className="chat-profile-emotions" aria-label="当前情绪">
            {buffs.map(buff => {
                const caption = <><i className="chat-profile-seal" aria-hidden="true">{buff.emoji || '✦'}</i>{buff.label || buff.name}</>;
                return <li key={buff.id} tabIndex={preview ? undefined : 0} aria-label={`情绪：${buff.label || buff.name}`}
                    onContextMenu={e => { if (!preview) { e.preventDefault(); edit(buff); } }}
                    onKeyDown={e => { if (e.target === e.currentTarget && e.key === 'Enter') { e.preventDefault(); edit(buff); } }}
                    onPointerDown={e => { if (!preview && e.button === 0) { clearPress(); start.current = { x: e.clientX, y: e.clientY }; timer.current = setTimeout(() => edit(buff), 550); } }}
                    onPointerUp={clearPress} onPointerCancel={clearPress} onPointerLeave={clearPress}
                    onPointerMove={e => { if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 8) clearPress(); }}>
                    {buff.description ? <details><summary>{caption}<CaretRight size={13} aria-hidden="true" /></summary><p>{buff.description}</p></details> : <h3>{caption}</h3>}
                </li>;
            })}
        </ul>}
        {original && <section aria-label="编辑情绪" className="chat-profile-emotion-editor space-y-3 text-slate-800 bg-white rounded-xl p-3 [color-scheme:light]">
            <label className="block text-xs">情绪名称<input aria-label="情绪名称" value={label} onChange={e => setLabel(e.target.value)} className="block mt-1 w-full border rounded-lg p-2 text-base" /></label>
            <label className="block text-xs">情绪说明<textarea aria-label="情绪说明" value={description} onChange={e => setDescription(e.target.value)} className="block mt-1 w-full min-h-24 border rounded-lg p-2 text-base" /></label>
            <label className="block text-xs">强度<select aria-label="情绪强度" value={intensity} onChange={e => setIntensity(Number(e.target.value) as 1 | 2 | 3)} className="ml-2 border rounded p-2 bg-white text-slate-800 text-base"><option value={1}>轻微</option><option value={2}>明显</option><option value={3}>强烈</option></select></label>
            <p className="text-xs text-slate-500">保存后会同步更新给模型的情绪描述。</p>
            {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
            <div className="flex gap-4"><button disabled={busy || !label.trim()} onClick={() => void save()} className="min-h-10 disabled:opacity-40">保存</button><button disabled={busy} onClick={() => setOriginal(null)} className="min-h-10">取消</button><button disabled={busy} onClick={() => void save(true)} className="min-h-10">删除</button></div>
        </section>}
    </>;
}

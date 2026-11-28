import React, { useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import type { CharacterProfile } from '../../types';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob } from '../../utils/blobRef';
import Modal from '../os/Modal';
import TokenImg from '../os/TokenImg';
import Section from './DateSettingsSection';

const EMOTIONS: Record<string, string> = { normal: '平静', happy: '开心', angry: '生气', sad: '难过', shy: '害羞' };
type ImageTarget = { kind: 'background' } | { kind: 'sprite'; key: string; skinId: string | null };
const field = 'min-w-0 w-full px-3 py-3 bg-slate-100 text-slate-800 rounded-xl text-sm outline-none focus:ring-1 focus:ring-primary/30';
const secondary = 'min-h-11 px-3 py-2 rounded-xl bg-slate-100 text-slate-600 text-xs font-medium';

/** Keep the existing role / skin fields; one image chooser for local files and URLs. */
export default function DateArtworkSettings({ char }: { char: CharacterProfile }) {
    const { updateCharacter, addToast } = useOS();
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const [skinPickerOpen, setSkinPickerOpen] = useState(false);
    const [creatingSkin, setCreatingSkin] = useState(false);
    const skinPickerId = React.useId();
    const skinTrigger = useRef<HTMLButtonElement>(null);
    const skinPicker = useRef<HTMLDivElement>(null);
    const [skinName, setSkinName] = useState('');
    const [emotionName, setEmotionName] = useState('');
    const [target, setTarget] = useState<ImageTarget | null>(null);
    const [urlMode, setUrlMode] = useState(false);
    const [url, setUrl] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [artOpen, setArtOpen] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const dialogContent = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLElement | null>(null);
    const skin = char.dateSkinSets?.find(item => item.id === char.activeSkinSetId);
    const editingId = skin?.id || null;
    const sprites = skin?.sprites || char.sprites || {};
    const keys = [...new Set([...Object.keys(EMOTIONS), ...(char.customDateSprites || []), ...Object.keys(sprites).filter(key => key !== 'chibi' && key !== 'default')])];
    const closeSkinPicker = () => { setSkinPickerOpen(false); setCreatingSkin(false); skinTrigger.current?.focus({ preventScroll: true }); };
    useLocalBackHandler(() => { closeSkinPicker(); return true; }, 55, skinPickerOpen);
    const selectSkin = (id: string | null) => {
        updateCharacter(char.id, { activeSkinSetId: id || undefined });
        closeSkinPicker();
    };
    const close = () => { if (!busy) { setTarget(null); trigger.current?.focus({ preventScroll: true }); } };
    useLocalBackHandler(() => { close(); return true; }, 60, !!target);
    const chooseImage = (next: ImageTarget) => {
        trigger.current = document.activeElement as HTMLElement;
        setTarget(next); setUrl(''); setUrlMode(false); setError('');
        requestAnimationFrame(() => dialogContent.current?.querySelector<HTMLButtonElement>('button')?.focus());
    };
    const saveImage = (destination: ImageTarget, value: string) => {
        updateCharacter(char.id, previous => {
            if (destination.kind === 'background') return { dateBackground: value };
            const customDateSprites = EMOTIONS[destination.key] || (previous.customDateSprites || []).includes(destination.key)
                ? previous.customDateSprites : [...(previous.customDateSprites || []), destination.key];
            if (destination.skinId) return {
                dateSkinSets: (previous.dateSkinSets || []).map(item => item.id === destination.skinId
                    ? { ...item, sprites: { ...item.sprites, [destination.key]: value } } : item), customDateSprites,
            };
            return { sprites: { ...previous.sprites, [destination.key]: value }, customDateSprites };
        });
        setTarget(null); trigger.current?.focus({ preventScroll: true });
        addToast(destination.kind === 'background' ? '背景已更新' : '立绘已更新', 'success');
    };
    const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0], destination = target;
        if (!file || !destination) return;
        setBusy(true); setError('');
        try {
            const blob = await processImageToBlob(file, destination.kind === 'background' ? { skipCompression: true } : undefined);
            saveImage(destination, await putImageBlob(blob));
        } catch (cause) { setError(cause instanceof Error ? cause.message : '图片上传失败，请重试'); }
        finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
    };
    const saveUrl = () => {
        if (!target || busy) return;
        try {
            const parsed = new URL(url.trim());
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
            saveImage(target, url.trim());
        } catch { setError('请填写有效的图片链接，以 http:// 或 https:// 开头。'); }
    };
    const createSkin = () => {
        const name = skinName.trim();
        if (!name) return;
        if (char.dateSkinSets?.some(item => item.name === name)) { addToast('该皮肤名称已存在', 'error'); return; }
        const id = `skin_${crypto.randomUUID()}`;
        updateCharacter(char.id, previous => ({ dateSkinSets: [...(previous.dateSkinSets || []), { id, name, sprites: {} }], activeSkinSetId: id }));
        setSkinName(''); closeSkinPicker();
        addToast('套装已创建并使用，可以开始添加立绘', 'success');
    };
    const addEmotion = () => {
        const key = emotionName.trim().toLowerCase().replace(/\s+/g, '_');
        if (!/^[a-z][a-z0-9_-]*$/.test(key) || key === 'chibi' || key === 'default') { addToast('请用英文字母命名情绪，可含数字、下划线或短横线', 'error'); return; }
        if (keys.includes(key)) { addToast('这个情绪已在列表中', 'error'); return; }
        updateCharacter(char.id, previous => ({ customDateSprites: [...(previous.customDateSprites || []), key] }));
        setEmotionName('');
        chooseImage({ kind: 'sprite', key, skinId: editingId });
    };
    const deleteSkin = async () => {
        if (!skin || !await requestConfirm({ title: `删除皮肤「${skin.name}」？`, message: '这套皮肤的立绘配置会移除，其他皮肤保留。', confirmText: '确认删除', variant: 'danger' })) return;
        updateCharacter(char.id, previous => ({ dateSkinSets: previous.dateSkinSets?.filter(item => item.id !== skin.id),
            ...(previous.activeSkinSetId === skin.id ? { activeSkinSetId: undefined } : {}) }));
    };
    const deleteEmotion = async (key: string) => {
        if (!await requestConfirm({ title: `删除情绪「${key}」？`, message: '默认立绘和所有皮肤中的这个情绪配置都会移除，无法恢复。', confirmText: '确认删除', variant: 'danger' })) return;
        updateCharacter(char.id, previous => {
            const without = (values: Record<string, string> = {}) => { const next = { ...values }; delete next[key]; return next; };
            return { customDateSprites: previous.customDateSprites?.filter(value => value !== key), sprites: without(previous.sprites),
                dateSkinSets: previous.dateSkinSets?.map(item => ({ ...item, sprites: without(item.sprites) })) };
        });
    };
    return <>
        <Section title="背景">
            <button type="button" aria-label="更换见面背景" onClick={() => chooseImage({ kind: 'background' })} className="w-full aspect-video bg-slate-100 rounded-xl overflow-hidden relative border border-dashed border-slate-300 flex items-center justify-center">
                {char.dateBackground ? <TokenImg value={char.dateBackground} className="w-full h-full object-cover" loading="lazy" /> : <span className="text-slate-500 text-xs">添加背景图片</span>}
                {char.dateBackground && <span className="absolute bottom-2 right-2 rounded-lg bg-black/60 text-white text-xs px-3 py-2">更换图片</span>}
            </button>
        </Section>
        <Section title="立绘与皮肤" onOpenChange={setArtOpen}>
            <div className="space-y-4">
                <p className="text-[11px] leading-relaxed text-slate-500">选中套装即使用；点击情绪图片可选择本地上传或图片链接。</p>
                <div onKeyDown={event => { if (event.key === 'Escape' && skinPickerOpen) { event.preventDefault(); event.stopPropagation(); closeSkinPicker(); } }}>
                    <span className="block text-xs text-slate-500 mb-2">立绘套装</span>
                    <button ref={skinTrigger} type="button" aria-label="选择立绘套装" aria-expanded={skinPickerOpen} aria-controls={skinPickerId}
                        className="w-full min-h-14 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-100 px-3 py-3 text-left text-sm text-slate-800"
                        onClick={() => { if (skinPickerOpen) closeSkinPicker(); else { setSkinPickerOpen(true); requestAnimationFrame(() => skinPicker.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()); } }}>
                        <span className="min-w-0 flex-1 break-words">{skin?.name || '默认立绘'}</span>
                        <span className="shrink-0 flex items-center gap-1 text-[11px] text-slate-600"><SkinCheck />当前使用</span>
                        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className={`w-4 h-4 shrink-0 ${skinPickerOpen ? 'rotate-180' : ''}`}><path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.3" /></svg>
                    </button>
                    {skinPickerOpen && <div id={skinPickerId} ref={skinPicker} className="mt-2 rounded-xl border border-slate-200 bg-white overflow-hidden">
                        <div role="radiogroup" aria-label="立绘套装列表" className="max-h-56 overflow-y-auto p-1" onKeyDown={event => {
                            if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                            event.preventDefault();
                            const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
                            const index = options.indexOf(document.activeElement as HTMLButtonElement);
                            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + options.length) % options.length;
                            options[next]?.focus();
                            updateCharacter(char.id, { activeSkinSetId: options[next]?.dataset.skinId || undefined });
                        }}>
                            {[{ id: '', name: '默认立绘' }, ...(char.dateSkinSets || [])].map(item => {
                                const current = item.id === (editingId || '');
                                return <button key={item.id} type="button" role="radio" data-skin-id={item.id} tabIndex={current ? 0 : -1} aria-label={item.name} aria-checked={current} onClick={() => selectSkin(item.id || null)}
                                    className={`w-full min-h-12 flex items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-500 ${current ? 'bg-slate-100' : 'hover:bg-slate-50'}`}>
                                    <span className="flex-1 min-w-0 break-words">{item.name}</span>
                                    {current && <span className="shrink-0 flex items-center gap-1 text-[11px] text-slate-600"><SkinCheck />当前使用</span>}
                                </button>;
                            })}
                        </div>
                        <div className="border-t border-slate-100 p-2">
                            {creatingSkin ? <div className="flex gap-2"><input autoFocus aria-label="新皮肤名称" value={skinName} onChange={event => setSkinName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); createSkin(); } }} placeholder="例如冬装、日常" className={field} /><button type="button" className={`${secondary} shrink-0 disabled:opacity-40`} disabled={!skinName.trim()} onClick={createSkin}>创建</button></div>
                                : <button type="button" aria-label="新建套装" className="w-full min-h-11 flex items-center gap-2 px-3 text-left text-sm text-slate-600" onClick={() => setCreatingSkin(true)}><span aria-hidden="true" className="text-lg">＋</span>新建套装</button>}
                        </div>
                    </div>}
                </div>
                {skin && <div className="flex justify-end"><button type="button" className="min-h-11 px-3 text-xs text-slate-500" onClick={() => void deleteSkin()}>删除这套皮肤</button></div>}
                {artOpen && <div className="grid grid-cols-3 gap-3">
                    {keys.map(key => <div key={key} className="min-w-0">
                        <button type="button" aria-label={`设置${EMOTIONS[key] || key}立绘`} onClick={() => chooseImage({ kind: 'sprite', key, skinId: editingId })} className="w-full aspect-[3/4] rounded-xl bg-slate-100 border border-slate-200 overflow-hidden flex items-center justify-center">
                            {sprites[key] ? <TokenImg value={sprites[key]} className="w-full h-full object-contain" loading="lazy" decoding="async" /> : <span className="text-xl text-slate-400">+</span>}
                        </button>
                        <div className="flex items-center justify-center gap-1 min-h-10">
                            <span className="truncate text-xs text-slate-600" title={key}>{EMOTIONS[key] || key}</span>
                            {!EMOTIONS[key] && <button type="button" aria-label={`删除情绪${key}`} onClick={() => void deleteEmotion(key)} className="shrink-0 w-8 h-10 text-slate-400">×</button>}
                        </div>
                    </div>)}
                </div>}
                <div className="flex gap-2"><input aria-label="新情绪名称" value={emotionName} onChange={event => setEmotionName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addEmotion(); }} placeholder="新情绪，例如 excited" className={field} /><button type="button" className={`${secondary} shrink-0`} disabled={!emotionName.trim()} onClick={addEmotion}>添加情绪</button></div>
            </div>
        </Section>
        <input type="file" ref={fileInput} accept="image/*" className="hidden" onChange={upload} />
        <div onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
                if (event.key !== 'Tab') return;
                const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
                const index = elements.indexOf(document.activeElement as HTMLElement);
                if (event.shiftKey && index <= 0) { event.preventDefault(); elements.at(-1)?.focus(); }
                else if (!event.shiftKey && index === elements.length - 1) { event.preventDefault(); elements[0]?.focus(); }
            }}>
        <Modal isOpen={!!target} title={target?.kind === 'background' ? '设置背景图片' : `设置${target?.kind === 'sprite' ? EMOTIONS[target.key] || target.key : ''}立绘`} onClose={close} className="z-[240]">
            <div ref={dialogContent} className="space-y-3">
                <button type="button" className={`${secondary} w-full`} disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? '正在上传…' : '从本地选择'}</button>
                <button type="button" className={`${secondary} w-full`} disabled={busy} onClick={() => setUrlMode(true)}>使用图片链接</button>
                {urlMode && <div className="space-y-3"><input type="url" aria-label="图片链接" value={url} onChange={event => { setUrl(event.target.value); setError(''); }} placeholder="https://…" className={field} /><button type="button" className="w-full min-h-11 rounded-xl bg-primary text-white text-sm" disabled={busy || !url.trim()} onClick={saveUrl}>保存图片</button></div>}
                {error && <p role="alert" className="text-xs leading-relaxed text-red-600">{error}</p>}
            </div>
        </Modal>
        </div>
        {confirmDialog}
    </>;
}

function SkinCheck() {
    return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

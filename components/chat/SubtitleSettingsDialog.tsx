import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { DEFAULT_SUBTITLE_SETTINGS, normalizeSubtitleSettings, SUBTITLE_FONTS, type ChatSubtitleSettings } from '../../utils/chatTranslationStyle';
import { ChatSubtitleLayer, ChatTranslationText } from './ChatSubtitleLayer';
import './subtitleSettings.css';
import { importFontFile, listSavedFonts, rememberFontDataUrl, type SavedFont } from '../../utils/fontLibrary';
import { DB } from '../../utils/db';

function SaveChangesPrompt({ busy, error, onSave, onDiscard, onCancel }: {
    busy: boolean; error: string; onSave: () => void; onDiscard: () => void; onCancel: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    const descriptionId = useId();
    useLocalBackHandler(() => { onCancel(); return true; }, 60);
    useLayoutEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const element = dialog.current;
        element?.showModal();
        cancel.current?.focus({ preventScroll: true });
        return () => {
            element?.close();
            if (previous?.isConnected) previous.focus({ preventScroll: true });
        };
    }, []);
    return <dialog ref={dialog} className="subtitle-save-prompt" role="alertdialog" aria-labelledby={titleId} aria-describedby={descriptionId}
        onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel(); }}
        onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
        <h3 id={titleId}>保存字幕修改？</h3>
        <p id={descriptionId}>{busy ? '字体正在导入，完成后即可保存。' : '还有未保存的修改。'}</p>
        {error && <p role="alert" className="subtitle-font-error">{error}</p>}
        <button type="button" className="subtitle-save-action" disabled={busy} onClick={onSave}>保存并返回</button>
        <button type="button" onClick={onDiscard}>不保存并返回</button>
        <button ref={cancel} type="button" onClick={onCancel}>继续编辑</button>
    </dialog>;
}

export default function SubtitleSettingsDialog({ value, onChange, onClose, appearanceFonts = [] }: {
    value: ChatSubtitleSettings; onChange: (value: ChatSubtitleSettings) => void; onClose: () => void;
    appearanceFonts?: Array<{ name: string; source: string }>;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const alive = useRef(true);
    // A fresh draft belongs to this visit; only an explicit save updates the chat.
    const [original] = useState(() => normalizeSubtitleSettings(value));
    const [draft, setDraft] = useState(original);
    const [confirmClose, setConfirmClose] = useState(false);
    const [saveError, setSaveError] = useState('');
    const [fonts, setFonts] = useState<SavedFont[]>([]);
    const [appearanceFont, setAppearanceFont] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const dirty = draft.fontSize !== original.fontSize || draft.color !== original.color
        || draft.outlineColor !== original.outlineColor || draft.font !== original.font
        || (draft.font === 'custom' && draft.fontId !== original.fontId);
    const requestClose = () => {
        if (dirty || busy) setConfirmClose(true);
        else onClose();
    };
    const save = () => {
        if (busy) return;
        try {
            onChange(normalizeSubtitleSettings(draft));
        } catch {
            setSaveError('保存失败，修改已保留，请重试。');
            return;
        }
        onClose();
    };
    useEffect(() => {
        alive.current = true;
        void Promise.all([listSavedFonts(), DB.getAsset('custom_font_data')]).then(([list, current]) => {
            if (!alive.current) return;
            setFonts(list); setAppearanceFont(current?.startsWith('data:') ? current : null);
        }).catch(() => { if (alive.current) setError('字体列表读取失败，请返回后重试'); });
        return () => { alive.current = false; };
    }, []);
    const useImported = async (importing: () => Promise<SavedFont>) => {
        setBusy(true); setError('');
        try {
            const font = await importing();
            if (!alive.current) return;
            setFonts(current => current.some(row => row.id === font.id) ? current : [...current, font]);
            setDraft(current => ({ ...current, font: 'custom', fontId: font.id }));
        } catch (err) { if (alive.current) setError(err instanceof Error ? err.message : '字体导入失败，请重试'); }
        finally { if (alive.current) setBusy(false); }
    };
    useLocalBackHandler(() => { requestClose(); return true; }, 40);
    useLayoutEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const element = dialog.current;
        element?.showModal();
        return () => {
            element?.close();
            if (previous?.isConnected) previous.focus({ preventScroll: true });
        };
    }, []);
    return createPortal(<dialog ref={dialog} className="subtitle-settings-page" aria-label="外挂字幕设置"
        onCancel={event => { event.preventDefault(); event.stopPropagation(); requestClose(); }}
        onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
        <header className="subtitle-settings-header">
            <button type="button" onClick={requestClose} aria-label="返回聊天设置"><span aria-hidden="true">‹</span> 返回</button>
            <h2>外挂字幕</h2><button type="button" className="subtitle-save-action" onClick={save} disabled={busy}>保存</button>
        </header>
        <div className="subtitle-settings-content">
            <p className="subtitle-settings-caption">实时预览</p>
            <div className="subtitle-settings-preview">
                <ChatSubtitleLayer settings={draft}>
                    <div className="subtitle-preview-message">
                        <ChatTranslationText subtitle="晚风正好。一起散步吧。">夕風が気持ちいいね。<br />一緒に散歩しよう。</ChatTranslationText>
                    </div>
                </ChatSubtitleLayer>
            </div>
            <p className="subtitle-settings-caption">只调整这位角色的译文显示</p>
            <div className="subtitle-settings-controls">
                <label className="subtitle-settings-size"><span>字号 <output>{draft.fontSize}</output></span>
                    <input aria-label="字幕字号" type="range" min="12" max="28" step="1" value={draft.fontSize}
                        onChange={event => setDraft({ ...draft, fontSize: Number(event.target.value) })} />
                </label>
                <label><span>字体</span><select aria-label="字幕字体" disabled={busy} value={draft.font === 'custom' ? draft.fontId : draft.font} onChange={event => {
                    const selected = event.target.value;
                    if (selected === 'appearance-current' && appearanceFont) void useImported(() => rememberFontDataUrl(appearanceFont, '外观字体'));
                    else if (selected.startsWith('appearance-preset-')) {
                        const font = appearanceFonts[Number(selected.slice('appearance-preset-'.length))];
                        if (font) void useImported(() => rememberFontDataUrl(font.source, font.name));
                    }
                    else if (fonts.some(font => font.id === selected)) setDraft({ ...draft, font: 'custom', fontId: selected });
                    else setDraft({ ...draft, font: selected as ChatSubtitleSettings['font'] });
                }}>
                    {Object.entries(SUBTITLE_FONTS).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}
                    {appearanceFont && <option value="appearance-current">外观里正在使用的字体</option>}
                    {appearanceFonts.length > 0 && <optgroup label="外观预设字体">{appearanceFonts.map((font, index) => <option key={index} value={'appearance-preset-' + index}>{font.name}</option>)}</optgroup>}
                    {fonts.length > 0 && <optgroup label="已导入字体">{fonts.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</optgroup>}
                    {draft.font === 'custom' && !fonts.some(font => font.id === draft.fontId) && <option value={draft.fontId}>已选字体（文件未找到）</option>}
                </select></label>
                <div className="subtitle-font-import"><button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? '正在导入…' : '导入字体文件'}</button><span>TTF / OTF / WOFF / WOFF2</span></div>
                <input ref={fileInput} type="file" accept=".ttf,.otf,.woff,.woff2" aria-label="导入字幕字体" hidden onChange={event => {
                    const file = event.target.files?.[0]; event.target.value = '';
                    if (file) void useImported(() => importFontFile(file));
                }} />
                {error && <p role="alert" className="subtitle-font-error">{error}</p>}
                <label><span>文字颜色</span><input aria-label="字幕文字颜色" type="color" value={draft.color} onChange={event => setDraft({ ...draft, color: event.target.value })} /></label>
                <label><span>描边颜色</span><input aria-label="字幕描边颜色" type="color" value={draft.outlineColor} onChange={event => setDraft({ ...draft, outlineColor: event.target.value })} /></label>
            </div>
            <div className="subtitle-settings-foot"><span>随文字与完整备份迁移</span><button type="button" title="还原默认样式" disabled={busy} onClick={() => setDraft({ ...DEFAULT_SUBTITLE_SETTINGS })}>还原</button></div>
            {saveError && !confirmClose && <p role="alert" className="subtitle-font-error">{saveError}</p>}
        </div>
        {confirmClose && <SaveChangesPrompt busy={busy} error={saveError} onSave={save} onDiscard={onClose} onCancel={() => setConfirmClose(false)} />}
    </dialog>, document.body);
}

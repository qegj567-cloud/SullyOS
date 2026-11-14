import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../../context/OSContext';
import { MEETING_APPEARANCES, meetingAppearance, type MeetingAppearance } from '../../utils/meetingAppearance';
import BeautyShareChannel from '../appearance/BeautyShareChannel';

export default function MeetingAppearanceControl({ surface, characterId }: { surface: 'date' | 'story'; characterId?: string }) {
    const { characters, theme, updateTheme, updateCharacter, appearancePresets, exportAppearancePreset, importAppearancePreset, addToast, registerBackHandler } = useOS();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!open) return;
        return registerBackHandler(() => { if (!busy) setOpen(false); return true; });
    }, [open, busy, registerBackHandler]);
    const char = characters.find(c => c.id === characterId);
    const current = meetingAppearance(surface === 'date' ? char?.dateAppearance : theme.storyAppearance);
    const apply = async (preset: MeetingAppearance['preset']) => {
        try {
            if (surface === 'date' && char) await updateCharacter(char.id, { dateAppearance: { preset } });
            else if (surface === 'story') await updateTheme({ storyAppearance: { preset } });
        } catch { addToast('美化保存失败，请重试', 'error'); }
    };
    return <div className="p-4 border-b border-slate-200">
        <div className="flex items-center justify-between gap-3">
            <label className="text-sm text-slate-600">当前美化：
                <select aria-label="当前美化" value={current.id} onChange={e => void apply(e.target.value as MeetingAppearance['preset'])} className="ml-1 bg-transparent font-semibold py-2">
                    {MEETING_APPEARANCES.map(item => <option key={item.id} value={item.id}>{item.id === current.id ? current.name : item.name}</option>)}
                </select>
            </label>
            <button onClick={() => setOpen(true)} className="text-xs text-violet-600 py-2">聊天装扮 →</button>
        </div>
        <p className="text-xs text-slate-400">{current.description}</p>
        {open && createPortal(<div className="fixed inset-0 z-[250] bg-white text-slate-800" role="dialog" aria-modal="true" aria-label="界面美化" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); if (!busy) setOpen(false); } }}>
            <BeautyShareChannel presets={appearancePresets} onExport={exportAppearancePreset} onImport={importAppearancePreset}
                initialCategory={surface} targetCharacterId={characterId} onBusyChange={setBusy} onBack={() => { if (!busy) setOpen(false); }} />
        </div>, document.body)}
    </div>;
}

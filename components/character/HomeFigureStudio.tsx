import {createLocalId} from '../../utils/localId.js';
import {homelyPaletteStyle} from '../os/homelyPalette';
import './homeFigureEditor.css';
import React, {useState} from 'react';
import {useOS} from '../../context/OSContext';
import {CreatorIframe, LIKE520_RECORD_KEY, type ChibiResult} from '../Like520Event';
const HomeFigureEditor = React.lazy(() => import('./HomeFigureEditor'));
import {UserCircle,Plus} from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import type {HomeFigureSlot} from '../../types';

export default function HomeFigureStudio({charId, onClose, startEditing = false}: {charId?: string; onClose: () => void; startEditing?: boolean}) {
    const {theme, characters, userProfile, updateCharacter, updateUserProfile} = useOS();
    const char = characters.find(c => c.id === charId);
    const [editing, setEditing] = useState<'source' | 'home' | 'chibi' | null>(startEditing ? 'source' : null);
    const [source, setSource] = useState<{value?: HomeFigureSlot; state?: unknown; draftKey?: string}>({});
    if (charId && !char) return null;
    const owner = char ?? userProfile, name = owner.name || '你';
    const figure = owner.chibiStudio?.home3D;
    const baseState = char ? char.chibiStudio?.room?.state ?? char.chibiStudio?.vr?.state ?? char.vrState?.chibi?.state : userProfile.vrState?.chibi?.state;
    const record = char?.specialMomentRecords?.[LIKE520_RECORD_KEY]?.customData?.charChibi as {state?: unknown; dataUrl?: string} | undefined;
    const choices = char ? [
        {id: 'room', label: '小小窝', state: char.chibiStudio?.room?.state, img: char.sprites?.chibi},
        {id: 'vr', label: '彼方', state: char.chibiStudio?.vr?.state ?? char.vrState?.chibi?.state, img: char.vrState?.chibi?.img},
        {id: 'like520', label: '特别时光', state: char.chibiStudio?.like520?.state ?? record?.state, img: char.chibiStudio?.like520?.img ?? record?.dataUrl},
    ] : [{id: 'chibi', label: '我的 Chibi', state: userProfile.vrState?.chibi?.state, img: userProfile.vrState?.chibi?.img}];
    const chooseSource = (state?: unknown, value?: HomeFigureSlot) => {
        setSource({state, value, draftKey: `home_figure_${charId ?? 'user'}_${createLocalId()}`});
        setEditing('home');
    };
    const saveHome = (value: HomeFigureSlot) => {
        if (char) updateCharacter(char.id, prev => ({chibiStudio: {...prev.chibiStudio, home3D: value}}));
        else updateUserProfile(prev => ({chibiStudio: {...prev.chibiStudio, home3D: value}}));
        if(startEditing)onClose();else setEditing(null);
    };
    const saveChibi = (value: ChibiResult) => {
        updateUserProfile(prev => ({vrState: {...prev.vrState, enabled: prev.vrState?.enabled ?? false, chibi: {...prev.vrState?.chibi, img: value.transparentDataUrl, state: value.state}}}));
        setEditing(null);
    };
    if (editing === 'source') return <div className="home-figure-studio fixed inset-0 z-[80] flex flex-col bg-[#f4f5ef] text-[#26372c]" style={{...homelyPaletteStyle(theme?.homelyPalette), paddingTop: 'var(--chrome-top)', paddingBottom: 'var(--safe-bottom)'}}>
        <header className="flex items-center gap-4 p-4"><button className="min-h-[44px]" onClick={startEditing ? onClose : () => setEditing(null)}>返回</button><h2 className="font-semibold">基于哪个形象 3D 化？</h2></header>
        <div className="flex-1 overflow-auto px-5 pb-6 max-w-xl w-full mx-auto" style={{scrollbarWidth: 'thin'}}>
            {figure?.state && <button className="w-full min-h-[48px] rounded-xl bg-[#466a48] text-white mb-4" onClick={() => chooseSource(undefined, figure)}>继续编辑当前家园形象</button>}
            <div className="grid grid-cols-2 gap-3">{choices.filter(choice => choice.state).map(choice => <button key={choice.id} aria-label={choice.label} className="rounded-xl border border-[#d7dfd1] bg-white p-3 flex flex-col items-center gap-2" onClick={() => chooseSource(choice.state)}>
                {choice.img ? <TokenImg value={choice.img} alt={choice.label} className="h-28 w-full object-contain" /> : <UserCircle size={96} weight="duotone" className="h-28 text-[#627062]"/>}
                <span className="text-sm font-medium">{choice.label}</span>
            </button>)}</div>
            <button className="mt-4 w-full min-h-[48px] rounded-xl border border-[#a5b99a]" onClick={() => chooseSource()}>从头捏一个</button>
            <p className="mt-3 text-xs text-[#627062]">只用作起点，原手办保持不变。</p>
        </div>
    </div>;
    if (editing === 'home') return <React.Suspense fallback={<div className="fixed inset-0 z-[80] bg-[#f4f5ef] text-[#26372c] p-8" style={{paddingTop: 'calc(var(--chrome-top) + 32px)'}}>正在打开 3D 捏人器…<button className="block mt-5" onClick={() => setEditing(null)}>返回</button></div>}><HomeFigureEditor paletteId={theme?.homelyPalette} name={name} ownerId={charId ?? 'user'} value={source.value} seedState={source.state} draftKey={source.draftKey} onSave={saveHome} onClose={() => setEditing('source')} /></React.Suspense>;
    if (editing === 'chibi') return <div className="fixed inset-0 z-[80] flex flex-col bg-white text-[#26372c]" style={{...homelyPaletteStyle(theme?.homelyPalette), paddingTop: 'var(--chrome-top)', paddingBottom: 'var(--safe-bottom)'}}><button className="min-h-[48px] text-left px-5" onClick={() => setEditing(null)}>返回手办柜</button><div className="flex-1 min-h-0"><CreatorIframe mode="user" savedState={userProfile.vrState?.chibi?.state ?? figure?.state} draftKey="studio_user_chibi" title="你的 Chibi 形象" subtitle="FIGURE STUDIO" onConfirm={saveChibi} /></div></div>;
    return <div className="home-figure-studio fixed inset-0 z-[75] flex flex-col bg-[#f4f5ef] text-[#26372c]" style={{...homelyPaletteStyle(theme?.homelyPalette), paddingTop: 'var(--chrome-top)', paddingBottom: 'var(--safe-bottom)'}}>
        <header className="flex items-center gap-4 p-4"><button className="min-h-[44px]" onClick={onClose}>返回</button><h2 className="text-lg font-semibold">{name}的手办柜</h2></header>
        <div className="flex-1 overflow-auto px-5 pb-8 max-w-xl w-full mx-auto">
            <div className="grid grid-cols-2 gap-4">
                <button className="rounded-2xl bg-white border border-[#d7dfd1] p-4 flex flex-col items-center gap-3" onClick={() => setEditing('source')} aria-label={figure?.state?'编辑 3D 形象':'开始捏 3D 形象'}>
                    {figure?.img?<TokenImg value={figure.img} className="w-full h-44 object-contain"/>:<UserCircle size={104} weight="duotone" className="h-44 text-[#a5b99a]"/>}
                    <span className="font-semibold">家园形象</span><span className="text-xs text-[#627062]">{figure?.state?'点击换装':'＋ 捏一个 3D 形象'}</span>
                </button>
                {!char&&<button className="rounded-2xl bg-white border border-[#d7dfd1] p-4 flex flex-col items-center gap-3" onClick={()=>setEditing('chibi')} aria-label="编辑 Chibi 形象">
                    {userProfile.vrState?.chibi?.img?<TokenImg value={userProfile.vrState.chibi.img} className="w-full h-44 object-contain"/>:<Plus size={64} className="h-44 text-[#a5b99a]"/>}
                    <span className="font-semibold">Chibi 形象</span><span className="text-xs text-[#627062]">{userProfile.vrState?.chibi?.state?'点击换装':'＋ 捏一个 Chibi'}</span>
                </button>}
            </div>
            <p className="mt-4 text-xs text-[#627062]">点击手办开始编辑，两个形象分别保存。</p>
        </div>
    </div>;
}



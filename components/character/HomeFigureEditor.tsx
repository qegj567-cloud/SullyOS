import {homelyPaletteStyle} from '../os/homelyPalette';
import {homeFigureSeed} from '../../utils/homeFigureSeed';
import builtinParts from '../../public/like520/parts/manifest.json';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {CreatorIframe, isSullyChar, sullyPresets, type ChibiResult} from '../Like520Event';
import {CreatorRollBridge} from '../../apps/room3d/chibi/CreatorRollBridge';
import {decodeParts} from '../../apps/room3d/chibi/visitor';
import {cleanFace} from '../../apps/room3d/chibi/faceAppearance';
import {selectedHairAssets, type HairSettings, type Parts} from '../../apps/room3d/chibi/types';
import {HairEditor} from '../../experiments/chibi/HairEditor';
import {loadCreatorPartsForRender} from '../../utils/creatorPartsBlob';
import type {HomeFigureSlot, CharacterProfile, CustomCreatorPart} from '../../types';
import {flipHomeFigurePart,selectHomeFigurePart} from '../../utils/homeFigureParts';
import './homeFigureEditor.css';
import {useFigurePreview} from '../../experiments/chibi/useFigurePreview';

export default function HomeFigureEditor({paletteId, name, ownerId, value, seedState, draftKey, onSave, onClose}: {
    paletteId?: string; name: string; ownerId: string; value?: HomeFigureSlot; seedState?: unknown; draftKey?: string;
    onSave: (value: HomeFigureSlot) => void; onClose: () => void;
}) {
    const isSully = ownerId !== 'user' && isSullyChar({name} as CharacterProfile);
    const [state, setState] = useState(() => homeFigureSeed(value?.state ?? seedState, isSully));
    const [image, setImage] = useState(value?.img ?? '');
    const [editingBase, setEditingBase] = useState(false);
    const [hair, setHair] = useState<HairSettings>(() => {
        let initial: HairSettings = value?.hair ?? {layers: {}, extras: [], bodyShape: 'blank', face: {...cleanFace(undefined), useBaseEyes: true, useBaseMouth: true}};
        if (!isSully && initial.face?.brow === 'sully') initial = {...initial, face: {...initial.face, brow: 'original'}};
        // The old complete Sully eyes include brows. Use the split sources in 3D
        // so changing brows never replaces the eyes or draws a second brow pair.
        if (isSully && state?.selected?.eyes === 'eyes_99' && initial.face?.useBaseEyes) {
            return {...initial, face: {...cleanFace(initial.face), useBaseEyes: false, eyeArtwork: 'sully'}};
        }
        return {...initial, ...(!isSully && (initial.face?.eyeArtwork === 'sully' || (value?.state as any)?.selected?.eyes === 'eyes_99') ? {face: {...cleanFace(initial.face), eyeArtwork: undefined, useBaseEyes: false}} : {})};
    });
    const [adjusting,setAdjusting]=useState(false);
    const {preview,deferred}=useFigurePreview(hair,adjusting);
    const [sourceEyeTints,setSourceEyeTints]=useState<import("../../apps/room3d/chibi/CreatorRollBridge").RollResult["eyeTints"]>();
    const [sourceEyeColors,setSourceEyeColors]=useState<{L:string;R:string}>();
    const [parts, setParts] = useState<Parts>();
    const [items, setItems] = useState<CustomCreatorPart[]>();
    const [rebuilding, setRebuilding] = useState(false);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState('');
    type Snapshot = {hair: HairSettings; state: unknown; image: string};
    const [past, setPast] = useState<Snapshot[]>([]), [future, setFuture] = useState<Snapshot[]>([]);
    const group = useRef(false), recorded = useRef(false), alive = useRef(true), revision = useRef(0);
    useEffect(() => {alive.current = true; loadCreatorPartsForRender().then(rows => {if (alive.current) setItems(rows);}).catch(e => {if (alive.current) setError(String(e));}); return () => {alive.current = false; revision.current++;};}, []);
    useEffect(()=>{
        const end=()=>{if(group.current){group.current=false;setAdjusting(false);}};
        window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);window.addEventListener('blur',end);
        return()=>{window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);window.removeEventListener('blur',end);};
    },[]);
    const change = (next: HairSettings) => {
        if (!group.current || !recorded.current) {setPast(rows => [...rows.slice(-39), {hair,state,image}]); recorded.current = true;}
        setFuture([]); setHair(next);
    };
    const restore = (snapshot: Snapshot) => {
        setHair(snapshot.hair);
        if(JSON.stringify(snapshot.state)!==JSON.stringify(state)){
            setReady(false);setRebuilding(true);setError('');revision.current++;
            setState(snapshot.state);setImage(snapshot.image);
        }
    };
    const assets = useMemo(() => selectedHairAssets(state), [state]);
    const previewHair=useMemo(()=>({...preview,assets}),[preview,assets]);
    const customParts=useMemo(()=>[...builtinParts.filter(p=>['fronthair','earhair','back1','back2','facemark','decor'].includes(p.categoryKey)).map(p=>({...p,src:import.meta.env.BASE_URL+'like520/'+p.src,createdAt:0})),...(items??[])],[items]);
    const [renderParts, setRenderParts] = useState<Parts>();
    useEffect(() => {let cancelled = false; if (!parts) return;
        Promise.all(preview.extras.filter(item => item.src).map(async item => {const img = new Image(); img.src = item.src!; await img.decode(); return [item.source, img] as const;}))
            .then(extras => {if (!cancelled) setRenderParts({...parts, ...Object.fromEntries(extras)});}).catch(e => {if (!cancelled) setError(String(e));});
        return () => {cancelled = true;};
    }, [parts, preview.extras]);
    const confirmBase = (result: ChibiResult) => {setReady(false); setError(''); setParts(undefined); setRenderParts(undefined); setState(result.state); setImage(result.transparentDataUrl); setEditingBase(false);};
    const useSullyEyes = () => {
        change({...hair, face: {...cleanFace(hair.face), useBaseEyes: true}});
        if (state?.selected?.eyes === 'eyes_99') return;
        setReady(false); setRebuilding(true); setError(''); revision.current++;
        setState({...state, selected: {...state?.selected, eyes: 'eyes_99'}});
    };
    const useCustomPart = (part: CustomCreatorPart) => {
        const next=selectHomeFigurePart(state,hair.face,part);
        change({...hair,face:next.face,...(part.categoryKey==='skin'?{skinColor:undefined}:{})});
        if(JSON.stringify(next.state)===JSON.stringify(state))return;
        setReady(false);setRebuilding(true);setError('');revision.current++;
        setState(next.state);
    };
    const flipPart=(key:string)=>{
        change({...hair});
        setReady(false);setRebuilding(true);setError('');revision.current++;
        setState(flipHomeFigurePart(state,key));
    };
    return <div className="home-figure-editor fixed inset-0 z-[80] flex flex-col bg-[#f4f5ef] text-[#26372c]" style={{...homelyPaletteStyle(paletteId), paddingTop: 'var(--chrome-top)', paddingBottom: 'var(--safe-bottom)'}}>
        <header className="home-figure-editor-header flex shrink-0 items-center gap-3 px-4 py-3 border-b border-black/10">
            <button className="min-h-[44px]" onClick={editingBase && state ? () => setEditingBase(false) : onClose}>{editingBase && state ? '返回 3D' : '取消'}</button>
            <strong className="flex-1 text-sm"><small>3D 形象</small><span>{name}的造型间</span></strong>
            {!editingBase && <button className="home-figure-save min-h-[44px] rounded-xl bg-[#466a48] px-4 text-white disabled:opacity-40" disabled={!renderParts || rebuilding || !!error} onClick={() => onSave({state, img: image, hair: {...hair, assets}, updatedAt: Date.now()})}>{rebuilding ? '准备中…' : '完成并保存'}</button>}
        </header>
        {editingBase ? <div className="flex-1 min-h-0"><CreatorIframe mode={ownerId === 'user' ? 'user' : 'char'} charName={name} isSully={isSully} presets={isSully ? sullyPresets() : undefined} savedState={state} draftKey={draftKey ?? `home_figure_${ownerId}`} title={`${name} · 家园形象`} subtitle="HOME FIGURE" onConfirm={confirmBase} /></div> : <div className="home-figure-editor-content flex-1 min-h-0">
            {renderParts ? <HairEditor allowSully={isSully} parts={renderParts} hair={hair} previewHair={previewHair} deferredPreview={deferred} assets={assets} onChange={change}
                bodyNotice={ownerId === 'user' ? '进入家园后，全员使用房主选择的体型。这里可先试捏你的形象。' : '这个家园内，全员跟随房主体型，包括你和来访角色。'}
                onSullyEyes={isSully ? useSullyEyes : undefined}
                sourceEyeTints={sourceEyeTints} sourceEyeColors={sourceEyeColors} flipped={state?.flipped} onFlipPart={flipPart} customParts={customParts} selectedParts={state?.selected} onCustomPart={useCustomPart}
                onBegin={() => {if(!group.current){group.current = true; recorded.current = false;}setAdjusting(true);}} onEnd={() => {group.current = false;setAdjusting(false);}}
                canUndo={past.length > 0} canRedo={future.length > 0}
                onUndo={() => {const last = past.at(-1); if (last) {setFuture(rows => [...rows, {hair,state,image}]); setPast(rows => rows.slice(0, -1)); restore(last);}}}
                onRedo={() => {const last = future.at(-1); if (last) {setPast(rows => [...rows, {hair,state,image}]); setFuture(rows => rows.slice(0, -1)); restore(last);}}}
                onReset={() => change({layers: {}, extras: [], bodyShape: hair.bodyShape})} onEditAppearance={() => {setReady(false); revision.current++; setEditingBase(true);}} appearanceImage={image} /> : <p className="p-8">正在还原 3D 形象…</p>}
        </div>}
        {state && !editingBase && <CreatorRollBridge key={JSON.stringify(state)} request={ready && items ? 1 : 0} savedState={state} extraItems={items} onReady={() => setReady(true)} onResult={result => {const token = ++revision.current; decodeParts(result).then(next => {if (alive.current && token === revision.current) {setParts(next); setSourceEyeColors(result.eyeColors); setSourceEyeTints(result.eyeTints); setImage(result.image); setRebuilding(false);}}).catch(e => {if (alive.current) setError(String(e));});}} onError={setError} />}
        {error && <p role="alert" className="p-3 text-sm text-red-700">{error} 请返回后重试。</p>}
    </div>;
}

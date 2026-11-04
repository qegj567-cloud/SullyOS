import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import TokenImg from '../../components/os/TokenImg';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';
import { FISHING_MARKET_STORAGE_KEY, mutateFishingMarket, readFishingMarketState } from '../../utils/vrWorld/fishingMarket';
import { assignHalloweenCostume, finishHalloweenDialogue, freshHalloween, giveHalloweenCandy, halloweenActive, HALLOWEEN_CANDIES, HALLOWEEN_COSTUMES, type HalloweenNpc, type KanataHalloweenState } from '../../utils/vrWorld/kanataHalloween';
import { isKanataHalloween } from '../../utils/vrWorld/halloweenCalendar';
import { SARDialogueCast } from './SARNpcArt';
import { SARDialogueBackdrop } from './SARDialogueBackdrop';
import { SARDialogueMeta } from './SARDialogueMeta';
import { FishArt } from './FishArt';
import './sar-familiarity-dialog.css';
import './kanata-halloween.css';
import { trackHalloweenFeature } from '../../utils/octoberAnalytics';

const HalloweenContext = createContext({ state: freshHalloween(), active: false, error: '' });
export const useKanataHalloween = () => useContext(HalloweenContext);
export function KanataHalloweenProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<KanataHalloweenState>(freshHalloween), [error, setError] = useState('');
    const day = useLocalDateKey();
    useEffect(() => {
        const sync = () => { try { setState(readFishingMarketState().kanataHalloween || freshHalloween()); setError(''); } catch (e) { setError((e as Error).message); } };
        const storage = (e: StorageEvent) => { if (!e.key || e.key === FISHING_MARKET_STORAGE_KEY) sync(); };
        sync(); window.addEventListener('vr-fishing-market-updated', sync); window.addEventListener('storage', storage);
        return () => { window.removeEventListener('vr-fishing-market-updated', sync); window.removeEventListener('storage', storage); };
    }, []);
    return <HalloweenContext.Provider value={{ state, active: isKanataHalloween(day) && !state.disabled && !error, error }}>{children}</HalloweenContext.Provider>;
}

/** User artwork shares the creator's original 472px canvas; transforms apply to both layers. */
export function HalloweenChibi({ actorId, img, name, className, style }: { actorId: string; img: string; name: string; className?: string; style?: React.CSSProperties }) {
    const { state, active } = useKanataHalloween();
    const [error, setError] = useState('');
    const assigned = Object.prototype.hasOwnProperty.call(state.costumes, actorId);
    useEffect(() => {
        if (active && !assigned) void mutateFishingMarket(s => assignHalloweenCostume(s, actorId, 'initial')).catch(e => setError(e.message));
    }, [active, assigned, actorId]);
    const costume = active ? HALLOWEEN_COSTUMES.find(c => c.id === state.costumes[actorId]) : undefined;
    if (!costume) return <TokenImg value={img} alt={name} draggable={false} className={className} style={style}/>;
    return <span className={`kanata-halloween-chibi ${className || ''}`} style={style}>
        <TokenImg value={img} alt={name} draggable={false} style={{ clipPath: costume && 'clip' in costume ? costume.clip : undefined }}/>
        {costume && <img className="kanata-halloween-costume" src={`${import.meta.env.BASE_URL}kanata-halloween/${costume.file}`} alt={costume.name} draggable={false}/>}
        {error && <span role="alert" className="kanata-halloween-save-error">装扮未保存</span>}
    </span>;
}
export function HalloweenCandyArt({ id, size = 64 }: { id: string; size?: number }) {
    const candy = HALLOWEEN_CANDIES.find(c => c.id === id);
    return <svg width={size} height={size} viewBox="0 0 80 80" role="img" aria-label={candy?.name || '糖果'}>
        <g transform="rotate(-18 40 40)" stroke="#403842" strokeWidth="2.5" strokeLinejoin="round">
            <path d="m23 30-17-9 4 18-4 18 17-9m34-18 17-9-4 18 4 18-17-9" fill={candy?.color || '#ed9849'}/>
            <rect x="21" y="23" width="38" height="34" rx="13" fill={candy?.color || '#ed9849'}/>
            <path d="M32 28q-6 4-6 11" stroke="white" opacity=".7" fill="none"/>
            <path d="m34 36 4 2m8-2-4 2m-6 8q4 3 8 0" fill="none" strokeLinecap="round"/>
        </g>
    </svg>;
}
export function HalloweenPumpkins() {
    const { active } = useKanataHalloween();
    if (!active) return null;
    return <div className="kanata-pumpkins" aria-hidden="true">{[0, 1, 2].map(i => <svg key={i} viewBox="0 0 80 74">
        <path d="m38 18 2-14 9-2-4 17" fill="#738456"/><ellipse cx="40" cy="43" rx="35" ry="27" fill="#d77e39"/>
        <ellipse cx="40" cy="43" rx="22" ry="27" fill="#f0a052"/><path d="m18 38 13-10 3 13zm28 3 3-13 13 10zM20 49l11 6 9-4 9 4 11-6-7 15H28z" fill="#493642"/>
    </svg>)}</div>;
}
export function HalloweenActions({ actorId, name }: { actorId: string; name: string }) {
    const { state, active, error: readError } = useKanataHalloween();
    const [busy, setBusy] = useState(false), lock = useRef(false), [error, setError] = useState(''), [reward, setReward] = useState<string | null>(null);
    if (!active) return readError ? <p role="alert">{readError}</p> : null;
    const run = async (mode: 'change' | 'remove' | 'candy') => {
        if (lock.current) return; lock.current = true; setBusy(true); setError('');
        try {
            let candyId = '', changed = false;
            await mutateFishingMarket(s => {
                if (mode !== 'candy') { const nextState = assignHalloweenCostume(s, actorId, mode); changed = nextState !== s; return nextState; }
                const result = giveHalloweenCandy(s); candyId = result.candyId; changed = result.state !== s; return result.state;
            });
            if (candyId) setReward(candyId);
            if (changed) trackHalloweenFeature(mode);
        } catch (e) { setError((e as Error).message); }
        finally { lock.current = false; setBusy(false); }
    };
    return <section className="kanata-halloween-actions" aria-label={`${name}的万圣节活动`}>
        <div><button disabled={busy} onClick={() => void run('change')}>更换万圣节装扮</button>
            {state.costumes[actorId] && <button disabled={busy} onClick={() => void run('remove')}>去除万圣节装扮</button>}</div>
        {actorId !== 'user' && <button className="kanata-trick-or-treat" disabled={busy} onClick={() => void run('candy')}>不给糖就捣蛋！！</button>}
        {reward && <div className="kanata-candy-reward" role="status"><HalloweenCandyArt id={reward}/><span>{name}递给你一颗<strong>{HALLOWEEN_CANDIES.find(c => c.id === reward)?.name}</strong><small>已收入收藏册 · 万圣节</small></span><button onClick={() => setReward(null)} aria-label="收好糖果">收好</button></div>}
        {error && <p role="alert">{error}</p>}
    </section>;
}

type Scene = { lines: string[]; choices?: { text: string; next: string }[]; end?: 'reward' | 'withdraw' };
export function halloweenScenes(npc: HalloweenNpc, name: string): Record<string, Scene> {
    return npc === 'caian' ? {
        start: { lines: ['万圣夜快乐！！', '发现了吗？大家都穿着可爱的衣服！'], choices: [{ text: '我不喜欢', next: 'dislike' }, { text: '好耶！', next: 'end' }, { text: '不给糖就捣蛋！', next: 'end' }] },
        dislike: { lines: ['诶？？不过万圣节吗？'], choices: [{ text: '嗯', next: 'withdraw' }, { text: '开玩笑的', next: 'end' }] },
        withdraw: { lines: [`那我把活动撤下了哦！既然${name}不喜欢的话，我们应该尊重重要成员的意见！`], end: 'withdraw' },
        end: { lines: ['这是你的糖果，拿好哦！'], end: 'reward' },
    } : {
        start: { lines: ['……', '……幽灵不会说话'], choices: [{ text: '不给糖就捣蛋！', next: 'end' }, { text: '……', next: 'end' }, { text: '为什么你们的立绘没有万圣节装扮？', next: 'portrait' }] },
        portrait: { lines: ['……………………', '据说真正的管理员没有档期', '不能再说了'], choices: [{ text: '继续', next: 'end' }] },
        end: { lines: ['……你或许会喜欢'], end: 'reward' },
    };
}
export function HalloweenDialogue({ npc, userName, onClose, replay = false }: { npc: HalloweenNpc; userName: string; onClose: () => void; replay?: boolean }) {
    const { active } = useKanataHalloween();
    const [node, setNode] = useState('start'), [line, setLine] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(''), [reward, setReward] = useState<string | null>(null);
    const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false);
    const scene = halloweenScenes(npc, userName)[node], last = line === scene.lines.length - 1;
    const counted = useRef(false);
    useEffect(() => {
        dialog.current?.showModal();
        if (!counted.current && (active || replay)) {
            counted.current = true;
            trackHalloweenFeature(replay ? 'replay' : 'dialogue');
        }
    }, [active, replay]);
    useEffect(() => { if (!active && !replay && !lock.current) onClose(); }, [active, replay]);
    const next = async () => {
        if (lock.current) return;
        if (!last) { setLine(i => i + 1); return; }
        if (!scene.end) return;
        if (replay) { onClose(); return; }
        lock.current = true; setBusy(true); setError('');
        try {
            let candyId = '', alreadyCompleted = false;
            await mutateFishingMarket(s => {
                if (!halloweenActive(s)) throw new Error('万圣节活动已经结束或撤下了。');
                alreadyCompleted = !!s.kanataHalloween?.completed.includes(npc);
                const nextState = finishHalloweenDialogue(s, npc, userName, scene.end === 'withdraw');
                candyId = HALLOWEEN_CANDIES.find(c => (nextState.kanataHalloween?.candies[c.id] || 0) > (s.kanataHalloween?.candies[c.id] || 0))?.id || '';
                return nextState;
            });
            if (scene.end === 'withdraw') onClose();
            else {
                if (!alreadyCompleted) trackHalloweenFeature('gift');
                setReward(alreadyCompleted ? 'received' : npc === 'aiven' ? 'halloween-dinosaur' : candyId || 'received');
            }
        } catch (e) { lock.current = false; setError((e as Error).message); }
        finally { setBusy(false); }
    };
    return createPortal(<dialog ref={dialog} className={`srf-dialog srf-${npc} kanata-halloween-dialog`} aria-label={`${npc === 'caian' ? '凯恩' : '艾文'}的万圣节对话`} onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
        <SARDialogueBackdrop/><button className="kanata-halloween-close" onClick={onClose} disabled={busy} aria-label="关闭对话">×</button>
        <div className="srf-body"><div className="srf-stage"><SARDialogueCast speaker={npc}/></div><div className="srf-script">
            <SARDialogueMeta npc={npc} speaker={npc === 'caian' ? '凯恩' : '艾文'}/>
            {reward ? <div className="kanata-dialogue-reward" role="status">{reward === 'halloween-dinosaur' ? <FishArt speciesId="halloween-dinosaur" size={112}/> : reward !== 'received' && <HalloweenCandyArt id={reward} size={80}/>}<p>{reward === 'halloween-dinosaur' ? '收到万圣小恐龙！' : reward === 'received' ? '这份心意已经收好啦。' : `收到${HALLOWEEN_CANDIES.find(c => c.id === reward)?.name}！`}</p><small>已收入收藏册{reward === 'halloween-dinosaur' ? '，也可以带去恐龙箱庭。' : ' · 万圣节'}</small><button onClick={onClose}>收好</button></div> : <>
                <button autoFocus className="srf-bubble" onClick={() => void next()} disabled={busy || (last && !!scene.choices)} aria-label="继续对话"><span className="srf-line">{scene.lines[line]}</span><span className="srf-next">{busy ? '正在收好…' : last && scene.choices ? '选择回应' : '点击继续'}</span></button>
                {last && scene.choices && <div className="kanata-halloween-choices">{scene.choices.map(choice => <button key={choice.text} onClick={() => { setNode(choice.next); setLine(0); }}>{choice.text}</button>)}</div>}
            </>}{error && <p role="alert">{error}</p>}
        </div></div>
    </dialog>, document.body);
}

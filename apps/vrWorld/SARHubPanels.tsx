import { HalloweenCandyArt } from './KanataHalloween';
import { SARFacilityGuide } from './SARFacilityGuide';
import { SARPageNav } from './SARCharacterPicker';
import { SARFamiliarityKeepsake } from './SARFamiliarityKeepsake';
import { freshFamiliarity } from '../../utils/vrWorld/sarFamiliarity/storageTypes';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, CaretDown, Coins, Cpu, Package, Stack, X, Ticket, IdentificationCard } from '@phosphor-icons/react';
import type { CharacterProfile, UserProfile } from '../../types';
import { ensureSARCommerce, readSARCommerce } from '../../utils/vrWorld/sarCommerce';
import { ensureActorAccounts, listMarketActors, mutateFishingMarket, type FishingMarketState } from '../../utils/vrWorld/fishingMarket';
import { remainingSARBuyback, SAR_DAILY_BUYBACK } from '../../utils/vrWorld/sarEconomy';
import { sarWarehouseItems, type SARWarehouseItem } from '../../utils/vrWorld/sarWarehouse';
import { FishArt } from './FishArt';
import { SARNpcChibi } from './SARNpcArt';
import { SARCollectionView } from './SARCollectionView';
import { KanataTitleEditor } from './KanataTitleEditor';
import './sar-hub.css';
import './sar-collection-theme.css';

export type SARHubPanel = 'settings' | 'warehouse';
const WAREHOUSE_PAGE_SIZE = 12;
export function SARHubPanels({ panel, onClose, npcEnabled, onChangeNpc, caianMet, onRequestRewind, userProfile, characters, backRef, onOpenFamiliarity }: {
    onOpenFamiliarity?: (npc:'caian'|'aiven',sceneId?:string)=>void;
    panel: SARHubPanel; onClose: () => void; npcEnabled: boolean; onChangeNpc: (preference: 'show' | 'hide') => void;
    caianMet: boolean; onRequestRewind: () => void;
    userProfile: UserProfile; characters: CharacterProfile[];
    backRef: React.MutableRefObject<(() => boolean) | null>;
}) {
    const root = useRef<HTMLElement>(null);
    const warehouseRef = useRef<HTMLElement>(null);
    const [market, setMarket] = useState<FishingMarketState | null>(null);
    const [error, setError] = useState('');
    const [ownerId, setOwnerId] = useState('user');
    const [filter, setFilter] = useState<'all' | SARWarehouseItem['kind']>('all');
    const [itemPage, setItemPage] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [collection, setCollection] = useState(false);
    const collectionBack = useRef<(() => boolean) | null>(null);
    useEffect(() => { if (!npcEnabled) { setFilter('all'); setSelectedId(null); } }, [npcEnabled]);
    const goBack = () => {
        if (collection) { if (!collectionBack.current?.()) setCollection(false); return true; }
        if (selectedId) { setSelectedId(null); return true; }
        return false;
    };
    useEffect(() => { backRef.current = goBack; return () => { backRef.current = null; }; }, [collection, selectedId]);
    const actors = useMemo(() => listMarketActors(userProfile, characters), [userProfile.name, characters]);
    const owner = actors.find(a => a.id === ownerId) || actors[0];
    const items = (market ? sarWarehouseItems(market, owner.id) : []).filter(item => npcEnabled || (item.kind !== 'souvenir' && !['aiven-chimera','dinosaur-egg'].includes(item.speciesId || '')));
    const shown = items.filter(item => filter === 'all' || item.kind === filter);
    const itemPages = Math.max(1, Math.ceil(shown.length / WAREHOUSE_PAGE_SIZE)), page = Math.min(itemPage, itemPages - 1);
    const visibleItems = shown.slice(page * WAREHOUSE_PAGE_SIZE, (page + 1) * WAREHOUSE_PAGE_SIZE);
    const selected = items.find(item => item.id === selectedId);
    const keepsake = npcEnabled && owner.id === 'user' ? market?.sarFamiliarity?.souvenirs.find(s=>s.id===selectedId) : undefined;
    const runtime = owner.id === 'user' ? userProfile.vrState?.sarModule : characters.find(c => c.id === owner.id)?.vrState?.sarModule;
    useEffect(() => { setSelectedId(null); setFilter('all'); setItemPage(0); }, [owner.id]);
    useEffect(() => {
        if (panel !== 'warehouse') return;
        let live = true;
        const refresh = () => {
            try { const state = readSARCommerce().market; if (live) { setMarket(ensureActorAccounts(state, actors)); setError(''); } }
            catch (cause) { if (live) setError(cause instanceof Error ? cause.message : '仓库暂时无法读取'); }
        };
        void (async () => {
            try { await ensureSARCommerce(); await mutateFishingMarket(state => {
                const next=ensureActorAccounts(state,actors);
                if(userProfile.vrState?.title||characters.some(c=>c.vrState?.title)){const familiarity=structuredClone(next.sarFamiliarity||freshFamiliarity());if(!familiarity.unlocks.includes('titles'))familiarity.unlocks.push('titles');next.sarFamiliarity=familiarity;}
                return next;
            }); refresh(); }
            catch (cause) { if (live) setError(cause instanceof Error ? cause.message : '仓库暂时无法读取'); }
        })();
        window.addEventListener('vr-fishing-market-updated', refresh);
        window.addEventListener('storage', refresh);
        window.addEventListener('focus', refresh);
        const timer = window.setInterval(refresh, 30_000);
        return () => { live = false; clearInterval(timer); window.removeEventListener('vr-fishing-market-updated', refresh); window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); };
    }, [panel, actors]);
    useEffect(() => {
        const prior = document.activeElement as HTMLElement | null;
        root.current?.querySelector<HTMLButtonElement>('button')?.focus();
        return () => { prior?.focus(); };
    }, []);
    useEffect(() => { root.current?.querySelector<HTMLButtonElement>('header button')?.focus({ preventScroll: true }); }, [collection]);
    useEffect(() => {
        if (collection) return;
        const target = window as Window & { render_game_to_text?: () => string; advanceTime?: (ms: number) => void };
        const render = () => JSON.stringify({ mode: 'sar-hub', panel, npcEnabled, ownerId: owner.id, balance: market?.accounts[owner.id], filter, page: page + 1, pages: itemPages, totalItems: shown.length, items: visibleItems.map(({ id, title, count, status }) => ({ id, title, count, status })) });
        const advance = (_ms: number) => {};
        target.render_game_to_text = render;
        target.advanceTime = advance;
        return () => { if (target.render_game_to_text === render) delete target.render_game_to_text; if (target.advanceTime === advance) delete target.advanceTime; };
    }, [panel, npcEnabled, owner.id, market, filter, collection, page]);
    const keyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Escape') { event.stopPropagation(); if (!goBack()) onClose(); }
        if (event.key !== 'Tab') return;
        const focusables = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select,[tabindex="0"]') || []);
        const first = focusables[0], last = focusables.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    return <div className="sar-hub-backdrop">
        <section ref={root} className={`sar-hub-panel${collection ? ' is-collection' : ''}`} role="dialog" aria-modal="true" aria-label={panel === 'settings' ? '活动室设置' : collection ? '收集图鉴' : '随身仓库'} onKeyDown={keyDown}>
            {collection && market ? <SARCollectionView npcEnabled={npcEnabled} market={market} owner={owner} actors={actors} onOwnerChange={setOwnerId} onClose={() => setCollection(false)} backRef={collectionBack} onOpenFamiliarity={onOpenFamiliarity}/> : <>
            <header className="sar-hub-header"><button type="button" onClick={onClose} aria-label="返回活动室"><ArrowLeft size={21}/></button><div><small>SAR · ACTIVITY ROOM</small><h2>{panel === 'settings' ? '活动室设置' : '随身仓库'}</h2></div>{panel === 'warehouse' && <button className="sar-hub-collection-link" type="button" aria-label="打开收集图鉴" disabled={!market || !!error} onClick={() => { setSelectedId(null); setCollection(true); }}><BookOpen size={20}/><span>图鉴</span></button>}{panel === 'warehouse' && <SARFacilityGuide facility="warehouse"/>}</header>
            {panel === 'settings' ? <main className="sar-hub-settings">
                <div className="sar-hub-residents" aria-hidden="true"><SARNpcChibi who="caian"/><SARNpcChibi who="aiven"/></div>
                <div className="sar-hub-setting-row"><div><h3>常驻 NPC</h3><p>让凯恩与艾文出现在活动室里。</p></div>
                    <button className="sar-hub-toggle" type="button" role="switch" aria-label="显示常驻 NPC" aria-checked={npcEnabled} onClick={() => onChangeNpc(npcEnabled ? 'hide' : 'show')}><span/></button>
                </div>
                <p className="sar-hub-muted">{npcEnabled ? '点击房间里的他们，就能聊聊天。' : 'NPC、称号、名册与专属纪念已关闭，进度会保留。'}<br/>扭蛋、模块、布告板和水域始终开放。</p>
                {npcEnabled && <div className="sar-hub-setting-row"><div><h3>初见回档</h3><p>重新遇见凯恩，用其他选择再走一遍初见。</p></div>
                    <button className="sar-hub-setting-action" type="button" onClick={onRequestRewind} disabled={!caianMet}>{caianMet?'回到初见前':'剧情未完成'}</button>
                </div>}
            </main> : <main ref={warehouseRef} className="sar-hub-warehouse">
                <div className="sar-hub-owner"><span>正在查看</span><label><select aria-label="仓库主人" value={owner.id} onChange={event => setOwnerId(event.target.value)}>{actors.map(actor => <option key={actor.id} value={actor.id}>{actor.id === 'user' ? '我' : actor.name}</option>)}</select><CaretDown size={16}/></label></div>
                {npcEnabled && <KanataTitleEditor key={owner.id} ownerId={owner.id} unlocked={!!market?.sarFamiliarity?.unlocks.includes('titles') || !!userProfile.vrState?.title || characters.some(c=>!!c.vrState?.title)} earnedTitles={market?.sarFamiliarity?.titles}/>}
                {error ? <p role="alert" className="sar-hub-error">{error}</p> : !market ? <p role="status" className="sar-hub-muted">正在打开仓库…</p> : <>
                    <div className="sar-hub-wallet"><div><span><Coins size={17}/>钱包余额</span><p><strong data-testid="sar-wallet-balance">{market.accounts[owner.id].toLocaleString()}</strong><small>鳞币</small></p></div><Package size={48} weight="light" aria-hidden="true"/></div>
                    <p className="sar-hub-allowance">今日还可回收 {remainingSARBuyback(market.buybackBudgets, owner.id)} / {SAR_DAILY_BUYBACK} 鳞币</p>
                    <nav className="sar-hub-filters" aria-label="物品分类">{([['all', '全部'], ['chip', '芯片'], ['module', '模块'], ['catch', '收藏'], ['souvenir', '纪念'], ['coupon','优惠券'], ['candy','糖果']] as const).filter(([value])=>npcEnabled || value !== 'souvenir').map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setSelectedId(null); setItemPage(0); }}>{label}</button>)}</nav>
                    <div className="sar-hub-inventory-bar">
                        <div className="sar-hub-inventory-count" role="status"><strong>共 {shown.length} 条</strong><span>每页 {WAREHOUSE_PAGE_SIZE} 条</span></div>
                        {shown.length > 0 && <SARPageNav page={page} pages={itemPages} showSinglePage onChange={next => { setItemPage(next); setSelectedId(null); warehouseRef.current?.scrollTo({ top: 0 }); }} label="仓库物品"/>}
                    </div>
                    {shown.length ? <div className="sar-hub-items">{visibleItems.map(item => <button type="button" className="sar-hub-item" key={item.id} aria-pressed={selectedId === item.id} onClick={() => setSelectedId(selectedId === item.id ? null : item.id)} aria-label={`${item.title} · ${item.count} 件 · ${item.status}`}>
                        <span className={`sar-hub-item-art is-${item.kind}`}>{item.speciesId ? <FishArt speciesId={item.speciesId} halloweenHat={item.halloweenHat} size={84}/> : item.kind === 'candy' ? <HalloweenCandyArt id={item.id}/> : item.kind === 'chip' ? <Stack size={35} weight="duotone"/> : item.kind === 'souvenir' ? <IdentificationCard size={35} weight="duotone"/> : item.kind === 'coupon' ? <Ticket size={35} weight="duotone"/> : <Cpu size={35} weight="duotone"/>}<b>×{item.count}</b></span><strong>{item.title}</strong><small>{item.status}</small>
                    </button>)}</div> : <div className="sar-hub-empty"><Package size={38} weight="light"/><h3>{filter === 'all' ? '仓库还是空的' : '还没有这类物品'}</h3><p>{owner.id === 'user' ? '钓到的收藏、抽到的芯片和买下的模块，会放在这里。' : `${owner.name}获得的物品，会留在自己的仓库里。`}</p></div>}
                    {selected && !keepsake && <aside className="sar-hub-item-detail" aria-live="polite"><button type="button" aria-label="收起物品详情" onClick={() => setSelectedId(null)}><X size={17}/></button><h3>{selected.title}</h3><p>{selected.detail}</p><small>{selected.count} 件 · {selected.status}</small></aside>}
                    {runtime && <p className="sar-hub-equipped"><Cpu size={16}/><span>正在装载「{runtime.moduleTitle}」<small>{runtime.phase === 'active' ? `还剩 ${runtime.remainingTurns} 次成功互动` : '效果已结束，余韵中'}</small></span></p>}
                </>}
            </main>}
            </>}
            {keepsake && <SARFamiliarityKeepsake key={keepsake.id} item={keepsake} onClose={()=>setSelectedId(null)}/>}
        </section>
    </div>;
}

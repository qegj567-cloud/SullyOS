import { trackSARFeature } from '../../utils/sarAnalytics';
import { trackHalloweenFeature } from '../../utils/octoberAnalytics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, CaretDown, CaretLeft, CaretRight, Check, Cpu, Fish, MagnifyingGlass, PawPrint, Stack, Users } from '@phosphor-icons/react';
import type { FishingMarketState, MarketActor } from '../../utils/vrWorld/fishingMarket';
import { sarCollectionEntries, sarCollectionProgress, type SARCollectionCategory, type SARCollectionEntry } from '../../utils/vrWorld/sarCollection';
import { FishArt } from './FishArt';
import { SARFamiliarityRoster } from './SARFamiliarityRoster';
import { SARExclusiveKeepsakes } from './SARExclusiveKeepsakes';
import type { FamiliarityNpc } from '../../utils/vrWorld/sarFamiliarity/types';
import { HalloweenCandyArt, HalloweenDialogue } from './KanataHalloween';
import { HALLOWEEN_COSTUMES, type HalloweenNpc } from '../../utils/vrWorld/kanataHalloween';

const Icons = { fish: Fish, dinosaur: PawPrint, chip: Stack, module: Cpu, halloween: BookOpen };
const PAGE_SIZE = 12;
function CollectionArt({ entry, size = 56 }: { entry: SARCollectionEntry; size?: number }) {
    const Icon = Icons[entry.category];
    const costume = HALLOWEEN_COSTUMES.find(c => c.id === entry.id);
    if (costume) return <img src={`${import.meta.env.BASE_URL}kanata-halloween/${costume.file}`} alt={entry.title} style={{ width:size+28,height:size+28,objectFit:'contain',filter:entry.collected?undefined:'grayscale(1)',opacity:entry.collected?1:.35 }}/>;
    if (entry.category === 'halloween' && entry.tag === '糖果') return <span style={{opacity:entry.collected?1:.3}}><HalloweenCandyArt id={entry.id} size={size+20}/></span>;
    return entry.speciesId ? <FishArt speciesId={entry.speciesId} halloweenHat={entry.halloweenHat} size={size + 28} silhouette={!entry.collected}/> : <Icon size={size} weight={entry.collected ? 'duotone' : 'thin'}/>;
}
export function SARCollectionView({ market, owner, actors, onOwnerChange, onClose, backRef, onOpenFamiliarity, npcEnabled = true }: {
    npcEnabled?: boolean;
    market: FishingMarketState; owner: MarketActor; actors: MarketActor[]; onOwnerChange: (id: string) => void; onClose: () => void;
    backRef: React.MutableRefObject<(() => boolean) | null>;
    onOpenFamiliarity?: (npc: FamiliarityNpc, sceneId?: string) => void;
}) {
    const [requestedSection, setSection] = useState<'collection' | 'roster' | 'keepsakes'>('collection');
    const [halloweenReplay, setHalloweenReplay] = useState<HalloweenNpc | null>(null);
    const section = npcEnabled ? requestedSection : 'collection';
    useEffect(() => { if (!npcEnabled) { setSection('collection'); setKeepsakeTitle(null); } }, [npcEnabled]);
    useEffect(() => { if (section !== 'keepsakes') trackSARFeature(section); }, [section]);
    const keepsakeBack = useRef<(() => boolean) | null>(null);
    const [keepsakeTitle,setKeepsakeTitle]=useState<string|null>(null);
    const [category, setCategory] = useState<SARCollectionCategory | null>(null);
    useEffect(() => { if (category === 'halloween') trackHalloweenFeature('collection'); }, [category]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<'all' | 'collected' | 'missing'>('all');
    const [page, setPage] = useState(0);
    const scroll = useRef<HTMLElement>(null);
    const headerBack=useRef<HTMLButtonElement>(null);
    const entries = useMemo(() => sarCollectionEntries(market, owner.id, npcEnabled), [market, owner.id, npcEnabled]);
    const progress = sarCollectionProgress(entries);
    const current = progress.find(item => item.id === category);
    const selected = entries.find(item => item.id === selectedId);
    const matches = entries.filter(item => item.category === category && (filter === 'all' || item.collected === (filter === 'collected')) && `${item.title} ${item.tag}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
    const shown = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    const collected = entries.filter(item => item.collected).length;
    const goBack = () => {
        if (halloweenReplay) { setHalloweenReplay(null); return true; }
        if (section === 'keepsakes' && keepsakeBack.current?.()) return true;
        if (section !== 'collection') return false;
        if (selectedId) { setSelectedId(null); return true; }
        if (category) { setCategory(null); return true; }
        return false;
    };
    useEffect(() => { backRef.current = goBack; return () => { backRef.current = null; }; }, [selectedId, category, section, halloweenReplay]);
    useEffect(() => { setSelectedId(null); setQuery(''); setFilter('all'); setPage(0); }, [owner.id, category]);
    useEffect(() => { setPage(0); }, [query, filter]);
    useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [category, selectedId, currentPage, owner.id]);
    // Replacing a grid removes its focused button; keep Escape/Tab inside the dialog.
    useEffect(() => { headerBack.current?.focus({ preventScroll: true }); }, [category, selectedId, keepsakeTitle]);
    useEffect(() => {
        if (section !== 'collection') return;
        const target = window as Window & { render_game_to_text?: () => string };
        const render = () => JSON.stringify({ mode: 'sar-collection', ownerId: owner.id, category, selectedId, progress, page: currentPage + 1, pages, filter, entries: shown.map(({ id, title, collected, owned }) => ({ id, title, collected, owned })) });
        target.render_game_to_text = render;
        return () => { if (target.render_game_to_text === render) delete target.render_game_to_text; };
    }, [owner.id, category, selectedId, market, query, filter, currentPage, section]);
    const chipProgress = (tag: string) => { const chips = entries.filter(entry => entry.category === 'chip' && entry.tag === tag); return `${chips.filter(entry => entry.collected).length} / ${chips.length}`; };

    return <>
        {halloweenReplay && npcEnabled && <HalloweenDialogue key={halloweenReplay} npc={halloweenReplay} userName={actors.find(a => a.id === 'user')?.name || '我'} replay onClose={() => setHalloweenReplay(null)}/>}
        <header className="sar-hub-header"><button ref={headerBack} type="button" onClick={() => { if (!goBack()) onClose(); }} aria-label={section==='keepsakes'&&keepsakeTitle?'返回专属纪念':section==='collection'&&selected?'返回分类图鉴':section==='collection'&&category?'返回图鉴总览':'返回随身仓库'}><ArrowLeft size={21}/></button><div><small>SAR · COLLECTION</small><h2>{section==='keepsakes'&&keepsakeTitle?keepsakeTitle:section==='collection'&&selected?selected.title:section==='collection'&&current?`${current.title}图鉴`:'收集图鉴'}</h2></div></header>
        <nav className="sar-collection-sections" aria-label="图鉴页面">
            <button type="button" aria-current={section==='collection'?'page':undefined} onClick={()=>setSection('collection')}><BookOpen size={16} weight={section==='collection'?'fill':'regular'}/>收藏</button>
            {npcEnabled && <><button type="button" aria-current={section==='keepsakes'?'page':undefined} onClick={()=>setSection('keepsakes')}><BookOpen size={16} weight={section==='keepsakes'?'fill':'regular'}/>专属纪念</button>
            <button type="button" aria-current={section==='roster'?'page':undefined} onClick={()=>setSection('roster')}><Users size={16} weight={section==='roster'?'fill':'regular'}/>名册</button></>}
        </nav>
        {section==='roster'?<SARFamiliarityRoster onOpenScene={(npc,sceneId)=>onOpenFamiliarity?.(npc,sceneId)}/>:section==='keepsakes'?<SARExclusiveKeepsakes market={market} backRef={keepsakeBack} onDetailChange={setKeepsakeTitle}/>:<>
        <main ref={scroll} className="sar-hub-warehouse sar-collection">
            <div className="sar-hub-owner"><span>正在查看</span><label><select aria-label="图鉴主人" value={owner.id} onChange={event => onOwnerChange(event.target.value)}>{actors.map(actor => <option key={actor.id} value={actor.id}>{actor.name}</option>)}</select><CaretDown size={16}/></label></div>
            {selected ? <article className="sar-collection-entry">
                <div className={`sar-collection-large-art ${selected.collected ? 'is-collected' : ''}`}><CollectionArt entry={selected} size={100}/></div>
                <div className="sar-collection-entry-status">{selected.collected ? <Check size={15}/> : <BookOpen size={15}/>}<span>{selected.collected ? '已收录' : '尚未收录'} · {selected.tag}</span></div>
                <p>{selected.description}</p><div className="sar-collection-source"><strong>获得方式</strong><p>{selected.source}</p></div>
                {selected.collected && selected.id.startsWith('halloween-memory-') && <button type="button" className="sar-hub-setting-action" onClick={() => setHalloweenReplay(selected.id.endsWith('caian') ? 'caian' : 'aiven')}>重看万圣节对话</button>}
                {selected.collected && <p className="sar-collection-owned">当前持有 {selected.owned} 件{selected.owned === 0 ? ' · 已用掉或转出，收集记录保留' : ''}</p>}
            </article> : !category ? <>
                <div className="sar-collection-total"><BookOpen size={29} weight="light"/><div><p><strong>{collected}</strong><span>/ {entries.length} 种</span></p><small>已经收录的相遇</small></div></div>
                <div className="sar-collection-categories">{progress.map(item => { const Icon = Icons[item.id]; return <button type="button" key={item.id} aria-label={`${item.title}图鉴 · 已收录 ${item.collected} / ${item.total} 种`} onClick={() => setCategory(item.id)}>
                    <span className={`sar-collection-category-icon is-${item.id}`}><Icon size={29} weight="duotone"/></span><div><span><strong>{item.title}</strong><small>{item.collected} / {item.total}</small></span><p>{item.description}</p><i role="progressbar" aria-label={`${item.title}收集进度`} aria-valuemin={0} aria-valuemax={item.total} aria-valuenow={item.collected}><b style={{ width: `${item.total ? item.collected / item.total * 100 : 0}%` }}/></i></div><CaretRight size={16}/>
                </button>; })}</div>
                <p className="sar-hub-muted sar-collection-footnote">同一种物品只点亮一次。用掉或转让后，收录记录仍会留下。</p>
            </> : <>
                <div className="sar-collection-category-progress"><strong>{current?.collected}<small> / {current?.total} 种已收录</small></strong>{category === 'chip' && <span>变体 {chipProgress('变体芯片')} · 故事 {chipProgress('故事芯片')}</span>}</div>
                {category === 'chip' && owner.id !== 'user' && <p className="sar-hub-muted">角色短篇演绎使用的临时芯片不计入永久收集。</p>}
                <div className="sar-collection-controls"><label><MagnifyingGlass size={16}/><input aria-label="搜索图鉴" placeholder="找一找…" value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label="图鉴收录状态" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">全部</option><option value="collected">已收录</option><option value="missing">未收录</option></select></div>
                {shown.length ? <div className="sar-hub-items">{shown.map(entry => <button type="button" key={entry.id} className={`sar-hub-item sar-collection-item ${entry.collected ? 'is-collected' : 'is-missing'}`} onClick={() => setSelectedId(entry.id)} aria-label={`${entry.title} · ${entry.collected ? '已收录' : '尚未收录'}`}>
                    <span className={`sar-hub-item-art is-${entry.category}`}><CollectionArt entry={entry} size={35}/>{entry.collected && <Check className="sar-collection-tick" size={14}/>}</span><strong>{entry.title}</strong><small>{entry.collected ? '已收录' : '尚未收录'}</small>
                </button>)}</div> : <p className="sar-collection-no-results">{query ? '没有找到匹配的条目。' : filter === 'missing' ? '这一类已经集齐了。' : '还没有收录这类物品。'}</p>}
                {pages > 1 && <nav className="sar-collection-pages" aria-label="图鉴翻页"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="上一页图鉴"><CaretLeft size={16}/></button><span>{currentPage + 1} / {pages}</span><button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)} aria-label="下一页图鉴"><CaretRight size={16}/></button></nav>}
            </>}
        </main></> }
    </>;
}

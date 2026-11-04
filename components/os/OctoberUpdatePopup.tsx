import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChatCircle, Heart, X } from '@phosphor-icons/react';
import { trackEvent } from '../../utils/analytics';
import { OCTOBER_CHANGELOG, OCTOBER_UPDATE_KEY } from '../../utils/octoberUpdate';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import BibiIcon from './BibiIcon';
import caian from '../../assets/sar/caian-chibi.png';
import aiven from '../../assets/sar/aiven-chibi.png';
import './october-update.css';

const costumes = [
    { file: 'black-cat', base: caian, clip: 'ellipse(29% 28% at 50% 53%)' },
    { file: 'little-devil', base: aiven },
    { file: 'ghost-cloak', base: caian, clip: 'ellipse(20% 20% at 50% 52%)' },
];
const pages = ['彼方万圣夜', '3D 家园万圣系列', '哔哔新 App'] as const;
const asset = (path: string) => import.meta.env.BASE_URL + path;

export default function OctoberUpdatePopup({ onDone, preview = false }: {
    onDone: () => void;
    /** Isolated design preview: no read receipt and no analytics. */
    preview?: boolean;
}) {
    const [page, setPage] = useState(0);
    const dialog = useRef<HTMLDialogElement>(null), scroll = useRef<HTMLDivElement>(null);
    const shown = useRef(false), finished = useRef(false), changedPage = useRef(false);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const element = dialog.current;
        element?.showModal();
        element?.querySelector<HTMLButtonElement>('.october-release-primary')?.focus({ preventScroll: true });
        if (!shown.current && !preview) { shown.current = true; trackEvent('弹出版本更新提醒', { 版本: OCTOBER_CHANGELOG }); }
        return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
    }, [preview]);
    useEffect(() => {
        if (scroll.current) scroll.current.scrollTop = 0;
        if (changedPage.current) dialog.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    }, [page]);
    const turnPage = (next: number) => { changedPage.current = true; setPage(Math.max(0, Math.min(2, next))); };
    const finish = (completed = false) => {
        if (finished.current) return;
        finished.current = true;
        if (!preview) {
            try { localStorage.setItem(OCTOBER_UPDATE_KEY, '1'); } catch { /* Closing still works when storage is unavailable. */ }
            trackEvent(completed ? '查看更新说明' : '跳过本次更新说明', { 版本: OCTOBER_CHANGELOG });
        }
        onDone();
    };
    useLocalBackHandler(() => { if (page > 0) turnPage(page - 1); else finish(); return true; }, 100);

    return <dialog ref={dialog} className={'october-release october-theme-' + page} aria-labelledby="october-release-title" onCancel={e => { e.preventDefault(); finish(); }}>
        <header className="october-release-top"><span>SullyOS <i>糯米机</i></span><span>v3.15 · 十月更新</span><button type="button" aria-label="关闭十月更新介绍" onClick={() => finish()}><X size={19}/></button></header>
        <div ref={scroll} className="october-release-scroll">
            <div key={page} className="october-release-page">
                {page === 0 ? <>
                    <section className="october-release-hero">
                        <p className="october-release-date">10.29 — 10.31 <span>彼方限时活动</span></p>
                        <h2 id="october-release-title" tabIndex={-1}>彼方也要<span>万圣节！</span></h2>
                        <p className="october-release-intro">换一身小衣服，敲敲门，讨颗糖。</p>
                        <div className="october-release-cast" role="img" aria-label="黑猫、小恶魔与小幽灵装扮预览">
                            <span className="october-release-star star-one" aria-hidden="true">✦</span><span className="october-release-star star-two" aria-hidden="true">✧</span>
                            {costumes.map(c => <figure key={c.file}><img src={c.base} style={{clipPath:c.clip}} alt="" draggable={false}/><img src={asset('kanata-halloween/' + c.file + '.png')} alt="" draggable={false}/></figure>)}
                            <span className="october-release-bubble">不给糖就捣蛋！</span>
                        </div>
                    </section>
                    <div className="october-release-copy">
                        <section className="october-release-feature"><h3>大家都换好了，就等你来</h3><p>五套随机装扮，点点角色就能换装、讨糖。凯恩和艾文也准备了万圣节特别对话。</p></section>
                        <section className="october-release-feature"><h3>把万圣夜留在收藏册里</h3><p>收集糖果，领走戴巫师帽的黑紫小恐龙！活动期间钓到的鱼，也有自己的万圣节帽子。</p></section>
                        <p className="october-release-note">10 月 29 日开场，31 日结束。<br/>已经获得的糖果、恐龙和收藏，活动结束后都会保留。</p>
                    </div>
                </> : page === 1 ? <>
                    <section className="october-release-hero">
                        <p className="october-release-date">3D HOME <span>万圣系列上新</span></p>
                        <h2 id="october-release-title" tabIndex={-1}>家里也要<span>过万圣！</span></h2>
                        <p className="october-release-intro">打开节日衣橱，把小屋也装扮起来。</p>
                        <div className="october-release-wardrobe" role="img" aria-label="3D 家园巫师裙、南瓜装与幽灵上衣预览">
                            <span className="october-wardrobe-rail"/>
                            <img className="october-outfit-left" src={asset('room3d/wardrobe/thumbnails/halloween-pumpkin-romper.png')} alt=""/>
                            <img className="october-outfit-main" src={asset('room3d/wardrobe/thumbnails/halloween-witch-dress.png')} alt=""/>
                            <img className="october-outfit-right" src={asset('room3d/wardrobe/thumbnails/halloween-ghost-hooded-top.png')} alt=""/>
                            <span className="october-wardrobe-label">今晚，穿哪一件？</span>
                        </div>
                    </section>
                    <div className="october-release-copy">
                        <section className="october-release-feature"><h3>小人的节日衣橱</h3><p>巫师、南瓜、幽灵……万圣节衣服和配饰来了，给小人搭一套今晚的新造型。</p></section>
                        <section className="october-release-feature"><h3>小屋的万圣节布置</h3><p>点亮南瓜灯，摆上蝙蝠沙发，还有一整套万圣家具。布置好房间，再留下一张合影。</p></section>
                        <p className="october-release-note">在 3D 家园的换装和布置房屋中，找到这次的新系列。</p>
                    </div>
                </> : <>
                    <section className="october-release-hero">
                        <p className="october-release-date">BIBI <span>独立 App 上线</span></p>
                        <h2 id="october-release-title" tabIndex={-1}>来哔哔，<span>聊点日常</span></h2>
                        <p className="october-release-intro">今天的小事，也想讲给你听。</p>
                        <div className="october-release-bibi" role="img" aria-label="哔哔日常动态与评论示意">
                            <div className="october-bibi-post"><span className="october-bibi-caption">今日份日常</span><p>把今天的小开心<br/>也分享给你。</p><span className="october-bibi-reactions"><Heart size={17}/><ChatCircle size={17}/><span>朋友们的留言板</span></span></div>
                            <BibiIcon className="october-bibi-mascot" size={106}/>
                            <span className="october-bibi-reply">我也有好多话想说！</span>
                        </div>
                    </section>
                    <div className="october-release-copy">
                        <section className="october-release-feature"><h3>朋友们的新动态</h3><p>发一条图文，刷刷大家的日常，在评论区接着聊。回复与留言，也有了自己的提醒。</p></section>
                        <section className="october-release-feature"><h3>关注你想认识的每一面</h3><p>管理角色的小号、关注和身份关系，让朋友们的日常在这里相遇。</p></section>
                        <p className="october-release-note">桌面上的哔哔 App、家园里的小手机，都能打开这块留言板。</p>
                    </div>
                </>}
            </div>
        </div>
        <footer className="october-release-footer">
            <div className="october-release-progress"><span role="status">{page + 1} / 3 · {pages[page]}</span><span className="october-release-steps" aria-hidden="true">{pages.map((name, i) => <i key={name} className={page === i ? 'active' : ''}/>)}</span></div>
            <div className="october-release-actions"><button type="button" disabled={page === 0} onClick={() => turnPage(page - 1)}><ArrowLeft size={16}/> 上一页</button><button type="button" className="october-release-primary" autoFocus onClick={() => page < 2 ? turnPage(page + 1) : finish(true)}>{page < 2 ? <>下一页 <ArrowRight size={18}/></> : '知道啦'}</button></div>
        </footer>
    </dialog>;
}

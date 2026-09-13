import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Lightning, PaperPlaneTilt, X } from '@phosphor-icons/react';
import roomArt from '../../assets/sar-club-room.png';
import { trackEvent } from '../../utils/analytics';
import { SAR_CHANGELOG, SAR_UPDATE_KEY } from '../../utils/sarUpdate';
import './sar-update.css';

const PAGES = ['在彼方相遇', '顺手地聊天', '一张图分享'] as const;

/** 独立展示层，公告和自动化预览共用。只在用户明确离开时记为已读。 */
export function SARUpdatePopup({ onDone, onVisit, onGuide }: {
    onDone: () => void; onVisit: () => void; onGuide: () => void;
}) {
    const [page, setPage] = useState(0);
    const root = useRef<HTMLElement>(null);
    const dismiss = useRef(() => {});
    const seen = () => { try { localStorage.setItem(SAR_UPDATE_KEY, '1'); } catch { /* 本次仍可关闭 */ } };
    dismiss.current = () => { seen(); trackEvent('跳过本次更新说明', { 版本: SAR_CHANGELOG }); onDone(); };
    useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: SAR_CHANGELOG });
        const previous = document.activeElement as HTMLElement | null;
        root.current?.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current(); }
            if (event.key !== 'Tab') return;
            const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || []);
            const first = nodes[0], last = nodes[nodes.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus(); }
        };
        document.addEventListener('keydown', keydown, true);
        return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
    }, []);
    const turn = (index: number) => { setPage(index); root.current?.querySelector('.sar-release-scroll')?.scrollTo(0, 0); };
    return <div className="sar-release-overlay">
        <section ref={root} className="sar-release" role="dialog" aria-modal="true" aria-labelledby="sar-release-title" tabIndex={-1}>
            <header className="sar-release-header"><span>SullyOS·糯米机 <i>✦</i> VOL. 3.10</span><span>彼方来信 / 2026.09</span>
                <button aria-label="关闭更新公告" onClick={() => dismiss.current()}><X size={19}/></button>
            </header>
            <div className="sar-release-scroll">
                <div key={page} className="sar-release-page">
                    {page === 0 ? <>
                        <div className="sar-release-art">
                            <img className="sar-release-room" src={roomArt} alt="SAR 活动室原画" draggable={false}/>
                            <div className="sar-release-orbit" aria-hidden="true"/>
                            <span className="sar-release-room-mark" aria-hidden="true">SAR</span>
                            <img className="sar-release-caian" src={`${import.meta.env.BASE_URL}sar-portraits/Caian/normal.webp`} alt="凯恩" draggable={false}/>
                            <img className="sar-release-aiven" src={`${import.meta.env.BASE_URL}sar-portraits/Aiven/normal.webp`} alt="艾文" draggable={false}/>
                            <span className="sar-release-seal">ACTIVITY<br/>ROOM<br/><b>✦</b></span>
                        </div>
                        <div className="sar-release-copy">
                            <p className="sar-release-kicker">01 / 一扇新门，为你留着</p>
                            <h2 id="sar-release-title">去彼方，<br/>一起虚度时光。</h2>
                            <p>凯恩与艾文，正在 SAR 活动室等你。<br/>从一句日常问候开始，把陌生聊成熟悉。</p>
                            <div className="sar-release-features"><span>交谈 · 星级故事</span><span>钓鱼 · 恐龙花园</span><span>芯片 · 推演 · 模块</span></div>
                            <p className="sar-release-note">慢慢收集，慢慢相熟。走过的故事和收下的纪念，都留在收藏册里。</p>
                        </div>
                    </> : page === 1 ? <>
                        <div className="sar-release-copy sar-release-copy-top">
                            <p className="sar-release-kicker">02 / 回复，就在手边</p>
                            <h2 id="sar-release-title">不用再够<br/>右上角的闪电。</h2>
                            <p>任意私聊 → 输入框旁「＋」→「设置」<br/>在顶部「输入与发送」里调整，点「保存设置」。<br/>一次设置，所有私聊一起生效。</p>
                        </div>
                        <div className="sar-release-chat-art" aria-hidden="true">
                            <div className="sar-release-demo-bubble">还有一张表情包，等我一下。</div>
                            <div className="sar-release-demo-input"><span>正在输入…</span><PaperPlaneTilt size={22}/></div>
                            <span className="sar-release-demo-arrow">点一下聊天空白处 <ArrowRight size={16}/></span>
                            <div className="sar-release-demo-input"><span>准备好，叫 TA 回复</span><Lightning size={22} weight="fill"/></div>
                        </div>
                        <div className="sar-release-options">
                            <p><span>○</span><strong>发送按钮代替生成按钮</strong><small>默认关闭 · 输入时发文字，点聊天空白处后变成闪电</small></p>
                            <p><span>✓</span><strong>回车发送文字</strong><small>默认开启 · 键盘上的回车键直接发文字；关闭后用来换行</small></p>
                            <p><span>○</span><strong>发完后自动生成回复</strong><small>默认关闭 · 发完后点聊天空白处，草稿为空、加号面板收起，再等 2 秒让 TA 回复</small></p>
                        </div>
                    </> : <>
                        <div className="sar-release-copy sar-release-copy-top">
                            <p className="sar-release-kicker">03 / 喜欢的东西，带走一份</p>
                            <h2 id="sar-release-title">一张图，<br/>装下你的分享。</h2>
                            <p>角色卡、世界书、气泡主题与外观预设……<br/>可以做成 PNG 分享卡，连内容一起装进去。</p>
                        </div>
                        <div className="sar-release-share-art" aria-hidden="true">
                            <div className="sar-release-share-shadow"/>
                            <div className="sar-release-share-card"><span>SullyOS·糯米机 / SHARE COLLECTION</span><img src={roomArt} alt=""/><strong>把喜欢的世界<br/>送到你手里。</strong><small>一张图片 · 一份完整心意</small><b>PNG ↗</b></div>
                        </div>
                        <p className="sar-release-share-note">发送 <strong>PNG 原文件</strong>，对方在对应入口导入。<br/>截图、压缩或转成其他格式，会丢掉里面的内容。<br/><span>原格式导出也保留着，照旧可用。</span></p>
                    </>}
                </div>
            </div>
            <footer className="sar-release-footer">
                <nav aria-label="公告章节">{PAGES.map((name, index) => <button key={name} onClick={() => turn(index)} aria-label={name} aria-current={page === index ? 'step' : undefined}><span>0{index + 1}</span><i/></button>)}</nav>
                <div className="sar-release-actions">
                    {page > 0 ? <button className="sar-release-back" onClick={() => turn(page - 1)} aria-label="上一页"><ArrowLeft size={18}/></button> : null}
                    <button className="sar-release-guide" onClick={() => { seen(); trackEvent('查看更新说明', { 版本: SAR_CHANGELOG }); onGuide(); }}>完整更新说明</button>
                    <button className="sar-release-next" onClick={() => {
                        if (page < 2) turn(page + 1);
                        else { seen(); trackEvent('点立刻体验', { 版本: SAR_CHANGELOG }); onVisit(); }
                    }}>{page < 2 ? '下一页' : '去彼方看看'}<ArrowRight size={18}/></button>
                </div>
            </footer>
        </section>
    </div>;
}

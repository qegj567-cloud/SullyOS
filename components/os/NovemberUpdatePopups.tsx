import React, { useEffect, useId, useRef } from 'react';
import { ArrowRight, X } from '@phosphor-icons/react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { AMSG_RECENT_UPDATE_KEY, HELP_STICKERS_UPDATE_KEY, SULLY_SUPPORT_NOTICE_KEY } from '../../utils/novemberNotices';
import { SULLY_HELP_DESK_AVATAR } from '../../utils/sullyIdentity';
import { trackEvent } from '../../utils/analytics';
import { shouldOfferRelayNotice } from './RelayUpdatePopup';
import sullyPeeking from '../../assets/sully-support/sully-peeking.webp';
import './NovemberUpdatePopups.css';

type NoticeActions = { onDone: () => void; onVisit: () => void };

function NovemberNotice({ noticeKey, title, eyebrow, visitLabel, children, onDone, onVisit, support = false }: NoticeActions & {
    noticeKey: string; title: string; eyebrow: string; visitLabel: string; children: React.ReactNode; support?: boolean;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const finished = useRef(false);
    const titleId = useId();
    useEffect(() => {
        const node = dialog.current;
        node?.showModal();
        return () => node?.close();
    }, []);
    const finish = (action: () => void) => {
        if (finished.current) return;
        finished.current = true;
        try { localStorage.setItem(noticeKey, '1'); } catch { /* Storage failure must not trap the user. */ }
        action();
    };
    useLocalBackHandler(() => { finish(onDone); return true; }, 100);
    return <dialog ref={dialog} className={`november-notice${support ? ' november-notice--support' : ''}`}
        aria-labelledby={titleId} onCancel={event => { event.preventDefault(); finish(onDone); }}>
        <div className="november-notice-layout">
            <header className="november-notice-heading">
                <p className="november-notice-eyebrow">{eyebrow}</p>
                <h2 id={titleId}>{title}</h2>
                <button type="button" className="november-notice-close" aria-label={`关闭${title}`} onClick={() => finish(onDone)}><X size={20} /></button>
            </header>
            <div className="november-notice-body" tabIndex={0} aria-label={`${title}说明`}>{children}</div>
            <footer className="november-notice-actions">
                <button type="button" onClick={() => finish(onDone)}>知道了</button>
                <button type="button" className="november-notice-primary" onClick={() => finish(onVisit)}>{visitLabel}<ArrowRight size={16} aria-hidden="true" /></button>
            </footer>
        </div>
    </dialog>;
}

export function HelpStickersUpdatePopup({ onDone, onVisit }: NoticeActions) {
    const version = { 版本: 'changelog-2026-11-19-help-stickers' };
    const shown = useRef(false);
    useEffect(() => {
        if (shown.current) return;
        shown.current = true;
        trackEvent('弹出版本更新提醒', { 版本: 'changelog-2026-11-19-help-stickers' });
    }, []);
    return <NovemberNotice noticeKey={HELP_STICKERS_UPDATE_KEY} eyebrow="11 月 19 日 · 小更新"
        title="Sully-11 答疑与表情包更新" visitLabel="问 Sully-11"
        onDone={() => { trackEvent('跳过本次更新说明', version); onDone(); }}
        onVisit={() => { trackEvent('点立刻体验', version); onVisit(); }}>
        <section>
            <img className="november-help-avatar" src={SULLY_HELP_DESK_AVATAR} width="60" height="60" alt="" />
            <h3>找不到设置？问问值班猫</h3>
            <p>在「使用帮助 → 问 Sully-11」写下问题，也可以附上报错截图。点纸飞机发送，再点闪电，11 号就会翻手册帮你找答案。</p>
        </section>
        <section>
            <h3>把相册里的表情带进聊天</h3>
            <p>在私聊点笑脸，再点铅笔进入表情管理。可以一次选多张图、导入整个 ZIP，或粘贴图床链接。默认沿用文件名，也可以选中一批表情，让主 API 看图起名。</p>
            <p>按文件夹整理后，可以为每个角色勾选可用的分组。导出时，本地图片随包保存，图床表情只保存链接。</p>
        </section>
    </NovemberNotice>;
}

export function AmsgRecentUpdatePopup(props: NoticeActions) {
    const showRelay = typeof location === 'undefined' || shouldOfferRelayNotice(location.href);
    return <NovemberNotice {...props} noticeKey={AMSG_RECENT_UPDATE_KEY} eyebrow="SULLYOS · 近期更新" title="最近的主动消息更新" visitLabel="去主动消息设置">
        <section>
            <h3>见面可以暂时挂起了</h3>
            <p>见面对话时回主页、用悬浮球回桌面，或打开别的 App，顶部会出现粉色返回条。点一下，就能回到原来的见面画面。</p>
            <div className="november-notice-date-bar" aria-label="见面返回条示意"><span aria-hidden="true">♡</span> 见面中 · TA · 点击返回 <ArrowRight size={14} aria-hidden="true" /></div>
            <p className="november-notice-hint">挂起保留在本次打开期间；刷新或关闭 SullyOS 后不会保留。</p>
        </section>
        <section>
            <h3>离开一会儿，TA 会来找你</h3>
            <p>见面设置新增「离开提醒」：离开见面或退出 SullyOS 超过设定时长，角色会在私聊里发来一条消息。</p>
            <ul>
                <li>每个角色单独开启，<strong>默认关闭</strong>。滑块可选 <strong>1–60 分钟</strong>，默认 5 分钟。</li>
                <li>回到见面，或在私聊里跟 TA 说话，就会取消这次提醒。</li>
                <li>已启用并配置主动消息 2.0 时由云端发送；未配置时仅能前台生成，SullyOS 切到后台后无法保证送达。</li>
            </ul>
            <aside className="november-notice-worker"><strong>需要更新主动消息 2.0 Worker</strong><p>已开启自动更新的 Worker 会在 12 小时内陆续更新完毕；想立刻体验，也可以在设置中手动更新。</p></aside>
        </section>
        <section>
            <h3>第一次设置，有了更详细的指引</h3>
            <p>优化了主动消息 2.0 首次进入时的引导，补充了配置步骤与说明。</p>
        </section>
        {showRelay && <section>
            <h3>大陆直连中转上线</h3>
            <p>新增内置的主动消息 2.0 大陆中转服务，希望改善大陆网络连接自己 Worker 的体验。领取令牌与使用方式，详见 DC 相关说明。</p>
            <p className="november-notice-hint">入口：设置 → 主动消息 2.0 → 后端 Worker → 大陆连接优化。开启前请先阅读数据转发说明。</p>
        </section>}
    </NovemberNotice>;
}

export function SullySupportNotice(props: NoticeActions) {
    return <NovemberNotice {...props} support noticeKey={SULLY_SUPPORT_NOTICE_KEY} eyebrow="SULLYOS · 一份小小的感谢" title="打赏 Sully" visitLabel="去看看">
        <div className="november-notice-support-intro">
            <div><p className="november-notice-thanks">谢谢你，<br />让热爱继续发光。</p><p>设置页最下方，<br />现在可以给 Sully 一点支持。</p></div>
            <img src={sullyPeeking} alt="Sully 探头向你打招呼" width="118" height="118" />
        </div>
        <div className="november-notice-letter">
            <p>为了给大家带来更好的体验，开发组每月在模型调用与测试上的硬性支出已达<strong>四位数</strong>。</p>
            <p>所有赞赏将直接用于继续项目的更新与维护。</p>
            <p><strong>赞赏完全自愿，不影响正常使用。</strong>它是一份单纯支持项目的心意，不附带额外权益、更新承诺或优先服务。请按自己的意愿与余力决定就好。</p>
            <p>感谢你愿意为这份热爱助力。</p>
            <p className="november-notice-signature">—— 条 &amp; TO 敬上</p>
        </div>
        <section className="november-notice-support-detail">
            <p>支持微信赞赏，可保存赞赏小票后，在微信扫一扫中从相册识别。</p>
            <p>想留下名字的话，请在付款时的<strong>【添加备注】</strong>写下希望公开展示的署名。每月更新会收录进「饲养员感谢名单」；未备注默认为「神秘猫奴」。</p>
            <p className="november-notice-gentle">先照顾好自己，有余力再支持。</p>
        </section>
    </NovemberNotice>;
}

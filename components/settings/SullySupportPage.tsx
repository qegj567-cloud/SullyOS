import { trackEvent } from '../../utils/analytics';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { fetchBlobForShare, shareOrDownloadBlob } from '../../utils/shareExport';
import { SupportIcon } from './SullySupportEntry';
import standing from '../../assets/sully-support/sully-standing.webp';
import phone from '../../assets/sully-support/sully-phone.webp';
import wechatCode from '../../assets/sully-support/wechat-sully-code.png';
import wechatCard from '../../assets/sully-support/wechat-support-card.png';
import wechatOriginal from '../../assets/sully-support/wechat-original.png';

const data = {
    label: '微信赞赏', image: wechatCode, card: wechatCard, original: wechatOriginal, size: 550,
    alt: '微信赞赏码，中央为 Sully 头像', caption: '微信赞赏 · 单次上限 ¥200', filename: 'Sully-微信投喂小票.png',
    help: '微信扫一扫 → 从相册选择 → 填写金额与署名', fallback: '识别不顺利？打开原始赞赏码',
} as const;
const menu = [
    ['🐟', '2.33', '一口小鱼干', '猫猫探头：这口归我了！'],
    ['🍪', '6.66', '工位加餐包', '给条和 TO 的灵感垫垫肚子。'],
    ['🥫', '18.80', '灵感猫罐头', '开罐声一响，新点子探出头。'],
    ['🎧', '18.88', '八号工位夜宵', 'Sully-08：陪聊小猫申请加餐。'],
    ['💭', '23.33', '咕噜咕噜快乐包', '猫猫笑出 233，Bug 先靠边站。'],
    ['🏰', '66.66', '豪华猫爬架', '站高一点，看看下一个新功能。'],
    ['🌌', '88.88', '银河猫粮储备', '猫粮常满，灵感常亮，大家常来。'],
] as const;
const petMessages = ['摸摸收到。今天也要好好照顾自己。', '嗯，再陪你待一会儿。', '你愿意来，我就已经很开心了。'];

export default function SullySupportPage({ onClose }: { onClose: () => void }) {
    const [originalOpen, setOriginalOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState('');
    const [pets, setPets] = useState(0);
    const [prepareAttempt, setPrepareAttempt] = useState(0);
    const [prepared, setPrepared] = useState<{ source: string; blob?: Blob } | null>(null);
    const imageCache = useRef(new Map<string, Blob>());
    const backRef = useRef<HTMLButtonElement>(null);
    const originalBackRef = useRef<HTMLButtonElement>(null);
    const originalTriggerRef = useRef<HTMLButtonElement>(null);
    const saveInFlight = useRef(false);
    const request = useRef(0);
    const wasOriginalOpen = useRef(false);
    const imageSource = originalOpen ? data.original : data.card;
    const preparedImage = prepared?.source === imageSource ? prepared : null;
    const preparing = !preparedImage;
    const prepareFailed = Boolean(preparedImage && !preparedImage.blob);

    // Prepare before the tap, just like Chibi's synchronous export bridge. Awaiting
    // a fetch in the click handler can lose the gesture required by mobile Web Share.
    useEffect(() => {
        let cancelled = false;
        const cached = imageCache.current.get(imageSource);
        if (cached) {
            setPrepared({ source: imageSource, blob: cached });
            return;
        }
        fetchBlobForShare(imageSource, 'image/png').then(blob => {
            if (cancelled) return;
            imageCache.current.set(imageSource, blob);
            setPrepared({ source: imageSource, blob });
        }).catch(() => {
            if (!cancelled) setPrepared({ source: imageSource });
        });
        return () => { cancelled = true; };
    }, [imageSource, prepareAttempt]);

    useLayoutEffect(() => { backRef.current?.focus({ preventScroll: true }); }, []);
    useLayoutEffect(() => {
        if (originalOpen) originalBackRef.current?.focus({ preventScroll: true });
        else if (wasOriginalOpen.current) originalTriggerRef.current?.focus({ preventScroll: true });
        wasOriginalOpen.current = originalOpen;
    }, [originalOpen]);
    useEffect(() => () => { request.current += 1; }, []);
    useLocalBackHandler(() => { setOriginalOpen(false); return true; }, 40, originalOpen);

    async function saveImage(original = false) {
        if (saveInFlight.current) return;
        if (!preparedImage?.blob) {
            setPrepared(null);
            setPrepareAttempt(value => value + 1);
            return;
        }
        saveInFlight.current = true;
        setSaving(true);
        setStatus('');
        const generation = ++request.current;
        try {
            const result = await shareOrDownloadBlob({ blob: preparedImage.blob,
                fileName: original ? `Sully-${data.label}-原始码.png` : data.filename,
                shareTitle: `打赏 Sully · ${data.label}` });
            if (result === 'downloaded' || result === 'shared') {
                trackEvent('保存赞赏图片', { 图片: original ? '原始码' : '投喂小票', 方式: result === 'shared' ? '系统分享' : '浏览器下载' });
            }
            if (generation === request.current) {
                setStatus(result === 'downloaded' ? '已交给浏览器下载，请在下载记录中查看。'
                    : result === 'shared' ? '请通过系统分享选项保存图片，再到微信中识别。' : '');
            }
        } catch {
            if (generation === request.current) setStatus('暂时无法保存，请打开原始码后长按图片保存，或截屏识别。');
        } finally {
            saveInFlight.current = false;
            setSaving(false);
        }
    }

    return <section className="sully-support support-page" aria-label="打赏 Sully" onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        if (originalOpen) setOriginalOpen(false); else onClose();
    }}>
        <div className="support-page-body" {...(originalOpen ? { inert: '' } : {})} aria-hidden={originalOpen || undefined}>
            <header className="support-header"><button ref={backRef} className="header-back" type="button" onClick={onClose} aria-label="返回设置"><SupportIcon name="back" /></button><h1>打赏 Sully</h1><span /></header>
            <div className="support-scroll"><div className="support-content">
                <section className="support-hero" aria-labelledby="sully-support-title">
                    <div className="hero-copy"><div className="sully-wordmark">Sully<span className="star" aria-hidden="true" /></div><h2 id="sully-support-title">给像素猫<br /><span>买点小鱼干</span></h2><p className="hero-quote">你的喜欢，我有好好收到。</p></div>
                    <div key={pets} className={`hero-art${pets ? ' is-petted' : ''}`}><span className="blue-disc" aria-hidden="true" /><span className="star hero-star-one" aria-hidden="true" /><span className="hero-star-two" aria-hidden="true">✦</span><span className="hero-heart" aria-hidden="true">♡</span><div className="charm"><span className="charm-loop" aria-hidden="true" /><img className="charm-character" src={standing} alt="穿着淡紫色条纹外套的 Sully" width="512" height="765" /></div></div>
                </section>
                <section className="team-note funding-note" aria-label="打赏用途与项目组致谢">
                    <p>为了给大家带来更好的体验，开发组每月在模型调用与测试上的硬性支出已达<strong>四位数</strong>。</p>
                    <p>所有赞赏将直接用于继续项目的更新与维护。</p>
                    <p><strong>赞赏完全自愿，不影响正常使用。</strong>它是一份单纯支持项目的心意，不附带额外权益、更新承诺或优先服务。请按自己的意愿与余力决定就好。</p>
                    <p className="team-thanks">感谢你愿意为这份热爱助力。</p>
                    <p className="team-signature">—— 条 &amp; TO 敬上 <SupportIcon name="heart" /></p>
                </section>
                <details className="snack-menu" onToggle={e => { if (e.currentTarget.open) trackEvent('展开投喂参考菜单'); }}>
                    <summary><span><strong>投喂参考菜单</strong><small>七份小小心意，随心挑一份</small></span><span className="menu-toggle" aria-hidden="true">＋</span></summary>
                    <ol className="menu-items">{menu.map(([emoji, price, title, description]) => <li key={price}><span className="menu-emoji" aria-hidden="true">{emoji}</span><div><strong>{title}</strong><p>{description}</p></div><span className="menu-price"><small>¥</small>{price}</span></li>)}</ol>
                    <p className="menu-footnote">金额只是心意参考，可在微信中自由填写。<br />不投喂也欢迎来玩，DC 陪聊照常营业。</p>
                </details>
                <aside className="signature-note"><span className="signature-pin" aria-hidden="true">✎</span><div><h3>留个名字，让猫猫认领这份偏爱。</h3><p>扫码投喂时，请在<strong>【添加备注】</strong>写下你希望公开展示的署名。每月更新时，我们会把它写进 SullyOS<strong>【饲养员感谢名单】</strong>。</p><p className="mystery-name">没留名字？那就记作「神秘猫奴」。</p></div></aside>
                <h3 className="payment-heading" id="sully-payment-title">微信赞赏</h3>
                <section id="sully-payment-panel" aria-labelledby="sully-payment-title">
                    <div className="ticket"><div className="ticket-top">A LITTLE LOVE, A BIG THANK YOU</div><div className="ticket-main"><div className="qr-crop"><img src={data.image} alt={data.alt} width={data.size} height={data.size} /></div><p className="code-caption">{data.caption}</p></div><div className="ticket-footer"><span>心意我会好好收着。</span><span className="footer-scribble" aria-hidden="true" /></div><img className="ticket-sticker" src={phone} alt="" width="256" height="270" /></div>
                    <button className="save-button" type="button" onClick={() => void saveImage()} disabled={saving || preparing}><SupportIcon name="download" /><span>{saving ? '正在打开保存选项…' : preparing ? '正在准备图片…' : prepareFailed ? '重新准备图片' : '保存投喂小票'}</span></button>
                    <p className="save-help">{data.help}</p>
                    <button ref={originalTriggerRef} className="original-link" type="button" onClick={() => { trackEvent('查看原始赞赏码'); setStatus(''); setOriginalOpen(true); }}>{data.fallback} <span aria-hidden="true">↗</span></button>
                    <p className="download-status" role="status">{status || (prepareFailed ? '图片暂未准备好，可重试或打开原始码长按保存。' : '')}</p>
                </section>
                <div className="gentle-footer"><p>先照顾好自己，有余力再投喂。</p><button type="button" className="pet-button" onClick={() => { if (!pets) trackEvent('在打赏页摸摸 Sully'); setPets(value => value + 1); }}>摸摸 Sully，也很好 <SupportIcon name="heart" /></button><p className="pet-response" aria-live="polite">{pets ? petMessages[(pets - 1) % petMessages.length] : ''}</p></div>
            </div></div>
        </div>
        {originalOpen && <section className="original-page" aria-label={`${data.label}原始码`}>
            <header className="support-header"><button ref={originalBackRef} className="header-back" type="button" aria-label="返回打赏页面" onClick={() => setOriginalOpen(false)}><SupportIcon name="back" /></button><h1>{data.label}原始码</h1><span /></header>
            <div className="support-scroll original-content"><img src={data.original} alt={`${data.label}原始收款码`} /><p>可长按图片保存，或截屏后从微信扫一扫的相册中识别。</p><button className="save-button" type="button" disabled={saving || preparing} onClick={() => void saveImage(true)}>{saving ? '正在打开保存选项…' : preparing ? '正在准备图片…' : prepareFailed ? '重新准备图片' : '保存原始码'}</button><p className="download-status" role="status">{status || (prepareFailed ? '图片暂未准备好，可重试或长按上方原图保存。' : '')}</p></div>
        </section>}
    </section>;
}

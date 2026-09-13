import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { embedShareInPng, MAX_SHARE_BYTES, safeShareFileName, SHARE_KINDS, type ShareCardMetadata, type ShareCardOptions, type ShareCardStyle } from '../../utils/pngShare';
import { canvasToPng, loadCardImage, renderShareCard } from '../../utils/shareCardCanvas';
import { fetchBlobForShare, shareOrDownloadBlob, type ShareOrDownloadBlobOptions } from '../../utils/shareExport';
import './shareCard.css';

type Result = 'shared' | 'downloaded' | 'cancelled';
interface Props { options: ShareOrDownloadBlobOptions; card: ShareCardOptions; onDone: (result: Result) => void; }
const layouts: { value: ShareCardStyle; label: string; sample: string }[] = [
    { value: 'paper', label: '留白相纸', sample: '▣' },
    { value: 'poster', label: '全幅海报', sample: '▥' },
    { value: 'business', label: '横版名片', sample: '▤' },
];

function ShareCardDialog({ options, card, onDone }: Props) {
    const dialog = useRef<HTMLDialogElement>(null);
    const preview = useRef<HTMLDivElement>(null);
    const settingsToggle = useRef<HTMLButtonElement>(null);
    const fields = useRef<HTMLFieldSetElement>(null);
    const upload = useRef<HTMLInputElement>(null);
    const imageRequest = useRef(0);
    const mounted = useRef(true);
    const working = useRef(false);
    const [title, setTitle] = useState((card.title || options.shareTitle || options.fileName).slice(0, 60));
    const [author, setAuthor] = useState((card.author || '').slice(0, 32));
    const [restrictions, setRestrictions] = useState((card.restrictions || '').slice(0, 120));
    const [style, setStyle] = useState<ShareCardStyle>('paper');
    const [image, setImage] = useState<HTMLImageElement | null>(null);
    const [loadingImage, setLoadingImage] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [renderError, setRenderError] = useState('');
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsTab, setSettingsTab] = useState<'style' | 'text'>('style');
    const tooLarge = options.blob.size > MAX_SHARE_BYTES;
    const design = { kind: card.kind, title, author, restrictions, style };

    const acceptImage = async (blobPromise: Promise<Blob>) => {
        const request = ++imageRequest.current;
        setLoadingImage(true); setError('');
        let url: string | undefined;
        try {
            const blob = await blobPromise;
            if (!/^image\/(png|jpeg|webp|gif|avif)$/i.test(blob.type)) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
            if (blob.size > 20 * 1024 * 1024) throw new Error('预览图请小于 20 MB');
            url = URL.createObjectURL(blob);
            const next = await loadCardImage(url);
            if (next.naturalWidth * next.naturalHeight > 40_000_000) throw new Error('预览图尺寸过大，请缩小后上传');
            if (mounted.current && request === imageRequest.current) setImage(next);
        } catch (e) {
            if (mounted.current && request === imageRequest.current) setError((e as Error).message || '图片读取失败');
        } finally {
            if (url) URL.revokeObjectURL(url);
            if (mounted.current && request === imageRequest.current) setLoadingImage(false);
        }
    };

    useEffect(() => {
        const previousFocus = document.activeElement as HTMLElement | null;
        dialog.current?.showModal();
        if (card.previewUrl) void acceptImage(fetchBlobForShare(card.previewUrl, 'image/png'));
        return () => { mounted.current = false; imageRequest.current++; previousFocus?.focus(); };
    }, []);

    // Mobile keyboards can resize only the visual viewport (not 100dvh).
    // Keep the preview and the partial settings panel inside the visible area.
    useEffect(() => {
        const viewport = window.visualViewport;
        if (!viewport) return;
        let frame = 0;
        const syncViewport = () => {
            // Let pinch zoom behave normally instead of resizing the editor around it.
            if (viewport.scale !== 1) return;
            dialog.current?.style.setProperty('--sully-share-vh', `${viewport.height}px`);
            dialog.current?.style.setProperty('--sully-share-top', `${viewport.offsetTop}px`);
            if (dialog.current) dialog.current.dataset.compactViewport = String(viewport.height <= 500);
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const focused = document.activeElement;
                const scroller = fields.current;
                if (!scroller || !(focused instanceof HTMLElement) || !scroller.contains(focused)) return;
                const fieldBox = focused.getBoundingClientRect(), scrollBox = scroller.getBoundingClientRect();
                if (fieldBox.top < scrollBox.top || fieldBox.height > scrollBox.height) scroller.scrollTop += fieldBox.top - scrollBox.top - 6;
                else if (fieldBox.bottom > scrollBox.bottom) scroller.scrollTop += fieldBox.bottom - scrollBox.bottom + 6;
            });
        };
        syncViewport();
        viewport.addEventListener('resize', syncViewport);
        viewport.addEventListener('scroll', syncViewport);
        return () => {
            cancelAnimationFrame(frame);
            viewport.removeEventListener('resize', syncViewport);
            viewport.removeEventListener('scroll', syncViewport);
        };
    }, []);

    useEffect(() => { fields.current?.scrollTo({ top: 0 }); }, [settingsTab]);

    const collapseSettings = () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        setSettingsOpen(false);
        settingsToggle.current?.focus({ preventScroll: true });
    };

    useEffect(() => {
        try {
            const canvas = renderShareCard(design, image);
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', `${SHARE_KINDS[card.kind]}分享卡预览：${title}，作者 ${author || '未署名'}，使用限制 ${restrictions || '未注明'}`);
            preview.current?.replaceChildren(canvas); setRenderError('');
        } catch (e) { setRenderError((e as Error).message); }
    }, [title, author, restrictions, style, image, card.kind]);

    const save = async (asPng: boolean) => {
        if (working.current) return;
        working.current = true; setBusy(true); setError('');
        try {
            let blob = options.blob;
            let fileName = safeShareFileName(options.fileName);
            if (asPng) {
                const metadata: ShareCardMetadata = { format: 'sullyos-share', version: 1, ...design, title: title.trim(),
                    author: author.trim(), restrictions: restrictions.trim(), fileName, mimeType: blob.type || 'application/octet-stream' };
                const canvas = preview.current?.querySelector('canvas');
                if (!canvas) throw new Error('图片预览尚未就绪，请重试');
                const png = await canvasToPng(canvas);
                const bytes = embedShareInPng(new Uint8Array(await png.arrayBuffer()), metadata, new Uint8Array(await blob.arrayBuffer()));
                blob = new Blob([new Uint8Array(bytes).buffer], { type: 'image/png' });
                fileName = `${safeShareFileName(title)}.sully.png`;
            }
            const result = await shareOrDownloadBlob({ ...options, card: undefined, blob, fileName, nativeChunked: true });
            if (result !== 'cancelled') onDone(result);
        } catch (e) {
            if (mounted.current) setError((e as Error).message || '导出失败，请重试');
        } finally { working.current = false; if (mounted.current) setBusy(false); }
    };
    return <dialog ref={dialog} className="sully-share-dialog" aria-labelledby="sully-share-heading"
        onCancel={event => {
            event.preventDefault();
            if (working.current) return;
            if (settingsOpen && window.matchMedia('(max-width: 640px)').matches) collapseSettings();
            else onDone('cancelled');
        }}>
        <header className="sully-share-header">
            <div><span className="sully-share-eyebrow">SullyOS·糯米机 / {SHARE_KINDS[card.kind]}</span><h2 id="sully-share-heading">制作分享图片</h2></div>
            <button type="button" className="sully-share-close" aria-label="关闭分享编辑器" disabled={busy} onClick={() => onDone('cancelled')}>×</button>
        </header>
        <div className="sully-share-body">
            <section className="sully-share-preview-pane" aria-label="图片预览"><div ref={preview} className={`sully-share-preview sully-share-preview-${style}`} />
                <div className="sully-share-preview-bar">
                    <p>{layouts.find(l => l.value === style)?.label} · {style === 'business' ? '1440 × 960' : '1080 × 1440'}</p>
                    <button ref={settingsToggle} type="button" className="sully-share-settings-toggle" aria-expanded={settingsOpen}
                        aria-controls="sully-share-settings" disabled={busy} onClick={() => settingsOpen ? collapseSettings() : setSettingsOpen(true)}>
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 7h7m4 0h5M4 17h3m4 0h9M11 4v6M7 14v6" /></svg>
                        {settingsOpen ? '收起设置' : '调整样式'}
                    </button>
                </div>
            </section>
            <section id="sully-share-settings" className="sully-share-settings" data-mobile-open={settingsOpen} aria-label="分享设置">
                <div className="sully-share-settings-tabs" role="group" aria-label="设置分类">
                    <button type="button" aria-pressed={settingsTab === 'style'} aria-controls="sully-share-style-controls" onClick={() => setSettingsTab('style')}>图片与排版</button>
                    <button type="button" aria-pressed={settingsTab === 'text'} aria-controls="sully-share-text-controls" onClick={() => setSettingsTab('text')}>文字与署名</button>
                </div>
            <fieldset ref={fields} className="sully-share-fields" disabled={busy}>
                <legend className="sully-share-sr-only">分享图片设置</legend>
                <div id="sully-share-style-controls" className="sully-share-section" data-mobile-active={settingsTab === 'style'}>
                <label>排版风格</label>
                <div className="sully-share-layouts">{layouts.map(layout => <button key={layout.value} type="button" aria-pressed={style === layout.value} onClick={() => setStyle(layout.value)}><span aria-hidden="true">{layout.sample}</span>{layout.label}</button>)}</div>
                <div className="sully-share-image-actions"><input ref={upload} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden aria-label="上传分享预览图" onChange={event => {
                    const file = event.target.files?.[0]; event.target.value = ''; if (file) void acceptImage(Promise.resolve(file));
                }} /><button type="button" onClick={() => upload.current?.click()}>{loadingImage ? '正在读取图片…' : image ? '更换预览图' : '上传预览图'}</button>
                    {(image || loadingImage) && <button type="button" onClick={() => { imageRequest.current++; setImage(null); setLoadingImage(false); setError(''); }}>移除</button>}</div>
                </div>
                <div id="sully-share-text-controls" className="sully-share-section" data-mobile-active={settingsTab === 'text'}>
                <label htmlFor="sully-share-title">作品名称</label><input id="sully-share-title" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} />
                <label htmlFor="sully-share-author">作者名</label><input id="sully-share-author" value={author} maxLength={32} placeholder="你的署名（可选）" onChange={e => setAuthor(e.target.value)} />
                <label htmlFor="sully-share-restrictions">使用限制</label><textarea id="sully-share-restrictions" value={restrictions} maxLength={120} rows={3} placeholder="例如：仅限自用 · 禁止商用 · 转载请署名" onChange={e => setRestrictions(e.target.value)} />
                <div className="sully-share-presets">{['仅限自用', '禁止商用', '转载请署名'].map(term => <button type="button" key={term} onClick={() => setRestrictions(old => old.includes(term) ? old : `${old}${old ? ' · ' : ''}${term}`.slice(0, 120))}>{term} +</button>)}</div>
                </div>
                <p className="sully-share-note">图片包含完整的{SHARE_KINDS[card.kind]}内容，可在对应功能的导入入口还原。请发送 PNG 原文件，截图或压缩后可能无法导入。使用限制为作者说明。</p>
            </fieldset>
            </section>
        </div>
        {(tooLarge || error || renderError) && <p role="alert" className="sully-share-status sully-share-error">{error || renderError || '内容超过 64 MB，请使用原格式导出。'}</p>}
        <footer className="sully-share-footer"><button type="button" disabled={busy} onClick={() => void save(false)}>导出原格式</button>
            <button type="button" className="sully-share-primary" disabled={busy || loadingImage || !title.trim() || tooLarge || !!renderError} onClick={() => void save(true)}>{busy ? '正在导出…' : '导出 PNG 分享图'}</button></footer>
    </dialog>;
}

let open = false;
export async function openShareCardDialog(options: ShareOrDownloadBlobOptions, card: ShareCardOptions): Promise<Result> {
    if (open) return 'cancelled';
    open = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    return new Promise(resolve => {
        let done = false;
        root.render(<ShareCardDialog options={options} card={card} onDone={result => {
            if (done) return; done = true;
            setTimeout(() => { root.unmount(); host.remove(); open = false; resolve(result); }, 0);
        }} />);
    });
}

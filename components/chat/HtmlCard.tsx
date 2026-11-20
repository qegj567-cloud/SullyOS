import React, { useEffect, useRef, useState } from 'react';
import { CaretDown, Check, CopySimple } from '@phosphor-icons/react';

/**
 * HTML 卡片渲染（私聊 MessageItem 与群聊 GroupMessageItem 共用）。
 * 沙盒 iframe：禁用脚本 / 表单提交 / 弹窗，避免任意 HTML 越权访问父页面。
 * srcDoc 用一个全宽中心化的 wrapper, 让 270px 的卡片在 iframe 里居中、背景透明。
 * body>* 强制清掉最外层元素的 box-shadow/filter: 模型经常给卡片外层加柔和阴影,
 * 但 iframe 只比卡片宽一点 + 外层 overflow-hidden, 阴影会被裁成一圈"若隐若现的
 * 假边框"贴在卡片周围 —— 聊天里卡片约定是直接贴在聊天背景上、无背景无边框,
 * 这里在渲染端兜底 (对已落库的旧卡片同样生效), 提示词端同步不再教模型加外层阴影。
 */
const HtmlCard: React.FC<{ html: string }> = ({ html }) => {
    const [sourceExpanded, setSourceExpanded] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'ok' | 'error'>('idle');
    const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#334155;}body{display:flex;justify-content:center;padding:0;}*{box-sizing:border-box;}img{max-width:100%;}body>*{box-shadow:none!important;filter:none!important;}</style></head><body>${html}</body></html>`;

    useEffect(() => () => {
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    }, []);

    const copyHtmlSource = async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        let copied = false;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
            // Copy the exact source stored on the message, not the renderer's
            // srcDoc wrapper, so users can archive or edit the original card.
            await navigator.clipboard.writeText(html);
            copied = true;
        } catch {
            // iOS PWA / non-secure contexts can reject Clipboard API. Keep a
            // user-gesture fallback without touching interactions in the iframe.
            let textarea: HTMLTextAreaElement | null = null;
            try {
                textarea = document.createElement('textarea');
                textarea.value = html;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.left = '-9999px';
                textarea.style.opacity = '0';
                textarea.style.pointerEvents = 'none';
                document.body.appendChild(textarea);
                textarea.select();
                textarea.setSelectionRange(0, textarea.value.length);
                copied = document.execCommand('copy');
            } catch {
                copied = false;
            } finally {
                textarea?.remove();
            }
        }

        setCopyState(copied ? 'ok' : 'error');
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = setTimeout(() => setCopyState('idle'), 1600);
    };

    return (
        <div className="w-[280px] max-w-full rounded-[18px] overflow-hidden bg-transparent">
            <iframe
                title="html-card"
                srcDoc={srcDoc}
                // allow-same-origin: 让父页面能读 contentDocument 自动调高度
                // 故意不给 allow-scripts / allow-forms / allow-popups —
                // AI 输出里的 <script> 不会执行, 表单 / 弹窗 / 顶层跳转 也都被拦。
                sandbox="allow-same-origin"
                referrerPolicy="no-referrer"
                className="block w-full min-h-[120px] border-0 bg-transparent"
                style={{ height: 200 }}
                onLoad={(e) => {
                    try {
                        const f = e.currentTarget as HTMLIFrameElement & { __htmlCardRO?: ResizeObserver };
                        const doc = f.contentDocument;
                        if (!doc || !doc.body) return;
                        // 量内容真实高度并把 iframe 调成等高，避免内部滚动。
                        // 上限放宽到 2400，足够长卡片完整展开；真正超长的才会兜底滚动。
                        const fit = () => {
                            try {
                                const root = doc.documentElement;
                                const body = doc.body;
                                const natural = Math.max(
                                    body.scrollHeight, body.offsetHeight,
                                    root ? root.scrollHeight : 0,
                                );
                                const h = Math.min(2400, Math.max(60, natural + 4));
                                f.style.height = h + 'px';
                            } catch { /* 同源读不到时静默 */ }
                        };
                        fit();
                        // 交互卡片（:checked 展开 / 折叠）、动画、字体晚到都会改变高度，
                        // 用 ResizeObserver 持续跟随，让高度始终自适应而不是只量一次。
                        f.__htmlCardRO?.disconnect();
                        if (typeof ResizeObserver !== 'undefined') {
                            const ro = new ResizeObserver(() => fit());
                            ro.observe(doc.body);
                            if (doc.documentElement) ro.observe(doc.documentElement);
                            f.__htmlCardRO = ro;
                        }
                    } catch { /* 同源也读不到时静默 */ }
                }}
            />
            {/* The source action deliberately lives outside the iframe. Card
                labels, checkboxes, text selection and other embedded gestures
                therefore keep their native long-press behavior. */}
            <div
                className="sully-html-source-bar flex h-8 select-none items-center justify-between overflow-hidden border-t border-slate-200/80 bg-white/85 px-2 text-[10px] text-slate-600 shadow-sm transition-all duration-200 ease-out"
                style={sourceExpanded ? undefined : {
                    height: 20,
                    justifyContent: 'center',
                    borderTopColor: 'transparent',
                    backgroundColor: 'transparent',
                    paddingLeft: 0,
                    paddingRight: 0,
                }}
                onPointerDown={event => event.stopPropagation()}
                onPointerUp={event => event.stopPropagation()}
                onContextMenu={event => event.stopPropagation()}
            >
                <button
                    type="button"
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSourceExpanded(expanded => !expanded);
                    }}
                    aria-expanded={sourceExpanded}
                    aria-label={sourceExpanded ? '收起 HTML 源码操作' : '展开 HTML 源码操作'}
                    title={sourceExpanded ? '收起源码操作' : '展开源码操作'}
                    className="sully-html-source-toggle inline-flex h-5 items-center gap-1 rounded-full font-medium text-slate-600 transition-all duration-200 hover:bg-slate-500/[0.08] hover:text-slate-700 focus:outline-none focus-visible:bg-slate-500/10 focus-visible:text-slate-700"
                    style={sourceExpanded ? undefined : {
                        gap: 2,
                        paddingLeft: 8,
                        paddingRight: 8,
                        backgroundColor: 'rgba(255, 255, 255, 0.72)',
                        color: 'rgba(71, 85, 105, 0.85)',
                    }}
                >
                    <span
                        className="rounded border border-slate-300/70 px-1 py-px font-mono text-[7px] tracking-[0.14em] text-slate-600 transition-all duration-200"
                        style={sourceExpanded ? undefined : { borderWidth: 0, paddingLeft: 0, paddingRight: 0, color: 'inherit' }}
                    >HTML</span>
                    <span
                        className="ml-0.5 max-w-16 overflow-hidden whitespace-nowrap tracking-[0.08em] opacity-100 transition-all duration-200"
                        style={sourceExpanded ? undefined : { marginLeft: 0, maxWidth: 0, opacity: 0 }}
                    >完整源码</span>
                    <CaretDown
                        size={8}
                        weight="bold"
                        className="shrink-0 transition-transform duration-200"
                        style={{ transform: sourceExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    />
                </button>
                <button
                    type="button"
                    onClick={copyHtmlSource}
                    aria-label="复制完整 HTML 源码"
                    title="复制完整 HTML 源码"
                    aria-hidden={!sourceExpanded}
                    tabIndex={sourceExpanded ? 0 : -1}
                    className={`sully-html-copy-button inline-flex h-6 max-w-24 items-center gap-1 overflow-hidden whitespace-nowrap rounded-full px-2 font-medium opacity-100 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/70 focus-visible:ring-offset-1 active:scale-95 ${
                        copyState === 'ok'
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : copyState === 'error'
                                ? 'bg-rose-500/10 text-rose-500'
                                : 'bg-slate-500/[0.06] text-slate-500/80 hover:bg-slate-500/10 hover:text-slate-600'
                    }`}
                    style={sourceExpanded ? undefined : {
                        maxWidth: 0,
                        paddingLeft: 0,
                        paddingRight: 0,
                        opacity: 0,
                        pointerEvents: 'none',
                    }}
                >
                    {copyState === 'ok' ? <Check size={11} weight="bold" /> : <CopySimple size={11} />}
                    {copyState === 'ok' ? '已复制' : copyState === 'error' ? '复制失败' : '复制源码'}
                </button>
            </div>
        </div>
    );
};

export default HtmlCard;

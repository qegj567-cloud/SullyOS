import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    ArrowCounterClockwise,
    Check,
    Copy,
    DownloadSimple,
    Eye,
    GearSix,
    UploadSimple,
    X,
} from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { JournalAppearance } from '../../types';
import {
    JOURNAL_AI_CSS_PROMPT,
    JOURNAL_APPEARANCE_PRESETS,
    JOURNAL_APPEARANCE_SAFETY_CSS,
    JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS,
    JOURNAL_CSS_SCOPE_HINT,
    JOURNAL_CSS_SCOPE_REGEX,
    flattenJournalAppearance,
    resolveJournalAppearanceCss,
} from '../../utils/journalAppearance';
import { runCssRenderabilityCheck, validateScopedCss } from '../../utils/scopedCss';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { readShareText } from '../../utils/pngShare';
import { JournalThemeThumbnail } from './JournalThemeArtwork';

const CSS_SNIPPETS = [
    {
        name: '纸张直角',
        code: `.sully-journal-paper{
  border-radius:4px!important;
  box-shadow:0 18px 48px rgba(20,14,10,.28)!important;
}`,
    },
    {
        name: '更像手写',
        code: `.sully-journal-textarea{
  font-family:"Kaiti SC","STKaiti",serif!important;
  font-size:17px!important;
  line-height:2!important;
  letter-spacing:.04em!important;
}`,
    },
    {
        name: '隐藏纸纹',
        code: `.sully-journal-texture{display:none!important;}`,
    },
];

const normalizeAppearance = (appearance?: JournalAppearance): JournalAppearance => ({
    preset: appearance?.preset || 'original',
    customCss: appearance?.customCss || '',
});

const copyText = async (text: string): Promise<boolean> => {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch { /* iOS/PWA may deny Clipboard API; fall back to a selection copy. */ }
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        return copied;
    } catch {
        return false;
    }
};

export const JournalAppearanceStyle: React.FC<{ appearance?: JournalAppearance }> = ({ appearance }) => {
    const validation = useMemo(
        () => validateScopedCss(
            appearance?.customCss || '',
            JOURNAL_CSS_SCOPE_REGEX,
            JOURNAL_CSS_SCOPE_HINT,
        ),
        [appearance?.customCss],
    );
    const css = resolveJournalAppearanceCss({
        ...appearance,
        customCss: validation.isValid ? appearance?.customCss : '',
    });
    return css ? <style>{`${css}\n${JOURNAL_APPEARANCE_SAFETY_CSS}`}</style> : null;
};

interface JournalAppearanceButtonProps {
    tone?: 'light' | 'dark';
    compact?: boolean;
    previewAppearance?: JournalAppearance;
    isPreviewing?: boolean;
    onStartPreview: (appearance: JournalAppearance) => void;
    onCancelPreview: () => void;
}

const JournalAppearanceButton: React.FC<JournalAppearanceButtonProps> = ({
    tone = 'light',
    compact = false,
    previewAppearance,
    isPreviewing = false,
    onStartPreview,
    onCancelPreview,
}) => {
    const { theme, updateTheme, addToast } = useOS();
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const cssImportRef = useRef<HTMLInputElement>(null);
    const appearanceButtonRef = useRef<HTMLButtonElement>(null);
    const [savedStyleBlocksButton, setSavedStyleBlocksButton] = useState(false);
    const [draft, setDraft] = useState<JournalAppearance>(() =>
        normalizeAppearance(theme.journalAppearance)
    );
    const hasSavedCustomCss = Boolean(theme.journalAppearance?.customCss?.trim());

    useEffect(() => {
        if (open) setDraft(normalizeAppearance(previewAppearance || theme.journalAppearance));
    }, [open, previewAppearance, theme.journalAppearance]);

    useEffect(() => {
        if (!open) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = previous; };
    }, [open]);

    // A saved skin can leave the button visible while an invisible overlay,
    // zero-sized ancestor or pointer-events rule steals every tap. Test the
    // actual hit target and expose a body-level reset only when the normal
    // entrance is genuinely unreachable. The capture listener also catches a
    // user's first failed tap if the skin changes after the initial check.
    useEffect(() => {
        if (!hasSavedCustomCss || isPreviewing) {
            setSavedStyleBlocksButton(false);
            return;
        }

        const detectBlockedButton = () => {
            const button = appearanceButtonRef.current;
            if (!button) return;
            const rect = button.getBoundingClientRect();
            const hasUsableRect = rect.width >= 24
                && rect.height >= 24
                && rect.right > 0
                && rect.bottom > 0
                && rect.left < window.innerWidth
                && rect.top < window.innerHeight;
            if (!hasUsableRect) {
                setSavedStyleBlocksButton(true);
                return;
            }
            const hit = document.elementFromPoint(
                Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2)),
                Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2)),
            );
            setSavedStyleBlocksButton(!hit || (hit !== button && !button.contains(hit)));
        };

        const handleCapturedPointer = (event: PointerEvent) => {
            const button = appearanceButtonRef.current;
            if (!button) return;
            const rect = button.getBoundingClientRect();
            const aimedAtButton = event.clientX >= rect.left
                && event.clientX <= rect.right
                && event.clientY >= rect.top
                && event.clientY <= rect.bottom;
            if (aimedAtButton && event.target instanceof Node && !button.contains(event.target)) {
                setSavedStyleBlocksButton(true);
            }
        };

        let secondFrame = 0;
        const frame = window.requestAnimationFrame(() => {
            secondFrame = window.requestAnimationFrame(detectBlockedButton);
        });
        const timer = window.setTimeout(detectBlockedButton, 400);
        document.addEventListener('pointerdown', handleCapturedPointer, true);
        window.addEventListener('resize', detectBlockedButton);
        return () => {
            window.cancelAnimationFrame(frame);
            window.cancelAnimationFrame(secondFrame);
            window.clearTimeout(timer);
            document.removeEventListener('pointerdown', handleCapturedPointer, true);
            window.removeEventListener('resize', detectBlockedButton);
        };
    }, [hasSavedCustomCss, isPreviewing]);

    const validation = useMemo(
        () => validateScopedCss(
            draft.customCss || '',
            JOURNAL_CSS_SCOPE_REGEX,
            JOURNAL_CSS_SCOPE_HINT,
        ),
        [draft.customCss],
    );

    const save = async () => {
        const renderability = runCssRenderabilityCheck(draft.customCss || '', validation);
        if (!renderability.ok) {
            addToast(renderability.message, 'error');
            return;
        }
        await updateTheme({ journalAppearance: { ...draft } });
        onCancelPreview();
        addToast('交换日记样式已保存', 'success');
        setOpen(false);
    };

    const startPreview = () => {
        const renderability = runCssRenderabilityCheck(draft.customCss || '', validation);
        if (!renderability.ok) {
            addToast(renderability.message, 'error');
            return;
        }
        onStartPreview({ ...draft });
        addToast('已进入日记本预览，可自由翻页；顶部救援条可随时撤销', 'info');
        setOpen(false);
    };

    const reset = async () => {
        await updateTheme({ journalAppearance: undefined });
        onCancelPreview();
        setDraft(normalizeAppearance());
        addToast('已还原交换日记原版样式', 'success');
        setOpen(false);
    };

    const closePanel = () => {
        setOpen(false);
    };

    const copyPrompt = async () => {
        if (await copyText(JOURNAL_AI_CSS_PROMPT)) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        } else {
            addToast('复制失败，请手动选择提示词', 'error');
        }
    };

    const appendSnippet = (code: string) => {
        setDraft(current => ({
            ...current,
            customCss: `${current.customCss?.trim() ? `${current.customCss.trim()}\n` : ''}${code}`,
        }));
    };

    const makeStandalone = () => {
        const standalone = flattenJournalAppearance(draft);
        setDraft(standalone);
        addToast('已转为独立 CSS，不再依赖内置主题', 'success');
    };

    const importCss = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const css = (await readShareText(file, 'journal-css')).replace(/^\uFEFF/, '').trim();
            if (!css) {
                addToast('CSS 文件是空的', 'error');
                return;
            }
            const importedValidation = validateScopedCss(
                css,
                JOURNAL_CSS_SCOPE_REGEX,
                JOURNAL_CSS_SCOPE_HINT,
            );
            const renderability = runCssRenderabilityCheck(css, importedValidation);
            if (!renderability.ok) {
                addToast(renderability.message, 'error');
                return;
            }
            setDraft({ preset: 'original', customCss: css });
            addToast('CSS 已导入并转为独立样式', 'success');
        } catch {
            addToast('CSS 文件读取失败', 'error');
        } finally {
            event.target.value = '';
        }
    };

    const exportCss = async () => {
        const css = resolveJournalAppearanceCss(draft);
        if (!css.trim()) {
            addToast('当前是原版样式，没有可导出的 CSS', 'info');
            return;
        }
        const date = new Date();
        const dateKey = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        const fileName = `sullyos-exchange-diary-${dateKey}.css`;
        try {
            const result = await shareOrDownloadFile({
                card: { kind: 'journal-css', title: '交换日记样式' },
                content: css,
                fileName,
                mimeType: 'text/css;charset=utf-8',
                shareTitle: 'SullyOS·糯米机 交换日记样式',
            });
            if (result === 'cancelled') return;
            addToast(result === 'shared' ? '已打开 CSS 分享面板' : '完整 CSS 已导出', 'success');
        } catch (error: any) {
            if (error?.name !== 'AbortError') addToast('CSS 导出失败，请重试', 'error');
        }
    };

    const panel = open ? createPortal(
        <>
        <style>{`
#sully-journal-appearance-editor{
  display:flex!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;
  position:fixed!important;inset:0!important;z-index:2147483647!important;
}
        `}</style>
        <div
            id="sully-journal-appearance-editor"
            className="fixed inset-0 z-[1950] flex items-end justify-center bg-black/45 backdrop-blur-sm"
            onMouseDown={event => {
                if (event.target === event.currentTarget) closePanel();
            }}
        >
            <div
                className="w-full max-w-[640px] max-h-[90vh] overflow-y-auto rounded-t-[30px] bg-[#fbfaf8] text-slate-800 shadow-2xl"
                style={{ paddingBottom: 'max(22px, env(safe-area-inset-bottom))' }}
                onMouseDown={event => event.stopPropagation()}
            >
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-stone-200/80 bg-[#fbfaf8]/95 px-5 py-4 backdrop-blur">
                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-[.22em] text-amber-600/70">Exchange diary skin</div>
                        <h2 className="mt-0.5 text-base font-black">交换日记美化</h2>
                    </div>
                    <button
                        onClick={closePanel}
                        className="grid h-9 w-9 place-items-center rounded-full bg-stone-100 text-stone-500 active:scale-90"
                        aria-label="关闭交换日记样式设置"
                    >
                        <X size={17} />
                    </button>
                </div>

                <div className="space-y-7 p-5">
                    <section>
                        <h3 className="text-sm font-bold">默认主题</h3>
                        <p className="mt-1 text-[11px] text-slate-400">先选择主题和 CSS，再点底部“预览并浏览”；保存后才会对所有角色生效。</p>
                        <div className="mt-3 grid grid-cols-2 gap-2.5">
                            {JOURNAL_APPEARANCE_PRESETS.map(preset => {
                                const selected = (draft.preset || 'original') === preset.id;
                                return (
                                    <button
                                        key={preset.id}
                                        onClick={() => {
                                            setDraft(current => ({ ...current, preset: preset.id }));
                                        }}
                                        className={`relative min-h-[92px] rounded-2xl border p-3 text-left transition-all active:scale-[.98] ${
                                            selected
                                                ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-400'
                                                : 'border-stone-200 bg-white'
                                        }`}
                                    >
                                        <div className="mb-3"><JournalThemeThumbnail preset={preset.id} /></div>
                                        <b className="block text-[12px]">{preset.name}</b>
                                        <span className="mt-1 block text-[10px] text-slate-400">{preset.description}</span>
                                        {selected && <Check size={15} weight="bold" className="absolute right-3 top-3 text-amber-600" />}
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    <section>
                        <div className="mb-3 flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-bold">自定义 CSS</h3>
                                <p className="mt-1 text-[11px] text-slate-400">叠加在主题之后，只作用于交换日记，不会影响其它 App。</p>
                            </div>
                            <button
                                onClick={copyPrompt}
                                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-700"
                            >
                                {copied ? <Check size={13} /> : <Copy size={13} />}
                                {copied ? '已复制' : '复制 AI 提示词'}
                            </button>
                        </div>

                        <div className="mb-3 grid grid-cols-3 gap-2">
                            <input
                                ref={cssImportRef}
                                type="file"
                                accept=".png,.css,.txt,image/png,text/css,text/plain"
                                className="hidden"
                                onChange={importCss}
                            />
                            <button
                                onClick={() => cssImportRef.current?.click()}
                                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-stone-200 bg-white px-2 text-[10px] font-bold text-slate-600"
                            >
                                <UploadSimple size={14} />
                                导入 PNG / CSS
                            </button>
                            <button
                                onClick={exportCss}
                                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-stone-200 bg-white px-2 text-[10px] font-bold text-slate-600"
                            >
                                <DownloadSimple size={14} />
                                导出完整 CSS
                            </button>
                            <button
                                onClick={makeStandalone}
                                disabled={(draft.preset || 'original') === 'original'}
                                className="min-h-11 rounded-xl border border-stone-200 bg-white px-2 text-[10px] font-bold text-slate-600 disabled:bg-stone-100 disabled:text-stone-400"
                            >
                                {(draft.preset || 'original') === 'original' ? '已独立使用' : '转为独立 CSS'}
                            </button>
                        </div>
                        <p className="mb-3 rounded-xl bg-emerald-50 px-3 py-2 text-[10px] leading-4 text-emerald-700">
                            导出会把内置主题展开成完整 CSS；导入后自动切到“原本琥珀”，只运行文件里的样式。导入仅替换当前预览，点击“保存样式”后才正式生效。
                        </p>

                        <div className="mb-3 flex gap-2 overflow-x-auto no-scrollbar">
                            {CSS_SNIPPETS.map(snippet => (
                                <button
                                    key={snippet.name}
                                    onClick={() => appendSnippet(snippet.code)}
                                    className="shrink-0 rounded-xl border border-stone-200 bg-white px-3 py-2 text-[11px] font-bold text-slate-600"
                                >
                                    + {snippet.name}
                                </button>
                            ))}
                            <button
                                onClick={() => setDraft(current => ({ ...current, customCss: '' }))}
                                className="shrink-0 rounded-xl border border-stone-200 bg-white px-3 py-2 text-[11px] font-bold text-slate-400"
                            >
                                清空 CSS
                            </button>
                        </div>

                        <textarea
                            value={draft.customCss || ''}
                            onChange={event => setDraft(current => ({ ...current, customCss: event.target.value }))}
                            rows={12}
                            spellCheck={false}
                            className="w-full resize-y rounded-2xl border border-stone-200 bg-[#171513] p-4 font-mono text-[11px] leading-5 text-amber-100 outline-none focus:border-amber-500"
                            placeholder={'.sully-journal-paper {\n  border-radius: 8px !important;\n}\n\n.sully-journal-textarea {\n  font-family: serif !important;\n}'}
                        />
                        {!validation.isValid && (
                            <div className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-[11px] leading-5 text-rose-600">
                                {validation.errors[0]}
                            </div>
                        )}

                        <details className="mt-3 text-[11px] text-slate-500">
                            <summary className="cursor-pointer font-bold">查看完整 CSS 钩子</summary>
                            <div className="mt-2 space-y-2 rounded-xl bg-stone-100 px-3 py-3 font-mono text-[10px] leading-5">
                                {JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS.map(group => (
                                    <p key={group.label}>
                                        <b className="font-sans">{group.label}：</b>{group.selectors.join(' / ')}
                                    </p>
                                ))}
                                <p className="font-sans text-slate-400">复制给 AI 的提示词包含上面全部选择器和安全限制。</p>
                            </div>
                        </details>
                    </section>
                </div>

                <div className="sticky bottom-0 grid grid-cols-[auto_1fr_1fr] gap-2 border-t border-stone-200/80 bg-[#fbfaf8]/95 px-5 pb-1 pt-3 backdrop-blur">
                    <button
                        onClick={reset}
                        className="flex h-12 items-center gap-1.5 rounded-2xl bg-stone-100 px-3 text-[11px] font-bold text-stone-500"
                    >
                        <ArrowCounterClockwise size={15} />
                        恢复默认
                    </button>
                    <button
                        onClick={startPreview}
                        disabled={!validation.isValid}
                        className="flex h-12 items-center justify-center gap-1.5 rounded-2xl border border-amber-300 bg-amber-50 px-2 text-[11px] font-bold text-amber-800 disabled:opacity-40"
                    >
                        <Eye size={15} />
                        预览并浏览
                    </button>
                    <button
                        onClick={save}
                        disabled={!validation.isValid}
                        className="h-12 rounded-2xl bg-stone-900 px-2 text-[11px] font-bold text-white disabled:opacity-40"
                    >
                        保存样式
                    </button>
                </div>
            </div>
        </div>
        </>,
        document.body,
    ) : null;

    const previewRescue = isPreviewing && !open ? createPortal(
        <>
            <style>{`
#sully-journal-preview-rescue{
  display:flex!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;
  position:fixed!important;z-index:2147483647!important;left:50%!important;
  top:max(10px,env(safe-area-inset-top))!important;transform:translateX(-50%)!important;
  width:min(94vw,520px)!important;box-sizing:border-box!important;align-items:center!important;
  justify-content:space-between!important;gap:10px!important;padding:10px 12px!important;
  border:1px solid rgba(245,158,11,.45)!important;border-radius:16px!important;
  background:rgba(24,20,16,.94)!important;color:white!important;
  box-shadow:0 12px 32px rgba(0,0,0,.32)!important;backdrop-filter:blur(14px)!important;
  font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif!important;
}
#sully-journal-preview-rescue *{box-sizing:border-box!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
#sully-journal-preview-rescue .preview-copy{display:flex!important;min-width:0!important;align-items:center!important;gap:8px!important;}
#sully-journal-preview-rescue .preview-copy span{display:block!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;font-size:12px!important;font-weight:800!important;color:white!important;}
#sully-journal-preview-rescue .preview-copy small{display:block!important;margin-top:2px!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;font-size:9px!important;color:rgba(255,255,255,.62)!important;}
#sully-journal-preview-rescue .preview-actions{display:flex!important;flex:none!important;gap:6px!important;}
#sully-journal-preview-rescue button{display:block!important;position:static!important;min-width:0!important;height:32px!important;margin:0!important;padding:0 10px!important;border:0!important;border-radius:10px!important;font-size:10px!important;font-weight:800!important;line-height:32px!important;transform:none!important;}
#sully-journal-preview-rescue .preview-edit{background:rgba(255,255,255,.12)!important;color:white!important;}
#sully-journal-preview-rescue .preview-cancel{background:#f59e0b!important;color:#2b1900!important;}
@media(max-width:420px){#sully-journal-preview-rescue{padding:8px 9px!important}#sully-journal-preview-rescue .preview-copy small{display:none!important}#sully-journal-preview-rescue button{padding:0 8px!important}}
            `}</style>
            <div id="sully-journal-preview-rescue" role="status" aria-live="polite">
                <div className="preview-copy">
                    <Eye size={18} weight="bold" />
                    <div>
                        <span>正在预览日记本美化</span>
                        <small>可以自由翻页；目前没有写入正式设置</small>
                    </div>
                </div>
                <div className="preview-actions">
                    <button
                        type="button"
                        className="preview-edit"
                        onClick={() => {
                            setDraft(normalizeAppearance(previewAppearance || theme.journalAppearance));
                            setOpen(true);
                        }}
                    >
                        返回编辑
                    </button>
                    <button
                        type="button"
                        className="preview-cancel"
                        onClick={() => {
                            onCancelPreview();
                            addToast('已撤销日记本预览，正式样式没有改动', 'success');
                        }}
                    >
                        一键撤销
                    </button>
                </div>
            </div>
        </>,
        document.body,
    ) : null;

    const savedStyleRescue = savedStyleBlocksButton && !isPreviewing ? createPortal(
        <>
            <style>{`
#sully-journal-saved-style-rescue{
  display:flex!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;
  position:fixed!important;z-index:2147483647!important;left:50%!important;
  bottom:calc(var(--safe-bottom,0px) + 12px)!important;top:auto!important;
  transform:translateX(-50%)!important;width:auto!important;min-width:0!important;max-width:92vw!important;
  box-sizing:border-box!important;margin:0!important;padding:10px 14px!important;
  border:1px solid rgba(254,215,170,.7)!important;border-radius:999px!important;
  background:rgba(124,45,18,.94)!important;color:white!important;
  box-shadow:0 10px 30px rgba(0,0,0,.34)!important;
  font:800 12px/1.2 system-ui,-apple-system,"Microsoft YaHei",sans-serif!important;
  white-space:nowrap!important;text-decoration:none!important;cursor:pointer!important;
  -webkit-tap-highlight-color:transparent!important;touch-action:manipulation!important;
}
            `}</style>
            <button
                type="button"
                id="sully-journal-saved-style-rescue"
                onClick={reset}
                aria-label="日记美化挡住了设置按钮，一键恢复原版"
            >
                ⟲ 日记美化急救：恢复原版
            </button>
        </>,
        document.body,
    ) : null;

    return (
        <>
            <button
                ref={appearanceButtonRef}
                type="button"
                onClick={() => {
                    setDraft(normalizeAppearance(previewAppearance || theme.journalAppearance));
                    setOpen(true);
                }}
                className={`sully-journal-appearance-button grid place-items-center rounded-full border transition-all active:scale-90 ${
                    compact ? 'h-8 w-8' : 'h-9 w-9'
                } ${
                    tone === 'dark'
                        ? 'border-white/10 bg-white/10 text-white/75 hover:bg-white/15'
                        : 'border-amber-900/10 bg-white/45 text-amber-900 hover:bg-white/70'
                }`}
                title="交换日记样式"
                aria-label="打开交换日记样式设置"
            >
                <GearSix size={compact ? 15 : 17} weight="bold" />
            </button>
            {panel}
            {previewRescue}
            {savedStyleRescue}
        </>
    );
};

export default JournalAppearanceButton;

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiPreset, DialogueApiConfig } from '../../types';
import type { ThinkingChainStyleId } from '../../utils/psycheAppearance';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import ThinkingTranslationSettings from './ThinkingTranslationSettings';
import './thinkingSettings.css';

interface ThinkingChainSettingsValue {
    enabled: boolean;
    styleId: ThinkingChainStyleId;
    customColors: { bg: string; accent: string; text: string };
    customPrompt: string;
    customCss: string;
}
interface Props {
    isOpen: boolean; onClose: () => void;
    value: ThinkingChainSettingsValue;
    onChange: (next: Partial<ThinkingChainSettingsValue>) => void;
    translationApi?: DialogueApiConfig; dialogueApi?: DialogueApiConfig; apiPresets?: ApiPreset[];
    onChangeTranslationApi?: (api: DialogueApiConfig | undefined) => void;
    onAddApiPreset?: (name: string, api: DialogueApiConfig) => void;
}
const HELP_SEEN_KEY = 'os_thinking_help_seen_v1';

const ThinkingChainSettingsModal: React.FC<Props> = ({ isOpen, onClose, value, onChange,
    translationApi, dialogueApi, apiPresets, onChangeTranslationApi, onAddApiPreset }) => {
    const [draftPrompt, setDraftPrompt] = useState(value.customPrompt || '');
    const [helpOpen, setHelpOpen] = useState(false);
    const done = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    useEffect(() => { if (isOpen) setDraftPrompt(value.customPrompt || ''); }, [isOpen, value.customPrompt]);
    useLayoutEffect(() => {
        if (!isOpen) return;
        try {
            setHelpOpen(localStorage.getItem(HELP_SEEN_KEY) !== '1');
            localStorage.setItem(HELP_SEEN_KEY, '1');
        } catch { setHelpOpen(true); }
    }, [isOpen]);
    const commitPrompt = () => { if (draftPrompt !== value.customPrompt) onChange({ customPrompt: draftPrompt }); };
    const close = () => { commitPrompt(); onClose(); };
    useLocalBackHandler(() => { close(); return true; }, 50, isOpen);
    useLayoutEffect(() => {
        if (!isOpen) return;
        const previous = document.activeElement as HTMLElement | null;
        done.current?.focus({ preventScroll: true });
        return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
    }, [isOpen]);
    if (!isOpen) return null;
    return <div className="thinking-settings-overlay" onClick={close}>
        <div ref={panel} role="dialog" aria-modal="true" aria-label="心象设置" className="thinking-settings-panel"
            onClick={event => event.stopPropagation()} onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
                if (event.key !== 'Tab') return;
                const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, summary') || []).filter(el => el.getClientRects().length);
                if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
                if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
            }}>
            <header className="thinking-settings-header"><h2>心象设置</h2><button ref={done} type="button" onClick={close}>完成</button></header>
            <div className="thinking-settings-content">
                <section>
                    <div className="thinking-setting-heading"><h3>显示心象</h3>
                        <button type="button" role="switch" aria-label="显示心象" aria-checked={value.enabled} className="thinking-switch" onClick={() => onChange({ enabled: !value.enabled })}><span /></button>
                    </div>
                    <p className="thinking-setting-hint">关闭后不显示新回复的心象，旧记录保留。</p>
                </section>
                {onChangeTranslationApi && dialogueApi && <ThinkingTranslationSettings value={translationApi} dialogueApi={dialogueApi}
                    presets={apiPresets} onChange={onChangeTranslationApi} onAddPreset={onAddApiPreset} />}
                <section>
                    <h3>追加提示词</h3>
                    <p className="thinking-setting-hint">补充你希望的表达方式，留空沿用默认。语言要求不一定会被模型遵循。</p>
                    <textarea aria-label="心象追加提示词" value={draftPrompt} onChange={event => setDraftPrompt(event.target.value)} onBlur={commitPrompt}
                        placeholder="比如：请用中文概括思考，多写一些感官细节…" />
                </section>
                <details className="thinking-help" open={helpOpen} onToggle={event => setHelpOpen(event.currentTarget.open)}>
                    <summary>关于心象与常见问题</summary>
                    <p>「心象」展示模型或渠道返回的思考文字。有些模型只提供摘要，不代表完整的内部思考，也不保证每轮都有。</p>
                    <p>这些文字可能是分析、规划或自言自语，语气不一定像角色台词。被识别为心象的文字与聊天正文分开保存，不作为普通聊天记录传给下一轮。</p>
                    <p>关闭显示不等于关闭模型推理，也不保证减少思考用量。卡片风格在「个性装扮 → 心象」调整。</p>
                    <h4>开了却没有卡片？</h4>
                    <p>模型或渠道可能没有返回可显示的文字，摘要也可能比实际推理短。同一模型在别处有、这里没有时，可向渠道确认是否分别返回思考和正文。</p>
                    <h4>思考一直是英文？</h4>
                    <p>语言由模型和渠道决定，追加提示词不保证有效。长按心象可选择「复制全文」或「翻译成中文」；翻译只处理这一条心象，保留原文，不改聊天正文。</p>
                    <h4>思考出现在聊天气泡里？</h4>
                    <p>先更新页面，再试一次新回复。如仍出现，请反馈完整模型名、是否流式，以及渠道是否将思考混入正文。无需清空历史；关闭心象无法可靠隐藏没有标记的正文。</p>
                </details>
            </div>
        </div>
    </div>;
};
export default ThinkingChainSettingsModal;
export type { ThinkingChainSettingsValue };

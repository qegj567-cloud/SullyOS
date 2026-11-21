import { MEMORY_GUIDE_SECTIONS } from '../utils/memoryGuide';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { GUIDE_SULLY_ID, hasGuideApi, setGuideStep, setVectorGuideSkipped, useFirstUseGuideStep, useVectorGuideSkipped } from '../utils/firstUseGuide';

const titles = ['为了您的使用体验，请先配置 API 和向量记忆！', '配置向量记忆', '开启 Sully 的全自动记忆', '从神经链接进入聊天', '认识生成按钮', '试着从桌面回到聊天', '记忆会自动整理'];
const descriptions = [
    '先填写聊天服务商提供的地址、API Key 和聊天模型，并保存 API 配置。保存后点击下一步。',
    '向量模型负责按含义找回记忆，与聊天模型不同。不熟悉的话，按下方硅基流动预设选择模型、填写 Key 并保存；熟悉 Embedding 的用户也可以填写其他兼容的向量模型。',
    '在 Sully 卡片上先开启「记忆宫殿」，再开启「全自动记忆」。之后达到整理条件时会自动归档和召回，无需每次手动操作。自动整理会使用 API，并按服务商规则计费。',
    '点击 Sully，再点击角色详情右上角的「发消息」，就能进入 Sully 的聊天界面。神经链接也是日后查看和修改角色记忆的入口。',
    '圈出的闪电按钮就是「生成」，默认在聊天页右上角。先在底部输入并发送文字，再用它让 Sully 回复；也可在输入设置中改为发送按钮代替生成。这里只认识位置，不需要点击：生成会调用 API，可能扣费。',
    '已经回到桌面，请点击「聊天」App，再次进入对话。以后退出聊天后，也可以这样回来；聊天页左上角的返回按钮可以回到桌面。',
    '配置向量记忆并开启全自动后，日常只管聊天，无需再主动整理。查看和更改记忆可到「神经链接」→ Sully →「记忆」或「门牌」；向量节点在「记忆宫殿」查看。原始记忆档案是文字记录，记忆宫殿负责按含义检索，两者不需要重复手动维护。',
];

export default function FirstUseGuide() {
    const step = useFirstUseGuideStep();
    const skippedVector = useVectorGuideSkipped();
    const { apiConfig, memoryPalaceConfig, characters, activeApp, activeCharacterId, openApp, setActiveCharacterId } = useOS();
    const [collapsed, setCollapsed] = useState(false);
    const [targetReady, setTargetReady] = useState(false);
    const [targetHint, setTargetHint] = useState<{ text: string; left: number; top: number; below: boolean } | null>(null);
    const pendingPage = useRef<AppID | null>(null);
    const sully = characters.find(c => c.id === GUIDE_SULLY_ID);
    const navigate = (target: number) => {
        setActiveCharacterId(GUIDE_SULLY_ID);
        const app = target === 0 ? AppID.Settings : target <= 2 ? AppID.MemoryPalace : target === 3 ? AppID.Character : target === 5 ? AppID.Launcher : AppID.Chat;
        pendingPage.current = app;
        openApp(app);
        window.dispatchEvent(new Event('sully:guide-navigate'));
    };
    // Resume after refresh; do not pull the user back while they interact with a page.
    useEffect(() => { if (step !== null) navigate(step); }, [step]);
    useEffect(() => {
        // Navigation must render before accepting a click back into Chat.
        if (pendingPage.current !== null) {
            if (activeApp !== pendingPage.current) return;
            pendingPage.current = null;
        }
        if (step === 3 && activeApp === AppID.Chat && activeCharacterId === GUIDE_SULLY_ID) setGuideStep(4);
        if (step === 5 && activeApp === AppID.Chat) setGuideStep(6);
    }, [step, activeApp, activeCharacterId]);
    useEffect(() => {
        setTargetHint(null);
        if (step === null) return;
        setTargetReady(false);
        let current: Element | null = null;
        let hint = '';
        let scrollFrame = 0;
        const placeHint = () => {
            if (!current) { setTargetHint(null); return; }
            const rect = current.getBoundingClientRect();
            const guideBottom = document.querySelector('[aria-label="首次使用引导"]')?.getBoundingClientRect().bottom || 0;
            if (!rect.width || !rect.height || rect.bottom <= guideBottom || rect.top >= window.innerHeight) {
                setTargetHint(null); return;
            }
            const below = rect.top - 42 < guideBottom;
            const top = below ? Math.min(rect.bottom + 10, window.innerHeight - 42) : rect.top - 42;
            setTargetHint({ text: hint, left: Math.max(104, Math.min(rect.left + rect.width / 2, window.innerWidth - 104)), top: Math.max(guideBottom + 4, top), below });
        };
        const revealTarget = () => {
            if (!current) return;
            if (step === 0) {
                // Settings is lazy-mounted. Its runtime styles must lay out the scroll pane first.
                cancelAnimationFrame(scrollFrame);
                scrollFrame = requestAnimationFrame(() => {
                    current?.scrollIntoView({ block: 'center', inline: 'nearest' });
                    placeHint();
                });
            } else {
                current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
        };
        const highlight = () => {
            let selector = '';
            if (step === 0) { selector = '[data-guide="api"] [data-api-field="base-url"]'; hint = '从这里填写主 API 地址'; }
            if (step === 1) {
                selector = hasGuideApi(memoryPalaceConfig.lightLLM) ? '[data-guide="embedding"]' : '[data-guide="use-main-api"]';
                hint = hasGuideApi(memoryPalaceConfig.lightLLM) ? '配置向量记忆，或选择跳过' : '可点这里，暂时沿用主 API';
            }
            if (step === 2) { selector = '[data-guide="sully-memory"]'; hint = '开启这两个记忆开关'; }
            if (step === 3) {
                selector = document.querySelector('[data-guide="sully-message"]') ? '[data-guide="sully-message"]' : '[data-guide="sully-card"]';
                hint = selector.includes('sully-message') ? '点击「发消息」进入聊天' : '点击 Sully，打开角色详情';
            }
            if (step === 4) { selector = '[data-guide="generate"]'; hint = '生成按钮 · 认识位置即可'; }
            if (step === 5) { selector = '[data-launcher-item="chat"]'; hint = '点击「聊天」回到对话'; }
            let next = selector ? document.querySelector(selector) : null;
            if (step === 2 && next) {
                const toggle = next.querySelector<HTMLInputElement>('input:not(:checked):not(:disabled)');
                if (toggle) {
                    next = toggle.closest('label');
                    hint = sully?.memoryPalaceEnabled ? '点击开启「全自动记忆」' : '先点击开启「记忆宫殿」';
                }
            }
            if (next === current) { placeHint(); return; }
            current?.classList.remove('first-use-highlight');
            current = next;
            setTargetReady(!!next);
            current?.classList.add('first-use-highlight');
            revealTarget();
            placeHint();
        };
        const observer = new MutationObserver(highlight);
        const pageRoot = document.getElementById('root') || document.body;
        observer.observe(pageRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-guide', 'checked', 'disabled'] });
        const resize = new ResizeObserver(placeHint);
        resize.observe(pageRoot);
        window.addEventListener('sully:guide-navigate', revealTarget);
        window.addEventListener('resize', placeHint);
        document.addEventListener('scroll', placeHint, true);
        highlight();
        return () => {
            observer.disconnect(); resize.disconnect(); current?.classList.remove('first-use-highlight');
            cancelAnimationFrame(scrollFrame);
            window.removeEventListener('sully:guide-navigate', revealTarget);
            window.removeEventListener('resize', placeHint);
            document.removeEventListener('scroll', placeHint, true);
        };
    }, [step, activeApp, memoryPalaceConfig.lightLLM, sully?.memoryPalaceEnabled, sully?.autoArchiveEnabled, collapsed]);
    if (step === null) return null;
    const ready = step === 0 ? hasGuideApi(apiConfig) : step === 1 ? hasGuideApi(memoryPalaceConfig.embedding) && hasGuideApi(memoryPalaceConfig.lightLLM) : step === 2 ? !!(sully?.memoryPalaceEnabled && sully.autoArchiveEnabled) : step === 4 ? activeApp === AppID.Chat && targetReady : step !== 3 && step !== 5;
    return <aside aria-label="首次使用引导" className="relative z-[70] shrink-0 bg-white border-b border-violet-200 px-4 py-3 text-slate-700" style={{ maxHeight: '40%', overflowY: 'auto', paddingTop: 'max(12px, var(--safe-top, 0px))' }}>
        <style>{`
            .first-use-highlight { outline: 4px solid #7c3aed !important; outline-offset: 3px; border-radius: 16px; box-shadow: 0 0 0 9px #ede9fe, 0 0 26px 8px #8b5cf670; animation: first-use-beacon 1.8s ease-in-out infinite !important; }
            @keyframes first-use-beacon { 50% { outline-color: #c026d3; box-shadow: 0 0 0 12px #ede9fe, 0 0 32px 10px #a855f780; } }
            @media (prefers-reduced-motion: reduce) { .first-use-highlight { animation: none !important; } }
        `}</style>
        {targetHint && createPortal(<div aria-hidden="true" style={{ position: 'fixed', zIndex: 10000, pointerEvents: 'none', left: targetHint.left, top: targetHint.top, transform: 'translateX(-50%)', maxWidth: 208, padding: '7px 12px', borderRadius: 12, background: '#6d28d9', color: 'white', fontSize: 12, fontWeight: 700, textAlign: 'center', boxShadow: '0 4px 16px #4c1d9555' }}>
            {targetHint.below ? '↑ ' : '↓ '}{targetHint.text}
        </div>, document.body)}
        <div className="flex items-center justify-between gap-3">
            <strong className="text-sm">{skippedVector && step > 2 ? step : step + 1}/{skippedVector ? 6 : 7} · {step === 6 && skippedVector ? '先开始聊天，记忆稍后配置' : titles[step]}</strong>
            <button className="text-xs shrink-0 text-violet-700" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>{collapsed ? '展开引导' : '收起'}</button>
        </div>
        <div className="flex justify-end mt-2">
            <button type="button" onClick={() => setGuideStep('done')} className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">直接跳过引导</button>
        </div>
        {!collapsed && <>
            <p className="text-xs leading-relaxed mt-2">{step === 6 && skippedVector ? '你已跳过向量记忆，本次引导没有为你开启全自动记忆。现在可以先聊天；之后到「记忆宫殿」配置 Embedding API，再开启 Sully 的记忆宫殿和全自动记忆。查看和更改角色记忆可到「神经链接」。' : descriptions[step]}</p>
            {step === 1 && <>
                <p className="text-xs leading-relaxed mt-2 text-amber-800">全自动记忆需要副 API 整理文字、Embedding API 检索记忆，两者缺一不可。副 API 可选择「我想暂时只用主 API」；向量记忆可暂时跳过。硅基流动需要先在<a className="underline" href="https://cloud.siliconflow.cn" target="_blank" rel="noreferrer">网页版完成实名认证</a>才能使用。</p>
            </>}
            {step === 6 && <div className="mt-3 space-y-3">{MEMORY_GUIDE_SECTIONS.map(([title, text]) => <section key={title}><strong className="text-xs">{title}</strong><p className="mt-1 text-xs leading-relaxed">{text}</p></section>)}</div>}
            {step === 6 && <p className="text-xs leading-relaxed mt-2">聊天「＋」→ 设置里的「一键存进记忆宫殿」等是进阶手动工具。全自动用户大部分时候不需要操作，只有明确知道用途和影响时才使用。</p>}
            <div className="flex items-center gap-3 mt-3 text-xs">
                {step > 0 && <button onClick={() => setGuideStep(step === 3 && skippedVector ? 1 : step - 1)}>上一步</button>}
                <button onClick={() => navigate(step)} className="text-violet-700">回到本步页面</button>
                <button disabled={!ready} onClick={() => { if (step === 1) setVectorGuideSkipped(false); setGuideStep(step === 6 ? 'done' : step + 1); }} className="ml-auto rounded-xl px-4 py-2 bg-violet-600 text-white disabled:opacity-40">{step === 6 ? '完成引导' : step === 4 ? '知道了，回桌面' : '下一步'}</button>
            </div>
            {!ready && <p className="mt-2 text-[11px] text-slate-500">{step <= 1 ? '请填写并保存完整配置后继续（保存不代表已验证连通性）。' : step === 2 ? '请开启 Sully 的两个记忆开关后继续。' : step === 4 ? '等待聊天页面显示生成按钮；离开后可点「回到本步页面」。' : '按上面的说明点击页面入口，即可继续引导。'}</p>}
        </>}
    </aside>;
}

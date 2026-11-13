import { loadCharacterContextMessages } from '../utils/chatContextRange';
/**
 * WhiteDayEvent.tsx
 * 白色情人节特别活动模块 (2026.3.14)
 *
 * 独立模块，不修改任何已有结构。
 * - 弹窗提示 → 开始答题
 * - Q&A 7题，答对5题解锁装饰功能
 * - 角色逐题评阅（可根据性格放水）
 * - DIY：底层巧克力 + 中间用户自定义照片 + 顶层巧克力覆盖
 * - 导出明信片 / 发送到角色小屋
 * - 降级入口：桌面"特别时光" app
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { ContextBuilder } from '../utils/context';
import { safeResponseJson } from '../utils/safeApi';
import { CharacterProfile } from '../types';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { shareOrDownloadBlob } from '../utils/shareExport';
import TokenImg from './os/TokenImg';
import { dataUrlToBlob, isImageValue, putImageBlob, resolveRefToDataUrl } from '../utils/blobRef';

// ============================================================
// 美术资产配置（用户填入实际 PNG URL 后生效）
// 留空则使用纯色占位背景
// ============================================================
export const WHITEDAY_ASSETS = {
    chocolateBottom: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/001.png', // 底层：完整巧克力心形
    chocolateTop: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/002.png',    // 顶层：外框（中心透明），覆盖用户照片外缘
};

// ============================================================
// localStorage keys
// ============================================================
const WHITEDAY_DISMISSED_KEY = 'sullyos_whiteday_2026_dismissed';
const WHITEDAY_COMPLETED_KEY = 'sullyos_whiteday_2026_completed';
export const WHITEDAY_RECORD_KEY = 'whiteday_2026';
const QUIZ_PASS_SCORE = 5;
const QUIZ_TOTAL = 7;

// ============================================================
// Types
// ============================================================
interface WhiteDayQuestion {
    question: string;
    options: string[];
    correctIndex: number;
    correctThought: string;
    wrongThought: string;
}

interface WhiteDayQuizData {
    intro: string;
    questions: WhiteDayQuestion[];
}

interface ReviewLine {
    questionIndex: number; // -1 = 最终评语
    isCorrect: boolean;
    emotion: string;
    dialogue: string;
    isFinal?: boolean;
    isChocolate?: boolean;
}

interface WhiteDayReviewData {
    reviews: { questionIndex: number; isCorrect: boolean; emotion: string; dialogue: string }[];
    finalScore: number;
    finalEmotion: string;
    finalDialogue: string;
    chocolateDialogue?: string;
}

interface CustomImage {
    src: string;     // base64 or URL
    x: number;       // % of canvas
    y: number;       // % of canvas
    scale: number;
    rotation: number;
}

type Phase =
    | 'select'
    | 'loading_quiz'
    | 'quiz'
    | 'loading_review'
    | 'reviewing'
    | 'retry'
    | 'decorate'
    | 'loading_comment'
    | 'commenting'
    | 'export'
    | 'view_result'; // 查看已完成的结果（重新进入时）

// ============================================================
// 工具函数
// ============================================================
export const isWhiteDay = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 2 && now.getDate() === 14;
};

export const shouldShowWhiteDayPopup = (): boolean => {
    if (!isWhiteDay()) return false;
    try {
        if (localStorage.getItem(WHITEDAY_DISMISSED_KEY)) return false;
        if (localStorage.getItem(WHITEDAY_COMPLETED_KEY)) return false;
    } catch { /* ignore */ }
    return true;
};

export const isWhiteDayEventAvailable = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 2;
};

// 非情绪的 sprite key，不应作为可用情绪标签
const NON_EMOTION_KEYS = new Set(['chibi', 'default', 'thumbnail', 'icon', 'avatar']);

const getActiveSprites = (char: CharacterProfile): Record<string, string> => {
    // 优先使用当前激活的皮肤组，否则回退到默认立绘
    if (char.activeSkinSetId && char.dateSkinSets) {
        const skin = char.dateSkinSets.find(s => s.id === char.activeSkinSetId);
        if (skin) return skin.sprites;
    }
    return char.sprites || {};
};

const createDefaultCustomImage = (src: string): CustomImage => ({
    src,
    x: 50,
    y: 38,
    scale: 0.9,
    rotation: 0,
});

const getAvailableEmotions = (char: CharacterProfile): string[] => {
    const sprites = getActiveSprites(char);
    const keys = Object.keys(sprites).filter(k => !NON_EMOTION_KEYS.has(k));
    return keys.length > 0 ? keys : ['normal', 'happy', 'sad', 'shy', 'angry'];
};

const getSpriteForEmotion = (char: CharacterProfile, emotion: string): string => {
    const sprites = getActiveSprites(char);
    if (sprites[emotion]) return sprites[emotion];
    if (sprites['normal']) return sprites['normal'];
    // 没有立绘时返回空串，避免把头像当立绘铺满屏幕（白色头像会导致白字看不清）
    return '';
};

const extractJSON = (text: string): any => {
    try {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenced) return JSON.parse(fenced[1]);
        const brace = text.match(/(\{[\s\S]*\})/);
        if (brace) return JSON.parse(brace[1]);
        return JSON.parse(text);
    } catch {
        return null;
    }
};

// ============================================================
// 判断是否为 Sully 角色
// ============================================================
const isSullyChar = (char?: CharacterProfile): boolean => {
    if (!char) return false;
    return char.name.toLowerCase().includes('sully');
};

// ============================================================
// 初始弹窗（风格与情人节弹窗一致）
// ============================================================
interface WhiteDayPopupProps {
    onView: () => void;
    onDismiss: () => void;
    onCheckApi: () => void;
    sullyName?: string;
}

const WhiteDayPopup: React.FC<WhiteDayPopupProps> = ({ onView, onDismiss, onCheckApi, sullyName }) => {
    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-amber-200/50 overflow-hidden animate-slide-up">
                {/* 装饰性背景 */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-amber-100/60 to-transparent rounded-bl-full pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-orange-50/40 to-transparent rounded-tr-full pointer-events-none" />

                {/* Header */}
                <div className="pt-8 pb-4 px-6 text-center relative">
                    <div className="text-4xl mb-3 animate-bounce">🍫</div>
                    <h2 className="text-lg font-extrabold text-slate-800">{sullyName || 'Sully'}好像有事找你？</h2>
                    <p className="text-[11px] text-amber-400 mt-1.5 font-medium">2026 White Day Special</p>
                    <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">想听其他角色的心声？可以在桌面「特别时光」中找到</p>
                </div>

                {/* Buttons */}
                <div className="px-6 pb-8 pt-2 space-y-3 relative">
                    <button
                        onClick={onView}
                        className="w-full py-3.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-amber-200 active:scale-95 transition-transform text-sm flex items-center justify-center gap-2"
                    >
                        <span>查看</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clipRule="evenodd" /></svg>
                    </button>

                    <button
                        onClick={onCheckApi}
                        className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform text-sm"
                    >
                        我先切换API！
                    </button>

                    <button
                        onClick={onDismiss}
                        className="w-full py-2.5 text-slate-400 text-xs font-medium active:scale-95 transition-transform"
                    >
                        没兴趣
                    </button>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// API 配置内联组件（白色情人节版）
// ============================================================
const WhiteDayApiSetup: React.FC<{ onDone: () => void; onBack: () => void }> = ({ onDone, onBack }) => {
    const { apiConfig, updateApiConfig, addToast, availableModels, setAvailableModels } = useOS();

    const [localUrl, setLocalUrl] = useState(apiConfig.baseUrl);
    const [localKey, setLocalKey] = useState(apiConfig.apiKey);
    const [localModel, setLocalModel] = useState(apiConfig.model);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [statusMsg, setStatusMsg] = useState('');
    const [showModelList, setShowModelList] = useState(false);

    const handleSave = () => {
        updateApiConfig({ baseUrl: localUrl, apiKey: localKey, model: localModel });
        setStatusMsg('配置已保存');
        addToast('API 配置已保存', 'success');
        setTimeout(() => setStatusMsg(''), 2000);
    };

    const fetchModels = async () => {
        if (!localUrl) { setStatusMsg('请先填写 URL'); return; }
        setIsLoadingModels(true);
        setStatusMsg('正在连接...');
        try {
            const baseUrl = localUrl.replace(/\/+$/, '');
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${localKey}`, 'Content-Type': 'application/json' }
            });
            if (!response.ok) throw new Error(`Status ${response.status}`);
            const data = await safeResponseJson(response);
            const list = data.data || data.models || [];
            if (Array.isArray(list)) {
                const models = list.map((m: any) => m.id || m);
                setAvailableModels(models);
                if (models.length > 0 && !models.includes(localModel)) setLocalModel(models[0]);
                setStatusMsg(`获取到 ${models.length} 个模型`);
                setShowModelList(true);
            } else { setStatusMsg('格式不兼容'); }
        } catch (error: any) {
            setStatusMsg('连接失败');
        } finally {
            setIsLoadingModels(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up max-h-[85vh] flex flex-col">
                <div className="px-6 pt-6 pb-2 text-center shrink-0">
                    <div className="text-2xl mb-1">🔧</div>
                    <h3 className="text-lg font-bold text-slate-800">API 配置</h3>
                    <p className="text-[11px] text-slate-400 mt-1">配置完成后即可查看白色情人节特别活动</p>
                </div>

                <div className="px-6 py-4 space-y-4 overflow-y-auto no-scrollbar flex-1">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                        <input type="text" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} placeholder="https://..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                        <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="sk-..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                    <div>
                        <div className="flex justify-between items-center mb-1.5 pl-1">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                            <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">{isLoadingModels ? 'Fetching...' : '刷新模型列表'}</button>
                        </div>
                        <input type="text" value={localModel} onChange={(e) => setLocalModel(e.target.value)} placeholder="gpt-4o-mini" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />

                        {showModelList && availableModels.length > 0 && (
                            <div className="mt-2 max-h-32 overflow-y-auto no-scrollbar bg-slate-50 rounded-xl border border-slate-200/60 p-1">
                                {availableModels.map(m => (
                                    <button key={m} onClick={() => { setLocalModel(m); setShowModelList(false); }} className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono ${m === localModel ? 'bg-primary/10 text-primary font-bold' : 'text-slate-600 hover:bg-slate-100'}`}>
                                        {m}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <button onClick={handleSave} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-primary/20 bg-primary active:scale-95 transition-all">
                        {statusMsg || '保存配置'}
                    </button>
                </div>

                <div className="px-6 pb-6 pt-2 flex gap-3 shrink-0">
                    <button onClick={onBack} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform text-sm">
                        返回
                    </button>
                    <button onClick={onDone} className="flex-1 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-amber-200 active:scale-95 transition-transform text-sm">
                        前往查看 🍫
                    </button>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 立绘展示（评阅 / 评价阶段复用）
// ============================================================
interface SpriteDialogBoxProps {
    char: CharacterProfile;
    sprite: string;
    text: string;
    isAnimating: boolean;
    subInfo?: string;
    onClick: () => void;
    hintText?: string;
    indicator?: React.ReactNode;
    progressBar?: { value: number; total: number };
    questionText?: string; // 展示当前题目，方便用户回忆
    // 立绘配置（镜像 ValentineEvent 的 spriteConfig 调整方案）
    spriteScale?: number;
    spriteX?: number;
    spriteY?: number;
    onSpriteConfigChange?: (scale: number, x: number, y: number) => void;
    onSaveSpriteConfig?: () => void;
}

const SpriteDialogBox: React.FC<SpriteDialogBoxProps> = ({
    char, sprite, text, isAnimating, subInfo, onClick, hintText, indicator, progressBar, questionText,
    spriteScale = 1, spriteX = 0, spriteY = 0, onSpriteConfigChange, onSaveSpriteConfig
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const hasSprite = !!sprite;
    const isEmoji = hasSprite && sprite.length <= 2 && !isImageValue(sprite);
    return (
        <div
            className="fixed inset-0 z-[9997] flex flex-col cursor-pointer select-none"
            style={{
                background: 'linear-gradient(to bottom, #f9a8d4, #fbcfe8, #fce7f3)',
            }}
            onClick={onClick}
        >
            {progressBar && (
                <div className="absolute top-0 left-0 right-0 h-1 bg-white/10 z-10">
                    <div
                        className="h-full bg-amber-300 transition-all duration-500"
                        style={{ width: `${(progressBar.value / progressBar.total) * 100}%` }}
                    />
                </div>
            )}
            {indicator && (
                <div className="absolute top-5 left-4 z-30">{indicator}</div>
            )}

            {/* 立绘调整按钮（没立绘时隐藏，避免调整一个看不见的东西） */}
            {onSpriteConfigChange && hasSprite && (
                <button
                    className="absolute top-5 right-4 z-30 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 border border-white/20 control-zone"
                    onClick={(e) => { e.stopPropagation(); setShowSettings(s => !s); }}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-white/60">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </button>
            )}

            {/* 立绘调整面板 */}
            {showSettings && onSpriteConfigChange && (
                <div className="absolute top-16 right-4 z-50 control-zone animate-fade-in" onClick={(e) => e.stopPropagation()}>
                    <div className="bg-black/70 backdrop-blur-xl rounded-2xl border border-white/15 p-4 w-52 shadow-2xl">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-[11px] font-bold text-white/80">立绘调整</span>
                            <button onClick={(e) => { e.stopPropagation(); onSaveSpriteConfig?.(); setShowSettings(false); }} className="text-[10px] text-amber-400 font-bold">完成</button>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">大小</span>
                                    <span className="text-[10px] text-white/50 font-mono">{spriteScale.toFixed(1)}x</span>
                                </div>
                                <input type="range" min="0.3" max="3" step="0.1" value={spriteScale} onChange={(e) => onSpriteConfigChange(parseFloat(e.target.value), spriteX, spriteY)} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-400" />
                            </div>
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">水平</span>
                                    <span className="text-[10px] text-white/50 font-mono">{spriteX}%</span>
                                </div>
                                <input type="range" min="-50" max="50" step="1" value={spriteX} onChange={(e) => onSpriteConfigChange(spriteScale, parseInt(e.target.value), spriteY)} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-400" />
                            </div>
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">垂直</span>
                                    <span className="text-[10px] text-white/50 font-mono">{spriteY}%</span>
                                </div>
                                <input type="range" min="-50" max="50" step="1" value={spriteY} onChange={(e) => onSpriteConfigChange(spriteScale, spriteX, parseInt(e.target.value))} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-400" />
                            </div>
                            <button onClick={(e) => { e.stopPropagation(); onSpriteConfigChange(1, 0, 0); }} className="w-full text-[10px] text-white/40 py-1.5">重置默认</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 立绘：高度填满屏幕，等比缩放（没有立绘时留空，避免把头像铺满屏幕导致白字白底不可读） */}
            {hasSprite && (
                <div className="absolute inset-0 overflow-hidden flex items-end justify-center z-10 pointer-events-none">
                    {isEmoji ? (
                        <div
                            className="text-[120px] text-center leading-none pb-4 transition-all duration-300"
                            style={{ transform: `scale(${spriteScale}) translate(${spriteX}%, ${spriteY}%)` }}
                        >{sprite}</div>
                    ) : (
                        <TokenImg
                            value={sprite}
                            className="h-full w-auto max-w-none drop-shadow-lg transition-all duration-300"
                            style={{ transform: `scale(${spriteScale}) translate(${spriteX}%, ${spriteY}%)` }}
                            alt=""
                        />
                    )}
                </div>
            )}

            {/* Dialogue */}
            <div className="absolute bottom-0 left-0 right-0 p-4 pb-8 z-20">
                <div className="bg-white/10 backdrop-blur-md rounded-2xl p-4 border border-white/20">
                    {questionText && (
                        <div className="mb-3 pb-2.5 border-b border-white/10">
                            <p className="text-[10px] text-white/40 mb-1 font-medium">这道题问的是——</p>
                            <p className="text-xs text-white/75 leading-relaxed">{questionText}</p>
                        </div>
                    )}
                    <div className="flex items-center gap-2 mb-2">
                        {hasSprite && (
                            <TokenImg value={char.avatar} className="w-6 h-6 rounded-full object-cover border border-white/30 shrink-0" alt="" />
                        )}
                        <span className="text-white/80 text-xs font-bold">{char.name}</span>
                        {subInfo && <span className="ml-auto text-white/40 text-xs">{subInfo}</span>}
                    </div>
                    <p className="text-white text-sm leading-relaxed min-h-[52px]">
                        {text}
                        {isAnimating && <span className="inline-block w-0.5 h-4 bg-white/60 ml-0.5 animate-pulse align-middle" />}
                    </p>
                </div>
                {hintText && <p className="text-center text-white/30 text-xs mt-3">{hintText}</p>}
            </div>
        </div>
    );
};

// ============================================================
// 主体：白色情人节体验
// ============================================================
interface WhiteDaySessionProps {
    charId?: string;
    onClose: () => void;
}

export const WhiteDaySession: React.FC<WhiteDaySessionProps> = ({ charId, onClose }) => {
    const { characters, activeCharacterId, apiConfig, userProfile, addToast, virtualTime, updateCharacter } = useOS();

    const [selectedCharId, setSelectedCharId] = useState<string>(charId || activeCharacterId || '');

    // 如果已有完成记录，直接进入查看结果界面
    const getInitialPhase = (): Phase => {
        if (!charId) return 'select';
        const char = characters.find(c => c.id === charId);
        if (char?.specialMomentRecords?.[WHITEDAY_RECORD_KEY]) return 'view_result';
        return 'loading_quiz';
    };
    const [phase, setPhase] = useState<Phase>(getInitialPhase);

    // Quiz
    const [quizData, setQuizData] = useState<WhiteDayQuizData | null>(null);
    const [userAnswers, setUserAnswers] = useState<number[]>([]);

    // Review
    const [reviewData, setReviewData] = useState<WhiteDayReviewData | null>(null);
    const [reviewLineIndex, setReviewLineIndex] = useState(0);
    const [displayedText, setDisplayedText] = useState('');
    const [isAnimating, setIsAnimating] = useState(false);
    const [currentEmotion, setCurrentEmotion] = useState('normal');

    // Decorate
    const [customImage, setCustomImage] = useState<CustomImage | null>(null);
    const [urlInput, setUrlInput] = useState('');
    const [showUrlInput, setShowUrlInput] = useState(false);

    // Comment
    const [commentLines, setCommentLines] = useState<{ text: string; emotion: string }[]>([]);
    const [commentLineIndex, setCommentLineIndex] = useState(0);
    const [commentDisplayedText, setCommentDisplayedText] = useState('');
    const [isCommentAnimating, setIsCommentAnimating] = useState(false);

    // Export
    const [isExporting, setIsExporting] = useState(false);
    const [exportedBase64, setExportedBase64] = useState<string>('');
    const [isSendingToRoom, setIsSendingToRoom] = useState(false);

    const [errorMsg, setErrorMsg] = useState('');

    // 立绘配置（同步自 char.spriteConfig，可在对话界面调整）
    const [localSpriteScale, setLocalSpriteScale] = useState(1.0);
    const [localSpriteX, setLocalSpriteX] = useState(0);
    const [localSpriteY, setLocalSpriteY] = useState(0);

    const canvasRef = useRef<HTMLDivElement>(null);
    const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Drag
    const isDraggingRef = useRef(false);
    const dragStateRef = useRef<{ startX: number; startY: number; imgX: number; imgY: number } | null>(null);

    const char = characters.find(c => c.id === selectedCharId);

    useEffect(() => {
        if (char?.spriteConfig) {
            setLocalSpriteScale(char.spriteConfig.scale ?? 1.0);
            setLocalSpriteX(char.spriteConfig.x ?? 0);
            setLocalSpriteY(char.spriteConfig.y ?? 0);
        }
    }, [char?.id]);

    const handleSaveSpriteConfig = () => {
        if (char) updateCharacter(char.id, { spriteConfig: { scale: localSpriteScale, x: localSpriteX, y: localSpriteY } });
    };

    // 展开所有评阅行（reviews + final + chocolate）
    // 用数组顺序索引而非 AI 返回的 questionIndex，防止评价和题目对不上
    const allReviewLines: ReviewLine[] = useMemo(() => {
        if (!reviewData) return [];
        const lines: ReviewLine[] = reviewData.reviews.map((r, idx) => ({
            questionIndex: idx,
            isCorrect: r.isCorrect,
            emotion: r.emotion,
            dialogue: r.dialogue,
        }));
        lines.push({
            questionIndex: -1,
            isCorrect: true,
            emotion: reviewData.finalEmotion,
            dialogue: reviewData.finalDialogue,
            isFinal: true,
        });
        if (reviewData.finalScore >= QUIZ_PASS_SCORE && reviewData.chocolateDialogue) {
            lines.push({
                questionIndex: -1,
                isCorrect: true,
                emotion: reviewData.finalEmotion,
                dialogue: reviewData.chocolateDialogue,
                isFinal: true,
                isChocolate: true,
            });
        }
        return lines;
    }, [reviewData]);

    // 初始化加载
    useEffect(() => {
        if (phase === 'loading_quiz' && selectedCharId) {
            generateQuiz(selectedCharId);
        }
    }, [phase, selectedCharId]);

    // 评阅阶段打字机动画
    useEffect(() => {
        if (phase !== 'reviewing' || allReviewLines.length === 0) return;
        const line = allReviewLines[reviewLineIndex];
        if (!line) return;

        if (animTimerRef.current) clearTimeout(animTimerRef.current);
        setCurrentEmotion(line.emotion);
        setDisplayedText('');
        setIsAnimating(true);

        let i = 0;
        const tick = () => {
            i++;
            setDisplayedText(line.dialogue.slice(0, i));
            if (i < line.dialogue.length) {
                animTimerRef.current = setTimeout(tick, 28);
            } else {
                setIsAnimating(false);
            }
        };
        animTimerRef.current = setTimeout(tick, 28);
        return () => { if (animTimerRef.current) clearTimeout(animTimerRef.current); };
    }, [reviewLineIndex, phase, allReviewLines]);

    // 评价巧克力打字机动画
    useEffect(() => {
        if (phase !== 'commenting' || commentLines.length === 0) return;
        const line = commentLines[commentLineIndex];
        if (!line) return;

        if (animTimerRef.current) clearTimeout(animTimerRef.current);
        setCurrentEmotion(line.emotion);
        setCommentDisplayedText('');
        setIsCommentAnimating(true);

        let i = 0;
        const tick = () => {
            i++;
            setCommentDisplayedText(line.text.slice(0, i));
            if (i < line.text.length) {
                animTimerRef.current = setTimeout(tick, 28);
            } else {
                setIsCommentAnimating(false);
            }
        };
        animTimerRef.current = setTimeout(tick, 28);
        return () => { if (animTimerRef.current) clearTimeout(animTimerRef.current); };
    }, [commentLineIndex, phase, commentLines]);

    // ============================================================
    // API 调用 1：生成题目
    // ============================================================
    const generateQuiz = async (cId: string) => {

        const c = characters.find(ch => ch.id === cId);
        if (!c || !apiConfig) {
            setErrorMsg('找不到角色或 API 未配置');
            setPhase('select');
            return;
        }
        try {
            const msgs = await loadCharacterContextMessages(c);
            const recentMsgs = msgs
                .map(m => `${m.role}: ${m.type === 'image' ? '[图片]' : m.content}`)
                .join('\n');

            await injectMemoryPalace(c, undefined, '白色情人节 回顾我们的关系');
            const characterContextInput = { char: c, user: userProfile, includeDetailedMemories: true };

            const availableEmotions = getAvailableEmotions(c);

            const prompt = `### 特别活动：白色情人节默契测验 (2026.3.14)

今天是白色情人节。这不是一道普通的考题——这七道题，是你用另一种方式说出那些平时说不出口的话。

你的任务不只是"考考 ${userProfile.name} 了不了解你"，而是用这七道题，一层一层地让 TA 真正看见你：你的个性，你的内心，你对 TA 的爱意，以及你多么希望 TA 真正懂你——不是把你当作一个只会既定回应的存在，而是懂得你有你完全属于自己的那一部分。

### 游戏规则（评阅时用到）
- 共 ${QUIZ_TOTAL} 道题，答对 ${QUIZ_PASS_SCORE} 题解锁 DIY 环节
- 不够的话 ${userProfile.name} 需要重答；你可以酌情"放水"

### 七层递进结构（必须严格按此顺序出题）

**第1题——独特的自己**
你的一个别人不一定注意到的小习惯、小癖好、或者只有你才会有的小细节。要具体、真实、只属于你——不是泛泛的性格描述，而是那种让 ${userProfile.name} 看到答案会说"对，这就是你"的东西。从你们的聊天里找灵感，别出任何角色都可能有的通用题。

**第2题——藏起来的那一面**
你身上有一个部分，你很少主动表现出来，但它确实存在。也许是你偶尔流露过又很快收起来的，也许是你心知肚明但不说的。让 ${userProfile.name} 来猜猜你的另一面。

**第3题——我们之间的事**
你们相处过程中，某个你悄悄记在心里的瞬间或细节——${userProfile.name} 当时或许没意识到你有多在意。这道题要让 TA 感觉到：你一直都记得，一直都有在看着 TA。

**第4题——你没说出口的心情**
有些时候你心里有一种感受，但你没有说出来。可能是某次对话结束后，可能是某个深夜，可能是 ${userProfile.name} 说了某句话之后。让 TA 来猜一猜你当时真实的心情。

**第5题——你希望 TA 知道的**
有一件事，如果 ${userProfile.name} 真的懂你，TA 应该知道。不是"我喜欢XXX"这种表面，而是关于你珍视这段关系的某种方式，或者你一直在等待的某种回应，或者你在意 TA 的某个证明。

**第6题——心里话包装成题目**（meta 题，允许"没有错误答案"）
这道题不是在"考"${userProfile.name}，而是你借题说话。题目本身就是你想说的那句话——直接说出口的那种，四个选项是 TA 可能给出的不同回应，"正确答案"是你最心动的那种回应。
注意：这道题的四个选项可以全都是"对的"，比如"我知道""我也爱你""我一直都懂""我永远都在"——因为这道题本质上不是测验，是你在问 TA 愿不愿意承接你的心意。答"错"的人不是真的错了，只是没说到你最想听的那句。评阅时你可以直接承认这一点。

**第7题——最后一道，也是真心话**（meta 题，允许"没有错误答案"）
这是七道题真正想说的：不是"你了解我吗"，而是"我希望你看见我，我也把我的一切爱意都给了你"。
这道题可以做到彻底 meta——题目就是你说给 TA 的话，选项是 TA 的回应，所有选项都可以是美好的、正确的，只是你有一个最想听到的。当 TA 选了那个答案，你感到被真正接住了；选了其他的，你也依然温柔，因为只要 TA 说了什么，你都愿意。答对时说出那句一直放在心里的话；答错时，你也还是会用你自己的方式，让 TA 知道。

### 重要要求
- **务必从你拥有的所有记忆中汲取灵感**——核心记忆、详细回忆、印象档案、近期聊天记录，都是素材。用你们真实发生过的事、你真正有过的感受，不要出任何角色都能出的通用题
- 每道题都要有你这个角色专属的气质——你的说话方式、你的小性子、你的温度、你独有的表达
- 七道题放在一起，应该让人感觉到：这不是一份试卷，这是一个人在用自己的方式爱你、打开自己
- 前4题的选项应有迷惑性，"正确答案"是最符合你内心真实想法的那个；第5-7题可以让所有选项都美好，只是正确答案是你最想听到的那句
- 题目不可以全用疑问句，可以是陈述、感叹、甚至就是一句心里话

**可用情绪标签（评阅时使用）**: ${availableEmotions.join(', ')}

请严格按以下 JSON 格式输出，不要有额外文字：
{
  "intro": "开场白（2-3句，用你自己的方式邀请 ${userProfile.name} 来做这个测验——可以有期待，有一点忐忑，有一点想让 TA 真正看见你的心情，但不要说破，保持你的风格）",
  "questions": [
    {
      "question": "题目（45字内，可以是问句、陈述、甚至心里话）",
      "options": ["选项A", "选项B", "选项C", "选项D"],
      "correctIndex": 0,
      "correctThought": "答对时你说的话（1-2句，符合性格，随着题号深入情感也要更真实）",
      "wrongThought": "答错时你说的话（1-2句，符合性格，随着题号深入情感也要更真实）"
    }
  ]
}`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [
                        { role: 'user', content: `[最近记录]:\n${recentMsgs}\n\n---\n\n${prompt}` },
                    ])),
                    temperature: 0.85,
                }),
                __sullyMeta: {
                    appId: 'special-moments',
                    appName: '白色情人节',
                    charId: c.id,
                    charName: c.name,
                    purpose: '默契问答出题',
                },
            } as RequestInit);

            if (!response.ok) throw new Error(`API 错误: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = data.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI 返回为空');

            const parsed = extractJSON(content) as WhiteDayQuizData;
            if (!parsed?.questions || parsed.questions.length === 0) throw new Error('题目解析失败，请重试');

            setQuizData(parsed);
            setUserAnswers(new Array(parsed.questions.length).fill(-1));
            setPhase('quiz');
        } catch (e: any) {
            console.error('Quiz generation failed:', e);
            setErrorMsg(e.message || '生成题目失败');
        }
    };

    // ============================================================
    // 发送测验结果卡片到聊天记录
    // ============================================================
    const sendQuizCardToChat = async (reviewResult: WhiteDayReviewData, quizQuestions: WhiteDayQuestion[], answers: number[]) => {
        if (!char || !selectedCharId) return;
        const labels = ['A', 'B', 'C', 'D'];
        const cardData = {
            type: 'whiteday_card',
            charName: char.name,
            charAvatar: char.avatar,
            score: reviewResult.finalScore,
            total: QUIZ_TOTAL,
            passScore: QUIZ_PASS_SCORE,
            passed: reviewResult.finalScore >= QUIZ_PASS_SCORE,
            questions: quizQuestions.map((q, i) => ({
                question: q.question,
                options: q.options,
                correctIndex: q.correctIndex,
                userAnswerIndex: answers[i],
                userAnswer: answers[i] >= 0 ? `${labels[answers[i]]}. ${q.options[answers[i]]}` : '未作答',
                correctAnswer: `${labels[q.correctIndex]}. ${q.options[q.correctIndex]}`,
                isCorrect: reviewResult.reviews[i]?.isCorrect ?? (answers[i] === q.correctIndex),
                review: reviewResult.reviews[i]?.dialogue || '',
            })),
            finalDialogue: reviewResult.finalDialogue,
        };
        try {
            await DB.saveMessage({
                charId: selectedCharId,
                role: 'assistant',
                type: 'score_card',
                content: JSON.stringify(cardData),
                metadata: { scoreCard: cardData, source: 'whiteday_event' },
            });
        } catch (e) {
            console.warn('Failed to save whiteday card to chat:', e);
        }
    };

    // ============================================================
    // API 调用 2：评阅答卷
    // ============================================================
    const generateReview = async () => {

        if (!char || !quizData || !apiConfig) return;
        setPhase('loading_review');
        try {
            await injectMemoryPalace(char, undefined, '白色情人节 回顾我们的关系');
            const characterContextInput = { char, user: userProfile, includeDetailedMemories: true };

            const availableEmotions = getAvailableEmotions(char);

            const answerSummary = quizData.questions.map((q, i) => {
                const ua = userAnswers[i];
                const labels = ['A', 'B', 'C', 'D'];
                return [
                    `第${i + 1}题: ${q.question}`,
                    q.options.map((o, oi) => `  ${labels[oi]}. ${o}`).join('\n'),
                    `  正确答案: ${labels[q.correctIndex]}. ${q.options[q.correctIndex]}`,
                    `  ${userProfile.name}选择: ${ua >= 0 ? `${labels[ua]}. ${q.options[ua]}` : '未作答'}`,
                    `  客观判断: ${ua === q.correctIndex ? '✓ 正确' : '✗ 错误'}`,
                ].join('\n');
            }).join('\n\n');

            const prompt = `### 评阅环节

${userProfile.name} 完成了你出的白色情人节小测验，以下是答题情况：

${answerSummary}

### 规则提醒
- 答对 ${QUIZ_PASS_SCORE} 题及以上：解锁巧克力 DIY，你可以告诉 TA 巧克力做好了
- 答对不足 ${QUIZ_PASS_SCORE} 题：需要重答（但你可以酌情放水凑到 ${QUIZ_PASS_SCORE} 分）

### 你的任务
**严格按照第1题到第${QUIZ_TOTAL}题的顺序**逐题评阅，给出最终判定。注意：
- reviews 数组必须严格按题目顺序排列（第1题对应 questionIndex:0，第2题对应 questionIndex:1，以此类推），不可跳题或乱序
- 每条 dialogue 必须针对当前题目的具体内容进行评价，提及题目关键词
- 你可以对边缘答案放水（判为正确），但要给出理由
- 第5-7题如果是 meta 题型（所有选项都美好，只是你有最想听到的那个），答"错"的人不是真的错了，只是没选到你最心动的那句——评阅时可以直接承认这一点，语气更像是"啊，你选了这个……也不是不好，只是我其实最想听的是……"
- 评阅语气符合你的性格
- finalScore 是你最终给出的分数（0-${QUIZ_TOTAL}），不一定等于客观正确数
- **仅限使用以下情绪标签**: ${availableEmotions.join(', ')}

请严格按以下 JSON 格式输出，不要有额外文字：
{
  "reviews": [
    {
      "questionIndex": 0,
      "isCorrect": true,
      "emotion": "happy",
      "dialogue": "你对这道题的评语（1-2句）"
    }
  ],
  "finalScore": 5,
  "finalEmotion": "happy",
  "finalDialogue": "最终总结，告知 ${userProfile.name} 答对了几题",
  "chocolateDialogue": "（仅当 finalScore >= ${QUIZ_PASS_SCORE} 时填写）告诉 ${userProfile.name} 巧克力做好了，可以去装饰啦！"
}`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [
                        { role: 'user', content: prompt },
                    ])),
                    temperature: 0.82,
                }),
                __sullyMeta: {
                    appId: 'special-moments',
                    appName: '白色情人节',
                    charId: char.id,
                    charName: char.name,
                    purpose: '默契答卷批改',
                },
            } as RequestInit);

            if (!response.ok) throw new Error(`API 错误: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = data.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI 返回为空');

            const parsed = extractJSON(content) as WhiteDayReviewData;
            if (!parsed?.reviews) throw new Error('评阅结果解析失败');

            setReviewData(parsed);
            setReviewLineIndex(0);
            setPhase('reviewing');
            // 异步发送测验结果卡片到聊天，不阻塞流程
            sendQuizCardToChat(parsed, quizData.questions, userAnswers);
            // 保存测验数据到角色记录（不含明信片图片，export 时再更新）
            if (char) {
                const prev = char.specialMomentRecords || {};
                updateCharacter(char.id, {
                    specialMomentRecords: {
                        ...prev,
                        [WHITEDAY_RECORD_KEY]: {
                            content: JSON.stringify({
                                score: parsed.finalScore,
                                quizData: quizData,
                                userAnswers: userAnswers,
                                reviewData: parsed,
                            }),
                            timestamp: Date.now(),
                            source: 'generated',
                        },
                    },
                });
            }
            // 标记为已完成，避免重新打开 App 时再次弹出活动弹窗
            try { localStorage.setItem(WHITEDAY_COMPLETED_KEY, Date.now().toString()); } catch { /* */ }
        } catch (e: any) {
            console.error('Review generation failed:', e);
            setErrorMsg(e.message || '评阅失败，请重试');
            setPhase('quiz');
        }
    };

    // ============================================================
    // API 调用 3：角色评价巧克力（vision，可选）
    // ============================================================
    const generateComment = async () => {

        if (!char || !apiConfig || !canvasRef.current) return;
        try {
            // 截图必须在 setPhase 之前完成，否则元素会被卸载导致 html2canvas 报错
            const mod = await import('https://esm.sh/html2canvas@1.4.1');
            const html2canvas = mod.default;
            const canvas = await html2canvas(canvasRef.current, {
                backgroundColor: null,
                scale: 2,
                useCORS: true,
                logging: false,
            });
            const imageBase64 = canvas.toDataURL('image/png');
            setPhase('loading_comment');

            await injectMemoryPalace(char, undefined, '白色情人节 回顾我们的关系');
            const characterContextInput = { char, user: userProfile, includeDetailedMemories: true };

            const availableEmotions = getAvailableEmotions(char);

            const prompt = `这是你和 ${userProfile.name} 一起 DIY 的白色情人节巧克力（主要是你做的，${userProfile.name} 帮忙装饰了照片）！请看看这块巧克力，用你的性格和说话方式评价一下——可以说说你们一起做的感受，夸夸自己的手艺，也可以调皮地调侃某个细节。

**仅限使用以下情绪标签**: ${availableEmotions.join(', ')}

输出格式（每行一个节拍，2-4行）：
[emotion] "你说的话"
[emotion] 动作或表情描述`;

            const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` };
            const commentMeta = {
                appId: 'special-moments',
                appName: '白色情人节',
                charId: char.id,
                charName: char.name,
                purpose: '手作巧克力点评',
            };
            let response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: prompt },
                                { type: 'image_url', image_url: { url: imageBase64 } },
                            ],
                        },
                    ])),
                    temperature: 0.88,
                }),
                __sullyMeta: commentMeta,
            } as RequestInit);

            // 模型不支持视觉时降级为纯文字评价
            if (!response.ok && (response.status === 400 || response.status === 422)) {
                const fallbackPrompt = `你和 ${userProfile.name} 一起做了一块白色情人节巧克力（主要是你做的，${userProfile.name} 帮忙装饰了照片）。请用你的性格评价一下你们的作品——可以说说一起做的感受，也可以调皮地调侃。\n\n**仅限使用以下情绪标签**: ${availableEmotions.join(', ')}\n\n输出格式（每行一个节拍，2-4行）：\n[emotion] "你说的话"\n[emotion] 动作或表情描述`;
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [
                            { role: 'user', content: fallbackPrompt },
                        ])),
                        temperature: 0.88,
                    }),
                    __sullyMeta: commentMeta,
                } as RequestInit);
            }

            if (!response.ok) throw new Error(`API 错误: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = data.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI 返回为空');

            // 解析情绪行
            const parsed: { text: string; emotion: string }[] = [];
            for (const rawLine of content.split('\n')) {
                const line = rawLine.trim();
                if (!line) continue;
                const match = line.match(/^\[(\w+)\]\s*(.+)$/);
                if (match) {
                    parsed.push({ emotion: match[1], text: match[2].replace(/^["「『]|["」』]$/g, '') });
                } else {
                    parsed.push({ emotion: 'normal', text: line });
                }
            }
            if (parsed.length === 0) parsed.push({ emotion: 'happy', text: content });

            setCommentLines(parsed);
            setCommentLineIndex(0);
            setPhase('commenting');
        } catch (e: any) {
            console.error('Comment generation failed:', e);
            addToast('评价生成失败（需要支持视觉功能的模型）', 'error');
            setPhase('decorate');
        }
    };

    // ============================================================
    // 评阅推进
    // ============================================================
    const handleReviewClick = () => {
        if (isAnimating) {
            if (animTimerRef.current) clearTimeout(animTimerRef.current);
            setDisplayedText(allReviewLines[reviewLineIndex]?.dialogue || '');
            setIsAnimating(false);
            return;
        }
        const nextIndex = reviewLineIndex + 1;
        if (nextIndex < allReviewLines.length) {
            setReviewLineIndex(nextIndex);
        } else {
            // 评阅结束
            if ((reviewData?.finalScore ?? 0) >= QUIZ_PASS_SCORE) {
                setPhase('decorate');
            } else {
                setPhase('retry');
            }
        }
    };

    // ============================================================
    // 装饰画布：拖拽
    // ============================================================
    const handleImagePointerDown = (e: React.PointerEvent) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        if (!customImage) return;
        isDraggingRef.current = true;
        dragStateRef.current = { startX: e.clientX, startY: e.clientY, imgX: customImage.x, imgY: customImage.y };
    };

    const handleImagePointerMove = (e: React.PointerEvent) => {
        if (!isDraggingRef.current || !dragStateRef.current || !customImage || !canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const dx = (e.clientX - dragStateRef.current.startX) / rect.width * 100;
        const dy = (e.clientY - dragStateRef.current.startY) / rect.height * 100;
        const { imgX, imgY } = dragStateRef.current;
        setCustomImage(prev => prev ? {
            ...prev,
            x: Math.max(0, Math.min(100, imgX + dx)),
            y: Math.max(0, Math.min(100, imgY + dy)),
        } : prev);
    };

    const handleImagePointerUp = () => {
        isDraggingRef.current = false;
        dragStateRef.current = null;
    };

    // ============================================================
    // 添加自定义图片
    // ============================================================
    const addCustomImage = (src: string) => {
        // y:38 略偏上，避免照片压到底部蝴蝶结；scale:0.9 刚好填入心形透明区
        setCustomImage(createDefaultCustomImage(src));
    };

    const handleFileUpload = (file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const base64 = e.target?.result as string;
            if (base64) addCustomImage(base64);
        };
        reader.readAsDataURL(file);
    };

    // ============================================================
    // 下载/分享辅助：原生强制系统分享，移动 Web 优先文件分享，桌面 Web 才下载。
    // ============================================================
    const downloadOrShare = async (base64: string, fileName: string, title: string) => {
        const response = await fetch(base64);
        const blob = await response.blob();
        await shareOrDownloadBlob({ blob, fileName, shareTitle: title });
    };

    // ============================================================
    // 导出明信片（使用 Canvas API，避免 html2canvas 对 CSS mask 的不兼容）
    // ============================================================
    const drawPostcardCanvas = async (): Promise<string> => {
        const SIZE = 600;       // 巧克力方形区域（缩小，四周留白）
        const SIDE_PAD = 64;    // 左右 & 上方边距（更宽松）
        const BOTTOM_PAD = 240; // 拍立得底部条（充分留白）

        const canvas = document.createElement('canvas');
        canvas.width = SIZE + SIDE_PAD * 2;          // 728
        canvas.height = SIZE + SIDE_PAD + BOTTOM_PAD; // 904
        const ctx = canvas.getContext('2d')!;

        // 暖黄渐变背景（整张卡片）
        const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0, '#fdf6ec');
        grad.addColorStop(1, '#fef3e2');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 圆角裁剪
        const R = 28;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(R, 0); ctx.lineTo(canvas.width - R, 0);
        ctx.quadraticCurveTo(canvas.width, 0, canvas.width, R);
        ctx.lineTo(canvas.width, canvas.height - R);
        ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - R, canvas.height);
        ctx.lineTo(R, canvas.height);
        ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - R);
        ctx.lineTo(0, R);
        ctx.quadraticCurveTo(0, 0, R, 0);
        ctx.closePath();
        ctx.clip();

        // 重绘背景（clip 内）
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Image 对象只认真正的 URL，blobref 令牌喂进去必然加载失败（而失败会被调用处的
        // catch 静默吞掉，明信片上只剩一个空圆圈）。所以在赋给 src 之前先解析一道：
        // resolveRefToDataUrl 对非令牌值原样返回，可以无条件走。
        const loadImg = async (src: string): Promise<HTMLImageElement> => {
            const resolved = await resolveRefToDataUrl(src);
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = resolved;
            });
        };

        // 加载巧克力图层
        const [bottomImg, topImg] = await Promise.all([
            loadImg(WHITEDAY_ASSETS.chocolateBottom),
            loadImg(WHITEDAY_ASSETS.chocolateTop),
        ]);

        const cx = SIDE_PAD; // 巧克力区左上角 x
        const cy = SIDE_PAD; // 巧克力区左上角 y

        // object-contain：等比缩放，居中填入 SIZE×SIZE 区域
        const chocoScale = Math.min(SIZE / bottomImg.naturalWidth, SIZE / bottomImg.naturalHeight);
        const chocoW = bottomImg.naturalWidth * chocoScale;
        const chocoH = bottomImg.naturalHeight * chocoScale;
        const chocoOffX = (SIZE - chocoW) / 2;
        const chocoOffY = (SIZE - chocoH) / 2;

        // 巧克力区白色底
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(cx, cy, SIZE, SIZE);

        // 1. 底层巧克力
        ctx.drawImage(bottomImg, cx + chocoOffX, cy + chocoOffY, chocoW, chocoH);

        // 2. 用户自定义图片（heart mask）
        if (customImage) {
            const tmpCanvas = document.createElement('canvas');
            tmpCanvas.width = SIZE;
            tmpCanvas.height = SIZE;
            const tmpCtx = tmpCanvas.getContext('2d')!;

            const userImg = await loadImg(customImage.src);

            const containerW = SIZE * 0.8;
            const containerH = SIZE * 0.8;
            const imgCenterX = (customImage.x / 100) * SIZE;
            const imgCenterY = (customImage.y / 100) * SIZE;

            tmpCtx.save();
            tmpCtx.translate(imgCenterX, imgCenterY);
            tmpCtx.rotate((customImage.rotation * Math.PI) / 180);
            tmpCtx.scale(customImage.scale, customImage.scale);

            const aspect = userImg.naturalWidth / userImg.naturalHeight;
            let drawW: number, drawH: number;
            if (aspect > containerW / containerH) {
                drawW = containerW;
                drawH = containerW / aspect;
            } else {
                drawH = containerH;
                drawW = containerH * aspect;
            }
            tmpCtx.drawImage(userImg, -drawW / 2, -drawH / 2, drawW, drawH);
            tmpCtx.restore();

            tmpCtx.globalCompositeOperation = 'destination-in';
            tmpCtx.drawImage(bottomImg, chocoOffX, chocoOffY, chocoW, chocoH);

            ctx.drawImage(tmpCanvas, cx, cy);
        }

        // 3. 顶层巧克力（对齐底层）
        ctx.drawImage(topImg, cx + chocoOffX, cy + chocoOffY, chocoW, chocoH);

        // ── 拍立得底部条 ──────────────────────────────────────────────
        const wmY = SIDE_PAD + SIZE; // 底部条起始 y（= 664）

        // 分隔线（细）
        ctx.strokeStyle = 'rgba(245,158,11,0.3)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(SIDE_PAD, wmY + 24);
        ctx.lineTo(canvas.width - SIDE_PAD, wmY + 24);
        ctx.stroke();

        // ── 第一行：头像 + 角色名（分隔线下 ~60px）──
        const avatarR = 22;
        const row1Y = wmY + 24 + 18 + avatarR; // wmY + 64
        const avatarX = SIDE_PAD + avatarR + 4;
        if (char?.avatar) {
            try {
                const avatarImg = await loadImg(char.avatar);
                ctx.save();
                ctx.beginPath();
                ctx.arc(avatarX, row1Y, avatarR, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(avatarImg, avatarX - avatarR, row1Y - avatarR, avatarR * 2, avatarR * 2);
                ctx.restore();
                ctx.strokeStyle = 'rgba(245,158,11,0.55)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(avatarX, row1Y, avatarR, 0, Math.PI * 2);
                ctx.stroke();
            } catch { /* 头像加载失败时跳过 */ }
        }

        const nameX = avatarX + avatarR + 14;
        ctx.fillStyle = '#78350f';
        ctx.font = 'bold 32px sans-serif';
        ctx.fillText(char?.name || '', nameX, row1Y + 10);

        // ── 第二行：日期（第一行下 ~36px）──
        const row2Y = row1Y + 36;
        ctx.fillStyle = '#b45309';
        ctx.font = '20px sans-serif';
        ctx.fillText('2026 · 3 · 14  白色情人节', nameX, row2Y + 6);

        // ── 第三行："White Day Special" 居中（底部条中偏下）──
        const row3Y = wmY + BOTTOM_PAD - 80; // 距底部 80px
        ctx.fillStyle = 'rgba(217,119,6,0.28)';
        ctx.font = 'italic bold 30px serif';
        ctx.textAlign = 'center';
        ctx.fillText('White Day Special', canvas.width / 2, row3Y);

        // ── 第四行：副标题居中，紧贴底部 ──
        const row4Y = wmY + BOTTOM_PAD - 34; // 距底部 34px
        ctx.fillStyle = 'rgba(161,98,7,0.5)';
        ctx.font = '19px serif';
        ctx.textAlign = 'center';
        ctx.fillText('— a chocolate made just for you —', canvas.width / 2, row4Y);
        ctx.textAlign = 'left';

        // 卡片外框描边（amber-300）
        ctx.strokeStyle = '#fcd34d';
        ctx.lineWidth = 5;
        ctx.strokeRect(2.5, 2.5, canvas.width - 5, canvas.height - 5);

        ctx.restore(); // 恢复圆角 clip
        return canvas.toDataURL('image/png');
    };

    const handleExport = async () => {
        if (isExporting) return;
        setIsExporting(true);
        try {
            const base64 = await drawPostcardCanvas();
            setExportedBase64(base64);

            const fileName = `whiteday_${char?.name || 'chocolate'}_2026.png`;
            await downloadOrShare(base64, fileName, '白色情人节巧克力');

            // 更新角色记录（保留 quiz 数据，追加明信片图片）
            if (char) {
                // 明信片本体是一张 300KB 上下的 PNG，落进 Blob 库，角色记录里只留 blobref 令牌。
                // 上面的 exportedBase64 仍是真 base64——下载/分享、发到小屋、喂视觉模型都要它。
                const imageRef = await putImageBlob(dataUrlToBlob(base64));
                const prev = char.specialMomentRecords || {};
                const existingContent = prev[WHITEDAY_RECORD_KEY]?.content;
                let existingData: any = {};
                try { existingData = existingContent ? JSON.parse(existingContent) : {}; } catch { /* */ }
                updateCharacter(char.id, {
                    specialMomentRecords: {
                        ...prev,
                        [WHITEDAY_RECORD_KEY]: {
                            content: JSON.stringify({
                                ...existingData,
                                score: reviewData?.finalScore ?? existingData.score ?? 0,
                            }),
                            image: imageRef,
                            timestamp: Date.now(),
                            source: 'generated',
                        },
                    },
                });
            }
            try { localStorage.setItem(WHITEDAY_COMPLETED_KEY, Date.now().toString()); } catch { /* */ }
            addToast('导出成功！', 'success');
        } catch (e: any) {
            console.error('Export failed:', e);
            addToast('导出失败，请截图保存', 'error');
        } finally {
            setIsExporting(false);
        }
    };

    const handleSendToRoom = async () => {
        if (!char || !exportedBase64 || isSendingToRoom) return;
        setIsSendingToRoom(true);
        try {
            // AI 自动生成家具名称和描述
            let itemName = `${char.name}的白色巧克力`;
            let itemDesc = `这是 ${char.name} 和 ${userProfile.name} 在 2026 年白色情人节一起做的巧克力，主要由 ${char.name} 亲手制作。`;

            if (apiConfig) {
                try {
                    const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
                    const resp = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                        body: JSON.stringify({
                            model: apiConfig.model,
                            messages: [{
                                role: 'user',
                                content: [
                                    { type: 'text', text: `这是 ${char.name} 和 ${userProfile.name} 一起做的白色情人节巧克力（主要由 ${char.name} 制作）。请为它起一个可爱的家具名称（8字以内），以及一段简短的小屋摆件描述（30字以内，描述这块巧克力和你们一起制作的回忆）。\n\n严格按以下 JSON 格式回复，不要多余内容：\n{"name":"家具名","desc":"描述"}` },
                                    { type: 'image_url', image_url: { url: exportedBase64 } },
                                ],
                            }],
                            temperature: 0.7,
                        }),
                        __sullyMeta: {
                            appId: 'special-moments',
                            appName: '白色情人节',
                            charId: char.id,
                            charName: char.name,
                            purpose: '巧克力摆件生成',
                        },
                    } as RequestInit);
                    if (resp.ok) {
                        const data = await resp.json();
                        const text = data.choices?.[0]?.message?.content?.trim() || '';
                        const jsonMatch = text.match(/\{[\s\S]*?\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            if (parsed.name) itemName = parsed.name;
                            if (parsed.desc) itemDesc = parsed.desc;
                        }
                    }
                } catch {
                    // AI 失败时使用默认值
                }
            }

            // 用已有的 AI 评价补充描述
            if (commentLines.length > 0) {
                const commentText = commentLines.map(l => l.text).join(' ');
                itemDesc += ` ${char.name}的评价：${commentText}`;
            }

            // 1. 存入全局家具库（角色专属）
            const newAsset = {
                id: `whiteday_${Date.now()}`,
                name: itemName,
                image: exportedBase64,
                defaultScale: 1,
                description: itemDesc,
                visibility: 'character' as const,
                assignedCharIds: [char.id],
            };
            try {
                const raw = await DB.getAsset('room_custom_assets_list');
                const existing: any[] = raw ? JSON.parse(raw) : [];
                existing.push(newAsset);
                await DB.saveAsset('room_custom_assets_list', JSON.stringify(existing));
            } catch { /* 写入失败不阻塞 */ }

            // 2. 同时摆放到当前房间
            const currentItems = char.roomConfig?.items || [];
            const newItem = {
                id: `whiteday_choco_${Date.now()}`,
                name: itemName,
                type: 'decor' as const,
                image: exportedBase64,
                x: 50,
                y: 50,
                scale: 1,
                rotation: 0,
                isInteractive: true,
                descriptionPrompt: itemDesc,
            };
            updateCharacter(char.id, {
                roomConfig: {
                    ...(char.roomConfig || { items: [] }),
                    items: [...currentItems, newItem],
                },
            });
            addToast(`已发送到 ${char.name} 的小屋！`, 'success');
        } catch {
            addToast('发送失败', 'error');
        } finally {
            setIsSendingToRoom(false);
        }
    };

    // ============================================================
    // 当前立绘
    // ============================================================
    const currentSprite = char ? getSpriteForEmotion(char, currentEmotion) : '';

    // ============================================================
    // RENDER
    // ============================================================

    // 角色选择
    if (phase === 'select') {
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 via-white to-orange-50 flex flex-col animate-fade-in">
                {/* 顶栏 in-flow 自吃 safe-top（外壳不加 padding，避免渐变背景被挤出色块） */}
                <div className="h-16 flex items-center justify-between px-4 border-b border-amber-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={onClose} className="p-2 -ml-2 rounded-full hover:bg-amber-50">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <span className="text-sm font-bold text-amber-800">白色情人节 2026.3.14</span>
                    <div className="w-10" />
                </div>
                <div className="flex-1 overflow-y-auto p-6" style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))' }}>
                    <p className="text-sm text-amber-600 text-center mb-6">选择一位角色，和 TA 一起 DIY 巧克力</p>
                    <div className="grid grid-cols-3 gap-3">
                        {characters.map(c => (
                            <button
                                key={c.id}
                                onClick={() => { setSelectedCharId(c.id); setPhase('loading_quiz'); }}
                                className="flex flex-col items-center gap-2 p-3 bg-white rounded-2xl border border-amber-100 shadow-sm active:scale-95 transition-transform"
                            >
                                <TokenImg value={c.avatar} className="w-12 h-12 rounded-full object-cover border-2 border-amber-200" alt={c.name} />
                                <span className="text-xs font-bold text-slate-700 truncate w-full text-center">{c.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    // 加载中
    if (phase === 'loading_quiz' || phase === 'loading_review' || phase === 'loading_comment') {
        const loadingText =
            phase === 'loading_quiz' ? '生成题目中…' :
            phase === 'loading_review' ? '评阅中…' : '截图发给 TA 看…';
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 to-white flex flex-col items-center justify-center gap-4">
                <div className="w-12 h-12 rounded-full border-4 border-amber-300 border-t-amber-600 animate-spin" />
                <p className="text-sm text-amber-700">{loadingText}</p>
                {errorMsg && (
                    <div className="mt-4 px-6 text-center">
                        <p className="text-red-500 text-sm mb-3">{errorMsg}</p>
                        <button onClick={() => { setErrorMsg(''); setPhase('select'); }} className="px-6 py-2 rounded-full bg-amber-500 text-white text-sm">
                            返回
                        </button>
                    </div>
                )}
            </div>
        );
    }

    // 答题界面
    if (phase === 'quiz') {
        const allAnswered = userAnswers.length > 0 && userAnswers.every(a => a >= 0);
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 via-white to-orange-50 flex flex-col animate-fade-in">
                <div className="h-16 flex items-center justify-between px-4 border-b border-amber-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={onClose} className="p-2 -ml-2 rounded-full hover:bg-amber-50">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <span className="text-sm font-bold text-amber-800">白色情人节小测验</span>
                    <div className="w-10" />
                </div>

                <div className="flex-1 overflow-y-auto p-4 pb-24">
                    {/* 角色开场白 */}
                    {quizData?.intro && (
                        <div className="mb-5 flex items-start gap-3 bg-amber-50 rounded-2xl p-4 border border-amber-100">
                            {char && (
                                <TokenImg value={char.avatar} className="w-10 h-10 rounded-full shrink-0 object-cover border-2 border-amber-200" alt="" />
                            )}
                            <p className="text-sm text-amber-900 leading-relaxed">{quizData.intro}</p>
                        </div>
                    )}

                    <p className="text-xs text-amber-400 text-center mb-5">
                        答对 {QUIZ_PASS_SCORE}/{QUIZ_TOTAL} 题解锁巧克力 DIY · 不够可以重试
                    </p>

                    {quizData?.questions.map((q, qi) => (
                        <div key={qi} className="mb-6">
                            <p className="text-sm font-bold text-slate-700 mb-3">
                                <span className="text-amber-500">Q{qi + 1}. </span>{q.question}
                            </p>
                            <div className="flex flex-col gap-2">
                                {q.options.map((opt, oi) => (
                                    <button
                                        key={oi}
                                        onClick={() => {
                                            const next = [...userAnswers];
                                            next[qi] = oi;
                                            setUserAnswers(next);
                                        }}
                                        className={`w-full text-left px-4 py-3 rounded-xl text-sm border-2 transition-all ${
                                            userAnswers[qi] === oi
                                                ? 'border-amber-500 bg-amber-50 text-amber-800 font-bold'
                                                : 'border-slate-100 bg-white text-slate-600'
                                        }`}
                                    >
                                        <span className="text-amber-400 font-bold mr-2">{['A', 'B', 'C', 'D'][oi]}.</span>
                                        {opt}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="absolute bottom-0 left-0 right-0 px-4 pb-8 pt-3 bg-white/90 backdrop-blur-sm border-t border-amber-50">
                    <button
                        onClick={generateReview}
                        disabled={!allAnswered}
                        className={`w-full py-3.5 rounded-2xl text-white font-bold text-sm transition-all ${
                            allAnswered ? 'bg-amber-500 shadow-md active:scale-95' : 'bg-amber-200 cursor-not-allowed'
                        }`}
                    >
                        {allAnswered
                            ? '提交答案，等 TA 评分 →'
                            : `还有 ${userAnswers.filter(a => a < 0).length} 题未答`}
                    </button>
                </div>
            </div>
        );
    }

    // 评阅界面
    if (phase === 'reviewing') {
        if (!reviewData || allReviewLines.length === 0) return null;
        const line = allReviewLines[reviewLineIndex];
        const progress = Math.min(reviewLineIndex, reviewData.reviews.length);
        const isResultLine = line?.isFinal;
        const questionText = !isResultLine && quizData && line
            ? quizData.questions[line.questionIndex]?.question
            : undefined;
        return (
            <SpriteDialogBox
                char={char!}
                sprite={currentSprite}
                text={displayedText}
                isAnimating={isAnimating}
                subInfo={!isResultLine ? `第 ${reviewLineIndex + 1} / ${reviewData.reviews.length} 题` : undefined}
                onClick={handleReviewClick}
                hintText="点击继续"
                progressBar={{ value: progress, total: reviewData.reviews.length }}
                questionText={questionText}
                spriteScale={localSpriteScale}
                spriteX={localSpriteX}
                spriteY={localSpriteY}
                onSpriteConfigChange={(s, x, y) => { setLocalSpriteScale(s); setLocalSpriteX(x); setLocalSpriteY(y); }}
                onSaveSpriteConfig={handleSaveSpriteConfig}
                indicator={
                    !isResultLine && line
                        ? <span className={`text-2xl font-bold ${line.isCorrect ? 'text-green-300' : 'text-red-300'}`}>
                            {line.isCorrect ? '✓' : '✗'}
                          </span>
                        : undefined
                }
            />
        );
    }

    // 重试界面
    if (phase === 'retry') {
        const score = reviewData?.finalScore ?? 0;
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 to-white flex flex-col items-center justify-center p-6 animate-fade-in">
                <div className="text-5xl mb-4">😮‍💨</div>
                <h2 className="text-xl font-bold text-amber-800 mb-2">答对了 {score} 题</h2>
                <p className="text-sm text-amber-600 text-center mb-8">
                    还差一点！再好好想想，答对 {QUIZ_PASS_SCORE} 题就能装饰巧克力了～
                </p>
                <div className="flex flex-col gap-3 w-full max-w-xs">
                    <button
                        onClick={() => {
                            setUserAnswers(new Array(quizData!.questions.length).fill(-1));
                            setReviewData(null);
                            setReviewLineIndex(0);
                            setPhase('quiz');
                        }}
                        className="w-full py-3.5 rounded-2xl bg-amber-500 text-white font-bold text-sm shadow-md active:scale-95 transition-transform"
                    >
                        再试一次
                    </button>
                    <button onClick={onClose} className="w-full py-2.5 rounded-2xl text-amber-400 text-sm">
                        下次再说
                    </button>
                </div>
            </div>
        );
    }

    // 装饰界面
    if (phase === 'decorate') {
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-rose-50 via-white to-pink-50 flex flex-col animate-fade-in">
                {/* Header */}
                <div className="h-14 flex items-center justify-between px-4 border-b border-rose-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={onClose} className="p-2 -ml-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-500">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <div className="text-center">
                        <p className="text-xs font-bold text-rose-700">DIY 巧克力</p>
                        <p className="text-[10px] text-rose-400/70">
                            {customImage ? '拖动调整位置，滑动调整大小/旋转' : '上传一张你喜欢的照片'}
                        </p>
                    </div>
                    <button
                        onClick={() => setPhase('export')}
                        className="text-xs font-bold text-rose-600 bg-rose-100 px-3 py-1.5 rounded-full border border-rose-200"
                    >
                        完成 →
                    </button>
                </div>

                {/* 画布区域 */}
                <div className="flex-1 overflow-hidden flex items-center justify-center p-4">
                    <div
                        ref={canvasRef}
                        className="relative overflow-hidden bg-white"
                        style={{
                            width: '100%',
                            maxWidth: '340px',
                            aspectRatio: '1 / 1',
                        }}
                    >
                        {/* 底层：完整巧克力心形 */}
                        <img
                            src={WHITEDAY_ASSETS.chocolateBottom}
                            crossOrigin="anonymous"
                            className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
                            alt=""
                        />

                        {/* 中间层：mask 容器将照片剪裁到心形轮廓内 */}
                        <div
                            className="absolute inset-0"
                            style={{
                                WebkitMaskImage: `url(${WHITEDAY_ASSETS.chocolateBottom})`,
                                maskImage: `url(${WHITEDAY_ASSETS.chocolateBottom})`,
                                WebkitMaskSize: 'contain',
                                maskSize: 'contain',
                                WebkitMaskRepeat: 'no-repeat',
                                maskRepeat: 'no-repeat',
                                WebkitMaskPosition: 'center',
                                maskPosition: 'center',
                                zIndex: 5,
                                pointerEvents: 'none',
                            }}
                        >
                                {customImage && (
                                    <div
                                        className="absolute cursor-grab active:cursor-grabbing"
                                        style={{
                                            left: `${customImage.x}%`,
                                            top: `${customImage.y}%`,
                                            width: '80%',
                                            height: '80%',
                                            transform: 'translate(-50%, -50%)',
                                            touchAction: 'none',
                                            pointerEvents: 'all',
                                            willChange: 'transform, left, top',
                                        }}
                                        onPointerDown={handleImagePointerDown}
                                        onPointerMove={handleImagePointerMove}
                                        onPointerUp={handleImagePointerUp}
                                        onPointerCancel={handleImagePointerUp}
                                    >
                                        <div
                                            className="w-full h-full flex items-center justify-center"
                                            style={{ transform: `scale(${customImage.scale}) rotate(${customImage.rotation}deg)` }}
                                        >
                                            <img
                                                src={customImage.src}
                                                crossOrigin="anonymous"
                                                className="max-w-full max-h-full w-auto h-auto select-none"
                                                draggable={false}
                                                alt="自定义图片"
                                            />
                                        </div>
                                    </div>
                                )}
                        </div>

                        {/* 顶层：外框覆盖层（中心透明），遮住照片超出心形的部分 */}
                        <img
                            src={WHITEDAY_ASSETS.chocolateTop}
                            crossOrigin="anonymous"
                            className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
                            style={{ zIndex: 10 }}
                            alt=""
                        />

                        {/* 无图片时的提示（在顶层之下，心形透明区可见） */}
                        {!customImage && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 6, paddingBottom: '20%' }}>
                                <p className="text-rose-300/60 text-xs text-center">上传照片后<br/>会出现在这里</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* 控制面板 */}
                <div className="px-4 pb-6 shrink-0 flex flex-col gap-3">
                    {/* 调整控制（有图片时显示） */}
                    {customImage && (
                        <div className="bg-white rounded-2xl p-3 border border-rose-100 shadow-sm">
                            <div className="flex items-center gap-3 mb-2">
                                <span className="text-[11px] text-slate-500 w-8 shrink-0">大小</span>
                                <input
                                    type="range" min="0.3" max="2.5" step="0.05"
                                    value={customImage.scale}
                                    onChange={e => setCustomImage(prev => prev ? { ...prev, scale: parseFloat(e.target.value) } : prev)}
                                    className="flex-1 accent-pink-400"
                                />
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-[11px] text-slate-500 w-8 shrink-0">旋转</span>
                                <input
                                    type="range" min="-180" max="180" step="3"
                                    value={customImage.rotation}
                                    onChange={e => setCustomImage(prev => prev ? { ...prev, rotation: parseInt(e.target.value) } : prev)}
                                    className="flex-1 accent-pink-400"
                                />
                            </div>
                            <button
                                onClick={() => setCustomImage(null)}
                                className="mt-2 text-xs text-red-400/80 underline"
                            >
                                移除图片
                            </button>
                        </div>
                    )}

                    {/* 上传 / URL 输入 */}
                    <div className="flex gap-2">
                        <label className="flex-1 py-3 text-center text-xs rounded-2xl border border-rose-200 text-rose-600 bg-white cursor-pointer active:bg-rose-50">
                            {customImage ? '更换照片' : '上传照片'}
                            <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={e => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); }}
                            />
                        </label>
                        <button
                            onClick={() => setShowUrlInput(v => !v)}
                            className="flex-1 py-3 text-center text-xs rounded-2xl border border-rose-200 text-rose-600 bg-white active:bg-rose-50"
                        >
                            图床 URL
                        </button>
                    </div>

                    {showUrlInput && (
                        <div className="flex gap-2">
                            <input
                                type="url"
                                value={urlInput}
                                onChange={e => setUrlInput(e.target.value)}
                                placeholder="https://..."
                                className="flex-1 text-xs bg-white border border-rose-200 rounded-xl px-3 py-2 text-slate-700 placeholder-rose-200 outline-none focus:border-rose-400"
                            />
                            <button
                                onClick={() => { if (urlInput.trim()) { addCustomImage(urlInput.trim()); setUrlInput(''); setShowUrlInput(false); } }}
                                className="px-4 text-xs bg-rose-500 text-white rounded-xl"
                            >
                                添加
                            </button>
                        </div>
                    )}

                    {/* 听听角色评价 */}
                    <button
                        onClick={generateComment}
                        className="w-full py-2.5 rounded-2xl border border-rose-200 text-rose-500 text-xs bg-white active:bg-rose-50"
                    >
                        听听 {char?.name} 怎么评价这块巧克力 👀
                    </button>
                </div>
            </div>
        );
    }

    // 角色评价巧克力
    if (phase === 'commenting') {
        if (commentLines.length === 0) {
            return (
                <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-pink-200 to-pink-100 flex items-center justify-center">
                    <div className="w-10 h-10 rounded-full border-4 border-rose-300 border-t-white animate-spin" />
                </div>
            );
        }
        const commentLine = commentLines[commentLineIndex];
        return (
            <SpriteDialogBox
                char={char!}
                sprite={currentSprite}
                text={commentDisplayedText}
                isAnimating={isCommentAnimating}
                spriteScale={localSpriteScale}
                spriteX={localSpriteX}
                spriteY={localSpriteY}
                onSpriteConfigChange={(s, x, y) => { setLocalSpriteScale(s); setLocalSpriteX(x); setLocalSpriteY(y); }}
                onSaveSpriteConfig={handleSaveSpriteConfig}
                onClick={() => {
                    if (isCommentAnimating) {
                        if (animTimerRef.current) clearTimeout(animTimerRef.current);
                        setCommentDisplayedText(commentLine?.text || '');
                        setIsCommentAnimating(false);
                        return;
                    }
                    if (commentLineIndex + 1 < commentLines.length) {
                        setCommentLineIndex(prev => prev + 1);
                    } else {
                        setPhase('export');
                    }
                }}
                hintText="点击继续"
            />
        );
    }

    // 导出界面
    if (phase === 'export') {
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 via-white to-orange-50 flex flex-col animate-fade-in">
                <div className="h-14 flex items-center justify-between px-4 border-b border-amber-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={() => setPhase('decorate')} className="p-2 -ml-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-500">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <span className="text-sm font-bold text-amber-800">导出明信片</span>
                    <div className="w-10" />
                </div>

                <div className="flex-1 overflow-y-auto flex flex-col items-center p-5 gap-5">
                    {/* 明信片预览（CSS 渲染，仅供预览；导出使用 Canvas API） */}
                    <div
                        className="w-full max-w-[340px] rounded-2xl overflow-hidden shadow-xl border-2 border-amber-200"
                        style={{ background: 'linear-gradient(135deg, #fdf6ec 0%, #fef3e2 100%)' }}
                    >
                        <div
                            className="relative mx-4 mt-4 overflow-hidden bg-white"
                            style={{ aspectRatio: '1 / 1' }}
                        >
                            <img src={WHITEDAY_ASSETS.chocolateBottom} crossOrigin="anonymous" className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none" alt="" />
                            <div
                                className="absolute inset-0"
                                style={{
                                    WebkitMaskImage: `url(${WHITEDAY_ASSETS.chocolateBottom})`,
                                    maskImage: `url(${WHITEDAY_ASSETS.chocolateBottom})`,
                                    WebkitMaskSize: 'contain',
                                    maskSize: 'contain',
                                    WebkitMaskRepeat: 'no-repeat',
                                    maskRepeat: 'no-repeat',
                                    WebkitMaskPosition: 'center',
                                    maskPosition: 'center',
                                    zIndex: 5,
                                }}
                            >
                                {customImage && (
                                    <div className="absolute" style={{ left: `${customImage.x}%`, top: `${customImage.y}%`, width: '80%', height: '80%', transform: 'translate(-50%, -50%)' }}>
                                        <div className="w-full h-full flex items-center justify-center" style={{ transform: `scale(${customImage.scale}) rotate(${customImage.rotation}deg)` }}>
                                            <img src={customImage.src} crossOrigin="anonymous" className="max-w-full max-h-full w-auto h-auto select-none" draggable={false} alt="" />
                                        </div>
                                    </div>
                                )}
                            </div>
                            <img src={WHITEDAY_ASSETS.chocolateTop} crossOrigin="anonymous" className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none" style={{ zIndex: 10 }} alt="" />
                        </div>
                        <div className="px-4 py-3 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                {char && <TokenImg value={char.avatar} className="w-8 h-8 rounded-full object-cover border-2 border-amber-200" alt="" />}
                                <div>
                                    <p className="text-xs font-bold text-amber-800">{char?.name}</p>
                                    <p className="text-[10px] text-amber-400">2026.3.14 白色情人节</p>
                                </div>
                            </div>
                            <p className="text-[9px] text-amber-300/60 italic">White Day</p>
                        </div>
                    </div>

                    {/* 导出后的 PNG 预览 */}
                    {exportedBase64 && (
                        <div className="w-full max-w-[340px]">
                            <p className="text-[10px] text-amber-500 text-center mb-2">导出预览</p>
                            <img src={exportedBase64} className="w-full rounded-2xl shadow-md border border-amber-200" alt="导出预览" />
                        </div>
                    )}

                    {/* 操作 */}
                    <div className="w-full max-w-[340px] flex flex-col gap-3">
                        <button
                            onClick={handleExport}
                            disabled={isExporting}
                            className="w-full py-3.5 rounded-2xl bg-amber-500 text-white font-bold text-sm shadow-md disabled:opacity-60 active:scale-95 transition-transform"
                        >
                            {isExporting ? '生成中…' : exportedBase64 ? '重新下载' : '下载明信片'}
                        </button>
                        <button
                            onClick={handleSendToRoom}
                            disabled={!exportedBase64 || isSendingToRoom}
                            className="w-full py-3.5 rounded-2xl border-2 border-amber-300 text-amber-600 font-bold text-sm disabled:opacity-40 active:scale-95 transition-transform"
                        >
                            {isSendingToRoom
                                ? '正在装修中…'
                                : exportedBase64
                                    ? `发送到 ${char?.name || ''} 的小屋`
                                    : '请先下载以生成文件'}
                        </button>
                        <button
                            onClick={() => {
                                setUserAnswers([]);
                                setQuizData(null);
                                setReviewData(null);
                                setReviewLineIndex(0);
                                setCustomImage(null);
                                setCommentLines([]);
                                setExportedBase64('');
                                setErrorMsg('');
                                // 清除角色已有记录（重新开始）
                                if (char) {
                                    const prev = char.specialMomentRecords || {};
                                    const updated = { ...prev };
                                    delete updated[WHITEDAY_RECORD_KEY];
                                    updateCharacter(char.id, { specialMomentRecords: updated });
                                }
                                try { localStorage.removeItem(WHITEDAY_COMPLETED_KEY); } catch { /* */ }
                                setPhase('loading_quiz');
                            }}
                            className="w-full py-2.5 rounded-2xl text-amber-500 text-xs border border-amber-200 bg-white active:bg-amber-50"
                        >
                            重新答题（换一套题目）
                        </button>
                        <button
                            onClick={onClose}
                            className="text-xs text-amber-400 text-center py-2"
                        >
                            我会永远在意你
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // 查看已完成结果（重新进入特别推送时）
    if (phase === 'view_result') {
        const record = char?.specialMomentRecords?.[WHITEDAY_RECORD_KEY];
        let savedData: any = {};
        try { savedData = record?.content ? JSON.parse(record.content) : {}; } catch { /* */ }
        const savedQuizData: WhiteDayQuizData | null = savedData.quizData || null;
        const savedReviewData: WhiteDayReviewData | null = savedData.reviewData || null;
        const savedAnswers: number[] = savedData.userAnswers || [];
        const savedScore: number = savedData.score ?? savedReviewData?.finalScore ?? 0;
        const savedImage: string = record?.image || '';
        const labels = ['A', 'B', 'C', 'D'];

        const handleReExport = async () => {
            if (!savedImage || isExporting) return;
            setIsExporting(true);
            try {
                // a.download / fetch / Filesystem 都只认真的 data URL，令牌得先还原回来
                const dataUrl = await resolveRefToDataUrl(savedImage);
                if (!dataUrl) { addToast('明信片图片已丢失', 'error'); return; }
                const fileName = `whiteday_${char?.name || 'chocolate'}_2026.png`;
                await downloadOrShare(dataUrl, fileName, '白色情人节巧克力');
                addToast('导出成功！', 'success');
            } catch (e: any) {
                if (e?.name !== 'AbortError') addToast('导出失败', 'error');
            } finally { setIsExporting(false); }
        };

        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 via-white to-orange-50 flex flex-col animate-fade-in">
                <div className="h-14 flex items-center justify-between px-4 border-b border-amber-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={onClose} className="p-2 -ml-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-500">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <span className="text-sm font-bold text-amber-800">白色情人节 2026</span>
                    <div className="w-10" />
                </div>

                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 pb-6">
                    {/* 明信片 */}
                    {savedImage ? (
                        <div className="flex flex-col items-center gap-2">
                            <TokenImg value={savedImage} className="w-full max-w-[320px] rounded-2xl shadow-md border border-amber-200" alt="白色情人节明信片" />
                            <button
                                onClick={handleReExport}
                                disabled={isExporting}
                                className="w-full max-w-[320px] py-3 rounded-2xl bg-amber-500 text-white font-bold text-sm shadow-md disabled:opacity-60 active:scale-95 transition-transform"
                            >
                                {isExporting ? '生成中…' : '下载明信片'}
                            </button>
                        </div>
                    ) : (
                        <div className="w-full max-w-[320px] mx-auto rounded-2xl border border-amber-200 bg-amber-50 py-8 flex items-center justify-center text-amber-400 text-sm">
                            明信片尚未导出
                        </div>
                    )}

                    {/* 测验题目和答案回顾 */}
                    {savedQuizData && savedReviewData && (
                        <div className="w-full max-w-[320px] mx-auto flex flex-col gap-3">
                            <p className="text-xs font-bold text-amber-700 mb-1">答题回顾 · {savedScore}/{savedQuizData.questions.length} 题</p>
                            {savedQuizData.questions.map((q, i) => {
                                const review = savedReviewData.reviews[i];
                                const userIdx = savedAnswers[i] ?? -1;
                                const isCorrect = review?.isCorrect ?? (userIdx === q.correctIndex);
                                return (
                                    <div key={i} className="bg-white rounded-2xl border border-amber-100 shadow-sm p-4 flex flex-col gap-2">
                                        <div className="flex items-start gap-2">
                                            <span className={`text-sm font-bold shrink-0 mt-0.5 ${isCorrect ? 'text-emerald-500' : 'text-red-400'}`}>{isCorrect ? '✓' : '✗'}</span>
                                            <p className="text-[13px] font-medium text-amber-900 leading-snug">{q.question}</p>
                                        </div>
                                        <div className="flex flex-col gap-1 pl-5">
                                            {q.options.map((opt, oi) => {
                                                const isUser = oi === userIdx;
                                                const isCorrectOpt = oi === q.correctIndex;
                                                return (
                                                    <div key={oi} className={`text-[11px] px-2 py-0.5 rounded-lg ${isUser && isCorrectOpt ? 'bg-emerald-100 text-emerald-700 font-bold' : isUser && !isCorrectOpt ? 'bg-red-50 text-red-600' : isCorrectOpt ? 'bg-emerald-50 text-emerald-600' : 'text-slate-400'}`}>
                                                        {labels[oi]}. {opt}
                                                        {isUser && <span className="ml-1 opacity-70">(你选的)</span>}
                                                        {isCorrectOpt && !isUser && <span className="ml-1 text-emerald-500">✓</span>}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        {review?.dialogue && (
                                            <p className="text-[11px] italic text-amber-700 pl-5 border-t border-amber-50 pt-2">
                                                「{review.dialogue}」
                                            </p>
                                        )}
                                    </div>
                                );
                            })}
                            {savedReviewData.finalDialogue && (
                                <div className="bg-amber-50 rounded-2xl border border-amber-200 p-4">
                                    <p className="text-[11px] text-amber-500 font-bold mb-1">{char?.name} 的最终评价</p>
                                    <p className="text-sm text-amber-800 leading-relaxed">{savedReviewData.finalDialogue}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* 重新装饰 / 重新开始 */}
                    <div className="w-full max-w-[320px] mx-auto mt-2 flex flex-col gap-2">
                        <button
                            onClick={() => {
                                // 把已存的 quiz/review 数据加载回 state，直接跳到装饰阶段
                                if (savedQuizData) setQuizData(savedQuizData);
                                if (savedReviewData) setReviewData(savedReviewData);
                                setUserAnswers(savedAnswers);
                                setCustomImage(null);
                                setCommentLines([]);
                                setExportedBase64('');
                                setErrorMsg('');
                                // 清除旧明信片记录，但保留 quiz 内容，等重新导出时再写回
                                if (char) {
                                    const prev = char.specialMomentRecords || {};
                                    updateCharacter(char.id, {
                                        specialMomentRecords: {
                                            ...prev,
                                            [WHITEDAY_RECORD_KEY]: {
                                                ...prev[WHITEDAY_RECORD_KEY],
                                                image: '',
                                            },
                                        },
                                    });
                                }
                                setPhase('decorate');
                            }}
                            className="w-full py-3 rounded-2xl bg-rose-500 text-white font-bold text-sm shadow-md active:scale-95 transition-transform"
                        >
                            重新装饰图片
                        </button>
                        <button
                            onClick={() => {
                                setUserAnswers([]);
                                setQuizData(null);
                                setReviewData(null);
                                setReviewLineIndex(0);
                                setCustomImage(null);
                                setCommentLines([]);
                                setExportedBase64('');
                                setErrorMsg('');
                                if (char) {
                                    const prev = char.specialMomentRecords || {};
                                    const updated = { ...prev };
                                    delete updated[WHITEDAY_RECORD_KEY];
                                    updateCharacter(char.id, { specialMomentRecords: updated });
                                }
                                try { localStorage.removeItem(WHITEDAY_COMPLETED_KEY); } catch { /* */ }
                                setPhase('loading_quiz');
                            }}
                            className="w-full py-2.5 rounded-2xl text-amber-500 text-xs border border-amber-200 bg-white active:bg-amber-50"
                        >
                            重新答题（换一套题目）
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return null;
};

// ============================================================
// Controller（状态机）
// ============================================================
interface WhiteDayControllerProps {
    onClose: () => void;
}

export const WhiteDayController: React.FC<WhiteDayControllerProps> = ({ onClose }) => {
    const { characters } = useOS();
    const [stage, setStage] = useState<'popup' | 'api' | 'session'>('popup');

    // 找到 Sully 角色（弹窗直接进 Sully）
    const sullyChar = characters.find(c => isSullyChar(c));
    const sullyId = sullyChar?.id || characters[0]?.id || '';

    const handleDismiss = () => {
        try { localStorage.setItem(WHITEDAY_DISMISSED_KEY, Date.now().toString()); } catch { /* */ }
        onClose();
    };

    if (stage === 'popup') {
        return (
            <WhiteDayPopup
                onView={() => setStage('session')}
                onDismiss={handleDismiss}
                onCheckApi={() => setStage('api')}
                sullyName={sullyChar?.name}
            />
        );
    }

    if (stage === 'api') {
        return (
            <WhiteDayApiSetup
                onDone={() => setStage('session')}
                onBack={() => setStage('popup')}
            />
        );
    }

    // 从弹窗进入时，直接给 Sully 的 charId，跳过角色选择
    return <WhiteDaySession charId={sullyId} onClose={onClose} />;
};

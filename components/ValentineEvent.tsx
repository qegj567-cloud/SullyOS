
/**
 * ValentineEvent.tsx
 * 情人节特别推送模块 (2026.2.14)
 *
 * 独立模块，不修改任何已有结构。
 * - 弹窗提示 → 查看 / 没兴趣 / 先检查API
 * - 特殊页面：向AI发送情人节提示词，DateApp风格立绘展示
 * - 对话存入 chat/date 通用上下文
 * - 降级入口：桌面第三页 "特别时光" app
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { ContextBuilder } from '../utils/context';
import { safeResponseJson } from '../utils/safeApi';
import { CharacterProfile, SpecialMomentRecord } from '../types';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { WhiteDaySession, isWhiteDayEventAvailable, WHITEDAY_RECORD_KEY } from './WhiteDayEvent';
import { Like520Session, isLike520EventAvailable, isLike520Past, LIKE520_RECORD_KEY } from './Like520Event';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';

// ============================================================
// 情人节立绘 Sprite 映射 (占位 emoji，等图片整理好后替换为图床URL)
// ============================================================
const VALENTINE_SPRITES: Record<string, string> = {
    happy:   'https://sharkpan.xyz/f/m3adhW/Vha.png',
    sad:     'https://sharkpan.xyz/f/BZgDfa/Vsad.png',
    normal:  'https://sharkpan.xyz/f/4rzdtj/VNormal.png',
    angry:   'https://sharkpan.xyz/f/NdlVfv/VAn.png',
    shy:     'https://sharkpan.xyz/f/VyontY/Vshy.png',
    love:    'https://sharkpan.xyz/f/xl8muX/VBl.png',
};

// localStorage keys
const VALENTINE_DISMISSED_KEY = 'sullyos_valentine_2026_dismissed';
const VALENTINE_COMPLETED_KEY = 'sullyos_valentine_2026_completed';
const VALENTINE_RECORD_KEY = 'valentine_2026';

// ============================================================
// 工具函数
// ============================================================

/** 判断今天是否是情人节 (2026-02-14) */
const isValentineDay = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 1 && now.getDate() === 14;
};

/** 判断是否应该显示弹窗 */
export const shouldShowValentinePopup = (): boolean => {
    if (!isValentineDay()) return false;
    try {
        if (localStorage.getItem(VALENTINE_DISMISSED_KEY)) return false;
        if (localStorage.getItem(VALENTINE_COMPLETED_KEY)) return false;
    } catch { /* ignore */ }
    return true;
};

/** 判断情人节活动是否当前可用（2026年2月） */
export const isValentineEventAvailable = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 1;
};

/** 判断情人节活动是否已过期（2026年2月之后，永久可回看） */
export const isValentinePast = (): boolean => {
    const now = new Date();
    return now.getFullYear() > 2026 || (now.getFullYear() === 2026 && now.getMonth() > 1);
};

// ============================================================
// 解析对话中的情绪标签
// ============================================================
interface ValentineDialogueLine {
    text: string;
    emotion: string;
}

const parseValentineDialogue = (raw: string): ValentineDialogueLine[] => {
    if (!raw) return [];
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const results: ValentineDialogueLine[] = [];
    let currentEmotion = 'normal';

    for (const line of lines) {
        // Skip system noise
        if (line.startsWith('(') && line.endsWith(')')) continue;
        if (line.startsWith('[system') || line.startsWith('(system')) continue;

        const tagMatch = line.match(/^\[([a-zA-Z0-9_\-]+)\]\s*(.*)/);
        let content = line;

        if (tagMatch) {
            currentEmotion = tagMatch[1].toLowerCase();
            content = tagMatch[2];
        } else {
            const standaloneTag = line.match(/^\[([a-zA-Z0-9_\-]+)\]$/);
            if (standaloneTag) {
                currentEmotion = standaloneTag[1].toLowerCase();
                continue;
            }
        }
        if (content) {
            results.push({ text: content, emotion: currentEmotion });
        }
    }
    return results;
};

/** 判断是否为 Sully 角色 */
const isSullyChar = (char?: CharacterProfile): boolean => {
    if (!char) return false;
    return char.name.toLowerCase().includes('sully');
};

/** 获取角色实际可用的表情列表（用于 prompt） */
const getAvailableEmotions = (char: CharacterProfile): string[] => {
    if (isSullyChar(char)) {
        // Sully 使用情人节专属表情
        return Object.keys(VALENTINE_SPRITES);
    }
    // 其他角色：从 sprites 配置 + customDateSprites 获取实际可用表情
    const REQUIRED = ['normal', 'happy', 'angry', 'sad', 'shy'];
    const custom = char.customDateSprites || [];
    const available = [...REQUIRED, ...custom];
    // 只保留角色真正有立绘的
    if (char.sprites) {
        return available.filter(e => char.sprites![e]);
    }
    return available;
};

/** 获取情绪对应的立绘 */
const getSpriteForEmotion = (emotion: string, char?: CharacterProfile): { type: 'image' | 'emoji', value: string } => {
    if (!char) {
        return { type: 'emoji', value: VALENTINE_SPRITES['normal'] };
    }

    const isSully = isSullyChar(char);

    if (isSully) {
        // Sully: 优先情人节专属立绘占位，未来会替换为图床URL
        const valentineMap: Record<string, string> = {
            happy: 'happy', sad: 'sad', normal: 'normal',
            angry: 'angry', shy: 'shy', love: 'love',
            upset: 'angry', excited: 'happy', bliss: 'love',
            embarrassed: 'shy', joyful: 'happy', tender: 'love',
        };
        const mapped = valentineMap[emotion] || 'normal';
        const spriteUrl = VALENTINE_SPRITES[mapped];
        // 当占位emoji被替换为URL后，这里会自动识别为 image 类型
        if (spriteUrl && (spriteUrl.startsWith('http') || spriteUrl.startsWith('data:'))) {
            return { type: 'image', value: spriteUrl };
        }
        return { type: 'emoji', value: spriteUrl || VALENTINE_SPRITES['normal'] };
    }

    // 非 Sully 角色：使用角色自己的见面立绘（和 DateApp 一致）
    if (char.sprites) {
        const sprite = char.sprites[emotion] || char.sprites['normal'];
        if (sprite) {
            return { type: 'image', value: sprite };
        }
    }
    // 最终降级到头像
    return { type: 'image', value: char.avatar };
};

// ============================================================
// 情人节弹窗组件
// ============================================================
interface ValentinePopupProps {
    onView: () => void;
    onDismiss: () => void;
    onCheckApi: () => void;
}

export const ValentinePopup: React.FC<ValentinePopupProps> = ({ onView, onDismiss, onCheckApi }) => {
    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-pink-200/50 overflow-hidden animate-slide-up">
                {/* 装饰性心形背景 */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-pink-100/60 to-transparent rounded-bl-full pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-red-50/40 to-transparent rounded-tr-full pointer-events-none" />

                {/* Header */}
                <div className="pt-8 pb-4 px-6 text-center relative">
                    <div className="text-4xl mb-3 animate-bounce">💌</div>
                    <h2 className="text-lg font-extrabold text-slate-800">Sully好像有话对你说？</h2>
                    <p className="text-[11px] text-pink-400 mt-1.5 font-medium">2026 Valentine's Day Special</p>
                    <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">想听其他角色的心声？可以在桌面「特别时光」中找到</p>
                </div>

                {/* Buttons */}
                <div className="px-6 pb-8 pt-2 space-y-3 relative">
                    <button
                        onClick={onView}
                        className="w-full py-3.5 bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-pink-200 active:scale-95 transition-transform text-sm flex items-center justify-center gap-2"
                    >
                        <span>查看</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clipRule="evenodd" /></svg>
                    </button>

                    <button
                        onClick={onCheckApi}
                        className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform text-sm"
                    >
                        我先检查API！
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
// API 配置内联组件 (复刻 Settings 中的 API 配置部分)
// ============================================================
const InlineApiSetup: React.FC<{ onDone: () => void; onBack: () => void }> = ({ onDone, onBack }) => {
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
                    <p className="text-[11px] text-slate-400 mt-1">配置完成后即可查看情人节特别推送</p>
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
                    <button onClick={onDone} className="flex-1 py-3 bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-pink-200 active:scale-95 transition-transform text-sm">
                        前往查看 💌
                    </button>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 情人节特别页面 - 核心体验
// ============================================================
interface ValentineSessionProps {
    charId?: string; // 如果从"特别时光"app进入，可以指定角色
    onClose: () => void;
}

export const ValentineSession: React.FC<ValentineSessionProps> = ({ charId, onClose }) => {
    const { characters, activeCharacterId, apiConfig, userProfile, addToast, virtualTime, updateCharacter } = useOS();

    // 角色选择
    const [selectedCharId, setSelectedCharId] = useState<string>(charId || activeCharacterId || '');
    const [phase, setPhase] = useState<'select' | 'loading' | 'session' | 'error'>(charId ? 'loading' : 'select');

    // 对话状态
    const [dialogueLines, setDialogueLines] = useState<ValentineDialogueLine[]>([]);
    const [currentLineIndex, setCurrentLineIndex] = useState(0);
    const [displayedText, setDisplayedText] = useState('');
    const [isAnimating, setIsAnimating] = useState(false);
    const [currentEmotion, setCurrentEmotion] = useState('normal');
    const [fullContent, setFullContent] = useState('');
    const [errorMsg, setErrorMsg] = useState('');

    const scrollRef = useRef<HTMLDivElement>(null);
    const recordRef = useRef<HTMLDivElement>(null);

    const char = characters.find(c => c.id === selectedCharId);

    // 立绘调整
    const [showSpriteSettings, setShowSpriteSettings] = useState(false);
    const [localSpriteScale, setLocalSpriteScale] = useState(char?.spriteConfig?.scale ?? 1);
    const [localSpriteX, setLocalSpriteX] = useState(char?.spriteConfig?.x ?? 0);
    const [localSpriteY, setLocalSpriteY] = useState(char?.spriteConfig?.y ?? 0);

    // 记录视图
    const [showRecord, setShowRecord] = useState(false);
    const [isExporting, setIsExporting] = useState(false);

    // 长按删除
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleLongPressStart = (cId: string) => {
        longPressTimer.current = setTimeout(() => {
            setDeleteTargetId(cId);
        }, 600);
    };
    const handleLongPressEnd = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };
    const handleDeleteRecord = async (cId: string) => {
        try {
            // 1. 删除角色上的 specialMomentRecords
            const targetChar = characters.find(c => c.id === cId);
            if (targetChar) {
                const updatedRecords = { ...(targetChar.specialMomentRecords || {}) };
                delete updatedRecords[VALENTINE_RECORD_KEY];
                updateCharacter(cId, { specialMomentRecords: updatedRecords });
            }
            // 2. 删除聊天记录中的情人节消息
            const msgs = await DB.getMessagesByCharId(cId);
            const valentineIds = msgs
                .filter(m => m.metadata?.valentineEvent)
                .map(m => m.id)
                .filter((id): id is number => id !== undefined);
            if (valentineIds.length > 0) {
                await DB.deleteMessages(valentineIds);
            }
            addToast(`已删除 ${targetChar?.name || ''} 的情人节记录`, 'success');
        } catch (e) {
            console.error('Delete valentine record failed:', e);
            addToast('删除失败', 'error');
        } finally {
            setDeleteTargetId(null);
        }
    };

    const hydrateSessionFromContent = (content: string) => {
        setFullContent(content);
        const lines = parseValentineDialogue(content);
        if (lines.length === 0) {
            setDialogueLines([{ text: content.replace(/\[.*?\]/g, '').trim(), emotion: 'normal' }]);
        } else {
            setDialogueLines(lines);
        }
        setCurrentLineIndex(0);
        setDisplayedText('');
        setPhase('session');
    };

    const loadExistingValentineRecord = async (cId: string): Promise<boolean> => {
        const targetChar = characters.find(c => c.id === cId);
        const persistentRecord = targetChar?.specialMomentRecords?.[VALENTINE_RECORD_KEY] as SpecialMomentRecord | undefined;

        if (persistentRecord?.content?.trim()) {
            hydrateSessionFromContent(persistentRecord.content);
            return true;
        }

        const msgs = await DB.getMessagesByCharId(cId);
        const lastValentineMsg = [...msgs]
            .reverse()
            .find(m => m.role === 'assistant' && m.type === 'text' && !!m.metadata?.valentineEvent && !!m.content?.trim());

        if (!lastValentineMsg) return false;

        const migratedRecord: SpecialMomentRecord = {
            content: lastValentineMsg.content,
            timestamp: lastValentineMsg.timestamp,
            source: 'migrated'
        };

        updateCharacter(cId, {
            specialMomentRecords: {
                ...(targetChar?.specialMomentRecords || {}),
                [VALENTINE_RECORD_KEY]: migratedRecord,
            }
        });

        hydrateSessionFromContent(lastValentineMsg.content);
        return true;
    };

    // 自动开始（如果已选角色）
    useEffect(() => {
        if (phase === 'loading' && selectedCharId) {
            loadExistingValentineRecord(selectedCharId)
                .then(found => {
                    if (!found) {
                        generateValentineMessage(selectedCharId);
                    }
                })
                .catch(() => {
                    generateValentineMessage(selectedCharId);
                });
        }
    }, [phase, selectedCharId]);

    // 打字机效果
    useEffect(() => {
        const currentLine = dialogueLines[currentLineIndex];
        if (!currentLine) return;

        setCurrentEmotion(currentLine.emotion);
        setIsAnimating(true);
        setDisplayedText('');
        let i = 0;
        const timer = setInterval(() => {
            setDisplayedText(currentLine.text.substring(0, i + 1));
            i++;
            if (i >= currentLine.text.length) {
                clearInterval(timer);
                setIsAnimating(false);
            }
        }, 30);
        return () => clearInterval(timer);
    }, [currentLineIndex, dialogueLines]);

    // 自动滚动
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [displayedText]);

    /** 生成情人节特别消息 */
    const generateValentineMessage = async (cId: string) => {
        const c = characters.find(ch => ch.id === cId);
        if (!c) { setErrorMsg('找不到角色'); setPhase('error'); return; }

        if (!apiConfig.baseUrl || !apiConfig.apiKey) {
            setErrorMsg('API 未配置');
            setPhase('error');
            return;
        }

        setPhase('loading');

        try {
            // 获取聊天历史摘要
            const msgs = await DB.getMessagesByCharId(cId);
            const limit = c.contextLimit || 500;
            const recentMsgs = msgs.slice(-Math.min(limit, 80)).map(m => {
                const content = m.type === 'image' ? '[图片]' : m.content;
                return `${m.role}: ${content}`;
            }).join('\n');

            await injectMemoryPalace(c, undefined, '情人节 我们在一起的回忆');
            const baseContext = ContextBuilder.buildCoreContext(c, userProfile, true);

            // 根据角色获取可用表情列表
            const availableEmotions = getAvailableEmotions(c);

            const valentinePrompt = `### 特别场景：情人节特别推送 (Valentine's Day Special)

当前日期: 2026年2月14日 情人节
当前时间: ${virtualTime.day} ${virtualTime.hours.toString().padStart(2, '0')}:${virtualTime.minutes.toString().padStart(2, '0')}

### 背景说明
今天是情人节。系统触发了一个特别推送功能，你现在有机会对${userProfile.name}说一段特别的话。
这是一个特殊的、温馨的时刻。

### 你的任务
请用你自己的方式，对${userProfile.name}说一段情人节特别的话。内容应包括：
1. **回顾**：回想你们认识以来的点点滴滴（参考聊天记录和记忆）
2. **感受**：表达你对这段关系的真实感受
3. **期待**：对未来的期待和心愿

### 重要提示
- 你和${userProfile.name}的关系不一定是恋人关系。请根据你们实际的互动历史和关系来表达。
- 可以是恋人的深情告白，也可以是好朋友的真挚感谢，或者是伙伴之间的温暖鼓励。
- 用你的性格和说话方式来表达，保持角色一致性。
- 内容可以稍微长一点，毕竟这是一年一次的特别时刻。
- 要真诚、有温度。

### 输出格式（视觉小说脚本模式）
使用情绪标签 + 对话内容的格式，一行一个节拍：
**仅限使用以下情绪标签**: ${availableEmotions.join(', ')}
格式示例:
[${availableEmotions.includes('shy') ? 'shy' : availableEmotions[0]}] "情人节快乐..."
[${availableEmotions.includes('happy') ? 'happy' : availableEmotions[0]}] 开心地笑了起来
[${availableEmotions.includes('bliss') ? 'bliss' : availableEmotions.includes('happy') ? 'happy' : availableEmotions[0]}] "能认识你真的太好了。"

禁止使用不在列表中的情绪标签。台词用双引号，动作直接写。`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: baseContext },
                        { role: 'user', content: `[最近记录 (Previous Context)]:\n${recentMsgs}\n\n---\n\n${valentinePrompt}` }
                    ],
                    temperature: 0.88
                })
            });

            if (!response.ok) throw new Error(`API 错误: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = data.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI 返回为空');

            hydrateSessionFromContent(content);

            // 保存到数据库（作为 date 来源，可被 chat 和 dateapp 读到上下文）
            await DB.saveMessage({
                charId: cId,
                role: 'user',
                type: 'text',
                content: '[系统] 情人节特别推送已触发。',
                metadata: { source: 'date', isOpening: true, valentineEvent: true }
            });
            await DB.saveMessage({
                charId: cId,
                role: 'assistant',
                type: 'text',
                content: content,
                metadata: { source: 'date', valentineEvent: true }
            });

            const previousRecords = c.specialMomentRecords || {};
            updateCharacter(cId, {
                specialMomentRecords: {
                    ...previousRecords,
                    [VALENTINE_RECORD_KEY]: {
                        content,
                        timestamp: Date.now(),
                        source: 'generated'
                    }
                }
            });

            // 标记已完成
            try { localStorage.setItem(VALENTINE_COMPLETED_KEY, Date.now().toString()); } catch { /* */ }

        } catch (e: any) {
            console.error('Valentine event error:', e);
            setErrorMsg(e.message || '生成失败');
            setPhase('error');
        }
    };

    /** 点击屏幕推进对话 */
    const handleScreenClick = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button, .control-zone')) return;

        if (isAnimating) {
            // 跳过动画
            const currentLine = dialogueLines[currentLineIndex];
            if (currentLine) {
                setDisplayedText(currentLine.text);
                setIsAnimating(false);
            }
            return;
        }

        // 下一行
        if (currentLineIndex < dialogueLines.length - 1) {
            setCurrentLineIndex(prev => prev + 1);
        }
    };

    /** 重新生成 */
    const handleRegenerate = () => {
        if (!selectedCharId) return;
        setShowRecord(false);
        setDialogueLines([]);
        setCurrentLineIndex(0);
        setDisplayedText('');
        generateValentineMessage(selectedCharId);
    };

    /** 保存立绘配置 */
    const handleSaveSpriteConfig = () => {
        setShowSpriteSettings(false);
        if (selectedCharId) {
            updateCharacter(selectedCharId, {
                spriteConfig: { scale: localSpriteScale, x: localSpriteX, y: localSpriteY }
            });
        }
    };

    /** 导出记录为长图 */
    const handleExportImage = async () => {
        if (!recordRef.current || isExporting) return;
        setIsExporting(true);
        try {
            const mod: any = await import('https://esm.sh/html2canvas@1.4.1');
            const html2canvas = mod.default;
            const canvas = await html2canvas(recordRef.current, {
                backgroundColor: '#faf6f1',
                scale: 2,
                useCORS: true,
                logging: false,
            });
            const fileName = `valentine_${char?.name || 'record'}_2026.png`;

            if (Capacitor.isNativePlatform()) {
                const dataUrl = canvas.toDataURL('image/png');
                await Filesystem.writeFile({
                    path: fileName,
                    data: dataUrl,
                    directory: Directory.Cache,
                });
                const uriResult = await Filesystem.getUri({
                    directory: Directory.Cache,
                    path: fileName,
                });
                await Share.share({
                    title: '特别时光 - 导出长图',
                    files: [uriResult.uri],
                });
            } else {
                const link = document.createElement('a');
                link.download = fileName;
                link.href = canvas.toDataURL('image/png');
                link.click();
            }
            addToast('导出成功', 'success');
        } catch (e: any) {
            console.error('Export failed:', e);
            addToast('导出失败，请截图保存', 'error');
        } finally {
            setIsExporting(false);
        }
    };

    // ----- 角色选择界面 -----
    if (phase === 'select') {
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-pink-50 via-white to-rose-50 flex flex-col animate-fade-in">
                <div className="h-16 flex items-center justify-between px-4 border-b border-pink-100 bg-white/80 backdrop-blur-sm shrink-0">
                    <button onClick={onClose} className="p-2 -ml-2 rounded-full hover:bg-pink-50">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-bold text-slate-700">特别时光 - 情人节</span>
                    <div className="w-8" />
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                    <div className="text-center mb-6">
                        <div className="text-4xl mb-2">💝</div>
                        <h2 className="text-lg font-bold text-slate-700">选择你想听谁说</h2>
                        <p className="text-xs text-slate-400 mt-1">选择一位角色，聆听他们的情人节特别心声</p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        {characters.map(c => {
                            const hasRecord = !!c.specialMomentRecords?.[VALENTINE_RECORD_KEY];
                            return (
                                <button
                                    key={c.id}
                                    onClick={() => { setSelectedCharId(c.id); setPhase('loading'); }}
                                    onTouchStart={() => handleLongPressStart(c.id)}
                                    onTouchEnd={handleLongPressEnd}
                                    onTouchCancel={handleLongPressEnd}
                                    onContextMenu={(e) => { e.preventDefault(); setDeleteTargetId(c.id); }}
                                    className="bg-white rounded-2xl p-4 shadow-sm border border-pink-100 active:scale-95 transition-transform flex flex-col items-center gap-3 hover:shadow-md hover:border-pink-200 relative"
                                >
                                    <img src={c.avatar} className="w-16 h-16 rounded-full object-cover shadow-sm border-2 border-pink-100" alt={c.name} />
                                    <span className="font-bold text-slate-700 text-sm">{c.name}</span>
                                    {hasRecord && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-pink-400" />}
                                </button>
                            );
                        })}
                    </div>

                    <p className="text-center text-[10px] text-slate-300 mt-4">长按角色可删除其情人节记录</p>
                </div>

                {/* 删除确认弹窗 */}
                {deleteTargetId && (
                    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-6 animate-fade-in">
                        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDeleteTargetId(null)} />
                        <div className="relative bg-white rounded-3xl p-6 max-w-xs w-full shadow-2xl">
                            <div className="text-center mb-4">
                                <div className="text-3xl mb-2">🗑️</div>
                                <h3 className="font-bold text-slate-700 text-base">删除情人节记录</h3>
                                <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                                    将删除 <span className="font-bold text-slate-600">{characters.find(c => c.id === deleteTargetId)?.name}</span> 的情人节记录，包括存储的回忆和对应的聊天消息。此操作不可撤销。
                                </p>
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setDeleteTargetId(null)}
                                    className="flex-1 py-2.5 bg-slate-100 text-slate-500 font-bold rounded-xl active:scale-95 transition-transform text-sm"
                                >
                                    取消
                                </button>
                                <button
                                    onClick={() => handleDeleteRecord(deleteTargetId)}
                                    className="flex-1 py-2.5 bg-red-500 text-white font-bold rounded-xl active:scale-95 transition-transform text-sm"
                                >
                                    确认删除
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ----- 加载界面 -----
    if (phase === 'loading') {
        return (
            <div className="fixed inset-0 z-[9997] bg-black flex flex-col items-center justify-center animate-fade-in">
                <div className="flex flex-col items-center gap-6">
                    <div className="relative">
                        <div className="w-20 h-20 rounded-full border-2 border-pink-500/20 flex items-center justify-center">
                            {char && <img src={char.avatar} className="w-16 h-16 rounded-full object-cover" alt="" />}
                        </div>
                        <div className="absolute inset-0 w-20 h-20 rounded-full border-2 border-transparent border-t-pink-400 animate-spin" />
                    </div>
                    <div className="text-center">
                        <p className="text-pink-300 text-sm font-light tracking-widest animate-pulse">
                            {char?.name} 正在准备要对你说的话...
                        </p>
                        <p className="text-pink-500/30 text-[10px] mt-2 tracking-wider">VALENTINE'S DAY 2026</p>
                    </div>
                </div>

                {/* 装饰性浮动心形 */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                    {[...Array(6)].map((_, i) => (
                        <div
                            key={i}
                            className="absolute text-pink-500/10 animate-float"
                            style={{
                                left: `${15 + i * 15}%`,
                                top: `${60 + (i % 3) * 10}%`,
                                animationDelay: `${i * 0.5}s`,
                                animationDuration: `${3 + i * 0.5}s`,
                                fontSize: `${16 + i * 4}px`,
                            }}
                        >
                            ♥
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // ----- 错误界面 -----
    if (phase === 'error') {
        return (
            <div className="fixed inset-0 z-[9997] bg-black flex flex-col items-center justify-center animate-fade-in p-8">
                <div className="text-center max-w-sm">
                    <div className="text-4xl mb-4">😢</div>
                    <h2 className="text-white text-lg font-bold mb-2">暂时无法连接</h2>
                    <p className="text-slate-400 text-sm mb-6">{errorMsg}</p>
                    <div className="flex flex-col gap-3">
                        <button
                            onClick={handleRegenerate}
                            className="w-full py-3 bg-pink-500 text-white font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            重试
                        </button>
                        <button
                            onClick={() => { setPhase('select'); setErrorMsg(''); }}
                            className="w-full py-3 bg-slate-800 text-slate-300 font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            重新选择角色
                        </button>
                        <button
                            onClick={onClose}
                            className="w-full py-2 text-slate-500 text-sm active:scale-95 transition-transform"
                        >
                            返回
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ----- 正片：情人节特别对话界面 -----
    const currentLine = dialogueLines[currentLineIndex];
    const spriteInfo = getSpriteForEmotion(currentEmotion, char);
    const isLastLine = currentLineIndex >= dialogueLines.length - 1;
    const isFinished = isLastLine && !isAnimating;

    return (
        <div className="fixed inset-0 z-[9997] bg-black overflow-hidden select-none" onClick={handleScreenClick}>
            {/* 背景 */}
            <div className="absolute inset-0 bg-gradient-to-b from-[#1a0a1e] via-[#0d0a1a] to-[#0a0510] opacity-90" />

            {/* 装饰性粒子 */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                {[...Array(12)].map((_, i) => (
                    <div
                        key={i}
                        className="absolute rounded-full animate-float"
                        style={{
                            left: `${Math.random() * 100}%`,
                            top: `${Math.random() * 100}%`,
                            width: `${2 + Math.random() * 4}px`,
                            height: `${2 + Math.random() * 4}px`,
                            background: `rgba(${200 + Math.random() * 55}, ${100 + Math.random() * 80}, ${150 + Math.random() * 105}, ${0.15 + Math.random() * 0.2})`,
                            animationDelay: `${Math.random() * 5}s`,
                            animationDuration: `${4 + Math.random() * 4}s`,
                        }}
                    />
                ))}
            </div>

            {/* 顶部标题 */}
            <div className="absolute top-0 left-0 right-0 pt-14 text-center z-20">
                <div className="text-[10px] font-mono text-pink-400/40 tracking-[0.3em] uppercase mb-1 pointer-events-none">Valentine's Day Special</div>
                <h2 className="text-2xl font-light text-white/80 tracking-[0.2em] pointer-events-none">{char?.name}</h2>
                {/* 返回按钮 */}
                <button
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    className="absolute top-14 left-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md border border-white/20 active:scale-90 transition-transform control-zone"
                    title="返回"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-white/70">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                    </svg>
                </button>
                {/* 立绘调整按钮 */}
                <button
                    onClick={(e) => { e.stopPropagation(); setShowSpriteSettings(s => !s); }}
                    className="absolute top-14 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md border border-white/20 active:scale-90 transition-transform control-zone"
                    title="调整立绘"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-white/70">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </button>
            </div>

            {/* 立绘调整面板 */}
            {showSpriteSettings && (
                <div className="absolute top-28 right-4 z-50 control-zone animate-fade-in" onClick={(e) => e.stopPropagation()}>
                    <div className="bg-black/70 backdrop-blur-xl rounded-2xl border border-white/15 p-4 w-56 shadow-2xl">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-[11px] font-bold text-white/80 tracking-wide">立绘调整</span>
                            <button onClick={(e) => { e.stopPropagation(); handleSaveSpriteConfig(); }} className="text-[10px] text-pink-400 font-bold">完成</button>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">大小</span>
                                    <span className="text-[10px] text-white/50 font-mono">{localSpriteScale.toFixed(1)}x</span>
                                </div>
                                <input type="range" min="0.3" max="3" step="0.1" value={localSpriteScale} onChange={(e) => setLocalSpriteScale(parseFloat(e.target.value))} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-pink-400" />
                            </div>
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">水平位置</span>
                                    <span className="text-[10px] text-white/50 font-mono">{localSpriteX}%</span>
                                </div>
                                <input type="range" min="-50" max="50" step="1" value={localSpriteX} onChange={(e) => setLocalSpriteX(parseInt(e.target.value))} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-pink-400" />
                            </div>
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">垂直位置</span>
                                    <span className="text-[10px] text-white/50 font-mono">{localSpriteY}%</span>
                                </div>
                                <input type="range" min="-50" max="50" step="1" value={localSpriteY} onChange={(e) => setLocalSpriteY(parseInt(e.target.value))} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-pink-400" />
                            </div>
                            <button onClick={(e) => { e.stopPropagation(); setLocalSpriteScale(1); setLocalSpriteX(0); setLocalSpriteY(0); }} className="w-full text-[10px] text-white/40 hover:text-white/60 py-1.5 transition-colors">
                                重置默认
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 立绘区域 - 高度填满设备，等比缩放，多余宽度裁掉 */}
            <div className="absolute inset-0 overflow-hidden flex items-end justify-center z-10 pointer-events-none">
                {spriteInfo.type === 'image' ? (
                    <img
                        src={spriteInfo.value}
                        className="h-full w-auto max-w-none drop-shadow-[0_10px_30px_rgba(236,72,153,0.3)] transition-all duration-500"
                        style={{
                            transform: `scale(${localSpriteScale}) translate(${localSpriteX}%, ${localSpriteY}%)`,
                            objectFit: 'cover',
                        }}
                        alt=""
                    />
                ) : (
                    <div
                        className="text-[120px] drop-shadow-2xl transition-all duration-500 animate-pulse"
                        style={{ transform: `scale(${localSpriteScale}) translate(${localSpriteX}%, ${localSpriteY}%)` }}
                    >
                        {spriteInfo.value}
                    </div>
                )}
            </div>

            {/* 对话框 */}
            <div className="absolute inset-x-0 bottom-8 z-30 flex justify-center pointer-events-none">
                <div className="w-[90%] max-w-lg pointer-events-auto">
                    {/* 主对话框 */}
                    <div className="bg-black/60 backdrop-blur-xl rounded-2xl border border-pink-500/20 p-6 min-h-[140px] shadow-[0_0_40px_rgba(236,72,153,0.1)] relative">
                        {/* 角色名标签 */}
                        <div className="absolute -top-3 left-6">
                            <div className="bg-gradient-to-r from-pink-500 to-rose-400 text-white px-4 py-1 rounded-sm text-xs font-bold tracking-widest uppercase shadow-lg transform -skew-x-12">
                                {char?.name}
                            </div>
                        </div>

                        {/* 对话文字 */}
                        <p className="text-white/90 text-[16px] leading-relaxed font-light tracking-wide drop-shadow-md mt-2 min-h-[60px]">
                            {displayedText}
                            {isAnimating && <span className="inline-block w-2 h-4 bg-pink-400/70 ml-1 animate-pulse align-middle" />}
                        </p>

                        {/* 继续提示 / 进度 */}
                        {!isAnimating && !isLastLine && (
                            <div className="absolute bottom-3 right-4 animate-bounce opacity-70">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-pink-300">
                                    <path fillRule="evenodd" d="M12.53 16.28a.75.75 0 0 1-1.06 0l-7.5-7.5a.75.75 0 0 1 1.06-1.06L12 14.69l6.97-6.97a.75.75 0 1 1 1.06 1.06l-7.5 7.5Z" clipRule="evenodd" />
                                </svg>
                            </div>
                        )}

                        {/* 进度条 */}
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 rounded-b-2xl overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-pink-500 to-rose-400 transition-all duration-500"
                                style={{ width: `${((currentLineIndex + 1) / dialogueLines.length) * 100}%` }}
                            />
                        </div>
                    </div>

                    {/* 结束后的操作按钮 */}
                    {isFinished && (
                        <div className="mt-4 flex gap-3 animate-fade-in control-zone">
                            <button
                                onClick={(e) => { e.stopPropagation(); setShowRecord(true); }}
                                className="flex-1 py-3 bg-white/10 backdrop-blur-md text-white/80 font-bold rounded-2xl border border-white/10 active:scale-95 transition-transform text-sm flex items-center justify-center gap-1.5"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                                查看记录
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); onClose(); }}
                                className="flex-1 py-3 bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-pink-500/20 active:scale-95 transition-transform text-sm"
                            >
                                谢谢你
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* 书信风格记录查看 */}
            {showRecord && (
                <div className="absolute inset-0 z-[60] flex flex-col bg-black/90 backdrop-blur-sm animate-fade-in" onClick={(e) => e.stopPropagation()}>
                    {/* 顶部工具栏 */}
                    <div className="shrink-0 flex items-center justify-between px-4 pt-12 pb-3">
                        <button onClick={() => setShowRecord(false)} className="p-2 rounded-full bg-white/10 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-white/80"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                        </button>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleRegenerate}
                                className="px-3 py-1.5 rounded-full bg-white/10 text-white/60 text-[11px] font-bold active:scale-95 transition-transform"
                            >
                                重新生成
                            </button>
                            <button
                                onClick={handleExportImage}
                                disabled={isExporting}
                                className="px-3 py-1.5 rounded-full bg-pink-500/80 text-white text-[11px] font-bold active:scale-95 transition-transform flex items-center gap-1 disabled:opacity-50"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                                {isExporting ? '导出中...' : '导出长图'}
                            </button>
                        </div>
                    </div>

                    {/* 书信内容 - 可滚动 */}
                    <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-8">
                        <div ref={recordRef} className="max-w-md mx-auto rounded-xl overflow-hidden shadow-2xl">
                            {/* 信纸 */}
                            <div className="px-8 py-10 relative" style={{ backgroundColor: '#faf6f1' }}>
                                {/* 装饰性边框线 */}
                                <div className="absolute top-4 left-4 right-4 bottom-4 border border-rose-200/30 rounded-lg pointer-events-none" />
                                {/* 四角装饰 */}
                                <div className="absolute top-5 left-5 w-3 h-3 border-t border-l border-rose-300/40 rounded-tl-sm" />
                                <div className="absolute top-5 right-5 w-3 h-3 border-t border-r border-rose-300/40 rounded-tr-sm" />
                                <div className="absolute bottom-5 left-5 w-3 h-3 border-b border-l border-rose-300/40 rounded-bl-sm" />
                                <div className="absolute bottom-5 right-5 w-3 h-3 border-b border-r border-rose-300/40 rounded-br-sm" />

                                {/* 信头 */}
                                <div className="text-center mb-8 relative">
                                    <div className="text-3xl mb-3 opacity-80">&#x1F48C;</div>
                                    <h2 className="text-lg font-bold tracking-widest" style={{ color: '#8b5e6b', fontFamily: 'Georgia, serif' }}>Valentine's Day</h2>
                                    <p className="text-[11px] mt-1 tracking-[0.4em]" style={{ color: '#c4879a' }}>2026.2.14</p>
                                    <div className="flex justify-center gap-6 mt-4 text-[11px]" style={{ color: '#b8899a' }}>
                                        <span>To: <span className="font-medium" style={{ color: '#8b5e6b' }}>{userProfile.name}</span></span>
                                        <span>From: <span className="font-medium" style={{ color: '#8b5e6b' }}>{char?.name}</span></span>
                                    </div>
                                    <div className="w-20 h-px mx-auto mt-5" style={{ backgroundColor: '#d4a0b0', opacity: 0.4 }} />
                                </div>

                                {/* 信件正文 */}
                                <div className="space-y-3 mb-8 px-2">
                                    {dialogueLines.map((line, i) => {
                                        const text = line.text;
                                        const isQuoted = text.startsWith('"') || text.startsWith('\u201c') || text.startsWith('\u300c');
                                        return (
                                            <p key={i} className={isQuoted
                                                ? "text-[15px] leading-[2] tracking-wide"
                                                : "text-[13px] italic leading-[1.9] tracking-wide pl-3 border-l-2"
                                            } style={isQuoted
                                                ? { color: '#5c3a42' }
                                                : { color: '#b8899a', borderColor: 'rgba(200,150,170,0.3)' }
                                            }>
                                                {text}
                                            </p>
                                        );
                                    })}
                                </div>

                                {/* 信尾 */}
                                <div className="text-center mt-10">
                                    <div className="w-20 h-px mx-auto mb-5" style={{ backgroundColor: '#d4a0b0', opacity: 0.4 }} />
                                    <p className="italic text-[11px] tracking-wider" style={{ color: '#c4879a', fontFamily: 'Georgia, serif' }}>with love</p>
                                    <p className="font-medium text-sm mt-2 tracking-widest" style={{ color: '#8b5e6b' }}>{char?.name}</p>
                                    <p className="text-[10px] mt-3 tracking-[0.3em]" style={{ color: '#d4b0be' }}>VALENTINE'S DAY 2026</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================
// 情人节主控制器 - 管理弹窗 → API设置 → 会话 的流转
// ============================================================
interface ValentineControllerProps {
    onClose: () => void;
}

export const ValentineController: React.FC<ValentineControllerProps> = ({ onClose }) => {
    const { characters } = useOS();
    const [stage, setStage] = useState<'popup' | 'api' | 'session'>('popup');

    // 找到 Sully 角色ID（弹窗直接进Sully）
    const sullyChar = characters.find(c => isSullyChar(c));
    const sullyId = sullyChar?.id || characters[0]?.id || '';

    const handleDismiss = () => {
        try { localStorage.setItem(VALENTINE_DISMISSED_KEY, Date.now().toString()); } catch { /* */ }
        onClose();
    };

    if (stage === 'popup') {
        return (
            <ValentinePopup
                onView={() => setStage('session')}
                onDismiss={handleDismiss}
                onCheckApi={() => setStage('api')}
            />
        );
    }

    if (stage === 'api') {
        return (
            <InlineApiSetup
                onDone={() => setStage('session')}
                onBack={() => setStage('popup')}
            />
        );
    }

    // 从弹窗进入时，直接给 Sully 的 charId，跳过角色选择
    return <ValentineSession charId={sullyId} onClose={onClose} />;
};

// ============================================================
// 共享：单个特别活动卡片（统一布局 + 性能优化）
// ============================================================

interface EventCardTheme {
    /** 当期渐变（active）—— 不带透明度 */
    activeGradient: string;
    /** 往期渐变（past）—— 通常加 /70 透明度 */
    pastGradient: string;
    /** 当期阴影颜色 className（如 shadow-pink-200） */
    activeShadow: string;
    /** 文案副色调（如 text-pink-100） */
    subColor: string;
    /** hint 颜色（如 text-pink-200/60） */
    hintColor: string;
    /** 长按提示颜色 */
    helpColor: string;
    /** 头像边框 */
    avatarRing: string;
    /** 当期 hasRecord 小圆点 */
    dotColor: string;
}

interface EventCardProps {
    theme: EventCardTheme;
    icon: string;
    eyebrow?: string;
    title: string;
    subtitleActive: string;
    subtitlePast: string;
    hintActive: string;
    hintPast: string;
    isPast: boolean;
    characters: CharacterProfile[];
    recordKey: string;
    onPick: (charId: string) => void;
    onLongPressDelete: (charId: string) => void;
    /** 选中要删的角色 id（用于显示 ring） */
    pendingDeleteId?: string | null;
}

const SpecialEventCardImpl: React.FC<EventCardProps> = ({
    theme, icon, eyebrow, title, subtitleActive, subtitlePast,
    hintActive, hintPast, isPast, characters, recordKey,
    onPick, onLongPressDelete, pendingDeleteId,
}) => {
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startLP = useCallback((id: string) => {
        longPressTimer.current = setTimeout(() => onLongPressDelete(id), 600);
    }, [onLongPressDelete]);
    const endLP = useCallback(() => {
        if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    }, []);

    return (
        <div className="mb-6" style={{ contain: 'layout paint' }}>
            <div
                className={`rounded-3xl p-6 text-white relative overflow-hidden ${isPast ? `${theme.pastGradient} shadow-lg` : `${theme.activeGradient} shadow-xl ${theme.activeShadow}`}`}
            >
                {/* 装饰圆 —— 用 pointer-events-none 避免拦截 */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-bl-full pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-20 h-20 bg-white/5 rounded-tr-full pointer-events-none" />

                {isPast && (
                    <div className="absolute top-4 right-4 bg-white/20 text-white/85 text-[10px] font-bold px-2 py-0.5 rounded-full border border-white/20">
                        往期活动
                    </div>
                )}

                <div className="relative">
                    <div className="text-3xl mb-2">{icon}</div>
                    {eyebrow && <div className="text-[10px] tracking-[6px] mb-1 opacity-80">{eyebrow}</div>}
                    <h2 className="text-xl font-bold mb-1">{title}</h2>
                    <p className={`${theme.subColor} text-xs mb-4`}>
                        {isPast ? subtitlePast : subtitleActive}
                    </p>
                    <div className={`text-[10px] ${theme.hintColor} mb-4`}>
                        {isPast ? hintPast : hintActive}
                    </div>

                    {characters.length === 0 ? (
                        <div className="text-center text-xs text-white/70 py-3">还没有角色</div>
                    ) : (
                        <div className="max-h-64 overflow-y-auto -mx-1 px-1">
                            <div className="grid grid-cols-3 gap-3">
                                {characters.map(c => {
                                    const hasRecord = !!c.specialMomentRecords?.[recordKey];
                                    const isPending = pendingDeleteId === c.id;
                                    return (
                                        <button
                                            key={c.id}
                                            onClick={() => { if (isPending) { return; } onPick(c.id); }}
                                            onTouchStart={() => hasRecord && startLP(c.id)}
                                            onTouchEnd={endLP}
                                            onTouchCancel={endLP}
                                            onMouseDown={() => hasRecord && startLP(c.id)}
                                            onMouseUp={endLP}
                                            onMouseLeave={endLP}
                                            onContextMenu={(e) => { e.preventDefault(); if (hasRecord) onLongPressDelete(c.id); }}
                                            className={`flex flex-col items-center gap-2 p-3 bg-white/15 rounded-2xl border ${isPending ? 'border-white/80 ring-2 ring-white/60' : 'border-white/20'} active:scale-95 transition-transform relative`}
                                        >
                                            {c.avatar?.startsWith('http') || c.avatar?.startsWith('data:') ? (
                                                <img src={c.avatar} loading="lazy" decoding="async" alt="" className={`w-12 h-12 rounded-full object-cover border-2 ${theme.avatarRing}`} />
                                            ) : (
                                                <span className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl bg-white/10 border-2 ${theme.avatarRing}`}>{c.avatar || '🌸'}</span>
                                            )}
                                            <span className="text-[11px] font-bold truncate w-full text-center">{c.name}</span>
                                            {hasRecord && <span className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ${theme.dotColor}`} />}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {characters.length > 0 && (
                        <p className={`text-[10px] ${theme.helpColor} mt-3 text-center`}>长按角色可删除记录</p>
                    )}
                </div>
            </div>
        </div>
    );
};

const SpecialEventCard = React.memo(SpecialEventCardImpl);

// 三个活动主题
const THEME_LIKE520: EventCardTheme = {
    activeGradient: 'bg-gradient-to-br from-pink-400 via-rose-400 to-amber-300',
    pastGradient: 'bg-gradient-to-br from-pink-300/70 via-rose-300/70 to-amber-200/70',
    activeShadow: 'shadow-rose-200',
    subColor: 'text-rose-50/90',
    hintColor: 'text-rose-100/60',
    helpColor: 'text-rose-100/40',
    avatarRing: 'border-white/30',
    dotColor: 'bg-white/70',
};

const THEME_WHITEDAY: EventCardTheme = {
    activeGradient: 'bg-gradient-to-br from-amber-500 via-orange-400 to-yellow-400',
    pastGradient: 'bg-gradient-to-br from-amber-400/70 via-orange-300/70 to-yellow-300/70',
    activeShadow: 'shadow-amber-200',
    subColor: 'text-amber-100',
    hintColor: 'text-amber-200/60',
    helpColor: 'text-amber-200/40',
    avatarRing: 'border-white/30',
    dotColor: 'bg-white/70',
};

const THEME_VALENTINE: EventCardTheme = {
    activeGradient: 'bg-gradient-to-br from-pink-500 via-rose-500 to-red-400',
    pastGradient: 'bg-gradient-to-br from-pink-400/70 via-rose-400/70 to-red-300/70',
    activeShadow: 'shadow-pink-200',
    subColor: 'text-pink-100',
    hintColor: 'text-pink-200/60',
    helpColor: 'text-pink-200/40',
    avatarRing: 'border-white/30',
    dotColor: 'bg-white/60',
};

// ============================================================
// 特别时光 App（桌面第三页降级入口）
// ============================================================
export const SpecialMomentsApp: React.FC = () => {
    const { closeApp, characters, addToast, updateCharacter } = useOS();
    const [showSession, setShowSession] = useState(false);
    const [selectedCharId, setSelectedCharId] = useState<string>('');
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

    // White Day
    const [showWhiteDaySession, setShowWhiteDaySession] = useState(false);
    const [whiteDayCharId, setWhiteDayCharId] = useState<string>('');
    const [wdDeleteTargetId, setWdDeleteTargetId] = useState<string | null>(null);

    // 520
    const [show520Session, setShow520Session] = useState(false);
    const [like520CharId, setLike520CharId] = useState<string>('');
    const [l520DeleteTargetId, setL520DeleteTargetId] = useState<string | null>(null);

    // 一次性算好可见性 / 往期态（避免每帧调日期函数）
    const visibility = useMemo(() => {
        const n = new Date();
        const wdPast = n.getFullYear() > 2026 || (n.getFullYear() === 2026 && n.getMonth() > 2);
        return {
            like520: { show: isLike520EventAvailable() || isLike520Past(), past: isLike520Past() },
            whiteday: { show: isWhiteDayEventAvailable() || wdPast, past: wdPast },
            valentine: { show: isValentineEventAvailable() || isValentinePast(), past: isValentinePast() },
        };
    }, []);

    const handleL520DeleteRecord = async (cId: string) => {
        try {
            const targetChar = characters.find(c => c.id === cId);
            if (targetChar) {
                const updated = { ...(targetChar.specialMomentRecords || {}) };
                delete updated[LIKE520_RECORD_KEY];
                updateCharacter(cId, { specialMomentRecords: updated });
            }
            const msgs = await DB.getMessagesByCharId(cId);
            const l520Ids = msgs
                .filter(m => m.metadata?.like520Event)
                .map(m => m.id)
                .filter((id): id is number => id !== undefined);
            if (l520Ids.length > 0) await DB.deleteMessages(l520Ids);
            addToast(`已删除 ${targetChar?.name || ''} 的 520 记录`, 'success');
        } catch {
            addToast('删除失败', 'error');
        } finally {
            setL520DeleteTargetId(null);
        }
    };

    const handleWdDeleteRecord = async (cId: string) => {
        try {
            const targetChar = characters.find(c => c.id === cId);
            if (targetChar) {
                const updated = { ...(targetChar.specialMomentRecords || {}) };
                delete updated[WHITEDAY_RECORD_KEY];
                updateCharacter(cId, { specialMomentRecords: updated });
            }
            addToast(`已删除 ${targetChar?.name || ''} 的白色情人节记录`, 'success');
        } catch {
            addToast('删除失败', 'error');
        } finally {
            setWdDeleteTargetId(null);
        }
    };

    const handleDeleteRecord = async (cId: string) => {
        try {
            const targetChar = characters.find(c => c.id === cId);
            if (targetChar) {
                const updatedRecords = { ...(targetChar.specialMomentRecords || {}) };
                delete updatedRecords[VALENTINE_RECORD_KEY];
                updateCharacter(cId, { specialMomentRecords: updatedRecords });
            }
            const msgs = await DB.getMessagesByCharId(cId);
            const valentineIds = msgs
                .filter(m => m.metadata?.valentineEvent)
                .map(m => m.id)
                .filter((id): id is number => id !== undefined);
            if (valentineIds.length > 0) {
                await DB.deleteMessages(valentineIds);
            }
            addToast(`已删除 ${targetChar?.name || ''} 的情人节记录`, 'success');
        } catch (e) {
            console.error('Delete valentine record failed:', e);
            addToast('删除失败', 'error');
        } finally {
            setDeleteTargetId(null);
        }
    };

    if (showSession && selectedCharId) {
        return (
            <ValentineSession
                charId={selectedCharId}
                onClose={() => { setShowSession(false); setSelectedCharId(''); }}
            />
        );
    }

    if (showWhiteDaySession && whiteDayCharId) {
        return (
            <WhiteDaySession
                charId={whiteDayCharId}
                onClose={() => { setShowWhiteDaySession(false); setWhiteDayCharId(''); }}
            />
        );
    }

    if (show520Session && like520CharId) {
        return (
            <Like520Session
                charId={like520CharId}
                onClose={() => { setShow520Session(false); setLike520CharId(''); }}
            />
        );
    }

    return (
        <div className="h-full w-full bg-gradient-to-b from-pink-50 via-white to-rose-50 flex flex-col font-light">
            {/* Header */}
            <div className="h-16 flex items-center justify-between px-4 border-b border-pink-100 bg-white/80 backdrop-blur-sm shrink-0">
                <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-pink-50">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                </button>
                <span className="font-bold text-slate-700">特别时光</span>
                <div className="w-8" />
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
                {/* 520 */}
                {visibility.like520.show && (
                    <SpecialEventCard
                        theme={THEME_LIKE520}
                        icon="🌸"
                        eyebrow="5 · 2 · 0"
                        title="如果 ta 变得小小的"
                        subtitleActive="2026.5.20 — 和 ta 一起度过一个小小的下午"
                        subtitlePast="2026.5.20 — 重温那个小小的下午"
                        hintActive="选择一位角色开始"
                        hintPast="点击角色重温记录"
                        isPast={visibility.like520.past}
                        characters={characters}
                        recordKey={LIKE520_RECORD_KEY}
                        onPick={(id) => { setLike520CharId(id); setShow520Session(true); }}
                        onLongPressDelete={(id) => setL520DeleteTargetId(id)}
                        pendingDeleteId={l520DeleteTargetId}
                    />
                )}

                {/* 白色情人节 */}
                {visibility.whiteday.show && (
                    <SpecialEventCard
                        theme={THEME_WHITEDAY}
                        icon="🍫"
                        title="白色情人节特别活动"
                        subtitleActive="2026 White Day — 和 ta 一起 DIY 一块专属巧克力"
                        subtitlePast="2026.3.14 — 重温你们的专属巧克力"
                        hintActive="选择一位角色开始"
                        hintPast="点击角色查看记录或重新制作"
                        isPast={visibility.whiteday.past}
                        characters={characters}
                        recordKey={WHITEDAY_RECORD_KEY}
                        onPick={(id) => { setWhiteDayCharId(id); setShowWhiteDaySession(true); }}
                        onLongPressDelete={(id) => setWdDeleteTargetId(id)}
                        pendingDeleteId={wdDeleteTargetId}
                    />
                )}

                {/* 情人节 */}
                {visibility.valentine.show && (
                    <SpecialEventCard
                        theme={THEME_VALENTINE}
                        icon="💝"
                        title="情人节特别推送"
                        subtitleActive="2026 Valentine's Day — 听听 ta 想对你说什么"
                        subtitlePast="2026.2.14 — 重温那天 ta 说的话"
                        hintActive="选择一位角色开始"
                        hintPast="点击角色重播或重新生成"
                        isPast={visibility.valentine.past}
                        characters={characters}
                        recordKey={VALENTINE_RECORD_KEY}
                        onPick={(id) => { setSelectedCharId(id); setShowSession(true); }}
                        onLongPressDelete={(id) => setDeleteTargetId(id)}
                        pendingDeleteId={deleteTargetId}
                    />
                )}
            </div>

            {/* 520 删除确认弹窗 */}
            {l520DeleteTargetId && (
                <ConfirmDeleteModal
                    title="删除 520 记录"
                    charName={characters.find(c => c.id === l520DeleteTargetId)?.name || ''}
                    note="将删除该角色的 520 记录，包括所有相关的聊天消息。此操作不可撤销。"
                    onCancel={() => setL520DeleteTargetId(null)}
                    onConfirm={() => handleL520DeleteRecord(l520DeleteTargetId)}
                />
            )}

            {/* 白色情人节删除确认弹窗 */}
            {wdDeleteTargetId && (
                <ConfirmDeleteModal
                    title="删除白色情人节记录"
                    charName={characters.find(c => c.id === wdDeleteTargetId)?.name || ''}
                    note="将删除该角色的白色情人节记录。此操作不可撤销。"
                    onCancel={() => setWdDeleteTargetId(null)}
                    onConfirm={() => handleWdDeleteRecord(wdDeleteTargetId)}
                />
            )}

            {/* 情人节删除确认弹窗 */}
            {deleteTargetId && (
                <ConfirmDeleteModal
                    title="删除情人节记录"
                    charName={characters.find(c => c.id === deleteTargetId)?.name || ''}
                    note="将删除该角色的情人节记录，包括存储的回忆和对应的聊天消息。此操作不可撤销。"
                    onCancel={() => setDeleteTargetId(null)}
                    onConfirm={() => handleDeleteRecord(deleteTargetId)}
                />
            )}
        </div>
    );
};

// ============================================================
// 共享：删除确认弹窗
// ============================================================
const ConfirmDeleteModal: React.FC<{
    title: string;
    charName: string;
    note: string;
    onCancel: () => void;
    onConfirm: () => void;
}> = ({ title, charName, note, onCancel, onConfirm }) => (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-6 animate-fade-in">
        <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
        <div className="relative bg-white rounded-3xl p-6 max-w-xs w-full shadow-2xl">
            <div className="text-center mb-4">
                <div className="text-3xl mb-2">🗑️</div>
                <h3 className="font-bold text-slate-700 text-base">{title}</h3>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                    将删除 <span className="font-bold text-slate-600">{charName}</span> 的记录。{note}
                </p>
            </div>
            <div className="flex gap-3">
                <button onClick={onCancel} className="flex-1 py-2.5 bg-slate-100 text-slate-500 font-bold rounded-xl active:scale-95 transition-transform text-sm">取消</button>
                <button onClick={onConfirm} className="flex-1 py-2.5 bg-red-500 text-white font-bold rounded-xl active:scale-95 transition-transform text-sm">确认删除</button>
            </div>
        </div>
    </div>
);

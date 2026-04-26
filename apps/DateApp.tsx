
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, Message, DateState } from '../types';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { safeResponseJson } from '../utils/safeApi';
import Modal from '../components/os/Modal';
import DateSession from '../components/date/DateSession';
import DateSettings from '../components/date/DateSettings';
import { BookOpen } from '@phosphor-icons/react';

const DateApp: React.FC = () => {
    const { closeApp, characters, activeCharacterId, setActiveCharacterId, apiConfig, addToast, updateCharacter, virtualTime, userProfile } = useOS();
    
    // Modes: 'select' -> 'peek' -> 'session' | 'settings' | 'history'
    const [mode, setMode] = useState<'select' | 'peek' | 'session' | 'settings' | 'history'>('select');
    // Track previous mode for Settings back navigation
    const [previousMode, setPreviousMode] = useState<'select' | 'peek'>('select');
    
    const [peekStatus, setPeekStatus] = useState<string>('');
    const [peekLoading, setPeekLoading] = useState(false);
    
    // History State
    const [historySessions, setHistorySessions] = useState<{date: string, msgs: Message[]}[]>([]);
    // History long-press context menu
    const [historyMenuMsg, setHistoryMenuMsg] = useState<Message | null>(null);
    const [historyMenuPos, setHistoryMenuPos] = useState<{x: number, y: number}>({x: 0, y: 0});
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // History edit modal
    const [historyEditMsg, setHistoryEditMsg] = useState<Message | null>(null);
    const [historyEditContent, setHistoryEditContent] = useState('');
    
    // Resume Logic State
    const [pendingSessionChar, setPendingSessionChar] = useState<CharacterProfile | null>(null);

    // --- NEW: Editing State lifted to here for DB sync ---
    const [dateMessages, setDateMessages] = useState<Message[]>([]);
    const [hasSavedOpening, setHasSavedOpening] = useState(false);

    // Edit Modal State
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editTargetMsg, setEditTargetMsg] = useState<Message | null>(null);
    const [editContent, setEditContent] = useState('');

    const char = characters.find(c => c.id === activeCharacterId);

    // --- Data Loading ---
    const loadDateMessages = async () => {
        if (char) {
            // includeProcessed=true：见面记录有自己的 source 维度，
            // 不能被聊天侧的 memoryPalace 高水位静默吃掉
            const msgs = await DB.getMessagesByCharId(char.id, true);
            // 只筛选 source='date' 的消息用于小说模式显示
            const filtered = msgs.filter(m => m.metadata?.source === 'date').sort((a,b) => a.timestamp - b.timestamp);
            setDateMessages(filtered);
            
            // 检查数据库中是否已经包含当前的 peekStatus（通过内容比对），避免重复保存
            if (peekStatus && filtered.some(m => m.content === peekStatus && m.role === 'assistant')) {
                setHasSavedOpening(true);
            }
        }
    };

    useEffect(() => {
        if (char && mode === 'session') {
            loadDateMessages();
        }
    }, [char, mode]);

    // --- Navigation Helpers ---
    const handleBack = () => {
        if (mode === 'peek') {
            setMode('select');
            setPeekStatus('');
        } else if (mode === 'history') {
            setMode('select');
        } else closeApp();
    };

    const formatTime = () => `${virtualTime.hours.toString().padStart(2, '0')}:${virtualTime.minutes.toString().padStart(2, '0')}`;

    // Improved Time Gap Logic
    const getTimeGapHint = (lastMsgTimestamp: number | undefined): string => {
        if (!lastMsgTimestamp) return '这是你们的初次互动。';
        const now = Date.now();
        const diffMs = now - lastMsgTimestamp;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const currentHour = new Date().getHours();
        const isNight = currentHour >= 23 || currentHour <= 6;

        if (diffMins < 5) return ''; 
        if (diffMins < 60) return `[系统提示: 距离上次互动: ${diffMins} 分钟。]`;
        if (diffHours < 6) {
            if (isNight) return `[系统提示: 距离上次互动: ${diffHours} 小时。现在是深夜/清晨。]`;
            return `[系统提示: 距离上次互动: ${diffHours} 小时。]`;
        }
        if (diffHours < 24) return `[系统提示: 距离上次互动: ${diffHours} 小时。]`;
        const days = Math.floor(diffHours / 24);
        return `[系统提示: 距离上次互动: ${days} 天。]`;
    };

    // --- Resume / Start Logic ---
    const handleCharClick = (c: CharacterProfile) => {
        if (c.savedDateState) {
            setPendingSessionChar(c);
        } else {
            startPeek(c);
        }
    };

    const handleResumeSession = () => {
        if (!pendingSessionChar) return;
        setActiveCharacterId(pendingSessionChar.id);
        setMode('session');
        setPendingSessionChar(null);
        addToast('已恢复上次进度', 'success');
    };

    const handleStartNewSession = () => {
        if (!pendingSessionChar) return;
        updateCharacter(pendingSessionChar.id, { savedDateState: undefined });
        startPeek(pendingSessionChar);
        setPendingSessionChar(null);
    };

    // --- 关键修复: 进入 Session 时立即归档开场白 ---
    const handleEnterSession = async () => {
        if (!char) return;

        // 1. 如果有开场白且未保存，立即保存到数据库
        // 这确保了 user 发送第一句话时，AI 能在历史记录里读到这个开场
        // UPDATE: 添加 isOpening 标记，用于区分新会话
        if (peekStatus && !hasSavedOpening) {
            try {
                await DB.saveMessage({
                    charId: char.id,
                    role: 'assistant',
                    type: 'text',
                    content: peekStatus,
                    metadata: { source: 'date', isOpening: true } // Added Flag
                });
                setHasSavedOpening(true);
            } catch (e) {
                console.error("Failed to save opening", e);
            }
        }

        // 2. 切换模式并刷新数据
        setMode('session');
        await loadDateMessages();
    };

    // --- Peek (Generation) Logic ---
    const startPeek = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        setMode('peek');
        setPeekLoading(true);
        setPeekStatus('');
        setHasSavedOpening(false); 

        try {
            const msgs = await DB.getMessagesByCharId(c.id, true);
            const limit = c.contextLimit || 500;
            const peekLimit = Math.min(limit, 50);
            const lastMsg = msgs[msgs.length - 1];
            const gapHint = getTimeGapHint(lastMsg?.timestamp);

            const recentMsgs = msgs.slice(-peekLimit).map(m => {
                const content = m.type === 'image' ? '[User sent an image]' : m.content;
                const source = m.metadata?.source === 'call' ? '[通话]' : m.metadata?.source === 'date' ? '[约会]' : '[聊天]';
                return `${m.role} ${source}: ${content}`;
            }).join('\n');

            const timeStr = `${virtualTime.day} ${formatTime()}`;
            const baseContext = ContextBuilder.buildCoreContext(c, userProfile, false);

            // 根据时间间隔选择合适的分隔符
            const contextSeparator = gapHint
                ? `\n\n--- [TIME SKIP: ${gapHint}] ---\n\n`
                : `\n\n--- [SCENE CONTINUATION: 刚刚还在聊天，现在来到了面对面的场景] ---\n\n`;

            const peekInstructions = `
### 场景：感知 (Sense Presence)
当前时间: ${timeStr}
时间上下文: ${gapHint}

### 任务
你现在并不在和用户直接对话。用户正在悄悄靠近你所在的地点。
请用**第三人称**描写一段话。
描述：${c.name} 此时此刻正在做什么？周围环境是怎样的？状态如何？

### 逻辑检查
1. **上下文连贯性**: 参考 [最近记录]（注意消息来源标签：[聊天]是文字聊天、[约会]是面对面、[通话]是语音通话）。如果有 [TIME SKIP] 且间隔很久，开启新场景；如果是 [SCENE CONTINUATION]，说明刚刚还在聊天，**必须**自然衔接最近的聊天话题和情绪状态，不要无视之前的对话内容。
2. **状态一致性**: ${gapHint.includes('很久') ? '因为很久没见，可能在发呆、忙碌或者有点落寞。' : '根据最近的聊天内容和情绪来决定当前状态。如果刚聊完，角色的状态应该与聊天内容相呼应。'}
3. **描写风格**: 电影感，沉浸式，细节丰富。不要输出任何前缀，直接输出描写内容。`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: "system", content: baseContext },
                        { role: "user", content: `[最近记录 (Previous Context)]:${recentMsgs}${contextSeparator}${peekInstructions}\n\n(Start sensing...)` }
                    ],
                    temperature: 0.85
                })
            });

            if (!response.ok) throw new Error('Failed to sense presence');
            const data = await safeResponseJson(response);
            const content = data.choices[0].message.content;
            setPeekStatus(content);

        } catch (e: any) {
            setPeekStatus(`(无法感知状态: ${e.message})`);
        } finally {
            setPeekLoading(false);
        }
    };

    // --- Session API Logic ---
    const handleSendMessage = async (text: string): Promise<string> => {
        if (!char) throw new Error("No char");
        
        // 1. Save User Msg
        await DB.saveMessage({ charId: char.id, role: 'user', type: 'text', content: text, metadata: { source: 'date' } });
        
        // 2. Prepare Context
        // Re-fetch messages. Since we saved the opening in handleEnterSession,
        // 'allMsgs' will now correctly contain: [History..., Opening, UserMsg]
        const allMsgs = await DB.getMessagesByCharId(char.id, true);
        
        // Update local state for display
        const dateFiltered = allMsgs.filter(m => m.metadata?.source === 'date').sort((a,b) => a.timestamp - b.timestamp);
        setDateMessages(dateFiltered);

        const limit = char.contextLimit || 500;
        
        // Construct History for AI
        // We exclude the very last message (UserMsg we just sent) from history array 
        // because we'll pass it as the explicit user prompt "content".
        // BUT, we must ensure the Opening (Assistant) is included in history.
        const historyMsgs = allMsgs.slice(-limit, -1).map(m => {
            const timeAxis = `[${new Date(m.timestamp).toLocaleString('zh-CN')}]`;
            const source = m.metadata?.source === 'call' ? '[通话]' : m.metadata?.source === 'date' ? '[约会]' : '[聊天]';
            return {
                role: m.role,
                content: m.type === 'image' ? `${timeAxis} ${source} [User sent an image]` : `${timeAxis} ${source} ${m.content}`
            };
        });

        await injectMemoryPalace(char, allMsgs);
        let systemPrompt = ContextBuilder.buildCoreContext(char, userProfile);
        const REQUIRED_EMOTIONS = ['normal', 'happy', 'angry', 'sad', 'shy'];
        const dateEmotions = [...REQUIRED_EMOTIONS, ...(char.customDateSprites || [])];

        // Explicitly tell AI about the scene
        systemPrompt += `### [Visual Novel Mode: 视觉小说脚本模式]
你正在与用户进行**面对面**的互动。这不是聊天，是一场真实的见面。

### 核心规则：一行一念 (One Line per Beat)
前端解析器基于**换行符**来分割气泡。
1. **禁止混写**: 严禁在同一行里既写动作又写带引号的台词。
2. **情绪标签**: **每一行都必须以** \`[emotion]\` **开头**，表示该行的表情立绘。情绪随内容变化——台词温柔就用 [happy]，动作紧张就用 [shy]，语气冲就用 [angry]。**不要整段只用一个情绪，要逐行根据语境切换。** 仅限使用以下情绪: ${dateEmotions.join(', ')}。不要使用任何不在此列表中的标签。
3. **格式**: 台词用双引号 **"..."**，动作/叙述直接写（不加引号）。

### ⭐ 动作与叙述行的写法
你不是在列清单，你是在写一个正在发生的场景。每一行动作/叙述都应该让人感受到**此时此刻的空气**。

**具体要求**：
- 写出**感官**：光线怎么落的、空气什么味道、皮肤什么触感、周围什么声音
- 写出**节奏**：动作之间有停顿、有犹豫、有呼吸，不要一口气做完三个动作
- 写出**情绪的痕迹**：不要说"他很紧张"，而是写他的手指在桌面上画了一道看不见的线
- 让每一行都有**画面**，像电影里的一个镜头

❌ **不要这样写**（只用一个情绪 + 干巴巴的动作罗列）：
[normal] 把手放下，看向你。
走到你身边，坐下来。
拿起杯子，喝了一口水。

✅ **要这样写**（每行标注情绪 + 有呼吸感的叙述）：
[normal] 指尖从发梢滑落，垂在身侧。视线转过来的时候并不急，像是刚好、又像是故意。
[shy] "……你一直在看我吗？"
[happy] 嘴角的弧度藏不住，像是被戳中了什么小心思。
[normal] 脚步踩在木地板上的声音很轻。在你旁边坐下来，衣料带过一缕还没散尽的冷风。

### 场景上下文
1. **Location**: 你们现在**面对面**。
2. **Context**: 参考历史记录。如果刚刚才看到开场白（Opening），请自然接话。
`;

        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...historyMsgs,
                    { role: 'user', content: `${text}\n\n(System Note: 严格遵守 VN 格式。每一行都要以 [emotion] 开头，根据内容逐行切换情绪标签，不要整段只用同一个。叙述行写出场景的呼吸感，不要罗列动作。)` }
                ],
                temperature: 0.85
            })
        });

        if (!response.ok) throw new Error('API Error');
        const data = await safeResponseJson(response);
        const content = data.choices[0].message.content;

        // 3. Save AI Response
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: content, metadata: { source: 'date' } });

        // Refresh local state
        const freshMsgs = await DB.getMessagesByCharId(char.id, true);
        setDateMessages(freshMsgs.filter(m => m.metadata?.source === 'date').sort((a,b) => a.timestamp - b.timestamp));

        return content;
    };

    const handleReroll = async (): Promise<string> => {
        if (!char || dateMessages.length === 0) throw new Error("No context");
        
        const lastMsg = dateMessages[dateMessages.length - 1];
        if (lastMsg.role !== 'assistant') throw new Error("Cannot reroll user message");

        // 1. Delete last AI message
        await DB.deleteMessage(lastMsg.id);
        
        // 2. Find the user input that triggered it
        const allMsgs = await DB.getMessagesByCharId(char.id, true);
        const validMsgs = allMsgs.filter(m => m.id !== lastMsg.id);
        const lastUserMsg = validMsgs[validMsgs.length - 1];
        
        if (!lastUserMsg || lastUserMsg.role !== 'user') throw new Error("Context lost");

        // 3. Call API logic
        const limit = char.contextLimit || 500;
        const historyMsgs = validMsgs.slice(-limit, -1).map(m => ({
            role: m.role,
            content: m.type === 'image' ? '[User sent an image]' : m.content
        }));

        await injectMemoryPalace(char, allMsgs);
        let systemPrompt = ContextBuilder.buildCoreContext(char, userProfile);
        const REQUIRED_EMOTIONS_R = ['normal', 'happy', 'angry', 'sad', 'shy'];
        const dateEmotionsR = [...REQUIRED_EMOTIONS_R, ...(char.customDateSprites || [])];
        systemPrompt += `### [Visual Novel Mode: 视觉小说脚本模式]
你正在与用户进行**面对面**的互动。

### 格式规则
1. **禁止混写**: 严禁在同一行里既写动作又写带引号的台词。
2. **情绪标签**: \`[emotion]\` (放在行首)。**仅限使用以下情绪**: ${dateEmotionsR.join(', ')}。不要使用不在列表中的标签。
3. **格式**: 台词用双引号 **"..."**，动作/叙述直接写。

### ⭐ 动作与叙述行的写法
不要罗列动作。写出感官细节、停顿和呼吸感，让每一行都像电影镜头——有画面、有空气、有温度。
用细微的肢体语言暗示情绪，不要直接说"开心""紧张"。
`;

        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...historyMsgs,
                    { role: 'user', content: `${lastUserMsg.content}\n\n(System Note: Reroll. 用不同的角度重写，叙述行保持场景感。)` }
                ],
                temperature: 0.9 
            })
        });

        if (!response.ok) throw new Error('API Error');
        const data = await safeResponseJson(response);
        const content = data.choices[0].message.content;

        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: content, metadata: { source: 'date' } });

        // Sync
        const freshMsgs = await DB.getMessagesByCharId(char.id, true);
        setDateMessages(freshMsgs.filter(m => m.metadata?.source === 'date').sort((a,b) => a.timestamp - b.timestamp));

        return content;
    };

    // --- Editing & Deletion ---
    const handleDeleteMessage = async (msg: Message) => {
        await DB.deleteMessage(msg.id);
        setDateMessages(prev => prev.filter(m => m.id !== msg.id));
    };

    const handleDeleteMessages = async (ids: number[]) => {
        if (ids.length === 0) return;
        await Promise.all(ids.map(id => DB.deleteMessage(id)));
        setDateMessages(prev => prev.filter(m => !ids.includes(m.id)));
        addToast(`已删除 ${ids.length} 条记录`, 'success');
    };

    const confirmEditMessage = async () => {
        if (!editTargetMsg) return;
        await DB.updateMessage(editTargetMsg.id, editContent);
        setDateMessages(prev => prev.map(m => m.id === editTargetMsg.id ? { ...m, content: editContent } : m));
        setIsEditModalOpen(false);
        setEditTargetMsg(null);
        addToast('已修改', 'success');
    };

    // --- History Long Press ---
    const handleHistoryLongPressStart = useCallback((msg: Message, e: React.TouchEvent | React.MouseEvent) => {
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
        longPressTimer.current = setTimeout(() => {
            setHistoryMenuMsg(msg);
            setHistoryMenuPos({ x: clientX, y: clientY });
        }, 500);
    }, []);

    const handleHistoryLongPressEnd = useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);

    const handleHistoryDelete = async (msg: Message) => {
        await DB.deleteMessage(msg.id);
        setHistorySessions(prev => prev.map(s => ({
            ...s,
            msgs: s.msgs.filter(m => m.id !== msg.id)
        })).filter(s => s.msgs.length > 0));
        setHistoryMenuMsg(null);
        addToast('已删除', 'success');
    };

    const handleHistoryEditOpen = (msg: Message) => {
        setHistoryEditMsg(msg);
        setHistoryEditContent(msg.content);
        setHistoryMenuMsg(null);
    };

    const handleHistoryEditConfirm = async () => {
        if (!historyEditMsg) return;
        await DB.updateMessage(historyEditMsg.id, historyEditContent);
        setHistorySessions(prev => prev.map(s => ({
            ...s,
            msgs: s.msgs.map(m => m.id === historyEditMsg.id ? { ...m, content: historyEditContent } : m)
        })));
        setHistoryEditMsg(null);
        addToast('已修改', 'success');
    };

    const onExitSession = (finalState: DateState) => {
        if (char) {
            updateCharacter(char.id, { savedDateState: finalState });
            addToast('进度已保存', 'success');
        }
        setMode('select');
        setPeekStatus('');
        setHasSavedOpening(false);
    };

    const openHistory = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        // includeProcessed=true：见面历史完全独立于聊天侧高水位，
        // 否则用户开了向量记忆后老的见面记录会全部"消失"
        const msgs = await DB.getMessagesByCharId(c.id, true);
        // dateMsgs sorted DESCENDING (newest first)
        const dateMsgs = msgs.filter(m => m.metadata?.source === 'date').sort((a, b) => b.timestamp - a.timestamp);
        
        const sessions: {date: string, msgs: Message[]}[] = [];
        if (dateMsgs.length > 0) {
            // Group by strict time gap (30 mins) OR explicit Opening flag
            let currentSession: Message[] = [dateMsgs[0]];
            
            for (let i = 1; i < dateMsgs.length; i++) {
                const prev = dateMsgs[i-1]; // Newer message
                const curr = dateMsgs[i];   // Older message
                
                // Break session if:
                // 1. Time gap > 30 minutes
                // 2. OR THE PREVIOUS (Newer) message was an opening. 
                //    (If 'prev' is an opening, it means 'prev' is the START of the newer session we just accumulated. 
                //     So 'curr' must belong to an older, different session.)
                const isTimeBreak = Math.abs(prev.timestamp - curr.timestamp) > 30 * 60 * 1000;
                const splitSincePrevWasOpening = prev.metadata?.isOpening === true;

                if (isTimeBreak || splitSincePrevWasOpening) {
                    // This session ends. 
                    // Date label is the Start Time of this session (which is the oldest msg in currentSession)
                    const sessionStartMsg = currentSession[currentSession.length - 1];
                    sessions.push({ 
                        date: new Date(sessionStartMsg.timestamp).toLocaleString(), 
                        msgs: currentSession.reverse() // Reverse messages to be Chronological (Old->New) inside the bubble
                    });
                    currentSession = [curr];
                } else {
                    currentSession.push(curr);
                }
            }
            // Push final session
            const sessionStartMsg = currentSession[currentSession.length - 1];
            sessions.push({ 
                date: new Date(sessionStartMsg.timestamp).toLocaleString(), 
                msgs: currentSession.reverse() 
            });
        }
        // Do NOT reverse sessions array. We want [NewestSession, OlderSession, OldestSession].
        // Default loop populated them New -> Old.
        setHistorySessions(sessions);
        setMode('history');
    };

    // --- Render ---

    if (mode === 'select' || !char) {
        return (
            <div className="h-full w-full bg-slate-50 flex flex-col font-light">
                <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200 bg-white sticky top-0 z-10">
                    <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-slate-100">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-bold text-slate-700">选择见面对象</span>
                    <div className="w-8"></div>
                </div>
                <div className="p-4 grid grid-cols-2 gap-4 overflow-y-auto">
                    {characters.map(c => (
                        <div key={c.id} onClick={() => handleCharClick(c)} className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 active:scale-95 transition-transform flex flex-col items-center gap-3 relative group">
                            <button 
                                onClick={(e) => { e.stopPropagation(); openHistory(c); }}
                                className="absolute top-2 right-2 p-1.5 text-slate-300 hover:text-slate-600 hover:bg-slate-100 rounded-full transition-colors z-20 active:scale-90"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" /></svg>
                            </button>
                            <img src={c.avatar} className="w-16 h-16 rounded-full object-cover" />
                            <span className="font-bold text-slate-700">{c.name}</span>
                            {c.savedDateState && <div className="absolute top-2 left-2 w-2 h-2 bg-green-500 rounded-full animate-pulse" title="有存档"></div>}
                        </div>
                    ))}
                </div>
                <Modal isOpen={!!pendingSessionChar} title="发现进度" onClose={() => setPendingSessionChar(null)} footer={<div className="flex gap-3 w-full"><button onClick={handleStartNewSession} className="flex-1 py-3 bg-slate-100 rounded-2xl text-slate-600 font-bold">新的见面</button><button onClick={handleResumeSession} className="flex-1 py-3 bg-green-500 text-white rounded-2xl font-bold shadow-lg shadow-green-200">继续上次</button></div>}>
                    <div className="text-center text-slate-500 text-sm py-4">检测到 {pendingSessionChar?.name} 有未结束的见面。<br/><span className="text-xs text-slate-400 mt-2 block">(存档时间: {pendingSessionChar?.savedDateState?.timestamp ? new Date(pendingSessionChar.savedDateState.timestamp).toLocaleString() : 'Unknown'})</span></div>
                </Modal>
            </div>
        );
    }

    if (mode === 'history') {
        return (
            <div className="h-full w-full bg-slate-50 flex flex-col font-light" onClick={() => historyMenuMsg && setHistoryMenuMsg(null)}>
                <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200 bg-white sticky top-0 z-10">
                    <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-slate-100"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                    <span className="font-bold text-slate-700">见面记录</span>
                    <div className="w-8"></div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-6 pb-20">
                    {historySessions.length === 0 ? <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2"><BookOpen size={48} className="opacity-50" /><span className="text-xs">暂无见面记录</span></div> : historySessions.map((session, idx) => (
                        <div key={idx} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                            <div className="bg-slate-50 px-4 py-3 border-b border-slate-100 flex justify-between items-center"><span className="text-xs font-bold text-slate-500 uppercase tracking-wider">{session.date}</span><span className="text-[10px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">{session.msgs.length} 句</span></div>
                            <div className="p-4 space-y-4">
                                {session.msgs.map(m => {
                                    const text = (m.content || '').replace(/\[.*?\]/g, '').trim();
                                    return (
                                        <div
                                            key={m.id}
                                            className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} select-none`}
                                            onTouchStart={(e) => handleHistoryLongPressStart(m, e)}
                                            onTouchEnd={handleHistoryLongPressEnd}
                                            onTouchMove={handleHistoryLongPressEnd}
                                            onMouseDown={(e) => handleHistoryLongPressStart(m, e)}
                                            onMouseUp={handleHistoryLongPressEnd}
                                            onMouseLeave={handleHistoryLongPressEnd}
                                            onContextMenu={(e) => { e.preventDefault(); setHistoryMenuMsg(m); setHistoryMenuPos({ x: e.clientX, y: e.clientY }); }}
                                        >
                                            <div className={`max-w-[90%] text-sm leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'text-slate-500 text-right italic' : 'text-slate-800'}`}>
                                                {m.role === 'user' ? <span className="bg-slate-100 px-3 py-2 rounded-xl rounded-tr-none inline-block">{text}</span> : <span>{text || '(无内容)'}</span>}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Long-press context menu */}
                {historyMenuMsg && (
                    <div
                        className="fixed z-50 bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden animate-fade-in"
                        style={{ top: Math.min(historyMenuPos.y, window.innerHeight - 120), left: Math.min(historyMenuPos.x, window.innerWidth - 140) }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => handleHistoryEditOpen(historyMenuMsg)}
                            className="w-full px-5 py-3 text-sm text-left text-slate-700 hover:bg-slate-50 active:bg-slate-100 flex items-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z" /></svg>
                            编辑
                        </button>
                        <div className="border-t border-slate-100" />
                        <button
                            onClick={() => handleHistoryDelete(historyMenuMsg)}
                            className="w-full px-5 py-3 text-sm text-left text-red-500 hover:bg-red-50 active:bg-red-100 flex items-center gap-2"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                            删除
                        </button>
                    </div>
                )}

                {/* History edit modal */}
                <Modal isOpen={!!historyEditMsg} title="编辑消息" onClose={() => setHistoryEditMsg(null)} footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setHistoryEditMsg(null)} className="flex-1 py-3 bg-slate-100 rounded-2xl text-slate-600 font-bold">取消</button>
                        <button onClick={handleHistoryEditConfirm} className="flex-1 py-3 bg-blue-500 text-white rounded-2xl font-bold shadow-lg shadow-blue-200">保存</button>
                    </div>
                }>
                    <textarea
                        value={historyEditContent}
                        onChange={(e) => setHistoryEditContent(e.target.value)}
                        className="w-full h-48 p-3 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-300"
                    />
                </Modal>
            </div>
        );
    }

    if (mode === 'peek') {
        return (
            <div className="h-full w-full bg-black relative flex flex-col font-sans overflow-hidden">
                <div className="pt-24 flex flex-col items-center z-10 shrink-0">
                     <div className="text-xs font-mono text-neutral-500 mb-2 tracking-[0.2em] font-medium">{virtualTime.day.toUpperCase()} {formatTime()}</div>
                     <h2 className="text-4xl font-light text-white tracking-[0.3em] uppercase">{char.name}</h2>
                </div>
                {peekLoading && (
                    <div className="flex-1 flex flex-col items-center justify-center -mt-20 z-10"><div className="w-12 h-[1px] bg-neutral-800 mb-12"></div><div className="w-[1px] h-12 bg-gradient-to-b from-transparent via-white to-transparent animate-pulse mb-6"></div><p className="text-sm font-light text-neutral-500 italic tracking-widest">正在感知...</p></div>
                )}
                {!peekLoading && peekStatus && (
                    <div className="flex-1 min-h-0 flex flex-col px-8 pb-10 z-10 animate-fade-in">
                        <div className="flex-1 overflow-y-auto no-scrollbar mb-8 mask-image-gradient pt-8"><div className="min-h-full flex flex-col justify-center"><p className="text-neutral-300 text-[15px] leading-8 tracking-wide text-justify font-light select-none whitespace-pre-wrap">{peekStatus}</p></div></div>
                        <div className="shrink-0 flex flex-col items-center gap-6">
                             <div className="w-full flex gap-3">
                                 {/* 修改这里：调用 handleEnterSession 确保开场白被保存 */}
                                 <button onClick={handleEnterSession} className="flex-1 h-14 bg-white text-black rounded-full font-bold tracking-[0.1em] text-sm shadow-[0_0_20px_rgba(255,255,255,0.1)] active:scale-95 transition-transform hover:bg-neutral-200">走过去 (Approach)</button>
                                 <button onClick={() => startPeek(char)} className="w-14 h-14 bg-neutral-800 text-white rounded-full flex items-center justify-center border border-neutral-700 shadow-lg active:scale-90 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg></button>
                             </div>
                             <div className="flex flex-col items-center gap-3 text-[10px] text-neutral-600 font-medium tracking-wider"><button onClick={() => { setPreviousMode('peek'); setMode('settings'); }} className="hover:text-neutral-400 transition-colors">布置场景 / 设定立绘</button><button onClick={handleBack} className="hover:text-neutral-400 transition-colors">悄悄离开</button></div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    if (mode === 'settings') {
        return <DateSettings char={char} onBack={() => setMode(previousMode)} />;
    }

    if (mode === 'session') {
        return (
            <>
                <DateSession 
                    char={char}
                    userProfile={userProfile}
                    messages={dateMessages}
                    peekStatus={peekStatus}
                    initialState={char.savedDateState}
                    onSendMessage={handleSendMessage}
                    onReroll={handleReroll}
                    onExit={onExitSession}
                    onEditMessage={(msg) => { setEditTargetMsg(msg); setEditContent(msg.content); setIsEditModalOpen(true); }}
                    onDeleteMessage={handleDeleteMessage}
                    onDeleteMessages={handleDeleteMessages}
                    onSettings={() => {}} // Removed parent state change, DateSession handles it internally now
                />
                
                {/* Global Message Edit Modal for Session Mode */}
                <Modal isOpen={isEditModalOpen} title="编辑内容" onClose={() => setIsEditModalOpen(false)} footer={<><button onClick={() => setIsEditModalOpen(false)} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button onClick={confirmEditMessage} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">保存</button></>}>
                    <textarea value={editContent} onChange={e => setEditContent(e.target.value)} className="w-full h-32 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-primary/20 transition-all text-sm leading-relaxed" />
                </Modal>
            </>
        );
    }

    return null;
};

export default DateApp;

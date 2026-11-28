import SystemAlarmDialog, { type AlarmTarget } from '../components/schedule/SystemAlarmDialog';
import { isAndroidAlarm } from '../utils/nativeAlarm';



import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { Task, Anniversary, CharacterProfile } from '../types';
import Modal from '../components/os/Modal';
import { ContextBuilder } from '../utils/context';
import { safeResponseJson, extractContent } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { getCalendarDayDifference, getLocalDateKey } from '../utils/localDate';
import { useLocalDateKey } from '../hooks/useLocalDateKey';
import { trackEvent } from '../utils/analytics';
import { splitInlineThinking } from '../utils/assistantThinking';
import { resolveTimeContractTheme, notifyTimeContractChanged } from '../utils/timeContract';
import TokenImg from '../components/os/TokenImg';
import { useConfirmDialog } from '../hooks/useConfirmDialog';


type ThemeMode = 'cyber' | 'soft' | 'minimal';

// Theme Configuration Definitions
const THEMES: Record<ThemeMode, any> = {
    cyber: {
        id: 'cyber',
        bg: 'bg-[#0f172a]',
        text: 'text-slate-200',
        textSub: 'text-slate-500',
        accent: 'text-cyan-400',
        border: 'border-cyan-900/30',
        card: 'bg-slate-900/50 backdrop-blur-md border border-slate-700/50',
        buttonPrimary: 'bg-cyan-600 hover:bg-cyan-500 text-white rounded-none skew-x-[-10deg]',
        font: 'font-mono',
        iconDone: 'text-green-500',
        decoLine: 'bg-slate-800',
        modalBg: 'bg-[#0f172a] border border-cyan-500',
        input: 'bg-slate-800 text-white [color-scheme:dark] placeholder:text-slate-400 border-none rounded-none',
        label: 'QUEST LOG',
        eventLabel: 'SERVER EVENTS'
    },
    soft: {
        id: 'soft',
        bg: 'bg-[#fff0f5]', // Lavender Blush
        text: 'text-slate-700',
        textSub: 'text-slate-400',
        accent: 'text-pink-500',
        border: 'border-pink-100',
        card: 'bg-white/80 backdrop-blur-xl rounded-[2rem] shadow-sm border border-white',
        buttonPrimary: 'bg-pink-400 hover:bg-pink-500 text-white rounded-2xl shadow-lg shadow-pink-200',
        font: 'font-sans',
        iconDone: 'text-pink-400',
        decoLine: 'bg-pink-200',
        modalBg: 'bg-white/90 rounded-[2.5rem]',
        input: 'bg-pink-50 text-slate-700 border border-pink-100 rounded-xl',
        label: '心愿单',
        eventLabel: '纪念日'
    },
    minimal: {
        id: 'minimal',
        bg: 'bg-[#eef2f6]', // Classic Neumorphism base
        text: 'text-slate-600',
        textSub: 'text-slate-400',
        accent: 'text-indigo-500',
        border: 'border-transparent',
        // Neumorphism Outer Shadow
        card: 'bg-[#eef2f6] rounded-2xl shadow-[6px_6px_12px_#d1d9e6,-6px_-6px_12px_#ffffff]',
        // Neumorphism Pressed State simulation for buttons usually, but here flat prompt
        buttonPrimary: 'bg-[#eef2f6] text-slate-600 font-bold rounded-xl shadow-[6px_6px_12px_#d1d9e6,-6px_-6px_12px_#ffffff] active:shadow-[inset_4px_4px_8px_#d1d9e6,inset_-4px_-4px_8px_#ffffff]',
        font: 'font-sans',
        iconDone: 'text-slate-400',
        decoLine: 'bg-slate-300',
        modalBg: 'bg-[#eef2f6] rounded-2xl shadow-2xl',
        input: 'bg-[#eef2f6] text-slate-700 rounded-xl shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]',
        label: 'Focus',
        eventLabel: 'Timeline'
    }
};

const ScheduleApp: React.FC = () => {
    const { closeApp, openApp, theme: osTheme, characters, activeCharacterId, apiConfig, addToast, userProfile, characterGroups } = useOS();
    const { requestConfirm, confirmDialog } = useConfirmDialog();
    const localDateKey = useLocalDateKey();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [anniversaries, setAnniversaries] = useState<Anniversary[]>([]);
    const [activeTab, setActiveTab] = useState<'quest' | 'server_events'>('quest');
    useAppShortcut(ShortcutAppID.Schedule, intent => setActiveTab(intent.entryId === 'server_events' ? 'server_events' : 'quest'));
    
    // Processing State for feedback
    const [processingTaskIds, setProcessingTaskIds] = useState<Set<string>>(new Set());

    const [generatingComment, setGeneratingComment] = useState<string | null>(null);
    const commentBusy = useRef(false);
    const [commentError, setCommentError] = useState<{ id: string; message: string } | null>(null);
    const deletedAnniversaries = useRef(new Set<string>());

    // Theme State
    const selectedTheme = resolveTimeContractTheme(osTheme.scheduleAppTheme);
    const currentThemeMode: ThemeMode = selectedTheme === 'system' ? (osTheme.darkMode ? 'cyber' : 'minimal') : selectedTheme;
    const theme = THEMES[currentThemeMode];

    const [alarmTarget, setAlarmTarget] = useState<AlarmTarget | null>(null);
    const androidAlarm = isAndroidAlarm();

    // Add Modal States
    const [showTaskModal, setShowTaskModal] = useState(false);
    const [showAnniModal, setShowAnniModal] = useState(false);

    // Forms
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [newTaskDate, setNewTaskDate] = useState('');
    const [newTaskSupervisor, setNewTaskSupervisor] = useState<string>(activeCharacterId || '');
    const [supervisorGroupId, setSupervisorGroupId] = useState<string>(GROUP_FILTER_ALL); // 选监督人的分组筛选

    const [newAnniTitle, setNewAnniTitle] = useState('');
    const [newAnniDate, setNewAnniDate] = useState('');
    const [newAnniChar, setNewAnniChar] = useState<string>(activeCharacterId || '');
    const [anniCharGroupId, setAnniCharGroupId] = useState<string>(GROUP_FILTER_ALL); // 纪念日关联对象的分组筛选

    useEffect(() => { void loadData().catch(() => addToast('时光契约读取失败，请重新打开', 'error')); }, []);

    const loadData = async () => {
        const [t, a] = await Promise.all([DB.getAllTasks(), DB.getAllAnniversaries()]);
        setTasks(t.sort((a, b) => b.createdAt - a.createdAt));
        setAnniversaries(a.sort((a, b) => a.date.localeCompare(b.date)));
    };

    // --- AI Logic ---

    const generateTaskReward = async (task: Task) => {

        const sourceSupervisor = characters.find(c => c.id === task.supervisorId);
        const supervisor = sourceSupervisor ? structuredClone(sourceSupervisor) : undefined;
        if (!supervisor || !apiConfig.apiKey) {
            addToast('任务已完成', 'success');
            return;
        }

        // FEEDBACK: Show loading state immediately
        // Note: The caller handles setting processingTaskIds, but we can also add a toast
        addToast(`${supervisor.name} 正在确认你的成果...`, 'info');

        try {
            // 1. Build Persona Context
            // RESTORED: Full context
            await injectMemoryPalace(supervisor, undefined, task.title);
            const characterContextInput = { char: supervisor, user: userProfile };


            const userPrompt = `
### 场景：任务完成 (Task Completed)
用户 (${userProfile.name}) 刚刚在现实生活中完成了一个任务/契约： "${task.title}"。
你是监督人。

### 任务
请根据你的人设，对用户完成任务这一行为做出反应。
- 如果你是严厉的：勉强认可，或者催促下一个。
- 如果你是温柔的：给予温暖的夸奖。
- 如果你是傲娇的：别扭地表示一下。
- **关键**：不要问我用什么语气，**你自己**根据你的人设决定。

**输出要求**:
- 仅输出一句话（类似气泡通知）。
- **必须使用用户常用语言**。
- 不要有引号。`;

            // 2. Separate System and User roles
            const messages = [
                { role: "system", content: '' },
                { role: "user", content: userPrompt }
            ];

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, messages)),
                    temperature: 0.9, 
                    max_tokens: 8000 
                }),
                __sullyMeta: {
                    appId: 'schedule',
                    appName: '日程表',
                    charId: supervisor.id,
                    charName: supervisor.name,
                    purpose: '待办完成反馈',
                },
            } as RequestInit);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API Error ${response.status}: ${errorText.slice(0, 100)}`);
            }

            const data = await safeResponseJson(response);
            
            // Extract content, handling potential reasoning_content or empty standard content
            let text = extractContent(data);
            if (!text && data.choices?.[0]?.message?.reasoning_content) {
                // If standard content is empty but model "thought" about it, try to use thought or fallback
                console.warn("AI returned empty content but has reasoning.");
            }
            
            if (text) {
                text = text.replace(/^["']|["']$/g, '');
                addToast(`${supervisor.name}: ${text}`, 'success');
                // Inject into Chat Memory (Localized & Personalized)
                await DB.saveMessage({
                    charId: supervisor.id,
                    role: 'system',
                    type: 'text',
                    content: `[系统: ${userProfile.name} 完成了任务 "${task.title}"。${supervisor.name} 评价道: "${text}"]`
                });
            } else {
                console.warn("AI returned empty content", data);
                addToast('任务完成 (AI 未返回评价)', 'success');
            }

        } catch (e: any) {
            console.error("Task Reward Error:", e);
            addToast(`评价生成失败: ${e.message}`, 'error');
        }
    };

    const generateAnniversaryThought = async (anni: Anniversary) => {

        if (commentBusy.current) return;
        const sourceCharacter = characters.find(c => c.id === anni.charId);
        if (!sourceCharacter) { addToast('请先为这条纪念日关联角色', 'error'); return; }
        if (!apiConfig.apiKey) { addToast('请先配置对话 API，再生成留言', 'error'); return; }
        commentBusy.current = true;
        if (anni.aiThought?.trim() && !await requestConfirm({ title: '重新生成留言？', message: '会调用 AI 消耗额度，并在成功后替换现有留言。失败保留原留言。', confirmText: '重新生成', variant: 'danger' })) {
            commentBusy.current = false; return;
        }
        if (deletedAnniversaries.current.has(anni.id)) { commentBusy.current = false; return; }
        setGeneratingComment(anni.id);
        setCommentError(null);
        trackEvent('手动生成纪念日留言');
        const char = structuredClone(sourceCharacter);
        const daysDiff = getCalendarDayDifference(getLocalDateKey(), anni.date) ?? 0;
        const dayText = daysDiff > 0 ? `还有 ${daysDiff} 天` : (daysDiff === 0 ? '就是今天!' : `已经过去 ${Math.abs(daysDiff)} 天了`);

        // RESTORED: Full context

        const characterContextInput = { char, user: userProfile };


        const userPrompt = `
### 场景：纪念日提醒
事件: "${anni.title}"
时间状态: ${dayText}

### 任务
请根据你的人设，针对这个日期发表一句简短的感想。
**输出要求**:
- 仅输出一句话。
- **必须使用用户常用语言**。`;

        const messages = [
            { role: "system", content: '' },
            { role: "user", content: userPrompt }
        ];

        try {
            await injectMemoryPalace(char, undefined, anni.title);
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, messages)),
                    temperature: 0.8,
                    max_tokens: 8000
                }),
                __sullyMeta: {
                    appId: 'schedule',
                    appName: '日程表',
                    charId: char.id,
                    charName: char.name,
                    purpose: '纪念日感想生成',
                },
            } as RequestInit);

            if (!response.ok) {
                 const errorText = await response.text();
                 throw new Error(`API Error ${response.status}: ${errorText.slice(0, 50)}`);
            }

            const data = await safeResponseJson(response);
            const text = extractContent(data).replace(/^["']|["']$/g, '');
            
            if (!text) throw new Error('AI 未返回留言正文，请重试');
            if (!deletedAnniversaries.current.has(anni.id)) {
                const updatedAnni = { ...anni, aiThought: text, lastThoughtGeneratedAt: Date.now() };
                await DB.saveAnniversary(updatedAnni);
                notifyTimeContractChanged();
                setAnniversaries(prev => prev.map(a => a.id === anni.id ? updatedAnni : a));
                trackEvent('生成纪念日留言完成');
                addToast('角色留言已保存', 'success');
            }
        } catch (e: any) {
            const message = e instanceof Error ? e.message : '留言生成失败，请重试';
            setCommentError({ id: anni.id, message });
            addToast(message, 'error');
            trackEvent('生成纪念日留言失败');
        } finally {
            commentBusy.current = false;
            setGeneratingComment(null);
        }
    };

    // --- Actions ---
    const pendingWrites = useRef(new Set<string>());
    const persist = async (kind: 'task' | 'anniversary', action: 'create' | 'update' | 'delete', id: string, write: () => Promise<unknown>) => {
        const key = action === 'create' ? kind + ':create' : kind + ':' + id;
        if (pendingWrites.current.has(key)) return false;
        pendingWrites.current.add(key);
        try {
            await write();
            notifyTimeContractChanged();
            trackEvent('保存时光契约条目', { kind, action, outcome: 'success' });
            return true;
        } catch {
            trackEvent('保存时光契约条目', { kind, action, outcome: 'failed' });
            addToast('保存失败，请重试；原记录仍保留', 'error');
            return false;
        } finally { pendingWrites.current.delete(key); }
    };

    const handleAddTask = async () => {
        if (!newTaskTitle.trim()) return;
        const task: Task = {
            id: `task-${Date.now()}`,
            title: newTaskTitle.trim(),
            supervisorId: newTaskSupervisor || characters[0]?.id || '',
            deadline: newTaskDate || undefined,
            tone: 'gentle', // Deprecated but kept for type compatibility
            isCompleted: false,
            createdAt: Date.now()
        };
        if (!await persist('task', 'create', task.id, () => DB.saveTask(task))) return;
        setTasks(prev => [task, ...prev]);
        setShowTaskModal(false);
        setNewTaskTitle('');
        setNewTaskDate('');
    };

    const handleToggleTask = async (task: Task) => {
        const updated = { ...task, isCompleted: !task.isCompleted, completedAt: !task.isCompleted ? Date.now() : undefined };
        if (!await persist('task', 'update', task.id, () => DB.saveTask(updated))) return;
        setTasks(prev => prev.map(t => t.id === task.id ? updated : t));
        
        if (updated.isCompleted) {
            // Start Visual Loading State on the Item
            setProcessingTaskIds(prev => new Set(prev).add(task.id));
            try {
                await generateTaskReward(updated);
            } finally {
                // End Visual Loading State
                setProcessingTaskIds(prev => {
                    const next = new Set(prev);
                    next.delete(task.id);
                    return next;
                });
            }
        }
    };

    const handleDeleteTask = async (id: string) => {
        const task = tasks.find(t => t.id === id);
        const confirmed = await requestConfirm({
            title: '删除任务？',
            message: task ? `确定删除任务「${task.title}」吗？` : '确定删除这条任务吗？',
            confirmText: '删除',
            variant: 'danger',
        });
        if (!confirmed) return;
        if (!await persist('task', 'delete', id, () => DB.deleteTask(id))) return;
        setTasks(prev => prev.filter(t => t.id !== id));
    };

    const handleAddAnni = async () => {
        if (!newAnniTitle.trim() || !newAnniDate) return;
        const anni: Anniversary = {
            id: `anni-${Date.now()}`,
            title: newAnniTitle.trim(),
            date: newAnniDate,
            charId: newAnniChar || characters[0]?.id || ''
        };
        if (!await persist('anniversary', 'create', anni.id, () => DB.saveAnniversary(anni))) return;
        setAnniversaries(prev => [...prev, anni].sort((a, b) => a.date.localeCompare(b.date)));
        setShowAnniModal(false);
        setNewAnniTitle('');
        setNewAnniDate('');
        
        // Adding a date never generates a paid AI comment.
    };

    const handleDeleteAnni = async (id: string) => {
        const anni = anniversaries.find(a => a.id === id);
        const confirmed = await requestConfirm({
            title: '删除纪念日？',
            message: anni ? `确定删除纪念日「${anni.title}」吗？` : '确定删除这条纪念日吗？',
            confirmText: '删除',
            variant: 'danger',
        });
        if (!confirmed) return;
        deletedAnniversaries.current.add(id);
        if (!await persist('anniversary', 'delete', id, () => DB.deleteAnniversary(id))) { deletedAnniversaries.current.delete(id); return; }
        setAnniversaries(prev => prev.filter(a => a.id !== id));
    };

    // --- Render Helpers ---

    const getDaysUntil = (dateStr: string) => {
        return getCalendarDayDifference(localDateKey, dateStr) ?? Number.POSITIVE_INFINITY;
    };

    const upcomingAnni = useMemo(() => {
        return anniversaries.filter(a => getDaysUntil(a.date) >= 0).sort((a, b) => a.date.localeCompare(b.date))[0];
    }, [anniversaries, localDateKey]);

    return (
        <div className={`h-full w-full flex flex-col ${theme.font} ${theme.bg} ${theme.text} relative overflow-hidden transition-colors duration-500`}>
             
             {/* Tech Background Grid (Only for Cyber) */}
             {currentThemeMode === 'cyber' && (
                 <div className="absolute inset-0 pointer-events-none opacity-20" 
                      style={{ 
                          backgroundImage: 'linear-gradient(rgba(56, 189, 248, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(56, 189, 248, 0.1) 1px, transparent 1px)', 
                          backgroundSize: '40px 40px' 
                      }}>
                 </div>
             )}
             
             {/* Soft Background Pattern (Only for Soft) */}
             {currentThemeMode === 'soft' && (
                 <div className="absolute inset-0 pointer-events-none opacity-30" 
                      style={{ 
                          backgroundImage: 'radial-gradient(#fbcfe8 2px, transparent 2px)', 
                          backgroundSize: '20px 20px' 
                      }}>
                 </div>
             )}

             {/* Header */}
             <div className={`border-b ${theme.border} backdrop-blur-sm sticky top-0 z-20 shrink-0 relative transition-colors duration-300`} style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="pt-8 pb-3 px-4 flex items-center justify-between gap-2 min-h-20 box-border">
                <button onClick={closeApp} className={`p-2 -ml-2 rounded-full active:scale-90 transition-transform ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[4px_4px_8px_#d1d9e6,-4px_-4px_8px_#ffffff]' : 'hover:bg-black/5'}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={`w-6 h-6 ${theme.accent}`}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                </button>

                {/* Tabs */}
                <div className={`flex gap-1 p-1 rounded-lg ${currentThemeMode === 'cyber' ? 'bg-black/40 border border-cyan-900/50' : (currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : 'bg-white/50')}`}>
                    <button onClick={() => { setActiveTab('quest'); trackEvent('切换日程标签页', { tab: 'quest' }); }} className={`px-3 py-2.5 whitespace-nowrap rounded text-xs font-bold transition-all ${activeTab === 'quest' ? `${theme.accent} ${currentThemeMode === 'cyber' ? 'bg-cyan-900/50 shadow-sm' : (currentThemeMode === 'minimal' ? 'shadow-[2px_2px_5px_#d1d9e6,-2px_-2px_5px_#ffffff] bg-[#eef2f6]' : 'bg-white shadow-sm')}` : `${theme.textSub}`}`}>待办事项</button>
                    <button onClick={() => { setActiveTab('server_events'); trackEvent('切换日程标签页', { tab: 'server_events' }); }} className={`px-3 py-2.5 whitespace-nowrap rounded text-xs font-bold transition-all ${activeTab === 'server_events' ? `${theme.accent} ${currentThemeMode === 'cyber' ? 'bg-cyan-900/50 shadow-sm' : (currentThemeMode === 'minimal' ? 'shadow-[2px_2px_5px_#d1d9e6,-2px_-2px_5px_#ffffff] bg-[#eef2f6]' : 'bg-white shadow-sm')}` : `${theme.textSub}`}`}>纪念日</button>
                </div>

                {/* Right Actions */}
                <div className="flex gap-2">
                    <button onClick={() => openApp(ShortcutAppID.Appearance)} className="min-h-10 px-1 text-xs shrink-0" aria-label="外观设置">外观</button>

                    {/* Add Button */}
                    <button onClick={() => { activeTab === 'quest' ? setShowTaskModal(true) : setShowAnniModal(true); trackEvent('打开新建条目弹窗', { kind: activeTab }); }} className={`p-2 rounded-full active:scale-90 transition-transform ${theme.accent} ${currentThemeMode === 'minimal' ? 'shadow-[4px_4px_8px_#d1d9e6,-4px_-4px_8px_#ffffff]' : 'hover:bg-white/10'}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                    </button>
                </div>
                </div>

                {/* Decoration Line */}
                {currentThemeMode === 'cyber' && <div className="absolute bottom-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent"></div>}
            </div>

            {(generatingComment || processingTaskIds.size > 0) && <div role="status" aria-live="polite" className="relative z-20 shrink-0 mx-4 mt-3 rounded-xl border border-cyan-700 bg-slate-900 text-white px-4 py-3 flex items-center gap-3">
                <span aria-hidden className="h-4 w-4 shrink-0 rounded-full border-2 border-white border-t-transparent animate-spin" />
                <span className="text-sm">{generatingComment ? '正在调用 AI 生成纪念日留言…' : '正在调用 AI 生成完成评价…'}<small className="block mt-1 text-xs text-slate-300">正在使用 API 额度，请勿重复提交</small></span>
            </div>}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 space-y-6 z-10">
                
                {/* Hero Anniversary Card */}
                {activeTab === 'server_events' && upcomingAnni && (
                    <div className={`w-full rounded-2xl p-5 relative overflow-hidden group transition-all duration-300 ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[inset_5px_5px_10px_#d1d9e6,inset_-5px_-5px_10px_#ffffff]' : (currentThemeMode === 'soft' ? 'bg-gradient-to-r from-pink-300 to-purple-300 text-white shadow-lg shadow-pink-200' : 'bg-gradient-to-r from-slate-900 to-slate-800 border border-purple-500/30')}`}>
                        <div className="relative z-10">
                            <div className="flex justify-between items-start mb-2">
                                <div className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded ${currentThemeMode === 'minimal' ? 'text-slate-400' : 'text-white/80 bg-white/20'}`}>即将到来</div>
                                <div className="text-3xl font-bold tracking-tighter">{getDaysUntil(upcomingAnni.date)} <span className="text-xs opacity-60 font-normal">天后</span></div>
                            </div>
                            <div className="text-xl font-bold mb-4">{upcomingAnni.title}</div>
                            
                            {/* AI Thought Bubble */}
                            <div className={`flex items-start gap-3 p-3 rounded-xl ${currentThemeMode === 'minimal' ? 'bg-[#eef2f6] shadow-[5px_5px_10px_#d1d9e6,-5px_-5px_10px_#ffffff]' : 'bg-white/20 backdrop-blur-md'}`}>
                                <TokenImg value={characters.find(c => c.id === upcomingAnni.charId)?.avatar} className="w-8 h-8 rounded-full object-cover" />
                                <div className={`text-xs font-medium leading-relaxed italic ${currentThemeMode === 'minimal' ? 'text-slate-500' : 'text-white/90'}`}>
                                    "{splitInlineThinking(upcomingAnni.aiThought || "").content.trim() || "还没有纪念日感想"}"
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'quest' && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 mb-2 px-1">
                            <div className={`w-2 h-2 rounded-full animate-pulse ${currentThemeMode === 'cyber' ? 'bg-cyan-500' : (currentThemeMode === 'soft' ? 'bg-pink-400' : 'bg-slate-400')}`}></div>
                            <h3 className={`text-xs font-bold uppercase tracking-[0.2em] ${theme.accent}`}>进行中任务</h3>
                        </div>
                        
                        {tasks.filter(t => !t.isCompleted).length === 0 && (
                            <div className={`text-center py-12 border-2 border-dashed rounded-xl ${currentThemeMode === 'cyber' ? 'border-slate-800' : 'border-slate-200'}`}>
                                <div className={theme.textSub}>暂无任务</div>
                            </div>
                        )}

                        {tasks.filter(t => !t.isCompleted).map(task => {
                            const supervisor = characters.find(c => c.id === task.supervisorId);
                            const isProcessing = processingTaskIds.has(task.id);
                            
                            return (
                                <div key={task.id} className={`${theme.card} p-4 grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 group relative overflow-hidden transition-all duration-300`}>
                                    {/* Supervisor Icon */}
                                    <div className="w-10 h-10 rounded-full overflow-hidden shrink-0 relative border border-white/10">
                                        {supervisor ? <TokenImg value={supervisor.avatar} className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity" /> : <span className="text-xs">?</span>}
                                        <div className={`absolute -bottom-0 -right-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${currentThemeMode === 'soft' ? 'bg-white text-pink-500' : 'bg-black text-cyan-500'}`}>!</div>
                                    </div>
                                    
                                    <div className="flex-1 min-w-0">
                                        <div className={`${theme.text} font-bold text-sm tracking-wide break-words`}>{task.title}</div>
                                        <div className={`text-[10px] ${theme.textSub} mt-1 font-mono uppercase`}>
                                            监督人: {supervisor?.name || '未选择'}
                                            {task.deadline && <span className="block mt-1">日期：{task.deadline.slice(0, 10)}</span>}
                                        </div>
                                    </div>

                                    <div className="col-span-2 flex items-center justify-end gap-2">
                                    {/* Action Button Area */}
                                    {isProcessing ? (
                                        <div className="flex items-center gap-2 px-2 py-2">
                                            <div className={`w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin ${theme.accent}`}></div>
                                            <span className={`text-[10px] font-bold animate-pulse ${theme.accent}`}>验收中...</span>
                                        </div>
                                    ) : (
                                        <button 
                                            onClick={() => handleToggleTask(task)}
                                            className={`px-4 py-2 text-[10px] font-bold uppercase tracking-wider rounded transition-all active:scale-95 ${currentThemeMode === 'minimal' ? 'shadow-[4px_4px_8px_#d1d9e6,-4px_-4px_8px_#ffffff] text-slate-500 active:shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : (currentThemeMode === 'soft' ? 'bg-pink-100 text-pink-500' : 'bg-cyan-900/30 text-cyan-400 border border-cyan-800')}`}
                                        >
                                            完成
                                        </button>
                                    )}
                                    
                                    {androidAlarm && <button aria-label={`为待办 ${task.title} 设置系统闹钟`} onClick={() => setAlarmTarget({ title: task.title, date: task.deadline, kind: 'task' })} className="min-h-10 px-2 text-xs shrink-0">闹钟</button>}
                                    <button onClick={() => handleDeleteTask(task.id)} aria-label={`删除待办 ${task.title}`} className="shrink-0 min-h-10 px-2 text-xs opacity-75 hover:text-red-500">删除</button>
                                    </div>
                                </div>
                            );
                        })}

                        {tasks.filter(t => t.isCompleted).length > 0 && (
                            <div className="pt-6">
                                <h3 className={`text-xs font-bold uppercase tracking-[0.2em] px-1 mb-4 ${theme.textSub}`}>已完成</h3>
                                {tasks.filter(t => t.isCompleted).map(task => (
                                    <div key={task.id} className={`flex items-center gap-3 py-2 px-2 border-b ${currentThemeMode === 'cyber' ? 'border-slate-800/50' : 'border-slate-100'}`}>
                                        <div className={`${theme.iconDone} text-xs font-mono`}>[DONE]</div>
                                        <span className={`text-sm flex-1 min-w-0 break-words line-through ${theme.text}`}>{task.title}</span>
                                        <button onClick={() => handleDeleteTask(task.id)} aria-label={`删除已完成待办 ${task.title}`} className="shrink-0 min-h-10 px-2 opacity-75 hover:text-red-500 text-xs">删除</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'server_events' && (
                    <div className={`relative pl-4 space-y-6 border-l ${theme.border}`}>
                        {/* Anniversaries List */}
                        <div>
                             <h3 className={`text-xs font-bold uppercase tracking-widest mb-6 -ml-6 pl-6 ${theme.textSub}`}>纪念日</h3>
                             <div className="space-y-4">
                                 {!anniversaries.length && <p className="text-sm opacity-70 py-5">还没有纪念日，点右上角添加。</p>}
                                 {anniversaries.map(a => (
                                     <div key={a.id} className="relative group">
                                         <div className={`absolute -left-[20px] top-4 w-2 h-2 rounded-full z-10 ${currentThemeMode === 'cyber' ? 'bg-black border border-purple-500' : 'bg-pink-400'}`}></div>
                                         <div className={`${theme.card} p-4 flex flex-wrap gap-2 justify-between items-center transition-colors`}>
                                             <div className="min-w-0 basis-full break-words">
                                                 <div className={`text-sm font-bold ${theme.text}`}>{a.title}</div>
                                                 <div className={`text-[10px] ${theme.textSub} font-mono mt-1`}>{a.date} · {characters.find(c => c.id === a.charId)?.name}</div>
                                             </div>
                                             <button aria-label={`${a.aiThought?.trim() ? '重新生成' : '生成'}留言：${a.title}`} disabled={generatingComment !== null} onClick={() => void generateAnniversaryThought(a)} className="min-h-10 px-2 text-xs shrink-0 disabled:opacity-50">
                                                 {generatingComment === a.id ? '生成中…' : a.aiThought?.trim() ? '重新生成留言 · AI' : '生成留言 · AI'}
                                             </button>
                                             {androidAlarm && <button aria-label={`为纪念日 ${a.title} 设置系统闹钟`} onClick={() => setAlarmTarget({ title: a.title, date: a.date, kind: 'anniversary' })} className="min-h-10 px-2 text-xs shrink-0">闹钟</button>}
                                             <button onClick={() => handleDeleteAnni(a.id)} aria-label={`删除纪念日 ${a.title}`} className="shrink-0 min-h-10 px-2 text-xs opacity-75 hover:text-red-500">删除</button>
                                             <div className="basis-full min-w-0 text-xs leading-relaxed">
                                                 {a.aiThought?.trim() ? <p className="whitespace-pre-wrap break-words">{splitInlineThinking(a.aiThought).content.trim()}</p> : <p className="opacity-70">点「生成留言」才会调用 AI，消耗 API 额度。</p>}
                                                 {commentError?.id === a.id && <p role="alert" className="mt-2 text-red-500">{commentError.message}</p>}
                                             </div>
                                         </div>
                                     </div>
                                 ))}
                             </div>
                        </div>

                    </div>
                )}

            </div>

            {/* Task Modal */}
            <Modal isOpen={showTaskModal} title={currentThemeMode === 'cyber' ? "INITIALIZE QUEST" : "新建任务"} onClose={() => setShowTaskModal(false)} footer={<button onClick={handleAddTask} className={`w-full py-3 font-bold transition-all ${theme.buttonPrimary}`}>确认添加</button>}>
                <div className={`space-y-6 ${currentThemeMode === 'minimal' ? 'p-2' : ''}`}>
                    <input autoFocus value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)} placeholder="任务目标 (例如: 背单词)" className={`w-full px-4 py-3 text-sm focus:outline-none ${theme.input}`} />
                    <label className="block text-xs text-slate-600">日期（可选，设置后会显示在桌面日历）<input aria-label="待办日期" type="date" value={newTaskDate} onChange={e => setNewTaskDate(e.target.value)} className={`w-full mt-2 px-4 py-3 text-sm min-w-0 focus:outline-none ${theme.input}`} /></label>
                    
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block tracking-widest">选择监督人</label>
                        {/* 分组筛选（没建分组时不渲染）。Modal 恒为白底，走浅色配色 */}
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                            value={supervisorGroupId} onChange={setSupervisorGroupId} className="mb-2" />
                        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
                            {filterCharactersByGroup(characters, characterGroups, supervisorGroupId).map(c => (
                                <button key={c.id} onClick={() => setNewTaskSupervisor(c.id)} className={`flex flex-col items-center gap-2 p-2 rounded-lg border transition-all min-w-[60px] ${newTaskSupervisor === c.id ? `${currentThemeMode === 'minimal' ? 'shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : 'border-current'}` : 'border-transparent opacity-50'}`}>
                                    <TokenImg value={c.avatar} className="w-10 h-10 rounded-md object-cover" />
                                    <span className="text-[10px] font-bold whitespace-nowrap text-slate-700">{c.name}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </Modal>

            {/* Anniversary Modal */}
            <Modal isOpen={showAnniModal} title={currentThemeMode === 'cyber' ? "REGISTER EVENT" : "添加纪念日"} onClose={() => setShowAnniModal(false)} footer={<button onClick={handleAddAnni} className={`w-full py-3 font-bold transition-all ${theme.buttonPrimary}`}>保存记录</button>}>
                <div className={`space-y-4 ${currentThemeMode === 'minimal' ? 'p-2' : ''}`}>
                    <input value={newAnniTitle} onChange={e => setNewAnniTitle(e.target.value)} placeholder="事件名称 (例如: 第一次见面)" className={`w-full px-4 py-3 text-sm focus:outline-none ${theme.input}`} />
                    <input type="date" value={newAnniDate} onChange={e => setNewAnniDate(e.target.value)} className={`w-full px-4 py-3 text-sm focus:outline-none ${theme.input}`} />
                    
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase mb-2 block tracking-widest">关联对象</label>
                        {/* 分组筛选（没建分组时不渲染）。Modal 恒为白底，走浅色配色 */}
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                            value={anniCharGroupId} onChange={setAnniCharGroupId} className="mb-2" />
                        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
                            {filterCharactersByGroup(characters, characterGroups, anniCharGroupId).map(c => (
                                <button key={c.id} onClick={() => setNewAnniChar(c.id)} className={`flex flex-col items-center gap-2 p-2 rounded-lg border transition-all min-w-[60px] ${newAnniChar === c.id ? `${currentThemeMode === 'minimal' ? 'shadow-[inset_2px_2px_5px_#d1d9e6,inset_-2px_-2px_5px_#ffffff]' : 'border-current'}` : 'border-transparent opacity-50'}`}>
                                    <TokenImg value={c.avatar} className="w-10 h-10 rounded-md object-cover" />
                                    <span className="text-[10px] font-bold whitespace-nowrap text-slate-700">{c.name}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </Modal>
            <SystemAlarmDialog target={alarmTarget} onClose={() => setAlarmTarget(null)} onOpened={() => addToast('已交给系统时钟，请核对闹钟是否保存', 'info')} />
            {confirmDialog}
        </div>
    );
};

export default ScheduleApp;
import { useAppShortcut } from '../utils/appShortcutLaunch';
import { AppID as ShortcutAppID } from '../types';

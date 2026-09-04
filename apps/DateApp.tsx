
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, Message, DateState, AppID } from '../types';
import { DatePrompts, ApiMessage } from '../utils/datePrompts';
import { processNewMessagesWithAutoArchive } from '../utils/memoryPalace/autoArchive';
import type { PipelineResult } from '../utils/memoryPalace/pipeline';
import { incrementDigestRound, runCognitiveDigestion } from '../utils/memoryPalace';
import { getRoomLabel } from '../utils/memoryPalace/types';
import { safeResponseJson, extractContent } from '../utils/safeApi';
import Modal from '../components/os/Modal';
import TokenImg from '../components/os/TokenImg';
import DateSession from '../components/date/DateSession';
import DateSettings from '../components/date/DateSettings';
import { armDateResumeAttempt, clearDateResumeAttempt, takeCrashedDateResume } from '../utils/dateSessionRecovery';
import { BookOpen, Sparkle, CaretLeft, GearSix } from '@phosphor-icons/react';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trimHistoryThrough } from '../utils/dateSessionHistory';
import { trackEvent } from '../utils/analytics';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import StoryTheater from '../components/date/story/StoryTheater';
import { dateLaunch } from '../utils/dateLaunch';
import { materializeVisionDescriptions } from '../utils/visionApi';
import { shareOrDownloadFile } from '../utils/shareExport';
import { buildInPersonContinueInstruction } from '../utils/meetingContinue';
import {
    advanceSARModuleRuntime,
    createSARModuleSurfaceMeta,
    getSARModuleRuntimePlan,
    parseSARModuleReply,
} from '../utils/vrWorld/sarModuleRuntime';
import {
    buildDateHistoryGroups,
    formatDateHistoryDate,
    formatDateHistoryExport,
    formatDateHistoryTime,
    makeDateHistoryFileName,
    type DateHistoryGroup,
    type DateHistorySortOrder,
    type DateHistoryView,
} from '../utils/dateHistory';

const DateApp: React.FC = () => {
    const { closeApp, openApp, characters, activeCharacterId, setActiveCharacterId, apiConfig, addToast, updateCharacter, updateUserProfile, virtualTime, userProfile, memoryPalaceConfig, dateAutoStartCharId, consumeDateAutoStart, characterGroups, groups, realtimeConfig } = useOS();

    // 是否由聊天「见面」按钮进入：为真时，退出见面流程回到聊天而非见面选择页/桌面。
    // 用本地 state（而非 context）承载：DateApp 切走即卸载，标记随之消失，不会泄漏到
    // 之后从桌面直接打开的见面会话里。
    const [cameFromChat, setCameFromChat] = useState(false);
    const [meetSurface, setMeetSurface] = useState<'companion' | 'story'>(() => dateLaunch.peek()?.surface ?? 'companion');

    // 记忆宫殿（与聊天侧共用同一套上下文：同 charId、同高水位线）
    // 见面流也需要在 AI 回复后跑一次缓冲区检查 + 自动归档，否则只有"读"没有"写"。
    const [memoryPalaceStatus, setMemoryPalaceStatus] = useState<string>('');
    const [memoryPalaceResult, setMemoryPalaceResult] = useState<PipelineResult | null>(null);
    const memoryPalaceStatusRef = useRef(memoryPalaceStatus);
    memoryPalaceStatusRef.current = memoryPalaceStatus;

    // characters ref：见面 hook 跑完后用户可能已经在 MemoryPalaceApp 里关掉了宫殿，
    // 直接闭包里的 charForHook 是回复开始时捕获的，会读到 stale memoryPalaceEnabled=true。
    const charactersRef = useRef(characters);
    charactersRef.current = characters;
    
    // Modes: 'select' -> 'peek' -> 'session' | 'settings' | 'history'
    const [mode, setMode] = useState<'select' | 'peek' | 'session' | 'settings' | 'history'>('select');
    // Track previous mode for Settings back navigation
    const [previousMode, setPreviousMode] = useState<'select' | 'peek'>('select');

    // 全局更新弹窗等入口可直接落到「剧情」。peek 让首次渲染就显示目标页，
    // subscribe 则覆盖 DateApp 已经打开的情况；应用后立即消费，绝不污染下次普通打开。
    useEffect(() => {
        const applyLaunchIntent = (intent: { surface: 'companion' | 'story' }) => {
            setCameFromChat(false);
            setMode('select');
            setMeetSurface(intent.surface);
            dateLaunch.consume();
        };

        const initialIntent = dateLaunch.peek();
        if (initialIntent) applyLaunchIntent(initialIntent);
        return dateLaunch.subscribe(applyLaunchIntent);
    }, []);

    // 选择页分页（6 个角色一页，横向翻页）
    const SELECT_PAGE_SIZE = 6;
    const DATE_SESSION_MESSAGE_LIMIT = 220;
    const DATE_HISTORY_MESSAGE_LIMIT = 500;
    const pagerRef = useRef<HTMLDivElement>(null);
    const [selectPage, setSelectPage] = useState(0);
    const [selectGroupId, setSelectGroupId] = useState(GROUP_FILTER_ALL); // 选择页的分组筛选
    const onPagerScroll = () => {
        const el = pagerRef.current;
        if (!el || el.clientWidth === 0) return;
        const p = Math.round(el.scrollLeft / el.clientWidth);
        setSelectPage(prev => (prev === p ? prev : p));
    };
    const goSelectPage = (pi: number) => {
        const el = pagerRef.current;
        if (!el) return;
        el.scrollTo({ left: pi * el.clientWidth, behavior: 'smooth' });
    };

    const [peekStatus, setPeekStatus] = useState<string>('');
    const [peekLoading, setPeekLoading] = useState(false);
    
    // History State
    const [historyMessages, setHistoryMessages] = useState<Message[]>([]);
    const [historyView, setHistoryView] = useState<DateHistoryView>('encounter');
    const [historySortOrder, setHistorySortOrder] = useState<DateHistorySortOrder>('newest');
    const [historyLoadLimit, setHistoryLoadLimit] = useState(DATE_HISTORY_MESSAGE_LIMIT);
    const [historyReachedEnd, setHistoryReachedEnd] = useState(false);
    const [historyBusy, setHistoryBusy] = useState(false);
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
    // 阅读模式「加载更早」用：当前查询 limit 与「库里已经没有更早的了」。
    const [dateLoadLimit, setDateLoadLimit] = useState(DATE_SESSION_MESSAGE_LIMIT);
    const [dateHistoryReachedEnd, setDateHistoryReachedEnd] = useState(false);
    const [hasSavedOpening, setHasSavedOpening] = useState(false);

    // Edit Modal State
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [editTargetMsg, setEditTargetMsg] = useState<Message | null>(null);
    const [editContent, setEditContent] = useState('');

    const char = characters.find(c => c.id === activeCharacterId);
    const historyGroups = useMemo(
        () => buildDateHistoryGroups(historyMessages, historyView, historySortOrder),
        [historyMessages, historyView, historySortOrder],
    );

    // 见面消息和普通聊天共用同一份历史，也就是主动消息 2.0 云端快照（fire_pack）的素材。
    // 每次落库 / 删改后打一次脏：中途杀 App 时这一场见面就不会在云端整个丢掉，删改过的
    // 内容也不会被角色到点又提一遍。快照里的消息在上传时从 DB 重读，打脏本身很便宜。
    const markDateTurnDirty = (target = char) => {
        if (!target) return;
        markAmsgStateDirty({ char: target, userProfile, groups, realtimeConfig });
    };

    const getDateContextFetchLimit = (c: CharacterProfile) => Math.max(c.contextLimit || 500, DATE_SESSION_MESSAGE_LIMIT) + 32;
    const loadRecentDateMessages = async (charId: string, limit = DATE_SESSION_MESSAGE_LIMIT) => {
        return (await DB.getRecentMessagesByCharIdAndSource(charId, 'date', limit))
            .sort((a, b) => a.timestamp - b.timestamp);
    };

    // --- Data Loading ---
    const loadDateMessages = async (limit = dateLoadLimit) => {
        if (char) {
            // 见面记录只取最近窗口，不再把该角色全部聊天 getAll 进内存。
            // TODO(date-assets): 后续把角色立绘/背景本体迁到 assets store 后，这里还能再把 limit 放宽。
            const filtered = await loadRecentDateMessages(char.id, limit);
            setDateMessages(filtered);
            // 拿回来的比要的少 = 库里的见面记录已经取完，阅读模式不用再往前翻了。
            setDateHistoryReachedEnd(filtered.length < limit);
            
            // 检查数据库中是否已经包含当前的 peekStatus（通过内容比对），避免重复保存
            if (peekStatus && filtered.some(m => m.content === peekStatus && m.role === 'assistant')) {
                setHasSavedOpening(true);
            }
        }
    };

    useEffect(() => {
        if (char && mode === 'session') {
            // 进会话 / 换角色都从初始窗口重来。limit 必须显式传：setState 是异步的，
            // 靠 dateLoadLimit 闭包会读到上一个角色翻开的深度，和重置后的 state 对不上。
            setDateLoadLimit(DATE_SESSION_MESSAGE_LIMIT);
            setDateHistoryReachedEnd(false);
            loadDateMessages(DATE_SESSION_MESSAGE_LIMIT);
        }
    }, [char, mode]);


    /** 阅读模式要更早的记录：limit 递增重取（反向游标，limit 越大够得越远）。 */
    const handleLoadMoreDateHistory = async (nextLimit: number) => {
        setDateLoadLimit(nextLimit);
        await loadDateMessages(nextLimit);
    };

    // 见面「继续上次」崩溃自愈：若上次恢复会话时把 iOS WebKit 内容进程撑崩了
    // (表现为反复灰屏/白屏「此网页反复出现问题」，非可捕获的 JS 异常)，那份重快照
    // 的哨兵会残留到本次进见面。这里检出后丢弃有毒的 savedDateState（仅清恢复快照，
    // 消息历史不动），避免用户永久卡在闪退死循环里。只在 DateApp 挂载时跑一次。
    useEffect(() => {
        const crashedCharId = takeCrashedDateResume();
        if (!crashedCharId) return;
        const crashed = characters.find(c => c.id === crashedCharId);
        trackEvent('检出见面存档崩溃并清理', { 处理结果: crashed?.savedDateState ? '已清理存档' : '无存档可清' });
        if (crashed?.savedDateState) {
            updateCharacter(crashedCharId, { savedDateState: undefined });
            addToast('上次见面异常退出，已清理存档，可重新开始', 'info');
        }
    }, []); // 仅挂载时检查一次

    // --- Navigation Helpers ---
    const handleBack = () => {
        if (mode === 'peek') {
            // 来自聊天：从感知页退出直接回聊天，不落在见面选择页
            if (cameFromChat) { returnToChat(); return; }
            setMode('select');
            setPeekStatus('');
        } else if (mode === 'history') {
            setMode('select');
        } else closeApp();
    };

    const formatTime = () => `${virtualTime.hours.toString().padStart(2, '0')}:${virtualTime.minutes.toString().padStart(2, '0')}`;

    // peek / send / reroll 共用的 LLM 调用（提示词构建统一在 utils/datePrompts.ts）
    const callLLM = async (messages: ApiMessage[], temperature: number): Promise<string> => {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages,
                temperature,
                // max_tokens 是 Claude 原生 API 的必填字段；缺了它，糯米机/Csy 等
                // OpenAI→Claude 中转会被上游打回，再包成 502 / bad_response_status_code。
                // 与私聊 (useChatAI.ts) 对齐，统一带 8000。
                max_tokens: 8000,
                stream: apiConfig.stream ?? false,
            })
        });
        if (!response.ok) throw new Error(`API Error ${response.status}`);
        const data = await safeResponseJson(response);
        // 思考型渠道会把正文塞进 reasoning_content、content 留空——直接取 content
        // 会拿到空串且不报错：感知页黑屏卡死（无按钮可退），会话里则落库空消息。
        const content = extractContent(data);
        if (!content) throw new Error('模型返回了空回复，请重试或检查渠道/模型设置');
        return content;
    };

    // --- Resume / Start Logic ---
    const handleCharClick = (c: CharacterProfile) => {
        if (c.savedDateState) {
            setPendingSessionChar(c);
        } else {
            startPeek(c);
        }
    };

    // 从聊天「见面」按钮跳进来：等同于在选择页点击该角色（有存档则弹继续/新开，否则直接感知）
    // 并记住「来自聊天」，退出见面时回到聊天。
    useEffect(() => {
        if (!dateAutoStartCharId) return;
        const target = characters.find(c => c.id === dateAutoStartCharId);
        consumeDateAutoStart();
        setCameFromChat(true);
        setMeetSurface('companion');
        if (target) handleCharClick(target);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dateAutoStartCharId]);

    // 退出见面流程：来自聊天则回聊天，否则回见面选择页/桌面（由调用方决定）
    const returnToChat = () => {
        setCameFromChat(false);
        openApp(AppID.Chat);
    };

    const handleResumeSession = () => {
        if (!pendingSessionChar) return;
        // 恢复尝试开始前先武装崩溃哨兵：若这份重快照在 iOS 上把内容进程撑崩，
        // 哨兵会残留到下次进见面被检出并清理（见挂载时的自愈 effect）。
        armDateResumeAttempt(pendingSessionChar.id);
        setActiveCharacterId(pendingSessionChar.id);
        setMode('session');
        setPendingSessionChar(null);
        addToast('已恢复上次进度', 'success');
        trackEvent('选择见面存档处理方式', { choice: 'resume' });
        trackEvent('恢复上次见面进度');
    };

    const handleStartNewSession = () => {
        if (!pendingSessionChar) return;
        // 新会话没有恢复快照可重放，撤销任何残留哨兵。
        clearDateResumeAttempt();
        updateCharacter(pendingSessionChar.id, { savedDateState: undefined });
        trackEvent('选择见面存档处理方式', { choice: 'new' });
        trackEvent('见面存档选重新开始');
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
                // 落库失败不能静默：开场白进不了 DB，阅读模式/见面记录会缺这次开场，
                // 表现和「阅读模式播旧剧情」一样，让用户知道出了什么事
                addToast('开场白保存失败，本次开场可能不会出现在阅读模式', 'error');
            }
        }

        // 2. 切换模式并刷新数据
        setMode('session');
        trackEvent('走过去开始见面会话');
        await loadDateMessages(DATE_SESSION_MESSAGE_LIMIT);
    };

    // --- Peek (Generation) Logic ---
    const startPeek = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        setMode('peek');
        setPeekLoading(true);
        setPeekStatus('');
        setHasSavedOpening(false);
        trackEvent('进入见面感知页');

        try {
            const msgs = await DB.getRecentMessagesByCharId(c.id, getDateContextFetchLimit(c), true);
            const preparedMsgs = await materializeVisionDescriptions(msgs, apiConfig.visionApi);
            const emojis = await DB.getEmojis();
            const { messages } = DatePrompts.buildPeekPayload({
                char: c,
                userProfile,
                allMsgs: preparedMsgs,
                emojis,
                useVisionDescriptions: apiConfig.visionApi?.enabled === true,
            });
            const content = await callLLM(messages, apiConfig.temperature ?? 0.85);
            setPeekStatus(content);

        } catch (e: any) {
            setPeekStatus(`(无法感知状态: ${e.message})`);
        } finally {
            setPeekLoading(false);
        }
    };

    // 与聊天侧 useChatAI 完全一致的 Memory Palace 后台流程：
    // 触发缓冲区处理 + 自动归档（如开启） + 50 轮认知消化。
    const runMemoryPalacePostHook = useCallback(async (charForHook: CharacterProfile) => {
        // 用 charactersRef 读最新状态，避免见面流程中用户去 MemoryPalaceApp 关掉宫殿后
        // 这里仍然按 charForHook 闭包里的旧 enabled 触发一次 LLM 总结
        const liveBefore = charactersRef.current.find(c => c.id === charForHook.id) || null;
        if (!liveBefore?.memoryPalaceEnabled) return;
        const mpEmb = memoryPalaceConfig?.embedding;
        const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
        const mpLLM = (mpLLMConfigured?.baseUrl)
            ? mpLLMConfigured
            : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
        if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM.baseUrl) return;

        const recentMsgs = await DB.getRecentMessagesByCharId(charForHook.id, 50);
        try {
            const pipelineResult = await processNewMessagesWithAutoArchive(
                recentMsgs,
                charForHook.id,
                charForHook.name,
                mpEmb,
                mpLLM,
                userProfile?.name || '',
                false,
                (stage) => setMemoryPalaceStatus(stage),
            );

            // pipeline 跑的过程中用户可能又关了宫殿，再 check 一次
            const liveAfter = charactersRef.current.find(c => c.id === charForHook.id) || null;
            if (!liveAfter?.memoryPalaceEnabled) return;

            if (pipelineResult && pipelineResult.stored > 0) {
                setMemoryPalaceResult(pipelineResult);
            }

            // 50 轮自动认知消化（与聊天侧共享计数器，按 charId 持久化）
            const shouldAutoDigest = incrementDigestRound(charForHook.id);
            if (shouldAutoDigest) {
                setMemoryPalaceStatus(`${charForHook.name}闭上眼睛，开始整理内心…`);
                const persona = [liveAfter.systemPrompt || '', liveAfter.worldview || ''].filter(Boolean).join('\n');
                await runCognitiveDigestion(charForHook.id, charForHook.name, persona, mpLLM, false, userProfile?.name, mpEmb);
            }
        } catch (e: any) {
            console.error('❌ [DateApp MemoryPalace] 后台处理异常:', e?.message || e);
            addToast('记忆整理失败', 'error');
        } finally {
            const current = memoryPalaceStatusRef.current;
            if (current && current.includes('完成')) {
                addToast(current, 'success');
            }
            setMemoryPalaceStatus('');
        }
    }, [memoryPalaceConfig, apiConfig, userProfile?.name, updateCharacter, addToast]);

    // --- Session API Logic ---
    const handleSendMessage = async (text: string, kind?: 'continue'): Promise<string> => {
        if (!char) throw new Error("No char");
        const sarModulePlan = getSARModuleRuntimePlan(char, userProfile);

        // 重发场景：如果 DB 里最后一条已经是这条 user 消息（上一轮发送后 API 失败 / 网络抖动等），
        // 就跳过重复落库，直接走 API。与 chat app 行为对齐，让用户按发送键即可重新触发 LLM。
        const recentCheck = await DB.getRecentMessagesByCharIdAndSource(char.id, 'date', 1);
        const isRetry = recentCheck.length > 0
            && recentCheck[0].role === 'user'
            && recentCheck[0].content === text
            && recentCheck[0].metadata?.source === 'date';
        // API 中断后的重试只会带回显示文本；从已落库标记恢复“继续”的完整语义。
        const isContinueTurn = kind === 'continue'
            || (isRetry && recentCheck[0].metadata?.meetingContinue === true);

        let userMessageId = isRetry ? recentCheck[0]?.id : undefined;
        if (!isRetry) {
            // 1. Save User Msg
            userMessageId = await DB.saveMessage({
                charId: char.id,
                role: 'user',
                type: 'text',
                content: text,
                metadata: { source: 'date', ...(isContinueTurn ? { meetingContinue: true } : {}) },
            });
            markDateTurnDirty(char);
        }

        // 2. Prepare Context
        // Re-fetch messages. Since we saved the opening in handleEnterSession,
        // 'allMsgs' will now correctly contain: [History..., Opening, UserMsg]
        const allMsgs = await DB.getRecentMessagesByCharId(char.id, getDateContextFetchLimit(char), true);
        const preparedAllMsgs = await materializeVisionDescriptions(allMsgs, apiConfig.visionApi);

        // Update local state for display
        setDateMessages(await loadRecentDateMessages(char.id));

        const emojis = await DB.getEmojis();
        const modelText = isContinueTurn
            ? buildInPersonContinueInstruction(userProfile?.name, char.name)
            : text;
        const { messages } = await DatePrompts.buildSessionPayload({
            char,
            userProfile,
            allMsgs: preparedAllMsgs,
            emojis,
            userText: modelText,
            variant: 'send',
            useVisionDescriptions: apiConfig.visionApi?.enabled === true,
        });
        const rawContent = await callLLM(messages, apiConfig.temperature ?? 0.85);
        const parsed = parseSARModuleReply(rawContent, sarModulePlan);
        if (sarModulePlan.user?.phase === 'active' && parsed.userSurface && userMessageId) {
            const surface = createSARModuleSurfaceMeta(sarModulePlan.user, parsed.userSurface);
            if (surface) await DB.updateMessageMetadata(userMessageId, previous => ({ ...(previous || {}), sarModuleSurface: surface }));
        }
        const assistantSurface = sarModulePlan.character?.phase === 'active' && parsed.assistantSurface
            ? createSARModuleSurfaceMeta(sarModulePlan.character, parsed.assistantSurface)
            : undefined;

        // 3. Save AI Response
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: parsed.canonical, metadata: { source: 'date', ...(assistantSurface ? { sarModuleSurface: assistantSurface } : {}) } });
        if (sarModulePlan.character) {
            const next = advanceSARModuleRuntime(sarModulePlan.character);
            updateCharacter(char.id, previous => ({
                vrState: { ...(previous.vrState || { enabled: false, intervalMinutes: 120 }), sarModule: next },
            }));
        }
        if (sarModulePlan.user) {
            const next = advanceSARModuleRuntime(sarModulePlan.user);
            updateUserProfile(previous => ({
                vrState: { ...(previous.vrState || { enabled: false }), sarModule: next },
            }));
        }
        markDateTurnDirty(char);

        // Refresh local state
        setDateMessages(await loadRecentDateMessages(char.id));

        // Memory Palace 后台流程（不阻塞返回，与聊天侧一致）
        runMemoryPalacePostHook(char);

        return parsed.assistantSurface || parsed.canonical;
    };

    const handleReroll = async (): Promise<string> => {
        if (!char || dateMessages.length === 0) throw new Error("No context");

        const lastMsg = dateMessages[dateMessages.length - 1];
        if (lastMsg.role !== 'assistant') throw new Error("Cannot reroll user message");

        // Keep the old reply until the replacement request succeeds.
        const allMsgs = await DB.getRecentMessagesByCharId(char.id, getDateContextFetchLimit(char), true);
        const validMsgs = allMsgs.filter(m => m.id !== lastMsg.id);
        const preparedValidMsgs = await materializeVisionDescriptions(validMsgs, apiConfig.visionApi);
        const emojis = await DB.getEmojis();

        // 重掷的是开场白（isOpening 锚点消息）：走感知同款 payload 重新生成开场。
        // 不能走下面的普通 reroll 路径——开场白前面没有触发它的 user 消息。旧逻辑会
        // 先删消息再报 "Context lost"（开场白被吞），即使上一条恰好是 user 侥幸续上，
        // 新消息也不带 isOpening，阅读模式会从上一次见面的开场开始切片，表现为
        // 「新见面只有立绘模式是新剧情，阅读模式全是旧剧情」。
        if (lastMsg.metadata?.isOpening === true) {
            const { messages } = DatePrompts.buildPeekPayload({
                char,
                userProfile,
                allMsgs: preparedValidMsgs,
                emojis,
                useVisionDescriptions: apiConfig.visionApi?.enabled === true,
            });
            const content = await callLLM(messages, Math.max(apiConfig.temperature ?? 0.85, 0.9));
            // 生成成功后才动库：先删旧开场、再带 isOpening 落新开场，请求失败时原剧情不丢
            await DB.deleteMessage(lastMsg.id);
            await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content, metadata: { source: 'date', isOpening: true } });
            markDateTurnDirty(char);
            trackEvent('重掷见面回复', { 目标: '开场白' });
            // 阅读模式空会话时顶部渲染的开场 & 退出快照里的 peekStatus 同步成新开场
            setPeekStatus(content);

            const freshMsgs = await DB.getMessagesByCharId(char.id, true);
            setDateMessages(freshMsgs.filter(m => m.metadata?.source === 'date').sort((a,b) => a.timestamp - b.timestamp));
            return content;
        }

        const validDateMsgs = preparedValidMsgs.filter(m => m.metadata?.source === 'date');
        const lastUserMsg = validDateMsgs[validDateMsgs.length - 1];
        if (!lastUserMsg || lastUserMsg.role !== 'user') throw new Error("Context lost");

        // Call API logic（与 handleSendMessage 共用 buildSessionPayload，只差 variant）
        // 历史裁到被重掷的那一轮为止：见面回复之后用户又在普通聊天里发过消息时，
        // validMsgs（全来源）的尾巴不是这条 date user，直接传进去会把那条聊天消息当成
        // 「待重发的最后一条」砍掉，同时 date user 又被追加一次（丢一条、重一条）。
        const { messages } = await DatePrompts.buildSessionPayload({
            char,
            userProfile,
            allMsgs: trimHistoryThrough(preparedValidMsgs, lastUserMsg.id),
            emojis,
            userText: lastUserMsg.content,
            variant: 'reroll',
            useVisionDescriptions: apiConfig.visionApi?.enabled === true,
        });
        // Reroll 略调高温度求多样性，但绝不低于用户配置的基线。
        const rawContent = await callLLM(messages, Math.max(apiConfig.temperature ?? 0.85, 0.9));
        const sarPlan = getSARModuleRuntimePlan(char, userProfile);
        const parsed = parseSARModuleReply(rawContent, sarPlan);
        if (sarPlan.user?.phase === 'active' && parsed.userSurface) {
            const userSurface = createSARModuleSurfaceMeta(sarPlan.user, parsed.userSurface);
            if (userSurface) await DB.updateMessageMetadata(lastUserMsg.id, previous => ({ ...(previous || {}), sarModuleSurface: userSurface }));
        }
        const assistantSurface = sarPlan.character?.phase === 'active' && parsed.assistantSurface
            ? createSARModuleSurfaceMeta(sarPlan.character, parsed.assistantSurface)
            : undefined;

        // 生成成功后才删旧回复：以前先删后调 API，请求一失败上一条剧情就永久消失
        await DB.deleteMessage(lastMsg.id);
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: parsed.canonical, metadata: { source: 'date', ...(assistantSurface ? { sarModuleSurface: assistantSurface } : {}) } });
        markDateTurnDirty(char);
        trackEvent('重掷见面回复', { 目标: '回复' });

        // Sync
        setDateMessages(await loadRecentDateMessages(char.id));

        // Memory Palace 后台流程（Reroll 也算一轮新输出）
        runMemoryPalacePostHook(char);

        return parsed.assistantSurface || parsed.canonical;
    };

    // --- Editing & Deletion ---
    // 删改同样要打脏（对齐 Chat.tsx 的同款处理器）：云端快照里带着最近对话原文，
    // 不刷的话角色到点还会提起这条已经被删掉 / 已经改过的消息。
    const handleDeleteMessage = async (msg: Message) => {
        await DB.deleteMessage(msg.id);
        setDateMessages(prev => prev.filter(m => m.id !== msg.id));
        markDateTurnDirty();
        trackEvent('删除一条见面消息');
    };

    const handleDeleteMessages = async (ids: number[]) => {
        if (ids.length === 0) return;
        await Promise.all(ids.map(id => DB.deleteMessage(id)));
        setDateMessages(prev => prev.filter(m => !ids.includes(m.id)));
        markDateTurnDirty();
        addToast(`已删除 ${ids.length} 条记录`, 'success');
        trackEvent('批量删除见面消息');
    };

    const confirmEditMessage = async () => {
        if (!editTargetMsg) return;
        await DB.updateMessage(editTargetMsg.id, editContent);
        setDateMessages(prev => prev.map(m => m.id === editTargetMsg.id ? { ...m, content: editContent } : m));
        markDateTurnDirty();
        setIsEditModalOpen(false);
        setEditTargetMsg(null);
        addToast('已修改', 'success');
        trackEvent('编辑一条见面消息');
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
        setHistoryMessages(prev => prev.filter(m => m.id !== msg.id));
        markDateTurnDirty();
        setHistoryMenuMsg(null);
        addToast('已删除', 'success');
        trackEvent('删除见面记录里的一条消息');
    };

    const handleHistoryEditOpen = (msg: Message) => {
        setHistoryEditMsg(msg);
        setHistoryEditContent(msg.content);
        setHistoryMenuMsg(null);
    };

    const handleHistoryEditConfirm = async () => {
        if (!historyEditMsg) return;
        await DB.updateMessage(historyEditMsg.id, historyEditContent);
        setHistoryMessages(prev => prev.map(m => (
            m.id === historyEditMsg.id ? { ...m, content: historyEditContent } : m
        )));
        markDateTurnDirty();
        setHistoryEditMsg(null);
        addToast('已修改', 'success');
        trackEvent('编辑见面记录里的一条消息');
    };

    const onExitSession = (finalState: DateState) => {
        // 用户主动保存并退出 = 干净退出，撤销恢复哨兵。
        clearDateResumeAttempt();
        if (char) {
            updateCharacter(char.id, { savedDateState: finalState });
            addToast('进度已保存', 'success');
        }
        // 来自聊天：退出见面回聊天
        if (cameFromChat) { returnToChat(); return; }
        setMode('select');
        setPeekStatus('');
        setHasSavedOpening(false);
    };

    // 从选择页直接进设置（不用先进见面再点菜单），改完立绘/观测等即时生效
    const openSettings = (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        setPreviousMode('select');
        setMode('settings');
        trackEvent('打开见面设置面板', { from: 'select' });
    };

    const openHistory = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        // 见面历史按 source=date 独立读取，不受聊天侧记忆宫殿高水位影响。
        const msgs = await DB.getRecentMessagesByCharIdAndSource(c.id, 'date', DATE_HISTORY_MESSAGE_LIMIT);
        setHistoryMessages(msgs);
        setHistoryView('encounter');
        setHistorySortOrder('newest');
        setHistoryLoadLimit(DATE_HISTORY_MESSAGE_LIMIT);
        setHistoryReachedEnd(msgs.length < DATE_HISTORY_MESSAGE_LIMIT);
        setMode('history');
        trackEvent('打开见面记录');
    };

    const handleLoadMoreHistory = async () => {
        if (!char || historyBusy || historyReachedEnd) return;
        const nextLimit = historyLoadLimit + DATE_HISTORY_MESSAGE_LIMIT;
        setHistoryBusy(true);
        try {
            const msgs = await DB.getRecentMessagesByCharIdAndSource(char.id, 'date', nextLimit);
            setHistoryMessages(msgs);
            setHistoryLoadLimit(nextLimit);
            setHistoryReachedEnd(msgs.length < nextLimit);
        } catch (error) {
            console.error('Load Earlier Date History Error', error);
            addToast('更早的见面记录加载失败', 'error');
        } finally {
            setHistoryBusy(false);
        }
    };

    const exportHistoryGroups = async (groups: DateHistoryGroup[], scope: string) => {
        if (!char || groups.length === 0 || historyBusy) return;
        setHistoryBusy(true);
        try {
            const result = await shareOrDownloadFile({
                content: formatDateHistoryExport(char.name, groups, historyView),
                fileName: makeDateHistoryFileName(char.name, scope),
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: `${char.name}的见面记录`,
            });
            addToast(result === 'shared' ? '已打开分享面板' : '见面记录已导出', 'success');
            trackEvent('导出见面记录', { 范围: scope, 整理方式: historyView === 'encounter' ? '按次' : '按日期' });
        } catch (error) {
            console.error('Export Date History Error', error);
            addToast('见面记录导出失败', 'error');
        } finally {
            setHistoryBusy(false);
        }
    };

    const handleExportAllHistory = async () => {
        if (!char || historyBusy) return;
        setHistoryBusy(true);
        try {
            // 导出属于用户主动操作，可以完整扫描该角色消息索引；只收集 source=date，避免把图片聊天读进内存。
            const allDateMessages = await DB.getRecentMessagesByCharIdAndSource(char.id, 'date', Number.MAX_SAFE_INTEGER);
            const allGroups = buildDateHistoryGroups(allDateMessages, historyView, historySortOrder);
            if (allGroups.length === 0) {
                addToast('暂无可导出的见面记录', 'info');
                return;
            }
            const result = await shareOrDownloadFile({
                content: formatDateHistoryExport(char.name, allGroups, historyView),
                fileName: makeDateHistoryFileName(char.name, `全部_${historyView === 'encounter' ? '按次' : '按日期'}`),
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: `${char.name}的全部见面记录`,
            });
            addToast(result === 'shared' ? '已打开分享面板' : '全部见面记录已导出', 'success');
            trackEvent('导出全部见面记录', { 整理方式: historyView === 'encounter' ? '按次' : '按日期' });
        } catch (error) {
            console.error('Export All Date History Error', error);
            addToast('全部见面记录导出失败', 'error');
        } finally {
            setHistoryBusy(false);
        }
    };

    // --- Render ---

    if (meetSurface === 'story' && mode === 'select' && !cameFromChat) {
        return <StoryTheater onSwitchCompanion={() => setMeetSurface('companion')} onClose={closeApp} />;
    }

    if (mode === 'select' || !char) {
        // 6 个角色一页，横向翻页（先按分组筛选，再切页）
        const selectChars = filterCharactersByGroup(characters, characterGroups, selectGroupId);
        const pages: CharacterProfile[][] = [];
        for (let i = 0; i < selectChars.length; i += SELECT_PAGE_SIZE) pages.push(selectChars.slice(i, i + SELECT_PAGE_SIZE));
        if (pages.length === 0) pages.push([]);
        // 浅色主题（参考「小屋 · 小小窝」房间）：薰衣草浅背景 + 柔星点 + 衬线标题 + 罗盘环角色卡
        const th = {
            pageBg: 'linear-gradient(180deg,#efe9f7 0%,#f4eff9 45%,#f7f2fb 100%)',
            stars: 'radial-gradient(1.5px 1.5px at 14% 16%,rgba(190,160,225,.45),transparent),radial-gradient(1px 1px at 80% 12%,rgba(220,190,235,.5),transparent),radial-gradient(1.5px 1.5px at 42% 28%,rgba(180,200,240,.4),transparent),radial-gradient(1px 1px at 86% 42%,rgba(200,175,230,.4),transparent),radial-gradient(1px 1px at 22% 66%,rgba(210,185,235,.35),transparent),radial-gradient(1px 1px at 66% 80%,rgba(200,210,240,.35),transparent)',
            title: '#6a5790', titleShadow: 'rgba(170,150,220,.4)', line: 'rgba(150,120,190,.5)',
            cardBorder: 'rgba(170,140,210,.3)', cardShadow: '0 8px 22px rgba(150,120,200,.18)',
            inner: 'rgba(170,140,210,.22)', gem: 'rgba(190,160,220,.85)',
            tick: 'rgba(170,140,210,.16)', halo: 'rgba(200,175,235,.3)',
            ring1: 'rgba(180,150,215,.5)', ring2: 'rgba(180,150,215,.25)', avGlow: 'rgba(190,160,235,.4)',
        };
        // 每张卡片按序循环的柔色底——粉/薰衣草/浅蓝渐变（同小小窝浅色卡）
        const CARD_TINTS = [
            'linear-gradient(180deg,rgba(250,212,228,.85),rgba(242,228,246,.8))',
            'linear-gradient(180deg,rgba(232,228,248,.85),rgba(242,238,250,.8))',
            'linear-gradient(180deg,rgba(226,216,246,.85),rgba(238,230,249,.8))',
            'linear-gradient(180deg,rgba(212,230,247,.85),rgba(234,240,250,.8))',
            'linear-gradient(180deg,rgba(226,212,245,.85),rgba(238,228,249,.8))',
            'linear-gradient(180deg,rgba(234,231,242,.88),rgba(242,240,247,.82))',
        ];
        return (
            <div className="h-full w-full relative overflow-hidden flex flex-col font-light" style={{ background: th.pageBg }}>
                {/* 柔星点氛围 */}
                <div className="absolute inset-0 pointer-events-none opacity-70" style={{ backgroundImage: th.stars }} />

                {/* 顶栏 + 标题 */}
                <div className="relative z-10 shrink-0" style={{ paddingTop: 'max(1.25rem, var(--safe-top))' }}>
                    <div className="relative flex items-center justify-center px-5 pt-2">
                        <button onClick={() => { if (cameFromChat) { returnToChat(); } else { closeApp(); } }}
                                className="absolute left-4 w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-all"
                                style={{ color: '#8f7bb5', background: 'rgba(255,255,255,0.6)', boxShadow: '0 2px 8px rgba(150,120,200,0.15)' }}>
                            <CaretLeft size={19} weight="bold" />
                        </button>
                        <div className="text-center">
                            <h1 className="text-[26px] tracking-[0.14em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: th.title, textShadow: `0 2px 18px ${th.titleShadow}` }}>选择见面对象</h1>
                            <div className="flex items-center justify-center gap-2 mt-1.5">
                                <span className="h-px w-10" style={{ background: `linear-gradient(90deg,transparent,${th.line})` }} />
                                <span className="text-[9px] tracking-[0.4em] font-bold" style={{ color: 'rgba(150,120,190,0.75)' }}>✦ CHOOSE CHARACTER ✦</span>
                                <span className="h-px w-10" style={{ background: `linear-gradient(270deg,transparent,${th.line})` }} />
                            </div>
                        </div>
                    </div>
                    <div className='mx-auto mt-4 mb-3 grid w-[min(18rem,calc(100%-2.5rem))] grid-cols-2 rounded-xl bg-white/45 p-1 shadow-sm'>
                        <button className='rounded-lg bg-white py-2 text-xs font-bold text-[#715d99] shadow-sm'>陪伴</button>
                        <button onClick={() => setMeetSurface('story')} className='rounded-lg py-2 text-xs font-bold text-[#8f7bb5]'>剧情</button>
                    </div>
                    {/* 分组筛选（没建分组时不渲染）。切组后回到第一页 */}
                    <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark
                        value={selectGroupId}
                        onChange={(id) => { setSelectGroupId(id); setSelectPage(0); pagerRef.current?.scrollTo({ left: 0 }); }}
                        className="px-4 mb-3" />
                </div>

                {/* 分页卡片区 */}
                {selectChars.length === 0 ? (
                    <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-3" style={{ color: 'rgba(150,120,190,0.7)' }}>
                        <Sparkle size={40} weight="light" />
                        <span className="text-xs tracking-wider">{characters.length ? '该分组下没有角色' : '还没有可见面的角色'}</span>
                    </div>
                ) : (
                    <div ref={pagerRef} onScroll={onPagerScroll}
                         className="relative z-10 flex-1 min-h-0 flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
                         style={{ scrollSnapType: 'x mandatory' }}>
                        {pages.map((page, pi) => (
                            <div key={pi} className="w-full shrink-0 snap-start h-full overflow-y-auto no-scrollbar px-5 pt-4">
                                <div className="grid grid-cols-2 gap-4 pb-6">
                                    {page.map((c, idx) => {
                                        const tint = CARD_TINTS[(pi * SELECT_PAGE_SIZE + idx) % CARD_TINTS.length];
                                        return (
                                        <div key={c.id} onClick={() => handleCharClick(c)}
                                             className="group relative rounded-2xl px-3 pt-8 pb-5 flex flex-col items-center active:scale-95 transition-all overflow-hidden"
                                             style={{ background: tint, border: `1px solid ${th.cardBorder}`, boxShadow: th.cardShadow }}>
                                            {/* 内描框 + 四角宝石 */}
                                            <div className="absolute inset-[7px] rounded-xl pointer-events-none" style={{ border: `1px solid ${th.inner}` }} />
                                            <span className="absolute top-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            <span className="absolute top-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            <span className="absolute bottom-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            <span className="absolute bottom-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                            {/* 在线徽标 */}
                                            <div className="absolute top-2.5 left-2.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full z-10"
                                                 style={{ background: 'rgba(255,255,255,0.8)', border: '1px solid rgba(120,200,160,0.4)', boxShadow: '0 1px 4px rgba(120,90,170,0.12)' }}>
                                                <span className="relative flex h-1.5 w-1.5">
                                                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
                                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                                                </span>
                                                <span className="text-[8px] font-bold text-emerald-600 tracking-wider">在线</span>
                                            </div>
                                            {/* 设置 / 记录（竖排） */}
                                            <div className="absolute top-2 right-2 flex flex-col gap-1 z-20">
                                                <button onClick={(e) => { e.stopPropagation(); openSettings(c); }} title="布置场景 / 设定立绘 / 观测"
                                                        className="w-7 h-7 rounded-lg text-purple-500 flex items-center justify-center active:scale-90 transition-all"
                                                        style={{ background: 'rgba(255,255,255,0.88)', boxShadow: '0 1px 5px rgba(120,90,170,0.2)' }}>
                                                    <GearSix size={15} weight="fill" />
                                                </button>
                                                <button onClick={(e) => { e.stopPropagation(); openHistory(c); }} title="见面记录"
                                                        className="w-7 h-7 rounded-lg text-purple-500 flex items-center justify-center active:scale-90 transition-all"
                                                        style={{ background: 'rgba(255,255,255,0.88)', boxShadow: '0 1px 5px rgba(120,90,170,0.2)' }}>
                                                    <BookOpen size={15} weight="fill" />
                                                </button>
                                            </div>
                                            {/* 头像 + 罗盘环 + 双层环 + 光晕 */}
                                            <div className="relative w-[92px] h-[92px] flex items-center justify-center mt-1">
                                                <div className="absolute w-[124px] h-[124px] rounded-full" style={{ background: `repeating-conic-gradient(from 0deg, ${th.tick} 0deg 2.4deg, transparent 2.4deg 9deg)`, WebkitMaskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)', maskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)' }} />
                                                <div className="absolute w-[110px] h-[110px] rounded-full" style={{ background: `radial-gradient(circle, ${th.halo}, transparent 62%)` }} />
                                                <div className="absolute inset-[8px] rounded-full" style={{ border: `1px solid ${th.ring1}` }} />
                                                <div className="absolute inset-[12px] rounded-full" style={{ border: `1px solid ${th.ring2}` }} />
                                                <div className="w-[70px] h-[70px] rounded-full overflow-hidden" style={{ boxShadow: `0 0 18px ${th.avGlow}` }}>
                                                    <TokenImg value={c.avatar} className="w-full h-full object-cover" alt={c.name} />
                                                </div>
                                                {c.savedDateState && (
                                                    <div title="有存档" className="absolute bottom-0 right-1.5 w-[22px] h-[22px] rounded-full flex items-center justify-center" style={{ background: '#fbbf24', boxShadow: '0 1px 5px rgba(180,120,20,0.4)' }}>
                                                        <Sparkle size={12} weight="fill" className="text-white" />
                                                    </div>
                                                )}
                                            </div>
                                            {/* 名字 + 简介 */}
                                            <span className="mt-3 text-[14px] font-semibold tracking-wide truncate max-w-full" style={{ color: '#4b3b6b', fontFamily: `'Noto Serif SC',serif` }}>{c.name}</span>
                                            <span className="mt-0.5 text-[10px] truncate max-w-full" style={{ color: c.description ? 'rgba(120,95,160,0.78)' : 'rgba(150,130,185,0.6)' }}>{c.description || '走过去见 ta'}</span>
                                        </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* 页码点 */}
                {pages.length > 1 && (
                    <div className="relative z-10 shrink-0 flex justify-center items-center gap-2 py-3">
                        {pages.map((_, pi) => (
                            <button key={pi} onClick={() => goSelectPage(pi)} aria-label={`第 ${pi + 1} 页`}
                                    className="h-2 rounded-full transition-all"
                                    style={{ width: pi === selectPage ? 24 : 8, background: pi === selectPage ? '#a78bd6' : 'rgba(170,140,210,0.35)' }} />
                        ))}
                    </div>
                )}

                <Modal isOpen={!!pendingSessionChar} title="发现进度" onClose={() => { setPendingSessionChar(null); if (cameFromChat) returnToChat(); }} footer={<div className="flex gap-3 w-full"><button onClick={handleStartNewSession} className="flex-1 py-3 bg-slate-100 rounded-2xl text-slate-600 font-bold">新的见面</button><button onClick={handleResumeSession} className="flex-1 py-3 bg-green-500 text-white rounded-2xl font-bold shadow-lg shadow-green-200">继续上次</button></div>}>
                    <div className="text-center text-slate-500 text-sm py-4">检测到 {pendingSessionChar?.name} 有未结束的见面。<br/><span className="text-xs text-slate-400 mt-2 block">(存档时间: {pendingSessionChar?.savedDateState?.timestamp ? new Date(pendingSessionChar.savedDateState.timestamp).toLocaleString() : 'Unknown'})</span></div>
                </Modal>
            </div>
        );
    }

    if (mode === 'history') {
        return (
            <div className="h-full w-full bg-slate-50 flex flex-col font-light" onClick={() => historyMenuMsg && setHistoryMenuMsg(null)}>
                <div className="border-b border-slate-200 bg-white sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="h-16 flex items-center justify-between px-4">
                        <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-slate-100"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                        <div className="text-center min-w-0">
                            <div className="font-bold text-slate-700">见面记录</div>
                            <div className="text-[10px] text-slate-400 truncate max-w-36">{char.name}</div>
                        </div>
                        <button
                            onClick={(event) => { event.stopPropagation(); handleExportAllHistory(); }}
                            disabled={historyBusy || historyMessages.length === 0}
                            className="text-xs font-bold text-blue-500 px-2 py-2 -mr-2 rounded-lg hover:bg-blue-50 disabled:opacity-40"
                        >
                            导出全部
                        </button>
                    </div>
                    <div className="px-4 pb-3 flex items-center gap-2">
                        <div className="flex-1 p-1 rounded-xl bg-slate-100 flex">
                            <button
                                onClick={() => setHistoryView('encounter')}
                                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${historyView === 'encounter' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}
                            >按次</button>
                            <button
                                onClick={() => setHistoryView('date')}
                                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${historyView === 'date' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}
                            >按日期</button>
                        </div>
                        <button
                            onClick={() => setHistorySortOrder(order => order === 'newest' ? 'oldest' : 'newest')}
                            className="h-9 px-3 rounded-xl border border-slate-200 bg-white text-[11px] font-bold text-slate-500 whitespace-nowrap"
                            title="切换排序方向"
                        >
                            {historySortOrder === 'newest' ? '新 → 旧' : '旧 → 新'}
                        </button>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-6 pb-20">
                    {historyGroups.length === 0 ? <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-2"><BookOpen size={48} className="opacity-50" /><span className="text-xs">暂无见面记录</span></div> : historyGroups.map((group) => (
                        <div key={group.id} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                            <div className="bg-slate-50 px-4 py-3 border-b border-slate-100 flex gap-3 justify-between items-center">
                                <div className="min-w-0">
                                    <div className="text-xs font-bold text-slate-600 tracking-wide truncate">
                                        {historyView === 'encounter' ? formatDateHistoryTime(group.startAt, true) : formatDateHistoryDate(group.startAt)}
                                    </div>
                                    <div className="text-[10px] text-slate-400 mt-1">
                                        {historyView === 'encounter'
                                            ? (group.hasOpeningAnchor ? '一次完整见面' : '旧记录 · 按日期兼容整理')
                                            : (group.encounterCount > 0 ? `${group.encounterCount} 次开场` : '旧记录')}
                                        {' · '}{group.messages.length} 句
                                    </div>
                                </div>
                                <button
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        exportHistoryGroups([group], `${historyView === 'encounter' ? '本次' : '当天'}_${group.dateKey}`);
                                    }}
                                    disabled={historyBusy}
                                    className="shrink-0 text-[11px] font-bold text-blue-500 bg-blue-50 px-3 py-1.5 rounded-full disabled:opacity-40"
                                >导出{historyView === 'encounter' ? '本次' : '当天'}</button>
                            </div>
                            <div className="p-4 space-y-4">
                                {group.messages.map(m => {
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
                                            <div className="text-[9px] text-slate-300 mt-1 px-1">{formatDateHistoryTime(m.timestamp)}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                    {!historyReachedEnd && historyMessages.length > 0 && (
                        <button
                            onClick={handleLoadMoreHistory}
                            disabled={historyBusy}
                            className="w-full py-3 rounded-2xl border border-slate-200 bg-white text-xs font-bold text-slate-500 disabled:opacity-50"
                        >
                            {historyBusy ? '正在加载…' : '加载更早的见面记录'}
                        </button>
                    )}
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
                                 <button onClick={() => { trackEvent('重新感知一次角色状态'); startPeek(char); }} className="w-14 h-14 bg-neutral-800 text-white rounded-full flex items-center justify-center border border-neutral-700 shadow-lg active:scale-90 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg></button>
                             </div>
                             <div className="flex flex-col items-center gap-3 text-[10px] text-neutral-600 font-medium tracking-wider"><button onClick={() => { setPreviousMode('peek'); setMode('settings'); trackEvent('打开见面设置面板', { from: 'peek' }); }} className="hover:text-neutral-400 transition-colors">布置场景 / 设定立绘</button><button onClick={handleBack} className="hover:text-neutral-400 transition-colors">悄悄离开</button></div>
                        </div>
                    </div>
                )}
                {/* 兜底：感知结束但 peekStatus 为空（历史上模型空回复会走到这）——
                    以前这里什么都不渲染，页面只剩角色名的纯黑屏，连退出按钮都没有 */}
                {!peekLoading && !peekStatus && (
                    <div className="flex-1 flex flex-col items-center justify-center gap-8 -mt-20 z-10 animate-fade-in">
                        <p className="text-sm font-light text-neutral-500 italic tracking-widest">未能感知到 {char.name} 的状态</p>
                        <button onClick={() => { trackEvent('重新感知一次角色状态'); startPeek(char); }} className="h-12 px-10 bg-white text-black rounded-full font-bold tracking-[0.1em] text-sm active:scale-95 transition-transform hover:bg-neutral-200">重新感知</button>
                        <button onClick={handleBack} className="text-[10px] text-neutral-600 font-medium tracking-wider hover:text-neutral-400 transition-colors">悄悄离开</button>
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
                    onLoadMoreHistory={handleLoadMoreDateHistory}
                    historyLoadLimit={dateLoadLimit}
                    historyReachedEnd={dateHistoryReachedEnd}
                />

                {/* 记忆整理中 — 顶部浮动胶囊（与聊天侧外观一致） */}
                {memoryPalaceStatus && (
                    <div
                        className="absolute top-[76px] left-1/2 z-[150] animate-fade-in"
                        style={{ transform: 'translateX(-50%)', pointerEvents: 'none', willChange: 'transform, opacity' }}
                    >
                        <div
                            className="flex items-center gap-2.5 pl-2.5 pr-3.5 py-2 max-w-[18rem]"
                            style={{
                                background: 'rgba(255,255,255,0.88)',
                                borderRadius: 999,
                                border: '1px solid rgba(99,102,241,0.18)',
                                boxShadow: '0 6px 18px -6px rgba(15,23,42,0.22)',
                            }}
                        >
                            <span
                                className="shrink-0 inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-200 animate-spin"
                                style={{ borderTopColor: '#6366f1', animationDuration: '0.9s' }}
                            />
                            <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                                {char.name}正在沉思
                            </span>
                            <span className="text-[10px] text-slate-400 truncate">{memoryPalaceStatus}</span>
                        </div>
                    </div>
                )}

                {/* 记忆整理结果 — 弹窗 */}
                {memoryPalaceResult && (
                    <div
                        className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                        style={{ pointerEvents: 'all', background: 'rgba(15,23,42,0.55)' }}
                        onClick={() => setMemoryPalaceResult(null)}
                    >
                        <div
                            className="w-full max-w-sm max-h-[82vh] overflow-hidden flex flex-col relative"
                            style={{
                                background: 'linear-gradient(160deg, #ffffff 0%, #f8fafc 100%)',
                                borderRadius: 28,
                                border: '1px solid rgba(148,163,184,0.18)',
                                boxShadow: '0 20px 50px -20px rgba(15,23,42,0.35)',
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div
                                className="absolute top-0 left-0 right-0 h-[2px] pointer-events-none"
                                style={{ background: 'linear-gradient(90deg, transparent, #6366f1, #a5b4fc, #6366f1, transparent)' }}
                            />
                            <div className="px-6 pt-7 pb-4 text-center">
                                <div
                                    className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3"
                                    style={{
                                        background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(129,140,248,0.06))',
                                        border: '1px solid rgba(99,102,241,0.15)',
                                    }}
                                >
                                    <span style={{ fontSize: 26 }}>🗂️</span>
                                </div>
                                <div className="text-[10px] tracking-[0.25em] uppercase font-semibold" style={{ color: '#6366f1' }}>Memory Palace</div>
                                <p className="text-[17px] font-bold mt-1" style={{ color: '#0f172a' }}>记忆整理完成</p>
                                <p className="text-[11px] text-slate-400 mt-1">
                                    新增 {memoryPalaceResult.stored} 条 · 去重跳过 {memoryPalaceResult.skipped} 条
                                    {memoryPalaceResult.batches.length > 1 && ` · ${memoryPalaceResult.batches.length} 批`}
                                </p>
                                {memoryPalaceResult.batches.some(b => !b.ok) && (
                                    <p className="text-[10px] text-red-500 mt-1">
                                        {memoryPalaceResult.batches.filter(b => !b.ok).map(b => `第 ${b.index} 批失败`).join(', ')}
                                    </p>
                                )}
                            </div>
                            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-2 no-scrollbar">
                                {memoryPalaceResult.memories.map((m, i) => {
                                    const roomMeta: Record<string, { label: string; color: string }> = {
                                        living_room: { label: '客厅', color: '#f59e0b' },
                                        bedroom: { label: '卧室', color: '#8b5cf6' },
                                        study: { label: '书房', color: '#0ea5e9' },
                                        user_room: { label: '用户房间', color: '#ec4899' },
                                        self_room: { label: '自我房间', color: '#10b981' },
                                        attic: { label: '阁楼', color: '#6366f1' },
                                        windowsill: { label: '窗台', color: '#14b8a6' },
                                    };
                                    const meta = roomMeta[m.room] || { label: m.room, color: '#64748b' };
                                    const roomLabel = getRoomLabel(m.room as any, userProfile?.name) || meta.label;
                                    return (
                                        <div
                                            key={i}
                                            className="p-3 rounded-2xl"
                                            style={{
                                                background: 'rgba(255,255,255,0.75)',
                                                border: `1px solid ${meta.color}22`,
                                                boxShadow: `0 2px 8px ${meta.color}14, inset 0 1px 0 rgba(255,255,255,0.8)`,
                                            }}
                                        >
                                            <div className="flex items-center gap-2 mb-1.5">
                                                <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                                                    style={{ background: `${meta.color}18`, color: meta.color }}
                                                >
                                                    {roomLabel}
                                                </span>
                                                <span className="text-[10px] text-slate-400">{m.mood}</span>
                                                <span className="text-[10px] font-bold ml-auto" style={{ color: '#f59e0b' }}>{'★'.repeat(Math.min(m.importance, 5))}</span>
                                            </div>
                                            <p className="text-[12px] text-slate-700 leading-relaxed">{m.content}</p>
                                            {m.tags.length > 0 && (
                                                <div className="flex gap-1 mt-2 flex-wrap">
                                                    {m.tags.map((t, j) => (
                                                        <span key={j} className="text-[9px] px-1.5 py-0.5 rounded-full"
                                                            style={{ background: 'rgba(148,163,184,0.15)', color: '#64748b' }}
                                                        >{t}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {memoryPalaceResult.memories.length === 0 && (
                                    <p className="text-center text-xs text-slate-400 py-4">本次未提取到新记忆</p>
                                )}
                            </div>
                            <div className="px-6 pb-6 pt-2">
                                <button
                                    onClick={() => setMemoryPalaceResult(null)}
                                    className="w-full py-3 text-white text-[13px] font-bold rounded-2xl active:scale-[0.98] transition-transform"
                                    style={{
                                        background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                                        boxShadow: '0 6px 18px -6px rgba(79,70,229,0.5)',
                                    }}
                                >
                                    确认
                                </button>
                            </div>
                        </div>
                    </div>
                )}

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

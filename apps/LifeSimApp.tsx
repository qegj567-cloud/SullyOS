/**
 * LifeSimApp — 都市模拟人生 · 2026现代版
 * 核心体验：看角色操控都市居民，制造都市Drama，离线回来发现整栋楼翻天覆地
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import {
    LifeSimState, SimAction, SimActionType, SimEventType,
    CharacterProfile, SimNPC,
} from '../types';
import {
    createNewLifeSimState, createNPC, applyAddNPC,
    applyTriggerEvent, settlePendingEffects, advanceTurn, checkGameOver,
    getChaosLabel, deepClone, migrateLifeSimState, advanceTimeOfDay,
    getTodayFestival, SEASON_INFO, TIME_INFO, WEATHER_INFO,
} from '../utils/lifeSimEngine';
import {
    buildCharTurnSystemPrompt, formatRecentChatForSim, buildUserActionDescription, CharDecision, normalizeCharDecision,
    buildWorldDramaPlannerPrompt, normalizeWorldDramaDecision, buildFallbackWorldDramaDecision,
} from '../utils/lifeSimPrompts';
import { materializeStoryAttachments } from '../utils/lifeSimStoryAttachments';
import { createLifeSimResetCardData } from '../utils/lifeSimChatCard';
import { buildFallbackLifeSimSessionSummary, buildLifeSimSessionSummaryPrompt } from '../utils/lifeSimSessionSummary';
import { getLifeSimToneEmoji } from '../utils/lifeSimTone';
// Offline simulation removed — random events didn't match the theme
import { extractJson, safeFetchJson } from '../utils/safeApi';
import { DB } from '../utils/db';
import {
    Buildings, ArrowCounterClockwise, Gear, Star, Hourglass,
    MaskHappy, UserPlus, Eye, UsersThree, MaskSad, HeartHalf, Lightning,
} from '@phosphor-icons/react';

// Twemoji helper: converts an emoji string to a Twemoji CDN <img> tag
const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
function emojiToCodepoint(emoji: string): string {
    const codepoints: string[] = [];
    for (const cp of emoji) {
        const hex = cp.codePointAt(0)?.toString(16);
        if (hex && hex !== 'fe0f') codepoints.push(hex);
    }
    return codepoints.join('-');
}
function TwemojiImg({ emoji, size = 16, className = '' }: { emoji: string; size?: number; className?: string }) {
    const cp = emojiToCodepoint(emoji);
    return <img src={`${TWEMOJI_BASE}/${cp}.png`} alt={emoji} width={size} height={size} className={`inline-block ${className}`} style={{ verticalAlign: 'middle' }} draggable={false} />;
}

// 子组件
import WorldMap from './lifesim/WorldMap';
import NPCGrid from './lifesim/NPCGrid';
import DramaFeed from './lifesim/DramaFeed';
import RelationsTab from './lifesim/RelationsTab';
import ActionPanel, { StirAction, AddNpcAction } from './lifesim/ActionPanel';
import NarrativeReplayOverlay from './lifesim/ReplayOverlay';
// OfflineRecapOverlay removed
import GameOverOverlay from './lifesim/GameOverOverlay';
import LifeSimSettingsPanel from './lifesim/LifeSimSettingsPanel';
import NPCEditorPanel from './lifesim/NPCEditorPanel';
import ResetCityDialog from './lifesim/ResetCityDialog';

// ── 常量 ────────────────────────────────────────────────────────

const CHAR_TURN_COUNT_RANGE = [1, 3] as const;
const MAIN_PLOT_WATCH_CHANCE = 0.45;
const genId = () => Math.random().toString(36).slice(2, 10);

// ── API调用 ──────────────────────────────────────────────────────

const AI_MAX_RETRIES = 2;

async function callCharAI(
    apiConfig: { baseUrl: string; apiKey: string; model: string },
    systemPrompt: string
): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
        try {
            const data = await safeFetchJson(
                `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: [{ role: 'user', content: systemPrompt }],
                        temperature: 0.85, max_tokens: 8192, stream: false,
                        response_format: { type: 'json_object' },
                    }),
                }
            );
            return data?.choices?.[0]?.message?.content?.trim() || '';
        } catch (e: any) {
            const isNetwork = e?.name === 'AbortError' || e?.message?.includes('fetch') || e?.message?.includes('network') || e?.message?.includes('aborted');
            lastError = e;

            if (isNetwork && attempt < AI_MAX_RETRIES) {
                const delay = (attempt + 1) * 2000;
                console.warn(`[LifeSim] AI请求失败(第${attempt + 1}次)，${delay / 1000}s后重试…`, e?.message);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw lastError;
        }
    }
    throw lastError || new Error('AI请求失败');
}

// ── 主组件 ──────────────────────────────────────────────────────

const LifeSimApp: React.FC = () => {
    const { apiConfig, apiPresets, characters, userProfile, closeApp } = useOS();

    const [gameState, setGameState] = useState<LifeSimState | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [showReplay, setShowReplay] = useState(false);
    const [replayIndex, setReplayIndex] = useState(0);
    const [processingMsg, setProcessingMsg] = useState('');
    const [showGameOver, setShowGameOver] = useState(false);
    const [festivalAnnounce, setFestivalAnnounce] = useState<string>('');
    const [showSettings, setShowSettings] = useState(false);
    const [showResetDialog, setShowResetDialog] = useState(false);
    const [editingNpc, setEditingNpc] = useState<SimNPC | null>(null);
    const [isResetting, setIsResetting] = useState(false);

    const [activeTab, setActiveTab] = useState<'npcs'|'drama'|'relations'>('npcs');
    const [actionPanel, setActionPanel] = useState<'none'|'stir'|'add'>('none');

    // ── 初始化 ──────────────────────────────────────────────────

    useEffect(() => {
        async function init() {
            setIsLoading(true);
            try {
                let saved = await DB.getLifeSimState();
                if (saved) {
                    saved = migrateLifeSimState(saved);
                    if (saved.isProcessingCharTurn) {
                        saved.isProcessingCharTurn = false;
                        saved.currentActorId = 'user';
                        saved.charQueue = [];
                    }
                    if (saved.replayPending && saved.replayPending.length > 0) {
                        saved.replayPending = [];
                    }

                    saved.lastActiveTimestamp = Date.now();
                    await DB.saveLifeSimState(saved);
                    setGameState(saved);
                } else {
                    const newState = createNewLifeSimState();
                    newState.lastActiveTimestamp = Date.now();
                    setGameState(newState);
                    await DB.saveLifeSimState(newState);
                }
            } finally {
                setIsLoading(false);
            }
        }
        init();
    }, []);

    const saveState = useCallback(async (s: LifeSimState) => {
        s.lastActiveTimestamp = Date.now();
        setGameState(s);
        await DB.saveLifeSimState(s);
    }, []);

    const resolveParticipantCharIds = useCallback((state: LifeSimState | null) => {
        const allIds = characters.filter(char => !!char.id).map(char => char.id);
        if (!state || state.participantCharIds === undefined) return allIds;
        const validIds = new Set(allIds);
        return state.participantCharIds.filter(id => validIds.has(id));
    }, [characters]);

    const getParticipatingCharacters = useCallback((state: LifeSimState | null) => {
        const allowedIds = new Set(resolveParticipantCharIds(state));
        return characters.filter(char => !!char.id && allowedIds.has(char.id));
    }, [characters, resolveParticipantCharIds]);

    const resolveLifeSimApiConfig = useCallback((state: LifeSimState | null | undefined) => {
        if (!state?.useIndependentApiConfig) return apiConfig;
        const override = state.independentApiConfig || {};
        return {
            ...apiConfig,
            baseUrl: override.baseUrl?.trim() || apiConfig.baseUrl,
            apiKey: override.apiKey?.trim() || apiConfig.apiKey,
            model: override.model?.trim() || apiConfig.model,
        };
    }, [apiConfig]);

    const buildMainPlotAction = useCallback(async (state: LifeSimState) => {
        if (!userProfile) return null;

        setProcessingMsg('主线编剧室正在加戏...');
        const fallback = buildFallbackWorldDramaDecision(state);
        const resolvedApiConfig = resolveLifeSimApiConfig(state);

        try {
            let decision = fallback;
            const canUseApi = !!(resolvedApiConfig?.baseUrl && resolvedApiConfig?.apiKey && resolvedApiConfig?.model);

            if (canUseApi) {
                const raw = await callCharAI(
                    { baseUrl: resolvedApiConfig.baseUrl, apiKey: resolvedApiConfig.apiKey, model: resolvedApiConfig.model },
                    buildWorldDramaPlannerPrompt(userProfile, state, state.actionLog)
                );
                let rawJson = extractJson(raw);
                if (Array.isArray(rawJson)) rawJson = rawJson[0];
                const normalized = normalizeWorldDramaDecision(rawJson);
                decision = {
                    ...fallback,
                    ...normalized,
                    attachments: normalized.attachments.length > 0 ? normalized.attachments : fallback.attachments,
                };
            }

            const involvedNpcIds = decision.involvedNpcIds
                .filter(id => state.npcs.some(npc => npc.id === id))
                .slice(0, 4);
            const fallbackNpcIds = fallback.involvedNpcIds.slice(0, 4);
            const finalNpcIds = involvedNpcIds.length > 0 ? involvedNpcIds : fallbackNpcIds;
            const actionResult = applyTriggerEvent(
                state,
                decision.eventType,
                finalNpcIds,
                decision.eventDescription || fallback.eventDescription
            );

            const mainPlotAction: SimAction = {
                id: genId(),
                turnNumber: state.turnNumber,
                actor: '主线编剧室',
                actorAvatar: '🎬',
                actorId: 'story',
                type: 'TRIGGER_EVENT',
                headline: decision.headline || fallback.headline,
                description: decision.eventDescription || fallback.eventDescription,
                immediateResult: decision.immediateResult || actionResult.immediateResult,
                narrative: decision.narrative || fallback.narrative,
                reasoning: decision.narrative?.innerThought || fallback.narrative.innerThought,
                storyKind: 'main_plot',
                involvedNpcIds: finalNpcIds,
                attachments: materializeStoryAttachments(decision.attachments.length > 0 ? decision.attachments : fallback.attachments),
                timestamp: Date.now(),
            };

            return {
                newState: {
                    ...actionResult.newState,
                    actionLog: [...actionResult.newState.actionLog, mainPlotAction],
                },
                mainPlotAction,
            };
        } finally {
            setProcessingMsg('');
        }
    }, [resolveLifeSimApiConfig, userProfile]);

    // ── 结束回合 ────────────────────────────────────────────────

    const endTurn = useCallback(async () => {
        if (!gameState) return;

        // 1. 推进时间
        const { newState: s1, events, festival } = advanceTimeOfDay(gameState);
        let s = deepClone(s1);
        for (const ev of events) {
            const sysAction: SimAction = {
                id: genId(), turnNumber: s.turnNumber,
                actor: '时光', actorAvatar: '', actorId: 'system',
                type: 'DO_NOTHING', description: ev, immediateResult: ev, timestamp: Date.now(),
            };
            s.actionLog = [...s.actionLog, sysAction];
        }

        if (festival) {
            setFestivalAnnounce(`${festival.name}：${festival.description}`);
            setTimeout(() => setFestivalAnnounce(''), 4000);
        }

        // 2. NPC自主行为

        // 3. 结算待处理效果
        const settled = settlePendingEffects(s);
        s = settled.newState;
        for (const ev of settled.events) {
            const sysAction: SimAction = {
                id: genId(), turnNumber: s.turnNumber,
                actor: '连锁', actorAvatar: '', actorId: 'system',
                type: 'TRIGGER_EVENT', description: ev, immediateResult: ev, timestamp: Date.now(),
            };
            s.actionLog = [...s.actionLog, sysAction];
        }

        // 4. 检查游戏结束
        const { over, reason } = checkGameOver(s);
        if (over) {
            s.gameOver = true; s.gameOverReason = reason;
            await saveState(s); setShowGameOver(true); return;
        }

        // 5. 决定CHAR回合
        const participantIds = new Set(resolveParticipantCharIds(gameState));
        const availableChars = characters.filter(c => c.id && participantIds.has(c.id));
        const charCount = Math.floor(
            Math.random() * (CHAR_TURN_COUNT_RANGE[1] - CHAR_TURN_COUNT_RANGE[0] + 1)
        ) + CHAR_TURN_COUNT_RANGE[0];
        const shuffled = [...availableChars].sort(() => Math.random() - 0.5);
        const charQueue = shuffled.slice(0, charCount).map(c => c.id);
        s.charQueue = charQueue;
        s.currentActorId = charQueue[0] || 'user';
        s = advanceTurn(s);

        await saveState(s);
        setActionPanel('none');

        if (charQueue.length > 0) await runCharTurns(s);
    }, [gameState, characters, resolveParticipantCharIds, saveState]);

    const finalizeTurn = useCallback(async (
        baseState: LifeSimState,
        options?: {
            replaySeed?: SimAction[];
            skipCharTurns?: boolean;
            captureNonCharReplay?: boolean;
        }
    ) => {
        const replayActions: SimAction[] = [...(options?.replaySeed || [])];
        const captureReplay = !!options?.captureNonCharReplay;
        const pushReplay = (action: SimAction) => {
            if (captureReplay) replayActions.push(action);
        };

        const { newState: s1, events, festival } = advanceTimeOfDay(baseState);
        let s = deepClone(s1);

        for (const ev of events) {
            const sysAction: SimAction = {
                id: genId(), turnNumber: s.turnNumber,
                actor: '时光', actorAvatar: '', actorId: 'system',
                type: 'DO_NOTHING', description: ev, immediateResult: ev, storyKind: 'system', timestamp: Date.now(),
            };
            s.actionLog = [...s.actionLog, sysAction];
            pushReplay(sysAction);
        }

        if (festival) {
            setFestivalAnnounce(`${festival.name}：${festival.description}`);
            setTimeout(() => setFestivalAnnounce(''), 4000);
        }


        const settled = settlePendingEffects(s);
        s = settled.newState;
        for (const ev of settled.events) {
            const sysAction: SimAction = {
                id: genId(), turnNumber: s.turnNumber,
                actor: '连锁', actorAvatar: '', actorId: 'system',
                type: 'TRIGGER_EVENT', description: ev, immediateResult: ev, storyKind: 'system', timestamp: Date.now(),
            };
            s.actionLog = [...s.actionLog, sysAction];
            pushReplay(sysAction);
        }

        const { over, reason } = checkGameOver(s);
        if (over) {
            s.gameOver = true;
            s.gameOverReason = reason;
            s.replayPending = replayActions;
            await saveState(s);
            setActionPanel('none');
            if (replayActions.length > 0) { setShowReplay(true); setReplayIndex(0); }
            setShowGameOver(true);
            return { state: s, replayActions, shouldRunCharTurns: false };
        }

        if (options?.skipCharTurns) {
            s.charQueue = [];
            s.currentActorId = 'user';
            s = advanceTurn(s);
            s.replayPending = replayActions;
            await saveState(s);
            setActionPanel('none');
            if (replayActions.length > 0) { setShowReplay(true); setReplayIndex(0); }
            return { state: s, replayActions, shouldRunCharTurns: false };
        }

        const participantIds = new Set(resolveParticipantCharIds(baseState));
        const availableChars = characters.filter(c => c.id && participantIds.has(c.id));
        const charCount = Math.floor(
            Math.random() * (CHAR_TURN_COUNT_RANGE[1] - CHAR_TURN_COUNT_RANGE[0] + 1)
        ) + CHAR_TURN_COUNT_RANGE[0];
        const shuffled = [...availableChars].sort(() => Math.random() - 0.5);
        const charQueue = shuffled.slice(0, charCount).map(c => c.id);
        s.charQueue = charQueue;
        s.currentActorId = charQueue[0] || 'user';
        s = advanceTurn(s);

        if (charQueue.length === 0) {
            s.replayPending = replayActions;
            await saveState(s);
            setActionPanel('none');
            if (replayActions.length > 0) { setShowReplay(true); setReplayIndex(0); }
            return { state: s, replayActions, shouldRunCharTurns: false };
        }

        await saveState(s);
        setActionPanel('none');
        return { state: s, replayActions, shouldRunCharTurns: true };
    }, [characters, resolveParticipantCharIds, saveState]);

    // ── CHAR回合引擎 ──────────────────────────────────────────

    const runCharTurns = useCallback(async (initialState: LifeSimState, seededReplayActions: SimAction[] = []) => {
        if (!userProfile) return;
        let s = deepClone(initialState);
        const replayActions: SimAction[] = [...seededReplayActions];
        const resolvedApiConfig = resolveLifeSimApiConfig(initialState);
        const canUseApi = !!(resolvedApiConfig?.baseUrl && resolvedApiConfig?.apiKey && resolvedApiConfig?.model);

        for (const charId of s.charQueue) {
            const char = characters.find(c => c.id === charId);
            if (!char) continue;
            s.isProcessingCharTurn = true; s.currentActorId = charId;
            setProcessingMsg(`${char.name} 正在思考……`);
            await saveState(s);

            try {
                let rawJson: any = null;
                let decision: CharDecision;

                if (canUseApi) {
                    const rawMessages = await DB.getRecentMessagesByCharId(charId, 20);
                    const chatHistory = formatRecentChatForSim(
                        rawMessages as any, char.name, userProfile.name || '你', 20
                    );
                    const systemPrompt = buildCharTurnSystemPrompt(char, userProfile, chatHistory, s, s.actionLog);
                    const raw = await callCharAI(
                        { baseUrl: resolvedApiConfig.baseUrl, apiKey: resolvedApiConfig.apiKey, model: resolvedApiConfig.model },
                        systemPrompt
                    );

                    rawJson = extractJson(raw);
                    if (Array.isArray(rawJson)) rawJson = rawJson[0];
                    decision = normalizeCharDecision(rawJson);

                    // 调试日志：查看每回合LLM的原始输出和解析结果
                    console.group(`[LifeSim] ${char.name} 的回合 (Turn ${s.turnNumber})`);
                    console.log('LLM原始输出:', raw);
                    console.log('extractJson结果:', rawJson);
                    console.log('normalize后决策:', JSON.stringify(decision, null, 2));
                    if (!rawJson) console.warn('JSON解析失败！LLM输出无法解析为JSON');
                    if (decision.action.type === 'DO_NOTHING' && rawJson?.type && rawJson.type !== 'DO_NOTHING')
                        console.warn('action type被fallback为DO_NOTHING，原始type:', rawJson.type);
                    console.groupEnd();
                } else {
                    decision = {
                        action: { type: 'DO_NOTHING' },
                        narrative: {
                            innerThought: `${char.name}决定先嗑着瓜子围观一轮，看看局面会不会自己炸开。`,
                            dialogue: '',
                            commentOnWorld: '没接上外部AI的时候，这座城也会自己慢慢酝酿戏剧。',
                            emotionalTone: 'amused',
                        },
                        reactionToUser: '你先继续折腾，我在旁边看戏。',
                    };
                }
                const actionResult = executeCharDecision(s, decision, char);
                s = actionResult.newState;

                const action: SimAction = {
                    id: genId(), turnNumber: s.turnNumber,
                    actor: char.name, actorAvatar: char.avatar, actorId: char.id,
                    type: decision.action.type as SimActionType,
                    description: buildCharActionDescription(char.name, decision),
                    immediateResult: actionResult.immediateResult,
                    narrative: decision.narrative || undefined,
                    reasoning: decision.narrative?.innerThought || undefined,
                    reactionToUser: decision.reactionToUser || undefined,
                    storyKind: 'character_drama',
                    timestamp: Date.now(),
                };
                s.actionLog = [...s.actionLog, action];
                replayActions.push(action);

                // 结算 pending effects
                const settled = settlePendingEffects(s);
                s = settled.newState;
                for (const ev of settled.events) {
                    const sysAction: SimAction = {
                        id: genId(), turnNumber: s.turnNumber,
                        actor: '系统', actorAvatar: '', actorId: 'system',
                        type: 'TRIGGER_EVENT', description: ev, immediateResult: ev, storyKind: 'system', timestamp: Date.now(),
                    };
                    s.actionLog = [...s.actionLog, sysAction];
                    replayActions.push(sysAction);
                }

                s = advanceTurn(s);
                const { over, reason } = checkGameOver(s);
                if (over) { s.gameOver = true; s.gameOverReason = reason; break; }

            } catch (e: any) {
                console.error(`[LifeSim] ${char.name} 回合异常:`, e?.message || e);
                const fallbackAction: SimAction = {
                    id: genId(), turnNumber: s.turnNumber,
                    actor: char.name, actorAvatar: char.avatar, actorId: char.id,
                    type: 'DO_NOTHING',
                    description: `${char.name}（因为某些原因）什么都没做，静静地看着局面发展。`,
                    immediateResult: '……', storyKind: 'character_drama', timestamp: Date.now(),
                };
                s.actionLog = [...s.actionLog, fallbackAction];
                replayActions.push(fallbackAction);
                s = advanceTurn(s);
            }
        }

        s.charQueue = []; s.isProcessingCharTurn = false; s.currentActorId = 'user';
        s.replayPending = replayActions;
        await saveState(s);
        setProcessingMsg('');
        if (replayActions.length > 0) { setShowReplay(true); setReplayIndex(0); }
        if (s.gameOver) setShowGameOver(true);
    }, [characters, resolveLifeSimApiConfig, saveState, userProfile]);

    // ── 用户行动：搅局 ──────────────────────────────────────────

    const handleStir = useCallback(async (action: StirAction) => {
        if (!gameState) return;
        const userActor = userProfile?.name || '你';
        const result = applyTriggerEvent(gameState, action.eventType, action.involvedNpcIds, action.eventDesc);
        const actionDesc = buildUserActionDescription('TRIGGER_EVENT', userActor, {
            eventType: action.eventType, eventDesc: action.eventDesc,
        });

        const simAction: SimAction = {
            id: genId(), turnNumber: gameState.turnNumber,
            actor: userActor, actorAvatar: userProfile?.avatar || '',
            actorId: 'user', type: 'TRIGGER_EVENT',
            description: actionDesc, immediateResult: result.immediateResult, timestamp: Date.now(),
        };
        let s = { ...result.newState, actionLog: [...result.newState.actionLog, simAction] };

        const { over, reason } = checkGameOver(s);
        if (over) {
            s.gameOver = true; s.gameOverReason = reason;
            await saveState(s); setShowGameOver(true); setActionPanel('none'); return;
        }

        const turnResult = await finalizeTurn(s);
        if (turnResult.shouldRunCharTurns) {
            await runCharTurns(turnResult.state, turnResult.replayActions);
        }
    }, [gameState, userProfile, finalizeTurn, runCharTurns]);

    // ── 用户行动：加人 ──────────────────────────────────────────

    const handleAddNpc = useCallback(async (action: AddNpcAction) => {
        if (!gameState) return;
        const userActor = userProfile?.name || '你';
        const npc = createNPC(action.name, action.emoji, action.personalities);
        const result = applyAddNPC(gameState, npc, action.familyId);
        const targetFamily = gameState.families.find(f => f.id === action.familyId);
        const actionDesc = buildUserActionDescription('ADD_NPC', userActor, {
            npcName: npc.name, npcEmoji: npc.emoji, npcPersonality: npc.personality,
            targetFamilyName: targetFamily?.name,
        });

        const simAction: SimAction = {
            id: genId(), turnNumber: gameState.turnNumber,
            actor: userActor, actorAvatar: userProfile?.avatar || '',
            actorId: 'user', type: 'ADD_NPC',
            description: actionDesc, immediateResult: result.immediateResult, timestamp: Date.now(),
        };
        let s = { ...result.newState, actionLog: [...result.newState.actionLog, simAction] };

        const turnResult = await finalizeTurn(s);
        if (turnResult.shouldRunCharTurns) {
            await runCharTurns(turnResult.state, turnResult.replayActions);
        }
    }, [gameState, userProfile, finalizeTurn, runCharTurns]);

    // ── 看戏（随机旁观角色戏 / 主线戏） ────────────────────────

    const handleWatch = useCallback(async () => {
        if (!gameState) return;

        const userActor = userProfile?.name || '你';
        const actionDesc = buildUserActionDescription('DO_NOTHING', userActor, {});
        const simAction: SimAction = {
            id: genId(), turnNumber: gameState.turnNumber,
            actor: userActor, actorAvatar: userProfile?.avatar || '',
            actorId: 'user', type: 'DO_NOTHING',
            description: actionDesc, immediateResult: '你选择了吃瓜围观……', timestamp: Date.now(),
        };
        const watchedState = { ...gameState, actionLog: [...gameState.actionLog, simAction] };

        if (Math.random() < MAIN_PLOT_WATCH_CHANCE) {
            const mainPlotResult = await buildMainPlotAction(watchedState);
            if (!mainPlotResult) {
                await saveState(watchedState);
                return;
            }

            let mainPlotState = mainPlotResult.newState;
            const immediateOutcome = checkGameOver(mainPlotState);
            if (immediateOutcome.over) {
                mainPlotState = {
                    ...mainPlotState,
                    gameOver: true,
                    gameOverReason: immediateOutcome.reason,
                    replayPending: [mainPlotResult.mainPlotAction],
                };
                await saveState(mainPlotState);
                setActionPanel('none');
                setShowReplay(true);
                setReplayIndex(0);
                setShowGameOver(true);
                return;
            }

            const turnResult = await finalizeTurn(mainPlotState, {
                replaySeed: [mainPlotResult.mainPlotAction],
                skipCharTurns: true,
                captureNonCharReplay: true,
            });

            if (turnResult.shouldRunCharTurns) {
                await runCharTurns(turnResult.state, turnResult.replayActions);
            }
            return;
        }

        const turnResult = await finalizeTurn(watchedState);
        if (turnResult.shouldRunCharTurns) {
            await runCharTurns(turnResult.state, turnResult.replayActions);
        }
    }, [gameState, userProfile, buildMainPlotAction, finalizeTurn, runCharTurns, saveState]);

    // ── CHAR决策执行 ──────────────────────────────────────────

    function executeCharDecision(state: LifeSimState, decision: CharDecision, char: CharacterProfile) {
        const act = decision.action;
        try {
            switch (act.type) {
                case 'ADD_NPC': {
                    const npc = createNPC(act.newNpcName || `${char.name}的小人`, act.newNpcEmoji || '', act.newNpcPersonality || ['神秘']);
                    const targetId = act.targetFamilyId && state.families.find(f => f.id === act.targetFamilyId) ? act.targetFamilyId : state.families[0]?.id;
                    if (!targetId) return { newState: state, immediateResult: '没有可用的家庭。' };
                    return applyAddNPC(state, npc, targetId);
                }
                case 'TRIGGER_EVENT': {
                    const involved = (act.involvedNpcIds || []).filter(id => state.npcs.find(n => n.id === id));
                    const fallback = state.npcs.slice(0, 2).map(n => n.id);
                    return applyTriggerEvent(state, act.eventType || 'gossip', involved.length ? involved : fallback, act.eventDescription || '发生了一些事');
                }
                default: return { newState: state, immediateResult: '……什么都没发生。' };
            }
        } catch { return { newState: state, immediateResult: '操作失败了，有点尴尬。' }; }
    }

    function buildCharActionDescription(charName: string, decision: CharDecision): string {
        const act = decision.action;
        const narr = decision.narrative;
        const toneEmoji = getLifeSimToneEmoji(narr?.emotionalTone);
        const tone = toneEmoji ? ` ${toneEmoji}` : '';
        switch (act.type) {
            case 'ADD_NPC': return `${charName}${tone}往游戏里捏了个叫"${act.newNpcEmoji}${act.newNpcName}"的小人`;
            case 'TRIGGER_EVENT': return `${charName}${tone}在游戏里制造了${act.eventType}事件：${act.eventDescription || '…'}`;
            default: return `${charName}${tone}看了看游戏，这轮跳过了`;
        }
    }

    // ── 设置 / 编辑 / 结算重置 ────────────────────────────────

    const handleToggleParticipantChar = useCallback(async (charId: string) => {
        if (!gameState) return;
        const currentIds = resolveParticipantCharIds(gameState);
        const nextIds = currentIds.includes(charId)
            ? currentIds.filter(id => id !== charId)
            : [...currentIds, charId];
        await saveState({ ...gameState, participantCharIds: nextIds });
    }, [gameState, resolveParticipantCharIds, saveState]);

    const handleSelectAllParticipantChars = useCallback(async () => {
        if (!gameState) return;
        const nextIds = characters.filter(char => !!char.id).map(char => char.id);
        await saveState({ ...gameState, participantCharIds: nextIds });
    }, [characters, gameState, saveState]);

    const handleClearParticipantChars = useCallback(async () => {
        if (!gameState) return;
        await saveState({ ...gameState, participantCharIds: [] });
    }, [gameState, saveState]);

    const handleSaveLifeSimApiSettings = useCallback(async (payload: {
        enabled: boolean;
        config: { baseUrl: string; apiKey: string; model: string };
    }) => {
        if (!gameState) return;
        await saveState({
            ...gameState,
            useIndependentApiConfig: payload.enabled,
            independentApiConfig: {
                baseUrl: payload.config.baseUrl,
                apiKey: payload.config.apiKey,
                model: payload.config.model,
            },
        });
    }, [gameState, saveState]);

    const handleSaveNpcEdits = useCallback(async (updates: Partial<SimNPC>) => {
        if (!gameState || !editingNpc) return;
        const nextState: LifeSimState = {
            ...gameState,
            npcs: gameState.npcs.map(npc => (
                npc.id === editingNpc.id
                    ? { ...npc, ...updates, personality: updates.personality || npc.personality }
                    : npc
            )),
        };
        await saveState(nextState);
        setEditingNpc(null);
    }, [editingNpc, gameState, saveState]);

    const resetGame = useCallback(async (options?: {
        preserveParticipantCharIds?: string[];
        preserveUseIndependentApiConfig?: boolean;
        preserveIndependentApiConfig?: LifeSimState['independentApiConfig'];
    }) => {
        const newState = createNewLifeSimState();
        newState.lastActiveTimestamp = Date.now();
        if (options?.preserveParticipantCharIds) {
            newState.participantCharIds = [...options.preserveParticipantCharIds];
        }
        if (options?.preserveUseIndependentApiConfig !== undefined) {
            newState.useIndependentApiConfig = options.preserveUseIndependentApiConfig;
        }
        if (options?.preserveIndependentApiConfig) {
            newState.independentApiConfig = { ...options.preserveIndependentApiConfig };
        }
        setShowGameOver(false);
        setShowReplay(false);
        setActionPanel('none');
        setFestivalAnnounce('');
        setShowResetDialog(false);
        setShowSettings(false);
        setEditingNpc(null);
        await saveState(newState);
    }, [saveState]);

    const handleArchiveAndReset = useCallback(async () => {
        if (!gameState) return;

        const participantIds = resolveParticipantCharIds(gameState);
        const participantChars = getParticipatingCharacters(gameState);
        const participantNames = participantChars.map(char => char.name);
        const fallbackSummary = buildFallbackLifeSimSessionSummary(userProfile?.name || '用户', participantNames, gameState.actionLog).slice(0, 300);
        const mainPlots = gameState.actionLog.filter(action => action.storyKind === 'main_plot');
        const resolvedApiConfig = resolveLifeSimApiConfig(gameState);

        setIsResetting(true);
        setProcessingMsg('正在生成城市小结...');

        try {
            let summary = fallbackSummary;
            const canUseApi = !!(userProfile && resolvedApiConfig?.baseUrl && resolvedApiConfig?.apiKey && resolvedApiConfig?.model);

            if (canUseApi && userProfile) {
                const raw = await callCharAI(
                    { baseUrl: resolvedApiConfig.baseUrl, apiKey: resolvedApiConfig.apiKey, model: resolvedApiConfig.model },
                    buildLifeSimSessionSummaryPrompt(userProfile, participantNames, gameState.actionLog)
                );
                let rawJson = extractJson(raw);
                if (Array.isArray(rawJson)) rawJson = rawJson[0];
                const aiSummary = String(rawJson?.summary || rawJson?.content || rawJson?.text || '').replace(/\s+/g, ' ').trim();
                if (aiSummary) summary = aiSummary.slice(0, 300);
            }

            for (const char of participantChars) {
                const cardData = createLifeSimResetCardData({
                    summary,
                    headline: mainPlots[0]?.headline || mainPlots[mainPlots.length - 1]?.headline,
                    userName: userProfile?.name || '用户',
                    participantNames,
                    charName: char.name,
                    charAvatar: char.avatar,
                    mainPlotCount: mainPlots.length,
                    turnCount: gameState.turnNumber,
                });

                await DB.saveMessage({
                    charId: char.id,
                    role: 'system',
                    type: 'score_card',
                    content: JSON.stringify(cardData),
                    metadata: { scoreCard: cardData, source: 'lifesim-reset' },
                });
            }

            await resetGame({
                preserveParticipantCharIds: participantIds,
                preserveUseIndependentApiConfig: gameState.useIndependentApiConfig,
                preserveIndependentApiConfig: gameState.independentApiConfig,
            });
        } finally {
            setIsResetting(false);
            setProcessingMsg('');
        }
    }, [gameState, getParticipatingCharacters, resetGame, resolveLifeSimApiConfig, resolveParticipantCharIds, userProfile]);

    const handleDirectReset = useCallback(async () => {
        if (!gameState) return;
        const participantIds = resolveParticipantCharIds(gameState);
        await resetGame({
            preserveParticipantCharIds: participantIds,
            preserveUseIndependentApiConfig: gameState.useIndependentApiConfig,
            preserveIndependentApiConfig: gameState.independentApiConfig,
        });
    }, [gameState, resetGame, resolveParticipantCharIds]);

    const nextReplay = () => {
        if (!gameState) return;
        if (replayIndex < (gameState.replayPending?.length ?? 0) - 1) {
            setReplayIndex(i => i + 1);
        } else {
            const s = { ...gameState, replayPending: [] };
            saveState(s); setShowReplay(false);
        }
    };

    // ── 渲染 ─────────────────────────────────────────────────

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center" style={{ background: '#c4c0d4' }}>
                <div className="text-center">
                    <div className="retro-window mx-auto" style={{ width: 200, padding: 0 }}>
                        <div className="retro-titlebar"><span>loading...</span><span className="retro-dots">···</span></div>
                        <div className="p-4 text-center">
                            <Buildings size={36} weight="duotone" className="mb-2 mx-auto" style={{ color: '#6b5b95' }} />
                            <p style={{ color: '#6b5b95', fontSize: 11, fontWeight: 700 }}>城市加载中…</p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (!gameState) return null;

    const isUserTurn = gameState.currentActorId === 'user' && !gameState.isProcessingCharTurn;
    const { label: chaosLabel } = getChaosLabel(gameState.chaosLevel);
    const season = gameState.season ?? 'spring';
    const si = SEASON_INFO[season];
    const ti = TIME_INFO[gameState.timeOfDay ?? 'morning'];
    const wi = WEATHER_INFO[gameState.weather ?? 'sunny'];
    const todayFestival = getTodayFestival(gameState);
    const participantChars = getParticipatingCharacters(gameState);
    const activeThinkingChar = participantChars.find(char => char.id === gameState.currentActorId) || null;
    const isMainPlotThinking = !!processingMsg && !gameState.isProcessingCharTurn;

    // Retro OS palette based on season
    const seasonPalette: Record<string, { bg: string; accent: string; titlebar: string; windowBg: string }> = {
        spring: { bg: '#d4cfe8', accent: '#8b7bb8', titlebar: '#a594d0', windowBg: '#eeeaf6' },
        summer: { bg: '#c8dce8', accent: '#5b8fa8', titlebar: '#7badc4', windowBg: '#e8f0f6' },
        fall: { bg: '#e4d5c8', accent: '#a87b5b', titlebar: '#c49a78', windowBg: '#f4ede6' },
        winter: { bg: '#d0d4e0', accent: '#7878a0', titlebar: '#9898b8', windowBg: '#eaebf2' },
    };
    const pal = seasonPalette[season] || seasonPalette.spring;
    const topSafePadding = 'max(12px, env(safe-area-inset-top, 12px))';

    const TAB_LABELS: Record<string, string> = { npcs: '住户.exe', drama: '动态.log', relations: '关系.dat' };

    return (
        <div className="h-full w-full max-w-full flex flex-col overflow-hidden select-none" style={{ background: pal.bg, overflowX: 'hidden' }}>

            {/* ── Retro OS global styles ── */}
            <style>{`
                .retro-window {
                    background: ${pal.windowBg};
                    border: 2px solid ${pal.accent};
                    border-radius: 6px;
                    box-shadow: 3px 3px 0px rgba(0,0,0,0.15), inset 0 0 0 1px rgba(255,255,255,0.5);
                    overflow: hidden;
                }
                .retro-titlebar {
                    background: linear-gradient(180deg, ${pal.titlebar}, ${pal.accent});
                    color: white;
                    font-size: 10px;
                    font-weight: 700;
                    padding: 3px 8px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    letter-spacing: 0.03em;
                    user-select: none;
                }
                .retro-titlebar .retro-dots {
                    display: flex; gap: 3px;
                }
                .retro-titlebar .retro-dot {
                    width: 10px; height: 10px; border-radius: 2px;
                    border: 1px solid rgba(0,0,0,0.2);
                    display: inline-flex; align-items: center; justify-content: center;
                    font-size: 8px; line-height: 1; cursor: pointer;
                }
                .retro-titlebar .retro-dot:hover { filter: brightness(1.1); }
                .retro-btn {
                    background: ${pal.windowBg};
                    border: 2px solid ${pal.accent};
                    border-radius: 4px;
                    box-shadow: 2px 2px 0px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.6);
                    color: ${pal.accent};
                    font-size: 11px;
                    font-weight: 700;
                    padding: 5px 12px;
                    cursor: pointer;
                    transition: all 0.1s;
                }
                .retro-btn:active {
                    box-shadow: inset 1px 1px 2px rgba(0,0,0,0.2);
                    transform: translate(1px, 1px);
                }
                .retro-btn-primary {
                    background: linear-gradient(180deg, ${pal.titlebar}, ${pal.accent});
                    color: white;
                    border-color: ${pal.accent};
                }
                .retro-divider {
                    height: 2px;
                    background: linear-gradient(90deg, transparent, ${pal.accent}40, transparent);
                }
                .retro-inset {
                    background: rgba(0,0,0,0.05);
                    border: 1px solid rgba(0,0,0,0.1);
                    border-radius: 3px;
                    box-shadow: inset 1px 1px 3px rgba(0,0,0,0.08);
                }
                .retro-tag {
                    background: ${pal.windowBg};
                    border: 1px solid ${pal.accent}50;
                    border-radius: 3px;
                    padding: 1px 5px;
                    font-size: 9px;
                    font-weight: 600;
                    color: ${pal.accent};
                }
                .no-scrollbar::-webkit-scrollbar { display: none; }
                .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
            `}</style>

            {/* ── 顶部状态栏 (retro taskbar) ── */}
            <div className="flex-shrink-0" style={{
                background: `linear-gradient(180deg, ${pal.titlebar}ee, ${pal.accent}dd)`,
                paddingTop: topSafePadding,
                borderBottom: `2px solid ${pal.accent}`,
                boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
            }}>
                <div className="flex items-center gap-2 px-3 py-2" style={{ minHeight: 46 }}>
                    {/* Start button */}
                    <button onClick={closeApp}
                        className="flex items-center gap-1 px-2 py-0.5 rounded"
                        style={{
                            background: 'rgba(255,255,255,0.2)',
                            border: '1px solid rgba(255,255,255,0.3)',
                            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.3)',
                            fontSize: 13, fontWeight: 700, color: 'white',
                            minHeight: 40, minWidth: 66, padding: '0 12px',
                            touchAction: 'manipulation',
                            WebkitTapHighlightColor: 'transparent',
                        }}>
                        <Buildings size={16} weight="fill" /> 返回
                    </button>

                    <div className="flex-1" />

                    {/* Compact info chips */}
                    <div className="flex items-center gap-1.5" style={{ fontSize: 11, color: 'rgba(255,255,255,0.95)', fontWeight: 700 }}>
                        <TwemojiImg emoji={si.emoji} size={13} />
                        <span>{si.zh}</span>
                        <span style={{ color: 'rgba(255,255,255,0.4)' }}>|</span>
                        <TwemojiImg emoji={ti.emoji} size={13} />
                        <span>{ti.zh}</span>
                        <span style={{ color: 'rgba(255,255,255,0.4)' }}>|</span>
                        <TwemojiImg emoji={wi.emoji} size={13} />
                        <span>{wi.zh}</span>
                    </div>

                    <div className="flex-1" />

                    {/* Turn & chaos compact */}
                    <div className="flex items-center gap-1.5">
                        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.82)', fontWeight: 700, fontFamily: 'monospace' }}>
                            R{gameState.turnNumber} D{gameState.day ?? 1}
                        </span>
                        <button
                            onClick={() => setShowSettings(true)}
                            className="flex items-center justify-center relative"
                            style={{
                                width: 44, height: 44, borderRadius: 7,
                                background: 'rgba(255,255,255,0.2)',
                                border: '1px solid rgba(255,255,255,0.3)',
                                fontSize: 12, color: 'white',
                                touchAction: 'manipulation',
                                WebkitTapHighlightColor: 'transparent',
                            }}>
                            <Gear size={16} weight="bold" />
                            <span style={{
                                position: 'absolute',
                                right: 3,
                                bottom: 3,
                                fontSize: 8,
                                fontWeight: 700,
                                background: 'rgba(0,0,0,0.28)',
                                borderRadius: 999,
                                padding: '0 4px',
                            }}>
                                {participantChars.length}
                            </span>
                        </button>
                        <button
                            onClick={() => setShowResetDialog(true)}
                            className="flex items-center justify-center"
                            style={{
                                width: 44, height: 44, borderRadius: 7,
                                background: 'rgba(255,255,255,0.2)',
                                border: '1px solid rgba(255,255,255,0.3)',
                                fontSize: 12, color: 'white',
                                touchAction: 'manipulation',
                                WebkitTapHighlightColor: 'transparent',
                            }}>
                            <ArrowCounterClockwise size={16} weight="bold" />
                        </button>
                    </div>
                </div>
            </div>

            {/* ── Festival banner (compact) ── */}
            {(todayFestival || festivalAnnounce) && (
                <div className="flex-shrink-0 text-center py-1 px-2" style={{
                    background: `linear-gradient(90deg, ${pal.titlebar}cc, ${pal.accent}cc)`,
                    fontSize: 10, fontWeight: 700, color: 'white', letterSpacing: '0.05em',
                }}>
                    {todayFestival ? <><TwemojiImg emoji={todayFestival.emoji} size={11} /> {todayFestival.name}</> : festivalAnnounce}
                </div>
            )}

            {/* ── 地图窗口 ── */}
            <div className="flex-shrink-0 mx-2 mt-2 retro-window">
                <div className="retro-titlebar">
                    <span>cityview.exe — {si.zh}季 Y{gameState.year ?? 1}</span>
                    <span className="retro-dots">
                        <span className="retro-dot" style={{ background: '#fbbf24' }}>─</span>
                        <span className="retro-dot" style={{ background: '#86efac' }}>□</span>
                    </span>
                </div>
                <WorldMap gameState={gameState} />
            </div>

            {/* ── Chaos meter (compact retro bar) ── */}
            <div className="flex items-center gap-2 mx-2 mt-1.5 px-2 py-1 retro-inset" style={{ borderRadius: 4 }}>
                <span style={{ fontSize: 9, fontWeight: 700, color: pal.accent, minWidth: 32 }}>{chaosLabel}</span>
                <div className="flex-1 h-2 rounded-sm overflow-hidden" style={{ background: 'rgba(0,0,0,0.08)', border: `1px solid ${pal.accent}30` }}>
                    <div className="h-full transition-all duration-700 ease-out" style={{
                        width: `${gameState.chaosLevel}%`,
                        background: gameState.chaosLevel > 70
                            ? 'linear-gradient(90deg, #e05070, #d060a0)'
                            : `linear-gradient(90deg, ${pal.titlebar}, ${pal.accent})`,
                        borderRadius: 1,
                    }} />
                </div>
                <span style={{ fontSize: 9, fontWeight: 700, color: pal.accent, fontFamily: 'monospace' }}>{gameState.chaosLevel}</span>
            </div>

            {/* ── Turn status (compact) ── */}
            {(gameState.isProcessingCharTurn || isUserTurn) && (
                <div className="mx-2 mt-1 px-2 py-1 flex items-center gap-1.5" style={{
                    fontSize: 10, fontWeight: 600,
                    color: gameState.isProcessingCharTurn ? '#8b6bb8' : '#5b8b6b',
                    background: gameState.isProcessingCharTurn ? 'rgba(139,107,184,0.1)' : 'rgba(91,139,107,0.1)',
                    borderRadius: 4,
                    border: `1px solid ${gameState.isProcessingCharTurn ? 'rgba(139,107,184,0.2)' : 'rgba(91,139,107,0.2)'}`,
                }}>
                    {gameState.isProcessingCharTurn ? (
                        <><Gear size={12} weight="bold" className="animate-spin" /> {processingMsg || '角色们在思考…'}</>
                    ) : (
                        <><Star size={12} weight="fill" /> 你的回合</>
                    )}
                </div>
            )}

            {(participantChars.length > 0 || isMainPlotThinking) && (
                <div className="mx-2 mt-1 px-2 py-1.5 retro-inset" style={{ borderRadius: 4 }}>
                    <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                        {isMainPlotThinking && (
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '4px 8px',
                                borderRadius: 999,
                                border: '1px solid rgba(184,108,61,0.35)',
                                background: 'rgba(184,108,61,0.12)',
                                color: '#9b6238',
                                fontSize: 10,
                                fontWeight: 700,
                                flexShrink: 0,
                            }}>
                                <span style={{ fontSize: 14 }}>🎬</span>
                                <span>主线编剧室</span>
                            </div>
                        )}

                        {participantChars.map(char => {
                            const isActive = gameState.isProcessingCharTurn && gameState.currentActorId === char.id;
                            return (
                                <div
                                    key={char.id}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '4px 8px',
                                        borderRadius: 999,
                                        border: isActive ? '1px solid rgba(139,107,184,0.5)' : '1px solid rgba(0,0,0,0.08)',
                                        background: isActive ? 'rgba(139,107,184,0.14)' : 'rgba(255,255,255,0.55)',
                                        color: isActive ? '#7b61aa' : '#777',
                                        fontSize: 10,
                                        fontWeight: isActive ? 700 : 600,
                                        boxShadow: isActive ? '0 0 0 1px rgba(139,107,184,0.15) inset' : 'none',
                                        flexShrink: 0,
                                        transition: 'all 0.18s ease',
                                    }}>
                                    <img
                                        src={char.avatar}
                                        alt={char.name}
                                        style={{
                                            width: 20,
                                            height: 20,
                                            borderRadius: 999,
                                            objectFit: 'cover',
                                            boxShadow: isActive ? '0 0 0 2px rgba(139,107,184,0.22)' : 'none',
                                        }}
                                    />
                                    <span>{char.name}</span>
                                    {isActive && (
                                        <span style={{
                                            width: 6,
                                            height: 6,
                                            borderRadius: '50%',
                                            background: '#8b6bb8',
                                            boxShadow: '0 0 10px rgba(139,107,184,0.45)',
                                        }} />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    {(activeThinkingChar || isMainPlotThinking) && (
                        <div style={{ marginTop: 5, fontSize: 9, color: '#8b8099', fontWeight: 700 }}>
                            {isMainPlotThinking
                                ? processingMsg
                                : `${activeThinkingChar?.name || '角色'} 正在思考，API 已开始调用`}
                        </div>
                    )}
                </div>
            )}

            {/* ── Content window with tabs ── */}
            <div className="flex-1 flex flex-col mx-2 mt-1.5 mb-1 retro-window overflow-hidden" style={{ minHeight: 0, minWidth: 0 }}>
                {/* Retro tab bar as titlebar */}
                <div className="retro-titlebar" style={{ padding: 0 }}>
                    {([
                        ['npcs', '住户', UsersThree],
                        ['drama', '动态', MaskSad],
                        ['relations', '关系', HeartHalf],
                    ] as const).map(([tab, label, Icon]) => (
                        <button key={tab} onClick={() => setActiveTab(tab as any)}
                            className="flex items-center gap-1 px-3 py-1"
                            style={{
                                fontSize: 10, fontWeight: 700,
                                color: activeTab === tab ? pal.accent : 'rgba(255,255,255,0.8)',
                                background: activeTab === tab ? pal.windowBg : 'transparent',
                                borderRight: `1px solid ${pal.accent}40`,
                                borderBottom: activeTab === tab ? `2px solid ${pal.windowBg}` : '2px solid transparent',
                                marginBottom: activeTab === tab ? -2 : 0,
                                borderRadius: activeTab === tab ? '4px 4px 0 0' : 0,
                            }}>
                            <Icon size={11} weight="bold" /> {TAB_LABELS[tab]}
                        </button>
                    ))}
                    <div className="flex-1" />
                </div>
                <div className="flex-1 overflow-y-auto overflow-x-hidden no-scrollbar" style={{ background: pal.windowBg, minWidth: 0 }}>
                    {activeTab === 'npcs' && <NPCGrid gameState={gameState} onLongPressNpc={setEditingNpc} />}
                    {activeTab === 'drama' && <DramaFeed gameState={gameState} />}
                    {activeTab === 'relations' && <RelationsTab gameState={gameState} />}
                </div>
            </div>

            {/* ── Bottom action bar (retro buttons) ── */}
            {isUserTurn && (
                <div className="flex-shrink-0 flex gap-2 px-2 pb-2 pt-1"
                    style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom, 8px))' }}>
                    <button onClick={() => setActionPanel('stir')}
                        className="flex-1 retro-btn retro-btn-primary flex items-center justify-center gap-1"
                        style={{ padding: '7px 8px' }}>
                        <MaskHappy size={13} weight="bold" /> 搅局
                    </button>
                    <button onClick={() => setActionPanel('add')}
                        className="flex-1 retro-btn retro-btn-primary flex items-center justify-center gap-1"
                        style={{ padding: '7px 8px', background: `linear-gradient(180deg, #7badc4, #5b8fa8)` }}>
                        <UserPlus size={13} weight="bold" /> 拉人
                    </button>
                    <button onClick={handleWatch}
                        className="flex-1 retro-btn flex items-center justify-center gap-1"
                        style={{ padding: '7px 8px' }}>
                        <Eye size={13} weight="bold" /> 吃瓜
                    </button>
                </div>
            )}

            {/* ── 行动面板 ── */}
            {actionPanel !== 'none' && isUserTurn && (
                <ActionPanel
                    gameState={gameState}
                    mode={actionPanel}
                    onStir={handleStir}
                    onAdd={handleAddNpc}
                    onClose={() => setActionPanel('none')}
                />
            )}

            {showSettings && (
                <LifeSimSettingsPanel
                    characters={characters}
                    selectedCharIds={resolveParticipantCharIds(gameState)}
                    apiPresets={apiPresets}
                    useIndependentApiConfig={!!gameState.useIndependentApiConfig}
                    independentApiConfig={gameState.independentApiConfig}
                    onToggleChar={handleToggleParticipantChar}
                    onSelectAll={handleSelectAllParticipantChars}
                    onSelectNone={handleClearParticipantChars}
                    onSaveApiSettings={handleSaveLifeSimApiSettings}
                    onClose={() => setShowSettings(false)}
                />
            )}

            {editingNpc && (
                <NPCEditorPanel
                    npc={editingNpc}
                    onSave={handleSaveNpcEdits}
                    onClose={() => setEditingNpc(null)}
                />
            )}

            {showResetDialog && (
                <ResetCityDialog
                    participantCount={participantChars.length}
                    mainPlotCount={gameState.actionLog.filter(action => action.storyKind === 'main_plot').length}
                    processing={isResetting}
                    onCancel={() => setShowResetDialog(false)}
                    onArchiveAndReset={handleArchiveAndReset}
                    onDirectReset={handleDirectReset}
                />
            )}

            {/* ── 回放弹窗 ── */}
            {showReplay && gameState.replayPending && gameState.replayPending.length > 0 && (
                <NarrativeReplayOverlay
                    actions={gameState.replayPending}
                    currentIndex={replayIndex}
                    onNext={nextReplay}
                />
            )}

            {/* ── 游戏结束 ── */}
            {showGameOver && (
                <GameOverOverlay reason={gameState.gameOverReason} onRestart={resetGame} />
            )}
        </div>
    );
};

export default LifeSimApp;

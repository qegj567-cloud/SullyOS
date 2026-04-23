import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { Message, MessageType, MemoryFragment, Emoji, EmojiCategory, DailySchedule, ScheduleSlot } from '../types';
import { processImage } from '../utils/file';
import { safeResponseJson, extractContent } from '../utils/safeApi';
import { generateDailyScheduleForChar, isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { formatMessageWithTime } from '../utils/messageFormat';
import { XhsMcpClient, extractNotesFromMcpData, normalizeNote } from '../utils/xhsMcpClient';
import MessageItem from '../components/chat/MessageItem';
import { PRESET_THEMES, DEFAULT_ARCHIVE_PROMPTS } from '../components/chat/ChatConstants';
import ChatHeader from '../components/chat/ChatHeaderShell';
import ChatInputArea from '../components/chat/ChatInputArea';
import ChatModals from '../components/chat/ChatModals';
import Modal from '../components/os/Modal';
import ProactiveSettingsModal from '../components/chat/ProactiveSettingsModal';
import { useChatAI } from '../hooks/useChatAI';
import { synthesizeSpeechDetailed, cleanTextForTts } from '../utils/minimaxTts';

const VOICE_LANG_LABELS: Record<string, string> = { en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', es: 'Español' };

const Chat: React.FC = () => {
    const { characters, activeCharacterId, setActiveCharacterId, updateCharacter, apiConfig, apiPresets, addApiPreset, closeApp, customThemes, removeCustomTheme, addToast, userProfile, lastMsgTimestamp, groups, clearUnread, realtimeConfig, memoryPalaceConfig, theme: osTheme } = useOS();

    // 记忆宫殿高水位（用于清空聊天时的安全检查）
    const getMemoryPalaceHWM = useCallback(async (charId: string): Promise<number> => {
        try {
            const { getMemoryPalaceHighWaterMark } = await import('../utils/memoryPalace/pipeline');
            return getMemoryPalaceHighWaterMark(charId);
        } catch { return 0; }
    }, []);
    const [messages, setMessages] = useState<Message[]>([]);
    const [totalMsgCount, setTotalMsgCount] = useState(0);
    const [visibleCount, setVisibleCount] = useState(30);
    const [input, setInput] = useState('');
    const [showPanel, setShowPanel] = useState<'none' | 'actions' | 'emojis' | 'chars'>('none');
    
    // Emoji State
    const [emojis, setEmojis] = useState<Emoji[]>([]);
    const [categories, setCategories] = useState<EmojiCategory[]>([]);
    const [activeCategory, setActiveCategory] = useState<string>('default');
    const [newCategoryName, setNewCategoryName] = useState('');

    const scrollRef = useRef<HTMLDivElement>(null);
    const lastMsgIdRef = useRef<number | null>(null);
    const scrollThrottleRef = useRef(0);
    const visibleCountRef = useRef(30);
    const activeCharIdRef = useRef(activeCharacterId);
    const charRef = useRef<typeof char>(null as any);

    // Reply Logic
    const [replyTarget, setReplyTarget] = useState<Message | null>(null);

    const [modalType, setModalType] = useState<'none' | 'transfer' | 'emoji-import' | 'chat-settings' | 'message-options' | 'edit-message' | 'delete-emoji' | 'delete-category' | 'add-category' | 'history-manager' | 'archive-settings' | 'prompt-editor' | 'category-options' | 'category-visibility' | 'schedule'>('none');
    const [scheduleData, setScheduleData] = useState<DailySchedule | null>(null);
    const [isScheduleGenerating, setIsScheduleGenerating] = useState(false);
    const [allHistoryMessages, setAllHistoryMessages] = useState<Message[]>([]);
    const [transferAmt, setTransferAmt] = useState('');
    const [emojiImportText, setEmojiImportText] = useState('');
    const [settingsContextLimit, setSettingsContextLimit] = useState(500);
    const [settingsHideSysLogs, setSettingsHideSysLogs] = useState(false);
    const [preserveContext, setPreserveContext] = useState(true);
    const [isVectorizing, setIsVectorizing] = useState(false);
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
    const [selectedEmoji, setSelectedEmoji] = useState<Emoji | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<EmojiCategory | null>(null); // For deletion modal
    const [editContent, setEditContent] = useState('');
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [archiveProgress, setArchiveProgress] = useState('');
    const [showProactiveModal, setShowProactiveModal] = useState(false);

    // 🛟 人格抢救 Modal：角色被"情感型 0.3"默认值卡住时，进聊天强制弹窗重跑一次检测
    type PersonalityRescueState =
        | { open: false }
        | { open: true; charId: string; charName: string; phase: 'rescuing' }
        | { open: true; charId: string; charName: string; phase: 'done'; result: { style: string; ruminationTendency: number; reasoning: string } }
        | { open: true; charId: string; charName: string; phase: 'failed'; error: string };
    const [personalityRescue, setPersonalityRescue] = useState<PersonalityRescueState>({ open: false });

    // Archive Prompts State
    const [archivePrompts, setArchivePrompts] = useState<{id: string, name: string, content: string}[]>(DEFAULT_ARCHIVE_PROMPTS);
    const [selectedPromptId, setSelectedPromptId] = useState<string>('preset_rational');
    const [editingPrompt, setEditingPrompt] = useState<{id: string, name: string, content: string} | null>(null);

    // --- Multi-Select State ---
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());

    // --- Translation State (per-character toggle, global language settings) ---
    const [translationEnabled, setTranslationEnabled] = useState(() => {
        try { return JSON.parse(localStorage.getItem(`chat_translate_enabled_${activeCharacterId}`) || 'false'); } catch { return false; }
    });
    const [translateSourceLang, setTranslateSourceLang] = useState(() => {
        return localStorage.getItem('chat_translate_source_lang') || '日本語';
    });
    const [translateTargetLang, setTranslateTargetLang] = useState(() => {
        return localStorage.getItem('chat_translate_lang') || '中文';
    });
    // Which messages are currently showing "译" version (toggle state only, no API calls)
    const [showingTargetIds, setShowingTargetIds] = useState<Set<number>>(new Set());

    const char = characters.find(c => c.id === activeCharacterId) || characters[0];
    charRef.current = char; // Keep ref in sync for async callbacks
    const currentThemeId = char?.bubbleStyle || 'default';
    const activeTheme = useMemo(() => customThemes.find(t => t.id === currentThemeId) || PRESET_THEMES[currentThemeId] || PRESET_THEMES.default, [currentThemeId, customThemes]);
    const draftKey = `chat_draft_${activeCharacterId}`;

    // Filter categories and emojis by active character's visibility (used for both AI prompt and UI)
    const visibleCategories = useMemo(() => categories.filter(cat => {
        if (!cat.allowedCharacterIds || cat.allowedCharacterIds.length === 0) return true;
        return cat.allowedCharacterIds.includes(activeCharacterId);
    }), [categories, activeCharacterId]);

    const aiVisibleEmojis = useMemo(() => {
        const hiddenIds = new Set(categories.filter(c => !visibleCategories.some(vc => vc.id === c.id)).map(c => c.id));
        if (hiddenIds.size === 0) return emojis;
        return emojis.filter(e => !e.categoryId || !hiddenIds.has(e.categoryId));
    }, [emojis, categories, visibleCategories]);




    // --- Initialize Hook ---
    const { isTyping, recallStatus, searchStatus, diaryStatus, emotionStatus, memoryPalaceStatus, memoryPalaceResult, setMemoryPalaceResult, lastDigestResult, setLastDigestResult, lastTokenUsage, tokenBreakdown, setLastTokenUsage, triggerAI, startProactiveChat, stopProactiveChat, isProactiveActive } = useChatAI({
        char,
        userProfile,
        apiConfig,
        groups,
        emojis: aiVisibleEmojis,
        categories: visibleCategories,
        addToast,
        setMessages,
        realtimeConfig,
        translationConfig: translationEnabled
            ? { enabled: true, sourceLang: translateSourceLang, targetLang: translateTargetLang }
            : undefined,
        memoryPalaceConfig,
        updateCharacter,
    });

    // --- Voice TTS for chat messages ---
    interface VoiceData { url: string; originalText: string; spokenText?: string; lang?: string; }
    // Persisted shape (IndexedDB assets store). `blob` is the raw audio;
    // `remoteUrl` is the fallback when fetching the MiniMax CDN blob was blocked by CORS.
    interface StoredVoice { blob?: Blob; remoteUrl?: string; originalText: string; spokenText?: string; lang?: string; }
    const voiceAssetKey = (msgId: number) => `voice_msg_${msgId}`;
    const [voiceDataMap, setVoiceDataMap] = useState<Record<number, VoiceData>>({});
    const [voiceLoading, setVoiceLoading] = useState<Set<number>>(new Set());
    const [playingMsgId, setPlayingMsgId] = useState<number | null>(null);
    const chatAudioRef = useRef<HTMLAudioElement | null>(null);
    const prevIsTypingRef = useRef(false);
    // Track blob: URLs we created so we can revoke them on character switch / unmount.
    const voiceBlobUrlsRef = useRef<Set<string>>(new Set());

    const persistVoice = async (msgId: number, url: string, blob: Blob | null, originalText: string, spokenText: string | undefined, lang: string | undefined) => {
        try {
            const stored: StoredVoice = blob
                ? { blob, originalText, spokenText, lang }
                : { remoteUrl: url, originalText, spokenText, lang };
            await DB.saveAssetRaw(voiceAssetKey(msgId), stored);
        } catch (e) {
            console.warn('[Chat] persist voice failed', e);
        }
    };

    /** Drop in-memory + on-disk voice data for the given message ids. */
    const discardVoiceForMessages = (ids: Iterable<number>) => {
        const idList = Array.from(ids);
        if (!idList.length) return;
        setVoiceDataMap(prev => {
            let changed = false;
            const next = { ...prev };
            for (const id of idList) {
                const entry = next[id];
                if (!entry) continue;
                if (entry.url && entry.url.startsWith('blob:')) {
                    try { URL.revokeObjectURL(entry.url); } catch { /* ignore */ }
                    voiceBlobUrlsRef.current.delete(entry.url);
                }
                delete next[id];
                changed = true;
            }
            return changed ? next : prev;
        });
        // Best-effort: remove persisted entries so they don't reappear on next load.
        for (const id of idList) {
            DB.deleteAsset(voiceAssetKey(id)).catch(() => { /* ignore */ });
        }
    };

    const handlePlayVoice = (msgId: number) => {
        const data = voiceDataMap[msgId];
        if (!data) {
            // No voice data yet — trigger TTS generation (e.g. placeholder voice bar clicked)
            const msg = messages.find(m => m.id === msgId);
            if (msg) handleManualTts(msg, false);
            return;
        }
        if (!chatAudioRef.current) chatAudioRef.current = new Audio();
        const audio = chatAudioRef.current;
        if (playingMsgId === msgId) {
            audio.pause();
            setPlayingMsgId(null);
            return;
        }
        audio.src = data.url;
        audio.onended = () => setPlayingMsgId(null);
        audio.play().catch(() => {});
        setPlayingMsgId(msgId);
    };

    /** Extract <语音>...</语音> tag content from a message, if present */
    const extractVoiceTag = (content: string): string | null => {
        const match = content.match(/<[语語]音>([\s\S]*?)<\/[语語]音>/);
        return match ? match[1].trim() : null;
    };

    const handleManualTts = async (msg: Message, autoTriggered = false) => {
        if (voiceDataMap[msg.id] || voiceLoading.has(msg.id)) return;

        // Check if message contains a <语音> tag (AI chose to send voice)
        const voiceTagContent = extractVoiceTag(msg.content);

        // Auto-TTS: only generate voice when AI explicitly used <语音> tag
        if (autoTriggered && !voiceTagContent) return;

        setVoiceLoading(prev => new Set(prev).add(msg.id));
        try {
            let spokenText: string;
            let originalText: string;
            const voiceLang = char.chatVoiceLang || '';

            if (voiceTagContent) {
                // AI already provided the spoken text (possibly translated) in <语音> tag
                spokenText = cleanTextForTts(`<语音>${voiceTagContent}</语音>`);
                // originalText = text OUTSIDE the voice tag (the display/Chinese text)
                const textOutsideTag = msg.content.replace(/<[语語]音>[\s\S]*?<\/[语語]音>/g, '').trim();
                originalText = textOutsideTag ? cleanTextForTts(textOutsideTag) : '';
                // If voice lang is set and no Chinese text outside the tag, translate spoken text back to Chinese
                if (voiceLang && !originalText && spokenText) {
                    try {
                        const transRes = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                            body: JSON.stringify({
                                model: apiConfig.model,
                                messages: [{ role: 'system', content: '把以下内容翻译成中文。只输出翻译结果，不要任何解释。' }, { role: 'user', content: spokenText }],
                                temperature: 0.3,
                            }),
                        });
                        const transData = await transRes.json();
                        const chineseText = transData?.choices?.[0]?.message?.content?.trim();
                        if (chineseText) originalText = chineseText;
                    } catch { /* keep originalText empty */ }
                }
            } else {
                // Manual TTS (long-press): no <语音> tag.
                // Bilingual messages already contain both a target-language side (before
                // %%BILINGUAL%%) and a Chinese side (after). When the char's voice language
                // matches the message's target language we reuse those halves directly —
                // translating again would just echo the target language back and produce
                // two identical foreign-language lines in the expanded voice bar.
                const bilingualIdx = msg.content.toLowerCase().indexOf('%%bilingual%%');
                const hasBilingual = bilingualIdx !== -1;
                if (hasBilingual && voiceLang) {
                    const langAText = cleanTextForTts(msg.content.substring(0, bilingualIdx));
                    const langBText = cleanTextForTts(msg.content.substring(bilingualIdx + '%%BILINGUAL%%'.length));
                    if (!langAText || langAText.length < 2) return;
                    spokenText = langAText;
                    originalText = langBText || '';
                } else {
                    originalText = cleanTextForTts(msg.content);
                    if (!originalText || originalText.length < 2) return;
                    spokenText = originalText;
                    if (voiceLang) {
                        const langLabel = VOICE_LANG_LABELS[voiceLang] || voiceLang;
                        try {
                            const transRes = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                                body: JSON.stringify({
                                    model: apiConfig.model,
                                    messages: [{ role: 'system', content: `Translate the following text to ${langLabel}. Output ONLY the translation, nothing else.` }, { role: 'user', content: originalText }],
                                    temperature: 0.3,
                                }),
                            });
                            const transData = await transRes.json();
                            const translated = transData?.choices?.[0]?.message?.content?.trim();
                            if (translated) spokenText = translated;
                        } catch { /* use original */ }
                    }
                }
            }

            if (!spokenText || spokenText.length < 2) return;

            const { url: blobUrl, blob } = await synthesizeSpeechDetailed(spokenText, char, apiConfig, {
                languageBoost: voiceLang || undefined,
                groupId: apiConfig.minimaxGroupId || undefined,
            });
            if (blobUrl.startsWith('blob:')) voiceBlobUrlsRef.current.add(blobUrl);
            const storedSpokenText = voiceTagContent ? spokenText : (voiceLang ? spokenText : undefined);
            const storedLang = voiceLang || undefined;
            setVoiceDataMap(prev => ({ ...prev, [msg.id]: { url: blobUrl, originalText, spokenText: storedSpokenText, lang: storedLang } }));
            // Persist so the voice bar survives leaving and re-entering the chat.
            persistVoice(msg.id, blobUrl, blob, originalText, storedSpokenText, storedLang);
            // Auto-play
            if (!chatAudioRef.current) chatAudioRef.current = new Audio();
            chatAudioRef.current.src = blobUrl;
            chatAudioRef.current.onended = () => setPlayingMsgId(null);
            chatAudioRef.current.play().catch(() => {});
            setPlayingMsgId(msg.id);
        } catch (err: any) {
            addToast(`语音生成失败: ${err?.message || '未知错误'}`, 'error');
        } finally {
            setVoiceLoading(prev => { const next = new Set(prev); next.delete(msg.id); return next; });
        }
    };

    // --- Auto-TTS: when chatVoiceEnabled, auto-generate voice when AI uses <语音> tag ---
    // Scans ALL recent assistant messages (not just the last one) because chunkText
    // may split a single AI response into multiple messages, and the <语音> tag could
    // end up in any chunk — not necessarily the final one.
    useEffect(() => {
        const wasTyping = prevIsTypingRef.current;
        prevIsTypingRef.current = isTyping;
        // Only trigger when AI just finished typing (wasTyping → !isTyping)
        if (!wasTyping || isTyping) return;
        if (!char.chatVoiceEnabled) return;
        const voiceProfile = char.voiceProfile;
        if (!voiceProfile?.voiceId && (!voiceProfile?.timberWeights || voiceProfile.timberWeights.length === 0)) return;
        // Scan recent assistant messages for unprocessed <语音> tags
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            // Stop scanning once we hit a non-assistant message (end of current AI response batch)
            if (msg.role !== 'assistant') break;
            if (msg.type !== 'text') continue;
            if (voiceDataMap[msg.id] || voiceLoading.has(msg.id)) continue;
            handleManualTts(msg, true);
        }
    }, [isTyping]); // eslint-disable-line react-hooks/exhaustive-deps

    const canReroll = !isTyping && messages.length > 0 && messages[messages.length - 1].role === 'assistant';

    // --- Translation: pure frontend toggle (no API calls, bilingual data is already in message content) ---
    const handleTranslateToggle = useCallback((msgId: number) => {
        setShowingTargetIds(prev => {
            const next = new Set(prev);
            if (next.has(msgId)) next.delete(msgId);
            else next.add(msgId);
            return next;
        });
    }, []);

    const loadEmojiData = async () => {
        await DB.initializeEmojiData();
        const [es, cats] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
        setEmojis(es);
        setCategories(cats);
        if (activeCategory !== 'default' && !cats.some(c => c.id === activeCategory)) {
            setActiveCategory('default');
        }
    };

    // Hydrate voice data from IndexedDB for currently visible messages.
    // Voice URLs are stored as blob: URLs that become invalid whenever the
    // component unmounts — persisting the raw blob and rebuilding the URL on
    // mount is what keeps previously-generated voice bars alive across
    // chat entries.
    useEffect(() => {
        if (!messages.length) return;
        const map = voiceDataMap;
        const toFetch = messages.filter(m => m.id && m.type === 'text' && m.role !== 'user' && !map[m.id]);
        if (!toFetch.length) return;
        let cancelled = false;
        (async () => {
            const updates: Record<number, VoiceData> = {};
            for (const m of toFetch) {
                try {
                    const stored = await DB.getAssetRaw(voiceAssetKey(m.id)) as StoredVoice | null;
                    if (!stored) continue;
                    let url: string | null = null;
                    if (stored.blob instanceof Blob) {
                        url = URL.createObjectURL(stored.blob);
                        voiceBlobUrlsRef.current.add(url);
                    } else if (stored.remoteUrl) {
                        url = stored.remoteUrl;
                    }
                    if (!url) continue;
                    updates[m.id] = { url, originalText: stored.originalText || '', spokenText: stored.spokenText, lang: stored.lang };
                } catch { /* ignore single-message hydration errors */ }
            }
            if (cancelled || !Object.keys(updates).length) return;
            setVoiceDataMap(prev => ({ ...updates, ...prev }));
        })();
        return () => { cancelled = true; };
    }, [messages]);

    // Revoke blob URLs when switching characters / unmounting to avoid leaks.
    useEffect(() => {
        const urls = voiceBlobUrlsRef.current;
        return () => {
            urls.forEach(u => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
            urls.clear();
        };
    }, [activeCharacterId]);

    // How many messages to load per batch (initial load + each "load more" click)
    const LOAD_BATCH_SIZE = 30;

    const reloadMessages = useCallback(async (requestedVisibleCount: number) => {
        if (!activeCharacterId) return;

        const charIdAtStart = activeCharacterId;
        try {
            const allMsgs = await DB.getMessagesByCharId(activeCharacterId, true);

            // Guard against stale async results: if the user switched characters
            // while the DB query was in flight, discard this result.
            if (activeCharIdRef.current !== charIdAtStart) return;

            // Use ref to always get the CURRENT char (avoids stale closure)
            const currentChar = charRef.current;
            const chatScopeMsgs = allMsgs
                .filter(m => m.metadata?.source !== 'date' && m.metadata?.source !== 'call')
                .filter(m => !currentChar?.hideBeforeMessageId || m.id >= currentChar.hideBeforeMessageId)
                .filter(m => !(currentChar?.hideSystemLogs && m.role === 'system' && m.type !== 'score_card'));

            setTotalMsgCount(chatScopeMsgs.length);
            setMessages(chatScopeMsgs.slice(-requestedVisibleCount));
        } catch (e) {
            // DB read failed — retry once after a short delay
            if (activeCharIdRef.current !== charIdAtStart) return;
            await new Promise(r => setTimeout(r, 200));
            if (activeCharIdRef.current !== charIdAtStart) return;
            try {
                const retryMsgs = await DB.getMessagesByCharId(activeCharacterId, true);
                if (activeCharIdRef.current !== charIdAtStart) return;
                const currentChar = charRef.current;
                const chatScopeMsgs = retryMsgs
                    .filter(m => m.metadata?.source !== 'date' && m.metadata?.source !== 'call')
                    .filter(m => !currentChar?.hideBeforeMessageId || m.id >= currentChar.hideBeforeMessageId)
                    .filter(m => !(currentChar?.hideSystemLogs && m.role === 'system' && m.type !== 'score_card'));
                setTotalMsgCount(chatScopeMsgs.length);
                setMessages(chatScopeMsgs.slice(-requestedVisibleCount));
            } catch { /* give up silently */ }
        }
    }, [activeCharacterId]);

    useEffect(() => {
        if (activeCharacterId) {
            // Update ref BEFORE any async work so stale reloadMessages calls
            // from a previous character can detect the switch and bail out.
            activeCharIdRef.current = activeCharacterId;

            // Clear messages immediately to prevent showing stale chat from previous character
            setMessages([]);
            setTotalMsgCount(0);
            // Reset voice map — stale blob: URLs from the previous char are revoked
            // by the cleanup effect and must not be reused against new messages.
            setVoiceDataMap({});
            setPlayingMsgId(null);
            if (chatAudioRef.current) { try { chatAudioRef.current.pause(); } catch { /* ignore */ } }

            reloadMessages(LOAD_BATCH_SIZE);
            loadEmojiData();
            const savedDraft = localStorage.getItem(draftKey);
            setInput(savedDraft || '');
            if (char) {
                setSettingsContextLimit(char.contextLimit || 500);
                setSettingsHideSysLogs(char.hideSystemLogs || false);
                clearUnread(char.id);
            }
            // Per-character translation toggle
            try {
                setTranslationEnabled(JSON.parse(localStorage.getItem(`chat_translate_enabled_${activeCharacterId}`) || 'false'));
            } catch { setTranslationEnabled(false); }
            setVisibleCount(30);
            visibleCountRef.current = 30;
            lastMsgIdRef.current = null;
            scrollThrottleRef.current = 0;
            setLastTokenUsage(null);
            setReplyTarget(null);
            setSelectionMode(false);
            setSelectedMsgIds(new Set());
            setShowingTargetIds(new Set());
        }
    }, [activeCharacterId, reloadMessages]);

    // Auto-generate daily schedule (fire-and-forget on chat load)
    // 总开关关闭时完全跳过：不查询 DB、不调用副 API、不跑兜底
    useEffect(() => {
        if (!char || !apiConfig.apiKey) return;
        if (!isScheduleFeatureOn(char)) {
            setScheduleData(null);
            return;
        }
        const today = new Date().toISOString().split('T')[0];
        DB.getDailySchedule(char.id, today).then(existing => {
            if (!existing) {
                // Generate in background, don't block chat
                generateDailySchedule(char, false);
            } else {
                setScheduleData(existing);
            }
        }).catch(() => {});
    }, [activeCharacterId, char?.scheduleFeatureEnabled]);

    // Load all messages when history-manager modal opens
    useEffect(() => {
        if (modalType === 'history-manager' && activeCharacterId) {
            DB.getMessagesByCharId(activeCharacterId, true).then(allMsgs => {
                const filtered = allMsgs
                    .filter(m => m.metadata?.source !== 'date' && m.metadata?.source !== 'call')
                    .filter(m => !(char?.hideSystemLogs && m.role === 'system' && m.type !== 'score_card'));
                setAllHistoryMessages(filtered);
            });
        }
    }, [modalType, activeCharacterId, char?.hideSystemLogs]);

    useEffect(() => {
        const savedPrompts = localStorage.getItem('chat_archive_prompts');
        if (savedPrompts) {
            try {
                const parsed = JSON.parse(savedPrompts);
                const merged = [...DEFAULT_ARCHIVE_PROMPTS, ...parsed.filter((p: any) => !p.id.startsWith('preset_'))];
                setArchivePrompts(merged);
            } catch(e) {}
        }
        const savedId = localStorage.getItem('chat_active_archive_prompt_id');
        if (savedId && archivePrompts.some(p => p.id === savedId)) setSelectedPromptId(savedId);
    }, []);

    useEffect(() => {
        if (activeCharacterId && lastMsgTimestamp > 0) {
            reloadMessages(visibleCountRef.current);
            clearUnread(activeCharacterId);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearUnread is stable (useCallback with []), omit to prevent stale-dep lint noise
    }, [lastMsgTimestamp, activeCharacterId, reloadMessages, clearUnread]);

    useEffect(() => {
        visibleCountRef.current = visibleCount;
    }, [visibleCount]);

    // （旧的"首次自动归档 banner"已移除，自动归档改为用户在神经链接里显式 opt-in）

    // Reload char data when background emotion evaluation updates buffs
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId === activeCharacterId) {
                // Reload all characters to pick up updated activeBuffs / buffInjection
                DB.getAllCharacters().then(all => {
                    const updated = all.find(c => c.id === activeCharacterId);
                    if (updated) updateCharacter(updated.id, {
                        activeBuffs: updated.activeBuffs,
                        buffInjection: updated.buffInjection
                    });
                }).catch(() => {});
            }
        };
        window.addEventListener('emotion-updated', handler);
        return () => window.removeEventListener('emotion-updated', handler);
    }, [activeCharacterId, updateCharacter]);

    // 🛟 人格抢救：进聊天后发现角色被卡在"情感型 0.3"显示（真实存储可能是 emotional/0.3，
    // 也可能是 undefined —— UI 的 `|| 'emotional'` 和 `?? 0.3` fallback 让两者看起来一样）。
    // 触发后强制弹窗重跑一次检测，每个角色只抢救一次（rescuedKey）。
    useEffect(() => {
        if (!char) return;
        const style = (char as any).personalityStyle;
        const rumination = (char as any).ruminationTendency;
        // v2：旧 silent rescue（4fec4d0）已经把 v1 设到一堆虽然仍是 emotional/0.3 的角色上了。
        // 换 key 让所有用户都获得一次新的抢救机会，不再被历史标记卡死。
        const rescuedKey = `mp_personality_rescued_v2_${char.id}`;
        const alreadyRescued = !!localStorage.getItem(rescuedKey);

        // 副 API 没配时 fallback 到主 apiConfig —— 跟 useChatAI.ts 里 mpLLM 的 fallback 策略对齐，
        // 否则没配过记忆宫殿 lightLLM 的用户会整个抢救流程静默 pass，体感上就是"什么都没触发"。
        const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
        const llmForRescue = (mpLLMConfigured?.baseUrl && mpLLMConfigured?.apiKey)
            ? mpLLMConfigured
            : (apiConfig?.baseUrl && apiConfig?.apiKey
                ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model }
                : null);
        const llmSource = (mpLLMConfigured?.baseUrl && mpLLMConfigured?.apiKey) ? 'lightLLM' : (llmForRescue ? 'apiConfig-fallback' : 'none');

        // "UI 显示 情感型 0.3"的所有情况：
        // - 完整命中 emotional + 0.3
        // - 完全 undefined/null（从未检测过或失败后没写回）
        // - 半命中（一项真实一项 fallback）—— 也按可疑处理
        const styleSuspect = style === 'emotional' || style == null;
        const rumSuspect = rumination === 0.3 || rumination == null;
        const isSuspectDefault = styleSuspect && rumSuspect;

        console.log(`🛟 [PersonalityRescue] 检查 ${char.name}: personalityStyle=${JSON.stringify(style)} ruminationTendency=${JSON.stringify(rumination)} suspectDefault=${isSuspectDefault} alreadyRescued=${alreadyRescued} llmSource=${llmSource}`);

        if (!isSuspectDefault) return;
        if (alreadyRescued) return;
        if (!llmForRescue) {
            console.warn(`🛟 [PersonalityRescue] ${char.name} 命中可疑默认值，但既没配副 API 也没配主 API，跳过抢救`);
            return;
        }

        // 已经在抢救同一个角色就不重复触发
        if (personalityRescue.open && personalityRescue.charId === char.id) return;

        let cancelled = false;
        const rescueCharId = char.id;
        const rescueCharName = char.name;
        const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');

        setPersonalityRescue({ open: true, charId: rescueCharId, charName: rescueCharName, phase: 'rescuing' });
        console.log(`🛟 [PersonalityRescue] ${rescueCharName} 命中可疑默认值（情感型 0.3 或 undefined），使用 ${llmSource} 弹窗抢救中...`);

        (async () => {
            try {
                const { detectPersonalityStyle } = await import('../utils/memoryPalace/digestion');
                const result = await detectPersonalityStyle(rescueCharId, rescueCharName, persona, llmForRescue);
                if (cancelled) return;
                try { localStorage.setItem(rescuedKey, '1'); } catch {}
                updateCharacter(rescueCharId, {
                    personalityStyle: result.style,
                    ruminationTendency: result.ruminationTendency,
                } as any);
                setPersonalityRescue({ open: true, charId: rescueCharId, charName: rescueCharName, phase: 'done', result });
            } catch (e: any) {
                if (cancelled) return;
                // 抢救失败不设 rescuedKey —— 下次打开聊天再试一次
                console.warn(`🛟 [PersonalityRescue] ${rescueCharName} 抢救失败:`, e?.message || e);
                setPersonalityRescue({ open: true, charId: rescueCharId, charName: rescueCharName, phase: 'failed', error: e?.message || String(e) });
            }
        })();

        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char?.id, (char as any)?.personalityStyle, (char as any)?.ruminationTendency, memoryPalaceConfig?.lightLLM?.baseUrl, memoryPalaceConfig?.lightLLM?.apiKey, apiConfig?.baseUrl, apiConfig?.apiKey]);

    const handleInputChange = (val: string) => {
        setInput(val);
        if (val.trim()) localStorage.setItem(draftKey, val);
        else localStorage.removeItem(draftKey);
    };

    useLayoutEffect(() => {
        if (!scrollRef.current || selectionMode) return;
        const currentLastId = messages.length > 0 ? messages[messages.length - 1].id : null;
        // Only auto-scroll when a new message is appended (ID changes),
        // not when loading older history or updating existing messages in-place
        if (currentLastId !== lastMsgIdRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            lastMsgIdRef.current = currentLastId;
        }
    }, [messages, activeCharacterId, selectionMode]);

    useEffect(() => {
        if (isTyping && scrollRef.current && !selectionMode) {
            const now = Date.now();
            if (now - scrollThrottleRef.current > 150) {
                scrollThrottleRef.current = now;
                scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
            }
        }
    }, [messages, isTyping, recallStatus, searchStatus, diaryStatus, selectionMode]);

    const formatTime = (ts: number) => {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    };

    // --- Actions ---

    const handleSendText = async (customContent?: string, customType?: MessageType, metadata?: any) => {
        if (!char || (!input.trim() && !customContent)) return;
        const text = customContent || input.trim();
        const type = customType || 'text';

        if (!customContent) { setInput(''); localStorage.removeItem(draftKey); }
        
        if (type === 'image') {
            const recentChat = messages.slice(-10).map(m => {
                const sender = m.role === 'user' ? userProfile.name : char.name;
                return `${sender}: ${m.content.substring(0, 100)}`;
            });
            await DB.saveGalleryImage({
                id: `img-${Date.now()}-${Math.random()}`,
                charId: char.id,
                url: text,
                timestamp: Date.now(),
                savedDate: new Date().toISOString().split('T')[0],
                chatContext: recentChat
            });
            addToast('图片已保存至相册', 'info');
        }

        const msgPayload: any = { charId: char.id, role: 'user', type, content: text, metadata };
        
        if (replyTarget) {
            msgPayload.replyTo = {
                id: replyTarget.id,
                content: replyTarget.content,
                name: replyTarget.role === 'user' ? '我' : char.name
            };
            setReplyTarget(null);
        }

        await DB.saveMessage(msgPayload);

        // Detect XHS link in user text and create xhs_card via MCP
        if (type === 'text') {
            const xhsUrlMatch = text.match(/xiaohongshu\.com\/(?:discovery\/item|explore)\/([a-f0-9]{24})/);
            const mcpUrl = realtimeConfig?.xhsMcpConfig?.serverUrl;
            if (xhsUrlMatch && mcpUrl && realtimeConfig?.xhsMcpConfig?.enabled) {
                const noteUrl = `https://www.xiaohongshu.com/explore/${xhsUrlMatch[1]}`;
                try {
                    const result = await XhsMcpClient.getNoteDetail(mcpUrl, noteUrl);
                    if (result.success && result.data) {
                        const note = normalizeNote(result.data);
                        await DB.saveMessage({
                            charId: char.id,
                            role: 'user',
                            type: 'xhs_card',
                            content: note.title || '小红书笔记',
                            metadata: { xhsNote: note }
                        });
                    }
                } catch (e) {
                    console.warn('XHS link fetch via MCP failed:', e);
                }
            }
        }

        await reloadMessages(visibleCountRef.current);
        setShowPanel('none');

        // Manual trigger only: Removed auto triggerAI call
    };

    const handleReroll = async () => {
        if (isTyping || messages.length === 0) return;

        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role !== 'assistant') return;

        const toDeleteIds: number[] = [];
        let index = messages.length - 1;
        while (index >= 0 && messages[index].role === 'assistant') {
            toDeleteIds.push(messages[index].id);
            index--;
        }

        if (toDeleteIds.length === 0) return;

        await DB.deleteMessages(toDeleteIds);
        discardVoiceForMessages(toDeleteIds);
        const newHistory = messages.slice(0, index + 1);
        setMessages(newHistory);
        addToast('回溯对话中...', 'info');

        triggerAI(newHistory);
    };

    const handleImageSelect = async (file: File) => {
        try {
            const base64 = await processImage(file, { maxWidth: 600, quality: 0.6, forceJpeg: true });
            setShowPanel('none');
            await handleSendText(base64, 'image');
        } catch (err: any) {
            addToast(err.message || '图片处理失败', 'error');
        }
    };

    const handlePanelAction = (type: string, payload?: any) => {
        switch (type) {
            case 'transfer': setModalType('transfer'); break;
            case 'poke': handleSendText('[戳一戳]', 'interaction'); break;
            case 'archive': setModalType('archive-settings'); break;
            case 'settings': setModalType('chat-settings'); break;
            case 'emoji-import': setModalType('emoji-import'); break;
            case 'send-emoji': if (payload) handleSendText(payload.url, 'emoji'); break;
            case 'delete-emoji-req': setSelectedEmoji(payload); setModalType('delete-emoji'); break;
            case 'add-category': setModalType('add-category'); break;
            case 'select-category': setActiveCategory(payload); break;
            case 'category-options': setSelectedCategory(payload); setModalType('category-options'); break;
            case 'delete-category-req': setSelectedCategory(payload); setModalType('delete-category'); break;
            case 'proactive': setShowProactiveModal(true); break;
            case 'emotion': setModalType('schedule'); break; // 情绪已并入日程，打开同一 modal
            case 'schedule': setModalType('schedule'); break;
        }
    };

    // --- Schedule Handlers ---
    const loadSchedule = async () => {
        if (!char) return;
        if (!isScheduleFeatureOn(char)) { setScheduleData(null); return; }
        const today = new Date().toISOString().split('T')[0];
        const s = await DB.getDailySchedule(char.id, today);
        setScheduleData(s);
    };

    // Load schedule when modal opens
    React.useEffect(() => {
        if (modalType === 'schedule') loadSchedule();
    }, [modalType]);

    const handleScheduleEdit = async (index: number, slot: ScheduleSlot) => {
        if (!scheduleData) return;
        const newSlots = [...scheduleData.slots];
        newSlots[index] = slot;
        const updated = { ...scheduleData, slots: newSlots };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
    };

    const handleScheduleDelete = async (index: number) => {
        if (!scheduleData) return;
        const newSlots = scheduleData.slots.filter((_, i) => i !== index);
        const updated = { ...scheduleData, slots: newSlots };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
    };

    const handleScheduleCoverChange = async (dataUrl: string) => {
        if (!scheduleData) return;
        const updated = { ...scheduleData, coverImage: dataUrl };
        setScheduleData(updated);
        await DB.saveDailySchedule(updated);
    };

    const generateDailySchedule = async (targetChar: typeof char, forceRegenerate: boolean = false) => {
        if (!targetChar || isScheduleGenerating) return;
        setIsScheduleGenerating(true);
        try {
            const result = await generateDailyScheduleForChar(targetChar, userProfile, apiConfig, forceRegenerate);
            if (result) setScheduleData(result);
        } catch (e) {
            console.error('[Schedule] Generation error:', e);
        } finally {
            setIsScheduleGenerating(false);
        }
    };

    const handleScheduleStyleChange = async (style: 'lifestyle' | 'mindful') => {
        if (!char) return;
        // 与情绪/意识流强制同步：启用日程时自动启用情绪感知
        const prevEmotion = char.emotionConfig;
        const nextEmotion = { ...(prevEmotion || {}), enabled: true };
        updateCharacter(char.id, { scheduleStyle: style, emotionConfig: nextEmotion });
        // Force regenerate with new style — use updated char object
        const updatedChar = { ...char, scheduleStyle: style, emotionConfig: nextEmotion };
        if (!isScheduleFeatureOn(updatedChar)) return;
        setIsScheduleGenerating(true);
        try {
            const result = await generateDailyScheduleForChar(updatedChar, userProfile, apiConfig, true);
            if (result) setScheduleData(result);
        } catch (e) {
            console.error('[Schedule] Regeneration after style change failed:', e);
        } finally {
            setIsScheduleGenerating(false);
        }
    };

    // 日程 / 情绪 buff 总开关
    // 关闭：清空前台 scheduleData，同时清空可能已缓存的 buff 注入（防止继续污染下一轮 prompt）
    // 打开：若还没生成今日日程，立即生成一次
    const handleToggleScheduleFeature = async () => {
        if (!char) return;
        const nextEnabled = !isScheduleFeatureOn(char);
        const patch: any = { scheduleFeatureEnabled: nextEnabled };
        if (!nextEnabled) {
            // 关闭时顺手把 buff 注入清空，避免上一轮残留继续注入
            patch.buffInjection = '';
            patch.activeBuffs = [];
        }
        updateCharacter(char.id, patch);
        if (!nextEnabled) {
            setScheduleData(null);
            addToast('日程与情绪已关闭', 'info');
            return;
        }
        addToast('日程与情绪已开启', 'success');
        // 打开后立刻尝试生成（若今日未生成且已选风格）
        const updatedChar = { ...char, ...patch };
        if (updatedChar.scheduleStyle) {
            const today = new Date().toISOString().split('T')[0];
            const existing = await DB.getDailySchedule(char.id, today).catch(() => null);
            if (existing) {
                setScheduleData(existing);
            } else {
                generateDailySchedule(updatedChar, false);
            }
        }
    };

    // --- Modal Handlers ---

    const handleAddCategory = async () => {
        if (!newCategoryName.trim()) {
             addToast('请输入分类名称', 'error');
             return;
        }
        const newCat = { id: `cat-${Date.now()}`, name: newCategoryName.trim() };
        await DB.saveEmojiCategory(newCat);
        await loadEmojiData();
        setActiveCategory(newCat.id);
        setModalType('none');
        setNewCategoryName('');
        addToast('分类创建成功', 'success');
    };

    const handleImportEmoji = async () => {
        if (!emojiImportText.trim()) return;
        const lines = emojiImportText.split('\n');
        const targetCatId = activeCategory === 'default' ? undefined : activeCategory;

        for (const line of lines) {
            const parts = line.split('--');
            if (parts.length >= 2) {
                const name = parts[0].trim();
                const url = parts.slice(1).join('--').trim();
                if (name && url) {
                    await DB.saveEmoji(name, url, targetCatId);
                }
            }
        }
        await loadEmojiData();
        setModalType('none');
        setEmojiImportText('');
        addToast('表情包导入成功', 'success');
    };

    const handleDeleteCategory = async () => {
        if (!selectedCategory) return;
        await DB.deleteEmojiCategory(selectedCategory.id);
        await loadEmojiData();
        setActiveCategory('default');
        setModalType('none');
        setSelectedCategory(null);
        addToast('分类及包含表情已删除', 'success');
    };

    const handleSaveCategoryVisibility = async (categoryId: string, allowedCharacterIds: string[] | undefined) => {
        const cat = categories.find(c => c.id === categoryId);
        if (!cat) return;
        await DB.saveEmojiCategory({ ...cat, allowedCharacterIds });
        await loadEmojiData();
        setSelectedCategory(null);
        addToast(allowedCharacterIds ? `已设置 ${allowedCharacterIds.length} 个角色可见` : '已设为所有角色可见', 'success');
    };

    const handleSavePrompt = () => {
        if (!editingPrompt || !editingPrompt.name.trim() || !editingPrompt.content.trim()) {
            addToast('请填写完整', 'error');
            return;
        }
        setArchivePrompts(prev => {
            let next;
            if (prev.some(p => p.id === editingPrompt.id)) {
                next = prev.map(p => p.id === editingPrompt.id ? editingPrompt : p);
            } else {
                next = [...prev, editingPrompt];
            }
            const customOnly = next.filter(p => !p.id.startsWith('preset_'));
            localStorage.setItem('chat_archive_prompts', JSON.stringify(customOnly));
            return next;
        });
        setSelectedPromptId(editingPrompt.id);
        setModalType('archive-settings');
        setEditingPrompt(null);
    };

    const handleDeletePrompt = (id: string) => {
        if (id.startsWith('preset_')) {
            addToast('默认预设不可删除', 'error');
            return;
        }
        setArchivePrompts(prev => {
            const next = prev.filter(p => p.id !== id);
            const customOnly = next.filter(p => !p.id.startsWith('preset_'));
            localStorage.setItem('chat_archive_prompts', JSON.stringify(customOnly));
            return next;
        });
        if (selectedPromptId === id) setSelectedPromptId('preset_rational');
        addToast('预设已删除', 'success');
    };

    const createNewPrompt = () => {
        setEditingPrompt({ id: `custom_${Date.now()}`, name: '新预设', content: DEFAULT_ARCHIVE_PROMPTS[0].content });
        setModalType('prompt-editor');
    };

    const editSelectedPrompt = () => {
        const p = archivePrompts.find(a => a.id === selectedPromptId);
        if (!p) return;
        if (p.id.startsWith('preset_')) {
            setEditingPrompt({ id: `custom_${Date.now()}`, name: `${p.name} (Copy)`, content: p.content });
        } else {
            setEditingPrompt({ ...p });
        }
        setModalType('prompt-editor');
    };

    const handleBgUpload = async (file: File) => {
        try {
            const dataUrl = await processImage(file, { skipCompression: true });
            updateCharacter(char.id, { chatBackground: dataUrl });
            addToast('聊天背景已更新', 'success');
        } catch(err: any) {
            addToast(err.message, 'error');
        }
    };

    const saveSettings = () => {
        updateCharacter(char.id, { 
            contextLimit: settingsContextLimit,
            hideSystemLogs: settingsHideSysLogs
        });
        setModalType('none');
        addToast('设置已保存', 'success');
    };

    const handleClearHistory = async () => {
        if (!char) return;

        // 记忆宫殿安全检查：如果角色启用了记忆宫殿，检查是否有未被向量化处理的消息
        if (char.memoryPalaceEnabled) {
            const hwm = await getMemoryPalaceHWM(char.id);
            const allMessages = await DB.getMessagesByCharId(char.id, true);
            const textMessages = allMessages.filter(m => m.type === 'text' && m.content?.trim());
            const unprocessedCount = textMessages.filter(m => m.id > hwm).length;

            if (unprocessedCount > 0) {
                // 有未处理的消息，弹出选择对话框
                const processedMsgs = allMessages.filter(m => m.id <= hwm);
                const choice = confirm(
                    `⚠️ 记忆宫殿提醒\n\n` +
                    `当前有 ${unprocessedCount} 条聊天记录尚未被记忆宫殿处理（向量化）。\n` +
                    `直接清空会导致这些记录永久丢失，无法被角色记住。\n\n` +
                    `点击「确定」→ 仅删除已被记忆宫殿处理过的记录（安全）\n` +
                    `点击「取消」→ 取消清空操作\n\n` +
                    `（看不懂在问什么的话就点确定）`
                );

                if (!choice) {
                    return; // 用户取消
                }

                // 安全删除：只删除高水位之前的消息
                if (processedMsgs.length === 0) {
                    addToast('没有已处理的记录可以删除', 'info');
                    return;
                }
                const processedIds = processedMsgs.map(m => m.id);
                await DB.deleteMessages(processedIds);
                discardVoiceForMessages(processedIds);
                const remaining = allMessages.filter(m => m.id > hwm);
                setMessages(remaining.slice(-200));
                setTotalMsgCount(remaining.length);
                setVisibleCount(LOAD_BATCH_SIZE);
                visibleCountRef.current = LOAD_BATCH_SIZE;
                addToast(`已安全清理 ${processedMsgs.length} 条已处理记录，保留 ${remaining.length} 条未处理记录`, 'success');
                setModalType('none');
                return;
            }
        }

        // 原有逻辑（无记忆宫殿 or 所有消息已处理）
        if (preserveContext) {
            const allMessages = await DB.getMessagesByCharId(char.id, true);
            const toKeep = allMessages.slice(-10);
            const toKeepIds = new Set(toKeep.map(m => m.id));
            const toDelete = allMessages.filter(m => !toKeepIds.has(m.id));
            if (toDelete.length === 0) {
                addToast('消息太少，无需清理', 'info');
                return;
            }
            const toDeleteIds = toDelete.map(m => m.id);
            await DB.deleteMessages(toDeleteIds);
            discardVoiceForMessages(toDeleteIds);
            setMessages(toKeep);
            setTotalMsgCount(toKeep.length);
            setVisibleCount(LOAD_BATCH_SIZE);
            visibleCountRef.current = LOAD_BATCH_SIZE;
            addToast(`已清理 ${toDelete.length} 条历史，保留最近10条`, 'success');
        } else {
            const allIds = (await DB.getMessagesByCharId(char.id, true)).map(m => m.id);
            await DB.clearMessages(char.id);
            discardVoiceForMessages(allIds);
            setMessages([]);
            setTotalMsgCount(0);
            setVisibleCount(LOAD_BATCH_SIZE);
            visibleCountRef.current = LOAD_BATCH_SIZE;
            addToast('已清空', 'success');
        }
        setModalType('none');
    };

    const handleForceVectorize = async () => {
        if (!char || !char.memoryPalaceEnabled || isVectorizing) return;
        const mpEmb = memoryPalaceConfig?.embedding;
        const mpLLM = memoryPalaceConfig?.lightLLM;
        if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM?.baseUrl) {
            addToast('请先在记忆宫殿设置中配置 API', 'error');
            return;
        }

        setIsVectorizing(true);
        setModalType('none');
        addToast('🏰 开始向量化所有聊天记录...', 'info');

        try {
            const { processNewMessages, getMemoryPalaceHighWaterMark, mergePalaceFragmentsIntoMemories } = await import('../utils/memoryPalace/pipeline');
            const BATCH_PROCESS_RATIO = 0.85;
            const BATCH_SIZE = 170; // 200 * 0.85
            let totalProcessed = 0;
            let round = 0;
            const MAX_ROUNDS = 50; // 安全上限
            // 每轮合并进来的 palace MemoryFragment；全部处理完后一次性 updateCharacter
            let accumulatedMemories = char.memories ? [...char.memories] : [];
            let latestHideBefore = char.hideBeforeMessageId;

            while (round < MAX_ROUNDS) {
                round++;
                const hwm = getMemoryPalaceHighWaterMark(char.id);
                const allMessages = await DB.getMessagesByCharId(char.id, true);
                const textMessages = allMessages
                    .filter(m => m.type === 'text' && m.content?.trim())
                    .sort((a, b) => a.id - b.id);

                // 计算未处理的消息
                const unprocessed = textMessages.filter(m => m.id > hwm);
                if (unprocessed.length < 10) break; // 剩余太少，停止

                // 取一批处理
                const batch = unprocessed.slice(0, BATCH_SIZE);
                console.log(`🏰 [ForceVectorize] 第 ${round} 轮：处理 ${batch.length} 条消息（hwm=${hwm}，剩余 ${unprocessed.length}）`);

                const pipelineResult = await processNewMessages(batch, char.id, char.name, mpEmb, mpLLM, userProfile?.name || '', true);

                // 软跳过：缓冲区还没到阈值 / 热区还没被挤出 / 已有任务在跑 —— 不是 LLM 失败
                if (pipelineResult?.skipReason) {
                    if (pipelineResult.skipReason !== 'lock') {
                        addToast('当前聊天不足以触发总结，请保持这个状态聊天~', 'info');
                    }
                    break;
                }

                totalProcessed += batch.length;

                // 累积自动归档，统一在循环结束后 updateCharacter
                // 避免每轮 setState 触发 char 对象重建进而 dep 失效
                // 仅在 char.autoArchiveEnabled 开启时累积；未开启则 palace 仍向量化，但不推 hideBefore
                if (pipelineResult?.autoArchive && (char as any).autoArchiveEnabled) {
                    accumulatedMemories = mergePalaceFragmentsIntoMemories(
                        accumulatedMemories,
                        pipelineResult.autoArchive.fragments,
                    );
                    latestHideBefore = pipelineResult.autoArchive.hideBeforeMessageId;
                }

                // 检查高水位是否前进了（如果没前进说明 LLM 失败了）
                const newHwm = getMemoryPalaceHighWaterMark(char.id);
                if (newHwm <= hwm) {
                    addToast('⚠️ 处理中断：LLM 提取失败，请检查副 API 配置', 'error');
                    break;
                }
            }

            // 循环结束后把累积的自动归档一次性写回角色
            if (latestHideBefore !== char.hideBeforeMessageId || accumulatedMemories.length !== (char.memories?.length || 0)) {
                updateCharacter(char.id, {
                    memories: accumulatedMemories,
                    hideBeforeMessageId: latestHideBefore,
                } as any);
            }

            if (totalProcessed > 0) {
                addToast(`✅ 向量化完成：${round} 轮处理了约 ${totalProcessed} 条消息`, 'success');
            } else {
                addToast('所有聊天记录都已处理完毕，无需操作', 'info');
            }
        } catch (e: any) {
            addToast(`❌ 向量化失败：${e.message}`, 'error');
        } finally {
            setIsVectorizing(false);
        }
    };

    const handleSetHistoryStart = (messageId: number | undefined) => {
        updateCharacter(char.id, { hideBeforeMessageId: messageId });
        setModalType('none');
        addToast(messageId ? '已隐藏历史消息' : '已恢复全部历史记录', 'success');
    };

    const handleFullArchive = async () => {
        if (!apiConfig.apiKey || !char) {
            addToast('请先配置 API Key', 'error');
            return;
        }
        const allMessages = await DB.getMessagesByCharId(char.id, true);
        const msgsByDate: Record<string, Message[]> = {};
        allMessages
        .filter(m => !char.hideBeforeMessageId || m.id >= char.hideBeforeMessageId)
        .forEach(m => {
            const d = new Date(m.timestamp);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (!msgsByDate[dateStr]) msgsByDate[dateStr] = [];
            msgsByDate[dateStr].push(m);
        });

        const datesToProcess = Object.keys(msgsByDate).sort();
        if (datesToProcess.length === 0) {
            addToast('聊天记录为空，无法归档', 'info');
            return;
        }

        setIsSummarizing(true);
        setShowPanel('none');
        setArchiveProgress(`准备归档 ${datesToProcess.length} 天...`);
        addToast(`开始归档 ${datesToProcess.length} 天聊天记录`, 'info');

        try {
            let processedCount = 0;
            const newMemories: MemoryFragment[] = [];
            const templateObj = archivePrompts.find(p => p.id === selectedPromptId) || DEFAULT_ARCHIVE_PROMPTS[0];
            const template = templateObj.content;

            for (let idx = 0; idx < datesToProcess.length; idx++) {
                const dateStr = datesToProcess[idx];
                setArchiveProgress(`归档中 ${dateStr} (${idx + 1}/${datesToProcess.length})`);
                const dayMsgs = msgsByDate[dateStr];
                const rawLog = dayMsgs
                    .map(m => formatMessageWithTime(m, char.name, userProfile.name, formatTime))
                    .join('\n');
                
                let prompt = template;
                prompt = prompt.replace(/\$\{dateStr\}/g, dateStr);
                prompt = prompt.replace(/\$\{char\.name\}/g, char.name);
                prompt = prompt.replace(/\$\{userProfile\.name\}/g, userProfile.name);
                prompt = prompt.replace(/\$\{rawLog.*?\}/g, rawLog.substring(0, 200000));

                const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: [{ role: "user", content: prompt }],
                        temperature: 0.5,
                        max_tokens: 8000 
                    })
                });

                if (!response.ok) throw new Error(`API Error on ${dateStr}`);
                const data = await safeResponseJson(response);
                let summary = extractContent(data);
                summary = summary.replace(/^["']|["']$/g, '').trim();

                if (summary) {
                    newMemories.push({ id: `mem-${Date.now()}-${idx}`, date: dateStr, summary: summary, mood: 'archive' });
                    processedCount++;
                }
                await new Promise(r => setTimeout(r, 500));
            }

            const total = datesToProcess.length;

            if (processedCount === 0) {
                addToast(`归档失败：${total} 天均未生成摘要（请检查 API/模型）`, 'error');
                setModalType('none');
            } else {
                const finalMemories = [...(char.memories || []), ...newMemories];

                // 关键修复：全量归档成功后把 hideBeforeMessageId 推到"倒数第 reserve 条"的位置。
                // 不推的话下次再点归档，hideBefore 过滤没作用，之前已归档的几天会被重总结一遍，
                // 往 char.memories 里堆重复条目。保留最近 max(100, 15%) 条不隐藏（和 palace
                // auto-archive 的 hot-zone 概念对齐），这样聊天 UI 不会突然空掉。
                //
                // 部分失败时不推 hideBefore —— 那几天的原消息没写进 MemoryFragment，推了
                // 就真的读不到了。用户下次重试归档会把失败的那几天补上。
                let newHideBefore = char.hideBeforeMessageId;
                let reservedCount = 0;
                let hiddenCount = 0;
                if (processedCount === total) {
                    const allArchivedMsgs: Message[] = [];
                    for (const d of datesToProcess) allArchivedMsgs.push(...msgsByDate[d]);
                    allArchivedMsgs.sort((a, b) => a.id - b.id);
                    const RESERVE = Math.max(100, Math.ceil(allArchivedMsgs.length * 0.15));
                    if (allArchivedMsgs.length > RESERVE) {
                        const candidate = allArchivedMsgs[allArchivedMsgs.length - RESERVE].id;
                        // 只前进不后退
                        if (!char.hideBeforeMessageId || candidate > char.hideBeforeMessageId) {
                            newHideBefore = candidate;
                            reservedCount = RESERVE;
                            hiddenCount = allArchivedMsgs.length - RESERVE;
                        }
                    }
                }

                const updates: Partial<typeof char> = { memories: finalMemories };
                if (newHideBefore !== char.hideBeforeMessageId) {
                    (updates as any).hideBeforeMessageId = newHideBefore;
                }
                updateCharacter(char.id, updates as any);

                const hideStr = hiddenCount > 0
                    ? `（已隐藏 ${hiddenCount} 条旧消息，保留最近 ${reservedCount} 条可见）`
                    : '';
                if (processedCount < total) {
                    addToast(`归档完成：${processedCount}/${total} 天成功（部分失败，下次再点会补上）`, 'info');
                } else {
                    addToast(`归档完成：成功归档 ${processedCount} 天${hideStr}`, 'success');
                }
                setModalType('none');
            }

        } catch (e: any) {
            addToast(`归档中断: ${e.message}`, 'error');
        } finally {
            setIsSummarizing(false);
            setArchiveProgress('');
        }
    };

    // --- Message Management ---
    const handleDeleteMessage = async () => {
        if (!selectedMessage) return;
        const deletedId = selectedMessage.id;
        await DB.deleteMessage(deletedId);
        discardVoiceForMessages([deletedId]);
        setMessages(prev => prev.filter(m => m.id !== deletedId));
        setTotalMsgCount(prev => Math.max(0, prev - 1));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已删除', 'success');
    };

    const confirmEditMessage = async () => {
        if (!selectedMessage) return;
        await DB.updateMessage(selectedMessage.id, editContent);
        setMessages(prev => prev.map(m => m.id === selectedMessage.id ? { ...m, content: editContent } : m));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已修改', 'success');
    };

    const handleReplyMessage = () => {
        if (!selectedMessage) return;
        setReplyTarget({
            ...selectedMessage,
            metadata: { ...selectedMessage.metadata, senderName: selectedMessage.role === 'user' ? '我' : char.name }
        });
        setModalType('none');
    };

    const handleCopyMessage = () => {
        if (!selectedMessage) return;
        navigator.clipboard.writeText(selectedMessage.content);
        setModalType('none');
        setSelectedMessage(null);
        addToast('已复制到剪贴板', 'success');
    };

    const handleDeleteEmoji = async () => {
        if (!selectedEmoji) return;
        await DB.deleteEmoji(selectedEmoji.name);
        await loadEmojiData();
        setModalType('none');
        setSelectedEmoji(null);
        addToast('表情包已删除', 'success');
    };

    // --- Batch Selection ---
    const handleEnterSelectionMode = () => {
        if (selectedMessage) {
            setSelectedMsgIds(new Set([selectedMessage.id]));
            setSelectionMode(true);
            setModalType('none');
            setSelectedMessage(null);
        }
    };

    const toggleMessageSelection = useCallback((id: number) => {
        setSelectedMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // Memoized callbacks for MessageItem to avoid busting React.memo
    const handleMessageLongPress = useCallback((msg: Message) => {
        setSelectedMessage(msg);
        setModalType('message-options');
    }, []);

    const handleBatchDelete = async () => {
        if (selectedMsgIds.size === 0) return;
        const deleteCount = selectedMsgIds.size;
        const ids = Array.from(selectedMsgIds);
        await DB.deleteMessages(ids);
        discardVoiceForMessages(ids);
        setMessages(prev => prev.filter(m => !selectedMsgIds.has(m.id)));
        setTotalMsgCount(prev => Math.max(0, prev - deleteCount));
        addToast(`已删除 ${deleteCount} 条消息`, 'success');
        setSelectionMode(false);
        setSelectedMsgIds(new Set());
    };

    // --- Forward Chat Records ---
    const [showForwardModal, setShowForwardModal] = useState(false);

    const handleForwardSelected = () => {
        if (selectedMsgIds.size === 0) return;
        setShowForwardModal(true);
    };

    const handleForwardToCharacter = async (targetCharId: string) => {
        if (!char) return;
        const selectedMsgs = messages
            .filter(m => selectedMsgIds.has(m.id))
            .sort((a, b) => a.id - b.id);

        if (selectedMsgs.length === 0) return;

        // Build preview text (first few messages)
        const previewLines = selectedMsgs.slice(0, 4).map(m => {
            const sender = m.role === 'user' ? userProfile.name : char.name;
            const text = m.type === 'text' ? m.content.slice(0, 30) : `[${m.type === 'image' ? '图片' : m.type === 'emoji' ? '表情' : m.type}]`;
            return `${sender}: ${text}`;
        });
        if (selectedMsgs.length > 4) previewLines.push(`... 共 ${selectedMsgs.length} 条消息`);

        const forwardData = {
            fromUserName: userProfile.name,
            fromCharName: char.name,
            count: selectedMsgs.length,
            preview: previewLines,
            messages: selectedMsgs.map(m => ({
                role: m.role,
                type: m.type,
                content: m.content,
                timestamp: m.timestamp || Date.now()
            }))
        };

        // Save forward card to target character's chat
        await DB.saveMessage({
            charId: targetCharId,
            role: 'user',
            type: 'chat_forward' as MessageType,
            content: JSON.stringify(forwardData),
        });

        // Also save a copy in the current chat so the user can see what they forwarded
        const targetChar = characters.find(c => c.id === targetCharId);
        if (char.id !== targetCharId) {
            await DB.saveMessage({
                charId: char.id,
                role: 'system',
                type: 'text' as MessageType,
                content: `[转发了 ${selectedMsgs.length} 条聊天记录给 ${targetChar?.name || ''}]`,
            });
            // Refresh messages to show the forwarding system message
            reloadMessages(visibleCountRef.current);
        }

        addToast(`已转发 ${selectedMsgs.length} 条记录给 ${targetChar?.name || ''}`, 'success');
        setShowForwardModal(false);
        setSelectionMode(false);
        setSelectedMsgIds(new Set());
    };

    const displayMessages = useMemo(() => messages
        .filter(m => m.metadata?.source !== 'date' && m.metadata?.source !== 'call')
        .filter(m => !m.metadata?.proactiveHint) // Hide proactive system hints
        .filter(m => !char?.hideBeforeMessageId || m.id >= char.hideBeforeMessageId)
        .filter(m => { if (char?.hideSystemLogs && m.role === 'system' && m.type !== 'score_card') return false; return true; })
        .slice(-visibleCount),
        [messages, char?.id, char?.hideBeforeMessageId, char?.hideSystemLogs, visibleCount]);

    const collapsedCount = Math.max(0, totalMsgCount - displayMessages.length);

    // Reset active category if it becomes invisible for the current character
    useEffect(() => {
        if (activeCategory !== 'default' && visibleCategories.length > 0 && !visibleCategories.some(c => c.id === activeCategory)) {
            setActiveCategory('default');
        }
    }, [visibleCategories, activeCategory]);

    // Build a set of hidden category IDs for quick lookup
    const hiddenCategoryIds = useMemo(() => {
        const visible = new Set(visibleCategories.map(c => c.id));
        return new Set(categories.filter(c => !visible.has(c.id)).map(c => c.id));
    }, [categories, visibleCategories]);

    // Memoize filtered emojis for ChatInputArea
    const filteredEmojis = useMemo(() => emojis.filter(e => {
        // Exclude emojis from hidden categories
        if (e.categoryId && hiddenCategoryIds.has(e.categoryId)) return false;
        if (activeCategory === 'default') return !e.categoryId || e.categoryId === 'default';
        return e.categoryId === activeCategory;
    }), [emojis, activeCategory, hiddenCategoryIds]);

    // Memoize ChatInputArea callbacks
    const handleSendCallback = useCallback(() => handleSendText(), [char, input, replyTarget]);
    const handleCharSelectCallback = useCallback((id: string) => { setActiveCharacterId(id); setShowPanel('none'); }, []);
    const chatChromeStyle = osTheme.chatChromeStyle || 'soft';
    const chatBackgroundStyle = osTheme.chatBackgroundStyle || 'plain';
    const chatRootClass =
        chatChromeStyle === 'pixel'
            ? 'flex flex-col h-full bg-[#efe1cf] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
            : chatChromeStyle === 'flat'
              ? 'flex flex-col h-full bg-white overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
              : chatChromeStyle === 'floating'
                ? 'flex flex-col h-full bg-[#eef2ff] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500'
                : 'flex flex-col h-full bg-[#f1f5f9] overflow-hidden relative font-sans transition-[background-image,background-color] duration-500';
    const chatRootStyle: React.CSSProperties = char.chatBackground
        ? {
            backgroundImage: `url(${char.chatBackground})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
        }
        : chatBackgroundStyle === 'grid'
          ? {
              backgroundColor: chatChromeStyle === 'pixel' ? '#efe1cf' : '#f8fafc',
              backgroundImage:
                  'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
              backgroundSize: '20px 20px',
            }
          : chatBackgroundStyle === 'paper'
            ? {
                backgroundColor: chatChromeStyle === 'pixel' ? '#f4e8d9' : '#f9f7f2',
                backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.12) 1px, transparent 0)',
                backgroundSize: '16px 16px',
              }
            : chatBackgroundStyle === 'mesh'
              ? {
                  backgroundColor: '#f8fafc',
                  backgroundImage:
                      'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
                }
              : {
                  backgroundImage: 'none',
                };

    return (
        <div 
            className={chatRootClass}
            style={chatRootStyle}
        >
             {activeTheme.customCss && <style>{activeTheme.customCss}</style>}

             {/* 记忆整理中 — 顶部浮动胶囊（不阻塞交互，轻量无 backdrop-filter） */}
             {memoryPalaceStatus && (
                 <div
                     className="absolute top-[76px] left-1/2 z-[150] animate-fade-in"
                     style={{
                         transform: 'translateX(-50%)',
                         pointerEvents: 'none',
                         willChange: 'transform, opacity',
                     }}
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
                             {char?.name || '角色'}正在沉思
                         </span>
                         <span className="text-[10px] text-slate-400 truncate">{memoryPalaceStatus}</span>
                     </div>
                 </div>
             )}


             {/* 记忆整理结果 — 弹窗（高级感） */}
             {memoryPalaceResult && (
                 <div
                     className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                     style={{
                         pointerEvents: 'all',
                         background: 'rgba(15,23,42,0.55)',
                     }}
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
                                     {memoryPalaceResult.batches.filter(b => !b.ok).map(b => `batch ${b.index} 失败`).join(', ')}
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
                                                 {meta.label}
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

             <ChatModals
                modalType={modalType} setModalType={setModalType}
                transferAmt={transferAmt} setTransferAmt={setTransferAmt}
                emojiImportText={emojiImportText} setEmojiImportText={setEmojiImportText}
                settingsContextLimit={settingsContextLimit} setSettingsContextLimit={setSettingsContextLimit}
                settingsHideSysLogs={settingsHideSysLogs} setSettingsHideSysLogs={setSettingsHideSysLogs}
                preserveContext={preserveContext} setPreserveContext={setPreserveContext}
                editContent={editContent} setEditContent={setEditContent}
                archivePrompts={archivePrompts} selectedPromptId={selectedPromptId} setSelectedPromptId={(id: string) => {
                    setSelectedPromptId(id);
                    // 同步写 localStorage，让 palace extraction 的风格追加能读到最新选择
                    try { localStorage.setItem('chat_active_archive_prompt_id', id); } catch {}
                }}
                editingPrompt={editingPrompt} setEditingPrompt={setEditingPrompt} isSummarizing={isSummarizing} archiveProgress={archiveProgress}
                selectedMessage={selectedMessage} selectedEmoji={selectedEmoji} activeCharacter={char} messages={messages}
                allHistoryMessages={allHistoryMessages}
                
                newCategoryName={newCategoryName} setNewCategoryName={setNewCategoryName} onAddCategory={handleAddCategory}
                selectedCategory={selectedCategory}

                onTransfer={() => { if(transferAmt) handleSendText(`[转账]`, 'transfer', { amount: transferAmt }); setModalType('none'); }}
                onImportEmoji={handleImportEmoji}
                onSaveSettings={saveSettings} onBgUpload={handleBgUpload} onRemoveBg={() => updateCharacter(char.id, { chatBackground: undefined })}
                onClearHistory={handleClearHistory} onArchive={handleFullArchive}
                onCreatePrompt={createNewPrompt} onEditPrompt={editSelectedPrompt} onSavePrompt={handleSavePrompt} onDeletePrompt={handleDeletePrompt}
                onSetHistoryStart={handleSetHistoryStart} onEnterSelectionMode={handleEnterSelectionMode}
                onReplyMessage={handleReplyMessage} onEditMessageStart={() => { if (selectedMessage) { setEditContent(selectedMessage.content); setModalType('edit-message'); } }}
                onConfirmEditMessage={confirmEditMessage} onDeleteMessage={handleDeleteMessage} onCopyMessage={handleCopyMessage} onDeleteEmoji={handleDeleteEmoji} onDeleteCategory={handleDeleteCategory}
                allCharacters={characters} onSaveCategoryVisibility={handleSaveCategoryVisibility}
                translationEnabled={translationEnabled}
                onToggleTranslation={() => { const next = !translationEnabled; setTranslationEnabled(next); localStorage.setItem(`chat_translate_enabled_${activeCharacterId}`, JSON.stringify(next)); if (!next) { setShowingTargetIds(new Set()); } }}
                translateSourceLang={translateSourceLang}
                translateTargetLang={translateTargetLang}
                onSetTranslateSourceLang={(lang: string) => { setTranslateSourceLang(lang); localStorage.setItem('chat_translate_source_lang', lang); setShowingTargetIds(new Set()); }}
                onSetTranslateLang={(lang: string) => { setTranslateTargetLang(lang); localStorage.setItem('chat_translate_lang', lang); setShowingTargetIds(new Set()); }}
                xhsEnabled={!!char.xhsEnabled}
                onToggleXhs={() => updateCharacter(char.id, { xhsEnabled: !char.xhsEnabled })}
                chatVoiceEnabled={!!char.chatVoiceEnabled}
                onToggleChatVoice={() => updateCharacter(char.id, { chatVoiceEnabled: !char.chatVoiceEnabled })}
                chatVoiceLang={char.chatVoiceLang || ''}
                onSetChatVoiceLang={(lang: string) => updateCharacter(char.id, { chatVoiceLang: lang })}
                voiceAvailable={!!(char.voiceProfile?.voiceId || char.voiceProfile?.timberWeights?.length)}
                onGenerateVoice={selectedMessage ? () => handleManualTts(selectedMessage) : undefined}
                scheduleData={scheduleData}
                isScheduleGenerating={isScheduleGenerating}
                onScheduleEdit={handleScheduleEdit}
                onScheduleDelete={handleScheduleDelete}
                onScheduleReroll={() => generateDailySchedule(char, true)}
                onScheduleCoverChange={handleScheduleCoverChange}
                onScheduleStyleChange={handleScheduleStyleChange}
                isScheduleFeatureEnabled={isScheduleFeatureOn(char)}
                onToggleScheduleFeature={handleToggleScheduleFeature}
                isMemoryPalaceEnabled={!!char.memoryPalaceEnabled}
                isVectorizing={isVectorizing}
                onForceVectorize={handleForceVectorize}
                apiPresets={apiPresets}
                onAddApiPreset={addApiPreset}
                onSaveEmotion={(config) => {
                    updateCharacter(char.id, { emotionConfig: config });
                }}
                onClearBuffs={() => {
                    updateCharacter(char.id, { activeBuffs: [], buffInjection: '' });
                    addToast('情绪状态已清除', 'info');
                }}
             />
             
             <ChatHeader
                selectionMode={selectionMode}
                selectedCount={selectedMsgIds.size}
                onCancelSelection={() => { setSelectionMode(false); setSelectedMsgIds(new Set()); }}
                activeCharacter={char}
                isTyping={isTyping}
                isSummarizing={isSummarizing}
                isEmotionEvaluating={emotionStatus === 'evaluating'}
                isMemoryPalaceProcessing={!!memoryPalaceStatus}
                memoryPalaceStatusText={memoryPalaceStatus}
                lastTokenUsage={lastTokenUsage}
                tokenBreakdown={tokenBreakdown}
                onClose={closeApp}
                onTriggerAI={() => triggerAI(messages)}
                onShowCharsPanel={() => setShowPanel('chars')}
                onDeleteBuff={(buffId) => {
                    const currentBuffs = char.activeBuffs || [];
                    const newBuffs = currentBuffs.filter(b => b.id !== buffId);
                    const newInjection = '';
                    updateCharacter(char.id, { activeBuffs: newBuffs, buffInjection: newInjection });
                    addToast('已删除该情绪状态', 'info');
                }}
                headerStyle={osTheme.chatHeaderStyle}
                avatarShape={osTheme.chatAvatarShape}
                headerAlign={osTheme.chatHeaderAlign}
                headerDensity={osTheme.chatHeaderDensity}
                statusStyle={osTheme.chatStatusStyle}
                chromeStyle={osTheme.chatChromeStyle}
             />

            {/* 认知消化结果弹窗 — 全屏玻璃拟态 */}
            {lastDigestResult && (() => {
                const r = lastDigestResult;
                const groups: Array<{
                    key: string;
                    label: string;
                    icon: string;
                    accent: string;       // base hue for chip/dot
                    items: Array<{ content: string; sub?: string }>;
                }> = [];
                if (r.resolved.length) groups.push({ key: 'resolved', label: '困惑化解', icon: '🕊️', accent: '#10b981', items: r.resolved.map(e => ({ content: e.content })) });
                if (r.deepened.length) groups.push({ key: 'deepened', label: '创伤加深', icon: '💢', accent: '#f43f5e', items: r.deepened.map(e => ({ content: e.content })) });
                if (r.internalized.length) groups.push({ key: 'internalized', label: '知识内化', icon: '🪞', accent: '#8b5cf6', items: r.internalized.map(e => ({ content: e.content })) });
                if (r.selfInsights.length) groups.push({ key: 'insights', label: '自我领悟', icon: '💡', accent: '#f59e0b', items: r.selfInsights.map(t => ({ content: t })) });
                if (r.selfConfused.length) groups.push({ key: 'confused', label: '新的自我困惑', icon: '🌀', accent: '#6366f1', items: r.selfConfused.map(e => ({ content: e.content })) });
                if (r.synthesizedUser.length) groups.push({ key: 'synth', label: '用户认知整合', icon: '👤', accent: '#0ea5e9', items: r.synthesizedUser.map(e => ({ content: e.content, sub: e.category })) });
                if (r.fulfilled.length) groups.push({ key: 'fulfilled', label: '期盼实现', icon: '✨', accent: '#22c55e', items: r.fulfilled.map(e => ({ content: e.content })) });
                if (r.disappointed.length) groups.push({ key: 'disappointed', label: '期盼落空', icon: '🍂', accent: '#94a3b8', items: r.disappointed.map(e => ({ content: e.content })) });
                if (r.faded.length) groups.push({ key: 'faded', label: '淡忘', icon: '🌫️', accent: '#cbd5e1', items: r.faded.map(e => ({ content: e.content })) });
                if (groups.length === 0) return null;
                return (
                    <div
                        className="absolute inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in"
                        style={{
                            background: 'radial-gradient(ellipse at top, rgba(16,185,129,0.18), rgba(0,0,0,0.55))',
                            backdropFilter: 'blur(10px)',
                            WebkitBackdropFilter: 'blur(10px)',
                        }}
                        onClick={() => setLastDigestResult(null)}
                    >
                        <div
                            className="w-full max-w-sm max-h-[85vh] overflow-hidden flex flex-col relative"
                            style={{
                                background: 'linear-gradient(160deg, rgba(255,255,255,0.98) 0%, rgba(240,253,250,0.96) 100%)',
                                borderRadius: 28,
                                border: '1px solid rgba(255,255,255,0.7)',
                                boxShadow: '0 30px 80px -20px rgba(16,185,129,0.35), 0 10px 40px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.9)',
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {/* 顶部光晕条 */}
                            <div
                                className="absolute top-0 left-0 right-0 h-1 pointer-events-none"
                                style={{ background: 'linear-gradient(90deg, transparent, #10b981, #6ee7b7, #10b981, transparent)' }}
                            />
                            {/* 头部 */}
                            <div className="px-6 pt-7 pb-4 text-center">
                                <div
                                    className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center mb-3"
                                    style={{
                                        background: 'linear-gradient(135deg, rgba(16,185,129,0.15), rgba(52,211,153,0.08))',
                                        boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.9), 0 4px 16px rgba(16,185,129,0.2)',
                                    }}
                                >
                                    <span style={{ fontSize: 28 }}>🧠</span>
                                </div>
                                <div className="text-[11px] tracking-[0.2em] uppercase font-semibold" style={{ color: '#059669' }}>Cognitive Digest</div>
                                <div className="text-[17px] font-bold mt-1" style={{ color: '#0f172a' }}>{char.name} 完成了一次认知消化</div>
                                <div className="text-[11px] text-slate-400 mt-1">内心整理 · {groups.reduce((s, g) => s + g.items.length, 0)} 项变化</div>
                            </div>

                            {/* 内容列表 */}
                            <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-3 no-scrollbar">
                                {groups.map(g => (
                                    <div key={g.key}
                                        className="rounded-2xl overflow-hidden"
                                        style={{
                                            background: 'rgba(255,255,255,0.7)',
                                            border: `1px solid ${g.accent}22`,
                                            boxShadow: `0 2px 8px ${g.accent}14, inset 0 1px 0 rgba(255,255,255,0.8)`,
                                        }}
                                    >
                                        <div className="px-4 py-2.5 flex items-center gap-2"
                                            style={{ background: `linear-gradient(90deg, ${g.accent}18, transparent)` }}
                                        >
                                            <span style={{ fontSize: 14 }}>{g.icon}</span>
                                            <span className="text-[12px] font-bold" style={{ color: g.accent }}>{g.label}</span>
                                            <span className="text-[10px] font-bold ml-auto px-1.5 py-0.5 rounded-full"
                                                style={{ background: `${g.accent}22`, color: g.accent }}
                                            >{g.items.length}</span>
                                        </div>
                                        <div className="px-4 py-2 space-y-1.5">
                                            {g.items.slice(0, 3).map((it, i) => (
                                                <div key={i} className="text-[12px] leading-relaxed text-slate-700 flex gap-2">
                                                    <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: g.accent }} />
                                                    <span className="flex-1">
                                                        {it.sub && <span className="text-[10px] font-semibold mr-1.5 px-1.5 py-0.5 rounded" style={{ background: `${g.accent}18`, color: g.accent }}>{it.sub}</span>}
                                                        <span>{it.content.length > 80 ? it.content.slice(0, 80) + '…' : it.content}</span>
                                                    </span>
                                                </div>
                                            ))}
                                            {g.items.length > 3 && (
                                                <div className="text-[10px] text-slate-400 pl-3">还有 {g.items.length - 3} 条…</div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* 确认按钮 */}
                            <div className="px-6 pb-6 pt-2">
                                <button
                                    onClick={() => setLastDigestResult(null)}
                                    className="w-full py-3 text-white text-[13px] font-bold rounded-2xl active:scale-[0.98] transition-transform"
                                    style={{
                                        background: 'linear-gradient(135deg, #10b981, #059669)',
                                        boxShadow: '0 8px 24px -4px rgba(16,185,129,0.45), inset 0 1px 0 rgba(255,255,255,0.25)',
                                    }}
                                >
                                    放入心里
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden pt-6 pb-6 no-scrollbar" style={{ backgroundImage: activeTheme.type === 'custom' && activeTheme.user.backgroundImage ? 'none' : undefined }}>
                {collapsedCount > 0 && (
                    <div className="flex justify-center mb-6">
                        <button onClick={async () => {
                            const nextVisibleCount = visibleCount + LOAD_BATCH_SIZE;
                            visibleCountRef.current = nextVisibleCount;
                            setVisibleCount(nextVisibleCount);
                            await reloadMessages(nextVisibleCount);
                        }} className="px-4 py-2 bg-white/50 backdrop-blur-sm rounded-full text-xs text-slate-500 shadow-sm border border-white hover:bg-white transition-colors">加载历史消息 ({collapsedCount})</button>
                    </div>
                )}

                {displayMessages.map((m, i) => {
                    const prevMessage = i > 0 ? displayMessages[i - 1] : null;
                    const nextMessage = i < displayMessages.length - 1 ? displayMessages[i + 1] : null;
                    const messageGroupGapMs = 30 * 60 * 1000;
                    const breaksWithPrevious =
                        !prevMessage ||
                        prevMessage.role !== m.role ||
                        Math.abs(m.timestamp - prevMessage.timestamp) > messageGroupGapMs;
                    const breaksWithNext =
                        !nextMessage ||
                        nextMessage.role !== m.role ||
                        Math.abs(nextMessage.timestamp - m.timestamp) > messageGroupGapMs;
                    return (
                        <MessageItem
                            key={m.id || i}
                            msg={m}
                            isFirstInGroup={breaksWithPrevious}
                            isLastInGroup={breaksWithNext}
                            activeTheme={activeTheme}
                            charAvatar={char.avatar}
                            charName={char.name}
                            userAvatar={userProfile.avatar}
                            onLongPress={handleMessageLongPress}
                            selectionMode={selectionMode}
                            isSelected={selectedMsgIds.has(m.id)}
                            onToggleSelect={toggleMessageSelection}
                            translationEnabled={translationEnabled && m.type === 'text' && m.role === 'assistant'}
                            isShowingTarget={showingTargetIds.has(m.id)}
                            onTranslateToggle={handleTranslateToggle}
                            voiceData={voiceDataMap[m.id]}
                            voiceLoading={voiceLoading.has(m.id)}
                            isVoicePlaying={playingMsgId === m.id}
                            onPlayVoice={() => handlePlayVoice(m.id)}
                            avatarShape={osTheme.chatAvatarShape}
                            avatarSize={osTheme.chatAvatarSize}
                            avatarMode={osTheme.chatAvatarMode}
                            bubbleVariant={osTheme.chatBubbleStyle}
                            messageSpacing={osTheme.chatMessageSpacing}
                            showTimestamp={osTheme.chatShowTimestamp}
                        />
                    );
                })}
                
                {(isTyping || recallStatus || searchStatus || diaryStatus) && !selectionMode && (
                    <div className="flex items-end gap-3 px-3 mb-6 animate-fade-in">
                        <img src={char.avatar} className={`${osTheme.chatAvatarSize === 'small' ? 'w-7 h-7' : osTheme.chatAvatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9'} ${osTheme.chatAvatarShape === 'square' ? 'rounded-sm' : osTheme.chatAvatarShape === 'rounded' ? 'rounded-xl' : 'rounded-[10px]'} object-cover`} />
                        <div className="bg-white px-4 py-3 rounded-2xl shadow-sm">
                            {searchStatus ? (
                                <div className="flex items-center gap-2 text-xs text-emerald-500 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    🔍 {searchStatus}
                                </div>
                            ) : recallStatus ? (
                                <div className="flex items-center gap-2 text-xs text-indigo-500 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    {recallStatus}
                                </div>
                            ) : diaryStatus ? (
                                <div className="flex items-center gap-2 text-xs text-amber-600 font-medium">
                                    <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    📖 {diaryStatus}
                                </div>
                            ) : (
                                <div className="flex gap-1"><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce delay-75"></div><div className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce delay-150"></div></div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className="relative z-40">
                {replyTarget && (
                    <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                        <div className="flex items-center gap-2 truncate"><span className="font-bold text-slate-700">正在回复:</span><span className="truncate max-w-[200px]">{replyTarget.content.length > 10 ? replyTarget.content.slice(0, 10) + '...' : replyTarget.content}</span></div>
                        <button onClick={() => setReplyTarget(null)} className="p-1 text-slate-400 hover:text-slate-600">×</button>
                    </div>
                )}
                
                <ChatInputArea
                    input={input} setInput={handleInputChange}
                    isTyping={isTyping} selectionMode={selectionMode}
                    showPanel={showPanel} setShowPanel={setShowPanel}
                    onSend={handleSendCallback}
                    onDeleteSelected={handleBatchDelete}
                    onForwardSelected={handleForwardSelected}
                    selectedCount={selectedMsgIds.size}
                    emojis={filteredEmojis}
                    characters={characters} activeCharacterId={activeCharacterId}
                    onCharSelect={handleCharSelectCallback}
                    customThemes={customThemes} onUpdateTheme={(id) => updateCharacter(char.id, { bubbleStyle: id })}
                    onRemoveTheme={removeCustomTheme} activeThemeId={currentThemeId}
                    onPanelAction={handlePanelAction}
                    onImageSelect={handleImageSelect}
                    isSummarizing={isSummarizing}
                    categories={visibleCategories}
                    activeCategory={activeCategory}
                    onReroll={handleReroll}
                    canReroll={canReroll}
                    isProactiveActive={isProactiveActive}
                    inputStyle={osTheme.chatInputStyle}
                    sendButtonStyle={osTheme.chatSendButtonStyle}
                    chromeStyle={osTheme.chatChromeStyle}
                />
            </div>


            {/* Proactive Settings Modal */}
            {char && (
                <ProactiveSettingsModal
                    isOpen={showProactiveModal}
                    onClose={() => setShowProactiveModal(false)}
                    char={char}
                    isProactiveActive={isProactiveActive}
                    onSave={(config) => {
                        updateCharacter(char.id, { proactiveConfig: config });
                        if (config.enabled) {
                            startProactiveChat(config.intervalMinutes);
                            addToast(`已启动主动消息，每 ${config.intervalMinutes >= 60 ? (config.intervalMinutes / 60) + ' 小时' : config.intervalMinutes + ' 分钟'}发送一次`, 'success');
                        } else {
                            stopProactiveChat();
                            addToast('已关闭主动消息', 'info');
                        }
                    }}
                    onStop={() => {
                        stopProactiveChat();
                        updateCharacter(char.id, { proactiveConfig: { ...char.proactiveConfig!, enabled: false } });
                        addToast('已停止主动消息', 'info');
                    }}
                />
            )}

            {/* 情绪设置已嵌入日程 Modal（与日程强制同步开/关），不再单独渲染 */}

            {/* 🛟 人格抢救 Modal —— 把"情感型 0.3"默认值卡住的角色偷偷救活 */}
            <Modal
                isOpen={personalityRescue.open}
                title={
                    personalityRescue.open && personalityRescue.phase === 'rescuing' ? '糯米鸡抢救中…' :
                    personalityRescue.open && personalityRescue.phase === 'done' ? '抢救完成！' :
                    personalityRescue.open && personalityRescue.phase === 'failed' ? '抢救失败' :
                    '糯米鸡抢救中…'
                }
                onClose={() => {
                    // rescuing 阶段不给关，必须看到结果；其它阶段允许关闭
                    if (personalityRescue.open && personalityRescue.phase === 'rescuing') return;
                    setPersonalityRescue({ open: false });
                }}
                footer={
                    personalityRescue.open && personalityRescue.phase !== 'rescuing' ? (
                        <button
                            onClick={() => setPersonalityRescue({ open: false })}
                            className="w-full py-3 bg-purple-600 text-white font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            好
                        </button>
                    ) : undefined
                }
            >
                {personalityRescue.open && personalityRescue.phase === 'rescuing' && (
                    <div className="space-y-3 py-2">
                        <p className="text-sm text-slate-600 leading-relaxed text-center">
                            角色的后台有点 bug，糯米鸡抢救一下，马上就好 ✨
                        </p>
                        <p className="text-xs text-slate-400 text-center">
                            正在重新分析 <span className="font-semibold text-slate-600">{personalityRescue.charName}</span> 的认知风格…
                        </p>
                        <div className="flex justify-center pt-2">
                            <div className="w-8 h-8 border-4 border-purple-200 border-t-purple-600 rounded-full animate-spin" />
                        </div>
                    </div>
                )}
                {personalityRescue.open && personalityRescue.phase === 'done' && (() => {
                    const styleLabel =
                        personalityRescue.result.style === 'emotional' ? '情感型' :
                        personalityRescue.result.style === 'narrative' ? '叙事型' :
                        personalityRescue.result.style === 'imagery' ? '意象型' :
                        personalityRescue.result.style === 'analytical' ? '分析型' :
                        personalityRescue.result.style;
                    return (
                        <div className="space-y-3 py-2">
                            <p className="text-xs text-slate-400 text-center">
                                <span className="font-semibold text-slate-600">{personalityRescue.charName}</span> 的认知参数已重新生成 🎉
                            </p>
                            <div className="bg-purple-50 rounded-2xl p-4 space-y-2 border border-purple-100">
                                <div className="flex justify-between text-sm">
                                    <span className="text-slate-500">认知风格</span>
                                    <span className="font-bold text-purple-700">{styleLabel}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span className="text-slate-500">反刍倾向</span>
                                    <span className="font-bold text-purple-700">{personalityRescue.result.ruminationTendency.toFixed(1)}</span>
                                </div>
                            </div>
                            {personalityRescue.result.reasoning && (
                                <p className="text-xs text-slate-500 leading-relaxed px-1">
                                    <span className="text-slate-400">糯米鸡的判断：</span>
                                    {personalityRescue.result.reasoning}
                                </p>
                            )}
                        </div>
                    );
                })()}
                {personalityRescue.open && personalityRescue.phase === 'failed' && (
                    <div className="space-y-3 py-2">
                        <p className="text-sm text-slate-600 text-center">
                            糯米鸡也没救回来 😢
                        </p>
                        <p className="text-xs text-slate-400 leading-relaxed text-center">
                            下次打开聊天再试一次，或去记忆宫殿检查一下副 API 配置。
                        </p>
                        <div className="bg-red-50 rounded-xl p-3 border border-red-100">
                            <p className="text-[11px] text-red-600 break-all font-mono">
                                {personalityRescue.error}
                            </p>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Forward Modal */}
            <Modal isOpen={showForwardModal} title="转发聊天记录" onClose={() => setShowForwardModal(false)}>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                    <p className="text-xs text-slate-400 mb-3">选择要转发给的角色 (已选 {selectedMsgIds.size} 条消息)</p>
                    {characters.filter(c => c.id !== activeCharacterId).map(c => (
                        <button
                            key={c.id}
                            onClick={() => handleForwardToCharacter(c.id)}
                            className="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-50 hover:bg-slate-100 active:scale-[0.98] transition-all border border-slate-100"
                        >
                            <img src={c.avatar} className="w-10 h-10 rounded-xl object-cover" />
                            <div className="flex-1 text-left">
                                <div className="font-bold text-sm text-slate-700">{c.name}</div>
                                <div className="text-[10px] text-slate-400 truncate">{c.description}</div>
                            </div>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                        </button>
                    ))}
                    {characters.filter(c => c.id !== activeCharacterId).length === 0 && (
                        <div className="text-center text-xs text-slate-400 py-8">没有其他角色可以转发</div>
                    )}
                </div>
            </Modal>
        </div>
    );
};

export default Chat;

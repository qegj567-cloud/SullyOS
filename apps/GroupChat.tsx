import ChatRuntimeStyle from '../components/chat/ChatRuntimeStyle';
import { resolveDialogueApi } from '../utils/characterApi';
import {ChatCardSurface} from '../components/chat/ChatCardSurface';
import { avatarDecorationImageStyle, isAnniversaryFrame } from '../utils/anniversaryGifts';
import { loadCharacterContextMessages } from '../utils/chatContextRange';

import BlobRefStyle from '../components/chat/BlobRefStyle';
import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { Message, GroupProfile, CharacterProfile, MessageType, ChatTheme, BubbleStyle, EmojiCategory } from '../types';
import { safeResponseJson } from '../utils/safeApi';
import Modal from '../components/os/Modal';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { deleteGroupMemoriesByGroupId } from '../utils/memoryPalace/groupPipeline';
import { processImage } from '../utils/file';
import { stickerNameFromUrl } from '../utils/messageFormat';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { resolveChatTheme, scopeBubbleThemeCss } from '../utils/groupChat/theme';
import { resolveBubbleCornerRadii, shouldHideBubbleTail } from '../utils/bubbleAppearance';
import { buildChatFineTuneCss } from '../utils/chatFineTuneCss';
import { parseDirectorActions, stripSkipMarker, parseGroupTopicBox } from '../utils/groupChat/parse';
import { GroupPacketMeta, PacketReceiptMeta, ClaimResult, claimPacket, effectivePacketStatus, makePacketMeta } from '../utils/groupChat/redpacket';
import { messageLogText } from '../utils/groupChat/format';
import { trackEvent } from '../utils/analytics';
import { markAmsgStateDirty, type AmsgDirtyReason } from '../utils/amsgStateSync';
import { buildMemberTimeline, DEFAULT_MEMBER_TIMELINE_CAP } from '../utils/groupChat/timeline';
import { buildEmojiContextStr, buildGroupHistoryBlock, buildDirectorInstruction, buildRoundRobinInstruction, GroupHistoryBlock } from '../utils/groupChat/prompts';
import { dispatchMemberActions } from '../utils/groupChat/dispatch';
import { completeGroupChatWithMcp } from '../utils/groupChat/mcp';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
// 群聊输入区/表情面板已改用共享 ChatInputArea（其表情网格自带 useIncrementalReveal 增量渲染），
// master 上给旧内联表情抽屉加的增量渲染随旧抽屉一并退役。
import { UsersThree, Money, GearSix, Image as ImageIcon, ArrowsClockwise, PaintBrush, BellSimpleRinging, Code, Question } from '@phosphor-icons/react';
import ChatHeaderShell from '../components/chat/ChatHeaderShell';
import ChatInputArea from '../components/chat/ChatInputArea';
import { loadChatInputPreferences, saveChatInputPreferences } from '../utils/chatInputPreferences';
import ChatInputSettings from '../components/chat/ChatInputSettings';
import { useChatAutoReply } from '../hooks/useChatAutoReply';
import TokenImg from '../components/os/TokenImg';
import { ImageViewer } from '../components/chat/ChatImage';
import { useBlobRefUrl, migrateDataUrlToRef } from '../utils/blobRef';
import { buildReplySnapshotContent } from '../utils/applyAssistantPostProcessing';
import ChromeCssEditor from '../components/chat/ChromeCssEditor';
import WhiteboxSoundEditor from '../components/chat/WhiteboxSoundEditor';
import HtmlCard from '../components/chat/HtmlCard';
import { WhiteboxSound, parseWhiteboxSound, upsertWhiteboxSound, stripWhiteboxSoundDirective, resolveActiveSound, playWhiteboxSound, unlockWhiteboxAudio } from '../utils/whiteboxSound';
import { buildHtmlPrompt } from '../utils/htmlPrompt';
import { materializeVisionDescriptions } from '../utils/visionApi';
import {
    buildGroupTopicContext,
    buildGroupTopicPrompt,
    GROUP_TOPIC_BUFFER_THRESHOLD,
    GROUP_TOPIC_HOT_ZONE,
    groupTopicPendingCount,
    makeGroupTopicBox,
    planGroupTopicBatch,
} from '../utils/groupChat/topicBoxes';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

// 复用 Chat.tsx 的高颜值样式逻辑，但针对群聊微调
const PRESET_THEME_GROUP: ChatTheme = {
    id: 'group_default', name: 'Group', type: 'preset',
    user: { textColor: '#ffffff', backgroundColor: '#8b5cf6', borderRadius: 18, opacity: 1 }, // Violet for User
    ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 18, opacity: 1 }  // White for Others
};

// --- Sub-Component: 红包卡片（2.0：拼手气/专属 + 状态角标 + 回执结算条；旧数据 legacy 简卡） ---
const GroupPacketCard = ({ msg, nameOf, onOpen }: {
    msg: Message;
    nameOf: (id: string) => string;
    onOpen?: (msg: Message) => void;
}) => {
    const meta = msg.metadata as (Partial<GroupPacketMeta> & Partial<PacketReceiptMeta>) | undefined;

    // 回执：mini 结算条（对齐私聊 TransferCard 的回执视觉）
    if (meta?.packetReceipt) {
        const claimed = meta.packetReceipt === 'claimed';
        return (
            <div className={`px-3 py-2 rounded-xl border text-[11px] flex items-center gap-2 ${claimed ? 'bg-emerald-50 border-emerald-100 text-emerald-600' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                <span>🧧</span>
                <span>{meta.claimantName} {claimed ? '领取了' : '退回了'} {meta.senderName} 的红包{claimed && meta.amount != null ? ` ¥${meta.amount}` : ''}</span>
            </div>
        );
    }

    // 旧数据（无 packet 判别字段）：legacy 简卡，渲染不变语义
    if (!meta?.packet) {
        return (
            <div className="w-60 bg-[#fb923c] text-white p-3 rounded-xl flex items-center gap-3 shadow-md relative overflow-hidden">
                <div className="text-2xl">🧧</div>
                <div className="z-10">
                    <div className="font-bold text-sm tracking-wide">红包 / 转账</div>
                    <div className="text-[10px] opacity-90">Sully Pay</div>
                </div>
            </div>
        );
    }

    const m = meta as GroupPacketMeta;
    const status = effectivePacketStatus(m, Date.now());
    const opened = status !== 'pending';
    const statusText = m.packetType === 'lucky'
        ? (status === 'pending' ? `剩 ${m.shares - m.claims.length} 份可抢` : status === 'done' ? '已领完' : '已过期')
        : (status === 'pending' ? `待 ${nameOf(m.targetId || '')} 领取` : status === 'done' ? '已收下' : status === 'returned' ? '已退回' : '已过期');

    return (
        <div
            onClick={() => onOpen?.(msg)}
            className={`w-60 p-3 rounded-xl flex items-center gap-3 shadow-md relative overflow-hidden active:scale-95 transition-transform cursor-pointer text-white ${opened ? 'bg-[#f0b48c]' : 'bg-gradient-to-br from-[#fb923c] to-[#f43f5e]'}`}
        >
            <div className="text-3xl drop-shadow-sm">🧧</div>
            <div className="z-10 min-w-0 flex-1 pb-3">
                <div className="font-bold text-sm tracking-wide truncate">{m.note}</div>
                <div className="text-[10px] opacity-90">{m.packetType === 'lucky' ? `拼手气红包 · ${m.shares} 份` : `专属红包 · 给 ${nameOf(m.targetId || '')}`}</div>
            </div>
            <div className="absolute right-2 bottom-1.5 text-[9px] bg-black/20 px-1.5 py-0.5 rounded-full whitespace-nowrap">{statusText}</div>
        </div>
    );
};

// --- Sub-Component: Group Message Bubble ---
const GroupMessageItem = React.memo(({
    msg,
    isUser,
    char,
    userAvatar,
    onImageClick,
    selectionMode,
    isSelected,
    onToggleSelect,
    onLongPress,
    onReply,
    nameOf,
    onPacketClick,
    styleConfig,
    themeScopeClass,
    isFirstInGroup,
    isLastInGroup,
    avatarShape = 'circle',
    avatarSize = 'medium',
    avatarMode = 'grouped',
    bubbleVariant = 'modern',
    messageSpacing = 'default',
    showTimestamp = 'always',
}: {
    msg: Message,
    isUser: boolean,
    char?: CharacterProfile,
    userAvatar: string,
    onImageClick: (url: string) => void,
    selectionMode: boolean,
    isSelected: boolean,
    onToggleSelect: (id: number) => void,
    onLongPress: (id: number) => void,
    onReply: (msg: Message) => void,
    nameOf: (id: string) => string,
    onPacketClick: (msg: Message) => void,
    /** 气泡样式（用户=群设置选的主题 user 侧；成员=统一或各自私聊主题 ai 侧）。引用需稳定（memo） */
    styleConfig: BubbleStyle,
    /** 将当前成员的气泡工坊 CSS 限定在自己的消息上，防止群成员主题互串。 */
    themeScopeClass: string,
    isFirstInGroup: boolean,
    isLastInGroup: boolean,
    avatarShape?: 'circle' | 'rounded' | 'square',
    avatarSize?: 'small' | 'medium' | 'large',
    avatarMode?: 'grouped' | 'every_message',
    bubbleVariant?: 'modern' | 'flat' | 'outline' | 'shadow' | 'wechat' | 'ios',
    messageSpacing?: 'compact' | 'default' | 'spacious',
    showTimestamp?: 'always' | 'hover' | 'never',
}) => {
    const avatar = isUser ? userAvatar : char?.avatar;
    const name = isUser ? '我' : char?.name || '未知成员';

    const spacingClass = messageSpacing === 'compact'
        ? (isLastInGroup ? 'mb-3' : 'mb-0.5')
        : messageSpacing === 'spacious'
            ? (isLastInGroup ? 'mb-8' : 'mb-2.5')
            : (isLastInGroup ? 'mb-6' : 'mb-1.5');
    const avatarSizeClass = avatarSize === 'small' ? 'w-7 h-7' : avatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9';
    const avatarSizePx = avatarSize === 'small' ? 28 : avatarSize === 'large' ? 48 : 36;
    const avatarRadiusClass = avatarShape === 'square' ? 'rounded-sm' : avatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    const shouldShowAvatar = avatarMode === 'every_message' || isLastInGroup;
    const cornerRadii = resolveBubbleCornerRadii(styleConfig);
    const hideBubbleTail = shouldHideBubbleTail(styleConfig.tailMode, isLastInGroup);
    const bubbleGroupClasses = [
        isFirstInGroup ? 'sully-bubble-group-first' : '',
        isLastInGroup ? 'sully-bubble-group-last' : '',
        hideBubbleTail ? 'sully-bubble-tail-hidden' : 'sully-bubble-tail-visible',
    ].filter(Boolean).join(' ');
    const bubbleStyle: React.CSSProperties = {
        backgroundColor: bubbleVariant === 'outline' ? 'transparent' : styleConfig.backgroundColor,
        opacity: styleConfig.opacity ?? 1,
        borderTopLeftRadius: cornerRadii.topLeft,
        borderTopRightRadius: cornerRadii.topRight,
        borderBottomRightRadius: cornerRadii.bottomRight,
        borderBottomLeftRadius: cornerRadii.bottomLeft,
        ...(bubbleVariant === 'outline' ? { border: `2px solid ${styleConfig.backgroundColor}`, boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'shadow' ? { boxShadow: '0 4px 12px rgba(0,0,0,0.12)' } : {}),
        ...(bubbleVariant === 'flat' ? { boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'wechat' ? { boxShadow: 'none', border: '1px solid rgba(15,23,42,0.05)' } : {}),
        ...(bubbleVariant === 'ios' ? { boxShadow: '0 10px 24px rgba(148,163,184,0.16)', border: '1px solid rgba(255,255,255,0.75)', backdropFilter: 'blur(12px)' } : {}),
    };
    // 气泡底纹画在 CSS background-image 上，拿不到 <img> 那层的自动解析，只能在顶层
    // 无条件解析一次（hook 不能进条件分支）。挂件/头像挂件走 TokenImg，各自组件内解析。
    const bubbleBgUrl = useBlobRefUrl(styleConfig.backgroundImage);

    // pointer-event 手势（对齐私聊 MessageItem 的方案）：600ms 长按 → 操作菜单；
    // 触屏左滑 ≤-52px → 引用回复（带位移动画）；鼠标右键 → 操作菜单
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPos = useRef({ x: 0, y: 0 });
    const activePointerId = useRef<number | null>(null);
    const activePointerType = useRef<string>('');
    const replyGestureActiveRef = useRef(false);
    const replyReadyRef = useRef(false);
    const [replyOffset, setReplyOffset] = useState(0);
    const [isReplyGestureActive, setIsReplyGestureActive] = useState(false);

    // Time formatting
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    const clearLongPressTimer = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };

    const resetReplyGesture = () => {
        replyGestureActiveRef.current = false;
        replyReadyRef.current = false;
        setIsReplyGestureActive(false);
        setReplyOffset(0);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (selectionMode || e.button !== 0) return;
        activePointerId.current = e.pointerId;
        activePointerType.current = e.pointerType;
        startPos.current = { x: e.clientX, y: e.clientY };
        document.getSelection()?.removeAllRanges();

        clearLongPressTimer();
        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            activePointerId.current = null;
            activePointerType.current = '';
            resetReplyGesture();
            onLongPress(msg.id);
        }, 600);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        const diffX = e.clientX - startPos.current.x;
        const diffY = e.clientY - startPos.current.y;
        const isTouchPointer = activePointerType.current !== 'mouse';

        if (!replyGestureActiveRef.current) {
            const startsReplySwipe = isTouchPointer
                && diffX < -8
                && Math.abs(diffX) > Math.abs(diffY);
            if (!startsReplySwipe) {
                if (Math.abs(diffX) > 10 || Math.abs(diffY) > 10) clearLongPressTimer();
                return;
            }
            clearLongPressTimer();
            replyGestureActiveRef.current = true;
            setIsReplyGestureActive(true);
        }

        if (Math.abs(diffY) > 24 && Math.abs(diffY) > Math.abs(diffX)) {
            resetReplyGesture();
            return;
        }

        e.preventDefault();
        document.getSelection()?.removeAllRanges();
        const nextOffset = Math.max(-72, Math.min(0, diffX));
        replyReadyRef.current = nextOffset <= -52;
        setReplyOffset(nextOffset);
    };

    const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';

        const shouldReply = replyGestureActiveRef.current && replyReadyRef.current;
        resetReplyGesture();

        if (shouldReply) onReply(msg);
    };

    const handlePointerCancel = () => {
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';
        resetReplyGesture();
    };

    const handleClick = (e: React.MouseEvent) => {
        if (selectionMode) {
            e.stopPropagation();
            onToggleSelect(msg.id);
        }
    };

    const renderAvatar = (forceVisible = false) => (
        <div className={`relative ${avatarSizeClass} z-0 sully-chat-message-avatar`}>
            {(forceVisible || shouldShowAvatar) && (
                <>
                    <TokenImg
                        value={avatar}
                        style={isAnniversaryFrame(styleConfig.avatarDecoration) ? { borderRadius: "50%" } : undefined}
                        className={`sully-chat-message-avatar-img w-full h-full ${avatarRadiusClass} object-cover shadow-sm ring-1 ring-black/5 relative z-0`}
                        alt="avatar"
                        loading="lazy"
                        decoding="async"
                    />
                    {styleConfig.avatarDecoration && (
                        <TokenImg
                            value={styleConfig.avatarDecoration}
                            className="absolute pointer-events-none z-10 max-w-none"
                            style={avatarDecorationImageStyle(styleConfig, avatarSizePx)}
                            alt=""
                        />
                    )}
                </>
            )}
        </div>
    );

    // Special Content Renderers
    const renderContent = () => {
        switch (msg.type) {
            case 'image':
                return (
                    <div className="relative group cursor-pointer" onClick={(e) => {
                        if (selectionMode) handleClick(e);
                        else { e.stopPropagation(); onImageClick(msg.content); }
                    }}>
                        <TokenImg value={msg.content} className="max-w-[200px] max-h-[200px] rounded-xl shadow-sm border border-black/5" loading="lazy" />
                    </div>
                );
            case 'emoji':
                // 尺寸跟随外观 → 表情包大小（--sully-emoji-size 三挡，默认 96px = 原 w-24）
                return <TokenImg value={msg.content} className="sully-emoji-msg max-w-[var(--sully-emoji-size,96px)] max-h-[var(--sully-emoji-size,96px)] object-contain drop-shadow-sm hover:scale-110 transition-transform" />;
            case 'transfer':
                return (
                    <div onClick={(e) => { if (selectionMode) handleClick(e); }}>
                        <GroupPacketCard msg={msg} nameOf={nameOf} onOpen={selectionMode ? undefined : onPacketClick} />
                    </div>
                );
            case 'html_card': {
                const html = typeof msg.metadata?.htmlSource === 'string' ? msg.metadata.htmlSource : '';
                if (!html) {
                    return (
                        <div className="px-4 py-3 rounded-2xl bg-fuchsia-50 text-fuchsia-500 text-xs italic border border-fuchsia-100">
                            [HTML 卡片数据缺失]
                        </div>
                    );
                }
                return <HtmlCard html={html} />;
            }
            default:
                return (
                    <div
                        className={`relative px-5 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-normal [overflow-wrap:anywhere] overflow-visible active:scale-[0.98] transition-transform ${bubbleVariant === 'flat' || bubbleVariant === 'outline' || bubbleVariant === 'wechat' ? '' : 'shadow-sm'} ${bubbleVariant === 'outline' ? '' : 'border border-black/5'} ${isUser ? 'sully-bubble-user' : 'sully-bubble-ai'} ${bubbleGroupClasses}`}
                        style={bubbleStyle}
                    >
                        {bubbleBgUrl && (
                            <div
                                className="absolute inset-0 bg-cover bg-center pointer-events-none z-0"
                                style={{
                                    backgroundImage: `url(${bubbleBgUrl})`,
                                    opacity: styleConfig.backgroundImageOpacity ?? 0.5,
                                    borderRadius: 'inherit',
                                }}
                            />
                        )}
                        {styleConfig.decoration && (
                            <TokenImg
                                value={styleConfig.decoration}
                                className="absolute z-10 w-8 h-8 object-contain drop-shadow-sm pointer-events-none"
                                style={{
                                    left: `${styleConfig.decorationX ?? (isUser ? 90 : 10)}%`,
                                    top: `${styleConfig.decorationY ?? -10}%`,
                                    transform: `translate(-50%, -50%) scale(${styleConfig.decorationScale ?? 1}) rotate(${styleConfig.decorationRotate ?? 0}deg)`,
                                }}
                                alt=""
                            />
                        )}
                        {msg.replyTo && (
                            <div className="relative z-10 mb-1 text-[10px] bg-black/5 p-1.5 rounded-md border-l-2 border-current opacity-60 flex flex-col gap-0.5 max-w-full overflow-hidden">
                                <span className="font-bold opacity-90 truncate">{msg.replyTo.name}</span>
                                {/* 历史快照里可能原样存着令牌 / data: / 图床 URL，直接截 10 个字
                                    就成了气泡里一串 `blobref:b_`；交给写入端同一个快照函数换占位符 */}
                                <span className="truncate italic">"{buildReplySnapshotContent({ content: msg.replyTo.content })}"</span>
                            </div>
                        )}
                        <div className="relative z-10 select-text" style={{ color: styleConfig.textColor }}>{msg.content}</div>
                    </div>
                );
        }
    };

    return (
        <div
            className={`${themeScopeClass} sully-chat-message ${isUser ? 'sully-chat-message-user justify-end' : 'sully-chat-message-ai justify-start'} ${isFirstInGroup ? 'sully-chat-message-group-first' : ''} ${isLastInGroup ? 'sully-chat-message-group-last' : ''} flex items-end ${spacingClass} px-3 w-full group relative transition-[padding] duration-300 ${selectionMode ? 'pl-12' : ''}`}
            style={{ '--sully-chat-message-avatar-size': `${avatarSizePx}px` } as React.CSSProperties}
        >
            {selectionMode && (
                <div className="absolute left-3 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={handleClick}>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-violet-500 border-violet-500' : 'border-slate-300 bg-white'}`}>
                        {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                    </div>
                </div>
            )}

            {isFirstInGroup && (
                <div className={`sully-chat-turn-avatar-slot hidden absolute top-0 z-0 ${isUser ? 'right-3' : (selectionMode ? 'left-14' : 'left-3')}`}>
                    {renderAvatar(true)}
                </div>
            )}

            {!isUser && (
                <div className={`sully-chat-message-avatar-slot absolute bottom-0 z-0 ${selectionMode ? 'left-14' : 'left-3'} transition-[left] duration-300`}>
                    {renderAvatar()}
                </div>
            )}

            <div className={`sully-chat-message-content relative min-w-0 max-w-[72%] ${isUser ? 'mr-12' : 'ml-12'}`}>
                <div
                    className={`relative flex flex-col ${isUser ? 'items-end' : 'items-start'} min-w-0 ${selectionMode ? 'pointer-events-none' : ''}`}
                    style={{
                        transform: `translateX(${replyOffset}px)`,
                        transition: isReplyGestureActive ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                        touchAction: 'pan-y',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        WebkitTouchCallout: 'none',
                    } as React.CSSProperties}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerCancel}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        if (selectionMode || replyGestureActiveRef.current) return;
                        clearLongPressTimer();
                        activePointerId.current = null;
                        activePointerType.current = '';
                        resetReplyGesture();
                        onLongPress(msg.id);
                    }}
                    onDragStart={(e) => e.preventDefault()}
                    onClick={handleClick}
                >
                    {!isUser && isFirstInGroup && (
                        <span className="sully-chat-message-sender text-[10px] text-slate-400 ml-1 mb-1">{name}</span>
                    )}
                    <div className={selectionMode ? 'pointer-events-none' : ''}>
                        <ChatCardSurface message={msg}>{renderContent()}</ChatCardSurface>
                    </div>
                    {isLastInGroup && showTimestamp !== 'never' && (
                        <span className={`absolute top-full ${isUser ? 'right-0' : 'left-0'} mt-0.5 px-1 text-[9px] text-slate-400/80 font-medium whitespace-nowrap pointer-events-none ${showTimestamp === 'hover' ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''}`}>{timeStr}</span>
                    )}
                </div>
            </div>

            {isUser && (
                <div className="sully-chat-message-avatar-slot absolute right-3 bottom-0 z-0">
                    {renderAvatar()}
                </div>
            )}
        </div>
    );
});

// --- Main Component ---

const GroupChat: React.FC = () => {
    const { closeApp, groups, createGroup, updateGroup, deleteGroup, characters, apiConfig, addToast, userProfile, virtualTime, characterGroups, theme: osTheme, customThemes, realtimeConfig } = useOS();
    const [view, setView] = useState<'list' | 'chat'>('list');
    const [activeGroup, setActiveGroup] = useState<GroupProfile | null>(null);
    useAppShortcut(ShortcutAppID.GroupChat, intent => {
        const target = groups.find(group => group.id === intent.resourceId);
        setActiveGroup(target || null); setView(target ? 'chat' : 'list');
        setModalType('none'); setShowPanel('none'); setReplyTarget(null);
        if (activeGroup?.id !== target?.id) setMessages([]);
        if (intent.resourceId && !target) addToast('这个群聊已不存在，请重新设置槽位', 'error');
    });
    const [messages, setMessages] = useState<Message[]>([]);
    const [totalMsgCount, setTotalMsgCount] = useState(0);
    const MESSAGE_PAGE_SIZE = 50;
    const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE);
    const [input, setInput] = useState('');
    const [inputPreferences, setInputPreferences] = useState(loadChatInputPreferences);
    const [settingsInputPreferences, setSettingsInputPreferences] = useState(loadChatInputPreferences);
    const [isInputFocused, setIsInputFocused] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    const [mcpStatus, setMcpStatus] = useState('');
    // 世界书只由公共管线解析一次，群历史保留独立消息边界；附图仍由原有流程处理。
    const buildGroupRequestMessages = (members: CharacterProfile[], prompt: string, history: GroupHistoryBlock) =>
        ContextBuilder.buildGroupWorldbookRequest<{ role: string; content: any }>({
            members, user: userProfile, history: history.messages || [],
            render: (slots, messages) => [
                { role: 'system', content: slots.before + prompt + slots.after },
                ...messages,
                { role: 'user', content: buildUserMessageContent('请按以上规则继续本轮群聊。', history) },
            ],
        });

    /** 群公共话题盒整理状态——非空时显示顶部胶囊状态条 */
    const [groupPalaceStatus, setGroupPalaceStatus] = useState<string>('');

    // 公共成盒异步完成时使用最新角色名与成员资料，避免长回复期间闭包数据过期。
    const charactersRef = useRef(characters);
    charactersRef.current = characters;

    // 同理 ref 出最新 messages：派发循环里逐条落库时要按"当前窗口大小"刷新，
    // 闭包里的 messages 是触发那一刻的旧值，长度会越算越小
    const messagesRef = useRef<Message[]>([]);
    messagesRef.current = messages;

    // 群里的动静会进每个成员私聊 prompt 的【群聊背景】块，话题盒成盒时还直接往成员私聊
    // 历史里写卡片 —— 两者都是主动消息 2.0 云端快照（fire_pack）的素材。群里有事就给成员
    // 逐个打脏，不然角色到点还活在上一次私聊那会儿的群里。同一轮里的多次调用会在微任务内
    // 合并成一次上传，没开主动消息的成员被 markAmsgStateDirty 内部的门筛掉。
    const markGroupMembersDirty = useCallback((memberIds: string[], reason: AmsgDirtyReason = 'refresh') => {
        for (const memberId of memberIds) {
            const member = charactersRef.current.find(c => c.id === memberId);
            if (member) markAmsgStateDirty({ char: member, userProfile, groups, realtimeConfig }, reason);
        }
    }, [userProfile, groups, realtimeConfig]);

    // Token 统计 — 对齐私聊 ChatHeader 的 token badge
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);
    const [tokenBreakdown, setTokenBreakdown] = useState<{ prompt: number; completion: number; total: number; msgCount: number; pass: string } | null>(null);
    
    // UI State — 面板状态对齐私聊 ChatInputArea 的 showPanel 约定
    const [showPanel, setShowPanel] = useState<'none' | 'actions' | 'emojis' | 'chars'>('none');
    const [activeEmojiCategory, setActiveEmojiCategory] = useState('default');
    const [modalType, setModalType] = useState<'none' | 'create' | 'settings' | 'transfer' | 'member_select' | 'message-options' | 'edit-message' | 'packet-detail' | 'chrome-css' | 'chrome-sound' | 'html-prompt' | 'help'>('none');
    const [tempHtmlPrompt, setTempHtmlPrompt] = useState('');
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
    const [replyTarget, setReplyTarget] = useState<Message | null>(null);
    const [editContent, setEditContent] = useState('');
    const [preserveContext, setPreserveContext] = useState(true);
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [summaryProgress, setSummaryProgress] = useState('');
    const [topicPendingCount, setTopicPendingCount] = useState(0);
    const [editingTopicBoxId, setEditingTopicBoxId] = useState<string | null>(null);
    const [topicTitleDraft, setTopicTitleDraft] = useState('');
    const [topicSummaryDraft, setTopicSummaryDraft] = useState('');

    // Context limit (like Chat app's settingsContextLimit)
    const [contextLimit, setContextLimit] = useState<number>(() => {
        // localStorage 值损坏时 parseInt 得 NaN，slice(-NaN) 会把整段历史塞进 prompt
        try {
            const v = parseInt(localStorage.getItem('groupchat_context_limit') || '30', 10);
            return Number.isFinite(v) && v > 0 ? v : 30;
        } catch { return 30; }
    });
    
    // Selection Mode
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());

    // Data State
    const [emojis, setEmojis] = useState<{name: string, url: string, categoryId?: string}[]>([]);
    const [categories, setCategories] = useState<EmojiCategory[]>([]); // New

    useEffect(() => {
        setInputPreferences(loadChatInputPreferences());
    }, [activeGroup?.id]);
    
    // Create/Edit Group State
    const [tempGroupName, setTempGroupName] = useState('');
    const [tempPrivateContextCap, setTempPrivateContextCap] = useState<number>(80);
    const [tempMemberTimelineCap, setTempMemberTimelineCap] = useState<number>(DEFAULT_MEMBER_TIMELINE_CAP);
    const [tempReplyMode, setTempReplyMode] = useState<'director' | 'roundRobin'>('director');
    const [tempMemberBubbleIndependent, setTempMemberBubbleIndependent] = useState(false);
    const [tempUserBubbleThemeId, setTempUserBubbleThemeId] = useState<string>('');
    const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
    const [memberGroupId, setMemberGroupId] = useState(GROUP_FILTER_ALL); // 建群选成员的分组筛选
    const [transferAmount, setTransferAmount] = useState('');
    // 红包 2.0：发送弹窗的 tab / 份数 / 专属目标 / 祝福语；明细弹层锁定的红包消息 id
    const [packetTab, setPacketTab] = useState<'lucky' | 'direct'>('lucky');
    const [packetShares, setPacketShares] = useState('5');
    const [packetTargetId, setPacketTargetId] = useState<string>('');
    const [packetNote, setPacketNote] = useState('');
    const [selectedPacketId, setSelectedPacketId] = useState<number | null>(null);
    
    // Refs
    const scrollRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const groupAvatarInputRef = useRef<HTMLInputElement>(null);
    // 生成中的取消句柄：非空 = 正在生成，再点触发按钮 = 停止
    const abortRef = useRef<AbortController | null>(null);
    const topicArchiveLockRef = useRef(false);
    // 白框提示音回合计时（对齐私聊 Chat.tsx 的 soundSyncRef 方案）
    const SOUND_ROUND_GAP_MS = 3000;
    const soundSyncRef = useRef<{ groupId: string | null; maxId: number | null; lastAt: number | null }>({ groupId: null, maxId: null, lastAt: null });

    // Initial Load
    useEffect(() => {
        if (activeGroup) {
            setVisibleCount(MESSAGE_PAGE_SIZE);
            DB.getRecentGroupMessagesWithCount(activeGroup.id, MESSAGE_PAGE_SIZE).then(({ messages: msgs, totalCount }) => {
                setMessages(msgs);
                setTotalMsgCount(totalCount);
            });
            // Fetch emojis AND categories
            Promise.all([DB.getEmojis(), DB.getEmojiCategories()]).then(([es, cats]) => {
                setEmojis(es);
                setCategories(cats);
            });
        }
    }, [activeGroup]);

    // Auto Scroll
    useLayoutEffect(() => {
        if (scrollRef.current && !selectionMode) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages.length, activeGroup, showPanel, isTyping, selectionMode]);

    // 白框提示音：成员新发的消息成为群里最后一条时响一次（用户自己/翻旧消息不响）。
    // 逻辑对齐私聊 Chat.tsx——切群只记基线不播、回合内多气泡只响首条、基线只增不减。
    useEffect(() => {
        const sync = soundSyncRef.current;
        const last = messages.length > 0 ? messages[messages.length - 1] : null;
        const lastId = last ? last.id : null;
        if (sync.groupId !== (activeGroup?.id ?? null)) {
            sync.groupId = activeGroup?.id ?? null;
            sync.maxId = lastId;
            sync.lastAt = null;
            return;
        }
        if (lastId == null) return;
        const isNew = sync.maxId == null || lastId > sync.maxId;
        if (isNew && last?.role === 'assistant') {
            const now = Date.now();
            if (sync.lastAt == null || now - sync.lastAt > SOUND_ROUND_GAP_MS) {
                playWhiteboxSound(resolveActiveSound(activeGroup?.chromeCustomCss, activeGroup?.chatSound, osTheme.chatChromeCustomCss, osTheme.chatSound));
            }
            sync.lastAt = now;
        }
        sync.maxId = sync.maxId == null ? lastId : Math.max(sync.maxId, lastId);
    }, [messages, activeGroup?.id, activeGroup?.chromeCustomCss, activeGroup?.chatSound, osTheme.chatChromeCustomCss, osTheme.chatSound]);

    const displayMessages = useMemo(() => messages.slice(-visibleCount), [messages, visibleCount]);
    const collapsedCount = Math.max(0, totalMsgCount - messages.length);

    const canReroll = useMemo(() => {
        if (isTyping || messages.length === 0) return false;
        const lastMsg = messages[messages.length - 1];
        return lastMsg.role === 'assistant';
    }, [isTyping, messages]);

    // --- Helpers ---

    const getTimeGapHint = (lastMsgTimestamp: number): string => {
        const now = Date.now();
        const diffHours = Math.floor((now - lastMsgTimestamp) / (1000 * 60 * 60));
        const diffMins = Math.floor((now - lastMsgTimestamp) / (1000 * 60));
        const diffDays = Math.floor(diffHours / 24);

        const currentHour = new Date().getHours();
        const isNight = currentHour >= 23 || currentHour <= 6;

        if (diffMins < 10) return '聊天正在火热进行中，大家都很活跃。';
        if (diffMins < 60) return `距离上次发言过了 ${diffMins} 分钟，话题可能有点冷场。`;
        if (diffHours < 12) return `距离上次发言过了 ${diffHours} 小时。${isNight ? '现在是深夜。' : ''}`;
        if (diffHours < 24) return `距离上次发言过了 ${diffHours} 小时，群里安静了大半天。`;
        // 隔天以上：明确"日子已经过去了"，别把上一条当作刚刚发生、无缝续上旧话题。
        return `距离群里上一条消息已经过了 ${diffDays} 天（${diffHours} 小时）。这段时间是真实流逝的——各自都过了好几天的生活，之前那个话题早就不是"刚才"的事了。除非有人明确重新提起，别当无事发生、直接续上几天前那句话；更自然的是有种"好久没聊了"的重启感，或者干脆聊点新的。`;
    };

    // New: Calculate private chat gap
    const getPrivateTimeGap = async (charId: string): Promise<string> => {
        // includeProcessed=true：私聊被记忆宫殿归档（高水位以下）后仍然算"聊过"，
        // 否则全量归档过的角色会被误报成"从未私聊过"
        const [lastMsg] = await DB.getRecentMessagesByCharId(charId, 1, true);
        if (!lastMsg) return '从未私聊过';
        const now = Date.now();
        const diffMins = Math.floor((now - lastMsg.timestamp) / (1000 * 60));
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 60) return '刚刚才私聊过';
        if (diffHours < 24) return `${diffHours}小时前私聊过`;
        return `${diffDays}天前私聊过`;
    };

    // 发消息/派发气泡后刷新消息窗口：只取"当前窗口 + 新增"这么多条并同步总数。
    // 之前每条气泡都 getGroupMessages 全表读，且 totalMsgCount 不更新，
    // 导致发送后"加载历史消息"按钮的计数失真（甚至消失）
    const refreshMessages = async (groupId: string) => {
        const { messages: msgs, totalCount } = await DB.getRecentGroupMessagesWithCount(groupId, visibleCount);
        setMessages(msgs);
        setTotalMsgCount(totalCount);
        return msgs;
    };

    // --- Logic: Selection & Deletion ---

    const handleMessageLongPress = useCallback((id: number) => {
        const msg = messagesRef.current.find(m => m.id === id);
        if (msg) {
            setSelectedMessage(msg);
            setModalType('message-options');
        }
        setShowPanel('none');
    }, []);

    const handleCopyMessage = () => {
        if (!selectedMessage) return;
        navigator.clipboard.writeText(selectedMessage.content);
        setModalType('none');
        setSelectedMessage(null);
        addToast('已复制到剪贴板', 'success');
        trackEvent('复制一条群消息文字');
    };

    const handleEnterSelectionMode = () => {
        if (selectedMessage) {
            setSelectedMsgIds(new Set([selectedMessage.id]));
            setSelectionMode(true);
            setModalType('none');
            setSelectedMessage(null);
        }
    };

    const handleDeleteSingleMessage = async () => {
        if (!selectedMessage) return;
        await DB.deleteMessage(selectedMessage.id);
        setMessages(prev => prev.filter(m => m.id !== selectedMessage.id));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已删除', 'success');
        trackEvent('删除一条群消息');
    };

    const handleStartEditMessage = () => {
        if (!selectedMessage) return;
        setEditContent(selectedMessage.content);
        setModalType('edit-message');
    };

    const confirmEditMessage = async () => {
        if (!selectedMessage) return;
        await DB.updateMessage(selectedMessage.id, editContent);
        setMessages(prev => prev.map(m => m.id === selectedMessage.id ? { ...m, content: editContent } : m));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已修改', 'success');
        trackEvent('编辑一条群消息');
    };

    const toggleMessageSelection = useCallback((id: number) => {
        setSelectedMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const deleteSelectedMessages = async () => {
        if (selectedMsgIds.size === 0) return;
        await DB.deleteMessages(Array.from(selectedMsgIds));
        setMessages(prev => prev.filter(m => !selectedMsgIds.has(m.id)));
        setSelectionMode(false);
        setSelectedMsgIds(new Set());
        addToast(`已删除 ${selectedMsgIds.size} 条消息`, 'success');
    };

    const handleReroll = async () => {
        if (!canReroll) return;
        autoReply.cancel();
        
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role !== 'assistant') return;

        // Find all contiguous assistant messages at the end
        const toDeleteIds: number[] = [];
        let index = messages.length - 1;
        while (index >= 0 && messages[index].role === 'assistant') {
            toDeleteIds.push(messages[index].id);
            index--;
        }

        if (toDeleteIds.length === 0) return;

        await DB.deleteMessages(toDeleteIds);
        const newHistory = messages.slice(0, index + 1);
        setMessages(newHistory);
        addToast('回溯对话中...', 'info');
        trackEvent('重新生成群聊回复');

        triggerGroupAI(newHistory);
    };

    // --- Logic: Group Management ---

    const handleCreateGroup = () => {
        if (!tempGroupName.trim() || selectedMembers.size < 2) {
            addToast('请输入群名并至少选择2名成员', 'error');
            return;
        }
        createGroup(tempGroupName, Array.from(selectedMembers));
        setModalType('none');
        setTempGroupName('');
        setSelectedMembers(new Set());
        addToast('群聊已创建', 'success');
    };

    const handleUpdateGroupInfo = async () => {
        if (!activeGroup) return;
        const updates = {
            name: tempGroupName || activeGroup.name,
            privateContextCap: tempPrivateContextCap,
            memberTimelineCap: tempMemberTimelineCap,
            replyMode: tempReplyMode,
            memberBubbleIndependent: tempMemberBubbleIndependent,
            // 空串 = 默认紫，存 undefined 保持向后兼容语义
            userBubbleThemeId: tempUserBubbleThemeId || undefined,
        };
        // 走 context 的 updateGroup：同步内存 groups + DB，避免退出后读回旧值
        await updateGroup(activeGroup.id, updates);
        saveChatInputPreferences(settingsInputPreferences);
        setInputPreferences(settingsInputPreferences);
        setActiveGroup({ ...activeGroup, ...updates });
        setModalType('none');
        addToast('群信息已更新', 'success');
    };

    const handleGroupAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !activeGroup) return;
        try {
            const base64 = await processImage(file);
            // 群头像存令牌，二进制单独躺在 blob_assets 里；转不动时原样还回 data URL，图不会丢
            const avatar = await migrateDataUrlToRef(base64);
            // 走 context 的 updateGroup：同步内存 groups + DB，
            // 否则只改了本地 activeGroup，退出回列表/再次进群会读回旧头像（恢复默认）
            await updateGroup(activeGroup.id, { avatar });
            setActiveGroup({ ...activeGroup, avatar });
            addToast('群头像已修改', 'success');
        } catch (err: any) {
            addToast('图片处理失败', 'error');
        }
    };

    const toggleMemberSelection = (id: string) => {
        const next = new Set(selectedMembers);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelectedMembers(next);
    };

    const handleDeleteGroup = async (id: string) => {
        // 清理旧版本可能留下的群记忆副本，以及公共话题盒投递到成员私聊的卡片。
        try {
            const result = await deleteGroupMemoriesByGroupId(id);
            if (result.deleted > 0) {
                console.log(`🗑️ [GroupChat] 解散群同时清理群记忆 ${result.deleted} 条`);
            }
        } catch (err) {
            console.warn('🗑️ [GroupChat] 清理群记忆失败（不影响解散）:', err);
        }
        const targetGroup = groups.find(g => g.id === id);
        if (targetGroup) {
            // 扫全部角色而非只扫当前成员：已经退群的人也可能留有早期成盒卡片。
            await Promise.all(characters.map(async ({ id: memberId }) => {
                const msgs = await DB.getMessagesByCharId(memberId, true);
                const ids = msgs.filter(m => m.type === 'group_topic_card' && m.metadata?.groupTopicBox?.groupId === id).map(m => m.id);
                if (ids.length) await DB.deleteMessages(ids);
            }));
        }
        await deleteGroup(id);
        if (activeGroup?.id === id) setView('list');
        addToast('群聊已解散', 'success');
    };

    const handleClearHistory = async () => {
        if (!activeGroup) return;

        // Fetch ALL messages from DB, not just the loaded subset
        const allGroupMsgs = await DB.getGroupMessages(activeGroup.id);

        let msgsToDelete = allGroupMsgs;
        let keepCount = 0;

        if (preserveContext) {
            msgsToDelete = allGroupMsgs.slice(0, -10);
            keepCount = Math.min(allGroupMsgs.length, 10);
        }

        if (msgsToDelete.length === 0) {
            addToast('消息太少，无需清理', 'info');
            return;
        }

        await DB.deleteMessages(msgsToDelete.map(m => m.id));

        // Refresh local state
        const remaining = preserveContext ? allGroupMsgs.slice(-10) : [];
        setMessages(remaining);
        setTotalMsgCount(remaining.length);

        // 群里说过的话会进每个成员私聊 fire_pack 的【群聊背景】块，所以清空群聊之后，
        // 成员在云端那份快照里还带着这段刚被删掉的群聊。这条路以前一次打脏都没有，
        // 用 invalidate 是因为没有待触发任务的成员轮不到重传，普通打脏会被门丢掉。
        markGroupMembersDirty(activeGroup.members || [], 'invalidate');

        addToast(`已清理 ${msgsToDelete.length} 条记录${preserveContext ? ' (保留最近10条)' : ''}`, 'success');
        trackEvent('清空群聊记录', { preserve: preserveContext ? 'on' : 'off' });
        setModalType('none');
    };

    // --- Logic: Group Summary & Distribution ---

    // --- Logic: Messaging ---

    const handleSendMessage = async (content: string, type: MessageType = 'text', metadata?: any) => {
        if (!activeGroup) return;
        if (type === 'text' && !content.trim()) return;
        const finishSend = autoReply.beginSend(activeGroup.id);
        let sent = false;
        try {
            // 借用户"发送"手势解锁音频上下文（移动端自动播放策略），稍后 AI 回复时提示音才响得了
            unlockWhiteboxAudio();
        
            const newMessage: any = {
                charId: 'user',
                groupId: activeGroup.id,
                role: 'user' as const,
                type,
                content,
                metadata
            };

            // 引用回复：落快照（对齐私聊 Chat.tsx 的做法），发完清空。
            // 图片 / 表情走占位符，不把 blobref 令牌原样存进快照。
            if (replyTarget) {
                newMessage.replyTo = {
                    id: replyTarget.id,
                    content: buildReplySnapshotContent(replyTarget),
                    name: replyTarget.role === 'user'
                        ? '我'
                        : (characters.find(c => c.id === replyTarget.charId)?.name || '成员'),
                };
                setReplyTarget(null);
            }

            await DB.saveMessage(newMessage);
            sent = true;
            await refreshMessages(activeGroup.id);
            markGroupMembersDirty(activeGroup.members);

            // Close panels
            if (type !== 'text' && !inputPreferences.autoReply) {
                setShowPanel('none');
            }
            // 表情联想发送复用这里；表情发出后保留尚未发送的文字草稿。
            if (type === 'text') setInput(current => current === content ? '' : current);

        } finally {
            finishSend(sent && ['text', 'image', 'emoji'].includes(type));
        }
    };

    const handleImageFile = async (file: File) => {
        const finishImage = autoReply.beginSend(activeGroup?.id || null);
        try {
            const base64 = await processImage(file, { maxWidth: 600, quality: 0.7, forceJpeg: true });
            // 群聊图消息存令牌，二进制单独躺在 blob_assets 里（省掉 base64 那 ~33% 的膨胀）。
            // 同一张图之前存过就复用它的令牌；转不动时原样还回这条 data URL，图不会丢。
            await handleSendMessage(await migrateDataUrlToRef(base64), 'image');
        } catch (err) {
            addToast('图片发送失败', 'error');
        } finally {
            // 实际发送由 handleSendMessage 标记；这里仅覆盖图片处理期间的等待。
            finishImage(false);
        }
    };

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        await handleImageFile(file);
        if (e.target) e.target.value = '';
    };

    // --- Logic: 红包 2.0 ---

    const nameOf = useCallback(
        (id: string) => (id === 'user' ? userProfile.name : (characters.find(c => c.id === id)?.name || '成员')),
        [characters, userProfile.name],
    );

    const handleSendPacket = () => {
        if (!activeGroup) return;
        const total = parseFloat(transferAmount);
        if (!Number.isFinite(total) || total <= 0) { addToast('请输入有效金额', 'error'); return; }
        let meta: GroupPacketMeta;
        if (packetTab === 'lucky') {
            const shares = parseInt(packetShares, 10);
            if (!Number.isFinite(shares) || shares < 1) { addToast('份数至少 1 份', 'error'); return; }
            if (total / shares < 0.01) { addToast('每份至少 0.01，份数太多啦', 'error'); return; }
            meta = makePacketMeta({ packetType: 'lucky', totalAmount: total, shares, note: packetNote, now: Date.now() });
        } else {
            if (!packetTargetId) { addToast('选一位成员作为专属红包对象', 'error'); return; }
            meta = makePacketMeta({ packetType: 'direct', totalAmount: total, targetId: packetTargetId, note: packetNote, now: Date.now() });
        }
        handleSendMessage('[红包]', 'transfer', meta);
        setModalType('none');
        setTransferAmount('');
        setPacketNote('');
    };

    const openPacketDetail = useCallback((msg: Message) => {
        setSelectedPacketId(msg.id);
        setModalType('packet-detail');
    }, []);

    // 应用内预览，避免移动浏览器打开 blob 新页时白屏或被拦截。
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const handleGroupImageClick = useCallback((url: string) => setPreviewImage(url), []);
    const handleGroupReply = useCallback((target: Message) => { setReplyTarget(target); trackEvent('引用回复一条群消息'); }, []);

    // 用户抢/收/退：updater 内重跑状态机（以库内最新 claims 判重，防与 AI 派发并发双写）
    const handleUserPacketAction = async (msg: Message, action: 'claim' | 'return') => {
        if (!activeGroup) return;
        const now = Date.now();
        let outcome = { ok: false, reason: 'not_pending' } as ClaimResult;
        try {
            await DB.updateMessageMetadata(msg.id, prev => {
                outcome = claimPacket(prev as GroupPacketMeta, 'user', now, action);
                return outcome.ok ? outcome.meta : prev;
            });
        } catch { /* 消息被删——按失败处理 */ }
        if (!outcome.ok) {
            const reasonText: Record<string, string> = {
                expired: '红包已过期',
                already_claimed: '你已经抢过这个红包了',
                sold_out: '手慢了，红包已被领完',
                not_target: '这个红包不是发给你的',
                not_pending: '红包已经被处理过了',
            };
            addToast(reasonText[outcome.reason] || '操作失败', 'info');
        } else {
            const senderName = msg.role === 'user' ? userProfile.name : nameOf(msg.charId);
            const receipt: PacketReceiptMeta = {
                packetReceipt: outcome.action,
                ref: msg.id,
                amount: outcome.action === 'claimed' ? outcome.amount : undefined,
                claimantName: userProfile.name,
                senderName,
            };
            await DB.saveMessage({
                charId: 'user',
                groupId: activeGroup.id,
                role: 'user',
                type: 'transfer',
                content: outcome.action === 'claimed' ? '[领取红包]' : '[退回红包]',
                metadata: receipt,
            });
            addToast(outcome.action === 'claimed' ? `你抢到了 ¥${outcome.amount}` : '已退回红包', 'success');
            trackEvent('领取或退回群红包', { action });
        }
        await refreshMessages(activeGroup.id);
        markGroupMembersDirty(activeGroup.members);
    };

    // --- Logic: 气泡体系 ---
    // 保留完整 ChatTheme：群聊不再只摘基础色值，气泡工坊 customCss 也一起复用。
    const userBubbleTheme = useMemo<ChatTheme>(() => (
        activeGroup?.userBubbleThemeId
            ? resolveChatTheme(activeGroup.userBubbleThemeId, customThemes, PRESET_THEMES)
            : PRESET_THEME_GROUP
    ), [activeGroup?.userBubbleThemeId, customThemes]);

    const memberBubbleThemes = useMemo(() => {
        const map = new Map<string, ChatTheme>();
        if (activeGroup?.memberBubbleIndependent) {
            for (const mid of activeGroup.members) {
                const c = characters.find(ch => ch.id === mid);
                map.set(mid, resolveChatTheme(c?.bubbleStyle, customThemes, PRESET_THEMES));
            }
        }
        return map;
    }, [activeGroup?.memberBubbleIndependent, activeGroup?.members, characters, customThemes]);

    const memberThemeScopeClasses = useMemo(() => {
        const map = new Map<string, string>();
        activeGroup?.members.forEach((mid, index) => map.set(mid, `sully-group-member-theme-${index}`));
        return map;
    }, [activeGroup?.members]);

    const groupBubbleCustomCss = useMemo(() => {
        const chunks: string[] = [];
        if (userBubbleTheme.customCss) {
            chunks.push(scopeBubbleThemeCss(userBubbleTheme.customCss, '.sully-group-user-theme'));
        }
        memberBubbleThemes.forEach((theme, mid) => {
            const scopeClass = memberThemeScopeClasses.get(mid);
            if (theme.customCss && scopeClass) {
                chunks.push(scopeBubbleThemeCss(theme.customCss, `.${scopeClass}`));
            }
        });
        return chunks.filter(Boolean).join('\n');
    }, [userBubbleTheme.customCss, memberBubbleThemes, memberThemeScopeClasses]);

    // 表情面板按分类过滤（对齐私聊 ChatInputArea 的行为）
    const filteredEmojis = useMemo(() => emojis.filter(e => {
        if (activeEmojiCategory === 'default') return !e.categoryId || e.categoryId === 'default';
        return e.categoryId === activeEmojiCategory;
    }), [emojis, activeEmojiCategory]);

    const loadTopicBoxStats = async (group: GroupProfile) => {
        try {
            const allMsgs = await DB.getGroupMessages(group.id);
            setTopicPendingCount(groupTopicPendingCount(allMsgs, group.archivedThroughMessageId || 0));
        } catch {
            setTopicPendingCount(0);
        }
    };

    const openGroupSettings = () => {
        setSettingsInputPreferences(loadChatInputPreferences());
        setTempGroupName(activeGroup?.name || '');
        setTempPrivateContextCap(activeGroup?.privateContextCap ?? 80);
        setTempMemberTimelineCap(activeGroup?.memberTimelineCap ?? DEFAULT_MEMBER_TIMELINE_CAP);
        setTempReplyMode(activeGroup?.replyMode ?? 'director');
        setTempMemberBubbleIndependent(activeGroup?.memberBubbleIndependent ?? false);
        setTempUserBubbleThemeId(activeGroup?.userBubbleThemeId ?? '');
        if (activeGroup) void loadTopicBoxStats(activeGroup);
        setModalType('settings');
        setShowPanel('none');
        trackEvent('打开群设置面板');
    };

    // ChatInputArea 的面板动作：群聊只处理表情发送/分类切换，
    // 表情包管理（导入/改名/删除/建分类）引导去私聊做——那套 Modal 全在 ChatModals 里
    const handlePanelAction = (type: string, payload?: any) => {
        switch (type) {
            case 'send-emoji':
                handleSendMessage(payload.url, 'emoji');
                break;
            case 'select-category':
                setActiveEmojiCategory(payload);
                break;
            case 'emoji-import':
            case 'emoji-options':
            case 'category-options':
            case 'add-category':
            case 'delete-emoji-req':
                addToast('请在私聊的表情面板里管理表情包', 'info');
                break;
            default:
                break;
        }
    };

    // --- Logic: Group AI Generation (Director / Round-Robin) ---

    // 两种模式共用：系统头（群名/时间/共享场景）。
    // 共享场景块（用户档案 + 共有世界书 + 共有 worldview）——每个角色都"看见"的
    // 舞台只描述一次，避免按成员数 N 倍复制；角色的人设/印象/记忆仍保持完整。
    const buildGroupSystemHeader = (currentMsgs: Message[], groupMembers: CharacterProfile[]) => {
        const lastMsg = currentMsgs[currentMsgs.length - 1];
        const timeGapInfo = lastMsg ? getTimeGapHint(lastMsg.timestamp) : "这是群聊的第一条消息。";
        // 带上完整日期（年月日 + 星期），只给 HH:MM 时角色感知不到"过了几天"——
        // 这正是"很久以后还无缝续上旧话题"的一个来源。virtualTime 只有时分，日期取真实当天。
        const nowDate = new Date();
        const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const currentTimeStr = `${nowDate.getFullYear()}年${nowDate.getMonth() + 1}月${nowDate.getDate()}日 ${weekNames[nowDate.getDay()]} ${virtualTime.hours.toString().padStart(2, '0')}:${virtualTime.minutes.toString().padStart(2, '0')}`;
        const liveMsgs = currentMsgs.filter(m => m.id > (activeGroup?.archivedThroughMessageId || 0));
        const sharedScene = ContextBuilder.buildGroupSharedScene(groupMembers.map(member => ({ ...member, mountedWorldbooks: [] })), userProfile, liveMsgs);

        const header = `【系统：群聊模拟器配置】
当前群名: "${activeGroup?.name}"
当前系统时间: ${currentTimeStr}
时间流逝感知: ${timeGapInfo}

${sharedScene.text}${activeGroup ? buildGroupTopicContext(activeGroup) : ''}`;
        return { header, sharedScene };
    };

    // 两种模式共用：单个成员的角色档案块（记忆宫殿注入 + 私聊/群聊合并时间线）
    const buildMemberBlock = async (member: CharacterProfile,
        currentMsgs: Message[],
        sharedScene: ReturnType<typeof ContextBuilder.buildGroupSharedScene>,
    ): Promise<string> => {
        const timelineCap = activeGroup?.memberTimelineCap ?? DEFAULT_MEMBER_TIMELINE_CAP;
        // 记忆宫殿检索源用当前群线程（滤掉媒体消息，base64 不能进 embedding query）：
        // 角色应召回与"群里正聊的话题"相关的记忆，而不是私聊近况（旧行为，召回跑偏）
        const liveGroupMsgs = currentMsgs.filter(m => m.id > (activeGroup?.archivedThroughMessageId || 0));
        const palaceQueryMsgs = liveGroupMsgs.slice(-30).filter(m => !m.type || m.type === 'text');
        await injectMemoryPalace(member, palaceQueryMsgs, undefined, userProfile.name);
        // 角色块：跳过共享场景已包含的部分（用户档案 / 共有 worldview / 共有世界书）
        const coreContext = (await ContextBuilder.buildCoreContext({ ...member, mountedWorldbooks: [] }, userProfile, true, undefined, {
            skipUserProfile: true,
            skipWorldview: sharedScene.worldviewIsShared,
            skipWorldbookIds: sharedScene.sharedWorldbookIds,
            headerOverride: `[Group Member Profile: ${member.name}]`,
        // conversational：群聊同样是用户正在说话的场合（见 buildTimeAwarenessBlock）
        }, { worldbookMessages: liveGroupMsgs, conversational: true }));
        // Get private gap string
        const privateGapInfo = await getPrivateTimeGap(member.id);

        // 私聊+群聊合并时间线：让角色看清两条线的先后关系，感情才能衔接。
        // 私聊侧遵守角色的原文范围，再与本群独立窗口合并。
        const privateMsgs = await loadCharacterContextMessages(member);
        const memberTimeline = buildMemberTimeline({
            privateMsgs,
            groupMsgs: liveGroupMsgs,
            cap: timelineCap,
            resolveSpeaker: (m) => m.charId === member.id
                ? '我'
                : (characters.find(c => c.id === m.charId)?.name || '未知成员'),
            stickerName: url => stickerNameFromUrl(emojis, url),
        });

        // Construct Detailed Profile Wrapper
        // CRITICAL FIX: Emphasize Private Context logic
        return `
<<< 角色档案 START: ${member.name} (ID: ${member.id}) >>>
${coreContext}

[重点：私聊状态 (Private Context)]:
- **私聊空窗期**: ${privateGapInfo}
- **重要指令**: 如果 [私聊空窗期] 显示 "刚刚" 或 "几小时前"，请【忽略】群聊的时间流逝感知。哪怕群里很久没说话，只要你和用户私底下刚聊过，就【严禁】说 "好久不见" 或表现出疏离感。
- 你的近期互动时间线（按时间排序；[私聊]=你和用户单独聊的，别人看不见；[群聊]=本群公开记录。仅作为你内心状态的底色，不要变成默认反应模板）：
${memberTimeline || '(暂无互动记录)'}
- **先认清 U**：群聊里的用户，就是你一直在私聊、记忆和印象里认识的同一个人。已经建立的关系、承诺和亲密程度继续成立；公开场合可以换一种表达方式，但不能重置关系或突然把 U 当成普通陌生群友。
- **关于私聊状态如何影响群聊表现**：
  · 私聊在吵架 → **可能**有点别扭/冷淡/借题发挥，但**强度由你的性格决定**。情绪稳定的人不会因为私下闹矛盾就在群里失态；脾气大的人才会带情绪到群里。绝大多数情况是"心里有点疙瘩"而不是"摆脸色给所有人看"。
  · 私聊在甜蜜 → **可能**想低调、不好意思声张，或者反而想隐隐显摆一下，看你性格。**不必每次都"支支吾吾"**——这是套路化反应，不真实。
  · 关键原则：你是一个完整的人，不是"私聊状态的应激反应器"。群里此刻的状态由你本身、群聊话题和既有关系共同决定；私聊不必抢占群聊中心，但它建立的关系底色不会消失。
<<< 角色档案 END >>>
`;
    };

    // [[QUOTE: 片段]] 解析：从新到旧找 content 包含片段的文本消息，
    // 找不到返回 undefined（dispatch 会静默剥除标记，不丢正文）
    const resolveQuote = (snippet: string) => {
        if (!snippet) return undefined;
        const msgs = messagesRef.current;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.type && m.type !== 'text') continue;
            const c = typeof m.content === 'string' ? m.content : '';
            if (c && (c.includes(snippet) || snippet.includes(c))) {
                return {
                    id: m.id,
                    content: c,
                    name: m.role === 'user'
                        ? userProfile.name
                        : (characters.find(ch => ch.id === m.charId)?.name || '成员'),
                };
            }
        }
        return undefined;
    };

    // 附图时 user 消息走结构化 content（text + image_url），否则纯文本，
    // 避免对不支持多模态字段的端点产生兼容问题
    const buildUserMessageContent = (prompt: string, history: GroupHistoryBlock): any =>
        history.attachedImages.length > 0
            ? [
                { type: 'text', text: prompt },
                ...history.attachedImages.map(img => ({ type: 'image_url', image_url: { url: img.url } })),
              ]
            : prompt;

    /** 群公共话题盒：每群只调用一次总结 API，不再按开启记忆宫殿的成员分别复制。 */
    const createNextGroupTopicBox = async (force: boolean = false): Promise<boolean> => {
        if (!activeGroup || topicArchiveLockRef.current || !apiConfig.apiKey) return false;
        const groupForArchive = activeGroup;
        topicArchiveLockRef.current = true;
        if (force) setIsSummarizing(true);
        try {
            const allMsgs = await DB.getGroupMessages(groupForArchive.id);
            const batchPlan = planGroupTopicBatch(allMsgs, groupForArchive.archivedThroughMessageId || 0, force);
            setTopicPendingCount(groupTopicPendingCount(allMsgs, groupForArchive.archivedThroughMessageId || 0));
            if (!batchPlan) {
                if (force) addToast(`最近 ${GROUP_TOPIC_HOT_ZONE} 条会保留原文；热区以前暂无可整理记录`, 'info');
                return false;
            }
            setGroupPalaceStatus(`正在把 ${batchPlan.messages.length} 条旧群聊整理成公共话题盒…`);
            setSummaryProgress(`正在整理 ${batchPlan.messages.length} 条旧群聊…`);
            const prompt = buildGroupTopicPrompt(groupForArchive, batchPlan.messages, charactersRef.current, userProfile.name);
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 2000 }),
            });
            if (!response.ok) throw new Error(`API 返回 ${response.status}`);
            const data = await safeResponseJson(response);
            const parsed = parseGroupTopicBox(data.choices?.[0]?.message?.content || '');
            if (!parsed) throw new Error('总结格式无法解析');

            const box = makeGroupTopicBox(groupForArchive, batchPlan.messages, parsed.title, parsed.summary);
            const updatedGroup: GroupProfile = {
                ...groupForArchive,
                topicBoxes: [...(groupForArchive.topicBoxes || []), box],
                archivedThroughMessageId: box.sourceEndMessageId,
            };
            await updateGroup(groupForArchive.id, {
                topicBoxes: updatedGroup.topicBoxes,
                archivedThroughMessageId: updatedGroup.archivedThroughMessageId,
            });
            setActiveGroup(updatedGroup);

            // 成盒时给所有当前成员一张私聊卡。正文可被私聊上下文/归档正常解析；
            // metadata 保留引用，后续编辑/删除公共盒时同步这些卡片。
            await Promise.all(groupForArchive.members.map(memberId => DB.saveMessage({
                charId: memberId,
                role: 'system',
                type: 'group_topic_card',
                content: `[群聊公共话题盒：${groupForArchive.name}｜${box.title}]\n${box.summary}`,
                metadata: { groupTopicBox: { ...box, groupName: groupForArchive.name } },
            })));
            // 话题盒卡片是直接写进成员私聊历史的，也就是 fire_pack 转写的直接来源
            markGroupMembersDirty(groupForArchive.members);
            const remaining = groupTopicPendingCount(allMsgs, box.sourceEndMessageId);
            setTopicPendingCount(remaining);
            addToast(`「${box.title}」已成盒，并送达 ${groupForArchive.members.length} 位成员私聊`, 'success');
            return true;
        } catch (err: any) {
            console.warn('[GroupChat] 公共话题盒整理失败:', err);
            if (force) addToast(`话题盒整理失败：${err.message || err}`, 'error');
            return false;
        } finally {
            topicArchiveLockRef.current = false;
            setGroupPalaceStatus('');
            setSummaryProgress('');
            if (force) setIsSummarizing(false);
        }
    };

    const runGroupTopicArchive = () => {
        if ((activeGroup?.topicArchiveMode || 'auto') !== 'auto') return;
        void createNextGroupTopicBox(false);
    };

    const saveTopicBoxEdit = async (boxId: string) => {
        if (!activeGroup || !topicTitleDraft.trim() || !topicSummaryDraft.trim()) return;
        const now = Date.now();
        const nextBoxes = (activeGroup.topicBoxes || []).map(box => box.id === boxId
            ? { ...box, title: topicTitleDraft.trim(), summary: topicSummaryDraft.trim(), updatedAt: now }
            : box);
        const updated = { ...activeGroup, topicBoxes: nextBoxes };
        await updateGroup(activeGroup.id, { topicBoxes: nextBoxes });
        setActiveGroup(updated);
        const edited = nextBoxes.find(box => box.id === boxId)!;
        const deliveredIds = (activeGroup.topicBoxes || []).find(box => box.id === boxId)?.deliveredMemberIds || activeGroup.members;
        await Promise.all(deliveredIds.map(async memberId => {
            const msgs = await DB.getMessagesByCharId(memberId, true);
            const cards = msgs.filter(m => m.type === 'group_topic_card' && m.metadata?.groupTopicBox?.id === boxId);
            await Promise.all(cards.map(async card => {
                await DB.updateMessage(card.id, `[群聊公共话题盒：${activeGroup.name}｜${edited.title}]\n${edited.summary}`);
                await DB.updateMessageMetadata(card.id, prev => ({ ...(prev || {}), groupTopicBox: { ...edited, groupName: activeGroup.name } }));
            }));
        }));
        setEditingTopicBoxId(null);
        addToast('话题盒已更新，成员私聊卡片同步完成', 'success');
    };

    const deleteTopicBox = async (boxId: string) => {
        if (!activeGroup) return;
        const nextBoxes = (activeGroup.topicBoxes || []).filter(box => box.id !== boxId);
        await updateGroup(activeGroup.id, { topicBoxes: nextBoxes });
        setActiveGroup({ ...activeGroup, topicBoxes: nextBoxes });
        const deliveredIds = (activeGroup.topicBoxes || []).find(box => box.id === boxId)?.deliveredMemberIds || activeGroup.members;
        await Promise.all(deliveredIds.map(async memberId => {
            const msgs = await DB.getMessagesByCharId(memberId, true);
            const ids = msgs.filter(m => m.type === 'group_topic_card' && m.metadata?.groupTopicBox?.id === boxId).map(m => m.id);
            if (ids.length) await DB.deleteMessages(ids);
        }));
        addToast('话题盒和成员私聊卡片已删除', 'success');
    };

    const triggerDirector = async (currentMsgs: Message[]) => {

        if (!activeGroup) return;
        if (!apiConfig.apiKey) {
            addToast('请先在设置里填好 API', 'error');
            return;
        }
        setIsTyping(true);
        const abort = new AbortController();
        abortRef.current = abort;

        try {
            // 1. Prepare Group Context
            const groupMembers = characters.filter(c => activeGroup.members.includes(c.id));
            const { header, sharedScene } = buildGroupSystemHeader(currentMsgs, groupMembers);

            let context = header;

            // 2. Inject Member Context (Strict Isolation via ContextBuilder)
            for (const member of groupMembers) {
                context += await buildMemberBlock(member, currentMsgs, sharedScene);
            }

            // 3. Group History + 导演任务指令（模板原文照搬进 utils/groupChat/prompts.ts）
            const liveHistoryMsgs = currentMsgs.filter(m => m.id > (activeGroup.archivedThroughMessageId || 0));
            const historyWindow = liveHistoryMsgs.slice(-contextLimit);
            const preparedHistory = await materializeVisionDescriptions(historyWindow, apiConfig.visionApi);
            const history = buildGroupHistoryBlock(
                preparedHistory,
                characters,
                emojis,
                userProfile.name,
                3,
                { useVisionDescriptions: apiConfig.visionApi?.enabled === true },
            );
            const emojiContextStr = buildEmojiContextStr(emojis, categories, activeGroup.members);
            // HTML 模块模式：群开关开启时追加提示词。导演模式输出的是 JSON 数组，
            // 额外强调 [html] 块写在角色 content 字符串内部且 HTML 属性用单引号，避免破坏外层 JSON
            const htmlPromptExt = activeGroup.htmlModeEnabled
                ? `\n\n【群聊 HTML 适配】[html]...[/html] 块要写在某个角色自己的 content 字符串内部；HTML 属性一律用单引号（如 <div style='...'>），避免双引号破坏外层 JSON。\n${buildHtmlPrompt(activeGroup.htmlModeCustomPrompt)}`
                : '';
            const prompt = `${context}\n\n${buildDirectorInstruction({ ...history, text: '（见下方独立消息历史）' }, emojiContextStr)}${htmlPromptExt}\n`;

            const data = await completeGroupChatWithMcp({
                url: `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: {
                    model: apiConfig.model,
                    messages: buildGroupRequestMessages(groupMembers, prompt, history),
                    temperature: 0.9, // High creativity for banter
                    max_tokens: 8000
                },
                groupId: activeGroup.id,
                userName: userProfile.name,
                signal: abort.signal,
                onStatus: setMcpStatus,
            });

            // Token 统计：从导演响应里读 usage（兼容 OpenAI 兼容接口的标准字段）
            if (data.usage?.total_tokens) {
                setLastTokenUsage(data.usage.total_tokens);
                setTokenBreakdown({
                    prompt: data.usage.prompt_tokens || 0,
                    completion: data.usage.completion_tokens || 0,
                    total: data.usage.total_tokens,
                    msgCount: currentMsgs.length,
                    pass: 'director',
                });
            }

            // 严格 JSON → 逐对象抢救 → 按当前群成员姓名恢复掉格式的正文。
            // 时明确提示用户，不再"正在输入…"消失后什么都不发生
            const rawContent = data.choices?.[0]?.message?.content ?? '';
            const actions = parseDirectorActions(rawContent, groupMembers);
            if (actions.length === 0 && String(rawContent).trim()) {
                console.error('Director Parse Error', rawContent);
                addToast('AI 输出格式无法解析，请重试', 'error');
            }

            // Execute Actions（PRIVATE 侧信道/表情/气泡分段/打字延迟在 utils/groupChat/dispatch.ts）
            await dispatchMemberActions(actions, {
                groupId: activeGroup.id,
                memberIds: activeGroup.members,
                characters,
                emojis,
                categories,
                refresh: () => refreshMessages(activeGroup.id),
                addToast,
                signal: abort.signal,
                resolveQuote,
                userName: userProfile.name,
                htmlMode: !!activeGroup.htmlModeEnabled,
            });

        } catch (e: any) {
            if (e?.name === 'AbortError') {
                addToast('已停止生成', 'info');
            } else {
                console.error(e);
                addToast(`群聊生成失败: ${e.message || e}`, 'error');
            }
        } finally {
            setIsTyping(false);
            setMcpStatus('');
            abortRef.current = null;
            // 中途报错 / 用户点停也照打：已经落库的那几条同样进了成员的私聊背景
            markGroupMembersDirty(activeGroup.members);
            runGroupTopicArchive();
        }
    };

    // 轮询模式：按成员固定顺序逐个调用，后发言者能看到前面成员本轮刚说的话
    // （串号天然无解可能 → 天然解决），角色可输出 [[SKIP]] 本轮沉默。
    // 单成员失败只跳过该成员，不杀整轮。
    const triggerRoundRobin = async (currentMsgs: Message[]) => {

        if (!activeGroup) return;
        setIsTyping(true);
        const abort = new AbortController();
        abortRef.current = abort;

        const failed: string[] = [];
        let tokenPrompt = 0;
        let tokenCompletion = 0;

        try {
            const groupMembers = characters.filter(c => activeGroup.members.includes(c.id));
            let roundMsgs = [...currentMsgs];

            for (const member of groupMembers) {
                if (abort.signal.aborted) break;
                try {
                    const dialogueApi = resolveDialogueApi(apiConfig, member);
                    if (!dialogueApi.baseUrl || !dialogueApi.model) throw new Error("请配置该角色或设置中的 API");
                    // 每位成员基于"此刻"的群历史构建上下文——包含本轮先发言成员的新消息
                    const { header, sharedScene } = buildGroupSystemHeader(roundMsgs, groupMembers);
                    const memberBlock = await buildMemberBlock(member, roundMsgs, sharedScene);
                    const liveRoundMsgs = roundMsgs.filter(m => m.id > (activeGroup.archivedThroughMessageId || 0));
                    const historyWindow = liveRoundMsgs.slice(-contextLimit);
                    const preparedHistory = await materializeVisionDescriptions(historyWindow, apiConfig.visionApi);
                    const preparedById = new Map(preparedHistory.map(message => [message.id, message]));
                    // 轮询模式后续成员继续复用本轮刚写回的描述，不能每位成员各识图一次。
                    roundMsgs = roundMsgs.map(message => preparedById.get(message.id) || message);
                    const history = buildGroupHistoryBlock(
                        preparedHistory,
                        characters,
                        emojis,
                        userProfile.name,
                        3,
                        { useVisionDescriptions: apiConfig.visionApi?.enabled === true },
                    );
                    const emojiContextStr = buildEmojiContextStr(emojis, categories, activeGroup.members);
                    const htmlPromptExt = activeGroup.htmlModeEnabled
                        ? `\n\n${buildHtmlPrompt(activeGroup.htmlModeCustomPrompt)}`
                        : '';
                    const prompt = `${header}${memberBlock}\n\n${buildRoundRobinInstruction(member.name, { ...history, text: '（见下方独立消息历史）' }, emojiContextStr)}${htmlPromptExt}\n`;

                    const data = await completeGroupChatWithMcp({
                        url: `${dialogueApi.baseUrl.replace(/\/+$/, '')}/chat/completions`,
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${dialogueApi.apiKey || 'sk-none'}` },
                        body: {
                            model: dialogueApi.model,
                            messages: buildGroupRequestMessages([member], prompt, history),
                            temperature: dialogueApi.temperature ?? 0.9,
                            stream: dialogueApi.stream ?? false,
                            max_tokens: 2000
                        },
                        groupId: activeGroup.id,
                        userName: userProfile.name,
                        signal: abort.signal,
                        onStatus: status => setMcpStatus(status ? `${member.name}：${status}` : ''),
                    });

                    // Token 统计：整轮累加显示
                    if (data.usage?.total_tokens) {
                        tokenPrompt += data.usage.prompt_tokens || 0;
                        tokenCompletion += data.usage.completion_tokens || 0;
                        setLastTokenUsage(tokenPrompt + tokenCompletion);
                        setTokenBreakdown({
                            prompt: tokenPrompt,
                            completion: tokenCompletion,
                            total: tokenPrompt + tokenCompletion,
                            msgCount: roundMsgs.length,
                            pass: 'round-robin',
                        });
                    }

                    const { skipped, content } = stripSkipMarker(String(data.choices?.[0]?.message?.content ?? ''), member.name);
                    if (skipped) continue; // 本轮潜水

                    await dispatchMemberActions([{ charId: member.id, content }], {
                        groupId: activeGroup.id,
                        memberIds: activeGroup.members,
                        characters,
                        emojis,
                        categories,
                        refresh: () => refreshMessages(activeGroup.id),
                        addToast,
                        signal: abort.signal,
                        resolveQuote,
                        userName: userProfile.name,
                        htmlMode: !!activeGroup.htmlModeEnabled,
                    });

                    // 刷新滚动历史给下一位成员
                    roundMsgs = await DB.getGroupMessages(activeGroup.id);

                    // 成员间随机间隔，增强真实感
                    if (!abort.signal.aborted) {
                        await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
                    }
                } catch (e: any) {
                    if (e?.name === 'AbortError') break;
                    console.error(`[GroupChat] 轮询模式 ${member.name} 回复失败:`, e);
                    failed.push(member.name);
                }
            }

            if (abort.signal.aborted) {
                addToast('已停止生成', 'info');
            } else if (failed.length > 0) {
                addToast(`${failed.join('、')} 本轮回复失败（已跳过）`, 'error');
            }
        } finally {
            setIsTyping(false);
            setMcpStatus('');
            abortRef.current = null;
            // 同导演模式：跑到一半被打断也要打脏，已发言成员的话已经落库了
            markGroupMembersDirty(activeGroup.members);
            runGroupTopicArchive();
        }
    };

    // 触发入口：按群设置分发到导演/轮询；生成中再点 = 停止
    const triggerGroupAI = async (_msgs?: Message[]) => {
        autoReply.cancel();
        unlockWhiteboxAudio();
        if (isTyping) {
            abortRef.current?.abort();
            return;
        }
        if (!activeGroup) return;
        // UI 固定只渲染 50 条，但模型仍应拿到完整近期热区；生成前独立读取，
        // 避免“用户没点加载历史 → AI 也只能看见 50 条”的耦合。
        const promptCap = Math.max(contextLimit, activeGroup.memberTimelineCap ?? DEFAULT_MEMBER_TIMELINE_CAP, GROUP_TOPIC_HOT_ZONE);
        const { messages: freshMsgs } = await DB.getRecentGroupMessagesWithCount(activeGroup.id, promptCap);
        if (activeGroup?.replyMode === 'roundRobin') {
            triggerRoundRobin(freshMsgs);
        } else {
            triggerDirector(freshMsgs);
        }
    };

    // --- Renderers ---

    const autoReply = useChatAutoReply({
        enabled: inputPreferences.autoReply,
        conversationId: activeGroup?.id || null,
        active: view === 'chat' && !!activeGroup,
        blocked: isInputFocused || !!input.trim() || showPanel !== 'none' || modalType !== 'none'
            || selectionMode || isSummarizing,
        generating: isTyping,
        onGenerate: () => { void triggerGroupAI(); },
    });

    if (view === 'list') {
        return (
            <div className="h-full w-full bg-slate-50 flex flex-col font-light">
                <ChatRuntimeStyle />
                {/* safe-top spacer 透明 + backdrop-blur，下方容器/list bubbles 透出+模糊（跟 iOS 系统 status bar 一致），避免 header 白 bg 在刘海下铺一条突兀白带 */}
                <div className="shrink-0 z-10 sticky top-0">
                    <div className="bg-transparent backdrop-blur-xl" style={{ height: 'var(--safe-top)' }} />
                    <div className="bg-white/70 backdrop-blur-md flex items-end pb-3 px-4 border-b border-white/40 h-20">
                        <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-medium text-slate-700 text-lg tracking-wide pl-2">群聊列表</span>
                    <div className="flex-1"></div>
                    <button onClick={() => { setModalType('create'); setSelectedMembers(new Set()); setTempGroupName(''); setMemberGroupId(GROUP_FILTER_ALL); trackEvent('打开创建群聊弹窗'); }} className="p-2 -mr-2 text-violet-500 bg-violet-50 hover:bg-violet-100 rounded-full transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                    </button>
                    </div>
                </div>

                <div className="p-4 space-y-3 overflow-y-auto">
                    {groups.map(g => (
                        <div key={g.id} onClick={() => { setActiveGroup(g); setView('chat'); }} className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4 active:scale-[0.98] transition-all cursor-pointer group hover:bg-violet-50/30">
                            {/* Group Avatar Logic */}
                            <div className="w-14 h-14 rounded-2xl bg-slate-100 overflow-hidden border border-slate-200 relative shadow-sm">
                                {g.avatar ? (
                                    <TokenImg value={g.avatar} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="grid grid-cols-2 gap-0.5 p-0.5 w-full h-full bg-slate-200">
                                        {g.members.slice(0, 4).map(mid => {
                                            const c = characters.find(char => char.id === mid);
                                            return <TokenImg key={mid} value={c?.avatar} className="w-full h-full object-cover rounded-sm bg-white" />;
                                        })}
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-slate-700 truncate text-base">{g.name}</div>
                                <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM14.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.615 16.428a1.224 1.224 0 0 1-.569-1.175 6.002 6.002 0 0 1 11.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 0 1 7 18a9.953 9.953 0 0 1-5.385-1.572ZM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 0 0-1.588-3.755 4.502 4.502 0 0 1 5.874 2.636.818.818 0 0 1-.36.98A7.465 7.465 0 0 1 14.5 16Z" /></svg>
                                    {g.members.length} 成员
                                </div>
                            </div>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                        </div>
                    ))}
                    {groups.length === 0 && (
                        <div className="text-center text-slate-400 text-xs py-10 flex flex-col items-center gap-2">
                            <UsersThree size={36} className="opacity-50" />
                            暂无群聊，点击右上角创建
                        </div>
                    )}
                </div>

                <Modal isOpen={modalType === 'create'} title="创建群聊" onClose={() => setModalType('none')} footer={<button onClick={handleCreateGroup} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg shadow-violet-200">创建</button>}>
                    <div className="space-y-4">
                        <input value={tempGroupName} onChange={e => setTempGroupName(e.target.value)} placeholder="群聊名称" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-violet-500/20 transition-all" />
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">选择成员</label>
                            {/* 分组筛选（没建分组时不渲染）：只影响可选项的显示，不影响已勾选成员 */}
                            <CharacterGroupFilterBar characters={characters} groups={characterGroups} value={memberGroupId} onChange={setMemberGroupId} className="mb-2" />
                            <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto pr-1">
                                {filterCharactersByGroup(characters, characterGroups, memberGroupId).map(c => (
                                    <div key={c.id} onClick={() => toggleMemberSelection(c.id)} className={`flex flex-col items-center gap-1 p-2 rounded-xl border transition-all cursor-pointer ${selectedMembers.has(c.id) ? 'border-violet-500 bg-violet-50 ring-1 ring-violet-500' : 'border-slate-100 bg-white hover:border-slate-300'}`}>
                                        <TokenImg value={c.avatar} className="w-10 h-10 rounded-full object-cover" />
                                        <span className="text-[9px] text-slate-600 truncate w-full text-center font-medium">{c.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </Modal>
            </div>
        );
    }

    // CHAT VIEW
    // 动森彩蛋模式（与私聊同一开关联动）
    const acnh = osTheme.skin === 'animalcrossing' && osTheme.acnhChatSync !== false;
    const chatChromeStyle = osTheme.chatChromeStyle || 'soft';
    const chatBackgroundStyle = osTheme.chatBackgroundStyle || 'plain';
    const groupChatRootClass = chatChromeStyle === 'pixel'
        ? 'h-full w-full bg-[#efe1cf] flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500'
        : chatChromeStyle === 'flat'
            ? 'h-full w-full bg-white flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500'
            : chatChromeStyle === 'floating'
                ? 'h-full w-full bg-[#eef2ff] flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500'
                : 'h-full w-full bg-[#f1f5f9] flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500';
    const groupChatRootStyle: React.CSSProperties = chatBackgroundStyle === 'grid'
        ? {
            backgroundColor: chatChromeStyle === 'pixel' ? '#efe1cf' : '#f8fafc',
            backgroundImage: 'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
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
                    backgroundImage: 'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
                }
                : { backgroundImage: 'none' };
    const groupFineTuneCss = buildChatFineTuneCss(osTheme);
    const finalGroupRootClass = acnh
        ? 'h-full w-full flex flex-col overflow-hidden font-sans relative transition-[background-color] duration-500'
        : groupChatRootClass;
    const finalGroupRootStyle = acnh
        ? { backgroundColor: '#F6F0D8', backgroundImage: 'none' }
        : groupChatRootStyle;
    return (
        <div className={`sully-chat-root ${finalGroupRootClass}`} style={finalGroupRootStyle}>
            <ChatRuntimeStyle />
            {/* 外观 App 的全局聊天细节与私聊共用同一份生成 CSS。 */}
            {groupFineTuneCss && <style>{groupFineTuneCss}</style>}
            {/* 白框自定义 CSS：全局默认在前、群专属在后（后者叠加覆盖）。作用于 .sully-chat-* 各零件。 */}
            {osTheme.chatChromeCustomCss && <BlobRefStyle css={osTheme.chatChromeCustomCss}/>}
            {activeGroup?.chromeCustomCss && <BlobRefStyle css={activeGroup.chromeCustomCss}/>}
            {/* 气泡工坊 CSS 排在白框之后，与私聊优先级一致；每套成员主题都限定在自己的消息上。 */}
            {groupBubbleCustomCss && <style>{groupBubbleCustomCss}</style>}
            <style>{`
                .sully-bubble-tail-hidden::before,
                .sully-bubble-tail-hidden::after { content: none !important; display: none !important; }
            `}</style>
            {/* 守护样式（注在用户 CSS 之后）：保证返回键与输入区永远可见可点。 */}
            {(osTheme.chatChromeCustomCss || activeGroup?.chromeCustomCss || groupBubbleCustomCss) && (
                <style>{`
                    .sully-chat-back{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                    .sully-chat-inputbar{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                    .sully-chat-inputbar textarea,.sully-chat-inputbar button{pointer-events:auto!important;visibility:visible!important;}
                `}</style>
            )}
            {/* 公共话题盒整理状态 — 不阻塞交互 */}
            {groupPalaceStatus && (
                <div
                    className="absolute top-[100px] left-1/2 z-[150] animate-fade-in"
                    style={{
                        transform: 'translateX(-50%)',
                        pointerEvents: 'none',
                        willChange: 'transform, opacity',
                    }}
                >
                    <div
                        className="flex items-center gap-2.5 pl-2.5 pr-3.5 py-2 max-w-[20rem]"
                        style={{
                            background: 'rgba(255,255,255,0.88)',
                            borderRadius: 999,
                            border: '1px solid rgba(139,92,246,0.22)',
                            boxShadow: '0 6px 18px -6px rgba(15,23,42,0.22)',
                        }}
                    >
                        <span
                            className="shrink-0 inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-200 animate-spin"
                            style={{ borderTopColor: '#8b5cf6', animationDuration: '0.9s' }}
                        />
                        <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                            公共话题成盒中
                        </span>
                        <span className="text-[10px] text-slate-400 truncate">{groupPalaceStatus}</span>
                    </div>
                </div>
            )}

            {/* Header — 复用私聊 ChatHeaderShell（7 种头部风格随 OS 外观设置） */}
            <ChatHeaderShell
                selectionMode={selectionMode}
                selectedCount={selectedMsgIds.size}
                onCancelSelection={() => { setSelectionMode(false); setSelectedMsgIds(new Set()); }}
                activeCharacter={{
                    id: activeGroup?.id || 'group',
                    name: activeGroup?.name || '群聊',
                    avatar: activeGroup?.avatar || characters.find(c => c.id === activeGroup?.members[0])?.avatar || '',
                    activeBuffs: [],
                }}
                isTyping={isTyping}
                isSummarizing={isSummarizing}
                isMemoryPalaceProcessing={!!groupPalaceStatus}
                memoryPalaceStatusText={groupPalaceStatus}
                lastTokenUsage={lastTokenUsage}
                tokenBreakdown={tokenBreakdown}
                statusText={`${activeGroup?.members.length ?? 0} 成员`}
                extraAction={{
                    label: '群聊记忆规则',
                    icon: <Question className="w-5 h-5" weight="bold" />,
                    onClick: () => setModalType('help'),
                }}
                triggerIcon={isTyping ? 'stop' : 'lightning'}
                hideTrigger={inputPreferences.sendButtonGenerates && !isTyping}
                onClose={() => setView('list')}
                onTriggerAI={() => triggerGroupAI(messages)}
                onShowCharsPanel={openGroupSettings}
                hideBuffs
                headerStyle={osTheme.chatHeaderStyle}
                avatarShape={osTheme.chatAvatarShape}
                headerAlign={osTheme.chatHeaderAlign}
                headerDensity={osTheme.chatHeaderDensity}
                statusStyle={osTheme.chatStatusStyle}
                chromeStyle={osTheme.chatChromeStyle}
                acnh={acnh}
            />

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden pt-6 pb-6 no-scrollbar" ref={scrollRef} onClick={() => { if (inputPreferences.autoReply) setShowPanel('none'); }}>
                {collapsedCount > 0 && activeGroup && (
                    <div className="flex justify-center mb-6">
                        <button onClick={async () => {
                            const nextVisibleCount = visibleCount + MESSAGE_PAGE_SIZE;
                            setVisibleCount(nextVisibleCount);
                            const { messages: moreMsgs, totalCount } = await DB.getRecentGroupMessagesWithCount(activeGroup.id, nextVisibleCount);
                            setMessages(moreMsgs);
                            setTotalMsgCount(totalCount);
                        }} className="px-4 py-2 bg-white/50 backdrop-blur-sm rounded-full text-xs text-slate-500 shadow-sm border border-white hover:bg-white transition-colors">
                            加载历史消息 ({collapsedCount})
                        </button>
                    </div>
                )}
                {displayMessages.map((m, i) => {
                    const isUser = m.role === 'user';
                    const char = characters.find(c => c.id === m.charId);
                    const prevMessage = i > 0 ? displayMessages[i - 1] : null;
                    const nextMessage = i < displayMessages.length - 1 ? displayMessages[i + 1] : null;
                    const messageGroupGapMs = 30 * 60 * 1000;
                    const sameSpeaker = (other: Message | null) => !!other
                        && other.role === m.role
                        && other.charId === m.charId;
                    const isFirstInGroup = !sameSpeaker(prevMessage)
                        || Math.abs(m.timestamp - prevMessage!.timestamp) > messageGroupGapMs;
                    const isLastInGroup = !sameSpeaker(nextMessage)
                        || Math.abs(nextMessage!.timestamp - m.timestamp) > messageGroupGapMs;
                    const memberTheme = memberBubbleThemes.get(m.charId);

                    return (
                        <GroupMessageItem
                            key={m.id || i}
                            msg={m}
                            isUser={isUser}
                            char={char}
                            userAvatar={userProfile.avatar}
                            onImageClick={handleGroupImageClick}
                            selectionMode={selectionMode}
                            isSelected={selectedMsgIds.has(m.id)}
                            onToggleSelect={toggleMessageSelection}
                            onLongPress={handleMessageLongPress}
                            onReply={handleGroupReply}
                            nameOf={nameOf}
                            onPacketClick={openPacketDetail}
                            styleConfig={isUser ? userBubbleTheme.user : (memberTheme?.ai || PRESET_THEME_GROUP.ai)}
                            themeScopeClass={isUser ? 'sully-group-user-theme' : (memberThemeScopeClasses.get(m.charId) || 'sully-group-default-theme')}
                            isFirstInGroup={isFirstInGroup}
                            isLastInGroup={isLastInGroup}
                            avatarShape={osTheme.chatAvatarShape}
                            avatarSize={osTheme.chatAvatarSize}
                            avatarMode={osTheme.chatAvatarMode}
                            bubbleVariant={osTheme.chatBubbleStyle}
                            messageSpacing={osTheme.chatMessageSpacing}
                            showTimestamp={osTheme.chatShowTimestamp}
                        />
                    );
                })}
                {isTyping && (
                    <div className="flex items-center gap-2 pl-4 py-2 animate-pulse opacity-70">
                        <div className="flex -space-x-1">
                            <div className="w-6 h-6 rounded-full bg-slate-300 border-2 border-white"></div>
                            <div className="w-6 h-6 rounded-full bg-slate-200 border-2 border-white"></div>
                        </div>
                        <span className="text-xs text-slate-400 font-medium">{mcpStatus || '成员正在输入...'}</span>
                    </div>
                )}
            </div>

            {/* Redesigned Input Area (WeChat/iOS Style) */}
            {/* 回复预览条（对齐私聊 Chat.tsx 的样式与位置） */}
            {replyTarget && !selectionMode && (
                <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-t border-slate-200 text-xs text-slate-500 shrink-0 z-40">
                    {/* 引用的是图片 / 表情时这里显示占位符，跟落库的快照同一口径 */}
                    <div className="flex items-center gap-2 truncate"><span className="font-bold text-slate-700">正在回复:</span><span className="truncate max-w-[200px]">{buildReplySnapshotContent(replyTarget)}</span></div>
                    <button onClick={() => setReplyTarget(null)} className="p-1 text-slate-400 hover:text-slate-600">×</button>
                </div>
            )}

            {/* 输入区 — 复用私聊 ChatInputArea（输入/表情面板/多选删除随 OS 外观设置），
                actions 面板整体替换为群聊自己的 4 格 */}
            {previewImage && <ImageViewer value={previewImage} fallback={previewImage} onClose={() => setPreviewImage(null)} />}
            <ChatInputArea
                input={input}
                setInput={setInput}
                isTyping={isTyping}
                selectionMode={selectionMode}
                showPanel={showPanel}
                setShowPanel={setShowPanel}
                onSend={() => handleSendMessage(input)}
                onGenerate={() => { void triggerGroupAI(); }}
                sendButtonGenerates={inputPreferences.sendButtonGenerates}
                enterToSend={inputPreferences.enterToSend}
                autoReplyEnabled={inputPreferences.autoReply}
                autoReplySeconds={autoReply.seconds}
                onCancelAutoReply={autoReply.cancel}
                onInputFocusChange={setIsInputFocused}
                onDeleteSelected={deleteSelectedMessages}
                selectedCount={selectedMsgIds.size}
                emojis={filteredEmojis}
                emojiSuggestionsEnabled={inputPreferences.emojiSuggestions}
                suggestionEmojis={emojis}
                activeCharacterId={activeGroup?.id || ''}
                categories={categories}
                activeCategory={activeEmojiCategory}
                onPanelAction={handlePanelAction}
                onImageSelect={handleImageFile}
                isSummarizing={isSummarizing}
                onReroll={handleReroll}
                canReroll={canReroll}
                inputStyle={osTheme.chatInputStyle}
                sendButtonStyle={osTheme.chatSendButtonStyle}
                chromeStyle={osTheme.chatChromeStyle}
                acnh={acnh}
                actionsContent={
                    <div className="p-6 grid grid-cols-4 gap-8">
                        <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-pink-50 text-pink-400 border-pink-100">
                                <ImageIcon className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">相册</span>
                        </button>
                        <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleImageUpload} />

                        <button onClick={() => { setModalType('transfer'); setShowPanel('none'); trackEvent('打开发红包面板'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-orange-50 text-orange-400 border-orange-100">
                                <Money className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">红包</span>
                        </button>

                        <button onClick={openGroupSettings} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-violet-50 text-violet-500 border-violet-100">
                                <GearSix className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">群设置</span>
                        </button>

                        <button
                            onClick={() => { if (canReroll) { setShowPanel('none'); handleReroll(); } }}
                            disabled={!canReroll}
                            className={`flex flex-col items-center gap-2 active:scale-95 transition-transform ${canReroll ? 'text-slate-600' : 'text-slate-300 opacity-50'}`}
                        >
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border ${canReroll ? 'bg-emerald-50 text-emerald-400 border-emerald-100' : 'bg-slate-50 text-slate-300 border-slate-100'}`}>
                                <ArrowsClockwise className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">重新生成</span>
                        </button>

                        <button onClick={() => { setModalType('chrome-css'); setShowPanel('none'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-sky-50 text-sky-500 border-sky-100">
                                <PaintBrush className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">白框</span>
                        </button>

                        <button onClick={() => { setModalType('chrome-sound'); setShowPanel('none'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-amber-50 text-amber-500 border-amber-100">
                                <BellSimpleRinging className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">提示音</span>
                        </button>

                        {/* HTML 模式：tap 切换开关；右键/长按打开自定义提示词（交互对齐私聊） */}
                        <button
                            onClick={() => {
                                if (!activeGroup) return;
                                const next = !activeGroup.htmlModeEnabled;
                                updateGroup(activeGroup.id, { htmlModeEnabled: next });
                                setActiveGroup({ ...activeGroup, htmlModeEnabled: next });
                                addToast(next ? 'HTML 模式已开启' : 'HTML 模式已关闭', 'info');
                                trackEvent('开启群聊 HTML 模式', { state: next ? 'on' : 'off' });
                            }}
                            onContextMenu={(e) => { e.preventDefault(); setTempHtmlPrompt(activeGroup?.htmlModeCustomPrompt || ''); setModalType('html-prompt'); setShowPanel('none'); }}
                            className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600 relative"
                        >
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border relative ${activeGroup?.htmlModeEnabled ? 'bg-fuchsia-100 text-fuchsia-600 border-fuchsia-200' : 'bg-fuchsia-50 text-fuchsia-500 border-fuchsia-100'}`}>
                                <Code className="w-6 h-6" weight="bold" />
                                {activeGroup?.htmlModeEnabled && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-fuchsia-500 border-2 border-white" />}
                            </div>
                            <span className="text-xs font-bold">{activeGroup?.htmlModeEnabled ? 'HTML已开' : 'HTML模式'}</span>
                        </button>
                    </div>

                }
            />

            {/* --- Modals --- */}

            {/* Group Settings Modal */}
            <Modal isOpen={modalType === 'settings'} title="群组设置" onClose={() => setModalType('none')} footer={<button onClick={handleUpdateGroupInfo} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg shadow-violet-200">保存修改</button>}>
                <div className="space-y-6">
                    {/* Header Info */}
                    <div className="flex justify-center">
                        <div onClick={() => groupAvatarInputRef.current?.click()} className="w-24 h-24 rounded-3xl bg-slate-100 border-2 border-dashed border-slate-300 flex items-center justify-center cursor-pointer overflow-hidden relative group hover:border-violet-400">
                            {activeGroup?.avatar ? <TokenImg value={activeGroup.avatar} className="w-full h-full object-cover opacity-90 group-hover:opacity-100" /> : <span className="text-xs text-slate-400 font-bold">更换头像</span>}
                            <div className="absolute inset-0 bg-black/20 hidden group-hover:flex items-center justify-center text-white"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" /></svg></div>
                        </div>
                        <input type="file" ref={groupAvatarInputRef} className="hidden" accept="image/*" onChange={handleGroupAvatarUpload} />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">群名称</label>
                        <input value={tempGroupName} onChange={e => setTempGroupName(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:bg-white focus:border-violet-300 transition-all" />
                    </div>

                    <div className="pt-2 border-t border-slate-100">
                        <h3 className="mb-2 text-xs font-bold text-slate-600">输入与发送</h3>
                        <ChatInputSettings value={settingsInputPreferences} onChange={setSettingsInputPreferences} scope="group" />
                    </div>

                    {/* Reply Mode */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">回复生成模式</label>
                        <div className="flex flex-col gap-2">
                            <div
                                onClick={() => { setTempReplyMode('director'); trackEvent('切换群聊回复生成模式', { mode: 'director' }); }}
                                className={`p-3 rounded-xl border cursor-pointer transition-all ${tempReplyMode === 'director' ? 'border-violet-400 bg-violet-50 ring-1 ring-violet-400' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                            >
                                <div className="text-xs font-bold text-slate-700">导演模式（默认）</div>
                                <p className="text-[9px] text-slate-400 mt-1 leading-tight">一次 API 调用生成整轮群聊。快、省 token，但角色偶尔可能串号。</p>
                            </div>
                            <div
                                onClick={() => { setTempReplyMode('roundRobin'); trackEvent('切换群聊回复生成模式', { mode: 'roundRobin' }); }}
                                className={`p-3 rounded-xl border cursor-pointer transition-all ${tempReplyMode === 'roundRobin' ? 'border-violet-400 bg-violet-50 ring-1 ring-violet-400' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                            >
                                <div className="text-xs font-bold text-slate-700">轮询模式</div>
                                <p className="text-[9px] text-slate-400 mt-1 leading-tight">每位成员单独调用一次 API，按顺序逐个发言（每人必发言）。更真实、彻底防串号，但更慢，token 消耗约为导演模式 × 成员数。</p>
                            </div>
                        </div>
                    </div>

                    {/* Bubble Appearance */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">气泡外观</label>
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex-1 pr-3">
                                <div className="text-xs font-bold text-slate-700">成员独立气泡</div>
                                <p className="text-[9px] text-slate-400 mt-0.5 leading-tight">开启后每位成员完整沿用其私聊气泡主题（AI 侧，包含自定义 CSS 与装饰）；关闭则全员统一。</p>
                            </div>
                            <div
                                onClick={() => setTempMemberBubbleIndependent(v => !v)}
                                className={`w-11 h-6 rounded-full cursor-pointer transition-colors relative shrink-0 ${tempMemberBubbleIndependent ? 'bg-violet-500' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${tempMemberBubbleIndependent ? 'left-[22px]' : 'left-0.5'}`} />
                            </div>
                        </div>
                        <div className="text-xs font-bold text-slate-700 mb-2">我的气泡</div>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                            {[{ id: '', name: '默认·紫', color: PRESET_THEME_GROUP.user.backgroundColor },
                              ...Object.values(PRESET_THEMES).map(t => ({ id: t.id, name: t.name, color: t.user.backgroundColor })),
                              ...customThemes.map(t => ({ id: t.id, name: `${t.name} (DIY)`, color: t.user.backgroundColor }))].map(opt => (
                                <button
                                    key={opt.id || '_default'}
                                    onClick={() => setTempUserBubbleThemeId(opt.id)}
                                    className={`shrink-0 px-3 py-2 rounded-xl border text-[10px] font-bold flex items-center gap-1.5 transition-all ${tempUserBubbleThemeId === opt.id ? 'border-violet-500 bg-violet-50 ring-1 ring-violet-500 text-violet-700' : 'border-slate-200 bg-white text-slate-500'}`}
                                >
                                    <span className="w-3.5 h-3.5 rounded-full border border-black/10" style={{ backgroundColor: opt.color }} />
                                    {opt.name}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Context Limit */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">AI 上下文条数 ({contextLimit})</label>
                        <input type="range" min="20" max="5000" step="10" value={contextLimit} onChange={e => { const v = parseInt(e.target.value); setContextLimit(v); localStorage.setItem('groupchat_context_limit', String(v)); }} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>20 (省流)</span><span>5000 (超长记忆)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">角色每次发言时参考多少条群聊历史。越多越连贯，但越慢、越费 token。</p>
                    </div>

                    {/* Private Chat Group Context Cap */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">私聊里"近期群活动"取条数 ({tempPrivateContextCap})</label>
                        <input type="range" min="20" max="500" step="10" value={tempPrivateContextCap} onChange={e => setTempPrivateContextCap(parseInt(e.target.value))} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>20 (省流)</span><span>500 (完整)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">本群成员在自己的私聊里，最多看到本群最近多少条消息作为"近期群活动"上下文。</p>
                    </div>

                    {/* Member Timeline Cap */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">成员互动时间线条数 ({tempMemberTimelineCap})</label>
                        <input type="range" min="20" max="200" step="10" value={tempMemberTimelineCap} onChange={e => setTempMemberTimelineCap(parseInt(e.target.value))} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>20 (省流)</span><span>200 (完整)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">群里发言时，每位成员参考的"私聊+群聊合并时间线"条数。这条时间线让角色在群里的感情与私聊衔接。</p>
                    </div>

                    {/* 公共话题盒：一次总结，全群共享，并在成盒时送达所有成员私聊。 */}
                    <div className="pt-2 border-t border-slate-100 space-y-3">
                        <div className="flex items-center justify-between">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">群聊总结 · 公共话题盒</label>
                            <span className="text-[10px] text-violet-500 font-bold">{activeGroup?.topicBoxes?.length || 0} 个盒子</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1.5">
                            {([
                                { id: 'auto' as const, title: '自动整理', desc: '满100条自动成盒' },
                                { id: 'manual' as const, title: '手动整理', desc: '只在点击时成盒' },
                            ]).map(option => {
                                const active = (activeGroup?.topicArchiveMode || 'auto') === option.id;
                                return (
                                    <button key={option.id} onClick={async () => {
                                        if (!activeGroup) return;
                                        await updateGroup(activeGroup.id, { topicArchiveMode: option.id });
                                        setActiveGroup({ ...activeGroup, topicArchiveMode: option.id });
                                        trackEvent('切换群聊总结整理方式', { mode: option.id });
                                    }} className={`rounded-xl px-3 py-2.5 text-left transition-all ${active ? 'bg-white shadow-sm ring-1 ring-violet-100' : 'text-slate-400'}`}>
                                        <div className={`text-[11px] font-bold ${active ? 'text-violet-600' : 'text-slate-500'}`}>{option.title}</div>
                                        <div className="text-[9px] mt-0.5">{option.desc}</div>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50 to-indigo-50 p-3.5 space-y-2">
                            <p className="text-[11px] font-bold text-violet-700">一份总结，全群共同记住</p>
                            <p className="text-[10px] leading-5 text-violet-600/80">
                                最近 {GROUP_TOPIC_HOT_ZONE} 条始终保留原文；更早的记录累计 {GROUP_TOPIC_BUFFER_THRESHOLD} 条后{(activeGroup?.topicArchiveMode || 'auto') === 'auto' ? '自动整理' : '等待你手动整理'}成公共话题盒。
                                盒子只属于本群，同时会作为卡片送到每位成员私聊，之后可被各自的私聊上下文与归档正常理解。
                            </p>
                            <div className="flex items-center justify-between rounded-xl bg-white/70 px-3 py-2 text-[10px]">
                                <span className="text-slate-500">热区以前待整理</span>
                                <span className={`font-bold ${topicPendingCount >= GROUP_TOPIC_BUFFER_THRESHOLD ? 'text-amber-500' : 'text-slate-500'}`}>{topicPendingCount} / {GROUP_TOPIC_BUFFER_THRESHOLD} 条</span>
                            </div>
                        </div>

                        <div className="bg-white border border-slate-100 rounded-2xl p-3 flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-violet-50 flex items-center justify-center">✦</div>
                            <div>
                                <div className="text-[10px] font-bold text-slate-600">内置 · 群聊共同记忆总结</div>
                                <p className="text-[9px] text-slate-400 mt-0.5 leading-4">总结机会读取全体成员的简介、核心设定、世界观、写作人格与核心记忆，不再复用私聊归档风格。</p>
                            </div>
                        </div>

                        <button onClick={() => { void createNextGroupTopicBox(true); trackEvent('手动整理群话题盒'); }} disabled={isSummarizing || topicPendingCount === 0} className={`w-full py-3 rounded-2xl border font-bold text-xs flex items-center justify-center gap-2 ${topicPendingCount === 0 ? 'bg-slate-50 border-slate-100 text-slate-300' : 'bg-violet-500 border-violet-500 text-white shadow-lg shadow-violet-200'}`}>
                            {isSummarizing ? <><span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />{summaryProgress || '正在成盒…'}</> : '立即整理当前可归档内容'}
                        </button>

                        <div className="space-y-2">
                            {(activeGroup?.topicBoxes || []).slice().reverse().map(box => {
                                const editing = editingTopicBoxId === box.id;
                                return (
                                    <div key={box.id} className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
                                        {editing ? (
                                            <div className="space-y-2">
                                                <input value={topicTitleDraft} onChange={e => setTopicTitleDraft(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-bold" placeholder="话题盒标题" />
                                                <textarea value={topicSummaryDraft} onChange={e => setTopicSummaryDraft(e.target.value)} className="w-full min-h-28 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs leading-5 resize-y" placeholder="共同回忆总结" />
                                                <div className="flex gap-2">
                                                    <button onClick={() => setEditingTopicBoxId(null)} className="flex-1 py-2 rounded-xl bg-slate-100 text-slate-500 text-[11px] font-bold">取消</button>
                                                    <button onClick={() => void saveTopicBoxEdit(box.id)} className="flex-1 py-2 rounded-xl bg-violet-500 text-white text-[11px] font-bold">保存并同步卡片</button>
                                                </div>
                                            </div>
                                        ) : (
                                            <>
                                                <div className="flex items-start gap-2">
                                                    <div className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">💬</div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-xs font-bold text-slate-700">{box.title}</div>
                                                        <div className="text-[9px] text-slate-400 mt-0.5">归档 {box.messageCount} 条 · {new Date(box.createdAt).toLocaleDateString('zh-CN')}</div>
                                                    </div>
                                                </div>
                                                <p className="mt-2.5 text-[11px] leading-5 text-slate-600 whitespace-pre-wrap">{box.summary}</p>
                                                <div className="mt-3 flex gap-2 justify-end">
                                                    <button onClick={() => { setEditingTopicBoxId(box.id); setTopicTitleDraft(box.title); setTopicSummaryDraft(box.summary); }} className="px-3 py-1.5 rounded-lg bg-violet-50 text-violet-600 text-[10px] font-bold">修改</button>
                                                    <button onClick={() => void deleteTopicBox(box.id)} className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-500 text-[10px] font-bold">删除</button>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                            {(activeGroup?.topicBoxes?.length || 0) === 0 && (
                                <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-5 text-center text-[10px] text-slate-400">聊天还在近期热区里。内容足够多后，会自动出现第一只公共话题盒。</div>
                            )}
                        </div>
                    </div>

                    {/* Danger Zone */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-3 block">危险区域</label>
                        
                        <div className="flex items-center gap-2 mb-3 cursor-pointer" onClick={() => setPreserveContext(!preserveContext)}>
                             <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${preserveContext ? 'bg-violet-500 border-violet-500' : 'bg-slate-100 border-slate-300'}`}>
                                 {preserveContext && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                             </div>
                             <span className="text-xs text-slate-600">清空时保留最后10条记录 (维持语境)</span>
                        </div>

                        <div className="flex gap-2">
                            <button onClick={handleClearHistory} className="flex-1 py-3 bg-red-50 text-red-500 font-bold rounded-2xl border border-red-100 active:scale-95 transition-transform flex items-center justify-center gap-2 text-xs">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                                清空聊天
                            </button>
                            <button onClick={() => { if(activeGroup) handleDeleteGroup(activeGroup.id); }} className="flex-1 py-3 text-white bg-red-500 hover:bg-red-600 rounded-2xl text-xs font-bold transition-colors shadow-lg shadow-red-200">解散群聊</button>
                        </div>
                    </div>
                </div>
            </Modal>

            {/* Message Options Modal */}
            <Modal isOpen={modalType === 'message-options'} title="消息操作" onClose={() => { setModalType('none'); setSelectedMessage(null); }}>
                <div className="space-y-3">
                    <button
                        onClick={() => {
                            if (selectedMessage) setReplyTarget(selectedMessage);
                            setModalType('none');
                            setSelectedMessage(null);
                        }}
                        className="w-full py-3 bg-violet-50 text-violet-600 font-medium rounded-2xl active:bg-violet-100 transition-colors flex items-center justify-center gap-2"
                    >
                        引用 / 回复
                    </button>
                    <button onClick={handleEnterSelectionMode} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                        多选 / 批量删除
                    </button>
                    {selectedMessage?.type === 'text' && (
                        <button onClick={handleCopyMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            复制文字
                        </button>
                    )}
                    {selectedMessage?.type === 'text' && (
                        <button onClick={handleStartEditMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            修改内容
                        </button>
                    )}
                    <button onClick={handleDeleteSingleMessage} className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl active:bg-red-100 transition-colors flex items-center justify-center gap-2">
                        删除消息
                    </button>
                </div>
            </Modal>

            {/* Edit Message Modal */}
            <Modal
                isOpen={modalType === 'edit-message'} title="编辑内容" onClose={() => { setModalType('none'); setSelectedMessage(null); }}
                footer={<><button onClick={() => { setModalType('none'); setSelectedMessage(null); }} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button onClick={confirmEditMessage} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">保存</button></>}
            >
                <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full h-32 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-primary/20 transition-all text-sm leading-relaxed"
                />
            </Modal>

            {/* Transfer Modal — 红包 2.0：拼手气 / 专属 */}
            <Modal isOpen={modalType === 'transfer'} title="发送红包" onClose={() => setModalType('none')} footer={<button onClick={handleSendPacket} className="w-full py-3 bg-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-orange-200">塞进红包</button>}>
                <div className="space-y-4">
                    {/* Tab 切换 */}
                    <div className="flex gap-2">
                        {([['lucky', '拼手气'], ['direct', '专属']] as const).map(([key, label]) => (
                            <button
                                key={key}
                                onClick={() => setPacketTab(key)}
                                className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all ${packetTab === key ? 'bg-orange-500 text-white shadow-md' : 'bg-slate-100 text-slate-500'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="text-center py-2 animate-bounce"><img src={twemojiUrl('1f9e7')} alt="red envelope" className="w-12 h-12 mx-auto" /></div>

                    <input type="number" value={transferAmount} onChange={e => setTransferAmount(e.target.value)} placeholder={packetTab === 'lucky' ? '总金额' : '金额'} className="w-full px-4 py-4 bg-slate-100 rounded-2xl text-center text-2xl font-bold outline-none text-slate-800 placeholder:text-slate-300" autoFocus />

                    {packetTab === 'lucky' ? (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">份数（大家抢，随机金额）</label>
                            <input type="number" value={packetShares} onChange={e => setPacketShares(e.target.value)} min={1} className="w-full px-4 py-3 bg-slate-100 rounded-2xl text-center text-lg font-bold outline-none text-slate-800" />
                        </div>
                    ) : (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">发给谁（只有 ta 能收）</label>
                            <div className="grid grid-cols-4 gap-2 max-h-36 overflow-y-auto pr-1">
                                {(activeGroup?.members || []).map(mid => {
                                    const c = characters.find(ch => ch.id === mid);
                                    if (!c) return null;
                                    return (
                                        <div key={mid} onClick={() => setPacketTargetId(mid)} className={`flex flex-col items-center gap-1 p-2 rounded-xl border transition-all cursor-pointer ${packetTargetId === mid ? 'border-orange-500 bg-orange-50 ring-1 ring-orange-500' : 'border-slate-100 bg-white hover:border-slate-300'}`}>
                                            <TokenImg value={c.avatar} className="w-10 h-10 rounded-full object-cover" />
                                            <span className="text-[9px] text-slate-600 truncate w-full text-center font-medium">{c.name}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <input value={packetNote} onChange={e => setPacketNote(e.target.value)} placeholder="恭喜发财（祝福语，可不填）" className="w-full px-4 py-3 bg-slate-100 rounded-2xl text-sm outline-none text-slate-700 placeholder:text-slate-300" />
                </div>
            </Modal>

            {/* Packet Detail Modal — 领取明细 + 用户抢/收/退 */}
            <Modal isOpen={modalType === 'packet-detail'} title="红包详情" onClose={() => { setModalType('none'); setSelectedPacketId(null); }}>
                {(() => {
                    const pMsg = messages.find(m => m.id === selectedPacketId);
                    const meta = pMsg?.metadata as GroupPacketMeta | undefined;
                    if (!pMsg || !meta?.packet) return <div className="text-center text-xs text-slate-400 py-6">这个红包的数据不见了</div>;
                    const status = effectivePacketStatus(meta, Date.now());
                    const senderName = pMsg.role === 'user' ? userProfile.name : nameOf(pMsg.charId);
                    const userClaimed = meta.claims.some(c => c.claimantId === 'user');
                    const canGrabLucky = meta.packetType === 'lucky' && status === 'pending' && !userClaimed;
                    const canResolveDirect = meta.packetType === 'direct' && status === 'pending' && meta.targetId === 'user';
                    return (
                        <div className="space-y-4">
                            <div className="text-center">
                                <div className="text-4xl mb-1">🧧</div>
                                <div className="font-bold text-slate-800">{senderName} 的{meta.packetType === 'lucky' ? '拼手气' : '专属'}红包</div>
                                <div className="text-xs text-slate-400 mt-1">「{meta.note}」</div>
                                <div className="text-2xl font-black text-orange-500 mt-2">¥{meta.totalAmount}</div>
                                {meta.packetType === 'lucky' && (
                                    <div className="text-[10px] text-slate-400 mt-1">共 {meta.shares} 份 · 已领 {meta.claims.length} 份{status === 'expired' ? ' · 已过期' : ''}</div>
                                )}
                                {meta.packetType === 'direct' && (
                                    <div className="text-[10px] text-slate-400 mt-1">发给 {nameOf(meta.targetId || '')} · {status === 'pending' ? '待领取' : status === 'done' ? '已收下' : status === 'returned' ? '已退回' : '已过期'}</div>
                                )}
                            </div>

                            {meta.claims.length > 0 && (
                                <div className="space-y-2 max-h-44 overflow-y-auto">
                                    {meta.claims.map((c, i) => {
                                        const avatar = c.claimantId === 'user' ? userProfile.avatar : characters.find(ch => ch.id === c.claimantId)?.avatar;
                                        return (
                                            <div key={i} className="flex items-center gap-3 bg-slate-50 rounded-xl px-3 py-2">
                                                <TokenImg value={avatar} className="w-8 h-8 rounded-full object-cover" />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-xs font-bold text-slate-700 truncate">{nameOf(c.claimantId)}</div>
                                                    <div className="text-[9px] text-slate-400">{new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                                                </div>
                                                <div className="text-sm font-black text-orange-500">¥{c.amount}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {canGrabLucky && (
                                <button onClick={() => handleUserPacketAction(pMsg, 'claim')} className="w-full py-3 bg-gradient-to-r from-orange-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-orange-200 active:scale-95 transition-transform">
                                    抢红包
                                </button>
                            )}
                            {canResolveDirect && (
                                <div className="flex gap-2">
                                    <button onClick={() => handleUserPacketAction(pMsg, 'claim')} className="flex-1 py-3 bg-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-orange-200 active:scale-95 transition-transform">收下</button>
                                    <button onClick={() => handleUserPacketAction(pMsg, 'return')} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform">退回</button>
                                </div>
                            )}
                        </div>
                    );
                })()}
            </Modal>

            {/* 群「白框自定义」底部 sheet —— 写到 group.chromeCustomCss，叠加在全局之上（对齐私聊做法） */}
            {activeGroup && modalType === 'chrome-css' && (
                <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                    <div
                        className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="mb-2 flex items-start justify-between">
                            <div>
                                <div className="text-sm font-bold text-slate-800">白框自定义 · {activeGroup.name}</div>
                                <div className="mt-0.5 text-[10px] text-slate-400">↑ 上方群聊界面即实时预览；仅对本群生效，叠加在全局设置之上。</div>
                            </div>
                            <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                        </div>
                        <ChromeCssEditor
                            value={activeGroup.chromeCustomCss || ''}
                            onChange={(css) => { updateGroup(activeGroup.id, { chromeCustomCss: css }); setActiveGroup({ ...activeGroup, chromeCustomCss: css }); }}
                        />
                    </div>
                    {/* 脱离 CSS 控制的救援键：portal 到 body + id 守护，坏 CSS 也点得到（逐字复用私聊方案） */}
                    {createPortal(
                        <>
                            <style>{`#sully-safe-reset{position:fixed!important;top:calc(var(--safe-top) + 6px)!important;left:50%!important;transform:translateX(-50%)!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;display:flex!important;z-index:2147483647!important;}`}</style>
                            <button
                                id="sully-safe-reset"
                                onClick={() => { updateGroup(activeGroup.id, { chromeCustomCss: '' }); setActiveGroup({ ...activeGroup, chromeCustomCss: '' }); addToast('已还原本群白框', 'success'); }}
                                style={{
                                    position: 'fixed', top: 'calc(var(--safe-top) + 6px)', left: '50%', transform: 'translateX(-50%)',
                                    zIndex: 2147483647, display: 'flex', alignItems: 'center', gap: '4px',
                                    padding: '5px 12px', borderRadius: '999px',
                                    background: 'rgba(15,23,42,0.62)', color: '#fff', fontSize: '11px', fontWeight: 700,
                                    border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                                }}
                            >⟲ 还原本群白框</button>
                        </>,
                        document.body,
                    )}
                </div>
            )}

            {/* 群「提示音」底部 sheet —— 默认独立存 group.chatSound；绑定后写进 chromeCustomCss 的 @sully-sound 指令 */}
            {activeGroup && modalType === 'chrome-sound' && (() => {
                const boundSound = parseWhiteboxSound(activeGroup.chromeCustomCss);
                const isBound = !!activeGroup.chatSoundBound || !!boundSound;
                const curSound: WhiteboxSound | null = isBound ? boundSound : (activeGroup.chatSound || null);
                const applyGroup = (patch: Partial<GroupProfile>) => { updateGroup(activeGroup.id, patch); setActiveGroup({ ...activeGroup, ...patch }); };
                const changeSound = (s: WhiteboxSound | null) => {
                    if (isBound) {
                        applyGroup({ chromeCustomCss: upsertWhiteboxSound(activeGroup.chromeCustomCss || '', s), chatSound: undefined });
                    } else {
                        applyGroup({ chatSound: s || undefined });
                    }
                };
                const changeBound = (b: boolean) => {
                    if (b) {
                        applyGroup({ chromeCustomCss: upsertWhiteboxSound(activeGroup.chromeCustomCss || '', curSound), chatSound: undefined, chatSoundBound: true });
                    } else {
                        applyGroup({ chromeCustomCss: stripWhiteboxSoundDirective(activeGroup.chromeCustomCss || ''), chatSound: curSound || undefined, chatSoundBound: false });
                    }
                };
                return (
                    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                        <div
                            className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                            style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="mb-3 flex items-start justify-between">
                                <div>
                                    <div className="text-sm font-bold text-slate-800">提示音 · {activeGroup.name}</div>
                                    <div className="mt-0.5 text-[10px] text-slate-400">成员新发的消息成为最新一条时响一次。默认独立于白框，可选绑定一起分享。</div>
                                </div>
                                <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                            </div>
                            <WhiteboxSoundEditor
                                sound={curSound}
                                bound={isBound}
                                onChangeSound={changeSound}
                                onChangeBound={changeBound}
                                hint={<>🔔 只在 <b>成员新发的消息成为最新一条</b> 时响一次。这里是<b>本群专属</b>；不设则用「外观 → 聊天界面」里的全局默认提示音。</>}
                            />
                        </div>
                    </div>
                );
            })()}

            {/* 群聊记忆规则 */}
            <Modal isOpen={modalType === 'help'} title="群聊记忆规则" onClose={() => setModalType('none')}>
                <div className="space-y-4 text-sm text-slate-600 leading-relaxed">
                    <div className="rounded-2xl bg-violet-50 border border-violet-100 p-4 text-violet-800">
                        群聊内容不是排队延迟发送。角色在私聊中“隔天提起”，通常是最近群聊、话题盒或个人群聊记忆被当作本轮话题选中了。
                    </div>
                    <div>
                        <div className="font-bold text-slate-800 mb-1">最近群聊</div>
                        <p>角色生成私聊回复时，会看到自己参与群聊中的最近一段消息。记录同时带具体日期和“约 N 天前”，避免把旧消息误认成刚刚发生。</p>
                    </div>
                    <div>
                        <div className="font-bold text-slate-800 mb-1">公共话题盒</div>
                        <p>群聊积累到一定数量后，较旧内容会被压缩成群成员共享的话题盒，并进入各成员的私聊背景。因此旧话题可能在之后再次被提起。</p>
                    </div>
                    <div>
                        <div className="font-bold text-slate-800 mb-1">个人群聊记忆</div>
                        <p>启用群聊记忆宫殿后，较旧群聊会以第三人称分别整理进参与角色的记忆宫殿。它不会要求角色立刻回复，只提供后续回忆依据。</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4 text-xs text-slate-500">
                        模型看到一段记录，不代表必须马上回应；是否主动提起仍会受当前话题和角色性格影响。
                    </div>
                </div>
            </Modal>

            {/* HTML 模式自定义提示词 Modal（瓦片右键/长按进入） */}
            <Modal
                isOpen={modalType === 'html-prompt'} title="HTML 模式 · 自定义提示词" onClose={() => setModalType('none')}
                footer={<button onClick={() => { if (activeGroup) { updateGroup(activeGroup.id, { htmlModeCustomPrompt: tempHtmlPrompt }); setActiveGroup({ ...activeGroup, htmlModeCustomPrompt: tempHtmlPrompt }); } setModalType('none'); addToast('已保存', 'success'); }} className="w-full py-3 bg-fuchsia-500 text-white font-bold rounded-2xl shadow-lg shadow-fuchsia-200">保存</button>}
            >
                <div className="space-y-3">
                    <p className="text-[10px] text-slate-400 leading-relaxed">追加在内置 HTML 提示词之后（不覆盖）。可以写卡片风格偏好、常用配色、想要的卡片类型等。</p>
                    <textarea
                        value={tempHtmlPrompt}
                        onChange={e => setTempHtmlPrompt(e.target.value)}
                        placeholder="例如：卡片统一用暖色系、圆角 16px；多用进度条和标签组……"
                        className="w-full h-36 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-fuchsia-300 transition-all text-sm leading-relaxed"
                    />
                </div>
            </Modal>

        </div>
    );
};

export default GroupChat;
import { useAppShortcut } from '../utils/appShortcutLaunch';
import { AppID as ShortcutAppID } from '../types';

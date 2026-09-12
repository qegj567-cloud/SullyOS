import ChatHistoryCleanupModal from '../components/chat/ChatHistoryCleanupModal';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import { loadRangeMessagePage, formatRangeTimestamp } from '../utils/memoryPalace/rangeMessagePage';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import {
    MemoryRoom, MemoryNode, ROOM_CONFIGS, ROOM_LABELS, getRoomLabel,
    MemoryNodeDB, AnticipationDB, MemoryLinkDB, EventBoxDB,
    migrateOldMemories, runCognitiveDigestion, getAvailableMonths, getAvailableChunks,
    detectPersonalityStyle,
    manuallyBindMemories, removeMemoryFromBox, unbindAllLiveMemories,
    reviveArchivedMemory,
    wipeAllMemoryPalace,
    exportMemoryPalace, importMemoryPalace, isMemoryPalaceExportFile,
    DigestReportDB, PLATE_TITLES,
    bootstrapPlatesFromHistory, markPlateBootstrapDone,
    getBootstrapResume, setBootstrapResume, clearBootstrapResume,
    updateStoredMemoryNode,
    regenerateEventBoxSummary,
    DEFAULT_CHARACTER_ACCOMMODATION,
} from '../utils/memoryPalace';
import type { Anticipation, MigrationProgress, DigestResult, MemoryLink, EventBox, DigestReport } from '../utils/memoryPalace';
import { confirmExportSafety } from '../utils/exportGuard';
import type { CharacterAccommodationPolicy, CharacterProfile, MemoryPalaceWaterlinePreset, Message } from '../types';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import TokenImg from '../components/os/TokenImg';
import {
    CONTEXT_RANGE_POLICY_VERSION,
    DEFAULT_MANUAL_CONTEXT_LIMIT,
} from '../utils/chatContextRange';
import {
    getRangeEndpointLabel,
    getRangeSelectionHint,
} from '../utils/memoryPalace/rangeSelection';
import { trackEvent } from '../utils/analytics';
import { shareOrDownloadFile } from '../utils/shareExport';
import {
    EXTERNAL_MEMORY_MAX_CHARS,
    getExternalMemoryLengthInfo,
    getExternalMemoryOverLimitMessage,
} from '../utils/memoryPalace/externalMemory';
import {
    MAX_MEMORY_BUFFER_THRESHOLD,
    MAX_MEMORY_HOT_ZONE_SIZE,
    MEMORY_PALACE_WATERLINE_PRESETS,
    MIN_MEMORY_BUFFER_THRESHOLD,
    MIN_MEMORY_HOT_ZONE_SIZE,
    makeCustomMemoryPalaceWaterline,
    resolveMemoryPalaceWaterline,
} from '../utils/memoryPalace/waterline';

/** 手动总结面板：每页渲染多少条聊天记录（翻页，避免一次性塞几百条 DOM 卡顿） */
const RANGE_PAGE_SIZE = 50;

/** 手动总结面板：把毫秒时间戳格式化成「2026-03-20 14:30」 */
const fmtRangeTs = formatRangeTimestamp;

/** UI 内部类型：统一描述"关联"来源（EventBox 兄弟 or 旧 MemoryLink） */
type LinkedMemoryUI = {
    /** 伪 link ID，用于 React key */
    id: string;
    /** 关系类型：box 兄弟（live / summary / archived）或 legacy causal link */
    relation: 'box_live' | 'box_summary' | 'box_archived' | 'legacy_causal';
    /** 所属 EventBox（box 关系时非 null） */
    box?: EventBox | null;
    node: MemoryNode;
};

// ─── 房间图标映射 ─────────────────────────────────────

/**
 * 顶部安全区 padding：用项目统一的 --safe-top（含刘海/灵动岛高度与 standalone PWA 回退），
 * 再加 16px 呼吸间距，并保证至少 40px，避免状态栏遮挡按钮。
 * 各视图的最外层滚动容器（自带背景）直接套这个 paddingTop，让背景顺着填到刘海下方。
 */
const SAFE_PAD_TOP: React.CSSProperties['paddingTop'] = 'max(40px, calc(var(--safe-top) + 16px))';

/** 房间图标：用纯线条 SVG 代替 emoji，用 currentColor 跟随房间主题色 */
const RoomIcon: React.FC<{ room: MemoryRoom; size?: number; style?: React.CSSProperties }> = ({ room, size = 20, style }) => {
    const commonProps = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
        style: { display: 'inline-block', verticalAlign: 'middle', ...style },
    };
    switch (room) {
        case 'living_room': // 沙发
            return (
                <svg {...commonProps}>
                    <path d="M3 14v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4" />
                    <path d="M4 14V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6" />
                    <path d="M2 14h20" />
                    <path d="M7 14V10h10v4" />
                </svg>
            );
        case 'bedroom': // 床
            return (
                <svg {...commonProps}>
                    <path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6" />
                    <path d="M3 18h18" />
                    <path d="M3 21v-3M21 21v-3" />
                    <path d="M8 10V7a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3" />
                </svg>
            );
        case 'study': // 书本
            return (
                <svg {...commonProps}>
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
                    <path d="M9 7h7M9 11h5" />
                </svg>
            );
        case 'user_room': // 用户
            return (
                <svg {...commonProps}>
                    <circle cx="12" cy="8" r="4" />
                    <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
                </svg>
            );
        case 'self_room': // 镜子/自我
            return (
                <svg {...commonProps}>
                    <ellipse cx="12" cy="10" rx="6" ry="8" />
                    <path d="M12 18v4M8 22h8" />
                    <path d="M9 8a3 3 0 0 1 3-3" />
                </svg>
            );
        case 'attic': // 大脑
            return (
                <svg {...commonProps}>
                    <path d="M9.5 3A3.5 3.5 0 0 0 6 6.5v0A3.5 3.5 0 0 0 4 12a3.5 3.5 0 0 0 2 5.5 3.5 3.5 0 0 0 3.5 3.5h0a2.5 2.5 0 0 0 2.5-2.5V5.5A2.5 2.5 0 0 0 9.5 3Z" />
                    <path d="M14.5 3A3.5 3.5 0 0 1 18 6.5v0A3.5 3.5 0 0 1 20 12a3.5 3.5 0 0 1-2 5.5 3.5 3.5 0 0 1-3.5 3.5h0a2.5 2.5 0 0 1-2.5-2.5V5.5A2.5 2.5 0 0 1 14.5 3Z" />
                </svg>
            );
        case 'windowsill': // 日出
            return (
                <svg {...commonProps}>
                    <path d="M12 3v2M4.6 7.6l1.4 1.4M18 9l1.4-1.4M2 14h2M20 14h2" />
                    <path d="M6 14a6 6 0 0 1 12 0" />
                    <path d="M2 19h20" />
                    <path d="M8 22h8" />
                </svg>
            );
        default:
            return null;
    }
};

/** 通用 UI 图标，避免再用 emoji 当图标 */
const Icon: React.FC<{ name: string; size?: number; style?: React.CSSProperties }> = ({ name, size = 16, style }) => {
    const p = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
        style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style },
    };
    switch (name) {
        case 'palace': // 记忆宫殿总图标：大脑 + 圆顶
            return (
                <svg {...p}>
                    <path d="M12 3a7 7 0 0 0-7 7v8h14v-8a7 7 0 0 0-7-7Z" />
                    <path d="M9 18v3M15 18v3M5 18h14" />
                    <path d="M12 9v6M9 12h6" />
                </svg>
            );
        case 'search':
            return (
                <svg {...p}>
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                </svg>
            );
        case 'settings':
            return (
                <svg {...p}>
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                </svg>
            );
        case 'list':
            return (
                <svg {...p}>
                    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                </svg>
            );
        case 'box':
            return (
                <svg {...p}>
                    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                    <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
                </svg>
            );
        case 'link':
            return (
                <svg {...p}>
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
            );
        case 'sparkle':
            return (
                <svg {...p}>
                    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
                    <path d="M5.6 5.6 8 8M16 16l2.4 2.4M5.6 18.4 8 16M16 8l2.4-2.4" />
                </svg>
            );
        case 'pin':
            return (
                <svg {...p}>
                    <path d="M12 2v6" />
                    <path d="M6 8h12l-2 6H8Z" />
                    <path d="M12 14v8" />
                </svg>
            );
        case 'trash':
            return (
                <svg {...p}>
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M10 11v6M14 11v6" />
                </svg>
            );
        case 'refresh':
            return (
                <svg {...p}>
                    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                    <path d="M21 4v5h-5" />
                </svg>
            );
        case 'beaker':
            return (
                <svg {...p}>
                    <path d="M9 3h6M10 3v7L5 20a1 1 0 0 0 .9 1.4h12.2A1 1 0 0 0 19 20l-5-10V3" />
                    <path d="M7 14h10" />
                </svg>
            );
        case 'cloud':
            return (
                <svg {...p}>
                    <path d="M18 10h-1.3A6 6 0 0 0 6.3 8.5 4.5 4.5 0 0 0 6 17.5h12a3.75 3.75 0 0 0 0-7.5Z" />
                </svg>
            );
        case 'target':
            return (
                <svg {...p}>
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="12" cy="12" r="5" />
                    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                </svg>
            );
        case 'robot':
            return (
                <svg {...p}>
                    <rect x="4" y="7" width="16" height="12" rx="2" />
                    <path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" />
                </svg>
            );
        case 'warning':
            return (
                <svg {...p}>
                    <path d="M10.3 3.86 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
                    <path d="M12 9v4M12 17h.01" />
                </svg>
            );
        case 'check':
            return (
                <svg {...p}>
                    <path d="M20 6 9 17l-5-5" />
                </svg>
            );
        case 'x':
            return (
                <svg {...p}>
                    <path d="M18 6 6 18M6 6l12 12" />
                </svg>
            );
        case 'pencil':
            return (
                <svg {...p}>
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
            );
        case 'book':
            return (
                <svg {...p}>
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2Z" />
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z" />
                </svg>
            );
        case 'sunrise':
            return (
                <svg {...p}>
                    <path d="M12 3v2M4.6 7.6l1.4 1.4M18 9l1.4-1.4M2 14h2M20 14h2" />
                    <path d="M6 14a6 6 0 0 1 12 0" />
                    <path d="M2 19h20" />
                </svg>
            );
        case 'lock':
            return (
                <svg {...p}>
                    <rect x="4" y="11" width="16" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
            );
        case 'broken-heart':
            return (
                <svg {...p}>
                    <path d="M12 21s-8-4.5-8-11a5 5 0 0 1 8-4 5 5 0 0 1 8 4c0 6.5-8 11-8 11Z" />
                    <path d="m10 8 3 3-2 2 3 3" />
                </svg>
            );
        case 'moon':
            return (
                <svg {...p}>
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
                </svg>
            );
        case 'bomb':
            return (
                <svg {...p}>
                    <circle cx="11" cy="15" r="7" />
                    <path d="M15 9l3-3 2 2-3 3M18 6v-2h2" />
                </svg>
            );
        case 'bolt':
            return (
                <svg {...p}>
                    <path d="M13 2 3 14h9l-1 8 10-12h-9Z" />
                </svg>
            );
        case 'arrow-left':
            return (
                <svg {...p}>
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
            );
        case 'document':
            return (
                <svg {...p}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                    <path d="M14 2v6h6M8 13h8M8 17h5" />
                </svg>
            );
        case 'download':
            return (
                <svg {...p}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <path d="m7 10 5 5 5-5M12 15V3" />
                </svg>
            );
        case 'money':
            return (
                <svg {...p}>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M14.5 9h-3.5a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9M12 7v10" />
                </svg>
            );
        case 'mask':
            return (
                <svg {...p}>
                    <path d="M4 8c0-2 2-3 4-3s3 1 4 1 2-1 4-1 4 1 4 3c0 4-2 10-8 10S4 12 4 8Z" />
                    <path d="M9 11h.01M15 11h.01M10 15c.5.5 1.2.8 2 .8s1.5-.3 2-.8" />
                </svg>
            );
        case 'crystal':
            return (
                <svg {...p}>
                    <path d="M12 3 6 10l6 11 6-11-6-7Z" />
                    <path d="M6 10h12M12 3v18" />
                </svg>
            );
        case 'sync':
            return (
                <svg {...p}>
                    <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                    <path d="M21 4v5h-5" />
                    <path d="M12 7v5l3 2" />
                </svg>
            );
        case 'square-check':
            return (
                <svg {...p}>
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <path d="m8 12 3 3 5-6" />
                </svg>
            );
        case 'square':
            return (
                <svg {...p}>
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                </svg>
            );
        case 'celebrate':
            return (
                <svg {...p}>
                    <path d="m5 19 3-9 9 9H5Z" />
                    <path d="M12 3v3M18 6l-2 2M18 11h3" />
                </svg>
            );
        case 'hourglass':
            return (
                <svg {...p}>
                    <path d="M6 3h12M6 21h12" />
                    <path d="M6 3v5l6 4 6-4V3M6 21v-5l6-4 6 4v5" />
                </svg>
            );
        default:
            return null;
    }
};

/** 解析带状态前缀（[ok]/[warn]/[err]）的结果字符串 */
const parseStatusPrefix = (msg: string | null | undefined): { status: 'ok' | 'warn' | 'err' | 'plain'; text: string } => {
    if (!msg) return { status: 'plain', text: '' };
    if (msg.startsWith('[ok]')) return { status: 'ok', text: msg.slice(4) };
    if (msg.startsWith('[warn]')) return { status: 'warn', text: msg.slice(6) };
    if (msg.startsWith('[err]')) return { status: 'err', text: msg.slice(5) };
    return { status: 'plain', text: msg };
};

/** 渲染带状态图标的结果消息 */
const StatusMessage: React.FC<{ msg: string | null | undefined; style?: React.CSSProperties }> = ({ msg, style }) => {
    const { status, text } = parseStatusPrefix(msg);
    if (!text) return null;
    const iconName = status === 'ok' ? 'check' : status === 'warn' ? 'warning' : status === 'err' ? 'x' : null;
    const iconColor = status === 'ok' ? '#16a34a' : status === 'warn' ? '#d97706' : status === 'err' ? '#dc2626' : '#6b7280';
    return (
        <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6, ...style }}>
            {iconName && <span style={{ color: iconColor, flexShrink: 0, marginTop: 2 }}><Icon name={iconName} size={12} /></span>}
            <span>{text}</span>
        </span>
    );
};

const ROOM_COLORS: Record<MemoryRoom, string> = {
    living_room: '#22c55e',
    bedroom: '#ec4899',
    study: '#3b82f6',
    user_room: '#f59e0b',
    self_room: '#8b5cf6',
    attic: '#6b7280',
    windowsill: '#f97316',
};

// ─── 通用样式 ─────────────────────────────────────────

const inputClass = "w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white focus:outline-none focus:ring-1 focus:ring-violet-300 transition-all";
const labelClass = "text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1";

const WATERLINE_PRESET_COPY: Record<MemoryPalaceWaterlinePreset, { label: string; short: string; description: string }> = {
    online: {
        label: '线上为主',
        short: '默认',
        description: '主要在私聊里慢慢聊，保留更长的连续原文，整理节奏更从容。',
    },
    balanced: {
        label: '综合',
        short: '均衡',
        description: '私聊、见面和剧情都会用，在上下文长度与沉淀速度之间取平衡。',
    },
    offline: {
        label: '见面/剧情为主',
        short: '更快',
        description: '经常使用见面或剧情陪伴，更快沉淀；副 API 会更频繁地被调用。',
    },
    custom: {
        label: '自定义',
        short: '微调',
        description: '自己决定保留多少条原文、积累多少条后开始整理。',
    },
};

const WATERLINE_PRESET_ORDER: MemoryPalaceWaterlinePreset[] = ['online', 'balanced', 'offline', 'custom'];

const MemoryWaterlineEditor: React.FC<{
    character: CharacterProfile;
    expanded: boolean;
    disabled?: boolean;
    onToggle: () => void;
    onPresetChange: (preset: MemoryPalaceWaterlinePreset) => void;
    onSaveCustom: (hotZoneSize: number, bufferThreshold: number) => void;
}> = ({ character, expanded, disabled, onToggle, onPresetChange, onSaveCustom }) => {
    const resolved = resolveMemoryPalaceWaterline(character.memoryPalaceWaterline);
    const [hotDraft, setHotDraft] = useState(String(resolved.hotZoneSize));
    const [bufferDraft, setBufferDraft] = useState(String(resolved.bufferThreshold));
    const [showHelp, setShowHelp] = useState(false);

    useEffect(() => {
        setHotDraft(String(resolved.hotZoneSize));
        setBufferDraft(String(resolved.bufferThreshold));
    }, [character.id, resolved.hotZoneSize, resolved.bufferThreshold]);

    const saveCustom = () => {
        const hot = Number(hotDraft);
        const buffer = Number(bufferDraft);
        onSaveCustom(hot, buffer);
    };

    return (
        <div
            style={{
                marginTop: -2,
                borderRadius: 15,
                border: '1px solid #f5d0e3',
                background: 'linear-gradient(135deg, rgba(253,242,248,0.9), rgba(250,245,255,0.9))',
                overflow: 'hidden',
                opacity: disabled ? 0.65 : 1,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', paddingRight: 10 }}>
                <button
                    type="button"
                    disabled={disabled}
                    onClick={e => { e.stopPropagation(); onToggle(); }}
                    style={{
                        minWidth: 0, flex: 1, border: 0, background: 'transparent', padding: '10px 6px 10px 12px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                        cursor: disabled ? 'wait' : 'pointer', textAlign: 'left',
                    }}
                >
                    <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 11, fontWeight: 800, color: '#9d174d' }}>聊天记忆整理节奏</span>
                        <span style={{ display: 'block', marginTop: 2, fontSize: 10, color: '#9ca3af' }}>
                            {WATERLINE_PRESET_COPY[resolved.preset].label} · AI 直接读最近 {resolved.hotZoneSize} 条 · 每攒 {resolved.bufferThreshold} 条整理
                        </span>
                    </span>
                    <span style={{ color: '#be185d', fontSize: 14, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>⌄</span>
                </button>
                <button
                    type="button"
                    aria-label="水位线是什么"
                    title="水位线是什么"
                    onClick={e => { e.stopPropagation(); setShowHelp(open => !open); }}
                    style={{
                        width: 22, height: 22, flexShrink: 0, borderRadius: '50%',
                        border: '1px solid #e9a8c7', background: showHelp ? '#db2777' : 'rgba(255,255,255,0.8)',
                        color: showHelp ? '#fff' : '#be185d', fontSize: 11, fontWeight: 900,
                        lineHeight: 1, display: 'grid', placeItems: 'center', cursor: 'pointer',
                    }}
                >
                    ?
                </button>
            </div>

            {showHelp && (
                <div
                    style={{
                        margin: '0 10px 10px', padding: '11px 12px', borderRadius: 12,
                        background: '#fff', border: '1px solid #f1d5e4', color: '#6b4b64',
                        fontSize: 10, lineHeight: 1.65, boxShadow: '0 5px 14px rgba(88,28,135,0.08)',
                    }}
                    onClick={e => e.stopPropagation()}
                >
                    <div style={{ fontSize: 11, fontWeight: 900, color: '#9d174d', marginBottom: 6 }}>聊天会按时间排在同一条线上</div>
                    <div style={{ padding: '7px 8px', borderRadius: 9, background: '#faf5ff', color: '#6d28d9', fontWeight: 800, textAlign: 'center' }}>
                        较旧　已向量化整理　｜水位线｜　等待整理　·　最近原文　较新
                    </div>
                    <div style={{ marginTop: 7 }}><b style={{ color: '#7c3aed' }}>水位线前（较旧的一侧）</b>：聊天已经经过向量化，被整理进记忆宫殿。原记录仍在数据库里，没有删除；AI 平时不再整段重读，需要时会从记忆宫殿召回。</div>
                    <div style={{ marginTop: 4 }}><b style={{ color: '#7c3aed' }}>水位线后（较新的一侧）</b>：聊天暂时保留为原文，包括正在等待整理的内容，以及 AI 每次直接读取的最近原文。</div>
                    <div style={{ marginTop: 4 }}>等待区攒够设定条数后，较早的约 85% 会被向量化并移到水位线前，留下约 15% 衔接下一次整理。</div>
                    <div style={{ marginTop: 6, padding: '7px 8px', borderRadius: 9, background: '#faf5ff', color: '#6d28d9' }}>
                        例如 50 / 20：AI 每次直接读最近 50 条；在这 50 条之外又攒够 20 条等待内容时，约 17 条会被向量化、进入水位线前，约 3 条留下衔接。一问一答通常约 2 条消息。
                    </div>
                    <div style={{ marginTop: 7, padding: '7px 8px', borderRadius: 9, background: '#fff1f7', color: '#9d174d' }}>
                        <b>见面、剧情里的内容也会被整理吗？会。</b><br />
                        私聊、见面、通话、剧情、主动消息、小屋、彼方，只要其中有可读内容并进入这个角色的上下文时间线，就都会排进这里，之后跨过同一条水位线进入记忆宫殿。不是只有私聊会整理，也不是每个入口各算一条线。
                    </div>
                </div>
            )}

            {expanded && (
                <div style={{ padding: '0 10px 11px' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                        {WATERLINE_PRESET_ORDER.map(preset => {
                            const active = resolved.preset === preset;
                            const presetNumbers = preset === 'custom'
                                ? null
                                : MEMORY_PALACE_WATERLINE_PRESETS[preset];
                            return (
                                <button
                                    key={preset}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => onPresetChange(preset)}
                                    style={{
                                        border: active ? '1px solid #db2777' : '1px solid #f1d5e4',
                                        borderRadius: 11,
                                        padding: '8px 7px',
                                        background: active ? '#fff1f7' : 'rgba(255,255,255,0.78)',
                                        color: active ? '#9d174d' : '#6b7280',
                                        textAlign: 'left', cursor: disabled ? 'wait' : 'pointer',
                                        boxShadow: active ? '0 2px 8px rgba(219,39,119,0.1)' : 'none',
                                    }}
                                >
                                    <span style={{ display: 'block', fontSize: 10, fontWeight: 800 }}>{WATERLINE_PRESET_COPY[preset].label}</span>
                                    <span style={{ display: 'block', marginTop: 2, fontSize: 9, opacity: 0.72 }}>
                                        {presetNumbers
                                            ? `最近 ${presetNumbers.hotZoneSize} · 攒 ${presetNumbers.bufferThreshold}`
                                            : WATERLINE_PRESET_COPY[preset].short}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    <div style={{ marginTop: 8, padding: '8px 9px', borderRadius: 10, background: 'rgba(255,255,255,0.68)', fontSize: 9.5, lineHeight: 1.5, color: '#7c3aed' }}>
                        {WATERLINE_PRESET_COPY[resolved.preset].description}
                    </div>

                    {resolved.preset === 'custom' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, alignItems: 'end', marginTop: 8 }}>
                            <label style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', fontSize: 9, color: '#9ca3af', marginBottom: 3 }}>AI 直接读最近原文（20–500）</span>
                                <input
                                    type="number"
                                    min={MIN_MEMORY_HOT_ZONE_SIZE}
                                    max={MAX_MEMORY_HOT_ZONE_SIZE}
                                    step={10}
                                    value={hotDraft}
                                    onChange={e => setHotDraft(e.target.value)}
                                    style={{ width: '100%', minWidth: 0, border: '1px solid #e9d5ff', borderRadius: 9, padding: '7px 6px', fontSize: 11, color: '#581c87', background: '#fff' }}
                                />
                            </label>
                            <label style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', fontSize: 9, color: '#9ca3af', marginBottom: 3 }}>攒够多少条开始整理（10–200）</span>
                                <input
                                    type="number"
                                    min={MIN_MEMORY_BUFFER_THRESHOLD}
                                    max={MAX_MEMORY_BUFFER_THRESHOLD}
                                    step={10}
                                    value={bufferDraft}
                                    onChange={e => setBufferDraft(e.target.value)}
                                    style={{ width: '100%', minWidth: 0, border: '1px solid #e9d5ff', borderRadius: 9, padding: '7px 6px', fontSize: 11, color: '#581c87', background: '#fff' }}
                                />
                            </label>
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={saveCustom}
                                style={{ border: 0, borderRadius: 9, padding: '8px 9px', background: '#7c3aed', color: '#fff', fontSize: 10, fontWeight: 800, cursor: disabled ? 'wait' : 'pointer' }}
                            >
                                保存
                            </button>
                        </div>
                    )}

                    <div style={{ marginTop: 8, fontSize: 9, lineHeight: 1.45, color: '#9ca3af' }}>
                        调快后会在下一次达到阈值时整理，成功前不会隐藏原文；调慢不会倒退水位或重复记忆，原文窗口会随新对话逐渐变长。
                    </div>
                </div>
            )}
        </div>
    );
};

// ─── 主组件 ───────────────────────────────────────────

export default function MemoryPalaceApp() {
    const { activeCharacterId, characters, updateCharacter, setActiveCharacterId, closeApp, apiPresets, userProfile, memoryPalaceConfig, updateMemoryPalaceConfig, remoteVectorConfig, updateRemoteVectorConfig, addToast, apiConfig, characterGroups, groups, realtimeConfig } = useOS();
    const char = characters.find(c => c.id === activeCharacterId);
    const [selectGroupId, setSelectGroupId] = useState(GROUP_FILTER_ALL); // 选角色页的分组筛选

    const [view, setView] = useState<'picker' | 'palace' | 'room' | 'memory' | 'settings' | 'globalSettings' | 'all' | 'boxes'>('picker');
    const [selectedRoom, setSelectedRoom] = useState<MemoryRoom | null>(null);
    const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);
    const [roomCounts, setRoomCounts] = useState<Record<MemoryRoom, number>>({} as any);
    const [showCharPicker, setShowCharPicker] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [selectMode, setSelectMode] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [roomNodes, setRoomNodes] = useState<MemoryNode[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [linkCount, setLinkCount] = useState(0);
    const [boxCount, setBoxCount] = useState(0);
    const [anticipations, setAnticipations] = useState<Anticipation[]>([]);
    const [pinnedNodes, setPinnedNodes] = useState<MemoryNode[]>([]);
    const [editingAnticipation, setEditingAnticipation] = useState<Anticipation | null>(null);
    const [anticipationDraft, setAnticipationDraft] = useState('');
    const [savingAnticipation, setSavingAnticipation] = useState(false);
    const anticipationPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const anticipationPressStartRef = React.useRef<{ x: number; y: number } | null>(null);

    // 事件盒视图
    const [allBoxes, setAllBoxes] = useState<EventBox[]>([]);
    const [expandedBoxId, setExpandedBoxId] = useState<string | null>(null);
    const [boxMembers, setBoxMembers] = useState<Record<string, { summary: MemoryNode | null; live: MemoryNode[]; archived: MemoryNode[] }>>({});
    // 事件盒名/tag 手动编辑状态（box.name / box.tags 仅用于展示抬头，不参与召回打分）
    const [editingBoxId, setEditingBoxId] = useState<string | null>(null);
    const [boxNameDraft, setBoxNameDraft] = useState('');
    const [boxTagsDraft, setBoxTagsDraft] = useState('');
    const [savingBox, setSavingBox] = useState(false);
    const [regeneratingBoxId, setRegeneratingBoxId] = useState<string | null>(null);

    // 迁移状态
    const [migrating, setMigrating] = useState(false);
    const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
    const [migrationResult, setMigrationResult] = useState<string | null>(null);

    // 月份选择（导入旧记忆）
    const [availableMonths, setAvailableMonths] = useState<string[]>([]);
    const [availableChunks, setAvailableChunks] = useState<{ key: string; count: number }[]>([]);
    const [selectedMonths, setSelectedMonths] = useState<Set<string>>(new Set());

    // 手动总结与向量化（保底机制）：圈选聊天区间 → 走一次总结，不碰水位线
    const [showHistoryCleanup, setShowHistoryCleanup] = useState(false);
    useEffect(() => setShowHistoryCleanup(false), [char?.id]);
    const [rangeModalOpen, setRangeModalOpen] = useState(false);
    const [rangeMessages, setRangeMessages] = useState<Message[]>([]);
    const [rangeLoading, setRangeLoading] = useState(false);
    const [rangeQuery, setRangeQuery] = useState('');
    const [rangePage, setRangePage] = useState(0); // 当前页（0 起）
    const [rangeStartId, setRangeStartId] = useState<number | null>(null);
    const [rangeEndId, setRangeEndId] = useState<number | null>(null);
    // 点一条消息先进入"待确认"，弹出[设为起点/设为终点]，避免误触
    const [rangePendingId, setRangePendingId] = useState<number | null>(null);
    const [rangeRunning, setRangeRunning] = useState(false);
    const [rangeProgress, setRangeProgress] = useState('');
    const [rangeResult, setRangeResult] = useState<string | null>(null);
    const [rangeCursor, setRangeCursor] = useState<{ beforeId?: number; afterId?: number }>({});
    const [rangeHasOlder, setRangeHasOlder] = useState(false);
    const [rangeHasNewer, setRangeHasNewer] = useState(false);
    useEffect(() => {
        if (!rangeModalOpen || !char) { setRangeMessages([]); return; }
        const controller = new AbortController();
        setRangeLoading(true);
        setRangePendingId(null);
        const timer = setTimeout(() => {
            void loadRangeMessagePage(char.id, { ...rangeCursor, query: rangeQuery, limit: RANGE_PAGE_SIZE, signal: controller.signal })
                .then(result => {
                    if (controller.signal.aborted) return;
                    setRangeMessages(result.messages);
                    setRangeHasOlder(rangeCursor.afterId !== undefined || result.hasMore);
                    setRangeHasNewer(rangeCursor.beforeId !== undefined || (rangeCursor.afterId !== undefined && result.hasMore));
                }).catch(error => {
                    if (controller.signal.aborted) return;
                    setRangeMessages([]);
                    setRangeHasOlder(false);
                    setRangeHasNewer(false);
                    addToast('加载聊天记录失败：' + (error?.message || error), 'error');
                }).finally(() => { if (!controller.signal.aborted) setRangeLoading(false); });
        }, rangeQuery ? 250 : 0);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [rangeModalOpen, char?.id, rangeCursor, rangeQuery]);
    // 完成后的结果弹窗（逐条列出新增记忆，和水位线总结一致）
    const [rangeResultData, setRangeResultData] = useState<import('../utils/memoryPalace/pipeline').RangeProcessResult | null>(null);

    // 全部记忆视图
    const [allNodes, setAllNodes] = useState<MemoryNode[]>([]);
    const [allSortBy, setAllSortBy] = useState<'time' | 'importance'>('time');
    const [allSortDir, setAllSortDir] = useState<'desc' | 'asc'>('desc');
    const [prevView, setPrevView] = useState<'room' | 'all' | 'boxes'>('room');

    // 认知消化状态
    const [digesting, setDigesting] = useState(false);
    const [digestResult, setDigestResult] = useState<string | null>(null);
    // 消化日志：null=未打开；[]=打开但没有记录
    const [digestReports, setDigestReports] = useState<DigestReport[] | null>(null);
    const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
    useEffect(() => { setDigestReports(null); setExpandedReportId(null); }, [char?.id]);
    // 门牌历史回填（老用户把积压立牌）
    const [bootstrapping, setBootstrapping] = useState(false);
    const [bootstrapStatus, setBootstrapStatus] = useState<string | null>(null);

    const handleBootstrapPlates = async () => {
        if (!char || bootstrapping) return;
        const lightApi = memoryPalaceConfig.lightLLM;
        if (!lightApi?.baseUrl) {
            setBootstrapStatus('[err]请先在设置中配置副 API');
            return;
        }
        setBootstrapping(true);
        setBootstrapStatus(null);
        trackEvent('整理历史记忆到门牌');
        try {
            // 每按一次只清一小段（断点续传）：上千条记忆的用户不会被一长串批次吓到，
            // 也随时可以停——进度存在本地，下次按继续
            const MANUAL_BATCHES_PER_PRESS = 5;
            const result = await bootstrapPlatesFromHistory(char.id, char.name, userProfile?.name, lightApi, {
                startBatch: getBootstrapResume(char.id),
                maxBatches: MANUAL_BATCHES_PER_PRESS,
                onProgress: (done, total) => setBootstrapStatus(`正在整理第 ${done}/${total} 批历史记忆…（请留在本页）`),
            });
            if (result.totalLines === 0) {
                setBootstrapStatus('记忆宫殿里还没有可立牌的历史');
            } else if (result.complete) {
                markPlateBootstrapDone(char.id);
                clearBootstrapResume(char.id);
                setBootstrapStatus(`[ok]历史全部整理完（共 ${result.neededBatches} 批），更新 ${result.updated.length} 块门牌——去神经链接「门牌」页看看`);
            } else {
                setBootstrapResume(char.id, result.nextBatch);
                setBootstrapStatus(`[ok]本次整理了 ${result.batches} 批（总进度 ${result.nextBatch}/${result.neededBatches}），更新 ${result.updated.length} 块门牌。再按一次继续`);
            }
        } catch (err: any) {
            setBootstrapStatus(`[err]整理失败：${err?.message || err}（可再按一次重试，已整理的部分不会重复计入）`);
        } finally {
            setBootstrapping(false);
        }
    };


    // 一键清空
    const [wiping, setWiping] = useState(false);
    const [wipeResult, setWipeResult] = useState<string | null>(null);

    // 导出记忆（接入外置记忆库）
    const [exporting, setExporting] = useState(false);
    const [exportResult, setExportResult] = useState<string | null>(null);
    // 默认带上向量：多数用户长期用同一套 embedding 模型，向量可直接复用、免重新向量化
    const [exportWithVectors, setExportWithVectors] = useState(true);

    // 导入记忆
    const [importing, setImporting] = useState(false);
    const [importResult, setImportResult] = useState<string | null>(null);
    const importInputRef = React.useRef<HTMLInputElement>(null);
    // 从其它应用搬来的原始文本：同一次清洗结果双写向量宫殿与神经链接角色档案。
    const [externalMemoryText, setExternalMemoryText] = useState('');
    const [externalImporting, setExternalImporting] = useState(false);
    const [externalImportProgress, setExternalImportProgress] = useState('');
    const [externalImportResult, setExternalImportResult] = useState<string | null>(null);
    const externalLengthInfo = useMemo(
        () => getExternalMemoryLengthInfo(externalMemoryText),
        [externalMemoryText],
    );

    // 关联记忆状态（记忆详情页展示 EventBox 兄弟 + 兼容展示遗留 causal link）
    const [linkedMemories, setLinkedMemories] = useState<LinkedMemoryUI[]>([]);
    const [currentBox, setCurrentBox] = useState<EventBox | null>(null);
    const [loadingLinks, setLoadingLinks] = useState(false);
    const [showLinkSearch, setShowLinkSearch] = useState(false);
    const [linkSearchQuery, setLinkSearchQuery] = useState('');
    const [linkSearchResults, setLinkSearchResults] = useState<MemoryNode[]>([]);

    // 全局搜索状态
    const [globalSearchQuery, setGlobalSearchQuery] = useState('');
    const [globalSearchResults, setGlobalSearchResults] = useState<MemoryNode[]>([]);
    const globalSearchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // 全自动记忆（自动归档）catch-up 状态：按角色 id 分别记录
    const [autoArchiveSyncingId, setAutoArchiveSyncingId] = useState<string | null>(null);
    const [autoArchiveSyncProgress, setAutoArchiveSyncProgress] = useState('');
    const [waterlineEditorCharId, setWaterlineEditorCharId] = useState<string | null>(null);

    // 全自动记忆追平确认弹窗（替代原生 confirm）
    const [autoArchiveConfirm, setAutoArchiveConfirm] = useState<{
        charId: string;
        charName: string;
        unprocessedCount: number;
        minutes: number;
        mpEmb: any;
        mpLLM: any;
    } | null>(null);

    // 记忆编辑状态
    const [editing, setEditing] = useState(false);
    const [editContent, setEditContent] = useState('');
    const [editImportance, setEditImportance] = useState(5);
    const [editMood, setEditMood] = useState('');
    const [editRoom, setEditRoom] = useState<MemoryRoom>('living_room');
    const [editTags, setEditTags] = useState('');
    const [saving, setSaving] = useState(false);

    // Embedding 配置本地状态（从全局配置初始化）
    const [embUrl, setEmbUrl] = useState(memoryPalaceConfig.embedding.baseUrl || 'https://api.siliconflow.cn/v1');
    const [embKey, setEmbKey] = useState(memoryPalaceConfig.embedding.apiKey || '');
    const [embModel, setEmbModel] = useState(memoryPalaceConfig.embedding.model || 'BAAI/bge-m3');
    const [embDimensions, setEmbDimensions] = useState(memoryPalaceConfig.embedding.dimensions || 1024);
    const [configSaved, setConfigSaved] = useState(false);
    const [testingEmb, setTestingEmb] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);

    // 副 API 配置（全局配置）
    const [lightUrl, setLightUrl] = useState(memoryPalaceConfig.lightLLM.baseUrl || '');
    const [lightKey, setLightKey] = useState(memoryPalaceConfig.lightLLM.apiKey || '');
    const [lightModel, setLightModel] = useState(memoryPalaceConfig.lightLLM.model || '');
    const [lightSaved, setLightSaved] = useState(false);
    const [testingLight, setTestingLight] = useState(false);
    const [lightTestResult, setLightTestResult] = useState<string | null>(null);

    // Rerank 配置（全局；cross-encoder 二次排序，独立于主召回的可选增强通道）
    const [rrEnabled, setRrEnabled] = useState(!!memoryPalaceConfig.rerank?.enabled);
    const [rrUrl, setRrUrl] = useState(memoryPalaceConfig.rerank?.baseUrl || '');
    const [rrKey, setRrKey] = useState(memoryPalaceConfig.rerank?.apiKey || '');
    const [rrModel, setRrModel] = useState(memoryPalaceConfig.rerank?.model || 'BAAI/bge-reranker-v2-m3');
    const [rrTopN, setRrTopN] = useState(memoryPalaceConfig.rerank?.topN || 5);
    const [rrSaved, setRrSaved] = useState(false);
    const [rrTesting, setRrTesting] = useState(false);
    const [rrTestResult, setRrTestResult] = useState<string | null>(null);

    // 远程向量存储配置
    const [rvUrl, setRvUrl] = useState(remoteVectorConfig.supabaseUrl);
    const [rvKey, setRvKey] = useState(remoteVectorConfig.supabaseAnonKey);
    const [rvTestResult, setRvTestResult] = useState('');
    const [rvTesting, setRvTesting] = useState(false);
    const [rvSyncing, setRvSyncing] = useState(false);
    const [showInitSQL, setShowInitSQL] = useState(false);

    // 全局配置变更时同步到本地状态
    useEffect(() => {
        setEmbUrl(memoryPalaceConfig.embedding.baseUrl || 'https://api.siliconflow.cn/v1');
        setEmbKey(memoryPalaceConfig.embedding.apiKey || '');
        setEmbModel(memoryPalaceConfig.embedding.model || 'BAAI/bge-m3');
        setEmbDimensions(memoryPalaceConfig.embedding.dimensions || 1024);
        setLightUrl(memoryPalaceConfig.lightLLM.baseUrl || '');
        setLightKey(memoryPalaceConfig.lightLLM.apiKey || '');
        setLightModel(memoryPalaceConfig.lightLLM.model || '');
        setRrEnabled(!!memoryPalaceConfig.rerank?.enabled);
        setRrUrl(memoryPalaceConfig.rerank?.baseUrl || '');
        setRrKey(memoryPalaceConfig.rerank?.apiKey || '');
        setRrModel(memoryPalaceConfig.rerank?.model || 'BAAI/bge-reranker-v2-m3');
        setRrTopN(memoryPalaceConfig.rerank?.topN || 5);
    }, [memoryPalaceConfig]);

    // 远程向量配置变更时同步到本地状态
    useEffect(() => {
        setRvUrl(remoteVectorConfig.supabaseUrl);
        setRvKey(remoteVectorConfig.supabaseAnonKey);
    }, [remoteVectorConfig.supabaseUrl, remoteVectorConfig.supabaseAnonKey]);

    // 人格风格 + 反刍倾向 检测
    const [detectingPersonality, setDetectingPersonality] = useState(false);
    const [pendingPersonality, setPendingPersonality] = useState<{ style: string; ruminationTendency: number; reasoning: string } | null>(null);
    // pendingPersonality 绑定到产生它的角色 id，防止切角色后把旧结果应用到新角色
    const [pendingPersonalityCharId, setPendingPersonalityCharId] = useState<string | null>(null);
    // 抽出原始字段作为 useEffect 依赖，避免 memoryPalaceConfig 对象新引用触发重跑
    const lightLLMBaseUrl = memoryPalaceConfig.lightLLM?.baseUrl || '';
    const lightLLMApiKey = memoryPalaceConfig.lightLLM?.apiKey || '';

    // 切换角色时清掉上一个角色遗留的待确认结果
    useEffect(() => {
        if (pendingPersonalityCharId && pendingPersonalityCharId !== char?.id) {
            setPendingPersonality(null);
            setPendingPersonalityCharId(null);
        }
    }, [char?.id, pendingPersonalityCharId]);

    useEffect(() => {
        if (!char || (char as any).personalityStyle) return;
        // 只在 palace 视图里检测；picker 只是选人页，此时 char 还是上个上下文遗留的 activeCharacterId
        // （比如刚从 Sully 的聊天退出就打开记忆宫殿），在 picker 里跑会把旧角色当前角色拿去检测
        if (view !== 'palace') return;
        // 已经尝试过或已确认过，不再重复检测（避免 LLM 偶发重置人格）
        const skipKey = `mp_personality_tried_${char.id}`;
        if (localStorage.getItem(skipKey)) return;
        if (!lightLLMBaseUrl || !lightLLMApiKey) return;

        // 切换角色时，丢弃旧角色尚未返回的检测结果，避免把 A 的人格应用到 B
        let cancelled = false;
        const detectingCharId = char.id;

        setDetectingPersonality(true);
        const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
        detectPersonalityStyle(detectingCharId, char.name, persona, memoryPalaceConfig.lightLLM)
            .then(result => {
                if (cancelled) return;
                setPendingPersonality(result);
                setPendingPersonalityCharId(detectingCharId);
            })
            .catch(e => {
                if (cancelled) return;
                console.warn('🎭 性格检测失败:', e.message);
                // 标记已尝试，避免重复弹窗；用户可在设置里手动调整
                localStorage.setItem(skipKey, '1');
            })
            .finally(() => {
                if (!cancelled) setDetectingPersonality(false);
            });

        return () => { cancelled = true; };
        // 依赖用原始字符串字段，避免 memoryPalaceConfig 对象每次新引用都重跑
    }, [char?.id, (char as any)?.personalityStyle, view, lightLLMBaseUrl, lightLLMApiKey]);

    // 手动触发 AI 评估（认知参数设置区的按钮）。和自动检测共用 detecting/pending
    // 两个状态，所以结果同样走"分析中 → 确认"两屏流程。副 API 没配时退回主
    // apiConfig —— 跟 useChatAI 里 mpLLM 的 fallback 策略一致。
    const manualDetectPersonality = () => {
        if (!char || detectingPersonality) return;
        const llm = (lightLLMBaseUrl && lightLLMApiKey)
            ? memoryPalaceConfig.lightLLM
            : (apiConfig?.baseUrl && apiConfig?.apiKey
                ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model }
                : null);
        if (!llm) {
            addToast('请先配置副 API（记忆宫殿全局设置）或主 API', 'error');
            return;
        }
        const detectingCharId = char.id;
        const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
        setDetectingPersonality(true);
        trackEvent('评估角色认知参数');
        detectPersonalityStyle(detectingCharId, char.name, persona, llm)
            .then(result => {
                setPendingPersonality(result);
                setPendingPersonalityCharId(detectingCharId);
            })
            .catch(e => {
                console.warn('🎭 手动性格评估失败:', e?.message || e);
                addToast(`评估失败：${e?.message || e}`, 'error');
            })
            .finally(() => setDetectingPersonality(false));
    };

    // 判断是否已配置（使用全局配置）
    const hasEmbeddingConfig = !!(memoryPalaceConfig.embedding.baseUrl && memoryPalaceConfig.embedding.apiKey);
    const hasLightApi = !!(memoryPalaceConfig.lightLLM.baseUrl && memoryPalaceConfig.lightLLM.apiKey);

    // 加载数据
    const loadStats = useCallback(async () => {
        if (!char) return;

        const allNodes = await MemoryNodeDB.getByCharId(char.id);
        setTotalCount(allNodes.length);

        const counts: Record<string, number> = {};
        const rooms: MemoryRoom[] = ['living_room', 'bedroom', 'study', 'user_room', 'self_room', 'attic', 'windowsill'];
        for (const room of rooms) {
            counts[room] = allNodes.filter(n => n.room === room).length;
        }
        setRoomCounts(counts as any);

        const boxes = await EventBoxDB.getByCharId(char.id);
        setBoxCount(boxes.length);

        const ants = await AnticipationDB.getByCharId(char.id);
        setAnticipations(ants);

        // 加载便利贴置顶记忆
        const now = Date.now();
        setPinnedNodes(allNodes.filter(n => n.pinnedUntil && n.pinnedUntil > now));

        let links = 0;
        for (const node of allNodes.slice(0, 5)) {
            const nodeLinks = await MemoryLinkDB.getByNodeId(node.id);
            links += nodeLinks.length;
        }
        setLinkCount(links);
    }, [char]);

    useEffect(() => { loadStats(); }, [loadStats]);

    const cancelAnticipationLongPress = useCallback(() => {
        if (anticipationPressTimerRef.current) {
            clearTimeout(anticipationPressTimerRef.current);
            anticipationPressTimerRef.current = null;
        }
        anticipationPressStartRef.current = null;
    }, []);

    const openAnticipationEditor = useCallback((ant: Anticipation) => {
        cancelAnticipationLongPress();
        setEditingAnticipation(ant);
        setAnticipationDraft(ant.content);
    }, [cancelAnticipationLongPress]);

    const startAnticipationLongPress = useCallback((e: React.PointerEvent<HTMLDivElement>, ant: Anticipation) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        cancelAnticipationLongPress();
        anticipationPressStartRef.current = { x: e.clientX, y: e.clientY };
        anticipationPressTimerRef.current = setTimeout(() => {
            anticipationPressTimerRef.current = null;
            anticipationPressStartRef.current = null;
            setEditingAnticipation(ant);
            setAnticipationDraft(ant.content);
        }, 550);
    }, [cancelAnticipationLongPress]);

    const moveAnticipationLongPress = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        const start = anticipationPressStartRef.current;
        if (!start) return;
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
            cancelAnticipationLongPress();
        }
    }, [cancelAnticipationLongPress]);

    useEffect(() => () => cancelAnticipationLongPress(), [cancelAnticipationLongPress]);
    useEffect(() => {
        setEditingAnticipation(null);
        setAnticipationDraft('');
    }, [char?.id]);

    const handleSaveAnticipation = async () => {
        if (!editingAnticipation) return;
        const content = anticipationDraft.trim();
        if (!content) {
            addToast('期盼内容不能为空', 'error');
            return;
        }
        setSavingAnticipation(true);
        try {
            const updated = { ...editingAnticipation, content };
            await AnticipationDB.save(updated);
            setAnticipations(prev => prev.map(ant => ant.id === updated.id ? updated : ant));
            setEditingAnticipation(null);
            setAnticipationDraft('');
            addToast('窗台期盼已修改', 'success');
        } finally {
            setSavingAnticipation(false);
        }
    };

    const handleDeleteAnticipation = async () => {
        if (!editingAnticipation) return;
        if (!window.confirm('确定删除这条窗台期盼吗？删除后不会自动恢复。')) return;
        setSavingAnticipation(true);
        try {
            await AnticipationDB.delete(editingAnticipation.id);
            setAnticipations(prev => prev.filter(ant => ant.id !== editingAnticipation.id));
            setEditingAnticipation(null);
            setAnticipationDraft('');
            addToast('窗台期盼已删除', 'success');
        } finally {
            setSavingAnticipation(false);
        }
    };

    // 加载可用月份和分块（旧记忆迁移用）
    useEffect(() => {
        if (char?.memories && char.memories.length > 0) {
            const months = getAvailableMonths(char.memories as any);
            setAvailableMonths(months);
            const chunks = getAvailableChunks(char.memories as any);
            setAvailableChunks(chunks);
        } else {
            setAvailableMonths([]);
            setAvailableChunks([]);
        }
    }, [char?.id, char?.memories?.length]);

    const openAllMemories = async () => {
        if (!char) return;
        const nodes = await MemoryNodeDB.getByCharId(char.id);
        setAllNodes(nodes);
        setView('all');
    };

    const openAllBoxes = async () => {
        if (!char) return;
        trackEvent('打开事件盒列表');
        const boxes = await EventBoxDB.getByCharId(char.id);
        boxes.sort((a, b) => b.updatedAt - a.updatedAt);
        setAllBoxes(boxes);
        setExpandedBoxId(null);
        setBoxMembers({});
        setView('boxes');
    };

    /** 把一条归档记忆复活成活节点。
     *  归档节点默认被压入 summary 不参与召回——手动点"复活"后回到活池独立参与召回。
     *  数据层走 reviveArchivedMemory：archived=false + box.archivedMemoryIds → liveMemoryIds
     *  + MemoryNodeDB.save 触发远程 upsertVector 同步 archived=false 到云。 */
    const handleReviveArchived = async (box: EventBox, node: MemoryNode) => {
        if (!char) return;
        try {
            await reviveArchivedMemory(node.id);
            // 重新拉取本盒成员（archived → live 的位置变化 + 盒元数据 updatedAt）
            const fresh = (await EventBoxDB.getById(box.id)) || box;
            const summary = fresh.summaryNodeId ? await MemoryNodeDB.getById(fresh.summaryNodeId) : null;
            const live: MemoryNode[] = [];
            for (const id of fresh.liveMemoryIds) {
                const n = await MemoryNodeDB.getById(id);
                if (n) live.push(n);
            }
            const archived: MemoryNode[] = [];
            for (const id of fresh.archivedMemoryIds) {
                const n = await MemoryNodeDB.getById(id);
                if (n) archived.push(n);
            }
            setBoxMembers(prev => ({ ...prev, [box.id]: { summary: summary || null, live, archived } }));
            // 盒列表的 updatedAt 也变了，刷一下
            const boxes = await EventBoxDB.getByCharId(char.id);
            boxes.sort((a, b) => b.updatedAt - a.updatedAt);
            setAllBoxes(boxes);
            loadStats();
        } catch (e: any) {
            alert(`复活失败：${e?.message || e}`);
        }
    };

    /** 进入/退出某盒的名字+tag 编辑态。box.name/box.tags 只决定召回时的展示抬头，
     *  不参与向量/BM25 检索打分（检索只认成员节点的 content/tags），改它不影响召回结果。 */
    const startEditBoxMeta = (box: EventBox) => {
        setEditingBoxId(box.id);
        setBoxNameDraft(box.name || '');
        setBoxTagsDraft(box.tags.join(', '));
    };
    const cancelEditBoxMeta = () => {
        setEditingBoxId(null);
        setBoxNameDraft('');
        setBoxTagsDraft('');
    };
    const handleSaveBoxMeta = async (box: EventBox) => {
        if (!char) return;
        setSavingBox(true);
        try {
            const fresh = (await EventBoxDB.getById(box.id)) || box;
            // 名字留空 → 回退默认值，避免存出空标题
            fresh.name = boxNameDraft.trim() || '未命名事件';
            fresh.tags = boxTagsDraft.split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 20);
            fresh.updatedAt = Date.now();
            await EventBoxDB.save(fresh);
            // 刷新盒列表（保持原排序：按 updatedAt 倒序）
            const boxes = await EventBoxDB.getByCharId(char.id);
            boxes.sort((a, b) => b.updatedAt - a.updatedAt);
            setAllBoxes(boxes);
            cancelEditBoxMeta();
        } catch (e: any) {
            alert(`保存失败：${e?.message || e}`);
        } finally {
            setSavingBox(false);
        }
    };

    /**
     * 用盒内全部 archived + live 原始节点重新生成 summary。
     * 数据层保证 Embedding 成功后才覆盖旧正文；这里负责确认、忙碌态和刷新 UI。
     */
    const handleRegenerateBoxSummary = async (box: EventBox) => {
        if (!char || regeneratingBoxId) return;
        const lightApi = memoryPalaceConfig.lightLLM;
        const embedding = memoryPalaceConfig.embedding;
        if (!lightApi?.baseUrl || !lightApi.apiKey || !lightApi.model) {
            addToast('请先在记忆宫殿设置中完整配置副 API', 'error');
            return;
        }
        if (!embedding?.baseUrl || !embedding.apiKey || !embedding.model) {
            addToast('请先在记忆宫殿设置中完整配置 Embedding API', 'error');
            return;
        }

        const sourceCount = new Set([
            ...box.archivedMemoryIds,
            ...box.liveMemoryIds,
        ]).size;
        if (sourceCount === 0) {
            addToast('盒内没有可用于重新整合的原始记忆', 'error');
            return;
        }
        if (!window.confirm(
            `重新整合「${box.name || '未命名事件'}」？\n\n`
            + `副 API 会重新读取盒内全部 ${sourceCount} 条原始记忆，不使用当前整合回忆；`
            + `随后重新生成语义向量。新总结和向量都成功后才会覆盖当前内容。`,
        )) return;

        setRegeneratingBoxId(box.id);
        try {
            const result = await regenerateEventBoxSummary(
                box.id,
                lightApi,
                embedding,
                char.name,
                userProfile?.name,
                remoteVectorConfig,
            );

            const fresh = result.box;
            const live = (await Promise.all(
                fresh.liveMemoryIds.map(id => MemoryNodeDB.getById(id)),
            )).filter((node): node is MemoryNode => Boolean(node));
            const archived = (await Promise.all(
                fresh.archivedMemoryIds.map(id => MemoryNodeDB.getById(id)),
            )).filter((node): node is MemoryNode => Boolean(node));
            setBoxMembers(prev => ({
                ...prev,
                [fresh.id]: { summary: result.summary, live, archived },
            }));

            const boxes = await EventBoxDB.getByCharId(char.id);
            boxes.sort((a, b) => b.updatedAt - a.updatedAt);
            setAllBoxes(boxes);
            setSelectedNode(prev => prev?.id === result.summary.id ? result.summary : prev);
            await loadStats();
            addToast(`已重新整合 ${result.sourceCount} 条原始记忆，语义向量已更新`, 'success');
        } catch (e: any) {
            addToast(`重新整合失败：${e?.message || e}`, 'error');
        } finally {
            setRegeneratingBoxId(null);
        }
    };

    /** 一键移出某 box 的所有活节点（应急出口：压缩连续失败导致活池堆到几十条时用）。
     *  记忆不删，回到"地上"作为独立记忆。summary / archived 保持不动。 */
    const handleUnbindAllLive = async (box: EventBox) => {
        if (!char) return;
        const liveCount = box.liveMemoryIds.length;
        if (liveCount === 0) return;
        if (!confirm(
            `把「${box.name || '未命名'}」里的 ${liveCount} 条活节点全部移出？\n\n`
            + `这些记忆不会被删除，只是脱离当前事件盒、回到"地上"作为独立记忆。\n`
            + `整合回忆（summary）和已归档节点保持不动。`
        )) return;
        try {
            await unbindAllLiveMemories(box.id);
            // 刷新 allBoxes + 展开态（盒可能已被整个删掉）
            const boxes = await EventBoxDB.getByCharId(char.id);
            boxes.sort((a, b) => b.updatedAt - a.updatedAt);
            setAllBoxes(boxes);
            const stillExists = boxes.some(b => b.id === box.id);
            if (!stillExists) {
                setExpandedBoxId(null);
                setBoxMembers(prev => {
                    const next = { ...prev };
                    delete next[box.id];
                    return next;
                });
            } else {
                setBoxMembers(prev => ({
                    ...prev,
                    [box.id]: { ...(prev[box.id] || { summary: null, live: [], archived: [] }), live: [] },
                }));
            }
            loadStats();
        } catch (e: any) {
            alert(`移出失败：${e?.message || e}`);
        }
    };

    const toggleBoxExpand = async (box: EventBox) => {
        if (expandedBoxId === box.id) {
            setExpandedBoxId(null);
            return;
        }
        if (!boxMembers[box.id]) {
            const summary = box.summaryNodeId ? await MemoryNodeDB.getById(box.summaryNodeId) : null;
            const live: MemoryNode[] = [];
            for (const id of box.liveMemoryIds) {
                const n = await MemoryNodeDB.getById(id);
                if (n) live.push(n);
            }
            const archived: MemoryNode[] = [];
            for (const id of box.archivedMemoryIds) {
                const n = await MemoryNodeDB.getById(id);
                if (n) archived.push(n);
            }
            setBoxMembers(prev => ({ ...prev, [box.id]: { summary: summary || null, live, archived } }));
        }
        setExpandedBoxId(box.id);
    };

    const openRoom = async (room: MemoryRoom) => {
        if (!char) return;
        trackEvent('打开记忆宫殿房间', { room });
        const nodes = await MemoryNodeDB.getByRoom(char.id, room);
        nodes.sort((a: MemoryNode, b: MemoryNode) => b.createdAt - a.createdAt);
        setRoomNodes(nodes);
        setSelectedRoom(room);
        setView('room');
    };

    const loadLinkedMemories = async (nodeId: string) => {
        setLoadingLinks(true);
        try {
            const node = await MemoryNodeDB.getById(nodeId);
            const results: LinkedMemoryUI[] = [];
            let box: EventBox | null = null;

            // 1) 若归属 EventBox → 列出 summary + 所有兄弟（live / archived）
            if (node?.eventBoxId) {
                box = (await EventBoxDB.getById(node.eventBoxId)) || null;
                if (box) {
                    // summary 节点
                    if (box.summaryNodeId && box.summaryNodeId !== nodeId) {
                        const s = await MemoryNodeDB.getById(box.summaryNodeId);
                        if (s) results.push({
                            id: `eb-summary-${box.id}`, relation: 'box_summary', box, node: s,
                        });
                    }
                    // live 兄弟
                    for (const id of box.liveMemoryIds) {
                        if (id === nodeId) continue;
                        const n = await MemoryNodeDB.getById(id);
                        if (n) results.push({
                            id: `eb-live-${box.id}-${id}`, relation: 'box_live', box, node: n,
                        });
                    }
                    // archived 兄弟（展示但视觉上弱化）
                    for (const id of box.archivedMemoryIds) {
                        if (id === nodeId) continue;
                        const n = await MemoryNodeDB.getById(id);
                        if (n) results.push({
                            id: `eb-arch-${box.id}-${id}`, relation: 'box_archived', box, node: n,
                        });
                    }
                }
            }

            // 2) 兼容展示遗留 causal MemoryLink（旧版本残留，新代码不再创建）
            const legacyLinks = await MemoryLinkDB.getByNodeId(nodeId);
            for (const link of legacyLinks.filter(l => l.type === 'causal')) {
                const otherId = link.sourceId === nodeId ? link.targetId : link.sourceId;
                if (results.some(r => r.node.id === otherId)) continue; // box 里已展示，不再重复
                const otherNode = await MemoryNodeDB.getById(otherId);
                if (otherNode) results.push({
                    id: link.id, relation: 'legacy_causal', node: otherNode,
                });
            }

            setCurrentBox(box);
            setLinkedMemories(results);
        } catch {
            setCurrentBox(null);
            setLinkedMemories([]);
        } finally {
            setLoadingLinks(false);
        }
    };

    const openMemory = (node: MemoryNode, from?: 'room' | 'all' | 'boxes') => {
        setSelectedNode(node);
        setEditing(false);
        setEditContent(node.content);
        setEditImportance(node.importance);
        setEditMood(node.mood);
        setEditRoom(node.room);
        setEditTags(node.tags.join(', '));
        setLinkedMemories([]);
        setCurrentBox(null);
        setPrevView(from || 'room');
        setView('memory');
        loadLinkedMemories(node.id);
    };

    const handleSaveEdit = async () => {
        if (!selectedNode || !char) return;
        setSaving(true);
        try {
            const result = await updateStoredMemoryNode(
                selectedNode.id,
                {
                content: editContent.trim(),
                importance: editImportance,
                mood: editMood.trim(),
                room: editRoom,
                tags: editTags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
                },
                memoryPalaceConfig.embedding,
                remoteVectorConfig,
            );
            const updated = result.node;
            setSelectedNode(updated);
            setEditing(false);
            addToast(
                result.reembedded ? '记忆已保存，语义向量已同步更新' : '记忆设置已保存',
                'success',
            );
            // 如果房间变了，刷新房间列表
            if (selectedRoom) {
                const nodes = await MemoryNodeDB.getByRoom(char.id, selectedRoom);
                nodes.sort((a: MemoryNode, b: MemoryNode) => b.createdAt - a.createdAt);
                setRoomNodes(nodes);
            }
            loadStats();
        } catch (error: any) {
            addToast(error?.message || '保存记忆失败', 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleSaveEmbeddingConfig = () => {
        updateMemoryPalaceConfig({
            embedding: {
                baseUrl: embUrl.trim(),
                apiKey: embKey.trim(),
                model: embModel.trim() || 'BAAI/bge-m3',
                dimensions: embDimensions || 1024,
            },
        });
        // 同步到当前角色的 embeddingConfig（兼容已有的 injectMemoryPalace 调用）
        if (char) {
            updateCharacter(char.id, {
                embeddingConfig: {
                    baseUrl: embUrl.trim(),
                    apiKey: embKey.trim(),
                    model: embModel.trim() || 'BAAI/bge-m3',
                    dimensions: embDimensions || 1024,
                },
            } as any);
        }
        setConfigSaved(true);
        setTimeout(() => setConfigSaved(false), 2000);
    };

    const handleSaveRerankConfig = () => {
        updateMemoryPalaceConfig({
            rerank: {
                enabled: rrEnabled,
                baseUrl: rrUrl.trim(),
                apiKey: rrKey.trim(),
                model: rrModel.trim() || 'BAAI/bge-reranker-v2-m3',
                topN: Math.max(1, Math.min(20, rrTopN || 5)),
            },
        });
        setRrSaved(true);
        setTimeout(() => setRrSaved(false), 2000);
    };

    const updateAccommodation = (key: keyof CharacterAccommodationPolicy, value: number) => {
        if (!char) return;
        updateCharacter(char.id, {
            interactionAccommodation: {
                ...DEFAULT_CHARACTER_ACCOMMODATION,
                ...(char.interactionAccommodation || {}),
                [key]: value,
            },
        });
    };

    const handleSaveLightApi = () => {
        const api = {
            baseUrl: lightUrl.trim(),
            apiKey: lightKey.trim(),
            model: lightModel.trim(),
        };
        // 只写全局 lightLLM；与情绪 API（emotionConfig.api）完全独立，互不影响。
        updateMemoryPalaceConfig({ lightLLM: api });
        setLightSaved(true);
        setTimeout(() => setLightSaved(false), 2000);
    };

    const handleSwitchChar = (id: string) => {
        setActiveCharacterId(id);
        setShowCharPicker(false);
        setView('palace');
        setSelectedRoom(null);
        setSelectedNode(null);
    };

    // 切换"记忆宫殿"总开关（picker 卡片上）
    const handleTogglePalaceFromPicker = (charId: string, on: boolean) => {
        trackEvent('开启记忆宫殿', { enabled: on ? 'on' : 'off' });
        if (on) {
            updateCharacter(charId, { memoryPalaceEnabled: true } as any);
        } else {
            // 关闭 palace 必然连带关闭全自动记忆；同时清空残留的向量召回注入，
            // 否则旧的 memoryPalaceInjection 会被 saveCharacter 持久化并继续注入 prompt。
            updateCharacter(charId, {
                memoryPalaceEnabled: false,
                autoArchiveEnabled: false,
                memoryPalaceInjection: undefined,
                contextRangeMode: 'manual',
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            } as any);
        }
    };

    // 切换"全自动记忆"（原 autoArchive）开关：复用原 Character.tsx 中的追平逻辑
    const handleToggleAutoArchiveFromPicker = async (charId: string, on: boolean): Promise<void> => {
        trackEvent('开启全自动记忆', { enabled: on ? 'on' : 'off' });
        const target = characters.find(c => c.id === charId);
        if (!target) return;

        if (!on) {
            updateCharacter(charId, {
                autoArchiveEnabled: false,
                contextRangeMode: 'manual',
                contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            } as any);
            addToast('已关闭全自动记忆（palace 向量化仍在正常运行）', 'info');
            return;
        }

        if (!(target as any).memoryPalaceEnabled) {
            addToast('请先启用记忆宫殿再打开全自动记忆', 'error');
            return;
        }
        const mpEmb = memoryPalaceConfig?.embedding;
        const mpLLM = memoryPalaceConfig?.lightLLM;
        if (!mpEmb?.baseUrl || !mpEmb?.apiKey || !mpLLM?.baseUrl || !mpLLM?.apiKey) {
            addToast('请先在记忆宫殿设置中配置 Embedding + 副 API', 'error');
            return;
        }

        updateCharacter(charId, {
            autoArchiveEnabled: true,
            contextRangeMode: 'adaptive',
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
            contextLimit: DEFAULT_MANUAL_CONTEXT_LIMIT,
            contextUserStartMessageId: undefined,
        } as any);

        // 统计未同步消息数并决定是否立即追平历史
        // 口径必须和 pipeline 的缓冲区定义一致：排除该角色档位指定的热区，
        // 否则会把"永远不会被处理"的热区也算成未同步，欺骗用户去点立即追平。
        const { getMemoryPalaceUnprocessedBufferCount } = await import('../utils/memoryPalace/pipeline');
        const unprocessedCount = await getMemoryPalaceUnprocessedBufferCount(charId);

        if (unprocessedCount < 10) {
            addToast('全自动记忆已开启（历史消息都已同步）', 'success');
            return;
        }

        const minutes = Math.max(1, Math.ceil(unprocessedCount / 300));
        // 弹出好看的确认弹窗（替代原生 confirm）
        setAutoArchiveConfirm({
            charId,
            charName: target.name,
            unprocessedCount,
            minutes,
            mpEmb,
            mpLLM,
        });
    };

    const saveCharacterWaterline = (
        target: CharacterProfile,
        nextConfig: CharacterProfile['memoryPalaceWaterline'],
    ) => {
        const before = resolveMemoryPalaceWaterline(target.memoryPalaceWaterline);
        const after = resolveMemoryPalaceWaterline(nextConfig);
        updateCharacter(target.id, { memoryPalaceWaterline: nextConfig });

        const faster = after.hotZoneSize <= before.hotZoneSize
            && after.bufferThreshold <= before.bufferThreshold
            && (after.hotZoneSize < before.hotZoneSize || after.bufferThreshold < before.bufferThreshold);
        const slower = after.hotZoneSize >= before.hotZoneSize
            && after.bufferThreshold >= before.bufferThreshold
            && (after.hotZoneSize > before.hotZoneSize || after.bufferThreshold > before.bufferThreshold);
        if (faster) {
            addToast('已调快：下次达到新阈值时开始整理，成功前不会隐藏原文', 'success');
        } else if (slower) {
            addToast('已调慢：旧水位不会倒退，原文窗口会随新对话逐渐变长', 'success');
        } else {
            addToast('已保存这个角色的记忆处理节奏', 'success');
        }
    };

    const handleWaterlinePresetChange = (
        target: CharacterProfile,
        preset: MemoryPalaceWaterlinePreset,
    ) => {
        if (preset === 'custom') {
            const current = resolveMemoryPalaceWaterline(target.memoryPalaceWaterline);
            saveCharacterWaterline(target, makeCustomMemoryPalaceWaterline(
                current.hotZoneSize,
                current.bufferThreshold,
            ));
            return;
        }
        saveCharacterWaterline(target, { preset });
    };

    const handleSaveCustomWaterline = (
        target: CharacterProfile,
        hotZoneSize: number,
        bufferThreshold: number,
    ) => {
        saveCharacterWaterline(target, makeCustomMemoryPalaceWaterline(hotZoneSize, bufferThreshold));
    };

    // 全自动记忆：用户点「立即追平」后跑的循环逻辑
    const runAutoArchiveCatchUp = async (params: {
        charId: string;
        charName: string;
        unprocessedCount: number;
        mpEmb: any;
        mpLLM: any;
    }) => {
        const { charId, charName, unprocessedCount, mpEmb, mpLLM } = params;
        const target = characters.find(c => c.id === charId);
        if (!target) return;

        const {
            getMemoryPalaceHighWaterMark,
            getMemoryPalaceUnprocessedBufferCount,
            processNewMessages,
            mergePalaceFragmentsIntoMemories,
        } = await import('../utils/memoryPalace/pipeline');

        setAutoArchiveSyncingId(charId);
        setAutoArchiveSyncProgress(`准备中... (${unprocessedCount} 条)`);
        try {
            const MAX_ROUNDS = 50;
            let accumulatedMemories = (target as any).memories ? [...(target as any).memories] : [];
            let latestHideBefore = (target as any).hideBeforeMessageId;
            let totalProcessed = 0;

            for (let round = 1; round <= MAX_ROUNDS; round++) {
                const curHwm = getMemoryPalaceHighWaterMark(charId);
                // 用 pipeline 的真实缓冲区口径（排除该角色档位的热区），避免把热区
                // 当未同步反复重试——下面的 force=true 调用其实也只会处理缓冲区，
                // 用同一口径循环才能正确收敛。
                const remaining = await getMemoryPalaceUnprocessedBufferCount(charId);
                if (remaining < 10) break;
                setAutoArchiveSyncProgress(`第 ${round} 轮：剩余 ${remaining} 条`);

                // processNewMessages 忽略首个参数（内部直接从 DB 加载），传 [] 即可
                const result = await processNewMessages([], charId, charName, mpEmb, mpLLM, userProfile.name, true);

                // 软跳过：缓冲区没到阈值 / 热区还没被挤出 / 已有任务在跑 —— 不是 palace 失败
                if (result?.skipReason) {
                    if (result.skipReason !== 'lock') {
                        addToast('当前聊天不足以触发总结，请保持这个状态聊天~', 'info');
                    }
                    break;
                }

                if (result?.autoArchive) {
                    accumulatedMemories = mergePalaceFragmentsIntoMemories(accumulatedMemories, result.autoArchive.fragments);
                    latestHideBefore = result.autoArchive.hideBeforeMessageId;
                }

                const newHwm = getMemoryPalaceHighWaterMark(charId);
                if (newHwm <= curHwm) {
                    addToast('追平中断：palace 处理失败，请检查副 API 配置', 'error');
                    break;
                }
                totalProcessed += result?.processedMessages || 0;
            }

            updateCharacter(charId, { memories: accumulatedMemories, hideBeforeMessageId: latestHideBefore } as any);
            addToast(`历史追平完成，处理了 ${totalProcessed} 条消息`, 'success');
        } catch (e: any) {
            addToast(`追平失败：${e?.message || '未知错误'}（开关保持开启，后续会按常规进度处理）`, 'error');
        } finally {
            setAutoArchiveSyncingId(null);
            setAutoArchiveSyncProgress('');
        }
    };

    // 远程向量：测试连接
    const handleTestRemoteVector = async () => {
        setRvTesting(true);
        setRvTestResult('');
        try {
            const { testConnection } = await import('../utils/memoryPalace/supabaseVector');
            const result = await testConnection({ enabled: true, supabaseUrl: rvUrl, supabaseAnonKey: rvKey, initialized: false });
            if (result.ok && result.tableExists) setRvTestResult('[ok]' + result.message);
            else if (result.ok) setRvTestResult('[warn]' + result.message);
            else setRvTestResult('[err]' + result.message);
        } catch (e: any) { setRvTestResult('[err]' + e.message); }
        setRvTesting(false);
    };

    // 远程向量：保存配置
    const handleSaveRemoteVector = () => {
        const initialized = rvTestResult.startsWith('[ok]');
        updateRemoteVectorConfig({ enabled: true, supabaseUrl: rvUrl, supabaseAnonKey: rvKey, initialized });
        addToast('远程向量存储配置已保存', 'success');
    };

    // 远程向量：关闭
    const handleDisableRemoteVector = () => {
        updateRemoteVectorConfig({ enabled: false, initialized: false });
        addToast('远程向量存储已关闭', 'info');
    };

    // 远程向量：同步本地到远程
    const handleSyncToRemote = async () => {
        setRvSyncing(true);
        trackEvent('同步记忆向量到云端');
        try {
            const { syncLocalToRemote } = await import('../utils/memoryPalace/supabaseVector');
            const { MemoryNodeDB } = await import('../utils/memoryPalace/db');
            const result = await syncLocalToRemote(
                remoteVectorConfig,
                async () => {
                    const allVectors = await (await import('../utils/db')).openDB().then(db => new Promise<any[]>((resolve, reject) => {
                        const tx = db.transaction('memory_vectors', 'readonly');
                        const req = tx.objectStore('memory_vectors').getAll();
                        req.onsuccess = () => resolve(req.result || []);
                        req.onerror = () => reject(req.error);
                    }));
                    const items = [];
                    for (const v of allVectors) {
                        const node = await MemoryNodeDB.getById(v.memoryId);
                        if (node) items.push({ memoryId: v.memoryId, charId: node.charId, vector: v.vector, node, dimensions: v.dimensions, model: v.model });
                    }
                    return items;
                },
                () => {},
            );
            addToast(`同步完成: ${result.synced} 条成功, ${result.failed} 条失败`, result.failed > 0 ? 'error' : 'success');
        } catch (e: any) { addToast(`同步失败: ${e.message}`, 'error'); }
        setRvSyncing(false);
    };

    // 远程向量：复制初始化 SQL
    const handleCopyInitSQL = async () => {
        try {
            const { INIT_SQL } = await import('../utils/memoryPalace/supabaseVector');
            await navigator.clipboard.writeText(INIT_SQL).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = INIT_SQL;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            });
            addToast('SQL 已复制到剪贴板', 'success');
        } catch { addToast('复制失败', 'error'); }
    };

    // ─── 手动总结与向量化（保底机制） ───────────────────────
    // 打开区间选择弹窗：加载该角色全部聊天记录（含已被自动总结过的）
    const openRangeModal = async () => {
        if (!char) return;
        trackEvent('打开手动区间总结面板');
        setRangeModalOpen(true);
        setRangeLoading(true);
        setRangeResult(null);
        setRangeResultData(null);
        setRangeProgress('');
        setRangeStartId(null);
        setRangeEndId(null);
        setRangePendingId(null);
        setRangeQuery('');
        setRangeCursor({});
        setRangePage(0);
        setRangeMessages([]);
    };

    // 点选一条消息：先进入"待确认"，由用户再点[设为起点]/[设为终点]，避免误触
    const onTapRangeMessage = (id: number) => {
        setRangePendingId(prev => prev === id ? null : id); // 再点同一条 = 收起菜单
    };
    // 从待确认菜单里确认这条是起点 / 终点
    const confirmRangeEndpoint = (id: number, which: 'start' | 'end') => {
        if (which === 'start') setRangeStartId(id);
        else setRangeEndId(id);
        setRangePendingId(null);
    };

    // 跑一次区间总结：调 processMessageRange，全程不碰水位线
    const runRangeSummary = async () => {
        if (!char || rangeRunning) return;
        if (rangeStartId == null || rangeEndId == null) {
            addToast('请先点选起点和终点', 'info');
            return;
        }
        const emb = memoryPalaceConfig.embedding;
        const llm = memoryPalaceConfig.lightLLM;
        if (!emb?.baseUrl || !emb?.apiKey) {
            addToast('请先配置 Embedding API', 'error');
            return;
        }
        if (!llm?.baseUrl || !llm?.apiKey) {
            addToast('请先配置副 API（用于 LLM 记忆提取）', 'error');
            return;
        }

        const lo = Math.min(rangeStartId, rangeEndId);
        const hi = Math.max(rangeStartId, rangeEndId);

        setRangeRunning(true);
        setRangeResult(null);
        setRangeProgress('准备中...');
        trackEvent('运行手动区间总结');
        try {
            const { processMessageRange } = await import('../utils/memoryPalace/pipeline');
            const r = await processMessageRange(
                char.id, char.name, emb, llm, lo, hi, userProfile?.name || '',
                (s) => setRangeProgress(s),
            );
            if (r.error === 'lock') {
                setRangeResult('[err]有其它记忆任务正在运行，请稍后再试');
            } else if (r.error === 'empty') {
                setRangeResult('[err]选定区间没有可处理的消息');
            } else if (r.error === 'no_memories') {
                setRangeResult('[warn]这段对话没有提取出新记忆（可能内容太碎，或都已存在于记忆里）');
            } else if (r.error) {
                setRangeResult(`[err]总结失败：${r.error}`);
            } else {
                setRangeResult(`[ok]完成！新增 ${r.stored} 条记忆${r.skipped > 0 ? `，${r.skipped} 条因重复跳过` : ''}（处理了 ${r.processedMessages} 条消息，未改动水位线）`);
                // 弹出"记忆整理完成"结果弹窗（逐条列出新增内容，和水位线总结一致）
                setRangeResultData(r);
                // 复位选择，避免误点再跑同一段
                setRangeStartId(null);
                setRangeEndId(null);
                setRangePendingId(null);
            }
            loadStats();
        } catch (e: any) {
            setRangeResult(`[err]总结失败：${e?.message || e}`);
        } finally {
            setRangeRunning(false);
            setRangeProgress('');
        }
    };

    const handleMigrate = async () => {
        if (!char || migrating) return;
        const emb = memoryPalaceConfig.embedding;
        if (!emb?.baseUrl || !emb?.apiKey) {
            setMigrationResult('[err]请先配置 Embedding API');
            return;
        }

        const oldMemories = char.memories || [];
        if (oldMemories.length === 0) {
            setMigrationResult('没有旧记忆可以迁移');
            return;
        }

        const lightApi = memoryPalaceConfig.lightLLM;
        if (!lightApi?.baseUrl) {
            setMigrationResult('[err]需要配置副 API（轻量副模型），用于 LLM 记忆提取');
            return;
        }

        setMigrating(true);
        setMigrationResult(null);

        try {
            const { ContextBuilder } = await import('../utils/context');
            const charContext = ContextBuilder.buildCoreContext(char, userProfile, false);
            // selectedMonths 现在存的是分块 key（如 "2026-03 上旬"）
            const monthsToProcess = selectedMonths.size > 0 ? Array.from(selectedMonths) : undefined;
            const result = await migrateOldMemories(
                char.id,
                char.name,
                oldMemories,
                char.refinedMemories,
                lightApi,
                emb,
                (p) => setMigrationProgress(p),
                charContext,
                monthsToProcess,
                userProfile?.name,
                remoteVectorConfig,
            );
            setMigrationResult(`[ok]迁移完成：${result.months} 个月 → ${result.migrated} 条记忆，${result.skipped} 条去重跳过`);
            loadStats(); // 刷新数据
        } catch (err: any) {
            setMigrationResult(`[err]迁移失败：${err.message}`);
        } finally {
            setMigrating(false);
            setMigrationProgress(null);
        }
    };

    const handleDigest = async () => {
        if (!char || digesting) return;
        trackEvent('手动触发认知消化');
        const lightApi = memoryPalaceConfig.lightLLM;
        if (!lightApi?.baseUrl) {
            setDigestResult('[err]请先在设置中配置副 API');
            return;
        }

        setDigesting(true);
        setDigestResult(null);

        try {
            const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
            const embApi = memoryPalaceConfig.embedding;
            const result = await runCognitiveDigestion(
                char.id, char.name, persona, lightApi, true, userProfile?.name, embApi,
                (stage) => setDigestResult(stage), // 审视→回填续传→整理门牌, 逐阶段刷给用户看
            );
            if (!result) {
                setDigestResult('没有需要消化的内容');
            } else {
                // 自我领悟的归宿已改为 self_room 门牌（digestion 内部提交），
                // 不再追加 char.selfInsights；这里只做结果摘要展示
                const parts: string[] = [];
                if (result.resolved.length) parts.push(`${result.resolved.length} 条困惑化解`);
                if (result.deepened.length) parts.push(`${result.deepened.length} 条创伤加深`);
                if (result.faded.length) parts.push(`${result.faded.length} 条淡忘`);
                if (result.fulfilled.length) parts.push(`${result.fulfilled.length} 个期盼实现`);
                if (result.disappointed.length) parts.push(`${result.disappointed.length} 个期盼落空`);
                if (result.internalized.length) parts.push(`${result.internalized.length} 条知识内化`);
                if (result.synthesizedUser.length) parts.push(`${result.synthesizedUser.length} 条用户认知整合`);
                if (result.selfInsights.length) parts.push(`${result.selfInsights.length} 条自我领悟`);
                if (result.selfConfused.length) parts.push(`${result.selfConfused.length} 条新困惑`);
                if (result.worries?.length) parts.push(`${result.worries.length} 条回看担忧`);
                if (result.aspirations?.length) parts.push(`${result.aspirations.length} 个新期盼`);
                if (result.distilled?.length) parts.push(`${result.distilled.length} 条沉淀到门牌`);
                if (result.plateUpdated?.length) parts.push(`${result.plateUpdated.length} 块门牌更新`);
                // 门牌整理是交给云端跑的（页面关着也能跑完），交出去就返回，门牌得过几分钟
                // 才动。手动消化时用户刚盯着「正在整理门牌…」一路看到这里，不说这一句的话
                // 他看到的就是整理阶段一闪而过、门牌纹丝不动，跟没跑过一模一样。
                if (result.plateCloudPending) parts.push('门牌整理在云端跑，结果晚几分钟落地');
                setDigestResult(parts.length > 0 ? `[ok]${parts.join('，')}` : '没有变化');
            }
            loadStats();
            // 消化日志面板开着的话，刷新出刚落的这条报告
            if (digestReports !== null) {
                try { setDigestReports(await DigestReportDB.getByCharId(char.id)); } catch { /* ignore */ }
            }
        } catch (err: any) {
            setDigestResult(`[err]消化失败：${err.message}`);
        } finally {
            setDigesting(false);
        }
    };

    /** 彻底删除一条记忆（node + vector + links + EventBox 成员引用 + 远程同步） */
    const deleteMemory = async (nodeId: string) => {
        // 先从 EventBox 中移除（若属于某盒）
        try { await removeMemoryFromBox(nodeId); } catch { /* ignore */ }
        // 删关联
        const links = await MemoryLinkDB.getByNodeId(nodeId);
        for (const link of links) {
            await MemoryLinkDB.delete(link.id);
        }
        // 删向量（本地）
        const { MemoryVectorDB } = await import('../utils/memoryPalace');
        await MemoryVectorDB.delete(nodeId);
        // 删向量（远程同步）
        if (remoteVectorConfig?.enabled && remoteVectorConfig.initialized) {
            import('../utils/memoryPalace/supabaseVector').then(({ deleteVector }) =>
                deleteVector(remoteVectorConfig, nodeId).catch(() => {})
            );
        }
        // 删节点
        await MemoryNodeDB.delete(nodeId);
    };

    /** 批量删除选中的记忆 */
    const handleBatchDelete = async () => {
        if (selectedIds.size === 0 || !char) return;
        setDeleting(true);
        try {
            for (const id of selectedIds) {
                await deleteMemory(id);
            }
            // 刷新房间数据
            if (selectedRoom) {
                const nodes = await MemoryNodeDB.getByRoom(char.id, selectedRoom);
                nodes.sort((a: MemoryNode, b: MemoryNode) => b.createdAt - a.createdAt);
                setRoomNodes(nodes);
            }
            setSelectedIds(new Set());
            setSelectMode(false);
            loadStats();
        } finally {
            setDeleting(false);
        }
    };

    /** 删除单条记忆并返回上一视图 */
    const handleDeleteSingle = async (nodeId: string) => {
        setDeleting(true);
        try {
            await deleteMemory(nodeId);
            setSelectedNode(null);
            setView(prevView);
            if (prevView === 'room' && selectedRoom && char) {
                const nodes = await MemoryNodeDB.getByRoom(char.id, selectedRoom);
                nodes.sort((a: MemoryNode, b: MemoryNode) => b.createdAt - a.createdAt);
                setRoomNodes(nodes);
            } else if (prevView === 'all' && char) {
                const nodes = await MemoryNodeDB.getByCharId(char.id);
                setAllNodes(nodes);
            } else if (prevView === 'boxes' && char) {
                const boxes = await EventBoxDB.getByCharId(char.id);
                boxes.sort((a, b) => b.updatedAt - a.updatedAt);
                setAllBoxes(boxes);
                setBoxMembers({});
                setExpandedBoxId(null);
            }
            loadStats();
        } finally {
            setDeleting(false);
        }
    };

    /** 清除所有已迁移数据 */
    /** 一键清空记忆宫殿（本地 + 可选云端）。双重确认后执行。 */
    const handleWipeAll = async (includeRemote: boolean) => {
        const firstPrompt = includeRemote
            ? '即将清空【本地 + 云端 Supabase】所有记忆宫殿数据，包括：\n\n' +
              '- 所有角色的记忆节点、向量、关联、事件盒\n- 高水位标记\n- 云端 memory_vectors 全表\n\n' +
              '此操作不可撤销。确定继续？'
            : '即将清空【本地】所有记忆宫殿数据（云端保留）。\n\n' +
              '包括所有角色的记忆节点、向量、关联、事件盒、高水位标记。\n\n' +
              '此操作不可撤销。确定继续？';
        if (!confirm(firstPrompt)) return;
        if (!confirm('再次确认：真的要清空？')) return;

        setWiping(true);
        setWipeResult(null);
        trackEvent('清空全部记忆数据', { scope: includeRemote ? 'all' : 'local' });
        try {
            const result = await wipeAllMemoryPalace({
                remoteConfig: includeRemote ? remoteVectorConfig : undefined,
                skipRemote: !includeRemote,
            });
            // 友好分项：记忆节点才是"一条记忆"，其余是衍生数据
            const STORE_LABELS: Record<string, string> = {
                memory_nodes: '记忆',
                memory_vectors: '向量',
                memory_links: '关联',
                memory_batches: '批次',
                anticipations: '期盼',
                event_boxes: '事件盒',
            };
            const parts: string[] = [];
            for (const [store, count] of Object.entries(result.local)) {
                if (count > 0) parts.push(`${STORE_LABELS[store] || store} ${count}`);
            }
            const breakdown = parts.length > 0 ? `（${parts.join('、')}）` : '';
            const msg = `本地已清空${breakdown}；高水位 ${result.highWatermarks} 条`
                + (result.remoteAttempted ? `；云端向量 ${result.remote} 行` : '；云端未清');
            setWipeResult(msg);
            await loadStats();
        } catch (e: any) {
            setWipeResult(`[err]清空失败：${e?.message || e}`);
        } finally {
            setWiping(false);
        }
    };

    /** 导出当前角色的记忆宫殿为 JSON 文件（接入外置记忆库）。
     *  含记忆节点 / 事件盒 / 期盼，不含向量（向量与 embedding 模型强绑定，外置库无意义）。 */
    const handleExportMemories = async () => {
        if (!char) return;
        setExporting(true);
        setExportResult(null);
        try {
            const data = await exportMemoryPalace(
                [{ id: char.id, name: char.name }],
                { includeVectors: exportWithVectors },
            );
            const c = data.characters[0]?.counts;
            const nodeCount = c?.nodes ?? 0;
            if (nodeCount === 0) {
                setExportResult('[warn]当前角色还没有记忆宫殿节点，没什么可导出的');
                return;
            }
            // 导出前明文密钥体检 + 二次确认（记忆宫殿正常不含密钥 → 提示「安全，可分享」）。
            if (!(await confirmExportSafety(data))) return;
            const json = JSON.stringify(data, null, 2);
            const safeName = (char.name || 'character').replace(/[\\/:*?"<>|]/g, '_');
            const fileName = `${safeName}_记忆宫殿_${new Date().toISOString().slice(0, 10)}.json`;
            const exportDisposition = await shareOrDownloadFile({
                content: json,
                fileName,
                mimeType: 'application/json;charset=utf-8',
                shareTitle: `${char.name}的记忆宫殿`,
            });
            trackEvent('导出记忆宫殿备份');
            const vecPart = exportWithVectors ? `、${c.vectors} 条向量` : '';
            setExportResult(`[ok]${exportDisposition === 'shared' ? '已打开分享面板：' : '已导出 '}${nodeCount} 条记忆、${c.eventBoxes} 个事件盒、${c.anticipations} 个期盼${vecPart}`);
        } catch (e: any) {
            setExportResult(`[err]导出失败：${e?.message || e}`);
        } finally {
            setExporting(false);
        }
    };

    /** 选了导入文件后：解析 JSON → 校验 → 合并进当前角色的记忆宫殿。 */
    const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const fileObj = e.target.files?.[0];
        // 清空 input，方便重复选同一个文件也能再次触发 onChange
        if (importInputRef.current) importInputRef.current.value = '';
        if (!fileObj || !char) return;
        setImporting(true);
        setImportResult(null);
        try {
            const text = await fileObj.text();
            const data = JSON.parse(text);
            if (!isMemoryPalaceExportFile(data)) {
                setImportResult('[err]这不是 SullyOS 记忆宫殿导出文件');
                return;
            }
            const totalNodes = data.characters.reduce((s, c) => s + (c.nodes?.length || 0), 0);
            const hadVectors = data.includeVectors;
            if (!confirm(
                `即将把文件里的 ${totalNodes} 条记忆合并进【${char.name}】的记忆宫殿。\n\n`
                + `· 不会覆盖现有记忆，是追加合并（重复导入会得到多份副本）。\n`
                + (hadVectors ? '· 文件含向量，将一并导入。\n' : '· 文件不含向量，导入后这些记忆需重建向量才能被语义检索。\n')
                + `\n确定继续？`
            )) return;

            const result = await importMemoryPalace(data, char.id);
            trackEvent('导入记忆宫殿备份');
            const vecPart = result.vectors > 0 ? `、${result.vectors} 条向量` : '';
            const platePart = result.roomPlateEntries > 0 ? `、${result.roomPlateEntries} 条门牌认知` : '';
            setImportResult(
                `[ok]已导入 ${result.nodes} 条记忆、${result.eventBoxes} 个事件盒、${result.anticipations} 个期盼${vecPart}${platePart}`
                + (hadVectors ? '' : '（无向量，建议到「全局设置」重建向量后再用语义检索）')
            );
            await loadStats();
        } catch (err: any) {
            setImportResult(`[err]导入失败：${err?.message || err}`);
        } finally {
            setImporting(false);
        }
    };

    /** 外部原始文本 → 保真清洗 → 向量宫殿 + 神经链接传统档案双写。 */
    const handleExternalMemoryImport = async () => {
        if (!char || externalImporting) return;
        const text = externalMemoryText.trim();
        if (!text) {
            setExternalImportResult('[err]请先粘贴要搬家的记忆文本');
            return;
        }
        if (externalLengthInfo.overLimit) {
            setExternalImportResult(`[err]${getExternalMemoryOverLimitMessage(externalMemoryText)}`);
            return;
        }
        const emb = memoryPalaceConfig.embedding;
        const llm = memoryPalaceConfig.lightLLM;
        if (!emb?.baseUrl || !emb?.apiKey || !emb?.model) {
            setExternalImportResult('[err]请先在记忆宫殿设置中配置 Embedding API');
            return;
        }
        if (!llm?.baseUrl || !llm?.apiKey || !llm?.model) {
            setExternalImportResult('[err]请先在记忆宫殿设置中配置副 API');
            return;
        }

        const target = { id: char.id, name: char.name };
        setExternalImporting(true);
        setExternalImportResult(null);
        setExternalImportProgress('准备搬家：只整理时间和结构，不压缩内容…');
        try {
            const {
                importExternalMemoryText,
                mergePalaceFragmentsIntoMemories,
            } = await import('../utils/memoryPalace/pipeline');
            const result = await importExternalMemoryText(
                text,
                target.id,
                target.name,
                emb,
                llm,
                userProfile?.name || '',
                stage => setExternalImportProgress(stage),
            );
            if (result.error === 'lock') {
                setExternalImportResult('[err]这个角色已有其它记忆任务正在运行，请稍后再试');
            } else if (result.error === 'no_memories') {
                setExternalImportResult('[warn]没有整理出可导入的记忆，请检查原文或副 API 返回');
            } else if (result.error) {
                setExternalImportResult(`[err]搬家失败：${result.error}`);
            } else {
                // 与全自动总结水位线共用同一个桥接器：把本次真正写入向量库的
                // 同一批节点按日期合并进角色 memories。外部导入没有消息 ID，
                // 因此只双写记忆，不推进 hideBeforeMessageId / 聊天水位线。
                setExternalImportProgress(`正在把同一批记忆同步到【${target.name}】的神经链接档案…`);
                const latestMemories = characters.find(c => c.id === target.id)?.memories || [];
                const mergedMemories = mergePalaceFragmentsIntoMemories(
                    latestMemories,
                    result.archiveFragments,
                );
                updateCharacter(target.id, { memories: mergedMemories });
                setExternalImportResult(
                    `[ok]已放入【${target.name}】：${result.stored} 条向量记忆；同一批内容已同步到神经链接档案`
                    + (result.skipped ? `，${result.skipped} 条重复内容已跳过` : ''),
                );
                setExternalMemoryText('');
                await loadStats();
            }
        } catch (error: any) {
            setExternalImportResult(`[err]搬家失败：${error?.message || error}`);
        } finally {
            setExternalImporting(false);
            setExternalImportProgress('');
        }
    };

    const handleClearMigrated = async () => {
        if (!char) return;
        setDeleting(true);
        try {
            const allNodes = await MemoryNodeDB.getByCharId(char.id);
            const migrated = allNodes.filter(n => n.boxId?.startsWith('migrated_'));
            for (const node of migrated) {
                await deleteMemory(node.id);
            }
            setMigrationResult(`已清除 ${migrated.length} 条迁移数据`);
            loadStats();
        } finally {
            setDeleting(false);
        }
    };

    const toggleSelect = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // ─── 入口页：选角色（picker）─ view='picker' 或未选择 activeCharacterId 时渲染 ─────
    //     退出按钮在这里才真正关闭 App；其它 view 的"← 返回"只回到这一层

    if (view === 'picker' || (!char && view !== 'globalSettings')) {
        return (
            <div
                style={{
                    paddingLeft: 20, paddingRight: 20, paddingBottom: 28, paddingTop: SAFE_PAD_TOP,
                    maxHeight: '100%', overflowY: 'auto',
                    background: 'linear-gradient(180deg, #faf5ff 0%, #f5f3ff 40%, #ffffff 100%)',
                    minHeight: '100%',
                    position: 'relative',
                }}
            >
                {/* 装饰性背景光斑 */}
                <div
                    style={{
                        position: 'absolute', top: -40, right: -40, width: 220, height: 220,
                        borderRadius: '50%',
                        background: 'radial-gradient(circle, rgba(167,139,250,0.22) 0%, rgba(167,139,250,0) 70%)',
                        pointerEvents: 'none',
                    }}
                />
                <div
                    style={{
                        position: 'absolute', top: 160, left: -60, width: 200, height: 200,
                        borderRadius: '50%',
                        background: 'radial-gradient(circle, rgba(236,72,153,0.14) 0%, rgba(236,72,153,0) 70%)',
                        pointerEvents: 'none',
                    }}
                />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, position: 'relative', zIndex: 1 }}>
                    <div
                        onClick={closeApp}
                        style={{
                            fontSize: 12, color: '#7c3aed', cursor: 'pointer',
                            padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: 6,
                            borderRadius: 999, background: 'rgba(124,58,237,0.08)',
                            border: '1px solid rgba(124,58,237,0.15)', fontWeight: 600,
                            letterSpacing: '0.04em',
                        }}
                    >
                        <Icon name="arrow-left" size={11} />
                        <span>退出</span>
                    </div>
                    <div
                        onClick={() => setView('globalSettings')}
                        title="记忆宫殿全局配置（API 等）"
                        style={{
                            position: 'relative',
                            width: 36, height: 36, borderRadius: 12,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer',
                            background: hasEmbeddingConfig
                                ? 'rgba(255,255,255,0.8)'
                                : 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
                            border: hasEmbeddingConfig
                                ? '1px solid rgba(124,58,237,0.15)'
                                : '1.5px solid #f59e0b',
                            color: hasEmbeddingConfig ? '#7c3aed' : '#b45309',
                            boxShadow: hasEmbeddingConfig
                                ? '0 2px 6px rgba(124,58,237,0.08)'
                                : '0 0 0 3px rgba(245,158,11,0.15), 0 4px 10px rgba(245,158,11,0.2)',
                            animation: hasEmbeddingConfig ? undefined : 'pulse 2s ease-in-out infinite',
                        }}
                    >
                        <Icon name="settings" size={16} />
                        {!hasEmbeddingConfig && (
                            <span style={{
                                position: 'absolute', top: -3, right: -3,
                                width: 10, height: 10, borderRadius: '50%',
                                background: '#ef4444', border: '2px solid #fff',
                            }} />
                        )}
                    </div>
                </div>

                {/* Embedding 未配置高亮提醒 */}
                {!hasEmbeddingConfig && (
                    <div
                        onClick={() => setView('globalSettings')}
                        style={{
                            position: 'relative', zIndex: 1,
                            marginBottom: 20, padding: '12px 14px', borderRadius: 16,
                            background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
                            border: '1.5px solid #f59e0b',
                            cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 10,
                            boxShadow: '0 4px 14px rgba(245,158,11,0.2)',
                        }}
                    >
                        <span style={{
                            width: 32, height: 32, borderRadius: 10,
                            background: 'rgba(245,158,11,0.2)',
                            color: '#b45309',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            flexShrink: 0,
                        }}>
                            <Icon name="warning" size={16} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#78350f' }}>
                                未配置 Embedding API
                            </div>
                            <div style={{ fontSize: 10, color: '#92400e', marginTop: 2 }}>
                                点击此处进入全局配置 · 不配置则无法向量化
                            </div>
                        </div>
                        <span style={{ color: '#b45309', flexShrink: 0 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                        </span>
                    </div>
                )}

                {/* Hero 标题区 */}
                <div style={{ textAlign: 'center', marginBottom: 28, position: 'relative', zIndex: 1 }}>
                    <div
                        style={{
                            fontSize: 10, fontWeight: 700, letterSpacing: '0.42em',
                            color: '#a78bfa', marginBottom: 10, textTransform: 'uppercase',
                        }}
                    >
                        Memory Palace
                    </div>
                    <div
                        style={{
                            fontSize: 28, fontWeight: 800, color: '#1f1147',
                            letterSpacing: '-0.01em',
                            background: 'linear-gradient(135deg, #4c1d95 0%, #7c3aed 50%, #db2777 100%)',
                            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                            backgroundClip: 'text',
                            marginBottom: 6,
                        }}
                    >
                        记忆宫殿
                    </div>
                    <div style={{ fontSize: 12, color: '#8b5cf6', opacity: 0.8, letterSpacing: '0.04em' }}>
                        选择一个角色 · 开启 Ta 的七房间思维空间
                    </div>
                </div>

                {/* 分组筛选（没建分组时不渲染） */}
                <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                    value={selectGroupId} onChange={setSelectGroupId}
                    className="mb-4 relative z-[1]" />
                {characters.length === 0 ? (
                    <div
                        style={{
                            textAlign: 'center', color: '#9ca3af', fontSize: 13, marginTop: 40,
                            padding: 32, borderRadius: 24, background: 'rgba(255,255,255,0.6)',
                            border: '1px dashed #ddd6fe',
                            position: 'relative', zIndex: 1,
                        }}
                    >
                        还没有角色——去神经链接创建一个吧
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'relative', zIndex: 1 }}>
                        {filterCharactersByGroup(characters, characterGroups, selectGroupId).map(c => {
                            const isActive = c.id === activeCharacterId;
                            const palaceOn = !!(c as any).memoryPalaceEnabled;
                            const autoOn = !!(c as any).autoArchiveEnabled;
                            const syncing = autoArchiveSyncingId === c.id;

                            return (
                                <div
                                    key={c.id}
                                    style={{
                                        position: 'relative',
                                        borderRadius: 22,
                                        padding: 2,
                                        background: palaceOn
                                            ? 'linear-gradient(135deg, #a78bfa 0%, #ec4899 100%)'
                                            : 'linear-gradient(135deg, #e5e7eb 0%, #f3f4f6 100%)',
                                        boxShadow: palaceOn
                                            ? '0 10px 30px -8px rgba(167,139,250,0.35), 0 4px 12px rgba(236,72,153,0.12)'
                                            : '0 4px 14px rgba(15,23,42,0.05)',
                                        transition: 'all 0.3s ease',
                                    }}
                                >
                                    <div
                                        style={{
                                            borderRadius: 20,
                                            background: isActive
                                                ? 'linear-gradient(180deg, #ffffff 0%, #faf5ff 100%)'
                                                : '#ffffff',
                                            padding: 16,
                                            display: 'flex', flexDirection: 'column', gap: 12,
                                        }}
                                    >
                                        {/* 顶部：头像 + 姓名 + 进入按钮 */}
                                        <div
                                            style={{ display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }}
                                            onClick={() => handleSwitchChar(c.id)}
                                        >
                                            <div
                                                style={{
                                                    position: 'relative',
                                                    width: 56, height: 56, borderRadius: 18, overflow: 'hidden',
                                                    flexShrink: 0,
                                                    boxShadow: palaceOn
                                                        ? '0 0 0 2px #fff, 0 0 0 4px rgba(167,139,250,0.5), 0 6px 16px rgba(167,139,250,0.25)'
                                                        : '0 2px 8px rgba(15,23,42,0.08)',
                                                    background: '#f3f4f6',
                                                }}
                                            >
                                                <TokenImg value={c.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                {palaceOn && (
                                                    <div
                                                        style={{
                                                            position: 'absolute', bottom: 2, right: 2,
                                                            width: 12, height: 12, borderRadius: '50%',
                                                            background: 'linear-gradient(135deg, #a78bfa, #ec4899)',
                                                            border: '2px solid #fff',
                                                            boxShadow: '0 0 6px rgba(167,139,250,0.6)',
                                                        }}
                                                    />
                                                )}
                                            </div>

                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div
                                                    style={{
                                                        fontSize: 16, fontWeight: 700, color: '#1f1147',
                                                        letterSpacing: '-0.01em', marginBottom: 3,
                                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    {c.name}
                                                </div>
                                                <div
                                                    style={{
                                                        fontSize: 10, fontWeight: 600, letterSpacing: '0.12em',
                                                        textTransform: 'uppercase',
                                                        color: palaceOn ? '#7c3aed' : '#9ca3af',
                                                    }}
                                                >
                                                    {palaceOn ? (syncing ? '同步中' : '已就绪') : '未启用'}
                                                </div>
                                            </div>

                                            {palaceOn && (
                                                <div
                                                    style={{
                                                        width: 34, height: 34, borderRadius: 12,
                                                        background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
                                                        color: '#fff',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        boxShadow: '0 4px 10px rgba(124,58,237,0.3)',
                                                    }}
                                                >
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
                                                </div>
                                            )}
                                        </div>

                                        {/* 分隔线 */}
                                        <div style={{ height: 1, background: 'linear-gradient(90deg, transparent, #ede9fe, transparent)' }} />

                                        {/* 开关区 */}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                            {/* 记忆宫殿开关 */}
                                            <div
                                                style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                                    padding: '6px 4px',
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                                                    <div
                                                        style={{
                                                            width: 30, height: 30, borderRadius: 10,
                                                            background: palaceOn
                                                                ? 'linear-gradient(135deg, rgba(167,139,250,0.2), rgba(236,72,153,0.15))'
                                                                : '#f3f4f6',
                                                            color: palaceOn ? '#7c3aed' : '#9ca3af',
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            flexShrink: 0,
                                                        }}
                                                    >
                                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="M12 2a9 9 0 0 0-9 9c0 3 1.5 5.5 4 7v3h10v-3c2.5-1.5 4-4 4-7a9 9 0 0 0-9-9Z" />
                                                            <path d="M9 22v-4M15 22v-4M12 12v6M9 15h6" />
                                                        </svg>
                                                    </div>
                                                    <div style={{ minWidth: 0, flex: 1 }}>
                                                        <div style={{ fontSize: 13, fontWeight: 700, color: '#1f1147' }}>
                                                            记忆宫殿
                                                        </div>
                                                        <div
                                                            style={{
                                                                fontSize: 10, color: '#9ca3af', marginTop: 1,
                                                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                            }}
                                                        >
                                                            七房间空间模型 · 向量检索
                                                        </div>
                                                    </div>
                                                </div>
                                                <label
                                                    style={{
                                                        position: 'relative', display: 'inline-block',
                                                        width: 42, height: 24, cursor: 'pointer', flexShrink: 0,
                                                    }}
                                                    onClick={e => e.stopPropagation()}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={palaceOn}
                                                        onChange={e => handleTogglePalaceFromPicker(c.id, e.target.checked)}
                                                        style={{ opacity: 0, width: 0, height: 0 }}
                                                    />
                                                    <span
                                                        style={{
                                                            position: 'absolute', inset: 0, borderRadius: 24,
                                                            background: palaceOn
                                                                ? 'linear-gradient(135deg, #a78bfa, #7c3aed)'
                                                                : '#e5e7eb',
                                                            transition: 'background 0.25s',
                                                            boxShadow: palaceOn
                                                                ? 'inset 0 1px 2px rgba(0,0,0,0.1), 0 2px 6px rgba(124,58,237,0.3)'
                                                                : 'inset 0 1px 2px rgba(0,0,0,0.05)',
                                                        }}
                                                    />
                                                    <span
                                                        style={{
                                                            position: 'absolute', top: 2, left: palaceOn ? 20 : 2,
                                                            width: 20, height: 20, borderRadius: '50%',
                                                            background: '#fff',
                                                            transition: 'left 0.25s',
                                                            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                                                        }}
                                                    />
                                                </label>
                                            </div>

                                            {/* 全自动记忆开关（依赖 palace） */}
                                            <div
                                                style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                                    padding: '6px 4px',
                                                    opacity: palaceOn ? 1 : 0.4,
                                                    pointerEvents: palaceOn ? 'auto' : 'none',
                                                    transition: 'opacity 0.25s',
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                                                    <div
                                                        style={{
                                                            width: 30, height: 30, borderRadius: 10,
                                                            background: autoOn && palaceOn
                                                                ? 'linear-gradient(135deg, rgba(236,72,153,0.2), rgba(251,146,60,0.15))'
                                                                : '#f3f4f6',
                                                            color: autoOn && palaceOn ? '#db2777' : '#9ca3af',
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            flexShrink: 0,
                                                        }}
                                                    >
                                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="M21 12a9 9 0 1 1-6.2-8.55" />
                                                            <path d="M21 4v5h-5" />
                                                            <path d="M12 7v5l3 2" />
                                                        </svg>
                                                    </div>
                                                    <div style={{ minWidth: 0, flex: 1 }}>
                                                        <div style={{ fontSize: 13, fontWeight: 700, color: '#1f1147' }}>
                                                            全自动记忆
                                                        </div>
                                                        <div
                                                            style={{
                                                                fontSize: 10, color: '#9ca3af', marginTop: 1,
                                                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                            }}
                                                        >
                                                            {syncing
                                                                ? autoArchiveSyncProgress || '追平中...'
                                                                : '自动归档 · 推水位线 · 隐藏已总结'}
                                                        </div>
                                                    </div>
                                                </div>
                                                <label
                                                    style={{
                                                        position: 'relative', display: 'inline-block',
                                                        width: 42, height: 24, cursor: syncing ? 'wait' : 'pointer', flexShrink: 0,
                                                    }}
                                                    onClick={e => e.stopPropagation()}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={autoOn}
                                                        disabled={syncing || !palaceOn}
                                                        onChange={e => handleToggleAutoArchiveFromPicker(c.id, e.target.checked)}
                                                        style={{ opacity: 0, width: 0, height: 0 }}
                                                    />
                                                    <span
                                                        style={{
                                                            position: 'absolute', inset: 0, borderRadius: 24,
                                                            background: autoOn
                                                                ? 'linear-gradient(135deg, #f472b6, #db2777)'
                                                                : '#e5e7eb',
                                                            transition: 'background 0.25s',
                                                            boxShadow: autoOn
                                                                ? 'inset 0 1px 2px rgba(0,0,0,0.1), 0 2px 6px rgba(219,39,119,0.3)'
                                                                : 'inset 0 1px 2px rgba(0,0,0,0.05)',
                                                            opacity: syncing ? 0.6 : 1,
                                                        }}
                                                    />
                                                    <span
                                                        style={{
                                                            position: 'absolute', top: 2, left: autoOn ? 20 : 2,
                                                            width: 20, height: 20, borderRadius: '50%',
                                                            background: '#fff',
                                                            transition: 'left 0.25s',
                                                            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
                                                        }}
                                                    />
                                                </label>
                                            </div>

                                            {palaceOn && autoOn && (
                                                <MemoryWaterlineEditor
                                                    character={c}
                                                    expanded={waterlineEditorCharId === c.id}
                                                    disabled={syncing}
                                                    onToggle={() => setWaterlineEditorCharId(current => current === c.id ? null : c.id)}
                                                    onPresetChange={preset => handleWaterlinePresetChange(c, preset)}
                                                    onSaveCustom={(hotZoneSize, bufferThreshold) => handleSaveCustomWaterline(
                                                        c,
                                                        hotZoneSize,
                                                        bufferThreshold,
                                                    )}
                                                />
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* 全自动记忆追平确认弹窗（替代原生 confirm） */}
                {autoArchiveConfirm && (
                    <div
                        style={{
                            position: 'fixed', inset: 0, zIndex: 200,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 24,
                            background: 'rgba(31,17,71,0.45)',
                            backdropFilter: 'blur(8px)',
                            WebkitBackdropFilter: 'blur(8px)',
                            animation: 'fade-in 0.2s ease-out',
                        }}
                        onClick={() => {
                            setAutoArchiveConfirm(null);
                            addToast('已开启全自动记忆，历史消息将按常规进度处理', 'info');
                        }}
                    >
                        <div
                            onClick={e => e.stopPropagation()}
                            style={{
                                width: '100%', maxWidth: 360,
                                borderRadius: 28, overflow: 'hidden',
                                background: 'linear-gradient(180deg, #ffffff 0%, #faf5ff 100%)',
                                boxShadow: '0 25px 60px -15px rgba(124,58,237,0.4), 0 10px 30px rgba(0,0,0,0.15)',
                                border: '1px solid rgba(167,139,250,0.25)',
                            }}
                        >
                            {/* Hero 头部 */}
                            <div
                                style={{
                                    padding: '26px 24px 20px',
                                    background: 'linear-gradient(135deg, rgba(167,139,250,0.12) 0%, rgba(236,72,153,0.08) 100%)',
                                    textAlign: 'center',
                                    position: 'relative',
                                }}
                            >
                                <div
                                    style={{
                                        width: 54, height: 54, borderRadius: 18,
                                        margin: '0 auto 12px',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
                                        color: '#fff',
                                        boxShadow: '0 8px 20px rgba(124,58,237,0.35)',
                                    }}
                                >
                                    <Icon name="sync" size={26} />
                                </div>
                                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.32em', color: '#a78bfa', textTransform: 'uppercase', marginBottom: 6 }}>
                                    Auto Memory
                                </div>
                                <div style={{ fontSize: 17, fontWeight: 800, color: '#1f1147', letterSpacing: '-0.01em' }}>
                                    全自动记忆已开启
                                </div>
                                <div style={{ fontSize: 12, color: '#7c3aed', marginTop: 4, opacity: 0.85 }}>
                                    {autoArchiveConfirm.charName} · 历史消息追平
                                </div>
                            </div>

                            {/* 数据卡片 */}
                            <div style={{ padding: '18px 24px 4px' }}>
                                <div
                                    style={{
                                        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10,
                                        marginBottom: 14,
                                    }}
                                >
                                    <div
                                        style={{
                                            padding: '12px 14px', borderRadius: 16,
                                            background: 'rgba(167,139,250,0.08)',
                                            border: '1px solid rgba(167,139,250,0.2)',
                                        }}
                                    >
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#a78bfa', letterSpacing: '0.16em', textTransform: 'uppercase' }}>未同步</div>
                                        <div style={{ fontSize: 22, fontWeight: 800, color: '#4c1d95', marginTop: 4, fontFamily: `'Space Grotesk', sans-serif`, lineHeight: 1 }}>
                                            {autoArchiveConfirm.unprocessedCount}
                                        </div>
                                        <div style={{ fontSize: 10, color: '#8b5cf6', marginTop: 2 }}>条历史消息</div>
                                    </div>
                                    <div
                                        style={{
                                            padding: '12px 14px', borderRadius: 16,
                                            background: 'rgba(236,72,153,0.08)',
                                            border: '1px solid rgba(236,72,153,0.2)',
                                        }}
                                    >
                                        <div style={{ fontSize: 9, fontWeight: 700, color: '#ec4899', letterSpacing: '0.16em', textTransform: 'uppercase' }}>预计</div>
                                        <div style={{ fontSize: 22, fontWeight: 800, color: '#9d174d', marginTop: 4, fontFamily: `'Space Grotesk', sans-serif`, lineHeight: 1 }}>
                                            ~{autoArchiveConfirm.minutes}
                                            <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 2 }}>分钟</span>
                                        </div>
                                        <div style={{ fontSize: 10, color: '#db2777', marginTop: 2 }}>保持应用打开</div>
                                    </div>
                                </div>

                                {/* 说明 */}
                                <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.7, padding: '4px 2px' }}>
                                    追平会把过往未同步的消息分批交给副 API 处理、自动归档并推进水位线。
                                </div>
                            </div>

                            {/* 操作按钮 */}
                            <div
                                style={{
                                    padding: '14px 24px 22px',
                                    display: 'flex', flexDirection: 'column', gap: 8,
                                }}
                            >
                                <button
                                    onClick={() => {
                                        const conf = autoArchiveConfirm;
                                        setAutoArchiveConfirm(null);
                                        runAutoArchiveCatchUp({
                                            charId: conf.charId,
                                            charName: conf.charName,
                                            unprocessedCount: conf.unprocessedCount,
                                            mpEmb: conf.mpEmb,
                                            mpLLM: conf.mpLLM,
                                        });
                                    }}
                                    style={{
                                        padding: '13px 0', borderRadius: 16,
                                        border: 'none', cursor: 'pointer',
                                        background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 100%)',
                                        color: '#fff', fontSize: 14, fontWeight: 700,
                                        letterSpacing: '0.02em',
                                        boxShadow: '0 6px 16px rgba(124,58,237,0.35)',
                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                                    }}
                                >
                                    <Icon name="bolt" size={14} />
                                    立即追平历史
                                </button>
                                <button
                                    onClick={() => {
                                        setAutoArchiveConfirm(null);
                                        addToast('已开启全自动记忆，历史消息将按常规进度处理', 'info');
                                    }}
                                    style={{
                                        padding: '11px 0', borderRadius: 16,
                                        border: '1px solid rgba(124,58,237,0.2)',
                                        cursor: 'pointer',
                                        background: 'transparent',
                                        color: '#7c3aed', fontSize: 13, fontWeight: 600,
                                    }}
                                >
                                    稍后按所选档位慢慢处理
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ─── 未启用记忆宫殿 ─────────────────────────────────

    if (!char!.memoryPalaceEnabled && view !== 'globalSettings') {
        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div
                    onClick={() => setView('picker')}
                    style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer', marginBottom: 16, padding: '4px 0' }}
                >
                    ← 返回
                </div>
                <div style={{ textAlign: 'center', color: '#9ca3af' }}>
                    <div style={{ marginBottom: 16, color: '#c4b5fd', display: 'inline-flex' }}>
                        <Icon name="palace" size={56} />
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>记忆宫殿</div>
                    <div style={{ fontSize: 13, marginBottom: 20 }}>
                        {char.name} 尚未开启记忆宫殿功能
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 20 }}>
                        请返回角色选择页开启
                    </div>
                </div>
                {/* 切换到其他角色 */}
                <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>切换角色</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {characters.filter(c => c.id !== char.id).map(c => (
                        <div
                            key={c.id}
                            onClick={() => handleSwitchChar(c.id)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                padding: 10, borderRadius: 12, cursor: 'pointer',
                                border: '1px solid #e5e7eb', backgroundColor: '#fafafa',
                            }}
                        >
                            <TokenImg value={c.avatar} alt="" style={{ width: 28, height: 28, borderRadius: 8, objectFit: 'cover' }} />
                            <div>
                                <div style={{ fontSize: 12, fontWeight: 600 }}>{c.name}</div>
                                <div style={{ fontSize: 10, color: '#7c3aed', display: 'inline-flex' }}>
                                    {(c as any).memoryPalaceEnabled ? <Icon name="palace" size={12} /> : null}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // ─── 性格检测弹窗（检测中 / 等待确认） ──────────────

    const STYLE_LABELS: Record<string, string> = {
        emotional: '情感型', narrative: '叙事型', imagery: '意象型', analytical: '分析型',
    };
    const STYLE_DESCS: Record<string, string> = {
        emotional: '思维以情绪为主导，联想时优先走情感链路',
        narrative: '思维以时间线为主导，喜欢回顾经历和讲故事',
        imagery: '思维以隐喻和画面为主导，喜欢用比喻理解世界',
        analytical: '思维以逻辑因果为主导，喜欢分析和推理',
    };
    const RUM_LABELS = (v: number) =>
        v <= 0.2 ? '洒脱，很少纠结过去' :
        v <= 0.5 ? '偶尔会想起旧事' :
        v <= 0.8 ? '敏感，容易纠结旧事' : '执念很深，难以释怀';

    if (detectingPersonality && view !== 'globalSettings') {
        return (
            <div style={{ paddingLeft: 32, paddingRight: 32, paddingBottom: 32, paddingTop: SAFE_PAD_TOP, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
                <div style={{ marginBottom: 16, color: '#7c3aed', animation: 'pulse 2s ease-in-out infinite', display: 'inline-flex' }}>
                    <Icon name="crystal" size={40} />
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#4b5563', marginBottom: 8 }}>
                    正在分析 {char.name} 的性格特征…
                </div>
                <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', lineHeight: 1.6 }}>
                    根据角色人设和已有记忆<br />判断认知风格与反刍倾向
                </div>
            </div>
        );
    }

    if (pendingPersonality && view !== 'globalSettings') {
        return (
            <div style={{ paddingLeft: 24, paddingRight: 24, paddingBottom: 24, paddingTop: SAFE_PAD_TOP, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
                <div style={{ marginBottom: 12, color: '#7c3aed', display: 'inline-flex' }}>
                    <Icon name="mask" size={40} />
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#1f2937', marginBottom: 16 }}>
                    {char.name} 的性格分析结果
                </div>

                <div style={{
                    width: '100%', maxWidth: 320, borderRadius: 16, overflow: 'hidden',
                    border: '1px solid #e5e7eb', background: 'white',
                }}>
                    {/* 认知风格 */}
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>认知风格</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: '#7c3aed' }}>
                            {STYLE_LABELS[pendingPersonality.style] || pendingPersonality.style}
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                            {STYLE_DESCS[pendingPersonality.style] || ''}
                        </div>
                    </div>
                    {/* 反刍倾向 */}
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6' }}>
                        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>反刍倾向</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                            <span style={{ fontSize: 18, fontWeight: 700, color: '#7c3aed' }}>
                                {pendingPersonality.ruminationTendency.toFixed(1)}
                            </span>
                            <span style={{ fontSize: 12, color: '#6b7280' }}>
                                {RUM_LABELS(pendingPersonality.ruminationTendency)}
                            </span>
                        </div>
                    </div>
                    {/* 理由 */}
                    {pendingPersonality.reasoning && (
                        <div style={{ padding: '12px 20px', background: '#faf5ff' }}>
                            <div style={{ fontSize: 12, color: '#7c3aed', fontStyle: 'italic', lineHeight: 1.5 }}>
                                "{pendingPersonality.reasoning}"
                            </div>
                        </div>
                    )}
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 20, width: '100%', maxWidth: 320 }}>
                    <button
                        onClick={() => {
                            // 防御：只把结果应用到产生它的角色
                            if (pendingPersonalityCharId && pendingPersonalityCharId !== char.id) {
                                setPendingPersonality(null);
                                setPendingPersonalityCharId(null);
                                return;
                            }
                            updateCharacter(char.id, {
                                personalityStyle: pendingPersonality.style,
                                ruminationTendency: pendingPersonality.ruminationTendency,
                            } as any);
                            // 标记已定过人格，之后永不自动重测
                            try { localStorage.setItem(`mp_personality_tried_${char.id}`, '1'); } catch {}
                            setPendingPersonality(null);
                            setPendingPersonalityCharId(null);
                        }}
                        style={{
                            flex: 1, padding: '12px 0', borderRadius: 12, border: 'none',
                            fontSize: 14, fontWeight: 700, color: 'white', background: '#7c3aed',
                            cursor: 'pointer',
                        }}
                    >
                        确认
                    </button>
                    <button
                        onClick={() => {
                            // 防御：只把跳过写到产生结果的角色
                            if (pendingPersonalityCharId && pendingPersonalityCharId !== char.id) {
                                setPendingPersonality(null);
                                setPendingPersonalityCharId(null);
                                return;
                            }
                            // 用默认值，让用户后续在认知参数里改
                            updateCharacter(char.id, {
                                personalityStyle: 'emotional',
                                ruminationTendency: 0.3,
                            } as any);
                            try { localStorage.setItem(`mp_personality_tried_${char.id}`, '1'); } catch {}
                            setPendingPersonality(null);
                            setPendingPersonalityCharId(null);
                        }}
                        style={{
                            padding: '12px 16px', borderRadius: 12, border: '1px solid #e5e7eb',
                            fontSize: 13, fontWeight: 600, color: '#6b7280', background: 'white',
                            cursor: 'pointer',
                        }}
                    >
                        跳过
                    </button>
                </div>

                <div style={{ fontSize: 10, color: '#c4c4c4', marginTop: 12, textAlign: 'center' }}>
                    可在设置页「认知参数」中随时调整
                </div>
            </div>
        );
    }

    // ─── 设置视图（Embedding 配置） ──────────────────────

    if (view === 'settings' || view === 'globalSettings') {
        const isGlobal = view === 'globalSettings';
        const backTarget: 'palace' | 'picker' = isGlobal ? 'picker' : 'palace';
        const backLabel = isGlobal ? '← 返回选择角色' : '← 返回宫殿';
        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div
                    onClick={() => setView(backTarget)}
                    style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer', marginBottom: 16 }}
                >
                    {backLabel}
                </div>

                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                    <div style={{ marginBottom: 6, color: '#7c3aed', display: 'inline-flex' }}>
                        <Icon name="settings" size={28} />
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>
                        {isGlobal ? '记忆宫殿 · 全局配置' : `${char?.name ?? ''} 的记忆设置`}
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                        {isGlobal ? '所有角色共用同一套 API · 与角色无关' : '仅对当前角色生效'}
                    </div>
                </div>

                {/* 费用警告 */}
                {isGlobal && (<>

                <div style={{
                    padding: 14, borderRadius: 14, marginBottom: 16,
                    background: '#fef2f2', border: '2px solid #fca5a5',
                    fontSize: 12, color: '#991b1b', lineHeight: 1.7,
                }}>
                    <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="warning" size={14} />
                        <span>建议使用超低价模型</span>
                    </div>
                    记忆宫殿的后台处理（话题切分、记忆提取、关联分析、认知消化）使用下方配置的「副 API」，
                    日常对话期间每轮会调用几次。<br/>
                    <b>建议配一个超低价的模型</b>跑后台任务就行，具体选哪家哪款自己对比；按量 vs 按次差别在这个量级下都不大，真想省心自己比一下单价即可。<br/>
                    <span style={{ fontSize: 11, color: '#b91c1c' }}>
                        注：「导入旧记忆」是一次性大批量操作，调用次数会明显多于日常，单独见那里的提示。
                    </span>
                </div>

                {/* 副 API 配置 */}
                <div style={{ background: '#f0fdf4', borderRadius: 16, padding: 16, border: '1px solid #bbf7d0', marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="robot" size={14} />
                        <span>副 API（后台处理用）</span>
                    </div>
                    <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 10, lineHeight: 1.6 }}>
                        用于<b>记忆提取、关联分析、认知消化</b>等后台任务。此配置全局生效，所有角色共用。
                        <span style={{ color: '#9ca3af' }}>仅作用于记忆宫殿相关流程，不影响主聊天，也不影响情绪感知。</span>
                    </div>
                    <div style={{
                        fontSize: 10, color: '#9a3412', background: '#fff7ed',
                        border: '1px solid #fed7aa', borderRadius: 8, padding: '6px 8px',
                        marginBottom: 12, lineHeight: 1.6,
                    }}>
                        下方<b>不填</b>（URL 留空）时，记忆宫殿会<b>自动回退用主 API</b> 跑后台处理。
                        想让后台任务走更便宜的账户 / 不想占主 API 额度，就在这里填一个便宜模型。
                        看不懂怎么选？直接挑一个<b>每百万 token 几毛钱</b>的模型即可，后台任务不需要推理能力。
                    </div>

                    {/* API 预设快速填充 */}
                    {apiPresets.length > 0 && (
                        <div style={{ marginBottom: 10 }}>
                            <label className={labelClass}>从预设导入</label>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {apiPresets.map(p => (
                                    <button key={p.id} onClick={() => {
                                        setLightUrl(p.config.baseUrl);
                                        setLightKey(p.config.apiKey);
                                        setLightModel(p.config.model);
                                    }} style={{
                                        padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                                        border: '1px solid #bbf7d0', background: 'white', color: '#166534',
                                        cursor: 'pointer',
                                    }}>
                                        {p.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                            <label className={labelClass}>BASE URL</label>
                            <input type="text" value={lightUrl} onChange={e => setLightUrl(e.target.value)}
                                placeholder="https://..." className={inputClass} />
                        </div>
                        <div>
                            <label className={labelClass}>API KEY</label>
                            <input type="password" value={lightKey} onChange={e => setLightKey(e.target.value)}
                                placeholder="sk-..." className={inputClass} />
                        </div>
                        <div>
                            <label className={labelClass}>MODEL</label>
                            <input type="text" value={lightModel} onChange={e => setLightModel(e.target.value)}
                                placeholder="一个便宜的对话模型名" className={inputClass} />
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, paddingLeft: 4 }}>
                                填任意一家便宜的<b>对话模型</b>即可（按主 API 一样的填法），自己挑就好。
                                注意：这里要的是跑后台文字任务的<b>对话</b>模型，<b>不是</b> embedding 向量模型——别填到下面 Embedding 区才该用的那类。
                            </div>
                        </div>
                    </div>

                    <button onClick={handleSaveLightApi}
                        disabled={!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()}
                        style={{
                            width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13, color: 'white',
                            background: (!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) ? '#cbd5e1' : '#16a34a',
                            cursor: (!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {lightSaved ? '✓ 已保存' : '保存副 API 配置'}
                    </button>

                    {/* 测试副 API 连接 */}
                    <button
                        onClick={async () => {
                            if (!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) return;
                            setTestingLight(true);
                            setLightTestResult(null);
                            try {
                                const res = await fetch(`${lightUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${lightKey.trim()}`,
                                    },
                                    body: JSON.stringify({
                                        model: lightModel.trim(),
                                        messages: [{ role: 'user', content: 'Hi' }],
                                        max_tokens: 5,
                                    }),
                                });
                                if (res.ok) {
                                    const data = await res.json();
                                    const reply = (data.choices?.[0]?.message?.content || '').toString();
                                    setLightTestResult(`[ok]连接成功 — 模型回复: "${reply.slice(0, 30)}"`);
                                } else {
                                    const text = await res.text().catch(() => '');
                                    setLightTestResult(`[err]HTTP ${res.status}: ${text.slice(0, 120)}`);
                                }
                            } catch (err: any) {
                                setLightTestResult(`[err]连接失败: ${err?.message || String(err)}`);
                            } finally {
                                setTestingLight(false);
                            }
                        }}
                        disabled={testingLight || !lightUrl.trim() || !lightKey.trim() || !lightModel.trim()}
                        style={{
                            width: '100%', marginTop: 8, padding: '10px 0', borderRadius: 12,
                            border: '1px solid #16a34a44', fontWeight: 600, fontSize: 13,
                            color: '#16a34a', background: 'white',
                            cursor: (testingLight || !lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) ? 'not-allowed' : 'pointer',
                            opacity: (!lightUrl.trim() || !lightKey.trim() || !lightModel.trim()) ? 0.5 : 1,
                        }}
                    >
                        {testingLight ? '测试中...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="beaker" size={13} />
                                <span>测试 API 连接</span>
                            </span>
                        )}
                    </button>

                    {lightTestResult && (
                        <div style={{
                            marginTop: 8, fontSize: 12, padding: '8px 12px', borderRadius: 8,
                            background: lightTestResult.startsWith('[ok]') ? '#f0fdf4' : '#fef2f2',
                            color: lightTestResult.startsWith('[ok]') ? '#16a34a' : '#dc2626',
                        }}>
                            <StatusMessage msg={lightTestResult} />
                        </div>
                    )}

                    {!hasLightApi && (
                        <div style={{ marginTop: 8, fontSize: 11, color: '#a16207', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="warning" size={12} />
                            <span>副 API 未配置 — 后台处理会<b>回退使用主 API</b>（功能可用，但会占主 API 额度）</span>
                        </div>
                    )}
                </div>

                {/* Embedding API */}
                <div style={{ background: '#f8f7ff', borderRadius: 16, padding: 16, border: '1px solid #e9e5ff' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="link" size={14} />
                        <span>Embedding API（OpenAI 兼容格式）</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 16, lineHeight: 1.6 }}>
                        推荐使用硅基流动（SiliconFlow），注册即送免费额度。
                        下方选择模型后只需填入 API Key 即可。
                        <br/>
                        <span style={{ color: '#a16207', fontWeight: 600 }}>
                            注意：Embedding 用的是 <code>/embeddings</code> 端点，和主 API 不通用，因此
                            <b>不会自动回退</b>。不配置则记忆宫殿的向量化流程无法运行。
                        </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div>
                            <label className={labelClass}>BASE URL</label>
                            <input
                                type="text"
                                value={embUrl}
                                onChange={e => setEmbUrl(e.target.value)}
                                placeholder="https://api.siliconflow.cn/v1"
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>API KEY</label>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <input
                                    type="password"
                                    value={embKey}
                                    onChange={e => setEmbKey(e.target.value)}
                                    placeholder="sk-..."
                                    className={inputClass}
                                    style={{ flex: 1 }}
                                />
                                <button onClick={() => window.open('https://cloud.siliconflow.cn/account/ak', '_blank')} style={{
                                    padding: '8px 12px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                    border: '1px solid #e9e5ff', background: 'white', color: '#7c3aed',
                                    cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                                }}>
                                    获取 Key →
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className={labelClass}>EMBEDDING 模型</label>

                            {/* 红框警告：已有记忆时提醒不要随意换模型 */}
                            {memoryPalaceConfig.embedding.model && totalCount > 0 && (
                                <div style={{
                                    margin: '0 0 10px 0', padding: '10px 14px', borderRadius: 12,
                                    border: '1.5px solid #fca5a5', background: '#fef2f2',
                                    fontSize: 11, color: '#991b1b', lineHeight: 1.7,
                                }}>
                                    <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 4 }}>
                                        <Icon name="warning" size={12} />
                                        <span>重要：</span>
                                    </span>
                                    当前已有 <b>{totalCount}</b> 条记忆使用 <b>{memoryPalaceConfig.embedding.model.split('/').pop()}</b> 模型生成。
                                    更换模型后系统会自动重新生成所有向量（需要一点时间和 API 额度），
                                    <b>建议选定后就不要再换了</b>。如果不确定，选「推荐」就好。
                                </div>
                            )}

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                                {[
                                    { model: 'BAAI/bge-m3', dim: 1024, tag: '推荐', desc: '多语言顶级模型，免费', color: '#7c3aed' },
                                    { model: 'Pro/BAAI/bge-m3', dim: 1024, tag: '最强', desc: '加速推理版，¥0.7/百万token', color: '#f59e0b' },
                                ].map(opt => {
                                    const isActive = embModel === opt.model && embDimensions === opt.dim;
                                    return (
                                        <button key={opt.model} onClick={() => {
                                            setEmbModel(opt.model);
                                            setEmbDimensions(opt.dim);
                                            if (!embUrl.trim()) setEmbUrl('https://api.siliconflow.cn/v1');
                                        }} style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            padding: '10px 14px', borderRadius: 12, fontSize: 12,
                                            border: isActive ? `2px solid ${opt.color}` : '1px solid #e5e7eb',
                                            background: isActive ? `${opt.color}11` : 'white',
                                            cursor: 'pointer', textAlign: 'left', width: '100%',
                                            transition: 'all 0.15s',
                                        }}>
                                            <span style={{ fontWeight: 700, fontSize: 11, color: opt.color, whiteSpace: 'nowrap' }}>{opt.tag}</span>
                                            <span style={{ flex: 1 }}>
                                                <span style={{ fontWeight: 600, fontSize: 12, color: '#1f2937' }}>{opt.model.split('/').pop()}</span>
                                                <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 6 }}>{opt.desc}</span>
                                            </span>
                                            <span style={{ fontSize: 10, color: '#9ca3af' }}>{opt.dim}维</span>
                                        </button>
                                    );
                                })}
                            </div>
                            <div style={{ fontSize: 10, color: '#9ca3af', paddingLeft: 4, marginBottom: 4 }}>
                                或手动输入模型名（支持任何 OpenAI 兼容的 Embedding 端点）
                            </div>
                            <input
                                type="text"
                                value={embModel}
                                onChange={e => setEmbModel(e.target.value)}
                                placeholder="BAAI/bge-m3"
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>DIMENSIONS</label>
                            <input
                                type="number"
                                value={embDimensions}
                                onChange={e => setEmbDimensions(parseInt(e.target.value) || 1024)}
                                placeholder="1024"
                                className={inputClass}
                            />
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, paddingLeft: 4 }}>
                                选择预设模型会自动填入。手动输入时推荐 1024，部分模型支持 512 / 768
                            </div>
                        </div>
                    </div>

                    <button
                        onClick={handleSaveEmbeddingConfig}
                        disabled={!embUrl.trim() || !embKey.trim()}
                        style={{
                            width: '100%',
                            marginTop: 16,
                            padding: '12px 0',
                            borderRadius: 16,
                            border: 'none',
                            fontWeight: 700,
                            fontSize: 14,
                            color: 'white',
                            background: (!embUrl.trim() || !embKey.trim()) ? '#cbd5e1' : '#7c3aed',
                            cursor: (!embUrl.trim() || !embKey.trim()) ? 'not-allowed' : 'pointer',
                            transition: 'all 0.15s',
                        }}
                    >
                        {configSaved ? '✓ 已保存' : '保存配置'}
                    </button>

                    {/* 测试 Embedding 连接 */}
                    <button
                        onClick={async () => {
                            if (!embUrl.trim() || !embKey.trim()) return;
                            setTestingEmb(true);
                            setTestResult(null);
                            try {
                                const { getEmbedding } = await import('../utils/memoryPalace/embedding');
                                const config = {
                                    baseUrl: embUrl.trim(),
                                    apiKey: embKey.trim(),
                                    model: embModel.trim() || 'BAAI/bge-m3',
                                    dimensions: embDimensions || 1024,
                                };
                                const vec = await getEmbedding('测试文本', config);
                                setTestResult(`[ok]成功！返回 ${vec.length} 维向量`);
                            } catch (err: any) {
                                setTestResult(`[err]失败：${err.message}`);
                            } finally {
                                setTestingEmb(false);
                            }
                        }}
                        disabled={testingEmb || !embUrl.trim() || !embKey.trim()}
                        style={{
                            width: '100%',
                            marginTop: 8,
                            padding: '10px 0',
                            borderRadius: 12,
                            border: '1px solid #7c3aed44',
                            fontWeight: 600,
                            fontSize: 13,
                            color: '#7c3aed',
                            background: 'white',
                            cursor: testingEmb ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {testingEmb ? '测试中...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="beaker" size={13} />
                                <span>测试连接</span>
                            </span>
                        )}
                    </button>

                    {testResult && (
                        <div style={{
                            marginTop: 8, fontSize: 12, padding: '8px 12px', borderRadius: 8,
                            background: testResult.startsWith('[ok]') ? '#f0fdf4' : '#fef2f2',
                            color: testResult.startsWith('[ok]') ? '#16a34a' : '#dc2626',
                        }}>
                            <StatusMessage msg={testResult} />
                        </div>
                    )}
                </div>

                {/* Rerank API（可选 cross-encoder 二次排序） */}
                <details style={{ marginTop: 16, background: '#f0f9ff', borderRadius: 16, padding: 16, border: '1px solid #bae6fd' }}>
                    <summary style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#0369a1', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Icon name="target" size={14} />
                            <span>Rerank 模型（可选 / 二次排序增强）</span>
                        </span>
                        {rrEnabled && (
                            <span style={{
                                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                                color: (rrUrl && rrKey) ? '#15803d' : '#92400e',
                                background: (rrUrl && rrKey) ? '#dcfce7' : '#fef3c7',
                            }}>
                                {(rrUrl && rrKey) ? '已启用' : '待配置'}
                            </span>
                        )}
                    </summary>

                    <div style={{
                        marginTop: 12, padding: 12, borderRadius: 12,
                        background: '#eff6ff', border: '1px solid #bfdbfe',
                        fontSize: 11, color: '#1e3a8a', lineHeight: 1.7,
                    }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>rerank 是干啥的？</div>
                        开了之后能让跟你这句话最相关的记忆更准地被翻出来；可选增强，不开也不影响。
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                        {/* 启用开关 */}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={rrEnabled}
                                onChange={e => setRrEnabled(e.target.checked)}
                                style={{ accentColor: '#0369a1' }}
                            />
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#0369a1' }}>
                                启用 Rerank 通道
                            </span>
                        </label>

                        {/* 一键同步 embedding 服务商 */}
                        <button
                            onClick={() => {
                                setRrUrl(embUrl.trim());
                                setRrKey(embKey.trim());
                            }}
                            disabled={!embUrl.trim() || !embKey.trim()}
                            style={{
                                padding: '8px 12px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                border: '1px solid #bae6fd',
                                background: (!embUrl.trim() || !embKey.trim()) ? '#f1f5f9' : 'white',
                                color: (!embUrl.trim() || !embKey.trim()) ? '#94a3b8' : '#0369a1',
                                cursor: (!embUrl.trim() || !embKey.trim()) ? 'not-allowed' : 'pointer',
                                textAlign: 'left',
                            }}
                            title="把上面 Embedding 的 baseUrl 和 API Key 直接复制到 rerank（同一服务商通常可以复用）"
                        >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <Icon name="document" size={13} />
                                <span>从 Embedding 配置一键同步（baseUrl + API Key）</span>
                            </span>
                        </button>

                        <div>
                            <label className={labelClass}>BASE URL</label>
                            <input
                                type="text"
                                value={rrUrl}
                                onChange={e => setRrUrl(e.target.value)}
                                placeholder="https://api.siliconflow.cn/v1"
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>API KEY</label>
                            <input
                                type="password"
                                value={rrKey}
                                onChange={e => setRrKey(e.target.value)}
                                placeholder="sk-..."
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>RERANK 模型</label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                                {[
                                    { model: 'BAAI/bge-reranker-v2-m3', tag: '推荐', desc: '多语言 cross-encoder，中文强，免费额度大', color: '#0369a1' },
                                    { model: 'Pro/BAAI/bge-reranker-v2-m3', tag: 'Pro 版', desc: '加速推理，延迟更低，按量计费', color: '#f59e0b' },
                                    { model: 'netease-youdao/bce-reranker-base_v1', tag: '免费', desc: '网易有道 BCE，中文专精', color: '#10b981' },
                                ].map(opt => {
                                    const isActive = rrModel === opt.model;
                                    return (
                                        <button key={opt.model} onClick={() => setRrModel(opt.model)} style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            padding: '10px 14px', borderRadius: 12, fontSize: 12,
                                            border: isActive ? `2px solid ${opt.color}` : '1px solid #e5e7eb',
                                            background: isActive ? `${opt.color}11` : 'white',
                                            cursor: 'pointer', textAlign: 'left', width: '100%',
                                        }}>
                                            <span style={{ fontWeight: 700, fontSize: 11, color: opt.color, whiteSpace: 'nowrap' }}>{opt.tag}</span>
                                            <span style={{ flex: 1 }}>
                                                <span style={{ fontWeight: 600, fontSize: 12, color: '#1f2937' }}>{opt.model.split('/').pop()}</span>
                                                <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 6 }}>{opt.desc}</span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                            <div style={{ fontSize: 10, color: '#9ca3af', paddingLeft: 4, marginBottom: 4 }}>
                                或手动输入（支持任何遵循 Cohere/Jina 协议的 /rerank 端点）
                            </div>
                            <input
                                type="text"
                                value={rrModel}
                                onChange={e => setRrModel(e.target.value)}
                                placeholder="BAAI/bge-reranker-v2-m3"
                                className={inputClass}
                            />
                        </div>

                        <div>
                            <label className={labelClass}>额外召回条数（TOP N）</label>
                            <input
                                type="number"
                                value={rrTopN}
                                onChange={e => setRrTopN(parseInt(e.target.value) || 5)}
                                min={1}
                                max={20}
                                className={inputClass}
                            />
                            <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, paddingLeft: 4 }}>
                                去重后追加到主 15 条记忆后面。默认 5，一般 3-10 合适。
                            </div>
                        </div>
                    </div>

                    <button
                        onClick={handleSaveRerankConfig}
                        style={{
                            width: '100%', marginTop: 16, padding: '12px 0',
                            borderRadius: 16, border: 'none', fontWeight: 700, fontSize: 14,
                            color: 'white', background: '#0369a1', cursor: 'pointer',
                        }}
                    >
                        {rrSaved ? '✓ 已保存' : '保存 Rerank 配置'}
                    </button>

                    {/* 测试 rerank 连接 */}
                    <button
                        onClick={async () => {
                            if (!rrUrl.trim() || !rrKey.trim()) return;
                            setRrTesting(true);
                            setRrTestResult(null);
                            try {
                                const { rerankDocuments } = await import('../utils/memoryPalace/rerank');
                                const results = await rerankDocuments(
                                    { baseUrl: rrUrl.trim(), apiKey: rrKey.trim(), model: rrModel.trim() || 'BAAI/bge-reranker-v2-m3' },
                                    '测试问题：外公身体怎么样',
                                    ['外公前几天去医院做了心脏检查，结果正常', '今天下雨了，路上有点堵', '她最喜欢吃妈妈做的红烧肉'],
                                    3,
                                );
                                if (results.length > 0) {
                                    setRrTestResult(`[ok]成功！返回 ${results.length} 条，top1 index=${results[0].index} score=${results[0].relevance_score.toFixed(3)}`);
                                } else {
                                    setRrTestResult(`[warn]API 接通了但返回空数组，检查模型名是否正确`);
                                }
                            } catch (err: any) {
                                setRrTestResult(`[err]失败：${err.message}`);
                            } finally {
                                setRrTesting(false);
                            }
                        }}
                        disabled={rrTesting || !rrUrl.trim() || !rrKey.trim()}
                        style={{
                            width: '100%', marginTop: 8, padding: '10px 0',
                            borderRadius: 12, border: '1px solid #0369a144',
                            fontWeight: 600, fontSize: 13, color: '#0369a1',
                            background: 'white',
                            cursor: rrTesting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {rrTesting ? '测试中...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="beaker" size={13} />
                                <span>测试 rerank 连接</span>
                            </span>
                        )}
                    </button>

                    {rrTestResult && (
                        <div style={{
                            marginTop: 8, fontSize: 12, padding: '8px 12px', borderRadius: 8,
                            background: rrTestResult.startsWith('[ok]') ? '#f0fdf4' : rrTestResult.startsWith('[warn]') ? '#fffbeb' : '#fef2f2',
                            color: rrTestResult.startsWith('[ok]') ? '#16a34a' : rrTestResult.startsWith('[warn]') ? '#92400e' : '#dc2626',
                        }}>
                            <StatusMessage msg={rrTestResult} />
                        </div>
                    )}
                </details>

                {/* 远程向量存储（Supabase，可选）— 默认折叠 */}
                <details style={{ marginTop: 16, background: '#faf5ff', borderRadius: 16, padding: 16, border: '1px solid #e9d5ff' }}>
                    <summary style={{ cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Icon name="cloud" size={14} />
                            <span>远程向量存储（可选 / Supabase）</span>
                        </span>
                        {remoteVectorConfig.enabled && (
                            <span style={{
                                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                                color: remoteVectorConfig.initialized ? '#15803d' : '#92400e',
                                background: remoteVectorConfig.initialized ? '#dcfce7' : '#fef3c7',
                            }}>
                                {remoteVectorConfig.initialized ? '已连接' : '待初始化'}
                            </span>
                        )}
                    </summary>

                    {/* 什么时候考虑用 */}
                    <div style={{
                        marginTop: 12, padding: 12, borderRadius: 12,
                        background: '#fffbeb', border: '1px solid #fde68a',
                        fontSize: 11, color: '#78350f', lineHeight: 1.7,
                    }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>什么时候考虑搞这个？</div>
                        当你觉得<b>向量搜索变卡</b>的时候（一般要到 2–3 万条记忆以上才会有感觉）。
                        万条以内本地完全跑得动，<b>不用折腾</b>。
                        <div style={{ marginTop: 8, padding: 8, borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
                            <span style={{ flexShrink: 0, marginTop: 2 }}><Icon name="warning" size={12} /></span>
                            <div>
                                <b>开了远程 ≠ 数据万事大吉。</b>
                                目前是双写模式（本地也会存一份，不是挪到云上），
                                Supabase 免费版也不保证永久可用。
                                <b>该导出备份还是要导出备份</b>，别指望一开了就高枕无忧。
                            </div>
                        </div>
                    </div>

                    {/* 图文教程 */}
                    <a href="https://www.kdocs.cn/l/ctifnJA5VGA3" target="_blank" rel="noopener noreferrer"
                        style={{
                            display: 'block', marginTop: 10, padding: '10px 12px', borderRadius: 12,
                            background: 'white', border: '1px dashed #c4b5fd', color: '#7c3aed',
                            fontSize: 11, fontWeight: 600, textDecoration: 'none', textAlign: 'center',
                        }}
                    >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="book" size={13} />
                            <span>查看详细图文教程（金山文档）→</span>
                        </span>
                    </a>

                    {/* 3 步操作提示 */}
                    <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: '#f5f3ff', fontSize: 11, color: '#5b21b6', lineHeight: 1.8 }}>
                        <b>3 步搞定：</b><br/>
                        1. 注册 Supabase（GitHub 一键登录，见上方教程）<br/>
                        2. 在 Supabase SQL Editor 里运行下方初始化 SQL<br/>
                        3. 填入 Project URL 和 anon key，点测试连接
                        <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer"
                            style={{
                                marginTop: 8, display: 'inline-block', padding: '6px 12px', borderRadius: 8,
                                background: '#7c3aed', color: 'white', fontSize: 11, fontWeight: 700, textDecoration: 'none',
                            }}>
                            前往 Supabase →
                        </a>
                    </div>

                    {/* 初始化 SQL */}
                    <div style={{ marginTop: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                            <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>初始化 SQL</span>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button onClick={() => setShowInitSQL(!showInitSQL)} style={{
                                    fontSize: 10, color: '#7c3aed', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer',
                                }}>
                                    {showInitSQL ? '收起' : '查看'}
                                </button>
                                <button onClick={handleCopyInitSQL} style={{
                                    fontSize: 10, color: 'white', fontWeight: 700, background: '#7c3aed',
                                    border: 'none', borderRadius: 6, padding: '3px 10px', cursor: 'pointer',
                                }}>
                                    复制
                                </button>
                            </div>
                        </div>
                        {showInitSQL && (
                            <pre style={{
                                background: '#0f172a', color: '#86efac', fontSize: 9, padding: 12, borderRadius: 10,
                                overflow: 'auto', maxHeight: 200, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                            }}>{`create extension if not exists vector;
create table if not exists memory_vectors (
  memory_id text primary key, char_id text not null,
  content text not null default '', vector vector(1024),
  dimensions int default 1024, model text, room text,
  importance int default 5, tags text[] default '{}',
  mood text default '',
  created_at bigint default (extract(epoch from now()) * 1000)::bigint,
  last_accessed_at bigint default 0,
  access_count int default 0
);
-- 完整 SQL 请点"复制"按钮获取`}</pre>
                        )}
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>复制此 SQL → Supabase Dashboard → SQL Editor → 运行</div>
                    </div>

                    {/* Project URL & anon key */}
                    <div style={{ marginTop: 12 }}>
                        <label className={labelClass}>PROJECT URL</label>
                        <input type="url" value={rvUrl} onChange={e => setRvUrl(e.target.value)}
                            placeholder="https://xxxxx.supabase.co" className={inputClass} />
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, paddingLeft: 4 }}>Settings → API → Project URL</div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                        <label className={labelClass}>ANON / PUBLIC KEY</label>
                        <input type="password" value={rvKey} onChange={e => setRvKey(e.target.value)}
                            placeholder="eyJhbGciOiJIUzI1NiIs..." className={inputClass} />
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, paddingLeft: 4 }}>Settings → API → anon public key</div>
                    </div>

                    {/* 测试 + 保存 */}
                    <button onClick={handleTestRemoteVector} disabled={rvTesting || !rvUrl || !rvKey}
                        style={{
                            width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 12,
                            border: '1px solid #e5e7eb', fontWeight: 600, fontSize: 12,
                            color: '#475569', background: 'white',
                            cursor: (rvTesting || !rvUrl || !rvKey) ? 'not-allowed' : 'pointer',
                            opacity: (rvTesting || !rvUrl || !rvKey) ? 0.5 : 1,
                        }}
                    >
                        {rvTesting ? '测试中...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="beaker" size={13} />
                                <span>测试连接</span>
                            </span>
                        )}
                    </button>
                    {rvTestResult && (
                        <div style={{
                            marginTop: 8, fontSize: 11, textAlign: 'center', fontWeight: 600,
                            color: rvTestResult.startsWith('[ok]') ? '#16a34a' : rvTestResult.startsWith('[warn]') ? '#d97706' : '#dc2626',
                        }}>
                            <StatusMessage msg={rvTestResult} />
                        </div>
                    )}
                    <button onClick={handleSaveRemoteVector} disabled={!rvUrl || !rvKey}
                        style={{
                            width: '100%', marginTop: 8, padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13, color: 'white',
                            background: (!rvUrl || !rvKey) ? '#cbd5e1' : '#7c3aed',
                            cursor: (!rvUrl || !rvKey) ? 'not-allowed' : 'pointer',
                        }}
                    >
                        保存配置
                    </button>

                    {/* 已启用后的操作 */}
                    {remoteVectorConfig.enabled && remoteVectorConfig.initialized && (
                        <button onClick={handleSyncToRemote} disabled={rvSyncing}
                            style={{
                                width: '100%', marginTop: 8, padding: '10px 0', borderRadius: 12,
                                border: '1px solid #e9d5ff', fontWeight: 600, fontSize: 12,
                                color: '#7c3aed', background: 'white',
                                cursor: rvSyncing ? 'not-allowed' : 'pointer',
                                opacity: rvSyncing ? 0.5 : 1,
                            }}
                        >
                            {rvSyncing ? '同步中...' : (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <Icon name="refresh" size={13} />
                                    <span>同步本地向量到远程</span>
                                </span>
                            )}
                        </button>
                    )}
                    {remoteVectorConfig.enabled && (
                        <button onClick={handleDisableRemoteVector}
                            style={{
                                width: '100%', marginTop: 8, padding: '8px 0',
                                border: 'none', background: 'none',
                                fontSize: 11, color: '#ef4444', fontWeight: 600, cursor: 'pointer',
                            }}
                        >
                            关闭远程存储
                        </button>
                    )}
                </details>
                </>)}

                {/* 人格风格 & 反刍倾向：由 LLM 自动推断，默认折叠 */}
                {!isGlobal && (<>
                <details style={{ marginTop: 16 }}>
                    <summary style={{ fontSize: 10, color: '#c4c4c4', cursor: 'pointer', userSelect: 'none' }}>
                        认知参数
                    </summary>
                    <div style={{ marginTop: 8, background: '#f9fafb', borderRadius: 12, padding: 14, border: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div>
                            <label className={labelClass}>认知风格</label>
                            <select
                                value={(char as any).personalityStyle || ''}
                                onChange={e => updateCharacter(char.id, { personalityStyle: e.target.value } as any)}
                                className={inputClass}
                                style={{ fontFamily: 'inherit', fontSize: 12 }}
                            >
                                {/* 未评估时如实显示，而不是假装成"情感型"（检索时按情感型默认值跑） */}
                                {!(char as any).personalityStyle && (
                                    <option value="" disabled>未评估（默认按情感型处理）</option>
                                )}
                                <option value="emotional">情感型</option>
                                <option value="narrative">叙事型</option>
                                <option value="imagery">意象型</option>
                                <option value="analytical">分析型</option>
                            </select>
                        </div>
                        <div>
                            <label className={labelClass}>
                                反刍倾向 {(char as any).ruminationTendency == null
                                    ? '未评估（默认 0.3）'
                                    : ((char as any).ruminationTendency).toFixed(1)}
                            </label>
                            <input
                                type="range" min="0" max="1" step="0.1"
                                value={(char as any).ruminationTendency ?? 0.3}
                                onChange={e => updateCharacter(char.id, { ruminationTendency: parseFloat(e.target.value) } as any)}
                                style={{ width: '100%' }}
                            />
                        </div>
                        <button
                            onClick={manualDetectPersonality}
                            disabled={detectingPersonality}
                            style={{
                                width: '100%', padding: '10px 0', borderRadius: 10,
                                border: '1px solid #ddd6fe', background: '#f5f3ff',
                                fontSize: 12, fontWeight: 700, color: '#7c3aed',
                                cursor: detectingPersonality ? 'wait' : 'pointer',
                                opacity: detectingPersonality ? 0.6 : 1,
                            }}
                        >
                            {detectingPersonality ? '评估中…' : 'AI 评估认知参数'}
                        </button>
                        <div style={{ fontSize: 10, color: '#b0b0b0', lineHeight: 1.5 }}>
                            认知风格影响记忆联想偏好，反刍倾向影响想起旧事的概率。
                            可手动调整，也可让 AI 根据人设评估（结果需确认后才生效）。
                        </div>
                    </div>
                </details>

                <details style={{ marginTop: 12 }}>
                    <summary style={{ fontSize: 10, color: '#0f766e', cursor: 'pointer', userSelect: 'none' }}>
                        ChatApp 交流步伐
                    </summary>
                    <div style={{ marginTop: 8, background: '#f0fdfa', borderRadius: 12, padding: 14, border: '1px solid #99f6e4' }}>
                        <div style={{ fontSize: 11, color: '#115e59', lineHeight: 1.65, marginBottom: 12 }}>
                            设置这个角色愿意在多大程度上跟随用户当下的说话步伐。0% 表示该维度完全保持自己，100% 也只会在安全范围内适应，不会改写角色人格。
                        </div>
                        {([
                            ['length', '回复长度'],
                            ['rhythm', '来回节奏'],
                            ['energy', '情绪能量'],
                            ['punctuation', '标点力度'],
                            ['emoji', 'Emoji 使用'],
                        ] as Array<[keyof CharacterAccommodationPolicy, string]>).map(([key, label]) => {
                            const value = char.interactionAccommodation?.[key]
                                ?? DEFAULT_CHARACTER_ACCOMMODATION[key];
                            return (
                                <div key={key} style={{ marginBottom: key === 'emoji' ? 0 : 10 }}>
                                    <label className={labelClass} style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <span>{label}</span>
                                        <span style={{ color: '#0f766e' }}>{Math.round(value * 100)}%</span>
                                    </label>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1"
                                        step="0.05"
                                        value={value}
                                        onChange={event => updateAccommodation(key, parseFloat(event.target.value))}
                                        style={{ width: '100%', accentColor: '#0f766e' }}
                                    />
                                </div>
                            );
                        })}
                        <button
                            onClick={() => updateCharacter(char.id, { interactionAccommodation: { ...DEFAULT_CHARACTER_ACCOMMODATION } })}
                            style={{
                                width: '100%', marginTop: 12, padding: '8px 0', borderRadius: 9,
                                border: '1px solid #99f6e4', background: '#ffffff',
                                fontSize: 11, fontWeight: 700, color: '#0f766e', cursor: 'pointer',
                            }}
                        >
                            恢复温和默认值
                        </button>
                        <div style={{ fontSize: 10, color: '#0f766e', lineHeight: 1.55, marginTop: 10 }}>
                            这里只影响 ChatApp 回复。角色回复不会被拿来反向训练这些数值，其他 App 的写作人格也不会变化。
                        </div>
                    </div>
                </details>

                {/* 手动总结与向量化（保底机制）：圈选聊天区间走一次总结，不碰水位线 */}
                <div style={{ marginTop: 16, background: '#f5f3ff', borderRadius: 16, padding: 16, border: '1px solid #ddd6fe' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#5b21b6', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="book" size={14} />
                        <span>手动总结与向量化</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12, lineHeight: 1.6 }}>
                        像翻聊天记录一样圈出一段对话（自己点<b>起点</b>和<b>终点</b>，支持模糊搜索），单独走一次总结 + 向量化。
                        这是给「连续总结失败、不确定向量化成没成」的<b>保底手段</b>——
                        它<b>完全不碰水位线</b>，和全自动记忆互不干扰，重复总结同一段也不会刷出重复记忆（已开启去重）。
                    </div>

                    {rangeResult && (
                        <div style={{ fontSize: 12, marginBottom: 8, color: rangeResult.startsWith('[ok]') ? '#16a34a' : rangeResult.startsWith('[warn]') ? '#d97706' : '#dc2626' }}>
                            <StatusMessage msg={rangeResult} />
                        </div>
                    )}

                    <button
                        onClick={openRangeModal}
                        disabled={!hasEmbeddingConfig}
                        style={{
                            width: '100%', padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13,
                            color: 'white',
                            background: !hasEmbeddingConfig ? '#cbd5e1' : '#7c3aed',
                            cursor: !hasEmbeddingConfig ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {!hasEmbeddingConfig ? '请先配置 Embedding API' : '选择聊天区间总结'}
                    </button>
                </div>

                {!isGlobal && char && <div style={{ marginTop: 16 }}>
                    <button type="button" onClick={() => setShowHistoryCleanup(true)} className="w-full rounded-2xl border border-red-100 bg-red-50 py-3 text-sm font-bold text-red-700">清理指定范围 / 保留最近 N 条</button>
                    <p className="mt-2 text-center text-xs text-slate-500">不需要副 API。永久删除前会有两次确认。</p>
                    {showHistoryCleanup && <ChatHistoryCleanupModal key={char.id} character={char} onClose={() => setShowHistoryCleanup(false)} onDeleted={() => {
                        trackEvent('清空聊天记录');
                        markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
                        setRangeModalOpen(false); setRangeMessages([]); setRangeStartId(null); setRangeEndId(null);
                        addToast('选中的聊天原文已清理，已有记忆保留', 'success');
                    }} />}
                </div>}

                {/* 手动总结：区间选择弹窗（浏览聊天记录 → 点选起点/终点 → 总结） */}
                {rangeModalOpen && char && (() => {
                    const bothSet = rangeStartId != null && rangeEndId != null;
                    const hasEndpoint = rangeStartId != null || rangeEndId != null;
                    const lo = bothSet ? Math.min(rangeStartId!, rangeEndId!) : null;
                    const hi = bothSet ? Math.max(rangeStartId!, rangeEndId!) : null;
                    const shown = rangeMessages;
                    const page = rangePage;

                    return (
                        <div
                            style={{
                                position: 'fixed', inset: 0, zIndex: 210,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                padding: 12,
                                background: 'rgba(31,17,71,0.45)',
                                animation: 'fade-in 0.2s ease-out',
                            }}
                            onClick={() => { if (!rangeRunning) setRangeModalOpen(false); }}
                        >
                            <div
                                onClick={e => e.stopPropagation()}
                                style={{
                                    width: '100%', maxWidth: 420, height: 'min(82dvh, 720px)', maxHeight: 'calc(100dvh - 24px)',
                                    minHeight: 0,
                                    display: 'flex', flexDirection: 'column',
                                    borderRadius: 24, overflow: 'hidden',
                                    background: '#ffffff',
                                    boxShadow: '0 25px 60px -15px rgba(124,58,237,0.4), 0 10px 30px rgba(0,0,0,0.15)',
                                    border: '1px solid rgba(167,139,250,0.25)',
                                }}
                            >
                                {/* 头部 */}
                                <div style={{ padding: '16px 18px 12px', borderBottom: '1px solid #f1f5f9' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                        <div style={{ fontSize: 15, fontWeight: 800, color: '#1f1147' }}>手动总结与向量化</div>
                                        <button
                                            onClick={() => { if (!rangeRunning) setRangeModalOpen(false); }}
                                            style={{ border: 'none', background: 'transparent', cursor: rangeRunning ? 'not-allowed' : 'pointer', color: '#94a3b8', padding: 4 }}
                                        >
                                            <Icon name="x" size={18} />
                                        </button>
                                    </div>
                                    <div style={{ fontSize: 11, color: '#7c3aed' }}>{char.name} · 点一条消息，再选「设为起点 / 终点」</div>

                                    {/* 模糊搜索 */}
                                    <div style={{ marginTop: 10, position: 'relative' }}>
                                        <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }}>
                                            <Icon name="search" size={14} />
                                        </span>
                                        <input
                                            value={rangeQuery}
                                            onChange={e => { setRangeQuery(e.target.value); setRangePage(0); setRangeCursor({}); }}
                                            placeholder="模糊搜索内容或日期（如 生日 / 2026-03）"
                                            style={{
                                                width: '100%', padding: '8px 10px 8px 30px', borderRadius: 10,
                                                border: '1px solid #e2e8f0', fontSize: 12, outline: 'none', boxSizing: 'border-box',
                                            }}
                                        />
                                    </div>
                                </div>

                                {/* 消息列表 */}
                                <div style={{
                                    flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px',
                                    WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y',
                                }}>
                                    {rangeLoading && (
                                        <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 12, padding: 24 }}>加载聊天记录中...</div>
                                    )}
                                    {!rangeLoading && shown.length === 0 && (
                                        <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 12, padding: 24 }}>
                                            {rangeQuery ? '没有匹配的消息' : '没有聊天记录'}
                                        </div>
                                    )}
                                    {!rangeLoading && (rangeHasOlder || rangeHasNewer) && (
                                        <div style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                            gap: 8, padding: '6px 8px', marginBottom: 6,
                                            background: '#faf5ff', borderRadius: 8,
                                        }}>
                                            <button
                                                onClick={() => { setRangeCursor({ beforeId: shown[0]?.id }); setRangePage(p => p + 1); }}
                                                disabled={!rangeHasOlder}
                                                style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 7, border: '1px solid #ddd6fe', background: !rangeHasOlder ? '#f1f5f9' : '#fff', color: !rangeHasOlder ? '#cbd5e1' : '#7c3aed', cursor: !rangeHasOlder ? 'not-allowed' : 'pointer' }}
                                            >
                                                ‹ 更早
                                            </button>
                                            <span style={{ fontSize: 10, color: '#7c3aed', fontWeight: 600 }}>
                                                从最新起第 {page + 1} 页 · 本页 {shown.length} 条
                                            </span>
                                            <button
                                                onClick={() => { setRangeCursor({ afterId: shown[shown.length - 1]?.id }); setRangePage(p => Math.max(0, p - 1)); }}
                                                disabled={!rangeHasNewer}
                                                style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 7, border: '1px solid #ddd6fe', background: !rangeHasNewer ? '#f1f5f9' : '#fff', color: !rangeHasNewer ? '#cbd5e1' : '#7c3aed', cursor: !rangeHasNewer ? 'not-allowed' : 'pointer' }}
                                            >
                                                更新 ›
                                            </button>
                                        </div>
                                    )}
                                    {!rangeLoading && shown.map(m => {
                                        const isStart = m.id === rangeStartId;
                                        const isEnd = m.id === rangeEndId;
                                        const endpointLabel = getRangeEndpointLabel(m.id, rangeStartId, rangeEndId);
                                        const isPending = m.id === rangePendingId;
                                        const inRange = lo != null && hi != null && m.id >= lo && m.id <= hi;
                                        const isEndpoint = !!endpointLabel;
                                        const who = m.role === 'user' ? '我' : m.role === 'system' ? '系统' : char.name;
                                        const isDate = (m.metadata as any)?.source === 'date';
                                        const preview = (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 48);
                                        return (
                                            <div
                                                key={m.id}
                                                onClick={() => { if (!rangeRunning) onTapRangeMessage(m.id); }}
                                                style={{
                                                    padding: '8px 10px', marginBottom: 4, borderRadius: 10, cursor: rangeRunning ? 'default' : 'pointer',
                                                    background: isEndpoint ? '#ede9fe' : isPending ? '#faf5ff' : inRange ? '#f5f3ff' : '#fff',
                                                    border: isPending ? '1.5px solid #c4b5fd' : isEndpoint ? '1.5px solid #7c3aed' : inRange ? '1px solid #ddd6fe' : '1px solid #f1f5f9',
                                                }}
                                            >
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                                    <span style={{ fontSize: 10, color: '#64748b', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                                        {isDate && (
                                                            <span style={{ fontSize: 9, fontWeight: 700, color: '#db2777', background: '#fce7f3', borderRadius: 5, padding: '0 5px' }}>约会</span>
                                                        )}
                                                        {who} · {fmtRangeTs(m.timestamp)}
                                                    </span>
                                                    {(isStart || isEnd) && (
                                                        <span style={{ fontSize: 9, fontWeight: 800, color: '#fff', background: '#7c3aed', borderRadius: 6, padding: '1px 6px' }}>
                                                            {endpointLabel}
                                                        </span>
                                                    )}
                                                </div>
                                                <div style={{ fontSize: 12, color: '#334155', marginTop: 2, lineHeight: 1.4 }}>
                                                    {preview || '（无文本内容）'}
                                                </div>

                                                {/* 待确认菜单：点了这条才出现，避免误触直接改动起止 */}
                                                {isPending && (
                                                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }} onClick={e => e.stopPropagation()}>
                                                        <button
                                                            onClick={() => confirmRangeEndpoint(m.id, 'start')}
                                                            style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: '1px solid #7c3aed', background: '#7c3aed', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                                        >
                                                            设为起点
                                                        </button>
                                                        <button
                                                            onClick={() => confirmRangeEndpoint(m.id, 'end')}
                                                            style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: '1px solid #7c3aed', background: '#fff', color: '#7c3aed', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                                        >
                                                            设为终点
                                                        </button>
                                                        <button
                                                            onClick={() => setRangePendingId(null)}
                                                            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#94a3b8', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                                                        >
                                                            取消
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* 底部操作 */}
                                <div style={{ borderTop: '1px solid #f1f5f9', padding: '10px 14px 14px' }}>
                                    {rangeRunning && rangeProgress && (
                                        <div style={{ fontSize: 11, color: '#7c3aed', marginBottom: 8, textAlign: 'center' }}>{rangeProgress}</div>
                                    )}
                                    {!rangeRunning && rangeResult && (
                                        <div style={{ fontSize: 12, marginBottom: 8, color: rangeResult.startsWith('[ok]') ? '#16a34a' : rangeResult.startsWith('[warn]') ? '#d97706' : '#dc2626' }}>
                                            <StatusMessage msg={rangeResult} />
                                        </div>
                                    )}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                        <span style={{ fontSize: 11, color: '#64748b' }}>
                                            {bothSet ? '已选区间（包含起点与终点）' : getRangeSelectionHint(rangeStartId, rangeEndId, 0)}
                                        </span>
                                        <button
                                            onClick={() => { setRangeStartId(null); setRangeEndId(null); }}
                                            disabled={rangeRunning || !hasEndpoint}
                                            style={{
                                                fontSize: 11, fontWeight: 600, color: (rangeRunning || !hasEndpoint) ? '#cbd5e1' : '#dc2626',
                                                background: 'transparent', border: 'none',
                                                cursor: (rangeRunning || !hasEndpoint) ? 'not-allowed' : 'pointer',
                                            }}
                                        >
                                            清除选择
                                        </button>
                                    </div>
                                    <button
                                        onClick={runRangeSummary}
                                        disabled={rangeRunning || !bothSet}
                                        style={{
                                            width: '100%', padding: '11px 0', borderRadius: 12,
                                            border: 'none', fontWeight: 700, fontSize: 13, color: 'white',
                                            background: (rangeRunning || !bothSet) ? '#cbd5e1' : '#7c3aed',
                                            cursor: (rangeRunning || !bothSet) ? 'not-allowed' : 'pointer',
                                        }}
                                    >
                                        {rangeRunning ? '总结中…请保持应用打开' : '开始总结 + 向量化'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* 手动总结：完成结果弹窗（逐条列出新增记忆，和水位线总结一致） */}
                {rangeResultData && (
                    <div
                        style={{
                            position: 'fixed', inset: 0, zIndex: 220,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
                            background: 'rgba(15,23,42,0.55)',
                            backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
                            animation: 'fade-in 0.2s ease-out',
                        }}
                        onClick={() => setRangeResultData(null)}
                    >
                        <div
                            onClick={e => e.stopPropagation()}
                            style={{
                                width: '100%', maxWidth: 380, maxHeight: '82vh',
                                display: 'flex', flexDirection: 'column', overflow: 'hidden',
                                background: 'linear-gradient(160deg, #ffffff 0%, #f8fafc 100%)',
                                borderRadius: 28, border: '1px solid rgba(148,163,184,0.18)',
                                boxShadow: '0 20px 50px -20px rgba(15,23,42,0.35)',
                            }}
                        >
                            <div style={{ padding: '26px 24px 14px', textAlign: 'center' }}>
                                <div style={{
                                    width: 54, height: 54, margin: '0 auto 12px', borderRadius: 18,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'linear-gradient(135deg, rgba(124,58,237,0.14), rgba(167,139,250,0.06))',
                                    border: '1px solid rgba(124,58,237,0.15)', fontSize: 26,
                                }}>🗂️</div>
                                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.25em', textTransform: 'uppercase', color: '#7c3aed' }}>Manual Summary</div>
                                <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', marginTop: 4 }}>手动总结完成</div>
                                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                                    新增 {rangeResultData.stored} 条 · 去重跳过 {rangeResultData.skipped} 条
                                    {rangeResultData.batches.length > 1 && ` · ${rangeResultData.batches.length} 批`}
                                    {' · '}处理 {rangeResultData.processedMessages} 条消息
                                </div>
                                <div style={{ fontSize: 10, color: '#16a34a', marginTop: 2 }}>未改动水位线，与全自动记忆互不干扰</div>
                                {rangeResultData.batches.some(b => !b.ok) && (
                                    <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2 }}>
                                        {rangeResultData.batches.filter(b => !b.ok).map(b => `batch ${b.index} 失败`).join(', ')}
                                    </div>
                                )}
                            </div>

                            <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {rangeResultData.memories.map((m, i) => {
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
                                        <div key={i} style={{
                                            padding: 12, borderRadius: 16,
                                            background: 'rgba(255,255,255,0.75)', border: `1px solid ${meta.color}22`,
                                            boxShadow: `0 2px 8px ${meta.color}14`,
                                        }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                                <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 8px', borderRadius: 999, background: `${meta.color}18`, color: meta.color }}>{roomLabel}</span>
                                                <span style={{ fontSize: 10, color: '#94a3b8' }}>{m.mood}</span>
                                                <span style={{ fontSize: 10, fontWeight: 700, marginLeft: 'auto', color: '#f59e0b' }}>{'★'.repeat(Math.min(m.importance, 5))}</span>
                                            </div>
                                            <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.6 }}>{m.content}</div>
                                            {m.tags.length > 0 && (
                                                <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                                                    {m.tags.map((t, j) => (
                                                        <span key={j} style={{ fontSize: 9, padding: '1px 6px', borderRadius: 999, background: 'rgba(148,163,184,0.15)', color: '#64748b' }}>{t}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {rangeResultData.memories.length === 0 && (
                                    <div style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', padding: 16 }}>
                                        本次没提取到新记忆{rangeResultData.skipped > 0 ? '（这段对话的记忆此前已存在）' : ''}
                                    </div>
                                )}
                            </div>

                            <div style={{ padding: '8px 24px 22px' }}>
                                <button
                                    onClick={() => setRangeResultData(null)}
                                    style={{
                                        width: '100%', padding: '12px 0', borderRadius: 14, border: 'none',
                                        color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                                        background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
                                        boxShadow: '0 6px 18px -6px rgba(124,58,237,0.5)',
                                    }}
                                >
                                    确认
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 聊天记录向量化 */}
                {/* 迁移旧记忆 */}
                <div style={{ marginTop: 16, background: '#fefce8', borderRadius: 16, padding: 16, border: '1px solid #fde68a' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="download" size={14} />
                        <span>导入旧记忆</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#78716c', marginBottom: 12, lineHeight: 1.6 }}>
                        按月将旧的日度记忆 ({char.memories?.length || 0} 条) 送给 LLM，
                        以 {char.name} 的第一人称视角重新提取为记忆节点。可选择具体月份，不选则全部导入。旧数据不会被删除。
                    </div>

                    {/* 开销提示：旧记忆一次性灌入 LLM 是一次性高消耗，提醒用户避免误用昂贵 API */}
                    <div style={{
                        marginBottom: 12, padding: 10, borderRadius: 10,
                        border: '1px solid #fca5a5', background: '#fef2f2',
                        fontSize: 11, color: '#991b1b', lineHeight: 1.7,
                    }}>
                        <div style={{ fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <Icon name="money" size={12} />
                            <span>开销提示（请先看完再开跑）</span>
                        </div>
                        <div>
                            <b>1.</b> 每个分块（如"1 月上旬"）会调副 API 1-2 次 → <b>每个月最多 3-12 次</b>。强烈建议用<b>按次数计费的便宜 API</b>，别拿包月的高级模型来烧。
                        </div>
                        <div>
                            <b>2.</b> 这里用的是<b>本页配置的副 API</b>（不是聊天主 API），动手前确认一下你配的是哪个模型。
                        </div>
                        <div>
                            <b>3.</b> 建议<b>先勾一个分块跑一次</b>，看完账单再决定要不要全量导。
                        </div>
                        <div>
                            <b>4.</b> 这里是<b>把历史记忆一口气重转成宫殿节点</b>，所以开销会有点吓人。日常聊天的自动归档不会这样。
                        </div>
                    </div>

                    {/* 分块选择器（每月拆上旬/中旬/下旬） */}
                    {availableChunks.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#92400e', marginBottom: 6 }}>
                                选择分块（不选 = 全部）· 每月拆为上旬/中旬/下旬，可单独选择避免重跑
                            </div>
                            {availableMonths.map(month => {
                                const monthChunks = availableChunks.filter(c => c.key.startsWith(month));
                                if (monthChunks.length === 0) return null;
                                return (
                                    <div key={month} style={{ marginBottom: 6 }}>
                                        <div style={{ fontSize: 10, color: '#78716c', marginBottom: 3, fontWeight: 600 }}>{month}</div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                            {monthChunks.map(chunk => (
                                                <button
                                                    key={chunk.key}
                                                    onClick={() => {
                                                        setSelectedMonths(prev => {
                                                            const next = new Set(prev);
                                                            if (next.has(chunk.key)) next.delete(chunk.key);
                                                            else next.add(chunk.key);
                                                            return next;
                                                        });
                                                    }}
                                                    style={{
                                                        padding: '3px 8px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                                                        border: selectedMonths.has(chunk.key) ? '2px solid #f59e0b' : '1px solid #d4d4d4',
                                                        background: selectedMonths.has(chunk.key) ? '#fef3c7' : 'white',
                                                        color: selectedMonths.has(chunk.key) ? '#92400e' : '#6b7280',
                                                        cursor: 'pointer',
                                                    }}
                                                >
                                                    {chunk.key.replace(month + ' ', '')} ({chunk.count}条)
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                            {selectedMonths.size > 0 && (
                                <div style={{ fontSize: 10, color: '#92400e', marginTop: 4 }}>
                                    已选 {selectedMonths.size} 个分块
                                    <span
                                        onClick={() => setSelectedMonths(new Set())}
                                        style={{ marginLeft: 8, color: '#dc2626', cursor: 'pointer', textDecoration: 'underline' }}
                                    >
                                        清除选择
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    {migrationProgress && (
                        <div style={{ fontSize: 11, color: '#92400e', marginBottom: 8 }}>
                            {migrationProgress.phase === 'grouping' && `按月分组中...`}
                            {migrationProgress.phase === 'extracting' && `LLM 提取中... ${migrationProgress.currentMonth || ''} (${migrationProgress.current}/${migrationProgress.total} 块)`}
                            {migrationProgress.phase === 'vectorizing' && `Embedding 向量化中... ${migrationProgress.current}/${migrationProgress.total} 条`}
                            {migrationProgress.phase === 'linking' && `建立记忆关联中...`}
                            {migrationProgress.phase === 'done' && `完成`}
                        </div>
                    )}

                    {migrationResult && (
                        <div style={{ fontSize: 12, marginBottom: 8, color: migrationResult.startsWith('[ok]') ? '#16a34a' : '#dc2626' }}>
                            <StatusMessage msg={migrationResult} />
                        </div>
                    )}

                    <button
                        onClick={handleMigrate}
                        disabled={migrating || !hasEmbeddingConfig}
                        style={{
                            width: '100%', padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13,
                            color: 'white',
                            background: migrating ? '#d4d4d4' : !hasEmbeddingConfig ? '#cbd5e1' : '#f59e0b',
                            cursor: migrating || !hasEmbeddingConfig ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {migrating ? '迁移中...' : !hasEmbeddingConfig ? '请先配置 Embedding API' : selectedMonths.size > 0 ? `开始迁移（${selectedMonths.size} 个分块）` : '开始迁移（全部）'}
                    </button>

                    <button
                        onClick={() => {
                            if (confirm('确定清除所有已迁移的数据？（boxId 以 migrated_ 开头的记忆 + 向量 + 关联）')) {
                                handleClearMigrated();
                            }
                        }}
                        disabled={deleting}
                        style={{
                            width: '100%', marginTop: 8, padding: '8px 0',
                            borderRadius: 10, border: '1px solid #fecaca',
                            fontSize: 12, fontWeight: 600,
                            color: '#dc2626', background: 'white',
                            cursor: deleting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {deleting ? '清除中...' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="trash" size={13} />
                                <span>清除已迁移数据</span>
                            </span>
                        )}
                    </button>
                </div>

                {/* 认知消化（手动触发/测试） */}
                <div style={{ marginTop: 16, background: '#f0fdf4', borderRadius: 16, padding: 16, border: '1px solid #bbf7d0' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#166534', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <RoomIcon room="attic" size={14} style={{ color: ROOM_COLORS.attic }} />
                        <span>认知消化</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12, lineHeight: 1.6 }}>
                        角色会安静地回想最近的事情：阁楼里的困惑有没有想开？窗台上的期盼实现了吗？
                        反复学到的东西是否已经内化成性格的一部分？聊天每 50 轮自动触发一次，也可以随时手动触发。
                        整合出的概括（用户认知 / 知识内化 / 自我领悟）会沉淀到房间门牌，不再新增记忆条目。
                    </div>

                    {digestResult && (
                        <div style={{ fontSize: 12, marginBottom: 8, color: digestResult.startsWith('[ok]') ? '#16a34a' : digestResult.startsWith('[err]') ? '#dc2626' : '#6b7280' }}>
                            <StatusMessage msg={digestResult} />
                        </div>
                    )}

                    <button
                        onClick={handleDigest}
                        disabled={digesting}
                        style={{
                            width: '100%', padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13,
                            color: 'white',
                            background: digesting ? '#d4d4d4' : '#16a34a',
                            cursor: digesting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {digesting ? `${char.name}正在静静地回想…` : '手动触发消化'}
                    </button>

                    {/* 门牌历史回填：老用户的积压不该白攒——分批扫全部历史立牌 */}
                    {bootstrapStatus && (
                        <div style={{ fontSize: 12, marginTop: 8, color: bootstrapStatus.startsWith('[ok]') ? '#7c3aed' : bootstrapStatus.startsWith('[err]') ? '#dc2626' : '#6b7280' }}>
                            <StatusMessage msg={bootstrapStatus} />
                        </div>
                    )}
                    <button
                        onClick={handleBootstrapPlates}
                        disabled={bootstrapping}
                        style={{
                            width: '100%', marginTop: 8, padding: '8px 0',
                            borderRadius: 10, border: '1px solid #ddd6fe',
                            fontSize: 12, fontWeight: 600,
                            color: '#7c3aed', background: 'white',
                            cursor: bootstrapping ? 'not-allowed' : 'pointer',
                            opacity: bootstrapping ? 0.6 : 1,
                        }}
                    >
                        {bootstrapping ? '正在整理…' : '整理历史记忆到门牌（每次一小段，可分多次）'}
                    </button>

                    {/* 消化日志：每次消化到底审视了什么、改了什么、往门牌提交了什么 */}
                    <button
                        onClick={async () => {
                            if (!char || digestReports !== null) { setDigestReports(null); return; }
                            try {
                                setDigestReports(await DigestReportDB.getByCharId(char.id));
                            } catch { setDigestReports([]); }
                        }}
                        style={{
                            width: '100%', marginTop: 8, padding: '8px 0',
                            borderRadius: 10, border: '1px solid #bbf7d0',
                            fontSize: 12, fontWeight: 600,
                            color: '#166534', background: 'white', cursor: 'pointer',
                        }}
                    >
                        {digestReports === null ? '查看消化日志' : '收起消化日志'}
                    </button>

                    {digestReports !== null && (
                        <div style={{ marginTop: 10 }}>
                            {digestReports.length === 0 && (
                                <div style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', padding: '12px 0' }}>
                                    还没有消化记录——触发一次消化后这里会记下它做了什么
                                </div>
                            )}
                            {digestReports.map(report => {
                                const expanded = expandedReportId === report.id;
                                const outcomeCount = report.outcomes.reduce((s, sec) => s + sec.items.length, 0);
                                const submitCount = report.plateSubmissions.reduce((s, sec) => s + sec.items.length, 0);
                                const examinedCount = report.examined.reduce((s, sec) => s + sec.items.length, 0);
                                const renderSection = (sec: { label: string; items: string[] }, color: string) => (
                                    <div key={sec.label} style={{ marginTop: 6 }}>
                                        <div style={{ fontSize: 10, fontWeight: 700, color }}>{sec.label}</div>
                                        {sec.items.map((it, i) => (
                                            <div key={i} style={{ fontSize: 11, color: '#475569', lineHeight: 1.5, padding: '2px 0 2px 8px', borderLeft: `2px solid ${color}22` }}>{it}</div>
                                        ))}
                                    </div>
                                );
                                return (
                                    <div
                                        key={report.id}
                                        style={{ background: 'white', borderRadius: 10, border: '1px solid #e5e7eb', padding: '8px 10px', marginBottom: 6, cursor: 'pointer' }}
                                        onClick={() => setExpandedReportId(expanded ? null : report.id)}
                                    >
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                                            <span style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>
                                                {fmtRangeTs(report.createdAt)}
                                                <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: 6 }}>{report.trigger === 'auto' ? '自动' : '手动'}</span>
                                            </span>
                                            <span style={{ fontSize: 10, color: '#94a3b8' }}>
                                                审视 {examinedCount} · 变化 {outcomeCount} · 提交门牌 {submitCount}
                                            </span>
                                        </div>
                                        {expanded && (
                                            <div style={{ marginTop: 4 }} onClick={e => e.stopPropagation()}>
                                                {examinedCount === 0 && outcomeCount === 0 && submitCount === 0 && (
                                                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>这次没有待消化的内容{report.plateUpdated.length > 0 ? '，但整理了门牌' : ''}</div>
                                                )}
                                                {report.examined.map(sec => renderSection(sec, '#0ea5e9'))}
                                                {report.outcomes.map(sec => renderSection(sec, '#16a34a'))}
                                                {report.plateSubmissions.map(sec => renderSection(sec, '#8b5cf6'))}
                                                {report.plateUpdated.length > 0 && (
                                                    <div style={{ fontSize: 10, color: '#8b5cf6', marginTop: 6 }}>
                                                        门牌已更新：{report.plateUpdated.map(r => (PLATE_TITLES as Record<string, string>)[r] || r).join('、')}
                                                    </div>
                                                )}
                                                {report.plateCloudPending && (
                                                    <div style={{ fontSize: 10, color: '#8b5cf6', marginTop: 6 }}>
                                                        门牌整理已交给云端跑，结果晚几分钟落地
                                                    </div>
                                                )}
                                                {submitCount > 0 && report.plateUpdated.length === 0 && !report.plateCloudPending && (
                                                    <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 6 }}>
                                                        ⚠️ 本次提交的候选未合并进门牌（整理未跑成或未被采纳）
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* 导出 / 导入记忆：接入外置记忆库、跨设备迁移 */}
                <div style={{ marginTop: 16, background: '#eff6ff', borderRadius: 16, padding: 16, border: '1px solid #bfdbfe' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#1e40af', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="download" size={14} />
                        <span>导出 / 导入记忆</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12, lineHeight: 1.6 }}>
                        把 <b>{char.name}</b> 记忆宫殿里的全部记忆导出成 JSON：含每条记忆的正文、房间、重要性、情绪、标签、时间，
                        以及事件盒（整合回忆）、窗台期盼和房间门牌（常驻认知）。
                    </div>

                    {/* 是否带向量：长期用同一 embedding 模型就勾上，向量可直接复用免重新向量化 */}
                    <label style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
                        marginBottom: 12, fontSize: 11, color: '#334155', lineHeight: 1.6,
                    }}>
                        <input
                            type="checkbox"
                            checked={exportWithVectors}
                            onChange={e => setExportWithVectors(e.target.checked)}
                            style={{ marginTop: 2, flexShrink: 0, cursor: 'pointer' }}
                        />
                        <span>
                            <b>同时导出向量</b>（推荐）<br/>
                            <span style={{ color: '#64748b' }}>
                                继续用<b>同一个 embedding 模型</b>时向量可直接复用，免重新向量化、检索结果一致；
                                换模型则无效。取消勾选只导文本结构，文件更小。
                            </span>
                        </span>
                    </label>

                    {exportResult && (
                        <div style={{ fontSize: 12, marginBottom: 8, color: exportResult.startsWith('[err]') ? '#dc2626' : exportResult.startsWith('[warn]') ? '#d97706' : '#16a34a' }}>
                            <StatusMessage msg={exportResult} />
                        </div>
                    )}

                    <button
                        onClick={handleExportMemories}
                        disabled={exporting}
                        style={{
                            width: '100%', padding: '10px 0', borderRadius: 12,
                            border: 'none', fontWeight: 700, fontSize: 13,
                            color: 'white',
                            background: exporting ? '#d4d4d4' : '#2563eb',
                            cursor: exporting ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {exporting ? '导出中…' : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                <Icon name="download" size={13} />
                                <span>导出为 JSON</span>
                            </span>
                        )}
                    </button>

                    {/* 外部文本搬家：原文清洗后直接向量化、分房间并建链 */}
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #dbeafe' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#1e40af', marginBottom: 6 }}>
                            从其它地方搬入原始记忆
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10, lineHeight: 1.65 }}>
                            最多 5 万字，字数完全在本地统计。AI 只整理时间与事件结构，<b>不摘要、不合并、不省略细节</b>；
                            随后直接生成向量、分配宫殿房间，并把<b>同一批内容</b>同步进
                            <b>【{char?.name || '当前角色'}】的神经链接记忆档案</b>。
                            5 万字以内会自动按自然段分批，不需要手动切。
                        </div>
                        <textarea
                            value={externalMemoryText}
                            onChange={event => setExternalMemoryText(event.target.value)}
                            disabled={externalImporting}
                            placeholder="粘贴从其它应用、设备或记忆系统带来的原始文字…"
                            style={{
                                width: '100%',
                                minHeight: 150,
                                resize: 'vertical',
                                borderRadius: 12,
                                border: '1px solid #bfdbfe',
                                background: externalImporting ? '#f8fafc' : 'white',
                                color: '#334155',
                                fontSize: 12,
                                lineHeight: 1.65,
                                padding: 12,
                                outline: 'none',
                            }}
                        />
                        <div style={{
                            fontSize: 10,
                            color: externalLengthInfo.overLimit ? '#dc2626' : '#94a3b8',
                            fontWeight: externalLengthInfo.overLimit ? 700 : 400,
                            textAlign: 'right',
                            margin: '4px 2px 8px',
                        }}>
                            {externalLengthInfo.count.toLocaleString()} / {EXTERNAL_MEMORY_MAX_CHARS.toLocaleString()} 字（本地统计）
                        </div>
                        {externalLengthInfo.overLimit && (
                            <div style={{
                                fontSize: 11,
                                lineHeight: 1.65,
                                color: '#92400e',
                                background: '#fffbeb',
                                border: '1px solid #fde68a',
                                borderRadius: 10,
                                padding: 10,
                                marginBottom: 8,
                            }}>
                                {getExternalMemoryOverLimitMessage(externalMemoryText)}
                            </div>
                        )}
                        <details style={{
                            fontSize: 11,
                            color: '#475569',
                            background: '#f8fafc',
                            border: '1px solid #e2e8f0',
                            borderRadius: 10,
                            padding: '8px 10px',
                            marginBottom: 10,
                        }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 700, color: '#475569' }}>
                                导入前常见疑问
                            </summary>
                            <div style={{ marginTop: 8, lineHeight: 1.75 }}>
                                <div><b>会导给谁？</b> 只导入当前选中的【{char?.name || '当前角色'}】，不会串到其他角色。</div>
                                <div><b>会覆盖旧记忆吗？</b> 不会；只追加新节点，相似内容会在向量阶段去重。</div>
                                <div><b>会压缩原文吗？</b> 不会；只整理时间、事件边界和第一人称视角，长事件宁可拆多条也不省略。</div>
                                <div><b>会写到哪里？</b> 同一次清洗结果会双写：一份进记忆宫殿向量库，一份按日期合并进神经链接的角色记忆档案。</div>
                                <div><b>和全自动水位线有什么不同？</b> 双写方式相同；但外部文本没有聊天消息 ID，所以不会推进水位线，也不会隐藏聊天记录。</div>
                                <div><b>会调用什么？</b> 先用副 API 清洗和分房间，再用 Embedding API 生成向量；宫殿内部仍会建立记忆关联。</div>
                                <div><b>超过 5 万字怎么办？</b> 页面会在本地计算并建议批数；超限内容不会上传或调用 API。</div>
                                <div><b>中途失败怎么办？</b> 清洗阶段任一批格式不完整或疑似删减，整次都不会入库，输入框会保留原文；系统会先自动重试一次。</div>
                            </div>
                        </details>
                        {externalImportProgress && (
                            <div style={{ fontSize: 11, color: '#2563eb', marginBottom: 8 }}>
                                {externalImportProgress}
                            </div>
                        )}
                        {externalImportResult && (
                            <div style={{
                                fontSize: 12,
                                marginBottom: 8,
                                color: externalImportResult.startsWith('[err]')
                                    ? '#dc2626'
                                    : externalImportResult.startsWith('[warn]') ? '#d97706' : '#16a34a',
                            }}>
                                <StatusMessage msg={externalImportResult} />
                            </div>
                        )}
                        <button
                            onClick={handleExternalMemoryImport}
                            disabled={externalImporting || !externalMemoryText.trim() || externalLengthInfo.overLimit}
                            style={{
                                width: '100%',
                                padding: '10px 0',
                                borderRadius: 12,
                                border: 'none',
                                fontWeight: 700,
                                fontSize: 13,
                                color: 'white',
                                background: externalImporting || !externalMemoryText.trim() || externalLengthInfo.overLimit ? '#cbd5e1' : '#4f46e5',
                                cursor: externalImporting || !externalMemoryText.trim() || externalLengthInfo.overLimit ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {externalImporting
                                ? '正在清洗并生成向量…'
                                : externalLengthInfo.overLimit ? '请按建议分批后再导入' : '开始清洗并导入'}
                        </button>
                    </div>

                    {/* 结构化导入：把本系统导出的 JSON 合并回当前角色（跨设备迁移 / 恢复） */}
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #dbeafe' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10, lineHeight: 1.6 }}>
                            已经是 SullyOS 记忆宫殿 JSON 的文件无需清洗，可直接合并进 <b>{char.name}</b>（追加，不覆盖）。
                        </div>

                        {importResult && (
                            <div style={{ fontSize: 12, marginBottom: 8, color: importResult.startsWith('[err]') ? '#dc2626' : importResult.startsWith('[warn]') ? '#d97706' : '#16a34a' }}>
                                <StatusMessage msg={importResult} />
                            </div>
                        )}

                        <input
                            ref={importInputRef}
                            type="file"
                            accept="application/json,.json"
                            onChange={handleImportFile}
                            style={{ display: 'none' }}
                        />
                        <button
                            onClick={() => importInputRef.current?.click()}
                            disabled={importing}
                            style={{
                                width: '100%', padding: '10px 0', borderRadius: 12,
                                border: '1px solid #bfdbfe', fontWeight: 700, fontSize: 13,
                                color: '#1d4ed8', background: 'white',
                                cursor: importing ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {importing ? '导入中…' : (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <Icon name="document" size={13} />
                                    <span>从 SullyOS JSON 导入</span>
                                </span>
                            )}
                        </button>
                    </div>
                </div>
                </>)}

                {/* 危险区：一键清空 */}
                {isGlobal && (
                <div style={{ marginTop: 16, background: '#fef2f2', borderRadius: 16, padding: 16, border: '2px solid #fca5a5' }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#991b1b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="warning" size={14} />
                        <span>危险区：一键清空向量记忆</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#7f1d1d', marginBottom: 12, lineHeight: 1.7 }}>
                        清空【所有角色】的记忆节点、向量、关联、事件盒、便利贴、期盼、高水位标记。
                        可选择同时清空云端 Supabase <code>memory_vectors</code> 全表。
                        <b> 此操作不可撤销。</b>
                    </div>

                    {wipeResult && (
                        <div style={{
                            fontSize: 12, marginBottom: 10,
                            color: wipeResult.startsWith('[err]') ? '#dc2626' : '#166534',
                        }}>
                            <StatusMessage msg={wipeResult} />
                        </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <button
                            onClick={() => handleWipeAll(false)}
                            disabled={wiping}
                            style={{
                                width: '100%', padding: '10px 0', borderRadius: 12,
                                border: '1px solid #fecaca', fontWeight: 700, fontSize: 13,
                                color: '#b91c1c', background: 'white',
                                cursor: wiping ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {wiping ? '清空中…' : (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <Icon name="trash" size={13} />
                                    <span>仅清空本地</span>
                                </span>
                            )}
                        </button>
                        <button
                            onClick={() => handleWipeAll(true)}
                            disabled={wiping || !remoteVectorConfig?.enabled || !remoteVectorConfig?.initialized}
                            title={
                                !remoteVectorConfig?.enabled ? '未启用云端向量存储'
                                : !remoteVectorConfig?.initialized ? '云端向量存储未初始化'
                                : undefined
                            }
                            style={{
                                width: '100%', padding: '10px 0', borderRadius: 12,
                                border: 'none', fontWeight: 700, fontSize: 13,
                                color: 'white',
                                background: (wiping || !remoteVectorConfig?.enabled || !remoteVectorConfig?.initialized)
                                    ? '#d4d4d4' : '#dc2626',
                                cursor: (wiping || !remoteVectorConfig?.enabled || !remoteVectorConfig?.initialized)
                                    ? 'not-allowed' : 'pointer',
                            }}
                        >
                            {wiping ? '清空中…' : (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <Icon name="bomb" size={13} />
                                    <span>清空本地 + 云端 Supabase</span>
                                </span>
                            )}
                        </button>
                    </div>
                </div>
                )}
            </div>
        );
    }

    // ─── 宫殿概览视图 ────────────────────────────────

    if (view === 'palace') {
        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                {/* 标题 + 返回 + 设置 */}
                <div style={{ textAlign: 'center', marginBottom: 20, position: 'relative' }}>
                    {/* 返回（到选角界面）按钮 */}
                    <div
                        onClick={() => setView('picker')}
                        style={{
                            position: 'absolute', left: 0, top: 0,
                            fontSize: 13, color: '#6b7280', cursor: 'pointer',
                            padding: '4px 0',
                        }}
                    >
                        ← 返回
                    </div>
                    {/* 设置齿轮 */}
                    <div
                        onClick={() => setView('settings')}
                        style={{
                            position: 'absolute', right: 0, top: 0,
                            width: 32, height: 32, borderRadius: 10,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer',
                            background: '#f3f0ff', color: '#7c3aed',
                        }}
                    >
                        <Icon name="settings" size={16} />
                    </div>

                    {/* 角色名（可点击切换） */}
                    <div
                        onClick={() => setShowCharPicker(!showCharPicker)}
                        style={{ fontSize: 18, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                        <TokenImg value={char.avatar} alt="" style={{ width: 24, height: 24, borderRadius: 8, objectFit: 'cover' }} />
                        {char.name} 的记忆宫殿
                        <span style={{ fontSize: 10, color: '#9ca3af' }}>▼</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
                        {totalCount} 条记忆 · {boxCount} 个事件盒 · {anticipations.length} 个期盼
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <div
                            onClick={openAllMemories}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                fontSize: 11, fontWeight: 600, color: '#7c3aed',
                                cursor: 'pointer', padding: '4px 12px',
                                borderRadius: 8, border: '1px solid #e9e5ff',
                                background: '#f8f6ff',
                            }}
                        >
                            <Icon name="list" size={13} />
                            <span>查看全部记忆</span>
                        </div>
                        <div
                            onClick={openAllBoxes}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                fontSize: 11, fontWeight: 600, color: '#6366f1',
                                cursor: 'pointer', padding: '4px 12px',
                                borderRadius: 8, border: '1px solid #c7d2fe',
                                background: '#eef2ff',
                            }}
                        >
                            <Icon name="box" size={13} />
                            <span>查看事件盒</span>
                        </div>
                    </div>

                    {/* 全局搜索 */}
                    <div style={{ marginTop: 12, textAlign: 'left', position: 'relative' }}>
                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', display: 'inline-flex', pointerEvents: 'none' }}>
                            <Icon name="search" size={14} />
                        </span>
                        <input
                            type="text"
                            value={globalSearchQuery}
                            onChange={(e) => {
                                const q = e.target.value;
                                setGlobalSearchQuery(q);
                                if (globalSearchTimerRef.current) clearTimeout(globalSearchTimerRef.current);
                                if (q.trim().length < 2) { setGlobalSearchResults([]); return; }
                                globalSearchTimerRef.current = setTimeout(async () => {
                                    const allNodes = await MemoryNodeDB.getByCharId(char!.id);
                                    const keywords = q.trim().toLowerCase().split(/\s+/);
                                    const filtered = allNodes
                                        .filter(n => {
                                            const text = (n.content + ' ' + n.tags.join(' ') + ' ' + n.mood).toLowerCase();
                                            return keywords.every(kw => text.includes(kw));
                                        })
                                        .sort((a, b) => b.importance - a.importance)
                                        .slice(0, 20);
                                    setGlobalSearchResults(filtered);
                                }, 300);
                            }}
                            placeholder="搜索记忆（关键词、标签、情绪...）"
                            style={{
                                width: '100%', padding: '10px 14px 10px 34px', borderRadius: 12,
                                border: '1px solid #e5e7eb', background: '#f9fafb',
                                fontSize: 13, outline: 'none', boxSizing: 'border-box',
                            }}
                        />
                    </div>

                    {/* 角色切换面板 */}
                    {showCharPicker && (
                        <div style={{
                            marginTop: 12, padding: 8, borderRadius: 12,
                            border: '1px solid #e5e7eb', backgroundColor: 'white',
                            textAlign: 'left', boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                        }}>
                            {characters.map(c => (
                                <div
                                    key={c.id}
                                    onClick={() => handleSwitchChar(c.id)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 10,
                                        padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                                        backgroundColor: c.id === activeCharacterId ? '#f3f0ff' : 'transparent',
                                    }}
                                >
                                    <TokenImg value={c.avatar} alt="" style={{ width: 32, height: 32, borderRadius: 10, objectFit: 'cover' }} />
                                    <div>
                                        <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                                        <div style={{ fontSize: 10, color: '#9ca3af' }}>
                                            {(c as any).memoryPalaceEnabled ? '已启用' : '未启用'}
                                        </div>
                                    </div>
                                    {c.id === activeCharacterId && (
                                        <span style={{ marginLeft: 'auto', color: '#7c3aed', display: 'inline-flex' }}>
                                            <Icon name="check" size={14} />
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Embedding 配置警告 */}
                    {!hasEmbeddingConfig && (
                        <div
                            onClick={() => setView('globalSettings')}
                            style={{
                                marginTop: 12, padding: '8px 12px', borderRadius: 10,
                                background: '#fef3c7', border: '1px solid #fde68a',
                                fontSize: 12, color: '#92400e', cursor: 'pointer',
                                display: 'flex', alignItems: 'center', gap: 6,
                            }}
                        >
                            <Icon name="warning" size={14} />
                            <span>尚未配置 Embedding API — 点击此处配置</span>
                        </div>
                    )}
                </div>

                {/* 便利贴置顶 */}
                {pinnedNodes.length > 0 && !globalSearchQuery.trim() && (
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Icon name="pin" size={14} />
                            <span>便利贴</span>
                        </div>
                        {pinnedNodes.map(node => {
                            const daysLeft = Math.ceil((node.pinnedUntil! - Date.now()) / (24 * 60 * 60 * 1000));
                            const color = ROOM_COLORS[node.room];
                            return (
                                <div key={node.id} style={{
                                    padding: '10px 12px', borderRadius: 10, marginBottom: 6,
                                    border: '1px solid #fde68a', background: '#fffbeb',
                                    display: 'flex', alignItems: 'flex-start', gap: 8,
                                }}>
                                    <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => openMemory(node, 'all')}>
                                        <div style={{ fontSize: 13, lineHeight: 1.5, color: '#1f2937' }}>
                                            {node.content.length > 80 ? node.content.slice(0, 80) + '...' : node.content}
                                        </div>
                                        <div style={{ fontSize: 10, color: '#92400e', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                            <RoomIcon room={node.room} size={12} style={{ color: ROOM_COLORS[node.room] }} />
                                            <span>{getRoomLabel(node.room, userProfile?.name)} · 剩余 {daysLeft} 天</span>
                                        </div>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            const updated = { ...node, pinnedUntil: null };
                                            await MemoryNodeDB.save(updated);
                                            setPinnedNodes(prev => prev.filter(n => n.id !== node.id));
                                        }}
                                        style={{
                                            flexShrink: 0, padding: '4px 8px', borderRadius: 6,
                                            border: '1px solid #fde68a', background: 'white',
                                            fontSize: 10, color: '#92400e', cursor: 'pointer',
                                        }}
                                    >
                                        取消置顶
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* 搜索结果 or 七个房间 */}
                {globalSearchQuery.trim().length >= 2 ? (
                    <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>
                            {globalSearchResults.length > 0
                                ? `找到 ${globalSearchResults.length} 条记忆`
                                : '没有找到匹配的记忆'}
                        </div>
                        {globalSearchResults.map(node => {
                            const color = ROOM_COLORS[node.room];
                            return (
                                <div
                                    key={node.id}
                                    onClick={() => openMemory(node, 'all')}
                                    style={{
                                        padding: '10px 12px', borderRadius: 10, marginBottom: 6,
                                        border: `1px solid ${color}33`, background: `${color}08`,
                                        cursor: 'pointer',
                                    }}
                                >
                                    <div style={{ fontSize: 13, lineHeight: 1.5, color: '#1f2937' }}>
                                        {node.content.length > 100 ? node.content.slice(0, 100) + '...' : node.content}
                                    </div>
                                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                            <RoomIcon room={node.room} size={12} style={{ color: ROOM_COLORS[node.room] }} />
                                            {getRoomLabel(node.room, userProfile?.name)}
                                        </span>
                                        <span>{new Date(node.createdAt).toLocaleDateString('zh-CN')}</span>
                                        <span style={{ color }}>{'★'.repeat(Math.min(node.importance, 5))}</span>
                                        <span>{node.mood}</span>
                                    </div>
                                    {node.tags.length > 0 && (
                                        <div style={{ marginTop: 4, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                                            {node.tags.map((t: string) => (
                                                <span key={t} style={{
                                                    fontSize: 9, padding: '1px 6px', borderRadius: 4,
                                                    backgroundColor: `${color}18`, color,
                                                }}>{t}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <>
                        {/* 七个房间 */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
                            {(Object.keys(ROOM_CONFIGS) as MemoryRoom[]).map(room => {
                                const config = ROOM_CONFIGS[room];
                                const count = roomCounts[room] || 0;
                                const color = ROOM_COLORS[room];
                                return (
                                    <div
                                        key={room}
                                        onClick={() => openRoom(room)}
                                        style={{
                                            padding: 14,
                                            borderRadius: 12,
                                            border: `1px solid ${color}33`,
                                            backgroundColor: `${color}11`,
                                            cursor: 'pointer',
                                            transition: 'transform 0.15s',
                                        }}
                                    >
                                        <div style={{ marginBottom: 6, color }}><RoomIcon room={room} size={26} /></div>
                                        <div style={{ fontSize: 14, fontWeight: 600, color }}>{getRoomLabel(room, userProfile?.name)}</div>
                                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{config.description}</div>
                                        <div style={{ fontSize: 20, fontWeight: 700, marginTop: 8, color }}>
                                            {count}
                                            <span style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>
                                                {config.capacity ? `/ ${config.capacity}` : '条'}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}

                {/* 期盼区 */}
                {anticipations.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Icon name="sunrise" size={14} />
                            <span>窗台期盼</span>
                            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>长按可修改或删除</span>
                        </div>
                        {anticipations.map((ant: Anticipation) => (
                            <div
                                key={ant.id}
                                onPointerDown={(e) => startAnticipationLongPress(e, ant)}
                                onPointerMove={moveAnticipationLongPress}
                                onPointerUp={cancelAnticipationLongPress}
                                onPointerCancel={cancelAnticipationLongPress}
                                onPointerLeave={cancelAnticipationLongPress}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    openAnticipationEditor(ant);
                                }}
                                style={{
                                padding: 10, borderRadius: 8, marginBottom: 6,
                                backgroundColor: ant.status === 'fulfilled' ? '#ecfdf5' :
                                    ant.status === 'disappointed' ? '#fef2f2' : '#fefce8',
                                fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 6,
                                cursor: 'pointer', userSelect: 'none', touchAction: 'pan-y',
                            }}>
                                <span style={{ display: 'inline-flex', color:
                                    ant.status === 'active' ? '#7c3aed' :
                                    ant.status === 'anchor' ? '#6b7280' :
                                    ant.status === 'fulfilled' ? '#16a34a' : '#ef4444'
                                }}>
                                    <Icon
                                        name={ant.status === 'active' ? 'sparkle' :
                                            ant.status === 'anchor' ? 'lock' :
                                            ant.status === 'fulfilled' ? 'celebrate' : 'broken-heart'}
                                        size={14}
                                    />
                                </span>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ lineHeight: 1.5, color: '#1f2937', whiteSpace: 'pre-wrap' }}>{ant.content}</div>
                                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                                        {new Date(ant.createdAt).toLocaleDateString('zh-CN')} · {ant.status}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {editingAnticipation && (
                    <div
                        onClick={() => {
                            if (!savingAnticipation) {
                                setEditingAnticipation(null);
                                setAnticipationDraft('');
                            }
                        }}
                        style={{
                            position: 'fixed', inset: 0, zIndex: 120,
                            background: 'rgba(15,23,42,0.42)', backdropFilter: 'blur(4px)',
                            display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                            padding: 16,
                        }}
                    >
                        <div
                            onClick={e => e.stopPropagation()}
                            style={{
                                width: '100%', maxWidth: 520, padding: 18,
                                borderRadius: 22, background: 'white',
                                boxShadow: '0 18px 50px rgba(15,23,42,0.22)',
                            }}
                        >
                            <div style={{ fontSize: 16, fontWeight: 700, color: '#1f2937' }}>修改窗台期盼</div>
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3, marginBottom: 12 }}>
                                只修改便利贴正文；状态与创建时间保持不变
                            </div>
                            <textarea
                                autoFocus
                                value={anticipationDraft}
                                onChange={e => setAnticipationDraft(e.target.value)}
                                rows={5}
                                maxLength={2000}
                                style={{
                                    width: '100%', boxSizing: 'border-box', resize: 'vertical',
                                    border: '1px solid #e5e7eb', borderRadius: 14,
                                    background: '#fffbeb', color: '#1f2937',
                                    fontSize: 14, lineHeight: 1.6, padding: 12, outline: 'none',
                                }}
                            />
                            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                                <button
                                    onClick={handleDeleteAnticipation}
                                    disabled={savingAnticipation}
                                    style={{
                                        padding: '10px 14px', borderRadius: 12,
                                        border: '1px solid #fecaca', background: '#fef2f2',
                                        color: '#dc2626', fontWeight: 700, cursor: 'pointer',
                                    }}
                                >
                                    删除
                                </button>
                                <button
                                    onClick={() => {
                                        setEditingAnticipation(null);
                                        setAnticipationDraft('');
                                    }}
                                    disabled={savingAnticipation}
                                    style={{
                                        marginLeft: 'auto', padding: '10px 16px', borderRadius: 12,
                                        border: '1px solid #e5e7eb', background: 'white',
                                        color: '#6b7280', fontWeight: 600, cursor: 'pointer',
                                    }}
                                >
                                    取消
                                </button>
                                <button
                                    onClick={handleSaveAnticipation}
                                    disabled={savingAnticipation || !anticipationDraft.trim()}
                                    style={{
                                        padding: '10px 18px', borderRadius: 12,
                                        border: 'none', background: '#7c3aed',
                                        color: 'white', fontWeight: 700, cursor: 'pointer',
                                        opacity: savingAnticipation || !anticipationDraft.trim() ? 0.5 : 1,
                                    }}
                                >
                                    {savingAnticipation ? '保存中…' : '保存'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ─── 全部记忆视图 ────────────────────────────────

    if (view === 'all') {
        const sorted = [...allNodes].sort((a, b) => {
            const dir = allSortDir === 'desc' ? -1 : 1;
            if (allSortBy === 'time') return dir * (a.createdAt - b.createdAt);
            return dir * (a.importance - b.importance);
        });

        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div
                        onClick={() => { setView('palace'); }}
                        style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer' }}
                    >
                        ← 返回宫殿
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>{allNodes.length} 条记忆</div>
                </div>

                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="list" size={18} />
                    <span>全部记忆</span>
                </div>

                {/* 排序控制 */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: '#6b7280' }}>排序：</span>
                    {(['time', 'importance'] as const).map(s => (
                        <button
                            key={s}
                            onClick={() => setAllSortBy(s)}
                            style={{
                                padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                                border: allSortBy === s ? '2px solid #7c3aed' : '1px solid #d4d4d4',
                                background: allSortBy === s ? '#f3f0ff' : 'white',
                                color: allSortBy === s ? '#7c3aed' : '#6b7280',
                                cursor: 'pointer',
                            }}
                        >
                            {s === 'time' ? '时间' : '重要性'}
                        </button>
                    ))}
                    <button
                        onClick={() => setAllSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                        style={{
                            padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                            border: '1px solid #d4d4d4', background: 'white', color: '#6b7280',
                            cursor: 'pointer',
                        }}
                    >
                        {allSortDir === 'desc' ? '↓ 降序' : '↑ 升序'}
                    </button>
                </div>

                {sorted.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40, fontSize: 13 }}>
                        这里还没有整理好的记忆
                    </div>
                ) : (
                    sorted.map((node: MemoryNode) => (
                        <div
                            key={node.id}
                            onClick={() => openMemory(node, 'all')}
                            style={{
                                padding: 12, borderRadius: 10, marginBottom: 8,
                                border: '1px solid #e5e7eb', cursor: 'pointer',
                                backgroundColor: '#fafafa',
                            }}
                        >
                            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{node.content}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                    <RoomIcon room={node.room} size={12} style={{ color: ROOM_COLORS[node.room] }} />
                                    {getRoomLabel(node.room, userProfile?.name)}
                                </span>
                                <span>重要性: {node.importance}</span>
                                <span>{node.mood}</span>
                                <span>{new Date(node.createdAt).toLocaleDateString('zh-CN')}</span>
                                <span>访问 {node.accessCount} 次</span>
                            </div>
                            {node.tags.length > 0 && (
                                <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                    {node.tags.map((t: string) => (
                                        <span key={t} style={{
                                            fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                            backgroundColor: '#f3f0ff', color: '#7c3aed',
                                        }}>{t}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        );
    }

    // ─── 事件盒列表视图 ────────────────────────────────

    if (view === 'boxes') {
        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div
                        onClick={() => { setView('palace'); }}
                        style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer' }}
                    >
                        ← 返回宫殿
                    </div>
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>{allBoxes.length} 个事件盒</div>
                </div>

                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="box" size={18} />
                    <span>事件盒</span>
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 14 }}>
                    按同一事件自动聚合的记忆，点击展开可查看整合回忆、活节点与已归档节点
                </div>

                {allBoxes.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40, fontSize: 13 }}>
                        还没有事件盒 —— 对话中出现关联事件或手动绑定关联时会自动创建
                    </div>
                ) : (
                    allBoxes.map(box => {
                        const expanded = expandedBoxId === box.id;
                        const members = boxMembers[box.id];
                        return (
                            <div
                                key={box.id}
                                style={{
                                    borderRadius: 12, marginBottom: 10,
                                    border: '1px solid #c7d2fe',
                                    background: expanded ? '#f5f7ff' : '#fafbff',
                                    overflow: 'hidden',
                                }}
                            >
                                <div
                                    onClick={() => toggleBoxExpand(box)}
                                    style={{ padding: 12, cursor: 'pointer' }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <div style={{ fontSize: 14, fontWeight: 700, color: '#3730a3', flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <Icon name="box" size={14} />
                                            <span>{box.name || '未命名'}</span>
                                            {box.sealed && <span style={{ fontSize: 10, marginLeft: 4, padding: '1px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e' }}>已封盒</span>}
                                        </div>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); editingBoxId === box.id ? cancelEditBoxMeta() : startEditBoxMeta(box); }}
                                            title="编辑盒名和标签"
                                            style={{
                                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                                                border: '1px solid #c7d2fe',
                                                background: editingBoxId === box.id ? '#e0e7ff' : '#fff',
                                                color: '#6366f1', cursor: 'pointer', padding: 0,
                                            }}
                                        >
                                            <Icon name="pencil" size={12} />
                                        </button>
                                        <div style={{ fontSize: 11, color: '#6366f1' }}>{expanded ? '▲' : '▼'}</div>
                                    </div>
                                    {box.tags.length > 0 && (
                                        <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                            {box.tags.slice(0, 6).map(t => (
                                                <span key={t} style={{
                                                    fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                                    backgroundColor: '#e0e7ff', color: '#4338ca',
                                                }}>{t}</span>
                                            ))}
                                        </div>
                                    )}
                                    <div style={{ fontSize: 10, color: '#6b7280', marginTop: 6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                        <span>活 {box.liveMemoryIds.length}</span>
                                        <span>归档 {box.archivedMemoryIds.length}</span>
                                        {box.compressionCount > 0 && <span>压缩 {box.compressionCount} 次</span>}
                                        <span>更新 {new Date(box.updatedAt).toLocaleDateString('zh-CN')}</span>
                                    </div>
                                </div>

                                {editingBoxId === box.id && (
                                    <div style={{ padding: '0 12px 12px', borderTop: '1px solid #e0e7ff' }}>
                                        <div style={{ fontSize: 10, color: '#6b7280', margin: '10px 0 8px', lineHeight: 1.5 }}>
                                            盒名和标签仅用于召回时的展示抬头，不参与检索打分（改它不影响召回哪些记忆）。
                                            注意：盒子之后再次压缩时，副 API 可能重新生成盒名/标签覆盖你的修改，不满意再改一次即可。
                                        </div>
                                        <label style={{ fontSize: 11, fontWeight: 600, color: '#4338ca' }}>盒名</label>
                                        <input
                                            value={boxNameDraft}
                                            onChange={e => setBoxNameDraft(e.target.value)}
                                            placeholder="未命名事件"
                                            maxLength={40}
                                            style={{
                                                width: '100%', boxSizing: 'border-box', marginTop: 4, marginBottom: 10,
                                                padding: '6px 8px', borderRadius: 6, border: '1px solid #c7d2fe',
                                                fontSize: 13, outline: 'none',
                                            }}
                                        />
                                        <label style={{ fontSize: 11, fontWeight: 600, color: '#4338ca' }}>标签（逗号分隔，最多 20 个）</label>
                                        <input
                                            value={boxTagsDraft}
                                            onChange={e => setBoxTagsDraft(e.target.value)}
                                            placeholder="如：买衣服, 退货, 流行款"
                                            style={{
                                                width: '100%', boxSizing: 'border-box', marginTop: 4, marginBottom: 10,
                                                padding: '6px 8px', borderRadius: 6, border: '1px solid #c7d2fe',
                                                fontSize: 13, outline: 'none',
                                            }}
                                        />
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button
                                                onClick={() => handleSaveBoxMeta(box)}
                                                disabled={savingBox}
                                                style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                    fontSize: 12, padding: '5px 12px', borderRadius: 6, border: 'none',
                                                    background: '#6366f1', color: '#fff',
                                                    cursor: savingBox ? 'default' : 'pointer', opacity: savingBox ? 0.6 : 1,
                                                }}
                                            >
                                                <Icon name="check" size={12} />
                                                <span>{savingBox ? '保存中…' : '保存'}</span>
                                            </button>
                                            <button
                                                onClick={cancelEditBoxMeta}
                                                disabled={savingBox}
                                                style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: 4,
                                                    fontSize: 12, padding: '5px 12px', borderRadius: 6,
                                                    border: '1px solid #d1d5db', background: '#fff', color: '#6b7280',
                                                    cursor: savingBox ? 'default' : 'pointer',
                                                }}
                                            >
                                                <Icon name="x" size={12} />
                                                <span>取消</span>
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {expanded && members && (
                                    <div style={{ padding: '0 12px 12px', borderTop: '1px solid #e0e7ff' }}>
                                        {(members.live.length > 0 || members.archived.length > 0) && (
                                            <div style={{
                                                marginTop: 10, padding: '9px 10px', borderRadius: 8,
                                                border: '1px solid #c7d2fe', background: '#eef2ff',
                                                display: 'flex', alignItems: 'center', gap: 10,
                                            }}>
                                                <div style={{ flex: 1, minWidth: 0, fontSize: 10, lineHeight: 1.45, color: '#6366f1' }}>
                                                    从全部 {members.live.length + members.archived.length} 条原始记忆重做总结，并重新生成语义向量
                                                </div>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); handleRegenerateBoxSummary(box); }}
                                                    disabled={regeneratingBoxId !== null}
                                                    title="不使用旧整合回忆，重新读取全部归档和活节点"
                                                    style={{
                                                        display: 'inline-flex', alignItems: 'center', gap: 4,
                                                        flexShrink: 0, padding: '5px 9px', borderRadius: 7,
                                                        border: '1px solid #a5b4fc', background: '#fff',
                                                        color: '#4f46e5', fontSize: 10, fontWeight: 700,
                                                        cursor: regeneratingBoxId !== null ? 'wait' : 'pointer',
                                                        opacity: regeneratingBoxId !== null && regeneratingBoxId !== box.id ? 0.5 : 1,
                                                    }}
                                                >
                                                    <Icon name="refresh" size={11} />
                                                    <span>{regeneratingBoxId === box.id ? '重新整合中…' : '重新整合'}</span>
                                                </button>
                                            </div>
                                        )}
                                        {members.summary && (
                                            <div
                                                onClick={() => openMemory(members.summary!, 'boxes')}
                                                style={{
                                                    marginTop: 10, padding: 10, borderRadius: 8,
                                                    border: '1px solid #fcd34d', background: '#fef3c7',
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                <div style={{ fontSize: 10, color: '#92400e', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    <Icon name="sparkle" size={11} />
                                                    <span>整合回忆</span>
                                                </div>
                                                <div style={{ fontSize: 12, lineHeight: 1.5, color: '#1f2937' }}>
                                                    {members.summary.content.length > 120 ? members.summary.content.slice(0, 120) + '...' : members.summary.content}
                                                </div>
                                            </div>
                                        )}

                                        {members.live.length > 0 && (
                                            <>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, marginBottom: 4 }}>
                                                    <div style={{ fontSize: 10, fontWeight: 600, color: '#6366f1', display: 'flex', alignItems: 'center', gap: 4 }}>
                                                        <Icon name="box" size={11} />
                                                        <span>活节点（{members.live.length}）</span>
                                                        {members.live.length >= 15 && (
                                                            <span style={{ marginLeft: 4, fontSize: 9, color: '#b91c1c', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                                                <Icon name="warning" size={10} />
                                                                <span>压缩可能连续失败</span>
                                                            </span>
                                                        )}
                                                    </div>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleUnbindAllLive(box); }}
                                                        style={{
                                                            fontSize: 10, padding: '3px 8px', borderRadius: 6,
                                                            border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c',
                                                            cursor: 'pointer',
                                                        }}
                                                        title="把所有活节点移出盒子，变回独立记忆（记忆不删）"
                                                    >
                                                        一键移出活节点
                                                    </button>
                                                </div>
                                                {members.live.map(n => (
                                                    <div
                                                        key={n.id}
                                                        onClick={() => openMemory(n, 'boxes')}
                                                        style={{
                                                            padding: 8, borderRadius: 8, marginBottom: 4,
                                                            border: '1px solid #e0e7ff', background: 'white',
                                                            cursor: 'pointer',
                                                        }}
                                                    >
                                                        <div style={{ fontSize: 12, lineHeight: 1.5, color: '#1f2937' }}>
                                                            {n.content.length > 80 ? n.content.slice(0, 80) + '...' : n.content}
                                                        </div>
                                                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                            <RoomIcon room={n.room} size={11} style={{ color: ROOM_COLORS[n.room] }} />
                                                            <span>{getRoomLabel(n.room, userProfile?.name)} · {new Date(n.createdAt).toLocaleDateString('zh-CN')}</span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </>
                                        )}

                                        {members.archived.length > 0 && (
                                            <>
                                                <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginTop: 10, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    <Icon name="moon" size={11} />
                                                    <span>已归档（{members.archived.length}）</span>
                                                </div>
                                                {members.archived.map(n => (
                                                    <div
                                                        key={n.id}
                                                        onClick={() => openMemory(n, 'boxes')}
                                                        style={{
                                                            padding: 8, borderRadius: 8, marginBottom: 4,
                                                            border: '1px solid #e5e7eb', background: '#f9fafb',
                                                            cursor: 'pointer', opacity: 0.75,
                                                            position: 'relative',
                                                        }}
                                                    >
                                                        <div style={{ fontSize: 12, lineHeight: 1.5, color: '#4b5563', paddingRight: 56 }}>
                                                            {n.content.length > 80 ? n.content.slice(0, 80) + '...' : n.content}
                                                        </div>
                                                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                            <RoomIcon room={n.room} size={11} style={{ color: ROOM_COLORS[n.room] }} />
                                                            <span>{getRoomLabel(n.room, userProfile?.name)} · {new Date(n.createdAt).toLocaleDateString('zh-CN')}</span>
                                                        </div>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleReviveArchived(box, n); }}
                                                            title="复活：把这条记忆单独拎出来，让它重新生效。"
                                                            style={{
                                                                position: 'absolute', top: 6, right: 6,
                                                                fontSize: 10, padding: '3px 8px', borderRadius: 6,
                                                                border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#15803d',
                                                                fontWeight: 600, cursor: 'pointer',
                                                            }}
                                                        >
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                                                <Icon name="sparkle" size={10} />
                                                                <span>复活</span>
                                                            </span>
                                                        </button>
                                                    </div>
                                                ))}
                                            </>
                                        )}

                                        {!members.summary && members.live.length === 0 && members.archived.length === 0 && (
                                            <div style={{ fontSize: 11, color: '#c4c4c4', textAlign: 'center', padding: '12px 0' }}>
                                                盒内暂无成员
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        );
    }

    // ─── 房间详情视图 ────────────────────────────────

    if (view === 'room' && selectedRoom) {
        const roomLabel = getRoomLabel(selectedRoom, userProfile?.name);
        const roomColor = ROOM_COLORS[selectedRoom];

        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div
                        onClick={() => { setView('palace'); setSelectedRoom(null); setSelectMode(false); setSelectedIds(new Set()); }}
                        style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer' }}
                    >
                        ← 返回宫殿
                    </div>
                    {roomNodes.length > 0 && (
                        <div
                            onClick={() => { setSelectMode(!selectMode); setSelectedIds(new Set()); }}
                            style={{ fontSize: 12, color: selectMode ? '#dc2626' : '#6b7280', cursor: 'pointer', fontWeight: 600 }}
                        >
                            {selectMode ? '取消选择' : '选择'}
                        </div>
                    )}
                </div>

                <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: roomColor, display: 'inline-flex' }}><RoomIcon room={selectedRoom} size={26} /></span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: roomColor }}>{roomLabel}</span>
                    <span style={{ fontSize: 12, color: '#9ca3af' }}>{roomNodes.length} 条记忆</span>
                </div>

                {/* 批量删除工具栏 */}
                {selectMode && (
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '8px 12px', borderRadius: 10, marginBottom: 12,
                        background: '#fef2f2', border: '1px solid #fecaca',
                    }}>
                        <div style={{ fontSize: 12, color: '#991b1b' }}>
                            已选 {selectedIds.size} 条
                            <span
                                onClick={() => setSelectedIds(new Set(roomNodes.map(n => n.id)))}
                                style={{ marginLeft: 8, color: '#6b7280', cursor: 'pointer', textDecoration: 'underline' }}
                            >全选</span>
                        </div>
                        <button
                            onClick={handleBatchDelete}
                            disabled={selectedIds.size === 0 || deleting}
                            style={{
                                padding: '4px 12px', borderRadius: 8, border: 'none',
                                fontSize: 12, fontWeight: 700,
                                color: 'white', background: selectedIds.size > 0 ? '#dc2626' : '#d4d4d4',
                                cursor: selectedIds.size > 0 ? 'pointer' : 'not-allowed',
                            }}
                        >
                            {deleting ? '删除中...' : `删除 (${selectedIds.size})`}
                        </button>
                    </div>
                )}

                {roomNodes.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40, fontSize: 13 }}>
                        这个房间还是空的
                    </div>
                ) : (
                    roomNodes.map((node: MemoryNode) => (
                        <div
                            key={node.id}
                            onClick={() => selectMode ? toggleSelect(node.id) : openMemory(node)}
                            style={{
                                padding: 12, borderRadius: 10, marginBottom: 8,
                                border: `1px solid ${selectMode && selectedIds.has(node.id) ? '#dc2626' : '#e5e7eb'}`,
                                cursor: 'pointer',
                                backgroundColor: selectMode && selectedIds.has(node.id) ? '#fef2f2' : '#fafafa',
                            }}
                        >
                            {selectMode && (
                                <div style={{ float: 'right', marginLeft: 8, color: selectedIds.has(node.id) ? '#dc2626' : '#9ca3af', display: 'inline-flex' }}>
                                    <Icon name={selectedIds.has(node.id) ? 'square-check' : 'square'} size={16} />
                                </div>
                            )}
                            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{node.content}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, display: 'flex', gap: 8 }}>
                                <span>重要性: {node.importance}</span>
                                <span>{node.mood}</span>
                                <span>{new Date(node.createdAt).toLocaleDateString('zh-CN')}</span>
                                <span>访问 {node.accessCount} 次</span>
                            </div>
                            {node.tags.length > 0 && (
                                <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                    {node.tags.map((t: string) => (
                                        <span key={t} style={{
                                            fontSize: 10, padding: '1px 6px', borderRadius: 4,
                                            backgroundColor: `${roomColor}22`, color: roomColor,
                                        }}>{t}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </div>
        );
    }

    // ─── 单条记忆详情 ────────────────────────────────

    if (view === 'memory' && selectedNode) {
        const roomColor = ROOM_COLORS[editing ? editRoom : selectedNode.room];
        const MOODS = ['happy', 'sad', 'angry', 'anxious', 'tender', 'peaceful', 'excited', 'nostalgic', 'frustrated', 'hopeful', 'lonely', 'grateful'];

        return (
            <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: SAFE_PAD_TOP, maxHeight: '100%', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div
                        onClick={() => { setView(prevView); setSelectedNode(null); setEditing(false); }}
                        style={{ fontSize: 13, color: '#6b7280', cursor: 'pointer' }}
                    >
                        ← 返回 {prevView === 'all' ? '全部记忆' : prevView === 'boxes' ? '事件盒' : getRoomLabel(selectedRoom || selectedNode.room, userProfile?.name)}
                    </div>
                    {!editing && (
                        <div
                            onClick={() => setEditing(true)}
                            style={{ fontSize: 12, color: '#3b82f6', cursor: 'pointer', fontWeight: 600 }}
                        >
                            编辑
                        </div>
                    )}
                </div>

                <div style={{
                    padding: 16, borderRadius: 12,
                    border: `1px solid ${roomColor}44`,
                    backgroundColor: `${roomColor}08`,
                }}>
                    {editing ? (
                        /* ─── 编辑模式 ─── */
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div>
                                <label className={labelClass}>内容</label>
                                <textarea
                                    value={editContent}
                                    onChange={e => setEditContent(e.target.value)}
                                    className={inputClass}
                                    style={{ minHeight: 100, resize: 'vertical', fontFamily: 'inherit' }}
                                />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                <div>
                                    <label className={labelClass}>房间</label>
                                    <select
                                        value={editRoom}
                                        onChange={e => setEditRoom(e.target.value as MemoryRoom)}
                                        className={inputClass}
                                        style={{ fontFamily: 'inherit' }}
                                    >
                                        {(Object.keys(ROOM_CONFIGS) as MemoryRoom[]).map(r => (
                                            <option key={r} value={r}>{getRoomLabel(r, userProfile?.name)}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className={labelClass}>情绪</label>
                                    <select
                                        value={editMood}
                                        onChange={e => setEditMood(e.target.value)}
                                        className={inputClass}
                                        style={{ fontFamily: 'inherit' }}
                                    >
                                        {MOODS.map(m => <option key={m} value={m}>{m}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label className={labelClass}>重要性: {editImportance}</label>
                                <input
                                    type="range" min="1" max="10" step="1"
                                    value={editImportance}
                                    onChange={e => setEditImportance(parseInt(e.target.value))}
                                    style={{ width: '100%' }}
                                />
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af' }}>
                                    <span>1</span>
                                    <span style={{ color: roomColor, fontWeight: 600 }}>{'★'.repeat(editImportance)}{'☆'.repeat(10 - editImportance)}</span>
                                    <span>10</span>
                                </div>
                            </div>
                            <div>
                                <label className={labelClass}>标签（逗号分隔）</label>
                                <input
                                    value={editTags}
                                    onChange={e => setEditTags(e.target.value)}
                                    className={inputClass}
                                    placeholder="标签1, 标签2, ..."
                                />
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                    onClick={handleSaveEdit}
                                    disabled={saving || !editContent.trim()}
                                    style={{
                                        flex: 1, padding: '10px 0', borderRadius: 10, border: 'none',
                                        fontSize: 13, fontWeight: 700, color: 'white',
                                        background: saving ? '#d4d4d4' : '#3b82f6',
                                        cursor: saving ? 'not-allowed' : 'pointer',
                                    }}
                                >
                                    {saving ? '保存中...' : '保存修改'}
                                </button>
                                <button
                                    onClick={() => {
                                        setEditing(false);
                                        setEditContent(selectedNode.content);
                                        setEditImportance(selectedNode.importance);
                                        setEditMood(selectedNode.mood);
                                        setEditRoom(selectedNode.room);
                                        setEditTags(selectedNode.tags.join(', '));
                                    }}
                                    style={{
                                        padding: '10px 16px', borderRadius: 10, border: '1px solid #e5e7eb',
                                        fontSize: 13, fontWeight: 600, color: '#6b7280', background: 'white',
                                        cursor: 'pointer',
                                    }}
                                >
                                    取消
                                </button>
                            </div>
                        </div>
                    ) : (
                        /* ─── 查看模式 ─── */
                        <>
                            <div style={{ fontSize: 15, lineHeight: 1.6, marginBottom: 12 }}>{selectedNode.content}</div>

                            <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.8 }}>
                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <RoomIcon room={selectedNode.room} size={14} style={{ color: ROOM_COLORS[selectedNode.room] }} />
                                    <span>{getRoomLabel(selectedNode.room, userProfile?.name)}</span>
                                </div>
                                <div>重要性: {'★'.repeat(selectedNode.importance)}{'☆'.repeat(10 - selectedNode.importance)}</div>
                                <div>情绪: {selectedNode.mood}</div>
                                <div>创建: {new Date(selectedNode.createdAt).toLocaleString('zh-CN')}</div>
                                <div>最后访问: {new Date(selectedNode.lastAccessedAt).toLocaleString('zh-CN')}</div>
                                <div>访问次数: {selectedNode.accessCount}</div>
                                {currentBox && <div>事件盒: {currentBox.name || '未命名'}</div>}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <span>向量化:</span>
                                    <span style={{ color: selectedNode.embedded ? '#16a34a' : '#dc2626', display: 'inline-flex' }}>
                                        <Icon name={selectedNode.embedded ? 'check' : 'x'} size={12} />
                                    </span>
                                </div>
                            </div>

                            {selectedNode.tags.length > 0 && (
                                <div style={{ marginTop: 10, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                    {selectedNode.tags.map((t: string) => (
                                        <span key={t} style={{
                                            fontSize: 11, padding: '2px 8px', borderRadius: 6,
                                            backgroundColor: `${roomColor}22`, color: roomColor,
                                        }}>{t}</span>
                                    ))}
                                </div>
                            )}

                            {/* 关联事件 */}
                            <div style={{ marginTop: 14 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                        <Icon name="link" size={12} />
                                        <span>关联事件{linkedMemories.length > 0 ? `（${linkedMemories.length}）` : ''}</span>
                                    </div>
                                    <button
                                        onClick={() => { setShowLinkSearch(!showLinkSearch); setLinkSearchQuery(''); setLinkSearchResults([]); }}
                                        style={{
                                            fontSize: 10, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
                                            border: '1px solid #e0e7ff', background: showLinkSearch ? '#e0e7ff' : 'white',
                                            color: '#6366f1', cursor: 'pointer',
                                        }}
                                    >
                                        {showLinkSearch ? '取消' : '+ 添加关联'}
                                    </button>
                                </div>

                                {/* 搜索添加关联 */}
                                {showLinkSearch && (
                                    <div style={{ marginBottom: 10, padding: 10, borderRadius: 10, border: '1px solid #e0e7ff', background: '#faf9ff' }}>
                                        <input
                                            type="text"
                                            value={linkSearchQuery}
                                            onChange={async (e) => {
                                                const q = e.target.value;
                                                setLinkSearchQuery(q);
                                                if (q.trim().length < 2) { setLinkSearchResults([]); return; }
                                                // 在当前角色的所有记忆中搜索关键词
                                                const allNodes = await MemoryNodeDB.getByCharId(char!.id);
                                                const filtered = allNodes
                                                    .filter(n => n.id !== selectedNode.id && !n.archived && (
                                                        n.content.includes(q.trim()) ||
                                                        n.tags.some(t => t.includes(q.trim()))
                                                    ))
                                                    .sort((a, b) => b.importance - a.importance)
                                                    .slice(0, 8);
                                                setLinkSearchResults(filtered);
                                            }}
                                            placeholder="输入关键词搜索记忆..."
                                            className={inputClass}
                                            style={{ fontSize: 12, marginBottom: 6 }}
                                        />
                                        {linkSearchResults.map(node => {
                                            const alreadyLinked = linkedMemories.some(l => l.node.id === node.id);
                                            return (
                                                <div key={node.id} style={{
                                                    padding: '8px 10px', borderRadius: 8, marginBottom: 4,
                                                    border: '1px solid #e5e7eb', background: 'white',
                                                    display: 'flex', alignItems: 'flex-start', gap: 8,
                                                    opacity: alreadyLinked ? 0.5 : 1,
                                                }}>
                                                    <div style={{ flex: 1 }}>
                                                        <div style={{ fontSize: 11, lineHeight: 1.5, color: '#1f2937' }}>
                                                            {node.content.length > 60 ? node.content.slice(0, 60) + '...' : node.content}
                                                        </div>
                                                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                            <RoomIcon room={node.room} size={11} style={{ color: ROOM_COLORS[node.room] }} />
                                                            <span>{getRoomLabel(node.room, userProfile?.name)} · {new Date(node.createdAt).toLocaleDateString('zh-CN')}</span>
                                                        </div>
                                                    </div>
                                                    <button
                                                        disabled={alreadyLinked}
                                                        onClick={async () => {
                                                            // 新版：绑入 EventBox（取代旧的 causal MemoryLink 单边关联）
                                                            const box = await manuallyBindMemories(char!.id, selectedNode.id, node.id);
                                                            if (box) {
                                                                trackEvent('手动关联两条记忆');
                                                                // 重新加载兄弟列表，展示最新 box 状态
                                                                await loadLinkedMemories(selectedNode.id);
                                                            }
                                                        }}
                                                        style={{
                                                            flexShrink: 0, padding: '4px 10px', borderRadius: 6,
                                                            border: 'none', fontSize: 10, fontWeight: 600,
                                                            color: 'white', background: alreadyLinked ? '#d4d4d4' : '#6366f1',
                                                            cursor: alreadyLinked ? 'not-allowed' : 'pointer',
                                                        }}
                                                    >
                                                        {alreadyLinked ? '已关联' : '绑入事件盒'}
                                                    </button>
                                                </div>
                                            );
                                        })}
                                        {linkSearchQuery.trim().length >= 2 && linkSearchResults.length === 0 && (
                                            <div style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', padding: 8 }}>
                                                没有找到匹配的记忆
                                            </div>
                                        )}
                                    </div>
                                )}

                                {loadingLinks && (
                                    <div style={{ fontSize: 12, color: '#9ca3af' }}>加载中...</div>
                                )}

                                {currentBox && (
                                    <div style={{
                                        padding: '8px 10px', borderRadius: 8, marginBottom: 8,
                                        border: '1px solid #c7d2fe', background: '#eef2ff',
                                        fontSize: 11, lineHeight: 1.5, color: '#3730a3',
                                    }}>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                            <Icon name="box" size={12} />
                                            <span>事件盒：<b>{currentBox.name || '未命名'}</b></span>
                                        </span>
                                        {currentBox.tags.length > 0 && (
                                            <span style={{ color: '#6366f1', fontSize: 10 }}> 〈{currentBox.tags.slice(0, 4).join(' · ')}〉</span>
                                        )}
                                        <span style={{ color: '#6b7280', fontSize: 10 }}>
                                            {' '}· 活 {currentBox.liveMemoryIds.length} 归档 {currentBox.archivedMemoryIds.length}
                                            {currentBox.compressionCount > 0 && ` · 压缩过 ${currentBox.compressionCount} 次`}
                                        </span>
                                    </div>
                                )}

                                {linkedMemories.map(({ id, relation, node: linkedNode }) => {
                                    const isSummary = relation === 'box_summary';
                                    const isArchived = relation === 'box_archived';
                                    const isLegacy = relation === 'legacy_causal';
                                    const bg = isSummary ? '#fef3c7' : isArchived ? '#f5f5f5' : '#f5f3ff';
                                    const border = isSummary ? '#fcd34d' : isArchived ? '#e5e7eb' : '#e0e7ff';
                                    const relationIcon = isSummary ? 'sparkle'
                                        : isArchived ? 'moon'
                                        : isLegacy ? 'link'
                                        : 'box';
                                    const relationText = isSummary ? '整合回忆'
                                        : isArchived ? '已归档'
                                        : isLegacy ? '旧关联'
                                        : '同盒活节点';
                                    return (
                                        <div key={id} style={{
                                            padding: '10px 12px', borderRadius: 10, marginBottom: 6,
                                            border: `1px solid ${border}`, background: bg,
                                            display: 'flex', alignItems: 'flex-start', gap: 8,
                                            opacity: isArchived ? 0.75 : 1,
                                        }}>
                                            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => openMemory(linkedNode, prevView)}>
                                                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    <Icon name={relationIcon} size={11} />
                                                    <span>{relationText}</span>
                                                </div>
                                                <div style={{ fontSize: 12, lineHeight: 1.5, color: '#1f2937' }}>
                                                    {linkedNode.content.length > 80 ? linkedNode.content.slice(0, 80) + '...' : linkedNode.content}
                                                </div>
                                                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    <RoomIcon room={linkedNode.room} size={11} style={{ color: ROOM_COLORS[linkedNode.room] }} />
                                                    <span>{getRoomLabel(linkedNode.room, userProfile?.name)} · {new Date(linkedNode.createdAt).toLocaleDateString('zh-CN')}</span>
                                                </div>
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    if (isLegacy) {
                                                        // 遗留 causal link 删除
                                                        if (confirm('解除这条旧关联？（不会删除记忆本身）')) {
                                                            await MemoryLinkDB.delete(id);
                                                            setLinkedMemories(prev => prev.filter(l => l.id !== id));
                                                        }
                                                    } else if (isSummary) {
                                                        alert('整合回忆是事件盒的压缩产物，不能单独解除；若要重建请删除事件盒所有成员。');
                                                    } else {
                                                        if (confirm('把这条记忆移出事件盒？（记忆本身不删，会回到"地上"作为独立记忆）')) {
                                                            await removeMemoryFromBox(linkedNode.id);
                                                            await loadLinkedMemories(selectedNode!.id);
                                                        }
                                                    }
                                                }}
                                                style={{
                                                    flexShrink: 0, padding: '4px 8px', borderRadius: 6,
                                                    border: '1px solid #e5e7eb', background: 'white',
                                                    fontSize: 10, color: '#9ca3af', cursor: 'pointer',
                                                }}
                                            >
                                                {isSummary ? '查看' : '移出'}
                                            </button>
                                        </div>
                                    );
                                })}

                                {!loadingLinks && linkedMemories.length === 0 && !showLinkSearch && (
                                    <div style={{ fontSize: 11, color: '#c4c4c4', textAlign: 'center', padding: '8px 0' }}>
                                        暂无事件盒关联
                                    </div>
                                )}
                            </div>

                            {/* 删除按钮 */}
                            <button
                                onClick={() => {
                                    if (confirm('确定删除这条记忆？（包括对应的向量和关联）')) {
                                        handleDeleteSingle(selectedNode.id);
                                    }
                                }}
                                disabled={deleting}
                                style={{
                                    marginTop: 16, width: '100%', padding: '10px 0',
                                    borderRadius: 10, border: '1px solid #fecaca',
                                    fontSize: 12, fontWeight: 600,
                                    color: '#dc2626', background: '#fef2f2',
                                    cursor: deleting ? 'not-allowed' : 'pointer',
                                }}
                            >
                                {deleting ? '删除中...' : (
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                        <Icon name="trash" size={13} />
                                        <span>删除这条记忆</span>
                                    </span>
                                )}
                            </button>
                        </>
                    )}
                </div>
            </div>
        );
    }

    return null;
}

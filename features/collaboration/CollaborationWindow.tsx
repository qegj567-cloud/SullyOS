import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowCounterClockwise,
  ArrowUUpLeft,
  Briefcase,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  DownloadSimple,
  Eye,
  FileArrowUp,
  FilePdf,
  FileText,
  Folder,
  GearSix,
  ImageSquare,
  List,
  MagnifyingGlass,
  PaperPlaneRight,
  Plus,
  SpinnerGap,
  Stop,
  Trash,
  X,
} from '@phosphor-icons/react';
import type { APIConfig, ApiPreset, CharacterProfile, ChatTheme, Emoji, EmojiCategory, GroupProfile, Message, RealtimeConfig, UserProfile } from '../../types';
import TokenImg from '../../components/os/TokenImg';
import { bucketFewCount, trackEvent } from '../../utils/analytics';
import { processImageToBlob } from '../../utils/file';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import { describeImageWithVisionApi } from '../../utils/visionApi';
import { loadCollaborationChatHistory, selectCollaborationTransfer } from './chatBridge';
import {
  collaborationProfileFromApi,
  collaborationProfileMatches,
  fetchCollaborationModels,
  hydrateCollaborationApiSettings,
} from './api';
import { buildCollaborationContextSnapshot, buildCollaborationTurnMemoryContext, buildLiveCollaborationChatContext } from './context';
import { runCollaborationTurn, isCollaborationApiConfigured, summarizeCollaborationForMemory } from './engine';
import { collaborationBlobToDataUrl, extractSourceFile, isCollaborationImageFile, materializeArtifact, parseArtifactBlocks } from './files';
import { normalizeCollaborationVisibleText, parseCollaborationMarkdown } from './markdown';
import type { CollaborationInlineSpan } from './markdown';
import { parseCollaborationRichOutput, resolveCollaborationEmoji, sanitizeCollaborationRichOutputSource } from './richOutput';
import { canSynthesizeSpeech, providerUsesRawVoiceMarkup, synthesizeSpeechDetailed } from '../../utils/ttsRouter';
import { CollaborationStore } from './store';
import { COLLABORATION_LIBRARY_GROUP_LABELS, collaborationLibraryGroupOf, type CollaborationLibraryGroup } from './chatLibrary';
import {
  buildInstallablePreviewDocument,
  COLLABORATION_MAKERS,
  COLLABORATION_MAKER_MAP,
  materializeInstallableArtifact,
  parseInstallableArtifactBlocks,
  validateInstallableArtifact,
} from './makers';
import type {
  CollaborationApiProfile,
  CollaborationArtifactFormat,
  CollaborationAvatarMode,
  CollaborationAvatarStyle,
  CollaborationAttachment,
  CollaborationCategory,
  CollaborationChatContextChoice,
  CollaborationContextMessage,
  CollaborationMessage,
  CollaborationInstallableArtifact,
  CollaborationLibraryFile,
  CollaborationMakerKind,
  CollaborationMode,
  CollaborationSession,
  CollaborationSettings,
  CollaborationTransferMessage,
  CollaborationUiTheme,
} from './types';
import {
  DEFAULT_COLLABORATION_SETTINGS,
  collaborationId,
} from './types';

interface CollaborationWindowProps {
  open: boolean;
  character: CharacterProfile;
  user: UserProfile;
  theme: ChatTheme;
  backgroundUrl?: string;
  chatApi: APIConfig;
  apiPresets: ApiPreset[];
  availableModels: string[];
  characters: CharacterProfile[];
  groups: GroupProfile[];
  emojis: Emoji[];
  emojiCategories: EmojiCategory[];
  recentChatMessages: Message[];
  realtimeConfig?: RealtimeConfig;
  chatCollaborationEnabled: boolean;
  requestedPreviewAssetId?: string | null;
  onRequestedPreviewHandled?: () => void;
  onClose: () => void;
  onSendToChat: (title: string, messages: CollaborationTransferMessage[]) => Promise<void>;
  onInstallArtifact: (artifact: CollaborationInstallableArtifact, targetCharacterId?: string) => Promise<string>;
  onArchiveToMemory: (summary: string, occurredAt: number, sourceId: string) => Promise<string>;
  onToggleChatCollaboration: (enabled: boolean) => void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}

type PendingAttachment = { attachment: CollaborationAttachment; blob: Blob };
type SessionFilter = 'active' | 'archived';

const OUTPUT_FORMAT_OPTIONS: Array<{ value: '' | CollaborationArtifactFormat; label: string }> = [
  { value: '', label: '格式：自动' },
  { value: 'docx', label: 'Word (.docx)' },
  { value: 'pdf', label: 'PDF (.pdf)' },
  { value: 'md', label: 'Markdown (.md)' },
  { value: 'txt', label: '纯文本 (.txt)' },
  { value: 'html', label: '网页 (.html)' },
  { value: 'json', label: 'JSON (.json)' },
];

const OUTPUT_FORMAT_LABELS = Object.fromEntries(
  OUTPUT_FORMAT_OPTIONS.filter(option => option.value).map(option => [option.value, option.label]),
) as Record<CollaborationArtifactFormat, string>;

const MODE_LABELS: Record<CollaborationMode, string> = {
  immersive: '沉浸式协同',
  focused: '中度协同',
};

const MODE_DESCRIPTIONS: Record<CollaborationMode, string> = {
  immersive: '和日常聊天使用同一整套角色上下文；最近聊天按设置逐轮实时读取。',
  focused: '保留核心人设、5 条相关记忆；也可只带 10～20 条最近聊天。',
};

const CHAT_CONTEXT_OPTIONS: Array<{ value: CollaborationChatContextChoice; label: string; hint: string }> = [
  { value: 0, label: '不读取', hint: '只看协同窗口' },
  { value: 10, label: '最近 10 条', hint: '更省上下文' },
  { value: 20, label: '最近 20 条', hint: '衔接更完整' },
  { value: 'configured', label: '用户设定范围', hint: '跟随 ChatApp' },
];

const ANALYTICS_UI_THEMES: readonly CollaborationUiTheme[] = ['sully', 'gpt', 'claude', 'gemini', 'kimi', 'deepseek'];
const ANALYTICS_AVATAR_MODES: readonly CollaborationAvatarMode[] = ['theme', 'both', 'character', 'user', 'none'];
const ANALYTICS_AVATAR_STYLES: readonly CollaborationAvatarStyle[] = ['circle', 'rounded', 'portrait'];

const analyticsEnum = (value: string | undefined, allowed: readonly string[], fallback: string): string => (
  value && allowed.includes(value) ? value : fallback
);

const analyticsMakerKind = (value: string | undefined): string => (
  value && Object.prototype.hasOwnProperty.call(COLLABORATION_MAKER_MAP, value) ? value : 'unknown'
);

const COLLABORATION_UI_THEMES: Array<{
  id: CollaborationUiTheme;
  label: string;
  caption: string;
  presence: string;
  emptyTitle: string;
  emptyDescription: string;
  swatches: [string, string, string];
}> = [
  { id: 'sully', label: '角色气泡', caption: 'SullyOS 原生布局', presence: '默认双方头像', emptyTitle: '从一件具体的事开始', emptyDescription: '上传资料或参考图，也可以直接告诉角色想完成什么。', swatches: ['#f4f6fa', '#ffffff', '#6366f1'] },
  { id: 'gpt', label: '黑白助手', caption: '克制的 AI 对话布局', presence: '默认不显示头像', emptyTitle: '有什么可以帮忙完成？', emptyDescription: '输入任务、上传文件或图片，或者选择一个制作能力开始。', swatches: ['#ffffff', '#f4f4f4', '#000000'] },
  { id: 'claude', label: '暖纸长文', caption: '适合阅读与写作', presence: '默认不显示头像', emptyTitle: '今天想一起做些什么？', emptyDescription: '把资料和目标交给角色，适合整理、写作与长文制作。', swatches: ['#f7f6f2', '#eee9df', '#d97757'] },
  { id: 'gemini', label: '渐光协作', caption: '轻盈的助手工作台', presence: '默认只显示角色', emptyTitle: '你好，今天一起完成什么？', emptyDescription: '角色会带着最近聊天里的连续感，在这里专心处理任务。', swatches: ['#ffffff', '#eef3ff', '#4d75e8'] },
  { id: 'kimi', label: '轻量资料', caption: '资料与文档优先', presence: '默认不显示头像', emptyTitle: '嗨，想从什么任务开始？', emptyDescription: '上传长文档、参考图或直接描述目标，角色会整理好再交付。', swatches: ['#f6f8fc', '#ffffff', '#2864ff'] },
  { id: 'deepseek', label: '理性工作台', caption: '清楚的推理分区', presence: '默认不显示头像', emptyTitle: '有什么可以帮到你？', emptyDescription: '描述问题或上传资料、图片，角色会按步骤分析并完成。', swatches: ['#f5f7fb', '#ffffff', '#4d6bfe'] },
];
type CollaborationUiThemeSpec = (typeof COLLABORATION_UI_THEMES)[number];

const THEME_AVATAR_MODE: Record<CollaborationUiTheme, Exclude<CollaborationAvatarMode, 'theme'>> = {
  sully: 'both',
  gpt: 'none',
  claude: 'none',
  gemini: 'character',
  kimi: 'none',
  deepseek: 'none',
};

const COLLABORATION_UI_THEME_CSS = `
.collab-ui-root{--collab-bg:#f4f6fa;--collab-panel:rgba(255,255,255,.84);--collab-panel-solid:#fff;--collab-ink:#1e293b;--collab-muted:#94a3b8;--collab-line:rgba(148,163,184,.28);--collab-accent:#6366f1;--collab-user:#6366f1;--collab-user-ink:#fff;background-color:var(--collab-bg)!important;color:var(--collab-ink)}
.collab-safe-header{height:calc(4rem + var(--safe-top,0px))!important;padding-top:var(--safe-top,0px)}
.collab-brand-mark,.collab-brand-label,.collab-assistant-mark,.collab-empty-brand,.collab-empty-companion{display:none}
.collab-mode-brand,.collab-mode-brand-title{display:none}
.collab-ui-gpt{--collab-bg:#fff;--collab-panel:#fff;--collab-panel-solid:#fff;--collab-ink:#0d0d0d;--collab-muted:#676767;--collab-line:#dedede;--collab-accent:#000;--collab-user:#f4f4f4;--collab-user-ink:#0d0d0d}
.collab-ui-claude{--collab-bg:#f7f6f2;--collab-panel:#f7f6f2;--collab-panel-solid:#fff;--collab-ink:#292522;--collab-muted:#756f69;--collab-line:#ddd8ce;--collab-accent:#d97757;--collab-user:#eee9df;--collab-user-ink:#292522}
.collab-ui-gemini{--collab-bg:#fff;--collab-panel:rgba(255,255,255,.96);--collab-panel-solid:#fff;--collab-ink:#1f1f1f;--collab-muted:#5f6368;--collab-line:#dfe3eb;--collab-accent:#315ed1;--collab-user:#eef3ff;--collab-user-ink:#1f1f1f;background-image:radial-gradient(circle at 50% 32%,rgba(89,121,232,.08),transparent 27%)!important}
.collab-ui-kimi{--collab-bg:#f6f8fc;--collab-panel:rgba(255,255,255,.96);--collab-panel-solid:#fff;--collab-ink:#202331;--collab-muted:#7b8193;--collab-line:#e7eaf1;--collab-accent:#2864ff;--collab-user:#e9efff;--collab-user-ink:#172453}
.collab-ui-deepseek{--collab-bg:#f5f7fb;--collab-panel:rgba(255,255,255,.96);--collab-panel-solid:#fff;--collab-ink:#202739;--collab-muted:#778099;--collab-line:#e3e8f2;--collab-accent:#4d6bfe;--collab-user:#e8edff;--collab-user-ink:#20367d}
.collab-ui-root:not(.collab-ui-sully) .collab-ui-header,.collab-ui-root:not(.collab-ui-sully) .collab-ui-composer,.collab-ui-root:not(.collab-ui-sully) .collab-settings-panel{background:var(--collab-panel)!important;border-color:var(--collab-line)!important;color:var(--collab-ink)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-entry-chooser{background:var(--collab-bg);color:var(--collab-ink)}
.collab-ui-root:not(.collab-ui-sully) .collab-entry-chooser h2,.collab-ui-root:not(.collab-ui-sully) .collab-entry-chooser button span{color:var(--collab-ink)}
.collab-ui-root:not(.collab-ui-sully) .collab-entry-chooser p,.collab-ui-root:not(.collab-ui-sully) .collab-entry-chooser button span+span{color:var(--collab-muted)}
.collab-ui-root:not(.collab-ui-sully) .collab-thinking{background:color-mix(in srgb,var(--collab-accent) 5%,var(--collab-panel-solid));border-color:var(--collab-line);color:var(--collab-ink)}
.collab-ui-root:not(.collab-ui-sully) .collab-ui-header{height:calc(56px + var(--safe-top,0px))!important;box-shadow:none!important;padding-inline:8px;padding-top:var(--safe-top,0px)}
.collab-ui-root:not(.collab-ui-sully) .collab-ui-header button{color:var(--collab-ink)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-header-identity{justify-content:flex-start!important;gap:9px!important}
.collab-ui-root:not(.collab-ui-sully) .collab-header-avatar{display:none}
.collab-ui-root:not(.collab-ui-sully) .collab-brand-mark{display:grid;width:27px;height:27px;flex:none;place-items:center;border-radius:9px;background:var(--collab-accent);color:#fff;font-size:14px;font-weight:700}
.collab-ui-root:not(.collab-ui-sully) .collab-brand-label{display:inline;font-size:14px;font-weight:650;color:var(--collab-ink)}
.collab-ui-root:not(.collab-ui-sully) .collab-session-title{font-size:14px;font-weight:650;color:var(--collab-ink)}
.collab-ui-root:not(.collab-ui-sully) .collab-session-title:before{content:none}
.collab-ui-root:not(.collab-ui-sully) .collab-session-dot{display:none}
.collab-ui-root:not(.collab-ui-sully) .collab-header-meta{font-size:9px;color:var(--collab-muted)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-ui-thread{padding-top:22px;background:var(--collab-bg)}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-picker{background:var(--collab-bg);color:var(--collab-ink);padding-top:44px}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-hero{gap:13px}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-avatar{display:none}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-brand{display:grid;width:48px;height:48px;flex:none;place-items:center;border-radius:15px;background:var(--collab-accent);color:#fff;font-size:23px;font-weight:700}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-kicker{display:none}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-brand-title{display:inline;color:var(--collab-ink)}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-role-title{display:block;margin-top:2px;color:var(--collab-ink);font-size:24px;font-weight:650}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-subtitle{color:var(--collab-muted)!important;font-size:12px}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-explanation{border-color:color-mix(in srgb,var(--collab-accent) 35%,transparent);color:var(--collab-ink)}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-explanation p,.collab-ui-root:not(.collab-ui-sully) .collab-mode-explanation dt{color:var(--collab-ink)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-explanation dd{color:var(--collab-muted)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-options{border-color:var(--collab-line);margin-top:42px}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-option{border-color:var(--collab-line)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-option-title{color:var(--collab-ink)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-option-description{color:var(--collab-muted)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-mode-footnote{color:var(--collab-muted)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-message-row{width:min(100%,760px);max-width:100%;min-width:0;margin-inline:auto;align-items:flex-start;padding:10px 18px;gap:12px;box-sizing:border-box}
.collab-ui-root:not(.collab-ui-sully) .collab-message-avatar{display:none}
.collab-ui-root:not(.collab-ui-sully) .collab-assistant-mark{display:grid;width:25px;height:25px;flex:none;place-items:center;margin-top:2px;border-radius:8px;background:var(--collab-accent);color:#fff;font-size:13px;font-weight:700}
.collab-ui-root:not(.collab-ui-sully) .collab-message-row-user{justify-content:flex-start;flex-direction:row-reverse}
.collab-ui-root:not(.collab-ui-sully) .collab-message-stack{min-width:0;max-width:85%}
.collab-ui-root:not(.collab-ui-sully) .collab-message-bubble{box-shadow:none!important;border:0!important;font-size:15px;line-height:1.75}
.collab-ui-root:not(.collab-ui-sully) .collab-message-bubble-assistant{background:transparent!important;color:var(--collab-ink)!important;padding:1px 0!important;border-radius:0!important}
.collab-ui-root:not(.collab-ui-sully) .collab-message-bubble-user{background:var(--collab-user)!important;color:var(--collab-user-ink)!important;padding:10px 16px!important;border-radius:20px!important}
.collab-ui-root:not(.collab-ui-sully) .collab-message-time{display:none}
.collab-ui-root:not(.collab-ui-sully) .collab-message-system{background:color-mix(in srgb,var(--collab-ink) 6%,transparent)!important;color:var(--collab-muted)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-empty-avatar{display:none}
.collab-ui-root:not(.collab-ui-sully) .collab-empty-brand{display:grid;width:48px;height:48px;place-items:center;border-radius:15px;background:var(--collab-accent);color:#fff;font-size:24px;font-weight:700;box-shadow:0 8px 26px color-mix(in srgb,var(--collab-accent) 22%,transparent)}
.collab-ui-root:not(.collab-ui-sully) .collab-empty-state h2{color:var(--collab-ink)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-empty-state p{color:var(--collab-muted)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-empty-starter{border-color:var(--collab-line)!important;background:var(--collab-panel-solid)!important;color:var(--collab-ink)!important;box-shadow:none!important}
.collab-ui-root:not(.collab-ui-sully) .collab-ui-composer{border-top:0!important;padding-top:8px}
.collab-ui-root:not(.collab-ui-sully) .collab-composer-tools,.collab-ui-root:not(.collab-ui-sully) .collab-composer-field{width:min(100%,760px);margin-inline:auto}
.collab-ui-root:not(.collab-ui-sully) .collab-composer-field{background:var(--collab-panel-solid)!important;border-color:var(--collab-line)!important;box-shadow:0 5px 22px rgba(20,28,45,.08)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-composer-field textarea{color:var(--collab-ink)!important}
.collab-ui-root:not(.collab-ui-sully) .collab-primary-action{background:var(--collab-accent)!important;color:#fff!important}
.collab-ui-root:not(.collab-ui-sully) .collab-accent-chip{background:color-mix(in srgb,var(--collab-accent) 11%,var(--collab-panel-solid))!important;color:var(--collab-accent)!important}
.collab-ui-gpt .collab-brand-mark,.collab-ui-gpt .collab-empty-brand{background:#000;border-radius:50%}
.collab-ui-gpt .collab-mode-brand{background:#000;border-radius:50%}
.collab-ui-gpt .collab-mode-option-icon{background:#f4f4f4!important;color:#111!important;border-radius:50%!important}
.collab-ui-gpt .collab-assistant-mark{background:#000;border-radius:50%}
.collab-ui-gpt .collab-composer-field{border-radius:24px!important;box-shadow:0 2px 10px rgba(0,0,0,.08)!important}
.collab-ui-claude .collab-brand-mark,.collab-ui-claude .collab-empty-brand,.collab-ui-claude .collab-assistant-mark{background:transparent;color:#c75f3c;font-size:20px}
.collab-ui-claude .collab-mode-brand{background:transparent;color:#c75f3c;font-size:29px}
.collab-ui-claude .collab-mode-brand-title,.collab-ui-claude .collab-mode-explanation>p{font-family:Georgia,'Times New Roman',serif}
.collab-ui-claude .collab-mode-option-icon{background:#eee9df!important;color:#b95e41!important;border-radius:14px!important}
.collab-ui-claude .collab-empty-state h2{font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:25px}
.collab-ui-claude .collab-message-bubble-assistant{font-family:Georgia,'Times New Roman',serif;font-size:15.5px}
.collab-ui-claude .collab-composer-field{border-radius:16px!important;box-shadow:0 3px 14px rgba(74,61,49,.07)!important}
.collab-ui-gemini .collab-brand-mark,.collab-ui-gemini .collab-empty-brand,.collab-ui-gemini .collab-assistant-mark{background:linear-gradient(135deg,#3f7ee8,#9c59d1)}
.collab-ui-gemini .collab-mode-brand{background:linear-gradient(135deg,#3f7ee8,#9c59d1)}
.collab-ui-gemini .collab-mode-avatar{display:block;width:31px;height:31px;border-radius:11px;margin-left:-22px;margin-top:38px;z-index:1;border:3px solid #fff}
.collab-ui-gemini .collab-mode-option-icon{background:#eef3ff!important;color:#4975df!important}
.collab-ui-gemini .collab-header-avatar{display:block;width:25px;height:25px;border-radius:9px;order:2}
.collab-ui-gemini .collab-message-avatar-assistant{display:block;width:27px;height:27px;border-radius:9px;order:-1}
.collab-ui-gemini .collab-message-row-assistant .collab-assistant-mark{display:none}
.collab-ui-gemini .collab-empty-companion{display:block;position:absolute;width:32px;height:32px;border-radius:11px;right:-8px;bottom:-7px;border:3px solid #fff;object-fit:cover}
.collab-ui-gemini .collab-empty-brand-wrap{position:relative}
.collab-ui-gemini .collab-empty-state h2{background:linear-gradient(90deg,#3576df,#8f55c8);-webkit-background-clip:text;background-clip:text;color:transparent!important}
.collab-ui-kimi .collab-brand-mark,.collab-ui-kimi .collab-empty-brand,.collab-ui-kimi .collab-assistant-mark{background:#111936;color:#fff;border-radius:11px}
.collab-ui-kimi .collab-mode-brand{background:#111936;border-radius:14px}
.collab-ui-kimi .collab-mode-option{margin:8px 0;padding:18px 15px!important;border:1px solid var(--collab-line)!important;border-radius:17px;background:#fff}
.collab-ui-kimi .collab-mode-options{border:0!important}
.collab-ui-kimi .collab-mode-option-icon{background:#eef2ff!important;color:#2864ff!important}
.collab-ui-kimi .collab-message-row-assistant{margin-top:2px;margin-bottom:2px}
.collab-ui-kimi .collab-message-bubble-assistant{background:#fff!important;border:1px solid var(--collab-line)!important;border-radius:16px!important;padding:13px 15px!important}
.collab-ui-kimi .collab-composer-field{border-radius:18px!important;border-color:#dfe4ee!important}
.collab-ui-deepseek .collab-brand-mark,.collab-ui-deepseek .collab-empty-brand,.collab-ui-deepseek .collab-assistant-mark{background:#4d6bfe;border-radius:10px}
.collab-ui-deepseek .collab-mode-brand{background:#4d6bfe;border-radius:12px}
.collab-ui-deepseek .collab-mode-option{margin:7px 0;padding:18px 14px!important;border:1px solid var(--collab-line)!important;border-radius:14px;background:#fff}
.collab-ui-deepseek .collab-mode-options{border:0!important}
.collab-ui-deepseek .collab-mode-option-icon{background:#edf1ff!important;color:#4d6bfe!important}
.collab-ui-deepseek .collab-message-bubble-assistant{background:#fff!important;border:1px solid var(--collab-line)!important;border-radius:14px!important;padding:13px 15px!important}
.collab-ui-deepseek .collab-composer-field{border-radius:14px!important}
.collab-brand-mark,.collab-brand-label,.collab-assistant-mark,.collab-empty-brand,.collab-mode-brand,.collab-mode-brand-title,.collab-empty-companion{display:none!important}
.collab-ui-root.collab-avatar-none .collab-message-avatar,.collab-ui-root.collab-avatar-none .collab-header-avatar,.collab-ui-root.collab-avatar-none .collab-mode-avatar,.collab-ui-root.collab-avatar-none .collab-empty-avatar{display:none!important}
.collab-ui-root.collab-avatar-user .collab-message-avatar-assistant,.collab-ui-root.collab-avatar-user .collab-header-avatar,.collab-ui-root.collab-avatar-user .collab-mode-avatar,.collab-ui-root.collab-avatar-user .collab-empty-avatar{display:none!important}
.collab-ui-root.collab-avatar-character .collab-message-avatar-user{display:none!important}
.collab-ui-root.collab-avatar-both .collab-message-avatar,.collab-ui-root.collab-avatar-user .collab-message-avatar-user,.collab-ui-root.collab-avatar-character .collab-message-avatar-assistant,.collab-ui-root.collab-avatar-character .collab-header-avatar,.collab-ui-root.collab-avatar-character .collab-mode-avatar,.collab-ui-root.collab-avatar-character .collab-empty-avatar,.collab-ui-root.collab-avatar-both .collab-header-avatar,.collab-ui-root.collab-avatar-both .collab-mode-avatar,.collab-ui-root.collab-avatar-both .collab-empty-avatar{display:block!important}
.collab-avatar-style-circle .collab-message-avatar,.collab-avatar-style-circle .collab-header-avatar,.collab-avatar-style-circle .collab-mode-avatar,.collab-avatar-style-circle .collab-empty-avatar{border-radius:999px!important}
.collab-avatar-style-rounded .collab-message-avatar,.collab-avatar-style-rounded .collab-header-avatar{border-radius:9px!important}
.collab-avatar-style-rounded .collab-mode-avatar,.collab-avatar-style-rounded .collab-empty-avatar{border-radius:18px!important}
.collab-avatar-style-portrait .collab-message-avatar{width:38px!important;height:48px!important;border-radius:12px!important}
.collab-avatar-style-portrait .collab-header-avatar{width:29px!important;height:36px!important;border-radius:9px!important}
.collab-avatar-style-portrait .collab-mode-avatar{width:54px!important;height:68px!important;border-radius:16px!important}
.collab-avatar-style-portrait .collab-empty-avatar{width:68px!important;height:86px!important;border-radius:20px!important}
.collab-message-row{width:100%;max-width:100%;min-width:0;box-sizing:border-box}
.collab-message-stack{min-width:0}
.collab-message-bubble{min-width:0;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}
`;

const shortPreview = (value: string, max = 52): string => {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
};

const readableSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const monthDay = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

const collaborationDateRange = (startAt: number, endAt: number): string => {
  const start = monthDay(startAt);
  const end = monthDay(endAt);
  return start === end ? start : `${start}～${end}`;
};

const withAlpha = (color: string | undefined, alpha: number, fallback: string): string => {
  if (!color) return fallback;
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return color;
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0.18, Math.min(1, alpha))})`;
};

const cloneDefaultSettings = (): CollaborationSettings => ({
  ...DEFAULT_COLLABORATION_SETTINGS,
  immersive: { ...DEFAULT_COLLABORATION_SETTINGS.immersive },
  focused: { ...DEFAULT_COLLABORATION_SETTINGS.focused },
});

const abortCollaborationRequest = (controller: AbortController | null, reason: string): void => {
  if (!controller || controller.signal.aborted) return;
  try {
    controller.abort(new DOMException(reason, 'AbortError'));
  } catch {
    controller.abort();
  }
};

const collaborationMessageTaskText = (message: CollaborationMessage): string => [
  message.content,
  ...(message.attachments || []).map(attachment => attachment.extractedText || ''),
].join('\n').slice(0, 80_000);

const collaborationMessagePreview = (message?: CollaborationMessage): string | undefined => {
  if (!message) return undefined;
  if (message.role === 'assistant') {
    const rich = parseCollaborationRichOutput(message.content);
    const label = rich.text
      || (rich.voice ? '[语音]' : '')
      || (rich.emojiNames.length > 0 ? `[表情包：${rich.emojiNames[0]}]` : '');
    return shortPreview(label || message.attachments?.[0]?.name || '已完成');
  }
  return shortPreview(message.content || message.attachments?.[0]?.name || (message.role === 'system' ? '系统提示' : '上传了文件'));
};

const copyCollaborationText = async (text: string): Promise<boolean> => {
  if (!text.trim()) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Older iOS PWAs may expose clipboard but reject it. Fall through.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
};

type CollaborationDialogResult = 'confirm' | 'secondary' | 'destructive' | 'cancel';
type CollaborationDialogTone = 'default' | 'danger' | 'warning';

interface CollaborationDialogRequest {
  title: string;
  description: string;
  detail?: string;
  confirmLabel?: string;
  secondaryLabel?: string;
  destructiveLabel?: string;
  cancelLabel?: string;
  tone?: CollaborationDialogTone;
}

interface CollaborationDialogState extends CollaborationDialogRequest {
  resolve: (result: CollaborationDialogResult) => void;
}

const CollaborationActionDialog: React.FC<{
  dialog: CollaborationDialogState | null;
  onResolve: (result: CollaborationDialogResult) => void;
}> = ({ dialog, onResolve }) => {
  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onResolve('cancel');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dialog, onResolve]);
  if (!dialog) return null;
  const danger = dialog.tone === 'danger';
  const warning = dialog.tone === 'warning';
  return (
    <div className="absolute inset-0 z-[140] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby="collaboration-dialog-title">
      <button type="button" aria-label="关闭确认弹窗" onClick={() => onResolve('cancel')} className="absolute inset-0 bg-slate-950/35 backdrop-blur-[2px] animate-[collabFade_.16s_ease-out]" />
      <section className="collab-action-dialog relative mx-3 mb-[max(.75rem,env(safe-area-inset-bottom))] w-[calc(100%-1.5rem)] max-w-[430px] overflow-hidden rounded-[26px] border border-white/65 bg-white/96 shadow-[0_28px_90px_rgba(15,23,42,.28)] backdrop-blur-2xl animate-[collabSheetIn_.22s_cubic-bezier(.2,.8,.2,1)] sm:mb-0">
        <div className="px-6 pb-5 pt-6 text-left">
          <span className={`grid h-11 w-11 place-items-center rounded-[15px] ${danger ? 'bg-rose-50 text-rose-600' : warning ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-700'}`}>
            {danger ? <Trash size={21} weight="fill" /> : <Archive size={21} weight="duotone" />}
          </span>
          <h2 id="collaboration-dialog-title" className="mt-4 text-[18px] font-semibold tracking-tight text-slate-900">{dialog.title}</h2>
          <p className="mt-2 text-[12px] leading-5 text-slate-500">{dialog.description}</p>
          {dialog.detail && <p className={`mt-3 rounded-[14px] px-3.5 py-3 text-[10px] leading-[1.65] ${danger ? 'bg-rose-50/80 text-rose-700' : warning ? 'bg-amber-50/80 text-amber-800' : 'bg-slate-50 text-slate-500'}`}>{dialog.detail}</p>}
        </div>
        <div className="border-t border-slate-100 px-3 pb-3 pt-2.5">
          {dialog.confirmLabel && (
            <button type="button" onClick={() => onResolve('confirm')} className={`w-full rounded-[16px] px-4 py-3.5 text-[13px] font-semibold text-white transition active:scale-[.985] ${danger ? 'bg-rose-600 active:bg-rose-700' : warning ? 'bg-amber-600 active:bg-amber-700' : 'bg-slate-900 active:bg-slate-800'}`}>
              {dialog.confirmLabel}
            </button>
          )}
          {dialog.secondaryLabel && (
            <button type="button" onClick={() => onResolve('secondary')} className="mt-1.5 w-full rounded-[16px] px-4 py-3 text-[12px] font-semibold text-slate-600 active:bg-slate-50">
              {dialog.secondaryLabel}
            </button>
          )}
          {dialog.destructiveLabel && (
            <button type="button" onClick={() => onResolve('destructive')} className="mt-1 w-full rounded-[16px] px-4 py-3 text-[12px] font-semibold text-rose-600 active:bg-rose-50">
              {dialog.destructiveLabel}
            </button>
          )}
          <button type="button" onClick={() => onResolve('cancel')} className="mt-0.5 w-full rounded-[16px] bg-slate-50 px-4 py-3 text-[12px] font-semibold text-slate-700 active:bg-slate-100">
            {dialog.cancelLabel || '取消'}
          </button>
        </div>
      </section>
    </div>
  );
};

const CollaborationMessageEditor: React.FC<{
  message: CollaborationMessage | null;
  value: string;
  saving: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}> = ({ message, value, saving, onChange, onCancel, onSave }) => {
  if (!message) return null;
  const regenerates = message.role === 'user';
  return (
    <div className="absolute inset-0 z-[140] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby="collaboration-message-editor-title">
      <button type="button" aria-label="关闭消息编辑" onClick={onCancel} className="absolute inset-0 bg-slate-950/35 backdrop-blur-[2px]" />
      <section className="relative mx-3 mb-[max(.75rem,env(safe-area-inset-bottom))] w-[calc(100%-1.5rem)] max-w-[520px] rounded-[26px] border border-white/70 bg-white p-5 shadow-[0_28px_90px_rgba(15,23,42,.28)] sm:mb-0">
        <h2 id="collaboration-message-editor-title" className="text-[17px] font-semibold text-slate-900">编辑{regenerates ? '自己的消息' : '这条回复'}</h2>
        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
          {regenerates ? '保存后会从这里重新生成，后面的旧回复与后续分支会移除。' : '只修改显示内容，不会重新调用模型。'}
        </p>
        <textarea
          autoFocus
          value={value}
          onChange={event => onChange(event.target.value)}
          className="mt-4 min-h-40 w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-800 outline-none focus:border-slate-400"
        />
        <div className="mt-4 flex gap-2.5">
          <button type="button" onClick={onCancel} disabled={saving} className="flex-1 rounded-2xl bg-slate-100 px-4 py-3 text-xs font-semibold text-slate-700 disabled:opacity-45">取消</button>
          <button type="button" onClick={onSave} disabled={saving || !value.trim()} className="flex-[1.5] rounded-2xl bg-slate-900 px-4 py-3 text-xs font-semibold text-white disabled:opacity-45">
            {saving ? '保存中…' : regenerates ? '保存并重新生成' : '保存修改'}
          </button>
        </div>
      </section>
    </div>
  );
};

const CollaborationEntryChooser: React.FC<{
  character: CharacterProfile;
  sessions: CollaborationSession[];
  onNew: () => void;
  onHistory: () => void;
}> = ({ character, sessions, onNew, onHistory }) => {
  const activeCount = sessions.filter(session => !session.archivedAt).length;
  const archivedCount = sessions.length - activeCount;
  return (
    <div className="collab-entry-chooser flex flex-1 flex-col overflow-y-auto px-6 pb-10 pt-12 sm:px-10">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center">
        <div className="collab-entry-hero flex items-center gap-4 animate-[collabRise_.28s_ease-out]">
          <TokenImg value={character.avatar} alt={character.name} className="collab-mode-avatar h-16 w-16 rounded-[22px] object-cover shadow-sm ring-1 ring-black/5" />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">Collaboration</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-800">这次要做什么？</h2>
            <p className="mt-1 text-sm text-slate-500">新任务不会继承旧窗口的上下文。</p>
          </div>
        </div>

        <div className="mt-12 border-y border-slate-200/80 animate-[collabRise_.34s_ease-out]">
          <button type="button" onClick={onNew} className="group flex w-full items-center gap-4 border-b border-slate-200/80 py-6 text-left transition-colors hover:bg-white/55 active:bg-white/80">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-indigo-600 text-white shadow-[0_10px_28px_rgba(79,70,229,.22)]"><Plus size={22} weight="bold" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[17px] font-semibold text-slate-800">新建协同</span>
              <span className="mt-1 block text-sm text-slate-500">从空白窗口开始，再选择沉浸式或中度协同。</span>
            </span>
            <span className="text-xl text-slate-300 transition-transform group-hover:translate-x-1">→</span>
          </button>
          <button type="button" onClick={onHistory} className="group flex w-full items-center gap-4 py-6 text-left transition-colors hover:bg-white/55 active:bg-white/80">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-slate-200 text-slate-600"><List size={22} weight="bold" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[17px] font-semibold text-slate-800">选择旧记录</span>
              <span className="mt-1 block text-sm text-slate-500">{activeCount} 个进行中{archivedCount > 0 ? ` · ${archivedCount} 个已归档` : ''}</span>
            </span>
            <span className="text-xl text-slate-300 transition-transform group-hover:translate-x-1">→</span>
          </button>
        </div>
        <p className="mt-6 text-xs leading-relaxed text-slate-400">只有你亲自选择旧记录后，才会重新进入那个窗口。</p>
      </div>
    </div>
  );
};

const ModePicker: React.FC<{
  character: CharacterProfile;
  onChoose: (mode: CollaborationMode) => void;
  onBack?: () => void;
}> = ({ character, onChoose, onBack }) => (
    <div className="collab-mode-picker flex flex-1 flex-col overflow-y-auto px-6 pb-8 pt-10 sm:px-10">
    <div className="mx-auto w-full max-w-xl">
       {onBack && <button type="button" onClick={onBack} className="mb-6 flex items-center gap-1 text-[11px] font-semibold text-slate-400 active:text-slate-700"><CaretLeft size={14} />返回新建 / 旧记录</button>}
       <div className="collab-mode-hero flex items-center gap-4">
        <TokenImg value={character.avatar} alt={character.name} className="collab-mode-avatar h-16 w-16 rounded-[22px] object-cover shadow-sm ring-1 ring-black/5" />
        <div className="min-w-0">
          <p className="collab-mode-kicker text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">Collaboration</p>
          <h2 className="collab-mode-role-title mt-1 text-2xl font-semibold tracking-tight text-slate-800">和 {character.name} 一起做</h2>
          <p className="collab-mode-subtitle mt-1 text-sm text-slate-500">选择这个窗口携带多少陪伴上下文。</p>
        </div>
       </div>

       <section className="collab-mode-explanation mt-8 border-l-2 border-indigo-200 pl-4 text-left">
         <p className="text-[13px] font-medium leading-6 text-slate-700">“你好。这里是我和你单独办正事的地方，先把规则说直白一点。”</p>
         <dl className="mt-4 space-y-3 text-[11px] leading-5 text-slate-500">
           <div><dt className="font-semibold text-slate-700">这是什么？</dt><dd>独立在 ChatApp 外围的工作窗口。我仍然是 {character.name}，但会把更多注意力放在拆解、制作、检查和交付上。</dd></div>
           <div><dt className="font-semibold text-slate-700">两个模式差在哪？</dt><dd><b>沉浸式</b>会带日常聊天同款完整上下文和最近聊天，最像刚从聊天里一起过来；<b>中度</b>只记得我们是谁和最多 5 条相关记忆，更轻、更专心办事。</dd></div>
           <div><dt className="font-semibold text-slate-700">会进入角色记忆吗？</dt><dd>默认不会。你可以手动把内容发回聊天，让它走日常聊天自己的记忆流程；也可以在归档窗口时选择只写入一条总结。</dd></div>
           <div><dt className="font-semibold text-slate-700">“让角色在日常聊天中知道协同功能”有什么用？</dt><dd>开启后，{character.name} 会知道你们另有一个独立工作区，也能读取并发送文件柜里已有的文件。普通聊天不会变成工作模式，不能在那里新建、修改或整理文件；真正干活仍要进入这里。</dd></div>
         </dl>
       </section>

       <div className="collab-mode-options mt-12 border-y border-slate-200/80">
        {(['immersive', 'focused'] as CollaborationMode[]).map((mode, index) => (
          <button
            key={mode}
            type="button"
            onClick={() => onChoose(mode)}
            className={`collab-mode-option group flex w-full items-center gap-4 py-6 text-left transition-colors hover:bg-white/55 active:bg-white/80 ${index === 0 ? 'border-b border-slate-200/80' : ''}`}
          >
            <span className={`collab-mode-option-icon grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${mode === 'immersive' ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-200 text-slate-600'}`}>
              {mode === 'immersive' ? <Briefcase size={23} weight="fill" /> : <FileText size={23} weight="bold" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="collab-mode-option-title block text-[17px] font-semibold text-slate-800">{MODE_LABELS[mode]}</span>
              <span className="collab-mode-option-description mt-1 block text-sm leading-relaxed text-slate-500">{MODE_DESCRIPTIONS[mode]}</span>
            </span>
            <span className="text-xl text-slate-300 transition-transform group-hover:translate-x-1">→</span>
          </button>
        ))}
      </div>

      <p className="collab-mode-footnote mt-6 text-xs leading-relaxed text-slate-400">
        每个窗口都有独立上下文，不会读取其它协同窗口，也不会自动写回日常聊天。
      </p>
    </div>
  </div>
);

const ApiSettingsPanel: React.FC<{
  settings: CollaborationSettings;
  character: CharacterProfile;
  user: UserProfile;
  chatCollaborationEnabled: boolean;
  chatApi: APIConfig;
  apiPresets: ApiPreset[];
  availableModels: string[];
  onToggleChatCollaboration: (enabled: boolean) => void;
  onSave: (settings: CollaborationSettings) => Promise<void>;
  onClose: () => void;
}> = ({ settings, character, user, chatCollaborationEnabled, chatApi, apiPresets, availableModels, onToggleChatCollaboration, onSave, onClose }) => {
  const [draft, setDraft] = useState<CollaborationSettings>(() => ({
    ...settings,
    immersive: { ...settings.immersive },
    focused: { ...settings.focused },
  }));
  const [mode, setMode] = useState<CollaborationMode>('immersive');
  const [saving, setSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<Record<CollaborationMode, string[]>>(() => ({
    immersive: collaborationProfileMatches(settings.immersive, chatApi) ? availableModels : [],
    focused: collaborationProfileMatches(settings.focused, chatApi) ? availableModels : [],
  }));
  const [modelStatus, setModelStatus] = useState<Record<CollaborationMode, string>>({ immersive: '', focused: '' });
  const [fetchingMode, setFetchingMode] = useState<CollaborationMode | null>(null);
  const profile = draft[mode];
  const selectableModels = Array.from(new Set([profile.model, ...modelOptions[mode]].filter(Boolean)));
  const previewAvatar = user.perCharAvatars?.[character.id] || user.avatar || character.avatar;

  const patchProfile = (patch: Partial<CollaborationApiProfile>, detach = false) => {
    setDraft(previous => ({
      ...previous,
      [mode]: {
        ...previous[mode],
        ...patch,
        ...(detach ? { source: 'custom' as const, sourceId: undefined, sourceName: '协同专用配置' } : {}),
      },
    }));
  };

  const useSavedConnection = (config: APIConfig, source: 'chat' | 'preset', name: string, sourceId?: string) => {
    const next = collaborationProfileFromApi(config, source, name, sourceId);
    setDraft(previous => ({ ...previous, [mode]: next }));
    setModelOptions(previous => ({
      ...previous,
      [mode]: source === 'chat' ? availableModels : [],
    }));
    setModelStatus(previous => ({ ...previous, [mode]: `已载入「${name}」` }));
  };

  const fetchModels = async () => {
    setFetchingMode(mode);
    setModelStatus(previous => ({ ...previous, [mode]: '正在拉取模型…' }));
    try {
      const models = await fetchCollaborationModels(profile);
      setModelOptions(previous => ({ ...previous, [mode]: models }));
      setModelStatus(previous => ({ ...previous, [mode]: `获取到 ${models.length} 个模型，点列表即可选择` }));
    } catch (error: any) {
      setModelStatus(previous => ({ ...previous, [mode]: `拉取失败：${error?.message || '未知错误'}` }));
    } finally {
      setFetchingMode(null);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ ...draft, id: 'main', updatedAt: Date.now() });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="collab-settings-panel absolute inset-0 z-50 flex flex-col bg-[#f7f8fb] animate-[collabFade_.18s_ease-out]">
      <header className="collab-safe-header flex h-16 shrink-0 items-center border-b border-slate-200/80 bg-white/90 px-3 backdrop-blur-xl">
        <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 active:bg-slate-100" aria-label="返回">
          <ArrowLeft size={22} />
        </button>
        <div className="min-w-0 flex-1 px-2">
          <h2 className="text-[15px] font-semibold text-slate-800">协同设置</h2>
          <p className="text-[10px] text-slate-400">界面与聊天感知全局生效；API 按协同模式独立配置</p>
        </div>
        <button type="button" onClick={save} disabled={saving} className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
          {saving ? '保存中' : '保存'}
        </button>
      </header>

      <div className="border-b border-slate-200/70 bg-white px-5 pt-3">
        <div className="flex gap-6">
          {(['immersive', 'focused'] as CollaborationMode[]).map(value => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={`border-b-2 pb-3 text-sm font-medium transition-colors ${mode === value ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-400'}`}
            >
              {MODE_LABELS[value]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-xl space-y-6">
          <section>
            <div className="mb-3">
              <h3 className="text-xs font-semibold text-slate-600">协同界面</h3>
              <p className="mt-0.5 text-[10px] text-slate-400">只改变这个工作窗口，不影响 ChatApp 和角色数据</p>
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {COLLABORATION_UI_THEMES.map(item => {
                const active = draft.uiTheme === item.id;
                return (
                  <button key={item.id} type="button" onClick={() => setDraft(previous => ({ ...previous, uiTheme: item.id }))} className={`rounded-2xl border px-3 py-3 text-left transition-all active:scale-[.98] ${active ? 'border-slate-800 bg-white shadow-sm' : 'border-slate-200 bg-white/65'}`}>
                    <span className="mb-2.5 flex gap-1">
                      {item.swatches.map(color => <span key={color} className="h-4 flex-1 rounded-full border border-black/5" style={{ background: color }} />)}
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span>
                        <span className="block text-[11px] font-semibold text-slate-700">{item.label}</span>
                        <span className="mt-0.5 block text-[9px] text-slate-400">{item.caption}</span>
                        <span className="mt-1 block text-[8px] text-slate-400/80">{item.presence}</span>
                      </span>
                      {active && <Check size={14} weight="bold" className="text-slate-800" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-3">
              <h3 className="text-xs font-semibold text-slate-600">头像显示</h3>
              <p className="mt-0.5 text-[10px] text-slate-400">独立于界面风格；可以保留角色感，也可以排成纯 AI 对话</p>
            </div>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="grid grid-cols-5 border-b border-slate-100">
                {([
                  ['theme', '跟随风格'],
                  ['both', '双方'],
                  ['character', '只角色'],
                  ['user', '只自己'],
                  ['none', '不显示'],
                ] as Array<[CollaborationAvatarMode, string]>).map(([value, label]) => {
                  const active = (draft.avatarMode || 'theme') === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setDraft(previous => ({ ...previous, avatarMode: value }))}
                      className={`min-w-0 px-1 py-3 text-[10px] font-semibold transition-colors ${active ? 'bg-slate-900 text-white' : 'text-slate-500 active:bg-slate-50'}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-3 gap-px bg-slate-100">
                {([
                  ['circle', '圆形', 'rounded-full', 'h-8 w-8'],
                  ['rounded', '圆角', 'rounded-[9px]', 'h-8 w-8'],
                  ['portrait', '半身卡面', 'rounded-[9px]', 'h-10 w-8'],
                ] as Array<[CollaborationAvatarStyle, string, string, string]>).map(([value, label, radius, size]) => {
                  const active = (draft.avatarStyle || 'circle') === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={(draft.avatarMode || 'theme') === 'none'}
                      onClick={() => setDraft(previous => ({ ...previous, avatarStyle: value }))}
                      className={`flex min-h-[76px] flex-col items-center justify-center gap-1.5 bg-white py-2 transition-colors disabled:opacity-35 ${active ? 'text-slate-900' : 'text-slate-400 active:bg-slate-50'}`}
                    >
                      <span className={`overflow-hidden ring-2 ${size} ${radius} ${active ? 'ring-slate-800' : 'ring-slate-200'}`}>
                        <TokenImg value={value === 'portrait' ? character.avatar : previewAvatar} alt="" className="h-full w-full object-cover" />
                      </span>
                      <span className="text-[10px] font-semibold">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="mt-2 text-[9px] leading-4 text-slate-400">“跟随风格”只决定默认显示谁；头像形状仍由你选择。界面内不会显示第三方品牌 Logo。</p>
          </section>

          <section>
            <div className="mb-3">
              <h3 className="text-xs font-semibold text-slate-700">ChatApp 最近聊天</h3>
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-600">每次生成前重新读取当前角色的最新私聊，不会冻结在刚进入协同工作时。只读取你选择的数量，避免无关闲聊长期占用上下文。</p>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-slate-200 bg-white p-2">
              {CHAT_CONTEXT_OPTIONS.map(option => {
                const active = (draft.recentChatContextCount ?? 'configured') === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setDraft(previous => ({ ...previous, recentChatContextCount: option.value }))}
                    className={`rounded-xl px-2 py-3 text-center transition-colors ${active ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 active:bg-slate-50'}`}
                  >
                    <span className="block text-[11px] font-semibold">{option.label}</span>
                    <span className={`mt-1 block text-[9px] ${active ? 'text-white/70' : 'text-slate-500'}`}>{option.hint}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-600">“用户设定范围”会直接读取 ChatApp 当前实际使用的上下文范围（含自适应范围和手动断点）。最近 10／20 条也只在这个范围内选取，不会越过手动断点或记忆水位。沉浸式会沿用 ChatApp 的完整角色上下文；中度协同只附加这些最新对话。修改后会从下一次生成开始生效，包括已有窗口。</p>
          </section>

          <section>
            <div className="mb-3">
              <h3 className="text-xs font-semibold text-slate-600">日常聊天感知</h3>
              <p className="mt-0.5 text-[10px] text-slate-400">决定角色在普通聊天里是否知道协同入口和文件柜</p>
            </div>
            <button
              type="button"
              onClick={() => onToggleChatCollaboration(!chatCollaborationEnabled)}
              className="flex w-full items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-4 py-4 text-left active:bg-slate-50"
            >
              <span>
                <span className="block text-sm font-semibold text-slate-700">让角色知道自己有协同功能</span>
                <span className="mt-1 block text-[10px] leading-relaxed text-slate-500">开启后，角色会知道可以引导你从 ChatApp 加号页进入协同工作，也能读取、发送文件柜里已有的文件。不会向普通聊天注入制作规则，也不能在那里干活。</span>
              </span>
              <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${chatCollaborationEnabled ? 'bg-indigo-600' : 'bg-slate-200'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${chatCollaborationEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
              </span>
            </button>
          </section>

          <section>
            <div className="mb-2 flex items-end justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold text-slate-600">使用已保存的连接</h3>
                <p className="mt-0.5 text-[10px] text-slate-400">Key 会直接带入，不需要重新填写</p>
              </div>
              <span className="max-w-[45%] truncate text-[10px] font-medium text-indigo-500">{profile.sourceName || '协同专用配置'}</span>
            </div>
            <div className="max-h-56 overflow-y-auto border-y border-slate-200 bg-white">
              <button
                type="button"
                onClick={() => useSavedConnection(chatApi, 'chat', '当前 ChatApp')}
                className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-3 text-left active:bg-slate-50"
              >
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${profile.source === 'chat' ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                  {profile.source === 'chat' ? <Check size={15} weight="bold" /> : <GearSix size={16} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold text-slate-700">当前 ChatApp</span>
                  <span className="mt-0.5 block truncate text-[10px] text-slate-400">{chatApi.model || '尚未选择模型'} · {chatApi.baseUrl || '尚未配置连接'}</span>
                </span>
              </button>
              {apiPresets.map(preset => {
                const active = profile.source === 'preset' && profile.sourceId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => useSavedConnection(preset.config, 'preset', preset.name, preset.id)}
                    className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-3 text-left last:border-b-0 active:bg-slate-50"
                  >
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400'}`}>
                      {active ? <Check size={15} weight="bold" /> : <Briefcase size={15} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-slate-700">{preset.name}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-slate-400">{preset.config.model || '尚未选择模型'} · {preset.config.baseUrl || '尚未配置连接'}</span>
                    </span>
                  </button>
                );
              })}
              {apiPresets.length === 0 && <p className="px-4 py-3 text-[10px] leading-relaxed text-slate-400">其它连接可以先在「设置 → API 预设」保存，之后会出现在这里。</p>}
            </div>
          </section>

          <section className="border-t border-slate-200 pt-5">
            <div className="mb-2 flex items-center justify-between gap-3">
              <label htmlFor={`collaboration-model-${mode}`} className="text-xs font-semibold text-slate-600">这个模式使用的模型</label>
              <button type="button" onClick={fetchModels} disabled={fetchingMode !== null} className="flex items-center gap-1.5 text-[11px] font-semibold text-indigo-600 disabled:opacity-45">
                {fetchingMode === mode && <SpinnerGap size={13} className="animate-spin" />}
                {fetchingMode === mode ? '拉取中' : '拉取模型'}
              </button>
            </div>
            <select
              id={`collaboration-model-${mode}`}
              aria-label={`${MODE_LABELS[mode]}模型`}
              value={profile.model}
              onChange={event => patchProfile({ model: event.target.value }, true)}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-slate-400"
            >
              <option value="">请选择模型</option>
              {selectableModels.map(modelId => <option key={modelId} value={modelId}>{modelId}</option>)}
            </select>
            <p className={`mt-2 min-h-4 text-[10px] ${modelStatus[mode].startsWith('拉取失败') ? 'text-rose-500' : 'text-slate-400'}`}>
              {modelStatus[mode] || (profile.model ? `当前：${profile.model}` : '选择连接后可直接沿用其模型，或现场拉取列表。')}
            </p>
          </section>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="mb-2 block text-xs font-semibold text-slate-500">温度</span>
              <input type="number" min="0" max="2" step="0.05" value={profile.temperature} onChange={event => patchProfile({ temperature: Number(event.target.value) })} className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-slate-400" />
            </label>
            <label className="flex items-end">
              <button type="button" onClick={() => patchProfile({ stream: !profile.stream })} className="flex h-[46px] w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-600">
                流式输出
                <span className={`grid h-5 w-5 place-items-center rounded-md ${profile.stream ? 'bg-slate-900 text-white' : 'bg-slate-100 text-transparent'}`}><Check size={13} weight="bold" /></span>
              </button>
            </label>
          </div>
          <button
            type="button"
            onClick={() => setDraft(previous => ({ ...previous, [mode === 'immersive' ? 'focused' : 'immersive']: { ...profile } }))}
            className="text-xs font-medium text-indigo-600"
          >
            将此配置复制到{mode === 'immersive' ? '中度协同' : '沉浸式协同'}
          </button>

          <details className="border-t border-slate-200 pt-5">
            <summary className="cursor-pointer text-xs font-semibold text-slate-500">高级 · 手动填写连接</summary>
            <div className="mt-4 space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-500">API 地址</span>
                <input value={profile.baseUrl} onChange={event => patchProfile({ baseUrl: event.target.value }, true)} placeholder="https://api.example.com/v1" className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-slate-400" />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-500">API Key</span>
                <input type="password" value={profile.apiKey} onChange={event => patchProfile({ apiKey: event.target.value }, true)} placeholder="sk-…（本地模型可留空）" className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-slate-400" />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-500">手动模型名</span>
                <input value={profile.model} onChange={event => patchProfile({ model: event.target.value }, true)} placeholder="仅在接口无法拉取模型时使用" className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-slate-400" />
              </label>
            </div>
          </details>
          <p className="text-xs leading-relaxed text-slate-400">
            每个模式只保存自己的选择，不会修改 ChatApp、见面或通用 API 预设。
          </p>
        </div>
      </div>
    </div>
  );
};

const AttachmentButton: React.FC<{
  attachment: CollaborationAttachment;
  onOpen: () => void;
}> = ({ attachment, onOpen }) => {
  const isImage = /^image\//i.test(attachment.mimeType);
  const isPdf = attachment.format === 'pdf' || /pdf/i.test(attachment.mimeType);
  return (
  <button type="button" onClick={onOpen} className="mt-2 flex w-full min-w-[210px] items-center gap-3 rounded-2xl border border-black/8 bg-white/72 px-3 py-2.5 text-left text-slate-700 shadow-sm backdrop-blur-sm active:scale-[.99]">
    <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${isImage ? 'bg-sky-100 text-sky-600' : isPdf ? 'bg-rose-100 text-rose-600' : 'bg-indigo-100 text-indigo-600'}`}>
      {attachment.kind === 'installable' ? <Briefcase size={21} weight="fill" /> : isImage ? <ImageSquare size={21} weight="fill" /> : isPdf ? <FilePdf size={21} weight="fill" /> : <FileText size={21} weight="fill" />}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-xs font-semibold">{attachment.name}</span>
      <span className="mt-0.5 block text-[10px] text-slate-400">{attachment.kind === 'installable' ? `${attachment.installableKind ? COLLABORATION_MAKER_MAP[attachment.installableKind].label : '可安装作品'} · 点击预览` : `${isImage ? '参考图 · ' : ''}${readableSize(attachment.size)}${attachment.pageCount ? ` · ${attachment.pageCount} 页` : ''}`}</span>
    </span>
    {attachment.kind === 'installable' ? <Eye size={17} className="shrink-0 text-slate-400" /> : <DownloadSimple size={17} className="shrink-0 text-slate-400" />}
  </button>
  );
};

const MakerStudio: React.FC<{
  activeKind?: CollaborationMakerKind;
  onChoose: (kind: CollaborationMakerKind) => void;
  onClose: () => void;
}> = ({ activeKind, onChoose, onClose }) => (
  <div className="absolute inset-0 z-[70] flex flex-col bg-[#f7f8fb] animate-[collabFade_.18s_ease-out]">
    <header className="collab-safe-header flex h-16 shrink-0 items-center border-b border-slate-200/80 bg-white/90 px-3 backdrop-blur-xl">
      <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 active:bg-slate-100" aria-label="返回"><ArrowLeft size={22} /></button>
      <div className="min-w-0 flex-1 px-2"><h2 className="text-[15px] font-semibold text-slate-800">和角色一起制作</h2><p className="text-[10px] text-slate-400">选择后只给当前协同窗口注入对应制作规范</p></div>
    </header>
    <div className="flex-1 overflow-y-auto px-5 pb-10 pt-7">
      <div className="mx-auto max-w-xl">
        <p className="text-[11px] font-semibold uppercase tracking-[.18em] text-slate-400">Beautification & Assets</p>
        <div className="mt-4 border-y border-slate-200/80">
          {COLLABORATION_MAKERS.map((maker, index) => (
            <button key={maker.kind} type="button" onClick={() => onChoose(maker.kind)} className={`group flex w-full items-center gap-4 py-4 text-left transition-colors active:bg-white ${index < COLLABORATION_MAKERS.length - 1 ? 'border-b border-slate-200/70' : ''}`}>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl text-sm font-bold text-white shadow-sm" style={{ background: maker.accent }}>{maker.shortLabel.slice(0, 1)}</span>
              <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm font-semibold text-slate-800">{maker.label}{activeKind === maker.kind && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[9px] text-indigo-600">当前</span>}</span><span className="mt-1 block text-[11px] leading-relaxed text-slate-400">{maker.description}</span></span>
              <span className="text-slate-300 transition-transform group-hover:translate-x-1">→</span>
            </button>
          ))}
        </div>
        <p className="mt-5 text-[10px] leading-relaxed text-slate-400">作品会先留在协同窗口里。只有你点「预览」并确认「使用该作品」后，才会写入角色或对应的原生预设。</p>
      </div>
    </div>
  </div>
);

const CHARACTER_PICKER_PAGE_SIZE = 5;

const CharacterTargetPicker: React.FC<{
  open: boolean;
  characters: CharacterProfile[];
  selectedId: string;
  allowEmpty: boolean;
  onChoose: (id: string) => void;
  onClose: () => void;
}> = ({ open, characters, selectedId, allowEmpty, onChoose, onClose }) => {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const filteredCharacters = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return characters;
    return characters.filter(item => (
      item.name.toLocaleLowerCase().includes(normalized)
      || String(item.description || '').toLocaleLowerCase().includes(normalized)
    ));
  }, [characters, query]);
  const pageCount = Math.max(1, Math.ceil(filteredCharacters.length / CHARACTER_PICKER_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const shownCharacters = filteredCharacters.slice(
    safePage * CHARACTER_PICKER_PAGE_SIZE,
    (safePage + 1) * CHARACTER_PICKER_PAGE_SIZE,
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPage(0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-[100] flex items-end justify-center bg-slate-950/55 px-3 pt-10 backdrop-blur-[2px] animate-[collabFade_.16s_ease-out]" role="dialog" aria-modal="true" aria-label="选择角色">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label="关闭角色选择" />
      <section className="relative z-10 flex max-h-[88%] w-full max-w-[520px] flex-col overflow-hidden rounded-t-[28px] bg-[#f8f9fc] text-slate-800 shadow-2xl animate-[collabEnter_.2s_ease-out]">
        <header className="flex shrink-0 items-center gap-3 border-b border-slate-200/80 px-4 py-3.5">
          <div className="min-w-0 flex-1"><h3 className="text-[16px] font-semibold">选择角色</h3><p className="mt-0.5 text-[10px] text-slate-400">每页显示 5 位，可按名字或简介搜索</p></div>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full text-slate-400 active:bg-slate-200/70" aria-label="关闭"><X size={19} /></button>
        </header>

        <div className="shrink-0 px-4 pb-2 pt-3">
          <label className="flex h-11 items-center gap-2 rounded-2xl bg-slate-100 px-3 ring-1 ring-transparent focus-within:bg-white focus-within:ring-slate-300">
            <MagnifyingGlass size={17} className="shrink-0 text-slate-400" />
            <input value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="搜索角色" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400" />
            {query && <button type="button" onClick={() => { setQuery(''); setPage(0); }} className="grid h-7 w-7 place-items-center rounded-full text-slate-400 active:bg-slate-200" aria-label="清空搜索"><X size={14} /></button>}
          </label>
          {allowEmpty && (
            <button type="button" onClick={() => onChoose('')} className={`mt-2 flex h-10 w-full items-center justify-between rounded-xl px-3 text-left text-xs transition-colors ${!selectedId ? 'bg-emerald-50 font-semibold text-emerald-700' : 'text-slate-500 active:bg-slate-100'}`}>
              <span>只保存到作品库，不挂载角色</span>{!selectedId && <Check size={16} weight="bold" />}
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
          {shownCharacters.map(item => {
            const selected = item.id === selectedId;
            return (
              <button key={item.id} type="button" onClick={() => onChoose(item.id)} className={`flex h-[62px] w-full items-center gap-3 rounded-2xl px-3 text-left transition-colors ${selected ? 'bg-white shadow-sm ring-1 ring-slate-200/80' : 'active:bg-slate-100'}`} aria-current={selected ? 'true' : undefined}>
                <TokenImg value={item.avatar} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-black/5" />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-700">{item.name}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400">{item.description || '暂无角色简介'}</span></span>
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${selected ? 'bg-slate-900 text-white' : 'border border-slate-200 text-transparent'}`}><Check size={13} weight="bold" /></span>
              </button>
            );
          })}
          {shownCharacters.length === 0 && <div className="grid h-[180px] place-items-center text-xs text-slate-400">没有找到匹配的角色</div>}
        </div>

        <footer className="flex shrink-0 items-center justify-between border-t border-slate-200/80 bg-white/80 px-4 pb-[max(.9rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl">
          <span className="text-[10px] tabular-nums text-slate-400">{filteredCharacters.length} 位角色 · 第 {safePage + 1}/{pageCount} 页</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPage(value => Math.max(0, value - 1))} disabled={safePage === 0} className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-slate-600 disabled:opacity-30" aria-label="上一页"><CaretLeft size={17} /></button>
            <button type="button" onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))} disabled={safePage >= pageCount - 1} className="grid h-9 w-9 place-items-center rounded-full bg-slate-900 text-white disabled:opacity-30" aria-label="下一页"><CaretRight size={17} /></button>
          </div>
        </footer>
      </section>
    </div>
  );
};

const InstallablePreview: React.FC<{
  artifact: CollaborationInstallableArtifact;
  characters: CharacterProfile[];
  currentCharacterId: string;
  onInstall: (targetCharacterId?: string) => Promise<void>;
  onClose: () => void;
}> = ({ artifact, characters, currentCharacterId, onInstall, onClose }) => {
  const definition = COLLABORATION_MAKER_MAP[artifact.kind];
  const errors = useMemo(() => validateInstallableArtifact(artifact), [artifact]);
  const [targetId, setTargetId] = useState(definition.target === 'optional-character' ? '' : currentCharacterId);
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const selectedCharacter = characters.find(item => item.id === targetId);
  const closeTargetPicker = useCallback(() => setTargetPickerOpen(false), []);
  const install = async () => {
    setInstalling(true);
    try { await onInstall(targetId || undefined); } finally { setInstalling(false); }
  };
  return (
    <div className="absolute inset-0 z-[80] flex flex-col bg-[#11131a] text-white animate-[collabFade_.18s_ease-out]">
      <header className="collab-safe-header flex h-16 shrink-0 items-center border-b border-white/10 px-3">
        <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full text-white/75 active:bg-white/10" aria-label="关闭预览"><X size={21} /></button>
        <div className="min-w-0 flex-1 px-2"><p className="text-[9px] uppercase tracking-[.18em] text-white/40">{definition.label} · Preview</p><h2 className="truncate text-sm font-semibold">{artifact.title}</h2></div>
      </header>
      <div className="min-h-0 flex-1 bg-[#1a1d26] p-3 sm:p-5">
        <iframe title={`${artifact.title}预览`} sandbox="" srcDoc={buildInstallablePreviewDocument(artifact)} className="h-full w-full rounded-[24px] border-0 bg-white shadow-2xl" />
      </div>
      <div className="shrink-0 border-t border-white/10 bg-[#11131a] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {errors.length > 0 ? <div className="mb-3 rounded-xl bg-rose-500/12 px-3 py-2 text-[11px] leading-relaxed text-rose-200">{errors[0]}</div> : null}
        {(definition.target === 'character' || definition.target === 'optional-character') && (
          <div className="mb-3">
            <span className="mb-1.5 block text-[10px] text-white/45">{definition.target === 'optional-character' ? '挂载给角色（可选）' : '使用这件作品的角色'}</span>
            <button type="button" onClick={() => setTargetPickerOpen(true)} className="flex h-12 w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/8 px-3 text-left transition-colors active:bg-white/12">
              {selectedCharacter ? <TokenImg value={selectedCharacter.avatar} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-white/15" /> : <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/8 text-xs text-white/35">＋</span>}
              <span className={`min-w-0 flex-1 truncate text-sm ${selectedCharacter ? 'text-white' : 'text-white/50'}`}>{selectedCharacter?.name || (definition.target === 'optional-character' ? '点击选择角色，或只保存到作品库' : '点击选择角色')}</span>
              <CaretRight size={16} className="shrink-0 text-white/35" />
            </button>
          </div>
        )}
        <button type="button" onClick={() => void install()} disabled={errors.length > 0 || installing || (definition.target === 'character' && !targetId)} className="flex h-12 w-full items-center justify-center rounded-2xl bg-white text-sm font-semibold text-slate-950 disabled:opacity-35 active:scale-[.99]">{installing ? '正在保存…' : definition.target === 'new-character' ? '创建这个角色' : '使用该作品'}</button>
      </div>
      <CharacterTargetPicker
        open={targetPickerOpen}
        characters={characters}
        selectedId={targetId}
        allowEmpty={definition.target === 'optional-character'}
        onChoose={id => { setTargetId(id); setTargetPickerOpen(false); }}
        onClose={closeTargetPicker}
      />
    </div>
  );
};

const CollaborationInline: React.FC<{ spans: CollaborationInlineSpan[] }> = ({ spans }) => (
  <>
    {spans.map((span, index) => {
      const key = `${span.kind}-${index}`;
      if (span.kind === 'bold') return <strong key={key} className="font-semibold">{span.text}</strong>;
      if (span.kind === 'italic') return <em key={key}>{span.text}</em>;
      if (span.kind === 'code') return <code key={key} className="rounded bg-black/7 px-1.5 py-0.5 font-mono text-[.88em]">{span.text}</code>;
      if (span.kind === 'link' && span.href && /^(https?:|mailto:)/i.test(span.href)) {
        return <a key={key} href={span.href} target="_blank" rel="noreferrer" className="font-medium underline decoration-current/35 underline-offset-2">{span.text}</a>;
      }
      return <React.Fragment key={key}>{span.text}</React.Fragment>;
    })}
  </>
);

const CollaborationMarkdownView: React.FC<{ content: string }> = ({ content }) => (
  <div className="min-w-0 max-w-full overflow-hidden break-words [overflow-wrap:anywhere]">
    {parseCollaborationMarkdown(normalizeCollaborationVisibleText(content)).map((block, index) => {
      const key = `${block.type}-${index}`;
      if (block.type === 'blank') return <div key={key} className="h-3" aria-hidden="true" />;
      if (block.type === 'divider') return <hr key={key} className="my-4 border-current/15" />;
      if (block.type === 'code') {
        return (
          <pre key={key} className="my-2 max-w-full overflow-x-auto rounded-xl bg-black/7 px-3 py-2 font-mono text-[12px] leading-5">
            <code>{block.text}</code>
          </pre>
        );
      }
      if (block.type === 'heading') {
        const headingClass = block.level === 1
          ? 'mb-2 mt-1 text-[1.24em] font-bold leading-snug'
          : block.level === 2
            ? 'mb-1.5 mt-1 text-[1.12em] font-bold leading-snug'
            : 'mb-1 mt-0.5 font-semibold leading-snug';
        return <div key={key} role="heading" aria-level={block.level} className={headingClass}><CollaborationInline spans={block.spans} /></div>;
      }
      if (block.type === 'bullet') {
        return <div key={key} className="flex gap-2 pl-1"><span aria-hidden="true">•</span><span className="min-w-0"><CollaborationInline spans={block.spans} /></span></div>;
      }
      if (block.type === 'ordered') {
        return <div key={key} className="flex gap-2 pl-1"><span className="tabular-nums opacity-65">{block.ordinal}.</span><span className="min-w-0"><CollaborationInline spans={block.spans} /></span></div>;
      }
      if (block.type === 'check') {
        return <div key={key} className="flex gap-2 pl-1"><span aria-hidden="true" className="font-semibold opacity-75">{block.checked ? '☒' : '☐'}</span><span className="min-w-0"><CollaborationInline spans={block.spans} /></span></div>;
      }
      if (block.type === 'quote') {
        return <blockquote key={key} className="my-1 border-l-2 border-current/20 pl-3 italic opacity-80"><CollaborationInline spans={block.spans} /></blockquote>;
      }
      return <p key={key} className="whitespace-pre-wrap"><CollaborationInline spans={block.spans} /></p>;
    })}
  </div>
);

const CollaborationThinkingBlock: React.FC<{ chain: string }> = ({ chain }) => {
  const [expanded, setExpanded] = useState(false);
  const text = chain.trim();
  if (!text) return null;
  const preview = text.replace(/\s+/g, ' ').slice(0, 44);
  return (
    <div className="collab-thinking mb-2.5 overflow-hidden rounded-[15px] border border-slate-200/80 bg-slate-50/80 text-slate-600">
      <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} className="flex w-full items-center gap-2 px-3 py-2.5 text-left active:bg-slate-100/80">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-white text-[12px] shadow-sm">💭</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold tracking-[.08em] text-slate-500">思考过程</span>
          {!expanded && <span className="mt-0.5 block truncate text-[10px] text-slate-400">{preview}{text.length > 44 ? '…' : ''}</span>}
        </span>
        <CaretDown size={14} className={`shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && <div className="max-h-72 overflow-y-auto border-t border-slate-200/70 px-3.5 py-3 text-[11px] leading-[1.75] whitespace-pre-wrap break-words">{text}</div>}
    </div>
  );
};

interface CollaborationVoiceUiState {
  loading?: boolean;
  playing?: boolean;
  url?: string;
}

const CollaborationVoiceBar: React.FC<{
  speech: string;
  subtitle?: string;
  state?: CollaborationVoiceUiState;
  onPlay: () => void;
}> = ({ speech, subtitle, state, onPlay }) => {
  const [showText, setShowText] = useState(false);
  return (
    <div className="collab-voice mt-2.5 max-w-[280px] overflow-hidden rounded-[17px] border border-black/5 bg-black/[.035]">
      <div className="flex w-full items-center gap-2 px-2.5 py-2">
        <button type="button" onClick={onPlay} disabled={state?.loading} aria-label={state?.playing ? '暂停语音' : '播放语音'} className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/85 text-[12px] text-slate-600 shadow-sm active:scale-95 disabled:opacity-70">
          {state?.loading ? <SpinnerGap size={15} className="animate-spin" /> : state?.playing ? 'Ⅱ' : '▶'}
        </button>
        <button type="button" onClick={onPlay} disabled={state?.loading} aria-label={state?.playing ? '暂停语音' : '播放语音'} className="flex h-8 min-w-0 flex-1 items-center gap-[3px] disabled:opacity-70">
          {[5, 11, 7, 16, 9, 13, 6, 15, 8, 12, 5, 10, 7, 14, 6, 9].map((height, index) => (
            <span key={index} className={`w-[2.5px] rounded-full bg-current opacity-35 ${state?.playing ? 'animate-pulse' : ''}`} style={{ height, animationDelay: `${index * 55}ms` }} />
          ))}
        </button>
        <button type="button" onClick={() => setShowText(value => !value)} className="shrink-0 rounded-lg bg-black/[.045] px-2 py-1 text-[9px] font-medium text-slate-500">{showText ? '收起' : '转文字'}</button>
      </div>
      {showText && (
        <div className="border-t border-black/5 px-3.5 py-3 text-[11px] leading-relaxed text-slate-600">
          <div className="whitespace-pre-wrap">{speech}</div>
          {subtitle && <div className="mt-1.5 border-t border-current/10 pt-1.5 opacity-65">{subtitle}</div>}
        </div>
      )}
    </div>
  );
};

const CollaborationEmojiCard: React.FC<{ name: string; emoji?: Emoji }> = ({ name, emoji }) => (
  emoji
    ? <TokenImg value={emoji.url} alt={emoji.name} title={emoji.name} className="collab-emoji mt-2 max-h-36 max-w-36 object-contain" />
    : <div className="mt-2 rounded-xl border border-dashed border-current/15 px-3 py-2 text-[10px] opacity-55">表情包未找到：{name}</div>
);

const useCollaborationLongPress = (onLongPress: () => void) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    originRef.current = null;
  }, []);
  useEffect(() => clearTimer, [clearTimer]);
  const isInteractiveTarget = (target: EventTarget | null) => (
    target instanceof Element && !!target.closest('button, a, input, textarea, select, label')
  );
  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || isInteractiveTarget(event.target)) return;
      clearTimer();
      longPressedRef.current = false;
      originRef.current = { x: event.clientX, y: event.clientY };
      timerRef.current = setTimeout(() => {
        longPressedRef.current = true;
        originRef.current = null;
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(12);
        onLongPress();
      }, 520);
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const origin = originRef.current;
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) clearTimer();
    },
    onPointerUp: clearTimer,
    onPointerCancel: clearTimer,
    onPointerLeave: clearTimer,
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      clearTimer();
      if (longPressedRef.current) return;
      onLongPress();
    },
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      if (!longPressedRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      longPressedRef.current = false;
    },
  };
};

const MessageBubble: React.FC<{
  message: CollaborationMessage;
  character: CharacterProfile;
  user: UserProfile;
  theme: ChatTheme;
  uiTheme: CollaborationUiTheme;
  emojis: Emoji[];
  emojiCategories: EmojiCategory[];
  voiceState?: CollaborationVoiceUiState;
  onPlayVoice: (message: CollaborationMessage) => void;
  onOpenAttachment: (attachment: CollaborationAttachment) => void;
  onLongPress: (message: CollaborationMessage) => void;
}> = ({ message, character, user, theme, uiTheme, emojis, emojiCategories, voiceState, onPlayVoice, onOpenAttachment, onLongPress }) => {
  const longPressHandlers = useCollaborationLongPress(() => onLongPress(message));
  if (message.role === 'system') {
    return <div {...longPressHandlers} className="collab-message-system mx-auto my-3 max-w-[82%] rounded-full bg-slate-900/6 px-4 py-2 text-center text-[11px] leading-relaxed text-slate-500">{message.content}</div>;
  }
  const isUser = message.role === 'user';
  const richOutput = isUser ? null : parseCollaborationRichOutput(message.content);
  const style = isUser ? theme.user : theme.ai;
  const avatar = isUser ? (user.perCharAvatars?.[character.id] || user.avatar) : character.avatar;
  return (
    <div {...longPressHandlers} className={`collab-message-row ${isUser ? 'collab-message-row-user flex-row-reverse' : 'collab-message-row-assistant'} flex items-end gap-2.5 px-4 py-2`}>
      <TokenImg value={avatar} alt={isUser ? user.name : character.name} className={`collab-message-avatar ${isUser ? 'collab-message-avatar-user' : 'collab-message-avatar-assistant'} h-8 w-8 shrink-0 rounded-full object-cover shadow-sm ring-1 ring-black/5`} />
      <div className={`collab-message-stack min-w-0 max-w-[78%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`} data-ui-theme={uiTheme}>
        <div
          className={`collab-message-bubble min-w-0 max-w-full ${isUser ? 'collab-message-bubble-user' : 'collab-message-bubble-assistant'} px-4 py-3 text-[15px] leading-7 shadow-sm`}
          style={{
            color: style.textColor || (isUser ? '#fff' : '#1e293b'),
            backgroundColor: withAlpha(style.backgroundColor, style.opacity ?? 1, isUser ? '#6366f1' : '#fff'),
            borderRadius: style.borderRadius ?? 20,
          }}
        >
          {!isUser && message.thinkingChain && <CollaborationThinkingBlock chain={message.thinkingChain} />}
          {isUser && message.requestedFormat && <div className="mb-1.5 text-[9px] font-semibold opacity-65">交付格式 · {OUTPUT_FORMAT_LABELS[message.requestedFormat]}</div>}
          {isUser && message.content && <CollaborationMarkdownView content={message.content} />}
          {!isUser && richOutput?.text && <CollaborationMarkdownView content={richOutput.text} />}
          {!isUser && richOutput?.voice && (
            <CollaborationVoiceBar
              speech={richOutput.voice.speech || richOutput.voice.rawSpeech}
              subtitle={richOutput.voice.subtitle}
              state={voiceState}
              onPlay={() => onPlayVoice(message)}
            />
          )}
          {!isUser && richOutput?.emojiNames.map((name, index) => (
            <CollaborationEmojiCard key={`${name}-${index}`} name={name} emoji={resolveCollaborationEmoji(name, emojis, emojiCategories)} />
          ))}
          {(message.attachments || []).map(attachment => (
            <AttachmentButton key={attachment.id} attachment={attachment} onOpen={() => onOpenAttachment(attachment)} />
          ))}
        </div>
        <span className="collab-message-time mt-1 px-1 text-[9px] text-slate-400">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    </div>
  );
};

const collaborationFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};

const CollaborationLibraryRow: React.FC<{
  file: CollaborationLibraryFile;
  onOpen: () => void;
  onLongPress: () => void;
}> = ({ file, onOpen, onLongPress }) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);
  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const startPress = () => {
    clearTimer();
    longPressedRef.current = false;
    timerRef.current = setTimeout(() => {
      longPressedRef.current = true;
      onLongPress();
    }, 520);
  };
  useEffect(() => clearTimer, []);
  return (
    <button
      type="button"
      onPointerDown={startPress}
      onPointerUp={clearTimer}
      onPointerCancel={clearTimer}
      onPointerLeave={clearTimer}
      onContextMenu={event => { event.preventDefault(); clearTimer(); onLongPress(); }}
      onClick={event => {
        if (longPressedRef.current) {
          event.preventDefault();
          longPressedRef.current = false;
          return;
        }
        onOpen();
      }}
      className="collab-library-row flex w-full items-center gap-3 border-b border-slate-200/65 px-4 py-3.5 text-left transition-colors active:bg-slate-100"
    >
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-[14px] ${file.kind === 'installable' ? 'bg-violet-50 text-violet-500' : /^image\//i.test(file.mimeType) ? 'bg-sky-50 text-sky-500' : file.format === 'pdf' ? 'bg-rose-50 text-rose-500' : 'bg-indigo-50 text-indigo-500'}`}>
        {file.kind === 'installable' ? <Briefcase size={22} weight="duotone" /> : /^image\//i.test(file.mimeType) ? <ImageSquare size={22} weight="duotone" /> : file.format === 'pdf' ? <FilePdf size={22} weight="duotone" /> : <FileText size={22} weight="duotone" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-slate-700">{file.name}</span>
        <span className="mt-1 block truncate text-[10px] text-slate-400">{file.kind === 'installable' && file.installableKind ? COLLABORATION_MAKER_MAP[file.installableKind]?.label || '可安装作品' : file.sessionTitle} · {collaborationFileSize(file.size)} · {new Date(file.createdAt).toLocaleDateString()}</span>
      </span>
      {file.kind === 'installable' ? <Eye size={18} className="shrink-0 text-slate-300" /> : <DownloadSimple size={18} className="shrink-0 text-slate-300" />}
    </button>
  );
};

const CollaborationFileLibrary: React.FC<{
  open: boolean;
  files: CollaborationLibraryFile[];
  loading: boolean;
  onClose: () => void;
  onOpen: (file: CollaborationLibraryFile) => void;
  onDelete: (file: CollaborationLibraryFile) => void;
}> = ({ open, files, loading, onClose, onOpen, onDelete }) => {
  const [query, setQuery] = useState('');
  const [actionFile, setActionFile] = useState<CollaborationLibraryFile | null>(null);
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActionFile(null);
    }
  }, [open]);
  if (!open) return null;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const shown = normalizedQuery
    ? files.filter(file => `${file.name} ${file.sessionTitle} ${file.format || ''} ${file.installableKind || ''} ${COLLABORATION_LIBRARY_GROUP_LABELS[collaborationLibraryGroupOf(file)]}`.toLocaleLowerCase().includes(normalizedQuery))
    : files;
  const grouped = (['beautification', 'character', 'document'] as CollaborationLibraryGroup[])
    .map(group => ({ group, files: shown.filter(file => collaborationLibraryGroupOf(file) === group) }))
    .filter(section => section.files.length > 0);
  return (
    <div className="collab-file-library absolute inset-0 z-[70] flex flex-col bg-[#f8f9fc]">
      <header className="collab-safe-header flex h-16 shrink-0 items-center gap-2 border-b border-slate-200/80 bg-white/92 px-3 backdrop-blur-xl">
        <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 active:bg-slate-100" aria-label="关闭文件库"><ArrowLeft size={21} /></button>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold text-slate-800">协同文件与作品</h2>
          <p className="text-[10px] text-slate-400">{files.length} 份 · 来自全部协同窗口</p>
        </div>
      </header>

      <div className="border-b border-slate-200/70 bg-white px-4 py-3">
        <label className="flex items-center gap-2 rounded-[14px] bg-slate-100 px-3 py-2.5">
          <MagnifyingGlass size={16} className="text-slate-400" />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件名或协同窗口" className="min-w-0 flex-1 bg-transparent text-[13px] text-slate-700 outline-none placeholder:text-slate-400" />
          {query && <button type="button" onClick={() => setQuery('')} className="text-slate-400" aria-label="清空搜索"><X size={15} /></button>}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-6 py-20 text-xs text-slate-400"><SpinnerGap size={17} className="animate-spin" />正在读取文件库</div>
        ) : shown.length > 0 ? (
          <div>
            {grouped.map(section => (
              <section key={section.group}>
                <h3 className="border-y border-slate-200/70 bg-slate-50 px-4 py-2 text-[10px] font-semibold tracking-[.12em] text-slate-400">{COLLABORATION_LIBRARY_GROUP_LABELS[section.group]} · {section.files.length}</h3>
                <div className="bg-white">
                  {section.files.map(file => <CollaborationLibraryRow key={file.assetId} file={file} onOpen={() => onOpen(file)} onLongPress={() => setActionFile(file)} />)}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="px-8 py-20 text-center">
            <Folder size={38} weight="duotone" className="mx-auto text-slate-300" />
            <p className="mt-4 text-sm font-semibold text-slate-500">{query ? '没有找到对应内容' : '还没有协同文件或作品'}</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-400">制作或上传并发送后的文档、美化和角色资料会收在这里。</p>
          </div>
        )}
        {!loading && files.length > 0 && <p className="px-5 py-4 text-center text-[10px] text-slate-400">点击预览 / 分享 / 导出 · 长按管理文件或作品</p>}
      </div>

      {actionFile && (
        <>
          <button type="button" aria-label="关闭文件操作" onClick={() => setActionFile(null)} className="absolute inset-0 z-10 bg-slate-950/25" />
          <div className="absolute inset-x-3 bottom-[max(.75rem,env(safe-area-inset-bottom))] z-20 overflow-hidden rounded-[22px] bg-white shadow-[0_20px_60px_rgba(15,23,42,.22)]">
            <div className="border-b border-slate-100 px-5 py-4">
              <p className="truncate text-[12px] font-semibold text-slate-700">{actionFile.name}</p>
              <p className="mt-1 text-[10px] text-slate-400">删除后，聊天里已经发出的同一文件或作品也将无法再次打开。</p>
            </div>
            <button type="button" onClick={() => { const file = actionFile; setActionFile(null); onDelete(file); }} className="flex w-full items-center justify-center gap-2 px-4 py-4 text-[13px] font-semibold text-rose-600 active:bg-rose-50"><Trash size={17} />删除这项内容</button>
            <button type="button" onClick={() => setActionFile(null)} className="w-full border-t border-slate-100 px-4 py-3.5 text-[12px] font-semibold text-slate-500 active:bg-slate-50">取消</button>
          </div>
        </>
      )}
    </div>
  );
};

const SessionDrawer: React.FC<{
  open: boolean;
  sessions: CollaborationSession[];
  categories: CollaborationCategory[];
  activeSessionId: string | null;
  filter: SessionFilter;
  categoryFilter: string;
  onFilter: (filter: SessionFilter) => void;
  onCategoryFilter: (id: string) => void;
  onChoose: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
  onArchive: (session: CollaborationSession, archived: boolean) => void;
  onDelete: (session: CollaborationSession) => void;
  onMove: (session: CollaborationSession, categoryId?: string) => void;
  onCreateCategory: (name: string) => void;
  onDeleteCategory: (category: CollaborationCategory) => void;
}> = ({
  open, sessions, categories, activeSessionId, filter, categoryFilter,
  onFilter, onCategoryFilter, onChoose, onNew, onClose, onArchive, onDelete,
  onMove, onCreateCategory, onDeleteCategory,
}) => {
  const [categoryName, setCategoryName] = useState('');
  const shown = sessions.filter(session => {
    if (filter === 'active' && session.archivedAt) return false;
    if (filter === 'archived' && !session.archivedAt) return false;
    return categoryFilter === 'all' || session.categoryId === categoryFilter;
  });
  return (
    <>
      <button type="button" aria-label="关闭会话列表" onClick={onClose} className={`absolute inset-0 z-40 bg-slate-950/25 transition-opacity ${open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`} />
      <aside className={`absolute inset-y-0 left-0 z-50 flex w-[88%] max-w-[340px] flex-col bg-[#f8f9fc] transition-transform duration-300 ease-out ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <header className="collab-safe-header flex h-16 shrink-0 items-center border-b border-slate-200/80 bg-white/85 px-4 backdrop-blur-xl">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold text-slate-800">协同窗口</h2>
            <p className="text-[10px] text-slate-400">每个窗口的上下文彼此独立</p>
          </div>
          <button type="button" onClick={onNew} className="grid h-9 w-9 place-items-center rounded-full bg-slate-900 text-white active:scale-95" aria-label="新建窗口"><Plus size={18} weight="bold" /></button>
        </header>

        <div className="flex gap-5 border-b border-slate-200/70 bg-white px-4 pt-3">
          {(['active', 'archived'] as SessionFilter[]).map(value => (
            <button key={value} type="button" onClick={() => onFilter(value)} className={`border-b-2 pb-2.5 text-xs font-semibold ${filter === value ? 'border-slate-900 text-slate-800' : 'border-transparent text-slate-400'}`}>
              {value === 'active' ? '进行中' : '已归档'}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto border-b border-slate-200/60 px-4 py-3 no-scrollbar">
          <button type="button" onClick={() => onCategoryFilter('all')} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] ${categoryFilter === 'all' ? 'bg-slate-900 text-white' : 'bg-white text-slate-500'}`}>全部</button>
          {categories.map(category => (
            <button key={category.id} type="button" onClick={() => onCategoryFilter(category.id)} onContextMenu={event => { event.preventDefault(); onDeleteCategory(category); }} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] ${categoryFilter === category.id ? 'bg-slate-900 text-white' : 'bg-white text-slate-500'}`}>{category.name}</button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {shown.map(session => (
            <div key={session.id} className={`group border-b border-slate-200/60 px-4 py-3 ${activeSessionId === session.id ? 'bg-white' : ''}`}>
              <button type="button" onClick={() => onChoose(session.id)} className="w-full text-left">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${session.mode === 'immersive' ? 'bg-indigo-500' : 'bg-slate-400'}`} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">{session.title}</span>
                  <span className="text-[9px] text-slate-400">{new Date(session.updatedAt).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}</span>
                </div>
                <p className="mt-1 truncate pl-4 text-[11px] text-slate-400">{session.lastMessagePreview || MODE_LABELS[session.mode]}</p>
              </button>
              <div className="mt-2 flex items-center gap-2 pl-4">
                <select value={session.categoryId || ''} onChange={event => onMove(session, event.target.value || undefined)} className="max-w-[120px] bg-transparent text-[10px] text-slate-400 outline-none">
                  <option value="">未分类</option>
                  {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
                </select>
                <span className="flex-1" />
                <button type="button" onClick={() => onArchive(session, !session.archivedAt)} className="text-[10px] text-slate-400 hover:text-slate-700">{session.archivedAt ? '撤销归档' : '归档'}</button>
                <button type="button" onClick={() => onDelete(session)} className="text-[10px] text-rose-400 hover:text-rose-600">删除</button>
              </div>
            </div>
          ))}
          {shown.length === 0 && <div className="px-6 py-16 text-center text-xs text-slate-400">这里还没有窗口</div>}
        </div>

        <form onSubmit={event => { event.preventDefault(); const value = categoryName.trim(); if (!value) return; onCreateCategory(value); setCategoryName(''); }} className="flex shrink-0 gap-2 border-t border-slate-200 bg-white p-3">
          <input value={categoryName} onChange={event => setCategoryName(event.target.value)} placeholder="新分类" className="min-w-0 flex-1 rounded-xl bg-slate-100 px-3 py-2 text-xs outline-none" />
          <button type="submit" className="rounded-xl px-3 text-xs font-semibold text-slate-600">添加</button>
        </form>
      </aside>
    </>
  );
};

const CollaborationWindow: React.FC<CollaborationWindowProps> = ({
  open,
  character,
  user,
  theme,
  backgroundUrl,
  chatApi,
  apiPresets,
  availableModels,
  characters,
  groups,
  emojis,
  emojiCategories,
  recentChatMessages,
  realtimeConfig,
  chatCollaborationEnabled,
  requestedPreviewAssetId,
  onRequestedPreviewHandled,
  onClose,
  onSendToChat,
  onInstallArtifact,
  onArchiveToMemory,
  onToggleChatCollaboration,
  notify,
}) => {
  const [sessions, setSessions] = useState<CollaborationSession[]>([]);
  const [categories, setCategories] = useState<CollaborationCategory[]>([]);
  const [settings, setSettings] = useState<CollaborationSettings>(() => cloneDefaultSettings());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferIds, setTransferIds] = useState<Set<string>>(new Set());
  const [transferring, setTransferring] = useState(false);
  const [chatReadReceipt, setChatReadReceipt] = useState<{ sessionId: string; count: number } | null>(null);
  useEffect(() => { setTransferOpen(false); setTransferIds(new Set()); setChatReadReceipt(null); }, [activeSessionId, character.id]);
  const [showModePicker, setShowModePicker] = useState(false);
  const [showEntryChooser, setShowEntryChooser] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryFiles, setLibraryFiles] = useState<CollaborationLibraryFile[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [makerOpen, setMakerOpen] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState<CollaborationInstallableArtifact | null>(null);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('active');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [requestedOutputFormat, setRequestedOutputFormat] = useState<CollaborationArtifactFormat | null>(null);
  const [uploadStatus, setUploadStatus] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [actionDialog, setActionDialog] = useState<CollaborationDialogState | null>(null);
  const [editingMessage, setEditingMessage] = useState<CollaborationMessage | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [voiceAudioUrls, setVoiceAudioUrls] = useState<Record<string, string>>({});
  const [voiceLoadingIds, setVoiceLoadingIds] = useState<Set<string>>(() => new Set());
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const notifyRef = useRef(notify);
  const actionDialogRef = useRef<CollaborationDialogState | null>(null);
  const collaborationAudioRef = useRef<HTMLAudioElement | null>(null);
  const collaborationVoiceBlobUrlsRef = useRef<Set<string>>(new Set());
  const previousOpenRef = useRef(false);

  const requestActionDialog = useCallback((request: CollaborationDialogRequest): Promise<CollaborationDialogResult> => (
    new Promise(resolve => {
      actionDialogRef.current?.resolve('cancel');
      const next = { ...request, resolve };
      actionDialogRef.current = next;
      setActionDialog(next);
    })
  ), []);

  const resolveActionDialog = useCallback((result: CollaborationDialogResult) => {
    const current = actionDialogRef.current;
    actionDialogRef.current = null;
    setActionDialog(null);
    current?.resolve(result);
  }, []);

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  // The sidecar stays mounted (and preloaded) while ChatApp is open. Reset the
  // route before paint on every re-entry so the previous thread never flashes
  // for one frame before the new/old-session chooser appears.
  useLayoutEffect(() => {
    const justOpened = open && !previousOpenRef.current;
    previousOpenRef.current = open;
    if (!justOpened || !loaded) return;
    setActiveSessionId(null);
    setMessages([]);
    setDrawerOpen(false);
    setLibraryOpen(false);
    setSettingsOpen(false);
    setMakerOpen(false);
    setPreviewArtifact(null);
    setEditingMessage(null);
    setEditDraft('');
    setShowEntryChooser(sessions.length > 0);
    setShowModePicker(sessions.length === 0);
  }, [loaded, open, sessions.length]);

  // A work delivered in ordinary ChatApp opens the same full-screen preview
  // used by the collaboration cabinet. The asset remains canonical in the
  // sidecar DB; this bridge passes only its id.
  useEffect(() => {
    if (!open || !loaded || !requestedPreviewAssetId) return;
    let cancelled = false;
    const openRequestedWork = async () => {
      try {
        const blob = await CollaborationStore.getAsset(requestedPreviewAssetId);
        if (!blob) throw new Error('原始作品已不存在');
        const parsed = JSON.parse(await blob.text()) as CollaborationInstallableArtifact;
        if (!COLLABORATION_MAKER_MAP[parsed.kind]) throw new Error('未知作品类型');
        if (!cancelled) {
          setPreviewArtifact(parsed);
          trackEvent('预览协同作品', { 类型: analyticsMakerKind(parsed.kind), 来源: '普通聊天' });
        }
      } catch (error: any) {
        if (!cancelled) notifyRef.current(`作品无法预览：${error?.message || '数据损坏'}`, 'error');
      } finally {
        if (!cancelled) onRequestedPreviewHandled?.();
      }
    };
    void openRequestedWork();
    return () => { cancelled = true; };
  }, [loaded, onRequestedPreviewHandled, open, requestedPreviewAssetId]);

  useEffect(() => {
    if (open) return;
    abortCollaborationRequest(abortRef.current, '协同窗口已关闭');
    collaborationAudioRef.current?.pause();
    setPlayingVoiceId(null);
    actionDialogRef.current?.resolve('cancel');
    actionDialogRef.current = null;
    setActionDialog(null);
  }, [open]);

  // Only an actual character switch / sidecar unmount may stop an in-flight
  // request. Ordinary OSContext rerenders (including API call logging) must not.
  useEffect(() => () => {
    abortCollaborationRequest(abortRef.current, '协同窗口已关闭');
    actionDialogRef.current?.resolve('cancel');
    actionDialogRef.current = null;
  }, [character.id]);

  useEffect(() => () => {
    collaborationAudioRef.current?.pause();
    collaborationVoiceBlobUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    collaborationVoiceBlobUrlsRef.current.clear();
  }, []);

  const activeSession = useMemo(
    () => sessions.find(session => session.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );

  const visibleEmojiLibrary = useMemo(() => {
    const visibleCategories = emojiCategories.filter(category => (
      !category.allowedCharacterIds?.length || category.allowedCharacterIds.includes(character.id)
    ));
    const visibleIds = new Set(visibleCategories.map(category => category.id));
    return {
      categories: visibleCategories,
      emojis: emojis.filter(emoji => !emoji.categoryId || visibleIds.has(emoji.categoryId)),
    };
  }, [character.id, emojiCategories, emojis]);

  const playCollaborationVoice = async (message: CollaborationMessage) => {
    const parsed = parseCollaborationRichOutput(message.content).voice;
    if (!parsed?.hasVoiceTag) return;
    if (!collaborationAudioRef.current) collaborationAudioRef.current = new Audio();
    const audio = collaborationAudioRef.current;
    const existingUrl = voiceAudioUrls[message.id];
    if (existingUrl) {
      if (playingVoiceId === message.id) {
        audio.pause();
        setPlayingVoiceId(null);
        return;
      }
      audio.src = existingUrl;
      audio.onended = () => setPlayingVoiceId(null);
      try {
        await audio.play();
        setPlayingVoiceId(message.id);
      } catch {
        notify('语音播放被浏览器拦截，请再点一次', 'info');
      }
      return;
    }
    if (voiceLoadingIds.has(message.id)) return;
    if (!canSynthesizeSpeech(character, chatApi)) {
      notify('这个角色还没有配好当前语音服务的音色或 API Key，可点“转文字”查看台词', 'info');
      return;
    }
    setVoiceLoadingIds(previous => new Set(previous).add(message.id));
    try {
      const spokenText = providerUsesRawVoiceMarkup(chatApi) ? parsed.rawSpeech : parsed.speech;
      const result = await synthesizeSpeechDetailed(spokenText, character, chatApi, {
        languageBoost: character.chatVoiceLang || undefined,
        groupId: chatApi.minimaxGroupId || undefined,
        emotion: parsed.emotion,
      });
      if (result.url.startsWith('blob:')) collaborationVoiceBlobUrlsRef.current.add(result.url);
      setVoiceAudioUrls(previous => ({ ...previous, [message.id]: result.url }));
      audio.src = result.url;
      audio.onended = () => setPlayingVoiceId(null);
      await audio.play();
      setPlayingVoiceId(message.id);
      trackEvent('播放协同语音条');
    } catch (error: any) {
      notify(`语音生成失败：${error?.message || '请检查语音设置'}`, 'error');
    } finally {
      setVoiceLoadingIds(previous => {
        const next = new Set(previous);
        next.delete(message.id);
        return next;
      });
    }
  };

  const refreshLibrary = useCallback(async () => {
    setLibraryLoading(true);
    try {
      setLibraryFiles(await CollaborationStore.listLibraryFiles(character.id));
    } catch (error) {
      console.error('[Collaboration] file library load failed', error);
      notifyRef.current('协同文件库读取失败', 'error');
    } finally {
      setLibraryLoading(false);
    }
  }, [character.id]);

  useEffect(() => {
    if (libraryOpen) void refreshLibrary();
  }, [libraryOpen, refreshLibrary]);

  const refreshSessions = useCallback(async (preferredId?: string | null) => {
    const next = await CollaborationStore.listSessions(character.id);
    setSessions(next);
    const preferred = preferredId === undefined ? activeSessionId : preferredId;
    if (preferred && next.some(session => session.id === preferred)) setActiveSessionId(preferred);
    else setActiveSessionId(next.find(session => !session.archivedAt)?.id || null);
    return next;
  }, [character.id, activeSessionId]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    Promise.all([
      CollaborationStore.listSessions(character.id),
      CollaborationStore.listCategories(),
      CollaborationStore.loadSettings(),
    ]).then(([sessionRows, categoryRows, savedSettings]) => {
      if (cancelled) return;
      const hydratedSettings = hydrateCollaborationApiSettings(savedSettings, chatApi, apiPresets);
      setSessions(sessionRows);
      setCategories(categoryRows);
      setSettings(hydratedSettings);
      if (JSON.stringify(hydratedSettings) !== JSON.stringify(savedSettings)) {
        void CollaborationStore.saveSettings({ ...hydratedSettings, updatedAt: Date.now() }).catch(error => {
          console.warn('[Collaboration] default API migration failed', error);
        });
      }
      setActiveSessionId(null);
      setShowEntryChooser(sessionRows.length > 0);
      setShowModePicker(sessionRows.length === 0);
      setLoaded(true);
    }).catch(error => {
      console.error('[Collaboration] load failed', error);
      notifyRef.current('协同工作数据加载失败', 'error');
      setLoaded(true);
      setShowEntryChooser(false);
      setShowModePicker(true);
    });
    return () => { cancelled = true; };
    // The shared API sources are captured when this character's sidecar opens.
    // The settings picker always receives the latest props for explicit changes.
  }, [character.id]);

  useEffect(() => {
    setEditingMessage(null);
    setEditDraft('');
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    CollaborationStore.listMessages(activeSessionId).then(rows => {
      if (!cancelled) setMessages(rows);
    }).catch(error => {
      console.error('[Collaboration] messages load failed', error);
      notifyRef.current('这个协同窗口暂时无法读取', 'error');
    });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    requestAnimationFrame(() => node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' }));
  }, [messages.length, streamingText, activeSessionId]);

  const createSession = async (mode: CollaborationMode) => {
    const now = Date.now();
    const session: CollaborationSession = {
      id: collaborationId('session'),
      charId: character.id,
      title: '新的协同',
      mode,
      createdAt: now,
      updatedAt: now,
    };
    await CollaborationStore.saveSession(session);
    setSessions(previous => [session, ...previous]);
    setActiveSessionId(session.id);
    setMessages([]);
    setDraft('');
    setPendingAttachments([]);
    setShowModePicker(false);
    setShowEntryChooser(false);
    setDrawerOpen(false);
    trackEvent('新建协同窗口', { 模式: mode });
  };

  const updateSession = async (session: CollaborationSession) => {
    await CollaborationStore.saveSession(session);
    setSessions(previous => previous.map(item => item.id === session.id ? session : item).sort((a, b) => b.updatedAt - a.updatedAt));
  };

  const archiveSession = async (session: CollaborationSession, archived: boolean) => {
    let memoryAction = archived ? (session.memoryArchivedAt ? '已有' : '跳过') : '不适用';
    let memoryArchivePatch: Pick<CollaborationSession, 'memoryArchivedAt' | 'memoryArchiveSummary'> = {
      memoryArchivedAt: session.memoryArchivedAt,
      memoryArchiveSummary: session.memoryArchiveSummary,
    };
    if (archived && !session.memoryArchivedAt) {
      const sessionMessages = await CollaborationStore.listMessages(session.id);
      const semanticMessages = sessionMessages.filter(message => message.role === 'user' || message.role === 'assistant');
      if (semanticMessages.length > 0) {
        const archiveChoice = await requestActionDialog({
          title: '归档这次协同？',
          description: `“${session.title}”归档后仍可在旧记录里找到。要不要把这次一起做的事整理进 ${character.name} 的记忆？`,
          detail: `总结会生成 1 条日期范围记忆，写入神经链接${character.memoryPalaceEnabled ? '，并同时存入记忆宫殿' : ''}。协同原文不会整段塞进记忆。`,
          confirmLabel: '总结并归档',
          secondaryLabel: '仅归档，不写记忆',
          cancelLabel: '先不归档',
          tone: 'warning',
        });
        if (archiveChoice === 'cancel') return;
        const shouldRemember = archiveChoice === 'confirm';
        if (shouldRemember) {
          notify('正在把这次协作整理成一条记忆…', 'info');
          try {
            const rawSummary = await summarizeCollaborationForMemory({
              profile: settings[session.mode],
              characterName: character.name,
              userName: user.name,
              sessionTitle: session.title,
              messages: semanticMessages,
            });
            const firstAt = semanticMessages[0].createdAt;
            const lastAt = semanticMessages[semanticMessages.length - 1].createdAt;
            const memorySummary = `【${collaborationDateRange(firstAt, lastAt)}，${rawSummary}】`;
            const memoryResult = await onArchiveToMemory(memorySummary, lastAt, session.id);
            memoryArchivePatch = { memoryArchivedAt: Date.now(), memoryArchiveSummary: memorySummary };
            memoryAction = '写入';
            notify(memoryResult, 'success');
          } catch (error: any) {
            notify(`记忆总结没有完成：${error?.message || '未知错误'}。窗口尚未归档，你可以重试或选择不写入记忆。`, 'error');
            return;
          }
        }
      }
    }
    const updated = { ...session, ...memoryArchivePatch, archivedAt: archived ? Date.now() : undefined, updatedAt: Date.now() };
    await updateSession(updated);
    trackEvent('归档协同窗口', { 动作: archived ? '归档' : '撤销', 记忆: memoryAction });
    if (archived && session.id === activeSessionId) {
      setActiveSessionId(null);
      setMessages([]);
      setShowModePicker(false);
      setShowEntryChooser(true);
    }
    notify(archived ? '窗口已归档' : '已撤销归档', 'success');
  };

  const deleteSession = async (session: CollaborationSession) => {
    const choice = await requestActionDialog({
      title: '删除这个协同窗口？',
      description: `“${session.title}”的窗口和消息会被永久删除。`,
      detail: '窗口里的文件会从协同文件柜列表移除；已经发到 ChatApp 的文件附件仍可打开。此操作不可撤销。',
      confirmLabel: '永久删除窗口',
      cancelLabel: '保留窗口',
      tone: 'danger',
    });
    if (choice !== 'confirm') return;
    await CollaborationStore.deleteSession(session.id);
    trackEvent('删除协同窗口');
    const next = sessions.filter(item => item.id !== session.id);
    setSessions(next);
    if (activeSessionId === session.id) {
      setActiveSessionId(null);
      setMessages([]);
      setShowEntryChooser(next.length > 0);
      setShowModePicker(next.length === 0);
    }
    notify('协同窗口已删除', 'success');
  };

  const moveSession = async (session: CollaborationSession, categoryId?: string) => {
    await updateSession({ ...session, categoryId, updatedAt: Date.now() });
  };

  const createCategory = async (name: string) => {
    const category: CollaborationCategory = { id: collaborationId('category'), name: name.slice(0, 24), createdAt: Date.now() };
    await CollaborationStore.saveCategory(category);
    setCategories(previous => [...previous, category]);
  };

  const deleteCategory = async (category: CollaborationCategory) => {
    const choice = await requestActionDialog({
      title: '删除这个分类？',
      description: `分类“${category.name}”会被删除，但里面的协同窗口都会保留。`,
      detail: '这些窗口会回到“未分类”，不会删除消息、文件或记忆。',
      confirmLabel: '删除分类',
      cancelLabel: '保留分类',
      tone: 'danger',
    });
    if (choice !== 'confirm') return;
    await CollaborationStore.deleteCategory(category.id);
    setCategories(previous => previous.filter(item => item.id !== category.id));
    setSessions(previous => previous.map(session => session.categoryId === category.id ? { ...session, categoryId: undefined } : session));
    if (categoryFilter === category.id) setCategoryFilter('all');
  };

  const saveSettings = async (next: CollaborationSettings) => {
    await CollaborationStore.saveSettings(next);
    trackEvent('保存协同设置', {
      沉浸线路: analyticsEnum(next.immersive.source, ['chat', 'preset', 'custom'], 'custom'),
      中度线路: analyticsEnum(next.focused.source, ['chat', 'preset', 'custom'], 'custom'),
    });
    if (
      next.uiTheme !== settings.uiTheme
      || next.avatarMode !== settings.avatarMode
      || next.avatarStyle !== settings.avatarStyle
    ) {
      trackEvent('设置协同界面', {
        主题: analyticsEnum(next.uiTheme, ANALYTICS_UI_THEMES, 'custom'),
        头像: analyticsEnum(next.avatarMode, ANALYTICS_AVATAR_MODES, 'custom'),
        形状: analyticsEnum(next.avatarStyle, ANALYTICS_AVATAR_STYLES, 'custom'),
      });
    }
    setSettings(next);
    notify('协同设置已保存', 'success');
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let acceptedCount = 0;
    for (const file of Array.from(files)) {
      if (file.size > 30 * 1024 * 1024) {
        notify(`${file.name} 超过 30MB，暂时无法读取`, 'error');
        continue;
      }
      try {
        setUploadStatus(`正在读取 ${file.name}`);
        const isImage = isCollaborationImageFile(file);
        const inferredImageType = file.type || (/\.png$/i.test(file.name)
          ? 'image/png'
          : /\.webp$/i.test(file.name)
            ? 'image/webp'
            : /\.gif$/i.test(file.name)
              ? 'image/gif'
              : 'image/jpeg');
        const readableImageFile = isImage && !file.type
          ? new File([file], file.name, { type: inferredImageType, lastModified: file.lastModified })
          : file;
        const blob = isImage
          ? await processImageToBlob(readableImageFile, { maxWidth: 2048, quality: 0.88 })
          : file;
        let extractedText: string | undefined;
        let pageCount: number | undefined;
        if (isImage) {
          if (chatApi.visionApi?.enabled) {
            try {
              setUploadStatus(`正在识别 ${file.name}`);
              const description = await describeImageWithVisionApi(
                await collaborationBlobToDataUrl(blob),
                chatApi.visionApi,
              );
              extractedText = `[参考图片视觉描述]\n${description}`;
            } catch (error: any) {
              notify(`${file.name} 的独立识图暂不可用，将交给当前协同模型直接看图：${error?.message || '识别失败'}`, 'info');
            }
          }
        } else {
          const extracted = await extractSourceFile(file, setUploadStatus);
          extractedText = extracted.text;
          pageCount = extracted.pageCount;
        }
        const attachment: CollaborationAttachment = {
          id: collaborationId('attachment'),
          assetId: collaborationId('asset'),
          kind: 'source',
          name: file.name,
          mimeType: blob.type || file.type || 'application/octet-stream',
          size: blob.size,
          createdAt: Date.now(),
          extractedText,
          pageCount,
        };
        setPendingAttachments(previous => [...previous, { attachment, blob }]);
        acceptedCount += 1;
      } catch (error: any) {
        notify(`${file.name}：${error?.message || '读取失败'}`, 'error');
      } finally {
        setUploadStatus('');
      }
    }
    if (acceptedCount > 0) trackEvent('协同上传文件', { 数量: bucketFewCount(acceptedCount) });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const openAttachment = async (attachment: CollaborationAttachment) => {
    const blob = await CollaborationStore.getAsset(attachment.assetId);
    if (!blob) {
      notify('文件已经不存在', 'error');
      return;
    }
    if (attachment.kind === 'installable') {
      try {
        const parsed = JSON.parse(await blob.text()) as CollaborationInstallableArtifact;
        if (!COLLABORATION_MAKER_MAP[parsed.kind]) throw new Error('未知作品类型');
        setPreviewArtifact(parsed);
        trackEvent('预览协同作品', { 类型: analyticsMakerKind(parsed.kind) });
      } catch (error: any) {
        notify(`作品无法预览：${error?.message || '数据损坏'}`, 'error');
      }
      return;
    }
    try {
      const result = await shareOrDownloadBlob({
        blob,
        fileName: attachment.name,
        shareTitle: attachment.name,
      });
      if (result === 'shared') notify('已打开系统分享面板', 'success');
      else if (result === 'downloaded') notify('文件已下载', 'success');
      if (result !== 'cancelled') trackEvent('打开协同文件', { 方式: result === 'shared' ? '分享' : '下载' });
    } catch (error: any) {
      notify(error?.message || '无法分享或导出这个文件', 'error');
    }
  };

  const deleteLibraryFile = async (file: CollaborationLibraryFile) => {
    const choice = await requestActionDialog({
      title: '永久删除这个文件？',
      description: `“${file.name}”的文件本体会被删除。`,
      detail: '协同窗口和 ChatApp 中引用它的附件都将无法再次打开。此操作不可撤销。',
      confirmLabel: '永久删除文件',
      cancelLabel: '保留文件',
      tone: 'danger',
    });
    if (choice !== 'confirm') return;
    try {
      await CollaborationStore.deleteLibraryFile(file.assetId);
      setLibraryFiles(previous => previous.filter(item => item.assetId !== file.assetId));
      setMessages(previous => previous.map(message => ({
        ...message,
        attachments: message.attachments?.filter(attachment => attachment.assetId !== file.assetId),
      })));
      trackEvent('删除协同文件');
      notify('文件已删除', 'success');
    } catch (error: any) {
      notify(error?.message || '文件删除失败', 'error');
    }
  };

  const chooseMaker = async (kind: CollaborationMakerKind) => {
    if (!activeSession) return;
    await updateSession({ ...activeSession, makerKind: kind, updatedAt: Date.now() });
    trackEvent('选择协同制作类型', { 类型: analyticsMakerKind(kind) });
    setMakerOpen(false);
    if (!draft.trim()) setDraft(`请和我一起做「${COLLABORATION_MAKER_MAP[kind].label}」。我希望它的感觉是：`);
  };

  const toggleChatCollaboration = async (enabled: boolean) => {
    if (!enabled) {
      onToggleChatCollaboration(false);
      trackEvent('切换日常聊天协同', { 状态: '关' });
      return;
    }
    const choice = await requestActionDialog({
      title: `让 ${character.name} 在日常聊天中知道协同功能？`,
      description: `${character.name} 会知道你们另有一个独立工作区，也能读取并发送文件柜里已经做好的文件。`,
      detail: '普通聊天不会因此变成工作模式：不能在那里新建、修改、整理或重新导出 Word、PDF、美化和可安装作品。真正干活仍要进入「协同工作」。',
      confirmLabel: '仍然开启',
      cancelLabel: '暂不开启',
      tone: 'warning',
    });
    if (choice !== 'confirm') return;
    onToggleChatCollaboration(true);
    trackEvent('切换日常聊天协同', { 状态: '开' });
  };

  const persistPendingAttachments = async () => {
    await Promise.all(pendingAttachments.map(item => CollaborationStore.saveAsset({
      id: item.attachment.assetId,
      blob: item.blob,
      createdAt: item.attachment.createdAt,
    })));
  };

  const generateCollaborationReply = async (
    sessionAtStart: CollaborationSession,
    requestMessages: CollaborationMessage[],
    latestUserMessage: CollaborationMessage,
  ) => {
    const profile = settings[sessionAtStart.mode];
    if (!isCollaborationApiConfigured(profile)) {
      setSettingsOpen(true);
      notify(`请先配置${MODE_LABELS[sessionAtStart.mode]}使用的 API`, 'info');
      return;
    }

    const abortController = new AbortController();
    abortRef.current = abortController;
    setIsGenerating(true);
    setStreamingText('');
    const taskText = collaborationMessageTaskText(latestUserMessage);
    let startedSession = sessionAtStart;
    try {
      let contextSnapshot = sessionAtStart.contextSnapshot || '';
      let liveChatContext: CollaborationContextMessage[] = [];
      const chatContextChoice = settings.recentChatContextCount ?? 'configured';
      const liveHistory = await loadCollaborationChatHistory(character, chatContextChoice);
      const liveRecentChatMessages = liveHistory.messages;
      const chatContextLimit = liveRecentChatMessages.length;
      setChatReadReceipt({ sessionId: sessionAtStart.id, count: chatContextLimit });
      if (sessionAtStart.mode === 'immersive') {
        const immersiveContext = await buildLiveCollaborationChatContext({
          char: liveHistory.character,
          user,
          groups,
          emojis,
          categories: emojiCategories,
          recentChatMessages: liveRecentChatMessages,
          mode: 'immersive',
          chatContextLimit,
          realtimeConfig,
        });
        contextSnapshot = immersiveContext.contextSnapshot;
        liveChatContext = immersiveContext.chatContextSnapshot;
      } else {
        if (chatContextLimit > 0) {
          const focusedChatContext = await buildLiveCollaborationChatContext({
            char: liveHistory.character,
            user,
            groups,
            emojis,
            categories: emojiCategories,
            recentChatMessages: liveRecentChatMessages,
            mode: 'focused',
            chatContextLimit,
            realtimeConfig,
          });
          liveChatContext = [
            { role: 'system', content: `### ChatApp 实时聊天衔接\n以下是每次生成前重新读取的 ${chatContextChoice === 'configured' ? `ChatApp 用户设定范围（本次 ${chatContextLimit} 条）` : `最近 ${chatContextLimit} 条私聊`}；它们只用于理解当前工作来龙去脉，不属于本协同窗口的对话。` },
            ...focusedChatContext.chatContextSnapshot,
          ];
        }
        if (!contextSnapshot) {
          contextSnapshot = await buildCollaborationContextSnapshot({
            char: liveHistory.character,
            user,
            mode: sessionAtStart.mode,
            taskText,
            emojis,
            categories: emojiCategories,
          });
        }
      }
      const turnMemoryContext = await buildCollaborationTurnMemoryContext({
        char: character,
        user,
        mode: sessionAtStart.mode,
        messages: requestMessages,
        taskText,
      });
      const nextTitle = sessionAtStart.title === '新的协同'
        ? shortPreview(latestUserMessage.content || latestUserMessage.attachments?.[0]?.name || '新的协同', 28)
        : sessionAtStart.title;
      startedSession = {
        ...sessionAtStart,
        title: nextTitle,
        contextSnapshot,
        // Pre-upgrade sessions may contain a frozen transcript. Clear it once
        // touched; the current request uses liveChatContext directly instead.
        chatContextSnapshot: undefined,
        updatedAt: Date.now(),
        lastMessagePreview: collaborationMessagePreview(latestUserMessage),
      };
      await updateSession(startedSession);

      const reply = await runCollaborationTurn({
        profile,
        contextSnapshot,
        messages: requestMessages,
        signal: abortController.signal,
        onDelta: setStreamingText,
        makerKind: startedSession.makerKind,
        chatContextSnapshot: liveChatContext,
        thinkingEnabled: !!character.showThinkingChain,
        turnContext: turnMemoryContext,
      });
      const parsedFiles = parseArtifactBlocks(reply.content);
      const parsedInstallables = parseInstallableArtifactBlocks(parsedFiles.visibleText);
      const visibleReply = sanitizeCollaborationRichOutputSource(normalizeCollaborationVisibleText(parsedInstallables.visibleText));
      const generatedAttachments: CollaborationAttachment[] = [];
      for (const artifact of parsedFiles.artifacts) {
        const materialized = await materializeArtifact(artifact);
        await CollaborationStore.saveAsset({ id: materialized.attachment.assetId, blob: materialized.blob, createdAt: Date.now() });
        generatedAttachments.push(materialized.attachment);
      }
      for (const artifact of parsedInstallables.artifacts) {
        const materialized = materializeInstallableArtifact(artifact);
        await CollaborationStore.saveAsset({ id: materialized.attachment.assetId, blob: materialized.blob, createdAt: Date.now() });
        generatedAttachments.push(materialized.attachment);
      }
      if (generatedAttachments.length > 0) {
        const hasInstallable = generatedAttachments.some(attachment => attachment.kind === 'installable');
        const hasFile = generatedAttachments.some(attachment => attachment.kind !== 'installable');
        trackEvent('协同生成文件', {
          结果: hasInstallable && hasFile ? '文件和作品' : hasInstallable ? '可安装作品' : '文件',
          数量: bucketFewCount(generatedAttachments.length),
        });
      }
      const assistantMessage: CollaborationMessage = {
        id: collaborationId('message'),
        sessionId: sessionAtStart.id,
        role: 'assistant',
        content: visibleReply || (generatedAttachments.length ? '我做好了，作品放在这里。' : sanitizeCollaborationRichOutputSource(normalizeCollaborationVisibleText(reply.content))),
        thinkingChain: reply.thinkingChain,
        createdAt: Date.now(),
        attachments: generatedAttachments,
      };
      await CollaborationStore.saveMessage(assistantMessage);
      setMessages([...requestMessages, assistantMessage]);
      await updateSession({
        ...startedSession,
        updatedAt: assistantMessage.createdAt,
        lastMessagePreview: collaborationMessagePreview(assistantMessage),
      });
      if (libraryOpen) void refreshLibrary();
    } catch (error: any) {
      const stopped = abortController.signal.aborted || /abort/i.test(error?.message || '');
      const systemMessage: CollaborationMessage = {
        id: collaborationId('message'),
        sessionId: sessionAtStart.id,
        role: 'system',
        content: stopped ? '已停止这次生成。' : `这次没有完成：${error?.message || 'API 请求失败'}`,
        createdAt: Date.now(),
      };
      await CollaborationStore.saveMessage(systemMessage);
      setMessages([...requestMessages, systemMessage]);
      await updateSession({
        ...startedSession,
        updatedAt: systemMessage.createdAt,
        lastMessagePreview: collaborationMessagePreview(systemMessage),
      });
      if (!stopped) notify(error?.message || '协同请求失败', 'error');
    } finally {
      if (abortRef.current === abortController) abortRef.current = null;
      setIsGenerating(false);
      setStreamingText('');
    }
  };

  const send = async () => {
    if (!activeSession || isGenerating || uploadStatus) return;
    const content = draft.trim();
    if (!content && pendingAttachments.length === 0) return;
    const profile = settings[activeSession.mode];
    if (!isCollaborationApiConfigured(profile)) {
      setSettingsOpen(true);
      notify(`请先配置${MODE_LABELS[activeSession.mode]}使用的 API`, 'info');
      return;
    }

    const now = Date.now();
    const userMessage: CollaborationMessage = {
      id: collaborationId('message'),
      sessionId: activeSession.id,
      role: 'user',
      content,
      ...(requestedOutputFormat ? { requestedFormat: requestedOutputFormat } : {}),
      createdAt: now,
      attachments: pendingAttachments.map(item => item.attachment),
    };
    await persistPendingAttachments();
    await CollaborationStore.saveMessage(userMessage);
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft('');
    setPendingAttachments([]);
    setRequestedOutputFormat(null);

    await generateCollaborationReply(activeSession, nextMessages, userMessage);
  };

  const rerollLatestReply = async () => {
    if (!activeSession || isGenerating || uploadStatus) return;
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex < 0) {
      notify('还没有可以重新生成的用户消息', 'info');
      return;
    }
    const profile = settings[activeSession.mode];
    if (!isCollaborationApiConfigured(profile)) {
      setSettingsOpen(true);
      notify(`请先配置${MODE_LABELS[activeSession.mode]}使用的 API`, 'info');
      return;
    }
    const requestMessages = messages.slice(0, lastUserIndex + 1);
    const latestUserMessage = requestMessages[lastUserIndex];
    const replacedMessages = messages.slice(lastUserIndex + 1);
    await CollaborationStore.deleteMessages(replacedMessages.map(message => message.id));
    setMessages(requestMessages);
    trackEvent('重新生成协同回复', {
      上次结果: replacedMessages.some(message => message.role === 'assistant') ? '已完成' : replacedMessages.length > 0 ? '失败或停止' : '无回复',
    });
    await generateCollaborationReply(activeSession, requestMessages, latestUserMessage);
  };

  const copyMessage = async (message: CollaborationMessage) => {
    const copied = await copyCollaborationText(message.content);
    trackEvent('复制协同消息', { 结果: copied ? '成功' : '失败', 角色: message.role });
    notify(copied ? '内容已复制' : '复制失败，请稍后重试', copied ? 'success' : 'error');
  };

  const beginMessageEdit = (message: CollaborationMessage) => {
    if (message.role === 'system' || !message.content.trim()) {
      notify('这条内容不支持编辑', 'info');
      return;
    }
    setEditingMessage(message);
    setEditDraft(message.content);
  };

  const saveMessageEdit = async () => {
    if (!activeSession || !editingMessage || editSaving || isGenerating) return;
    const content = editDraft.trim();
    if (!content) return;
    const messageIndex = messages.findIndex(message => message.id === editingMessage.id);
    if (messageIndex < 0) {
      setEditingMessage(null);
      setEditDraft('');
      notify('这条消息已经不存在了', 'error');
      return;
    }
    setEditSaving(true);
    try {
      const updatedMessage: CollaborationMessage = { ...editingMessage, content };
      await CollaborationStore.saveMessage(updatedMessage);
      if (updatedMessage.role === 'user') {
        const droppedMessages = messages.slice(messageIndex + 1);
        await CollaborationStore.deleteMessages(droppedMessages.map(message => message.id));
        const requestMessages = [...messages.slice(0, messageIndex), updatedMessage];
        setMessages(requestMessages);
        const updatedSession = {
          ...activeSession,
          updatedAt: Date.now(),
          lastMessagePreview: collaborationMessagePreview(updatedMessage),
        };
        await updateSession(updatedSession);
        setEditingMessage(null);
        setEditDraft('');
        if (libraryOpen) void refreshLibrary();
        trackEvent('编辑协同消息', { 角色: 'user', 后续移除: bucketFewCount(droppedMessages.length) });
        notify('消息已修改，正在重新生成', 'success');
        await generateCollaborationReply(updatedSession, requestMessages, updatedMessage);
        return;
      }

      const nextMessages = messages.map(message => message.id === updatedMessage.id ? updatedMessage : message);
      setMessages(nextMessages);
      const latestMessage = nextMessages[nextMessages.length - 1];
      await updateSession({
        ...activeSession,
        updatedAt: Date.now(),
        lastMessagePreview: collaborationMessagePreview(latestMessage),
      });
      setEditingMessage(null);
      setEditDraft('');
      trackEvent('编辑协同消息', { 角色: updatedMessage.role });
      notify('内容已修改', 'success');
    } catch (error: any) {
      notify(error?.message || '消息修改失败', 'error');
    } finally {
      setEditSaving(false);
    }
  };

  const deleteMessage = async (message: CollaborationMessage) => {
    if (!activeSession || isGenerating) {
      if (isGenerating) notify('请先停止这次生成，再删除消息', 'info');
      return;
    }
    const messageIndex = messages.findIndex(item => item.id === message.id);
    if (messageIndex < 0) return;
    let deleteEnd = messageIndex + 1;
    if (message.role === 'user') {
      while (deleteEnd < messages.length && messages[deleteEnd].role !== 'user') deleteEnd += 1;
    }
    const rowsToDelete = messages.slice(messageIndex, deleteEnd);
    const choice = await requestActionDialog({
      title: message.role === 'user' ? '删除这一轮协同？' : message.role === 'assistant' ? '删除这条回复？' : '删除这条提示？',
      description: message.role === 'user'
        ? `这条用户消息和 ${character.name} 紧随其后的回复会一起删除。`
        : '只会删除你刚刚长按的这一条内容。',
      detail: rowsToDelete.some(row => (row.attachments || []).length > 0)
        ? '消息中的文件会从协同文件柜列表移除；已经发到 ChatApp 的附件仍可打开。此操作不可撤销。'
        : '删除后不会影响其它协同窗口，也不会改动普通聊天与角色记忆。此操作不可撤销。',
      confirmLabel: message.role === 'user' ? '永久删除这一轮' : '永久删除这条内容',
      cancelLabel: '保留内容',
      tone: 'danger',
    });
    if (choice !== 'confirm') return;
    await CollaborationStore.deleteMessages(rowsToDelete.map(row => row.id));
    const deletedIds = new Set(rowsToDelete.map(row => row.id));
    const remainingMessages = messages.filter(row => !deletedIds.has(row.id));
    setMessages(remainingMessages);
    const lastMessage = remainingMessages[remainingMessages.length - 1];
    await updateSession({
      ...activeSession,
      updatedAt: Date.now(),
      lastMessagePreview: collaborationMessagePreview(lastMessage),
    });
    if (libraryOpen) void refreshLibrary();
    trackEvent('删除协同消息', { 范围: message.role === 'user' ? '整轮' : '单条' });
    notify(message.role === 'user' ? '这一轮协同已删除' : '这条内容已删除', 'success');
  };

  const openMessageActions = async (message: CollaborationMessage) => {
    if (isGenerating) {
      notify('请先停止这次生成，再处理消息', 'info');
      return;
    }
    const canEdit = message.role !== 'system' && !!message.content.trim();
    const canCopy = !!message.content.trim();
    const choice = await requestActionDialog({
      title: message.role === 'user' ? '处理自己的消息' : message.role === 'assistant' ? `处理 ${character.name} 的回复` : '处理这条提示',
      description: canEdit && message.role === 'user'
        ? '可以修改后从这一条重新生成，也可以复制或删除。'
        : '选择要对刚刚长按的这条内容执行的操作。',
      detail: (message.attachments || []).length > 0 ? '编辑正文不会移除这条消息里已有的附件。' : undefined,
      confirmLabel: canEdit ? (message.role === 'user' ? '编辑并重新生成' : '编辑内容') : canCopy ? '复制内容' : undefined,
      secondaryLabel: canEdit && canCopy ? '复制内容' : undefined,
      destructiveLabel: message.role === 'user' ? '删除这一轮' : '删除这条内容',
      cancelLabel: '取消',
    });
    if (choice === 'confirm') {
      if (canEdit) beginMessageEdit(message);
      else if (canCopy) await copyMessage(message);
      return;
    }
    if (choice === 'secondary') {
      await copyMessage(message);
      return;
    }
    if (choice === 'destructive') await deleteMessage(message);
  };

  const transferToChat = async () => {
    if (!activeSession) return;
    if (transferring) return;
    const transferable = selectCollaborationTransfer(messages, activeSession.id, transferIds);
    if (transferable.length === 0) {
      notify('这个窗口还没有可以发送的上下文', 'info');
      return;
    }
    setTransferring(true);
    try {
      await onSendToChat(activeSession.title, transferable);
      setTransferOpen(false);
      setTransferIds(new Set());
    } catch (error: any) {
      notify(error?.message || '发送失败，请重试', 'error');
      return;
    } finally { setTransferring(false); }
    trackEvent('发送协同上下文到聊天', {
      模式: analyticsEnum(activeSession.mode, ['immersive', 'focused'], 'custom'),
    });
    notify('已将选中的 ' + transferable.length + ' 条消息发给 ChatApp', 'success');
  };

  const backgroundStyle: React.CSSProperties = backgroundUrl
    ? { backgroundImage: `linear-gradient(rgba(248,250,252,.78), rgba(248,250,252,.78)), url("${backgroundUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { backgroundColor: '#f4f6fa', backgroundImage: 'radial-gradient(circle at 20% 0%, rgba(99,102,241,.09), transparent 28%), radial-gradient(circle at 90% 80%, rgba(148,163,184,.12), transparent 30%)' };
  const uiTheme = settings.uiTheme || 'sully';
  const uiThemeSpec = COLLABORATION_UI_THEMES.find(item => item.id === uiTheme) || COLLABORATION_UI_THEMES[0];
  const requestedAvatarMode = settings.avatarMode || 'theme';
  const avatarMode = requestedAvatarMode === 'theme' ? THEME_AVATAR_MODE[uiTheme] : requestedAvatarMode;
  const avatarStyle = settings.avatarStyle || 'circle';
  const chatContextChoice = settings.recentChatContextCount ?? 'configured';
  const chatContextLabel = chatContextChoice === 'configured'
    ? 'Chat 实时 · 用户设定范围'
    : chatContextChoice > 0
      ? `Chat 实时 ${chatContextChoice} 条`
      : '不读取 Chat';
  const streamingArtifactText = streamingText
    ? parseInstallableArtifactBlocks(parseArtifactBlocks(streamingText).visibleText).visibleText
    : '';
  const streamingRichOutput = parseCollaborationRichOutput(streamingArtifactText);
  const streamingRichLabel = streamingRichOutput.voice
    ? '正在准备语音…'
    : streamingRichOutput.emojiNames.length > 0
      ? '正在发送表情包…'
      : '正在制作作品…';

  if (!open) return null;

  if (!loaded) {
    return <div className="absolute inset-0 z-[120] grid place-items-center bg-[#f7f8fb]"><SpinnerGap size={28} className="animate-spin text-slate-400" /></div>;
  }

  return (
    <div className={`collab-ui-root collab-ui-${uiTheme} collab-avatar-${avatarMode} collab-avatar-style-${avatarStyle} absolute inset-0 z-[120] flex flex-col overflow-hidden bg-[#f4f6fa] font-sans animate-[collabEnter_.28s_cubic-bezier(.2,.8,.2,1)]`} style={uiTheme === 'sully' ? backgroundStyle : undefined}>
      <style>{`
        @keyframes collabEnter { from { opacity: 0; transform: translateY(14px) scale(.992); } to { opacity: 1; transform: none; } }
        @keyframes collabFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes collabRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        @keyframes collabSheetIn { from { opacity: 0; transform: translateY(22px) scale(.985); } to { opacity: 1; transform: none; } }
        ${COLLABORATION_UI_THEME_CSS}
      `}</style>

      <header className="collab-safe-header collab-ui-header relative z-20 flex h-16 shrink-0 items-center border-b border-white/60 bg-white/78 px-2 shadow-[0_1px_0_rgba(15,23,42,.04)] backdrop-blur-xl">
        <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 active:bg-slate-100/80" aria-label="返回 ChatApp"><ArrowLeft size={22} /></button>
        <button type="button" onClick={() => setDrawerOpen(true)} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 active:bg-slate-100/80" aria-label="协同窗口列表"><List size={21} /></button>
        <div className="collab-header-identity flex min-w-0 flex-1 items-center justify-center gap-2 px-2">
          <TokenImg value={character.avatar} alt={character.name} className="collab-header-avatar h-9 w-9 rounded-full object-cover shadow-sm ring-1 ring-black/5" />
          <div className="collab-header-copy min-w-0 text-left">
            <div className="flex items-center gap-1.5">
              <span className="collab-session-title truncate text-[13px] font-semibold text-slate-800">{activeSession?.title || (showEntryChooser ? '协同工作' : '新的协同')}</span>
              {activeSession && <span className={`collab-session-dot h-1.5 w-1.5 shrink-0 rounded-full ${activeSession.mode === 'immersive' ? 'bg-indigo-500' : 'bg-slate-400'}`} />}
            </div>
            <p className="collab-header-meta truncate text-[9px] text-slate-500">{activeSession ? `${character.name} · ${MODE_LABELS[activeSession.mode]} · ${chatContextLabel}${chatReadReceipt?.sessionId === activeSession.id ? ` · 本次读取 ${chatReadReceipt.count} 条` : ''}${activeSession.makerKind ? ` · ${COLLABORATION_MAKER_MAP[activeSession.makerKind].shortLabel}` : ''}` : showEntryChooser ? '新建或继续一项协同' : '选择协同模式'}</p>
          </div>
        </div>
        <button type="button" onClick={() => void rerollLatestReply()} disabled={!activeSession || isGenerating || !messages.some(message => message.role === 'user')} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 disabled:opacity-25 active:bg-slate-100/80" aria-label="重新生成上一条回复" title="重新生成上一条回复"><ArrowCounterClockwise size={20} /></button>
        <button type="button" onClick={() => { setTransferIds(new Set()); setTransferOpen(true); }} disabled={!activeSession || messages.length === 0} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 disabled:opacity-25 active:bg-slate-100/80" aria-label="选择消息发送到 ChatApp" title="选择消息发送到 ChatApp"><PaperPlaneRight size={20} /></button>
        <button type="button" onClick={() => { setLibraryOpen(true); trackEvent('打开协同文件库'); }} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 active:bg-slate-100/80" aria-label="协同文件库"><Folder size={20} /></button>
        <button type="button" onClick={() => setSettingsOpen(true)} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 active:bg-slate-100/80" aria-label="协同设置"><GearSix size={20} /></button>
      </header>

      {showEntryChooser ? (
        <CollaborationEntryChooser
          character={character}
          sessions={sessions}
          onNew={() => { setShowEntryChooser(false); setShowModePicker(true); setActiveSessionId(null); }}
          onHistory={() => {
            setSessionFilter(sessions.some(session => !session.archivedAt) ? 'active' : 'archived');
            setCategoryFilter('all');
            setDrawerOpen(true);
          }}
        />
      ) : showModePicker || !activeSession ? (
        <ModePicker character={character} onChoose={createSession} onBack={sessions.length > 0 ? () => { setShowModePicker(false); setShowEntryChooser(true); } : undefined} />
      ) : (
        <>
          <div ref={scrollRef} className="collab-ui-thread flex-1 overflow-y-auto overflow-x-hidden pb-5 pt-4 no-scrollbar">
            {messages.length === 0 && !isGenerating && (
              <div className="collab-empty-state mx-auto flex min-h-full max-w-md flex-col items-center justify-center px-8 pb-20 text-center">
                <div className="collab-empty-brand-wrap relative">
                  <TokenImg value={character.avatar} alt={character.name} className="collab-empty-avatar h-20 w-20 rounded-[26px] object-cover shadow-lg ring-4 ring-white/70" />
                </div>
                <h2 className="mt-5 text-xl font-semibold tracking-tight text-slate-800">{uiThemeSpec.emptyTitle}</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">{uiThemeSpec.emptyDescription.replace('角色', character.name)}</p>
                <div className="collab-empty-starters mt-8 flex flex-wrap justify-center gap-2">
                  {['帮我整理这份文件', '制作一份 PDF'].map(starter => (
                    <button key={starter} type="button" onClick={() => setDraft(starter)} className="collab-empty-starter rounded-full border border-white/80 bg-white/70 px-3.5 py-2 text-[11px] text-slate-600 shadow-sm backdrop-blur-sm active:scale-95">{starter}</button>
                  ))}
                  <button type="button" onClick={() => setMakerOpen(true)} className="collab-empty-starter collab-accent-chip rounded-full border border-indigo-200 bg-indigo-50/90 px-3.5 py-2 text-[11px] font-semibold text-indigo-600 shadow-sm active:scale-95">制作可安装作品</button>
                </div>
              </div>
            )}
            {messages.map(message => (
              <MessageBubble
                key={message.id}
                message={message}
                character={character}
                user={user}
                theme={theme}
                uiTheme={uiTheme}
                emojis={visibleEmojiLibrary.emojis}
                emojiCategories={visibleEmojiLibrary.categories}
                voiceState={{
                  loading: voiceLoadingIds.has(message.id),
                  playing: playingVoiceId === message.id,
                  url: voiceAudioUrls[message.id],
                }}
                onPlayVoice={playCollaborationVoice}
                onOpenAttachment={openAttachment}
                onLongPress={openMessageActions}
              />
            ))}
            {isGenerating && (
              <div className="collab-message-row collab-message-row-assistant flex items-end gap-2.5 px-4 py-2">
                <TokenImg value={character.avatar} alt={character.name} className="collab-message-avatar collab-message-avatar-assistant h-8 w-8 rounded-full object-cover shadow-sm ring-1 ring-black/5" />
                <div className="collab-message-stack collab-message-bubble collab-message-bubble-assistant min-w-0 max-w-[78%] rounded-[20px] bg-white px-4 py-3 text-[15px] leading-7 text-slate-700 shadow-sm">
                  {streamingText
                    ? streamingRichOutput.text
                      ? <CollaborationMarkdownView content={streamingRichOutput.text} />
                      : <span className="flex items-center gap-2 text-sm text-slate-400"><SpinnerGap size={16} className="animate-spin" />{streamingRichLabel}</span>
                    : <span className="flex items-center gap-2 text-sm text-slate-400"><SpinnerGap size={16} className="animate-spin" />{character.name} 正在处理</span>}
                </div>
              </div>
            )}
          </div>

          <div className="collab-ui-composer relative z-20 shrink-0 border-t border-white/70 bg-white/82 px-3 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl">
            <div className="collab-composer-tools mb-2 flex items-center gap-2 overflow-x-auto no-scrollbar">
              <button type="button" onClick={() => setMakerOpen(true)} disabled={isGenerating} className="collab-primary-action flex shrink-0 items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1.5 text-[10px] font-semibold text-white disabled:opacity-40"><Plus size={12} weight="bold" />制作</button>
              <select
                value={requestedOutputFormat || ''}
                onChange={event => setRequestedOutputFormat((event.target.value || null) as CollaborationArtifactFormat | null)}
                disabled={isGenerating}
                aria-label="选择文件交付格式"
                title="支持 Word、PDF、Markdown、纯文本、HTML 和 JSON"
                className="h-7 shrink-0 rounded-full border-0 bg-slate-100 px-3 text-[10px] font-medium text-slate-600 outline-none disabled:opacity-40"
              >
                {OUTPUT_FORMAT_OPTIONS.map(option => <option key={option.value || 'auto'} value={option.value}>{option.label}</option>)}
              </select>
              {COLLABORATION_MAKERS.slice(0, 5).map(maker => (
                <button key={maker.kind} type="button" onClick={() => void chooseMaker(maker.kind)} disabled={isGenerating} className={`shrink-0 rounded-full px-3 py-1.5 text-[10px] font-medium transition-colors disabled:opacity-40 ${activeSession.makerKind === maker.kind ? 'collab-accent-chip bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}`}>{maker.shortLabel}</button>
              ))}
            </div>
            {(pendingAttachments.length > 0 || uploadStatus) && (
              <div className="mb-2 flex gap-2 overflow-x-auto no-scrollbar">
                {pendingAttachments.map(item => (
                  <div key={item.attachment.id} className="flex max-w-[220px] shrink-0 items-center gap-2 rounded-xl bg-slate-100 px-3 py-2">
                    {/^image\//i.test(item.attachment.mimeType) ? <ImageSquare size={16} className="shrink-0 text-sky-500" /> : <FileText size={16} className="shrink-0 text-indigo-500" />}
                    <span className="truncate text-[10px] text-slate-600">{item.attachment.name}</span>
                    <button type="button" onClick={() => setPendingAttachments(previous => previous.filter(pending => pending.attachment.id !== item.attachment.id))} className="text-slate-400"><X size={13} /></button>
                  </div>
                ))}
                {uploadStatus && <div className="flex shrink-0 items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-[10px] text-slate-500"><SpinnerGap size={14} className="animate-spin" />{uploadStatus}</div>}
              </div>
            )}
            <div className="collab-composer-field flex items-end gap-2 rounded-[24px] border border-slate-200/90 bg-white px-2 py-2 shadow-[0_8px_30px_rgba(15,23,42,.08)]">
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isGenerating || !!uploadStatus} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-500 active:bg-slate-100 disabled:opacity-40" aria-label="上传文件或参考图片" title="支持图片、PDF、Word 与文本资料"><FileArrowUp size={21} /></button>
              <input ref={fileInputRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.doc,.txt,.md,.markdown,.json,.csv,.tsv,.html,.htm,.xml,.yaml,.yml" className="hidden" onChange={event => void handleFiles(event.target.files)} />
              <textarea
                value={draft}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={`告诉 ${character.name} 要完成什么…`}
                rows={1}
                className="max-h-32 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-5 text-slate-800 outline-none placeholder:text-slate-400"
              />
              {isGenerating ? (
                <button type="button" onClick={() => abortCollaborationRequest(abortRef.current, '用户已停止生成')} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-900 text-white active:scale-95" aria-label="停止生成"><Stop size={15} weight="fill" /></button>
              ) : (
                <button type="button" onClick={() => void send()} disabled={(!draft.trim() && pendingAttachments.length === 0) || !!uploadStatus} className="collab-primary-action grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-900 text-white disabled:bg-slate-200 disabled:text-slate-400 active:scale-95" aria-label="发送"><PaperPlaneRight size={18} weight="fill" /></button>
              )}
            </div>
          </div>
        </>
      )}

      {transferOpen && activeSession && <div className="absolute inset-0 z-[180] flex flex-col bg-slate-50" role="dialog" aria-modal="true" aria-label="选择发送到 ChatApp 的消息" style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}>
        <header className="flex items-center justify-between gap-2 border-b border-slate-200 p-4">
          <button disabled={transferring} onClick={() => setTransferOpen(false)} className="text-sm text-slate-500">取消</button>
          <h2 className="text-sm font-semibold">选择消息</h2>
          <button onClick={() => setTransferIds(new Set(messages.filter(message => message.sessionId === activeSession.id && (message.role === 'user' || message.role === 'assistant')).map(message => message.id)))} className="text-sm text-indigo-500">全选</button>
        </header>
        <p className="px-4 py-3 text-xs text-slate-500">只发送勾选的正文和附件文字，不包含思考过程。</p>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {messages.filter(message => message.sessionId === activeSession.id && (message.role === 'user' || message.role === 'assistant')).map(message => <label key={message.id} className="mb-3 flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3">
            <input type="checkbox" className="mt-1" checked={transferIds.has(message.id)} onChange={() => setTransferIds(prev => { const next = new Set(prev); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}/>
            <span className="min-w-0 flex-1"><span className="block text-[10px] font-semibold text-slate-400">{message.role === 'user' ? user.name : character.name}</span><span className="mt-1 block whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-700">{message.content || '附件消息'}</span>{message.attachments?.map(attachment => <span key={attachment.id} className="mt-2 block break-all text-[10px] text-indigo-500">文件：{attachment.name}</span>)}</span>
          </label>)}
        </div>
        <footer className="flex items-center gap-3 border-t border-slate-200 p-4"><button onClick={() => setTransferIds(new Set())} className="text-xs text-slate-400">清空选择</button><button onClick={() => void transferToChat()} disabled={!transferIds.size || transferring} className="flex-1 rounded-xl bg-slate-900 py-3 text-sm text-white disabled:opacity-40">{transferring ? '发送中…' : '发送 ' + transferIds.size + ' 条到 ChatApp'}</button></footer>
      </div>}

      <SessionDrawer
        open={drawerOpen}
        sessions={sessions}
        categories={categories}
        activeSessionId={activeSessionId}
        filter={sessionFilter}
        categoryFilter={categoryFilter}
        onFilter={setSessionFilter}
        onCategoryFilter={setCategoryFilter}
        onChoose={id => { setActiveSessionId(id); setShowModePicker(false); setShowEntryChooser(false); setDrawerOpen(false); }}
        onNew={() => { setShowEntryChooser(false); setShowModePicker(true); setActiveSessionId(null); setDrawerOpen(false); }}
        onClose={() => setDrawerOpen(false)}
        onArchive={(session, archived) => void archiveSession(session, archived)}
        onDelete={session => void deleteSession(session)}
        onMove={(session, categoryId) => void moveSession(session, categoryId)}
        onCreateCategory={name => void createCategory(name)}
        onDeleteCategory={category => void deleteCategory(category)}
      />

      <CollaborationFileLibrary
        open={libraryOpen}
        files={libraryFiles}
        loading={libraryLoading}
        onClose={() => setLibraryOpen(false)}
        onOpen={file => void openAttachment(file)}
        onDelete={file => void deleteLibraryFile(file)}
      />

      {settingsOpen && (
        <ApiSettingsPanel
          settings={settings}
          character={character}
          user={user}
          chatCollaborationEnabled={chatCollaborationEnabled}
          chatApi={chatApi}
          apiPresets={apiPresets}
          availableModels={availableModels}
          onToggleChatCollaboration={enabled => void toggleChatCollaboration(enabled)}
          onSave={saveSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {makerOpen && activeSession && (
        <MakerStudio activeKind={activeSession.makerKind} onChoose={kind => void chooseMaker(kind)} onClose={() => setMakerOpen(false)} />
      )}

      {previewArtifact && (
        <InstallablePreview
          artifact={previewArtifact}
          characters={characters}
          currentCharacterId={character.id}
          onClose={() => setPreviewArtifact(null)}
          onInstall={async targetCharacterId => {
            const message = await onInstallArtifact(previewArtifact, targetCharacterId);
            trackEvent('使用协同作品', {
              类型: analyticsMakerKind(previewArtifact.kind),
              目标: targetCharacterId ? '角色' : '全局',
            });
            notify(message, 'success');
            setPreviewArtifact(null);
          }}
        />
      )}

      <CollaborationMessageEditor
        message={editingMessage}
        value={editDraft}
        saving={editSaving}
        onChange={setEditDraft}
        onCancel={() => {
          if (editSaving) return;
          setEditingMessage(null);
          setEditDraft('');
        }}
        onSave={() => void saveMessageEdit()}
      />

      <CollaborationActionDialog dialog={actionDialog} onResolve={resolveActionDialog} />
    </div>
  );
};

export default CollaborationWindow;

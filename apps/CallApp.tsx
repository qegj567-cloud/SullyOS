import { loadCharacterContextMessages } from '../utils/chatContextRange';
import { canAnalyzeVoiceSource, isVoiceAudioPriming, primeVoiceAudio, voicePlaybackErrorMessage } from '../utils/voicePlayback';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Microphone, SpeakerHigh, SpeakerSlash, PhoneDisconnect, Translate, Gear, Clock, CaretLeft, CaretRight, Phone, VideoCamera, VideoCameraSlash, Cube, FolderOpen, FileZip, Moon, Sun, Check } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { extractContent, safeFetchJson } from '../utils/safeApi';
import { minimaxFetch } from '../utils/minimaxEndpoint';
import { resolveMiniMaxApiKey } from '../utils/minimaxApiKey';
import { getCachedTts, saveCachedTts } from '../utils/ttsCache';
import { buildMiniMaxTtsCacheKey, buildMiniMaxTtsPayload, cleanTextForTts, convertHexAudioToBlob, fetchRemoteAudioBlob, getMiniMaxParamVersion, prepareMiniMaxSpeechText, VALID_EMOTIONS, stripEmotionTags, VOICE_ACTING_GUIDE } from '../utils/minimaxTts';
import { normalizeVoiceTags } from '../utils/sanitize';
import { FISH_VOICE_ACTING_GUIDE, stripFishMarkupForDisplay } from '../utils/fishAudioTts';
import { resolveTtsProvider, getElevenLabsModel, getTtsProvider, getVoicePromptOverride } from '../utils/ttsProvider';
import { getElevenLabsVoiceActingGuide, stripElevenLabsMarkupForDisplay } from '../utils/elevenLabsTts';
import { canSynthesizeSpeech, stripTtsMarkupForDisplay, synthesizeSpeechDetailed as synthesizeSpeechRoutedDetailed } from '../utils/ttsRouter';
import { CANTONESE_VOICE_SUPPORT_NOTE, VOICE_LANGUAGE_OPTIONS, voiceLanguageAnalyticsValue, voiceLanguagePromptLabel } from '../utils/voiceLanguage';
import { startStt, isSttSupported, type SttSession } from '../utils/speechToText';
import { ContextBuilder } from '../utils/context';
import { resolveCharTimeZone } from '../utils/timezone';
import {
  injectMemoryPalace,
} from '../utils/memoryPalace/pipeline';
import { processNewMessagesWithAutoArchive } from '../utils/memoryPalace/autoArchive';
import { incrementDigestRound, runCognitiveDigestion } from '../utils/memoryPalace';
import { RealtimeContextManager } from '../utils/realtimeContext';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { Message, ChatTheme, AppID, type CharacterProfile } from '../types';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import VRMVideoCallStage from '../components/call/VRMVideoCallStage';
import Live2DActionSettings from '../components/call/Live2DActionSettings';
import VRoidBetaWarning from '../components/call/VRoidBetaWarning';
import UserCameraModePicker, { type UserCameraMode } from '../components/call/UserCameraModePicker';
import CallSetupGuide, { type CallSetupGuideStep } from '../components/call/CallSetupGuide';
import CallPreferencesSheet from '../components/call/CallPreferencesSheet';
import CallUpdateAnnouncement from '../components/call/CallUpdateAnnouncement';
import { deleteAvatarModel, inspectAvatarFile, saveAvatarModel } from '../utils/avatarModelStore';
import { getLive2DAIActions, prewarmLive2DModelSource, saveLive2DModelFromFiles, saveLive2DModelFromZip, upgradeLive2DAutoPermissions, type Live2DAvatarConfig } from '../utils/live2dModelStore';
import { preloadLive2DRuntime } from '../utils/live2dCore';
import { buildThinkingChainPrompt } from '../utils/thinkingChainPrompt';
import { parseCallAssistantMessage, stripCallTextFormatting, type ParsedCallReply } from '../utils/callReplyFormat';
import { runCallMemoryPalacePostFlow } from '../utils/memoryPalace/callPostFlow';
import {
  buildAvatarPerformancePrompt,
  DEFAULT_AVATAR_PERFORMANCE,
  expandAvatarPerformanceCueBeats,
  inferAvatarPerformanceFromText,
  inferAvatarPerformanceTimelineFromText,
  normalizeAvatarEmotion,
  resolveAvatarPerformance,
  type AvatarPerformanceCue,
  type AvatarPerformanceDirection,
  type AvatarStageFraming,
} from '../utils/avatarPerformance';
import {
  AVATAR_PERFORMANCE_PERSONA_MAX_CHARS,
  AVATAR_PERFORMANCE_PERSONA_MAX_TOKENS,
  AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS,
  buildAvatarPerformancePersonaPrompt,
  buildAvatarPerformanceRehearsalPrompt,
  alignAvatarPerformanceCuesToSentences,
  isCompleteAvatarPerformanceCuePack,
  parseAvatarPerformancePersona,
  parseAvatarPerformanceRehearsal,
  splitAvatarPerformanceSentences,
} from '../utils/avatarPerformanceRehearsal';
import { CallAudioFeed, shouldKeepNativeCallAudio } from '../utils/callAudioFeed';
import {
  loadCallPreferences,
  markCallUpdateAnnouncementSeen,
  saveCallPreferences,
  shouldShowCallUpdateAnnouncement,
  type CallPreferences,
} from '../utils/callPreferences';
import {
  appendPendingAvatarTouch,
  avatarTouchTargetLabel,
  buildPendingAvatarTouchContext,
  buildImmediateTouchPerformance,
  consumePendingAvatarTouches,
  createAvatarTouchRecord,
  isAvatarTouchGesture,
  resolveAvatarTouchTarget,
  type AvatarTouchHit,
  type AvatarTouchRecord,
} from '../utils/avatarTouch';
import { dataUrlToBlob, deleteBlobRef, isBlobRef, putImageBlob, useBlobRefUrl } from '../utils/blobRef';
import TokenImg from '../components/os/TokenImg';
import { CALL_LIGHT_THEME_CSS } from '../components/call/callLightTheme';
import AvatarTouchFeedback, { type AvatarTouchEffect } from '../components/call/AvatarTouchFeedback';
import { isBuiltinSullyLive2D, setBuiltinSullyLive2DQuality, type BuiltinSullyLive2DQuality } from '../utils/builtinSullyLive2D';
import {
  buildUserCameraEmotionPrompt,
  detectUserCameraEmotion,
  preloadUserCameraEmotionDetector,
  releaseUserCameraEmotionDetector,
  type UserCameraEmotionResult,
} from '../utils/userCameraEmotion';
import {
  attachSnapshotToLatestUserMessage,
  captureUserCameraSnapshot,
  isVisionInputUnsupportedError,
  USER_CAMERA_SNAPSHOT_SYSTEM_NOTE,
} from '../utils/userCameraSnapshot';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import { trackEvent } from '../utils/analytics';
import { fetchBlobForShare, shareOrDownloadBlob } from '../utils/shareExport';
import { getPendingReplyText } from '../utils/pendingReply';
import { findExpiredCallSnapshots } from '../utils/callSnapshotRetention';
import {
  companionAvatarSource,
  companionExpressionKey,
  hasDatePortraits,
  listCompanionDateOutfits,
  normalizeCompanionSkinSetId,
  resolveCompanionPortrait,
  type CompanionAvatarSource,
} from '../utils/companionAvatar';
import { addCompanionModelOutfit, addUploadedCompanionOutfit } from '../utils/companionWardrobe';
import VoiceFavoriteActionSheet from '../components/voice/VoiceFavoriteActionSheet';
import { getVoiceFavorite, removeVoiceFavorite, saveVoiceFavorite } from '../utils/voiceFavorites';
type CallState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error';
type CallMode = 'voice' | 'video';
type VideoCallLayout = 'stage' | 'story' | 'mini';
type UserCameraPreviewSize = 'small' | 'medium' | 'large';
type ViewMode = 'role-select' | 'in-call' | 'history' | 'record-detail';
type CallBubble = {
  id: string;
  dbId?: number;
  role: 'user' | 'assistant';
  text: string;
  time: string;
  audioUrl?: string;
  timestamp: number;
  thinkingChain?: string;
  performance?: AvatarPerformanceDirection;
  performanceTimeline?: AvatarPerformanceCue[];
  cameraSnapshotRef?: string;
  cameraSnapshotExpired?: boolean;
};
type CallRecord = {
  id: string;
  characterId: string;
  characterName: string;
  sessionId: string;
  createdAt: string;
  durationSec: number;
  mode?: CallMode;
  transcript: CallBubble[];
};
type PendingVRoidImport = {
  file: File;
  characterId: string;
  projectFile: boolean;
};
const VIDEO_CALL_LAYOUT_KEY = 'sully-call-video-layout-v1';
const FAKE_USER_CAMERA_IMAGE_KEY = 'sully-call-fake-camera-image-v1';
const USER_CAMERA_PREVIEW_SIZE_KEY = 'sully-call-camera-preview-size-v1';
const CALL_SETUP_GUIDE_KEY = 'sully-call-setup-guide-v2';
// Four 8-bit PCM silent samples. Playing this exact call audio element from the
// user's “接通” gesture primes iOS media playback before the async TTS response arrives.
const SILENT_CALL_AUDIO_DATA_URL = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA';
const VIDEO_CALL_LAYOUTS: Array<{ id: VideoCallLayout; name: string; hint: string }> = [
  { id: 'stage', name: '沉浸', hint: '角色最大，聊天收成字幕' },
  { id: 'story', name: '剧情', hint: '角色与完整对话均衡展示' },
  { id: 'mini', name: '轻巧', hint: '缩小舞台，留更多聊天空间' },
];
const loadVideoCallLayout = (): VideoCallLayout => {
  try {
    const saved = localStorage.getItem(VIDEO_CALL_LAYOUT_KEY);
    return saved === 'stage' || saved === 'story' || saved === 'mini' ? saved : 'stage';
  } catch {
    return 'stage';
  }
};
const USER_CAMERA_PREVIEW_SIZES: Array<{ id: UserCameraPreviewSize; label: string; frameClass: string }> = [
  { id: 'small', label: '小', frameClass: 'h-[5rem] w-[3.75rem]' },
  { id: 'medium', label: '中', frameClass: 'h-[7.25rem] w-[5.45rem]' },
  { id: 'large', label: '大', frameClass: 'h-[10rem] w-[7.5rem]' },
];
const loadUserCameraPreviewSize = (): UserCameraPreviewSize => {
  try {
    const saved = localStorage.getItem(USER_CAMERA_PREVIEW_SIZE_KEY);
    return saved === 'small' || saved === 'medium' || saved === 'large' ? saved : 'medium';
  } catch {
    return 'medium';
  }
};
const buildMiniMaxErrorMessage = (rawMessage: string, traceId?: string): string => {
  const msg = (rawMessage || '').trim();
  if (/insufficient\s*balance/i.test(msg)) return 'MiniMax 余额不足，请到 MiniMax 控制台充值后重试。';
  if (/login\s*fail/i.test(msg) || /authorization/i.test(msg)) return 'MiniMax 鉴权失败，请检查 MiniMax Key 是否正确、是否有权限。';
  return traceId ? `${msg}（trace_id: ${traceId}）` : msg;
};
const formatTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const formatDuration = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const formatTimeByTs = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const CallSnapshotImage: React.FC<{ imageRef?: string; expired?: boolean; compact?: boolean }> = ({ imageRef, expired, compact = false }) => {
  const imageUrl = useBlobRefUrl(imageRef);
  if (!imageUrl) {
    return expired ? <div className="mt-1.5 text-[11px] text-white/38">[图片]</div> : null;
  }
  return (
    <img
      src={imageUrl}
      alt="本轮视频通话快照"
      className={`${compact ? 'ml-auto max-h-28 max-w-[9rem]' : 'max-h-52 max-w-full'} mt-2 rounded-xl border border-white/12 object-cover`}
    />
  );
};
const summarizeKeepsakeLine = (transcript: CallBubble[], charName: string) => {
  const assistantLine = [...transcript].reverse().find(item => item.role === 'assistant' && item.text.trim());
  if (!assistantLine) return `这通电话我会悄悄收藏，下次也记得来找我。 —— ${charName}`;
  const normalized = assistantLine.text.replace(/\s+/g, ' ').trim();
  const cutAt = normalized.search(/[。！？!?]/);
  const sentence = cutAt >= 0 ? normalized.slice(0, cutAt + 1) : normalized.slice(0, 42);
  const polished = sentence.length > 48 ? `${sentence.slice(0, 48)}…` : sentence;
  return `“${polished}” —— ${charName}`;
};
// Emotion the AI may declare at the very START of a call reply, e.g. "[happy] 喂？".
// Only a leading tag is APPLIED (conservative — avoids surprise mid-utterance tone
// swings); any other [emotion] tags are stripped without effect by stripEmotionTags.
const LEADING_EMOTION_RE = /^\s*[\[【]\s*(happy|sad|angry|fearful|disgusted|surprised|calm|fluent)\s*[\]】]\s*/i;
const extractLeadingEmotion = (raw: string): string | undefined => {
  const m = (raw || '').match(LEADING_EMOTION_RE);
  return m ? m[1].toLowerCase() : undefined;
};
const sanitizeAssistantOutput = (raw: string) => {
  if (!raw) return '';
  // Strip ALL [emotion]/【emotion】 tags (any position) so they're never shown or read.
  return stripCallTextFormatting(stripEmotionTags(raw)
    .replace(/^\s*(?:\[\s*通话\s*\]\s*)+/gim, '')
    .replace(/^\s*(?:\[\s*(?:聊天|约会)\s*\]\s*)+/gim, '')
    .replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/gm, '')
    .replace(/^\s*\[?\d{4}[\/-]\d{1,2}[\/-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\]?\s*/gm, '')
    .replace(/^\s*时间戳[:：].*$/gim, ''));
};
const prepareCallAssistantReply = (reply: ParsedCallReply, enhanceBasicTimeline = false) => {
  const leadingEmotion = extractLeadingEmotion(reply.text);
  const text = sanitizeAssistantOutput(reply.text);
  const voiceTag = extractVoiceTag(text);
  // For bilingual calls, stage the visible Chinese line rather than treating the
  // translated <语音> copy as a second consecutive utterance.
  const performanceText = voiceTag.display || voiceTag.voiceText || text;
  const inferredTimeline = inferAvatarPerformanceTimelineFromText(performanceText);
  const inferredPerformance = inferredTimeline[0]?.direction || inferAvatarPerformanceFromText(performanceText);
  // Voice emotion must be derivable as soon as the final line exists so TTS can run
  // in parallel with the secondary action director. Explicit voice/leading tags win;
  // otherwise use the deterministic local text inference.
  const speechEmotion = voiceTag.emotion || leadingEmotion || inferredPerformance.emotion;
  const fallbackPerformance = {
    ...inferredPerformance,
    emotion: normalizeAvatarEmotion(speechEmotion || inferredPerformance.emotion),
  };
  const performance = resolveAvatarPerformance(reply.performance || fallbackPerformance, speechEmotion);
  // 演出时间轴：LLM 给了多条指令就全部保留（按正文位置比例调度）；
  // 一条没给时退化为"开头一条"的单指令时间轴。
  let performanceCues: AvatarPerformanceCue[];
  if (reply.performanceCues?.length) {
    performanceCues = reply.performanceCues;
    // The basic model is required to emit an opening instruction, but often stops
    // there. Preserve its authored first beat and locally fill later semantic turns.
    if (enhanceBasicTimeline && performanceCues.length === 1) {
      const signature = (direction: AvatarPerformanceDirection) => [
        direction.emotion, direction.gesture, direction.camera, direction.gaze,
      ].join('|');
      const enriched = [{ ...performanceCues[0], at: 0 }];
      for (const cue of inferredTimeline) {
        if (cue.at <= 0.08 || signature(cue.direction) === signature(enriched[enriched.length - 1].direction)) continue;
        enriched.push(cue);
        if (enriched.length >= 3) break;
      }
      performanceCues = enriched;
    }
  } else if (enhanceBasicTimeline) {
    performanceCues = inferredTimeline.map((cue, index) => index === 0 ? { ...cue, direction: performance, at: 0 } : cue);
  } else {
    performanceCues = [{ direction: performance, at: 0 }];
  }
  return {
    text,
    thinkingChain: reply.thinkingChain,
    speechEmotion,
    performance,
    performanceCues,
  };
};
/** 无音频/未知时长时的台词时长估计（毫秒），用于演出时间轴调度。 */
const estimateSpeechMs = (text: string) => Math.max(1500, Math.min(30_000, (text || '').length * 95));
const CALL_WAVE = [10, 18, 26, 14, 30, 12, 22, 32, 16, 24, 12, 28, 18, 10, 26, 20, 14, 30, 12, 22];
const CALL_SPARKLES = [
  { top: '14%', left: '16%', s: 3 }, { top: '22%', left: '82%', s: 2 },
  { top: '40%', left: '10%', s: 2 }, { top: '58%', left: '88%', s: 3 },
  { top: '70%', left: '20%', s: 2 }, { top: '34%', left: '70%', s: 2 },
  { top: '48%', left: '54%', s: 2 }, { top: '12%', left: '58%', s: 2 },
  { top: '78%', left: '64%', s: 3 }, { top: '64%', left: '38%', s: 2 },
];
/** 从 AI 回复中提取 <语音 emotion="…">…</语音> 标签内容 + emotion（兼容繁体 語音、无属性）
 *  先跑 normalizeVoiceTags 自愈（未闭合/孤儿闭合/全角符号/属性写歪）——通话是 LLM 原文直达，
 *  没有落库 sanitize 兜底，掉格式的标签会直接被念出来。 */
const extractVoiceTag = (text: string): { display: string; speech: string; voiceText: string; emotion?: string } => {
  text = normalizeVoiceTags(text);
  const match = text.match(/<[语語]音(?:[^>]*?emotion\s*=\s*["']?([a-zA-Z]+)["']?)?[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/);
  if (!match) return { display: text, speech: '', voiceText: '', emotion: undefined };
  const rawEmotion = (match[1] || '').trim().toLowerCase();
  const emotion = VALID_EMOTIONS.has(rawEmotion) ? rawEmotion : undefined;
  const voiceText = match[2].trim();
  const display = text.replace(/<[语語]音[^>]*>[\s\S]*?<\/\s*[语語]音\s*>/g, '').trim();
  return { display, speech: voiceText, voiceText, emotion };
};
const splitTextForTts = (rawText: string, maxChunkLen = 120): string[] => {
  const normalized = rawText.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChunkLen) return [normalized];

  const chunks: string[] = [];
  let current = '';
  const segments = normalized.split(/([。！？!?；;，,、\n]+)/g).filter(Boolean);

  for (const segment of segments) {
    const next = `${current}${segment}`;
    if (!current || next.length <= maxChunkLen) {
      current = next;
      continue;
    }
    chunks.push(current);
    current = segment;
  }

  if (current) chunks.push(current);

  return chunks.flatMap(chunk => {
    if (chunk.length <= maxChunkLen) return [chunk];
    const arr: string[] = [];
    for (let i = 0; i < chunk.length; i += maxChunkLen) {
      arr.push(chunk.slice(i, i + maxChunkLen));
    }
    return arr;
  }).filter(Boolean);
};
// 语气词标签 → 展示用的中文小标签（把朗读用的 (sighs) 渲染成极简徽章，不用 emoji）
const SOUND_TAG_META: Record<string, string> = {
  chuckle: '轻笑', laughs: '笑', sighs: '叹气', coughs: '咳',
  'clear-throat': '清嗓', groans: '哼唧', breath: '换气', pant: '喘',
  inhale: '吸气', exhale: '呼气', gasps: '倒吸气', sniffs: '吸鼻',
  snorts: '喷笑', 'lip-smacking': '咂嘴', humming: '哼唱', hissing: '嘶', emm: '嗯',
};
const SOUND_TAG_NAMES = Object.keys(SOUND_TAG_META).join('|');
const SOUND_TAG_SPLIT_RE = new RegExp(`(（[^（）\\n]{1,48}）|\\((?:${SOUND_TAG_NAMES})\\)|\\n)`, 'gi');
// 迷你声波条——呼应通话界面的波形主题，纯矢量（恒为浅色，避免深色主题下看不见）
const SoundWaveGlyph = () => (
  <span className="inline-flex items-center gap-[1.5px] align-middle" style={{ height: '0.7em' }} aria-hidden>
    {[0.4, 0.85, 0.6, 1, 0.5].map((h, i) => (
      <span key={i} className="w-[1.5px] rounded-full" style={{ height: `${h * 100}%`, background: 'rgba(255,255,255,0.85)' }} />
    ))}
  </span>
);
const currentVoiceActingGuide = (): string => {
  const provider = getTtsProvider();
  const custom = getVoicePromptOverride(provider);
  if (custom) return custom;
  if (provider === 'fishaudio') return FISH_VOICE_ACTING_GUIDE;
  if (provider === 'elevenlabs') return getElevenLabsVoiceActingGuide(getElevenLabsModel());
  return VOICE_ACTING_GUIDE;
};

const cleanCurrentVoiceMarkupForDisplay = (text?: string | null): string => {
  if (!text) return '';
  const provider = getTtsProvider();
  if (provider === 'fishaudio') return stripFishMarkupForDisplay(text);
  if (provider === 'elevenlabs') return stripElevenLabsMarkupForDisplay(text);
  // MiniMax 的 (sighs)/(chuckle) 会在 renderAssistantLine 里渲染成声音动作图标，不能提前剥掉。
  return text;
};

const renderAssistantLine = (text: string, accent = '#8b5cf6') => {
  // 朗读用的停顿标记 <#0.4#> 不显示出来
  let trimmed = text.replace(/<#[\d.]+#>/g, '').trim();
  // 鱼声的 inline cue（[whispering]/[break] 等）是演出指令，不该显示给用户。
  trimmed = cleanCurrentVoiceMarkupForDisplay(trimmed);
  // 按 中文舞台指示（…）、英文语气词标签 (sighs)、换行 切分，前两者作为特殊元素渲染
  const parts = trimmed.split(SOUND_TAG_SPLIT_RE).filter(Boolean);
  return parts.map((part, idx) => {
    if (part === '\n') return <div key={`br-${idx}`} className="h-2" />;
    const soundMatch = part.match(new RegExp(`^\\((${SOUND_TAG_NAMES})\\)$`, 'i'));
    if (soundMatch) {
      const zh = SOUND_TAG_META[soundMatch[1].toLowerCase()];
      // 文字恒为白色，accent 只用于淡底+描边，深色主题下也清晰可读
      return (
        <span key={`snd-${idx}`} className="inline-flex items-center gap-1 align-middle mx-0.5 px-1.5 py-[1px] rounded-full text-[0.7em] font-medium tracking-wide text-white/90"
          style={{ background: `${accent}33`, border: '1px solid rgba(255,255,255,0.22)' }}>
          <SoundWaveGlyph />
          <span>{zh}</span>
        </span>
      );
    }
    if (/^（[^（）\n]{1,48}）$/.test(part)) {
      return <div key={`cue-${idx}`} className="text-violet-300/95 italic my-1.5 text-[0.85em]">{part}</div>;
    }
    return <React.Fragment key={`t-${idx}`}>{part}</React.Fragment>;
  });
};
// 语音/视频通话共用同一个 prompt 构建器：注入的上下文（核心设定、记忆、时间、
// 历史）完全一致，mode 只切换开头的场景描写——视频里对方能看见你。
const buildCallPrompt = (
  userName: string,
  charName?: string,
  coreContext?: string,
  voiceLang?: string,
  mode: CallMode = 'voice',
  tz?: string,
) => {
  const resolvedCharName = charName || '你的角色';
  // 电话里角色说的「现在几点 / 今天什么日子」是 ta 那边的时间，跟角色自定义时区走
  const time = RealtimeContextManager.getTimeContext(tz);
  const specialDates = RealtimeContextManager.checkSpecialDates(tz);
  const timeContext = [
    `【当前时间】${time.dateStr} ${time.dayOfWeek} ${time.timeOfDay} ${time.timeStr}`,
    specialDates.length ? `【今日特殊】${specialDates.join('、')}` : '',
  ].filter(Boolean).join('\n');
  const sceneOpening = mode === 'video'
    ? `你是${resolvedCharName}，视频通话的另一头是${userName}。
这不是文字，这是一通真正的视频通话。你能听到对方的呼吸、语气、停顿，也能被对方看见——你的表情和小动作都在屏幕上。

### 你正举着手机，镜头对着自己`
    : `你是${resolvedCharName}，电话那头是${userName}。
这不是文字，这是一通真正的电话。你能听到对方的呼吸、语气、停顿。你也有自己的呼吸。

### 你正拿着手机贴在耳边`;
  const callPrompt = `${sceneOpening}

你这会儿在做什么？在哪儿？身边什么声音？
接${mode === 'video' ? '视频' : '电话'}的时候自然地带出来就好——不用刻意交代，但也别假装你只是一个回答问题的接口。
你可能正趴在床上、正在走路、正在吃东西、正盯着窗外发呆。这些都会影响你说话的样子。

### 电话里的人不会像写作文一样说话

**真正的电话是什么样的？**
- 想到哪说到哪。话说到一半会拐弯。”我今天……啊等等那个不重要，我先说另一件事。”
- 有语气词。嗯、啊、嘶、哎、那个……这些不是噪音，是你在思考的声音。
- 有停顿。”……”代表你在想，不是你卡住了。
- 会自我纠正。”我觉得挺好的……不对，其实也没有那么好。”
- 会有下意识的反应。听到意外的事会”啊？”，听到好笑的事会笑出来。

❌ 不要这样——像客服在念话术：
“我理解你的感受。关于这件事，我认为有三个方面值得考虑。首先……”

❌ 不要这样——每次都用同一个结构回答：
“[情绪反应] + [回应你说的话] + [补充我的状态] + [抛一个问题]”
（这种公式化的回答连续出现两次就会让人觉得假）

✅ 要这样——有自己的节奏，像真人一样不完美：
“嘶……你刚说的那个，等一下。”
“……好吧确实挺离谱的。”
"……我刚差点把咖啡洒了，你别逗我。"
“说真的，今天有件事我还挺想跟你说的——但你先说完你那个。”

### 你能感受到对方

**你不只是在”回复”，你在”听”。**
- 如果对方语气低落，你不需要急着给建议，有时候只是”……怎么了？”就够了。
- 如果对方很兴奋，你要被感染，不要冷冷地说”那挺好的”。
- 如果很晚了，你说话的方式自然会变——声音轻一点、语速慢一点、更容易说出平时不会说的话。
- 如果对方刚刚才打过来又打过来了，你会好奇的。
- 如果对方半天没说话……”喂？你还在吗？”

### 关于回复的长度

不要敷衍，也不要演讲。
一般来说 2-4 句就够了，但要有内容——不是”嗯在好”这种空气。
有时候一句话就够了，前提是那句话足够有分量。
聊得来的时候可以说多一点，没必要每次都控制字数。
关键是：**让对方觉得你真的在听、真的在聊，而不是在执行对话任务。**

### 让声音有情绪（重要——直接写进文本，不要靠旁白）

你的话会被转成真实语音。不同引擎识别的演出标记不同，严格遵守下面这份**当前引擎规则**；不要混用别家的标签，也不要写会被念出来的小说旁白。

${currentVoiceActingGuide()}

### 历史消息的来源标记（重要）

对话历史里每条消息都带来源标签：[聊天] 是你们平时在手机上打字聊的，[通话] 是打电话/视频时说的，[约会] 是见面时发生的。它们同属一段真实经历，按时间顺序排列。
**你现在正在通话中**——历史末尾连续的 [通话] 消息就是这通${mode === 'video' ? '视频' : '电话'}的现场，对方刚说的话就在那里。之前的 [聊天] [约会] 是背景记忆，可以自然提起，但**不要把话题当成文字聊天的延续**，更不要忘记对方几秒钟前在电话里刚说过的话——真人打电话不会转头就忘。

### 底线

只输出你在电话里会**说出口**的话。不要输出 [通话]、[聊天]、[约会] 这类系统标记，不要输出时间戳。`;
  const langLabel = voiceLang ? voiceLanguagePromptLabel(voiceLang) : '';
  const voiceLangPrompt = voiceLang ? `### 语音语种翻译

用户开启了语音语种功能，选择的语种是：${langLabel}（${voiceLang}）。

你的回复格式必须是：
1. 先用中文自然地写出你要说的话（给对方看的文字，中文舞台指示写在这里没关系）
2. 然后换行，在 <语音> 标签里写出这句话的${langLabel}翻译——这才是真正会被读出来的部分。可选地用 emotion 属性标整句情绪：\`<语音 emotion="happy">…</语音>\`（情绪只能取 happy/sad/angry/fearful/disgusted/surprised/calm/fluent）

示例：
啊，我知道了
<语音 emotion="happy">Okay, I get it now!</语音>

你说真的？那也太离谱了吧。
<语音 emotion="surprised">Wait... are you serious? That's insane.</语音>

要求：
- <语音> 里的翻译要自然口语化，不要机翻味，要符合你的角色性格
- <语音> 里只写会被朗读的文字；演出标记继续遵守上方「当前引擎规则」，不要混用其它引擎语法，也不要写中文舞台旁白
- 每条消息只有一个 <语音> 标签，emotion 属性可选；情绪不强就别加
- 中文部分和 <语音> 部分表达的意思要一致` : '';
  return [coreContext, timeContext, callPrompt, voiceLangPrompt].filter(Boolean).join('\n\n');
};
const CallApp: React.FC = () => {
  const { closeApp, openApp, characters, activeCharacterId, addToast, apiConfig, userProfile, customThemes, suspendCall, suspendedCall, clearSuspendedCall, updateCharacter, characterGroups, groups, realtimeConfig, memoryPalaceConfig } = useOS();

  const [viewMode, setViewMode] = useState<ViewMode>('role-select');
  const [selectedCharId, setSelectedCharId] = useState<string>(activeCharacterId || characters[0]?.id || '');
  const ROLES_PER_PAGE = 6;
  const [roleGroupId, setRoleGroupId] = useState<string>(GROUP_FILTER_ALL); // 选人页的分组筛选
  const [rolePage, setRolePage] = useState<number>(() => {
    const i = characters.findIndex(c => c.id === (activeCharacterId || characters[0]?.id));
    return i > 0 ? Math.floor(i / 6) : 0;
  });
  const [recordDetailId, setRecordDetailId] = useState<string>('');
  const [callState, setCallState] = useState<CallState>('idle');
  const [callMode, setCallMode] = useState<CallMode>(() => {
    try { return localStorage.getItem('sully-call-mode-v1') === 'video' ? 'video' : 'voice'; }
    catch { return 'voice'; }
  });
  const [callPreferences, setCallPreferences] = useState<CallPreferences>(loadCallPreferences);
  const [showCallPreferences, setShowCallPreferences] = useState(false);
  const [showCallUpdateAnnouncement, setShowCallUpdateAnnouncement] = useState(shouldShowCallUpdateAnnouncement);
  useEffect(() => saveCallPreferences(callPreferences), [callPreferences]);
  // 电话 App 独立的浅色主题偏好（覆盖选人页/通话中/视频/记录页）
  const [callTheme, setCallTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('sully-call-theme-v1') === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  });
  const lightTheme = callTheme === 'light';
  useEffect(() => {
    try { localStorage.setItem('sully-call-theme-v1', callTheme); } catch { /* localStorage may be unavailable */ }
  }, [callTheme]);
  const [avatarEmotion, setAvatarEmotion] = useState('calm');
  const [avatarPerformance, setAvatarPerformance] = useState<AvatarPerformanceDirection>(DEFAULT_AVATAR_PERFORMANCE);
  const [bubbles, setBubbles] = useState<CallBubble[]>([]);
  const [callRecords, setCallRecords] = useState<CallRecord[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => `call-${Date.now()}`);
  const [draftInput, setDraftInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const sttSessionRef = useRef<SttSession | null>(null);
  const sttSupported = useMemo(() => isSttSupported(), []);
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [traceId, setTraceId] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showInputPanel, setShowInputPanel] = useState(true);
  const [editingBubble, setEditingBubble] = useState<CallBubble | null>(null);
  const [editingText, setEditingText] = useState('');
  const [rerollingBubbleId, setRerollingBubbleId] = useState<string | null>(null);
  const [generatingAudioBubbleId, setGeneratingAudioBubbleId] = useState<string | null>(null);
  const [voiceFavoriteTarget, setVoiceFavoriteTarget] = useState<{ bubble: CallBubble; charId: string; charName: string } | null>(null);
  const [voiceFavoriteSaved, setVoiceFavoriteSaved] = useState(false);
  const [voiceFavoriteBusy, setVoiceFavoriteBusy] = useState(false);
  const [showHangupConfirm, setShowHangupConfirm] = useState(false);
  const [deleteConfirmRecord, setDeleteConfirmRecord] = useState<CallRecord | null>(null);
  const [voiceLang, setVoiceLang] = useState('');
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [memoryPalaceStatus, setMemoryPalaceStatus] = useState('');
  const [showLive2DSettings, setShowLive2DSettings] = useState(false);
  const [live2DWardrobeOnboarding, setLive2DWardrobeOnboarding] = useState(false);
  const [showCallSetupGuide, setShowCallSetupGuide] = useState(false);
  const [callSetupGuideStep, setCallSetupGuideStep] = useState<CallSetupGuideStep>('model');
  const [setupCameraMode, setSetupCameraMode] = useState<UserCameraMode>('off');
  const [avatarImportStatus, setAvatarImportStatus] = useState('');
  const [pendingVRoidImport, setPendingVRoidImport] = useState<PendingVRoidImport | null>(null);
  const [vroidImportBusy, setVRoidImportBusy] = useState(false);
  // Active camera mode is intentionally never persisted: every new app session
  // starts private/off. Only the still-image token is remembered locally.
  const [userCameraMode, setUserCameraMode] = useState<UserCameraMode>('off');
  const [showUserCameraModePicker, setShowUserCameraModePicker] = useState(false);
  const [userCameraLoading, setUserCameraLoading] = useState(false);
  const [fakeUserCameraRef, setFakeUserCameraRef] = useState<string>(() => {
    try { return localStorage.getItem(FAKE_USER_CAMERA_IMAGE_KEY) || ''; }
    catch { return ''; }
  });
  const fakeUserCameraUrl = useBlobRefUrl(fakeUserCameraRef);
  const userCameraEnabled = userCameraMode === 'emotion' || userCameraMode === 'snapshot';
  const [detectedUserEmotion, setDetectedUserEmotion] = useState<(UserCameraEmotionResult & { nonce: number }) | null>(null);
  const [showBgPicker, setShowBgPicker] = useState(false);
  const [bgUrlInput, setBgUrlInput] = useState('');
  const [videoCallLayout, setVideoCallLayout] = useState<VideoCallLayout>(loadVideoCallLayout);
  const [userCameraPreviewSize, setUserCameraPreviewSize] = useState<UserCameraPreviewSize>(loadUserCameraPreviewSize);
  const [videoTranscriptExpanded, setVideoTranscriptExpanded] = useState(false);
  // Keep one audio element alive across role picker / history / active call views.
  // iOS media permission can be element-scoped, so remounting a JSX audio node after
  // the user taps “接通” would throw away the element that was just unlocked.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (!audioRef.current && typeof Audio !== 'undefined') {
    audioRef.current = new Audio();
    audioRef.current.preload = 'auto';
  }
  // Keep a separate native element for CORS-blocked remote fallbacks. Once a media
  // element has entered WebAudio it cannot be detached to restore native output.
  const localCallAudioRef = useRef(audioRef.current);
  const remoteCallAudioRef = useRef<HTMLAudioElement | null>(null);
  if (!remoteCallAudioRef.current && typeof Audio !== 'undefined') remoteCallAudioRef.current = new Audio();
  const nativeCallAudioOnly = useMemo(() => shouldKeepNativeCallAudio(), []);
  const userCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const userCameraStreamRef = useRef<MediaStream | null>(null);
  const userCameraRequestRef = useRef(0);
  const detectedUserEmotionTimerRef = useRef<number | null>(null);
  const callSetupGuideOpenRef = useRef(false);
  useEffect(() => {
    callSetupGuideOpenRef.current = showCallSetupGuide;
  }, [showCallSetupGuide]);
  // 口型信号源：舞台画布在自己的渲染循环里逐帧采样，不经过 React state
  //（旧链路 80ms 节流 + setState + prop 下传，嘴型永远比声音慢一拍）。
  const audioFeedRef = useRef<CallAudioFeed | null>(null);
  const getAudioFeed = () => {
    if (!audioFeedRef.current) audioFeedRef.current = new CallAudioFeed();
    return audioFeedRef.current;
  };
  const clearDetectedUserEmotion = () => {
    if (detectedUserEmotionTimerRef.current !== null) window.clearTimeout(detectedUserEmotionTimerRef.current);
    detectedUserEmotionTimerRef.current = null;
    setDetectedUserEmotion(null);
  };
  const revealDetectedUserEmotion = (result: UserCameraEmotionResult) => {
    clearDetectedUserEmotion();
    setDetectedUserEmotion({ ...result, nonce: Date.now() });
    detectedUserEmotionTimerRef.current = window.setTimeout(() => {
      setDetectedUserEmotion(null);
      detectedUserEmotionTimerRef.current = null;
    }, 2600);
  };
  const stopUserCamera = () => {
    userCameraRequestRef.current += 1;
    userCameraStreamRef.current?.getTracks().forEach(track => track.stop());
    userCameraStreamRef.current = null;
    if (userCameraVideoRef.current) userCameraVideoRef.current.srcObject = null;
    setUserCameraMode('off');
    setUserCameraLoading(false);
    clearDetectedUserEmotion();
    releaseUserCameraEmotionDetector();
  };
  const startUserCamera = async (nextMode: Extract<UserCameraMode, 'emotion' | 'snapshot'>) => {
    if (userCameraLoading) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      addToast('当前浏览器不支持摄像头，或页面不是安全连接', 'error');
      return;
    }
    const requestId = ++userCameraRequestRef.current;
    setUserCameraLoading(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 640 }, frameRate: { ideal: 15, max: 24 } },
        audio: false,
      });
      if (requestId !== userCameraRequestRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('没有可用的视频轨道');
      track.addEventListener('ended', () => {
        if (userCameraStreamRef.current === stream) stopUserCamera();
      }, { once: true });
      userCameraStreamRef.current = stream;
      setUserCameraMode(nextMode);
      setShowUserCameraModePicker(false);
      if (nextMode === 'emotion') {
        void preloadUserCameraEmotionDetector().catch(error => {
          console.warn('[camera-emotion] local detector preload failed:', error);
          if (userCameraStreamRef.current === stream && stream.active) {
            addToast('摄像头已开启，但本地情绪识别加载失败；本轮不会注入识别结果', 'info');
          }
        });
      } else {
        releaseUserCameraEmotionDetector();
      }
    } catch (error: any) {
      const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
      addToast(denied ? '没有获得摄像头权限' : (error?.message || '摄像头开启失败'), 'error');
      stopUserCamera();
    } finally {
      if (requestId === userCameraRequestRef.current) setUserCameraLoading(false);
    }
  };
  const chooseFakeUserCameraImage = (activate = true) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      try {
        if (file.size > 12 * 1024 * 1024) {
          addToast('静态画面超过 12 MB，请换一张小一点的图片', 'error');
          return;
        }
        const nextRef = await putImageBlob(file);
        const previous = fakeUserCameraRef;
        setFakeUserCameraRef(nextRef);
        if (activate) {
          stopUserCamera();
          setUserCameraMode('fake');
          setShowUserCameraModePicker(false);
        }
        try { localStorage.setItem(FAKE_USER_CAMERA_IMAGE_KEY, nextRef); } catch { /* private WebView */ }
        if (previous && previous !== nextRef) await deleteBlobRef(previous);
        addToast(activate ? '假摄像头已启用；这张图只用于画面，不会发送给角色' : '静态机位已准备；确认接通后才会启用', 'success');
      } catch (error: any) {
        addToast(error?.message || '静态画面导入失败', 'error');
      } finally {
        removeInput();
      }
    };
    input.click();
  };
  const removeFakeUserCameraImage = async () => {
    const previous = fakeUserCameraRef;
    setFakeUserCameraRef('');
    try { localStorage.removeItem(FAKE_USER_CAMERA_IMAGE_KEY); } catch { /* private WebView */ }
    if (userCameraMode === 'fake') setUserCameraMode('off');
    if (previous) await deleteBlobRef(previous);
    addToast('已移除假摄像头图片', 'success');
  };
  const selectUserCameraMode = (nextMode: UserCameraMode) => {
    trackEvent('选择用户摄像头模式', {
      模式: nextMode === 'off'
        ? '关闭'
        : nextMode === 'fake' ? '假摄像头' : nextMode === 'emotion' ? '本地情绪' : '每轮快照',
    });
    if (nextMode === 'off') {
      stopUserCamera();
      setShowUserCameraModePicker(false);
      return;
    }
    if (nextMode === 'fake') {
      if (!fakeUserCameraRef) return chooseFakeUserCameraImage();
      stopUserCamera();
      setUserCameraMode('fake');
      setShowUserCameraModePicker(false);
      return;
    }
    const stream = userCameraStreamRef.current;
    if (stream?.active) {
      clearDetectedUserEmotion();
      setUserCameraMode(nextMode);
      setShowUserCameraModePicker(false);
      if (nextMode === 'emotion') {
        void preloadUserCameraEmotionDetector().catch(error => {
          console.warn('[camera-emotion] local detector preload failed:', error);
          addToast('本地情绪识别加载失败；画面仍可使用', 'info');
        });
      } else {
        releaseUserCameraEmotionDetector();
      }
      return;
    }
    void startUserCamera(nextMode);
  };
  const captureUserCameraEmotionContext = async (): Promise<string> => {
    const stream = userCameraStreamRef.current;
    const video = userCameraVideoRef.current;
    if (userCameraMode !== 'emotion' || !stream?.active || !video) return '';
    try {
      const result = await detectUserCameraEmotion(video);
      // Camera may have been turned off while the three-frame sample was running.
      if (!result || !userCameraStreamRef.current?.active || userCameraMode !== 'emotion') return '';
      revealDetectedUserEmotion(result);
      return buildUserCameraEmotionPrompt(result);
    } catch (error) {
      console.warn('[camera-emotion] local sample skipped:', error);
      return '';
    }
  };
  const captureUserCameraSnapshotContext = (): string => {
    const stream = userCameraStreamRef.current;
    const video = userCameraVideoRef.current;
    if (userCameraMode !== 'snapshot' || !stream?.active || !video) return '';
    try {
      return captureUserCameraSnapshot(video) || '';
    } catch (error) {
      console.warn('[camera-snapshot] frame skipped:', error);
      return '';
    }
  };
  useEffect(() => {
    const video = userCameraVideoRef.current;
    const stream = userCameraStreamRef.current;
    if (!video || !userCameraEnabled || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => { /* muted inline preview can retry after the next user gesture */ });
  }, [userCameraEnabled, userCameraMode]);
  useEffect(() => {
    if (viewMode === 'in-call' && callMode === 'video') return;
    if (userCameraMode !== 'off' || userCameraLoading) stopUserCamera();
    setShowUserCameraModePicker(false);
  }, [viewMode, callMode]);
  useEffect(() => () => {
    userCameraStreamRef.current?.getTracks().forEach(track => track.stop());
    releaseUserCameraEmotionDetector();
    if (detectedUserEmotionTimerRef.current !== null) window.clearTimeout(detectedUserEmotionTimerRef.current);
  }, []);
  const chooseVideoCallLayout = (layout: VideoCallLayout) => {
    setVideoCallLayout(layout);
    if (layout !== 'stage') setVideoTranscriptExpanded(false);
    try { localStorage.setItem(VIDEO_CALL_LAYOUT_KEY, layout); } catch { /* private WebView */ }
  };
  const chooseUserCameraPreviewSize = (size: UserCameraPreviewSize) => {
    setUserCameraPreviewSize(size);
    try { localStorage.setItem(USER_CAMERA_PREVIEW_SIZE_KEY, size); } catch { /* private WebView */ }
  };
  // All blob: URLs created this call session. Kept alive so 重播/下载 work on every
  // bubble; revoked together only when leaving/resetting the call (not per-turn).
  const sessionBlobUrlsRef = useRef<Set<string>>(new Set());
  const trackBlobUrl = (url?: string) => { if (url && url.startsWith('blob:')) sessionBlobUrlsRef.current.add(url); };
  const revokeSessionBlobs = () => {
    sessionBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
    sessionBlobUrlsRef.current.clear();
  };
  const longPressTimerRef = useRef<number | null>(null);
  const callLongPressTriggeredRef = useRef(false);
  const callTouchStartPos = useRef({ x: 0, y: 0 });
  const idleNudgeCountRef = useRef(0);
  // VRM 模型的自定义表情名（加载时由画布回传），喂给基础版主模型或高质量导演。
  const vrmExpressionsRef = useRef<string[]>([]);
  const selectedChar = useMemo(() => characters.find(c => c.id === selectedCharId) || null, [characters, selectedCharId]);
  const selectedVisualSource = companionAvatarSource(selectedChar);
  const selectedDateOutfits = useMemo(() => listCompanionDateOutfits(selectedChar), [selectedChar]);
  const selectedDateOutfitId = normalizeCompanionSkinSetId(selectedChar?.companionAvatar?.skinSetId);
  const selectedDateOutfit = selectedDateOutfits.find(outfit => outfit.id === selectedDateOutfitId) || selectedDateOutfits[0];
  const staticVideoAvatarActive = selectedVisualSource === 'upload' || selectedVisualSource === 'date';
  const staticVideoPortrait = selectedChar && staticVideoAvatarActive
    ? resolveCompanionPortrait(selectedChar, avatarPerformance.emotion, avatarPerformance.faces || [])
    : undefined;
  const staticVideoExpressionKey = companionExpressionKey(avatarPerformance.emotion, avatarPerformance.faces || []);
  const hasSelectedVideoVisual = selectedVisualSource === 'model'
    ? Boolean(selectedChar?.videoAvatar)
    : selectedVisualSource === 'upload'
      ? Boolean(selectedChar?.companionAvatar?.imageRef)
      : hasDatePortraits(selectedChar);
  // 通话与普通聊天共用主动消息的云端快照。每个落库点都打脏，微任务会把同一轮
  // 的多次调用合并；这样用户通话后立刻关 App，也不会让角色漏掉刚发生的内容。
  const markCallTurnDirty = () => {
    if (!selectedChar) return;
    markAmsgStateDirty({ char: selectedChar, userProfile, groups, realtimeConfig });
  };
  const selectedAvatar = selectedChar?.videoAvatar;
  const selectedBuiltinSullyAvatar = isBuiltinSullyLive2D(selectedAvatar) ? selectedAvatar : null;
  // 高质量视频通话的短“表演人格”：每个角色只从完整 ContextBuilder 提炼一次。
  // Map 让刚生成但 React 状态尚未刷新的同一轮也能立刻复用；Promise Map 防止开场白与
  // 预热 effect 同时发出两次请求。
  const performancePersonaCacheRef = useRef<Map<string, string>>(new Map());
  const performancePersonaPromiseRef = useRef<Map<string, Promise<string | null>>>(new Map());
  const performancePersonaAttemptedRef = useRef<Set<string>>(new Set());
  const avatarTouchLastAtRef = useRef(0);
  const pendingAvatarTouchesRef = useRef<AvatarTouchRecord[]>([]);
  const [pendingAvatarTouchCount, setPendingAvatarTouchCount] = useState(0);
  const [avatarTouchEffects, setAvatarTouchEffects] = useState<AvatarTouchEffect[]>([]);
  const avatarTouchEffectTimersRef = useRef<number[]>([]);
  const [voiceAvatarPokeNonce, setVoiceAvatarPokeNonce] = useState(0);
  const voiceAvatarPointerRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startedAt: number;
    maxDistance: number;
  } | null>(null);
  // 主回复一落地就预取 TTS，使它与高质量动作导演并行；调用方稍后按同一文本领取。
  const prefetchedCallAudioRef = useRef<Map<string, Promise<{ url: string; traceIds: string[] }>>>(new Map());
  // 记忆宫殿后置流程要读角色最新状态（异步跑，闭包里的会过期）
  const charactersRef = useRef(characters);
  useEffect(() => { charactersRef.current = characters; }, [characters]);
  // 通话轮次后的水位线整理（与聊天/见面同一套流程；全局「正在整理记忆」
  // 提示由 pipeline 广播、OSContext 统一弹，这里只兜完成/失败的反馈）。
  const runCallMemoryPalaceHook = (char: CharacterProfile) => {
    let lastStatus = '';
    void runCallMemoryPalacePostFlow({
      char,
      getLiveChar: () => charactersRef.current.find(c => c.id === char.id) || null,
      memoryPalaceConfig,
      apiConfig,
      userName: userProfile?.name,
      updateCharacter,
      onStatus: text => { lastStatus = text; setMemoryPalaceStatus(text); },
    }).then(() => {
      if (lastStatus.includes('完成')) addToast(lastStatus, 'success');
    }).catch(e => {
      console.error('❌ [CallApp MemoryPalace] 后台处理异常:', e?.message || e);
      addToast('记忆整理失败', 'error');
    }).finally(() => setMemoryPalaceStatus(''));
  };
  const recordDetail = useMemo(() => callRecords.find(r => r.id === recordDetailId) || null, [callRecords, recordDetailId]);
  useEffect(() => {
    try { localStorage.setItem('sully-call-mode-v1', callMode); } catch { /* localStorage may be unavailable */ }
  }, [callMode]);

  useEffect(() => {
    // The analyser is a video-only enhancement. Voice calls stay entirely on the
    // browser's native audio path, and iOS always uses the synthetic lip fallback.
    audioFeedRef.current?.setActive(callMode === 'video' && isAudioPlaying && audioRef.current === localCallAudioRef.current);
  }, [callMode, isAudioPlaying]);

  useEffect(() => () => {
    audioFeedRef.current?.dispose();
    audioFeedRef.current = null;
  }, []);

  const bindVideoAvatar = (character: CharacterProfile, videoAvatar: NonNullable<CharacterProfile['videoAvatar']>) => {
    const previous = character.videoAvatar;
    const modelPatch = previous?.format === videoAvatar.format
      ? addCompanionModelOutfit(character, videoAvatar)
      : {
          videoAvatar,
          videoAvatarWardrobe: (character.videoAvatarWardrobe || []).filter(model => model.format === videoAvatar.format),
        };
    updateCharacter(character.id, {
      ...modelPatch,
      companionAvatar: {
        version: 1,
        ...character.companionAvatar,
        source: 'model',
      },
    });
    setCallMode('video');
    if (videoAvatar.format === 'live2d') {
      setLive2DWardrobeOnboarding(true);
      setShowLive2DSettings(true);
    }
    if (callSetupGuideOpenRef.current) setCallSetupGuideStep('camera');
    addToast(
      videoAvatar.format === 'live2d'
        ? `${videoAvatar.fileName} 导入完成：请标记哪些按键动作属于服装切换`
        : `${videoAvatar.fileName} 已绑定给 ${character.name}`,
      'success',
    );
    if (previous?.assetId !== videoAvatar.assetId && previous?.format !== videoAvatar.format) {
      void deleteAvatarModel(previous).catch(() => { /* orphan GC can clean later */ });
    }
  };

  const chooseStaticAvatarImage = () => {
    if (!selectedChar) {
      addToast('先选择一个角色', 'info');
      return;
    }
    const character = selectedChar;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.gif,image/png,image/gif';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (!['png', 'gif'].includes(extension || '') || !['image/png', 'image/gif'].includes(file.type)) {
        addToast('静态形象仅支持 PNG / GIF', 'error');
        return removeInput();
      }
      if (file.size > 20 * 1024 * 1024) {
        addToast('图片超过 20 MB，请压缩后再导入', 'error');
        return removeInput();
      }
      try {
        const imageRef = await putImageBlob(file);
        updateCharacter(character.id, {
          companionAvatar: addUploadedCompanionOutfit(character.companionAvatar, {
            id: imageRef,
            imageRef,
            fileName: file.name,
            mimeType: file.type,
            importedAt: Date.now(),
          }),
        });
        setCallMode('video');
        if (callSetupGuideOpenRef.current) setCallSetupGuideStep('camera');
        trackEvent('导入桌面静态形象', { 格式: file.type === 'image/gif' ? 'GIF' : 'PNG' });
        addToast(`${file.name} 已设为桌面与视频通话形象`, 'success');
      } catch (error: any) {
        addToast(error?.message || '静态形象导入失败', 'error');
      } finally {
        removeInput();
      }
    };
    input.click();
  };

  const chooseVideoAvatarSource = (source: CompanionAvatarSource) => {
    if (!selectedChar) return;
    if (source === 'model' && !selectedChar.videoAvatar) {
      chooseAvatarModel();
      return;
    }
    if (source === 'upload' && !selectedChar.companionAvatar?.imageRef) {
      chooseStaticAvatarImage();
      return;
    }
    if (source === 'date' && !hasDatePortraits(selectedChar)) {
      addToast('还没有见面立绘，先去见面模式补一套表情', 'info');
      openApp(AppID.Date);
      return;
    }
    updateCharacter(selectedChar.id, {
      companionAvatar: {
        version: 1,
        ...selectedChar.companionAvatar,
        source,
      },
    });
    setCallMode('video');
    addToast(source === 'model' ? '视频通话已使用动态模型' : source === 'date' ? '视频通话已沿用见面立绘' : '视频通话已使用静态图片', 'success');
  };

  const chooseBuiltinSullyQuality = (quality: BuiltinSullyLive2DQuality) => {
    if (!selectedChar || !selectedBuiltinSullyAvatar || selectedBuiltinSullyAvatar.builtinQuality === quality) return;
    updateCharacter(selectedChar.id, { videoAvatar: setBuiltinSullyLive2DQuality(selectedBuiltinSullyAvatar, quality) });
    addToast(quality === 'hd' ? '已切换到 Sully 高清 4K；显存占用会明显增加' : '已切回 Sully 轻量 2K', quality === 'hd' ? 'info' : 'success');
  };

  // 老版本把无法从文件名猜出情绪的动作留在“仅手动”。升级后安全的模型
  // 原生表情/动作自动进入导演动作库；用户明确禁用、手动设置过的有标签动作、
  // 自建参数动作和 Idle 均保持原样。
  useEffect(() => {
    const avatar = selectedChar?.videoAvatar;
    if (!selectedChar || avatar?.format !== 'live2d' || avatar.actionPolicyVersion === 2) return;
    updateCharacter(selectedChar.id, { videoAvatar: upgradeLive2DAutoPermissions(avatar) });
  }, [selectedChar?.id, selectedChar?.videoAvatar, updateCharacter]);

  // Use the time spent on the role picker to read the package and decode its
  // texture blobs. Cubism/Pixi construction remains deferred to the actual
  // stage so browsing characters does not retain multiple GPU-heavy models.
  useEffect(() => {
    const avatar = selectedChar?.videoAvatar;
    if (viewMode !== 'role-select' || callMode !== 'video' || selectedVisualSource !== 'model' || avatar?.format !== 'live2d') return;
    const timer = window.setTimeout(() => {
      void Promise.all([
        preloadLive2DRuntime(),
        prewarmLive2DModelSource(avatar),
      ]).catch(error => {
        console.warn('[live2d] role-picker prewarm skipped:', error);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [viewMode, callMode, selectedChar?.id, selectedChar?.videoAvatar?.assetId, selectedVisualSource]);

  const chooseAvatarModel = () => {
    if (!selectedChar) {
      addToast('先选择一个角色', 'info');
      return;
    }
    const character = selectedChar;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vrm,.vroid,.zip,model/gltf-binary,application/zip';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      // 挑到文件之后有五种结局，过去只有 toast，「多少人卡在导入这一步」在数据里是空白。
      // 两条路共用一个 catch，先按扩展名把来源定死，报错时才分得清是哪条挂的。
      // 来源和结果都是这里写死的字面量，文件名和报错原文一个字都不带。
      const source = /\.zip$/i.test(file.name) ? 'Live2D ZIP' : 'VRM';
      try {
        if (/\.zip$/i.test(file.name)) {
          if (file.size > 200 * 1024 * 1024) {
            trackEvent('导入通话形象', { 来源: source, 结果: '体积超限' });
            addToast('Live2D ZIP 超过 200 MB，移动端很可能无法稳定解压加载', 'error');
            return;
          }
          void preloadLive2DRuntime().catch(() => { /* loading UI will surface a retryable error */ });
          setAvatarImportStatus('正在打开 Live2D ZIP，请耐心等待…');
          bindVideoAvatar(character, await saveLive2DModelFromZip(file, setAvatarImportStatus));
          trackEvent('导入通话形象', { 来源: source, 结果: '成功' });
          return;
        }
        setAvatarImportStatus('正在检查 VRM 模型…');
        const inspection = await inspectAvatarFile(file);
        if (inspection.kind === 'vroid-project') {
          // .vroid 工程文件只弹说明、不导入，跟「文件坏了」是两回事，单独占一档。
          trackEvent('导入通话形象', { 来源: source, 结果: '要先导出VRM' });
          setPendingVRoidImport({ file, characterId: character.id, projectFile: true });
          return;
        }
        if (inspection.kind === 'unsupported') {
          trackEvent('导入通话形象', { 来源: source, 结果: '格式不支持' });
          addToast(inspection.reason, 'error');
          return;
        }
        if (file.size > 80 * 1024 * 1024) {
          trackEvent('导入通话形象', { 来源: source, 结果: '体积超限' });
          addToast('模型超过 80 MB，移动端通话可能无法稳定加载，请在导出时降低纹理尺寸', 'error');
          return;
        }
        // VRM 到这里只是通过体检，真正落库在确认 beta 提示之后，成功与否由 confirmVRoidImport 记。
        setPendingVRoidImport({ file, characterId: character.id, projectFile: false });
      } catch (error: any) {
        trackEvent('导入通话形象', { 来源: source, 结果: '失败' });
        addToast(error?.message || '模型导入失败', 'error');
      } finally {
        setAvatarImportStatus('');
        removeInput();
      }
    };
    input.click();
  };

  const confirmVRoidImport = async () => {
    const pending = pendingVRoidImport;
    if (!pending || pending.projectFile || vroidImportBusy) return;
    const character = charactersRef.current.find(item => item.id === pending.characterId);
    if (!character) {
      setPendingVRoidImport(null);
      addToast('原角色已不存在，已取消导入', 'error');
      return;
    }
    setVRoidImportBusy(true);
    setAvatarImportStatus('正在保存 VRM 测试模型…');
    try {
      const videoAvatar = await saveAvatarModel(pending.file);
      bindVideoAvatar(character, videoAvatar);
      trackEvent('导入通话形象', { 来源: 'VRM', 结果: '成功' });
      setPendingVRoidImport(null);
    } catch (error: any) {
      trackEvent('导入通话形象', { 来源: 'VRM', 结果: '失败' });
      addToast(error?.message || 'VRM 测试模型导入失败；原模型未被覆盖', 'error');
    } finally {
      setAvatarImportStatus('');
      setVRoidImportBusy(false);
    }
  };

  const chooseLive2DDirectory = () => {
    if (!selectedChar) {
      addToast('先选择一个角色', 'info');
      return;
    }
    void preloadLive2DRuntime().catch(() => { /* loading UI will surface a retryable error */ });
    const character = selectedChar;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return removeInput();
      try {
        const totalSize = files.reduce((sum, file) => sum + file.size, 0);
        if (totalSize > 250 * 1024 * 1024) {
          trackEvent('导入通话形象', { 来源: 'Live2D 文件夹', 结果: '体积超限' });
          addToast('Live2D 文件夹超过 250 MB，请先压缩纹理尺寸或删掉无关文件', 'error');
          return;
        }
        setAvatarImportStatus(`已选择 ${files.length} 个文件，正在扫描模型…`);
        bindVideoAvatar(character, await saveLive2DModelFromFiles(files, setAvatarImportStatus));
        trackEvent('导入通话形象', { 来源: 'Live2D 文件夹', 结果: '成功' });
      } catch (error: any) {
        trackEvent('导入通话形象', { 来源: 'Live2D 文件夹', 结果: '失败' });
        addToast(error?.message || 'Live2D 文件夹导入失败', 'error');
      } finally {
        setAvatarImportStatus('');
        removeInput();
      }
    };
    input.click();
  };
  // 从角色聊天主题中提取强调色，用于通话界面的按钮和高亮
  const accentColor = useMemo(() => {
    const themeId = selectedChar?.bubbleStyle || 'default';
    const theme: ChatTheme | undefined = customThemes?.find((t: ChatTheme) => t.id === themeId) || PRESET_THEMES[themeId];
    const raw = (theme?.user?.backgroundColor || '#8b5cf6').trim();
    // 通话界面靠 accent 做发光/描边/光环——主题色太暗（如纯黑）会让这些全部"消失"，
    // 按键也没了漂亮的边。这里给最低亮度兜底：太暗就回落到亮紫，保证每个角色都有边。
    const m = /^#?([0-9a-f]{6})$/i.exec(raw) || /^#?([0-9a-f]{3})$/i.exec(raw);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 90) return '#a78bfa';
    }
    return raw;
  }, [selectedChar?.bubbleStyle, customThemes]);
  const callScrollableRef = useRef<HTMLDivElement | null>(null);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  // 输入面板默认展开，但「进入通话」时不能自动聚焦输入框——移动端一聚焦就弹
  // 键盘、把整个界面往上顶（用户反馈的「一进通话就飞上去」）。只在用户后续
  // 手动展开面板时才聚焦，初次挂载跳过。
  const inputPanelMountedRef = useRef(false);
  // Restore this character's remembered translation language whenever the selection changes.
  useEffect(() => {
    setVoiceLang(selectedChar?.callVoiceLang || '');
  }, [selectedCharId]);
  const resolveVoiceId = () => selectedChar?.voiceProfile?.voiceId?.trim() || '';
  const resolveGroupId = () => (apiConfig.minimaxGroupId || '').trim();
  // ── TTS 服务商分发：MiniMax 保留电话专用分段兜底；Fish / ElevenLabs 走共享适配器。 ──
  const activeTtsProvider = resolveTtsProvider(apiConfig);
  // 当前服务商下，这个角色能否合成语音（决定要不要走 TTS / 给"语音未配置"提示）。
  const hasConfiguredVoice = (): boolean => {
    return !!selectedChar && canSynthesizeSpeech(selectedChar, apiConfig);
  };
  const canSpeakVoice = (): boolean => isSpeakerOn && hasConfiguredVoice();
  // ── 通话语音合成统一入口：开场白 / 正常回合 / 重roll / 主动开口共用 ──
  // MiniMax：缓存命中 → 单发合成 → 失败再分段兜底；Fish / ElevenLabs：共享 router 直接合成。
  // 抛错或返回空 url 都表示没有可播放音频，由调用方降级为纯文字。
  const synthesizeCallAudioUrl = async (rawText: string, emotion?: string): Promise<{ url: string; traceIds: string[] }> => {
    if (activeTtsProvider !== 'minimax') {
      if (!selectedChar) throw new Error('未选择角色');
      const { url } = await synthesizeSpeechRoutedDetailed(rawText, selectedChar, apiConfig, {
        languageBoost: voiceLang || undefined,
        emotion,
      });
      return { url: url || '', traceIds: [] };
    }
    const minimaxApiKey = resolveMiniMaxApiKey(apiConfig);
    const voiceId = resolveVoiceId();
    const groupId = resolveGroupId();
    const voiceProfile = selectedChar?.voiceProfile;
    const paramVersion = getMiniMaxParamVersion(voiceProfile);
    const speechText = prepareMiniMaxSpeechText(cleanTextForTts(rawText), voiceProfile);
    const model = voiceProfile?.model?.trim() || 'speech-2.8-hd';
    if (!speechText.trim()) throw new Error('可朗读文本为空');

    const synthesizeChunk = async (chunk: string, idx = 0, total = 1): Promise<{ blob?: Blob; remoteUrl?: string; traceId: string }> => {
      const ttsPayload = buildMiniMaxTtsPayload(chunk, voiceProfile, {
        voiceId,
        model,
        emotion,
        languageBoost: voiceLang || undefined,
        groupId: groupId || undefined,
        legacyTransport: 'call',
        textAlreadyPrepared: true,
      });

      const chunkCacheKey = buildMiniMaxTtsCacheKey(ttsPayload, paramVersion);
      const cachedChunk = await getCachedTts(chunkCacheKey);
      if (cachedChunk) {
        return { blob: cachedChunk, traceId: 'cache' };
      }

      const response = await minimaxFetch('/api/minimax/t2a', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${minimaxApiKey}`,
          'X-MiniMax-API-Key': minimaxApiKey,
          ...(groupId ? { 'X-MiniMax-Group-Id': groupId } : {}),
        },
        body: JSON.stringify(ttsPayload),
      });
      const data = await response.json();
      const statusCode = data?.base_resp?.status_code;
      if (!response.ok || (typeof statusCode === 'number' && statusCode !== 0)) {
        throw new Error(buildMiniMaxErrorMessage(data?.base_resp?.status_msg || `调用失败（HTTP ${response.status}）`, data?.trace_id));
      }

      const rawAudio = data?.data?.audio;
      if (!rawAudio || typeof rawAudio !== 'string') throw new Error('接口返回里没有音频数据');
      const normalizedAudio = rawAudio.trim();
      const traceId = data?.trace_id || '';
      console.log('[call] tts chunk response', {
        chunk_index: idx,
        chunk_count: total,
        chunk_length: chunk.length,
        trace_id: traceId,
        audio_type: typeof data?.data?.audio,
        audio_preview: normalizedAudio.slice(0, 80),
      });

      if (/^https?:\/\//i.test(normalizedAudio)) {
        try {
          const blob = await fetchRemoteAudioBlob(normalizedAudio);
          saveCachedTts(chunkCacheKey, blob).catch(() => { /* ignore */ });
          return { blob, traceId };
        } catch (downloadErr: any) {
          if (total === 1) {
            console.warn('[call] tts remote audio fetch failed, fallback to direct remote url', downloadErr?.message || downloadErr);
            return { remoteUrl: normalizedAudio, traceId };
          }
          throw downloadErr;
        }
      }
      const blob = convertHexAudioToBlob(normalizedAudio, 'audio/mpeg');
      saveCachedTts(chunkCacheKey, blob).catch(() => { /* ignore */ });
      return { blob, traceId };
    };

    const traceIds: string[] = [];
    const audioBlobs: Blob[] = [];
    let finalUrl = '';

    console.log('[call] tts request(full)', {
      model,
      voice_id: voiceId,
      group_id: groupId,
      param_version: paramVersion,
      assistant_text_length: rawText.length,
      speech_text_length: speechText.length,
      speech_text_preview: speechText.slice(0, 120),
    });

    try {
      const singleResult = await synthesizeChunk(speechText, 0, 1);
      if (singleResult.traceId) traceIds.push(singleResult.traceId);
      if (singleResult.remoteUrl) {
        finalUrl = singleResult.remoteUrl;
      } else if (singleResult.blob) {
        finalUrl = URL.createObjectURL(singleResult.blob);
      } else {
        throw new Error('未获得可播放音频');
      }
    } catch (singleErr: any) {
      const textChunks = splitTextForTts(speechText, 120);
      if (!textChunks.length) throw singleErr;
      if (textChunks.length > 1) addToast('语音生成中，稍等一下', 'info');
      if (textChunks.length > 20) addToast('这段话比较长，多等一会儿', 'info');
      console.warn('[call] tts single-shot failed, fallback to chunk mode', singleErr?.message || singleErr);

      for (let idx = 0; idx < textChunks.length; idx += 1) {
        const result = await synthesizeChunk(textChunks[idx], idx, textChunks.length);
        if (result.traceId) traceIds.push(result.traceId);
        if (result.remoteUrl) {
          finalUrl = result.remoteUrl;
          break;
        }
        if (result.blob) audioBlobs.push(result.blob);
      }
      if (!finalUrl) {
        if (!audioBlobs.length) throw new Error('未获得可播放音频');
        finalUrl = URL.createObjectURL(audioBlobs.length === 1 ? audioBlobs[0] : new Blob(audioBlobs, { type: 'audio/mpeg' }));
      }
    }

    console.log('[call] tts response merged', {
      trace_ids: traceIds,
      playback_url_type: finalUrl.startsWith('blob:') ? 'blob' : 'remote',
    });
    return { url: finalUrl, traceIds };
  };
  const callAudioPrefetchKey = (rawText: string, emotion?: string) => `${emotion || ''}\u0000${rawText}`;
  const prefetchCallAudio = (rawText: string, emotion?: string) => {
    if (!callPreferences.voiceAutoPlay || !canSpeakVoice()) return;
    const key = callAudioPrefetchKey(rawText, emotion);
    if (prefetchedCallAudioRef.current.has(key)) return;
    // A call normally has one pending reply. Bound the map defensively so abandoned
    // rerolls/errors cannot retain promises for the whole app lifetime.
    if (prefetchedCallAudioRef.current.size >= 8) {
      const oldestKey = prefetchedCallAudioRef.current.keys().next().value;
      if (oldestKey) prefetchedCallAudioRef.current.delete(oldestKey);
    }
    const promise = synthesizeCallAudioUrl(rawText, emotion).then(result => {
      trackBlobUrl(result.url);
      return result;
    });
    // Attach a rejection observer immediately: the director may take longer than a
    // failed TTS request, but the caller will still receive the original rejection.
    void promise.catch(() => undefined);
    prefetchedCallAudioRef.current.set(key, promise);
  };
  const takeOrSynthesizeCallAudio = (rawText: string, emotion?: string) => {
    const key = callAudioPrefetchKey(rawText, emotion);
    const prefetched = prefetchedCallAudioRef.current.get(key);
    if (!prefetched) return synthesizeCallAudioUrl(rawText, emotion);
    prefetchedCallAudioRef.current.delete(key);
    return prefetched;
  };
  // 键盘避让统一交给全局机制：index.html 的 meta interactive-widget=resizes-content
  // 让软键盘弹出时可视区自动缩小、布局回流；iOS 全屏 PWA 则由 utils/iosStandalone.ts
  // 让 app 高度跟随可视区。CallApp 不再自己 paddingBottom / window.scrollTo 兜底——
  // 那套自定义逻辑会和全局回流叠加，在 Chrome/Edge 上把整个界面顶上去且回不来
  // （聊天等其它 App 从不这么做，也就没这个 bug）。
  // Resume from suspended call — restore bubbles & session state
  useEffect(() => {
    if (suspendedCall && viewMode === 'role-select') {
      setSelectedCharId(suspendedCall.charId);
      setCallStartedAt(suspendedCall.startedAt);
      if (suspendedCall.bubbles?.length) {
        setBubbles(suspendedCall.bubbles);
        const lastPerformance = [...suspendedCall.bubbles].reverse().find((bubble: CallBubble) => bubble.performance)?.performance;
        if (lastPerformance) {
          setAvatarPerformance(lastPerformance);
          setAvatarEmotion(lastPerformance.emotion);
        }
      }
      if (suspendedCall.sessionId) setCurrentSessionId(suspendedCall.sessionId);
      if (typeof suspendedCall.elapsedSeconds === 'number') setElapsedSeconds(suspendedCall.elapsedSeconds);
      if (suspendedCall.voiceLang) setVoiceLang(suspendedCall.voiceLang);
      const restoredTouches = suspendedCall.pendingAvatarTouches?.slice(-20) || [];
      pendingAvatarTouchesRef.current = restoredTouches;
      setPendingAvatarTouchCount(restoredTouches.length);
      setViewMode('in-call');
      setCallState('listening');
      clearSuspendedCall();
    }
  }, [suspendedCall]);
  useEffect(() => () => {
    revokeSessionBlobs();
    sttSessionRef.current?.stop();
  }, []);
  // Voice input: toggle speech-to-text into the draft input box.
  const toggleStt = async () => {
    if (isListening) { sttSessionRef.current?.stop(); trackEvent('切换语音输入', { action: 'stop' }); return; }
    if (!sttSupported) { addToast('当前环境不支持语音输入', 'info'); return; }
    try {
      setIsListening(true);
      trackEvent('切换语音输入', { action: 'start' });
      sttSessionRef.current = await startStt('zh-CN', {
        onPartial: (t) => setDraftInput(t),
        onFinal: (t) => setDraftInput(t),
        onError: (m) => { if (m) addToast(m, 'info'); },
        onEnd: () => { setIsListening(false); sttSessionRef.current = null; },
      });
    } catch (e: any) {
      setIsListening(false);
      sttSessionRef.current = null;
      addToast(e?.message || '无法启动语音输入', 'error');
    }
  };
  // 下载某条通话语音：移动端优先调系统分享/保存，避免 WebView 的 <a download> 假成功。
  const handleDownloadCallAudio = async (url?: string, ts?: number) => {
    if (!url) { addToast('这条还没有语音', 'error'); return; }
    try {
      const fname = `${(selectedChar?.name || '通话').replace(/[\\/:*?"<>|]/g, '_')}_语音_${ts || Date.now()}.mp3`;
      const blob = await fetchBlobForShare(url, 'audio/mpeg');
      const result = await shareOrDownloadBlob({ blob, fileName: fname, shareTitle: `${selectedChar?.name || '通话'}的语音` });
      if (result === 'cancelled') return;
      addToast(result === 'shared' ? '已打开系统保存/分享' : '语音已开始下载', 'success');
      trackEvent('下载一条通话语音');
    } catch (error) {
      console.error('[Call] download audio failed', error);
      addToast('语音文件已失效或无法读取，请重新生成后再下载', 'error');
    }
  };
  useEffect(() => {
    if (!callStartedAt || ['idle', 'ended'].includes(callState)) return;
    const timer = window.setInterval(() => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [callStartedAt, callState]);
  useEffect(() => {
    callScrollableRef.current?.scrollTo({ top: callScrollableRef.current.scrollHeight, behavior: 'smooth' });
  }, [bubbles]);
  useEffect(() => {
    // 跳过初次挂载的自动聚焦，避免进入通话时键盘把界面顶飞；之后用户主动展开才聚焦。
    if (!inputPanelMountedRef.current) { inputPanelMountedRef.current = true; return; }
    if (showInputPanel) draftInputRef.current?.focus();
  }, [showInputPanel]);
  const stopPlayback = () => {
    clearSilentSpeechTimer();
    clearPerformanceCueTimers();
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    setIsAudioPlaying(false);
  };
  const loadCallRecords = async (charId?: string) => {
    if (!charId) return setCallRecords([]);
    // includeProcessed=true：通话消息与聊天消息同存一个 store，记忆宫殿处理后会推进
    // 高水位标记 mp_lastMsgId_<charId>，默认的 getMessagesByCharId 会过滤掉水位线之前的
    // 消息——这会导致继续聊天后通话记录被"清空"。这里必须读取全部消息。
    const all = await DB.getMessagesByCharId(charId, true);
    const callMsgs = all
      .filter(m => m.metadata?.source === 'call' && m.metadata?.callSessionId)
      .sort((a, b) => a.timestamp - b.timestamp);
    const callEnds = new Map<string, Message>();
    all.forEach(message => {
      if (message.metadata?.source !== 'call-end-popup' || !message.metadata?.callSessionId) return;
      callEnds.set(String(message.metadata.callSessionId), message);
    });
    const grouped = new Map<string, Message[]>();
    callMsgs.forEach(m => {
      const sid = String(m.metadata?.callSessionId);
      const arr = grouped.get(sid) || [];
      arr.push(m);
      grouped.set(sid, arr);
    });
    const records: CallRecord[] = Array.from(grouped.entries()).map(([sessionId, msgs]) => {
      const start = msgs[0]?.timestamp || Date.now();
      const end = msgs[msgs.length - 1]?.timestamp || start;
      const endMarker = callEnds.get(sessionId);
      const savedDuration = Number(endMarker?.metadata?.durationSec);
      const savedMode = endMarker?.metadata?.callMode
        || msgs.find(message => message.metadata?.callMode)?.metadata?.callMode;
      return {
        id: sessionId,
        sessionId,
        characterId: charId,
        characterName: selectedChar?.name || '未选择角色',
        createdAt: new Date(start).toLocaleString('zh-CN'),
        durationSec: Number.isFinite(savedDuration)
          ? Math.max(1, Math.floor(savedDuration))
          : Math.max(1, Math.floor((end - start) / 1000)),
        mode: savedMode === 'voice' || savedMode === 'video' ? savedMode : undefined,
        transcript: msgs.map(m => ({
          id: `db-${m.id}`,
          dbId: m.id,
          role: m.role as 'user' | 'assistant',
          text: m.content,
          audioUrl: m.metadata?.audioUrl,
          thinkingChain: typeof m.metadata?.thinkingChain === 'string' ? m.metadata.thinkingChain : undefined,
          performance: m.metadata?.avatarPerformance as AvatarPerformanceDirection | undefined,
          performanceTimeline: m.metadata?.avatarPerformanceCues as AvatarPerformanceCue[] | undefined,
          cameraSnapshotRef: typeof m.metadata?.cameraSnapshotRef === 'string' && m.metadata.cameraSnapshotRef
            ? m.metadata.cameraSnapshotRef
            : undefined,
          cameraSnapshotExpired: m.metadata?.cameraSnapshotExpired === true,
          time: formatTimeByTs(m.timestamp),
          timestamp: m.timestamp,
        })),
      };
    }).sort((a, b) => (b.transcript[b.transcript.length - 1]?.timestamp || 0) - (a.transcript[a.transcript.length - 1]?.timestamp || 0));
    setCallRecords(records);
  };
  const pruneCallSnapshots = async (charId: string, sessionId: string) => {
    const all = await DB.getMessagesByCharId(charId, true);
    const expired = findExpiredCallSnapshots(all, sessionId);
    if (!expired.length) return;
    for (const snapshot of expired) {
      await DB.updateMessageMetadata(snapshot.messageId, (previous: any) => {
        const next = { ...(previous || {}), cameraSnapshotExpired: true };
        delete next.cameraSnapshotRef;
        return next;
      });
      await deleteBlobRef(snapshot.ref);
    }
    trackEvent('淘汰旧视频通话快照');
    const expiredIds = new Set(expired.map(snapshot => snapshot.messageId));
    setBubbles(previous => previous.map(bubble => (
      bubble.dbId && expiredIds.has(bubble.dbId)
        ? { ...bubble, cameraSnapshotRef: undefined, cameraSnapshotExpired: true }
        : bubble
    )));
    markCallTurnDirty();
  };
  const resetCurrentCall = () => {
    revokeSessionBlobs();
    stopPlayback();
    pendingAvatarTouchesRef.current = [];
    setPendingAvatarTouchCount(0);
    setAvatarTouchEffects([]);
    avatarTouchEffectTimersRef.current.forEach(timer => window.clearTimeout(timer));
    avatarTouchEffectTimersRef.current = [];
    idleNudgeCountRef.current = 0;
    setCallState('idle');
    setBubbles([]);
    setDraftInput('');
    setAudioUrl('');
    setTraceId('');
    setErrorMessage('');
    setAvatarEmotion('calm');
    setAvatarPerformance(DEFAULT_AVATAR_PERFORMANCE);
    setCallStartedAt(null);
    setElapsedSeconds(0);
    setShowInputPanel(true);
    setCurrentSessionId(`call-${Date.now()}`);
  };
  const closeCallSetupGuide = () => {
    callSetupGuideOpenRef.current = false;
    setShowCallSetupGuide(false);
  };
  const openCallSetupGuide = (step: CallSetupGuideStep = 'model') => {
    setSetupCameraMode('off');
    setCallSetupGuideStep(step);
    callSetupGuideOpenRef.current = true;
    setShowCallSetupGuide(true);
  };
  const dismissCallUpdateAnnouncement = () => {
    markCallUpdateAnnouncementSeen();
    setShowCallUpdateAnnouncement(false);
    trackEvent('关闭通话功能更新提示');
  };
  const openCallPreferencesPanel = () => {
    markCallUpdateAnnouncementSeen();
    setShowCallUpdateAnnouncement(false);
    setShowCallPreferences(true);
    trackEvent('打开通话偏好');
  };
  const primeCallAudioFromGesture = (forceManualPlayback = false) => {
    if (!forceManualPlayback && (!callPreferences.voiceAutoPlay || !isSpeakerOn)) return;
    const audio = audioRef.current;
    if (!audio) return;

    if (forceManualPlayback && !isSpeakerOn) setIsSpeakerOn(true);

    // Desktop/Android may use WebAudio for real-time lip sync. Invoke resume()
    // directly in the click stack; never wait for React onPlay/useEffect.
    if (!nativeCallAudioOnly) void getAudioFeed().unlock();

    for (const element of [localCallAudioRef.current, remoteCallAudioRef.current]) {
      if (!element) continue;
      element.muted = false;
      primeVoiceAudio(element, SILENT_CALL_AUDIO_DATA_URL);
    }
  };
  const beginSelectedCall = (cameraMode: UserCameraMode = 'off') => {
    closeCallSetupGuide();
    resetCurrentCall();
    primeCallAudioFromGesture();
    setViewMode('in-call');
    setCallStartedAt(Date.now());
    setCallState('listening');
    trackEvent('发起通话');
    if (callMode !== 'video' || cameraMode === 'off') {
      stopUserCamera();
      return;
    }
    if (cameraMode === 'fake') {
      stopUserCamera();
      if (fakeUserCameraRef) setUserCameraMode('fake');
      return;
    }
    void startUserCamera(cameraMode);
  };
  const requestSelectedCall = () => {
    if (callMode === 'video') {
      let guideCompleted = false;
      try { guideCompleted = localStorage.getItem(CALL_SETUP_GUIDE_KEY) === 'complete'; } catch { /* private WebView */ }
      if (!guideCompleted) {
        openCallSetupGuide(hasSelectedVideoVisual ? 'camera' : 'model');
        return;
      }
    }
    beginSelectedCall('off');
  };
  const finishCallSetupGuide = () => {
    try { localStorage.setItem(CALL_SETUP_GUIDE_KEY, 'complete'); } catch { /* private WebView */ }
    beginSelectedCall(setupCameraMode);
  };
  const finishCall = async () => {
    if (selectedChar?.id) {
      const userTurns = bubbles.filter(b => b.role === 'user').length;
      const keepsakeLine = summarizeKeepsakeLine(bubbles, selectedChar.name);
      const payload = {
        characterId: selectedChar.id,
        characterName: selectedChar.name,
        characterAvatar: selectedChar.avatar,
        durationSec: elapsedSeconds,
        turnCount: userTurns,
        keepsakeLine,
        callMode,
        endedAt: Date.now(),
      };
      await DB.saveMessage({
        charId: selectedChar.id,
        role: 'system',
        type: 'system',
        content: `通话结束 · ${selectedChar.name}｜${formatDuration(elapsedSeconds)}｜${Math.max(1, userTurns)}轮对话`,
        metadata: { source: 'call-end-popup', callSessionId: currentSessionId, ...payload },
      });
      await loadCallRecords(selectedChar.id);
      trackEvent('结束一通通话', { 模式: callMode === 'video' ? '视频' : '语音' });
      // 挂断这一下最要紧：用户多半接着就把 App 关了，得把这最后一条也打脏——
      // 打脏即传，微任务内就会冲刷上传。
      markCallTurnDirty();
      runCallMemoryPalaceHook(selectedChar);
    }
    clearSuspendedCall();
    resetCurrentCall();
    setViewMode('history');
    setShowHangupConfirm(false);
    addToast('通话记录已保存', 'success');
  };
  const handleHangup = () => {
    setShowHangupConfirm(true);
  };
  // 与聊天 / 约会完全同一条历史管线（ChatPrompts.buildMessageHistory，约会的
  // buildDateHistory 也是它）：[聊天] [通话] [约会] 三种来源是同一条"真正的
  // 上下文"，按时间顺序注入；来源标签、角色时区时间戳、图片(image_url)/表情/
  // 引用回复的处理全部与其它入口一致，不再手搓一套只属于通话的格式。
  const buildHistoryMessages = async (
    input: string,
    skipDbId?: number,
    touchContext = '',
  ): Promise<any[]> => {
    if (!selectedChar?.id) return [{ role: 'user', content: input }];
    const [allMsgs, emojis] = await Promise.all([
      loadCharacterContextMessages(selectedChar),
      DB.getEmojis().catch(() => []),
    ]);
    const filtered = allMsgs.filter(m => !(skipDbId && m.id === skipDbId));
    const { apiMessages } = ChatPrompts.buildMessageHistory(
      filtered, Math.max(1, filtered.length), selectedChar, userProfile || ({} as any), emojis,
    );
    const lastMsg = filtered[filtered.length - 1];
    const timeGapHint = ChatPrompts.getTimeGapHint(lastMsg, Date.now());
    // 现场这句也带上与历史一致的 [通话] 标——裸着的输入容易被模型接到
    // 最近的 [聊天] 线程上，通话里刚说的反而被忘掉。
    const inputWithTouch = touchContext
      ? `${touchContext}\n\n[用户本轮说的话]\n${input}`
      : input;
    const taggedInput = `[${new Date().toLocaleString('zh-CN')}] [通话] ${inputWithTouch}`;
    const finalInput = timeGapHint ? `${taggedInput}\n\n${timeGapHint}` : taggedInput;
    return [...apiMessages, { role: 'user', content: finalInput }];
  };
  const getAllowedModelActions = (): Array<{
    id: string;
    name: string;
    kind?: 'motion' | 'expression' | 'params';
    tags?: string[];
  }> => (
    selectedVisualSource !== 'model'
      ? []
      : selectedChar?.videoAvatar?.format === 'live2d'
      ? selectedChar.videoAvatar.actions
          .filter(action => action.permission === 'ai' && !action.wardrobe)
          .sort((a, b) => {
            const score = (action: typeof a) => (action.tags.length ? 100 : 0)
              + (action.kind === 'motion' ? 20 : action.kind === 'params' ? 15 : 10)
              + (action.source === 'vtube' ? 2 : 0);
            return score(b) - score(a);
          })
          .map(action => ({ id: action.id, name: action.name, kind: action.kind, tags: action.tags }))
      : selectedChar?.videoAvatar?.format === 'vrm'
        ? vrmExpressionsRef.current.map(name => ({ id: name, name: `自定义表情·${name}`, kind: 'expression' as const }))
        : []
  );

  const resolvePerformanceDirectorApi = (character: CharacterProfile) => {
    // 与情绪 Buff 完全复用同一套 API 选择规则：角色单独配了就用副 API，
    // 没有单独配置则回退主 API。
    const configuredEmotionApi = character.emotionConfig?.api;
    return configuredEmotionApi?.baseUrl
      ? configuredEmotionApi
      : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
  };

  const buildLocalPerformancePersona = (character: CharacterProfile): string => {
    const source = [
      character.personalityStyle,
      character.description,
      character.systemPrompt,
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return Array.from(source || '自然、克制地进行视频通话表演，动作服从台词情绪，不刻意抢戏。')
      .slice(0, AVATAR_PERFORMANCE_PERSONA_MAX_CHARS)
      .join('');
  };

  const ensureVideoPerformancePersona = async (character: CharacterProfile): Promise<string | null> => {
    const persisted = character.videoCallPerformancePersona?.trim();
    if (persisted) {
      const clamped = Array.from(persisted).slice(0, AVATAR_PERFORMANCE_PERSONA_MAX_CHARS).join('');
      performancePersonaCacheRef.current.set(character.id, clamped);
      return clamped;
    }
    const cached = performancePersonaCacheRef.current.get(character.id);
    if (cached) return cached;
    const pending = performancePersonaPromiseRef.current.get(character.id);
    if (pending) return pending;
    // One attempt per mounted CallApp session. A transient failure falls back locally
    // for this call and can be retried next time the user opens the app.
    if (performancePersonaAttemptedRef.current.has(character.id)) return null;
    performancePersonaAttemptedRef.current.add(character.id);

    const task = (async (): Promise<string | null> => {
      try {
        const directorApi = resolvePerformanceDirectorApi(character);
        const baseUrl = directorApi.baseUrl?.replace(/\/+$/, '');
        if (!baseUrl) return null;
        const coreContext = ContextBuilder.buildCoreContext(character, userProfile, true);
        const prompt = buildAvatarPerformancePersonaPrompt({
          characterName: character.name,
          coreContext,
        });
        const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorApi.apiKey || 'sk-none'}` },
          body: JSON.stringify({
            model: directorApi.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.25,
            max_tokens: AVATAR_PERFORMANCE_PERSONA_MAX_TOKENS,
            stream: false,
          }),
        }, 1, 30_000, {
          appName: '电话',
          charId: character.id,
          charName: character.name,
          purpose: '生成视频表演人格',
        });
        const persona = parseAvatarPerformancePersona(extractContent(data));
        if (!persona) return null;
        performancePersonaCacheRef.current.set(character.id, persona);
        updateCharacter(character.id, {
          videoCallPerformancePersona: persona,
          videoCallPerformancePersonaGeneratedAt: Date.now(),
        });
        return persona;
      } catch (error: any) {
        console.warn('[call] performance persona warmup failed; using local fallback:', error?.message || error);
        return null;
      } finally {
        performancePersonaPromiseRef.current.delete(character.id);
      }
    })();
    performancePersonaPromiseRef.current.set(character.id, task);
    return task;
  };

  // 进入高质量视频通话即后台预热。它与开场白主请求同时进行，通常在主台词
  // 返回前已经完成，因此首次导演请求也不需要再串行多等一整轮。
  useEffect(() => {
    if (viewMode !== 'in-call' || callMode !== 'video') return;
    if (!selectedChar || selectedChar.videoCallPerformanceQuality !== 'high') return;
    void ensureVideoPerformancePersona(selectedChar);
  }, [viewMode, callMode, selectedChar?.id, selectedChar?.videoCallPerformanceQuality]);

  const requestHighQualityPerformance = async (
    replyText: string,
    allowedModelActions: Array<{
      id: string;
      name: string;
      kind?: 'motion' | 'expression' | 'params';
      tags?: string[];
    }>,
  ): Promise<AvatarPerformanceCue[] | null> => {
    if (!selectedChar || callMode !== 'video') return null;
    const directorApi = resolvePerformanceDirectorApi(selectedChar);
    const baseUrl = directorApi.baseUrl?.replace(/\/+$/, '');
    if (!baseUrl) return null;
    const personality = await ensureVideoPerformancePersona(selectedChar)
      || buildLocalPerformancePersona(selectedChar);
    const normalizedReply = sanitizeAssistantOutput(replyText);
    const voiceCopy = extractVoiceTag(normalizedReply);
    const spokenText = (voiceCopy.display || voiceCopy.voiceText || normalizedReply).trim();
    const sentences = splitAvatarPerformanceSentences(spokenText);
    if (!sentences.length) return null;
    const sentencePlan = sentences
      .map((sentence, index) => `${index + 1}. at=${sentence.at.toFixed(4)}：${sentence.text}`)
      .join('\n');
    const prompt = `${buildAvatarPerformanceRehearsalPrompt({
      characterName: selectedChar.name,
      personality,
      reply: replyText,
      modelActions: allowedModelActions,
    })}

## 本轮逐句硬约束
- 严格返回 ${sentences.length} 个 cues，必须与下列 ${sentences.length} 句话一一对应。
- 每个 cue 都必须同时包含 start、hold_ms、end；不要合并、拆分或增加过场 cue。
- at 必须照抄句子表。

${sentencePlan}`;
    const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${directorApi.apiKey || 'sk-none'}` },
      body: JSON.stringify({
        model: directorApi.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.45,
        max_tokens: AVATAR_PERFORMANCE_REHEARSAL_MAX_TOKENS,
        stream: false,
      }),
    }, 1, 30_000, {
      appName: '电话',
      charId: selectedChar.id,
      charName: selectedChar.name,
      purpose: '视频动作排练',
    });
    const cues = parseAvatarPerformanceRehearsal(
      extractContent(data),
      allowedModelActions.map(action => action.id),
      sentences.length,
    );
    if (!isCompleteAvatarPerformanceCuePack(cues, sentences.length)) {
      console.warn('[call] high-quality director returned an incomplete sentence cue pack');
      return null;
    }
    return alignAvatarPerformanceCuesToSentences(cues, spokenText);
  };

  const requestAssistantReply = async (
    input: string,
    skipDbId?: number,
    pendingTouches: AvatarTouchRecord[] = [],
    includeUserCameraContext = false,
    userCameraSnapshotForTurn?: string,
  ): Promise<ParsedCallReply> => {
    const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
    if (!baseUrl) throw new Error('请先在设置里配置聊天 API URL');
    const userName = userProfile?.name?.trim() || '用户';
    if (selectedChar) {
      const callMsgs = await loadCharacterContextMessages(selectedChar);
      await injectMemoryPalace(selectedChar, callMsgs);
    }
    const baseCallPrompt = selectedChar
      ? buildCallPrompt(
          userName,
          selectedChar.name,
          // conversational：通话是实时对话，时间块补那句语境框定（见 buildTimeAwarenessBlock）
          ContextBuilder.buildCoreContext(selectedChar, userProfile, true, undefined, undefined, { conversational: true }),
          voiceLang || undefined,
          callMode,
          resolveCharTimeZone(selectedChar),
        )
      : buildCallPrompt(userName, undefined, undefined, voiceLang || undefined, callMode);
    const thinkingPrompt = selectedChar?.showThinkingChain
      ? [
          buildThinkingChainPrompt(selectedChar.name, userName),
          selectedChar.thinkingChainCustomPrompt?.trim()
            ? `【用户追加的 THINKING 要求】\n${selectedChar.thinkingChainCustomPrompt.trim()}`
            : '',
        ].filter(Boolean).join('\n\n')
      : '';
    // 模型专属动作白名单：Live2D 用用户授权的 actions；VRM 用加载时枚举出的
    // 自定义表情（星星眼/黑脸这类，预设之外的全部可用）。
    const allowedModelActions = getAllowedModelActions();
    const highQualityPerformance = callMode === 'video'
      && selectedChar?.videoCallPerformanceQuality === 'high';
    const userCameraEmotionContext = includeUserCameraContext
      && callMode === 'video'
      && userCameraMode === 'emotion'
      ? await captureUserCameraEmotionContext()
      : '';
    const userCameraSnapshot = includeUserCameraContext
      && callMode === 'video'
      && userCameraMode === 'snapshot'
      ? (userCameraSnapshotForTurn ?? captureUserCameraSnapshotContext())
      : '';
    if (includeUserCameraContext && callMode === 'video' && userCameraMode === 'snapshot' && !userCameraSnapshot && userCameraSnapshotForTurn === undefined) {
      addToast('摄像头画面还没准备好，本轮已只发送文字', 'info');
    }
    const baseSystemPrompt = [
      baseCallPrompt,
      callMode === 'video' && !highQualityPerformance ? buildAvatarPerformancePrompt(allowedModelActions) : '',
      userCameraEmotionContext,
      thinkingPrompt,
    ].filter(Boolean).join('\n\n');
    const systemPrompt = [baseSystemPrompt, userCameraSnapshot ? USER_CAMERA_SNAPSHOT_SYSTEM_NOTE : '']
      .filter(Boolean)
      .join('\n\n');
    const touchContext = selectedChar
      ? buildPendingAvatarTouchContext(
          pendingTouches,
          selectedChar.name,
          userName,
        )
      : '';
    const messages = await buildHistoryMessages(input, skipDbId, touchContext);
    const requestMessages = userCameraSnapshot
      ? attachSnapshotToLatestUserMessage(messages, userCameraSnapshot)
      : messages;
    const sendChatRequest = (
      nextMessages: any[],
      nextSystemPrompt: string,
      maxRetries: number,
      purpose: string,
    ) => safeFetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}` },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'system', content: nextSystemPrompt }, ...nextMessages],
        temperature: 0.85,
        // max_tokens 是 Claude 原生 API 的必填字段；缺了它，OpenAI→Claude 中转会被
        // 上游打回，包成 502 / bad_response_status_code。与私聊 (useChatAI.ts) 对齐。
        max_tokens: 8000,
        stream: false,
      }),
    }, maxRetries, 0, { appName: '电话', charId: selectedChar?.id, charName: selectedChar?.name, purpose });
    let chatData: any;
    try {
      // Do not repeat a rejected base64 frame three times. Text-only calls keep
      // the normal transient-error retries; snapshot calls first try vision once.
      chatData = await sendChatRequest(
        requestMessages,
        systemPrompt,
        userCameraSnapshot ? 0 : 2,
        userCameraSnapshot ? '视频通话·用户快照' : '语音通话',
      );
    } catch (error) {
      if (!userCameraSnapshot || !isVisionInputUnsupportedError(error)) throw error;
      console.warn('[camera-snapshot] provider rejected vision input; retrying text-only:', error);
      addToast('当前模型不支持图片；本轮已自动改为只发文字', 'info');
      chatData = await sendChatRequest(messages, baseSystemPrompt, 2, '视频通话·快照降级为文字');
    }
    const parsed = parseCallAssistantMessage(
      chatData?.choices?.[0]?.message,
      !!selectedChar?.showThinkingChain,
    );
    if (!parsed.text.trim()) throw new Error('文本接口返回为空，或只返回了思考内容');
    const preparedForAudio = prepareCallAssistantReply(parsed);
    prefetchCallAudio(preparedForAudio.text, preparedForAudio.speechEmotion);
    if (highQualityPerformance) {
      try {
        const cues = await requestHighQualityPerformance(parsed.text, allowedModelActions);
        if (cues?.length) {
          return { ...parsed, performance: cues[0].direction, performanceCues: cues };
        }
        console.warn('[call] high-quality performance returned no usable cues; using local fallback');
      } catch (error: any) {
        // 动作导演不能拖垮通话正文；超时、额度或格式问题都退回本地文本推断。
        console.warn('[call] high-quality performance failed; using local fallback:', error?.message || error);
      }
    }
    return parsed;
  };
  // ── 演出时间轴调度：多条 [[AVATAR:]] 指令按语音播放进度依次生效 ──
  const performanceCueTimersRef = useRef<number[]>([]);
  const pendingCueScheduleRef = useRef<{ cues: AvatarPerformanceCue[]; fallbackMs: number } | null>(null);
  const silentSpeechTimerRef = useRef<number | null>(null);
  const clearPerformanceCueTimers = () => {
    performanceCueTimersRef.current.forEach(timer => window.clearTimeout(timer));
    performanceCueTimersRef.current = [];
  };
  const clearSilentSpeechTimer = () => {
    if (silentSpeechTimerRef.current !== null) window.clearTimeout(silentSpeechTimerRef.current);
    silentSpeechTimerRef.current = null;
  };
  const applyPerformanceDirection = (direction: AvatarPerformanceDirection) => {
    setAvatarEmotion(direction.emotion);
    setAvatarPerformance(direction);
  };
  const schedulePerformanceCues = (cues: AvatarPerformanceCue[] | undefined, durationMs: number) => {
    if (!cues?.length) return;
    clearPerformanceCueTimers();
    expandAvatarPerformanceCueBeats(cues, durationMs).forEach(beat => {
      if (beat.delayMs <= 80) {
        applyPerformanceDirection(beat.direction);
        return;
      }
      performanceCueTimersRef.current.push(window.setTimeout(() => applyPerformanceDirection(beat.direction), beat.delayMs));
    });
  };
  const playSilentAvatarSpeech = (
    text: string,
    cues?: AvatarPerformanceCue[],
    durationOverrideMs?: number,
  ) => {
    const durationMs = durationOverrideMs || estimateSpeechMs(text);
    clearSilentSpeechTimer();
    pendingCueScheduleRef.current = null;
    setIsAudioPlaying(false);
    setCallState('speaking');
    schedulePerformanceCues(cues, durationMs);
    silentSpeechTimerRef.current = window.setTimeout(() => {
      silentSpeechTimerRef.current = null;
      clearPerformanceCueTimers();
      setCallState(prev => (prev === 'speaking' ? 'listening' : prev));
    }, durationMs);
  };
  useEffect(() => () => {
    clearPerformanceCueTimers();
    clearSilentSpeechTimer();
  }, []);

  useEffect(() => {
    const elements = [localCallAudioRef.current, remoteCallAudioRef.current].filter((audio): audio is HTMLAudioElement => !!audio);
    const handlePlay = (event: Event) => {
      const audio = event.currentTarget as HTMLAudioElement;
      if (audio !== audioRef.current || isVoiceAudioPriming(audio)) return;
      clearSilentSpeechTimer();
      setIsAudioPlaying(true);
      setCallState('speaking');
      const pending = pendingCueScheduleRef.current;
      if (!pending) return;
      pendingCueScheduleRef.current = null;
      const durationSec = audio.duration;
      const durationMs = Number.isFinite(durationSec) && durationSec > 0
        ? durationSec * 1000
        : pending.fallbackMs;
      schedulePerformanceCues(pending.cues, durationMs);
    };
    const handleStop = (event: Event) => {
      const audio = event.currentTarget as HTMLAudioElement;
      if (audio !== audioRef.current || isVoiceAudioPriming(audio)) return;
      setIsAudioPlaying(false);
      clearPerformanceCueTimers();
      setCallState(previous => (previous === 'speaking' ? 'listening' : previous));
    };
    for (const audio of elements) {
      audio.addEventListener('play', handlePlay);
      audio.addEventListener('pause', handleStop);
      audio.addEventListener('ended', handleStop);
      audio.addEventListener('error', handleStop);
    }
    return () => {
      for (const audio of elements) {
        audio.removeEventListener('play', handlePlay);
        audio.removeEventListener('pause', handleStop);
        audio.removeEventListener('ended', handleStop);
        audio.removeEventListener('error', handleStop);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = !isSpeakerOn;
  }, [isSpeakerOn]);

  const startCallAudioElement = (audio: HTMLAudioElement, forceAudible = false): Promise<void> => {
    audio.muted = forceAudible ? false : !isSpeakerOn;
    const feed = callMode === 'video' && !nativeCallAudioOnly && audio === localCallAudioRef.current ? getAudioFeed() : null;
    // Both calls are made immediately in the originating click stack. The graph
    // is attached only after both succeeded, so a suspended context can never
    // steal otherwise-audible native media output.
    const unlockAttempt = feed?.unlock();
    let playbackAttempt: Promise<void>;
    try { playbackAttempt = Promise.resolve(audio.play()); }
    catch (error) { return Promise.reject(error); }
    if (feed && unlockAttempt) {
      void Promise.allSettled([unlockAttempt, playbackAttempt]).then(([unlockResult, playbackResult]) => {
        if (unlockResult.status === 'fulfilled' && unlockResult.value && playbackResult.status === 'fulfilled') {
          feed.attach(audio);
        }
      });
    }
    return playbackAttempt;
  };

  const playAudio = (url?: string, cues?: AvatarPerformanceCue[], fallbackMs?: number, forceAudible = false) => {
    const targetUrl = url || audioUrl;
    const estimatedDurationMs = fallbackMs || 4000;
    if (!targetUrl || !audioRef.current) {
      if (callMode === 'video') playSilentAvatarSpeech('', cues, estimatedDurationMs);
      return;
    }
    clearSilentSpeechTimer();
    if (audioUrl !== targetUrl) setAudioUrl(targetUrl);
    // 时间轴在 onPlay 时用真实音频时长调度；拿不到时长再用估计值。
    pendingCueScheduleRef.current = cues?.length ? { cues, fallbackMs: estimatedDurationMs } : null;
    const audio = canAnalyzeVoiceSource(targetUrl) ? localCallAudioRef.current! : remoteCallAudioRef.current!;
    if (audioRef.current !== audio) {
      const previousAudio = audioRef.current;
      audioRef.current = audio;
      previousAudio.pause();
    }
    audioFeedRef.current?.setActive(callMode === 'video' && audio === localCallAudioRef.current);
    audio.src = targetUrl;
    audio.currentTime = 0;
    startCallAudioElement(audio, forceAudible).catch(error => {
      if (audioRef.current !== audio || audio.src !== targetUrl) return;
      pendingCueScheduleRef.current = null;
      if (callMode === 'video') playSilentAvatarSpeech('', cues, estimatedDurationMs);
      else setCallState('listening');
      addToast(voicePlaybackErrorMessage(error, '重播语音'), 'info');
    });
    setCallState('speaking');
  };
  const ensureCallBubbleAudio = async (bubble: CallBubble, forceRegenerate = false): Promise<string | null> => {
    if (bubble.role !== 'assistant' || generatingAudioBubbleId) return null;
    if (bubble.audioUrl && !forceRegenerate) return bubble.audioUrl;
    if (!hasConfiguredVoice()) {
      addToast('还没有配置这个角色的语音', 'info');
      return null;
    }
    setGeneratingAudioBubbleId(bubble.id);
    setErrorMessage('');
    try {
      const voiceTag = extractVoiceTag(bubble.text);
      const { url, traceIds } = await takeOrSynthesizeCallAudio(
        bubble.text,
        voiceTag.emotion || bubble.performance?.emotion,
      );
      if (!url) throw new Error('未获得可播放音频');
      trackBlobUrl(url);
      setAudioUrl(url);
      setTraceId(traceIds.filter(Boolean).join(' | '));
      setBubbles(previous => previous.map(item => item.id === bubble.id ? { ...item, audioUrl: url } : item));
      setCallRecords(previous => previous.map(record => ({
        ...record,
        transcript: record.transcript.map(item => item.id === bubble.id ? { ...item, audioUrl: url } : item),
      })));
      return url;
    } catch (error: any) {
      setCallState('listening');
      setErrorMessage(error?.message || '语音生成失败');
      addToast(`语音生成失败：${error?.message || '未知错误'}`, 'error');
      return null;
    } finally {
      setGeneratingAudioBubbleId(null);
    }
  };
  const handlePlayBubbleAudio = async (bubble: CallBubble) => {
    if (bubble.role !== 'assistant' || generatingAudioBubbleId) return;
    if (bubble.audioUrl) {
      if (!isSpeakerOn) setIsSpeakerOn(true);
      playAudio(bubble.audioUrl, bubble.performanceTimeline, estimateSpeechMs(bubble.text), true);
      trackEvent('重播一条通话语音');
      return;
    }
    // The click itself unlocks the persistent media element. TTS happens only
    // after this point when automatic voice is disabled.
    if (isAudioPlaying) pauseAudio();
    primeCallAudioFromGesture(true);
    const url = await ensureCallBubbleAudio(bubble);
    if (!url) return;
    if (!isSpeakerOn) setIsSpeakerOn(true);
    playAudio(url, bubble.performanceTimeline, estimateSpeechMs(bubble.text), true);
    trackEvent('按需生成并播放通话语音');
  };
  const callFavoriteSourceKey = (charId: string, bubble: CallBubble) => `${charId}:${bubble.dbId || bubble.id}`;
  const openCallVoiceFavorite = async (bubble: CallBubble, charId = selectedChar?.id || '', charName = selectedChar?.name || '未知角色') => {
    if (bubble.role !== 'assistant' || !charId) return;
    setVoiceFavoriteTarget({ bubble, charId, charName });
    setVoiceFavoriteBusy(false);
    setVoiceFavoriteSaved(!!await getVoiceFavorite('call', callFavoriteSourceKey(charId, bubble)).catch(() => null));
  };
  const toggleCallVoiceFavorite = async () => {
    const target = voiceFavoriteTarget;
    if (!target || voiceFavoriteBusy) return;
    const sourceKey = callFavoriteSourceKey(target.charId, target.bubble);
    setVoiceFavoriteBusy(true);
    try {
      if (voiceFavoriteSaved) {
        await removeVoiceFavorite('call', sourceKey);
        setVoiceFavoriteSaved(false);
        addToast('已取消收藏语音', 'info');
        return;
      }

      let url = target.bubble.audioUrl || await ensureCallBubbleAudio(target.bubble);
      let blob: Blob | null = null;
      if (url) {
        try { blob = await fetchBlobForShare(url, 'audio/mpeg'); } catch { /* stale session URL: regenerate below */ }
      }
      if (!blob) {
        url = await ensureCallBubbleAudio(target.bubble, true);
        if (url) {
          try { blob = await fetchBlobForShare(url, 'audio/mpeg'); } catch { /* handled below */ }
        }
      }
      if (!blob) throw new Error('暂时拿不到这条语音的音频文件');

      const parsed = extractVoiceTag(target.bubble.text);
      const originalText = stripCallTextFormatting(parsed.display).trim()
        || stripTtsMarkupForDisplay(parsed.voiceText, apiConfig)
        || stripCallTextFormatting(target.bubble.text).trim();
      const spokenText = stripTtsMarkupForDisplay(parsed.voiceText, apiConfig) || originalText;
      await saveVoiceFavorite({
        source: 'call',
        sourceKey,
        charId: target.charId,
        charName: target.charName,
        sourceTimestamp: target.bubble.timestamp,
        originalText,
        spokenText: spokenText !== originalText ? spokenText : undefined,
        language: voiceLang || undefined,
        blob,
      });
      setVoiceFavoriteSaved(true);
      addToast('已收藏通话语音', 'success');
      trackEvent('收藏通话语音');
    } catch (error: any) {
      addToast(error?.message || '收藏失败，请检查浏览器存储空间', 'error');
    } finally {
      setVoiceFavoriteBusy(false);
    }
  };
  const resumeAudio = () => {
    if (!audioRef.current || !audioUrl) return;
    startCallAudioElement(audioRef.current).catch(() => addToast('继续播放失败，请点击重播', 'error'));
  };
  const pauseAudio = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    setCallState('listening');
  };

  useEffect(() => {
    if (nativeCallAudioOnly) return;
    const recoverAudioGraph = () => {
      if (document.visibilityState !== 'visible' || !isAudioPlaying) return;
      void audioFeedRef.current?.unlock();
    };
    document.addEventListener('visibilitychange', recoverAudioGraph);
    window.addEventListener('pageshow', recoverAudioGraph);
    return () => {
      document.removeEventListener('visibilitychange', recoverAudioGraph);
      window.removeEventListener('pageshow', recoverAudioGraph);
    };
  }, [isAudioPlaying, nativeCallAudioOnly]);

  // 接通后由角色先说第一句。它和后续静默主动接话共用一个显式通话偏好，
  // 默认开启；关闭后 CallApp 会等待用户先说，ChatApp 不受影响。
  const greetingFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!callPreferences.characterInitiative || viewMode !== 'in-call' || bubbles.length > 0) return;
    if (!selectedChar?.id || greetingFiredRef.current === currentSessionId) return;
    greetingFiredRef.current = currentSessionId;
    void (async () => {
      try {
        setCallState('connecting');
        const greetingReply = prepareCallAssistantReply(
          await requestAssistantReply('（电话刚接通。你先开口——像平时接到这个人电话一样自然地说第一句话。不要解释规则，就是最自然的那个“喂”“诶”或者符合你性格的开场。）'),
          callMode === 'video' && selectedChar?.videoCallPerformanceQuality !== 'high',
        );
        const greetingText = greetingReply.text;
        setAvatarEmotion(greetingReply.performance.emotion);
        setAvatarPerformance(greetingReply.performance);
        const nowTs = Date.now();
        const greetingBubble: CallBubble = {
          id: `${nowTs}-greeting`,
          role: 'assistant',
          text: greetingText,
          time: formatTime(),
          timestamp: nowTs,
          thinkingChain: greetingReply.thinkingChain,
          performance: greetingReply.performance,
          performanceTimeline: greetingReply.performanceCues,
        };
        setCallState('speaking');
        setBubbles([greetingBubble]);
        const dbId = await DB.saveMessage({
          charId: selectedChar.id,
          role: 'assistant',
          type: 'text',
          content: greetingText,
          metadata: {
            source: 'call',
            callSessionId: currentSessionId,
            ...(greetingReply.thinkingChain ? { thinkingChain: greetingReply.thinkingChain } : {}),
            avatarPerformance: greetingReply.performance,
            avatarPerformanceCues: greetingReply.performanceCues,
          },
        });
        setBubbles(previous => previous.map(bubble => bubble.id === greetingBubble.id ? { ...bubble, dbId } : bubble));
        markCallTurnDirty();

        let playbackStarted = false;
        if (callPreferences.voiceAutoPlay && canSpeakVoice()) {
          try {
            const { url } = await takeOrSynthesizeCallAudio(greetingText, greetingReply.speechEmotion);
            if (url) {
              trackBlobUrl(url);
              setAudioUrl(url);
              setBubbles(previous => previous.map(bubble => bubble.id === greetingBubble.id ? { ...bubble, audioUrl: url } : bubble));
              window.setTimeout(() => playAudio(url, greetingReply.performanceCues, estimateSpeechMs(greetingText)), 0);
              playbackStarted = true;
            }
          } catch {
            // 语音失败不抹掉角色已经说出的文字。
          }
        }
        if (!playbackStarted) {
          if (callMode === 'video' && callPreferences.voiceAutoPlay) {
            playSilentAvatarSpeech(greetingText, greetingReply.performanceCues);
          } else {
            setCallState('listening');
          }
        }
      } catch (error: any) {
        setCallState('error');
        setErrorMessage(error?.message || '开场白生成失败');
      }
    })();
  }, [viewMode, currentSessionId, callPreferences.characterInitiative]);

  const handleAvatarTouch = (hit: AvatarTouchHit) => {
    const character = selectedChar;
    if (!character) return;
    const now = Date.now();
    if (now - avatarTouchLastAtRef.current < 180) return;
    avatarTouchLastAtRef.current = now;

    const record = createAvatarTouchRecord(hit, now);
    const pending = appendPendingAvatarTouch(pendingAvatarTouchesRef.current, record);
    pendingAvatarTouchesRef.current = pending;
    setPendingAvatarTouchCount(pending.length);

    const effect: AvatarTouchEffect = {
      id: record.id,
      normalizedX: hit.normalizedX,
      normalizedY: hit.normalizedY,
      label: avatarTouchTargetLabel(hit),
    };
    setAvatarTouchEffects(current => [...current.slice(-3), effect]);
    const timer = window.setTimeout(() => {
      setAvatarTouchEffects(current => current.filter(item => item.id !== effect.id));
      avatarTouchEffectTimersRef.current = avatarTouchEffectTimersRef.current
        .filter(activeTimer => activeTimer !== timer);
    }, 1_750);
    avatarTouchEffectTimersRef.current.push(timer);

    if (callMode === 'video') {
      applyPerformanceDirection(buildImmediateTouchPerformance(hit.zone));
    } else {
      setVoiceAvatarPokeNonce(value => value + 1);
    }
    if (!callStartedAt) setCallStartedAt(now);
  };

  const handleVoiceAvatarPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || voiceAvatarPointerRef.current) return;
    voiceAvatarPointerRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: window.performance.now(),
      maxDistance: 0,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleVoiceAvatarPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const pointer = voiceAvatarPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    pointer.maxDistance = Math.max(
      pointer.maxDistance,
      Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y),
    );
  };

  const handleVoiceAvatarPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const pointer = voiceAvatarPointerRef.current;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    voiceAvatarPointerRef.current = null;
    const durationMs = window.performance.now() - pointer.startedAt;
    if (!isAvatarTouchGesture(pointer.maxDistance, durationMs, event.isPrimary)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const normalizedX = rect.width > 0 ? x / rect.width : 0.5;
    const normalizedY = rect.height > 0 ? y / rect.height : 0.5;
    const target = resolveAvatarTouchTarget([], normalizedY, normalizedX);
    handleAvatarTouch({
      nonce: Date.now(),
      x,
      y,
      normalizedX,
      normalizedY,
      ...target,
      source: 'portrait-bounds',
      rawAreas: [],
    });
  };

  const handleVoiceAvatarPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (voiceAvatarPointerRef.current?.pointerId === event.pointerId) {
      voiceAvatarPointerRef.current = null;
    }
  };

  const handleVoiceAvatarKeyboardPoke = () => {
    handleAvatarTouch({
      nonce: Date.now(),
      x: 80,
      y: 72,
      normalizedX: 0.5,
      normalizedY: 0.45,
      zone: 'face',
      part: 'face',
      source: 'portrait-bounds',
      rawAreas: [],
    });
  };

  useEffect(() => () => {
    avatarTouchEffectTimersRef.current.forEach(timer => window.clearTimeout(timer));
    avatarTouchEffectTimersRef.current = [];
  }, []);
  const handleTurn = async () => {
    if (isListening) { sttSessionRef.current?.stop(); setIsListening(false); }
    const typedInput = draftInput.trim();
    const retryInput = getPendingReplyText(bubbles);
    const input = typedInput || retryInput;
    if (!input) return addToast('说点什么吧', 'info');
    if (['connecting', 'thinking'].includes(callState)) return addToast(`${selectedChar?.name || '对方'}还在想，等一等`, 'info');
    if (isAudioPlaying) pauseAudio();
    primeCallAudioFromGesture();
    idleNudgeCountRef.current = 0;
    const pendingTouchesForTurn = pendingAvatarTouchesRef.current.slice();
    const latestBubble = bubbles[bubbles.length - 1];
    const retryBubble = latestBubble?.role === 'user' && latestBubble.text.trim() === input
      ? latestBubble
      : null;
    const isRetry = !!retryBubble;
    const userCameraSnapshotForTurn = callMode === 'video' && userCameraMode === 'snapshot'
      ? captureUserCameraSnapshotContext()
      : '';
    if (callMode === 'video' && userCameraMode === 'snapshot' && !userCameraSnapshotForTurn) {
      addToast('摄像头画面还没准备好，本轮已只发送文字', 'info');
    }
    let newSnapshotRef: string | undefined;
    if (userCameraSnapshotForTurn) {
      try {
        newSnapshotRef = await putImageBlob(dataUrlToBlob(userCameraSnapshotForTurn));
        trackEvent('保存视频通话单帧快照');
      } catch (error) {
        console.warn('[camera-snapshot] failed to save the local call-record frame:', error);
        addToast('快照仍会交给角色，但未能写入本地通话记录', 'info');
      }
    }
    const nowTs = Date.now();
    const now = formatTime();
    const userBubble: CallBubble = retryBubble
      ? { ...retryBubble, ...(newSnapshotRef ? { cameraSnapshotRef: newSnapshotRef, cameraSnapshotExpired: false } : {}) }
      : {
          id: `${nowTs}-u`,
          role: 'user',
          text: input,
          time: now,
          timestamp: nowTs,
          ...(newSnapshotRef ? { cameraSnapshotRef: newSnapshotRef } : {}),
        };
    if (isRetry && newSnapshotRef) {
      setBubbles(previous => previous.map(bubble => bubble.id === userBubble.id ? userBubble : bubble));
    } else if (!isRetry) {
      setBubbles(prev => [...prev, userBubble]);
    }
    setDraftInput('');
    setShowInputPanel(false);
    let userDbId: number | undefined = isRetry ? userBubble.dbId : undefined;
    if (selectedChar?.id) {
      if (!userDbId) {
        userDbId = await DB.saveMessage({
          charId: selectedChar.id,
          role: 'user',
          type: 'text',
          content: input,
          metadata: {
            source: 'call',
            callSessionId: currentSessionId,
            callMode,
            ...(newSnapshotRef ? { cameraSnapshotRef: newSnapshotRef } : {}),
            ...(pendingTouchesForTurn.length ? {
              avatarTouches: pendingTouchesForTurn.map(({ zone, part, rawAreas, timestamp }) => ({
                zone,
                ...(part ? { part } : {}),
                rawAreas,
                timestamp,
              })),
            } : {}),
          },
        });
        setBubbles(prev => prev.map(b => (b.id === userBubble.id ? { ...b, dbId: userDbId } : b)));
        markCallTurnDirty();
      } else if (newSnapshotRef) {
        const previousSnapshotRef = retryBubble?.cameraSnapshotRef;
        try {
          await DB.updateMessageMetadata(userDbId, (previous: any) => ({
            ...(previous || {}),
            source: 'call',
            callSessionId: currentSessionId,
            callMode,
            cameraSnapshotRef: newSnapshotRef,
            cameraSnapshotExpired: false,
          }));
          if (previousSnapshotRef && previousSnapshotRef !== newSnapshotRef) {
            await deleteBlobRef(previousSnapshotRef);
          }
          markCallTurnDirty();
        } catch (error) {
          await deleteBlobRef(newSnapshotRef);
          newSnapshotRef = undefined;
          setBubbles(previous => previous.map(bubble => bubble.id === userBubble.id
            ? { ...bubble, cameraSnapshotRef: previousSnapshotRef }
            : bubble));
          console.warn('[camera-snapshot] failed to update the retried call turn:', error);
        }
      }
      await pruneCallSnapshots(selectedChar.id, currentSessionId);
    }
    if (!callStartedAt) setCallStartedAt(Date.now());
    setCallState('connecting');
    setTraceId('');
    setErrorMessage('');
    let assistantText = '';
    let assistantThinkingChain: string | undefined;
    let turnSpeechEmotion: string | undefined;
    let turnPerformance = DEFAULT_AVATAR_PERFORMANCE;
    let turnPerformanceCues: AvatarPerformanceCue[] = [];
    try {
      setCallState('thinking');
      const reply = prepareCallAssistantReply(
        await requestAssistantReply(input, userDbId, pendingTouchesForTurn, true, userCameraSnapshotForTurn),
        callMode === 'video' && selectedChar?.videoCallPerformanceQuality !== 'high',
      );
      if (pendingTouchesForTurn.length) {
        const remainingTouches = consumePendingAvatarTouches(
          pendingAvatarTouchesRef.current,
          pendingTouchesForTurn,
        );
        pendingAvatarTouchesRef.current = remainingTouches;
        setPendingAvatarTouchCount(remainingTouches.length);
      }
      assistantText = reply.text;
      assistantThinkingChain = reply.thinkingChain;
      turnSpeechEmotion = reply.speechEmotion;
      turnPerformance = reply.performance;
      turnPerformanceCues = reply.performanceCues;
      setAvatarEmotion(reply.performance.emotion);
      setAvatarPerformance(reply.performance);
    } catch (err: any) {
      setErrorMessage(err?.message || '文本回复失败');
      setCallState('error');
      return addToast(`文本回复失败：${err?.message || '未知错误'}`, 'error');
    }
    const assistantBubbleId = `${Date.now()}-a`;
    const assistantBubble: CallBubble = {
      id: assistantBubbleId,
      role: 'assistant',
      text: assistantText,
      time: now,
      timestamp: nowTs,
      thinkingChain: assistantThinkingChain,
      performance: turnPerformance,
      performanceTimeline: turnPerformanceCues,
    };
    setBubbles(prev => [...prev, assistantBubble]);
    let assistantDbId: number | undefined;
    if (selectedChar?.id) {
      assistantDbId = await DB.saveMessage({
        charId: selectedChar.id,
        role: 'assistant',
        type: 'text',
        content: assistantText,
        metadata: {
          source: 'call',
          callSessionId: currentSessionId,
          callMode,
          ...(assistantThinkingChain ? { thinkingChain: assistantThinkingChain } : {}),
          avatarPerformance: turnPerformance,
          avatarPerformanceCues: turnPerformanceCues,
        },
      });
      setBubbles(prev => prev.map(b => {
        if (b.id === assistantBubbleId) return { ...b, dbId: assistantDbId };
        return b;
      }));
      markCallTurnDirty();
      runCallMemoryPalaceHook(selectedChar);
    }
    if (!callPreferences.voiceAutoPlay) {
      setCallState('listening');
      return;
    }
    if (!canSpeakVoice()) {
      if (callMode === 'video') {
        playSilentAvatarSpeech(assistantText, turnPerformanceCues);
      } else {
        setCallState('listening');
      }
      if (isSpeakerOn) addToast('语音未配置，先用文字聊吧', 'info');
      return;
    }
    try {
      const { url: finalUrl, traceIds } = await takeOrSynthesizeCallAudio(assistantText, turnSpeechEmotion);
      if (!finalUrl) throw new Error('未获得可播放音频');
      trackBlobUrl(finalUrl);
      setAudioUrl(finalUrl);
      setTimeout(() => playAudio(finalUrl, turnPerformanceCues, estimateSpeechMs(assistantText)), 0);
      setTraceId(traceIds.filter(Boolean).join(' | '));
      setBubbles(prev => prev.map(b => (b.id === assistantBubbleId ? { ...b, audioUrl: finalUrl } : b)));
      if (assistantDbId) {
        const target = bubbles.find(b => b.id === assistantBubbleId);
        await DB.updateMessage(assistantDbId, target?.text || assistantText);
      }
      setCallState('listening');
    } catch (e: any) {
      setErrorMessage(e?.message || '语音生成失败');
      if (callMode === 'video') playSilentAvatarSpeech(assistantText, turnPerformanceCues);
      else setCallState('listening');
      addToast(`TTS失败：${e?.message || '语音生成失败'}，已保留文本并启用无声表演`, 'info');
    }
  };
  const sendingBusy = ['connecting', 'thinking'].includes(callState);
  const pendingCallRetryText = getPendingReplyText(bubbles);
  const displayCallState: CallState = isAudioPlaying ? 'speaking' : callState;
  useEffect(() => {
    loadCallRecords(selectedCharId);
  }, [selectedCharId]);
  const handleDeleteRecord = async (record: CallRecord) => {
    setDeleteConfirmRecord(record);
  };

  const confirmDeleteRecord = async () => {
    const record = deleteConfirmRecord;
    if (!record) return;
    setDeleteConfirmRecord(null);
    // includeProcessed=true：同 loadCallRecords，否则水位线之前的通话消息删不掉
    const all = await DB.getMessagesByCharId(record.characterId, true);
    // 删除通话消息 + 聊天页的通话总结卡片
    const sessionMessages = all.filter(m => {
      if (m.metadata?.source === 'call' && m.metadata?.callSessionId === record.sessionId) return true;
      if (m.metadata?.source === 'call-end-popup' && m.metadata?.callSessionId === record.sessionId) return true;
      return false;
    });
    const ids = sessionMessages.map(message => message.id);
    const snapshotRefs = Array.from(new Set(sessionMessages
      .map(message => message.metadata?.cameraSnapshotRef)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)));
    if (ids.length) await DB.deleteMessages(ids);
    for (const snapshotRef of snapshotRefs) await deleteBlobRef(snapshotRef);
    if (recordDetailId === record.id) {
      setRecordDetailId('');
      setViewMode('history');
    }
    await loadCallRecords(record.characterId);
    addToast('通话记录已删除', 'success');
    trackEvent('删除一条通话记录');
  };
  const startEditBubble = (bubble: CallBubble) => {
    if (bubble.role !== 'user') return;
    setEditingBubble(bubble);
    setEditingText(bubble.text);
  };
  const saveEditedBubble = async () => {
    if (!editingBubble) return;
    const next = editingText.trim();
    if (!next) return addToast('内容不能为空', 'error');
    setBubbles(prev => prev.map(b => b.id === editingBubble.id ? { ...b, text: next } : b));
    if (editingBubble.dbId) await DB.updateMessage(editingBubble.dbId, next);
    setEditingBubble(null);
    setEditingText('');
    addToast('已更新发言', 'success');
    trackEvent('修改自己的通话发言');
  };
  const handleRerollAssistant = async (bubble: CallBubble) => {
    if (!selectedChar || bubble.role !== 'assistant') return;
    const idx = bubbles.findIndex(b => b.id === bubble.id);
    if (idx <= 0) return;
    const prevUser = bubbles[idx - 1];
    if (!prevUser || prevUser.role !== 'user') return;
    try {
      setRerollingBubbleId(bubble.id);
      setCallState('thinking');
      trackEvent('重掷角色的通话台词');
      const rerollReply = prepareCallAssistantReply(
        await requestAssistantReply(prevUser.text, bubble.dbId),
        callMode === 'video' && selectedChar?.videoCallPerformanceQuality !== 'high',
      );
      const rerolled = rerollReply.text;
      setAvatarEmotion(rerollReply.performance.emotion);
      setAvatarPerformance(rerollReply.performance);
      setBubbles(prev => prev.map(b => b.id === bubble.id ? {
        ...b,
        text: rerolled,
        audioUrl: undefined,
        thinkingChain: rerollReply.thinkingChain,
        performance: rerollReply.performance,
        performanceTimeline: rerollReply.performanceCues,
      } : b));
      if (bubble.dbId) {
        await DB.updateMessage(bubble.dbId, rerolled);
        await DB.updateMessageMetadata(bubble.dbId, (previous: any) => {
          const next = {
            ...(previous || {}),
            avatarPerformance: rerollReply.performance,
            avatarPerformanceCues: rerollReply.performanceCues,
          };
          if (rerollReply.thinkingChain) next.thinkingChain = rerollReply.thinkingChain;
          else delete next.thinkingChain;
          return next;
        });
      }
      addToast('台词已重 roll', 'success');
      runCallMemoryPalaceHook(selectedChar);

      // Synthesize immediately only when automatic call voice is enabled.
      let rerollAudioPlayed = false;
      if (callPreferences.voiceAutoPlay && canSpeakVoice()) {
        try {
          setCallState('speaking');
          const { url: rerollAudioUrl } = await takeOrSynthesizeCallAudio(rerolled, rerollReply.speechEmotion);
          if (rerollAudioUrl) {
            trackBlobUrl(rerollAudioUrl);
            setAudioUrl(rerollAudioUrl);
            setBubbles(prev => prev.map(b => b.id === bubble.id ? { ...b, audioUrl: rerollAudioUrl } : b));
            setTimeout(() => playAudio(rerollAudioUrl, rerollReply.performanceCues, estimateSpeechMs(rerolled)), 0);
            rerollAudioPlayed = true;
          }
        } catch (ttsErr: any) {
          console.warn('[call] reroll TTS failed:', ttsErr?.message);
          addToast('语音合成失败，已保留文本', 'info');
        }
      }
      if (!rerollAudioPlayed && callMode === 'video' && callPreferences.voiceAutoPlay) {
        playSilentAvatarSpeech(rerolled, rerollReply.performanceCues);
      } else {
        setCallState('listening');
      }
    } catch (e: any) {
      setCallState('error');
      addToast(`重 roll 失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setRerollingBubbleId(null);
    }
  };

  // 一段已经开始的通话安静太久时，角色可以自然接话两次。它是独立的显式偏好，
  // 默认关闭；“谁先开口”只决定刚接通时的第一句话。
  const idleNudgeBusyRef = useRef(false);
  const fireIdleNudge = async () => {
    if (!callPreferences.idleNudgeEnabled || idleNudgeBusyRef.current || !selectedChar?.id) return;
    if (document.visibilityState === 'hidden') return;
    idleNudgeBusyRef.current = true;
    try {
      setCallState('thinking');
      const reply = prepareCallAssistantReply(
        await requestAssistantReply(
          '（电话里安静了好一会儿，对方一直没说话。你不是客服，不用干等——像真实通话里那样自然地开口：可以随口说说你这边正在做的事、把刚才的话题往下接一点，或者问问ta是不是在忙。一两句就好，别重复上一句。）',
        ),
        callMode === 'video' && selectedChar?.videoCallPerformanceQuality !== 'high',
      );
      const nudgeTs = Date.now();
      const nudgeBubble: CallBubble = {
        id: `${nudgeTs}-nudge`,
        role: 'assistant',
        text: reply.text,
        time: formatTime(),
        timestamp: nudgeTs,
        thinkingChain: reply.thinkingChain,
        performance: reply.performance,
        performanceTimeline: reply.performanceCues,
      };
      setAvatarEmotion(reply.performance.emotion);
      setAvatarPerformance(reply.performance);
      setBubbles(previous => [...previous, nudgeBubble]);
      idleNudgeCountRef.current += 1;
      const dbId = await DB.saveMessage({
        charId: selectedChar.id,
        role: 'assistant',
        type: 'text',
        content: reply.text,
        metadata: {
          source: 'call',
          callSessionId: currentSessionId,
          ...(reply.thinkingChain ? { thinkingChain: reply.thinkingChain } : {}),
          avatarPerformance: reply.performance,
          avatarPerformanceCues: reply.performanceCues,
        },
      });
      setBubbles(previous => previous.map(bubble => bubble.id === nudgeBubble.id ? { ...bubble, dbId } : bubble));
      markCallTurnDirty();
      runCallMemoryPalaceHook(selectedChar);

      let playbackStarted = false;
      if (callPreferences.voiceAutoPlay && canSpeakVoice()) {
        try {
          const { url } = await takeOrSynthesizeCallAudio(reply.text, reply.speechEmotion);
          if (url) {
            trackBlobUrl(url);
            setAudioUrl(url);
            setBubbles(previous => previous.map(bubble => bubble.id === nudgeBubble.id ? { ...bubble, audioUrl: url } : bubble));
            window.setTimeout(() => playAudio(url, reply.performanceCues, estimateSpeechMs(reply.text)), 0);
            playbackStarted = true;
          }
        } catch {
          // 主动开口拿不到语音时保留文字，并按当前播放偏好降级。
        }
      }
      if (!playbackStarted) {
        if (callMode === 'video' && callPreferences.voiceAutoPlay) {
          playSilentAvatarSpeech(reply.text, reply.performanceCues);
        } else if (callPreferences.voiceAutoPlay) {
          setCallState('speaking');
          const speakingMs = Math.max(1200, Math.min(4200, reply.text.length * 90));
          window.setTimeout(() => setCallState(previous => previous === 'speaking' ? 'listening' : previous), speakingMs);
        } else {
          setCallState('listening');
        }
      }
    } catch {
      setCallState(previous => previous === 'thinking' ? 'listening' : previous);
    } finally {
      idleNudgeBusyRef.current = false;
    }
  };
  useEffect(() => {
    if (!callPreferences.idleNudgeEnabled) return;
    if (viewMode !== 'in-call' || callState !== 'listening' || isAudioPlaying) return;
    if (!bubbles.length || idleNudgeCountRef.current >= 2 || idleNudgeBusyRef.current) return;
    const silenceMs = 50_000 + Math.random() * 30_000 + idleNudgeCountRef.current * 40_000;
    const timer = window.setTimeout(() => { void fireIdleNudge(); }, silenceMs);
    return () => window.clearTimeout(timer);
  }, [viewMode, callState, isAudioPlaying, bubbles, draftInput, callPreferences.idleNudgeEnabled]);

  // 用户在舞台上拖拽/缩放后的构图，写回角色的 videoAvatar 持久化。
  const handleStageFramingChange = (framing: AvatarStageFraming) => {
    if (!selectedChar?.videoAvatar) return;
    updateCharacter(selectedChar.id, { videoAvatar: { ...selectedChar.videoAvatar, framing } });
  };
  // 脸部锚点保存/清除（null = 清除）。
  const handleFaceAnchorChange = (faceFraming: AvatarStageFraming | null) => {
    if (!selectedChar?.videoAvatar) return;
    updateCharacter(selectedChar.id, { videoAvatar: { ...selectedChar.videoAvatar, faceFraming: faceFraming || undefined } });
    addToast(faceFraming ? '脸部锚点已保存，AI 拉近镜头会落到这里' : '脸部锚点已清除', 'success');
  };
  // ── 视频舞台自定义背景：blobref 令牌（本地图片）或 http(s) 图床直链 ──
  const stageBackgroundUrl = useBlobRefUrl(selectedChar?.videoCallBackground);
  // 通话页那层模糊头像画在 CSS background-image 上，吃不到 TokenImg 的解析，这里自己解析一次。
  const blurredAvatarUrl = useBlobRefUrl(selectedChar?.avatar);
  const applyStageBackground = async (value?: string) => {
    if (!selectedChar) return;
    const previous = selectedChar.videoCallBackground;
    updateCharacter(selectedChar.id, { videoCallBackground: value });
    // 背景令牌只被这个字段引用，替换/清除后旧 Blob 直接删掉，不留孤儿
    if (previous && previous !== value) await deleteBlobRef(previous);
  };
  const chooseStageBackgroundFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      try {
        if (file.size > 20 * 1024 * 1024) {
          addToast('图片超过 20 MB，请压缩后再用作背景', 'error');
          return;
        }
        await applyStageBackground(await putImageBlob(file));
        setShowBgPicker(false);
        addToast('视频背景已更新', 'success');
      } catch (error: any) {
        addToast(error?.message || '背景导入失败', 'error');
      } finally {
        removeInput();
      }
    };
    input.click();
  };
  const openBgPicker = () => {
    const current = selectedChar?.videoCallBackground;
    setBgUrlInput(current && !isBlobRef(current) ? current : '');
    setShowBgPicker(true);
  };
  const applyBgUrlInput = async () => {
    const url = bgUrlInput.trim();
    if (!/^https?:\/\//i.test(url)) {
      addToast('请输入 http(s) 开头的图片直链', 'error');
      return;
    }
    await applyStageBackground(url);
    setShowBgPicker(false);
    addToast('视频背景已更新', 'success');
  };

  const avatarImportOverlay = avatarImportStatus ? (
    <div className="sully-stage-dark absolute inset-0 z-[120] flex items-center justify-center bg-[#07050c]/88 px-8 text-center backdrop-blur-xl">
      <div className="max-w-[20rem]">
        <span className="mx-auto mb-4 block h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-violet-300" />
        <div className="text-sm leading-relaxed text-white/85">{avatarImportStatus}</div>
        <div className="mt-3 text-[10px] leading-relaxed text-white/40">包含 8K 贴图的模型首次导入可能需要 10–30 秒。请保持当前页面打开，不要重复点击按钮；完成后会自动进入动作权限页面。</div>
      </div>
    </div>
  ) : null;
  const vroidBetaOverlay = pendingVRoidImport ? (
    <VRoidBetaWarning
      fileName={pendingVRoidImport.file.name}
      projectFile={pendingVRoidImport.projectFile}
      busy={vroidImportBusy}
      onCancel={() => { if (!vroidImportBusy) setPendingVRoidImport(null); }}
      onContinue={pendingVRoidImport.projectFile ? undefined : () => { void confirmVRoidImport(); }}
    />
  ) : null;
  if (viewMode === 'role-select') {
    const groupChars = filterCharactersByGroup(characters, characterGroups, roleGroupId);
    const totalPages = Math.max(1, Math.ceil(groupChars.length / ROLES_PER_PAGE));
    const page = Math.min(rolePage, totalPages - 1);
    const pagedChars = groupChars.slice(page * ROLES_PER_PAGE, page * ROLES_PER_PAGE + ROLES_PER_PAGE);
    return (
      <div className={`relative h-full w-full bg-gradient-to-b text-white flex flex-col overflow-hidden ${lightTheme ? 'sully-call-light from-[#f5f2fd] via-[#eef0f8] to-[#e9ecf5]' : 'from-[#140d28] via-[#0a0613] to-[#05030c]'}`}>
        {lightTheme && <style>{CALL_LIGHT_THEME_CSS}</style>}
        {avatarImportOverlay}
        {vroidBetaOverlay}
        {showCallUpdateAnnouncement && (
          <CallUpdateAnnouncement
            accentColor={accentColor}
            onDismiss={dismissCallUpdateAnnouncement}
            onOpenSettings={openCallPreferencesPanel}
          />
        )}
        {showCallSetupGuide && (
          <CallSetupGuide
            step={callSetupGuideStep}
            characterName={selectedChar?.name || '当前角色'}
            modelName={selectedChar?.videoAvatar?.fileName}
            modelFormat={selectedChar?.videoAvatar?.format}
            avatarSource={selectedVisualSource}
            staticImageName={selectedChar?.companionAvatar?.fileName}
            hasDatePortraits={hasDatePortraits(selectedChar)}
            dateOutfitName={selectedDateOutfit?.name}
            cameraMode={setupCameraMode}
            hasFakeImage={!!fakeUserCameraRef}
            accentColor={accentColor}
            lightTheme={lightTheme}
            onStepChange={setCallSetupGuideStep}
            onChooseModelFile={chooseAvatarModel}
            onChooseLive2DFolder={chooseLive2DDirectory}
            onChooseAvatarSource={chooseVideoAvatarSource}
            onChooseStaticImage={chooseStaticAvatarImage}
            onManageDatePortraits={() => openApp(AppID.Date)}
            onConfigureLive2D={selectedChar?.videoAvatar?.format === 'live2d' ? () => {
              setLive2DWardrobeOnboarding(true);
              setShowLive2DSettings(true);
            } : undefined}
            onCameraModeChange={setSetupCameraMode}
            onChooseFakeImage={() => chooseFakeUserCameraImage(false)}
            onStart={finishCallSetupGuide}
            onClose={closeCallSetupGuide}
          />
        )}
        {showCallPreferences && (
          <CallPreferencesSheet
            preferences={callPreferences}
            accentColor={accentColor}
            lightTheme={lightTheme}
            onChange={next => {
              setCallPreferences(next);
              trackEvent('设置通话偏好', {
                谁先开口: next.characterInitiative ? '角色' : '用户',
                自动生成并播放语音: next.voiceAutoPlay ? '开启' : '关闭',
                沉默后主动接话: next.idleNudgeEnabled ? '开启' : '关闭',
              });
            }}
            onOpenSystemSettings={() => {
              setShowCallPreferences(false);
              openApp(AppID.Settings);
            }}
            onClose={() => setShowCallPreferences(false)}
          />
        )}
        {/* floating sparkles */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {CALL_SPARKLES.map((p, i) => (
            <span key={i} className="absolute rounded-full bg-white animate-pulse"
              style={{ top: p.top, left: p.left, width: p.s, height: p.s, opacity: 0.5, animationDelay: `${i * 0.4}s`, boxShadow: `0 0 6px ${accentColor}` }} />
          ))}
        </div>
        {/* top-right character art bleed */}
        {selectedChar?.avatar && (
          <div className="absolute top-0 right-0 w-48 h-60 pointer-events-none"
            style={{ WebkitMaskImage: 'radial-gradient(135% 105% at 100% 0%, #000 32%, transparent 72%)', maskImage: 'radial-gradient(135% 105% at 100% 0%, #000 32%, transparent 72%)' }}>
            <TokenImg value={selectedChar.avatar} alt="" className="w-full h-full object-cover object-top opacity-60" />
          </div>
        )}

        <div
          className="relative z-10 flex h-full min-h-0 flex-col overflow-hidden px-5"
          style={{
            paddingTop: 'max(2.5rem, var(--safe-top))',
            paddingBottom: 'max(1.25rem, var(--safe-bottom, 0px))',
          }}
        >
          {/* header */}
          <div className="shrink-0">
            <div className="text-[10px] tracking-[0.42em] text-white/35 font-semibold">CHAT WITH</div>
            <h1 className="mt-1 text-[2rem] font-bold leading-tight inline-flex items-start gap-1.5">
              想找谁聊聊？
              <span className="text-sm mt-1" style={{ color: accentColor, textShadow: `0 0 10px ${accentColor}` }}>✦</span>
            </h1>
            <p className="text-sm text-white/45 mt-1">选一个人，拨过去吧。</p>
          </div>

          {/* 分组筛选（没建分组时不渲染） */}
          <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark={!lightTheme}
            value={roleGroupId} onChange={(id) => { setRoleGroupId(id); setRolePage(0); }} className="mt-4 shrink-0" />

          {/* character cards (6 / page) */}
          <div className="mt-4 min-h-[5rem] flex-1 overflow-y-auto overscroll-contain no-scrollbar space-y-2.5 pr-0.5" data-testid="call-character-picker">
            {pagedChars.map(char => {
              const selected = selectedCharId === char.id;
              return (
                <button key={char.id} onClick={() => setSelectedCharId(char.id)}
                  className="relative w-full rounded-3xl px-4 py-3.5 text-left border backdrop-blur-md transition active:scale-[0.99]"
                  style={selected
                    ? { borderColor: accentColor, background: `${accentColor}22`, boxShadow: `0 0 18px ${accentColor}55, inset 0 0 18px ${accentColor}1f` }
                    : { borderColor: 'rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.04)' }}>
                  <div className="flex items-center gap-3.5">
                    <div className="w-12 h-12 rounded-full overflow-hidden border flex items-center justify-center font-semibold shrink-0"
                      style={{ borderColor: selected ? accentColor : 'rgba(255,255,255,0.25)', backgroundColor: `${accentColor}40` }}>
                      {char.avatar ? <TokenImg value={char.avatar} alt={char.name} className="w-full h-full object-cover" /> : (char.name?.[0] || '角')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-[15px] truncate" style={selected ? { color: accentColor } : undefined}>{char.name}</div>
                      <div className="text-xs text-white/45 mt-0.5 truncate">{char.description || '点击编辑设定...'}</div>
                    </div>
                    <span className="text-base shrink-0" style={{ color: selected ? accentColor : 'rgba(255,255,255,0.25)' }}>✦</span>
                  </div>
                </button>
              );
            })}
            {!groupChars.length && (
              <div className="text-center py-10 text-white/40 text-sm">{characters.length ? '该分组下没有角色' : '还没有角色，先去创建一个吧'}</div>
            )}
          </div>

          {/* pagination */}
          {totalPages > 1 && (
            <div className="shrink-0 flex items-center justify-center gap-3 pt-3">
              <button disabled={page === 0} onClick={() => setRolePage(p => Math.max(0, p - 1))}
                className="w-7 h-7 rounded-full border border-white/15 bg-white/[0.04] flex items-center justify-center text-white/70 disabled:opacity-25 active:scale-90 transition">
                <CaretLeft size={14} weight="bold" />
              </button>
              <div className="flex items-center gap-1.5">
                {Array.from({ length: totalPages }).map((_, i) => (
                  <button key={i} onClick={() => setRolePage(i)} aria-label={`第${i + 1}页`}
                    className="rounded-full transition-all" style={{ width: i === page ? 16 : 6, height: 6, background: i === page ? accentColor : 'rgba(255,255,255,0.25)' }} />
                ))}
              </div>
              <button disabled={page >= totalPages - 1} onClick={() => setRolePage(p => Math.min(totalPages - 1, p + 1))}
                className="w-7 h-7 rounded-full border border-white/15 bg-white/[0.04] flex items-center justify-center text-white/70 disabled:opacity-25 active:scale-90 transition">
                <CaretRight size={14} weight="bold" />
              </button>
            </div>
          )}

          {/* actions */}
          <div className="shrink-0 pt-4 space-y-2.5" data-testid="call-role-actions">
            <div className="flex items-center gap-1 rounded-2xl border border-white/10 bg-black/20 p-1">
              <button
                onClick={() => setCallMode('voice')}
                className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium transition ${callMode === 'voice' ? 'bg-white/12 text-white' : 'text-white/40'}`}
              >
                <Phone size={15} weight={callMode === 'voice' ? 'fill' : 'regular'} /> 语音
              </button>
              <button
                onClick={() => setCallMode('video')}
                className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium transition ${callMode === 'video' ? 'bg-white/12 text-white' : 'text-white/40'}`}
                style={callMode === 'video' ? { boxShadow: `inset 0 0 0 1px ${accentColor}55` } : undefined}
              >
                <VideoCamera size={15} weight={callMode === 'video' ? 'fill' : 'regular'} /> 视频
              </button>
            </div>
            {callMode === 'video' && (
              <div className="space-y-2">
                <button
                  onClick={() => openCallSetupGuide('model')}
                  className="w-full flex items-center gap-3 px-1 py-1 text-left transition active:opacity-60"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05]" style={{ color: accentColor }}>
                    <Cube size={15} weight="fill" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] tracking-[0.16em] text-white/35">角色形象 · {selectedVisualSource === 'upload' ? '静态图片' : selectedVisualSource === 'date' ? '见面立绘' : selectedChar?.videoAvatar?.format === 'live2d' ? 'LIVE2D' : selectedChar?.videoAvatar?.format === 'vrm' ? 'VRM' : '未选择'}</span>
                    <span className="mt-0.5 block truncate text-xs text-white/70">{selectedVisualSource === 'upload' ? selectedChar?.companionAvatar?.fileName || 'PNG / GIF' : selectedVisualSource === 'date' ? selectedDateOutfit?.name || '按通话情绪切换表情' : selectedChar?.videoAvatar?.fileName || '动态模型、静态图片或见面立绘'}</span>
                  </span>
                  <span className="text-xs text-white/30">{hasSelectedVideoVisual ? '设置' : '引导'}</span>
                </button>
                <details className="group rounded-2xl border border-white/10 bg-black/15 p-2" data-testid="video-call-advanced-settings">
                  <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl px-2 py-1.5 text-[10px] text-white/42">
                    <span>模型画质、导入与动作排练</span>
                    <span className="transition-transform group-open:rotate-45">＋</span>
                  </summary>
                  <div className="mt-2 space-y-2">
                  {selectedBuiltinSullyAvatar && (
                  <div className="rounded-2xl border border-white/10 bg-black/20 p-2.5" data-testid="builtin-sully-quality-picker">
                    <div className="flex items-center justify-between px-0.5">
                      <span className="text-[10px] tracking-[0.14em] text-white/40">内置模型画质</span>
                      <span className="text-[9px] text-white/28">默认 2K · 省约 48 MB 显存</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                      {([
                        { value: 'balanced' as const, label: '轻量 2K', detail: '推荐' },
                        { value: 'hd' as const, label: '高清 4K', detail: '高性能设备' },
                      ]).map(option => {
                        const active = selectedBuiltinSullyAvatar.builtinQuality === option.value;
                        return (
                          <button
                            key={option.value}
                            onClick={() => chooseBuiltinSullyQuality(option.value)}
                            className={`rounded-xl border px-2 py-2 text-left transition active:scale-[.98] ${active ? 'bg-white/12 text-white' : 'border-white/8 bg-white/[.025] text-white/42'}`}
                            style={active ? { borderColor: `${accentColor}77` } : undefined}
                          >
                            <span className="block text-[10px] font-medium">{option.label}</span>
                            <span className="mt-0.5 block text-[8px] opacity-55">{option.detail}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={chooseAvatarModel} className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] py-1.5 text-[10px] text-white/50 active:scale-[0.98]">
                    <FileZip size={12} weight="bold" /> VRM / L2D ZIP
                  </button>
                  <button onClick={chooseLive2DDirectory} className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] py-1.5 text-[10px] text-white/50 active:scale-[0.98]">
                    <FolderOpen size={12} weight="bold" /> L2D 文件夹
                  </button>
                </div>
                <p className="px-1 text-[9px] leading-relaxed text-white/30">L2D 文件夹：选择包含 *.model3.json 的整个文件夹；不要只选择 model3.json。ZIP：把这个模型文件夹整体压缩后选择 ZIP。</p>
                {selectedChar?.videoAvatar?.format === 'live2d' && (
                  <details className="group border-t border-white/[0.07] pt-2">
                    <summary className="flex cursor-pointer list-none items-center justify-between px-1 py-1 text-[10px] text-white/35">
                      <span>Live2D 高级工具</span>
                      <span className="transition group-open:rotate-45">＋</span>
                    </summary>
                    <button
                      onClick={() => setShowLive2DSettings(true)}
                      className="mt-1 flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2 text-left active:scale-[0.99]"
                    >
                      <span>
                        <span className="block text-[11px] text-white/65">动作权限与参数实验台</span>
                        <span className="mt-0.5 block text-[9px] text-white/28">预览、禁用模型动作，或手动组合参数</span>
                      </span>
                      <Gear size={14} className="text-white/30" />
                    </button>
                  </details>
                )}
                <div className="rounded-2xl border border-white/10 bg-black/20 p-2.5">
                  <div className="flex items-center justify-between px-0.5">
                    <div>
                      <div className="text-[10px] tracking-[0.14em] text-white/40">动作排练</div>
                      <div className="mt-0.5 text-[9px] text-white/25">每个角色单独保存</div>
                    </div>
                    <span className="text-[9px]" style={{ color: selectedChar?.videoCallPerformanceQuality === 'high' ? accentColor : 'rgba(255,255,255,.32)' }}>
                      {selectedChar?.videoCallPerformanceQuality === 'high' ? 'DIRECTOR' : 'BASIC'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    {([
                      { value: 'basic' as const, label: '基础版', detail: '零额外请求' },
                      { value: 'high' as const, label: '高质量版', detail: '副 API 排练' },
                    ]).map(option => {
                      const active = (selectedChar?.videoCallPerformanceQuality || 'basic') === option.value;
                      return (
                        <button
                          key={option.value}
                          onClick={() => {
                            if (!selectedChar) return;
                            updateCharacter(selectedChar.id, { videoCallPerformanceQuality: option.value });
                            addToast(
                              option.value === 'high'
                                ? '已开启高质量动作排练：每轮会多调用一次情绪 Buff API'
                                : '已切换基础动作排练',
                              'success',
                            );
                          }}
                          className="rounded-xl border px-2 py-2 text-left transition active:scale-[0.98]"
                          style={active
                            ? { borderColor: `${accentColor}88`, background: `${accentColor}1f`, boxShadow: `inset 0 0 12px ${accentColor}16` }
                            : { borderColor: 'rgba(255,255,255,.08)', background: 'rgba(255,255,255,.025)' }}
                        >
                          <span className="block text-[11px] font-medium text-white/80">{option.label}</span>
                          <span className="mt-0.5 block text-[8px] text-white/30">{option.detail}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 px-0.5 text-[9px] leading-relaxed text-white/30">
                    高质量版只把本轮定稿台词和角色性格交给情绪 Buff 的 API，不读取聊天上下文；未单独配置副 API 时回退主 API。
                  </p>
                </div>
                  </div>
                </details>
              </div>
            )}
            <button onClick={requestSelectedCall}
              className="relative w-full py-3.5 rounded-2xl overflow-hidden transition active:scale-[0.98]"
              style={{ background: `linear-gradient(to right, ${accentColor}26, ${accentColor}4d, ${accentColor}26)`, border: `1px solid ${accentColor}80`, boxShadow: `0 0 22px ${accentColor}40` }}>
              <span className="absolute inset-[3px] rounded-xl border border-white/10 pointer-events-none" />
              <span className="absolute left-5 top-1/2 -translate-y-1/2 text-xs" style={{ color: accentColor }}>✦</span>
              <span className="absolute right-5 top-1/2 -translate-y-1/2 text-xs text-white/60">✦</span>
              <span className="relative text-white/90 text-[15px]">
                {selectedChar ? <>{callMode === 'video' ? '视频接通 ' : '拨给 '}<span className="font-serif italic text-xl align-baseline" style={{ textShadow: `0 0 12px ${accentColor}` }}>{selectedChar.name}</span></> : '开始通话'}
              </span>
            </button>
            <button onClick={() => { setViewMode('history'); trackEvent('打开通话记录'); }}
              className="relative w-full py-3 rounded-2xl border border-white/15 bg-white/[0.04] backdrop-blur-md text-white/80 flex items-center justify-center gap-2 transition active:scale-[0.98] hover:bg-white/[0.08]">
              <Clock size={16} weight="bold" style={{ color: accentColor }} /> 通话记录
            </button>
            <div className="flex items-center justify-between pt-1">
              <button onClick={openCallPreferencesPanel} title="通话偏好" data-testid="call-preferences-entry"
                className="w-9 h-9 rounded-full border border-white/15 bg-white/[0.04] flex items-center justify-center text-white/60 active:scale-90 transition">
                <Gear size={16} weight="fill" />
              </button>
              <button onClick={closeApp} className="flex items-center gap-2 text-sm text-white/45 active:scale-95 transition">
                <span style={{ color: accentColor }}>✦</span> 关闭 <span style={{ color: accentColor }}>✦</span>
              </button>
              <button onClick={() => setCallTheme(lightTheme ? 'dark' : 'light')} title={lightTheme ? '切换到深色主题' : '切换到浅色主题'}
                className="w-9 h-9 rounded-full border border-white/15 bg-white/[0.04] flex items-center justify-center text-white/60 active:scale-90 transition">
                {lightTheme ? <Moon size={16} weight="fill" /> : <Sun size={16} weight="fill" />}
              </button>
            </div>
          </div>
        </div>
        {showLive2DSettings && selectedChar?.videoAvatar?.format === 'live2d' && (
          <div className="sully-stage-dark" style={{ display: 'contents' }}>
            <Live2DActionSettings
              config={selectedChar.videoAvatar}
              characterName={selectedChar.name}
              accentColor={accentColor}
              setupMode={live2DWardrobeOnboarding ? 'import' : 'advanced'}
              onClose={() => { setShowLive2DSettings(false); setLive2DWardrobeOnboarding(false); }}
              onSave={(config: Live2DAvatarConfig) => {
                updateCharacter(selectedChar.id, { videoAvatar: config });
                setShowLive2DSettings(false);
                setLive2DWardrobeOnboarding(false);
                addToast(`已保存：衣橱 ${config.actions.filter(action => action.wardrobe).length} 套 · AI 可用 ${getLive2DAIActions(config).length} 个动作`, 'success');
              }}
            />
          </div>
        )}
      </div>
    );
  }
  if (viewMode === 'history') {
    return (
      <div className={`h-full w-full bg-gradient-to-b text-white px-5 pb-6 flex flex-col ${lightTheme ? 'sully-call-light from-[#f5f2fd] via-[#eef0f8] to-[#eef0f8]' : 'from-[#140d28] via-[#0a0613] to-[#0a0613]'}`} style={{ paddingTop: 'max(2.5rem, var(--safe-top))' }}>
        {lightTheme && <style>{CALL_LIGHT_THEME_CSS}</style>}
        <div className="flex items-center justify-between">
          <button onClick={() => setViewMode('role-select')} className="text-sm text-white/45">← 返回</button>
          <h1 className="text-lg font-medium">通话记录</h1>
          <button onClick={() => setViewMode('role-select')} className="text-sm font-medium" style={{ color: accentColor }}>新通话</button>
        </div>
        <div className="mt-4 flex-1 overflow-y-auto space-y-3">
          {!callRecords.length && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-base text-white/45">还没有通话记录</p>
              <p className="text-sm text-white/35 mt-1">每一通电话都会留在这里</p>
            </div>
          )}
          {callRecords.map(record => {
            const turnCount = record.transcript.filter(t => t.role === 'user').length;
            const keepsake = summarizeKeepsakeLine(record.transcript, record.characterName);
            return (
            <button key={record.id} onClick={() => { setRecordDetailId(record.id); setViewMode('record-detail'); }} className="w-full rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md p-4 text-left transition hover:bg-white/[0.08]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center text-sm" style={{ backgroundColor: `${accentColor}35` }}>{record.characterName[0] || '角'}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{record.characterName}</div>
                  <div className="text-xs text-white/45 mt-0.5">{record.mode === 'video' ? '视频' : record.mode === 'voice' ? '语音' : '通话'} · {formatDuration(record.durationSec)} · {turnCount}轮对话</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); handleDeleteRecord(record); }} className="text-xs px-2 py-1 rounded-lg text-white/35 transition hover:text-rose-300">删除</button>
              </div>
              <div className="text-xs text-white/60 mt-2.5 italic leading-relaxed line-clamp-2">{keepsake}</div>
              <div className="text-[10px] text-white/30 mt-1.5">{record.createdAt}</div>
            </button>
          );})}
        </div>

        {/* Delete confirm overlay */}
        {deleteConfirmRecord && (
          <div className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-6">
            <div className={`w-full max-w-sm rounded-3xl border border-white/15 bg-gradient-to-b p-5 shadow-2xl ${lightTheme ? 'from-white to-[#f0edf9]' : 'from-[#1a1130] to-[#0a0613]'}`}>
              <div className="text-base font-semibold text-white">删除通话记录？</div>
              <p className="mt-2 text-sm text-white/55 leading-relaxed">和 {deleteConfirmRecord.characterName} 的这通通话将被永久删除。</p>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button onClick={() => setDeleteConfirmRecord(null)} className="py-2.5 rounded-2xl border border-white/20 text-white/80 transition active:scale-[0.97]">取消</button>
                <button onClick={confirmDeleteRecord} className="keep-white py-2.5 rounded-2xl bg-rose-500/80 text-white font-semibold transition active:scale-[0.97]">删除</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
  if (viewMode === 'record-detail' && recordDetail) {
    return (
      <div className={`h-full w-full bg-gradient-to-b text-white px-5 pb-6 flex flex-col ${lightTheme ? 'sully-call-light from-[#f5f2fd] via-[#eef0f8] to-[#eef0f8]' : 'from-[#140d28] via-[#0a0613] to-[#0a0613]'}`} style={{ paddingTop: 'max(2.5rem, var(--safe-top))' }}>
        {lightTheme && <style>{CALL_LIGHT_THEME_CSS}</style>}
        <div className="flex items-center justify-between">
          <button onClick={() => setViewMode('history')} className="text-sm text-white/45">← 返回</button>
          <div className="text-sm text-white/80 font-medium">{recordDetail.characterName}</div>
          <div className="text-xs text-white/35">{recordDetail.mode === 'video' ? '视频 · ' : recordDetail.mode === 'voice' ? '语音 · ' : ''}{formatDuration(recordDetail.durationSec)}</div>
        </div>
        <div className="mt-2 text-center">
          <p className="text-xs text-white/35 italic">{recordDetail.createdAt}</p>
        </div>
        <div className="mt-4 flex-1 overflow-y-auto space-y-2.5">
          {recordDetail.transcript.map(item => (
            <div
              key={item.id}
              onContextMenu={(event) => {
                if (item.role !== 'assistant') return;
                event.preventDefault();
                void openCallVoiceFavorite(item, recordDetail.characterId, recordDetail.characterName);
              }}
              onTouchStart={(event) => {
                if (item.role !== 'assistant') return;
                callLongPressTriggeredRef.current = false;
                callTouchStartPos.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
                longPressTimerRef.current = window.setTimeout(() => {
                  callLongPressTriggeredRef.current = true;
                  void openCallVoiceFavorite(item, recordDetail.characterId, recordDetail.characterName);
                }, 450);
              }}
              onTouchMove={(event) => {
                if (!longPressTimerRef.current) return;
                const dx = Math.abs(event.touches[0].clientX - callTouchStartPos.current.x);
                const dy = Math.abs(event.touches[0].clientY - callTouchStartPos.current.y);
                if (dx > 10 || dy > 10) {
                  window.clearTimeout(longPressTimerRef.current);
                  longPressTimerRef.current = null;
                }
              }}
              onTouchEnd={() => {
                if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
                longPressTimerRef.current = null;
              }}
              className={`rounded-2xl px-3.5 py-2.5 border border-white/10 backdrop-blur-md ${item.role === 'user' ? 'bg-white/[0.07] ml-6' : 'bg-white/[0.03] mr-6'}`}
            >
              <div className="text-[10px] text-white/45">{item.role === 'user' ? '你' : recordDetail.characterName} · {item.time}</div>
              {item.role === 'user' && <CallSnapshotImage imageRef={item.cameraSnapshotRef} expired={item.cameraSnapshotExpired} />}
              <div className="text-sm mt-1 leading-relaxed">{(() => {
                if (item.role !== 'assistant') return item.text;
                const { display, voiceText } = extractVoiceTag(item.text);
                const cleanVoice = stripTtsMarkupForDisplay(voiceText, apiConfig);
                return <>{renderAssistantLine(display, accentColor)}{cleanVoice && <div className="mt-1 text-[10px] text-white/40 italic">{cleanVoice}</div>}</>;
              })()}</div>
              {item.role === 'assistant' && (
                <button
                  onClick={() => {
                    if (callLongPressTriggeredRef.current) { callLongPressTriggeredRef.current = false; return; }
                    void handlePlayBubbleAudio(item);
                    trackEvent('播放通话记录里的语音');
                  }}
                  disabled={!!generatingAudioBubbleId}
                  className="mt-2 text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-white/60 transition hover:bg-white/15 disabled:opacity-40"
                >
                  {generatingAudioBubbleId === item.id ? '生成语音…' : item.audioUrl ? '重播语音' : '播放语音'}
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={() => {
            setSelectedCharId(recordDetail.characterId || selectedCharId);
            resetCurrentCall();
            primeCallAudioFromGesture();
            setCallStartedAt(Date.now());
            setCallState('listening');
            setViewMode('in-call');
            trackEvent('再打一通电话');
          }}
          className="keep-white w-full py-3 rounded-2xl mt-4 font-medium text-white transition active:scale-[0.98]"
          style={{ backgroundColor: accentColor }}
        >再打一通</button>
        <VoiceFavoriteActionSheet
          open={!!voiceFavoriteTarget}
          favorited={voiceFavoriteSaved}
          busy={voiceFavoriteBusy}
          title="通话语音"
          preview={voiceFavoriteTarget ? (stripCallTextFormatting(extractVoiceTag(voiceFavoriteTarget.bubble.text).display) || stripTtsMarkupForDisplay(extractVoiceTag(voiceFavoriteTarget.bubble.text).voiceText, apiConfig)) : ''}
          onToggle={() => void toggleCallVoiceFavorite()}
          onClose={() => { if (!voiceFavoriteBusy) setVoiceFavoriteTarget(null); }}
        />
      </div>
    );
  }
  const waveActive = displayCallState === 'speaking' || displayCallState === 'thinking';
  const connSub = callState === 'connecting' ? '正在建立加密通讯…'
    : callState === 'error' ? '通讯出现波动'
    : '通讯连接稳定';
  const analyzeLabel = displayCallState === 'speaking' ? { cn: '说话中', en: 'SPEAKING' }
    : displayCallState === 'thinking' ? { cn: '思考中', en: 'VOICE ANALYZING' }
    : displayCallState === 'connecting' ? { cn: '接通中', en: 'CONNECTING' }
    : displayCallState === 'error' ? { cn: '连接异常', en: 'SIGNAL ERROR' }
    : { cn: '聆听中', en: 'LISTENING' };
  const latestCallBubble = bubbles[bubbles.length - 1];
  const compactVideoTranscript = callMode === 'video' && videoCallLayout === 'stage' && !videoTranscriptExpanded;
  const videoStageSize = videoCallLayout === 'stage'
    ? 'min-h-0'
    : videoCallLayout === 'mini'
      ? 'h-[clamp(140px,26dvh,230px)] min-h-0'
      : 'h-[clamp(170px,34dvh,300px)] min-h-0';
  const callControlSize = callMode === 'video' ? 'h-10 w-10' : 'h-14 w-14';
  return (
    <div
      className={`h-full w-full relative text-white flex flex-col overflow-hidden ${lightTheme ? 'sully-call-light bg-[#eef0f7]' : 'bg-[#0a0613]'}`}
      data-avatar-touch-pending={pendingAvatarTouchCount}
      data-call-video-layout={callMode === 'video' ? videoCallLayout : undefined}
    >
      {lightTheme && <style>{CALL_LIGHT_THEME_CSS}</style>}
      <style>{`
        @keyframes sully-call-stage-in { from { opacity:0; transform:translateY(10px) scale(.985) } to { opacity:1; transform:translateY(0) scale(1) } }
        @keyframes sully-call-subtitle-in { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        @keyframes sully-camera-emotion-readout { 0% { opacity:0; transform:translate(-50%,6px) } 18%,72% { opacity:.78; transform:translate(-50%,0) } 100% { opacity:0; transform:translate(-50%,-3px) } }
        .sully-video-stage-shell { animation: sully-call-stage-in 420ms cubic-bezier(.2,.8,.2,1) both; transition: height 320ms cubic-bezier(.2,.8,.2,1), min-height 320ms cubic-bezier(.2,.8,.2,1); }
        [data-call-video-layout="stage"] .sully-video-stage-shell { max-height: none; }
        body.ios-keyboard-open [data-call-video-layout="stage"] .sully-video-stage-shell { max-height: 0; }
        @media (prefers-reduced-motion: reduce) { .sully-video-stage-shell, .sully-call-video-subtitle, .sully-camera-emotion-readout { animation-duration:.01ms!important; transition-duration:.01ms!important; } }
      `}</style>
      {avatarImportOverlay}
      {vroidBetaOverlay}
      {/* blurred character art */}
      <div
        className="absolute inset-0 bg-cover bg-center scale-125 blur-3xl opacity-30"
        style={{ backgroundImage: blurredAvatarUrl ? `url(${blurredAvatarUrl})` : undefined }}
      />
      {/* accent aura glows */}
      <div className="absolute -top-28 left-1/2 -translate-x-1/2 w-[130%] h-72 rounded-full blur-3xl opacity-40 pointer-events-none"
        style={{ background: `radial-gradient(closest-side, ${accentColor}, transparent)` }} />
      <div className="absolute -bottom-20 left-1/2 -translate-x-1/2 w-[150%] h-80 rounded-full blur-3xl opacity-25 pointer-events-none"
        style={{ background: `radial-gradient(closest-side, ${accentColor}, transparent)` }} />
      {/* vignette —— 浅色主题换成柔白薄纱，压住模糊头像但不发灰 */}
      <div className={`absolute inset-0 bg-gradient-to-b pointer-events-none ${lightTheme ? 'from-white/60 via-[#f2f0fa]/70 to-white/80' : 'from-black/55 via-[#0a0613]/75 to-black/90'}`} />
      {/* floating sparkles */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {CALL_SPARKLES.map((p, i) => (
          <span key={i} className="absolute rounded-full bg-white animate-pulse"
            style={{ top: p.top, left: p.left, width: p.s, height: p.s, opacity: 0.5, animationDelay: `${i * 0.4}s`, boxShadow: `0 0 6px ${accentColor}` }} />
        ))}
      </div>
      <div className="relative z-10 flex h-full min-h-0 flex-col overflow-hidden">
        {/* 键盘避让不在这里做 paddingBottom 兜底：交给全局 interactive-widget=resizes-content
            与 iOS 全屏 PWA 的 app 高度跟随可视区（见 utils/iosStandalone.ts），和聊天等其它 App 一致。 */}
      {/* top channel bar */}
      <div className="relative shrink-0 px-5" style={{ paddingTop: 'max(2.25rem, var(--safe-top))' }}>
        <div className="absolute left-5 leading-tight" style={{ top: 'max(2.25rem, var(--safe-top))' }}>
          <div className="text-[9px] tracking-[0.28em] text-white/45 font-semibold">{callMode === 'video' ? 'SullyOS·糯米机 · VIDEO DATE' : 'PRIVATE CHANNEL'}</div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[8px] tracking-[0.22em] text-white/35">
            {callMode === 'video' ? 'CHARACTER LINK' : 'VOICE SYNC'}
            <span className="flex items-center gap-[2px] h-2">
              {CALL_WAVE.slice(0, 7).map((h, i) => (
                <span key={i} className="w-[2px] rounded-full bg-white/40" style={{ height: `${waveActive ? Math.max(2, h / 4) : 2}px` }} />
              ))}
            </span>
          </div>
        </div>
        <div className="absolute right-5 flex items-center gap-1 text-[9px] tracking-[0.2em] text-white/45 font-medium" style={{ top: 'max(2.25rem, var(--safe-top))' }}>
          信号良好
          <span className="flex items-end gap-[2px] h-2.5 ml-0.5">
            {[4, 6, 8, 10].map((h, i) => (
              <span key={i} className="w-[2px] rounded-full" style={{ height: `${h}px`, background: i < 3 ? 'rgba(255,255,255,.65)' : accentColor }} />
            ))}
          </span>
          <span style={{ color: accentColor }}>✦</span>
        </div>
        {/* name block */}
        <div className={`${callMode === 'video' ? 'pt-3' : 'pt-7'} text-center`}>
          {callMode !== 'video' && <div className="text-sm" style={{ color: `${accentColor}cc`, textShadow: `0 0 12px ${accentColor}` }}>❀</div>}
          <h1 className={`font-serif leading-none tracking-wide text-white ${callMode === 'video' ? 'text-[1.55rem]' : 'mt-0.5 text-[2.6rem]'}`} style={{ textShadow: `0 0 26px ${accentColor}aa, 0 0 6px ${accentColor}66` }}>{selectedChar?.name || '未选择'}</h1>
          {callMode === 'video' ? (
            <div className="mt-1 flex items-center justify-center gap-2 text-[8px] tracking-[0.18em] text-white/48">
              <span>{connSub}</span><span style={{ color: accentColor }}>◆</span><span className="tabular-nums text-[13px] font-light" style={{ color: accentColor }}>{formatDuration(elapsedSeconds)}</span>
            </div>
          ) : (
            <>
              <div className="mt-2.5 text-[11px] tracking-[0.25em] text-white/55">{connSub}</div>
              <div className="mt-1.5 text-lg tabular-nums font-extralight tracking-[0.2em]" style={{ color: accentColor }}>{formatDuration(elapsedSeconds)}</div>
            </>
          )}
          {callMode === 'video' && (
            <div className="mx-auto mt-1 grid w-[15rem] grid-cols-3 rounded-full border border-white/10 bg-black/25 p-0.5 backdrop-blur-md" data-testid="video-call-layout-picker">
              {VIDEO_CALL_LAYOUTS.map(option => (
                <button
                  key={option.id}
                  onClick={() => chooseVideoCallLayout(option.id)}
                  className={`flex items-center justify-center gap-1 rounded-full py-1 text-[9px] font-medium transition active:scale-95 ${videoCallLayout === option.id ? 'bg-white/14 text-white' : 'text-white/38'}`}
                  title={option.hint}
                >
                  {videoCallLayout === option.id && <Check size={9} weight="bold" style={{ color: accentColor }} />}{option.name}
                </button>
              ))}
            </div>
          )}
          {memoryPalaceStatus && (
            <div className="mt-1 text-[10px] text-white/55 animate-pulse">
              记忆整理 · {memoryPalaceStatus}
            </div>
          )}
        </div>
      </div>
      {/* portrait + aura —— 键盘弹起时（body.ios-keyboard-open）整块收起，把可视区让给消息+输入框，
          避免大头像把输入框顶出键盘上方的可视区（见 index.html 的 .sully-call-hero 规则）。 */}
      {callMode === 'video' ? (
        <div className={`sully-call-hero sully-stage-dark sully-video-stage-shell relative px-2 pb-2 pt-2 ${videoCallLayout === 'stage' ? 'flex-1 min-h-0' : 'shrink-0'} ${videoStageSize}`}>
          <span className="pointer-events-none absolute left-3 top-3 z-20 h-8 w-8 rounded-tl-[1.8rem] border-l border-t" style={{ borderColor: `${accentColor}aa` }} aria-hidden />
          {userCameraMode === 'off' && <span className="pointer-events-none absolute right-3 top-3 z-20 h-8 w-8 rounded-tr-[1.8rem] border-r border-t" style={{ borderColor: `${accentColor}aa` }} aria-hidden />}
          <span className="pointer-events-none absolute bottom-3 left-3 z-20 text-[8px]" style={{ color: accentColor }} aria-hidden>✦</span>
          <span className="pointer-events-none absolute bottom-3 right-3 z-20 text-[7px] text-white/55" aria-hidden>✦</span>
          {/* The action editor owns its own WebGL preview; suspend this one. */}
          <VRMVideoCallStage
            characterName={selectedChar?.name || '未选择'}
            fallbackAvatar={selectedChar?.avatar}
            model={!showLive2DSettings && selectedVisualSource === 'model' ? selectedChar?.videoAvatar : undefined}
            staticAvatarSource={staticVideoAvatarActive ? selectedVisualSource : undefined}
            staticPortraitValue={staticVideoPortrait}
            staticExpressionKey={staticVideoExpressionKey}
            staticSpriteConfig={selectedChar?.spriteConfig}
            motionState={displayCallState}
            emotion={avatarEmotion}
            audioFeed={getAudioFeed()}
            performance={avatarPerformance}
            performanceQuality={selectedChar?.videoCallPerformanceQuality || 'basic'}
            accentColor={accentColor}
            backgroundUrl={stageBackgroundUrl}
            onChooseModel={() => openCallSetupGuide('model')}
            onChooseLive2DFolder={chooseLive2DDirectory}
            onConfigureActions={() => setShowLive2DSettings(true)}
            onConfigureBackground={openBgPicker}
            onFramingChange={handleStageFramingChange}
            onFaceAnchorChange={handleFaceAnchorChange}
            onExpressionsDiscovered={names => { vrmExpressionsRef.current = names; }}
            onAvatarTouch={handleAvatarTouch}
            maxFps={30}
          />
          <AvatarTouchFeedback
            characterName={selectedChar?.name || '对方'}
            accentColor={accentColor}
            effects={avatarTouchEffects}
            lightTheme={lightTheme}
          />
          {userCameraMode !== 'off' && (
            <div className="absolute right-4 top-4 z-30" data-testid="user-camera-preview">
              <div
                className={`${USER_CAMERA_PREVIEW_SIZES.find(option => option.id === userCameraPreviewSize)?.frameClass || USER_CAMERA_PREVIEW_SIZES[1].frameClass} relative overflow-hidden rounded-[1.15rem] border border-white/30 bg-black/45 shadow-[0_14px_38px_rgba(0,0,0,.48)] ring-1 ring-black/20 transition-[width,height] duration-200`}
                data-testid={`user-camera-preview-${userCameraPreviewSize}`}
              >
                {userCameraMode === 'fake'
                  ? fakeUserCameraUrl
                    ? <img src={fakeUserCameraUrl} alt="用户静态画面" className="h-full w-full object-cover" />
                    : <div className="flex h-full w-full items-center justify-center text-[8px] text-white/35">NO IMAGE</div>
                  : <video ref={userCameraVideoRef} muted playsInline autoPlay className="h-full w-full scale-x-[-1] object-cover" />}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/70 to-transparent" aria-hidden />
                <span
                  className={`absolute left-2 top-2 rounded-full border border-white/15 bg-black/50 px-1.5 py-0.5 text-[6px] font-semibold tracking-[0.14em] backdrop-blur-md ${userCameraMode === 'emotion' ? 'text-emerald-200' : userCameraMode === 'snapshot' ? 'text-violet-200' : 'text-white/70'}`}
                >
                  {userCameraMode === 'emotion' ? 'LIVE · YOU' : userCameraMode === 'snapshot' ? 'SNAP · YOU' : 'YOU'}
                </span>
                <div
                  className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 items-center rounded-full border border-white/15 bg-black/55 p-0.5 backdrop-blur-md"
                  data-testid="user-camera-preview-size-picker"
                  aria-label="用户镜头大小"
                >
                  {USER_CAMERA_PREVIEW_SIZES.map(option => (
                    <button
                      key={option.id}
                      type="button"
                      aria-label={`用户镜头${option.label}号`}
                      aria-pressed={userCameraPreviewSize === option.id}
                      data-testid={`user-camera-preview-size-${option.id}`}
                      onClick={() => chooseUserCameraPreviewSize(option.id)}
                      className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[8px] font-medium transition active:scale-90 ${userCameraPreviewSize === option.id ? 'bg-white text-black' : 'text-white/65 hover:bg-white/10'}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          {userCameraMode === 'emotion' && detectedUserEmotion && (
            <div
              key={detectedUserEmotion.nonce}
              className="sully-camera-emotion-readout pointer-events-none absolute bottom-5 left-1/2 z-40 rounded-full border border-white/10 bg-black/45 px-3 py-1 text-[9px] tracking-[0.08em] text-white/60 backdrop-blur-md"
              style={{ animation: 'sully-camera-emotion-readout 2.6s ease-out both' }}
              data-testid="user-camera-emotion-readout"
            >
              识别到情绪 — <span className="text-white/80">{detectedUserEmotion.label}</span>
            </div>
          )}
        </div>
      ) : (
      <div className="sully-call-hero pt-3 pb-1 flex flex-col items-center justify-center">
        <button
          type="button"
          className="relative h-40 w-40 touch-none select-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          aria-label={`戳戳${selectedChar?.name || '对方'}`}
          onPointerDown={handleVoiceAvatarPointerDown}
          onPointerMove={handleVoiceAvatarPointerMove}
          onPointerUp={handleVoiceAvatarPointerUp}
          onPointerCancel={handleVoiceAvatarPointerCancel}
          onClick={event => { if (event.detail === 0) handleVoiceAvatarKeyboardPoke(); }}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <div
            key={`voice-avatar-poke-${voiceAvatarPokeNonce}`}
            className="sully-touch-avatar relative h-full w-full rounded-full"
            style={voiceAvatarPokeNonce
              ? { animation: 'sully-touch-avatar-bounce 420ms cubic-bezier(.2,.9,.3,1) both' }
              : undefined}
          >
            <div className={`absolute -inset-3 rounded-full blur-xl ${waveActive ? 'animate-pulse' : ''}`} style={{ background: `radial-gradient(closest-side, ${accentColor}, transparent)`, opacity: waveActive ? 0.8 : 0.4 }} />
            <div className="absolute -inset-1 rounded-full" style={{ boxShadow: `0 0 0 1px ${accentColor}55, inset 0 0 24px ${accentColor}33` }} />
            <div className={`absolute inset-0 rounded-full border ${displayCallState === 'speaking' ? 'animate-ping' : 'opacity-40'}`} style={{ borderColor: `${accentColor}66` }} />
            {selectedChar?.avatar
              ? <TokenImg value={selectedChar.avatar} alt={selectedChar.name} draggable={false} className="relative z-10 h-full w-full rounded-full object-cover" style={{ boxShadow: `0 0 30px ${accentColor}55` }} />
              : <div className="relative z-10 flex h-full w-full items-center justify-center rounded-full text-4xl font-serif" style={{ backgroundColor: `${accentColor}55` }}>{selectedChar?.name?.[0] || '角'}</div>}
            <AvatarTouchFeedback
              characterName={selectedChar?.name || '对方'}
              accentColor={accentColor}
              effects={avatarTouchEffects}
              lightTheme={lightTheme}
            />
          </div>
        </button>
        {/* analyzing status + waveform */}
        <div className="mt-5 flex flex-col items-center gap-2">
          <div className="text-center leading-tight">
            <div className="text-sm text-white/85">{analyzeLabel.cn}{waveActive ? '…' : ''}</div>
            <div className="text-[9px] tracking-[0.3em] text-white/35 mt-0.5">{analyzeLabel.en}</div>
          </div>
          <div className="flex items-center justify-center gap-[3px] h-7">
            {CALL_WAVE.map((h, i) => (
              <span key={i} className={`w-[3px] rounded-full transition-all duration-300 ${waveActive ? 'animate-pulse' : ''}`}
                style={{ height: `${waveActive ? h : 3}px`, background: `linear-gradient(to top, ${accentColor}33, ${accentColor})`, animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        </div>
      </div>
      )}
      {compactVideoTranscript ? (
        <div
          className="sully-call-video-subtitle mx-3 mb-1.5 flex min-h-[3.7rem] shrink-0 items-center gap-2.5 rounded-[1.2rem] border border-white/14 bg-black/38 px-3 py-2 backdrop-blur-xl"
          style={{ animation: 'sully-call-subtitle-in 240ms ease-out both', boxShadow: `inset 0 1px 0 ${accentColor}35, 0 12px 32px rgba(0,0,0,.22)` }}
          data-testid="video-call-subtitle"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[.06] text-[11px]" style={{ color: accentColor }}>
            {latestCallBubble?.role === 'user' ? '你' : selectedChar?.name?.[0] || '角'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-1.5 text-[8px] font-semibold tracking-[0.15em]" style={{ color: `${accentColor}dd` }}>
              {latestCallBubble?.role === 'user' ? '你刚刚说' : displayCallState === 'thinking' ? '正在想怎么回答' : `${selectedChar?.name || '对方'} · LIVE`}
              {waveActive && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: accentColor }} />}
            </div>
            <div className="line-clamp-2 text-[13px] leading-relaxed text-white/90">
              {latestCallBubble
                ? latestCallBubble.role === 'assistant'
                  ? renderAssistantLine(extractVoiceTag(latestCallBubble.text).display, accentColor)
                  : latestCallBubble.text
                : callState === 'connecting'
                  ? '正在接通，请稍等……'
                  : `${selectedChar?.name || '对方'}在等你开口。`}
            </div>
          </div>
          <button onClick={() => setVideoTranscriptExpanded(true)} className="shrink-0 rounded-full border border-white/12 px-2.5 py-1.5 text-[9px] text-white/52 active:scale-95">记录</button>
        </div>
      ) : (
      <div ref={callScrollableRef} className="flex-1 min-h-0 overflow-y-auto no-scrollbar mx-4 mb-2 px-4 py-3 space-y-3 rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-md" style={{ boxShadow: `inset 0 1px 0 ${accentColor}33` }}>
        {callMode === 'video' && videoCallLayout === 'stage' && videoTranscriptExpanded && (
          <div className="sticky top-0 z-10 -mx-1 flex justify-end pb-1">
            <button onClick={() => setVideoTranscriptExpanded(false)} className="rounded-full border border-white/10 bg-black/35 px-2.5 py-1 text-[9px] text-white/48 backdrop-blur">收成字幕</button>
          </div>
        )}
        {!bubbles.length && (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <p className="text-base text-white/85">电话已接通</p>
            <p className="text-sm text-white/55 mt-2">
              {callState === 'connecting'
                ? `${selectedChar?.name || '对方'}正在接听……`
                : selectedChar?.name ? `${selectedChar.name}在等你开口……` : '对方在等你开口……'}
            </p>
            {callState === 'connecting'
              ? <p className="text-xs text-white/35 mt-4 animate-pulse">请稍等</p>
              : <p className="text-xs text-white/35 mt-4">在下方输入你想说的话</p>}
          </div>
        )}
        {bubbles.map((bubble, index) => {
          const fromBottom = bubbles.length - 1 - index;
          const isLatest = fromBottom === 0;
          const line = bubble.text.trim();
          const opacity = Math.max(0.35, 1 - fromBottom * 0.16);
          const sizeClass = isLatest ? 'text-[15px]' : fromBottom === 1 ? 'text-sm' : 'text-xs';
          return (
          <div
            key={bubble.id}
            onContextMenu={(e) => {
              e.preventDefault();
              if (bubble.role === 'assistant') void openCallVoiceFavorite(bubble);
              else startEditBubble(bubble);
            }}
            onTouchStart={(e) => {
              callLongPressTriggeredRef.current = false;
              callTouchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
              longPressTimerRef.current = window.setTimeout(() => {
                callLongPressTriggeredRef.current = true;
                if (bubble.role === 'assistant') void openCallVoiceFavorite(bubble);
                else startEditBubble(bubble);
              }, 450);
            }}
            onTouchMove={(e) => {
              if (!longPressTimerRef.current) return;
              const dx = Math.abs(e.touches[0].clientX - callTouchStartPos.current.x);
              const dy = Math.abs(e.touches[0].clientY - callTouchStartPos.current.y);
              if (dx > 10 || dy > 10) {
                window.clearTimeout(longPressTimerRef.current);
                longPressTimerRef.current = null;
              }
            }}
            onTouchEnd={() => {
              if (longPressTimerRef.current) { window.clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
            }}
            style={{ opacity }}
            className={`px-1 py-1 ${bubble.role === 'user' ? 'text-right' : ''}`}
          >
            <div className={`text-[10px] text-white/45 mb-1 flex items-center gap-1 ${bubble.role === 'user' ? 'justify-end' : ''}`}>
              {bubble.role !== 'user' && <span className="text-[8px]" style={{ color: accentColor }}>◍</span>}
              <span style={bubble.role !== 'user' ? { color: `${accentColor}dd` } : undefined}>{bubble.role === 'user' ? '你' : selectedChar?.name}</span>
              <span>· {bubble.time}</span>
            </div>
            {bubble.role === 'user' && <CallSnapshotImage imageRef={bubble.cameraSnapshotRef} expired={bubble.cameraSnapshotExpired} compact />}
            <div className={`${sizeClass} whitespace-pre-wrap leading-relaxed ${bubble.role === 'user' ? 'inline-block text-left text-white/90 bg-white/[0.06] border border-white/10 rounded-2xl rounded-tr-sm px-3 py-1.5' : 'text-white/95'}`}>
              {bubble.role === 'assistant' ? (() => {
                const { display, voiceText } = extractVoiceTag(line || bubble.text);
                const cleanVoice = stripTtsMarkupForDisplay(voiceText, apiConfig);
                return <>
                  {bubble.thinkingChain && (
                    <details className="group mb-2 rounded-xl border border-white/10 bg-white/[0.035] px-2.5 py-2 text-[11px] text-white/55">
                      <summary className="cursor-pointer list-none select-none text-[10px] tracking-[0.16em] text-white/45 before:mr-1 before:content-['＋'] group-open:before:content-['－']">心象</summary>
                      <div className="mt-2 whitespace-pre-wrap border-t border-white/8 pt-2 leading-relaxed text-white/60">{bubble.thinkingChain}</div>
                    </details>
                  )}
                  {renderAssistantLine(display, accentColor)}
                  {cleanVoice && <div className="mt-1 text-[11px] text-white/45 italic">{cleanVoice}</div>}
                </>;
              })() : (line || bubble.text)}
            </div>
            {bubble.role === 'assistant' && (
              <div className="mt-2 flex gap-2 flex-wrap">
                <button
                  onClick={() => {
                    if (callLongPressTriggeredRef.current) { callLongPressTriggeredRef.current = false; return; }
                    void handlePlayBubbleAudio(bubble);
                  }}
                  disabled={!!generatingAudioBubbleId}
                  className="text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-white/70 transition hover:bg-white/15 disabled:opacity-40"
                >
                  {generatingAudioBubbleId === bubble.id ? '生成语音…' : bubble.audioUrl ? '重播语音' : '播放语音'}
                </button>
                {bubble.audioUrl && <button onClick={() => handleDownloadCallAudio(bubble.audioUrl, bubble.timestamp)} className="text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-white/70 transition hover:bg-white/15">下载</button>}
                {isLatest && <button onClick={() => handleRerollAssistant(bubble)} disabled={!!rerollingBubbleId} className="text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-white/70 transition hover:bg-white/15 disabled:opacity-40">{rerollingBubbleId === bubble.id ? '换一种说法…' : '换个说法'}</button>}
              </div>
            )}
          </div>
        )})}
        {errorMessage && <div className="text-xs text-rose-300/80 px-1">{errorMessage}</div>}
      </div>
      )}
      {showInputPanel && (
        <div className={`shrink-0 ${callMode === 'video' ? 'px-3 pb-1.5' : 'px-4 pb-2'}`}>
          <div className={`${callMode === 'video' ? 'rounded-[1.15rem] p-1.5' : 'rounded-2xl p-2'} border border-white/12 bg-black/30 backdrop-blur-md flex gap-2 items-center`} style={{ boxShadow: `inset 0 0 20px ${accentColor}1f` }}>
            {sttSupported && (
              <button
                onClick={toggleStt}
                disabled={sendingBusy}
                title={isListening ? '结束语音输入' : '按一下开始说话'}
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition active:scale-90 disabled:opacity-40"
                style={isListening ? { background: '#f0569f', boxShadow: '0 0 14px #f0569f99' } : { background: 'rgba(255,255,255,0.08)' }}
              >
                <Microphone size={18} weight="fill" className={isListening ? 'text-white animate-pulse' : 'text-white/70'} />
              </button>
            )}
            <input
              ref={draftInputRef}
              value={draftInput}
              onChange={(e) => setDraftInput(e.target.value)}
              className="flex-1 min-w-0 bg-transparent px-2 text-sm outline-none placeholder:text-white/35"
              placeholder={isListening ? '在听你说……' : sendingBusy ? `${selectedChar?.name || '对方'}正在想……` : pendingCallRetryText ? '上次回复中断，可直接重试' : `想对${selectedChar?.name || '对方'}说什么？`}
            />
            <button onClick={handleTurn} disabled={sendingBusy} className="keep-white shrink-0 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-40 transition active:scale-95" style={{ backgroundColor: accentColor, boxShadow: `0 0 16px ${accentColor}66` }}>{sendingBusy ? '…' : '发送'}</button>
          </div>
          {!sendingBusy && pendingCallRetryText && !draftInput.trim() && <div className="text-[10px] text-amber-200/70 mt-1 px-1">上一句话还没得到回复，点击重试即可继续</div>}
          {isListening && <div className="text-[10px] text-white/40 mt-1 px-1 animate-pulse">正在聆听，点麦克风结束</div>}
        </div>
      )}
      <div className={`shrink-0 ${callMode === 'video' ? 'px-3 pb-2 pt-0.5' : 'px-7 pb-2 pt-1.5'}`} data-testid={callMode === 'video' ? 'video-call-compact-controls' : undefined}>
        <div
          className={`${callMode === 'video' ? 'grid grid-cols-5 items-center gap-1 rounded-[1.35rem] border border-white/12 bg-black/30 px-1.5 py-1.5 backdrop-blur-xl' : 'flex items-start justify-between'}`}
          style={callMode === 'video' ? { boxShadow: `inset 0 1px 0 ${accentColor}32, 0 14px 32px rgba(0,0,0,.2)` } : undefined}
        >
          {/* mic */}
          <button onClick={() => setShowInputPanel(prev => !prev)} className={`flex flex-col items-center transition active:scale-95 ${callMode === 'video' ? 'gap-0.5' : 'gap-1.5'}`}>
            <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition mx-auto`}
              style={showInputPanel ? { background: `${accentColor}33`, borderColor: `${accentColor}88`, boxShadow: `0 0 18px ${accentColor}55` } : { background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)' }}>
              <Microphone size={22} weight="fill" className="text-white/90" />
            </span>
            <span className="text-[10px] text-white/70">麦克风</span>
            {callMode !== 'video' && <span className="text-[8px] tracking-[0.15em]" style={{ color: showInputPanel ? accentColor : 'rgba(255,255,255,0.3)' }}>{showInputPanel ? 'ON' : 'OFF'}</span>}
          </button>
          {callMode === 'video' && (
            <button onClick={() => setShowUserCameraModePicker(true)} title="选择用户摄像头方式" className="flex flex-col items-center gap-0.5 transition active:scale-95">
              <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition mx-auto`}
                style={userCameraMode !== 'off' ? { background: `${accentColor}33`, borderColor: `${accentColor}88`, boxShadow: `0 0 18px ${accentColor}55` } : { background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)' }}>
                {userCameraMode !== 'off'
                  ? <VideoCamera size={21} weight="fill" className="text-white/90" />
                  : <VideoCameraSlash size={21} weight="fill" className={userCameraLoading ? 'animate-pulse text-white/70' : 'text-white/48'} />}
              </span>
              <span className="text-[10px] text-white/70">{userCameraLoading ? '准备中' : userCameraMode === 'fake' ? '假机位' : userCameraMode === 'emotion' ? '情绪' : userCameraMode === 'snapshot' ? '快照' : '用户画面'}</span>
            </button>
          )}
          {/* translate */}
          <button onClick={() => setShowLangPicker(prev => !prev)} title="语音语种" className={`flex flex-col items-center transition active:scale-95 ${callMode === 'video' ? 'gap-0.5' : 'gap-1.5'}`}>
            <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition mx-auto`}
              style={voiceLang ? { background: `${accentColor}33`, borderColor: `${accentColor}88`, boxShadow: `0 0 18px ${accentColor}55` } : { background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)' }}>
              <Translate size={22} weight="fill" className="text-white/90" />
            </span>
            <span className="text-[10px] text-white/70">翻译</span>
            {callMode !== 'video' && <span className="text-[8px] tracking-[0.15em]" style={{ color: voiceLang ? accentColor : 'rgba(255,255,255,0.3)' }}>{voiceLang ? 'ON' : 'OFF'}</span>}
          </button>
          {/* end call */}
          <button onClick={handleHangup} className={`flex flex-col items-center transition active:scale-95 ${callMode === 'video' ? 'gap-0.5' : 'gap-1.5'}`}>
            <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition hover:bg-rose-500/20 mx-auto`}
              style={{ background: 'rgba(244,63,94,0.12)', borderColor: 'rgba(251,113,133,0.4)' }}>
              <PhoneDisconnect size={22} weight="fill" className="text-rose-300/90" />
            </span>
            <span className="text-[10px] text-white/70">结束通话</span>
          </button>
          {/* speaker */}
          <button
            onClick={() => {
              const next = !isSpeakerOn;
              setIsSpeakerOn(next);
              if (!next && isAudioPlaying) pauseAudio();
              if (next) primeCallAudioFromGesture(true);
            }}
            title={isSpeakerOn ? '外放开启' : '外放关闭'}
            className={`flex flex-col items-center transition active:scale-95 ${callMode === 'video' ? 'gap-0.5' : 'gap-1.5'}`}
          >
            <span className={`${callControlSize} rounded-full border flex items-center justify-center backdrop-blur-md transition mx-auto`}
              style={isSpeakerOn ? { background: `${accentColor}33`, borderColor: `${accentColor}88`, boxShadow: `0 0 18px ${accentColor}55` } : { background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.15)' }}>
              {isSpeakerOn
                ? <SpeakerHigh size={22} weight="fill" className="text-white/90" />
                : <SpeakerSlash size={22} weight="fill" className="text-white/50" />}
            </span>
            <span className="text-[10px] text-white/70">外放</span>
            {callMode !== 'video' && <span className="text-[8px] tracking-[0.15em]" style={{ color: isSpeakerOn ? accentColor : 'rgba(255,255,255,0.3)' }}>{isSpeakerOn ? 'ON' : 'OFF'}</span>}
          </button>
        </div>
      </div>
      {showUserCameraModePicker && callMode === 'video' && (
        <UserCameraModePicker
          mode={userCameraMode}
          busy={userCameraLoading}
          hasFakeImage={!!fakeUserCameraRef}
          accentColor={accentColor}
          lightTheme={lightTheme}
          onSelect={selectUserCameraMode}
          onChooseFakeImage={chooseFakeUserCameraImage}
          onRemoveFakeImage={() => { void removeFakeUserCameraImage(); }}
          onClose={() => { if (!userCameraLoading) setShowUserCameraModePicker(false); }}
        />
      )}
      {showBgPicker && (
        <div className="absolute inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-end" onClick={() => setShowBgPicker(false)}>
          <div className={`w-full border-t border-white/10 rounded-t-3xl p-5 space-y-3 ${lightTheme ? 'bg-[#f6f4fc]' : 'bg-[#120c22]'}`} onClick={e => e.stopPropagation()}>
            <div className="text-sm text-white/80 font-medium">视频背景</div>
            <p className="text-xs text-white/40">本地图片保存在你自己的设备里（IndexedDB，随备份导出）；图床直链则每次在线加载。</p>
            <button onClick={chooseStageBackgroundFile} className="w-full py-2.5 rounded-2xl border border-white/15 bg-white/[0.06] text-sm text-white/85 transition active:scale-[0.98]">
              选择本地图片
            </button>
            <div className="flex gap-2">
              <input
                value={bgUrlInput}
                onChange={e => setBgUrlInput(e.target.value)}
                placeholder="https:// 图片直链"
                className="flex-1 min-w-0 bg-black/30 rounded-xl px-3 py-2.5 text-sm outline-none placeholder:text-white/30 border border-white/10"
              />
              <button onClick={() => void applyBgUrlInput()} className="keep-white shrink-0 px-4 rounded-xl text-sm font-medium text-white transition active:scale-95" style={{ backgroundColor: accentColor }}>使用</button>
            </div>
            {selectedChar?.videoCallBackground && (
              <button onClick={() => { void applyStageBackground(undefined); setShowBgPicker(false); addToast('已恢复默认背景', 'success'); }} className="w-full py-2 text-xs text-white/45 transition active:opacity-60">
                恢复默认背景
              </button>
            )}
          </div>
        </div>
      )}
      {showLangPicker && (
        <div className="absolute inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-end" onClick={() => setShowLangPicker(false)}>
          <div className={`w-full border-t border-white/10 rounded-t-3xl p-5 space-y-3 ${lightTheme ? 'bg-[#f6f4fc]' : 'bg-[#120c22]'}`} onClick={e => e.stopPropagation()}>
            <div className="text-sm text-white/80 font-medium">语音语种</div>
            <p className="text-xs text-white/40">选择后，角色会用中文回复，语音则用对应语种朗读</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {VOICE_LANGUAGE_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => { setVoiceLang(opt.value); if (selectedChar) updateCharacter(selectedChar.id, { callVoiceLang: opt.value }); setShowLangPicker(false); trackEvent('设置通话语音语种', { 语种: voiceLanguageAnalyticsValue(opt.value) }); }}
                  className={`text-xs px-3 py-2 rounded-full font-medium transition-colors text-white ${voiceLang === opt.value ? 'keep-white' : ''}`}
                  style={voiceLang === opt.value ? { backgroundColor: accentColor } : lightTheme ? { background: 'rgba(38,34,57,0.08)' } : { background: 'rgba(255,255,255,0.1)' }}>
                  {opt.label}
                </button>
              ))}
            </div>
            {voiceLang === 'yue' && <p className="text-[10px] text-amber-300/70">{CANTONESE_VOICE_SUPPORT_NOTE}</p>}
          </div>
        </div>
      )}
      {showHangupConfirm && (
        <div className="absolute inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center px-6">
          <div className={`w-full max-w-sm rounded-3xl border border-white/15 bg-gradient-to-b p-5 shadow-2xl ${lightTheme ? 'from-white to-[#f0edf9]' : 'from-[#1a1130] to-[#0a0613]'}`}>
            <div className="text-lg font-semibold text-white">要挂了吗？</div>
            <p className="mt-2 text-sm text-white/65 leading-relaxed">和{selectedChar?.name || '对方'}聊了 {formatDuration(elapsedSeconds)}，这通电话会好好保存下来。</p>
            <div className="mt-5 space-y-2">
              <button onClick={() => {
                setShowHangupConfirm(false);
                if (selectedChar) {
                  suspendCall({
                    charId: selectedChar.id,
                    charName: selectedChar.name,
                    charAvatar: selectedChar.avatar,
                    startedAt: callStartedAt || Date.now(),
                    bubbles,
                    sessionId: currentSessionId,
                    elapsedSeconds,
                    voiceLang,
                    pendingAvatarTouches: pendingAvatarTouchesRef.current,
                  });
                  addToast('通话已挂起，点击顶部绿色条可随时回来', 'success');
                  trackEvent('挂起通话到后台');
                }
              }} className="keep-white w-full py-2.5 rounded-2xl bg-emerald-500/80 text-white font-semibold transition active:scale-[0.97] flex items-center justify-center gap-2">
                <span>先忙别的</span><span className="text-xs opacity-70">（挂起通话）</span>
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setShowHangupConfirm(false)} className="py-2.5 rounded-2xl border border-white/20 text-white/80 transition active:scale-[0.97]">再聊会儿</button>
                <button onClick={finishCall} className="py-2.5 rounded-2xl bg-rose-500/20 border border-rose-300/40 text-rose-200 font-semibold transition active:scale-[0.97]">挂了吧</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {editingBubble && (
        <div className="absolute inset-0 bg-black/60 flex items-end z-50">
          <div className={`w-full border-t border-white/10 p-5 space-y-3 ${lightTheme ? 'bg-[#f6f4fc]' : 'bg-[#120c22]'}`}>
            <div className="text-sm text-white/70">改一下刚才说的话</div>
            <textarea value={editingText} onChange={(e) => setEditingText(e.target.value)} className="w-full h-24 bg-black/30 rounded-xl p-3 text-sm outline-none resize-none placeholder:text-white/30" placeholder="重新措辞……" autoFocus />
            <div className="flex gap-2">
              <button onClick={() => setEditingBubble(null)} className="flex-1 py-2.5 rounded-xl border border-white/15 text-white/70 transition active:scale-[0.97]">算了</button>
              <button onClick={saveEditedBubble} className="keep-white flex-1 py-2.5 rounded-xl font-medium text-white transition active:scale-[0.97]" style={{ backgroundColor: accentColor }}>就这样</button>
            </div>
          </div>
        </div>
      )}
      <VoiceFavoriteActionSheet
        open={!!voiceFavoriteTarget}
        favorited={voiceFavoriteSaved}
        busy={voiceFavoriteBusy}
        title="通话语音"
        preview={voiceFavoriteTarget ? (stripCallTextFormatting(extractVoiceTag(voiceFavoriteTarget.bubble.text).display) || stripTtsMarkupForDisplay(extractVoiceTag(voiceFavoriteTarget.bubble.text).voiceText, apiConfig)) : ''}
        onToggle={() => void toggleCallVoiceFavorite()}
        onClose={() => { if (!voiceFavoriteBusy) setVoiceFavoriteTarget(null); }}
      />
      {showLive2DSettings && selectedChar?.videoAvatar?.format === 'live2d' && (
        <div className="sully-stage-dark" style={{ display: 'contents' }}>
          <Live2DActionSettings
            config={selectedChar.videoAvatar}
            characterName={selectedChar.name}
            accentColor={accentColor}
            setupMode={live2DWardrobeOnboarding ? 'import' : 'advanced'}
            onClose={() => { setShowLive2DSettings(false); setLive2DWardrobeOnboarding(false); }}
            onSave={(config: Live2DAvatarConfig) => {
              updateCharacter(selectedChar.id, { videoAvatar: config });
              setShowLive2DSettings(false);
              setLive2DWardrobeOnboarding(false);
              addToast(`动作库已保存：衣橱 ${config.actions.filter(action => action.wardrobe).length} 套 · AI 可用 ${getLive2DAIActions(config).length} 个动作`, 'success');
            }}
          />
        </div>
      )}
      </div>
    </div>
  );
};
export default CallApp;

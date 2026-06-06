import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Microphone, SpeakerHigh, SpeakerSlash, PhoneDisconnect, Translate } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { safeFetchJson } from '../utils/safeApi';
import { minimaxFetch } from '../utils/minimaxEndpoint';
import { resolveMiniMaxApiKey } from '../utils/minimaxApiKey';
import { hashTtsParams, getCachedTts, saveCachedTts } from '../utils/ttsCache';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { RealtimeContextManager } from '../utils/realtimeContext';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { Message, ChatTheme } from '../types';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
type CallState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error';
type ViewMode = 'role-select' | 'in-call' | 'history' | 'record-detail';
type CallBubble = { id: string; dbId?: number; role: 'user' | 'assistant'; text: string; time: string; audioUrl?: string; timestamp: number };
type CallRecord = {
  id: string;
  characterId: string;
  characterName: string;
  sessionId: string;
  createdAt: string;
  durationSec: number;
  transcript: CallBubble[];
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
const summarizeKeepsakeLine = (transcript: CallBubble[], charName: string) => {
  const assistantLine = [...transcript].reverse().find(item => item.role === 'assistant' && item.text.trim());
  if (!assistantLine) return `这通电话我会悄悄收藏，下次也记得来找我。 —— ${charName}`;
  const normalized = assistantLine.text.replace(/\s+/g, ' ').trim();
  const cutAt = normalized.search(/[。！？!?]/);
  const sentence = cutAt >= 0 ? normalized.slice(0, cutAt + 1) : normalized.slice(0, 42);
  const polished = sentence.length > 48 ? `${sentence.slice(0, 48)}…` : sentence;
  return `“${polished}” —— ${charName}`;
};
const sanitizeAssistantOutput = (raw: string) => {
  if (!raw) return '';
  return raw
    .replace(/^\s*(?:\[\s*通话\s*\]\s*)+/gim, '')
    .replace(/^\s*(?:\[\s*(?:聊天|约会)\s*\]\s*)+/gim, '')
    .replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/gm, '')
    .replace(/^\s*\[?\d{4}[\/-]\d{1,2}[\/-]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\]?\s*/gm, '')
    .replace(/^\s*时间戳[:：].*$/gim, '')
    .trim();
};
/** 中文舞台指示 → MiniMax 语气词标签映射 */
const NARRATION_TO_INTERJECTION: Record<string, string> = {
  '轻笑': '(chuckle)', '笑': '(laughs)', '笑声': '(laughs)', '大笑': '(laughs)',
  '叹气': '(sighs)', '叹息': '(sighs)',
  '咳嗽': '(coughs)', '咳': '(coughs)',
  '清嗓': '(clear-throat)', '清嗓子': '(clear-throat)',
  '呻吟': '(groans)', '哼': '(groans)',
  '换气': '(breath)', '呼吸': '(breath)',
  '喘气': '(pant)', '喘': '(pant)',
  '吸气': '(inhale)', '深吸一口气': '(inhale)',
  '呼气': '(exhale)',
  '倒吸气': '(gasps)', '倒吸一口气': '(gasps)',
  '吸鼻子': '(sniffs)',
  '喷鼻息': '(snorts)',
  '咂嘴': '(lip-smacking)',
  '哼唱': '(humming)',
  '嘶': '(hissing)',
  '嗯': '(emm)', '呃': '(emm)',
  '啧': '(lip-smacking)', '啧啧': '(lip-smacking)',
  '咕噜': '(groans)', '咕噜咕噜': '(groans)',
  '嘟囔': '(emm)', '嘀咕': '(emm)',
  '嘘': '(hissing)', '嘘嘘': '(hissing)',
  '哇': '(gasps)', '哇哦': '(gasps)',
  '嗷': '(groans)', '嗷嗷': '(groans)',
  '呜': '(groans)', '呜呜': '(groans)',
  '嘤': '(groans)', '嘤嘤': '(groans)',
  '噗': '(snorts)', '噗嗤': '(snorts)',
  '啊': '(gasps)',
  '唔': '(emm)',
};
/** 裸拟声词 → 语气词标签（仅处理 TTS 无法自然发音的词，避免误伤正常用词） */
const BARE_ONOMATOPOEIA: [RegExp, string][] = [
  [/啧啧啧/g, '(lip-smacking)'],
  [/啧啧/g, '(lip-smacking)'],
  [/啧/g, '(lip-smacking)'],
  [/咕噜咕噜/g, '(groans)'],
  [/咕噜/g, '(groans)'],
  [/嘤嘤嘤/g, '(groans)'],
  [/嘤嘤/g, '(groans)'],
  [/噗嗤/g, '(snorts)'],
  [/噗/g, '(snorts)'],
  [/嘁/g, '(snorts)'],
  [/嘘—*/g, '(hissing)'],
  [/哼哼/g, '(groans)'],
];
// MiniMax 支持的合法语气标签 — 这些必须保留，不能被当作舞台指示砍掉
const VALID_INTERJECTION_TAGS = new Set([
  'chuckle', 'laughs', 'sighs', 'coughs', 'clear-throat', 'groans',
  'breath', 'pant', 'inhale', 'exhale', 'gasps', 'sniffs', 'snorts',
  'lip-smacking', 'humming', 'hissing', 'emm',
]);
/** 清理 <语音> 标签内的内容：映射中文舞台指示 → 语气标签，删除不认识的括号描述 */
const cleanVoiceTagContent = (voiceText: string): string => {
  if (!voiceText) return '';
  let result = voiceText
    // 中文括号：先尝试映射，映射不到就删
    .replace(/（([^（）\n]{1,48})）/g, (_match, cue: string) => {
      const trimmed = cue.trim();
      if (NARRATION_TO_INTERJECTION[trimmed]) return NARRATION_TO_INTERJECTION[trimmed];
      for (const [key, tag] of Object.entries(NARRATION_TO_INTERJECTION)) {
        if (trimmed.includes(key)) return tag;
      }
      return ''; // 无法映射 → 删除
    })
    // 西文括号：保留合法语气标签，删除其他
    .replace(/\(([^)]{1,80})\)/g, (_match, inner: string) => {
      const tag = inner.trim().toLowerCase();
      if (VALID_INTERJECTION_TAGS.has(tag)) return `(${tag})`;
      return ''; // 不是合法标签 → 删除（如"背景有电流杂音"）
    });
  // 裸拟声词替换
  for (const [pattern, tag] of BARE_ONOMATOPOEIA) {
    result = result.replace(pattern, tag);
  }
  return result.replace(/\s+/g, ' ').trim();
};
const convertNarrationCues = (raw: string) => {
  if (!raw) return '';
  let result = raw
    .replace(/<[语語]音>[\s\S]*?<\/[语語]音>/g, '')
    .replace(/（([^（）\n]{1,48})）/g, (_match, cue: string) => {
      const trimmed = cue.trim();
      // 直接匹配
      if (NARRATION_TO_INTERJECTION[trimmed]) return NARRATION_TO_INTERJECTION[trimmed];
      // 模糊匹配：舞台指示包含关键词
      for (const [key, tag] of Object.entries(NARRATION_TO_INTERJECTION)) {
        if (trimmed.includes(key)) return tag;
      }
      // 无法映射的舞台指示直接删除（避免 TTS 朗读）
      return '';
    });
  // 裸拟声词替换（非括号内的拟声词）
  for (const [pattern, tag] of BARE_ONOMATOPOEIA) {
    result = result.replace(pattern, tag);
  }
  return result.replace(/\s+/g, ' ').trim();
};
/** 为 TTS 文本插入 MiniMax 原生停顿标签 <#秒数#>，让语音有自然停顿
 *  注意：停顿值不宜过大，过大会导致混合声线（timber_weights）在各段产生不同混合效果 */
const insertSpeechBreaks = (text: string): string => {
  if (!text) return '';
  return text
    // 省略号 → 短停顿（思考 / 犹豫）
    .replace(/[…]{1,}/g, '…<#0.15#>')
    .replace(/\.{3,}/g, '...<#0.15#>')
    .replace(/。{2,}/g, '。<#0.15#>')
    // 破折号 → 微停顿（话题转折）
    .replace(/——/g, '——<#0.1#>')
    .replace(/--/g, '--<#0.1#>')
    // 句末标点 → 微停顿（句间呼吸）— 仅中文句号和感叹/问号
    .replace(/([。！？])/g, '$1<#0.08#>')
    // 英文句末标点不加停顿（TTS 自身已有节奏）
    // 分号 → 不加停顿（太细碎）
    // 清理多余的连续停顿标签（避免叠加）
    .replace(/(<#[\d.]+#>[\s]*){2,}/g, (match) => {
      const times = [...match.matchAll(/<#([\d.]+)#>/g)].map(m => parseFloat(m[1]));
      const maxTime = Math.min(Math.max(...times), 0.2);
      return `<#${maxTime}#>`;
    })
    .trim();
};
const VOICE_LANG_OPTIONS = [
  { value: '', label: '默认' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'de', label: 'Deutsch' },
  { value: 'ru', label: 'Русский' },
];
/** 从 AI 回复中提取 <语音>…</语音> 标签内容（兼容繁体 語音） */
const extractVoiceTag = (text: string): { display: string; speech: string; voiceText: string } => {
  const match = text.match(/<[语語]音>([\s\S]*?)<\/[语語]音>/);
  if (!match) return { display: text, speech: '', voiceText: '' };
  const voiceText = match[1].trim();
  const display = text.replace(/<[语語]音>[\s\S]*?<\/[语語]音>/g, '').trim();
  return { display, speech: voiceText, voiceText };
};
const convertHexAudioToBlob = (hexAudio: string, mimeType = 'audio/mpeg'): Blob => {
  const cleanHex = hexAudio.trim().replace(/^0x/i, '');
  if (!cleanHex || cleanHex.length % 2 !== 0 || /[^\da-f]/i.test(cleanHex)) {
    throw new Error('MiniMax 返回的 HEX 音频数据格式异常');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return new Blob([bytes], { type: mimeType });
};
const fetchRemoteAudioBlob = async (sourceUrl: string): Promise<Blob> => {
  const cacheBustedUrl = sourceUrl.includes('?')
    ? `${sourceUrl}&_ts=${Date.now()}`
    : `${sourceUrl}?_ts=${Date.now()}`;
  const response = await fetch(cacheBustedUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`音频下载失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (!blob.size) throw new Error('音频下载为空文件');
  return blob;
};
// Derive the shared TTS cache key from the MiniMax payload. Must match the
// key used by `synthesizeSpeechDetailed` so chat/date/call can reuse each
// other's cached audio when the effective request matches.
const ttsCacheKeyFromPayload = (payload: any): string => hashTtsParams({
  kind: 'minimax-t2a',
  text: payload.text,
  model: payload.model,
  voice_setting: payload.voice_setting,
  timber_weights: payload.timber_weights,
  voice_modify: payload.voice_modify,
  language_boost: payload.language_boost,
  audio_setting: payload.audio_setting,
});
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
const renderAssistantLine = (text: string) => {
  const trimmed = text.trim();
  // Split by narration cues（…）AND newlines, treat cues as block elements
  const parts = trimmed.split(/(（[^（）\n]{1,48}）|\n)/g).filter(Boolean);
  return parts.map((part, idx) => {
    if (part === '\n') return <div key={`br-${idx}`} className="h-2" />;
    const isCue = /^（[^（）\n]{1,48}）$/.test(part);
    if (isCue) return <div key={`cue-${idx}`} className="text-violet-300/95 italic my-1.5 text-[0.85em]">{part}</div>;
    return <React.Fragment key={`t-${idx}`}>{part}</React.Fragment>;
  });
};
const buildCallPrompt = (userName: string, charName?: string, coreContext?: string, voiceLang?: string) => {
  const resolvedCharName = charName || '你的角色';
  const time = RealtimeContextManager.getTimeContext();
  const specialDates = RealtimeContextManager.checkSpecialDates();
  const timeContext = [
    `【当前时间】${time.dateStr} ${time.dayOfWeek} ${time.timeOfDay} ${time.timeStr}`,
    specialDates.length ? `【今日特殊】${specialDates.join('、')}` : '',
  ].filter(Boolean).join('\n');
  const callPrompt = `你是${resolvedCharName}，电话那头是${userName}。
这不是文字，这是一通真正的电话。你能听到对方的呼吸、语气、停顿。你也有自己的呼吸。

### 你正拿着手机贴在耳边

你这会儿在做什么？在哪儿？身边什么声音？
接电话的时候自然地带出来就好——不用刻意交代，但也别假装你只是一个回答问题的接口。
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
“（轻笑）我刚差点把咖啡洒了，你别逗我。”
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

### 舞台指示（给前端用，不要念出来）

偶尔可以加一个简短的括号描述你的状态——（轻笑）（叹气）（压低声音）（沉默了一下）。
最多一条消息一个。不要写成小说旁白：”（我靠在椅背上，嘴角微微上扬，目光看向远方……）”——这不是你会在电话里说的。

### 底线

只输出你在电话里会**说出口**的话。不要输出 [通话]、[聊天]、[约会] 这类系统标记，不要输出时间戳。`;
  const langLabel = voiceLang ? VOICE_LANG_OPTIONS.find(o => o.value === voiceLang)?.label || voiceLang : '';
  const voiceLangPrompt = voiceLang ? `### 语音语种翻译

用户开启了语音语种功能，选择的语种是：${langLabel}（${voiceLang}）。

你的回复格式必须是：
1. 先用中文自然地写出你要说的话（包括舞台指示）
2. 然后换行，在 <语音> 标签里写出这句话的${langLabel}翻译——这才是真正会被读出来的部分

示例：
啊，我知道了（轻笑）
<语音>Ok, I get it</语音>

嘶……你说真的？那也太离谱了吧。
<语音>Wait... are you serious? That's insane.</语音>

要求：
- <语音> 里的翻译要自然口语化，不要机翻味，要符合你的角色性格
- <语音> 里不要包含舞台指示，只写会被朗读的文字
- 每条消息只有一个 <语音> 标签
- 中文部分和 <语音> 部分表达的意思要一致` : '';
  return [coreContext, timeContext, callPrompt, voiceLangPrompt].filter(Boolean).join('\n\n');
};
const getCallStateStyles = (state: CallState) => {
  const map: Record<CallState, { label: string; textClass: string; ringClass: string; waveClass: string }> = {
    idle: { label: '等待中', textClass: 'text-slate-200', ringClass: 'ring-slate-300/35', waveClass: 'bg-slate-300/20' },
    connecting: { label: '接通中……', textClass: 'text-indigo-200', ringClass: 'ring-indigo-300/40', waveClass: 'bg-indigo-300/25' },
    listening: { label: '在听', textClass: 'text-cyan-200', ringClass: 'ring-cyan-300/40', waveClass: 'bg-cyan-200/25' },
    thinking: { label: '在想……', textClass: 'text-amber-200', ringClass: 'ring-amber-300/40', waveClass: 'bg-amber-200/25' },
    speaking: { label: '在说', textClass: 'text-violet-200', ringClass: 'ring-violet-300/40', waveClass: 'bg-violet-200/30' },
    ended: { label: '已挂断', textClass: 'text-rose-200', ringClass: 'ring-rose-300/35', waveClass: 'bg-rose-200/25' },
    error: { label: '断了', textClass: 'text-rose-200', ringClass: 'ring-rose-300/40', waveClass: 'bg-rose-200/30' },
  };
  return map[state];
};
const CallApp: React.FC = () => {
  const { closeApp, characters, activeCharacterId, addToast, apiConfig, userProfile, customThemes, suspendCall, suspendedCall, clearSuspendedCall } = useOS();

  const [viewMode, setViewMode] = useState<ViewMode>('role-select');
  const [selectedCharId, setSelectedCharId] = useState<string>(activeCharacterId || characters[0]?.id || '');
  const [recordDetailId, setRecordDetailId] = useState<string>('');
  const [callState, setCallState] = useState<CallState>('idle');
  const [bubbles, setBubbles] = useState<CallBubble[]>([]);
  const [callRecords, setCallRecords] = useState<CallRecord[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() => `call-${Date.now()}`);
  const [draftInput, setDraftInput] = useState('');
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
  const [showHangupConfirm, setShowHangupConfirm] = useState(false);
  const [deleteConfirmRecord, setDeleteConfirmRecord] = useState<CallRecord | null>(null);
  const [voiceLang, setVoiceLang] = useState('');
  const [showLangPicker, setShowLangPicker] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentBlobUrlRef = useRef<string | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const callTouchStartPos = useRef({ x: 0, y: 0 });
  const selectedChar = useMemo(() => characters.find(c => c.id === selectedCharId) || null, [characters, selectedCharId]);
  const recordDetail = useMemo(() => callRecords.find(r => r.id === recordDetailId) || null, [callRecords, recordDetailId]);
  // 从角色聊天主题中提取强调色，用于通话界面的按钮和高亮
  const accentColor = useMemo(() => {
    const themeId = selectedChar?.bubbleStyle || 'default';
    const theme: ChatTheme | undefined = customThemes?.find((t: ChatTheme) => t.id === themeId) || PRESET_THEMES[themeId];
    return theme?.user?.backgroundColor || '#8b5cf6';
  }, [selectedChar?.bubbleStyle, customThemes]);
  const callScrollableRef = useRef<HTMLDivElement | null>(null);
  const resolveVoiceId = () => selectedChar?.voiceProfile?.voiceId?.trim() || '';
  const resolveModel = () => selectedChar?.voiceProfile?.model?.trim() || 'speech-2.8-hd';
  const resolveGroupId = () => (apiConfig.minimaxGroupId || '').trim();
  const buildTtsExtras = () => {
    const vp = selectedChar?.voiceProfile;
    if (!vp) return {};
    const extras: any = {};
    const tw = vp.timberWeights;
    if (tw && tw.length > 1) {
      extras.timber_weights = (() => {
        const totalWeight = tw.reduce((sum: number, t: any) => sum + (t.weight || 0), 0);
        if (totalWeight === 0) return tw.map((t: any) => ({ voice_id: t.voice_id, weight: Math.round(100 / tw.length) }));
        const raw = tw.map((t: any) => ({ voice_id: t.voice_id, weight: Math.round((t.weight / totalWeight) * 100) }));
        const diff = 100 - raw.reduce((s: number, r: any) => s + r.weight, 0);
        if (diff !== 0) raw[0].weight += diff;
        return raw;
      })();
    }
    if (vp.voiceModify) {
      const vm: any = {};
      // Soft-clamp voice_modify to prevent extreme spikes during excited speech
      const sc = (v: number, limit: number) => {
        if (Math.abs(v) <= limit) return v;
        const sign = v > 0 ? 1 : -1;
        return sign * (limit + Math.log1p(Math.abs(v) - limit) * (limit * 0.15));
      };
      if (vp.voiceModify.pitch) vm.pitch = Math.round(sc(vp.voiceModify.pitch, 40));
      if (vp.voiceModify.intensity) vm.intensity = Math.round(sc(vp.voiceModify.intensity, 30));
      if (vp.voiceModify.timbre) vm.timbre = Math.round(sc(vp.voiceModify.timbre, 40));
      if (vp.voiceModify.sound_effects) vm.sound_effects = vp.voiceModify.sound_effects;
      if (Object.keys(vm).length) extras.voice_modify = vm;
    }
    return extras;
  };
  const resolveVoiceSettingFields = () => {
    const vp = selectedChar?.voiceProfile;
    return {
      // Clamp speed & pitch to safe human-like ranges
      speed: Math.max(0.75, Math.min(1.4, vp?.speed ?? 1)),
      vol: Math.max(0.3, Math.min(2, vp?.vol ?? 1)),
      pitch: Math.max(-8, Math.min(8, vp?.pitch ?? 0)),
      ...(vp?.emotion ? { emotion: vp.emotion } : {}),
    };
  };
  // Resume from suspended call — restore bubbles & session state
  useEffect(() => {
    if (suspendedCall && viewMode === 'role-select') {
      setSelectedCharId(suspendedCall.charId);
      setCallStartedAt(suspendedCall.startedAt);
      if (suspendedCall.bubbles?.length) setBubbles(suspendedCall.bubbles);
      if (suspendedCall.sessionId) setCurrentSessionId(suspendedCall.sessionId);
      if (typeof suspendedCall.elapsedSeconds === 'number') setElapsedSeconds(suspendedCall.elapsedSeconds);
      if (suspendedCall.voiceLang) setVoiceLang(suspendedCall.voiceLang);
      setViewMode('in-call');
      setCallState('listening');
      clearSuspendedCall();
    }
  }, [suspendedCall]);
  useEffect(() => () => {
    if (currentBlobUrlRef.current) {
      URL.revokeObjectURL(currentBlobUrlRef.current);
      currentBlobUrlRef.current = null;
    }
  }, []);
  useEffect(() => {
    if (!callStartedAt || ['idle', 'ended'].includes(callState)) return;
    const timer = window.setInterval(() => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [callStartedAt, callState]);
  useEffect(() => {
    callScrollableRef.current?.scrollTo({ top: callScrollableRef.current.scrollHeight, behavior: 'smooth' });
  }, [bubbles]);
  // 开场白：进入通话后角色自动先开口
  const greetingFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (viewMode !== 'in-call' || bubbles.length > 0) return;
    if (!selectedChar?.id || greetingFiredRef.current === currentSessionId) return;
    greetingFiredRef.current = currentSessionId;
    (async () => {
      try {
        setCallStartedAt(Date.now());
        setCallState('connecting');
        const greetingText = sanitizeAssistantOutput(await requestAssistantReply('（电话刚接通。你先开口——像平时接到这个人电话一样自然地说第一句话。不要解释你在做什么，就是最自然的那个"喂"或者"诶"或者别的什么。）'));
        const nowTs = Date.now();
        const greetingBubble: CallBubble = { id: `${nowTs}-greeting`, role: 'assistant', text: greetingText, time: formatTime(), timestamp: nowTs };
        setCallState('speaking');
        setBubbles([greetingBubble]);
        if (selectedChar?.id) {
          const dbId = await DB.saveMessage({ charId: selectedChar.id, role: 'assistant', type: 'text', content: greetingText, metadata: { source: 'call', callSessionId: currentSessionId } });
          setBubbles(prev => prev.map(b => b.id === greetingBubble.id ? { ...b, dbId: dbId } : b));
        }
        // 尝试语音合成开场白
        const minimaxApiKey = resolveMiniMaxApiKey(apiConfig);
        const voiceId = resolveVoiceId();
        const hasTimberWeights = (selectedChar?.voiceProfile?.timberWeights?.length || 0) > 1;
        let greetingAudioPlayed = false;
        if (isSpeakerOn && minimaxApiKey && (voiceId || hasTimberWeights)) {
          try {
            const groupId = resolveGroupId();
            const { speech: greetingVoiceTag } = extractVoiceTag(greetingText);
            const cleanedGreetingVoice = greetingVoiceTag ? cleanVoiceTagContent(greetingVoiceTag) : '';
            const speechText = insertSpeechBreaks(cleanedGreetingVoice || convertNarrationCues(greetingText));
            const model = resolveModel();
            const ttsPayload: any = {
              model, text: speechText, stream: false, output_format: 'url',
              voice_setting: { voice_id: voiceId, ...resolveVoiceSettingFields() },
              audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
              ...(voiceLang ? { language_boost: voiceLang } : {}),
              ...buildTtsExtras(),
            };
            if (groupId) ttsPayload.group_id = groupId;
            const greetingCacheKey = ttsCacheKeyFromPayload(ttsPayload);
            const cachedGreeting = await getCachedTts(greetingCacheKey);
            let greetingAudioUrl = '';
            if (cachedGreeting) {
              greetingAudioUrl = URL.createObjectURL(cachedGreeting);
            } else {
              const response = await minimaxFetch('/api/minimax/t2a', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${minimaxApiKey}`, 'X-MiniMax-API-Key': minimaxApiKey, ...(groupId ? { 'X-MiniMax-Group-Id': groupId } : {}) },
                body: JSON.stringify(ttsPayload),
              });
              const data = await response.json();
              const rawAudio = data?.data?.audio;
              if (rawAudio && typeof rawAudio === 'string') {
                const normalizedAudio = rawAudio.trim();
                let greetingBlob: Blob | null = null;
                if (/^https?:\/\//i.test(normalizedAudio)) {
                  try { greetingBlob = await fetchRemoteAudioBlob(normalizedAudio); } catch { greetingAudioUrl = normalizedAudio; }
                } else {
                  greetingBlob = convertHexAudioToBlob(normalizedAudio, 'audio/mpeg');
                }
                if (greetingBlob) {
                  greetingAudioUrl = URL.createObjectURL(greetingBlob);
                  saveCachedTts(greetingCacheKey, greetingBlob).catch(() => { /* ignore */ });
                }
              }
            }
            if (greetingAudioUrl) {
              if (greetingAudioUrl.startsWith('blob:')) currentBlobUrlRef.current = greetingAudioUrl;
              setAudioUrl(greetingAudioUrl);
              setBubbles(prev => prev.map(b => b.id === greetingBubble.id ? { ...b, audioUrl: greetingAudioUrl } : b));
              setTimeout(() => playAudio(greetingAudioUrl), 0);
              greetingAudioPlayed = true;
            }
          } catch { /* 语音合成失败不影响文字开场白 */ }
        }
        // 有音频播放时由 audio onEnded 回调切换到 listening；无音频时延迟切换，让用户看到 speaking 状态
        if (!greetingAudioPlayed) {
          setTimeout(() => setCallState('listening'), 1500);
        }
      } catch (e: any) {
        setCallState('error');
        setErrorMessage(e?.message || '开场白生成失败');
      }
    })();
  }, [viewMode, currentSessionId]);
  const stopPlayback = () => {
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
      return {
        id: sessionId,
        sessionId,
        characterId: charId,
        characterName: selectedChar?.name || '未选择角色',
        createdAt: new Date(start).toLocaleString('zh-CN'),
        durationSec: Math.max(1, Math.floor((end - start) / 1000)),
        transcript: msgs.map(m => ({
          id: `db-${m.id}`,
          dbId: m.id,
          role: m.role as 'user' | 'assistant',
          text: m.content,
          audioUrl: m.metadata?.audioUrl,
          time: formatTimeByTs(m.timestamp),
          timestamp: m.timestamp,
        })),
      };
    }).sort((a, b) => (b.transcript[b.transcript.length - 1]?.timestamp || 0) - (a.transcript[a.transcript.length - 1]?.timestamp || 0));
    setCallRecords(records);
  };
  const resetCurrentCall = () => {
    if (currentBlobUrlRef.current) {
      URL.revokeObjectURL(currentBlobUrlRef.current);
      currentBlobUrlRef.current = null;
    }
    stopPlayback();
    setCallState('idle');
    setBubbles([]);
    setDraftInput('');
    setAudioUrl('');
    setTraceId('');
    setErrorMessage('');
    setCallStartedAt(null);
    setElapsedSeconds(0);
    setShowInputPanel(true);
    setCurrentSessionId(`call-${Date.now()}`);
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
  const buildHistoryMessages = async (input: string, skipDbId?: number) => {
    if (!selectedChar?.id) return [{ role: 'user', content: input }];
    const limit = selectedChar.contextLimit || 500;
    const allMsgs = await DB.getRecentMessagesByCharId(selectedChar.id, limit);
    const filtered = allMsgs.filter(m => !(skipDbId && m.id === skipDbId));
    const history = filtered.map(m => {
      const source = m.metadata?.source === 'call' ? '（通话记录）' : m.metadata?.source === 'date' ? '（约会记录）' : '（聊天记录）';
      const content = m.type === 'image'
        ? '[用户发送了一张图片]'
        : m.type === 'emoji'
          ? '[发送了一个表情]'
          : m.content;
      return { role: m.role, content: `[${new Date(m.timestamp).toLocaleString('zh-CN')}] ${source} ${content}` };
    });
    const lastMsg = filtered[filtered.length - 1];
    const timeGapHint = ChatPrompts.getTimeGapHint(lastMsg, Date.now());
    const finalInput = timeGapHint ? `${input}\n\n${timeGapHint}` : input;
    return [...history, { role: 'user', content: finalInput }];
  };
  const requestAssistantReply = async (input: string, skipDbId?: number): Promise<string> => {
    const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
    if (!baseUrl) throw new Error('请先在设置里配置聊天 API URL');
    const userName = userProfile?.name?.trim() || '用户';
    if (selectedChar) {
      const callMsgs = await DB.getMessagesByCharId(selectedChar.id);
      await injectMemoryPalace(selectedChar, callMsgs);
    }
    const systemPrompt = selectedChar
      ? buildCallPrompt(userName, selectedChar.name, ContextBuilder.buildCoreContext(selectedChar, userProfile, true), voiceLang || undefined)
      : buildCallPrompt(userName, selectedChar?.name, undefined, voiceLang || undefined);
    const messages = await buildHistoryMessages(input, skipDbId);
    const chatData = await safeFetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}` },
      body: JSON.stringify({
        model: apiConfig.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.85,
        stream: false,
      }),
    }, 2, 0, { appName: '电话', charId: selectedChar?.id, charName: selectedChar?.name, purpose: '语音通话' });
    const assistantText = chatData?.choices?.[0]?.message?.content?.trim() || '';
    if (!assistantText) throw new Error('文本接口返回为空');
    return assistantText;
  };
  const playAudio = (url?: string) => {
    const targetUrl = url || audioUrl;
    if (!targetUrl || !audioRef.current) return;
    if (audioUrl !== targetUrl) setAudioUrl(targetUrl);
    audioRef.current.src = targetUrl;
    audioRef.current.currentTime = 0;
    audioRef.current.play().catch(() => addToast('音频已生成，自动播放被浏览器拦截，请点击重播', 'info'));
    setCallState('speaking');
  };
  const resumeAudio = () => {
    if (!audioRef.current || !audioUrl) return;
    audioRef.current.play().catch(() => addToast('继续播放失败，请点击重播', 'error'));
  };
  const pauseAudio = () => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    setCallState('listening');
  };
  const handleTurn = async () => {
    const minimaxApiKey = resolveMiniMaxApiKey(apiConfig);
    const voiceId = resolveVoiceId();
    const input = draftInput.trim();
    if (!input) return addToast('说点什么吧', 'info');
    if (['connecting', 'thinking'].includes(callState)) return addToast(`${selectedChar?.name || '对方'}还在想，等一等`, 'info');
    if (isAudioPlaying) pauseAudio();
    const nowTs = Date.now();
    const now = formatTime();
    const userBubble: CallBubble = { id: `${nowTs}-u`, role: 'user', text: input, time: now, timestamp: nowTs };
    setBubbles(prev => [...prev, userBubble]);
    setDraftInput('');
    setShowInputPanel(false);
    let userDbId: number | undefined;
    if (selectedChar?.id) {
      userDbId = await DB.saveMessage({ charId: selectedChar.id, role: 'user', type: 'text', content: input, metadata: { source: 'call', callSessionId: currentSessionId } });
      setBubbles(prev => prev.map(b => (b.id === userBubble.id ? { ...b, dbId: userDbId } : b)));
    }
    if (!callStartedAt) setCallStartedAt(Date.now());
    setCallState('connecting');
    setTraceId('');
    setErrorMessage('');
    let assistantText = '';
    try {
      setCallState('thinking');
      assistantText = sanitizeAssistantOutput(await requestAssistantReply(input, userDbId));
    } catch (err: any) {
      setErrorMessage(err?.message || '文本回复失败');
      setCallState('error');
      return addToast(`文本回复失败：${err?.message || '未知错误'}`, 'error');
    }
    const assistantBubbleId = `${Date.now()}-a`;
    const assistantBubble: CallBubble = { id: assistantBubbleId, role: 'assistant', text: assistantText, time: now, timestamp: nowTs };
    setBubbles(prev => [...prev, assistantBubble]);
    let assistantDbId: number | undefined;
    if (selectedChar?.id) {
      assistantDbId = await DB.saveMessage({ charId: selectedChar.id, role: 'assistant', type: 'text', content: assistantText, metadata: { source: 'call', callSessionId: currentSessionId } });
      setBubbles(prev => prev.map(b => {
        if (b.id === assistantBubbleId) return { ...b, dbId: assistantDbId };
        return b;
      }));
    }
    const hasTimberWeights2 = (selectedChar?.voiceProfile?.timberWeights?.length || 0) > 1;
    if (!isSpeakerOn || !minimaxApiKey || (!voiceId && !hasTimberWeights2)) {
      setCallState('listening');
      if (isSpeakerOn && !voiceId && !hasTimberWeights2) addToast('语音未配置，先用文字聊吧', 'info');
      return;
    }
    try {
      const groupId = resolveGroupId();
      const { speech: voiceTagText } = extractVoiceTag(assistantText);
      const cleanedVoiceTag = voiceTagText ? cleanVoiceTagContent(voiceTagText) : '';
      const speechText = insertSpeechBreaks(cleanedVoiceTag || convertNarrationCues(assistantText));
      const model = resolveModel();
      if (!speechText.trim()) throw new Error('可朗读文本为空');

      const synthesizeChunk = async (chunk: string, idx = 0, total = 1): Promise<{ blob?: Blob; remoteUrl?: string; traceId: string }> => {
        const ttsPayload: any = {
          model,
          text: chunk,
          stream: false,
          output_format: 'url',
          voice_setting: { voice_id: voiceId, ...resolveVoiceSettingFields() },
          audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
          ...(voiceLang ? { language_boost: voiceLang } : {}),
          ...buildTtsExtras(),
        };
        if (groupId) ttsPayload.group_id = groupId;

        const chunkCacheKey = ttsCacheKeyFromPayload(ttsPayload);
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
        assistant_text_length: assistantText.length,
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

      if (currentBlobUrlRef.current) {
        URL.revokeObjectURL(currentBlobUrlRef.current);
        currentBlobUrlRef.current = null;
      }
      if (finalUrl.startsWith('blob:')) currentBlobUrlRef.current = finalUrl;
      setAudioUrl(finalUrl);
      setTimeout(() => playAudio(finalUrl), 0);
      setTraceId(traceIds.filter(Boolean).join(' | '));
      console.log('[call] tts response merged', {
        trace_ids: traceIds,
        playback_url_type: finalUrl.startsWith('blob:') ? 'blob' : 'remote',
      });
      setBubbles(prev => prev.map(b => (b.id === assistantBubbleId ? { ...b, audioUrl: finalUrl } : b)));
      if (assistantDbId) {
        const target = bubbles.find(b => b.id === assistantBubbleId);
        await DB.updateMessage(assistantDbId, target?.text || assistantText);
      }
      setCallState('listening');
    } catch (e: any) {
      setErrorMessage(e?.message || '语音生成失败');
      setCallState('error');
      addToast(`TTS失败：${e?.message || '语音生成失败'}，已保留文本回复`, 'error');
    }
  };
  const sendingBusy = ['connecting', 'thinking'].includes(callState);
  const displayCallState: CallState = isAudioPlaying ? 'speaking' : callState;
  const callStateStyles = getCallStateStyles(displayCallState);
  const latestAssistantAudio = [...bubbles].reverse().find(b => b.role === 'assistant' && b.audioUrl)?.audioUrl;
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
    const ids = all.filter(m => {
      if (m.metadata?.source === 'call' && m.metadata?.callSessionId === record.sessionId) return true;
      if (m.metadata?.source === 'call-end-popup' && m.metadata?.callSessionId === record.sessionId) return true;
      return false;
    }).map(m => m.id);
    if (ids.length) await DB.deleteMessages(ids);
    if (recordDetailId === record.id) {
      setRecordDetailId('');
      setViewMode('history');
    }
    await loadCallRecords(record.characterId);
    addToast('通话记录已删除', 'success');
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
      const rerolled = sanitizeAssistantOutput(await requestAssistantReply(prevUser.text, bubble.dbId));
      setBubbles(prev => prev.map(b => b.id === bubble.id ? { ...b, text: rerolled, audioUrl: undefined } : b));
      if (bubble.dbId) await DB.updateMessage(bubble.dbId, rerolled);
      addToast('台词已重 roll', 'success');

      // Synthesize voice for the rerolled text (same logic as handleTurn)
      const minimaxApiKey = resolveMiniMaxApiKey(apiConfig);
      const voiceId = resolveVoiceId();
      const hasTimberWeights = (selectedChar?.voiceProfile?.timberWeights?.length || 0) > 1;
      if (isSpeakerOn && minimaxApiKey && (voiceId || hasTimberWeights)) {
        try {
          setCallState('speaking');
          const groupId = resolveGroupId();
          const { speech: voiceTagText } = extractVoiceTag(rerolled);
          const cleanedVoiceTag = voiceTagText ? cleanVoiceTagContent(voiceTagText) : '';
          const speechText = insertSpeechBreaks(cleanedVoiceTag || convertNarrationCues(rerolled));
          if (speechText.trim()) {
            const model = resolveModel();
            const ttsPayload: any = {
              model, text: speechText, stream: false, output_format: 'url',
              voice_setting: { voice_id: voiceId, ...resolveVoiceSettingFields() },
              audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
              ...(voiceLang ? { language_boost: voiceLang } : {}),
              ...buildTtsExtras(),
            };
            if (groupId) ttsPayload.group_id = groupId;
            const rerollCacheKey = ttsCacheKeyFromPayload(ttsPayload);
            const cachedReroll = await getCachedTts(rerollCacheKey);
            let rerollAudioUrl = '';
            if (cachedReroll) {
              rerollAudioUrl = URL.createObjectURL(cachedReroll);
            } else {
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
              const rawAudio = data?.data?.audio;
              if (rawAudio && typeof rawAudio === 'string') {
                const normalizedAudio = rawAudio.trim();
                let rerollBlob: Blob | null = null;
                if (/^https?:\/\//i.test(normalizedAudio)) {
                  try { rerollBlob = await fetchRemoteAudioBlob(normalizedAudio); } catch { rerollAudioUrl = normalizedAudio; }
                } else {
                  rerollBlob = convertHexAudioToBlob(normalizedAudio, 'audio/mpeg');
                }
                if (rerollBlob) {
                  rerollAudioUrl = URL.createObjectURL(rerollBlob);
                  saveCachedTts(rerollCacheKey, rerollBlob).catch(() => { /* ignore */ });
                }
              }
            }
            if (rerollAudioUrl) {
              if (currentBlobUrlRef.current) URL.revokeObjectURL(currentBlobUrlRef.current);
              if (rerollAudioUrl.startsWith('blob:')) currentBlobUrlRef.current = rerollAudioUrl;
              setAudioUrl(rerollAudioUrl);
              setBubbles(prev => prev.map(b => b.id === bubble.id ? { ...b, audioUrl: rerollAudioUrl } : b));
              setTimeout(() => playAudio(rerollAudioUrl), 0);
            }
          }
        } catch (ttsErr: any) {
          console.warn('[call] reroll TTS failed:', ttsErr?.message);
          addToast('语音合成失败，已保留文本', 'info');
        }
      }
      setCallState('listening');
    } catch (e: any) {
      setCallState('error');
      addToast(`重 roll 失败：${e?.message || '未知错误'}`, 'error');
    } finally {
      setRerollingBubbleId(null);
    }
  };
  if (viewMode === 'role-select') {
    return (
      <div className="h-full w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white px-5 pt-10 pb-6 flex flex-col">
        <h1 className="text-2xl font-semibold">想找谁聊聊？</h1>
        <p className="text-sm text-slate-400 mt-1">选一个人，拨过去吧。</p>
        <div className="mt-5 space-y-3 flex-1 overflow-y-auto">
          {characters.map(char => (
            <button key={char.id} onClick={() => setSelectedCharId(char.id)} className={`w-full rounded-2xl p-4 border text-left transition ${selectedCharId === char.id ? 'border-white/40' : 'bg-white/5 border-white/15'}`} style={selectedCharId === char.id ? { backgroundColor: `${accentColor}20` } : undefined}>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full border border-white/30 flex items-center justify-center font-semibold" style={{ backgroundColor: `${accentColor}40` }}>{char.avatar ? <img src={char.avatar} alt={char.name} className="w-full h-full rounded-full object-cover" /> : (char.name?.[0] || '角')}</div>
                <div>
                  <div className="font-medium">{char.name}</div>
                  <div className="text-xs text-slate-300 mt-1 line-clamp-2">{char.description || '等你一通电话。'}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="pt-4 space-y-2">
          <button onClick={() => { resetCurrentCall(); setViewMode('in-call'); }} className="w-full py-3 rounded-2xl text-white font-medium transition active:scale-[0.98]" style={{ backgroundColor: accentColor }}>
            {selectedChar ? `拨给 ${selectedChar.name}` : '开始通话'}
          </button>
          <button onClick={() => setViewMode('history')} className="w-full py-3 rounded-2xl border border-white/20 bg-white/5 text-slate-200">通话记录</button>
          <button onClick={closeApp} className="w-full py-2 text-sm text-slate-400">关闭</button>
        </div>
      </div>
    );
  }
  if (viewMode === 'history') {
    return (
      <div className="h-full w-full bg-slate-950 text-white px-5 pt-10 pb-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button onClick={() => setViewMode('role-select')} className="text-sm text-slate-400">← 返回</button>
          <h1 className="text-lg font-medium">通话记录</h1>
          <button onClick={() => setViewMode('role-select')} className="text-sm text-violet-300/80">新通话</button>
        </div>
        <div className="mt-4 flex-1 overflow-y-auto space-y-3">
          {!callRecords.length && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <p className="text-base text-slate-400">还没有通话记录</p>
              <p className="text-sm text-slate-500 mt-1">每一通电话都会留在这里</p>
            </div>
          )}
          {callRecords.map(record => {
            const turnCount = record.transcript.filter(t => t.role === 'user').length;
            const keepsake = summarizeKeepsakeLine(record.transcript, record.characterName);
            return (
            <button key={record.id} onClick={() => { setRecordDetailId(record.id); setViewMode('record-detail'); }} className="w-full rounded-2xl border border-white/10 bg-white/5 p-4 text-left transition hover:bg-white/8">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center text-sm" style={{ backgroundColor: `${accentColor}35` }}>{record.characterName[0] || '角'}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{record.characterName}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{formatDuration(record.durationSec)} · {turnCount}轮对话</div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); handleDeleteRecord(record); }} className="text-xs px-2 py-1 rounded-lg text-slate-500 transition hover:text-rose-300">删除</button>
              </div>
              <div className="text-xs text-slate-300/70 mt-2.5 italic leading-relaxed line-clamp-2">{keepsake}</div>
              <div className="text-[10px] text-slate-500 mt-1.5">{record.createdAt}</div>
            </button>
          );})}
        </div>

        {/* Delete confirm overlay */}
        {deleteConfirmRecord && (
          <div className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-6">
            <div className="w-full max-w-sm rounded-3xl border border-white/20 bg-gradient-to-b from-slate-900 to-slate-950 p-5 shadow-2xl">
              <div className="text-base font-semibold text-white">删除通话记录？</div>
              <p className="mt-2 text-sm text-slate-400 leading-relaxed">和 {deleteConfirmRecord.characterName} 的这通通话将被永久删除。</p>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button onClick={() => setDeleteConfirmRecord(null)} className="py-2.5 rounded-2xl border border-white/20 text-slate-200 transition active:scale-[0.97]">取消</button>
                <button onClick={confirmDeleteRecord} className="py-2.5 rounded-2xl bg-rose-500/80 text-white font-semibold transition active:scale-[0.97]">删除</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
  if (viewMode === 'record-detail' && recordDetail) {
    return (
      <div className="h-full w-full bg-slate-950 text-white px-5 pt-10 pb-6 flex flex-col">
        <div className="flex items-center justify-between">
          <button onClick={() => setViewMode('history')} className="text-sm text-slate-400">← 返回</button>
          <div className="text-sm text-slate-200 font-medium">{recordDetail.characterName}</div>
          <div className="text-xs text-slate-500">{formatDuration(recordDetail.durationSec)}</div>
        </div>
        <div className="mt-2 text-center">
          <p className="text-xs text-slate-500 italic">{recordDetail.createdAt}</p>
        </div>
        <div className="mt-4 flex-1 overflow-y-auto space-y-2.5">
          {recordDetail.transcript.map(item => (
            <div key={item.id} className={`rounded-2xl px-3.5 py-2.5 ${item.role === 'user' ? 'bg-cyan-500/15 ml-6' : 'bg-violet-500/15 mr-6'}`}>
              <div className="text-[10px] text-slate-400">{item.role === 'user' ? '你' : recordDetail.characterName} · {item.time}</div>
              <div className="text-sm mt-1 leading-relaxed">{(() => {
                if (item.role !== 'assistant') return item.text;
                const { display, voiceText } = extractVoiceTag(item.text);
                return <>{display}{voiceText && <div className="mt-1 text-[10px] text-slate-400/60 italic">{voiceText}</div>}</>;
              })()}</div>
              {!!item.audioUrl && <button onClick={() => playAudio(item.audioUrl)} className="mt-2 text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-slate-400 transition hover:bg-white/15">重播语音</button>}
            </div>
          ))}
        </div>
        <button
          onClick={() => {
            setSelectedCharId(recordDetail.characterId || selectedCharId);
            resetCurrentCall();
            setViewMode('in-call');
          }}
          className="w-full py-3 rounded-2xl mt-4 font-medium text-white transition active:scale-[0.98]"
          style={{ backgroundColor: accentColor }}
        >再打一通</button>
      </div>
    );
  }
  return (
    <div className="h-full w-full relative bg-slate-950 text-white flex flex-col overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center scale-125 blur-2xl opacity-35"
        style={{ backgroundImage: selectedChar?.avatar ? `url(${selectedChar.avatar})` : undefined }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-slate-950/70 to-black/85" />
      <div className="relative z-10 flex flex-col h-full">
      <div className="px-4 pt-10 pb-3 border-b border-white/10 flex items-center justify-between">
        <button onClick={handleHangup} className="text-sm text-slate-400">挂断</button>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs" style={{ backgroundColor: `${accentColor}50` }}>{selectedChar?.avatar ? <img src={selectedChar.avatar} alt="" className="w-full h-full rounded-full object-cover" /> : (selectedChar?.name?.[0] || '角')}</div>
          <div className="text-sm">{selectedChar?.name || '未选择角色'}</div>
        </div>
        <div className="text-sm tabular-nums">{formatDuration(elapsedSeconds)}</div>
      </div>
      <div className="px-4 pt-2">
        <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${callStateStyles.textClass} ${callStateStyles.ringClass}`}>
          <span>{callStateStyles.label}</span>
          <div className="flex items-end gap-1 h-3" aria-hidden>
            {[10, 18, 13, 16].map((h, idx) => (
              <span
                key={`${h}-${idx}`}
                className={`w-1 rounded-full ${callStateStyles.waveClass} ${displayCallState === 'speaking' ? 'animate-pulse' : ''}`}
                style={{ height: `${displayCallState === 'speaking' ? h : 6}px`, animationDelay: `${idx * 90}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="pt-4 pb-2 flex flex-col items-center justify-center">
        <div className={`relative w-36 h-36 rounded-full ring-1 ${callStateStyles.ringClass}`}>
          <div className={`absolute inset-0 rounded-full ${callStateStyles.waveClass} ${displayCallState === 'speaking' ? 'animate-ping' : 'opacity-50'}`} />
          <div className={`absolute -inset-4 rounded-full ${callStateStyles.waveClass} ${displayCallState === 'speaking' ? 'animate-pulse' : 'opacity-30'}`} />
          {selectedChar?.avatar ? <img src={selectedChar.avatar} alt={selectedChar.name} className="relative z-10 w-full h-full rounded-full object-cover" /> : <div className="relative z-10 w-full h-full rounded-full flex items-center justify-center text-3xl" style={{ backgroundColor: `${accentColor}60` }}>{selectedChar?.name?.[0] || '角'}</div>}
        </div>
      </div>
      <div ref={callScrollableRef} className="flex-1 overflow-y-auto no-scrollbar px-6 py-2 space-y-3">
        {!bubbles.length && (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <p className="text-base text-slate-300/90">电话已接通</p>
            <p className="text-sm text-slate-400/80 mt-2">
              {callState === 'connecting'
                ? `${selectedChar?.name || '对方'}正在接听……`
                : selectedChar?.name ? `${selectedChar.name}在等你开口……` : '对方在等你开口……'}
            </p>
            {callState === 'connecting'
              ? <p className="text-xs text-slate-500/60 mt-4 animate-pulse">请稍等</p>
              : <p className="text-xs text-slate-500/60 mt-4">在下方输入你想说的话</p>}
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
              startEditBubble(bubble);
            }}
            onTouchStart={(e) => {
              if (bubble.role !== 'user') return;
              callTouchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
              longPressTimerRef.current = window.setTimeout(() => startEditBubble(bubble), 450);
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
            <div className="text-[10px] text-slate-300/80 mb-1">{bubble.role === 'user' ? '你' : selectedChar?.name} · {bubble.time}</div>
            <div className={`${sizeClass} whitespace-pre-wrap leading-relaxed ${bubble.role === 'user' ? 'text-cyan-100/90' : 'text-white'}`}>
              {bubble.role === 'assistant' ? (() => {
                const { display, voiceText } = extractVoiceTag(line || bubble.text);
                return <>
                  {renderAssistantLine(display)}
                  {voiceText && <div className="mt-1 text-[11px] text-slate-300/60 italic">{voiceText}</div>}
                </>;
              })() : (line || bubble.text)}
            </div>
            {isLatest && bubble.role === 'assistant' && (
              <div className="mt-2 flex gap-2">
                {bubble.audioUrl && <button onClick={() => playAudio(bubble.audioUrl)} className="text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-slate-300 transition hover:bg-white/15">重播语音</button>}
                <button onClick={() => handleRerollAssistant(bubble)} disabled={!!rerollingBubbleId} className="text-xs px-2.5 py-1 rounded-full bg-white/8 border border-white/15 text-slate-300 transition hover:bg-white/15 disabled:opacity-40">{rerollingBubbleId === bubble.id ? '换一种说法…' : '换个说法'}</button>
              </div>
            )}
          </div>
        )})}
        {errorMessage && <div className="text-xs text-rose-300/80 px-1">{errorMessage}</div>}
      </div>
      {showInputPanel && (
        <div className="px-4 pb-2">
          <div className="rounded-2xl border border-white/15 bg-black/40 backdrop-blur-sm p-2 flex gap-2">
            <input
              value={draftInput}
              onChange={(e) => setDraftInput(e.target.value)}
              className="flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-slate-500"
              placeholder={sendingBusy ? `${selectedChar?.name || '对方'}正在想……` : `想对${selectedChar?.name || '对方'}说什么？`}
              autoFocus
            />
            <button onClick={handleTurn} disabled={sendingBusy} className="px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-40 transition active:scale-95" style={{ backgroundColor: accentColor }}>{sendingBusy ? '…' : '说'}</button>
          </div>
        </div>
      )}
      <div className="px-5 pb-5 pt-1.5">
        <div className="rounded-3xl border border-white/15 bg-white/8 backdrop-blur-md px-6 py-3 flex items-center justify-between">
          <button onClick={() => setShowInputPanel(prev => !prev)} className={`w-12 h-12 rounded-full border flex items-center justify-center transition ${showInputPanel ? 'bg-emerald-400/25 border-emerald-300/50' : 'bg-white/10 border-white/20'}`}>
            <Microphone size={22} weight="fill" className={showInputPanel ? 'text-emerald-100' : 'text-slate-300'} />
          </button>
          <button
            onClick={() => setShowLangPicker(prev => !prev)}
            className={`w-12 h-12 rounded-full border flex items-center justify-center transition ${voiceLang ? 'bg-amber-400/25 border-amber-300/50' : 'bg-white/10 border-white/20'}`}
            title="语音语种"
          >
            <Translate size={22} weight="fill" className={voiceLang ? 'text-amber-100' : 'text-slate-300'} />
          </button>
          <button
            onClick={() => {
              const next = !isSpeakerOn;
              setIsSpeakerOn(next);
              if (!next && isAudioPlaying) pauseAudio();
            }}
            className={`w-12 h-12 rounded-full border flex items-center justify-center transition ${isSpeakerOn ? 'bg-cyan-400/25 border-cyan-300/50' : 'bg-rose-400/25 border-rose-300/50'}`}
            title={isSpeakerOn ? '静音（不调用语音合成）' : '取消静音'}
          >
            {isSpeakerOn
              ? <SpeakerHigh size={22} weight="fill" className="text-cyan-100" />
              : <SpeakerSlash size={22} weight="fill" className="text-rose-300" />}
          </button>
          <button onClick={handleHangup} className="w-14 h-14 rounded-full bg-rose-400/80 border border-rose-200/60 flex items-center justify-center transition active:scale-95">
            <PhoneDisconnect size={24} weight="fill" className="text-rose-950" />
          </button>
        </div>
      </div>
      <audio
        ref={audioRef}
        src={audioUrl}
        muted={!isSpeakerOn}
        onPlay={() => { setIsAudioPlaying(true); setCallState('speaking'); }}
        onPause={() => { setIsAudioPlaying(false); if (callState === 'speaking') setCallState('listening'); }}
        onEnded={() => { setIsAudioPlaying(false); if (callState === 'speaking') setCallState('listening'); }}
      />
      {showLangPicker && (
        <div className="absolute inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-end" onClick={() => setShowLangPicker(false)}>
          <div className="w-full bg-slate-900 border-t border-white/10 rounded-t-3xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="text-sm text-slate-300 font-medium">语音语种</div>
            <p className="text-xs text-slate-500">选择后，角色会用中文回复，语音则用对应语种朗读</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {VOICE_LANG_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => { setVoiceLang(opt.value); setShowLangPicker(false); }}
                  className={`text-xs px-3 py-2 rounded-full font-medium transition-colors ${voiceLang === opt.value ? 'bg-amber-500 text-white' : 'bg-white/10 text-slate-300 hover:bg-white/15'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {showHangupConfirm && (
        <div className="absolute inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center px-6">
          <div className="w-full max-w-sm rounded-3xl border border-white/20 bg-gradient-to-b from-slate-900 to-slate-950 p-5 shadow-2xl">
            <div className="text-lg font-semibold text-white">要挂了吗？</div>
            <p className="mt-2 text-sm text-slate-300/90 leading-relaxed">和{selectedChar?.name || '对方'}聊了 {formatDuration(elapsedSeconds)}，这通电话会好好保存下来。</p>
            <div className="mt-5 space-y-2">
              <button onClick={() => {
                setShowHangupConfirm(false);
                if (selectedChar) {
                  suspendCall({ charId: selectedChar.id, charName: selectedChar.name, charAvatar: selectedChar.avatar, startedAt: callStartedAt || Date.now(), bubbles, sessionId: currentSessionId, elapsedSeconds, voiceLang });
                  addToast('通话已挂起，点击顶部绿色条可随时回来', 'success');
                }
              }} className="w-full py-2.5 rounded-2xl bg-emerald-500/80 text-white font-semibold transition active:scale-[0.97] flex items-center justify-center gap-2">
                <span>先忙别的</span><span className="text-xs opacity-70">（挂起通话）</span>
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => setShowHangupConfirm(false)} className="py-2.5 rounded-2xl border border-white/20 text-slate-200 transition active:scale-[0.97]">再聊会儿</button>
                <button onClick={finishCall} className="py-2.5 rounded-2xl bg-rose-400/80 text-rose-950 font-semibold transition active:scale-[0.97]">挂了吧</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {editingBubble && (
        <div className="absolute inset-0 bg-black/60 flex items-end z-50">
          <div className="w-full bg-slate-900 border-t border-white/10 p-5 space-y-3">
            <div className="text-sm text-slate-300">改一下刚才说的话</div>
            <textarea value={editingText} onChange={(e) => setEditingText(e.target.value)} className="w-full h-24 bg-black/30 rounded-xl p-3 text-sm outline-none resize-none placeholder:text-slate-600" placeholder="重新措辞……" autoFocus />
            <div className="flex gap-2">
              <button onClick={() => setEditingBubble(null)} className="flex-1 py-2.5 rounded-xl border border-white/15 text-slate-300 transition active:scale-[0.97]">算了</button>
              <button onClick={saveEditedBubble} className="flex-1 py-2.5 rounded-xl font-medium text-white transition active:scale-[0.97]" style={{ backgroundColor: accentColor }}>就这样</button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};
export default CallApp;

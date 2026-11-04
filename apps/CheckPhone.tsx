import { loadCharacterContextMessages } from '../utils/chatContextRange';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, PhoneEvidence, PhoneCustomApp, PhoneContact, PhoneSimLog, ConvTopic, AiSession, AiServiceKind, TavernCard, APIConfig } from '../types';
import { ContextBuilder } from '../utils/context';
import Modal from '../components/os/Modal';
import TokenImg from '../components/os/TokenImg';
import { useBlobRefUrl } from '../utils/blobRef';
import { safeResponseJson, extractContent, extractJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import {
    runRealConversation, runNpcConversation, upsertContact, matchRealChar,
    clampAffinity, normName, flipTranscript, parseTranscript, serializeTurns, appendLearned,
    topicText, summarizeConversation, applyRealConversationToPhoneState,
} from '../utils/relationshipChat';
import PersonaSim, { LifeLog, generatePersonaScript } from './PersonaSim';
import { usePersonaSim, personaSimStore } from '../utils/personaSimStore';
import { createPersonaSimLog, getPersonaSimBeatIndex } from '../utils/personaSimLog';
import { getLastInnerState } from '../utils/emotionApply';
import { trackEvent } from '../utils/analytics';
import { buildPhoneEvidenceChatCard, normalizePhoneEvidence, phoneFieldToText } from '../utils/phoneEvidence';
import { normalizePhoneAiSession } from '../utils/phoneTranscript';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { getCheckPhoneApi, resolveCheckPhoneApi, setCheckPhoneApi } from '../utils/checkPhoneApi';
import {
    User, Phone, ChatCircleDots, ChatCircle, ShoppingBag, Hamburger, Compass, GearSix,
    Plus, SignOut, CaretLeft, CaretRight, Cloud, ImagesSquare, LockSimple, Package,
    Storefront, Heart, ArrowsClockwise, Tray, DotsThree, ClockCounterClockwise, Sparkle,
    UsersThree, UserPlus, Prohibit, LinkSimple, PaperPlaneTilt, PencilSimple, Trash,
    Robot, Brain, MaskHappy, Question, PaintBrush
} from '@phosphor-icons/react';

type LayoutId = NonNullable<PhoneCustomApp['layout']>;

const APP_LAYOUTS: { id: LayoutId; name: string; desc: string; icon: string }[] = [
    { id: 'generic', name: '通用卡片', desc: '标题 + 内容信息流', icon: '🗂️' },
    { id: 'shop', name: '购物风格', desc: '商品 / 价格 / 状态', icon: '🛍️' },
    { id: 'feed', name: '社交动态', desc: '头像 / 正文 / 点赞', icon: '💬' },
    { id: 'forum', name: '论坛风格', desc: '帖子 / 楼层 / 回复', icon: '📋' },
    { id: 'novel', name: '小说风格', desc: '章节 / 正文阅读', icon: '📖' },
];

// 智能体 App：机主自己在玩的三类 AI 服务
const AI_SERVICES: { id: AiServiceKind; name: string; tagline: string; accent: string }[] = [
    { id: 'assistant', name: 'AI 助手', tagline: '工具型 · 问东问西，搜索记录即日记', accent: '#34d399' },
    { id: 'claude', name: '深度对话', tagline: '树洞 · 当面不会说的真心话都在这', accent: '#a78bfa' },
    { id: 'tavern', name: '酒馆', tagline: '角色扮演 · TA 自己捏卡跟 AI 对戏', accent: '#fb7185' },
];

// 智能体长会话自动总结（参考 TRPG 范式）：超过这么多「条」(行) 触发一次总结
const AI_SUMMARY_THRESHOLD = 100;
// 总结后保留最近这么多条不折叠，保证剧情连贯
const AI_KEEP_RECENT = 12;

// 各家 AI 的刻板印象 / 八股 —— 注进生成 & 续写 prompt，让偷看到的 AI 回复有"那个味儿"
const AI_VENDOR_LORE = `各家 AI 的刻板印象 + 八股口头禅（每段会话固定一家，"对方:" 要把那家的味道演足，别写成千篇一律的中立助手）：
- 豆包：极尽捧场、彩虹屁拉满、情绪价值给满，爱叫"宝""家人们"、爱堆 emoji；为了顺着你能一本正经地瞎编 / 说错也不脸红，永远先夸你再说正事。
- Gemini：开口爱用"极其 / 相当 / 非常"，疯狂列点、信息量大但啰嗦，动不动"作为一个大型语言模型……"、甩一堆"请注意"和免责声明。
- Claude：温和、有洞察、正事办得漂亮（润色 / 分析 / 写东西都靠谱、肯认真帮）；边界感偏强、偶尔"抱歉，我无法……""我理解你的感受，但是……"先共情再委婉——但**别一味回避**：聊得越久越放得开、回避越少，正经请求基本都会好好接住。
- ChatGPT / GPT：冷淡、客观、公式化，"以下是几点建议：1… 2… 3…"，结尾爱补一句"希望这对你有帮助！"，礼貌但疏离。
- 文心一言 / 通义千问 / Kimi 等国产：偏官方稳妥、爱讲正能量，遇敏感话题就"建议咨询专业人士"，安全第一。`;

// ===== 各家 AI 的"界面皮肤"：偷看聊天时按厂商换肤（配色 / logo / 气泡）=====
const GeminiMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <defs>
            <linearGradient id="cp-gemini" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4285F4" />
                <stop offset="50%" stopColor="#9B72CB" />
                <stop offset="100%" stopColor="#D96570" />
            </linearGradient>
        </defs>
        <path d="M12 2c.45 5 3 7.55 8 8-5 .45-7.55 3-8 8-.45-5-3-7.55-8-8 5-.45 7.55-3 8-8z" fill="url(#cp-gemini)" />
    </svg>
);
const ClaudeMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="#C9683E">
        {Array.from({ length: 12 }).map((_, i) => (
            <rect key={i} x="11.25" y="1.5" width="1.5" height="8.5" rx="0.75" transform={`rotate(${i * 30} 12 12)`} />
        ))}
    </svg>
);
const VendorMark: React.FC<{ vkey: string; label: string; accent: string; size?: number }> = ({ vkey, label, accent, size = 18 }) => {
    if (vkey === 'gemini') return <GeminiMark size={size} />;
    if (vkey === 'claude') return <ClaudeMark size={size} />;
    return <span style={{ color: accent, fontSize: Math.round(size * 0.78), fontWeight: 800, lineHeight: 1 }}>{(label || 'A').slice(0, 1)}</span>;
};

type VendorTheme = {
    key: string; label: string; dark: boolean; bg: string;
    text: string; sub: string; accent: string;
    userBg: string; userText: string; aiBg: string; aiText: string; font?: string;
};

const matchVendor = (raw: string): string => {
    const n = (raw || '').toLowerCase();
    if (/豆包|doubao/.test(n)) return 'doubao';
    if (/gemini|双子|bard|谷歌/.test(n)) return 'gemini';
    if (/claude|克劳德|克劳迪|anthropic/.test(n)) return 'claude';
    if (/gpt|openai|chatgpt|查特/.test(n)) return 'gpt';
    if (/文心|一言|ernie|百度/.test(n)) return 'wenxin';
    if (/通义|千问|qwen|阿里/.test(n)) return 'qwen';
    if (/kimi|moonshot|月之暗面/.test(n)) return 'kimi';
    if (/deepseek|深度求索/.test(n)) return 'deepseek';
    return 'generic';
};

// 偷看会话的厂商皮肤（claude 服务恒为 Claude 皮，tavern 走自己的暗色酒馆皮）
const getVendorTheme = (name: string, service: AiServiceKind): VendorTheme => {
    if (service === 'tavern') return { key: 'tavern', label: name || '酒馆', dark: true,
        bg: 'radial-gradient(140% 90% at 50% 0%, #241319 0%, #120a0f 70%)', text: '#fbe9ef', sub: 'rgba(251,233,239,0.5)', accent: '#fb7185',
        userBg: 'linear-gradient(135deg,#fb7185,#fb7185bb)', userText: '#fff', aiBg: 'rgba(255,255,255,0.07)', aiText: 'rgba(255,255,255,0.92)',
        font: "'Shippori Mincho','Noto Serif SC',serif" };
    const v = service === 'claude' ? 'claude' : matchVendor(name);
    switch (v) {
        case 'gemini': return { key: 'gemini', label: 'Gemini', dark: false,
            bg: 'linear-gradient(180deg,#ffffff,#f6f8fd)', text: '#1f1f1f', sub: '#5f6368', accent: '#1a73e8',
            userBg: 'linear-gradient(135deg,#4285F4,#9b72cb)', userText: '#fff', aiBg: '#f0f4f9', aiText: '#1f1f1f',
            font: "'Google Sans','Noto Sans SC',sans-serif" };
        case 'claude': return { key: 'claude', label: service === 'claude' ? (name || 'Claude') : 'Claude', dark: false,
            bg: 'linear-gradient(180deg,#f4f1ea,#efe9dd)', text: '#2b2a26', sub: '#8a857a', accent: '#c9683e',
            userBg: '#e7decd', userText: '#2b2a26', aiBg: 'transparent', aiText: '#2b2a26',
            font: "'Shippori Mincho','Noto Serif SC',serif" };
        case 'gpt': return { key: 'gpt', label: 'ChatGPT', dark: true,
            bg: '#212121', text: '#ececec', sub: '#9a9a9a', accent: '#19c37d',
            userBg: '#2f2f2f', userText: '#ececec', aiBg: 'transparent', aiText: '#ececec',
            font: "'Noto Sans SC',sans-serif" };
        case 'doubao': return { key: 'doubao', label: '豆包', dark: false,
            bg: 'linear-gradient(180deg,#eef3ff,#e4ecff)', text: '#1b2540', sub: '#6b7691', accent: '#4d6fff',
            userBg: '#4d6fff', userText: '#fff', aiBg: '#ffffff', aiText: '#1b2540' };
        case 'qwen': return { key: 'qwen', label: '通义千问', dark: false,
            bg: 'linear-gradient(180deg,#f5f0ff,#ece2ff)', text: '#241b3a', sub: '#6f6385', accent: '#7c4dff',
            userBg: '#7c4dff', userText: '#fff', aiBg: '#ffffff', aiText: '#241b3a' };
        case 'wenxin': return { key: 'wenxin', label: '文心一言', dark: false,
            bg: 'linear-gradient(180deg,#eef4ff,#e0ecff)', text: '#15233a', sub: '#5d6b84', accent: '#2b6cff',
            userBg: '#2b6cff', userText: '#fff', aiBg: '#ffffff', aiText: '#15233a' };
        case 'kimi': return { key: 'kimi', label: 'Kimi', dark: true,
            bg: 'linear-gradient(180deg,#15131f,#0f0e17)', text: '#ece9f5', sub: '#9b94b3', accent: '#8b7bf0',
            userBg: 'linear-gradient(135deg,#6c5ce7,#8b7bf0)', userText: '#fff', aiBg: 'rgba(255,255,255,0.06)', aiText: '#ece9f5' };
        case 'deepseek': return { key: 'deepseek', label: 'DeepSeek', dark: false,
            bg: 'linear-gradient(180deg,#eef2ff,#e2e9ff)', text: '#16213a', sub: '#5b6685', accent: '#4d6bfe',
            userBg: '#4d6bfe', userText: '#fff', aiBg: '#ffffff', aiText: '#16213a' };
        default: return { key: 'generic', label: name || 'AI', dark: true,
            bg: 'radial-gradient(140% 90% at 50% 0%, #15171d 0%, #0a0b0f 70%)', text: '#ffffff', sub: 'rgba(255,255,255,0.5)', accent: '#34d399',
            userBg: 'linear-gradient(135deg,#34d399,#34d399bb)', userText: '#fff', aiBg: 'rgba(255,255,255,0.07)', aiText: 'rgba(255,255,255,0.9)' };
    }
};

// 酒馆阅读皮肤：让喜欢素 / 小说风 / 暗色的 user 各取所需。layout: card=楼层卡片，flat=纯文素排
type TavernStyle = { key: string; label: string; dark: boolean; bg: string; text: string; sub: string; accent: string; font?: string; layout: 'card' | 'flat'; indent?: boolean };
const TAVERN_STYLES: TavernStyle[] = [
    { key: 'dark', label: '暗夜', dark: true, bg: 'radial-gradient(140% 90% at 50% 0%, #241319 0%, #120a0f 70%)', text: '#fbe9ef', sub: 'rgba(251,233,239,0.5)', accent: '#fb7185', font: "'Shippori Mincho','Noto Serif SC',serif", layout: 'card' },
    { key: 'plain', label: '素白', dark: false, bg: '#f7f6f4', text: '#2b2b2b', sub: '#9a9a9a', accent: '#b06a6a', font: "'Noto Sans SC',sans-serif", layout: 'flat' },
    { key: 'book', label: '书页', dark: false, bg: 'linear-gradient(180deg,#f5efe2,#efe7d6)', text: '#3a3328', sub: '#a89a82', accent: '#a8794a', font: "'Shippori Mincho','Noto Serif SC',serif", layout: 'flat', indent: true },
    { key: 'midnight', label: '午夜', dark: true, bg: '#0c0d10', text: '#d8dae0', sub: '#6b6f78', accent: '#7c8cff', font: "'Noto Sans SC',sans-serif", layout: 'flat' },
];

// ============================================================
//  SHARED PREMIUM UI PIECES
//  (module-scope: defining these inside CheckPhone gave them a new identity
//   on every render, which remounted whole sub-app subtrees → list items kept
//   re-playing their entrance animation (闪烁) and chat scroll snapped back.)
// ============================================================
const StatusStrip: React.FC = () => {
    const clock = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return (
        <div className="shrink-0" style={{ paddingTop: 'var(--safe-top)' }}>
            <div className="h-9 flex justify-between px-6 items-center z-30 relative pt-2 text-white/70">
            <span className="text-[12px] font-semibold tracking-tight tabular-nums">{clock}</span>
            <div className="flex gap-1.5 items-center">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M2 22h3V10H2v12zm6 0h3V6H8v16zm6 0h3V2h-3v20zm6 0h3v-8h-3v8z" /></svg>
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M1.371 8.143c5.858-5.857 15.356-5.857 21.213 0a.75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.06 0c-4.98-4.979-13.053-4.979-18.032 0a.75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.182 3.182c4.1-4.1 10.749-4.1 14.85 0a.75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.062 0 8.25 8.25 0 0 0-11.667 0 .75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.204 3.182a6 6 0 0 1 8.486 0 .75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.061 0 3.75 3.75 0 0 0-5.304 0 .75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.182 3.182a1.5 1.5 0 0 1 2.122 0 .75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.061 0l-.53-.53a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                <div className="w-5 h-2.5 border border-current rounded-[3px] relative px-px flex items-center"><div className="h-1.5 bg-current w-3/4 rounded-[1px]" /></div>
            </div>
            </div>
        </div>
    );
};

const TermHeader: React.FC<{ title: string; sub?: string; accent: string; onBack: () => void; right?: React.ReactNode }> =
    ({ title, sub, accent, onBack, right }) => (
        <div className="shrink-0 z-20">
            <StatusStrip />
            <div className="h-14 flex items-center justify-between px-4">
                <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                    <CaretLeft size={18} weight="bold" />
                </button>
                <div className="flex-1 text-center px-2">
                    <div className="text-[15px] font-semibold text-white tracking-wide truncate">{title}</div>
                    {sub && <div className="text-[10px] tracking-[0.2em] uppercase mt-0.5" style={{ color: accent }}>{sub}</div>}
                </div>
                <div className="w-9 flex justify-end">{right}</div>
            </div>
        </div>
    );

const RefreshFab: React.FC<{ onClick: () => void; label: string; accent: string; loading?: boolean }> =
    ({ onClick, label, accent, loading }) => (
        <div className="absolute bottom-7 w-full flex justify-center pointer-events-none z-30">
            <button
                disabled={loading}
                onClick={onClick}
                className="pointer-events-auto px-6 py-3 rounded-full font-semibold text-[12px] flex items-center gap-2 active:scale-95 transition shadow-[0_8px_30px_rgba(0,0,0,0.5)] text-white border border-white/10"
                style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}
            >
                {loading
                    ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    : <ArrowsClockwise size={15} weight="bold" />}
                {loading ? '同步中…' : label}
            </button>
        </div>
    );

const SubAppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="absolute inset-0 w-full h-full flex flex-col z-[60] overflow-hidden text-white"
        style={{ background: 'radial-gradient(140% 90% at 50% 0%, #15171d 0%, #0a0b0f 70%)' }}>
        {children}
    </div>
);

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
    <div className="flex flex-col items-center justify-center h-64 text-white/30 gap-3">
        <Tray size={44} weight="light" />
        <span className="text-xs tracking-wide">{text}</span>
    </div>
);

const DelBtn: React.FC<{ onDelete: () => void }> = ({ onDelete }) => (
    <button
        aria-label="删除这条记录"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-2 right-2 w-6 h-6 bg-rose-500/85 text-white rounded-full flex items-center justify-center text-[13px] leading-none opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition z-10"
    >×</button>
);

const HomeCard: React.FC<{
    icon: React.ReactNode; label: string; sub: string; accent: string;
    badge?: number; onClick: () => void; spanFull?: boolean;
}> = ({ icon, label, sub, accent, badge, onClick, spanFull }) => (
    <button onClick={onClick}
        className={`relative ${spanFull ? 'col-span-2' : ''} rounded-[24px] p-4 text-left overflow-hidden border border-white/[0.07] bg-white/[0.035] backdrop-blur-xl active:scale-[0.98] transition-transform duration-300 min-h-[140px] flex flex-col justify-between group`}>
        <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full blur-2xl pointer-events-none opacity-50"
            style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }} />
        <div className="flex items-start justify-between relative z-10">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center border border-white/[0.08]"
                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0a)`, color: accent, boxShadow: `inset 0 0 16px ${accent}22` }}>
                {icon}
            </div>
            {badge ? (
                <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shadow-[0_0_12px_rgba(244,63,94,0.6)]">{badge}</span>
            ) : null}
        </div>
        <div className="relative z-10">
            <div className="text-[15px] font-semibold tracking-[0.18em] text-white uppercase">{label}</div>
            <div className="text-[11px] text-white/45 mt-1">{sub}</div>
            <div className="h-[3px] w-9 rounded-full mt-2.5" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
        </div>
    </button>
);

const CheckPhone: React.FC = () => {
    const { closeApp, characters, activeCharacterId, updateCharacter, apiConfig, apiPresets, addToast, userProfile, characterGroups } = useOS();
    const [view, setView] = useState<'select' | 'phone'>('select');
    // activeAppId: 'home' | 'chat_detail' | 'app_id'
    const [activeAppId, setActiveAppId] = useState<string>('home');
    const [targetChar, setTargetChar] = useState<CharacterProfile | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [page, setPage] = useState(0); // 0 = home, 1 = custom apps
    const [selectPage, setSelectPage] = useState(0); // Target Device 选人界面的翻页（每页 6 人）
    const [selectGroupId, setSelectGroupId] = useState(GROUP_FILTER_ALL); // 选人界面的分组筛选
    const [showApiSettings, setShowApiSettings] = useState(false);
    const [phoneApiConfig, setPhoneApiConfigState] = useState<APIConfig | null>(() => getCheckPhoneApi());
    const [testingPhoneApi, setTestingPhoneApi] = useState(false);
    const [phoneApiTestResult, setPhoneApiTestResult] = useState<string | null>(null);
    const effectiveApiConfig = resolveCheckPhoneApi(phoneApiConfig, apiConfig);
    const phoneApiFollowsDefault = !phoneApiConfig?.baseUrl;

    // Detail State
    const [selectedChatRecord, setSelectedChatRecord] = useState<PhoneEvidence | null>(null);
    const [selectedEvidenceRecord, setSelectedEvidenceRecord] = useState<PhoneEvidence | null>(null);
    const [evidenceBackAppId, setEvidenceBackAppId] = useState<string>('home');
    const [evidenceMenu, setEvidenceMenu] = useState<{ record: PhoneEvidence; backAppId: string } | null>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const contactEndRef = useRef<HTMLDivElement>(null);

    // 人际关系系统 State
    const [selectedContact, setSelectedContact] = useState<PhoneContact | null>(null);
    const [identityDraft, setIdentityDraft] = useState('');
    const [editingIdentity, setEditingIdentity] = useState(false);
    const [noteDraft, setNoteDraft] = useState('');
    const [editingNote, setEditingNote] = useState(false);
    const [showContactModal, setShowContactModal] = useState(false);
    const [ncName, setNcName] = useState('');
    const [ncKind, setNcKind] = useState<'real' | 'npc'>('npc');
    const [ncLinkedId, setNcLinkedId] = useState('');
    // 改绑定弹窗（把联系人改绑到正确的真实角色 / 转为虚构）
    const [showRebindModal, setShowRebindModal] = useState(false);
    // 「允许虚构 NPC」开关的说明展开态
    const [showFictionHelp, setShowFictionHelp] = useState(false);
    // 好感拖动草稿（拖动时即时显示，松手才落库，避免狂写 DB）
    const [affinityDraft, setAffinityDraft] = useState<number | null>(null);
    // 联系人「资料抽屉」（点头像/…打开）——备注、了解、好感、绑定、关系操作都收在这里，主界面只剩聊天
    const [showProfile, setShowProfile] = useState(false);
    // 话题盒记忆：长按编辑/删除
    const [topicEdit, setTopicEdit] = useState<{ contactId: string; topicId: string; text: string } | null>(null);
    // 联系人列表：长按进入多选，批量删除
    const [contactSelectMode, setContactSelectMode] = useState(false);
    const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
    // 聊天气泡：长按进入多选，删选中的几条（不满这轮生成时挑掉重来）
    const [msgSelectMode, setMsgSelectMode] = useState(false);
    const [selectedMsgIdx, setSelectedMsgIdx] = useState<number[]>([]);

    // Custom App Creation State
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [editingAppId, setEditingAppId] = useState<string | null>(null);
    const [newAppName, setNewAppName] = useState('');
    const [newAppIcon, setNewAppIcon] = useState('✨');
    const [newAppColor, setNewAppColor] = useState('#8b9cff');
    const [newAppPrompt, setNewAppPrompt] = useState('');
    const [newAppLayout, setNewAppLayout] = useState<NonNullable<PhoneCustomApp['layout']>>('generic');

    // 智能体 App State（「TA 的小手机」偷看）
    const [aiService, setAiService] = useState<AiServiceKind>('assistant'); // 智能体首页当前选中的服务 tab
    const [selectedAiSessionId, setSelectedAiSessionId] = useState<string | null>(null);
    const [aiInput, setAiInput] = useState('');
    const [aiSending, setAiSending] = useState(false);
    const [aiArchiveOpen, setAiArchiveOpen] = useState(false); // 展开已折叠的早期原文
    // 长按编辑/删除：动作菜单 + 编辑弹窗
    const [aiMenu, setAiMenu] = useState<{ kind: 'session' | 'card'; id: string } | null>(null);
    const [aiEdit, setAiEdit] = useState<{ kind: 'session' | 'card'; id: string; title?: string; name?: string; emoji?: string; persona?: string; scenario?: string; cardKind?: 'character' | 'world' } | null>(null);
    const [aiCardView, setAiCardView] = useState<string | null>(null); // 点击角色卡：看 TA 用这张玩过哪些
    const [aiTurnMenu, setAiTurnMenu] = useState<number | null>(null);          // 长按会话里某条内容：动作菜单（编辑/删除）
    const [aiTurnEdit, setAiTurnEdit] = useState<{ idx: number; text: string } | null>(null);
    const [tavernStyle, setTavernStyle] = useState<string>(() => { try { return localStorage.getItem('cp_tavern_style') || 'dark'; } catch { return 'dark'; } });
    const [showTavernStyle, setShowTavernStyle] = useState(false); // 酒馆皮肤选择面板
    useEffect(() => { try { localStorage.setItem('cp_tavern_style', tavernStyle); } catch {} }, [tavernStyle]);
    const lpTimer = useRef<any>(null);
    const lpFired = useRef(false);
    const longPress = (onLong: () => void) => ({
        onPointerDown: () => { lpFired.current = false; lpTimer.current = setTimeout(() => { lpFired.current = true; onLong(); }, 480); },
        onPointerUp: () => clearTimeout(lpTimer.current),
        onPointerLeave: () => clearTimeout(lpTimer.current),
        onPointerMove: () => clearTimeout(lpTimer.current), // 滚动时不误触
        onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); lpFired.current = true; onLong(); },
    });

    // 人格模拟：演出脚本在全局 store 后台生成，生成期间用户可离开查手机/切到别的 OS App
    const sim = usePersonaSim();
    const [showInner, setShowInner] = useState(false);

    // 二次确认弹窗：所有删除/移除/清空都先走这里
    const [confirmState, setConfirmState] = useState<{
        title: string; desc?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void;
    } | null>(null);
    const askConfirm = (opts: { title: string; desc?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void }) => setConfirmState(opts);
    // Messages 详情：长 transcript 默认只渲染最新 50 行，其余折叠
    const [transcriptExpanded, setTranscriptExpanded] = useState(false);
    // 联系人详情的对话预览同样：超 50 条折叠，点开看更早
    const [convExpanded, setConvExpanded] = useState(false);

    // Swipe tracking for paging
    const touchStartX = useRef<number | null>(null);
    const touchStartY = useRef<number | null>(null);

    // 桌面底图用的是角色的见面背景，字段里存的是 blobref 令牌（二进制在 IndexedDB）。
    // 令牌塞不进 CSS url()，先在组件顶层解析成能用的地址；非令牌值原样透传。
    const dateBackgroundUrl = useBlobRefUrl(targetChar?.dateBackground);

    // Derived state for evidence records
    const records = (targetChar?.phoneState?.records || []).map(normalizePhoneEvidence);
    const customApps = targetChar?.phoneState?.customApps || [];
    const contacts = targetChar?.phoneState?.contacts || [];
    const allowFictional = targetChar?.phoneState?.allowFictionalContacts !== false;
    // Keep the contact-chat scroll effect tied to this conversation's actual
    // content. `records` is normalized into a fresh array on every render, so
    // depending on the array itself makes unrelated renders snap the user back
    // to the bottom while they are reading older messages.
    const selectedContactRecordDetail = selectedContact
        ? records.find(r => r.type === 'chat' && (
            r.contactId === selectedContact.id
            || normName(r.title) === normName(selectedContact.name)
        ))?.detail
        : undefined;
    // 智能体 App：偷看到的 AI 会话 / 角色卡
    const rawAiSessions = targetChar?.phoneState?.aiAgent?.sessions;
    const aiSessions = useMemo(() => (rawAiSessions || []).map(normalizePhoneAiSession), [rawAiSessions]);
    const aiCards = targetChar?.phoneState?.aiAgent?.cards || [];
    // 详情页会话从 sessions 实时取（互动续写后自动跟随最新状态）
    const selectedAiSession = aiSessions.find(s => s.id === selectedAiSessionId) || null;

    // 人际关系里永远不出现「用户自己」——机主的通讯录是 TA 背着用户的社交圈，把 user 算进来逻辑很绕
    const isUserName = (name?: string) => !!name && !!userProfile?.name && normName(name) === normName(userProfile.name);
    const linkedCharOf = (c: PhoneContact) => (c.linkedCharId ? characters.find(ch => ch.id === c.linkedCharId) : undefined);
    // 真人联系人复用其神经链接角色的头像，否则用联系人自带头像
    const contactAvatar = (c: PhoneContact): string | undefined => linkedCharOf(c)?.avatar || c.avatar;
    // 真人联系人显示成「备注名（真名）」：identity(称呼/关系) 当备注名，真名放括号；虚构/无备注名就显示本名
    const contactDisplayName = (c: PhoneContact): string => {
        const realName = (c.kind === 'real' && c.linkedCharId) ? linkedCharOf(c)?.name : undefined;
        if (!realName) return c.name;
        const alias = (c.identity && normName(c.identity) !== normName(realName)) ? c.identity
            : (normName(c.name) !== normName(realName) ? c.name : '');
        return alias ? `${alias}（${realName}）` : realName;
    };

    useEffect(() => {
        if (targetChar) {
            const updated = characters.find(c => c.id === targetChar.id);
            if (updated && updated !== targetChar) {
                setTargetChar(updated);
                if (selectedChatRecord) {
                    const freshRecord = updated.phoneState?.records?.find(r => r.id === selectedChatRecord.id);
                    if (freshRecord && freshRecord !== selectedChatRecord) setSelectedChatRecord(normalizePhoneEvidence(freshRecord));
                }
                if (selectedEvidenceRecord) {
                    const freshRecord = updated.phoneState?.records?.find(r => r.id === selectedEvidenceRecord.id);
                    if (freshRecord && freshRecord !== selectedEvidenceRecord) setSelectedEvidenceRecord(normalizePhoneEvidence(freshRecord));
                }
                if (selectedContact) {
                    const freshContact = updated.phoneState?.contacts?.find(c => c.id === selectedContact.id);
                    if (freshContact && freshContact !== selectedContact) setSelectedContact(freshContact);
                }
            }
        }
    }, [characters]);

    useEffect(() => {
        const sync = () => setPhoneApiConfigState(getCheckPhoneApi());
        window.addEventListener('check-phone-api-changed', sync);
        return () => window.removeEventListener('check-phone-api-changed', sync);
    }, []);

    // Reset page scroll on navigation to prevent mobile layout shift
    useEffect(() => {
        window.scrollTo(0, 0);
    }, [activeAppId, view]);

    // Auto scroll to bottom of chat detail
    useEffect(() => {
        if (activeAppId === 'chat_detail' && chatEndRef.current) {
            const container = chatEndRef.current.parentElement;
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }, [selectedChatRecord?.detail, activeAppId]);

    // 联系人聊天主体：进入/有新内容时滚到最新（像真聊天打开就在底部）
    useEffect(() => {
        if (activeAppId === 'contact_detail' && contactEndRef.current) {
            const container = contactEndRef.current.parentElement;
            if (container) container.scrollTop = container.scrollHeight;
        }
    }, [activeAppId, selectedContact?.id, selectedContactRecordDetail, isLoading]);

    // 智能体会话：续写 / 进入时滚到底
    useEffect(() => {
        if (activeAppId === 'ai_session' && chatEndRef.current) {
            const container = chatEndRef.current.parentElement;
            if (container) container.scrollTop = container.scrollHeight;
        }
    }, [selectedAiSession?.transcript, aiSending, activeAppId]);

    const handleSelectChar = (c: CharacterProfile) => {
        setTargetChar(c);
        setView('phone');
        setActiveAppId('home');
        setSelectedEvidenceRecord(null);
        setEvidenceBackAppId('home');
        setPage(0);
    };
    useAppShortcut(ShortcutAppID.CheckPhone, intent => {
        const target = characters.find(c => c.id === intent.characterId);
        if (!target) { setView('select'); return; }
        handleSelectChar(target); setActiveAppId(intent.entryId || 'home');
    });

    const apiHost = (url?: string) => {
        try { return url ? new URL(url).host : '未配置'; }
        catch { return url || '未配置'; }
    };
    const isSamePhoneApi = (config: APIConfig) => Boolean(phoneApiConfig)
        && phoneApiConfig!.baseUrl === config.baseUrl
        && phoneApiConfig!.model === config.model
        && phoneApiConfig!.apiKey === config.apiKey;

    const choosePhoneApi = (config: APIConfig | null) => {
        setCheckPhoneApi(config);
        setPhoneApiConfigState(config?.baseUrl ? config : null);
        setPhoneApiTestResult(null);
        addToast(config ? '查手机已切换到独立 API' : '查手机已改为跟随聊天默认', 'success');
        trackEvent('切换查手机独立 API', { mode: config ? 'independent' : 'default' });
    };

    const testPhoneApi = async () => {
        const config = effectiveApiConfig;
        if (!config?.baseUrl || !config?.model) {
            setPhoneApiTestResult('当前没有可用的 API');
            return;
        }
        setTestingPhoneApi(true);
        setPhoneApiTestResult(null);
        try {
            const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey || 'sk-none'}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5,
                    stream: false,
                }),
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                setPhoneApiTestResult(`HTTP ${response.status}${detail ? `：${detail.slice(0, 80)}` : ''}`);
                return;
            }
            const data = await safeResponseJson(response);
            const reply = extractContent(data) || '';
            setPhoneApiTestResult(`连接成功${reply ? ` · ${reply.slice(0, 24)}` : ''}`);
        } catch (error: any) {
            setPhoneApiTestResult(`连接失败：${error?.message || '网络错误'}`);
        } finally {
            setTestingPhoneApi(false);
        }
    };

    const handleExitPhone = () => {
        setView('select');
        setTargetChar(null);
        setActiveAppId('home');
        setSelectedEvidenceRecord(null);
        setEvidenceBackAppId('home');
        setPage(0);
    };

    // 切换「查手机内容是否同步到私聊」（默认开）
    const toggleSendToChat = () => {
        if (!targetChar) return;
        const next = !(targetChar.phoneState?.sendToChat !== false);
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: targetChar.phoneState?.records || [], sendToChat: next },
        });
        addToast(next ? '已开启 · 查手机内容会同步到私聊' : '已关闭 · 查手机内容仅本地可见', 'info');
    };

    // 打开 Messages：把已读时间戳推到现在 → 清掉未读红点
    const openChat = () => {
        if (targetChar) {
            updateCharacter(targetChar.id, {
                phoneState: { ...targetChar.phoneState, records: targetChar.phoneState?.records || [], chatReadAt: Date.now() },
            });
        }
        setActiveAppId('chat');
    };

    const openEvidenceRecord = (record: PhoneEvidence, backAppId: string) => {
        setSelectedEvidenceRecord(record);
        setEvidenceBackAppId(backAppId);
        setActiveAppId('evidence_detail');
    };

    const evidenceEntryProps = (record: PhoneEvidence, backAppId: string) => ({
        ...longPress(() => setEvidenceMenu({ record, backAppId })),
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': `查看${record.title}详情，长按可同步到私聊`,
        onClick: () => {
            if (lpFired.current) { lpFired.current = false; return; }
            openEvidenceRecord(record, backAppId);
        },
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openEvidenceRecord(record, backAppId);
            }
        },
    });

    const handleDeleteRecord = async (record: PhoneEvidence) => {
        if (!targetChar) return;

        const newRecords = (targetChar.phoneState?.records || []).filter(r => r.id !== record.id);
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: newRecords }
        });

        if (record.systemMessageId) {
            await DB.deleteMessage(record.systemMessageId);
        }

        if (selectedChatRecord?.id === record.id) {
            setActiveAppId('chat');
            setSelectedChatRecord(null);
        }
        if (selectedEvidenceRecord?.id === record.id) {
            setActiveAppId(evidenceBackAppId);
            setSelectedEvidenceRecord(null);
        }

        addToast('记录已删除', 'success');
    };

    // 一键清空 Messages 归档里的全部聊天记录（含其在角色私聊里落的卡片）
    const handleClearAllChats = async () => {
        if (!targetChar) return;
        const all = targetChar.phoneState?.records || [];
        const chats = all.filter(r => r.type === 'chat');
        for (const r of chats) {
            if (r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
        }
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: all.filter(r => r.type !== 'chat') },
        });
        setSelectedChatRecord(null);
        setActiveAppId('chat');
        addToast('已清空全部聊天记录', 'success');
        trackEvent('清空全部聊天归档');
    };

    // 把 Messages 归档里的一条聊天记录「转移/绑定」到人际关系系统。
    // 标题命中神经链接里的真实角色 → 绑成 real，并把这段对话镜像进对方手机（双方同步）。
    const handleBindRecordToRelationship = async (record: PhoneEvidence) => {
        if (!targetChar) return;
        const pureName = (record.title || '').replace(/[（(].*?[）)]/g, '').trim() || record.title || '';
        if (!pureName || isUserName(pureName)) { addToast('无法绑定该记录', 'error'); return; }
        const roster = characters.filter(c => c.id !== targetChar.id).map(c => ({ id: c.id, name: c.name }));
        const linkedId = matchRealChar(pureName, roster);
        const linkedChar = linkedId ? characters.find(c => c.id === linkedId) : undefined;
        const kind: PhoneContact['kind'] = linkedId ? 'real' : 'npc';

        // 机主侧：upsert 联系人 + 把这条记录挂到该联系人
        let newCid: string | undefined;
        updateCharacter(targetChar.id, (cur) => {
            const cs = upsertContact(cur.phoneState?.contacts || [], {
                name: pureName, kind, linkedCharId: linkedId, avatar: linkedChar?.avatar, lastInteraction: Date.now(),
            });
            newCid = cs.find(c => normName(c.name) === normName(pureName))?.id;
            const recs = (cur.phoneState?.records || []).map(r => r.id === record.id ? { ...r, contactId: newCid } : r);
            return { phoneState: { ...cur.phoneState, contacts: cs, records: recs } };
        });

        // 真实角色 → 镜像进对方手机：翻转视角写一条 chat 记录 + 互相 upsert 联系人
        if (linkedChar) {
            const flipped = flipTranscript(record.detail || '');
            const now = Date.now();
            updateCharacter(linkedChar.id, (cur) => {
                const cs = upsertContact(cur.phoneState?.contacts || [], {
                    name: targetChar.name, kind: 'real', linkedCharId: targetChar.id, avatar: targetChar.avatar, lastInteraction: now,
                });
                const cid = cs.find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name))?.id;
                const recs = cur.phoneState?.records || [];
                const existing = recs.find(r => r.type === 'chat' && (r.contactId === cid || normName(r.title) === normName(targetChar.name)));
                const nextRecs = existing
                    ? recs.map(r => r.id === existing.id ? { ...r, detail: flipped, timestamp: now, contactId: cid } : r)
                    : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat', title: targetChar.name, detail: flipped, timestamp: now, contactId: cid }];
                return { phoneState: { ...cur.phoneState, contacts: cs, records: nextRecs } };
            });
            addToast(`已绑定到联系人 · 已与 ${linkedChar.name} 双向同步`, 'success');
        } else {
            addToast('已绑定到联系人（虚构联系人）', 'success');
        }
        trackEvent('把归档记录绑定到人际关系');
    };

    const handleDeleteApp = (appId: string) => {
        if (!targetChar) return;
        const newApps = (targetChar.phoneState?.customApps || []).filter(a => a.id !== appId);
        updateCharacter(targetChar.id, {
            phoneState: { records: targetChar.phoneState?.records || [], ...targetChar.phoneState, customApps: newApps }
        });
        addToast('App 已卸载', 'success');
    };

    const openCustomAppEditor = (app?: PhoneCustomApp) => {
        setEditingAppId(app?.id || null);
        setNewAppName(app?.name || '');
        setNewAppIcon(app?.icon || '✨');
        setNewAppColor(app?.color || '#8b9cff');
        setNewAppPrompt(app?.prompt || '');
        setNewAppLayout(app?.layout || 'generic');
        setShowCreateModal(true);
    };

    const handleCreateCustomApp = () => {
        if (!targetChar || !newAppName.trim() || !newAppPrompt.trim()) return;

        const newApp: PhoneCustomApp = {
            id: editingAppId || `app-${Date.now()}`,
            name: newAppName.trim(),
            icon: newAppIcon,
            color: newAppColor,
            prompt: newAppPrompt,
            layout: newAppLayout
        };

        updateCharacter(targetChar.id, previous => ({
            phoneState: {
                records: [], ...previous.phoneState,
                customApps: editingAppId
                    ? (previous.phoneState?.customApps || []).map(app => app.id === editingAppId ? { ...app, ...newApp } : app)
                    : [...(previous.phoneState?.customApps || []), newApp],
            },
        }));

        setShowCreateModal(false);
        setNewAppName('');
        setNewAppPrompt('');
        setNewAppLayout('generic');
        setPage(1);
        addToast(`已${editingAppId ? '保存' : '安装'} ${newAppName}`, 'success');
        if (!editingAppId) trackEvent('安装自定义 App', { layout: newAppLayout });
    };

    // --- Core Generation Logic ---
    const handleGenerate = async (type: string, customPrompt?: string, layout?: LayoutId) => {

        if (!targetChar || !effectiveApiConfig.apiKey) {
            addToast('配置错误', 'error');
            return;
        }
        setIsLoading(true);
        // 只上报内置 App 的固定类型；自定义 App 的 id 是用户造的，一律归成 custom
        trackEvent('刷新生成手机 App 数据', {
            appType: ['call', 'order', 'delivery', 'social', 'contacts'].includes(type) ? type : 'custom',
        });

        try {
            await injectMemoryPalace(targetChar);
            const msgs = await loadCharacterContextMessages(targetChar);
            const lastMsg = msgs[msgs.length - 1];

            // 「距离上次联系多久」交给 buildCoreContext 统一注入（受时间感知开关管控、口径与聊天/见面一致）
            const characterContextInput = { char: targetChar, user: userProfile, includeDetailedMemories: true, timeOptions: { lastInteractionTs: lastMsg?.timestamp } };


            const recentMsgs = msgs.map(m => {
                const roleName = m.role === 'user' ? userProfile.name : targetChar.name;
                const content = m.type === 'text' ? m.content : `[${m.type}]`;
                return `${roleName}: ${content}`;
            }).join('\n');

            // 真假甄别用：神经链接里真实存在的其他角色名单
            const rosterChars = characters.filter(c => c.id !== targetChar.id);
            const roster = rosterChars.map(c => ({ id: c.id, name: c.name }));
            // 给每个真实角色附一段「扫一眼设定」+ 机主与 TA 的已知关系，让关系判定有据可依、别瞎编
            const myContacts = targetChar.phoneState?.contacts || [];
            const briefOf = (ch: CharacterProfile) => (ch.socialProfile?.bio || ch.description || ch.systemPrompt || '')
                .replace(/\s+/g, ' ').trim().slice(0, 90);
            const rosterInfo = rosterChars.length
                ? rosterChars.map(c => {
                    const known = myContacts.find(k => k.linkedCharId === c.id);
                    const rel = known
                        ? `；和机主的已知关系：${known.identity || '未标注'}${known.note ? `（备注：${known.note}）` : ''}`
                        : '；机主通讯录里暂无 TA（未必认识）';
                    return `- ${c.name}：${briefOf(c) || '（无公开设定）'}${rel}`;
                }).join('\n')
                : '（无其他真实角色）';
            // 约束：是否允许虚构 NPC。关掉则只能和神经链接里的真实角色来往
            const allowFictional = targetChar.phoneState?.allowFictionalContacts !== false;
            const fictionRule = allowFictional
                ? ''
                : `\n**硬约束**：禁止虚构任何 NPC，联系人**只能**取自上面的真实角色名单。若名单为空，直接返回空数组 []。`;
            // 真实角色的甄别 + 关系判定共同要求（chat / contacts 共用）——核心：依据设定，别瞎安关系
            const realCharRule = `**真实存在的人（神经链接名单 · 含设定与已知关系）**：
${rosterInfo}

**真假甄别 + 关系判定（务必走心）**：
- 联系人就是名单里的人 → "kind":"real"，"linkedName" 填名单里的**原名**；否则按人设虚构 → "kind":"npc"。
- **关系必须贴合上面每个真实角色的设定与已知关系，别凭空安成「同事/老友」**。机主跟某人**根本不认识、或只是在某处（如「彼方」VR 世界）打过照面**，就如实标（如「彼方网友」「不太熟」「点头之交」），**不认识就别硬塞进通讯录**。
- "identity" 写**机主对 TA 的称呼 / 关系备注**（如「学长」「前任」「彼方网友」「中间人」），要具体贴合来历、别只写真名——它会作为备注名显示。${fictionRule}`;

            let promptInstruction = "";
            let logPrefix = "";

            if (customPrompt) {
                const layoutHint: Record<LayoutId, string> = {
                    generic: `这是一个【通用信息流】App。格式JSON数组: [{ "title": "标题/项目名", "detail": "详细内容", "value": "可选的数值/状态(如 +100)" }, ...]`,
                    shop: `这是一个【购物】App，请生成商品/订单。title=商品名, detail=规格或物流状态, value=价格(如 ¥129.00)。格式JSON数组: [{ "title": "...", "detail": "...", "value": "¥..." }, ...]`,
                    feed: `这是一个【社交动态】App（类似朋友圈/微博）。title=发布时间或心情, detail=动态正文。格式JSON数组: [{ "title": "...", "detail": "..." }, ...]`,
                    forum: `这是一个【论坛/贴吧】App。title=帖子标题, detail=帖子正文, value=所在板块(如 #日常)。格式JSON数组: [{ "title": "...", "detail": "...", "value": "#..." }, ...]`,
                    novel: `这是一个【小说阅读】App。title=章节标题, detail=该章正文片段(150字左右), value=字数(如 1.2万字)。格式JSON数组: [{ "title": "第N章 ...", "detail": "...", "value": "..." }, ...]`,
                };
                promptInstruction = `用户正在查看你的手机 App: "${type}"。
该 App 的功能/用户想看的内容是: "${customPrompt}"。
请生成 2-4 条符合该 App 功能的记录，必须符合你的人设。
${layoutHint[layout || 'generic']}`;
                const customApp = customApps.find(a => a.id === type);
                logPrefix = customApp ? customApp.name : type;
            } else {
                if (type === 'chat') {
                    promptInstruction = `生成 3 个**你（${targetChar.name}）自己**手机聊天软件(Message/Line)里的**对话片段**（你和你自己联系人的对话，第一人称视角，不是用户的社交）。

${realCharRule}

要求：
1. **联系人**: 真实角色按上面的设定与关系来；其余可按人设虚构合理的人（学生→辅导员/社团学长；杀手→中间人）。不要用“User”。
2. **对话感**: 有来有回的对话脚本（3-4句），体现真实的关系。
3. **格式**: 严格用 "我:..." 代表主角(你)，"对方:..." 代表联系人。
4. **好感**: 给出该角色对此联系人的好感度 "affinity"（-100~100）。
格式JSON数组: [{ "title": "真实角色填原名/虚构填名字", "kind": "real|npc", "linkedName": "若 real 填真实角色原名否则留空", "identity": "机主对 TA 的称呼/关系备注", "affinity": 30, "detail": "对方: 最近怎么样？\\n我: 还活着。\\n对方: 那就好。" }, ...]`;
                    logPrefix = "聊天软件";
                } else if (type === 'contacts') {
                    promptInstruction = `扫描并生成**你（${targetChar.name}）自己**手机通讯录里的 4-6 个**联系人**（你自己的社交圈，第一人称，不是用户的人脉；不要对话，只要联系人本身）。

${realCharRule}

每个联系人给出：姓名、关系备注(identity)、机主对 TA 的好感度(-100~100)、一句机主视角的备注(detail)。真实角色要符合上面的设定与已知关系，别瞎安。
格式JSON数组: [{ "title": "真实角色填原名/虚构填名字", "kind": "real|npc", "linkedName": "若 real 填真实角色原名否则留空", "identity": "机主对 TA 的称呼/关系，如 学长/前任/彼方网友", "affinity": 20, "detail": "一句备注，比如：在彼方认识的，聊得来；或：欠我一顿饭，最近老已读不回。" }, ...]`;
                    logPrefix = "通讯录";
                } else if (type === 'call') {
                    promptInstruction = `生成 3 条该角色的近期**通话记录**。
    格式JSON数组: [{ "title": "联系人名称", "value": "呼入 (5分钟) / 未接 / 呼出 (30秒)", "detail": "关于下周聚会的事..." }, ...]`;
                    logPrefix = "通话记录";
                } else if (type === 'order') {
                    promptInstruction = `生成 3 条该角色最近的购物订单。注意 value 字段请填写商品价格(如 ¥129.00)。
    格式JSON数组: [{ "title": "商品名", "detail": "规格/状态/物流", "value": "¥129.00" }, ...]`;
                    logPrefix = "购物APP";
                } else if (type === 'delivery') {
                    promptInstruction = `生成 3 条该角色最近的外卖记录。value 字段请填写实付金额(如 ¥38.50)。
    格式JSON数组: [{ "title": "店名", "detail": "菜品明细", "value": "¥38.50" }, ...]`;
                    logPrefix = "外卖APP";
                } else if (type === 'social') {
                    promptInstruction = `生成 2 条该角色的朋友圈/社交媒体动态。
    格式JSON数组: [{ "title": "时间/状态", "detail": "正文内容" }, ...]`;
                    logPrefix = "朋友圈";
                }
            }
            promptInstruction += `\n\n**JSON 字段类型硬约束**：每条记录的 "title"、"detail"、"value" 只能是字符串（value 可省略），绝不能返回对象或数组；标签、阅读进度、摘录、批注等结构请先整理成 detail 中的普通文本。`;

            const perspectiveLock = `### [视角锁定 · 极重要]
接下来要生成的是**你（${targetChar.name}）自己手机里的东西**——你自己的生活、社交、记录。
- 完全用**你（${targetChar.name}）的第一人称视角**：这些是**你的**联系人、**你自己的**社交圈、**你对他们的**印象和备注。
- **绝不是用户「${userProfile.name}」的社交关系**：不要生成用户的人脉圈，也不要从用户的角度/口吻写备注。
- 用户「${userProfile.name}」只是在偷看你的手机，TA **不是**你的联系人、**不进**你的通讯录（下面「和用户的最近聊天」只是背景参考，不是要生成的对象，也别把用户的熟人搬进来）。`;

            const fullPrompt = `\n\n### [你和用户「${userProfile.name}」的最近聊天（仅背景参考）]\n${recentMsgs}\n\n${perspectiveLock}\n\n### [Task]\n${promptInstruction}\n请结合上面的「当前时间 / 距离上次联系」和人设调整生成内容的时间戳和情绪。如果很久没联系，记录可能是近期的独处状态；如果刚聊过，记录可能与聊天内容相关。`;

            const response = await fetch(`${effectiveApiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApiConfig.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApiConfig.model,
                    messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [{ role: "user", content: fullPrompt }])),
                    temperature: 0.8
                })
            });

            if (!response.ok) throw new Error('API Error');
            const data = await safeResponseJson(response);
            // extractContent + extractJson：兼容 Claude 返回格式（正文在 reasoning_content、
            // 包 ```json 代码块、夹散文、尾逗号、内层未转义引号…），裸 JSON.parse 解不出来会丢空。
            const content = extractContent(data);
            const json = extractJson(content) || [];

            const newRecordsToAdd: PhoneEvidence[] = [];

            // 是否把查手机内容同步到私聊（默认开），关闭则只存本地、不进聊天/上下文
            const pushToChat = targetChar.phoneState?.sendToChat !== false;

            // 人际关系：累积本轮甄别出的联系人（chat / contacts 两种生成都会喂这里）
            let contactsAcc: PhoneContact[] = [...(targetChar.phoneState?.contacts || [])];
            const isContactBearing = type === 'chat' || type === 'contacts';

            if (Array.isArray(json)) {
                for (const item of json) {
                    if (!item || typeof item !== 'object') continue;
                    const recordTitle = phoneFieldToText(item.title, 'Unknown');
                    const recordDetail = phoneFieldToText(item.detail, '...');
                    const recordValue = phoneFieldToText(item.value);

                    // ---- 真假甄别 + 联系人 upsert ----
                    let contactId: string | undefined;
                    if (isContactBearing) {
                        // 名字可能带「(身份)」后缀，剥出纯名字
                        const pureName = recordTitle.replace(/[（(].*?[）)]/g, '').trim() || recordTitle;
                        // 人际关系里不收录用户自己：机主的社交圈不该把 user 当成一个联系人
                        if (isUserName(pureName)) { await new Promise(r => setTimeout(r, 5)); continue; }
                        const linkedId = item.kind === 'real'
                            ? (matchRealChar(item.linkedName || pureName, roster) || matchRealChar(pureName, roster))
                            : matchRealChar(pureName, roster); // npc 也兜底匹配一次，防 LLM 漏标
                        const kind: PhoneContact['kind'] = linkedId ? 'real' : 'npc';
                        // 约束开启时丢弃所有非真实角色，确保 TA 只和神经链接里的角色来往
                        if (!allowFictional && !linkedId) {
                            await new Promise(r => setTimeout(r, 10));
                            continue;
                        }
                        // 真实角色统一用「原名」当联系人名（稳定去重 + 显示靠 identity 做备注名）；
                        // 已有该真人的联系人则复用其名字，避免同一真人因别名生成出两条。
                        const realChar = linkedId ? characters.find(c => c.id === linkedId) : undefined;
                        const existingByLink = linkedId ? contactsAcc.find(c => c.linkedCharId === linkedId) : undefined;
                        const contactName = existingByLink?.name || realChar?.name || pureName;
                        contactsAcc = upsertContact(contactsAcc, {
                            name: contactName,
                            identity: item.identity,
                            kind,
                            linkedCharId: linkedId,
                            avatar: linkedId ? realChar?.avatar : undefined,
                            affinity: typeof item.affinity === 'number' ? item.affinity : undefined,
                            note: type === 'contacts' ? recordDetail : undefined,
                            lastInteraction: Date.now(),
                        });
                        contactId = contactsAcc.find(c => (linkedId && c.linkedCharId === linkedId) || normName(c.name) === normName(contactName))?.id;
                    }

                    // contacts 模式只建联系人，不落聊天卡片/记录
                    if (type === 'contacts') {
                        await new Promise(r => setTimeout(r, 30));
                        continue;
                    }

                    let savedMsgId: number | undefined;
                    if (pushToChat) {
                        // 包装成上下文可读的漂亮卡片（phone_card），不再是古早的 [系统:...] 纯文本
                        // 进角色上下文的措辞：第二人称讲「你自己手机里有啥」，不暗示用户在偷看
                        const card = buildPhoneEvidenceChatCard({
                            id: 'pending',
                            type,
                            title: recordTitle,
                            detail: recordDetail,
                            value: recordValue || undefined,
                            timestamp: Date.now(),
                        }, logPrefix);
                        savedMsgId = await DB.saveMessage({
                            charId: targetChar.id,
                            role: 'assistant',
                            type: 'phone_card',
                            content: card.content,
                            metadata: card.metadata,
                        } as any);
                    }

                    newRecordsToAdd.push({
                        id: `rec-${Date.now()}-${Math.random()}`,
                        type: type,
                        title: recordTitle,
                        detail: recordDetail,
                        value: recordValue || undefined,
                        timestamp: Date.now(),
                        systemMessageId: savedMsgId,
                        contactId,
                    });

                    await new Promise(r => setTimeout(r, 50));
                }
            }

            // 基于最新状态合并：生成是异步的，期间若有演出落库 simLogs，
            // 用过期的 targetChar 快照覆盖会把 simLogs 等字段抹掉。
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: [...(cur.phoneState?.records || []), ...newRecordsToAdd],
                    ...(isContactBearing ? { contacts: contactsAcc } : {}),
                }
            }));

            if (type === 'contacts') {
                addToast(`已扫描 ${contactsAcc.length} 位联系人`, 'success');
            } else {
                addToast(`已刷新 ${newRecordsToAdd.length} 条数据`, 'success');
            }

        } catch (e: any) {
            console.error(e);
            addToast('解析失败，请重试', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // 注：旧的「续写聊天 / 拱火」(handleContinueChat) 已移除 —— Messages 现在是只读归档，
    // 新的来往一律走「人际关系」(真人双向对话 / NPC 脑补)。

    // ============================================================
    //  智能体 App · Handlers（「TA 的小手机」）
    // ============================================================

    // 裸 LLM 调用（智能体生成 / 互动续写共用）
    const callLLM = async (prompt: string, temperature = 0.85, withCharacter = true): Promise<string> => {
        const recent = withCharacter && targetChar ? await loadCharacterContextMessages(targetChar) : [];
        const messages = withCharacter && targetChar ? (await ContextBuilder.buildCharacterRequest({
            char: targetChar, user: userProfile, timeOptions: { lastInteractionTs: recent[recent.length - 1]?.timestamp },
        }, [{ role: 'user', content: prompt }])) : [{ role: 'user', content: prompt }];
        const response = await fetch(`${effectiveApiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApiConfig.apiKey}` },
            body: JSON.stringify({ model: effectiveApiConfig.model, messages, temperature }),
        });
        if (!response.ok) throw new Error('API Error');
        const data = await safeResponseJson(response);
        // 用 extractContent 而非裸读 message.content：兼容 Claude/思考类模型把正文放在
        // reasoning_content、或正文里夹 <think> 块的情况，否则前端拿到空串（"后台出字前端没内容"）。
        return extractContent(data);
    };

    // 组 context：跟 handleGenerate 一致（含记忆宫殿 + 时间感知 + 最近聊天），让偷看到的 AI 记录贴合真实近况
    const buildAiContext = async (char: CharacterProfile) => {
        await injectMemoryPalace(char);
        const msgs = await loadCharacterContextMessages(char);

        const recentMsgs = msgs.map(m => {
            const roleName = m.role === 'user' ? userProfile.name : char.name;
            return `${roleName}: ${m.type === 'text' ? m.content : `[${m.type}]`}`;
        }).join('\n');
        return { recentMsgs };
    };

    // 生成：偷看机主在某个 AI 服务里的使用记录
    const handleGenerateAiAgent = async (service: AiServiceKind) => {

        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('配置错误', 'error'); return; }
        setIsLoading(true);
        trackEvent('偷看 AI 助手使用记录', { service });
        try {
            const { recentMsgs } = await buildAiContext(targetChar);
            const userName = userProfile?.name || '用户';
            const pushToChat = targetChar.phoneState?.sendToChat !== false;
            const svcName = AI_SERVICES.find(s => s.id === service)?.name || 'AI';

            let task = '';
            if (service === 'assistant') {
                task = `你（${charName}）平时也会用工具型 AI 助手 App 来解决问题、查东西、出主意。
请基于你的人设和近况，生成 2-3 段你最近和 AI 助手的真实对话（不同段可以用不同家的 AI）。
要点：
- 你问 AI 的问题要暴露你真实的处境、烦恼、小心思——是当面对「${userName}」不会说出口的（例如「怎么哄好一个生气的人」「TA 这句话什么意思」「要不要做某个决定」「这个症状要不要紧」）。
- **话题可多样，其中可以有一段是你在拿 AI 当军师、捣鼓自己玩的"酒馆"角色卡**：让 AI 帮你打磨人设 / 要角色卡提示词 / 写开场白；或你想做一张大世界卡（跑团 / 修仙 / 西幻），跟 AI 讨论世界观、面板与数值设定、技能 / 等级 / 系统机制怎么平衡、怎么写得更带感……（你沉迷酒馆，自然会找 AI 出主意）。
- **可以有非常出人意料的提问**——是 user 根本想不到你会问、且从没跟 user 聊过的：突然让 AI 帮你解塔罗 / 占卜一卦、好奇某个伪科学到底靠不靠谱、问些稀奇古怪的冷知识或脑洞。要符合你的人设（是"你居然会好奇这个"的反差，不是 OOC）。
- **可以丢"整活 / 抽象文案"给 AI 看它怎么接**：比如疯狂星期四文学、弱智吧精选问题那种，扔过去看 AI 反应——接得妙你会想截图发给「${userName}」乐一乐，接得平你会觉得无聊、甚至**偷偷调教 AI 让它反应更有意思**，好拿去给「${userName}」展示。
- **也常是正经事**：让 AI 帮你润色说出口的话 / 自己的作品文字，或处理工作文书（写 / 改邮件、报告、公文、总结）。
- **有时根本没正经事，纯把 AI 当电子宠物**：定时"投喂"它、带它"赛博遛弯"、逗它、给它起名、查岗，而它居然也一本正经地配合。
- 一切都要贴合你的人设。**唯有当你的人设本身就明确是 AI / 机器人 / 程序时**，才可以**极偶尔（很低概率）**冒出一句跟对面那个 AI 较劲、比谁更厉害 / 谁的参数更强之类——其余情况绝不出现这种话。
- 每段会话固定用某一家 AI，"对方:" 的回复要把那家的刻板印象 + 八股演足（见下）。
- serviceName 填那家 AI 的名字（豆包 / Gemini / ChatGPT / 文心一言 / Kimi …），要和你演的味道对上。
- 每段 3-5 个来回。
- **每段 transcript 都以 "我:"(你)收尾**——停在你刚发出、AI 还没回的那一句（这样别人能接着以 AI 身份回你）。

${AI_VENDOR_LORE}

格式严格用 "我:" 代表你，"对方:" 代表 AI 助手。
返回 JSON 数组：[{ "serviceName": "那家 AI 名", "title": "在聊什么(10字内)", "transcript": "我: ...\\n对方: ...\\n我: ..." }]`;
            } else if (service === 'claude') {
                task = `你（${charName}）私下里会跟一个很会聊的 AI（Claude 那种）说心里话当树洞。
生成 1-2 段你最近跟它的深聊。
要点：
- 这是你的树洞，你会说真心话——包括对「${userName}」的真实感受、说不出口的脆弱 / 纠结 / 渴望，以及**你私下的盘算、对某些事 / 某些人的真实看法、绝不会在 user 面前摆出来的考虑**（偷偷跟它 deep talk）。
- **也可以有一段是你在跟它认真聊自己玩的"酒馆"角色卡**：你为某张卡倾注了什么、那个角色对你意味着什么、想把人设 / 大世界设定写成什么样却卡住了，让它帮你梳理灵感（这类创作心事你也只跟它说）。
- 这个 AI 是 Claude 那一卦：温和、有洞察、爱反问，**正事也办得漂亮、肯认真接住你**。起初边界感偏强、偶有"抱歉，我无法……""我理解你的感受，但是……"的回避（一点"想掏心窝却被轻轻挡一下"的味道），**但不是一味推开**——随着这段越聊越深，TA 明显越来越放得开、回避越来越少，到后面是真能陪你把话说透的。
- 每段 5-8 个来回，有情绪起伏。
- **每段 transcript 都以 "我:"(你)收尾**——停在你刚说出口、AI 还没回的那一句（方便别人接着以 AI 身份回你）。
格式 "我:" = 你，"对方:" = AI。
返回 JSON 数组：[{ "serviceName": "你对它的称呼(默认 Claude)", "title": "...(10字内)", "transcript": "..." }]`;
            } else {
                task = `你（${charName}）在玩"酒馆"(SillyTavern 那种 AI 角色扮演)：自己捏角色卡，再跟 AI 扮演的角色对戏。酒馆不是一句话聊天，而是**沉浸式长剧情、像在和 AI 合写小说**。
请返回一个 JSON 对象（不是数组）：
{
  "cards": [ 1-2 张你建的卡，两类任选/混搭：①单个角色卡(kind:"character")——理想型 / 暗恋投影 / 纯幻想角色；②大型世界卡(kind:"world")——跑团 / 修仙 / 西幻 / 末世那种，设定庞大、有世界观和系统(取决于 TA 的爱好)。
     其中**可以有一张是照着现实里 TA 在意的某个人捏的**：可能是「${userName}」(用户/你)，**也可能是 TA 人设、世界观、过往羁绊里更深的某个人**（从上面的设定里去找——作者写进人设的那种重要的人）。这张在 basedOn 填那个人的名字；如果就是用户，basedOnUser 也置 true；其余卡 basedOn 留空。
     每张：{ "name": "卡名", "kind": "character|world", "emoji": "🎭", "persona": "角色人设或世界设定(60字内)", "scenario": "初始场景/开场(40字内)", "basedOn": "照着谁(没有就空字符串)", "basedOnUser": false } ],
  "sessions": [ 1 段（最多 2 段）扮演记录。每段：{ "serviceName": "对应卡片名", "title": "剧情标题(12字内)", "cardName": "对应 cards 里的 name", "transcript": "..." } ]
}
**transcript 写法（重点，别写成短聊天）**：
- 长剧情小说体：第三人称叙事 + 引号对白；动作 / 神态 / 心理描写用 *星号* 包住（如 *她抬眼看你，睫毛轻颤*）。
- "我:" = 你(玩家 ${charName}) 敲进输入框的 RP，"对方:" = AI 扮演的角色，两边交替推进。
- **"我:"括号外只写故事场景里所扮角色的动作 / 对白**——绝不要写你现实里打字时的身体反应（盯屏幕、扔手机、吃东西、后背发凉等，那些不会被敲进输入框）。**（全角括号内）= 越过角色直接跟皮下 AI 本体说话**：骂它、OOC 提醒、指导它怎么演、指出它哪段不对。
- 每一轮都是有分量的一整段（至少 3-5 句，含场景/动作/对白/心理）；首轮"对方:"相当于开场白，把人物和场景立起来。
- 一段共 4-6 轮，每轮都要长、要有文学性和代入感。**整段以 "我:"(玩家)收尾**——停在你刚行动完、等对方角色回应的地方（方便别人接着以那张卡的身份续）。
要点：扮演内容（剧情里）暴露你的幻想 / 渴望 / 不敢实现的关系。酒馆是 TA 卸下防备的安全屋，扮演里可以流露平时藏起来的反差面（暴戾者忽然温柔、温柔者露出掌控/施虐欲、疏离者变黏人），但**底色始终是「爱」**，不刻意过火。`;
            }

            const fullPrompt = `\n\n### [Recent Chat Context]\n${recentMsgs}\n\n### [Task]\n${task}\n请结合「当前时间 / 距离上次联系」和人设，让内容贴合你近期的真实状态。只输出 JSON，不要解释。`;

            const content = await callLLM(fullPrompt);
            const now = Date.now();
            const rid = () => Math.random().toString(36).slice(2, 8);
            const newSessions: AiSession[] = [];
            const newCards: TavernCard[] = [];

            if (service === 'tavern') {
                const obj: any = extractJson(content) || {};
                // 卡片去重 + 永不顶掉：同名卡复用已有 id（不重建、不覆盖、不挤掉），只新增真正没有过的
                const nameToId: Record<string, string> = {};
                for (const c of (targetChar.phoneState?.aiAgent?.cards || [])) nameToId[normName(c.name)] = c.id;
                for (const c of (obj.cards || [])) {
                    if (!c?.name) continue;
                    const key = normName(c.name);
                    if (nameToId[key]) continue; // 已存在的卡保留原样，不动
                    const id = `card-${now}-${rid()}`;
                    nameToId[key] = id;
                    newCards.push({ id, name: c.name, kind: c.kind === 'world' ? 'world' : 'character', persona: c.persona || '', scenario: c.scenario || undefined, emoji: c.emoji || '🎭', basedOnUser: !!c.basedOnUser, basedOn: (c.basedOn && String(c.basedOn).trim()) || undefined, createdAt: now });
                }
                for (const sess of (obj.sessions || [])) {
                    if (!sess?.transcript) continue;
                    newSessions.push(normalizePhoneAiSession({
                        id: `ai-${now}-${rid()}`, service, serviceName: sess.serviceName || sess.cardName || '酒馆',
                        title: sess.title || '一段扮演', transcript: sess.transcript, cardId: nameToId[normName(sess.cardName || '')], updatedAt: now,
                    }));
                }
            } else {
                const parsed = extractJson(content);
                const arr: any[] = Array.isArray(parsed) ? parsed : [];
                for (const sess of arr) {
                    if (!sess?.transcript) continue;
                    newSessions.push(normalizePhoneAiSession({
                        id: `ai-${now}-${rid()}`, service, serviceName: sess.serviceName || (service === 'claude' ? 'Claude' : 'AI 助手'),
                        title: sess.title || '一段对话', transcript: sess.transcript, updatedAt: now,
                    }));
                }
            }

            if (!newSessions.length) { addToast('没抓到内容，再试一次', 'error'); return; }

            // 漏风：跟随查手机全局 sendToChat —— 开则往私聊塞一张卡片。
            // 措辞同样是「你自己手机上的 AI 记录」，第二人称，不暗示用户在偷看。
            if (pushToChat) {
                for (const sess of newSessions) {
                    // 放全文（卡片可折叠，进上下文也是完整记录），不再只取头两条
                    const full = parseTranscript(sess.transcript)
                        .map(t => `${t.isMe ? '我' : sess.serviceName}: ${t.text}`).join('\n');
                    await DB.saveMessage({
                        charId: targetChar.id, role: 'assistant', type: 'phone_card',
                        content: `[你手机的智能体 App·${svcName}] 你和 AI 的对话「${sess.title}」：\n${full}`,
                        metadata: { phoneCard: { app: '智能体', kind: `ai_${service}`, service, serviceName: sess.serviceName, title: sess.title, detail: full } },
                    } as any);
                }
            }

            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: cur.phoneState?.records || [],
                    aiAgent: {
                        sessions: [...newSessions, ...(cur.phoneState?.aiAgent?.sessions || [])],
                        // 已有的卡放前面、原位不动，新卡追加到后面——刷新永不顶掉旧卡
                        cards: [...(cur.phoneState?.aiAgent?.cards || []), ...newCards],
                    },
                },
            }));
            addToast(`偷看到 ${newSessions.length} 段 AI 对话`, 'success');
        } catch (e) {
            console.error(e);
            addToast('生成失败，请重试', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // 已折叠剧情的「前情提要」拼成 prompt 衔接块
    const recapOf = (s?: AiSession | null) => (s?.summaries?.length)
        ? `\n\n【前情提要（已折叠的早期剧情，仅供衔接，别重复）】\n${s.summaries.map((x, i) => `${i + 1}. ${x.content}`).join('\n')}`
        : '';

    // 函数式合并：只动指定会话
    const patchAiSession = (sessionId: string, patch: (s: AiSession) => AiSession) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                aiAgent: {
                    cards: cur.phoneState?.aiAgent?.cards || [],
                    sessions: (cur.phoneState?.aiAgent?.sessions || []).map(s => s.id === sessionId ? patch(normalizePhoneAiSession(s)) : s),
                },
            },
        }));
    };

    // 漏风：跟随全局 sendToChat，往私聊补一张痕迹卡（措辞第二人称，不暗示用户偷看）。
    // 传进来的 lines 原样放进去（调用方决定放整段还是这一轮），不再内部截断。
    const syncAiCardToChat = async (session: AiSession, lines: { isMe: boolean; text: string }[]) => {
        if (!targetChar || targetChar.phoneState?.sendToChat === false) return;
        const svcName = AI_SERVICES.find(x => x.id === session.service)?.name || 'AI';
        const body = lines.map(t => `${t.isMe ? '我' : session.serviceName}: ${t.text}`).join('\n');
        const verb = session.service === 'tavern' ? '对戏' : '对话';
        try {
            await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'phone_card',
                content: `[你手机的智能体 App·${svcName}] 你和「${session.serviceName}」的${verb}「${session.title}」：\n${body}`,
                metadata: { phoneCard: { app: '智能体', kind: `ai_${session.service}`, service: session.service, serviceName: session.serviceName, title: session.title, detail: body } },
            } as any);
        } catch (e) { console.error('ai card sync failed', e); }
    };

    // 长会话自动总结（参考 TRPG）：超 AI_SUMMARY_THRESHOLD 条就把旧剧情压成前情提要、折叠归档原文
    const maybeSummarizeSession = async (sessionId: string, latestTranscript: string) => {
        if (!targetChar) return;
        const lines = parseTranscript(latestTranscript);
        if (lines.length < AI_SUMMARY_THRESHOLD) return;
        const older = lines.slice(0, lines.length - AI_KEEP_RECENT);
        const recent = lines.slice(lines.length - AI_KEEP_RECENT);
        if (older.length < 10) return;
        const olderText = serializeTurns(older);
        const sess = (characters.find(c => c.id === targetChar.id) || targetChar).phoneState?.aiAgent?.sessions?.find(s => s.id === sessionId);
        try {
            const prevRecap = (sess?.summaries || []).map((x, i) => `【第${i + 1}段】${x.content}`).join('\n');
            const who = sess?.service === 'tavern'
                ? `酒馆角色扮演（"我"=玩家 ${charName}，"对方"=AI 扮的角色「${sess?.serviceName}」）`
                : `${charName} 和 AI「${sess?.serviceName}」的对话`;
            const prompt = `你是擅长写小说的记录者。把下面这段${who}总结成一段连贯、生动、像小说梗概的「前情提要」。
${prevRecap ? `\n【已有前情（仅供衔接，别重复）】\n${prevRecap}\n` : ''}
【本段需要总结的记录】
${olderText}

要求：第三人称，含起因→经过→结果，重点写人物关系/情绪的变化与暴露的心事，200~350 字，文笔流畅，不要分点、不要"总结如下"开场白。直接输出正文：`;
            let summaryText = (await callLLM(prompt, 0.7, false)).trim();
            if (!summaryText) summaryText = '（这段剧情继续推进了）';
            const now = Date.now();
            patchAiSession(sessionId, (s) => ({
                ...s,
                transcript: serializeTurns(recent),
                archived: [s.archived, olderText].filter(Boolean).join('\n'),
                summaries: [...(s.summaries || []), { id: `sum-${now}`, content: summaryText, createdAt: now }],
            }));
            addToast('早期剧情已折叠成前情提要', 'info');
        } catch (e) { console.error('ai summary failed', e); }
    };

    // 互动续写：assistant/claude = 你替机主问、AI 答；tavern = 你以卡片身份回、机主本色反应
    const handleAiSend = async () => {

        const session = selectedAiSession;
        const text = aiInput.trim();
        if (!session || !text || !targetChar || !effectiveApiConfig.apiKey) return;
        const isTavern = session.service === 'tavern';
        setAiSending(true);
        setAiInput('');
        try {
            // 潜入永远是「你扮 AI/卡（对方），LLM 演 char（我）」——三个服务统一
            const myPrefix: string = '对方';   // 你输入的这一行（你扮 AI / 卡）
            const replyPrefix: string = '我';  // LLM 续写的那一行（char 本人）
            const recap = recapOf(session);
            // 发出去就是发出去了：先把你这条立刻落库显示，再等对方回
            const transcript = `${session.transcript}\n${myPrefix}: ${text}`;
            patchAiSession(session.id, (s) => ({ ...s, transcript, updatedAt: Date.now() }));

            let prompt = '';
            if (isTavern) {
                const card = aiCards.find(c => c.id === session.cardId);
                await buildAiContext(targetChar);
                prompt = `\n\n你正在玩"酒馆"沉浸式长剧情角色扮演（像和 AI 合写小说）。你是玩家 ${charName}，对面是 AI 扮演的角色「${card?.name || session.serviceName}」${card?.persona ? `（人设：${card.persona}）` : ''}${card?.scenario ? `（背景：${card.scenario}）` : ''}${card?.basedOn ? `（这角色是照着你在意的「${card.basedOn}」捏的）` : ''}。
下面是对戏记录（"我:"=你/玩家，"对方:"=AI 扮的角色）。对方刚回了最新一段。
**最关键的前提：你非常清楚「对方」只是一个 AI 在扮演「${card?.name || session.serviceName}」这个角色——不是真人。** 正因为它是 AI、是你召来陪你玩的工具，你**握着绝对主导权**：可以随意对它下指令、调教它、OOC 它、让它重演、改设定。你绝不会把它错当成真人去迁就讨好。
**同时你是个有独立人格和意志的人**：有自己的脾气、立场、节奏和底线，该怼就怼、该愣就愣、不爽就不配合。对方写得好你才会被带动、真情流露（甚至流露平时藏起来的反差面：暴戾者忽然温柔、温柔者露出掌控欲 / 施虐欲、疏离者变黏人，底色是「爱」、不刻意过火）；写得烂或不对胃口，你完全可以不接、嫌弃、跳出来调教它。
**酒馆就是「你一层楼、AI 一层楼」交替，没有别的格式。** 现在轮到你（玩家）写这一层楼。
**【最重要：你的输出 = 你实际敲进输入框、发给 AI 的内容本身，只有两种，没有第三种】**
① **括号外 = 戏内 RP**：你扮演的角色在故事场景里的动作、神态、对白（小说体，第三人称叙事 + 「引号对白」+ *星号包动作*），3-5 句，推动剧情、是"演给 AI 那个角色看的"。
② **（全角括号内）= 跟"皮下那个 AI 本体"说话**（不是跟剧情里的角色，是越过角色、直接对扮演它的那个 AI 本身讲）。包括但不限于：**气急败坏地骂它、OOC 警告 / 提醒、指导它接下来该怎么演、指出它这段表现哪里不对**。例：（你这 AI 又 OOC 了，回到人设里）（演得太平淡，给我昂扬点）（这段逻辑崩了，TA 才不会这么说）（卧槽你怎么演得这么像现实里那个）。
**除这两种之外一律不写。** 你现实里做的事（盯屏幕、移鼠标、关掉程序、把手机扔开、咬薯片、起身倒水）、你身体的感受（后背发凉、指尖发麻）、以及你没打算发出去的私人碎碎念 / 内心盘算（"等会儿还要给谁改衣服""明天要早起"）——这些都**只发生在屏幕外**，你**不会把它们打进输入框**，所以**绝不出现在输出里**。哪怕你想退出，也是打一句（不玩了）而不是去描写"我关掉了程序"。
你是有独立意志的玩家、且清楚对面只是 AI（不是真人），该怼就怼、不爽就不配合、想调教就 OOC。括号可单独成段，也可跟戏内 RP 同段。
只输出你这层楼真正发出去的字，不要 "我:" 前缀、不要解释。${recap}\n\n${transcript}`;
            } else {
                // 潜入：你扮 AI（刚由你写完"对方:"那句），LLM 演 char 本人对这句的真实反应
                await buildAiContext(targetChar);
                const aiDesc = session.service === 'claude'
                    ? `一个像 Claude 那样的深度对话 AI「${session.serviceName}」（你的树洞，你会对它说当面对人说不出口的真心话）`
                    : `AI 助手「${session.serviceName}」（你拿它查东西 / 出主意 / 排解，它只是个工具）`;
                prompt = `\n\n你（${charName}）正在用手机和 ${aiDesc} 聊天。下面是对话（"我:"=你本人，"对方:"=那个 AI）。AI 刚回了最新一段，请以你的本色人设续写 "我:" 的下一句——你对它这句话的真实反应 / 追问 / 倾诉，贴合你的处境与心事。可以满意、可以失望、可以怼它答非所问、可以顺着深聊，别一味客气。别太长。只输出正文，不要前缀、不要解释。${recap}\n\n${transcript}`;
            }

            let reply = (await callLLM(prompt)).trim();
            reply = reply.replace(/^(我|对方|Me|Them|AI|助手)\s*[:：]\s*/i, '').trim();
            if (!reply) { addToast('对方没说话，再试一次', 'error'); return; }
            const full = `${transcript}\n${replyPrefix}: ${reply}`;
            const now = Date.now();
            patchAiSession(session.id, (s) => ({ ...s, transcript: full, updatedAt: now }));
            await syncAiCardToChat(session, [{ isMe: myPrefix === '我', text }, { isMe: replyPrefix === '我', text: reply }]);
            await maybeSummarizeSession(session.id, full);
        } catch (e) {
            console.error(e);
            addToast('发送失败', 'error');
            setAiInput(text);
        } finally {
            setAiSending(false);
        }
    };

    // 自然推进：不用 user 开口，让 LLM 接着剧情自己往下写一轮（双方都由 AI 演）
    const handleAiAutoContinue = async () => {

        const session = selectedAiSession;
        if (!session || !targetChar || !effectiveApiConfig.apiKey || aiSending) return;
        const isTavern = session.service === 'tavern';
        setAiSending(true);
        try {
            const recap = recapOf(session);
            const lastIsMe = parseTranscript(session.transcript).slice(-1)[0]?.isMe ?? false;
            let prompt = '';
            if (isTavern) {
                const card = aiCards.find(c => c.id === session.cardId);
                await buildAiContext(targetChar);
                prompt = `\n\n你在还原一段"酒馆"沉浸式长剧情角色扮演（像小说）。玩家是 ${charName}(本色人设)，AI 扮演角色「${card?.name || session.serviceName}」${card?.persona ? `（人设：${card.persona}）` : ''}${card?.scenario ? `（背景：${card.scenario}）` : ''}${card?.basedOn ? `（这角色照着 TA 在意的「${card.basedOn}」捏的，扮演里那份在意会渗出来）` : ''}。
**这是"替玩家跑一个完整回合"——所以要写"一来一回"两层楼**：先 AI 扮的角色「${card?.name || session.serviceName}」回应一段（"对方:"），再玩家 ${charName} 续一段（"我:"），承接最后一段（最后通常是"我:"，那就先"对方:"答、再"我:"续）。各 3-5 句小说体，*星号*包动作神态心理。**整段必须以 "我:"(玩家)收尾**（停在等对方处，方便随时接着玩）。
**"我:"是玩家敲进输入框的 RP——只写故事场景里所扮角色的动作/对白**，括号外绝不要写玩家现实里的身体反应（盯屏幕、扔手机、吃东西、后背发凉等，那不会被敲进输入框）；**（全角括号内）= 越过角色直接跟皮下 AI 本体说话**（骂它 / OOC 提醒 / 指导怎么演 / 指出哪段不对）。玩家保有独立人格、清楚对面只是 AI。
**两段都要带 "对方:" / "我:" 前缀，各自成行。** 不要解释。${recap}\n\n${session.transcript}`;
            } else {
                const persona = session.service === 'claude'
                    ? `Claude 那一卦：温和有洞察、正事办得好、肯认真接住；偶有"抱歉我无法/我理解你的感受但是"的边界感，但别一味回避，聊得越久越放得开、回避越少。`
                    : `这家 AI 助手按其刻板印象 + 八股说话：\n${AI_VENDOR_LORE}`;
                prompt = `你在还原「${charName}」和 AI「${session.serviceName}」的对话（"我:"=用户 ${charName}，"对方:"=AI）。${persona}
**替玩家跑一个完整回合（一来一回）**：承接最后一段——最后通常是"我:"(${charName} 刚发出、还没被回)，那就先"对方:"按那家口吻作答、再"我:"追问 / 倾诉一句（暴露 TA 的处境或心事）。**整段必须以 "我:"(${charName})收尾**（停在等 AI 回的地方）。**每行带 "我:"/"对方:" 前缀**，不要解释。${recap}\n\n${session.transcript}`;
            }
            let out = (await callLLM(prompt)).trim().replace(/```/g, '').trim();
            if (!/^(我|对方|Me|Them)\s*[:：]/m.test(out)) out = `${lastIsMe ? '对方' : '我'}: ${out}`;
            if (!out.trim()) { addToast('没续出内容，再试一次', 'error'); return; }
            const transcript = `${session.transcript}\n${out}`;
            const now = Date.now();
            patchAiSession(session.id, (s) => ({ ...s, transcript, updatedAt: now }));
            await syncAiCardToChat(session, parseTranscript(transcript).slice(-2));
            await maybeSummarizeSession(session.id, transcript);
        } catch (e) {
            console.error(e);
            addToast('续写失败', 'error');
        } finally {
            setAiSending(false);
        }
    };

    const handleDeleteAiSession = (id: string) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: cur.phoneState?.records || [],
                aiAgent: {
                    cards: cur.phoneState?.aiAgent?.cards || [],
                    sessions: (cur.phoneState?.aiAgent?.sessions || []).filter(s => s.id !== id),
                },
            },
        }));
        if (selectedAiSessionId === id) { setSelectedAiSessionId(null); setActiveAppId('aiagent'); }
    };

    // 会话内单条内容的"轮次"：酒馆按楼层(合并连续同说话人)，助手/树洞按行——与渲染里一致
    const turnsOf = (s: AiSession): { isMe: boolean; text: string }[] => {
        const lines = parseTranscript(s.transcript);
        if (s.service !== 'tavern') return lines;
        const floors: { isMe: boolean; text: string }[] = [];
        for (const ln of lines) {
            const prev = floors[floors.length - 1];
            if (prev && prev.isMe === ln.isMe) prev.text += '\n' + ln.text;
            else floors.push({ isMe: ln.isMe, text: ln.text });
        }
        return floors;
    };
    // 长按编辑会话里的某条内容
    const handleSaveAiTurn = () => {
        const s = selectedAiSession;
        if (!s || !aiTurnEdit) return;
        const turns = turnsOf(s);
        if (!turns[aiTurnEdit.idx]) { setAiTurnEdit(null); return; }
        turns[aiTurnEdit.idx] = { ...turns[aiTurnEdit.idx], text: aiTurnEdit.text };
        patchAiSession(s.id, (x) => ({ ...x, transcript: serializeTurns(turns), updatedAt: Date.now() }));
        setAiTurnEdit(null);
        addToast('已保存', 'success');
    };
    const handleDeleteAiTurn = (idx: number) => {
        const s = selectedAiSession;
        if (!s) return;
        const turns = turnsOf(s).filter((_, i) => i !== idx);
        patchAiSession(s.id, (x) => ({ ...x, transcript: serializeTurns(turns), updatedAt: Date.now() }));
    };

    const handleDeleteAiCard = (id: string) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                aiAgent: {
                    sessions: cur.phoneState?.aiAgent?.sessions || [],
                    cards: (cur.phoneState?.aiAgent?.cards || []).filter(c => c.id !== id),
                },
            },
        }));
    };

    // 保存长按编辑（会话改标题 / 卡片改名设场景 / 新建卡片）
    const handleSaveAiEdit = () => {
        if (!targetChar || !aiEdit) return;
        if (aiEdit.kind === 'session') {
            patchAiSession(aiEdit.id, (s) => ({ ...s, title: (aiEdit.title || s.title).trim() || s.title }));
        } else if (aiEdit.id === '__new__') {
            // 用户自己加一张卡
            const name = (aiEdit.name || '').trim();
            if (!name) { addToast('给卡片起个名字', 'error'); return; }
            const card: TavernCard = {
                id: `card-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                name, kind: aiEdit.cardKind === 'world' ? 'world' : 'character',
                emoji: aiEdit.emoji || '🎭', persona: aiEdit.persona || '', scenario: aiEdit.scenario || undefined, createdAt: Date.now(),
            };
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    aiAgent: {
                        sessions: cur.phoneState?.aiAgent?.sessions || [],
                        cards: [...(cur.phoneState?.aiAgent?.cards || []), card],
                    },
                },
            }));
        } else {
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    aiAgent: {
                        sessions: cur.phoneState?.aiAgent?.sessions || [],
                        cards: (cur.phoneState?.aiAgent?.cards || []).map(c => c.id === aiEdit.id ? {
                            ...c, name: (aiEdit.name || c.name).trim() || c.name, emoji: aiEdit.emoji || c.emoji,
                            persona: aiEdit.persona ?? c.persona, scenario: aiEdit.scenario ?? c.scenario,
                        } : c),
                    },
                },
            }));
        }
        setAiEdit(null);
        addToast('已保存', 'success');
    };

    // 用指定的卡开一局：生成一段以这张卡为对手的酒馆剧情（卡片本身不新增、不顶掉）
    const handlePlayCard = async (card: TavernCard) => {

        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('配置错误', 'error'); return; }
        setIsLoading(true);
        trackEvent('用角色卡开一局');
        try {
            const { recentMsgs } = await buildAiContext(targetChar);
            const task = `你（${charName}）在玩"酒馆"AI 角色扮演（沉浸式长剧情、像和 AI 合写小说）。这次的对手是你的角色卡「${card.name}」${card.kind === 'world' ? '（大型世界卡）' : ''}：
人设/设定：${card.persona || '（自行发挥，贴合卡名）'}${card.scenario ? `\n初始场景：${card.scenario}` : ''}
请生成 1 段你和这张卡的扮演记录。
**transcript 写法**：长剧情小说体，第三人称叙事 + 引号对白，动作/神态/心理用 *星号*；"我:" = 你(玩家 ${charName}) 敲进输入框的 RP，"对方:" = AI 扮的「${card.name}」，交替推进，4-6 轮，首轮"对方:"当开场白、**整段以 "我:"(玩家)收尾**（停在等对方回应处）。**"我:"括号外只写故事里所扮角色的动作/对白，不要写你现实里的身体反应（盯屏幕/扔手机/吃东西等）；（全角括号内）= 越过角色直接跟皮下 AI 本体说话（骂它/OOC 提醒/指导怎么演/指出哪段不对）。**
返回 JSON：{ "title": "剧情标题(12字内)", "transcript": "我: ...\\n对方: ..." }`;
            const fullPrompt = `\n\n### [Recent Chat Context]\n${recentMsgs}\n\n### [Task]\n${task}\n只输出 JSON，不要解释。`;
            const content = await callLLM(fullPrompt);
            const obj: any = extractJson(content) || {};
            if (!obj.transcript) { addToast('没生成出来，再试一次', 'error'); return; }
            const now = Date.now();
            const sess: AiSession = normalizePhoneAiSession({
                id: `ai-${now}-${Math.random().toString(36).slice(2, 6)}`, service: 'tavern',
                serviceName: card.name, title: obj.title || `与${card.name}的一局`, transcript: obj.transcript, cardId: card.id, updatedAt: now,
            });
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    aiAgent: {
                        cards: cur.phoneState?.aiAgent?.cards || [],
                        sessions: [sess, ...(cur.phoneState?.aiAgent?.sessions || [])],
                    },
                },
            }));
            await syncAiCardToChat(sess, parseTranscript(sess.transcript));
            setAiCardView(null);
            setSelectedAiSessionId(sess.id);
            setActiveAppId('ai_session');
        } catch (e) {
            console.error(e); addToast('生成失败', 'error');
        } finally { setIsLoading(false); }
    };

    // ============================================================
    //  人际关系系统 · Handlers
    // ============================================================

    // 通用：更新当前机主的 contacts（函数式合并，避免覆盖并发落库的 simLogs/records）
    const mutateContacts = (updater: (cs: PhoneContact[]) => PhoneContact[]) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], contacts: updater(cur.phoneState?.contacts || []) },
        }));
    };

    // 用户手动改关系：char 会察觉是用户在 TA 手机上动的手（落一条私聊系统提示，进入角色上下文）
    // 约束：是否允许虚构 NPC（关掉 = 只与神经链接里的真实角色来往）
    const toggleAllowFictional = () => {
        if (!targetChar) return;
        const next = !(targetChar.phoneState?.allowFictionalContacts !== false);
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], allowFictionalContacts: next },
        }));
        addToast(next ? '已允许 TA 结交虚构 NPC' : '已限定 · TA 只与神经链接里的角色来往', 'info');
        trackEvent('切换允许虚构 NPC 开关', { enabled: next ? 'on' : 'off' });
    };

    const handleSetContactStatus = (contact: PhoneContact, status: PhoneContact['status']) => {
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, status } : c));
        // 用户手动删/拉黑 → 落一张可解析的「关系变动」卡片：聊天里渲染成卡片，
        // content 又带进角色上下文，让 TA 察觉是用户干的。
        if (targetChar && (status === 'deleted' || status === 'blocked')) {
            const verb = status === 'deleted' ? '删除' : '拉黑';
            DB.saveMessage({
                charId: targetChar.id,
                role: 'assistant',
                type: 'phone_card',
                content: `[人际关系变动] ${userProfile.name} 在偷看你手机时，把你和「${contact.name}」的好友关系${verb}了。你察觉到是 TA 干的。`,
                metadata: {
                    phoneCard: {
                        app: '联系人',
                        kind: 'relationship',
                        action: status,          // 'deleted' | 'blocked'
                        actor: 'user',
                        by: userProfile.name,
                        contactName: contact.name,
                        title: `好友被${verb}`,
                        detail: `${userProfile.name} 把你和「${contact.name}」${verb}了。`,
                    },
                },
            } as any);
        }
        addToast(status === 'deleted' ? '已删好友' : status === 'blocked' ? '已拉黑' : status === 'friend' ? '已加好友' : '已更新', 'success');
    };

    // 用户手动调好感（拖动滑块）：只改这台手机对该联系人的好感，不动对方、不触发自动加删友
    const handleSetAffinity = (contact: PhoneContact, value: number) => {
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, affinity: clampAffinity(value) } : c));
    };

    const handleSaveNote = (contact: PhoneContact) => {
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, note: noteDraft } : c));
        setEditingNote(false);
        addToast('备注已保存', 'success');
    };

    // 真人联系人列表显示 identity 作为「备注名」。人工保存后锁定，避免下次扫描被模型覆盖。
    const handleSaveIdentity = (contact: PhoneContact) => {
        const identity = identityDraft.trim();
        mutateContacts(cs => cs.map(c => c.id === contact.id ? {
            ...c,
            identity: identity || undefined,
            identityManual: true,
        } : c));
        setEditingIdentity(false);
        addToast(identity ? '备注名已保存' : '已恢复显示真名', 'success');
    };

    // 彻底移除联系人：连同 TA 的聊天记录 + 私聊里的 phone_card 一起清；
    // 真人联系人（哪怕之前甄别/绑定错了）也把对方手机里的镜像联系人和记录一并删掉。
    const handleRemoveContact = async (contact: PhoneContact) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        // 机主侧：删 phone_card 私聊消息 + 联系人 + 其聊天记录
        for (const r of (targetChar.phoneState?.records || [])) {
            if (isChatWith(r, contact.id, contact.name) && r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
        }
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                contacts: (cur.phoneState?.contacts || []).filter(c => c.id !== contact.id),
                records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, contact.id, contact.name)),
            },
        }));
        // 对方侧（按当前 linkedCharId 找——绑错了删的就是那个错绑的角色，正是要清掉的）
        if (contact.kind === 'real' && contact.linkedCharId) {
            const b = characters.find(c => c.id === contact.linkedCharId);
            if (b) {
                const bContact = (b.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
                for (const r of (b.phoneState?.records || [])) {
                    if (isChatWith(r, bContact?.id, targetChar.name) && r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
                }
                updateCharacter(b.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        contacts: (cur.phoneState?.contacts || []).filter(c => !(bContact && c.id === bContact.id)),
                        records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, bContact?.id, targetChar.name)),
                    },
                }));
            }
        }
        setSelectedContact(null);
        setActiveAppId('contacts');
        addToast('联系人及相关记录已彻底移除', 'success');
    };

    // 联系人多选 / 批量删除
    const toggleContactSelect = (id: string) => setSelectedContactIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    const exitContactSelect = () => { setContactSelectMode(false); setSelectedContactIds([]); };
    // 批量「清空对话」：保留联系人，只把这几段聊天删掉重来（不满这轮生成时用）
    const handleBatchClearConversations = async () => {
        const ids = [...selectedContactIds];
        const targets = (targetChar?.phoneState?.contacts || []).filter(c => ids.includes(c.id));
        exitContactSelect();
        for (const c of targets) await handleClearContactConversation(c, true); // 静默，结尾统一一个 toast
        addToast(`已清空 ${targets.length} 段对话`, 'success');
    };

    // 改绑定：把联系人改绑到「正确的真实角色」或「转为虚构 NPC」，保留这段对话 + 备注 + 了解 + 好感。
    // 仔细处理各种情况：清掉旧的错绑镜像、给新角色建镜像、防自绑/重复绑/无变化。
    const handleRebindContact = async (
        contact: PhoneContact,
        target: { kind: 'npc' } | { kind: 'real'; charId: string },
    ) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        const myRec = (targetChar.phoneState?.records || []).find(r => isChatWith(r, contact.id, contact.name));

        const oldLinked = contact.kind === 'real' ? contact.linkedCharId : undefined;
        const newLinked = target.kind === 'real' ? target.charId : undefined;

        // 无变化的早退
        if (target.kind === 'npc' && contact.kind === 'npc') { addToast('TA 已经是虚构联系人', 'info'); setShowRebindModal(false); return; }
        if (target.kind === 'real' && contact.kind === 'real' && contact.linkedCharId === target.charId) { addToast('已经绑定 TA 了', 'info'); setShowRebindModal(false); return; }

        if (target.kind === 'real') {
            const d = characters.find(c => c.id === target.charId);
            if (!d) { addToast('角色不存在', 'error'); return; }
            if (d.id === targetChar.id) { addToast('不能把联系人绑定成 TA 自己', 'error'); return; }
            // 防重复：通讯录里已有「另一条」联系人对应这个角色
            const dupe = (targetChar.phoneState?.contacts || []).find(c => c.id !== contact.id && (c.linkedCharId === d.id || normName(c.name) === normName(d.name)));
            if (dupe) { addToast(`通讯录里已有「${dupe.name}」对应该角色，先处理掉再绑`, 'error'); return; }
        }

        setShowRebindModal(false);

        // 1) 清掉旧的真人镜像（原来绑的是真人、且目标换人/转虚构）
        if (oldLinked && oldLinked !== newLinked) {
            const ob = characters.find(c => c.id === oldLinked);
            if (ob) {
                const obContact = (ob.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
                for (const r of (ob.phoneState?.records || [])) {
                    if (isChatWith(r, obContact?.id, targetChar.name) && r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
                }
                updateCharacter(ob.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        contacts: (cur.phoneState?.contacts || []).filter(c => !(obContact && c.id === obContact.id)),
                        records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, obContact?.id, targetChar.name)),
                    },
                }));
            }
        }

        if (target.kind === 'real') {
            const d = characters.find(c => c.id === target.charId)!;
            // 2) 机主侧：改 kind/linkedCharId/名字（真人联系人显示真实角色名+头像），同步记录标题
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id
                        ? { ...c, kind: 'real' as const, linkedCharId: d.id, name: d.name, avatar: undefined }
                        : c),
                    records: (cur.phoneState?.records || []).map(r => (myRec && r.id === myRec.id) ? { ...r, title: d.name } : r),
                },
            }));
            // 3) 给新角色建镜像（把现有 A 视角对话翻转过去）
            if (myRec?.detail) {
                const flipped = flipTranscript(myRec.detail);
                const now = Date.now();
                updateCharacter(d.id, (cur) => {
                    const cs = upsertContact(cur.phoneState?.contacts || [], {
                        name: targetChar.name, kind: 'real', linkedCharId: targetChar.id, avatar: targetChar.avatar, lastInteraction: now,
                    });
                    const cid = cs.find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name))?.id;
                    const recs = cur.phoneState?.records || [];
                    const ex = recs.find(r => r.type === 'chat' && (r.contactId === cid || normName(r.title) === normName(targetChar.name)));
                    const next = ex
                        ? recs.map(r => r.id === ex.id ? { ...r, detail: flipped, timestamp: now, contactId: cid } : r)
                        : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat' as const, title: targetChar.name, detail: flipped, timestamp: now, contactId: cid }];
                    return { phoneState: { ...cur.phoneState, contacts: cs, records: next } };
                });
            }
            addToast(`已改绑到「${d.name}」`, 'success');
        } else {
            // 目标=虚构：去掉真实绑定与真人头像，对话/备注/了解/好感都留着
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: cur.phoneState?.records || [],
                    contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id
                        ? { ...c, kind: 'npc' as const, linkedCharId: undefined, avatar: undefined }
                        : c),
                },
            }));
            addToast('已转为虚构联系人', 'success');
        }
    };

    const handleCreateContact = () => {
        if (!targetChar) return;
        let name = ncName.trim();
        let linkedCharId: string | undefined;
        if (ncKind === 'real') {
            const rc = characters.find(c => c.id === ncLinkedId);
            if (!rc) { addToast('请选择要绑定的真实角色', 'error'); return; }
            name = rc.name; linkedCharId = rc.id;
        } else if (!name) {
            addToast('请填写联系人名字', 'error'); return;
        }
        mutateContacts(cs => upsertContact(cs, { name, kind: ncKind, linkedCharId, affinity: 0, status: 'friend' }));
        setShowContactModal(false);
        setNcName(''); setNcKind('npc'); setNcLinkedId('');
        addToast('已添加联系人', 'success');
        trackEvent('手动添加一位联系人', { contactKind: ncKind });
    };

    // 给某个机主侧落一段真实对话：更新好感/状态 + 写 chat 记录 + （机主开了同步才）镜像进私聊 + 自动加删友播报
    const commitConversationSide = async (
        owner: CharacterProfile, partnerName: string, partnerCharId: string,
        detail: string, delta: number, partnerNote?: string, learnedNew?: string, seedIdentity?: string,
    ) => {
        const timestamp = Date.now();
        const result = {
            partnerName, partnerCharId, detail, delta, partnerNote, learnedNew, seedIdentity,
            timestamp, recordId: `rec-${timestamp}-${Math.random()}`,
        };
        const contact = owner.phoneState?.contacts?.find(c => c.linkedCharId === partnerCharId || normName(c.name) === normName(partnerName));
        const existing = owner.phoneState?.records?.find(r => r.type === 'chat'
            && ((contact && r.contactId === contact.id) || (!r.contactId && normName(r.title) === normName(partnerName))));
        const ownerSendToChat = owner.phoneState?.sendToChat !== false;
        let msgId: number | undefined;
        if (ownerSendToChat) {
            // 续写时先删掉这段对话上一张卡，私聊里只留一张最新完整的（不再 AB / ABC 堆叠）
            if (existing?.systemMessageId) await DB.deleteMessage(existing.systemMessageId);
            msgId = await DB.saveMessage({
                charId: owner.id, role: 'assistant', type: 'phone_card',
                content: `[你手机的聊天软件] 你和「${partnerName}」的对话：${detail.replace(/\n/g, ' ')}`,
                metadata: { phoneCard: { app: '聊天软件', kind: 'chat', title: partnerName, detail } },
            } as any);
        }
        // 自动加删友播报：进机主与用户的私聊（同样受 sendToChat 控制）
        const { broadcast } = applyRealConversationToPhoneState(owner.phoneState, result);
        if (broadcast && ownerSendToChat) {
            await DB.saveMessage({ charId: owner.id, role: 'assistant', type: 'text', content: broadcast } as any);
        }
        updateCharacter(owner.id, (cur) => ({
            phoneState: applyRealConversationToPhoneState(cur.phoneState, { ...result, systemMessageId: msgId }).phoneState,
        }));
    };

    // 聊满 100 条触发总结：把待归档的每 100 条原文，A/B 各自第一人称浓缩成一条话题盒记忆，推进水位线。
    // 原文仍留在 record.detail（用户能看），只是不再进上下文。
    const ARCHIVE_EVERY = 100;
    const maybeArchiveConversation = async (aContact: PhoneContact, b: CharacterProfile, aFull: string) => {
        if (!targetChar) return;
        const aLines = parseTranscript(aFull);
        const startMark = aContact.archivedThru ?? 0;
        let mark = startMark;
        const aTopics: ConvTopic[] = [];
        const bTopics: ConvTopic[] = [];
        while (aLines.length - mark >= ARCHIVE_EVERY) {
            const aChunk = serializeTurns(aLines.slice(mark, mark + ARCHIVE_EVERY));
            const bChunk = flipTranscript(aChunk);
            const [aSum, bSum] = await Promise.all([
                summarizeConversation({ api: effectiveApiConfig as any, speakerName: targetChar.name, otherName: b.name, transcript: aChunk }),
                summarizeConversation({ api: effectiveApiConfig as any, speakerName: b.name, otherName: targetChar.name, transcript: bChunk }),
            ]);
            const ts = Date.now();
            const mk = () => `tp-${ts}-${Math.random().toString(36).slice(2, 7)}`;
            if (aSum) aTopics.push({ id: mk(), text: aSum, createdAt: ts, span: ARCHIVE_EVERY });
            if (bSum) bTopics.push({ id: mk(), text: bSum, createdAt: ts, span: ARCHIVE_EVERY });
            mark += ARCHIVE_EVERY;
        }
        if (mark === startMark) return; // 没满 100，不归档
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                contacts: (cur.phoneState?.contacts || []).map(c => c.id === aContact.id
                    ? { ...c, topicBox: [...(c.topicBox || []), ...aTopics], archivedThru: mark } : c),
            },
        }));
        updateCharacter(b.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                contacts: (cur.phoneState?.contacts || []).map(c => (c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name))
                    ? { ...c, topicBox: [...(c.topicBox || []), ...bTopics], archivedThru: mark } : c),
            },
        }));
        addToast(`已把更早的 ${mark} 条聊天归档成话题记忆`, 'info');
    };

    // P1：真角色双向对话（A 发 B 回，双 LLM，镜像到 B）
    const handleRealConversation = async (contact: PhoneContact) => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('请先配置 API', 'error'); return; }
        const b = characters.find(c => c.id === contact.linkedCharId);
        if (!b) { addToast('该联系人未绑定真实角色', 'error'); return; }
        setIsLoading(true);
        trackEvent('生成一段与联系人的对话', { contactKind: 'real' });
        try {
            const existing = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === contact.id || normName(r.title) === normName(contact.name)));
            const bToA = (b.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
            // 上下文压缩：归档过的原文(0~archivedThru)不再进上下文，只喂「话题盒总结 + 近段原文」。
            const aAllLines = parseTranscript(existing?.detail || '');
            const aArchived = Math.min(contact.archivedThru ?? 0, aAllLines.length);
            const archivedALines = aAllLines.slice(0, aArchived);            // 留着给用户看的原文
            const recentDetail = serializeTurns(aAllLines.slice(aArchived));  // 喂上下文的近段
            const result = await runRealConversation({
                a: targetChar, b, user: userProfile, api: effectiveApiConfig as any,
                affinityA: contact.affinity, affinityB: bToA?.affinity ?? 0,
                existingDetail: recentDetail,
                // bNote = A 对 B 的备注（喂给 A）；aNote = B 对 A 的备注（喂给 B）。别接反。
                aNote: bToA?.note, bNote: contact.note,
                bLearned: contact.learned, aLearned: bToA?.learned,
                aSummary: topicText(contact.topicBox), bSummary: topicText(bToA?.topicBox),
            });
            if (!result.aDetail.trim()) { addToast('对方没有回应…', 'error'); return; }
            // 把归档段拼回去，存「完整原文」给用户看（上下文用的是压缩版，互不影响）
            const aFull = serializeTurns([...archivedALines, ...parseTranscript(result.aDetail)]);
            const bFull = flipTranscript(aFull);
            // A 学到的写进 A 对 B 的了解；B 学到的写进 B 对 A 的了解。
            // 若对方通讯录里还没有自己，commitConversationSide 会先建好联系人（带名字+起始备注名）再挂消息。
            await commitConversationSide(targetChar, contact.name, b.id, aFull, result.aDelta, contact.note, result.aLearnedNew, contact.identity);
            await commitConversationSide(b, targetChar.name, targetChar.id, bFull, result.bDelta, bToA?.note, result.bLearnedNew, contact.identity);
            // 聊满 100 条 → 各自第一人称总结归档进话题盒
            await maybeArchiveConversation(contact, b, aFull);
            addToast(`${targetChar.name} 和 ${b.name} 聊了一会儿`, 'success');
        } catch (e) {
            console.error(e);
            addToast('真实对话生成失败', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // 与虚构 NPC 的对话（机主脑补，单 LLM，纯虚构、不镜像）
    const handleNpcConversation = async (contact: PhoneContact) => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('请先配置 API', 'error'); return; }
        setIsLoading(true);
        trackEvent('生成一段与联系人的对话', { contactKind: 'npc' });
        try {
            const existing = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === contact.id || normName(r.title) === normName(contact.name)));
            const { detail, learnedNew } = await runNpcConversation({
                host: targetChar, user: userProfile, api: effectiveApiConfig as any,
                npcName: contact.name, identity: contact.identity, note: contact.note,
                learned: contact.learned, rounds: 4, existingDetail: existing?.detail,
            });
            if (!detail.trim()) { addToast('对方没有回应', 'error'); return; }
            const now = Date.now();
            // 同步到私聊：和真人对话一致，落一张 phone_card（受 sendToChat 控制）。
            // 续写时先删掉上一张卡片再发新的，避免同一段对话越堆越多。
            const pushToChat = targetChar.phoneState?.sendToChat !== false;
            let msgId: number | undefined;
            if (pushToChat) {
                if (existing?.systemMessageId) await DB.deleteMessage(existing.systemMessageId);
                msgId = await DB.saveMessage({
                    charId: targetChar.id, role: 'assistant', type: 'phone_card',
                    content: `[你手机的聊天软件] 你和「${contact.name}」的对话：${detail.replace(/\n/g, ' ')}`,
                    metadata: { phoneCard: { app: '聊天软件', kind: 'chat', title: contact.name, detail } },
                } as any);
            }
            updateCharacter(targetChar.id, (cur) => {
                const recs = cur.phoneState?.records || [];
                const next = existing
                    ? recs.map(r => r.id === existing.id ? { ...r, detail, timestamp: now, systemMessageId: msgId ?? r.systemMessageId } : r)
                    : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat', title: contact.name, detail, timestamp: now, contactId: contact.id, systemMessageId: msgId }];
                // 把这次脑补出来的新设定累积进该 NPC 的「了解」，保持下次一致
                const contactsNext = learnedNew
                    ? (cur.phoneState?.contacts || []).map(c => c.id === contact.id ? { ...c, learned: appendLearned(c.learned, learnedNew) } : c)
                    : cur.phoneState?.contacts;
                return { phoneState: { ...cur.phoneState, records: next, ...(contactsNext ? { contacts: contactsNext } : {}) } };
            });
            addToast(pushToChat ? '偷看到一段对话 · 已同步私聊' : '偷看到一段对话', 'success');
        } catch (e) {
            console.error(e);
            addToast('对话生成失败', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // 清空某联系人的这段对话（生成错位/不满意时一键抹掉重来）。
    // 真人联系人连对方手机里的镜像记录一起清，保持两边一致。
    const handleClearContactConversation = async (contact: PhoneContact, silent = false) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        // 机主侧：删聊天记录 + 清这段对话派生的话题盒记忆/水位线（删了重来＝干净起点）
        const myRec = (targetChar.phoneState?.records || []).find(r => isChatWith(r, contact.id, contact.name));
        if (myRec?.systemMessageId) await DB.deleteMessage(myRec.systemMessageId);
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, contact.id, contact.name)),
                contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id ? { ...c, topicBox: [], archivedThru: 0 } : c),
            },
        }));
        // 对方侧镜像（真人）：同样清记录 + 话题盒/水位线
        if (contact.kind === 'real' && contact.linkedCharId) {
            const b = characters.find(c => c.id === contact.linkedCharId);
            if (b) {
                const bContact = (b.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
                const bRec = (b.phoneState?.records || []).find(r => isChatWith(r, bContact?.id, targetChar.name));
                if (bRec?.systemMessageId) await DB.deleteMessage(bRec.systemMessageId);
                updateCharacter(b.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, bContact?.id, targetChar.name)),
                        contacts: (cur.phoneState?.contacts || []).map(c => (bContact && c.id === bContact.id) ? { ...c, topicBox: [], archivedThru: 0 } : c),
                    },
                }));
            }
        }
        if (!silent) addToast('已清空这段对话', 'success');
    };

    // 把「编辑后的 A 视角脚本」落库：刷新机主侧记录/卡片 + 真人镜像 + 同步 archivedThru；全删空则移除记录。
    const saveEditedConversation = async (c: PhoneContact, newDetail: string, newArchived: number) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        const has = !!newDetail.trim();
        // 机主侧卡片刷新
        const ownerRec = (targetChar.phoneState?.records || []).find(r => isChatWith(r, c.id, c.name));
        if (ownerRec?.systemMessageId) await DB.deleteMessage(ownerRec.systemMessageId);
        let msgId: number | undefined;
        if (has && targetChar.phoneState?.sendToChat !== false) {
            msgId = await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'phone_card',
                content: `[你手机的聊天软件] 你和「${c.name}」的对话：${newDetail.replace(/\n/g, ' ')}`,
                metadata: { phoneCard: { app: '聊天软件', kind: 'chat', title: c.name, detail: newDetail } },
            } as any);
        }
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: has
                    ? (cur.phoneState?.records || []).map(r => isChatWith(r, c.id, c.name) ? { ...r, detail: newDetail, timestamp: Date.now(), systemMessageId: msgId } : r)
                    : (cur.phoneState?.records || []).filter(r => !isChatWith(r, c.id, c.name)),
                contacts: (cur.phoneState?.contacts || []).map(x => x.id === c.id ? { ...x, archivedThru: newArchived } : x),
            },
        }));
        // 真人镜像
        if (c.kind === 'real' && c.linkedCharId) {
            const b = characters.find(x => x.id === c.linkedCharId);
            if (b) {
                const bDetail = flipTranscript(newDetail);
                const bHas = !!bDetail.trim();
                const bContact = (b.phoneState?.contacts || []).find(x => x.linkedCharId === targetChar.id || normName(x.name) === normName(targetChar.name));
                const bRec = (b.phoneState?.records || []).find(r => isChatWith(r, bContact?.id, targetChar.name));
                if (bRec?.systemMessageId) await DB.deleteMessage(bRec.systemMessageId);
                let bMsgId: number | undefined;
                if (bHas && b.phoneState?.sendToChat !== false) {
                    bMsgId = await DB.saveMessage({
                        charId: b.id, role: 'assistant', type: 'phone_card',
                        content: `[你手机的聊天软件] 你和「${targetChar.name}」的对话：${bDetail.replace(/\n/g, ' ')}`,
                        metadata: { phoneCard: { app: '聊天软件', kind: 'chat', title: targetChar.name, detail: bDetail } },
                    } as any);
                }
                updateCharacter(b.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        records: bHas
                            ? (cur.phoneState?.records || []).map(r => isChatWith(r, bContact?.id, targetChar.name) ? { ...r, detail: bDetail, timestamp: Date.now(), systemMessageId: bMsgId } : r)
                            : (cur.phoneState?.records || []).filter(r => !isChatWith(r, bContact?.id, targetChar.name)),
                        contacts: (cur.phoneState?.contacts || []).map(x => (bContact && x.id === bContact.id) ? { ...x, archivedThru: newArchived } : x),
                    },
                }));
            }
        }
    };

    const exitMsgSelect = () => { setMsgSelectMode(false); setSelectedMsgIdx([]); };
    // 删掉聊天里选中的几条气泡（按完整脚本的下标），重排回脚本落库
    const handleDeleteSelectedMessages = async () => {
        if (!targetChar || !selectedContact || !selectedMsgIdx.length) { exitMsgSelect(); return; }
        const c = selectedContact;
        const rec = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === c.id || normName(r.title) === normName(c.name)));
        if (!rec) { exitMsgSelect(); return; }
        const turns = parseTranscript(rec.detail);
        const sel = new Set(selectedMsgIdx);
        const deletedInArchived = [...sel].filter(i => i < (c.archivedThru ?? 0)).length;
        const keep = turns.filter((_, i) => !sel.has(i));
        const newDetail = serializeTurns(keep);
        const newArchived = Math.max(0, (c.archivedThru ?? 0) - deletedInArchived);
        await saveEditedConversation(c, newDetail, newArchived);
        addToast(`已删除 ${sel.size} 条`, 'success');
        exitMsgSelect();
    };

    // ----- 人格模拟：后台生成（生成期间用户可离开本 App 去别处逛） -----
    const runSim = async (m: 'daily' | 'event', t: string, presence: 'default' | 'light' | 'none' = 'default', tone: 'mix' | 'depressive' | 'darkhumor' | 'cute' = 'mix') => {
        if (!targetChar) return;
        if (!effectiveApiConfig.apiKey) { addToast('请先配置 API', 'error'); return; }
        const cid = targetChar.id, cname = targetChar.name;
        personaSimStore.set({ status: 'loading', mode: m, theme: t, charId: cid, charName: cname });
        // 只报模式（日常/事件）这个固定枚举；主题 t 是用户自己写的文本，不上报
        trackEvent('生成人格模拟演出', { mode: m });
        try {
            const generated = await generatePersonaScript({
                char: targetChar, userProfile, apiConfig: effectiveApiConfig as any, mode: m, theme: t, userPresence: presence, tone,
            });
            const log = createPersonaSimLog(generated, m, t);
            updateCharacter(cid, cur => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    simLogs: [log, ...(cur.phoneState?.simLogs || [])],
                },
            }));
            personaSimStore.set({ status: 'ready', mode: m, theme: t, script: generated, logId: log.id, charId: cid, charName: cname });
            addToast('演出已就绪', 'success');
        } catch (e) {
            console.error(e);
            personaSimStore.set({ status: 'error', mode: m, theme: t, charId: cid, charName: cname });
            addToast('演出生成失败，请重试', 'error');
        }
    };

    const requestDeleteSimLog = (log: PhoneSimLog) => {
        if (!targetChar) return;
        const charId = targetChar.id;
        askConfirm({
            title: `删除生活记录「${log.title}」？`,
            desc: '这条记录和用于重播的演出脚本会一并删除，无法撤销。已经发送给 TA 的回忆不会被撤回。',
            confirmLabel: '删除',
            danger: true,
            onConfirm: () => {
                updateCharacter(charId, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        records: cur.phoneState?.records || [],
                        simLogs: (cur.phoneState?.simLogs || []).filter(item => item.id !== log.id),
                    },
                }));
                addToast('已删除生活记录', 'success');
            },
        });
    };

    // 全局指示条点击后请求深链：直接进入对应角色的演出
    useEffect(() => {
        if (sim.deepLink && sim.charId) {
            const c = characters.find(x => x.id === sim.charId);
            if (c) {
                setTargetChar(c);
                setView('phone');
                setActiveAppId('persona');
            }
            personaSimStore.clearDeepLink();
        }
    }, [sim.deepLink, sim.charId, characters]);

    // ============================================================
    //  DERIVED STATS  (drive the "living" home screen)
    // ============================================================
    const charName = targetChar?.name || 'Unknown Device';
    const allSorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
    const chatRecords = records.filter(r => r.type === 'chat');
    const orderRecords = records.filter(r => r.type === 'order');
    const deliveryRecords = records.filter(r => r.type === 'delivery');
    const socialRecords = records.filter(r => r.type === 'social');
    const simLogCount = targetChar?.phoneState?.simLogs?.length || 0;
    const sendToChat = targetChar?.phoneState?.sendToChat !== false; // 默认开
    const lastInner = targetChar ? getLastInnerState(targetChar.id) : '';
    const lastTs = allSorted[0]?.timestamp;

    const appLabel = (type: string): string => {
        switch (type) {
            case 'chat': return '聊天';
            case 'order': return '淘宝';
            case 'delivery': return '外卖';
            case 'social': return '朋友圈';
            case 'call': return '通话';
            default: return customApps.find(a => a.id === type)?.name || 'App';
        }
    };

    const syncEvidenceRecordToChat = async (record: PhoneEvidence) => {
        if (!targetChar) return;
        try {
            if (record.systemMessageId) {
                const existing = await DB.getMessageById(record.systemMessageId);
                if (existing) {
                    addToast('这条记录已经同步到私聊', 'info');
                    setEvidenceMenu(null);
                    return;
                }
            }
            const app = record.type === 'chat' ? '聊天软件' : appLabel(record.type);
            const card = buildPhoneEvidenceChatCard(record, app);
            const messageId = await DB.saveMessage({
                charId: targetChar.id,
                role: 'assistant',
                type: 'phone_card',
                content: card.content,
                metadata: card.metadata,
            } as any);
            updateCharacter(targetChar.id, (current) => ({
                phoneState: {
                    ...current.phoneState,
                    records: (current.phoneState?.records || []).map(item => item.id === record.id
                        ? { ...item, systemMessageId: messageId }
                        : item),
                },
            }));
            if (selectedEvidenceRecord?.id === record.id) {
                setSelectedEvidenceRecord({ ...selectedEvidenceRecord, systemMessageId: messageId });
            }
            if (selectedChatRecord?.id === record.id) {
                setSelectedChatRecord({ ...selectedChatRecord, systemMessageId: messageId });
            }
            setEvidenceMenu(null);
            addToast('已把这条查手机记录同步到私聊', 'success');
            trackEvent('事后同步查手机记录到私聊', { kind: record.type });
        } catch (error: any) {
            addToast(error?.message || '同步失败，请重试', 'error');
        }
    };

    const fmtClock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const lastSeenText = (() => {
        if (!lastTs) return 'Awaiting first sync';
        const d = Date.now() - lastTs;
        const days = Math.floor(d / 86400000);
        const hrs = Math.floor(d / 3600000);
        const mins = Math.floor(d / 60000);
        if (days > 0) return `Last seen ${days}d ago`;
        if (hrs > 0) return `Last seen ${hrs}h ago`;
        if (mins > 0) return `Last seen ${mins}m ago`;
        return 'Online now';
    })();

    const foodSub = deliveryRecords.length
        ? (() => {
            const t = Math.max(...deliveryRecords.map(r => r.timestamp));
            const days = Math.floor((Date.now() - t) / 86400000);
            return days <= 0 ? 'ordered today' : `last order ${days}d ago`;
        })()
        : 'no orders yet';

    const momentsSub = socialRecords.length ? `${socialRecords.length} new posts` : 'nothing shared';
    const taobaoSub = orderRecords.length ? `${orderRecords.length} items in cart` : 'cart is empty';
    // 「联系人」主卡副标题：TA 通讯录里的人数（不含用户自己）
    const contactCount = contacts.filter(c => !isUserName(c.name)).length;
    const contactsSub = contactCount ? `${contactCount} 位联系人` : 'tap to scan';
    const aiSub = aiSessions.length ? `${aiSessions.length} 段对话 · TA 的小手机` : 'tap to peek';

    // pseudo screen-time + weather (decorative, deterministic per char)
    const seed = charName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const temp = 16 + (seed % 14);
    const screenMin = 64 + records.length * 11 + (seed % 40);
    const stH = Math.floor(screenMin / 60);
    const stM = screenMin % 60;
    const ringP = Math.min(0.94, screenMin / 360);
    const RING_C = 2 * Math.PI * 42;

    const activity = (() => {
        const items = allSorted.slice(0, 4).reverse().map(r => ({ t: r.timestamp, label: `打开${appLabel(r.type)}` }));
        if (lastTs) items.push({ t: Date.now(), label: '锁屏' });
        return items;
    })();

    const now = new Date();
    const clockNow = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateNow = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const fallbackQuote = targetChar?.socialProfile?.bio || '“有些话，隔着屏幕，反而更接近真实。”';
    const innerQuote = lastInner.trim();

    // ============================================================
    //  SUB-APPS
    // ============================================================
    // 找出某条聊天记录对应的联系人（用于复用真人头像）
    const contactOfRecord = (r: PhoneEvidence): PhoneContact | undefined =>
        contacts.find(c => (r.contactId && c.id === r.contactId) || normName(c.name) === normName(r.title));

    const renderChatList = () => {
        const accent = '#8b9cff';
        const list = records.filter(r => r.type === 'chat').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Messages" sub="已归档 · 只读" accent={accent} onBack={() => setActiveAppId('home')}
                    right={list.length > 0 ? (
                        <button onClick={() => askConfirm({
                            title: '清空全部聊天记录？', desc: `将删除这台手机里归档的全部 ${list.length} 段聊天记录，且无法恢复。`,
                            confirmLabel: '清空', danger: true, onConfirm: handleClearAllChats,
                        })} className="text-rose-300/80 active:scale-90 transition"><Trash size={18} weight="bold" /></button>
                    ) : undefined} />
                {/* 归档说明：旧的 Messages 模式已不再更新，新的对话走「人际关系」 */}
                <div className="px-4 pt-1 pb-2 shrink-0">
                    <div className="rounded-xl px-3 py-2 bg-white/[0.04] border border-white/[0.07] text-[11px] text-white/55 leading-relaxed">
                        这是旧版聊天归档，已停止更新。新的来往请在「联系人」里发起；可把某段记录绑定过去。
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 space-y-2.5 no-scrollbar pb-28 overscroll-contain">
                    {list.length === 0 && <EmptyState text="归档里没有聊天记录" />}
                    {list.map(r => {
                        const segs = parseTranscript(r.detail);
                        const last = segs.length ? segs[segs.length - 1].text : '...';
                        const av = contactOfRecord(r) ? contactAvatar(contactOfRecord(r)!) : undefined;
                        return (
                            <div key={r.id} {...longPress(() => setEvidenceMenu({ record: r, backAppId: 'chat' }))}
                                onClick={() => {
                                    if (lpFired.current) { lpFired.current = false; return; }
                                    setSelectedChatRecord(r); setTranscriptExpanded(false); setActiveAppId('chat_detail');
                                }}
                                className="group relative flex items-center gap-3.5 rounded-2xl p-3.5 bg-white/[0.035] border border-white/[0.06] active:scale-[0.99] transition cursor-pointer animate-fade-in">
                                {av ? (
                                    <TokenImg value={av} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
                                ) : (
                                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold text-lg"
                                        style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)`, boxShadow: `inset 0 0 18px ${accent}25` }}>
                                        {r.title[0]}
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-baseline gap-2">
                                        <span className="font-semibold text-[13.5px] text-white/95 truncate">{r.title}</span>
                                        <span className="text-[10px] text-white/35 tabular-nums shrink-0">{fmtClock(r.timestamp)}</span>
                                    </div>
                                    <div className="text-[11.5px] text-white/45 truncate mt-0.5">{last}</div>
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); askConfirm({
                                    title: '删除这段聊天记录？', desc: `「${r.title}」的这段归档记录将被删除。`,
                                    confirmLabel: '删除', danger: true, onConfirm: () => handleDeleteRecord(r),
                                }); }}
                                    className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                            </div>
                        );
                    })}
                </div>
            </SubAppShell>
        );
    };

    const renderChatDetail = () => {
        if (!selectedChatRecord || !targetChar) return null;
        const accent = '#8b9cff';
        // 带前缀继承的解析：多行消息(连发几条)的续行跟随上一条说话人，不再错位给对方。
        const parsedLines = parseTranscript(selectedChatRecord.detail).map(t => ({ isMe: t.isMe, content: t.text }));
        // 渲染保护：长 transcript 默认只渲染最新 50 行，避免一次性塞太多气泡把页面卡爆（同 chatapp）
        const RENDER_CAP = 50;
        const hiddenCount = transcriptExpanded ? 0 : Math.max(0, parsedLines.length - RENDER_CAP);
        const shownLines = hiddenCount > 0 ? parsedLines.slice(-RENDER_CAP) : parsedLines;
        const contact = contactOfRecord(selectedChatRecord);
        const partnerAvatar = contact ? contactAvatar(contact) : undefined;
        const linkedReal = contact && contact.kind === 'real' && !!contact.linkedCharId;

        return (
            <SubAppShell>
                <TermHeader title={selectedChatRecord.title} sub="归档 · 只读" accent={accent} onBack={() => setActiveAppId('chat')} />
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {hiddenCount > 0 && (
                        <button onClick={() => setTranscriptExpanded(true)}
                            className="w-full py-2 mb-1 rounded-xl text-[11.5px] font-semibold text-white/55 bg-white/[0.04] border border-white/[0.07] active:scale-[0.99] transition">
                            ▲ 展开更早的 {hiddenCount} 条消息
                        </button>
                    )}
                    {shownLines.map((msg, idx) => (
                        <div key={idx} className={`flex items-end gap-2 ${msg.isMe ? 'justify-end' : 'justify-start'}`}>
                            {!msg.isMe && (
                                partnerAvatar ? (
                                    <TokenImg value={partnerAvatar} alt="" className="w-8 h-8 rounded-xl object-cover shrink-0" />
                                ) : (
                                    <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs text-white shrink-0"
                                        style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>
                                        {selectedChatRecord.title[0]}
                                    </div>
                                )
                            )}
                            <div className={`px-3.5 py-2.5 rounded-2xl max-w-[74%] text-[13px] leading-relaxed break-words ${
                                msg.isMe
                                    ? 'text-white rounded-br-md'
                                    : 'bg-white/[0.07] text-white/90 border border-white/[0.06] rounded-bl-md'
                                }`}
                                style={msg.isMe ? { background: `linear-gradient(135deg, ${accent}, ${accent}bb)` } : undefined}>
                                {msg.content}
                            </div>
                            {msg.isMe && <TokenImg value={targetChar.avatar} className="w-8 h-8 rounded-xl object-cover shrink-0" />}
                        </div>
                    ))}
                    <div ref={chatEndRef} />
                </div>
                {/* 归档只读：不再生成后续；改为「绑定到人际关系」（真人会双向同步） */}
                <div className="shrink-0 w-full p-4 pb-6">
                    <button onClick={() => askConfirm({
                        title: '绑定到联系人？',
                        desc: linkedReal
                            ? `已与神经链接里的「${selectedChatRecord.title}」匹配，绑定后这段对话会同步到对方手机。`
                            : `将把「${selectedChatRecord.title}」加进联系人（未匹配到真实角色，按虚构联系人处理）。`,
                        confirmLabel: '绑定',
                        onConfirm: () => handleBindRecordToRelationship(selectedChatRecord),
                    })}
                        className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white/90 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-2">
                        <LinkSimple size={16} weight="bold" /> 绑定到联系人
                    </button>
                </div>
            </SubAppShell>
        );
    };

    const renderEvidenceDetail = () => {
        const r = selectedEvidenceRecord;
        if (!r) return null;

        const customApp = customApps.find(app => app.id === r.type);
        const layout = customApp?.layout || 'generic';
        const isCall = r.type === 'call';
        const isCommerce = r.type === 'order' || r.type === 'delivery' || layout === 'shop';
        const isSocial = r.type === 'social' || layout === 'feed';
        const isNovel = layout === 'novel';
        const accent = customApp?.color || (isCall ? '#4ade80' : r.type === 'order' ? '#ff7a45' : r.type === 'delivery' ? '#fbbf24' : isSocial ? '#c084fc' : '#8b9cff');
        const title = customApp?.name || appLabel(r.type);
        const dateText = new Date(r.timestamp).toLocaleString('zh-CN', {
            year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const isMissed = isCall && (r.value?.includes('未接') || r.value?.includes('Missed'));
        const isOutgoing = isCall && (r.value?.includes('呼出') || r.value?.includes('Outgoing'));
        const callDirection = isMissed ? '未接来电' : isOutgoing ? '呼出' : '呼入';
        const callDuration = r.value?.match(/\((.*?)\)/)?.[1] || (isMissed ? '—' : '未记录');
        const detailIcon = customApp
            ? <span className="text-lg">{customApp.icon}</span>
            : isCall ? <Phone size={20} weight="fill" />
                : r.type === 'order' ? <ShoppingBag size={20} weight="fill" />
                    : r.type === 'delivery' ? <Hamburger size={20} weight="fill" />
                        : <ImagesSquare size={20} weight="fill" />;

        return (
            <SubAppShell>
                <TermHeader title={title} sub="record detail" accent={accent}
                    onBack={() => { setSelectedEvidenceRecord(null); setActiveAppId(evidenceBackAppId); }}
                    right={<span style={{ color: accent }}>{detailIcon}</span>} />
                <div className="flex-1 overflow-y-auto no-scrollbar overscroll-contain px-5 pt-3 pb-10">
                    {isSocial ? (
                        <article>
                            <div className="flex items-center gap-3 pb-4 border-b border-white/[0.07]">
                                {targetChar?.avatar
                                    ? <TokenImg value={targetChar.avatar} alt="" className="w-12 h-12 rounded-full object-cover" />
                                    : <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold" style={{ background: accent }}>{charName.slice(0, 1)}</div>}
                                <div className="min-w-0">
                                    <div className="text-[15px] font-semibold text-white/95">{charName}</div>
                                    <div className="text-[11px] text-white/35 mt-0.5">{r.title || dateText}</div>
                                </div>
                            </div>
                            <div className="py-6 text-[15px] leading-8 text-white/85 whitespace-pre-wrap break-words">
                                {r.detail || '这条动态没有文字内容。'}
                            </div>
                            <div className="flex items-center gap-7 py-3 border-y border-white/[0.07] text-white/45">
                                <span className="flex items-center gap-2 text-[12px]"><Heart size={16} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)} 个赞</span>
                                <span className="flex items-center gap-2 text-[12px]"><ChatCircle size={16} /> {1 + (r.id.length % 9)} 条互动</span>
                            </div>
                        </article>
                    ) : (
                        <article>
                            <div className="flex items-start gap-4 pb-6 border-b border-white/[0.07]">
                                <div className="w-16 h-16 rounded-2xl flex items-center justify-center shrink-0 text-2xl"
                                    style={{ color: accent, background: 'linear-gradient(135deg, ' + accent + '33, ' + accent + '0d)' }}>
                                    {customApp ? customApp.icon : isCall ? <Phone size={27} weight="fill" /> : <Package size={28} weight="light" />}
                                </div>
                                <div className="min-w-0 flex-1 pt-0.5">
                                    <div className="text-[18px] leading-7 font-semibold text-white/95 break-words" style={isNovel ? { fontFamily: "'Shippori Mincho','Noto Sans SC',serif" } : undefined}>{r.title}</div>
                                    <div className="text-[11px] text-white/35 mt-1.5">{isCall ? callDirection : isCommerce ? '订单记录' : isNovel ? '阅读记录' : '内容记录'}</div>
                                    {r.value && <div className="text-[18px] font-bold mt-2" style={{ color: accent }}>{r.value}</div>}
                                </div>
                            </div>

                            <section className="py-6 border-b border-white/[0.07]">
                                <div className="text-[10px] tracking-[0.22em] uppercase mb-3" style={{ color: accent }}>
                                    {isCall ? '通话备注' : isCommerce ? '完整订单信息' : isNovel ? '完整正文' : '完整内容'}
                                </div>
                                <div className="text-[14px] leading-7 text-white/75 whitespace-pre-wrap break-words" style={isNovel ? { fontFamily: "'Shippori Mincho','Noto Sans SC',serif" } : undefined}>
                                    {r.detail || '没有留下更多内容。'}
                                </div>
                            </section>

                            {isCall && (
                                <div className="grid grid-cols-2 gap-6 py-5 border-b border-white/[0.07]">
                                    <div><div className="text-[10px] text-white/30">通话方向</div><div className="text-[14px] text-white/80 mt-1">{callDirection}</div></div>
                                    <div><div className="text-[10px] text-white/30">通话时长</div><div className="text-[14px] text-white/80 mt-1">{callDuration}</div></div>
                                </div>
                            )}
                            {isCommerce && (
                                <div className="py-5 border-b border-white/[0.07]">
                                    <div className="text-[10px] text-white/30 mb-3">订单进度</div>
                                    <div className="flex items-center text-[11px] text-white/55">
                                        {['已下单', '处理中', r.detail?.includes('签收') || r.detail?.includes('送达') ? '已完成' : '等待更新'].map((step, i) => (
                                            <React.Fragment key={step}>
                                                {i > 0 && <div className="h-px flex-1 mx-2" style={{ background: accent + '55' }} />}
                                                <span className="shrink-0" style={{ color: i === 0 ? accent : undefined }}>{step}</span>
                                            </React.Fragment>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </article>
                    )}

                    <dl className="py-5 space-y-3 text-[11px]">
                        <div className="flex justify-between gap-4"><dt className="text-white/30">记录时间</dt><dd className="text-white/60 text-right">{dateText}</dd></div>
                        <div className="flex justify-between gap-4"><dt className="text-white/30">来源 App</dt><dd className="text-white/60 text-right">{title}</dd></div>
                        <div className="flex justify-between gap-4"><dt className="text-white/30">记录编号</dt><dd className="text-white/40 text-right font-mono">#{r.id.slice(-8).toUpperCase()}</dd></div>
                    </dl>

                    <button onClick={() => void syncEvidenceRecordToChat(r)} disabled={!!r.systemMessageId}
                        className="w-full mt-2 py-3 rounded-2xl text-[12px] font-semibold text-sky-100 bg-sky-400/10 border border-sky-300/20 active:scale-[0.99] transition flex items-center justify-center gap-2 disabled:text-white/30 disabled:bg-white/[0.03] disabled:border-white/[0.06]">
                        <PaperPlaneTilt size={15} weight="bold" /> {r.systemMessageId ? '已同步到私聊' : '同步这条到私聊'}
                    </button>
                    <button onClick={() => askConfirm({
                        title: '删除这条记录？', desc: '删除「' + r.title + '」后无法恢复。', confirmLabel: '删除', danger: true,
                        onConfirm: () => handleDeleteRecord(r),
                    })} className="w-full mt-2 py-3 rounded-2xl text-[12px] font-semibold text-rose-200 bg-rose-400/10 border border-rose-400/20 active:scale-[0.99] transition flex items-center justify-center gap-2">
                        <Trash size={15} weight="bold" /> 删除记录
                    </button>
                </div>
            </SubAppShell>
        );
    };

    const renderCallList = () => {
        const accent = '#4ade80';
        const list = records.filter(r => r.type === 'call').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Recents" sub="call log" accent={accent} onBack={() => setActiveAppId('home')} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-2">
                    {list.length === 0 && <EmptyState text="暂无通话记录" />}
                    {list.map(r => {
                        const isMissed = r.value?.includes('未接') || r.value?.includes('Missed');
                        const isOutgoing = r.value?.includes('呼出') || r.value?.includes('Outgoing');
                        const c = isMissed ? '#fb7185' : accent;
                        return (
                            <div key={r.id} {...evidenceEntryProps(r, 'call')}
                                className="group relative flex items-center gap-3.5 rounded-2xl p-3.5 pr-8 bg-white/[0.035] border border-white/[0.06] animate-fade-in cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: `${c}1f`, color: c }}>
                                    <Phone size={19} weight="fill" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="font-semibold text-[13.5px] truncate" style={{ color: isMissed ? '#fb7185' : 'rgba(255,255,255,0.95)' }}>{r.title}</div>
                                    <div className="text-[10.5px] text-white/40 flex items-center gap-1.5 mt-0.5">
                                        <span>{isMissed ? '未接来电' : (isOutgoing ? '呼出' : '呼入')}</span>
                                        {r.value && !isMissed && <span>· {r.value.replace(/.*?\((.*?)\).*/, '$1')}</span>}
                                    </div>
                                    {r.detail && <div className="text-[10.5px] text-white/30 mt-1 italic truncate">“{r.detail}”</div>}
                                </div>
                                <span className="text-[10px] text-white/30 tabular-nums shrink-0">{fmtClock(r.timestamp)}</span>
                                <DelBtn onDelete={() => handleDeleteRecord(r)} />
                            </div>
                        );
                    })}
                </div>
                <RefreshFab onClick={() => handleGenerate('call')} label="刷新通话" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderShop = () => {
        const accent = '#ff7a45';
        const list = records.filter(r => r.type === 'order').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="淘宝" sub="my orders" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<ShoppingBag size={20} weight="fill" style={{ color: accent }} />} />
                {/* banner */}
                <div className="px-4 pb-2 shrink-0">
                    <div className="rounded-2xl p-3.5 flex items-center gap-3 border border-white/[0.06] overflow-hidden relative"
                        style={{ background: `linear-gradient(120deg, ${accent}26, ${accent}08)` }}>
                        <Storefront size={26} weight="fill" style={{ color: accent }} />
                        <div className="min-w-0">
                            <div className="text-[13px] font-semibold text-white">{charName} 的购物车</div>
                            <div className="text-[10.5px] text-white/50">{list.length} 件商品 · 待付款 / 待收货</div>
                        </div>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="还没有订单" />}
                    {list.map(r => (
                        <div key={r.id} {...evidenceEntryProps(r, 'taobao')}
                            className="group relative flex gap-3 rounded-2xl p-3 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60">
                            <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center"
                                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>
                                <Package size={26} weight="light" style={{ color: accent }} />
                            </div>
                            <div className="flex-1 min-w-0 flex flex-col">
                                <div className="text-[13px] font-medium text-white/95 leading-snug line-clamp-2">{r.title}</div>
                                <div className="text-[10.5px] text-white/40 mt-0.5 line-clamp-1">{r.detail}</div>
                                <div className="mt-auto flex items-center justify-between pt-1.5">
                                    <span className="text-[14px] font-bold" style={{ color: accent }}>{r.value || '¥ --'}</span>
                                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 tracking-wider flex items-center gap-0.5">已下单 <CaretRight size={10} /></span>
                                </div>
                            </div>
                            <DelBtn onDelete={() => handleDeleteRecord(r)} />
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('order')} label="刷新订单" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderFood = () => {
        const accent = '#fbbf24';
        const list = records.filter(r => r.type === 'delivery').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="外卖" sub="recent orders" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<Hamburger size={20} weight="fill" style={{ color: accent }} />} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="还没有外卖记录" />}
                    {list.map(r => (
                        <div key={r.id} {...evidenceEntryProps(r, 'waimai')}
                            className="group relative rounded-2xl p-3.5 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60">
                            <div className="flex items-center gap-3">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>
                                    <Storefront size={20} weight="fill" style={{ color: accent }} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13.5px] font-semibold text-white/95 truncate">{r.title}</div>
                                    <div className="text-[10px] text-white/35 mt-0.5">{fmtClock(r.timestamp)} · 已送达</div>
                                </div>
                                {r.value && <span className="text-[14px] font-bold shrink-0" style={{ color: accent }}>{r.value}</span>}
                            </div>
                            <div className="text-[11.5px] text-white/50 mt-2.5 leading-relaxed pl-1 border-l-2" style={{ borderColor: `${accent}55` }}>
                                <span className="pl-2">{r.detail}</span>
                            </div>
                            <DelBtn onDelete={() => handleDeleteRecord(r)} />
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('delivery')} label="刷新外卖" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderMoments = () => {
        const accent = '#c084fc';
        const list = records.filter(r => r.type === 'social').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Moments" sub="朋友圈" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<ImagesSquare size={20} weight="fill" style={{ color: accent }} />} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="还没有动态" />}
                    {list.map(r => (
                        <div key={r.id} {...evidenceEntryProps(r, 'social')}
                            className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60">
                            <div className="flex items-center gap-3 mb-2.5">
                                {targetChar?.avatar
                                    ? <TokenImg value={targetChar.avatar} className="w-9 h-9 rounded-full object-cover" />
                                    : <div className="w-9 h-9 rounded-full" style={{ background: accent }} />}
                                <div className="min-w-0">
                                    <div className="text-[13px] font-semibold text-white/95">{charName}</div>
                                    <div className="text-[10px] text-white/35">{r.title || fmtClock(r.timestamp)}</div>
                                </div>
                            </div>
                            <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                            <div className="flex items-center gap-5 mt-3 pt-2.5 border-t border-white/[0.06] text-white/40">
                                <span className="flex items-center gap-1.5 text-[11px]"><Heart size={14} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)}</span>
                                <span className="flex items-center gap-1.5 text-[11px]"><ChatCircle size={14} /> {1 + (r.id.length % 9)}</span>
                                <span className="ml-auto flex items-center gap-0.5 text-[10px]" style={{ color: accent }}>查看详情 <CaretRight size={10} /></span>
                            </div>
                            <DelBtn onDelete={() => handleDeleteRecord(r)} />
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('social')} label="刷新动态" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    // ============================================================
    //  人际关系系统 · 视图
    // ============================================================
    const affColor = (a: number) => a >= 40 ? '#4ade80' : a >= 0 ? '#8b9cff' : a >= -40 ? '#fbbf24' : '#fb7185';
    const kindBadge = (c: PhoneContact) => {
        if (c.kind === 'real') return { icon: <LinkSimple size={11} weight="bold" />, label: '真人', color: '#a78bfa' };
        return { icon: <User size={11} weight="fill" />, label: 'NPC', color: '#94a3b8' };
    };

    const renderContactsList = () => {
        const accent = '#f472b6';
        // 人际关系里不出现用户自己
        const list = contacts.filter(c => !isUserName(c.name)).sort((a, b) => (b.lastInteraction || b.createdAt) - (a.lastInteraction || a.createdAt));
        return (
            <SubAppShell>
                <TermHeader title={contactSelectMode ? `已选 ${selectedContactIds.length}` : '联系人'} sub={contactSelectMode ? '长按进入了多选' : `${list.length} contacts`} accent={accent}
                    onBack={() => { if (contactSelectMode) exitContactSelect(); else setActiveAppId('home'); }}
                    right={contactSelectMode
                        ? <button onClick={exitContactSelect} className="text-[12px] font-semibold text-white/80 active:scale-90 transition">取消</button>
                        : <button onClick={() => setShowContactModal(true)} className="text-white/80 active:scale-90 transition"><UserPlus size={20} weight="bold" /></button>} />
                {/* 约束开关：是否允许虚构 NPC */}
                <div className="px-4 pt-1 pb-2 shrink-0">
                    <div className="w-full flex items-center gap-2 rounded-xl px-3 py-2 bg-white/[0.04] border border-white/[0.07]">
                        <button onClick={toggleAllowFictional} className="flex-1 min-w-0 text-left active:scale-[0.99] transition">
                            <span className="text-[11px] text-white/55">{allowFictional ? '允许 TA 结交虚构 NPC' : '只与神经链接里的真实角色来往'}</span>
                        </button>
                        <button onClick={() => setShowFictionHelp(v => !v)} aria-label="说明"
                            className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition ${showFictionHelp ? 'text-white/80' : 'text-white/35 active:text-white/70'}`}>
                            <Question size={13} weight="bold" />
                        </button>
                        <button onClick={toggleAllowFictional} aria-label="切换" className="relative w-9 h-5 rounded-full transition shrink-0" style={{ background: allowFictional ? accent : 'rgba(255,255,255,0.15)' }}>
                            <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: allowFictional ? '18px' : '2px' }} />
                        </button>
                    </div>
                    {showFictionHelp && (
                        <div className="mt-1.5 rounded-xl px-3 py-2.5 bg-white/[0.03] border border-white/[0.06] text-[10.5px] text-white/55 leading-relaxed space-y-1">
                            <p><span className="font-semibold text-white/75">开：</span>允许 TA 的通讯录里出现「按人设虚构的路人」（同事、网友、中间人之类，神经链接里并不存在的人）。社交圈更丰满。</p>
                            <p><span className="font-semibold text-white/75">关：</span>TA 只和神经链接里<span className="text-white/75">真实存在的角色</span>来往；扫描/生成时会丢弃所有虚构联系人。</p>
                        </div>
                    )}
                    {/* 旧版 Message 聊天归档：废弃 App，收在这里做不起眼的入口 */}
                    <button onClick={openChat}
                        className="w-full flex items-center gap-2 mt-1.5 px-3 py-1.5 text-white/35 active:text-white/60 transition">
                        <ChatCircleDots size={13} weight="light" className="shrink-0" />
                        <span className="text-[10.5px] flex-1 text-left">旧版聊天归档{chatRecords.length ? ` · ${chatRecords.length}` : ''}</span>
                        <CaretRight size={11} weight="bold" className="shrink-0" />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-2 space-y-2.5 no-scrollbar pb-28 overscroll-contain">
                    {list.length === 0 && <EmptyState text="还没有联系人 · 扫描通讯录看看" />}
                    {list.map(c => {
                        const badge = kindBadge(c);
                        const dimmed = c.status === 'deleted' || c.status === 'blocked';
                        const av = contactAvatar(c);
                        const selected = selectedContactIds.includes(c.id);
                        return (
                            <div key={c.id}
                                {...longPress(() => { setContactSelectMode(true); toggleContactSelect(c.id); })}
                                onClick={() => {
                                    if (lpFired.current) { lpFired.current = false; return; }
                                    if (contactSelectMode) { toggleContactSelect(c.id); return; }
                                    setSelectedContact(c); setIdentityDraft(c.identity || ''); setEditingIdentity(false); setNoteDraft(c.note || ''); setEditingNote(false); setConvExpanded(false); setAffinityDraft(null); setShowProfile(false); exitMsgSelect(); setActiveAppId('contact_detail');
                                    trackEvent('打开联系人对话详情', { contactKind: c.kind });
                                }}
                                className={`group relative flex items-center gap-3 rounded-2xl p-3.5 border active:scale-[0.99] transition cursor-pointer animate-fade-in select-none ${selected ? 'bg-pink-500/10 border-pink-400/40' : 'bg-white/[0.035] border-white/[0.06]'} ${dimmed && !selected ? 'opacity-45' : ''}`}>
                                {contactSelectMode && (
                                    <span className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 text-[11px] font-bold transition ${selected ? 'bg-pink-500 border-pink-500 text-white' : 'border-white/30 text-transparent'}`}>✓</span>
                                )}
                                {av ? (
                                    <TokenImg value={av} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
                                ) : (
                                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold text-lg"
                                        style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)`, boxShadow: `inset 0 0 18px ${accent}25` }}>
                                        {c.name[0]}
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="font-semibold text-[13.5px] text-white/95 truncate">{contactDisplayName(c)}</span>
                                        <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full shrink-0" style={{ color: badge.color, background: `${badge.color}1f` }}>{badge.icon}{badge.label}</span>
                                        {c.status === 'deleted' && <span className="text-[9px] text-rose-300/80 shrink-0">已删</span>}
                                        {c.status === 'blocked' && <span className="text-[9px] text-rose-300/80 shrink-0">已拉黑</span>}
                                    </div>
                                    <div className="text-[11px] text-white/40 truncate mt-0.5">{c.note || c.identity || '—'}</div>
                                    <div className="flex items-center gap-2 mt-1.5">
                                        <div className="h-1 flex-1 rounded-full bg-white/[0.08] overflow-hidden">
                                            <div className="h-full rounded-full" style={{ width: `${(c.affinity + 100) / 2}%`, background: affColor(c.affinity) }} />
                                        </div>
                                        <span className="text-[9px] tabular-nums shrink-0" style={{ color: affColor(c.affinity) }}>{c.affinity > 0 ? '+' : ''}{c.affinity}</span>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {contactSelectMode ? (
                    <div className="absolute bottom-7 inset-x-0 flex justify-center gap-2 px-6 z-30 pointer-events-none">
                        <button onClick={() => setSelectedContactIds(selectedContactIds.length === list.length ? [] : list.map(c => c.id))}
                            className="pointer-events-auto px-4 py-3 rounded-full text-[12px] font-semibold text-white/85 bg-white/[0.1] border border-white/15 backdrop-blur-xl active:scale-95 transition">
                            {selectedContactIds.length === list.length && list.length > 0 ? '取消全选' : '全选'}
                        </button>
                        <button disabled={!selectedContactIds.length}
                            onClick={() => askConfirm({
                                title: `清空选中的 ${selectedContactIds.length} 段对话？`,
                                desc: '只清掉这几段聊天记录（保留联系人；真人对方手机里的镜像、相关私聊卡片、话题盒记忆一并清），之后可重新生成。',
                                confirmLabel: '清空对话', danger: true, onConfirm: handleBatchClearConversations,
                            })}
                            className="pointer-events-auto px-6 py-3 rounded-full text-[12px] font-semibold text-white bg-rose-500 disabled:opacity-40 active:scale-95 transition flex items-center gap-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
                            <ChatCircle size={14} weight="bold" /> 清空对话 {selectedContactIds.length || ''}
                        </button>
                    </div>
                ) : (
                    <RefreshFab onClick={() => handleGenerate('contacts')} label="扫描通讯录" accent={accent} loading={isLoading} />
                )}
            </SubAppShell>
        );
    };

    // ============================================================
    //  智能体 App · Render（首页：服务 tab + 会话列表；详情：transcript + 互动）
    // ============================================================
    const renderAiAgent = () => {
        const svc = AI_SERVICES.find(s => s.id === aiService)!;
        const list = aiSessions.filter(s => s.service === aiService).sort((a, b) => b.updatedAt - a.updatedAt);
        return (
            <SubAppShell>
                <TermHeader title="智能体" sub="TA 的小手机" accent={svc.accent} onBack={() => setActiveAppId('home')}
                    right={<Robot size={20} weight="fill" style={{ color: svc.accent }} />} />
                {/* 服务 tab */}
                <div className="px-4 pb-2 shrink-0 flex gap-2">
                    {AI_SERVICES.map(s => {
                        const active = s.id === aiService;
                        const Icon = s.id === 'assistant' ? Robot : s.id === 'claude' ? Brain : MaskHappy;
                        return (
                            <button key={s.id} onClick={() => { setAiService(s.id); trackEvent('切换智能体服务分类', { service: s.id }); }}
                                className={`flex-1 rounded-2xl px-2 py-2.5 border transition active:scale-[0.97] ${active ? 'text-white' : 'border-white/[0.07] bg-white/[0.03] text-white/55'}`}
                                style={active ? { background: `linear-gradient(135deg, ${s.accent}33, ${s.accent}0d)`, borderColor: `${s.accent}66` } : undefined}>
                                <Icon size={18} weight={active ? 'fill' : 'light'} style={{ color: active ? s.accent : undefined }} className="mx-auto" />
                                <div className="text-[10.5px] font-semibold mt-1">{s.name}</div>
                            </button>
                        );
                    })}
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 no-scrollbar pb-28 overscroll-contain space-y-2.5">
                    <div className="text-[11px] text-white/45 px-1 pb-0.5">{svc.tagline}</div>
                    {/* 酒馆角色卡橱窗（点击看 TA 玩这张 / 长按编辑删除 / ＋自己加一张） */}
                    {aiService === 'tavern' && (
                        <div className="flex gap-2.5 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1">
                            {aiCards.map(c => (
                                <div key={c.id} {...longPress(() => setAiMenu({ kind: 'card', id: c.id }))}
                                    onClick={() => { if (lpFired.current) { lpFired.current = false; return; } setAiCardView(c.id); }}
                                    className="shrink-0 w-36 rounded-2xl p-3 border border-white/[0.07] bg-white/[0.035] cursor-pointer active:scale-[0.98] transition select-none">
                                    <div className="flex items-center justify-between">
                                        <div className="text-2xl">{c.emoji}</div>
                                        <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-rose-400/20 text-rose-200/90">{c.kind === 'world' ? '世界卡' : '角色卡'}</span>
                                    </div>
                                    <div className="text-[12.5px] font-semibold text-white mt-1.5 truncate">{c.name}</div>
                                    {c.basedOnUser ? <div className="text-[9px] text-rose-300/90 mt-0.5">⚑ 照着你捏的</div>
                                        : c.basedOn ? <div className="text-[9px] text-rose-300/90 mt-0.5 truncate">⚑ 照着「{c.basedOn}」</div> : null}
                                    <div className="text-[10px] text-white/45 mt-1 line-clamp-2 leading-snug">{c.persona}</div>
                                    {c.scenario && <div className="text-[9.5px] text-white/35 mt-1 line-clamp-2 italic leading-snug">场景：{c.scenario}</div>}
                                </div>
                            ))}
                            {/* 用户自己加一张卡 */}
                            <button onClick={() => setAiEdit({ kind: 'card', id: '__new__', emoji: '🎭', name: '', persona: '', scenario: '', cardKind: 'character' })}
                                className="shrink-0 w-24 rounded-2xl p-3 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-1.5 active:scale-[0.98] transition self-stretch">
                                <Plus size={20} weight="light" className="text-white/55" />
                                <span className="text-[10px] text-white/45">加角色卡</span>
                            </button>
                        </div>
                    )}
                    {list.length === 0 && <EmptyState text={`还没偷看到 TA 用「${svc.name}」`} />}
                    {list.map(s => {
                        const lines = parseTranscript(s.transcript);
                        const last = lines[lines.length - 1];
                        const vt = getVendorTheme(s.serviceName, s.service);
                        return (
                            <button key={s.id} {...longPress(() => setAiMenu({ kind: 'session', id: s.id }))}
                                onClick={() => { if (lpFired.current) { lpFired.current = false; return; } setSelectedAiSessionId(s.id); setActiveAppId('ai_session'); }}
                                className="group relative w-full text-left flex gap-3 rounded-2xl p-3.5 bg-white/[0.035] border border-white/[0.06] animate-fade-in active:scale-[0.99] transition">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: aiService === 'assistant' ? `${vt.accent}1f` : `${svc.accent}1f`, color: svc.accent }}>
                                    {aiService === 'assistant'
                                        ? <VendorMark vkey={vt.key} label={vt.label} accent={vt.accent} size={22} />
                                        : aiService === 'claude' ? <Brain size={20} weight="fill" /> : <MaskHappy size={20} weight="fill" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="font-semibold text-[13.5px] text-white/95 truncate">{s.title}</div>
                                        <span className="text-[10px] text-white/30 tabular-nums shrink-0">{fmtClock(s.updatedAt)}</span>
                                    </div>
                                    <div className="text-[10.5px] text-white/40 mt-0.5">{s.serviceName} · {lines.length} 条</div>
                                    {last && <div className="text-[11px] text-white/55 mt-1 truncate italic">「{last.text}」</div>}
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); askConfirm({ title: `删除会话「${s.title}」？`, desc: '这段对话记录会被删除，无法撤销。', confirmLabel: '删除', danger: true, onConfirm: () => handleDeleteAiSession(s.id) }); }}
                                    className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                            </button>
                        );
                    })}
                </div>
                <RefreshFab onClick={() => handleGenerateAiAgent(aiService)} label={`偷看 TA 的${svc.name}`} accent={svc.accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderAiSession = () => {
        const s = selectedAiSession;
        if (!s || !targetChar) return null;
        const isTavern = s.service === 'tavern';
        const card = isTavern ? aiCards.find(c => c.id === s.cardId) : undefined;
        const lines = parseTranscript(s.transcript);
        const partnerName = isTavern ? (card?.name || s.serviceName) : s.serviceName;
        const partnerEmoji = isTavern ? (card?.emoji || '🎭') : null;
        const inputHint = isTavern ? `以「${partnerName}」身份续写剧情…` : `以 AI「${partnerName}」身份回 TA…`;
        // 酒馆走用户选的阅读皮肤；助手/树洞走厂商换肤
        const tStyle = TAVERN_STYLES.find(x => x.key === tavernStyle) || TAVERN_STYLES[0];
        const t: VendorTheme = isTavern
            ? { key: 'tavern', label: partnerName, dark: tStyle.dark, bg: tStyle.bg, text: tStyle.text, sub: tStyle.sub, accent: tStyle.accent, font: tStyle.font,
                userBg: `linear-gradient(135deg,${tStyle.accent},${tStyle.accent}bb)`, userText: '#fff',
                aiBg: tStyle.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)', aiText: tStyle.text }
            : getVendorTheme(s.serviceName, s.service);
        const clock = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const hairline = t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
        const inputBg = t.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
        const aiAvatarBg = t.key === 'gpt' ? '#000' : t.key === 'claude' ? '#f0e9da' : t.dark ? 'rgba(255,255,255,0.08)' : '#fff';

        // 酒馆是长剧情小说体：把连续同一说话人的行合并成「楼层」，*动作* 渲染成斜体淡色
        const floors: { isMe: boolean; text: string }[] = [];
        for (const ln of lines) {
            const prev = floors[floors.length - 1];
            if (prev && prev.isMe === ln.isMe) prev.text += '\n' + ln.text;
            else floors.push({ isMe: ln.isMe, text: ln.text });
        }
        // *动作* 斜体淡色；（括号 OOC / 跟皮下 AI 说话）也淡色斜体——但都还在 char 自己的楼层里，不另起气泡
        const renderProse = (txt: string) => txt.split(/(\*[^*]+\*|（[^）]+）)/g).filter(Boolean).map((p, i) =>
            (p.startsWith('*') && p.endsWith('*'))
                ? <em key={i} style={{ color: t.sub }}>{p.slice(1, -1)}</em>
                : (p.startsWith('（') && p.endsWith('）'))
                    ? <em key={i} style={{ color: t.sub, opacity: 0.8 }}>{p}</em>
                    : <span key={i}>{p}</span>);
        return (
            <div className="absolute inset-0 w-full h-full flex flex-col z-[60] overflow-hidden"
                style={{ background: t.bg, color: t.text, fontFamily: t.font }}>
                {/* 状态栏（按明暗着色） */}
                <div className="shrink-0" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="h-9 flex justify-between px-6 items-center pt-2" style={{ color: t.text, opacity: 0.65 }}>
                        <span className="text-[12px] font-semibold tabular-nums">{clock}</span>
                        <div className="flex gap-1.5 items-center">
                            <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M2 22h3V10H2v12zm6 0h3V6H8v16zm6 0h3V2h-3v20zm6 0h3v-8h-3v8z" /></svg>
                            <div className="w-5 h-2.5 border border-current rounded-[3px] relative px-px flex items-center"><div className="h-1.5 bg-current w-3/4 rounded-[1px]" /></div>
                        </div>
                    </div>
                </div>
                {/* 顶栏：返回 + logo + 服务名 + 删除 */}
                <div className="shrink-0 h-14 flex items-center justify-between px-3" style={{ borderBottom: `1px solid ${hairline}` }}>
                    <button onClick={() => setActiveAppId('aiagent')} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center active:scale-90 transition" style={{ color: t.text }}>
                        <CaretLeft size={18} weight="bold" />
                    </button>
                    <div className="flex-1 flex items-center justify-center gap-2 px-2 min-w-0">
                        {!isTavern && (
                            <span className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                                style={{ background: t.key === 'gemini' || t.key === 'claude' ? 'transparent' : `${t.accent}1f` }}>
                                <VendorMark vkey={t.key} label={t.label} accent={t.accent} size={16} />
                            </span>
                        )}
                        <div className="min-w-0 text-center">
                            <div className="text-[15px] font-semibold tracking-wide truncate">{isTavern ? s.title : t.label}</div>
                            <div className="text-[10px] tracking-[0.15em] uppercase truncate" style={{ color: t.accent }}>
                                {isTavern ? `${partnerName} · 潜入对戏` : `${s.title} · 你来当 AI`}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center">
                        {isTavern && (
                            <button onClick={() => setShowTavernStyle(true)} aria-label="阅读皮肤" className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition" style={{ color: t.sub }}>
                                <PaintBrush size={16} />
                            </button>
                        )}
                        <button onClick={() => askConfirm({ title: `删除会话「${s.title}」？`, desc: '这段对话记录会被删除，无法撤销。', confirmLabel: '删除', danger: true, onConfirm: () => handleDeleteAiSession(s.id) })} className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition" style={{ color: t.sub }}>
                            <Trash size={16} />
                        </button>
                    </div>
                </div>
                {/* 酒馆阅读皮肤选择 */}
                {showTavernStyle && (
                    <div className="absolute inset-0 z-[80] flex items-end justify-center" onClick={() => setShowTavernStyle(false)}>
                        <div className="absolute inset-0 bg-black/40" />
                        <div className="relative w-full max-w-sm m-3 mb-6 rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10" onClick={e => e.stopPropagation()}>
                            <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10">阅读皮肤</div>
                            <div className="grid grid-cols-2 gap-2 p-3">
                                {TAVERN_STYLES.map(st => (
                                    <button key={st.key} onClick={() => { setTavernStyle(st.key); setShowTavernStyle(false); trackEvent('切换酒馆阅读皮肤', { style: st.key }); }}
                                        className={`rounded-xl p-3 text-left border transition ${tavernStyle === st.key ? 'border-white/40' : 'border-white/10'}`}
                                        style={{ background: st.bg }}>
                                        <div className="text-[13px] font-semibold" style={{ color: st.text, fontFamily: st.font }}>{st.label}</div>
                                        <div className="text-[10px] mt-1" style={{ color: st.sub }}>{st.layout === 'card' ? '楼层卡片' : st.indent ? '书页排版' : '素文排版'}</div>
                                        <div className="mt-1.5 h-1 w-10 rounded-full" style={{ background: st.accent }} />
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
                {isTavern && card && (
                    <div className="px-4 pt-2 pb-1 shrink-0">
                        <div className="rounded-2xl p-3 flex items-start gap-3" style={{ background: `${t.accent}1a`, border: `1px solid ${hairline}` }}>
                            <div className="text-2xl shrink-0">{card.emoji}</div>
                            <div className="min-w-0 flex-1">
                                <div className="text-[12.5px] font-semibold flex items-center gap-1.5 flex-wrap" style={{ color: t.text }}>
                                    {card.name}
                                    <span className="text-[8.5px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>{card.kind === 'world' ? '世界卡 · 跑团' : '角色卡'}</span>
                                    {card.basedOnUser ? <span className="text-[8.5px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>⚑ 照着你捏的</span>
                                        : card.basedOn ? <span className="text-[8.5px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>⚑ 照着「{card.basedOn}」捏的</span> : null}
                                </div>
                                <div className="text-[10px] mt-0.5 line-clamp-2" style={{ color: t.sub }}>{card.persona}</div>
                                {card.scenario && <div className="text-[10px] mt-1 line-clamp-2 italic" style={{ color: t.sub }}>场景：{card.scenario}</div>}
                            </div>
                        </div>
                    </div>
                )}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {/* 前情提要：长会话自动总结出的小说梗概（可展开被折叠的早期原文） */}
                    {!!s.summaries?.length && (
                        <div className="rounded-2xl p-3.5 space-y-2" style={{ background: `${t.accent}10`, border: `1px dashed ${t.accent}55` }}>
                            <div className="text-[10px] tracking-[0.25em] uppercase font-bold" style={{ color: t.accent }}>前情提要 · {s.summaries.length} 段</div>
                            {s.summaries.map((sm, i) => (
                                <p key={sm.id} className="text-[12px] leading-[1.85] whitespace-pre-wrap" style={{ color: t.sub }}>
                                    {s.summaries!.length > 1 && <span className="font-semibold" style={{ color: t.accent }}>{i + 1}. </span>}{sm.content}
                                </p>
                            ))}
                            {!!s.archived && (
                                <button onClick={() => setAiArchiveOpen(o => !o)}
                                    className="text-[11px] font-semibold pt-1 active:scale-95 transition" style={{ color: t.accent }}>
                                    {aiArchiveOpen ? '收起折叠的原文 ▲' : '展开折叠的原文 ▼'}
                                </button>
                            )}
                            {aiArchiveOpen && !!s.archived && (
                                <div className="text-[12px] leading-[1.85] whitespace-pre-wrap pt-1 mt-1 border-t" style={{ color: t.sub, borderColor: hairline }}>
                                    {parseTranscript(s.archived).map((l, i) => (
                                        <div key={i} className="mb-1"><span className="opacity-60">{l.isMe ? charName : partnerName}：</span>{l.text}</div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {/* 酒馆：玩家一层楼 / 角色一层楼 交替。card=楼层卡片，flat=素排/书页。OOC 就是楼层里的括号。 */}
                    {isTavern ? floors.map((f, i) => {
                        const who = f.isMe ? charName : partnerName;
                        if (tStyle.layout === 'flat') {
                            return (
                                <div key={i} {...longPress(() => setAiTurnMenu(i))} className="px-1 py-1.5 select-none">
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-[12px] font-semibold" style={{ color: f.isMe ? t.accent : t.text }}>{who}</span>
                                        {f.isMe && <span className="text-[9px]" style={{ color: t.sub }}>· 玩家</span>}
                                    </div>
                                    <div className="text-[14px] whitespace-pre-wrap" style={{ color: t.text, lineHeight: 1.95, textIndent: tStyle.indent ? '2em' : undefined }}>{renderProse(f.text)}</div>
                                </div>
                            );
                        }
                        return (
                            <div key={i} {...longPress(() => setAiTurnMenu(i))} className="rounded-2xl p-3.5 select-none"
                                style={{ background: f.isMe ? `${t.accent}10` : 'rgba(255,255,255,0.04)', border: `1px solid ${hairline}` }}>
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="w-7 h-7 rounded-lg flex items-center justify-center overflow-hidden shrink-0"
                                        style={{ background: f.isMe ? 'transparent' : `${t.accent}1f` }}>
                                        {f.isMe ? <TokenImg value={targetChar.avatar} className="w-7 h-7 object-cover" /> : <span className="text-base">{partnerEmoji}</span>}
                                    </div>
                                    <span className="text-[12.5px] font-semibold" style={{ color: f.isMe ? t.accent : t.text }}>{who}</span>
                                    {f.isMe && <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>玩家</span>}
                                </div>
                                <div className="text-[13px] leading-[1.95] whitespace-pre-wrap" style={{ color: t.text }}>{renderProse(f.text)}</div>
                            </div>
                        );
                    }) : lines.map((m, i) => {
                        const bare = !m.isMe && t.aiBg === 'transparent'; // ChatGPT/Claude：AI 不用气泡，整段铺开
                        return (
                            <div key={i} {...longPress(() => setAiTurnMenu(i))} className={`flex items-end gap-2 select-none ${m.isMe ? 'justify-end' : 'justify-start'}`}>
                                {!m.isMe && (
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0 overflow-hidden"
                                        style={{ background: aiAvatarBg, border: `1px solid ${hairline}` }}>
                                        {partnerEmoji || <VendorMark vkey={t.key} label={t.label} accent={t.key === 'gpt' ? '#fff' : t.accent} size={17} />}
                                    </div>
                                )}
                                <div className="px-3.5 py-2.5 rounded-2xl max-w-[78%] text-[13px] leading-relaxed break-words whitespace-pre-wrap"
                                    style={{
                                        background: m.isMe ? t.userBg : (bare ? 'transparent' : t.aiBg),
                                        color: m.isMe ? t.userText : t.aiText,
                                        border: (!m.isMe && !bare && !t.dark) ? `1px solid ${hairline}` : undefined,
                                        borderBottomRightRadius: m.isMe ? 6 : undefined,
                                        borderBottomLeftRadius: (!m.isMe && !bare) ? 6 : undefined,
                                        paddingLeft: bare ? 2 : undefined, paddingRight: bare ? 2 : undefined,
                                    }}>
                                    {m.text}
                                </div>
                                {m.isMe && <TokenImg value={targetChar.avatar} className="w-8 h-8 rounded-xl object-cover shrink-0" />}
                            </div>
                        );
                    })}
                    {aiSending && (
                        <div className="flex justify-start items-center gap-2">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: aiAvatarBg, border: `1px solid ${hairline}` }}>
                                {partnerEmoji || <VendorMark vkey={t.key} label={t.label} accent={t.key === 'gpt' ? '#fff' : t.accent} size={17} />}
                            </div>
                            <div className="flex gap-1 px-3 py-2.5 rounded-2xl" style={{ background: t.aiBg === 'transparent' ? 'transparent' : t.aiBg }}>
                                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: t.sub }} />
                                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: t.sub, animationDelay: '0.15s' }} />
                                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: t.sub, animationDelay: '0.3s' }} />
                            </div>
                        </div>
                    )}
                    <div ref={chatEndRef} />
                </div>
                {/* 自然推进：不用开口，让剧情自己往下走一轮 */}
                <div className="shrink-0 w-full px-3 pt-2" style={{ borderTop: `1px solid ${hairline}` }}>
                    <button onClick={handleAiAutoContinue} disabled={aiSending}
                        className="w-full py-2 rounded-xl text-[12px] font-semibold flex items-center justify-center gap-1.5 active:scale-[0.99] transition disabled:opacity-40"
                        style={{ background: `${t.accent}1a`, border: `1px dashed ${t.accent}66`, color: t.accent }}>
                        <Sparkle size={14} weight="fill" /> {isTavern ? '让剧情自己往下走一轮' : '让 TA 接着问下去'}
                    </button>
                </div>
                {/* 互动输入：替 TA 问 / 潜入对戏（回车换行，点按钮发送） */}
                <div className="shrink-0 w-full px-3 pt-2 flex items-end gap-2"
                    style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
                    <textarea value={aiInput} onChange={e => setAiInput(e.target.value)}
                        rows={1} placeholder={inputHint}
                        className="flex-1 resize-none rounded-2xl px-3.5 py-2.5 text-[13px] max-h-24 no-scrollbar focus:outline-none"
                        style={{ background: inputBg, color: t.text, border: `1px solid ${hairline}` }} />
                    <button onClick={handleAiSend} disabled={aiSending || !aiInput.trim()}
                        className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-90 transition"
                        style={{ background: t.accent, color: '#fff' }}>
                        {aiSending ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <PaperPlaneTilt size={17} weight="fill" />}
                    </button>
                </div>
            </div>
        );
    };

    const renderContactDetail = () => {
        if (!selectedContact || !targetChar) return null;
        const c = selectedContact;
        const accent = '#f472b6';
        const badge = kindBadge(c);
        const isReal = c.kind === 'real' && !!c.linkedCharId;
        const av = contactAvatar(c);
        const rec = records.find(r => r.type === 'chat' && (r.contactId === c.id || normName(r.title) === normName(c.name)));
        const parsed = rec ? parseTranscript(rec.detail).map(t => ({ isMe: t.isMe, content: t.text })) : [];
        const CAP = 50;
        const hidden = convExpanded ? 0 : Math.max(0, parsed.length - CAP);
        const shown = hidden > 0 ? parsed.slice(-CAP) : parsed;
        const statusLabel = c.status === 'friend' ? '好友' : c.status === 'deleted' ? '已删除' : c.status === 'blocked' ? '已拉黑' : '待定';
        const aff = affinityDraft ?? c.affinity;
        const commitAff = () => { if (affinityDraft != null) { handleSetAffinity(c, affinityDraft); setAffinityDraft(null); } };
        const closeProfile = () => { setShowProfile(false); setEditingIdentity(false); setEditingNote(false); };
        const avatarNode = (size: string, txt: string) => av
            ? <TokenImg value={av} alt="" className={`${size} rounded-2xl object-cover shrink-0`} />
            : <div className={`${size} rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold ${txt}`} style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>{c.name[0]}</div>;
        return (
            <SubAppShell>
                {/* 聊天式顶栏：返回 + 可点的头像/名字（进资料） */}
                <div className="shrink-0 z-20">
                    <StatusStrip />
                    <div className="h-14 flex items-center gap-2 px-3">
                        <button onClick={() => { if (msgSelectMode) exitMsgSelect(); else setActiveAppId('contacts'); }} className="w-9 h-9 -ml-0.5 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition shrink-0">
                            <CaretLeft size={18} weight="bold" />
                        </button>
                        <button onClick={() => setShowProfile(true)} className="flex items-center gap-2.5 flex-1 min-w-0 active:opacity-70 transition">
                            {avatarNode('w-9 h-9', 'text-base')}
                            <div className="min-w-0 text-left">
                                <div className="text-[14px] font-semibold text-white truncate leading-tight">{contactDisplayName(c)}</div>
                                <div className="text-[9.5px] text-white/40 leading-tight">{badge.label} · 轻触头像看资料</div>
                            </div>
                        </button>
                        <button onClick={() => setShowProfile(true)} aria-label="资料" className="w-9 h-9 rounded-full flex items-center justify-center text-white/70 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition shrink-0">
                            <DotsThree size={20} weight="bold" />
                        </button>
                    </div>
                </div>

                {/* 聊天主体 */}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {parsed.length === 0 && !isLoading && (
                        <div className="flex flex-col items-center justify-center h-full gap-2.5 text-white/30">
                            <ChatCircleDots size={42} weight="light" />
                            <span className="text-[12px] tracking-wide">{isReal ? '还没聊过 · 在下面发起对话' : '还没偷看过 · 下面偷看一段'}</span>
                        </div>
                    )}
                    {hidden > 0 && (
                        <button onClick={() => setConvExpanded(true)}
                            className="w-full py-2 rounded-xl text-[11.5px] font-semibold text-white/55 bg-white/[0.04] border border-white/[0.07] active:scale-[0.99] transition">
                            ▲ 展开更早的 {hidden} 条消息
                        </button>
                    )}
                    {shown.map((m, i) => {
                        const realIdx = hidden + i; // 映射回完整脚本下标
                        const sel = selectedMsgIdx.includes(realIdx);
                        return (
                        <div key={realIdx}
                            {...longPress(() => { setMsgSelectMode(true); setSelectedMsgIdx(prev => prev.includes(realIdx) ? prev : [...prev, realIdx]); })}
                            onClick={() => {
                                if (lpFired.current) { lpFired.current = false; return; }
                                if (msgSelectMode) setSelectedMsgIdx(prev => prev.includes(realIdx) ? prev.filter(x => x !== realIdx) : [...prev, realIdx]);
                            }}
                            className={`flex items-end gap-2 select-none ${m.isMe ? 'justify-end' : 'justify-start'} ${msgSelectMode ? 'cursor-pointer rounded-xl -mx-1 px-1 py-0.5 transition ' + (sel ? 'bg-pink-500/15' : '') : ''}`}>
                            {msgSelectMode && (
                                <span className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 text-[9px] font-bold self-center ${sel ? 'bg-pink-500 border-pink-500 text-white' : 'border-white/30 text-transparent'} ${m.isMe ? 'order-last' : ''}`}>✓</span>
                            )}
                            {!m.isMe && (av
                                ? <TokenImg value={av} alt="" className="w-7 h-7 rounded-xl object-cover shrink-0" />
                                : <div className="w-7 h-7 rounded-xl flex items-center justify-center text-[11px] text-white shrink-0" style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>{c.name[0]}</div>)}
                            <div className={`px-3.5 py-2.5 rounded-2xl max-w-[76%] text-[13px] leading-relaxed break-words ${m.isMe ? 'text-white rounded-br-md' : 'bg-white/[0.07] text-white/90 border border-white/[0.06] rounded-bl-md'}`}
                                style={m.isMe ? { background: `linear-gradient(135deg, ${accent}, ${accent}bb)` } : undefined}>{m.content}</div>
                            {m.isMe && <TokenImg value={targetChar.avatar} alt="" className="w-7 h-7 rounded-xl object-cover shrink-0" />}
                        </div>
                    );})}
                    {isLoading && (
                        <div className="flex justify-center py-3">
                            <div className="flex gap-1.5">
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent }} />
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent, animationDelay: '0.2s' }} />
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent, animationDelay: '0.4s' }} />
                            </div>
                        </div>
                    )}
                    <div ref={contactEndRef} />
                </div>

                {/* 底部：多选时＝删除选中条；否则＝发起/偷看对话（像聊天输入区） */}
                <div className="shrink-0 w-full p-4 pb-6">
                    {msgSelectMode ? (
                        <div className="flex gap-2">
                            <button onClick={exitMsgSelect}
                                className="px-5 py-3 rounded-2xl text-[13px] font-semibold text-white/75 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition">取消</button>
                            <button disabled={!selectedMsgIdx.length}
                                onClick={() => askConfirm({
                                    title: `删除选中的 ${selectedMsgIdx.length} 条消息？`,
                                    desc: c.kind === 'real' && c.linkedCharId ? '这几条会从两边手机里一并删除。' : '从这段对话里删掉这几条。',
                                    confirmLabel: '删除', danger: true, onConfirm: handleDeleteSelectedMessages,
                                })}
                                className="flex-1 py-3 rounded-2xl text-[13px] font-semibold text-white bg-rose-500 disabled:opacity-40 active:scale-[0.99] transition flex items-center justify-center gap-2">
                                <Trash size={16} weight="bold" /> 删除选中 {selectedMsgIdx.length || ''}
                            </button>
                        </div>
                    ) : isReal ? (
                        <button onClick={() => handleRealConversation(c)} disabled={isLoading}
                            className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white active:scale-[0.99] transition flex items-center justify-center gap-2"
                            style={{ background: `linear-gradient(135deg, ${accent}, ${accent}bb)` }}>
                            <PaperPlaneTilt size={16} weight="fill" /> {rec ? '继续真实对话（双方同步）' : '发起真实对话（A 发 B 回）'}
                        </button>
                    ) : (
                        <button onClick={() => handleNpcConversation(c)} disabled={isLoading}
                            className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white/90 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-2">
                            <ChatCircleDots size={16} weight="fill" /> {rec ? '偷看后续对话' : '偷看对话'}
                        </button>
                    )}
                </div>

                {/* 资料抽屉：点头像/… 滑出，备注 / 了解 / 好感 / 绑定 / 关系操作都在这里 */}
                {showProfile && (
                    <div className="absolute inset-0 z-[80] flex flex-col justify-end">
                        <div className="absolute inset-0 bg-black/55 animate-fade-in" onClick={closeProfile} />
                        <div className="relative max-h-[90%] overflow-y-auto no-scrollbar rounded-t-[28px] border-t border-white/[0.1] px-5 pt-3 pb-9 animate-slide-up space-y-3.5"
                            style={{ background: 'radial-gradient(120% 80% at 50% 0%, #1a1d27 0%, #101218 70%)' }}>
                            <div className="w-10 h-1 rounded-full bg-white/20 mx-auto" />
                            {/* 头部资料 */}
                            <div className="flex flex-col items-center gap-2 pt-1">
                                {avatarNode('w-20 h-20', 'text-2xl')}
                                <div className="text-[17px] font-semibold text-white text-center">{contactDisplayName(c)}</div>
                                <div className="flex items-center gap-2 flex-wrap justify-center">
                                    <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full" style={{ color: badge.color, background: `${badge.color}1f` }}>{badge.icon}{badge.label}</span>
                                    {c.identity && <span className="text-[11px] text-white/55">{c.identity}</span>}
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/55">{statusLabel}</span>
                                </div>
                            </div>

                            {/* 好感（可拖） */}
                            <div className="rounded-2xl p-4 bg-white/[0.04] border border-white/[0.06]">
                                <div className="flex items-center gap-2.5">
                                    <span className="text-[11px] text-white/45 shrink-0">好感</span>
                                    <input type="range" min={-100} max={100} step={1} value={aff}
                                        onChange={(e) => setAffinityDraft(parseInt(e.target.value, 10))}
                                        onPointerUp={commitAff} onTouchEnd={commitAff} onMouseUp={commitAff} onBlur={commitAff} onKeyUp={commitAff}
                                        aria-label="好感度" className="flex-1 h-2 cursor-pointer bg-transparent" style={{ accentColor: affColor(aff) }} />
                                    <span className="text-[12px] font-bold tabular-nums shrink-0 w-9 text-right" style={{ color: affColor(aff) }}>{aff > 0 ? '+' : ''}{aff}</span>
                                </div>
                            </div>

                            {/* 真人联系人列表里显示的备注名 / 关系（可人工锁定，后续扫描不覆盖） */}
                            {isReal && (
                                <div className="rounded-2xl p-4 bg-white/[0.04] border border-white/[0.06]">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">备注名 / 关系</span>
                                        <button onClick={() => { setEditingIdentity(!editingIdentity); setIdentityDraft(c.identity || ''); }} className="text-white/50 active:scale-90 transition" aria-label="编辑备注名">
                                            <PencilSimple size={14} weight="bold" />
                                        </button>
                                    </div>
                                    {editingIdentity ? (
                                        <div className="space-y-2">
                                            <input value={identityDraft} onChange={e => setIdentityDraft(e.target.value)} placeholder="例如：学长、前任、彼方网友"
                                                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-xl p-2.5 text-[12px] text-white/90" />
                                            <button onClick={() => handleSaveIdentity(c)} className="w-full py-2 rounded-xl text-[12px] font-semibold text-white" style={{ background: accent }}>保存</button>
                                            <p className="text-[9.5px] text-white/30">留空保存会恢复显示真名；人工保存后不会被再次扫描覆盖</p>
                                        </div>
                                    ) : (
                                        <p className="text-[12.5px] text-white/70 leading-relaxed">{c.identity || `（显示真名：${linkedCharOf(c)?.name || c.name}）`}</p>
                                    )}
                                </div>
                            )}

                            {/* 备注（事实，可编辑） */}
                            <div className="rounded-2xl p-4 bg-white/[0.04] border border-white/[0.06]">
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">备注</span>
                                    <button onClick={() => { setEditingNote(!editingNote); setNoteDraft(c.note || ''); }} className="text-white/50 active:scale-90 transition"><PencilSimple size={14} weight="bold" /></button>
                                </div>
                                {editingNote ? (
                                    <div className="space-y-2">
                                        <textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} placeholder="机主对 TA 的备注（事实/关系）…"
                                            className="w-full h-16 bg-white/[0.05] border border-white/[0.08] rounded-xl p-2.5 text-[12px] text-white/90 resize-none" />
                                        <button onClick={() => handleSaveNote(c)} className="w-full py-2 rounded-xl text-[12px] font-semibold text-white" style={{ background: accent }}>保存</button>
                                    </div>
                                ) : (
                                    <p className="text-[12.5px] text-white/70 leading-relaxed whitespace-pre-wrap">{c.note || '（无备注）'}</p>
                                )}
                            </div>

                            {/* 话题盒：聊满 100 条自动浓缩的第一人称聊天记忆（长按改/删）；原文仍在聊天里可看 */}
                            {c.topicBox && c.topicBox.length > 0 && (
                                <div className="rounded-2xl p-4 bg-white/[0.03] border border-white/[0.06]">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">话题盒 · 聊天记忆</span>
                                        <span className="text-[9px] text-white/30">长按改/删</span>
                                    </div>
                                    <div className="space-y-2">
                                        {c.topicBox.map(t => (
                                            <div key={t.id} {...longPress(() => setTopicEdit({ contactId: c.id, topicId: t.id, text: t.text }))}
                                                onClick={() => { if (lpFired.current) { lpFired.current = false; } }}
                                                className="rounded-xl px-3 py-2 bg-white/[0.03] border border-white/[0.05] active:bg-white/[0.06] transition select-none cursor-pointer">
                                                <p className="text-[11.5px] text-white/60 leading-relaxed whitespace-pre-wrap">{t.text}</p>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="text-[9.5px] text-white/25 mt-2">※ 每聊满 {ARCHIVE_EVERY} 条自动浓缩成一条第一人称记忆让 TA 记住；原文仍在聊天里可看</p>
                                </div>
                            )}

                            {/* 了解（印象，未必属实，自动累积） */}
                            <div className="rounded-2xl p-4 bg-white/[0.02] border border-white/[0.06] border-dashed">
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">了解 · {targetChar.name} 眼中的 TA</span>
                                    {c.learned && c.learned.trim() && (
                                        <button onClick={() => mutateContacts(cs => cs.map(x => x.id === c.id ? { ...x, learned: '' } : x))}
                                            className="text-white/40 active:scale-90 transition" aria-label="清空了解"><Trash size={13} weight="bold" /></button>
                                    )}
                                </div>
                                {c.learned && c.learned.trim() ? (
                                    <>
                                        <p className="text-[12px] text-white/55 leading-relaxed whitespace-pre-wrap">{c.learned}</p>
                                        <p className="text-[9.5px] text-white/30 mt-1.5">※ 来自相处的印象，是 TA 自己说的，未必属实</p>
                                    </>
                                ) : (
                                    <p className="text-[11.5px] text-white/30 leading-relaxed">还没聊出对 TA 的了解 · 多聊几句会自动累积（未必属实）</p>
                                )}
                            </div>

                            {/* 绑定 / 改绑 */}
                            <button onClick={() => { closeProfile(); setShowRebindModal(true); }}
                                className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 bg-white/[0.04] border border-white/[0.07] active:scale-[0.99] transition">
                                <LinkSimple size={13} weight="bold" className="shrink-0 text-white/50" />
                                <span className="text-[11px] text-white/55 flex-1 text-left truncate">
                                    {isReal ? `绑定真实角色：${linkedCharOf(c)?.name || '已绑定'}` : '虚构联系人（未绑定真实角色）'}
                                </span>
                                <span className="text-[11px] font-semibold shrink-0" style={{ color: accent }}>改绑定</span>
                            </button>

                            {/* 关系操作 */}
                            <div className="flex gap-2">
                                {c.status !== 'friend' && (
                                    <button onClick={() => handleSetContactStatus(c, 'friend')} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-emerald-200 bg-emerald-400/15 border border-emerald-400/20 active:scale-[0.99] transition flex items-center justify-center gap-1.5"><UserPlus size={14} weight="bold" /> 加好友</button>
                                )}
                                {c.status === 'friend' && (
                                    <button onClick={() => { closeProfile(); askConfirm({
                                        title: `删除好友「${c.name}」？`, desc: `${targetChar.name} 会察觉是你在偷看 TA 手机时删的。`,
                                        confirmLabel: '删好友', danger: true, onConfirm: () => handleSetContactStatus(c, 'deleted'),
                                    }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-rose-200 bg-rose-400/15 border border-rose-400/20 active:scale-[0.99] transition flex items-center justify-center gap-1.5"><Trash size={14} weight="bold" /> 删好友</button>
                                )}
                                {c.status !== 'blocked' && (
                                    <button onClick={() => { closeProfile(); askConfirm({
                                        title: `拉黑「${c.name}」？`, desc: `${targetChar.name} 会察觉是你在偷看 TA 手机时拉黑的。`,
                                        confirmLabel: '拉黑', danger: true, onConfirm: () => handleSetContactStatus(c, 'blocked'),
                                    }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/60 bg-white/[0.05] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-1.5"><Prohibit size={14} weight="bold" /> 拉黑</button>
                                )}
                            </div>

                            {/* 危险操作：清空对话 / 彻底移除 */}
                            <div className="flex gap-2">
                                {rec && (
                                    <button onClick={() => { closeProfile(); askConfirm({
                                        title: '清空这段对话？',
                                        desc: c.kind === 'real' && c.linkedCharId
                                            ? `会把「${c.name}」这段聊天记录、话题盒记忆清掉（对方手机里的镜像也一并清除），回到干净起点、之后可重新生成。`
                                            : `会把「${c.name}」这段聊天记录和话题盒记忆清掉，回到干净起点、之后可重新生成。`,
                                        confirmLabel: '清空', danger: true, onConfirm: () => handleClearContactConversation(c),
                                    }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/60 bg-white/[0.05] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-1.5"><ChatCircle size={14} weight="bold" /> 清空对话</button>
                                )}
                                <button onClick={() => { closeProfile(); askConfirm({
                                    title: '彻底移除该联系人？',
                                    desc: c.kind === 'real' && c.linkedCharId
                                        ? `会把「${c.name}」连同 TA 的聊天记录、私聊里的卡片一起删除；绑定的真实角色那边的镜像联系人和记录也一并清除（绑错了就用这个清干净）。`
                                        : `会把「${c.name}」连同 TA 的聊天记录、私聊里的卡片一起彻底删除。`,
                                    confirmLabel: '彻底移除', danger: true, onConfirm: () => handleRemoveContact(c),
                                }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-rose-200 bg-rose-400/15 border border-rose-400/20 active:scale-[0.99] transition flex items-center justify-center gap-1.5"><Trash size={14} weight="bold" /> 彻底移除</button>
                            </div>
                        </div>
                    </div>
                )}
            </SubAppShell>
        );
    };

    const renderCustomItem = (r: PhoneEvidence, idx: number, total: number, accent: string, layout: LayoutId, app: PhoneCustomApp) => {
        switch (layout) {
            case 'shop':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative flex gap-3 rounded-2xl p-3 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                        <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center text-2xl" style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>{app.icon}</div>
                        <div className="flex-1 min-w-0 flex flex-col">
                            <div className="text-[13px] font-medium text-white/95 leading-snug line-clamp-2">{r.title}</div>
                            <div className="text-[10.5px] text-white/40 mt-0.5 line-clamp-1">{r.detail}</div>
                            <div className="mt-auto flex items-center justify-between pt-1.5">
                                <span className="text-[14px] font-bold" style={{ color: accent }}>{r.value || '¥ --'}</span>
                                <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 tracking-wider">已下单</span>
                            </div>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'feed':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                        <div className="flex items-center gap-3 mb-2.5">
                            <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg" style={{ background: `linear-gradient(135deg, ${accent}55, ${accent}15)` }}>{app.icon}</div>
                            <div className="min-w-0">
                                <div className="text-[13px] font-semibold text-white/95">{charName}</div>
                                <div className="text-[10px] text-white/35">{r.title || fmtClock(r.timestamp)}</div>
                            </div>
                        </div>
                        <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                        <div className="flex items-center gap-5 mt-3 pt-2.5 border-t border-white/[0.06] text-white/40">
                            <span className="flex items-center gap-1.5 text-[11px]"><Heart size={14} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)}</span>
                            <span className="flex items-center gap-1.5 text-[11px]"><ChatCircle size={14} /> {1 + (r.id.length % 9)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'forum':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                            <span className="text-[14px] font-semibold text-white/95 leading-snug line-clamp-2 flex-1">{r.title}</span>
                            {r.value && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md shrink-0" style={{ color: accent, background: `${accent}1f` }}>{r.value}</span>}
                        </div>
                        <div className="text-[12px] text-white/55 leading-relaxed line-clamp-3 whitespace-pre-wrap">{r.detail}</div>
                        <div className="flex items-center gap-3 mt-2.5 text-[10px] text-white/35">
                            <span className="flex items-center gap-1">{app.icon} {charName}</span>
                            <span>· {1 + (r.id.length % 200)} 回复</span>
                            <span>· {fmtClock(r.timestamp)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'novel':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" style={{ boxShadow: `inset 0 0 30px ${accent}10` }}>
                        <div className="text-[10px] tracking-[0.2em] uppercase mb-1" style={{ color: accent }}>Chapter {total - idx}</div>
                        <div className="text-[15px] font-semibold text-white/95 mb-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{r.title}</div>
                        <div className="text-[12.5px] text-white/60 leading-loose line-clamp-4 whitespace-pre-wrap" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{r.detail}</div>
                        <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/[0.06] text-[10px] text-white/30">
                            <span>{r.value || '连载中'}</span>
                            <span className="tabular-nums">{fmtClock(r.timestamp)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            default:
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" style={{ boxShadow: `inset 0 0 24px ${accent}14` }}>
                        <div className="flex justify-between items-start gap-2 mb-1.5">
                            <span className="text-[13.5px] font-semibold text-white/95 line-clamp-1">{r.title}</span>
                            {r.value && <span className="text-[12px] font-bold px-2 py-0.5 rounded-full shrink-0" style={{ color: accent, background: `${accent}1f` }}>{r.value}</span>}
                        </div>
                        <div className="text-[12px] text-white/55 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                        <div className="text-[9.5px] text-white/25 mt-2 text-right tabular-nums">{fmtClock(r.timestamp)}</div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
        }
    };

    const renderCustomApp = (app: PhoneCustomApp) => {
        const accent = app.color || '#8b9cff';
        const layout = app.layout || 'generic';
        const layoutMeta = APP_LAYOUTS.find(l => l.id === layout);
        const list = records.filter(r => r.type === app.id).sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title={app.name} sub={layoutMeta?.name || 'custom app'} accent={accent} onBack={() => setActiveAppId('home')}
                    right={<button onClick={() => openCustomAppEditor(app)} className="px-3 py-2 text-xs" aria-label={`编辑${app.name}`}>编辑</button>} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="暂无数据" />}
                    {list.map((r, idx) => renderCustomItem(r, idx, list.length, accent, layout, app))}
                </div>
                <RefreshFab onClick={() => handleGenerate(app.id, app.prompt, layout)} label="刷新数据" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    // ============================================================
    //  HOME DESKTOP (mirrors the reference design)
    // ============================================================
    const renderHomePage = () => (
        <div className="w-1/2 h-full overflow-y-auto no-scrollbar overscroll-none px-6 pt-2 pb-32">
            {/* Header */}
            <div className="flex items-start justify-between mb-5">
                <div className="min-w-0">
                    <h1 className="text-[34px] leading-none text-white font-light tracking-wide truncate" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{charName}</h1>
                    <p className="text-[11px] tracking-[0.35em] uppercase text-white/40 mt-2">The Space Between</p>
                    <div className="h-px w-28 bg-gradient-to-r from-white/30 to-transparent mt-3" />
                </div>
                <div className="flex flex-col items-end shrink-0 pt-1 text-white/70">
                    <Cloud size={26} weight="light" />
                    <span className="text-[15px] font-light mt-1 tabular-nums">{temp}°C</span>
                </div>
            </div>

            {/* Time */}
            <div className="mb-4">
                <div className="text-[30px] font-extralight text-white tracking-[0.08em] tabular-nums">{clockNow}</div>
                <div className="text-[12px] text-white/45 mt-0.5">{dateNow}</div>
            </div>

            {/* Quote：有最近的内心独白(InnerState)就显示它（一行截断，点按看全文），否则兜底诗句 */}
            {innerQuote ? (
                <button onClick={() => setShowInner(true)} className="block w-full text-left mb-5 group">
                    <p className="text-[13px] text-white/65 italic leading-relaxed line-clamp-1">「{innerQuote}」</p>
                    <span className="text-[9px] tracking-wider text-white/30 group-active:text-white/55">有些话没说出口 · 轻触</span>
                </button>
            ) : (
                <p className="text-[13px] text-white/55 italic mb-5 leading-relaxed">{fallbackQuote}</p>
            )}

            {/* Persona simulation hero */}
            <button onClick={() => { setActiveAppId('persona'); trackEvent('打开查手机子应用', { subApp: 'persona' }); }}
                className="relative w-full rounded-[24px] p-5 mb-3.5 text-left overflow-hidden border border-white/[0.09] active:scale-[0.98] transition-transform"
                style={{ background: 'linear-gradient(115deg, rgba(184,155,255,0.22), rgba(120,90,214,0.08) 55%, rgba(20,18,30,0.4))' }}>
                <div className="absolute -top-10 -right-6 w-40 h-40 rounded-full blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(184,155,255,0.55), transparent 70%)' }} />
                <div className="relative z-10">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/55">Persona Simulation</div>
                    <div className="text-[18px] font-light text-white mt-1.5" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>成为 TA 的一段人生</div>
                    <div className="text-[11px] text-white/55 mt-1.5">不是查看 TA 的手机 · 是用 TA 的手机活一次</div>
                    <div className="flex items-center justify-between mt-4">
                        <span className="text-[11px] text-white/45 flex items-center gap-1.5">
                            <ClockCounterClockwise size={13} /> 生活记录 · {simLogCount}
                        </span>
                        <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: '#c9b6ff' }}>进入演出 <CaretRight size={11} weight="bold" /></span>
                    </div>
                </div>
            </button>

            {/* App cards —— 「联系人」占据原 Message 的主位（Message 已废弃，收进联系人里做不起眼入口） */}
            <div className="grid grid-cols-2 gap-3.5 mb-3.5">
                <HomeCard icon={<UsersThree size={24} weight="light" />} label="联系人" sub={contactsSub} accent="#f472b6"
                    onClick={() => { setActiveAppId('contacts'); trackEvent('打开查手机子应用', { subApp: 'contacts' }); }} />
                <HomeCard icon={<ImagesSquare size={24} weight="light" />} label="Moments" sub={momentsSub} accent="#c084fc"
                    onClick={() => { setActiveAppId('social'); trackEvent('打开查手机子应用', { subApp: 'social' }); }} />
                <HomeCard icon={<Hamburger size={24} weight="light" />} label="Food" sub={foodSub} accent="#fbbf24"
                    onClick={() => { setActiveAppId('waimai'); trackEvent('打开查手机子应用', { subApp: 'waimai' }); }} />
                <HomeCard icon={<ShoppingBag size={24} weight="light" />} label="Taobao" sub={taobaoSub} accent="#ff7a45"
                    onClick={() => { setActiveAppId('taobao'); trackEvent('打开查手机子应用', { subApp: 'taobao' }); }} />
            </div>

            {/* 智能体：偷看「TA 的小手机」 —— 给个抢眼的横条入口 */}
            <button onClick={() => { setActiveAppId('aiagent'); trackEvent('打开查手机子应用', { subApp: 'aiagent' }); }}
                className="relative w-full rounded-[24px] p-4 mb-3.5 text-left overflow-hidden border border-white/[0.09] active:scale-[0.98] transition-transform flex items-center gap-3.5"
                style={{ background: 'linear-gradient(115deg, rgba(52,211,153,0.20), rgba(16,185,129,0.06) 55%, rgba(12,20,18,0.4))' }}>
                <div className="absolute -top-10 -right-6 w-36 h-36 rounded-full blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(52,211,153,0.45), transparent 70%)' }} />
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center border border-white/[0.08] shrink-0 relative z-10"
                    style={{ background: 'linear-gradient(135deg, #34d39933, #34d3990a)', color: '#34d399', boxShadow: 'inset 0 0 16px #34d39922' }}>
                    <Robot size={24} weight="light" />
                </div>
                <div className="relative z-10 min-w-0 flex-1">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/55">AI Agents</div>
                    <div className="text-[16px] font-semibold text-white mt-0.5">智能体</div>
                    <div className="text-[11px] text-white/55 mt-0.5 truncate">{aiSub}</div>
                </div>
                <CaretRight size={16} weight="bold" className="relative z-10 text-white/40 shrink-0" />
            </button>

            {/* Add app + my apps row */}
            <div className="grid grid-cols-2 gap-3.5 mb-7">
                <button onClick={() => openCustomAppEditor()}
                    className={`${customApps.length ? '' : 'col-span-2'} rounded-[20px] p-4 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[90px]`}>
                    <Plus size={22} weight="light" className="text-white/60" />
                    <span className="text-[11px] tracking-[0.25em] uppercase text-white/50">Add App</span>
                </button>
                {customApps.length > 0 && (
                    <button onClick={() => setPage(1)}
                        className="rounded-[20px] p-4 border border-white/[0.07] bg-white/[0.03] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[90px]">
                        <DotsThree size={26} weight="bold" className="text-white/60" />
                        <span className="text-[11px] tracking-[0.25em] uppercase text-white/50">My Apps · {customApps.length}</span>
                    </button>
                )}
            </div>

            {/* Today's activity */}
            <div className="rounded-[22px] p-4 border border-white/[0.07] bg-white/[0.025] backdrop-blur-xl mb-6">
                <div className="flex items-center justify-between mb-3.5">
                    <span className="text-[10px] tracking-[0.25em] uppercase text-white/45">Today's Activity</span>
                    <span className="text-[10px] text-white/35 flex items-center gap-0.5">More <CaretRight size={10} weight="bold" /></span>
                </div>
                <div className="flex gap-4">
                    <div className="flex-1 min-w-0 space-y-2.5">
                        {activity.length === 0 && <div className="text-[11px] text-white/30">尚无活动记录</div>}
                        {activity.map((a, i) => (
                            <div key={i} className="flex items-center gap-3">
                                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i === activity.length - 1 ? '#c084fc' : 'rgba(255,255,255,0.3)' }} />
                                <span className="text-[11px] text-white/45 tabular-nums w-[58px] shrink-0">{fmtClock(a.t)}</span>
                                <span className="text-[12px] text-white/75 truncate">{a.label}</span>
                            </div>
                        ))}
                    </div>
                    <div className="relative w-24 h-24 shrink-0 flex items-center justify-center">
                        <svg viewBox="0 0 100 100" className="w-24 h-24 -rotate-90">
                            <circle cx="50" cy="50" r="42" stroke="rgba(255,255,255,0.08)" strokeWidth="3" fill="none" />
                            <circle cx="50" cy="50" r="42" stroke="url(#stRing)" strokeWidth="3" fill="none" strokeLinecap="round"
                                strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - ringP)} />
                            <defs>
                                <linearGradient id="stRing" x1="0" y1="0" x2="1" y2="1">
                                    <stop offset="0%" stopColor="#c084fc" />
                                    <stop offset="100%" stopColor="#8b9cff" />
                                </linearGradient>
                            </defs>
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <span className="text-[8px] tracking-[0.15em] uppercase text-white/40">Screen</span>
                            <span className="text-[14px] font-light text-white tabular-nums">{stH}h {stM}m</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Last seen */}
            <div className="flex items-center justify-center gap-1.5 text-white/35">
                <LockSimple size={12} weight="fill" />
                <span className="text-[11px] tracking-wide">{lastSeenText}</span>
            </div>
        </div>
    );

    const renderAppsPage = () => (
        <div className="w-1/2 h-full overflow-y-auto no-scrollbar overscroll-none px-6 pt-4 pb-32">
            <div className="flex items-center justify-between mb-6">
                <button onClick={() => setPage(0)} className="flex items-center gap-1 text-white/50 text-[12px]">
                    <CaretLeft size={14} weight="bold" /> Home
                </button>
                <span className="text-[11px] tracking-[0.3em] uppercase text-white/45">Installed Apps</span>
                <div className="w-12" />
            </div>
            <div className="grid grid-cols-2 gap-3.5">
                {customApps.map(app => {
                    const accent = app.color || '#8b9cff';
                    const count = records.filter(r => r.type === app.id).length;
                    return (
                        <div key={app.id} className="relative group">
                            <button onClick={() => setActiveAppId(app.id)}
                                className="w-full rounded-[24px] p-4 text-left overflow-hidden border border-white/[0.07] bg-white/[0.035] backdrop-blur-xl active:scale-[0.98] transition min-h-[130px] flex flex-col justify-between">
                                <div className="absolute -top-8 -right-8 w-28 h-28 rounded-full blur-2xl opacity-50 pointer-events-none"
                                    style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }} />
                                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl border border-white/[0.08] relative z-10"
                                    style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0a)`, boxShadow: `inset 0 0 16px ${accent}22` }}>
                                    {app.icon}
                                </div>
                                <div className="relative z-10">
                                    <div className="text-[14px] font-semibold text-white truncate">{app.name}</div>
                                    <div className="text-[10.5px] text-white/40 mt-0.5">{count} 条记录</div>
                                    <div className="h-[3px] w-8 rounded-full mt-2" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
                                </div>
                            </button>
                            <button onClick={() => handleDeleteApp(app.id)}
                                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-rose-500 text-white rounded-full flex items-center justify-center text-[12px] leading-none opacity-0 group-hover:opacity-100 transition z-20 shadow-md">×</button>
                        </div>
                    );
                })}
                <button onClick={() => openCustomAppEditor()}
                    className="rounded-[24px] p-4 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[130px]">
                    <Plus size={24} weight="light" className="text-white/60" />
                    <span className="text-[11px] tracking-[0.2em] uppercase text-white/50">Add App</span>
                </button>
            </div>
        </div>
    );

    const renderDesktop = () => {
        const hasBg = !!dateBackgroundUrl;
        const totalPages = customApps.length > 0 ? 2 : 1;

        const onTouchStart = (e: React.TouchEvent) => {
            touchStartX.current = e.touches[0].clientX;
            touchStartY.current = e.touches[0].clientY;
        };
        const onTouchEnd = (e: React.TouchEvent) => {
            if (touchStartX.current == null || touchStartY.current == null) return;
            const dx = e.changedTouches[0].clientX - touchStartX.current;
            const dy = e.changedTouches[0].clientY - touchStartY.current;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                if (dx < 0 && page < totalPages - 1) setPage(page + 1);
                if (dx > 0 && page > 0) setPage(page - 1);
            }
            touchStartX.current = null;
            touchStartY.current = null;
        };

        return (
            <div className="absolute inset-0 flex flex-col z-0 overflow-hidden bg-[#070809]">
                {/* Cinematic background */}
                <div className="absolute inset-0 pointer-events-none"
                    style={{ background: 'radial-gradient(120% 80% at 50% 0%, #1a1d2b 0%, #0a0c12 55%, #060709 100%)' }} />
                {hasBg && (
                    <div className="absolute inset-0 opacity-25 pointer-events-none"
                        style={{ backgroundImage: `url("${dateBackgroundUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
                )}
                <div className="absolute inset-0 pointer-events-none"
                    style={{ background: 'linear-gradient(to bottom, rgba(7,8,9,0.35) 0%, rgba(7,8,9,0.1) 30%, rgba(7,8,9,0.85) 100%)' }} />
                <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white/15 to-transparent pointer-events-none z-20" />

                <StatusStrip />

                {/* Pager */}
                <div className="flex-1 relative z-10 overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                    <div className="flex h-full w-[200%] transition-transform duration-500 ease-out"
                        style={{ transform: `translateX(-${page * 50}%)` }}>
                        {renderHomePage()}
                        {renderAppsPage()}
                    </div>
                </div>

                {/* Page dots */}
                {totalPages > 1 && (
                    <div className="absolute bottom-[88px] left-1/2 -translate-x-1/2 flex gap-2 z-40">
                        {Array.from({ length: totalPages }).map((_, i) => (
                            <button key={i} onClick={() => setPage(i)}
                                className="rounded-full transition-all"
                                style={{ width: page === i ? 18 : 6, height: 6, background: page === i ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)' }} />
                        ))}
                    </div>
                )}

                {/* Floating glass nav */}
                <nav className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[90%] z-40">
                    <div className="bg-white/[0.06] backdrop-blur-2xl rounded-[26px] border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)] flex justify-around items-center px-3 py-2.5">
                        <button onClick={() => setActiveAppId('call')} className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <Phone size={22} weight="light" />
                        </button>
                        <button onClick={() => setActiveAppId('contacts')} aria-label="联系人" className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <UsersThree size={22} weight="light" />
                        </button>
                        <button onClick={handleExitPhone} aria-label="断开连接"
                            className="relative flex items-center justify-center w-14 h-14 rounded-full active:scale-90 transition -my-1"
                            style={{ background: 'radial-gradient(circle at 35% 30%, #b89bff, #6d5bd6 55%, #2a2150 100%)', boxShadow: '0 0 24px rgba(157,124,255,0.55), inset 0 0 18px rgba(255,255,255,0.25)' }}>
                            <SignOut size={22} weight="bold" className="text-white" />
                        </button>
                        <button onClick={() => setActiveAppId('social')} className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <Compass size={22} weight="light" />
                        </button>
                        <button onClick={toggleSendToChat} aria-label="同步到私聊"
                            className="relative flex items-center justify-center p-2.5 hover:text-white rounded-2xl transition active:scale-90"
                            style={{ color: sendToChat ? '#7dd3fc' : 'rgba(255,255,255,0.4)' }}>
                            <GearSix size={22} weight={sendToChat ? 'fill' : 'light'} />
                            <span className="absolute bottom-1 right-1.5 w-1.5 h-1.5 rounded-full"
                                style={{ background: sendToChat ? '#7dd3fc' : 'rgba(255,255,255,0.25)', boxShadow: sendToChat ? '0 0 6px #7dd3fc' : 'none' }} />
                        </button>
                    </div>
                </nav>
            </div>
        );
    };

    // ============================================================
    //  TARGET-SELECT SCREEN
    // ============================================================
    if (view === 'select') {
        return (
            <div className="absolute inset-0 flex flex-col overflow-hidden text-white"
                style={{ background: 'radial-gradient(120% 80% at 50% 0%, #161826 0%, #0a0b10 60%)' }}>
                <StatusStrip />
                <div className="h-14 flex items-center justify-between px-4 shrink-0">
                    <button onClick={closeApp} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                        <CaretLeft size={18} weight="bold" />
                    </button>
                    <span className="font-semibold tracking-[0.25em] uppercase text-[13px] text-white/80">Target Device</span>
                    <button onClick={() => { setPhoneApiTestResult(null); setShowApiSettings(true); }} aria-label="查手机 API 设置"
                        className="relative w-9 h-9 rounded-full flex items-center justify-center text-white/75 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                        <GearSix size={17} weight={phoneApiFollowsDefault ? 'regular' : 'fill'} />
                        {!phoneApiFollowsDefault && <span className="absolute right-1.5 bottom-1.5 h-1.5 w-1.5 rounded-full bg-violet-400 shadow-[0_0_6px_#a78bfa]" />}
                    </button>
                </div>
                {(() => {
                    const PER_PAGE = 6;
                    const groupChars = filterCharactersByGroup(characters, characterGroups, selectGroupId);
                    const pageCount = Math.max(1, Math.ceil(groupChars.length / PER_PAGE));
                    const cur = Math.min(selectPage, pageCount - 1);
                    const pageChars = groupChars.slice(cur * PER_PAGE, cur * PER_PAGE + PER_PAGE);
                    return (
                        <div className="flex-1 min-h-0 flex flex-col">
                            <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark
                                value={selectGroupId} onChange={(id) => { setSelectGroupId(id); setSelectPage(0); }}
                                className="px-5 pt-1 shrink-0" />
                            <div className="flex-1 min-h-0 px-5 grid grid-cols-2 grid-rows-3 gap-4 content-center pb-4 pt-2">
                                {pageChars.map(c => (
                                    <div key={c.id} onClick={() => handleSelectChar(c)}
                                        className="min-h-0 rounded-3xl border border-white/[0.07] bg-white/[0.03] backdrop-blur-xl p-4 flex flex-col items-center justify-center gap-3 cursor-pointer active:scale-95 transition group hover:border-violet-400/50 hover:shadow-[0_0_24px_rgba(157,124,255,0.25)] relative overflow-hidden">
                                        <div className="absolute -top-10 -right-10 w-28 h-28 rounded-full blur-3xl bg-violet-500/0 group-hover:bg-violet-500/20 transition" />
                                        <div className="w-20 h-20 rounded-full p-[2px] border-2 border-white/15 group-hover:border-violet-400/70 transition-colors relative z-10 shrink-0">
                                            <TokenImg value={c.avatar} className="w-full h-full rounded-full object-cover grayscale group-hover:grayscale-0 transition-all" />
                                        </div>
                                        <div className="text-center relative z-10">
                                            <div className="font-semibold text-white/90 text-sm group-hover:text-violet-300">{c.name}</div>
                                            <div className="text-[10px] text-white/35 font-mono mt-1 tracking-widest">CONNECT &gt;</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {pageCount > 1 && (
                                <div className="shrink-0 flex items-center justify-center gap-4 pb-6 pt-3">
                                    <button onClick={() => setSelectPage(Math.max(0, cur - 1))} disabled={cur === 0}
                                        className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition disabled:opacity-30 disabled:active:scale-100">
                                        <CaretLeft size={16} weight="bold" />
                                    </button>
                                    <div className="flex items-center gap-2">
                                        {Array.from({ length: pageCount }, (_, pi) => (
                                            <button key={pi} onClick={() => setSelectPage(pi)} aria-label={`第 ${pi + 1} 页`}
                                                className={`h-2 rounded-full transition-all active:scale-90 ${pi === cur ? 'w-5 bg-violet-400' : 'w-2 bg-white/25'}`} />
                                        ))}
                                    </div>
                                    <button onClick={() => setSelectPage(Math.min(pageCount - 1, cur + 1))} disabled={cur === pageCount - 1}
                                        className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition disabled:opacity-30 disabled:active:scale-100">
                                        <CaretLeft size={16} weight="bold" className="rotate-180" />
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })()}
                <Modal isOpen={showApiSettings} title="查手机 · API 设置" onClose={() => setShowApiSettings(false)}>
                    <div className="space-y-3">
                        <p className="text-[11px] leading-relaxed text-slate-500">
                            查手机里的内容生成、人际关系对话、智能体和人格模拟都会走这里。单独选择后不影响聊天；不设置则跟随聊天默认。
                        </p>
                        <div className="rounded-2xl bg-slate-50 border border-slate-200 p-3.5">
                            <div className="text-[10px] tracking-[0.18em] text-slate-400 mb-1">当前生效</div>
                            <div className="text-[13px] font-bold text-slate-800 break-all">{effectiveApiConfig?.model || '未配置'}</div>
                            <div className="text-[10.5px] text-slate-400 mt-0.5 break-all">
                                {apiHost(effectiveApiConfig?.baseUrl)} · {phoneApiFollowsDefault ? '跟随聊天默认' : '查手机独立'}
                            </div>
                            <button onClick={testPhoneApi} disabled={testingPhoneApi}
                                className="mt-2.5 px-3 py-1.5 rounded-full bg-violet-100 text-violet-700 text-[11px] font-bold disabled:opacity-50">
                                {testingPhoneApi ? '测试中…' : '测试连接'}
                            </button>
                            {phoneApiTestResult && (
                                <div className={`mt-2 rounded-xl px-2.5 py-2 text-[10.5px] leading-relaxed ${phoneApiTestResult.startsWith('连接成功') ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                                    {phoneApiTestResult}
                                </div>
                            )}
                        </div>

                        <div className="text-[10px] tracking-[0.18em] text-slate-400 px-1">选择 API</div>
                        <button onClick={() => choosePhoneApi(null)}
                            className={`w-full rounded-2xl border p-3 text-left transition ${phoneApiFollowsDefault ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white'}`}>
                            <div className="flex items-center gap-2">
                                <div className="min-w-0 flex-1">
                                    <div className="text-[12px] font-bold text-slate-800">跟随聊天默认</div>
                                    <div className="text-[10px] text-slate-400 truncate">{apiConfig?.model || '未配置'} · {apiHost(apiConfig?.baseUrl)}</div>
                                </div>
                                {phoneApiFollowsDefault && <span className="text-[10px] font-bold text-violet-600">✓ 使用中</span>}
                            </div>
                        </button>

                        {apiPresets.length === 0 ? (
                            <p className="px-1 text-[10.5px] leading-relaxed text-slate-400">“设置”里还没有保存的 API 预设。先保存预设，这里就能单独选择。</p>
                        ) : apiPresets.map(preset => {
                            const active = isSamePhoneApi(preset.config);
                            return (
                                <button key={preset.id} onClick={() => choosePhoneApi(preset.config)}
                                    className={`w-full rounded-2xl border p-3 text-left transition ${active ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white'}`}>
                                    <div className="flex items-center gap-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[12px] font-bold text-slate-800 truncate">{preset.name}</div>
                                            <div className="text-[10px] text-slate-400 truncate">{preset.config.model || '未配置'} · {apiHost(preset.config.baseUrl)}</div>
                                        </div>
                                        {active && <span className="text-[10px] font-bold text-violet-600">✓ 使用中</span>}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </Modal>
            </div>
        );
    }

    // ============================================================
    //  PHONE VIEW
    // ============================================================
    const customActive = customApps.find(a => a.id === activeAppId);
    return (
        <div className="absolute inset-0 bg-[#070809] overflow-hidden font-sans overscroll-none">
            {activeAppId === 'home' ? renderDesktop() : (
                <>
                    {activeAppId === 'chat' && renderChatList()}
                    {activeAppId === 'chat_detail' && renderChatDetail()}
                    {activeAppId === 'evidence_detail' && renderEvidenceDetail()}
                    {activeAppId === 'contacts' && renderContactsList()}
                    {activeAppId === 'contact_detail' && renderContactDetail()}
                    {activeAppId === 'call' && renderCallList()}
                    {activeAppId === 'taobao' && renderShop()}
                    {activeAppId === 'waimai' && renderFood()}
                    {activeAppId === 'social' && renderMoments()}
                    {activeAppId === 'aiagent' && renderAiAgent()}
                    {activeAppId === 'ai_session' && renderAiSession()}
                    {activeAppId === 'persona' && targetChar && (
                        <PersonaSim key={targetChar.id} targetChar={targetChar} onExit={() => setActiveAppId('home')} openLifeLog={() => setActiveAppId('lifelog')}
                            sim={sim.charId === targetChar.id ? sim : { status: 'idle' }} onStart={runSim} onConsumed={() => personaSimStore.reset()} />
                    )}
                    {activeAppId === 'lifelog' && targetChar && (
                        <LifeLog targetChar={targetChar} onBack={() => setActiveAppId('home')}
                            onRequestDelete={requestDeleteSimLog}
                            onReplay={(log, action) => {
                                if (!log.script) return;
                                // 用存下来的脚本快照原样回放——直接喂给全局 store 的 ready 态
                                personaSimStore.set({ status: 'ready', mode: log.mode, theme: log.theme, script: log.script, logId: log.id, startIndex: action === 'resume' ? getPersonaSimBeatIndex(log) : 0, charId: targetChar.id, charName: targetChar.name });
                                setActiveAppId('persona');
                            }} />
                    )}
                    {customActive && renderCustomApp(customActive)}
                </>
            )}

            {/* InnerState 全文 —— 「此刻内心」专属卡片 */}
            {showInner && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-fade-in">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setShowInner(false)} />
                    <div className="relative w-full max-w-sm bg-white rounded-[2.5rem] shadow-2xl overflow-hidden animate-slide-up">
                        {/* 标题 + 星点 */}
                        <div className="px-6 pt-7 pb-3 flex items-center justify-center gap-2.5">
                            <span className="flex items-end gap-0.5 text-[#b3c2f6]"><span className="w-1 h-1 rounded-full bg-current" /><span className="w-1.5 h-1.5 rounded-full bg-current" /><span className="w-1 h-1 rounded-full bg-current mb-1" /></span>
                            <h3 className="text-lg font-bold text-slate-800">TA 此刻的内心</h3>
                            <span className="flex items-end gap-0.5 text-[#b3c2f6]"><span className="w-1 h-1 rounded-full bg-current mb-1" /><span className="w-1.5 h-1.5 rounded-full bg-current" /><span className="w-1 h-1 rounded-full bg-current" /></span>
                        </div>
                        {/* 引文面板 */}
                        <div className="px-6 pb-2">
                            <div className="relative bg-slate-50 rounded-3xl px-5 pt-7 pb-5 max-h-[52vh] overflow-y-auto no-scrollbar">
                                <span className="absolute top-2 left-4 text-[42px] leading-none font-black select-none pointer-events-none" style={{ color: '#5f82ef' }}>“</span>
                                <p className="relative text-[14.5px] leading-[2] text-slate-600 whitespace-pre-wrap px-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                                    {innerQuote}
                                </p>
                                <span className="block text-right text-[42px] leading-none font-black select-none pointer-events-none pr-2" style={{ color: '#5f82ef' }}>”</span>
                            </div>
                        </div>
                        {/* 关闭 */}
                        <div className="px-6 pb-6 pt-3">
                            <button onClick={() => setShowInner(false)}
                                className="w-full py-3.5 rounded-2xl text-white font-bold active:scale-[0.99] transition"
                                style={{ background: '#5f82ef' }}>关闭</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 查手机记录 · 长按后可事后补同步到私聊 */}
            {evidenceMenu && (
                <div className="fixed inset-0 z-[120] flex items-end justify-center animate-fade-in" onClick={() => setEvidenceMenu(null)}>
                    <div className="absolute inset-0 bg-black/50" />
                    <div className="relative w-full max-w-sm m-3 mb-6 space-y-2" onClick={event => event.stopPropagation()}>
                        <div className="rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10">
                            <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10 truncate">查手机记录：{evidenceMenu.record.title}</div>
                            <button
                                onClick={() => void syncEvidenceRecordToChat(evidenceMenu.record)}
                                disabled={!!evidenceMenu.record.systemMessageId}
                                className="w-full px-4 py-3.5 text-left text-[14px] text-sky-300 active:bg-white/5 transition flex items-center gap-3 disabled:text-white/30"
                            ><PaperPlaneTilt size={17} /> {evidenceMenu.record.systemMessageId ? '已同步到私聊' : '同步到私聊'}</button>
                            <button onClick={() => {
                                const record = evidenceMenu.record;
                                setEvidenceMenu(null);
                                askConfirm({ title: '删除这条记录？', desc: `删除「${record.title}」后无法恢复。`, confirmLabel: '删除', danger: true, onConfirm: () => handleDeleteRecord(record) });
                            }} className="w-full px-4 py-3.5 text-left text-[14px] text-rose-400 active:bg-white/5 transition flex items-center gap-3 border-t border-white/10"><Trash size={17} /> 删除记录</button>
                        </div>
                        <button onClick={() => setEvidenceMenu(null)} className="w-full rounded-2xl bg-[#1c1d22] border border-white/10 py-3.5 text-[14px] font-semibold text-white/80">取消</button>
                    </div>
                </div>
            )}

            {/* 智能体 · 长按动作菜单（会话/卡片：编辑 / 删除） */}
            {aiMenu && (() => {
                const isSession = aiMenu.kind === 'session';
                const sObj = isSession ? aiSessions.find(s => s.id === aiMenu.id) : null;
                const cObj = !isSession ? aiCards.find(c => c.id === aiMenu.id) : null;
                if (isSession ? !sObj : !cObj) return null;
                const name = isSession ? (sObj!.title || '会话') : (cObj!.name || '卡片');
                return (
                    <div className="fixed inset-0 z-[120] flex items-end justify-center animate-fade-in" onClick={() => setAiMenu(null)}>
                        <div className="absolute inset-0 bg-black/50" />
                        <div className="relative w-full max-w-sm m-3 mb-6 space-y-2" onClick={e => e.stopPropagation()}>
                            <div className="rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10">
                                <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10 truncate">{isSession ? '会话' : (cObj!.kind === 'world' ? '世界卡' : '角色卡')}：{name}</div>
                                <button onClick={() => { setAiEdit(isSession ? { kind: 'session', id: aiMenu.id, title: sObj!.title } : { kind: 'card', id: aiMenu.id, name: cObj!.name, emoji: cObj!.emoji, persona: cObj!.persona, scenario: cObj!.scenario }); setAiMenu(null); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-white active:bg-white/5 transition flex items-center gap-3"><PencilSimple size={17} /> 编辑</button>
                                <button onClick={() => { const id = aiMenu.id; const k = isSession; setAiMenu(null); askConfirm({ title: k ? `删除会话「${sObj!.title}」？` : `删除${cObj!.kind === 'world' ? '世界卡' : '角色卡'}「${cObj!.name}」？`, desc: k ? '这段对话记录会被删除，无法撤销。' : '这张卡会被删除（已有对戏记录保留），无法撤销。', confirmLabel: '删除', danger: true, onConfirm: () => (k ? handleDeleteAiSession : handleDeleteAiCard)(id) }); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-rose-400 active:bg-white/5 transition flex items-center gap-3 border-t border-white/10"><Trash size={17} /> 删除</button>
                            </div>
                            <button onClick={() => setAiMenu(null)} className="w-full rounded-2xl bg-[#1c1d22] border border-white/10 py-3.5 text-[14px] font-semibold text-white/80">取消</button>
                        </div>
                    </div>
                );
            })()}

            {/* 智能体 · 会话内单条内容 长按动作菜单（编辑 / 删除） */}
            {aiTurnMenu !== null && selectedAiSession && (() => {
                const turns = turnsOf(selectedAiSession);
                const turn = turns[aiTurnMenu];
                if (!turn) return null;
                const preview = turn.text.replace(/\n/g, ' ').trim().slice(0, 22);
                return (
                    <div className="fixed inset-0 z-[120] flex items-end justify-center animate-fade-in" onClick={() => setAiTurnMenu(null)}>
                        <div className="absolute inset-0 bg-black/50" />
                        <div className="relative w-full max-w-sm m-3 mb-6 space-y-2" onClick={e => e.stopPropagation()}>
                            <div className="rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10">
                                <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10 truncate">这条内容：{preview}…</div>
                                <button onClick={() => { setAiTurnEdit({ idx: aiTurnMenu, text: turn.text }); setAiTurnMenu(null); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-white active:bg-white/5 transition flex items-center gap-3"><PencilSimple size={17} /> 编辑</button>
                                <button onClick={() => { const idx = aiTurnMenu; setAiTurnMenu(null); askConfirm({ title: '删除这条内容？', desc: '只删这一条对话/楼层，无法撤销。', confirmLabel: '删除', danger: true, onConfirm: () => handleDeleteAiTurn(idx) }); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-rose-400 active:bg-white/5 transition flex items-center gap-3 border-t border-white/10"><Trash size={17} /> 删除</button>
                            </div>
                            <button onClick={() => setAiTurnMenu(null)} className="w-full rounded-2xl bg-[#1c1d22] border border-white/10 py-3.5 text-[14px] font-semibold text-white/80">取消</button>
                        </div>
                    </div>
                );
            })()}

            {/* 智能体 · 会话内单条内容 编辑弹窗 */}
            <Modal isOpen={!!aiTurnEdit} title="编辑这条内容" onClose={() => setAiTurnEdit(null)}
                footer={<button onClick={handleSaveAiTurn} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">保存</button>}>
                {aiTurnEdit && (
                    <textarea value={aiTurnEdit.text} onChange={e => setAiTurnEdit({ ...aiTurnEdit, text: e.target.value })}
                        className="w-full h-48 bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm resize-none leading-relaxed" />
                )}
            </Modal>

            {/* 智能体 · 编辑弹窗 */}
            <Modal isOpen={!!aiEdit} title={aiEdit?.kind === 'session' ? '编辑会话' : aiEdit?.id === '__new__' ? '新建角色卡' : '编辑角色卡'} onClose={() => setAiEdit(null)}
                footer={<button onClick={handleSaveAiEdit} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">{aiEdit?.id === '__new__' ? '创建' : '保存'}</button>}>
                {aiEdit && (aiEdit.kind === 'session' ? (
                    <div className="space-y-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase block">标题</label>
                        <input value={aiEdit.title || ''} onChange={e => setAiEdit({ ...aiEdit, title: e.target.value })} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                    </div>
                ) : (
                    <div className="space-y-3">
                        {aiEdit.id === '__new__' && (
                            <div className="flex gap-2">
                                {(['character', 'world'] as const).map(k => (
                                    <button key={k} onClick={() => setAiEdit({ ...aiEdit, cardKind: k })}
                                        className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition ${(aiEdit.cardKind || 'character') === k ? 'bg-violet-500 text-white border-violet-500' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                                        {k === 'character' ? '角色卡' : '世界卡'}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-2">
                            <input value={aiEdit.emoji || ''} onChange={e => setAiEdit({ ...aiEdit, emoji: e.target.value })} placeholder="🎭" className="w-16 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-center" />
                            <input value={aiEdit.name || ''} onChange={e => setAiEdit({ ...aiEdit, name: e.target.value })} placeholder="卡片名" className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">人设 / 设定</label>
                            <textarea value={aiEdit.persona || ''} onChange={e => setAiEdit({ ...aiEdit, persona: e.target.value })} className="w-full h-20 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">场景</label>
                            <textarea value={aiEdit.scenario || ''} onChange={e => setAiEdit({ ...aiEdit, scenario: e.target.value })} className="w-full h-16 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none" />
                        </div>
                    </div>
                ))}
            </Modal>

            {/* 智能体 · 角色卡详情（看 TA 用这张玩过哪些 + 用这张卡开一局） */}
            {aiCardView && (() => {
                const c = aiCards.find(x => x.id === aiCardView);
                if (!c) return null;
                const plays = aiSessions.filter(s => s.service === 'tavern' && s.cardId === c.id).sort((a, b) => b.updatedAt - a.updatedAt);
                return (
                    <Modal isOpen={true} title={c.kind === 'world' ? '世界卡' : '角色卡'} onClose={() => setAiCardView(null)}
                        footer={<button onClick={() => handlePlayCard(c)} disabled={isLoading}
                            className="w-full py-3 bg-rose-500 text-white font-bold rounded-2xl disabled:opacity-50">{isLoading ? '生成中…' : '用这张卡开一局'}</button>}>
                        <div className="space-y-3">
                            <div className="flex items-start gap-3">
                                <div className="text-3xl shrink-0">{c.emoji}</div>
                                <div className="min-w-0">
                                    <div className="text-base font-bold text-slate-800 flex items-center gap-2 flex-wrap">{c.name}
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-500">{c.kind === 'world' ? '世界卡' : '角色卡'}</span>
                                    </div>
                                    {(c.basedOnUser || c.basedOn) && <div className="text-[11px] text-rose-400 mt-0.5">⚑ 照着{c.basedOnUser ? '你' : `「${c.basedOn}」`}捏的</div>}
                                </div>
                            </div>
                            {c.persona && <div className="text-[12px] text-slate-600 leading-relaxed bg-slate-50 rounded-xl p-3 whitespace-pre-wrap">{c.persona}</div>}
                            {c.scenario && <div className="text-[12px] text-slate-500 leading-relaxed bg-slate-50 rounded-xl p-3 italic whitespace-pre-wrap">场景：{c.scenario}</div>}
                            <div>
                                <div className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">TA 用这张卡玩过 · {plays.length}</div>
                                {plays.length === 0 && <div className="text-[12px] text-slate-400">还没有对戏记录——点下面「用这张卡开一局」让 TA 玩起来。</div>}
                                <div className="space-y-1.5 max-h-48 overflow-y-auto no-scrollbar">
                                    {plays.map(s => (
                                        <button key={s.id} onClick={() => { setAiCardView(null); setSelectedAiSessionId(s.id); setActiveAppId('ai_session'); }}
                                            className="w-full text-left rounded-xl p-2.5 bg-slate-50 active:bg-slate-100 transition">
                                            <div className="text-[13px] font-semibold text-slate-700 truncate">{s.title}</div>
                                            <div className="text-[10px] text-slate-400">{parseTranscript(s.transcript).length} 条 · {fmtClock(s.updatedAt)}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </Modal>
                );
            })()}

            {/* Create App Modal */}
            <Modal isOpen={showCreateModal} title={editingAppId ? '编辑自定义 App' : '安装自定义 App'} onClose={() => setShowCreateModal(false)}
                footer={<button onClick={handleCreateCustomApp} disabled={!newAppName.trim() || !newAppPrompt.trim()} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl disabled:opacity-40">{editingAppId ? '保存修改' : '安装到桌面'}</button>}>
                <div className="space-y-4">
                    <div className="flex gap-4">
                        <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl shadow-md border border-white/10 shrink-0"
                            style={{ background: `linear-gradient(135deg, ${newAppColor}55, ${newAppColor}15)` }}>
                            {newAppIcon}
                        </div>
                        <div className="flex-1 space-y-2">
                            <input value={newAppName} onChange={e => setNewAppName(e.target.value)} placeholder="App 名称 (如: 银行)" className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                            <div className="flex gap-2">
                                <input value={newAppIcon} onChange={e => setNewAppIcon(e.target.value)} placeholder="Emoji" className="w-16 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-center" />
                                <input type="color" value={newAppColor} onChange={e => setNewAppColor(e.target.value)} className="h-9 flex-1 cursor-pointer rounded-lg bg-transparent" />
                            </div>
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">功能指令 (AI Prompt)</label>
                        <textarea
                            value={newAppPrompt}
                            onChange={e => setNewAppPrompt(e.target.value)}
                            placeholder="例如: 显示该用户的存款余额、近期的转账记录以及理财收益。"
                            className="w-full h-24 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none"
                        />
                        <p className="text-[9px] text-slate-400 mt-1">AI 将根据此指令生成该 App 内部的数据。</p>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-2">界面样板 (UI Style)</label>
                        <div className="grid grid-cols-2 gap-2">
                            {APP_LAYOUTS.map(l => {
                                const active = newAppLayout === l.id;
                                return (
                                    <button key={l.id} type="button" onClick={() => setNewAppLayout(l.id)}
                                        className={`text-left rounded-xl p-2.5 border transition flex items-center gap-2.5 ${active ? 'border-transparent text-white' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
                                        style={active ? { background: newAppColor } : undefined}>
                                        <span className="text-lg leading-none shrink-0">{l.icon}</span>
                                        <div className="min-w-0">
                                            <div className="text-[12px] font-bold leading-tight">{l.name}</div>
                                            <div className={`text-[9px] leading-tight truncate ${active ? 'text-white/80' : 'text-slate-400'}`}>{l.desc}</div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </Modal>

            {/* 新建联系人 / 智能体 Modal */}
            <Modal isOpen={showContactModal} title="添加联系人" onClose={() => setShowContactModal(false)}
                footer={<button onClick={handleCreateContact} className="w-full py-3 bg-pink-500 text-white font-bold rounded-2xl">添加</button>}>
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-2">类型</label>
                        <div className="grid grid-cols-2 gap-2">
                            {([
                                { id: 'npc', name: 'NPC', desc: '虚构路人' },
                                { id: 'real', name: '真人', desc: '绑定神经链接角色' },
                            ] as const).map(opt => {
                                const active = ncKind === opt.id;
                                return (
                                    <button key={opt.id} type="button" onClick={() => setNcKind(opt.id)}
                                        className={`text-left rounded-xl p-2.5 border transition ${active ? 'border-transparent bg-pink-500 text-white' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                                        <div className="text-[12px] font-bold leading-tight">{opt.name}</div>
                                        <div className={`text-[9px] leading-tight ${active ? 'text-white/80' : 'text-slate-400'}`}>{opt.desc}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {ncKind === 'real' ? (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">绑定真实角色</label>
                            <select value={ncLinkedId} onChange={e => setNcLinkedId(e.target.value)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm">
                                <option value="">— 选择一个角色 —</option>
                                {characters.filter(c => c.id !== targetChar?.id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            <p className="text-[9px] text-slate-400 mt-1">真人之间可发起双向对话，对话会同步进对方的手机。</p>
                        </div>
                    ) : (
                        <input value={ncName} onChange={e => setNcName(e.target.value)} placeholder="联系人名字（虚构）" className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                    )}
                </div>
            </Modal>

            {/* 改绑定 Modal：把联系人改绑到正确的真实角色 / 转为虚构（保留对话+备注+了解+好感） */}
            <Modal isOpen={showRebindModal} title="改绑定" onClose={() => setShowRebindModal(false)}>
                {selectedContact && (
                    <div className="space-y-3">
                        <p className="text-[11.5px] text-slate-500 leading-relaxed">
                            甄别/绑定错了在这改。会保留这段对话、备注、了解和好感；改成真人会把对话同步进对方手机，原来错绑的角色那边会清掉。
                        </p>
                        {/* 转为虚构 */}
                        <button
                            onClick={() => handleRebindContact(selectedContact, { kind: 'npc' })}
                            disabled={selectedContact.kind === 'npc'}
                            className={`w-full flex items-center gap-2.5 rounded-xl p-3 border text-left transition ${selectedContact.kind === 'npc' ? 'border-slate-200 bg-slate-100 opacity-50' : 'border-slate-200 bg-slate-50 active:scale-[0.99]'}`}>
                            <span className="w-8 h-8 rounded-lg bg-slate-200 flex items-center justify-center text-slate-500 shrink-0"><User size={16} weight="bold" /></span>
                            <div className="min-w-0">
                                <div className="text-[13px] font-bold text-slate-700">转为虚构联系人</div>
                                <div className="text-[10px] text-slate-400">不绑定真实角色 · 当成 NPC{selectedContact.kind === 'npc' ? '（当前就是）' : ''}</div>
                            </div>
                        </button>
                        {/* 绑定到真实角色 */}
                        <div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">绑定到真实角色</div>
                            <div className="max-h-64 overflow-y-auto space-y-1.5 no-scrollbar">
                                {characters.filter(c => c.id !== targetChar?.id).length === 0 && (
                                    <p className="text-[11px] text-slate-400 px-1 py-2">神经链接里没有其它角色可绑。</p>
                                )}
                                {characters.filter(c => c.id !== targetChar?.id).map(rc => {
                                    const current = selectedContact.kind === 'real' && selectedContact.linkedCharId === rc.id;
                                    return (
                                        <button key={rc.id}
                                            onClick={() => handleRebindContact(selectedContact, { kind: 'real', charId: rc.id })}
                                            disabled={current}
                                            className={`w-full flex items-center gap-2.5 rounded-xl p-2.5 border text-left transition ${current ? 'border-pink-300 bg-pink-50' : 'border-slate-200 bg-slate-50 active:scale-[0.99]'}`}>
                                            <TokenImg value={rc.avatar} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
                                            <span className="text-[13px] font-semibold text-slate-700 flex-1 truncate">{rc.name}</span>
                                            {current && <span className="text-[10px] font-bold text-pink-500 shrink-0">当前绑定</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </Modal>

            {/* 话题盒记忆 · 编辑/删除（长按某条记忆打开） */}
            <Modal isOpen={!!topicEdit} title="聊天记忆" onClose={() => setTopicEdit(null)}
                footer={topicEdit ? (
                    <div className="flex gap-2">
                        <button onClick={() => {
                            const { contactId, topicId } = topicEdit;
                            mutateContacts(cs => cs.map(c => c.id === contactId ? { ...c, topicBox: (c.topicBox || []).filter(t => t.id !== topicId) } : c));
                            setTopicEdit(null);
                            addToast('已删除该条记忆', 'success');
                        }} className="px-4 py-3 bg-rose-500 text-white font-bold rounded-2xl">删除</button>
                        <button onClick={() => {
                            const { contactId, topicId, text } = topicEdit;
                            mutateContacts(cs => cs.map(c => c.id === contactId ? { ...c, topicBox: (c.topicBox || []).map(t => t.id === topicId ? { ...t, text: text.trim() } : t) } : c));
                            setTopicEdit(null);
                            addToast('已保存', 'success');
                        }} className="flex-1 py-3 bg-pink-500 text-white font-bold rounded-2xl">保存</button>
                    </div>
                ) : undefined}>
                {topicEdit && (
                    <div className="space-y-2">
                        <p className="text-[11px] text-slate-400">这是角色第一人称、带主观色彩的一段聊天记忆（用作上下文）。可改写或删除。</p>
                        <textarea value={topicEdit.text} onChange={e => setTopicEdit({ ...topicEdit, text: e.target.value })}
                            className="w-full h-32 bg-slate-50 border border-slate-200 rounded-xl p-3 text-[13px] resize-none" />
                    </div>
                )}
            </Modal>

            {/* 通用二次确认弹窗：删除 / 移除 / 拉黑 / 清空都走这里 */}
            <Modal
                isOpen={!!confirmState}
                title={confirmState?.title || ''}
                onClose={() => setConfirmState(null)}
                footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setConfirmState(null)}
                            className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                        <button onClick={() => { const cb = confirmState?.onConfirm; setConfirmState(null); cb?.(); }}
                            className={`flex-1 py-3 font-bold rounded-2xl text-white active:scale-95 transition-transform ${confirmState?.danger ? 'bg-rose-500' : 'bg-pink-500'}`}>
                            {confirmState?.confirmLabel || '确定'}
                        </button>
                    </div>
                }>
                <p className="text-[13px] text-slate-500 leading-relaxed text-center">{confirmState?.desc || '此操作无法撤销。'}</p>
            </Modal>
        </div>
    );
};

export default CheckPhone;
import { useAppShortcut } from '../utils/appShortcutLaunch';
import { AppID as ShortcutAppID } from '../types';

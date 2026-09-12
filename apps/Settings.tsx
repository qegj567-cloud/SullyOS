
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { Capacitor } from '@capacitor/core';
import { extractContent, safeResponseJson } from '../utils/safeApi';
import { extractModelIds, normalizeModelIds } from '../utils/modelList';
import { shareOrDownloadBlob } from '../utils/shareExport';
import { bucketRetryCount, isAnalyticsConfigured, isAnalyticsEnabled, setAnalyticsEnabled, trackEvent } from '../utils/analytics';
import Modal from '../components/os/Modal';
import { NotionManager, FeishuManager, RealtimeContextManager, fetchOwmWeather, fetchOpenMeteoWeather } from '../utils/realtimeContext';
import { XhsMcpClient } from '../utils/xhsMcpClient';
import { resolveXhsDeploymentMode } from '../utils/xhsMcpConfig';
import { getMcdToken, setMcdToken as saveMcdToken, isMcdEnabled, setMcdEnabled as saveMcdEnabled, testMcdConnection, resetMcdSession } from '../utils/mcdMcpClient';
import { getLuckinToken, setLuckinToken as saveLuckinToken, isLuckinEnabled, setLuckinEnabled as saveLuckinEnabled, testLuckinConnection, resetLuckinSession } from '../utils/luckinMcpClient';
import { consumeProxyWorkerSettingsFocus, getProxyWorkerUrl, setProxyWorkerUrl, DEFAULT_PROXY_WORKER } from '../utils/proxyWorker';
import { VOICE_ACTING_GUIDE } from '../utils/minimaxTts';
import { FISH_VOICE_ACTING_GUIDE } from '../utils/fishAudioTts';
import {
    DEFAULT_ELEVENLABS_MODEL,
    ELEVENLABS_MODEL_OPTIONS,
    getElevenLabsVoiceActingGuide,
} from '../utils/elevenLabsTts';
import { DATE_VOICE_GUIDE } from '../utils/datePrompts';
import { Sun, Newspaper, NotePencil, Notebook, Book, ForkKnife, Coffee, PlugsConnected } from '@phosphor-icons/react';
import { loadMcpServers, saveMcpServers, createMcpServer, testMcpConnection, resetMcpSession, getMcpUseNativeTools, setMcpUseNativeTools, type McpServerConfig } from '../utils/mcpClient';
import { loadPushConfig, savePushConfig, registerScheduleOnWorker, startHeartbeat, stopHeartbeat, isPushConfigAvailable, ensureSubscribed, sendTestPush, getPushDiagnostics, resetSubscription, deepResetSubscription, type PushDiagnostics } from '../utils/proactivePushConfig';
import { ProactiveChat } from '../utils/proactiveChat';
import { InstantPushSettingsModal } from '../components/settings/InstantPushSettingsModal';
import { PushVapidSettingsModal } from '../components/settings/PushVapidSettingsModal';
import PushSubscriptionPanel from '../components/settings/PushSubscriptionPanel';
import ActiveMsgGlobalSettingsModal from '../components/settings/ActiveMsgGlobalSettingsModal';
import { syncAmsgLlmCredentials, syncAmsgToolConfig, syncAmsgToolConfigAndPrompts } from '../utils/amsgStateSync';
import { ActiveMsgClient } from '../utils/activeMsgClient';
import VersionInfo from '../components/settings/VersionInfo';
import { isPushVapidReady } from '../utils/pushVapid';
import ApiCallLogModal from '../components/settings/ApiCallLogModal';
import StorageUsagePanel from '../components/settings/StorageUsagePanel';
import McpConnectionConsole from '../components/settings/McpConnectionConsole';
import { DB } from '../utils/db';
import { getBackupReminderState, setBackupReminderIntervalDays, daysSinceLastBackup, BACKUP_REMINDER_MIN_DAYS, BACKUP_REMINDER_MAX_DAYS } from '../utils/backupReminder';
import {
    createAvatarModelBackup,
    getAvatarModelBackupInventory,
    restoreAvatarModelBackup,
    type AvatarModelBackupInventory,
    type AvatarModelBackupProgress,
} from '../utils/avatarModelBackup';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../utils/apiConfigNormalize';
import { configFromPreset, findActivePresetId, type PresetSwitchPatch } from '../utils/apiPresetSwitch';
import type { APIConfig, TtsProvider } from '../types';
import { describeImageWithVisionApi, VISION_API_TEST_IMAGE_DATA_URL, visionApiConfigFromPreset } from '../utils/visionApi';
import {
    FIRECRAWL_API_KEYS_URL,
    getFirecrawlApiKey,
    getFirecrawlCreditUsage,
    setFirecrawlApiKey,
    type FirecrawlCreditUsage,
} from '../utils/firecrawl';

// hot_news（news.orz.ai）可选热榜平台。key 必须与 API 的 ?platform= 完全一致。
const HOTNEWS_PLATFORM_OPTIONS: { key: string; label: string }[] = [
    { key: 'weibo', label: '微博' },
    { key: 'zhihu', label: '知乎' },
    { key: 'baidu', label: '百度' },
    { key: 'bilibili', label: 'B站' },
    { key: 'douyin', label: '抖音' },
    { key: 'jinritoutiao', label: '今日头条' },
    { key: 'tieba', label: '贴吧' },
    { key: 'hupu', label: '虎扑' },
    { key: 'douban', label: '豆瓣' },
    { key: 'tskr', label: '36氪' },
    { key: 'juejin', label: '掘金' },
    { key: 'sspai', label: '少数派' },
    { key: 'vtex', label: 'V2EX' },
    { key: 'github', label: 'GitHub' },
    { key: 'hackernews', label: 'Hacker News' },
    { key: 'sina_finance', label: '新浪财经' },
    { key: 'eastmoney', label: '东方财富' },
    { key: 'xueqiu', label: '雪球' },
    { key: 'cls', label: '财联社' },
    { key: 'tenxunwang', label: '腾讯网' },
];

// 「主动消息 Push 加速」面板入口开关。底层逻辑（心跳、订阅、诊断）全部保留，
// 这里设为 false 只是把设置页里的入口隐藏掉，想恢复改回 true 即可。
const SHOW_PROACTIVE_PUSH_ACCEL_UI = false;
// Firecrawl「方舟计划」：实现、额度检测和抓取降级链全部保留，默认不向用户展示配置入口。
// 需要重新启用时只改为 true。
const SHOW_FIRECRAWL_ARK_UI = false;
const VISION_MODEL_LIST_STORAGE_KEY = 'os_vision_available_models';

const readStoredVisionModels = (): string[] => {
    try {
        return normalizeModelIds(JSON.parse(localStorage.getItem(VISION_MODEL_LIST_STORAGE_KEY) || '[]'));
    } catch {
        return [];
    }
};

const buildModelPickerView = (models: unknown[], filter: string) => {
    const q = filter.trim().toLowerCase();
    const safeModels = normalizeModelIds(models);
    const filtered = q ? safeModels.filter(model => model.toLowerCase().includes(q)) : safeModels;
    let commonPrefix = '';
    if (filtered.length >= 2) {
        let prefix = filtered[0];
        for (let index = 1; index < filtered.length; index += 1) {
            const candidate = filtered[index];
            let cursor = 0;
            while (cursor < prefix.length && cursor < candidate.length && prefix[cursor] === candidate[cursor]) cursor += 1;
            prefix = prefix.slice(0, cursor);
            if (!prefix) break;
        }
        const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('-'));
        if (cut > 3) prefix = prefix.slice(0, cut + 1);
        if (prefix.length >= 4) commonPrefix = prefix;
    }
    return { filtered, commonPrefix };
};

const DiagRow: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
    <div className="flex items-start justify-between gap-3">
        <span className="text-slate-500 shrink-0">{label}</span>
        <span className={`text-right ${bad ? 'text-rose-600 font-medium' : 'text-slate-700'}`}>{value}</span>
    </div>
);

// 用户版 MCP 教程（自包含，写给用户和他们的 AI 助手看的）。静态部署的站点
// 看不到仓库内文档，所以帮助弹窗只能跳 GitHub 的 blob 页。
const MCP_USER_GUIDE_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/docs/mcp-user-guide.md';
const PROXY_WORKER_SOURCE_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/worker/index.js';

const formatBackupBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
};

/**
 * 设置大板块的折叠外壳：默认收起，标题行常显、点击开合；
 * actions 放右侧动作（配置按钮 / 状态 chip / 问号），点击不触发开合。
 */
const SettingsSection: React.FC<{
    icon: React.ReactNode;
    title: string;
    badge?: React.ReactNode;
    actions?: React.ReactNode;
    sectionProps?: Record<string, any>;
    children: React.ReactNode;
}> = ({ icon, title, badge, actions, sectionProps, children }) => {
    const [open, setOpen] = useState(false);
    return (
        <section {...sectionProps} className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
            <div className={`flex items-center justify-between gap-2 ${open ? 'mb-4' : ''}`}>
                <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                    {icon}
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">{title}</h2>
                    {badge}
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>
                {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
            </div>
            {open && children}
        </section>
    );
};

let mcpToolConfigSyncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMcpToolConfigSync: (() => void) | null = null;

const runMcpToolConfigSync = () => {
    const sync = pendingMcpToolConfigSync;
    mcpToolConfigSyncTimer = null;
    pendingMcpToolConfigSync = null;
    // 上传本身的失败重试与底账在 syncAmsgToolConfig 里（见 amsgStateSync），这儿只管节流。
    sync?.();
};

/**
 * MCP 卡片没有「保存」按钮，改一个字就落盘一次；直接每次都上云就变成一次按键一个请求。
 * 攒到停手 800ms 再传一次，中途继续改就顺延。
 */
const scheduleMcpToolConfigSync = (sync: () => void) => {
    pendingMcpToolConfigSync = sync;
    if (mcpToolConfigSyncTimer) clearTimeout(mcpToolConfigSyncTimer);
    mcpToolConfigSyncTimer = setTimeout(runMcpToolConfigSync, 800);
};

/** 关掉 MCP 设置就别让那 800ms 继续吊着了，攒着的改动当场传上去。 */
const flushMcpToolConfigSync = () => {
    if (!mcpToolConfigSyncTimer) return;
    clearTimeout(mcpToolConfigSyncTimer);
    runMcpToolConfigSync();
};

/**
 * 旧版通用 MCP 管理卡片。保留一小段迁移期，实际入口已切到新版 MCP 管理面板。
 * 配置存 localStorage（utils/mcpClient），启用且发现过工具的服务器会在聊天里
 * 以 function-calling 注入，详见 docs/mcp-client.md。
 */
const McpServersCard: React.FC<{
    addToast: (msg: string, type?: any) => void;
    /** 服务器清单或「原生 tools」开关变了 → 让主动消息那边把新配置重传上云 */
    onMcpConfigChanged?: () => void;
}> = ({ addToast, onMcpConfigChanged }) => {
    const { characters, groups } = useOS();
    const [servers, setServers] = useState<McpServerConfig[]>(() => loadMcpServers());
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [testStatus, setTestStatus] = useState<Record<string, string>>({});
    const [useNativeTools, setUseNativeToolsState] = useState<boolean>(() => getMcpUseNativeTools());

    const persist = (next: McpServerConfig[]) => {
        setServers(next);
        saveMcpServers(next);
        onMcpConfigChanged?.();
    };

    const update = (id: string, patch: Partial<McpServerConfig>) => {
        persist(servers.map(s => s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s));
        // URL / 鉴权头 / 代理变了，旧 session 不能再用
        if (patch.url !== undefined || patch.token !== undefined || patch.customHeaders !== undefined || patch.proxyUrl !== undefined || patch.proxyKey !== undefined) {
            resetMcpSession(id);
        }
    };

    const addServer = () => {
        const s = createMcpServer(`MCP 服务器 ${servers.length + 1}`, '');
        persist([...servers, s]);
        setExpandedId(s.id);
    };

    const removeServer = (id: string) => {
        resetMcpSession(id);
        persist(servers.filter(s => s.id !== id));
    };

    const discover = async (server: McpServerConfig) => {
        if (!server.url.trim()) { addToast('请先填写服务器 URL', 'error'); return; }
        setTestingId(server.id);
        setTestStatus(prev => ({ ...prev, [server.id]: '' }));
        try {
            const r = await testMcpConnection(server);
            setTestStatus(prev => ({ ...prev, [server.id]: r.ok ? `✅ ${r.message}` : `❌ ${r.message}` }));
            // 失败原因只上报归类后的固定枚举：原始报错里可能带服务器地址和返回内容，不能外发
            if (r.ok) {
                trackEvent('测试 MCP 服务器连接', { result: r.tools?.length ? 'connected' : 'connected-no-tools' });
            } else {
                const msg = r.message || '';
                const failureKind =
                    /超时/.test(msg) ? 'timeout'
                    : /鉴权失败/.test(msg) ? 'auth-failed'
                    : /请求失败/.test(msg) ? 'fetch-failed'
                    : /MCP HTTP/.test(msg) ? 'http-error'
                    : 'other';
                trackEvent('测试 MCP 服务器连接', { result: 'failed', failureKind });
            }
            if (r.ok && r.tools) {
                update(server.id, { tools: r.tools });
            }
        } finally {
            setTestingId(null);
        }
    };

    return (
        <div className="bg-violet-50/60 p-4 rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <PlugsConnected size={20} weight="fill" className="text-violet-600" />
                    <span className="text-sm font-bold text-violet-700">MCP 工具服务器</span>
                    <span className="text-[9px] bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full">通用</span>
                </div>
                <button onClick={addServer} className="text-[11px] font-bold text-violet-600 bg-violet-100 px-2.5 py-1 rounded-lg active:scale-95 transition-transform">+ 添加</button>
            </div>
            <p className="text-[10px] text-violet-700/70 leading-relaxed">
                接入任意标准 MCP 服务器（Streamable HTTP）：填 URL → 测试连接 → 打开开关，角色就能在聊天里调用这些工具。
                被浏览器 CORS 拦住时配「代理 URL」：本地跑 <code className="bg-violet-100/80 px-1 rounded">node scripts/mcp-proxy.mjs</code>，或把 <code className="bg-violet-100/80 px-1 rounded">worker/mcp-proxy</code> 部署到你自己的 Cloudflare 账号。配置只存本机，详见 docs/mcp-client.md。
            </p>
            <div className="flex items-center justify-between gap-3 bg-white/70 border border-violet-100 rounded-xl px-3 py-2.5">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <div className="text-xs font-bold text-slate-700">原生 tools 工具调用</div>
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[8px] font-bold text-emerald-700">推荐</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                        开启后发送标准 tools，调用更稳定、参数更可靠。只有模型或中转明确不支持 function calling 时才关闭，退回文字兼容模式。
                    </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                    <input type="checkbox" checked={useNativeTools} onChange={e => {
                        const next = e.target.checked;
                        setUseNativeToolsState(next);
                        setMcpUseNativeTools(next);
                        onMcpConfigChanged?.();
                        trackEvent('切换原生工具调用', { state: next ? 'on' : 'off' });
                    }} className="sr-only peer" />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500"></div>
                </label>
            </div>
            <div className="border-l-2 border-violet-300 pl-3 text-[10px] leading-relaxed text-violet-700/80">
                <p>
                    <b>简单说：</b>tools / function calling 是聊天模型的一项能力，让角色用标准格式告诉 API“要调用哪个工具、传什么参数”，系统才能真正执行；不支持时，模型可能只会把工具调用写成普通聊天文字。
                </p>
                <p className="mt-1.5 text-violet-600/75">
                    不知道自己的模型或中转是否支持？请询问你所使用的 API 负责人或售卖方，确认是否支持 <b>tools / function calling（函数调用）</b>。拿不准时保持开启；只有对方明确说不支持，或请求出现 tools / function calling 报错时再关闭。
                </p>
            </div>
            {servers.map(server => (
                <div key={server.id} className="bg-white/70 border border-violet-100 rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <button className="flex-1 text-left min-w-0" onClick={() => setExpandedId(expandedId === server.id ? null : server.id)}>
                            <div className="text-xs font-bold text-slate-700 truncate">{server.name || '(未命名)'}</div>
                            <div className="text-[10px] text-slate-400 truncate">
                                {server.url || '未填 URL'}{server.tools?.length ? ` · ${server.tools.length} 个工具` : ' · 未获取工具'}{server.charIds?.length ? ` · 绑定 ${server.charIds.length} 个聊天` : ''}
                            </div>
                        </button>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                            <input type="checkbox" checked={server.enabled} onChange={e => {
                                if (e.target.checked && !(server.tools?.length)) {
                                    addToast('先点「测试连接」拿到工具清单再启用', 'error');
                                    trackEvent('启用未测通的 MCP 服务器被拦下');
                                    return;
                                }
                                update(server.id, { enabled: e.target.checked });
                            }} className="sr-only peer" />
                            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500"></div>
                        </label>
                    </div>
                    {expandedId === server.id && (
                        <div className="space-y-2 pt-1">
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">名称</label>
                                <input type="text" value={server.name} onChange={e => update(server.id, { name: e.target.value })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm" placeholder="例如：Notion" />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">服务器 URL</label>
                                <input type="text" value={server.url} onChange={e => update(server.id, { url: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="https://mcp.example.com/mcp" />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Bearer Token（可选）</label>
                                <input type="password" value={server.token || ''} onChange={e => update(server.id, { token: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="服务器要求鉴权时填" />
                            </div>
                            <div>
                                <div className="flex items-center justify-between gap-2 mb-1">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">自定义请求头（可选）</label>
                                    <button
                                        type="button"
                                        onClick={() => update(server.id, { customHeaders: [...(server.customHeaders || []), { name: '', value: '' }] })}
                                        className="text-[10px] font-bold text-violet-600"
                                    >+ 添加请求头</button>
                                </div>
                                {(server.customHeaders || []).map((header, index) => (
                                    <div key={index} className="flex gap-1.5 mb-1.5">
                                        <input
                                            type="text"
                                            value={header.name}
                                            onChange={e => update(server.id, { customHeaders: (server.customHeaders || []).map((item, i) => i === index ? { ...item, name: e.target.value } : item) })}
                                            className="min-w-0 flex-[0.9] bg-white/80 border border-violet-200 rounded-xl px-2.5 py-2 text-xs font-mono"
                                            placeholder="XBY-APIKEY"
                                            aria-label={`自定义请求头 ${index + 1} 名称`}
                                        />
                                        <input
                                            type="password"
                                            value={header.value}
                                            onChange={e => update(server.id, { customHeaders: (server.customHeaders || []).map((item, i) => i === index ? { ...item, value: e.target.value } : item) })}
                                            className="min-w-0 flex-1 bg-white/80 border border-violet-200 rounded-xl px-2.5 py-2 text-xs font-mono"
                                            placeholder="请求头的值"
                                            aria-label={`自定义请求头 ${index + 1} 值`}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => update(server.id, { customHeaders: (server.customHeaders || []).filter((_, i) => i !== index) })}
                                            className="w-9 shrink-0 rounded-xl bg-red-50 text-red-500 text-base"
                                            aria-label={`删除自定义请求头 ${index + 1}`}
                                        >×</button>
                                    </div>
                                ))}
                                <p className="text-[10px] text-slate-400 leading-relaxed">
                                    用于 X-API-Key、XBY-APIKEY 等非 Bearer 鉴权；名称或值留空的行不会发送。
                                </p>
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">代理 URL（可选，留空 = 直连）</label>
                                <input type="text" value={server.proxyUrl || ''} onChange={e => update(server.id, { proxyUrl: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="http://localhost:18061 或你的 Worker 地址" />
                            </div>
                            {(server.proxyUrl || '').trim() && (
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">代理密钥（可选，自部署 Worker 的 PROXY_KEY）</label>
                                    <input type="password" value={server.proxyKey || ''} onChange={e => update(server.id, { proxyKey: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="没设就留空" />
                                </div>
                            )}
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">可用聊天</label>
                                <div className="flex flex-wrap gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => update(server.id, { charIds: [] })}
                                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${!server.charIds?.length ? 'bg-violet-500 text-white' : 'bg-white/80 border border-violet-200 text-slate-500'}`}
                                    >通用（所有私聊和群聊）</button>
                                </div>
                                {characters.length > 0 && <div className="text-[10px] text-slate-400 mt-2 mb-1">角色</div>}
                                <div className="flex flex-wrap gap-1.5">
                                    {characters.map(c => {
                                        const bound = !!server.charIds?.includes(c.id);
                                        return (
                                            <button
                                                key={c.id}
                                                type="button"
                                                onClick={() => {
                                                    const cur = server.charIds || [];
                                                    update(server.id, { charIds: bound ? cur.filter(id => id !== c.id) : [...cur, c.id] });
                                                }}
                                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${bound ? 'bg-violet-500 text-white' : 'bg-white/80 border border-violet-200 text-slate-500'}`}
                                            >{c.name}</button>
                                        );
                                    })}
                                </div>
                                {groups.length > 0 && <div className="text-[10px] text-slate-400 mt-2 mb-1">群聊</div>}
                                <div className="flex flex-wrap gap-1.5">
                                    {groups.map(group => {
                                        const bound = !!server.charIds?.includes(group.id);
                                        return (
                                            <button
                                                key={group.id}
                                                type="button"
                                                onClick={() => {
                                                    const cur = server.charIds || [];
                                                    update(server.id, { charIds: bound ? cur.filter(id => id !== group.id) : [...cur, group.id] });
                                                }}
                                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${bound ? 'bg-violet-500 text-white' : 'bg-white/80 border border-violet-200 text-slate-500'}`}
                                            >{group.name}</button>
                                        );
                                    })}
                                </div>
                                <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                    通用 = 所有私聊和群聊都能用；绑定后只有选中的角色或群聊能看到这批工具。
                                </p>
                                {!!server.charIds?.length && server.charIds.some(id => !characters.some(c => c.id === id) && !groups.some(g => g.id === id)) && (
                                    <p className="text-[10px] text-amber-600 mt-1">
                                        ⚠️ 绑定里有已删除的角色或群聊，对应绑定不再生效，可重新点选清理。
                                    </p>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => discover(server)} disabled={testingId === server.id} className="flex-1 py-2 bg-violet-100 text-violet-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                                    {testingId === server.id ? '测试中…' : '测试连接'}
                                </button>
                                <button onClick={() => removeServer(server.id)} className="px-4 py-2 bg-red-50 text-red-500 text-xs font-bold rounded-xl active:scale-95 transition-transform">删除</button>
                            </div>
                            {testStatus[server.id] && (
                                <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${testStatus[server.id].startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                                    {testStatus[server.id]}
                                </div>
                            )}
                            {!!server.tools?.length && (
                                <p className="text-[10px] text-slate-400 leading-relaxed">
                                    工具：{server.tools.map(t => t.name).join('、')}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            ))}
            <p className="text-[10px] text-violet-700/60 leading-relaxed bg-violet-100/40 rounded-lg px-2 py-1.5">
                开启 MCP 工具后，聊天会改用本地工具请求（跳过 Instant Push），本轮思考链会让位给工具调用；发布、下单、删除等操作仍会先征得你的确认。Token、自定义请求头与配置保存在本机；若配置了代理，请求会按你的设置经该代理转发。
            </p>
        </div>
    );
};

const Settings: React.FC = () => {
  const {
      apiConfig, updateApiConfig, closeApp, availableModels, setAvailableModels,
      theme, updateTheme, resetAppearance,
      exportSystem, importSystem, addToast, showError, resetSystem, updateCharacter,
      apiPresets, addApiPreset, updateApiPreset, removeApiPreset,
      sysOperation, // Get progress state
      realtimeConfig, updateRealtimeConfig, // 实时感知配置
      // 改工具凭据时要连云端提示词一起刷（见 syncAmsgToolConfigAndPrompts）
      characters, groups, userProfile,
      cloudBackupConfig, updateCloudBackupConfig,
      cloudBackupToWebDAV, cloudRestoreFromWebDAV, listCloudBackups,
  } = useOS();
  
  const [localKey, setLocalKey] = useState(apiConfig.apiKey);
  const [localUrl, setLocalUrl] = useState(apiConfig.baseUrl);
  const [localModel, setLocalModel] = useState(String(apiConfig.model || ''));
  const [localStream, setLocalStream] = useState<boolean>(apiConfig.stream === true);
  const [localTemperature, setLocalTemperature] = useState<number>(
    typeof apiConfig.temperature === 'number' ? apiConfig.temperature : 0.85
  );
  const [localVisionEnabled, setLocalVisionEnabled] = useState(apiConfig.visionApi?.enabled === true);
  const [localVisionUrl, setLocalVisionUrl] = useState(apiConfig.visionApi?.baseUrl || '');
  const [localVisionKey, setLocalVisionKey] = useState(apiConfig.visionApi?.apiKey || '');
  const [localVisionModel, setLocalVisionModel] = useState(apiConfig.visionApi?.model || '');
  const [availableVisionModels, setAvailableVisionModels] = useState<string[]>(readStoredVisionModels);
  const [selectedVisionPresetId, setSelectedVisionPresetId] = useState<string | null>(null);
  const [visionStatusMsg, setVisionStatusMsg] = useState('');
  const [testingVisionApi, setTestingVisionApi] = useState(false);
  const [visionTestResult, setVisionTestResult] = useState<string | null>(null);
  const [localMiniMaxKey, setLocalMiniMaxKey] = useState(apiConfig.minimaxApiKey || '');
  const [localMiniMaxGroupId, setLocalMiniMaxGroupId] = useState(apiConfig.minimaxGroupId || '');
  const [localMiniMaxRegion, setLocalMiniMaxRegion] = useState<'domestic' | 'overseas'>(
    apiConfig.minimaxRegion === 'overseas' ? 'overseas' : 'domestic'
  );
  const [localAceStepKey, setLocalAceStepKey] = useState(apiConfig.aceStepApiKey || '');
  const [localTtsProvider, setLocalTtsProvider] = useState<TtsProvider>(
    apiConfig.ttsProvider === 'fishaudio' || apiConfig.ttsProvider === 'elevenlabs'
      ? apiConfig.ttsProvider
      : 'minimax'
  );
  const [localFishKey, setLocalFishKey] = useState(apiConfig.fishAudioApiKey || '');
  const [localFishModel, setLocalFishModel] = useState(apiConfig.fishAudioModel || 's2.1-pro');
  const [localElevenLabsKey, setLocalElevenLabsKey] = useState(apiConfig.elevenLabsApiKey || '');
  const [localElevenLabsModel, setLocalElevenLabsModel] = useState(apiConfig.elevenLabsModel || DEFAULT_ELEVENLABS_MODEL);
  const [localElevenLabsStability, setLocalElevenLabsStability] = useState(apiConfig.elevenLabsStability ?? 0.5);
  const [localElevenLabsSimilarityBoost, setLocalElevenLabsSimilarityBoost] = useState(apiConfig.elevenLabsSimilarityBoost ?? 0.8);
  const [localElevenLabsStyle, setLocalElevenLabsStyle] = useState(apiConfig.elevenLabsStyle ?? 0);
  const [localElevenLabsUseSpeakerBoost, setLocalElevenLabsUseSpeakerBoost] = useState(apiConfig.elevenLabsUseSpeakerBoost === true);
  // 自定义语音表演指南（留空 → 用内置默认）。按服务商分别保存。
  const [localVoicePromptMinimax, setLocalVoicePromptMinimax] = useState(apiConfig.voicePrompts?.minimax || '');
  const [localVoicePromptFish, setLocalVoicePromptFish] = useState(apiConfig.voicePrompts?.fishaudio || '');
  const [localVoicePromptElevenLabs, setLocalVoicePromptElevenLabs] = useState(apiConfig.voicePrompts?.elevenlabs || '');
  const [localVoicePromptDate, setLocalVoicePromptDate] = useState(apiConfig.voicePrompts?.dateVoice || '');
  const [showVoicePrompts, setShowVoicePrompts] = useState(false);
  const [showAceStepGuide, setShowAceStepGuide] = useState(false);
  const [otherStatusMsg, setOtherStatusMsg] = useState('');
  // 高级设置（流式/温度）默认折叠 — 大多数用户不需要碰
  const [showApiAdvanced, setShowApiAdvanced] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isLoadingVisionModels, setIsLoadingVisionModels] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  // 就地编辑某条预设：只改预设本身；改的正好是当前生效那条时，生效配置一并跟着走
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editPresetName, setEditPresetName] = useState('');
  const [editPresetUrl, setEditPresetUrl] = useState('');
  const [editPresetKey, setEditPresetKey] = useState('');
  const [editPresetModel, setEditPresetModel] = useState('');
  const [editPresetStream, setEditPresetStream] = useState(false);
  const [editPresetTemperature, setEditPresetTemperature] = useState(0.85);
  const [holdingDeletePresetId, setHoldingDeletePresetId] = useState<string | null>(null);
  const presetDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // UI States
  const [showModelModal, setShowModelModal] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [showVisionModelModal, setShowVisionModelModal] = useState(false);
  const [visionModelFilter, setVisionModelFilter] = useState('');
  const [showExportModal, setShowExportModal] = useState(false); // Used for completion now
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [showApiCallLog, setShowApiCallLog] = useState(false);
  const [showRealtimeModal, setShowRealtimeModal] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [showMcpHelp, setShowMcpHelp] = useState(false);
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [showCloudRestoreModal, setShowCloudRestoreModal] = useState(false);
  const [cloudBackupFiles, setCloudBackupFiles] = useState<import('../types').CloudBackupFile[]>([]);
  const [cloudBackupListState, setCloudBackupListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [cloudBackupListError, setCloudBackupListError] = useState('');
  const [cloudTestResult, setCloudTestResult] = useState<string>('');
  const [cloudTesting, setCloudTesting] = useState(false);
  const [avatarModelInventory, setAvatarModelInventory] = useState<AvatarModelBackupInventory | null>(null);
  const [avatarModelBackupBusy, setAvatarModelBackupBusy] = useState(false);
  const [avatarModelBackupProgress, setAvatarModelBackupProgress] = useState<AvatarModelBackupProgress | null>(null);

  // 「该备份啦」提醒频率（1~30 天）。改动即落 localStorage（backupReminder 模块自管持久化）。
  const [backupReminderDays, setBackupReminderDays] = useState<number>(() => getBackupReminderState().intervalDays);
  const backupDaysAgo = daysSinceLastBackup();
  const hasJournalAppearanceOverride = Boolean(
    theme.journalAppearance
    && ((theme.journalAppearance.preset || 'original') !== 'original'
      || theme.journalAppearance.customCss?.trim())
  );

  const [confirmAppearanceReset, setConfirmAppearanceReset] = useState(false);
  const [resettingAppearance, setResettingAppearance] = useState(false);
  const handleAppearanceEmergencyReset = async () => {
    setResettingAppearance(true);
    try { await resetAppearance(); }
    finally { setResettingAppearance(false); setConfirmAppearanceReset(false); }
  };
  // 一键还原全部「聊天白框自定义 CSS」：清掉全局 + 每个角色自带的。
  // 兼作救援：单角色的坏 CSS 把聊天界面整崩、进不去该角色设置时，从这里一键全清即可恢复。
  const resetAllChromeCss = () => {
    let n = 0;
    if (theme.chatChromeCustomCss) { updateTheme({ chatChromeCustomCss: '' }); n++; }
    (characters || []).forEach((c: any) => {
      if (c?.chromeCustomCss) { updateCharacter(c.id, { chromeCustomCss: '' } as any); n++; }
    });
    addToast(n ? `已还原 ${n} 处聊天白框美化` : '没有需要还原的白框美化', n ? 'success' : 'info');
  };

  const handleJournalAppearanceEmergencyReset = async () => {
    await updateTheme({ journalAppearance: undefined });
    addToast('已从系统设置还原交换日记原版样式', 'success');
  };

  // Cloud backup local config state (WebDAV)
  const [cbUrl, setCbUrl] = useState(cloudBackupConfig.webdavUrl);
  const [cbUsername, setCbUsername] = useState(cloudBackupConfig.username);
  const [cbPassword, setCbPassword] = useState(cloudBackupConfig.password);
  const [cbPath, setCbPath] = useState(cloudBackupConfig.remotePath || '/SullyBackup/');

  // GitHub local state
  const [ghToken, setGhToken] = useState(cloudBackupConfig.githubToken || '');
  const [ghRepo, setGhRepo] = useState(cloudBackupConfig.githubRepo || 'sully-backup');
  // 安全默认：旧版曾把代理默认打开。现在旧配置一律视为未重新确认，只有在
  // 新版说明下手动开启过（consentVersion=1）才保持勾选。
  const [ghUseProxy, setGhUseProxy] = useState(
      cloudBackupConfig.githubUseProxy === true && cloudBackupConfig.githubProxyConsentVersion === 1
  );
  const [ghShowAdvanced, setGhShowAdvanced] = useState(false);
  const [ghTesting, setGhTesting] = useState(false);
  const [ghTestResult, setGhTestResult] = useState<string>('');

  // 主代理 Worker 地址（联网搜索 / 备份代理 / Notion / 飞书 / MCD·瑞幸 MCP / 网页抓取 / 出图都走它）。
  // 入口刻意低调：默认折叠，普通用户不需要碰，开箱即用。
  const [focusProxyConfigOnMount] = useState(() => consumeProxyWorkerSettingsFocus());
  const [proxyWorkerInput, setProxyWorkerInput] = useState(getProxyWorkerUrl());
  const [showProxyConfig, setShowProxyConfig] = useState(focusProxyConfigOnMount);
  const proxyConfigSectionRef = useRef<HTMLElement | null>(null);
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(() => isAnalyticsEnabled());
  const [firecrawlKeyInput, setFirecrawlKeyInput] = useState(getFirecrawlApiKey);
  const [firecrawlUsage, setFirecrawlUsage] = useState<FirecrawlCreditUsage | null>(null);
  const [firecrawlChecking, setFirecrawlChecking] = useState(false);
  const [firecrawlCheckResult, setFirecrawlCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
      if (!focusProxyConfigOnMount || !showProxyConfig) return;
      const frame = window.requestAnimationFrame(() => {
          proxyConfigSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return () => window.cancelAnimationFrame(frame);
  }, [focusProxyConfigOnMount, showProxyConfig]);

  // 每次打开实时感知面板时查余额，不消耗抓取 credit。失败不影响其他配置。
  useEffect(() => {
      if (!showRealtimeModal) return;
      const key = getFirecrawlApiKey();
      if (!key) return;
      let active = true;
      setFirecrawlChecking(true);
      getFirecrawlCreditUsage(key)
          .then(usage => {
              if (!active) return;
              setFirecrawlUsage(usage);
              setFirecrawlCheckResult({ ok: true, text: 'Firecrawl 已连接' });
          })
          .catch((error: any) => {
              if (!active) return;
              setFirecrawlUsage(null);
              setFirecrawlCheckResult({ ok: false, text: error?.message || 'Firecrawl 连接失败' });
          })
          .finally(() => { if (active) setFirecrawlChecking(false); });
      return () => { active = false; };
  }, [showRealtimeModal]);

  // 实时感知配置的本地状态
  const [rtWeatherEnabled, setRtWeatherEnabled] = useState(realtimeConfig.weatherEnabled);
  const [rtWeatherKey, setRtWeatherKey] = useState(realtimeConfig.weatherApiKey);
  const [rtWeatherCity, setRtWeatherCity] = useState(realtimeConfig.weatherCity);
  const [rtNewsEnabled, setRtNewsEnabled] = useState(realtimeConfig.newsEnabled);
  const [rtNewsApiKey, setRtNewsApiKey] = useState(realtimeConfig.newsApiKey || '');
  const [rtNewsPlatforms, setRtNewsPlatforms] = useState<string[]>(realtimeConfig.newsPlatforms || ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin']);
  const [rtNotionEnabled, setRtNotionEnabled] = useState(realtimeConfig.notionEnabled);
  const [rtNotionKey, setRtNotionKey] = useState(realtimeConfig.notionApiKey);
  const [rtNotionDbId, setRtNotionDbId] = useState(realtimeConfig.notionDatabaseId);
  const [rtNotionNotesDbId, setRtNotionNotesDbId] = useState(realtimeConfig.notionNotesDatabaseId || '');
  const [rtFeishuEnabled, setRtFeishuEnabled] = useState(realtimeConfig.feishuEnabled);
  const [rtFeishuAppId, setRtFeishuAppId] = useState(realtimeConfig.feishuAppId);
  const [rtFeishuAppSecret, setRtFeishuAppSecret] = useState(realtimeConfig.feishuAppSecret);
  const [rtFeishuBaseId, setRtFeishuBaseId] = useState(realtimeConfig.feishuBaseId);
  const [rtFeishuTableId, setRtFeishuTableId] = useState(realtimeConfig.feishuTableId);
  const [rtXhsEnabled, setRtXhsEnabled] = useState(realtimeConfig.xhsEnabled);
  // lite 模式走中心配置的主代理 worker（/api 是 worker/index.js 里的 XHSLite 桥）。
  // 用户改了「自定义网络代理」，lite 模式自动跟着切到新 worker。
  const XHS_LITE_URL = `${getProxyWorkerUrl()}/api`;
  const XHS_RISK_TEXT = '使用提示：Lite 通过网页接口连接小红书，平台规则变化时可能出现登录失效或功能暂时不可用。建议先用小号体验，并在发布或互动前确认内容。';
  const XHS_COOKIE_GUIDE = [
    '【获取小红书 cookie 教程】',
    '1. 用电脑浏览器(Chrome/Edge)登录实际分配给你的站点：www.xiaohongshu.com 或 www.rednote.com',
    '2. 按 F12 打开开发者工具，切到「Network/网络」标签',
    '3. 刷新页面，点列表最上面那条「explore」(document 类型，发给当前网站的主请求)',
    '4. 右侧切到「Headers/标头」，往下滚到「Request Headers/请求标头」',
    '5. 找到 cookie: 开头那一行(很长一串)',
    '6. 复制它后面整段的值：可把 Request Headers 右边的「Raw」开关打开看纯文本更好选，或在值上右键 Copy value，或选中后 Ctrl+C',
    '7. 确认这串里有 a1= 和 web_session= 两个字段(最关键)，粘到「小红书 Lite」的 cookie 框',
    'Lite 会自动判断这串 Cookie 属于国内小红书还是全球 RedNote；不用自己补 gid、bRequestId 等会随站点变化的字段。',
    '注意：别用 Console 的 document.cookie，拿不到 web_session(httpOnly)。cookie 数天~数周会过期，失效重复制即可。',
  ].join('\n');
  const _xhsCfgUrl = realtimeConfig.xhsMcpConfig?.serverUrl || '';
  // 部署模式与协议分开保存：本地 Skills 和云端 Lite 都是 /api，不能再凭路径判断。
  const _xhsStoredMode = resolveXhsDeploymentMode(realtimeConfig.xhsMcpConfig, XHS_LITE_URL);
  const _xhsIsLocal = _xhsStoredMode === 'local';
  const [rtXhsMcpEnabled, setRtXhsMcpEnabled] = useState(realtimeConfig.xhsMcpConfig?.enabled || false);
  const [rtXhsMode, setRtXhsMode] = useState<'lite' | 'local'>(_xhsIsLocal ? 'local' : 'lite');
  const [rtXhsLocalUrl, setRtXhsLocalUrl] = useState(_xhsIsLocal ? _xhsCfgUrl : 'http://localhost:18060/mcp');
  const [rtXhsNickname, setRtXhsNickname] = useState(realtimeConfig.xhsMcpConfig?.loggedInNickname || '');
  const [rtXhsUserId, setRtXhsUserId] = useState(realtimeConfig.xhsMcpConfig?.loggedInUserId || '');
  const [rtXhsCookie, setRtXhsCookie] = useState(realtimeConfig.xhsMcpConfig?.cookie || '');
  const [rtXhsPlatform, setRtXhsPlatform] = useState<'xhs' | 'rednote' | undefined>(realtimeConfig.xhsMcpConfig?.platform);
  const [rtXhsGuideOpen, setRtXhsGuideOpen] = useState(false);
  const [rtTestStatus, setRtTestStatus] = useState('');

  // 麦当劳 MCP (token / 启用态都直接存 localStorage, 不进 realtimeConfig)
  const [mcdToken, setMcdTokenState] = useState(() => getMcdToken());
  const [mcdEnabled, setMcdEnabledState] = useState(() => isMcdEnabled());
  const [mcdTestStatus, setMcdTestStatus] = useState('');
  const [mcdTesting, setMcdTesting] = useState(false);

  // 瑞幸 MCP (与麦当劳同构)
  const [luckinToken, setLuckinTokenState] = useState(() => getLuckinToken());
  const [luckinEnabled, setLuckinEnabledState] = useState(() => isLuckinEnabled());
  const [luckinTestStatus, setLuckinTestStatus] = useState('');
  const [luckinTesting, setLuckinTesting] = useState(false);

  // Proactive Push 加速器（Worker URL / VAPID 公钥写死在 proactivePushConfig.ts 常量里）
  const initialPushCfg = loadPushConfig();
  const ppAvailable = isPushConfigAvailable();
  const [ppEnabled, setPpEnabled] = useState(initialPushCfg.enabled);
  const [ppStatus, setPpStatus] = useState<string>('');
  const [ppBusy, setPpBusy] = useState(false);
  const [showPpConfirm, setShowPpConfirm] = useState(false);
  const [ppDiag, setPpDiag] = useState<PushDiagnostics | null>(null);
  const [ppTestBusy, setPpTestBusy] = useState(false);
  const [ppResetBusy, setPpResetBusy] = useState(false);
  const [ppDeepResetBusy, setPpDeepResetBusy] = useState(false);
  // 连续 zombie 重置失败次数 — 累计 >= 3 时, "重置订阅" 按钮自动 morph 成
  // "深度重置". 不持久化, 刷新页面归零 (用户原话: "刷新页面正常消失").
  const [ppZombieStreak, setPpZombieStreak] = useState(0);
  const [showInstantModal, setShowInstantModal] = useState(false);
  const [showAmsg2Modal, setShowAmsg2Modal] = useState(false);
  const [showVapidModal, setShowVapidModal] = useState(false);
  const [vapidReadyTick, setVapidReadyTick] = useState(0); // 关闭 VAPID 弹窗后刷新顶层徽标

  // 模型选择 Modal 的过滤 + 公共前缀（memo 掉，避免每次 Settings 重渲染都重算）
  const modelPickerView = useMemo(
      () => buildModelPickerView(availableModels, modelFilter),
      [modelFilter, availableModels],
  );
  const visionModelPickerView = useMemo(
      () => buildModelPickerView(availableVisionModels, visionModelFilter),
      [visionModelFilter, availableVisionModels],
  );

  const refreshPpDiag = useCallback(async () => {
      try { setPpDiag(await getPushDiagnostics()); } catch { /* ignore */ }
  }, []);

  const doEnablePushAccelerator = async () => {
      if (ppBusy) return;
      setPpBusy(true);
      setPpStatus('正在连接 Worker…');
      try {
          const res = await fetch(`${initialPushCfg.workerUrl}/health`);
          if (!res.ok) {
              trackEvent('启用主动消息 Push 加速', { result: 'fail', failStage: 'worker_health' });
              trackEvent('启用 Push 加速器的结果', { result: 'worker-unreachable' });
              setPpStatus(`失败：Worker HTTP ${res.status}`); setPpBusy(false); return;
          }
      } catch (e: any) {
          trackEvent('启用主动消息 Push 加速', { result: 'fail', failStage: 'network' });
          trackEvent('启用 Push 加速器的结果', { result: 'worker-unreachable' });
          setPpStatus(`失败：${e?.message || '网络错误'}`); setPpBusy(false); return;
      }

      // Step 1: ensure permission + subscription up front, regardless of schedules.
      // This is the fix for the old bug where toggle "succeeded" without ever
      // requesting permission when the user hadn't enabled any character timer yet.
      setPpStatus('正在请求通知权限并创建订阅…');
      const sub = await ensureSubscribed();
      if (!sub.ok) {
          trackEvent('启用主动消息 Push 加速', { result: 'fail', failStage: 'subscribe' });
          trackEvent('启用 Push 加速器的结果', { result: 'subscribe-failed' });
          setPpStatus(`失败：${sub.reason || '订阅创建失败'}`);
          setPpBusy(false);
          await refreshPpDiag();
          return;
      }

      // Step 2: persist enabled flag and start heartbeat.
      savePushConfig(true);
      setPpEnabled(true);
      startHeartbeat();

      // Step 3: register any existing per-character schedules.
      const schedules = ProactiveChat.getSchedules();
      let okCount = 0;
      for (const s of schedules) {
          if (await registerScheduleOnWorker(s.charId, s.intervalMs)) okCount++;
      }

      if (schedules.length === 0) {
          trackEvent('启用主动消息 Push 加速', { result: 'success' });
          trackEvent('启用 Push 加速器的结果', { result: 'ok-no-schedule' });
          setPpStatus('已启用（订阅已建立。暂无主动消息定时，下次开启角色主动消息时会自动注册）');
      } else if (okCount < schedules.length) {
          trackEvent('启用主动消息 Push 加速', { result: 'partial' });
          trackEvent('启用 Push 加速器的结果', { result: 'ok-partial-schedule' });
          setPpStatus(`已启用：${okCount}/${schedules.length} 个定时注册成功`);
      } else {
          trackEvent('启用主动消息 Push 加速', { result: 'success' });
          trackEvent('启用 Push 加速器的结果', { result: 'ok' });
          setPpStatus(`已启用，${okCount} 个主动消息定时已注册`);
      }
      setPpBusy(false);
      await refreshPpDiag();
  };

  const doDisablePushAccelerator = async () => {
      trackEvent('关闭主动消息 Push 加速');
      savePushConfig(false);
      setPpEnabled(false);
      stopHeartbeat();
      setPpStatus('已关闭（主动消息退回本地计时器）');
      await refreshPpDiag();
  };

  const doSendTestPush = async () => {
      if (ppTestBusy) return;
      setPpTestBusy(true);
      setPpStatus('正在让 Worker 发一条测试推送…');
      const res = await sendTestPush();
      if (res.ok) {
          trackEvent('发送测试推送（主动消息加速）', { result: 'sent' });
          trackEvent('发一条测试推送', { result: 'sent' });
          setPpStatus('测试推送已发出。如果 5 秒内系统通知里没出现"推送测试成功"，说明送达环节有问题——看下方诊断面板。');
      } else if (res.deadSubscription) {
          trackEvent('发送测试推送（主动消息加速）', { result: 'dead_subscription' });
          trackEvent('发一条测试推送', { result: 'dead-subscription' });
          setPpStatus('订阅已被浏览器吊销（zombie endpoint）。请点下方"重置订阅"重建一次再测。');
      } else {
          trackEvent('发送测试推送（主动消息加速）', { result: 'fail' });
          trackEvent('发一条测试推送', { result: 'failed' });
          setPpStatus(`测试失败：${res.reason || '未知错误'}${res.status ? `（HTTP ${res.status}）` : ''}`);
      }
      setPpTestBusy(false);
      await refreshPpDiag();
  };

  const doResetSubscription = async () => {
      if (ppResetBusy || ppDeepResetBusy) return;
      setPpResetBusy(true);
      setPpStatus('正在重置订阅…');
      const res = await resetSubscription();
      if (res.ok) {
          trackEvent('重置推送订阅', { result: 'success', attempt: bucketRetryCount(ppZombieStreak) });
          setPpZombieStreak(0);
          setPpStatus('订阅已重建。可以再点"发一条测试推送"试一下。');
      } else {
          const reason = res.reason || '';
          // 失败原因指向 zombie endpoint 时累计, 达到 3 次后按钮自动 morph 成深度重置
          if (/permanently-removed|zombie/i.test(reason)) {
              setPpZombieStreak(c => c + 1);
          }
          // 只上报归类后的固定枚举，失败原文一个字都不带；重试次数同样先分桶
          trackEvent('重置推送订阅', {
              result: /permanently-removed|zombie/i.test(reason) ? 'fail_zombie' : 'fail_other',
              attempt: bucketRetryCount(ppZombieStreak),
          });
          setPpStatus(`重置失败：${reason || '未知错误'}`);
      }
      setPpResetBusy(false);
      await refreshPpDiag();
  };

  const doDeepResetSubscription = async () => {
      if (ppDeepResetBusy || ppResetBusy) return;
      setPpDeepResetBusy(true);
      setPpStatus('正在深度重置…');
      const res = await deepResetSubscription();
      // 无论成败, 按钮都回归"重置订阅" — 下次出问题再次累计触发 morph
      setPpZombieStreak(0);
      if (res.ok) {
          // ProactiveChat.resume() 把所有 schedule 推回新 SW. deepResetSubscription 内部
          // 不调它是为了避免循环依赖 (ProactiveChat 反向依赖 proactivePushConfig).
          try { ProactiveChat.resume(); } catch (e) { console.warn('[Settings] ProactiveChat.resume failed', e); }
          trackEvent('深度重置推送订阅', { result: 'success' });
          setPpStatus('订阅已重建。可以再点"发一条测试推送"试一下。');
      } else {
          trackEvent('深度重置推送订阅', { result: 'fail' });
          setPpStatus(`深度重置失败：${res.reason || '未知错误'}`);
      }
      setPpDeepResetBusy(false);
      await refreshPpDiag();
  };

  // Refresh diagnostics whenever the panel is mounted or the toggle changes.
  useEffect(() => {
      void refreshPpDiag();
  }, [refreshPpDiag, ppEnabled]);

  // For web download link
  const [downloadUrl, setDownloadUrl] = useState<string>('');
  const [downloadFileName, setDownloadFileName] = useState('Sully_Backup.zip');
  // 用 ref 跟住当前的 object URL，关弹窗 / 重新导出 / 卸载时都能 revoke 到最新那个，
  // 不受 state 闭包过期影响。
  const downloadUrlRef = useRef<string>('');
  const revokeDownloadUrl = useCallback(() => {
      if (downloadUrlRef.current) {
          URL.revokeObjectURL(downloadUrlRef.current);
          downloadUrlRef.current = '';
      }
      setDownloadUrl('');
  }, []);
  useEffect(() => () => {
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
  }, []);

  const [statusMsg, setStatusMsg] = useState('');
  const [testingApi, setTestingApi] = useState(false);
  const [testApiResult, setTestApiResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const avatarModelBackupInputRef = useRef<HTMLInputElement>(null);
  const refreshAvatarModelInventory = useCallback(async () => {
      try {
          setAvatarModelInventory(await getAvatarModelBackupInventory());
      } catch (error) {
          console.warn('[Settings] 读取模型备份清单失败', error);
      }
  }, []);
  useEffect(() => { void refreshAvatarModelInventory(); }, [refreshAvatarModelInventory]);

  // 把已保存的配置同步进上面这些输入框。
  //
  // 三个区块（主 API / 识图 / 其他）各同步各的，依赖写到具体字段值上——**不能**整个
  // apiConfig 当依赖：updateApiConfig 每次都返回新对象，那样在识图区点一下保存，
  // 主 API 这边还没保存的输入就被悄悄冲回旧值了，而且界面上完全看不出来。
  useEffect(() => {
      setLocalUrl(apiConfig.baseUrl);
      setLocalKey(apiConfig.apiKey);
      setLocalModel(String(apiConfig.model || ''));
      setLocalStream(apiConfig.stream === true);
      setLocalTemperature(typeof apiConfig.temperature === 'number' ? apiConfig.temperature : 0.85);
  }, [apiConfig.baseUrl, apiConfig.apiKey, apiConfig.model, apiConfig.stream, apiConfig.temperature]);

  useEffect(() => {
      setLocalVisionEnabled(apiConfig.visionApi?.enabled === true);
  }, [apiConfig.visionApi?.enabled]);
  useEffect(() => {
      setLocalVisionUrl(apiConfig.visionApi?.baseUrl || '');
      setLocalVisionKey(apiConfig.visionApi?.apiKey || '');
      setLocalVisionModel(apiConfig.visionApi?.model || '');
  }, [apiConfig.visionApi?.baseUrl || '', apiConfig.visionApi?.apiKey || '', apiConfig.visionApi?.model || '']);

  useEffect(() => {
      setLocalMiniMaxKey(apiConfig.minimaxApiKey || '');
      setLocalMiniMaxGroupId(apiConfig.minimaxGroupId || '');
      setLocalMiniMaxRegion(apiConfig.minimaxRegion === 'overseas' ? 'overseas' : 'domestic');
      setLocalAceStepKey(apiConfig.aceStepApiKey || '');
      setLocalTtsProvider(
          apiConfig.ttsProvider === 'fishaudio' || apiConfig.ttsProvider === 'elevenlabs'
              ? apiConfig.ttsProvider
              : 'minimax'
      );
      setLocalFishKey(apiConfig.fishAudioApiKey || '');
      setLocalFishModel(apiConfig.fishAudioModel || 's2.1-pro');
      setLocalElevenLabsKey(apiConfig.elevenLabsApiKey || '');
      setLocalElevenLabsModel(apiConfig.elevenLabsModel || DEFAULT_ELEVENLABS_MODEL);
      setLocalElevenLabsStability(apiConfig.elevenLabsStability ?? 0.5);
      setLocalElevenLabsSimilarityBoost(apiConfig.elevenLabsSimilarityBoost ?? 0.8);
      setLocalElevenLabsStyle(apiConfig.elevenLabsStyle ?? 0);
      setLocalElevenLabsUseSpeakerBoost(apiConfig.elevenLabsUseSpeakerBoost === true);
      setLocalVoicePromptMinimax(apiConfig.voicePrompts?.minimax || '');
      setLocalVoicePromptFish(apiConfig.voicePrompts?.fishaudio || '');
      setLocalVoicePromptElevenLabs(apiConfig.voicePrompts?.elevenlabs || '');
      setLocalVoicePromptDate(apiConfig.voicePrompts?.dateVoice || '');
  }, [
      apiConfig.minimaxApiKey, apiConfig.minimaxGroupId, apiConfig.minimaxRegion, apiConfig.aceStepApiKey,
      apiConfig.ttsProvider, apiConfig.fishAudioApiKey, apiConfig.fishAudioModel,
      apiConfig.elevenLabsApiKey, apiConfig.elevenLabsModel, apiConfig.elevenLabsStability,
      apiConfig.elevenLabsSimilarityBoost, apiConfig.elevenLabsStyle, apiConfig.elevenLabsUseSpeakerBoost,
      apiConfig.voicePrompts?.minimax, apiConfig.voicePrompts?.fishaudio,
      apiConfig.voicePrompts?.elevenlabs, apiConfig.voicePrompts?.dateVoice,
  ]);

  // 当前生效的是哪条预设 —— 按已保存的配置反查，不额外记状态。
  // 这样刷新、手改 URL、导入备份之后，界面上的「使用中」永远等于请求真的会发去哪。
  const activePresetId = useMemo(
      () => findActivePresetId(apiPresets, apiConfig),
      [apiPresets, apiConfig.baseUrl, apiConfig.apiKey, apiConfig.model],
  );

  /**
   * 把一份配置真正切过去。保存按钮和点预设走的是同一条路——除了写进全局配置，
   * 还要把已排程的主动消息凭据一起换掉，否则聊天换了、后台任务还拿旧 Key 打请求。
   */
  const commitApiConfig = (patch: PresetSwitchPatch | Partial<APIConfig>) => {
    updateApiConfig(patch);
    // 支持凭据表的 Worker 上，任务只带引用，换 Key 只要覆盖云端那几行——不用逐条改任务。
    // 老 Worker 上这句是 no-op，凭据靠下面那条逐条补刷的老路续命。
    syncAmsgLlmCredentials({ ...apiConfig, ...patch });
    // 已排程的主动消息 2.0 AI 任务里冻结的是排程那一刻的凭据——换 Key / 换模型后
    // 不重传的话，到点全拿旧凭据打请求（旧 Key 一吊销就是连环 401）。best-effort：
    // 保存本身不等它，失败只提示；没配 2.0 / 没有 pending AI 任务时它是 no-op。
    // 存量的内联任务还靠它，所以走引用那条路的用户这里照跑（带 credRefs 的任务
    // 到点只认引用，这一份补刷落在它们身上是无害的空转）。
    void ActiveMsgClient.refreshApiCredentialsForPendingTasks({ ...apiConfig, ...patch })
      .then((result) => {
        if (result.status === 'partial') {
          addToast(`API 已保存，但有 ${result.failed} 条已排程的主动消息没换上新凭据，稍后再保存一次可重试。`, 'error');
        }
      })
      .catch((error) => {
        console.warn('[Settings] 刷新已排程任务的 API 凭据失败', error);
        addToast('API 已保存，但已排程的主动消息凭据刷新失败，稍后再保存一次可重试。', 'error');
      });
  };

  /**
   * 点预设 = 直接切过去并生效，没有「载入了但还没保存」的中间状态。
   * 上面的输入框由 apiConfig 同步 effect 自己跟上，不在这里手动塞。
   * MiniMax / AceStep 那些不归预设管：一个人通常只有一个语音账号，换 LLM 不该动它。
   */
  const applyPreset = (preset: typeof apiPresets[0]) => {
      // 已经在用这条也照切：「使用中」只看 URL/Key/Model 三件套，温度、流式可能被手调过，
      // 再点一下的语义就是「整套回到这条预设存的样子」。
      commitApiConfig(configFromPreset(preset));
      addToast(`已切换到「${preset.name}」，立即生效`, 'success');
  };

  const openEditPreset = (preset: typeof apiPresets[0]) => {
      cancelPresetDeleteHold();
      const isActive = activePresetId === preset.id;
      setEditingPresetId(preset.id);
      setEditPresetName(preset.name);
      setEditPresetUrl(preset.config.baseUrl || '');
      setEditPresetKey(preset.config.apiKey || '');
      setEditPresetModel(preset.config.model || '');
      // 当前正在使用的预设要接住主表单里刚改的高级设置：用户点铅笔再点保存即可写回，
      // 不必猜还要额外按一次「用当前配置填入」。非当前/老预设则读取自身，缺字段才回退。
      setEditPresetStream(
          isActive ? localStream : (typeof preset.config.stream === 'boolean' ? preset.config.stream : localStream),
      );
      setEditPresetTemperature(
          isActive
              ? localTemperature
              : (typeof preset.config.temperature === 'number' ? preset.config.temperature : localTemperature),
      );
  };

  const handleUpdatePreset = () => {
      const preset = apiPresets.find(item => item.id === editingPresetId);
      if (!preset) return;
      const name = editPresetName.trim();
      if (!name) {
          addToast('预设名称不能为空', 'error');
          return;
      }
      const nextConfig = {
          ...preset.config,
          baseUrl: normalizeApiBaseUrl(editPresetUrl),
          apiKey: normalizeApiCredential(editPresetKey),
          model: normalizeApiModel(editPresetModel),
          stream: editPresetStream,
          temperature: editPresetTemperature,
      };
      // 「正在用的就是这条」要在改之前问，改完值就对不上了
      const wasActive = activePresetId === preset.id;
      updateApiPreset(preset.id, name, nextConfig);
      // 改的正好是当前生效那条 → 生效配置跟着走，否则界面写着新 Key、请求还在用旧的
      if (wasActive) commitApiConfig(configFromPreset({ ...preset, name, config: nextConfig }));
      setEditingPresetId(null);
      addToast(wasActive ? `「${name}」已更新，当前配置同步生效` : `「${name}」已更新`, 'success');
  };

  const cancelPresetDeleteHold = useCallback(() => {
      if (presetDeleteTimerRef.current) {
          clearTimeout(presetDeleteTimerRef.current);
          presetDeleteTimerRef.current = null;
      }
      setHoldingDeletePresetId(null);
  }, []);

  useEffect(() => () => {
      if (presetDeleteTimerRef.current) clearTimeout(presetDeleteTimerRef.current);
  }, []);

  // 删预设只是把这张「存档卡」扔掉：当前生效的配置是拷贝，不受影响。
  const deleteApiPreset = (id: string, name: string) => {
      cancelPresetDeleteHold();
      removeApiPreset(id);
      setEditingPresetId(current => (current === id ? null : current));
      addToast(`已删除预设: ${name}`, 'success');
  };

  const beginPresetDeleteHold = (id: string, name: string) => {
      cancelPresetDeleteHold();
      setHoldingDeletePresetId(id);
      presetDeleteTimerRef.current = setTimeout(() => {
          presetDeleteTimerRef.current = null;
          setHoldingDeletePresetId(null);
          removeApiPreset(id);
          setEditingPresetId(current => (current === id ? null : current));
          addToast(`已删除预设: ${name}`, 'success');
      }, 700);
  };

  const handleSavePreset = () => {
      if (!newPresetName.trim()) {
          addToast('请输入预设名称', 'error');
          return;
      }
      addApiPreset(newPresetName, {
        baseUrl: normalizeApiBaseUrl(localUrl),
        apiKey: normalizeApiCredential(localKey),
        model: normalizeApiModel(localModel),
        stream: localStream,
        temperature: localTemperature,
      });
      setNewPresetName('');
      setShowPresetModal(false);
      addToast('预设已保存', 'success');
  };

  /**
   * 保存下面这份表单 = 改「当前生效的配置」，**不会**顺手覆盖任何一条预设。
   * 想把改动存回预设，走预设那排的铅笔（弹窗里可一键填入当前配置）。
   */
  const handleSaveApi = () => {
    const nextConfig = {
      apiKey: normalizeApiCredential(localKey),
      baseUrl: normalizeApiBaseUrl(localUrl),
      model: normalizeApiModel(localModel),
      stream: localStream,
      temperature: localTemperature,
    };
    setLocalKey(nextConfig.apiKey);
    setLocalUrl(nextConfig.baseUrl);
    setLocalModel(nextConfig.model);
    commitApiConfig(nextConfig);
    setStatusMsg('配置已保存');
    setTimeout(() => setStatusMsg(''), 2000);
  };

  const handleSaveVisionApi = (enabled = localVisionEnabled) => {
    const nextVisionApi = {
      enabled,
      baseUrl: normalizeApiBaseUrl(localVisionUrl),
      apiKey: normalizeApiCredential(localVisionKey),
      model: normalizeApiModel(localVisionModel),
    };
    if (nextVisionApi.enabled && (!nextVisionApi.baseUrl || !nextVisionApi.apiKey || !nextVisionApi.model)) {
      addToast('开启识图 API 前，请填写完整的 URL、Key 和 Model', 'error');
      return;
    }
    setLocalVisionUrl(nextVisionApi.baseUrl);
    setLocalVisionKey(nextVisionApi.apiKey);
    setLocalVisionModel(nextVisionApi.model);
    updateApiConfig({ visionApi: nextVisionApi });
    setVisionStatusMsg(nextVisionApi.enabled ? '识图 API 已接入' : '已关闭，沿用原有识图方式');
    setTimeout(() => setVisionStatusMsg(''), 2200);
  };

  const handleToggleVisionApi = () => {
    const enabled = !localVisionEnabled;
    setLocalVisionEnabled(enabled);
    if (!enabled) {
      // 关闭立即落盘；保留已保存的凭据，未保存的输入仍留在表单里。
      updateApiConfig({ visionApi: {
        baseUrl: '', apiKey: '', model: '', ...apiConfig.visionApi, enabled: false,
      } });
      setVisionStatusMsg('已关闭，沿用原有识图方式');
    } else if (normalizeApiBaseUrl(localVisionUrl) && normalizeApiCredential(localVisionKey) && normalizeApiModel(localVisionModel)) {
      handleSaveVisionApi(true);
    } else {
      setVisionStatusMsg('请填写 URL、Key 和 Model，保存后接入');
    }
  };

  const loadVisionApiPreset = (preset: typeof apiPresets[0]) => {
    const next = visionApiConfigFromPreset(preset);
    setSelectedVisionPresetId(preset.id);
    setLocalVisionEnabled(true);
    setLocalVisionUrl(next.baseUrl);
    setLocalVisionKey(next.apiKey);
    setLocalVisionModel(next.model);
    setVisionTestResult(null);
    setVisionStatusMsg(`已载入预设：${preset.name}`);
    setTimeout(() => setVisionStatusMsg(''), 2200);
    addToast(`已把「${preset.name}」填入识图 API；保存后生效`, 'info');
  };

  const fetchVisionModels = async () => {
    const baseUrl = normalizeApiBaseUrl(localVisionUrl);
    const apiKey = normalizeApiCredential(localVisionKey);
    if (!baseUrl) { setVisionStatusMsg('请先填写识图 URL'); return; }
    setIsLoadingVisionModels(true);
    setVisionStatusMsg('正在拉取识图模型...');
    setVisionTestResult(null);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const models = extractModelIds(await safeResponseJson(response));
      if (models.length === 0) {
        setVisionStatusMsg('模型列表为空或格式不兼容');
        return;
      }
      setAvailableVisionModels(models);
      try { localStorage.setItem(VISION_MODEL_LIST_STORAGE_KEY, JSON.stringify(models)); } catch { /* ignore */ }
      if (!models.includes(normalizeApiModel(localVisionModel))) {
        setLocalVisionModel(models[0]);
        setSelectedVisionPresetId(null);
      }
      setVisionStatusMsg(`获取到 ${models.length} 个识图模型`);
      setVisionModelFilter('');
      setShowVisionModelModal(true);
    } catch (error: any) {
      console.error('Fetch Vision Models Error', error);
      setVisionStatusMsg(`拉取失败${error?.message ? `：${error.message}` : ''}`);
    } finally {
      setIsLoadingVisionModels(false);
    }
  };

  const handleTestVisionApi = async () => {
    const config = {
      enabled: true,
      baseUrl: normalizeApiBaseUrl(localVisionUrl),
      apiKey: normalizeApiCredential(localVisionKey),
      model: normalizeApiModel(localVisionModel),
    };
    if (!config.baseUrl || !config.apiKey || !config.model) {
      setVisionTestResult('❌ 请先填写完整的 URL、Key 和 Model');
      return;
    }
    setTestingVisionApi(true);
    setVisionTestResult(null);
    try {
      const description = await describeImageWithVisionApi(VISION_API_TEST_IMAGE_DATA_URL, config);
      setVisionTestResult(`✅ 识图成功 — ${description.slice(0, 80)}`);
      trackEvent('测试识图 API', { result: '成功' });
    } catch (error: any) {
      console.error('Test Vision API Error', error);
      setVisionTestResult(`❌ 识图失败：${error?.message || '未知错误'}`);
      trackEvent('测试识图 API', { result: '失败' });
    } finally {
      setTestingVisionApi(false);
    }
  };

  const buildOtherApiConfig = (overrides: Partial<APIConfig> = {}): Partial<APIConfig> => ({
      minimaxApiKey: localMiniMaxKey,
      minimaxGroupId: localMiniMaxGroupId,
      minimaxRegion: localMiniMaxRegion,
      aceStepApiKey: localAceStepKey,
      ttsProvider: localTtsProvider,
      fishAudioApiKey: localFishKey,
      fishAudioModel: localFishModel,
      elevenLabsApiKey: localElevenLabsKey,
      elevenLabsModel: localElevenLabsModel,
      elevenLabsStability: localElevenLabsStability,
      elevenLabsSimilarityBoost: localElevenLabsSimilarityBoost,
      elevenLabsStyle: localElevenLabsStyle,
      elevenLabsUseSpeakerBoost: localElevenLabsUseSpeakerBoost,
      voicePrompts: {
        minimax: localVoicePromptMinimax.trim() ? localVoicePromptMinimax : undefined,
        fishaudio: localVoicePromptFish.trim() ? localVoicePromptFish : undefined,
        elevenlabs: localVoicePromptElevenLabs.trim() ? localVoicePromptElevenLabs : undefined,
        dateVoice: localVoicePromptDate.trim() ? localVoicePromptDate : undefined,
      },
      ...overrides,
  });

  const handleSaveOtherApis = () => {
    updateApiConfig(buildOtherApiConfig());
    setOtherStatusMsg('已保存');
    setTimeout(() => setOtherStatusMsg(''), 2000);
  };

  // 选「谁来做语音生成」立即落库——不需要再点下面的保存。
  // 连同当前「其他 API」草稿一起提交（与保存按钮同一份 payload）：一是即时生效，
  // 二是避免 [apiConfig] 同步 effect 把刚填、还没保存的 Key 草稿冲掉。
  const selectTtsProvider = (provider: TtsProvider) => {
    setLocalTtsProvider(provider);
    updateApiConfig(buildOtherApiConfig({ ttsProvider: provider }));
    const providerLabel = provider === 'fishaudio' ? '鱼声 Fish' : provider === 'elevenlabs' ? 'ElevenLabs' : 'MiniMax';
    addToast(`语音生成已切到 ${providerLabel}`, 'success');
  };

  // 选鱼声模型：立即落库（同上，连带草稿一起提交，避免被同步 effect 冲掉）。
  const selectFishModel = (model: string) => {
    setLocalFishModel(model);
    updateApiConfig(buildOtherApiConfig({ fishAudioModel: model }));
  };

  // ElevenLabs 模型会改变可用的语音标签，因此和鱼声模型一样立即落库。
  const selectElevenLabsModel = (model: string) => {
    setLocalElevenLabsModel(model);
    updateApiConfig(buildOtherApiConfig({ elevenLabsModel: model }));
  };

  const fetchModels = async () => {
    const baseUrl = normalizeApiBaseUrl(localUrl);
    const apiKey = normalizeApiCredential(localKey);
    if (!baseUrl) { setStatusMsg('请先填写 URL'); return; }
    setIsLoadingModels(true);
    setStatusMsg('正在连接...');
    try {
        const response = await fetch(`${baseUrl}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await safeResponseJson(response);
        // Support common OpenAI-compatible and nested gateway response formats.
        const models = extractModelIds(data);
        if (models.length > 0) {
            setAvailableModels(models);
            if (models.length > 0 && !models.includes(localModel)) setLocalModel(models[0]);
            setStatusMsg(`获取到 ${models.length} 个模型`);
            setShowModelModal(true); // Open selector immediately
        } else { setStatusMsg('模型列表为空或格式不兼容'); }
    } catch (error: any) {
        console.error(error);
        setStatusMsg(`连接失败${error?.message ? `：${error.message}` : ''}`);
    } finally {
        setIsLoadingModels(false);
    }
  };

  // 一键清理「幽灵表情包」残留：先 dryRun 扫描，弹确认后才真正删。
  // 残留的来历：旧版本删角色不会级联清理表情分类，只对已删角色可见的专属分类
  // 会卡在数据库里——单聊面板看不到（也删不掉），群聊面板却能看到。
  const [isCleaningResidue, setIsCleaningResidue] = useState(false);
  const handleCleanupResidue = async () => {
      if (isCleaningResidue) return;
      setIsCleaningResidue(true);
      try {
          const validIds = (await DB.getAllCharacters()).map(c => c.id);
          const scan = await DB.cleanupEmojiResidue(validIds, { dryRun: true });
          if (scan.removedCategories.length === 0 && scan.fixedCategories.length === 0 && scan.removedEmojiCount === 0) {
              addToast('很干净，没有发现表情包残留 ✨', 'success');
              return;
          }
          const lines = [
              scan.removedCategories.length > 0 ? `• 删除 ${scan.removedCategories.length} 个失效专属分类：${scan.removedCategories.map(c => `「${c.name}」`).join('、')}` : '',
              scan.removedEmojiCount > 0 ? `• 删除 ${scan.removedEmojiCount} 个随分类失效/无主的表情` : '',
              scan.fixedCategories.length > 0 ? `• 修复 ${scan.fixedCategories.length} 个分类里指向已删角色的绑定：${scan.fixedCategories.map(c => `「${c.name}」`).join('、')}` : '',
          ].filter(Boolean).join('\n');
          if (!window.confirm(`扫描到以下残留（角色已删除但表情包还在）：\n\n${lines}\n\n点「确定」清理，此操作不可撤销。`)) return;
          const report = await DB.cleanupEmojiResidue(validIds);
          addToast(`清理完成：删除 ${report.removedCategories.length} 个分类、${report.removedEmojiCount} 个表情${report.fixedCategories.length > 0 ? `，修复 ${report.fixedCategories.length} 处绑定` : ''}`, 'success');
      } catch (err) {
          console.error('[Settings] 表情包残留清理失败', err);
          addToast('清理失败，请重试', 'error');
      } finally {
          setIsCleaningResidue(false);
      }
  };

  const handleExport = async (mode: 'text_only' | 'media_only' | 'full') => {
      trackEvent('导出本地备份', { scope: mode });
      try {
          // 二次确认：整包备份（full / text_only）本就包含你的 API 密钥等设置——这是预期行为，
          // 但绝不能发给别人。media_only 只有媒体、不含密钥，视为可分享。
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              const includesSettings = mode !== 'media_only';
              const msg = includesSettings
                  ? '该导出数据包含了明文密钥，请不要发送给任何人'
                  : '该导出内容安全，可以用于分享';
              if (!window.confirm(`${msg}\n\n点「确定」继续导出，「取消」中止。`)) {
                  trackEvent('取消导出前的密钥确认', { mode });
                  return;
              }
          }

          // Trigger export (Context handles loading state UI)
          const blob = await exportSystem(mode);
          
          const fileName = `Sully_Backup_${mode}_${new Date().toISOString().slice(0, 10)}.zip`;
          if (!Capacitor.isNativePlatform()) {
              // 网页额外保留一条手动下载链接，作为浏览器禁用文件分享/自动下载时的最终救援。
              if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
              const url = URL.createObjectURL(blob);
              downloadUrlRef.current = url;
              setDownloadUrl(url);
              setDownloadFileName(fileName);
              setShowExportModal(true);
          }
          const result = await shareOrDownloadBlob({
              blob,
              fileName,
              shareTitle: 'Sully Backup',
              nativeChunked: true,
          });
          if (result === 'cancelled') return;
      } catch (e: any) {
          // 只报导出档位，错误文案是动态串不能进属性
          trackEvent('导出备份失败', { mode });
          addToast(e.message, 'error');
      }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Pass the File object directly to importSystem
      importSystem(file).catch(err => {
          console.error(err);
          // 只上报归类后的固定枚举：报错原文（可能含文件路径/内容片段）只留在 console
          const rawMessage = String(err?.message || '');
          trackEvent('导入备份失败', {
              source: file.name.toLowerCase().endsWith('.zip') ? 'zip' : 'json',
              reason:
                  /无效的文件格式/.test(rawMessage) ? 'invalid_file_format'
                  : /缺少 data\.json/.test(rawMessage) ? 'missing_data_json'
                  : /manifest\.json 解析失败/.test(rawMessage) ? 'bad_manifest'
                  : /JSON 格式错误/.test(rawMessage) ? 'json_syntax'
                  : 'other',
          });
          const details = err?.stack || err?.message || String(err || '未知错误');
          showError('导入失败', details);
          addToast('导入失败，错误信息已展开', 'error');
      });
      
      if (importInputRef.current) importInputRef.current.value = '';
  };

  const deliverStandaloneBackup = async (blob: Blob, fileName: string, shareTitle: string) => {
      if (!Capacitor.isNativePlatform()) {
          if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
          const url = URL.createObjectURL(blob);
          downloadUrlRef.current = url;
          setDownloadUrl(url);
          setDownloadFileName(fileName);
          setShowExportModal(true);
      }
      await shareOrDownloadBlob({ blob, fileName, shareTitle, nativeChunked: true });
  };

  const handleAvatarModelExport = async () => {
      if (avatarModelBackupBusy) return;
      setAvatarModelBackupBusy(true);
      setAvatarModelBackupProgress({ phase: 'scan', done: 0, total: 1, label: '正在读取本地模型…' });
      try {
          const blob = await createAvatarModelBackup(setAvatarModelBackupProgress);
          const fileName = `Sully_Models_${new Date().toISOString().slice(0, 10)}_${Date.now()}.zip`;
          await deliverStandaloneBackup(blob, fileName, 'Sully 模型备份');
          addToast(`模型备份已生成（${formatBackupBytes(blob.size)}）`, 'success');
      } catch (error: any) {
          const details = error?.stack || error?.message || String(error || '未知错误');
          showError('模型备份导出失败', details);
          addToast(error?.message || '模型备份导出失败', 'error');
      } finally {
          setAvatarModelBackupBusy(false);
          setAvatarModelBackupProgress(null);
          void refreshAvatarModelInventory();
      }
  };

  const handleAvatarModelImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      if (!files.length || avatarModelBackupBusy) return;
      setAvatarModelBackupBusy(true);
      let restored = 0;
      let skipped = 0;
      let restoredBytes = 0;
      try {
          for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
              const file = files[fileIndex];
              const result = await restoreAvatarModelBackup(file, progress => {
                  setAvatarModelBackupProgress({
                      ...progress,
                      label: files.length > 1 ? `[${fileIndex + 1}/${files.length}] ${progress.label}` : progress.label,
                  });
              });
              restored += result.restored;
              skipped += result.skipped;
              restoredBytes += result.restoredBytes;
              for (const model of result.models) {
                  updateCharacter(model.characterId, { videoAvatar: model.config });
              }
          }
          await refreshAvatarModelInventory();
          addToast(
              skipped > 0
                  ? `已恢复 ${restored} 个模型，跳过 ${skipped} 个未找到的角色`
                  : `已顺序恢复 ${restored} 个模型（${formatBackupBytes(restoredBytes)}）`,
              skipped > 0 ? 'info' : 'success',
          );
      } catch (error: any) {
          const details = error?.stack || error?.message || String(error || '未知错误');
          showError('模型备份导入失败', details);
          addToast(restored > 0 ? `已恢复 ${restored} 个模型后中断` : '模型备份导入失败', 'error');
      } finally {
          setAvatarModelBackupBusy(false);
          setAvatarModelBackupProgress(null);
          if (avatarModelBackupInputRef.current) avatarModelBackupInputRef.current.value = '';
      }
  };
  // Cloud Backup Handlers
  const handleTestCloudConnection = async () => {
      setCloudTesting(true);
      setCloudTestResult('');
      try {
          const { testConnection } = await import('../utils/webdavClient');
          const tempConfig = { ...cloudBackupConfig, webdavUrl: cbUrl, username: cbUsername, password: cbPassword, remotePath: cbPath };
          const result = await testConnection(tempConfig);
          setCloudTestResult(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
          // 失败原因收敛成固定几类，地址/账号/密码与原始报错都不上报
          if (result.ok) {
              trackEvent('测试 WebDAV 连接', { result: '成功' });
          } else {
              const m = result.message || '';
              trackEvent('测试 WebDAV 连接', {
                  result: '失败',
                  failure_kind:
                      /认证失败/.test(m) ? 'auth_401'
                      : /无法创建/.test(m) ? 'dir_missing_uncreatable'
                      : /服务器返回/.test(m) ? 'http_status'
                      : 'network_error',
              });
          }
      } catch (e: any) {
          trackEvent('测试 WebDAV 连接', { result: '失败', failure_kind: 'network_error' });
          setCloudTestResult(`✗ ${e.message}`);
      }
      setCloudTesting(false);
  };

  const handleSaveCloudConfig = () => {
      updateCloudBackupConfig({
          enabled: true,
          provider: 'webdav',
          webdavUrl: cbUrl, username: cbUsername, password: cbPassword,
          remotePath: cbPath,
      });
      addToast('云端备份配置已保存', 'success');
      setShowCloudModal(false);
  };

  // 保存 / 恢复主代理 Worker 地址
  // 主动消息那边的搜索、Notion、飞书全经这个地址转发（tool_config.proxyWorkerUrl），
  // 所以改完必须把 tool_config 重传一次——不然云端还指着旧地址，角色到点的工具全静默失灵。
  const handleSaveProxyWorker = () => {
      const raw = proxyWorkerInput.trim();
      if (raw && !/^https?:\/\//i.test(raw)) {
          addToast('地址必须以 http:// 或 https:// 开头', 'error');
          trackEvent('代理地址格式被拒');
          return;
      }
      setProxyWorkerUrl(raw);                 // 传空 / 默认地址 → 自动回落默认
      const applied = getProxyWorkerUrl();
      setProxyWorkerInput(applied);
      // 上云那份的 proxyWorkerUrl 是现算的（读 getProxyWorkerUrl），所以要在生效之后再传。
      syncAmsgToolConfig(realtimeConfig);
      if (applied === DEFAULT_PROXY_WORKER) trackEvent('恢复默认代理 Worker', { via: 'save-empty' });
      addToast(applied === DEFAULT_PROXY_WORKER ? '已恢复为默认 Worker' : 'Worker 地址已保存', 'success');
  };

  const handleResetProxyWorker = () => {
      setProxyWorkerUrl('');
      setProxyWorkerInput(getProxyWorkerUrl());
      syncAmsgToolConfig(realtimeConfig);
      trackEvent('恢复默认代理 Worker', { via: 'reset-button' });
      addToast('已恢复为默认 Worker', 'info');
  };

  const handleCheckFirecrawl = async () => {
      const key = firecrawlKeyInput.trim();
      if (!key) {
          setFirecrawlApiKey('');
          setFirecrawlUsage(null);
          setFirecrawlCheckResult({ ok: false, text: '请先填写 Firecrawl API Key' });
          return;
      }
      setFirecrawlChecking(true);
      setFirecrawlCheckResult(null);
      try {
          const usage = await getFirecrawlCreditUsage(key);
          setFirecrawlApiKey(key);
          setFirecrawlKeyInput(key);
          setFirecrawlUsage(usage);
          setFirecrawlCheckResult({ ok: true, text: 'Key 有效，网页读取已启用' });
          addToast('Firecrawl 已连接', 'success');
      } catch (error: any) {
          setFirecrawlUsage(null);
          setFirecrawlCheckResult({ ok: false, text: error?.message || 'Firecrawl 连接失败' });
      } finally {
          setFirecrawlChecking(false);
      }
  };

  const handleClearFirecrawl = () => {
      setFirecrawlApiKey('');
      setFirecrawlKeyInput('');
      setFirecrawlUsage(null);
      setFirecrawlCheckResult(null);
      addToast('已停用 Firecrawl，网页读取将继续使用原有兜底', 'info');
  };

  const handleCloudBackup = async (mode: 'text_only' | 'full') => {
      try { await cloudBackupToWebDAV(mode); } catch { /* toast handled in context */ }
  };

  const handleOpenCloudRestore = async () => {
      setShowCloudRestoreModal(true);
      setCloudBackupFiles([]);
      setCloudBackupListState('loading');
      setCloudBackupListError('');
      try {
          const files = await listCloudBackups();
          setCloudBackupFiles(files);
          setCloudBackupListState('ready');
          trackEvent('加载云端备份列表', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav', result: '成功' });
      } catch (error: any) {
          const message = error?.message || '获取云端备份列表失败';
          setCloudBackupListError(message);
          setCloudBackupListState('error');
          trackEvent('加载云端备份列表', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav', result: '失败' });
          addToast(message, 'error');
      }
  };

  const handleCloudRestore = async (file: import('../types').CloudBackupFile) => {
      if (file.status === 'incomplete') {
          addToast(file.statusMessage || '这个备份上传未完成，暂时不能恢复', 'error');
          return;
      }
      setShowCloudRestoreModal(false);
      try {
          await cloudRestoreFromWebDAV(file);
      } catch (err: any) {
          // 只区分「下载阶段」还是「导入阶段」，报错原文只进 showError / console
          trackEvent('从云端恢复失败', {
              provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav',
              stage: /^恢复失败/.test(String(err?.message || '')) ? 'import' : 'download',
          });
          const details = err?.stack || err?.message || String(err || '未知错误');
          showError('云端恢复失败', details);
      }
  };

  // GitHub backup handlers — single "测试并连接" button does verify-token +
  // ensure-repo, persists owner/login on success so users never type 'owner'.
  const handleTestGithub = async () => {
      if (!ghToken.trim()) {
          trackEvent('测试并连接 GitHub', { result: '失败', failure_stage: 'no_token' });
          setGhTestResult('✗ 请先粘贴 Token');
          return;
      }
      setGhTesting(true);
      setGhTestResult('');
      try {
          const { testConnection } = await import('../utils/githubClient');
          const result = await testConnection({
              ...cloudBackupConfig,
              githubToken: ghToken.trim(),
              githubRepo: ghRepo.trim() || 'sully-backup',
              githubUseProxy: ghUseProxy,
              githubProxyConsentVersion: ghUseProxy ? 1 : undefined,
          });
          setGhTestResult(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
          // 失败时只报卡在哪一步：token 校验没过 → 没有 login，仓库准备没过 → 有 login
          trackEvent('测试并连接 GitHub', result.ok
              ? { result: '成功' }
              : { result: '失败', failure_stage: result.login ? 'ensure_repo' : 'verify_token' });
          if (result.ok && result.login) {
              updateCloudBackupConfig({
                  enabled: true,
                  provider: 'github',
                  githubToken: ghToken.trim(),
                  githubOwner: result.login,
                  githubRepo: ghRepo.trim() || 'sully-backup',
                  githubUseProxy: ghUseProxy,
                  githubProxyConsentVersion: ghUseProxy ? 1 : undefined,
              });
          }
      } catch (e: any) {
          trackEvent('测试并连接 GitHub', { result: '失败', failure_stage: 'exception' });
          setGhTestResult(`✗ ${e?.message || '连接失败'}`);
      }
      setGhTesting(false);
  };

  const handleGithubProxyToggle = (enabled: boolean) => {
      setGhUseProxy(enabled);
      // 勾选本身就是用户对中转的明确同意，立即持久化。旧行为只有再次完成
      // “测试并连接”才保存，用户可能勾完直接关闭，实际上传仍在走直连。
      updateCloudBackupConfig({
          githubUseProxy: enabled,
          githubProxyConsentVersion: enabled ? 1 : undefined,
      });
      trackEvent('切换 GitHub 备份线路', { route: enabled ? 'cloudflare_worker' : 'direct' });
      addToast(
          enabled ? '已改用应用内 Cloudflare 中转，下次备份立即生效' : '已改为直连 GitHub 附件域名',
          'info',
      );
  };

  const handleDisableCloud = () => {
      trackEvent('关闭云端备份', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav' });
      updateCloudBackupConfig({ enabled: false });
      setShowCloudModal(false);
      setShowGithubModal(false);
      addToast('云端备份已关闭', 'info');
  };

  // One-click provider switch — if the target provider was already configured
  // before, just flip the 'provider' field and show a toast. Otherwise open
  // the setup modal. Critically: switching does NOT touch the other side's
  // saved credentials, so old WebDAV users keep their old backups visible
  // when they switch back.
  const switchToGithub = () => {
      trackEvent('切换云端备份服务商', { to: 'github' });
      if (cloudBackupConfig.githubToken && cloudBackupConfig.githubOwner) {
          updateCloudBackupConfig({ provider: 'github' });
          addToast(`已切换到 GitHub @${cloudBackupConfig.githubOwner}`, 'success');
      } else {
          setShowGithubModal(true);
      }
  };
  const switchToWebDAV = () => {
      trackEvent('切换云端备份服务商', { to: 'webdav' });
      if (cloudBackupConfig.webdavUrl && cloudBackupConfig.username) {
          updateCloudBackupConfig({ provider: 'webdav' });
          addToast('已切换回 WebDAV，旧备份依旧在', 'success');
      } else {
          setShowCloudModal(true);
      }
  };

  const confirmReset = () => {
      resetSystem();
      setShowResetConfirm(false);
  };

  // 保存实时感知配置
  const handleSaveRealtimeConfig = () => {
      const updates = {
          weatherEnabled: rtWeatherEnabled,
          weatherApiKey: rtWeatherKey,
          weatherCity: rtWeatherCity,
          newsEnabled: rtNewsEnabled,
          newsApiKey: rtNewsApiKey,
          newsPlatforms: rtNewsPlatforms,
          notionEnabled: rtNotionEnabled,
          notionApiKey: rtNotionKey,
          notionDatabaseId: rtNotionDbId,
          notionNotesDatabaseId: rtNotionNotesDbId || undefined,
          feishuEnabled: rtFeishuEnabled,
          feishuAppId: rtFeishuAppId,
          feishuAppSecret: rtFeishuAppSecret,
          feishuBaseId: rtFeishuBaseId,
          feishuTableId: rtFeishuTableId,
          xhsEnabled: rtXhsEnabled,
          xhsMcpConfig: {
              enabled: rtXhsMcpEnabled,
              mode: rtXhsMode,
              serverUrl: rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl,
              cookie: rtXhsMode === 'lite' ? (rtXhsCookie.trim() || undefined) : undefined,
              platform: rtXhsMode === 'lite' ? rtXhsPlatform : undefined,
              loggedInNickname: rtXhsNickname || undefined,
              loggedInUserId: rtXhsUserId || undefined,
              userXsecToken: realtimeConfig.xhsMcpConfig?.userXsecToken,
          }
      };
      updateRealtimeConfig(updates);
      RealtimeContextManager.clearCache();
      const nextRealtimeConfig = { ...realtimeConfig, ...updates };
      // 云端凭据 + 按配置裁剪过的提示词一起刷，否则角色到点会照着旧提示词调已关掉的工具。
      syncAmsgToolConfigAndPrompts(nextRealtimeConfig, { characters, userProfile, groups });
      addToast('实时感知配置已保存', 'success');
      setShowRealtimeModal(false);
  };

  // 测试天气API连接：填了 key 测 OpenWeatherMap，没填测免费的 Open-Meteo
  const testWeatherApi = async () => {
      if (!rtWeatherCity) {
          setRtTestStatus('请先填写城市');
          return;
      }
      setRtTestStatus('正在测试...');
      try {
          const weather = rtWeatherKey
              ? await fetchOwmWeather(rtWeatherCity, rtWeatherKey)
              : await fetchOpenMeteoWeather(rtWeatherCity);
          const source = rtWeatherKey ? 'OpenWeatherMap' : 'Open-Meteo';
          // 刻意不带数据源名：那等价于「有没有填天气 key」，属于配置状态
          trackEvent('测试天气数据源连接', { result: 'ok' });
          setRtTestStatus(`连接成功！(${source}) ${weather.city}: ${weather.description}, ${weather.temp}°C`);
      } catch (e: any) {
          trackEvent('测试天气数据源连接', { result: 'failed' });
          setRtTestStatus(`连接失败: ${e.message}`);
      }
  };

  // 测试Notion连接
  const testNotionApi = async () => {
      if (!rtNotionKey || !rtNotionDbId) {
          setRtTestStatus('请填写 Notion API Key 和 Database ID');
          return;
      }
      setRtTestStatus('正在测试 Notion 连接...');
      try {
          const result = await NotionManager.testConnection(rtNotionKey, rtNotionDbId);
          trackEvent('测试 Notion 连接', { result: result.success ? 'ok' : 'failed' });
          setRtTestStatus(result.message);
      } catch (e: any) {
          trackEvent('测试 Notion 连接', { result: 'network-error' });
          setRtTestStatus(`网络错误: ${e.message}`);
      }
  };

  // 测试飞书连接
  const testFeishuApi = async () => {
      if (!rtFeishuAppId || !rtFeishuAppSecret || !rtFeishuBaseId || !rtFeishuTableId) {
          setRtTestStatus('请填写飞书 App ID、App Secret、多维表格 ID 和数据表 ID');
          return;
      }
      setRtTestStatus('正在测试飞书连接...');
      try {
          const result = await FeishuManager.testConnection(rtFeishuAppId, rtFeishuAppSecret, rtFeishuBaseId, rtFeishuTableId);
          trackEvent('测试飞书连接', { result: result.success ? 'ok' : 'failed' });
          setRtTestStatus(result.message);
      } catch (e: any) {
          trackEvent('测试飞书连接', { result: 'network-error' });
          setRtTestStatus(`网络错误: ${e.message}`);
      }
  };

  // 测试小红书 Bridge 连接
  const testXhsMcp = async () => {
      const urlToUse = rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl;
      const cookieToUse = rtXhsMode === 'lite' ? (rtXhsCookie.trim() || undefined) : undefined;
      if (!urlToUse) {
          setRtTestStatus('请填写服务器 URL');
          return;
      }
      if (rtXhsMode === 'lite' && !cookieToUse) {
          setRtTestStatus('请先粘贴小红书 cookie');
          return;
      }
      setRtTestStatus('正在连接...');
      try {
          const result = await XhsMcpClient.testConnection(
              urlToUse,
              cookieToUse,
          );
          if (result.connected) {
              // 昵称 / 用户 ID / xsecToken 一律不带
              trackEvent('测试小红书桥接连接', { mode: rtXhsMode === 'lite' ? 'lite' : 'local', result: 'connected' });
              const toolCount = result.tools?.length || 0;
              const tokenInfo = result.xsecToken ? ' | xsecToken 已获取' : '';
              const platformInfo = result.platform ? ` | 平台: ${result.platform === 'rednote' ? 'RedNote' : '小红书'}` : '';
              const loginInfo = result.loggedIn
                  ? `${platformInfo} | ${result.nickname ? `账号: ${result.nickname}` : '已登录'}${result.userId ? ` (ID: ${result.userId})` : ''}${tokenInfo}`
                  : ' | 未登录，请检查 cookie 或登录小红书';
              setRtTestStatus(`连接成功! ${toolCount} 个功能可用${loginInfo}`);
              // 自动填充：只在用户未手动填写时覆盖
              if (result.nickname && !rtXhsNickname) setRtXhsNickname(result.nickname);
              if (result.userId && !rtXhsUserId) setRtXhsUserId(result.userId);
              setRtXhsPlatform(result.platform);
              const xhsUpdates = {
                  xhsMcpConfig: {
                      enabled: rtXhsMcpEnabled,
                      mode: rtXhsMode,
                      serverUrl: urlToUse,
                      cookie: cookieToUse,
                      platform: result.platform,
                      loggedInNickname: rtXhsNickname || result.nickname,
                      loggedInUserId: rtXhsUserId || result.userId,
                      userXsecToken: result.xsecToken,
                  }
              };
              updateRealtimeConfig(xhsUpdates);
              const nextConfig = { ...realtimeConfig, ...xhsUpdates };
              syncAmsgToolConfigAndPrompts(nextConfig, { characters, userProfile, groups });
          } else {
              trackEvent('测试小红书桥接连接', { mode: rtXhsMode === 'lite' ? 'lite' : 'local', result: 'failed' });
              setRtTestStatus(`连接失败: ${result.error}`);
          }
      } catch (e: any) {
          trackEvent('测试小红书桥接连接', { mode: rtXhsMode === 'lite' ? 'lite' : 'local', result: 'network-error' });
          setRtTestStatus(`网络错误: ${e.message}`);
      }
  };

  // 麦当劳 MCP: 改 token / 启用态都即时落 localStorage; "测试连接"调 initialize+tools/list
  const handleMcdTokenChange = (v: string) => {
      setMcdTokenState(v);
      saveMcdToken(v);
      resetMcdSession();
      setMcdTestStatus('');
  };
  const handleMcdEnabledChange = (v: boolean) => {
      setMcdEnabledState(v);
      saveMcdEnabled(v);
      if (!v) resetMcdSession();
  };
  const testMcdApi = async () => {
      if (!mcdToken.trim()) { setMcdTestStatus('请先填写 MCP Token'); return; }
      setMcdTesting(true);
      setMcdTestStatus('正在连接麦当劳 MCP...');
      try {
          const r = await testMcdConnection();
          if (r.ok) {
              trackEvent('测试点单 MCP 连接', { provider: 'mcdonalds', result: 'ok' });
              const names = (r.tools || []).map(t => t.name).slice(0, 6).join(', ');
              setMcdTestStatus(`✅ ${r.message}${names ? `\n工具: ${names}${(r.tools || []).length > 6 ? ' ...' : ''}` : ''}`);
          } else {
              trackEvent('测试点单 MCP 连接', { provider: 'mcdonalds', result: 'failed' });
              setMcdTestStatus(`❌ ${r.message}`);
          }
      } catch (e: any) {
          trackEvent('测试点单 MCP 连接', { provider: 'mcdonalds', result: 'exception' });
          setMcdTestStatus(`❌ ${e?.message || String(e)}`);
      } finally {
          setMcdTesting(false);
      }
  };

  // 瑞幸 MCP (与麦当劳同构)
  const handleLuckinTokenChange = (v: string) => {
      setLuckinTokenState(v);
      saveLuckinToken(v);
      resetLuckinSession();
      setLuckinTestStatus('');
  };
  const handleLuckinEnabledChange = (v: boolean) => {
      setLuckinEnabledState(v);
      saveLuckinEnabled(v);
      if (!v) resetLuckinSession();
  };
  const testLuckinApi = async () => {
      if (!luckinToken.trim()) { setLuckinTestStatus('请先填写 MCP Token'); return; }
      setLuckinTesting(true);
      setLuckinTestStatus('正在连接瑞幸 MCP...');
      try {
          const r = await testLuckinConnection();
          if (r.ok) {
              trackEvent('测试点单 MCP 连接', { provider: 'luckin', result: 'ok' });
              const names = (r.tools || []).map(t => t.name).slice(0, 6).join(', ');
              setLuckinTestStatus(`✅ ${r.message}${names ? `\n工具: ${names}${(r.tools || []).length > 6 ? ' ...' : ''}` : ''}`);
          } else {
              trackEvent('测试点单 MCP 连接', { provider: 'luckin', result: 'failed' });
              setLuckinTestStatus(`❌ ${r.message}`);
          }
      } catch (e: any) {
          trackEvent('测试点单 MCP 连接', { provider: 'luckin', result: 'exception' });
          setLuckinTestStatus(`❌ ${e?.message || String(e)}`);
      } finally {
          setLuckinTesting(false);
      }
  };

  return (
    <div className="h-full w-full bg-[#f3f4f8] flex flex-col font-light relative isolate">

      {/* GLOBAL PROGRESS OVERLAY */}
      {sysOperation.status === 'processing' && (
          <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center animate-fade-in">
              <div className="bg-white p-6 rounded-3xl shadow-2xl flex flex-col items-center gap-4 w-64">
                  <div className="w-12 h-12 border-4 border-slate-200 border-t-primary rounded-full animate-spin"></div>
                  <div className="text-sm font-bold text-slate-700 text-center leading-relaxed whitespace-pre-wrap break-words max-w-full">{sysOperation.message}</div>
                  {sysOperation.progress > 0 && (
                      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${sysOperation.progress}%` }}></div>
                      </div>
                  )}
              </div>
          </div>
      )}

      {/* Header */}
      <div className="bg-[#fffefe] border-b border-slate-200 shrink-0 z-10 sticky top-0" style={{ paddingTop: 'var(--safe-top)' }}>
        <div className="flex items-center px-4 py-3">
        <div className="flex items-center gap-2 w-full">
            <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                </svg>
            </button>
            <h1 className="text-xl font-medium text-slate-700 tracking-wide">系统设置</h1>
        </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6 no-scrollbar pb-20">

        {/* 外观救急入口统一放在设置顶部，无需进入已被错误 CSS 遮住的聊天或日记。 */}
        <SettingsSection
            title="外观急救"
            badge={hasJournalAppearanceOverride
                ? <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-bold shrink-0">日记美化已启用</span>
                : undefined}
            icon={
                <div className="p-2 bg-amber-100/70 rounded-xl text-amber-700">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21a2.12 2.12 0 0 0 3-3l-5.84-5.84M11.42 15.17l2.83-2.83M11.42 15.17l-4.68 4.68a2.121 2.121 0 0 1-3-3l6.59-6.59m4.08 1.9 2.83-2.83m0 0 1.5-1.5a2.121 2.121 0 0 0-3-3l-1.5 1.5m3 3-3-3m-3.91 3.91-4.95-4.95a2.121 2.121 0 0 0-3 3l4.95 4.95" /></svg>
                </div>
            }
        >
            <p className="text-xs text-slate-500 leading-relaxed">
                如果交换日记的自定义 CSS 把返回键、设置键遮住或变得无法点击，可以从这里直接清除日记主题与 CSS，不影响日记内容。
            </p>
            <button
                type="button"
                disabled={!hasJournalAppearanceOverride}
                onClick={handleJournalAppearanceEmergencyReset}
                className="mt-3 w-full rounded-xl bg-amber-600 px-4 py-3 text-xs font-bold text-white shadow-sm transition active:scale-[.98] disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
            >
                {hasJournalAppearanceOverride ? '重置交换日记美化' : '交换日记当前为原版'}
            </button>
            <div className="mt-4 border-t border-slate-100 pt-4">
                <p className="text-xs text-slate-500 leading-relaxed">聊天白框 CSS 导致界面异常、无法进入角色设置时，还原全局及全部角色的白框美化，其他聊天外观设置不受影响。</p>
                <button type="button"
                    onClick={() => { if (window.confirm('确定还原全部聊天白框美化？将清空「全局」以及「每个角色」的自定义 CSS（其它聊天外观设置不受影响）。')) resetAllChromeCss(); }}
                    className="mt-3 w-full rounded-xl bg-amber-600 px-4 py-3 text-xs font-bold text-white shadow-sm transition active:scale-[.98]">
                    一键还原全部聊天白框美化（救援）
                </button>
            </div>
            <div className="mt-4 border-t border-slate-100 pt-4">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-sm font-bold text-rose-500 uppercase tracking-widest">一键还原外观</h2>
                </div>
                <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
                    把主题色、壁纸、字体、应用图标、桌面小组件、装饰贴纸全部还原成最初始状态。在不同版本之间反复导入预设导致图标错乱时使用。<br/>
                    <span className="text-slate-400">已保存的外观预设不会被删除，随时还能切回去。</span>
                </p>
                {!confirmAppearanceReset ? (
                    <button onClick={() => setConfirmAppearanceReset(true)}
                        className="w-full py-2.5 bg-white text-rose-500 font-bold text-xs rounded-xl border border-rose-200 active:scale-95 transition-transform flex items-center justify-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                        还原为初始外观
                    </button>
                ) : (
                    <div className="flex gap-2">
                        <button onClick={handleAppearanceEmergencyReset} disabled={resettingAppearance}
                            className="flex-1 py-2.5 bg-rose-500 text-white font-bold text-xs rounded-xl shadow-sm active:scale-95 transition-transform disabled:opacity-50">
                            {resettingAppearance ? '正在还原...' : '确认还原'}
                        </button>
                        <button onClick={() => setConfirmAppearanceReset(false)} disabled={resettingAppearance}
                            className="flex-1 py-2.5 bg-white text-slate-500 font-bold text-xs rounded-xl border border-slate-200 active:scale-95 transition-transform disabled:opacity-50">
                            取消
                        </button>
                    </div>
                )}
            </div>

        </SettingsSection>
        
        {/* 数据备份区域 */}
        <SettingsSection
            title="备份与恢复 (ZIP)"
            icon={
                <div className="p-2 bg-blue-100 rounded-xl text-blue-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
                </div>
            }
        >
            <StorageUsagePanel />

            <div className="mb-3">
                <button onClick={() => handleExport('full')} className="w-full py-4 bg-gradient-to-r from-violet-500 to-purple-600 border border-violet-300 rounded-xl text-xs font-bold text-white shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 relative overflow-hidden mb-3">
                    <div className="absolute top-0 right-0 px-1.5 py-0.5 bg-white/20 text-[9px] text-white rounded-bl-lg font-bold">完整</div>
                    <div className="p-2 bg-white/20 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg></div>
                    <span>整合导出 (文字+媒体)</span>
                </button>
            </div>

            <p className="text-[10px] text-slate-400 px-1 mb-3 text-center">以下为分步导出，适合低配设备分次备份</p>

            <div className="grid grid-cols-2 gap-3 mb-3">
                <button onClick={() => handleExport('text_only')} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 relative overflow-hidden">
                    <div className="p-2 bg-blue-50 rounded-full text-blue-500"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg></div>
                    <span>纯文字备份</span>
                </button>
                 <button onClick={() => handleExport('media_only')} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2">
                    <div className="p-2 bg-pink-50 rounded-full text-pink-500"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg></div>
                    <span>媒体与美化素材</span>
                </button>
            </div>

            <div className="grid grid-cols-1 gap-3 mb-4">
                 <div onClick={() => importInputRef.current?.click()} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 cursor-pointer hover:bg-emerald-50 hover:border-emerald-200">
                    <div className="p-2 bg-emerald-100 rounded-full text-emerald-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg></div>
                    <span>导入备份 (.zip / .json)</span>
                </div>
                <input type="file" ref={importInputRef} className="hidden" accept=".json,.zip" onChange={handleImport} />
            </div>

            <p className="text-[10px] text-slate-400 px-1 mb-4 leading-relaxed">
                • <b>整合导出</b>: 一次性导出文字与图片媒体；VRM / Live2D 模型请使用下方独立备份。<br/>
                • <b>纯文字备份</b>: 包含所有聊天记录、角色设定、剧情数据。所有图片会被移除（减小体积）。<br/>
                • <b>媒体与美化素材</b>: 导出相册、表情包、聊天图片、头像、主题气泡、壁纸、图标等图片资源和外观配置。<br/>
                • <b>语音范围</b>: 整合/媒体备份仅包含已收藏语音，以及 Live2D 开机、触摸预设实际引用的语音；未收藏的聊天、通话等临时语音不会导出。<br/>
                • 兼容旧版 JSON 备份文件的导入。
            </p>

            <div data-testid="avatar-model-backup-section" className="mb-5 border-y border-violet-100 py-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-xs font-bold text-slate-700">视频模型 · 单独备份</h3>
                        <p className="mt-0.5 text-[10px] text-slate-400">VRM / Live2D 不再混进普通数据包</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-bold text-violet-600">
                        {avatarModelInventory
                            ? `${avatarModelInventory.availableCount} 个 · ${formatBackupBytes(avatarModelInventory.totalBytes)}`
                            : '正在扫描…'}
                    </span>
                </div>

                {avatarModelInventory && avatarModelInventory.models.length > 0 && (
                    <div className="mb-3 divide-y divide-slate-100 border-y border-slate-100">
                        {avatarModelInventory.models.map(model => (
                            <div key={model.characterId} className="flex items-center justify-between gap-3 py-2">
                                <div className="min-w-0">
                                    <p className="truncate text-[11px] font-semibold text-slate-600">{model.characterName}</p>
                                    <p className="truncate text-[9px] uppercase tracking-wide text-slate-400">{model.format} · {model.fileName}</p>
                                </div>
                                <span className={`shrink-0 text-[10px] font-medium ${model.available ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {model.available ? formatBackupBytes(model.byteLength) : '文件缺失'}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={handleAvatarModelExport}
                        disabled={avatarModelBackupBusy || !avatarModelInventory?.availableCount}
                        className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 text-xs font-bold text-white transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V3.75m0 0 4.5 4.5M12 3.75l-4.5 4.5M3.75 15v4.125c0 .621.504 1.125 1.125 1.125h14.25c.621 0 1.125-.504 1.125-1.125V15" /></svg>
                        导出模型包
                    </button>
                    <button
                        type="button"
                        onClick={() => avatarModelBackupInputRef.current?.click()}
                        disabled={avatarModelBackupBusy}
                        className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-violet-200 bg-white px-3 text-xs font-bold text-violet-600 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v12m0 0 4.5-4.5M12 19.5 7.5 15M3.75 9V4.875c0-.621.504-1.125 1.125-1.125h14.25c.621 0 1.125.504 1.125 1.125V9" /></svg>
                        顺序导入
                    </button>
                    <input
                        ref={avatarModelBackupInputRef}
                        type="file"
                        accept=".zip,application/zip"
                        multiple
                        className="hidden"
                        onChange={handleAvatarModelImport}
                    />
                </div>

                {avatarModelBackupProgress && (
                    <div className="mt-3" aria-live="polite">
                        <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-violet-600">
                            <span className="truncate">{avatarModelBackupProgress.label}</span>
                            <span className="shrink-0 font-bold">
                                {Math.min(100, Math.round((avatarModelBackupProgress.done / Math.max(1, avatarModelBackupProgress.total)) * 100))}%
                            </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-violet-100">
                            <div
                                className="h-full rounded-full bg-violet-500 transition-[width] duration-200"
                                style={{ width: `${Math.min(100, Math.round((avatarModelBackupProgress.done / Math.max(1, avatarModelBackupProgress.total)) * 100))}%` }}
                            />
                        </div>
                    </div>
                )}

                <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                    一个 ZIP 可以包含多个角色模型。恢复时请先导入上方普通数据，再导入模型包；系统会逐个读取、逐个写入。一次选择多个模型包时，也会按选择顺序处理。
                </p>
                {avatarModelInventory && avatarModelInventory.missingCount > 0 && (
                    <p className="mt-2 text-[10px] leading-relaxed text-rose-500">
                        有 {avatarModelInventory.missingCount} 个角色只剩模型索引，本地二进制已经丢失，无法导出。
                    </p>
                )}
            </div>
            {/* 备份提醒频率：糯米机数据只在本机，隔 N 天没导出会弹一次提醒 */}
            <div className="mb-4 p-3.5 bg-gradient-to-br from-rose-50 to-orange-50 border border-rose-100 rounded-xl">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-slate-600">备份提醒频率</span>
                    <span className="text-xs font-bold text-rose-500">每 {backupReminderDays} 天</span>
                </div>
                <input
                    type="range"
                    min={BACKUP_REMINDER_MIN_DAYS}
                    max={BACKUP_REMINDER_MAX_DAYS}
                    step={1}
                    value={backupReminderDays}
                    onChange={e => {
                        const v = parseInt(e.target.value, 10);
                        setBackupReminderDays(v);
                        setBackupReminderIntervalDays(v);
                    }}
                    className="w-full h-2 bg-rose-100 rounded-full appearance-none accent-rose-500"
                />
                <div className="flex justify-between text-[9px] text-slate-400 mt-1 px-0.5">
                    <span>{BACKUP_REMINDER_MIN_DAYS} 天</span>
                    <span>{BACKUP_REMINDER_MAX_DAYS} 天</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                    超过这个天数没有导出，就会弹窗提醒一次。
                    {backupDaysAgo == null
                        ? ' 你还没有导出过备份，记得留一份哦。'
                        : ` 上次备份是在 ${backupDaysAgo} 天前。`}
                </p>
            </div>

            <button onClick={handleCleanupResidue} disabled={isCleaningResidue} className="w-full py-3 mb-2 bg-amber-50 border border-amber-100 text-amber-600 rounded-xl text-xs font-bold flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50">
                {isCleaningResidue ? '正在扫描…' : '一键清理表情包残留'}
            </button>
            <p className="text-[10px] text-slate-400 px-1 mb-4 leading-relaxed">
                清理已删除角色遗留的「幽灵表情包」：专属分类的角色没了之后，单聊表情面板看不到它、群聊面板却还冒出来。先扫描列出结果，确认后才会删除。
            </p>

            <button onClick={() => setShowResetConfirm(true)} className="w-full py-3 bg-red-50 border border-red-100 text-red-500 rounded-xl text-xs font-bold flex items-center justify-center gap-2">
                格式化系统 (出厂设置)
            </button>
        </SettingsSection>

        {/* 云端备份区域 */}
        <SettingsSection
            title="云端备份"
            icon={
                <div className="p-2 bg-sky-100 rounded-xl text-sky-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                </div>
            }
        >
            {!cloudBackupConfig.enabled ? (
                <div className="space-y-3 py-2">
                    <p className="text-[11px] text-slate-400 leading-relaxed text-center">
                        把备份上传到你自己的云端，换设备、丢手机都不怕。<br/>
                        大文件推荐 <b>GitHub</b>（自动分片上传）。
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => { trackEvent('连接云端备份服务商', { provider: 'github' }); setShowGithubModal(true); }}
                            className="py-3 px-2 bg-gradient-to-br from-slate-800 to-slate-900 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1.5 relative"
                        >
                            <span className="absolute top-1 right-1.5 text-[8px] bg-amber-300 text-slate-800 px-1.5 py-0.5 rounded-full font-bold">推荐</span>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.522 2 12 2z" /></svg>
                            <span>GitHub</span>
                            <span className="text-[9px] text-slate-300 font-normal">大文件自动分片</span>
                        </button>
                        <button
                            onClick={() => { trackEvent('连接云端备份服务商', { provider: 'webdav' }); setShowCloudModal(true); }}
                            className="py-3 px-2 bg-gradient-to-br from-sky-500 to-blue-600 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1.5"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                            <span>WebDAV</span>
                            <span className="text-[9px] text-sky-100 font-normal">日本/NAS · 需梯子</span>
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    <div className={`flex items-center justify-between rounded-xl px-3 py-2 ${cloudBackupConfig.provider === 'github' ? 'bg-slate-100' : 'bg-sky-50'}`}>
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                            <span className="text-[11px] text-slate-600 font-medium">
                                已连接 · {cloudBackupConfig.provider === 'github'
                                    ? `GitHub${cloudBackupConfig.githubOwner ? ` (@${cloudBackupConfig.githubOwner})` : ''}`
                                    : 'WebDAV'}
                            </span>
                        </div>
                        <button
                            onClick={() => cloudBackupConfig.provider === 'github' ? setShowGithubModal(true) : setShowCloudModal(true)}
                            className={`text-[10px] font-medium ${cloudBackupConfig.provider === 'github' ? 'text-slate-600' : 'text-sky-500'}`}
                        >
                            修改配置
                        </button>
                    </div>

                    {/* Quick link to the GitHub releases page so the user knows
                        where their backups physically live and can browse /
                        delete them on github.com directly if they want. */}
                    {cloudBackupConfig.provider === 'github' && cloudBackupConfig.githubOwner && (
                        <a
                            href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                            target="_blank" rel="noopener noreferrer"
                            className="block text-center text-[10px] text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline transition-colors"
                        >
                            🔗 在 GitHub 上查看备份 (github.com/{cloudBackupConfig.githubOwner}/{cloudBackupConfig.githubRepo || 'sully-backup'}/releases) ↗
                        </a>
                    )}

                    {/* Switch-provider hint — shown to existing users so the
                        new GitHub option is discoverable from the connected
                        state, not only on the first-time setup screen. If the
                        other provider was previously configured, the click is
                        a one-shot flip; old credentials and backups stay put. */}
                    {cloudBackupConfig.provider !== 'github' ? (
                        <>
                            <button
                                onClick={switchToGithub}
                                className="w-full py-2 bg-gradient-to-r from-slate-800 to-slate-900 text-white rounded-xl text-[11px] font-bold shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.522 2 12 2z" /></svg>
                                <span>{cloudBackupConfig.githubToken ? '切换到 GitHub' : '试试 GitHub 备份（大文件自动分片）'}</span>
                            </button>
                            <p className="text-[10px] text-slate-400 text-center">
                                你 WebDAV 上的旧备份不会被动，可随时切回。
                            </p>
                        </>
                    ) : (
                        <button
                            onClick={switchToWebDAV}
                            className="w-full py-1.5 text-[10px] text-slate-400 hover:text-sky-500 transition-colors"
                        >
                            {cloudBackupConfig.webdavUrl ? '切换回 WebDAV →' : '改用 WebDAV 备份 →'}
                        </button>
                    )}
                    {cloudBackupConfig.lastBackupTime && (
                        <p className="text-[10px] text-slate-400 text-center">
                            上次备份: {new Date(cloudBackupConfig.lastBackupTime).toLocaleString('zh-CN')}
                            {cloudBackupConfig.lastBackupSize && ` (${(cloudBackupConfig.lastBackupSize / 1024 / 1024).toFixed(1)} MB)`}
                        </p>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => handleCloudBackup('text_only')}
                            className="py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-sky-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                            <span>备份到云端</span>
                            <span className="text-[9px] text-slate-400">(纯文字)</span>
                        </button>
                        <button
                            onClick={() => handleCloudBackup('full')}
                            className="py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-violet-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                            <span>备份到云端</span>
                            <span className="text-[9px] text-slate-400">(完整)</span>
                        </button>
                    </div>

                    <button
                        onClick={handleOpenCloudRestore}
                        className="w-full py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-emerald-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                        从云端恢复
                    </button>
                </div>
            )}

            <p className="text-[10px] text-slate-400 px-1 mt-3 leading-relaxed">
                备份始终存放在你自己的 WebDAV 或 GitHub 账号中，项目不建立用户备份数据库。
                网页 WebDAV 因跨域限制需要中转；GitHub 默认直连，网络受限时可自行开启中转。
            </p>
        </SettingsSection>

        {/* AI 连接设置区域 */}
        <SettingsSection
            title="API 配置"
            icon={
                <div className="p-2 bg-emerald-100/50 rounded-xl text-emerald-600">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                    </svg>
                </div>
            }
            actions={
                <button onClick={() => { setNewPresetName(''); setShowPresetModal(true); }} className="text-[10px] bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                    新建预设
                </button>
            }
        >
            {/* Presets List */}
            {apiPresets.length > 0 && (
                <div className="mb-4">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">我的预设 (Presets)</label>
                    <div className="flex gap-2 flex-wrap">
                        {apiPresets.map(preset => (
                            <div key={preset.id} className={`flex items-center rounded-lg pl-3 pr-1 py-1 shadow-sm border transition-colors ${
                                activePresetId === preset.id
                                    ? 'bg-primary/5 border-primary/30'
                                    : 'bg-white border-slate-200'
                            }`}>
                                <button type="button" onClick={() => applyPreset(preset)}
                                    title={`切换到 ${preset.name}`}
                                    className={`text-xs font-medium cursor-pointer mr-1.5 transition-colors ${
                                        activePresetId === preset.id ? 'text-primary' : 'text-slate-600 hover:text-primary'
                                    }`}>
                                    {preset.name}
                                    {activePresetId === preset.id && <span className="ml-1 text-[9px] font-bold">· 使用中</span>}
                                </button>
                                <button
                                    type="button"
                                    aria-label={`编辑预设 ${preset.name}`}
                                    title="编辑这条预设"
                                    onClick={(event) => { event.stopPropagation(); openEditPreset(preset); }}
                                    className="p-1 rounded-full text-slate-300 hover:bg-primary/10 hover:text-primary transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793ZM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" /></svg>
                                </button>
                                <button
                                    type="button"
                                    aria-label={`长按或双击删除预设 ${preset.name}`}
                                    title="长按或双击删除"
                                    onPointerDown={(event) => { event.stopPropagation(); beginPresetDeleteHold(preset.id, preset.name); }}
                                    onPointerUp={cancelPresetDeleteHold}
                                    onPointerCancel={cancelPresetDeleteHold}
                                    onPointerLeave={cancelPresetDeleteHold}
                                    onDoubleClick={(event) => { event.stopPropagation(); deleteApiPreset(preset.id, preset.name); }}
                                    onContextMenu={(event) => event.preventDefault()}
                                    className={`p-1 rounded-full transition-colors select-none touch-none ${
                                        holdingDeletePresetId === preset.id
                                            ? 'bg-red-100 text-red-500 scale-110'
                                            : 'text-slate-300 hover:bg-red-50 hover:text-red-400'
                                    }`}>
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                    <p className="text-[9px] text-slate-300 mt-1.5 pl-1">点名称直接切换并生效；铅笔改这条预设的内容；长按或双击 × 才会删除。</p>
                </div>
            )}

            <div className="space-y-4">
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                    <input type="text" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} placeholder="https://..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                    <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="sk-..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                {/* 高级（流式 / 温度）— 默认折叠，灰色低调，明确写"不建议修改" */}
                <div className="pt-1">
                    <button
                        type="button"
                        onClick={() => setShowApiAdvanced(v => !v)}
                        className="text-[10px] text-slate-300 hover:text-slate-400 transition-colors flex items-center gap-1 pl-1 active:scale-95"
                    >
                        <span>高级（不建议修改）</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-2.5 h-2.5 transition-transform ${showApiAdvanced ? 'rotate-180' : ''}`}>
                            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                        </svg>
                    </button>
                    {showApiAdvanced && (
                        <div className="mt-2 pl-2 border-l-2 border-slate-100 space-y-3 py-2">
                            <p className="text-[10px] text-slate-300 leading-relaxed">
                                这两项绝大多数用户保持默认即可。除非接口报错"only stream supported"或对回复风格有强需求，否则不建议改。
                            </p>
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-[10px] text-slate-400">流式输出 (Stream)</span>
                                    <p className="text-[9px] text-slate-300 mt-0.5">仅在你的 API 强制要求时打开</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setLocalStream(v => !v)}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${localStream ? 'bg-slate-400' : 'bg-slate-200'}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${localStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                            </div>
                            <div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-slate-400">温度 (Temperature)</span>
                                    <span className="text-[10px] font-mono text-slate-400">{localTemperature.toFixed(2)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="2"
                                    step="0.05"
                                    value={localTemperature}
                                    onChange={(e) => setLocalTemperature(parseFloat(e.target.value))}
                                    className="w-full accent-slate-400 mt-1"
                                />
                                <p className="text-[9px] text-slate-300 mt-0.5">默认 0.85；只作用于聊天和约会的主回复</p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="pt-2">
                     <div className="flex justify-between items-center mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                        <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">{isLoadingModels ? 'Fetching...' : '刷新模型列表'}</button>
                    </div>
                    
                    <button
                        onClick={() => setShowModelModal(true)}
                        title={localModel || 'Select Model...'}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm"
                    >
                        <span
                            className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left"
                            style={{ direction: 'rtl', textOverflow: 'ellipsis' }}
                        >
                            <bdi style={{ direction: 'ltr' }}>{localModel || 'Select Model...'}</bdi>
                        </span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 flex-shrink-0"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                    </button>
                </div>

                <button onClick={handleSaveApi} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-primary/20 bg-primary active:scale-95 transition-all mt-2">
                    {statusMsg || '保存配置'}
                </button>
                {apiPresets.length > 0 && (
                    <p className="text-[9px] text-slate-300 px-1 leading-relaxed">
                        这里改的是当前生效的配置，不会动上面的预设；要把改动存回某条预设，点它的铅笔。
                    </p>
                )}

                <button
                    onClick={async () => {
                        if (!localUrl.trim() || !localKey.trim() || !localModel.trim()) return;
                        setTestingApi(true);
                        setTestApiResult(null);
                        try {
                            const res = await fetch(`${localUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localKey.trim()}` },
                                body: JSON.stringify({
                                    model: localModel.trim(),
                                    messages: [{ role: 'user', content: 'Hi' }],
                                    max_tokens: 5,
                                    stream: localStream,
                                }),
                            });
                            if (res.ok) {
                                // 走 safeResponseJson —— 它能透明把 SSE 流响应拼成普通 chat/completion 结构
                                const data = await safeResponseJson(res);
                                const reply = extractContent(data);
                                setTestApiResult(`✅ 连接成功 — 模型回复: "${reply.slice(0, 30)}"`);
                            } else {
                                const text = await res.text().catch(() => '');
                                setTestApiResult(`❌ HTTP ${res.status}: ${text.slice(0, 100)}`);
                            }
                        } catch (err: any) {
                            setTestApiResult(`❌ 连接失败: ${err.message}`);
                        } finally {
                            setTestingApi(false);
                        }
                    }}
                    disabled={testingApi || !localUrl.trim() || !localKey.trim() || !localModel.trim()}
                    className={`w-full py-2.5 rounded-2xl font-bold text-sm border mt-2 active:scale-95 transition-all ${
                        testingApi || !localUrl.trim() || !localKey.trim() || !localModel.trim()
                            ? 'border-slate-200 text-slate-400 bg-slate-50'
                            : 'border-primary/30 text-primary bg-primary/5 hover:bg-primary/10'
                    }`}
                >
                    {testingApi ? '测试中...' : '🧪 测试连接'}
                </button>

                {testApiResult && (
                    <div className={`mt-2 text-xs px-3 py-2 rounded-xl ${
                        testApiResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                    }`}>
                        {testApiResult}
                    </div>
                )}
            </div>
        </SettingsSection>

        {/* 独立识图 API：给不支持 image_url 的主模型补视觉能力；可手动从通用模型预设载入。 */}
        <SettingsSection
            title="识图 API"
            badge={
                <span className={`text-[9px] font-bold px-2 py-1 rounded-full ${
                    apiConfig.visionApi?.enabled
                        ? 'bg-violet-100 text-violet-600'
                        : 'bg-slate-100 text-slate-400'
                }`}>
                    {apiConfig.visionApi?.enabled ? '已接入' : '未接入'}
                </span>
            }
            icon={
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12 18 18.75 12 18.75 2.25 12 2.25 12Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </div>
            }
        >
            <div className="space-y-4">
                <div className="rounded-2xl border border-violet-100 bg-violet-50/60 p-3.5">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-xs font-bold text-slate-600">接入独立识图 API</div>
                            <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                适合 DeepSeek 等不能直接看图的主模型。
                            </p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={localVisionEnabled}
                            onClick={handleToggleVisionApi}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${localVisionEnabled ? 'bg-violet-500' : 'bg-slate-200'}`}
                        >
                            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${localVisionEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                        </button>
                    </div>
                </div>

                <p className="text-[10px] text-slate-400 leading-relaxed px-1">
                    开启后，每张聊天图片只会先交给这里的视觉模型识别一次，并把结果写成
                    <span className="font-semibold text-violet-600"> [图片：模型看到的内容] </span>
                    再发给主 API；之后聊天和重 roll 都直接复用，不会重复识图扣费。关闭时完全沿用原来的图片发送逻辑。
                </p>

                <div className="rounded-2xl border border-violet-100 bg-white/70 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <label className="text-[10px] font-bold text-violet-500 uppercase tracking-widest">从模型预设载入</label>
                        <span className="text-[9px] text-slate-300">不会切换主 API</span>
                    </div>
                    {apiPresets.length > 0 ? (
                        <div className="flex gap-2 flex-wrap">
                            {apiPresets.map(preset => (
                                <button
                                    key={preset.id}
                                    type="button"
                                    onClick={() => loadVisionApiPreset(preset)}
                                    className={`max-w-full px-3 py-1.5 rounded-lg border text-[11px] font-medium truncate transition-colors ${
                                        selectedVisionPresetId === preset.id
                                            ? 'bg-violet-100 border-violet-200 text-violet-700'
                                            : 'bg-white border-slate-200 text-slate-500 hover:border-violet-200'
                                    }`}
                                    title={`${preset.name} · ${preset.config.model || '未配置模型'}`}
                                >
                                    {preset.name}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <p className="text-[10px] text-slate-400 leading-relaxed">还没有模型预设；可先在上方“API 配置”中保存预设，或直接手动填写。</p>
                    )}
                </div>

                <div className={`space-y-3 transition-opacity ${localVisionEnabled ? 'opacity-100' : 'opacity-50'}`}>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                        <input
                            type="text"
                            value={localVisionUrl}
                            onChange={event => { setLocalVisionUrl(event.target.value); setSelectedVisionPresetId(null); setVisionTestResult(null); }}
                            disabled={!localVisionEnabled}
                            placeholder="https://.../v1"
                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all disabled:cursor-not-allowed"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                        <input
                            type="password"
                            value={localVisionKey}
                            onChange={event => { setLocalVisionKey(event.target.value); setSelectedVisionPresetId(null); setVisionTestResult(null); }}
                            disabled={!localVisionEnabled}
                            placeholder="sk-..."
                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all disabled:cursor-not-allowed"
                        />
                    </div>
                    <div>
                        <div className="flex justify-between items-center mb-1.5 pl-1">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                            <button
                                type="button"
                                onClick={fetchVisionModels}
                                disabled={!localVisionEnabled || isLoadingVisionModels}
                                className="text-[10px] text-violet-600 font-bold disabled:text-slate-300"
                            >
                                {isLoadingVisionModels ? 'Fetching...' : '刷新模型列表'}
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowVisionModelModal(true)}
                            disabled={!localVisionEnabled}
                            title={localVisionModel || '选择或手动输入模型'}
                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm disabled:cursor-not-allowed"
                        >
                            <span className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left text-ellipsis">
                                {localVisionModel || '选择或手动输入模型...'}
                            </span>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 shrink-0"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={handleTestVisionApi}
                        disabled={testingVisionApi || !localVisionEnabled || !localVisionUrl.trim() || !localVisionKey.trim() || !localVisionModel.trim()}
                        className="py-3 rounded-2xl font-bold text-violet-600 border border-violet-200 bg-violet-50 active:scale-95 transition-all disabled:opacity-40"
                    >
                        {testingVisionApi ? '识图测试中…' : '🧪 测试识图'}
                    </button>
                    <button
                        type="button"
                        onClick={() => handleSaveVisionApi()}
                        disabled={isLoadingVisionModels || testingVisionApi}
                        className="py-3 rounded-2xl font-bold text-white shadow-lg shadow-violet-500/20 bg-violet-500 active:scale-95 transition-all disabled:opacity-50"
                    >
                        保存识图 API
                    </button>
                </div>
                {visionStatusMsg && (
                    <div className="text-[11px] text-center text-violet-600 bg-violet-50 px-3 py-2 rounded-xl">{visionStatusMsg}</div>
                )}
                <p className="text-[9px] text-slate-300 px-1">测试会发送一张内置紫色圆点图，确认该模型真的能看图，并消耗一次极小请求。</p>
                {visionTestResult && (
                    <div className={`text-xs px-3 py-2 rounded-xl leading-relaxed ${
                        visionTestResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                    }`}>
                        {visionTestResult}
                    </div>
                )}
            </div>
        </SettingsSection>

        {/* API 调用记录入口 — 点开看最近 5 天各 App / 角色 / 用途的调用明细 */}
        <button
            type="button"
            onClick={() => setShowApiCallLog(true)}
            className="w-full bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50 flex items-center gap-3 active:scale-[0.99] transition-transform text-left"
        >
            <div className="p-2 bg-sky-100/60 rounded-xl text-sky-600 shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />
                </svg>
            </div>
            <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider">API 调用记录</h2>
                <p className="text-[11px] text-slate-400 mt-0.5">最近 5 天：时间 · 哪个 API · 哪个 App · 哪个角色 · 用途</p>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-300 shrink-0">
                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
            </svg>
        </button>

        {/* 其他 API 区域 — 非 LLM 类（语音、写歌等），不会跟随预设切换 */}
        <SettingsSection
            title="其他 API"
            icon={
                <div className="p-2 bg-amber-100/50 rounded-xl text-amber-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
                    </svg>
                </div>
            }
        >
            <p className="text-[11px] text-slate-400 mb-4 leading-relaxed pl-1">
                语音 / 写歌等非 LLM 类 API。这些设置 <span className="font-semibold text-slate-500">不会随预设切换</span>，通常只配置一次。
            </p>

            <div className="space-y-4">
                <p className="text-[11px] text-slate-400 -mt-1 pl-1 leading-relaxed">
                    🎙️ 语音生成支持 <span className="font-semibold text-slate-500">MiniMax</span>、<span className="font-semibold text-slate-500">鱼声 Fish</span> 和 <span className="font-semibold text-slate-500">ElevenLabs</span>。三家的配置都会保留，最后在底部选择当前引擎。
                </p>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax 服务器</label>
                    <div className="flex bg-white/50 border border-slate-200/60 rounded-xl p-1 gap-1">
                        <button
                            type="button"
                            onClick={() => setLocalMiniMaxRegion('domestic')}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${localMiniMaxRegion === 'domestic' ? 'bg-primary text-white shadow-sm' : 'text-slate-600 active:bg-white/60'}`}
                        >
                            国服
                        </button>
                        <button
                            type="button"
                            onClick={() => setLocalMiniMaxRegion('overseas')}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${localMiniMaxRegion === 'overseas' ? 'bg-primary text-white shadow-sm' : 'text-slate-600 active:bg-white/60'}`}
                        >
                            海外
                        </button>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        {localMiniMaxRegion === 'overseas'
                            ? '海外站（api.minimax.io）— 请使用海外账号签发的 Key。'
                            : '国服（api.minimaxi.com）— 默认，适配国内账号。'}
                    </p>
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Key (可选)</label>
                    <input type="password" name="minimax-api-secret" autoComplete="new-password" spellCheck={false} value={localMiniMaxKey} onChange={(e) => setLocalMiniMaxKey(e.target.value)} placeholder="MiniMax API Secret（留空则复用 Key）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">电话 / 音色查询优先使用这个 Key，空着时回退通用 Key。</p>
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Group ID (可选)</label>
                    <input type="text" value={localMiniMaxGroupId} onChange={(e) => setLocalMiniMaxGroupId(e.target.value)} placeholder="group_id（部分账号/模型需要）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">如控制台给了 group_id，请填这里；会透传到 TTS 请求体和代理日志。</p>
                </div>

                {/* 鱼声 Fish Audio —— 与 MiniMax 对等的另一套语音系统，中性样式、不做视觉偏向 */}
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">鱼声 Fish Audio Key</label>
                    <input type="password" name="fish-api-key" autoComplete="new-password" spellCheck={false} value={localFishKey} onChange={(e) => setLocalFishKey(e.target.value)} placeholder="Fish Audio API Key（fish.audio 控制台签发）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">在 <a href="https://fish.audio/zh-CN/developers/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-semibold">fish.audio 开发者页</a> 拿 Key（<span className="text-amber-600 font-medium">需梯子</span>）。角色音色在「角色 → 语音」里填 reference_id。静态网页环境会在合成时通过网络 Worker 转发 Key 与待合成文字，项目不主动留存。</p>

                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-3 mb-1.5 block pl-1">鱼声模型</label>
                    <select
                        value={localFishModel}
                        onChange={(e) => selectFishModel(e.target.value)}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2.5 text-sm focus:bg-white transition-all"
                    >
                        <option value="s2.1-pro-free">s2.1-pro-free —— 免费（同款模型 $0，测试/个人首选）</option>
                        <option value="s2.1-pro">s2.1-pro —— 付费，质量/延迟更优，生产推荐</option>
                        <option value="s2-pro">s2-pro —— 上一代，多说话人 / 自然语言控制</option>
                        <option value="s1">s1 —— 旧版，(圆括号) 情绪标签</option>
                    </select>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        {localFishModel === 's2.1-pro-free'
                            ? '免费版：和 s2.1-pro 同一个模型、$0，但不保证 TTFA / DPA，适合自用测试。选了立即生效。'
                            : '切换立即生效。角色也可在「角色 → 语音」单独覆盖模型（留空则用这里的全局默认）。'}
                    </p>
                </div>

                {/* ElevenLabs —— Voice ID 在角色页配置，这里保存账号、全局模型和通用声音参数。 */}
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">ElevenLabs API Key</label>
                    <input
                        type="password"
                        name="elevenlabs-api-key"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={localElevenLabsKey}
                        onChange={(e) => setLocalElevenLabsKey(e.target.value)}
                        placeholder="ElevenLabs API Key"
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        在 <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-semibold">ElevenLabs API Keys</a> 创建。角色音色在「角色 → 语音」填写 Voice ID；网页端合成会通过项目代理转发，不写入服务端存储。
                    </p>

                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-3 mb-1.5 block pl-1">ElevenLabs 模型</label>
                    <select
                        value={localElevenLabsModel}
                        onChange={(e) => selectElevenLabsModel(e.target.value)}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2.5 text-sm focus:bg-white transition-all"
                    >
                        {ELEVENLABS_MODEL_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        Flash v2.5 默认更适合实时聊天；v3 支持更丰富的方括号 Audio Tags。切换后对应的内置语音提示规则也会同步切换。
                    </p>

                    <details className="mt-3 rounded-xl border border-slate-200/60 bg-white/35 px-3 py-2">
                        <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 select-none">声音参数（高级）</summary>
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {([
                                ['稳定度', localElevenLabsStability, setLocalElevenLabsStability],
                                ['相似度', localElevenLabsSimilarityBoost, setLocalElevenLabsSimilarityBoost],
                                ['风格强度', localElevenLabsStyle, setLocalElevenLabsStyle],
                            ] as const).map(([label, value, setter]) => (
                                <label key={label} className="text-[11px] text-slate-500">
                                    <span className="flex justify-between mb-1"><span>{label}</span><span className="font-mono">{value.toFixed(2)}</span></span>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1"
                                        step="0.05"
                                        value={value}
                                        onChange={(e) => setter(Number(e.target.value))}
                                        className="w-full accent-primary"
                                    />
                                </label>
                            ))}
                            <label className="flex items-center justify-between gap-3 text-[11px] text-slate-500 sm:col-span-2">
                                <span>Speaker Boost（更贴近原音色，可能增加少量延迟）</span>
                                <input
                                    type="checkbox"
                                    checked={localElevenLabsUseSpeakerBoost}
                                    onChange={(e) => setLocalElevenLabsUseSpeakerBoost(e.target.checked)}
                                    className="w-4 h-4 accent-primary"
                                />
                            </label>
                        </div>
                    </details>
                </div>

                {/* 底部：当前语音引擎三选一 —— radio 样式（配置都在上面，这里只挑用哪家） */}
                <div className="group rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-0.5 block">当前语音引擎（三选一）</label>
                    <p className="text-[11px] text-slate-400 mb-2.5">聊天语音条 / 约会 / 电话用哪一家。上面三家的配置都会保留，这里只切换当前生效的。</p>
                    <div className="space-y-2">
                        {([
                            ['minimax', 'MiniMax', '国内可直连，默认推荐'],
                            ['fishaudio', '鱼声 Fish', '需科学上网（梯子 / 魔法），否则一直合成失败'],
                            ['elevenlabs', 'ElevenLabs', '多语言音色丰富；需可访问 ElevenLabs API'],
                        ] as const).map(([key, name, desc]) => {
                            const active = localTtsProvider === key;
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => selectTtsProvider(key)}
                                    className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${active ? 'border-primary bg-primary/5 shadow-sm' : 'border-slate-200 bg-white/70 active:bg-white'}`}
                                >
                                    <span className={`shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${active ? 'border-primary' : 'border-slate-300'}`}>
                                        {active && <span className="w-2 h-2 rounded-full bg-primary" />}
                                    </span>
                                    <span className="flex-1 min-w-0">
                                        <span className={`text-sm font-semibold ${active ? 'text-primary' : 'text-slate-700'}`}>{name}</span>
                                        <span className="block text-[11px] text-slate-400 mt-0.5">{desc}</span>
                                    </span>
                                    {active && <span className="text-[10px] font-bold text-primary shrink-0">使用中</span>}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* 语音提示词（高级）—— 自定义注入角色 system prompt 的「语音表演指南」，按服务商分别保存 */}
                <div className="group rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
                    <button
                        type="button"
                        onClick={() => setShowVoicePrompts(v => !v)}
                        className="w-full flex items-center justify-between text-left"
                    >
                        <span>
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">语音提示词（高级 · 可自定义）</span>
                            <span className="block text-[11px] text-slate-400 mt-0.5">教模型怎么写出有情绪、有停顿的语音台词（聊天 / 电话 / 见面三处）。留空则用内置默认。</span>
                        </span>
                        <span className={`shrink-0 ml-2 text-slate-400 transition-transform ${showVoicePrompts ? 'rotate-180' : ''}`}>▾</span>
                    </button>

                    {showVoicePrompts && (
                        <div className="mt-3 space-y-4">
                            <p className="text-[11px] text-amber-600 leading-relaxed pl-0.5">
                                ⚠️ 这是给模型的格式说明（停顿标记 / 情绪标签 / 动作词等），不是角色人设。改坏了可能导致语音标记解析失败——拿不准就点「清空」回到默认。改完记得点下面的「保存」。
                            </p>

                            {([
                                ['minimax', 'MiniMax 语音指南', localVoicePromptMinimax, setLocalVoicePromptMinimax, VOICE_ACTING_GUIDE, '聊天 + 电话 · MiniMax 引擎时生效'] as const,
                                ['fishaudio', '鱼声 Fish 语音指南', localVoicePromptFish, setLocalVoicePromptFish, FISH_VOICE_ACTING_GUIDE, '聊天 + 电话 · 鱼声引擎时生效'] as const,
                                ['elevenlabs', 'ElevenLabs 语音指南', localVoicePromptElevenLabs, setLocalVoicePromptElevenLabs, getElevenLabsVoiceActingGuide(localElevenLabsModel), '聊天 + 电话 · ElevenLabs 引擎时生效；默认模板随模型变化'] as const,
                                ['dateVoice', '见面（约会）语音情绪', localVoicePromptDate, setLocalVoicePromptDate, DATE_VOICE_GUIDE, '见面专用 [v:xxx] 规则 · 角色开了见面语音时生效，与引擎无关'] as const,
                            ]).map(([key, title, value, setValue, def, hint]) => {
                                const active = localTtsProvider === key;
                                const usingDefault = !value.trim();
                                return (
                                    <div key={key}>
                                        <div className="flex items-center justify-between mb-1 pl-0.5">
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                                {title}
                                                {active && <span className="ml-1.5 text-[9px] font-bold text-primary normal-case tracking-normal">· 当前引擎</span>}
                                            </label>
                                            <span className={`text-[10px] font-medium ${usingDefault ? 'text-slate-400' : 'text-primary'}`}>
                                                {usingDefault ? '使用内置默认' : '已自定义'}
                                            </span>
                                        </div>
                                        <p className="text-[10px] text-slate-400 mb-1.5 pl-0.5">{hint}</p>
                                        <textarea
                                            value={value}
                                            onChange={(e) => setValue(e.target.value)}
                                            placeholder="留空 → 使用内置默认。点下方「载入默认模板」可把内置文案填进来再改。"
                                            rows={6}
                                            spellCheck={false}
                                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-3 py-2.5 text-xs font-mono leading-relaxed focus:bg-white transition-all resize-y"
                                        />
                                        <div className="flex items-center justify-between mt-1.5 pl-0.5">
                                            <span className="text-[10px] text-slate-400">{value.length} 字</span>
                                            <span className="flex gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() => setValue(def)}
                                                    className="text-[11px] font-semibold text-slate-500 hover:text-primary active:scale-95 transition-all"
                                                >
                                                    载入默认模板
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setValue('')}
                                                    disabled={usingDefault}
                                                    className="text-[11px] font-semibold text-rose-500 hover:text-rose-600 active:scale-95 transition-all disabled:opacity-30 disabled:pointer-events-none"
                                                >
                                                    清空（恢复默认）
                                                </button>
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="group">
                    <div className="flex items-center justify-between mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">写歌 · Replicate Token (可选)</label>
                        <button
                            type="button"
                            onClick={() => setShowAceStepGuide(v => !v)}
                            className="text-[10px] font-semibold text-rose-500 hover:text-rose-600 active:scale-95 transition-all flex items-center gap-1"
                        >
                            {showAceStepGuide ? '收起' : '怎么拿？'}
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 transition-transform ${showAceStepGuide ? 'rotate-180' : ''}`}>
                                <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </div>
                    <input type="password" name="ace-step-api-token" autoComplete="new-password" spellCheck={false} value={localAceStepKey} onChange={(e) => setLocalAceStepKey(e.target.value)} placeholder="r8_xxx（写歌 App 调 ACE-Step 出整首歌用）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">填了之后，写歌 App 的歌词页可以一键调用 ACE-Step 生成真人声整首歌（约 ¥0.1/首）。生成时 Token、歌词与风格参数会通过网络 Worker 转发给 Replicate，项目不主动留存。</p>

                    {showAceStepGuide && (
                        <div className="mt-3 rounded-2xl overflow-hidden border border-rose-200/60 bg-gradient-to-br from-rose-50 via-orange-50 to-amber-50 shadow-sm animate-slide-down">
                            <div className="px-4 pt-3.5 pb-2 flex items-center gap-2 border-b border-rose-200/40">
                                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 text-white flex items-center justify-center text-base shadow-sm shadow-rose-500/30">🎤</div>
                                <div className="flex-1">
                                    <div className="text-[12px] font-bold text-stone-700">3 步搞定 Replicate Token</div>
                                    <div className="text-[10px] text-stone-500">让 ACE-Step 帮你把歌唱出来</div>
                                </div>
                            </div>
                            <div className="px-4 py-3 space-y-2.5">
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">1</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">注册 Replicate 账号</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">用 GitHub 一键登录最快。无需邮箱验证。</p>
                                        <a
                                            href="https://replicate.com/signin"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-rose-600 hover:text-rose-700 active:scale-95 transition-all px-2 py-1 rounded-lg bg-white/70 border border-rose-200/50"
                                        >
                                            打开注册页
                                        </a>
                                    </div>
                                </div>
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-orange-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">2</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">复制 API Token</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">登录后访问 Account → API Tokens，复制以 <span className="font-mono text-rose-600">r8_</span> 开头的那一串。</p>
                                        <a
                                            href="https://replicate.com/account/api-tokens"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-orange-600 hover:text-orange-700 active:scale-95 transition-all px-2 py-1 rounded-lg bg-white/70 border border-orange-200/50"
                                        >
                                            打开 Token 页
                                        </a>
                                    </div>
                                </div>
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-amber-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">3</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">绑卡充值（必须）</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">Replicate 没有免费试用额度，需先绑信用卡。<span className="text-rose-600 font-semibold">国内卡基本不行</span>，建议 Visa / MC 美区卡。最低充 $1（约 ¥7.3）≈ 50-100 首歌。</p>
                                    </div>
                                </div>
                                <div className="mt-2 pt-2.5 border-t border-rose-200/40 flex gap-2 items-start">
                                    <span className="text-rose-500 text-sm leading-none mt-0.5">💡</span>
                                    <p className="text-[11px] text-stone-500 leading-relaxed">
                                        粘贴到上面输入框 → 点保存配置 → 进写歌 App 打开任意一首歌的预览页 → 底部「AI 出歌」即可。
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <button onClick={handleSaveOtherApis} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-amber-500/20 bg-amber-500 active:scale-95 transition-all mt-2">
                    {otherStatusMsg || '保存其他 API'}
                </button>
            </div>
        </SettingsSection>

        {/* 实时感知配置区域 */}
        <SettingsSection
            title="实时感知"
            icon={
                <div className="p-2 bg-violet-100/50 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
                    </svg>
                </div>
            }
            actions={
                <button onClick={() => { trackEvent('打开实时感知配置'); setShowRealtimeModal(true); }} className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                    配置
                </button>
            }
        >
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                让AI角色感知真实世界：天气、新闻热点、当前时间。角色可以根据天气关心你、聊聊最近的热点话题。
            </p>

            <div className="grid grid-cols-5 gap-2 text-center">
                <div className={`py-3 rounded-xl text-xs font-bold ${rtWeatherEnabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtWeatherEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2600.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f32b.png" className="w-5 h-5 inline" alt="" />}</div>
                    天气
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtNewsEnabled ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtNewsEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4f0.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c4.png" className="w-5 h-5 inline" alt="" />}</div>
                    新闻
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtNotionEnabled ? 'bg-orange-50 text-orange-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtNotionEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4dd.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    Notion
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtFeishuEnabled ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtFeishuEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d2.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    飞书
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtXhsEnabled ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtXhsEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d5.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    小红书
                </div>
            </div>
        </SettingsSection>

        {/* 通用 MCP，独立于实时感知 */}
        <SettingsSection
            title="MCP"
            badge={<span className="text-[9px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded-full font-bold shrink-0">本机配置</span>}
            icon={
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <PlugsConnected size={16} weight="fill" />
                </div>
            }
            actions={
                <>
                    <button
                        onClick={() => { trackEvent('打开「MCP 是什么」说明弹窗'); setShowMcpHelp(true); }}
                        aria-label="MCP 是什么？"
                        className="w-7 h-7 rounded-full border border-slate-200 bg-white text-[12px] font-bold text-slate-400 active:scale-90 transition-all"
                    >?</button>
                    <button onClick={() => { trackEvent('打开MCP工具服务器配置'); setShowMcpModal(true); }} className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                        管理
                    </button>
                </>
            }
        >
            <p className="text-xs text-slate-500 leading-relaxed">
                连接标准 MCP 服务器，让聊天可以调用资料库、搜索、笔记或智能家居等工具。
            </p>
            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed border-l-2 border-violet-200 pl-2">
                需要自行准备 Streamable HTTP 服务；不配置不会影响内置 Sully、记忆或普通聊天。
            </p>
            {(() => {
                const list = loadMcpServers();
                if (!list.length) return null;
                const on = list.filter(s => s.enabled && s.tools?.length);
                const toolCount = on.reduce((n, s) => n + (s.tools?.length || 0), 0);
                return (
                    <p className="text-[10px] text-slate-400 mt-2">
                        已配置 {list.length} 个服务器 · {on.length} 个启用中{toolCount ? ` · 共 ${toolCount} 个工具` : ''}
                    </p>
                );
            })()}
        </SettingsSection>

        {/* ───────── 推送凭据 (VAPID) ───────── */}
        {/* VAPID 公私钥, 与 Proactive / Instant Push 共用一份 — 独立成块, 避免再被当成 */}
        {/* Instant Push 的子配置, 也避免两边 key 不一致互相抢同一个 pushManager 订阅. */}
        {/* vapidReadyTick: VAPID 弹窗关闭后 +1, 让本节点 re-render 重读 isPushVapidReady(). */}
        <SettingsSection
            title="推送凭据 (VAPID)"
            sectionProps={{ 'data-vapid-tick': vapidReadyTick }}
            icon={
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
                    </svg>
                </div>
            }
            actions={
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${isPushVapidReady() ? 'bg-violet-100 text-violet-600' : 'bg-rose-100 text-rose-600'}`}>
                    {isPushVapidReady() ? '已配置' : '未配置'}
                </span>
            }
        >
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                Proactive Push 和 Instant Push <b>共用同一份 VAPID 密钥对</b>。重新生成会让已开的推送失效，需要重新开启。
            </p>
            <button
                type="button"
                onClick={() => setShowVapidModal(true)}
                className={`w-full py-2.5 rounded-xl text-xs font-bold ${isPushVapidReady() ? 'bg-white text-violet-700 border border-violet-200 hover:bg-violet-50' : 'bg-violet-500 text-white hover:bg-violet-600 shadow-md shadow-violet-200'}`}
            >
                {isPushVapidReady() ? '查看 / 重新生成' : '生成 VAPID 密钥对 →'}
            </button>
        </SettingsSection>

        {/* ───────── 推送订阅状态（诊断 + 重置） ───────── */}
        <SettingsSection
            title="推送订阅状态"
            icon={
                <div className="p-2 bg-sky-100/60 rounded-xl text-sky-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z" />
                    </svg>
                </div>
            }
        >
            <PushSubscriptionPanel addToast={addToast} />
        </SettingsSection>

        {/* ───────── 主动消息 Push 加速器（开关） ───────── */}
        {SHOW_PROACTIVE_PUSH_ACCEL_UI && ppAvailable && (
        <SettingsSection
            title="主动消息 Push 加速"
            icon={
                <div className="p-2 bg-teal-100/60 rounded-xl text-teal-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
                    </svg>
                </div>
            }
            actions={
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${ppEnabled ? 'bg-teal-100 text-teal-600' : 'bg-slate-100 text-slate-400'}`}>
                    {ppEnabled ? '已启用' : '未启用'}
                </span>
            }
        >
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                让主动消息在浏览器后台标签里也能准点触发。AI 仍在本地生成，云端只管"到点喊醒浏览器"。
                浏览器进程被完全关闭时无法唤醒——下次打开 app 会自动补跑漏掉的主动消息，
                你看到的就是"开 app 即有"，不会半路弹窗打扰你。
            </p>

            {ppStatus && (
                <div className={`mb-3 p-3 rounded-xl text-xs font-medium text-center ${ppStatus.includes('成功') || ppStatus.includes('已启用') || ppStatus.includes('OK') ? 'bg-emerald-100 text-emerald-700' : ppStatus.includes('失败') || ppStatus.includes('错误') || ppStatus.includes('拒绝') ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                    {ppStatus}
                </div>
            )}

            <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2.5">
                <div>
                    <p className="text-[11px] text-slate-600 font-medium">启用 Push 加速</p>
                    <p className="text-[10px] text-slate-400">关闭则退回纯本地计时器</p>
                </div>
                <button
                    disabled={ppBusy}
                    onClick={() => {
                        if (ppBusy) return;
                        trackEvent('切换主动消息Push加速', { action: ppEnabled ? 'disable' : 'enable' });
                        if (ppEnabled) {
                            void doDisablePushAccelerator();
                        } else {
                            setShowPpConfirm(true);
                        }
                    }}
                    className={`w-10 h-5 rounded-full transition-colors ${ppEnabled ? 'bg-teal-500' : 'bg-slate-300'} ${ppBusy ? 'opacity-60' : ''}`}
                >
                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${ppEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
            </div>

            {/* ───── 诊断面板 ───── */}
            <div className="mt-4 bg-slate-50/70 rounded-2xl p-4 border border-slate-100">
                <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-slate-600">Web Push 状态</p>
                    <button
                        onClick={() => {
                            // 全部是浏览器/设备状态的固定枚举，不含端点地址、也不含任何用户配置值
                            trackEvent('刷新 Web Push 诊断', ppDiag ? {
                                permission: ppDiag.permission,
                                subscription: !ppDiag.endpoint ? 'none' : ppDiag.endpointDead ? 'dead' : 'active',
                                swState: ppDiag.swState === 'activated' ? 'activated' : ppDiag.swState === 'none' ? 'none' : 'other',
                                platform: ppDiag.capacitorNative ? 'capacitor_native' : ppDiag.iosNeedsPwa ? 'ios_needs_pwa' : 'normal',
                            } : undefined);
                            void refreshPpDiag();
                        }}
                        className="text-[10px] px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50"
                    >
                        刷新
                    </button>
                </div>

                {ppDiag ? (
                    <div className="space-y-1.5 text-[11px]">
                        <DiagRow
                            label="浏览器支持"
                            value={
                                ppDiag.capacitorNative ? '否（当前在 App 里运行）' :
                                ppDiag.supported ? '是' : '否（浏览器缺少推送相关 API）'
                            }
                            bad={!ppDiag.supported || ppDiag.capacitorNative}
                        />
                        <DiagRow
                            label="通知权限"
                            value={
                                ppDiag.permission === 'granted' ? '已授权' :
                                ppDiag.permission === 'denied' ? '已拒绝（请到浏览器站点设置手动开启）' :
                                ppDiag.permission === 'default' ? '未决定' :
                                '不可用'
                            }
                            bad={ppDiag.permission !== 'granted'}
                        />
                        <DiagRow
                            label="Service Worker"
                            value={
                                ppDiag.swState === 'activated' ? `已激活（scope: ${ppDiag.swScope || '?'}）` :
                                ppDiag.swState === 'none' ? '未注册' :
                                `${ppDiag.swState}（scope: ${ppDiag.swScope || '?'}）`
                            }
                            bad={ppDiag.swState !== 'activated'}
                        />
                        <DiagRow
                            label="订阅"
                            value={
                                !ppDiag.endpoint ? '不存在' :
                                ppDiag.endpointDead ? '已失效（zombie endpoint）' :
                                '已建立'
                            }
                            bad={!ppDiag.endpoint || ppDiag.endpointDead}
                        />
                        <DiagRow label="推送通道" value={ppDiag.channel} />
                        <DiagRow
                            label="最近一次唤醒"
                            value={
                                ppDiag.lastWakeAt
                                    ? `${new Date(ppDiag.lastWakeAt).toLocaleString()}${ppDiag.lastWakeChar ? `（${ppDiag.lastWakeChar}）` : ''}`
                                    : '从未'
                            }
                        />
                        {ppDiag.endpoint && (
                            <div className="pt-2 mt-2 border-t border-slate-200">
                                <p className="text-[10px] text-slate-400 mb-1">订阅端点（前 60 字符）</p>
                                <p className={`text-[10px] font-mono break-all leading-relaxed ${ppDiag.endpointDead ? 'text-rose-600' : 'text-slate-500'}`}>{ppDiag.endpoint.slice(0, 60)}…</p>
                            </div>
                        )}
                        {ppDiag.endpointDead && (
                            <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                                订阅地址是 <code className="font-mono">permanently-removed.invalid</code>——浏览器已经把这个订阅吊销了
                                （常见原因：长期不访问、通知权限切换过、浏览器清理过站点数据）。<br/>
                                这个域名是 RFC 保留 TLD，全球永远不会解析；Worker 试图把 push 投递过去就会回 HTTP 530。<br/>
                                点下方<b>"重置订阅"</b>会清掉这条死订阅并重建一个新的。
                            </div>
                        )}
                        {ppDiag.iosNeedsPwa && (
                            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                                检测到 iOS Safari，但当前不是已添加到主屏幕的 PWA。<br/>
                                iOS 的 Web Push 必须先把网站"添加到主屏幕"启动后才能用。
                            </div>
                        )}
                        {ppDiag.capacitorNative && (
                            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                                你现在是在<b>打包好的 App</b>里运行（不是浏览器网页）。<br/>
                                这个"Push 加速器"只对网页版生效——App 里没有网页推送通道，但<b>不影响你正常用</b>：
                                主动消息会通过 App 的本地通知发出，App 在后台/锁屏也能收到。<br/>
                                下面的"测试推送 / 重置订阅"按钮在 App 里点了也没用，可以直接忽略这个面板。
                            </div>
                        )}
                    </div>
                ) : (
                    <p className="text-[10px] text-slate-400">加载中…</p>
                )}

                {(() => {
                    const inDeepMode = ppZombieStreak >= 3;
                    const resetLabel = inDeepMode
                        ? (ppDeepResetBusy ? '深度重置中…' : '深度重置')
                        : (ppResetBusy ? '重置中…' : '重置订阅');
                    const resetBusy = ppResetBusy || ppDeepResetBusy;
                    return (
                        <div className="mt-4 grid grid-cols-2 gap-2">
                            <button
                                disabled={ppTestBusy || resetBusy || !ppDiag?.endpoint || ppDiag?.endpointDead || ppDiag?.capacitorNative}
                                onClick={() => void doSendTestPush()}
                                className={`py-2 rounded-xl text-xs font-bold ${ppTestBusy || resetBusy || !ppDiag?.endpoint || ppDiag?.endpointDead || ppDiag?.capacitorNative ? 'bg-slate-200 text-slate-400' : 'bg-teal-500 text-white hover:bg-teal-600'}`}
                            >
                                {ppTestBusy ? '测试中…' : '发一条测试推送'}
                            </button>
                            <button
                                disabled={resetBusy || ppTestBusy || ppDiag?.capacitorNative}
                                onClick={() => inDeepMode ? void doDeepResetSubscription() : void doResetSubscription()}
                                className={`py-2 rounded-xl text-xs font-bold border ${resetBusy || ppTestBusy || ppDiag?.capacitorNative ? 'bg-slate-100 text-slate-400 border-slate-200' : inDeepMode || ppDiag?.endpointDead ? 'bg-rose-500 text-white border-rose-500 hover:bg-rose-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                            >
                                {resetLabel}
                            </button>
                        </div>
                    );
                })()}
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                    "测试推送"会让 Worker 立刻给你这台设备发一条 push，5 秒内系统通知里出现"推送测试成功"= 链路通。
                    "重置订阅"会清掉旧订阅再建一个，适合订阅失效或换浏览器后用。
                    {ppZombieStreak >= 3 && <><br/>连续几次都没成，已切到"深度重置"——点一下做一次更彻底的清理。</>}
                </p>
            </div>
        </SettingsSection>
        )}

        {/* ───────── Instant Push ───────── */}
        <SettingsSection
            title="Instant Push"
            icon={
                <div className="p-2 bg-indigo-100/60 rounded-xl text-indigo-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.348 14.651a3.75 3.75 0 0 1 0-5.303m5.304 0a3.75 3.75 0 0 1 0 5.303m-7.425 2.122a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.808-3.808-9.98 0-13.789m13.788 0c3.808 3.808 3.808 9.981 0 13.789M12 12h.008v.008H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                    </svg>
                </div>
            }
            actions={
                <button
                    onClick={() => { trackEvent('打开Instant Push配置'); setShowInstantModal(true); }}
                    className="text-[10px] bg-indigo-100 text-indigo-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform"
                >
                    配置
                </button>
            }
        >
            <p className="text-xs text-slate-500 leading-relaxed">
                与上方 Push 加速器不同：前端发 prompt 到你自部署的 Worker，Worker 调你自己的 LLM 生成回复后分句逐条 Web Push。零数据库、零 cron。
            </p>
        </SettingsSection>

        {/* ───────── 主动消息 2.0（定时推送） ───────── */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">主动消息 2.0</h2>
                </div>
                <button
                    onClick={() => { trackEvent('打开主动消息2.0配置'); setShowAmsg2Modal(true); }}
                    className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform"
                >
                    配置
                </button>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
                角色到点自动给你发消息，App 关着也能收。需要你自己部署一个 Cloudflare Worker（自带 D1 数据库 + 定时触发），在配置里填地址即可。聊天上云（即时对话）与定时主动消息都由它承担。
            </p>
        </section>

        {/* 自定义网络代理 — 刻意低调的高级入口。默认折叠，不主动指引基本发现不了。
            普通用户无需配置：默认走作者部署的公共 Worker，所有功能开箱即用。 */}
        {!showProxyConfig ? (
            <button
                onClick={() => setShowProxyConfig(true)}
                className="w-full text-center text-[10px] text-slate-300 hover:text-slate-400 py-1 transition-colors"
            >
                · 自定义网络代理 ·
            </button>
        ) : (
            <section ref={proxyConfigSectionRef} className="scroll-mt-4 bg-white/60 rounded-2xl p-4 border border-slate-100">
                <div className="flex items-center justify-between mb-2">
                    <h2 className="text-xs font-semibold text-slate-500">自定义网络代理 (Worker)</h2>
                    <button onClick={() => { setShowProxyConfig(false); setProxyWorkerInput(getProxyWorkerUrl()); }} className="text-[10px] text-slate-400">收起</button>
                </div>

                <div className="text-[10px] text-slate-500 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-2 mb-3 leading-relaxed">
                    <b>一般无需修改这里。</b>默认地址负责静态网页环境中需要跨域转发的联网功能；
                    GitHub 备份仍默认直连，只有你在备份设置中主动开启中转后才会使用 Worker。
                    如果你部署了自己的 <b>worker/index.js</b>，可以在这里换成自己的实例。
                </div>

                <div className="mb-3 rounded-xl border border-sky-100 bg-sky-50/80 px-3 py-2.5 text-[10px] leading-relaxed text-sky-900">
                    <p className="mb-1.5 font-bold">部署自己的 Worker</p>
                    <ol className="space-y-1">
                        <li><b>1.</b> 在 Cloudflare 控制台进入 Workers &amp; Pages，新建一个 Worker。</li>
                        <li><b>2.</b> 打开并复制完整的 <a href={PROXY_WORKER_SOURCE_URL} target="_blank" rel="noreferrer" className="font-bold underline underline-offset-2">worker/index.js 源码</a>，替换编辑器里的默认代码，然后部署。</li>
                        <li><b>3.</b> 复制部署得到的 <b>https://xxx.workers.dev</b> 地址，粘贴到下方并保存。</li>
                    </ol>
                </div>

                <input
                    type="text"
                    value={proxyWorkerInput}
                    onChange={(e) => setProxyWorkerInput(e.target.value)}
                    placeholder={DEFAULT_PROXY_WORKER}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-200 mb-2"
                />

                <div className="grid grid-cols-2 gap-2">
                    <button onClick={handleResetProxyWorker} className="py-2 bg-slate-100 rounded-xl text-[11px] font-bold text-slate-500 active:scale-95 transition-transform">
                        恢复默认
                    </button>
                    <button onClick={handleSaveProxyWorker} className="py-2 bg-slate-700 rounded-xl text-[11px] font-bold text-white active:scale-95 transition-transform">
                        保存
                    </button>
                </div>

                <p className="text-[10px] text-slate-400 px-1 mt-2 leading-relaxed">
                    只填到域名（如 <b>{DEFAULT_PROXY_WORKER}</b>），不要带 /search、/webdav、/api 等路径。
                    联网搜索 / 备份代理 / Notion / 飞书 / 点单 / 网页抓取 / 出图 / 小红书 Lite / 音乐 都会切到这里填的 Worker。
                    （音乐播放器里还留了一个独立地址框，单独填了就以那个为准。）
                </p>
            </section>
        )}

        {/* ───────── 使用统计 ─────────
            只在配了统计环境变量的构建里显示。自部署实例本来就一个统计请求都不发，
            给个关不掉也没东西可关的开关只会更让人犯嘀咕。 */}
        {isAnalyticsConfigured() && (
        <SettingsSection
            title="使用统计"
            icon={
                <div className="p-2 bg-slate-100/60 rounded-xl text-slate-500">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
                    </svg>
                </div>
            }
        >
            <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-bold text-slate-600">参与使用统计</span>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input
                            type="checkbox"
                            checked={analyticsEnabled}
                            onChange={e => {
                                setAnalyticsEnabledState(e.target.checked);
                                setAnalyticsEnabled(e.target.checked);
                            }}
                            className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-slate-500"></div>
                    </label>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">
                    只数「哪个页面被打开了、哪个功能被用了一次」，记忆条数 / 角色数落在哪个区间，
                    以及你这台设备打开页面花了多久（浏览器自己测的毫秒数）。
                    不碰你和角色的任何对话、记忆、设定，不碰你输入的任何文字，不碰 API 和 MCP 配置。
                </p>
                <p className="text-xs text-slate-500 leading-relaxed">
                    SullyOS 的功能已经多到我们自己也扫不完，但「哪些真的有人用、大家配置时卡在哪一步」
                    基本靠猜。留着这个开关开着能帮我们看清这些，好把精力放在有人用的地方。
                    不想参与就关掉，功能一点不受影响。
                </p>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                    浏览器开了 Do Not Track 的话，不用动这个开关也会自动跳过。
                    关掉之后当场就不再发，下次启动连统计脚本都不会加载。想自己核实的话，按 F12 打开 Network 面板，
                    这个页面发出的每一个请求装了什么都在你自己的浏览器里。
                </p>
            </div>
        </SettingsSection>
        )}

        <VersionInfo />

      </div>

      {/* 主动消息 Push 加速 · 启用前确认 */}
      <Modal
          isOpen={showPpConfirm}
          title="启用 Push 加速？"
          onClose={() => setShowPpConfirm(false)}
          footer={
              <div className="flex gap-2 w-full">
                  <button
                      onClick={() => { trackEvent('在 Push 加速启用确认弹窗做出选择', { choice: 'cancel' }); setShowPpConfirm(false); }}
                      className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl"
                  >
                      取消
                  </button>
                  <button
                      onClick={() => {
                          trackEvent('在 Push 加速启用确认弹窗做出选择', { choice: 'confirm' });
                          setShowPpConfirm(false);
                          void doEnablePushAccelerator();
                      }}
                      className="flex-1 py-3 bg-teal-500 text-white font-bold rounded-2xl shadow-lg shadow-teal-200"
                  >
                      我知道了，启用
                  </button>
              </div>
          }
      >
          <div className="space-y-3 text-[12px] leading-relaxed text-slate-600">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="font-bold text-amber-800 mb-1">启用后会做三件事</p>
                  <ol className="list-decimal pl-4 space-y-1 text-amber-900">
                      <li>浏览器会弹 <b>"允许发送通知？"</b> 的系统对话框——请点"允许"，不然没法在后台唤醒</li>
                      <li>浏览器生成一个 <b>推送订阅凭证</b>（只是一个"门铃地址"，不含任何聊天内容），上传到 Cloudflare</li>
                      <li>开着本应用的标签页时，每 2 分钟给 Cloudflare 发一次心跳；关掉 5 分钟 Cloudflare 自动停止喊你</li>
                  </ol>
              </div>

              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                  <p className="font-bold text-emerald-800 mb-1">谁能看到什么</p>
                  <div className="space-y-1.5 text-emerald-900">
                      <p><b>Cloudflare 能看到：</b>推送订阅凭证 + 角色 ID（一串随机字符串）+ 间隔分钟数。<b>看不到</b>聊天内容、角色人设、AI 回复、API Key、你是谁。</p>
                      <p><b>浏览器厂商的推送服务（Google / Mozilla / Apple）：</b>知道你某时刻收到一条 push，内容是加密的，他们读不到。</p>
                      <p><b>你的 AI 接口供应商：</b>和平时聊天一样，到点时浏览器在<b>本地</b>直接调你在"API 配置"里填的那个接口，走你自己的 key。Cloudflare 完全不碰这一步。</p>
                  </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <p className="font-bold text-slate-700 mb-1">一句话</p>
                  <p className="text-slate-700">聊天记录和 AI 请求只在你自己和 AI 提供商之间，和现在没开 Push 加速时完全一样。Cloudflare 只是一个"到点按门铃"的闹钟。</p>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
                  <p className="font-bold text-blue-800 mb-1">不会主动弹通知打扰你</p>
                  <p className="text-blue-900">浏览器后台标签 → 静默触发，进 app 就看到。浏览器整个关掉 → 下次打开 app 自动补跑，开 app 即有。中间不弹"有人想找你"那种窗口扰你。</p>
              </div>
          </div>
      </Modal>

      {/* Cloud Config Modal */}
      <Modal isOpen={showCloudModal} title="云端备份配置" onClose={() => setShowCloudModal(false)}>
          <div className="space-y-4 p-1">
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3">
                  <p className="text-[10px] text-rose-700 leading-relaxed">
                      <b>🪜 需要梯子</b><br/>
                      InfiniCloud 是日本的服务，国内直连通常打不开注册页、也无法同步备份。<b>注册和之后每次同步都需要保持梯子开启</b>，否则会连接失败或超时。
                  </p>
              </div>
              <div className="bg-sky-50 rounded-xl p-3">
                  <p className="text-[10px] text-sky-700 leading-relaxed">
                      <b>快速上手 (InfiniCloud, 免费 20GB):</b><br/>
                      1. 注册 <a href="https://infini-cloud.net/" target="_blank" rel="noopener noreferrer" className="text-sky-600 underline font-bold hover:text-sky-800">infini-cloud.net ↗</a>（邮箱验证）<br/>
                      2. 登录后 <b>My Page</b> 最底 → 勾选 <b>Turn on Apps Connection</b><br/>
                      3. 顶栏 <b>Apps</b> → 复制 <b>WebDAV URL</b> / <b>Connection ID</b> / <b>Apps Password</b><br/>
                      4. 用户名填 <b>Connection ID</b>（不是邮箱），密码填 <b>Apps Password</b>
                  </p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="text-[10px] text-amber-800 leading-relaxed">
                      <b>⚠️ Apps Password ≠ 登录密码</b><br/>
                      <b>Apps Password</b> 是 <b>Apps</b> 页面里显示在 <b>WebDAV URL</b>、<b>Connection ID</b> <b>下方</b>的一串<b>可复制</b>的应用专用密码，往下滚就能看到。直接把它复制粘贴到上面的"密码"框即可，用账号登录密码会 401。
                  </p>
              </div>
              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">WebDAV 地址</label>
                  <input type="url" value={cbUrl} onChange={(e) => setCbUrl(e.target.value)} placeholder="https://xxx.infini-cloud.net/dav/" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                  <div>
                      <label className="text-[11px] text-slate-500 font-medium mb-1 block">用户名</label>
                      <input type="text" value={cbUsername} onChange={(e) => setCbUsername(e.target.value)} placeholder="邮箱或用户名" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
                  </div>
                  <div>
                      <label className="text-[11px] text-slate-500 font-medium mb-1 block">密码</label>
                      <input type="password" value={cbPassword} onChange={(e) => setCbPassword(e.target.value)} placeholder="应用专用密码" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
                  </div>
              </div>
              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">备份目录</label>
                  <input type="text" value={cbPath} onChange={(e) => setCbPath(e.target.value)} placeholder="/SullyBackup/" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
              </div>
              <button onClick={handleTestCloudConnection} disabled={cloudTesting || !cbUrl || !cbUsername || !cbPassword} className="w-full py-2.5 bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 disabled:opacity-40">
                  {cloudTesting ? '测试中...' : '测试连接'}
              </button>
              {cloudTestResult && (
                  <p className={`text-[11px] text-center font-medium ${cloudTestResult.startsWith('✓') ? 'text-green-600' : 'text-red-500'}`}>{cloudTestResult}</p>
              )}
              <div className="grid grid-cols-2 gap-3 pt-2">
                  <button onClick={() => setShowCloudModal(false)} className="py-2.5 bg-slate-100 rounded-xl text-xs font-bold text-slate-500">取消</button>
                  <button onClick={handleSaveCloudConfig} disabled={!cbUrl || !cbUsername || !cbPassword} className="py-2.5 bg-sky-500 rounded-xl text-xs font-bold text-white disabled:opacity-40">保存配置</button>
              </div>
              {cloudBackupConfig.enabled && (
                  <button onClick={() => { trackEvent('关闭云端备份', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav' }); updateCloudBackupConfig({ enabled: false }); setShowCloudModal(false); addToast('云端备份已关闭', 'info'); }} className="w-full py-2 text-[11px] text-red-400 font-medium">关闭云端备份</button>
              )}
          </div>
      </Modal>

      {/* GitHub Backup Modal — minimum-input flow: paste a token, we figure
          out owner via /user and auto-create a private 'sully-backup' repo. */}
      <Modal isOpen={showGithubModal} title="GitHub 备份" onClose={() => setShowGithubModal(false)}>
          <div className="space-y-4 p-1">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
                  <p className="text-[11px] text-slate-700 leading-relaxed">
                      <b>三步连接 GitHub：</b><br/>
                      ① 点下面按钮跳到 GitHub 创建 Token<br/>
                      ② 复制 token，回来粘到下面框里<br/>
                      ③ 点 <b>测试并连接</b> — 我们会自动帮你建好私有仓库 <code className="bg-white px-1 rounded">{ghRepo || 'sully-backup'}</code>
                  </p>
                  <p className="text-[10px] text-slate-500 leading-relaxed border-t border-slate-200 pt-2">
                      <b>连接成功不等于上传一定能通。</b> GitHub 网页、账号接口和 ZIP 附件上传分别使用
                      <code className="mx-0.5 bg-white px-1 rounded">github.com</code>、
                      <code className="mx-0.5 bg-white px-1 rounded">api.github.com</code>、
                      <code className="mx-0.5 bg-white px-1 rounded">uploads.github.com</code>。
                      不同网络、梯子分流和 iOS PWA 可能只接管其中一部分，所以会出现“网页能进但上传失败”或“开着梯子反而不通”。
                  </p>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="text-[10px] text-amber-800 leading-relaxed">
                      <b>⚠️ 在 GitHub 那一页只改一处:</b><br/>
                      把 <b>Expiration</b>(有效期)下拉框 <b>从 90天 改成 No expiration</b>（永不过期）。
                      不改的话 90 天后 token 过期，备份会突然 401。<br/>
                      其它都别动 —— Note 已经填好「Sully 备份」，<b>repo</b> 权限已经勾上了，
                      直接拉到最底点绿色 <b>Generate token</b> 即可。
                  </p>
              </div>

              <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=Sully%20%E5%A4%87%E4%BB%BD"
                  target="_blank" rel="noopener noreferrer"
                  onClick={() => trackEvent('跳去 GitHub 创建 Token')}
                  className="block w-full py-3 bg-gradient-to-br from-slate-800 to-slate-900 text-white rounded-xl text-xs font-bold text-center shadow-sm active:scale-95 transition-all"
              >
                  ① 去 GitHub 创建 Token ↗
              </a>

              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">② Personal Access Token</label>
                  <input
                      type="password"
                      value={ghToken}
                      onChange={(e) => setGhToken(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 font-mono focus:border-slate-500 focus:ring-1 focus:ring-slate-300 outline-none"
                  />
                  <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                      Token 保存在本机配置中。GitHub 默认直连；如果附件域名不通，可在下方高级选项开启应用内中转。
                      仅在你手动开启后，Token 才会随 GitHub 请求经过所选 Worker，项目不会主动留存。
                  </p>
              </div>

              <button
                  onClick={handleTestGithub}
                  disabled={ghTesting || !ghToken.trim()}
                  className="w-full py-3 bg-gradient-to-r from-emerald-500 to-green-600 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all disabled:opacity-40"
              >
                  {ghTesting ? '连接中...' : '③ 测试并连接'}
              </button>
              {ghTestResult && (
                  <p className={`text-[11px] text-center font-medium ${ghTestResult.startsWith('✓') ? 'text-green-600' : 'text-red-500'}`}>
                      {ghTestResult}
                  </p>
              )}
              {ghTestResult.startsWith('✓') && cloudBackupConfig.githubOwner && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-1.5">
                      <p className="text-[11px] text-emerald-800 font-medium">
                          🎉 备份会上传到这里:
                      </p>
                      <a
                          href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                          target="_blank" rel="noopener noreferrer"
                          className="block text-[10px] text-emerald-700 font-mono break-all underline hover:text-emerald-900"
                      >
                          github.com/{cloudBackupConfig.githubOwner}/{cloudBackupConfig.githubRepo || 'sully-backup'}/releases ↗
                      </a>
                      <p className="text-[10px] text-emerald-700 leading-relaxed">
                          每次备份会创建一个新的 release（带时间戳）。想看 / 删除旧备份就去这个网址。
                      </p>
                  </div>
              )}

              <button
                  onClick={() => { if (!ghShowAdvanced) trackEvent('展开 GitHub 高级选项'); setGhShowAdvanced(v => !v); }}
                  className="w-full text-[10px] text-slate-400 underline-offset-2 hover:underline"
              >
                  {ghShowAdvanced ? '收起高级选项 ▲' : '高级选项 ▼'}
              </button>
              {ghShowAdvanced && (
                  <div className="space-y-3 bg-slate-50 rounded-xl p-3">
                      <div>
                          <label className="text-[11px] text-slate-500 font-medium mb-1 block">备份仓库名</label>
                          <input
                              type="text"
                              value={ghRepo}
                              onChange={(e) => setGhRepo(e.target.value)}
                              placeholder="sully-backup"
                              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 font-mono focus:border-slate-500 outline-none"
                          />
                          <p className="text-[10px] text-slate-400 mt-1">不存在会自动创建为私有仓库。</p>
                      </div>
                      <label className="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer">
                          <input
                              type="checkbox"
                              checked={ghUseProxy}
                              onChange={(e) => handleGithubProxyToggle(e.target.checked)}
                              className="rounded"
                          />
                          <span>应用内 Cloudflare 中转（与手机 / 电脑的梯子是两回事）</span>
                      </label>
                      <p className="text-[10px] text-slate-500 leading-relaxed pl-5">
                          <b>{ghUseProxy ? '当前线路：浏览器 → Cloudflare Worker → GitHub。' : '当前线路：浏览器 → GitHub 直连。'}</b>
                          勾选状态会立即保存，不必重新连接。系统梯子可能因规则分流、节点或 PWA 未接管而漏掉
                          <code className="mx-0.5 bg-white px-1 rounded">uploads.github.com</code>；应用内中转是另一条独立线路，也可能被某些网络拦截。
                      </p>
                      <p className="text-[10px] text-slate-400 leading-relaxed pl-5">
                          中转只负责转发，备份仍存放在你的 GitHub 私有仓库；项目不建立备份数据库，也不主动留存 Token 或备份文件。
                          大于 32MB 时会自动分片，并在全部完成后发布。
                      </p>
                  </div>
              )}

              <div className="grid grid-cols-2 gap-3 pt-2">
                  <button onClick={() => setShowGithubModal(false)} className="py-2.5 bg-slate-100 rounded-xl text-xs font-bold text-slate-500">关闭</button>
                  {cloudBackupConfig.enabled && cloudBackupConfig.provider === 'github' ? (
                      <button onClick={handleDisableCloud} className="py-2.5 bg-red-50 text-red-500 rounded-xl text-xs font-bold">断开 GitHub</button>
                  ) : (
                      <button
                          onClick={() => setShowGithubModal(false)}
                          disabled={!cloudBackupConfig.enabled || cloudBackupConfig.provider !== 'github'}
                          className="py-2.5 bg-slate-800 text-white rounded-xl text-xs font-bold disabled:opacity-30"
                      >
                          完成
                      </button>
                  )}
              </div>
          </div>
      </Modal>

      {/* Cloud Restore Modal */}
      <Modal isOpen={showCloudRestoreModal} title="从云端恢复" onClose={() => setShowCloudRestoreModal(false)}>
          <div className="space-y-2 p-1">
              {cloudBackupListState === 'loading' ? (
                  <div className="text-center py-8"><p className="text-[11px] text-slate-400">正在加载云端备份列表...</p></div>
              ) : cloudBackupListState === 'error' ? (
                  <div className="text-center py-7 px-3 space-y-3">
                      <p className="text-[11px] text-red-500 leading-relaxed">{cloudBackupListError || '获取云端备份列表失败'}</p>
                      <button onClick={handleOpenCloudRestore} className="px-4 py-2 rounded-xl bg-slate-800 text-white text-[11px] font-bold">重新加载</button>
                  </div>
              ) : cloudBackupListState === 'ready' && cloudBackupFiles.length === 0 ? (
                  <div className="text-center py-8"><p className="text-[11px] text-slate-400">云端还没有备份</p></div>
              ) : (
                  <>
                      <p className="text-[10px] text-slate-400 mb-2">选择要恢复的备份文件:</p>
                      <div className="max-h-[50vh] overflow-y-auto space-y-2">
                          {cloudBackupFiles.map((file, i) => file.status === 'incomplete' ? (
                              <div key={file.href || i} className="w-full p-3 bg-amber-50/70 border border-amber-200 rounded-xl text-left">
                                  <div className="flex items-start justify-between gap-2">
                                      <p className="text-[11px] text-slate-700 font-medium truncate">{file.name}</p>
                                      <span className="shrink-0 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[9px] font-bold">上传未完成</span>
                                  </div>
                                  <p className="text-[10px] text-amber-700 mt-1 leading-relaxed">{file.statusMessage || '附件不完整，不能恢复'}</p>
                                  <div className="flex items-center justify-between gap-3 mt-2">
                                      <span className="text-[10px] text-slate-400">{file.lastModified ? new Date(file.lastModified).toLocaleString('zh-CN') : '未知时间'}</span>
                                      {cloudBackupConfig.provider === 'github' && cloudBackupConfig.githubOwner && (
                                          <a
                                              href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-[10px] text-amber-700 font-semibold hover:underline"
                                          >去 GitHub 查看 ↗</a>
                                      )}
                                  </div>
                              </div>
                          ) : (
                              <button key={file.href || i} onClick={() => handleCloudRestore(file)} className="w-full p-3 bg-white border border-slate-200 rounded-xl text-left hover:bg-sky-50 hover:border-sky-200 transition-colors active:scale-[0.98]">
                                  <p className="text-[11px] text-slate-700 font-medium truncate">{file.name}</p>
                                  <div className="flex items-center gap-3 mt-1">
                                      <span className="text-[10px] text-slate-400">{file.lastModified ? new Date(file.lastModified).toLocaleString('zh-CN') : '未知时间'}</span>
                                      <span className="text-[10px] text-slate-400">{file.size > 0 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : ''}</span>
                                  </div>
                              </button>
                          ))}
                      </div>
                  </>
              )}
          </div>
      </Modal>

      {/* 模型选择 Modal */}
      <Modal isOpen={showModelModal} title="选择模型" onClose={() => setShowModelModal(false)}>
        {(() => {
            const { filtered, commonPrefix } = modelPickerView;
            return (
                <div className="space-y-3 p-1">
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={localModel}
                            onChange={(e) => setLocalModel(e.target.value)}
                            placeholder="手动输入模型名称..."
                            className="flex-1 bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary focus:bg-white transition-all"
                        />
                        <button
                            onClick={() => setShowModelModal(false)}
                            className="px-4 py-2.5 bg-primary text-white text-sm font-bold rounded-xl active:scale-95 transition-all"
                        >
                            确定
                        </button>
                    </div>
                    {availableModels.length > 0 && (
                        <div className="relative">
                            <input
                                type="text"
                                value={modelFilter}
                                onChange={(e) => setModelFilter(e.target.value)}
                                placeholder={`🔍 搜索 ${availableModels.length} 个模型...`}
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs focus:outline-primary focus:bg-white transition-all"
                            />
                            {modelFilter && (
                                <button
                                    onClick={() => setModelFilter('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs px-2"
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    )}
                    {commonPrefix && (
                        <div className="text-[10px] text-slate-400 px-1 flex items-center gap-1 flex-wrap">
                            <span>共同前缀:</span>
                            <code className="font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded break-all">{commonPrefix}</code>
                            <span className="text-slate-300">(下方已弱化显示)</span>
                        </div>
                    )}
                    <div className="max-h-[40vh] overflow-y-auto no-scrollbar space-y-2">
                        {filtered.length > 0 ? filtered.map(m => {
                            const suffix = commonPrefix && m.startsWith(commonPrefix) ? m.slice(commonPrefix.length) : m;
                            const selected = m === localModel;
                            return (
                                <button
                                    key={m}
                                    onClick={() => { setLocalModel(m); setShowModelModal(false); }}
                                    title={m}
                                    className={`w-full text-left px-4 py-3 rounded-xl text-sm font-mono flex justify-between items-start gap-2 ${selected ? 'bg-primary/10 text-primary font-bold ring-1 ring-primary/20' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                                >
                                    <span className="break-all min-w-0 flex-1 leading-relaxed">
                                        {commonPrefix && suffix !== m && (
                                            <span className={selected ? 'text-primary/40 font-normal' : 'text-slate-400 font-normal'}>{commonPrefix}</span>
                                        )}
                                        <span>{suffix}</span>
                                    </span>
                                    {selected && <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0"></div>}
                                </button>
                            );
                        }) : (
                            <div className="text-center text-slate-400 py-8 text-xs">
                                {availableModels.length === 0
                                    ? '列表为空，可手动输入或点击"刷新模型列表"拉取'
                                    : `没有匹配 "${modelFilter}" 的模型`}
                            </div>
                        )}
                    </div>
                </div>
            );
        })()}
      </Modal>

      {/* 识图 API 使用独立模型列表，避免覆盖主 API 的模型选择。 */}
      <Modal isOpen={showVisionModelModal} title="选择识图模型" onClose={() => setShowVisionModelModal(false)}>
        {(() => {
            const { filtered, commonPrefix } = visionModelPickerView;
            return (
                <div className="space-y-3 p-1">
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={localVisionModel}
                            onChange={(event) => {
                                setLocalVisionModel(event.target.value);
                                setSelectedVisionPresetId(null);
                                setVisionTestResult(null);
                            }}
                            placeholder="手动输入视觉模型名称..."
                            className="flex-1 min-w-0 bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-violet-500 focus:bg-white transition-all"
                        />
                        <button
                            onClick={() => setShowVisionModelModal(false)}
                            className="px-4 py-2.5 bg-violet-500 text-white text-sm font-bold rounded-xl active:scale-95 transition-all"
                        >
                            确定
                        </button>
                    </div>
                    {availableVisionModels.length > 0 && (
                        <div className="relative">
                            <input
                                type="text"
                                value={visionModelFilter}
                                onChange={(event) => setVisionModelFilter(event.target.value)}
                                placeholder={`🔍 搜索 ${availableVisionModels.length} 个识图模型...`}
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs focus:outline-violet-500 focus:bg-white transition-all"
                            />
                            {visionModelFilter && (
                                <button
                                    onClick={() => setVisionModelFilter('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs px-2"
                                >×</button>
                            )}
                        </div>
                    )}
                    {commonPrefix && (
                        <div className="text-[10px] text-slate-400 px-1 flex items-center gap-1 flex-wrap">
                            <span>共同前缀:</span>
                            <code className="font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded break-all">{commonPrefix}</code>
                            <span className="text-slate-300">(下方已弱化显示)</span>
                        </div>
                    )}
                    <div className="max-h-[40vh] overflow-y-auto no-scrollbar space-y-2">
                        {filtered.length > 0 ? filtered.map(model => {
                            const suffix = commonPrefix && model.startsWith(commonPrefix) ? model.slice(commonPrefix.length) : model;
                            const selected = model === localVisionModel;
                            return (
                                <button
                                    key={model}
                                    onClick={() => {
                                        setLocalVisionModel(model);
                                        setSelectedVisionPresetId(null);
                                        setVisionTestResult(null);
                                        setShowVisionModelModal(false);
                                    }}
                                    title={model}
                                    className={`w-full text-left px-4 py-3 rounded-xl text-sm font-mono flex justify-between items-start gap-2 ${selected ? 'bg-violet-100 text-violet-700 font-bold ring-1 ring-violet-200' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                                >
                                    <span className="break-all min-w-0 flex-1 leading-relaxed">
                                        {commonPrefix && suffix !== model && (
                                            <span className={selected ? 'text-violet-400 font-normal' : 'text-slate-400 font-normal'}>{commonPrefix}</span>
                                        )}
                                        <span>{suffix}</span>
                                    </span>
                                    {selected && <div className="w-2 h-2 rounded-full bg-violet-500 mt-1.5 shrink-0" />}
                                </button>
                            );
                        }) : (
                            <div className="text-center text-slate-400 py-8 text-xs">
                                {availableVisionModels.length === 0
                                    ? '列表为空，可手动输入或点击“刷新模型列表”拉取'
                                    : `没有匹配 "${visionModelFilter}" 的模型`}
                            </div>
                        )}
                    </div>
                </div>
            );
        })()}
      </Modal>

      {/* API 调用记录页面 */}
      <ApiCallLogModal isOpen={showApiCallLog} onClose={() => setShowApiCallLog(false)} />

      {/* Preset Name Modal */}
      <Modal isOpen={showPresetModal} title="新建预设" onClose={() => setShowPresetModal(false)} footer={<button onClick={handleSavePreset} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">新建</button>}>
          <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase">预设名称 (例如: DeepSeek)</label>
              <input value={newPresetName} onChange={e => setNewPresetName(e.target.value)} className="w-full bg-slate-100 rounded-xl px-4 py-3 text-sm focus:outline-primary" autoFocus placeholder="Name..." />
              <p className="text-[10px] text-slate-400 leading-relaxed pt-1">会保存上面表单里的 URL / Key / Model，以及高级设置中的流式与温度。</p>
          </div>
      </Modal>

      {/* 编辑预设：只改这条预设本身；正在用它的话，当前配置一并跟着走 */}
      <Modal
          isOpen={!!editingPresetId}
          title="编辑预设"
          onClose={() => setEditingPresetId(null)}
          footer={<button onClick={handleUpdatePreset} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">保存</button>}
      >
          <div className="space-y-3">
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">名称</label>
                  <input value={editPresetName} onChange={e => setEditPresetName(e.target.value)} placeholder="预设名称" className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm focus:outline-primary" />
              </div>
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">URL</label>
                  <input value={editPresetUrl} onChange={e => setEditPresetUrl(e.target.value)} placeholder="https://..." className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary" />
              </div>
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Key</label>
                  <input type="password" value={editPresetKey} onChange={e => setEditPresetKey(e.target.value)} placeholder="sk-..." className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary" />
              </div>
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                  <input value={editPresetModel} onChange={e => setEditPresetModel(e.target.value)} placeholder="模型名称" className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary" />
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                      <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">流式输出 (Stream)</p>
                          <p className="text-[9px] text-slate-300 mt-0.5">随这条预设独立保存</p>
                      </div>
                      <button
                          type="button"
                          aria-label="预设流式输出"
                          aria-pressed={editPresetStream}
                          onClick={() => setEditPresetStream(value => !value)}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${editPresetStream ? 'bg-primary' : 'bg-slate-200'}`}
                      >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${editPresetStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                  </div>
                  <div>
                      <div className="flex items-center justify-between">
                          <label htmlFor="edit-preset-temperature" className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">温度 (Temperature)</label>
                          <span className="text-[10px] font-mono text-slate-400">{editPresetTemperature.toFixed(2)}</span>
                      </div>
                      <input
                          id="edit-preset-temperature"
                          type="range"
                          min="0"
                          max="2"
                          step="0.05"
                          value={editPresetTemperature}
                          onChange={event => setEditPresetTemperature(parseFloat(event.target.value))}
                          className="w-full accent-primary mt-1"
                      />
                  </div>
              </div>
              <button
                  type="button"
                  onClick={() => {
                      setEditPresetUrl(localUrl);
                      setEditPresetKey(localKey);
                      setEditPresetModel(localModel);
                      setEditPresetStream(localStream);
                      setEditPresetTemperature(localTemperature);
                      addToast('已填入当前配置', 'info');
                  }}
                  className="w-full py-2 bg-slate-100 text-slate-500 text-xs font-bold rounded-xl active:scale-95 transition-transform"
              >
                  用当前完整配置填入
              </button>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                  {editingPresetId && activePresetId === editingPresetId
                      ? '这条正在使用中，保存后当前配置会一起换成新的值。'
                      : '只改这条预设，当前生效的配置不受影响。'}
              </p>
          </div>
      </Modal>

      {/* 强制导出 Modal */}
      <Modal isOpen={showExportModal} title="备份下载" onClose={() => { revokeDownloadUrl(); setShowExportModal(false); }} footer={
          <div className="flex gap-2 w-full">
               <button onClick={() => { revokeDownloadUrl(); setShowExportModal(false); }} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">关闭</button>
          </div>
      }>
          <div className="space-y-4 text-center py-4">
              <div className="w-16 h-16 bg-green-100 text-green-500 rounded-full flex items-center justify-center mx-auto mb-2">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
              </div>
              <p className="text-sm font-bold text-slate-700">备份文件已生成！</p>
              <p className="text-xs text-slate-500">如果浏览器没有自动下载，请点击下方链接。</p>
              {downloadUrl && <a href={downloadUrl} download={downloadFileName} className="text-primary text-sm underline block py-2">点击手动下载 .zip</a>}
          </div>
      </Modal>

      {/* 实时感知配置 Modal */}
      <Modal
          isOpen={showRealtimeModal}
          title="实时感知配置"
          onClose={() => setShowRealtimeModal(false)}
          footer={<button onClick={handleSaveRealtimeConfig} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg">保存配置</button>}
      >
          <div className="space-y-5 max-h-[60vh] overflow-y-auto no-scrollbar">
              {/* 天气配置 */}
              <div className="bg-emerald-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Sun size={20} weight="fill" />
                          <span className="text-sm font-bold text-emerald-700">天气感知</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtWeatherEnabled} onChange={e => setRtWeatherEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                      </label>
                  </div>
                  {rtWeatherEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">OpenWeatherMap API Key（可选）</label>
                              <input type="password" value={rtWeatherKey} onChange={e => setRtWeatherKey(e.target.value)} className="w-full bg-white/80 border border-emerald-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="留空则用免费的 Open-Meteo，无需注册" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">城市</label>
                              <input type="text" value={rtWeatherCity} onChange={e => setRtWeatherCity(e.target.value)} className="w-full bg-white/80 border border-emerald-200 rounded-xl px-3 py-2 text-sm" placeholder="北京 / Beijing / Shanghai" />
                          </div>
                          <button onClick={testWeatherApi} className="w-full py-2 bg-emerald-100 text-emerald-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试天气API</button>
                      </div>
                  )}
              </div>

              {/* 新闻配置 */}
              <div className="bg-blue-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Newspaper size={20} weight="fill" />
                          <span className="text-sm font-bold text-blue-700">新闻热点</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtNewsEnabled} onChange={e => setRtNewsEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                      </label>
                  </div>
                  {rtNewsEnabled && (
                      <div className="space-y-2">
                          <p className="text-xs text-blue-600/70">默认主源：中文多平台热榜（免鉴权，聊天时角色会自动捕捉热点）。选择要关注的平台：</p>
                          <div className="flex flex-wrap gap-1.5">
                              {HOTNEWS_PLATFORM_OPTIONS.map(p => {
                                  const active = rtNewsPlatforms.includes(p.key);
                                  return (
                                      <button
                                          key={p.key}
                                          type="button"
                                          onClick={() => setRtNewsPlatforms(prev => prev.includes(p.key) ? prev.filter(k => k !== p.key) : [...prev, p.key])}
                                          className={`text-[11px] px-2.5 py-1 rounded-full font-bold transition-colors active:scale-95 ${active ? 'bg-blue-500 text-white shadow-sm' : 'bg-white/80 text-slate-500 border border-blue-200'}`}
                                      >
                                          {p.label}
                                      </button>
                                  );
                              })}
                          </div>
                          {rtNewsPlatforms.length === 0 && (
                              <p className="text-[10px] text-rose-500/80">未选任何平台时会回落到 Brave / Hacker News。</p>
                          )}
                          <details className="border-t border-blue-200/50 pt-2 mt-1 group">
                              <summary className="text-[10px] font-bold text-slate-400 uppercase cursor-pointer select-none list-none flex items-center gap-1.5">
                                  <span className="transition-transform group-open:rotate-90">›</span>
                                  Brave Search（回落源 · <span className="text-rose-400">不建议配置</span>）
                              </summary>
                              <div className="mt-2 space-y-1.5">
                                  <p className="text-[10px] text-slate-400/90 leading-relaxed">
                                      上面的中文热榜在国内场景比 Brave 好用一万倍，<b className="text-slate-500">基本不需要配这个</b>。
                                      它只是热榜彻底拉不到时的英文回落，配了反而可能盖掉中文热点。除非你清楚自己在做什么，否则留空即可。
                                  </p>
                                  <input type="password" value={rtNewsApiKey} onChange={e => setRtNewsApiKey(e.target.value)} className="w-full bg-white/60 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-slate-500" placeholder="（不建议）brave.com/search/api" />
                                  <p className="text-[10px] text-slate-400/70">仅当中文热榜拉取失败时才启用；都不可用时再兜底 Hacker News（英文）。</p>
                              </div>
                          </details>
                      </div>
                  )}
              </div>

              {/* Firecrawl 网页读取：方舟计划默认隐藏，代码与降级能力保留。 */}
              {SHOW_FIRECRAWL_ARK_UI && (
              <div className="bg-amber-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                          <PlugsConnected size={20} weight="fill" className="text-amber-600 shrink-0" />
                          <div className="min-w-0">
                              <span className="text-sm font-bold text-amber-800">Firecrawl 网页读取</span>
                              <p className="text-[10px] text-amber-700/60">网页分享抓取增强 · 可选</p>
                          </div>
                      </div>
                      <a
                          href={FIRECRAWL_API_KEYS_URL}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-[10px] bg-white border border-amber-200 text-amber-700 px-2.5 py-1.5 rounded-full font-bold"
                      >
                          前往免费注册 ↗
                      </a>
                  </div>

                  <p className="text-[10px] text-amber-800/70 leading-relaxed">
                      聊天里粘贴普通网页时，原有提取失败后会自动用 Firecrawl 读取动态页面；再失败仍会回落 Jina 与 Worker，不会因额度耗尽让分享失效。免费计划目前每月约 1,000 页。
                  </p>

                  {!firecrawlKeyInput.trim() && (
                      <ol className="rounded-xl border border-amber-200/80 bg-white/70 px-3 py-2 text-[10px] text-amber-900/75 leading-relaxed space-y-1">
                          <li><b>1.</b> 点击“前往免费注册”，在 Firecrawl 注册或登录。</li>
                          <li><b>2.</b> 进入 API Keys，创建并复制一个以 <b>fc-</b> 开头的 Key。</li>
                          <li><b>3.</b> 回到这里粘贴，点击“保存并检查额度”。</li>
                      </ol>
                  )}

                  <input
                      type="password"
                      value={firecrawlKeyInput}
                      onChange={e => {
                          setFirecrawlKeyInput(e.target.value);
                          setFirecrawlCheckResult(null);
                          setFirecrawlUsage(null);
                      }}
                      className="w-full bg-white/90 border border-amber-200 rounded-xl px-3 py-2 text-sm font-mono"
                      placeholder="fc-..."
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                  />

                  <div className="grid grid-cols-2 gap-2">
                      <button
                          type="button"
                          onClick={handleClearFirecrawl}
                          disabled={firecrawlChecking || !firecrawlKeyInput}
                          className="py-2 bg-white/80 border border-amber-200 text-amber-700 text-xs font-bold rounded-xl disabled:opacity-40 active:scale-95 transition-transform"
                      >
                          清除
                      </button>
                      <button
                          type="button"
                          onClick={() => void handleCheckFirecrawl()}
                          disabled={firecrawlChecking}
                          className="py-2 bg-amber-500 text-white text-xs font-bold rounded-xl disabled:opacity-50 active:scale-95 transition-transform"
                      >
                          {firecrawlChecking ? '检查中…' : '保存并检查额度'}
                      </button>
                  </div>

                  {firecrawlUsage && (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[10px] text-emerald-800 leading-relaxed">
                          <b>剩余 {firecrawlUsage.remainingCredits.toLocaleString()} / {firecrawlUsage.planCredits.toLocaleString()} credits</b>
                          {firecrawlUsage.billingPeriodEnd && (
                              <span> · {new Date(firecrawlUsage.billingPeriodEnd).toLocaleDateString('zh-CN')} 刷新</span>
                          )}
                      </div>
                  )}
                  {firecrawlCheckResult && !firecrawlUsage && (
                      <p className={`text-[10px] leading-relaxed ${firecrawlCheckResult.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {firecrawlCheckResult.ok ? '✓ ' : '✗ '}{firecrawlCheckResult.text}
                      </p>
                  )}

                  <p className="text-[9px] text-slate-400 leading-relaxed">
                      Key 仅保存在当前设备，并由设备直接连接 Firecrawl，不经过项目 Worker。请求明确关闭 Firecrawl 页面缓存；请勿分享需要登录的私密链接。
                  </p>
              </div>
              )}

              {/* Notion 配置 */}
              <div className="bg-orange-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <NotePencil size={20} weight="fill" />
                          <span className="text-sm font-bold text-orange-700">Notion 日记</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtNotionEnabled} onChange={e => setRtNotionEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500"></div>
                      </label>
                  </div>
                  {rtNotionEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Notion Integration Token</label>
                              <input type="password" value={rtNotionKey} onChange={e => setRtNotionKey(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="ntn_... 或 secret_..." />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Database ID</label>
                              <input type="text" value={rtNotionDbId} onChange={e => setRtNotionDbId(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="从数据库URL复制" />
                          </div>
                          <button onClick={testNotionApi} className="w-full py-2 bg-orange-100 text-orange-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试Notion连接</button>
                          <div className="border-t border-orange-200/50 pt-2 mt-2">
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">笔记数据库 ID（可选）</label>
                              <input type="text" value={rtNotionNotesDbId} onChange={e => setRtNotionNotesDbId(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="用户日常笔记的数据库ID" />
                              <p className="text-[10px] text-orange-500/60 leading-relaxed mt-1">
                                  填写后角色可以偶尔看到你的笔记标题，温馨地提起你写的内容。留空则不启用。
                              </p>
                          </div>
                          <p className="text-[10px] text-orange-500/70 leading-relaxed">
                               1. 在 <a href="https://www.notion.so/my-integrations" target="_blank" className="underline">Notion开发者</a> 创建Integration（新版 Token 以 ntn_ 开头，老版以 secret_ 开头，都能用）<br/>
                               2. 创建一个日记数据库，添加"Name"(标题)和"Date"(日期)属性<br/>
                               3. 在数据库右上角菜单中 Connect 你的 Integration<br/>
                               Token 保存在本机配置中；启用后，所选数据库的请求会由网络 Worker 转发，项目不主动留存日记内容。
                          </p>
                      </div>
                  )}
              </div>

              {/* 飞书配置 (中国区替代) */}
              <div className="bg-indigo-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Notebook size={20} weight="fill" />
                          <span className="text-sm font-bold text-indigo-700">飞书日记</span>
                          <span className="text-[9px] bg-indigo-100 text-indigo-500 px-1.5 py-0.5 rounded-full">中国区</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtFeishuEnabled} onChange={e => setRtFeishuEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-indigo-500/70 leading-relaxed">
                      Notion 的中国区替代方案，无需翻墙。使用飞书多维表格存储日记。
                  </p>
                  {rtFeishuEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">飞书 App ID</label>
                              <input type="text" value={rtFeishuAppId} onChange={e => setRtFeishuAppId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="cli_xxxxxxxx" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">飞书 App Secret</label>
                              <input type="password" value={rtFeishuAppSecret} onChange={e => setRtFeishuAppSecret(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="xxxxxxxxxxxxxxxx" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">多维表格 App Token</label>
                              <input type="text" value={rtFeishuBaseId} onChange={e => setRtFeishuBaseId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="从多维表格URL中获取" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">数据表 Table ID</label>
                              <input type="text" value={rtFeishuTableId} onChange={e => setRtFeishuTableId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="tblxxxxxxxx" />
                          </div>
                           <button onClick={testFeishuApi} className="w-full py-2 bg-indigo-100 text-indigo-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试读取连接</button>
                           <p className="rounded-xl bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-700">
                               测试不会新增记录，只验证凭据、读取权限和 Table ID。读取成功但写入提示 Forbidden，说明还缺新增记录权限。
                           </p>
                           <p className="text-[10px] text-indigo-500/70 leading-relaxed">
                                1. 在 <a href="https://open.feishu.cn/app" target="_blank" className="underline">飞书开放平台</a> 创建企业自建应用，获取 App ID 和 Secret<br/>
                                2. 开通「查看、评论、编辑和管理多维表格」权限，创建并发布新版本，完成管理员审批<br/>
                                3. 在目标多维表格的「添加文档应用」中加入该应用，并授予可编辑权限（开了高级权限时也要允许新增记录）<br/>
                                4. 添加字段: 标题(文本)、内容(文本)、日期(日期)、心情(文本)、角色(文本)<br/>
                                5. 从多维表格 URL 中获取 App Token 和 Table ID<br/>
                                App Secret 保存在本机配置中；启用后，多维表格请求会由网络 Worker 转发，项目不主动留存表格内容。
                           </p>
                      </div>
                  )}
              </div>

              {/* 小红书自动化 */}
              <div className="bg-red-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Book size={20} weight="fill" />
                          <span className="text-sm font-bold text-red-700">小红书 · 本地</span>
                          <span className="text-[9px] bg-red-100 text-red-500 px-1.5 py-0.5 rounded-full">MCP 兼容 / Skills</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtXhsMcpEnabled && rtXhsMode === 'local'} onChange={e => { if (e.target.checked) { setRtXhsMcpEnabled(true); setRtXhsEnabled(true); setRtXhsMode('local'); } else { setRtXhsMcpEnabled(false); setRtXhsEnabled(false); } }} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-red-500/70 leading-relaxed">
                      本地模式继续可用：xiaohongshu-mcp 走 MCP 协议，xhs-bridge / Skills 走本地 /api。MCP 保留兼容，但不再承诺随其上游版本持续适配；新配置建议使用下方持续维护的 Lite。
                  </p>
                  {rtXhsMcpEnabled && rtXhsMode === 'local' && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">服务器 URL</label>
                              <input value={rtXhsLocalUrl} onChange={e => setRtXhsLocalUrl(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="http://localhost:18060/mcp" />
                          </div>
                          <button onClick={testXhsMcp} className="w-full py-2 bg-red-100 text-red-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试连接</button>
                          <div className="grid grid-cols-2 gap-2">
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小红书昵称</label>
                                  <input value={rtXhsNickname} onChange={e => setRtXhsNickname(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px]" placeholder="手动填写" />
                              </div>
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">用户 ID</label>
                                  <input value={rtXhsUserId} onChange={e => setRtXhsUserId(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="可选，用于查看主页" />
                              </div>
                          </div>
                          <p className="text-[10px] text-red-500/70 leading-relaxed">
                              <b>MCP 模式:</b> 下载 xiaohongshu-mcp + 运行脚本，URL 填 http://localhost:18060/mcp（代理则 18061/mcp）<br/>
                              <b>Skills 模式:</b> URL 填 http://localhost:18061/api（需 Python + xhs-bridge.mjs，额外支持视频/长文）<br/>
                              系统按 URL 结尾自动判断（/mcp 或 /api）。
                          </p>
                      </div>
                  )}
              </div>

              {/* 小红书 Lite (云端) */}
              <div className="bg-rose-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Book size={20} weight="fill" />
                          <span className="text-sm font-bold text-rose-700">小红书 Lite</span>
                          <span className="text-[9px] bg-rose-100 text-rose-500 px-1.5 py-0.5 rounded-full">持续维护</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtXhsMcpEnabled && rtXhsMode === 'lite'} onChange={e => { if (e.target.checked) { if (!window.confirm(XHS_RISK_TEXT + '\n\n确定要开启吗？')) return; setRtXhsMcpEnabled(true); setRtXhsEnabled(true); setRtXhsMode('lite'); } else { setRtXhsMcpEnabled(false); setRtXhsEnabled(false); } }} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-rose-500/70 leading-relaxed">
                      免电脑、免扫码：粘贴一次小红书 / RedNote cookie，即可搜索、浏览、看详情及互动；国内小红书还支持发帖(带图)。地址已内置，无需填写。
                  </p>
                  <p className="text-[10px] text-amber-700 leading-relaxed bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">{XHS_RISK_TEXT}</p>
                  {rtXhsMcpEnabled && rtXhsMode === 'lite' && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小红书 Cookie</label>
                              <textarea value={rtXhsCookie} onChange={e => { setRtXhsCookie(e.target.value); setRtXhsPlatform(undefined); }} rows={2} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[10px] font-mono resize-y" placeholder="a1=...; web_session=...; （从浏览器登录后复制完整 cookie）" />
                          </div>
                          <button onClick={testXhsMcp} className="w-full py-2 bg-rose-100 text-rose-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">测试连接</button>
                          <div className="grid grid-cols-2 gap-2">
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小红书昵称</label>
                                  <input value={rtXhsNickname} onChange={e => setRtXhsNickname(e.target.value)} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[11px]" placeholder="测试连接后自动获取" />
                              </div>
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">用户 ID</label>
                                  <input value={rtXhsUserId} onChange={e => setRtXhsUserId(e.target.value)} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="自动获取" />
                              </div>
                          </div>
                          <div>
                              <button type="button" onClick={() => { if (!rtXhsGuideOpen) trackEvent('展开获取 cookie 教程'); setRtXhsGuideOpen(v => !v); }} className="text-[11px] font-bold text-rose-600 underline">📖 点击获取 cookie 教程 {rtXhsGuideOpen ? '▲' : '▼'}</button>
                              {rtXhsGuideOpen && (
                                  <div className="mt-1 bg-white/70 rounded-lg p-2 space-y-1.5">
                                      <pre className="text-[10px] text-slate-600 whitespace-pre-wrap font-sans leading-relaxed">{XHS_COOKIE_GUIDE}</pre>
                                      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(XHS_COOKIE_GUIDE); trackEvent('复制 cookie 教程文本', { result: 'copied' }); addToast('教程已复制，可粘贴去问别的 AI', 'success'); } catch { trackEvent('复制 cookie 教程文本', { result: 'clipboard-failed' }); addToast('复制失败，请长按手动选择', 'error'); } }} className="w-full py-1.5 bg-rose-100 text-rose-600 text-[11px] font-bold rounded-lg active:scale-95 transition-transform">复制教程</button>
                                  </div>
                              )}
                          </div>
                          <p className="text-[10px] text-slate-400 leading-relaxed bg-slate-100/60 rounded-lg px-2 py-1.5">
                              使用说明：Cookie 保存在本机配置中；使用 Lite 时会随请求发送到网络 Worker，用于登录校验和接口签名，当前开源 Worker 不主动留存。建议使用小号，并在退出账号或 Cookie 失效后及时更新。
                          </p>
                      </div>
                  )}
              </div>

              {/* 麦当劳 MCP */}
              <div className="bg-yellow-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <ForkKnife size={20} weight="fill" className="text-yellow-600" />
                          <span className="text-sm font-bold text-yellow-700">麦当劳</span>
                          <span className="text-[9px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full">官方 MCP</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={mcdEnabled} onChange={e => handleMcdEnabledChange(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-yellow-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-yellow-700/70 leading-relaxed">
                      启用后，在聊天里点 + 号 → 第二页 → 麦当劳，发送"麦请求"激活，角色就能为你查菜单、查门店、点麦乐送/到店取餐/团餐、积分兑券、查活动。
                  </p>
                  {mcdEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">MCP Token (个人)</label>
                              <input type="password" value={mcdToken} onChange={e => handleMcdTokenChange(e.target.value)} className="w-full bg-white/80 border border-yellow-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="去 open.mcd.cn/mcp 申请" />
                          </div>
                          <button onClick={testMcdApi} disabled={mcdTesting} className="w-full py-2 bg-yellow-100 text-yellow-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                              {mcdTesting ? '测试中…' : '测试连接'}
                          </button>
                          {mcdTestStatus && (
                              <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${mcdTestStatus.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : mcdTestStatus.startsWith('❌') ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-600'}`}>
                                  {mcdTestStatus}
                              </div>
                          )}
                          <p className="text-[10px] text-yellow-700/70 leading-relaxed">
                              1. 访问 <a href="https://open.mcd.cn/mcp" target="_blank" className="underline">open.mcd.cn/mcp</a> 用麦当劳账号登录申请 Token<br/>
                              2. Token 保存在本机配置中；使用点单功能时会随 MCP 请求由网络 Worker 转发，项目不主动留存<br/>
                              3. 下单类操作涉及真实支付，角色会先复述清单等你确认再下单<br/>
                              4. 仅中国大陆 (不含港澳台)
                          </p>
                      </div>
                  )}
              </div>

              {/* 瑞幸 MCP */}
              <div className="bg-blue-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Coffee size={20} weight="fill" className="text-blue-600" />
                          <span className="text-sm font-bold text-blue-700">瑞幸咖啡</span>
                          <span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">官方 MCP</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={luckinEnabled} onChange={e => handleLuckinEnabledChange(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-blue-700/70 leading-relaxed">
                      启用后，在聊天里点 + 号 → 第二页 → 瑞一杯，发送"瑞一杯"激活，角色就能为你查门店、搜咖啡、选规格、下单到店自提、查取餐码。
                  </p>
                  {luckinEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">MCP Token (个人)</label>
                              <input type="password" value={luckinToken} onChange={e => handleLuckinTokenChange(e.target.value)} className="w-full bg-white/80 border border-blue-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="去 open.lkcoffee.com 登录后复制" />
                          </div>
                          <button onClick={testLuckinApi} disabled={luckinTesting} className="w-full py-2 bg-blue-100 text-blue-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                              {luckinTesting ? '测试中…' : '测试连接'}
                          </button>
                          {luckinTestStatus && (
                              <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${luckinTestStatus.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : luckinTestStatus.startsWith('❌') ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-600'}`}>
                                  {luckinTestStatus}
                              </div>
                          )}
                          <p className="text-[10px] text-blue-700/70 leading-relaxed">
                              1. 访问 <a href="https://open.lkcoffee.com" target="_blank" className="underline">open.lkcoffee.com</a> 用瑞幸账号登录，复制 Token（有效期约 1 个月）<br/>
                              2. Token 保存在本机配置中；使用点单功能时会随 MCP 请求由网络 Worker 转发，项目不主动留存<br/>
                              3. 下单类操作涉及真实支付，角色会先复述清单等你确认再下单<br/>
                              4. 上游需经 Worker 代理 (/mcp/luckin)，请确保已部署最新 worker
                          </p>
                      </div>
                  )}
              </div>

              {/* 测试状态 */}
              {rtTestStatus && (
                  <div className={`p-3 rounded-xl text-xs font-medium text-center ${rtTestStatus.includes('成功') ? 'bg-emerald-100 text-emerald-700' : rtTestStatus.includes('失败') || rtTestStatus.includes('错误') ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                      {rtTestStatus}
                  </div>
              )}
          </div>
      </Modal>

      {/* 通用 MCP 管理（从实时感知里独立出来） */}
      <Modal isOpen={showMcpModal} title="MCP" onClose={() => { setShowMcpModal(false); flushMcpToolConfigSync(); }}>
          <div className="space-y-4">
              <McpConnectionConsole addToast={addToast} onMcpConfigChanged={() => {
                  // MCP 配置变更只需重传 tool_config：提示词块与 tools 数组由 worker 在 fire 时
                  // 从 tool_config 现场生成（见 mcpFireCore），不经过 fire_pack，没有陈旧问题，
                  // 所以不用像实时感知那样连提示词一起刷（syncAmsgToolConfigAndPrompts）。
                  // 这一份尤其不能传丢：删掉的服务器要是没同步上去，worker 半夜还会带着
                  // 旧 token 去直连它。重试和底账由 syncAmsgToolConfig 负责。
                  scheduleMcpToolConfigSync(() => syncAmsgToolConfig(realtimeConfig));
              }} />
          </div>
      </Modal>

      {/* MCP 帮助 Modal —— 面向完全不懂 MCP 的用户，讲清用途与部署方式 */}
      <Modal isOpen={showMcpHelp} title="MCP 是什么？" onClose={() => setShowMcpHelp(false)}>
          <div className="space-y-3 text-xs text-slate-600 leading-relaxed">
              <div className="bg-violet-50/60 rounded-xl p-3 space-y-1.5">
                  <p className="font-bold text-violet-700">MCP 工具服务器</p>
                  <p>
                      MCP（Model Context Protocol）是一套开放协议。接上资料库、联网搜索、笔记或智能家居后，
                      Sully 可以在聊天中调用它们。MCP 配置不会覆盖角色设定、关系或记忆。
                  </p>
              </div>
              <div className="bg-sky-50/60 rounded-xl p-3 space-y-1.5">
                  <p className="font-bold text-sky-700">🏠 为什么服务器要自己准备？</p>
                  <p>
                      SullyOS 的核心前端可以静态部署，也没有强制所有 MCP 流量经过项目方的中央代理。
                      URL 和凭据默认留在本机，工具服务器需要你自己准备，三选一：
                  </p>
                  <p>
                      ☁️ <b>用现成的云端 MCP 服务</b>：对方给你一个公网 https 地址（可能还有 Token），直接填进配置即可。<br/>
                      🖥️ <b>跑在自己电脑上</b>：电脑上的浏览器直接填 <code className="bg-white/80 px-1 rounded">http://localhost:端口</code>；
                      想在手机上也能用，再配个内网穿透（如 Cloudflare Tunnel）。<br/>
                      🚀 <b>自己部署到云上</b>：VPS / Cloudflare / Zeabur 等，任何设备随时可用。
                  </p>
              </div>
              <div className="bg-amber-50/60 rounded-xl p-3 space-y-1.5">
                  <p className="font-bold text-amber-700">🚧 测试连接报「Failed to fetch」？</p>
                  <p>
                      八成是浏览器的 CORS 跨域拦截（静态网页的另一个代价）。能改服务器就在服务器端配好 CORS；
                      改不了就在配置里填「代理 URL」——本地跑一个小代理，或把仓库里的 Worker 代理部署到你自己的
                      Cloudflare 账号，教程里都有现成步骤。
                  </p>
              </div>
              <div className="space-y-2">
                  <a
                      href={MCP_USER_GUIDE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => trackEvent('跳转 MCP 完整教程')}
                      className="block w-full py-2.5 bg-violet-500 text-white text-center text-xs font-bold rounded-xl active:scale-95 transition-transform"
                  >📖 打开完整教程（含部署示例）</a>
                  <button
                      type="button"
                      onClick={async () => {
                          const text = `请阅读这份教程，然后一步一步教我把 MCP 工具服务器接入 SullyOS。先问清楚我想接什么工具、准备部署在哪（云端/本地电脑/本地+内网穿透），再给对应路线的步骤：\n${MCP_USER_GUIDE_URL}`;
                          try { await navigator.clipboard.writeText(text); trackEvent('复制 MCP 部署指引给 AI', { result: 'copied' }); addToast('已复制，去粘贴给你的 AI 吧', 'success'); }
                          catch { trackEvent('复制 MCP 部署指引给 AI', { result: 'clipboard-failed' }); addToast('复制失败，请手动复制教程链接', 'error'); }
                      }}
                      className="w-full py-2.5 bg-violet-100 text-violet-700 text-xs font-bold rounded-xl active:scale-95 transition-transform"
                  >🤖 复制链接给你的 AI，让它带你部署</button>
                  <p className="text-[10px] text-slate-400 text-center">教程是自包含的，任何 AI 助手读完都能带你走完全程。</p>
              </div>
          </div>
      </Modal>

      {/* 确认重置 Modal */}
      <Modal
          isOpen={showResetConfirm}
          title="系统警告"
          onClose={() => setShowResetConfirm(false)}
          footer={
              <div className="flex gap-2 w-full">
                  <button onClick={() => setShowResetConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">取消</button>
                  <button onClick={confirmReset} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">确认格式化</button>
              </div>
          }
      >
          <div className="flex flex-col items-center gap-3 py-2">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-12 h-12 text-red-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>
              <p className="text-center text-sm text-slate-600 font-medium">
                  这将<span className="text-red-500 font-bold">永久删除</span>所有角色、聊天记录和设置，且无法恢复！
              </p>
          </div>
      </Modal>

      <InstantPushSettingsModal
        open={showInstantModal}
        onClose={() => setShowInstantModal(false)}
        onOpenVapid={() => { setShowInstantModal(false); setShowVapidModal(true); }}
      />
      <PushVapidSettingsModal
        open={showVapidModal}
        onClose={() => { setShowVapidModal(false); setVapidReadyTick((n) => n + 1); }}
      />
      <ActiveMsgGlobalSettingsModal
        isOpen={showAmsg2Modal}
        onClose={() => setShowAmsg2Modal(false)}
        addToast={addToast}
        realtimeConfig={realtimeConfig}
        onOpenVapid={() => { setShowAmsg2Modal(false); setShowVapidModal(true); }}
      />

    </div>
  );
};

export default Settings;

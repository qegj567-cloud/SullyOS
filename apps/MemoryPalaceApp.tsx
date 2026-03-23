/**
 * Memory Palace App — 记忆宫殿独立应用
 *
 * 整合了：
 * - 记忆房间总览 / 记忆列表 / 整理日志（原 MemoryPalaceModal）
 * - Embedding API 配置（原 Settings.tsx 中的配置段）
 * - 向量搜索测试
 */

import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { MemoryNode, MemoryProcessBatch, EmbeddingApiConfig, PersonalityCrystal, Tension, EmotionLayer, InnerMonologueEntry } from '../types';
import { DB } from '../utils/db';
import { processMemoryBatch } from '../utils/memoryExtractor';
import { getMemoryStats } from '../utils/memoryRetrieval';
import { getDefaultEmbeddingConfig } from '../utils/memoryEmbedding';
import { safeResponseJson } from '../utils/safeApi';
import { getCharacterEmotionVisualization } from '../utils/cognitivePipeline';
import { getActiveCrystals, rejectCrystal, formatCrystalsForPrompt } from '../utils/personalityCrystallizer';
import { getActiveTensions, getAllTensions } from '../utils/tensions';
import { getActiveLinks } from '../utils/crossEventLinks';
import { getMonologues } from '../utils/emotionStorage';
import { getPrimaryLabel, getOntologyEntry } from '../utils/emotionOntology';

const ROOM_META: Record<string, { label: string; icon: string; color: string; bg: string; gradient: string }> = {
    living_room: { label: '客厅', icon: '🛋️', color: 'text-blue-600', bg: 'bg-blue-50', gradient: 'from-blue-400 to-blue-600' },
    bedroom:     { label: '卧室', icon: '🛏️', color: 'text-pink-600', bg: 'bg-pink-50', gradient: 'from-pink-400 to-pink-600' },
    study:       { label: '书房', icon: '📚', color: 'text-emerald-600', bg: 'bg-emerald-50', gradient: 'from-emerald-400 to-emerald-600' },
    user_room:   { label: 'TA的房间', icon: '💜', color: 'text-violet-600', bg: 'bg-violet-50', gradient: 'from-violet-400 to-violet-600' },
    self_room:   { label: '自己的房间', icon: '🪞', color: 'text-amber-600', bg: 'bg-amber-50', gradient: 'from-amber-400 to-amber-600' },
    attic:       { label: '阁楼', icon: '🗃️', color: 'text-slate-500', bg: 'bg-slate-50', gradient: 'from-slate-400 to-slate-600' },
};

const EMBEDDING_PRESETS = [
    { name: '硅基 bge-m3', url: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', dims: 1024, tag: '免费', tagColor: 'bg-emerald-100 text-emerald-600' },
    { name: '硅基 Qwen3-0.6B', url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-Embedding-0.6B', dims: 1024, tag: '¥0.01/M', tagColor: 'bg-blue-100 text-blue-600' },
    { name: '硅基 Qwen3-8B', url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-Embedding-8B', dims: 1024, tag: '最强', tagColor: 'bg-violet-100 text-violet-600' },
    { name: '阿里百炼 v4', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v4', dims: 1024, tag: '¥0.5/M', tagColor: 'bg-orange-100 text-orange-600' },
    { name: '豆包', url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-embedding', dims: 2560, tag: '¥0.5/M', tagColor: 'bg-sky-100 text-sky-600' },
    { name: 'OpenAI small', url: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dims: 1536, tag: '$0.02/M', tagColor: 'bg-slate-100 text-slate-500' },
];

type Tab = 'palace' | 'memories' | 'logs' | 'config' | 'emotions' | 'consciousness' | 'crystals' | 'timeline';

const MemoryPalaceApp: React.FC = () => {
    const {
        closeApp, characters, activeCharacterId, setActiveCharacterId,
        apiConfig, embeddingConfig, updateEmbeddingConfig, addToast, userProfile,
    } = useOS();

    const [showCharPicker, setShowCharPicker] = useState(false);

    const char = characters.find(c => c.id === activeCharacterId) || characters[0];
    const cogEnabled = char?.emotionConfig?.cognitiveArchEnabled ?? false;

    // Tab state
    const [activeTab, setActiveTab] = useState<Tab>('palace');

    // Memory data
    const [stats, setStats] = useState<{ totalCount: number; byRoom: Record<string, number>; embeddedCount: number; avgImportance: number } | null>(null);
    const [batches, setBatches] = useState<MemoryProcessBatch[]>([]);
    const [memories, setMemories] = useState<MemoryNode[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [selectedRoom, setSelectedRoom] = useState<string | null>(null);

    // Cognitive architecture data
    const [emotionViz, setEmotionViz] = useState<{
        surface: EmotionLayer[]; middle: EmotionLayer[]; deep: EmotionLayer[];
        overallValence: number; overallArousal: number;
    } | null>(null);
    const [crystals, setCrystals] = useState<PersonalityCrystal[]>([]);
    const [tensions, setTensions] = useState<Tension[]>([]);
    const [monologues, setMonologues] = useState<InnerMonologueEntry[]>([]);
    const [cogLinks, setCogLinks] = useState<{ pattern: string; level: string; observationCount: number; confidence: number }[]>([]);

    // Embedding config local state
    const [embUrl, setEmbUrl] = useState(embeddingConfig.baseUrl);
    const [embKey, setEmbKey] = useState(embeddingConfig.apiKey);
    const [embModel, setEmbModel] = useState(embeddingConfig.model);
    const [embDims, setEmbDims] = useState(String(embeddingConfig.dimensions || 1024));
    const [embUseSameApi, setEmbUseSameApi] = useState(!embeddingConfig.baseUrl);
    const [embStatus, setEmbStatus] = useState('');

    useEffect(() => {
        if (char?.id) loadData();
    }, [char?.id]);

    const loadData = async () => {
        if (!char?.id) return;
        const [s, b, m] = await Promise.all([
            getMemoryStats(char.id),
            DB.getMemoryBatches(char.id),
            DB.getMemoryNodesByCharId(char.id),
        ]);
        setStats(s);
        setBatches(b.sort((a, b) => b.processedAt - a.processedAt).slice(0, 20));
        setMemories(m.sort((a, b) => b.createdAt - a.createdAt));

        // Load cognitive data if enabled
        if (char.emotionConfig?.cognitiveArchEnabled) {
            loadCognitiveData(char.id);
        }
    };

    const loadCognitiveData = async (charId: string) => {
        try {
            const [viz, crys, tens, mono, links] = await Promise.all([
                getCharacterEmotionVisualization(charId),
                getActiveCrystals(charId),
                getAllTensions(charId),
                getMonologues(charId),
                getActiveLinks(charId),
            ]);
            setEmotionViz(viz);
            setCrystals(crys);
            setTensions(tens);
            setMonologues(mono.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50));
            setCogLinks(links.filter(l => l.level !== 'L1_observation').map(l => ({
                pattern: l.pattern, level: l.level, observationCount: l.observationCount, confidence: l.confidence,
            })));
        } catch (e) {
            console.warn('[MemoryPalace] Failed to load cognitive data:', e);
        }
    };

    const handleProcess = async () => {
        if (isProcessing || !char) return;
        const effEmb = (embeddingConfig?.baseUrl && embeddingConfig?.apiKey)
            ? embeddingConfig
            : getDefaultEmbeddingConfig(apiConfig.baseUrl, apiConfig.apiKey);

        setIsProcessing(true);
        try {
            const result = await processMemoryBatch(char.id, {
                apiBaseUrl: apiConfig.baseUrl,
                apiKey: apiConfig.apiKey,
                model: apiConfig.model,
                embeddingConfig: effEmb,
                charName: char.name,
                userName: userProfile.name || '用户',
            });
            if (result) {
                addToast(`整理完成: 提取 ${result.extractedCount} 条, 合并 ${result.mergedCount} 条`, 'success');
            } else {
                addToast('当前没有需要整理的新消息', 'info');
            }
            await loadData();
        } catch (err: any) {
            addToast(`整理失败: ${err.message?.slice(0, 60)}`, 'error');
        }
        setIsProcessing(false);
    };

    const handleSaveEmbeddingConfig = () => {
        if (embUseSameApi) {
            updateEmbeddingConfig({ baseUrl: '', apiKey: '', model: 'text-embedding-3-small', dimensions: 1024 });
            setEmbStatus('已设为使用主 API');
        } else {
            updateEmbeddingConfig({ baseUrl: embUrl, apiKey: embKey, model: embModel, dimensions: Number(embDims) || 1024 });
            setEmbStatus('配置已保存');
        }
        setTimeout(() => setEmbStatus(''), 2000);
    };

    const testEmbeddingApi = async () => {
        const baseUrl = embUseSameApi ? apiConfig.baseUrl : embUrl;
        const apiKey = embUseSameApi ? apiConfig.apiKey : embKey;
        const model = embUseSameApi ? 'text-embedding-3-small' : embModel;
        if (!baseUrl || !apiKey) { setEmbStatus('请先填写 URL 和 Key'); return; }
        setEmbStatus('测试中...');
        try {
            const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model, input: ['测试向量化'], dimensions: Number(embDims) || 1024 }),
            });
            if (!resp.ok) { const d = await safeResponseJson(resp); throw new Error(d?.error?.message || `HTTP ${resp.status}`); }
            const data = await safeResponseJson(resp);
            const dim = data?.data?.[0]?.embedding?.length || 0;
            setEmbStatus(`连接成功! 维度=${dim}`);
        } catch (e: any) {
            setEmbStatus(`失败: ${e.message?.slice(0, 60)}`);
        }
    };

    const applyEmbeddingPreset = (preset: typeof EMBEDDING_PRESETS[number]) => {
        setEmbUrl(preset.url);
        setEmbModel(preset.model);
        setEmbDims(String(preset.dims));
        setEmbUseSameApi(false);
    };

    const filteredMemories = selectedRoom
        ? memories.filter(m => m.room === selectedRoom)
        : memories;

    const formatTime = (ts: number) => {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    };

    if (!char) {
        return (
            <div className="h-full flex items-center justify-center">
                <p className="text-slate-400 text-sm">请先在神经链接中创建角色</p>
            </div>
        );
    }

    const baseTabs: { id: Tab; label: string; icon: string }[] = [
        { id: 'palace', label: '宫殿', icon: '🏛️' },
        { id: 'memories', label: '记忆', icon: '💎' },
        { id: 'logs', label: '日志', icon: '📋' },
        { id: 'config', label: '向量化', icon: '⚙️' },
    ];

    const cogTabs: { id: Tab; label: string; icon: string }[] = cogEnabled ? [
        { id: 'emotions', label: '情绪', icon: '🌊' },
        { id: 'consciousness', label: '意识', icon: '💭' },
        { id: 'crystals', label: '人格', icon: '💎' },
        { id: 'timeline', label: '认知', icon: '🔗' },
    ] : [];

    const tabs = [...baseTabs, ...cogTabs];

    return (
        <div className="h-full w-full bg-slate-50/30 font-light flex flex-col">
            {/* Header */}
            <div className="px-5 pt-14 pb-3 shrink-0">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-lg shadow-lg shadow-amber-500/30">
                            🏛️
                        </div>
                        <div>
                            <h1 className="text-xl font-light text-slate-800 tracking-tight">记忆宫殿</h1>
                            {/* Character Switcher */}
                            <button onClick={() => setShowCharPicker(!showCharPicker)}
                                className="text-[10px] text-slate-400 hover:text-amber-600 transition-colors flex items-center gap-1">
                                {char.name} 的记忆空间
                                {characters.length > 1 && (
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-3 h-3">
                                        <path strokeLinecap="round" strokeLinejoin="round" d={showCharPicker ? "M4.5 15.75l7.5-7.5 7.5 7.5" : "M19.5 8.25l-7.5 7.5-7.5-7.5"} />
                                    </svg>
                                )}
                            </button>
                        </div>
                    </div>
                    <button onClick={closeApp} className="p-2 rounded-full bg-white/40 hover:bg-white/80 transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Character Picker Dropdown */}
                {showCharPicker && characters.length > 1 && (
                    <div className="mb-3 bg-white/80 backdrop-blur-sm rounded-2xl border border-white/50 shadow-lg overflow-hidden animate-fade-in">
                        {characters.map(c => (
                            <button key={c.id}
                                onClick={() => { setActiveCharacterId(c.id); setShowCharPicker(false); }}
                                className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors ${
                                    c.id === activeCharacterId
                                        ? 'bg-amber-50 text-amber-700'
                                        : 'text-slate-600 hover:bg-slate-50'
                                }`}>
                                {c.avatar ? (
                                    <img src={c.avatar} className="w-7 h-7 rounded-full object-cover" alt="" />
                                ) : (
                                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-300 to-slate-400 flex items-center justify-center text-white text-xs font-bold">
                                        {c.name.charAt(0)}
                                    </div>
                                )}
                                <span className="text-xs font-medium">{c.name}</span>
                                {c.id === activeCharacterId && (
                                    <span className="ml-auto text-amber-500 text-[10px] font-bold">当前</span>
                                )}
                            </button>
                        ))}
                    </div>
                )}

                {/* Tabs */}
                <div className="flex gap-1 bg-white/60 rounded-2xl p-1 border border-white/50 overflow-x-auto no-scrollbar">
                    {tabs.map(tab => (
                        <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                            className={`shrink-0 px-3 py-2 rounded-xl text-[11px] font-bold transition-all ${
                                activeTab === tab.id
                                    ? 'bg-amber-500 text-white shadow-md shadow-amber-500/20'
                                    : 'text-slate-500 hover:bg-white/60'
                            }`}>
                            <span className="mr-0.5">{tab.icon}</span>{tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 pb-20 no-scrollbar">
                {/* ===== Palace Overview ===== */}
                {activeTab === 'palace' && (
                    <div className="space-y-4 animate-fade-in">
                        {stats ? (
                            <>
                                {/* Stats Cards */}
                                <div className="grid grid-cols-3 gap-2">
                                    <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-3 text-center border border-white/50 shadow-sm">
                                        <div className="text-2xl font-bold text-amber-600">{stats.totalCount}</div>
                                        <div className="text-[10px] text-slate-400 mt-0.5">总记忆</div>
                                    </div>
                                    <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-3 text-center border border-white/50 shadow-sm">
                                        <div className="text-2xl font-bold text-emerald-600">{stats.embeddedCount}</div>
                                        <div className="text-[10px] text-slate-400 mt-0.5">已向量化</div>
                                    </div>
                                    <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-3 text-center border border-white/50 shadow-sm">
                                        <div className="text-2xl font-bold text-violet-600">{stats.avgImportance.toFixed(1)}</div>
                                        <div className="text-[10px] text-slate-400 mt-0.5">平均重要性</div>
                                    </div>
                                </div>

                                {/* Room Cards */}
                                <div className="space-y-2">
                                    {Object.entries(ROOM_META).map(([key, meta]) => {
                                        const count = stats.byRoom[key] || 0;
                                        const pct = stats.totalCount > 0 ? (count / stats.totalCount * 100) : 0;
                                        return (
                                            <button key={key}
                                                onClick={() => { setSelectedRoom(key); setActiveTab('memories'); }}
                                                className="w-full flex items-center gap-3 p-3 rounded-2xl bg-white/70 backdrop-blur-sm border border-white/50 shadow-sm active:scale-[0.98] transition-all">
                                                <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${meta.gradient} flex items-center justify-center text-white text-base shadow-sm`}>
                                                    {meta.icon}
                                                </div>
                                                <div className="flex-1 text-left">
                                                    <div className="flex items-center justify-between mb-1">
                                                        <span className={`text-sm font-medium ${meta.color}`}>{meta.label}</span>
                                                        <span className={`text-xs font-bold ${meta.color}`}>{count}</span>
                                                    </div>
                                                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                        <div className={`h-full rounded-full bg-gradient-to-r ${meta.gradient} transition-all`}
                                                            style={{ width: `${Math.max(pct, 2)}%` }} />
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </>
                        ) : (
                            <div className="text-center py-12 text-slate-400 text-xs">加载中...</div>
                        )}

                        {/* Process Button */}
                        <button onClick={handleProcess} disabled={isProcessing}
                            className={`w-full py-3.5 rounded-2xl font-bold text-white shadow-lg transition-all active:scale-95 ${
                                isProcessing
                                    ? 'bg-slate-400 shadow-slate-400/20'
                                    : 'bg-gradient-to-r from-amber-500 to-orange-500 shadow-amber-500/30'
                            }`}>
                            {isProcessing ? (
                                <span className="flex items-center justify-center gap-2">
                                    <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                    整理中...
                                </span>
                            ) : '整理记忆'}
                        </button>
                        <p className="text-[10px] text-slate-400 text-center">从聊天记录中提取新的记忆碎片并向量化入库</p>
                    </div>
                )}

                {/* ===== Memory List ===== */}
                {activeTab === 'memories' && (
                    <div className="space-y-3 animate-fade-in">
                        {/* Room Filter */}
                        <div className="flex gap-1.5 flex-wrap">
                            <button onClick={() => setSelectedRoom(null)}
                                className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
                                    !selectedRoom ? 'bg-amber-500 text-white shadow-sm' : 'bg-white/70 text-slate-500 border border-white/50'
                                }`}>
                                全部 ({memories.length})
                            </button>
                            {Object.entries(ROOM_META).map(([key, meta]) => {
                                const count = memories.filter(m => m.room === key).length;
                                if (count === 0) return null;
                                return (
                                    <button key={key} onClick={() => setSelectedRoom(key)}
                                        className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${
                                            selectedRoom === key
                                                ? 'bg-amber-500 text-white shadow-sm'
                                                : `bg-white/70 ${meta.color} border border-white/50`
                                        }`}>
                                        {meta.icon} {meta.label} ({count})
                                    </button>
                                );
                            })}
                        </div>

                        {/* Memory Items */}
                        {filteredMemories.length === 0 ? (
                            <div className="text-center py-12 text-slate-400 text-xs">暂无记忆，请先整理</div>
                        ) : filteredMemories.slice(0, 80).map(mem => {
                            const meta = ROOM_META[mem.room] || ROOM_META.attic;
                            return (
                                <div key={mem.id} className="p-3 rounded-2xl bg-white/70 backdrop-blur-sm border border-white/50 shadow-sm">
                                    <div className="flex items-start gap-2">
                                        <div className={`shrink-0 px-2 py-0.5 rounded-lg text-[9px] font-bold ${meta.color} bg-white/80`}>
                                            {meta.icon} {meta.label}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs text-slate-700 leading-relaxed">{mem.content}</p>
                                            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                                <span className="text-[9px] text-slate-400">{formatTime(mem.createdAt)}</span>
                                                <span className="text-[9px] text-amber-500 font-bold">★{mem.importance}</span>
                                                {mem.tags?.length > 0 && mem.tags.slice(0, 3).map(t => (
                                                    <span key={t} className="text-[9px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">#{t}</span>
                                                ))}
                                                {!mem.embedded && <span className="text-[9px] text-red-400 font-bold">未向量化</span>}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        {filteredMemories.length > 80 && (
                            <div className="text-center text-[10px] text-slate-400 py-2">还有 {filteredMemories.length - 80} 条记忆未显示</div>
                        )}
                    </div>
                )}

                {/* ===== Logs ===== */}
                {activeTab === 'logs' && (
                    <div className="space-y-3 animate-fade-in">
                        {batches.length === 0 ? (
                            <div className="text-center py-12 text-slate-400 text-xs">暂无整理记录</div>
                        ) : batches.map(batch => (
                            <div key={batch.id} className="bg-white/70 backdrop-blur-sm rounded-2xl p-3 space-y-2 border border-white/50 shadow-sm">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-bold text-slate-600">{formatTime(batch.processedAt)}</span>
                                    <span className="text-[10px] text-slate-400">提取 {batch.extractedCount} / 合并 {batch.mergedCount}</span>
                                </div>
                                <div className="space-y-1">
                                    {batch.log.map((line, i) => (
                                        <p key={i} className="text-[11px] text-slate-500 leading-relaxed">{line}</p>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* ===== Embedding Config ===== */}
                {activeTab === 'config' && (
                    <div className="space-y-4 animate-fade-in">
                        <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-4 border border-white/50 shadow-sm">
                            <h3 className="text-sm font-semibold text-slate-700 mb-2">向量化 API 配置</h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed mb-4">
                                记忆宫殿需要 Embedding API 来将记忆向量化。支持任何 OpenAI 兼容接口。
                            </p>

                            {/* Presets */}
                            <div className="mb-4">
                                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">一键预设</label>
                                <div className="flex gap-1.5 flex-wrap">
                                    {EMBEDDING_PRESETS.map(p => (
                                        <button key={p.model} onClick={() => applyEmbeddingPreset(p)}
                                            className={`px-2.5 py-1.5 rounded-xl text-[10px] font-bold border transition-all active:scale-95 ${
                                                embModel === p.model && embUrl === p.url
                                                    ? 'bg-amber-500 text-white border-amber-500'
                                                    : 'bg-white border-slate-200 text-slate-600 hover:border-amber-300'
                                            }`}>
                                            {p.name}
                                            <span className={`ml-1 px-1 py-0.5 rounded text-[8px] ${embModel === p.model && embUrl === p.url ? 'bg-white/20 text-white' : p.tagColor}`}>{p.tag}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Same API Toggle */}
                            <div className="flex items-center gap-3 mb-4 p-3 bg-amber-50/80 rounded-xl">
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" checked={embUseSameApi} onChange={e => setEmbUseSameApi(e.target.checked)} className="sr-only peer" />
                                    <div className="w-11 h-6 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500"></div>
                                </label>
                                <span className="text-xs text-slate-600 font-medium">使用与主 API 相同的地址和 Key</span>
                            </div>

                            {!embUseSameApi && (
                                <div className="space-y-3 mb-4">
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Embedding URL</label>
                                        <input type="text" value={embUrl} onChange={e => setEmbUrl(e.target.value)} placeholder="https://api.siliconflow.cn/v1"
                                            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-mono focus:border-amber-400 transition-all" />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Embedding Key</label>
                                        <input type="password" value={embKey} onChange={e => setEmbKey(e.target.value)} placeholder="sk-..."
                                            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-mono focus:border-amber-400 transition-all" />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Embedding Model</label>
                                        <input type="text" value={embModel} onChange={e => setEmbModel(e.target.value)} placeholder="BAAI/bge-m3"
                                            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-mono focus:border-amber-400 transition-all" />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">维度 (Dimensions)</label>
                                        <input type="number" value={embDims} onChange={e => setEmbDims(e.target.value)} placeholder="1024"
                                            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-mono focus:border-amber-400 transition-all" />
                                    </div>
                                </div>
                            )}

                            <p className="text-[10px] text-slate-400 mb-3 leading-relaxed">
                                硅基流动新用户送 14 元额度，bge-m3 免费无限用（有限速）。阿里百炼批量模式 5 折。
                            </p>

                            <div className="flex gap-2">
                                <button onClick={testEmbeddingApi}
                                    className="flex-1 py-2.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl text-xs font-bold active:scale-95 transition-transform">
                                    测试连接
                                </button>
                                <button onClick={handleSaveEmbeddingConfig}
                                    className="flex-1 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl text-xs font-bold shadow-lg shadow-amber-500/20 active:scale-95 transition-transform">
                                    {embStatus || '保存配置'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* ===== Emotion Weather Map ===== */}
                {activeTab === 'emotions' && cogEnabled && (
                    <div className="space-y-4 animate-fade-in">
                        {emotionViz ? (
                            <>
                                {/* Overall Mood Indicator */}
                                <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-4 border border-white/50 shadow-sm text-center">
                                    <div className="text-3xl mb-1">
                                        {emotionViz.overallValence > 0.3 ? '☀️' :
                                         emotionViz.overallValence > 0 ? '🌤️' :
                                         emotionViz.overallValence > -0.3 ? '☁️' :
                                         emotionViz.overallValence > -0.6 ? '🌧️' : '⛈️'}
                                    </div>
                                    <div className="text-sm text-slate-600 font-medium">
                                        情绪气象 ·
                                        <span className={emotionViz.overallValence > 0 ? 'text-emerald-600' : 'text-rose-600'}>
                                            {' '}{emotionViz.overallValence > 0.3 ? '晴朗' :
                                              emotionViz.overallValence > 0 ? '多云转晴' :
                                              emotionViz.overallValence > -0.3 ? '阴' :
                                              emotionViz.overallValence > -0.6 ? '小雨' : '暴风雨'}
                                        </span>
                                    </div>
                                    <div className="flex justify-center gap-6 mt-3 text-[10px] text-slate-400">
                                        <span>效价 {(emotionViz.overallValence * 100).toFixed(0)}%</span>
                                        <span>激活度 {(emotionViz.overallArousal * 100).toFixed(0)}%</span>
                                    </div>
                                </div>

                                {/* Three-layer Stack */}
                                {[
                                    { label: '深层底色', layers: emotionViz.deep, color: 'from-violet-500 to-purple-600', bgColor: 'bg-violet-50', textColor: 'text-violet-700' },
                                    { label: '中层情绪', layers: emotionViz.middle, color: 'from-blue-400 to-indigo-500', bgColor: 'bg-blue-50', textColor: 'text-blue-700' },
                                    { label: '表层感受', layers: emotionViz.surface, color: 'from-cyan-400 to-teal-500', bgColor: 'bg-cyan-50', textColor: 'text-cyan-700' },
                                ].map(section => (
                                    <div key={section.label} className="bg-white/70 backdrop-blur-sm rounded-2xl p-4 border border-white/50 shadow-sm">
                                        <div className={`text-[10px] font-bold uppercase tracking-widest ${section.textColor} mb-3`}>{section.label}</div>
                                        {section.layers.length === 0 ? (
                                            <div className="text-xs text-slate-400 py-2">平静 — 无明显情绪</div>
                                        ) : (
                                            <div className="space-y-2">
                                                {section.layers.map(layer => {
                                                    const entry = getOntologyEntry(layer.ontologyId);
                                                    return (
                                                        <div key={layer.id} className="flex items-center gap-3">
                                                            <div className="flex-1">
                                                                <div className="flex items-center justify-between mb-1">
                                                                    <span className={`text-sm font-medium ${section.textColor}`}>
                                                                        {getPrimaryLabel(layer.ontologyId)}
                                                                        {layer.nuance && <span className="text-slate-400 font-normal ml-1 text-xs">({layer.nuance})</span>}
                                                                    </span>
                                                                    <span className="text-[10px] text-slate-400">{Math.round(layer.intensity * 100)}%</span>
                                                                </div>
                                                                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                                                                    <div className={`h-full rounded-full bg-gradient-to-r ${section.color} transition-all duration-500`}
                                                                        style={{ width: `${Math.max(layer.intensity * 100, 3)}%` }} />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </>
                        ) : (
                            <div className="text-center py-12 text-slate-400 text-xs">暂无情绪数据 — 开始对话后会自动生成</div>
                        )}
                    </div>
                )}

                {/* ===== Consciousness Stream ===== */}
                {activeTab === 'consciousness' && cogEnabled && (
                    <div className="space-y-3 animate-fade-in">
                        <p className="text-[10px] text-slate-400 leading-relaxed mb-2">
                            角色的内心独白 — 用户看不到的真实想法
                        </p>
                        {monologues.length === 0 ? (
                            <div className="text-center py-12 text-slate-400 text-xs">暂无内心独白记录</div>
                        ) : monologues.map(mono => {
                            const typeLabel = mono.type === 'daily_review' ? '每日回顾' : mono.type === 'reflection' ? '自我反思' : '实时独白';
                            const typeColor = mono.type === 'daily_review' ? 'bg-amber-100 text-amber-700' :
                                              mono.type === 'reflection' ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-600';
                            return (
                                <div key={mono.id} className="bg-white/70 backdrop-blur-sm rounded-2xl p-4 border border-white/50 shadow-sm">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${typeColor}`}>{typeLabel}</span>
                                        <span className="text-[9px] text-slate-400">{formatTime(mono.timestamp)}</span>
                                    </div>
                                    <p className="text-xs text-slate-600 leading-relaxed italic">"{mono.content}"</p>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* ===== Personality Crystals ===== */}
                {activeTab === 'crystals' && cogEnabled && (
                    <div className="space-y-4 animate-fade-in">
                        <p className="text-[10px] text-slate-400 leading-relaxed">
                            从长期互动中涌现的人格特质 — 不像 TA 的可以否决
                        </p>

                        {crystals.length === 0 ? (
                            <div className="text-center py-12 text-slate-400 text-xs">暂无涌现特质 — 需要足够的互动积累</div>
                        ) : crystals.map(crystal => {
                            const isProvisional = crystal.status === 'provisional';
                            return (
                                <div key={crystal.id} className={`bg-white/70 backdrop-blur-sm rounded-2xl p-4 border shadow-sm ${
                                    isProvisional ? 'border-dashed border-violet-200' : 'border-white/50'
                                }`}>
                                    <div className="flex items-start justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-base">{isProvisional ? '🔮' : '💎'}</span>
                                            <div>
                                                <span className="text-sm font-medium text-slate-700">{crystal.trait}</span>
                                                {isProvisional && (
                                                    <span className="ml-1.5 text-[9px] px-1.5 py-0.5 bg-violet-100 text-violet-600 rounded-full font-bold">试验中</span>
                                                )}
                                            </div>
                                        </div>
                                        <button
                                            onClick={async () => {
                                                await rejectCrystal(char.id, crystal.id);
                                                setCrystals(prev => prev.filter(c => c.id !== crystal.id));
                                                addToast('已否决该特质', 'info');
                                            }}
                                            className="text-[10px] text-slate-400 hover:text-red-500 transition-colors px-2 py-1"
                                        >
                                            这不像 TA
                                        </button>
                                    </div>

                                    {/* Strength bar */}
                                    <div className="mb-2">
                                        <div className="flex justify-between text-[9px] text-slate-400 mb-0.5">
                                            <span>强度</span>
                                            <span>{Math.round(crystal.strength * 100)}%</span>
                                        </div>
                                        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                            <div className={`h-full rounded-full transition-all ${isProvisional ? 'bg-violet-400' : 'bg-gradient-to-r from-amber-400 to-orange-500'}`}
                                                style={{ width: `${Math.max(crystal.strength * 100, 3)}%` }} />
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-3 text-[9px] text-slate-400">
                                        <span>验证 {crystal.reinforcementCount} 次</span>
                                        <span>存活 {crystal.periodsSurvived} 周期</span>
                                    </div>

                                    {crystal.evidence.length > 0 && (
                                        <div className="mt-2 space-y-1">
                                            {crystal.evidence.slice(-2).map((e, i) => (
                                                <p key={i} className="text-[10px] text-slate-400 leading-relaxed pl-2 border-l-2 border-slate-200">
                                                    {e}
                                                </p>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* ===== Cognitive Timeline ===== */}
                {activeTab === 'timeline' && cogEnabled && (
                    <div className="space-y-4 animate-fade-in">
                        {/* Cross-Event Patterns */}
                        <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-4 border border-white/50 shadow-sm">
                            <div className="text-[10px] font-bold text-teal-700 uppercase tracking-widest mb-3">跨事件关联</div>
                            {cogLinks.length === 0 ? (
                                <div className="text-xs text-slate-400 py-2">暂未发现关联模式</div>
                            ) : (
                                <div className="space-y-2">
                                    {cogLinks.map((link, i) => {
                                        const levelLabel = link.level === 'L3_stable' ? '稳定' : '假说';
                                        const levelColor = link.level === 'L3_stable' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700';
                                        return (
                                            <div key={i} className="flex items-start gap-2">
                                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 mt-0.5 ${levelColor}`}>{levelLabel}</span>
                                                <div className="flex-1">
                                                    <p className="text-xs text-slate-600 leading-relaxed">{link.pattern}</p>
                                                    <div className="flex gap-3 mt-1 text-[9px] text-slate-400">
                                                        <span>验证 {link.observationCount} 次</span>
                                                        <span>确信度 {Math.round(link.confidence * 100)}%</span>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Active Tensions */}
                        <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-4 border border-white/50 shadow-sm">
                            <div className="text-[10px] font-bold text-amber-700 uppercase tracking-widest mb-3">未解决的困惑</div>
                            {tensions.filter(t => t.status === 'active' || t.status === 'resolving').length === 0 ? (
                                <div className="text-xs text-slate-400 py-2">角色内心暂无困惑</div>
                            ) : (
                                <div className="space-y-2">
                                    {tensions.filter(t => t.status === 'active' || t.status === 'resolving').map(t => (
                                        <div key={t.id} className="p-3 bg-amber-50/50 rounded-xl">
                                            <div className="flex items-center justify-between mb-1">
                                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                                                    t.status === 'resolving' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
                                                }`}>
                                                    {t.status === 'resolving' ? '正在理解' : '困惑中'}
                                                </span>
                                                <span className="text-[9px] text-slate-400">回想 {t.revisitCount} 次</span>
                                            </div>
                                            <p className="text-xs text-slate-600 leading-relaxed mt-1">{t.description}</p>
                                            {/* Intensity bar */}
                                            <div className="h-1 bg-amber-100 rounded-full mt-2 overflow-hidden">
                                                <div className="h-full bg-amber-400 rounded-full" style={{ width: `${t.intensity * 100}%` }} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Resolved / Dormant */}
                        {tensions.filter(t => t.status === 'resolved' || t.status === 'dormant').length > 0 && (
                            <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-4 border border-white/50 shadow-sm">
                                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">已消解 / 休眠</div>
                                <div className="space-y-1.5">
                                    {tensions.filter(t => t.status === 'resolved' || t.status === 'dormant').map(t => (
                                        <div key={t.id} className="flex items-center gap-2">
                                            <span className="text-[9px]">{t.status === 'resolved' ? '✅' : '💤'}</span>
                                            <p className="text-[11px] text-slate-400 line-through leading-relaxed">{t.description}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default MemoryPalaceApp;

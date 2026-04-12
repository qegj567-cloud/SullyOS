/**
 * Memory Palace Modal — 记忆宫殿管理面板
 * 显示记忆房间统计、手动触发整理、查看整理日志
 */

import React, { useState, useEffect } from 'react';
import Modal from '../os/Modal';
import { CharacterProfile, EmbeddingApiConfig, MemoryNode, MemoryProcessBatch } from '../../types';
import { DB } from '../../utils/db';
import { processMemoryBatch } from '../../utils/memoryExtractor';
import { getMemoryStats } from '../../utils/memoryRetrieval';
import { getDefaultEmbeddingConfig } from '../../utils/memoryEmbedding';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    char: CharacterProfile;
    apiConfig: { baseUrl: string; apiKey: string; model: string };
    embeddingConfig?: EmbeddingApiConfig;
    userName: string;
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
}

const ROOM_META: Record<string, { label: string; color: string; bg: string }> = {
    living_room: { label: '客厅', color: 'text-blue-600', bg: 'bg-blue-50' },
    bedroom: { label: '卧室', color: 'text-pink-600', bg: 'bg-pink-50' },
    study: { label: '书房', color: 'text-emerald-600', bg: 'bg-emerald-50' },
    user_room: { label: 'TA的房间', color: 'text-violet-600', bg: 'bg-violet-50' },
    self_room: { label: '自己的房间', color: 'text-amber-600', bg: 'bg-amber-50' },
    attic: { label: '阁楼', color: 'text-slate-500', bg: 'bg-slate-50' },
};

const MemoryPalaceModal: React.FC<Props> = ({ isOpen, onClose, char, apiConfig, embeddingConfig, userName, addToast }) => {
    const [stats, setStats] = useState<{ totalCount: number; byRoom: Record<string, number>; embeddedCount: number; avgImportance: number } | null>(null);
    const [batches, setBatches] = useState<MemoryProcessBatch[]>([]);
    const [memories, setMemories] = useState<MemoryNode[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [activeTab, setActiveTab] = useState<'rooms' | 'memories' | 'logs'>('rooms');
    const [selectedRoom, setSelectedRoom] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen && char.id) loadData();
    }, [isOpen, char.id]);

    const loadData = async () => {
        const [s, b, m] = await Promise.all([
            getMemoryStats(char.id),
            DB.getMemoryBatches(char.id),
            DB.getMemoryNodesByCharId(char.id),
        ]);
        setStats(s);
        setBatches(b.sort((a, b) => b.processedAt - a.processedAt).slice(0, 10));
        setMemories(m.sort((a, b) => b.createdAt - a.createdAt));
    };

    const handleProcess = async () => {
        if (isProcessing) return;
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
                userName,
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

    const filteredMemories = selectedRoom
        ? memories.filter(m => m.room === selectedRoom)
        : memories;

    const formatTime = (ts: number) => {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    };

    return (
        <Modal isOpen={isOpen} title="记忆宫殿" onClose={onClose}>
            <div className="space-y-4">
                {/* Tabs */}
                <div className="flex gap-2">
                    {(['rooms', 'memories', 'logs'] as const).map(tab => (
                        <button key={tab} onClick={() => setActiveTab(tab)}
                            className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all ${activeTab === tab ? 'bg-amber-500 text-white shadow-lg' : 'bg-slate-100 text-slate-500'}`}>
                            {tab === 'rooms' ? '房间总览' : tab === 'memories' ? '记忆列表' : '整理日志'}
                        </button>
                    ))}
                </div>

                {/* Room Overview */}
                {activeTab === 'rooms' && (
                    <div className="space-y-3">
                        {stats ? (
                            <>
                                <div className="grid grid-cols-3 gap-2 text-center">
                                    <div className="bg-amber-50 rounded-xl p-3">
                                        <div className="text-xl font-bold text-amber-600">{stats.totalCount}</div>
                                        <div className="text-[10px] text-slate-400">总记忆数</div>
                                    </div>
                                    <div className="bg-emerald-50 rounded-xl p-3">
                                        <div className="text-xl font-bold text-emerald-600">{stats.embeddedCount}</div>
                                        <div className="text-[10px] text-slate-400">已向量化</div>
                                    </div>
                                    <div className="bg-violet-50 rounded-xl p-3">
                                        <div className="text-xl font-bold text-violet-600">{stats.avgImportance.toFixed(1)}</div>
                                        <div className="text-[10px] text-slate-400">平均重要性</div>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    {Object.entries(ROOM_META).map(([key, meta]) => {
                                        const count = stats.byRoom[key] || 0;
                                        const pct = stats.totalCount > 0 ? (count / stats.totalCount * 100) : 0;
                                        return (
                                            <button key={key} onClick={() => { setSelectedRoom(key); setActiveTab('memories'); }}
                                                className={`w-full flex items-center gap-3 p-3 rounded-xl ${meta.bg} active:scale-[0.98] transition-transform`}>
                                                <div className={`text-sm font-bold ${meta.color} w-16 text-left`}>{meta.label}</div>
                                                <div className="flex-1 h-2 bg-white/60 rounded-full overflow-hidden">
                                                    <div className={`h-full rounded-full transition-all ${meta.bg.replace('50', '300')}`} style={{ width: `${pct}%`, backgroundColor: 'currentColor', opacity: 0.4 }} />
                                                </div>
                                                <div className={`text-sm font-bold ${meta.color} w-8 text-right`}>{count}</div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </>
                        ) : (
                            <div className="text-center py-8 text-slate-400 text-xs">加载中...</div>
                        )}

                        <button onClick={handleProcess} disabled={isProcessing}
                            className={`w-full py-3 rounded-2xl font-bold text-white shadow-lg transition-all active:scale-95 ${isProcessing ? 'bg-slate-400' : 'bg-amber-500 shadow-amber-500/20'}`}>
                            {isProcessing ? '整理中...' : '手动整理记忆'}
                        </button>
                        <p className="text-[10px] text-slate-400 text-center">从聊天记录中提取新的记忆碎片并向量化入库</p>
                    </div>
                )}

                {/* Memory List */}
                {activeTab === 'memories' && (
                    <div className="space-y-3">
                        {/* Room Filter */}
                        <div className="flex gap-1.5 flex-wrap">
                            <button onClick={() => setSelectedRoom(null)}
                                className={`px-3 py-1 rounded-full text-[10px] font-bold ${!selectedRoom ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                全部 ({memories.length})
                            </button>
                            {Object.entries(ROOM_META).map(([key, meta]) => {
                                const count = memories.filter(m => m.room === key).length;
                                if (count === 0) return null;
                                return (
                                    <button key={key} onClick={() => setSelectedRoom(key)}
                                        className={`px-3 py-1 rounded-full text-[10px] font-bold ${selectedRoom === key ? 'bg-amber-500 text-white' : `${meta.bg} ${meta.color}`}`}>
                                        {meta.label} ({count})
                                    </button>
                                );
                            })}
                        </div>

                        {/* Memory Items */}
                        <div className="max-h-[40vh] overflow-y-auto no-scrollbar space-y-2">
                            {filteredMemories.length === 0 ? (
                                <div className="text-center py-8 text-slate-400 text-xs">暂无记忆，点击「手动整理记忆」开始</div>
                            ) : filteredMemories.slice(0, 50).map(mem => {
                                const meta = ROOM_META[mem.room] || ROOM_META.attic;
                                return (
                                    <div key={mem.id} className={`p-3 rounded-xl ${meta.bg} border border-white/50`}>
                                        <div className="flex items-start gap-2">
                                            <div className={`shrink-0 px-2 py-0.5 rounded-md text-[9px] font-bold ${meta.color} bg-white/60`}>
                                                {meta.label}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs text-slate-700 leading-relaxed">{mem.content}</p>
                                                <div className="flex items-center gap-2 mt-1.5">
                                                    <span className="text-[9px] text-slate-400">{formatTime(mem.createdAt)}</span>
                                                    <span className="text-[9px] text-amber-500 font-bold">★{mem.importance}</span>
                                                    {mem.tags?.length > 0 && mem.tags.slice(0, 3).map(t => (
                                                        <span key={t} className="text-[9px] text-slate-400 bg-white/60 px-1.5 py-0.5 rounded">#{t}</span>
                                                    ))}
                                                    {!mem.embedded && <span className="text-[9px] text-red-400 font-bold">未向量化</span>}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            {filteredMemories.length > 50 && (
                                <div className="text-center text-[10px] text-slate-400 py-2">还有 {filteredMemories.length - 50} 条记忆未显示</div>
                            )}
                        </div>
                    </div>
                )}

                {/* Batch Logs */}
                {activeTab === 'logs' && (
                    <div className="max-h-[50vh] overflow-y-auto no-scrollbar space-y-3">
                        {batches.length === 0 ? (
                            <div className="text-center py-8 text-slate-400 text-xs">暂无整理记录</div>
                        ) : batches.map(batch => (
                            <div key={batch.id} className="bg-slate-50 rounded-xl p-3 space-y-2">
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
            </div>
        </Modal>
    );
};

export default MemoryPalaceModal;

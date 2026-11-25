import React, { useState } from 'react';
import type { APIConfig, CharacterProfile } from '../../types';
import type { MemoryPalaceGlobalConfig } from '../../context/OSContext';
import { processNewMessagesWithAutoArchive } from '../../utils/memoryPalace/autoArchive';
import { EventBoxDB } from '../../utils/memoryPalace/db';
import { hasRunnableMemoryPalaceLlm, resolveMemoryPalaceLlm } from '../../utils/memoryPalace/pipeline';
import { EVENT_BOX_COMPRESSION_THRESHOLD } from '../../utils/memoryPalace/types';
import { maybeCompressEventBoxes } from '../../utils/memoryPalace/eventBoxCompression';
import { consolidateAllPlates } from '../../utils/memoryPalace/roomPlates';

const running = new Set<string>();
const labels = ['提取记忆', '压缩事件盒', '整理门牌', '本轮完成'];
function readStep(id: string): number {
    try { return Math.max(0, Math.min(3, Number(localStorage.getItem('mp_manualStep_' + id)) || 0)); } catch { return 0; }
}
export default function MemoryMaintenancePanel({ config, update, char, userName, apiConfig }: {
    config: MemoryPalaceGlobalConfig; update: (patch: Partial<MemoryPalaceGlobalConfig>) => void;
    char?: CharacterProfile | null; userName: string; apiConfig?: Partial<APIConfig> | null;
}) {
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState(() => readStep(char?.id || ''));
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const advance = (next: number) => { localStorage.setItem('mp_manualStep_' + char!.id, String(next)); setStep(next); };
    const run = async () => {
        if (!char || running.has(char.id) || !config.manualMaintenance) return;
        if (!char.memoryPalaceEnabled) { setMessage('请先为该角色开启记忆宫殿。'); return; }
        const resolvedLlm = resolveMemoryPalaceLlm(config.lightLLM, apiConfig);
        const llm = { ...resolvedLlm, deferPlateMaintenance: true };
        const emb = config.embedding;
        if (!hasRunnableMemoryPalaceLlm(resolvedLlm)) { setMessage('请先在设置中配置主 API 或在记忆宫殿设置中配置副 API。'); return; }
        if (!emb?.baseUrl || !emb?.apiKey) { setMessage('请先在全局配置中填好 Embedding API。'); return; }
        running.add(char.id); setBusy(true); setMessage('正在处理，请保持页面打开；请求间隔内会等待…');
        try {
            if (step === 0) {
                const result = await processNewMessagesWithAutoArchive([], char.id, char.name, emb, llm, userName, false, setMessage, { manualMaintenanceStep: true, requireAllBatches: true });
                if (!result || result.batches.some(batch => !batch.ok)) throw new Error('提取未完成，请稍后重试；原文仍保留。');
                if (result.skipReason === 'lock') throw new Error('已有提取任务运行，请稍后再试。');
                setMessage(result.skipReason ? '原文尚未达到整理阈值，可继续检查已有事件盒。' : result.stored ? '记忆已提取并保存。下一步只压缩一个达到条件的事件盒。' : '本批没有提取到新记忆，原文仍保留。可继续检查已有事件盒。');
                advance(1);
            } else if (step === 1) {
                const boxes = await EventBoxDB.getByCharId(char.id);
                const eligible = boxes.filter(box => box.liveMemoryIds.length >= EVENT_BOX_COMPRESSION_THRESHOLD);
                if (!eligible.length) { advance(2); setMessage('没有待压缩事件盒。下一步整理门牌。'); }
                else {
                    const result = await maybeCompressEventBoxes([eligible[0].id], llm, emb, char.name, userName);
                    if (!result.compressed) throw new Error('该事件盒未完成压缩，请稍后重试；不会自动跳到门牌。');
                    const remaining = (await EventBoxDB.getByCharId(char.id)).filter(box => box.liveMemoryIds.length >= EVENT_BOX_COMPRESSION_THRESHOLD).length;
                    if (!remaining) advance(2);
                    setMessage('已压缩 1 个事件盒。' + (remaining ? '还有 ' + remaining + ' 个，点击下一步继续压缩。' : '下一步整理门牌。'));
                }
            } else if (step === 2) {
                const result = await consolidateAllPlates(char.id, char.name, userName, llm);
                advance(3); setMessage('本轮完成，更新了 ' + result.updated.length + ' 块门牌。');
            }
        } catch (error: any) { setMessage(error?.message || '本步失败，请稍后重试。'); }
        finally { running.delete(char.id); setBusy(false); }
    };
    return <details style={{ marginTop: 24, fontSize: 12, color: '#64748b' }}>
        <summary style={{ cursor: 'pointer' }}>低频维护 · API 有频率限制时使用</summary>
        <div style={{ padding: 12, background: '#f8fafc', borderRadius: 12, marginTop: 8 }}>
            <label><input type="checkbox" checked={config.manualMaintenance === true} disabled={busy}
                onChange={event => update({ manualMaintenance: event.target.checked })} /> 手动分步维护（所有角色）</label>
            <p>默认关闭。开启后暂停聊天后的自动提取和认知消化，到角色记忆设置中手动推进。已启动的任务会继续结束。聊天召回照常使用已有记忆；待提取原文会继续保留。</p>
            <label>宫殿请求最小间隔（秒） <input type="number" min={1} max={3600} value={config.maintenanceIntervalSeconds || 60} disabled={busy}
                onChange={event => update({ maintenanceIntervalSeconds: Math.max(1, Math.min(3600, Number(event.target.value) || 60)) })}
                style={{ width: 70, color: '#1e293b', background: 'white', border: '1px solid #cbd5e1' }} /></label>
            <p>默认 60 秒。包括本页宫殿副 API 与向量请求；一步可能包含多个请求，逐个等待。其它设备、主聊天与已提交的云端任务不受这个间隔控制。</p>
            {char && config.manualMaintenance && <button onClick={() => { setStep(readStep(char.id)); setOpen(true); }} style={{ padding: '8px 14px', color: '#fff', background: '#64748b', borderRadius: 8 }}>开始 / 继续维护</button>}
        </div>
        {open && char && <div role="dialog" aria-modal="true" aria-label="低频维护" style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#0008', display: 'grid', placeItems: 'center', padding: 24 }}>
            <div style={{ background: 'white', color: '#334155', padding: 24, borderRadius: 20, maxWidth: 360, width: '100%' }}>
                <h3>{char.name} · {labels[step]}</h3>
                <p>提取记忆 → 逐盒压缩 → 整理门牌。每次点击仅推进当前步骤，完成后停下等待。认知消化仍可在原入口单独手动运行。</p>
                <p role="status" style={{ whiteSpace: 'pre-wrap' }}>{message || '准备好后点击下一步。关闭弹窗会保留步骤。'}</p>
                <div style={{ display: 'flex', gap: 12 }}>
                    <button disabled={busy} onClick={() => setOpen(false)}>稍后继续</button>
                    {step === 3 ? <button disabled={busy} onClick={() => { advance(0); setMessage('准备开始下一轮。'); }}>新一轮</button> : <button disabled={busy} onClick={run}>{busy ? '处理 / 等待中…' : '下一步'}</button>}
                </div>
            </div>
        </div>}
    </details>;
}

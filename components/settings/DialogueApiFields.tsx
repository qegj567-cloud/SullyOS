import React, { useState } from 'react';
import type { DialogueApiConfig } from '../../types';
import { llmApiType } from '../../utils/llmEndpoint';

export default function DialogueApiFields({ value, onChange, fetchModels, isLoadingModels, openModelPicker }: {
 value: DialogueApiConfig; onChange: (patch: Partial<DialogueApiConfig>) => void;
 fetchModels: () => void; isLoadingModels: boolean; openModelPicker: () => void;
}) {
 const { baseUrl: localUrl, apiKey: localKey, model: localModel, stream: localStream = false, temperature: localTemperature = 0.85 } = value;
 const [showApiAdvanced, setShowApiAdvanced] = useState(false);
 const setLocalUrl = (baseUrl: string) => onChange({ baseUrl });
 const setLocalKey = (apiKey: string) => onChange({ apiKey });
 const setLocalTemperature = (temperature: number) => onChange({ temperature });
 return <div className="space-y-4">
                <label className="block text-xs text-slate-500">接口类型
                    <select aria-label="接口类型" value={llmApiType(value)} onChange={e => onChange({apiType:e.target.value as 'openai'|'anthropic'})} className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-2.5 bg-white/50">
                        <option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic 原生 Messages</option>
                    </select>
                </label>
                {llmApiType(value) === 'anthropic' && <p className="text-[10px] text-slate-400 leading-relaxed">直连服务商，启用 5 分钟 Prompt Caching；首次写入缓存也会计费，能否命中取决于模型、长度与前缀是否相同。支持填写根地址、/v1 或完整 /v1/messages。主动消息 2.0 在 Worker 自动更新完成后可用，无需手动重连。</p>}
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
                                通常保持默认即可；如接口有输出额度或流式要求，可按服务商说明调整。
                            </p>
                            <label className="block text-[10px] text-slate-400">
                                私聊最大生成 Token（max_tokens）
                                <input type="number" min={1} step={1} value={value.maxTokens ?? ''} placeholder="跟随全局，默认 8000"
                                    onChange={e => { const n = Number(e.target.value); if (!e.target.value || (Number.isSafeInteger(n) && n > 0)) onChange({ maxTokens: e.target.value ? n : undefined }); }}
                                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                                <span className="block mt-1 text-[9px] leading-relaxed">限制一次回复的输出量，不是历史消息条数。较小值可减少预留额度，过小可能截断回复；历史输入超限仍需调整上下文或归档。需在模型支持范围内填写。</span>
                            </label>
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-[10px] text-slate-400">流式输出 (Stream)</span>
                                    <p className="text-[9px] text-slate-300 mt-0.5">仅在你的 API 强制要求时打开</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => onChange({ stream: !localStream })}
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
                                    max={llmApiType(value) === 'anthropic' ? '1' : '2'}
                                    step="0.05"
                                    value={localTemperature}
                                    onChange={(e) => setLocalTemperature(parseFloat(e.target.value))}
                                    className="w-full accent-slate-400 mt-1"
                                />
                                <p className="text-[9px] text-slate-300 mt-0.5">默认 0.85；用于支持此配置的角色回复</p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="pt-2">
                     <div className="flex justify-between items-center mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                        <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">{isLoadingModels ? '正在拉取…' : '刷新模型列表'}</button>
                    </div>
                    
                    <button
                        onClick={openModelPicker}
                        title={localModel || '选择模型…'}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm"
                    >
                        <span
                            className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left"
                            style={{ direction: 'rtl', textOverflow: 'ellipsis' }}
                        >
                            <bdi style={{ direction: 'ltr' }}>{localModel || '选择模型…'}</bdi>
                        </span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 flex-shrink-0"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                    </button>
                </div>


 </div>;
}

import React, { useState, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { CharacterProfile, DateObservation, DateObserveConfig, DateObserveStyleId } from '../../types';
import { OBSERVE_DIMENSIONS } from '../../utils/datePrompts';
import ObserveHUD, { OBSERVE_STYLES } from './ObserveHUD';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { DateFeatureHeader, DateSettingSwitch } from './DateSettingsControls';

/**
 * 见面设置里的「观测协议 OBSERVE」配置块（默认折叠）：
 *   - 总开关
 *   - HUD 样式选择（全息 / 水墨 / 霓虹 / 水晶 / 终端），带实时预览
 *   - 四个默认维度（时间/地点/状态/细节）：启用开关、HUD 显示标签、生成提示
 *   - 追加自定义维度（最多 6 个）：标签 + 生成提示 + 启用 + 删除
 *   - 一键重置（样式 + 全部字段自定义 + 自定义维度回默认）
 *
 * 所有改动即时写回 char.dateObserve，下一条回复 / 下次渲染生效。
 */

interface ObserveSettingsProps {
    char: CharacterProfile;
}

// 预览用的示例观测（不发请求，纯展示样式）
const SAMPLE: DateObservation = {
    time: '傍晚六点过，天刚擦黑',
    place: '便利店门口的塑料凳上',
    state: '有点疲惫，但见到你眼神亮了一下',
    detail: '指尖无意识地敲着关东煮的纸杯',
};

const MAX_CUSTOM = 6;
const genId = () => 'obs_' + Math.random().toString(36).slice(2, 9);

type FieldDraft = Record<string, { label: string; hint: string }>;

const buildFieldDraft = (char: CharacterProfile): FieldDraft => {
    const f = char.dateObserve?.fields || {};
    const d: FieldDraft = {};
    for (const dim of OBSERVE_DIMENSIONS) d[dim.key] = { label: f[dim.key]?.label || '', hint: f[dim.key]?.hint || '' };
    return d;
};
const buildCustomDraft = (char: CharacterProfile): FieldDraft => {
    const d: FieldDraft = {};
    for (const c of char.dateObserve?.custom || []) d[c.id] = { label: c.label || '', hint: c.hint || '' };
    return d;
};

const ObserveSettings: React.FC<ObserveSettingsProps> = ({ char }) => {
    const { updateCharacter, addToast } = useOS();
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const enabled = !!char.dateObserve?.enabled;
    const style = char.dateObserve?.style || 'hologram';
    const fields = char.dateObserve?.fields || {};
    const customs = char.dateObserve?.custom || [];

    const [open, setOpen] = useState(false); // 默认折叠
    const [draft, setDraft] = useState<FieldDraft>(() => buildFieldDraft(char));
    const [customDraft, setCustomDraft] = useState<FieldDraft>(() => buildCustomDraft(char));
    useEffect(() => { setDraft(buildFieldDraft(char)); setCustomDraft(buildCustomDraft(char)); }, [char.id]);

    const patchObserve = (patch: Partial<DateObserveConfig>) =>
        updateCharacter(char.id, { dateObserve: { ...char.dateObserve, ...patch } });

    // —— 默认维度 ——
    const patchField = (key: keyof DateObservation, partial: Record<string, unknown>) =>
        patchObserve({ fields: { ...fields, [key]: { ...(fields[key] || {}), ...partial } } });
    const commitField = (key: keyof DateObservation, which: 'label' | 'hint') => {
        const v = (draft[key]?.[which] || '').trim();
        if (v === (fields[key]?.[which] || '')) return;
        patchField(key, { [which]: v || undefined });
    };

    // —— 自定义维度 ——
    const addCustom = () => {
        if (customs.length >= MAX_CUSTOM) { addToast(`最多 ${MAX_CUSTOM} 个自定义维度`, 'info'); return; }
        const id = genId();
        patchObserve({ custom: [...customs, { id, label: '', hint: '', enabled: true }] });
        setCustomDraft(d => ({ ...d, [id]: { label: '', hint: '' } }));
    };
    const delCustom = async (id: string) => {
        const target = customs.find(c => c.id === id);
        const label = (target?.label || '').trim();
        const ok = await requestConfirm({
            title: label ? `删除自定义维度「${label}」？` : '删除这个自定义维度？',
            message: '删除后该维度的显示标签与生成提示将一并清除。',
            confirmText: '确认删除',
            variant: 'danger',
        });
        if (!ok) return;
        patchObserve({ custom: customs.filter(c => c.id !== id) });
    };
    const toggleCustom = (id: string, on: boolean) => patchObserve({ custom: customs.map(c => c.id === id ? { ...c, enabled: on } : c) });
    const commitCustom = (id: string, which: 'label' | 'hint') => {
        const cur = customs.find(c => c.id === id);
        if (!cur) return;
        const v = (customDraft[id]?.[which] || '').trim();
        if (v === (cur[which] || '')) return;
        patchObserve({ custom: customs.map(c => c.id === id ? { ...c, [which]: which === 'label' ? v : (v || undefined) } : c) });
    };

    const resetAll = async () => {
        const ok = await requestConfirm({
            title: '重置观测协议设置？',
            message: '将清除所有自定义标题、生成提示词与自定义维度，面板样式恢复默认（总开关状态保留）。',
            confirmText: '确认重置',
            variant: 'warning',
        });
        if (!ok) return;
        updateCharacter(char.id, { dateObserve: { enabled: char.dateObserve?.enabled, style: undefined, fields: undefined, custom: undefined } });
        setDraft(buildFieldDraft({ ...char, dateObserve: { enabled } }));
        setCustomDraft({});
        addToast('观测样式与提示词已重置为默认', 'success');
    };

    // 预览：默认四维用示例文案，自定义维度塞占位内容，让样式预览也能看到追加的格子
    const previewObs: DateObservation = {
        ...SAMPLE,
        extra: Object.fromEntries(
            customs.filter(c => c.enabled !== false && (c.label || '').trim()).map(c => [c.id, '此处显示生成的内容']),
        ),
    };

    return (
        <section className="date-feature">
            <DateFeatureHeader title="观测协议" description={`每条回复附上 ${char.name} 此刻的状态，可独立查看。`}
                open={open} onExpand={() => setOpen(o => !o)} checked={enabled} onChange={enabled => patchObserve({ enabled })} switchLabel="切换观测协议" />

            {open && (
                !enabled ? (
                    <p className="px-4 pb-4 -mt-1 text-[11px] text-slate-400">先打开右上角开关，即可选择面板样式、自定义每格生成什么、追加观察维度。</p>
                ) : (
                <div className="px-4 pb-4 space-y-4">
                    {/* ── 样式选择 ── */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <h4 className="text-[11px] font-bold text-slate-500">面板样式</h4>
                            <button onClick={() => void resetAll()} className="text-[10px] font-bold text-primary/80 hover:text-primary px-2 py-0.5 rounded-full bg-primary/5 active:scale-95 transition-transform">一键重置</button>
                        </div>
                        <div className="grid grid-cols-5 gap-1.5">
                            {OBSERVE_STYLES.map(s => (
                                <button
                                    key={s.id}
                                    onClick={() => patchObserve({ style: s.id as DateObserveStyleId })}
                                    title={s.desc}
                                    className={`flex flex-col items-center gap-1 py-2 rounded-xl border transition-all active:scale-95 ${style === s.id ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-slate-200 hover:border-slate-300'}`}
                                >
                                    <span className="w-7 h-7 rounded-lg shadow-inner" style={{ background: s.swatch }} />
                                    <span className={`text-[10px] font-bold ${style === s.id ? 'text-primary' : 'text-slate-500'}`}>{s.name}</span>
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1.5 leading-snug">{OBSERVE_STYLES.find(s => s.id === style)?.desc}</p>
                    </div>

                    {/* ── 实时预览 ── */}
                    <div>
                        <h4 className="text-[11px] font-bold text-slate-500 mb-2">预览</h4>
                        <div className="rounded-xl p-4 flex justify-center" style={{ background: style === 'ink' ? '#e9e0cd' : 'radial-gradient(circle at 30% 20%, #1e2433, #0a0d16)' }}>
                            <div className="w-full max-w-[260px]">
                                <ObserveHUD observation={previewObs} variant="card" charName={char.name} config={char.dateObserve} />
                            </div>
                        </div>
                    </div>

                    {/* ── 每个维度的提示词与标签自定义 ── */}
                    <div>
                        <h4 className="text-[11px] font-bold text-slate-500 mb-1">每个部分生成什么（自定义提示词）</h4>
                        <p className="text-[10px] text-slate-400 mb-2.5 leading-snug">「显示标签」只改面板上的字样；「生成提示」决定这一格让 AI 写什么。留空即用默认。关掉的维度不会生成、面板上也不显示。</p>
                        <div className="space-y-2.5">
                            {OBSERVE_DIMENSIONS.map(dim => {
                                const on = fields[dim.key]?.enabled !== false;
                                const defHint = dim.hint.replace(/\{name\}/g, char.name);
                                return (
                                    <div key={dim.key} className={`rounded-xl border p-2.5 transition-opacity ${on ? 'border-slate-200 bg-slate-50/60' : 'border-slate-100 bg-slate-50/30 opacity-60'}`}>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-[11px] font-bold text-slate-600 flex items-center gap-1.5"><span className="text-slate-400">{dim.glyph}</span>{dim.label}</span>
                                            <DateSettingSwitch small label={`观测${dim.label}`} checked={on} onChange={enabled => patchField(dim.key, { enabled })} />
                                        </div>
                                        {on && (
                                            <div className="space-y-1.5">
                                                <input
                                                    value={draft[dim.key]?.label || ''}
                                                    onChange={e => setDraft(d => ({ ...d, [dim.key]: { ...d[dim.key], label: e.target.value } }))}
                                                    onBlur={() => commitField(dim.key, 'label')}
                                                    placeholder={`显示标签（默认「${dim.label}」）`}
                                                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white text-slate-800 placeholder:text-slate-400"
                                                />
                                                <textarea
                                                    value={draft[dim.key]?.hint || ''}
                                                    onChange={e => setDraft(d => ({ ...d, [dim.key]: { ...d[dim.key], hint: e.target.value } }))}
                                                    onBlur={() => commitField(dim.key, 'hint')}
                                                    placeholder={`生成提示（默认：${defHint}）`}
                                                    rows={2}
                                                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white text-slate-800 placeholder:text-slate-400 leading-relaxed resize-none"
                                                />
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* ── 追加自定义维度 ── */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <h4 className="text-[11px] font-bold text-slate-500">追加维度</h4>
                            <button
                                onClick={addCustom}
                                disabled={customs.length >= MAX_CUSTOM}
                                className="text-[10px] font-bold text-primary px-2.5 py-1 rounded-full bg-primary/5 hover:bg-primary/10 disabled:opacity-40 active:scale-95 transition-all"
                            >+ 添加（{customs.length}/{MAX_CUSTOM}）</button>
                        </div>
                        <p className="text-[10px] text-slate-400 mb-2.5 leading-snug">在四个默认维度之外，自己开观察项（如「穿着」「天气」「和你的距离」）。标签同时用于 AI 输出与面板显示。</p>
                        {customs.length === 0 ? (
                            <div className="text-[11px] text-slate-300 text-center py-3 border border-dashed border-slate-200 rounded-xl">还没有自定义维度，点「+ 添加」开一格</div>
                        ) : (
                            <div className="space-y-2.5">
                                {customs.map(c => {
                                    const on = c.enabled !== false;
                                    return (
                                        <div key={c.id} className={`rounded-xl border p-2.5 transition-opacity ${on ? 'border-slate-200 bg-slate-50/60' : 'border-slate-100 bg-slate-50/30 opacity-60'}`}>
                                            <div className="flex items-center gap-2 mb-2">
                                                <input
                                                    value={customDraft[c.id]?.label || ''}
                                                    onChange={e => setCustomDraft(d => ({ ...d, [c.id]: { ...d[c.id], label: e.target.value } }))}
                                                    onBlur={() => commitCustom(c.id, 'label')}
                                                    placeholder="维度名（如 穿着 / 天气）"
                                                    className="flex-1 min-w-0 text-[12px] font-bold px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white text-slate-800 placeholder:text-slate-400"
                                                />
                                                <DateSettingSwitch small label={`观测${c.label || '自定义维度'}`} checked={on} onChange={enabled => toggleCustom(c.id, enabled)} />
                                                <button onClick={() => void delCustom(c.id)} title="删除" className="text-slate-300 hover:text-red-400 transition-colors shrink-0 p-0.5">
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                                                </button>
                                            </div>
                                            {on && (
                                                <textarea
                                                    value={customDraft[c.id]?.hint || ''}
                                                    onChange={e => setCustomDraft(d => ({ ...d, [c.id]: { ...d[c.id], hint: e.target.value } }))}
                                                    onBlur={() => commitCustom(c.id, 'hint')}
                                                    placeholder="生成提示：这一格让 AI 写什么（留空给个通用默认）"
                                                    rows={2}
                                                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-slate-200 focus:border-primary focus:outline-none bg-white text-slate-800 placeholder:text-slate-400 leading-relaxed resize-none"
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
                )
            )}
            {confirmDialog}
        </section>
    );
};

export default ObserveSettings;

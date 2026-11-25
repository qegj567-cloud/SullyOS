import React from 'react';
import { CharacterProfile, ApiPreset, APIConfig, CharacterBuff } from '../../types';
import { useOS } from '../../context/OSContext';
import { isScheduleFeatureOn } from '../../utils/scheduleGenerator';
import ApiSlotEditor from '../settings/ApiSlotEditor';

interface EmotionSettingsPanelProps {
    char: CharacterProfile;
    apiPresets?: ApiPreset[];
    addApiPreset?: (name: string, config: APIConfig, group?: string) => void;
    onSave?: (config: NonNullable<CharacterProfile['emotionConfig']>) => void;
    onClearBuffs: () => void;
}

const normalizeIntensity = (n: number | undefined | null): 1 | 2 | 3 => {
    const parsed = Number.isFinite(n) ? Math.round(Number(n)) : 2;
    if (parsed <= 1) return 1;
    if (parsed >= 3) return 3;
    return 2;
};

const INTENSITY_DOTS = (n: number | undefined | null) => {
    const safe = normalizeIntensity(n);
    return '●'.repeat(safe) + '○'.repeat(3 - safe);
};

const EmotionSettingsPanel: React.FC<EmotionSettingsPanelProps> = ({
    char, onSave, onClearBuffs,
}) => {
    const { apiConfig, updateApiConfig } = useOS();
    const buffs: CharacterBuff[] = char.activeBuffs || [];
    const scheduleOn = isScheduleFeatureOn(char);

    return (
        <div className="space-y-4 pt-4 border-t border-slate-100">
            <div>
                <div className="text-xs font-bold text-slate-700 mb-1">🎭 情绪 / 意识流 API</div>
            </div>

            {!scheduleOn && (
                <div className="text-[11px] text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-lg px-3 py-2">
                    尚未选择日程风格。选择「生活系」或「意识系」后，情绪/意识流会自动启用。
                </div>
            )}

            <ApiSlotEditor
                slotName="情绪副API"
                value={apiConfig.emotionApi ?? char.emotionConfig?.api}
                onCommit={(next) => {
                    updateApiConfig({ emotionApi: next });
                    onSave?.({
                        enabled: isScheduleFeatureOn(char),
                        api: next ? { baseUrl: next.baseUrl, apiKey: next.apiKey, model: next.model } : undefined,
                    });
                }}
                followButtonLabel="清空并回退主 API"
                globalScopeNotice="全局共用 · 修改后对所有角色的情绪与意识流评估生效"
                helperText="与日程开关联动：日程开启时自动启用情绪评估。留空时自动使用主对话 API。"
                meta={{ appId: 'chat', appName: '消息', charId: char.id, charName: char.name }}
            />

            {/* Current buffs */}
            {buffs.length > 0 ? (
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">当前情绪状态</label>
                        <button type="button" onClick={onClearBuffs} className="text-xs text-slate-400 hover:text-red-400 transition-colors">清除</button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {buffs.map(buff => (
                            <div
                                key={buff.id}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-bold"
                                style={{
                                    backgroundColor: buff.color ? buff.color + '22' : '#fdf2f8',
                                    color: buff.color || '#db2777',
                                    border: `1px solid ${buff.color ? buff.color + '55' : '#fbcfe8'}`,
                                }}
                            >
                                {buff.emoji && <span>{buff.emoji}</span>}
                                <span>{buff.label}</span>
                                <span className="opacity-60">{INTENSITY_DOTS(buff.intensity)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : scheduleOn ? (
                <div className="text-xs text-slate-400 text-center py-2">
                    暂无情绪状态 — 发几条消息后会自动生成
                </div>
            ) : null}
        </div>
    );
};

export default React.memo(EmotionSettingsPanel);

import React, { useState } from 'react';
import { ApiPreset, APIConfig, CharacterProfile, DialogueApiConfig } from '../../types';
import { CheckSquare, Gear, Square, X } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../../components/character/CharacterGroupFilter';
import ApiSlotEditor from '../../components/settings/ApiSlotEditor';
import { isBlankApiSlot } from '../../utils/apiSlots';
import { pickDialogueApi } from '../../utils/characterApi';
import { trackEvent } from '../../utils/analytics';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import TokenImg from '../../components/os/TokenImg';

const LifeSimSettingsPanel: React.FC<{
    characters: CharacterProfile[];
    selectedCharIds: string[];
    apiPresets: ApiPreset[];
    useIndependentApiConfig: boolean;
    independentApiConfig?: Partial<APIConfig>;
    onToggleChar: (charId: string) => void;
    onSelectAll: () => void;
    onSelectNone: () => void;
    onSaveApiSettings: (next: DialogueApiConfig | undefined) => Promise<void> | void;
    onClose: () => void;
}> = ({
    characters,
    selectedCharIds,
    useIndependentApiConfig,
    independentApiConfig,
    onToggleChar,
    onSelectAll,
    onSelectNone,
    onSaveApiSettings,
    onClose,
}) => {
    // 参与角色多选的分组筛选（characters 由 props 传入，这里单独取 characterGroups）
    const { characterGroups } = useOS();
    const [charGroupId, setCharGroupId] = useState<string>(GROUP_FILTER_ALL);

    useLocalBackHandler(() => {
        onClose();
        return true;
    }, 80);

    const independentApi = independentApiConfig && !isBlankApiSlot(independentApiConfig)
        ? pickDialogueApi(independentApiConfig as DialogueApiConfig)
        : undefined;
    const useIndependent = Boolean(useIndependentApiConfig && independentApi);

    return (
        <div
            className="absolute inset-0 z-40 flex items-end justify-center"
            style={{ background: 'rgba(0,0,0,0.3)' }}
            onClick={event => { if (event.target === event.currentTarget) onClose(); }}
        >
            <div
                className="retro-window w-full mx-2 mb-2"
                style={{
                    maxHeight: '82vh',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '4px 4px 0 rgba(0,0,0,0.2), inset 0 0 0 1px rgba(255,255,255,0.5)',
                    minWidth: 0,
                }}
            >
                <div className="retro-titlebar">
                    <span className="flex items-center gap-1">
                        <Gear size={11} weight="bold" /> lifesim.settings
                    </span>
                    <button
                        onClick={onClose}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 18,
                            height: 18,
                            borderRadius: 3,
                            background: 'rgba(255,255,255,0.15)',
                            border: '1px solid rgba(255,255,255,0.25)',
                            color: 'white',
                        }}
                    >
                        <X size={10} weight="bold" />
                    </button>
                </div>

                <div className="overflow-y-auto overflow-x-hidden no-scrollbar flex-1" style={{ padding: 10 }}>
                    <div className="retro-inset" style={{ padding: '6px 8px', marginBottom: 10 }}>
                        <p style={{ fontSize: 10, color: '#6a6181', lineHeight: 1.6 }}>
                            这里可以分别控制这局 LifeSim 允许哪些角色参与，以及是否给 LifeSim 单独指定一套 API（所有改动自动保存）。
                        </p>
                    </div>

                    <div style={{ fontSize: 10, fontWeight: 700, color: '#6f6780', marginBottom: 6, letterSpacing: '0.04em' }}>
                        参与角色
                    </div>

                    <div className="flex gap-2 mb-2">
                        <button onClick={() => { onSelectAll(); trackEvent('全选参与角色'); }} className="retro-btn" style={{ padding: '4px 10px', fontSize: 10 }}>
                            全选
                        </button>
                        <button onClick={() => { onSelectNone(); trackEvent('清空参与角色'); }} className="retro-btn" style={{ padding: '4px 10px', fontSize: 10 }}>
                            清空
                        </button>
                    </div>

                    {/* 分组筛选（没建分组时不渲染）：只影响显示哪些可选项，已勾选参与者不受影响 */}
                    <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                        value={charGroupId} onChange={setCharGroupId} className="mb-2" />
                    <div className="space-y-1.5">
                        {filterCharactersByGroup(characters, characterGroups, charGroupId).map(char => {
                            const active = selectedCharIds.includes(char.id);
                            return (
                                <button
                                    key={char.id}
                                    onClick={() => onToggleChar(char.id)}
                                    className="w-full text-left"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 10,
                                        padding: 8,
                                        borderRadius: 6,
                                        border: active ? '2px solid rgba(91,143,168,0.55)' : '2px solid rgba(0,0,0,0.08)',
                                        background: active ? 'rgba(123,173,196,0.12)' : 'rgba(255,255,255,0.55)',
                                        minWidth: 0,
                                    }}
                                >
                                    <TokenImg value={char.avatar} alt={char.name} style={{ width: 32, height: 32, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontSize: 11, fontWeight: 700, color: '#504a61' }}>{char.name}</div>
                                        <div style={{ fontSize: 9, color: '#8b8499', lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                                            {char.description || '暂无描述'}
                                        </div>
                                    </div>
                                    <div style={{ color: active ? '#5b8fa8' : '#a7a0b6', flexShrink: 0 }}>
                                        {active ? <CheckSquare size={16} weight="fill" /> : <Square size={16} weight="bold" />}
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    <div className="retro-divider" style={{ margin: '12px 0 10px' }} />

                    <div style={{ fontSize: 10, fontWeight: 700, color: '#6f6780', marginBottom: 6, letterSpacing: '0.04em' }}>
                        LifeSim 独立 API
                    </div>

                    <div className="bg-white/95 rounded-xl p-3 border border-black/10">
                        <ApiSlotEditor
                            slotName="模拟人生"
                            value={useIndependent ? independentApi : undefined}
                            onCommit={(next) => onSaveApiSettings(next)}
                            followButtonLabel="恢复跟随全局主 API"
                            helperText="未配置时使用全局主对话 API；绑定预设或填写后自动保存进当前存档。"
                            meta={{ appId: 'lifesim', appName: '模拟人生' }}
                        />
                    </div>
                </div>

                <div style={{ padding: '6px 10px', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
                    <button
                        onClick={onClose}
                        className="retro-btn w-full"
                        style={{ padding: '7px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    >
                        完成
                    </button>
                </div>
            </div>
        </div>
    );
};

export default LifeSimSettingsPanel;

import React, { useEffect, useState } from 'react';
import { ApiPreset, APIConfig, CharacterProfile } from '../../types';
import { CheckSquare, FloppyDisk, Gear, Square, X } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../../components/character/CharacterGroupFilter';
import { trackEvent } from '../../utils/analytics';
import TokenImg from '../../components/os/TokenImg';

type LifeSimApiDraft = Pick<APIConfig, 'baseUrl' | 'apiKey' | 'model'>;

const EMPTY_API_DRAFT: LifeSimApiDraft = {
    baseUrl: '',
    apiKey: '',
    model: '',
};

const LifeSimSettingsPanel: React.FC<{
    characters: CharacterProfile[];
    selectedCharIds: string[];
    apiPresets: ApiPreset[];
    useIndependentApiConfig: boolean;
    independentApiConfig?: Partial<APIConfig>;
    onToggleChar: (charId: string) => void;
    onSelectAll: () => void;
    onSelectNone: () => void;
    onSaveApiSettings: (payload: { enabled: boolean; config: LifeSimApiDraft }) => Promise<void> | void;
    onClose: () => void;
}> = ({
    characters,
    selectedCharIds,
    apiPresets,
    useIndependentApiConfig,
    independentApiConfig,
    onToggleChar,
    onSelectAll,
    onSelectNone,
    onSaveApiSettings,
    onClose,
}) => {
    const [useIndependentApi, setUseIndependentApi] = useState(useIndependentApiConfig);
    const [draft, setDraft] = useState<LifeSimApiDraft>(EMPTY_API_DRAFT);
    const [isSaving, setIsSaving] = useState(false);
    // 参与角色多选的分组筛选（characters 由 props 传入，这里单独取 characterGroups）
    const { characterGroups } = useOS();
    const [charGroupId, setCharGroupId] = useState<string>(GROUP_FILTER_ALL);

    useEffect(() => {
        setUseIndependentApi(useIndependentApiConfig);
        setDraft({
            baseUrl: independentApiConfig?.baseUrl || '',
            apiKey: independentApiConfig?.apiKey || '',
            model: independentApiConfig?.model || '',
        });
    }, [independentApiConfig, useIndependentApiConfig]);

    const patchDraft = (updates: Partial<LifeSimApiDraft>) => {
        setDraft(prev => ({ ...prev, ...updates }));
    };

    const handleLoadPreset = (preset: ApiPreset) => {
        setDraft({
            baseUrl: preset.config.baseUrl || '',
            apiKey: preset.config.apiKey || '',
            model: preset.config.model || '',
        });
        setUseIndependentApi(true);
    };

    const handleSaveAndClose = async () => {
        if (isSaving) return;
        setIsSaving(true);
        try {
            await onSaveApiSettings({
                enabled: useIndependentApi,
                config: {
                    baseUrl: draft.baseUrl.trim(),
                    apiKey: draft.apiKey.trim(),
                    model: draft.model.trim(),
                },
            });
            onClose();
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div
            className="absolute inset-0 z-40 flex items-end justify-center"
            style={{ background: 'rgba(0,0,0,0.3)' }}
            onClick={event => { if (event.target === event.currentTarget) void handleSaveAndClose(); }}
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
                        onClick={() => void handleSaveAndClose()}
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
                            这里可以分别控制这局 LifeSim 允许哪些角色参与，以及是否给 LifeSim 单独指定一套 API。
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

                    <div className="flex items-center justify-between" style={{ marginBottom: 8, gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: '#6f6780', letterSpacing: '0.04em' }}>
                                LifeSim 独立 API
                            </div>
                            <div style={{ fontSize: 9, color: '#8a8198', lineHeight: 1.5, marginTop: 3 }}>
                                推荐 Gemini Flash 系列，便宜且快，适合这种高频轻剧情生成。
                            </div>
                        </div>
                        <button
                            onClick={() => {
                                // 只在「关 → 开」这一下记一次，且只发事件名：
                                // 填没填 URL / Key 属于配置状态，一律不上报。
                                if (!useIndependentApi) trackEvent('启用独立 API 线路');
                                setUseIndependentApi(value => !value);
                            }}
                            style={{
                                width: 44,
                                height: 24,
                                borderRadius: 999,
                                border: '1px solid rgba(0,0,0,0.1)',
                                background: useIndependentApi ? 'linear-gradient(180deg, #7badc4, #5b8fa8)' : 'rgba(0,0,0,0.12)',
                                position: 'relative',
                                flexShrink: 0,
                            }}
                        >
                            <span
                                style={{
                                    position: 'absolute',
                                    top: 2,
                                    left: useIndependentApi ? 22 : 2,
                                    width: 18,
                                    height: 18,
                                    borderRadius: 999,
                                    background: '#fff',
                                    boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
                                    transition: 'left 0.15s ease',
                                }}
                            />
                        </button>
                    </div>

                    <div className="retro-inset" style={{ padding: '6px 8px', marginBottom: 8 }}>
                        <p style={{ fontSize: 9, color: '#80778e', lineHeight: 1.6 }}>
                            {useIndependentApi
                                ? '开启后，LifeSim 会优先使用下面这套配置；没填的字段会回退到全局 API。'
                                : '关闭时，LifeSim 直接沿用系统全局 API。'}
                        </p>
                    </div>

                    {useIndependentApi && (
                        <>
                            {apiPresets.length > 0 && (
                                <div style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: 9, fontWeight: 700, color: '#7b7289', marginBottom: 5 }}>
                                        预设
                                    </div>
                                    <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                                        {apiPresets.map(preset => (
                                            <button
                                                key={preset.id}
                                                onClick={() => handleLoadPreset(preset)}
                                                className="retro-btn"
                                                style={{
                                                    padding: '4px 10px',
                                                    fontSize: 9,
                                                    whiteSpace: 'nowrap',
                                                    flexShrink: 0,
                                                }}
                                            >
                                                {preset.name} · {preset.config.model}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="space-y-3">
                                <div>
                                    <label style={{ fontSize: 9, fontWeight: 700, color: '#7b7289', marginBottom: 4, display: 'block' }}>
                                        URL
                                    </label>
                                    <input
                                        type="text"
                                        value={draft.baseUrl}
                                        onChange={event => patchDraft({ baseUrl: event.target.value })}
                                        placeholder="https://..."
                                        className="w-full"
                                        style={{
                                            background: 'rgba(255,255,255,0.72)',
                                            color: '#1f2937',
                                            border: '1px solid rgba(0,0,0,0.1)',
                                            borderRadius: 6,
                                            padding: '8px 10px',
                                            fontSize: 10,
                                            fontFamily: 'monospace',
                                        }}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: 9, fontWeight: 700, color: '#7b7289', marginBottom: 4, display: 'block' }}>
                                        API Key
                                    </label>
                                    <input
                                        type="password"
                                        value={draft.apiKey}
                                        onChange={event => patchDraft({ apiKey: event.target.value })}
                                        placeholder="sk-..."
                                        className="w-full"
                                        style={{
                                            background: 'rgba(255,255,255,0.72)',
                                            color: '#1f2937',
                                            border: '1px solid rgba(0,0,0,0.1)',
                                            borderRadius: 6,
                                            padding: '8px 10px',
                                            fontSize: 10,
                                            fontFamily: 'monospace',
                                        }}
                                    />
                                </div>
                                <div>
                                    <label style={{ fontSize: 9, fontWeight: 700, color: '#7b7289', marginBottom: 4, display: 'block' }}>
                                        Model
                                    </label>
                                    <input
                                        type="text"
                                        value={draft.model}
                                        onChange={event => patchDraft({ model: event.target.value })}
                                        placeholder="gemini-2.0-flash / gemini-2.5-flash-lite / ..."
                                        className="w-full"
                                        style={{
                                            background: 'rgba(255,255,255,0.72)',
                                            color: '#1f2937',
                                            border: '1px solid rgba(0,0,0,0.1)',
                                            borderRadius: 6,
                                            padding: '8px 10px',
                                            fontSize: 10,
                                            fontFamily: 'monospace',
                                        }}
                                    />
                                </div>
                            </div>
                        </>
                    )}
                </div>

                <div style={{ padding: '6px 10px', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
                    <button
                        onClick={() => void handleSaveAndClose()}
                        className="retro-btn w-full"
                        style={{ padding: '7px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                        disabled={isSaving}
                    >
                        <FloppyDisk size={12} weight="bold" /> {isSaving ? '保存中...' : '保存并关闭'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default LifeSimSettingsPanel;

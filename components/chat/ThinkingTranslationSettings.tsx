import React, { useState } from 'react';
import type { ApiPreset, DialogueApiConfig } from '../../types';
import { describeDialogueApi, pickDialogueApi } from '../../utils/characterApi';
import { configFromPreset } from '../../utils/apiPresetSwitch';
import { validateThinkingTranslationApi } from '../../utils/thinkingTranslation';

export default function ThinkingTranslationSettings({ value, dialogueApi, presets = [], onChange, onAddPreset }: {
    value?: DialogueApiConfig; dialogueApi: DialogueApiConfig; presets?: ApiPreset[];
    onChange: (api: DialogueApiConfig | undefined) => void;
    onAddPreset?: (name: string, api: DialogueApiConfig) => void;
}) {
    const [draft, setDraft] = useState<DialogueApiConfig | null>(null);
    const [presetName, setPresetName] = useState('');
    const [savePreset, setSavePreset] = useState(false);
    const [error, setError] = useState('');
    const groups = new Map<string, ApiPreset[]>();
    for (const preset of presets) {
        const group = preset.group?.trim() || '未分组';
        groups.set(group, [...(groups.get(group) || []), preset]);
    }
    const save = () => {
        if (!draft) return;
        try {
            const api = validateThinkingTranslationApi(draft);
            if (savePreset && !presetName.trim()) throw new Error('请给新预设起个名字');
            onChange(api);
            if (savePreset) onAddPreset?.(presetName.trim(), api);
            setDraft(null); setError('');
        } catch (err) { setError(err instanceof Error ? err.message : '保存失败，请重试'); }
    };
    return <section className="thinking-translation-settings">
        <div className="thinking-setting-heading"><h3>翻译 API</h3><button type="button" onClick={() => {
            setDraft(value ? pickDialogueApi(value) : { baseUrl: '', apiKey: '', model: '' });
            setError(''); setSavePreset(false); setPresetName('心象翻译');
        }}>{value ? '修改' : '配置'}</button></div>
        <p>{value ? describeDialogueApi(value) : '尚未配置'}</p>
        <p className="thinking-setting-hint">长按心象选择翻译时才调用，可选便宜模型。所有角色共用，译文保存后不重复调用。</p>
        {draft && <div className="thinking-api-editor">
            {presets.length > 0 && <label>从已有预设载入<select aria-label="心象翻译 API 预设" value="" onChange={event => {
                const preset = presets.find(row => row.id === event.target.value);
                if (preset) { setDraft(configFromPreset(preset)); setError(''); }
            }}><option value="" disabled>选择 API 预设</option>{[...groups].map(([group, rows]) => <optgroup key={group} label={group}>
                {rows.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </optgroup>)}</select></label>}
            <button type="button" className="thinking-api-use-current" onClick={() => { setDraft(pickDialogueApi(dialogueApi)); setError(''); }}>载入当前对话 API</button>
            <label>接口类型<select aria-label="翻译接口类型" value={draft.apiType || 'openai'} onChange={e => setDraft({ ...draft, apiType: e.target.value as 'openai' | 'anthropic' })}>
                <option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic 原生</option>
            </select></label>
            <label>API 地址<input aria-label="翻译 API 地址" value={draft.baseUrl} placeholder="https://…/v1" autoCapitalize="none" spellCheck={false} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
            <label>API Key<input aria-label="翻译 API Key" type="password" autoComplete="off" value={draft.apiKey} placeholder="sk-…" onChange={e => setDraft({ ...draft, apiKey: e.target.value })} /></label>
            <label>模型<input aria-label="翻译模型" value={draft.model} autoCapitalize="none" spellCheck={false} placeholder="输入模型名称，或载入预设" onChange={e => setDraft({ ...draft, model: e.target.value })} /></label>
            <details className="thinking-api-advanced"><summary>更多参数</summary>
                <label>输出上限<input aria-label="翻译输出上限" type="number" min={1} step={1} value={draft.maxTokens ?? ''} placeholder="默认 8000" onChange={e => {
                    const count = Number(e.target.value);
                    if (!e.target.value || (Number.isSafeInteger(count) && count > 0)) setDraft({ ...draft, maxTokens: e.target.value ? count : undefined });
                }} /></label>
                <label className="thinking-api-check"><input type="checkbox" checked={draft.stream === true} onChange={e => setDraft({ ...draft, stream: e.target.checked })} />接口需要流式输出</label>
            </details>
            {onAddPreset && <><label className="thinking-api-check"><input type="checkbox" checked={savePreset} onChange={e => setSavePreset(e.target.checked)} />同时存为新的 API 预设</label>
                {savePreset && <input aria-label="翻译预设名称" value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="预设名称" />}</>}
            {error && <p role="alert" className="thinking-settings-error">{error}</p>}
            <div className="thinking-api-actions"><button type="button" onClick={() => { setDraft(null); setError(''); }}>取消</button><button type="button" onClick={save}>保存翻译 API</button></div>
        </div>}
    </section>;
}

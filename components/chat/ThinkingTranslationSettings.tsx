import React from 'react';
import type { ApiPreset, DialogueApiConfig } from '../../types';
import { describeDialogueApi } from '../../utils/characterApi';
import ApiSlotEditor from '../settings/ApiSlotEditor';

export default function ThinkingTranslationSettings({ value, dialogueApi, presets, onChange }: {
    value?: DialogueApiConfig;
    dialogueApi: DialogueApiConfig;
    presets?: ApiPreset[];
    onChange: (api: DialogueApiConfig | undefined) => void;
    onAddPreset?: (name: string, api: DialogueApiConfig) => void;
}) {
    return (
        <section className="thinking-translation-settings">
            <div className="thinking-setting-heading mb-2">
                <h3>翻译 API</h3>
            </div>
            <ApiSlotEditor
                slotName="心象翻译"
                value={value}
                onCommit={(next) => onChange(next)}
                followButtonLabel="清空并回退主 API"
                followSummary={describeDialogueApi(dialogueApi, presets)}
                globalScopeNotice="全局共用 · 所有角色共用，译文保存后不重复调用"
                helperText="长按心象卡片选择翻译时调用。未单独配置时默认回退使用主对话 API；也可绑定便宜模型预设。"
                meta={{ appId: 'chat', appName: '心象翻译' }}
            />
        </section>
    );
}

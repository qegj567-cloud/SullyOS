import React, { useState } from 'react';
import SettingsSelect from './SettingsSelect';
import './dialogueApiFields.css';
import type { DialogueApiConfig } from '../../types';
import { llmApiType } from '../../utils/llmEndpoint';

export default function DialogueApiFields({
  value,
  onChange,
  fetchModels,
  isLoadingModels,
  models = [],
  onSelectModel,
  onUrlBlur,
  onFieldBlur,
  modelPlaceholder = '输入或选择模型…',
}: {
  value: DialogueApiConfig;
  onChange: (patch: Partial<DialogueApiConfig>) => void;
  fetchModels: () => void;
  isLoadingModels: boolean;
  models?: string[];
  onSelectModel?: (model: string) => void;
  onUrlBlur?: () => void;
  onFieldBlur?: () => void;
  modelPlaceholder?: string;
}) {
  const {
    baseUrl: localUrl,
    apiKey: localKey,
    model: localModel,
    stream: localStream = false,
    temperature: localTemperature = 0.85,
  } = value;
  const [manualModel, setManualModel] = useState(false);
  const [showApiAdvanced, setShowApiAdvanced] = useState(false);
  const setLocalUrl = (baseUrl: string) => onChange({ baseUrl });
  const setLocalKey = (apiKey: string) => onChange({ apiKey });
  const setLocalModel = (model: string) => onChange({ model });
  const setLocalTemperature = (temperature: number) => onChange({ temperature });
  const currentApiType = llmApiType(value);

  return (
    <div className="dialogue-api-fields text-slate-800">
      <div className="api-field-row"><span>接口类型</span>
        <SettingsSelect label="接口类型" value={currentApiType} onChange={next => {
          const nextType = next as 'openai' | 'anthropic';
          const patch: Partial<DialogueApiConfig> = { apiType: nextType };
          if (nextType === 'anthropic' && typeof value.temperature === 'number' && value.temperature > 1) patch.temperature = 1;
          onChange(patch);
        }} options={[{ value: 'openai', label: 'OpenAI 兼容', description: '适用于支持 OpenAI 格式的接口' }, { value: 'anthropic', label: 'Anthropic 原生 Messages', description: '适用于原生 Messages 接口' }]} />
      </div>
      {currentApiType === 'anthropic' && (
        <p className="text-[10px] text-slate-400 leading-relaxed">
          直连服务商，启用 5 分钟 Prompt Caching；首次写入缓存也会计费，能否命中取决于模型、长度与前缀是否相同。支持填写根地址、/v1 或完整 /v1/messages。主动消息 2.0 在 Worker 自动更新完成后可用，无需手动重连。
        </p>
      )}
      <div className="api-field-row" data-api-field="base-url">
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
        <input
          type="text"
          value={localUrl}
          onChange={(e) => setLocalUrl(e.target.value)}
          onBlur={() => {
            onUrlBlur?.();
            onFieldBlur?.();
          }}
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://..."
          className="w-full bg-white/80 text-slate-800 border border-slate-200/80 rounded-xl px-3 py-2 text-sm font-mono placeholder:text-slate-400 focus:bg-white transition-all"
        />
      </div>

      <div className="api-field-row">
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
        <input
          type="password"
          value={localKey}
          onChange={(e) => setLocalKey(e.target.value)}
          onBlur={() => onFieldBlur?.()}
          autoComplete="off"
          placeholder="sk-...（本地免密模型可留空）"
          className="w-full bg-white/80 text-slate-800 border border-slate-200/80 rounded-xl px-3 py-2 text-sm font-mono placeholder:text-slate-400 focus:bg-white transition-all"
        />
      </div>

      <div className="pt-1">
        <button
          type="button"
          onClick={() => setShowApiAdvanced((v) => !v)}
          className="text-[10px] text-slate-400 hover:text-slate-600 transition-colors flex items-center gap-1 pl-1 active:scale-95"
        >
          <span>高级（不建议修改）</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`w-2.5 h-2.5 transition-transform ${showApiAdvanced ? 'rotate-180' : ''}`}
          >
            <path
              fillRule="evenodd"
              d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        {showApiAdvanced && (
          <div className="mt-2 pl-2 border-l-2 border-slate-100 space-y-3 py-2">
            <p className="text-[10px] text-slate-400 leading-relaxed">
              通常保持默认即可；如接口有输出额度或流式要求，可按服务商说明调整。
            </p>
            <label className="block text-[10px] text-slate-500">
              私聊最大生成 Token（max_tokens）
              <input
                type="number"
                min={1}
                step={1}
                value={value.maxTokens ?? ''}
                placeholder="跟随全局，默认 8000"
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (!raw) {
                    onChange({ maxTokens: undefined });
                    return;
                  }
                  const n = Number(raw);
                  if (Number.isSafeInteger(n) && n > 0) onChange({ maxTokens: n });
                }}
                onBlur={() => onFieldBlur?.()}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white text-slate-800 px-3 py-2 text-sm"
              />
              <span className="block mt-1 text-[9px] text-slate-400 leading-relaxed">
                限制一次回复的输出量，不是历史消息条数。较小值可减少预留额度，过小可能截断回复；历史输入超限仍需调整上下文或归档。
              </span>
            </label>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] text-slate-500">流式输出 (Stream)</span>
                <p className="text-[9px] text-slate-400 mt-0.5">仅在你的 API 强制要求时打开</p>
              </div>
              <button
                type="button"
                onClick={() => onChange({ stream: !localStream })}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${localStream ? 'bg-primary' : 'bg-slate-200'}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${localStream ? 'translate-x-4' : 'translate-x-0.5'}`}
                />
              </button>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-500">温度 (Temperature)</span>
                <span className="text-[10px] font-mono text-slate-500">{localTemperature.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0"
                max={currentApiType === 'anthropic' ? '1' : '2'}
                step="0.05"
                value={localTemperature}
                onChange={(e) => setLocalTemperature(parseFloat(e.target.value))}
                onMouseUp={() => onFieldBlur?.()}
                onTouchEnd={() => onFieldBlur?.()}
                className="w-full accent-slate-500 mt-1"
              />
              <p className="text-[9px] text-slate-400 mt-0.5">默认 0.85；用于支持此配置的角色回复</p>
            </div>
          </div>
        )}
      </div>

      <div className="pt-2">
        <div className="flex justify-between items-center mb-1.5 pl-1">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
          <button
            type="button"
            onClick={fetchModels}
            disabled={isLoadingModels}
            className="text-[10px] text-primary font-bold disabled:opacity-50"
          >
            {isLoadingModels ? '正在拉取…' : '刷新模型列表'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          {models.length > 0 && !manualModel ? (
            <select aria-label="模型" value={localModel}
              onChange={event => (onSelectModel ?? setLocalModel)(event.target.value)}
              className="min-w-0 w-full bg-white text-slate-800 border border-slate-200/80 rounded-2xl px-3 py-2.5 text-sm font-mono [color-scheme:light]">
              {!models.includes(localModel) && <option value={localModel}>{localModel || '选择模型'}</option>}
              {models.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
          ) : (
            <input aria-label="模型" type="text" value={localModel} onChange={event => setLocalModel(event.target.value)}
              onBlur={() => onFieldBlur?.()} placeholder={modelPlaceholder} autoCapitalize="none" spellCheck={false}
              className="min-w-0 w-full bg-white text-slate-800 border border-slate-200/80 rounded-2xl px-3 py-2.5 text-sm font-mono" />
          )}
          {models.length > 0 && <button type="button" onClick={() => setManualModel(value => !value)} className="shrink-0 min-h-11 px-2 text-xs text-slate-500">
            {manualModel ? '从列表选择' : '手动输入'}
          </button>}
        </div>
      </div>
    </div>
  );
}

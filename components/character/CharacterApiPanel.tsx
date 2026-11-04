import React, { useRef, useState } from 'react';
import type { CharacterProfile, DialogueApiConfig } from '../../types';
import { useOS } from '../../context/OSContext';
import { describeDialogueApi, pickDialogueApi } from '../../utils/characterApi';
import { configFromPreset, findActivePresetId } from '../../utils/apiPresetSwitch';
import { extractModelIds } from '../../utils/modelList';
import { extractContent, safeResponseJson } from '../../utils/safeApi';
import Modal from '../os/Modal';
import DialogueApiFields from '../settings/DialogueApiFields';
import ModelPicker from '../settings/ModelPicker';
import ApiPresetGroups from '../settings/ApiPresetGroups';
import { fetchLlm } from '../../utils/anthropicApi';

export default function CharacterApiPanel({ character, onChange }: {
  character: CharacterProfile;
  onChange: (api: DialogueApiConfig | undefined) => void;
}) {
  const { apiConfig, apiPresets, availableModels } = useOS();
  const [draft, setDraft] = useState<DialogueApiConfig | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [picker, setPicker] = useState(false);
  const [pickerModel, setPickerModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState('');
  const requestVersion = useRef(0);
  const close = () => {
    requestVersion.current += 1;
    setDraft(null); setPicker(false); setLoading(false); setTesting(false); setStatus('');
  };
  const changeDraft = (patch: Partial<DialogueApiConfig>) => {
    // A response from the previous provider must never populate the next provider's picker.
    requestVersion.current += 1;
    setLoading(false); setTesting(false); setStatus('');
    if (patch.baseUrl !== undefined || patch.apiKey !== undefined || patch.apiType !== undefined) setModels([]);
    setDraft(previous => previous ? { ...previous, ...patch } : previous);
  };
  const open = () => {
    const source = character.dialogueApi || apiConfig;
    setDraft(pickDialogueApi(source));
    setModels(source.baseUrl === apiConfig.baseUrl && source.apiKey === apiConfig.apiKey ? availableModels : []);
    setStatus('');
  };
  const fetchModels = async () => {
    if (!draft) return;
    const api = pickDialogueApi(draft);
    if (!api.baseUrl) { setStatus('请先填写 API URL'); return; }
    const version = ++requestVersion.current;
    setLoading(true); setStatus('');
    try {
      const response = await fetchLlm(`${api.baseUrl}/models`, { headers: { Authorization: `Bearer ${api.apiKey || 'sk-none'}` } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = extractModelIds(await response.json());
      if (version !== requestVersion.current) return;
      setModels(next);
      setStatus(next.length ? `获取到 ${next.length} 个模型` : '模型列表为空，可手动输入');
      setPickerModel(api.model || next[0] || ''); setPicker(true);
    } catch (error) {
      if (version === requestVersion.current) setStatus(`获取失败：${error instanceof Error ? error.message : '请检查配置'}`);
    } finally { if (version === requestVersion.current) setLoading(false); }
  };
  const testConnection = async () => {
    if (!draft) return;
    const api = pickDialogueApi(draft);
    const version = ++requestVersion.current;
    setTesting(true); setStatus('');
    try {
      const response = await fetchLlm(`${api.baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || 'sk-none'}` },
        body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5, stream: api.stream ?? false }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const content = extractContent(await safeResponseJson(response));
      if (version === requestVersion.current) setStatus(content ? '连接成功' : '接口已响应，但回复为空');
    } catch (error) {
      if (version === requestVersion.current) setStatus(`连接失败：${error instanceof Error ? error.message : '请检查配置'}`);
    } finally { if (version === requestVersion.current) setTesting(false); }
  };
  const save = () => {
    if (!draft) return;
    const api = pickDialogueApi(draft);
    if (!api.baseUrl || !api.model) { setStatus('请填写 API URL 和模型'); return; }
    try {
      const url = new URL(api.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { setStatus('请填写有效的 HTTP / HTTPS API 地址'); return; }
    onChange(api); close();
  };
  const activePreset = draft ? findActivePresetId(apiPresets, draft) : null;
  return <section className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-3">
    <h3 className="text-xs font-bold text-slate-700">独立 API</h3>
    <p className="text-xs text-slate-600 break-words" data-testid="character-api-status">
      {character.dialogueApi ? '目前使用的为：' : '目前跟随设置中的 API：'}
      {describeDialogueApi(character.dialogueApi || apiConfig)}
    </p>
    <p className="text-[11px] text-slate-400 leading-relaxed">用于私聊、见面、电话、群聊逐人回复、彼方角色活动和主动消息。App 独立 API 优先；TRPG 等统一生成和记忆、情绪、识图、语音合成仍用原配置。</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={open} className="px-3 py-2 text-xs font-bold rounded-xl bg-primary/10 text-primary active:scale-95 transition-transform">
        {character.dialogueApi ? '修改独立 API' : '为角色使用独立 API'}
      </button>
      {character.dialogueApi && <button type="button" onClick={() => onChange(undefined)} className="px-3 py-2 text-xs text-slate-500 rounded-xl bg-slate-100">跟随设置中的 API</button>}
    </div>
    <Modal isOpen={!!draft && !picker} title="角色独立 API" onClose={close} footer={<>
      <button type="button" onClick={close} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl">取消</button>
      <button type="button" onClick={save} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">确定</button>
    </>}>
      {draft && <div className="space-y-4">
        {apiPresets.length > 0 && <div className="space-y-2">
          <h4 className="text-[10px] font-bold text-slate-400 tracking-widest">API 预设</h4>
          <ApiPresetGroups presets={apiPresets}>{preset => <button key={preset.id} type="button"
            onClick={() => changeDraft(configFromPreset(preset))}
            className={`rounded-lg px-3 py-2 text-xs border ${activePreset === preset.id ? 'bg-primary/5 border-primary/30 text-primary' : 'bg-white border-slate-200 text-slate-600'}`}>
            {preset.name}{activePreset === preset.id ? ' · 已选' : ''}
          </button>}</ApiPresetGroups>
          <p className="text-[10px] text-slate-400">与设置共用预设及分组；点确定后只应用到当前角色。</p>
        </div>}
        <DialogueApiFields value={draft} onChange={changeDraft} fetchModels={fetchModels} isLoadingModels={loading}
          openModelPicker={() => { setPickerModel(draft.model); setPicker(true); }} />
        <button type="button" onClick={testConnection} disabled={testing || !draft.baseUrl.trim() || !draft.model.trim()}
          className="w-full py-2.5 rounded-xl border border-primary/30 text-primary text-xs font-bold disabled:opacity-40">
          {testing ? '测试中…' : '测试连接'}
        </button>
        {status && <p role="status" className="text-xs text-slate-500 break-words">{status}</p>}
      </div>}
    </Modal>
    <Modal isOpen={!!draft && picker} title="选择模型" onClose={() => setPicker(false)}>
      <ModelPicker availableModels={models} localModel={pickerModel} setLocalModel={setPickerModel}
        confirmModelPicker={model => { changeDraft({ model }); setPicker(false); }} />
    </Modal>
  </section>;
}

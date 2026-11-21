import React, { useState } from 'react';
import type { CompanionSttConfig } from '../../types';
import { normalizeApiCredential } from '../../utils/apiConfigNormalize';
import { testCompanionStt } from '../../utils/companion/apiTests';
import { CompanionApiTest } from '../companion/CompanionApiTest';

/** Keep credential drafts in the parent settings form so every save path sees the same values. */
export function useDoubaoSpeechDraft(config?: CompanionSttConfig) {
  const [key, setKey] = useState('');
  const [clear, setClear] = useState(false);
  const [spec, setSpec] = useState<CompanionSttConfig['resourceId']>();
  const reset = () => { setKey(''); setClear(false); setSpec(undefined); };
  React.useEffect(reset, [config?.apiKey, config?.resourceId]);
  const resourceId = spec ?? config?.resourceId ?? 'volc.seedasr.sauc.duration';
  const apiKey = normalizeApiCredential(key) || (clear ? '' : config?.apiKey ?? '');
  const savedMode = apiKey ? config?.provider ?? 'browser' : 'browser';
  const configDraft: CompanionSttConfig = { provider: savedMode, resourceId, apiKey };
  return { key, setKey, clear, setClear, resourceId, setSpec, reset, configDraft,
    edited: Boolean(key || clear || spec), hasSavedKey: Boolean(config?.apiKey) };
}

export function DoubaoSpeechSettings({ form, save }: {
  form: ReturnType<typeof useDoubaoSpeechDraft>;
  save(config: CompanionSttConfig): void;
}) {
  const { key, setKey, clear, setClear, resourceId, setSpec, configDraft } = form;
  const draft: CompanionSttConfig = { ...configDraft, provider: 'doubao' };
  const apiKey = draft.apiKey;
  return <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700">
    <strong>豆包流式语音识别 2.0</strong>
    <p>电话听写和同行连续听共用这一份语音 Key。已有同行测试配置会自动显示为已保存。</p>
    <label className="block">豆包语音 API Key<input aria-label="豆包语音 API Key" type="password" autoComplete="off"
      className="mt-1 block w-full rounded border p-2" value={key} onChange={e => setKey(e.target.value)}
      placeholder={form.hasSavedKey ? '已保存，留空沿用' : '填写豆包语音控制台的 Key'}/></label>
    {form.hasSavedKey && <label className="flex gap-2"><input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)}/>移除已保存的 Key</label>}
    <label className="block">服务规格<select aria-label="豆包识别服务规格" className="ml-2 rounded border p-1" value={resourceId} onChange={e => setSpec(e.target.value as typeof resourceId)}>
      <option value="volc.seedasr.sauc.duration">小时版</option><option value="volc.seedasr.sauc.concurrent">并发版</option>
    </select></label>
    <div className="flex flex-wrap gap-3 text-primary underline">
      <a href="https://console.volcengine.com/speech/new/overview" target="_blank" rel="noreferrer">开通豆包语音</a>
      <a href="https://console.volcengine.com/speech/new/setting/apikeys?projectName=default" target="_blank" rel="noreferrer">获取语音 Key</a>
    </div>
    <p>开始识别后，麦克风音频和语音 Key 经应用语音代理发给豆包。Key 保存在本机并随系统配置备份。</p>
    <CompanionApiTest label="测试豆包语音识别" description="说一句话并停顿，显示识别文字后自动停止。测试使用当前填写的 Key。" config={draft}
      disabled={!apiKey} begin={() => {}} run={(signal, progress) => testCompanionStt(draft, signal, progress)}/>
    <button type="button" className="rounded-lg bg-primary px-3 py-2 font-semibold text-white disabled:opacity-40" disabled={!apiKey && !clear}
      onClick={() => { save({ ...draft, provider: apiKey ? 'doubao' : 'browser' }); form.reset(); }}>
      {clear && !apiKey ? '确认移除豆包 Key' : '保存并使用豆包'}</button>
  </div>;
}

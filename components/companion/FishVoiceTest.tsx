import React, { useState } from 'react';
import type { APIConfig, CharacterProfile } from '../../types';
import { canSynthesizeSpeech } from '../../utils/ttsRouter';
import { normalizeFishReferenceId } from '../../utils/fishAudioTts';
import { testCompanionVoice } from '../../utils/companion/apiTests';
import { CompanionApiTest, type BeginCompanionTest } from './CompanionApiTest';

/** A real Fish request using this form's credentials, without changing the active engine. */
export function FishVoiceTest({ api, characters, begin = () => {} }: {
  api: APIConfig; characters: CharacterProfile[]; begin?: BeginCompanionTest;
}) {
  const [selectedId, setSelectedId] = useState('');
  const char = characters.find(item => item.id === selectedId)
    ?? characters.find(item => item.voiceProfile?.fishReferenceId) ?? characters[0];
  const fishApi: APIConfig = { ...api, ttsProvider: 'fishaudio' };
  const reference = normalizeFishReferenceId(char?.voiceProfile?.fishReferenceId);
  const model = char?.voiceProfile?.fishModel?.trim() || api.fishAudioModel?.trim() || 's2.1-pro';
  return <div className="companion-fish-test">
    {characters.length > 1 && <label>试听角色<select aria-label="鱼声试听角色" value={char?.id || ''} onChange={event => setSelectedId(event.target.value)}>
      {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>}
    <p>鱼声模型：{model} · 音色：{reference || '尚未配置 Reference ID'}</p>
    <CompanionApiTest label="测试鱼声并试听" config={{ apiKey: api.fishAudioApiKey, model, reference, charId: char?.id, speed: char?.voiceProfile?.speed }}
      description="使用当前填写的鱼声 Key 和角色音色，发送固定短句并播放；不读旧音频缓存、不保存配置或切换引擎，可能产生少量语音用量。"
      disabled={!char || !canSynthesizeSpeech(char, fishApi)} begin={begin}
      run={(signal, progress) => testCompanionVoice(fishApi, char!, signal, progress)}/>
    {!char ? <p>请先添加角色，再配置鱼声音色。</p> : !reference ? <p>请到「神经链接 → 当前角色 → 设定」填写鱼声 Reference ID。</p>
      : !canSynthesizeSpeech(char, fishApi) && <p>请填写鱼声 API Key 后测试。</p>}
  </div>;
}

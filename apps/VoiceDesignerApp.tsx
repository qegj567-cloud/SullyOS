import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SpeakerHigh, PlayCircle, StopCircle, Plus, Trash, FloppyDisk, Lock, Check, Warning } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { resolveMiniMaxApiKey } from '../utils/minimaxApiKey';
import { fetchMiniMaxVoices, MiniMaxVoiceItem } from '../utils/minimaxVoice';
import { safeResponseJson } from '../utils/safeApi';
import { formatUnknownError } from '../utils/errorSelfCheck';
import { minimaxFetch } from '../utils/minimaxEndpoint';
import { getCachedTts, saveCachedTts } from '../utils/ttsCache';
import { trackEvent } from '../utils/analytics';
import { buildMiniMaxTtsCacheKey, buildMiniMaxTtsPayload, getMiniMaxParamVersion, type MiniMaxParamVersion } from '../utils/minimaxTts';

const DEFAULT_MODEL = 'speech-2.8-hd';
// 多语言试听样例：点一下切换试听文本 + 对应 language_boost，方便听不同语种下的发音
const PREVIEW_SAMPLES: { code: string; label: string; boost: string; text: string }[] = [
  { code: 'zh', label: '中文', boost: 'Chinese', text: '你好呀，这是捏出来的新声音，听听看喜不喜欢？' },
  { code: 'yue', label: '粤语', boost: 'Chinese,Yue', text: '你好呀，呢把聲係我啱啱整好嘅，聽下鍾唔鍾意？' },
  { code: 'en', label: 'English', boost: 'English', text: 'Hey, this is the new voice I just put together — what do you think?' },
  { code: 'ja', label: '日本語', boost: 'Japanese', text: 'こんにちは、これは新しく作った声だよ。気に入ってくれるといいな。' },
  { code: 'ko', label: '한국어', boost: 'Korean', text: '안녕, 이건 내가 새로 만든 목소리야. 마음에 들었으면 좋겠다.' },
  { code: 'fr', label: 'Français', boost: 'French', text: "Bonjour, voici la nouvelle voix que je viens de créer. Elle te plaît ?" },
  { code: 'es', label: 'Español', boost: 'Spanish', text: 'Hola, esta es la nueva voz que acabo de crear. ¿Te gusta?' },
];
const PREVIEW_TEXT = PREVIEW_SAMPLES[0].text;
const SOUND_EFFECTS_OPTIONS = [
  { value: '', label: '无音效' },
  { value: 'spacious_echo', label: '空旷回声' },
  { value: 'auditorium_echo', label: '礼堂回声' },
  { value: 'lofi_telephone', label: 'LoFi 电话' },
];

interface TimberWeight {
  id: string;
  voice_id: string;
  voice_name: string;
  weight: number;
}

const convertHexAudioToBlob = (hexAudio: string, mimeType = 'audio/mpeg'): Blob => {
  const cleanHex = hexAudio.trim().replace(/^0x/i, '');
  if (!cleanHex || cleanHex.length % 2 !== 0 || /[^\da-f]/i.test(cleanHex)) {
    throw new Error('MiniMax 返回的 HEX 音频数据格式异常');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return new Blob([bytes], { type: mimeType });
};

const fetchRemoteAudioBlob = async (sourceUrl: string): Promise<Blob> => {
  const response = await fetch(sourceUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`音频下载失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (!blob.size) throw new Error('音频下载为空文件');
  return blob;
};

type DesignerTab = 'mix' | 'modify';

const VoiceDesignerApp: React.FC = () => {
  const { closeApp, apiConfig, addToast, characters, activeCharacterId, updateCharacter } = useOS();
  const selectedChar = useMemo(() => characters.find(c => c.id === activeCharacterId) || characters[0], [characters, activeCharacterId]);

  // ── Available voices (for picker) ──
  const [availableVoices, setAvailableVoices] = useState<MiniMaxVoiceItem[]>([]);
  const [isLoadingVoices, setIsLoadingVoices] = useState(false);
  const [voiceSearch, setVoiceSearch] = useState('');

  // ── Tab ──
  const [tab, setTab] = useState<DesignerTab>('mix');

  // ── Timber weights (混合) ──
  const [timberWeights, setTimberWeights] = useState<TimberWeight[]>(() => {
    const saved = selectedChar?.voiceProfile?.timberWeights;
    if (saved && saved.length > 0) {
      return saved.map((tw, i) => ({ id: `init-${i}`, voice_id: tw.voice_id, voice_name: '', weight: tw.weight }));
    }
    const existingVoiceId = selectedChar?.voiceProfile?.voiceId;
    if (existingVoiceId) {
      return [{ id: 'init-0', voice_id: existingVoiceId, voice_name: selectedChar?.voiceProfile?.voiceName || '', weight: 1 }];
    }
    return [];
  });

  // ── Voice modify ──
  const [modifyPitch, setModifyPitch] = useState(selectedChar?.voiceProfile?.voiceModify?.pitch ?? 0);
  const [modifyIntensity, setModifyIntensity] = useState(selectedChar?.voiceProfile?.voiceModify?.intensity ?? 0);
  const [modifyTimbre, setModifyTimbre] = useState(selectedChar?.voiceProfile?.voiceModify?.timbre ?? 0);
  const [soundEffect, setSoundEffect] = useState(selectedChar?.voiceProfile?.voiceModify?.sound_effects ?? '');

  // ── Basic settings ──
  const [speed, setSpeed] = useState(selectedChar?.voiceProfile?.speed ?? 1);
  const [volume, setVolume] = useState(selectedChar?.voiceProfile?.vol ?? 1);
  const [pitch, setPitch] = useState(selectedChar?.voiceProfile?.pitch ?? 0);
  const [emotion, setEmotion] = useState(selectedChar?.voiceProfile?.emotion ?? '');
  const [model, setModel] = useState(selectedChar?.voiceProfile?.model || DEFAULT_MODEL);
  const [minimaxParamVersion, setMinimaxParamVersion] = useState<MiniMaxParamVersion>(() => getMiniMaxParamVersion(selectedChar?.voiceProfile));

  // ── Preview ──
  const [previewText, setPreviewText] = useState(PREVIEW_TEXT);
  const [previewLang, setPreviewLang] = useState('zh');
  const [isGenerating, setIsGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // ── Voice baking (固定声音) ──
  const [isBaking, setIsBaking] = useState(false);

  // ── Voice picker modal ──
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [pickingForIndex, setPickingForIndex] = useState<number>(-1);

  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  // ── Load voices ──
  const handleLoadVoices = async () => {
    const apiKey = resolveMiniMaxApiKey(apiConfig);
    if (!apiKey) return addToast('请先在设置里配置 MiniMax API Key', 'error');
    setIsLoadingVoices(true);
    try {
      const result = await fetchMiniMaxVoices(apiKey, 'all');
      const allVoices = [...result.system_voice, ...result.voice_cloning, ...result.voice_generation];
      setAvailableVoices(allVoices);
      addToast(`已加载 ${allVoices.length} 个音色`, 'success');
    } catch (err: any) {
      addToast(err?.message || '加载音色失败', 'error');
    } finally {
      setIsLoadingVoices(false);
    }
  };

  // ── Timber weight helpers ──
  const addTimberSlot = () => {
    setTimberWeights(prev => [...prev, { id: `tw-${Date.now()}`, voice_id: '', voice_name: '', weight: 1 }]);
  };
  const removeTimberSlot = (index: number) => {
    setTimberWeights(prev => prev.filter((_, i) => i !== index));
  };
  const updateTimberWeight = (index: number, weight: number) => {
    setTimberWeights(prev => prev.map((tw, i) => i === index ? { ...tw, weight } : tw));
  };
  const updateTimberVoiceId = (index: number, voice_id: string, voice_name: string = '') => {
    setTimberWeights(prev => prev.map((tw, i) => i === index ? { ...tw, voice_id, voice_name } : tw));
  };

  // ── Build TTS payload ──
  const buildPayload = (text: string, languageBoost?: string) => {
    const validTimbers = timberWeights.filter(tw => tw.voice_id.trim());
    if (validTimbers.length === 0) {
      addToast('请至少添加一个音色', 'error');
      return null;
    }

    if (minimaxParamVersion === 'natural-v2') {
      return buildMiniMaxTtsPayload(text, {
        ...selectedChar?.voiceProfile,
        minimaxParamVersion,
        voiceId: validTimbers.length === 1 ? validTimbers[0].voice_id.trim() : '',
        model: model || DEFAULT_MODEL,
        timberWeights: validTimbers.length > 1
          ? validTimbers.map(tw => ({ voice_id: tw.voice_id.trim(), weight: tw.weight }))
          : undefined,
        voiceModify: modifyPitch !== 0 || modifyIntensity !== 0 || modifyTimbre !== 0 || soundEffect
          ? {
              ...(modifyPitch !== 0 ? { pitch: modifyPitch } : {}),
              ...(modifyIntensity !== 0 ? { intensity: modifyIntensity } : {}),
              ...(modifyTimbre !== 0 ? { timbre: modifyTimbre } : {}),
              ...(soundEffect ? { sound_effects: soundEffect } : {}),
            }
          : undefined,
        emotion: emotion || undefined,
        speed,
        vol: volume,
        pitch,
      }, {
        languageBoost,
        groupId: (apiConfig.minimaxGroupId || '').trim() || undefined,
      });
    }

    const payload: any = {
      model: model || DEFAULT_MODEL,
      text,
      stream: false,
      output_format: 'url',
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
    };
    if (languageBoost) payload.language_boost = languageBoost;

    // voice_setting with timber_weights or single voice_id
    if (validTimbers.length > 1) {
      payload.voice_setting = {
        voice_id: '',
        speed: speed,
        vol: volume,
        pitch: pitch,
      };
      payload.timber_weights = (() => {
        const totalWeight = validTimbers.reduce((sum, tw) => sum + tw.weight, 0);
        if (totalWeight === 0) return validTimbers.map(tw => ({ voice_id: tw.voice_id.trim(), weight: Math.round(100 / validTimbers.length) }));
        const raw = validTimbers.map(tw => ({ voice_id: tw.voice_id.trim(), weight: Math.round((tw.weight / totalWeight) * 100) }));
        const diff = 100 - raw.reduce((s, r) => s + r.weight, 0);
        if (diff !== 0) raw[0].weight += diff;
        return raw;
      })();
    } else if (validTimbers.length === 1) {
      payload.voice_setting = {
        voice_id: validTimbers[0].voice_id.trim(),
        speed: speed,
        vol: volume,
        pitch: pitch,
      };
    }

    // emotion
    if (emotion) payload.voice_setting.emotion = emotion;

    // voice_modify
    const hasModify = modifyPitch !== 0 || modifyIntensity !== 0 || modifyTimbre !== 0 || soundEffect;
    if (hasModify) {
      payload.voice_modify = {} as any;
      if (modifyPitch !== 0) payload.voice_modify.pitch = modifyPitch;
      if (modifyIntensity !== 0) payload.voice_modify.intensity = modifyIntensity;
      if (modifyTimbre !== 0) payload.voice_modify.timbre = modifyTimbre;
      if (soundEffect) payload.voice_modify.sound_effects = soundEffect;
    }

    const groupId = (apiConfig.minimaxGroupId || '').trim();
    if (groupId) payload.group_id = groupId;
    return payload;
  };

  // ── Preview ──
  const handlePreview = async () => {
    const apiKey = resolveMiniMaxApiKey(apiConfig);
    if (!apiKey) return addToast('请先在设置里配置 MiniMax API Key', 'error');
    const text = previewText.trim();
    if (!text) return addToast('请输入试听文本', 'error');

    const boost = PREVIEW_SAMPLES.find(s => s.code === previewLang)?.boost;
    const payload = buildPayload(text, boost);
    if (!payload) return;

    setIsGenerating(true);
    try {
      const groupId = (apiConfig.minimaxGroupId || '').trim();
      const cacheKey = buildMiniMaxTtsCacheKey(payload, minimaxParamVersion);
      const cached = await getCachedTts(cacheKey);
      let url = '';
      if (cached) {
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        url = URL.createObjectURL(cached);
      } else {
        const response = await minimaxFetch('/api/minimax/t2a', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'X-MiniMax-API-Key': apiKey,
            ...(groupId ? { 'X-MiniMax-Group-Id': groupId } : {}),
          },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        const statusCode = data?.base_resp?.status_code;
        if (!response.ok || (typeof statusCode === 'number' && statusCode !== 0)) {
          throw new Error(formatUnknownError(data, '') || `调用失败（HTTP ${response.status}）`);
        }

        const audioRaw = data?.data?.audio;
        if (!audioRaw || typeof audioRaw !== 'string') throw new Error('接口没有返回音频数据');

        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        let blob: Blob;
        if (/^https?:\/\//i.test(audioRaw.trim())) {
          blob = await fetchRemoteAudioBlob(audioRaw.trim());
        } else {
          blob = convertHexAudioToBlob(audioRaw, 'audio/mpeg');
        }
        url = URL.createObjectURL(blob);
        saveCachedTts(cacheKey, blob).catch(() => { /* ignore */ });
      }
      blobUrlRef.current = url;
      setAudioUrl(url);
      setTimeout(() => { audioRef.current?.play().catch(() => {}); }, 50);
    } catch (err: any) {
      addToast(err?.message || '预览失败', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  // ── Bake voice: server synthesizes long audio with timber_weights → upload → clone ──
  const handleBakeVoice = async () => {
    const apiKey = resolveMiniMaxApiKey(apiConfig);
    if (!apiKey) return addToast('请先在设置里配置 MiniMax API Key', 'error');

    const payload = buildPayload('');  // just to validate timber_weights
    if (!payload) return;

    setIsBaking(true);
    try {
      const charName = selectedChar?.name || 'char';
      const timestamp = Date.now().toString(36);
      const customVoiceId = `vc${charName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()}${timestamp}`;

      addToast('正在合成长音频并克隆声音，请稍候...', 'success');

      const groupId = (apiConfig.minimaxGroupId || '').trim();
      const region = apiConfig.minimaxRegion === 'overseas' ? 'overseas' : 'domestic';
      const res = await fetch('/api/minimax/bake-voice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MiniMax-Region': region,
        },
        body: JSON.stringify({
          apiKey,
          voiceId: customVoiceId,
          model: model || DEFAULT_MODEL,
          // Pass the current TTS payload so server can synthesize a long sample
          ttsPayload: payload,
          groupId: groupId || undefined,
          region,
        }),
      });
      const data = await safeResponseJson(res);
      if (!res.ok || data?.error) {
        throw new Error(formatUnknownError(data, '') || `固定声音失败（HTTP ${res.status}）`);
      }

      // Replace timber_weights with the new fixed voice_id
      setTimberWeights([{ id: `baked-${Date.now()}`, voice_id: customVoiceId, voice_name: `固定音色 (${customVoiceId})`, weight: 1 }]);
      addToast(`声音已固定！voice_id: ${customVoiceId}`, 'success');

      // Play the clone preview if available
      const cloneAudio = data?.clone_data?.data?.audio;
      if (cloneAudio && typeof cloneAudio === 'string') {
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        let blob: Blob;
        if (/^https?:\/\//i.test(cloneAudio.trim())) {
          blob = await fetchRemoteAudioBlob(cloneAudio.trim());
        } else {
          blob = convertHexAudioToBlob(cloneAudio, 'audio/mpeg');
        }
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setAudioUrl(url);
        setTimeout(() => { audioRef.current?.play().catch(() => {}); }, 50);
      }
    } catch (err: any) {
      addToast(err?.message || '固定声音失败', 'error');
    } finally {
      setIsBaking(false);
    }
  };

  // ── Apply to character ──
  const handleApply = () => {
    if (!selectedChar) return addToast('没有选中角色', 'error');
    const validTimbers = timberWeights.filter(tw => tw.voice_id.trim());
    if (validTimbers.length === 0) return addToast('请至少添加一个音色', 'error');

    const hasModify = modifyPitch !== 0 || modifyIntensity !== 0 || modifyTimbre !== 0 || soundEffect;
    const updatedProfile = {
      ...selectedChar,
      voiceProfile: {
        ...selectedChar.voiceProfile,
        provider: 'minimax' as const,
        voiceId: validTimbers.length === 1 ? validTimbers[0].voice_id.trim() : '',
        minimaxParamVersion,
        voiceName: validTimbers.length === 1 ? (validTimbers[0].voice_name || validTimbers[0].voice_id) : `混合音色 (${validTimbers.length}个)`,
        source: 'custom' as const,
        model: model || DEFAULT_MODEL,
        notes: validTimbers.length > 1 ? validTimbers.map(tw => `${tw.voice_id}×${tw.weight}`).join(' + ') : '',
        timberWeights: validTimbers.length > 1 ? (() => {
          const totalWeight = validTimbers.reduce((sum, tw) => sum + tw.weight, 0);
          if (totalWeight === 0) return validTimbers.map(tw => ({ voice_id: tw.voice_id.trim(), weight: Math.round(100 / validTimbers.length) }));
          const raw = validTimbers.map(tw => ({ voice_id: tw.voice_id.trim(), weight: Math.round((tw.weight / totalWeight) * 100) }));
          const diff = 100 - raw.reduce((s, r) => s + r.weight, 0);
          if (diff !== 0) raw[0].weight += diff;
          return raw;
        })() : undefined,
        voiceModify: hasModify ? {
          ...(modifyPitch !== 0 ? { pitch: modifyPitch } : {}),
          ...(modifyIntensity !== 0 ? { intensity: modifyIntensity } : {}),
          ...(modifyTimbre !== 0 ? { timbre: modifyTimbre } : {}),
          ...(soundEffect ? { sound_effects: soundEffect } : {}),
        } : undefined,
        emotion: emotion || undefined,
        speed: speed !== 1 ? speed : undefined,
        vol: volume !== 1 ? volume : undefined,
        pitch: pitch !== 0 ? pitch : undefined,
      },
    };
    updateCharacter(selectedChar.id, updatedProfile);
    trackEvent('把捏好的声音应用到角色');
    addToast(`已将捏好的声音应用到「${selectedChar.name}」`, 'success');
  };

  const filteredVoices = useMemo(() => {
    if (!voiceSearch.trim()) return availableVoices.slice(0, 100);
    const q = voiceSearch.toLowerCase();
    return availableVoices.filter(v => (v.voice_id || '').toLowerCase().includes(q) || (v.voice_name || '').toLowerCase().includes(q)).slice(0, 100);
  }, [availableVoices, voiceSearch]);

  // ── Slider component ──
  const Slider: React.FC<{
    label: string; value: number; min: number; max: number; step: number;
    onChange: (v: number) => void; unit?: string; showValue?: boolean;
  }> = ({ label, value, min, max, step, onChange, unit = '', showValue = true }) => (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-[11px] text-slate-500">{label}</span>
        {showValue && <span className="text-[11px] font-mono text-slate-600">{value}{unit}</span>}
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-slate-200 rounded-full appearance-none cursor-pointer accent-violet-500" />
    </div>
  );

  return (
    <div className="h-full w-full bg-gradient-to-b from-violet-50 to-white flex flex-col">
      {/* Header */}
      <header className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-white/80 backdrop-blur-sm shrink-0" style={{ paddingTop: 'max(0.75rem, var(--safe-top))' }}>
        <div>
          <h2 className="text-sm font-bold text-slate-800">捏声音</h2>
          <p className="text-[10px] text-slate-400">
            {selectedChar ? `为「${selectedChar.name}」设计声线` : 'MiniMax 音色设计器'}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleApply} className="text-[10px] px-3 py-1.5 rounded-full bg-violet-500 text-white font-bold flex items-center gap-1 active:scale-95 transition-transform">
            <FloppyDisk size={12} weight="bold" /> 应用
          </button>
          <button onClick={() => closeApp()} className="text-[10px] px-3 py-1.5 rounded-full bg-slate-100 text-slate-600 font-bold">关闭</button>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex border-b border-slate-100 bg-white/60 shrink-0">
        <button onClick={() => { setTab('mix'); trackEvent('切换捏声音标签页', { tab: 'mix' }); }} className={`flex-1 py-2.5 text-xs font-semibold transition-colors relative ${tab === 'mix' ? 'text-violet-600' : 'text-slate-400'}`}>
          混合音色
          {tab === 'mix' && <div className="absolute bottom-0 left-1/4 w-1/2 h-0.5 bg-violet-500 rounded-full" />}
        </button>
        <button onClick={() => { setTab('modify'); trackEvent('切换捏声音标签页', { tab: 'modify' }); }} className={`flex-1 py-2.5 text-xs font-semibold transition-colors relative ${tab === 'modify' ? 'text-violet-600' : 'text-slate-400'}`}>
          音色微调
          {tab === 'modify' && <div className="absolute bottom-0 left-1/4 w-1/2 h-0.5 bg-violet-500 rounded-full" />}
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        <div className="bg-white rounded-2xl p-4 border border-violet-100 shadow-sm space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-700">MiniMax 合成参数</span>
            <span className="text-[9px] text-slate-400">按角色保存</span>
          </div>
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setMinimaxParamVersion('legacy')}
              className={`rounded-lg px-2 py-2 text-[10px] font-bold transition-colors ${minimaxParamVersion === 'legacy' ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-400'}`}
            >
              经典参数
            </button>
            <button
              type="button"
              onClick={() => setMinimaxParamVersion('natural-v2')}
              className={`rounded-lg px-2 py-2 text-[10px] font-bold transition-colors ${minimaxParamVersion === 'natural-v2' ? 'bg-violet-500 text-white shadow-sm' : 'text-slate-400'}`}
            >
              新版自然参数
            </button>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-400">
            {minimaxParamVersion === 'natural-v2'
              ? '试听与聊天、见面、电话统一参数；使用模型原生标点韵律，不再给每个标点自动硬塞停顿。'
              : '完整保留原有参数、自动停顿和限幅规则，老角色默认继续使用这一档。'}
          </p>
        </div>

        {/* ── TAB: 混合音色 ── */}
        {tab === 'mix' && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700">声线配方</span>
                <div className="flex gap-2">
                  {availableVoices.length === 0 && (
                    <button onClick={handleLoadVoices} disabled={isLoadingVoices}
                      className="text-[10px] px-2 py-1 rounded bg-violet-50 text-violet-600 font-bold hover:bg-violet-100 disabled:opacity-50">
                      {isLoadingVoices ? '加载中...' : '加载音色库'}
                    </button>
                  )}
                  <button onClick={addTimberSlot} className="text-[10px] px-2 py-1 rounded bg-emerald-50 text-emerald-600 font-bold hover:bg-emerald-100 flex items-center gap-0.5">
                    <Plus size={10} weight="bold" /> 加声线
                  </button>
                </div>
              </div>
              <p className="text-[10px] text-slate-400">添加多个音色并调节权重来混合出独特声线。单个音色也可以，后续在「音色微调」里精调。</p>
            </div>

            <div className="flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <Warning size={13} weight="fill" className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-[10px] text-amber-700 leading-relaxed">
                建议<b>只融合同一种语言</b>的音色。比如想要韩语角色，就只挑韩语音色来融——混入其它语种的音色容易让角色说话<b>带口音</b>。融好后用上方多语种样例分别试听确认。
              </p>
            </div>

            {timberWeights.map((tw, index) => (
              <div key={tw.id} className="bg-white rounded-2xl p-3 border border-slate-100 shadow-sm space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-slate-500">声线 #{index + 1}</span>
                  {timberWeights.length > 1 && (
                    <button onClick={() => removeTimberSlot(index)} className="text-slate-300 hover:text-red-400 p-1">
                      <Trash size={14} />
                    </button>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    value={tw.voice_id}
                    onChange={e => updateTimberVoiceId(index, e.target.value)}
                    className="flex-1 bg-slate-50 rounded-xl px-3 py-2 text-xs border border-slate-200 focus:border-violet-300 transition-colors"
                    placeholder="输入 voice_id 或从库中选"
                  />
                  {availableVoices.length > 0 && (
                    <button onClick={() => { setPickingForIndex(index); setShowVoicePicker(true); trackEvent('打开音色选择器'); }}
                      className="text-[10px] px-2 py-2 rounded-xl bg-violet-50 text-violet-600 font-bold hover:bg-violet-100 shrink-0">
                      选
                    </button>
                  )}
                </div>
                {tw.voice_name && <div className="text-[10px] text-slate-400 px-1">{tw.voice_name}</div>}
                <Slider label="权重" value={tw.weight} min={1} max={100} step={1} onChange={v => updateTimberWeight(index, v)} />
              </div>
            ))}

            {timberWeights.length === 0 && (
              <div className="text-center py-8 text-slate-300">
                <SpeakerHigh size={40} className="mx-auto mb-2 opacity-30" />
                <p className="text-xs">还没有声线，点击上方「加声线」开始</p>
              </div>
            )}
          </>
        )}

        {/* ── TAB: 音色微调 ── */}
        {tab === 'modify' && (
          <>
            <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm space-y-3">
              <span className="text-xs font-bold text-slate-700">基础参数</span>
              <Slider label="语速" value={speed} min={0.5} max={2} step={0.1} onChange={setSpeed} unit="x" />
              <Slider label="音量" value={volume} min={0} max={2} step={0.1} onChange={setVolume} />
              <Slider label="基础音调" value={pitch} min={-12} max={12} step={1} onChange={setPitch} />
            </div>

            <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm space-y-3">
              <span className="text-xs font-bold text-slate-700">音色修饰</span>
              <Slider label="音调偏移" value={modifyPitch} min={-100} max={100} step={1} onChange={setModifyPitch} />
              <Slider label="强度" value={modifyIntensity} min={-100} max={100} step={1} onChange={setModifyIntensity} />
              <Slider label="音色" value={modifyTimbre} min={-100} max={100} step={1} onChange={setModifyTimbre} />
              <div className="space-y-1">
                <span className="text-[11px] text-slate-500">音效</span>
                <select value={soundEffect} onChange={e => setSoundEffect(e.target.value)}
                  className="w-full bg-slate-50 rounded-xl px-3 py-2 text-xs border border-slate-200">
                  {SOUND_EFFECTS_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm space-y-3">
              <span className="text-xs font-bold text-slate-700">情感</span>
              <div className="flex flex-wrap gap-1.5">
                {['', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'].map(em => (
                  <button key={em} onClick={() => setEmotion(em)}
                    className={`text-[10px] px-2.5 py-1.5 rounded-full font-semibold transition-colors ${emotion === em ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                    {em === '' ? '自动' : em === 'happy' ? '开心' : em === 'sad' ? '伤感' : em === 'angry' ? '生气' : em === 'fearful' ? '恐惧' : em === 'disgusted' ? '厌恶' : em === 'surprised' ? '惊讶' : '平静'}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm space-y-2">
              <span className="text-xs font-bold text-slate-700">TTS 模型</span>
              <input value={model} onChange={e => setModel(e.target.value)}
                className="w-full bg-slate-50 rounded-xl px-3 py-2 text-xs border border-slate-200"
                placeholder="speech-2.8-hd" />
            </div>
          </>
        )}

        {/* ── Preview Section (always visible) ── */}
        <div className="bg-gradient-to-r from-violet-50 to-purple-50 rounded-2xl p-4 border border-violet-100 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-violet-700">试听预览</span>
            <span className="text-[9px] text-violet-400">点语种切换样例</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PREVIEW_SAMPLES.map(s => (
              <button key={s.code}
                onClick={() => { setPreviewLang(s.code); setPreviewText(s.text); trackEvent('切换试听语种样例', { lang: s.code }); }}
                className={`text-[10px] px-2.5 py-1 rounded-full font-bold transition-colors ${previewLang === s.code ? 'bg-violet-500 text-white' : 'bg-white text-violet-500 border border-violet-200 hover:bg-violet-100'}`}>
                {s.label}
              </button>
            ))}
          </div>
          <textarea value={previewText} onChange={e => setPreviewText(e.target.value)}
            rows={2} className="w-full bg-white rounded-xl px-3 py-2 text-xs border border-violet-200 resize-none"
            placeholder="输入试听文本..." />
          <div className="flex gap-2">
            <button onClick={handlePreview} disabled={isGenerating}
              className="flex-1 py-2 rounded-xl bg-violet-500 hover:bg-violet-400 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform">
              <SpeakerHigh size={14} weight="bold" /> {isGenerating ? '合成中...' : '试听'}
            </button>
            {audioUrl && (
              <>
                <button onClick={() => { audioRef.current?.play().catch(() => {}); }}
                  className="px-3 py-2 rounded-xl bg-violet-100 text-violet-600"><PlayCircle size={16} /></button>
                <button onClick={() => { if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; } }}
                  className="px-3 py-2 rounded-xl bg-violet-100 text-violet-600"><StopCircle size={16} /></button>
              </>
            )}
          </div>
          {audioUrl && timberWeights.filter(tw => tw.voice_id.trim()).length > 1 && (
            <div className="space-y-1.5">
              <p className="text-[10px] text-emerald-600/80 text-center">
                <Check size={12} weight="bold" className="inline" /> 混合声线已就绪，直接点「应用」即可使用。通话时会实时混合，效果与试听一致。
              </p>
              <details className="group">
                <summary className="text-[10px] text-slate-400 text-center cursor-pointer hover:text-slate-500 select-none">
                  高级：固定为独立 voice_id（克隆）▸
                </summary>
                <div className="mt-2 space-y-1.5 pt-2 border-t border-slate-100">
                  <p className="text-[10px] text-amber-600/70 text-center">
                    <Warning size={12} weight="bold" className="inline" /> 克隆会从试听音频中提取音色特征，生成的声音可能与混合试听有差异。仅在需要固定 voice_id 时使用。
                  </p>
                  <button onClick={handleBakeVoice} disabled={isBaking}
                    className="w-full py-2 rounded-xl bg-slate-200 hover:bg-slate-300 disabled:opacity-50 text-slate-600 text-xs font-medium flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform">
                    <Lock size={14} weight="bold" /> {isBaking ? '固定中...' : '固定声音（克隆）'}
                  </button>
                </div>
              </details>
            </div>
          )}
          {audioUrl && <audio ref={audioRef} controls className="w-full h-8" src={audioUrl} />}
        </div>

        {/* Summary */}
        <div className="bg-slate-50 rounded-2xl p-3 text-[10px] text-slate-400 space-y-1">
          <div>声线数: {timberWeights.filter(tw => tw.voice_id.trim()).length}</div>
          {timberWeights.filter(tw => tw.voice_id.trim()).length > 1 && (
            <div>配方: {timberWeights.filter(tw => tw.voice_id.trim()).map(tw => `${tw.voice_id}×${tw.weight}`).join(' + ')}</div>
          )}
          {(modifyPitch !== 0 || modifyIntensity !== 0 || modifyTimbre !== 0) && (
            <div>微调: pitch={modifyPitch} intensity={modifyIntensity} timbre={modifyTimbre}</div>
          )}
          {soundEffect && <div>音效: {soundEffect}</div>}
          {emotion && <div>情感: {emotion}</div>}
          <div>参数: {minimaxParamVersion === 'natural-v2' ? '新版自然参数' : '经典参数'}</div>
        </div>

        {/* Bottom spacer */}
        <div className="h-4" />
      </div>

      {/* Voice Picker Modal */}
      {showVoicePicker && (
        <div className="absolute inset-0 z-50 bg-black/40 flex items-end">
          <div className="bg-white w-full rounded-t-3xl max-h-[70%] flex flex-col animate-slide-up">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between shrink-0">
              <span className="text-sm font-bold text-slate-700">选择音色</span>
              <button onClick={() => setShowVoicePicker(false)} className="text-xs px-3 py-1 bg-slate-100 rounded-full">关闭</button>
            </div>
            <div className="px-4 pt-3 shrink-0">
              <input value={voiceSearch} onChange={e => setVoiceSearch(e.target.value)}
                className="w-full bg-slate-50 rounded-xl px-3 py-2 text-xs border border-slate-200"
                placeholder="搜索音色名或 ID..." />
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-1">
              {filteredVoices.map(v => (
                <button key={v.voice_id} onClick={() => {
                  updateTimberVoiceId(pickingForIndex, v.voice_id, v.voice_name || '');
                  setShowVoicePicker(false);
                }}
                  className="w-full text-left px-3 py-2 rounded-xl text-xs hover:bg-violet-50 border border-transparent hover:border-violet-200 transition-colors">
                  <div className="font-medium text-slate-700 truncate">{v.voice_name || '未命名'}</div>
                  <div className="text-[10px] text-slate-400 truncate">{v.voice_id}</div>
                </button>
              ))}
              {filteredVoices.length === 0 && (
                <div className="text-center py-8 text-slate-300 text-xs">
                  {availableVoices.length === 0 ? '请先加载音色库' : '没有找到匹配的音色'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VoiceDesignerApp;

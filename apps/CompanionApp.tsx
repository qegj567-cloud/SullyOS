import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Camera, CameraSlash, Microphone, MicrophoneSlash, SpeakerHigh, SpeakerSlash, Stop, SlidersHorizontal, ChatsCircle, Compass } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import type { APIConfig, CharacterProfile, RealtimeConfig, UserProfile } from '../types';
import { CompanionSession, type CompanionLine } from '../utils/companion/session';
import { createCompanionRequests } from '../utils/companion/requests';
import { CompanionVoice } from '../utils/companion/voice';
import { canListenContinuously, startCompanionListening } from '../utils/companion/listening';
import { observeCompanionFrames, observationText, type CompanionFrame, type CompanionObservation } from '../utils/companion/vision';
import { canSynthesizeSpeech } from '../utils/ttsRouter';
import { isVisionApiReady } from '../utils/visionApi';
import { resolveContextRangeMode, clampManualContextLimit } from '../utils/chatContextRange';
import { CompanionDebugStore } from '../utils/companion/debug';
import { CompanionDebugPanel } from '../components/companion/CompanionDebugPanel';
import { CompanionSetupGuide } from '../components/companion/CompanionSetupGuide';
import { companionDialogueReady, openCompanionSetupTarget, type CompanionSetupTarget } from '../utils/companion/setup';
import './companion.css';

type RequestFactory = typeof createCompanionRequests;
export interface CompanionSurfaceProps {
  characters: CharacterProfile[]; user: UserProfile; api: APIConfig; realtimeConfig?: RealtimeConfig;
  close(): void;
  navigateSetup?(target: CompanionSetupTarget, charId?: string): void;
  /** Fixture injection only; production always uses the shared request pipeline. */
  requestFactory?: RequestFactory;
}

export function CompanionSurface({ characters, user, api, realtimeConfig, close, navigateSetup, requestFactory = createCompanionRequests }: CompanionSurfaceProps) {
  const [charId, setCharId] = useState(characters[0]?.id || '');
  const char = characters.find(item => item.id === charId);
  const [style, setStyle] = useState('');
  const [settings, setSettings] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [debug] = useState(() => new CompanionDebugStore());
  const [lines, setLines] = useState<CompanionLine[]>([]);
  const [status, setStatus] = useState('选好伙伴，开始同行');
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [partial, setPartial] = useState('');
  const [listening, setListening] = useState(false);
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [observation, setObservation] = useState<CompanionObservation>();
  const [observing, setObserving] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<MediaStream>();
  const cameraGeneration = useRef(0);
  const frames = useRef<CompanionFrame[]>([]);
  const observationRef = useRef<CompanionObservation>();
  const visionAbort = useRef<AbortController>();
  const stopListening = useRef<() => void>();
  const voice = useRef(new CompanionVoice());
  const session = useRef<CompanionSession<any>>();
  const voiceOn = useRef(voiceEnabled); voiceOn.current = voiceEnabled;
  const sendRef = useRef<(text: string) => void>(() => {});
  const mounted = useRef(true);
  const canVoice = !!char && canSynthesizeSpeech(char, api);
  const latest = lines.at(-1);

  const stopMic = () => { stopListening.current?.(); stopListening.current = undefined; setListening(false); setPartial(''); };
  const stopCamera = () => {
    cameraGeneration.current++;
    visionAbort.current?.abort();
    mediaRef.current?.getTracks().forEach(track => track.stop()); mediaRef.current = undefined;
    frames.current = []; observationRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera(false); setCameraPending(false); setObservation(undefined);
  };
  const stopAll = () => { session.current?.interrupt(); stopMic(); stopCamera(); };

  useEffect(() => {
    session.current?.interrupt(); session.current = undefined;
    debug.clear();
    stopMic(); stopCamera(); setLines([]); setStatus('在你身边');
    // This editable seed is intentionally short and visibly labelled as an excerpt.
    setStyle(char?.systemPrompt?.slice(0, 1600) || '保留角色的身份和熟悉的说话方式，自然回应眼前的话题。');
  }, [charId]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.hidden) { stopAll(); setStatus('已暂停，回到页面后可重新开启'); } };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      mounted.current = false;
      session.current?.interrupt(); stopListening.current?.(); visionAbort.current?.abort();
      cameraGeneration.current++; mediaRef.current?.getTracks().forEach(track => track.stop());
      voice.current.close(); document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  const ensureSession = () => {
    if (!char) throw new Error('请先在神经链接中添加角色');
    if (!session.current) {
      const requests = requestFactory({ char, user, api, style, realtimeConfig, debug, scene: () => observationText(observationRef.current) });
      session.current = new CompanionSession({ ...requests, debug,
        play: async (text, signal, heard, started) => {
          if (!voiceOn.current || !canSynthesizeSpeech(char, api)) { signal.throwIfAborted(); started('text'); heard(text); return; }
          await voice.current.play(text, char, api, signal, heard, () => started('audio'));
        },
        change: (next, state) => { if (mounted.current) { setLines(next); setStatus(state); } },
        error: err => { if (mounted.current) setError(err instanceof Error ? err.message : '本轮没有完成，请重试'); },
      });
    }
    return session.current;
  };
  const send = (text: string) => {
    if (!text.trim() || !char) return;
    setError(''); setInput(''); voice.current.prime();
    try { void ensureSession().send(text); } catch (err) { setError((err as Error).message); }
  };
  sendRef.current = send;

  const toggleMic = () => {
    if (listening) { stopMic(); return; }
    setError(''); voice.current.prime();
    try {
      ensureSession();
      stopListening.current = startCompanionListening({
        speech: () => session.current?.interrupt(), partial: setPartial, final: text => sendRef.current(text),
        error: message => { setError(message); setListening(false); setPartial(''); },
      });
      setListening(true);
    } catch (err) { setError((err as Error).message); }
  };

  const toggleCamera = async () => {
    if (camera || cameraPending) { stopCamera(); return; }
    if (!char || !isVisionApiReady(api.visionApi)) { setError('请在设置 → 识图 API 配置并开启独立识图，再开启镜头'); setSetupOpen(true); return; }
    setError(''); setCameraPending(true);
    const generation = ++cameraGeneration.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 960 } }, audio: false });
      if (generation !== cameraGeneration.current || !mounted.current) { stream.getTracks().forEach(track => track.stop()); return; }
      mediaRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      if (generation !== cameraGeneration.current) return;
      setCamera(true);
    } catch (err) {
      if (generation === cameraGeneration.current) { stopCamera(); setError(`摄像头未能开启：${(err as Error).message}`); }
    } finally { if (generation === cameraGeneration.current) setCameraPending(false); }
  };

  useEffect(() => {
    if (!camera || !char || !isVisionApiReady(api.visionApi)) return;
    const abort = new AbortController(); visionAbort.current = abort;
    let busy = false, lastRequest = 0, previous = '', failures = 0;
    const canvas = document.createElement('canvas');
    const sample = async () => {
      const video = videoRef.current;
      if (abort.signal.aborted || !video || video.readyState < 2 || !video.videoWidth) return;
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height); // rear camera: never mirror text
      const image = canvas.toDataURL('image/jpeg', 0.65);
      if (image === previous) return;
      previous = image;
      frames.current = [...frames.current.slice(-2), { image, at: Date.now() }];
      if (busy || Date.now() - lastRequest < 8000) return;
      busy = true; lastRequest = Date.now(); setObserving(true);
      try {
        const next = await observeCompanionFrames([...frames.current], api.visionApi!, char.id, char.name, abort.signal);
        if (!abort.signal.aborted) { failures = 0; observationRef.current = next; setObservation(next); }
      } catch (err) {
        if (!abort.signal.aborted) {
          setError(`画面识别失败：${(err as Error).message}`);
          // Avoid endlessly billing a broken configuration.
          if (++failures >= 2) { stopCamera(); setError('连续两次识图失败，镜头已暂停。请检查识图配置后重新开启。'); }
        }
      } finally { busy = false; if (mounted.current) setObserving(false); }
    };
    void sample(); const timer = setInterval(() => void sample(), 2500);
    return () => { clearInterval(timer); abort.abort(); };
  }, [camera, charId, api.visionApi]);

  return <section className="companion-app" aria-label="同行">
    <header className="companion-header">
      <button className="companion-icon" aria-label="返回桌面" onClick={() => { stopAll(); close(); }}><ArrowLeft size={22}/></button>
      <div className="companion-title"><strong>同行<span>DEMO</span></strong><small>{status}</small></div>
      <button type="button" className="companion-setup-entry" onClick={() => setSetupOpen(true)}>API 接入</button>
      <button className="companion-icon" aria-label="同行设置" onClick={() => setSettings(!settings)}><SlidersHorizontal size={22}/></button>
    </header>
    <div className="companion-stage">
      <video ref={videoRef} muted playsInline aria-label="摄像头实时画面" className={camera ? 'is-on' : ''}/>
      {!camera && <div className="companion-empty"><Compass size={68} weight="thin"/><h1>一起，看看眼前。</h1><p>打开镜头，或直接说说你看到的。</p></div>}
      <div className="companion-topline"><label><span className="companion-dot"/>
        <select aria-label="同行角色" value={charId} onChange={event => setCharId(event.target.value)}>
          {!characters.length && <option value="">请先添加角色</option>}
          {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label><span>{camera ? observing ? '正在看' : '镜头已开启' : '镜头关闭'}</span></div>
      {latest && !historyOpen && <div className="companion-caption" key={latest.id}>
        <small>{latest.role === 'user' ? user.name : char?.name}{latest.status === 'interrupted' ? ' · 已打断' : latest.status === 'speaking' ? ' · 正在说' : ''}</small>
        <p>{latest.status === 'interrupted' ? latest.heard || '这句话还没来得及说出口。' : latest.text}</p>
      </div>}
      {historyOpen && <div className="companion-history" aria-label="本次同行记录">
        <header>本次同行<button onClick={() => setHistoryOpen(false)}>收起</button></header>
        {!lines.length && <p>从一句话开始。</p>}
        {lines.map(line => <article key={line.id} data-role={line.role}><small>{line.role === 'user' ? user.name : char?.name}{line.status === 'interrupted' ? ' · 已打断' : ''}</small><p>{line.status === 'interrupted' ? line.heard || '未播放' : line.text}</p></article>)}
      </div>}
      {settings && <div className="companion-settings">
        <header>同行设置<button onClick={() => setSettings(false)}>完成</button></header>
        <button type="button" className="companion-reset" onClick={() => setSetupOpen(true)}>API 配置与注册引导</button>
        <p>上下文：{char && resolveContextRangeMode(char) === 'adaptive' ? '跟随自动记忆' : `最近 ${clampManualContextLimit(char?.contextLimit)} 条`}。与消息 App 共用角色设置。</p>
        <label>接话设定<textarea value={style} maxLength={2400} disabled={!!session.current} onChange={event => setStyle(event.target.value)}/></label>
        <p>默认摘取人设开头，可在开始前改成语气、称呼和关系要点。续答使用完整人设和记忆。</p>
        <p>连续听使用浏览器识别，建议戴耳机避免扬声器被识别成你说的话。豆包流式识别尚未接入。</p>
        <p>镜头开启后，每隔至少 8 秒将最近 1–3 张截图发给独立识图 API。不会保存图片；本次对话离开后清空，暂不写入聊天和长期记忆。</p>
        <button className="companion-reset" onClick={() => { stopAll(); session.current = undefined; setLines([]); setStatus('已结束本次同行'); }}>结束本次同行</button>
      </div>}
    </div>
    <CompanionDebugPanel store={debug}/>
    <footer className="companion-controls">
      {!companionDialogueReady(api, char) && <button type="button" className="companion-setup-hint" onClick={() => setSetupOpen(true)}>还没配置对话模型？从这里开始 →</button>}
      {error && <div className="companion-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
      <div className="companion-sensing"><span>{partial || (listening ? '在听，直接开口就好' : '可输入文字，或开启连续听')}</span><button aria-label="本次记录" onClick={() => setHistoryOpen(!historyOpen)}><ChatsCircle size={20}/></button></div>
      <form onSubmit={event => { event.preventDefault(); send(input); }}><input aria-label="对同行伙伴说" placeholder="你看，这件怎么样？" value={input} onChange={event => setInput(event.target.value)}/><button type="submit" aria-label="发送" disabled={!input.trim() || !char}><ArrowUp size={22}/></button></form>
      <div className="companion-actions">
        <button aria-pressed={camera} onClick={() => void toggleCamera()} disabled={!char}>{camera ? <Camera size={23}/> : <CameraSlash size={23}/>}<span>{cameraPending ? '取消开启' : camera ? '关闭镜头' : '开启镜头'}</span></button>
        <button aria-pressed={listening} onClick={toggleMic} disabled={!char || !canListenContinuously()}>{listening ? <Microphone size={23}/> : <MicrophoneSlash size={23}/>}<span>{listening ? '暂停聆听' : '连续听'}</span></button>
        <button aria-pressed={voiceEnabled && canVoice} onClick={() => { session.current?.interrupt(); voice.current.prime(); setVoiceEnabled(!voiceEnabled); }} disabled={!canVoice}>{voiceEnabled && canVoice ? <SpeakerHigh size={23}/> : <SpeakerSlash size={23}/>}<span>{canVoice ? voiceEnabled ? '角色语音' : '文字模式' : '未配音色'}</span></button>
        <button onClick={() => session.current?.interrupt()}><Stop size={23}/><span>打断</span></button>
      </div>
      {observation && <details className="companion-observation"><summary>最近看到的画面</summary><p>{observationText(observation)}</p></details>}
      {!canListenContinuously() && <small className="companion-note">此浏览器不支持连续识别，可以输入文字。</small>}
    </footer>
    {setupOpen && <CompanionSetupGuide char={char} api={api} canListen={canListenContinuously()} close={() => setSetupOpen(false)} navigate={target => {
      if (!navigateSetup) { setError('此模拟页不进入真实配置，请在主应用打开同行后配置。'); setSetupOpen(false); return; }
      stopAll(); session.current = undefined; setSetupOpen(false);
      navigateSetup(target, char?.id);
    }}/>}
  </section>;
}

export default function CompanionApp() {
  const { characters, userProfile, apiConfig, realtimeConfig, closeApp, openApp } = useOS();
  return <CompanionSurface characters={characters} user={userProfile} api={apiConfig} realtimeConfig={realtimeConfig} close={closeApp}
    navigateSetup={(target, charId) => openCompanionSetupTarget(target, charId, openApp)}/>;
}

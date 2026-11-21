import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, ArrowsOutSimple, Camera, CameraSlash, Microphone, MicrophoneSlash, PhoneDisconnect, SpeakerHigh, SpeakerSlash, Stop, SlidersHorizontal, ChatsCircle } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import type { APIConfig, CharacterProfile, CompanionVideoApiConfig, RealtimeConfig, UserProfile } from '../types';
import { CompanionSession, type CompanionLine } from '../utils/companion/session';
import { createCompanionRequests } from '../utils/companion/requests';
import { CompanionVoice } from '../utils/companion/voice';
import { canListenContinuously, startCompanionListening, type ListeningCallbacks, type ListeningDiagnostics } from '../utils/companion/listening';
import { CompanionMicMeter } from '../components/companion/CompanionMicMeter';
import { canUseDoubaoListening, startDoubaoListening } from '../utils/companion/doubaoListening';
import { observeCompanionVideo, observationText, companionVideoReady, type CompanionImageMode, type CompanionObservation } from '../utils/companion/vision';
import { createCompanionClipRecorder, startCompanionVideoLoop } from '../utils/companion/capture';
import { domesticMiniMaxVideoKey, isOfficialCompanionMiniMax, resolveCompanionVideoApi } from '../utils/companion/videoProviders';
import { canSynthesizeSpeech } from '../utils/ttsRouter';
import { resolveContextRangeMode, clampManualContextLimit } from '../utils/chatContextRange';
import { CompanionDebugStore } from '../utils/companion/debug';
import { holdCompanionPresence } from '../utils/companion/presence';
import { companionCameraConstraints, companionCameraError } from '../utils/companion/cameraSource';
import { CompanionCameraSource } from '../components/companion/CompanionCameraSource';
import { CompanionCharacterView } from '../components/companion/CompanionCharacterView';
import { CompanionDebugPanel } from '../components/companion/CompanionDebugPanel';
import { CompanionReplyProgress, companionReplyLabel } from '../components/companion/CompanionReplyProgress';
import { CompanionVideoStatus } from '../components/companion/CompanionVideoStatus';
import { CompanionSetupGuide } from '../components/companion/CompanionSetupGuide';
import { companionDialogueReady, openCompanionSetupTarget, type CompanionSetupTarget } from '../utils/companion/setup';
import './companion.css';

const AvatarSettings = React.lazy(() => import('../components/companion/CompanionAvatarSettings'));

type RequestFactory = typeof createCompanionRequests;
export interface CompanionSurfaceProps {
  characters: CharacterProfile[]; user: UserProfile; api: APIConfig; realtimeConfig?: RealtimeConfig;
  close(): void;
  navigateSetup?(target: CompanionSetupTarget, charId?: string): void;
  saveVideoApi?(config: CompanionVideoApiConfig): void;
  saveQuickReply?(enabled: boolean): void;
  saveBargeIn?(enabled: boolean): void;
  editAvatar?: boolean;
  /** Fixture injection only; production always uses the shared request pipeline. */
  requestFactory?: RequestFactory;
  videoObserver?: typeof observeCompanionVideo;
}

export function CompanionSurface({ characters, user, api, realtimeConfig, close, navigateSetup, saveVideoApi, saveQuickReply, saveBargeIn, editAvatar, requestFactory = createCompanionRequests, videoObserver = observeCompanionVideo }: CompanionSurfaceProps) {
  const [charId, setCharId] = useState(characters[0]?.id || '');
  const char = characters.find(item => item.id === charId);
  const [style, setStyle] = useState('');
  const [settings, setSettings] = useState(false);
  const [avatarSettings, setAvatarSettings] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [debug] = useState(() => new CompanionDebugStore());
  const [lines, setLines] = useState<CompanionLine[]>([]);
  const [status, setStatus] = useState('选好伙伴，开始同行');
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [partial, setPartial] = useState('');
  const [pendingInput, setPendingInput] = useState('');
  const [listening, setListening] = useState(false);
  const [micStatus, setMicStatus] = useState('');
  const [micDiagnostics, setMicDiagnostics] = useState<ListeningDiagnostics>();
  const [camera, setCamera] = useState(false);
  const [streetMain, setStreetMain] = useState(false);
  const [localQuickReply, setLocalQuickReply] = useState(api.companionQuickReply === true);
  const quickEnabled = saveQuickReply ? api.companionQuickReply === true : localQuickReply;
  const [localBargeIn, setLocalBargeIn] = useState(api.companionBargeIn !== false);
  const bargeIn = saveBargeIn ? api.companionBargeIn !== false : localBargeIn;
  const bargeInRef = useRef(bargeIn);
  bargeInRef.current = bargeIn;
  const [cameraPending, setCameraPending] = useState(false);
  const [cameraDeviceId, setCameraDeviceId] = useState('');
  const [cameraLabel, setCameraLabel] = useState('');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [observation, setObservation] = useState<CompanionObservation>();
  const [observing, setObserving] = useState(false);
  const [analysisPaused, setAnalysisPaused] = useState(false);
  const [analysisProblem, setAnalysisProblem] = useState('');
  const [analysisClip, setAnalysisClip] = useState<{ from: number; to: number }>();
  const [imageMode, setImageMode] = useState<CompanionImageMode>('none');
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const updateStreetAspect = () => {
    const video = videoRef.current;
    if (video?.videoWidth && video.videoHeight) {
      stageRef.current?.style.setProperty('--street-aspect', `${video.videoWidth} / ${video.videoHeight}`);
    }
  };
  const mediaRef = useRef<MediaStream>();
  const cameraGeneration = useRef(0);
  const observationRef = useRef<CompanionObservation>();
  const visionAbort = useRef<AbortController>();
  const stopListening = useRef<() => void>();
  const voice = useRef(new CompanionVoice());
  const session = useRef<CompanionSession<any>>();
  const voiceOn = useRef(voiceEnabled); voiceOn.current = voiceEnabled;
  const sendRef = useRef<(text: string, fromSpeech?: boolean) => void>(() => {});
  const mounted = useRef(true);
  const canVoice = !!char && canSynthesizeSpeech(char, api);
  const latest = lines.at(-1);
  const useDoubao = api.companionStt?.provider === 'doubao';
  const canListen = useDoubao ? canUseDoubaoListening() : canListenContinuously();
  const domesticKey = domesticMiniMaxVideoKey(api);
  const savedVideo = api.companionVideoApi;
  const videoApi = useMemo(() => resolveCompanionVideoApi(savedVideo, domesticKey), [savedVideo, domesticKey]);
  const miniMaxDirect = isOfficialCompanionMiniMax(videoApi);

  const stopMic = () => { stopListening.current?.(); stopListening.current = undefined; session.current?.speechEnded(); setListening(false); setPartial(''); setMicStatus(''); setMicDiagnostics(undefined); };
  const stopCamera = () => {
    cameraGeneration.current++;
    visionAbort.current?.abort();
    mediaRef.current?.getTracks().forEach(track => track.stop()); mediaRef.current = undefined;
    observationRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera(false); setStreetMain(false); setCameraPending(false); setObservation(undefined); setObserving(false);
    setCameraLabel('');
    setAnalysisPaused(false); setAnalysisProblem(''); setAnalysisClip(undefined);
  };
  const stopAll = () => { session.current?.interrupt('停止看听、配置或测试'); stopMic(); stopCamera(); };

  useEffect(() => charId ? holdCompanionPresence(charId) : undefined, [charId]);

  useEffect(() => {
    session.current?.interrupt('切换角色'); session.current = undefined;
    debug.clear();
    stopMic(); stopCamera(); setLines([]); setImageMode('none'); setStatus('在你身边');
    // This editable seed is intentionally short and visibly labelled as an excerpt.
    setStyle(char?.systemPrompt?.slice(0, 1600) || '保留角色的身份和熟悉的说话方式，自然回应眼前的话题。');
  }, [charId]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.hidden) { stopAll(); setStatus('已暂停，回到页面后可重新开启'); } };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      mounted.current = false;
      session.current?.interrupt('离开同行'); stopListening.current?.(); visionAbort.current?.abort();
      cameraGeneration.current++; mediaRef.current?.getTracks().forEach(track => track.stop());
      voice.current.close(); document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  const ensureSession = () => {
    if (!char) throw new Error('请先在神经链接中添加角色');
    if (!session.current) {
      const requests = requestFactory({ char, user, api, style, realtimeConfig, debug, scene: () => observationText(observationRef.current), observation: () => observationRef.current, imageMode });
      session.current = new CompanionSession({ ...requests, debug,
        play: async (text, signal, heard, started) => {
          if (!voiceOn.current || !canSynthesizeSpeech(char, api)) { signal.throwIfAborted(); started('text'); heard(text); return; }
          await voice.current.play(text, char, api, signal, heard, () => started('audio'));
        },
        change: (next, state) => { if (mounted.current) { setLines(next); setStatus(state); } },
        pendingInput: text => { if (mounted.current) setPendingInput(text); },
        error: err => { if (mounted.current) setError(err instanceof Error ? err.message : '本轮没有完成，请重试'); },
      });
    }
    return session.current;
  };
  const send = (text: string, fromSpeech = false) => {
    if (!text.trim() || !char) return;
    setError('');
    if (!fromSpeech) setInput('');
    voice.current.prime();
    try {
      const current = ensureSession();
      void current.send(text, quickEnabled, bargeInRef.current ? 'interrupt' : 'queue');
      if (fromSpeech) void current.speechEnded();
    } catch (err) { setError((err as Error).message); }
  };
  sendRef.current = send;

  const toggleMic = () => {
    if (listening) { stopMic(); return; }
    if (useDoubao && !api.companionStt?.apiKey.trim()) { setError('请先填写豆包语音 API Key'); setSetupOpen(true); return; }
    setError(''); setMicDiagnostics(undefined); voice.current.prime();
    try {
      const current = ensureSession();
      const callbacks: ListeningCallbacks = {
        speech: () => current.speechStarted(bargeInRef.current), partial: setPartial,
        final: text => sendRef.current(text, true), speechEnded: () => { void current.speechEnded(); },
        error: (message: string) => { void current.speechEnded(); setError(message); setListening(false); setPartial(''); setMicStatus(''); stopListening.current = undefined; },
        state: setMicStatus, diagnostics: setMicDiagnostics,
      };
      stopListening.current = useDoubao ? startDoubaoListening(api.companionStt!, callbacks) : startCompanionListening(callbacks);
      setListening(true);
    } catch (err) { setError((err as Error).message); }
  };

  const toggleCamera = async () => {
    if (camera || cameraPending) { stopCamera(); return; }
    if (!char) return;
    setError(''); setCameraPending(true);
    const generation = ++cameraGeneration.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法使用摄像头，请通过 HTTPS 页面打开');
      const stream = await navigator.mediaDevices.getUserMedia(companionCameraConstraints(cameraDeviceId));
      if (generation !== cameraGeneration.current || !mounted.current) { stream.getTracks().forEach(track => track.stop()); return; }
      mediaRef.current = stream;
      for (const track of stream.getVideoTracks()) track.onended = () => {
        if (generation === cameraGeneration.current) { stopCamera(); setError('摄像头已断开，请检查设备后重新开启'); }
      };
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      if (generation !== cameraGeneration.current) return;
      setCameraLabel(stream.getVideoTracks()[0]?.label || ''); setCamera(true);
    } catch (err) {
      if (generation === cameraGeneration.current) { stopCamera(); setError(companionCameraError(err)); }
    } finally { if (generation === cameraGeneration.current) setCameraPending(false); }
  };

  useEffect(() => {
    if (!camera || analysisPaused || !char || !companionVideoReady(videoApi) || !mediaRef.current) return;
    const abort = new AbortController(); visionAbort.current = abort;
    const stream = mediaRef.current;
    const failAnalysis = (err: unknown, fatal: boolean) => {
      if (abort.signal.aborted) return;
      setAnalysisProblem(`${err instanceof Error ? err.message : '视频理解失败'}${fatal ? '' : '；将尝试下一段视频。'}`);
      if (fatal) {
        // Cancel recording and model work, but keep the SAME preview stream alive.
        abort.abort(); setAnalysisPaused(true); setObserving(false); setAnalysisClip(undefined);
      }
    };
    const publish = (next: CompanionObservation) => {
      if (!abort.signal.aborted && mounted.current) { observationRef.current = next; setObservation(next); setAnalysisProblem(''); }
    };
    let record: ReturnType<typeof createCompanionClipRecorder>;
    try { record = createCompanionClipRecorder(stream, abort.signal); }
    catch (err) { failAnalysis(err, true); return () => abort.abort(); }
    startCompanionVideoLoop({ signal: abort.signal,
      record,
      observe: async clip => {
        setObserving(true); setAnalysisClip({ from: clip.from, to: clip.to });
        try { publish(await videoObserver(clip, videoApi, char.id, char.name, abort.signal, { mode: imageMode, helper: api.visionApi }, publish)); }
        finally { if (!abort.signal.aborted && mounted.current) { setObserving(false); setAnalysisClip(undefined); } }
      },
      error: failAnalysis,
    });
    return () => abort.abort();
  }, [camera, analysisPaused, charId, videoApi, api.visionApi, imageMode, videoObserver]);

  const caption = latest && !historyOpen && <div className="companion-caption" key={latest.id}>
    <small>{latest.role === 'user' ? user.name : char?.name}{latest.phase && <b className="companion-reply-label">{companionReplyLabel(latest.phase)}</b>}{latest.status === 'interrupted' ? ' · 已打断' : ''}</small>
    <p>{latest.status === 'interrupted' ? latest.heard || '这句话还没来得及说出口。' : latest.text}</p>
  </div>;

  return <section className={`companion-app${camera ? ' camera-on' : ''}`} aria-label="同行">
    <header className="companion-header">
      <button className="companion-icon" aria-label="返回桌面" onClick={() => { stopAll(); close(); }}><ArrowLeft size={22}/></button>
      <div className="companion-title"><select aria-label="同行角色" value={charId} onChange={event => setCharId(event.target.value)}>
        {!characters.length && <option value="">请先添加角色</option>}
        {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select><small>{status}</small></div>
      <button type="button" className="companion-setup-entry" onClick={() => setSetupOpen(true)}>API 接入</button>
      <button className="companion-icon" aria-label="同行设置" onClick={() => setSettings(!settings)}><SlidersHorizontal size={22}/></button>
    </header>
    <div ref={stageRef} className={`companion-stage${camera ? ' has-camera' : ''}`} data-main={streetMain && camera ? 'street' : 'character'} data-vision={analysisPaused ? 'paused' : observing ? 'analyzing' : 'recording'}>
      <div className="companion-call-pane character">
        {!avatarSettings && <CompanionCharacterView key={char?.id} char={char} spokenText={latest?.role === 'assistant' && latest.status !== 'interrupted' ? latest.text : undefined} motion={latest?.role === 'assistant' && latest.status === 'speaking' ? 'speaking' : listening ? 'listening' : 'idle'}/>}
      </div>
      <div className="companion-call-pane street" hidden={!camera && !cameraPending}>
        <video ref={videoRef} muted playsInline onLoadedMetadata={updateStreetAspect} onResize={updateStreetAspect}
          aria-label="摄像头实时画面" className={camera || cameraPending ? 'is-on' : ''}/>
      </div>
      {camera && <button type="button" className="companion-swap" onClick={() => setStreetMain(value => !value)}
        aria-label={streetMain ? '将角色切到主画面' : '将街景切到主画面'}>
        <span>{streetMain ? char?.name : '街景'} <ArrowsOutSimple size={13}/></span>
      </button>}
    </div>
      {historyOpen && <div className="companion-history" aria-label="本次同行记录">
        <header>本次同行<button onClick={() => setHistoryOpen(false)}>收起</button></header>
        {!lines.length && <p>从一句话开始。</p>}
        {lines.map(line => <article key={line.id} data-role={line.role}><small>{line.role === 'user' ? user.name : char?.name}{line.phase && <b className="companion-reply-label">{companionReplyLabel(line.phase)}</b>}{line.status === 'interrupted' ? ' · 已打断' : ''}</small><p>{line.status === 'interrupted' ? line.heard || '未播放' : line.text}</p></article>)}
      </div>}
      {settings && <div className="companion-settings">
        <header>同行设置<button onClick={() => setSettings(false)}>完成</button></header>
        {editAvatar && <button type="button" className="companion-reset" disabled={!char} onClick={() => { stopAll(); setAvatarSettings(true); }}>角色形象</button>}
        <button type="button" className="companion-reset" onClick={() => setSetupOpen(true)}>API 配置与注册引导</button>
        <p>上下文：{char && resolveContextRangeMode(char) === 'adaptive' ? '跟随自动记忆' : `最近 ${clampManualContextLimit(char?.contextLimit)} 条`}。与消息 App 共用角色设置。</p>
        <label className="companion-quick-toggle"><input type="checkbox" checked={quickEnabled} onChange={event => {
          const enabled = event.target.checked;
          if (saveQuickReply) saveQuickReply(enabled); else setLocalQuickReply(enabled);
        }}/>短接话 a</label>
        <p>从下一句话生效。关闭时直接准备完整上下文，只生成和播放 a′。</p>
        <label className="companion-quick-toggle"><input type="checkbox" checked={bargeIn} onChange={event => {
          const enabled = event.target.checked;
          if (saveBargeIn) saveBargeIn(enabled); else setLocalBargeIn(enabled);
        }}/>插话打断</label>
        <p>开启时，识别到你说话就打断角色。关闭后，说完的话和发出的文字会等角色讲完，再合成下一轮发送。</p>
        {quickEnabled && <label>接话设定<textarea value={style} maxLength={2400} disabled={!!session.current} onChange={event => setStyle(event.target.value)}/></label>}
        <p>连续听：{useDoubao ? '豆包流式语音识别 2.0' : '浏览器识别'}。在「设置 → 其他 API」中配置；建议戴耳机避免识别到角色的外放声音。</p>
        <p>镜头开启后始终显示完整实时画面。后台录制约 8 秒的无声视频片段交给视频理解 API；绿色边框表示正在分析已录完的片段。分析失败会暂停理解，实时预览保留。主模型默认只收视频摘要；补充截图在 API 接入中选择。视频和截图不存档，本次对话离开后清空。</p>
        <button className="companion-reset" onClick={() => { stopAll(); session.current = undefined; debug.clear(); setLines([]); setStatus('已结束本次同行'); }}>结束本次同行</button>
      </div>}
    {caption && <div className="companion-camera-caption">{caption}</div>}
    <div className="companion-call-info">
    <details className="companion-devices"><summary>摄像头来源</summary><CompanionCameraSource selected={cameraDeviceId} active={camera} activeLabel={cameraLabel} change={deviceId => {
      session.current?.interrupt('切换摄像头'); stopCamera(); setCameraDeviceId(deviceId); setError('');
    }}/></details>
    {!camera && !cameraPending && savedVideo && !miniMaxDirect && domesticKey && saveVideoApi &&
      <div className="companion-video-status"><button type="button" onClick={() => {
        saveVideoApi({ ...savedVideo, preferSharedMiniMax: true });
        setStatus('已切换到 MiniMax 直连，可开启镜头');
      }}>切换到 MiniMax 直连</button></div>}
    <CompanionVideoStatus active={camera} analyzing={observing} paused={analysisPaused} configured={companionVideoReady(videoApi)}
      clip={analysisClip} lastSeen={observation?.to} problem={analysisProblem}
      retry={() => { setAnalysisProblem(''); setAnalysisPaused(false); }} configure={() => setSetupOpen(true)}/>
    <CompanionReplyProgress store={debug}/>
    <CompanionDebugPanel store={debug}/>
    </div>
    <footer className="companion-controls">
      {!companionDialogueReady(api, char) && <button type="button" className="companion-setup-hint" onClick={() => setSetupOpen(true)}>还没配置对话模型？从这里开始 →</button>}
      {error && <div className="companion-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
      <div className="companion-sensing"><span>{partial || (listening ? micStatus || '在听，直接开口就好' : '可输入文字，或开启连续听')}</span><button aria-label="本次记录" onClick={() => setHistoryOpen(!historyOpen)}><ChatsCircle size={20}/></button></div>
      {pendingInput && <div className="companion-pending" role="status" aria-label="下一轮待发送"><strong>下一轮待发送</strong> {pendingInput}</div>}
      <CompanionMicMeter data={micDiagnostics} active={listening}/>
      <form onSubmit={event => { event.preventDefault(); send(input); }}><input aria-label="对同行伙伴说" placeholder="你看，这件怎么样？" value={input} onChange={event => setInput(event.target.value)}/><button type="submit" aria-label="发送" disabled={!input.trim() || !char}><ArrowUp size={22}/></button></form>
      <div className="companion-actions">
        <button aria-pressed={camera} onClick={() => void toggleCamera()} disabled={!char}>{camera ? <Camera size={23}/> : <CameraSlash size={23}/>}<span>{cameraPending ? '取消开启' : camera ? '关闭镜头' : miniMaxDirect ? '开启镜头 · MiniMax 直连' : '开启镜头'}</span></button>
        <button aria-pressed={listening} onClick={toggleMic} disabled={!char || !canListen}>{listening ? <Microphone size={23}/> : <MicrophoneSlash size={23}/>}<span>{listening ? '暂停聆听' : '连续听'}</span></button>
        <button aria-pressed={voiceEnabled && canVoice} onClick={() => { voiceOn.current = !voiceEnabled; setVoiceEnabled(!voiceEnabled); voice.current.prime(); void session.current?.skipReply(); }} disabled={!canVoice}>{voiceEnabled && canVoice ? <SpeakerHigh size={23}/> : <SpeakerSlash size={23}/>}<span>{canVoice ? voiceEnabled ? '角色语音' : '文字模式' : '未配音色'}</span></button>
        <button onClick={() => { void session.current?.skipReply(); }}><Stop size={23}/><span>打断</span></button>
        <button type="button" className="companion-hangup" onClick={() => { stopAll(); close(); }}><PhoneDisconnect size={23} weight="fill"/><span>结束同行</span></button>
      </div>
      {observation && <details className="companion-observation"><summary>最近理解的视频</summary><p>{observationText(observation)}</p>{observation.imageNote && <p>{observation.imageNote}</p>}</details>}
      {!canListen && <small className="companion-note">此浏览器不支持当前识别方式。可输入文字，或通过「API 接入 → 去设置语音识别」选择其他方式。</small>}
    </footer>
    {avatarSettings && char && <React.Suspense fallback={<div className="companion-settings" role="status">正在打开角色形象…</div>}>
      <AvatarSettings key={char.id} char={char} close={() => setAvatarSettings(false)}/>
    </React.Suspense>}
    {setupOpen && <CompanionSetupGuide char={char} api={api} beforeTest={stopAll} imageMode={imageMode} changeImageMode={mode => {
      stopAll(); session.current = undefined; debug.clear(); setImageMode(mode); setStatus('截图方式已更新，可重新开启同行');
    }} saveVideoApi={saveVideoApi ? config => {
      stopAll(); session.current = undefined; debug.clear(); saveVideoApi(config); setStatus('视频 API 已保存，可重新开启镜头');
    } : undefined} canListen={canListenContinuously()} close={() => setSetupOpen(false)} navigate={target => {
      if (!navigateSetup) { setError('此模拟页不进入真实配置，请在主应用打开同行后配置。'); setSetupOpen(false); return; }
      stopAll(); session.current = undefined; setSetupOpen(false);
      navigateSetup(target, char?.id);
    }}/>}
  </section>;
}

export default function CompanionApp() {
  const { characters, userProfile, apiConfig, updateApiConfig, realtimeConfig, closeApp, openApp } = useOS();
  return <CompanionSurface editAvatar characters={characters} user={userProfile} api={apiConfig} realtimeConfig={realtimeConfig} close={closeApp}
    navigateSetup={(target, charId) => openCompanionSetupTarget(target, charId, openApp)} saveVideoApi={config => updateApiConfig({ companionVideoApi: config })}
    saveQuickReply={enabled => updateApiConfig({ companionQuickReply: enabled })}
    saveBargeIn={enabled => updateApiConfig({ companionBargeIn: enabled })}/>;
}

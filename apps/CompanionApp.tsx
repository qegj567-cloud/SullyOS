import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, CaretRight, Camera, CameraSlash, Microphone, MicrophoneSlash, PhoneDisconnect, SpeakerHigh, SpeakerSlash, Stop, Timer, Wrench, ClockCounterClockwise, Waveform, Translate, VideoCamera, PlugsConnected, SlidersHorizontal } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import type { APIConfig, CharacterProfile, RealtimeConfig, UserProfile } from '../types';
import { CompanionSession, type CompanionLine, type CompanionPorts, type IdleConversationSeconds } from '../utils/companion/session';
import { createCompanionRequests } from '../utils/companion/requests';
import { CompanionVoice } from '../utils/companion/voice';
import { canListenContinuously, startCompanionListening, type ListeningCallbacks, type ListeningDiagnostics } from '../utils/companion/listening';
import { CompanionMicMeter } from '../components/companion/CompanionMicMeter';
import { canUseDoubaoListening, startDoubaoListening } from '../utils/companion/doubaoListening';
import { observeCompanionVideo, observationText, companionVideoReady, type CompanionImageMode, type CompanionObservation } from '../utils/companion/vision';
import { createCompanionClipRecorder, startCompanionVideoLoop } from '../utils/companion/capture';
import { domesticMiniMaxVideoKey, resolveCompanionVideoApi } from '../utils/companion/videoProviders';
import { canSynthesizeSpeech } from '../utils/ttsRouter';
import { resolveContextRangeMode, clampManualContextLimit } from '../utils/chatContextRange';
import { CompanionDebugStore } from '../utils/companion/debug';
import { holdCompanionPresence } from '../utils/companion/presence';
import { useCompanionWakeLock } from '../utils/companion/useCompanionWakeLock';
import { companionCameraConstraints, companionCameraError, type CameraSourceHint } from '../utils/companion/cameraSource';
import { CompanionCameraSource } from '../components/companion/CompanionCameraSource';
import { CompanionCharacterView } from '../components/companion/CompanionCharacterView';
import { CompanionDebugPanel } from '../components/companion/CompanionDebugPanel';
import { RoleCameraSelect, useRoleCamera } from '../components/call/RoleCameraSelect';
import { companionPerformanceFormat } from '../utils/roleCamera';
import { useBlobRefUrl } from '../utils/blobRef';
import { RolePlacementLayer, RolePlacementSettings } from '../components/call/RolePlacement';
import { normalizePlacement, patchCallPlacement } from '../utils/callRolePlacement';
import type { CallRolePlacement } from '../types';
import { CompanionHistory } from '../components/companion/CompanionHistory';
import { resolveTtsProvider } from '../utils/ttsProvider';
import { VOICE_LANGUAGE_OPTIONS, voiceLanguageAnalyticsValue } from '../utils/voiceLanguage';
import { trackEvent } from '../utils/analytics';
import { CompanionDialog, type CompanionToolPage } from '../components/companion/CompanionDialog';
import { CompanionReplyProgress } from '../components/companion/CompanionReplyProgress';
import { CompanionVideoStatus } from '../components/companion/CompanionVideoStatus';
import { CompanionSetupGuide } from '../components/companion/CompanionSetupGuide';
import { companionDialogueReady, openCompanionSetupTarget, type CompanionSetupTarget } from '../utils/companion/setup';
import './companion.css';
import { useCallComposerViewport } from '../components/call/useCallComposerViewport';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import { runCallMemoryPalacePostFlow } from '../utils/memoryPalace/callPostFlow';

const AvatarSettings = React.lazy(() => import('../components/companion/CompanionAvatarSettings'));
const layouts = { overlay: '同屏叠放', rows: '上下分屏', columns: '左右分屏', pip: '大小窗' } as const;

type Requests = ReturnType<typeof createCompanionRequests>;
type RequestFactory = (context: Parameters<typeof createCompanionRequests>[0]) => Omit<Requests, 'saveLine'> & Partial<Pick<Requests, 'saveLine'>>;
export interface CompanionSurfaceProps {
  characters: CharacterProfile[]; user: UserProfile; api: APIConfig; realtimeConfig?: RealtimeConfig;
  savePlacement?(id: string, value: CallRolePlacement): void;
  onArchived?(charId: string, role: CompanionLine['role'], phase?: CompanionLine['phase']): void;
  close(): void;
  foreground?: boolean;
  onRetentionChange?(retain: boolean): void;
  navigateSetup?(target: CompanionSetupTarget, charId?: string): void;
  saveQuickReply?(enabled: boolean): void;
  saveBargeIn?(enabled: boolean): void;
  saveLanguage?(charId: string, language: string): void;
  introKey?: string;
  initialView?: 'call' | 'tools';
  editAvatar?: boolean;
  /** Fixture injection only; production always uses the shared request pipeline. */
  playSample?: CompanionPorts<unknown>['play'];
  requestFactory?: RequestFactory;
  videoObserver?: typeof observeCompanionVideo;
}

export function CompanionSurface({ characters, user, api, realtimeConfig, close, foreground = true, onRetentionChange, navigateSetup, saveQuickReply, saveBargeIn, saveLanguage, savePlacement, onArchived, editAvatar, playSample, initialView = 'call', introKey = 'sully_companion_intro_v1', requestFactory = createCompanionRequests, videoObserver = observeCompanionVideo }: CompanionSurfaceProps) {
  const [charId, setCharId] = useState(characters[0]?.id || '');
  const callViewport = useCallComposerViewport(foreground);
  const archivedRef = useRef(onArchived); archivedRef.current = onArchived;
  const char = characters.find(item => item.id === charId);
  const roleCamera = useRoleCamera(char);
  const [previewPlacements, setPreviewPlacements] = useState<Record<string, CallRolePlacement>>({});
  const placement = {
    value: normalizePlacement((!savePlacement && previewPlacements[charId]) || char?.companionAvatar?.callPlacements?.companion),
    save: (value: CallRolePlacement) => {
      if (savePlacement) savePlacement(charId, value);
      else setPreviewPlacements(previous => ({ ...previous, [charId]: value }));
    },
  };
  const currentFormat = useRef('');
  const [immersive, setImmersive] = useState(false);
  currentFormat.current = useMemo(() => companionPerformanceFormat(roleCamera.view, char, immersive), [roleCamera.view, char, immersive]);
  const [demoLanguage, setDemoLanguage] = useState('');
  const language = saveLanguage ? char?.callVoiceLang || '' : demoLanguage;
  const languageRef = useRef(language); languageRef.current = language;
  const ttsName = { fishaudio: '鱼声 Fish Audio', minimax: 'MiniMax', elevenlabs: 'ElevenLabs' }[resolveTtsProvider(api)];
  const [introOpen, setIntroOpen] = useState(() => {
    if (initialView === 'tools') return false;
    try { return localStorage.getItem(introKey) !== 'seen'; } catch { return true; }
  });
  const dismissIntro = () => {
    setIntroOpen(false);
    try { localStorage.setItem(introKey, 'seen'); } catch { /* storage unavailable */ }
  };
  const [style, setStyle] = useState('');
  const [settings, setSettings] = useState<CompanionToolPage | null>(initialView === 'tools' ? 'home' : null);
  const [keepAwake, setKeepAwake] = useState(false);
  const wake = useCompanionWakeLock(keepAwake);
  const [continueAway, setContinueAway] = useState(false);
  const away = useRef(false);
  const changeRetention = (enabled: boolean) => {
    away.current = enabled;
    setContinueAway(enabled);
    onRetentionChange?.(enabled);
  };
  const wrench = useRef<HTMLButtonElement>(null);
  const cameraToggle = useRef<HTMLButtonElement>(null);
  const cameraSelect = useRef<HTMLSelectElement>(null);
  const cameraHintTrigger = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const closeTools = () => {
    const trigger = cameraHintTrigger.current;
    returnFocus.current = trigger ? (trigger.isConnected ? trigger : cameraToggle.current) : wrench.current;
    cameraHintTrigger.current = null;
    setSettings(null);
  };
  useLayoutEffect(() => {
    if (settings || !returnFocus.current) return;
    returnFocus.current.focus({ preventScroll: true });
    returnFocus.current = null;
  }, [settings]);
  const [avatarSettings, setAvatarSettings] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [debug] = useState(() => new CompanionDebugStore());
  const [lines, setLines] = useState<CompanionLine[]>([]);
  const [status, setStatus] = useState('选好伙伴，开始同行');
  const [error, setError] = useState<string | CameraSourceHint | { message: string; setting: 'stt' | 'dialogue' }>('');
  const [input, setInput] = useState('');
  const [partial, setPartial] = useState('');
  const [pendingInput, setPendingInput] = useState('');
  const [listening, setListening] = useState(false);
  const [micStatus, setMicStatus] = useState('');
  const [micDiagnostics, setMicDiagnostics] = useState<ListeningDiagnostics>();
  const [camera, setCamera] = useState(false);
  const [layout, setLayout] = useState<keyof typeof layouts>('overlay');
  const [cameraMain, setCameraMain] = useState(false);
  const [idleSeconds, setIdleSeconds] = useState<IdleConversationSeconds>(0);
  const dualView = camera && roleCamera.view !== 'off';
  const [cameraAspect, setCameraAspect] = useState(0);
  const idleBackground = useBlobRefUrl(!camera && roleCamera.enabled ? char?.videoCallBackground : undefined);
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
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const syncFrame = () => {
      if (video.videoWidth && video.videoHeight) setCameraAspect(video.videoWidth / video.videoHeight);
    };
    video.addEventListener('loadedmetadata', syncFrame);
    video.addEventListener('resize', syncFrame);
    return () => {
      video.removeEventListener('loadedmetadata', syncFrame);
      video.removeEventListener('resize', syncFrame);
    };
  }, []);
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
  const canVoice = !!char && (!!playSample || canSynthesizeSpeech(char, api));
  const latest = lines.at(-1);
  const useDoubao = api.companionStt?.provider === 'doubao';
  const canListen = useDoubao ? canUseDoubaoListening() : canListenContinuously();
  const domesticKey = domesticMiniMaxVideoKey(api);
  const savedVideo = api.companionVideoApi;
  const videoApi = useMemo(() => resolveCompanionVideoApi(savedVideo, domesticKey), [savedVideo, domesticKey]);

  const stopMic = () => { stopListening.current?.(); stopListening.current = undefined; session.current?.speechEnded(); setListening(false); setPartial(''); setMicStatus(''); setMicDiagnostics(undefined); };
  const stopCamera = () => {
    cameraGeneration.current++;
    visionAbort.current?.abort();
    mediaRef.current?.getTracks().forEach(track => track.stop()); mediaRef.current = undefined;
    observationRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera(false); setCameraAspect(0); setCameraPending(false); setObservation(undefined); setObserving(false);
    setCameraLabel('');
    setAnalysisPaused(false); setAnalysisProblem(''); setAnalysisClip(undefined);
  };
  const stopAll = () => { session.current?.interrupt('停止看听、配置或测试'); stopMic(); stopCamera(); };
  const endOuting = () => { changeRetention(false); setKeepAwake(false); setIdleSeconds(0); stopAll(); };
  const leaveOuting = async () => {
    endOuting();
    try { await session.current?.flushHistory(); close(); }
    catch { setError('同行对话尚未保存。请检查本机存储，再点一次结束同行重试。'); }
  };

  useEffect(() => charId ? holdCompanionPresence(charId) : undefined, [charId]);

  useEffect(() => {
    session.current?.interrupt('切换角色'); session.current = undefined;
    setIdleSeconds(0);
    debug.clear();
    stopMic(); stopCamera(); setLines([]); setImageMode('none'); setDemoLanguage(char?.callVoiceLang || ''); setStatus('在你身边');
    // This editable seed is intentionally short and visibly labelled as an excerpt.
    setStyle(char?.systemPrompt?.slice(0, 1600) || '保留角色的身份和熟悉的说话方式，自然回应眼前的话题。');
  }, [charId]);
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      if (document.hidden && !away.current) { stopAll(); setStatus('已暂停，回到页面后可重新开启'); }
    };
    const leavePage = () => { endOuting(); setStatus('已暂停，可重新开启镜头和聆听'); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leavePage);
    return () => {
      mounted.current = false;
      session.current?.interrupt('离开同行'); stopListening.current?.(); visionAbort.current?.abort();
      cameraGeneration.current++; mediaRef.current?.getTracks().forEach(track => track.stop());
      voice.current.close(); document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leavePage);
      if (away.current) onRetentionChange?.(false);
    };
  }, []);

  const ensureSession = () => {
    if (!char) throw new Error('请先在神经链接中添加角色');
    if (!session.current) {
      const requests = requestFactory({ char, user, api, style, realtimeConfig, debug, replyFormat: () => currentFormat.current, observation: () => observationRef.current, imageMode,
        onArchived: (role, phase) => archivedRef.current?.(char.id, role, phase) });
      session.current = new CompanionSession({ ...requests, debug, language: () => languageRef.current,
        play: async (text, signal, heard, started, speech) => {
          if (!voiceOn.current || !canVoice) { signal.throwIfAborted(); started('text'); heard(text); return; }
          if (playSample) return playSample(text, signal, heard, started, speech);
          await voice.current.play(text, char, api, signal, heard, () => started('audio'), speech);
        },
        change: (next, state) => { if (mounted.current) { setLines(next); setStatus(state); } },
        pendingInput: text => { if (mounted.current) setPendingInput(text); },
        error: err => {
          if (!mounted.current) return;
          setIdleSeconds(0);
          const message = err instanceof Error ? err.message : '本轮没有完成，请重试';
          setError(companionDialogueReady(api, char) ? message : { message, setting: 'dialogue' });
        },
      }, lines);
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
    if (useDoubao && !api.companionStt?.apiKey.trim()) { setError({ message: '豆包听写需要语音 Key。', setting: 'stt' }); return; }
    setError(''); setMicDiagnostics(undefined); voice.current.prime();
    try {
      const current = ensureSession();
      const callbacks: ListeningCallbacks = {
        speech: () => current.speechStarted(bargeInRef.current), partial: setPartial,
        final: text => sendRef.current(text, true), speechEnded: () => { void current.speechEnded(); },
        error: (message, setting) => { void current.speechEnded(); setError(setting ? { message, setting } : message); setListening(false); setPartial(''); setMicStatus(''); stopListening.current = undefined; },
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
        if (generation === cameraGeneration.current) { stopCamera(); setError({ message: '摄像头已断开。请重新连接设备，或打开', setting: 'camera' }); }
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

  const openService = (target: CompanionSetupTarget) => {
    if (introOpen) dismissIntro();
    if (!navigateSetup) { setSetupOpen(true); return; }
    endOuting(); session.current = undefined; setSetupOpen(false); setSettings(null);
    navigateSetup(target, char?.id);
  };
  const cameraSettingLink = (label: string) => <button type="button" className="companion-error-action" onClick={event => {
    cameraHintTrigger.current = event.currentTarget;
    setSettings('camera');
  }}>{label}</button>;
  const serviceLinks = <nav className="companion-services" aria-label="服务设置">
    {([
      [char?.dialogueApi ? 'character' : 'api', '对话模型', companionDialogueReady(api, char) ? '已配置' : '待设置'],
      ['video', '视频理解', companionVideoReady(videoApi) ? '已配置' : '可选'],
      ['stt', '语音识别', useDoubao ? '豆包' : canListen ? '浏览器' : '待设置'],
      ['voice', '角色语音', ttsName],
    ] as const).map(([target, label, detail]) => <button type="button" key={target} onClick={() => openService(target)}>
      {label}<small>{detail}</small><CaretRight size={15}/></button>)}
  </nav>;
  const busyTalking = latest?.role === 'assistant' && latest.status === 'speaking';
  const publicStatus = busyTalking ? '正在说话' : /接话|准备|继续想|生成/.test(status) ? '正在想'
    : listening ? '正在聆听' : status === '已停下，听你说' ? '已停下' : status;
  const overlay = introOpen || !!settings || historyOpen || setupOpen || avatarSettings;
  const sessionFactory = useRef(ensureSession);
  sessionFactory.current = ensureSession;
  useEffect(() => {
    if (!idleSeconds || !charId || overlay || !foreground || input.trim()) return;
    const current = sessionFactory.current();
    const sync = () => current.setIdleConversation(document.hidden ? 0 : idleSeconds);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => { current.setIdleConversation(0); document.removeEventListener('visibilitychange', sync); };
  }, [idleSeconds, charId, overlay, foreground, input]);
  const cameraAction = cameraPending ? '取消开启' : camera ? '关闭镜头' : '开启镜头';
  const retryVideo = () => { setAnalysisProblem(''); setAnalysisPaused(false); };

  return <section className="companion-app" aria-label="同行" ref={callViewport}>
    <div className="companion-main" aria-hidden={overlay || undefined} ref={node => { if (node) node.inert = overlay; }}>
      <header className="companion-header">
        <button type="button" aria-label="返回桌面" onClick={() => { if (away.current) close(); else void leaveOuting(); }}><ArrowLeft size={22}/></button>
        <div className="companion-title"><select aria-label="同行角色" value={charId} onChange={event => setCharId(event.target.value)}>
          {!characters.length && <option value="">请先添加角色</option>}
          {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select><small>{publicStatus}</small></div>
        <div className="companion-head-tools"><button type="button" className="companion-log-entry" aria-label="历史记录" onClick={() => { setHistoryOpen(true); trackEvent('打开通话记录'); }}><ClockCounterClockwise size={17}/><span>历史</span></button>
        <button type="button" ref={wrench} aria-label="同行设置" title="通话工具" onClick={() => setSettings('home')}><Wrench size={21}/></button></div>
      </header>
      <div className="companion-stage" data-layout={dualView ? layout : 'overlay'} data-camera-main={cameraMain} data-camera={camera ? 'on' : 'off'} data-vision={analysisPaused ? 'paused' : observing ? 'analyzing' : 'idle'}>
        <div className="companion-scene" style={camera && cameraAspect ? { '--camera-aspect': cameraAspect } as React.CSSProperties : undefined}>
          {idleBackground && !camera && roleCamera.enabled && <img className="companion-call-background" src={idleBackground} alt=""/>}
          <video ref={videoRef} muted playsInline aria-label="摄像头实时画面" className={camera || cameraPending ? 'is-on' : ''}/>
          <div className="companion-role-pane">{foreground && char && roleCamera.view !== 'off' && !avatarSettings && <RolePlacementLayer key={char.id} control={placement}
            sceneModel={roleCamera.view === 'model' && char.videoAvatar?.format === 'live2d'} corner={dualView && layout === 'overlay'}
            className="companion-foreground" view={roleCamera.view} label="角色画面">
              <CompanionCharacterView key={char.id} char={char} view={roleCamera.view} immersive={immersive}
                direction={latest?.role === 'assistant' && latest.status !== 'interrupted' ? latest.performance : undefined}
                spokenText={latest?.role === 'assistant' && latest.status !== 'interrupted' ? latest.text : undefined}
                motion={busyTalking ? 'speaking' : listening ? 'listening' : 'idle'}/>
          </RolePlacementLayer>}</div>
        </div>
        {!char ? <div className="companion-lens-off"><button className="companion-add-partner" onClick={() => openService('character')}>添加同行角色</button></div>
          : !camera && roleCamera.view === 'off' && <div className="companion-lens-off"><CameraSlash size={28}/><span>{cameraPending ? '正在开启镜头' : '双方镜头已关闭'}</span></div>}
        <div className="companion-lenses" role="group" aria-label="镜头开关">
          <button type="button" aria-pressed={camera} ref={cameraToggle} aria-label={cameraAction} title={cameraAction} disabled={!char} onClick={() => void toggleCamera()}>
            {camera ? <Camera size={17}/> : <CameraSlash size={17}/>}<span>{cameraPending ? '开启中…' : '我的镜头'}</span></button>
          <button type="button" disabled={!char} aria-pressed={roleCamera.enabled} aria-label={roleCamera.enabled ? '关闭角色镜头' : '开启角色镜头'} onClick={roleCamera.toggle}>
            {roleCamera.enabled ? <Camera size={17}/> : <CameraSlash size={17}/>}<span>角色镜头</span></button>
        </div>
        {camera && (observing || !companionVideoReady(videoApi)) && <span className="companion-scene-status">{observing ? '正在看' : '仅实时预览'}</span>}
        {analysisPaused && <button type="button" className="companion-retry" onClick={retryVideo} aria-label="重试视频理解">视频理解已暂停 · 重试</button>}
      </div>
      {latest && <div className="companion-caption"><small>{latest.role === 'user' ? user.name : char?.name}{latest.status === 'interrupted' ? ' · 已打断' : ''}</small>
        <p>{latest.status === 'interrupted' ? latest.heard || '未播放' : latest.text}</p>{latest.translation && latest.status !== 'interrupted' && <p className="companion-subtitle" lang={latest.language}>{latest.translation}</p>}</div>}
      <footer className="companion-controls">
        {error && <div className="companion-error" role="alert">
          <span>{typeof error === 'string' ? error : error.setting === 'camera' ? <>
            {error.message}{cameraSettingLink('摄像头来源')}选择设备。
            {error.suggestVts && <>用 VTS 时，先开启虚拟输出，再选{cameraSettingLink('VTubeStudioCam')}。</>}
          </> : <>{error.message} <button type="button" className="companion-error-action" onClick={() => openService(
            error.setting === 'stt' ? 'stt' : char?.dialogueApi ? 'character' : 'api'
          )}>{error.setting === 'stt' ? '语音识别设置' : '对话模型设置'}</button></>}</span>
          <button type="button" className="companion-error-close" aria-label="关闭提示" onClick={() => setError('')}>×</button>
        </div>}
        {partial && <div className="companion-partial">{partial}</div>}
        {pendingInput && <div className="companion-pending" role="status" aria-label="下一轮待发送"><strong>下一轮待发送</strong> {pendingInput}</div>}
        <form data-call-composer onSubmit={event => { event.preventDefault(); send(input); }}><input aria-label="对同行伙伴说" placeholder="说点什么…" value={input} onChange={event => setInput(event.target.value)}/>
          <button type="submit" aria-label="发送" disabled={!input.trim() || !char}><ArrowUp size={19}/></button></form>
        <div className="companion-actions">
          <button aria-pressed={listening} onClick={toggleMic} disabled={!char || !canListen}>{listening ? <Microphone size={21}/> : <MicrophoneSlash size={21}/>}<span>{listening ? '暂停聆听' : '连续听'}</span></button>
          <button aria-pressed={voiceEnabled && canVoice} onClick={() => { voiceOn.current = !voiceEnabled; setVoiceEnabled(!voiceEnabled); voice.current.prime(); void session.current?.skipReply(); }} disabled={!canVoice}>{voiceEnabled && canVoice ? <SpeakerHigh size={21}/> : <SpeakerSlash size={21}/>}<span>{canVoice ? voiceEnabled ? '角色语音' : '文字模式' : '未配音色'}</span></button>
          <div className="companion-idle-control" data-on={idleSeconds > 0}>
            <Timer size={21} aria-hidden="true"/>
            <select aria-label="自动续聊" title="完整回复结束后，等待多久再继续聊" value={idleSeconds} disabled={!char} onChange={event => {
              const next = Number(event.target.value);
              if (next !== 0 && next !== 30 && next !== 60) return;
              if (!next) session.current?.stopIdleConversation(); else voice.current.prime();
              setIdleSeconds(next);
              if (!!next !== !!idleSeconds) trackEvent('开关同行主动开口', { 状态: next ? '开' : '关' });
              if (next) trackEvent('设置同行续聊间隔', { 间隔: next === 30 ? '30 秒' : '1 分钟' });
            }}><option value={0}>续聊关闭</option><option value={30}>续聊 30 秒</option><option value={60}>续聊 1 分钟</option></select>
          </div>
          <button onClick={() => void session.current?.skipReply()}><Stop size={21}/><span>打断</span></button>
          <button className="companion-hangup" onClick={() => void leaveOuting()}><PhoneDisconnect size={21} weight="fill"/><span>结束同行</span></button>
        </div>
      </footer>
    </div>
    {foreground && introOpen && <CompanionDialog title="开始同行" close={dismissIntro}>
      <p>选一个角色就能用文字交谈。想让对方听你说话、看见街景，可以在这里接入需要的服务。配置视频理解后，开启自己的镜头会把短片发给所选服务。</p>
      {serviceLinks}
      {!char && <button className="companion-link" onClick={() => openService('character')}>添加同行角色</button>}
      <button type="button" className="companion-primary" onClick={dismissIntro}>进入同行</button>
    </CompanionDialog>}
    {foreground && settings && !setupOpen && !avatarSettings && !historyOpen && <CompanionDialog toolPage={settings}
      title={{ home: '通话工具', camera: '镜头与形象', services: '连接与服务', outing: '亮屏与暂离', debug: '回复与调试' }[settings]}
      close={settings === 'home' || cameraHintTrigger.current ? closeTools : () => setSettings('home')} dismissTools={closeTools}
      focusTarget={settings === 'camera' && cameraHintTrigger.current ? cameraSelect : undefined}>
      {settings === 'home' && <>
        <section className="companion-tool-group"><h3>交谈偏好</h3>
          <div className="companion-tool-list">
            <label className="companion-tool-row"><Waveform size={22} aria-hidden="true"/>
              <span className="companion-tool-copy"><strong>插话打断</strong><small id="companion-interrupt-hint">{bargeIn ? '开口时，角色会停下来听你说' : '插话会留到角色说完后发送'}</small></span>
              <input aria-label="插话打断" aria-describedby="companion-interrupt-hint" className="companion-switch" type="checkbox" checked={bargeIn} onChange={event => {
                if (saveBargeIn) saveBargeIn(event.target.checked); else setLocalBargeIn(event.target.checked);
              }}/>
            </label>
            <label className="companion-tool-row"><Translate size={22} aria-hidden="true"/>
              <span className="companion-tool-copy"><strong>通话翻译</strong></span>
              <span className="companion-tool-language"><select aria-label="通话翻译" value={language} disabled={!char} onChange={event => {
                const value = event.target.value;
                if (char && saveLanguage) saveLanguage(char.id, value); else setDemoLanguage(value);
                trackEvent('设置通话语音语种', { 语种: voiceLanguageAnalyticsValue(value) });
              }}>{VOICE_LANGUAGE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.value ? option.label : '关闭'}</option>)}</select><CaretRight aria-hidden="true" size={15}/></span>
            </label>
          </div>
        </section>
        <section className="companion-tool-group"><h3>设备与服务</h3>
          <nav className="companion-tool-list" aria-label="设备与服务">
            <button type="button" aria-label="镜头与形象" data-tool="camera" className="companion-tool-row" onClick={() => setSettings('camera')}>
              <VideoCamera size={22}/><span className="companion-tool-copy"><strong>镜头与形象</strong><small>摄像头来源、角色外观</small></span><CaretRight size={17}/>
            </button>
            <button type="button" aria-label="连接与服务" data-tool="services" className="companion-tool-row" onClick={() => setSettings('services')}>
              <PlugsConnected size={22}/><span className="companion-tool-copy"><strong>连接与服务</strong><small>对话、视频与语音 API</small></span><CaretRight size={17}/>
            </button>
            <button type="button" aria-label="亮屏与暂离" data-tool="outing" className="companion-tool-row" onClick={() => setSettings('outing')}>
              <SlidersHorizontal size={22}/><span className="companion-tool-copy"><strong>亮屏与暂离</strong><small>本次同行的屏幕和后台行为</small></span><CaretRight size={17}/>
            </button>
          </nav>
        </section>
        <button type="button" data-tool="debug" className="companion-tool-advanced" onClick={() => setSettings('debug')}>
          <SlidersHorizontal size={18}/>回复与调试<CaretRight size={15}/>
        </button>
      </>}
      {settings === 'outing' && <section className="companion-tool-group"><h3>仅本次同行</h3><div className="companion-tool-list">
        <label className="companion-tool-row"><span className="companion-tool-copy"><strong>保持亮屏</strong><small id="companion-wake-hint" role="status">{wake.hint}</small></span>
          <input className="companion-switch" type="checkbox" aria-label="保持亮屏" aria-describedby="companion-wake-hint" disabled={!wake.supported} checked={keepAwake} onChange={event => setKeepAwake(event.target.checked)}/>
        </label>
        <label className="companion-tool-row"><span className="companion-tool-copy"><strong>暂离时继续同行</strong><small id="companion-away-hint">切到桌面或其他应用时，已开启的镜头和麦克风会继续向所选服务发送。手机锁屏或冻结网页时可能暂停。</small></span>
          <input className="companion-switch" type="checkbox" aria-label="暂离时继续同行" aria-describedby="companion-away-hint" checked={continueAway} onChange={event => changeRetention(event.target.checked)}/>
        </label>
      </div></section>}
      {settings === 'camera' && <>
        <section><h3>双镜头布局</h3>
          <label className="companion-option">画面布局<select value={layout} onChange={event => {
            const next = event.target.value as keyof typeof layouts;
            if (!Object.hasOwn(layouts, next)) return;
            setLayout(next); trackEvent('切换同行画面布局', { 布局: layouts[next] });
          }}>
            {Object.entries(layouts).map(([value, name]) => <option value={value} key={value}>{name}</option>)}
          </select></label>
          {layout === 'pip' && <label className="companion-option">主画面<select value={cameraMain ? 'camera' : 'role'} onChange={event => setCameraMain(event.target.value === 'camera')}>
            <option value="role">角色</option><option value="camera">我的镜头</option>
          </select></label>}
        </section>
        <section><h3>角色画面</h3><label className="companion-option">角色镜头形象<RoleCameraSelect char={char} camera={roleCamera}/></label>
          <label className="companion-tool-row"><span className="companion-tool-copy"><strong>沉浸式表演</strong><small id="companion-acting-hint">动态模型随台词做动作，见面立绘切换已配置的表情，Chibi 保持原样。生成可能稍慢，取决于对话模型。</small></span>
            <input type="checkbox" className="companion-switch" aria-label="沉浸式表演" aria-describedby="companion-acting-hint" checked={immersive} onChange={event => {
              const on = event.target.checked; setImmersive(on); trackEvent('开关同行沉浸式表演', { 状态: on ? '开' : '关' });
            }}/>
          </label>
          {char && <RolePlacementSettings key={char.id} control={placement}/>}
          {editAvatar && <button className="companion-link" disabled={!char} onClick={() => { stopAll(); setAvatarSettings(true); }}>管理角色形象</button>}
        </section>
        <section><h3>我的画面</h3><CompanionCameraSource selectRef={cameraSelect} selected={cameraDeviceId} active={camera} activeLabel={cameraLabel} change={deviceId => {
          session.current?.interrupt('切换摄像头'); stopCamera(); setCameraDeviceId(deviceId); setError('');
        }}/></section>
      </>}
      {settings === 'services' && <>
        <section><h3>服务设置</h3>{serviceLinks}<p>打开系统设置会结束本次同行。角色语音支持鱼声 Fish Audio、MiniMax 和 ElevenLabs。</p></section>
        <button className="companion-link" onClick={() => setSetupOpen(true)}>接入说明与连接测试</button>
      </>}
      {settings === 'debug' && <><section><h3>回复方式</h3>
        <label className="companion-option">短接话 a<input type="checkbox" checked={quickEnabled} onChange={event => {
          if (saveQuickReply) saveQuickReply(event.target.checked); else setLocalQuickReply(event.target.checked);
        }}/></label>
        <p>从下一句话生效。关闭后只生成完整回复 a′。上下文{char && resolveContextRangeMode(char) === 'adaptive' ? '跟随自动记忆' : `读取最近 ${clampManualContextLimit(char?.contextLimit)} 条`}。</p>
        {quickEnabled && <label>接话设定<textarea value={style} maxLength={2400} disabled={!!session.current} onChange={event => setStyle(event.target.value)}/></label>}
      </section><section><h3>本轮回复</h3>
        <CompanionReplyProgress store={debug}/><CompanionDebugPanel store={debug}/>
      </section>{(listening || camera || observation) && <section><h3>声音与画面</h3>
        {listening && <p>{micStatus}</p>}<CompanionMicMeter data={micDiagnostics} active={listening}/>
        <CompanionVideoStatus active={camera} analyzing={observing} paused={analysisPaused} configured={companionVideoReady(videoApi)}
          clip={analysisClip} lastSeen={observation?.to} problem={analysisProblem} retry={retryVideo} configure={() => openService('video')}/>
        {observation && <details><summary>最近理解的视频</summary><p>{observationText(observation)}</p>{observation.imageNote && <p>{observation.imageNote}</p>}</details>}
      </section>}</>}
    </CompanionDialog>}
    {foreground && historyOpen && <CompanionHistory lines={lines} charId={charId} charName={char?.name || '角色'} userName={user.name}
      liveSpeaking={Boolean(busyTalking && voiceEnabled && canVoice)} stopListening={() => { if (listening) stopMic(); }} close={() => setHistoryOpen(false)}/>}
    {foreground && avatarSettings && char && <React.Suspense fallback={<div className="companion-settings" role="status">正在打开角色形象…</div>}>
      <AvatarSettings key={char.id} char={char} placement={placement} close={() => setAvatarSettings(false)}/>
    </React.Suspense>}
    {foreground && setupOpen && <CompanionSetupGuide char={char} api={api} backLabel={settings === 'services' ? '返回连接与服务' : '返回同行'} beforeTest={stopAll} imageMode={imageMode} changeImageMode={mode => {
      stopAll(); session.current = undefined; debug.clear(); setImageMode(mode); setStatus('截图方式已更新，可重新开启同行');
    }} canListen={canListenContinuously()} close={() => setSetupOpen(false)} navigate={target => {
      if (navigateSetup) openService(target);
      else { setSetupOpen(false); setError('此模拟页只预览通话。请在主应用打开系统设置。'); }
    }}/>}
  </section>;
}

export default function CompanionApp(props: Pick<CompanionSurfaceProps, 'foreground' | 'onRetentionChange'>) {
  const { characters, groups, userProfile, apiConfig, updateApiConfig, updateCharacter, memoryPalaceConfig, realtimeConfig, closeApp, openApp } = useOS();
  const charactersRef = useRef(characters); charactersRef.current = characters;
  return <CompanionSurface {...props} editAvatar characters={characters} user={userProfile} api={apiConfig} realtimeConfig={realtimeConfig} close={closeApp}
    navigateSetup={(target, charId) => openCompanionSetupTarget(target, charId, openApp)}
    onArchived={(id, role, phase) => {
      const char = charactersRef.current.find(item => item.id === id);
      if (!char) return;
      markAmsgStateDirty({ char, userProfile, groups, realtimeConfig });
      if (role === 'assistant' && phase === 'full' && char.memoryPalaceEnabled) {
        void runCallMemoryPalacePostFlow({ char, getLiveChar: () => charactersRef.current.find(item => item.id === id),
          memoryPalaceConfig, apiConfig, userName: userProfile.name, updateCharacter }).catch(error => console.error('同行记忆整理失败', error));
      }
    }}
    saveLanguage={(charId, value) => updateCharacter(charId, { callVoiceLang: value })}
    savePlacement={(id, value) => updateCharacter(id, previous => patchCallPlacement(previous, 'companion', value))}
    saveQuickReply={enabled => updateApiConfig({ companionQuickReply: enabled })}
    saveBargeIn={enabled => updateApiConfig({ companionBargeIn: enabled })}/>;
}

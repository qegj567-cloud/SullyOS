import { useCallback, useEffect, useRef, useState } from 'react';
import type { APIConfig, CharacterProfile } from '../types';
import { VoiceTextQueue, streamElevenLabsSequence, streamElevenLabsDialogue, streamElevenLabsSpeech, type DialogueLine, type StreamedVoice, type VoiceStreamOptions } from '../utils/elevenLabsStream';
import { PcmVoicePlayer, type VoiceCue } from '../utils/voiceStream';

export interface StreamingVoiceState {
  id: string;
  status: 'loading' | 'playing' | 'done' | 'error';
  cues: VoiceCue[];
  time: number;
  error?: string;
}

/** One owner per surface: switching utterances cancels both network and already scheduled audio. */
export function useStreamingVoice(owner: string | undefined) {
  const [state, setState] = useState<StreamingVoiceState | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const mutedRef = useRef(false);
  const getContext = useCallback(() => {
    if (contextRef.current && contextRef.current.state !== 'closed') return contextRef.current;
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) throw new Error('当前浏览器不支持流式音频播放');
    return contextRef.current = new Ctor() as AudioContext;
  }, []);
  // Prime the same context from the original gesture, before translation/LLM awaits.
  const prime = useCallback(() => { try { void getContext().resume().catch(() => {}); } catch { /* reported by run */ } }, [getContext]);
  const setMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    if (gainRef.current) gainRef.current.gain.value = muted ? 0 : 1;
  }, []);
  const disconnect = useCallback(() => {
    analyserRef.current?.disconnect(); gainRef.current?.disconnect();
    analyserRef.current = null; gainRef.current = null;
  }, []);
  const sessionRef = useRef<{ abort: AbortController; player: PcmVoicePlayer; timer: ReturnType<typeof setInterval> } | null>(null);
  const stop = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      session.abort.abort(); session.player.stop(); clearInterval(session.timer);
      disconnect();
    }
    setState(null);
  }, [disconnect]);
  useEffect(() => stop, [owner, stop]);
  useEffect(() => () => { void contextRef.current?.close().catch(() => {}); contextRef.current = null; }, []);

  const run = useCallback(async (
    id: string,
    produce: (options: VoiceStreamOptions) => Promise<StreamedVoice>,
  ): Promise<StreamedVoice> => {
    stop();
    const context = getContext();
    const analyser = context.createAnalyser(); analyser.fftSize = 1024;
    const gain = context.createGain(); gain.gain.value = mutedRef.current ? 0 : 1;
    analyser.connect(gain); gain.connect(context.destination);
    analyserRef.current = analyser; gainRef.current = gain;
    const player = new PcmVoicePlayer(context, undefined, analyser);
    const abort = new AbortController();
    let cues: VoiceCue[] = [];
    let audible = false;
    const timer = setInterval(() => {
      if (sessionRef.current?.abort === abort) setState({ id, status: audible ? 'playing' : 'loading', cues, time: player.currentTime });
    }, 80);
    const session = { abort, player, timer };
    sessionRef.current = session;
    setState({ id, status: 'loading', cues, time: 0 });
    try {
      // Called immediately by click handlers, before the first network await, for mobile audio unlock.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => settle(new DOMException('请点播放以允许音频输出', 'NotAllowedError')), 3000);
        const onAbort = () => settle(new DOMException('语音已停止', 'AbortError'));
        const settle = (error?: unknown) => { clearTimeout(timeout); abort.signal.removeEventListener('abort', onAbort); error ? reject(error) : resolve(); };
        abort.signal.addEventListener('abort', onAbort, { once: true });
        void player.resume().then(() => settle(), settle);
      });
      if (abort.signal.aborted) throw new DOMException('语音已停止', 'AbortError');
      const result = await produce({
        signal: abort.signal,
        onAudio: pcm => { player.push(pcm); audible = true; },
        onCues: next => { cues = next; },
      });
      if (abort.signal.aborted) throw new DOMException('语音已停止', 'AbortError');
      await player.finish();
      if (sessionRef.current === session) {
        clearInterval(timer); sessionRef.current = null;
        setState({ id, status: 'done', cues, time: result.duration });
        disconnect();
      }
      return result;
    } catch (error) {
      if (sessionRef.current === session) {
        stop();
        if ((error as Error).name !== 'AbortError') setState({ id, status: 'error', cues, time: player.currentTime, error: (error as Error).message });
      }
      throw error;
    }
  }, [stop, getContext, disconnect]);

  const speak = useCallback((id: string, text: string, character: CharacterProfile, config: APIConfig, options: VoiceStreamOptions = {}) =>
    run(id, callbacks => streamElevenLabsSpeech(text, character, config, { ...options, ...callbacks })), [run]);
  const dialogue = useCallback((id: string, lines: DialogueLine[], config: APIConfig) =>
    run(id, callbacks => streamElevenLabsDialogue(lines, config, callbacks)), [run]);
  const sequence = useCallback((id: string, character: CharacterProfile, config: APIConfig, options: VoiceStreamOptions = {}) => {
    const queue = new VoiceTextQueue();
    const result = run(id, callbacks => streamElevenLabsSequence(queue, character, config, { ...options, ...callbacks }));
    void result.catch(() => {}); // The caller consumes it when its final text arrives.
    return { append: (text: string) => queue.append(text), finish: () => queue.finish(), result };
  }, [run]);
  const replay = useCallback((id: string, recording: StreamedVoice) => run(id, async callbacks => {
    const pcm = new Uint8Array(await recording.blob.slice(44).arrayBuffer());
    if (callbacks.signal?.aborted) throw new DOMException('语音已停止', 'AbortError');
    callbacks.onCues?.(recording.cues);
    for (let i = 0; i < pcm.length; i += 48000) callbacks.onAudio?.(pcm.slice(i, i + 48000));
    return recording;
  }), [run]);
  return { state, speak, dialogue, sequence, replay, stop, prime, setMuted, analyserRef };
}

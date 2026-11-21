/** Browser-only streaming recognizer for the demo. Paid file STT is not relabelled as realtime. */
export interface ListeningDiagnostics {
  device: string;
  contextState: string;
  sampleRate: number;
  rms: number;
  packets: number;
  responses: number;
  quietSeconds: number;
  muted: boolean;
}
export interface ListeningCallbacks {
  speech(): void; partial(text: string): void; final(text: string): void; error(message: string): void;
  speechEnded?(): void;
  state?(message: string): void;
  diagnostics?(data: ListeningDiagnostics): void;
}
export function canListenContinuously() {
  return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export function startCompanionListening(callbacks: ListeningCallbacks) {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) throw new Error('此浏览器不支持连续识别，请使用文字输入');
  let stopped = false;
  let restart: ReturnType<typeof setTimeout> | undefined;
  let finalize: ReturnType<typeof setTimeout> | undefined;
  let pending = '';
  const recognition = new Ctor();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  const flush = () => {
    clearTimeout(finalize);
    const text = pending.trim(); pending = '';
    if (stopped) return;
    callbacks.partial('');
    if (text) callbacks.final(text);
    else callbacks.speechEnded?.();
  };
  // speechstart may be triggered by ambient noise. Interrupt on actual recognized
  // partial text, before finalization, rather than treating all noise as a user turn.
  recognition.onresult = (event: any) => {
    if (stopped) return;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) pending += result[0].transcript;
      else interim += result[0].transcript;
    }
    if ((pending + interim).trim()) callbacks.speech();
    callbacks.partial(pending + interim);
    if (!pending && !interim) callbacks.speechEnded?.();
    clearTimeout(finalize);
    if (pending && !interim) finalize = setTimeout(flush, 650);
  };
  recognition.onerror = (event: any) => {
    if (stopped || event.error === 'no-speech' || event.error === 'aborted') return;
    stopped = true; clearTimeout(restart); clearTimeout(finalize); recognition.abort();
    callbacks.error(event.error === 'not-allowed' ? '麦克风权限未允许' : `连续识别中断（${event.error}），可重新开启或输入文字`);
  };
  recognition.onend = () => {
    if (stopped) return;
    flush();
    restart = setTimeout(() => { if (!stopped) { try { recognition.start(); } catch { stopped = true; callbacks.error('识别未能继续，请重新开启'); } } }, 300);
  };
  recognition.start();
  return () => { stopped = true; clearTimeout(restart); clearTimeout(finalize); recognition.abort(); };
}

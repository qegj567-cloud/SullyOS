import { extractVoiceTag } from '../callVoiceTranslation';
import { extractAvatarPerformance, type AvatarPerformanceDirection } from '../avatarPerformance';
import type { CompanionDebugStore } from './debug';

/** Owns one foreground conversation. No CallApp state, persistence or timers. */
export interface CompanionLine {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  heard: string;
  at: number;
  phase?: 'quick' | 'full';
  voiceFailed?: boolean;
  performance?: AvatarPerformanceDirection;
  translation?: string;
  language?: string;
  audio?: Blob[];
  status: 'ready' | 'speaking' | 'done' | 'interrupted';
}

export interface CompanionPorts<P> {
  language?(): string;
  quick(history: CompanionLine[], signal: AbortSignal, language?: string): Promise<string>;
  prepare(history: CompanionLine[], quick: Promise<string>, signal: AbortSignal, quickEnabled?: boolean): Promise<P>;
  full(payload: P, signal: AbortSignal, quickEnabled?: boolean, language?: string): Promise<string>;
  play(text: string, signal: AbortSignal, heard: (text: string) => void, started: (mode: 'audio' | 'text') => void, voice: { language?: string; emotion?: string; record(blob: Blob): void }): Promise<void>;
  debug?: CompanionDebugStore;
  change(lines: CompanionLine[], state: string): void;
  pendingInput?(text: string): void;
  error(error: unknown): void;
}

export class CompanionSession<P> {
  private controller?: AbortController;
  private serial = 0;
  private lines: CompanionLine[] = [];
  private pending: string[] = [];
  private pendingQuickEnabled = true;
  private recognizing = false;
  constructor(private ports: CompanionPorts<P>, history: readonly CompanionLine[] = []) {
    this.lines = history.map(line => ({ ...line }));
    this.serial = history.reduce((last, line) => Math.max(last, line.id), 0);
  }

  private publish(state: string) { this.ports.change(this.lines.map(line => ({ ...line })), state); }

  private abortReply(reason: string) {
    if (!this.controller || this.controller.signal.aborted) return;
    // Abort listeners report the last audible position synchronously before we snapshot.
    this.controller.abort(new DOMException(`同行已停止：${reason}`, 'AbortError'));
    this.lines.forEach(line => { if (line.status === 'speaking' || line.status === 'ready') line.status = 'interrupted'; });
    this.publish('已停下，听你说');
  }

  /** Leaving or reconfiguring the session discards unsent speech as well as the active turn. */
  interrupt(reason = '手动打断') {
    this.recognizing = false;
    this.takePending();
    this.abortReply(reason);
  }

  speechStarted(allowInterruption: boolean) {
    this.recognizing = true;
    if (allowInterruption) this.abortReply('识别到新的语音输入');
  }

  speechEnded() {
    this.recognizing = false;
    return this.dispatchPending();
  }

  skipReply() {
    this.abortReply('手动打断');
    return this.dispatchPending();
  }

  async send(text: string, quickEnabled = true, mode: 'queue' | 'interrupt' = 'interrupt') {
    const input = text.trim();
    if (!input) return;
    if (mode === 'interrupt') {
      this.recognizing = false;
      this.abortReply('收到新一轮输入');
    }
    this.pending.push(input);
    this.pendingQuickEnabled = quickEnabled;
    if (this.waitingForTurn) {
      this.ports.pendingInput?.(this.pending.join('\n'));
      return;
    }
    return this.dispatchPending();
  }

  private takePending() {
    const text = this.pending.join('\n');
    if (this.pending.length) {
      this.pending = [];
      this.ports.pendingInput?.('');
    }
    return text;
  }

  private get waitingForTurn() {
    return this.recognizing || Boolean(this.controller && !this.controller.signal.aborted);
  }

  private dispatchPending() {
    if (this.waitingForTurn || !this.pending.length) return;
    return this.runTurn(this.takePending(), this.pendingQuickEnabled);
  }

  private async runTurn(text: string, quickEnabled: boolean): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const language = this.ports.language?.();
    const trace = this.ports.debug?.start(signal, text.trim(), quickEnabled);
    this.lines.push({ id: ++this.serial, role: 'user', text: text.trim(), heard: text.trim(), at: Date.now(), status: 'done' });
    // Unheard drafts never become history in a new turn.
    const history = this.lines.filter(line => line.heard.trim()).map(({ audio, performance, translation, ...line }) => ({ ...line, text: line.heard }));
    this.publish(quickEnabled ? '正在接话' : '正在准备完整回复');
    let playing: Promise<void> | undefined;
    let quickFinished = false, fullReady = false, hadFailure = false;
    try {
      const quick = quickEnabled ? this.ports.quick(history, signal, language).catch(error => {
        signal.throwIfAborted();
        hadFailure = true;
        this.ports.error(new Error(`接话生成失败：${error instanceof Error ? error.message : '请求失败'}，会继续准备完整回复。`));
        // No invented assistant message; recall still completes for this input.
        return '';
      }) : Promise.resolve('');
      // A rejected preparation may finish before quick speech: attach its handler now.
      const spokenQuick = quick.then(raw => { const { display, voiceText } = extractVoiceTag(extractAvatarPerformance(raw).text); return display || voiceText; });
      void spokenQuick.catch(() => {});
      const prepared = this.ports.prepare(history, spokenQuick, signal, quickEnabled);
      void prepared.catch(() => {});
      if (quickEnabled) {
        const a = await quick;
        signal.throwIfAborted();
        playing = this.deliver(a, 'quick', signal, language).then(failed => {
          hadFailure ||= failed;
          quickFinished = true;
          if (!fullReady) trace?.begin('wait_full');
        });
        void playing.catch(() => {});
      }
      // Generation starts as soon as recall + a are ready, regardless of audio duration.
      const continuation = prepared.then(payload => {
        signal.throwIfAborted();
        this.publish(quickEnabled ? '接话中 · 正在继续想' : '正在生成完整回复');
        return this.ports.full(payload, signal, quickEnabled, language);
      }).then(result => {
        signal.throwIfAborted(); fullReady = true; trace?.end('wait_full');
        if (quickEnabled && !quickFinished) trace?.begin('wait_audio');
        return result;
      });
      void continuation.catch(() => {});
      if (playing) {
        await playing;
        signal.throwIfAborted();
        this.publish('正在继续想');
      }
      const full = await continuation;
      signal.throwIfAborted();
      trace?.end('wait_full'); trace?.end('wait_audio');
      hadFailure = (await this.deliver(full, 'full', signal, language)) || hadFailure;
      signal.throwIfAborted();
      this.publish('在你身边');
      trace?.finish(hadFailure ? 'error' : 'done');
    } catch (error) {
      if (!signal.aborted) {
        trace?.finish('error');
        this.abortReply('本轮续答失败');
        this.ports.error(new Error(`回复失败：${error instanceof Error ? error.message : '请求失败'}`));
      }
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
        void this.dispatchPending();
      }
    }
  }

  private async deliver(raw: string, phase: 'quick' | 'full', signal: AbortSignal, language?: string) {
    const { text: clean, direction } = extractAvatarPerformance(raw);
    const { display, voiceText, emotion } = extractVoiceTag(clean);
    const text = display || voiceText;
    const translation = language && voiceText ? voiceText : undefined;
    if (!text.trim()) return false;
    signal.throwIfAborted();
    const line: CompanionLine = { id: ++this.serial, role: 'assistant', text, heard: '', at: Date.now(), phase, performance: direction, translation, language, status: 'speaking' };
    this.lines.push(line);
    this.publish(phase === 'quick' ? '正在接话' : '正在和你说');
    const trace = this.ports.debug?.get(signal);
    trace?.begin(`${phase}_tts`);
    try {
      await this.ports.play(translation || text, signal, heard => {
        line.heard = heard;
        if (!signal.aborted) this.publish(phase === 'quick' ? '接话中 · 同时准备后续' : '正在和你说');
      }, mode => trace?.deliveryStart(phase, mode), {
        language: translation ? language : undefined, emotion,
        record: blob => { if (blob.size) line.audio = [...(line.audio || []), blob]; },
      });
    } catch (error) {
      signal.throwIfAborted();
      // The full text is already visible in the caption/history. Record it as
      // displayed, explicitly mark voice failure, and keep the other LLM work alive.
      line.voiceFailed = true; line.heard = text; line.status = 'done';
      trace?.deliveryFailed(phase);
      this.publish('语音失败，正文已展示');
      this.ports.error(new Error(`${phase === 'quick' ? '接话' : '回复'}语音失败：${error instanceof Error ? error.message : '播放失败'}。正文已保留${phase === 'quick' ? '，会继续准备完整回复' : ''}。`));
      return true;
    }
    signal.throwIfAborted();
    line.heard = text;
    line.status = 'done';
    trace?.deliveryEnd(phase);
    this.publish(phase === 'quick' ? 'a 已结束 · 继续准备 a′' : '在你身边');
    return false;
  }
}

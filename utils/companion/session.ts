import { extractVoiceTag } from '../callVoiceTranslation';
import { extractAvatarPerformance, type AvatarPerformanceDirection } from '../avatarPerformance';
import type { CompanionDebugStore } from './debug';

export type IdleConversationSeconds = 0 | 30 | 60;

/** Session transcript, delivery order and optional idle conversation timer. */
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
  saveLine?(line: CompanionLine): Promise<number>;
  language?(): string;
  quick(history: CompanionLine[], signal: AbortSignal, language?: string): Promise<string>;
  prepare(history: CompanionLine[], quick: Promise<string>, signal: AbortSignal, quickEnabled?: boolean): Promise<P>;
  full(payload: P, signal: AbortSignal, quickEnabled?: boolean, language?: string, proactive?: boolean): Promise<string>;
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
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleSeconds: IdleConversationSeconds = 0;
  private afterFullReply = false;
  private activeProactive?: AbortController;
  private archiveQueue = new Map<number, CompanionLine>();
  private writing?: Promise<void>;
  private preparing?: AbortSignal;
  private heldQuick?: CompanionLine;

  private archive(line: CompanionLine) {
    if (!this.ports.saveLine || !line.heard.trim()) return;
    this.archiveQueue.set(line.id, { ...line, text: line.heard, audio: undefined });
  }

  flushHistory(): Promise<void> {
    if (this.writing) return this.writing.then(() => this.flushHistory());
    if (!this.archiveQueue.size) return Promise.resolve();
    const write = async () => {
      for (const [id, line] of this.archiveQueue) {
        await this.ports.saveLine!(line);
        this.archiveQueue.delete(id);
      }
    };
    this.writing = write().finally(() => { this.writing = undefined; });
    return this.writing;
  }

  private flushInBackground() {
    void this.flushHistory().catch(() => this.ports.error(new Error('同行对话暂未保存到消息，下一次发送或结束同行时会重试。')));
  }

  private finishPreparation(signal: AbortSignal) {
    if (this.preparing !== signal) return;
    this.preparing = undefined;
    if (this.heldQuick) {
      this.archive(this.heldQuick); this.heldQuick = undefined;
      this.flushInBackground();
    }
  }
  setIdleConversation(seconds: IdleConversationSeconds) {
    if (seconds === this.idleSeconds) return;
    this.idleSeconds = seconds;
    this.resetIdleTimer();
  }

  private resetIdleTimer() {
    clearTimeout(this.idleTimer);
    if (!this.idleSeconds || !this.afterFullReply || this.waitingForTurn || this.pending.length) return;
    this.idleTimer = setTimeout(() => {
      if (!this.waitingForTurn && !this.pending.length) void this.runTurn(undefined, false);
    }, this.idleSeconds * 1000);
  }

  stopIdleConversation() {
    this.setIdleConversation(0);
    if (this.activeProactive === this.controller && this.controller) {
      this.abortReply('关闭主动开口'); void this.dispatchPending();
    }
  }
  constructor(private ports: CompanionPorts<P>, history: readonly CompanionLine[] = []) {
    this.lines = history.map(line => ({ ...line }));
    const last = history.at(-1);
    this.afterFullReply = last?.phase === 'full' && last.status === 'done' && !last.voiceFailed && !!last.heard.trim();
    this.serial = history.reduce((last, line) => Math.max(last, line.id), 0);
  }

  private publish(state: string) { this.ports.change(this.lines.map(line => ({ ...line })), state); }

  private abortReply(reason: string) {
    if (!this.controller || this.controller.signal.aborted) return;
    // Abort listeners report the last audible position synchronously before we snapshot.
    this.controller.abort(new DOMException(`同行已停止：${reason}`, 'AbortError'));
    this.finishPreparation(this.controller.signal);
    this.lines.forEach(line => {
      if (line.status === 'speaking' || line.status === 'ready') {
        line.status = 'interrupted';
        this.archive(line);
      }
    });
    this.flushInBackground();
    this.publish('已停下，听你说');
  }

  /** Leaving or reconfiguring the session discards unsent speech as well as the active turn. */
  interrupt(reason = '手动打断') {
    this.setIdleConversation(0);
    this.recognizing = false;
    this.takePending();
    this.abortReply(reason);
  }

  speechStarted(allowInterruption: boolean) {
    this.recognizing = true;
    clearTimeout(this.idleTimer);
    if (allowInterruption) this.abortReply('识别到新的语音输入');
  }

  speechEnded() {
    const hadSpeech = this.recognizing;
    this.recognizing = false;
    // Silent recognition packets can repeatedly report an empty utterance.
    if (hadSpeech) this.resetIdleTimer();
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

  private async runTurn(text: string | undefined, quickEnabled: boolean): Promise<void> {
    clearTimeout(this.idleTimer);
    this.afterFullReply = false;
    const controller = new AbortController();
    this.controller = controller;
    this.activeProactive = text === undefined ? controller : undefined;
    const { signal } = controller;
    const language = this.ports.language?.();
    const trace = this.ports.debug?.start(signal, text ?? '角色主动开口', quickEnabled);
    if (text !== undefined) {
      const line: CompanionLine = { id: ++this.serial, role: 'user', text, heard: text, at: Date.now(), status: 'done' };
      this.lines.push(line); this.archive(line);
    }
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
      this.preparing = signal;
      const prepared = this.flushHistory().then(() => {
        signal.throwIfAborted();
        return this.ports.prepare(history, spokenQuick, signal, quickEnabled);
      }).finally(() => this.finishPreparation(signal));
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
        return this.ports.full(payload, signal, quickEnabled, language, text === undefined);
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
        this.activeProactive = undefined;
        void this.dispatchPending();
        this.resetIdleTimer();
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
      this.archiveDelivered(line, signal);
      trace?.deliveryFailed(phase);
      this.publish('语音失败，正文已展示');
      this.ports.error(new Error(`${phase === 'quick' ? '接话' : '回复'}语音失败：${error instanceof Error ? error.message : '播放失败'}。正文已保留${phase === 'quick' ? '，会继续准备完整回复' : ''}。`));
      return true;
    }
    signal.throwIfAborted();
    line.heard = text;
    line.status = 'done';
    if (phase === 'full') this.afterFullReply = true;
    this.archiveDelivered(line, signal);
    trace?.deliveryEnd(phase);
    this.publish(phase === 'quick' ? 'a 已结束 · 继续准备 a′' : '在你身边');
    return false;
  }

  private archiveDelivered(line: CompanionLine, signal: AbortSignal) {
    // This turn already injects a into a′. Until its context snapshot is built,
    // keep a out of the shared history so it cannot occupy a second slot.
    if (line.phase === 'quick' && this.preparing === signal) this.heldQuick = line;
    else { this.archive(line); this.flushInBackground(); }
  }
}

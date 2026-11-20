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
  status: 'ready' | 'speaking' | 'done' | 'interrupted';
}

export interface CompanionPorts<P> {
  quick(history: CompanionLine[], signal: AbortSignal): Promise<string>;
  prepare(history: CompanionLine[], quick: Promise<string>, signal: AbortSignal): Promise<P>;
  full(payload: P, signal: AbortSignal): Promise<string>;
  play(text: string, signal: AbortSignal, heard: (text: string) => void, started: (mode: 'audio' | 'text') => void): Promise<void>;
  debug?: CompanionDebugStore;
  change(lines: CompanionLine[], state: string): void;
  error(error: unknown): void;
}

export class CompanionSession<P> {
  private controller?: AbortController;
  private serial = 0;
  private lines: CompanionLine[] = [];
  constructor(private ports: CompanionPorts<P>) {}

  private publish(state: string) { this.ports.change(this.lines.map(line => ({ ...line })), state); }

  interrupt(reason = '手动打断') {
    // Abort listeners report the last audible position synchronously before we snapshot.
    this.controller?.abort(new DOMException(`同行已停止：${reason}`, 'AbortError'));
    this.controller = undefined;
    this.lines.forEach(line => { if (line.status === 'speaking' || line.status === 'ready') line.status = 'interrupted'; });
    this.publish('已停下，听你说');
  }

  async send(text: string) {
    if (!text.trim()) return;
    this.interrupt('收到新一轮输入');
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const trace = this.ports.debug?.start(signal, text.trim());
    this.lines.push({ id: ++this.serial, role: 'user', text: text.trim(), heard: text.trim(), at: Date.now(), status: 'done' });
    // Unheard drafts never become history in a new turn.
    const history = this.lines.filter(line => line.heard.trim()).map(line => ({ ...line, text: line.heard }));
    this.publish('正在接话');
    let playing: Promise<void> | undefined;
    let quickFinished = false, fullReady = false, hadFailure = false;
    try {
      const quick = this.ports.quick(history, signal).catch(error => {
        signal.throwIfAborted();
        hadFailure = true;
        this.ports.error(new Error(`a · 接话生成失败：${error instanceof Error ? error.message : '请求失败'}；继续准备 a′。`));
        // No invented assistant message; recall still completes for this input.
        return '';
      });
      // A rejected preparation may finish before quick speech: attach its handler now.
      const prepared = this.ports.prepare(history, quick, signal);
      void prepared.catch(() => {});
      const a = await quick;
      signal.throwIfAborted();
      playing = this.deliver(a, 'quick', signal).then(failed => {
        hadFailure ||= failed;
        quickFinished = true;
        if (!fullReady) trace?.begin('wait_full');
      });
      void playing.catch(() => {});
      // Generation starts as soon as recall + a are ready, regardless of audio duration.
      const continuation = prepared.then(payload => {
        signal.throwIfAborted();
        this.publish('接话中 · 正在继续想');
        return this.ports.full(payload, signal);
      }).then(result => {
        signal.throwIfAborted(); fullReady = true; trace?.end('wait_full');
        if (!quickFinished) trace?.begin('wait_audio');
        return result;
      });
      void continuation.catch(() => {});
      await playing;
      signal.throwIfAborted();
      this.publish('正在继续想');
      const full = await continuation;
      signal.throwIfAborted();
      trace?.end('wait_full'); trace?.end('wait_audio');
      hadFailure = (await this.deliver(full, 'full', signal)) || hadFailure;
      signal.throwIfAborted();
      this.publish('在你身边');
      trace?.finish(hadFailure ? 'error' : 'done');
    } catch (error) {
      if (!signal.aborted) {
        trace?.finish('error');
        this.interrupt('本轮续答失败');
        this.ports.error(new Error(`a′ · 完整回复失败：${error instanceof Error ? error.message : '请求失败'}`));
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async deliver(text: string, phase: 'quick' | 'full', signal: AbortSignal) {
    if (!text.trim()) return false;
    signal.throwIfAborted();
    const line: CompanionLine = { id: ++this.serial, role: 'assistant', text, heard: '', at: Date.now(), phase, status: 'speaking' };
    this.lines.push(line);
    this.publish(phase === 'quick' ? '正在接话' : '正在和你说');
    const trace = this.ports.debug?.get(signal);
    trace?.begin(`${phase}_tts`);
    try {
      await this.ports.play(text, signal, heard => {
        line.heard = heard;
        if (!signal.aborted) this.publish(phase === 'quick' ? '接话中 · 同时准备后续' : '正在和你说');
      }, mode => trace?.deliveryStart(phase, mode));
    } catch (error) {
      signal.throwIfAborted();
      // The full text is already visible in the caption/history. Record it as
      // displayed, explicitly mark voice failure, and keep the other LLM work alive.
      line.voiceFailed = true; line.heard = text; line.status = 'done';
      trace?.deliveryFailed(phase);
      this.publish('语音失败，正文已展示');
      this.ports.error(new Error(`${phase === 'quick' ? 'a · 接话' : 'a′ · 完整回复'}语音失败：${error instanceof Error ? error.message : '播放失败'}。正文已保留${phase === 'quick' ? '，a′ 继续生成' : ''}。`));
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

export type CompanionPhase = 'quick' | 'full';
export const COMPANION_STAGES = {
  quick_request: '短回复 a · 模型请求',
  full_prepare: '完整上下文准备（含下方子阶段）',
  history: '收件箱、历史与素材读取',
  vision: '历史图片处理',
  memory: '记忆召回',
  wait_a: '召回后等待 a 全文',
  prompt: '人设与提示词组装',
  collaboration: '协同上下文',
  tasks: '任务上下文',
  full_request: '长回复 a′ · 模型请求',
  quick_tts: 'a · 准备语音至首次出声',
  quick_audio: 'a · 播放（含分段间隙）',
  wait_full: 'a 结束后等待 a′ 文本',
  wait_audio: 'a′ 文本就绪后等待 a 结束',
  full_tts: 'a′ · 准备语音至首次出声',
  full_audio: 'a′ · 播放（含分段间隙）',
} as const;
export type CompanionStage = keyof typeof COMPANION_STAGES;
type Status = 'running' | 'done' | 'cancelled' | 'error' | 'skipped';
export interface CompanionSpan { start: number; end?: number; status: Status; note?: string }
export interface CompanionDebugRequest {
  /** The exact serialized body handed to safeFetchJson, without URL or headers. */
  body: string; submitted: number; firstDelta?: number; response?: string;
  headers?: { at: number; status: number; streaming: boolean };
}
export interface CompanionDebugTurn {
  id: number; input: string; origin: number; end?: number; status: Status;
  stages: Partial<Record<CompanionStage, CompanionSpan>>;
  requests: Partial<Record<CompanionPhase, CompanionDebugRequest>>;
  delivery: Partial<Record<CompanionPhase, { mode?: 'audio' | 'text'; end?: number; failed?: boolean }>>;
}

/** Page-local, bounded instrumentation. It never writes storage, logs or credentials. */
export class CompanionDebugStore {
  private turns: CompanionDebugTurn[] = [];
  private listeners = new Set<() => void>();
  private bySignal = new WeakMap<AbortSignal, CompanionTurnTrace>();
  private serial = 0;
  constructor(readonly now = () => performance.now()) {}
  getSnapshot = () => this.turns;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish = () => { for (const listener of this.listeners) listener(); };
  clear() { this.turns = []; this.publish(); }
  get(signal: AbortSignal) { return this.bySignal.get(signal); }
  start(signal: AbortSignal, input: string) {
    const turn: CompanionDebugTurn = { id: ++this.serial, input, origin: this.now(), status: 'running', stages: {}, requests: {}, delivery: {} };
    this.turns = [...this.turns.slice(-4), turn];
    const trace = new CompanionTurnTrace(turn, signal, this.now, next => {
      if (!this.turns.some(item => item.id === next.id)) return;
      this.turns = this.turns.map(item => item.id === next.id ? next : item);
      this.publish();
    });
    this.bySignal.set(signal, trace);
    this.publish();
    if (signal.aborted) trace.finish('cancelled');
    return trace;
  }
}

export class CompanionTurnTrace {
  private abort = () => this.finish('cancelled');
  constructor(private turn: CompanionDebugTurn, private signal: AbortSignal, private now: () => number,
    private publish: (turn: CompanionDebugTurn) => void) { signal.addEventListener('abort', this.abort, { once: true }); }
  private elapsed() { return Math.max(0, this.now() - this.turn.origin); }
  private update(edit: (turn: CompanionDebugTurn) => void) {
    if (this.turn.status !== 'running') return;
    const next = { ...this.turn, stages: { ...this.turn.stages }, requests: { ...this.turn.requests }, delivery: { ...this.turn.delivery } };
    edit(next); this.turn = next; this.publish(next);
  }
  begin(stage: CompanionStage) {
    this.update(turn => { if (!turn.stages[stage]) turn.stages[stage] = { start: this.elapsed(), status: 'running' }; });
  }
  end(stage: CompanionStage, status: Status = 'done', note?: string) {
    this.update(turn => {
      const span = turn.stages[stage];
      if (span && span.end === undefined) turn.stages[stage] = { ...span, end: this.elapsed(), status, note };
    });
  }
  annotate(stage: CompanionStage, note: string, status?: Status) {
    this.update(turn => { const span = turn.stages[stage]; if (span) turn.stages[stage] = { ...span, note, ...(status ? { status } : {}) }; });
  }
  request(phase: CompanionPhase, body: string) {
    this.update(turn => { turn.requests[phase] = { body, submitted: this.elapsed() }; });
  }
  firstDelta(phase: CompanionPhase) {
    this.update(turn => { const request = turn.requests[phase]; if (request && request.firstDelta === undefined) turn.requests[phase] = { ...request, firstDelta: this.elapsed() }; });
  }
  responseHeaders(phase: CompanionPhase, info: { status: number; streaming: boolean }) {
    this.update(turn => { const request = turn.requests[phase]; if (request) turn.requests[phase] = { ...request,
      headers: { ...info, at: this.elapsed() } }; });
  }
  response(phase: CompanionPhase, response: string) {
    this.update(turn => { const request = turn.requests[phase]; if (request) turn.requests[phase] = { ...request, response }; });
  }
  deliveryStart(phase: CompanionPhase, mode: 'audio' | 'text') {
    this.end(`${phase}_tts`, mode === 'text' ? 'skipped' : 'done', mode === 'text' ? '文字展示，没有播放语音' : undefined);
    this.update(turn => { turn.delivery[phase] = { mode }; });
    if (mode === 'audio') this.begin(`${phase}_audio`);
  }
  deliveryEnd(phase: CompanionPhase) {
    this.end(`${phase}_audio`);
    this.end(`${phase}_tts`, 'skipped', '未收到出声事件');
    this.update(turn => { turn.delivery[phase] = { ...turn.delivery[phase], end: this.elapsed() }; });
  }
  deliveryFailed(phase: CompanionPhase) {
    this.end(`${phase}_tts`, 'error', '语音失败，正文仍展示');
    this.end(`${phase}_audio`, 'error', '播放失败，正文仍展示');
    this.update(turn => { turn.delivery[phase] = { ...turn.delivery[phase], end: this.elapsed(), failed: true }; });
  }
  finish(status: 'done' | 'cancelled' | 'error') {
    this.signal.removeEventListener('abort', this.abort);
    this.update(turn => {
      turn.status = status; turn.end = this.elapsed();
      for (const key of Object.keys(turn.stages) as CompanionStage[]) {
        const span = turn.stages[key]!;
        if (span.end === undefined) turn.stages[key] = { ...span, end: turn.end, status };
      }
    });
  }
}

export function overlapMs(a: CompanionSpan | undefined, b: CompanionSpan | undefined, elapsed: number) {
  if (!a || !b) return undefined;
  return Math.max(0, Math.min(a.end ?? elapsed, b.end ?? elapsed) - Math.max(a.start, b.start));
}

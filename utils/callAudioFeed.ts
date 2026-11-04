/**
 * 通话口型信号源：把 <audio> 元素接到 WebAudio 分析器上，按渲染帧输出
 * { level, vowel }。舞台画布（VRM / Live2D）在自己的 rAF 循环里直接
 * sample()，不经过 React state——旧实现走 80ms 节流 + setState + prop
 * 层层下传，嘴型比声音慢一拍还忽真忽假。
 *
 * level：0..1 的开口度。对说话人音量做自适应归一（跟踪运行峰值），
 *        小声说话也有完整口型，不会因为绝对音量低而抿嘴。
 * vowel：0..1 的元音倾向（低频占优 ≈ あ/お → 0，高频占优 ≈ い/え → 1），
 *        由频谱能量带比值估计，用来在 Aa/Ee/Oh viseme 之间过渡。
 * active：false 表示拿不到实时信号（未播放 / CORS 音频接不进 WebAudio），
 *        画布应退回节奏型假口型，而不是把 level=0 当成闭嘴。
 */

export interface LipSyncFrame {
  level: number;
  vowel: number;
  active: boolean;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * iOS 上把 HTMLMediaElement 接入 WebAudio 后，AudioContext 一旦被系统挂起，
 * 原生音频输出也会一起被截断。这里宁可退回节奏型口型，也不让分析器成为声音的必经节点。
 * iPadOS 桌面 UA 会伪装成 Mac，需要同时检查触点数量。
 */
export const shouldKeepNativeCallAudio = (runtimeNavigator?: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean => {
  const nav = runtimeNavigator || (typeof navigator !== 'undefined' ? navigator : undefined);
  if (!nav) return false;
  return /iPad|iPhone|iPod/i.test(nav.userAgent)
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
};

/**
 * 自适应开口度：rms 相对运行峰值归一。峰值缓慢回落（每次采样 ×0.996），
 * 换了音量更小的语音片段后 1–2 秒内恢复满幅口型。
 */
export const adaptiveMouthLevel = (rms: number, peak: number): { level: number; peak: number } => {
  const nextPeak = Math.max(0.05, peak * 0.996, rms);
  const raw = rms / (nextPeak * 0.85);
  // 低于 6% 视为呼吸/底噪，直接闭嘴，避免静音段嘴唇抖动。
  return { level: raw < 0.06 ? 0 : clamp01(raw), peak: nextPeak };
};

/** 元音倾向：mid 带（~1k-3.6kHz）能量占比。两带都近乎无声时回中位 0.5。 */
export const vowelFromBands = (lowEnergy: number, midEnergy: number): number => {
  const total = lowEnergy + midEnergy;
  if (total < 1e-3) return 0.5;
  return clamp01(midEnergy / total);
};

export class CallAudioFeed {
  frame: LipSyncFrame = { level: 0, vowel: 0.5, active: false };

  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private streamAnalyser: AnalyserNode | null = null;
  private streamTimeData: Uint8Array<ArrayBuffer> | null = null;
  private streamFreqData: Uint8Array<ArrayBuffer> | null = null;
  private attachedElement: HTMLAudioElement | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private peak = 0.12;
  private playing = false;
  private broken = false;
  private lastSampleAt = 0;
  private smoothedLevel = 0;
  private smoothedVowel = 0.5;

  private ensureContext(): AudioContext | null {
    if (this.broken) return null;
    if (this.context && this.context.state !== 'closed') return this.context;
    if (typeof window === 'undefined') return null;
    const AudioContextCtor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      this.broken = true;
      return null;
    }
    try {
      this.context = new AudioContextCtor();
      return this.context;
    } catch {
      this.broken = true;
      return null;
    }
  }

  /**
   * 必须从“接通 / 重播 / 继续播放”等真实点击处理器里直接调用。
   * 返回 false 时调用方应保留 HTMLAudioElement 原生输出，不要 attach。
   */
  async unlock(): Promise<boolean> {
    const context = this.ensureContext();
    if (!context) return false;
    if (context.state === 'running') return true;
    try {
      await context.resume();
      // Safari may mutate state to its non-standard `interrupted` value between
      // tasks; stringify to force a fresh runtime read after the awaited resume.
      return String(context.state) === 'running';
    } catch {
      return false;
    }
  }

  /** 把播放元素接入分析图。同一元素只会创建一次；未解锁时绝不接管原生声音。 */
  attach(element: HTMLAudioElement): boolean {
    if (this.broken) return false;
    if (this.attachedElement === element) return !!this.analyser;
    const context = this.ensureContext();
    if (!context || context.state !== 'running') return false;
    try {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      const source = context.createMediaElementSource(element);
      source.connect(analyser);
      analyser.connect(context.destination);
      this.context = context;
      this.analyser = analyser;
      this.attachedElement = element;
      this.timeData = new Uint8Array(analyser.fftSize);
      this.freqData = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch {
      // 某些跨域音频不允许接入 WebAudio；标记后 sample() 恒 active=false，
      // 画布退回节奏型口型。
      this.broken = true;
      return false;
    }
  }

  /** Borrow the PCM player's analyser; its context/output remain owned by the player. */
  useStreamAnalyser(analyser: AnalyserNode | null): void {
    if (this.streamAnalyser === analyser) return;
    this.streamAnalyser = analyser;
    this.streamTimeData = analyser ? new Uint8Array(analyser.fftSize) : null;
    this.streamFreqData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    this.lastSampleAt = 0;
  }

  setActive(playing: boolean): void {
    this.playing = playing;
    if (!playing) {
      this.smoothedLevel = 0;
      this.frame = { level: 0, vowel: this.smoothedVowel, active: false };
    }
  }

  /** 每帧调用。多块画布同帧重复调用时命中 8ms 缓存，不会双重平滑。 */
  sample(now: number): LipSyncFrame {
    if (!this.playing) return this.frame;
    const analyser = this.streamAnalyser || this.analyser;
    const timeData = this.streamAnalyser ? this.streamTimeData : this.timeData;
    const freqData = this.streamAnalyser ? this.streamFreqData : this.freqData;
    const context = this.streamAnalyser?.context || this.context;
    if (!analyser || !timeData || !freqData || !context) {
      this.frame = { level: 0, vowel: 0.5, active: false };
      return this.frame;
    }
    if (now - this.lastSampleAt < 8) return this.frame;
    this.lastSampleAt = now;

    analyser.getByteTimeDomainData(timeData);
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const v = (timeData[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    const adapted = adaptiveMouthLevel(rms, this.peak);
    this.peak = adapted.peak;
    // 快起慢落：辅音爆破立即张嘴，词尾自然合拢。
    const rate = adapted.level > this.smoothedLevel ? 0.55 : 0.22;
    this.smoothedLevel += (adapted.level - this.smoothedLevel) * rate;

    analyser.getByteFrequencyData(freqData);
    const hzPerBin = context.sampleRate / 2 / freqData.length;
    const bandEnergy = (fromHz: number, toHz: number): number => {
      const from = Math.max(0, Math.floor(fromHz / hzPerBin));
      const to = Math.min(freqData.length - 1, Math.ceil(toHz / hzPerBin));
      let sum = 0;
      for (let i = from; i <= to; i += 1) sum += freqData[i];
      return sum / Math.max(1, to - from + 1) / 255;
    };
    const vowel = vowelFromBands(bandEnergy(120, 900), bandEnergy(1000, 3600));
    this.smoothedVowel += (vowel - this.smoothedVowel) * 0.25;

    this.frame = { level: clamp01(this.smoothedLevel), vowel: clamp01(this.smoothedVowel), active: true };
    return this.frame;
  }

  dispose(): void {
    this.useStreamAnalyser(null);
    this.playing = false;
    this.analyser = null;
    this.attachedElement = null;
    this.timeData = null;
    this.freqData = null;
    const context = this.context;
    this.context = null;
    if (context) void context.close().catch(() => { /* already closed */ });
  }
}

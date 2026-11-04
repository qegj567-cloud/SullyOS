import { describe, expect, it } from 'vitest';
import { CallAudioFeed, adaptiveMouthLevel, shouldKeepNativeCallAudio, vowelFromBands } from './callAudioFeed';

describe('adaptiveMouthLevel', () => {
  it('小音量语音也能张到接近满口型（相对峰值归一）', () => {
    let peak = 0.05;
    // 连续多帧 0.04 的小声说话：峰值收敛到 ~0.05，口型应接近全开
    let level = 0;
    for (let i = 0; i < 60; i += 1) {
      const out = adaptiveMouthLevel(0.045, peak);
      peak = out.peak;
      level = out.level;
    }
    expect(level).toBeGreaterThan(0.85);
  });

  it('静音/底噪帧直接闭嘴，不残留抖动', () => {
    const out = adaptiveMouthLevel(0.002, 0.3);
    expect(out.level).toBe(0);
  });

  it('峰值跟随更响的输入立即抬升，避免爆音顶满', () => {
    const out = adaptiveMouthLevel(0.6, 0.1);
    expect(out.peak).toBe(0.6);
    expect(out.level).toBeLessThanOrEqual(1);
  });

  it('峰值缓慢回落，切到小声片段后能恢复动态范围', () => {
    let peak = 0.8;
    for (let i = 0; i < 400; i += 1) peak = adaptiveMouthLevel(0.01, peak).peak;
    expect(peak).toBeLessThan(0.25);
  });
});

describe('vowelFromBands', () => {
  it('低频占优（あ/お类元音）趋近 0', () => {
    expect(vowelFromBands(0.8, 0.1)).toBeLessThan(0.2);
  });
  it('高频占优（い/え类元音）趋近 1', () => {
    expect(vowelFromBands(0.1, 0.7)).toBeGreaterThan(0.8);
  });
  it('近乎无声时回中位，不产生 NaN', () => {
    expect(vowelFromBands(0, 0)).toBe(0.5);
  });
});

describe('iOS call audio routing', () => {
  it('keeps iPhone and iPad audio on the native media element path', () => {
    expect(shouldKeepNativeCallAudio({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    })).toBe(true);
    expect(shouldKeepNativeCallAudio({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    })).toBe(true);
  });

  it('allows desktop browsers to use the analyser graph', () => {
    expect(shouldKeepNativeCallAudio({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      platform: 'Win32',
      maxTouchPoints: 0,
    })).toBe(false);
  });
});


describe('streaming PCM lip sync', () => {
  it('samples the external analyser without creating another context or taking ownership of it', () => {
    const feed = new CallAudioFeed();
    const analyser = {
      fftSize: 1024, frequencyBinCount: 512, context: { sampleRate: 24000 },
      getByteTimeDomainData: (data: Uint8Array) => data.fill(150),
      getByteFrequencyData: (data: Uint8Array) => data.fill(40),
    } as unknown as AnalyserNode;
    feed.useStreamAnalyser(analyser);
    feed.setActive(true);
    expect(feed.sample(100).active).toBe(true);
    expect(feed.sample(100).level).toBeGreaterThan(0);
    feed.useStreamAnalyser(null);
    expect(feed.sample(200).active).toBe(false);
    feed.dispose();
  });
});

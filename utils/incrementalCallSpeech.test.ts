import { describe, expect, it } from 'vitest';
import { IncrementalCallSpeech } from './incrementalCallSpeech';

describe('incremental call speech', () => {
  it('waits for translated voice content and never reads the Chinese subtitle twice', () => {
    const result: string[] = [];
    const stream = new IncrementalCallSpeech(text => result.push(text), true);
    stream.update('你好呀。\n<语');
    expect(result).toEqual([]);
    stream.update('你好呀。\n<语音 emotion="happy">Hello! How');
    expect(result).toEqual(['Hello!']);
    stream.finish('你好呀。\n<语音 emotion="happy">Hello! How are you?</语音>');
    expect(result).toEqual(['Hello!', ' How are you?']);
  });
  it('emits complete spoken sentences before final completion, never thoughts or partial directions', () => {
    const result: string[] = [];
    const stream = new IncrementalCallSpeech(text => result.push(text));
    stream.update('<think>先分析一下。');
    stream.update('<think>先分析一下。</think>[[AVATAR: emotion=happy');
    stream.update('<think>先分析一下。</think>[[AVATAR: emotion=happy]] [whispers] 你好。第二');
    expect(result).toEqual(['[whispers] 你好。']);
    stream.update('<think>先分析一下。</think>[[AVATAR: emotion=happy]] [whispers] 你好。第二句！');
    stream.finish('[whispers] 你好。第二句！结尾');
    expect(result).toEqual(['[whispers] 你好。', '第二句！', '结尾']);
  });
  it('does not cut punctuation inside audio tags or pronunciation instructions', () => {
    const result: string[] = [];
    const stream = new IncrementalCallSpeech(text => result.push(text));
    stream.update('[calm. very quiet] Read /hə.ˈləʊ/ please. Next');
    expect(result).toEqual(['[calm. very quiet] Read /hə.ˈləʊ/ please.']);
  });
  it('keeps decimal numbers together and rejects incomplete final directions', () => {
    const spoken: string[] = [];
    const stream = new IncrementalCallSpeech(text => spoken.push(text));
    stream.update('温度是 3.');
    expect(spoken).toEqual([]);
    stream.update('温度是 3.14 度。');
    expect(spoken).toEqual(['温度是 3.14 度。']);
    expect(() => stream.finish('温度是 3.14 度。[whisper')).toThrow('未闭合');
  });
  it('unwraps voice markup without sending it to synthesis', () => {
    const spoken: string[] = [];
    const stream = new IncrementalCallSpeech(text => spoken.push(text));
    stream.update('<语音 emotion="happy">你好。');
    stream.finish('<语音 emotion="happy">你好。</语音>');
    expect(spoken).toEqual(['你好。']);
  });
  it('fails explicitly if the upstream rewrites already emitted speech', () => {
    const stream = new IncrementalCallSpeech(() => {});
    stream.update('第一句话。');
    expect(() => stream.update('改写了。')).toThrow('改写');
  });
});

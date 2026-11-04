import { describe, expect, it } from 'vitest';
import { extractDateDialogueText } from './dateVoiceText';

describe('date dialogue speech script', () => {
  it('keeps v4 directions inside quotes without reading sprite or voice emotion tags', () => {
    const line = '[shy] "[Warm, conversational tone] 你来啦。[soft chuckle]" [v:calm]';
    expect(extractDateDialogueText(line, true)).toBe('[Warm, conversational tone] 你来啦。[soft chuckle]');
    expect(extractDateDialogueText(line)).toBe('你来啦。');
  });

  it('supports Japanese quotes and multiple quoted phrases', () => {
    expect(extractDateDialogueText('[normal] 「[whispers] 你好」', true)).toBe('[whispers] 你好');
    expect(extractDateDialogueText('"你好。" "[long pause] 等等。"', true)).toBe('你好。 [long pause] 等等。');
  });
});

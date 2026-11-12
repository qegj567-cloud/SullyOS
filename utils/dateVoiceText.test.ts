import { describe, expect, it } from 'vitest';
import { extractDateDialogueText, resolveDateSpeechText, stripDateVoiceTranslations, normalizeDateVoiceLines, buildDateReadingScript, dateVoiceCacheKey } from './dateVoiceText';
import type { APIConfig, CharacterProfile } from '../types';

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

  const bilingual = '[happy] "你来啦。" [v:calm] <date-voice lang="en">[whispers] You are here.</date-voice>';
  it('keeps the original on screen and uses only the saved target-language speech', () => {
    expect(stripDateVoiceTranslations(bilingual)).toBe('[happy] "你来啦。" [v:calm]');
    expect(extractDateDialogueText(bilingual)).toBe('你来啦。');
    expect(resolveDateSpeechText(bilingual, 'en', true)).toBe('[whispers] You are here.');
    expect(resolveDateSpeechText(bilingual, 'en')).toBe('You are here.');
    expect(resolveDateSpeechText(bilingual, 'ja')).toBe('你来啦。');
    expect(resolveDateSpeechText(bilingual)).toBe('你来啦。');
  });

  it('does not lose words around quotes in translated dialogue', () => {
    expect(resolveDateSpeechText('"你说的对吗？" <date-voice lang="en">Did you say "yes"?</date-voice>', 'en')).toBe('Did you say "yes"?');
  });

  it('reads old, empty or incomplete translations as the original without leaking markup', () => {
    for (const suffix of ['', ' <date-voice lang="en"></date-voice>', ' <date-voice lang="en">unfinished']) {
      expect(resolveDateSpeechText('[normal] "你好。"' + suffix, 'en')).toBe('你好。');
    }
  });

  it('joins wrapped translations to their source line and reads translated narration too', () => {
    const body = '[normal] 他挥了挥手。\n<date-voice lang="en">He waved.\n</date-voice>\n' + bilingual;
    expect(normalizeDateVoiceLines(body).split('\n')).toHaveLength(2);
    expect(buildDateReadingScript(body, 'en', true)).toBe('He waved.\n[whispers] You are here.');
    expect(buildDateReadingScript(body, '', true)).toBe('他挥了挥手。\n"你来啦。"');
  });

  it('separates cached audio when speech, language, emotion, voice or model settings change', () => {
    const char = { id: 'c', dateVoiceLang: 'en', voiceProfile: { elevenLabsVoiceId: 'voice1' } } as CharacterProfile;
    const config = { ttsProvider: 'elevenlabs', elevenLabsModel: 'eleven_v4' } as APIConfig;
    const key = dateVoiceCacheKey('Hello.', char, config, 'calm');
    expect(dateVoiceCacheKey('Hello.', { ...char }, { ...config }, 'calm')).toBe(key);
    expect(dateVoiceCacheKey('Bye.', char, config, 'calm')).not.toBe(key);
    expect(dateVoiceCacheKey('Hello.', { ...char, dateVoiceLang: 'ja' }, config, 'calm')).not.toBe(key);
    expect(dateVoiceCacheKey('Hello.', { ...char, voiceProfile: { elevenLabsVoiceId: 'voice2' } }, config, 'calm')).not.toBe(key);
    expect(dateVoiceCacheKey('Hello.', char, { ...config, elevenLabsModel: 'eleven_v3' }, 'calm')).not.toBe(key);
    expect(dateVoiceCacheKey('Hello.', char, { ...config, elevenLabsStability: 0.2 }, 'calm')).not.toBe(key);
    expect(dateVoiceCacheKey('Hello.', char, config, 'happy')).not.toBe(key);
  });
});

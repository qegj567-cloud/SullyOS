import { describe, expect, it } from 'vitest';
import type { APIConfig, CharacterProfile } from '../types';
import {
  buildElevenLabsRequestBody,
  DEFAULT_ELEVENLABS_MODEL,
  ELEVENLABS_MODEL_OPTIONS,
  cleanTextForTtsElevenLabs,
  getElevenLabsVoiceActingGuide,
  normalizeElevenLabsVoiceId,
  stripElevenLabsMarkupForDisplay,
} from './elevenLabsTts';
import { getElevenLabsModel, normalizeTtsProvider, setElevenLabsModel } from './ttsProvider';

const character = {
  id: 'char-1',
  name: '测试角色',
  avatar: '',
  description: '',
  systemPrompt: '',
  memories: [],
  voiceProfile: {
    elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM',
    speed: 1.1,
  },
} as CharacterProfile;

describe('ElevenLabs voice id', () => {
  it('accepts a raw id and extracts ids from common links', () => {
    expect(normalizeElevenLabsVoiceId('21m00Tcm4TlvDq8ikWAM')).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenLabsVoiceId('https://elevenlabs.io/app/voice-library?voiceId=21m00Tcm4TlvDq8ikWAM'))
      .toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenLabsVoiceId('https://elevenlabs.io/app/voice-library/21m00Tcm4TlvDq8ikWAM'))
      .toBe('21m00Tcm4TlvDq8ikWAM');
    expect(normalizeElevenLabsVoiceId('https://elevenlabs.io/app/settings')).toBe('');
  });
});

describe('ElevenLabs text cleanup', () => {
  it.each(['eleven_v4', 'eleven_v4_turbo'])('preserves open-ended audio directions, effects, pauses and IPA for %s', (model) => {
    const script = '[Warm, conversational tone, faint amusement] 你好 [door slams] [long pause] /ˌbaɪoʊˈkemɪstri/\n\n[Quietly, with controlled fear] 等等。';
    expect(cleanTextForTtsElevenLabs(`<语音>${script}</语音><字幕>你好</字幕>`, model)).toBe(script);
  });

  it('removes app markup and unsupported SSML without discarding spoken content', () => {
    expect(cleanTextForTtsElevenLabs('<语音>[whispers] [[秘密]] <break time="1s" /> <emphasis>你好</emphasis> <#0.5#>（看向窗外）</语音>%%BILINGUAL%%译文', 'eleven_v4'))
      .toBe('[whispers] 你好');
  });

  it('hides free-form v4 directions in subtitles while preserving ordinary Chinese brackets', () => {
    expect(stripElevenLabsMarkupForDisplay('[Warm, conversational tone] 你好 [door slams] [第2章]', 'eleven_v4'))
      .toBe('你好 [第2章]');
  });
  it('keeps supported v3 tags and converts known parenthesized cues', () => {
    expect(cleanTextForTtsElevenLabs('<语音>[laughs] 你好 (sigh)</语音>', 'eleven_v3'))
      .toBe('[laughs] 你好 [sighs]');
  });

  it('removes performance tags for non-v3 models so they are not spoken aloud', () => {
    const output = cleanTextForTtsElevenLabs('[laughs] 你好 (sighs)（看向窗外）', 'eleven_flash_v2_5');
    expect(output).toBe('你好');
  });

  it('removes cues only from display text and preserves ordinary brackets', () => {
    expect(stripElevenLabsMarkupForDisplay('[whispers] 小声说 [第2章]')).toBe('小声说 [第2章]');
  });
});

describe('ElevenLabs request body', () => {
  it.each(['eleven_v4', 'eleven_v4_turbo'])('sends only supported v4 voice settings for %s without quantizing stability', (model) => {
    const body = buildElevenLabsRequestBody('[soft chuckle] 真的？', character, {
      baseUrl: '', apiKey: '', model: '', elevenLabsModel: model,
      elevenLabsStability: 0.35, elevenLabsSimilarityBoost: 0.9,
      elevenLabsStyle: 0.8, elevenLabsUseSpeakerBoost: true,
    }, { emotion: 'surprised', languageBoost: 'yue' });
    expect(body).toEqual({
      text: '[soft chuckle] 真的？', model_id: model,
      voice_settings: { stability: 0.35, similarity_boost: 0.9 },
    });
  });

  it('maps date emotions into v4 audio tags when the script has no direction', () => {
    expect(buildElevenLabsRequestBody('真的？', character, {
      baseUrl: '', apiKey: '', model: '', elevenLabsModel: 'eleven_v4',
    }, { emotion: 'surprised' }).text).toBe('[curious] 真的？');
  });
  it('uses global voice settings, role speed and ISO language code', () => {
    const config: APIConfig = {
      baseUrl: '',
      apiKey: '',
      model: '',
      elevenLabsModel: 'eleven_flash_v2_5',
      elevenLabsStability: 0.35,
      elevenLabsSimilarityBoost: 1.5,
      elevenLabsStyle: -1,
      elevenLabsUseSpeakerBoost: true,
    };
    const body = buildElevenLabsRequestBody('你好', character, config, { languageBoost: 'JA' });
    expect(body).toMatchObject({
      text: '你好',
      model_id: 'eleven_flash_v2_5',
      language_code: 'ja',
      voice_settings: {
        stability: 0.35,
        similarity_boost: 1,
        style: 0,
        speed: 1.1,
        use_speaker_boost: true,
      },
    });
  });

  it('snaps v3 stability to supported tiers and adds an emotion cue once', () => {
    const config = {
      baseUrl: '', apiKey: '', model: '',
      elevenLabsModel: 'eleven_v3',
      elevenLabsStability: 0.76,
    } as APIConfig;
    const body = buildElevenLabsRequestBody('真的？', character, config, { emotion: 'surprised' });
    expect(body.voice_settings.stability).toBe(1);
    expect(body.text).toBe('[curious] 真的？');
  });
});

describe('ElevenLabs prompt and provider routing', () => {
  it('defaults to v4 consistently and exposes both v4 variants', () => {
    expect(DEFAULT_ELEVENLABS_MODEL).toBe('eleven_v4');
    setElevenLabsModel(undefined);
    expect(getElevenLabsModel()).toBe(DEFAULT_ELEVENLABS_MODEL);
    expect(ELEVENLABS_MODEL_OPTIONS.map(option => option.value)).toEqual(expect.arrayContaining(['eleven_v4', 'eleven_v4_turbo']));
    setElevenLabsModel('eleven_flash_v2_5');
    expect(getElevenLabsModel()).toBe('eleven_flash_v2_5');
    setElevenLabsModel(undefined);
  });

  it.each(['eleven_v4', 'eleven_v4_turbo'])('uses v4 guidance covering expressive delivery, effects and pronunciation for %s', (model) => {
    const guide = getElevenLabsVoiceActingGuide(model);
    expect(guide).toContain('ElevenLabs v4');
    expect(guide).toContain('Audio Tags');
    expect(guide).toContain('[door slams]');
    expect(guide).toContain('IPA');
    expect(guide).not.toContain('一段 0–2 个');
  });
  it('uses audio-tag guidance only for v3 and recognizes the provider', () => {
    expect(getElevenLabsVoiceActingGuide('eleven_v3')).toContain('Audio Tags');
    expect(getElevenLabsVoiceActingGuide('eleven_flash_v2_5')).toContain('不要输出方括号');
    expect(normalizeTtsProvider('elevenlabs')).toBe('elevenlabs');
  });
});

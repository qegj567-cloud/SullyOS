import { describe, expect, it } from 'vitest';
import { describeDialogueApi, pickDialogueApi, resolveDialogueApi, dialogueMaxTokens } from './characterApi';
import { buildCharChatCredRow, buildCharEmotionCredRow, buildCharInstantCredRow } from './amsgLlmCredentials';
import { stripSensitiveCardFields } from './characterCard';

const globalApi = { baseUrl: 'https://global.test/v1', apiKey: 'global-key', model: 'global', stream: true, temperature: 0.4,
  ttsProvider: 'fishaudio' as const, visionApi: { enabled: true, baseUrl: 'https://vision.test', apiKey: 'vision-key', model: 'vision' } };
const personal = { baseUrl: 'https://role.test/v1', apiKey: 'role-key', model: 'role', stream: false, temperature: 1.1 };
const app = { baseUrl: 'https://app.test/v1', apiKey: 'app-key', model: 'app' };
const char = { id: 'a', dialogueApi: personal };

describe('dialogue routing', () => {
  it('validates output limits and inherits the global setting unless explicitly overridden', () => {
    for (const maxTokens of [0, -1, 1.5, NaN, Infinity, '2000']) expect(dialogueMaxTokens({ maxTokens } as any)).toBe(8000);
    expect(dialogueMaxTokens(resolveDialogueApi({ ...globalApi, maxTokens: 2048 }, char))).toBe(2048);
    expect(dialogueMaxTokens(resolveDialogueApi({ ...globalApi, maxTokens: 2048 }, { dialogueApi: { ...personal, maxTokens: 16000 } }))).toBe(16000);
  });
  it('uses app, character, then global without changing the global config', () => {
    expect(resolveDialogueApi(globalApi)).toBe(globalApi);
    expect(resolveDialogueApi(globalApi, char)).toMatchObject(personal);
    expect(resolveDialogueApi(globalApi, char, app)).toMatchObject(app);
    expect(globalApi.model).toBe('global');
  });
  it('keeps two independent members separate; a director explicitly omits the character', () => {
    expect([char, { id: 'b', dialogueApi: app }, { id: 'c' }].map(c => resolveDialogueApi(globalApi, c).model))
      .toEqual(['role', 'app', 'global']);
    expect(resolveDialogueApi(globalApi, undefined, app).model).toBe('app');
    expect(resolveDialogueApi(globalApi).model).toBe('global');
  });
  it('never borrows a global credential to repair an incomplete independent config', () => {
    expect(resolveDialogueApi(globalApi, { dialogueApi: { ...personal, apiKey: '', model: '' } }))
      .toMatchObject({ baseUrl: personal.baseUrl, apiKey: '', model: '' });
    expect(resolveDialogueApi(globalApi, char, { ...app, apiKey: '' }).apiKey).toBe('');
  });
  it('preserves voice and vision, but follows the selected endpoint stream and temperature', () => {
    const result = resolveDialogueApi(globalApi, { dialogueApi: { ...personal, ttsProvider: 'minimax', visionApi: undefined } as any });
    expect(result).toMatchObject({ ...personal, ttsProvider: 'fishaudio', visionApi: globalApi.visionApi });
    expect(pickDialogueApi(globalApi)).not.toHaveProperty('visionApi');
  });
  it('cloud scheduled and instant dialogue use the same role credentials, emotion stays global', () => {
    const expected = { apiUrl: personal.baseUrl + '/chat/completions', apiKey: personal.apiKey, primaryModel: personal.model };
    expect(buildCharChatCredRow(char, undefined, globalApi)?.value).toEqual(expected);
    expect(buildCharInstantCredRow(char.id, resolveDialogueApi(globalApi, char))?.value).toEqual(expected);
    expect(buildCharEmotionCredRow(char.id, undefined, globalApi)?.value.primaryModel).toBe('global');
    expect(buildCharChatCredRow({ id: char.id }, undefined, globalApi)?.value.primaryModel).toBe('global');
  });
  it('normalizes pasted values and never exposes keys in the status or shared character cards', () => {
    expect(pickDialogueApi({ baseUrl: ' https://role.test/v1/ ', apiKey: ' key ', model: ' role ' }))
      .toEqual({ baseUrl: personal.baseUrl, apiKey: 'key', model: 'role' });
    expect(describeDialogueApi(personal)).toBe('role.test · role');
    expect(describeDialogueApi({ ...personal, baseUrl: 'https://user:secret@role.test/v1?token=secret' })).not.toContain('secret');
    expect(stripSensitiveCardFields({ ...char, name: 'A' })).toEqual({ id: 'a', name: 'A' });
  });
});

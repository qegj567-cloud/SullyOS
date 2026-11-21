import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createBackupArchive } from './backupArchive';
import { assembleV2Backup, writeV2Backup } from './backupFormat';
import {
  normalizeApiBaseUrl,
  normalizeApiConfig,
  normalizeApiCredential,
} from './apiConfigNormalize';

describe('API config normalization', () => {
  it('restores the camera preference, original video config and separate speech key after a ZIP export', async () => {
    const original = { baseUrl: '', model: '', apiKey: '', minimaxApiKey: 'fixture-minimax',
      companionQuickReply: true, sttProvider: 'doubao' as const,
      companionVideoApi: { provider: 'doubao' as const, baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        model: 'doubao-seed-2.1-pro', apiKey: 'fixture-plan', preferSharedMiniMax: true as const },
      companionStt: { provider: 'doubao' as const, apiKey: 'fixture-speech', resourceId: 'volc.seedasr.sauc.duration' as const } };
    const archive = createBackupArchive();
    await writeV2Backup(archive, { apiConfig: original });
    const zip = await JSZip.loadAsync(await (await archive.generateBlob()).arrayBuffer());
    const restored = await assembleV2Backup(zip, JSON.parse(await zip.file('manifest.json')!.async('string')));
    expect(normalizeApiConfig(restored.apiConfig)).toEqual(original);
    expect(JSON.stringify(restored.apiConfig.companionVideoApi)).not.toContain(original.minimaxApiKey);
  });
  it('normalizes independent STT credentials and restores the supported default service on import', () => {
    const input = { baseUrl: 'https://chat.test', model: 'chat', apiKey: 'chat-key',
      companionStt: { provider: 'doubao', apiKey: ' \u200Bspeech-key ', resourceId: 'legacy', url: 'https://discard.test' } } as any;
    const result = normalizeApiConfig(input);
    expect(result.companionStt).toEqual({ provider: 'doubao', apiKey: 'speech-key', resourceId: 'volc.seedasr.sauc.duration' });
    expect(result.apiKey).toBe('chat-key'); expect(input.companionStt.resourceId).toBe('legacy');
  });
  it('removes pasted whitespace and invisible edge characters from credentials', () => {
    expect(normalizeApiCredential(' \n\u200Bsk-example\u2060\r ')).toBe('sk-example');
  });

  it('normalizes the base URL without touching its path', () => {
    expect(normalizeApiBaseUrl('  https://api.example.com/v1///\u200B ')).toBe('https://api.example.com/v1');
  });

  it('drops retired companion upload credentials on load without replacing the chosen video model', () => {
    const companionVideoApi = { provider: 'zhipu' as const, baseUrl: ' https://open.bigmodel.cn/api/paas/v4/ ',
      apiKey: ' model-key ', model: ' glm-4.6v ', upload: { baseUrl: 'https://retired.example', token: 'old-secret' } };
    const config = normalizeApiConfig({ baseUrl: '', apiKey: '', model: '', companionVideoApi });
    expect(config.companionVideoApi).toEqual({ provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'model-key', model: 'glm-4.6v' });
    expect(JSON.stringify(config)).not.toContain('old-secret');
    expect(companionVideoApi.upload.token).toBe('old-secret');
  });

  it('keeps unrelated API settings intact', () => {
    expect(normalizeApiConfig({
      baseUrl: ' https://api.example.com/v1/ ',
      apiKey: '\uFEFFsk-test\u200B',
      model: ' gpt-test ',
      stream: true,
      temperature: 0.7,
      minimaxApiKey: 'mini-key',
      visionApi: {
        enabled: true,
        baseUrl: ' https://vision.example.com/v1/// ',
        apiKey: '\u200Bvision-key\u2060',
        model: ' vision-model ',
      },
    })).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      stream: true,
      temperature: 0.7,
      minimaxApiKey: 'mini-key',
      visionApi: {
        enabled: true,
        baseUrl: 'https://vision.example.com/v1',
        apiKey: 'vision-key',
        model: 'vision-model',
      },
    });
  });
});

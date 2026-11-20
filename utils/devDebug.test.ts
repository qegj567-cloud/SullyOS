import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DEV_DEBUG_FLAGS,
  appendDevDebugApiLog,
  clearDevDebugLog,
  closeDevDebug,
  readDevDebugLog,
  redactDevDebugSecrets,
  unlockDevDebug,
  writeDevDebugFlags,
} from './devDebug';

describe('dev debug HTTP log capture', () => {
  afterEach(() => {
    clearDevDebugLog();
    closeDevDebug();
    vi.unstubAllGlobals();
  });

  it('sanitizes the request url in both the label and data of captured API logs', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      },
      dispatchEvent: () => true,
    });
    unlockDevDebug();
    writeDevDebugFlags({ ...DEFAULT_DEV_DEBUG_FLAGS, captureEnabled: true, captureLogs: ['api'] });

    const token = 'secretRelayToken_0123456789ABCDEFabcdef';
    appendDevDebugApiLog({
      url: `https://amsg-relay.friedsully.com/t/${token}/w.workers.dev/v1/chat/completions?key=AIzaSecret123`,
      method: 'POST',
      status: 500,
    });

    const [entry] = readDevDebugLog('api');
    expect(entry).toBeDefined();
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('AIzaSecret123');
    expect(entry.label).toContain('/t/<redacted>/w.workers.dev/v1/chat/completions');
    expect((entry.data as { url: string }).url).toContain('/t/<redacted>/w.workers.dev/v1/chat/completions');
  });
});

describe('dev debug privacy redaction', () => {
  it('never persists camera image data URLs in request detail logs', () => {
    expect(redactDevDebugSecrets({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,PRIVATEPIXELS' } }],
      }],
    })).toEqual({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: '<image data omitted · 36 chars>' } }],
      }],
    });
  });

  it('redacts amsg relay tokens embedded in url or error strings', () => {
    const token = 'secretRelayToken_0123456789ABCDEFabcdef';
    const relayUrl = `https://amsg-relay.friedsully.com/t/${token}/sullyos-amsg.louis810.workers.dev/debug`;
    const redacted = redactDevDebugSecrets({
      url: relayUrl,
      error: `TimeoutError while requesting ${relayUrl}`,
    });
    expect(redacted).toEqual({
      url: 'https://amsg-relay.friedsully.com/t/<redacted>/sullyos-amsg.louis810.workers.dev/debug',
      error: 'TimeoutError while requesting https://amsg-relay.friedsully.com/t/<redacted>/sullyos-amsg.louis810.workers.dev/debug',
    });
  });

  it('redacts sensitive query params, cookies, passwords, and bearer tokens in debug logs', () => {
    const redacted = redactDevDebugSecrets({
      url: 'https://user:pass@proxy.example.com/v1/chat/completions?key=AIzaSecret123',
      password: 'my-webdav-password',
      cookie: 'MUSIC_U=secret-cookie',
      error: '401 Bearer sk-secret-token-999999',
    });
    expect(JSON.stringify(redacted)).not.toContain('AIzaSecret123');
    expect(JSON.stringify(redacted)).not.toContain('user:pass');
    expect(JSON.stringify(redacted)).not.toContain('my-webdav-password');
    expect(JSON.stringify(redacted)).not.toContain('secret-cookie');
    expect(JSON.stringify(redacted)).not.toContain('sk-secret-token-999999');
    // 只抹凭据，域名、接口路径和报错状态码要留着排障。
    const kept = redacted as Record<string, string>;
    expect(kept.url).toContain('proxy.example.com/v1/chat/completions');
    expect(kept.error).toContain('401 Bearer');
  });

  it('redacts extended credential keys without over-matching unrelated fields', () => {
    const redacted = redactDevDebugSecrets({
      device_key: 'bark-device-secret',
      // 值故意不像 SPT_ 令牌，确保打码来自键名规则而不是文本兜底。
      spt: 'plain-spt-value',
      amap_key: 'amap-secret',
      geoapify_key: 'geo-secret',
      aspt: 'keep-me-not-spt',
    }) as Record<string, unknown>;
    expect(redacted.device_key).toBe('<redacted>');
    expect(redacted.spt).toBe('<redacted>');
    expect(redacted.amap_key).toBe('<redacted>');
    expect(redacted.geoapify_key).toBe('<redacted>');
    expect(redacted.aspt).toBe('keep-me-not-spt');
  });
});

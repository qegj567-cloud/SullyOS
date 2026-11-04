import { describe, expect, it } from 'vitest';
import {
    THIRD_PARTY_PUSH_PROVIDERS,
    buildThirdPartyClickUrl,
    buildThirdPartyPushEndpoint,
    normalizeThirdPartyPushConfig,
    parseThirdPartyPushEndpoint,
    validateThirdPartyPushConfig,
} from './amsgThirdPartyPush';

describe('amsgThirdPartyPush', () => {
    it('exposes wxpusher (recommended), bark, and meow without ntfy in provider options', () => {
        expect(THIRD_PARTY_PUSH_PROVIDERS.map(p => p.id)).toEqual(['wxpusher', 'bark', 'meow']);
        expect(THIRD_PARTY_PUSH_PROVIDERS[0].label).toContain('推荐');
        expect(THIRD_PARTY_PUSH_PROVIDERS[1].label).toContain('头像');
        expect(THIRD_PARTY_PUSH_PROVIDERS[2].label).toContain('纯血鸿蒙备用');
    });

    it('normalizes WxPusher SPT token from raw string or pasted URL', () => {
        expect(
            normalizeThirdPartyPushConfig({
                provider: 'wxpusher',
                token: '  SPT_abc123XYZ_-99  ',
            }),
        ).toEqual({
            provider: 'wxpusher',
            token: 'SPT_abc123XYZ_-99',
            serverOrigin: 'https://wxpusher.zjiecode.com',
        });

        expect(
            normalizeThirdPartyPushConfig({
                provider: 'wxpusher',
                token: 'https://wxpusher.zjiecode.com/api/send/message/SPT_fromUrl12345/hello',
            }),
        ).toEqual({
            provider: 'wxpusher',
            token: 'SPT_fromUrl12345',
            serverOrigin: 'https://wxpusher.zjiecode.com',
        });
    });

    it('validates WxPusher SPT format', () => {
        expect(validateThirdPartyPushConfig({ provider: 'wxpusher', token: 'invalid_token' }).ok).toBe(false);
        expect(validateThirdPartyPushConfig({ provider: 'wxpusher', token: 'SPT_valid12345' }).ok).toBe(true);
    });

    it('normalizes Bark key or full URL and builds/parses endpoint', () => {
        const fromUrl = normalizeThirdPartyPushConfig({
            provider: 'bark',
            token: 'https://bark.example.com/MyDeviceKey123/测试推送',
        });
        expect(fromUrl).toEqual({
            provider: 'bark',
            token: 'MyDeviceKey123',
            serverOrigin: 'https://bark.example.com',
        });

        const endpoint = buildThirdPartyPushEndpoint({
            provider: 'bark',
            token: 'MyDeviceKey123',
            serverUrl: 'https://bark.example.com/',
        });
        expect(endpoint).toBe('bark:https://bark.example.com/MyDeviceKey123');
        expect(parseThirdPartyPushEndpoint(endpoint)).toEqual({
            provider: 'bark',
            token: 'MyDeviceKey123',
            serverOrigin: 'https://bark.example.com',
        });
    });

    it('normalizes MeoW nickname or full URL and builds/parses endpoint', () => {
        const endpoint = buildThirdPartyPushEndpoint({
            provider: 'meow',
            token: 'https://api.chuckfang.com/sully_harmony/',
        });
        expect(endpoint).toBe('meow:https://api.chuckfang.com/sully_harmony');
        expect(parseThirdPartyPushEndpoint(endpoint)).toEqual({
            provider: 'meow',
            token: 'sully_harmony',
            serverOrigin: 'https://api.chuckfang.com',
        });
    });

    it('builds click jump URL only for public http(s) origins', () => {
        expect(buildThirdPartyClickUrl('http://localhost:5173/', 'char-1')).toBeUndefined();
        expect(buildThirdPartyClickUrl('https://sully.example.com/', 'char-1')).toBe(
            'https://sully.example.com/?openApp=chat&activeMsgCharId=char-1',
        );
    });
});

import { describe, expect, it } from 'vitest';
import {
    VOICE_BACKUP_DIR,
    VOICE_BACKUP_MARKER,
    externalizeVoiceMessageBlobs,
    externalizeVoiceMessageBlob,
    restoreVoiceMessageBlobs,
    shouldIncludeVoiceRelatedAssetInBackup,
} from './voiceMessageBackup';
import { VOICE_FAVORITE_AUDIO_PREFIX, VOICE_FAVORITES_INDEX_ASSET_ID } from './voiceFavorites';
import {
    COMPANION_STARTUP_VOICE_ASSET_PREFIX,
    COMPANION_TOUCH_VOICE_ASSET_PREFIX,
} from './companionVoiceAssets';

it('逐条语音导出保留 Blob 到 ZIP 读取时，不提前展开完整音频', async () => {
    const original = new Blob([new Uint8Array([1, 4, 9])], { type: 'audio/mpeg' });
    original.arrayBuffer = async () => { throw new Error('eager audio allocation'); };
    const row: any = { id: `${VOICE_FAVORITE_AUDIO_PREFIX}one`, data: { blob: original, title: '保留' } };
    const files = new Map<string, Blob>();
    externalizeVoiceMessageBlob(row, 7, (path, blob) => { files.set(path, blob); });
    expect(row.data.title).toBe('保留');
    expect(row.data.blob[VOICE_BACKUP_MARKER]).toBe(true);
    expect(row.data.blob.size).toBe(3);
    expect(files.get(row.data.blob.path)).toBe(original);
    await restoreVoiceMessageBlobs([row], async path => new Uint8Array(await files.get(path)!.slice().arrayBuffer()));
    expect([...new Uint8Array(await row.data.blob.arrayBuffer())]).toEqual([1, 4, 9]);
});

describe('chat voice backup binary lane', () => {
    it('round-trips per-message audio as a real Blob', async () => {
        const bytes = new Uint8Array([1, 4, 9, 16]);
        const assets: any[] = [
            { id: 'voice_msg_42', data: { blob: new Blob([bytes], { type: 'audio/mpeg' }), favorite: true, originalText: 'hello' } },
            { id: 'ordinary_setting', data: { enabled: true } },
        ];
        const files = new Map<string, Uint8Array>();

        expect(await externalizeVoiceMessageBlobs(assets, (path, data) => { files.set(path, data); })).toBe(1);
        expect(assets[0].data.blob[VOICE_BACKUP_MARKER]).toBe(true);
        expect(assets[0].data.blob.path).toMatch(new RegExp(`^${VOICE_BACKUP_DIR}/`));
        expect(JSON.parse(JSON.stringify(assets))[0].data.blob.size).toBe(bytes.byteLength);

        expect(await restoreVoiceMessageBlobs(assets, async path => files.get(path) || null)).toBe(1);
        expect(assets[0].data.blob).toBeInstanceOf(Blob);
        expect(assets[0].data.blob.type).toBe('audio/mpeg');
        expect(Array.from(new Uint8Array(await assets[0].data.blob.arrayBuffer()))).toEqual(Array.from(bytes));
        expect(assets[0].data.originalText).toBe('hello');
    });

    it('externalizes unified favorites from every source without loading ordinary voice cache', async () => {
        const assets: any[] = [
            { id: `${VOICE_FAVORITE_AUDIO_PREFIX}call_1`, data: { blob: new Blob(['call'], { type: 'audio/mpeg' }) } },
            { id: VOICE_FAVORITES_INDEX_ASSET_ID, data: { version: 1, items: [{ source: 'call' }] } },
            { id: 'voice_msg_ordinary', data: { blob: new Blob(['ordinary']), favorite: false } },
        ];
        const files = new Map<string, Uint8Array>();

        expect(await externalizeVoiceMessageBlobs(assets, (path, data) => { files.set(path, data); })).toBe(1);
        expect(files.size).toBe(1);
        expect(assets[0].data.blob[VOICE_BACKUP_MARKER]).toBe(true);
        expect(shouldIncludeVoiceRelatedAssetInBackup(assets[0])).toBe(true);
        expect(shouldIncludeVoiceRelatedAssetInBackup(assets[1])).toBe(true);
        expect(shouldIncludeVoiceRelatedAssetInBackup(assets[2])).toBe(false);
    });

    it('does not duplicate the reproducible shared TTS cache', async () => {
        const assets: any[] = [
            { id: 'tts_abc', data: { blob: new Blob([new Uint8Array([7])], { type: 'audio/mpeg' }) } },
            { id: 'voice_msg_9', data: { blob: new Blob([new Uint8Array([8])], { type: 'audio/mpeg' }), favorite: false } },
        ];
        const files = new Map<string, Uint8Array>();

        expect(await externalizeVoiceMessageBlobs(assets, (path, data) => { files.set(path, data); })).toBe(0);
        expect(files.size).toBe(0);
        expect(assets[0].data.blob).toBeInstanceOf(Blob);
        expect(assets[1].data.blob).toBeInstanceOf(Blob);
    });

    it('backs up only preset-owned companion voice Blobs alongside explicit favorites', async () => {
        const assets: any[] = [
            { id: `${COMPANION_STARTUP_VOICE_ASSET_PREFIX}char:preset-a`, data: { blob: new Blob(['startup'], { type: 'audio/mpeg' }) } },
            { id: `${COMPANION_TOUCH_VOICE_ASSET_PREFIX}char:preset-b:head:0`, data: { blob: new Blob(['touch'], { type: 'audio/wav' }) } },
            { id: 'voice_msg_unfavorited', data: { blob: new Blob(['chat']), favorite: false } },
            { id: 'tts_reproducible', data: { blob: new Blob(['tts']) } },
        ];
        const files = new Map<string, Uint8Array>();

        expect(await externalizeVoiceMessageBlobs(assets, (path, data) => { files.set(path, data); })).toBe(2);
        expect(files.size).toBe(2);
        expect(assets[0].data.blob.path).toMatch(/^assets\/companion-voices\//);
        expect(assets[1].data.blob.path).toMatch(/^assets\/companion-voices\//);
        expect(assets[2].data.blob).toBeInstanceOf(Blob);
        expect(assets[3].data.blob).toBeInstanceOf(Blob);

        expect(await restoreVoiceMessageBlobs(assets, async path => files.get(path) || null)).toBe(2);
        expect(await assets[0].data.blob.text()).toBe('startup');
        expect(await assets[1].data.blob.text()).toBe('touch');
    });

    it('includes only explicit favorites among voice-related asset rows', () => {
        expect(shouldIncludeVoiceRelatedAssetInBackup({ id: 'tts_hash', data: {} })).toBe(false);
        expect(shouldIncludeVoiceRelatedAssetInBackup({ id: 'voice_msg_1', data: { favorite: false } })).toBe(false);
        expect(shouldIncludeVoiceRelatedAssetInBackup({ id: 'voice_msg_2', data: { favorite: true } })).toBe(true);
        expect(shouldIncludeVoiceRelatedAssetInBackup({ id: `${VOICE_FAVORITE_AUDIO_PREFIX}chat_1`, data: {} }, false)).toBe(false);
        expect(shouldIncludeVoiceRelatedAssetInBackup({ id: `${COMPANION_TOUCH_VOICE_ASSET_PREFIX}char:pack`, data: {} })).toBe(true);
        expect(shouldIncludeVoiceRelatedAssetInBackup({ id: `${COMPANION_TOUCH_VOICE_ASSET_PREFIX}char:pack`, data: {} }, false)).toBe(false);
        expect(shouldIncludeVoiceRelatedAssetInBackup({ id: VOICE_FAVORITES_INDEX_ASSET_ID, data: {} }, false)).toBe(false);
        expect(shouldIncludeVoiceRelatedAssetInBackup({ id: 'wallpaper', data: 'x' })).toBe(true);
    });

    it('rejects a missing or truncated voice file before import', async () => {
        const marker = (size: number) => ({
            [VOICE_BACKUP_MARKER]: true,
            path: `${VOICE_BACKUP_DIR}/voice_msg_1_0.bin`,
            mimeType: 'audio/mpeg',
            size,
        });

        await expect(restoreVoiceMessageBlobs(
            [{ id: 'voice_msg_1', data: { blob: marker(4) } }],
            async () => null,
        )).rejects.toThrow('缺少语音文件');

        await expect(restoreVoiceMessageBlobs(
            [{ id: 'voice_msg_1', data: { blob: marker(4) } }],
            async () => new Uint8Array([1, 2]),
        )).rejects.toThrow('大小不符');
    });
});

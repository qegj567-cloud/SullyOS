import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const candidate = () => 'data:audio/mpeg;base64,' + btoa('x'.repeat(15096));
const hashBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16)).buffer;
beforeEach(() => { vi.resetModules(); localStorage.clear(); vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('hashes a candidate only once, including concurrent requests', async () => {
    const m = await import('./recalledNotificationSound');
    const digest = vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(hashBytes(m.RECALLED_SOUND_HASH));
    const src = candidate();
    expect(await Promise.all([m.isRecalledNotificationSound(src), m.isRecalledNotificationSound(src)])).toEqual([true, true]);
    expect(await m.isRecalledNotificationSound(src)).toBe(true);
    expect(digest).toHaveBeenCalledTimes(1);
});

it('compares bytes despite MIME changes or base64 whitespace', async () => {
    const m = await import('./recalledNotificationSound');
    const digest = vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(hashBytes(m.RECALLED_SOUND_HASH));
    expect(await m.isRecalledNotificationSound(candidate().replace('mpeg', 'ogg').replace('base64,', 'base64,\n'))).toBe(true);
    expect((digest.mock.calls[0][1] as Uint8Array).byteLength).toBe(15096);
});

it('does not hash builtins, remote URLs, short or oversized inline sounds, or fetch anything', async () => {
    const m = await import('./recalledNotificationSound');
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const src of ['chime', 'none', 'https://example.invalid/sound.mp3', 'data:audio/mp3;base64,eA==', 'data:audio/mp3;base64,' + 'x'.repeat(33000)]) {
        expect(await m.isRecalledNotificationSound(src)).toBe(false);
    }
    expect(digest).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('allows a different recording of the same length', async () => {
    const m = await import('./recalledNotificationSound');
    expect(await m.isRecalledNotificationSound(candidate())).toBe(false);
});

it('does not cache failed verification as a safe result', async () => {
    const m = await import('./recalledNotificationSound');
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(Error('unavailable')).mockResolvedValueOnce(hashBytes(m.RECALLED_SOUND_HASH));
    await expect(m.isRecalledNotificationSound(candidate())).rejects.toThrow();
    expect(await m.isRecalledNotificationSound(candidate())).toBe(true);
    expect(digest).toHaveBeenCalledTimes(2);
});

it('blocks before Audio construction, repairs the selected setting and notifies once', async () => {
    const m = await import('./recalledNotificationSound');
    vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(hashBytes(m.RECALLED_SOUND_HASH));
    const audio = vi.fn(); vi.stubGlobal('Audio', audio);
    const listener = vi.fn(); window.addEventListener(m.RECALLED_SOUND_EVENT, listener);
    const repair = vi.fn(); const { playWhiteboxSound } = await import('./whiteboxSound');
    playWhiteboxSound({ src: candidate() }, { onBlocked: repair });
    playWhiteboxSound({ src: candidate() }, { onBlocked: repair });
    await vi.waitFor(() => expect(repair).toHaveBeenCalledTimes(2));
    expect(audio).not.toHaveBeenCalled(); expect(listener).toHaveBeenCalledTimes(1);
    m.acknowledgeRecalledSoundNotice(); m.notifyRecalledSound();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.resetModules(); const reloaded = await import('./recalledNotificationSound');
    reloaded.notifyRecalledSound(); expect(reloaded.hasRecalledSoundNotice()).toBe(false);
});

it('preserves the owner on this device, but a different author is not exempt', async () => {
    const m = await import('./recalledNotificationSound');
    const { BEAUTY_SHARE_URL } = await import('./beautyShareConfig');
    localStorage.setItem('sully-beauty-author-identity-v1', JSON.stringify({ version: 1, service: BEAUTY_SHARE_URL, authorCode: 'A-AC8B38B60D1CD6B2', password: 'test-only-long-password' }));
    expect(m.isRecalledSoundOwner()).toBe(true);
    const play = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Audio', class { volume = 0; play = play; });
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const { playWhiteboxSound } = await import('./whiteboxSound');
    playWhiteboxSound({ src: candidate() }); expect(play).toHaveBeenCalledOnce(); expect(digest).not.toHaveBeenCalled();
    localStorage.clear(); localStorage.setItem('sully-beauty-author-session-v1', JSON.stringify({ authorCode: 'A-0000000000000000', token: 'a'.repeat(64), expiresAt: Date.now() + 60000 }));
    expect(m.isRecalledSoundOwner()).toBe(false);
});

it('repairs only matching CSS/structured sound and preserves unrelated styles', async () => {
    const m = await import('./recalledNotificationSound');
    const css = '.keep{color:red}/* @sully-sound {"src":"bad"} */.also{color:blue}';
    expect(m.resetRecalledSoundSettings({ chromeCustomCss: css }, 'bad')).toEqual({ chromeCustomCss: '.keep{color:red}.also{color:blue}', chatSound: { src: 'none' }, chatSoundBound: false });
    expect(m.resetRecalledSoundSettings({ chatSound: { src: 'bad' } }, 'bad', true)).toEqual({ chatSound: { src: 'none' } });
    expect(m.resetRecalledSoundSettings({ chatSound: { src: 'new-selection' } }, 'bad')).toBeNull();
});

it('still plays an unrelated custom sound with the requested volume', async () => {
    const play = vi.fn().mockResolvedValue(undefined); const instances: any[] = [];
    vi.stubGlobal('Audio', class { volume = 0; play = play; constructor(public src: string) { instances.push(this); } });
    const { playWhiteboxSound } = await import('./whiteboxSound');
    playWhiteboxSound({ src: candidate(), volume: 0.3 });
    await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
    expect(instances[0].volume).toBe(0.3);
});

it('neither plays nor resets a candidate when fingerprint verification fails', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(Error('crypto unavailable'));
    const audio = vi.fn(), repair = vi.fn(); vi.stubGlobal('Audio', audio);
    const { playWhiteboxSound } = await import('./whiteboxSound');
    const m = await import('./recalledNotificationSound');
    playWhiteboxSound({ src: candidate() }, { onBlocked: repair });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(audio).not.toHaveBeenCalled(); expect(repair).not.toHaveBeenCalled(); expect(m.hasRecalledSoundNotice()).toBe(false);
});

// Optional local evidence check. The private audio is never committed as a fixture.
it.skipIf(!process.env.RECALLED_SOUND_AUDIT_FILE)('matches the actual withdrawn recording', async () => {
    const pack = JSON.parse(readFileSync(process.env.RECALLED_SOUND_AUDIT_FILE!, 'utf8'));
    const m = await import('./recalledNotificationSound');
    expect(await m.isRecalledNotificationSound(pack.theme.chatSound.src)).toBe(true);
});

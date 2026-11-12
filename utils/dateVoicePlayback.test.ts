// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    config: { ttsProvider: 'elevenlabs', elevenLabsModel: 'eleven_v4' } as any,
    speak: vi.fn(), replay: vi.fn(), stop: vi.fn(), fetch: vi.fn(), synthesize: vi.fn(),
    toast: vi.fn(), registerBackHandler: vi.fn(() => () => {}),
}));
vi.mock('../context/OSContext', () => ({ useOS: () => ({ apiConfig: mocks.config, addToast: mocks.toast, registerBackHandler: mocks.registerBackHandler, updateCharacter: vi.fn() }) }));
vi.mock('../components/date/DateSettings', () => ({ default: () => null }));
vi.mock('../components/date/ObserveHUD', () => ({ default: () => null }));
vi.mock('../components/os/TokenImg', () => ({ default: () => null }));
vi.mock('../components/voice/VoiceFavoriteActionSheet', () => ({ default: () => null }));
vi.mock('../components/voice/StreamingVoiceBar', () => ({ default: () => null }));
vi.mock('./blobRef', () => ({ useBlobRefUrl: () => '' }));
vi.mock('./minimaxTts', () => ({ VALID_EMOTIONS: new Set(['calm', 'happy']) }));
vi.mock('./datePrompts', () => ({ extractObservation: (text: string) => ({ rest: text, observation: null }), hasObservation: () => false }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./shareExport', () => ({ fetchBlobForShare: vi.fn() }));
vi.mock('./voiceFavorites', () => ({ getVoiceFavorite: vi.fn(), makeVoiceFavoriteId: () => 'id', removeVoiceFavorite: vi.fn(), saveVoiceFavorite: vi.fn() }));
vi.mock('./useDateReadingScroll', () => ({ useDateReadingScroll: () => ({ scrollRef: { current: null }, contentRef: { current: null }, onScroll: vi.fn() }) }));
vi.mock('./ttsRouter', () => ({ canSynthesizeSpeech: () => true, characterHasVoice: () => true, cleanTextForTtsProvider: (s: string) => s, stripTtsMarkupForDisplay: (s: string) => s, synthesizeSpeech: mocks.synthesize }));
vi.mock('../hooks/useStreamingVoice', () => ({ useStreamingVoice: () => ({ state: null, speak: mocks.speak, replay: mocks.replay, stop: mocks.stop }) }));
vi.mock('./elevenLabsStream', () => ({ streamElevenLabsSpeech: vi.fn() }));

import DateSession from '../components/date/DateSession';

let root: Root;
let container: HTMLDivElement;
const content = '[happy] "你来啦。" [v:calm] <date-voice lang="en">[whispers] You are here.</date-voice>';
let props: any;
const render = async () => { await act(async () => root.render(React.createElement(DateSession, props))); };
const click = async (button: Element | null) => {
    expect(button).not.toBeNull();
    await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const playLine = () => click(container.querySelector('button[title="播放；长按可收藏"]'));
beforeEach(() => {
    vi.clearAllMocks();
    mocks.config = { ttsProvider: 'elevenlabs', elevenLabsModel: 'eleven_v4' };
    mocks.speak.mockResolvedValue({ blob: new Blob(['audio']), cues: [], duration: 1 });
    mocks.replay.mockResolvedValue(undefined);
    mocks.synthesize.mockResolvedValue('blob:non-streamed');
    vi.stubGlobal('fetch', mocks.fetch);
    vi.stubGlobal('Audio', class { src = ''; onended: unknown; play = vi.fn(async () => {}); pause = vi.fn(); });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('URL', class extends URL {
        static createObjectURL = vi.fn(() => 'blob:date-voice');
        static revokeObjectURL = vi.fn();
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    props = {
        char: { id: 'c', name: '角色', avatar: '', dateVoiceEnabled: true, dateVoiceLang: 'en', voiceProfile: { elevenLabsVoiceId: 'voice1' } },
        userProfile: { name: '用户' }, messages: [{ id: 1, role: 'assistant', content, timestamp: 1, metadata: { source: 'date' } }],
        peekStatus: '', initialState: { isNovelMode: true, currentText: content, dialogueQueue: [], dialogueBatch: [] },
        onSendMessage: vi.fn(), onReroll: vi.fn(), onExit: vi.fn(), onEditMessage: vi.fn(), onDeleteMessage: vi.fn(), onDeleteMessages: vi.fn(), onSettings: vi.fn(),
    };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('见面播放不单独翻译，生成成功后直接重播', () => {
    it.each(['eleven_v4', 'eleven_v4_turbo', 'eleven_v3'])('%s 点播使用回复译文，重播不重新合成', async model => {
        mocks.config.elevenLabsModel = model;
        await render();
        expect(container.textContent).toContain('你来啦。');
        expect(container.textContent).not.toContain('You are here');
        await playLine(); await playLine();
        expect(mocks.speak).toHaveBeenCalledTimes(1);
        expect(mocks.speak.mock.calls[0][1]).toContain('You are here.');
        expect(mocks.replay).toHaveBeenCalledTimes(1);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('整段朗读使用逐行译文并复用音频', async () => {
        props.messages[0].content = '[normal] 他挥手。 <date-voice lang="en">He waved.</date-voice>\n' + content;
        await render();
        const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '朗读最新一段')!;
        await click(button); await click(button);
        expect(mocks.speak).toHaveBeenCalledTimes(1);
        expect(mocks.speak.mock.calls[0][1]).toBe('He waved.\n[whispers] You are here.');
        expect(mocks.replay).toHaveBeenCalledTimes(1);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('旧消息读原文，修改语言不会沿用不匹配的译文', async () => {
        props.messages[0].content = '[normal] "旧台词。"';
        await render(); await playLine(); await playLine();
        expect(mocks.speak.mock.calls[0][1]).toBe('旧台词。');
        props = { ...props, char: { ...props.char, dateVoiceLang: 'ja' }, messages: [{ ...props.messages[0], content }] };
        await render(); await playLine();
        expect(mocks.speak.mock.calls[1][1]).toBe('你来啦。');
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('修改音色后重新合成，随后仍可缓存重播', async () => {
        await render(); await playLine();
        props = { ...props, char: { ...props.char, voiceProfile: { elevenLabsVoiceId: 'voice2' } } };
        await render(); await playLine(); await playLine();
        expect(mocks.speak).toHaveBeenCalledTimes(2);
        expect(mocks.replay).toHaveBeenCalledTimes(1);
    });

    it('失败或取消不缓存残缺音频，下次点击可重新生成', async () => {
        mocks.speak.mockRejectedValueOnce(new DOMException('stopped', 'AbortError'));
        await render(); await playLine(); await playLine(); await playLine();
        expect(mocks.speak).toHaveBeenCalledTimes(2);
        expect(mocks.replay).toHaveBeenCalledTimes(1);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('GAL 自动朗读后手动重播用同一个缓存', async () => {
        props.initialState.isNovelMode = false;
        await render();
        await vi.waitFor(() => expect(container.querySelector('button[title="播放；长按可收藏"]')).not.toBeNull());
        await playLine();
        expect(mocks.speak).toHaveBeenCalledTimes(1);
        expect(mocks.replay).toHaveBeenCalledTimes(1);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('非 ElevenLabs 同样直接读译文并缓存 URL', async () => {
        mocks.config.ttsProvider = 'minimax';
        await render(); await playLine(); await playLine(); await playLine();
        expect(mocks.synthesize).toHaveBeenCalledTimes(1);
        expect(mocks.synthesize.mock.calls[0][0]).toBe('You are here.');
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
});

// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FishVoiceTest } from '../../components/companion/FishVoiceTest';
import { testCompanionVoice } from './apiTests';
vi.mock('./apiTests', async original => ({ ...await original<typeof import('./apiTests')>(), testCompanionVoice: vi.fn(async () => ({ summary: '已合成并完成播放' })) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('explicit Fish testing uses the form draft and selected character without switching the saved engine', async () => {
  const host = document.createElement('div'), root = createRoot(host), begin = vi.fn();
  const characters = [{ id: 'a', name: 'A', voiceProfile: { fishReferenceId: 'reference-a', fishModel: 's2-pro' } },
    { id: 'b', name: 'B', voiceProfile: { fishReferenceId: 'reference-b' } }] as any;
  const api = { ttsProvider: 'minimax', fishAudioApiKey: 'draft-fish-key', fishAudioModel: 's2.1-pro' } as any;
  const before = JSON.stringify({ api, characters });
  try {
    await act(async () => root.render(React.createElement(FishVoiceTest, { api, characters, begin })));
    expect(testCompanionVoice).not.toHaveBeenCalled();
    expect(host.textContent).toContain('s2-pro'); expect(host.textContent).toContain('reference-a');
    expect(host.textContent).not.toContain('draft-fish-key');
    await act(async () => { const select = host.querySelector('select')!; select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => host.querySelector('button')!.click());
    expect(testCompanionVoice).toHaveBeenCalledWith(expect.objectContaining({ ttsProvider: 'fishaudio', fishAudioApiKey: 'draft-fish-key' }), characters[1], expect.any(AbortSignal), expect.any(Function));
    expect(begin).toHaveBeenCalledOnce(); expect(host.textContent).toContain('测试通过');
    expect(JSON.stringify({ api, characters })).toBe(before);
  } finally { await act(async () => root.unmount()); vi.clearAllMocks(); }
});

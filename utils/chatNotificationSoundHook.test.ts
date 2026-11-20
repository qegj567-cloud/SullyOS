// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useChatNotificationSound } from '../hooks/useChatNotificationSound';

const mock = vi.hoisted(() => ({ os: {} as any, blocked: undefined as undefined | ((src: string) => Promise<void>) }));
vi.mock('../context/OSContext', () => ({ useOS: () => mock.os }));
vi.mock('./whiteboxSound', async importOriginal => ({ ...await importOriginal<any>(), playWhiteboxSound: (_sound: unknown, options: any) => { mock.blocked = options.onBlocked; } }));
let root: ReturnType<typeof createRoot>, host: HTMLDivElement, play: ReturnType<typeof useChatNotificationSound>;
function Harness() { play = useChatNotificationSound(); return null; }
beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mock.os = { characters: [{ id: 'c1', chatSound: { src: 'bad' } }, { id: 'c2', chatSound: { src: 'safe' } }], groups: [{ id: 'g1', chatSound: { src: 'bad' } }], theme: {}, updateTheme: vi.fn(), updateGroup: vi.fn(), updateCharacter: vi.fn() };
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root.render(React.createElement(Harness)); });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('repairs the triggering character only and rechecks a newer selection', async () => {
    play('character', 'c1'); await mock.blocked!('bad');
    const [id, patch] = mock.os.updateCharacter.mock.calls[0]; expect(id).toBe('c1');
    expect(patch(mock.os.characters[0])).toMatchObject({ chatSound: { src: 'none' } });
    expect(patch({ id, chatSound: { src: 'safe' } })).toEqual({});
    expect(mock.os.updateTheme).not.toHaveBeenCalled();
});

it('repairs inherited global sound, not every character', async () => {
    mock.os.characters[0].chatSound = undefined; mock.os.theme = { chatSound: { src: 'bad' } };
    play('character', 'c1'); await mock.blocked!('bad');
    expect(mock.os.updateTheme).toHaveBeenCalledWith({ chatSound: { src: 'none' } });
    expect(mock.os.updateCharacter).not.toHaveBeenCalled();
});

it('does not overwrite a global selection made while the digest was pending', async () => {
    mock.os.characters[0].chatSound = undefined; mock.os.theme = { chatSound: { src: 'bad' } };
    play('character', 'c1'); mock.os = { ...mock.os, theme: { chatSound: { src: 'safe' } } };
    await act(async () => root.render(React.createElement(Harness)));
    await mock.blocked!('bad'); expect(mock.os.updateTheme).not.toHaveBeenCalled();
});

it('repairs the triggering group only', async () => {
    play('group', 'g1'); await mock.blocked!('bad');
    expect(mock.os.updateGroup).toHaveBeenCalledWith('g1', { chatSound: { src: 'none' }, chatSoundBound: false });
    expect(mock.os.updateCharacter).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AppID } from '../types';
import { appShortcutLaunch, useAppShortcut } from './appShortcutLaunch';

it('isolates App intents, consumes once under StrictMode, uses current state and cancels stale reads', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const received = vi.fn(); let firstIsCurrent: () => boolean = () => false;
  function Receiver({ label }: { label: string }) {
    useAppShortcut(AppID.CheckPhone, (intent, isCurrent) => { if (!received.mock.calls.length) firstIsCurrent = isCurrent; received(label, intent, isCurrent); });
    return null;
  }
  try {
    appShortcutLaunch.request({ appId: AppID.CheckPhone, entryId: 'contacts', characterId: 'a' });
    expect(appShortcutLaunch.consume(AppID.Journal)).toBeNull();
    await act(async () => root.render(React.createElement(StrictMode, {}, React.createElement(Receiver, { label: 'first' }))));
    expect(received).toHaveBeenCalledTimes(1);
    // A StrictMode effect replay must not discard the single consumed request's read.
    expect(firstIsCurrent()).toBe(true);
    await act(async () => root.render(React.createElement(StrictMode, {}, React.createElement(Receiver, { label: 'latest' }))));
    await act(async () => appShortcutLaunch.request({ appId: AppID.CheckPhone, entryId: 'chat', characterId: 'b' }));
    expect(received.mock.lastCall?.[0]).toBe('latest');
    const isCurrent = received.mock.lastCall![2]; expect(isCurrent()).toBe(true);
    await act(async () => appShortcutLaunch.request({ appId: AppID.CheckPhone, entryId: 'home', characterId: 'c' }));
    expect(isCurrent()).toBe(false);
    const last = received.mock.lastCall![2]; await act(async () => root.unmount()); expect(last()).toBe(false);
    appShortcutLaunch.request({ appId: AppID.CheckPhone }); expect(received).toHaveBeenCalledTimes(3);
    expect(appShortcutLaunch.consume(AppID.CheckPhone)).toEqual({ appId: AppID.CheckPhone });
  } finally { host.remove(); }
});

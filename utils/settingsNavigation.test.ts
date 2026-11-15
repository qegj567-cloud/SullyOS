// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { requestSettingsFocus, useSettingsFocus } from './settingsNavigation';

it.each(['api', 'support'] as const)('consumes %s focus before mount once and handles repeat navigation without resetting a draft', async target => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function ApiSection() {
    const [expanded, setExpanded] = useState(false), [count, setCount] = useState(0);
    useSettingsFocus(target, () => { setExpanded(true); setCount(value => value + 1); });
    return React.createElement('section', { 'data-count': count }, expanded && React.createElement('input', { defaultValue: 'draft' }));
  }
  try {
    requestSettingsFocus(target);
    await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(ApiSection))));
    expect(host.querySelector('section')?.dataset.count).toBe('1');
    const input = host.querySelector('input')!; input.value = 'unsaved';
    await act(async () => requestSettingsFocus(target));
    expect(host.querySelector('input')).toBe(input); expect(input.value).toBe('unsaved');
    expect(host.querySelector('section')?.dataset.count).toBe('2');
    await act(async () => root.render(null));
    await act(async () => root.render(React.createElement(ApiSection)));
    expect(host.querySelector('input')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

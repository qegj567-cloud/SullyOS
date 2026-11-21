// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { CompanionDebugPanel } from '../../components/companion/CompanionDebugPanel';
import { CompanionDebugStore } from './debug';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('expands exact prompts, selects interrupted turns and keeps the trace when collapsed', async () => {
  const store = new CompanionDebugStore(), first = new AbortController();
  const trace = store.start(first.signal, '这件怎么样');
  trace.begin('quick_request');
  trace.request('quick', JSON.stringify({ model: 'same-model', stream: true, messages: [
    { role: 'system', content: '<不要渲染成 HTML>\n完整提示词' }, { role: 'user', content: '这件怎么样' },
  ] }));
  trace.responseHeaders('quick', { status: 524, streaming: false });
  first.abort();
  const second = store.start(new AbortController().signal, '我是说旁边的'); second.finish('done');
  const host = document.createElement('div'), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(React.createElement(CompanionDebugPanel, { store })));
    const panel = host.querySelector('details')!;
    expect(host.textContent).not.toContain('完整提示词');
    await act(async () => { panel.open = true; panel.dispatchEvent(new Event('toggle')); });
    const select = host.querySelector('select')!;
    await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).toContain('已打断');
    expect(host.textContent).toContain('system'); expect(host.textContent).toContain('same-model');
    expect(host.textContent).toContain('HTTP 524'); expect(host.textContent).toContain('KiB');
    expect(host.textContent).toContain('不是 Token 数');
    expect(host.querySelector('pre')?.textContent).toBe('<不要渲染成 HTML>\n完整提示词');
    expect(host.textContent).toContain('长回复 a′：尚未提交请求');
    await act(async () => { panel.open = false; panel.dispatchEvent(new Event('toggle')); });
    expect(store.getSnapshot()).toHaveLength(2);
    expect(store.getSnapshot()[0].status).toBe('cancelled');
  } finally { act(() => root.unmount()); host.remove(); }
});

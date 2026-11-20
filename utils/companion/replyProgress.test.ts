// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { CompanionDebugStore } from './debug';
import { CompanionReplyProgress } from '../../components/companion/CompanionReplyProgress';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('shows concurrent recall, actual full generation, queued playback and cancellation without opening debug', async () => {
  const host = document.createElement('div'), root = createRoot(host), store = new CompanionDebugStore();
  const controller = new AbortController();
  const trace = store.start(controller.signal, '这件怎么样');
  trace.begin('quick_request'); trace.begin('full_prepare'); trace.begin('memory');
  await act(async () => root.render(React.createElement(CompanionReplyProgress, { store })));
  const quick = () => host.querySelector('[data-phase=quick]')!.textContent;
  const full = () => host.querySelector('[data-phase=full]')!.textContent;
  expect(quick()).toContain('正在生成'); expect(full()).toContain('正在召回记忆，尚未开始生成');
  await act(async () => { trace.end('quick_request'); trace.deliveryStart('quick', 'audio'); trace.end('memory'); trace.end('full_prepare'); trace.begin('full_request'); });
  expect(quick()).toContain('正在播放'); expect(full()).toContain('正在生成');
  await act(async () => trace.end('full_request'));
  expect(full()).toContain('已生成，等待 a 播完');
  await act(async () => controller.abort());
  expect(quick()).toContain('已打断'); expect(full()).toContain('已打断'); expect(host.textContent).not.toContain('正在生成');
  await act(async () => {
    const next = store.start(new AbortController().signal, '下一轮'); next.begin('quick_request'); next.begin('full_prepare');
    trace.deliveryStart('full', 'audio'); // Late old-turn event must not revive its UI.
  });
  expect(quick()).toContain('正在生成'); expect(full()).toContain('尚未开始生成');
  await act(async () => store.clear()); expect(host.textContent).toBe('');
  await act(async () => root.unmount());
});

it('shows failed a audio separately while a′ is still generating', async () => {
  const host = document.createElement('div'), root = createRoot(host), store = new CompanionDebugStore();
  const trace = store.start(new AbortController().signal, 'A');
  trace.begin('quick_tts'); trace.deliveryFailed('quick'); trace.begin('full_request');
  await act(async () => root.render(React.createElement(CompanionReplyProgress, { store })));
  expect(host.querySelector('[data-phase=quick]')!.textContent).toContain('语音失败，正文已展示');
  expect(host.querySelector('[data-phase=full]')!.textContent).toContain('正在生成');
  await act(async () => root.unmount());
});

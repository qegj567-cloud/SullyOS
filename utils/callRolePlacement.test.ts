// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import Stage from '../components/call/VRMVideoCallStage';
import { createBuiltinSullyLive2DConfig } from './builtinSullyLive2D';
import type { AvatarTouchRequest } from './avatarTouch';

const { canvas } = vi.hoisted(() => ({ canvas: vi.fn() }));
vi.mock('../components/call/Live2DAvatarCanvas', () => ({ default: (props: unknown) => { canvas(props); return null; } }));

it('hit-tests a transformed video-call model in model space and displays its feedback under the finger', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const hit = vi.fn(), save = vi.fn();
  try {
    await act(async () => root.render(React.createElement(Stage, {
      characterName: '示例', motionState: 'idle', accentColor: '#fff', model: createBuiltinSullyLive2DConfig(),
      onAvatarTouch: hit, rolePlacement: { value: { x: 10, y: 5, scale: 2, angle: 90 }, save },
    })));
    const layer = host.querySelector<HTMLElement>('.call-placement-content')!;
    const stage = layer.parentElement!.parentElement!;
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 400, height: 600 } as DOMRect);
    for (const type of ['pointerdown', 'pointerup']) {
      await act(async () => layer.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, clientX: 250, clientY: 290 }), { pointerId: 1, pointerType: 'touch' })));
    }
    const props = canvas.mock.lastCall![0];
    const request: AvatarTouchRequest = props.touchRequest;
    expect(request.x).toBeCloseTo(170);
    expect(request.y).toBeCloseTo(300);
    props.onAvatarTouch({ ...request, zone: 'head' });
    expect(hit).toHaveBeenCalledWith(expect.objectContaining({ normalizedX: 0.6, normalizedY: 0.45, zone: 'head' }));
    expect(save).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

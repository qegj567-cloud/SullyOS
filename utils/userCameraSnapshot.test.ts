import { describe, expect, it, vi } from 'vitest';
import { ContextBuilder } from './context';
import type { CharacterProfile, UserProfile, WorldbookDepthRole } from '../types';
import {
  attachSnapshotToLatestUserMessage,
  fitUserCameraSnapshot,
  isVisionInputUnsupportedError,
  prepareUserCameraSnapshot,
} from './userCameraSnapshot';

describe('user camera snapshot', () => {
  it('fits a frame without enlarging it', () => {
    expect(fitUserCameraSnapshot(1920, 1080, 640)).toEqual({ width: 640, height: 360 });
    expect(fitUserCameraSnapshot(320, 480, 640)).toEqual({ width: 320, height: 480 });
    expect(fitUserCameraSnapshot(0, 480, 640)).toBeNull();
  });

  it('attaches the image only to the latest user message', () => {
    const messages = [
      { role: 'user', content: '旧消息' },
      { role: 'assistant', content: '旧回复' },
      { role: 'user', content: '现在看我' },
    ];
    const result = attachSnapshotToLatestUserMessage(messages, 'data:image/jpeg;base64,AAAA');
    expect(result[0].content).toBe('旧消息');
    expect(result[2].content).toEqual([
      { type: 'text', text: '现在看我' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ]);
    expect(messages[2].content).toBe('现在看我');
  });

  it('only identifies explicit vision incompatibility errors', () => {
    expect(isVisionInputUnsupportedError(new Error('unknown variant `image_url`'))).toBe(true);
    expect(isVisionInputUnsupportedError(new Error('model does not support image input'))).toBe(true);
    expect(isVisionInputUnsupportedError(new Error('network timeout'))).toBe(false);
  });

  it.each([0, 1, 2] as WorldbookDepthRole[])('depth=0、role=%s 时快照仍附在用户输入上，文字降级保留同轮世界书', async role => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValue(0.9);
    try {
      const original = [{ role: 'assistant', content: '旧回复' }, { role: 'user', content: '看看这张照片' }];
      const snapshot = prepareUserCameraSnapshot(original, 'data:image/jpeg;base64,AAAA');
      const context = (await ContextBuilder.buildCharacterContext({
        scene: 'offline.call',
        char: {
          id: 'c', name: 'C', systemPrompt: '角色设定',
          mountedWorldbooks: [{ id: 'wb', title: '规则', content: '深度世界书', constant: true,
            position: 4, depth: 0, role, useProbability: true, probability: 50 }],
        } as CharacterProfile,
        user: { name: 'U' } as UserProfile,
        history: snapshot.messages,
      }));
      expect(context.history[1].content).toEqual([
        { type: 'text', text: '看看这张照片' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      ]);
      expect(context.history[2]).toEqual({ role: ['system', 'user', 'assistant'][role], content: '深度世界书' });
      const textOnly = snapshot.restoreTextMessages(context.history);
      expect(textOnly).toEqual([...original, context.history[2]]);
      expect(textOnly[2]).toBe(context.history[2]);
      expect(original[1].content).toBe('看看这张照片');
      expect(random).toHaveBeenCalledTimes(1);
    } finally { random.mockRestore(); }
  });
});

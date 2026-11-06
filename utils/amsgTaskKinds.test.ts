import { describe, expect, it } from 'vitest';
import { classifyTaskRow } from './amsgTaskKinds';

describe('classifyTaskRow', () => {
  it('只有 subtype（GET /messages 的列表投影）时按 subtype 分', () => {
    expect(classifyTaskRow({ messageSubtype: 'chat' })).toBe('scheduled');
    expect(classifyTaskRow({ messageSubtype: 'instant-chat' })).toBe('instant-chat');
    expect(classifyTaskRow({ messageSubtype: 'job' })).toBe('background-job');
    expect(classifyTaskRow({})).toBe('scheduled');
  });

  it('带 metadata 时以 metadata 为准', () => {
    expect(classifyTaskRow({ messageSubtype: 'chat', metadata: { amsgInstantChat: true } })).toBe('instant-chat');
    expect(classifyTaskRow({ messageSubtype: 'chat', metadata: { amsgKind: 'plate' } })).toBe('background-job');
    expect(classifyTaskRow({ messageSubtype: 'instant-chat', metadata: { charId: 'c' } })).toBe('instant-chat');
  });

  // 即时对话里自排的任务曾继承父任务的 'instant-chat'，被当成聊天行滤掉，角色看不见、取消不了。
  it('带自排标记的旧行即使挂着 instant-chat 也算定时任务', () => {
    expect(classifyTaskRow({
      messageSubtype: 'instant-chat',
      metadata: { charId: 'c', amsgSelfScheduled: true },
    })).toBe('scheduled');
  });
});

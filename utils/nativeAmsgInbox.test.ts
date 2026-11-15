import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveInboxMessage: vi.fn().mockResolvedValue(undefined),
  flushInboxToChat: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
  result: vi.fn().mockResolvedValue(true),
  spaces: vi.fn().mockReturnValue([]),
  getCharacter: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { saveInboxMessage: mocks.saveInboxMessage },
}));
vi.mock('./activeMsgRuntime', () => ({
  flushInboxToChat: mocks.flushInboxToChat,
  handleInstantErrorPushMessage: mocks.error,
}));
vi.mock('./amsgResults', () => ({ dispatchAmsgResult: mocks.result }));
vi.mock('./userSpaces', () => ({ listUserSpaces: mocks.spaces }));
vi.mock('./db', () => ({ DB: { getCharacter: mocks.getCharacter } }));

import { ingestNativeAmsgPayload, parseNativeAmsgPayload } from './nativeAmsgInbox';

describe('UnifiedPush payload 入库桥', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.saveInboxMessage.mockClear();
    mocks.flushInboxToChat.mockClear();
    mocks.result.mockReset().mockResolvedValue(true);
    mocks.error.mockClear();
    mocks.spaces.mockReturnValue([]);
  });

  it('接受对象或 JSON 字符串，拒绝无效内容', () => {
    expect(parseNativeAmsgPayload({ message: 'hi' })).toEqual({ message: 'hi' });
    expect(parseNativeAmsgPayload('{"message":"hi"}')).toEqual({ message: 'hi' });
    expect(parseNativeAmsgPayload('not-json')).toBeNull();
  });

  it('把标准 AMSG payload 交给现有 inbox 管线并按 messageId 去重', async () => {
    const payload = {
      messageId: 'msg-up-1',
      message: '该醒啦',
      contactName: '小明',
      timestamp: '2026-08-09T08:00:00.000Z',
      metadata: { charId: 'char-1', charName: '小明' },
    };

    await ingestNativeAmsgPayload(payload);
    await ingestNativeAmsgPayload(payload);

    expect(mocks.saveInboxMessage).toHaveBeenCalledTimes(1);
    expect(mocks.saveInboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'msg-up-1',
      charId: 'char-1',
      body: '该醒啦',
      sentAt: Date.parse('2026-08-09T08:00:00.000Z'),
    }));
    expect(mocks.flushInboxToChat).toHaveBeenCalledTimes(2);
  });

  it('并发重复收件只持久化一次，保留所有业务元数据和隐私预览', async () => {
    const payload = { messageId: 'race', message: '私密正文', notification: { body: '收到房间消息' },
      taskUuid: 'task', metadata: { charId: 'c', emotionRaw: 'raw', amsgKind: 'chat', thinkingChain: 'thought' } };
    await Promise.all([ingestNativeAmsgPayload(payload), ingestNativeAmsgPayload(JSON.stringify(payload))]);
    expect(mocks.saveInboxMessage).toHaveBeenCalledTimes(1);
    expect(mocks.saveInboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: '私密正文', previewBody: '收到房间消息', taskUuid: 'task',
      metadata: expect.objectContaining({ ...payload.metadata, nativeNotificationHandled: true }),
    }));
  });

  it.each([{ emotionStatus: 'done', emotionRaw: '' }, { emotionStatus: 'error', emotionError: 'failure' }])('情绪尾包不是正文：%j', async metadata => {
    await ingestNativeAmsgPayload({ messageKind: 'emotion_update', messageId: 'emotion', metadata: { charId: 'c', ...metadata } });
    expect(mocks.saveInboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: '', previewBody: '', messageType: 'emotion_update', metadata: expect.objectContaining(metadata),
    }));
  });

  it('result 交给 master 分发器，不伪装成聊天', async () => {
    const payload = { messageKind: 'result', charId: 'c', resultKind: 'assistant-actions', result: {} };
    await ingestNativeAmsgPayload(payload);
    expect(mocks.result).toHaveBeenCalledWith(payload);
    expect(mocks.saveInboxMessage).not.toHaveBeenCalled();
  });

  it('result 暂时不能接收时拒绝确认，下次仍能重试', async () => {
    mocks.result.mockResolvedValueOnce(false);
    const payload = { messageKind: 'result', resultKind: 'new-kind' };
    await expect(ingestNativeAmsgPayload(payload)).rejects.toThrow('retained');
    await ingestNativeAmsgPayload(payload);
    expect(mocks.result).toHaveBeenCalledTimes(2);
  });

  it('error 交给已有失败处理器，不成为助手气泡', async () => {
    const payload = { messageKind: 'error', metadata: { charId: 'c', taskUuid: 't', reason: 'failed' } };
    await ingestNativeAmsgPayload(payload);
    expect(mocks.error).toHaveBeenCalledWith(payload);
    expect(mocks.saveInboxMessage).not.toHaveBeenCalled();
  });

  it('其他空间错误留在原生队列，不误清当前空间状态', async () => {
    mocks.spaces.mockReturnValue([{ id: 'a' }, { id: 'b' }]);
    await expect(ingestNativeAmsgPayload({ messageKind: 'error', metadata: { charId: 'other' } })).rejects.toThrow('retained');
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each([[], '[]', { messageKind: 'reasoning' }, { messageKind: 'tools' }, { messageKind: '_multipart' }])('不把协议内部消息写进聊天：%j', async payload => {
    expect(await ingestNativeAmsgPayload(payload)).toBeNull();
    expect(mocks.saveInboxMessage).not.toHaveBeenCalled();
  });

  it('落库失败不记为已接收，成功落库后刷新失败可以继续处理', async () => {
    const payload = { messageId: 'retry', body: 'hi', metadata: { charId: 'c' } };
    mocks.saveInboxMessage.mockRejectedValueOnce(new Error('storage'));
    await expect(ingestNativeAmsgPayload(payload)).rejects.toThrow('storage');
    mocks.flushInboxToChat.mockRejectedValueOnce(new Error('flush'));
    await expect(ingestNativeAmsgPayload(payload)).rejects.toThrow('flush');
    await ingestNativeAmsgPayload(payload);
    expect(mocks.saveInboxMessage).toHaveBeenCalledTimes(2);
    expect(mocks.flushInboxToChat).toHaveBeenCalledTimes(2);
  });
});

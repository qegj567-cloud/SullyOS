import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../types';

const mocks = vi.hoisted(() => ({
  getGlobalConfig: vi.fn(),
  putCharLimits: vi.fn(),
  cancelAllTasksForChar: vi.fn(),
  upsertExpiredNotices: vi.fn(),
  purgeCharCloudState: vi.fn(),
  isInstantChatReady: vi.fn(),
}));

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    getGlobalConfig: mocks.getGlobalConfig,
    putCharLimits: mocks.putCharLimits,
    cancelAllTasksForChar: mocks.cancelAllTasksForChar,
  },
}));

vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    upsertExpiredNotices: mocks.upsertExpiredNotices,
  },
}));

vi.mock('./amsg2CharCleanup', () => ({
  disableScheduleCharPurge: (instantLive: boolean) => ({
    clientState: !instantLive,
    credPurposes: instantLive ? ['chat'] : ['chat', 'instant', 'emotion'],
    inFlightPlateJob: false,
  }),
  purgeCharCloudState: mocks.purgeCharCloudState,
}));

vi.mock('./amsgInstantChat', () => ({
  isInstantChatReady: mocks.isInstantChatReady,
}));

import {
  clearTimeAwarenessOverride,
  disableCharacterAmsg2Schedule,
  isChatTimeAwarenessOff,
  needsAmsg2TimeAwarenessOverride,
  shouldPromptDisableAmsg2OnTimeAwarenessOff,
} from './amsg2TimeAwarenessGate';

const makeChar = (extra: Partial<CharacterProfile> = {}): CharacterProfile => ({
  id: 'char-1',
  name: '小满',
  avatar: '',
  description: '',
  systemPrompt: '',
  memories: [],
  ...extra,
});

describe('amsg2TimeAwarenessGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGlobalConfig.mockResolvedValue({
      userId: 'u-1',
      workerUrl: 'https://worker.example.com',
      enabled: true,
      initializedAt: 1000,
    });
    mocks.isInstantChatReady.mockResolvedValue(false);
    mocks.putCharLimits.mockResolvedValue(undefined);
    mocks.cancelAllTasksForChar.mockResolvedValue({ targets: [], failed: new Set<string>() });
    mocks.upsertExpiredNotices.mockResolvedValue(undefined);
    mocks.purgeCharCloudState.mockResolvedValue({ status: 'cleared', keys: ['fire_pack'] });
  });

  it('开启时间感知（默认或显式 true）时不需要风险覆盖确认', () => {
    expect(isChatTimeAwarenessOff(makeChar())).toBe(false);
    expect(needsAmsg2TimeAwarenessOverride(makeChar())).toBe(false);
    expect(needsAmsg2TimeAwarenessOverride(makeChar({ timeAwarenessEnabled: true }))).toBe(false);
  });

  it('关闭聊天时间感知时默认拦截 2.0，显式确认 allowWithoutTimeAwareness 后放行', () => {
    const blocked = makeChar({
      timeAwarenessEnabled: false,
      activeMsg2Config: { enabled: false, tasks: [] },
    });
    expect(needsAmsg2TimeAwarenessOverride(blocked)).toBe(true);

    const overridden = makeChar({
      timeAwarenessEnabled: false,
      activeMsg2Config: { enabled: true, allowWithoutTimeAwareness: true, tasks: [] },
    });
    expect(needsAmsg2TimeAwarenessOverride(overridden)).toBe(false);
  });

  it('在神经链接关闭聊天时间感知时，仅当角色当前启用了主动消息 2.0 才弹窗提示停用', () => {
    expect(shouldPromptDisableAmsg2OnTimeAwarenessOff(makeChar({
      activeMsg2Config: { enabled: true, tasks: [] },
    }))).toBe(true);

    expect(shouldPromptDisableAmsg2OnTimeAwarenessOff(makeChar({
      activeMsg2Config: { enabled: false, tasks: [] },
    }))).toBe(false);

    expect(shouldPromptDisableAmsg2OnTimeAwarenessOff(makeChar())).toBe(false);

    // 已经处于关闭态再切回开启时不应弹停用框
    expect(shouldPromptDisableAmsg2OnTimeAwarenessOff(makeChar({
      timeAwarenessEnabled: false,
      activeMsg2Config: { enabled: true, allowWithoutTimeAwareness: true, tasks: [] },
    }))).toBe(false);
  });

  it('重新开启聊天时间感知时清除 allowWithoutTimeAwareness，保留其余排程配置', () => {
    const cleared = clearTimeAwarenessOverride({
      enabled: true,
      allowWithoutTimeAwareness: true,
      maxTokens: 150,
      tasks: [],
    });
    expect(cleared).toEqual({
      enabled: true,
      maxTokens: 150,
      tasks: [],
    });
    expect('allowWithoutTimeAwareness' in (cleared ?? {})).toBe(false);
  });

  it('停用角色 2.0 时先通知云端关闸、取消远端任务、清理状态并清除覆盖标记', async () => {
    const taskA = {
      taskUuid: 'uuid-a',
      clientTaskId: 'cid-a',
      mode: 'auto' as const,
      firstSendTime: new Date(Date.now() + 3600_000).toISOString(),
      recurrenceType: 'none' as const,
      expirePolicy: 'expire' as const,
      source: 'character' as const,
      status: 'scheduled' as const,
      createdAt: 1000,
    };
    const taskB = { ...taskA, taskUuid: 'uuid-b', clientTaskId: 'cid-b' };

    mocks.cancelAllTasksForChar.mockResolvedValue({
      targets: ['uuid-a', 'uuid-b'],
      failed: new Set(['uuid-b']),
    });

    const char = makeChar({
      timeAwarenessEnabled: false,
      activeMsg2Config: {
        enabled: true,
        allowWithoutTimeAwareness: true,
        maxUnansweredSends: 4,
        tasks: [taskA, taskB],
      },
    });

    const res = await disableCharacterAmsg2Schedule(char);
    expect(mocks.putCharLimits).toHaveBeenCalledTimes(1);
    expect(mocks.putCharLimits.mock.calls[0][0].activeMsg2Config.enabled).toBe(false);
    expect(mocks.cancelAllTasksForChar).toHaveBeenCalledWith('char-1', ['uuid-a', 'uuid-b']);
    expect(mocks.upsertExpiredNotices).toHaveBeenCalledTimes(1);
    expect(mocks.purgeCharCloudState).toHaveBeenCalledTimes(1);
    expect(res.failedCount).toBe(1);
    expect(res.toastType).toBe('error');

    const next = res.applyToConfig(char.activeMsg2Config);
    expect(next.enabled).toBe(false);
    expect(next.allowWithoutTimeAwareness).toBeUndefined();
    expect(next.maxUnansweredSends).toBe(4);
    // 已成功取消的 uuid-a 出列，远端取消失败的 uuid-b 保留在清单里避免变成幽灵任务
    expect(next.tasks?.map((t) => t.taskUuid)).toEqual(['uuid-b']);
    expect(next.tasks?.[0].lastError).toContain('远端取消失败');
  });

  it('全局总开关暂停时本机直接记录停用且清除覆盖标记，不向 Worker 发起清理请求', async () => {
    mocks.getGlobalConfig.mockResolvedValue({
      userId: 'u-1',
      workerUrl: 'https://worker.example.com',
      enabled: false,
      initializedAt: 1000,
    });

    const char = makeChar({
      timeAwarenessEnabled: false,
      activeMsg2Config: {
        enabled: true,
        allowWithoutTimeAwareness: true,
        tasks: [],
      },
    });

    const res = await disableCharacterAmsg2Schedule(char);
    expect(mocks.putCharLimits).not.toHaveBeenCalled();
    expect(mocks.cancelAllTasksForChar).not.toHaveBeenCalled();
    expect(mocks.purgeCharCloudState).not.toHaveBeenCalled();
    expect(res.globalPaused).toBe(true);

    const next = res.applyToConfig(char.activeMsg2Config);
    expect(next.enabled).toBe(false);
    expect(next.allowWithoutTimeAwareness).toBeUndefined();
  });

  it('主动消息 2.0 面板与神经链接角色页均接入时间感知互斥门禁', () => {
    const modal = readFileSync(
      fileURLToPath(new URL('../components/chat/ActiveMsg2SettingsModal.tsx', import.meta.url)),
      'utf8',
    );
    const charApp = readFileSync(
      fileURLToPath(new URL('../apps/Character.tsx', import.meta.url)),
      'utf8',
    );

    expect(modal).toMatch(/needsAmsg2TimeAwarenessOverride\(char\)/);
    expect(modal).toContain('我知道自己在做什么，仍然开启');
    expect(charApp).toMatch(/shouldPromptDisableAmsg2OnTimeAwarenessOff\(formData\)/);
    expect(charApp).toMatch(/onClick=\{handleToggleChatTimeAwareness\}/);
    expect(charApp).not.toMatch(/handleChange\('timeAwarenessEnabled',\s*formData\.timeAwarenessEnabled === false\)/);
    expect(charApp).toContain('我知道自己在做什么，保留 2.0');
  });
});

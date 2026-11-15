// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIConfig, CharacterProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import {
  PUSH_SUBSCRIPTION_CHANGED_KV_ID,
  catchUpMissedPushes,
  refreshPushSubscriptionIfMarked,
  runInstantChatStatusCheck,
  startLateEmotionPoll,
  sweepThirdPartyOutbox,
} from './activeMsgRuntime';
import { ActiveMsgStore, exportAmsg2GlobalConfig, importAmsg2GlobalConfig } from './activeMsgStore';
import { purgeCharCloudState } from './amsg2CharCleanup';
import { isAmsg2GlobalReady } from './amsg2ToolBridge';
import { requestStartupUpdateCheck } from './amsgAutoUpdateTrigger';
import { pendingCloudRetirements, retireCloudCharacter } from './amsgCloudRetirement';
import { isAmsg2GloballyEnabled, isAmsg2WorkerActive, isAmsgGlobalDisabledError } from './amsgGlobalGate';
import { setAmsg2GlobalEnabled } from './amsgGlobalSwitch';
import {
  listInstantChatPendings,
  resolveInstantChatReadiness,
  setInstantChatPending,
} from './amsgInstantChat';
import { findCloudOwnerConflicts } from './amsgOwnerReconcile';
import {
  AMSG2_PENDING_TOOL_CONFIG_LS_KEY,
  flushAmsgState,
  invalidateCharCloudState,
  markAmsgStateDirty,
  startAmsgChatPresence,
  stopAmsgChatPresence,
  syncAmsgLlmCredentials,
  syncAmsgToolConfig,
  wipeAmsgCloudDataForReset,
} from './amsgStateSync';
import { cancelCloudAwayTasks } from './awayMessage';
import { disarmDateLeaveReminder } from './dateLeaveReminder';

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const makeChar = (id = 'char-master-1'): CharacterProfile => ({
  id,
  name: '测试角色',
  avatar: '',
  description: '',
  systemPrompt: '你是测试角色',
  memories: [],
  activeMsg2Config: {
    enabled: true,
    tasks: [
      {
        taskUuid: 'task-1',
        clientTaskId: 'ct-1',
        mode: 'auto',
        firstSendTime: new Date(Date.now() + 60_000).toISOString(),
        recurrenceType: 'daily',
        source: 'user',
        status: 'scheduled',
        createdAt: Date.now(),
        awayMessage: true,
        dateLeave: true,
      },
    ],
  },
  dateLeaveReminder: { enabled: true, delayMinutes: 5 },
} as unknown as CharacterProfile);

const userProfile: UserProfile = {
  name: '测试用户',
  avatar: '',
  bio: '',
} as UserProfile;

const realtimeConfig: RealtimeConfig = {
  weatherEnabled: true,
  weatherApiKey: 'w-key',
  weatherCity: 'Tokyo',
  newsEnabled: false,
  notionEnabled: false,
  notionApiKey: '',
  notionDatabaseId: '',
  feishuEnabled: false,
  feishuAppId: '',
  feishuAppSecret: '',
  feishuBaseId: '',
  feishuTableId: '',
} as RealtimeConfig;

const apiConfig: APIConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-key',
  model: 'gpt-4o-mini',
};

describe('主动消息 2.0 全局总开关（amsgGlobalSwitch）', () => {
  let fetchSpy: { mockRejectedValue: (err: unknown) => void; mockClear: () => void };

  beforeEach(async () => {
    localStorage.clear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network fetch'));
    await ActiveMsgStore.saveGlobalConfig({
      enabled: true,
      workerUrl: 'https://amsg-test.workers.dev',
      serverToken: 'srv-token-keep',
      masterKey: 'dGVzdC1tYXN0ZXIta2V5LTMzLWJ5dGVzLWxvbmctenp6',
      useRelay: true,
      relayToken: 'rly_test_token',
      pushMode: 'third-party',
      thirdPartyPush: { provider: 'wxpusher', token: 'AT_xxx|UID_yyy' },
      instantChatEnabled: true,
      initializedAt: 1_700_000_000_000,
    });
    ActiveMsgClient.resetSessionCache();
  });

  afterEach(() => {
    stopAmsgChatPresence('char-master-1');
    vi.restoreAllMocks();
  });

  it('关闭总开关：保留全部连接配置、清掉本机在途等待，Worker 失联也不阻塞或抛错', async () => {
    setInstantChatPending('char-master-1', 'pending-uuid-1', Date.now(), '测试角色');
    expect(listInstantChatPendings()).toHaveLength(1);

    // 模拟已删/断连 Worker：取消与暂停 Cron 请求全部网络失败
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    const res = await setAmsg2GlobalEnabled(false);
    expect(res.enabled).toBe(false);
    expect(res.cronPaused).toBe(false);
    expect(res.cronNotice).toContain('本机已暂停所有云端连接');

    // 在途即时对话等待已在本地销账
    expect(listInstantChatPendings()).toEqual([]);

    // 已存连接配置、密钥、中转、第三方推送全部原样保留，仅 enabled 变为 false
    const saved = await ActiveMsgStore.getGlobalConfig();
    expect(saved.enabled).toBe(false);
    expect(isAmsg2GloballyEnabled(saved)).toBe(false);
    expect(isAmsg2WorkerActive(saved)).toBe(false);
    expect(saved.workerUrl).toBe('https://amsg-test.workers.dev');
    expect(saved.serverToken).toBe('srv-token-keep');
    expect(saved.masterKey).toBe('dGVzdC1tYXN0ZXIta2V5LTMzLWJ5dGVzLWxvbmctenp6');
    expect(saved.useRelay).toBe(true);
    expect(saved.relayToken).toBe('rly_test_token');
    expect(saved.pushMode).toBe('third-party');
    expect(saved.thirdPartyPush?.token).toBe('AT_xxx|UID_yyy');
    expect(saved.initializedAt).toBe(1_700_000_000_000);
  });

  it('总开关处于关闭态时：冷启动、前台轮询、状态同步、清理与聊天路由全部零网络请求', async () => {
    await ActiveMsgStore.saveGlobalConfig({ enabled: false });
    ActiveMsgClient.resetSessionCache();
    fetchSpy.mockClear();

    const char = makeChar();

    // 1. 底层客户端硬闸直接挡在发请求之前
    await expect(ActiveMsgClient.listAllTasks()).rejects.toSatisfy(isAmsgGlobalDisabledError);
    await expect(ActiveMsgClient.openCloudDataSession()).rejects.toSatisfy(isAmsgGlobalDisabledError);

    // 2. 工具桥 / 即时对话就绪门禁返回关闭
    expect(await isAmsg2GlobalReady()).toBe(false);
    expect(await resolveInstantChatReadiness(char)).toEqual({ ready: false, reason: 'disabled' });

    // 3. 运行时启动 / 回前台 / 第三方轮询 / 状态检查 / 自动更新 / owner 对账
    expect(await catchUpMissedPushes('startup')).toBe('worker-unset');
    expect(await catchUpMissedPushes('foreground')).toBe('worker-unset');
    expect(await sweepThirdPartyOutbox()).toBe(false);
    await runInstantChatStatusCheck();
    expect(await requestStartupUpdateCheck(Date.now(), 'build-new')).toBe('worker-unset');
    expect(await findCloudOwnerConflicts([{ id: char.id, name: char.name }])).toEqual([]);

    // 订阅变化标记保留，不打网络请求
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('ActiveMsg');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ id: PUSH_SUBSCRIPTION_CHANGED_KV_ID, at: Date.now() });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      req.onerror = () => reject(req.error);
    });
    expect(await refreshPushSubscriptionIfMarked()).toBe('kept');

    // 晚投情绪轮询在暂停态下立即收尾，不读云端
    vi.useFakeTimers();
    try {
      startLateEmotionPoll(char.id, 'emo-ref', char.name, { intervalMs: 50, maxTries: 2 });
      await vi.advanceTimersByTimeAsync(150);
    } finally {
      vi.useRealTimers();
    }

    // 4. 状态同步 / 工具凭据 / LLM 凭据 / 活跃租约 / 清历史失效 / 重置清云端
    markAmsgStateDirty({ char, userProfile, groups: [], realtimeConfig });
    await flushAmsgState('test-paused');
    syncAmsgToolConfig(realtimeConfig);
    syncAmsgLlmCredentials(apiConfig);
    // 等微任务跑完，确认异步队列在暂停门前停住，且待传标记保留给恢复时使用
    await new Promise((r) => setTimeout(r, 30));
    expect(localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY)).toBe('1');

    startAmsgChatPresence(char.id, null);
    await new Promise((r) => setTimeout(r, 20));
    stopAmsgChatPresence(char.id);

    await invalidateCharCloudState(char.id);
    expect(await purgeCharCloudState(char)).toEqual({ status: 'skipped' });
    expect(await wipeAmsgCloudDataForReset()).toEqual({ status: 'skipped' });
    await cancelCloudAwayTasks(char, vi.fn());
    await disarmDateLeaveReminder({ char, updateCharacter: vi.fn() });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('暂停期间删除角色记入本地待停用底账且不发请求，重新开启总开关后自动补送', async () => {
    await ActiveMsgStore.saveGlobalConfig({ enabled: false });
    ActiveMsgClient.resetSessionCache();
    fetchSpy.mockClear();

    const globalBefore = await ActiveMsgStore.getGlobalConfig();
    // 同时覆盖无 expectedConnection（单角色删除）与带 expectedConnection（deleteUserSpace 用户空间删除）两条路径
    const resWhilePaused = await retireCloudCharacter({ id: 'char-retired-1', name: '待停用角色' });
    const resSpaceWhilePaused = await retireCloudCharacter(
      { id: 'char-retired-space', name: '空间待停用角色' },
      { workerUrl: globalBefore.workerUrl, userId: globalBefore.userId },
    );
    expect(resWhilePaused).toEqual({ status: 'skipped' });
    expect(resSpaceWhilePaused).toEqual({ status: 'skipped' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pendingCloudRetirements({
      workerUrl: globalBefore.workerUrl,
      userId: globalBefore.userId,
    })).toEqual([
      { id: 'char-retired-1', name: '待停用角色' },
      { id: 'char-retired-space', name: '空间待停用角色' },
    ]);

    // 重新打开总开关：恢复 Cron 并触发待停用角色对账补送
    const openSessionSpy = vi.spyOn(ActiveMsgClient, 'openCloudDataSession').mockResolvedValue({
      workerUrl: globalBefore.workerUrl,
      userId: globalBefore.userId,
      getOwner: vi.fn()
        .mockResolvedValueOnce({ owner: { type: 'character', id: 'char-retired-1' }, retired: false, generation: 1, complete: true, gaps: [] })
        .mockResolvedValueOnce({ owner: { type: 'character', id: 'char-retired-1' }, retired: true, generation: 2, complete: true, gaps: [] })
        .mockResolvedValueOnce({ owner: { type: 'character', id: 'char-retired-space' }, retired: false, generation: 1, complete: true, gaps: [] })
        .mockResolvedValueOnce({ owner: { type: 'character', id: 'char-retired-space' }, retired: true, generation: 2, complete: true, gaps: [] }),
      prepare: vi.fn().mockResolvedValue({
        id: 'plan-1',
        mode: 'retire-owner',
        expiresAt: Date.now() + 60_000,
        count: 1,
        counts: [],
        resources: [],
        impacts: [],
        complete: true,
        gaps: [],
      }),
      start: vi.fn().mockResolvedValue({
        id: 'op-1',
        planId: 'plan-1',
        status: 'completed',
        counts: [],
        errors: [],
      }),
      listOperations: vi.fn(),
      listOwners: vi.fn(),
      listResources: vi.fn(),
      restoreOwner: vi.fn(),
      getOperation: vi.fn(),
    } as any);
    vi.spyOn(ActiveMsgClient, 'setCronTriggerEnabled').mockResolvedValue({ ok: true, message: 'ok' });

    const toggleOn = await setAmsg2GlobalEnabled(true);
    expect(toggleOn.enabled).toBe(true);
    await new Promise((r) => setTimeout(r, 40));

    expect(openSessionSpy).toHaveBeenCalled();
    expect(pendingCloudRetirements({
      workerUrl: globalBefore.workerUrl,
      userId: globalBefore.userId,
    })).toEqual([]);
  });

  it('若用户原本已在高级面板手动暂停了后台任务，开关总开关不会误将其恢复', async () => {
    vi.spyOn(ActiveMsgClient, 'getCronTriggerState').mockResolvedValue({
      supported: true,
      enabled: false,
    });
    const setCronSpy = vi.spyOn(ActiveMsgClient, 'setCronTriggerEnabled').mockResolvedValue({
      ok: true,
      message: 'ok',
    });

    const offRes = await setAmsg2GlobalEnabled(false);
    expect(offRes).toEqual({ enabled: false, cronPaused: true });
    expect(setCronSpy).not.toHaveBeenCalled();

    const onRes = await setAmsg2GlobalEnabled(true);
    expect(onRes.enabled).toBe(true);
    expect(setCronSpy).not.toHaveBeenCalled();
  });

  it('备份导出与导入：不含后端连接的分享包不携带 enabled:false，还原开启态备份可恢复开启', async () => {
    await ActiveMsgStore.saveGlobalConfig({ enabled: false, instantChatEnabled: false });

    // 导出分享备份（不含后端连接）时摘除 enabled，防止覆盖接收方自己的总开关
    const sharedPack = await exportAmsg2GlobalConfig({ includeBackendConnection: false });
    expect(sharedPack?.enabled).toBeUndefined();
    expect(sharedPack?.instantChatEnabled).toBe(false);

    // 接收方当前开启，导入他人的含连接备份但拒绝还原连接（allowBackendConnection: false），本机仍保持开启
    await ActiveMsgStore.saveGlobalConfig({ enabled: true, instantChatEnabled: true });
    await importAmsg2GlobalConfig(
      { userId: 'other-u', workerUrl: 'https://other.workers.dev', enabled: false, instantChatEnabled: false },
      { allowBackendConnection: false },
    );
    const afterRejectConn = await ActiveMsgStore.getGlobalConfig();
    expect(afterRejectConn.enabled).toBe(true);
    expect(afterRejectConn.instantChatEnabled).toBe(false);

    // 本机处于暂停态，恢复自己以前的开启态备份（enabled 缺省）且允许还原连接时，自动恢复为开启
    await ActiveMsgStore.saveGlobalConfig({ enabled: false });
    await importAmsg2GlobalConfig(
      { userId: 'self-u', workerUrl: 'https://amsg-test.workers.dev', serverToken: 'tok' },
      { allowBackendConnection: true },
    );
    const afterRestoreConn = await ActiveMsgStore.getGlobalConfig();
    expect(afterRestoreConn.enabled).toBe(true);
  });

  it('源码接线守卫：关键入口均接入全局总开关门禁且不触犯角色开关正则禁区', () => {
    const pushPanelSrc = readSrc('../components/settings/PushSubscriptionPanel.tsx');
    expect(pushPanelSrc).toContain('isAmsg2WorkerActive(config)');
    expect(pushPanelSrc).toContain('AMSG_GLOBAL_CONFIG_EVENT');

    const cloudModalSrc = readSrc('../components/settings/AmsgCloudDataModal.tsx');
    expect(cloudModalSrc).toContain('isAmsg2GloballyEnabled(globalConfig)');
    expect(cloudModalSrc).toContain('AMSG_GLOBAL_CONFIG_EVENT');

    const charModalSrc = readSrc('../components/chat/ActiveMsg2SettingsModal.tsx');
    expect(charModalSrc).toContain('isAmsg2WorkerActive(globalConfig)');
    expect(charModalSrc).not.toMatch(/\benabled\s*===\s*false|\benabled\s*!==\s*false|\benabled\s*\?\?/);

    const settingsSrc = readSrc('../apps/Settings.tsx');
    expect(settingsSrc).toContain('setAmsg2GlobalEnabled(');
    expect(settingsSrc).toContain('flushMcpToolConfigSync()');

    const dateSrc = readSrc('../apps/DateApp.tsx');
    expect(dateSrc).toContain('AMSG_GLOBAL_CONFIG_EVENT');
    expect(dateSrc).toContain('amsgGlobalEnabled');

    const osSrc = readSrc('../context/OSContext.tsx');
    expect(osSrc).toContain('isAmsg2WorkerActive(');
    expect(osSrc).toContain('isAmsg2GloballyEnabled(');
  });
});

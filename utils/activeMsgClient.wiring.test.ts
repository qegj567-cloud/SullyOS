// amsg2 订阅自检 / 凭据重传 / 失败可见化的接线守卫。
//
// 仓库的 vitest 是纯 Node 环境（没装 jsdom），Settings / 两个设置弹窗这些 React 组件
// 没法真渲染起来测行为，这里沿用 amsgStateSync.wiring.test.ts 的做法做**源码级**断言：
// 把「保存 API 后面跟着凭据重传」「面板保存后刷其余任务凭据」「SW 订阅变化标记与主线程
// 消费两头 key 一致」这些接线钉住，谁把调用删了这里就红。它验证不了运行时时序，
// 只防「接线被误删」这一种回归——补上组件测试基建后应该换成真正的行为测试。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 取 [start, end) 之间的源码片段；找不到锚点直接让断言失败。 */
const sliceBetween = (src: string, start: string, end: string): string => {
  const i = src.indexOf(start);
  expect(i, `找不到锚点: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `找不到结束锚点: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};

describe('③ 凭据变更重传接线', () => {
  it('Settings.commitApiConfig：换了聊天 API 就触发已排程任务的凭据重传', () => {
    const src = read('../apps/Settings.tsx');
    // 保存按钮和点预设切换共用 commitApiConfig 这一个出口。
    const fn = sliceBetween(src, 'const commitApiConfig', 'const applyPreset');
    expect(fn).toContain('syncAmsgLlmCredentials(');
    // 传的是「这次要换过去的配置」叠在 apiConfig 上，而不是渲染时的旧快照。
    const call = fn.match(/syncAmsgLlmCredentials\(\{ \.\.\.apiConfig, \.\.\.(\w+) \}\)/);
    expect(call, '凭据重传要把新配置叠在 apiConfig 上一起传').not.toBeNull();
    expect(fn, '叠上去的得是这次切换现组的那份').toContain(`const commitApiConfig = (${call![1]}:`);
    // 两个入口递进去的都是现组的配置对象，不是旧的 localXxx 草稿
    expect(sliceBetween(src, 'const handleSaveApi', 'const handleSaveVisionApi'))
      .toMatch(/const nextConfig = \{[\s\S]*commitApiConfig\(nextConfig\)/);
    expect(sliceBetween(src, 'const applyPreset', 'const openEditPreset'))
      .toContain('commitApiConfig(configFromPreset(preset))');
  });

  it('ActiveMsg2SettingsModal.handleSubmit：面板保存后刷同角色其余 pending AI 任务', () => {
    const src = read('../components/chat/ActiveMsg2SettingsModal.tsx');
    const fn = sliceBetween(src, 'const handleSubmit', 'return (');
    expect(fn).toContain('ActiveMsgClient.refreshCharPendingAiTaskCredentials(');
    // 刚排的这条（result.uuid）与被替换的旧条都要摘掉，别对着它们重复 PUT。
    expect(fn).toContain('t.taskUuid !== result.uuid');
    expect(fn).toContain('t.taskUuid !== editingTaskUuid');
  });
});

describe('③ 失败可见化接线（远端 lastError 上卡片）', () => {
  it('面板对账改拉全量投影 listRemoteTasksForChar，并用 describeRemoteLastError 渲染', () => {
    const src = read('../components/chat/ActiveMsg2SettingsModal.tsx');
    expect(src).toContain('ActiveMsgClient.listRemoteTasksForChar(');
    expect(src).toContain('describeRemoteLastError(');
    // 进度文案吸收远端 status（failed 终态不再谎报「待处理」）。
    expect(src).toMatch(/describeTaskProgress\(t, knownRemoteUuids, now, remoteInfo\?\.status\)/);
  });
});

describe('② 订阅刷新接线（SW 标记 ↔ 主线程消费）', () => {
  it('SW：pushsubscriptionchange 监听 + 往 kv store 写标记 + 通知页面', () => {
    const src = read('../worker/sw-keep-alive.ts');
    expect(src).toContain("addEventListener('pushsubscriptionchange'");
    const listener = sliceBetween(src, "addEventListener('pushsubscriptionchange'", 'notificationclick');
    expect(listener).toContain('PUSH_SUBSCRIPTION_CHANGED_KV_ID');
    expect(listener).toContain("withInboxTx(ACTIVE_MSG_KV_STORE, 'readwrite'");
    expect(listener).toContain("notifyClients({ type: 'active-msg-subscription-change'");
    // SW-first 安装也要有 kv store 可写（onupgradeneeded 补建）。
    expect(src).toMatch(/objectStoreNames\.contains\(ACTIVE_MSG_KV_STORE\)/);
  });

  it('SW 与主线程的标记 key 必须一字不差（两个文件各自持有一份常量）', () => {
    const swSrc = read('../worker/sw-keep-alive.ts');
    const runtimeSrc = read('./activeMsgRuntime.ts');
    const pickKey = (src: string) => {
      const m = /PUSH_SUBSCRIPTION_CHANGED_KV_ID = '([^']+)'/.exec(src);
      expect(m, '找不到 PUSH_SUBSCRIPTION_CHANGED_KV_ID 常量').toBeTruthy();
      return m![1];
    };
    expect(pickKey(swSrc)).toBe(pickKey(runtimeSrc));
  });

  it('主线程：启动兜底 + SW 通知两条路都消费标记', () => {
    const src = read('./activeMsgRuntime.ts');
    const init = sliceBetween(src, 'export const ActiveMsgRuntime', 'handleDeepLink();');
    // 启动路径 fire-and-forget 一次
    expect(init).toContain('void refreshPushSubscriptionIfMarked()');
    // SW postMessage（页面开着时立即处理）
    expect(init).toContain("type === 'active-msg-subscription-change'");
  });
});

describe('④ 多设备说明文案', () => {
  it('全局设置弹窗的通知区块里说明「换设备要重新开启，会覆盖原来的订阅」', () => {
    const src = read('../components/settings/ActiveMsgGlobalSettingsModal.tsx');
    expect(src).toContain('换了设备或浏览器');
    expect(src).toContain('会覆盖原来的订阅');
  });
});

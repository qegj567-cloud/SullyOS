// amsg2 打脏入口 & 删角色阻塞的接线守卫。
//
// 仓库的 vitest 是纯 Node 环境（没装 jsdom），OSContext / Chat / Character 这些 React
// 组件没法真渲染起来测行为，这里退而求其次做**源码级**断言：把「保存路径后面跟着
// markAmsgStateDirty」「删角色会被云端清理失败拦下」这几处接线钉住，谁把调用删了
// 这里就红。它验证不了运行时时序，只防「接线被误删」这一种回归——补上组件测试基建
// 后应该换成真正的行为测试。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');

/** 取 [start, end) 之间的源码片段；找不到锚点直接让断言失败。 */
const sliceBetween = (src: string, start: string, end: string): string => {
  const i = src.indexOf(start);
  expect(i, `找不到锚点: ${start}`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `找不到结束锚点: ${end}`).toBeGreaterThan(-1);
  return src.slice(i, j);
};

describe('打脏入口接线（保存后调 markAmsgStateDirty）', () => {
  it('OSContext.updateCharacter：落库成功后打脏（改人设/改记忆/面板取消任务的汇合点）', () => {
    const src = read('../context/OSContext.tsx');
    const fn = sliceBetween(src, 'const updateCharacter = async', 'const deleteCharacter');
    // 时序也要钉住：是「落库成功后」（saveCharacter 的 then 里），不是随手同步调一下。
    expect(fn).toMatch(/DB\.saveCharacter\(target\)\.then\([\s\S]*?markAmsgStateDirty\(/);
  });

  it('Chat：删除 / 编辑 / 清空消息路径都打脏', () => {
    const src = read('../apps/Chat.tsx');
    for (const [start, end] of [
      ['const handleDeleteMessage', 'const confirmEditMessage'],
      ['const confirmEditMessage', 'const handleQuickReply'],
      ['const handleHistoryCleanupDone', '// 只在打开聊天设置时计算一键存入'],
      ['const handleReroll', 'const handleImageSelect'],
    ] as const) {
      expect(sliceBetween(src, start, end), `${start} 里少了打脏调用`).toContain('markAmsgStateDirty(');
    }
  });

  it('OSContext 启动路径接了底账补传 resumePendingAmsgStateSync', () => {
    expect(read('../context/OSContext.tsx')).toContain('resumePendingAmsgStateSync({');
  });
});

// 换 Key 之后云端那几行凭据不重传的话，已排程的任务到点全部 401，而界面上一切正常。
// 保存配置那两处是它唯一的触发点，接线被删就没人补了。
describe('LLM 凭据行的重传接线', () => {
  it('设置页换聊天 API：通过同步队列更新凭据与存量任务', () => {
    const src = read('../apps/Settings.tsx');
    // 主对话 ApiSlotEditor 的自动提交统一汇到 commitApiConfig 这一个出口，凭据接线挂在它身上。
    const fn = sliceBetween(src, 'const commitApiConfig', 'const applyPreset');
    expect(fn).toContain('syncAmsgLlmCredentials(');
    expect(read('./amsgStateSync.ts')).toContain('ActiveMsgClient.refreshApiCredentialsForPendingTasks(');
    expect(sliceBetween(src, 'slotName="主对话"', 'slotName="独立识图"')).toContain('commitApiConfig(');
  });

  it('角色 2.0 面板保存：也同步一次主 API', () => {
    expect(read('../components/chat/ActiveMsg2SettingsModal.tsx')).toContain('syncAmsgLlmCredentials(');
  });

  it('启动补传把 apiConfig 也递进去（缺了它凭据那一项永远补不上）', () => {
    const src = read('../context/OSContext.tsx');
    const call = sliceBetween(src, 'resumePendingAmsgStateSync({', '});');
    expect(call).toContain('apiConfig:');
  });

  it('删角色时连它名下那几行凭据一起清（keys 是 API Key，不能留在云端）', () => {
    const src = read('./amsg2CharCleanup.ts');
    // 清单由调用方给，这里钉的是「删角色那份清单是全量的」——少一种用途，
    // 就有一行 API Key 留在云端没人再清。
    expect(src).toContain('credPurposes: ALL_CREDENTIAL_PURPOSES');
    expect(src).toContain('deleteLlmCredentials({ credIds })');
  });
});

// 「更新 Worker」之后必须跑一次 init-tenant：新版后端带了新表（这一波是 llm_credentials），
// 而建表只在那个端点里做。少了它，代码是新的、表还是旧的，cron 每分钟静默失败。
describe('更新 Worker 之后的自动验证', () => {
  it('自更新成功后接着 connect()（POST /init-tenant，新表在这一步建出来）', () => {
    const src = read('../components/settings/ActiveMsgGlobalSettingsModal.tsx');
    const fn = sliceBetween(src, 'const handleSelfUpdateWorker', 'const handleAttachUpdateKey');
    expect(fn).toContain('await ActiveMsgClient.connect()');
    expect(fn, '验证没过要单独说，别把「代码换上了」和「表补齐了」混成一句').toContain('重新连接并验证');
  });
});

describe('删角色阻塞接线（云端任务清不掉先不删本地）', () => {
  it('deleteCharacter：await 云端清理、失败返回 cloud-cleanup-failed', () => {
    const src = read('../context/OSContext.tsx');
    const fn = sliceBetween(src, 'const deleteCharacter = async', 'const createCharacterGroup');
    expect(fn).toContain('await ActiveMsgClient.cancelAllTasksForChar(');
    expect(fn).toContain("return { status: 'cloud-cleanup-failed' }");
    // 旧实现的「void (async () => { cancelAllTasksForChar ... })()」整段后台化是这次
    // 修的病根；只允许 force（仍然删除）和无任务两条路走后台。
    expect(fn).toContain("options?.force");
  });

  it('角色 App 对 cloud-cleanup-failed 弹「重试 / 仍然删除」', () => {
    const src = read('../apps/Character.tsx');
    expect(src).toContain("cloud-cleanup-failed");
    expect(src).toContain('仍然删除');
    expect(src).toMatch(/runDeleteCharacter\(cloudCleanupFailTarget, true\)/);
  });
});

// 「设置 → API 槽位与预设引用联动」的接线守卫。
//
// 验证主对话 API、独立识图 API、预设编辑弹窗与云端凭据同步的关键接线没有退化：
// 1. 设置页主对话与独立识图均复用统一的 ApiSlotEditor，不再维护易打架的手写草稿；
// 2. 主对话槽位 onCommit 统一走 commitApiConfig，确保主动消息 2.0 云端凭据同步触发；
// 3. 预设编辑器复用 DialogueApiFields + ModelPicker（支持拉模型与 Anthropic 温度限幅）；
// 4. OSContext.updateApiPreset 同步刷新全局槽位与跨空间预设快照并排入云端凭据同步。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const settings = read('../apps/Settings.tsx');
const slotEditor = read('../components/settings/ApiSlotEditor.tsx');
const presetEditor = read('../components/settings/ApiPresetEditorModal.tsx');
const modelPicker = read('../components/settings/ModelPicker.tsx');
const osContext = read('../context/OSContext.tsx');
const stateSync = read('./amsgStateSync.ts');

describe('设置页主对话与独立识图统一复用 ApiSlotEditor', () => {
  it('两个页签均挂载标准 ApiSlotEditor，且废弃旧版存回预设二次询问弹窗', () => {
    expect(settings).toContain('slotName="主对话"');
    expect(settings).toContain('slotName="独立识图"');
    expect(settings).not.toContain('title="存回预设？"');
  });

  it('语音与写歌同步 effect 仅盯具体字段，不以整个 apiConfig 对象为依赖', () => {
    expect(settings).not.toMatch(/\}, \[apiConfig\]\);/);
  });
});

describe('点选预设按 ID 引用 + 编辑器全站联动', () => {
  it('ApiSlotEditor 点预设通过 slotFromPreset 生成带 presetId 与 presetFp 的引用并立即提交', () => {
    expect(slotEditor).toContain('const nextSlot = slotFromPreset(preset);');
    expect(slotEditor).toContain('void onCommit(nextSlot);');
  });

  it('预设编辑弹窗复用 DialogueApiFields 与 ModelPicker，并列出引用影响范围', () => {
    expect(presetEditor).toContain('<DialogueApiFields');
    expect(presetEditor).toContain('<ModelPicker');
    expect(presetEditor).toContain('collectPresetUsageSummary(');
    expect(modelPicker).toMatch(/onClick=\{\(\) => confirmModelPicker\(localModel\)\}/);
    expect(modelPicker).toMatch(/onClick=\{\(\) => confirmModelPicker\(m\)\}/);
  });

  it('OSContext.updateApiPreset 同步刷新主配置、记忆副 API 及跨空间快照，并调度云端凭据同步', () => {
    expect(osContext).toContain('refreshPresetSnapshotsEverywhere(targetPreset)');
    expect(osContext).toContain('isSlotActivelyBoundToPreset(prevApi, id)');
    expect(osContext).toContain('isSlotActivelyBoundToPreset(prevMp.lightLLM, id)');
  });
});

describe('换主对话 API 必连带同步主动消息云端凭据', () => {
  it('Settings.commitApiConfig 同时更新本地配置与云端凭据队列', () => {
    const start = settings.indexOf('const commitApiConfig = ');
    expect(start).toBeGreaterThan(-1);
    const end = settings.indexOf('\n  };', start);
    const fn = settings.slice(start, end);
    expect(fn).toContain('updateApiConfig(patch)');
    expect(fn).toContain('syncAmsgLlmCredentials({ ...apiConfig, ...patch })');
    expect(stateSync).toContain('refreshApiCredentialsForPendingTasks(snapshot)');
  });
});

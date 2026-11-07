// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Settings from '../apps/Settings';

const context = vi.hoisted(() => ({
    apiConfig: { baseUrl: '', apiKey: '', model: '' }, theme: {}, realtimeConfig: {}, cloudBackupConfig: {}, characters: [], groups: [], userProfile: {},
    apiPresets: [], availableModels: [], sysOperation: { status: 'idle' }, addToast: vi.fn(), exportSystem: vi.fn(), importSystem: vi.fn(),
}));
const share = vi.hoisted(() => vi.fn());
vi.mock('../context/OSContext', () => ({ useOS: () => context }));
vi.mock('../components/os/Modal', () => ({ default: () => null }));
vi.mock('../components/settings/VersionInfo', () => ({ default: () => null }));
vi.mock('../components/settings/StorageUsagePanel', () => ({ default: () => null }));
vi.mock('../components/settings/ActiveMsgGlobalSettingsModal', () => ({ default: () => null }));
vi.mock('../components/settings/PushVapidSettingsModal', () => ({ PushVapidSettingsModal: () => null }));
vi.mock('../components/settings/ApiCallLogModal', () => ({ default: () => null }));
vi.mock('./avatarModelBackup', () => ({ getAvatarModelBackupInventory: async () => ({ models: [], totalBytes: 0 }) }));
vi.mock('./shareExport', () => ({ shareOrDownloadBlob: share }));
let host: HTMLDivElement, root: Root;

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('URL', class extends URL {
        static createObjectURL = () => 'blob:backup';
        static revokeObjectURL = vi.fn();
    });
    share.mockResolvedValue('cancelled');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps the missing-file warning visible after sharing is cancelled and clears it for the next healthy backup', async () => {
    const file = new Blob(['zip']);
    context.exportSystem.mockImplementation(async (_mode, options) => {
        options.onMissingAssets([{ id: 'img_missing', locations: ['用户「甲」 → 角色「小夏」 → 头像'] }]);
        return file;
    });
    await act(async () => root.render(createElement(Settings)));
    const section = Array.from(host.querySelectorAll('section')).find(node => node.querySelector('h2')?.textContent === '备份与恢复 (ZIP)')!;
    await act(async () => section.querySelector('button')!.click());
    const button = Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes('整合导出 (文字+媒体)'))!;
    await act(async () => button.click());
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ blob: file }));
    expect(host.textContent).toContain('备份已生成，但有 1 份素材原文件缺失');
    const details = Array.from(host.querySelectorAll('details')).find(node => node.textContent?.includes('img_missing'))!;
    await act(async () => details.querySelector('summary')!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('用户「甲」 → 角色「小夏」 → 头像');
    context.exportSystem.mockImplementation(async (_mode, options) => { options.onMissingAssets([]); return file; });
    await act(async () => button.click());
    expect(host.textContent).not.toContain('img_missing');
});

it('offers independent migration explicitly while the original import button keeps normal restore behavior', async () => {
    context.importSystem.mockResolvedValue(undefined);
    await act(async () => root.render(createElement(Settings)));
    const section = Array.from(host.querySelectorAll('section')).find(node => node.querySelector('h2')?.textContent === '备份与恢复 (ZIP)')!;
    await act(async () => section.querySelector('button')!.click());
    const independent = host.querySelector<HTMLInputElement>('input[aria-label="迁入独立用户备份"]')!;
    const picker = vi.spyOn(independent, 'click');
    await act(async () => Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes('从其他网址 / App 迁入独立用户'))!.click());
    expect(picker).toHaveBeenCalledOnce();
    const file = new File(['{}'], 'backup.json');
    Object.defineProperty(independent, 'files', { value: [file], configurable: true });
    await act(async () => independent.dispatchEvent(new Event('change', { bubbles: true })));
    expect(context.importSystem).toHaveBeenLastCalledWith(file, expect.objectContaining({ asNewUsers: true }));
    const normal = independent.previousElementSibling?.previousElementSibling as HTMLInputElement;
    expect(normal.type).toBe('file');
    Object.defineProperty(normal, 'files', { value: [file], configurable: true });
    await act(async () => normal.dispatchEvent(new Event('change', { bubbles: true })));
    expect(context.importSystem).toHaveBeenLastCalledWith(file, expect.objectContaining({ asNewUsers: false }));
});

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import Settings from '../apps/Settings';

vi.mock('../context/OSContext', () => ({ useOS: () => os }));
vi.mock('../components/settings/VersionInfo', () => ({ default: () => null }));
vi.mock('../components/settings/StorageUsagePanel', () => ({ default: () => null }));
vi.mock('../components/settings/ApiCallLogModal', () => ({ default: () => null }));
vi.mock('../components/settings/ActiveMsgGlobalSettingsModal', () => ({ default: () => null }));
vi.mock('../components/settings/PushVapidSettingsModal', () => ({ PushVapidSettingsModal: () => null }));
vi.mock('./avatarModelBackup', () => ({ getAvatarModelBackupInventory: async () => ({ models: [], totalBytes: 0 }) }));

const source = { id: 'one', name: '写作', group: '日常', config: {
    baseUrl: 'https://example.test/v1', apiKey: 'demo', model: 'first', stream: true, temperature: 0.65, maxTokens: 4096,
} };
const os = {
    isDataLoaded: true,
    apiConfig: source.config, apiPresets: [source], availableModels: [], theme: {}, characters: [], groups: [],
    realtimeConfig: {}, cloudBackupConfig: {}, userProfile: {}, sysOperation: { status: 'idle' },
    addToast: vi.fn(), addApiPreset: vi.fn(), removeApiPreset: vi.fn(), updateApiPreset: vi.fn(), updateApiConfig: vi.fn(),
};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('copies the edit form into a separate preset and only deletes through the editor', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const click = async (button: HTMLButtonElement) => act(async () => { button.click(); });
    const button = (label: string) => Array.from(host.querySelectorAll('button')).find(el => el.textContent?.trim() === label)!;
    const pencil = () => host.querySelector<HTMLButtonElement>('[aria-label="编辑预设 写作"]')!;
    try {
        await act(async () => root.render(createElement(Settings)));
        if (!pencil()) await click(host.querySelector<HTMLButtonElement>('section[data-guide="api"] button')!);
        expect(button('删除预设')).toBeUndefined();
        await click(pencil());
        await click(button('复制预设'));
        expect(host.querySelector<HTMLInputElement>('[placeholder="预设名称"]')!.value).toBe('写作 副本');
        await click(button('取消'));
        expect(os.addApiPreset).not.toHaveBeenCalled();

        // Releasing the long press after the editor opens must not switch the live API.
        const name = host.querySelector<HTMLButtonElement>('[title="切换到 写作"]')!;
        await act(async () => {
            name.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
            await new Promise(resolve => setTimeout(resolve, 600));
        });
        await act(async () => {
            name.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
            name.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        });
        await click(button('复制预设'));
        const model = host.querySelector<HTMLInputElement>('[placeholder="模型名称"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(model, 'second');
            model.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click(button('保存副本'));
        expect(os.addApiPreset).toHaveBeenCalledWith('写作 副本', expect.objectContaining({ ...source.config, model: 'second' }), '日常');
        expect(os.updateApiPreset).not.toHaveBeenCalled();
        expect(os.updateApiConfig).not.toHaveBeenCalled();
        await click(pencil());
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        await click(button('删除预设'));
        expect(os.removeApiPreset).not.toHaveBeenCalled();
        await click(button('删除预设'));
        expect(confirm).toHaveBeenCalledWith('确定删除预设「写作」？');
        expect(os.removeApiPreset).toHaveBeenCalledWith('one');
        expect(os.updateApiConfig).not.toHaveBeenCalled();
    } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    }
});

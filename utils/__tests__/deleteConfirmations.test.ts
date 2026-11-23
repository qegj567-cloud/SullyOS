// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackEventMock = vi.hoisted(() => vi.fn());
const settingsContext = vi.hoisted(() => ({
    isDataLoaded: true,
    apiConfig: { baseUrl: '', apiKey: '', model: '' },
    theme: {},
    realtimeConfig: {},
    cloudBackupConfig: { enabled: true, provider: 'webdav', webdavUrl: 'https://dav.example.test' },
    characters: [],
    characterGroups: [],
    groups: [],
    userProfile: {},
    apiPresets: [],
    availableModels: [],
    sysOperation: { status: 'idle' },
    addToast: vi.fn(),
    showError: vi.fn(),
    exportSystem: vi.fn(),
    importSystem: vi.fn().mockResolvedValue(undefined),
    cloudRestoreFromWebDAV: vi.fn().mockResolvedValue(undefined),
    listCloudBackups: vi.fn().mockResolvedValue([
        { name: 'backup-1.zip', href: '/backup-1.zip', size: 2048, lastModified: '2026-10-01T00:00:00Z' },
    ]),
}));

vi.mock('../../context/OSContext', () => ({ useOS: () => settingsContext }));
vi.mock('../../utils/analytics', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/analytics')>()),
    trackEvent: trackEventMock,
}));
vi.mock('../../components/settings/VersionInfo', () => ({ default: () => null }));
vi.mock('../../components/settings/StorageUsagePanel', () => ({ default: () => null }));
vi.mock('../../components/settings/ActiveMsgGlobalSettingsModal', () => ({ default: () => null }));
vi.mock('../../components/settings/PushVapidSettingsModal', () => ({ PushVapidSettingsModal: () => null }));
vi.mock('../../components/settings/ApiCallLogModal', () => ({ default: () => null }));
vi.mock('../../utils/avatarModelBackup', () => ({ getAvatarModelBackupInventory: async () => ({ models: [], totalBytes: 0 }) }));
vi.mock('../../utils/shareExport', () => ({ shareOrDownloadBlob: vi.fn() }));
vi.mock('../../components/handbook/JournalCanvas', () => ({ default: () => null }));
vi.mock('../../components/chat/EmojiExportDialog', () => ({ default: () => null }));
vi.mock('../../components/chat/EmojiHealthDialog', () => ({ default: () => null }));
vi.mock('../../components/chat/ChatCamera', () => ({ default: () => null }));

import Settings from '../../apps/Settings';
import HandbookDayView from '../../components/handbook/HandbookDayView';
import ChatInputArea from '../../components/chat/ChatInputArea';
import type { HandbookEntry, HandbookPage } from '../../types';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

const findButton = (scope: ParentNode, text: string) =>
    Array.from(scope.querySelectorAll('button')).find(btn => btn.textContent?.trim() === text);

const topDialogButton = (scope: ParentNode, text: string) => {
    const dialogs = scope.querySelectorAll('[role="dialog"]');
    const top = dialogs[dialogs.length - 1];
    if (!top) return undefined;
    return Array.from(top.querySelectorAll('button')).find(btn => btn.textContent?.trim() === text);
};

describe('secondary confirmation regression guards', () => {
    it('HandbookDayView keeps the page editor open when delete confirmation is cancelled and closes only after confirmed delete', async () => {
        const page: HandbookPage = {
            id: 'p1',
            type: 'user_diary',
            content: '今天去买了桂花拿铁',
            paperStyle: 'cream',
            createdAt: 1,
        };
        const entry: HandbookEntry = {
            id: '2026-10-01',
            date: '2026-10-01',
            pages: [page],
            layouts: [],
            updatedAt: 1,
        };
        const onCancelEdit = vi.fn();
        const onDeletePage = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

        await act(async () => {
            root.render(React.createElement(HandbookDayView, {
                date: '2026-10-01',
                entry,
                characters: [],
                userName: '用户',
                editingPageId: 'p1',
                regenPageId: null,
                onStartEdit: vi.fn(),
                onSavePage: vi.fn(),
                onCancelEdit,
                onToggleExclude: vi.fn(),
                onDeletePage,
                onRegenerateLifestream: vi.fn(),
            }));
        });

        await act(async () => findButton(host, '撕掉')!.click());
        expect(onDeletePage).toHaveBeenCalledTimes(1);
        expect(onCancelEdit).not.toHaveBeenCalled();
        expect(findButton(host, '撕掉')).toBeTruthy();

        await act(async () => findButton(host, '撕掉')!.click());
        expect(onDeletePage).toHaveBeenCalledTimes(2);
        expect(onCancelEdit).toHaveBeenCalledTimes(1);
    });

    it('Settings asks for confirmation before overwriting data on local import or cloud restore', async () => {
        await act(async () => {
            root.render(React.createElement(Settings));
        });

        const backupSection = Array.from(host.querySelectorAll('section')).find(
            node => node.querySelector('h2')?.textContent === '备份与恢复',
        )!;
        await act(async () => backupSection.querySelector('button')!.click());
        // 云端已连接时卡片默认打开云端页签，本地导入在「本地文件」页签
        await act(async () => findButton(backupSection, '本地文件')!.click());

        const normalInput = host.querySelector<HTMLInputElement>('input[aria-label="迁入独立用户备份"]')!
            .previousElementSibling?.previousElementSibling as HTMLInputElement;
        const file = new File(['{}'], 'backup.json', { type: 'application/json' });
        Object.defineProperty(normalInput, 'files', { value: [file], configurable: true });

        await act(async () => normalInput.dispatchEvent(new Event('change', { bubbles: true })));
        expect(settingsContext.importSystem).not.toHaveBeenCalled();

        await act(async () => topDialogButton(host, '取消')!.click());
        expect(settingsContext.importSystem).not.toHaveBeenCalled();

        Object.defineProperty(normalInput, 'files', { value: [file], configurable: true });
        await act(async () => normalInput.dispatchEvent(new Event('change', { bubbles: true })));
        await act(async () => topDialogButton(host, '确认覆盖')!.click());
        expect(settingsContext.importSystem).toHaveBeenCalledWith(file, expect.objectContaining({ asNewUsers: false }));

        await act(async () => findButton(backupSection, '云端')!.click());
        await act(async () => findButton(host, '从云端恢复')!.click());

        const backupItem = Array.from(host.querySelectorAll('button')).find(btn => btn.textContent?.includes('backup-1.zip'))!;
        expect(backupItem).toBeTruthy();
        await act(async () => backupItem.click());
        expect(settingsContext.cloudRestoreFromWebDAV).not.toHaveBeenCalled();

        await act(async () => topDialogButton(host, '取消')!.click());
        expect(settingsContext.cloudRestoreFromWebDAV).not.toHaveBeenCalled();
        expect(host.textContent).toContain('backup-1.zip');

        const backupItemAgain = Array.from(host.querySelectorAll('button')).find(btn => btn.textContent?.includes('backup-1.zip'))!;
        await act(async () => backupItemAgain.click());
        await act(async () => topDialogButton(host, '确认恢复')!.click());
        expect(settingsContext.cloudRestoreFromWebDAV).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'backup-1.zip' }),
            expect.objectContaining({ confirmBackendRestore: expect.any(Function) }),
        );
    });

    it('ChatInputArea delegates batch delete without firing analytics prior to confirmation', async () => {
        const onDeleteSelected = vi.fn();
        await act(async () => {
            root.render(React.createElement(ChatInputArea, {
                input: '',
                setInput: vi.fn(),
                isTyping: false,
                selectionMode: true,
                showPanel: 'none',
                setShowPanel: vi.fn(),
                onSend: vi.fn(),
                onDeleteSelected,
                selectedCount: 2,
                emojis: [],
                onPanelAction: vi.fn(),
                onImageSelect: vi.fn(),
                isSummarizing: false,
                onReroll: vi.fn(),
                canReroll: false,
            }));
        });

        await act(async () => findButton(host, '删除 (2)')!.click());
        expect(onDeleteSelected).toHaveBeenCalledTimes(1);
        expect(trackEventMock).not.toHaveBeenCalledWith('批量删除选中的消息');
    });
});

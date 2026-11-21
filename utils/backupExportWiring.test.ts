// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from '../apps/Settings';
import { markBackupDone } from './backupReminder';

// OSContext 是 5000 行的 Provider，没法直接跑；这里在语法树上检查调用顺序，不依赖缩进或文本位置。
const osContextSource = readFileSync(path.resolve(__dirname, '../context/OSContext.tsx'), 'utf8');
const dbSource = readFileSync(path.resolve(__dirname, './db.ts'), 'utf8');
const sourceFile = ts.createSourceFile('OSContext.tsx', osContextSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const findVariable = (name: string): ts.Expression => {
    let found: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (!found && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) found = node.initializer;
        else ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(found, name).toBeDefined();
    return found!;
};
const calleeName = (call: ts.CallExpression) => {
    const callee = call.expression;
    return ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : callee.getText(sourceFile);
};
const callsIn = (root: ts.Node, name: string) => {
    const found: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && calleeName(node) === name) found.push(node);
        ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
};
const insideProperty = (node: ts.Node, property: string) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name) && parent.name.text === property) return true;
    }
    return false;
};

describe('single-space export store list', () => {
    const allStores = (findVariable('allStores') as ts.ArrayLiteralExpression).elements
        .filter(ts.isStringLiteral).map(element => element.text);
    const fieldByStore = Object.fromEntries((findVariable('backupArrayFieldByStore') as ts.ObjectLiteralExpression).properties
        .filter(ts.isPropertyAssignment)
        .map(property => [property.name.getText(sourceFile), (property.initializer as ts.StringLiteral).text]));

    it('exports xhs_owned_posts under the field the importer restores', () => {
        expect(allStores).toContain('xhs_owned_posts');
        expect(fieldByStore.xhs_owned_posts).toBe('xhsOwnedPosts');
        expect(dbSource).toContain('clearAndAdd(STORE_XHS_OWNED_POSTS, data.xhsOwnedPosts');
    });

    it('only maps stores that are actually exported', () => {
        for (const store of Object.keys(fieldByStore)) expect(allStores, store).toContain(store);
    });
});

describe('last backup time', () => {
    it('is not recorded while packing, only after a cloud upload succeeds', () => {
        expect(callsIn(findVariable('exportSystem'), 'markBackupDone')).toEqual([]);
        const cloud = findVariable('cloudBackupToWebDAV');
        const marks = callsIn(cloud, 'markBackupDone');
        expect(marks).toHaveLength(1);
        let okCheck: ts.IfStatement | undefined;
        const visit = (node: ts.Node) => {
            if (ts.isIfStatement(node) && node.expression.getText(sourceFile) === '!result.ok') okCheck = node;
            ts.forEachChild(node, visit);
        };
        visit(cloud);
        expect(marks[0].getStart()).toBeGreaterThan(okCheck!.getEnd());
        for (let parent = marks[0].parent; parent !== cloud; parent = parent.parent) expect(ts.isCatchClause(parent)).toBe(false);
    });
});

describe('import-in-progress marker', () => {
    const importSystem = findVariable('importSystem');
    const lastCall = (name: string) => Math.max(...callsIn(importSystem, name).map(call => call.getStart()));
    const firstCall = (name: string) => Math.min(...callsIn(importSystem, name).map(call => call.getStart()));

    it('single-space import starts the marker after every read-only check and before the first write, image store included', () => {
        const begins = callsIn(importSystem, 'beginWrite').filter(call => !insideProperty(call, 'onBeforeWrite'));
        expect(begins).toHaveLength(1);
        const begin = begins[0].getStart();
        for (const check of ['openBackupZip', 'openLegacyBackup', 'assertSupportedSullyBackup', 'readBlobsIndex', 'confirmBackendRestore', 'assertUniqueSpaceCharacters']) {
            expect(callsIn(importSystem, check).length, check).toBeGreaterThan(0);
            expect(begin, check).toBeGreaterThan(lastCall(check));
        }
        for (const write of ['restoreBlobsFromZip', 'importFullData', 'importBackup']) {
            expect(begin, write).toBeLessThan(firstCall(write));
        }
    });

    it('voice files are only restored from the field-read hook, which the pre-write validation pass runs for every field', () => {
        // 钩子在校验那一遍（写库前）和写库轮到 assets 时各跑一次，源码位置说明不了先后；
        // 「缺语音文件在写库前被拒绝」由 backupLegacyRestore.test.ts 的行为测试钉住，这里只钉接线。
        const open = callsIn(importSystem, 'openLegacyBackup')[0];
        const voice = callsIn(importSystem, 'restoreVoiceMessageBlobs');
        expect(voice).toHaveLength(1);
        expect(insideProperty(voice[0], 'onFieldRead')).toBe(true);
        expect(voice[0].getStart()).toBeGreaterThan(open.getStart());
        expect(voice[0].getEnd()).toBeLessThan(open.getEnd());
    });

    it('both user-space paths start the marker from the pre-write hook and clear it after a clean rollback', () => {
        const hooks = findVariable('userSpaceWriteHooks') as ts.ObjectLiteralExpression;
        const property = (name: string) => hooks.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sourceFile) === name)!;
        expect(callsIn(property('onBeforeWrite'), 'beginWrite')).toHaveLength(1);
        expect(property('onRolledBack').getText(sourceFile)).toContain('importMarker.clear()');
        for (const entry of ['importUserSpaces', 'importLegacyAsIndependentUser']) {
            const calls = callsIn(importSystem, entry);
            expect(calls, entry).toHaveLength(1);
            expect(calls[0].arguments.some(arg => arg.getText(sourceFile).includes('userSpaceWriteHooks')), entry).toBe(true);
        }
    });
});

describe('backup package reading', () => {
    const importSystem = findVariable('importSystem');

    it('restore opens the package with the on-demand reader, never by loading the whole file through JSZip', () => {
        expect(callsIn(importSystem, 'loadAsync')).toEqual([]);
        expect(callsIn(importSystem, 'loadJSZip')).toEqual([]);
        const opens = callsIn(importSystem, 'openBackupZip');
        expect(opens).toHaveLength(1);
        expect(opens[0].arguments.map(arg => arg.getText(sourceFile))).toEqual(['fileOrJson']);
        // 多空间包和旧格式包读的都是这一个读取器。
        for (const entry of ['importUserSpaces', 'openLegacyBackup']) {
            expect(callsIn(importSystem, entry)[0].arguments[0].getText(sourceFile), entry).toBe('loadedZip');
        }
    });

    it('zip.js stays out of the main bundle: the reader module is only imported dynamically or for types', () => {
        const staticImports = sourceFile.statements.filter(ts.isImportDeclaration)
            .filter(node => (node.moduleSpecifier as ts.StringLiteral).text.endsWith('/backupZipReader'));
        for (const node of staticImports) expect(node.importClause?.isTypeOnly).toBe(true);
        const dynamic = callsIn(importSystem, 'import').filter(call => call.arguments[0].getText(sourceFile).includes('backupZipReader'));
        expect(dynamic).toHaveLength(1);
    });

    it('closes the reader when the restore ends, whether it succeeded or failed', () => {
        let closesInFinally = 0;
        const visit = (node: ts.Node) => {
            if (ts.isTryStatement(node) && node.finallyBlock) closesInFinally += callsIn(node.finallyBlock, 'close').length;
            ts.forEachChild(node, visit);
        };
        visit(importSystem);
        expect(closesInFinally).toBe(1);
    });

    it('judges the format by the file header, not by the file name', () => {
        expect(callsIn(importSystem, 'detectBackupFileKind').map(call => call.arguments[0].getText(sourceFile))).toEqual(['fileOrJson']);
        expect(callsIn(importSystem, 'endsWith')).toEqual([]);
        expect(callsIn(findVariable('importAppearancePreset'), 'isZipFile')).toHaveLength(1);
        // 云端下载落盘的文件原样交给恢复入口，不先读进内存。
        const cloud = findVariable('cloudRestoreFromWebDAV');
        expect(cloud.getText(sourceFile)).toContain('backup.blob instanceof File');
        expect(callsIn(cloud, 'importSystem')).toHaveLength(1);
    });

    it('skipped pictures are noted from both picture steps, with one shared file-still-readable guard for assets/*', () => {
        const restore = callsIn(importSystem, 'restoreBlobsFromZip')[0];
        expect(restore.arguments[3].getText(sourceFile)).toContain('onDamaged: entry => noteDamagedAsset(entry.id)');
        expect(callsIn(importSystem, 'createDamagedPictureGuard')).toHaveLength(1);
        const assets = callsIn(importSystem, 'restoreAssetFilesInPlace');
        expect(assets).toHaveLength(1);
        expect(assets[0].arguments[2].getText(sourceFile)).toContain('skipDamaged: skipDamagedAsset');
        expect(callsIn(assets[0], 'noteDamagedAsset')).toHaveLength(1);
        // importSystem 里不再自己 catch 图片读取错误，判断都在共用的那一处。
        const catches: ts.CatchClause[] = [];
        const visit = (node: ts.Node) => { if (ts.isCatchClause(node)) catches.push(node); ts.forEachChild(node, visit); };
        visit(findVariable('restoreAssetsInPlace'));
        expect(catches).toEqual([]);
    });

    it('stores the skipped-picture list and reloads without waiting for the user', () => {
        const report = findVariable('reportDamagedAssets') as ts.ArrowFunction;
        expect(report.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false).toBe(false);
        expect(callsIn(report, 'saveRestoreDamagedAssets')).toHaveLength(1);
        const reports = callsIn(importSystem, 'reportDamagedAssets');
        const reloads = callsIn(importSystem, 'reload').map(call => call.getStart());
        expect(reports).toHaveLength(3);
        expect(reloads).toHaveLength(3);
        reloads.forEach((reload, index) => {
            expect(reports[index].getStart()).toBeLessThan(reload);
            if (index > 0) expect(reports[index].getStart()).toBeGreaterThan(reloads[index - 1]);
            expect(ts.isAwaitExpression(reports[index].parent)).toBe(false);
        });
        // 恢复入口不再接收任何「等用户确认损坏清单」的回调。
        expect(osContextSource).not.toContain('onDamagedAssets');
        expect(readFileSync(path.resolve(__dirname, '../apps/Settings.tsx'), 'utf8')).not.toContain('onDamagedAssets');
    });

    it('keeps the screen awake for the whole restore, cloud download included', () => {
        for (const name of ['importSystem', 'cloudRestoreFromWebDAV']) {
            const body = (findVariable(name) as ts.ArrowFunction).body;
            expect(ts.isCallExpression(body) && calleeName(body), name).toBe('withScreenAwake');
        }
        // 常亮模块动态加载，加载不到就照常执行。
        const awake = findVariable('withScreenAwake');
        expect(callsIn(awake, 'import')[0].arguments[0].getText(sourceFile)).toContain('backupTempFile');
        expect(sourceFile.statements.filter(ts.isImportDeclaration).some(node => (node.moduleSpecifier as ts.StringLiteral).text.endsWith('/backupTempFile'))).toBe(false);
        expect(awake.getText(sourceFile)).toContain('mod ? mod.withScreenWakeLock(task) : task()');
    });

    it('leftover temp files are cleaned once at startup, outside export and restore', () => {
        expect(callsIn(sourceFile, 'cleanupBackupTempFiles')).toHaveLength(1);
        for (const name of ['importSystem', 'exportSystem']) expect(callsIn(findVariable(name), 'cleanupBackupTempFiles')).toEqual([]);
    });
});

const context = vi.hoisted(() => ({
    isDataLoaded: true, // 设置页要等数据读完才渲染
    apiConfig: { baseUrl: '', apiKey: '', model: '' }, theme: {}, realtimeConfig: {}, cloudBackupConfig: {}, characters: [], groups: [], userProfile: {},
    apiPresets: [], availableModels: [], sysOperation: { status: 'idle' }, addToast: vi.fn(), exportSystem: vi.fn(), importSystem: vi.fn(),
}));
const share = vi.hoisted(() => vi.fn());
vi.mock('../context/OSContext', () => ({ useOS: () => context }));
// 只渲染打开着的弹窗（标题、内容、底部按钮），好点到里面的链接和按钮。
vi.mock('../components/os/Modal', async () => {
    const { createElement: h } = await import('react');
    return { default: ({ isOpen, title, children, footer }: { isOpen: boolean; title: string; children?: any; footer?: any }) =>
        (isOpen ? h('div', { role: 'dialog' }, h('h3', null, title), children, footer) : null) };
});
vi.mock('../components/settings/VersionInfo', () => ({ default: () => null }));
vi.mock('../components/settings/StorageUsagePanel', () => ({ default: () => null }));
vi.mock('../components/settings/ActiveMsgGlobalSettingsModal', () => ({ default: () => null }));
vi.mock('../components/settings/PushVapidSettingsModal', () => ({ PushVapidSettingsModal: () => null }));
vi.mock('../components/settings/ApiCallLogModal', () => ({ default: () => null }));
vi.mock('./avatarModelBackup', () => ({ getAvatarModelBackupInventory: async () => ({ models: [], totalBytes: 0 }) }));
vi.mock('./shareExport', () => ({ shareOrDownloadBlob: share }));
vi.mock('./backupReminder', async importOriginal => ({ ...await importOriginal<typeof import('./backupReminder')>(), markBackupDone: vi.fn() }));

describe('local export', () => {
    let host: HTMLDivElement, root: Root;
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.stubGlobal('URL', class extends URL {
            static createObjectURL = () => 'blob:backup';
            static revokeObjectURL = vi.fn();
        });
        context.exportSystem.mockResolvedValue(new Blob(['zip']));
        host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    });
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    const exportButton = () => Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes('整合导出 (文字+媒体)'))!;
    const exportFull = async () => {
        await act(async () => root.render(createElement(Settings)));
        const section = Array.from(host.querySelectorAll('section')).find(node => node.querySelector('h2')?.textContent === '备份与恢复 (ZIP)')!;
        await act(async () => section.querySelector('button')!.click());
        await act(async () => exportButton().click());
    };
    const clickManualDownload = async () => {
        const link = Array.from(host.querySelectorAll('a')).find(node => node.textContent?.includes('点击手动下载'))!;
        expect(link).toBeTruthy();
        link.addEventListener('click', event => event.preventDefault(), { once: true }); // jsdom 不支持真的下载
        await act(async () => link.click());
    };

    it.each(['downloaded', 'shared'] as const)('records the backup once the file is handed over (%s)', async outcome => {
        share.mockResolvedValue(outcome);
        await exportFull();
        expect(markBackupDone).toHaveBeenCalledOnce();
    });

    it('does not record a cancelled save or a failed save', async () => {
        share.mockResolvedValue('cancelled');
        await exportFull();
        share.mockRejectedValue(new Error('无法拉起系统文件分享'));
        await act(async () => exportButton().click());
        expect(share).toHaveBeenCalledTimes(2);
        expect(markBackupDone).not.toHaveBeenCalled();
    });

    it('records the manual download link once per export, without doubling a successful share', async () => {
        share.mockResolvedValue('cancelled');
        await exportFull();
        expect(markBackupDone).not.toHaveBeenCalled();
        await clickManualDownload();
        await clickManualDownload();
        expect(markBackupDone).toHaveBeenCalledTimes(1);

        share.mockResolvedValue('downloaded');
        await act(async () => exportButton().click());
        expect(markBackupDone).toHaveBeenCalledTimes(2);
        await clickManualDownload();
        expect(markBackupDone).toHaveBeenCalledTimes(2);
    });
});

describe('GitHub 备份连接时的中转询问', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/Settings.tsx'), 'utf8');
    const handler = source.slice(source.indexOf('const handleTestGithub'), source.indexOf('const handleGithubProxyToggle'));

    it('网页端没开中转时，先询问再连接，连接和保存都用询问后的结果', () => {
        const ask = handler.indexOf('window.confirm(');
        expect(ask).toBeGreaterThan(handler.indexOf('!useProxy && !Capacitor.isNativePlatform()'));
        expect(ask).toBeLessThan(handler.indexOf('testConnection({'));
        // 同意要立即持久化，和手动勾选走同一条路
        expect(handler).toContain('if (useProxy) handleGithubProxyToggle(true)');
        expect(handler.match(/githubUseProxy: useProxy,/g)).toHaveLength(2);
        expect(handler).not.toContain('githubUseProxy: ghUseProxy');
    });
});

// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import DatabaseGuard from '../components/DatabaseGuard';
import { reportDatabaseFailure } from './databaseHealth';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  open: vi.fn(),
  rescueExport: vi.fn(),
  shareBlob: vi.fn(),
  track: vi.fn(),
}));
vi.mock('./db', () => ({ openDB: mocks.open }));
vi.mock('./databaseHealth', async importOriginal => ({
  ...await importOriginal<typeof import('./databaseHealth')>(), checkDatabaseReadable: mocks.check,
}));
vi.mock('./databaseRescueExport', () => ({
  exportDamagedDatabaseRescue: mocks.rescueExport,
}));
vi.mock('./shareExport', () => ({
  shareOrDownloadBlob: mocks.shareBlob,
}));
vi.mock('./analytics', () => ({
  trackEvent: mocks.track,
}));

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  mocks.check.mockReset();
  mocks.rescueExport.mockReset();
  mocks.shareBlob.mockReset();
  mocks.track.mockReset();
});

async function mount(child: React.ReactNode, readiness?: Promise<void>) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(DatabaseGuard, { children: child, readiness })));
}

it('does not mount default-seeding/sync providers until storage is readable, including an empty installation', async () => {
  let ready!: () => void;
  mocks.check.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  const mounted = vi.fn();
  function Child() { React.useEffect(() => { mounted(); }, []); return React.createElement('p', null, '桌面'); }
  await mount(React.createElement(Child));
  expect(mounted).not.toHaveBeenCalled();
  expect(host.textContent).toBe('');
  expect(host.querySelector('.database-guard')).toBeNull();
  expect(host.querySelector<HTMLElement>('[data-database-pending]')?.hidden).toBe(true);
  await act(async () => ready());
  expect(mounted).toHaveBeenCalledOnce();
  expect(host.textContent).toBe('桌面');
  expect(host.querySelector('[data-database-pending]')).toBeNull();
});

it('shares the entry check through StrictMode and mounts the desktop without waiting for the SW', async () => {
  let readable!: () => void;
  const readiness = new Promise<void>(resolve => { readable = resolve; });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(React.StrictMode, null,
    React.createElement(DatabaseGuard, { readiness, children: React.createElement('p', { 'data-testid': 'desktop' }, '桌面') }))));
  expect(mocks.check).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid=desktop]')).toBeNull();
  await act(async () => readable());
  expect(host.textContent).toBe('桌面');
  expect(mocks.check).not.toHaveBeenCalled();
});

it('shows actionable index-conflict diagnostics, exposes the rescue export entry on every failure, and does not alter saved settings', async () => {
  localStorage.setItem('os_api_config', 'secret-preserve');
  mocks.check.mockRejectedValue(new DOMException('Index with the same ID already exists', 'UnknownError'));
  const mounted = vi.fn();
  function Child() { mounted(); return null; }
  await mount(React.createElement(Child));
  expect(mounted).not.toHaveBeenCalled();
  expect(host.textContent).toContain('读取失败不代表数据已被清空');
  expect(host.textContent).toContain('内部索引冲突');
  expect(host.textContent).toContain('紧急抢救导出备份');
  expect(host.textContent).toContain('生成抢救备份包');
  expect(host.textContent).not.toContain('如果其他页面');
  expect(host.querySelector('textarea')!.value).toContain('UnknownError');
  expect(host.querySelector('textarea')!.value).not.toContain('secret-preserve');
  expect(localStorage.getItem('os_api_config')).toBe('secret-preserve');
});

it('unmounts the active app after an open failure caught by a background caller', async () => {
  mocks.check.mockResolvedValue(undefined);
  const stopped = vi.fn();
  function Child() { React.useEffect(() => stopped, []); return React.createElement('p', null, '桌面'); }
  await mount(React.createElement(Child));
  await act(async () => reportDatabaseFailure(new Error('Index with the same ID already exists')));
  expect(stopped).toHaveBeenCalledOnce();
  expect(host.querySelector('h1')!.textContent).toBe('暂时无法读取本地数据');
  expect(host.textContent).toContain('生成抢救备份包');
});

it('explains missing-file NotReadableError and runs two-step rescue export + chunked native-safe handover', async () => {
  mocks.check.mockRejectedValue(
    new DOMException('Data lost due to missing file. Affected record should be considered irrecoverable', 'NotReadableError'),
  );
  const fakeBlob = new Blob(['rescue-zip-bytes'], { type: 'application/zip' });
  mocks.rescueExport.mockImplementation(async (onProgress?: (text: string) => void) => {
    onProgress?.('正在读取 默认用户 · messages（120 / 120 条）');
    return {
      blob: fakeBlob,
      fileName: 'Sully_Rescue_Backup_2026-11-28.zip',
      healedCharacters: [],
      placeholderCharacters: [{ spaceId: 'default', spaceName: '默认用户', charId: 'secret-char-id', name: '秘密名字', mode: 'placeholder' }],
      skippedRecords: [{ spaceId: 'default', spaceName: '默认用户', store: 'characters', key: 'secret-char-id', error: 'NotReadableError' }],
      unreadableBlobIds: [],
      missingAssets: [],
      failedSections: [],
      summaryText: '已将本机可读取的全部存档打包完成。有 1 个角色档案因原文件丢失已自动生成同编号占位档案。',
      reportText: 'report',
    };
  });

  await mount(React.createElement('p', null, '桌面'));
  expect(host.textContent).toContain('浏览器报告本地数据文件缺失');

  const generateBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('生成抢救备份包'))!;
  expect(generateBtn).toBeTruthy();
  await act(async () => { generateBtn.click(); });

  expect(mocks.rescueExport).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('有 1 个角色档案因原文件丢失已自动生成同编号占位档案');
  expect(mocks.track).toHaveBeenCalledWith('导出数据库抢救备份', { 结果: '成功' });

  // First save attempt: user cancels system share -> reported as cancelled, save button stays ready
  mocks.shareBlob.mockResolvedValueOnce('cancelled');
  const saveBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('保存抢救备份 (.zip)'))!;
  expect(saveBtn).toBeTruthy();
  await act(async () => { saveBtn.click(); });
  expect(mocks.shareBlob).toHaveBeenCalledWith({
    blob: fakeBlob,
    fileName: 'Sully_Rescue_Backup_2026-11-28.zip',
    shareTitle: 'SullyOS 紧急抢救备份',
    nativeChunked: true,
  });
  expect(host.textContent).toContain('已取消保存');
  expect(mocks.track).toHaveBeenCalledWith('保存数据库抢救备份', { 结果: '取消' });

  // Second save attempt: shared via system sheet -> reported as shared, never leaks character IDs or names to analytics
  mocks.shareBlob.mockResolvedValueOnce('shared');
  await act(async () => { saveBtn.click(); });
  expect(host.textContent).toContain('已拉起系统分享');
  expect(mocks.track).toHaveBeenCalledWith('保存数据库抢救备份', { 结果: '已分享' });
  mocks.shareBlob.mockResolvedValueOnce('downloaded');
  await act(async () => { saveBtn.click(); });
  expect(mocks.track).toHaveBeenCalledWith('保存数据库抢救备份', { 结果: '已下载' });
  mocks.shareBlob.mockRejectedValueOnce(new Error('secret-char-id'));
  await act(async () => { saveBtn.click(); });
  expect(mocks.track).toHaveBeenCalledWith('保存数据库抢救备份', { 结果: '失败' });
  mocks.rescueExport.mockRejectedValueOnce(new Error('secret-char-id'));
  const regenerate = Array.from(host.querySelectorAll('button')).find(b => b.textContent === '重新生成')!;
  await act(async () => { regenerate.click(); });
  expect(mocks.track).toHaveBeenCalledWith('导出数据库抢救备份', { 结果: '失败' });
  expect(host.textContent).not.toContain('保存抢救备份 (.zip)');
  expect(host.textContent).toContain('生成抢救备份包');
  expect(JSON.stringify(mocks.track.mock.calls)).not.toContain('secret-char-id');
  expect(JSON.stringify(mocks.track.mock.calls)).not.toContain('秘密名字');
});

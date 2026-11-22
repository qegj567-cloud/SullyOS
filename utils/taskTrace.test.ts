/**
 * 中断留痕的通用部分：按步骤留痕的写入、节流、删除，启动时多份留痕各报一条，以及所有留痕键都不进备份、不随迁入带走。
 * 留痕本身只在闪退、被系统杀掉时才该留下来，所以「中途消失」就是开了留痕、不调 clear() 直接去读。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeTaskTrace, isTaskTraceKey, startStepTrace, STEP_TRACE_KINDS } from './taskTrace';
import { collectStartupTraceReports, TASK_TRACE_KINDS } from './taskTraceReport';
import { createExportTrace, EXPORT_TRACE_KEY } from './backupExportTrace';
import { createImportProgressMarker, IMPORT_IN_PROGRESS_KEY } from './backupImportPolicy';
import { isSharedSpaceKey } from './userSpaces';
import { canMigrateLocalKey } from './independentUserRemap';

const keyOf = (name: string) => STEP_TRACE_KINDS.find(kind => kind.key.includes(name))!.key;
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('startStepTrace', () => {
    it('writes right away, writes again whenever the step changes, and throttles progress within one step', () => {
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        const trace = startStepTrace('optimize', { 说明: '测试' });
        const read = () => JSON.parse(localStorage.getItem(keyOf('optimize'))!);
        expect(read()).toMatchObject({ version: 1, step: '开始', facts: { 说明: '测试' } });
        trace.step('系统外观', 1, 100, '项');
        expect(read()).toMatchObject({ step: '系统外观', done: 1, total: 100 });
        clock += 100;
        trace.step('系统外观', 2, 100, '项');
        expect(read().done).toBe(1); // 同一步里 500ms 内的进度不写
        clock += 600;
        trace.step('系统外观', 3, 100, '项');
        expect(read().done).toBe(3);
        trace.step('角色头像', 4, 100, '项');
        expect(read()).toMatchObject({ step: '角色头像', done: 4 });
        trace.clear();
        expect(localStorage.getItem(keyOf('optimize'))).toBeNull();
    });

    it('turns a leftover trace into readable log text once, then the key is gone', () => {
        vi.stubGlobal('__APP_BUILD_ID__', 'build-test');
        const trace = startStepTrace('cloudUpload', { 云端: 'GitHub', 备份大小: '12.0 MB' });
        trace.step('上传第 2 / 3 片', 8 * 1024 * 1024, 12 * 1024 * 1024, 'B');
        // 闪退：没有调用 clear()。
        const kind = STEP_TRACE_KINDS.find(k => k.key === keyOf('cloud_upload'))!;
        const report = consumeTaskTrace(kind)!;
        expect(report.title).toBe('上次云端备份上传没有完成');
        expect(report.detail.split('\n')).toEqual(expect.arrayContaining([
            '停在：上传第 2 / 3 片', '进度：8.0 MB / 12.0 MB', '云端：GitHub', '备份大小：12.0 MB', '构建：build-test',
        ]));
        expect(report.detail).toMatch(/^开始时间：.*持续了 \d+ 秒$/m);
        expect(localStorage.getItem(kind.key)).toBeNull();
        expect(consumeTaskTrace(kind)).toBeNull();
    });

    it('keeps working when localStorage refuses the write', () => {
        const storage = { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); }, removeItem: () => {} };
        expect(() => startStepTrace('singleExport', {}, storage).step('压缩', 10, 100, '%')).not.toThrow();
    });
});

describe('collectStartupTraceReports', () => {
    it('reports every leftover trace separately, clears the traces and leaves the import marker for the reimport prompt', () => {
        createExportTrace({ mode: 'full', scope: 'all', onDisk: true }).table('小明', 'messages', 10);
        startStepTrace('singleExport').step('打包第 3 / 40 张表 · messages', 500, undefined, '条');
        startStepTrace('cloudDownload', { 云端: 'WebDAV' }).step('分段下载', 0, 100, 'B');
        startStepTrace('optimize').step('压缩记忆向量', 3, 9, '项');
        const marker = createImportProgressMarker('backup.zip');
        marker.beginWrite();
        marker.update('database', { stage: '正在写入', current: '小明 · memory_links', itemDone: 37, itemTotal: 1000 });

        const reports = collectStartupTraceReports();
        expect(reports.map(r => r.title)).toEqual([
            '上次备份导出没有完成', '上次备份导出没有完成', '上次云端备份下载没有完成', '上次一键优化没有完成', '上次备份恢复没有完成',
        ]);
        expect(reports[0].detail).toContain('停在：小明 · messages（正在读取第 1 页）');
        expect(reports[1].detail).toContain('停在：打包第 3 / 40 张表 · messages\n进度：500 条');
        expect(reports[2].detail).toContain('云端：WebDAV');
        expect(reports[3].detail).toContain('进度：3 项 / 9 项');
        expect(reports[4].detail).toContain('停在：写入数据库 · 正在写入\n当前部分：小明 · memory_links\n进度：37 / 1000');
        expect(reports[4].detail).not.toContain('backup.zip');
        for (const kind of TASK_TRACE_KINDS) expect(localStorage.getItem(kind.key), kind.key).toBeNull();
        expect(localStorage.getItem(IMPORT_IN_PROGRESS_KEY)).not.toBeNull();
        // 没有重新导入成功之前，下次启动还会再报一次恢复中断，其余的不再重复。
        expect(collectStartupTraceReports().map(r => r.key)).toEqual([IMPORT_IN_PROGRESS_KEY]);
    });

    it('reports nothing when nothing was left behind, and a broken trace still gets a line', () => {
        localStorage.setItem('chat_bg', 'blue');
        expect(collectStartupTraceReports()).toEqual([]);
        localStorage.setItem(keyOf('cloud_download'), '{broken');
        expect(collectStartupTraceReports()).toEqual([expect.objectContaining({ title: '上次云端备份下载没有完成', detail: '诊断信息读不出来了。' })]);
        expect(localStorage.getItem('chat_bg')).toBe('blue');
    });
});

describe('trace keys are device state', () => {
    it('every trace key is recognised as a trace, shared by all user spaces, and never migrated into an independent user', () => {
        expect(TASK_TRACE_KINDS.map(kind => kind.key)).toContain(EXPORT_TRACE_KEY);
        expect(new Set(TASK_TRACE_KINDS.map(kind => kind.key)).size).toBe(TASK_TRACE_KINDS.length);
        for (const { key } of TASK_TRACE_KINDS) {
            expect(isTaskTraceKey(key), key).toBe(true);
            expect(isSharedSpaceKey(key), key).toBe(true);
            expect(canMigrateLocalKey(key), key).toBe(false);
        }
        expect(isTaskTraceKey('sullyos_notice_restore_damaged_assets_v1')).toBe(false);
    });
});

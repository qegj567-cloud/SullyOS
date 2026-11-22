/**
 * 启动时读导出留痕：有留痕就生成一条能读懂的日志文本并删键（同一份只报一次），没有就什么都不做。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { consumeExportTrace, createExportTrace, EXPORT_TRACE_KEY } from './backupExportTrace';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('turns a leftover trace into log text once and clears the key', () => {
    vi.stubGlobal('__APP_BUILD_ID__', 'build-test');
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock += 600);
    const trace = createExportTrace({ mode: 'text_only', scope: 'all', onDisk: true, startedAt: Date.now() - 23_000 });
    trace.table('小明', 'memories', 5000);
    trace.pageRead({ rows: new Array(5000), bytes: 2_000_000, maxRowBytes: 2048, maxRowKey: 'm_1' });
    trace.pageWritten();
    trace.table('小明', 'memory_links', 1_000_000);
    trace.pageRead({ rows: new Array(1000), bytes: 4_000_000, maxRowBytes: 12 * 1024 * 1024, maxRowKey: ['l', 'x'.repeat(200)] });
    trace.written(12_900_000);
    trace.pageWritten();
    // 闪退：没有调用 clear()，键留在 localStorage 里。
    const stored = JSON.parse(localStorage.getItem(EXPORT_TRACE_KEY)!);
    expect(stored.current.maxRowKey).toHaveLength(80);
    expect(stored.build).toBe('build-test');

    const log = consumeExportTrace();
    expect(log?.title).toBe('上次备份导出没有完成');
    expect(log!.detail).toContain('停在：小明 · memory_links（正在读取第 2 页）');
    expect(log!.detail).toContain('已读 / 总条数：1000 / 1000000');
    expect(log!.detail).toContain('这张表最大的一条：约 12.0 MB');
    expect(log!.detail).toContain('前一张表：小明 · memories，已读 5000 / 5000 条，共 1 页，最大的一条约 2.0 KB（编号 m_1）');
    expect(log!.detail).toContain('写在磁盘上');
    expect(log!.detail).toContain('构建：build-test');
    expect(localStorage.getItem(EXPORT_TRACE_KEY)).toBeNull();
    expect(consumeExportTrace()).toBeNull();
});

it('does nothing when there is no trace', () => {
    localStorage.setItem('chat_bg', 'blue');
    expect(consumeExportTrace()).toBeNull();
    expect(localStorage.getItem('chat_bg')).toBe('blue');
});

it('still reports and clears a trace it cannot parse', () => {
    localStorage.setItem(EXPORT_TRACE_KEY, '{broken');
    expect(consumeExportTrace()).toEqual({ title: '上次备份导出没有完成', detail: '诊断信息读不出来了。' });
    expect(localStorage.getItem(EXPORT_TRACE_KEY)).toBeNull();
});

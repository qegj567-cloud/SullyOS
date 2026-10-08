import { describe, expect, it, vi } from 'vitest';
import { createCloudDataSession, cloudResourceIdentity, describeCloudOperation, mergeCloudResourcePage, readCloudPageSummary } from './amsgCloudData';

const resource = (id: string, owner: any = null) => ({ id, type: 'state' as const, owner, kind: 'context', label: 'fire_pack', byteSize: 128, updatedAt: 1, status: null });
const plan = { id: 'plan-1', mode: 'purge' as const, owner: null, resources: [resource('r1')], count: 1, expiresAt: Date.now() + 60_000, counts: [{ type: 'state' as const, count: 1 }], impacts: [], complete: true, gaps: [] };
const transport = () => ({
  getCapabilities: vi.fn(async () => ({ features: ['cloud-data-management'] })),
  listCloudDataResources: vi.fn(async () => ({ success: true, data: { resources: [resource('r1')], nextCursor: 'next', complete: false, gaps: [{ source: 'task', code: 'UNREADABLE', message: '部分任务无法读取' }] } })),
  createCloudDataCleanupPlan: vi.fn(async () => ({ success: true, data: plan })),
  startCloudDataCleanup: vi.fn(async () => ({ success: true, data: { id: 'op-1', planId: 'plan-1', mode: 'purge', owner: null, status: 'pending', counts: [], errors: [], createdAt: 1, updatedAt: 1 } })),
});

describe('服务端云端管理接入', () => {
  it('新版清单直接复用同一份摘要，不额外请求全库清点', async () => {
    const summary = { total: 1, counts: [], complete: true, gaps: [] };
    const session = { summary: vi.fn(async () => { throw new Error('不应重新清点'); }) };
    expect(await readCloudPageSummary(session as any, { summary } as any)).toEqual(summary);
    expect(session.summary).not.toHaveBeenCalled();
  });

  it('旧 Worker 没有随页摘要时仍能按原接口显示摘要', async () => {
    const summary = { total: 1, counts: [], complete: true, gaps: [] };
    const session = { summary: vi.fn(async () => summary) };
    expect(await readCloudPageSummary(session as any, { resources: [] } as any)).toEqual(summary);
    expect(session.summary).toHaveBeenCalledTimes(1);
  });
  it('不接收本地角色清单，保留服务端分页和缺口', async () => {
    const session = await createCloudDataSession(transport() as any, { workerUrl: 'https://old.example', userId: 'u1' });
    const result = await session.listResources();
    expect(result.resources.map(row => row.id)).toEqual(['r1']);
    expect(result.nextCursor).toBe('next');
    expect(result.complete).toBe(false);
    expect(result.gaps[0].code).toBe('UNREADABLE');
  });

  it('旧 Worker 和能力探测失败分别报不支持与无法确认，不退成空清单', async () => {
    const api = transport();
    api.getCapabilities.mockResolvedValueOnce({ features: [] });
    await expect(createCloudDataSession(api as any, { workerUrl: 'https://old.example', userId: 'u1' }))
      .rejects.toMatchObject({ code: 'CLOUD_DATA_UNSUPPORTED' });
    api.getCapabilities.mockRejectedValueOnce(new Error('网络断开'));
    await expect(createCloudDataSession(api as any, { workerUrl: 'https://old.example', userId: 'u1' }))
      .rejects.toThrow('网络断开');
  });

  it('空选择不能扩大成全删，不完整或过期预览不能执行', async () => {
    const api = transport();
    const session = await createCloudDataSession(api as any, { workerUrl: 'https://old.example', userId: 'u1' });
    await expect(session.prepare({ mode: 'purge', resourceIds: [] })).rejects.toThrow('选择');
    await expect(session.start({ ...plan, complete: false }, 'request-1')).rejects.toThrow('完整');
    await expect(session.start({ ...plan, expiresAt: 1 }, 'request-1')).rejects.toThrow('过期');
    expect(api.startCloudDataCleanup).not.toHaveBeenCalled();
  });

  it('请求交给原连接，待处理不算完成；失败保留服务端错误码供重新预览', async () => {
    const api = transport();
    const connection = { workerUrl: 'https://old.example', userId: 'u1' };
    const session = await createCloudDataSession(api as any, connection);
    connection.workerUrl = 'https://new.example';
    expect(session.workerUrl).toBe('https://old.example');
    const operation = await session.start(plan, 'request-1');
    expect(describeCloudOperation(operation).complete).toBe(false);
    expect(api.startCloudDataCleanup).toHaveBeenCalledWith({ planId: 'plan-1', idempotencyKey: 'request-1' });
    api.startCloudDataCleanup.mockResolvedValueOnce({ success: false, error: { code: 'PLAN_STALE', message: '清单已变化，请重新预览' } } as any);
    await expect(session.start(plan, 'request-1')).rejects.toMatchObject({ code: 'PLAN_STALE' });
  });
});

describe('云端清单显示边界', () => {
  it('优先显示云端名称，本机缺失不能被叫作已删除', () => {
    expect(cloudResourceIdentity(resource('r1', { type: 'character', id: 'c1', label: '云端旧名' }), [{ id: 'c1', name: '本地别名' }]))
      .toEqual({ name: '云端旧名', detail: 'c1', local: true });
    expect(cloudResourceIdentity(resource('r2', { type: 'character', id: 'gone' }), []))
      .toEqual({ name: '未命名角色', detail: 'gone', local: false });
    expect(cloudResourceIdentity(resource('unknown'), [])).toEqual({ name: '归属未知', detail: 'unknown', local: false });
  });

  it('翻页保留已读取记录，以资源 ID 去重，不按同名角色合并', () => {
    const a = resource('a', { type: 'character', id: 'c1', label: '同名' });
    const b = resource('b', { type: 'character', id: 'c2', label: '同名' });
    expect(mergeCloudResourcePage([a], [a, b]).map(row => row.id)).toEqual(['a', 'b']);
  });

  it('即使响应写 completed，只要有失败或未完成项目也不显示已清干净', () => {
    const operation: any = { status: 'completed', counts: [{ type: 'state', deleted: 1, remaining: 1, failed: 0 }], errors: [] };
    expect(describeCloudOperation(operation).complete).toBe(false);
    expect(describeCloudOperation({ ...operation, counts: [{ type: 'state', deleted: 2, remaining: 0, failed: 0 }] }).complete).toBe(true);
  });
});

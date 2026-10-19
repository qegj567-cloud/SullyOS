import { describe, expect, it } from 'vitest';
import { packStateValue } from '../../../utils/amsgFirePack';
import { resolveSullyCloudOwnership } from './cloudDataOwnership';

describe('云端资源归属（不读取本地角色）', async () => {
  it('仅有角色命名空间也能识别，日志和旁路内容归同一个角色', async () => {
    expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:char:char-gone', key: 'reasoning:old' }))
      .toEqual({ owner: { type: 'character', id: 'char-gone' }, kind: 'sidechannel' });
    expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:char:char-gone', key: 'fire_pack' }))
      .toEqual({ owner: { type: 'character', id: 'char-gone' }, kind: 'context' });
  });

  it('从任务自身恢复稳定 ID 和名称，不按同名联系人猜归属', async () => {
    expect(await resolveSullyCloudOwnership({ type: 'task', payload: {
      metadata: { charId: 'char-1' }, contactName: '小满', messageSubtype: 'instant-chat',
    } })).toEqual({ owner: { type: 'character', id: 'char-1', label: '小满' }, kind: 'instant-chat' });
    expect(await resolveSullyCloudOwnership({ type: 'task', payload: { contactName: '小满' } })).toBeNull();
  });

  it('凭据用途从完整约定解析，不把其他应用的凭据当成角色', async () => {
    expect(await resolveSullyCloudOwnership({ type: 'credential', credId: 'char:char-old/memory' }))
      .toEqual({ owner: { type: 'character', id: 'char-old' }, kind: 'credential-memory' });
    expect(await resolveSullyCloudOwnership({ type: 'credential', credId: 'global/weather' })).toBeNull();
    expect(await resolveSullyCloudOwnership({ type: 'credential', credId: 'char:char-old/unknown' })).toBeNull();
  });

  it('共享 job 命名空间按每份有效输入分归属，不整体归给一个角色', async () => {
    expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:job', key: 'plate:job-1', value: JSON.stringify({
      v: 1, charId: 'char-1', charName: '小满', userName: '用户', identityContext: '', rooms: [], materials: [],
    }) })).toEqual({ owner: { type: 'character', id: 'char-1', label: '小满' }, kind: 'job-input' });
    expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:job', key: 'plate:job-2', value: '{broken' })).toBeNull();
    expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:job', key: 'other:job-2', value: '{"charId":"char-1"}' })).toBeNull();
  });

  it('全局状态与推送订阅不随角色删除，未知记录保持可见但不猜归属', async () => {
    expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:global', key: 'tool_config' }))
      .toEqual({ owner: null, kind: 'global-state' });
    expect(await resolveSullyCloudOwnership({ type: 'subscription' })).toEqual({ owner: null, kind: 'global-subscription' });
    expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:char:', key: 'fire_pack' })).toBeNull();
  });

  it('已完成任务消失后，结果仍能按自己的角色 ID 归属', async () => {
    expect(await resolveSullyCloudOwnership({ type: 'outbox', payload: { charId: 'char-gone', resultKind: 'plate-consolidate' } }))
      .toEqual({ owner: { type: 'character', id: 'char-gone' }, kind: 'job-result' });
    expect(await resolveSullyCloudOwnership({ type: 'outbox', payload: { metadata: { charId: 'char-2' }, message: '私密正文' } }))
      .toEqual({ owner: { type: 'character', id: 'char-2' }, kind: 'message-result' });
  });
});

it('压缩过的旧后台输入仍能认出归属', async () => {
  const value = await packStateValue(JSON.stringify({ v: 1, charId: 'char-compressed', charName: '旧名字', userName: '用户', identityContext: '正文'.repeat(15000), rooms: [], materials: [] }));
  expect(value.startsWith('gz1:')).toBe(true);
  expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:job', key: 'plate:old', value }))
    .toEqual({ owner: { type: 'character', id: 'char-compressed', label: '旧名字' }, kind: 'job-input' });
});

it('旧结果本身没有角色编号时，使用上游提供的关联任务身份', async () => {
  expect(await resolveSullyCloudOwnership({ type: 'outbox', payload: { message: '旧结果正文' }, task: { metadata: { charId: 'char-legacy' }, contactName: '旧名字' } }))
    .toEqual({ owner: { type: 'character', id: 'char-legacy', label: '旧名字' }, kind: 'message-result' });
});

it('只有旧上下文时仍可从工具资料恢复名字，不把正文当名字', async () => {
  const value = JSON.stringify({ v: 1, charName: '云端旧名字', timeAwarenessEnabled: true, activeMemoryMonths: [], memories: [] });
  expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:char:only-state', key: 'tool_pack', value }))
    .toEqual({ owner: { type: 'character', id: 'only-state', label: '云端旧名字' }, kind: 'context' });
});

it('classifies generic attachment envelopes by their explicit character owner', async () => {
  expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:attachments', key: 'random-attachment',
    value: JSON.stringify({ version: 1, owner: { type: 'character', id: 'char-attachment' }, kind: 'sidechannel', value: 'private-card' }),
  })).toEqual({ owner: { type: 'character', id: 'char-attachment' }, kind: 'sidechannel' });
});

it('immutable instant inputs retain character ownership even after the task is deleted', async () => {
  expect(await resolveSullyCloudOwnership({ type: 'state', namespace: 'amsg:instant-input', key: 'unique-input',
    value: JSON.stringify({ v: 1, charId: 'input-owner', packedFirePack: '{"chat":{}}' }),
  })).toEqual({ owner: { type: 'character', id: 'input-owner' }, kind: 'instant-input' });
});

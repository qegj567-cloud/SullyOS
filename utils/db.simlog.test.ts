import { describe, it, expect } from 'vitest';
import { DB } from './db';
import type { CharacterProfile } from '../types';

// 复现「人格模拟生活记录导出再导入后消失」的报障：
// simLogs 存在 char.phoneState.simLogs，应随角色一起 round-trip。
describe('生活记录 (phoneState.simLogs) 导出/导入 round-trip', () => {
  it('exportFullData → JSON → importFullData 后 simLogs 仍在', async () => {
    const char = {
      id: 'sim-rt-char',
      name: '阿狸',
      persona: '测试角色',
      phoneState: {
        records: [],
        simLogs: [
          // 新版：带完整脚本快照（可重播），导出导入须把 script.beats 一起带走
          { id: 'sim-1', mode: 'daily', theme: '雨天', title: '一个雨天', summary: '', ending: 'soft', beatsCount: 12, memoryText: '下了一天的雨。', timestamp: 1718900000000,
            playback: { beatIndex: 1, status: 'playing' },
            script: { title: '一个雨天', summary: '', ending: 'soft', beats: [
              { kind: 'lock', time: '07:00', monologue: '不想起床。' },
              { kind: 'thought', monologue: '又下雨了。', vibe: 'numb' },
              { kind: 'end' },
            ] } },
          // 旧版：没有 script 快照，导入后仍应保持「没有」（只能发送、不能重播）
          { id: 'sim-2', mode: 'event', theme: '搬家', title: '搬家那天', summary: '', ending: 'open', beatsCount: 20, memoryText: '箱子堆满了客厅。', timestamp: 1718990000000 },
        ],
      },
    } as unknown as CharacterProfile;

    await DB.saveCharacter(char);

    // 1) 导出（DB 层路径，等价于设置-导出读 characters store 的内容）
    const exported = await DB.exportFullData();
    // 2) 模拟写文件 + 读文件
    const onDisk = JSON.parse(JSON.stringify(exported));

    // 导出物里必须带着 simLogs
    const exportedChar = (onDisk.characters as CharacterProfile[]).find(c => c.id === 'sim-rt-char');
    expect(exportedChar?.phoneState?.simLogs?.length).toBe(2);

    // 3) 清掉再导入
    await DB.saveCharacter({ ...char, phoneState: { records: [] } } as any); // 模拟导入前本地无记录
    await DB.importFullData(onDisk as any, {});

    // 4) 导入后从 DB 重新读
    const all = await DB.getAllCharacters();
    const restored = all.find(c => c.id === 'sim-rt-char');
    const restoredLogs = restored?.phoneState?.simLogs;
    expect(restoredLogs?.length).toBe(2);
    expect(restoredLogs?.[0].memoryText).toBe('下了一天的雨。');
    // 新版脚本快照完整 round-trip → 导入后仍可重播
    expect(restoredLogs?.[0].script?.beats?.length).toBe(3);
    expect(restoredLogs?.[0].script?.beats?.[0].monologue).toBe('不想起床。');
    expect(restoredLogs?.[0].playback).toEqual({ beatIndex: 1, status: 'playing' });
    // 旧版没有 script，导入后依旧没有（不会凭空冒出来）
    expect(restoredLogs?.[1].script).toBeUndefined();
  });
});

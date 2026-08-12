/**
 * amsgToolPack 回归测试：构建 ↔ 解析往返、坏数据回退 null（worker 端 fire 链
 * 依赖「parse 失败 = 无工具数据继续跑」这个契约，别让它变成抛错）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildToolConfig,
  buildToolPack,
  parseToolConfig,
  parseToolPack,
} from './amsgToolPack';
import type { CharacterProfile, RealtimeConfig } from '../types';

describe('buildToolPack / parseToolPack', () => {
  it('构建后 JSON 往返还原，memories 只留 date/summary/mood', () => {
    const char = {
      id: 'c1',
      name: '小鹿',
      xhsEnabled: true,
      activeMemoryMonths: ['2026-06'],
      memories: [
        { id: 'm1', date: '2026-06-12', summary: '一起看了落日', mood: 'happy' },
        { id: 'm2', date: '2026-05-01', summary: '吵了一小架' },
      ],
    } as unknown as CharacterProfile;

    const pack = buildToolPack(char);
    const parsed = parseToolPack(JSON.stringify(pack));

    expect(parsed).toEqual({
      v: 1,
      charName: '小鹿',
      xhsEnabled: true,
      activeMemoryMonths: ['2026-06'],
      memories: [
        { date: '2026-06-12', summary: '一起看了落日', mood: 'happy' },
        { date: '2026-05-01', summary: '吵了一小架' },
      ],
      timeAwarenessEnabled: true,
    });
    expect(JSON.stringify(pack)).not.toContain('"id"');
  });

  it('缺字段的角色（老档案）也能出合法 pack', () => {
    const pack = buildToolPack({ id: 'c2', name: '阿绫' } as unknown as CharacterProfile);
    expect(parseToolPack(JSON.stringify(pack))).toEqual({
      v: 1,
      charName: '阿绫',
      xhsEnabled: false,
      activeMemoryMonths: [],
      memories: [],
      timeAwarenessEnabled: true,
    });
  });

  it('坏数据一律 null：非 JSON / 形状不对 / 版本不认识', () => {
    expect(parseToolPack('not json')).toBeNull();
    expect(parseToolPack('{"v":1}')).toBeNull();
    expect(parseToolPack(JSON.stringify({ v: 2, charName: 'x', activeMemoryMonths: [], memories: [] }))).toBeNull();
  });

  it('角色关掉时间感知 → 这个开关跟着上云（不然主动消息里照样过节）', () => {
    const off = buildToolPack({ id: 'c3', name: '零', timeAwarenessEnabled: false } as unknown as CharacterProfile);
    expect(off.timeAwarenessEnabled).toBe(false);
    expect(parseToolPack(JSON.stringify(off))?.timeAwarenessEnabled).toBe(false);
    // 没这个字段的包一律打回：worker 拿不到开关就只能猜，而猜错就是穿帮。
    const { timeAwarenessEnabled: _dropped, ...missing } = off;
    expect(parseToolPack(JSON.stringify(missing))).toBeNull();
  });

  it('Prompt 控制关掉时间感知 → tool_pack 也跟着关，Worker 不能补回节日', () => {
    const pack = buildToolPack(
      { id: 'c4', name: '澪', timeAwarenessEnabled: true } as unknown as CharacterProfile,
      { timeAwareness: false, realtimeState: true, mcpTools: true },
    );
    expect(pack.timeAwarenessEnabled).toBe(false);
    expect(parseToolPack(JSON.stringify(pack))?.timeAwarenessEnabled).toBe(false);
  });
});

describe('buildToolConfig / parseToolConfig', () => {
  it('只收工具子集字段，空值不写键', () => {
    const rc = {
      newsEnabled: true,
      newsApiKey: 'brave-key',
      notionEnabled: true,
      notionApiKey: 'ntn-key',
      notionDatabaseId: 'db1',
      feishuEnabled: false,
      xhsMcpConfig: { enabled: true, serverUrl: 'https://xhs.example.com/api', cookie: 'ck', platform: 'rednote' },
      // 天气不是工具，但 worker 到点要自己拉一次填进提示词，所以也得上云
      weatherEnabled: true,
      weatherCity: '上海',
      newsPlatforms: ['weibo', 'zhihu'],
    } as unknown as RealtimeConfig;

    const config = buildToolConfig(rc);
    const parsed = parseToolConfig(JSON.stringify(config));

    expect(parsed?.newsApiKey).toBe('brave-key');
    expect(parsed?.notionDatabaseId).toBe('db1');
    expect(parsed?.xhsMcpConfig).toEqual({ enabled: true, serverUrl: 'https://xhs.example.com/api', cookie: 'ck', platform: 'rednote' });
    expect(typeof parsed?.proxyWorkerUrl).toBe('string');
    expect(parsed?.proxyWorkerUrl).toMatch(/^https?:\/\//);
    // 到点组提示词要用的实时世界配置：天气开关 + 城市 + 热榜平台
    expect(parsed?.weatherEnabled).toBe(true);
    expect(parsed?.weatherCity).toBe('上海');
    expect(parsed?.newsPlatforms).toEqual(['weibo', 'zhihu']);
    // 未配置的可选键不写（省 payload，也避免 undefined 序列化怪态）
    expect('feishuAppId' in config).toBe(false);
  });

  it('无 realtimeConfig 时出全禁用配置（而不是抛错）', () => {
    const config = buildToolConfig(undefined);
    expect(config.newsEnabled).toBe(false);
    expect(config.weatherEnabled).toBe(false);
    expect('weatherCity' in config).toBe(false);
    expect('newsPlatforms' in config).toBe(false);
    expect(config.notionEnabled).toBe(false);
    expect(config.feishuEnabled).toBe(false);
    expect(config.xhsMcpConfig).toBeUndefined();
  });

  it('坏数据一律 null', () => {
    expect(parseToolConfig('not json')).toBeNull();
    expect(parseToolConfig('{"v":1}')).toBeNull();
  });

  it('mcp 配置随 tool_config 往返, 坏条目被丢弃', () => {
    const servers = [{
      id: 's1', name: '探针', url: 'https://probe.example.com',
      token: 'tok', tools: [{ name: 'get_secret' }],
    }];
    const config = buildToolConfig(undefined, { servers, useNativeTools: false });
    const parsed = parseToolConfig(JSON.stringify(config));
    expect(parsed?.mcpServers).toEqual(servers);
    expect(parsed?.mcpUseNativeTools).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dirty = { ...config, mcpServers: [servers[0], { id: 'bad' }, null, { name: 'x', url: 'u' }] };
    expect(parseToolConfig(JSON.stringify(dirty))?.mcpServers).toEqual(servers);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('Prompt 控制状态随 tool_config 上云，Worker 到点按同一份开关裁剪工具块', () => {
    const config = buildToolConfig(
      undefined,
      { servers: [{ id: 's1', name: '探针', url: 'https://probe.example.com', tools: [] }], useNativeTools: true },
      { mcpTools: false, realtimeState: false, timeAwareness: false },
    );
    const parsed = parseToolConfig(JSON.stringify(config));

    expect(parsed?.promptControls).toEqual({
      mcpTools: false,
      realtimeState: false,
      timeAwareness: false,
    });
  });

  it('整份清单都坏时两个字段一起消失, 并且留一条 warn', () => {
    const config = buildToolConfig(undefined, {
      servers: [{ id: 's1', name: '探针', url: 'https://probe.example.com', tools: [] }],
      useNativeTools: false,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseToolConfig(JSON.stringify({ ...config, mcpServers: [{ id: 'bad' }, null] }));

    expect(parsed).not.toBeNull();
    expect('mcpServers' in parsed!).toBe(false);
    expect('mcpUseNativeTools' in parsed!).toBe(false);
    // 其余凭据字段不受牵连
    expect(typeof parsed?.proxyWorkerUrl).toBe('string');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('不传 mcp 配置时两个字段都不出现（老 worker 解析零影响）', () => {
    const config = buildToolConfig(undefined);
    expect('mcpServers' in config).toBe(false);
    expect('mcpUseNativeTools' in config).toBe(false);
  });
});

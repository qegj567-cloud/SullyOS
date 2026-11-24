// utils/amsgLlmCredentials.test.ts
//
// 回归守卫（凭据行本身）：
//   1. 起名。三种用途各一行，名字进了任务就不再改——名字错一次，云端那行永远没人认领，
//      任务到点只会报「凭据不存在」。
//   2. 取值。角色开了「单独 API」时定时消息那行必须写单独 API 的值；情绪评估没单独配
//      时回落到全局聊天 API。算错等于用户以为在用 A 模型、实际云端在用 B。
//   3. 指纹门控。值没变就不该重传（每次排程 / 每条消息都白发一次 PUT），变了必须重传
//      （不然换完 Key 云端还是旧的，已排任务到点全 401）。
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildCharChatCredRow,
  buildCharEmotionCredRow,
  buildCharInstantCredRow,
  charCredId,
  charCredIds,
  chunkCredRows,
  forgetAllCredIds,
  forgetCredIds,
  knownCredIds,
  normalizeChatApiUrl,
  parseCharCredId,
  pickChangedCredRows,
  rememberCredRows,
  supportsLlmCredentials,
  toCredentialValue,
} from './amsgLlmCredentials';

const CHAR = { id: 'char-1' } as any;
const API = { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'gpt-global' };
const SECONDARY = { baseUrl: 'https://alt.example.dev/v1', apiKey: 'sk-alt', model: 'gpt-alt' };

beforeEach(() => {
  forgetAllCredIds();
});

describe('能力位', () => {
  it('features 里有 llm-credentials 才算达标', () => {
    expect(supportsLlmCredentials(['client-state', 'llm-credentials'])).toBe(true);
    expect(supportsLlmCredentials(['client-state'])).toBe(false);
  });

  it('探不到（null / undefined）一律不达标——不知道 ≠ 可以用新写法', () => {
    expect(supportsLlmCredentials(null)).toBe(false);
    expect(supportsLlmCredentials(undefined)).toBe(false);
  });
});

describe('credId 起名', () => {
  it('每种用途各一个名字，拆得回去', () => {
    expect(charCredId('c1', 'chat')).toBe('char:c1/chat');
    expect(charCredId('c1', 'instant')).toBe('char:c1/instant');
    expect(charCredId('c1', 'emotion')).toBe('char:c1/emotion');
    expect(charCredId('c1', 'memory')).toBe('char:c1/memory');
    expect(charCredIds('c1')).toEqual([
      'char:c1/chat', 'char:c1/instant', 'char:c1/emotion', 'char:c1/memory',
      'char:c1/gen-schedule', 'char:c1/gen-persona-sim', 'char:c1/gen-dream',
    ]);
    expect(parseCharCredId('char:c1/emotion')).toEqual({ charId: 'c1', purpose: 'emotion' });
    expect(parseCharCredId('char:c1/memory')).toEqual({ charId: 'c1', purpose: 'memory' });
    expect(parseCharCredId('char:c1/gen-persona-sim')).toEqual({ charId: 'c1', purpose: 'gen-persona-sim' });
  });

  // 回归守卫：删角色时按 charCredIds 清云端凭据行。用途表漏了一档，那一行就永远留在
  // 云端 —— 角色删了，他那份副 API 的 Key 还在别人的 D1 里躺着。
  it('新增用途必须同时进 ALL_CREDENTIAL_PURPOSES 和 parseCharCredId', () => {
    for (const credId of charCredIds('c1')) {
      expect(parseCharCredId(credId)).not.toBeNull();
    }
  });

  it('不认识的形状拆出来是 null（别把别人的键当成角色凭据去重算）', () => {
    expect(parseCharCredId('global/chat')).toBeNull();
    expect(parseCharCredId('char:c1/whatever')).toBeNull();
    expect(parseCharCredId('')).toBeNull();
  });

  it('名字在上游的长度上限（128）之内', () => {
    // 角色 id 是 uuid，最长的那个名字也就四十来个字符。
    expect(charCredId('7f2b1c8a-9d4e-4a1b-8c2d-000000000001', 'instant').length).toBeLessThanOrEqual(128);
  });
});

describe('凭据行取值', () => {
  it('地址归一成 /chat/completions（任务行里存的是终点地址）', () => {
    expect(normalizeChatApiUrl('https://api.example.dev/v1/')).toBe('https://api.example.dev/v1/chat/completions');
    expect(toCredentialValue(API)).toEqual({
      apiUrl: 'https://api.example.dev/v1/chat/completions',
      apiKey: 'sk-global',
      primaryModel: 'gpt-global',
    });
  });

  it('缺地址 / 缺模型 → null（一份配不齐的凭据不该被写到云端）', () => {
    expect(toCredentialValue({ baseUrl: '', apiKey: 'k', model: 'm' })).toBeNull();
    expect(toCredentialValue({ baseUrl: 'https://x.dev', apiKey: 'k', model: '' })).toBeNull();
  });

  it('定时消息那行：没开单独 API → 全局聊天 API', () => {
    const row = buildCharChatCredRow(CHAR, { enabled: true } as any, API);
    expect(row).toEqual({
      credId: 'char:char-1/chat',
      value: { apiUrl: 'https://api.example.dev/v1/chat/completions', apiKey: 'sk-global', primaryModel: 'gpt-global' },
    });
  });

  it('旧备份带单独 API 时，定时消息仍使用主 API', () => {
    const row = buildCharChatCredRow(
      CHAR, { enabled: true, useSecondaryApi: true, secondaryApi: SECONDARY } as any, API,
    );
    expect(row?.value).toEqual({
      apiUrl: 'https://api.example.dev/v1/chat/completions', apiKey: 'sk-global', primaryModel: 'gpt-global',
    });
  });

  it('定时消息那行：开关开着但单独 API 没填地址 → 回落全局（口径同排程时的 resolveApiConfig）', () => {
    const row = buildCharChatCredRow(
      CHAR, { enabled: true, useSecondaryApi: true, secondaryApi: { baseUrl: '', apiKey: '', model: '' } } as any, API,
    );
    expect(row?.value.primaryModel).toBe('gpt-global');
  });

  it('即时对话那行：原样收下当轮终值（claude 系开思考时的 -thinking 后缀不能被抹掉）', () => {
    const row = buildCharInstantCredRow('char-1', {
      baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'claude-sonnet-4-thinking',
    });
    expect(row).toEqual({
      credId: 'char:char-1/instant',
      value: {
        apiUrl: 'https://api.example.dev/v1/chat/completions',
        apiKey: 'sk-global',
        primaryModel: 'claude-sonnet-4-thinking',
      },
    });
  });

  it('情绪评估那行：配了副 API 用副 API，没配回落全局聊天 API', () => {
    expect(buildCharEmotionCredRow('char-1', SECONDARY, API)?.value.primaryModel).toBe('gpt-alt');
    expect(buildCharEmotionCredRow('char-1', undefined, API)?.value.primaryModel).toBe('gpt-global');
    expect(buildCharEmotionCredRow('char-1', { baseUrl: '', apiKey: '', model: '' }, API)?.value.primaryModel)
      .toBe('gpt-global');
  });
});

describe('指纹门控', () => {
  const row = () => buildCharChatCredRow(CHAR, { enabled: true } as any, API)!;

  it('没传过 → 要传；传过且值没变 → 不再传', () => {
    expect(pickChangedCredRows([row()])).toHaveLength(1);
    rememberCredRows([row()]);
    expect(pickChangedCredRows([row()])).toHaveLength(0);
  });

  it('换了 Key → 重新算成「要传」（不然云端永远是旧 Key，已排任务到点 401）', () => {
    rememberCredRows([row()]);
    const rotated = buildCharChatCredRow(CHAR, { enabled: true } as any, { ...API, apiKey: 'sk-new' })!;
    expect(pickChangedCredRows([rotated])).toHaveLength(1);
  });

  it('换了模型也算变（同一把 Key 不同模型是两份不同的凭据）', () => {
    rememberCredRows([row()]);
    const remodeled = buildCharChatCredRow(CHAR, { enabled: true } as any, { ...API, model: 'gpt-new' })!;
    expect(pickChangedCredRows([remodeled])).toHaveLength(1);
  });

  it('划掉某一行之后必须重传（云端删了 / 上一次其实没落地时的自愈前提）', () => {
    rememberCredRows([row()]);
    forgetCredIds([row().credId]);
    expect(pickChangedCredRows([row()])).toHaveLength(1);
  });

  it('底账里记着传过哪些行（后台补传按它决定重算哪几行）', () => {
    rememberCredRows([row(), buildCharEmotionCredRow('char-1', undefined, API)!]);
    expect(knownCredIds().sort()).toEqual(['char:char-1/chat', 'char:char-1/emotion']);
    forgetAllCredIds();
    expect(knownCredIds()).toEqual([]);
  });

  it('凭据本体一个字节都不进 localStorage（底账只记指纹）', () => {
    rememberCredRows([row()]);
    expect(JSON.stringify(localStorage.getItem('amsg2_llm_cred_fingerprints'))).not.toContain('sk-global');
  });
});

describe('批量切片', () => {
  it('按上游单批上限切开（一次 PUT 最多 100 条）', () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({
      credId: `char:c${i}/chat`,
      value: { apiUrl: 'u', apiKey: 'k', primaryModel: 'm' },
    }));
    expect(chunkCredRows(rows).map((batch) => batch.length)).toEqual([100, 100, 5]);
  });
});

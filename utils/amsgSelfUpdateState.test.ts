import { describe, it, expect } from 'vitest';
import {
  cfTokenRejectedMessage,
  describeAmsgSelfUpdate,
  explainCfTokenRejection,
  parseAmsgSelfUpdateState,
  type AmsgSelfUpdateState,
} from './amsgSelfUpdateState';

const NOW = Date.parse('2026-09-25T08:00:00.000Z');
const HOUR = 60 * 60_000;

const state = (patch: Partial<AmsgSelfUpdateState> = {}): AmsgSelfUpdateState => ({
  lastCheckAt: new Date(NOW - 2 * HOUR).toISOString(),
  lastSource: 'cron',
  lastOutcome: 'up_to_date',
  bundleHash: 'abcdef012345',
  lastUpdatedAt: new Date(NOW - 3 * 24 * HOUR).toISOString(),
  lastError: null,
  ...patch,
});

describe('parseAmsgSelfUpdateState', () => {
  it('形状对就原样认', () => {
    expect(parseAmsgSelfUpdateState(state())).toEqual(state());
  });

  it('时刻或结果不对就当没有', () => {
    expect(parseAmsgSelfUpdateState(null)).toBeNull();
    expect(parseAmsgSelfUpdateState({ ...state(), lastCheckAt: 'not-a-date' })).toBeNull();
    expect(parseAmsgSelfUpdateState({ ...state(), lastOutcome: 'weird' })).toBeNull();
  });

  it('可选字段缺了也能认，来源认不出就按 cron', () => {
    const parsed = parseAmsgSelfUpdateState({ lastCheckAt: state().lastCheckAt, lastOutcome: 'updated', lastSource: 'martian' });
    expect(parsed).toEqual({
      lastCheckAt: state().lastCheckAt,
      lastSource: 'cron',
      lastOutcome: 'updated',
      bundleHash: null,
      lastUpdatedAt: null,
      lastError: null,
    });
  });
});

describe('describeAmsgSelfUpdate', () => {
  it('没有自更新能力 → null，界面沿用原来的说明', () => {
    expect(describeAmsgSelfUpdate(null, NOW)).toBeNull();
    expect(describeAmsgSelfUpdate({ supported: false, state: null }, NOW)).toBeNull();
  });

  it('有能力但从没查过', () => {
    expect(describeAmsgSelfUpdate({ supported: true, state: null }, NOW)).toContain('还没检查过');
  });

  it('已是最新：说上次查的时间和上次换代码的时间', () => {
    const text = describeAmsgSelfUpdate({ supported: true, state: state() }, NOW);
    expect(text).toContain('上次检查 2 小时前');
    expect(text).toContain('已经是最新');
    expect(text).toContain('上次换代码是 3 天前');
  });

  it('刚更新过', () => {
    const text = describeAmsgSelfUpdate({ supported: true, state: state({ lastOutcome: 'updated', lastCheckAt: new Date(NOW - 30_000).toISOString(), lastUpdatedAt: new Date(NOW - 30_000).toISOString() }) }, NOW);
    expect(text).toContain('上次检查 刚刚');
    expect(text).toContain('换上了新代码');
  });

  it('失败：带代号和整句，说明到点会再试', () => {
    const text = describeAmsgSelfUpdate({ supported: true, state: state({ lastOutcome: 'failed', lastError: { code: 'UPLOAD_FAILED', message: '上传失败（boom）' } }) }, NOW);
    expect(text).toContain('没成功');
    expect(text).toContain('UPLOAD_FAILED');
    expect(text).toContain('boom');
    expect(text).toContain('到点会再试');
  });

  it('旧 Worker 报 token 无效：换掉「加 CF_ACCOUNT_ID 即可」那句', () => {
    const text = describeAmsgSelfUpdate({
      supported: true,
      state: state({
        lastOutcome: 'failed',
        lastError: {
          code: 'SCRIPT_NOT_LOCATED',
          message: '问不到账号列表（9109: Invalid access token）。给 Worker 加一条 CF_ACCOUNT_ID 变量即可跳过这一步。',
        },
      }),
    }, NOW);
    expect(text).toContain('Cloudflare 不认这枚 CF_API_TOKEN（9109: Invalid access token）');
    expect(text).not.toContain('即可跳过');
  });
});

describe('explainCfTokenRejection', () => {
  it('新 Worker 的提示和其他报错都原样保留', () => {
    const current = cfTokenRejectedMessage('9109: Invalid access token', false);
    expect(explainCfTokenRejection(current)).toBe(current);
    const denied = '问不到账号列表（9109: Unauthorized to access requested resource）。给 Worker 加一条 CF_ACCOUNT_ID 变量即可跳过这一步。';
    expect(explainCfTokenRejection(denied)).toBe(denied);
  });

  it('已经配了 CF_ACCOUNT_ID 的不再建议加它', () => {
    const text = explainCfTokenRejection('在 CF_ACCOUNT_ID 指定的账号里读不到这个 Worker 的配置（9109: Invalid access token）。');
    expect(text).toContain('Cloudflare 不认这枚 CF_API_TOKEN');
    expect(text).not.toContain('CF_ACCOUNT_ID 指定');
    expect(text).not.toContain('加一条 CF_ACCOUNT_ID');
  });
});

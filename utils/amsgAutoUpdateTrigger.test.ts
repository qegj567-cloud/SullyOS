import { describe, it, expect } from 'vitest';
import { STARTUP_UPDATE_CHECK_MIN_INTERVAL_MS, pickStartupUpdateAction, shouldRequestStartupUpdateCheck } from './amsgAutoUpdateTrigger';

describe('shouldRequestStartupUpdateCheck', () => {
  const NOW = Date.parse('2026-09-25T08:00:00.000Z');

  it('从没敲过门 → 敲', () => {
    expect(shouldRequestStartupUpdateCheck(null, 'dev@abc', NOW)).toBe(true);
  });

  /**
   * 回归守卫：前端换了构建就该立刻催后端一次——两边一起改的功能，前端已经会了、
   * 后端还没跟上，正是这一下要补的空档。不能被「离上次不够久」挡住。
   */
  it('构建换了 → 不管离上次多近都敲', () => {
    expect(shouldRequestStartupUpdateCheck({ buildLabel: 'dev@old', atMs: NOW - 1000 }, 'dev@new', NOW)).toBe(true);
  });

  it('同一个构建、离上次不够久 → 不敲（手机一天开十几次 App 不该次次去撞）', () => {
    expect(shouldRequestStartupUpdateCheck({ buildLabel: 'dev@abc', atMs: NOW - STARTUP_UPDATE_CHECK_MIN_INTERVAL_MS + 1 }, 'dev@abc', NOW)).toBe(false);
  });

  it('同一个构建、够久了 → 敲', () => {
    expect(shouldRequestStartupUpdateCheck({ buildLabel: 'dev@abc', atMs: NOW - STARTUP_UPDATE_CHECK_MIN_INTERVAL_MS }, 'dev@abc', NOW)).toBe(true);
  });
});

describe('pickStartupUpdateAction', () => {
  /**
   * 回归守卫：版本对不上就直接更新，不管它有没有自更新能力那一段——存量用户的旧 Worker
   * 根本不报那一段，但 /self-update 它是有的。这一条就是「存量用户不用自己点一次」的全部依据。
   */
  it('版本对不上 → 直接更新，跟用户点按钮一样', () => {
    expect(pickStartupUpdateAction({ state: 'outdated', autoUpdate: null })).toBe('self-update');
    expect(pickStartupUpdateAction({ state: 'outdated', autoUpdate: { supported: false, state: null } })).toBe('self-update');
  });

  it('版本对得上、有自更新能力 → 敲门让它按指纹自查', () => {
    expect(pickStartupUpdateAction({ state: 'current', autoUpdate: { supported: true, state: null } })).toBe('check');
    // Worker 比 App 新：App 是缓存的旧构建，催 Worker 更新只会把同一份代码重传一遍。
    expect(pickStartupUpdateAction({ state: 'ahead', autoUpdate: { supported: true, state: null } })).toBe('none');
  });

  it('版本对得上但没钥匙 / 探不到版本 → 什么都不做', () => {
    expect(pickStartupUpdateAction({ state: 'current', autoUpdate: { supported: false, state: null } })).toBe('none');
    expect(pickStartupUpdateAction({ state: 'current', autoUpdate: null })).toBe('none');
    expect(pickStartupUpdateAction({ state: 'unknown', autoUpdate: null })).toBe('none');
  });
});

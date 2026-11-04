import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProactiveChat, PROACTIVE_FAIL_LIMIT, MIN_PROACTIVE_INTERVAL_MS } from './proactiveChat';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

describe('ProactiveChat (1.0 scheduler)', () => {
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', {});
    ProactiveChat.reconcile([]);
  });

  afterEach(() => {
    ProactiveChat.onTrigger(() => {});
    ProactiveChat.reconcile([]);
    vi.unstubAllGlobals();
  });

  it('reconcile 补建缺失调度、更新间隔并清理已关闭或已删除角色的残留调度', () => {
    ProactiveChat.start('c1', 60);
    ProactiveChat.start('c2', 120);
    expect(ProactiveChat.isActiveFor('c1')).toBe(true);
    expect(ProactiveChat.isActiveFor('c2')).toBe(true);

    // c2 已关闭主动消息，c3 新开启，c1 改间隔为 240 分钟
    ProactiveChat.reconcile([
      { charId: 'c1', intervalMinutes: 240 },
      { charId: 'c3', intervalMinutes: 30 },
    ]);

    expect(ProactiveChat.isActiveFor('c1')).toBe(true);
    expect(ProactiveChat.getIntervalMinutes('c1')).toBe(240);
    expect(ProactiveChat.isActiveFor('c2')).toBe(false);
    expect(ProactiveChat.isActiveFor('c3')).toBe(true);
    expect(ProactiveChat.getIntervalMinutes('c3')).toBe(30);
  });

  it('连续失败达到 PROACTIVE_FAIL_LIMIT 次时自动熔断并停止调度', () => {
    ProactiveChat.start('c1', 60);
    for (let i = 0; i < PROACTIVE_FAIL_LIMIT - 1; i++) {
      expect(ProactiveChat.report('c1', 'failed').tripped).toBe(false);
      expect(ProactiveChat.isActiveFor('c1')).toBe(true);
    }
    const last = ProactiveChat.report('c1', 'failed');
    expect(last.tripped).toBe(true);
    expect(last.streak).toBe(PROACTIVE_FAIL_LIMIT);
    expect(ProactiveChat.isActiveFor('c1')).toBe(false);
  });

  it('成功一次或重新 start 后连续失败计数清零', () => {
    ProactiveChat.start('c1', 60);
    ProactiveChat.report('c1', 'failed');
    ProactiveChat.report('c1', 'failed');
    expect(ProactiveChat.getFailStreak('c1')).toBe(2);

    ProactiveChat.report('c1', 'ok');
    expect(ProactiveChat.getFailStreak('c1')).toBe(0);
    expect(ProactiveChat.report('c1', 'failed').tripped).toBe(false);

    ProactiveChat.start('c1', 60);
    expect(ProactiveChat.getFailStreak('c1')).toBe(0);
  });

  it('localStorage 存有异常过小间隔时自动钳制到最小 30 分钟', () => {
    storage.setItem('proactive_schedules', JSON.stringify({
      c1: { charId: 'c1', intervalMs: 500 },
    }));
    const schedule = ProactiveChat.getSchedule('c1');
    expect(schedule?.intervalMs).toBe(MIN_PROACTIVE_INTERVAL_MS);
  });

  it('localStorage.setItem 抛 QuotaExceededError 时内存兜底仍能推进 lastFire 并允许 stop，不会死循环重发', () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

    ProactiveChat.start('c1', 30);
    ProactiveChat.start('c2', 60);

    // 模拟 localStorage 配额写满
    storage.setItem = () => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    };

    const fired: string[] = [];
    // 时间推进 31 分钟，触发一次到期检查
    nowSpy.mockReturnValue(now + 31 * 60_000);
    ProactiveChat.onTrigger((id) => { fired.push(id); });
    expect(fired).toEqual(['c1']);

    // 20 秒后再次检查：即使 localStorage 写失败，内存里的 lastFire 已更新，绝不重复触发
    nowSpy.mockReturnValue(now + 31 * 60_000 + 20_000);
    ProactiveChat.onTrigger((id) => { fired.push(id); });
    expect(fired).toEqual(['c1']);

    // 此时用户点停止 c1（c2 仍在，所以 saveSchedules 会走 setItem 而不是 removeItem）
    ProactiveChat.stop('c1');
    expect(ProactiveChat.isActiveFor('c1')).toBe(false);
    expect(ProactiveChat.isActiveFor('c2')).toBe(true);

    nowSpy.mockRestore();
  });
});

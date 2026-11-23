import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  CANARY_BOOT_ATTEMPTS_KEY,
  CANARY_FALLBACK_NOTICE_KEY,
  CANARY_HOST,
  CHANNEL_ARRIVAL_KEY,
  RELEASE_CHANNEL_STORAGE_KEY,
  describeCanaryJoinBlocker,
  type ReleaseChannel,
} from './releaseChannel';
import { analyticsTag } from './analytics';
import { APP_VERSION_TAG } from './buildInfo';

const gateSource = readFileSync(new URL('../public/release-channel-gate.js', import.meta.url), 'utf8');

/** 在假的页面环境里跑一遍跳转脚本，返回跳去了哪、localStorage 剩下什么。 */
const runGate = (build: ReleaseChannel, href: string, saved: Record<string, string> = {}) => {
  const store = new Map(Object.entries(saved));
  const replace = vi.fn();
  const style: Record<string, string> = {};
  const attrs: Record<string, string> = { 'data-channel': build, 'data-canary-host': CANARY_HOST };
  runInNewContext(gateSource, {
    URL,
    Number,
    String,
    location: { href, replace },
    document: { currentScript: { getAttribute: (name: string) => attrs[name] ?? null }, documentElement: { style } },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
    },
  });
  return { to: replace.mock.calls[0]?.[0] as string | undefined, store: Object.fromEntries(store), hidden: style.visibility === 'hidden' };
};

const HOME = `https://${CANARY_HOST}/`;

describe('release-channel-gate.js', () => {
  it('uses the same storage keys as utils/releaseChannel.ts', () => {
    for (const key of [RELEASE_CHANNEL_STORAGE_KEY, CANARY_BOOT_ATTEMPTS_KEY, CANARY_FALLBACK_NOTICE_KEY, CHANNEL_ARRIVAL_KEY]) {
      expect(gateSource).toContain(`'${key}'`);
    }
  });

  it('leaves stable users on stable and never touches other hosts', () => {
    expect(runGate('stable', HOME).to).toBeUndefined();
    expect(runGate('stable', 'https://qegj567-cloud.github.io/SullyOS/', { [RELEASE_CHANNEL_STORAGE_KEY]: 'canary' }).to).toBeUndefined();
  });

  it('sends canary users from stable to /canary/ and counts the attempt', () => {
    const run = runGate('stable', `${HOME}?x=1#a`, { [RELEASE_CHANNEL_STORAGE_KEY]: 'canary' });
    expect(run.to).toBe('/canary/?x=1#a');
    expect(run.hidden).toBe(true);
    expect(run.store[CANARY_BOOT_ATTEMPTS_KEY]).toBe('1');
  });

  it('falls back to stable after two canary boots that never became healthy', () => {
    const run = runGate('stable', HOME, { [RELEASE_CHANNEL_STORAGE_KEY]: 'canary', [CANARY_BOOT_ATTEMPTS_KEY]: '2' });
    expect(run.to).toBeUndefined();
    expect(run.store[RELEASE_CHANNEL_STORAGE_KEY]).toBe('stable');
    expect(run.store[CANARY_BOOT_ATTEMPTS_KEY]).toBeUndefined();
    expect(run.store[CANARY_FALLBACK_NOTICE_KEY]).toBe('1');
    expect(run.store[CHANNEL_ARRIVAL_KEY]).toBe('1');
  });

  it('sends people who never joined back from /canary/ to the stable path', () => {
    expect(runGate('canary', `${HOME}canary/`).to).toBe('/');
    expect(runGate('canary', `${HOME}canary/recover.html`).to).toBe('/recover.html');
    expect(runGate('canary', `${HOME}canary/`, { [RELEASE_CHANNEL_STORAGE_KEY]: 'canary' }).to).toBeUndefined();
  });

  it('?channel=stable forces stable from either build', () => {
    const fromStable = runGate('stable', `${HOME}?channel=stable`, { [RELEASE_CHANNEL_STORAGE_KEY]: 'canary', [CANARY_BOOT_ATTEMPTS_KEY]: '1' });
    expect(fromStable.to).toBeUndefined();
    expect(fromStable.store[RELEASE_CHANNEL_STORAGE_KEY]).toBe('stable');
    expect(fromStable.store[CANARY_BOOT_ATTEMPTS_KEY]).toBeUndefined();
    const fromCanary = runGate('canary', `${HOME}canary/?channel=stable`, { [RELEASE_CHANNEL_STORAGE_KEY]: 'canary' });
    expect(fromCanary.to).toBe('/?channel=stable');
    expect(fromCanary.store[RELEASE_CHANNEL_STORAGE_KEY]).toBe('stable');
  });
});

describe('describeCanaryJoinBlocker', () => {
  const ok = { hostname: CANARY_HOST, native: false, amsg: null };

  it('allows web users on the canary host, with or without a channel-aware Worker', () => {
    expect(describeCanaryJoinBlocker(ok)).toBeNull();
    expect(describeCanaryJoinBlocker({ ...ok, amsg: { selfUpdateSupported: true, workerChannel: 'stable' } })).toBeNull();
  });

  it('blocks other hosts, native apps and Workers that cannot follow the channel', () => {
    expect(describeCanaryJoinBlocker({ ...ok, hostname: 'qegj567-cloud.github.io' })).toContain(CANARY_HOST);
    expect(describeCanaryJoinBlocker({ ...ok, native: true })).not.toBeNull();
    expect(describeCanaryJoinBlocker({ ...ok, amsg: { selfUpdateSupported: false, workerChannel: 'stable' } })).toContain('自动更新');
    expect(describeCanaryJoinBlocker({ ...ok, amsg: { selfUpdateSupported: true, workerChannel: null } })).toContain('更新 Worker');
  });
});

describe('analyticsTag', () => {
  it('keeps the stable tag and suffixes canary', () => {
    expect(analyticsTag('stable')).toBe(APP_VERSION_TAG);
    expect(analyticsTag('canary')).toBe(`${APP_VERSION_TAG}-canary`);
  });
});

describe('canary 黄点开关', () => {
  it('写入后读得到，取消隐藏会删掉这条偏好', async () => {
    const { readCanaryDotHidden, writeCanaryDotHidden, CANARY_DOT_HIDDEN_KEY } = await import('./releaseChannel');
    writeCanaryDotHidden(true);
    expect(readCanaryDotHidden()).toBe(true);
    writeCanaryDotHidden(false);
    expect(readCanaryDotHidden()).toBe(false);
    expect(localStorage.getItem(CANARY_DOT_HIDDEN_KEY)).toBeNull();
  });
});

describe('releaseUpdateVersion（网页更新要不要弹提示）', () => {
  it('正式版只看版本号那半截，同一版的不同构建不打扰', async () => {
    const { releaseUpdateVersion } = await import('./releaseChannel');
    expect(releaseUpdateVersion('v3.17', 'stable', 'build-a')).toBe('v3.17');
    expect(releaseUpdateVersion('v3.17', 'stable', 'build-b')).toBe('v3.17');
  });

  /** 回归守卫：canary 每个构建都要算新版本，否则志愿者刷不出新构建。 */
  it('canary 每个构建都算新版本', async () => {
    const { releaseUpdateVersion } = await import('./releaseChannel');
    expect(releaseUpdateVersion('v3.17', 'canary', 'build-a')).not.toBe(releaseUpdateVersion('v3.17', 'canary', 'build-b'));
  });
});

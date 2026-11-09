import { describe, expect, it } from 'vitest';
import { compareBundleVersions } from './amsgBundleVersion';

describe('compareBundleVersions', () => {
  it('按日期比新旧，不是只看相不相等', () => {
    expect(compareBundleVersions('2026-11-07.3', '2026-11-09')).toBeLessThan(0);
    expect(compareBundleVersions('2026-11-09', '2026-11-07.3')).toBeGreaterThan(0);
    expect(compareBundleVersions('2026-11-09', '2026-11-09')).toBe(0);
  });

  it('同一天的后缀按数字比，不带后缀算 .0', () => {
    expect(compareBundleVersions('2026-11-07.2', '2026-11-07.10')).toBeLessThan(0);
    expect(compareBundleVersions('2026-11-07', '2026-11-07.1')).toBeLessThan(0);
  });

  it('格式认不出返回 null', () => {
    expect(compareBundleVersions('old', '2026-11-09')).toBeNull();
    expect(compareBundleVersions('2026-11-09', '2026-11-09-beta')).toBeNull();
  });
});

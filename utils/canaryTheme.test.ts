import { describe, expect, it } from 'vitest';
import { CANARY_ACCENT, resolveDisplayAccent } from './canaryTheme';

const factory = { hue: 88, saturation: 14, lightness: 46 };

describe('canary 金黄主题', () => {
  it('canary 里出厂强调色换成金色', () => {
    expect(resolveDisplayAccent(factory, factory, 'canary')).toEqual(CANARY_ACCENT);
  });

  it('用户调过任何一项就听用户的', () => {
    const custom = { ...factory, lightness: 47 };
    expect(resolveDisplayAccent(custom, factory, 'canary')).toBe(custom);
  });

  it('正式版不动', () => {
    expect(resolveDisplayAccent(factory, factory, 'stable')).toBe(factory);
  });
});

import { afterEach, expect, it, vi } from 'vitest';
import { weatherForCharacter } from './characterWeather';
import { importBeautyPreferences } from './beautyPreferencesBackup';
import { importHome3DLocal } from './home3DBackup';
import { describeD1LimitCode } from './amsgD1Limits';
import { trackBeauty } from './beautyAnalytics';
import { trackEvent } from './analytics';

vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it('旧内核缺少 Object.hasOwn 时，回复上下文、美化与备份仍可用且不接受原型字段', () => {
    vi.spyOn(Object, 'hasOwn');
    Object.defineProperty(Object, 'hasOwn', { value: undefined, configurable: true, writable: true });
    const cities = Object.assign(Object.create({ inherited: '不应使用' }), { actor: '上海', hasOwnProperty: '北京' });
    const config: {weatherCity?: string; weatherCities: Record<string, string>} = { weatherCities: cities };
    expect(weatherForCharacter(config, 'actor').weatherCity).toBe('上海');
    expect(weatherForCharacter(config, 'hasOwnProperty').weatherCity).toBe('北京');
    expect(weatherForCharacter(config, 'inherited').weatherCity).toBeUndefined();
    trackBeauty('apply', 'bubbles');
    trackBeauty('constructor', 'bubbles');
    expect(trackEvent).toHaveBeenCalledOnce();
    const values = Object.assign(Object.create({ 'sully-beauty-author-notice-v1': '不应导入' }), { 'sully-beauty-catalog-notice-v1': '1' });
    importBeautyPreferences({ version: 1, values });
    expect(localStorage.getItem('sully-beauty-catalog-notice-v1')).toBe('1');
    expect(localStorage.getItem('sully-beauty-author-notice-v1')).toBeNull();
    importHome3DLocal({ 'sully-home3d-light-mode': 'auto' });
    expect(localStorage.getItem('sully-home3d-light-mode')).toBe('auto');
    expect(describeD1LimitCode('D1_STORAGE_FULL')).toContain('云端数据库满了');
    expect(describeD1LimitCode('constructor')).toBe('');
});

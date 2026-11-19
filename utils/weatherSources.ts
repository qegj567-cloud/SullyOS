export type FreeWeatherSource = 'open-meteo' | 'wttr';
export type WeatherSource = FreeWeatherSource | 'owm';

export const normalizeFreeWeatherSource = (value: unknown): FreeWeatherSource => value === 'open-meteo' ? 'open-meteo' : 'wttr';
// The marker travels with settings so later explicit choices survive reload and backup.
export function migrateFreeWeatherPreference(config: import('../types').RealtimeConfig) {
    if (config.weatherFreeSourceMigration === 1) return config;
    return { ...config, weatherFreeSourceMigration: 1 as const,
        weatherFreeSource: config.weatherApiKey?.trim() ? config.weatherFreeSource : 'wttr' as const };
}

export const WEATHER_SOURCE_LABELS: Record<WeatherSource, string> = {
    'open-meteo': '免费源 1 · Open-Meteo', wttr: '免费源 2 · wttr.in', owm: 'OpenWeatherMap',
};

export type FreeWeatherSource = 'open-meteo' | 'wttr';
export type WeatherSource = FreeWeatherSource | 'owm';

export const normalizeFreeWeatherSource = (value: unknown): FreeWeatherSource => value === 'wttr' ? 'wttr' : 'open-meteo';
export const WEATHER_SOURCE_LABELS: Record<WeatherSource, string> = {
    'open-meteo': '免费源 1 · Open-Meteo', wttr: '免费源 2 · wttr.in', owm: 'OpenWeatherMap',
};

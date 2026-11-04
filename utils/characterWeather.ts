/** Manual weather cities are independent of device location and character timezones. */
export function cleanCharacterWeatherCities(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, city]) => id && typeof city === 'string' && city.trim())
        .map(([id, city]) => [id, (city as string).trim().slice(0, 100)]));
}

export function weatherForCharacter<T extends {weatherCity?: string; weatherCities?: Record<string, string>}>(config: T, charId?: string): T {
    const city = charId && Object.hasOwn(config.weatherCities || {}, charId) ? config.weatherCities?.[charId] : undefined;
    return typeof city === 'string' && city.trim() ? {...config, weatherCity: city.trim().slice(0, 100)} : config;
}

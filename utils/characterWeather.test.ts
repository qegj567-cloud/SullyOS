import {beforeEach,expect,it,vi} from 'vitest';
import {cleanCharacterWeatherCities,weatherForCharacter} from './characterWeather';
import {RealtimeContextManager,defaultRealtimeConfig} from './realtimeContext';
import {fetchWeatherWithFallback} from './realtimeWorldCore';
import {buildToolConfig,parseToolConfig} from './amsgToolPack';
vi.mock('./realtimeWorldCore',async original=>({...await original<any>(),fetchWeatherWithFallback:vi.fn()}));
beforeEach(()=>{vi.clearAllMocks();RealtimeContextManager.clearCache();});
it('resolves by stable ID and preserves default city for new characters',()=>{
    const cfg={...defaultRealtimeConfig,weatherEnabled:true,weatherCity:'北京',weatherCities:{a:' 上海 ',b:'London'}};
    expect(weatherForCharacter(cfg,'a').weatherCity).toBe('上海');expect(weatherForCharacter(cfg,'b').weatherCity).toBe('London');
    expect(weatherForCharacter(cfg,'new').weatherCity).toBe('北京');expect(cfg.weatherCity).toBe('北京');
    expect(cleanCharacterWeatherCities({a:' 上海 ',b:' ',c:2})).toEqual({a:'上海'});
    expect(parseToolConfig(JSON.stringify(buildToolConfig(cfg)))?.weatherCities).toEqual({a:'上海',b:'London'});
});
it('isolates cached weather by city and key, including failed city switches',async()=>{
    vi.mocked(fetchWeatherWithFallback).mockImplementation(async city=>({city,temp:20}) as any);
    const cfg={...defaultRealtimeConfig,weatherEnabled:true,weatherCity:'上海'};
    expect((await RealtimeContextManager.fetchWeather(cfg))?.city).toBe('上海');
    expect((await RealtimeContextManager.fetchWeather({...cfg,weatherCity:'London'}))?.city).toBe('London');
    expect((await RealtimeContextManager.fetchWeather(cfg))?.city).toBe('上海');
    expect(fetchWeatherWithFallback).toHaveBeenCalledTimes(2);
    vi.mocked(fetchWeatherWithFallback).mockResolvedValue(null);
    expect(await RealtimeContextManager.fetchWeather({...cfg,weatherCity:'Paris'})).toBeNull();
    expect(await RealtimeContextManager.fetchWeather({...cfg,weatherApiKey:'new-key'})).toBeNull();
});

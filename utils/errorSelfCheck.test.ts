import { expect, it } from 'vitest';
import { errorDetails, matchErrorRoute, requestErrorAdvice, textErrorAdvice, type ErrorRoutes } from './errorSelfCheck';

const c = (name: string, baseUrl: string, model='m') => ({name,config:{baseUrl,model}});
it('matches paths, changed domain suffixes and redirected hosts without trusting generic prefixes', () => {
    const primary=c('主 API','https://api.mooncat.cn/v1');
    const other=c('副 API','https://api.other.org/v1');
    const match=(...urls:string[])=>matchErrorRoute(urls,[primary,other]);
    expect(match('https://api.mooncat.cn/v1/chat/completions?token=secret')).toEqual({name:'主 API',host:'api.mooncat.cn',possible:false});
    expect(match('https://mooncat.net/v2/messages')).toMatchObject({name:'主 API',possible:true});
    expect(match('https://mooncat.net/v1','https://api.other.org/v1')).toMatchObject({name:'副 API',possible:false});
    expect(match('https://api.unrelated.org')).toBeUndefined();
    expect(matchErrorRoute(['https://mooncat.net'],[primary,c('other','https://mooncat.tw')])).toBeUndefined();
});
it('identifies a unique preset by model and does not invent a preset when co-hosted routes tie',()=>{
    const routes=[c('A','https://shared.example/v1','m1'),c('B','https://shared.example/v1','m2')].map(v=>({...v,preset:true}));
    expect(matchErrorRoute(['https://shared.example/v1/messages'],routes,'m2')?.name).toBe('B');
    expect(matchErrorRoute(['https://shared.example/v1/messages'],routes)?.name).toBe('你的 API');
});
it('distinguishes truncated replies, malformed model text, HTML responses and exhausted weather sources',()=>{
    expect(textErrorAdvice('记忆提取输出被截断')?.title).toContain('截断');
    expect(textErrorAdvice('记忆提取未返回有效 JSON')?.title).toContain('格式不对');
    expect(textErrorAdvice('API返回了HTML而非JSON')?.action).toContain('服务商');
    expect(textErrorAdvice('Failed to fetch weather:')?.action).toContain('12 小时');
});
it('scopes SiliconFlow guidance to palace operations and recognizes known balance errors',()=>{
    const cfg=c('main','https://api.siliconflow.cn/v1').config;
    const routes={apiConfig:cfg,characters:[],apiPresets:[],memoryPalaceConfig:{embedding:cfg,rerank:cfg,lightLLM:{...cfg,baseUrl:''}}} as ErrorRoutes;
    expect(requestErrorAdvice(routes,cfg.baseUrl+'/embeddings','',402)?.action).toContain('硅基流动账号的余额');
    expect(requestErrorAdvice(routes,cfg.baseUrl+'/chat/completions','',401)?.title).toContain('主 API');
    expect(textErrorAdvice('[记忆宫殿·硅基流动]', 'Embedding API error 401')?.action).toContain('Key');
});
it('keeps the error message in front of a Safari-style stack and names a corrupt backup in plain words',()=>{
    const safari=Object.assign(new Error('损坏的备份包：stores/messages.003.json'),{stack:'@https://x/main.js:2683:14064\nasync h@https://x/a.js:1:2193'});
    expect(errorDetails(safari).startsWith('损坏的备份包：stores/messages.003.json\n')).toBe(true);
    expect(errorDetails(safari)).toContain('main.js:2683');
    const chrome=new Error('boom');
    expect(errorDetails(chrome)).toBe(chrome.stack);
    expect(errorDetails('纯文本')).toBe('纯文本');
    expect(textErrorAdvice('导入失败',errorDetails(safari))?.title).toBe('这份备份文件损坏了');
    expect(textErrorAdvice('云端恢复失败','恢复失败: IndexedDB transaction aborted')?.action).toContain('不要切走');
    expect(textErrorAdvice('保存失败','IndexedDB transaction aborted')).toBeUndefined();
});

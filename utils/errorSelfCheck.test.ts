import { expect, it } from 'vitest';
import { cleanErrorStack, errorDetails, formatUnknownError, matchErrorRoute, requestErrorAdvice, textErrorAdvice, type ErrorRoutes } from './errorSelfCheck';

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

it('formats non-Error objects, DOM events, MediaError, FastAPI arrays and Error.cause without [object Object]', () => {
    expect(formatUnknownError(null, '兜底文案')).toBe('兜底文案');
    expect(formatUnknownError(undefined, '兜底文案')).toBe('兜底文案');
    expect(formatUnknownError({ code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' })).toContain('音频源不可用或格式不支持');
    expect(formatUnknownError({ type: 'error', target: { tagName: 'IMG', src: 'data:image/png;base64,AAAA' } })).toContain('资源或读写事件失败 (error · <img> data:image/png;base64,<inline');
    expect(formatUnknownError({ code: 'PGRST301', message: 'JWT expired', hint: 'Renew token' })).toBe('JWT expired [PGRST301] · 提示: Renew token');
    expect(formatUnknownError({ detail: [{ loc: ['body', 'voice_id'], msg: 'Field required' }] })).toContain('body.voice_id: Field required');
    expect(formatUnknownError({ base_resp: { status_code: 1004, status_msg: 'insufficient balance' } })).toBe('insufficient balance [1004]');

    const rootCause = new TypeError('connect ETIMEDOUT');
    const wrapped = new Error('请求上游失败', { cause: rootCause });
    expect(formatUnknownError(wrapped)).toBe('请求上游失败 (cause: connect ETIMEDOUT)');
    expect(errorDetails(wrapped)).toContain('Caused by:');

    const noisyStack = [
        'Error: boom',
        '    at MyComp (https://friedsully.com/assets/build/Chat-abc.js:10:20)',
        '    at a1 (https://friedsully.com/assets/build/vendor-react-1a2b3c.js:1:100)',
        '    at a2 (https://friedsully.com/assets/build/vendor-react-1a2b3c.js:1:200)',
        '    at a3 (https://friedsully.com/assets/build/vendor-react-1a2b3c.js:1:300)',
        '    at Root (https://friedsully.com/assets/build/main-9f8e7d.js:5:10)',
    ].join('\n');
    const cleaned = cleanErrorStack(noisyStack);
    expect(cleaned).toContain('... (已折叠 3 行框架内部调用)');
    expect(cleaned).not.toContain('vendor-react-1a2b3c.js');

    // 循环引用与抛异常的访问器不会导致报错格式化自身崩溃，errorDetails 自动脱敏中转令牌
    const cyclic: any = {};
    cyclic.error = cyclic;
    expect(formatUnknownError(cyclic, '循环兜底')).toBe('循环兜底');
    const hostile = Object.defineProperty({}, 'message', { get() { throw new Error('getter trap'); } });
    expect(formatUnknownError(hostile, '访问器兜底')).toBe('访问器兜底');
    const leakErr = new Error('request failed: https://amsg-relay.friedsully.com/t/secret_relay_token_1234567890/w.workers.dev/debug?key=sk-123');
    const details = errorDetails(leakErr);
    expect(details).not.toContain('secret_relay_token_1234567890');
    expect(details).not.toContain('sk-123');
    expect(details).toContain('<redacted>');

    // 含有非 ISO-8859-1 字符（如误粘全角引号/空格）的请求头不会让 requestErrorAdvice 自身崩溃
    const cfg = c('main', 'https://api.mooncat.cn/v1').config;
    const routes = {
        apiConfig: { ...cfg, apiKey: 'sk-test“中文引号”' },
        characters: [],
        apiPresets: [],
        memoryPalaceConfig: { embedding: cfg, rerank: cfg, lightLLM: { ...cfg, baseUrl: '' } },
    } as ErrorRoutes;
    expect(() => requestErrorAdvice(routes, cfg.baseUrl + '/chat/completions', '', 0, '', 'm', undefined, {
        Authorization: 'Bearer sk-test“中文引号”',
    })).not.toThrow();

    // 自定义 toString 返回 'undefined' 时仍优先提取结构化 message；loc 含对象段不产出 [object Object]
    expect(formatUnknownError({ message: '真实错误原因', toString: () => 'undefined' })).toBe('真实错误原因');
    expect(formatUnknownError([{ loc: ['body', { nested: true }, 'input'], msg: 'Invalid field' }])).toBe('body.input: Invalid field');
});

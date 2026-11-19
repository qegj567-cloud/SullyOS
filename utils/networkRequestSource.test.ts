import { describe, it, expect } from 'vitest';
import {
    buildSystemLogsExportPayload,
    extractCallerHint,
    identifyApplicationErrorSource,
    identifyNetworkRequestSource,
    sanitizeUrlForLog,
    type ConfiguredEndpointSnapshot,
} from './networkRequestSource';
import {
    buildConsoleErrorSystemLog,
    buildFetchFailureSystemLog,
    buildHttpErrorSystemLog,
    classifyFetchFailure,
    shouldLogHttpStatusError,
    shouldProbeReachability,
    shouldShowNetworkSelfCheck,
} from './networkFailureDiagnosis';

const baseEndpoints: ConfiguredEndpointSnapshot = {
    mainApiBaseUrl: 'https://open.selart.cc/v1',
    apiPresets: [
        { name: '主力 Claude 渠道', baseUrl: 'https://open.selart.cc/v1' },
        { name: '备用 Gemini', baseUrl: 'https://gemini-proxy.example.com/v1' },
    ],
    checkPhoneApiBaseUrl: 'https://checkphone-llm.example.com/v1',
    embeddingBaseUrl: 'https://api.siliconflow.cn/v1',
    lightLlmBaseUrl: 'https://light-llm.example.com/v1',
    rerankBaseUrl: 'https://rerank.example.com/v1',
    supabaseUrl: 'https://xyzcompany.supabase.co',
    webdavUrl: 'https://dav.jianguoyun.com/dav/',
    proxyWorkerUrl: 'https://proxy.friedsully.com',
    amsgWorkerUrl: 'https://sullyos-amsg.louis810.workers.dev',
    mcpServers: [
        { name: '高德地图 MCP', url: 'https://mcp.amap.com/sse', proxyUrl: 'https://my-mcp-proxy.workers.dev' },
    ],
};

describe('sanitizeUrlForLog（隐私脱敏守卫）', () => {
    it('抹掉主动消息 2.0 大陆中转路径里的个人令牌，保留目标 Worker 域名与接口路径', () => {
        const token = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
        const raw = `https://amsg-relay.friedsully.com/t/${token}/sullyos-amsg.louis810.workers.dev/instant-chat`;
        const sanitized = sanitizeUrlForLog(raw);
        expect(sanitized).toBe('https://amsg-relay.friedsully.com/t/<redacted>/sullyos-amsg.louis810.workers.dev/instant-chat');
        expect(sanitized).not.toContain(token);
    });

    it('抹掉查询参数里的 key/token/secret 及嵌套代理地址里的口令', () => {
        const raw = 'https://proxy.friedsully.com/webdav?url='
            + encodeURIComponent('https://alice:supersecret@dav.example.com/SullyBackup/?token=abc123')
            + '&api_key=sk-secret-999&safe=1';
        const sanitized = sanitizeUrlForLog(raw);
        expect(sanitized).not.toContain('supersecret');
        expect(sanitized).not.toContain('abc123');
        expect(sanitized).not.toContain('sk-secret-999');
        expect(sanitized).toContain('dav.example.com');
        expect(sanitized).toContain('safe=1');
    });

    it('不含敏感信息的常规 URL 原样保留，不破坏已有断言', () => {
        expect(sanitizeUrlForLog('https://proxy.friedsully.com/api/health')).toBe('https://proxy.friedsully.com/api/health');
        expect(sanitizeUrlForLog('https://api.siliconflow.cn/v1/embeddings')).toBe('https://api.siliconflow.cn/v1/embeddings');
    });
});

describe('identifyNetworkRequestSource（多来源精确识别）', () => {
    it('identifies optional external image and font reads without suppressing API or local asset failures', () => {
        const identify = (url: string, method = 'GET', accept = '*/*') => identifyNetworkRequestSource({
            url, method, headers: { Accept: accept }, endpoints: baseEndpoints, pageOrigin: 'https://friedsully.com',
        }).category;
        expect(identify('https://voice.cdn.test/art.PNG?from=/models')).toBe('external-media');
        expect(identify('https://raw.githubusercontent.com/example/assets/main/cat.png')).toBe('external-media');
        expect(identify('https://api.github.com/repos/example/assets/contents/cat.png')).toBe('backup');
        expect(identify('https://cdn.test/han.woff2', 'HEAD')).toBe('external-media');
        expect(identify('https://fonts.googleapis.com/css2?family=Example')).toBe('external-media');
        expect(identify('https://cdn.test/42', 'GET', 'image/avif, image/webp, */*;q=0.5')).toBe('external-media');
        expect(identify('https://cdn.test/42', 'GET', 'text/html, image/webp')).not.toBe('external-media');
        expect(identify('https://cdn.test/42')).not.toBe('external-media');
        expect(identify('https://cdn.test/art.png', 'PUT')).not.toBe('external-media');
        expect(identify('https://open.selart.cc/v1/models', 'GET', 'image/*')).toBe('llm');
        expect(identify('https://friedsully.com/assets/build/start.js')).toBe('local-asset');
        expect(identify('https://cdn.test/voice.mp3')).toBe('audio');
    });
    it('区分对话模型（带显式用途、模型列表、Anthropic 原生、副模型）', () => {
        const chat = identifyNetworkRequestSource({
            url: 'https://open.selart.cc/v1/chat/completions',
            method: 'POST',
            body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
            explicitMeta: { appName: '消息', charName: 'Sully', purpose: '聊天回复' },
            endpoints: baseEndpoints,
        });
        expect(chat.source).toBe('对话模型 · 消息（聊天回复）');
        expect(chat.category).toBe('llm');
        expect(chat.model).toBe('claude-sonnet-4-5');
        expect(chat.configSource).toContain('主力 Claude 渠道');

        const anthropicNative = identifyNetworkRequestSource({
            url: 'https://api.anthropic.com/v1/messages',
            method: 'POST',
            headers: { 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }] }),
            endpoints: baseEndpoints,
        });
        expect(anthropicNative.category).toBe('llm');
        expect(anthropicNative.operation).toContain('Anthropic');
        expect(anthropicNative.model).toBe('claude-opus-4-6');

        const models = identifyNetworkRequestSource({
            url: 'https://gemini-proxy.example.com/v1/models',
            method: 'GET',
            endpoints: baseEndpoints,
        });
        expect(models.source).toContain('拉取模型列表');
        expect(models.configSource).toContain('备用 Gemini');

        const lightLlm = identifyNetworkRequestSource({
            url: 'https://light-llm.example.com/v1/chat/completions',
            method: 'POST',
            endpoints: baseEndpoints,
        });
        expect(lightLlm.source).toContain('记忆宫殿副模型');
    });

    it('把记忆宫殿 Embedding / Rerank / Supabase 与主动消息和主对话明确分开', () => {
        const emb = identifyNetworkRequestSource({
            url: 'https://api.siliconflow.cn/v1/embeddings',
            method: 'POST',
            body: JSON.stringify({ model: 'BAAI/bge-m3', input: ['a', 'b', 'c'] }),
            endpoints: baseEndpoints,
        });
        expect(emb.source).toBe('记忆宫殿 · Embedding 向量化');
        expect(emb.category).toBe('embedding');
        expect(emb.model).toBe('BAAI/bge-m3');
        expect(emb.operation).toContain('batch=3');
        expect(emb.impactHint).toContain('与主动消息推送订阅及对话主 API 不是同一个接口');

        const supa = identifyNetworkRequestSource({
            url: 'https://xyzcompany.supabase.co/rest/v1/rpc/match_vectors',
            method: 'POST',
            endpoints: baseEndpoints,
        });
        expect(supa.source).toBe('记忆宫殿 · 远程向量库 (Supabase)');
        expect(supa.category).toBe('vector-db');
    });

    it('识别主动消息 2.0 直连 Worker 与经大陆中转的各种子接口', () => {
        const token = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
        const relayedInstant = identifyNetworkRequestSource({
            url: `https://amsg-relay.friedsully.com/t/${token}/sullyos-amsg.louis810.workers.dev/instant-chat`,
            method: 'POST',
            endpoints: baseEndpoints,
        });
        expect(relayedInstant.source).toBe('主动消息 2.0 · 即时对话（经大陆中转）');
        expect(relayedInstant.via).toBe('amsg-relay');
        expect(relayedInstant.upstreamTarget).toBe('sullyos-amsg.louis810.workers.dev');

        const directSync = identifyNetworkRequestSource({
            url: 'https://sullyos-amsg.louis810.workers.dev/client-state',
            method: 'PUT',
            endpoints: baseEndpoints,
        });
        expect(directSync.source).toBe('主动消息 2.0 · 云端状态同步');
        expect(directSync.via).toBe('direct');
    });

    it('识别主代理 Worker 下的网易云、微博、WebDAV、点单 MCP、热榜搜索等各条支线', () => {
        expect(identifyNetworkRequestSource({
            url: 'https://proxy.friedsully.com/netease/song/url',
            method: 'POST',
            endpoints: baseEndpoints,
        })).toMatchObject({
            source: '音乐 · 网易云代理 (song/url)',
            category: 'music',
            via: 'proxy-worker',
        });

        expect(identifyNetworkRequestSource({
            url: 'https://proxy.friedsully.com/webdav?url=' + encodeURIComponent('https://dav.jianguoyun.com/dav/SullyBackup/'),
            method: 'POST',
            headers: { 'X-WebDAV-Method': 'PROPFIND' },
            endpoints: baseEndpoints,
        })).toMatchObject({
            source: '云备份 · WebDAV 代理 (PROPFIND)',
            category: 'backup',
            via: 'proxy-worker',
            upstreamTarget: 'dav.jianguoyun.com',
        });

        expect(identifyNetworkRequestSource({
            url: 'https://proxy.friedsully.com/weibo',
            method: 'POST',
            body: JSON.stringify({ action: 'timeline' }),
            endpoints: baseEndpoints,
        }).source).toBe('好友圈 · 微博同步 (timeline)');

        expect(identifyNetworkRequestSource({
            url: 'https://proxy.friedsully.com/mcp/luckin',
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'search_menu' } }),
            endpoints: baseEndpoints,
        })).toMatchObject({
            source: 'MCP · 瑞幸点单代理',
            operation: 'tools/call:search_menu',
        });
    });

    it('识别通用 MCP（经代理转发与直连）、语音服务、彼方、装扮与本机资源', () => {
        const mcpProxied = identifyNetworkRequestSource({
            url: 'https://my-mcp-proxy.workers.dev/?target=' + encodeURIComponent('https://mcp.amap.com/sse'),
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'maps_weather' } }),
            endpoints: baseEndpoints,
        });
        expect(mcpProxied.source).toBe('MCP · 高德地图 MCP（经代理）');
        expect(mcpProxied.operation).toBe('tools/call:maps_weather');

        expect(identifyNetworkRequestSource({
            url: 'https://api.minimaxi.com/v1/t2a_v2',
            method: 'POST',
            endpoints: baseEndpoints,
        }).source).toContain('MiniMax 语音合成');

        expect(identifyNetworkRequestSource({
            url: 'https://bifang.friedsully.com/po/poem/active',
            method: 'GET',
            endpoints: baseEndpoints,
        }).source).toContain('彼方 · 信号坠落处');

        expect(identifyNetworkRequestSource({
            url: 'https://beauty.friedsully.com/api/shares/S-1234',
            method: 'GET',
            endpoints: baseEndpoints,
        }).source).toBe('装扮 · 美化分享码服务');

        expect(identifyNetworkRequestSource({
            url: 'https://friedsully.com/room3d/catalog.json',
            method: 'GET',
            pageOrigin: 'https://friedsully.com',
            endpoints: baseEndpoints,
        }).source).toBe('本机资源 · 3D 家园模型/动作素材');
    });
});

describe('SystemLog 组装与关键排障守卫', () => {
    it('真实复现：前台发消息时后台 Embedding 报 Load failed，绝不再打成笼统的 source="Network" 且不冒认前台聊天归属', () => {
        const { log, kind } = buildFetchFailureSystemLog({
            url: 'https://api.siliconflow.cn/v1/embeddings',
            method: 'POST',
            body: JSON.stringify({ model: 'BAAI/bge-m3', input: ['最近聊到的猫粮'] }),
            durationMs: 1727,
            error: new TypeError('Load failed'),
            startedAtPerf: 100,
            // 没有显式 meta，只有用户在消息界面的环境快照
            ambientMeta: { appId: 'chat', appName: '消息', charId: 'char-1', charName: 'Sully' },
            visibilityAtStart: 'visible',
            visibilityAtEnd: 'visible',
            caller: 'callEmbeddingAPI (utils/memoryPalace/embedding.ts:129:26)',
            endpoints: baseEndpoints,
            pageOrigin: 'https://qegj567-cloud.github.io',
            pageProtocol: 'https:',
            online: true,
            perf: { getEntriesByName: () => [] },
        });

        expect(kind).toBe('blocked');
        expect(log.source).toBe('记忆宫殿 · Embedding 向量化');
        expect(log.source).not.toBe('Network');
        expect(log.message).toContain('POST api.siliconflow.cn/v1/embeddings');
        expect(log.message).toContain('Load failed');
        expect(log.context).toMatchObject({
            category: 'embedding',
            failureKind: 'blocked',
            model: 'BAAI/bge-m3',
            attributionMode: 'ambient',
            appName: '消息',
            charName: 'Sully',
            backgroundedDuringRequest: false,
        });
        expect(log.detail).toContain('模块来源: 记忆宫殿 · Embedding 向量化');
        expect(log.detail).toContain('当时前台状态: 界面=消息 · 当前角色=Sully（未显式传归属，可能是后台自动任务）');
        expect(log.detail).not.toContain('调用点显式标记');
        expect(log.detail).toContain('与主动消息推送订阅及对话主 API 不是同一个接口');
    });

    it('请求期间切过后台/锁屏时，主动点明移动端后台断连线索', () => {
        const { log } = buildFetchFailureSystemLog({
            url: 'https://open.selart.cc/v1/chat/completions',
            method: 'POST',
            body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: '在吗' }] }),
            durationMs: 8420,
            error: new TypeError('Load failed'),
            startedAtPerf: 200,
            explicitMeta: { appName: '消息', charName: 'Sully', purpose: '聊天回复' },
            visibilityAtStart: 'visible',
            visibilityAtEnd: 'visible', // iOS 切回前台后才执行 catch
            backgroundedDuringRequest: true,
            endpoints: baseEndpoints,
            pageOrigin: 'https://friedsully.com',
            pageProtocol: 'https:',
            online: true,
            perf: { getEntriesByName: () => [] },
        });

        expect(log.message).toContain('期间切过后台');
        expect(log.context?.backgroundedDuringRequest).toBe(true);
        expect(log.context?.attributionMode).toBe('explicit');
        expect(log.detail).toContain('请求期间进入过后台/锁屏');
        expect(log.detail).toContain('优先保持前台重试一次');
    });

    it('已收到 HTTP 200 响应头后在流式读取途中报错，归为 stream-interrupted 且不做无意义的 no-cors 探测', () => {
        const { log, kind } = buildFetchFailureSystemLog({
            url: 'https://open.selart.cc/v1/chat/completions',
            method: 'POST',
            durationMs: 24_500,
            error: new TypeError('network error'),
            startedAtPerf: 300,
            explicitMeta: { appName: '见面', purpose: '剧情见面生成' },
            responseHeadersReceived: {
                status: 200,
                headersMs: 680,
                contentType: 'text/event-stream',
                streamUpgraded: true,
            },
            endpoints: baseEndpoints,
            pageOrigin: 'https://friedsully.com',
            pageProtocol: 'https:',
            online: true,
        });

        expect(kind).toBe('stream-interrupted');
        expect(shouldProbeReachability(kind)).toBe(false);
        expect(log.message).toContain('流式读取中断(HTTP 200)');
        expect(log.detail).toContain('已于 680ms 收到 HTTP 200 响应头');
        expect(log.detail).toContain('DNS、跨域头和初始握手均已通过');
        expect(log.detail).not.toContain('DNS 解析不到');
    });

    it('HTTP 状态错误精确提取服务商报错与中转错误码，且放过 WebDAV 404 等正常探测', () => {
        const webdavId = identifyNetworkRequestSource({
            url: 'https://proxy.friedsully.com/webdav',
            method: 'POST',
            headers: { 'X-WebDAV-Method': 'PROPFIND' },
            endpoints: baseEndpoints,
        });
        expect(shouldLogHttpStatusError({ status: 404, identity: webdavId })).toBe(false);

        const token = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
        const relayUrl = `https://amsg-relay.friedsully.com/t/${token}/sullyos-amsg.louis810.workers.dev/instant-chat`;
        const relayId = identifyNetworkRequestSource({ url: relayUrl, method: 'POST', endpoints: baseEndpoints });
        expect(shouldLogHttpStatusError({ status: 401, identity: relayId, relayErrorCode: 'invalid_token' })).toBe(true);

        const relayLog = buildHttpErrorSystemLog({
            url: relayUrl,
            method: 'POST',
            status: 401,
            responseText: '{"error":"invalid_token"}',
            relayErrorCode: 'invalid_token',
            durationMs: 120,
            identity: relayId,
        });
        expect(relayLog.source).toBe('主动消息 2.0 · 即时对话（经大陆中转）');
        expect(relayLog.message).toContain('HTTP 401');
        expect(relayLog.message).toContain('中转令牌无效');
        expect(JSON.stringify(relayLog)).not.toContain(token);
    });

    it('shouldShowNetworkSelfCheck 只对真实连接故障打开自查清单，不对 HTTP 业务错误或主动取消误弹', () => {
        const httpLog = buildHttpErrorSystemLog({
            url: 'https://open.selart.cc/v1/chat/completions',
            method: 'POST',
            status: 429,
            responseText: '{"error":{"message":"Rate limit reached"}}',
            endpoints: baseEndpoints,
        });
        const abortErr = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
        const abortedLog = buildFetchFailureSystemLog({
            url: 'https://open.selart.cc/v1/chat/completions',
            error: abortErr,
            startedAtPerf: 0,
            endpoints: baseEndpoints,
        }).log;
        const blockedLog = buildFetchFailureSystemLog({
            url: 'https://api.siliconflow.cn/v1/embeddings',
            error: new TypeError('Failed to fetch'),
            startedAtPerf: 0,
            online: true,
            pageProtocol: 'https:',
            endpoints: baseEndpoints,
        }).log;

        expect(shouldShowNetworkSelfCheck([httpLog, abortedLog])).toBe(false);
        expect(shouldShowNetworkSelfCheck([httpLog, blockedLog])).toBe(true);
    });

    it('console.error 来源识别与调用栈提取、JSON 导出包裹结构正常运作', () => {
        const stack = [
            'Error',
            '    at captureCallerHint (https://friedsully.com/assets/networkRequestSource.ts:510:12)',
            '    at patchedFetch (https://friedsully.com/context/OSContext.tsx:1199:20)',
            '    at safeFetchJson (https://friedsully.com/utils/safeApi.ts:467:28)',
            '    at callEmbeddingAPI (https://friedsully.com/utils/memoryPalace/embedding.ts?t=12345:129:26)',
            '    at recallMemories (https://friedsully.com/utils/memoryPalace/pipeline.ts:88:14)',
        ].join('\n');
        const caller = extractCallerHint(stack);
        expect(caller).toBe('callEmbeddingAPI (utils/memoryPalace/embedding.ts:129:26) <- recallMemories (utils/memoryPalace/pipeline.ts:88:14)');

        expect(identifyApplicationErrorSource('❌ [Embedding] API 400: input too long')).toBe('应用报错 · 记忆宫殿 · Embedding');
        const appLog = buildConsoleErrorSystemLog({
            message: '❌ [MemoryPalace] 后台处理异常: quota exceeded',
            caller,
            ambientMeta: { appName: '消息', charName: 'Sully' },
        });
        expect(appLog.source).toBe('应用报错 · 记忆宫殿');
        expect(appLog.detail).toContain('当时前台状态: 界面=消息 · 当前角色=Sully');

        const exported = buildSystemLogsExportPayload([appLog]);
        expect(exported.count).toBe(1);
        expect(exported.build.appVersion).toBeTruthy();
        expect(exported.logs[0].source).toBe('应用报错 · 记忆宫殿');
    });

    it('classifyFetchFailure 在收到响应头但请求被主动 abort 时仍判为 aborted', () => {
        const err = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
        expect(classifyFetchFailure({
            url: 'https://open.selart.cc/v1/chat/completions',
            error: err,
            responseHeadersReceived: { status: 200, headersMs: 300 },
        })).toBe('aborted');
    });
});

// utils/networkFailureDiagnosis.test.ts
// 回归守卫：
//   1. 调试终端里那条 network 日志不能再退回「Failed to fetch + 一个 URL」——方法、耗时、
//      在线状态、跨域与否、初判、可能原因，少一样用户就又只能来问作者。
//   2. 分类不能认错：主动取消 / 离线 / https 打 http / 地址非法 这四种都有确定结论，
//      混进 blocked 会白白多打一次探测，还会给出跑偏的排查方向。
//   3. no-cors 复检的两个结论必须泾渭分明：「通了」指向 CORS/限流，「没通」指向线路，
//      两边要查的东西完全相反，说反了比不说更糟。
//   4. 探测有 30s 冷却：一串请求同时炸时不能对同一个域名连打探测。
//   5. Resource Timing 只认本次请求那条记录。同一个地址被反复请求时，timeline 里躺着
//      早先成功过的记录，误取会打出「对方其实回了 200」这种跟事实相反的结论。
import { describe, it, expect, beforeEach } from 'vitest';
import {
    NETWORK_SELF_CHECK_STEPS,
    buildFetchFailureDetail,
    buildFetchFailureSystemLog,
    classifyFetchFailure,
    describeReachabilityProbe,
    parseTargetUrl,
    probeOriginReachability,
    readResourceTimingHint,
    readStallHint,
    resetReachabilityProbeCooldown,
    shouldProbeReachability,
    summarizeFetchRequestBody,
} from './networkFailureDiagnosis';

const failedToFetch = () => new TypeError('Failed to fetch');

it('keeps cancellation advice ahead of generic network/provider advice', () => {
    const { log, kind } = buildFetchFailureSystemLog({ url: 'https://api.example/v1/chat/completions',
        error: new DOMException('同行已停止：识别到新的语音输入', 'AbortError'), startedAtPerf: 0,
        advice: { title: 'API 请求失败', action: '请检查网络并联系服务商' } });
    expect(kind).toBe('aborted');
    expect(log.advice?.title).toContain('请求已取消');
    expect(log.advice?.action).not.toContain('联系服务商');
    expect(log.detail).toContain('识别到新的语音输入');
});

describe('classifyFetchFailure', () => {
    it('Chrome / Safari / Firefox 三种说法都算「拿不到响应」', () => {
        for (const msg of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource']) {
            expect(classifyFetchFailure({
                url: 'https://proxy.friedsully.com/api/health',
                error: new TypeError(msg),
                online: true,
                pageProtocol: 'https:',
            })).toBe('blocked');
        }
    });

    it('主动取消不算网络失败', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        expect(classifyFetchFailure({ url: 'https://a.example.com/x', error: err })).toBe('aborted');
    });

    // 线上实测踩到过：AbortSignal.timeout() 抛的是 TimeoutError("signal timed out")，
    // 既不含 abort 字样也不是 TypeError，一度掉进 unknown，日志只剩「不符合已知形态」。
    it('AbortSignal.timeout 的 TimeoutError 归到 timeout，不是 aborted、更不是 unknown', () => {
        const err = new Error('signal timed out');
        err.name = 'TimeoutError';
        expect(classifyFetchFailure({ url: 'https://proxy.friedsully.com/api/health', error: err })).toBe('timeout');
    });

    it('timeout 和 blocked 都要做连通性复检，其余不做', () => {
        expect(shouldProbeReachability('timeout')).toBe(true);
        expect(shouldProbeReachability('blocked')).toBe(true);
        expect(shouldProbeReachability('unknown')).toBe(true);
        expect(shouldProbeReachability('aborted')).toBe(false);
        expect(shouldProbeReachability('offline')).toBe(false);
        expect(shouldProbeReachability('mixed-content')).toBe(false);
        expect(shouldProbeReachability('bad-url')).toBe(false);
    });

    it('浏览器报离线时优先归到离线', () => {
        expect(classifyFetchFailure({
            url: 'https://a.example.com/x', error: failedToFetch(), online: false, pageProtocol: 'https:',
        })).toBe('offline');
    });

    it('https 页面打 http 地址 → 混合内容，且优先级高于离线判定', () => {
        expect(classifyFetchFailure({
            url: 'http://a.example.com/x', error: failedToFetch(), online: false, pageProtocol: 'https:',
        })).toBe('mixed-content');
    });

    it('http://localhost 不当混合内容拦（Chrome 视其为可信来源）', () => {
        expect(classifyFetchFailure({
            url: 'http://localhost:18060/api/health', error: failedToFetch(), online: true, pageProtocol: 'https:',
        })).toBe('blocked');
    });

    it('地址本身不合法 → bad-url', () => {
        expect(classifyFetchFailure({
            url: 'sullymeow ccwu cc/api', error: failedToFetch(), online: true, pageProtocol: 'https:',
        })).toBe('bad-url');
    });
});

describe('summarizeFetchRequestBody', () => {
    it('只保留结构统计，不泄露剧情正文', () => {
        const summary = summarizeFetchRequestBody(JSON.stringify({
            messages: [
                { role: 'system', content: '绝不能写进日志的秘密设定' },
                { role: 'assistant', content: '预填充' },
            ],
            stream: true,
            top_p: 0.7,
            presence_penalty: 0.2,
        }));
        expect(summary).toMatchObject({
            messageCount: 2,
            contentChars: 15,
            lastMessageRole: 'assistant',
            stream: true,
            optionalParams: ['top_p', 'presence_penalty'],
        });
        expect(JSON.stringify(summary)).not.toContain('秘密设定');
    });
});

describe('buildFetchFailureDetail', () => {
    const detail = () => buildFetchFailureDetail({
        url: 'https://proxy.friedsully.com/api/health',
        method: 'get',
        durationMs: 43,
        error: failedToFetch(),
        online: true,
        pageOrigin: 'https://sullyos.example.com',
        pageProtocol: 'https:',
    }, { startedAt: 0, perf: { getEntriesByName: () => [] } });

    it('把能补的旁证全补上', () => {
        const text = detail();
        expect(text).toContain('URL: https://proxy.friedsully.com/api/health');
        expect(text).toContain('GET');
        expect(text).toContain('43ms');
        expect(text).toContain('TypeError: Failed to fetch');
        expect(text).toContain('proxy.friedsully.com');
        expect(text).toContain('跨域');
        expect(text).toContain('在线');
        expect(text).toContain('初判:');
        expect(text).toContain('可能原因:');
    });

    it('同源请求不会被标成跨域', () => {
        const text = buildFetchFailureDetail({
            url: 'https://sullyos.example.com/api/x',
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://sullyos.example.com',
            pageProtocol: 'https:',
        }, { startedAt: 0, perf: { getEntriesByName: () => [] } });
        expect(text).toContain('同源');
        expect(text).not.toContain('跨域请求');
    });

    it('同一个 POST 刚成功时，不再把剧情模式失败甩给 DNS 或整域名代理', () => {
        const now = 1_786_894_455_703;
        const text = buildFetchFailureDetail({
            url: 'https://open.selart.cc/v1/chat/completions',
            method: 'POST',
            durationMs: 3828,
            error: new TypeError('Load failed'),
            online: true,
            pageOrigin: 'https://qegj567-cloud.github.io',
            pageProtocol: 'https:',
            requestPurpose: '剧情见面生成',
            requestSummary: summarizeFetchRequestBody(JSON.stringify({
                messages: [{ role: 'system', content: '设定' }, { role: 'assistant', content: '<content>' }],
                stream: true,
                top_p: 0.8,
            })),
            recentSuccessfulSameRequest: { timestamp: now - 42_000, status: 200 },
        }, { startedAt: 0, now, perf: { getEntriesByName: () => [] } });

        expect(text).toContain('调用用途: 剧情见面生成');
        expect(text).toContain('messages=2');
        expect(text).toContain('末条 role=assistant');
        expect(text).toContain('额外参数: top_p');
        expect(text).toContain('同一个 POST 已成功返回 HTTP 200');
        expect(text).toContain('当前请求/响应特有的失败');
        expect(text).toContain('剧情上下文或请求体更大');
        expect(text).toContain('末条 assistant 预填充或额外参数');
        expect(text).not.toContain('DNS 解析不到');
        expect(text).not.toContain('代理把这个域名的连接掐了');
    });

    it('普通聊天和记忆请求不会套用剧情专属诊断', () => {
        const now = 1_786_894_455_703;
        const text = buildFetchFailureDetail({
            url: 'https://open.selart.cc/v1/chat/completions',
            method: 'POST',
            durationMs: 3828,
            error: new TypeError('Load failed'),
            online: true,
            pageOrigin: 'https://qegj567-cloud.github.io',
            pageProtocol: 'https:',
            requestPurpose: '记忆提取',
            requestSummary: summarizeFetchRequestBody(JSON.stringify({
                messages: [{ role: 'system', content: '设定' }, { role: 'assistant', content: '<content>' }],
                stream: false,
                top_p: 0.8,
            })),
            recentSuccessfulSameRequest: { timestamp: now - 42_000, status: 200 },
        }, { startedAt: 0, now, perf: { getEntriesByName: () => [] } });

        expect(text).toContain('调用用途: 记忆提取');
        expect(text).toContain('当前请求体或响应与刚才成功的请求不同');
        expect(text).toContain('上游限流或临时故障');
        expect(text).not.toContain('剧情上下文');
        expect(text).not.toContain('assistant 预填充');
    });

    it('混合内容给的是「改成 https」而不是「查梯子」', () => {
        const text = buildFetchFailureDetail({
            url: 'http://my-bridge.example.com/api/health',
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://sullyos.example.com',
            pageProtocol: 'https:',
        }, { startedAt: 0, perf: { getEntriesByName: () => [] } });
        expect(text).toContain('混合内容');
        expect(text).not.toContain('DNS 解析不到');
    });

    // 复刻线上那条真实日志：/api/health 被 10s 超时掐断。旧版把它归到 unknown，
    // 初判打成「不符合已知的几种失败形态」、可能原因打成「看下面的错误原文」——等于没说。
    it('10s 超时的探活不能再打出「不符合已知形态」', () => {
        const err = new Error('signal timed out');
        err.name = 'TimeoutError';
        const text = buildFetchFailureDetail({
            url: 'https://proxy.friedsully.com/api/health',
            method: 'GET',
            durationMs: 10001,
            error: err,
            online: true,
            pageOrigin: 'https://qegj567-cloud.github.io',
            pageProtocol: 'https:',
        }, { startedAt: 0, perf: { getEntriesByName: () => [] } });
        expect(text).toContain('请求超时');
        expect(text).toContain('不能仅凭耗时确定失败阶段');
        expect(text).not.toContain('不符合已知');
        expect(text).not.toContain('看下面的错误原文');
    });

    it('Resource Timing 里有状态码时，直接点破「不是网络不通」', () => {
        const text = buildFetchFailureDetail({
            url: 'https://proxy.friedsully.com/api/health',
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://sullyos.example.com',
            pageProtocol: 'https:',
        }, {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [{ startTime: 50_010, responseStatus: 429, transferSize: 0, duration: 120 }],
            },
        });
        expect(text).toContain('responseStatus=429');
        expect(text).toContain('CORS');
    });

    // 整条日志级别的守卫：早先那次成功的记录不能反过来推翻本次「挂了 10s、一个字节没收到」
    // 的判断。两句结论同时出现在一条日志里，用户只会更懵。
    it('挂 10s 的失败不能被历史记录改口成「对方其实回了 200」', () => {
        const text = buildFetchFailureDetail({
            url: 'https://sullyos-amsg.example.workers.dev/client-state',
            method: 'PUT',
            durationMs: 10078,
            error: failedToFetch(),
            online: true,
            pageOrigin: 'https://qegj567-cloud.github.io',
            pageProtocol: 'https:',
        }, {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [{ startTime: 9_000, responseStatus: 200, transferSize: 0, duration: 1038 }],
            },
        });
        expect(text).toContain('不能仅凭耗时确定失败阶段');
        expect(text).not.toContain('对方其实回了');
        expect(text).not.toContain('responseStatus=200');
    });
});

describe('readStallHint', () => {
    it('MiniMax 的快速 GET 失败保留 CORS 可能性，不误判为请求未发出', () => {
        const text = buildFetchFailureDetail({
            url: 'https://audio.example.com/voice.mp3', method: 'GET', durationMs: 162,
            error: new TypeError('Load failed'), online: true, pageOrigin: 'https://friedsully.com',
        }, { startedAt: 0, perf: { getEntriesByName: () => [] } });
        expect(text).toContain('请求: GET');
        expect(text).toContain('CORS');
        expect(text).not.toContain('拿到响应头之前就失败');
        expect(text).not.toContain('通常说明连接压根没建立');
    });
    it('耗时较长不能确定卡在连接阶段，也可能是上游处理或 CORS', () => {
        const hint = readStallHint(20187, 'blocked');
        expect(hint).toContain('20.2s');
        expect(hint).toContain('代理');
        expect(hint).toContain('CORS');
        expect(hint).toContain('不能仅凭耗时');
        expect(hint).not.toContain('一个字节都没收到');
    });

    it('几十毫秒就失败也可能是已收到响应后的 CORS 拒绝', () => {
        const hint = readStallHint(43, 'blocked');
        expect(hint).toContain('CORS');
        expect(hint).toContain('DNS');
        expect(hint).not.toContain('连接建立阶段被吞');
    });

    it('中间地带不硬猜（宁可不说）', () => {
        expect(readStallHint(1500, 'blocked')).toBe('');
    });

    it('已有确定结论的几类不掺和耗时猜测', () => {
        expect(readStallHint(20000, 'mixed-content')).toBe('');
        expect(readStallHint(20000, 'aborted')).toBe('');
    });
});

describe('readResourceTimingHint', () => {
    it('没有记录时不武断认定连接未建立', () => {
        expect(readResourceTimingHint('https://a.example.com/x', {
            startedAt: 1000, perf: { getEntriesByName: () => [] },
        })).toContain('没有这条请求的记录');
    });

    it('同一 URL 请求过多次时，取本次这条', () => {
        const hint = readResourceTimingHint('https://a.example.com/x', {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [
                    { startTime: 9_000, responseStatus: 200, duration: 1038 },
                    { startTime: 50_120, responseStatus: 503, duration: 88 },
                ],
            },
        });
        expect(hint).toContain('503');
        expect(hint).not.toContain('1038');
    });

    // 线上翻车实录：/client-state 被反复 PUT，timeline 里躺着早先成功那次的 200。本次连接
    // 压根没建立、什么都没往 timeline 里写，旧版取「最后一条」就把那条陈旧的 200 当成了本次
    // 的响应，打出「对方其实回了 HTTP 200，是响应被 CORS 拦掉的」——跟同一条日志里「挂了
    // 10.1s 一个字节没收到」「no-cors 也连不上」直接打架，把人往查 CORS 的方向带。
    it('不能把早先成功那次的记录当成本次失败的证据', () => {
        const hint = readResourceTimingHint('https://sullyos-amsg.example.workers.dev/client-state', {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [
                    { startTime: 9_000, responseStatus: 200, transferSize: 0, duration: 1038 },
                ],
            },
        });
        expect(hint).toContain('没有这条请求的记录');
        expect(hint).not.toContain('200');
        expect(hint).not.toContain('CORS');
    });

    // 跨域拿不到 Timing-Allow-Origin 授权时，responseStatus / transferSize 被规范统统置 0。
    // 直接印出来会被读成「状态码是 0」「一个字节都没传」——后者尤其坑，跟「连接被吞」是完全
    // 不同的两回事。这时候只有耗时可信，其余整个不印，并说清为什么少了。
    it('拿不到 Timing-Allow-Origin 时只报耗时，不印那两个恒为 0 的字段', () => {
        const hint = readResourceTimingHint('https://a.example.com/x', {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [
                    { startTime: 50_010, responseStart: 0, responseStatus: 0, transferSize: 0, duration: 10_078 },
                ],
            },
        });
        expect(hint).not.toContain('responseStatus');
        expect(hint).not.toContain('transferSize');
        expect(hint).toContain('10078ms');
        expect(hint).toContain('Timing-Allow-Origin');
    });

    // 有授权时 transferSize=0 才真的是「没传字节」，得照常给。这条同时钉住 responseStart
    // 这个探针：Safari 没有 responseStatus 字段，只能靠它判断有没有授权。
    it('有 Timing-Allow-Origin 授权时照常给字节数', () => {
        const hint = readResourceTimingHint('https://a.example.com/x', {
            startedAt: 50_000,
            perf: {
                getEntriesByName: () => [{ startTime: 50_010, responseStart: 50_050, transferSize: 0, duration: 88 }],
            },
        });
        expect(hint).toContain('transferSize=0');
        expect(hint).not.toContain('Timing-Allow-Origin');
    });

    it('performance 不可用时静默返回空串，不能抛', () => {
        expect(readResourceTimingHint('https://a.example.com/x', { startedAt: 0, perf: {} })).toBe('');
        expect(readResourceTimingHint('https://a.example.com/x', {
            startedAt: 0,
            perf: { getEntriesByName: () => { throw new Error('boom'); } },
        })).toBe('');
    });

    // 没有 performance.now() 就没法分辨哪条记录是本次的，这时候整段不出比瞎猜强。
    it('拿不到发起时刻时整段不出，不退回「取最后一条」', () => {
        expect(readResourceTimingHint('https://a.example.com/x', {
            startedAt: Number.NaN,
            perf: { getEntriesByName: () => [{ startTime: 9_000, responseStatus: 200 }] },
        })).toBe('');
    });
});

describe('probeOriginReachability', () => {
    beforeEach(() => resetReachabilityProbeCooldown());

    it('打的是域名根路径，不是原地址——原地址可能有副作用', async () => {
        const seen: any[] = [];
        const fakeFetch = ((url: any, init: any) => { seen.push([url, init]); return Promise.resolve(new Response('')); }) as any;
        const verdict = await probeOriginReachability('https://proxy.friedsully.com/api/publish', fakeFetch);
        expect(verdict).toBe('reachable');
        expect(seen[0][0]).toBe('https://proxy.friedsully.com/');
        expect(seen[0][1].mode).toBe('no-cors');
        expect(seen[0][1].credentials).toBe('omit');
    });

    it('探测也失败 → unreachable', async () => {
        const fakeFetch = (() => Promise.reject(failedToFetch())) as any;
        expect(await probeOriginReachability('https://proxy.friedsully.com/api/health', fakeFetch)).toBe('unreachable');
    });

    it('被超时控制器掐断 → timeout，不是 unreachable', async () => {
        const fakeFetch = (() => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            return Promise.reject(err);
        }) as any;
        expect(await probeOriginReachability('https://proxy.friedsully.com/api/health', fakeFetch)).toBe('timeout');
    });

    it('同一域名 30s 内只探一次', async () => {
        let calls = 0;
        const fakeFetch = (() => { calls += 1; return Promise.resolve(new Response('')); }) as any;
        const now = () => 1_000_000;
        expect(await probeOriginReachability('https://a.example.com/1', fakeFetch, { now })).toBe('reachable');
        expect(await probeOriginReachability('https://a.example.com/2', fakeFetch, { now })).toBe('cooldown');
        expect(calls).toBe(1);
        // 换个域名不受上一个的冷却影响
        expect(await probeOriginReachability('https://b.example.com/1', fakeFetch, { now })).toBe('reachable');
        expect(calls).toBe(2);
    });

    it('地址非法直接跳过，不浪费一次请求', async () => {
        let calls = 0;
        const fakeFetch = (() => { calls += 1; return Promise.resolve(new Response('')); }) as any;
        expect(await probeOriginReachability('not a url', fakeFetch)).toBe('skipped');
        expect(calls).toBe(0);
    });
});

describe('describeReachabilityProbe', () => {
    it('通了 → 只确认域名可达，并警告生成后失败仍可能计费', () => {
        const text = describeReachabilityProbe('reachable', 'proxy.friedsully.com', 'POST');
        expect(text).toContain('域名当前可达');
        expect(text).toContain('原 POST');
        expect(text).toContain('CORS');
        expect(text).toContain('可能计费');
        expect(text).toContain('不要连续重发');
        expect(text).not.toContain('问题出在响应本身');
        expect(text).not.toContain('梯子的分流规则');
    });

    it('GET 音频下载失败不能被说成 POST 生成失败', () => {
        const text = describeReachabilityProbe('reachable', 'audio.example.com', 'GET');
        expect(text).toContain('原 GET');
        expect(text).toContain('资源加载失败不等于生成失败');
        expect(text).not.toContain('POST');
        expect(text).not.toContain('可能计费');
    });

    it('没通 → 指向线路，不能再提 CORS 把人带偏', () => {
        const text = describeReachabilityProbe('unreachable', 'proxy.friedsully.com');
        expect(text).toContain('连不上');
        expect(text).toContain('梯子');
        expect(text).not.toContain('域名当前可达');
    });

    it('冷却期内要说清「已经查过了，看上一条」，不能一声不吭让人以为漏了', () => {
        expect(describeReachabilityProbe('cooldown', 'proxy.friedsully.com')).toContain('之前那一条日志');
    });

    it('skipped 不产出文案（不往日志里塞废话）', () => {
        expect(describeReachabilityProbe('skipped', 'a.example.com')).toBe('');
    });
});

describe('parseTargetUrl / 自查清单', () => {
    it('相对地址按 base 解析', () => {
        expect(parseTargetUrl('/api/health', 'https://sullyos.example.com/index.html').host).toBe('sullyos.example.com');
    });

    it('自查清单第一步就是「换节点 / 关梯子直连」', () => {
        expect(NETWORK_SELF_CHECK_STEPS.length).toBeGreaterThanOrEqual(4);
        expect(NETWORK_SELF_CHECK_STEPS[0]).toContain('梯子');
    });
});

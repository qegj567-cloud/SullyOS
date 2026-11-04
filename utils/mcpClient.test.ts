import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    buildMcpFetchUrl,
    buildMcpRequestHeaders,
    createMcpServer,
    loadMcpServers,
    saveMcpServers,
    exportMcpLocal,
    importMcpLocal,
    getEnabledMcpServers,
    hasWorkerUnreachableMcpServer,
    isMcpChatAvailable,
    getMcpUseNativeTools,
    setMcpUseNativeTools,
    collectMcpFireServers,
    callMcpTool,
    normalizeMcpToolArguments,
    MCP_REQUEST_TIMEOUT_MS,
    type McpServerConfig,
} from './mcpClient';
import {
    buildMcpOpenAITools,
    buildMcpRejectedToolsFallbackBody,
    buildMcpSystemBlock,
    buildMcpTextFallbackBody,
    formatMcpToolResult,
    MCP_CHAT_MAX_STALLED_ROUNDS,
    MCP_CHAT_MAX_TOOL_LOOPS,
    MCP_RESULT_MAX_CHARS,
    MCP_TAIL_REMINDER,
    sanitizeMcpLeadInText,
    shouldRetryMcpWithoutTools,
    stripTextFakedMcpCalls,
} from './mcpToolBridge';
import { completeGroupChatWithMcp } from './groupChat/mcp';
import { formatApiErrorPayload } from './safeApi';

const mkServer = (over: Partial<McpServerConfig>): McpServerConfig => ({
    ...createMcpServer('测试', 'https://mcp.example.com/mcp'),
    enabled: true,
    tools: [{ name: 'search', description: '搜点东西', inputSchema: { type: 'object', properties: {} } }],
    ...over,
});

beforeEach(() => {
    localStorage.removeItem('aetheros.mcp.servers');
    localStorage.removeItem('aetheros.mcp.useNativeTools');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('buildMcpFetchUrl', () => {
    it('没配代理就直连服务器 URL', () => {
        expect(buildMcpFetchUrl({ url: 'https://mcp.example.com/mcp' })).toBe('https://mcp.example.com/mcp');
    });

    it('配了代理包成 ?target=<url-encoded>（与 worker/mcp-proxy 和 scripts/mcp-proxy.mjs 的约定一致）', () => {
        expect(buildMcpFetchUrl({ url: 'https://mcp.example.com/mcp', proxyUrl: 'http://localhost:18061' }))
            .toBe('http://localhost:18061?target=https%3A%2F%2Fmcp.example.com%2Fmcp');
    });

    it('代理尾部斜杠被剥掉，已带 query 的代理用 & 续接', () => {
        expect(buildMcpFetchUrl({ url: 'https://a.com/mcp', proxyUrl: 'https://w.dev/' }))
            .toBe('https://w.dev?target=https%3A%2F%2Fa.com%2Fmcp');
        expect(buildMcpFetchUrl({ url: 'https://a.com/mcp', proxyUrl: 'https://w.dev?x=1' }))
            .toBe('https://w.dev?x=1&target=https%3A%2F%2Fa.com%2Fmcp');
    });
});

describe('buildMcpRequestHeaders', () => {
    it('直连时发送任意自定义请求头，空行与非法头名会被忽略', () => {
        const headers = buildMcpRequestHeaders({
            customHeaders: [
                { name: 'XBY-APIKEY', value: 'secret-xby' },
                { name: '', value: 'empty-name' },
                { name: 'bad header', value: 'invalid-name' },
            ],
        });
        expect(headers.get('XBY-APIKEY')).toBe('secret-xby');
        expect(Array.from(headers.keys())).not.toContain('bad header');
        expect(headers.has('X-MCP-Forward-Headers')).toBe(false);
    });

    it('走代理时声明需要透传的自定义头；Bearer 与 session 仍由客户端托管', () => {
        const headers = buildMcpRequestHeaders({
            token: 'bearer-token',
            proxyUrl: 'https://proxy.example.com',
            proxyKey: 'proxy-secret',
            customHeaders: [
                { name: 'XBY-APIKEY', value: 'secret-xby' },
                { name: 'Authorization', value: 'Custom auth' },
            ],
        }, 'session-1', '2025-11-25');
        expect(headers.get('XBY-APIKEY')).toBe('secret-xby');
        expect(headers.get('Authorization')).toBe('Bearer bearer-token');
        expect(headers.get('Mcp-Session-Id')).toBe('session-1');
        expect(headers.get('MCP-Protocol-Version')).toBe('2025-11-25');
        expect(headers.get('X-Proxy-Key')).toBe('proxy-secret');
        expect(headers.get('X-MCP-Forward-Headers')).toBe('XBY-APIKEY,Authorization');
    });
});

describe('formatMcpToolResult', () => {
    it('正常体量的结果原样回填不截断（对象序列化, 字符串直出）', () => {
        expect(formatMcpToolResult({ memories: ['a', 'b'] })).toBe('{"memories":["a","b"]}');
        expect(formatMcpToolResult('一段长文本'.repeat(500))).toBe('一段长文本'.repeat(500));
    });

    it('超过安全上限才截断, 并标注全文长度', () => {
        const huge = 'x'.repeat(MCP_RESULT_MAX_CHARS + 100);
        const out = formatMcpToolResult(huge);
        expect(out.startsWith('x'.repeat(100))).toBe(true);
        expect(out).toContain(`全文共 ${huge.length} 字符`);
        expect(out.length).toBeLessThan(huge.length);
    });

    it('不可序列化的对象降级 String()', () => {
        const cyclic: any = {};
        cyclic.self = cyclic;
        expect(formatMcpToolResult(cyclic)).toBe('[object Object]');
    });
});

describe('服务器配置持久化', () => {
    it('save → load 往返一致，坏 JSON 回退空数组', () => {
        const s = mkServer({ name: 'Notion' });
        saveMcpServers([s]);
        expect(loadMcpServers()).toEqual([s]);
        localStorage.setItem('aetheros.mcp.servers', '{broken');
        expect(loadMcpServers()).toEqual([]);
    });

    it('导出/导入随备份走（原样字符串搬运）', () => {
        saveMcpServers([mkServer({ name: 'A' })]);
        const dump = exportMcpLocal();
        localStorage.removeItem('aetheros.mcp.servers');
        expect(loadMcpServers()).toEqual([]);
        importMcpLocal(dump);
        expect(loadMcpServers().map(s => s.name)).toEqual(['A']);
    });

    it('isMcpChatAvailable: 必须启用且已发现工具', () => {
        saveMcpServers([mkServer({ enabled: false })]);
        expect(isMcpChatAvailable()).toBe(false);
        saveMcpServers([mkServer({ tools: [] })]);
        expect(isMcpChatAvailable()).toBe(false);
        saveMcpServers([mkServer({})]);
        expect(isMcpChatAvailable()).toBe(true);
    });

    it('角色绑定: charIds 为空/缺省是通用, 非空只对绑定角色可见', () => {
        saveMcpServers([
            mkServer({ id: 'srv_common', name: '通用' }),                        // 无 charIds
            mkServer({ id: 'srv_a', name: '小A专属', charIds: ['char_a'] }),
            mkServer({ id: 'srv_empty', name: '空数组也通用', charIds: [] }),
        ]);
        // 角色 A: 通用 + 专属都可见
        expect(getEnabledMcpServers('char_a').map(s => s.id)).toEqual(['srv_common', 'srv_a', 'srv_empty']);
        // 角色 B: 只有通用
        expect(getEnabledMcpServers('char_b').map(s => s.id)).toEqual(['srv_common', 'srv_empty']);
        // 无角色上下文: 绑定服务器不可见, 不泄漏专属工具
        expect(getEnabledMcpServers().map(s => s.id)).toEqual(['srv_common', 'srv_empty']);
        expect(isMcpChatAvailable('char_b')).toBe(true);
        // 只剩绑定服务器时, 未绑定角色不进 MCP 模式
        saveMcpServers([mkServer({ id: 'srv_a', charIds: ['char_a'] })]);
        expect(isMcpChatAvailable('char_a')).toBe(true);
        expect(isMcpChatAvailable('char_b')).toBe(false);
    });

    it('群聊 ID 与角色 ID 共用绑定过滤，指定群聊可见且不会泄漏给其他群', () => {
        saveMcpServers([
            mkServer({ id: 'srv_group', charIds: ['group_game'] }),
        ]);
        expect(isMcpChatAvailable('group_game')).toBe(true);
        expect(isMcpChatAvailable('group_other')).toBe(false);
        expect(buildMcpOpenAITools('group_game').tools).toHaveLength(1);
        expect(buildMcpOpenAITools('group_other').tools).toHaveLength(0);
    });

    it('原生 tools 开关默认开启，可持久化并随 MCP 备份导入导出', () => {
        expect(getMcpUseNativeTools()).toBe(true);
        setMcpUseNativeTools(false);
        expect(getMcpUseNativeTools()).toBe(false);
        const dump = exportMcpLocal();
        localStorage.removeItem('aetheros.mcp.useNativeTools');
        expect(getMcpUseNativeTools()).toBe(true);
        importMcpLocal(dump);
        expect(getMcpUseNativeTools()).toBe(false);
    });
});

describe('buildMcpOpenAITools', () => {
    it('转成 OpenAI function 格式，暴露名映射回 (server, 真实工具名)', () => {
        const s = mkServer({ tools: [{ name: 'my.tool/x', description: 'd', inputSchema: { type: 'object' } }] });
        saveMcpServers([s]);
        const { tools, resolve } = buildMcpOpenAITools();
        expect(tools).toHaveLength(1);
        // 点号斜杠等非法字符被替换成下划线
        expect(tools[0].function.name).toBe('my_tool_x');
        const hit = resolve.get('my_tool_x')!;
        expect(hit.toolName).toBe('my.tool/x');
        expect(hit.server.id).toBe(s.id);
    });

    it('跨服务器重名时后者加服务器名前缀，互不覆盖', () => {
        const a = mkServer({ name: 'AAA' });
        const b = mkServer({ name: 'BBB' });
        saveMcpServers([a, b]);
        const { tools, resolve } = buildMcpOpenAITools();
        expect(tools.map(t => t.function.name)).toEqual(['search', 'BBB_search']);
        expect(resolve.get('search')!.server.id).toBe(a.id);
        expect(resolve.get('BBB_search')!.server.id).toBe(b.id);
        // 多服务器时描述里带来源，帮模型区分
        expect(tools[0].function.description).toContain('[AAA]');
    });

    it('未启用 / 未发现工具的服务器不注入', () => {
        saveMcpServers([mkServer({ enabled: false }), mkServer({ tools: [] })]);
        expect(buildMcpOpenAITools().tools).toHaveLength(0);
    });

    it('按角色过滤: 绑定服务器的工具只注入给绑定角色', () => {
        const common = mkServer({ name: '通用', tools: [{ name: 'web_search' }] });
        const bound = mkServer({ name: '记忆库', charIds: ['char_a'], tools: [{ name: 'breath' }] });
        saveMcpServers([common, bound]);
        expect(buildMcpOpenAITools('char_a').tools.map(t => t.function.name)).toEqual(['web_search', 'breath']);
        expect(buildMcpOpenAITools('char_b').tools.map(t => t.function.name)).toEqual(['web_search']);
        // 单服务器可见时描述不带 [来源] 前缀（multi 按角色可见数算）
        expect(buildMcpOpenAITools('char_b').tools[0].function.description).not.toContain('[通用]');
        expect(buildMcpOpenAITools('char_a').tools[0].function.description).toContain('[通用]');
    });
});

describe('MCP 高风险工具保护', () => {
    it('服务端明确标注为 destructive 的工具会自动确认，用户拒绝后不发请求', async () => {
        const server = mkServer({
            tools: [{
                name: 'delete_note',
                title: '删除笔记',
                inputSchema: { type: 'object', properties: {} },
                annotations: { destructiveHint: true },
            }],
        });
        vi.stubGlobal('window', { confirm: vi.fn().mockReturnValue(false) });
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        const result = await callMcpTool(server, 'delete_note', { id: 'n1' });
        expect(result.success).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('MCP 多步任务策略', () => {
    it('工具轮次使用 12 轮硬上限，并在连续两轮没有新结果时提前收口', () => {
        expect(MCP_CHAT_MAX_TOOL_LOOPS).toBe(12);
        expect(MCP_CHAT_MAX_STALLED_ROUNDS).toBe(2);
    });

    it('提示模型从检查推进到动作，并把用户本轮明确要求视为已确认', () => {
        saveMcpServers([mkServer({ name: '游戏盒' })]);
        const block = buildMcpSystemBlock('条条');
        expect(block).toContain('随后立刻调用能推进目标的动作工具');
        expect(block).toContain('不要反复读取同一份说明或状态');
        expect(block).toContain('本轮已经明确要求执行，即视为已经确认');
        expect(MCP_TAIL_REMINDER).toContain('本轮已明确要求的操作视为已确认');
    });

    it('文字兼容提示允许按结果继续下一步，但要求每次只输出一个调用', () => {
        const body = buildMcpRejectedToolsFallbackBody({
            messages: [{ role: 'user', content: '继续玩游戏' }],
            tools: [{ type: 'function', function: {
                name: 'play_game',
                description: '执行游戏动作',
                parameters: { type: 'object', properties: { action: { type: 'string' } } },
            } }],
            tool_choice: 'auto',
        });
        const prompt = body.messages.at(-1).content;
        expect(prompt).toContain('每一步如果需要工具，只输出一行');
        expect(prompt).toContain('选择下一步真正能推进目标的工具');
        expect(prompt).toContain('不要反复读取同一份说明或状态');
    });
});

describe('extractTextFakedMcpCalls（掉格式容错）', () => {
    const setup = () => {
        const s = mkServer({
            name: 'QA',
            tools: [
                { name: 'ask_question', description: '问答', inputSchema: { type: 'object', properties: { question: { type: 'string' }, lang: { type: 'string' } }, required: ['question'] } },
                { name: 'roll.dice/v1', description: '骰子', inputSchema: { type: 'object', properties: { sides: { type: 'number' } } } },
            ],
        });
        saveMcpServers([s]);
        return buildMcpOpenAITools().resolve;
    };

    it('括号传参: 引号字符串 / JSON / kwargs 三种形态都能解出 args', async () => {
        const { extractTextFakedMcpCalls } = await import('./mcpToolBridge');
        const resolve = setup();
        expect(extractTextFakedMcpCalls('我来查查 ask_question("SullyOS")', resolve)[0].args).toEqual({ question: 'SullyOS' });
        expect(extractTextFakedMcpCalls('ask_question({"question": "SullyOS", "lang": "zh"})', resolve)[0].args).toEqual({ question: 'SullyOS', lang: 'zh' });
        expect(extractTextFakedMcpCalls('ask_question(question="SullyOS", lang=zh)', resolve)[0].args).toEqual({ question: 'SullyOS', lang: 'zh' });
    });

    it('冒号传参(整行) + 尾部标点剥离 + 数字按 schema 转型', async () => {
        const { extractTextFakedMcpCalls } = await import('./mcpToolBridge');
        const resolve = setup();
        const colon = extractTextFakedMcpCalls('好的！\nask_question: SullyOS。\n稍等哦', resolve);
        expect(colon).toHaveLength(1);
        expect(colon[0].args).toEqual({ question: 'SullyOS' });
        // 真实名（带点号）也认, 数字被转型
        const dice = extractTextFakedMcpCalls('roll.dice/v1(20)', resolve);
        expect(dice[0].toolName).toBe('roll.dice/v1');
        expect(dice[0].args).toEqual({ sides: 20 });
        // 暴露名（sanitize 后）也认
        expect(extractTextFakedMcpCalls('roll_dice_v1(6)', resolve)[0].toolName).toBe('roll.dice/v1');
    });

    it('普通句子提到工具名不误伤; 未知工具名不匹配; 同一调用去重', async () => {
        const { extractTextFakedMcpCalls } = await import('./mcpToolBridge');
        const resolve = setup();
        expect(extractTextFakedMcpCalls('我有个 ask_question 工具, 你想问什么都可以', resolve)).toHaveLength(0);
        expect(extractTextFakedMcpCalls('句中说 ask_question: 这种格式不算（不在行首）', resolve)).toHaveLength(0);
        expect(extractTextFakedMcpCalls('delete_all("x")', resolve)).toHaveLength(0);
        expect(extractTextFakedMcpCalls('ask_question("a")\nask_question("a")', resolve)).toHaveLength(1);
    });

    it('工具前角色文字可单独展示，调用语法不会漏进气泡', async () => {
        const { extractTextFakedMcpCalls } = await import('./mcpToolBridge');
        const resolve = setup();
        const raw = '我先帮你看看。\n\nask_question({"question":"SullyOS"})';
        const calls = extractTextFakedMcpCalls(raw, resolve);
        expect(stripTextFakedMcpCalls(raw, calls)).toBe('我先帮你看看。');
    });

    it('MCP 前置气泡剥掉 think、历史时间戳和伪造的用户表情行为', () => {
        const raw = '<think>不能展示的思考</think>[2026-07-11 17:25] [你 发送了表情包: 我来搞定][2026-07-11 17:25] [聊天] 我去工具箱看看。\n</think>';
        expect(sanitizeMcpLeadInText(raw)).toBe('我去工具箱看看。');
    });
});

describe('MCP 聊天链路不悬挂', () => {
    it('只按工具 schema 还原嵌套 object / array 字符串，普通 string 保持不变', () => {
        const schema = {
            type: 'object',
            properties: {
                room: { type: 'string' },
                game: {
                    type: 'object',
                    properties: {
                        players: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { name: { type: 'string' }, stats: { type: 'object' } },
                            },
                        },
                    },
                },
            },
        };
        const input = {
            room: '{"id":"这是普通文本，不该解析"}',
            game: '{"players":"[{\\"name\\":\\"Sully\\",\\"stats\\":\\"{\\\\\\"coins\\\\\\":100}\\"}]"}',
        };

        expect(normalizeMcpToolArguments(input, schema)).toEqual({
            room: input.room,
            game: { players: [{ name: 'Sully', stats: { coins: 100 } }] },
        });
    });

    it('tools/call 发送前按 inputSchema 修复整个 arguments 双重编码', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const server = mkServer({
            id: 'nested-args-server',
            tools: [{
                name: 'start_game',
                inputSchema: {
                    type: 'object',
                    properties: {
                        config: {
                            type: 'object',
                            properties: { players: { type: 'array', items: { type: 'object' } } },
                        },
                    },
                },
            }],
        });
        let toolsCall: any;
        vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            const req = JSON.parse(String(init?.body || '{}'));
            if (req.method === 'initialize') {
                return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                }));
            }
            if (req.method === 'notifications/initialized') return Promise.resolve(new Response('', { status: 202 }));
            toolsCall = req;
            return Promise.resolve(new Response(JSON.stringify({
                jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'ok' }] },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        });

        const onceParsedByChatLayer = '{"config":"{\\"players\\":\\"[{\\\\\\"name\\\\\\":\\\\\\"A\\\\\\"}]\\"}"}';
        await expect(callMcpTool(server, 'start_game', onceParsedByChatLayer as any)).resolves.toMatchObject({ success: true });
        expect(toolsCall.params.arguments).toEqual({ config: { players: [{ name: 'A' }] } });
        expect(info).toHaveBeenCalledWith('🔌 [MCP] tools/call 完成', expect.objectContaining({
            args: { config: { players: [{ name: 'A' }] } },
        }));
    });

    it('正文假调用已代执行后，组织回复请求移除 tools，避免空正文 tool_calls 被吞', () => {
        const body = buildMcpTextFallbackBody(
            { model: 'x', tools: [{ type: 'function' }], tool_choice: 'auto', temperature: 0.8 },
            [{ role: 'user', content: '工具结果' }],
        );
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
        expect(body.model).toBe('x');
        expect(body.temperature).toBe(0.8);
        expect(body.messages).toEqual([{ role: 'user', content: '工具结果' }]);
    });

    it('只把中转拒绝请求的常见 4xx 识别为无 tools 重试条件', () => {
        expect(shouldRetryMcpWithoutTools(new Error('API Error 401: Unauthorized'))).toBe(true);
        expect(shouldRetryMcpWithoutTools(new Error('HTTP 422 INVALID_ARGUMENT'))).toBe(true);
        expect(shouldRetryMcpWithoutTools(new Error('API Error 429: rate limited'))).toBe(false);
        expect(shouldRetryMcpWithoutTools(new Error('API Error 500'))).toBe(false);
    });

    it('tools 被拒绝的降级请求会携带真实工具参数说明，但不再发送 tools 字段', () => {
        const body = buildMcpRejectedToolsFallbackBody({
            messages: [{ role: 'user', content: '查仓库' }],
            tools: [{ type: 'function', function: {
                name: 'ask_question',
                description: '[DeepWiki] 查询 GitHub 仓库文档',
                parameters: {
                    type: 'object',
                    properties: { repoName: { type: 'string' }, question: { type: 'string' } },
                    required: ['repoName', 'question'],
                },
            } }],
            tool_choice: 'auto',
        });
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
        expect(body.messages.at(-1).content).toContain('ask_question(repoName*:string, question*:string)');
        expect(body.messages.at(-1).content).toContain('[DeepWiki] 查询 GitHub 仓库文档');
    });

    it('远端 MCP 请求不结束时会超时返回失败，不会永久占住 isTyping', async () => {
        vi.useFakeTimers();
        const server = mkServer({ id: 'timeout-server' });
        vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            const req = JSON.parse(String(init?.body || '{}'));
            if (req.method === 'initialize') {
                return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                }));
            }
            if (req.method === 'notifications/initialized') {
                return Promise.resolve(new Response('', { status: 202 }));
            }
            // 模拟最容易漏掉的悬挂：响应头已经回来，但 SSE body 永远不结束。
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: new Headers({ 'Content-Type': 'text/event-stream' }),
                text: () => new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                }),
            } as Response);
        });

        const pending = callMcpTool(server, 'search', { q: 'react' });
        await vi.advanceTimersByTimeAsync(MCP_REQUEST_TIMEOUT_MS);
        await expect(pending).resolves.toMatchObject({ success: false, error: expect.stringContaining('MCP 请求超时') });
    });

    it('SSE 收到当前 JSON-RPC 结果后立即返回，不等待服务器关闭长连接', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const server = mkServer({ id: 'open-sse-server' });
        vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            const req = JSON.parse(String(init?.body || '{}'));
            if (req.method === 'initialize') {
                return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                }));
            }
            if (req.method === 'notifications/initialized') {
                return Promise.resolve(new Response('', { status: 202 }));
            }
            const payload = JSON.stringify({
                jsonrpc: '2.0', id: req.id,
                result: { content: [{ type: 'text', text: 'React 是一个 UI 库' }] },
            });
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${payload}\n\n`));
                    // 故意不 close：模拟 Streamable HTTP 保持 SSE 长连接。
                },
            });
            return Promise.resolve(new Response(stream, {
                status: 200, headers: { 'Content-Type': 'text/event-stream' },
            }));
        });

        await expect(callMcpTool(server, 'ask_question', { repoName: 'facebook/react' }))
            .resolves.toMatchObject({ success: true, data: 'React 是一个 UI 库' });
        expect(info).toHaveBeenCalledWith('🔌 [MCP] tools/call 完成', expect.objectContaining({
            server: server.name,
            tool: 'ask_question',
            args: { repoName: 'facebook/react' },
            success: true,
            result: '"React 是一个 UI 库"',
        }));
    });
});

describe('群聊 MCP 工具循环', () => {
    it('向绑定群聊注入工具，执行 tools/call 后把结果交回模型生成群聊内容', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        saveMcpServers([mkServer({
            id: 'group-mcp-server',
            charIds: ['group_game'],
            tools: [{ name: 'roll_dice', description: '掷骰子', inputSchema: { type: 'object', properties: { sides: { type: 'number' } } } }],
        })]);
        const chatBodies: any[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
            const url = String(input);
            const body = JSON.parse(String(init?.body || '{}'));
            if (url.includes('/chat/completions')) {
                chatBodies.push(body);
                const payload = chatBodies.length === 1
                    ? {
                        choices: [{ message: { content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'roll_dice', arguments: '{"sides":6}' } }] } }],
                        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                    }
                    : {
                        choices: [{ message: { content: '[{"charId":"char_a","content":"你掷出了 4。"}]' } }],
                        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
                    };
                return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            if (body.method === 'initialize') {
                return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            if (body.method === 'notifications/initialized') return Promise.resolve(new Response('', { status: 202 }));
            return Promise.resolve(new Response(JSON.stringify({
                jsonrpc: '2.0', id: body.id,
                result: { content: [{ type: 'text', text: '{"value":4}' }] },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        });

        const result = await completeGroupChatWithMcp({
            url: 'https://api.example.com/chat/completions',
            headers: { Authorization: 'Bearer chat-key' },
            body: { model: 'test', messages: [{ role: 'user', content: '开始游戏' }] },
            groupId: 'group_game',
            userName: '用户',
        });

        expect(chatBodies).toHaveLength(2);
        expect(chatBodies[0].tools[0].function.name).toBe('roll_dice');
        expect(chatBodies[1].messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'tool', name: 'roll_dice', tool_call_id: 'call-1', content: expect.stringContaining('{"value":4}') }),
        ]));
        expect(result.choices[0].message.content).toContain('你掷出了 4');
        expect(result.usage.total_tokens).toBe(29);
        expect(info).toHaveBeenCalled();
    });
});

describe('collectMcpFireServers', () => {
    it('只带 enabled + 已发现工具 + 公网地址; 剥代理字段、留 token', () => {
        localStorage.setItem('aetheros.mcp.servers', JSON.stringify([
            { id: 'a', name: 'ok', url: 'https://mcp.example.com', enabled: true, token: 'tok', proxyUrl: 'https://proxy.x', proxyKey: 'pk', charIds: ['c1'], tools: [{ name: 't1', inputSchema: { type: 'object' } }], updatedAt: 1 },
            { id: 'b', name: 'disabled', url: 'https://x.com', enabled: false, tools: [{ name: 't' }], updatedAt: 1 },
            { id: 'c', name: 'no-tools', url: 'https://y.com', enabled: true, tools: [], updatedAt: 1 },
            { id: 'd', name: 'local', url: 'http://localhost:18061/mcp', enabled: true, tools: [{ name: 't' }], updatedAt: 1 },
            { id: 'e', name: 'lan', url: 'http://192.168.1.5/mcp', enabled: true, tools: [{ name: 't' }], updatedAt: 1 },
        ]));
        const out = collectMcpFireServers();
        expect(out.map((s) => s.id)).toEqual(['a']);
        expect(out[0]).toEqual({
            id: 'a', name: 'ok', url: 'https://mcp.example.com', token: 'tok',
            charIds: ['c1'], tools: [{ name: 't1', inputSchema: { type: 'object' } }],
        });
        expect('proxyUrl' in out[0]).toBe(false);
    });

    it('本机 / 内网服务器不上云，但本地照常在 MCP 模式里 —— 上云那一轮会掉工具', () => {
        // 这一条钉的是「两侧集合不一致」这件事本身：collectMcpFireServers 把 localhost
        // 过滤掉了，isMcpChatAvailable 没有。即时对话那一轮前端不注入 MCP 说明块、云端
        // 清单又是空的，角色就彻底不知道自己有工具，而设置页还显示「已连接」。
        saveMcpServers([mkServer({ id: 'srv_local', url: 'http://localhost:18061/mcp' })]);
        expect(isMcpChatAvailable('char_a')).toBe(true);
        expect(collectMcpFireServers()).toEqual([]);
        expect(hasWorkerUnreachableMcpServer('char_a')).toBe(true);
    });

    it('无人值守后台不带 destructive 工具', () => {
        saveMcpServers([
            mkServer({
                id: 'guarded',
                tools: [
                    { name: 'read_note', annotations: { readOnlyHint: true } },
                    { name: 'delete_note', annotations: { destructiveHint: true } },
                ],
            }),
        ]);

        const out = collectMcpFireServers();
        expect(out.map(server => server.id)).toEqual(['guarded']);
        expect(out[0].tools?.map(tool => tool.name)).toEqual(['read_note']);
    });

    it('其余 worker 够不着的地址一并挡掉（链路本地 / 占位地址 / 局域网域名 / IPv6 ULA）', () => {
        const blocked = [
            'http://169.254.1.1/mcp',      // IPv4 链路本地
            'http://0.0.0.0:8080/mcp',     // 占位地址
            'http://[::]/mcp',             // 同上, IPv6
            'http://127.0.0.5:9000/mcp',   // 回环整段 127/8, 不只 127.0.0.1
            'http://my-nas.local/mcp',     // mDNS
            'http://foo.localhost/mcp',    // 本机后缀域名
            'http://[fd12:3456::1]/mcp',   // IPv6 ULA (fd)
            'http://[fc00::1]/mcp',        // IPv6 ULA (fc)
            'ftp://files.example.com/mcp', // 非 http(s)
            '这不是个地址',                  // URL 解析不了
        ];
        localStorage.setItem('aetheros.mcp.servers', JSON.stringify([
            ...blocked.map((url, i) => ({ id: `bad${i}`, name: url, url, enabled: true, tools: [{ name: 't' }], updatedAt: 1 })),
            { id: 'good', name: 'ok', url: 'https://mcp.example.com/mcp', enabled: true, tools: [{ name: 't' }], updatedAt: 1 },
        ]));

        expect(collectMcpFireServers().map((s) => s.id)).toEqual(['good']);
    });
});

describe('错误详情透传（MCP JSON-RPC error.data 与 API 错误体）', () => {
    it('tools/call 返回 JSON-RPC error.data 时把参数校验细节透传出来', async () => {
        const server = mkServer({ id: 'rpc-error-server' });
        vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            const req = JSON.parse(String(init?.body || '{}'));
            if (req.method === 'initialize') {
                return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }), {
                    status: 200, headers: { 'Content-Type': 'application/json' },
                }));
            }
            if (req.method === 'notifications/initialized') {
                return Promise.resolve(new Response('', { status: 202 }));
            }
            return Promise.resolve(new Response(JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                error: {
                    code: -32602,
                    message: 'Invalid params',
                    data: { missingFields: ['query'] },
                },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        });

        const res = await callMcpTool(server, 'search', {});
        expect(res.success).toBe(false);
        expect(res.error).toContain('[-32602]: Invalid params');
        expect(res.error).toContain('{"missingFields":["query"]}');
    });

    it('formatApiErrorPayload: error 为无 message 的对象时不产出 [object Object]，并保留 code/param/details 与顶层 detail', () => {
        expect(formatApiErrorPayload({ error: { code: 'invalid_request', details: { missing: ['model'] } } }, 400))
            .toBe('invalid_request ({"missing":["model"]})');
        expect(formatApiErrorPayload({ error: { message: 'Invalid parameter', code: 'invalid_argument', param: 'tools' } }, 400))
            .toBe('Invalid parameter [invalid_argument, param=tools]');
        expect(formatApiErrorPayload({ detail: 'Model not found', code: 404 }, 404))
            .toBe('Model not found [404]');
    });
});

describe('hasWorkerUnreachableMcpServer', () => {
    it('地址全是公网 → false（这一轮可以放心上云，worker 那边照样有工具）', () => {
        saveMcpServers([mkServer({ id: 'srv_pub', url: 'https://mcp.example.com/mcp' })]);
        expect(hasWorkerUnreachableMcpServer('char_a')).toBe(false);
    });

    it('混着一台本机地址 → true（上云会让角色少掉那台的工具）', () => {
        saveMcpServers([
            mkServer({ id: 'srv_pub', url: 'https://mcp.example.com/mcp' }),
            mkServer({ id: 'srv_lan', url: 'http://192.168.1.5:18061/mcp' }),
        ]);
        expect(hasWorkerUnreachableMcpServer('char_a')).toBe(true);
    });

    it('口径跟 isMcpChatAvailable 同源：没启用 / 没发现工具 / 绑给别的角色的都不算', () => {
        saveMcpServers([mkServer({ id: 'srv_off', url: 'http://localhost:18061/mcp', enabled: false })]);
        expect(hasWorkerUnreachableMcpServer('char_a')).toBe(false);
        saveMcpServers([mkServer({ id: 'srv_empty', url: 'http://localhost:18061/mcp', tools: [] })]);
        expect(hasWorkerUnreachableMcpServer('char_a')).toBe(false);
        saveMcpServers([mkServer({ id: 'srv_bound', url: 'http://localhost:18061/mcp', charIds: ['char_b'] })]);
        expect(hasWorkerUnreachableMcpServer('char_a')).toBe(false);
        expect(hasWorkerUnreachableMcpServer('char_b')).toBe(true);
    });
});

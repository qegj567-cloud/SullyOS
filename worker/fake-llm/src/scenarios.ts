// 假模型的「这一轮该回什么」。零依赖的纯函数：不碰网络、不读时钟以外的环境，测试直接调。
// 场景清单与命名规则见 docs/fake-llm.md。标签语法全部照 App 真实解析器写，
// 改了解析器语法，worker/fake-llm/src/scenarios.parse.test.ts 会跟着挂。

import { detectAuxKind, AUX_KINDS, type AuxKind } from './auxRequests';

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ReplyPlan {
    type: 'reply';
    model: string;
    content: string;
    reasoning?: string;
    toolCalls?: ToolCall[];
    finishReason: 'stop' | 'length' | 'tool_calls';
    /** 开始吐字之前先等多久。 */
    delayMs: number;
    /** >0 时逐字吐，每个字之间等这么久。 */
    charIntervalMs: number;
    promptTokens: number;
    completionTokens: number;
}

export type Plan =
    | ReplyPlan
    | { type: 'http-error'; status: number; body: unknown; headers?: Record<string, string> }
    /** 连响应头都不给，等这么久再断。 */
    | { type: 'hang'; ms: number }
    /** 原样吐出去的坏数据：非流式用 body，流式用 sse。 */
    | { type: 'raw'; body: string; sse: string };

export interface PlanResult {
    plan: Plan;
    /** 实际生效的场景名（不带 fake/ 前缀）。 */
    scenario: string;
    /** 'main' 或某类辅助请求。 */
    requestKind: 'main' | AuxKind;
}

export const MODEL_PREFIX = 'fake/';
const DEFAULT_SCENARIO = 'basic';
/** 写在聊天里的一次性场景指令，例如用户发「#fake:side-effects 测一下」。 */
const INLINE_DIRECTIVE = /(?:^|[^\w])#fake:([\w./@-]+)/;
/** 定时任务的提示词会列出其他排程（带着它们的提示词），只认这一段之后的内容。 */
const SCHEDULED_TASK_MARK = '【本次任务】';
/**
 * 回连标签那一轮写在标签前面的话。App 下一轮把它当 assistant 上文交回来（标签剥掉），
 * 看到它就知道是「工具结果回来了」。不另加可见记号，免得用户在气泡里看到。
 */
const DATA_TAG_LEADS = ['我翻翻以前的记录。', '我搜一下。'];
/** 前端工具循环在上一轮正文为空时塞的占位（utils/amsg2ToolLoop.ts 的 TOOL_ROUND_PLACEHOLDER）。 */
const TOOL_ROUND_PLACEHOLDER = '(调用工具中)';
const MAX_DURATION_MS = 60 * 60_000;

// ─── 读请求 ───

type Message = { role?: string; content?: unknown; tool_calls?: unknown };

export function messageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => (part && typeof part === 'object' && typeof (part as any).text === 'string') ? (part as any).text : '').join('');
    }
    return '';
}

function messagesOf(body: Record<string, unknown>): Message[] {
    return Array.isArray(body.messages) ? body.messages.filter(m => m && typeof m === 'object') as Message[] : [];
}

function lastUserText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return messageText(messages[i].content);
    }
    return '';
}

/** 上一轮是工具调用（原生 tool_calls 或回连标签），这一轮该给收尾正文了。 */
export function isFollowUpRound(messages: Message[]): boolean {
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') return true;
    const prev = messages[messages.length - 2];
    if (prev?.role !== 'assistant') return false;
    const text = messageText(prev.content);
    return DATA_TAG_LEADS.includes(text.trim()) || text.trim() === TOOL_ROUND_PLACEHOLDER || Array.isArray(prev.tool_calls);
}

function inlineDirective(messages: Message[]): string | null {
    const all = messages.map(m => messageText(m.content)).join('\n');
    const at = all.lastIndexOf(SCHEDULED_TASK_MARK);
    const scope = at >= 0 ? all.slice(at + SCHEDULED_TASK_MARK.length) : lastUserText(messages);
    return scope.match(INLINE_DIRECTIVE)?.[1] ?? null;
}

function parseDuration(raw: string | undefined, fallbackMs: number): number {
    if (!raw) return fallbackMs;
    const m = raw.match(/^(\d+)(ms|s|m)$/);
    if (!m) return fallbackMs;
    const n = Number(m[1]) * (m[2] === 'ms' ? 1 : m[2] === 's' ? 1000 : 60_000);
    return Math.min(n, MAX_DURATION_MS);
}

// ─── 时间：排程标签必须写未来的时刻，否则解析器直接丢掉 ───

const pad = (n: number) => String(n).padStart(2, '0');
/** 两天后的同一天 09:00，任何时区下都还是未来。 */
function futureWallClock(now: number, withSeconds: boolean): string {
    const d = new Date(now + 2 * 86_400_000);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return withSeconds ? `${date} 09:00:00` : `${date} 09:00`;
}

/**
 * 用户这轮说的话，像真模型引用时那样只取原话：App 发给模型的 user 消息前面带着
 * 「[2026-11-27 02:23] [聊天] 」这类前缀，原样抄进 [[QUOTE: …]] 的话，里面的 ] 会把标签提前闭合。
 */
export function userWords(lastUser: string): string {
    const line = lastUser.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
    return line.replace(/^(?:\[[^\]]*\]\s*)+/, '').replace(/#fake:\S+\s*/g, '').replace(/[[\]]/g, '').trim().slice(0, 30);
}

// ─── 副作用标签 ───
// 每一条的语法出处写在后面；以 App 解析器为准，这里只是照抄。

interface Ctx {
    messages: Message[];
    requestText: string;
    lastUser: string;
    tools: Array<{ type?: string; function?: { name?: string; parameters?: any } }>;
    now: number;
}

/** 真实的哔哔待办 requestId 只在提示词里有，抄过来才能真落地；没有就用占位，App 只记一条警告。 */
function friendFeedTag(ctx: Ctx): string {
    const example = ctx.requestText.match(/\[\[FRIEND_FEED_REPLY:(\{.*?\})\]\]/);
    let action: Record<string, unknown> = { requestId: 'fake-request', kind: 'comment', postId: 'fake-post', comment: '' };
    if (example) {
        try { action = JSON.parse(example[1]); } catch { /* 用占位 */ }
    }
    if (action.kind === 'comment' || !action.kind) action = { ...action, kind: 'comment', comment: '假模型路过，留个评论～' };
    return `[[FRIEND_FEED_REPLY:${JSON.stringify(action)}]]`;
}

/**
 * taughtBy：提示词里出现这串才说明这一轮教了这个标签，合集场景才带上它。真模型不会写没教过的标签；
 * 判据取教学句里独有的那截，不取标签名本身：聊天历史里漏过一次的标签也会让标签名出现在请求里。
 * 带上的话，没开 2.0 时正文排程会原样露成一条气泡，合集看起来像坏了。单个 tag- 场景不看这个。
 */
export const SIDE_EFFECT_TAGS: Record<string, { describe: string; line: (ctx: Ctx) => string; taughtBy?: string }> = {
    // utils/chatPrompts.ts「戳一戳」；前端 utils/chatParser.ts，云端 worker/amsg/src/classifier.ts
    poke: { describe: '戳一戳', line: () => '戳你一下～\n[[ACTION:POKE]]' },
    // utils/transferFormat.ts extractTransferCommands；to 只能是 user
    transfer: { describe: '角色给用户转账', line: () => '这个给你，拿去买奶茶。\n[[ACTION:TRANSFER|to=user|amount=52.00]]' },
    // utils/chatParser.ts ADD_EVENT
    'add-event': { describe: '记一个纪念日', line: ctx => `这天我记下来了。\n[[ACTION:ADD_EVENT | 假模型纪念日 | ${futureWallClock(ctx.now, false).slice(0, 10)}]]` },
    // utils/chatParser.ts schedule_message：| 两边各一个空格，时间必须在未来；taughtBy 取 utils/chatPrompts.ts 的教学句
    'schedule-message': { describe: '本地定时消息 [schedule_message]', taughtBy: '单独起一行输出: `[schedule_message', line: ctx => `明早叫你起床。\n[schedule_message | ${futureWallClock(ctx.now, true)} | fixed | 早安，这是假模型排的消息]` },
    // utils/amsgFireSchedule.ts extractFireScheduleTextCalls：2.0 的正文排程，单独一行；taughtBy 取同文件正文模式的教学句
    'amsg-schedule': { describe: '2.0 正文排程 schedule_active_message(...)', taughtBy: '单独输出一行 schedule_active_message(', line: ctx => `到时候我再来找你。\nschedule_active_message(${JSON.stringify({ send_at: futureWallClock(ctx.now, false), prompt_hint: '假模型排的回访' })})` },
    // utils/scheduleChangeParse.ts；要今天日程里真有这个时段才会落地
    'change-schedule': { describe: '改今天的日程', line: () => '那我晚上改去超市。\n[[ACTION:CHANGE_SCHEDULE | 18:30 | 去超市]]' },
    // utils/chatParser.ts MUSIC_ACTION：前端要「正在一起听」才会出卡片，否则静默剥掉
    music: { describe: '一起听歌', line: () => '我也来听！\n[[MUSIC_ACTION:join]]' },
    // utils/realtimeWorldCore.ts 教的新闻卡
    news: { describe: '热搜新闻卡', line: () => '你看这个热搜。\n[[NEWS_CARD: 微博|假模型测试热搜]]' },
    // utils/lifeRecords.ts；角色要开着生活记录代记才会落地
    life: { describe: '生活记录代记一笔支出', line: () => '打车钱我帮你记上了。\n[[LIFE:EXPENSE|38|打车]]' },
    // utils/chatOutputStylePrompt.ts SEND_EMOJI；找不到这个表情会退成文字气泡
    sticker: { describe: '发表情包', line: () => '嘿嘿\n[[SEND_EMOJI: 开心]]\n表情发出去了' },
    // utils/applyAssistantPostProcessing.ts QUOTE：行首，引用用户原话
    quote: { describe: '引用用户的话', line: ctx => `[[QUOTE: ${userWords(ctx.lastUser) || '你好'}]]\n我在回你这句。` },
    // utils/friendFeedReplyFormat.ts extractFriendFeedReplyTags
    'friend-feed': { describe: '哔哔（好友圈）评论', line: friendFeedTag },
};

/** 回连标签：会让 App 再请求一轮模型，下一轮由 isFollowUpRound 认出来给收尾正文。 */
export const DATA_TAGS: Record<string, { describe: string; line: () => string }> = {
    // utils/chatPrompts.ts RECALL，classifier DATA_TAGS 里叫 recall
    recall: { describe: '回连：翻月度记忆', line: () => `${DATA_TAG_LEADS[0]}\n[[RECALL: 2026-10]]` },
    // classifier DATA_TAGS web_search
    search: { describe: '回连：联网搜索', line: () => `${DATA_TAG_LEADS[1]}\n[[SEARCH: 假模型测试关键词]]` },
};

// ─── 正文素材 ───

const BASIC_LINES = (ctx: Ctx) => [
    `收到啦，你刚才说的是「${userWords(ctx.lastUser)}」。`,
    '这是假模型的回复，没有调用真实模型。',
];

const MULTI_PART = [
    '先说第一句。',
    '再说第二句，这句稍微长一点，用来看看推送和气泡在中等长度下的样子。',
    '',
    '空一行之后是第三句。',
    '---',
    '分隔线后面的第四句。',
    '最后一句很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长，看看长句会不会被截断。',
].join('\n');

const THINKING = '先想一想：用户在测试思考链。我应该给出一段思考，再给正文。';

// ─── 场景 ───

type Build = (ctx: Ctx, param?: string) => Plan;

const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 2));

function reply(ctx: Ctx, content: string, extra: Partial<ReplyPlan> = {}): ReplyPlan {
    const plan: ReplyPlan = {
        type: 'reply', model: '', content, finishReason: 'stop', delayMs: 0, charIntervalMs: 0,
        promptTokens: Math.max(1, Math.ceil(JSON.stringify(ctx.messages).length / 4)), completionTokens: 0, ...extra,
    };
    plan.completionTokens = tokens(plan.content + (plan.reasoning ?? '') + JSON.stringify(plan.toolCalls ?? ''));
    return plan;
}

const openAiError = (status: number, message: string, type: string, code: string) =>
    ({ type: 'http-error' as const, status, body: { error: { message, type, code } }, ...(status === 429 ? { headers: { 'Retry-After': '1' } } : {}) });

function pickTool(ctx: Ctx) {
    const tools = ctx.tools.filter(t => t?.function?.name);
    return tools.find(t => t.function!.name === 'schedule_active_message') ?? tools[0];
}

/** 按 JSON Schema 的 required 填最小参数，免得工具执行端因为缺参直接拒。 */
function minimalArgs(ctx: Ctx, schema: any): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    const props = schema?.properties ?? {};
    for (const key of Array.isArray(schema?.required) ? schema.required : []) {
        const type = props[key]?.type;
        if (key === 'send_at') args[key] = futureWallClock(ctx.now, false);
        else if (Array.isArray(props[key]?.enum)) args[key] = props[key].enum[0];
        else args[key] = type === 'number' || type === 'integer' ? 1 : type === 'boolean' ? false : type === 'array' ? [] : type === 'object' ? {} : '假模型';
    }
    if (props.prompt_hint && !args.prompt_hint) args.prompt_hint = '假模型排的回访';
    return args;
}

const followUpText = (ctx: Ctx) => {
    const last = ctx.messages[ctx.messages.length - 1];
    const result = messageText(last?.content).replace(/\s+/g, ' ').slice(0, 60);
    return `工具结果拿到了：${result || '（空）'}\n这是假模型在工具之后的收尾回复。`;
};

interface ScenarioDef { describe: string; build: Build; /** 带参数的场景：匹配 `名字-参数` */ param?: RegExp; examples?: string[] }

export const SCENARIOS: Record<string, ScenarioDef> = {
    basic: { describe: '两行普通回复，带上用户最后一句', build: ctx => reply(ctx, BASIC_LINES(ctx).join('\n')) },
    'side-effects': {
        describe: '所有副作用标签一次全出（不含回连标签；两种排程只在提示词教了时才带）',
        build: ctx => reply(ctx, Object.values(SIDE_EFFECT_TAGS)
            .filter(t => !t.taughtBy || ctx.requestText.includes(t.taughtBy))
            .map(t => t.line(ctx)).join('\n')),
    },
    ...Object.fromEntries(Object.entries(SIDE_EFFECT_TAGS).map(([name, tag]) => [`tag-${name}`, {
        describe: `单个标签：${tag.describe}`, build: (ctx: Ctx) => reply(ctx, tag.line(ctx)),
    }])),
    ...Object.fromEntries(Object.entries(DATA_TAGS).map(([name, tag]) => [`tag-${name}`, {
        describe: `${tag.describe}；工具结果回来的下一轮给收尾正文`,
        build: (ctx: Ctx) => reply(ctx, tag.line()),
    }])),
    'multi-part': { describe: '多句、多段、空行、--- 分隔、长短混合，切出多条气泡和推送', build: ctx => reply(ctx, MULTI_PART) },
    delay: {
        describe: '先等一段时间再回多句回复；等待期间吐保活字节。例：delay-30s、delay-6m（超过云端 5 分钟上限）',
        param: /^delay-(\d+(?:ms|s|m))$/, examples: ['delay-10s', 'delay-6m'],
        build: (ctx, p) => reply(ctx, MULTI_PART, { delayMs: parseDuration(p, 10_000) }),
    },
    'slow-stream': {
        describe: '逐字慢吐，默认每字 120ms。例：slow-stream-50ms',
        param: /^slow-stream-(\d+ms)$/, examples: ['slow-stream', 'slow-stream-50ms'],
        build: (ctx, p) => reply(ctx, MULTI_PART, { charIntervalMs: parseDuration(p, 120) }),
    },
    'thinking-field': { describe: 'reasoning_content 字段 + 正文', build: ctx => reply(ctx, BASIC_LINES(ctx).join('\n'), { reasoning: THINKING }) },
    'thinking-tag': { describe: '正文里的 <think> 标签 + 正文', build: ctx => reply(ctx, `<think>${THINKING}</think>\n${BASIC_LINES(ctx).join('\n')}`) },
    'thinking-only': { describe: '只有思考、正文为空（应当按空回复处理）', build: ctx => reply(ctx, '', { reasoning: THINKING }) },
    error: {
        describe: '返回 HTTP 错误码。例：error-401、error-429、error-500、error-502',
        param: /^error-(\d{3})$/, examples: ['error-401', 'error-429', 'error-500', 'error-502'],
        build: (_ctx, p) => {
            const status = Number(p) || 500;
            if (status === 401) return openAiError(401, 'Incorrect API key provided (fake-llm).', 'invalid_request_error', 'invalid_api_key');
            if (status === 429) return openAiError(429, 'Rate limit reached (fake-llm).', 'rate_limit_error', 'rate_limit_exceeded');
            return openAiError(status, `Upstream returned ${status} (fake-llm).`, 'server_error', `fake_${status}`);
        },
    },
    hang: {
        describe: '连响应头都不回，默认 30 分钟后才断。例：hang-90s',
        param: /^hang-(\d+(?:ms|s|m))$/, examples: ['hang'],
        build: (_ctx, p) => ({ type: 'hang', ms: parseDuration(p, 30 * 60_000) }),
    },
    'error-body': {
        describe: 'HTTP 200，但 body 是错误对象（流式时是一帧 data: {"error":…}）',
        build: () => {
            const error = JSON.stringify({ error: { message: 'Upstream error inside a 200 response (fake-llm).', type: 'server_error', code: 'fake_error_body' } });
            return { type: 'raw', body: error, sse: `data: ${error}\n\n` };
        },
    },
    empty: { describe: '正常结构，正文是空字符串', build: ctx => reply(ctx, '') },
    truncated: { describe: 'finish_reason: length，正文停在半句', build: ctx => reply(ctx, '这句话说到一半就被截断了，因为', { finishReason: 'length' }) },
    'bad-json': {
        describe: 'HTTP 200，body 是写了一半的 JSON（流式时是坏掉的 data 帧）',
        build: () => ({
            type: 'raw',
            body: '{"id":"chatcmpl-fake","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"半截',
            sse: 'data: {"id":"chatcmpl-fake","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"半截\n\ndata: [DONE]\n\n',
        }),
    },
    'tool-call': {
        describe: '原生 tool_calls：先调请求里的一个工具（有 schedule_active_message 就调它），拿到结果后给正文',
        build: ctx => {
            const tool = pickTool(ctx);
            if (!tool) return reply(ctx, '这次请求没带 tools，假模型没有工具可调。');
            const call: ToolCall = {
                id: `call_fake_${ctx.now.toString(36)}`,
                type: 'function',
                function: { name: tool.function!.name!, arguments: JSON.stringify(minimalArgs(ctx, tool.function!.parameters)) },
            };
            return reply(ctx, '', { toolCalls: [call], finishReason: 'tool_calls' });
        },
    },
};

/** /v1/models 列出来的名字：固定场景 + 带参数场景的几个示例 + 几个针对辅助请求的示例。 */
export function listModelIds(): string[] {
    const ids: string[] = [];
    for (const [name, def] of Object.entries(SCENARIOS)) {
        if (def.param) ids.push(...(def.examples ?? []));
        else ids.push(name);
    }
    ids.push('error-500@emotion', 'bad-json@emotion', 'delay-6m@emotion');
    return ids.map(id => MODEL_PREFIX + id);
}

function resolveScenario(name: string): { def: ScenarioDef; param?: string } | null {
    if (SCENARIOS[name] && !SCENARIOS[name].param) return { def: SCENARIOS[name] };
    for (const def of Object.values(SCENARIOS)) {
        if (!def.param) continue;
        if (def.examples?.includes(name) && !def.param.test(name)) return { def }; // 不带参数的默认写法，如 hang、slow-stream
        const m = name.match(def.param);
        if (m) return { def, param: m[1] };
    }
    return null;
}

export function planResponse(body: Record<string, unknown>, now = Date.now()): PlanResult {
    const messages = messagesOf(body);
    const ctx: Ctx = {
        messages,
        requestText: messages.map(m => messageText(m.content)).join('\n'),
        lastUser: lastUserText(messages),
        tools: Array.isArray(body.tools) ? body.tools as Ctx['tools'] : [],
        now,
    };
    const model = typeof body.model === 'string' ? body.model : '';
    const fromModel = model.startsWith(MODEL_PREFIX) ? model.slice(MODEL_PREFIX.length) : DEFAULT_SCENARIO;
    const requested = inlineDirective(messages) ?? fromModel;
    const [scenarioName, target] = requested.split('@');

    const auxKind = detectAuxKind(ctx.requestText, messages);
    const requestKind = auxKind ?? 'main';
    // 场景默认只作用在主回复上；写了 @kind 就只作用在那类辅助请求上。
    const applies = target ? target === requestKind : requestKind === 'main';

    let plan: Plan;
    let scenario: string;
    if (requestKind === 'main' && isFollowUpRound(messages)) {
        // 工具结果回来的那一轮：不管场景是什么都给收尾正文。场景常常是写在第一轮用户消息里的
        // #fake: 指令，这一轮的最后一条 user 已经换成了工具结果，读不到它了。
        scenario = 'follow-up';
        plan = reply(ctx, followUpText(ctx));
    } else if (applies) {
        const found = resolveScenario(scenarioName);
        scenario = found ? scenarioName : `unknown:${scenarioName}`;
        plan = found
            ? found.def.build(ctx, found.param)
            : reply(ctx, `假模型不认识场景「${scenarioName}」。可用场景见 GET /v1/models。`);
    } else if (auxKind) {
        scenario = `default@${auxKind}`;
        plan = reply(ctx, AUX_KINDS[auxKind].reply(ctx.requestText, ctx.lastUser));
    } else {
        scenario = DEFAULT_SCENARIO;
        plan = SCENARIOS.basic.build(ctx);
    }
    if (plan.type === 'reply') plan.model = model || MODEL_PREFIX + DEFAULT_SCENARIO;
    return { plan, scenario, requestKind };
}

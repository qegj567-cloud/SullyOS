import { describe, it, expect, vi } from 'vitest';
import {
    buildApiRequestCapture,
    buildPromptBreakdown,
    captureApiRequestOnce,
    coreModelName,
    extractApiTokenUsage,
    formatApiRequestCaptureTxt,
    getApiCallAmbientContext,
    getApiRequestCaptureSectionContent,
    getApiRequestCaptureSectionSource,
    isApiRequestCaptureArmed,
    isFixedPromptBlockLabel,
    isSameCoreModel,
    recordCompletedCloudApiCall,
    resolveApiCallMeta,
    scanSseForLog,
    setApiRequestCaptureArmed,
    setApiCallAmbientContext,
    summarizeApiRequestCaptureDuplicates,
    updateApiRequestCaptureUsage,
} from './apiCallLog';
import { setCharNameRegistry } from './charNameRegistry';
import { formatWorldbookSection, resolveWorldbookEntries } from './worldbook';

describe('one-shot full API request capture', () => {
    it('uses the in-memory armed flag on the disabled hot path instead of reading localStorage per request', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('isApiRequestCaptureArmed must not read storage'); },
            setItem: () => {},
            removeItem: () => {},
        });
        setApiRequestCaptureArmed(true);
        expect(isApiRequestCaptureArmed()).toBe(true);
        setApiRequestCaptureArmed(false);
        expect(isApiRequestCaptureArmed()).toBe(false);
        vi.unstubAllGlobals();
    });

    it('keeps the complete payload and indexes memory, worldbook, history, tools and options', () => {
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: JSON.stringify({
                model: 'gpt-test',
                temperature: 0.7,
                messages: [
                    { role: 'system', content: '## 行为规范\n规则正文\n## 记忆召回\n昨天一起看了海。\n## 世界书\n海边城市设定。' },
                    { role: 'user', content: '今天还去吗？' },
                    { role: 'assistant', content: '当然。' },
                ],
                tools: [{ type: 'function', function: { name: 'read_calendar' } }],
            }),
            meta: { appName: '消息', charName: '测试角色' },
            capturedAt: 1234,
        });

        expect(capture.model).toBe('gpt-test');
        expect(capture.messageCount).toBe(3);
        expect(capture.meta.charName).toBe('测试角色');
        expect(capture.sections.some(section => section.kind === 'memory')).toBe(true);
        expect(capture.sections.some(section => section.kind === 'worldbook')).toBe(true);
        expect(capture.sections.some(section => section.kind === 'tools')).toBe(true);
        expect(capture.sections.some(section => section.kind === 'user')).toBe(true);

        const memory = capture.sections.find(section => section.kind === 'memory')!;
        expect(getApiRequestCaptureSectionContent(capture, memory)).toContain('昨天一起看了海');
        expect(getApiRequestCaptureSectionSource(memory)).toContain('记忆系统召回');
        expect(memory.path).toBe('messages[0].content · 分块 2');
        expect(JSON.stringify(capture.payload)).toContain('read_calendar');
        expect(JSON.stringify(capture.payload)).toContain('今天还去吗');
    });

    it('classifies group-chat background separately instead of calling it a system prompt', () => {
        const content = [
            '## 行为规范',
            '普通规则',
            '### 【群聊背景 · 你亲历的近期群聊】',
            '[2026-08-05 12:00] [群：朋友们] 小夏：晚上吃什么？',
            '### 群聊场景共享设定 (Group Scene)',
            '本群成员都知道今天下雨。',
        ].join('\n');
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: { model: 'gpt-test', messages: [{ role: 'system', content }] },
        });

        const groupSections = capture.sections.filter(section => section.kind === 'group');
        expect(groupSections).toHaveLength(2);
        expect(groupSections.every(section => getApiRequestCaptureSectionSource(section).includes('群聊'))).toBe(true);
        expect(capture.sections.filter(section => section.kind === 'system')).toHaveLength(1);
        expect(capture.sections
            .filter(section => section.messageIndex != null)
            .reduce((sum, section) => sum + section.chars, 0)).toBe(content.length);
    });

    it('keeps a worldbook section whole even when entries carry their own markdown headings', () => {
        // 用 formatWorldbookSection 真拼一段，跟线上发出去的形状保持一致
        const worldbook = formatWorldbookSection(resolveWorldbookEntries([
            { id: 'a', title: '破甲', content: '开头几行\n## 第一部分\n正文一\n### 第二部分\n正文二', category: '测试', sourceUid: 1 },
            { id: 'b', title: '设定', content: '## 第二条的小标题\n第二条正文', category: '测试', sourceUid: 2 },
        ]), '扩展设定集 (Worldbooks)');
        const content = `### 你的身份 (Character)\n设定\n\n${worldbook}### 表达底线 (Anti-Filler)\n规则`;
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: { model: 'gpt-test', messages: [{ role: 'system', content }] },
        });

        const promptLabels = capture.sections.filter(section => section.messageIndex != null).map(section => section.label);
        expect(promptLabels).toEqual([
            '你的身份 (Character)',
            '扩展设定集 (Worldbooks)',
            '表达底线 (Anti-Filler)',
        ]);
        const worldbookSection = capture.sections.find(section => section.kind === 'worldbook')!;
        const text = getApiRequestCaptureSectionContent(capture, worldbookSection);
        expect(text).toContain('正文二');
        expect(text).toContain('第二条正文');
        expect(text).not.toContain('表达底线');

        expect(buildPromptBreakdown({ messages: [{ role: 'system', content }] })!.map(block => block.label)).toEqual([
            '你的身份 (Character)',
            '扩展设定集 (Worldbooks)',
            '表达底线 (Anti-Filler)',
        ]);
    });

    it('still splits after a worldbook-looking heading that has no section ending', () => {
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: { model: 'gpt-test', messages: [{ role: 'system', content: '## 世界书\n设定\n## 记忆召回\n昨天\n## 行为规范\n规则' }] },
        });
        expect(capture.sections.filter(section => section.messageIndex != null).map(section => section.label))
            .toEqual(['世界书', '记忆召回', '行为规范']);
    });

    it('classifies embedded full conversation history separately from system prompts', () => {
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: {
                model: 'gpt-test',
                messages: [{
                    role: 'user',
                    content: [
                        `## 角色此刻看到的完整上下文\n${'设定'.repeat(3000)}`,
                        `## 完整对话历史（与主 API 看到的消息历史一致）\n${'[用户] 你好\n[角色] 嗨\n'.repeat(300)}`,
                        '## 任务\n分析当前情绪。',
                    ].join('\n'),
                }],
            },
        });

        const history = capture.sections.find(section => section.kind === 'history');
        expect(history).toBeTruthy();
        expect(history?.label).toContain('完整对话历史');
        expect(getApiRequestCaptureSectionSource(history!)).toContain('既往用户与角色对话');
    });

    it('reads real token usage from common OpenAI, Anthropic and Gemini-compatible fields', () => {
        expect(extractApiTokenUsage({ usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } }))
            .toEqual({ prompt: 123, completion: 45, total: 168 });
        expect(extractApiTokenUsage({ usage: { input_tokens: 70, output_tokens: 20 } }))
            .toEqual({ prompt: 70, completion: 20, total: undefined });
        expect(extractApiTokenUsage({ usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10, totalTokenCount: 90 } }))
            .toEqual({ prompt: 80, completion: 10, total: 90 });
    });

    it('backfills the real response usage into the same one-shot capture', async () => {
        const { DB } = await import('./db');
        await DB.clearApiRequestCapture();
        setApiRequestCaptureArmed(true);
        const captureId = captureApiRequestOnce({
            url: 'https://example.com/v1/chat/completions',
            body: { model: 'gpt-test', messages: [{ role: 'user', content: '你好' }] },
        });
        expect(captureId).toEqual(expect.any(String));

        updateApiRequestCaptureUsage({
            captureId,
            ok: true,
            response: { usage: { prompt_tokens: 456, completion_tokens: 78, total_tokens: 534 } },
        });

        await vi.waitFor(async () => {
            expect(await DB.getApiRequestCapture()).toMatchObject({
                id: captureId,
                promptTokens: 456,
                completionTokens: 78,
                totalTokens: 534,
                usageStatus: 'reported',
            });
        });
    });

    it('detects duplicated long prompt blocks in the client request without flagging short reminders', () => {
        const duplicated = `## 固定规则\n${'不要重复发送这段提示词。'.repeat(30)}`;
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: {
                model: 'gpt-test',
                messages: [
                    { role: 'system', content: duplicated },
                    { role: 'system', content: duplicated },
                    { role: 'system', content: '短提醒' },
                    { role: 'system', content: '短提醒' },
                ],
            },
        });

        const summary = summarizeApiRequestCaptureDuplicates(capture);
        expect(summary.groups).toBe(1);
        expect(summary.repeatedSections).toBe(2);
        expect(summary.extraChars).toBe(duplicated.length);
        expect(summary.examples[0]).toMatchObject({ occurrences: 2, chars: duplicated.length });
    });

    it('exports a readable TXT report with source ranking, paths, section content and raw JSON', () => {
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: {
                model: 'gpt-test',
                messages: [
                    { role: 'system', content: '## 记忆召回\n记忆正文' },
                    { role: 'user', content: '用户正文' },
                ],
            },
            meta: { appName: '消息', purpose: '聊天回复' },
            capturedAt: 1234,
        });
        const txt = formatApiRequestCaptureTxt(capture);

        expect(txt).toContain('来源体积排行');
        expect(txt).toContain('记忆系统召回后注入本次请求的内容');
        expect(txt).toContain('位置：messages[0].content · 分块 1');
        expect(txt).toContain('记忆正文');
        expect(txt).toContain('完整原始请求 JSON');
        expect(txt).toContain('"content": "用户正文"');
        expect(txt).toContain('请求体总字符（不是 Token）');
        expect(txt).toContain('客户端发出前重复检查');
        expect(txt).toContain('未发现完全相同的长文本被客户端重复发送');
    });

    it('replaces oversized inline binary data but preserves its original size for diagnosis', () => {
        const dataUrl = `data:image/png;base64,${'a'.repeat(5000)}`;
        const capture = buildApiRequestCapture({
            url: 'https://example.com/v1/chat/completions',
            body: { model: 'vision', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }] },
        });

        expect(capture.binaryPlaceholders).toBe(1);
        const raw = JSON.stringify(capture.payload);
        expect(raw).toContain('原始 5,022 字符');
        expect(raw).not.toContain('a'.repeat(100));
    });
});

describe('API call ambient context snapshots', () => {
    it('keeps the request-start App even after ambient navigation changes', () => {
        setApiCallAmbientContext({ appId: 'social', appName: 'Spark' });
        const requestStart = getApiCallAmbientContext();
        setApiCallAmbientContext({ appId: 'group_chat', appName: '群聊' });
        expect(requestStart).toEqual({ appId: 'social', appName: 'Spark' });
        setApiCallAmbientContext({});
    });
});

// 锁住 API 调用记录的 SSE 兜底解析：流式响应 JSON.parse 必然失败，
// 后端自报 model（首个非空）与 usage（末个非空）从 data: 行里扫出来。

describe('scanSseForLog', () => {
    it('抠出首个 model 与最后一个 usage', () => {
        const sse = [
            'data: {"id":"x","model":"[逆-V]gemini-3.1-pro-preview-c","choices":[{"delta":{"content":"a"}}]}',
            'data: {"model":"[逆-V]gemini-3.1-pro-preview-c","choices":[{"delta":{"content":"b"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15572,"completion_tokens":725,"total_tokens":16297}}',
            'data: [DONE]',
        ].join('\n');
        const { model, usage } = scanSseForLog(sse);
        expect(model).toBe('[逆-V]gemini-3.1-pro-preview-c');
        expect((usage as any).prompt_tokens).toBe(15572);
        expect((usage as any).total_tokens).toBe(16297);
    });

    it('坏行/空行/[DONE] 跳过不崩', () => {
        const sse = 'data: 不是json\n\ndata: [DONE]\ndata: {"model":"m1","choices":[]}';
        const { model, usage } = scanSseForLog(sse);
        expect(model).toBe('m1');
        expect(usage).toBeUndefined();
    });

    it('非 SSE 文本返回空结果', () => {
        expect(scanSseForLog('{"model":"x"}')).toEqual({ model: undefined, usage: undefined });
    });
});

describe('coreModelName 核心名归一化（实际后端琥珀判定用）', () => {
    it('剥方括号/半角圆括号/全角圆括号渠道标签', () => {
        expect(coreModelName('[千岛-自营]gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
        expect(coreModelName('(按次)gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
        expect(coreModelName('（官转）gemini-3.1-pro-preview')).toBe('gemini-3.1-pro-preview');
    });

    it('渠道标签不同但核心名相同 → 判定一致（不误报琥珀）', () => {
        expect(coreModelName('(按次)gemini-3.1-pro-preview')).toBe(coreModelName('gemini-3.1-pro-preview'));
        expect(coreModelName('[co假流]Gemini-3.1-Pro-Preview')).toBe(coreModelName('gemini-3.1-pro-preview'));
    });

    it('核心名真的不同（如 -c 后缀）→ 判定不一致（该报琥珀）', () => {
        expect(coreModelName('[逆-V]gemini-3.1-pro-preview-c')).not.toBe(coreModelName('[千岛-自营]gemini-3.1-pro-preview'));
    });
});

describe('isSameCoreModel 方向性同名判定', () => {
    it('裸前缀 / 路径前缀 → 同名（gcli-X↔X、X↔models/X）', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('gemini-3.1-pro-preview', 'models/gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('(按次)gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('[千岛-自营]gemini-3.1-pro-preview', 'gemini-3.1-pro-preview')).toBe(true);
    });

    it('尾部变体 → 不同名（缩水降级信号必须报琥珀）', () => {
        expect(isSameCoreModel('[千岛-自营]gemini-3.1-pro-preview', '[逆-V]gemini-3.1-pro-preview-c')).toBe(false);
        expect(isSameCoreModel('gpt-4o', 'gpt-4o-mini')).toBe(false);
        expect(isSameCoreModel('gemini-3.1-pro-preview', 'gemini-3.1-flash-preview')).toBe(false);
    });

    it('短名不做 endsWith 宽容；空值不报警', () => {
        expect(isSameCoreModel('4o', 'gpt-4o')).toBe(false);
        expect(isSameCoreModel('x', '')).toBe(true);
    });
});

describe('coreModelName 家族锚点裸前缀剥离（两头前缀不一样也能对上）', () => {
    it('两头贴不同裸前缀 → 同名', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'vertex-gemini-3.1-pro-preview')).toBe(true);
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', '[逆-V]az-gemini-3.1-pro-preview')).toBe(true);
    });

    it('家族名本身开头的名字不被误剥', () => {
        expect(coreModelName('chatgpt-4o-latest')).toBe('chatgpt-4o-latest');
        expect(coreModelName('deepseek-chat')).toBe('deepseek-chat');
        expect(coreModelName('gpt-4o-mini')).toBe('gpt-4o-mini');
    });

    it('剥前缀后尾部变体仍然抓得住', () => {
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'az-gemini-3.1-pro-preview-c')).toBe(false);
        expect(isSameCoreModel('gcli-gemini-3.1-pro-preview', 'vertex-gemini-3.1-flash-preview')).toBe(false);
    });
});

// 输入构成统计：回答「prompt_tokens 为什么这么大」——system 按 ###/[System:] 块头
// 切开逐块计数，历史消息按角色聚合。只存统计不存原文。
describe('buildPromptBreakdown', () => {
    it('system 按块头切开，历史按角色聚合', () => {
        const body = JSON.stringify({
            model: 'x',
            messages: [
                { role: 'system', content: '### 你的身份 (Character)\n设定文本\n### 记忆系统 (Memory Bank)\n- 一条记忆\n- 两条记忆' },
                { role: 'user', content: '你好' },
                { role: 'assistant', content: '嗨嗨' },
                { role: 'user', content: '在吗' },
                { role: 'system', content: '[System: 实时状态 (Live Context)]\n现在是晚上' },
            ],
        });
        const blocks = buildPromptBreakdown(body)!;
        const labels = blocks.map(b => b.label);
        expect(labels).toEqual([
            '你的身份 (Character)',
            '记忆系统 (Memory Bank)',
            '[System: 实时状态 (Live Context)]',
            '聊天历史·用户消息 ×2',
            '聊天历史·角色消息 ×1',
        ]);
        // 字数守恒：system 各块之和 = 原文长度 + 每行换行补偿
        const memBlock = blocks.find(b => b.label.startsWith('记忆系统'))!;
        expect(memBlock.chars).toBeGreaterThan(0);
        expect(blocks.find(b => b.label === '聊天历史·用户消息 ×2')!.chars).toBe(4);
    });

    it('无块头的短 system（尾部提醒）用首行当名字', () => {
        const blocks = buildPromptBreakdown({
            messages: [{ role: 'system', content: '[MCP 工具 ON · 永远用角色语气回复别空回]' }],
        })!;
        expect(blocks).toHaveLength(1);
        expect(blocks[0].label.startsWith('[MCP 工具 ON')).toBe(true);
    });

    it('多模态 content 摊平计数，图片按占位符', () => {
        const blocks = buildPromptBreakdown({
            messages: [
                { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
            ],
        })!;
        // 单条请求走「提示词整体」标注（见下方 describe），此处只锁多模态计数口径
        expect(blocks[0].label).toBe('提示词整体「看图 [图片]」');
        expect(blocks[0].chars).toBe('看图 [图片]'.length);
    });

    it('解析不了 / 没 messages 时返回 undefined', () => {
        expect(buildPromptBreakdown('{broken')).toBeUndefined();
        expect(buildPromptBreakdown({ model: 'x' })).toBeUndefined();
        expect(buildPromptBreakdown(undefined)).toBeUndefined();
    });

    it('病态多块时合并尾巴限容', () => {
        const sys = Array.from({ length: 80 }, (_, i) => `### 块${i}\n内容${i}`).join('\n');
        const blocks = buildPromptBreakdown({ messages: [{ role: 'system', content: sys }] })!;
        expect(blocks.length).toBeLessThanOrEqual(48);
        expect(blocks[blocks.length - 1].label).toContain('其余');
    });
});

// 情绪评估形态：完整上下文打包成一条巨型 user 消息——必须拆块，否则面板只显示
// 「用户消息 ×1 · 100%」，用户会误以为评估请求里没有角色设定。
describe('buildPromptBreakdown · 巨型 user 消息拆块', () => {
    it('超阈值且含多个块头的 user 消息按 system 同款规则拆开', () => {
        const evalPrompt = [
            '你是一个角色情绪分析系统。请分析角色「Noir」当前的情绪底色状态。',
            '## 角色此刻看到的完整上下文（与主 API 发送的 system prompt 完全一致）',
            `### 你的身份 (Character)\n${'设'.repeat(6000)}`,
            '## 完整对话历史（与主 API 看到的消息历史完全一致）',
            `${'[用户]: 在吗\n'.repeat(300)}`,
            '## 任务\n基于以上对话……',
        ].join('\n');
        const blocks = buildPromptBreakdown({ messages: [{ role: 'user', content: evalPrompt }] })!;
        const labels = blocks.map(b => b.label);
        expect(labels.some(l => l.startsWith('角色此刻看到的完整上下文'))).toBe(true);
        expect(labels.some(l => l.startsWith('你的身份'))).toBe(true);
        expect(labels.some(l => l === '任务')).toBe(true);
        expect(labels.some(l => l.startsWith('聊天历史·用户消息'))).toBe(false);
    });

    it('普通短 user 消息仍走角色聚合，不拆', () => {
        const blocks = buildPromptBreakdown({
            messages: [
                { role: 'user', content: '## 今天的计划\n买菜' },
                { role: 'user', content: '在吗' },
            ],
        })!;
        expect(blocks).toEqual([{ label: '聊天历史·用户消息 ×2', chars: '## 今天的计划\n买菜'.length + 2 }]);
    });
});

// 单条 user 提示词（记忆提取/日程生成等大量调用点的形态）：标「提示词整体」而非
// 「聊天历史」，用首行摘要标识任务。
describe('buildPromptBreakdown · 单条提示词标注', () => {
    it('无块头的单条 user 请求标成「提示词整体『首行』」', () => {
        const blocks = buildPromptBreakdown({
            messages: [{ role: 'user', content: '请从以下对话中提取记忆事件。\n对话：……' }],
        })!;
        expect(blocks).toHaveLength(1);
        expect(blocks[0].label).toBe('提示词整体「请从以下对话中提取记忆事件。」');
    });

    it('多条消息时仍按聊天历史聚合', () => {
        const blocks = buildPromptBreakdown({
            messages: [
                { role: 'system', content: '### 规则\n……' },
                { role: 'user', content: '你好' },
            ],
        })!;
        expect(blocks.map(b => b.label)).toContain('聊天历史·用户消息 ×1');
    });
});

// 围栏感知 + 固定块识别：行为规范里的日记示例（``` 内的 ## 行）不能被切成独立块；
// 固定骨架块名能被 isFixedPromptBlockLabel 识别（展示层据此合并）。
describe('buildPromptBreakdown · 围栏感知与固定块', () => {
    it('``` 代码块内的 ##/### 行不开新块', () => {
        const sys = [
            '### 聊天 App 行为规范 (Chat App Rules)',
            '规则正文',
            '```',
            '## 今天的小确幸',
            '### 小标题（会变成彩色卡片）',
            '```',
            '规则继续',
            '### 表达底线 (Anti-Filler)',
            '正文',
        ].join('\n');
        const labels = buildPromptBreakdown({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }] })!
            .map(b => b.label);
        expect(labels).toEqual([
            '聊天 App 行为规范 (Chat App Rules)',
            '表达底线 (Anti-Filler)',
            '聊天历史·用户消息 ×1',
        ]);
    });

    it('固定骨架块名识别，数据块不误伤', () => {
        expect(isFixedPromptBlockLabel('聊天 App 行为规范 (Chat App Rules)')).toBe(true);
        expect(isFixedPromptBlockLabel('最后，回到你自己')).toBe(true);
        expect(isFixedPromptBlockLabel('[MCP 工具 ON · 永远用角色语气回复别空回')).toBe(true);
        expect(isFixedPromptBlockLabel('记忆系统 (Memory Bank)')).toBe(false);
        expect(isFixedPromptBlockLabel('底色认知 (Resident Knowledge)')).toBe(false);
        expect(isFixedPromptBlockLabel('[Background Context: Recent Group Activi')).toBe(false);
    });
});

// 落单围栏防吞噬：用户数据里奇数个 ``` 不能把后面所有块头吞进上一块
// （实测事故：记忆摘要带半个围栏 → 62K「记忆系统」行吞掉对话历史+评估框架）。
describe('buildPromptBreakdown · 落单围栏', () => {
    it('奇数个 ``` 时最后一个不算开栏，后续块头照常识别', () => {
        const sys = [
            '### 记忆系统 (Memory Bank)',
            '- 某条记忆里带了半个围栏 ```',
            '### 表达底线 (Anti-Filler)',
            '正文',
            '## 任务',
            '评估任务说明',
        ].join('\n');
        const labels = buildPromptBreakdown({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }] })!
            .map(b => b.label);
        expect(labels).toContain('表达底线 (Anti-Filler)');
        expect(labels).toContain('任务');
    });

    it('成对围栏仍然屏蔽示例块头', () => {
        const sys = '### 规则\n```\n## 示例标题\n```\n### 下一块\n正文';
        const labels = buildPromptBreakdown({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }] })!
            .map(b => b.label);
        expect(labels).toEqual(['规则', '下一块', '聊天历史·用户消息 ×1']);
    });
});

it('没有标准收尾的世界书文本仍按标题拆分，所有消息分区可还原全文', () => {
    const content = '### 扩展设定集 (Worldbooks)\n开头几行\n### 自定义规则\n' + '完整规则正文\n'.repeat(500) + '末尾标记';
    const capture = buildApiRequestCapture({
        url: 'https://example.com/v1/chat/completions',
        body: JSON.stringify({ messages: [{ role: 'system', content }] }),
    });
    const parts = capture.sections.filter(s => s.messageIndex === 0);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map(s => getApiRequestCaptureSectionContent(capture, s)).join('')).toBe(content);
    expect(JSON.stringify(capture.payload)).toContain('末尾标记');
});

describe('resolveApiCallMeta · 归属补全与前台上下文隔离', () => {
    it('显式传入无角色的 meta 时，绝不混入前台打开的私聊角色', () => {
        setApiCallAmbientContext({ appId: 'chat', appName: '消息', charId: 'char-fg', charName: '前台角色' });
        const resolved = resolveApiCallMeta({ appId: 'settings', purpose: '测试连接' });
        expect(resolved).toEqual({
            appId: 'settings',
            appName: '设置',
            charId: undefined,
            charName: undefined,
            purpose: '测试连接',
        });
    });

    it('只传 appId 与 charId 时自动补齐中文 App 名与已注册角色名', () => {
        setCharNameRegistry([{ id: 'char-mp', name: 'Sully' }]);
        const resolved = resolveApiCallMeta({ appId: 'memorypalace', charId: 'char-mp', purpose: '记忆消化' });
        expect(resolved).toEqual({
            appId: 'memorypalace',
            appName: '记忆宫殿',
            charId: 'char-mp',
            charName: 'Sully',
            purpose: '记忆消化',
        });
    });

    it('未传显式 meta 时仍退回前台环境快照', () => {
        setApiCallAmbientContext({ appId: 'chat', appName: '消息', charId: 'char-fg', charName: '前台角色' });
        expect(resolveApiCallMeta(undefined)).toMatchObject({
            appId: 'chat',
            appName: '消息',
            charId: 'char-fg',
            charName: '前台角色',
        });
    });
});

describe('recordCompletedCloudApiCall · 单阶段云端调用落账', () => {
    it('一次写齐渠道、角色用途与总 Token 且不挂 pending', async () => {
        const { DB } = await import('./db');
        const logged: any[] = [];
        const spy = vi.spyOn(DB, 'appendApiCallLog').mockImplementation(async (entry: any) => {
            logged.push(entry);
        });
        try {
            recordCompletedCloudApiCall({
                id: 'cloud-proactive-task-1:1700000000000',
                route: 'cloud-proactive',
                baseUrl: 'https://api.example.com/v1',
                model: 'claude-sonnet-4-5',
                ok: true,
                timestamp: 1700000000000,
                promptTokens: 3200,
                completionTokens: 180,
                meta: { appId: 'chat', charId: 'char-mp', purpose: '主动消息' },
            });
            await vi.waitFor(() => expect(logged).toHaveLength(1));
            expect(logged[0]).toMatchObject({
                id: 'cloud-proactive-task-1:1700000000000',
                route: 'cloud-proactive',
                pending: false,
                ok: true,
                baseUrl: 'https://api.example.com/v1',
                model: 'claude-sonnet-4-5',
                promptTokens: 3200,
                completionTokens: 180,
                totalTokens: 3380,
                appName: '消息',
                purpose: '主动消息',
            });
        } finally {
            spy.mockRestore();
        }
    });
});

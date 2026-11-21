import { afterEach, expect, it, vi } from 'vitest';
import { DB } from '../db';
import * as palace from '../memoryPalace/pipeline';
import * as api from '../safeApi';
import { createCompanionRequests } from './requests';
import { isChatConversationEntry } from '../memoryPalace/trace';
import { ContextBuilder } from '../context';
import type { CompanionLine } from './session';
import { CompanionDebugStore } from './debug';

vi.mock('../activeMsgRuntime', () => ({ prepareInboxBeforeChat: vi.fn(async () => {}) }));
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
const line = (text: string): CompanionLine => ({ id: 1, text, heard: text, role: 'user', at: Date.now(), status: 'done' });
const char = (id: string): any => ({ id, name: 'C', systemPrompt: '完整人设标记', contextRangePolicyVersion: 1, contextLimit: 10,
  contextRangeMode: 'manual', memoryPalaceEnabled: true, memoryPalaceInjection: '过期召回',
  dialogueApi: { baseUrl: 'https://character.example/v1', apiKey: 'character-key', model: 'same-model' },
  mountedWorldbooks: [{ id: 'quick-key', title: '关键设定', content: '世界书深度标记', constant: false, key: ['短答关键词'], position: 4, depth: 1, role: 0 }] });
const context = (character: any): any => ({ char: character, user: { name: 'U' }, api: { baseUrl: 'https://global.example', apiKey: 'global-key', model: 'wrong-model' }, style: '轻量语气', scene: () => '一件蓝外套' });

it.each(['none', 'direct', 'helper'] as const)('only attaches matching clip stills to the full request with explicit direct opt-in: %s', async imageMode => {
  vi.spyOn(palace, 'injectMemoryPalace').mockResolvedValue({} as any);
  const calls = vi.spyOn(api, 'safeFetchJson').mockResolvedValue({ choices: [{ message: { content: '短答关键词' } }] });
  const observation = { text: '先看红衣服，再转向蓝外套', from: Date.now() - 8000, to: Date.now(), frames: [{ image: 'data:image/jpeg;base64,MATCHED', at: Date.now() }] };
  const requests = createCompanionRequests({ ...context(char('images-' + imageMode)), imageMode, observation: () => observation });
  const signal = new AbortController().signal;
  const quick = requests.quick([line('A')], signal);
  const payload = await requests.prepare([line('A')], quick, signal);
  await requests.full(payload, signal);
  const first = calls.mock.calls[0][1].body as string, second = calls.mock.calls[1][1].body as string;
  expect(first).not.toContain('image_url');
  expect(second.includes('image_url')).toBe(imageMode === 'direct');
  expect(second.includes('MATCHED')).toBe(imageMode === 'direct');
  expect(second).toContain('先看红衣服，再转向蓝外套');
  expect(second).toContain('完整人设标记'); expect(second).toContain('世界书深度标记');
  expect(second.match(/短答关键词/g)).toHaveLength(1);
  const messages = JSON.parse(second).messages;
  // Gemini drops system messages from contents: it must still end in a user task.
  expect(messages.filter((message: any) => message.role !== 'system').at(-1)).toMatchObject({ role: 'user' });
  expect(messages.at(-1).content).toContain('非用户新增发言');
  expect(JSON.parse(first).messages.at(-1)).toEqual({ role: 'user', content: 'A' });
});

it('sends one direct full-context answer without waiting for a or adding an assistant turn', async () => {
  const recall = vi.spyOn(palace, 'injectMemoryPalace').mockImplementation(async c => { c.memoryPalaceInjection = '本轮召回'; return {} as any; });
  const transport = vi.spyOn(api, 'safeFetchJson').mockResolvedValue({ choices: [{ message: { content: '完整回答' } }] });
  const debug = new CompanionDebugStore(), signal = new AbortController().signal;
  const requests = createCompanionRequests({ ...context(char('direct-full')), debug });
  debug.start(signal, '这件呢', false);
  const payload = await requests.prepare([line('这件呢')], new Promise<string>(() => {}), signal, false);
  expect(await requests.full(payload, signal, false)).toBe('完整回答');
  expect(transport).toHaveBeenCalledOnce();
  expect(recall).toHaveBeenCalledOnce();
  const body = JSON.parse(String(transport.mock.calls[0][1].body));
  expect(body.model).toBe('same-model');
  expect(body.messages.filter((m: any) => m.role === 'assistant')).toEqual([]);
  expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('直接回答') });
  expect(JSON.stringify(body.messages)).toContain('完整人设标记');
  expect(JSON.stringify(body.messages)).toContain('本轮召回');
  expect(debug.getSnapshot()[0].stages.wait_a).toBeUndefined();
});

it('does not invent an assistant prefill when quick generation has failed', async () => {
  vi.spyOn(palace, 'injectMemoryPalace').mockResolvedValue({} as any);
  const requests = createCompanionRequests(context(char('quick-failed')));
  const payload = await requests.prepare([line('A')], Promise.resolve(''), new AbortController().signal);
  expect(payload.fullMessages.some(message => message.role === 'assistant' && !message.content.trim())).toBe(false);
});

it('keeps quick history bounded after lengthy continuations without truncating the current question', () => {
  const current = '当前问题'.repeat(500);
  const request = ContextBuilder.buildCompanionQuickRequest({ char: char('bounded'), user: { name: 'U' } as any,
    style: '语气', scene: '现场', history: [
      ...Array.from({ length: 12 }, () => ({ role: 'assistant' as const, content: '长回复'.repeat(4000) })),
      { role: 'user', content: current },
    ] });
  expect(request).toHaveLength(8);
  expect(request.at(-1)?.content).toBe(current);
  expect(request.slice(1, -1).every(message => message.content.length < 620)).toBe(true);
});

it('quick never recalls; full waits for a once, shares the route and scans worldbooks after a arrives', async () => {
  const character = char('companion-route');
  const calls = vi.spyOn(api, 'safeFetchJson').mockResolvedValue({ choices: [{ message: { content: '短答关键词' } }] });
  const recall = vi.spyOn(palace, 'injectMemoryPalace').mockImplementation(async c => { c.memoryPalaceInjection = '本轮召回'; return {} as any; });
  const debug = new CompanionDebugStore();
  const requests = createCompanionRequests({ ...context(character), debug });
  const signal = new AbortController().signal;
  debug.start(signal, 'A');
  const quick = requests.quick([line('A')], signal);
  expect(recall).not.toHaveBeenCalled();
  const payload = await requests.prepare([line('A')], quick, signal);
  await requests.full(payload, signal);
  expect(recall).toHaveBeenCalledOnce();
  const quickBody = JSON.parse(calls.mock.calls[0][1].body as string);
  expect(JSON.stringify(quickBody)).toContain('轻量语气');
  expect(JSON.stringify(quickBody)).not.toMatch(/完整人设标记|过期召回|本轮召回|世界书深度标记/);
  const long = JSON.stringify(payload.fullMessages);
  expect(long).toContain('完整人设标记'); expect(long).toContain('本轮召回'); expect(long).not.toContain('过期召回');
  expect(long.match(/短答关键词/g)).toHaveLength(1);
  expect(long.match(/世界书深度标记/g)).toHaveLength(1);
  expect(payload.fullMessages.findIndex(message => String(message.content).includes('世界书深度标记')))
    .toBeLessThan(payload.fullMessages.findIndex(message => message.content === '短答关键词'));
  for (const [url, init, , , meta] of calls.mock.calls) {
    expect(url).toBe('https://character.example/v1/chat/completions');
    expect((init.headers as any).Authorization).toBe('Bearer character-key');
    expect(JSON.parse(init.body as string).model).toBe('same-model'); expect(meta?.appId).toBe('companion');
  }
  expect(isChatConversationEntry('companion')).toBe(true);
  expect(character.memoryPalaceInjection).toBe('过期召回');
  const recorded = debug.getSnapshot()[0];
  expect(recorded.requests.quick?.body).toBe(calls.mock.calls[0][1].body);
  expect(recorded.requests.full?.body).toBe(calls.mock.calls[1][1].body);
  expect(recorded.stages.memory?.end).toBeLessThanOrEqual(recorded.stages.prompt!.start);
  expect(recorded.requests.quick?.firstDelta).toBeUndefined();
  expect(JSON.stringify(recorded)).not.toMatch(/character-key|global-key|character\.example/);
});

it('reports a skipped recall and real first content event without changing request messages', async () => {
  vi.spyOn(palace, 'injectMemoryPalace').mockResolvedValue({ outcome: 'skipped_palace_disabled' } as any);
  const calls = vi.spyOn(api, 'safeFetchJson').mockImplementation(async (_url, _init, _retries, _timeout, _meta, hooks) => {
    hooks?.onFirstDelta?.(); return { choices: [{ message: { content: 'a' } }] };
  });
  const debug = new CompanionDebugStore(), signal = new AbortController().signal;
  const requests = createCompanionRequests({ ...context(char('skip-debug')), debug });
  debug.start(signal, 'A');
  await requests.prepare([line('A')], requests.quick([line('A')], signal), signal);
  const turn = debug.getSnapshot()[0];
  expect(turn.stages.memory).toMatchObject({ status: 'skipped', note: '未开启记忆宫殿' });
  expect(turn.requests.quick?.firstDelta).toBeGreaterThanOrEqual(turn.requests.quick!.submitted);
  expect(turn.requests.full).toBeUndefined(); expect(calls).toHaveBeenCalledOnce();
});

it.each(['manual', 'adaptive'])('respects %s range and passes exactly the selected rows to recall', async mode => {
  const character = { ...char('companion-range-' + mode), contextRangeMode: mode, autoArchiveEnabled: mode === 'adaptive' };
  const saved: number[] = [];
  for (let i = 0; i < 230; i++) saved.push(await DB.saveMessage({ charId: character.id, role: 'user', type: 'text', content: `历史编号${i}结束`, timestamp: Date.now() - 100000 + i }));
  localStorage.setItem('mp_lastMsgId_' + character.id, String(saved[5]));
  const recall = vi.spyOn(palace, 'injectMemoryPalace').mockResolvedValue({} as any);
  const payload = await createCompanionRequests(context(character)).prepare([line('当前A')], Promise.resolve('短答'), new AbortController().signal);
  const text = JSON.stringify(payload.fullMessages);
  expect(text).not.toContain('历史编号5结束');
  expect(text).toContain('历史编号229结束');
  expect(text.includes('历史编号6结束')).toBe(mode === 'adaptive');
  expect(recall.mock.calls[0][1]!.length).toBe(mode === 'adaptive' ? 225 : 10);
  expect(recall.mock.calls[0][1]!.at(-1)?.content).toBe('当前A');
  expect(text.match(/当前A/g)).toHaveLength(1);
});

it.each([true, false])('preserves the selected API transport setting for both requests: %s', async stream => {
  vi.spyOn(palace, 'injectMemoryPalace').mockResolvedValue({} as any);
  const calls = vi.spyOn(api, 'safeFetchJson').mockResolvedValue({ choices: [{ message: { content: '短答关键词' } }] });
  const ctx = context(char('stream-setting-' + stream));
  ctx.api.stream = stream;
  const requests = createCompanionRequests(ctx);
  const signal = new AbortController().signal;
  const quick = requests.quick([line('A')], signal);
  await requests.full(await requests.prepare([line('A')], quick, signal), signal);
  expect(calls.mock.calls.map(call => JSON.parse(String(call[1].body)).stream)).toEqual([stream, stream]);
  expect(ctx.api.stream).toBe(stream);
  expect(JSON.parse(String(calls.mock.calls[1][1].body)).messages.at(-1).role).toBe('user');
});

it('observes headers and first text from the real streaming parser before a′ has completed', async () => {
  vi.spyOn(palace, 'injectMemoryPalace').mockResolvedValue({} as any);
  const debug = new CompanionDebugStore(), signal = new AbortController().signal;
  const trace = debug.start(signal, 'A');
  let finish!: () => void, firstText!: () => void;
  const first = new Promise<void>(resolve => { firstText = resolve; });
  const seenFirst = vi.spyOn(trace, 'firstDelta').mockImplementation(phase => {
    // Keep actual trace mutation while signalling the test after the first chunk.
    Object.getPrototypeOf(trace).firstDelta.call(trace, phase);
    firstText();
  });
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    expect(JSON.parse(String(init!.body)).stream).toBe(true);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"我记得"}}]}\n\n'));
      finish = () => {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你的偏好。"},"finish_reason":"stop"}]}\n\n'));
        controller.close();
      };
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const ctx = context(char('real-stream')); ctx.api.stream = true;
  const requests = createCompanionRequests({ ...ctx, debug });
  const payload = await requests.prepare([line('A')], Promise.resolve('短答关键词'), signal);
  const result = requests.full(payload, signal);
  await first;
  expect(debug.getSnapshot()[0].requests.full?.headers).toMatchObject({ status: 200, streaming: true });
  expect(debug.getSnapshot()[0].requests.full?.firstDelta).toBeDefined();
  expect(debug.getSnapshot()[0].requests.full?.response).toBeUndefined();
  finish(); expect(await result).toBe('我记得你的偏好。');
  expect(seenFirst).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
});

it('records an actual 524 without retrying generation or claiming the connection produced text', async () => {
  const debug = new CompanionDebugStore(), signal = new AbortController().signal;
  debug.start(signal, 'A');
  const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    '{"error":{"message":"openai_error"}}', { status: 524, headers: { 'content-type': 'application/json' } }));
  const requests = createCompanionRequests({ ...context(char('timeout')), debug });
  await expect(requests.full({ fullMessages: [{ role: 'user', content: 'A' }] } as any, signal)).rejects.toThrow('524');
  expect(debug.getSnapshot()[0].requests.full?.headers?.status).toBe(524);
  expect(debug.getSnapshot()[0].requests.full?.firstDelta).toBeUndefined();
  expect(debug.getSnapshot()[0].stages.full_request?.status).toBe('error');
  expect(transport).toHaveBeenCalledOnce();
});

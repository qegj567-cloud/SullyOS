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

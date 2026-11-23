// 回归守卫：回连轮数用完时写出的回连标签不执行，剥掉的同时要留 trace（带种类和个数），
// 否则「角色说去查了却没下文」查不到原因。
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./instantTraceLog', () => ({ appendInstantTraceEntry: vi.fn() }));

import * as agenticTools from './agenticTools';
import { applyAssistantPostProcessing, type PostProcessCtx } from './applyAssistantPostProcessing';
import { DB } from './db';
import { appendInstantTraceEntry } from './instantTraceLog';

const makeCtx = (charId: string): PostProcessCtx => ({
  char: { id: charId, name: '测试角色', xhsEnabled: true } as any,
  userProfile: { name: '用户' } as any,
  emojis: [],
  realtimeConfig: { xhsMcpConfig: { enabled: true, serverUrl: 'https://xhs-lite.test' } } as any,
  contextMsgs: [],
  fullMessages: [{ role: 'user', content: '看看这条' }],
  initialData: {},
  historyMsgCount: 1,
  xhsCaches: {
    xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(),
    commentAuthorNameCache: new Map(), commentParentIdCache: new Map(),
  },
  api: { baseUrl: 'https://llm.test/v1', headers: {}, effectiveApi: { baseUrl: 'https://llm.test/v1', apiKey: '', model: 'test' } },
  hooks: { setMessages: vi.fn(), addToast: vi.fn() },
  instantRender: true,
});

const replyWith = (content: string) => vi.spyOn(globalThis, 'fetch' as any).mockImplementation((async () => ({
  ok: true, status: 200,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
  text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
})) as any);

let saved: string[];
beforeEach(() => {
  vi.clearAllMocks();
  saved = [];
  vi.spyOn(DB, 'saveMessage').mockImplementation(async (m: any) => { saved.push(String(m.content)); return 1 as any; });
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([]);
  vi.spyOn(agenticTools, 'runXhsDetail').mockResolvedValue({
    ok: true, noteId: 'n1', detailText: '标题：猫', commentsUnavailable: false,
  } as any);
});
afterEach(() => { vi.restoreAllMocks(); });

const replyQueue = (...contents: string[]) => vi.spyOn(globalThis, 'fetch' as any).mockImplementation((async () => ({
  ok: true, status: 200,
  headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
  text: async () => JSON.stringify({ choices: [{ message: { content: contents.shift() ?? '' } }] }),
})) as any);

it('最后一轮写出的回连标签：不执行、照常剥掉，并记 second-pass-tag-unexecuted', async () => {
  const fetchSpy = replyQueue(
    '[[XHS_DETAIL: n2]]', '[[XHS_DETAIL: n3]]', '[[XHS_DETAIL: n4]]',
    '看完啦\n[[XHS_SEARCH: 猫]]\n[[SEARCH: 猫咪品种]]',
  );
  const search = vi.spyOn(agenticTools, 'runXhsSearch');
  await applyAssistantPostProcessing('[[XHS_DETAIL: n1]]', makeCtx(`trace-${Math.random()}`));
  expect(fetchSpy).toHaveBeenCalledTimes(4);
  expect(search).not.toHaveBeenCalled();
  expect(saved.join('\n')).not.toMatch(/\[\[/);
  expect(saved.join('\n')).toContain('看完啦');
  expect(appendInstantTraceEntry).toHaveBeenCalledOnce();
  expect(vi.mocked(appendInstantTraceEntry).mock.calls[0][0]).toMatchObject({
    event: 'second-pass-tag-unexecuted', tags: { XHS_SEARCH: 1, SEARCH: 1 }, count: 2, reason: 'final-round',
  });
});

it('连着打回重复调用到阈值收尾时，同样记 trace', async () => {
  replyQueue('[[XHS_DETAIL: n1]]', '[[XHS_DETAIL: n1]]', '[[XHS_DETAIL: n1]]');
  await applyAssistantPostProcessing('[[XHS_DETAIL: n1]]', makeCtx(`trace-${Math.random()}`));
  expect(appendInstantTraceEntry).toHaveBeenCalledOnce();
  expect(vi.mocked(appendInstantTraceEntry).mock.calls[0][0]).toMatchObject({
    event: 'second-pass-tag-unexecuted', tags: { XHS_DETAIL: 1 }, count: 1, reason: 'duplicate-limit',
  });
});

it('二轮正文里没有回连标签时不记 trace', async () => {
  replyWith('看完啦');
  await applyAssistantPostProcessing('[[XHS_DETAIL: n1]]', makeCtx(`trace-${Math.random()}`));
  expect(appendInstantTraceEntry).not.toHaveBeenCalled();
});

it('回连请求发出前先过调用方的确认，确认中止时不发请求', async () => {
  const fetchSpy = replyWith('看完啦');
  const { createReplyRun } = await import('./chatReplyCancellation');
  const ctx = makeCtx(`abort-${Math.random()}`);
  const run = createReplyRun(ctx.char.id);
  ctx.replyRun = run;
  ctx.beforeSecondPass = async () => { run.stop(); run.check(); };
  await expect(applyAssistantPostProcessing('[[XHS_DETAIL: n1]]', ctx)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchSpy).not.toHaveBeenCalled();
  await run.settle();
});

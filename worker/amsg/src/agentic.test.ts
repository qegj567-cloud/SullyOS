/**
 * amsg worker v2 服务端工具循环 — 决策纯逻辑回归测试。
 *
 * 钉住的行为：
 *  1. finish 分段与客户端气泡同一份（sanitizeIntoSegments：按换行切，
 *     [[...]] / [html] 等标签块保持原子）；push 业务字段形状与 v1 一致，另挂
 *     notification.body = 净化文本给 OS banner；
 *  2. 数据标签 → tool-request，旁白与旁白里的副作用跨轮累积、finish 时一起出；
 *  3. 副作用标签 → 结构化 directives 只挂最后一条 push（收侧 isLastChunk 守卫依赖这一点）；
 *  4. 全程无正文：无副作用 → skip-push，有副作用 → 单条空正文 push 携带 directives。
 */

import { describe, expect, it } from 'vitest';
import {
  buildXhsSessionPayload,
  classifyNativeToolCalls,
  createFireSessionState,
  DEFAULT_TOOL_ITERATIONS,
  MCP_MAX_TOOL_ITERATIONS,
  resolveToolIterationBudget,
  processLLMRound,
  type PushBuildInput,
} from './agentic';
import { buildMcpNameMap, type McpFireServer } from '../../../utils/mcpFireCore';
import {
  AMSG_FIRE_CANCEL_TOOL,
  AMSG_FIRE_SCHEDULE_TOOL,
} from '../../../utils/amsgFireSchedule';
import type { XhsNote } from '../../../utils/realtimeContext';

const build: PushBuildInput = {
  contactName: '小鹿',
  avatarUrl: 'https://example.com/a.png',
  taskId: '42',
  messageType: 'auto',
  metadata: { charId: 'char-1', amsgMode: 'auto' },
  occurrenceMs: Date.UTC(2026, 6, 21, 1, 0),
};

describe('processLLMRound — 纯文本 finish', () => {
  it('按换行分段成多条 scheduled push，业务字段形状与 v1 一致 + notification banner', () => {
    const state = createFireSessionState();
    const decision = processLLMRound(state, '想你了。\n快回消息！', build);

    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads).toHaveLength(2);
    expect(decision.pushPayloads[0]).toEqual({
      messageKind: 'content',
      messageType: 'auto',
      source: 'scheduled',
      message: '想你了。',
      title: '来自 小鹿',
      contactName: '小鹿',
      avatarUrl: 'https://example.com/a.png',
      messageSubtype: 'chat',
      taskId: '42',
      // 每条 push 都带触发时刻——客户端靠它认「这次触发送达过」。
      metadata: { charId: 'char-1', amsgMode: 'auto', amsgOccurrenceMs: build.occurrenceMs },
      notification: { title: '来自 小鹿', body: '想你了。' },
    });
    // 无副作用时 metadata 原样透传，不额外挂 directives 键。
    expect((decision.pushPayloads[1].metadata as any).directives).toBeUndefined();
  });

  it('同一行多句不拆 — 气泡结构跟随 LLM 的换行意图（与客户端 chunkText 一致）', () => {
    const decision = processLLMRound(createFireSessionState(), '想你了。快回消息！', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads.map((p) => p.message)).toEqual(['想你了。快回消息！']);
  });

  // 标签用 SEND_EMOJI 这种约定好的：模型现编的标签（`[[分享卡: …]]`）独占一段时会被
  // sanitize 整段丢掉，那是「横幅响了、点进去 0 气泡」那条规则，跟这里验的劈碎无关。
  it('回归：[[...]] 标签内的句读不再把标签劈碎（曾把「]]」拼进下一条消息）', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '看到个热搜。\n[[SEND_EMOJI: 官宣了！速看]]',
      build,
    );
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads.map((p) => p.message)).toEqual([
      '看到个热搜。',
      '[[SEND_EMOJI: 官宣了！速看]]',
    ]);
  });

  it('SEND_EMOJI 独立成段：message 保留原始标签给客户端渲染，banner 显示可读形态', () => {
    const decision = processLLMRound(createFireSessionState(), '想你了\n[[SEND_EMOJI: 抱抱]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads).toHaveLength(2);
    expect(decision.pushPayloads[1].message).toBe('[[SEND_EMOJI: 抱抱]]');
    expect((decision.pushPayloads[1].notification as any).body).toBe('[表情：抱抱]');
  });

  it('空输出且无累积 → skip-push', () => {
    const decision = processLLMRound(createFireSessionState(), '', build);
    expect(decision.decision).toBe('skip-push');
  });
});

describe('processLLMRound — 数据标签 tool-request 与跨轮累积', () => {
  it('RECALL 标签 → tool-request，旁白暂存；下一轮 finish 时旁白排在正文前', () => {
    const state = createFireSessionState();

    const round1 = processLLMRound(state, '等等，我想想上个月的事。[[RECALL: 2026-06]]', build);
    expect(round1.decision).toBe('tool-request');
    if (round1.decision !== 'tool-request') return;
    expect(round1.toolCalls).toHaveLength(1);
    expect(round1.toolCalls[0].function.name).toBe('recall');
    expect(JSON.parse(round1.toolCalls[0].function.arguments)).toEqual({ year: '2026', month: '06' });
    expect(state.narrations).toEqual(['等等，我想想上个月的事。']);

    const round2 = processLLMRound(state, '想起来了，那天的落日超好看！', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    expect(round2.pushPayloads.map((p) => p.message)).toEqual([
      '等等，我想想上个月的事。',
      '想起来了，那天的落日超好看！',
    ]);
  });

  it('tool-request 轮旁白里的副作用标签也被结构化累积，finish 时挂上', () => {
    const state = createFireSessionState();

    const round1 = processLLMRound(state, '[[ACTION:POKE]]在吗在吗。[[SEARCH: 今晚 流星雨]]', build);
    expect(round1.decision).toBe('tool-request');
    // 旁白存原始文本（副作用标签保留），finish 时拼回全文统一扫。
    expect(state.narrations).toEqual(['[[ACTION:POKE]]在吗在吗。']);

    const round2 = processLLMRound(state, '今晚十点有流星雨！[[ACTION:ADD_EVENT|看流星雨|今晚10点]]', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    expect((last.metadata as any).directives).toEqual([
      { type: 'poke' },
      { type: 'add_event', title: '看流星雨', date: '今晚10点' },
    ]);
    // 非最后一条不挂 directives（客户端只在 isLastChunk 时 replay 一次）。
    for (const p of round2.pushPayloads.slice(0, -1)) {
      expect((p.metadata as any).directives).toBeUndefined();
    }
    // 副作用标签已从正文剥掉。
    for (const p of round2.pushPayloads) {
      expect(String(p.message)).not.toContain('[[ACTION');
    }
  });
});

// 回归守卫：`[[MUSIC_ACTION:add|歌单标题]]` 里只有歌单名，没有歌名。客户端重放时若只能
// 取「用户此刻在听的那首」，定时消息补收的那一刻用户多半什么都没在放 —— 正文聊着这首歌，
// 卡片和加歌单却整个没发生。所以到点渲染「你此刻在听：《X》」时顺手把 X 冻进 directive。
describe('processLLMRound — MUSIC_ACTION 冻结这次在听的那首歌', () => {
  const song = { id: 33, name: '夜航星', artists: '某某' };
  const withSong: PushBuildInput = { ...build, sceneSong: song };

  const directivesOf = (decision: ReturnType<typeof processLLMRound>) => {
    if (decision.decision !== 'finish') return undefined;
    const last = decision.pushPayloads[decision.pushPayloads.length - 1];
    return (last.metadata as any).directives;
  };

  it('这次渲染挑了歌 → music_action 带上它', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '这首太好听了，收进歌单。\n[[MUSIC_ACTION:add|深夜]]',
      withSong,
    );
    expect(directivesOf(decision)).toEqual([
      { type: 'music_action', verb: 'add', args: ['深夜'], song },
    ]);
  });

  it('这次没渲染「此刻在听」（不在听歌的时段 / 跨天作废）→ 不附，客户端走实时快照那条路', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '这首太好听了。\n[[MUSIC_ACTION:add|深夜]]',
      { ...build, sceneSong: null },
    );
    expect(directivesOf(decision)).toEqual([
      { type: 'music_action', verb: 'add', args: ['深夜'] },
    ]);
  });

  it('其余类型的 directive 一概不动', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '戳你一下。\n[[ACTION:POKE]]',
      withSong,
    );
    expect(directivesOf(decision)).toEqual([{ type: 'poke' }]);
  });
});

describe('processLLMRound — 无正文边界', () => {
  // 空正文的 push 连 banner body 都是空的：用户锁屏收到一条只有标题的空横幅、未读 +1、
  // 点进去 0 气泡。所以没正文就整条不发，副作用一起放弃，两种成因分开记进 last_skip。
  it('全程只有副作用标签、没有正文：整条不发，记 side-effects-only', () => {
    const decision = processLLMRound(createFireSessionState(), '[[ACTION:POKE]]', build);
    expect(decision.decision).toBe('skip-push');
    if (decision.decision !== 'skip-push') return;
    expect(decision.reason).toBe('side-effects-only');
  });

  // 日程改动是「没正文就整条丢」这条规矩里的唯一例外：它不是做给用户看的动作，是角色
  // 在纠正自己的表。一起丢掉的话，下一次 fire 读到的还是那条旧安排，角色会反复想改又
  // 反复改不掉。所以照旧不发推送，但把改动带出来交给调用方走 emitResult。
  it('只有日程改动、没有正文：仍然不发推送，但把改动带出来', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '[[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]',
      build,
    );
    expect(decision.decision).toBe('skip-push');
    if (decision.decision !== 'skip-push') return;
    expect(decision.reason).toBe('side-effects-only');
    expect(decision.scheduleChanges).toEqual([{ startTime: '22:00', activity: '陪你聊天' }]);
  });

  it('没有日程改动时不带这个字段（别让调用方对着空数组白跑一趟）', () => {
    const decision = processLLMRound(createFireSessionState(), '[[ACTION:POKE]]', build);
    expect(decision.decision).toBe('skip-push');
    if (decision.decision !== 'skip-push') return;
    expect(decision.scheduleChanges).toBeUndefined();
  });

  it('既没正文也没副作用：整条不发，记 empty-generation', () => {
    const decision = processLLMRound(createFireSessionState(), '', build);
    expect(decision.decision).toBe('skip-push');
    if (decision.decision !== 'skip-push') return;
    expect(decision.reason).toBe('empty-generation');
  });

  it('工具轮后 LLM 空输出：仍冲刷累积旁白，不静默丢', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我查查。[[SEARCH: 天气]]', build);
    const round2 = processLLMRound(state, '', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    expect(round2.pushPayloads.map((p) => p.message)).toEqual(['我查查。']);
  });
});

describe('processLLMRound — 副作用标签块被数据标签劈成两轮（实机回归）', () => {
  it('长形态日记写一半去 RECALL：finish 拼回全文，日记成 directive、裸标签不漏进 push', () => {
    const state = createFireSessionState();

    // round 1：日记开了头，中途想查记忆 → 数据标签把文本劈开。
    const round1 = processLLMRound(
      state,
      '[[DIARY_START: 专属点读机 | 傲娇]]\n今天那家伙又缠着我。[[RECALL: 2026-06]]',
      build,
    );
    expect(round1.decision).toBe('tool-request');

    // round 2：日记收尾 + 正文。
    const round2 = processLLMRound(state, '……才、才不是想他！\n[[DIARY_END]]\n写完了，哼。', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;

    // 日记整块成了 directive（title/mood/跨轮内容都在），挂最后一条 push。
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    const directives = (last.metadata as any).directives;
    expect(directives).toHaveLength(1);
    expect(directives[0].type).toBe('notion_write_diary');
    expect(directives[0].title).toBe('专属点读机');
    expect(directives[0].mood).toBe('傲娇');
    expect(directives[0].content).toContain('今天那家伙又缠着我。');
    expect(directives[0].content).toContain('……才、才不是想他！');

    // 正文 push 里不再出现孤立的 DIARY_START / DIARY_END 裸标签。
    for (const p of round2.pushPayloads) {
      expect(String(p.message)).not.toContain('DIARY_START');
      expect(String(p.message)).not.toContain('DIARY_END');
    }
    expect(round2.pushPayloads.map((p) => p.message)).toContain('写完了，哼。');
  });

  it('飞书长形态同款劈裂也能拼回', () => {
    const state = createFireSessionState();
    processLLMRound(state, '[[FS_DIARY_START: 今日份|开心]]\n上半段。[[SEARCH: 流星雨]]', build);
    // 末尾这句正文是必要的：日记整块会被剥成 directive，一句话不留的话这轮没有可发的
    // 正文，走的是「无正文不发」那条路，验不到这里想验的「跨轮拼回」。
    const round2 = processLLMRound(state, '下半段。\n[[FS_DIARY_END]]\n记好啦。', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    const directives = (last.metadata as any).directives;
    expect(directives?.[0]?.type).toBe('feishu_write_diary');
    expect(directives?.[0]?.content).toContain('上半段。');
    expect(directives?.[0]?.content).toContain('下半段。');
  });
});

// ─── XHS 笔记随 push 带回（amsg2 round 1 在 worker 跑，客户端缺笔记缓冲） ────────

const makeNote = (n: number, descLen = 10): XhsNote => ({
  noteId: `note-${n}`,
  title: `标题${n}`,
  desc: 'd'.repeat(descLen),
  likes: n,
  author: `作者${n}`,
  authorId: `author-${n}`,
  xsecToken: `tok-${n}`,
  coverUrl: `https://img.example.com/${n}.jpg`,
});

describe('buildXhsSessionPayload — 按 directive 引用挑选最小数据包', () => {
  const notes = [makeNote(1), makeNote(2), makeNote(3)];

  it('xhs_share 的 idx（1-based）→ 对应笔记；未引用的不带', () => {
    const payload = buildXhsSessionPayload([{ type: 'xhs_share', idx: 2 }], notes, []);
    expect(payload).not.toBeNull();
    expect(payload!.notes).toHaveLength(1);
    expect(payload!.notes[0].idx).toBe(2);
    expect(payload!.notes[0].note.noteId).toBe('note-2');
  });

  it('越界 / 编造的序号取不到笔记 → 跳过；全落空且无 token → null', () => {
    const payload = buildXhsSessionPayload([{ type: 'xhs_share', idx: 14 }], notes, []);
    expect(payload).toBeNull();
  });

  it('desc 截断到 120 字符（防 web push ~4KB payload 超限）', () => {
    const payload = buildXhsSessionPayload(
      [{ type: 'xhs_share', idx: 1 }],
      [makeNote(1, 500)],
      [],
    );
    expect(payload!.notes[0].note.desc).toHaveLength(120);
    // 原数组的笔记不能被就地改掉（worker 内同 fire 后续还会用）。
    expect(notes[0].desc).toHaveLength(10);
  });

  it('点赞/评论引用的 noteId → 只带对应 xsecToken', () => {
    const payload = buildXhsSessionPayload(
      [{ type: 'xhs_like', noteId: 'note-3' }],
      notes,
      [['note-1', 'tok-1'], ['note-3', 'tok-3']],
    );
    expect(payload!.notes).toHaveLength(0);
    expect(payload!.xsecTokens).toEqual([['note-3', 'tok-3']]);
  });

  it('无任何 XHS directive → null（poke 等副作用不触发带笔记）', () => {
    expect(buildXhsSessionPayload([{ type: 'poke' }], notes, [['note-1', 'tok-1']])).toBeNull();
  });

  // 回归守卫：角色说分享了几张就带几张，绝不按张数砍。
  // 砍过的版本会让用户看到「说分享了 6 张、只出来 4 张卡」——话和内容对不上。
  // 装不装得进一条 push 由 index.ts 的 offloadOversizedPush 按真实字节算，
  // 超出的旁路存 client_state，不是丢内容。
  it('share 引用几张就带几张，不按张数砍', () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => makeNote(n));
    const payload = buildXhsSessionPayload(
      [1, 2, 3, 4, 5, 6].map((idx) => ({ type: 'xhs_share' as const, idx })),
      many,
      [],
    );
    expect(payload!.notes).toHaveLength(6);
  });
});

describe('processLLMRound — metadata.xhsSession 挂载', () => {
  it('share 引用的笔记与 directives 同挂最后一条 push，其余 push 不挂', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我去逛逛。[[XHS_BROWSE]]', build);
    const round2 = processLLMRound(state, '看到个好玩的！\n[[XHS_SHARE: 1]]', {
      ...build,
      xhsNotes: [makeNote(1)],
      xhsXsecTokens: [['note-1', 'tok-1']],
    });
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    expect((last.metadata as any).directives).toEqual([{ type: 'xhs_share', idx: 1 }]);
    expect((last.metadata as any).xhsSession.notes).toEqual([
      { idx: 1, note: makeNote(1) },
    ]);
    for (const p of round2.pushPayloads.slice(0, -1)) {
      expect((p.metadata as any).xhsSession).toBeUndefined();
    }
  });

  // [[XHS_SHARE: n]] 的 n 指的是模型写这句话时手上那份笔记列表。列表在后面的轮次被
  // 另一次搜索整个换掉之后，还按最终列表解引用就会推错卡片——正文聊的是露营帖、卡片
  // 推的却是同一序号的口红帖，用户点开一眼假。
  it('说要分享之后列表又被换掉 → 卡片仍取说这句话那一轮的列表', () => {
    const state = createFireSessionState();
    const 露营帖 = [makeNote(1), makeNote(2), makeNote(3)];
    const 口红帖 = [makeNote(11), makeNote(12), makeNote(13)];

    // 轮 1：先逛一圈，还没有笔记。
    processLLMRound(state, '我去逛逛。[[XHS_BROWSE]]', build);
    // 轮 2：拿到露营帖列表，说分享第 3 篇，同一轮又去搜别的。
    const round2 = processLLMRound(
      state,
      '这第三个露营帖太可了！[[XHS_SHARE: 3]]\n[[XHS_SEARCH: 口红]]',
      { ...build, xhsNotes: 露营帖 },
    );
    expect(round2.decision).toBe('tool-request');
    // 轮 3：手上的列表已经被搜索换成口红帖了，这时候收尾。
    const round3 = processLLMRound(state, '就这些啦。', { ...build, xhsNotes: 口红帖 });

    expect(round3.decision).toBe('finish');
    if (round3.decision !== 'finish') return;
    const last = round3.pushPayloads[round3.pushPayloads.length - 1];
    expect((last.metadata as any).xhsSession.notes).toEqual([
      { idx: 3, note: makeNote(3) },
    ]);
  });

  it('分享和收尾同一轮（没换过列表）照旧用最终列表', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我去逛逛。[[XHS_BROWSE]]', build);
    const round2 = processLLMRound(state, '看看这个！\n[[XHS_SHARE: 2]]', {
      ...build,
      xhsNotes: [makeNote(1), makeNote(2)],
    });
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    expect((last.metadata as any).xhsSession.notes).toEqual([{ idx: 2, note: makeNote(2) }]);
  });

  it('没有 XHS 引用时 metadata 不多挂 xhsSession 键（形状回归）', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '[[ACTION:POKE]]在吗',
      { ...build, xhsNotes: [makeNote(1)], xhsXsecTokens: [['note-1', 'tok-1']] },
    );
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    const last = decision.pushPayloads[decision.pushPayloads.length - 1];
    expect((last.metadata as any).directives).toEqual([{ type: 'poke' }]);
    expect((last.metadata as any).xhsSession).toBeUndefined();
  });
});

// 模型卡在同一个工具上出不来时的止损。
//
// 实测过一次最恶劣的情况：提示词里写着「每一轮第一行都要先输出 [[RECALL: 2026-06]]」，
// 那句话常驻在 system prompt 里、每轮都在模型眼前，工具结果里说什么都盖不过它——连着
// 五轮都在请求同一个 recall，最后撞上轮次上限抛 AGENTIC_LOOP_EXCEEDED，任务不出清、
// 下一分钟整条从头重跑，用户一个字都收不到。
//
// 打回重复调用只省下网络请求，止不住这个循环；到阈值直接收尾才行。
describe('processLLMRound — 重复调用到阈值就收尾', () => {
  it('还没到阈值时照常给下一轮工具机会', () => {
    const state = createFireSessionState();
    state.duplicateToolCalls = 1;
    const decision = processLLMRound(state, '让我想想。\n[[RECALL: 2026-06]]', build);
    expect(decision.decision).toBe('tool-request');
  });

  it('到阈值后不再请求工具，直接把已经写出来的内容发出去', () => {
    const state = createFireSessionState();
    // 前两轮攒下的旁白
    processLLMRound(state, '让我想想六月的事。\n[[RECALL: 2026-06]]', build);
    state.duplicateToolCalls = 2;

    const decision = processLLMRound(state, '再查一下。\n[[RECALL: 2026-06]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;

    const text = decision.pushPayloads.map((p) => p.message).join('\n');
    expect(text).toContain('让我想想六月的事');
    // 转不出去的那个标签不能漏进正文
    expect(text).not.toContain('RECALL');
  });

  it('之前几轮的旁白只出现一次，不重复', () => {
    const state = createFireSessionState();
    processLLMRound(state, '就说这一句。\n[[RECALL: 2026-06]]', build);
    state.duplicateToolCalls = 2;
    const decision = processLLMRound(state, '再查一次。\n[[RECALL: 2026-06]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    const text = decision.pushPayloads.map((p) => p.message).join('\n');
    expect(text.match(/就说这一句/g)?.length).toBe(1);
  });

  it('卡住时一个字都没写出来 → skip-push，不发空消息', () => {
    const state = createFireSessionState();
    state.duplicateToolCalls = 2;
    expect(processLLMRound(state, '[[RECALL: 2026-06]]', build).decision).toBe('skip-push');
  });
});

// 穿透收尾（重复到阈值 / 最后一轮）时，触发穿透那一轮的旁白是「等我翻翻记录哈」这种半句：
// 它请求的工具永远不会跑了，发出去用户收到的最后一条消息就永远没有下文。
describe('processLLMRound — 穿透收尾丢掉悬空的「我去查查」', () => {
  it('触发穿透那一轮的旁白不进正文，之前几轮的照发', () => {
    const state = createFireSessionState();
    processLLMRound(state, '今天路过那家店了。\n[[RECALL: 2026-06]]', build);
    state.duplicateToolCalls = 2;

    const decision = processLLMRound(state, '等我翻翻记录哈。\n[[RECALL: 2026-06]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    const text = decision.pushPayloads.map((p) => p.message).join('\n');
    expect(text).toContain('今天路过那家店了');
    expect(text, '这句后面永远没有下文，不能当结尾发出去').not.toContain('等我翻翻记录哈');
  });

  it('只有这一句半截话可发 → skip-push，宁可不发', () => {
    const state = createFireSessionState();
    state.duplicateToolCalls = 2;
    const decision = processLLMRound(state, '稍等，我查查看。\n[[SEARCH: 天气]]', build);
    expect(decision.decision).toBe('skip-push');
  });
});

// 上游在最后一轮遇到 tool-request 会直接抛 AGENTIC_LOOP_EXCEEDED：这次攒下的旁白全丢、
// 任务不出清、下一分钟整条从头重跑再烧一遍 LLM，而用户一个字都收不到。
describe('processLLMRound — 最后一轮不再放行工具请求', () => {
  it('最后一轮还想调工具 → 拿之前几轮的内容收尾', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我想想六月发生了什么。\n[[RECALL: 2026-06]]', build, null, null, 0);
    processLLMRound(state, '顺便看看天气。\n[[SEARCH: 明天 天气]]', build, null, null, 1);

    const decision = processLLMRound(
      state, '还得再查一次。\n[[RECALL: 2026-07]]', build, null, null, DEFAULT_TOOL_ITERATIONS - 1);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    const text = decision.pushPayloads.map((p) => p.message).join('\n');
    expect(text).toContain('我想想六月发生了什么');
    expect(text).toContain('顺便看看天气');
    expect(text).not.toContain('还得再查一次');
    expect(text).not.toContain('RECALL');
  });

  it('倒数第二轮照常给工具机会', () => {
    const decision = processLLMRound(
      createFireSessionState(), '查一下。\n[[SEARCH: 天气]]', build, null, null, DEFAULT_TOOL_ITERATIONS - 2);
    expect(decision.decision).toBe('tool-request');
  });

  it('不传轮次（拿不到 ctx.iteration 的老部署）行为不变', () => {
    const decision = processLLMRound(createFireSessionState(), '查一下。\n[[SEARCH: 天气]]', build);
    expect(decision.decision).toBe('tool-request');
  });
});

describe('工具轮次预算 — 普通任务省成本，MCP 多步任务可继续', () => {
  it('没有 MCP 保持 5 轮，有 MCP 放宽到 12 轮', () => {
    expect(resolveToolIterationBudget(false)).toBe(DEFAULT_TOOL_ITERATIONS);
    expect(resolveToolIterationBudget(true)).toBe(MCP_MAX_TOOL_ITERATIONS);
    expect(DEFAULT_TOOL_ITERATIONS).toBe(5);
    expect(MCP_MAX_TOOL_ITERATIONS).toBe(12);
  });

  it('MCP 的第 5 轮仍可继续，第 12 轮才强制收尾', () => {
    const fifth = processLLMRound(
      createFireSessionState(), '继续查。\n[[SEARCH: 天气]]', build, null, null,
      DEFAULT_TOOL_ITERATIONS - 1, MCP_MAX_TOOL_ITERATIONS,
    );
    expect(fifth.decision).toBe('tool-request');

    const last = processLLMRound(
      createFireSessionState(), '再查。\n[[SEARCH: 天气]]', build, null, null,
      MCP_MAX_TOOL_ITERATIONS - 1, MCP_MAX_TOOL_ITERATIONS,
    );
    expect(last.decision).not.toBe('tool-request');
  });
});

// ─── 通用 MCP 的两层识别（native tool_calls 优先，正文协议兜底） ────────────────

const mcpSrv: McpFireServer = {
  id: 's1',
  name: '探针',
  url: 'https://probe.example.com',
  tools: [{ name: 'get_secret', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } }],
};
const mcpResolve = buildMcpNameMap([mcpSrv]);
const nativeCall = (args = '{}') => ({
  id: 'call_n1',
  type: 'function' as const,
  function: { name: 'mcp__get_secret', arguments: args },
});

describe('processLLMRound + MCP', () => {
  it('native tool_calls → tool-request 原样透传, 正文全文入旁白', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去问问暗号。', build, {
      resolve: mcpResolve,
      nativeToolCalls: [nativeCall('{"who":"小满"}')],
    });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls).toEqual([nativeCall('{"who":"小满"}')]);
    expect(state.narrations.join('')).toContain('我去问问暗号');
  });

  it('第二层：无 native 时识别正文假调用, 名字带 mcp__ 前缀, 旁白剥净语法', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去问问暗号。\nget_secret({"who":"小满"})', build, {
      resolve: mcpResolve,
    });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls[0].function.name).toBe('mcp__get_secret');
    expect(JSON.parse(d.toolCalls[0].function.arguments)).toEqual({ who: '小满' });
    expect(state.narrations.join('')).not.toContain('get_secret(');
  });

  it('模型把带前缀的名字写进正文（native 模式掉格式）也认, 不出现双前缀', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, 'mcp__get_secret({"who":"小满"})', build, { resolve: mcpResolve });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls[0].function.name).toBe('mcp__get_secret');
  });

  // 模型经常同一个意图两处都写：native 通道发一份、正文里再"演"一份。
  // 两份都入列会把同一个工具跑两遍（第二次还会被判成重复调用往收尾计数上加），
  // 所以 native 在场时正文那份只剥语法、不入列。
  it('native 与正文同时出现 → 只认 native，正文语法照剥', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '我去问问。\nget_secret({"who":"小满"})', build, {
      resolve: mcpResolve,
      nativeToolCalls: [nativeCall('{"who":"小满"}')],
    });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls).toEqual([nativeCall('{"who":"小满"}')]);   // 不重复入列
    expect(state.narrations.join('')).not.toContain('get_secret('); // 语法照剥
  });

  // 合成 id 曾用「已跑过的工具数」做轮间区分度，但重复调用被短路、工具抛错这两条路
  // 都不会往 toolCalls 落账——连着两轮都会拿到同一个 id，assistant/tool 消息配不上对。
  it('正文合成的 tool_call id 跨轮不重号（轮间没有工具落账也不撞）', () => {
    const state = createFireSessionState();
    const r1 = processLLMRound(state, 'get_secret({"who":"甲"})', build, { resolve: mcpResolve });
    const r2 = processLLMRound(state, 'get_secret({"who":"乙"})', build, { resolve: mcpResolve });
    expect(r1.decision).toBe('tool-request');
    expect(r2.decision).toBe('tool-request');
    if (r1.decision !== 'tool-request' || r2.decision !== 'tool-request') return;
    expect(r1.toolCalls[0].id).not.toBe(r2.toolCalls[0].id);
  });

  it('native 与数据标签同轮 → 合并进同一个 tool-request', () => {
    const state = createFireSessionState();
    const d = processLLMRound(state, '[[RECALL: 2026-06]]', build, {
      resolve: mcpResolve,
      nativeToolCalls: [nativeCall()],
    });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    const names = d.toolCalls.map((tc) => tc.function.name);
    expect(names).toContain('recall');
    expect(names).toContain('mcp__get_secret');
  });

  it('无 MCP 参与时行为与不传第 4 参完全一致（回归）', () => {
    const a = processLLMRound(createFireSessionState(), '正常收尾文本。', build, { resolve: mcpResolve });
    const b = processLLMRound(createFireSessionState(), '正常收尾文本。', build);
    expect(a).toEqual(b);
  });

  it('finish 后最终推送正文不含调用语法（防泄漏回归守卫）', () => {
    const state = createFireSessionState();
    processLLMRound(state, '先问暗号。\nget_secret({})', build, { resolve: mcpResolve });
    const d = processLLMRound(state, '拿到了，暗号是 X。', build, { resolve: mcpResolve });
    expect(d.decision).toBe('finish');
    if (d.decision !== 'finish') return;
    const all = d.pushPayloads.map((p) => String(p.message)).join('\n');
    expect(all).toContain('先问暗号');
    expect(all).not.toContain('get_secret(');
  });
});

// ─── native tool_call 认领：严格命中优先，去命名空间唯一命中兜底（实机回归） ────────
//
// 实测里两类丢弃都真实发生过：模型把 mcp__ 前缀弄丢只报裸名（sess_task_60/61），
// 以及 native 调 cancel_active_message 这个明明声明过的工具被当幻觉丢掉（sess_task_64
// ——旧入口只认 schedule + mcp__ 两种名字，cancel / renew 压根没有池可进）。

const manageNames = new Set([AMSG_FIRE_SCHEDULE_TOOL, AMSG_FIRE_CANCEL_TOOL]);
const rawCall = (name: string, args = '{}', id = 'call_x1') => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});

describe('classifyNativeToolCalls — 认领与丢弃', () => {
  it('严格命中照旧：mcp__ 前缀名进 mcp 池、声明的管理工具名进 manage 池，名字不动', () => {
    const r = classifyNativeToolCalls(
      [rawCall('mcp__get_secret'), rawCall(AMSG_FIRE_SCHEDULE_TOOL), rawCall(AMSG_FIRE_CANCEL_TOOL)],
      manageNames, mcpResolve,
    );
    expect(r.mcp.map((tc) => tc.function.name)).toEqual(['mcp__get_secret']);
    expect(r.manage.map((tc) => tc.function.name))
      .toEqual([AMSG_FIRE_SCHEDULE_TOOL, AMSG_FIRE_CANCEL_TOOL]);
    expect(r.dropped).toEqual([]);
  });

  it('模型丢了 mcp__ 前缀只报裸名 → 认领并把名字改写回声明名（sess_task_60/61 现场）', () => {
    const r = classifyNativeToolCalls(
      [rawCall('get_secret', '{"who":"小满"}')], manageNames, mcpResolve);
    expect(r.mcp).toHaveLength(1);
    expect(r.mcp[0].function.name).toBe('mcp__get_secret');
    // id 与参数原样保留，只改名字
    expect(r.mcp[0].id).toBe('call_x1');
    expect(r.mcp[0].function.arguments).toBe('{"who":"小满"}');
    expect(r.dropped).toEqual([]);
  });

  it('换了「姓」的命名空间写法（default_api: / functions. / tools/）取最后一段唯一命中', () => {
    const r = classifyNativeToolCalls([
      rawCall('default_api:get_secret'),
      rawCall('functions.mcp__get_secret'),
      rawCall(`tools/${AMSG_FIRE_CANCEL_TOOL}`),
    ], manageNames, mcpResolve);
    expect(r.mcp.map((tc) => tc.function.name))
      .toEqual(['mcp__get_secret', 'mcp__get_secret']);
    expect(r.manage.map((tc) => tc.function.name)).toEqual([AMSG_FIRE_CANCEL_TOOL]);
    expect(r.dropped).toEqual([]);
  });

  it('幻觉工具（哪份清单都对不上）照旧丢弃，名字留给日志', () => {
    const r = classifyNativeToolCalls(
      [rawCall('made_up_tool'), rawCall('default_api:also_fake')], manageNames, mcpResolve);
    expect(r.manage).toEqual([]);
    expect(r.mcp).toEqual([]);
    expect(r.dropped).toEqual(['made_up_tool', 'default_api:also_fake']);
  });

  it('工具没声明就不认领：manage 清单空时 cancel 照丢、mcpResolve 为 null 时裸名照丢', () => {
    const r = classifyNativeToolCalls(
      [rawCall(AMSG_FIRE_CANCEL_TOOL), rawCall('get_secret')], new Set<string>(), null);
    expect(r.manage).toEqual([]);
    expect(r.mcp).toEqual([]);
    expect(r.dropped).toEqual([AMSG_FIRE_CANCEL_TOOL, 'get_secret']);
  });

  it('形状不对的输入（非数组 / 没有名字）不炸，进 dropped 或忽略', () => {
    expect(classifyNativeToolCalls(undefined, manageNames, mcpResolve))
      .toEqual({ manage: [], mcp: [], dropped: [] });
    const r = classifyNativeToolCalls(
      [{ id: 'call_bad', type: 'function', function: { name: '', arguments: '{}' } }],
      manageNames, mcpResolve);
    expect(r.dropped).toEqual([null]);
  });
});

describe('processLLMRound — 排程池混入 cancel / renew', () => {
  it('本轮只 native 取消了一条 → 正文里的排程语法照常认（不同意图不算跑两遍）', () => {
    const state = createFireSessionState();
    const d = processLLMRound(
      state,
      `那条不用发了，我重新约。\n${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"2026-07-22 09:00","topic":"约早饭"})`,
      build, null, { nativeToolCalls: [rawCall(AMSG_FIRE_CANCEL_TOOL, '{"task_id":"abcd1234"}')] });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    const names = d.toolCalls.map((tc) => tc.function.name);
    expect(names).toContain(AMSG_FIRE_CANCEL_TOOL);
    expect(names).toContain(AMSG_FIRE_SCHEDULE_TOOL);
    // 正文那句排程语法照剥，不能漏进旁白
    expect(state.narrations.join('')).not.toContain(`${AMSG_FIRE_SCHEDULE_TOOL}(`);
  });

  it('native 排程在场时正文排程语法仍只剥不入列（防同一意图跑两遍，回归守卫）', () => {
    const state = createFireSessionState();
    const nativeSchedule = rawCall(AMSG_FIRE_SCHEDULE_TOOL, '{"send_at":"2026-07-22 09:00"}');
    const d = processLLMRound(
      state,
      `我给你排上啦。\n${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"2026-07-22 09:00"})`,
      build, null, { nativeToolCalls: [nativeSchedule] });
    expect(d.decision).toBe('tool-request');
    if (d.decision !== 'tool-request') return;
    expect(d.toolCalls).toEqual([nativeSchedule]);
    expect(state.narrations.join('')).not.toContain(`${AMSG_FIRE_SCHEDULE_TOOL}(`);
  });

  it('多轮工具循环里收尾轮原样复读了前序旁白 → 去重不发两遍；不同内容照常拼合', () => {
    const dupState = createFireSessionState();
    const nativeSchedule = rawCall(AMSG_FIRE_SCHEDULE_TOOL, '{"send_at":"2026-07-22 09:00"}');
    processLLMRound(dupState, '好呀，明早九点叫你起床～', build, null, { nativeToolCalls: [nativeSchedule] });
    const dupFinish = processLLMRound(dupState, '好呀，明早九点叫你起床～', build);
    expect(dupFinish.decision).toBe('finish');
    if (dupFinish.decision === 'finish') {
      expect(dupFinish.pushPayloads.map((p) => p.message)).toEqual(['好呀，明早九点叫你起床～']);
    }

    const contState = createFireSessionState();
    processLLMRound(contState, '好的，我去整。', build, null, { nativeToolCalls: [nativeSchedule] });
    const contFinish = processLLMRound(contState, '哎呀没排上，你先自己定个闹钟哈。', build);
    expect(contFinish.decision).toBe('finish');
    if (contFinish.decision === 'finish') {
      expect(contFinish.pushPayloads.map((p) => p.message)).toEqual([
        '好的，我去整。',
        '哎呀没排上，你先自己定个闹钟哈。',
      ]);
    }
  });
});

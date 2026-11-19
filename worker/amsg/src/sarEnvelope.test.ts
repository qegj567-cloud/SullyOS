/**
 * SAR 临时模块信封在 worker 侧的处理——回归守卫。
 *
 * 钉住的行为（线协议见 plans/amsg2-instant-chat-contract.md）：
 *  1. 信封轮只有 CHAR_TRUE 进分段，信封标签绝不成为 push 正文；
 *  2. CHAR_SURFACE 里的标签不 classify：不产 directive、不触发工具；
 *  3. 外显逐段对齐挂 amsgSarSurface，横幅换成外显；表情 / HTML / 纯动作不占槽位，
 *     翻译块、语音块各是一个原子段；
 *  4. 模型不守信封 → 原文照发；只剩余韵 → 原文一个字节不动；
 *  5. amsgSar 快照、amsgSarUserSurface 只挂最后一条 push。
 */

import { describe, expect, it } from 'vitest';
import {
  createFireSessionState,
  processLLMRound,
  type PushBuildInput,
} from './agentic';
import {
  alignSarSurfaceSegments,
  clipSarSurfaceBanner,
  maskSarSurfaceBlocks,
  SAR_SURFACE_BANNER_MAX,
  parseSarEnvelopeRounds,
  readSarSnapshot,
  stripSarSnapshot,
} from './sarEnvelope';
import { sanitizeIntoSegments } from '../../../utils/sanitize';
import {
  planFromSARModuleSnapshot,
  type AmsgSarModuleSnapshot,
  type SARModuleSurfaceSource,
} from '../../../utils/vrWorld/sarEnvelopeCore';

const CHAR_ACTIVE: SARModuleSurfaceSource = {
  runId: 'run-char', moduleId: 'mod-reverse', moduleTitle: '反话模块', target: 'character', phase: 'active',
};
const USER_ACTIVE: SARModuleSurfaceSource = {
  runId: 'run-user', moduleId: 'mod-sweet', moduleTitle: '夹子音', target: 'user', phase: 'active',
};

const snapshot = (over: Partial<AmsgSarModuleSnapshot> = {}): AmsgSarModuleSnapshot => ({
  v: 1,
  character: CHAR_ACTIVE,
  events: [],
  userMessageId: 7,
  userSurfaceTargetIds: [7],
  reroll: false,
  ...over,
});

const baseBuild: PushBuildInput = {
  contactName: '小鹿',
  avatarUrl: null,
  taskId: '42',
  messageType: 'instant',
  metadata: { charId: 'char-1', amsgMode: 'instant' },
  occurrenceMs: Date.UTC(2026, 8, 25, 1, 0),
};

const buildWith = (sar: AmsgSarModuleSnapshot | null): PushBuildInput => ({ ...baseBuild, sar });

const envelope = (parts: { truth: string; surface?: string; user?: string }) => [
  '<SAR_MODULE_OUTPUT>',
  `<CHAR_TRUE>\n${parts.truth}\n</CHAR_TRUE>`,
  ...(parts.surface !== undefined ? [`<CHAR_SURFACE>\n${parts.surface}\n</CHAR_SURFACE>`] : []),
  ...(parts.user !== undefined ? [`<USER_SURFACE>\n${parts.user}\n</USER_SURFACE>`] : []),
  '</SAR_MODULE_OUTPUT>',
].join('\n');

const finishPayloads = (decision: ReturnType<typeof processLLMRound>) => {
  expect(decision.decision).toBe('finish');
  if (decision.decision !== 'finish') throw new Error('not finish');
  return decision.pushPayloads as Array<Record<string, any>>;
};

const ENVELOPE_TAG = /<\/?(?:SAR_MODULE_OUTPUT|CHAR_TRUE|CHAR_SURFACE|USER_SURFACE)>/i;

describe('processLLMRound — SAR 信封', () => {
  it('只有 CHAR_TRUE 进分段，信封标签不成为 push 正文；外显逐段挂上、横幅用外显', () => {
    const sar = snapshot();
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      envelope({ truth: '我好想你。\n今天好累', surface: '我才不想你。\n今天一点都不累' }),
      buildWith(sar),
    ));

    expect(payloads.map((p) => p.message)).toEqual(['我好想你。', '今天好累']);
    for (const p of payloads) {
      expect(p.message).not.toMatch(ENVELOPE_TAG);
      expect(p.notification.body).not.toMatch(ENVELOPE_TAG);
    }
    expect(payloads.map((p) => p.metadata.amsgSarSurface?.surface)).toEqual(['我才不想你。', '今天一点都不累']);
    expect(payloads[0].metadata.amsgSarSurface).toEqual({
      version: 1,
      runId: 'run-char',
      moduleId: 'mod-reverse',
      moduleTitle: '反话模块',
      target: 'character',
      phase: 'active',
      surface: '我才不想你。',
      canonicalField: 'content',
      surfaceField: 'metadata.sarModuleSurface.surface',
    });
    // 锁屏横幅跟界面一致：显示外显，真意不能漏出去。
    expect(payloads.map((p) => p.notification.body)).toEqual(['我才不想你。', '今天一点都不累']);
    // 快照只随最后一条回去一次。
    expect(payloads[0].metadata.amsgSar).toBeUndefined();
    expect(payloads[1].metadata.amsgSar).toBe(sar);
  });

  it('CHAR_SURFACE 里的标签不 classify：不产 directive，也不触发工具', () => {
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      envelope({
        truth: '我在呢。',
        surface: '我才不在。[[ACTION:POKE]]\n[[RECALL: 2026-06]]\n[[DIARY: 偷偷记一笔]]',
      }),
      buildWith(snapshot()),
    ));

    expect(payloads.map((p) => p.message)).toEqual(['我在呢。']);
    expect(payloads[0].metadata.directives).toBeUndefined();
    expect(payloads[0].metadata.amsgSarSurface.surface).toBe('我才不在。');
  });

  it('真意里的副作用照常结构化，外显里抄的同一个标签不会再来一遍', () => {
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      envelope({ truth: '戳你一下。[[ACTION:POKE]]', surface: '才不戳你。[[ACTION:POKE]][[ACTION:ADD_EVENT|约会|2026-10-01]]' }),
      buildWith(snapshot()),
    ));

    expect(payloads[payloads.length - 1].metadata.directives).toEqual([{ type: 'poke' }]);
  });

  it('逐段对齐：表情 / HTML 不占外显槽位，纯动作不吃掉下一句台词，翻译块和语音块各占一个', () => {
    const truth = [
      '（揉了揉眼睛）',
      '早上好',
      '[[SEND_EMOJI: 抱抱]]',
      '[html]<div>今日卡片</div>[/html]',
      '<翻译><原文>Hello</原文><译文>你好</译文></翻译>',
      '<语音>嗯哼</语音><字幕>嗯哼</字幕>',
      '晚安',
    ].join('\n');
    const surface = [
      '早上坏',
      '[[SEND_EMOJI: 抱抱]]',
      '[html]<div>别的卡片</div>[/html]',
      '<翻译><原文>Bye</原文><译文>再见</译文></翻译>',
      '<语音>哼</语音><字幕>哼</字幕>',
      '不睡',
    ].join('\n');
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(), envelope({ truth, surface }), buildWith(snapshot()),
    ));

    expect(payloads.map((p) => p.message)).toEqual([
      '（揉了揉眼睛）',
      '早上好',
      '[[SEND_EMOJI: 抱抱]]',
      '[html]<div>今日卡片</div>[/html]',
      '<翻译><原文>Hello</原文><译文>你好</译文></翻译>',
      '<语音>嗯哼</语音><字幕>嗯哼</字幕>',
      '晚安',
    ]);
    expect(payloads.map((p) => p.metadata.amsgSarSurface?.surface)).toEqual([
      undefined,
      '早上坏',
      undefined,
      undefined,
      '<翻译><原文>Bye</原文><译文>再见</译文></翻译>',
      '<语音>哼</语音><字幕>哼</字幕>',
      '不睡',
    ]);
    // 对上外显的换横幅，对不上的保持真意自己的横幅。
    expect(payloads.map((p) => p.notification.body)).toEqual([
      '（揉了揉眼睛）',
      '早上坏',
      '[表情：抱抱]',
      '[HTML 卡片]',
      'Bye',
      '哼',
      '不睡',
    ]);
  });

  it('外显原位抄了动作时，动作消耗掉它自己那一格', () => {
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      envelope({ truth: '（抱住你）\n别走', surface: '（推开你）\n快走' }),
      buildWith(snapshot()),
    ));
    expect(payloads.map((p) => p.metadata.amsgSarSurface?.surface)).toEqual([undefined, '快走']);
  });

  it('模型不守信封 → 原文照发，快照照样挂最后一条，不挂外显', () => {
    const sar = snapshot();
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(), '忘了格式。\n直接说话', buildWith(sar),
    ));
    expect(payloads.map((p) => p.message)).toEqual(['忘了格式。', '直接说话']);
    expect(payloads.map((p) => p.notification.body)).toEqual(['忘了格式。', '直接说话']);
    for (const p of payloads) expect(p.metadata.amsgSarSurface).toBeUndefined();
    expect(payloads[0].metadata.amsgSar).toBeUndefined();
    expect(payloads[1].metadata.amsgSar).toBe(sar);
  });

  it('信封只写了半截（CHAR_TRUE 为空）时散落的信封标签也不进正文', () => {
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      '<SAR_MODULE_OUTPUT>\n<CHAR_TRUE></CHAR_TRUE>\n说漏了\n</SAR_MODULE_OUTPUT>',
      buildWith(snapshot()),
    ));
    expect(payloads.map((p) => p.message)).toEqual(['说漏了']);
  });

  it('只剩余韵（afterglow）→ 不拆信封，推送与没有模块时一字不差，只多一个末条快照', () => {
    const sar = snapshot({ character: { ...CHAR_ACTIVE, phase: 'afterglow' } });
    const text = '余韵还在。\n<CHAR_TRUE>别动</CHAR_TRUE>';
    const withSar = finishPayloads(processLLMRound(createFireSessionState(), text, buildWith(sar)));
    const plain = finishPayloads(processLLMRound(createFireSessionState(), text, baseBuild));

    expect(withSar.map((p) => [p.message, p.notification])).toEqual(plain.map((p) => [p.message, p.notification]));
    expect(withSar[withSar.length - 1].metadata.amsgSar).toBe(sar);
    for (const p of withSar.slice(0, -1)) expect(p.metadata.amsgSar).toBeUndefined();
    for (const p of withSar) expect(p.metadata.amsgSarSurface).toBeUndefined();
  });

  it('用户模块 active → USER_SURFACE 原文只挂最后一条', () => {
    const sar = snapshot({ character: undefined, user: USER_ACTIVE });
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      envelope({ truth: '嗯。\n听到了', surface: '不该用上的外显', user: '人家想你了嘛～\n[[ACTION:POKE]]' }),
      buildWith(sar),
    ));

    expect(payloads.map((p) => p.message)).toEqual(['嗯。', '听到了']);
    expect(payloads[0].metadata.amsgSarUserSurface).toBeUndefined();
    expect(payloads[1].metadata.amsgSarUserSurface).toBe('人家想你了嘛～\n[[ACTION:POKE]]');
    // 角色身上没有模块：CHAR_SURFACE 不用，也不把 USER_SURFACE 里的标签当副作用。
    for (const p of payloads) expect(p.metadata.amsgSarSurface).toBeUndefined();
    expect(payloads[1].metadata.directives).toBeUndefined();
  });

  it('只有角色模块时 USER_SURFACE 不回传', () => {
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      envelope({ truth: '在。', surface: '不在。', user: '不该回传' }),
      buildWith(snapshot()),
    ));
    expect(payloads[0].metadata.amsgSarUserSurface).toBeUndefined();
  });

  it('metadata 里带着快照也不会摊进每一条（只有末条经收尾挂回）', () => {
    const sar = snapshot();
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      envelope({ truth: '一\n二', surface: '壹\n贰' }),
      { ...buildWith(sar), metadata: { ...baseBuild.metadata, amsgSar: sar } },
    ));
    expect(payloads[0].metadata.amsgSar).toBeUndefined();
    expect(payloads[1].metadata.amsgSar).toBe(sar);
  });

  it('外显里的数据标签不触发工具（整段只有外显带 [[RECALL]] 时直接收尾）', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      envelope({ truth: '想起来了。', surface: '想不起来。\n[[RECALL: 2026-06]]' }),
      buildWith(snapshot()),
    );
    expect(decision.decision).toBe('finish');
  });

  it('工具循环跨轮两段信封 → 两段真意都在、各自对齐自己的外显，标签不漏', () => {
    const state = createFireSessionState();
    const build = buildWith(snapshot());
    const first = processLLMRound(
      state,
      envelope({ truth: '我去翻翻。\n[[RECALL: 2026-06]]', surface: '我才不翻。' }),
      build, null, null, 0,
    );
    expect(first.decision).toBe('tool-request');

    const payloads = finishPayloads(processLLMRound(
      state,
      envelope({ truth: '想起来了。\n那天去看海', surface: '忘光了。\n那天在家' }),
      build, null, null, 1,
    ));
    expect(payloads.map((p) => p.message)).toEqual(['我去翻翻。', '想起来了。', '那天去看海']);
    expect(payloads.map((p) => p.metadata.amsgSarSurface?.surface)).toEqual(['我才不翻。', '忘光了。', '那天在家']);
    for (const p of payloads) expect(p.message).not.toMatch(ENVELOPE_TAG);
  });
});

describe('processLLMRound — SAR 信封逐轮降级', () => {
  it('工具轮守了信封、最后一轮忘写信封 → 两轮都推出去，只有第一轮挂外显', () => {
    const state = createFireSessionState();
    const build = buildWith(snapshot());
    const first = processLLMRound(
      state,
      '<SAR_MODULE_OUTPUT><CHAR_TRUE>我去翻翻。\n[[RECALL: 2026-06]]</CHAR_TRUE><CHAR_SURFACE>我才不翻。</CHAR_SURFACE></SAR_MODULE_OUTPUT>',
      build, null, null, 0,
    );
    expect(first.decision).toBe('tool-request');

    const payloads = finishPayloads(processLLMRound(state, '想起来了，那天去看海。', build, null, null, 1));
    expect(payloads.map((p) => p.message)).toEqual(['我去翻翻。', '想起来了，那天去看海。']);
    expect(payloads.map((p) => p.metadata.amsgSarSurface?.surface)).toEqual(['我才不翻。', undefined]);
    expect(payloads.map((p) => p.notification.body)).toEqual(['我才不翻。', '想起来了，那天去看海。']);
  });

  it('没写外层包裹、CHAR_SURFACE 写在 CHAR_TRUE 前面 → 外显照样拿到，真意不上锁屏', () => {
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      '<CHAR_SURFACE>讨厌你</CHAR_SURFACE><CHAR_TRUE>喜欢你</CHAR_TRUE>',
      buildWith(snapshot()),
    ));
    expect(payloads.map((p) => p.message)).toEqual(['喜欢你']);
    expect(payloads[0].metadata.amsgSarSurface.surface).toBe('讨厌你');
    expect(payloads[0].notification.body).toBe('讨厌你');
  });

  it('外显横幅截到上限，普通回合的横幅不截', () => {
    const longSurface = '讨'.repeat(300);
    const payloads = finishPayloads(processLLMRound(
      createFireSessionState(),
      envelope({ truth: '喜'.repeat(300), surface: longSurface }),
      buildWith(snapshot()),
    ));
    expect(Array.from(payloads[0].notification.body)).toHaveLength(SAR_SURFACE_BANNER_MAX);
    // meta 里的外显不截：界面照它完整显示。
    expect(payloads[0].metadata.amsgSarSurface.surface).toBe(longSurface);

    const plain = finishPayloads(processLLMRound(createFireSessionState(), '喜'.repeat(300), baseBuild));
    expect(plain[0].notification.body).toBe('喜'.repeat(300));
  });

  it('多轮工具循环里收尾轮重抄了前序信封真意 → 连同前序外显一起去重；新补充的后轮信封照常拼合', () => {
    const sar = snapshot();
    const dupState = createFireSessionState();
    processLLMRound(
      dupState,
      envelope({ truth: '明早叫你起床[[RECALL: 2026-06]]', surface: '爱起不起' }),
      buildWith(sar),
      null,
      null,
      0,
    );
    const dupPayloads = finishPayloads(processLLMRound(
      dupState,
      envelope({ truth: '明早叫你起床\n记得定闹钟', surface: '爱起不起\n别迟到' }),
      buildWith(sar),
      null,
      null,
      1,
    ));
    expect(dupPayloads.map((p) => p.message)).toEqual(['明早叫你起床', '记得定闹钟']);
    expect(dupPayloads.map((p) => p.metadata.amsgSarSurface?.surface)).toEqual(['爱起不起', '别迟到']);
  });
});

describe('sarEnvelope 纯函数', () => {
  it('readSarSnapshot：形状不对就当没有', () => {
    expect(readSarSnapshot({ amsgSar: snapshot() })).not.toBeNull();
    expect(readSarSnapshot({})).toBeNull();
    expect(readSarSnapshot(null)).toBeNull();
    expect(readSarSnapshot({ amsgSar: 'x' })).toBeNull();
    expect(readSarSnapshot({ amsgSar: [] })).toBeNull();
    expect(readSarSnapshot({ amsgSar: { ...snapshot(), v: 2 } })).toBeNull();
    expect(readSarSnapshot({ amsgSar: { ...snapshot(), character: 'active' } })).toBeNull();
  });

  it('stripSarSnapshot 只摘快照', () => {
    expect(stripSarSnapshot({ a: 1, amsgSar: snapshot() })).toEqual({ a: 1 });
    expect(stripSarSnapshot(undefined)).toEqual({});
  });

  it('maskSarSurfaceBlocks：外显整块藏起来，restore 原样换回（含没闭合的）', () => {
    const text = '<CHAR_TRUE>真</CHAR_TRUE><CHAR_SURFACE>[[RECALL: 2026-06]]</CHAR_SURFACE><USER_SURFACE>没闭合';
    const mask = maskSarSurfaceBlocks(text);
    expect(mask.masked).not.toContain('RECALL');
    expect(mask.masked).not.toContain('没闭合');
    expect(mask.restore(mask.masked)).toBe(text);
  });

  it('parseSarEnvelopeRounds：不要求信封时原文一个字节不动', () => {
    const plan = planFromSARModuleSnapshot(snapshot({ character: { ...CHAR_ACTIVE, phase: 'afterglow' } }))!;
    const raw = '  <CHAR_TRUE>x</CHAR_TRUE>  ';
    expect(parseSarEnvelopeRounds([raw], plan)).toEqual({ canonical: raw, enveloped: false, pieces: [] });
  });

  it('parseSarEnvelopeRounds：截断的信封补上闭合再拆', () => {
    const plan = planFromSARModuleSnapshot(snapshot())!;
    const parsed = parseSarEnvelopeRounds(['<SAR_MODULE_OUTPUT><CHAR_TRUE>说到一半<CHAR_SURFACE>外显一半'], plan);
    expect(parsed.enveloped).toBe(true);
    expect(parsed.canonical).toBe('说到一半');
    expect(parsed.pieces[0].surface).toBe('外显一半');
  });

  it('parseSarEnvelopeRounds：逐轮降级——守了信封的轮带外显，没守的那轮原文照发', () => {
    const plan = planFromSARModuleSnapshot(snapshot())!;
    const parsed = parseSarEnvelopeRounds([
      '<SAR_MODULE_OUTPUT><CHAR_TRUE>我去翻翻。</CHAR_TRUE><CHAR_SURFACE>我才不翻。</CHAR_SURFACE></SAR_MODULE_OUTPUT>',
      '想起来了，那天去看海。',
    ], plan);
    expect(parsed).toEqual({
      canonical: '我去翻翻。\n想起来了，那天去看海。',
      enveloped: true,
      pieces: [
        { canonical: '我去翻翻。', surface: '我才不翻。' },
        { canonical: '想起来了，那天去看海。' },
      ],
    });
  });

  it('clipSarSurfaceBanner：超过上限按字符截断加省略号，不劈开代理对', () => {
    expect(clipSarSurfaceBanner('短')).toBe('短');
    const long = '😀'.repeat(SAR_SURFACE_BANNER_MAX + 20);
    const clipped = clipSarSurfaceBanner(long);
    expect(Array.from(clipped)).toHaveLength(SAR_SURFACE_BANNER_MAX);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('alignSarSurfaceSegments：外显比真意少时后面的段不挂', () => {
    const slots = alignSarSurfaceSegments(sanitizeIntoSegments('一\n二\n三'), '壹');
    expect(slots.map((s) => s?.surface)).toEqual(['壹', undefined, undefined]);
  });
});

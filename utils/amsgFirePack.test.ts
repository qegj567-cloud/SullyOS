import { describe, it, expect } from 'vitest';
import {
  AMSG_SLOT_AWAY_HINT,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_SCENE,
  AMSG_SLOT_SELF_LOG,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG_SLOT_TIME_SINCE_USER,
  AMSG_SLOT_USER_CLOCK,
  AmsgFirePack,
  AmsgSelfLog,
  FIRE_PACK_VERSION,
  describeFirePackVersion,
  SELF_LOG_MAX_ENTRIES,
  SELF_LOG_TEXT_MAX,
  AMSG_SLOT_LIVE_CHAT,
  appendSelfLogEntry,
  buildAwayHint,
  buildUserClockHint,
  countUnansweredSends,
  createSelfLog,
  DEFAULT_MAX_UNANSWERED_SENDS,
  describeLastSkip,
  formatFireTimeFull,
  formatFireTimeShort,
  formatTimeSinceUser,
  parseFirePack,
  parseLastSkip,
  parseSelfLog,
  packStateValue,
  reconcileSelfLogWithPack,
  renderFirePack,
  renderSelfLogBlock,
  resolveMaxUnansweredSends,
  unpackStateValue,
} from './amsgFirePack';

// 回归守卫：这些期望值抄的是 activeMsgClient 拆槽位前（buildTimeGapHint /
// buildLegacyStyleProactiveHint 内联时代）的旧文案。模板在前端维护、填槽在 worker 里跑，
// 改文案时这份测试会挡住手滑——期望值和文案要一起改。

describe('formatTimeSinceUser', () => {
  it('没有聊天记录（null）', () => {
    expect(formatTimeSinceUser(null)).toBe('你们最近没有新的聊天记录。');
  });

  it('小于 1 小时按分钟', () => {
    expect(formatTimeSinceUser(0)).toBe('距离用户上次主动发消息大约 0 分钟。');
    expect(formatTimeSinceUser(59)).toBe('距离用户上次主动发消息大约 59 分钟。');
  });

  it('小于 1 天按小时（整点不带分钟尾巴）', () => {
    expect(formatTimeSinceUser(60)).toBe('距离用户上次主动发消息大约 1 小时。');
    expect(formatTimeSinceUser(90)).toBe('距离用户上次主动发消息大约 1 小时 30 分钟。');
    expect(formatTimeSinceUser(1439)).toBe('距离用户上次主动发消息大约 23 小时 59 分钟。');
  });

  it('超过 1 天按天（整天不带小时尾巴）', () => {
    expect(formatTimeSinceUser(1440)).toBe('距离用户上次主动发消息大约 1 天。');
    expect(formatTimeSinceUser(1440 + 300)).toBe('距离用户上次主动发消息大约 1 天 5 小时。');
  });

  it('负数钳到 0（时钟回拨防线）', () => {
    expect(formatTimeSinceUser(-5)).toBe('距离用户上次主动发消息大约 0 分钟。');
  });
});

describe('buildAwayHint', () => {
  it('无记录 → 「最近没有主动来找你说话」', () => {
    expect(buildAwayHint('小明同学', '你们最近没有新的聊天记录。'))
      .toBe('小明同学最近没有主动来找你说话。');
  });

  it('有记录 → 只借时长、句子重拼', () => {
    expect(buildAwayHint('小明', '距离用户上次主动发消息大约 3 小时。'))
      .toBe('小明已经大约 3 小时 没主动来找你了。');
    expect(buildAwayHint('小明', '距离用户上次主动发消息大约 1 天 5 小时。'))
      .toBe('小明已经大约 1 天 5 小时 没主动来找你了。');
  });

  it('时长取不出来时退回「最近没来找你」，不吐半截句子', () => {
    expect(buildAwayHint('小明', '格式变了的一句话')).toBe('小明最近没有主动来找你说话。');
  });

  it('空名字回退「对方」', () => {
    expect(buildAwayHint('', '你们最近没有新的聊天记录。'))
      .toBe('对方最近没有主动来找你说话。');
  });
});

describe('formatFireTimeFull / formatFireTimeShort（角色参照系的自然中文时间）', () => {
  const noonZ = Date.UTC(2026, 6, 17, 12, 0);   // 2026-07-17（周五）12:00Z

  it('tzId 走 Intl（夏令时交给 ICU）', () => {
    // 纽约 7 月是 EDT(-4)：12:00Z → 08:00 早晨。固定偏移算法（EST -5）会给 07:00。
    expect(formatFireTimeFull(noonZ, { tzId: 'America/New_York' }))
      .toBe('2026年7月17日 周五 早晨 08:00');
    expect(formatFireTimeShort(noonZ, { tzId: 'America/New_York' })).toBe('7月17日 08:00');
  });

  it('tzId 非法直接抛错（数据坏了走 fire 失败路径，不静默给一个错的时间）', () => {
    expect(() => formatFireTimeFull(noonZ, { tzId: 'Not/AZone' })).toThrow();
  });

  it('时段词分桶与 buildCoreContext 一致（抽查边界）', () => {
    const at = (h: number) => Date.UTC(2026, 6, 17, h, 0);
    const word = (h: number) => formatFireTimeFull(at(h), { tzId: 'UTC' }).split(' ')[2];
    expect(word(4)).toBe('凌晨');
    expect(word(5)).toBe('早晨');
    expect(word(9)).toBe('上午');
    expect(word(13)).toBe('中午');
    expect(word(16)).toBe('下午');
    expect(word(18)).toBe('傍晚');
    expect(word(21)).toBe('晚上');
    expect(word(23)).toBe('深夜');
  });
});

describe('renderFirePack', () => {
  const basePack: AmsgFirePack = {
    v: FIRE_PACK_VERSION, builtAt: 1_700_000_000_000, pendingTasks: [], scene: null, selfScheduleEnabled: true,
    template: [
      `当前本地时间：${AMSG_SLOT_CURRENT_TIME}`,
      AMSG_SLOT_TIME_SINCE_USER,
      `现在是 ${AMSG_SLOT_CURRENT_TIME}。`,
      AMSG_SLOT_AWAY_HINT,
      AMSG_SLOT_TASK_INSTRUCTION,
    ].join('\n'),
    lastUserMessageAt: null,
    tzId: 'UTC',
    userTzId: 'UTC',
    targetName: '小明同学',
  };

  it('填满全部槽位，currentTime 出现多次也全部替换（自然中文格式，与 buildCoreContext 同款）', () => {
    const now = Date.UTC(2026, 6, 17, 8, 30);
    const rendered = renderFirePack(basePack, now, '本次任务指令');
    expect(rendered).toBe([
      '当前本地时间：2026年7月17日 周五 早晨 08:30',
      '你们最近没有新的聊天记录。',
      '现在是 2026年7月17日 周五 早晨 08:30。',
      '小明同学最近没有主动来找你说话。',
      '本次任务指令',
    ].join('\n'));
    expect(rendered).not.toContain('{{');
  });

  it('按 pack.tzId 的 IANA 时区渲染（Intl 处理，不吃运行时本地时区）', () => {
    // 2026-08-01T00:00Z 在 Asia/Shanghai 是周六早上 8 点。
    const now = Date.UTC(2026, 7, 1, 0, 0);
    const rendered = renderFirePack({ ...basePack, tzId: 'Asia/Shanghai' }, now, '指令');
    expect(rendered).toContain('当前本地时间：2026年8月1日 周六 早晨 08:00');
  });

  it('lastUserMessageAt 用渲染时刻现算时间差', () => {
    const now = Date.UTC(2026, 6, 17, 8, 0);
    const rendered = renderFirePack(
      { ...basePack, lastUserMessageAt: now - 90 * 60_000 },
      now,
      '本次任务指令',
    );
    expect(rendered).toContain('距离用户上次主动发消息大约 1 小时 30 分钟。');
    expect(rendered).toContain('小明同学已经大约 1 小时 30 分钟 没主动来找你了。');
  });
});

// 回归守卫：用户那边的钟以前完全没上云——角色只看得到自己那边的时间，
// 「晚上九点跟他说一声」在异国恋角色手里就是排到用户的凌晨三点，而且它没有任何线索
// 能察觉这件事。现在随包带 userTzId，到点渲染成一行参考。
//
// 另一半同样重要：这一行是**第二个钟**，措辞必须钉死主语，否则一份 prompt 里两个时间
// 在打架，模型只会随便挑一个信。
describe('对方那边现在几点（AMSG_SLOT_USER_CLOCK）', () => {
  // 纽约角色 / 上海用户：2026-08-02T13:00Z = 纽约 09:00、上海 21:00。
  const AT = Date.UTC(2026, 7, 2, 13, 0);
  const nyChar: AmsgFirePack = {
    v: FIRE_PACK_VERSION, builtAt: 1, pendingTasks: [], scene: null, selfScheduleEnabled: true, lastUserMessageAt: null,
    template: `当前本地时间（你所在地）：${AMSG_SLOT_CURRENT_TIME}${AMSG_SLOT_USER_CLOCK}`,
    tzId: 'America/New_York',
    userTzId: 'Asia/Shanghai',
    targetName: '小明同学',
  };

  it('两个钟各写各的主语：角色的是「当前本地时间」，用户的点名是「对方所在时区」', () => {
    const out = renderFirePack(nyChar, AT, '指令');
    expect(out).toContain('当前本地时间（你所在地）：2026年8月2日 周日 上午 09:00');
    expect(out).toContain('对方所在时区参考：小明同学那边现在是 8月2日 晚上 21:00');
    expect(out).not.toContain('{{');
  });

  it('同一个时区 → 整行消失（同一个钟报两遍就成了两个打架的时间）', () => {
    const out = renderFirePack({ ...nyChar, userTzId: 'America/New_York' }, AT, '指令');
    expect(out).toBe('当前本地时间（你所在地）：2026年8月2日 周日 上午 09:00');
  });

  it('buildUserClockHint 只认 userTz，不吃运行时本地时区', () => {
    expect(buildUserClockHint(AT, { tzId: 'UTC' }, { tzId: 'Asia/Tokyo' }, '小明同学'))
      .toContain('小明同学那边现在是 8月2日 深夜 22:00');
    // 空 tz（理论上 parseFirePack 已经挡住）→ 不硬编一个时间出来
    expect(buildUserClockHint(AT, { tzId: 'UTC' }, { tzId: '' }, '小明同学')).toBe('');
  });

  it('没名字回退「对方」', () => {
    expect(buildUserClockHint(AT, { tzId: 'UTC' }, { tzId: 'Asia/Shanghai' }, ''))
      .toContain('对方那边现在是');
  });
});

describe('parseFirePack', () => {
  const valid: AmsgFirePack = {
    v: FIRE_PACK_VERSION, template: 'x', lastUserMessageAt: null, tzId: 'Asia/Shanghai', userTzId: 'Asia/Shanghai', targetName: 'A',
    builtAt: 1_700_000_000_000, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  };

  it('合法 JSON 原样返回', () => {
    expect(parseFirePack(JSON.stringify(valid))).toEqual(valid);
  });

  it('builtAt / pendingTasks 缺一不可（self_log 对齐与排程清单都靠它们）', () => {
    const { builtAt: _b, ...noBuiltAt } = valid;
    const { pendingTasks: _t, ...noTasks } = valid;
    expect(parseFirePack(JSON.stringify(noBuiltAt))).toBeNull();
    expect(parseFirePack(JSON.stringify(noTasks))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, builtAt: 'x' }))).toBeNull();
  });

  it('lastUserMessageAt 数字也合法', () => {
    expect(parseFirePack(JSON.stringify({ ...valid, lastUserMessageAt: 123 }))?.lastUserMessageAt).toBe(123);
  });

  it('tzId 必填：缺失 / 空串 / 非字符串整包打回（渲染时间没有第二套算法可退）', () => {
    expect(parseFirePack(JSON.stringify({ ...valid, tzId: 'Asia/Tokyo' }))?.tzId).toBe('Asia/Tokyo');
    const { tzId: _tz, ...noTzId } = valid;
    expect(parseFirePack(JSON.stringify(noTzId))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, tzId: '' }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, tzId: 42 }))).toBeNull();
  });

  it('userTzId 同样必填（缺了就没法说「对方那边现在几点」）', () => {
    const { userTzId: _u, ...noUserTz } = valid;
    expect(parseFirePack(JSON.stringify(noUserTz))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, userTzId: '' }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, userTzId: 'America/New_York' }))?.userTzId)
      .toBe('America/New_York');
  });

  it('坏形状 → null（worker 借此抛 fire-state 错）', () => {
    expect(parseFirePack('not json')).toBeNull();
    expect(parseFirePack('{}')).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, v: 1 }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, template: '' }))).toBeNull();
  });
});

// 回归守卫：主动消息的多轮连续性全靠这份自述日志。它一旦失效，用户离线期间连着触发两次，
// 角色第二次看到的上下文跟第一次逐字一样，只会把同一句话换个说法再发一遍——而且没有任何
// 报错，静默退化成「单轮」。下面每条都对着一种具体的退化方式。
describe('self_log', () => {
  const packAt = 1_700_000_000_000;
  const pack: AmsgFirePack = {
    v: FIRE_PACK_VERSION, template: 'x', lastUserMessageAt: null, tzId: 'UTC', userTzId: 'UTC', targetName: '小明同学',
    builtAt: packAt, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  };
  const entry = (id: string, text: string, at = packAt) => ({ id, at, text });

  describe('appendSelfLogEntry', () => {
    it('同 id 覆盖，fire 重跑不会把一条消息记成好几条', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, entry('t1@100', '在干嘛呢'));
      log = appendSelfLogEntry(log, entry('t1@100', '在干嘛呢'));
      expect(log.entries).toHaveLength(1);
    });

    it('不同触发各记一条，按追加顺序排', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, entry('t1@100', '第一条'));
      log = appendSelfLogEntry(log, entry('t1@200', '第二条'));
      expect(log.entries.map((e) => e.text)).toEqual(['第一条', '第二条']);
    });

    it('只留最近 SELF_LOG_MAX_ENTRIES 条，老的挤掉', () => {
      let log = createSelfLog(packAt);
      for (let i = 0; i < SELF_LOG_MAX_ENTRIES + 3; i += 1) {
        log = appendSelfLogEntry(log, entry(`t1@${i}`, `第 ${i} 条`));
      }
      expect(log.entries).toHaveLength(SELF_LOG_MAX_ENTRIES);
      expect(log.entries[0].text).toBe('第 3 条');
    });

    it('超长正文截断', () => {
      const log = appendSelfLogEntry(createSelfLog(packAt), entry('t1@1', 'あ'.repeat(500)));
      expect(log.entries[0].text).toHaveLength(SELF_LOG_TEXT_MAX);
    });

    it('空正文原样返回（调用方据此跳过一次写库）', () => {
      const before = createSelfLog(packAt);
      expect(appendSelfLogEntry(before, entry('t1@1', '   \n '))).toBe(before);
    });
  });

  // 回归守卫（炸屏事故的根）：连发计数以前挂在 basePackAt 上，客户端每认领一条推送就
  // 重传一次 fire_pack，计数被自己发的消息洗回零——在线时连排提醒永远不出现。
  // entries 只认「用户开口了」；tasks 只在同 UUID 已进入客户端 pendingTasks 后去重。
  describe('reconcileSelfLogWithPack', () => {
    const task = (uuid: string) => ({
      taskUuid: uuid, clientTaskId: `${uuid}-c`, mode: 'auto', firstSendTime: '2026-08-07T09:00:00.000Z',
      recurrenceType: 'none', expirePolicy: 'expire', source: 'character', status: 'scheduled', createdAt: packAt,
    } as AmsgSelfLog['tasks'][number]);

    const seeded = (): AmsgSelfLog => {
      let log = createSelfLog(packAt, 500);
      log = appendSelfLogEntry(log, entry('t1@1', '第一条'));
      log = appendSelfLogEntry(log, entry('t1@2', '第二条'));
      return { ...log, tasks: [task('u1')] };
    };

    it('没有日志 → 从空的建一份，锚定当前的 lastUserMessageAt', () => {
      const log = reconcileSelfLogWithPack(null, pack, 500);
      expect(log.entries).toHaveLength(0);
      expect(log.tasks).toHaveLength(0);
      expect(log.basePackAt).toBe(packAt);
      expect(log.anchorUserMsgAt).toBe(500);
    });

    it('fire_pack 换代但没有逐项认领证明 → tasks 和 entries 原样保留', () => {
      const log = reconcileSelfLogWithPack(seeded(), { ...pack, builtAt: packAt + 1 }, 500);
      expect(log.entries.map((e) => e.text)).toEqual(['第一条', '第二条']);
      expect(log.tasks).toHaveLength(1);
      expect(log.basePackAt).toBe(packAt + 1);
    });

    it('用户开口了（lastUserMessageAt 比锚新）→ 清 entries、锚前进，tasks 不动', () => {
      const log = reconcileSelfLogWithPack(seeded(), pack, 900);
      expect(log.entries).toHaveLength(0);
      expect(log.anchorUserMsgAt).toBe(900);
      expect(log.tasks).toHaveLength(1);
    });

    it('用户没有新发言（同锚 / 更旧 / null）→ entries 原样保留', () => {
      expect(reconcileSelfLogWithPack(seeded(), pack, 500).entries).toHaveLength(2);
      expect(reconcileSelfLogWithPack(seeded(), pack, 400).entries).toHaveLength(2);
      expect(reconcileSelfLogWithPack(seeded(), pack, null).entries).toHaveLength(2);
    });

    it('换代与用户开口同时发生 → 只清 entries，未认领任务仍保留', () => {
      const log = reconcileSelfLogWithPack(seeded(), { ...pack, builtAt: packAt + 1 }, 900);
      expect(log.entries).toHaveLength(0);
      expect(log.tasks).toHaveLength(1);
    });
  });

  describe('countUnansweredSends（连发上限的计数口径）', () => {
    it('只数主动发出的条目，即时对话的回复（reply 标记）不算连发', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, { id: 'r@1', at: packAt, text: '嗯嗯我在', reply: true });
      log = appendSelfLogEntry(log, entry('t1@2', '主动第一条'));
      log = appendSelfLogEntry(log, entry('t1@3', '主动第二条'));
      expect(countUnansweredSends(log)).toBe(2);
      expect(countUnansweredSends(createSelfLog(packAt))).toBe(0);
      expect(countUnansweredSends(null)).toBe(0);
    });

    // 回归守卫：计数以前是数 entries 数出来的，而 entries 只留最近 SELF_LOG_MAX_ENTRIES
    // （8）条——计数因此永远不会超过 8，用户把连发上限设成 9 或 10 时，到点兜底闸的
    // 「计数 >= 上限」恒为 false，那道闸整个失效（等于「不限」）。
    it('连发条数不被 entries 上限压平：发 10 条就数到 10（上限设 9 / 10 时闸才拦得住）', () => {
      let log = createSelfLog(packAt);
      for (let i = 0; i < 10; i += 1) {
        log = appendSelfLogEntry(log, entry(`t1@${i}`, `第 ${i + 1} 条`));
      }
      expect(log.entries).toHaveLength(SELF_LOG_MAX_ENTRIES);   // 前提：entries 确实被削过
      expect(countUnansweredSends(log)).toBe(10);
    });

    it('同一次触发重跑（同 id 再追加一次）不多记一条连发', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, entry('t1@100', '在干嘛呢'));
      log = appendSelfLogEntry(log, entry('t1@100', '在干嘛呢'));
      expect(countUnansweredSends(log)).toBe(1);
    });

    it('用户开口 → 连发条数跟 entries 一起归零', () => {
      let log = createSelfLog(packAt, 500);
      for (let i = 0; i < 10; i += 1) log = appendSelfLogEntry(log, entry(`t1@${i}`, `第 ${i} 条`));
      const after = reconcileSelfLogWithPack(log, pack, 900);
      expect(after.entries).toHaveLength(0);
      expect(countUnansweredSends(after)).toBe(0);
    });

    it('fire_pack 换代（客户端认领重传）不清连发条数', () => {
      let log = createSelfLog(packAt, 500);
      for (let i = 0; i < 10; i += 1) log = appendSelfLogEntry(log, entry(`t1@${i}`, `第 ${i} 条`));
      expect(countUnansweredSends(reconcileSelfLogWithPack(log, { ...pack, builtAt: packAt + 1 }, 500)))
        .toBe(10);
    });
  });

  describe('resolveMaxUnansweredSends（用户设置的连发上限）', () => {
    it('没设 → 默认值；0 → 不限（Infinity）；正整数原样；坏值回默认', () => {
      expect(resolveMaxUnansweredSends(undefined)).toBe(DEFAULT_MAX_UNANSWERED_SENDS);
      expect(resolveMaxUnansweredSends(0)).toBe(Infinity);
      expect(resolveMaxUnansweredSends(5)).toBe(5);
      expect(resolveMaxUnansweredSends(-2)).toBe(DEFAULT_MAX_UNANSWERED_SENDS);
      expect(resolveMaxUnansweredSends(Number.NaN)).toBe(DEFAULT_MAX_UNANSWERED_SENDS);
      expect(resolveMaxUnansweredSends('3' as unknown)).toBe(DEFAULT_MAX_UNANSWERED_SENDS);
    });
  });

  describe('parseSelfLog', () => {
    it('合法 JSON 原样返回（含 reply 标记与锚）', () => {
      let log = createSelfLog(packAt, 500);
      log = appendSelfLogEntry(log, entry('t1@1', '喂'));
      log = appendSelfLogEntry(log, { id: 'r@2', at: packAt, text: '在的', reply: true });
      const parsed = parseSelfLog(JSON.stringify(log));
      expect(parsed).toEqual(log);
      expect(parsed?.anchorUserMsgAt).toBe(500);
      expect(parsed?.entries[1].reply).toBe(true);
    });

    it('坏形状 / 旧版本 → null（调用方当没有、从空的重新攒）', () => {
      expect(parseSelfLog('')).toBeNull();
      expect(parseSelfLog('not json')).toBeNull();
      expect(parseSelfLog(JSON.stringify({ v: 2, basePackAt: packAt, entries: [], tasks: [] }))).toBeNull();
      expect(parseSelfLog(JSON.stringify({ v: 1, basePackAt: packAt }))).toBeNull();
      // v3（连发条数还数在 entries 里的那版）不认：读出来的计数会是错的，宁可从空的重攒
      expect(parseSelfLog(JSON.stringify({ v: 3, basePackAt: packAt, anchorUserMsgAt: null, entries: [], tasks: [] }))).toBeNull();
      // 缺连发计数字段的一样不认（少了它计数会静默从 0 开始，闸又白装了）
      expect(parseSelfLog(JSON.stringify({ v: 4, basePackAt: packAt, anchorUserMsgAt: null, entries: [], tasks: [] }))).toBeNull();
      expect(parseSelfLog(JSON.stringify({ v: 4, basePackAt: packAt, anchorUserMsgAt: null, entries: [{ id: 'a' }], unansweredSends: 0, tasks: [] }))).toBeNull();
    });
  });

  describe('renderFirePack 注入', () => {
    const slotted: AmsgFirePack = {
      ...pack,
      template: `【最近对话上下文】\n用户：在吗${AMSG_SLOT_SELF_LOG}\n\n【本次任务】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    };

    it('有自述时接在对话上下文后面，正文原样出现、时间用相对口径', () => {
      let log = createSelfLog(packAt);
      log = appendSelfLogEntry(log, entry('t1@1', '刚看到楼下那只猫又来了', Date.UTC(2026, 6, 30, 21, 30)));
      const rendered = renderFirePack(slotted, Date.UTC(2026, 6, 30, 23, 0), '本次任务指令', { selfLog: log });

      expect(rendered).toContain('刚看到楼下那只猫又来了');
      expect(rendered).toContain('1小时前');
      // 位置：夹在对话上下文和本次任务之间，不能跑到任务指令后面去当新指令读。
      expect(rendered.indexOf('刚看到楼下那只猫又来了')).toBeGreaterThan(rendered.indexOf('用户：在吗'));
      expect(rendered.indexOf('刚看到楼下那只猫又来了')).toBeLessThan(rendered.indexOf('本次任务指令'));
      expect(rendered).not.toContain('{{');
    });

    it('没有自述时槽位被抹平，输出与没有这回事时一致', () => {
      const now = Date.UTC(2026, 6, 30, 23, 0);
      const plain: AmsgFirePack = {
        ...pack,
        template: '【最近对话上下文】\n用户：在吗\n\n【本次任务】\n' + AMSG_SLOT_TASK_INSTRUCTION,
      };
      expect(renderFirePack(slotted, now, '本次任务指令', { selfLog: createSelfLog(packAt) }))
        .toBe(renderFirePack(plain, now, '本次任务指令'));
      expect(renderFirePack(slotted, now, '本次任务指令')).not.toContain('{{');
    });

    it('模板里没有这个槽位时不报错（只是那段无处可去）', () => {
      const legacy: AmsgFirePack = { ...pack, template: `头部\n${AMSG_SLOT_TASK_INSTRUCTION}` };
      const log = appendSelfLogEntry(createSelfLog(packAt), entry('t1@1', '喂'));
      expect(renderFirePack(legacy, Date.UTC(2026, 6, 30), '指令', { selfLog: log })).toBe('头部\n指令');
    });
  });

  // 即时回复结束后、客户端还没把聊天记录传上来的那段时间里，下一条定时消息只能从这里
  // 读到角色刚说过什么。回复挂在「对方还没回」的标题下、或者被截到两百字，角色就接不上话。
  describe('即时回复的条目', () => {
    const now = Date.UTC(2026, 6, 30, 23, 0);
    const reply = (text: string, at = now - 2 * 60_000) => ({ ...entry('instant@1', text, at), reply: true });

    it('回复单独一个标题，不跟「对方还没回」的主动消息混在一起', () => {
      const log = appendSelfLogEntry(createSelfLog(packAt), reply('好，那我八点叫你'));
      const block = renderSelfLogBlock(log, now, { tzId: 'UTC' });
      expect(block).toContain('【这之后你回了对方】');
      expect(block).toContain('2分钟前　好，那我八点叫你');
      expect(block).not.toContain('对方还没回');
    });

    it('回复之后又主动发过 → 两段各说各的，连发计数只挂在主动那段', () => {
      let log = appendSelfLogEntry(createSelfLog(packAt), reply('好，那我八点叫你', now - 30 * 60_000));
      log = appendSelfLogEntry(log, entry('t1@1', '起床啦', now - 3 * 60_000));
      const block = renderSelfLogBlock(log, now, { tzId: 'UTC' });
      expect(block.indexOf('【这之后你回了对方】')).toBeLessThan(block.indexOf('【这之后你又发过（对方还没回）】'));
      expect(block).toContain('已连着主动找了对方 1 次');
    });

    it('回复留够长度：超过主动消息那条两百字的线也不截', () => {
      const long = '长'.repeat(SELF_LOG_TEXT_MAX + 300);
      const log = appendSelfLogEntry(createSelfLog(packAt), reply(long));
      expect(log.entries[0].text).toHaveLength(SELF_LOG_TEXT_MAX + 300);
      // 主动消息照旧按两百字截。
      const proactive = appendSelfLogEntry(createSelfLog(packAt), entry('t1@1', long));
      expect(proactive.entries[0].text).toHaveLength(SELF_LOG_TEXT_MAX);
    });
  });

  describe('「你们此刻正聊着」那一行', () => {
    const now = Date.UTC(2026, 6, 30, 23, 0);
    const live: AmsgFirePack = {
      ...pack,
      template: `【开口之前】\n先对照上面的对话。${AMSG_SLOT_LIVE_CHAT}\n默认是说。`,
    };

    it('对方刚说过话 → 写明正聊着；过了十分钟这一行连带消失', () => {
      expect(renderFirePack({ ...live, lastUserMessageAt: now - 3 * 60_000 }, now, '指令'))
        .toContain('先对照上面的对话。\n你们此刻正聊着：小明同学3 分钟前还在跟你说话。\n默认是说。');
      expect(renderFirePack({ ...live, lastUserMessageAt: now - 20_000 }, now, '指令')).toContain('小明同学刚刚还在跟你说话');
      expect(renderFirePack({ ...live, lastUserMessageAt: now - 11 * 60_000 }, now, '指令'))
        .toBe('【开口之前】\n先对照上面的对话。\n默认是说。');
      expect(renderFirePack({ ...live, lastUserMessageAt: null }, now, '指令')).not.toContain('正聊着');
    });

    it('调用方给了更新的开口时刻（包还没传完）→ 按新的那份算', () => {
      const stale = { ...live, lastUserMessageAt: now - 30 * 60_000 };
      expect(renderFirePack(stale, now, '指令')).not.toContain('正聊着');
      expect(renderFirePack(stale, now, '指令', { lastUserMessageAt: now - 60_000 })).toContain('1 分钟前还在跟你说话');
    });
  });

  it('renderSelfLogBlock 空日志返回空串', () => {
    const now = Date.UTC(2026, 6, 30, 23, 0);
    expect(renderSelfLogBlock(null, now, { tzId: 'UTC' })).toBe('');
    expect(renderSelfLogBlock(createSelfLog(packAt), now, { tzId: 'UTC' })).toBe('');
  });

  it('renderSelfLogBlock 时间口径：一天内相对（分钟/小时前），更久回绝对时刻并按 pack 时区换算', () => {
    const now = Date.UTC(2026, 6, 31, 14, 0);
    let log = createSelfLog(packAt);
    log = appendSelfLogEntry(log, entry('t1@1', '前天说的', Date.UTC(2026, 6, 29, 14, 0)));
    log = appendSelfLogEntry(log, entry('t1@2', '三分钟前说的', now - 3 * 60_000));

    const sh = renderSelfLogBlock(log, now, { tzId: 'Asia/Shanghai' });
    expect(sh).toContain('3分钟前');
    expect(sh).toContain('7月29日 22:00');   // UTC+8 的绝对时刻
    expect(renderSelfLogBlock(log, now, { tzId: 'UTC' })).toContain('7月29日 14:00');
  });

  // ② 的回归守卫：同一个 pack 渲染出来的当前时间 / 自述绝对时间戳必须落在同一参照系。
  // 旧实现里当前时间和别处各写各的换算，参照系一混角色就会算错「几小时前」。
  // 一天内的条目现在渲染相对时间（与参照系无关），所以拿一条超过一天的老条目守这条线。
  it('同一个 pack 里当前时间与自述绝对时间戳同参照系（tzId 一把尺）', () => {
    const slotted: AmsgFirePack = {
      ...pack,
      tzId: 'Asia/Tokyo',
      template: `当前 ${AMSG_SLOT_CURRENT_TIME}${AMSG_SLOT_SELF_LOG}\n【本次任务】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    };
    const at = Date.UTC(2026, 6, 28, 13, 0);       // 东京 7月28日 22:00
    const now = Date.UTC(2026, 6, 30, 14, 0);      // 东京 7月30日 23:00
    const log = appendSelfLogEntry(createSelfLog(packAt), entry('t1@1', '睡了', at));
    const rendered = renderFirePack(slotted, now, '指令', { selfLog: log });
    expect(rendered).toContain('2026年7月30日 周四 深夜 23:00');
    expect(rendered).toContain('7月28日 22:00');
  });
});

// ④ 连发提醒：计数/上限就长在自述块里——模型看到的是「几分钟前发过什么」这个频率本身，
// 而不是一句抽象的「第 x 条」。计数随 reconcileSelfLogWithPack 只在用户开口时清零，
// 在线认领推送不再冲掉它（炸屏事故里提醒正是被这条回路洗没的）。
describe('连发提醒（自述块内的计数与上限）', () => {
  const packAt = 1_700_000_000_000;
  const slotted: AmsgFirePack = {
    v: FIRE_PACK_VERSION, lastUserMessageAt: null, tzId: 'UTC', userTzId: 'UTC', targetName: '小明同学',
    builtAt: packAt, pendingTasks: [], scene: null, selfScheduleEnabled: true,
    template: `【最近对话上下文】\n用户：在吗${AMSG_SLOT_SELF_LOG}\n\n【本次任务】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
  };
  const entry = (id: string, text: string) => ({ id, at: packAt, text });

  it('有未回应连发时，块里写明已连发几条、上限几条（默认上限）', () => {
    let log = createSelfLog(packAt);
    log = appendSelfLogEntry(log, entry('t1@1', '第一条'));
    log = appendSelfLogEntry(log, entry('t1@2', '第二条'));
    const rendered = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log });
    expect(rendered).toContain('连着主动找了对方 2 次');
    expect(rendered).toContain(`上限 ${DEFAULT_MAX_UNANSWERED_SENDS} 次`);
  });

  it('按传进来的用户上限渲染；不限（Infinity）不渲染上限半句', () => {
    let log = createSelfLog(packAt);
    log = appendSelfLogEntry(log, entry('t1@1', '第一条'));
    const custom = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log, maxUnansweredSends: 8 });
    expect(custom).toContain('上限 8 次');
    const unlimited = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log, maxUnansweredSends: Infinity });
    expect(unlimited).toContain('连着主动找了对方 1 次');
    expect(unlimited).not.toContain('上限');
  });

  // 回归守卫：到上限之后自排的后续是跳过、不补发。以前写成「会暂停、等对方回复才恢复」，
  // 角色读了以为排着的话迟早会说出去，照样对用户许诺。
  it('上限说明讲的是「跳过、不补发」，不是「暂停后恢复」', () => {
    let log = createSelfLog(packAt);
    log = appendSelfLogEntry(log, entry('t1@1', '第一条'));
    const rendered = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log, maxUnansweredSends: 3 });
    expect(rendered).toContain('跳过、不补发');
    expect(rendered).not.toContain('暂停');
  });

  it('只有即时回复（reply 条目）→ 列出但不算连发，不出现计数行', () => {
    const log = appendSelfLogEntry(createSelfLog(packAt), { id: 'r@1', at: packAt + 1000, text: '嗯我在', reply: true });
    const rendered = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log });
    expect(rendered).toContain('嗯我在');
    expect(rendered).not.toContain('连着主动找了对方');
  });

  it('已进转写的条目（at ≤ basePackAt）不再重复渲染正文，但计数保留', () => {
    let log = createSelfLog(packAt);
    log = appendSelfLogEntry(log, { id: 's@1', at: packAt - 1000, text: '已在转写里的那条' });
    log = appendSelfLogEntry(log, { id: 's@2', at: packAt + 1000, text: '转写之后新发的' });
    const rendered = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log });
    expect(rendered).not.toContain('已在转写里的那条');
    expect(rendered).toContain('转写之后新发的');
    expect(rendered).toContain('连着主动找了对方 2 次');
  });

  it('不再往【本次任务】前面插旧版 streak 提醒行', () => {
    let log = createSelfLog(packAt);
    for (let i = 0; i < 4; i += 1) log = appendSelfLogEntry(log, entry(`t1@${i}`, `第${i}条`));
    const rendered = renderFirePack(slotted, packAt + 60_000, '指令', { selfLog: log });
    expect(rendered).not.toContain('条主动消息。请注意边界');
    expect(rendered).toContain('指令');
  });
});

// ⑤⑥ 的 last_skip 新原因：空生成 / 过期不补发。parse 认、describe 有对应人话。
describe('last_skip 新原因', () => {
  const base = { v: 1 as const, taskUuid: null, occurrenceMs: 1_700_000_000_000, skippedAt: 1_700_000_100_000 };
  const fmt = (ms: number) => `T${ms}`;

  it('parseLastSkip 认 empty-generation / stale / unanswered-limit', () => {
    expect(parseLastSkip(JSON.stringify({ ...base, reason: 'empty-generation' }))?.reason).toBe('empty-generation');
    expect(parseLastSkip(JSON.stringify({ ...base, reason: 'stale' }))?.reason).toBe('stale');
    expect(parseLastSkip(JSON.stringify({ ...base, reason: 'unanswered-limit' }))?.reason).toBe('unanswered-limit');
    expect(parseLastSkip(JSON.stringify({ ...base, reason: 'nonsense' }))).toBeNull();
  });

  it('describeLastSkip 对每个原因都有人话（面板一行说明）', () => {
    expect(describeLastSkip({ ...base, reason: 'empty-generation' }, fmt)).toContain('没写出要说的话');
    expect(describeLastSkip({ ...base, reason: 'stale' }, fmt)).toContain('过去太久');
    expect(describeLastSkip({ ...base, reason: 'declined' }, fmt)).toContain('不用再说');
    expect(describeLastSkip({ ...base, reason: 'unanswered-limit' }, fmt)).toContain('连发上限');
  });

  // 被连发上限拦下的那一次是**真的跳过了**：上游把 { skip: true } 当成功消费，一次性
  // 任务的行当场就删了，循环任务也只是快进到下一次，都不会把这一条补回来。文案要是说
  // 「等你回复后恢复」，用户就会一直等一条永远不会来的消息（角色在正文里承诺过的
  // 「等下再来找你」也跟着蒸发）。
  it('连发上限那次说清「不会补发」，不许承诺恢复', () => {
    const text = describeLastSkip({ ...base, reason: 'unanswered-limit' }, fmt);
    expect(text).toContain('不会补发');
    expect(text).not.toContain('等你回复后恢复');
  });
});

describe('fire_pack 任务指令槽', () => {
  const pack: AmsgFirePack = {
    v: FIRE_PACK_VERSION,
    template: `头部\n${AMSG_SLOT_TASK_INSTRUCTION}\n尾部 ${AMSG_SLOT_CURRENT_TIME}`,
    lastUserMessageAt: null, tzId: 'Asia/Shanghai', userTzId: 'Asia/Shanghai', targetName: '小明同学',
    builtAt: 1_700_000_000_000, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  };

  it('renderFirePack 用传入的任务指令填槽', () => {
    const out = renderFirePack(pack, Date.UTC(2026, 6, 21, 1, 0), '围绕"问考试"发起私聊');
    expect(out).toContain('围绕"问考试"发起私聊');
    expect(out).not.toContain(AMSG_SLOT_TASK_INSTRUCTION);
  });

  it('只认当前版本号，对不上的整包 parse 失败（worker 抛 fire-state 错）', () => {
    expect(parseFirePack(JSON.stringify(pack))).not.toBeNull();
    expect(parseFirePack(JSON.stringify({ ...pack, v: 3 }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...pack, v: 1 }))).toBeNull();
  });
});

describe('client_state 值压缩', () => {
  // fire_pack 有几万字，随手编一小段压不出效果也测不出真问题，拿重复的中文段落凑量。
  const bigJson = JSON.stringify({
    v: FIRE_PACK_VERSION,
    template: '【角色系统设定】你是一个会在深夜突然想起对方的人。\n'.repeat(400),
    lastUserMessageAt: 1_700_000_000_000,
    tzId: 'Asia/Shanghai',
    userTzId: 'Asia/Shanghai',
    targetName: '小明',
    builtAt: 1_700_000_000_000,
    pendingTasks: [],
    scene: null,
    selfScheduleEnabled: true,
  });

  it('压完再解回来，一个字都不差', async () => {
    const packed = await packStateValue(bigJson);
    expect(packed.startsWith('gz1:')).toBe(true);
    expect(await unpackStateValue(packed)).toBe(bigJson);
  });

  it('压完确实变小了（不然这整套机制没有意义）', async () => {
    const packed = await packStateValue(bigJson);
    expect(packed.length).toBeLessThan(bigJson.length / 2);
  });

  // 内容太短时 packStateValue 会原样返回（压完更大），读侧必须认得这种没前缀的值。
  it('压完反而更大的短内容保持原样，读回来也认', async () => {
    const tiny = '{"v":2}';
    expect(await packStateValue(tiny)).toBe(tiny);
    expect(await unpackStateValue(tiny)).toBe(tiny);
  });

  // 回归守卫：上面那份 repeat 出来的样本压缩率 20 倍以上，怎么比都划算，测不出口径错误。
  // 真实 fire_pack 是中文散文，压缩率只有 2~3 倍，恰好落在「按字符数比不划算、按字节比
  // 划算」的缺口里——线上就是这么一份都没压成的：13977 字节的提示词压完 base64 约 7000
  // 字符，拿它跟原文 5849 个**字符**比，7000 > 5849 判定「压完更大」直接放弃，而实际
  // 字节数是 7000 < 13977，省了一半。
  //
  // 下面这段用固定序列从常用字里取，压缩率 2.8 倍，跟真实提示词一个量级。
  it('中文按字节算划算就要压（不能拿字符数比）', async () => {
    const CHARS = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感';
    const prose = Array.from(
      { length: 400 },
      (_, i) => CHARS[(i * 37 + (i >> 4) * 11) % CHARS.length],
    ).join('');
    const rawBytes = new TextEncoder().encode(prose).length;
    // 前提：这段内容按字符数比是「不划算」的，正是旧口径会放弃的那一类。
    expect(rawBytes).toBeGreaterThan(prose.length * 2);

    const packed = await packStateValue(prose);
    expect(packed.startsWith('gz1:'), '按字节算划算就该压').toBe(true);
    expect(packed.length).toBeLessThan(rawBytes);
    expect(packed.length).toBeGreaterThan(prose.length); // 按字符数比反而更长
    expect(await unpackStateValue(packed)).toBe(prose);
  });

  it('压过的值解出来还能正常 parse 成 fire_pack', async () => {
    const packed = await packStateValue(bigJson);
    const pack = parseFirePack(await unpackStateValue(packed));
    expect(pack?.targetName).toBe('小明');
    expect(pack?.tzId).toBe('Asia/Shanghai');
  });

  it('数据损坏时解压抛错，不会把半截内容当正常值放过去', async () => {
    await expect(unpackStateValue('gz1:bm90LWd6aXAtYXQtYWxs')).rejects.toThrow();
  });
});

// 回归守卫：升 fire_pack 版本要 worker bundle 和前端一起动，而设置页的版本门槛读的是
// **上游 amsg-server 库**的版本号——只改 SullyOS 自己那份 worker 代码时那个号不动，门槛不亮。
// 用户忘了重贴 bundle 时，唯一能看到的线索就是面板上的 lastError，所以这句话得说清该做什么。
// 注意这里钉的是「说明白」，不是「兼容」：版本对不上照样整包打回。
describe('fire_pack 版本对不上时说清该做什么', () => {
  const pack = (v: unknown) => JSON.stringify({
    v, template: 'x', lastUserMessageAt: null, tzId: 'UTC', userTzId: 'UTC', targetName: 'A',
    builtAt: 1, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  });

  it('旧包（worker 新、前端旧）→ 让用户打开一次网页重传', () => {
    expect(parseFirePack(pack(FIRE_PACK_VERSION - 1))).toBeNull();
    expect(describeFirePackVersion(pack(FIRE_PACK_VERSION - 1))).toContain('前端比 worker 旧');
  });

  it('新包（前端新、worker 旧）→ 让用户去重新粘贴部署', () => {
    expect(parseFirePack(pack(FIRE_PACK_VERSION + 1))).toBeNull();
    expect(describeFirePackVersion(pack(FIRE_PACK_VERSION + 1))).toContain('重新粘贴部署');
  });

  it('版本号对得上但别的字段坏了 → 不甩锅给部署', () => {
    const reason = describeFirePackVersion(pack(FIRE_PACK_VERSION));
    expect(reason).toContain('数据损坏');
    expect(reason).not.toContain('粘贴');
  });

  it('压根不是 JSON / 没版本号', () => {
    expect(describeFirePackVersion('not json')).toContain('不是合法 JSON');
    expect(describeFirePackVersion('{}')).toContain('没有版本号');
  });
});

// ─── v7：即时对话的 chat 段 ───
//
// 开发期规矩：版本对不上整包打回，不做任何形状兼容。v6 的包被放行的话，标了即时对话
// 的任务会拿不到 chat 段——而那时 worker 已经走过版本门，只能一路跑到「用主动消息模板
// 答用户刚说的话」，出来的东西驴唇不对马嘴且没有报错。
describe('fire_pack v7 的 chat 段', () => {
  const base: AmsgFirePack = {
    v: FIRE_PACK_VERSION, template: 'x', lastUserMessageAt: null,
    tzId: 'Asia/Shanghai', userTzId: 'Asia/Shanghai', targetName: '小明',
    builtAt: 1_700_000_000_000, pendingTasks: [], scene: null, selfScheduleEnabled: true,
  };
  const chat = { messages: [{ role: 'user', content: '在吗' }], builtAt: 1_700_000_000_000 };

  it('当前版本号是 7（升版要前端和 worker 一起动）', () => {
    expect(FIRE_PACK_VERSION).toBe(7);
  });

  it('v6 的包直接拒（不做旧格式兼容）', () => {
    expect(parseFirePack(JSON.stringify({ ...base, v: 6 }))).toBeNull();
    expect(describeFirePackVersion(JSON.stringify({ ...base, v: 6 })))
      .toContain('前端比 worker 旧');
  });

  it('不带 chat 段照样合法（没开即时对话的角色就是这样）', () => {
    expect(parseFirePack(JSON.stringify(base))).toEqual(base);
  });

  it('带了 chat 段就原样返回', () => {
    const withChat = { ...base, chat };
    expect(parseFirePack(JSON.stringify(withChat))).toEqual(withChat);
  });

  it('chat 段形状不对 → 整包打回（半份对话消息比没有更糟）', () => {
    const bad = (value: unknown) => parseFirePack(JSON.stringify({ ...base, chat: value }));
    expect(bad(null)).toBeNull();
    expect(bad({ messages: [], builtAt: 1 })).toBeNull();                     // 空数组
    expect(bad({ messages: [{ role: 'user' }], builtAt: 1 })).toBeNull();     // 缺 content
    expect(bad({ messages: [{ content: '在吗' }], builtAt: 1 })).toBeNull();  // 缺 role
    expect(bad({ messages: chat.messages })).toBeNull();                      // 缺 builtAt
    expect(bad({ messages: chat.messages, builtAt: 'x' })).toBeNull();
  });

  // 带图片的消息本地就是结构化分段，云端这条路要原样送到模型面前——parse 认不了
  // 这种形状的话，整包被打回、fire 硬失败，用户看到的是「一直在输入」。
  it('结构化分段的 content 照收（图片消息本地就长这样）', () => {
    const structured = {
      ...base,
      chat: {
        builtAt: 1_700_000_000_000,
        messages: [
          { role: 'user', content: [
            { type: 'text', text: '08:00 [User sent an image]' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ] },
          { role: 'assistant', content: '好可爱' },   // 同一串里混着纯文本也行
        ],
      },
    };
    expect(parseFirePack(JSON.stringify(structured))).toEqual(structured);
  });

  it('分段只查到 type 为止（图片那套方言归 chat API 管，这层只负责搬）', () => {
    const withOddPart = {
      ...base,
      chat: {
        builtAt: 1,
        messages: [{ role: 'user', content: [{ type: '将来才有的新分段', 随便什么字段: 1 }] }],
      },
    };
    expect(parseFirePack(JSON.stringify(withOddPart))).toEqual(withOddPart);
  });

  it('分段数组本身不合格 → 整包打回', () => {
    const bad = (content: unknown) => parseFirePack(JSON.stringify({
      ...base, chat: { builtAt: 1, messages: [{ role: 'user', content }] },
    }));
    expect(bad([])).toBeNull();                          // 空数组 = 没内容
    expect(bad([{ text: '缺 type' }])).toBeNull();
    expect(bad([{ type: 123 }])).toBeNull();             // type 不是字符串
    expect(bad(['纯字符串分段'])).toBeNull();
    expect(bad([null])).toBeNull();
    expect(bad([[{ type: 'text' }]])).toBeNull();        // 嵌套数组不算分段对象
    expect(bad(42)).toBeNull();
  });
});

// 「此刻在做什么」那一段的钟点跟着角色的「时间感知」开关走。开关的值 worker 从
// tool_pack.timeAwarenessEnabled 读（与今日节日同源），经 renderFirePack 透传到
// renderFireSceneBlock。断的是「透传」这一环：渲染本身在 amsgFireScene.test.ts 里钉过。
describe('renderFirePack — 把 includeClock 透传给场景块', () => {
  const scenePack: AmsgFirePack = {
    v: FIRE_PACK_VERSION,
    builtAt: 1_700_000_000_000,
    pendingTasks: [],
    selfScheduleEnabled: true,
    template: AMSG_SLOT_SCENE,
    lastUserMessageAt: null,
    tzId: 'Asia/Shanghai',
    userTzId: 'Asia/Shanghai',
    targetName: '小明同学',
    scene: {
      charId: 'char-clock',
      dateKey: '2026-08-02',
      schedule: {
        slots: [
          { startTime: '08:00', activity: '起床做早饭' },
          { startTime: '22:00', activity: '睡觉' },
        ],
      },
      songPool: [],
    },
  } as AmsgFirePack;

  /** 2026-08-02 上海 23:10。 */
  const at = Date.UTC(2026, 7, 2, 23 - 8, 10);

  it('不传时照常报钟点（老行为）', () => {
    expect(renderFirePack(scenePack, at, '指令')).toContain('当前时段：22:00 你正在睡觉');
  });

  it('includeClock=false 时钟点消失，活动还在', () => {
    const out = renderFirePack(scenePack, at, '指令', { includeClock: false });
    expect(out).toContain('你正在睡觉');
    expect(out).not.toContain('22:00');
  });
});

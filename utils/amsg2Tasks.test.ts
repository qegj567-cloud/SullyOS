// utils/amsg2Tasks.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  REPLACE_CANCEL_FAILED_NOTE,
  applyRemoteTaskDelta,
  applyScheduledTask,
  AMSG2_SCHEDULE_SECRECY_NOTE,
  buildFireTaskListBlock,
  currentOccurrenceMs,
  describeInstantChatFailure,
  describeRemoteLastError,
  describeTaskFailureCause,
  describeTaskProgress,
  findTaskByShortId,
  getPendingTasks,
  hasActiveAiTask,
  isPendingTask,
  isRemoteMissingTask,
  keepUncancelledTasks,
  parseRemoteTaskLastError,
  pruneFiredTasks,
  REMOTE_ERROR_REASON_MAX,
  pruneStaleTasks,
  reconcileTasksWithRemote,
  shortTaskId,
  toDatetimeLocalValue,
} from './amsg2Tasks';
import type { ActiveMsg2TaskRecord } from '../types';

const H = 3600_000;
const task = (extra: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
  clientTaskId: 'cid-aabb',
  mode: 'auto', firstSendTime: new Date(Date.now() + H).toISOString(),
  recurrenceType: 'none', expirePolicy: 'expire',
  source: 'character', status: 'scheduled', createdAt: Date.now(),
  ...extra,
});

describe('amsg2Tasks helpers', () => {
  it('shortTaskId 取 uuid 前 8 位；findTaskByShortId 按短 id 找', () => {
    const t = task();
    expect(shortTaskId(t.taskUuid)).toBe('aabbccdd');
    expect(findTaskByShortId([t], 'aabbccdd')).toBe(t);
    expect(findTaskByShortId([t], 'ffffffff')).toBeUndefined();
  });

  it('isPendingTask：未来一次性/循环任务算待触发，过点一次性不算', () => {
    const now = Date.now();
    expect(isPendingTask(task(), now)).toBe(true);
    expect(isPendingTask(task({ firstSendTime: new Date(now - H).toISOString() }), now)).toBe(false);
    expect(isPendingTask(task({ firstSendTime: new Date(now - H).toISOString(), recurrenceType: 'daily' }), now)).toBe(true);
  });

  it('pruneStaleTasks 清掉过点超过 48h 的一次性任务，循环任务保留', () => {
    const now = Date.now();
    const stale = task({ taskUuid: 'stale000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 49 * H).toISOString() });
    const recent = task({ taskUuid: 'recent00-0000-0000-0000-000000000000', firstSendTime: new Date(now - H).toISOString() });
    const daily = task({ taskUuid: 'daily000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 100 * H).toISOString(), recurrenceType: 'daily' });
    expect(pruneStaleTasks([stale, recent, daily], now).map((t) => shortTaskId(t.taskUuid)))
      .toEqual(['recent00', 'daily000']);
  });

  // 同步门（amsgStateSync）依赖 hasActiveAiTask：只要还有「待触发的非 fixed 任务」才同步 fire_pack。
  // 钉住这条，防止后续改动把它悄悄改死——静默分流杀主动消息是踩过的坑。
  it('getPendingTasks 只留待触发任务；hasActiveAiTask 排除 fixed，无待触发 AI 任务时为 false', () => {
    const now = Date.now();
    const ai = task();
    const fixed = task({ taskUuid: 'fixed000-0000-0000-0000-000000000000', mode: 'fixed' });
    const past = task({ taskUuid: 'past0000-0000-0000-0000-000000000000', firstSendTime: new Date(now - H).toISOString() });
    const config = { enabled: true, tasks: [ai, fixed, past] };
    expect(getPendingTasks(config, now).map((t) => shortTaskId(t.taskUuid))).toEqual(['aabbccdd', 'fixed000']);
    expect(hasActiveAiTask(config, now)).toBe(true);
    expect(hasActiveAiTask({ enabled: true, tasks: [fixed, past] }, now)).toBe(false);
    expect(hasActiveAiTask(undefined, now)).toBe(false);
  });
});

// 防坑：角色用工具建的任务 firstSendTime 是完整 ISO 8601，datetime-local 输入框只认
// 'YYYY-MM-DDTHH:mm'——不折算编辑角色任务时时间框会空白。断言全部与本机时区无关。
describe('toDatetimeLocalValue', () => {
  it('已是 datetime-local 格式 → 原样返回（跨时区恒成立）', () => {
    expect(toDatetimeLocalValue('2026-07-21T09:00')).toBe('2026-07-21T09:00');
  });
  it('完整 ISO（带 Z / 秒 / 毫秒）→ 折成 16 位 YYYY-MM-DDTHH:mm（无 Z 无秒）', () => {
    const out = toDatetimeLocalValue('2026-07-21T01:00:00.000Z');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(out).not.toContain('Z');
  });
  it('再折一次结果不变（幂等，防重复编辑时间漂移）', () => {
    const once = toDatetimeLocalValue('2026-07-21T01:00:00.000Z');
    expect(toDatetimeLocalValue(once)).toBe(once);
  });
  it('无法解析 / 空串 → 原样返回，不抛错', () => {
    expect(toDatetimeLocalValue('')).toBe('');
    expect(toDatetimeLocalValue('not-a-date')).toBe('not-a-date');
  });
});

// ─── 并清单 / 关闭时保留 —— 面板与角色工具共用的规则 ───
// 这两个函数的存在意义是「绝不留下本地看不见、远端却会触发的幽灵任务」，
// 所以每条都按这个标准钉：什么情况下记录必须留下来。

describe('applyScheduledTask', () => {
  const A = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const B = task({ taskUuid: 'bbbbbbbb-0000-0000-0000-000000000000' });
  const fresh = task({ taskUuid: 'cccccccc-0000-0000-0000-000000000000' });

  it('纯新建：并到清单末尾，其它任务不动', () => {
    const out = applyScheduledTask([A, B], fresh, {}, Date.now());
    expect(out.map((t) => t.taskUuid)).toEqual([A.taskUuid, B.taskUuid, fresh.taskUuid]);
  });

  it('替换成功：旧记录移除，新记录进来', () => {
    const out = applyScheduledTask([A, B], fresh, { replaceTaskUuid: A.taskUuid }, Date.now());
    expect(out.map((t) => t.taskUuid)).toEqual([B.taskUuid, fresh.taskUuid]);
  });

  it('替换时远端取消失败：旧记录必须保留并标错（远端新旧并存，本地不能只剩新的）', () => {
    const out = applyScheduledTask(
      [A, B], fresh,
      { replaceTaskUuid: A.taskUuid, replacedCancelFailed: true },
      Date.now(),
    );
    expect(out.map((t) => t.taskUuid)).toEqual([A.taskUuid, B.taskUuid, fresh.taskUuid]);
    expect(out.find((t) => t.taskUuid === A.taskUuid)?.lastError).toBe(REPLACE_CANCEL_FAILED_NOTE);
    // 没被替换的那条不该被牵连打标
    expect(out.find((t) => t.taskUuid === B.taskUuid)?.lastError).toBeUndefined();
  });

  it('顺手清掉过点 48h 的一次性任务，但循环任务不清', () => {
    const stale = task({ taskUuid: 'dddddddd-0000-0000-0000-000000000000', firstSendTime: new Date(Date.now() - 72 * H).toISOString() });
    const oldDaily = task({ taskUuid: 'eeeeeeee-0000-0000-0000-000000000000', recurrenceType: 'daily', firstSendTime: new Date(Date.now() - 72 * H).toISOString() });
    const out = applyScheduledTask([stale, oldDaily], fresh, {}, Date.now());
    expect(out.map((t) => t.taskUuid)).toEqual([oldDaily.taskUuid, fresh.taskUuid]);
  });
});

describe('keepUncancelledTasks', () => {
  const notes = { failed: '取消失败', appeared: '关闭时新出现' };
  const A = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const B = task({ taskUuid: 'bbbbbbbb-0000-0000-0000-000000000000' });
  const C = task({ taskUuid: 'cccccccc-0000-0000-0000-000000000000' });

  it('全部取消成功 → 清单清空', () => {
    const attempted = new Set([A.taskUuid, B.taskUuid]);
    expect(keepUncancelledTasks([A, B], attempted, new Set(), notes)).toEqual([]);
  });

  it('取消失败的留下并标错（远端还活着，用户得能再试）', () => {
    const attempted = new Set([A.taskUuid, B.taskUuid]);
    const out = keepUncancelledTasks([A, B], attempted, new Set([B.taskUuid]), notes);
    expect(out.map((t) => t.taskUuid)).toEqual([B.taskUuid]);
    expect(out[0].lastError).toBe(notes.failed);
  });

  it('取消期间才出现的任务留下（压根没被尝试过，跟着清掉就成幽灵任务）', () => {
    // C 是关闭流程跑到一半时角色在聊天里刚排的，不在 attempted 里
    const attempted = new Set([A.taskUuid, B.taskUuid]);
    const out = keepUncancelledTasks([A, B, C], attempted, new Set(), notes);
    expect(out.map((t) => t.taskUuid)).toEqual([C.taskUuid]);
    expect(out[0].lastError).toBe(notes.appeared);
  });
});

// 回归守卫：面板打开时抓的远端底账是「那一刻」的快照，之后新建的任务当然不在里面。
// 曾经每建一条任务，卡片下面就立刻冒一行「⚠ 远端不存在」，关掉面板重开才消失——
// 第一次用的人会以为排程失败了。
describe('远端对账（applyRemoteTaskDelta / isRemoteMissingTask）', () => {
  const now = Date.now();
  const A = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const NEW = task({ taskUuid: 'nnnnnnnn-0000-0000-0000-000000000000' });

  it('新建成功后记进底账 → 不再误标「远端不存在」', () => {
    const opened = new Set([A.taskUuid]);            // 打开面板时远端只有 A
    expect(isRemoteMissingTask(NEW, opened, now)).toBe(true);   // 不记账就是这个错觉

    const after = applyRemoteTaskDelta(opened, { present: [NEW.taskUuid] });
    expect(isRemoteMissingTask(NEW, after, now)).toBe(false);
    expect(isRemoteMissingTask(A, after, now)).toBe(false);     // 别牵连原有任务
  });

  it('编辑 = 新建 + 取消旧的：新 uuid 进账、旧 uuid 出账', () => {
    const after = applyRemoteTaskDelta(new Set([A.taskUuid]), {
      present: [NEW.taskUuid],
      gone: [A.taskUuid],
    });
    expect(after).toEqual(new Set([NEW.taskUuid]));
  });

  it('替换时旧任务取消失败 → 旧 uuid 留在账上（远端新旧并存，别标成不存在）', () => {
    const after = applyRemoteTaskDelta(new Set([A.taskUuid]), { present: [NEW.taskUuid] });
    expect(isRemoteMissingTask(A, after, now)).toBe(false);
  });

  it('底账没拉到（null）→ 一直保持 null，整个徽标不显示', () => {
    expect(applyRemoteTaskDelta(null, { present: [NEW.taskUuid] })).toBeNull();
    expect(isRemoteMissingTask(A, null, now)).toBe(false);
  });

  it('已过点的一次性任务不标：它本来就该从远端消失', () => {
    const fired = task({
      taskUuid: 'ffffffff-0000-0000-0000-000000000000',
      firstSendTime: new Date(now - 24 * H).toISOString(),
    });
    expect(isRemoteMissingTask(fired, new Set(), now)).toBe(false);
  });

  it('待触发的任务确实从远端消失了 → 照标（这才是徽标存在的意义）', () => {
    expect(isRemoteMissingTask(A, new Set(), now)).toBe(true);
  });
});

// 回归守卫：循环任务的 firstSendTime 是「第一次」的锚点，可能在好几天前。
// 直接把它显示出来，一条每天的任务看着就像「过点了还没触发」——设置面板、角色查到的
// 清单、注入角色的排程现状块三处都栽在这上面，所以时间一律走 currentOccurrenceMs。
describe('currentOccurrenceMs（清单显示的「这一次」）', () => {
  const NOW = new Date('2026-07-26T14:00:00.000Z').getTime();
  const at = (iso: string) => new Date(iso).getTime();

  it('一次性任务恒为 firstSendTime，过没过点都一样', () => {
    const future = task({ firstSendTime: '2026-07-27T09:00:00.000Z' });
    const past = task({ firstSendTime: '2026-07-20T09:00:00.000Z' });
    expect(currentOccurrenceMs(future, NOW)).toBe(at('2026-07-27T09:00:00.000Z'));
    expect(currentOccurrenceMs(past, NOW)).toBe(at('2026-07-20T09:00:00.000Z'));
  });

  it('每天：几天前建的任务推到今天/明天的那一次，而不是原始锚点', () => {
    const daily = task({ recurrenceType: 'daily', firstSendTime: '2026-07-20T09:00:00.000Z' });
    // 今天 09:00 已经过了（现在 14:00），下一次是明天 09:00
    expect(currentOccurrenceMs(daily, NOW)).toBe(at('2026-07-27T09:00:00.000Z'));
  });

  it('每周：按 7 天推，跨月也不迭代', () => {
    const weekly = task({ recurrenceType: 'weekly', firstSendTime: '2026-05-04T09:00:00.000Z' });
    const next = currentOccurrenceMs(weekly, NOW)!;
    expect(next).toBeGreaterThan(NOW);
    expect((next - at('2026-05-04T09:00:00.000Z')) % (7 * 24 * H)).toBe(0);
  });

  it('时间串坏掉 → null（调用方退回原值显示，不抛错）', () => {
    expect(currentOccurrenceMs(task({ firstSendTime: '不是时间' }), NOW)).toBeNull();
  });
});

// 「已到点」这三个字对一次性任务等于没说——发过了还是卡住了，用户分不出来。
// 远端底账正好能分辨，这里钉住三档口径。
describe('describeTaskProgress', () => {
  const now = Date.now();
  const pending = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const fired = task({
    taskUuid: 'ffffffff-0000-0000-0000-000000000000',
    firstSendTime: new Date(now - 24 * H).toISOString(),
  });

  it('还没到点 → 待触发（底账有没有都一样）', () => {
    expect(describeTaskProgress(pending, new Set([pending.taskUuid]), now)).toBe('待触发');
    expect(describeTaskProgress(pending, null, now)).toBe('待触发');
  });

  it('过点了、远端那行还在 → cron 还没消费', () => {
    expect(describeTaskProgress(fired, new Set([fired.taskUuid]), now)).toBe('已到点·待处理');
  });

  it('过点了、远端已经没有 → worker 处理完了（发出去或被闸作废）', () => {
    expect(describeTaskProgress(fired, new Set(), now)).toBe('已触发');
  });

  it('底账没拉到 → 不猜，给中性文案', () => {
    expect(describeTaskProgress(fired, null, now)).toBe('已到点');
  });

  // 一次性任务重试用完会被标 'failed' 留在远端，永远不会再被消费——
  // 这时候还说「待处理」是骗人，它不会有下文了。
  it('远端那行还在但已是 failed 终态 → 发送失败，不再说「待处理」', () => {
    expect(describeTaskProgress(fired, new Set([fired.taskUuid]), now, 'failed')).toBe('发送失败');
    // 非终态的远端 status（pending 等）不改变原口径。
    expect(describeTaskProgress(fired, new Set([fired.taskUuid]), now, 'pending')).toBe('已到点·待处理');
  });

  it('云端后台任务处于暂停态（cronPaused=true）→ 未消费任务显示暂停态，已触发与发送失败保持原判', () => {
    expect(describeTaskProgress(pending, new Set([pending.taskUuid]), now, 'pending', true)).toBe('后台已暂停');
    expect(describeTaskProgress(pending, null, now, undefined, true)).toBe('后台已暂停');
    expect(describeTaskProgress(fired, new Set([fired.taskUuid]), now, 'pending', true)).toBe('已暂停·待恢复');
    expect(describeTaskProgress(fired, null, now, undefined, true)).toBe('已暂停·待恢复');
    // 暂停前已经处理完或终态失败的任务仍按既有事实展示
    expect(describeTaskProgress(fired, new Set(), now, undefined, true)).toBe('已触发');
    expect(describeTaskProgress(fired, new Set([fired.taskUuid]), now, 'failed', true)).toBe('发送失败');
  });
});

// ─── 远端 lastError（上一次没发出去的原因）的收敛与人话 ───
describe('parseRemoteTaskLastError', () => {
  it('标准形状（run-tick 写的 {at, occurrence, reason}）原样收敛', () => {
    expect(parseRemoteTaskLastError({
      at: '2026-07-30T15:00:10.000Z',
      occurrence: '2026-07-30T15:00:00.000Z',
      reason: 'stale',
    })).toEqual({
      at: '2026-07-30T15:00:10.000Z',
      occurrence: '2026-07-30T15:00:00.000Z',
      reason: 'stale',
    });
  });

  it('null / 非对象 / 全空对象 → null（旧 worker 没这字段，界面不显示那行）', () => {
    expect(parseRemoteTaskLastError(null)).toBeNull();
    expect(parseRemoteTaskLastError(undefined)).toBeNull();
    expect(parseRemoteTaskLastError('stale')).toBeNull();
    expect(parseRemoteTaskLastError({})).toBeNull();
    expect(parseRemoteTaskLastError({ at: 123, reason: '' })).toBeNull();
  });

  it('字段残缺时留下能用的部分', () => {
    expect(parseRemoteTaskLastError({ reason: 'HTTP 403' })).toEqual({
      at: undefined, occurrence: undefined, reason: 'HTTP 403',
    });
  });
});

describe('describeRemoteLastError', () => {
  const fmt = (iso: string) => `T(${iso})`;

  it("reason 'stale' → 「到点时已过期太久，跳过了一次」，时间优先用 occurrence", () => {
    expect(describeRemoteLastError({
      at: '2026-07-30T15:00:10.000Z',
      occurrence: '2026-07-30T15:00:00.000Z',
      reason: 'stale',
    }, fmt)).toBe('T(2026-07-30T15:00:00.000Z) 到点时已过期太久，跳过了一次');
  });

  it('其余 reason → 「上次到点没发出去（连续失败）」并带上原因', () => {
    expect(describeRemoteLastError({
      occurrence: '2026-07-30T15:00:00.000Z',
      reason: 'Web Push 返回 HTTP 403',
    }, fmt)).toBe('T(2026-07-30T15:00:00.000Z) 上次到点没发出去（连续失败：Web Push 返回 HTTP 403）');
  });

  it('reason 是一长串原始报错时截断，别把整段堆栈糊上卡片', () => {
    const text = describeRemoteLastError({ reason: 'x'.repeat(500) }, fmt)!;
    // 对着常量算，别写死数字：截断长度会随上游报错的形态调整，写死的话调一次常量
    // 就假挂一次，而这条测试真正要钉的是「500 字的原文不会整段糊上来」。
    expect(text.length).toBeLessThan(REMOTE_ERROR_REASON_MAX + 40);
    expect(text).toContain('上次到点没发出去');
  });

  // 上游拒了请求时 reason 是「状态行 —— 上游原话」两段，而唯一能照着改的东西
  // （模型名写错、余额不够）全在破折号后面。老的 60 字截断正好把它整段切掉。
  it('LLM 上游那句话取破折号后面那段，不把状态行占满整行', () => {
    const reason = 'AI API error: 401 Unauthorized. Request URL: https://api.example.com/v1/chat/completions\n'
      + '  — Incorrect API key provided: sk-[redacted]. (provider code: invalid_api_key)';
    const text = describeRemoteLastError({ reason }, fmt)!;
    expect(text).toContain('Incorrect API key provided');
    expect(text).toContain('invalid_api_key');
    expect(text).not.toContain('Request URL');
  });

  it('上游破折号后是 HTML 网关错误页时保留状态码与标题摘要，不把 <!DOCTYPE html> 糊上卡片', () => {
    const reason = 'AI API error: 502 Bad Gateway. Request URL: https://api.example.com/v1/chat/completions\n'
      + '  — <!DOCTYPE html><html><head><title>502: Bad gateway</title></head><body>Cloudflare</body></html>';
    const text = describeRemoteLastError({ reason }, fmt)!;
    expect(text).toContain('502 Bad Gateway');
    expect(text).not.toContain('<!DOCTYPE');
  });

  it('推送订阅失效（pushStatus 410 / 404）说该去重置订阅，不报原始错误', () => {
    const text = describeRemoteLastError(
      { reason: 'Web Push delivery failed: 410 Gone — …', pushStatus: 410 }, fmt,
    )!;
    expect(text).toContain('重置订阅');
    expect(text).not.toContain('410 Gone');
  });

  it('没有 occurrence 退回 at；两个都没有就不带时间；null → null', () => {
    expect(describeRemoteLastError({ at: '2026-07-30T15:00:10.000Z', reason: 'boom' }, fmt))
      .toBe('T(2026-07-30T15:00:10.000Z) 上次到点没发出去（连续失败：boom）');
    expect(describeRemoteLastError({ reason: 'boom' }, fmt))
      .toBe('上次到点没发出去（连续失败：boom）');
    expect(describeRemoteLastError(null, fmt)).toBeNull();
  });
});

describe('describeInstantChatFailure', () => {
  // 排程那句是「上次到点没发出去」，说的是一条到点该主动开口的任务。即时对话是用户
  // 刚按下发送的一条消息，套那个句式读起来不知所云。
  it('说人话地讲这一轮生成失败，带上重试次数和底层报错，不提「到点」', () => {
    expect(describeInstantChatFailure({ at: '2026-08-05T00:00:00.000Z', reason: '上游 502' }, 3))
      .toBe('生成失败（重试 3 次后放弃）：上游 502');
  });

  it('没重试过就不提重试；没有底层报错就只说生成失败', () => {
    expect(describeInstantChatFailure({ reason: '上游 502' }, 0)).toBe('生成失败：上游 502');
    expect(describeInstantChatFailure({ at: '2026-08-05T00:00:00.000Z' })).toBe('生成失败');
  });

  it("reason 'stale' 是排队太久没轮到，没有底层报错可引", () => {
    expect(describeInstantChatFailure({ reason: 'stale' }, 2)).toBe('云端排队太久没轮到这一轮（重试 2 次后放弃）');
  });

  // skip-push 的两种机器码（worker 在 chat_fail 里留的）：这一轮不是失败、是没产出。
  // 掉进「生成失败」句式的话，用户以为出了故障，其实是模型拒答/只做了动作。
  it("reason 'empty-generation' / 'side-effects-only' 照实说没产出，不说成失败", () => {
    expect(describeInstantChatFailure({ reason: 'empty-generation' }))
      .toBe('模型这轮没有生成内容（空输出或拒答）');
    expect(describeInstantChatFailure({ reason: 'side-effects-only' }))
      .toBe('角色这轮只做了动作，没有文字回复');
  });

  it('一长串原始报错照样截断；没有 lastError → null', () => {
    expect(describeInstantChatFailure({ reason: 'x'.repeat(500) })!.length)
      .toBeLessThan(REMOTE_ERROR_REASON_MAX + 40);
    expect(describeInstantChatFailure(null)).toBeNull();
  });

  // ── 机读字段（amsg-server 2.6.0-next.21 起）：这三条守的是「按 errorCode /
  //    pushStatus 分流，不去正则匹配 reason 那句人话」。上游改个措辞，reason 就变了，
  //    而这几句「接下来该做什么」不能跟着失效。

  it('errorCode LLM_CALL_FAILED → 说是模型接口拒了，别让人以为本地生成挂了', () => {
    const reason = 'AI API error: 404 Not Found. Request URL: https://api.example.com/v1/chat/completions\n'
      + '  — The model `gpt-4o-typo` does not exist. (provider code: model_not_found)';
    const text = describeInstantChatFailure({ reason, errorCode: 'LLM_CALL_FAILED' })!;
    expect(text).toContain('模型接口拒了这次请求');
    // 模型名是这一档最关键的信息，上游不再脱敏它，这边也不能截断截掉。
    expect(text).toContain('gpt-4o-typo');
    expect(text).not.toContain('生成失败');
  });

  // 中转站把报错装在 HTTP 200 里（amsg-server 2.6.0-next.28 起按调用失败处理）：报错开头
  // 换成了「HTTP 200 but …」，给用户看的仍得是破折号后面中转站的原话。
  it('errorCode LLM_CALL_FAILED 且上游回的是 200 → 照样引中转站原话', () => {
    const reason = 'AI API error: HTTP 200 but body is not a chat completion (no choices). '
      + 'Request URL: https://relay.example.com/v1/chat/completions — 无效的令牌 (provider code: 401)';
    expect(describeInstantChatFailure({ reason, errorCode: 'LLM_CALL_FAILED' }))
      .toBe('模型接口拒了这次请求：无效的令牌 (provider code: 401)');
  });

  it('errorCode PUSH_PAYLOAD_TOO_LARGE → 说这条太长，不套「生成失败」', () => {
    expect(describeInstantChatFailure({ reason: 'push payload 4200 bytes', errorCode: 'PUSH_PAYLOAD_TOO_LARGE' }))
      .toBe('这条回复太长，一条推送装不下');
  });

  it('pushStatus 410 → 引导重新登记订阅（重发多少次都是同一个结果）', () => {
    const text = describeInstantChatFailure(
      { reason: 'Web Push delivery failed: 410 Gone', pushStatus: 410 }, 3,
    )!;
    expect(text).toContain('重置订阅');
    expect(text).toContain('重试 3 次后放弃');
  });

  it('认不出来的 errorCode 走通用文案，不吞掉底层报错', () => {
    expect(describeInstantChatFailure({ reason: '上游 502', errorCode: 'SOMETHING_NEW' }))
      .toBe('生成失败：上游 502');
  });

  // 聊天里没有「原文」可以展开，这句就是用户能看到的全部，原话里的凭据 id 不能被一句概括替掉。
  it('errorCode CREDENTIAL_MISSING → 照样显示原话（体检面板那套一句话概括不用在这里）', () => {
    const text = describeInstantChatFailure({
      reason: 'CREDENTIAL_MISSING: 凭据 cred-abc 不存在',
      errorCode: 'CREDENTIAL_MISSING',
    }, 2)!;
    expect(text).toContain('cred-abc');
  });
});

// 体检「定时任务」那一行逐条说「这次是哪一类失败」。原文全文另外收在「原文」底下，
// 这里要守的是：类别说对、要紧的那半句不被吞掉、null 字段（体检回执给的就是 null）不炸。
describe('describeTaskFailureCause', () => {
  it('模型接口拒了：类别 + 上游原话的关键段（模型名不能截掉）', () => {
    const reason = 'AI API error: 404 Not Found. Request URL: https://api.example.com/v1/chat/completions\n'
      + '  — The model `gpt-4o-typo` does not exist. (provider code: model_not_found)';
    const text = describeTaskFailureCause({ reason, errorCode: 'LLM_CALL_FAILED', pushStatus: null });
    expect(text).toContain('模型接口拒了这次请求');
    expect(text).toContain('gpt-4o-typo');
    expect(text).not.toContain('Request URL');
  });

  it('推送服务拒收：类别 + 状态码（原话里状态码在破折号前面，会被切掉，从机读字段补回来）', () => {
    const text = describeTaskFailureCause({
      reason: 'Web Push delivery failed: 403 Forbidden — invalid JWT provided',
      errorCode: 'PUSH_SEND_FAILED',
      pushStatus: 403,
    });
    expect(text).toBe('推送服务没收下这条消息（403）：invalid JWT provided');
  });

  it('只要一句就说完的几种直接给那一句', () => {
    expect(describeTaskFailureCause({ reason: 'CREDENTIAL_MISSING: 凭据 cred-1 不存在', errorCode: 'CREDENTIAL_MISSING' }))
      .toBe('Worker 上找不到这个角色要用的 API 凭据');
    expect(describeTaskFailureCause({ reason: 'PUSH_SUBSCRIPTION_MISSING: …', errorCode: 'PUSH_SUBSCRIPTION_MISSING' }))
      .toBe('Worker 上没有登记收件设备');
    expect(describeTaskFailureCause({ reason: 'AGENTIC_LOOP_EXCEEDED: no finish/skip-push decision within 6 LLM round(s)', errorCode: 'AGENTIC_LOOP_EXCEEDED' }))
      .toBe('工具调用轮数用完了还没写出回复');
    expect(describeTaskFailureCause({ reason: 'x', errorCode: 'AGENTIC_EMPTY_TOOL_REQUEST' })).toContain('工具');
    expect(describeTaskFailureCause({ reason: 'push payload 4200 bytes', errorCode: 'PUSH_PAYLOAD_TOO_LARGE' }))
      .toBe('这条回复太长，一条推送装不下');
  });

  it('订阅失效（410）照旧说去重置订阅', () => {
    expect(describeTaskFailureCause({ reason: 'Web Push delivery failed: 410 Gone', errorCode: 'PUSH_SEND_FAILED', pushStatus: 410 }))
      .toContain('重置订阅');
  });

  it("'stale' 说成过期太久，不把机器词原样透出去", () => {
    expect(describeTaskFailureCause({ reason: 'stale', errorCode: null, pushStatus: null })).toBe('到点时已经过期太久');
  });

  it('SullyOS 自己的 Worker 抛的错没有 errorCode：原话截一段，代号留在开头', () => {
    const text = describeTaskFailureCause({
      reason: `AMSG2_FIRE_STATE_MISSING: ${'x'.repeat(400)}`,
      errorCode: null,
      pushStatus: null,
    });
    expect(text.startsWith('AMSG2_FIRE_STATE_MISSING')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(REMOTE_ERROR_REASON_MAX);
  });

  it('什么都没留下时也给一句，不返回空串', () => {
    expect(describeTaskFailureCause({ reason: '', errorCode: null, pushStatus: null })).toBe('没留下具体原因');
  });
});

describe('pruneFiredTasks', () => {
  const now = Date.now();
  const uuids = (list: ActiveMsg2TaskRecord[]) => list.map((t) => shortTaskId(t.taskUuid));
  const fired = task({
    taskUuid: 'ffffffff-0000-0000-0000-000000000000',
    firstSendTime: new Date(now - 24 * H).toISOString(),
  });
  const pending = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });

  it('走完的一次性任务出清单，待触发的留下', () => {
    expect(uuids(pruneFiredTasks([fired, pending], new Set(), now))).toEqual(['aaaaaaaa']);
  });

  it('过点了但远端那行还在 → worker 还没处理，留着', () => {
    expect(uuids(pruneFiredTasks([fired], new Set([fired.taskUuid]), now))).toEqual(['ffffffff']);
  });

  // 带错误的那行是用户唯一能看见的线索（远端可能还会照发），清掉等于把问题藏起来。
  it('带 lastError 的即使走完也留着', () => {
    const broken = { ...fired, lastError: REPLACE_CANCEL_FAILED_NOTE };
    expect(uuids(pruneFiredTasks([broken], new Set(), now))).toEqual(['ffffffff']);
  });

  it('底账没拉到时一条都不动', () => {
    expect(uuids(pruneFiredTasks([fired, pending], null, now))).toEqual(['ffffffff', 'aaaaaaaa']);
  });

  it('循环任务过点了也不清——它下一轮还会响', () => {
    const daily = task({
      taskUuid: 'dddddddd-0000-0000-0000-000000000000',
      firstSendTime: new Date(now - 24 * H).toISOString(),
      recurrenceType: 'daily',
    });
    expect(uuids(pruneFiredTasks([daily], new Set(), now))).toEqual(['dddddddd']);
  });

  // 清理口径必须跟面板上那行字一致：写着「已触发」的正是该清掉的那条，
  // 两边走岔就会出现「显示已触发却清不掉」或者「还在处理却被清了」。
  it('清理口径与 describeTaskProgress 的「已触发」对齐', () => {
    for (const t of [fired, pending]) {
      const remote = new Set<string>();
      const kept = pruneFiredTasks([t], remote, now).length === 1;
      expect(kept).toBe(describeTaskProgress(t, remote, now) !== '已触发');
    }
  });
});

// 回归守卫：fire 时刻的排程清单。平时聊天角色每轮都看得到自己挂着什么，到点生成时
// 以前是瞎的——于是它会把同一件事再排一遍，或者说「等下再告诉你 X」而 X 早就排好了。
// 这一块跟聊天那份说同一套话，但有三处只属于 fire：时区换算、摘掉正在发的那条、不带作废回执。
describe('buildFireTaskListBlock', () => {
  const NOW = Date.UTC(2026, 6, 30, 12, 0);
  const fireTask = (over: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
    taskUuid: 'aaaaaaaa-1111-4111-8111-111111111111',
    clientTaskId: 'client-1',
    mode: 'auto',
    firstSendTime: new Date(NOW + 3600_000).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    source: 'user',
    status: 'scheduled',
    createdAt: NOW,
    ...over,
  });

  it('列出待触发任务，时间按 tzId 换算（worker 跑在 UTC，不能用运行时本地时区）', () => {
    const block = buildFireTaskListBlock([fireTask()], { nowMs: NOW, tzId: 'Asia/Shanghai' });
    expect(block).toContain('7月30日 21:00');            // UTC 13:00 → UTC+8 21:00
    expect(buildFireTaskListBlock([fireTask()], { nowMs: NOW, tzId: 'UTC' }))
      .toContain('7月30日 13:00');
  });

  it('tzId 与当前时间槽 / self_log 同一参照系（东京钟）', () => {
    // UTC 13:00 → 东京 22:00。
    const block = buildFireTaskListBlock([fireTask()], { nowMs: NOW, tzId: 'Asia/Tokyo' });
    expect(block).toContain('7月30日 22:00');
    expect(block).not.toContain('13:00');
  });

  it('摘掉正在发的那一条——列进去角色会以为还得再排一次', () => {
    const firing = fireTask({ clientTaskId: 'client-firing' });
    const other = fireTask({
      taskUuid: 'bbbbbbbb-2222-4222-8222-222222222222',
      clientTaskId: 'client-other',
    });
    const block = buildFireTaskListBlock([firing, other], {
      nowMs: NOW, tzId: 'UTC', excludeClientTaskId: 'client-firing',
    });
    expect(block).toContain(shortTaskId(other.taskUuid));
    expect(block).not.toContain(shortTaskId(firing.taskUuid));
  });

  it('过点的一次性任务不列（isPendingTask 同一把尺）', () => {
    const past = fireTask({ firstSendTime: new Date(NOW - 86_400_000).toISOString() });
    expect(buildFireTaskListBlock([past], { nowMs: NOW, tzId: 'UTC' })).toBe('');
  });

  it('循环任务写「下一次」的时间，不是好几天前的首次', () => {
    const daily = fireTask({
      firstSendTime: new Date(Date.UTC(2026, 6, 20, 13, 0)).toISOString(),
      recurrenceType: 'daily',
    });
    const block = buildFireTaskListBlock([daily], { nowMs: NOW, tzId: 'UTC' });
    expect(block).toContain('7月30日 13:00');
    expect(block).not.toContain('7月20日');
  });

  // 回归守卫：这一块以前只说「别重复排、也别当它们不存在」，没说「别念出来」。
  // 短 id 和「到点看情况」是纯系统腔，被角色照着复述出来就是当场穿帮。
  it('带防复述约束（跟平时聊天那份共用同一句）', () => {
    const block = buildFireTaskListBlock([fireTask()], { nowMs: NOW, tzId: 'UTC' });
    expect(block).toContain(AMSG2_SCHEDULE_SECRECY_NOTE);
    expect(block).toContain('不要向用户复述');
  });

  it('没有可列的 → 空串（槽位被抹平）', () => {
    expect(buildFireTaskListBlock([], { nowMs: NOW, tzId: 'UTC' })).toBe('');
    expect(buildFireTaskListBlock([fireTask()], {
      nowMs: NOW, tzId: 'UTC', excludeClientTaskId: 'client-1',
    })).toBe('');
  });

  it('带上模式与到点策略——角色要据此判断这条到点会不会照发', () => {
    const block = buildFireTaskListBlock([fireTask({ expirePolicy: 'force', mode: 'prompted', promptHint: '叫他起床' })], {
      nowMs: NOW, tzId: 'UTC',
    });
    expect(block).toContain('到点必发');
    expect(block).toContain('叫他起床');
  });
});

describe('reconcileTasksWithRemote（跟远端底账对一次账）', () => {
  const remoteRow = (over: Record<string, unknown> = {}) => ({
    uuid: 'amsgself-char1-1754179200000-0',
    status: 'scheduled',
    lastError: null,
    clientTaskId: 'amsgself-char1-1754179200000-0-c',
    messageType: 'auto',
    recurrenceType: 'daily',
    nextSendAt: '2026-08-03T01:00:00.000Z',
    ...over,
  }) as any;

  // 角色在 fire 里给自己排的任务是随 push 认领的。那条 push 推失败、或者被防穿帮闸
  // 吞掉，认领就跟着没了，而任务在 D1 里照常到点触发——面板列不出来、用户也取消不掉，
  // 唯一的办法是关掉整个 2.0 或者删角色。
  it('远端有、本地没有的任务补回清单', () => {
    const out = reconcileTasksWithRemote([], [remoteRow()]);
    expect(out.map((t) => t.taskUuid)).toEqual(['amsgself-char1-1754179200000-0']);
    expect(out[0].source).toBe('character');
    expect(out[0].recurrenceType).toBe('daily');
    expect(out[0].nextSendAt).toBe('2026-08-03T01:00:00.000Z');
  });

  it('本地已有的不重复补，只把远端算的下次触发时刻同步过来', () => {
    const local = [task({ taskUuid: 'amsgself-char1-1754179200000-0' })];
    const out = reconcileTasksWithRemote(local, [remoteRow()]);
    expect(out).toHaveLength(1);
    expect(out[0].nextSendAt).toBe('2026-08-03T01:00:00.000Z');
  });

  it('远端那行还没有下次触发时刻 → 不凭空造一条本地记录', () => {
    expect(reconcileTasksWithRemote([], [remoteRow({ nextSendAt: undefined })])).toEqual([]);
  });

  it('远端一条都没有 → 原样返回，不动本地清单', () => {
    const local = [task()];
    expect(reconcileTasksWithRemote(local, [])).toEqual(local);
  });

  // 失败的行会在远端留 7 天（一次性任务发成功才删行），照单全收的话，清单上会多出
  // 一条永远等不到的幽灵任务。
  it('远端那行已经失败 → 不补进清单', () => {
    expect(reconcileTasksWithRemote([], [remoteRow({ status: 'failed' })])).toEqual([]);
  });

  // 即时对话的行是「用户此刻正等着的一轮聊天」，不是排程：补进清单会显示成待触发的
  // 任务，还可能被「取消全部」把用户正等着的回复顺手掐掉。
  it('远端那行是即时对话 → 不补进清单', () => {
    expect(reconcileTasksWithRemote([], [remoteRow({ messageSubtype: 'instant-chat' })])).toEqual([]);
  });
});

describe('currentOccurrenceMs 跨夏令时', () => {
  // 循环任务按角色所在时区的墙钟推进（worker 那边用 Intl 算）。本地固定加 24 小时的话，
  // 纽约的每日任务过一次夏令时切换就永久偏一小时，显示的时刻跟真正会响的对不上。
  it('对过账就用远端算的那个时刻，不自己按固定周期乘', () => {
    const dstTask = task({
      firstSendTime: '2026-03-07T13:00:00.000Z',   // 纽约 3/7 08:00（EST）
      recurrenceType: 'daily',
      nextSendAt: '2026-03-08T12:00:00.000Z',      // 纽约 3/8 08:00（EDT，真实间隔 23h）
    });
    const now = Date.parse('2026-03-07T14:00:00.000Z');

    expect(currentOccurrenceMs(dstTask, now)).toBe(Date.parse('2026-03-08T12:00:00.000Z'));
    // 固定 +24h 会算成 13:00Z，也就是纽约的 09:00——那正是旧行为偏掉的那一小时。
    expect(currentOccurrenceMs(dstTask, now)).not.toBe(Date.parse('2026-03-08T13:00:00.000Z'));
  });

  it('远端给的那次已经过点 → 退回自己推算（还没对上这一轮的账）', () => {
    const stale = task({
      firstSendTime: '2026-03-07T13:00:00.000Z',
      recurrenceType: 'daily',
      nextSendAt: '2026-03-08T12:00:00.000Z',
    });
    const now = Date.parse('2026-03-20T00:00:00.000Z');
    expect(currentOccurrenceMs(stale, now)).toBeGreaterThan(now);
  });
});

// ─── 设置面板的「启用主动消息 2.0」开关必须落盘 ───
//
// isAmsg2EnabledForChar 只认持久化下来的 enabled:true。开关的 onClick 要是只改 React
// state，用户拨开、关掉弹窗之后角色身上还是没有 activeMsg2Config：聊天里不注入
// schedule/cancel/renew/list、fire_pack 的 selfScheduleEnabled 上传 false、云端 fire
// 也不给排程能力，而重开面板开关又显示成「关」。症状是纯界面的，不报错也不崩，
// 用户唯一能歪打正着的路子是去点「新建任务」——那条路才顺手写了 enabled:true。
//
// 仓库的 vitest 是纯 Node 环境（没装 jsdom），设置面板是 React 组件跑不起来测行为，
// 所以沿用 amsg2CharToggle.wiring.test.ts 的做法做源码级断言：它验证不了运行时时序，
// 只钉住「开关接的是会写库的 handler」这一件事。
describe('设置面板的启用开关落盘', () => {
  const modal = readFileSync(
    fileURLToPath(new URL('../components/chat/ActiveMsg2SettingsModal.tsx', import.meta.url)),
    'utf8',
  );
  const toggleHandler = modal.match(/const handleToggleEnabled[\s\S]*?\n  \};/)?.[0] ?? '';

  it('开关接的是会写库的 handler，不是裸 setEnabled', () => {
    expect(modal).toMatch(/onClick=\{handleToggleEnabled\}/);
    expect(modal).not.toMatch(/onClick=\{\(\) => setEnabled\(!enabled\)\}/);
  });

  it('handler 既改面板状态也落盘', () => {
    expect(toggleHandler).toMatch(/setEnabled\(!enabled\)/);
    expect(toggleHandler).toMatch(/onSave\(/);
  });

  it('只有「开」就地落盘，「关」留给「关闭 2.0」按钮先取消远端任务', () => {
    // 就地写 enabled:false 的话，该角色在远端的任务没人取消，会变成面板看不见、
    // 却照样到点触发的幽灵任务。
    expect(toggleHandler).toMatch(/if \(turningOn\)[\s\S]*?onSave\(/);
  });
});

// 任务卡片上那行原因只留得下关键半句，状态码和上游原话的其余部分都截掉了——
// 用户截图来问的时候，唯一能看到全文的地方就是这个「原文」折叠块。
// 跟上面一样是源码级断言（vitest 是纯 Node 环境，组件跑不起来）。
describe('任务卡片的失败原文', () => {
  const modal = readFileSync(
    fileURLToPath(new URL('../components/chat/ActiveMsg2SettingsModal.tsx', import.meta.url)),
    'utf8',
  );

  it('失败原因下面挂着「原文」折叠块，放的是没截断的 reason', () => {
    expect(modal).toMatch(/<summary[^>]*>原文<\/summary>/);
    expect(modal).toMatch(/<pre[^>]*>\s*\{remoteInfo\.lastError\.reason\}\s*<\/pre>/);
  });
});

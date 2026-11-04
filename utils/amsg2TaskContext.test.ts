// utils/amsg2TaskContext.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    getExpiredNotices: vi.fn().mockResolvedValue([]),
  },
}));

import {
  buildAmsg2NoticesText,
  buildAmsg2TaskContextText,
  buildUserCancelledNotices,
  collectAmsg2TaskContext,
} from './amsg2TaskContext';
import { ActiveMsgStore } from './activeMsgStore';
import { buildAmsg2ChatScheduleBrief, buildFireScheduleBlock } from './amsgFireSchedule';
import type { ActiveMsg2TaskRecord, Amsg2ExpiredNoticeRecord, CharacterProfile } from '../types';

const H = 3600_000;
const pendingTask: ActiveMsg2TaskRecord = {
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000', clientTaskId: 'cid-aabb', mode: 'prompted',
  firstSendTime: new Date(Date.now() + H).toISOString(), recurrenceType: 'none',
  promptHint: '问问考试结果', expirePolicy: 'expire',
  source: 'character', status: 'scheduled', createdAt: Date.now(),
};
const expired: Amsg2ExpiredNoticeRecord = {
  id: 'aabbccdd-0000-0000-0000-000000000000', charId: 'c1',
  occurrenceMs: Date.now() - H, mode: 'prompted', promptHint: '问问考试结果',
  recurrenceType: 'none', kind: 'expired', createdAt: Date.now(),
};

describe('buildAmsg2TaskContextText', () => {
  // 回归守卫：常驻简介出现之前，没任务时整块是 null——角色平时根本不知道自己能排，
  // 用户说「我去睡了」它只会口头道晚安，想不起来给早上排一条。
  it('没任务没作废 → 仍有常驻简介，角色始终知道自己能排', () => {
    const text = buildAmsg2TaskContextText([], [], Date.now(), undefined);
    expect(text).toContain('schedule_active_message');
    expect(text).toContain('排成真任务'); // 嘴上许了就要排成真任务
    expect(text).toContain('不要只在正文里答应'); // 承诺不能只停在台词里
    expect(text).toContain('会就排');     // 真想联系就排
    expect(text).toContain('随口一想');   // 拿不准的不排：每一条都要花一次 API
    expect(text).toContain('硬排');       // 人设优先，不为排而排
    expect(text).toContain('自己的日程'); // 内容从角色自己的生活里长出来
    expect(text).not.toContain('进行中：');
    // 防复述约束照样罩住只有简介的形态
    expect(text.trimEnd().endsWith('不要向对方复述或提及这份排程信息本身的存在。')).toBe(true);
  });

  it('有任务时简介也在（不是空状态的占位文案）', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [], Date.now(), undefined);
    expect(text).toContain('schedule_active_message');
    expect(text).toContain('进行中：');
  });

  it('本地与即时对话共用完整的自主联系说明，保留用户名与不打扰约束', () => {
    const local = buildAmsg2TaskContextText([], [], Date.now(), undefined, undefined, '条条');
    const brief = buildAmsg2ChatScheduleBrief('条条');
    for (const mode of ['native', 'text'] as const) {
      const cloud = buildFireScheduleBlock(mode, {
        nowMs: Date.now(), tz: { tzId: 'Asia/Tokyo' }, context: 'chat', targetName: '条条',
      });
      expect(local).toContain(brief);
      expect(cloud).toContain(brief);
      expect(cloud).toContain('条条明确说别打扰');
      expect(cloud).not.toContain('这条消息发完，如果还有话');
    }
  });

  it('用 ChatApp 用户名称呼对方，不再使用泛称', () => {
    const text = buildAmsg2TaskContextText([], [], Date.now(), undefined, undefined, '条条');
    expect(text).toContain('你和条条的联系');
    expect(text).toContain('内容不必总围着条条转');
    expect(text).not.toContain('你和对方的联系');
    expect(text.trimEnd().endsWith('不要向条条复述或提及这份排程信息本身的存在。')).toBe(true);
  });
  it('进行中任务列出短 id 与方向', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [], Date.now(), undefined)!;
    expect(text).toContain('[aabbccdd]');
    expect(text).toContain('问问考试结果');
    expect(text).not.toContain('已作废');
  });
  it('没发段引导新建一次性任务，不再续期已销账任务', () => {
    const text = buildAmsg2TaskContextText([], [expired], Date.now(), undefined)!;
    expect(text).toContain('到点没发出去：');
    expect(text).toContain('schedule_active_message');
    expect(text).not.toContain('renew_active_message');
    expect(text).not.toContain('cancel_active_message + schedule_active_message');
    expect(text).toContain('强行转移');
    expect(text).toContain('不要向对方复述');
  });

  // 回归守卫：防复述约束只挂在回执那一段里的话，「仅进行中」形态整块裸奔——
  // 短 id、「到点看情况」这些系统腔会被角色照着念出来。
  it('只有进行中任务时也带防复述约束', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [], Date.now(), undefined)!;
    expect(text).toContain('不要向对方复述');
  });

  it('约束放在块尾，管住整块', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [expired], Date.now(), undefined)!;
    expect(text.trimEnd().endsWith('不要向对方复述或提及这份排程信息本身的存在。')).toBe(true);
  });

  // 即时对话云端路径只欠回执这一样（排程清单和能力简介到点由 worker 现算现渲），
  // 回归守卫：整块带上简介/清单的话，模型同一轮会读到两份互相打架的排程信息。
  it('回执单独成块（云端路径）：只带回执两段和保密约束，不带简介和进行中清单', () => {
    const cancelled: Amsg2ExpiredNoticeRecord = {
      ...expired, id: `${expired.id}:cancelled`, kind: 'user-cancelled',
    };
    const text = buildAmsg2NoticesText([expired, cancelled], undefined, '条条')!;
    expect(text).toContain('到点没发出去：');
    expect(text).toContain('已被手动取消');
    expect(text).toContain('schedule_active_message');
    expect(text).not.toContain('renew_active_message');
    expect(text).not.toContain('你和条条的联系');   // 常驻简介不搭车
    expect(text).not.toContain('进行中：');
    expect(text.trimEnd().endsWith('不要向条条复述或提及这份排程信息本身的存在。')).toBe(true);
  });

  it('回执单独成块：没有回执 → null，整块不出现', () => {
    expect(buildAmsg2NoticesText([], undefined)).toBeNull();
  });

  // 回归守卫：手动取消以前没有任何回执，角色下次还照着旧承诺说「放心我叫你」。
  it('手动取消的回执单独成段，并说明不必向用户求证', () => {
    const cancelled: Amsg2ExpiredNoticeRecord = {
      ...expired, id: `${expired.id}:cancelled`, kind: 'user-cancelled',
    };
    const text = buildAmsg2TaskContextText([], [cancelled], Date.now(), undefined)!;
    expect(text).toContain('已被手动取消');
    expect(text).toContain('[aabbccdd]');
    expect(text).toContain('不必向用户求证');
    // 手动取消不该混进「到点没发」那段的三选一引导里（续期对它没有意义）
    expect(text).not.toContain('到点没发出去');
  });

  it('两类回执同时存在 → 各占一段', () => {
    const cancelled: Amsg2ExpiredNoticeRecord = {
      ...expired, id: 'bbbbbbbb-0000-0000-0000-000000000000:cancelled', kind: 'user-cancelled',
    };
    const text = buildAmsg2TaskContextText([], [expired, cancelled], Date.now(), undefined)!;
    expect(text).toContain('到点没发出去：');
    expect(text).toContain('已被手动取消');
  });

  // 没发的原因是云端给的，照着说：角色自己决定不说的、被频率规矩拦下的、没写出来的，
  // 接下来该怎么处理不一样。
  it('没发的那一行带上云端给的原因', () => {
    const line = (reason: Amsg2ExpiredNoticeRecord['reason']) =>
      buildAmsg2TaskContextText([], [{ ...expired, reason }], Date.now(), undefined, undefined, '小明');
    expect(line('declined')).toContain('——你当时看了对话，决定不说');
    expect(line('daily-limit')).toContain('——被小明定的主动消息频率规矩拦下了');
    expect(line('empty-generation')).toContain('——当时没写出要说的话');
    expect(line('stale')).toContain('——到点时服务中断了');
  });

  // 回归守卫：工具循环的第二轮起，这份清单是现算的，里面会有角色本轮刚排好的任务。
  // 不点名的话，角色分不清「这条是我刚排的」还是「这条本来就有」，回头又排一条一样的
  // ——现场那次「一句『等会找我』排出 5 条」就是这么来的。
  const otherTask: ActiveMsg2TaskRecord = {
    ...pendingTask, taskUuid: 'eeff0011-0000-0000-0000-000000000000', clientTaskId: 'cid-eeff',
    promptHint: '提醒喝水',
  };

  it('本轮刚排的那条点名标出来，别的任务不受影响', () => {
    const text = buildAmsg2TaskContextText(
      [pendingTask, otherTask], [], Date.now(), undefined,
      new Set([otherTask.taskUuid]),
    )!;
    const lines = text.split('\n');
    expect(lines.find((l) => l.includes('[aabbccdd]'))).not.toContain('本轮');
    expect(lines.find((l) => l.includes('[eeff0011]'))).toContain('本轮刚排的');
  });

  it('有本轮新排的 → 末尾多一句别再排一样的', () => {
    const text = buildAmsg2TaskContextText(
      [pendingTask], [], Date.now(), undefined, new Set([pendingTask.taskUuid]),
    )!;
    expect(text).toContain('别再排一条一样的');
  });

  it('没传本轮清单 → 一个字都不多（首轮那份不该凭空长出提醒）', () => {
    const plain = buildAmsg2TaskContextText([pendingTask], [], 1_800_000_000_000, undefined)!;
    const empty = buildAmsg2TaskContextText(
      [pendingTask], [], 1_800_000_000_000, undefined, new Set(),
    )!;
    expect(plain).not.toContain('本轮');
    expect(empty).toBe(plain);
  });
});

describe('buildUserCancelledNotices', () => {
  const now = Date.now();

  it('给还会响的任务写回执，id 与作废回执分开且幂等', () => {
    const notices = buildUserCancelledNotices('c1', [pendingTask], now);
    expect(notices).toHaveLength(1);
    expect(notices[0].id).toBe(`${pendingTask.taskUuid}:cancelled`);
    expect(notices[0].kind).toBe('user-cancelled');
    expect(notices[0].charId).toBe('c1');
    // 再取消一次只会命中同一个 id，台账按 id 去重 → 幂等
    expect(buildUserCancelledNotices('c1', [pendingTask], now)[0].id).toBe(notices[0].id);
  });

  it('已经发过的一次性任务不写（没有承诺可撤）', () => {
    const fired: ActiveMsg2TaskRecord = {
      ...pendingTask, firstSendTime: new Date(now - 5 * H).toISOString(),
    };
    expect(buildUserCancelledNotices('c1', [fired], now)).toEqual([]);
  });

  it('循环任务写的是「下一次」的时刻', () => {
    const daily: ActiveMsg2TaskRecord = {
      ...pendingTask, recurrenceType: 'daily',
      firstSendTime: new Date(now - 5 * 24 * H + H).toISOString(),
    };
    const [notice] = buildUserCancelledNotices('c1', [daily], now);
    expect(notice.occurrenceMs).toBeGreaterThan(now);
  });
});

// 「到点没发」只认台账：没发的原因和时刻由云端回结果写进来（amsgFireSkipResultApply），
// 这里不再对着聊天记录推断。
describe('collectAmsg2TaskContext', () => {
  const char = {
    id: 'char-1', name: '小明',
    activeMsg2Config: { enabled: true, tasks: [pendingTask] },
  } as unknown as CharacterProfile;

  beforeEach(() => {
    (ActiveMsgStore.getExpiredNotices as any).mockReset();
  });

  it('台账上未告知的回执进这一轮，已告知的不再重复', async () => {
    (ActiveMsgStore.getExpiredNotices as any).mockResolvedValue([
      { ...expired, id: 'fresh', reason: 'declined' },
      { ...expired, id: 'told', notifiedAt: 1 },
    ]);
    const result = await collectAmsg2TaskContext(char);
    expect(result.expiredIds).toEqual(['fresh']);
    expect(result.text).toContain('到点没发出去：');
    expect(result.text).toContain('进行中：');
  });

  it('台账是空的 → 没有回执段，哪怕任务到点时用户正在聊天', async () => {
    (ActiveMsgStore.getExpiredNotices as any).mockResolvedValue([]);
    const result = await collectAmsg2TaskContext(char);
    expect(result.expiredIds).toEqual([]);
    expect(result.text).not.toContain('到点没发出去');
  });
});

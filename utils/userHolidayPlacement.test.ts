// utils/userHolidayPlacement.test.ts
//
// 回归守卫（I5）：云端现取的用户所在地节日，插在「互动对象」段 bio 后面，与本地逐字一致；
// bio 里有空行也不会插进 bio 中间。找不到「互动对象」段时不往整串末尾追加（本地那时也没有这一行）。
import { describe, expect, it, vi } from 'vitest';

vi.mock('./userHolidays', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./userHolidays')>()),
  getCachedUserHolidayReminder: () => '小明所在地今天是元旦。',
}));
vi.mock('./dailySchedule', () => ({ getDailyScheduleForChar: async () => null }));

import { ContextBuilder } from './context';
import { insertUserHolidayInProfile } from './userHolidays';

const REMINDER = '小明所在地今天是元旦。';
const char = { id: 'c-holiday', name: '小满', memories: [] } as any;
const user = { name: '小明', bio: '喜欢猫。\n\n最近在学吉他。' } as any;

describe('用户所在地节日的插入位置', () => {
  it('云端插入后的「互动对象」段与本地逐字一致', async () => {
    const local = await ContextBuilder.buildCoreContext(char, user, false, undefined, undefined, { userHolidays: { enabled: true } as any });
    const cloudBase = await ContextBuilder.buildCoreContext(char, user, false, undefined, undefined, { userHolidays: { enabled: true } as any, skipUserHoliday: true });
    expect(cloudBase).not.toContain(REMINDER);
    expect(insertUserHolidayInProfile(cloudBase, REMINDER, user.bio.length)).toBe(local);
  });

  it('找不到「互动对象」段时不追加到末尾', () => {
    expect(insertUserHolidayInProfile('只有角色设定\n（开口前回到你自己）', REMINDER)).toBe('只有角色设定\n（开口前回到你自己）');
  });
});

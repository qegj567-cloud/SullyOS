/**
 * 日程的代跑落地。
 *
 * 解析和写库用的是本机直连那一份（scheduleGenerator 的 landDailyScheduleResponse），只多几道「结果晚到」的判断：
 *   - 角色不在了、日程关了、角色当地已经翻到下一天：丢弃。昨天的日程不该盖到今天。
 *   - 自动生成的那份回来时这一天已经有日程了（用户手动生成过、别的路径先落了）：丢弃。
 *     手动重新生成、换风格（force）照样覆盖。
 *   - 家园位置按落地这一刻的房间校验：请求之后删掉的房间不会写进日程，这次要了位置却对不上就丢弃、原日程保留。
 *   - generatedAt 取交出请求的时刻：日程按「请求那一刻的当天」拼的，读取时也按它判断属于哪一天。
 * 解析不出来、串门申请不合规这类永久失败按失败计（进退避）后丢弃；读写库出错抛出，结果留着下次再落。
 *
 * 落地期间登记表那条还是 running，聊天里的生成闸门一直关着，本机不会同时再生成一份，所以这里不另外加锁。
 */

import { DB } from '../../db';
import { getDailyScheduleForChar } from '../../dailySchedule';
import { getScheduleDateKey } from '../../scheduleTime';
import {
  SCHEDULE_LANDED_EVENT,
  isScheduleFeatureOn,
  landDailyScheduleResponse,
  markScheduleGenerationFailed,
  type ScheduleCloudContext,
  type ScheduleLandedEventDetail,
} from '../../scheduleGenerator';
import type { CharacterProfile } from '../../../types';
import type { CloudGenLander } from '../types';

const HEADER = '[cloud-gen:schedule]';

const readContext = (context: unknown): ScheduleCloudContext | null => {
  const c = context as Partial<ScheduleCloudContext> | null;
  return c && typeof c.date === 'string' ? { date: c.date, force: c.force === true, homePrompt: c.homePrompt === true } : null;
};

/** 云端那份 fire_pack 里烤着日程快照，落地后要刷新。不在 React 里，跟 amsgScheduleResultApply 一样从本机读材料。 */
const markCloudStateDirty = async (char: CharacterProfile): Promise<void> => {
  const [userProfile, groups] = await Promise.all([
    DB.getUserProfile().catch(() => null),
    DB.getGroups().catch(() => undefined),
  ]);
  if (!userProfile || !groups) {
    console.warn(`${HEADER} 取不到用户资料 / 群组，云端 fire_pack 这一轮没能打脏`, { charId: char.id });
    return;
  }
  const [{ markAmsgStateDirty }, { loadRealtimeConfigFromLocalStorage }] = await Promise.all([
    import('../../amsgStateSync'),
    import('../../activeMsgRuntime'),
  ]);
  markAmsgStateDirty({ char, userProfile, groups, realtimeConfig: loadRealtimeConfigFromLocalStorage() });
};

export const lander: CloudGenLander = {
  async land(response, record) {
    // 没开 acceptsOrphanResults，record 不会是 null。
    const context = readContext(record?.context);
    if (!record || !context) return 'discarded';
    const char = await DB.getCharacter(record.charId);
    if (!char || !isScheduleFeatureOn(char)) return 'discarded';
    if (getScheduleDateKey(char) !== context.date) return 'discarded';
    if (!context.force && await getDailyScheduleForChar(char)) return 'discarded';

    let schedule;
    try {
      schedule = await landDailyScheduleResponse(response, char, {
        date: context.date,
        homePrompt: context.homePrompt,
        generatedAt: record.submittedAt,
      });
    } catch (error) {
      // 读写库出错是一时的，抛出去下次再落；其余（串门申请冲突、格式不对）再来一次也一样，按失败收掉。
      if (error instanceof DOMException) throw error;
      console.warn(`${HEADER} 日程没能落地`, error);
      schedule = null;
    }
    if (!schedule) {
      markScheduleGenerationFailed(char.id, context.date);
      // 按失败收尾：登记表留下 failed 记录，自动生成的 30 分钟退避刷新后也认得到。
      return { failed: { code: 'invalid-output', message: '日程没能从模型输出里解析出来' } };
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<ScheduleLandedEventDetail>(SCHEDULE_LANDED_EVENT, { detail: { charId: char.id, schedule } }));
    }
    await markCloudStateDirty(char).catch((error) => console.warn(`${HEADER} 打脏云端状态失败`, error));
    return 'landed';
  },

  async onFailed(record) {
    const context = readContext(record.context);
    if (context) markScheduleGenerationFailed(record.charId, context.date);
  },

  open(record) {
    // 与通知点开同一条路：按用户空间找到角色，打开 TA 的聊天。日程面板没有现成的深链，不另做。
    window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId: record.charId } }));
  },
};

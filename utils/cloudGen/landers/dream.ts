/**
 * 梦境的代跑落地。
 *
 * 梦要等用户看完才写进 dreamLogs（DreamTheater 的 persist），所以落地只把剧本放进「还没看的梦」
 * （cloudGen/pending，按角色各一份，刷新后还在），DreamTheater 打开这个角色时取走播放。
 * 校验和本机生成是同一个 validateDreamResponse；没通过的按失败收尾（登记表标 failed），
 * 打开时走原来的「梦没能成形」报错界面。界面靠落地后登记表那次变化刷新，这里不用另行通知。
 */

import { DB } from '../../db';
import { validateDreamResponse } from '../../dreamScript';
import { dreamSimStore, type DreamCloudPending } from '../../dreamSimStore';
import { writeCloudGenPending } from '../pending';
import type { CloudGenLander } from '../types';

export const lander: CloudGenLander = {
  async land(response, record, info) {
    const charId = record?.charId ?? info.charId;
    const char = await DB.getCharacter(charId);
    if (!char) return 'discarded';
    let pending: DreamCloudPending;
    try {
      pending = { jobId: info.jobId, charName: char.name, script: validateDreamResponse(response) };
    } catch (error) {
      return { failed: { code: 'invalid-output', message: error instanceof Error ? error.message : String(error) } };
    }
    // 写不进去会抛出：结果不销账，下次上线再落
    writeCloudGenPending('dream', charId, pending);
    return 'landed';
  },
  // 只登记深链；打开小屋由调用方负责（梦境胶囊点按时会 openApp(Room)）
  open(record) {
    dreamSimStore.requestOpen(record.charId);
  },
};

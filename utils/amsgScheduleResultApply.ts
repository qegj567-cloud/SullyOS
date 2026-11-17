/**
 * 消化一条 `schedule-change` 结果（角色在后台改了自己的日程）。
 *
 * 结果的形状与「为什么要单独走一条通道」见 utils/amsgScheduleResult.ts。这份文件只管
 * 落地：取表 → 改 → 存 → 通知界面 → 把云端那份 fire_pack 打脏。
 *
 * 单独一份文件是为了让 amsgResults 的分发表能动态 import 它——落库这条路要拖 IndexedDB
 * 和整套日程依赖，静态引进去会把它们塞进补收链路的首屏包。
 */

import { DB } from './db';
import { announceScheduleChanges, applyScheduleChangeDirectives } from './scheduleChange';
import { parseScheduleChangeResult } from './amsgScheduleResult';
import { markAmsgStateDirty } from './amsgStateSync';
import type { AmsgResultContext } from './amsgResults';

const HEADER = '[amsg2:schedule-change]';

export const applyScheduleChangeResult = async (
    payload: unknown,
    _context?: AmsgResultContext,
): Promise<boolean> => {
    const result = parseScheduleChangeResult(payload);
    if (!result) {
        console.warn(`${HEADER} 结果形状认不出来，丢弃`, payload);
        return true;
    }

    const characters = await DB.getAllCharacters();
    const char = characters.find((c) => c.id === result.charId);
    if (!char) {
        // 角色已经被删了：这条永远没有落点，留着只会每次上线重放一遍。
        console.warn(`${HEADER} 找不到角色 ${result.charId}（已删除？），销账丢弃`);
        return true;
    }

    // spokenAt 是角色说这句话的那一刻。躺一夜才被拿到的话，applyScheduleChangeDirectives
    // 的日历日门槛会把整批丢掉——昨晚的意思不该盖到今天的表上。
    const applied = await applyScheduleChangeDirectives(result.directives, char, new Date(result.spokenAt));

    if (applied.changes.length > 0 && applied.schedule) {
        announceScheduleChanges(char.id, applied.schedule, applied.changes);
        // 云端那份 fire_pack 里烤着打包那会儿的日程快照。不打脏的话，下一次主动消息
        // 读到的还是旧安排，角色会再想改一次。
        const [userProfile, groups] = await Promise.all([
            DB.getUserProfile().catch(() => null),
            DB.getGroups().catch(() => undefined),
        ]);
        if (userProfile && groups) {
            // 实时配置也要带：缺了它，重打的模板里搜索 / 翻日记 / 小红书的能力说明和日记标题整段消失，
            // 一直到下次聊天重新打包。这里不在 React 里，跟推送路径一样从本机设置读。
            const { loadRealtimeConfigFromLocalStorage } = await import('./activeMsgRuntime');
            markAmsgStateDirty({ char, userProfile, groups, realtimeConfig: loadRealtimeConfigFromLocalStorage() });
        } else {
            // 这两样是拼 fire_pack 的必需材料，编不出来，所以这一轮只能不打脏。
            // 后果要说清楚：本地的表已经改好了，云端那份还留着旧安排，下一次主动消息
            // 角色会照旧安排再改一次——而那一次会因为「活动名已经一样」被当成无落点
            // 销账，于是每次触发都重来一遍，直到用户打开这个角色的聊天顺手带上一次打脏。
            console.warn(`${HEADER} 取不到用户资料 / 群组，云端 fire_pack 这一轮没能打脏`, {
                charId: char.id,
                hasUserProfile: !!userProfile,
                hasGroups: !!groups,
            });
        }
    } else {
        // 没落地也照常销账：原因要么是隔天了、要么是表里没有对得上的时段，两种都不会
        // 因为「下次再试」变得能落——留着只是每次上线重放一次。
        console.warn(`${HEADER} 这批改动没有落点（${applied.rejectedReason ?? 'none'}），销账丢弃`, result.directives);
    }
    return true;
};

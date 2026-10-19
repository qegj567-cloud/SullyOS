/**
 * 云端结果的分发口（`resultKind` → 谁来消化）
 *
 * worker 的 `ctx.emitResult` 送回来的东西不是聊天内容——是后台跑完的产物：整理好的一份
 * 数据、一条账目、一份报告。它跟聊天正文走同一条送达通道（落服务端收件箱 + 视通知策略
 * 发推送），但到了客户端要分头处理，所以在这里按 `resultKind` 派活。
 *
 * 两个入口都指到这儿来：
 *   - **推送直达**：SW 收到 `messageKind: 'result'` → `active-msg-result` → activeMsgRuntime
 *   - **上线补收**：`GET /outbox?since=` 拉回来的 result 条目（amsgInstantChat 的补收）
 *
 * 返回值就一件事：**这条能不能销账**。`true` = 消化完了（或者确定消化不了，留着也没用），
 * 客户端把它从服务端账本上划掉；`false` = 这次没处理成（比如落库失败），账不销，下次
 * 上线再拉回来重试。判断反了的后果两头都难看：该销不销就是每次上线重放一次，该留不留
 * 就是结果静默蒸发。
 */

import { PLATE_CONSOLIDATE_RESULT_KIND } from './amsgPlateJob';
import { SCHEDULE_CHANGE_RESULT_KIND } from './amsgScheduleResult';
import { FIRE_SKIP_RESULT_KIND } from './amsgFireSkipResult';

const HEADER = '[amsg2:result]';

/** 从一条 push payload 上读出结果种类；不是结果类 payload 就返回 null。 */
export const readResultKind = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).resultKind;
  return typeof raw === 'string' && raw ? raw : null;
};

/**
 * 分发排队用的尾巴：同一时刻只跑一条结果。
 *
 * 上面那两个入口能撞车——推送刚到、页面同时因为 visibilitychange 跑了一趟补收，两边
 * 指的是同一条结果，或者两条不同的结果落在同一块数据上。handler 普遍是「读一份 → 改 →
 * 整块存回去」，并发跑就是后写的把先写的整块盖掉，而且两边日志都显示成功。排队的代价
 * 只是后一条晚几百毫秒落地，结果本来就是异步回来的，没人在等。
 */
let dispatchChain: Promise<unknown> = Promise.resolve();

/**
 * 单条结果最多占用队伍这么久。
 *
 * 队是全局一条、所有 resultKind 共用的，所以「卡住」的代价不是这一条晚落地，而是**后面
 * 每一条都永远排不上**。而 handler 干的是 IndexedDB 的活儿：连接被别的标签页 block 住
 * （IndexedDB 连接风暴时就出过这种事）、事务卡在那儿不 settle，都是真实发生
 * 过的形态，promise 一辈子不 resolve。超时之后按「这条没处理成」算——账不销，下次上线
 * 还会拉回来重试；卡住那次的活儿还在后台跑，但至少不再挡着别人。
 *
 * **超时只是放行，不是取消**：卡住那个 handler 还在跑，后面那条一进来就跟它并行了。所以
 * 这条队不能是数据安全的唯一依靠——真正的互斥要落在被改的那份数据上（门牌那条路在
 * `mutatePlate` 里按门牌排队，两个 handler 撞上同一块也只会一前一后）。往这张表里加新
 * handler 时照着办：自己那份数据自己锁，别指望这条队。
 */
const DISPATCH_TIMEOUT_MS = 60_000;

/**
 * 把一条结果交给认领它的那一方。
 *
 * 具体 handler 走动态 import：它们要读写 IndexedDB，而这份文件被补收链路引着，
 * 静态引进来会把整个记忆宫殿的依赖拖进那条路的首屏包里。
 *
 * @param context 这条结果的随身信息，转交给 handler。补收那条腿要带上 `createdAt`
 *   （账本上记的时间）——handler 据此判「这份产物是不是已经陈到不能用了」。
 * @returns 这条能不能销账
 */
export const dispatchAmsgResult = async (
  payload: unknown,
  context?: AmsgResultContext,
): Promise<boolean> => {
  const next = () => guardDispatch(payload, context);
  // 前一条的成败不影响后一条排上队（catch 掉，别让一次失败把整条队掐断）。
  const run = dispatchChain.then(next, next);
  dispatchChain = run.catch(() => {});
  return run;
};

/** 一条结果的随身信息（不是结果内容本身）。 */
export interface AmsgResultContext {
  /** 这条结果是什么时候记进服务端账本的（epoch 毫秒）。推送直达那条腿是刚刚，不用传。 */
  createdAt?: number;
}

const guardDispatch = async (payload: unknown, context?: AmsgResultContext): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dispatchOne(payload, context),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`${HEADER} 一条结果消化了 ${DISPATCH_TIMEOUT_MS / 1000} 秒还没完（IDB 卡住？），先放行后面的（账没销）`, payload);
          resolve(false);
        }, DISPATCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const dispatchOne = async (payload: unknown, context?: AmsgResultContext): Promise<boolean> => {
  const resultKind = readResultKind(payload);
  if (!resultKind) {
    console.warn(`${HEADER} 收到一条没有 resultKind 的结果，丢弃`, payload);
    return true;
  }

  try {
    switch (resultKind) {
      case 'assistant-actions': {
        const { applyAmsgActionResult } = await import('./amsgActionResult');
        return await applyAmsgActionResult(payload);
      }
      case PLATE_CONSOLIDATE_RESULT_KIND: {
        const { applyPlateConsolidateResult } = await import('./memoryPalace/roomPlateCloud');
        return await applyPlateConsolidateResult(payload, context);
      }
      case SCHEDULE_CHANGE_RESULT_KIND: {
        const { applyScheduleChangeResult } = await import('./amsgScheduleResultApply');
        return await applyScheduleChangeResult(payload, context);
      }
      case FIRE_SKIP_RESULT_KIND: {
        const { applyFireSkipResult } = await import('./amsgFireSkipResultApply');
        return await applyFireSkipResult(payload, context);
      }
      default:
        // 认不出来的多半是**前端比 worker 旧**：worker 可以脱开前端单独更新（fork 的
        // Sync → Cloudflare Workers Builds），PWA 那边还可能跑着缓存下来的旧包。销账
        // 丢掉的话，这份跑完的活儿在前端更新完之前就已经从服务端账本上抹掉了，等前端
        // 认得它的时候东西已经没了。
        //
        // 所以留着不销：代价只是每次上线把它拉回来再看一眼、多打一行日志，而收件箱
        // 本来就有 28 天保留期兜底，攒不住。这跟上面「没有 resultKind」那一支的处置
        // 相反是有意的——那种是形状本身就坏了，换个版本的前端也一样读不出来。
        console.warn(`${HEADER} 不认识的 resultKind=${resultKind}（前端比 worker 旧？），先留着不销账`);
        return false;
    }
  } catch (error) {
    console.warn(`${HEADER} 消化 ${resultKind} 出错（账没销，下次再来）`, error);
    return false;
  }
};

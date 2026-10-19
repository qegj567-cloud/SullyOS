import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  AMSG2_TASKS_ADOPTED_EVENT,
  INBOX_FRESH_DELIVERY_WINDOW_MS,
  MAX_INBOX_ORDER_HOLDS,
  MAX_INBOX_PROCESS_ATTEMPTS,
  OrphanedCharacterError,
  PUSH_SUBSCRIPTION_CHANGED_KV_ID,
  catchUpMissedPushes,
  catchUpMissedPushesManually,
  resetOutboxCatchUpThrottleForTesting,
  findInboxArtifacts,
  findMissingChunkIndexes,
  findPersistedChunkIndexes,
  flushInboxToChat,
  handlePageBecameVisible,
  isFreshInboxDelivery,
  notePageBecameVisible,
  wasDeliveredWhileAway,
  purgeInboxArtifacts,
  refreshPushSubscriptionIfMarked,
  resolveBackfillTimestamp,
  resolveInboxFailureAction,
  resolveInboxPersistTimestamp,
  resolveInboxRetryDelay,
  runInstantChatStatusCheck,
  cancelLateEmotionPoll,
  describeMultipartFailure,
  handleInstantErrorPushMessage,
  startLateEmotionPoll,
  sweepLocalInbox,
  shouldRenderInstantly,
  isOutboxBackfill,
} from './activeMsgRuntime';
import { MULTIPART_FAILURE_REASON } from '@rei-standard/amsg-shared';
import * as Analytics from './analytics';
import {
  AMSG_INSTANT_CHAT_PENDING_LS_KEY,
  AMSG_OUTBOX_ADOPTED_LS_KEY,
  INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS,
  getInstantChatPending,
  getStagedInstantChatExpiredNotices,
  listInstantChatPendings,
  setInstantChatPending,
  stageInstantChatExpiredNotices,
} from './amsgInstantChat';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { amsgStateNamespace } from './amsgFirePack';
import { CHAT_GEN_EVENTS } from './chatGenEvents';
import { DB } from './db';
import { readAllInstantTraces } from './instantTraceLog';
import {
  createSARModuleEventMeta,
  installSARModuleOnCharacter,
  installSARModuleOnUser,
  toSARModuleSurfaceSource,
  type AmsgSarModuleSnapshot,
} from './vrWorld/sarModuleRuntime';
import { SAR_MODULE_CATALOG } from './vrWorld/sarModuleShop';

describe('resolveInboxFailureAction', () => {
  it('角色已不存在 → 孤儿，不重试（重试多少次都没用，该去清远端任务）', () => {
    const err = new OrphanedCharacterError('char-gone');
    expect(resolveInboxFailureAction(err, 1)).toBe('orphan');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS + 5)).toBe('orphan');
  });

  it('普通失败且没到上限 → 重试，不把残缺版固化进聊天记录', () => {
    const err = new Error('IndexedDB transaction aborted');
    expect(resolveInboxFailureAction(err, 1)).toBe('retry');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS - 1)).toBe('retry');
  });

  it('重试到上限 → 退回存原稿保底（残缺也好过什么都没有）', () => {
    const err = new Error('IndexedDB transaction aborted');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS)).toBe('degrade');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS + 1)).toBe('degrade');
  });
});

// 回归守卫：重试等多久。
//
// 这条路上最常见的失败是 IndexedDB 的「将死连接」——App 切后台时系统强关连接，页面刚
// 解冻就处理推送，正好撞在重建窗口里，db.transaction() 同步抛 InvalidStateError
// （db.ts 的 onclose 注释写着这个形态：当次失败、下一次调用就自愈）。线上埋点里
// 「重试中」占失败的 96.7%，而「重试到头退回存原稿」几乎没有——全是一两次就缓过来了。
//
// 自愈是毫秒级的，等半分钟纯属让用户对着「正在输入」干等：推送通知早就把这句话完整
// 显示过了，聊天界面却要过 30 秒才追上。所以第一次重试必须是秒级；真的连着失败再拉长
// 间隔，避免存储持续故障时空转。
describe('resolveInboxRetryDelay（重试等多久）', () => {
  it('第一次重试是秒级——瞬态故障下一次调用就自愈，不该让用户干等', () => {
    expect(resolveInboxRetryDelay(1)).toBeLessThanOrEqual(1_000);
  });

  it('连着失败就拉长间隔，别在持续故障时空转', () => {
    expect(resolveInboxRetryDelay(2)).toBeGreaterThan(resolveInboxRetryDelay(1));
    expect(resolveInboxRetryDelay(3)).toBeGreaterThan(resolveInboxRetryDelay(2));
  });

  it('次数超出上限也给得出延迟，不返回 undefined/NaN', () => {
    const last = resolveInboxRetryDelay(MAX_INBOX_PROCESS_ATTEMPTS + 5);
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBeGreaterThan(0);
  });

  it('attempts 非法（0 / 负数 / NaN）时退到第一档，别算出 0 或负延迟', () => {
    expect(resolveInboxRetryDelay(0)).toBe(resolveInboxRetryDelay(1));
    expect(resolveInboxRetryDelay(-3)).toBe(resolveInboxRetryDelay(1));
    expect(resolveInboxRetryDelay(Number.NaN)).toBe(resolveInboxRetryDelay(1));
  });
});

// 回归守卫：重试不能把已经写进聊天记录的气泡再写一遍。
//
// 后处理是逐条落库的（十几处 DB.saveMessage），第 3 条写失败时前两条已经在库里了。
// 「失败就整条重跑」最多跑 4 趟（3 次重试 + 最后存原稿保底），不先认领并清掉上一趟的
// 半成品，用户就会看到同一段话出现三四遍——而重复进了聊天记录是永久的。
// 认领的依据是每条气泡都继承的 metadata.activeMsg2.messageId（每条 push 唯一）。
describe('findInboxArtifacts', () => {
  const bubble = (id: number, messageId: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: 'assistant',
    metadata: { source: 'active_msg_2', activeMsg2: { messageId }, ...extra },
  });

  it('认出同一条 push 写下的全部气泡', () => {
    const found = findInboxArtifacts(
      [bubble(1, 'msg_a'), bubble(2, 'msg_a'), bubble(3, 'msg_b')],
      'msg_a',
    );
    expect(found.map((m) => m.id)).toEqual([1, 2]);
  });

  it('别的 push / 别的来源一律不动（多分段 push 每段各有各的 messageId）', () => {
    const messages = [
      bubble(1, 'msg_b'),
      { id: 2, role: 'assistant', metadata: { source: 'chat' } },
      { id: 3, role: 'assistant' },
      { id: 4, role: 'user', metadata: { activeMsg2: { messageId: 'msg_a' } } },
    ];
    expect(findInboxArtifacts(messages as any, 'msg_a')).toEqual([]);
  });

  it('一趟都没写成（第一条就挂了）→ 空清单，调用方据此判定副作用还得重放', () => {
    expect(findInboxArtifacts([bubble(1, 'msg_b')], 'msg_a')).toEqual([]);
  });

  it('退回存原稿那条也带同一个 messageId，所以也认得出来（免得原稿跟残留气泡并排）', () => {
    const raw = { id: 9, role: 'assistant', metadata: { activeMsg2: { messageId: 'msg_a' } } };
    expect(findInboxArtifacts([raw] as any, 'msg_a')).toHaveLength(1);
  });
});

// 上面那条是纯判定，这条走真库（fake-indexeddb）钉住实际删除行为：
// 重试前不清场的话，重跑一趟就是把同样的气泡再写一遍，用户看到重复的一段话。
describe('purgeInboxArtifacts（走真库）', () => {
  const CHAR = 'char-purge';

  const saveBubble = (content: string, messageId: string | null, type = 'text') => DB.saveMessage({
    charId: CHAR,
    role: 'assistant',
    type,
    content,
    metadata: messageId
      ? { source: 'active_msg_2', activeMsg2: { messageId } }
      : { source: 'chat' },
  } as any);

  it('只删这条 push 写下的气泡，别人的一条不动', async () => {
    await saveBubble('上一趟写了一半 1', 'msg_a');
    await saveBubble('上一趟写了一半 2', 'msg_a');
    await saveBubble('另一条 push 的', 'msg_b');
    await saveBubble('普通聊天回复', null);

    const { removed, evidence } = await purgeInboxArtifacts({ charId: CHAR, messageId: 'msg_a' } as any);

    expect(removed).toBe(2);
    expect(evidence).toBe(2);
    const left = await DB.getRecentMessagesByCharId(CHAR, 200);
    expect(left.map((m) => m.content)).toEqual(['另一条 push 的', '普通聊天回复']);
  });

  it('一条都没写过 → 删 0 条，也不报错（首次处理走的就是这条）', async () => {
    await expect(purgeInboxArtifacts({ charId: 'char-empty', messageId: 'msg_x' } as any))
      .resolves.toEqual({ removed: 0, evidence: 0 });
  });

  // 副作用产物跟正文气泡带着同一个 activeMsg2.messageId（chatParser 落库时统一挂的）。
  // 一起删掉的话：本轮又因为「认出了标记」不重放 directives，那张转账卡就永远回不来了。
  // 所以「算不算凭据」和「删不删」必须分开——凭据照数，删只删渲染型气泡。
  it('副作用产物（转账卡等）算凭据但不删，只删渲染型气泡', async () => {
    const charId = 'char-purge-sideeffect';
    const save = (content: string, type: string) => DB.saveMessage({
      charId, role: 'assistant', type, content,
      metadata: { source: 'active_msg_2', activeMsg2: { messageId: 'msg_mixed' } },
    } as any);

    await save('半截正文', 'text');
    await save('[表情]', 'emoji');
    await save('[HTML卡片]', 'html_card');
    await save('给你转 5 块', 'transfer');
    await save('戳了戳你', 'interaction');
    await save('今天的热点', 'news_card');
    await save('[音乐]', 'music_card');
    await save('日程已加', 'info');
    await save('今天的生活记录', 'life_card');
    await save('小红书笔记', 'xhs_card');

    const { removed, evidence } = await purgeInboxArtifacts({ charId, messageId: 'msg_mixed' } as any);

    expect(removed, '只删 text / emoji / html_card').toBe(3);
    expect(evidence, '凭据要把副作用产物一起数上，否则重试会二次转账').toBe(10);
    const left = await DB.getRecentMessagesByCharId(charId, 200);
    expect(left.map((m) => m.type)).toEqual([
      'transfer', 'interaction', 'news_card', 'music_card', 'info', 'life_card', 'xhs_card',
    ]);
  });
});

// 回归守卫：主动消息落库时间戳一律取 sentAt（云端真正发出那一刻）。
//
// 气泡在聊天流里的位置只看自增 id（db.ts 按 charId 索引游标读、Chat.tsx 的 displayMessages
// 不排序），跟 timestamp 无关，所以标 sentAt 不会让消息跑到用户正在聊的内容上面。timestamp
// 只决定气泡上显示的那个数字。唯一要防的是「位置在下、数字往回走」的倒挂，那个由
// resolveBackfillTimestamp 精确接管（本地真有更晚的消息才退让）。
//
// 这里不再按「消息够不够新」二选一：那个判据回答不了「用户在不在场」——到点弹的通知，
// 用户隔几分钟才点进来，消息就会被标成他点进来的那一刻。而在线送达时 sentAt 距落库
// 只有几秒，标 sentAt 一样显示「刚刚」，观感没有差别。
//
// 落库时间戳还会喂给 amsg2ExpireGuard.hasDeliveredProactiveNear（判定窗
// [occurrence-90s, occurrence+30min]）：sentAt ≈ occurrence + 云端生成耗时，稳落在窗内，
// 已送达的消息不会被误判成没送到而生成假作废回执。
describe('resolveInboxPersistTimestamp（边界值）', () => {
  const NOW = 1_700_000_000_000;

  it('刚送达（几秒 / 一分钟前）→ 也落 sentAt，不再改成写库当刻', () => {
    expect(resolveInboxPersistTimestamp(NOW - 3_000, NOW)).toBe(NOW - 3_000);
    expect(resolveInboxPersistTimestamp(NOW - 60_000, NOW)).toBe(NOW - 60_000);
    expect(resolveInboxPersistTimestamp(NOW, NOW)).toBe(NOW);
  });

  // 现场那一例：17:35 到点弹通知，17:43 才点进去，气泡标成了 17:43。
  it('到点弹通知、隔 8 分钟才点进来 → 落 sentAt（不是点进来的那一刻）', () => {
    const sentAt = NOW - 8 * 60_000;
    expect(resolveInboxPersistTimestamp(sentAt, NOW)).toBe(sentAt);
  });

  it('隔夜典型场景：13 小时前的 sentAt 原样返回', () => {
    const sentAt = NOW - 13 * 3_600_000;
    expect(resolveInboxPersistTimestamp(sentAt, NOW)).toBe(sentAt);
  });

  it('sentAt 缺失 / 非法（老 push 可能不带）→ undefined，交给写库当刻', () => {
    expect(resolveInboxPersistTimestamp(undefined, NOW)).toBeUndefined();
    expect(resolveInboxPersistTimestamp(0, NOW)).toBeUndefined();
    expect(resolveInboxPersistTimestamp(Number.NaN, NOW)).toBeUndefined();
  });

  it('sentAt 在未来（时钟偏差）→ undefined，别把气泡标到未来', () => {
    expect(resolveInboxPersistTimestamp(NOW + 5 * 60_000, NOW)).toBeUndefined();
  });
});

// 回归守卫：补收的消息跳过拟人打字延迟。
//
// 气泡是一条条冒出来的——后处理管线每条之间夹 0.5~2 秒 setTimeout，模拟角色在打字。
// 实时收到时这是对的（角色正在你眼前说话）；但补收的消息早在几小时前就在云端生成完了，
// 再慢放一遍只会让用户干等，而且这段时间里用户来得及插话，把倒挂的口子撑开
// （见 resolveBackfillTimestamp）。所以躺过窗口的消息一次性回填。
//
// 判据用 receivedAt（消息落到这台设备的时刻）而不是 sentAt：它剔除了云端到设备之间的
// 网络延迟，问的正是「这条在收件箱里躺了多久没人消费」。
describe('isFreshInboxDelivery（决定要不要慢放打字节奏）', () => {
  const NOW = 1_700_000_000_000;

  it('刚落到设备（几秒前）→ 保留打字节奏', () => {
    expect(isFreshInboxDelivery(NOW - 3_000, NOW)).toBe(true);
    expect(isFreshInboxDelivery(NOW, NOW)).toBe(true);
  });

  it('前台连收几条排队处理（一分钟前）→ 仍算刚到，用户就在看着', () => {
    expect(isFreshInboxDelivery(NOW - 60_000, NOW)).toBe(true);
  });

  it('恰好等于窗口 → 仍算刚到（规则是「超过」才算补收）', () => {
    expect(isFreshInboxDelivery(NOW - INBOX_FRESH_DELIVERY_WINDOW_MS, NOW)).toBe(true);
  });

  it('点通知隔 8 分钟才进来 → 算补收，一次性回填不慢放', () => {
    expect(isFreshInboxDelivery(NOW - 8 * 60_000, NOW)).toBe(false);
  });

  it('隔夜补收 → 算补收', () => {
    expect(isFreshInboxDelivery(NOW - 13 * 3_600_000, NOW)).toBe(false);
  });

  it('receivedAt 缺失 / 非法 → 当刚到处理（保守：宁可慢放，也别把实时消息秒刷出来）', () => {
    expect(isFreshInboxDelivery(undefined, NOW)).toBe(true);
    expect(isFreshInboxDelivery(0, NOW)).toBe(true);
    expect(isFreshInboxDelivery(Number.NaN, NOW)).toBe(true);
  });

  it('窗口要明显短于用户「看到通知再点进来」的典型间隔，否则补收照样慢放', () => {
    expect(INBOX_FRESH_DELIVERY_WINDOW_MS).toBeLessThanOrEqual(2 * 60_000);
  });
});

// 慢放的第二个判据：消息落到设备时，用户在不在看这个页面。
//
// 「够不够新」只回答了「这句话是不是刚生成的」，回答不了「用户读没读过」。推送到达时
// 页面在后台，系统通知就已经把整句话完整显示过了——用户再点进来，看到的是一句他刚读完
// 的话被一个字一个字重演一遍。慢放的意义是「角色正在你眼前打字」，人不在场时它只剩等待。
//
// 反过来，用户本来就开着聊天界面时收到的消息要保留慢放：那才是它想要的场景。
/**
 * 这一组守的是线上那条「补收回来的消息还在一条条演打字」。
 *
 * 补收在写库时会把整批消息的到达时间统一改写成「现在」，于是原来那两条判据（是不是刚
 * 到的、送达时人在不在场）问的全是同一个已经被改坏的值，双双得出「刚到、用户在场」，
 * 补收就把自己伪装成了实时消息。判据必须认补收路径自己盖的标记。
 */
describe('shouldRenderInstantly（这条要不要跳过打字慢放）', () => {
  const NOW = 1_700_000_000_000;

  it('补收回来的：哪怕到达时间被改成现在、用户也算在场，照样一次性回填', () => {
    const rewritten = NOW;               // 被补收改写过的到达时间
    const visibleSince = NOW - 60_000;   // 用户一分钟前就在前台 → 会被判成「在场」

    // 先钉死「另外两条判据在这个场景下确实指望不上」——它们俩都投了「保留慢放」：
    expect(isFreshInboxDelivery(rewritten, NOW)).toBe(true);
    expect(wasDeliveredWhileAway(rewritten, visibleSince)).toBe(false);

    // 认标记就不会被骗。
    expect(shouldRenderInstantly({ amsgOutboxBackfill: true }, rewritten, NOW, visibleSince)).toBe(true);
  });

  it('SW 直送、用户就在前台看着的：保留打字节奏', () => {
    expect(shouldRenderInstantly({ sessionId: 'sess-1' }, NOW - 3_000, NOW, NOW - 60_000)).toBe(false);
  });

  it('在收件箱里躺了十分钟才被捞出来的：一次性回填', () => {
    expect(shouldRenderInstantly(undefined, NOW - 10 * 60_000, NOW, NOW - 60_000)).toBe(true);
  });

  it('送达时人不在场（系统通知已经念过一遍）：一次性回填', () => {
    expect(shouldRenderInstantly(undefined, NOW - 3_000, NOW, NOW - 1_000)).toBe(true);
  });

  it('补收标记只认真的 true，SW 直送那份不带这个键', () => {
    expect(isOutboxBackfill({ amsgOutboxBackfill: true })).toBe(true);
    expect(isOutboxBackfill({ sessionId: 'sess-1' })).toBe(false);
    expect(isOutboxBackfill(undefined)).toBe(false);
  });
});

/**
 * 这一组守的是线上那条「消息早就在手机里了，页面却白等几十秒」。
 *
 * iOS 上 App 不在最前台时，Service Worker 拿到的「当前有哪些页面」名单是空的，存完消息
 * 喊了也没人听见（实测一轮 8 条推送 8 次全空）。所以页面不能等人喊，得自己隔几秒数一眼
 * 收件箱——但这趟巡查几秒就跑一次，空表时必须什么都不做，否则光是空转的记录就能把排障
 * 要看的东西全顶出缓冲区。
 */
describe('本地收件箱守望', () => {
  it('库里没货：不动收件箱，也不留下冲刷记录', async () => {
    await ActiveMsgStore.consumeInboxMessages();  // 先清干净
    const before = readAllInstantTraces().length;
    const consume = vi.spyOn(ActiveMsgStore, 'consumeInboxMessages');

    await sweepLocalInbox();

    expect(consume, '空表就该在数完个数之后收手').not.toHaveBeenCalled();
    expect(readAllInstantTraces().length, '空转不许写进 trace 缓冲').toBe(before);
    consume.mockRestore();
  });

  it('库里有货：自己就接着冲刷，不用等任何人来喊', async () => {
    await ActiveMsgStore.consumeInboxMessages();
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-sweep-1',
      charId: 'char-sweep',
      charName: '小明',
      body: '在吗',
      messageType: 'text',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      metadata: { charId: 'char-sweep' },
    } as any);
    // 取空这一步换成空实现：这条守的是「数出有货就往下走」，冲刷内部怎么处理有它自己
    // 的用例，不该在这里连带跑一遍真管线（还会往后面的用例里漏重试定时器）。
    const consume = vi.spyOn(ActiveMsgStore, 'consumeInboxMessages').mockResolvedValue([]);
    try {
      await sweepLocalInbox();
      expect(consume, '数出有货就该接着冲刷').toHaveBeenCalled();
    } finally {
      consume.mockRestore();
      await ActiveMsgStore.consumeInboxMessages();  // 别把这条留给后面的用例
    }
  });

  it('页面不可见时连数都不数（后台数了也做不了什么）', async () => {
    const hadDocument = 'document' in globalThis;
    (globalThis as any).document = { visibilityState: 'hidden' };
    const count = vi.spyOn(ActiveMsgStore, 'countInboxMessages');
    try {
      await sweepLocalInbox();
      expect(count).not.toHaveBeenCalled();
    } finally {
      if (!hadDocument) delete (globalThis as any).document;
      count.mockRestore();
    }
  });
});

describe('wasDeliveredWhileAway（送达时用户在不在场）', () => {
  const NOW = 1_700_000_000_000;

  it('页面回到前台之前就送到了 → 用户是从通知知道的，跳过慢放', () => {
    expect(wasDeliveredWhileAway(NOW - 30_000, NOW)).toBe(true);
  });

  it('App 在前台时送到 → 保留慢放，角色在他眼前说话', () => {
    expect(wasDeliveredWhileAway(NOW + 5_000, NOW)).toBe(false);
  });

  it('恰好在回到前台那一刻送到 → 算在场（规则是「早于」才算缺席）', () => {
    expect(wasDeliveredWhileAway(NOW, NOW)).toBe(false);
  });

  it('receivedAt 缺失 / 非法 → 当作用户在场，宁可慢放也别误伤实时消息', () => {
    expect(wasDeliveredWhileAway(undefined, NOW)).toBe(false);
    expect(wasDeliveredWhileAway(0, NOW)).toBe(false);
    expect(wasDeliveredWhileAway(Number.NaN, NOW)).toBe(false);
  });

  it('还没记录过「回到前台」的时刻 → 不把所有消息都判成缺席', () => {
    expect(wasDeliveredWhileAway(NOW - 30_000, 0)).toBe(false);
  });
});

// 接线守卫：回到前台时，「记下时刻」必须排在「去 flush」之前。
//
// 顺序反了的话，后台期间攒下的那条消息在 flush 那一刻还查不到回到前台的时刻，会被判成
// 「用户在场」照常慢放——而它恰恰是最该跳过的一条（用户就是看着通知点进来的）。
// 这种错法不会有任何报错，消息照常出现，只是又慢了一遍。
describe('handlePageBecameVisible（回到前台的入口）', () => {
  afterEach(() => { notePageBecameVisible(0); });

  it('先记下回到前台的时刻，之前送达的消息据此判为「用户不在场」', () => {
    notePageBecameVisible(0);
    const earlier = Date.now() - 5_000;
    expect(wasDeliveredWhileAway(earlier), '前置条件：还没回过前台时不该判缺席').toBe(false);

    handlePageBecameVisible();

    expect(wasDeliveredWhileAway(earlier), '回到前台后，更早送达的那条算缺席送达').toBe(true);
  });
});

// 端到端（走真库 + 真 flush）：钉住主路径（post-processing 逐条落库）和降级存原稿路径
// 用的是同一个口径——离线补收落 sentAt，在线送达落写库当刻。修复前主路径永远落写库当刻
// （离线补收用例挂）、降级路径永远落 sentAt（在线送达用例挂），两套口径各错一半。
describe('flushInboxToChat 落库时间戳（走真库）', () => {
  beforeAll(async () => {
    // flush 尾部会 dispatch 'active-msg-received' 等事件；node 测试环境没有 window，
    // 给个最小 stub（事件本身不在本组断言范围内）。
    (globalThis as any).window ??= { dispatchEvent: () => true };
    // 主路径要查得到角色才不会走孤儿分支。
    await DB.saveCharacter({ id: 'char-ts-main', name: '守夜角色' } as any);
  });

  const inboxMsg = (over: Record<string, unknown>) => ({
    charId: 'char-ts-main',
    charName: '守夜角色',
    body: '还没睡吗，早点休息',
    receivedAt: Date.now(),
    ...over,
  }) as any;

  const assistantMsgs = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');

  it('主路径·离线补收：sentAt 超过阈值 → 每条气泡都落 sentAt', async () => {
    const sentAt = Date.now() - 13 * 3_600_000; // 昨晚推的，今天中午才打开
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-stale',
      messageType: 'text', // ASSISTANT_TEXT_TYPES 白名单内 → 走 post-processing 主路径
      sentAt,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs('char-ts-main');
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBe(sentAt);
  }, 20000);

  // 循环判定读的是 push 顶层的 recurrenceType（库盖上去的，用户排的和角色自排的走同
  // 一份）。任务 metadata 里那份是排程方自己抄的，角色在 fire 里自排那条路径压根不会
  // 抄——照着 metadata 判的话，每日提醒只要用户开过一次口就会被永远吞掉，而 worker 那边
  // 照常生成、照常推、照常记「我说过这句」。几天后角色会说「我连着叫你三天你都不理我」。
  it('角色自排的 daily 任务不被当成一次性吞掉（顶层 recurrenceType 说了算）', async () => {
    const charId = 'char-selfsched-daily';
    await DB.saveCharacter({ id: charId, name: '每日提醒角色' } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3 * 3_600_000;   // 排程那一刻的锚点：三小时前
    // 用户在锚点之后开过口，但离本次触发还有两小时——一次性任务的判据（锚点之后有新
    // 消息就作废）会中招，循环任务的窗口（触发时刻前 10 分钟起算）够不着它。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '在吗',
      timestamp: occurrenceMs - 2 * 3_600_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-selfsched-daily',
      charId,
      charName: '每日提醒角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'daily',   // push 顶层，库盖的
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-selfsched',
        // 角色自排那条路径不往 metadata 抄 recurrence，这里刻意留空。
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs.length, '循环任务不该被防穿帮闸吞掉').toBeGreaterThan(0);
  }, 20000);

  // 送达正文的同时认领自排任务，让面板、取消操作与凭据刷新都能找到它。
  it('送达时用户正在聊天，正文与角色自排任务都保留', async () => {
    const charId = 'char-adopt-before-gate';
    await DB.saveCharacter({
      id: charId, name: '自排角色', activeMsg2Config: { enabled: true, tasks: [] },
    } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3_600_000;
    // 到点前一分钟用户还在说话，但推送已发出，接收端仍须保留正文。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '我在忙',
      timestamp: occurrenceMs - 60_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-adopt-before-gate',
      charId,
      charName: '自排角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'daily',
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-adopt',
        amsgSelfScheduled: [{
          taskUuid: 'amsgself-adopt-1',
          clientTaskId: 'client-task-adopt-next',
          mode: 'auto',
          firstSendTime: new Date(occurrenceMs + 90 * 60_000).toISOString(),
          recurrenceType: 'none',
          expirePolicy: 'expire',
          source: 'character',
          status: 'scheduled',
          createdAt: occurrenceMs,
        }],
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    expect(await assistantMsgs(charId), '发出的正文不能再按聊天状态作废').toHaveLength(1);
    const char = (await DB.getAllCharacters()).find((c) => c.id === charId);
    expect(
      char?.activeMsg2Config?.tasks?.map((t: any) => t.taskUuid),
      '正文落库的同时认领自排任务',
    ).toContain('amsgself-adopt-1');
  }, 20000);

  it('已发出消息不再二次作废，保留接收 trace', async () => {
    localStorage.removeItem('instant_push_trace_log_v1');
    const charId = 'char-scheduled-accepted';
    await DB.saveCharacter({ id: charId, name: '留痕角色' } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 3_600_000;
    const lastUserAt = occurrenceMs - 60_000;   // 到点前一分钟还在聊 → 循环任务判作废
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '我在忙', timestamp: lastUserAt,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-scheduled-accepted',
      charId,
      charName: '留痕角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'daily',
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-accepted',
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    expect(await assistantMsgs(charId), '已送达的消息应进入聊天').toHaveLength(1);
    const decision = readAllInstantTraces()
      .find((e) => e.event === 'runtime-scheduled-delivery-accepted');
    expect(decision, '收到推送应留下接收记录').toBeTruthy();
    expect(decision).toMatchObject({ charId, messageId: 'msg-scheduled-accepted' });
  }, 20000);

  // 线上真实事故的最小复现：角色半夜说「明早九点半叫你起床」，用户回一句「晚安」，
  // 七小时后那条早安到了设备上却被这一层判成「对话已经前进了」整条吞掉——不进聊天流、
  // 不弹提示、还去云端账本销了账，而通知早就弹到锁屏上了。用户看到的是「通知说角色
  // 发了消息，点进去什么都没有」，消息再也补不回来。
  // 锚点规则没有时间窗，跨夜任务几乎必然中招（说完「明早叫你」，用户基本一定会再回
  // 一句），所以客户端这一层不再跑它。这条测试就是那道闸别被顺手加回来的守卫。
  it('跨夜的一次性任务不再被吞：说完「明早叫你」之后用户回过话，早安照样送达', async () => {
    const charId = 'char-overnight-oneshot';
    await DB.saveCharacter({ id: charId, name: '叫早角色' } as any);

    const occurrenceMs = Date.now();
    const anchorMs = occurrenceMs - 8 * 3_600_000;        // 八小时前排的任务
    await DB.saveMessage({                                 // 排完之后用户回了句「晚安」
      charId, role: 'user', type: 'text', content: '好，晚安',
      timestamp: anchorMs + 60_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-overnight-oneshot',
      charId,
      charName: '叫早角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'none',
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-overnight',
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    expect(await assistantMsgs(charId), '跨夜的早安不该被锚点规则吞掉').toHaveLength(1);
  }, 20000);

  it('送达时用户没有新发言，同样记录接收结果', async () => {
    localStorage.removeItem('instant_push_trace_log_v1');
    const charId = 'char-gate-trace-pass';
    await DB.saveCharacter({ id: charId, name: '放行角色' } as any);

    const occurrenceMs = Date.now();
    // 用户最后一次开口在锚点之前 → 一次性任务照发。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '晚安', timestamp: occurrenceMs - 7_200_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-gate-trace-pass',
      charId,
      charName: '放行角色',
      messageType: 'text',
      source: 'scheduled',
      recurrenceType: 'none',
      occurrenceMs,
      metadata: {
        charId,
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: 'client-task-trace-pass',
      },
      sentAt: occurrenceMs,
    }));

    await flushInboxToChat('SW通知');

    expect(await assistantMsgs(charId), '前提：这条该放行').toHaveLength(1);
    expect(
      readAllInstantTraces().some((e) => e.event === 'runtime-scheduled-delivery-accepted'),
      '放行也要留痕',
    ).toBe(true);
  }, 20000);

  /**
   * 这条守的是「排障能力本身」。收件箱里的消息有七八条路能捞出来，其中只有 SW 实时喊
   * 页面那条是快的，其余（轮询、回前台、补收）都带着几秒到一分钟的固有延迟。线上出过
   * 一次实时通道整个断掉、消息全靠 60 秒轮询兜底的故障——功能表面正常，只是每条都白等，
   * 而当时的记录里没有触发源，只能靠算时间差反推。所以这个字段必须一直在。
   */
  it('每趟冲刷都要记下是谁触发的，否则查不出实时通道断没断', async () => {
    const charId = 'char-flush-trigger';
    await DB.saveCharacter({ id: charId, name: '触发源角色' } as any);
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-flush-trigger',
      charId,
      messageType: 'text',
      sentAt: Date.now(),
    }));

    await flushInboxToChat('轮询补收');

    const flushStarts = readAllInstantTraces().filter((e) => e.event === 'runtime-flush-start');
    expect(flushStarts.length, '前提：这趟冲刷要留痕').toBeGreaterThan(0);
    expect(
      flushStarts.some((e) => e.trigger === '轮询补收'),
      '冲刷记录里必须带上触发源',
    ).toBe(true);
  }, 20000);

  it('主路径·刚送达：一样落 sentAt（本地没有更晚的消息，不需要退让）', async () => {
    const charId = 'char-ts-main-fresh';
    await DB.saveCharacter({ id: charId, name: '在线角色' } as any);
    const sentAt = Date.now() - 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-fresh',
      charId,
      messageType: 'text',
      sentAt,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBe(sentAt);
  }, 20000);

  // 到点弹通知、用户隔几分钟才点进来 —— 这一例的旧行为是把气泡标成点进来的那一刻。
  it('主路径·点通知隔 8 分钟进来：落 sentAt，不是点进来的那一刻', async () => {
    const charId = 'char-ts-main-notif';
    await DB.saveCharacter({ id: charId, name: '定时角色' } as any);
    const sentAt = Date.now() - 8 * 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-notif',
      charId,
      messageType: 'text',
      sentAt,
    }));

    const before = Date.now();
    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m.timestamp).toBe(sentAt);
      expect(m.timestamp, '别再标成点进来的那一刻').toBeLessThan(before);
    }
  }, 20000);

  // 倒挂守卫仍然在岗：用户先说了话，补收的消息就不能标成比它更早。
  it('主路径·补收时本地已有更晚的消息 → 退回写库当刻，时间戳不倒挂', async () => {
    const charId = 'char-ts-main-backfill';
    await DB.saveCharacter({ id: charId, name: '倒挂守卫角色' } as any);
    const sentAt = Date.now() - 13 * 3_600_000;   // 昨晚推的
    // 用户今天打开 App 先说了一句，落库时刻比 sentAt 晚得多。
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '早',
      timestamp: Date.now() - 5_000,
    } as any);

    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-backfill',
      charId,
      messageType: 'text',
      sentAt,
    }));

    const before = Date.now();
    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBeGreaterThanOrEqual(before);
  }, 20000);

  it('降级存原稿路径·离线补收：与主路径同口径，落 sentAt', async () => {
    const charId = 'char-ts-raw-stale';
    const sentAt = Date.now() - 13 * 3_600_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-raw-stale',
      charId,
      messageType: 'forum', // 白名单外 → 不走 post-processing，直接原稿落库
      sentAt,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('还没睡吗，早点休息');
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);

  // 接线守卫：判据（isFreshInboxDelivery）算出来的结论要真的传到后处理管线去。
  //
  // 阈值锚在真实常量上，不是拍脑袋的容差：拟人打字延迟每条气泡至少 500ms
  // （applyAssistantPostProcessing 的 `Math.max(chunk.length * 50, 500)`），所以
  // 「跑没跑那个 setTimeout」在耗时上是 500ms 起 vs 几十毫秒的落库开销，中间隔着
  // 一整个数量级。取 400ms 当界：慢机器把落库拖慢几倍也够不着，而慢放路径必然超过。
  // （别改成「补收比实时快」这种相对比较——接线被删掉时两边都慢放、耗时相当，
  //   谁快谁慢就由噪声决定，测试会时过时挂。）
  it('补收的消息跳过拟人打字延迟，实时收到的照旧慢放', async () => {
    const runFlush = async (charId: string, receivedAt: number) => {
      await DB.saveCharacter({ id: charId, name: '打字节奏角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: `msg-pace-${charId}`,
        charId,
        messageType: 'text',
        sentAt: receivedAt,
        receivedAt,
      }));
      const t0 = Date.now();
      await flushInboxToChat('SW通知');
      return Date.now() - t0;
    };

    const freshMs = await runFlush('char-pace-fresh', Date.now());
    const staleMs = await runFlush('char-pace-stale', Date.now() - 8 * 60_000);

    // 实时那条确实慢放了，否则下面那条断言就成了空气
    expect(freshMs, '实时送达该保留打字节奏').toBeGreaterThan(400);
    expect(staleMs, '补收该跳过打字延迟').toBeLessThan(400);
  }, 20000);

  // 接线守卫：第二个判据（wasDeliveredWhileAway）也要真的传到后处理管线去。
  //
  // 这条跟上一条的差别只有「送达时用户在不在场」：消息一样新鲜，一样走实时口径。
  // 人不在场时系统通知已经把整句话显示完了，再演一遍打字过程就只剩干等——这正是
  // 「通知都看到了，App 里还得再等几十秒」那个反馈的后半截。
  // 阈值同上：慢放每条气泡至少 500ms，落库开销是几十毫秒，取 400ms 当界。
  it('实时送达、但送达时用户不在场 → 也跳过慢放（他已经在通知里读过了）', async () => {
    const charId = 'char-pace-away';
    await DB.saveCharacter({ id: charId, name: '缺席送达角色' } as any);
    const receivedAt = Date.now();
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-pace-away',
      charId,
      messageType: 'text',
      sentAt: receivedAt,
      receivedAt,
    }));

    // 消息落到设备之后，用户才把页面切回前台 = 他是从通知知道这条消息的。
    notePageBecameVisible(receivedAt + 1_000);
    const t0 = Date.now();
    try {
      await flushInboxToChat('SW通知');
    } finally {
      notePageBecameVisible(0); // 全局状态，别漏给后面的用例
    }

    expect(Date.now() - t0, '人不在场时该跳过打字延迟').toBeLessThan(400);
  }, 20000);

  // 同一条推送的「第二次到达」（outbox 补收先落库、被推送服务延迟的原始 push 几分钟后
  // 才送达；或补收销账时 cancelTask 没拦住、worker 重试重跑复用同 messageId）不该再上
  // 屏一遍：落库前按聊天近史里的 activeMsg2.messageId 去重。
  it('聊天记录里已有同 messageId → 第二次到达整条丢弃，不重复上屏', async () => {
    const charId = 'char-dedup-redelivery';
    await DB.saveCharacter({ id: charId, name: '去重角色' } as any);
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg_task_9@1700000000000_hook_0',
      charId,
      messageType: 'text',
      sentAt: Date.now() - 8 * 60_000, // 走补收口径，跳过拟人慢放
    }));
    await flushInboxToChat('SW通知');
    const first = await assistantMsgs(charId);
    expect(first.length).toBeGreaterThan(0);

    // 同一条（同 messageId）再次入库 = 迟到的原始推送终于送达
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg_task_9@1700000000000_hook_0',
      charId,
      messageType: 'text',
      sentAt: Date.now() - 8 * 60_000,
    }));
    await flushInboxToChat('SW通知');

    expect((await assistantMsgs(charId)).length, '第二次到达不能再上屏').toBe(first.length);
  }, 20000);

  // 即时对话的情绪评估在 worker 里跟主回复并行跑，结果挂在最后一条推送的 metadata 上。
  // 收侧得跟单独一条 emotion_update 消息走同一条链：同一个 applyEmotionEvalRaw 落 buff、
  // 同一个 'instant-emotion-done' 熄灯。漏了这一段，用户看到的是「回复来了、情绪永远不更新、
  // 头顶那盏『情绪更新中』亮满十一分钟」。
  describe('即时对话带回来的情绪评估', () => {
    /** 记下这一段派了哪些事件（spy 而不是手工换函数：restore 交给 vitest，漏还原不了）。 */
    const captureEvents = () => {
      const seen: Array<{ type: string; detail: any }> = [];
      const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: any) => {
        seen.push({ type: event?.type, detail: event?.detail });
        return true;
      });
      return { seen, restore: () => spy.mockRestore() };
    };

    it('评估原文随回复一起到 → 落 buff + 熄灯（跟 emotion_update 同一条链）', async () => {
      const charId = 'char-emotion-inline';
      await DB.saveCharacter({ id: charId, name: '情绪角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-inline',
        charId,
        charName: '情绪角色',
        messageType: 'text',
        metadata: {
          charId,
          amsgEmotionDone: true,
          amsgEmotionUpdate: JSON.stringify({
            changed: true,
            buffs: [{ label: '雀跃', emoji: '✨', intensity: 3 }],
            injection: '你此刻心情很好。',
            innerState: '他记得我说过的话。',
          }),
        },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
      }

      const updated = (await DB.getAllCharacters()).find((c) => c.id === charId)!;
      expect(updated.activeBuffs?.map((b: any) => b.label)).toContain('雀跃');
      expect(updated.buffInjection).toContain('心情很好');
      // 意识流喂给下一轮 + 徽章熄灭，两个事件都得发（点灯的那一侧只认它们）
      expect(seen.some((e) => e.type === 'emotion-innerstate-updated' && e.detail?.charId === charId)).toBe(true);
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(true);
      // 正文照常上屏：情绪只是附赠，不能把这条消息带跑
      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);
    }, 20000);

    it('云端评估没跑出东西 → 照样熄灯，并把 worker 捎回来的原因原样给用户看', async () => {
      const charId = 'char-emotion-empty';
      await DB.saveCharacter({ id: charId, name: '空评估角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-empty',
        charId,
        charName: '空评估角色',
        messageType: 'text',
        metadata: { charId, amsgEmotionDone: true, amsgEmotionError: '副 API HTTP 401：no credit' },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
      }

      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(true);
      const failed = seen.find((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId);
      expect(failed).toBeTruthy();
      // 「可查 worker 日志」对自己部署 worker 的用户等于没说；具体状态码才查得下去
      expect(failed!.detail.reason).toContain('副 API HTTP 401');
      expect(failed!.detail.reason).toContain('no credit');
    }, 20000);

    it('老 worker 没带原因 → 退回那句笼统的（不至于什么都不说）', async () => {
      const charId = 'char-emotion-noreason';
      await DB.saveCharacter({ id: charId, name: '旧版角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-noreason',
        charId,
        charName: '旧版角色',
        messageType: 'text',
        metadata: { charId, amsgEmotionDone: true },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
      }

      const failed = seen.find((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId);
      expect(failed!.detail.reason).toContain('云端情绪评估无输出');
    }, 20000);

    // 晚投：worker 那头评估没赶上回复，push 只挂引用键 + pending 标记，结果收尾时才写进
    // 旁路。收侧不许当场熄灯（结论还没有），也不许立刻按 ref 取（键多半还空着，白打
    // 一个「被下一轮覆盖」的 warn）。回归守卫——旧行为会把 ref 当旁路结果取、当场熄灯。
    it('晚投标记（amsgEmotionPending）→ 不熄灯、不立刻取，交给补落轮询', async () => {
      const charId = 'char-emotion-pending';
      await DB.saveCharacter({ id: charId, name: '晚投角色' } as any);
      const ref = 'emotion_update:client-task-late';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValue(JSON.stringify({ changed: true, buffs: [] }));

      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-pending',
        charId,
        charName: '晚投角色',
        messageType: 'text',
        metadata: { charId, amsgEmotionPending: true, amsgEmotionRef: ref },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
        // 收掉这一轮排下的补落定时器，别让它带着生产间隔漂进后面的测试
        cancelLateEmotionPoll(charId);
      }

      // 结论未到：灯不熄、不报失败、也不立刻去读旁路键
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(false);
      expect(seen.some((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId)).toBe(false);
      expect(readSpy).not.toHaveBeenCalled();
      // 正文照常上屏
      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);
      readSpy.mockRestore();
    }, 20000);

    it('补落轮询：第二跳等到结果 → 落 buff + 熄灯 + 删云端副本', async () => {
      const charId = 'char-emotion-late-land';
      await DB.saveCharacter({ id: charId, name: '补落角色' } as any);
      const ref = 'emotion_update:client-task-land';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValueOnce(null)
        .mockResolvedValue(JSON.stringify({
          changed: true,
          buffs: [{ label: '释然', emoji: '🌤', intensity: 2 }],
          injection: '你此刻很释然。',
        }));
      const clearSpy = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined as any);

      const { seen, restore } = captureEvents();
      try {
        startLateEmotionPoll(charId, ref, '补落角色', { intervalMs: 10, maxTries: 5 });
        await vi.waitFor(() => {
          expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
        }, { timeout: 5000 });
      } finally {
        restore();
        cancelLateEmotionPoll(charId);
      }

      const updated = (await DB.getAllCharacters()).find((c) => c.id === charId)!;
      expect(updated.activeBuffs?.map((b: any) => b.label)).toContain('释然');
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(true);
      expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      readSpy.mockRestore();
      clearSpy.mockRestore();
    }, 20000);

    it('补落轮询：跳数用尽还没等到 → 报「最终没等到」+ 熄灯', async () => {
      const charId = 'char-emotion-late-timeout';
      await DB.saveCharacter({ id: charId, name: '超时角色' } as any);
      const ref = 'emotion_update:client-task-timeout';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);

      const { seen, restore } = captureEvents();
      try {
        startLateEmotionPoll(charId, ref, '超时角色', { intervalMs: 10, maxTries: 3 });
        await vi.waitFor(() => {
          expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(true);
        }, { timeout: 5000 });
      } finally {
        restore();
        cancelLateEmotionPoll(charId);
      }

      const failed = seen.find((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId);
      expect(failed).toBeTruthy();
      expect(failed!.detail.reason).toContain('最终没等到');
      expect(readSpy).toHaveBeenCalledTimes(3);
      readSpy.mockRestore();
    }, 20000);

    it('装不下时挪进 client_state：按 amsgEmotionRef 取回来照样落 buff，用完就删', async () => {
      const charId = 'char-emotion-ref';
      await DB.saveCharacter({ id: charId, name: '旁路角色' } as any);
      const ref = 'emotion_update:client-task-ref';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValue(JSON.stringify({
          changed: true,
          buffs: [{ label: '安心', emoji: '🍵', intensity: 2 }],
          injection: '你此刻很安心。',
        }));
      const clearSpy = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined as any);

      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-ref',
        charId,
        charName: '旁路角色',
        messageType: 'text',
        metadata: { charId, amsgEmotionDone: true, amsgEmotionRef: ref },
      }));

      await flushInboxToChat('SW通知');

      expect(readSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
      const updated = (await DB.getAllCharacters()).find((c) => c.id === charId)!;
      expect(updated.activeBuffs?.map((b: any) => b.label)).toContain('安心');
      expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
      readSpy.mockRestore();
      clearSpy.mockRestore();
    }, 20000);

    // 降级存原稿（post-processing 失败到头 / 白名单外类型）也要消费情绪附赠：全仓库
    // 唯一的消费点在主路径里面，降级只把 metadata 原样抄进聊天记录的话，结果永远无人
    // 再读——徽章亮满十来分钟的安全网，然后弹「worker 可能是旧版」的假告警，其实结论
    // 早就到了本地。
    it('降级存原稿路径 → 照样落 buff + 熄灯（结果不能躺在 metadata 里烂掉）', async () => {
      const charId = 'char-emotion-degraded';
      await DB.saveCharacter({ id: charId, name: '降级角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-degraded',
        charId,
        charName: '降级角色',
        messageType: 'forum', // 白名单外 → 不走 post-processing，直接原稿落库（routed=false）
        metadata: {
          charId,
          amsgEmotionDone: true,
          amsgEmotionUpdate: JSON.stringify({
            changed: true,
            buffs: [{ label: '释然', emoji: '🌿', intensity: 2 }],
            injection: '你此刻很释然。',
          }),
        },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
      }

      const updated = (await DB.getAllCharacters()).find((c) => c.id === charId)!;
      expect(updated.activeBuffs?.map((b: any) => b.label), '降级路径也要落 buff').toContain('释然');
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId),
        '降级路径也要熄灯，别把安全网的假告警等出来').toBe(true);
      // 原稿本体照常上屏
      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);
    }, 20000);

    // 降级 × 晚投的组合：降级分支也得认 pending 标记——旧行为是立刻按 ref 去读旁路
    // （键还空着，白打「被下一轮覆盖」的 warn），然后既不熄灯也不补落，安全网到点弹
    // 「worker 可能是旧版」的假告警。回归守卫——旧行为下 readSpy 会被立即调用。
    it('降级存原稿 × 晚投标记 → 不熄灯、不立刻取，交给补落轮询', async () => {
      const charId = 'char-emotion-degraded-pending';
      await DB.saveCharacter({ id: charId, name: '降级晚投角色' } as any);
      const ref = 'emotion_update:client-task-degraded-late';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValue(JSON.stringify({ changed: true, buffs: [] }));

      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-emotion-degraded-pending',
        charId,
        charName: '降级晚投角色',
        messageType: 'forum', // 白名单外 → 降级存原稿分支（routed=false）
        metadata: { charId, amsgEmotionPending: true, amsgEmotionRef: ref },
      }));

      const { seen, restore } = captureEvents();
      try {
        await flushInboxToChat('SW通知');
      } finally {
        restore();
        // 收掉这一轮排下的补落定时器，别让它带着生产间隔漂进后面的测试
        cancelLateEmotionPoll(charId);
      }

      // 结论未到：灯不熄、不报失败、也不立刻去读旁路键
      expect(seen.some((e) => e.type === 'instant-emotion-done' && e.detail?.charId === charId)).toBe(false);
      expect(seen.some((e) => e.type === CHAT_GEN_EVENTS.emotionFailed && e.detail?.charId === charId)).toBe(false);
      expect(readSpy).not.toHaveBeenCalled();
      // 原稿本体照常上屏
      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);
      readSpy.mockRestore();
    }, 20000);
  });

  // 聊天走即时对话时，思考是在 worker 里生成的，客户端手上没有那份 reasoning。
  // worker 把它挂在第一条 push 的 metadata.amsgReasoning 上；收侧不认的话，用户开着
  // 「显示思考链」却只在本地生成时看得到卡片，云端这条路整个缺席。
  describe('云端带回来的思考链', () => {
    const thinkingChainOf = async (charId: string) =>
      (await assistantMsgs(charId)).map((m: any) => m.metadata?.thinkingChain).filter(Boolean);

    it('随第一条 push 回来 → 挂到第一条气泡的 thinkingChain 上', async () => {
      const charId = 'char-reasoning-inline';
      await DB.saveCharacter({ id: charId, name: '会思考的角色', showThinkingChain: true } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-reasoning-inline',
        charId,
        charName: '会思考的角色',
        messageType: 'text',
        metadata: { charId, messageIndex: 1, amsgReasoning: '他这句问得很轻，先接住。' },
      }));

      await flushInboxToChat('SW通知');

      expect(await thinkingChainOf(charId)).toEqual(['他这句问得很轻，先接住。']);
    }, 20000);

    it('太长挪进了 client_state → 按 amsgReasoningRef 取回来，用完就删', async () => {
      const charId = 'char-reasoning-ref';
      await DB.saveCharacter({ id: charId, name: '想很多的角色', showThinkingChain: true } as any);
      const ref = 'reasoning:client-task-reasoning';
      const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
        .mockResolvedValue('想了很久才决定这么说。');
      const clearSpy = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined as any);

      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-reasoning-ref',
        charId,
        charName: '想很多的角色',
        messageType: 'text',
        metadata: { charId, messageIndex: 1, amsgReasoningRef: ref },
      }));

      await flushInboxToChat('SW通知');

      expect(readSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
      expect(await thinkingChainOf(charId)).toEqual(['想了很久才决定这么说。']);
      expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), ref);
      readSpy.mockRestore();
      clearSpy.mockRestore();
    }, 20000);

    it('不可变附件按引用取回心象，成功落库后仍保留云端副本', async () => {
      const charId = 'char-reasoning-attachment';
      await DB.saveCharacter({ id: charId, name: '心象角色', showThinkingChain: true } as any);
      const ref = { version: 1 as const, namespace: 'amsg:attachments', key: 'unique-reasoning', taskUuid: 'task-attachment',
        occurrenceMs: Date.now(), expiresAt: Date.now() + 86_400_000 };
      const read = vi.spyOn(ActiveMsgClient, 'readAttachment').mockResolvedValue('这次慢慢说给你听。');
      const clear = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({ messageId: 'reasoning-attachment-message', charId,
        metadata: { charId, messageIndex: 1, amsgReasoningAttachment: ref },
      }));
      await flushInboxToChat('SW通知');
      expect(await thinkingChainOf(charId)).toEqual(['这次慢慢说给你听。']);
      expect(read).toHaveBeenCalledWith(ref);
      expect(clear).not.toHaveBeenCalled();
      read.mockRestore();
      clear.mockRestore();
    }, 20000);

    // 卡片只能挂第一条气泡。后面几段要是也认，同一段思考会在这轮对话里重复冒出来。
    it('后面几段 push 不认（哪怕 worker 出 bug 每条都挂）', async () => {
      const charId = 'char-reasoning-late';
      await DB.saveCharacter({ id: charId, name: '第二段角色', showThinkingChain: true } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-reasoning-late',
        charId,
        charName: '第二段角色',
        messageType: 'text',
        metadata: { charId, messageIndex: 2, amsgReasoning: '这段不该出现在卡片里。' },
      }));

      await flushInboxToChat('SW通知');

      expect((await assistantMsgs(charId)).length).toBeGreaterThan(0);   // 正文照常上屏
      expect(await thinkingChainOf(charId)).toEqual([]);
    }, 20000);
  });

  // worker 把「这一轮跑过哪些工具」挂在最后一条 push 的 metadata.amsgToolTrace 上，
  // 气泡底下那行灰字照它渲染。它走的是 mcdInheritMeta 这条通道——push 的 metadata 整份
  // 铺到每条落库的气泡上。这一份必须铺进去，哪天漏了，这行灰字会静默消失
  // （用户只看到角色凭空知道了新闻）。
  describe('云端带回来的工具痕迹', () => {
    const TRACE = [{ name: 'web_search', count: 2 }, { name: 'recall', count: 1 }];

    it('随 push 回来 → 落到这条 push 拆出的气泡 metadata 上，跟固定那几个字段并存', async () => {
      const charId = 'char-tooltrace';
      await DB.saveCharacter({ id: charId, name: '会查东西的角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-tooltrace',
        charId,
        charName: '会查东西的角色',
        messageType: 'text',
        body: '我看了下。\n没什么大事。',
        // 补收（跳过打字节奏），这条用例只关心元数据落到哪
        receivedAt: Date.now() - 3_600_000,
        sentAt: Date.now() - 3_600_000,
        metadata: { charId, amsgToolTrace: TRACE },
      }));

      await flushInboxToChat('SW通知');

      const msgs = await assistantMsgs(charId);
      expect(msgs.length).toBeGreaterThan(0);
      for (const m of msgs) {
        expect((m.metadata as any)?.amsgToolTrace).toEqual(TRACE);
        // 同一份 metadata 里那几个固定字段照旧在：痕迹是加进来的，不是挤掉别人换来的
        expect((m.metadata as any)?.source).toBe('active_msg_2');
        expect((m.metadata as any)?.activeMsg2?.messageId).toBe('msg-tooltrace');
      }
    }, 20000);

    it('没跑工具的那一轮 → 气泡上一个字段都没有', async () => {
      const charId = 'char-tooltrace-none';
      await DB.saveCharacter({ id: charId, name: '没查东西的角色' } as any);
      await ActiveMsgStore.saveInboxMessage(inboxMsg({
        messageId: 'msg-tooltrace-none',
        charId,
        charName: '没查东西的角色',
        messageType: 'text',
        receivedAt: Date.now() - 3_600_000,
        sentAt: Date.now() - 3_600_000,
        metadata: { charId },
      }));

      await flushInboxToChat('SW通知');

      const msgs = await assistantMsgs(charId);
      expect(msgs.length).toBeGreaterThan(0);
      for (const m of msgs) expect((m.metadata as any)?.amsgToolTrace).toBeUndefined();
    }, 20000);
  });

  it('降级存原稿路径·刚送达：与主路径同口径，落 sentAt', async () => {
    const charId = 'char-ts-raw-fresh';
    const sentAt = Date.now() - 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-raw-fresh',
      charId,
      messageType: 'forum',
      sentAt,
    }));

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);
});

// ─── ② pushsubscriptionchange 标记消费（真库 fake-indexeddb）───
// SW 换订阅时往 ActiveMsg 库 kv store 写固定 key 的标记（worker/sw-keep-alive.ts），
// 这里钉主线程的消费口径：有标记才刷；刷成功才清；不支持 / 部分失败 / 抛错都留着
// 下次再试（清了就再也没人补——marker 只在 pushsubscriptionchange 那一刻写一次）。
describe('refreshPushSubscriptionIfMarked', () => {
  const openAmsgDb = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ActiveMsg');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  /** 按 SW 写入的同款记录形状（KvRecord {id, value}）把标记放进真库。 */
  const putMarker = async () => {
    await ActiveMsgStore.getGlobalConfig(); // 先把 schema 建到当前版本（含 kv store）
    const db = await openAmsgDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({
        id: PUSH_SUBSCRIPTION_CHANGED_KV_ID,
        value: { changedAt: Date.now(), resubscribed: false },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  const markerExists = async (): Promise<boolean> => {
    const db = await openAmsgDb();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const request = tx.objectStore('kv').get(PUSH_SUBSCRIPTION_CHANGED_KV_ID);
        request.onsuccess = () => resolve(Boolean(request.result));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };

  const clearMarker = async () => {
    const db = await openAmsgDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(PUSH_SUBSCRIPTION_CHANGED_KV_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMarker();
  });

  it('没有标记 → 不发起登记', async () => {
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription')
      .mockResolvedValue(undefined);

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('no-marker');
    expect(register).not.toHaveBeenCalled();
  });

  // 登记是一次覆盖写，覆盖到的是用户级那一份订阅——本地知不知道有哪些任务、有没有
  // 任务，都跟它无关。所以只有「成功清标记 / 失败留标记」两种归宿。
  it('有标记 + 登记成功 → 调一次并清掉标记', async () => {
    await putMarker();
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription')
      .mockResolvedValue(undefined);

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('refreshed');
    expect(register).toHaveBeenCalledTimes(1);
    await expect(markerExists()).resolves.toBe(false);
  });

  it('登记抛错（断网 / 权限被收回）→ 标记保留下次再试', async () => {
    await putMarker();
    vi.spyOn(ActiveMsgClient, 'registerPushSubscription')
      .mockRejectedValue(new Error('offline'));

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('kept');
    await expect(markerExists()).resolves.toBe(true);
  });
});

// ─── ③ 角色自排任务：认领之后要广播出去 ───
// 认领只写了 IndexedDB 的话，React 那侧内存里的任务清单还是旧的：任务面板列不出这条、
// 按任务数 / 凭据 / 订阅这三道门做判断的地方也都看不见它，而它照常到点触发。
// 事件名和 detail 形状是与 OSContext 监听侧的约定，这组用例把它钉死。
describe('认领角色自排任务后广播 amsg2-tasks-adopted', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** 把 flush 期间派发的事件都收下来（node 环境没有真 window，只记录不分发）。 */
  const captureEvents = (): any[] => {
    const seen: any[] = [];
    vi.spyOn((globalThis as any).window, 'dispatchEvent')
      .mockImplementation((event: any) => { seen.push(event); return true; });
    return seen;
  };

  const selfScheduledTask = (taskUuid: string, at: number) => ({
    taskUuid,
    clientTaskId: `client-${taskUuid}`,
    mode: 'auto',
    firstSendTime: new Date(at + 90 * 60_000).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    source: 'character',
    status: 'scheduled',
    createdAt: at,
  });

  const pushWithSelfScheduled = (charId: string, messageId: string, tasks: unknown[]) =>
    ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '自排角色',
      body: '晚点再找你',
      // 白名单外的类型 → 走原稿落库，不必为这组用例跑整条后处理管线。
      messageType: 'forum',
      receivedAt: Date.now(),
      metadata: { charId, amsgSelfScheduled: tasks },
    } as any);

  it('认领到新任务 → 派发一次，detail.charId 是这个角色', async () => {
    const charId = 'char-adopt-event';
    const now = Date.now();
    await DB.saveCharacter({
      id: charId, name: '自排角色', activeMsg2Config: { enabled: true, tasks: [] },
    } as any);
    await pushWithSelfScheduled(charId, 'msg-adopt-event-1', [selfScheduledTask('amsgself-evt-1', now)]);

    const events = captureEvents();
    await flushInboxToChat('SW通知');

    const adopted = events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT);
    expect(adopted, '修复前只写库不广播，这里拿到 0 条').toHaveLength(1);
    expect(adopted[0].detail).toEqual({ charId });
  }, 20000);

  it('同一条任务再来一次（push 重放）→ 不重复派发，别让 UI 白重读', async () => {
    const charId = 'char-adopt-event-dup';
    const now = Date.now();
    await DB.saveCharacter({
      id: charId,
      name: '自排角色',
      activeMsg2Config: { enabled: true, tasks: [selfScheduledTask('amsgself-evt-dup', now)] },
    } as any);
    await pushWithSelfScheduled(charId, 'msg-adopt-event-2', [selfScheduledTask('amsgself-evt-dup', now)]);

    const events = captureEvents();
    await flushInboxToChat('SW通知');

    expect(events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT)).toHaveLength(0);
  }, 20000);

  // 对称的消账侧：角色在 fire 里取消 / 改期掉的既有任务（amsgTaskMutations）。
  // D1 行已经没了（或换了时间），本地清单不跟着动的话，面板会一直列着一条
  // 永远不会响（或时间不对）的任务。
  it('取消 + 改期随 amsgTaskMutations 落到本地清单，并广播一次', async () => {
    const charId = 'char-mutations';
    const now = Date.now();
    const keep = selfScheduledTask('amsgself-mut-keep', now);
    const gone = selfScheduledTask('amsgself-mut-gone', now);
    const moved = selfScheduledTask('amsgself-mut-moved', now);
    const newSendAt = new Date(now + 5 * 3600_000).toISOString();
    await DB.saveCharacter({
      id: charId, name: '自排角色', activeMsg2Config: { enabled: true, tasks: [keep, gone, moved] },
    } as any);
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-mutations-1',
      charId,
      charName: '自排角色',
      body: '那条不用等了',
      messageType: 'forum',
      receivedAt: Date.now(),
      metadata: {
        charId,
        amsgTaskMutations: {
          cancelled: ['amsgself-mut-gone'],
          renewed: [{ taskUuid: 'amsgself-mut-moved', sendAt: newSendAt }],
        },
      },
    } as any);

    const events = captureEvents();
    await flushInboxToChat('SW通知');

    const chars = await DB.getAllCharacters();
    const tasks = chars.find((c: any) => c.id === charId)?.activeMsg2Config?.tasks ?? [];
    expect(tasks.map((t: any) => t.taskUuid).sort()).toEqual(['amsgself-mut-keep', 'amsgself-mut-moved']);
    const renewed = tasks.find((t: any) => t.taskUuid === 'amsgself-mut-moved');
    expect(renewed?.firstSendTime).toBe(newSendAt);
    expect(renewed?.nextSendAt).toBe(newSendAt);
    expect(events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT)).toHaveLength(1);
  }, 20000);

  it('账已经平了（重放同一份 mutations）→ 不写库不广播', async () => {
    const charId = 'char-mutations-replay';
    const now = Date.now();
    await DB.saveCharacter({
      id: charId, name: '自排角色',
      activeMsg2Config: { enabled: true, tasks: [selfScheduledTask('amsgself-mut-r', now)] },
    } as any);
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-mutations-replay-1',
      charId,
      charName: '自排角色',
      body: '……',
      messageType: 'forum',
      receivedAt: Date.now(),
      metadata: {
        charId,
        // 取消的那条本地早就没有了 → 清单不变，什么都不该发生
        amsgTaskMutations: { cancelled: ['amsgself-mut-already-gone'] },
      },
    } as any);

    const events = captureEvents();
    await flushInboxToChat('SW通知');

    expect(events.filter((e) => e.type === AMSG2_TASKS_ADOPTED_EVENT)).toHaveLength(0);
  }, 20000);
});

// ─── ⑤ 多段消息的等齐守卫 ───
// 一次生成拆成几条 push，Web Push 不保证按序到达；App 开着时每条 push 各触发一次 flush，
// 两段落进两批的话「同批按段序排」根本够不着——显示顺序按自增 id，后段先到就永久颠倒。
describe('findPersistedChunkIndexes / findMissingChunkIndexes', () => {
  const bubble = (sessionId: string, messageIndex: number, role = 'assistant') => ({
    role,
    metadata: { sessionId, messageIndex },
  });

  it('认出同 session 已经落过库的段序（一条 push 拆成几个气泡也只算一段）', () => {
    const found = findPersistedChunkIndexes(
      [bubble('S', 1), bubble('S', 1), bubble('S', 3), bubble('T', 2), bubble('S', 2, 'user')],
      'S',
    );
    expect([...found].sort()).toEqual([1, 3]);
  });

  it('前面的段都齐了 → 不缺；缺哪段就报哪段', () => {
    expect(findMissingChunkIndexes(3, new Set([1, 2]))).toEqual([]);
    expect(findMissingChunkIndexes(3, new Set([2]))).toEqual([1]);
    expect(findMissingChunkIndexes(3, new Set())).toEqual([1, 2]);
    expect(findMissingChunkIndexes(1, new Set()), '第一段没有前面的段').toEqual([]);
  });
});

describe('多段消息跨批到达的等齐守卫（走真库）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
    // 扣住时会排一次几秒后的重看；这组用例自己手动驱动 flush，别让真定时器插进来。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterAll(() => { vi.useRealTimers(); });

  const chunk = (charId: string, sessionId: string, index: number, total: number, body: string) =>
    ActiveMsgStore.saveInboxMessage({
      messageId: `${sessionId}-${index}`,
      charId,
      charName: '分段角色',
      body,
      // 白名单外 → 原稿落库，这组只关心落库顺序。
      messageType: 'forum',
      receivedAt: Date.now() + index,
      sentAt: Date.now() + index,
      metadata: { sessionId, messageIndex: index, totalMessages: total },
    } as any);

  const bodies = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50))
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);

  it('后段先到 → 先扣住等前段；前段到了之后两条按序落库', async () => {
    const charId = 'char-chunk-order';
    const sessionId = 'sess-order';
    await DB.saveCharacter({ id: charId, name: '分段角色' } as any);

    await chunk(charId, sessionId, 2, 2, '……不然我一个人吃不完');
    await flushInboxToChat('SW通知');

    expect(await bodies(charId), '修复前后段会直接落库，顺序就此固定').toEqual([]);
    expect(
      (await ActiveMsgStore.listInboxMessages()).map((m) => m.messageId),
      '被扣住的消息留在收件箱里等下一次',
    ).toEqual([`${sessionId}-2`]);

    await chunk(charId, sessionId, 1, 2, '晚上一起吃火锅吧');
    await flushInboxToChat('SW通知');

    expect(await bodies(charId)).toEqual(['晚上一起吃火锅吧', '……不然我一个人吃不完']);
  }, 20000);

  it('前段真丢了 → 扣到上限就放行，绝不永远扣着后段', async () => {
    const charId = 'char-chunk-giveup';
    const sessionId = 'sess-giveup';
    await DB.saveCharacter({ id: charId, name: '分段角色' } as any);

    await chunk(charId, sessionId, 2, 2, '……你说呢');

    // 扣满上限的那几次
    for (let i = 0; i < MAX_INBOX_ORDER_HOLDS; i += 1) {
      await flushInboxToChat('SW通知');
      expect(await bodies(charId), `第 ${i + 1} 次还该扣着`).toEqual([]);
    }
    // 再来一次：放行
    await flushInboxToChat('SW通知');

    expect(await bodies(charId)).toEqual(['……你说呢']);
    expect(await ActiveMsgStore.listInboxMessages()).toEqual([]);
  }, 20000);

  it('第一段（messageIndex=1）从不扣，单条 push 也照常直接落库', async () => {
    const charId = 'char-chunk-first';
    const sessionId = 'sess-first';
    await DB.saveCharacter({ id: charId, name: '分段角色' } as any);

    await chunk(charId, sessionId, 1, 2, '在吗');
    await flushInboxToChat('SW通知');

    expect(await bodies(charId)).toEqual(['在吗']);
  }, 20000);
});

// ─── ⑥ 补收时间戳不能倒挂 ───
// 「打开 App」和「后台补投的 push 送到」之间隔着好几秒，用户来得及先说一句话。
// 这时候还按 sentAt 落库，聊天流里就会出现：08:01 用户说「早安」，下面紧跟着一条
// 标着昨晚 23:00 的角色消息。
describe('resolveBackfillTimestamp', () => {
  const SENT_AT = 1_700_000_000_000;

  it('本地没有更晚的消息 → 保住 sentAt（隔夜补收就该显示昨晚的时间）', () => {
    expect(resolveBackfillTimestamp(SENT_AT, undefined)).toBe(SENT_AT);
    expect(resolveBackfillTimestamp(SENT_AT, SENT_AT - 60_000)).toBe(SENT_AT);
  });

  it('本地已有更晚的消息 → 退回写库当刻（undefined），别让时间戳往回走', () => {
    expect(resolveBackfillTimestamp(SENT_AT, SENT_AT + 1)).toBeUndefined();
  });

  it('恰好同一时刻 → 不算更晚，保住 sentAt（同一次触发的几段常常同时刻）', () => {
    expect(resolveBackfillTimestamp(SENT_AT, SENT_AT)).toBe(SENT_AT);
  });

  it('本来就是在线送达（写库当刻）→ 原样返回 undefined', () => {
    expect(resolveBackfillTimestamp(undefined, SENT_AT + 1)).toBeUndefined();
  });
});

describe('离线补收落库时间戳与本地历史的先后（走真库）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
  });

  const backfillPush = (charId: string, messageId: string, sentAt: number) =>
    ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '守夜角色',
      body: '早点睡',
      messageType: 'forum',
      receivedAt: sentAt,
      sentAt,
    } as any);

  const assistantMsgs = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');

  it('用户已经先说了话 → 补收的这条落写库当刻，不倒挂到他那句话前面', async () => {
    const charId = 'char-backfill-after-user';
    const sentAt = Date.now() - 13 * 3_600_000;   // 昨晚 23:00 推的
    await DB.saveCharacter({ id: charId, name: '守夜角色' } as any);
    // 用户今早先开的口（push 补投比它晚到几秒）
    await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '早安', timestamp: Date.now() - 60_000,
    } as any);
    await backfillPush(charId, 'msg-backfill-after-user', sentAt);

    const before = Date.now();
    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp, '修复前这里落的是昨晚 23:00，排在「早安」下面').toBeGreaterThanOrEqual(before);
  }, 20000);

  it('用户没说话 → 照旧落 sentAt（跟正文里角色说的晚上的话对得上）', async () => {
    const charId = 'char-backfill-quiet';
    const sentAt = Date.now() - 13 * 3_600_000;
    await DB.saveCharacter({ id: charId, name: '守夜角色' } as any);
    await backfillPush(charId, 'msg-backfill-quiet', sentAt);

    await flushInboxToChat('SW通知');

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);
});

// ─── ⑦ 重试清场：只清正文，副作用产物留在原地 ───
// 副作用产物（转账卡等）跟正文气泡带着同一个 activeMsg2.messageId。一起删掉的话，
// 本轮又因为「认出了标记」判定副作用上次已跑完、不重放 directives —— 卡片删了又不重建，
// 用户看到的就是「角色说转了账，但没有转账卡」，而钱是真的转过。
describe('重试清场时副作用产物不受牵连（走真库）', () => {
  beforeAll(async () => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
    await DB.saveCharacter({ id: 'char-retry-sideeffect', name: '转账角色' } as any);
  });

  it('转账卡 + 半截正文 → 只删正文，卡还在，directives 也不重放', async () => {
    const charId = 'char-retry-sideeffect';
    const messageId = 'msg-retry-sideeffect';
    const stale = (content: string, type: string) => DB.saveMessage({
      charId, role: 'assistant', type, content,
      metadata: { source: 'active_msg_2', activeMsg2: { messageId } },
    } as any);

    // 上一趟：副作用跑完了（转账卡已落库），正文写到一半挂了
    await stale('给你转 5 块', 'transfer');
    await stale('给你转个账', 'text');

    await ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '转账角色',
      body: '给你转个账',
      messageType: 'text',          // 白名单内 → 走后处理主路径（重试清场在这条路上）
      receivedAt: Date.now(),
      sentAt: Date.now(),
      processAttempts: 1,           // 这是一次重试
      metadata: { directives: [{ type: 'transfer', amount: 5 }] },
    } as any);

    await flushInboxToChat('SW通知');

    const msgs = await DB.getRecentMessagesByCharId(charId, 200);
    const transfers = msgs.filter((m) => m.type === 'transfer');
    expect(transfers, '删了又不重放 → 0 张；删了还重放 → 2 张（二次转账）').toHaveLength(1);
    expect(transfers[0].content).toBe('给你转 5 块');
    expect(
      msgs.filter((m) => m.type === 'text' && m.content === '给你转个账'),
      '上一趟的半截正文该被清掉、由这一趟重新渲染，不该并排两条',
    ).toHaveLength(1);
  }, 20000);
});

// 更狠的一种半成品：副作用跑完了、正文一条都没来得及写。
// 这时可删的气泡是 0 条，但「上一趟已经转过账」是铁证——凭据要是照着「删了几条」算，
// 这一趟就会把 directives 再放一遍，用户账上真的少两笔。
describe('重试清场·只留下副作用产物的半成品（走真库）', () => {
  beforeAll(async () => {
    (globalThis as any).window ??= { dispatchEvent: () => true };
    await DB.saveCharacter({ id: 'char-retry-cardonly', name: '转账角色' } as any);
  });

  it('上一趟只写下了转账卡 → 不重放 directives，卡还是一张', async () => {
    const charId = 'char-retry-cardonly';
    const messageId = 'msg-retry-cardonly';
    await DB.saveMessage({
      charId, role: 'assistant', type: 'transfer', content: '给你转 8 块',
      metadata: { source: 'active_msg_2', activeMsg2: { messageId } },
    } as any);

    await ActiveMsgStore.saveInboxMessage({
      messageId,
      charId,
      charName: '转账角色',
      body: '给你转个账',
      messageType: 'text',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      processAttempts: 1,
      metadata: { directives: [{ type: 'transfer', amount: 8 }] },
    } as any);

    await flushInboxToChat('SW通知');

    const transfers = (await DB.getRecentMessagesByCharId(charId, 200))
      .filter((m) => m.type === 'transfer');
    expect(transfers, '凭据按「删了几条」算的话这里会变成 2 张 —— 二次转账').toHaveLength(1);
    expect(transfers[0].content).toBe('给你转 8 块');
  }, 20000);
});

// ─── 即时对话：待收记录的生命周期（走真库）───
//
// 「正在输入…」那盏灯挂在待收记录上，而生成不在本机跑——所以三件事必须钉死：
//   1. 角色一开口就销账（灯灭），别让用户对着一条已经收到的回复继续等；
//   2. **等多久都不是判据**。只有云端点名回来的结论（任务已失败 / 行没了）才收尾，
//      云端还说 pending 就一直等——worker 一次 fire 能跑 10 分钟，失败还要按
//      2/4/6 分钟重试，任何客户端定时宣判都会抢在结论前把还在路上的回复判死；
//   3. 下结论前**先拉一次云端副本**。推送静默丢是常态，不拉就报失败的话，用户会为
//      一条其实已经生成好的回复重发一遍（再烧一轮 LLM）。
describe('即时对话的待收记录（走真库）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });

  beforeEach(() => {
    localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
    // 默认「账本读得到、里面是空的」。要区分「读到了、确实没有」和「压根没读成」的
    // 那几条自己覆盖：前者才构成结论，后者只能继续等。
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // umami 是直接挂在 window 上的，restoreAllMocks 管不着，留着会串到下一条测试。
    delete (globalThis as any).window.umami;
  });

  /** 服务端账本上的一条：`push` 就是推送信封本身，跟 SW 收到的那份逐字一致。 */
  const outboxEntries = (charId: string, messageId: string, taskUuid: string) => [{
    id: 1,
    messageId,
    taskUuid,
    sessionId: 'sess-instant',
    messageIndex: 1,
    totalMessages: 1,
    createdAt: Date.now(),
    deliveredAt: null,
    push: {
      messageKind: 'content',
      messageType: 'instant',
      source: 'scheduled',
      message: '在的，刚看到',
      contactName: '即时角色',
      messageId,
      sessionId: 'sess-instant',
      messageIndex: 1,
      totalMessages: 1,
      taskUuid,
      timestamp: new Date().toISOString(),
      metadata: { charId, charName: '即时角色', amsgInstantChat: true },
    },
  }];

  it('欠着的那一轮回复到了 → 待收记录销账（灯灭）', async () => {
    const charId = 'char-instant-clear';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-clear');

    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-instant-clear',
      charId,
      charName: '即时角色',
      body: '在的',
      messageType: 'instant',
      taskUuid: 'uuid-clear',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      metadata: { charId },
    } as any);
    await flushInboxToChat('SW通知');

    expect(getInstantChatPending(charId)).toBeNull();
  }, 20000);

  // 「任务被作废」的回执随 chat 段一起上云，发出时只记账（worker 回 202 仅表示受理）。
  // 真正销账要等回复落库——这一轮要是整个失败了，回执得留着下轮重新注入，否则角色
  // 永远不知道自己许过的那条排程已经没了，既不会续期也不会解释。
  it('随这一轮上云的作废回执 → 回复落库时才销账', async () => {
    const charId = 'char-instant-notices';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-notices');
    stageInstantChatExpiredNotices(charId, 'uuid-notices', ['expired-1', 'expired-2']);

    const marked = vi.spyOn(ActiveMsgStore, 'markExpiredNoticesNotified').mockResolvedValue(undefined as any);

    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-instant-notices',
      charId,
      charName: '即时角色',
      body: '在的',
      messageType: 'instant',
      taskUuid: 'uuid-notices',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      metadata: { charId },
    } as any);
    await flushInboxToChat('SW通知');

    expect(marked).toHaveBeenCalledWith(charId, ['expired-1', 'expired-2']);
    expect(getStagedInstantChatExpiredNotices(charId)).toBeNull();
  }, 20000);

  // 销账认 taskUuid，不认「这个角色开口了」：定时任务的主动消息、被顶掉的上一轮迟到
  // 的回复都可能先落地。按角色销账的话，60s 点名连同 outbox 兜底当场全停——这一轮的
  // 推送真丢了就再也没人去补，用户对着灭掉的灯以为没事，其实回复正躺在 outbox 里。
  it('同角色的别的消息（定时主动消息 / 旧一轮迟到的回复）→ 不销账、灯不灭', async () => {
    const charId = 'char-instant-unrelated';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-awaited');

    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-scheduled-1',
      charId,
      charName: '即时角色',
      body: '到点想你了',
      messageType: 'auto',
      taskUuid: 'uuid-some-scheduled-task',
      receivedAt: Date.now(),
      sentAt: Date.now(),
      metadata: { charId },
    } as any);
    await flushInboxToChat('SW通知');

    expect(getInstantChatPending(charId)?.uuid, '别的消息不能替这一轮销账').toBe('uuid-awaited');
  }, 20000);

  /**
   * 60s 那个点名定时器只记下来、不真的挂在测试进程上（否则跑完测试还得等它）。
   * 别的 setTimeout 一律照常走真的——测试里还有别人在用，一起吞掉会把它们弄坏。
   * 返回排过的间隔清单；用完在断言前 restore。
   */
  const captureStatusPollTimers = () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: any, ms?: number, ...rest: any[]
    ) => {
      if (ms !== INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS) return realSetTimeout(fn, ms, ...rest);
      delays.push(ms);
      return 0 as any;
    }) as any);
    return { delays, restore: () => spy.mockRestore() };
  };

  it('云端账本里有那条 → 补收上屏，不查状态也不报失败', async () => {
    const charId = 'char-instant-outbox';
    const messageId = 'msg_task_9@1700000000000_hook_0';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-outbox', Date.now());
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries')
      .mockResolvedValue(outboxEntries(charId, messageId, 'uuid-outbox') as any);
    const status = vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus')
      .mockResolvedValue({ state: 'gone' });
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: 'uuid-outbox', alreadyGone: true });

    await runInstantChatStatusCheck();

    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'assistant'), '推送丢了的那条该被补回来').toBe(true);
    expect(msgs.some((m) => m.role === 'system'), '补收成功就不该再报失败').toBe(false);
    expect(getInstantChatPending(charId)).toBeNull();
    // 补收就把账销了，这一轮已经有结论，不用再去问云端。
    expect(status).not.toHaveBeenCalled();
    // 但要尽力取消那条任务行：回复是从 outbox 捡回来的 = 真推送没送到 = 行多半还挂在
    // 2/4/6 分钟的重试队列里，不取消的话重试跑起来就是同一轮的第二份回复（段数更多时
    // 多出的段成孤儿气泡）。行已经删掉的场景取消打到 404，一样安静。
    expect(cancel).toHaveBeenCalledWith('uuid-outbox');
  }, 20000);

  it('云端仍是 pending → 不销账、不落失败说明、不取消任务（等多久都不是判据）', async () => {
    const charId = 'char-instant-still-running';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    // 受理时刻故意放到半小时前：worker 一次 fire 能跑 10 分钟，失败还要按 2/4/6 分钟
    // 重试，等了多久本身不构成任何结论。
    setInstantChatPending(charId, 'uuid-still-running', Date.now() - 30 * 60_000);
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    const status = vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus')
      // nextSendAt 已经过去是重试中的常态（云端只往前推 retry_after），不是放弃的信号。
      .mockResolvedValue({ state: 'pending', retryCount: 2, nextSendAt: new Date(Date.now() - 60_000).toISOString() });
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: 'uuid-still-running', alreadyGone: false });

    const timers = captureStatusPollTimers();
    await runInstantChatStatusCheck();
    timers.restore();

    expect(status).toHaveBeenCalledWith('uuid-still-running');
    expect(getInstantChatPending(charId)?.uuid, '云端还在跑，账不能销').toBe('uuid-still-running');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system'), '还在跑就不该留失败说明').toBe(false);
    expect(cancel, '客户端不再替云端宣判，更不许把还在跑的任务掐掉').not.toHaveBeenCalled();
    expect(timers.delays).toContain(INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
  }, 20000);

  it('云端说任务已失败 → 再补收一次仍没有 → 销账 + 落带失败原因的说明', async () => {
    const charId = 'char-instant-failed';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-failed', Date.now());
    // 失败原因从 chat_fail 留痕一次点名读回（worker fire 收尾时写的），不再全量拉任务列表。
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockImplementation(async (_ns, key) => (
      key === 'chat_fail'
        ? JSON.stringify({ v: 1, uuid: 'uuid-failed', reason: '上游 502', retryCount: 3, at: Date.now() })
        : null
    ));
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'completed' });

    await runInstantChatStatusCheck();

    expect(getInstantChatPending(charId)).toBeNull();
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('即时对话');
    expect(systemMsgs[0].content, '云端记下的失败原因要带到用户眼前').toContain('上游 502');
    // 措辞是即时对话自己的：用户刚按下发送，「上次到点没发出去」那套排程口吻不成话。
    expect(systemMsgs[0].content).toContain('生成失败（重试 3 次后放弃）');
    expect(systemMsgs[0].content).not.toContain('到点');
  }, 20000);

  // 查失败原因要去云端点名读一份 chat_fail 留痕，这中间用户看指示灯不动又发了一条
  // 是很自然的事。结论回来时不认 uuid 的话，销掉的是新那一轮的账：「正在输入」当场
  // 熄灭，聊天流里还多一条它其实没失败的说明。
  it('查失败原因的空档里用户又发了一条 → 迟到的结论不动新那一轮', async () => {
    const charId = 'char-instant-resend';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-old', Date.now());
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'completed' });
    (globalThis as any).window.umami = { track: vi.fn() };

    // 手动掌控 chat_fail 那次点名：卡在半路，好让「用户重发」精确插进这个空档。
    // outbox 兜底的读照常立即回空——卡住的必须只是失败原因那一步。
    let releaseFail!: (raw: string | null) => void;
    const failCalled = new Promise<void>((markCalled) => {
      vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockImplementation((_ns, key) => {
        if (key !== 'chat_fail') return Promise.resolve(null);
        markCalled();
        return new Promise((resolve) => { releaseFail = resolve; });
      });
    });

    const timers = captureStatusPollTimers();
    const sweep = runInstantChatStatusCheck();
    await failCalled;
    setInstantChatPending(charId, 'uuid-new'); // 用户重发，待收记录换人
    releaseFail(JSON.stringify({ v: 1, uuid: 'uuid-old', reason: '上游 502', retryCount: 3, at: Date.now() }));
    await sweep;
    timers.restore();

    expect(getInstantChatPending(charId)?.uuid, '新那一轮还等着，别把它的灯灭了').toBe('uuid-new');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system'), '新那一轮没失败，不该有失败说明').toBe(false);
    expect((globalThis as any).window.umami.track).not.toHaveBeenCalled();
  }, 20000);

  it('云端那行已经没了、outbox 里也没有 → 销账 + 说明「回复没能取回」', async () => {
    const charId = 'char-instant-gone';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-gone', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'gone' });

    await runInstantChatStatusCheck();

    expect(getInstantChatPending(charId)).toBeNull();
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('回复没能取回');
  }, 20000);

  // gone 不都是「发成功后行被删」：模型空输出 / 纯拒答被 worker 判 skip-push 时，一次性
  // 行同样被上游当成功消费删掉，worker 在那一刻写过 chat_fail。gone 分支不读它的话，
  // 给用户的解释是「云端已处理但回复没能取回」——把「没生成出来」说成了「取不回」，
  // 用户以为是投递故障白重发，其实该知道的是模型这轮没说话。
  it('行没了 + outbox 为空 + chat_fail 说是 skip → 照实说「模型这轮没有生成内容」', async () => {
    const charId = 'char-instant-skip';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-skip', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockImplementation(async (_ns, key) => (
      key === 'chat_fail'
        ? JSON.stringify({ v: 1, uuid: 'uuid-skip', reason: 'empty-generation', retryCount: 0, at: Date.now() })
        : null
    ));
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'gone' });

    await runInstantChatStatusCheck();

    expect(getInstantChatPending(charId)).toBeNull();
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('模型这轮没有生成内容');
    expect(systemMsgs[0].content, '不许把「没生成」说成「取不回」').not.toContain('回复没能取回');
  }, 20000);

  // 「不按时长宣判」只对云端还答得上话的等待成立。worker 被删（未知路由回 HTML 页）、
  // 共享密钥被换（401）这类用户自己动过环境的场景，状态查询永远抛错——不设线的话
  // 「正在输入…」跨重启常亮、每 60s 空转、该角色 fire_pack 同步被无限期挂起。
  it('联网状态下状态查询连续失败到第 5 次 → 先取消远端那行，再判失联收场', async () => {
    const charId = 'char-instant-unreachable';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-unreachable', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockRejectedValue(new Error('Unexpected token < in JSON'));
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: 'uuid-unreachable', alreadyGone: false });

    const timers = captureStatusPollTimers();
    try {
      for (let i = 0; i < 4; i += 1) {
        await runInstantChatStatusCheck();
        expect(getInstantChatPending(charId)?.uuid, `第 ${i + 1} 次失败还不够判死`).toBe('uuid-unreachable');
        expect(cancel, '还没判死就不许动远端那行').not.toHaveBeenCalled();
      }
      await runInstantChatStatusCheck();
    } finally {
      timers.restore();
    }

    expect(getInstantChatPending(charId), '连续 5 次问不出话就该收场').toBeNull();
    // 这条路跟 completed / gone 不一样：云端从头到尾没给过结论，那行完全可能还挂在
    // 重试梯子上。不取消就宣判 = 用户照说明重发一遍，原来那行随后又跑成功，一轮对话
    // 烧两次 LLM、聊天流里冒出两份几乎一样的回复。
    expect(cancel, '判死这一轮就得把远端那行也了结掉').toHaveBeenCalledWith('uuid-unreachable');
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('联系不上云端 worker');
    expect(systemMsgs[0].content, '要给用户指条能走的路').toContain('重新连接并验证');
    // 取消成功 = 那行真没了，不用再吓唬用户「回复可能还会来」
    expect(systemMsgs[0].content).not.toContain('稍后可能还会送到');
  }, 20000);

  // 会走到失联判定的典型场景（worker 被删、共享密钥被换），取消同样打不通。要求取消
  // 成功才准判死的话，「正在输入…」永亮这个原病就又被请回来了——所以照判，只是把话说
  // 清楚：那行可能自己跑完，回复还会来。
  it('判死时连取消也失败 → 照样收场，但说明里挑明回复可能稍后还会到', async () => {
    const charId = 'char-instant-unreachable-nocancel';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-nocancel', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockRejectedValue(new Error('Unexpected token < in JSON'));
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask').mockRejectedValue(new Error('worker 也连不上'));

    const timers = captureStatusPollTimers();
    try {
      for (let i = 0; i < 5; i += 1) await runInstantChatStatusCheck();
    } finally {
      timers.restore();
    }

    expect(cancel).toHaveBeenCalledWith('uuid-nocancel');
    expect(getInstantChatPending(charId), '取消不掉也不能永远等下去').toBeNull();
    const systemMsgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('联系不上云端 worker');
    expect(systemMsgs[0].content, '取消没落地就得如实说').toContain('稍后可能还会送到');
  }, 20000);

  // 断网的失败是这台设备的问题，攒不出「worker 失联」的结论——恢复网络后从头计。
  it('设备离线时的查询失败不计入失联判定', async () => {
    const charId = 'char-instant-airplane';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-airplane', Date.now());
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockRejectedValue(new Error('Failed to fetch'));
    vi.stubGlobal('navigator', { onLine: false });

    const timers = captureStatusPollTimers();
    try {
      for (let i = 0; i < 6; i += 1) await runInstantChatStatusCheck();
    } finally {
      timers.restore();
      vi.unstubAllGlobals();
    }

    expect(getInstantChatPending(charId)?.uuid, '离线失败次数再多也不许判死').toBe('uuid-airplane');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system')).toBe(false);
  }, 20000);

  // 「取不回」的结论 = 行没了 **且账本读到了、里面确实没有**。账本那一步读失败
  // 时（网络抖、worker 500），结论就建立在一次失败的读上——回复可能正躺在账本里。
  // 这时判死的话：用户看到「生成失败」重发一遍（再烧一轮），下一跳补收又把原回复放
  // 出来，聊天流里失败说明后面跟着两条几乎一样的回复。
  it('云端那行已经没了、但账本读失败 → 这一跳不下结论，等下一跳', async () => {
    const charId = 'char-instant-gone-unreadable';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-gone-unreadable', Date.now());
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockRejectedValue(new Error('worker 500'));
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'gone' });

    const timers = captureStatusPollTimers();
    await runInstantChatStatusCheck();
    timers.restore();

    expect(getInstantChatPending(charId)?.uuid, '账本没读成就不许判死').toBe('uuid-gone-unreadable');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system'), '一次失败的读不构成「生成失败」').toBe(false);
    expect(timers.delays, '下一跳还得排上').toContain(INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
  }, 20000);

  it('状态查不到（网络断了）→ 什么都不做，等下一跳', async () => {
    const charId = 'char-instant-offline';
    await DB.saveCharacter({ id: charId, name: '即时角色' } as any);
    setInstantChatPending(charId, 'uuid-offline', Date.now() - 30 * 60_000);
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockRejectedValue(new Error('网络断了'));

    const timers = captureStatusPollTimers();
    await runInstantChatStatusCheck();
    timers.restore();

    expect(getInstantChatPending(charId)?.uuid, '问不到就什么都不结论').toBe('uuid-offline');
    const msgs = await DB.getRecentMessagesByCharId(charId, 50);
    expect(msgs.some((m) => m.role === 'system')).toBe(false);
    expect(timers.delays, '下一跳还得排上，不然这条待收就没人管了').toContain(INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
  }, 20000);

  // 后台每分钟醒一次去打网络毫无意义：用户看不见结果，移动端还会被系统掐。周期由
  // 回前台那次点名接上，所以不可见时连下一跳都不排。
  it('页面不可见 → 一个请求都不发，也不排下一跳', async () => {
    const charId = 'char-instant-hidden';
    setInstantChatPending(charId, 'uuid-hidden', Date.now() - 30 * 60_000);
    const read = vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    const status = vi.spyOn(ActiveMsgClient, 'getRemoteTaskStatus').mockResolvedValue({ state: 'gone' });

    (globalThis as any).document = { visibilityState: 'hidden' };
    const timers = captureStatusPollTimers();
    try {
      await runInstantChatStatusCheck();
    } finally {
      timers.restore();
      delete (globalThis as any).document;
    }

    expect(read).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(getInstantChatPending(charId)?.uuid).toBe('uuid-hidden');
    expect(timers.delays, '后台不排下一跳，等回前台那次点名把周期接上').not.toContain(INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
  });
});

// 拦住「处理失败后排的那次重试」，别让它在用例之间真的跑起来。
//
// 按 resolveInboxRetryDelay 的档位认，跟着实现走：写死某个毫秒数的话，延迟一改这里就
// 悄悄失效，重试漏到后面的用例里，症状是别处莫名其妙地飘。
// 前提是用它的用例都走补收口径（跳过拟人慢放）——慢放那条路自己也排 0.5~2 秒的
// setTimeout，撞上档位就会被一起拦掉。
const captureInboxRetryTimer = () => {
  const retryDelays = new Set([1, 2, 3].map(resolveInboxRetryDelay));
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: any, ms?: number, ...rest: any[]
  ) => (ms != null && retryDelays.has(ms) ? (0 as any) : realSetTimeout(fn, ms, ...rest))) as any);
  return { restore: () => spy.mockRestore() };
};

// ─── 收件箱「先 ack 后处理」的兜底 ───
// consumeInboxMessages 把整批消息原子取空之后才开始逐条处理，这中间任何一步抛出去的
// 异常都会穿过 for 循环：剩下的消息既不在聊天记录里、也不在收件箱里、还不弹任何提示，
// 用户那边只看到「正在输入…」亮到 60s 点名判失败。所以每条消息都得整段包住。
describe('收件箱处理途中抛错不许吞掉整批（走真库）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** 30s 的自动重试定时器只记下来、不真挂在测试进程上（其余 setTimeout 照常走真的）。 */
  // 接线守卫：排重试用的必须是 resolveInboxRetryDelay 算出来的档位，不是写死的常量。
  //
  // 这条的存在意义是「用户看到的等待时长」：推送通知已经把整句话显示过了，聊天界面
  // 却要等重试才追上。延迟被改回半分钟的话，症状是「通知都看到了，App 里还是三个点」，
  // 而所有功能测试照样全绿——消息一条不丢，只是晚了三十秒。没人会当回事。
  it('瞬态失败后排的重试是秒级的，不让用户对着「正在输入」干等', async () => {
    const charId = 'char-retry-delay';
    await DB.saveCharacter({ id: charId, name: '重试延迟角色' } as any);

    const base = Date.now() - 8 * 60_000; // 补收口径，跳过拟人慢放
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-retry-delay',
      charId,
      charName: '重试延迟角色',
      body: '在的，刚看到',
      messageType: 'text',
      receivedAt: base,
      sentAt: base,
      metadata: { charId },
    } as any);

    // 去重那步读近史时炸一次 = 最常见的那种瞬态存储故障。
    const realRecent = DB.getRecentMessagesByCharId.bind(DB);
    vi.spyOn(DB, 'getRecentMessagesByCharId')
      .mockImplementation(realRecent as any)
      .mockRejectedValueOnce(new Error('IndexedDB 连接被占'));

    // 记下排了哪些延迟；重试那个不能真的跑起来，否则会漏到后面的用例里。
    const scheduled: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: any, ms?: number, ...rest: any[]
    ) => {
      scheduled.push(ms ?? 0);
      return ms != null && ms >= 1_000 ? (0 as any) : realSetTimeout(fn, ms, ...rest);
    }) as any);
    try {
      await flushInboxToChat('SW通知');
    } finally {
      spy.mockRestore();
    }

    expect(scheduled, '第一次失败该按第一档排重试').toContain(resolveInboxRetryDelay(1));

    await ActiveMsgStore.consumeInboxMessages(); // 别把这条留给后面的用例
  }, 20000);

  // 「重试中」这个代号有两个发射点（收发环节兜底 / 后处理），共用一个事件。
  // 不分段的话面板上只看得到「有多少次重试」，看不出是哪一段在挂——线上那 293 次就是
  // 这么变成一笔糊涂账的：查根因时只能靠读代码猜，而猜的结论没法验证。
  it('上报失败时带上是哪一段挂的，三条路不能混成一个数', async () => {
    const charId = 'char-retry-stage';
    await DB.saveCharacter({ id: charId, name: '分段上报角色' } as any);

    const base = Date.now() - 8 * 60_000; // 补收口径，跳过拟人慢放
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-retry-stage',
      charId,
      charName: '分段上报角色',
      body: '在的，刚看到',
      messageType: 'text',
      receivedAt: base,
      sentAt: base,
      metadata: { charId },
    } as any);

    // 去重那步读近史时炸一次 = 收发环节的兜底 catch，不是后处理。
    const realRecent = DB.getRecentMessagesByCharId.bind(DB);
    vi.spyOn(DB, 'getRecentMessagesByCharId')
      .mockImplementation(realRecent as any)
      .mockRejectedValueOnce(new Error('IndexedDB 连接被占'));

    const track = vi.spyOn(Analytics, 'trackEvent').mockImplementation(() => {});
    const timers = captureInboxRetryTimer();
    try {
      await flushInboxToChat('SW通知');
    } finally {
      timers.restore();
    }

    expect(track).toHaveBeenCalledWith('主动消息送达失败', { kind: '重试中', stage: '收发' });

    await ActiveMsgStore.consumeInboxMessages(); // 别把这条留给后面的用例
  }, 20000);

  it('查近史去重时本地存储抛错 → 这条压回收件箱重试，同批后面那条照常落库', async () => {
    const failCharId = 'char-stage-throw';
    const okCharId = 'char-stage-ok';
    await DB.saveCharacter({ id: failCharId, name: '抛错角色' } as any);
    await DB.saveCharacter({ id: okCharId, name: '同批后一条的角色' } as any);

    const base = Date.now() - 8 * 60_000; // 补收口径，跳过拟人慢放
    const inbox = (charId: string, messageId: string, sentAt: number) => ({
      messageId,
      charId,
      charName: '测试角色',
      body: '在的，刚看到',
      messageType: 'text',
      receivedAt: sentAt,
      sentAt,
      metadata: { charId },
    }) as any;
    await ActiveMsgStore.saveInboxMessage(inbox(failCharId, 'msg-stage-throw', base));
    await ActiveMsgStore.saveInboxMessage(inbox(okCharId, 'msg-stage-ok', base + 1_000));

    // 第一次读近史（去重那一步）炸掉，之后照常。这一步在后处理那圈 try/catch 之外，
    // 旧行为下异常会一路冒到 flushInboxToChat 的包装层被 console.warn 掉，两条一起蒸发。
    const realRecent = DB.getRecentMessagesByCharId.bind(DB);
    vi.spyOn(DB, 'getRecentMessagesByCharId')
      .mockImplementation(realRecent as any)
      .mockRejectedValueOnce(new Error('IndexedDB 连接被占'));

    const seen: string[] = [];
    const dispatch = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: any) => {
      seen.push(event?.type);
      return true;
    });

    const timers = captureInboxRetryTimer();
    try {
      await flushInboxToChat('SW通知');
    } finally {
      timers.restore();
      dispatch.mockRestore();
    }

    const requeued = (await ActiveMsgStore.listInboxMessages())
      .find((m) => m.messageId === 'msg-stage-throw');
    expect(requeued, '抛错那条必须回到收件箱，不能凭空蒸发').toBeTruthy();
    expect(requeued?.processAttempts, '失败次数要记上，才有重试上限可言').toBe(1);
    expect(seen, '还要告诉用户有条消息没能正常显示').toContain('active-msg-process-failed');
    expect(
      (await DB.getRecentMessagesByCharId(okCharId, 50)).some((m) => m.role === 'assistant'),
      '同一批里后面那条不该被连累',
    ).toBe(true);

    await ActiveMsgStore.consumeInboxMessages(); // 别把这条留给后面的用例
  }, 20000);

  // 销账即失忆：云端账本一销，那条就再也拉不回来了。压回收件箱的消息还没处理完，
  // 这一趟把它一起销掉的话，进程正好在重试前被杀就是**永久丢一条消息**——而这恰恰是
  // 这次接账本要修的那个病。所以「有着落」的口径必须是「不会再回收件箱」，不是「处理过了」。
  it('压回收件箱重试的那条不许销账，同批走完的照常销', async () => {
    const failCharId = 'char-ack-requeue';
    const okCharId = 'char-ack-settled';
    await DB.saveCharacter({ id: failCharId, name: '抛错角色' } as any);
    await DB.saveCharacter({ id: okCharId, name: '正常角色' } as any);

    const base = Date.now() - 8 * 60_000; // 补收口径，跳过拟人慢放
    const inbox = (charId: string, messageId: string, sentAt: number) => ({
      messageId,
      charId,
      charName: '测试角色',
      body: '在的，刚看到',
      messageType: 'text',
      receivedAt: sentAt,
      sentAt,
      metadata: { charId },
    }) as any;
    await ActiveMsgStore.saveInboxMessage(inbox(failCharId, 'msg-ack-requeue', base));
    await ActiveMsgStore.saveInboxMessage(inbox(okCharId, 'msg-ack-settled', base + 1_000));

    const realRecent = DB.getRecentMessagesByCharId.bind(DB);
    vi.spyOn(DB, 'getRecentMessagesByCharId')
      .mockImplementation(realRecent as any)
      .mockRejectedValueOnce(new Error('IndexedDB 连接被占'));
    const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);

    const timers = captureInboxRetryTimer();
    try {
      await flushInboxToChat('SW通知');
    } finally {
      timers.restore();
    }

    const acked = ack.mock.calls.flatMap(([ids]) => ids ?? []);
    expect(acked, '压回收件箱的那条销了账就再也补不回来了').not.toContain('msg-ack-requeue');
    expect(acked, '走完流程的那条要销账，不然每趟都被重新捞回来').toContain('msg-ack-settled');

    await ActiveMsgStore.consumeInboxMessages(); // 别把这条留给后面的用例
  }, 20000);
});

// ─── 云端旁路副本的删除时机 ───
// 回复太长时 worker 会把思考链 / 小红书会话数据挪进 client_state，push 里只留一个引用键。
// 客户端取回来就删的话，落库半路失败把消息压回收件箱之后，重试那一趟读到的是空——
// 心象卡片这一轮就永久没了，而且不报任何错（回复照常上屏，只是少了张卡）。
describe('云端旁路副本等这条消息处理成功了再删（走真库）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('后处理半路挂了 → 云端那几份一个都不删，重试那趟心象卡片还在', async () => {
    const charId = 'char-offload-defer';
    await DB.saveCharacter({ id: charId, name: '心象角色', showThinkingChain: true } as any);
    const reasoningRef = 'reasoning:client-task-defer';
    const xhsRef = 'xhs_session:client-task-defer';

    // 一份会真被删掉的云端存储：删了之后再读就是 null，跟线上一样。
    const cloud = new Map<string, string>([
      [reasoningRef, '这句话我想了很久才说出口。'],
      [xhsRef, JSON.stringify({ notes: [{ idx: 1, note: { id: 'note-1', title: '一条笔记' } }], xsecTokens: [] })],
    ]);
    vi.spyOn(ActiveMsgClient, 'readClientStateValue')
      .mockImplementation(async (_ns: string, key: string) => cloud.get(key) ?? null);
    const clearSpy = vi.spyOn(ActiveMsgClient, 'clearClientStateValue')
      .mockImplementation(async (_ns: string, key: string) => { cloud.delete(key); });

    const sentAt = Date.now() - 8 * 60_000; // 补收口径，跳过拟人慢放
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-offload-defer',
      charId,
      charName: '心象角色',
      body: '刚看到，我在的。',
      messageType: 'text',
      receivedAt: sentAt,
      sentAt,
      metadata: {
        charId,
        sessionId: 'sess-offload-defer',
        messageIndex: 1,
        totalMessages: 1,
        amsgReasoningRef: reasoningRef,
        xhsSessionRef: xhsRef,
      },
    } as any);

    const timers = captureInboxRetryTimer();
    try {
      // 第一趟：落库挂了（配额满 / 连接被占那种），这条被压回收件箱等重试。
      const saveSpy = vi.spyOn(DB, 'saveMessage').mockRejectedValue(new Error('QuotaExceededError'));
      await flushInboxToChat('SW通知');
      saveSpy.mockRestore();

      expect(clearSpy, '这一趟没成，云端那几份一个都不许删').not.toHaveBeenCalled();
      expect(
        (await ActiveMsgStore.listInboxMessages()).some((m) => m.messageId === 'msg-offload-defer'),
        '这条该在收件箱里等重试',
      ).toBe(true);

      // 第二趟：存储缓过来了，重试把心象卡片补上。
      await flushInboxToChat('SW通知');
    } finally {
      timers.restore();
    }

    const chains = (await DB.getRecentMessagesByCharId(charId, 50))
      .filter((m) => m.role === 'assistant')
      .map((m: any) => m.metadata?.thinkingChain)
      .filter(Boolean);
    expect(chains, '重试那趟还得读得到思考链').toEqual(['这句话我想了很久才说出口。']);
    // 落定了才轮到收尾：两份都删掉，D1 不留垃圾。
    expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), reasoningRef);
    expect(clearSpy).toHaveBeenCalledWith(amsgStateNamespace(charId), xhsRef);
  }, 20000);
});

// worker 判死那一刻直发的 error push：SW 转给页面后当场收尾那一轮（落系统消息、销账），
// 不用干等 60s 点名。回归守卫：以前 active-msg-error 在页面被静默丢弃。
describe('error push 到页面 → 当场收尾（handleInstantErrorPushMessage）', () => {
  it('uuid 对得上 → 销账 + 落同一份翻译的失败说明', async () => {
    const charId = 'char-errpush-hit';
    await DB.saveCharacter({ id: charId, name: '直发角色' } as any);
    setInstantChatPending(charId, 'uuid-errpush-1');

    await handleInstantErrorPushMessage({
      metadata: { charId, taskUuid: 'uuid-errpush-1', reason: 'empty-generation' },
    });

    expect(getInstantChatPending(charId)).toBeNull();
    const msgs = await DB.getRecentMessagesByCharId(charId, 10);
    const note = msgs.find((m: any) => m.role === 'system' && String(m.content).includes('即时对话没能完成'));
    expect(note, '要落一条失败说明').toBeTruthy();
    // 与 60s 点名路径同一份翻译（describeInstantChatFailure），两条路对用户说同样的话
    expect(String(note!.content)).toContain('模型这轮没有生成内容');
  }, 20000);

  it('uuid 对不上（用户已经重发了新一轮）→ 不动账', async () => {
    const charId = 'char-errpush-miss';
    await DB.saveCharacter({ id: charId, name: '重发角色' } as any);
    setInstantChatPending(charId, 'uuid-new-round');

    await handleInstantErrorPushMessage({
      metadata: { charId, taskUuid: 'uuid-old-round', reason: 'stale' },
    });

    expect(getInstantChatPending(charId)?.uuid).toBe('uuid-new-round');
    const msgs = await DB.getRecentMessagesByCharId(charId, 10);
    expect(msgs.some((m: any) => String(m.content ?? '').includes('即时对话没能完成'))).toBe(false);
  }, 20000);

  it('metadata 缺 taskUuid（不是即时对话的失败告知）→ 静默略过', async () => {
    const charId = 'char-errpush-no-uuid';
    setInstantChatPending(charId, 'uuid-untouched');

    await handleInstantErrorPushMessage({ metadata: { charId }, code: 'SOME_DIAG', message: 'x' });

    expect(getInstantChatPending(charId)?.uuid).toBe('uuid-untouched');
  }, 20000);

  // worker 把稳定的 errorCode 一起挂在 push 上（amsg-server 给 fire 抛的错误挂了 code）。
  // 不带过去的话，秒级到达的这条直发告知只能说一句笼统的「生成失败」，而 60s 点名那条
  // 路读得到同一个码、说的是「模型接口拒了，去查 Key」——同一次失败两种说法。
  it('push 上带 errorCode → 用它给能照着做的话，跟点名路径同一份翻译', async () => {
    const charId = 'char-errpush-code';
    await DB.saveCharacter({ id: charId, name: '报错角色' } as any);
    setInstantChatPending(charId, 'uuid-errpush-code');

    await handleInstantErrorPushMessage({
      metadata: {
        charId,
        taskUuid: 'uuid-errpush-code',
        reason: 'AI API error: 401 Unauthorized. Request URL: https://api.example.com/v1/chat/completions\n'
          + '  — Incorrect API key provided: sk-[redacted]. (provider code: invalid_api_key)',
        errorCode: 'LLM_CALL_FAILED',
      },
    });

    const msgs = await DB.getRecentMessagesByCharId(charId, 10);
    const note = msgs.find((m: any) => m.role === 'system' && String(m.content).includes('即时对话没能完成'));
    expect(String(note!.content)).toContain('模型接口拒了这次请求');
    expect(String(note!.content)).toContain('invalid_api_key');
  }, 20000);
});

// 一条推送装不下的内容会切成分片发出，SW 收齐还原。拼不起来的原因不都一样：等超时
// 重开一下多半就好，而分片对不上 / 超限那几种重开没用。混成同一句「消息接收不完整」
// 的话，用户对着一条永远修不好的提示反复重开。
describe('分片拼不起来时说的那句话（describeMultipartFailure）', () => {
  it('等超时 → 说没等齐，建议重开', () => {
    const text = describeMultipartFailure(MULTIPART_FAILURE_REASON.TTL_EXPIRED);
    expect(text).toContain('没在时限内到齐');
    expect(text).toContain('重开');
  });

  it('本机存储写不进去 → 指向存储空间，不叫人重开', () => {
    const text = describeMultipartFailure(MULTIPART_FAILURE_REASON.STORAGE_FAILED);
    expect(text).toContain('存储');
  });

  it('分片本身有问题的几种 → 照实说是数据问题，别让人以为重开能好', () => {
    for (const reason of [
      MULTIPART_FAILURE_REASON.INVALID_CHUNK,
      MULTIPART_FAILURE_REASON.CHUNK_CONFLICT,
      MULTIPART_FAILURE_REASON.SIZE_LIMIT_EXCEEDED,
      MULTIPART_FAILURE_REASON.RESTORE_FAILED,
      MULTIPART_FAILURE_REASON.DISABLED,
    ]) {
      const text = describeMultipartFailure(reason);
      expect(text, reason).toContain('分片数据有问题');
      expect(text, reason).not.toContain('重开');
    }
  });

  // 老 SW 不带 reason（字段是 2.4.0-next.4 加的），照样得给一句完整的话。
  it('没有 reason → 走通用文案，不出现 undefined', () => {
    const text = describeMultipartFailure(undefined);
    expect(text).toContain('没接收完整');
    expect(text).not.toContain('undefined');
  });
});

// 这一组钉的是一次真实事故：定时主动消息到点生成好了、账本也记了、推送也发出去了，
// 但在网络层丢了（代理断流、推送服务连不上）。worker 日志全绿、任务照常消费、订阅
// 也没被退回，用户那边就是再也收不到——而云端账本上明明躺着那几条。
//
// 病根不在补收本身，在**什么时候去补**：拉账本的时机当初只挂在「即时对话正等着回复」
// 上，而定时主动消息由云端到点自己发，客户端从来不产生那个状态，于是永远没人去捞。
//
// 所以这里钉死的不变量只有一条：**一条待收记录都没有时，上线补收照样要去拉账本。**
describe('上线补收不看有没有在等回复（走真库）', () => {
  const WORKER_URL = 'https://amsg-catchup.example.workers.dev';

  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });

  beforeEach(async () => {
    localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
    // 这一组测的都是「已经接上账本之后」的常规补收；首次接管那条路（存量整批销账、
    // 不上屏）有自己的一组，见 amsgInstantChat.test.ts。
    localStorage.setItem(AMSG_OUTBOX_ADOPTED_LS_KEY, JSON.stringify({ at: Date.now() }));
    resetOutboxCatchUpThrottleForTesting();
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: WORKER_URL });
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: '' });
  });

  /** 账本上的一条定时主动消息（`push` 就是推送信封本身，跟 SW 收到的那份逐字一致）。 */
  const scheduledEntry = (charId: string, messageId: string) => ({
    id: 1,
    messageId,
    taskUuid: 'uuid-scheduled',
    sessionId: 'sess-scheduled',
    messageIndex: 1,
    totalMessages: 1,
    createdAt: Date.now(),
    deliveredAt: Date.now(),
    push: {
      messageKind: 'content',
      messageType: 'scheduled',
      source: 'scheduled',
      message: '到点啦，该睡觉了',
      contactName: '定时角色',
      messageId,
      sessionId: 'sess-scheduled',
      messageIndex: 1,
      totalMessages: 1,
      taskUuid: 'uuid-scheduled',
      timestamp: new Date().toISOString(),
      metadata: { charId, charName: '定时角色' },
    },
  });

  it('一条待收记录都没有，冷启动照样去账本上捞', async () => {
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    expect(listInstantChatPendings()).toHaveLength(0);
    await expect(catchUpMissedPushes('startup')).resolves.toBe('drained');
    expect(list).toHaveBeenCalledTimes(1);
  }, 20000);

  it('回到前台同样不看待收记录', async () => {
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    expect(listInstantChatPendings()).toHaveLength(0);
    await expect(catchUpMissedPushes('foreground')).resolves.toBe('drained');
    expect(list).toHaveBeenCalledTimes(1);
  }, 20000);

  it('推送丢掉的那条定时主动消息，从账本补回聊天流', async () => {
    const charId = 'char-catchup-scheduled';
    const messageId = 'msg_task_67@1786434120000_hook_0';
    await DB.saveCharacter({ id: charId, name: '定时角色' } as any);
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries')
      .mockResolvedValue([scheduledEntry(charId, messageId)] as any);

    expect(listInstantChatPendings()).toHaveLength(0);
    await expect(catchUpMissedPushes('startup')).resolves.toBe('drained');

    const msgs = await DB.getRecentMessagesByCharId(charId, 10);
    expect(msgs.some((m: any) => String(m.content ?? '').includes('到点啦，该睡觉了'))).toBe(true);
  }, 20000);

  it('不到节流窗口的第二趟不打网络', async () => {
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    await expect(catchUpMissedPushes('startup')).resolves.toBe('drained');
    await expect(catchUpMissedPushes('foreground')).resolves.toBe('throttled');
    expect(list).toHaveBeenCalledTimes(1);
  }, 20000);

  it('手动补收不受节流管（用户自己知道丢了才点）', async () => {
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    await expect(catchUpMissedPushes('startup')).resolves.toBe('drained');
    await expect(catchUpMissedPushes('manual')).resolves.toBe('drained');
    expect(list).toHaveBeenCalledTimes(2);
  }, 20000);

  it('没配 Worker 的用户一个请求都不发', async () => {
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: '' });
    const list = vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);

    await expect(catchUpMissedPushes('startup')).resolves.toBe('worker-unset');
    expect(list).not.toHaveBeenCalled();
  }, 20000);

  it('账本读不成只是「这趟没读成」，不当成「账本上没有」', async () => {
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockRejectedValue(new Error('worker 500'));

    await expect(catchUpMissedPushes('startup')).resolves.toBe('failed');
  }, 20000);
});

// 手动补收那个按钮报的「补回 N 条消息，去聊天里看看」必须是真话。
//
// 「写进收件箱」离「上了屏」还差一整趟冲刷：落库去重会丢、多段等齐会扣。
// 按收件箱那个数报的话，用户点完按钮看到「补回 2 条」，翻遍聊天记录一条也找不到——
// 而这个按钮存在的全部意义就是让他确认「消息到底还在不在」。
describe('手动补收报的是真上了屏的条数（走真库）', () => {
  const WORKER_URL = 'https://amsg-manual-catchup.example.workers.dev';

  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });

  beforeEach(async () => {
    localStorage.setItem(AMSG_OUTBOX_ADOPTED_LS_KEY, JSON.stringify({ at: Date.now() }));
    resetOutboxCatchUpThrottleForTesting();
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: WORKER_URL });
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
    // 被吞那条会顺手去云端撤自述日志（best-effort），别让它真打网络。
    vi.spyOn(ActiveMsgClient, 'readClientStateValue').mockResolvedValue(null);
    vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: '' });
  });

  /** 账本上的一条定时主动消息。messageType 用 'scheduled'，走原稿落库那条最短的路。 */
  const scheduledEntry = (charId: string, messageId: string, occurrenceMs: number) => ({
    id: 1,
    messageId,
    taskUuid: null,
    sessionId: null,
    messageIndex: 1,
    totalMessages: 1,
    createdAt: Date.now(),
    deliveredAt: null,
    push: {
      messageKind: 'content',
      messageType: 'scheduled',
      source: 'scheduled',
      message: `${charId} 的定时消息`,
      contactName: '定时角色',
      messageId,
      messageIndex: 1,
      totalMessages: 1,
      occurrenceMs,
      timestamp: new Date(occurrenceMs).toISOString(),
      metadata: {
        charId,
        charName: '定时角色',
        amsgExpirePolicy: 'expire',
        amsgClientTaskId: `client-task-${charId}`,
      },
    },
  });

  it('两条都写进收件箱，即使用户刚开过口也都补回并如实计数', async () => {
    const scheduledChar = 'char-manual-scheduled';
    const landedChar = 'char-manual-landed';
    await DB.saveCharacter({ id: scheduledChar, name: '定时角色' } as any);
    await DB.saveCharacter({ id: landedChar, name: '定时角色' } as any);

    const occurrenceMs = Date.now();
    // 一个角色最近聊过，另一个没有；已经发出的两条都应补回。
    await DB.saveMessage({
      charId: scheduledChar, role: 'user', type: 'text', content: '我在忙',
      timestamp: occurrenceMs - 60_000,
    } as any);

    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([
      scheduledEntry(scheduledChar, 'msg-manual-scheduled', occurrenceMs),
      scheduledEntry(landedChar, 'msg-manual-landed', occurrenceMs),
    ] as any);

    const { written, scanned, stale } = await catchUpMissedPushesManually();

    expect(scanned, '账本上翻过两条').toBe(2);
    expect(stale, '都是刚落账的，没有超窗的').toBe(0);
    expect(written, '两条已发出的正文都补回了').toBe(2);

    // 数字要与真正落进聊天记录的消息一致。
    const scheduledMsgs = await DB.getRecentMessagesByCharId(scheduledChar, 20);
    expect(scheduledMsgs.some((m: any) => m.role === 'assistant')).toBe(true);
    const landedMsgs = await DB.getRecentMessagesByCharId(landedChar, 20);
    expect(landedMsgs.some((m: any) => m.role === 'assistant')).toBe(true);
  }, 20000);
});

// ─── SAR 临时模块 · 即时对话回复的收尾（走真库 + 真 flush）───
//
// 云端生成的回复落库时要做和本地路径同样的收尾：每段角色外显写到那一段的气泡上、
// USER_SURFACE 和事件写回用户消息、模块回合推进一格。回合推进挂在销账块里，同一轮
// 只进一次——同一轮再冒出一条回复（worker 重试的第二份）也不能再扣。
describe('即时对话 SAR 临时模块收尾（走真库）', () => {
  beforeAll(() => {
    (globalThis as any).window ??= { dispatchEvent: () => true, addEventListener: () => {} };
  });
  beforeEach(() => {
    localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
    vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([]);
    vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).window.umami;
  });

  it('两段回复：第一段接外显、载具键不进气泡、用户消息拿到外显与事件、回合只推进一次', async () => {
    const charId = 'char-sar-instant';
    const uuid = 'uuid-sar-instant';
    const sessionId = 'sess-sar-instant';
    const sarModule = SAR_MODULE_CATALOG[0];
    const now = Date.now();
    const charModule = installSARModuleOnCharacter(sarModule, now - 60_000);
    const userModule = installSARModuleOnUser(sarModule, { id: charId, name: '模块角色' }, now - 60_000);
    await DB.saveCharacter({
      id: charId, name: '模块角色',
      vrState: { enabled: true, intervalMinutes: 120, sarModule: charModule },
    } as any);
    await DB.saveUserProfile({
      name: '小明', avatar: '', bio: '', vrState: { enabled: true, sarModule: userModule },
    } as any);
    const userMsgId = await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '晚上一起吃火锅吗', timestamp: now - 5_000,
    } as any);
    setInstantChatPending(charId, uuid);

    const snapshot: AmsgSarModuleSnapshot = {
      v: 1,
      character: toSARModuleSurfaceSource(charModule),
      user: toSARModuleSurfaceSource(userModule),
      events: createSARModuleEventMeta({
        character: charModule, user: userModule,
        hasActiveEffect: true, hasAfterglow: false, requiresEnvelope: true,
      }),
      userMessageId: userMsgId,
      userSurfaceTargetIds: [userMsgId],
      reroll: false,
    };
    const charSurfaceMeta = (surface: string) => ({
      version: 1, runId: charModule.runId, moduleId: charModule.moduleId, moduleTitle: charModule.moduleTitle,
      target: 'character', phase: 'active', surface,
      canonicalField: 'content', surfaceField: 'metadata.sarModuleSurface.surface',
    });
    const segment = (index: number, body: string, extra: Record<string, unknown>) =>
      ActiveMsgStore.saveInboxMessage({
        messageId: `msg-sar-instant-${index}`,
        charId,
        charName: '模块角色',
        body,
        messageType: 'instant',
        taskUuid: uuid,
        receivedAt: now + index,
        sentAt: now + index,
        metadata: { charId, sessionId, messageIndex: index, totalMessages: 2, amsgInstantChat: true, ...extra },
      } as any);

    await segment(1, '好啊，我请客', { amsgSarSurface: charSurfaceMeta('哼，才不要跟你去') });
    await segment(2, '七点楼下见', {
      amsgSar: snapshot,
      amsgSarUserSurface: JSON.stringify([{ id: userMsgId, surface: '晚上想一个人待着' }]),
    });
    await flushInboxToChat('SW通知');

    const assistants = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.content)).toEqual(['好啊，我请客', '七点楼下见']);
    // 第一段的外显落在第一段的气泡上；第二段没带外显就没有。
    expect(assistants[0].metadata?.sarModuleSurface?.surface).toBe('哼，才不要跟你去');
    expect(assistants[0].metadata?.sarModuleSurface?.runId).toBe(charModule.runId);
    expect(assistants[1].metadata?.sarModuleSurface).toBeUndefined();
    // 回程载具键一个都不许留在气泡上。
    for (const m of assistants) {
      for (const key of ['amsgSar', 'amsgSarSurface', 'amsgSarUserSurface', 'amsgSarUserSurfaceRef']) {
        expect(Object.prototype.hasOwnProperty.call(m.metadata || {}, key), `气泡上残留了 ${key}`).toBe(false);
      }
    }

    // 用户消息：外显 + 事件快照。
    const userMsg = await DB.getMessageById(userMsgId);
    expect(userMsg?.content).toBe('晚上一起吃火锅吗');
    expect(userMsg?.metadata?.sarModuleSurface).toMatchObject({
      target: 'user', runId: userModule.runId, surface: '晚上想一个人待着',
    });
    expect(userMsg?.metadata?.sarModuleEvents).toEqual(snapshot.events);

    // 回合各推进一格。
    const charAfter = async () => (await DB.getAllCharacters()).find((c) => c.id === charId)?.vrState?.sarModule;
    expect((await charAfter())?.remainingTurns).toBe(charModule.remainingTurns - 1);
    expect((await DB.getUserProfile())?.vrState?.sarModule?.remainingTurns).toBe(userModule.remainingTurns - 1);
    expect(getInstantChatPending(charId)).toBeNull();

    // 同一轮又来一条带快照的回复（worker 重试的第二份）：落库照常，但账已经销过，不再扣回合。
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'msg-sar-instant-dup',
      charId,
      charName: '模块角色',
      body: '七点楼下见哦',
      messageType: 'instant',
      taskUuid: uuid,
      receivedAt: Date.now(),
      sentAt: Date.now(),
      metadata: { charId, sessionId: 'sess-sar-instant-retry', messageIndex: 1, totalMessages: 1, amsgSar: snapshot },
    } as any);
    await flushInboxToChat('SW通知');

    const landed = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');
    expect(landed.map((m) => m.content), '第二份照常落库，确认它真的走到了销账那一步').toContain('七点楼下见哦');
    expect((await charAfter())?.remainingTurns, '同一轮不许扣第二次').toBe(charModule.remainingTurns - 1);
    expect((await DB.getUserProfile())?.vrState?.sarModule?.remainingTurns).toBe(userModule.remainingTurns - 1);
  }, 20000);

  it('三份内容都挪进了旁路存储 → 按引用键取回收尾、用完登记删除；外显取不回不进重试', async () => {
    const charId = 'char-sar-instant-ref';
    const uuid = 'uuid-sar-instant-ref';
    const sessionId = 'sess-sar-instant-ref';
    const sarModule = SAR_MODULE_CATALOG[0];
    const now = Date.now();
    const charModule = installSARModuleOnCharacter(sarModule, now - 60_000);
    const userModule = installSARModuleOnUser(sarModule, { id: charId, name: '模块角色' }, now - 60_000);
    await DB.saveCharacter({
      id: charId, name: '模块角色',
      vrState: { enabled: true, intervalMinutes: 120, sarModule: charModule },
    } as any);
    await DB.saveUserProfile({
      name: '小明', avatar: '', bio: '', vrState: { enabled: true, sarModule: userModule },
    } as any);
    const userMsgId = await DB.saveMessage({
      charId, role: 'user', type: 'text', content: '明天去看海吧', timestamp: now - 5_000,
    } as any);
    setInstantChatPending(charId, uuid);

    const snapshot: AmsgSarModuleSnapshot = {
      v: 1,
      character: toSARModuleSurfaceSource(charModule),
      user: toSARModuleSurfaceSource(userModule),
      events: createSARModuleEventMeta({
        character: charModule, user: userModule,
        hasActiveEffect: true, hasAfterglow: false, requiresEnvelope: true,
      }),
      userMessageId: userMsgId,
      userSurfaceTargetIds: [userMsgId],
      reroll: false,
    };
    const surfaceMeta = {
      version: 1, runId: charModule.runId, moduleId: charModule.moduleId, moduleTitle: charModule.moduleTitle,
      target: 'character', phase: 'active', surface: '海有什么好看的',
      canonicalField: 'content', surfaceField: 'metadata.sarModuleSurface.surface',
    };
    const keys = {
      surface1: 'sar_surface:client-task-sar:1',
      surface2: 'sar_surface:client-task-sar:2',
      snapshot: 'sar_snapshot:client-task-sar',
      userSurface: 'sar_user_surface:client-task-sar',
    };
    const stored: Record<string, string> = {
      [keys.surface1]: JSON.stringify(surfaceMeta),
      // keys.surface2 故意缺席：第二段的外显丢了，这一段显示真实回复，不许因此进重试。
      [keys.snapshot]: JSON.stringify(snapshot),
      [keys.userSurface]: JSON.stringify([{ id: userMsgId, surface: '海边人太多了' }]),
    };
    const readSpy = vi.spyOn(ActiveMsgClient, 'readClientStateValue')
      .mockImplementation(async (_ns: string, key: string) => stored[key] ?? null);
    const clearSpy = vi.spyOn(ActiveMsgClient, 'clearClientStateValue').mockResolvedValue(undefined as any);

    const segment = (index: number, body: string, extra: Record<string, unknown>) =>
      ActiveMsgStore.saveInboxMessage({
        messageId: `msg-sar-instant-ref-${index}`,
        charId,
        charName: '模块角色',
        body,
        messageType: 'instant',
        taskUuid: uuid,
        receivedAt: now + index,
        sentAt: now + index,
        metadata: { charId, sessionId, messageIndex: index, totalMessages: 2, amsgInstantChat: true, ...extra },
      } as any);
    await segment(1, '好啊，我带相机', { amsgSarSurfaceRef: keys.surface1 });
    await segment(2, '早上八点出发', {
      amsgSarSurfaceRef: keys.surface2,
      amsgSarRef: keys.snapshot,
      amsgSarUserSurfaceRef: keys.userSurface,
    });
    await flushInboxToChat('SW通知');

    const ns = amsgStateNamespace(charId);
    const assistants = (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');
    expect(assistants.map((m) => m.content)).toEqual(['好啊，我带相机', '早上八点出发']);
    expect(assistants[0].metadata?.sarModuleSurface?.surface).toBe('海有什么好看的');
    expect(assistants[1].metadata?.sarModuleSurface, '取不回的那段显示真实回复').toBeUndefined();
    expect(await ActiveMsgStore.listInboxMessages(), '外显丢了不许把消息压回收件箱').toEqual([]);
    for (const m of assistants) {
      for (const key of ['amsgSarRef', 'amsgSarSurfaceRef', 'amsgSarUserSurfaceRef']) {
        expect(Object.prototype.hasOwnProperty.call(m.metadata || {}, key), `气泡上残留了 ${key}`).toBe(false);
      }
    }

    const userMsg = await DB.getMessageById(userMsgId);
    expect(userMsg?.metadata?.sarModuleSurface?.surface).toBe('海边人太多了');
    expect(userMsg?.metadata?.sarModuleEvents).toEqual(snapshot.events);
    expect((await DB.getAllCharacters()).find((c) => c.id === charId)?.vrState?.sarModule?.remainingTurns)
      .toBe(charModule.remainingTurns - 1);
    expect((await DB.getUserProfile())?.vrState?.sarModule?.remainingTurns).toBe(userModule.remainingTurns - 1);

    for (const key of Object.values(keys)) expect(readSpy).toHaveBeenCalledWith(ns, key);
    // 取回成功的三份都删；没取回的那份不删（本来就不在）。清理是 fire-and-forget，等一拍。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clearSpy).toHaveBeenCalledWith(ns, keys.surface1);
    expect(clearSpy).toHaveBeenCalledWith(ns, keys.snapshot);
    expect(clearSpy).toHaveBeenCalledWith(ns, keys.userSurface);
    expect(clearSpy).not.toHaveBeenCalledWith(ns, keys.surface2);
  }, 20000);
});

describe('停止的instant回程', () => {
  it('迟到的正文直接销账丢弃，不走重试或原稿降级', async () => {
    const { markReplyStopped } = await import('./chatReplyCancellation');
    (globalThis as any).window ??= { dispatchEvent: () => true };
    const charId = 'stopped-inbox-char';
    await DB.saveCharacter({ id: charId, name: '角色' } as any);
    markReplyStopped('stopped-inbox-task');
    await ActiveMsgStore.saveInboxMessage({
      messageId: 'stopped-inbox-message', taskUuid: 'stopped-inbox-task',
      charId, charName: '角色', source: 'instant', messageType: 'text',
      body: '不要显示这句话', receivedAt: Date.now() - 100000,
    } as any);
    await flushInboxToChat('轮询补收');
    expect(await DB.getRecentMessagesByCharId(charId, 20)).toEqual([]);
    expect((await ActiveMsgStore.consumeInboxMessages()).filter(m => m.taskUuid === 'stopped-inbox-task')).toEqual([]);
  });
});

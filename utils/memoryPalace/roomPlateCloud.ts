/**
 * 门牌整理走云端那条路（提交 → 等结果 → 合并落库）
 *
 * 本地那条路（roomPlates.ts 的 consolidatePlates）是「读库 → 调 LLM → 合并落库」一条龙，
 * 全程 await，页面一关就断。云端这条路把中间那段搬走：客户端把材料装成一份 job 交上去
 * 就返回，LLM 在用户自己的 CF Worker 上跑；跑完结果落进服务端收件箱，客户端下次上线
 * 补收回来，再做合并落库。
 *
 * 合并为什么留在本地：要合并进去的门牌本体在浏览器的 IndexedDB 里，云端够不着。而合并
 * 语义（basedOn 继承来历、没被重新输出的条目淘汰）是纯函数，放哪儿跑都一样。
 *
 * 一个必须处理的时间差：提示词是拿**提交那一刻**的门牌快照拼的，而结果可能几分钟后才
 * 回来，这中间门牌说不定已经被别的路径动过（封盒、手动回填都在本地跑）。所以提交时把
 * 每条的 id 一起带上、结果原样回传，落地时按 id 做两件事：
 *   1. 把 `basedOn` 标签重新对准当前条目（remapBasedOnLabels）；
 *   2. 把**快照之后新增的条目**护住不淘汰（mergeCloudPlateEntries）——LLM 没见过它们，
 *      谈不上「决定淘汰」。
 * 还有一道防线在提交侧：同一个角色同时只许一份整理在飞（见 in-flight 记号），两份结果
 * 先后落地就是拿两份旧快照互相盖。
 */

import { ActiveMsgClient, mayHaveCreatedBackgroundJob } from '../activeMsgClient';
import type { AmsgResultContext } from '../amsgResults';
import { cloudApiCallLogId, recordCloudApiCall, settleCloudApiCall } from '../apiCallLog';
import { buildCharMemoryCredRow } from '../amsgLlmCredentials';
import {
  PLATE_CONSOLIDATE_KIND,
  type PlateJobRoom,
  buildPlateJobInput,
  buildPlateJobMessages,
  parsePlateConsolidateResult,
  plateJobKey,
} from '../amsgPlateJob';
import { ROOM_PLATES_UPDATED_EVENT, mutatePlate } from './db';
import {
  PLATE_LLM_MAX_TOKENS,
  PLATE_LLM_TEMPERATURE,
  type PlateMaterial,
  mergeCloudPlateEntries,
  remapBasedOnLabels,
} from './roomPlateCore';
import type { PlateRoom, RoomPlate } from './types';

const HEADER = '🚪 [RoomPlate:云端]';

/** 记忆宫殿副 API 的形状（与本地那条路的 LightLLMConfig 同构）。 */
interface PlateLightLLM {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// ─── 在飞记号（同一角色同时只许一份整理） ─────────────

/**
 * 「这个角色有一份整理正在云端跑」的记号。
 *
 * 没有它的话，两次消化挨得近（手动连点、或者一轮聊得快）就会先后交两份 job，而它们拿
 * 的是**同一份或相邻的旧快照**：后回来那份按自己那份快照做合并，先回来那份的整理成果
 * 被整块盖掉，还白烧一次 API。放 localStorage 而不是内存变量，是因为提交完用户多半就
 * 切走了，页面重开还得认得出上一份没回来。
 */
const PLATE_JOB_INFLIGHT_KEY = (charId: string) => `mp_plateJobInFlight_${charId}`;

/**
 * 记号最多挡这么久。超了就当那份不会回来了（worker 挂了 / 任务被清了 / 结果丢了），
 * 放行下一次——门牌一直不更新比偶尔重叠一次严重得多。
 */
const PLATE_JOB_INFLIGHT_TTL_MS = 30 * 60_000;

interface PlateJobInFlight {
  jobId: string;
  /**
   * 这份整理在云端那条任务行的 uuid。
   *
   * 记着它才有办法**回头找到那条任务**：删角色时要把它取消掉（不取消的话，一条已经
   * 没有落脚点的整理会照常烧一次副 API），排障时也要靠它把「设置里那笔云端生成中」
   * 跟 D1 上那一行对上号。提交答复丢在路上时拿不到（任务可能建了、编号却没回来），
   * 那种只能等 TTL——所以是可选的。
   */
  uuid?: string;
  /** 提交那一刻（epoch 毫秒）。TTL 从它算起。 */
  at: number;
  /**
   * 交上去那份门牌快照是**什么时候读出来的**（epoch 毫秒）。
   *
   * 跟 `at` 差着一小段：读完门牌之后还要拼身份上下文、过一遍能不能交云端那几道门
   * （其中一道要发请求）、把消化刚提交的候选先保底并进去，才轮到提交。这段时间里
   * 用户在门牌面板上改的字，LLM 是看不到的——落地时得按**读快照那一刻**去认「这条
   * 是不是等结果期间被本地改过」，按提交时刻认就会把这一段的编辑漏掉，用户刚敲的字
   * 被一份陈旧结果原样盖回去。
   */
  snapshotAt: number;
}

/**
 * 读在飞记号的**原值**：不看 TTL，也不做任何收尾。
 *
 * 「本地记着的那个 job 编号是什么」和「那份还算不算在飞」是两个问题，问后者的那个函数
 * （下面的 readPlateJobInFlight）超时后会返回 null，但不清记号。
 * 删角色时要清云端那份输入、结果落地时要认「这是不是当前这一份」，问的都是前者。
 */
export const readPlateJobInFlightRaw = (charId: string): PlateJobInFlight | null => {
  try {
    const raw = localStorage.getItem(PLATE_JOB_INFLIGHT_KEY(charId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlateJobInFlight>;
    if (typeof parsed?.jobId !== 'string') return null;
    if (typeof parsed?.at !== 'number' || typeof parsed?.snapshotAt !== 'number') return null;
    return {
      jobId: parsed.jobId,
      at: parsed.at,
      snapshotAt: parsed.snapshotAt,
      ...(typeof parsed.uuid === 'string' && parsed.uuid ? { uuid: parsed.uuid } : {}),
    };
  } catch {
    return null;
  }
};

/**
 * 这个角色现在有没有一份整理在飞；没有、读不出来、或者已经超时都返回 null。
 *
 * **纯判断，不动任何状态**。超时那份的收尾（清记号、把挂着的调用记录记成失败）是
 * sweepExpiredPlateJob 的活儿。合在一起过：这个函数在一轮整理里会被问到两次（决定
 * 交不交云端时一次、提交抛错后判断「是不是已经建起来了」时一次），TTL 边界正好落在
 * 两次之间的话，第二次问会就地把闸删掉、把那笔记成失败，而第一次的决定是照着相反的
 * 答案做的。「问一句」和「收个尾」是两件事，别让问的人替答的人做决定。
 */
export const readPlateJobInFlight = (charId: string): PlateJobInFlight | null => {
  const mark = readPlateJobInFlightRaw(charId);
  if (!mark) return null;
  return Date.now() - mark.at > PLATE_JOB_INFLIGHT_TTL_MS ? null : mark;
};

/**
 * 把超时那份就地收掉：清记号 + 把「API 调用记录」里那笔挂着的记成失败。
 *
 * 不收的话它会一直写着「云端生成中」，直到 5 天后被裁掉——用户看到的是一条永远转圈的
 * 记录，分不清是还在跑还是早就没了。收尾要有个明确的时机，所以放在每轮整理的最开头
 * （plateCloudGate）跑一次，而不是搭在「还在飞吗」那句问话的便车上。
 */
export const sweepExpiredPlateJob = (charId: string): void => {
  const mark = readPlateJobInFlightRaw(charId);
  if (!mark) return;
  if (Date.now() - mark.at <= PLATE_JOB_INFLIGHT_TTL_MS) return;
  console.warn(`${HEADER} 上一份整理超过 ${PLATE_JOB_INFLIGHT_TTL_MS / 60_000} 分钟没回来，当它不会来了（job ${mark.jobId}）`);
  clearPlateJobInFlight(charId);
  settleCloudApiCall({ id: cloudApiCallLogId(mark.jobId), ok: false });
};

const markPlateJobInFlight = (charId: string, jobId: string, snapshotAt: number): void => {
  try {
    localStorage.setItem(
      PLATE_JOB_INFLIGHT_KEY(charId),
      JSON.stringify({ jobId, at: Date.now(), snapshotAt } satisfies PlateJobInFlight),
    );
  } catch { /* 存不下就退回没有闸的老行为，不值得为它中断整理 */ }
};

/**
 * 任务建起来之后把远端编号补进记号里。
 *
 * 分两步写是因为记号必须在**发请求之前**就落下（答复丢在路上时它是唯一的痕迹），
 * 而 uuid 要等答复回来才知道。补不上（记号这会儿已经被别人清了）就算了：那说明这一份
 * 已经不作数，写回去反而会把一条死记号复活。
 */
const attachPlateJobUuid = (charId: string, jobId: string, uuid: string): void => {
  const mark = readPlateJobInFlightRaw(charId);
  if (!mark || mark.jobId !== jobId) return;
  try {
    localStorage.setItem(PLATE_JOB_INFLIGHT_KEY(charId), JSON.stringify({ ...mark, uuid } satisfies PlateJobInFlight));
  } catch { /* 补不上最多是删角色时取消不掉那条任务，等它自己跑完 */ }
};

/** 清掉在飞记号。结果落地、提交失败、以及删角色时都要清。 */
export const clearPlateJobInFlight = (charId: string): void => {
  try { localStorage.removeItem(PLATE_JOB_INFLIGHT_KEY(charId)); } catch { /* 清不掉最多多挡半小时 */ }
};

// ─── 提交 ─────────────────────────────────────────────

/**
 * 这一轮能不能交给云端跑：记忆宫殿副 API 配齐了才行。
 *
 * 刻意不回落到主 API——本地那条路也不回落（记忆宫殿 App 的手动按钮在副 API 没配时直接
 * 报错），拿主 API 悄悄跑一遍后台整理会把用户的额度花在他没同意的地方。配不齐返回 null，
 * 调用方留在本地按原来的规矩跑。
 */
export const buildPlateCredRow = (charId: string, lightLLM: PlateLightLLM | null | undefined) =>
  buildCharMemoryCredRow(charId, lightLLM);

/**
 * 这一轮拿云端怎么办的三种结论。
 *
 * `local` 和 `skip` 的区别是这道门最容易搞错的地方：**「交不出去」和「不用交」不一样**。
 * 交不出去（没配、worker 太老）得退回本地把活儿干了，不然门牌永远不更新；不用交
 * （已经有一份在云端跑着）反而必须什么都不做——本地再全量整理一遍既白烧一次 API，
 * 结果还会和在飞那份互相盖。
 */
export type PlateCloudGate = 'submit' | 'local' | 'skip';

/**
 * 这一轮该不该交云端：副 API 配齐 + 这台 worker 认识后台任务 + 没有另一份还在飞。
 *
 * 三道门的顺序是这个函数最容易改错的地方，两头都有坑：
 *
 *   - **「路断了」要排在「有一份在飞」前面**。反过来的话，一份交出去再没回来的任务会
 *     让接下来半小时既不走云端、也不退回本地——用户中途关掉主动消息 2.0、或者 worker
 *     挂了，整理就整整半小时一次都不做，而 skip 的语义本来是「云端正在替我们干这件事」。
 *   - **但「这次没问到」不算路断**。探测要发一次请求，代理切换、CF 边缘抖一下、D1 冷
 *     启动超时都会让它落空；这种时候手上那份任务多半好好地在云端跑着，退回本地就是拿
 *     同一份快照再烧一次副 API，两份结果还先后落地互相盖——正是这道闸要防的事。所以
 *     「问不到」时先看有没有在飞的，有就 skip，没有才退回本地。
 *
 * 老 bundle 会把后台任务当聊天任务跑、终态失败，而那条任务行不在用户的清单里，面板一片
 * 正常门牌却永远不更新——「不支持」那一支就是为了别走到那儿。
 *
 * 探测那道门收在这儿一起导出，调用方就只认这一个入口——分散到两个模块的话，探测换名字
 * 或换语义要改两处，漏一处就是「点了灯却走本地」那种查不出来的静默分流。
 */
export const plateCloudGate = async (args: {
  charId: string;
  lightLLM: PlateLightLLM | null | undefined;
}): Promise<PlateCloudGate> => {
  // 上一份躺太久的先收掉，再往下判——收尾要有个明确的时机，别搭在下面那句「还在飞吗」
  // 的便车上（见 readPlateJobInFlight / sweepExpiredPlateJob）。
  sweepExpiredPlateJob(args.charId);

  if (!buildPlateCredRow(args.charId, args.lightLLM)) return 'local';

  const { isAmsg2GlobalReady } = await import('../amsg2ToolBridge');
  if (!await isAmsg2GlobalReady()) return 'local';

  const support = await ActiveMsgClient.probeBackgroundJobSupportDetailed();
  if (support === 'unsupported') {
    console.log(`${HEADER} 这台 Worker 的代码还不认识后台任务，这轮在本地整理`);
    return 'local';
  }

  const inFlight = readPlateJobInFlight(args.charId);
  if (inFlight) {
    console.log(`${HEADER} 上一份整理还在云端跑（job ${inFlight.jobId}），这轮不重复交`);
    return 'skip';
  }

  if (support === 'unknown') {
    console.log(`${HEADER} 这轮没问到 Worker 支不支持后台任务，手上也没有在飞的整理，先在本地跑掉`);
    return 'local';
  }
  return 'submit';
};

/**
 * 把一次整理交给云端。
 *
 * 一律抛错，绝不静默降级——静默分流那种「三个点照亮、测试照过、云端一条日志都没有」
 * 的坑踩过一次就够了。
 *
 * 但**抛错不等于「没交出去」**：请求发出去却没等到答复时，任务可能已经在云端建起来了。
 * 那种情况这里把在飞记号留着，调用方据此判断能不能退回本地跑（见 tryCloudConsolidation）。
 */
export const submitPlateConsolidation = async (args: {
  charId: string;
  charName: string;
  userName: string;
  identityContext: string;
  plates: RoomPlate[];
  materials: PlateMaterial[];
  lightLLM: PlateLightLLM | null | undefined;
  /**
   * `plates` 是**什么时候读出来的**（epoch 毫秒）。不是「现在几点」——落地时要靠它认出
   * 「LLM 看不到的那些本地修改」，取晚了这段时间里的编辑就会被陈旧结果盖回去。
   */
  snapshotAt: number;
}): Promise<{ jobId: string; uuid: string }> => {
  const credRow = buildPlateCredRow(args.charId, args.lightLLM);
  if (!credRow) throw new Error('记忆宫殿副 API 没配齐，门牌整理交不了云端');

  const rooms: PlateJobRoom[] = args.plates.map((p) => ({
    room: p.room,
    entries: p.entries.map((e) => e.text),
    entryIds: p.entries.map((e) => e.id),
  }));

  const jobId = crypto.randomUUID();
  const jobInput = buildPlateJobInput({
    charId: args.charId,
    charName: args.charName,
    userName: args.userName,
    identityContext: args.identityContext,
    rooms,
    materials: args.materials,
    snapshotAt: args.snapshotAt,
  });

  // 记号和调用记录都在**发请求之前**落下。事后再落的话，「请求到了服务端、答复却丢在
  // 路上」那一种会一点痕迹都不留：任务照跑照扣费，本地却当它没交出去——这一轮退回本地
  // 再全量跑一遍（同一份快照烧两次 API、两份结果先后落地互相盖），而那笔烧掉的副 API
  // 调用在「设置 → API 调用记录」里一条都看不到，排查「谁在烧我的 Key」直接断线。
  markPlateJobInFlight(args.charId, jobId, args.snapshotAt);

  // 这一次调用记进「设置 → API 调用记录」：请求是云端发的，本地的 fetch 拦截器只认
  // `/chat/completions`，够不着它。结果回程时带上供应商回报的 usage 一并补齐。
  recordCloudApiCall({
    id: cloudApiCallLogId(jobId),
    route: 'cloud-plate-consolidate',
    baseUrl: args.lightLLM?.baseUrl || '',
    model: args.lightLLM?.model || '',
    messages: buildPlateJobMessages(jobInput),
    meta: { appId: 'memorypalace', appName: '记忆宫殿', purpose: '门牌整理', charId: args.charId, charName: args.charName },
  });

  let uuid: string;
  try {
    ({ uuid } = await ActiveMsgClient.scheduleBackgroundJob({
      kind: PLATE_CONSOLIDATE_KIND,
      charId: args.charId,
      charName: args.charName,
      jobKey: plateJobKey(jobId),
      jobId,
      jobInput,
      credRow,
      // 与本地那条路同一组采样参数（叶子里那两个常量），别让同一批材料在两条路上
      // 跑出不一样的门牌：整理是照着材料重排不是创作，温度要压低；四块门牌一次全量
      // 输出很长，输出上限要给足，不给的话回复会被截断、只能靠解析容错抢救半份。
      temperature: PLATE_LLM_TEMPERATURE,
      maxTokens: PLATE_LLM_MAX_TOKENS,
    }));
  } catch (error) {
    // 服务端答复了「不行」= 确定没建成，痕迹全收干净，下一轮照常再试。
    // 没等到答复的那一种不收：任务可能真在云端跑着，记号留着挡住下一轮重复提交，
    // 调用记录留着等结果回来收尾；真没建成的话，下一轮整理的 sweepExpiredPlateJob
    // 会在超过 30 分钟时把两样都收掉。
    if (!mayHaveCreatedBackgroundJob(error)) {
      clearPlateJobInFlight(args.charId);
      settleCloudApiCall({ id: cloudApiCallLogId(jobId), ok: false });
    }
    throw error;
  }

  // 远端编号补进记号：删角色时要靠它把这条任务取消掉。
  attachPlateJobUuid(args.charId, jobId, uuid);

  console.log(`${HEADER} 已交给云端整理 ${rooms.length} 块门牌（job ${jobId}，任务 ${uuid}）`);
  return { jobId, uuid };
};

// ─── 落地 ─────────────────────────────────────────────

/**
 * 一份整理结果最多还能用多久。
 *
 * 结果晚到是常态（正是为此才上云的），所以补收那条路刻意不拿聊天那两天的窗口去卡它。
 * 但不能真的没有上限：服务端账本留 28 天，换设备 / 重装 PWA / 清过 localStorage 的用户
 * 第一次接上账本时会把这些老结果一次性拉回来，那时候拿一份月前的快照去改写门牌，改的是
 * 一块早就被后来几十轮整理翻过好几遍的门牌。一周足够覆盖「关掉笔记本过个周末」，也拦得住
 * 「一个月后重装」。
 */
const PLATE_RESULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 已经落过地的 job 编号（每角色留最近几条）。
 *
 * 同一份结果会被送到两次以上：销账那一步失败（断网）下次上线还会拉回来，推送直达那条腿
 * 收下之后压根不销账、补收时又来一遍。落地本身不是幂等的——`mergePlateEntries` 对每条
 * 保留下来的条目 `sourceCount + 1`，那个数字就是门牌面板上的「印证 N 次」，重放一次全
 * 门牌集体虚增一次，版本号也白跳一格。所以认编号，见过的直接销账走人。
 */
const PLATE_JOB_DONE_KEY = (charId: string) => `mp_plateJobDone_${charId}`;
/** 留几条。够盖住「一条结果反复重放」和「几份结果先后回来」，又不至于把 localStorage 撑大。 */
const PLATE_JOB_DONE_KEEP = 8;

const readDoneJobIds = (charId: string): string[] => {
  try {
    const raw = localStorage.getItem(PLATE_JOB_DONE_KEY(charId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

const markJobDone = (charId: string, jobId: string): void => {
  try {
    const next = [jobId, ...readDoneJobIds(charId).filter((id) => id !== jobId)].slice(0, PLATE_JOB_DONE_KEEP);
    localStorage.setItem(PLATE_JOB_DONE_KEY(charId), JSON.stringify(next));
  } catch { /* 记不下就退回没有这道闸的老行为：重放会让「印证 N 次」多加一次 */ }
};

/** 删角色时连这本底账一起清掉，别在 localStorage 里留一串没主的编号。 */
export const clearPlateJobDone = (charId: string): void => {
  try { localStorage.removeItem(PLATE_JOB_DONE_KEY(charId)); } catch { /* 清不掉只是占几十字节 */ }
};

/**
 * 云端整理结果落地：重新对准标签 → 合并（护住快照后新增的条目）→ 落库。
 *
 * @param context 这条结果的随身信息（`createdAt` = 它是什么时候记进服务端账本的）。
 *   推送直达那条腿是刚刚发生的事，不用传。
 * @returns 这条结果能不能销账。落库出错时抛出去，由分发口记成「账没销」——整理跑一次
 *   要一两分钟还烧一次 API，不能因为一次 IDB 抖动就丢掉。
 */
export const applyPlateConsolidateResult = async (
  payload: unknown,
  context?: AmsgResultContext,
): Promise<boolean> => {
  const result = parsePlateConsolidateResult(payload);
  if (!result) {
    console.warn(`${HEADER} 结果形状认不出来，丢弃`, payload);
    return true;
  }

  const { charId, items } = result;

  // 先读原值再动它：这枚记号既是「这份结果对应哪一次提交」的凭据，也带着快照时刻
  // （下面合并时要靠它认出「快照之后被本地改过」的条目）。
  const inFlight = readPlateJobInFlightRaw(charId);
  const isCurrentJob = inFlight?.jobId === result.jobId;
  if (!isCurrentJob && inFlight) {
    console.warn(`${HEADER} 这份结果（job ${result.jobId}）不是当前在飞那一份（job ${inFlight.jobId}），照常落地但不动闸`);
  }

  /**
   * 闸放开。**只清自己那一份**：编号对不上还照清的话，一条迟到的（上一份超时之后才姗姗
   * 来迟）或者被重放的（销账失败，下次上线又拉回来一遍）结果，会把另一份**真正还在跑**
   * 的任务的闸打开——下一轮又交一份上去，两份带着各自的旧快照先后落地互相盖。
   */
  const releaseGate = () => { if (isCurrentJob) clearPlateJobInFlight(charId); };

  /**
   * 这一笔云端调用的结论。**只在落库真的走完之后才收**，而且只收一次。
   *
   * 收早了两头都会说谎：这份结果被丢掉（太旧、内容空）时那笔已经写着 ok，而它其实白烧
   * 了；落库中途炸掉时那笔也写着 ok，可一条门牌都没写进去，而结果还会被重放、重放时又
   * 收一遍。所以三条出口各说各的实话，落库失败那条干脆不收——账没销，下次上线重放，
   * 那时候再照实收。
   */
  const settle = (ok: boolean) => settleCloudApiCall({
    id: cloudApiCallLogId(result.jobId),
    ok,
    ...(result.usage?.promptTokens !== undefined ? { promptTokens: result.usage.promptTokens } : {}),
    ...(result.usage?.completionTokens !== undefined ? { completionTokens: result.usage.completionTokens } : {}),
  });

  // 这份已经落过地了（销账失败被重放、或者推送和补收两条腿各送了一遍）。再合并一次的
  // 代价不是「白做一遍」而是**门牌被改坏**：合并对每条保留下来的条目 sourceCount + 1，
  // 门牌面板上的「印证 N 次」会跟着重放次数一路虚增。销账走人。
  if (readDoneJobIds(charId).includes(result.jobId)) {
    console.log(`${HEADER} 这份结果（job ${result.jobId}）之前已经落过地了，直接销账`);
    releaseGate();
    return true;
  }

  const age = typeof context?.createdAt === 'number' && context.createdAt > 0
    ? Date.now() - context.createdAt
    : 0;
  if (age > PLATE_RESULT_MAX_AGE_MS) {
    console.warn(`${HEADER} 这份结果已经躺了 ${Math.round(age / 86_400_000)} 天，门牌早翻过好几轮了，丢弃（job ${result.jobId}）`);
    settle(false);
    releaseGate();
    return true;
  }

  if (items.length === 0) {
    // worker 那边解析不出条目时压根不会送结果，走到这里说明形状对但内容空。
    // 空列表当「LLM 决定清空」处理会把整块门牌抹掉，宁可不动。
    console.warn(`${HEADER} 结果里没有条目，门牌保持不动（job ${result.jobId}）`);
    settle(false);
    releaseGate();
    return true;
  }

  // 角色还在不在。删角色时清的是云端那份**输入**，可这份结果说明 LLM 早就跑完了——
  // 输入那时候已经被 worker 自己删掉，清了个寂寞。这里不拦的话，下次上线补收会拿它
  // 给一个已经不存在的角色**重新建出四块门牌**（loadOrCreatePlate 没有就现造），
  // 里面装着那个角色蒸馏出来的全部认知，而删除确认框跟用户说的是「记忆将被清空」。
  try {
    const { DB } = await import('../db');
    const chars = await DB.getAllCharacters();
    if (!chars.some((c) => c.id === charId)) {
      console.warn(`${HEADER} 这份结果的角色已经被删掉了，丢弃（job ${result.jobId}）`);
      settle(false);
      releaseGate();
      clearPlateJobDone(charId);
      return true;
    }
  } catch (error) {
    // 角色库读不出来（IDB 抖了一下）：不结论也不落地，账留着下次再来。宁可晚几分钟，
    // 也别在「不知道角色还在不在」的时候往库里写四块门牌。
    console.warn(`${HEADER} 查不到角色还在不在，这份结果留着下次再落（job ${result.jobId}）`, error);
    return false;
  }

  const now = Date.now();
  const updated: PlateRoom[] = [];
  // 在飞记号只挡 30 分钟，结果却允许晚到一周；下一轮整理可能已经清掉或覆盖了记号。
  // 结果必须能带回自己的快照时间，否则提交前的历史改写也会被误认成提交后的编辑。
  // 旧 Worker 未回传时仍可用同 job 的本地记号；两边都没有才保守保护，不能借用新 job 的时间。
  const snapshotAt = (isCurrentJob ? inFlight?.snapshotAt : undefined) ?? result.snapshotAt ?? 0;

  // 逐块串行：并发跑会同时开好几个 IDB 事务，连接一挤爆，推送收件那边就会跟着超时。
  // 走 mutatePlate 而不是自己「读一份 → 改 → 存回去」：同一块门牌上还有别的路在写
  // （门牌面板的手改、本地整理、送达保证兜底），各写各的就是互相整块盖掉。
  for (const { room, entryIds } of result.rooms) {
    const roomItems = items.filter((i) => i.room === room);
    // 一个条目都没提到的房间跳过保存——区分「LLM 决定清空」和「LLM 忘了这个房间 /
    // 输出被截断」，宁可保守不动，等下轮消化再整理。与本地那条路同一个规矩。
    if (roomItems.length === 0) continue;

    // 对齐之后一条不剩 = 这个房间的结果整份都是「保留几条已经被删掉的条目」。同样按
    // 「宁可保守不动」处理：拿空列表往下走会被合并语义当成「LLM 决定清空」，把这块门牌
    // 连同提交之后新增的条目一起抹掉。变换要保持是纯的，所以只在里面做个标记，
    // 日志出来之后再打。
    let allDeleted = false;
    const saved = await mutatePlate(charId, room, (plate) => {
      const aligned = remapBasedOnLabels(room, roomItems, entryIds, plate.entries);
      if (aligned.length === 0) {
        allDeleted = true;
        return null;
      }
      return {
        ...plate,
        entries: mergeCloudPlateEntries(room, plate.entries, aligned, entryIds, now, snapshotAt),
        updatedAt: now,
        version: plate.version + 1,
      };
    });
    if (allDeleted) {
      console.warn(`${HEADER} 「${room}」这份结果保留的条目在提交之后都已被删掉，门牌保持不动`);
      continue;
    }
    if (!saved) continue;
    updated.push(room);
    console.log(`${HEADER} 「${room}」v${saved.version}：${saved.entries.length} 条`);
  }

  // 记「这份落过地了」和放闸都留到**落库全部走完**。提前做的话，中途某一块存不进去
  // （IDB 配额、事务被中断）这份结果不销账、下次上线还会重放：闸已经开着，期间的消化
  // 又交了一份新的上去，两份带着不同的旧快照先后落地互相盖；而重放那次会被幂等闸挡在
  // 门外，剩下的房间就再也补不上了。
  markJobDone(charId, result.jobId);
  settle(true);
  releaseGate();

  if (updated.length > 0) {
    window.dispatchEvent(new CustomEvent(ROOM_PLATES_UPDATED_EVENT, { detail: { charId, rooms: updated } }));
  }
  return true;
};

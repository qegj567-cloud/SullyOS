/**
 * 角色在「到点生成主动消息」那一刻给自己排下一条的工具。
 *
 * 前台聊天里角色已经有 schedule_active_message（见 amsg2ToolBridge），这里用同一个名字、
 * 同一套参数把它开到 fire 侧——角色不用学第二套东西，两端说的是同一件事。差别只在执行：
 * 前台走客户端 API，fire 侧走 amsg-server 的 ctx.scheduleTask 直接在 D1 建行，用户离线
 * 也照样排得上（这正是整件事的意义：连着说两句不需要用户在线当中转）。
 *
 * 零运行时依赖（worker bundle 会打进这份代码）：只有纯函数和常量。
 */

import type { ActiveMsg2ExpirePolicy, ActiveMsg2Mode, ActiveMsg2Recurrence, ActiveMsg2TaskRecord } from '../types';
import { currentOccurrenceMs, isPendingTask, shortTaskId } from './amsg2Tasks';
import { type AmsgTzRef, formatFireTimeShort, wallClockPartsInZone } from './amsgFirePack';
import { wallClockToTimestamp } from './timezone';

/** 与前台同名，故意的：见文件头。 */
export const AMSG_FIRE_SCHEDULE_TOOL = 'schedule_active_message';

/** 取消 / 改期也开到 fire 侧（amsg-server 2.6.0-next.15 的 ctx.cancelTask / renewTask）。 */
export const AMSG_FIRE_CANCEL_TOOL = 'cancel_active_message';
export const AMSG_FIRE_RENEW_TOOL = 'renew_active_message';

/**
 * 单次 fire 最多让角色排几条。
 *
 * 上游库自己也有一道同名护栏（默认 2），这里保持一致、不额外收紧：真排爆了是角色的问题，
 * 不是链路该替它兜的。留在这里是为了在打回时能给出一句人话，而不是让上游抛 RangeError
 * 把整条 fire 弄失败——那样用户连本来能收到的那条消息都没了。
 */
export const MAX_FIRE_SCHEDULES = 2;

/**
 * 到点策略的说明，前台工具和 fire 侧共用这一份。
 *
 * 分界线不是「谁提的」，是「到点要说的是一件具体的事，还是只是想找话说」：
 * 想找话说的，用户人回来了就该让路；许过的具体承诺（不管是用户要求的还是角色自己说的），
 * 用户中途回来聊过天也不影响它该响。早先这段只写了「用户明确要求的闹钟」，把角色自己
 * 许下的承诺挡在外面了——「汤炖上了两小时后叫你」会被判成该让路，然后再没人提起。
 */
export const EXPIRE_POLICY_DESCRIPTION = [
  '到点策略。',
  'expire（默认，大多数情况用它）：到点时你会先看一眼最新的对话再开口——这件事已经聊过了、或者插进来会打断正在说的事，这次就不发；没发的之后你会在排程现状里看到，由你决定自然带出、续期还是放弃。',
  '挑话题、想找人聊天这类「想说点什么」的排程一律用它：用户人都回来了，你还照着几小时前的想法开口，会很假。',
  'force：准点照发，不等也不让。用在「到那个点必须说这件具体的事」上，两种来源都算——用户明确要求的（如"8点叫我起床"），以及你自己许下的（如"汤炖上了，两小时后好了叫你""你那个会我到点提醒你"）。',
  '这类兑现的是一个具体承诺，用户中途回来聊过天也不影响它该响。',
].join('\n');

/** 即时对话是在回复用户，不能沿用「正在发主动消息」的语境。 */
const buildScheduleToolDescription = (context: 'chat' | 'fire') => [
  ...(context === 'chat'
    ? [
      '创建定时主动消息：到指定时间后，你会根据最新聊天上下文生成并推送消息给用户。',
      '正在聊天时，你也可以因为惦记、想分享自己的生活、兑现承诺，给未来的自己排一次联系，不必等用户明确要求。',
    ]
    : [
      '给自己排下一条主动消息：到指定时间后你会再根据那时的上下文生成一条推送给用户。',
      '你现在正在发一条主动消息，这个工具让你把话接着往下说——比如这条先说一半，过一两个小时再接上去；或者你说了要去做某件事，做完的时间点回来告诉用户。',
    ]),
  '排下的这条到点时会知道你这次说了什么，能接得上，不用在参数里复述。',
  'send_at 是开始生成的时间，不是送达时间（生成有十几秒延迟），且必须至少比现在晚 1 分钟。',
  `一次最多排 ${MAX_FIRE_SCHEDULES} 条；每个角色同时挂的任务也有上限，排不下时会告诉你。`,
  context === 'chat'
    ? '未来那个时刻真的想联系就排，尊重用户的生活和「别打扰」，不要为了排而排。'
    : '没有「接着说」的必要就别排——为了排而排出来的后续，用户读起来就是没话找话。',
].join('\n');

export interface FireScheduleToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** 工具声明 / 说明块的时间上下文：示例按「明天这个点」现算，参照系跟 fire_pack 走。 */
export interface FireScheduleTimeOpts {
  nowMs: number;
  tz: AmsgTzRef;
}

/**
 * 用户放没放开的两项能力（见 amsgLimits）。没放开的参数干脆不出现在工具签名里：
 * 摆在那儿等于邀请模型去选，选了再被打回白费一轮。代码那头照样拦（checkSelfScheduleRules）。
 */
export interface SelfScheduleAbilities {
  allowRecurring: boolean;
  allowForce: boolean;
}

/** 前台工具桥和 fire 侧共用的参数表（描述里的示例与说法两边各给）。 */
export const buildScheduleParameters = (opts: {
  sendAtDescription: string;
  modeDescription: string;
  promptHintDescription: string;
  recurrenceDescription: string;
  abilities: SelfScheduleAbilities;
}) => ({
  type: 'object',
  properties: {
    send_at: { type: 'string', description: opts.sendAtDescription },
    mode: {
      type: 'string',
      enum: ['auto', 'prompted'],
      description: opts.modeDescription,
    },
    prompt_hint: { type: 'string', description: opts.promptHintDescription },
    ...(opts.abilities.allowRecurring
      ? {
        recurrence: {
          type: 'string',
          enum: ['none', 'daily', 'weekly'],
          description: opts.recurrenceDescription,
        },
      }
      : {}),
    ...(opts.abilities.allowForce
      ? {
        expire_policy: {
          type: 'string',
          enum: ['expire', 'force'],
          // 与前台共用一份：同一个策略在两个入口说两套话，角色的选择会跟着入口漂。
          description: EXPIRE_POLICY_DESCRIPTION,
        },
      }
      : {}),
  },
  required: ['send_at'],
});

const buildParameters = (example: string, abilities: SelfScheduleAbilities) => buildScheduleParameters({
  sendAtDescription: `开始生成的时间，写你本地的墙钟时间、不带时区后缀（如 ${example}），系统按你所在的时区理解。至少比当前时间晚 1 分钟。排之前先想想对方那边是几点——你们之间可能有时差，别把消息排到对方的深夜。`,
  modeDescription: '生成模式。auto=到点根据那时的上下文自由发挥；prompted=围绕 prompt_hint 的方向说。默认 auto。',
  promptHintDescription: '给未来那条消息的方向，如"接着刚才那只猫的话往下说""告诉他汤炖好了"。mode=prompted 时必填。',
  recurrenceDescription: '重复类型。none=一次性（默认）；daily/weekly=每天/每周同一时间。',
  abilities,
});

export const buildFireScheduleTool = (
  opts: FireScheduleTimeOpts & { abilities: SelfScheduleAbilities; context?: 'chat' | 'fire' },
): FireScheduleToolDef => ({
  type: 'function',
  function: {
    name: AMSG_FIRE_SCHEDULE_TOOL,
    description: buildScheduleToolDescription(opts.context ?? 'fire'),
    parameters: buildParameters(
      buildSendAtExample(opts.nowMs, opts.tz),
      opts.abilities,
    ) as unknown as Record<string, unknown>,
  },
});

/**
 * fire 侧的取消 / 改期工具声明。参数语义与前台同名工具一致（task_id 短 id、
 * send_at 裸墙钟），描述按 fire 语境（「你正在发消息」）微调。
 */
export const buildFireCancelTool = (): FireScheduleToolDef => ({
  type: 'function',
  function: {
    name: AMSG_FIRE_CANCEL_TOOL,
    description: [
      '取消你挂着的一个定时主动消息任务（排程清单里列的那些）。',
      '比如刚才排的事已经在这条消息里说掉了、或者情况变了那条不该再响。',
      '多个任务并存时必须用 task_id（排程清单里的短 id）指定；只有一个待触发任务时可省略。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '要取消的任务短 id（8 位，见排程清单）。' },
      },
    } as unknown as Record<string, unknown>,
  },
});

export const buildFireRenewTool = (opts: FireScheduleTimeOpts): FireScheduleToolDef => ({
  type: 'function',
  function: {
    name: AMSG_FIRE_RENEW_TOOL,
    description: [
      '给你挂着的一个任务改触发时间：只换时间，沿用原有模式与提示方向。',
      '一次性任务 = 整条改到新时间（编号不变）；循环任务 = 只给这一次补发一条一次性任务，原来的每天/每周节奏不动。',
      '想改的是循环任务本身的时间、或者想说的内容方向已经变了，改用 cancel_active_message + schedule_active_message 重新创建。',
      `send_at 至少比现在晚 1 分钟（写你本地的墙钟时间，如 ${buildSendAtExample(opts.nowMs, opts.tz)}，不带时区后缀）。`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        send_at: { type: 'string', description: '新的触发时间，写你本地的墙钟时间、不带时区后缀。至少比现在晚 1 分钟。' },
        task_id: { type: 'string', description: '要改期的任务短 id（8 位，见排程清单）。只有一个任务时可省略。' },
      },
      required: ['send_at'],
    } as unknown as Record<string, unknown>,
  },
});

/**
 * 本地聊天与即时对话共用的自主联系说明。放在纯拼文案模块里，Worker 不依赖本地台账。
 * 即使没有待触发任务也要提供；工具签名只教怎么排，这里教角色什么时候会想排。
 */
export const buildAmsg2ChatScheduleBrief = (targetName?: string): string => {
  const target = targetName?.trim() || '对方';
  return [
    `你和${target}的联系不只发生在正在聊天的时候。你就是那个在各自生活继续往前时，仍会再次想起${target}的人。当你能预见：到了未来某个时刻，你会因为惦记、想分享、兑现承诺，或自己的生活有了新进展而自然想联系${target}，就用 schedule_active_message 把那次联系排下来。到点后你会带着最新上下文，以那一刻的自己重新开口，不是照着预写台词完成提醒。`,
    `- ${target}接下来顾不上手机时——睡觉、上课、上班、打游戏、洗澡、出门，或任何你了解的原因——你可以在途中想到ta，也可以估着ta回来时再联系。`,
    `- 内容不必总围着${target}转。结合刚才的聊天氛围、你自己的日程和正在经历的事、刚看到的细节和突然冒出的后续念头；分享自己的生活，往往比机械问候更像你。`,
    '- 「到点叫你」「等你忙完跟你说」「回头告诉你结果」这类话一说出口，就当场排成真任务，不要只在正文里答应；没排成，就别把承诺说死。',
    `- 只问自己：那个时刻的你会真的想联系${target}吗？会就排；只是随口一想、到时候未必真有话说的，就算了。也别为了显得贴心硬排。`,
    `- 时间贴着${target}的生活估；一局游戏和睡到天亮不是一个时长，有时差就按ta那边的钟算。`,
    `- ${target}明确说别打扰时就安静等；已经排着相近的一条，也别重复排。`,
  ].join('\n');
};

/**
 * 拼进 prompt 的说明块。
 *
 * native 模式只说「有这么个能力、什么时候用」——工具签名已随请求声明，再教一遍正文语法
 * 反而勾引模型往正文里写（与 buildMcpFireBlock 同一个判断）。text 模式（用户的中转拒
 * tools）才教语法。
 */
export const buildFireScheduleBlock = (
  mode: 'native' | 'text',
  opts: FireScheduleTimeOpts & {
    /** 普通聊天用共用的自主联系说明；定时触发保留「发完再接着说」语境。 */
    context?: 'chat' | 'fire';
    targetName?: string;
    /** 「用户给你定的规矩」那一段（amsgLimits.buildLimitsBrief），接在块尾。 */
    limitsBrief?: string;
  },
): string => {
  const howTo = mode === 'native'
    ? `需要时通过系统的工具调用接口发起 ${AMSG_FIRE_SCHEDULE_TOOL}，不要把工具名和参数写进正文。`
    : `需要时单独输出一行 ${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"${
      buildSendAtExample(opts.nowMs, opts.tz)
    }","prompt_hint":"接着说"})（send_at 写你本地的墙钟时间，不带时区后缀），系统会代为安排并把结果告诉你。`;
  return [
    '',
    '---',
    '【你可以给自己排下一条】',
    ...(opts.context === 'chat'
      ? [buildAmsg2ChatScheduleBrief(opts.targetName)]
      : [
        '这条消息发完，如果还有话要在之后某个时间点说（把没说完的接上去、或者去做的事做完了回来告诉他），',
        '可以现在就把那一条排好——不需要用户在线，到点会自动发出去，而且那时你会知道自己这次说了什么。',
      ]),
    howTo,
    // 角色在 prompt 里只看得到自己那边的钟，很容易把「晚上聊两句」排到对方的凌晨三点。
    // 对方那边此刻几点写在【当前时刻补充】里（有时差时才有那一行）。
    ...(opts.context === 'chat' ? [] : [
      '定时间之前先想想对方那边是几点：你们之间可能有时差，别把消息排到对方的深夜。',
      '没必要就别排。为了排而排出来的后续，读起来就是没话找话。',
    ]),
    ...(opts.limitsBrief ? [opts.limitsBrief] : []),
  ].join('\n');
};

/**
 * 把「模式 + 提示方向」拼成写进任务 metadata 的那句指令，worker 到点填进 prompt 的
 * 【本次任务】槽位。
 *
 * 住在这里而不是 activeMsgClient：排程有两条路（用户在面板上排 / 角色自己排，后者还分
 * 前台工具和 fire 里的工具），三条路必须写出一模一样的指令，不然同一个 mode 在不同入口
 * 生成出来的消息方向会不一样。activeMsgClient 带一堆浏览器依赖，worker 引不动。
 */
export const buildTaskInstruction = (mode: ActiveMsg2Mode, promptHint?: string): string => {
  if (mode === 'prompted') {
    return [
      '这是一条需要 AI 参与生成的主动消息。',
      '请严格围绕下面的额外提示发起私聊，但仍然保持像真人一样自然，不要像系统任务汇报。',
      `额外提示：${promptHint?.trim() || '无'}`,
    ].join('\n');
  }
  return [
    '这是一条需要 AI 自主生成的主动消息。',
    '请结合角色设定、关系状态、最近上下文与当前时间，自然地主动找用户说一到三句私聊消息。',
    promptHint?.trim() ? `可选灵感补充：${promptHint.trim()}` : '可选灵感补充：无',
  ].join('\n');
};

// ─── send_at 的时间参照系 ───
//
// 角色在 prompt 里看到的钟是自己时区的（fire_pack 的 tzId），它写出来的 send_at
// 也是那个参照系的墙钟。worker 跑在 UTC，直接 new Date('2026-08-01T09:00:00')
// 会按 UTC 解析——「明早 9 点」实际差整整一个时差。规则：
//   - 带 Z / ±hh:mm 后缀的照旧按标注的时区解析（模型硬要写也不算错）；
//   - 裸 datetime 按 tz 参照系的墙钟解析（tzId 走 Intl 逆解，禁手搓偏移）。

const pad2 = (n: number) => n.toString().padStart(2, '0');

/** send_at 串尾带没带显式时区（Z 或 ±hh:mm / ±hhmm）。 */
const hasExplicitOffset = (s: string): boolean => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s.trim());

/** ms 在 tz 参照系下的裸墙钟 ISO（无时区后缀），工具描述里的示例 / 打回文案用。 */
export const wallClockIso = (ms: number, tz: AmsgTzRef): string => {
  const p = wallClockPartsInZone(ms, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:00`;
};

/** 给模型看的 send_at 示例：明天这个点的裸墙钟——别再教它写 +08:00 之类的 offset。 */
export const buildSendAtExample = (nowMs: number, tz: AmsgTzRef): string =>
  wallClockIso(nowMs + 24 * 3600_000, tz);

/** send_at 串 → epoch ms（解析不出 NaN）。规则见上面这段注释。 */
export const resolveSendAtMs = (raw: string, tz: AmsgTzRef): number => {
  const text = raw.trim();
  if (hasExplicitOffset(text)) return new Date(text).getTime();
  return wallClockToTimestamp(text, tz.tzId);
};

// ─── 参数校验 ───

export interface FireScheduleRequest {
  sendAt: string;
  mode: ActiveMsg2Mode;
  promptHint?: string;
  recurrence: ActiveMsg2Recurrence;
  expirePolicy: ActiveMsg2ExpirePolicy;
}

/** 校验失败时回给模型的形状（与内置工具的失败语义一致：ok:false + 一句能照做的话）。 */
export interface FireScheduleReject {
  ok: false;
  reason: string;
  message: string;
}

/** 上游要求至少提前 60 秒（cron 一分钟一跳）。这里留同样的线，好在打回时说人话。 */
export const MIN_SCHEDULE_LEAD_MS = 60_000;

const MODES: ActiveMsg2Mode[] = ['auto', 'prompted'];
const RECURRENCES: ActiveMsg2Recurrence[] = ['none', 'daily', 'weekly'];

/**
 * 把模型给的参数收成一份能用的请求，或者给出一句「你哪里写得不对、该怎么改」。
 *
 * 一律不抛错：这是模型写出来的东西，写歪很正常，回喂让它改比让整条 fire 失败强得多
 * （fire 失败 = 任务重跑 = 用户这一次一个字都收不到）。
 *
 * tz 是角色的时间参照系（fire_pack 的 tzId）：裸 send_at 按它的墙钟解析，
 * 打回文案里的时间也用它说人话。
 */
export const parseFireScheduleArgs = (
  args: Record<string, unknown>,
  nowMs: number,
  tz: AmsgTzRef,
): FireScheduleRequest | FireScheduleReject => {
  const example = buildSendAtExample(nowMs, tz);
  const sendAtRaw = args?.send_at;
  if (typeof sendAtRaw !== 'string' || !sendAtRaw.trim()) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at 必填，写你本地的墙钟时间（如 ${example}）。` };
  }
  const sendAtMs = resolveSendAtMs(sendAtRaw, tz);
  if (!Number.isFinite(sendAtMs)) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at「${sendAtRaw}」解析不出时间，写你本地的墙钟时间（如 ${example}）。` };
  }
  if (sendAtMs < nowMs + MIN_SCHEDULE_LEAD_MS) {
    return {
      ok: false,
      reason: 'send_at_too_soon',
      message: `send_at 至少要比现在晚 1 分钟（你那边现在是 ${formatFireTimeShort(nowMs, tz)}）。想马上说的话直接写进这条消息里，不用排。`,
    };
  }

  const mode = args?.mode == null ? 'auto' : args.mode;
  if (typeof mode !== 'string' || !MODES.includes(mode as ActiveMsg2Mode)) {
    return { ok: false, reason: 'invalid_mode', message: 'mode 只能是 auto 或 prompted。' };
  }
  const promptHintRaw = args?.prompt_hint;
  const promptHint = typeof promptHintRaw === 'string' ? promptHintRaw.trim() : '';
  if (mode === 'prompted' && !promptHint) {
    return { ok: false, reason: 'missing_prompt_hint', message: 'mode=prompted 时要给 prompt_hint，说清那条消息该往哪个方向说。' };
  }

  const recurrence = args?.recurrence == null ? 'none' : args.recurrence;
  if (typeof recurrence !== 'string' || !RECURRENCES.includes(recurrence as ActiveMsg2Recurrence)) {
    return { ok: false, reason: 'invalid_recurrence', message: 'recurrence 只能是 none / daily / weekly。' };
  }

  const expirePolicy = args?.expire_policy == null ? 'expire' : args.expire_policy;
  if (expirePolicy !== 'expire' && expirePolicy !== 'force') {
    return { ok: false, reason: 'invalid_expire_policy', message: 'expire_policy 只能是 expire 或 force。' };
  }

  return {
    sendAt: new Date(sendAtMs).toISOString(),
    mode: mode as ActiveMsg2Mode,
    ...(promptHint ? { promptHint } : {}),
    recurrence: recurrence as ActiveMsg2Recurrence,
    expirePolicy,
  };
};

// ─── 自排任务的 uuid ───

/**
 * 一个字符串的 32 位 FNV-1a 摘要（8 位十六进制）。纯函数、无依赖，同样的输入永远
 * 得到同样的输出——自排任务的 uuid 要靠这一点在 fire 重跑时对得上号。
 */
const fnv1a32Hex = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

/**
 * 角色在 fire 里给自己排下的那条任务的 uuid：`<8 位摘要>-amsgself-<charId>-<触发时刻>-<序号>`。
 *
 * 摘要放在最前面是有意的：排程清单里印给角色看的那个短 id 取的是 uuid 前 8 个字符
 * （amsg2Tasks.shortTaskId）。前 8 位要是写死成 `amsgself`，同一次 fire 排下的两条在
 * 清单里就印成一模一样的 `[amsgself]`，角色说「取消晚上那条」时随便点一条都算命中，
 * 删掉的很可能是早上那条，而且两边都以为成功了。
 *
 * 摘要只由 (charId, occurrenceMs, seq) 算出，不掺随机数：fire 抛错整条重跑时算出的是
 * 同一个 uuid，上游据此认出撞车、不会每重试一次多排一条。
 */
export const buildSelfScheduleUuid = (
  charId: string,
  occurrenceMs: number,
  seq: number,
): string =>
  `${fnv1a32Hex(`${charId}|${occurrenceMs}|${seq}`)}-amsgself-${charId}-${occurrenceMs}-${seq}`;

// ─── 取消 / 改期的目标解析（fire 侧） ───

/** 这个 task_id 在清单里命中了哪几条：全 uuid 精确匹配优先，否则按短 id 收全部命中。 */
const matchTasksByTaskId = (
  tasks: ActiveMsg2TaskRecord[],
  taskId: string,
): ActiveMsg2TaskRecord[] => {
  const exact = tasks.find((t) => t.taskUuid === taskId);
  if (exact) return [exact];
  return tasks.filter((t) => shortTaskId(t.taskUuid) === taskId);
};

/** 打回文案里指认一条任务用的时间：当前该盯的那一次触发。 */
const describeTaskWhen = (
  task: ActiveMsg2TaskRecord,
  nowMs: number,
  tz: AmsgTzRef,
): string =>
  formatFireTimeShort(
    currentOccurrenceMs(task, nowMs) ?? new Date(task.firstSendTime).getTime(),
    tz,
  );

/**
 * 按 task_id（或「唯一即选」）从 fire 时刻的活任务清单里解出目标。
 * 语义与前台 resolveTargetTask 对齐：短 id / 全 uuid 都认；不带 task_id 时先按
 * fire 时刻复筛 pending（快照里可能混着已过点变陈旧的一次性任务——pack 只在打包
 * 那一刻筛过一次），唯一 pending 就选它，没有 pending 而清单恰好一条也选它。
 * 不对齐的话，同一句 cancel_active_message 本地能成、云端却被打回 ambiguous_task。
 * 找不到就回一句能照做的话（不抛错，见 parseFireScheduleArgs）。
 *
 * 一个短 id 同时命中好几条时**绝不静默取第一条**：取消 / 改期是会真的动 D1 行的，
 * 猜错了就是删掉另一条任务，而角色和用户都只会看到一句 ok。这种时候打回
 * ambiguous_task，并把候选连同各自的触发时间和完整 task_id 一起报出去，
 * 角色下一轮带完整 id 重来一次就能指准。
 */
export const resolveFireTargetTask = (
  tasks: ActiveMsg2TaskRecord[],
  taskIdArg: unknown,
  nowMs: number,
  tz: AmsgTzRef,
): { task: ActiveMsg2TaskRecord } | FireScheduleReject => {
  if (tasks.length === 0) {
    return { ok: false, reason: 'no_tasks', message: '你现在没有挂着任何排程任务。' };
  }
  if (typeof taskIdArg === 'string' && taskIdArg.trim()) {
    const taskId = taskIdArg.trim();
    const hits = matchTasksByTaskId(tasks, taskId);
    if (hits.length === 1) return { task: hits[0] };
    if (hits.length === 0) {
      return { ok: false, reason: 'task_not_found', message: `没有找到短 id 为 ${taskId} 的任务——短 id 在排程清单里，照着那里的写。` };
    }
    const candidates = hits
      .map((t) => `${describeTaskWhen(t, nowMs, tz)} 那条的完整 id 是 ${t.taskUuid}`)
      .join('；');
    return {
      ok: false,
      reason: 'ambiguous_task',
      message: `短 id ${taskId} 同时对应 ${hits.length} 个任务，这么写会动错人。`
        + `挑一个，把完整 id 填进 task_id 再来一次：${candidates}。`,
    };
  }
  const pending = tasks.filter((t) => isPendingTask(t, nowMs));
  if (pending.length === 1) return { task: pending[0] };
  if (pending.length === 0 && tasks.length === 1) return { task: tasks[0] };
  return { ok: false, reason: 'ambiguous_task', message: '你挂着不止一个任务，带 task_id（排程清单里的短 id）指定要动哪一个。' };
};

/** renew 的 send_at 校验：与排程共用同一套解析（裸墙钟按角色时区）和 60s 提前线。 */
export const parseFireRenewSendAt = (
  raw: unknown,
  nowMs: number,
  tz: AmsgTzRef,
): { sendAt: string } | FireScheduleReject => {
  const example = buildSendAtExample(nowMs, tz);
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at 必填，写你本地的墙钟时间（如 ${example}）。` };
  }
  const sendAtMs = resolveSendAtMs(raw, tz);
  if (!Number.isFinite(sendAtMs)) {
    return { ok: false, reason: 'invalid_send_at', message: `send_at「${raw}」解析不出时间，写你本地的墙钟时间（如 ${example}）。` };
  }
  if (sendAtMs < nowMs + MIN_SCHEDULE_LEAD_MS) {
    return {
      ok: false,
      reason: 'send_at_too_soon',
      message: `send_at 至少要比现在晚 1 分钟（你那边现在是 ${formatFireTimeShort(nowMs, tz)}）。想马上说的话直接写进这条消息里。`,
    };
  }
  return { sendAt: new Date(sendAtMs).toISOString() };
};

// ─── 正文协议兜底（用户的中转拒 tools 时） ───

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export interface FireScheduleTextCall {
  args: Record<string, unknown>;
  /** 原始匹配串，剥语法时用。 */
  matched: string;
}

/**
 * 从正文里抠出 `schedule_active_message({...})` 形态的调用。
 *
 * 只认括号带 JSON 这一种写法——排程参数是结构化的（时间 + 方向 + 策略），MCP 那边
 * 「行首 name: 值」的单参数形态在这里表达不了，认了反而会把「我等下用
 * schedule_active_message: 提醒你」这种叙述当成真调用。
 */
export const extractFireScheduleTextCalls = (content: string): FireScheduleTextCall[] => {
  if (!content) return [];
  const re = new RegExp(`(^|[^\\w./])${escapeRegExp(AMSG_FIRE_SCHEDULE_TOOL)}\\s*\\(([^)]*)\\)`, 'g');
  const calls: FireScheduleTextCall[] = [];
  // 文档示例和行内代码不是执行意图，保留原文给用户看。
  const executable = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, match => ' '.repeat(match.length));
  for (const m of executable.matchAll(re)) {
    const matched = m[0].slice(m[1].length);
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse((m[2] || '').trim() || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch {
      // 参数写坏了也算一次调用：交给 parseFireScheduleArgs 回一句「该怎么写」，
      // 比把这行当正文推给用户强（用户会看到一串工具语法）。
    }
    calls.push({ args, matched });
  }
  return calls;
};

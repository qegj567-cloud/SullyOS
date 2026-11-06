// 即时对话的接线守卫（源码级断言）。
//
// 仓库的 vitest 是纯 Node 环境（没装 jsdom），useChatAI 是个绑死 React 的大 hook、
// Chat.tsx 和设置面板是组件，都跑不起来测行为，所以沿用 amsg2ChatLoop.wiring.test.ts
// 的做法：读源码钉接线。它验证不了运行时时序，只防「接线被误删 / 改回去」这一种回归。
//
// 这里钉的每一条，塌了都不会报错，只会表现成「功能怎么不响」：
//   · 分流条件漏了工具循环的排除 → 瑞一杯/麦当劳选完城市没反应（请求交给 worker 了）；
//   · 失败时悄悄回本地跑 → 用户以为云端在跑，其实每条都在本地生成，查无可查；
//   · 收尾还打脏 → 同一份 fire_pack 再传一遍，白走一趟网络；
//   · 「正在输入…」不看落盘记录 → 关一次页面灯就没了，用户以为消息丢了；
//   · 路由不在构建 prompt 之前定下来 → 上云那份也烤前端时效段，一份 prompt 两个钟。
//
// 取源码片段统一走 sliceSrc（下面那个 helper）：按需调用、两个锚点都要命中，
// 找不到就抛一条写明是哪一段、缺哪个锚点的错，只挂真正用到它的那几条用例。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const chatAiSrc = read('../hooks/useChatAI.ts');
const chatSrc = read('../apps/Chat.tsx');
const settingsSrc = read('../components/settings/ActiveMsgGlobalSettingsModal.tsx');

/** 即时对话分支的判定行（分支起点、也是排序基准）。 */
const INSTANT_CHAT_BRANCH_HEAD = 'if (instantChatRoute)';
/** 路由判定那一段的起点（否决名单从这行开始拼）。 */
const ROUTING_HEAD = 'const luckinChatOn =';

/**
 * 取一段源码：从起点锚点到终点锚点之间。两个锚点都要求命中，找不到就抛一条写明
 * 「哪一段、哪个锚点」的错——按需调用，只有真正用到这一段的用例会挂，其余照跑。
 * （别在模块顶层取：那样锚点一改名整份文件在收集阶段就集体阵亡，报出来的还是
 * `expected -1 to be greater than -1`，看不出是哪条不变量塌了。）
 */
const sliceSrc = (src: string, label: string, startAnchor: string, endAnchor: string): string => {
  const start = src.indexOf(startAnchor);
  if (start < 0) {
    throw new Error(`[${label}] 找不到起点锚点 ${JSON.stringify(startAnchor)}。先确认这条不变量本身还在（只是改了名就更新锚点，被删了就是真回归）。`);
  }
  const end = src.indexOf(endAnchor, start);
  if (end <= start) {
    throw new Error(`[${label}] 起点之后找不到终点锚点 ${JSON.stringify(endAnchor)}，这一段的边界变了。`);
  }
  return src.slice(start, end);
};

/** 路由判定那一段源码（在 buildChatRequestPayload 之前算好，上云与否 + 要不要剥时效段 + 没上云的留痕）。 */
const routingSrc = () => sliceSrc(chatAiSrc, '即时对话路由段', ROUTING_HEAD, 'const payload = await replyStep(');

/** 即时对话分支那一段源码（从判定行到它自己的 return）。 */
const branchSrc = () => sliceSrc(chatAiSrc, '即时对话分支', INSTANT_CHAT_BRANCH_HEAD, '// 流式预览：');

/** Chat 里自动合成语音那个 effect 的源码（含它的依赖数组）。 */
const autoTtsSrc = () => sliceSrc(chatSrc, '语音自动合成', '// --- Auto-TTS: when chatVoiceEnabled', 'const canReroll =');

describe('useChatAI 的分流接缝', () => {
  it('MCP 本身不在排除名单里（worker 会跑后台 MCP；整片排掉 = 配了 MCP 的人永远静默走本地）', () => {
    // e2e 实测踩过：只要全局有一台 enabled 的 MCP 服务器，mcpChatActive 对所有角色为真，
    // 拿它当排除条件的话，即时对话开关亮着却永远走本地生成，用户查无可查。
    // 判定挪到构建 payload 之前之后，这条要连路由那一段一起看。
    // （地址 worker 够不着的那几台是另一回事，见下面那条。）
    expect(routingSrc()).not.toContain('mcpChatActive');
    expect(branchSrc()).not.toContain('mcpChatActive');
  });

  it('本机/内网地址的 MCP 服务器否决这一轮上云（上云会让角色掉工具）', () => {
    // 上云那一轮前端不注入 MCP 说明块（chatRequestPayload 的 timelyByWorker 分支），
    // 而上云清单 collectMcpFireServers 恰好把 localhost / 私网地址过滤掉了——两边都不说，
    // 角色这一轮彻底不知道自己有工具，设置页却还显示 MCP 已连接、聊天界面毫无异常。
    // 判据是「这一轮上云会掉能力就别上云」，所以它得是个 veto、且带 char.id（服务器可绑角色）。
    const routing = routingSrc();
    expect(routing).toContain('hasWorkerUnreachableMcpServer(char.id)');
    expect(routing).toContain("'mcp-worker-unreachable'");
    // 否决也要留痕：走的是下面那条统一的 instant-chat-veto trace（reason 带着它）。
    expect(routing).toContain('const skipReason = instantChatVeto;');
    expect(routing).toContain('reason: skipReason');
  });

  it('全局配置读不出来单独留一条 trace（它不是「用户没开」）', () => {
    // 读失败时 instantChatOn 天然为假，veto 那条 trace 的条件够不到它。不单独留痕的话，
    // 这一轮悄悄退回本地直连生成，用户按完发送锁屏就什么都收不到，观察窗里还查无此事。
    const routing = routingSrc();
    expect(routing).toContain('resolveInstantChatReadiness');
    expect(routing).toContain("reason === 'config-unreadable'");
    expect(routing).toContain("event: 'instant-chat-config-unreadable'");
    // 跟 veto 一样只报不拦（那条 return 的守卫在下面「留痕只此一处」那条里）。
  });

  it('角色级即时对话开关吃进路由判定（char-disabled 静默走本地，不留 veto trace）', () => {
    const routing = routingSrc();
    // readiness 判定必须带上 char：角色单独关了的话 ready 直接为 false，veto trace 的
    // 条件（instantChatOn && …）够不到它。不带 char 的话角色关了照上云——旧行为回潮。
    expect(routing).toMatch(/resolveInstantChatReadiness\(char[,)]/);
    // 也不许给 char-disabled 单开留痕分支：那是用户的主动选择，和「全局没开」同一待遇，
    // 每条消息刷一遍 warn 就成骚扰了。查的是带引号的字面量——真要按它分支绕不开这个比较；
    // 注释里提一嘴不算。
    expect(routing).not.toContain("'char-disabled'");
  });

  it('上云的判定在构建 prompt 之前就定下来，并作为 timelyByWorker 交给 payload', () => {
    // 这一条钉的是「一份 prompt 只剩一个钟」：走云端时前端不烤时钟/节日/天气/热搜/
    // MCP 说明，那几段由 worker 在 fire 时刻独家补。判定要是又挪回分支里现算，
    // payload 就只能按全量构建，模型会同时读到前端快照和 worker 现拉的两份。
    expect(routingSrc()).toContain('const instantChatRoute =');
    expect(chatAiSrc).toMatch(/timelyByWorker:\s*instantChatRoute/);
    const routeAt = chatAiSrc.indexOf('const instantChatRoute =');
    const payloadAt = chatAiSrc.indexOf('const payload = await replyStep(');
    expect(routeAt).toBeGreaterThan(-1);
    expect(payloadAt).toBeGreaterThan(routeAt);
    // 上云只看两样：即时对话就绪、没被否决。
    expect(routingSrc()).toContain('const instantChatRoute = instantChatOn && !instantChatVeto;');
  });

  it('云端生成只剩即时对话这一条路（聊天链路里不再有别的云端发送分支）', () => {
    // 发送、情绪评估、安全网都只认 instantChatRoute；再冒出一条云端分支的话，这几处
    // 要各自重新分叉，漏一处就是「按一条路打包、实际走了另一条」。
    for (const src of [chatAiSrc, chatSrc]) {
      for (const gone of ['instantPushClient', 'isInstantConfigReady', 'sendInstantPushAndAwaitReply', 'onInstantPosted']) {
        expect(src).not.toContain(gone);
      }
    }
    expect(chatAiSrc).not.toContain('cloudGenRoute');
  });

  it('回执块与 worker 时效块都排在易变尾段之前，不压过「回到你自己」', () => {
    const branch = branchSrc();
    expect(branch).toContain('timelyInsertAt: payload.volatileTailIndex');
    expect(branch).toContain("insertAmsg2TaskContextBlock(fullMessages, { role: 'system', content: amsg2NoticesBlock }, payload.volatileTailIndex)");
    expect(branch).not.toContain("[...fullMessages, { role: 'system', content: amsg2NoticesBlock }]");
    // 下标一路带进 fire_pack 的 chat 段
    expect(read('./amsgInstantChat.ts')).toContain('timelyInsertAt: params.timelyInsertAt');
    expect(read('./activeMsgClient.ts')).toContain('{ timelyInsertAt: params.timelyInsertAt }');
  });

  it('分支只认 instantChatRoute，不拿原料重算一遍', () => {
    // 「这份 prompt 剥没剥时效段」和「这一轮走不走云端」必须出自同一个值。分支要是
    // 自己再拿 instantChatOn / 否决名单拼一次条件，两处早晚会不同意——剥过时效段的
    // prompt 就落到本地那条路上去了。
    const branch = branchSrc();
    for (const reDerived of ['instantChatOn', 'instantChatVeto']) {
      expect(branch).not.toContain(reDerived);
    }
    // 上云那一路一进来就直奔发送，中间没有别的门。
    expect(branch.indexOf('sendInstantChatTurn')).toBeGreaterThan(-1);
    expect(branch).toContain('return;');
  });

  it('开着即时对话却没上云 —— 每一种情形都在路由段留 trace，就这一处', () => {
    // 原因都在否决名单里：SAR 模块遇上旧 Worker、点单流程（瑞幸/麦当劳要客户端交互）、
    // MCP 地址够不着，这一轮留在本地是对的。哪一种没留痕，都是「开关亮着、消息照常出来」的
    // 静默分流，用户查无可查。
    const routing = routingSrc();
    // 点单那三个来源和 payload.flags 同源，只是算得更早；SAR 那一条看的是模块计划 +
    // 那台 Worker 的 bundle 结论（见下面那条专门的用例）。
    for (const source of [
      'luckinChatRef?.current?.active', 'mcdMiniOpen', 'luckinMiniOpen',
      'sarModulePlan.requiresEnvelope', 'instantChatReadiness.workerBundleCurrent === false',
    ]) {
      expect(routing).toContain(source);
    }
    expect(routing).toContain('const instantChatVeto');
    expect(routing).toContain("event: 'instant-chat-veto'");
    // 判定用的是「上云没成」这个总口径，不是逐个原因去数——漏一种就又静默了。
    expect(routing).toMatch(/if \(instantChatOn && !instantChatRoute\)/);
    // 留痕只此一处：多写一处迟早会漏掉某种情形，或者同一轮报两遍。
    const traceSites = chatAiSrc.match(/event: 'instant-chat-veto'/g) ?? [];
    expect(traceSites.length).toBe(1);
    // 只报不拦：报完照常往下走本地路径，不能顺手 return 掉整轮。
    // （config-unreadable 的裸情形是唯一例外——那档要拦，单独一条用例钉在下面。）
    const vetoBranch = sliceSrc(
      chatAiSrc,
      '否决留痕分支',
      'if (instantChatOn && !instantChatRoute)',
      "} else if (instantChatReadiness.reason === 'config-unreadable')",
    );
    expect(vetoBranch).not.toContain('return;');
  });

  it('配置读不出来（config-unreadable）：裸情形明确报错拦下这一轮，veto 在场只留痕', () => {
    // 静默退回本地的坑：用户按「发完就自由」的心智锁屏，本地 fetch 被系统掐死，回来
    // 既无回复也无报错，设置页还写着「已开启」。裸情形（没有否决）
    // 必须与 sendInstantChatTurn 失败同口径：落系统消息 + 弹错 + return，不发起本地
    // 生成。回归守卫——改回「静默走本地」这条会挂。
    const branch = sliceSrc(
      chatAiSrc,
      'config-unreadable 分支',
      "} else if (instantChatReadiness.reason === 'config-unreadable')",
      'const payload = await replyStep(',
    );
    expect(branch).toContain("event: 'instant-chat-config-unreadable'");
    // 裸情形的判定与两档去向：veto 在场时本就轮不到即时对话，照原路只留痕不拦。
    expect(branch).toMatch(/configUnreadableFailsTurn = !instantChatVeto;/);
    expect(branch).toMatch(/outcome: configUnreadableFailsTurn \? 'turn-failed' : 'other-route'/);
    // 拦下的那一档：落系统消息、弹错、return——绝不静默退回本地生成。
    expect(branch).toMatch(/if \(configUnreadableFailsTurn\) \{[\s\S]*?return;/);
    expect(branch).not.toContain('safeFetchJson');
  });

  it('云端拿到的就是本地要发的那串消息和那份凭据（回执块只另插一块，不动原消息）', () => {
    // 基底永远是 fullMessages；有作废回执时单独成块插进去（云端到点自己渲染排程
    // 清单和能力简介，chat 段只补回执这一样，别和 timely block 撞车）。
    expect(branchSrc()).toMatch(/insertAmsg2TaskContextBlock\(fullMessages, \{ role: 'system', content: amsg2NoticesBlock \}/);
    expect(branchSrc()).toMatch(/:\s*fullMessages\)/);
    expect(branchSrc()).toMatch(/buildAmsg2NoticesText\(/);
    expect(branchSrc()).toMatch(/baseUrl:\s*effectiveApi\.baseUrl/);
    // model / temperature 取 baseReqBody 的终值：本地那套 thinking 后缀（claude 系
    // -thinking）和「开思考删温度」跑完是什么，云端就发什么——同一句话两条路才是
    // 同一个模型、同一个温度。回退成 effectiveApi 原始值就是行为分叉的开始。
    expect(branchSrc()).toMatch(/model:\s*baseReqBody\.model/);
    expect(branchSrc()).toMatch(/temperature:\s*baseReqBody\.temperature/);
  });

  it('作废回执在 202 之后只记账不销账（受理 ≠ 角色读到过）', () => {
    // 202 只说明云端收下了。那一轮照样可能空输出被判 skip-push、或 fire 重试打光标 failed，
    // 回执不会重新注入——用户只收到「[即时对话没能完成…]」并重发，而重发那一轮已经没有
    // 回执可注入，角色永远不知道那条任务被作废过，聊天里许下的承诺就这么消失。
    // 正确时机是回复真的落库之后（跟本地路径同一口径），所以这里只落台账。
    const branch = branchSrc();
    expect(branch).not.toContain('markExpiredNoticesNotified');
    expect(branch).toMatch(/instantChatResult\.ok[\s\S]{0,800}stageInstantChatExpiredNotices/);
  });

  // ★ SAR 模块回合上云的回归守卫。
  //
  // 从前角色或用户身上只要有模块（生效或恢复期），这一轮就被整个否决、静默退回本地生成——
  // 用户开着即时对话却查无可查。现在只有需要信封的回合才看 Worker 版本：确认是当前 bundle
  // 才上云，存量为空就当场探一次；探到旧版 → outdated，探不到 → unverified。恢复期回合照常上云。
  it('SAR 模块回合上云：不再整片否决，需要信封时要求确认 Worker 是当前 bundle', () => {
    const routing = routingSrc();
    // 裸的 'sar-module' 否决回潮 = 模块回合又一律静默走本地。
    expect(routing).not.toContain("'sar-module'");
    expect(routing).not.toMatch(/sarModulePlan\.hasActiveEffect \|\| sarModulePlan\.hasAfterglow \?/);
    // 需要信封才现探（恢复期回合不探、不多花一次往返）。
    expect(routing).toMatch(/ensureBundleVersion:\s*sarModulePlan\.requiresEnvelope/);
    // 两档否决：探到旧版 / 没探到。放行只认 workerBundleCurrent === true。
    expect(routing).toMatch(/!sarModulePlan\.requiresEnvelope \? null/);
    expect(routing).toContain("instantChatReadiness.workerBundleCurrent === false ? 'sar-module-worker-outdated'");
    expect(routing).toContain("instantChatReadiness.workerBundleCurrent === undefined ? 'sar-module-worker-unverified'");
    // 只在 ready 时判：否则 config-unreadable 那档会被这条否决错判成「本来就不走即时对话」、
    // 悄悄退回本地，而那一档要的是明确报错。
    expect(routing).toMatch(/const sarWorkerVeto: string \| null = !instantChatOn \|\|/);
    // 否决要用到 readiness 的结论，所以 readiness 得先算出来。
    expect(routing.indexOf('resolveInstantChatReadiness(char'))
      .toBeLessThan(routing.indexOf('const sarWorkerVeto'));
    // 两档都走那条统一的 instant-chat-veto trace（上面「留痕只此一处」那条钉着），warn 各说各的。
    expect(routing).toContain("skipReason === 'sar-module-worker-outdated'");
    expect(routing).toContain("skipReason === 'sar-module-worker-unverified'");
  });

  it('SAR 快照随 sendInstantChatTurn 上云，目标取自喂 prompt 的同一份 contextMsgs', () => {
    const branch = branchSrc();
    expect(branch).toContain('buildAmsgSarModuleSnapshot({');
    expect(branch).toContain('sarModule: amsgSarSnapshot');
    // USER_SURFACE 目标必须和 buildChatRequestPayload 的 historyMsgs 是同一个变量，
    // 不然快照里的 id 和模型看到的列表对不上，外显会贴错消息。
    expect(chatAiSrc).toMatch(/historyMsgs:\s*contextMsgs,\s*\n\s*recentMsgsHint:/);
    expect(branch).toMatch(/historyMsgs:\s*contextMsgs/);
    // 重掷：效果照用、不推进回合，和本地路径那句 if (!skipEmotionInjection) 同一个值。
    expect(branch).toMatch(/reroll:\s*skipEmotionInjection/);
    // 本轮用户消息的选法两条路共用一个函数，落点不会分家。
    expect(chatAiSrc).toContain('const latestUserMessage = findSARTurnUserMessage(currentMsgs);');
  });

  it('失败时不悄悄回本地生成：分支里没有本地 LLM 请求，走完就 return', () => {
    expect(branchSrc()).not.toContain('safeFetchJson');
    expect(branchSrc()).not.toContain('chat/completions');
    expect(branchSrc()).toContain('return;');
  });

  it('失败时留下能看见的痕迹（系统消息 + 弹错），不是静默吞掉', () => {
    expect(branchSrc()).toContain("role: 'system'");
    expect(branchSrc()).toMatch(/showError\(/);
  });

  it('受理成功那一轮不再打脏重传 fire_pack', () => {
    expect(branchSrc()).toContain('instantChatAccepted = true');
    expect(chatAiSrc).toMatch(/if \(!instantChatAccepted\) \{[\s\S]{0,200}markAmsgStateDirty\(/);
  });

  // 情绪评估跟着这一轮一起上云：用户发完就能关页面，评估在 worker 里跑完，结果随
  // 最后一条推送回来。留在本地发一枪的话，页面一关情绪底色和意识流就悄悄停更了。
  it('情绪评估跟着一起交给云端，不在本地再发一枪', () => {
    expect(branchSrc()).toContain('emotionEval: cloudEmotionEval');
    expect(branchSrc()).not.toContain('fireLocalEmotionEval');
    // 本地那一枪和上云那份认的是同一个 instantChatRoute，
    // 不然两边会同时跑评估（双扣费，而且后落的那份会盖掉先落的）。
    expect(chatAiSrc).toMatch(/const fireLocalEmotionEval = \(emotionEvalEnabled && !instantChatRoute/);
    expect(chatAiSrc).toMatch(/const cloudEmotionEval = \(emotionEvalEnabled && instantChatRoute/);
  });

  it('不在这条路上开活跃会话租约（生成不在本机跑，没人需要它举手）', () => {
    // 租约那句排在分支的 return 之后，走这条路根本到不了。
    const leaseAt = chatAiSrc.indexOf('startAmsgChatPresence(char.id');
    expect(leaseAt).toBeGreaterThan(chatAiSrc.indexOf(INSTANT_CHAT_BRANCH_HEAD));
    expect(branchSrc()).not.toContain('startAmsgChatPresence');
  });
});

describe('Chat 界面的「正在输入…」', () => {
  it('灯的依据是落盘的待收记录，而不是本轮的内存状态', () => {
    expect(chatSrc).toContain('getInstantChatPending');
    expect(chatSrc).toContain('AMSG_INSTANT_CHAT_PENDING_EVENT');
    // 只订阅事件、不读一次现状的话，重开应用时灯是灭的（记录还在，回复还没到）。
    expect(chatSrc).toMatch(/const sync = \(\) => setInstantChatPending\(/);
  });

  it('三个点的显示条件带上它（isTyping 在 POST 完就灭了）', () => {
    expect(chatSrc).toMatch(/\(isTyping \|\| instantChatPending \|\|/);
  });
});

describe('Chat 界面的语音自动合成', () => {
  it('云端回来的回复也算数（只认 isTyping 的话，开了自动播放的角色一路静音）', () => {
    // isTyping 在 POST 完就灭了，即时对话的回复是之后靠推送落库的，永远等不到那一下。
    // 灯灭（instantChatPending 由真变假）开窗 + messages 进依赖补扫，缺一条都没声音。
    expect(autoTtsSrc()).toMatch(/wasPending && !instantChatPending/);
    expect(autoTtsSrc()).toMatch(/\}, \[isTyping, instantChatPending, messages\]\)/);
  });

  it('不在窗里就还是只在打字结束那一下扫（不然每来一条消息都重扫一遍历史）', () => {
    expect(autoTtsSrc()).toMatch(/if \(!typingJustEnded && !inInstantWindow\) return;/);
  });

  it('换角色把扫描窗作废（Chat 里切角色不卸载组件，ref 会跨角色留着）', () => {
    // 甲还欠着回复时切到乙，指示灯会跟着乙的记录灭——那不是「乙的回复到了」，
    // 拿它开窗就会把乙的历史消息整批合成一遍。
    expect(autoTtsSrc()).toContain('instantVoiceScanCharRef');
  });
});

describe('设置页那一道门', () => {
  it('版本门槛只有这一处：探 /config-check 的 instantChat 标志', () => {
    expect(settingsSrc).toContain('probeInstantChatSupport');
    // 逐调用预检会让每发一条消息多一次网络往返，而且探失败时分不清是旧版还是网抖。
    expect(chatAiSrc).not.toContain('probeInstantChatSupport');
  });

  it('三道门缺一不可：三个输入都要喂进同一份判定', () => {
    // 顺序和每道门的文案钉在 amsgDiagnostics.test.ts（resolveInstantChatBlocker 是纯函数，
    // 能直接测）。这里只钉「设置页确实把三个输入都递过去了」——漏一个的话那道门就消失了，
    // 界面上表现为开关能点，点完发一条挂一条。
    const gate = sliceSrc(settingsSrc, '即时对话开关的置灰理由', 'const instantChatBlocker = resolveInstantChatBlocker(', '\n  const instantChatBlockedReason');
    expect(gate).toContain('isConnected');
    expect(gate).toContain('pushStatus?.hasSubscription');
    expect(gate).toContain('instantChatSupported');
    // 黄字直接取自代号表：文案跟上报属性共用一份判定，不许哪天各写各的。
    expect(settingsSrc).toContain('INSTANT_CHAT_BLOCKER_HINTS[instantChatBlocker]');
  });

  it('开不了卡在哪要上报，且跟界面共用那份判定', () => {
    // 开关灰着的时候用户什么都点不动，也就不会产生别的事件——不主动收的话，被挡在门外的人
    // 和「不想要这功能的人」在数据里长得一模一样。
    const report = sliceSrc(settingsSrc, '即时对话可用性上报', 'const reportInstantChatGate', '\n  const refresh');
    expect(report).toContain('resolveInstantChatBlocker(gate)');
    expect(report).toContain(`trackEvent('即时对话能不能开'`);
    // 反复点「连接」的人否则一个人能刷出十几条同样的结果，把分布带歪。
    expect(report).toContain('instantChatGateReported');
  });

  it('开关落盘：两个 saveGlobalConfig 调用点都要带上它', () => {
    // 漏一处的话，用户改完 Worker 地址（或点一次「连接」）开关就被冲回默认值。
    const saves = settingsSrc.match(/ActiveMsgStore\.saveGlobalConfig\(\{[\s\S]{0,220}?\}\)/g) ?? [];
    expect(saves.length).toBeGreaterThanOrEqual(3);
    for (const save of saves) {
      expect(save).toContain('instantChatEnabled');
    }
  });
});

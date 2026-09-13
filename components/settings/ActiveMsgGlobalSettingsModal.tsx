import React, { useEffect, useRef, useState } from 'react';
import Modal from '../os/Modal';
import ConfirmDialog from '../os/ConfirmDialog';
import { ActiveMsg2GlobalConfig, RealtimeConfig } from '../../types';
import {
  ActiveMsgClient, ActiveMsg2PushStatus, fetchWorkerDiagnostics, readAmsgFailKind,
  type AmsgCronTriggerState,
} from '../../utils/activeMsgClient';
import {
  AmsgDiagnosticLevel, AmsgDiagnosticsProbe,
  buildAmsgDiagnosticRows, summarizeAmsgDiagnostics,
  INSTANT_CHAT_BLOCKER_HINTS, resolveInstantChatBlocker,
  type InstantChatGateInput,
} from '../../utils/amsgDiagnostics';
import { ActiveMsgStore, maskActiveMsgUserId } from '../../utils/activeMsgStore';
import { cancelAllRemoteAmsgTasks, isWorkerUrlCleared, wipeAmsgCloudData } from '../../utils/amsgStateSync';
import {
  buildCloudflareDashboardUrl,
  isInstantConfigReady,
  loadInstantConfig,
  saveInstantConfig,
} from '../../utils/instantPushClient';
import { generateClientToken } from '../../utils/vapidGen';
import { loadPushVapid, savePushVapid } from '../../utils/pushVapid';
import {
  attachUpdateCapability,
  provisionAmsgBackend,
  waitForWorkerReady,
  type CfAccount,
  type ProvisionProgress,
} from '../../utils/cfProvision';
import { isAmsgServerVersionAtLeast } from '../../utils/amsgWorkerVersion';
import { trackEvent } from '../../utils/analytics';

// 满血链路吃满这些 worker 特性（amsg-server 2.6.0-next.4+）。探测不到端点（老部署
// 404 → null）或缺任何一项，就亮「重新部署」提示——worker 跑在用户自己的账号里，
// 站点这边发新版不会自动同步过去。
const REQUIRED_WORKER_FEATURES = [
  'client-state',
  'client-state-chunking',
  'agentic-hooks',
  'agentic-scratch',
  // 后台 fire 每轮把 tools 参数带给 LLM（角色在主动消息里用得上用户自配的 MCP 工具）。
  'agentic-fire-tools',
  // hook 载荷自带 readState / writeState，配置级 hook 不用再自己攒一份写口。
  'hook-state-accessors',
  // onAfterSend 拿到本次 fire 的 scratch：自述回写按真正送出去的段数落账。
  'after-send-scratch',
  // 任务身份直接挂在 ctx 和 push 顶层，两条排程路径不用各抄一份 metadata。
  'fire-task-identity',
  'push-task-identity',
  // 库导出信封余量常量，push 体积按「库补完字段之后」的尺寸算。
  'push-envelope-reserved-bytes',
  // 角色自排撞车时回已存在那行的投影，重跑那轮也记得下账。
  'schedule-task-duplicate-row',
  // 循环任务的过期快进也回调，攒下的那几次跳过在面板上看得见。
  'recurring-stale-skip-hook',
  // 任务行带时区，daily / weekly 按角色所在时区的墙钟推进。
  'task-timezone',
  // 推送订阅按用户存一份，排程不再携带；换订阅后已排的任务自动跟上。
  'user-push-subscription',
  // 凭据存成表里的一行、任务只带引用（credRefs）。换 Key 只要覆盖那一行，已排的任务
  // ——包括角色在触发时给自己排的那些——下次触发就用新凭据。缺了它就退回「凭据冻结
  // 进每条任务」的老路：换 Key 要逐条补刷，漏一条到点就是 401。
  'llm-credentials',
];
// features 之外还必须比版本：这波依赖的能力大多没发独立 flag，光查 features 分不出新旧。
//   next.5 — GET /messages 投影（charId/clientTaskId）、onBeforeFire 的 { skip } 出口
//   next.6 — 任务占位租约（带工具的 AI 任务常跑过一分钟，没有占位会被相邻 cron tick 重复推）
//   next.7 — hook 的 writeState（大内容旁路存 client_state）、Web Push payload 大小护栏
//   next.8 — fire 循环透传 tools 请求参数（后台调用户自配 MCP 的前置）
//   next.9 — 这一档还兼做「bundle 里有没有自述回写」的判据：角色发完把正文记回
//            client_state、下次到点接着说（fire_pack 的 self_log 槽位），是随本波
//            bundle 一起上去的。旧 bundle 收到带槽位的 fire_pack 只会把
//            `{{AMSG_SELF_LOG}}` 原样发给 LLM，而 SERVER_VERSION 是打包时那份
//            amsg-server 的版本号，正好能把这类旧粘贴认出来。
//   next.11 — 推送订阅改成按用户存一份：这一档起排程不再携带订阅，前端走
//            /push-subscription 端点登记，旧 worker 上这个端点不存在。
//   next.12 — 「角色说过什么」的落盘改挂在 onFireSettled 上（不论这次是发出去了、
//            跳过了还是抛错了都调一次）。旧 worker 认不得这个 hook，会把它当成
//            无关配置直接忽略——而 bundle 这边已经不再用 onAfterSend，表现就是
//            self_log 永远不写：角色到点不知道自己上次说过什么，天天重复同一句。
//            同一档还带 run-tick 的同角色任务串行（serializeBy）。
//   next.15 — 这一档能力密集，而且 bundle 里的 wrapper 已经按新上游行为改写：
//            即时对话 immediate 落库即到期 + supersedesUuid 原子顶替；llmExtraBody
//            （思考链三件套上云）；租约心跳续租（wrapper 不再配 claimLeaseMs，旧
//            上游没有心跳 → 退回 10 分钟死租约，isolate 死后任务干等）；fire ctx
//            的 cancelTask / renewTask（角色取消 / 改期自己的排程）；client_state
//            条件写（旧包不盖新包）；任务行 last_error（失败原因可查）。
//   next.16 — 即时对话改由 Durable Object 起跳，靠的就是这一档的 runTask（按 uuid
//            跑单条）；错误响应带 error.cause（真因不再只进 worker 日志）；
//            getSchemaVersion（表结构对不对得上，由上游按自己的建表语句比对）。
//   next.17 — 用户级 LLM 凭据表（PUT/GET/DELETE /llm-credentials）、任务的 credRefs、
//            fire hook 的 resolveLlmCredential。这一档有独立 flag（上面那条
//            'llm-credentials'），版本号列在这里只是备个案。
//   next.20 — 推送被推送服务判死（410 / 404）时当终态，不再空转重试——投递是先生成
//            后推送，每重试一跳就白跑一整轮 LLM；同时把状态码结构化写进 last_error
//            的 pushStatus，体检的「这台设备」靠它拆穿「登记全绿但一条都不来」。
//            另外 client_state 的前缀清理改走字典序范围：D1 把 LIKE pattern 压到
//            50 字节（官方文档没写），key 一长就整条语句报 pattern too complex，
//            同批的状态写入跟着一起回滚。
//   next.21 — 带 body 的端点认 `Content-Encoding: gzip`：即时对话那条路上的正文
//            （整轮聊天）在客户端压过再发，旧 worker 不认这个头，会把压缩字节当
//            明文读，报出来是一句「请求体不是合法的 JSON」——大消息一条都发不出去。
//            同一档还有失败记录里的 errorCode（`LLM_CALL_FAILED` 之类）和上游拒绝
//            请求时的原话：卡片上那句「生成失败」从此说得出到底是模型名写错了、
//            余额不够，还是订阅失效该去重新登记。
//   next.23 — 跟着 amsg-shared 0.4.0-next.8 一起升：shared 的通知字段校验放行了
//            `silent: 'when-visible'`（静音改由 Service Worker 按窗口可见性算）。
//            server 侧没有行为变化，单升这一档不解决任何问题；这批真正要用户去点
//            一次「更新 Worker」的是通知策略本身，见 utils/amsgBundleVersion.ts。
//   next.26 — client_state 的条件写不再被「来自未来」的时间戳锁死。设备时钟只要
//            领先过真实时间，那一刻同步上去的行就带着一个还没到的时刻，之后这台
//            设备发什么都被判成「旧的」，云端那行要等真实时间追上来才解得开；用户
//            侧的表现是某个角色的即时对话一直发不出去，删消息、重装、重填地址全都
//            不管用。这一档两件事：库里那种行不再有拦人的资格（存量能被覆盖回来），
//            以及新写入的护栏值钳到服务端当前时刻（不再产生新的脏行）。旧部署上前端
//            的水位（utils/amsgStateClock.ts）能兜住发不出去这一半，但云端那行会一直
//            停在未来，只有升上来才会第一次写入就回到现实。
//   next.27 — 两件事。一、cron 每跳顺手跑的几条清理 DELETE 有了索引：client_state 和
//            message_outbox 上原先没有对应的索引，每分钟整表扫一遍，扫过的行全算进
//            D1 的 rows read，两张表合计一千七百行就把免费额度（每天 500 万行）用完，
//            之后整个 worker 报「exceeded daily row read limit」、所有查询都拒。索引在
//            用户点「重新连接并验证」（POST /init-tenant）时补上，「更新 Worker」会自动
//            接一次。二、PUT /client-state 认 value: null 删行：客户端取回旁路存的大
//            内容后把那行真的删掉，不再留空壳（即时对话每轮的键都是新的，空壳只涨不
//            跌，worker 每次生成都要把整个角色命名空间读一遍）。前端接入见
//            utils/activeMsgClient.ts 的 clearClientStateValue 与存量空壳清理。
// 不比版本的话，旧粘贴部署会被误判为最新，问题全在 worker 侧静默发生。
const REQUIRED_WORKER_VERSION = '2.6.0-next.27';

/** 装着打包好的 worker 代码的部署仓库：fork 它 → 在 Cloudflare 连上 → 以后点 Sync fork 更新。 */
const WORKERS_REPO_URL = 'https://github.com/Tosd0/sullyos-workers';
const SETUP_WALKTHROUGH_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/docs/amsg2-setup-walkthrough.md';
/** 一键部署要的那枚 API Token 在这里建。 */
const CF_TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens';

// 探测结果每次会话只报一次。refresh() 在开面板、连接成功、订阅成功后都会跑一遍，
// 一个连不上、反复点「连接」的人否则能一个人刷出十几条同样的结果，把分布带歪。
let workerCapsReported = false;
// 「即时对话开不了卡在哪」同样每次会话只报一次，理由同上。
let instantChatGateReported = false;

/** 体检每一行的配色与那一列小字。unknown 用灰：查不出结论时别拿颜色暗示好坏。 */
const DIAGNOSTIC_STYLES: Record<AmsgDiagnosticLevel, { dot: string; text: string; word: string }> = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-600', word: '正常' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-600', word: '注意' },
  bad: { dot: 'bg-rose-500', text: 'text-rose-600', word: '有问题' },
  unknown: { dot: 'bg-slate-300', text: 'text-slate-400', word: '查不到' },
};

/** 刚生成的密钥明文：输入框是 password 型，只能在这一处让用户看见并手动复制。 */
const SecretReveal: React.FC<{ value: string; className?: string }> = ({ value, className = '' }) => (
  <p className={`font-mono text-[10px] leading-relaxed text-slate-500 break-all bg-white border border-slate-200 rounded-xl px-2 py-1.5 ${className}`}>
    {value}
  </p>
);

interface ActiveMsgGlobalSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** 「清空云端数据」清完要立刻把工具凭据补传回去，所以这里需要当前这份配置。 */
  realtimeConfig: RealtimeConfig;
  /** 由 Settings 注入：点「去推送凭据面板」时打开顶层 PushVapidSettingsModal */
  onOpenVapid?: () => void;
}

const ActiveMsgGlobalSettingsModal: React.FC<ActiveMsgGlobalSettingsModalProps> = ({
  isOpen,
  onClose,
  addToast,
  realtimeConfig,
  onOpenVapid,
}) => {
  const [config, setConfig] = useState<ActiveMsg2GlobalConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  // 手动粘贴部署：给没有 GitHub 账号的人留的退路，默认收着不干扰主流程。
  const [pasteFallbackOpen, setPasteFallbackOpen] = useState(false);
  // Deno 门面：workers.dev 在国内连不上时才需要，默认收着。
  const [denoProxyOpen, setDenoProxyOpen] = useState(false);
  const [pushStatus, setPushStatus] = useState<ActiveMsg2PushStatus | null>(null);
  // 「生成 Master Key」只在本次打开期间展示，前端不落盘——它是 worker 侧密钥，粘进 CF env 即可。
  const [generatedMasterKey, setGeneratedMasterKey] = useState('');
  const [generatedServerToken, setGeneratedServerToken] = useState('');

  // 一键部署：填一枚 CF Token，剩下的（建库、传 worker、写密钥、加定时）都自动做完。
  // Token 只在这次部署期间留在内存里，成功与否都不落盘——它是能改整个账号 Workers 的
  // 权限，真正需要长期留着的那一份已经作为 secret 写进用户自己的 worker 了（自更新用）。
  const [cfToken, setCfToken] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [provisionStep, setProvisionStep] = useState('');
  /** token 能用在多个账号上时让用户挑一个。 */
  const [provisionAccounts, setProvisionAccounts] = useState<CfAccount[] | null>(null);
  /** 全新的 CF 账号还没有 workers.dev 子域，得先起一个。 */
  const [needsSubdomain, setNeedsSubdomain] = useState(false);
  const [desiredSubdomain, setDesiredSubdomain] = useState('');
  const [provisionError, setProvisionError] = useState('');

  // 补装更新能力：老办法装的后端里没有 CF_API_TOKEN，点更新会被顶回来。
  // 粘一枚 token 就能就地补上，不用去 Cloudflare 面板。只在真的缺钥匙时才露出来。
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachToken, setAttachToken] = useState('');
  const [attachScriptName, setAttachScriptName] = useState('');
  const [attachNeedsScriptName, setAttachNeedsScriptName] = useState(false);
  const [attachAccounts, setAttachAccounts] = useState<CfAccount[] | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState('');

  // 体检：worker 的 GET /debug 结果。它早就把「缺哪个变量、缺哪张表、缺哪几列、cron
  // 有没有停」都算好了，但入口一直只有手拼 URL——而这几样恰恰是「界面上一切正常、
  // 就是一条都不发」的全部原因。存原始探测结果，红绿灯在渲染时算（推送状态一变就跟着走）。
  const [diagnosticsProbe, setDiagnosticsProbe] = useState<AmsgDiagnosticsProbe | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  // 体检摆在最上面，但默认收着：装好之后它天天是「都正常」，摊开占掉半屏。
  // 标题那一行已经把结论说了，要看是哪一项才需要点开。
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const [workerOutdated, setWorkerOutdated] = useState(false);
  /**
   * 用户那台 Worker 上的后端代码是不是最新的（见 ActiveMsgClient.probeWorkerVersion）。
   * null = 还没探到（没填地址 / 正在探）。界面拿它决定更新按钮是高亮催更新还是弱化。
   */
  const [workerVersion, setWorkerVersion] = useState<
    { state: 'current' | 'outdated' | 'unknown'; deployed: string | null; expected: string } | null
  >(null);
  /** 自更新成功后 worker 报回来的代码指纹，显示出来好让人确认这次真换了。 */
  const [selfUpdateHash, setSelfUpdateHash] = useState('');
  /**
   * 后台任务的定时触发（Worker 的 cron trigger）现在开着没有，见 ActiveMsgClient.getCronTriggerState。
   * null = 这台 Worker 没有这个端点（旧版）或没读到，按钮整个不显示。
   * token-missing = 端点在、但 Worker 没配 CF_API_TOKEN，点按钮先引导补钥匙。
   */
  const [cronState, setCronState] = useState<
    { kind: 'known'; enabled: boolean } | { kind: 'token-missing'; message: string } | null
  >(null);
  /** 「暂停后台任务」的确认框开着没有。恢复不用确认。 */
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  // Instant Push 也开着：聊天会走它，2.0 挂在本地那条路上的几样东西全静默失效——设置页
  // 两道双向门通常已经拦住这种组合，这里读一次是给漏网脏配置兜底，关掉后立刻更新。
  const [instantOn, setInstantOn] = useState(false);
  // 这台 worker 认不认 /instant-chat。即时对话的**唯一**版本门槛就在这儿，
  // 别处不做逐调用预检——每发一条消息多探一次网络，探失败还分不清是旧版还是网抖。
  const [instantChatSupported, setInstantChatSupported] = useState(false);

  // 特性探测：确认「过老」（端点 404 → null，或缺关键特性）才亮牌；
  // 探测本身失败（断网 / 密钥不对 / 没填地址）不亮，避免误报。
  const probeWorkerCaps = async (workerConfigured: boolean) => {
    // 只有配了地址才报：没填地址时这次探测必然失败，那不是版本问题。
    const shouldReport = workerConfigured && !workerCapsReported;
    if (shouldReport) workerCapsReported = true;
    try {
      const caps = await ActiveMsgClient.getCapabilities();
      const missingFeature = !caps || REQUIRED_WORKER_FEATURES.some((f) => !caps.features.includes(f));
      const versionTooOld = !caps || !isAmsgServerVersionAtLeast(caps.serverVersion, REQUIRED_WORKER_VERSION);
      setWorkerOutdated(missingFeature || versionTooOld);
      // 跑着旧 worker 的表现是**静默错**（自述回写不落盘、任务重复推），用户不会来报，
      // 面板这一句提示是唯一的出口。这里数的就是「有多少人正跑着一个不该跑的版本」。
      if (shouldReport) {
        trackEvent('探测 2.0 Worker 能力', {
          result: !caps ? '端点不存在' : missingFeature ? '缺特性' : versionTooOld ? '版本过旧' : 'ok',
        });
      }
    } catch {
      setWorkerOutdated(false);
      // 探测本身炸了（断网 / 地址不通）不亮牌，免得误报；但它跟「版本旧」是两回事，
      // 单独占一格，看分布时能一眼把这批人排除掉。
      if (shouldReport) trackEvent('探测 2.0 Worker 能力', { result: '探测失败' });
    }
  };

  // 已经存过盘的那个 Worker 地址。清空确认要用它：确认之前不能换地址，
  // 取消远端任务的那几个请求还得发到旧那台上去。
  const savedWorkerUrlRef = useRef('');

  /**
   * 拉一次体检。没填地址时不拉——那时候唯一该做的事是把地址填上，
   * 摆一排红灯只会让人以为哪儿坏了。
   */
  const runDiagnostics = async () => {
    setDiagnosing(true);
    try {
      setDiagnosticsProbe(await fetchWorkerDiagnostics());
    } finally {
      setDiagnosing(false);
    }
  };

  /** 把 worker 报回来的定时触发状态翻成界面上的三态（见 cronState 的说明）。 */
  const applyCronTriggerState = (state: AmsgCronTriggerState | null) => {
    if (!state) {
      setCronState(null);
      return;
    }
    if (state.supported && typeof state.enabled === 'boolean') {
      setCronState({ kind: 'known', enabled: state.enabled });
      return;
    }
    if (state.code === 'CF_TOKEN_MISSING') {
      setCronState({ kind: 'token-missing', message: state.message || '' });
      return;
    }
    // 别的原因（认不出 Worker 名、CF 那边读不到）：按钮不显示，原因留在 console 里备查。
    if (state.message) console.warn('[amsg2] 读不到后台任务的定时触发状态：', state.message);
    setCronState(null);
  };

  /**
   * 报一次「即时对话此刻能不能开、开不了卡在哪」。
   *
   * 这一格只能在这儿收：开关灰着的时候用户什么都点不动，也就不会产生任何别的事件——
   * 光看配置快照里那个开/关，被挡在门外的人和「不想要这功能的人」长得一模一样。
   * 判定跟界面上那行黄字共用 resolveInstantChatBlocker，两处不会各说各话。
   */
  const reportInstantChatGate = (gate: InstantChatGateInput, enabled: boolean) => {
    if (instantChatGateReported) return;
    instantChatGateReported = true;
    trackEvent('即时对话能不能开', {
      result: resolveInstantChatBlocker(gate) ?? '可以开',
      // 已经开着的人也报：他们卡住意味着「开的时候好好的，后来 Worker 退回旧版了」，
      // 那是一种发一条挂一条、但设置页还写着「已开启」的坏法。
      state: enabled ? '已开着' : '还没开',
    });
  };

  const refresh = async () => {
    const nextConfig = await ActiveMsgClient.getGlobalConfig();
    const nextPushStatus = await ActiveMsgClient.getPushStatus();
    savedWorkerUrlRef.current = nextConfig.workerUrl || '';
    setConfig(nextConfig);
    setPushStatus(nextPushStatus);
    setInstantOn(isInstantConfigReady());
    void probeWorkerCaps(Boolean(nextConfig.workerUrl?.trim()));
    if (nextConfig.workerUrl?.trim()) {
      void ActiveMsgClient.probeWorkerVersion().then(setWorkerVersion);
      void ActiveMsgClient.probeInstantChatSupport().then((supported) => {
        setInstantChatSupported(supported);
        reportInstantChatGate({
          connected: Boolean(nextConfig.initializedAt),
          pushSubscribed: Boolean(nextPushStatus?.hasSubscription),
          workerSupportsInstantChat: supported,
          instantPushOn: isInstantConfigReady(),
        }, Boolean(nextConfig.instantChatEnabled));
      });
      void runDiagnostics();
      // 已连接才问定时触发开没开：没连上的时候这事还轮不到操心。
      if (nextConfig.initializedAt) void ActiveMsgClient.getCronTriggerState().then(applyCronTriggerState);
      else setCronState(null);
    } else {
      setInstantChatSupported(false);
      setDiagnosticsProbe(null);
      setWorkerVersion(null);
      setCronState(null);
    }
  };

  /** 关掉 Instant Push 的开关，worker 地址等配置留着——以后想切回去不用重填。 */
  const disableInstantPush = () => {
    saveInstantConfig({ ...loadInstantConfig(), enabled: false });
    setInstantOn(false);
    addToast('已关闭 Instant Push，聊天回到本地直连。', 'success');
  };

  useEffect(() => {
    if (!isOpen) return;
    setAdvancedOpen(false);
    setDiagnosticsOpen(false);
    setDeployOpen(false);
    setPasteFallbackOpen(false);
    // 两个明文密钥都要清：留到下次打开面板还挂在页面上，就是白白多摊一次。
    setGeneratedMasterKey('');
    setGeneratedServerToken('');
    // CF Token 更要清：它比上面两个都重，绝不留到下次打开。
    setCfToken('');
    setProvisionAccounts(null);
    setNeedsSubdomain(false);
    setDesiredSubdomain('');
    setProvisionError('');
    setAttachOpen(false);
    setAttachToken('');
    setAttachScriptName('');
    setAttachNeedsScriptName(false);
    setAttachAccounts(null);
    setAttachError('');
    setPauseConfirmOpen(false);
    void refresh();
  }, [isOpen]);

  /**
   * 地址被清空时的收尾：先问一句，再拿**旧地址**把远端任务取消干净，最后才存空值。
   *
   * 光存空值的话，前端这边所有同步立刻停摆，D1 里的任务却一条没少：cron 每分钟照常
   * 消费、照烧 LLM、照推送（推送订阅也还在），只是内容永远停在最后一次同步的样子。
   * 用户以为自己关掉了一切，实际只是把自己变成了看不见的那一方。
   */
  const confirmAndClearRemote = async (): Promise<boolean> => {
    const ok = confirm('清空 Worker 地址会把远端还挂着的主动消息任务一并取消，确定吗？\n\n不取消的话，那些任务仍会按时触发并给你推送，而这边已经管不到它们了。');
    if (!ok) return false;
    const { total, failed, listed } = await cancelAllRemoteAmsgTasks();
    if (!listed) {
      addToast('远端任务没能取消，可能还挂在那儿照常触发。建议把地址填回去，到角色的主动消息面板里逐个处理。', 'error');
    } else if (failed > 0) {
      addToast(`还有 ${failed} 个远端任务取消失败，建议恢复地址后在面板处理。`, 'error');
    } else if (total > 0) {
      addToast(`已取消远端 ${total} 个任务。`, 'info');
    }
    return true;
  };

  const persistGlobalConfig = async () => {
    if (!config) return;
    if (isWorkerUrlCleared(savedWorkerUrlRef.current, config.workerUrl)) {
      if (!await confirmAndClearRemote()) {
        // 用户反悔：把地址填回输入框，别留一个「界面空着、库里还存着」的错位。
        patchConfig({ workerUrl: savedWorkerUrlRef.current });
        return;
      }
    }
    await ActiveMsgStore.saveGlobalConfig({
      workerUrl: config.workerUrl,
      serverToken: config.serverToken,
      instantChatEnabled: config.instantChatEnabled,
      // 一键部署生成的 Master Key 也要跟着存：这是本地唯一的一份，Worker 那边读不回来。
      masterKey: config.masterKey,
    });
    savedWorkerUrlRef.current = config.workerUrl || '';
  };

  useEffect(() => {
    if (!isOpen || !config) return;
    const timer = setTimeout(() => { void persistGlobalConfig(); }, 1000);
    return () => clearTimeout(timer);
  }, [config?.workerUrl, config?.serverToken, isOpen]);

  const patchConfig = (updates: Partial<ActiveMsg2GlobalConfig>) => {
    setConfig((prev) => ({
      ...(prev || { userId: '', workerUrl: '' }),
      ...updates,
    }));
  };

  const handleCreateSubscription = async () => {
    setLoading(true);
    try {
      // 建完浏览器订阅还要登记到 worker 上那一份用户级订阅——worker 到点读的是它，
      // 只在浏览器建订阅的话云端仍是空的，到点会抛 PUSH_SUBSCRIPTION_MISSING，
      // 而这句 toast 已经报了「准备完成」。
      await ActiveMsgClient.registerPushSubscription();
      await refresh();
      addToast('通知权限和推送订阅已准备完成。', 'success');
      trackEvent('开启通知与推送订阅', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || '创建推送订阅失败。', 'error');
      // 只报抛错那一刻挂上的代号（源码里写死的枚举）。错误原文可能带 push endpoint，
      // 留在 toast 和 console 里，不进上报。
      trackEvent('开启通知与推送订阅', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  /**
   * 一键部署：只要一枚 Cloudflare API Token，把后端从零装好，装完顺手连上。
   *
   * 密钥全部在本地生成，用户不用复制粘贴任何东西。已经有的一律沿用——Master Key 换了
   * 之前排的任务全解不开，VAPID 换了浏览器现有的推送订阅会全部 403。
   *
   * Token 只在这次操作期间留在内存里，成功与否都不落盘。需要长期留着的那一份已经作为
   * secret 写进用户自己的 Worker 了（以后「更新后端」用的就是它）。
   */
  const handleOneClickDeploy = async (accountId?: string) => {
    const token = cfToken.trim();
    if (!token) {
      addToast('先把 Cloudflare API Token 填进来。', 'error');
      return;
    }

    setProvisioning(true);
    setProvisionError('');
    setProvisionStep('');
    try {
      const vapid = loadPushVapid();
      const result = await provisionAmsgBackend({
        token,
        accountId: accountId || undefined,
        desiredSubdomain: desiredSubdomain.trim() || undefined,
        secrets: {
          AMSG_MASTER_KEY: config?.masterKey || undefined,
          VAPID_PUBLIC_KEY: vapid.vapidPublicKey || undefined,
          VAPID_PRIVATE_KEY: vapid.vapidPrivateKey || undefined,
          VAPID_EMAIL: vapid.vapidEmail || undefined,
          AMSG_SERVER_TOKEN: config?.serverToken || undefined,
        },
        onProgress: (p: ProvisionProgress) => setProvisionStep(p.message),
      });

      if (!result.ok) {
        setProvisionStep('');
        // 这两种不是失败，是「还差一个信息」，界面上补个输入再点一次就能接着走。
        if (result.code === 'ACCOUNT_AMBIGUOUS') {
          setProvisionAccounts(result.accounts || []);
          trackEvent('一键部署 2.0 后端', { result: '要选账号' });
          return;
        }
        if (result.code === 'SUBDOMAIN_MISSING') {
          setNeedsSubdomain(true);
          setProvisionError(result.message);
          trackEvent('一键部署 2.0 后端', { result: '要起子域名' });
          return;
        }
        setProvisionError(result.message);
        trackEvent('一键部署 2.0 后端', { result: '失败' });
        return;
      }

      // 先把密钥落盘再连接：连接要用 serverToken，而 Master Key 一旦丢了就再也读不回来。
      const { secrets } = result;
      savePushVapid({
        vapidPublicKey: secrets.VAPID_PUBLIC_KEY,
        vapidPrivateKey: secrets.VAPID_PRIVATE_KEY,
        vapidEmail: secrets.VAPID_EMAIL || undefined,
      });
      // instantChatEnabled 跟着一起写：面板渲染时 config 一定不是 null（文件末尾有空值
      // 早退），读到的就是界面上当前的值，不显式带上会被这次保存冲掉。
      await ActiveMsgStore.saveGlobalConfig({
        workerUrl: result.workerUrl,
        serverToken: secrets.AMSG_SERVER_TOKEN,
        masterKey: secrets.AMSG_MASTER_KEY,
        instantChatEnabled: config?.instantChatEnabled,
      });
      patchConfig({
        workerUrl: result.workerUrl,
        serverToken: secrets.AMSG_SERVER_TOKEN,
        masterKey: secrets.AMSG_MASTER_KEY,
      });
      savedWorkerUrlRef.current = result.workerUrl;

      setProvisionAccounts(null);
      setNeedsSubdomain(false);
      setCfToken('');
      result.warnings.forEach((warning) => addToast(warning, 'info'));
      // 别在这儿说「装好了」就完事：地址还要几十秒才在各个边缘节点上生效，而上面那句
      // patchConfig 一落地，一键部署那张卡片就因为「地址已填」收起来了——进度条跟着消失，
      // 看上去像是全部办妥。用户于是去点「连接并启用」，撞上还没生效的地址。
      addToast(`后端装好了：${result.workerUrl}。地址还要几十秒才生效，等它自己连上就行。`, 'success');
      trackEvent('一键部署 2.0 后端', { result: '成功' });

      // 刚建好的 workers.dev 地址要等一会儿才解析得到，等它活过来再建表。
      setProvisionStep('等待 Worker 启动…');
      const ready = await waitForWorkerReady(result.workerUrl);
      if (!ready) {
        addToast('Worker 装好了，但地址还没生效。过一两分钟点一下「连接并启用」即可。', 'info');
        return;
      }
      setProvisionStep('正在建表…');
      const { warnings } = await ActiveMsgClient.connect();
      await refresh();
      warnings.forEach((warning) => addToast(warning.message, 'info'));
      addToast('已连接成功，主动消息 2.0 可以用了。', 'success');
    } catch (error: any) {
      // 报错原文只进界面，不进上报（可能带地址、账号 id）。
      setProvisionError(error?.message || '部署过程中出错了。');
      trackEvent('一键部署 2.0 后端', { result: '失败' });
    } finally {
      setProvisioning(false);
      setProvisionStep('');
    }
  };

  const handleConnect = async () => {
    if (!config?.workerUrl.trim()) {
      addToast('先把你部署的 Worker 地址填进来。', 'error');
      return;
    }

    setLoading(true);
    try {
      await ActiveMsgStore.saveGlobalConfig({
        workerUrl: config.workerUrl,
        serverToken: config.serverToken,
        instantChatEnabled: config.instantChatEnabled,
      });
      const { warnings } = await ActiveMsgClient.connect();
      await refresh();
      addToast('已连接成功，主动消息 2.0 可以用了。', 'success');
      // 连上了但有一块是哑的（最典型是 VAPID 没配齐：任务建得成、到点一条都推不出去，
      // 而界面上没有任何异常）。这类问题用户自己发现不了，连接这一刻不说就没人说了。
      warnings.forEach((warning) => addToast(warning.message, 'info'));
      // 只报「这次连接成没成 / 卡在哪一类」。连接串 / tenantToken / 错误原文一概不带，
      // 也不报「之前配没配过 tenant」——那等于把两项凭据的配置状态压成一位发出去。
      // 失败代号是抛错时按 HTTP 状态挂上的字面量（见 activeMsgClient 的 AmsgFailKind），
      // 分开是因为「密钥对不上」和「D1 没绑」要用户去改的地方完全不同。
      trackEvent('连接并启用主动消息 2.0', { result: 'ok' });
    } catch (error: any) {
      addToast(error?.message || '连接失败。', 'error');
      trackEvent('连接并启用主动消息 2.0', { result: readAmsgFailKind(error) });
    } finally {
      setLoading(false);
    }
  };

  /**
   * 让后端自己更新到最新版本。
   *
   * 三种装法（fork 后连 Git / Deploy 按钮 / 找人代配）此前更新方式各不相同，最麻烦的一种
   * 要在两个网站之间倒腾一个几百 KB 的文件。有了这个按钮都变成点一下。
   *
   * 更新成功后接着跑一次「连接并验证」（POST /init-tenant，幂等）。
   *
   * 这一步不是可有可无的收尾：新版后端可能带了新的表结构，而 D1 的建表只在这个端点里做。
   * 少了它，Worker 代码是新的、库还是旧的，cron 每分钟静默失败，主动消息整个停摆——
   * 而界面上一切正常，用户完全看不出来（这个坑踩过）。让「更新」自己把它带上，
   * 就不必指望每个人都记得再手动点一次。
   *
   * 失败不改判这次更新：代码确实已经换上了，只是库没跟上。分开报，用户才知道该点哪个。
   */
  const handleSelfUpdateWorker = async () => {
    setLoading(true);
    try {
      const result = await ActiveMsgClient.selfUpdateWorker();
      if (result.ok) {
        setSelfUpdateHash(result.bundleHash || '');
        setAttachOpen(false);
        addToast(result.message, 'success');
        try {
          await ActiveMsgClient.connect();
          await refresh();
        } catch (error: any) {
          addToast(
            `后端已更新，但紧接着的验证没过：${error?.message || '未知原因'}。手动点一下「重新连接并验证」。`,
            'error',
          );
        }
      } else {
        addToast(result.message, result.supported ? 'error' : 'info');
        // 「缺 CF_API_TOKEN」是这里唯一能就地解决的一种：露出补装那一块，
        // 用户粘一枚 token 就好，不用去 Cloudflare 面板加变量。
        if (result.code === 'CF_TOKEN_MISSING') setAttachOpen(true);
      }
      trackEvent('更新后端 Worker', {
        result: result.ok ? 'ok' : result.supported ? 'failed' : 'unsupported',
      });
    } catch (error: any) {
      addToast(error?.message || '更新失败。', 'error');
      trackEvent('更新后端 Worker', { result: 'failed' });
    } finally {
      setLoading(false);
    }
  };

  /**
   * 暂停 / 恢复后台任务：让 Worker 摘掉或加回自己的 cron trigger（见 worker/amsg/src/cronTrigger.ts）。
   *
   * 暂停期间到点的任务在 D1 里排着，不会丢；恢复后的第一跳一起补发。
   * 走 GitHub 的 Sync fork 重新部署会按 wrangler.toml 把 cron 加回来，所以这不是永久开关。
   */
  const applyCronTrigger = async (enabled: boolean) => {
    setPauseConfirmOpen(false);
    setLoading(true);
    const action = enabled ? 'resume' : 'pause';
    try {
      const result = await ActiveMsgClient.setCronTriggerEnabled(enabled);
      if (result.ok) {
        setCronState({ kind: 'known', enabled });
        addToast(result.message, 'success');
      } else {
        addToast(result.message, 'error');
        // 缺 CF_API_TOKEN 是这里唯一能就地解决的一种，跟自更新一样露出补钥匙那一块。
        if (result.code === 'CF_TOKEN_MISSING') setAttachOpen(true);
      }
      trackEvent('暂停后台任务', { action, result: result.ok ? 'ok' : 'failed' });
    } catch (error: any) {
      addToast(error?.message || (enabled ? '恢复失败。' : '暂停失败。'), 'error');
      trackEvent('暂停后台任务', { action, result: 'failed' });
    } finally {
      setLoading(false);
    }
  };

  /** 暂停要先确认（点错一下角色就全哑了），恢复直接做。 */
  const handleCronTriggerClick = () => {
    if (!cronState) return;
    if (cronState.kind === 'token-missing') {
      // 钥匙还没装，先把补装那一块露出来；装好之后再点就能真的暂停了。
      addToast(cronState.message || '这台 Worker 还没配 CF_API_TOKEN，先在下面补一把钥匙。', 'info');
      setAttachOpen(true);
      return;
    }
    if (cronState.enabled) setPauseConfirmOpen(true);
    else void applyCronTrigger(true);
  };

  /**
   * 给已经装好的后端补上「自己更新自己」的钥匙。
   *
   * 只写 CF_API_TOKEN / CF_SCRIPT_NAME 两条密钥，不碰脚本也不碰别的绑定——手动部署的
   * 用户，前端手里根本没有他们的 Master Key，走重传那条路会把密钥抹掉。
   */
  const handleAttachUpdateKey = async (accountId?: string) => {
    const token = attachToken.trim();
    if (!token) {
      addToast('先把 Cloudflare API Token 填进来。', 'error');
      return;
    }
    if (!config?.workerUrl.trim()) {
      addToast('先把 Worker 地址填好。', 'error');
      return;
    }

    setAttaching(true);
    setAttachError('');
    try {
      const result = await attachUpdateCapability({
        token,
        workerUrl: config.workerUrl,
        scriptName: attachScriptName.trim() || undefined,
        accountId,
      });

      if (!result.ok) {
        if (result.code === 'SCRIPT_NAME_UNKNOWN') {
          setAttachNeedsScriptName(true);
          setAttachError(result.message);
          trackEvent('补装后端更新能力', { result: '要填Worker名' });
          return;
        }
        if (result.code === 'ACCOUNT_AMBIGUOUS') {
          setAttachAccounts(result.accounts || []);
          trackEvent('补装后端更新能力', { result: '要选账号' });
          return;
        }
        setAttachError(result.message);
        trackEvent('补装后端更新能力', { result: '失败' });
        return;
      }

      setAttachToken('');
      setAttachAccounts(null);
      setAttachNeedsScriptName(false);
      addToast('钥匙装好了，现在可以点上面的「更新 Worker」了。', 'success');
      trackEvent('补装后端更新能力', { result: '成功' });
      // 钥匙一到位，暂停后台任务那个按钮也能用了，重新问一次它的状态。
      void ActiveMsgClient.getCronTriggerState().then(applyCronTriggerState);
    } catch (error: any) {
      setAttachError(error?.message || '装钥匙时出错了。');
      trackEvent('补装后端更新能力', { result: '失败' });
    } finally {
      setAttaching(false);
    }
  };

  // 手动粘贴部署用。主流程是 fork sullyos-workers + 在 CF 连 Git，这条是给没有 GitHub
  // 账号的人留的退路，所以在面板里收在折叠区里。
  const handleCopyWorkerBundle = async () => {
    try {
      await ActiveMsgClient.copyWorkerBundleToClipboard();
      addToast('Worker 代码已复制，去 CF 后台的 Edit code 里粘贴覆盖。', 'success');
      trackEvent('复制 2.0 Worker 代码', { result: 'ok' });
    } catch (error: any) {
      addToast(`复制失败（${error?.message || error}）。也可以从仓库 worker/amsg/worker.bundle.js 获取。`, 'error');
      // 剪贴板 API 在非 HTTPS / 部分 WebView 里会直接抛，这条就是那批人的规模。
      trackEvent('复制 2.0 Worker 代码', { result: 'failed' });
    }
  };

  // workers.dev 在国内连不上时的门面脚本。跟上面那份不一样：这份不打包、原样发布，
  // 用户要照着里面的注释改 UPSTREAM 那一行，所以注释必须留着。
  const handleCopyDenoProxy = async () => {
    try {
      await ActiveMsgClient.copyDenoProxyToClipboard();
      addToast('代理代码已复制，贴进 Deno Playground 后记得改 UPSTREAM 那一行。', 'success');
      trackEvent('复制 2.0 Deno 代理代码', { result: 'ok' });
    } catch (error: any) {
      addToast(`复制失败（${error?.message || error}）。也可以从仓库 worker/amsg/deno-proxy.ts 获取。`, 'error');
      trackEvent('复制 2.0 Deno 代理代码', { result: 'failed' });
    }
  };

  /**
   * 复制密钥时带不带 `变量名=` 前缀，看 Worker 地址填了没：
   * 空着 = 还没装后端，用户要去 Cloudflare 的 Variables and secrets 里新建变量，
   * 给整行最省事（粘一行进去会自动拆成名字和值两栏，不用对着抄名字）；
   * 填了 = 后端早装好了，这会儿是回来改某一项的值，光标就停在值那一栏，
   * 整行粘进去会把变量名一起写成值。
   */
  const copyWholeEnvLine = !config?.workerUrl?.trim();

  /**
   * 把刚生成的密钥交给用户：存进 state 供展示 + 尽量复制到剪贴板。
   * 输入框是 password 型看不见内容，所以生成时必须把值显示出来，
   * 否则「把同样的值填进 Worker 环境变量」这一步没法做。
   * 剪贴板不可用时用户是从下方手抄的，所以展示的那份要和复制的一模一样。
   */
  const revealAndCopy = async (value: string, reveal: (v: string) => void, envName: string) => {
    const text = copyWholeEnvLine ? `${envName}=${value}` : value;
    reveal(text);
    try {
      await navigator.clipboard.writeText(text);
      addToast(
        copyWholeEnvLine
          ? `已复制 ${envName} 整行，粘进 Worker 的 Variables 会自动填好名字和值。`
          : `已复制 ${envName} 的值（不含变量名），直接粘进 Cloudflare 的值那一栏。`,
        'success',
      );
    } catch {
      addToast(copyWholeEnvLine ? '已生成，请手动从下方复制整行。' : '已生成，请手动从下方复制。', 'info');
    }
  };

  const handleGenerateMasterKey = () => {
    // 只报「生成了哪一个」。密钥本体只在这次面板打开期间存在于 state，前端不落盘，
    // 更不会进上报。
    trackEvent('生成 2.0 Worker 密钥', { which: 'master_key' });
    return revealAndCopy(ActiveMsgClient.generateMasterKey(), setGeneratedMasterKey, 'AMSG_MASTER_KEY');
  };

  const handleWipeCloudData = async () => {
    if (!confirm(
      '确定清空云端数据？Worker D1 里属于你的这几样会一起删掉：\n\n'
      + '· 已排程的主动消息任务（含角色自己排的）\n'
      + '· 同步上去的角色上下文与工具凭据\n'
      + '· 登记的 API 凭据\n'
      + '· 推送订阅登记\n\n'
      + '任务删了要重新排。角色上下文下次聊天会自动传回去，API 凭据下次排程/发消息时重新登记，'
      + '工具凭据和推送订阅当场就补登记。'
    )) return;
    setLoading(true);
    try {
      const result = await wipeAmsgCloudData(realtimeConfig, {
        pushRegistered: Boolean(pushStatus?.hasSubscription),
      });

      // 没清干净的地方逐条说明白：这个按钮多半是在「云端数据已经出问题」时点的，
      // 含糊一句「部分失败」会让人不知道下一步该干嘛。
      const problems: string[] = [];
      if (!result.tasks.listed) {
        problems.push('任务清单读不出来（换过 AMSG_MASTER_KEY 的话旧任务解不开就会这样），这些任务到点会失败，Worker 会在 7 天后自动清掉它们');
      } else if (result.tasks.failed > 0) {
        problems.push(`${result.tasks.failed} 个任务没取消成功，建议到角色的主动消息面板里逐个处理`);
      }
      if (result.stateDeleted === null) {
        problems.push('角色上下文没能删掉');
      } else if (!result.toolConfigRestored) {
        problems.push('工具凭据没能补传回去，请到「实时感知」里重新保存一次配置，否则已排程的 AI 任务会一直失败');
      }
      if (result.llmCredentialsDeleted === null) {
        // 老 Worker 上压根没有这张表，这一句同样成立：那边确实没清成，而下次排程会
        // 走回「凭据冻结进任务」的老路，也就无所谓残留。
        problems.push('登记的 API 凭据没能删掉（Worker 版本较旧的话本来就没有这一项）');
      }
      if (result.push === 'failed') {
        problems.push('推送订阅没能收拾干净，建议到上面的推送区域重新订阅一次');
      }

      if (problems.length > 0) {
        addToast(`云端数据没能全部清干净：${problems.join('；')}。`, 'error');
      } else {
        const done = [
          `任务 ${result.tasks.total} 个`,
          `状态 ${result.stateDeleted} 条`,
          `API 凭据 ${result.llmCredentialsDeleted} 行`,
        ];
        if (result.push === 'reregistered') done.push('推送订阅已重新登记');
        addToast(`已清空云端数据（${done.join('、')}）。`, 'success');
      }
    } catch (error: any) {
      addToast(error?.message || '清空云端数据失败。', 'error');
    } finally {
      setLoading(false);
      void refresh();
    }
  };

  /**
   * 开关即时对话。直接落盘而不是走那条 1 秒去抖的自动保存：开关是一次明确的动作，
   * 点完立刻生效（下一条消息就按新路走），而不是「点完还得等一下」。
   */
  const handleToggleInstantChat = async () => {
    const next = !config?.instantChatEnabled;
    // 开了又关是这条路上最值钱的信号：能开、开过、然后放弃了，跟「压根没开」不是一回事。
    trackEvent('切换即时对话', { action: next ? '开' : '关' });
    patchConfig({ instantChatEnabled: next });
    await ActiveMsgStore.saveGlobalConfig({ instantChatEnabled: next });
    addToast(next ? '已开启即时对话，之后的聊天在你的 Worker 上生成。' : '已关闭即时对话，聊天回到本地生成。', 'success');
  };

  const handleGenerateServerToken = () => {
    const token = generateClientToken();
    patchConfig({ serverToken: token });
    trackEvent('生成 2.0 Worker 密钥', { which: 'server_token' });
    return revealAndCopy(token, setGeneratedServerToken, 'AMSG_SERVER_TOKEN');
  };

  if (!config) return null;

  const isConnected = Boolean(config.initializedAt);

  // 体检：探测结果 + 「这台设备订阅了没」这个只有前端知道的事实，红绿灯判定全在
  // amsgDiagnostics 那份纯函数里（那边有回归测试钉着）。
  const diagnosticRows = diagnosticsProbe
    ? buildAmsgDiagnosticRows({
      probe: diagnosticsProbe,
      localPushSubscribed: Boolean(pushStatus?.hasSubscription),
    })
    : [];
  const diagnosticLevel = diagnosticRows.length ? summarizeAmsgDiagnostics(diagnosticRows) : 'unknown';

  const instantChatBlocker = resolveInstantChatBlocker({
    connected: isConnected,
    pushSubscribed: Boolean(pushStatus?.hasSubscription),
    workerSupportsInstantChat: instantChatSupported,
    instantPushOn: instantOn,
  });
  const instantChatBlockedReason = instantChatBlocker ? INSTANT_CHAT_BLOCKER_HINTS[instantChatBlocker] : '';

  return (
    <>
    <Modal
      isOpen={isOpen}
      title="主动消息 2.0"
      onClose={onClose}
      footer={(
        <button
          onClick={onClose}
          className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform"
        >
          关闭
        </button>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        {/* 后台任务暂停着的时候常驻这一条：下面的按钮在折叠区里，不然一眼看不出角色为什么都不响。 */}
        {cronState?.kind === 'known' && !cronState.enabled ? (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-amber-700">
            后台任务已暂停，到点的消息先攒着，恢复后一起补发。
          </div>
        ) : null}

        {/* 体检。主动消息坏掉的那几种方式在界面上全是隐形的：D1 没绑、表结构是旧的、
            VAPID 没配、云端没登记收件设备——任务照建、面板照常，就是一条都不发。
            Worker 的 /debug 一直算得出这些，这里只是把它摆到看得见的地方。 */}
        {config.workerUrl?.trim() ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
            {/* 收着时那句「都正常 / 有问题」就是全部结论，逐项细节点开再看。 */}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setDiagnosticsOpen((prev) => !prev)}
                className="flex-1 flex items-center justify-between gap-2 text-left"
              >
                <span className="flex items-center gap-2">
                  <span className="font-bold text-slate-700">体检</span>
                  {diagnosticRows.length ? (
                    <span className={`text-xs font-bold ${DIAGNOSTIC_STYLES[diagnosticLevel].text}`}>
                      {diagnosticLevel === 'ok' ? '都正常' : diagnosticLevel === 'bad' ? '有问题' : diagnosticLevel === 'warn' ? '有提醒' : '查不全'}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs font-bold text-slate-400">{diagnosticsOpen ? '收起' : '展开'}</span>
              </button>
              {diagnosticsOpen ? (
                <button
                  type="button"
                  onClick={() => void runDiagnostics()}
                  disabled={diagnosing}
                  className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform disabled:opacity-50"
                >
                  {diagnosing ? '检查中…' : '重新检查'}
                </button>
              ) : null}
            </div>

            {!diagnosticsOpen ? null : diagnosticRows.length ? (
              <div className="space-y-2">
                {diagnosticRows.map((row) => {
                  const style = DIAGNOSTIC_STYLES[row.level];
                  return (
                    <div key={row.key}>
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${style.dot}`} />
                        <span className="flex-1 text-xs font-bold text-slate-600">{row.label}</span>
                        <span className={`shrink-0 text-[11px] font-bold ${style.text}`}>{style.word}</span>
                      </div>
                      {/* 正常的行不展开说明：全绿时这一列要短到能一眼扫完。 */}
                      {row.level === 'ok' ? null : (
                        <p className="mt-1 pl-3.5 text-[11px] leading-relaxed text-slate-500 whitespace-pre-line">
                          {row.detail}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-slate-400">
                {diagnosing ? '正在问 Worker…' : '还没有结果，点右上角检查一次。'}
              </p>
            )}
          </div>
        ) : null}

        {/* 正常情况下两道双向门会拦住「两个都开」，能走到这儿全是脏配置遗留。
            脏配置照样会让聊天悄悄走 Instant，2.0 挂在本地那条路上的东西全静默失效——
            没有报错也没有提示，只会表现成「这功能怎么不响」，这张卡就是收拾它的入口。 */}
        {instantOn ? (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-2">
            <div className="font-bold text-amber-900 text-sm">Instant Push 也开着</div>
            <p className="text-xs leading-relaxed text-amber-800">
              检测到 Instant Push 还开着。即时对话已经覆盖了它的能力（发完就自由、云端跑工具、断网补收），两条路只能留一条。点下面把 Instant Push 关掉，聊天就交给 2.0。
            </p>
            <button
              type="button"
              onClick={disableInstantPush}
              className="w-full py-2.5 bg-amber-500 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform"
            >
              关掉 Instant Push（保留它的配置）
            </button>
          </div>
        ) : null}

        {/* 已经填了 Worker 地址就说明后端装好了，这张卡收起来；重装走「清掉地址再回来」这条路。 */}
        {config.workerUrl?.trim() ? null : (
        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-slate-700">一键部署（推荐）</span>
            <span className="shrink-0 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              只要一枚 Token
            </span>
          </div>

          <p className="text-xs leading-relaxed text-slate-500">
            在 Cloudflare 建一枚 API Token 粘进来，建数据库、传后端代码、写密钥、加定时触发
            全都自动做完。不用 GitHub 账号，手机上也走得完。
          </p>

          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-1.5">
            <p className="text-[11px] font-bold text-slate-600">建 Token 时这三项权限都要勾上</p>
            <ul className="text-[11px] leading-relaxed text-slate-500 space-y-0.5 list-disc list-outside pl-4">
              <li>Account → <code className="font-mono">Workers Scripts</code> : Edit</li>
              <li>Account → <code className="font-mono">D1</code> : Edit</li>
              <li>Account → <code className="font-mono">Account Settings</code> : Read</li>
            </ul>
            <a
              href={CF_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              onClick={() => trackEvent('打开 2.0 部署外链', { target: 'CF面板' })}
              className="inline-block mt-1 text-[11px] font-bold text-violet-600"
            >
              ↗ 去 Cloudflare 建 Token
            </a>
          </div>

          <input
            type="password"
            value={cfToken}
            onChange={(e) => setCfToken(e.target.value)}
            placeholder="粘贴 Cloudflare API Token"
            autoComplete="off"
            className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
          />

          {provisionAccounts?.length ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold text-slate-600">这枚 Token 能用在多个账号上，装到哪个？</p>
              {provisionAccounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  disabled={provisioning}
                  onClick={() => void handleOneClickDeploy(account.id)}
                  className="w-full px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-left active:scale-95 transition-transform disabled:opacity-50"
                >
                  {account.name}
                </button>
              ))}
            </div>
          ) : null}

          {needsSubdomain ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold text-slate-600">给这个账号起一个 workers.dev 子域名</p>
              <input
                type="text"
                value={desiredSubdomain}
                onChange={(e) => setDesiredSubdomain(e.target.value)}
                placeholder="例如 my-name（全 Cloudflare 唯一）"
                autoComplete="off"
                className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
              />
              <p className="text-[11px] leading-relaxed text-slate-400">
                后端地址会长这样：<code className="font-mono">sullyos-amsg.你填的.workers.dev</code>。
                这个名字定了就是这个账号所有 Worker 共用的，之后不好改。
              </p>
            </div>
          ) : null}

          <button
            type="button"
            disabled={provisioning || !cfToken.trim()}
            onClick={() => void handleOneClickDeploy()}
            className="w-full py-3 rounded-xl text-sm font-bold bg-violet-500 text-white active:scale-95 transition-transform disabled:opacity-50"
          >
            {provisioning ? provisionStep || '部署中…' : '开始部署'}
          </button>

          {provisionError ? (
            <p className="text-[11px] leading-relaxed text-rose-600 whitespace-pre-line">{provisionError}</p>
          ) : null}

          <p className="text-[10px] leading-relaxed text-slate-400">
            浏览器不能直接调 Cloudflare 的接口（它不给跨域），所以这枚 Token 会经过本站的
            网络代理 Worker 转发一次。部署完它会作为密钥存进<strong>你自己的</strong> Worker，
            以后「更新后端」用的就是它；本页不保存。介意的话可以照下面的手动方式装。
          </p>
        </div>
        )}

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setDeployOpen((prev) => {
              // 只在展开时记一笔：收起也记的话同一个人会被数两次，漏斗第一格直接虚高一倍。
              if (!prev) trackEvent('展开 2.0 部署指引', { mode: '主流程' });
              return !prev;
            })}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">手动部署 Worker（想自己一步步来）</span>
            <span className="text-xs font-bold text-slate-400">{deployOpen ? '收起' : '展开'}</span>
          </button>

          {deployOpen ? (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-slate-500">
                全程在网页上点，不用装东西也不用敲命令，大约 15 分钟。第一次做建议直接照着
                <strong>图文教程</strong>走，下面是简版。
              </p>

              <ol className="text-xs leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                <li>
                  Fork 后端仓库 <code className="font-mono">sullyos-workers</code>
                  （页面右上角 Fork → Create fork）。
                </li>
                <li>
                  CF 后台 Storage &amp; databases → <strong>D1 SQLite Database</strong> 建一个库，
                  把它的 <strong>Database ID</strong> 复制下来。表不用建，下面点「连接」时会自动建好。
                </li>
                <li>
                  CF 后台 Workers &amp; Pages → <strong>Create application</strong> →
                  <strong> Continue with GitHub</strong>，选中你 fork 的仓库，然后填：
                  <ul className="mt-1 space-y-0.5 list-disc list-outside pl-4">
                    <li>Build command：<code className="font-mono">sh ./deploy-prepare.sh</code></li>
                    <li>Advanced settings → Path：<code className="font-mono">/amsg</code></li>
                    <li>
                      Advanced settings 里加一个构建变量
                      <code className="font-mono"> D1_DATABASE_ID </code>
                      = 上一步的 Database ID（<strong>别点 Encrypt</strong>，构建时要读它）
                    </li>
                  </ul>
                </li>
                <li>部署完在 Settings → Variables and secrets 按下面的清单填密钥，再 Deploy 一次。</li>
              </ol>

              <p className="text-[11px] leading-relaxed text-slate-400">
                D1 绑定和「每分钟检查一次」的定时触发器都写在仓库里，会自动带上，不用手动加。
                以后想更新，回你 fork 的仓库点一下 <strong>Sync fork</strong> 就行，CF 会自动重新部署。
              </p>

              <div className="grid grid-cols-3 gap-2">
                {/* 三个出口合成一个事件带 target 枚举：它们是部署流程同一步的三条岔路，
                    拆成三个事件名只是多占清单行数，看漏斗时还得自己加回去。 */}
                <a
                  href={WORKERS_REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('打开 2.0 部署外链', { target: 'fork仓库' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white text-center active:scale-95 transition-transform"
                >
                  ↗ Fork 仓库
                </a>
                <a
                  href={SETUP_WALKTHROUGH_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('打开 2.0 部署外链', { target: '图文教程' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-center active:scale-95 transition-transform"
                >
                  ↗ 图文教程
                </a>
                <a
                  href={buildCloudflareDashboardUrl(config.workerUrl.trim() || undefined)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackEvent('打开 2.0 部署外链', { target: 'CF面板' })}
                  className="py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-center active:scale-95 transition-transform"
                >
                  ↗ CF 面板
                </a>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2.5 text-xs">
                <p className="font-bold text-slate-700">环境变量清单</p>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">AMSG_MASTER_KEY</code>
                    <button
                      type="button"
                      onClick={() => void handleGenerateMasterKey()}
                      className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      生成并复制
                    </button>
                  </div>
                  {generatedMasterKey ? (
                    <SecretReveal value={generatedMasterKey} />
                  ) : (
                    <p className="text-[11px] text-slate-400">
                      加密任务内容用的密钥，只存在 Worker 侧。本页不保存。
                      {copyWholeEnvLine
                        ? <>复制出来是 <code className="font-mono">变量名=值</code> 整行，粘进 CF 的 Variables 会自动分好两栏。</>
                        : <>复制出来只有值本身，直接粘进 CF 里那一项的值那一栏。</>}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-600">VAPID_EMAIL / PUBLIC_KEY / PRIVATE_KEY</code>
                    {onOpenVapid ? (
                      <button
                        type="button"
                        onClick={onOpenVapid}
                        className="shrink-0 px-3 py-1.5 text-[11px] rounded-xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                      >
                        去推送凭据面板
                      </button>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    必须和「推送凭据 (VAPID)」面板里的是<strong>同一对</strong>（和 Instant Push 共用）——
                    整个站点只有一个浏览器推送订阅，Worker 用别的密钥对签推送会 403。
                  </p>
                </div>

                <div className="space-y-1">
                  <code className="font-mono text-[11px] text-slate-600">AMSG_SERVER_TOKEN（可选）</code>
                  <p className="text-[11px] text-slate-400">
                    防止别人滥用你的 Worker。值 = 下面「共享密钥」填的那串，两边一致即可；不配则端点全开。
                  </p>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-2.5">
                <button
                  type="button"
                  onClick={() => setPasteFallbackOpen((prev) => {
                    if (!prev) trackEvent('展开 2.0 部署指引', { mode: '手动粘贴' });
                    return !prev;
                  })}
                  className="w-full flex items-center justify-between text-left text-[11px] font-bold text-slate-400"
                >
                  <span>没有 GitHub 账号？手动粘贴部署</span>
                  <span>{pasteFallbackOpen ? '收起' : '展开'}</span>
                </button>

                {pasteFallbackOpen ? (
                  <div className="mt-2 space-y-2">
                    <ol className="text-[11px] leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                      <li>
                        点下面「复制 Worker 代码」，CF 后台 Create → Worker 建一个空 Worker，
                        进 <strong>Edit code</strong> 全选粘贴覆盖，Deploy。
                      </li>
                      <li>
                        Settings → Bindings 加一个 <strong>D1 database</strong>，
                        变量名必须是 <code className="font-mono">DB</code>。
                      </li>
                      <li>
                        Settings → Trigger Events 加 <strong>Cron Trigger</strong>：
                        <code className="font-mono"> * * * * * </code>（每分钟检查一次到点任务）。
                      </li>
                      <li>Settings → Variables and secrets 按上面的清单填密钥，然后重新 Deploy 一次。</li>
                    </ol>

                    <button
                      type="button"
                      onClick={() => void handleCopyWorkerBundle()}
                      className="w-full py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      复制 Worker 代码
                    </button>

                    <p className="text-[11px] leading-relaxed text-slate-400">
                      这条路每次 Worker 更新都要重新粘一遍，D1 绑定和定时触发器也得自己加，容易漏。
                      能用 GitHub 的话还是走上面的 fork 流程。
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">当前状态</span>
            <span className={`text-xs font-bold ${isConnected ? 'text-emerald-600' : 'text-amber-600'}`}>
              {isConnected ? '已连接' : '未连接'}
            </span>
          </div>

          {workerOutdated ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-amber-700">
              Worker 上跑的还是旧版代码，缺少新特性（大上下文云端存储、服务端工具循环等）。
              回你 fork 的 <code className="font-mono">sullyos-workers</code> 仓库点一下
              <strong> Sync fork</strong>，CF 会自动重新部署（当初是手动粘贴部署的话，
              去下方「部署 Worker」里重新复制一次代码粘贴覆盖）。已有数据和任务不受影响。
            </div>
          ) : null}

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              Worker 地址
            </label>
            <input
              type="text"
              value={config.workerUrl}
              onChange={(event) => patchConfig({ workerUrl: event.target.value })}
              placeholder="https://amsg.你的账号.workers.dev"
              className="w-full bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-xs font-mono"
            />

            <div className="mt-2">
              <button
                type="button"
                onClick={() => setDenoProxyOpen((prev) => {
                  if (!prev) trackEvent('展开 2.0 部署指引', { mode: 'Deno 代理' });
                  return !prev;
                })}
                className="w-full flex items-center justify-between text-left text-[11px] font-bold text-slate-400"
              >
                <span>这个地址连不上？在外面套一层 Deno</span>
                <span>{denoProxyOpen ? '收起' : '展开'}</span>
              </button>

              {denoProxyOpen ? (
                <div className="mt-2 space-y-2">
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    <code className="font-mono">workers.dev</code> 这个域名在国内连不上。
                    办法是给它套一个门面：Worker 和数据全都留在 Cloudflare 不动，
                    只在外面加一层只管转发的 Deno，然后把地址换成 Deno 那个。
                  </p>

                  <ol className="text-[11px] leading-relaxed text-slate-500 space-y-1.5 list-decimal list-outside pl-4">
                    <li>
                      去 Deno 控制台点右上角 <strong>New Playground</strong>。
                    </li>
                    <li>
                      点下面「复制 Deno 代理代码」，在 Playground 里全选粘贴覆盖，
                      把开头 <code className="font-mono">UPSTREAM</code> 那一行改成你上面填的
                      Cloudflare 地址，然后 Deploy。
                    </li>
                    <li>
                      把 Deploy 后拿到的 <code className="font-mono">https://xxx.deno.net</code> 地址
                      填回上面的输入框，替换掉原来那个。
                    </li>
                  </ol>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCopyDenoProxy()}
                      className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      复制 Deno 代理代码
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        trackEvent('打开 Deno 控制台');
                        window.open('https://console.deno.com', '_blank');
                      }}
                      className="shrink-0 px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
                    >
                      去 Deno
                    </button>
                  </div>

                  <p className="text-[11px] leading-relaxed text-slate-400">
                    收消息不走这一层——推送是 Cloudflare 直接发给手机的，
                    所以这层就算挂了也只影响你打开这个面板改配置。
                    部署好后打开 <code className="font-mono">/__proxy-health</code> 能看它活着没。
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
              共享密钥（可选）
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                value={config.serverToken || ''}
                onChange={(event) => patchConfig({ serverToken: event.target.value })}
                placeholder="worker 配了 AMSG_SERVER_TOKEN 才需要填"
                className="flex-1 bg-white/70 border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              />
              <button
                type="button"
                onClick={() => void handleGenerateServerToken()}
                className="shrink-0 px-3 py-3 text-xs rounded-2xl font-bold bg-white border border-slate-200 text-slate-600 active:scale-95 transition-transform"
              >
                随机
              </button>
            </div>
            {generatedServerToken ? (
              <SecretReveal value={generatedServerToken} className="mt-1.5" />
            ) : null}
          </div>

          {/*
            部署还没收尾时这个按钮必须是点不动的：刚建好的 workers.dev 地址要过几十秒才在
            各个边缘节点上都解析得到，这期间点连接必然报「连不上 Worker」。一键部署那条路
            自己会等（waitForWorkerReady），等到了还会顺手把表建好——用户抢在前面点，
            收获的只有一次莫名其妙的失败。
          */}
          <button
            onClick={handleConnect}
            disabled={loading || provisioning}
            className="w-full py-3 bg-slate-900 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {provisioning
              ? provisionStep || '部署中…'
              : loading ? '处理中...' : isConnected ? '重新连接并验证' : '连接并启用'}
          </button>

          <p className="text-xs leading-relaxed text-slate-500">
            「连接」会自动在你的 D1 里把表建好（幂等，重复点没关系），不用手动执行 SQL。
          </p>

          {isConnected ? (
            <div className="pt-1 space-y-2 border-t border-slate-200">
              {/*
                按钮常驻，但有更新时才抢眼：有新版就实心高亮并写明更新到哪一版，
                没新版时弱化成一行浅色的「重新检查并更新」——想手动重跑一次的人照样点得到，
                不用为了这个去别处找入口。
              */}
              <button
                onClick={handleSelfUpdateWorker}
                disabled={loading}
                className={`w-full py-2.5 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50 ${
                  workerVersion?.state === 'outdated'
                    ? 'bg-emerald-600 text-white border border-emerald-600'
                    : 'bg-white border border-slate-300 text-slate-700'
                }`}
              >
                {loading
                  ? '处理中...'
                  : workerVersion?.state === 'outdated'
                    ? `更新 Worker 到 ${workerVersion.expected}`
                    : '重新检查并更新 Worker'}
              </button>
              {workerVersion?.state === 'outdated' ? (
                <p className="text-xs leading-relaxed text-emerald-700">
                  你这台 Worker 上跑的是
                  {workerVersion.deployed ? <code className="font-mono"> {workerVersion.deployed} </code> : '更早的版本'}
                  ，更新后即时对话才走得上新的生成通道。
                </p>
              ) : workerVersion?.state === 'current' ? (
                <p className="text-xs leading-relaxed text-slate-500">
                  后端已经是最新版（<code className="font-mono">{workerVersion.expected}</code>）。
                </p>
              ) : null}
              <p className="text-xs leading-relaxed text-slate-500">
                后端自己去取最新代码覆盖自己，你排好的任务和填过的密钥都不动，更新完会自动验证一次。
                用一键部署装的可以直接点；老办法装的第一次点会提示补一把钥匙，就在下面补。
              </p>
              {selfUpdateHash ? (
                <p className="text-xs leading-relaxed text-emerald-600">
                  当前后端代码指纹：<code className="font-mono">{selfUpdateHash}</code>
                </p>
              ) : null}

              {/* 暂停 / 恢复后台任务：摘掉或加回 Worker 的 cron trigger。旧版 Worker 没这个端点时整块不显示。 */}
              {cronState ? (
                <>
                  <button
                    onClick={handleCronTriggerClick}
                    disabled={loading}
                    className={`w-full py-2.5 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50 ${
                      cronState.kind === 'known' && !cronState.enabled
                        ? 'bg-amber-500 text-white border border-amber-500'
                        : 'bg-white border border-slate-300 text-slate-700'
                    }`}
                  >
                    {loading
                      ? '处理中...'
                      : cronState.kind === 'known' && !cronState.enabled
                        ? '恢复后台任务'
                        : '暂停后台任务'}
                  </button>
                  <p className="text-xs leading-relaxed text-slate-500">
                    暂停会摘掉 Worker 的定时触发，到点的主动消息和定时消息先攒在云端，不会丢；恢复后一起补发。
                  </p>
                </>
              ) : null}

              {attachOpen ? (
                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 space-y-2.5">
                  <p className="text-[11px] font-bold text-slate-600">给这台后端补一把更新用的钥匙</p>
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    建一枚只勾 <strong>Account → Workers Scripts : Edit</strong> 的 Cloudflare API Token
                    粘进来（<strong>Start Date 留空</strong>），SullyOS·糯米机 会把它写进你这台 Worker。
                    做完一次以后更新就都是点上面那个按钮了。
                  </p>
                  <a
                    href={CF_TOKEN_URL}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => trackEvent('打开 2.0 部署外链', { target: 'CF面板' })}
                    className="inline-block text-[11px] font-bold text-violet-600"
                  >
                    ↗ 去 Cloudflare 建 Token
                  </a>
                  <input
                    type="password"
                    value={attachToken}
                    onChange={(e) => setAttachToken(e.target.value)}
                    placeholder="粘贴 Cloudflare API Token"
                    autoComplete="off"
                    className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
                  />

                  {attachNeedsScriptName ? (
                    <input
                      type="text"
                      value={attachScriptName}
                      onChange={(e) => setAttachScriptName(e.target.value)}
                      placeholder="这台 Worker 在 Cloudflare 上的名字"
                      autoComplete="off"
                      className="w-full px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:border-violet-400"
                    />
                  ) : null}

                  {attachAccounts?.length ? (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-bold text-slate-600">多个账号下都有同名 Worker，选一个：</p>
                      {attachAccounts.map((account) => (
                        <button
                          key={account.id}
                          type="button"
                          disabled={attaching}
                          onClick={() => void handleAttachUpdateKey(account.id)}
                          className="w-full px-3 py-2.5 rounded-xl text-xs font-bold bg-white border border-slate-200 text-slate-600 text-left active:scale-95 transition-transform disabled:opacity-50"
                        >
                          {account.name}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    disabled={attaching || !attachToken.trim()}
                    onClick={() => void handleAttachUpdateKey()}
                    className="w-full py-2.5 rounded-xl text-xs font-bold bg-violet-500 text-white active:scale-95 transition-transform disabled:opacity-50"
                  >
                    {attaching ? '装钥匙中…' : '装上钥匙'}
                  </button>

                  {attachError ? (
                    <p className="text-[11px] leading-relaxed text-rose-600 whitespace-pre-line">{attachError}</p>
                  ) : null}

                  <p className="text-[10px] leading-relaxed text-slate-400">
                    这一步只往你的 Worker 里加这一条密钥，不动代码、不动数据库、不动已有的密钥。
                    Token 写进去之后就留在你自己的 Worker 里，本页不保存。
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">
              {pushStatus?.transport === 'unified-push' ? 'UnifiedPush 通知' : '通知权限'}
            </span>
            <span className={`text-xs font-bold ${pushStatus?.hasSubscription ? 'text-emerald-600' : 'text-amber-600'}`}>
              {pushStatus?.hasSubscription ? '已开启' : '未开启'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            这是第二步。只有你真的想让角色在后台主动推送消息时，才需要点。
          </p>
          {pushStatus?.transport === 'unified-push' ? (
            <p className="text-xs leading-relaxed text-slate-500">
              Android App 通过开放的 UnifiedPush 收消息，不依赖 Firebase 或 Google 服务。
              ntfy 只负责在后台唤醒本 App，AMSG Worker 仍是你自己部署的那一台。
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-slate-500">
              推送跟着「排程时所在的设备」走：每条任务到点后，推给保存这条排程时用的那台设备。
              换了设备（或者换了浏览器）之后，在新设备上把排程重新保存一次，之后的推送就发到这台。
            </p>
          )}
          {pushStatus?.needsDistributor ? (
            <a
              href="https://docs.ntfy.sh/subscribe/phone/"
              target="_blank"
              rel="noreferrer"
              className="block text-xs font-bold text-violet-600 underline"
            >
              安装并打开 ntfy（选择无 Firebase 版本）
            </a>
          ) : null}
          {pushStatus?.detail ? (
            <p className="text-xs leading-relaxed text-amber-600">{pushStatus.detail}</p>
          ) : null}
          <button
            onClick={handleCreateSubscription}
            disabled={loading}
            className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {loading ? '处理中...' : pushStatus?.transport === 'unified-push' ? '连接 ntfy 并开启通知' : '开启通知与推送'}
          </button>
        </div>

        {/* 即时对话：聊天本身也交给云端跑。四道门缺一不可，缺哪道就把哪道写出来——
            置灰而不说原因的话，用户只会反复点它。 */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-bold text-slate-700">即时对话</span>
            {/* 开着但有门没过时不能只写「已开启」——那几道门是真的会让这一轮走本地生成的，
                标成绿色的「已开启」就是在骗人：用户以为聊天在云端跑，实际一直在本地。 */}
            <span className={`text-xs font-bold ${
              !config.instantChatEnabled ? 'text-slate-400'
                : instantChatBlockedReason ? 'text-amber-600' : 'text-emerald-600'
            }`}>
              {!config.instantChatEnabled ? '未开启'
                : instantChatBlockedReason ? '已开启 · 暂不生效' : '已开启'}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            开了以后，你发出的每一条消息都由这台 Worker 去生成回复，回复走推送回来。
            发完就能切后台、关掉应用，回来时消息已经在那儿了。关掉则回到本地直连生成。
          </p>
          {instantChatBlockedReason ? (
            <p className="text-xs leading-relaxed text-amber-600">{instantChatBlockedReason}</p>
          ) : (
            <p className="text-[11px] leading-relaxed text-slate-400">
              没有逐字吐出，生成期间显示「正在输入…」；云端明确报错才会提示重发，
              只要还在生成或重试就一直等（LLM 慢不算失败）。
            </p>
          )}
          <button
            type="button"
            onClick={() => void handleToggleInstantChat()}
            disabled={loading || (!config.instantChatEnabled && !!instantChatBlockedReason)}
            className={`w-full py-3 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-40 ${
              config.instantChatEnabled ? 'bg-slate-200 text-slate-600' : 'bg-slate-900 text-white'
            }`}
          >
            {config.instantChatEnabled ? '关闭即时对话' : '开启即时对话'}
          </button>
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 text-xs leading-relaxed text-amber-700 space-y-2">
          <div className="font-bold text-amber-800">风险说明</div>
          <p>开了 2.0 以后，主动消息内容、提示词、相关配置，都会进入你自己部署的 Worker 及其 D1 数据库。</p>
          <p>这是你自己的 Worker、你自己的库，项目不会额外接一个中心服务器。但只要数据进库，能碰到这台 Worker / 数据库的人（也就是你自己）就能看到这些内容。</p>
          <p>如果你不接受把私密提示词、API Key 放进自己部署的服务，就不要开 2.0。</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((prev) => !prev)}
            className="w-full flex items-center justify-between text-left"
          >
            <span className="font-bold text-slate-700">高级信息</span>
            <span className="text-xs font-bold text-slate-400">{advancedOpen ? '收起' : '展开'}</span>
          </button>

          {advancedOpen ? (
            <div className="space-y-3 text-xs">
              <div className="bg-violet-50 border border-violet-100 rounded-2xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-slate-700">X-User-Id</span>
                  <span className="font-mono text-violet-600">{maskActiveMsgUserId(config.userId)}</span>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Worker 侧的环境变量清单见上面「部署 Worker」一节。发布的 Worker 代码默认 CORS 全开
                （<code className="font-mono">origin: '*'</code>），想收紧就把它改成自己站点的域名再部署。
              </p>
              <div className="bg-rose-50 border border-rose-100 rounded-2xl p-3 space-y-2">
                <div className="font-semibold text-rose-700">清空云端数据</div>
                <p className="text-[11px] leading-relaxed text-rose-600">
                  把 Worker D1 里属于你的数据全部删掉：已排程的主动消息任务（含角色自己排的）、
                  同步上去的角色上下文（角色卡、最近聊天窗口等）与工具凭据、推送订阅登记。
                </p>
                <p className="text-[11px] leading-relaxed text-rose-600">
                  清完角色上下文下次聊天会自动传回去，工具凭据和推送订阅当场补登记，任务要自己重新排。
                  换过 <code className="font-mono">AMSG_MASTER_KEY</code> 之后旧数据解不开，也从这里清干净。
                </p>
                <button
                  onClick={() => void handleWipeCloudData()}
                  disabled={loading}
                  className="w-full py-2.5 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
                >
                  {loading ? '处理中...' : '清空云端数据'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
    {/* 摆在 Modal 外面：它自己是全屏 fixed 定位，放进面板里会被面板的动画容器框住。 */}
    <ConfirmDialog
      isOpen={pauseConfirmOpen}
      title="暂停后台任务"
      message="暂停后，到点的主动消息和定时消息会先攒着，不会丢。点「恢复后台任务」之后，攒下的会一起补发。"
      confirmText="暂停"
      variant="warning"
      onConfirm={() => void applyCronTrigger(false)}
      onCancel={() => setPauseConfirmOpen(false)}
    />
    </>
  );
};

export default React.memo(ActiveMsgGlobalSettingsModal);

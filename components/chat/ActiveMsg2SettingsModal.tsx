import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  ActiveMsg2TaskRecord,
  APIConfig,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../../types';
import { ActiveMsgClient, getDefaultActiveMsgFirstSendTime } from '../../utils/activeMsgClient';
import { ActiveMsgStore } from '../../utils/activeMsgStore';
import { type AmsgLastSkip, describeLastSkip } from '../../utils/amsgFirePack';
import {
  type AmsgDailySends,
  type AmsgPacingSettings,
  dayKeyInZone,
  describeMinutes,
  pickPacingSettings,
  resolveAmsgLimits,
} from '../../utils/amsgLimits';
import ActiveMsg2PacingModal from './ActiveMsg2PacingModal';
import { isInstantChatReady } from '../../utils/amsgInstantChat';
import { syncAmsgLlmCredentials } from '../../utils/amsgStateSync';
import { disableScheduleCharPurge, purgeCharCloudState } from '../../utils/amsg2CharCleanup';
import { buildUserCancelledNotices } from '../../utils/amsg2TaskContext';
import { trackEvent } from '../../utils/analytics';
import {
  applyRemoteTaskDelta,
  applyScheduledTask,
  currentOccurrenceMs,
  describeExpirePolicy,
  describeRecurrence,
  describeRemoteLastError,
  describeTaskMode,
  describeTaskProgress,
  formatTaskTime,
  fromDatetimeLocalValue,
  isAmsg2EnabledForChar,
  isPendingTask,
  isRemoteMissingTask,
  keepUncancelledTasks,
  pruneFiredTasks,
  reconcileTasksWithRemote,
  resolveExpirePolicy,
  type RemoteTaskLastError,
  type RemoteTaskProjection,
  shortTaskId,
  toDatetimeLocalValue,
} from '../../utils/amsg2Tasks';

interface ActiveMsg2SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  char: CharacterProfile;
  apiConfig: APIConfig;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  /**
   * 落盘任务清单与角色级设置。
   *
   * 传的是 updater 而不是整份 config：面板的每次保存都要先 await 网络请求，这期间角色
   * 可能在聊天里用工具排了新任务（写的是同一个 activeMsg2Config）。拿渲染时的旧快照整份
   * 盖回去会把它抹掉——远端照发、面板却看不见，就是各处都在防的幽灵任务。
   * updater 由 OSContext 的函数式 setState 执行，拿到的 prev 是最新排队后的状态。
   */
  onSave: (
    updater: (prev: ActiveMsg2CharacterConfig | undefined) => ActiveMsg2CharacterConfig,
  ) => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

const MODE_OPTIONS = [
  { id: 'fixed', label: '固定', desc: '到点直接发你写好的内容' },
  { id: 'auto', label: '自动', desc: '用当前角色设定和聊天快照自己生成' },
  { id: 'prompted', label: '提示词', desc: '围绕你写的方向生成主动消息' },
] as const;

const RECURRENCE_OPTIONS = [
  { id: 'none', label: '一次' },
  { id: 'daily', label: '每天' },
  { id: 'weekly', label: '每周' },
] as const;

/** 「主动频率」卡片上那一行摘要：只挑三项最能说明「多久找你一次」的。 */
const describePacingSummary = (config: AmsgPacingSettings | undefined): string => {
  const limits = resolveAmsgLimits(config);
  const gapMinutes = Math.round(limits.minSendGapMs / 60_000);
  return [
    Number.isFinite(limits.maxUnansweredSends) ? `没回最多连发 ${limits.maxUnansweredSends} 次` : '没回也不限次数',
    gapMinutes > 0 ? `至少隔 ${describeMinutes(gapMinutes)}` : '间隔不限',
    Number.isFinite(limits.dailySendCap) ? `每天最多 ${limits.dailySendCap} 次` : '每天不限',
  ].join(' · ');
};

const ActiveMsg2SettingsModal: React.FC<ActiveMsg2SettingsModalProps> = ({
  isOpen,
  onClose,
  char,
  apiConfig,
  userProfile,
  groups,
  realtimeConfig,
  onSave,
  addToast,
}) => {
  const saved = char.activeMsg2Config;
  const tasks = saved?.tasks ?? [];
  // 任务列表的判定基准时刻：一次 render 只取一次，同屏卡片不会踩在不同的时刻上。
  const now = Date.now();

  // 开关初值走和工具注入门同一个判定：面板显示「关」而角色其实还能排程，界面就在骗人。
  const [enabled, setEnabled] = useState(() => isAmsg2EnabledForChar(char));
  // 即时对话按角色单独关：undefined = 跟随全局默认开，所以只有显式 false 才显示成关。
  const [instantChatOn, setInstantChatOn] = useState(saved?.instantChatEnabled !== false);
  // 全局那道门开没开（isInstantChatReady 读回来的）。没开时下面那行开关置灰。
  const [globalInstantChatOn, setGlobalInstantChatOn] = useState(false);
  const [mode, setMode] = useState<ActiveMsg2Mode>('auto');
  const [firstSendTime, setFirstSendTime] = useState(getDefaultActiveMsgFirstSendTime());
  const [recurrenceType, setRecurrenceType] = useState<ActiveMsg2Recurrence>('none');
  const [userMessage, setUserMessage] = useState('');
  const [promptHint, setPromptHint] = useState('');
  const [maxTokens, setMaxTokens] = useState(String(saved?.maxTokens ?? ''));
  // 「主动频率」那一页开没开（它自带保存按钮，见 ActiveMsg2PacingModal）。
  const [pacingOpen, setPacingOpen] = useState(false);
  const [globalReady, setGlobalReady] = useState(false);
  const [pushSummary, setPushSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // editingTaskUuid=null → 新建；非 null → 编辑该任务（保存时 replaceTaskUuid）。
  const [editingTaskUuid, setEditingTaskUuid] = useState<string | null>(null);
  const [expirePolicy, setExpirePolicy] = useState<ActiveMsg2ExpirePolicy>('expire');
  // 远端对账底账：打开面板时拉一次全量任务，只留归属本角色的 uuid。null = 没对上账
  // （读失败/未拉完），此时不显示「远端不存在」徽标，免得半个清单误伤。
  // 之后不重拉，靠 applyRemoteTaskDelta 把每次远端操作的结果记进来（见 amsg2Tasks 注释）。
  const [knownRemoteUuids, setKnownRemoteUuids] = useState<Set<string> | null>(null);
  // 远端任务的 status / lastError 投影（对账那次一起拉的）。null = 没拉到，卡片上
  // 不显示失败说明。这份只在打开面板时取一次，不随 delta 维护——取消/重建后任务
  // 换了 uuid，旧条目自然失配，不会串行。
  const [remoteTaskInfo, setRemoteTaskInfo] = useState<Map<string, {
    status?: string;
    lastError: RemoteTaskLastError | null;
  }> | null>(null);
  // 最近一次到点没发的记录（worker 写的）。null = 没有记录 / 没读到。
  const [lastSkip, setLastSkip] = useState<AmsgLastSkip | null>(null);
  // 今天主动找了几次（worker 每次发完累加的那份）。null = 没有记录 / 没读到。
  const [dailySends, setDailySends] = useState<AmsgDailySends | null>(null);

  // 表单值重置：面板打开或切换编辑对象时，用被编辑任务的字段填表单（新建则填默认值）。
  // 角色级共享设置（maxTokens）始终跟随保存值。
  useEffect(() => {
    if (!isOpen) return;

    const config = char.activeMsg2Config;
    const list = config?.tasks ?? [];
    // 跟 useState 初值同一个判定：这里自己写三元的话，面板显示的开关状态就会跟
    // 工具注入门分家（见 isAmsg2EnabledForChar 的注释）。
    setEnabled(isAmsg2EnabledForChar(char));
    setInstantChatOn(config?.instantChatEnabled !== false);
    setMaxTokens(config?.maxTokens ? String(config.maxTokens) : '');

    const editing = editingTaskUuid ? list.find((t) => t.taskUuid === editingTaskUuid) : undefined;
    if (editing) {
      setMode(editing.mode);
      setFirstSendTime(toDatetimeLocalValue(editing.firstSendTime));
      setRecurrenceType(editing.recurrenceType);
      setUserMessage(editing.userMessage ?? '');
      setPromptHint(editing.promptHint ?? '');
      setExpirePolicy(resolveExpirePolicy(editing.mode, editing.expirePolicy));
    } else {
      setMode('auto');
      setFirstSendTime(getDefaultActiveMsgFirstSendTime());
      setRecurrenceType('none');
      setUserMessage('');
      setPromptHint('');
      setExpirePolicy('expire');
    }
  }, [isOpen, char.id, char.activeMsg2Config, editingTaskUuid]);

  // 打开面板时的 push 状态检查 + 远端对账（只随 isOpen / 角色变化跑，不随编辑对象重复请求）。
  useEffect(() => {
    if (!isOpen) return;
    // 「主动频率」那一页每次都从关着开始，别带着上回没关的状态直接弹出来。放在这个只认
    // 「打开」的 effect 里：放进上面那个的话，角色在聊天里排一条任务都会把它关掉。
    setPacingOpen(false);
    setKnownRemoteUuids(null);
    setRemoteTaskInfo(null);

    // 全局即时对话开没开（现成的读取函数，别自己另读存储）。读失败按没开置灰。
    void isInstantChatReady().then(setGlobalInstantChatOn).catch(() => setGlobalInstantChatOn(false));

    void (async () => {
      const globalConfig = await ActiveMsgClient.getGlobalConfig();
      const pushStatus = await ActiveMsgClient.getPushStatus();
      setGlobalReady(Boolean(globalConfig.workerUrl));
      const permLabel = pushStatus.permission === 'granted'
        ? '已允许'
        : pushStatus.permission === 'denied'
          ? '已拒绝'
          : '未授权';
      setPushSummary(pushStatus.supported
        ? `权限：${permLabel} / 订阅：${pushStatus.hasSubscription ? '已就绪' : '未创建'}`
        : '当前环境不支持 Web Push');
    })();

    // 防穿帮闸最近拦下了哪次触发、今天主动找了几次。闸是静默的，不说一声的话「让路了」
    // 在用户看来跟「没发出去」一模一样；次数摆出来，用户才知道上限是不是在起作用。
    setDailySends(null);
    void (async () => {
      const status = await ActiveMsgClient.readPanelStatus(char.id);
      setLastSkip(status.lastSkip);
      setDailySends(status.dailySends);
    })();

    void (async () => {
      let remote: Set<string>;
      let remoteTasks: RemoteTaskProjection[];
      try {
        // 全量投影一次拉齐：uuid 当对账底账，status / lastError 给任务卡片说明
        // 「上次到点为什么没发出去」，nextSendAt 给循环任务显示真正会响的时刻。
        remoteTasks = await ActiveMsgClient.listRemoteTasksForChar(char.id);
        remote = new Set(remoteTasks.map((t) => t.uuid));
        setRemoteTaskInfo(new Map(remoteTasks.map((t) => [
          t.uuid, { status: t.status, lastError: t.lastError },
        ])));
      } catch {
        // 对账失败不打扰：null 让「远端不存在」徽标整体不显示，也不清任何任务。
        setKnownRemoteUuids(null);
        return;
      }
      setKnownRemoteUuids(remote);

      // 对账两个方向都走：把已经走完的一次性任务清出列表（不然发过的任务会一直堆在
      // 这儿，得手动一条条取消），同时把远端有、本地没有的接回来——角色自排的任务是
      // 随 push 认领的，那条 push 推失败或被防穿帮闸吞掉，本地就永远不知道它存在，
      // 而它照常到点触发。先拿渲染时这份探一下有没有变化，避免每次开面板都写一次库。
      // 真正落盘时在 updater 里用最新的 prev 重算——面板保存要 await 网络请求，
      // 这期间角色可能在聊天里用工具排了新任务。
      const settle = (tasks: ActiveMsg2TaskRecord[]) =>
        pruneFiredTasks(reconcileTasksWithRemote(tasks, remoteTasks), remote, Date.now());
      const current = char.activeMsg2Config?.tasks ?? [];
      const settled = settle(current);
      const changed = settled.length !== current.length
        || settled.some((t, i) => t !== current[i]);
      if (changed) {
        onSave((prev) => ({
          ...(prev ?? { enabled: true, tasks: [] }),
          tasks: settle(prev?.tasks ?? []),
        }));
      }
    })();
    // char.activeMsg2Config 只在函数体里读当前值当探针，不进依赖——清理落盘会改它，
    // 进了依赖就是「清理 → 重跑 → 再清理」的自激循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, char.id]);

  /**
   * 拼一份要落盘的 config：
   *   - 角色级共享设置（maxTokens）以面板表单为准——只有面板编辑它们；
   *   - 任务清单以「落盘那一刻的最新清单」为准，面板只通过 tasksOf 声明自己动了哪一条。
   * 别把渲染时的 tasks 整份传下去，原因见 onSave 的注释。
   */
  const buildConfig = (
    prev: ActiveMsg2CharacterConfig | undefined,
    tasksOf: (prevTasks: ActiveMsg2TaskRecord[]) => ActiveMsg2TaskRecord[],
    extra?: Partial<ActiveMsg2CharacterConfig>,
  ): ActiveMsg2CharacterConfig => ({
    // 开关以已保存的为准：关着 2.0 时任务列表照样列出来、照样能单独取消，取消完落盘
    // 不能顺手把 2.0 又打开。要开 / 要关的地方各自经 extra 显式给。
    enabled: prev ? prev.enabled : true,
    tasks: tasksOf(prev?.tasks ?? []),
    // 「主动频率」那几项由它自己那一页保存，这里原样带着最新的，别被表单盖掉。
    ...pickPacingSettings(prev),
    // 开着就存 undefined（= 跟随全局默认开），只有显式关掉才落 false。
    instantChatEnabled: instantChatOn ? undefined : false,
    maxTokens: maxTokens.trim() ? Number(maxTokens) : undefined,
    lastSyncedAt: prev?.lastSyncedAt,
    ...extra,
  });

  /**
   * 拨开关本身就算一次保存。
   *
   * 这是设置弹窗，用户拨完开关就认为已经生效了。只改 React state 不写库的话，角色的
   * activeMsg2Config 还是空的（= 关）：聊天里不注入排程工具、fire_pack 的
   * selfScheduleEnabled 上传 false、重开面板开关又显示成「关」，全程一句提示都没有。
   *
   * 只有「开」这一侧就地落盘。「关」要走底部那颗「关闭 2.0」按钮：关掉的同时得把该
   * 角色在远端的任务全部取消，这里就地写一个 enabled:false，远端任务没人管，会变成
   * 面板看不见却照样到点触发的幽灵任务。
   */
  const handleToggleEnabled = () => {
    const turningOn = !enabled;
    setEnabled(!enabled);
    // 顺手把面板上其它角色级设置（maxTokens）一起带上，与
    // buildConfig 的口径一致：这几项本来就只有面板会写。
    if (turningOn) {
      onSave((prev) => buildConfig(prev, (list) => list, { enabled: true }));
      // 上次关 2.0 时云端那份「频率与额度」被写成了关，这里立刻改回开。不等也不报错：
      // 真到要用它的时候（排任务 / 云端聊天）每次都会连同上下文再传一份。
      if (globalReady) {
        void ActiveMsgClient.putCharLimits({
          ...char,
          activeMsg2Config: { ...(char.activeMsg2Config ?? { enabled: true }), enabled: true },
        }).catch((error) => console.warn('[ActiveMsg2Settings] 打开 2.0 时同步主动频率失败（下次上传会带上）', error));
      }
    }
  };

  /**
   * 保存「主动频率」那一页。
   *
   * 先落本地，再单独把这份设置传上云——不等下一次上下文同步：那一份要「有待发任务、
   * 聊完一轮」才会重传，而角色在云端给自己排、手机还没收到的那些任务，要的正是现在
   * 这份上限。传失败不回滚本地：下一次上下文同步会连同它一起带上，这里说一声就行。
   *
   * 关掉「可以排重复的」时，把 TA 现在排着的重复消息一起取消（页面上已经提前说了）。
   */
  const handleSavePacing = async (next: AmsgPacingSettings): Promise<boolean> => {
    const wasAllowingRecurring = resolveAmsgLimits(saved).allowSelfRecurring;
    const toCancel = wasAllowingRecurring && !next.allowSelfRecurring
      ? tasks.filter((t) => t.source === 'character' && t.recurrenceType !== 'none'
        && isPendingTask(t, Date.now()))
      : [];

    onSave((prev) => ({ ...(prev ?? { enabled: true }), ...next }));

    let synced = true;
    if (globalReady) {
      try {
        await ActiveMsgClient.putCharLimits({
          ...char,
          activeMsg2Config: { ...(char.activeMsg2Config ?? { enabled: true }), ...next },
        });
      } catch (error) {
        console.warn('[ActiveMsg2Settings] 主动频率同步到云端失败', error);
        synced = false;
      }
    }

    const failed = new Set<string>();
    for (const t of toCancel) {
      try { await ActiveMsgClient.cancelTask(t.taskUuid); } catch { failed.add(t.taskUuid); }
    }
    if (toCancel.length) {
      const cancelled = toCancel.filter((t) => !failed.has(t.taskUuid));
      await writeCancelledNotices(cancelled);
      setKnownRemoteUuids((prev) => applyRemoteTaskDelta(prev, { gone: cancelled.map((t) => t.taskUuid) }));
      onSave((prev) => buildConfig(prev, (list) => list
        .filter((x) => !cancelled.some((c) => c.taskUuid === x.taskUuid))
        .map((x) => (failed.has(x.taskUuid) ? { ...x, lastError: '远端取消失败，可重试' } : x))));
    }

    if (failed.size) {
      addToast(`主动频率已保存，但 TA 排的重复消息有 ${failed.size} 次没能取消，可以在任务列表里单独取消。`, 'error');
    } else if (!synced) {
      addToast('主动频率已保存在本机，这次没同步到云端，下次同步时会自动带上。', 'error');
    } else {
      addToast(toCancel.length
        ? `主动频率已保存，TA 排过的 ${toCancel.length} 次重复消息已经取消。`
        : '主动频率已保存。', 'info');
    }
    return true;
  };

  /**
   * 即时对话开关也是拨了就落盘（跟上面同一习惯）。它没有远端任务要清，关掉只影响
   * 之后每一轮的路由，所以开关两个方向都能就地保存。注意不能走 buildConfig：那份会
   * 把 enabled 钉成 true，而即时对话和排程是互相独立的两个开关，不能顺手把排程也打开。
   */
  const handleToggleInstantChat = () => {
    const next = !instantChatOn;
    // 全局那个开关有自己的事件，这里单独记：想知道「按角色区分」这件事有没有人真的用。
    trackEvent('切换角色的即时对话', { action: next ? '开' : '关' });
    setInstantChatOn(next);
    onSave((prev) => ({
      ...(prev ?? { enabled: false }),
      // 开着存 undefined（= 跟随全局默认开），只有显式关掉才落 false。
      instantChatEnabled: next ? undefined : false,
    }));
  };

  /**
   * 给角色留一句「这几条被人工取消了」。
   *
   * 聊天历史里那句「明早八点叫你～」是角色自己许的承诺，任务在面板里被删掉之后它并不
   * 知道——下次聊天照旧说「放心我叫你」。所以取消也写进回执台账（按 id 幂等），
   * 下一轮的排程现状块会把它读出来告诉角色。写失败不打断取消本身：任务确实已经没了。
   */
  const writeCancelledNotices = async (cancelled: ActiveMsg2TaskRecord[]) => {
    const notices = buildUserCancelledNotices(char.id, cancelled, Date.now());
    if (!notices.length) return;
    try {
      await ActiveMsgStore.upsertExpiredNotices(char.id, notices);
    } catch (e) {
      console.warn('[ActiveMsg2Modal] 取消回执写入失败（角色可能还以为约定有效）', e);
    }
  };

  const handleCancelTask = async (t: ActiveMsg2TaskRecord) => {
    // alreadyGone = 远端本来就没有这一条（一次性任务发完就删行）。这也是取消成功，
    // 只是文案上说清楚，免得用户以为自己刚刚拦下了一条还没发的消息。
    let alreadyGone = false;
    try {
      ({ alreadyGone } = await ActiveMsgClient.cancelTask(t.taskUuid));
    } catch (e) {
      // 远端取消失败不移除本地记录（Codex #4）——否则远端照发、面板却看不见了。
      console.warn('[ActiveMsg2Modal] 远端取消失败（保留记录待重试）', e);
      onSave((prev) => buildConfig(prev, (list) =>
        list.map((x) => x.taskUuid === t.taskUuid ? { ...x, lastError: '远端取消失败，可重试' } : x)));
      addToast(`任务 [${shortTaskId(t.taskUuid)}] 取消失败（远端未确认），稍后重试。`, 'error');
      // 排程有埋点、取消没有的话，任务生命周期只记了一半。三个结果各有各的含义：
      // failed = 远端照发但面板以为拦下了，是对账不平里最难受的一种。
      trackEvent('取消定时消息', { result: 'failed' });
      return;
    }
    if (editingTaskUuid === t.taskUuid) setEditingTaskUuid(null);
    await writeCancelledNotices([t]);
    setKnownRemoteUuids((prev) => applyRemoteTaskDelta(prev, { gone: [t.taskUuid] }));
    // 落盘走 onSave → OSContext.updateCharacter，那里在落库成功后会给 amsg2 云端快照
    // 打脏（markAmsgStateDirty）——fire_pack 里角色能看到的排程清单因此不会还留着这条
    // 已取消的任务。别在这里用渲染时的 char 快照自己打脏：它的清单还是旧的。
    onSave((prev) => buildConfig(
      prev,
      (list) => list.filter((x) => x.taskUuid !== t.taskUuid),
      { lastSyncedAt: Date.now() },
    ));
    addToast(alreadyGone
      ? `任务 [${shortTaskId(t.taskUuid)}] 在远端已不存在（多半已经发过了），已从列表移除。`
      : `任务 [${shortTaskId(t.taskUuid)}] 已取消。`, 'info');
    trackEvent('取消定时消息', { result: alreadyGone ? '远端已不存在' : 'ok' });
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      if (!enabled) {
        // 第一件事：告诉云端这个角色关了。下面逐条取消要花几秒，这期间正在跑的那一轮
        // （尤其是即时对话——它不在取消范围里）还可能顺手给自己排一条；云端先知道「关了」，
        // 这种漏网的到点就会被直接跳过。传不上去也照样往下关：取消本身才是主线。
        if (globalReady) {
          try {
            await ActiveMsgClient.putCharLimits({
              ...char,
              activeMsg2Config: { ...(char.activeMsg2Config ?? { enabled: false }), enabled: false },
            });
          } catch (error) {
            console.warn('[ActiveMsg2Settings] 关闭 2.0 时没能先通知云端（照常取消任务）', error);
          }
        }
        // 关闭 2.0 = 取消该角色全部远端任务（远端清单优先的口径见 cancelAllTasksForChar，
        // 与删角色共用一份）。取消失败的保留在本地清单里，下次重开面板可重试。
        const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar(
          char.id,
          tasks.map((t) => t.taskUuid),
        );
        const attempted = new Set(targets);
        // 真被取消掉的那些（试过且没失败）要给角色一句交代，否则关掉 2.0 之后它还挂着
        // 一堆没人会兑现的承诺。留在清单里的（取消失败 / 期间新出现的）不写——它们还会响。
        await writeCancelledNotices(tasks.filter((t) =>
          attempted.has(t.taskUuid) && !failed.has(t.taskUuid)));
        // 任务取消掉了，云端还留着这个角色的上下文（fire_pack 是完整角色卡加最近
        // 30 条对话原文，一个角色 32KB 起步）和那行主动消息用的 API 凭据。不清的话
        // 它们会永久留在 D1 里：关掉之后打脏那道门（见 amsgStateSync 的 hasActiveAiTask）
        // 把这个角色永久挡在外面，既不会再刷新，也不会再被清掉，永远冻在此刻这份原文上。
        //
        // 清多少要看还有谁在用：即时对话还生效的话，云端那份上下文每轮聊天都会重写，
        // 这时候清只是白清一次；记忆宫殿的后台活儿走的是另一条路，它那行凭据不能动。
        const cleanup = await purgeCharCloudState(
          char,
          disableScheduleCharPurge(globalInstantChatOn && instantChatOn),
        );
        if (cleanup.status === 'failed') {
          console.warn('[ActiveMsg2Settings] 关闭 2.0 时清云端上下文失败', cleanup.error);
          addToast('ta 在云端的聊天上下文没能清掉，可以稍后重开面板再关一次。', 'error');
        }
        onSave((prev) => buildConfig(
          prev,
          (list) => keepUncancelledTasks(list, attempted, failed, {
            failed: '关闭时远端取消失败，可重试',
            appeared: '关闭主动消息时新出现，未被取消，请单独处理',
          }),
          { enabled: false, lastSyncedAt: Date.now() },
        ));
        addToast(failed.size
          ? `主动消息 2.0 已关闭，但有 ${failed.size} 个任务远端取消失败，请稍后重开面板重试。`
          : '主动消息 2.0 已关闭，全部任务已取消。', failed.size ? 'error' : 'info');
        onClose();
        return;
      }

      if (!globalReady) throw new Error('请先去系统设置里完成“主动消息 2.0”的全局配置。');

      // 时间框里的是用户桌上的钟，先折成绝对时刻再往下传。裸墙钟交出去的话，排程接口
      // 会按角色时区解释它（那条规则是给角色自己排程用的），角色一开自定义时区就差一个
      // 时差。落盘也存这一份，面板显示与远端对账因此认的是同一个时刻。
      const firstSendAt = fromDatetimeLocalValue(firstSendTime);

      // 传给排程接口的这份只用来读角色级设置（封顶校验 / 副 API），不参与落盘。
      const config = buildConfig(saved, () => tasks);
      const result = await ActiveMsgClient.scheduleCharacterTask({
        char, config,
        task: {
          mode, firstSendTime: firstSendAt, recurrenceType,
          promptHint: promptHint.trim() || undefined,
          userMessage: userMessage.trim() || undefined,
          expirePolicy,
        },
        replaceTaskUuid: editingTaskUuid ?? undefined,
        userProfile, groups, realtimeConfig, apiConfig,
      });

      const record: ActiveMsg2TaskRecord = {
        taskUuid: result.uuid,
        clientTaskId: result.clientTaskId,
        mode, firstSendTime: result.firstSendAt, recurrenceType,
        promptHint: promptHint.trim() || undefined,
        userMessage: userMessage.trim() || undefined,
        expirePolicy: resolveExpirePolicy(mode, expirePolicy),
        source: 'user',
        status: 'scheduled',
        createdAt: Date.now(),
      };
      onSave((prev) => buildConfig(
        prev,
        // 并清单的规则（含替换失败时保留旧记录）与角色工具路径共用 applyScheduledTask。
        (list) => applyScheduledTask(list, record, {
          replaceTaskUuid: editingTaskUuid ?? undefined,
          replacedCancelFailed: result.replacedCancelFailed,
        }, Date.now()),
        { lastSyncedAt: Date.now() },
      ));
      // 排程接口回了 success = 这条在远端确实存在，记进底账，别让它被当成「远端不存在」。
      // 编辑时旧任务已被取消才出账；取消失败的话远端新旧并存，旧 uuid 要留着。
      setKnownRemoteUuids((prev) => applyRemoteTaskDelta(prev, {
        present: [result.uuid],
        gone: editingTaskUuid && !result.replacedCancelFailed ? [editingTaskUuid] : [],
      }));
      // 只报枚举构成，内容、时间、编号一概不带。mode/recurrence 虽有 TS 类型，但编辑路径
      // 是从持久化任务记录读回来的（导入的备份可携带任意字符串），上报前运行时收敛一遍。
      trackEvent('排程定时消息', {
        mode: mode === 'fixed' || mode === 'prompted' ? mode : 'auto',
        recurrence: recurrenceType === 'daily' || recurrenceType === 'weekly' ? recurrenceType : 'none',
        source: 'user',
        isEdit: editingTaskUuid ? 'yes' : 'no',
      });
      setEditingTaskUuid(null);
      // 编辑走的是「先建新的再取消旧的」，编号必然换一个——只说「已更新」的话，
      // 用户会以为列表里那条陌生编号是多出来的。
      addToast(result.replacedCancelFailed
        ? '新任务已创建，但旧任务取消失败，请稍后重试。'
        : (editingTaskUuid
          ? `任务已更新，编号换成 [${shortTaskId(result.uuid)}]。`
          : `任务已创建 [${shortTaskId(result.uuid)}]。`),
      result.replacedCancelFailed ? 'error' : 'success');

      // 同步主 API，并为存量任务补刷凭据。失败只提示，不把已成功排程标成失败。
      syncAmsgLlmCredentials(apiConfig);
      const otherAiTasks = tasks.filter((t) =>
        t.taskUuid !== result.uuid
        && t.taskUuid !== editingTaskUuid
        && isPendingTask(t, Date.now()));
      if (otherAiTasks.length > 0) {
        try {
          const refresh = await ActiveMsgClient.refreshCharPendingAiTaskCredentials({
            char, config, apiConfig, tasks: otherAiTasks,
          });
          if (refresh.status === 'partial') {
            addToast(`该角色排好的主动消息里，有 ${refresh.failed} 次的 API 凭据没刷新成功，稍后重新保存可重试。`, 'error');
          }
        } catch (refreshError) {
          console.warn('[ActiveMsg2Modal] 刷新其余任务的 API 凭据失败', refreshError);
        }
      }
    } catch (error: any) {
      const message = error?.message || '主动消息 2.0 保存失败。';
      onSave((prev) => buildConfig(prev, (list) => list, { lastError: message }));
      addToast(message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // 「今天」按这台设备的日期（worker 记账用的也是打包设备的时区，两边对得上）。
  const todayCount = dailySends
    && dailySends.day === dayKeyInZone(now, Intl.DateTimeFormat().resolvedOptions().timeZone)
    ? dailySends : null;
  const todayLine = todayCount && todayCount.sends > 0
    ? `今天 TA 已主动找你 ${todayCount.sends} 次`
      + (todayCount.llmCalls ? `，后台一共调用了 ${todayCount.llmCalls} 次 AI` : '')
    : null;
  // 关掉「可以排重复的」时会一起取消的那几条（在那一页上提前说）。
  const selfRecurringTaskCount = tasks.filter((t) => t.source === 'character'
    && t.recurrenceType !== 'none' && isPendingTask(t, now)).length;

  return (
    <>
    <Modal
      isOpen={isOpen}
      title="主动消息 2.0"
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
            取消
          </button>
          <button onClick={handleSubmit} disabled={isSubmitting} className="flex-1 py-3 bg-fuchsia-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50">
            {isSubmitting ? '保存中...' : !enabled ? '关闭 2.0' : (editingTaskUuid ? '保存修改' : '新建任务')}
          </button>
        </>
      )}
    >
      <div className="space-y-4 text-sm text-slate-600">
        <p className="text-xs leading-relaxed text-slate-500">
          这是新的云端主动消息入口。它会把当前角色设定、最近聊天快照和推送订阅一起提交到主动消息标准服务里。长周期循环任务建议在剧情变化后重新保存一次，避免使用过旧的上下文。
        </p>

        <div className="flex items-center justify-between bg-fuchsia-50 border border-fuchsia-100 rounded-2xl p-4">
          <div>
            <div className="font-bold text-slate-700">启用主动消息 2.0</div>
            <div className="text-xs text-fuchsia-600 mt-1">{pushSummary || '正在检查 Push 状态...'}</div>
          </div>
          <button
            onClick={handleToggleEnabled}
            className={`w-12 h-7 rounded-full transition-colors relative ${enabled ? 'bg-fuchsia-500' : 'bg-slate-200'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        {/* 关着的时候面板下面整块都是空的，不说一句的话，用户看不出这个开关是按角色算的，
            也不知道打开它能换来什么。 */}
        {!enabled ? (
          <p className="text-xs leading-relaxed text-slate-400 pl-1">
            主动消息 2.0 按角色单独开启。打开这个开关，TA 才能在聊天里给你排定时消息，到点由云端发出；你也可以在这里手动建任务。
          </p>
        ) : null}

        {/* 即时对话按角色单独关，和上面的排程开关互相独立（只排程不即时、只即时不排程
            都行），所以不裹在 enabled 里。全局那道门没开时这里只置灰说明，不代替它。 */}
        <div className={`flex items-center justify-between rounded-2xl p-4 border ${globalInstantChatOn ? 'bg-white border-slate-200' : 'bg-slate-50 border-slate-100'}`}>
          <div className="min-w-0 pr-3">
            <div className={`font-bold ${globalInstantChatOn ? 'text-slate-700' : 'text-slate-400'}`}>即时对话</div>
            <div className="text-xs text-slate-400 mt-1 leading-relaxed">
              {globalInstantChatOn
                ? '开着时 TA 的回复在云端生成、走推送送回，发完就能锁屏。关掉的话这个角色回到本地生成。'
                : '需要先在全局设置里开启即时对话，才能按角色单独调。'}
            </div>
          </div>
          <button
            onClick={handleToggleInstantChat}
            disabled={!globalInstantChatOn}
            className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${globalInstantChatOn && instantChatOn ? 'bg-fuchsia-500' : 'bg-slate-200'} ${!globalInstantChatOn ? 'opacity-50' : ''}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-all duration-200 ${globalInstantChatOn && instantChatOn ? 'translate-x-5' : 'translate-x-0'}`} />
          </button>
        </div>

        {/* 「主动频率」：几条上限集中在自己那一页改、自己那一页存，这里只放一行摘要。
            今天主动找了几次摆在摘要下面——上限是不是在起作用，用户一眼能看到。 */}
        {enabled ? (
          <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-4">
            <div className="min-w-0 pr-3">
              <div className="font-bold text-slate-700">主动频率</div>
              <div className="text-xs text-slate-400 mt-1 leading-relaxed">{describePacingSummary(saved)}</div>
              {todayLine ? <div className="text-xs text-fuchsia-600 mt-1 leading-relaxed">{todayLine}</div> : null}
              {/* 「可以排重复的」没开、TA 名下却还挂着重复消息（多半是这项设置出现之前排的）：
                  这些到点会被跳过。不替用户删，说清楚两条路让用户自己选。 */}
              {selfRecurringTaskCount > 0 && !resolveAmsgLimits(saved).allowSelfRecurring ? (
                <div className="text-xs text-amber-600 mt-1 leading-relaxed">
                  TA 之前排过 {selfRecurringTaskCount} 次重复消息，之后都不会再发了。想留着，就在「调整」里打开「可以排每天、每周重复的消息」；不要了，可以在下面的列表里取消。
                </div>
              ) : null}
            </div>
            <button onClick={() => setPacingOpen(true)} className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 font-bold text-xs shrink-0">
              调整
            </button>
          </div>
        ) : null}

        {/* 闸拦下一次触发时不发任何推送，远端那行任务却照样被消费掉——不说一声的话，
            「让路了」在用户看来跟「没发出去 / 功能坏了」完全一样。 */}
        {enabled && lastSkip ? (
          <div className="bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-slate-600">
            {describeLastSkip(lastSkip, (ms) => formatTaskTime(new Date(ms).toISOString()))}
          </div>
        ) : null}

        {/* 关着 2.0 也照样列出来：关闭时没取消掉的任务还会响，藏起来的话用户只能对着
            一个空面板盲点「关闭 2.0」重试。关着时只给「取消」，不给编辑。 */}
        {tasks.length > 0 ? (
          <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">
              任务列表（{tasks.length}）
            </label>
            {/* 一次 render 内所有任务用同一个 now，免得同屏卡片踩在不同的时刻上判定。 */}
            <div className="space-y-2">
              {tasks.map((t) => {
                // 循环任务显示的是「下一次」，不是创建时那个锚点（见 currentOccurrenceMs）。
                const occurrenceMs = currentOccurrenceMs(t, now);
                const missingRemote = isRemoteMissingTask(t, knownRemoteUuids, now);
                const remoteInfo = remoteTaskInfo?.get(t.taskUuid);
                // 远端记录的「上一次没发出去」——worker 只在失败时写、成功不清，
                // 文案里带时间就不会把老记录读成「现在还坏着」。
                const remoteErrorText = describeRemoteLastError(remoteInfo?.lastError, formatTaskTime);
                return (
                  <div key={t.taskUuid} className={`rounded-2xl border px-4 py-3 text-xs ${editingTaskUuid === t.taskUuid ? 'border-fuchsia-400 bg-fuchsia-50' : 'border-slate-200 bg-white'}`}>
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="font-bold text-slate-700 truncate">
                          [{shortTaskId(t.taskUuid)}] {formatTaskTime(occurrenceMs ?? t.firstSendTime)} · {describeRecurrence(t.recurrenceType)}
                        </div>
                        {/* 进度排最前：这一行会被截断，而「发没发」是用户最想先看到的一条，
                            排在末尾的话（模式描述可能很长）它永远看不见。 */}
                        <div className="text-slate-400 mt-0.5 truncate">
                          {describeTaskProgress(t, knownRemoteUuids, now, remoteInfo?.status)} · {describeTaskMode(t)}
                          · {describeExpirePolicy(t.expirePolicy)}
                          · {t.source === 'character' ? '角色创建' : '手动创建'}
                        </div>
                        {missingRemote ? (
                          <div className="text-slate-400 mt-1 text-[11px]">⚠ 云端已无此任务（可能已发送或在别处取消）</div>
                        ) : null}
                        {remoteErrorText ? (
                          <div className="text-amber-600 mt-1 text-[11px]">⚠ {remoteErrorText}</div>
                        ) : null}
                        {/* 上面那行只留得下原因的关键半句，状态码和上游原话的其余部分都截掉了。
                            原文收在这里，排查或者截图问人时点开就能看到全文。stale 是个机器词，没有原文可看。 */}
                        {remoteErrorText && remoteInfo?.lastError?.reason && remoteInfo.lastError.reason !== 'stale' ? (
                          <details className="mt-0.5">
                            <summary className="cursor-pointer text-[10px] font-bold text-slate-400">原文</summary>
                            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-slate-500 bg-slate-50 rounded-lg p-2 select-text">
                              {remoteInfo.lastError.reason}
                            </pre>
                          </details>
                        ) : null}
                        {t.lastError ? (
                          <div className="text-red-500 mt-1 text-[11px]">{t.lastError}</div>
                        ) : null}
                      </div>
                      <div className="flex gap-2 shrink-0 ml-2">
                        {enabled ? (
                          <button onClick={() => setEditingTaskUuid(t.taskUuid)} className="px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 font-bold">编辑</button>
                        ) : null}
                        <button onClick={() => void handleCancelTask(t)} className="px-2.5 py-1.5 rounded-lg bg-red-50 text-red-500 font-bold">取消</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {editingTaskUuid ? (
              <button onClick={() => setEditingTaskUuid(null)} className="mt-2 text-xs text-fuchsia-500 font-bold pl-1">
                ＋ 放弃编辑，改为新建任务
              </button>
            ) : null}
          </div>
        ) : null}

        {enabled ? (
          <>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">
                {editingTaskUuid ? '编辑任务' : '新建任务'}
              </label>
              <div className="space-y-2">
                {MODE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => {
                      setMode(option.id);
                      // fixed 进不了 worker 闸（taskNeedsLlm=false），策略统一钉成 force。
                      if (option.id === 'fixed') setExpirePolicy('force');
                    }}
                    className={`w-full text-left rounded-2xl border px-4 py-3 transition-all ${mode === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                  >
                    <div className="font-bold">{option.label}</div>
                    <div className={`text-xs mt-1 ${mode === option.id ? 'text-fuchsia-50' : 'text-slate-400'}`}>{option.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">首次发送时间</label>
              <input
                type="datetime-local"
                value={firstSendTime}
                onChange={(event) => setFirstSendTime(event.target.value)}
                className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">重复方式</label>
              <div className="grid grid-cols-3 gap-2">
                {RECURRENCE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setRecurrenceType(option.id)}
                    className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${recurrenceType === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-slate-400 mt-2 pl-1">
                2.0 标准版目前只支持：一次 / 每天 / 每周。30 分钟、1 小时、2 小时这类间隔暂时不支持。
              </div>
            </div>

            {mode !== 'fixed' ? (
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">到点时用户正在聊天</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: 'expire', label: '看情况', desc: 'ta 看着对话决定说不说' },
                    { id: 'force', label: '到点必发', desc: '闹钟型，照发' },
                  ] as const).map((option) => (
                    <button
                      key={option.id}
                      onClick={() => setExpirePolicy(option.id)}
                      className={`py-2.5 rounded-xl text-xs font-bold border transition-all ${expirePolicy === option.id ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-white border-slate-200 text-slate-600'}`}
                    >
                      {option.label}
                      <div className={`font-normal mt-0.5 ${expirePolicy === option.id ? 'text-fuchsia-100' : 'text-slate-400'}`}>{option.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {mode === 'fixed' ? (
              <div>
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">固定消息内容</label>
                <textarea
                  value={userMessage}
                  onChange={(event) => setUserMessage(event.target.value)}
                  placeholder="到点后直接推送这段消息"
                  className="w-full h-28 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
                />
              </div>
            ) : (
              <>
                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">
                    {mode === 'prompted' ? '额外提示词' : '补充灵感 (可选)'}
                  </label>
                  <textarea
                    value={promptHint}
                    onChange={(event) => setPromptHint(event.target.value)}
                    placeholder={mode === 'prompted' ? '例如：晚安前撒娇一下，但别太油' : '例如：今天下雨、想找我聊一点轻松的'}
                    className="w-full h-24 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">单次回复长度上限 (可选)</label>
                  <input
                    type="number"
                    min={1}
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    placeholder="例如 120"
                    className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm"
                  />
                </div>
              </>
            )}

            <p className="pt-1 border-t border-slate-100 text-xs text-slate-400">
              主动消息使用当前聊天主 API，调用费用也由主 API 承担。
            </p>
          </>
        ) : null}
      </div>
    </Modal>
    {/* 跟主面板并排渲染而不是塞进它里面：Modal 的卡片带进场动画（transform），嵌在里面的
        fixed 浮层会被困在卡片里、跟着裁掉。后渲染的这个自然盖在上面。 */}
    <ActiveMsg2PacingModal
      isOpen={isOpen && pacingOpen}
      onClose={() => setPacingOpen(false)}
      initial={pickPacingSettings(saved)}
      selfRecurringTaskCount={selfRecurringTaskCount}
      onSubmit={handleSavePacing}
    />
    </>
  );
};

export default React.memo(ActiveMsg2SettingsModal);

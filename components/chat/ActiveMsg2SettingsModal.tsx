import React, { useEffect, useRef, useState } from 'react';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import Modal from '../os/Modal';
import SettingsDetailPage from '../settings/SettingsDetailPage';
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
import {
  AMSG_CRON_TRIGGER_EVENT,
  isAmsg2GloballyEnabled,
  isAmsg2WorkerActive,
  isCloudCronPaused,
} from '../../utils/amsgGlobalGate';
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
import { showInstantChatSendHelp } from '../../utils/instantChatSendHelp';
import { syncAmsgLlmCredentials } from '../../utils/amsgStateSync';
import {
  disableCharacterAmsg2Schedule,
  isChatTimeAwarenessOff,
  needsAmsg2TimeAwarenessOverride,
} from '../../utils/amsg2TimeAwarenessGate';
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
  pruneFiredTasks,
  reconcileTasksWithRemote,
  resolveExpirePolicy,
  type RemoteTaskLastError,
  type RemoteTaskProjection,
  toDatetimeLocalValue,
} from '../../utils/amsg2Tasks';

interface ActiveMsg2SettingsModalProps {
  isOpen: boolean;
  fullPage?: boolean;
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
  { id: 'fixed', label: '固定内容', desc: '到点直接发送你写好的内容，不经过 AI 生成。' },
  { id: 'prompted', label: '指定话题', desc: '到点结合最新的聊天上下文和角色设定，围绕你指定的话题生成消息。' },
  { id: 'auto', label: '自由发挥', desc: '到点结合最新的聊天上下文、角色设定和当前时间，由 TA 自己决定聊什么。' },
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
    Number.isFinite(limits.maxUnansweredSends) ? `未回复时主动联系 ${limits.maxUnansweredSends} 次` : '未回复时主动联系不限次数',
    gapMinutes > 0 ? `至少隔 ${describeMinutes(gapMinutes)}` : '间隔不限',
    Number.isFinite(limits.dailySendCap) ? `每天最多 ${limits.dailySendCap} 次` : '每天不限',
  ].join(' · ');
};

const ActiveMsg2SettingsModal: React.FC<ActiveMsg2SettingsModalProps> = ({
  isOpen,
  fullPage = false,
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
  // 「主动频率」那一页开没开（它自带保存按钮，见 ActiveMsg2PacingModal）。
  const [pacingOpen, setPacingOpen] = useState(false);
  const [globalReady, setGlobalReady] = useState(false);
  const [pushSummary, setPushSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // editingTaskUuid=null → 新建；非 null → 编辑该任务（保存时 replaceTaskUuid）。
  const [editingTaskUuid, setEditingTaskUuid] = useState<string | null>(null);
  const [taskEditorOpen, setTaskEditorOpen] = useState(false);
  const [timeAwareConfirmOpen, setTimeAwareConfirmOpen] = useState(false);
  const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTaskEditor = () => { if (!isSubmitting) setTaskEditorOpen(false); };
  useLocalBackHandler(() => { closeTaskEditor(); return true; }, 45, isOpen && taskEditorOpen && !pacingOpen);
  useEffect(() => { if (!isOpen) { setTaskEditorOpen(false); setEditingTaskUuid(null); setTimeAwareConfirmOpen(false); } }, [isOpen]);
  useEffect(() => {
    const scroll = contentRef.current?.closest('.amsg-detail-scroll') ?? contentRef.current?.parentElement;
    const frame = requestAnimationFrame(() => {
      scroll?.scrollTo?.({ top: 0 });
      if (taskEditorOpen) contentRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [taskEditorOpen]);
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
  const [globalPaused, setGlobalPaused] = useState(false);
  const [cloudCronPaused, setCloudCronPaused] = useState(false);
  const [resumingCron, setResumingCron] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onCronChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ enabled?: boolean }>).detail;
      if (detail && typeof detail.enabled === 'boolean') {
        setCloudCronPaused(!detail.enabled);
      }
    };
    window.addEventListener(AMSG_CRON_TRIGGER_EVENT, onCronChanged);
    return () => window.removeEventListener(AMSG_CRON_TRIGGER_EVENT, onCronChanged);
  }, [isOpen]);

  // 表单值重置：面板打开或切换编辑对象时，用被编辑任务的字段填表单（新建则填默认值）。
  useEffect(() => {
    if (!isOpen) return;

    const config = char.activeMsg2Config;
    const list = config?.tasks ?? [];
    // 跟 useState 初值同一个判定：这里自己写三元的话，面板显示的开关状态就会跟
    // 工具注入门分家（见 isAmsg2EnabledForChar 的注释）。
    setEnabled(isAmsg2EnabledForChar(char));
    setInstantChatOn(config?.instantChatEnabled !== false);

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
    setTimeAwareConfirmOpen(false);
    setKnownRemoteUuids(null);
    setRemoteTaskInfo(null);
    setCloudCronPaused(false);

    // 全局即时对话开没开（现成的读取函数，别自己另读存储）。读失败按没开置灰。
    void isInstantChatReady().then(setGlobalInstantChatOn).catch(() => setGlobalInstantChatOn(false));

    void (async () => {
      const globalConfig = await ActiveMsgClient.getGlobalConfig();
      const pushStatus = await ActiveMsgClient.getPushStatus();
      const active = isAmsg2WorkerActive(globalConfig);
      setGlobalReady(active);
      setGlobalPaused(Boolean(globalConfig.workerUrl?.trim()) && !isAmsg2GloballyEnabled(globalConfig));
      const permLabel = pushStatus.permission === 'granted'
        ? '已允许'
        : pushStatus.permission === 'denied'
          ? '已拒绝'
          : '未授权';
      setPushSummary(
        pushStatus.transport === 'third-party'
          ? `${pushStatus.detail || '第三方推送'} / 状态：${pushStatus.hasSubscription ? '已就绪' : '未配置'}`
          : pushStatus.supported
            ? `权限：${permLabel} / 订阅：${pushStatus.hasSubscription ? '已就绪' : '未创建'}`
            : '当前环境不支持 Web Push（可在全局设置改用第三方推送 App）',
      );
      if (!active) {
        setLastSkip(null);
        setDailySends(null);
        setKnownRemoteUuids(null);
        setCloudCronPaused(false);
        return;
      }

      // 云端定时触发状态直接向 Worker 查询，不依赖本机存储标记。
      void ActiveMsgClient.getCronTriggerState().then((state) => {
        setCloudCronPaused(isCloudCronPaused(state));
      });

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
    })();
    // char.activeMsg2Config 只在函数体里读当前值当探针，不进依赖——清理落盘会改它，
    // 进了依赖就是「清理 → 重跑 → 再清理」的自激循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, char.id]);

  /**
   * 拼一份要落盘的 config：
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
    ...(prev?.allowWithoutTimeAwareness ? { allowWithoutTimeAwareness: true } : {}),
    tasks: tasksOf(prev?.tasks ?? []),
    // 「主动频率」那几项由它自己那一页保存，这里原样带着最新的，别被表单盖掉。
    ...pickPacingSettings(prev),
    // 开着就存 undefined（= 跟随全局默认开），只有显式关掉才落 false。
    instantChatEnabled: instantChatOn ? undefined : false,
    lastSyncedAt: prev?.lastSyncedAt,
    ...extra,
  });

  const confirmEnableWithoutTimeAwareness = () => {
    setTimeAwareConfirmOpen(false);
    if (!enabled) setEnabled(!enabled);
    // 顺手把面板上其它角色级设置（即时对话开关）一起带上，与
    // buildConfig 的口径一致：这几项本来就只有面板会写。
    const extra: Partial<ActiveMsg2CharacterConfig> = {
      enabled: true,
      allowWithoutTimeAwareness: true,
    };
    onSave((prev) => buildConfig(prev, (list) => list, extra));
    // 上次关 2.0 时云端那份「频率与额度」被写成了关，这里立刻改回开。不等也不报错：
    // 真到要用它的时候（排任务 / 云端聊天）每次都会连同上下文再传一份。
    if (globalReady) {
      void ActiveMsgClient.putCharLimits({
        ...char,
        activeMsg2Config: { ...(char.activeMsg2Config ?? { enabled: true }), ...extra },
      }).catch((error) => console.warn('[ActiveMsg2Settings] 打开 2.0 时同步主动频率失败（下次上传会带上）', error));
    }
  };

  /**
   * 拨开关本身就算一次保存。
   *
   * 这是设置弹窗，用户拨完开关就认为已经生效了。只改 React state 不写库的话，角色的
   * activeMsg2Config 还是空的（= 关）：聊天里不注入排程工具、fire_pack 的
   * selfScheduleEnabled 上传 false、重开面板开关又显示成「关」，全程一句提示都没有。
   *
   * 只有「开」这一侧就地落盘（但若角色关着「聊天 · 时间感知强化」且未经显式覆盖确认，
   * 默认拦住并展开风险确认卡片，防止现实定时与架空剧情时间打架）。
   * 「关」要走底部那颗「关闭 2.0」按钮：关掉的同时得把该角色在远端的任务全部取消，
   * 这里就地写一个 enabled:false，远端任务没人管，会变成面板看不见却照样到点触发的幽灵任务。
   */
  const handleToggleEnabled = () => {
    const turningOn = !enabled;
    if (turningOn && needsAmsg2TimeAwarenessOverride(char)) {
      setTimeAwareConfirmOpen(true);
      return;
    }
    setTimeAwareConfirmOpen(false);
    setEnabled(!enabled);
    // 顺手把面板上其它角色级设置（即时对话开关）一起带上，与
    // buildConfig 的口径一致：这几项本来就只有面板会写。
    if (turningOn) {
      const extra: Partial<ActiveMsg2CharacterConfig> = {
        enabled: true,
        ...(isChatTimeAwarenessOff(char) ? { allowWithoutTimeAwareness: true } : {}),
      };
      onSave((prev) => buildConfig(prev, (list) => list, extra));
      // 上次关 2.0 时云端那份「频率与额度」被写成了关，这里立刻改回开。不等也不报错：
      // 真到要用它的时候（排任务 / 云端聊天）每次都会连同上下文再传一份。
      if (globalReady) {
        void ActiveMsgClient.putCharLimits({
          ...char,
          activeMsg2Config: { ...(char.activeMsg2Config ?? { enabled: true }), ...extra },
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
    if (globalReady) {
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
    }

    if (failed.size) {
      addToast(`主动频率已保存，但 TA 排的重复消息有 ${failed.size} 次没能取消，可以在任务列表里单独取消。`, 'error');
    } else if (!synced) {
      addToast('主动频率已保存在本机，这次没同步到云端，下次同步时会自动带上。', 'error');
    } else if (!globalReady && toCancel.length) {
      addToast('主动频率已保存在本机；已排过的重复消息可在恢复全局连接后于列表中取消。', 'info');
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
    if (next) showInstantChatSendHelp('cloud', true);
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
    if (!globalReady) {
      addToast(
        globalPaused
          ? '全局总开关当前处于暂停状态，恢复总开关后再取消远端任务。'
          : '请先去系统设置里完成“主动消息 2.0”的全局配置。',
        'info',
      );
      return;
    }
    if (!(await requestConfirm({
      title: '取消这条主动消息排程？',
      message: '取消后角色不会在原定时间发送这条消息。',
      confirmText: '确认取消',
    }))) return;
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
      addToast('任务取消失败（远端未确认），稍后重试。', 'error');
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
      ? '这条任务在远端已不存在（多半已经发过了），已从列表移除。'
      : '任务已取消。', 'info');
    trackEvent('取消定时消息', { result: alreadyGone ? '远端已不存在' : 'ok' });
  };

  const runDisableAmsg2 = async (closeAfter: boolean) => {
    setIsSubmitting(true);
    try {
      const outcome = await disableCharacterAmsg2Schedule(char, {
        globalState: { globalReady, globalPaused, globalInstantChatOn },
        instantChatEnabled: instantChatOn,
      });
      if (outcome.cleanupFailed) {
        addToast('ta 在云端的聊天上下文没能清掉，可以稍后重开面板再关一次。', 'error');
      }
      onSave((prev) => outcome.applyToConfig(prev, {
        instantChatEnabled: instantChatOn ? undefined : false,
      }));
      if (enabled) setEnabled(!enabled);
      setTimeAwareConfirmOpen(false);
      addToast(outcome.toastMessage, outcome.toastType);
      if (closeAfter) onClose();
    } catch (error: any) {
      const message = error?.message || '主动消息 2.0 保存失败。';
      onSave((prev) => buildConfig(prev, (list) => list, { lastError: message }));
      addToast(message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!enabled) {
      await runDisableAmsg2(true);
      return;
    }

    setIsSubmitting(true);
    try {

      if (!globalReady) {
        if (globalPaused) {
          addToast('全局「主动消息 2.0」总开关当前已暂停，请先到系统设置里重新开启后再新建或修改任务。', 'info');
          return;
        }
        throw new Error('请先去系统设置里完成“主动消息 2.0”的全局配置。');
      }

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
      setTaskEditorOpen(false);
      addToast(result.replacedCancelFailed
        ? '新任务已创建，但旧任务取消失败，请稍后重试。'
        : (editingTaskUuid
          ? '任务已更新。'
          : '任务已创建。'),
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

  const handleResumeCloudCron = async () => {
    if (resumingCron || isSubmitting) return;
    setResumingCron(true);
    try {
      const res = await ActiveMsgClient.setCronTriggerEnabled(true);
      if (res.ok) {
        setCloudCronPaused(false);
        addToast(res.message, 'success');
        trackEvent('暂停后台任务', { action: 'resume', result: 'ok' });
      } else {
        addToast(res.message, 'error');
        trackEvent('暂停后台任务', { action: 'resume', result: 'failed' });
      }
    } catch (error: any) {
      addToast(error?.message || '网络波动，恢复后台任务失败，请稍后重试。', 'error');
      trackEvent('暂停后台任务', { action: 'resume', result: 'failed' });
    } finally {
      setResumingCron(false);
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

  const hintInput = (
    <textarea
      aria-label={mode === 'prompted' ? '这次想聊什么' : '补充灵感'}
      value={promptHint}
      onChange={(event) => setPromptHint(event.target.value)}
      placeholder={mode === 'prompted' ? '例如：问问我今天的考试怎么样' : '例如：今天下雨，想聊一点轻松的'}
      className="w-full h-24 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
    />
  );

  const Panel = fullPage ? SettingsDetailPage : Modal;
  return (
    <>
    <Panel
      isOpen={isOpen}
      hidden={fullPage && pacingOpen}
      title={taskEditorOpen ? (editingTaskUuid ? '编辑定时任务' : '手动安排消息') : fullPage ? `${char.name} · 主动消息` : '主动消息 2.0'}
      onClose={() => { if (isSubmitting) return; if (taskEditorOpen) closeTaskEditor(); else onClose(); }}
      footer={(
        <>
          <button onClick={taskEditorOpen ? closeTaskEditor : onClose} disabled={isSubmitting} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
            {taskEditorOpen ? '返回角色设置' : '完成'}
          </button>
          {(taskEditorOpen || !enabled) && <button
            onClick={handleSubmit}
            disabled={isSubmitting || (enabled && globalPaused)}
            className="amsg-character-save flex-1 py-3 bg-fuchsia-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
          >
            {isSubmitting ? '保存中...' : !enabled ? '关闭 2.0' : (editingTaskUuid ? '保存修改' : '新建任务')}
          </button>}
        </>
      )}
    >
      <div ref={contentRef} tabIndex={-1} className="space-y-4 text-sm text-slate-600 amsg-character-settings">
        {!taskEditorOpen && <>
        {globalPaused ? (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-amber-700">
            系统设置里的「主动消息 2.0」总开关当前处于暂停状态，恢复总开关后才会重新连接云端并生效。
          </div>
        ) : cloudCronPaused ? (
          <div role="status" className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 space-y-2.5 text-xs leading-relaxed text-amber-800">
            <div className="font-bold text-amber-950">云端后台任务已被暂停</div>
            <p>
              定时主动消息到点不会发，私聊云端生成不受影响。恢复后只补发晚到一小时以内的，更早的作废，重复任务跳到下一次。可在此直接恢复，或前往「设置 → 主动消息 2.0 → 功能设置 → 后台地址与维护」恢复。
            </p>
            <button
              type="button"
              onClick={() => void handleResumeCloudCron()}
              disabled={resumingCron || isSubmitting}
              className="px-3.5 py-2 rounded-xl bg-amber-500 text-white font-bold active:scale-95 transition-transform disabled:opacity-50"
            >
              {resumingCron ? '恢复中…' : '立即恢复后台任务'}
            </button>
          </div>
        ) : null}
        <section className="amsg-overview-controls" aria-label="角色功能开关">
        <div className="amsg-overview-control">
          <h4>启用主动消息 2.0</h4>
          <button
            role="switch"
            aria-label="角色主动消息"
            aria-checked={enabled}
            onClick={handleToggleEnabled}
            disabled={isSubmitting}
            className="amsg-overview-switch"
          >
            <span />
          </button>
        </div>

        {/* 即时对话按角色单独关，和上面的排程开关互相独立（只排程不即时、只即时不排程
            都行），所以不裹在 enabled 里。全局那道门没开时这里只置灰说明，不代替它。 */}
        <div className="amsg-character-instant"><div className="amsg-overview-control">
          <h4>私聊云端生成</h4>
          <button
            role="switch"
            aria-label="角色私聊云端生成"
            aria-checked={globalInstantChatOn && instantChatOn}
            onClick={handleToggleInstantChat}
            disabled={!globalInstantChatOn || isSubmitting}
            className="amsg-overview-switch"
          >
            <span />
          </button>
        </div></div>
        </section>
        <div className="amsg-overview-footnote">
          <p>仅调整 {char.name}，与系统设置中的角色开关同步。</p>
          {!globalInstantChatOn && <p>私聊云端生成需先在系统设置的「云端生成」里开启。</p>}
          {!globalReady && <p>{pushSummary || '正在检查后台连接…'}</p>}
          {!enabled && isAmsg2EnabledForChar(char) && <p>关闭尚未保存，请点击下方「关闭 2.0」。</p>}
        </div>

        {/* 角色关了聊天时间感知时，主动消息 2.0 仍按现实时间触发和读取作息；默认拦下开启，
            要求用户显式确认已知时间错乱风险才放行，存量已开未确认的也在此引导处理。 */}
        {!enabled && timeAwareConfirmOpen && isChatTimeAwarenessOff(char) ? (
          <div role="region" aria-label="时间感知冲突确认" className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3 text-xs leading-relaxed text-amber-900">
            <div className="font-bold text-amber-950">当前角色已关闭「聊天 · 时间感知强化」</div>
            <p className="text-amber-800">
              主动消息 2.0 固定按现实时间（或角色时区）定时触发、读取当日作息并安排后续联系，无法跟随架空剧情里的虚拟时段推进。强行开启后，可能出现早晚问候、作息状态与剧情时间错乱等问题。
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => setTimeAwareConfirmOpen(false)}
                className="px-3.5 py-2 rounded-xl bg-amber-900 text-white font-bold active:scale-95 transition-transform"
              >
                保持关闭
              </button>
              <button
                type="button"
                onClick={confirmEnableWithoutTimeAwareness}
                className="px-3.5 py-2 rounded-xl bg-white border border-amber-300 text-amber-800 font-bold active:scale-95 transition-transform"
              >
                我知道自己在做什么，仍然开启
              </button>
            </div>
          </div>
        ) : null}

        {enabled && isChatTimeAwarenessOff(char) ? (
          saved?.allowWithoutTimeAwareness === true ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs leading-relaxed text-amber-800">
              当前角色已关闭聊天时间感知；主动消息 2.0 仍按现实时间（或角色时区）运行，可能与架空剧情时段不一致。
            </div>
          ) : (
            <div role="region" aria-label="时间感知冲突提示" className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-3 text-xs leading-relaxed text-amber-900">
              <div className="font-bold text-amber-950">当前角色已关闭「聊天 · 时间感知强化」</div>
              <p className="text-amber-800">
                主动消息 2.0 固定按现实时间（或角色时区）定时触发、读取当日作息并安排后续联系，无法跟随架空剧情时段，容易出现早晚问候或作息错乱。建议停用主动消息 2.0。
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => void runDisableAmsg2(false)}
                  className="px-3.5 py-2 rounded-xl bg-amber-900 text-white font-bold active:scale-95 transition-transform disabled:opacity-50"
                >
                  {isSubmitting ? '停用中…' : '停用主动消息 2.0'}
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={confirmEnableWithoutTimeAwareness}
                  className="px-3.5 py-2 rounded-xl bg-white border border-amber-300 text-amber-800 font-bold active:scale-95 transition-transform disabled:opacity-50"
                >
                  我知道自己在做什么，继续使用
                </button>
              </div>
            </div>
          )
        ) : null}

        {/* 「主动频率」：几条上限集中在自己那一页改、自己那一页存，这里只放一行摘要。
            今天主动找了几次摆在摘要下面——上限是不是在起作用，用户一眼能看到。 */}
        {enabled ? (
          <section aria-label="主动频率" className="amsg-character-pacing">
            <div className="min-w-0 pr-3">
              <div className="font-bold text-slate-700">主动频率</div>
              <div className="text-xs text-slate-400 mt-1 leading-relaxed">{describePacingSummary(saved)}</div>
              {todayLine ? <div className="text-xs text-fuchsia-600 mt-1 leading-relaxed">{todayLine}</div> : null}
              {/* 「可以排重复的」没开、TA 名下却还挂着重复消息（多半是这项设置出现之前排的）：
                  这些到点会被跳过。不替用户删，说清楚两条路让用户自己选。 */}
              {selfRecurringTaskCount > 0 && !resolveAmsgLimits(saved).allowSelfRecurring ? (
                <div className="text-xs text-amber-600 mt-1 leading-relaxed">
                  TA 之前排过 {selfRecurringTaskCount} 次重复消息，之后都不会再发了。想留着，就在「调整」里打开「允许每天／每周重复」；不要了，可以在下面的列表里取消。
                </div>
              ) : null}
            </div>
            <button onClick={() => setPacingOpen(true)} className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 font-bold text-xs shrink-0">
              调整
            </button>
          </section>
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
          <section className="amsg-character-schedule" aria-label="消息排期">
            <div className="amsg-schedule-heading"><h4>消息排期</h4><span>{tasks.length} 项</span></div>
            {tasks.length === 0 && <div className="amsg-schedule-empty">
              <p>暂无排期</p><span>TA 或你安排的消息会显示在这里。</span>
            </div>}
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
                const progress = describeTaskProgress(t, knownRemoteUuids, now, remoteInfo?.status, cloudCronPaused);
                const isPausedProgress = progress === '后台已暂停' || progress === '已暂停·待恢复';
                return (
                  <div key={t.taskUuid} className={`rounded-2xl border px-4 py-3 text-xs ${editingTaskUuid === t.taskUuid ? 'border-fuchsia-400 bg-fuchsia-50' : 'border-slate-200 bg-white'}`}>
                    {/* 按钮只跟时间共用第一行，下面的标签和内容占满整宽，不被按钮那一列挤窄。
                        卡片不显示短编号：用户靠时间和内容认任务，编号只在给角色看的清单里有用。 */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-bold text-slate-700 text-[13px] min-w-0">
                        {formatTaskTime(occurrenceMs ?? t.firstSendTime)}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {enabled ? (
                          <button
                            onClick={() => { setEditingTaskUuid(t.taskUuid); setTaskEditorOpen(true); }}
                            disabled={!globalReady}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-100 text-slate-600 font-bold disabled:opacity-40"
                          >
                            编辑
                          </button>
                        ) : null}
                        <button
                          onClick={() => void handleCancelTask(t)}
                          disabled={!globalReady}
                          className="px-2.5 py-1.5 rounded-lg bg-red-50 text-red-500 font-bold disabled:opacity-40"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                    {/* 状态拆成可换行的小标签，不截断：「发没发」排最前，是用户最想先看到的。 */}
                    <div className="flex flex-wrap gap-1 mt-1.5 text-[10px]">
                      {(() => {
                        const tone = progress === '发送失败' ? 'bg-red-50 text-red-500'
                          : isPausedProgress ? 'bg-amber-50 text-amber-700'
                          : progress === '待触发' ? 'bg-fuchsia-50 text-fuchsia-600' : 'bg-slate-100 text-slate-500';
                        return <span className={`px-1.5 py-0.5 rounded-md font-bold ${tone}`}>{progress}</span>;
                      })()}
                      {[describeRecurrence(t.recurrenceType), describeExpirePolicy(t.expirePolicy), t.source === 'character' ? '角色创建' : '手动创建'].map((label) => (
                        <span key={label} className="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500">{label}</span>
                      ))}
                    </div>
                    {/* 提示方向 / 灵感可能很长，完整换行显示，不截断。 */}
                    <div className="text-slate-500 mt-1.5 leading-relaxed break-words">{describeTaskMode(t)}</div>
                    {isPausedProgress ? (
                      <div className="text-amber-700 mt-1 text-[11px] leading-relaxed">
                        {progress === '已暂停·待恢复'
                          ? '后台任务已被暂停，因此到点未触发；在上方恢复或前往「设置 → 主动消息 2.0」恢复后台任务后会处理'
                          : '后台任务已被暂停，恢复前到点不会触发；可在上方直接恢复或前往「设置 → 主动消息 2.0」恢复'}
                      </div>
                    ) : null}
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
                );
              })}
            </div>
          </section>
        {enabled && <section className="amsg-character-manual" aria-label="手动安排">
          <div><h4>手动安排 <small>可选</small></h4><p>指定时间或内容时使用，不是开启功能的必填项。</p></div>
          <button type="button" className="amsg-button-secondary" disabled={!globalReady || globalPaused || isSubmitting} onClick={() => { setEditingTaskUuid(null); setTaskEditorOpen(true); }}>新建定时任务 <span aria-hidden>→</span></button>
        </section>}
        </>}
        {enabled && taskEditorOpen ? (
          <>
            <div>
              <p className="amsg-caption mb-3">选择发送方式，再设置时间。</p>
              <div className="amsg-task-modes" aria-label="发送方式">
                {MODE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={mode === option.id}
                    onClick={() => {
                      setMode(option.id);
                      // fixed 进不了 worker 闸（taskNeedsLlm=false），策略统一钉成 force。
                      if (option.id === 'fixed') setExpirePolicy('force');
                    }}
                    className="amsg-task-mode"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="amsg-caption mt-2" aria-live="polite">
                {mode === 'fixed' ? <>到点直接发送你写好的内容，<strong>不经过 AI 生成。</strong></> : MODE_OPTIONS.find(option => option.id === mode)?.desc}
              </p>
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
                  placeholder="写下要发送的原文，TA 不会用 AI 改写"
                  className="w-full h-28 bg-white border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none"
                />
              </div>
            ) : (
              <>
                {mode === 'prompted' ? <div>
                  <label className="text-[10px] font-bold text-slate-400 mb-1.5 block pl-1">这次想聊什么</label>
                  {hintInput}
                  <p className="amsg-caption mt-1">写话题或要求，具体消息由 AI 生成。</p>
                </div> : <details key={editingTaskUuid || 'new'} open={promptHint ? true : undefined}>
                  <summary className="cursor-pointer text-xs text-slate-500 py-2">补充灵感（可选）</summary>
                  <p className="amsg-caption mb-2">仅供参考，TA 仍可自行选择话题。</p>
                  {hintInput}
                </details>}
              </>
            )}

            {mode !== 'fixed' && <p className="pt-1 border-t border-slate-100 text-xs text-slate-400">
              聊天内容以最近成功同步到后台的为准。AI 生成使用当前聊天主 API，费用由该 API 承担。
            </p>}
          </>
        ) : null}
      </div>
    </Panel>
    {/* 跟主面板并排渲染而不是塞进它里面：Modal 的卡片带进场动画（transform），嵌在里面的
        fixed 浮层会被困在卡片里、跟着裁掉。后渲染的这个自然盖在上面。 */}
    <ActiveMsg2PacingModal
      isOpen={isOpen && pacingOpen}
      fullPage={fullPage}
      onClose={() => setPacingOpen(false)}
      initial={pickPacingSettings(saved)}
      selfRecurringTaskCount={selfRecurringTaskCount}
      onSubmit={handleSavePacing}
    />
    {confirmDialog}
    </>
  );
};

export default React.memo(ActiveMsg2SettingsModal);

// 设置页的「推送订阅状态」面板。
//
// 主动消息 2.0 最难自己发现的故障是「静默失联」：任务建得成、界面全绿、到点一条
// 消息都不来。原因通常在推送这条链路上——权限没给、订阅被浏览器吊销、或者 worker
// 上登记的订阅根本不是这台设备。这个面板把这条链路从头到尾摊开，最后一行「云端
// 登记」正是拆穿静默失联的那一行。
//
// 只读诊断走 pushSubscribeShared 的 readBrowserPushState（各推送层共用同一份判定），
// 重置走 ActiveMsgClient 的 amsg2 路径——退订、按 worker 自己的 VAPID 重订、再覆盖
// 登记回 worker。三步缺一不可，少了最后一步就是把这个面板要治的病再犯一遍。

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActiveMsgClient,
  compareRemotePushSubscription,
  fetchWorkerDiagnostics,
  readAmsgFailKind,
  type AmsgPushRegistrationState,
  type AmsgRemotePushSubscription,
} from '../../utils/activeMsgClient';
import {
  judgePushDeliveryFailure,
  type AmsgPushDeliveryProbe,
} from '../../utils/amsgDiagnostics';
import { catchUpMissedPushesManually } from '../../utils/activeMsgRuntime';
import { readBrowserPushState, type BrowserPushState } from '../../utils/pushSubscribeShared';
import {
  describeElapsed,
  describePermission,
  describeServiceWorker,
  describeSubscription,
  describeSupport,
  hasLiveFailure,
  isSupportBad,
  liveFailureKind,
} from '../../utils/pushDiagnosticsView';
import { bucketRetryCount, trackEvent } from '../../utils/analytics';

interface PushSubscriptionPanelProps {
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

/** 连续几次僵尸失败之后，「重置订阅」升级成「深度重置」。 */
const DEEP_RESET_THRESHOLD = 3;

const Row: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
  <div className="flex items-start justify-between gap-3">
    <span className="text-slate-500 shrink-0">{label}</span>
    <span className={`text-right font-medium ${bad ? 'text-rose-600' : 'text-slate-700'}`}>{value}</span>
  </div>
);


const REGISTRATION_TEXT: Record<AmsgPushRegistrationState, { value: string; bad: boolean }> = {
  'worker-unset': { value: '还没填 Worker 地址', bad: true },
  unreachable: { value: '问不到（Worker 连不上，或版本太旧没这个接口）', bad: true },
  missing: { value: '没有登记', bad: true },
  'other-endpoint': { value: '登记的是别的设备', bad: true },
  matched: { value: '已登记（就是这台设备）', bad: false },
};

const PushSubscriptionPanel: React.FC<PushSubscriptionPanelProps> = ({ addToast }) => {
  const [browser, setBrowser] = useState<BrowserPushState | null>(null);
  const [remote, setRemote] = useState<AmsgRemotePushSubscription | null>(null);
  // 「登记的确实是这台设备，但推送根本送不到」——只有 Worker 那侧的投递结果知道这件事。
  // null = 还没问到（没填 Worker / 连不上），那时这一行照实说「没查到」。
  const [delivery, setDelivery] = useState<AmsgPushDeliveryProbe | null>(null);
  const [workerConfigured, setWorkerConfigured] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  // 连续几次僵尸失败。不落盘：刷新页面就归零，用户不会莫名其妙看到一个红按钮。
  const [zombieStreak, setZombieStreak] = useState(0);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const browserState = await readBrowserPushState();
      setBrowser(browserState);
      // 没填 Worker 地址就别去问了——问也是白问，还会在控制台留一串没用的报错。
      const config = await ActiveMsgClient.getGlobalConfig().catch(() => null);
      const configured = Boolean(config?.workerUrl?.trim());
      setWorkerConfigured(configured);
      setRemote(configured ? await ActiveMsgClient.getRemotePushSubscription() : null);
      // 「推送有没有真的送出去」是 Worker 那侧算好的（见 /debug 的 pushDelivery）。
      // 这一行和体检面板读的是同一份，不会一个说红一个说绿。
      const probe = configured ? await fetchWorkerDiagnostics() : null;
      setDelivery(probe?.reachable ? probe.report.storage.pushDelivery ?? null : null);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const deepMode = zombieStreak >= DEEP_RESET_THRESHOLD;

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      if (deepMode) {
        await ActiveMsgClient.deepResetPushSubscription();
      } else {
        await ActiveMsgClient.resetPushSubscription();
      }
      setZombieStreak(0);
      addToast('订阅已重建，并登记到了 Worker 上。', 'success');
      // 只报「成不成 / 是哪一档 / 之前失败了几次」，全是源码里写死的枚举。
      trackEvent(deepMode ? '深度重置推送订阅' : '重置推送订阅', {
        result: 'success',
        attempt: bucketRetryCount(zombieStreak),
      });
    } catch (error: any) {
      const failKind = readAmsgFailKind(error);
      // 僵尸端点是「重试也没用」的那一类，攒够次数把按钮升级成深度重置。
      // 别的失败（没配 VAPID、权限被拒、断网）换深度重置一点用没有，不计数。
      if (failKind === '端点僵尸') setZombieStreak((count) => count + 1);
      // 报错原文可能带 push endpoint，只留在 toast 和控制台里，不进上报。
      addToast(error?.message || '重置订阅失败。', 'error');
      trackEvent(deepMode ? '深度重置推送订阅' : '重置推送订阅', {
        result: failKind,
        attempt: bucketRetryCount(zombieStreak),
      });
    } finally {
      setResetting(false);
      await refresh();
    }
  };

  /**
   * 手动补收：去云端账本上把没收到的消息捞回来。
   *
   * 结果照实说，不含糊：捞回来几条、翻过多少条都报出来。「一条都没补回来」跟「压根没读成」
   * 是两个结论，用户拿它决定下一步该干嘛（前者说明消息不在账本上、该查别处，后者只是这趟
   * 没读成、再点一次就行），混在一起说等于什么都没说。
   */
  const handleCatchUp = async () => {
    setCatchingUp(true);
    try {
      const { written, scanned, stale } = await catchUpMissedPushesManually();
      if (written > 0) {
        // 补回来了，但同一趟里还有超窗的——两件事都得说，不然用户以为全找回来了。
        addToast(
          stale > 0
            ? `补回 ${written} 条消息，去聊天里看看。另有 ${stale} 条超过两天，拿不回来了。`
            : `补回 ${written} 条消息，去聊天里看看。`,
          'success',
        );
      } else if (stale > 0) {
        // 有本该收到的消息、但全都过了两天：说清楚是「丢了」不是「没有」——这是用户
        // 唯一一次知道这件事的机会，含糊过去他会以为链路是好的。
        addToast(`有 ${stale} 条消息超过两天没能收到，已经拿不回来了。`, 'error');
      } else if (scanned > 0) {
        // 账本上有行，但没一条是该上屏的聊天内容（思维链、工具请求这些不进聊天流）。
        addToast('云端暂存里没有未收到的聊天消息。', 'info');
      } else {
        addToast('云端没有漏收的消息——当前推送连接正常。', 'info');
      }
    } catch (error: any) {
      addToast(error?.message || '读取云端暂存消息失败，请稍后再试。', 'error');
    } finally {
      setCatchingUp(false);
    }
  };

  const registration: AmsgPushRegistrationState = workerConfigured
    ? compareRemotePushSubscription(browser?.endpoint, remote)
    : 'worker-unset';
  const registrationText = REGISTRATION_TEXT[registration];

  // 上一次推送到底送没送到。判定跟体检面板共用 judgePushDeliveryFailure——两处各写一套的话，
  // 用户会看到一个红一个绿，而这正是他判断该不该重置订阅的唯一依据。
  const deliveryVerdict = judgePushDeliveryFailure(delivery);
  const deliveryText: { value: string; bad: boolean } = !workerConfigured || !delivery
    ? { value: '没查到（要先连上 Worker）', bad: false }
    : !delivery.probed
      ? { value: delivery.reason === 'unsupported' ? '这台 Worker 还不查' : '没查成', bad: false }
      : delivery.gone && deliveryVerdict
        ? { value: `被推送服务退回（${delivery.gone.status}）`, bad: true }
        // 有旧账但已经不算数了：说清楚「那是上一条订阅的事」，别让人以为从来没坏过。
        : { value: delivery.gone ? '这条订阅登记之后没被退回过' : '没有被退回的记录', bad: false };

  const resetLabel = resetting
    ? (deepMode ? '深度重置中…' : '重置中…')
    : (deepMode ? '深度重置' : '重置订阅');

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3 leading-relaxed">
        主动消息到点靠网页推送送到你手上。这条链路上任意一环断了，表现都是「任务建得成、到点没消息」，
        界面上不会有任何异常。这里把每一环摊开给你看。
      </p>

      <div className="bg-slate-50/70 rounded-2xl p-4 border border-slate-100">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-slate-600">链路状态</p>
          <button
            onClick={() => {
              // 全是浏览器/设备状态的固定枚举，不含端点地址、也不含任何用户配置值
              trackEvent('刷新 Web Push 诊断', browser ? {
                permission: browser.permission,
                subscription: !browser.endpoint ? 'none' : browser.endpointDead ? 'dead' : 'active',
                swState: browser.swState === 'activated' ? 'activated' : browser.swState === 'none' ? 'none' : 'other',
                platform: browser.capacitorNative ? 'capacitor_native' : browser.iosNeedsPwa ? 'ios_needs_pwa' : 'normal',
                registration,
                // 「接口全在但这台设备就是建不出订阅」的唯一可见出口。取的是共用层那个
                // 固定枚举，不含报错原文。
                lastFailure: liveFailureKind(browser) ?? 'none',
                // 「登记全对但推送被退回」有多普遍。四个取值全是这儿写死的字面量，
                // 不带状态码原文、不带端点、不带失败原因。
                delivery: !delivery || !delivery.probed ? 'unknown'
                  : delivery.gone && deliveryVerdict ? 'gone'
                    : delivery.gone ? 'recovered' : 'clean',
              } : undefined);
              void refresh();
            }}
            disabled={refreshing || resetting}
            className="text-[10px] px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:text-slate-300"
          >
            {refreshing ? '读取中…' : '刷新'}
          </button>
        </div>

        {browser ? (
          <div className="space-y-1.5 text-[11px]">
            <Row label="浏览器支持" value={describeSupport(browser)} bad={isSupportBad(browser)} />
            <Row label="通知权限" value={describePermission(browser.permission)} bad={browser.permission !== 'granted'} />
            <Row label="Service Worker" value={describeServiceWorker(browser)} bad={browser.swState !== 'activated'} />
            <Row
              label="浏览器订阅"
              value={describeSubscription(browser)}
              bad={!browser.endpoint || browser.endpointDead}
            />
            <Row label="推送通道" value={browser.channel} />
            <Row label="云端登记" value={registrationText.value} bad={registrationText.bad} />
            {/* 上面每一行答的都是「配好了吗」，这一行答的是「实际推出去了吗」。前面全绿
                后面照样能红——那正是「任务建得成、到点没消息」最难自己发现的一种坏法。 */}
            <Row label="上次投递" value={deliveryText.value} bad={deliveryText.bad} />

            {browser.endpoint && (
              <div className="pt-2 mt-2 border-t border-slate-200">
                <p className="text-[10px] text-slate-400 mb-1">订阅端点（前 60 字符）</p>
                <p className={`text-[10px] font-mono break-all leading-relaxed ${browser.endpointDead ? 'text-rose-600' : 'text-slate-500'}`}>
                  {browser.endpoint.slice(0, 60)}…
                </p>
              </div>
            )}

            {browser.capabilityGap && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                {browser.capabilityGap}。
              </div>
            )}
            {/* 失败原文以前只走 toast，一闪而过就没了——而这类失败恰恰最需要照着原文
                排查。这里把它固定显示出来，直到订阅真的建起来为止。 */}
            {hasLiveFailure(browser) && browser.lastSubscribeFailure && (() => {
              const failure = browser.lastSubscribeFailure!;
              const elapsed = describeElapsed(failure.at);
              return (
                <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                  <p className="font-semibold mb-1">上次建订阅失败{elapsed && `（${elapsed}）`}</p>
                  <p>{failure.text}。</p>
                  {(failure.kind === 'channel-unreachable' || failure.kind === 'no-subscription') && (
                    <p className="mt-1.5 pt-1.5 border-t border-rose-200">
                      这一类<b>重试多少次都是一样的结果</b>，问题不在这个站点、也不在权限，
                      换个浏览器、换个网络或换台设备才有用。
                    </p>
                  )}
                </div>
              );
            })()}
            {browser.endpointDead && (
              <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                订阅地址变成了 <code className="font-mono">permanently-removed.invalid</code>，
                意思是浏览器把这条订阅吊销了（常见原因：很久没打开、通知权限被改过、站点数据被清过）。
                这个域名全球都不会解析，推送发过去必然失败。点下面的「重置订阅」重建一条就行。
              </div>
            )}
            {deliveryVerdict?.level === 'bad' && (
              <div className={`mt-2 p-2 border rounded-lg text-[10px] leading-relaxed ${
                deliveryVerdict.level === 'bad'
                  ? 'bg-rose-50 border-rose-200 text-rose-700'
                  : 'bg-amber-50 border-amber-200 text-amber-700'
              }`}>
                <p className="font-semibold mb-1">推送被退回了</p>
                <p>{deliveryVerdict.what}。</p>
                {/* 这段解释只在坐实了的时候说：warn 那档是 Worker 问不到，上面几行本来
                    就红着，再说一句「上面都没问题」只会自相矛盾。 */}
                {deliveryVerdict.level === 'bad' && (
                  <p className="mt-1.5 pt-1.5 border-t border-current/20">
                    上面每一行<b>都没问题</b>，坏的是那条订阅本身——它在推送服务
                    （Chrome 走 FCM、Firefox 走 Mozilla、iOS 走 Apple）那侧已经作废了，
                    这件事只有推送服务知道，前面几行谁都查不出来。点下面的「重置订阅」换一条新的。
                  </p>
                )}
              </div>
            )}
            {registration === 'other-endpoint' && (
              <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                Worker 上登记的订阅不是这台设备——主动消息到点会推到<b>别处</b>，这台收不到。
                换过设备、换过浏览器、或者换过 Worker 之后会这样（一个账号只存一份订阅，后登记的顶掉先前的）。
                点「重置订阅」把它改成这台。
              </div>
            )}
            {/* 通道不通 / 内核不支持的时候不提「点重置订阅」：那一步必挂在建订阅上，
                登记根本轮不到，上面那个失败框才是这台设备真正的结论。 */}
            {registration === 'missing' && !isSupportBad(browser) && (
              <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                Worker 上一份订阅都没有，到点没地方推。点「重置订阅」登记一下这台设备。
              </div>
            )}
            {browser.iosNeedsPwa && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                检测到 iOS Safari，但现在不是从主屏图标启动的。
                iOS 的网页推送必须先「添加到主屏幕」、再从主屏图标打开才能用。
              </div>
            )}
            {browser.capacitorNative && (
              <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                你现在用的是<b>打包好的 App</b>，不是浏览器网页。网页推送这条通道在 App 里不存在，
                这个面板可以直接忽略——不影响正常使用。
              </div>
            )}
          </div>
        ) : (
          <p className="text-[10px] text-slate-400">读取中…</p>
        )}

        <button
          disabled={resetting || refreshing || browser?.capacitorNative}
          onClick={() => void handleReset()}
          className={`mt-4 w-full py-2 rounded-xl text-xs font-bold border ${
            resetting || refreshing || browser?.capacitorNative
              ? 'bg-slate-100 text-slate-400 border-slate-200'
              : deepMode || browser?.endpointDead || registrationText.bad || deliveryText.bad
                ? 'bg-rose-500 text-white border-rose-500 hover:bg-rose-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
          }`}
        >
          {resetLabel}
        </button>
        <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
          「重置订阅」会清掉现在这条、重建一条，再登记到 Worker 上。换了浏览器、换了 Worker、
          或者订阅被吊销之后点它。
          {deepMode && <><br/>连着几次都没成，已经切到「深度重置」——它会把 Service Worker 整个装一遍，更彻底。</>}
        </p>

        {/* 上面那条链路修好了也追不回已经丢掉的消息——那些还在云端账本上躺着，得有人去拿。
            平时冷启动和回到前台会自动捞一次，这个按钮是给「我确实少收了东西」的时候用的：
            它连头一趟的账本存量也当补收处理，而自动那条路会把存量整批销掉（分不清哪些是
            真丢的、哪些是当时收到了只是老版本不会销账，倒出来就是重放）。 */}
        {workerConfigured && !browser?.capacitorNative && (
          <>
            <button
              disabled={catchingUp || resetting || refreshing}
              onClick={() => void handleCatchUp()}
              className={`mt-3 w-full py-2 rounded-xl text-xs font-bold border ${
                catchingUp || resetting || refreshing
                  ? 'bg-slate-100 text-slate-400 border-slate-200'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {catchingUp ? '正在找…' : '找回没收到的消息'}
            </button>
            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
              每条消息发出去之前，云端都先记了一行，你这边收到了才销账。所以推送要是在路上丢了
              （网络不稳、挂着代理、手机压后台），内容还留在云端——点它把最近一天里漏掉的捞回来。
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default PushSubscriptionPanel;

import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import SettingsDetailPage from '../settings/SettingsDetailPage';
import {
  type AmsgPacingSettings,
  DEFAULT_MAX_ACTIVE_TASKS,
  DEFAULT_MAX_UNANSWERED_SENDS,
  DEFAULT_MIN_SEND_GAP_MINUTES,
  DEFAULT_RECURRING_STOP_AFTER,
  describeMinutes,
  MAX_ACTIVE_TASKS_CEILING,
  resolveAmsgLimits,
} from '../../utils/amsgLimits';

/**
 * 「主动频率」：用户给这个角色定的几条上限（主动消息 2.0 面板里点「调整」打开）。
 *
 * 单独成一页、自带保存按钮：这几项跟「新建任务」那张表单不是一回事，挤在一起的话，
 * 底部按钮只能是「新建任务」，改个上限就得顺手建一条任务才存得下来。
 *
 * 文案只说「会怎样」，不讲实现：用户要知道的是「到了上限会跳过、不补发」「你手动排的
 * 算不算」，不需要知道这些闸在哪一层拦。
 */

interface ActiveMsg2PacingModalProps {
  isOpen: boolean;
  fullPage?: boolean;
  onClose: () => void;
  /** 当前保存着的设置（没设的项 = 用默认值）。 */
  initial: AmsgPacingSettings;
  /** TA 现在排着几次每天/每周重复的消息（关掉「可以排重复的」时会一起取消）。 */
  selfRecurringTaskCount: number;
  /** 保存。返回 true 关掉这一页；false 表示没存成、留在原处（调用方负责提示）。 */
  onSubmit: (next: AmsgPacingSettings) => Promise<boolean>;
}

/** 下拉框的值：'' = 跟默认值走（存 undefined），其余是数字的字符串。 */
type SelectValue = string;

const toSelect = (value: number | undefined): SelectValue => (value === undefined ? '' : String(value));
const fromSelect = (value: SelectValue): number | undefined => (value === '' ? undefined : Number(value));

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const GAP_OPTIONS = [5, 10, 20, 30, 60, 120, 180];
const DAILY_CAP_OPTIONS = [1, 2, 3, 5, 8, 10, 15, 20, 30];

const selectClass = 'amsg-pacing-select';

const Field: React.FC<{ label: string; hint: string; children: React.ReactNode; warning?: string | null }> = ({
  label, hint, children, warning,
}) => (
  <div className="amsg-pacing-field">
    <label className="amsg-pacing-row"><span>{label}</span>{children}</label>
    <p className="amsg-pacing-hint">{hint}</p>
    {warning ? <p className="amsg-pacing-warning">{warning}</p> : null}
  </div>
);

const Toggle: React.FC<{ label: string; on: boolean; onClick: () => void }> = ({ label, on, onClick }) => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={on}
    onClick={onClick}
    className="amsg-overview-switch"
  >
    <span />
  </button>
);

const ActiveMsg2PacingModal: React.FC<ActiveMsg2PacingModalProps> = ({
  isOpen, fullPage = false, onClose, initial, selfRecurringTaskCount, onSubmit,
}) => {
  const [maxUnanswered, setMaxUnanswered] = useState<SelectValue>('');
  const [minGap, setMinGap] = useState<SelectValue>('');
  const [dailyCap, setDailyCap] = useState<SelectValue>('');
  const [recurringStop, setRecurringStop] = useState<SelectValue>('');
  const [maxTasks, setMaxTasks] = useState<SelectValue>('');
  const [allowRecurring, setAllowRecurring] = useState(false);
  const [allowForce, setAllowForce] = useState(false);
  const [saving, setSaving] = useState(false);

  // 每次打开都从保存值重新填：上次没保存就关掉的改动不该留着。只认「打开」这一下：
  // initial 跟着角色配置走，这一页开着时角色在聊天里排了条任务，配置对象就换了一个，
  // 跟着它重填的话用户正在改的几项会被悄悄冲掉。
  useEffect(() => {
    if (!isOpen) return;
    const resolved = resolveAmsgLimits(initial);
    setMaxUnanswered(toSelect(initial.maxUnansweredSends));
    setMinGap(toSelect(initial.minSendGapMinutes));
    // 每日上限的 0 和「没设」是同一个意思（不限），下拉里只留一个「不限」。
    setDailyCap(initial.dailySendCap ? String(initial.dailySendCap) : '');
    setRecurringStop(toSelect(initial.recurringStopAfter));
    setMaxTasks(toSelect(initial.maxActiveTasks));
    setAllowRecurring(resolved.allowSelfRecurring);
    setAllowForce(resolved.allowSelfForce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const wasAllowingRecurring = resolveAmsgLimits(initial).allowSelfRecurring;
  const willCancelRecurring = wasAllowingRecurring && !allowRecurring && selfRecurringTaskCount > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      const closed = await onSubmit({
        maxUnansweredSends: fromSelect(maxUnanswered),
        minSendGapMinutes: fromSelect(minGap),
        dailySendCap: fromSelect(dailyCap),
        recurringStopAfter: fromSelect(recurringStop),
        maxActiveTasks: fromSelect(maxTasks),
        allowSelfRecurring: allowRecurring,
        allowSelfForce: allowForce,
      });
      if (closed) onClose();
    } finally {
      setSaving(false);
    }
  };

  const Panel = fullPage ? SettingsDetailPage : Modal;
  return (
    <Panel
      isOpen={isOpen}
      title="主动频率"
      onClose={() => { if (!fullPage || !saving) onClose(); }}
      footer={(
        <>
          <button onClick={onClose} disabled={fullPage && saving} className="amsg-pacing-action amsg-pacing-back flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">
            返回角色设置
          </button>
          <button onClick={() => void handleSave()} disabled={saving} className="amsg-pacing-action amsg-pacing-save flex-1 py-3 bg-fuchsia-500 text-white font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50">
            {saving ? '保存中...' : '保存'}
          </button>
        </>
      )}
    >
      <div className="amsg-pacing-settings">
        <p className="amsg-pacing-intro">
          这里管的是 TA 主动来找你的消息。你们正常聊天时 TA 的回复不算在内。
        </p>

        <section className="amsg-pacing-fields" aria-label="联系频率">

          <Field
            label="未回复时主动联系"
            hint="一次联系可包含多条消息；你回复后重新计数。达到上限后，TA 自己安排的后续联系会跳过、不补发；你手动安排的不受此项限制。"
            warning={maxUnanswered === '0' ? '选了不限，你不回的时候 TA 可以一直接着找你，每一次都要消耗 API 额度。' : null}
          >
            <select value={maxUnanswered} onChange={(e) => setMaxUnanswered(e.target.value)} className={selectClass}>
              <option value="">默认（{DEFAULT_MAX_UNANSWERED_SENDS} 次）</option>
              {range(1, 10).map((n) => <option key={n} value={String(n)}>{n} 次</option>)}
              <option value="0">不限</option>
            </select>
          </Field>

          <Field
            label="两次联系至少间隔"
            hint="只管 TA 自己排的，免得接连不断地刷屏。"
          >
            <select value={minGap} onChange={(e) => setMinGap(e.target.value)} className={selectClass}>
              <option value="">默认（{describeMinutes(DEFAULT_MIN_SEND_GAP_MINUTES)}）</option>
              {GAP_OPTIONS.map((m) => <option key={m} value={String(m)}>{describeMinutes(m)}</option>)}
              <option value="0">不限制</option>
            </select>
          </Field>

          <Field
            label="每天最多联系"
            hint="你手动排的也算在内（写好固定内容的那种不算）。到了上限，当天剩下的会跳过、不补发，第二天重新数。"
          >
            <select value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} className={selectClass}>
              <option value="">不限（默认）</option>
              {DAILY_CAP_OPTIONS.map((n) => <option key={n} value={String(n)}>{n} 次</option>)}
            </select>
          </Field>

          <Field
            label="重复消息未回暂停"
            hint="对每天、每周重复的消息生效，你手动排的也算（写好固定内容的那种不算）。停下以后，你回一句话它就会恢复。"
          >
            <select value={recurringStop} onChange={(e) => setRecurringStop(e.target.value)} className={selectClass}>
              <option value="">默认（{DEFAULT_RECURRING_STOP_AFTER} 次）</option>
              {range(1, 10).map((n) => <option key={n} value={String(n)}>{n} 次</option>)}
              <option value="0">不停</option>
            </select>
          </Field>

          <Field
            label="最多同时安排"
            hint="你和 TA 排的共用这些名额，每天、每周重复的只算一次。"
          >
            <select value={maxTasks} onChange={(e) => setMaxTasks(e.target.value)} className={selectClass}>
              <option value="">默认（{DEFAULT_MAX_ACTIVE_TASKS} 次）</option>
              {range(1, MAX_ACTIVE_TASKS_CEILING).map((n) => <option key={n} value={String(n)}>{n} 次</option>)}
            </select>
          </Field>
        </section>

        <section className="amsg-pacing-permissions" aria-label="TA 的排程权限">
          <h4>TA 自己能排什么</h4>
          <p className="amsg-pacing-hint">仅限制 TA 自己安排的消息。</p>

          <div className="amsg-pacing-permission">
            <div className="amsg-pacing-row">
              <span>允许每天／每周重复</span>
              <Toggle label="允许每天／每周重复" on={allowRecurring} onClick={() => setAllowRecurring(!allowRecurring)} />
            </div>
            <p className="amsg-pacing-hint">关闭时，TA 只能安排一次性的消息。</p>
              {willCancelRecurring ? (
                <p className="amsg-pacing-warning">
                  TA 排过 {selfRecurringTaskCount} 次重复消息，保存后会一起取消。
                </p>
              ) : null}
          </div>

          <div className="amsg-pacing-permission">
            <div className="amsg-pacing-row">
              <span>允许到点必发</span>
              <Toggle label="允许到点必发" on={allowForce} onClick={() => setAllowForce(!allowForce)} />
            </div>
            <p className="amsg-pacing-hint">开启后，约好的消息到点照发；关闭时，TA 会结合聊天决定是否开口。</p>
          </div>
        </section>
      </div>
    </Panel>
  );
};

export default React.memo(ActiveMsg2PacingModal);

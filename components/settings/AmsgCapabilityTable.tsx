import React, { useId, useState } from 'react';
import type { AmsgCapabilityId, AmsgCapabilityRow, AmsgCapabilityState } from '../../utils/amsgCapabilities';
import { AmsgIcon } from './AmsgArtwork';

/** 开关不在 2.0 工作区里的能力，点了只说去哪开，不做跨 App 跳转。 */
const ELSEWHERE: Partial<Record<AmsgCapabilityId, string>> = {
  away: '按角色开：在和 TA 的聊天里点「＋」→「离开后消息」。',
  date: '按角色开：在「见面」里点角色卡右上角的齿轮 →「离开提醒」。',
  mcp: '在系统设置的「扩展连接 → MCP」里添加服务器并打开。',
};

const STATE_TEXT: Record<AmsgCapabilityState, string> = { ok: '可用', bad: '不可用', off: '未开启', checking: '检测中' };

function StateMark({ state }: { state: AmsgCapabilityState }) {
  return <svg className="amsg-capability-mark" data-state={state} viewBox="0 0 20 20" aria-hidden="true">
    {state === 'ok' ? <path d="m5 10.5 3.2 3.2L15 6.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      : state === 'bad' ? <path d="m6 6 8 8M14 6l-8 8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        : state === 'off' ? <circle cx="10" cy="10" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          : <g fill="currentColor"><circle cx="5" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="15" cy="10" r="1.6" /></g>}
  </svg>;
}

/** 红叉的行交给 onSelect 按原因跳转；其余行开关不在本页的就地提示去哪开。 */
export default function AmsgCapabilityTable({ rows, onSelect }: { rows: AmsgCapabilityRow[]; onSelect: (row: AmsgCapabilityRow) => void }) {
  const prefix = useId();
  const [hint, setHint] = useState<AmsgCapabilityId | null>(null);
  return <section className="amsg-capability-table" aria-labelledby={`${prefix}-title`}>
    <div className="amsg-capability-head"><h4 id={`${prefix}-title`}>能力</h4><span aria-hidden="true">现在</span></div>
    {rows.map(row => {
      const elsewhere = row.cause ? undefined : ELSEWHERE[row.id];
      const hintId = `${prefix}-${row.id}-hint`;
      return <div key={row.id} className="amsg-capability-row">
        <button type="button" aria-label={`${row.label}：${STATE_TEXT[row.state]}${row.note ? `，${row.note}` : ''}`}
          aria-expanded={elsewhere ? hint === row.id : undefined} aria-controls={elsewhere ? hintId : undefined}
          onClick={() => elsewhere ? setHint(current => current === row.id ? null : row.id) : onSelect(row)}>
          <span className="amsg-capability-copy"><strong>{row.label}</strong>{row.note && <small>{row.note}</small>}</span>
          <StateMark state={row.state} />
          <AmsgIcon name="chevron" className="amsg-capability-chevron" />
        </button>
        {elsewhere && hint === row.id && <p id={hintId} className="amsg-capability-hint">{elsewhere}</p>}
      </div>;
    })}
  </section>;
}

import React from 'react';

export interface AmsgTab { id: string; label: string; lines?: string[]; icon?: React.ReactNode; attention?: boolean; }

export default function AmsgTabBar({ tabs, selected, onSelect, label, prefix, vertical = false, panelId }: {
  tabs: AmsgTab[]; selected: string; onSelect: (id: string) => void; label: string; prefix: string; vertical?: boolean; panelId?: string;
}) {
  return <div role="tablist" aria-label={label} aria-orientation={vertical ? 'vertical' : 'horizontal'} className={vertical ? 'amsg-sidebar-tabs' : 'amsg-config-tabs'}>
    {tabs.map((tab, index) => <button
      key={tab.id} type="button" role="tab" id={`${prefix}-tab-${tab.id}`} aria-controls={panelId || `${prefix}-panel-${tab.id}`}
      aria-label={tab.label} aria-description={tab.attention ? '有待处理事项' : undefined}
      aria-selected={selected === tab.id} tabIndex={selected === tab.id ? 0 : -1} onClick={() => onSelect(tab.id)}
      onKeyDown={event => {
        const nextKey = vertical ? 'ArrowDown' : 'ArrowRight', previousKey = vertical ? 'ArrowUp' : 'ArrowLeft';
        let next: number;
        if (event.key === nextKey) next = (index + 1) % tabs.length;
        else if (event.key === previousKey) next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault(); onSelect(tabs[next].id);
        const button = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
        button?.focus({ preventScroll: true });
        button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }}
    >{tab.icon}<span className="amsg-tab-label">{tab.lines ? tab.lines.map(line => <span key={line}>{line}</span>) : tab.label}</span>{tab.attention && <span className="amsg-tab-attention" aria-hidden="true" />}</button>)}
  </div>;
}

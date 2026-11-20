import React, { createContext, useContext, useId, useLayoutEffect, useRef } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { handleLocalBack } from '../../utils/localBackHandlers';
import './amsgSettings.css';

interface Props {
  isOpen: boolean;
  hidden?: boolean;
  title: string;
  sectionLabel?: string;
  className?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  navigation?: React.ReactNode;
}

export const SettingsPageEmbedded = createContext(false);

/** A step can remove its trigger; keep keyboard navigation in the visible page. */
export function focusSettingsBackIfNeeded(anchor: HTMLElement | null) {
  if (document.activeElement !== document.body) return;
  anchor?.closest('[role="dialog"]:not([hidden])')?.querySelector<HTMLButtonElement>('.amsg-back')?.focus({ preventScroll: true });
}

/** A settings subpage fills the app. Covered pages stay mounted to retain drafts. */
export default function SettingsDetailPage({ isOpen, hidden = false, title, className = '', sectionLabel = '主动消息 2.0', onClose, children, footer, navigation }: Props) {
  const embedded = useContext(SettingsPageEmbedded);
  const titleId = useId();
  const page = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const visible = isOpen && !hidden;
  const goBack = () => { if (!handleLocalBack()) onClose(); };
  useLocalBackHandler(() => { onClose(); return true; }, 30, visible && !embedded);
  useLayoutEffect(() => {
    if (!visible || embedded) return;
    const previous = document.activeElement as HTMLElement | null;
    back.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, [visible, embedded]);
  if (!isOpen) return null;
  return (
    <section
      ref={page}
      role={embedded ? 'region' : 'dialog'}
      aria-modal={!embedded && visible || undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : '主动消息配置内容'}
      hidden={hidden}
      {...(hidden ? { inert: '' } : {})}
      className={embedded ? 'amsg-embedded-page' : `amsg-detail-page ${className}${navigation ? ' amsg-workspace-page' : ''}`}
      onKeyDown={event => {
        if (embedded) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); goBack(); }
        if (event.key !== 'Tab') return;
        const controls = Array.from(page.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? [])
          .filter(element => element.getClientRects().length && !element.closest('[hidden], [inert]'));
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
    >
      {embedded ? (title ? <header className="amsg-embedded-header"><h2 id={titleId}>{title}</h2></header> : null) : <header className="amsg-detail-header">
        <div className="amsg-detail-header-inner">
          <button ref={back} type="button" onClick={goBack} className="amsg-back" aria-label="返回上一级">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="m14 6-6 6 6 6" /></svg>
            <span>返回</span>
          </button>
          <div className="amsg-detail-heading min-w-0">{!navigation && <p className="text-[10px] text-slate-400">系统设置 · {sectionLabel}</p>}<h2 id={titleId} className="text-base font-semibold text-slate-800">{title}</h2></div>
        </div>
      </header>}
      {navigation ? <div className="amsg-workspace">
        <aside className="amsg-sidebar">{navigation}</aside>
        <div className="amsg-workspace-content">{children}</div>
      </div> : <div className="amsg-detail-scroll"><div className="amsg-detail-content">{children}</div></div>}
      {footer && <footer className="amsg-detail-footer"><div className="flex gap-3 w-full max-w-2xl mx-auto">{footer}</div></footer>}
    </section>
  );
}

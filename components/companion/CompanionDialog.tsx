import React, { useLayoutEffect, useRef } from 'react';
import { ArrowLeft, X } from '@phosphor-icons/react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

export type CompanionToolPage = 'home' | 'camera' | 'services' | 'outing' | 'debug';

interface Props {
  title: string;
  close(): void;
  children: React.ReactNode;
  floating?: boolean;
  toolPage?: CompanionToolPage;
  dismissTools?(): void;
  focusTarget?: React.RefObject<HTMLElement>;
}

export function CompanionDialog({ title, close, children, floating = false, toolPage, dismissTools, focusTarget }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const lastPage = useRef<CompanionToolPage>();
  useLocalBackHandler(() => { close(); return true; }, 25);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useLayoutEffect(() => {
    if (!toolPage) return;
    const origin = lastPage.current;
    const target = focusTarget?.current || (toolPage === 'home' && origin ? panel.current?.querySelector<HTMLElement>(`[data-tool="${origin}"]`) : undefined);
    (target || panel.current)?.focus({ preventScroll: true });
    if (content.current) content.current.scrollTop = 0;
    target?.scrollIntoView?.({ block: 'nearest' });
    lastPage.current = toolPage;
  }, [toolPage, focusTarget]);
  const dialog = <div className="companion-sheet" data-tools-page={toolPage} role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:enabled,a[href],input:enabled,select:enabled,textarea:enabled,summary,[tabindex="0"]') || [])
        .filter(node => node.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <header>
      {toolPage !== 'home' && <button type="button" onClick={close} aria-label="返回"><ArrowLeft size={21}/></button>}
      <h2>{title}</h2>
      {toolPage && <button type="button" className="companion-tools-close" onClick={dismissTools} aria-label="回到通话"><X size={20}/></button>}
    </header>
    <div className="companion-sheet-content" ref={content}>{children}</div>
  </div>;
  if (toolPage || floating) return <div className={toolPage ? 'companion-tools-scrim' : 'companion-scrim'} onClick={event => {
    if (event.target === event.currentTarget) (dismissTools || close)();
  }}>{dialog}</div>;
  return dialog;
}

import { useLayoutEffect, useRef } from 'react';

/** Freeze only the call surface while the soft keyboard covers the phone. */
export function useCallComposerViewport(enabled = true) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!enabled || !node) return;
    const viewport = window.visualViewport;
    let composer: HTMLElement | null = null;
    let restHeight = 0, restWidth = 0, lift = 0;
    const release = () => {
      composer?.style.removeProperty('translate');
      node.style.removeProperty('height');
      node.style.removeProperty('flex');
      node.removeAttribute('data-composing');
      composer = null;
      lift = 0;
    };
    const update = () => {
      if (!composer) return;
      if (!composer.isConnected) { release(); return; }
      const rect = node.getBoundingClientRect();
      if (Math.abs(rect.width - restWidth) > 20) { release(); return; }
      const visibleBottom = Math.min(window.innerHeight, viewport ? viewport.offsetTop + viewport.height : Infinity,
        node.parentElement?.getBoundingClientRect().bottom ?? Infinity);
      const covered = rect.top + restHeight - visibleBottom;
      if (!composer.contains(document.activeElement) && covered < 4) { release(); return; }
      const bottom = composer.getBoundingClientRect().bottom + lift;
      lift = Math.max(0, bottom - visibleBottom + (covered > 4 ? 6 : 0));
      composer.style.translate = '0 ' + -lift + 'px';
    };
    const focus = (event: FocusEvent) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
      const panel = field.closest<HTMLElement>('[data-call-composer]');
      if (!panel || composer === panel) return;
      release();
      const rect = node.getBoundingClientRect();
      restWidth = rect.width;
      restHeight = rect.height;
      composer = panel;
      node.style.height = restHeight + 'px';
      node.style.flex = '0 0 auto';
      node.dataset.composing = 'true';
      update();
    };
    let frame = 0;
    const blur = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    node.addEventListener('focusin', focus);
    node.addEventListener('focusout', blur);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    if (node.parentElement) observer?.observe(node.parentElement);
    return () => {
      cancelAnimationFrame(frame); observer?.disconnect(); release();
      node.removeEventListener('focusin', focus); node.removeEventListener('focusout', blur);
      viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [enabled]);
  return root;
}

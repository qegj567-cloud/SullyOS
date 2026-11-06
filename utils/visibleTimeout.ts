/** Count foreground waiting only, using a monotonic clock rather than role/user wall time. */
export function setVisibleTimeout(callback: () => void, delay: number): () => void {
  let remaining = delay;
  let started: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const update = () => {
    clear();
    if (finished) return;
    if (started !== undefined) remaining = Math.max(0, remaining - (performance.now() - started));
    started = undefined;
    if (document.visibilityState === 'hidden') return;
    started = performance.now();
    timer = setTimeout(() => {
      // A throttled callback can run just after the page becomes hidden.
      if (document.visibilityState === 'hidden') { update(); return; }
      finished = true;
      document.removeEventListener('visibilitychange', update);
      callback();
    }, remaining);
  };
  document.addEventListener('visibilitychange', update);
  update();
  return () => { finished = true; clear(); document.removeEventListener('visibilitychange', update); };
}

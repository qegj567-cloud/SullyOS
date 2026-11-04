import { useLayoutEffect, useRef } from 'react';
import { registerLocalBackHandler } from '../utils/localBackHandlers';

/** Keep registration stable as a panel's state changes; remove it when the panel closes. */
export function useLocalBackHandler(handler: () => boolean, layer: number, enabled = true) {
  const latest = useRef(handler);
  useLayoutEffect(() => { latest.current = handler; });
  useLayoutEffect(() => {
    if (enabled) return registerLocalBackHandler(() => latest.current(), layer);
  }, [layer, enabled]);
}

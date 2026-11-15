// A cold-start notification can arrive before OSContext installs its UI listeners.
// Keep only the latest user click in memory; no chat data or network activity here.
let pending: string | undefined;
let listener: ((charId: string) => void) | undefined;

export function requestNativeNotificationOpen(charId: string): void {
  if (!charId) return;
  if (listener) listener(charId);
  else pending = charId;
}

export function subscribeNativeNotificationOpen(next: (charId: string) => void): () => void {
  listener = next;
  if (pending) {
    const charId = pending;
    pending = undefined;
    next(charId);
  }
  return () => { if (listener === next) listener = undefined; };
}

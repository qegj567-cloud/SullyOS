/** Page-local presence only. No chat records, cloud leases or persisted settings. */
const owners = new Map<string, Set<symbol>>();
const listeners = new Set<(charId: string) => void>();

export const isCompanionPresent = (charId: string) => !!owners.get(charId)?.size;

export function subscribeCompanionPresence(listener: (charId: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Ownership prevents an old surface's cleanup from releasing a newer one. */
export function holdCompanionPresence(charId: string) {
  const token = Symbol(), held = owners.get(charId) ?? new Set<symbol>();
  const wasPresent = held.size > 0;
  held.add(token); owners.set(charId, held);
  if (!wasPresent) for (const listener of listeners) listener(charId);
  return () => {
    if (!held.delete(token) || held.size) return;
    owners.delete(charId);
    for (const listener of listeners) listener(charId);
  };
}

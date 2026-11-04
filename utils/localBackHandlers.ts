type Entry = { handler: () => boolean; layer: number };
const handlers: Entry[] = [];

/** Local panels take precedence over the app's fallback. Children use a higher layer. */
export function registerLocalBackHandler(handler: () => boolean, layer: number) {
  const entry = { handler, layer };
  handlers.push(entry);
  return () => { const index = handlers.indexOf(entry); if (index >= 0) handlers.splice(index, 1); };
}
export function handleLocalBack(): boolean {
  const ordered = handlers.slice().reverse().sort((a, b) => b.layer - a.layer);
  return ordered.some(entry => handlers.includes(entry) && entry.handler());
}

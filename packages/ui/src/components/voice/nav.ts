/**
 * "Go to the assistant's Voice tab": the call card, the sidebar and the settings all send a person there, and the tab is
 * the assistant page's own state, so the request is held here until the page takes it. Said again while the page is open,
 * it is heard at once.
 */

let pending: string | null = null;
const listeners = new Set<(tab: string) => void>();

export function wantAssistantTab(tab: string): void {
  pending = tab;
  for (const listener of [...listeners]) listener(tab);
}

/** The tab asked for before the page opened, once; null when nobody asked. */
export function takeWantedTab(): string | null {
  const tab = pending;
  pending = null;
  return tab;
}

export function onWantedTab(listener: (tab: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

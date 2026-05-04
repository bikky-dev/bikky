/**
 * Destination state — module-level so apiFetch() and React can share it.
 *
 * - `selected` is the currently-active destination name, or "all" for fan-out.
 * - `null` means "use server default" (single-destination configs).
 *
 * Persisted to localStorage so the choice survives reloads.
 */

const STORAGE_KEY = "bikky.destination";

export type DestinationSelection = string | null;

export interface DestinationInfo {
  name: string;
  collection: string;
  isDefault: boolean;
}

let _selected: DestinationSelection = null;
let _options: DestinationInfo[] | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) _selected = raw;
  } catch { /* ignore */ }
}

export function getSelectedDestination(): DestinationSelection {
  return _selected;
}

export function setSelectedDestination(name: DestinationSelection): void {
  _selected = name;
  if (typeof window !== "undefined") {
    try {
      if (name === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, name);
    } catch { /* ignore */ }
  }
  for (const fn of listeners) fn();
}

export function getDestinationOptions(): DestinationInfo[] | null {
  return _options;
}

export function setDestinationOptions(opts: DestinationInfo[]): void {
  _options = opts;
  // If only one destination is configured, we never want to send ?destination=
  // — the server handles single-dest configs natively.
  if (opts.length <= 1) {
    if (_selected !== null) setSelectedDestination(null);
    else for (const fn of listeners) fn();
    return;
  }
  // Multi-destination: default to "all" if nothing was previously chosen.
  if (_selected === null) {
    setSelectedDestination("all");
    return;
  }
  // If the persisted selection no longer exists, fall back to "all".
  if (_selected !== "all" && !opts.some((o) => o.name === _selected)) {
    setSelectedDestination("all");
    return;
  }
  for (const fn of listeners) fn();
}

export function subscribeDestination(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

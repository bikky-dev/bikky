import { getSelectedDestination } from "./destinationStore";

export class ApiError extends Error {
  public code?: string;
  constructor(public status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/**
 * Append the currently-selected destination as `?destination=...` to the path.
 * No-op when nothing is selected (single-destination configs).
 */
function withDestination(path: string): string {
  const sel = getSelectedDestination();
  if (!sel) return path;
  // Don't override an explicitly-supplied destination param.
  if (/[?&]destination=/.test(path)) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}destination=${encodeURIComponent(sel)}`;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };

  const res = await fetch(withDestination(path), { ...init, headers });

  if (!res.ok) {
    let body = "";
    let code: string | undefined;
    try {
      const json = await res.json() as { error?: string; code?: string };
      body = json.error ?? JSON.stringify(json);
      code = json.code;
    } catch {
      body = await res.text().catch(() => res.statusText);
    }
    throw new ApiError(res.status, body, code);
  }

  return res.json() as Promise<T>;
}

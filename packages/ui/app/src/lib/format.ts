export function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

export const CATEGORY_COLORS: Record<string, string> = {
  codebase: "blue",
  infrastructure: "blue",
  operations: "orange",
  decisions: "purple",
  product_domain: "indigo",
  observations: "amber",
  preferences: "green",
  projects: "cyan",
  people: "pink",
  // Legacy facts may still carry pre-ontology category values.
  observation: "amber",
  team: "pink",
};

export const KIND_COLORS: Record<string, string> = {
  fact: "zinc",
  summary: "indigo",
  distilled: "violet",
  relation: "orange",
  telemetry: "red",
};

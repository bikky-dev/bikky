export interface RedactionMatch {
  type: string;
  count: number;
}

export interface RedactionSummary {
  redacted: boolean;
  summary: string;
  matches: RedactionMatch[];
}

export interface RedactionResult extends RedactionSummary {
  text: string;
}

const SECRET_PLACEHOLDER = "[REDACTED:secret]";

interface RedactionPattern {
  type: string;
  pattern: RegExp;
  replace(match: string, ...groups: string[]): string;
}

const secretPatterns: RedactionPattern[] = [
  {
    type: "secret",
    pattern: /\b((?:password|passwd|pwd|api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|private[_-]?key)\s*[:=]\s*)(?:"[^"\s,;]+"|'[^'\s,;]+'|[^\s,;]+)/gi,
    replace: (_match, prefix) => `${prefix}${SECRET_PLACEHOLDER}`,
  },
  {
    type: "secret",
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: (_match, prefix) => `${prefix}${SECRET_PLACEHOLDER}`,
  },
  {
    type: "secret",
    pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[opsur]_[A-Za-z0-9_]{20,})\b/g,
    replace: () => SECRET_PLACEHOLDER,
  },
  {
    type: "secret",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => SECRET_PLACEHOLDER,
  },
  {
    type: "secret",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => SECRET_PLACEHOLDER,
  },
];

const noRedaction = (): RedactionSummary => ({
  redacted: false,
  summary: "none",
  matches: [],
});

const summarizeMatches = (counts: Map<string, number>): RedactionSummary => {
  const matches = [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count }));

  if (matches.length === 0) return noRedaction();

  return {
    redacted: true,
    summary: matches.map((match) => `${match.type}:${match.count}`).join(","),
    matches,
  };
};

export const combineRedactions = (
  items: Array<RedactionSummary | RedactionResult | null | undefined>,
): RedactionSummary => {
  const counts = new Map<string, number>();

  for (const item of items) {
    if (!item?.redacted) continue;
    for (const match of item.matches) {
      counts.set(match.type, (counts.get(match.type) ?? 0) + match.count);
    }
  }

  return summarizeMatches(counts);
};

export const redactStorageText = (text: string): RedactionResult => {
  let redactedText = text;
  const counts = new Map<string, number>();

  for (const { type, pattern, replace } of secretPatterns) {
    redactedText = redactedText.replace(pattern, (match, ...groups: string[]) => {
      counts.set(type, (counts.get(type) ?? 0) + 1);
      return replace(match, ...groups);
    });
  }

  return {
    text: redactedText,
    ...summarizeMatches(counts),
  };
};

export const addRedactionPayload = (
  payload: Record<string, unknown>,
  summary: RedactionSummary,
): void => {
  if (summary.redacted) {
    payload["redaction"] = {
      redacted: summary.redacted,
      summary: summary.summary,
      matches: summary.matches,
    };
  }
};

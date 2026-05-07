export type UsefulnessFilter = "positive" | "needs_review" | "no_useful" | "unrated";

export interface UsefulnessSignalPayload {
  useful_count?: unknown;
  useful_feedback_count?: unknown;
  not_useful_count?: unknown;
  not_useful_feedback_count?: unknown;
  misleading_count?: unknown;
  wrong_count?: unknown;
  irrelevant_count?: unknown;
}

export interface UsefulnessMetrics {
  usefulness_score: number | null;
  usefulness_percent: number | null;
  usefulness_rated_count: number;
  useful_count: number;
  not_useful_count: number;
  misleading_count: number;
  wrong_count: number;
  irrelevant_count: number;
  needs_review: boolean;
}

export type UsefulnessSort = "usefulness_desc" | "usefulness_asc";

export const isUsefulnessSort = (value: string | undefined): value is UsefulnessSort =>
  value === "usefulness_desc" || value === "usefulness_asc";

export const parseUsefulnessFilter = (value: string | undefined): UsefulnessFilter | null => {
  if (value === "positive" || value === "needs_review" || value === "no_useful" || value === "unrated") {
    return value;
  }
  return null;
};

const countValue = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
};

const primaryOrFallbackCount = (primary: unknown, fallback: unknown): number => {
  const primaryCount = countValue(primary);
  return primaryCount > 0 ? primaryCount : countValue(fallback);
};

export const wilsonLowerBound = (positiveCount: number, ratedCount: number): number | null => {
  if (ratedCount <= 0) return null;
  const positive = Math.min(Math.max(positiveCount, 0), ratedCount);
  const n = ratedCount;
  const z = 1.96;
  const z2 = z * z;
  const phat = positive / n;
  const numerator = phat + z2 / (2 * n) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;
  return Math.max(0, numerator / denominator);
};

export const usefulnessMetrics = (payload: UsefulnessSignalPayload): UsefulnessMetrics => {
  const useful = primaryOrFallbackCount(payload.useful_count, payload.useful_feedback_count);
  const notUseful = primaryOrFallbackCount(payload.not_useful_count, payload.not_useful_feedback_count);
  const misleading = countValue(payload.misleading_count);
  const wrong = countValue(payload.wrong_count);
  const irrelevant = countValue(payload.irrelevant_count);
  const rated = useful + notUseful + misleading + wrong + irrelevant;
  const score = wilsonLowerBound(useful, rated);

  return {
    usefulness_score: score,
    usefulness_percent: score === null ? null : Math.round(score * 100),
    usefulness_rated_count: rated,
    useful_count: useful,
    not_useful_count: notUseful,
    misleading_count: misleading,
    wrong_count: wrong,
    irrelevant_count: irrelevant,
    needs_review: misleading > 0 || wrong > 0,
  };
};

export const matchesUsefulnessFilter = (metrics: UsefulnessMetrics, filter: UsefulnessFilter | null): boolean => {
  if (filter === null) return true;
  if (filter === "positive") return metrics.useful_count > 0;
  if (filter === "needs_review") return metrics.needs_review;
  if (filter === "no_useful") return metrics.usefulness_rated_count > 0 && metrics.useful_count === 0;
  return metrics.usefulness_rated_count === 0;
};

export const compareUsefulness = (
  a: Pick<UsefulnessMetrics, "usefulness_score" | "usefulness_rated_count"> & { created_at?: unknown },
  b: Pick<UsefulnessMetrics, "usefulness_score" | "usefulness_rated_count"> & { created_at?: unknown },
  sort: UsefulnessSort,
): number => {
  const aScore = a.usefulness_score;
  const bScore = b.usefulness_score;
  if (aScore === null && bScore !== null) return 1;
  if (aScore !== null && bScore === null) return -1;
  if (aScore !== null && bScore !== null && aScore !== bScore) {
    return sort === "usefulness_desc" ? bScore - aScore : aScore - bScore;
  }
  if (a.usefulness_rated_count !== b.usefulness_rated_count) {
    return b.usefulness_rated_count - a.usefulness_rated_count;
  }
  return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
};

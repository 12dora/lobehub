export interface DailyTokenPoint {
  day: string;
  tokens: number;
}

/** True when there is no series or every day is zero (new deploy / idle window). */
export const isEmptyTokenTrend = (points: DailyTokenPoint[] | undefined | null): boolean => {
  if (!points?.length) return true;
  return points.every((p) => !p.tokens);
};

/** True when ranking list is missing or all counts are zero. */
export const isEmptyRank = (
  items: Array<{ count?: number | null }> | undefined | null,
): boolean => {
  if (!items?.length) return true;
  return items.every((item) => !item.count);
};

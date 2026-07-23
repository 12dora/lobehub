export interface TopicLike {
  id: string;
  updatedAt: Date | string | number;
}

/**
 * Merge live head page with accumulated older pages.
 * Head wins on id collision; result sorted by updatedAt descending.
 */
export const mergeTopicPages = <T extends TopicLike>(head: T[], olderPages: T[][]): T[] => {
  const byId = new Map<string, T>();
  // Older first so head overwrites.
  for (const page of olderPages) {
    for (const item of page) {
      byId.set(item.id, item);
    }
  }
  for (const item of head) {
    byId.set(item.id, item);
  }
  return [...byId.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
};

/** True when two id sets share no members (possible pagination gap under fast writes). */
export const idSetsDisjoint = (a: Iterable<string>, b: Iterable<string>): boolean => {
  const setB = new Set(b);
  for (const id of a) {
    if (setB.has(id)) return false;
  }
  return true;
};

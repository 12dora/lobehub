export interface AdminFilterValues {
  [key: string]: string | undefined;
  query: string;
}

export const createEmptyAdminFilters = (keys: string[] = []): AdminFilterValues => {
  const base: AdminFilterValues = { query: '' };
  for (const key of keys) {
    if (key !== 'query') base[key] = '';
  }
  return base;
};

export const hasActiveAdminFilters = (values: AdminFilterValues): boolean =>
  Object.values(values).some((v) => Boolean(v && String(v).trim()));

export const clearAdminFilters = (values: AdminFilterValues): AdminFilterValues => {
  const next: AdminFilterValues = { query: '' };
  for (const key of Object.keys(values)) {
    next[key] = key === 'query' ? '' : '';
  }
  return next;
};

/** Simple client-side filter helper for list pages before server filters land. */
export const matchAdminFilterQuery = (
  haystack: string | null | undefined,
  query: string,
): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (haystack ?? '').toLowerCase().includes(q);
};

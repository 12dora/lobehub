export interface AdminFilterValues {
  [key: string]: string | undefined;
  /**
   * ISO date strings for created range (empty string when unset).
   * Kept as strings so FilterBar can treat all values uniformly for Clear.
   */
  createdFrom?: string;
  createdTo?: string;
  query: string;
  role?: string;
  status?: string;
}

export const createEmptyAdminFilters = (keys: string[] = []): AdminFilterValues => {
  const base: AdminFilterValues = {
    createdFrom: '',
    createdTo: '',
    query: '',
    role: '',
    status: '',
  };
  for (const key of keys) {
    if (!(key in base)) base[key] = '';
  }
  return base;
};

export const hasActiveAdminFilters = (values: AdminFilterValues): boolean =>
  Object.values(values).some((v) => Boolean(v && String(v).trim()));

export const clearAdminFilters = (values: AdminFilterValues): AdminFilterValues => {
  const next: AdminFilterValues = { query: '' };
  for (const key of Object.keys(values)) {
    next[key] = '';
  }
  return next;
};

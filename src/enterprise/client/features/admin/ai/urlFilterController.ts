export interface UrlBackedTextFilter {
  draft: string;
  /** URL value that was current when this draft was authored. */
  source: string;
}

export const createUrlBackedTextFilter = (urlValue: string): UrlBackedTextFilter => ({
  draft: urlValue,
  source: urlValue,
});

export const editUrlBackedTextFilter = (
  draft: string,
  currentUrlValue: string,
): UrlBackedTextFilter => ({ draft, source: currentUrlValue });

export const syncUrlBackedTextFilter = (
  state: UrlBackedTextFilter,
  urlValue: string,
): UrlBackedTextFilter =>
  state.draft === urlValue && state.source === urlValue
    ? state
    : createUrlBackedTextFilter(urlValue);

/** Null means no URL write; stale drafts from Back/Forward can never overwrite the new URL. */
export const resolveUrlBackedTextCommit = (
  state: UrlBackedTextFilter,
  currentUrlValue: string,
): string | undefined | null => {
  if (state.source !== currentUrlValue) return null;
  const next = state.draft.trim();
  if (next === currentUrlValue) return null;
  return next || undefined;
};

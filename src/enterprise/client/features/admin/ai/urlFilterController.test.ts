import { describe, expect, it } from 'vitest';

import {
  createUrlBackedTextFilter,
  editUrlBackedTextFilter,
  resolveUrlBackedTextCommit,
  syncUrlBackedTextFilter,
} from './urlFilterController';

describe('AI catalog URL-backed filters', () => {
  it('commits user edits only against the URL source they were authored from', () => {
    const edited = editUrlBackedTextFilter(' new value ', 'old');
    expect(resolveUrlBackedTextCommit(edited, 'old')).toBe('new value');
    expect(resolveUrlBackedTextCommit(edited, 'deep-link')).toBeNull();
  });

  it('syncs Back/Forward and deep-link values without retaining a stale draft', () => {
    const stale = editUrlBackedTextFilter('stale pending text', 'first');
    const synced = syncUrlBackedTextFilter(stale, 'history-value');
    expect(synced).toEqual(createUrlBackedTextFilter('history-value'));
    expect(resolveUrlBackedTextCommit(stale, 'history-value')).toBeNull();
    expect(resolveUrlBackedTextCommit(synced, 'history-value')).toBeNull();
  });

  it('clears the URL for whitespace-only input', () => {
    expect(resolveUrlBackedTextCommit(editUrlBackedTextFilter('   ', 'query'), 'query')).toBe(
      undefined,
    );
  });
});

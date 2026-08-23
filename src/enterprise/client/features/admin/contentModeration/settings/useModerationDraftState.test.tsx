// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';

import type { ContentModerationSettingsView } from '@/types/platform/contentModeration';
import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import { useModerationDraftState } from './useModerationDraftState';

/** `mode` is the top-level field an admin actually flips, so it stands in for "an edit" here. */
const settings = (
  revision: number,
  mode: ContentModerationSettingsView['mode'] = 'off',
): ContentModerationSettingsView =>
  ({
    ...createDefaultContentModerationConfig(),
    mode,
    revision,
    updatedAt: new Date('2026-08-23T00:00:00.000Z'),
    updatedBy: null,
  }) as unknown as ContentModerationSettingsView;

type Bundle = { settings: ContentModerationSettingsView } | undefined;

/**
 * The adoption effect is the one place this hook reads state to decide whether to write it, so it
 * is the one place a `setDraft` updater could be tempted to carry side effects along with the
 * decision. These cases pin the contract that decision has to keep: adopt only into an empty
 * editor, stamp the baseline from the bundle actually adopted, and never overwrite local edits.
 */
describe('useModerationDraftState snapshot adoption', () => {
  it('holds an empty editor until a bundle arrives, then adopts it', () => {
    const { rerender, result } = renderHook((data: Bundle) => useModerationDraftState(data), {
      initialProps: undefined as Bundle,
    });

    expect(result.current.draft).toBeNull();
    expect(result.current.baseRevision).toBeNull();

    rerender({ settings: settings(7, 'enforce') });

    expect(result.current.draft?.config.mode).toBe('enforce');
    expect(result.current.baseRevision).toBe(7);
    // The baseline was taken from the same bundle that became the draft, so it reads clean.
    expect(result.current.dirty).toBe(false);
  });

  it('never replaces a draft the admin has already edited, however many bundles arrive', () => {
    const { rerender, result } = renderHook((data: Bundle) => useModerationDraftState(data), {
      initialProps: { settings: settings(1, 'off') } as Bundle,
    });

    expect(result.current.baseRevision).toBe(1);

    act(() => result.current.patch({ mode: 'enforce' }));
    expect(result.current.draft?.config.mode).toBe('enforce');

    // A later revalidation of the same query must not throw the local edit away, and must not
    // move the concurrency token the edit will be saved against.
    rerender({ settings: settings(2, 'off') });

    expect(result.current.draft?.config.mode).toBe('enforce');
    expect(result.current.baseRevision).toBe(1);
    expect(result.current.dirty).toBe(true);
  });

  it('adopts once under StrictMode, with the baseline agreeing with the adopted draft', () => {
    // StrictMode double-invokes render and effects. Adoption has to survive that with one
    // consistent outcome — which is why the decision no longer lives inside a `setDraft` updater,
    // where React is free to run it twice and would have replayed its side effects with it.
    const { result } = renderHook((data: Bundle) => useModerationDraftState(data), {
      initialProps: { settings: settings(9, 'enforce') } as Bundle,
      wrapper: StrictMode,
    });

    expect(result.current.draft?.config.mode).toBe('enforce');
    expect(result.current.baseRevision).toBe(9);
    expect(result.current.dirty).toBe(false);
  });
});

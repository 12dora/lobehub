'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import type { ContentModerationSettingsView } from '@/types/platform/contentModeration';

import type { ConfigValidationMessage } from '../configErrors';
import {
  fingerprintDraftBase,
  fingerprintKeywords,
  type ModerationConfigView,
  type ModerationSettingsDraft,
  toDraft,
} from './draft';

/** One place the baseline fingerprint is produced, so adopt/save/reload can never disagree. */
const draftFingerprint = (draft: ModerationSettingsDraft): string =>
  `${fingerprintDraftBase(draft)}|${fingerprintKeywords(draft.config.keywords)}`;

/**
 * The editor document: the draft itself, its optimistic-concurrency token, and the dirty check.
 *
 * The keyword list is allowed to hold 10,000 rules, so its expensive derivations run against a
 * DEFERRED copy of the array — that deferral is what keeps typing in a rule responsive, and it is
 * why "is this form dirty" is a tri-state rather than a boolean.
 */
export const useModerationDraftState = (data?: { settings: ContentModerationSettingsView }) => {
  const [draft, setDraft] = useState<ModerationSettingsDraft | null>(null);
  // Internal optimistic-concurrency token echoed back on save — never displayed to the admin.
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [importText, setImportText] = useState('');
  const [fieldError, setFieldError] = useState<ConfigValidationMessage | null>(null);
  const baselineRef = useRef<string>('');
  /**
   * The freshest draft, readable from an effect without making `draft` a dependency of it.
   * Assigned during render, so it is already current by the time effects run.
   */
  const draftRef = useRef<ModerationSettingsDraft | null>(null);
  draftRef.current = draft;

  /**
   * Replace the whole editor from an authoritative server payload (first load, save, reload).
   *
   * The baseline is recomputed from the SAME object that becomes the draft, so the base and
   * keyword halves of the fingerprint always move together — a baseline taken from one array while
   * the deferred copy still held another is what produced a transient "unsaved changes" flash.
   */
  const applySnapshot = useCallback((bundle: { settings: ContentModerationSettingsView }) => {
    const next = toDraft(bundle.settings);
    baselineRef.current = draftFingerprint(next);
    setDraft(next);
    setBaseRevision(bundle.settings.revision);
    setConflict(false);
    setFieldError(null);
  }, []);

  /**
   * Adopt the server snapshot only while there is nothing local to lose.
   *
   * The "is there a local draft" test reads the ref rather than deciding inside a `setDraft`
   * updater. An updater has to be pure: React is free to run it more than once for one commit
   * (StrictMode does exactly that), and this one used to write `baselineRef` and queue
   * `setBaseRevision` from inside — side effects that would then run twice, and could stamp the
   * baseline from a bundle that never became the draft.
   */
  useEffect(() => {
    if (!data || draftRef.current !== null) return;
    const next = toDraft(data.settings);
    baselineRef.current = draftFingerprint(next);
    setDraft(next);
    setBaseRevision(data.settings.revision);
  }, [data]);

  /**
   * The keyword list is allowed to hold 10,000 rules, so its two expensive derivations —
   * serialization for the dirty check and rule validation — run against a DEFERRED copy of the
   * array. Typing in a rule commits the edit at normal priority (the input stays responsive) and
   * React re-runs these at low priority once typing settles; 保存 simply enables a beat later.
   */
  const deferredKeywords = useDeferredValue(draft?.config.keywords);
  /**
   * True while the deferred copy is behind the live rule array. During that window the keyword
   * fingerprint and the keyword issues describe the PREVIOUS rules, so mixing them with the
   * up-to-date base state would let an already-dirty form save a rule that has not been validated
   * yet. Writes are held until the low-priority pass catches up (usually the next frame).
   */
  const keywordsPending = Boolean(draft) && deferredKeywords !== draft?.config.keywords;
  const baseFingerprint = useMemo(() => (draft ? fingerprintDraftBase(draft) : ''), [draft]);
  const keywordFingerprint = useMemo(
    () => (deferredKeywords ? fingerprintKeywords(deferredKeywords) : ''),
    [deferredKeywords],
  );
  const currentFingerprint = `${baseFingerprint}|${keywordFingerprint}`;
  /**
   * Real config changes — the only thing 保存 should ever write.
   *
   * While the keyword pass is pending the fingerprint mixes a fresh base half with a stale keyword
   * half, so it is not authoritative; treat the form as not-yet-saveable rather than as clean
   * (a false "clean" right after a snapshot adoption is exactly the transient dirty/clean flash
   * this guard removes).
   */
  const configDirty =
    draft && !keywordsPending ? currentFingerprint !== baselineRef.current : false;
  /**
   * An unapplied batch-import paste is unsaved work too, so the leave guard covers it — but it
   * must not enable 保存, which would otherwise commit an unchanged document and bump the revision.
   */
  const dirty = configDirty || importText.length > 0;

  const patch = useCallback((next: Partial<ModerationConfigView>) => {
    setDraft((current) =>
      current ? { ...current, config: { ...current.config, ...next } } : current,
    );
  }, []);

  const setAddedKeys = useCallback((keys: string[]) => {
    setDraft((current) => (current ? { ...current, addedApiKeys: keys } : current));
  }, []);

  return {
    applySnapshot,
    baseRevision,
    configDirty,
    conflict,
    deferredKeywords,
    dirty,
    draft,
    fieldError,
    importText,
    keywordsPending,
    patch,
    setAddedKeys,
    setConflict,
    setFieldError,
    setImportText,
  };
};

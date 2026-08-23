'use client';

import { toast } from '@lobehub/ui/base-ui';
import type { MutableRefObject } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminNetworkProxySettings } from '@/enterprise/client/services/adminNetworkProxy';

import { runAdminMutation } from '../primitives/runAdminMutation';
import {
  isRevisionConflict,
  networkProxyErrorKey,
  networkProxyIssueKey,
  NetworkProxyLocalError,
} from './errors';
import type {
  NetworkProxyEntry,
  NetworkProxyFieldId,
  NetworkProxySettingsStore,
} from './networkProxyActionTypes';

export interface UseNetworkProxyEntriesOptions {
  authMethod?: AdminReauthAuthMethod | null;
  settings: NetworkProxySettingsStore;
}

export interface NetworkProxyEntries {
  conflicts: NetworkProxyFieldId[];
  dismiss: (field: NetworkProxyFieldId) => void;
  dismissAll: () => void;
  entryOf: (field: NetworkProxyFieldId) => NetworkProxyEntry | undefined;
  isBusy: (field: NetworkProxyFieldId) => boolean;
  /**
   * The freshest bundle any write must be expressed against. It is a ref rather than state
   * because a conflict retry has to read the winning revision *now*, not after a re-render.
   */
  latestRef: MutableRefObject<AdminNetworkProxySettings | undefined>;
  retry: (field: NetworkProxyFieldId) => Promise<void>;
  retryAll: () => Promise<void>;
  /**
   * Shared runner: reauth retry, conflict routing, per-field draft + failure state.
   * `draft` is `undefined` for tasks that are not a field edit (install, restart, tests).
   */
  runField: (field: string, draft: unknown, run: () => Promise<void>) => Promise<boolean>;
  valueOf: <T>(field: NetworkProxyFieldId, serverValue: T) => T;
}

/**
 * Per-field write state for the whole 网络代理 tab.
 *
 * Failure state lives per field: a successful write to one control can never clear, hide or
 * disarm another control's pending conflict, and the admin's chosen value stays on screen until
 * the write commits or they dismiss it.
 */
export const useNetworkProxyEntries = ({
  authMethod,
  settings,
}: UseNetworkProxyEntriesOptions): NetworkProxyEntries => {
  const { t } = useTranslation('admin');
  const [entries, setEntries] = useState<Record<string, NetworkProxyEntry | undefined>>({});
  const latestRef = useRef<AdminNetworkProxySettings | undefined>(settings.data);
  // Never let a stale render regress the revision a pending retry would send.
  if (
    settings.data &&
    (!latestRef.current || settings.data.revision >= latestRef.current.revision)
  ) {
    latestRef.current = settings.data;
  }

  const setEntry = useCallback((field: string, entry: NetworkProxyEntry | undefined) => {
    // Per-field merge: a write finishing here must not touch any other field's state.
    setEntries((current) => ({ ...current, [field]: entry }));
  }, []);

  const entryOf = useCallback((field: string) => entries[field], [entries]);

  const isBusy = useCallback((field: string) => entries[field]?.status === 'pending', [entries]);

  const valueOf = useCallback(
    <T>(field: string, serverValue: T): T => {
      const entry = entries[field];
      // A committed write has no draft — the server bundle is authoritative again.
      return entry && entry.status !== 'success' && 'draft' in entry
        ? (entry.draft as T)
        : serverValue;
    },
    [entries],
  );

  const dismiss = useCallback(
    (field: string) => {
      setEntry(field, undefined);
    },
    [setEntry],
  );

  const dismissAll = useCallback(() => {
    setEntries((current) => {
      const next: Record<string, NetworkProxyEntry | undefined> = {};
      for (const [field, entry] of Object.entries(current)) {
        // Keep in-flight work; only unresolved failures are dismissible.
        if (entry?.status === 'pending') next[field] = entry;
      }
      return next;
    });
  }, []);

  /** Self-reference for the retry closure without a cyclic `useCallback` dependency. */
  const runFieldRef = useRef<
    ((field: string, draft: unknown, run: () => Promise<void>) => Promise<boolean>) | null
  >(null);

  const runField = useCallback(
    async (field: string, draft: unknown, run: () => Promise<void>): Promise<boolean> => {
      const withDraft = (entry: NetworkProxyEntry): NetworkProxyEntry =>
        draft === undefined ? entry : { ...entry, draft };
      const retryEntry = async () => {
        await runFieldRef.current?.(field, draft, run);
      };

      setEntry(field, withDraft({ status: 'pending' }));
      const ok = await runAdminMutation({
        authMethod,
        onError: async (error) => {
          if (isRevisionConflict(error)) {
            // Reload so the retry carries the winning revision; the draft stays on screen.
            // A failing reload must NOT leave the control stuck on `pending` with no way out —
            // the field still becomes a recoverable conflict, it just cannot promise the retry
            // will carry the winning revision yet.
            let reloadFailed = false;
            try {
              const fresh = await settings.reload();
              if (fresh) latestRef.current = fresh;
            } catch {
              reloadFailed = true;
            }
            setEntry(
              field,
              withDraft({
                errorKey: reloadFailed
                  ? 'networkProxy.conflict.reloadFailed'
                  : 'networkProxy.conflict.field',
                retry: retryEntry,
                status: 'conflict',
              }),
            );
            return;
          }
          const errorKey = networkProxyErrorKey(error);
          // The engine answers with a code; the panel never renders the raw text behind it.
          const detailKey =
            error instanceof NetworkProxyLocalError
              ? networkProxyIssueKey(error.issueCode)
              : undefined;
          setEntry(field, withDraft({ detailKey, errorKey, retry: retryEntry, status: 'error' }));
          toast.error(t(errorKey as never));
        },
        run,
      });
      // Success drops the draft (and only this field's state) so the server value takes over.
      if (ok) setEntry(field, { status: 'success' });
      return ok;
    },
    [authMethod, setEntry, settings, t],
  );
  runFieldRef.current = runField;

  const retry = useCallback(
    async (field: string) => {
      await entries[field]?.retry?.();
    },
    [entries],
  );

  const conflicts = useMemo(
    () =>
      Object.entries(entries)
        .filter(([, entry]) => entry?.status === 'conflict')
        .map(([field]) => field),
    [entries],
  );

  const retryAll = useCallback(async () => {
    // Snapshot first: each retry rewrites `entries`, and they must run one at a time so two
    // writes never race for the same revision.
    const pending = Object.entries(entries)
      .filter(([, entry]) => entry?.status === 'conflict')
      .map(([, entry]) => entry?.retry);
    for (const run of pending) {
      if (run) await run();
    }
  }, [entries]);

  return {
    conflicts,
    dismiss,
    dismissAll,
    entryOf,
    isBusy,
    latestRef,
    retry,
    retryAll,
    runField,
    valueOf,
  };
};

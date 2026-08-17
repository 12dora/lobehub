'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminNetworkProxyConnectivity,
  AdminNetworkProxyNodeList,
  AdminNetworkProxyService,
  AdminNetworkProxySettings,
  AdminNetworkProxySettingsMutation,
} from '@/enterprise/client/services/adminNetworkProxy';
import { adminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';
import type {
  EgressScopeOp,
  NetworkProxyArtifactKind,
  NetworkProxyConfigUpdate,
  SubscriptionCreate,
  SubscriptionUpdate,
} from '@/types/platform/networkProxy';

import { runAdminMutation } from '../primitives/runAdminMutation';
import { isRevisionConflict, networkProxyErrorKey, NetworkProxyLocalError } from './errors';
import {
  invalidateNetworkProxyEngine,
  invalidateNetworkProxyNodes,
  invalidateNetworkProxySubscriptions,
} from './hooks';

/**
 * Field ids. Every instant-save control owns one, so a failure on one control never disables,
 * clears or rolls back another. Ids are stable strings because scope / subscription / node fields
 * are keyed by a runtime id.
 */
export const NETWORK_PROXY_FIELDS = {
  bypassHosts: 'bypassHosts',
  connectivity: 'connectivity',
  downloadViaStaticProxy: 'downloadViaStaticProxy',
  install: (kind: NetworkProxyArtifactKind) => `install:${kind}`,
  latency: 'latency',
  master: 'master',
  nodeLatency: (nodeName: string) => `latency:${nodeName}`,
  outletKind: 'outlet.kind',
  outletLatencyInterval: 'outlet.latencyIntervalSec',
  outletLatencyUrl: 'outlet.latencyTestUrl',
  outletMode: 'outlet.mode',
  outletTolerance: 'outlet.toleranceMs',
  restart: 'restart',
  ruleMode: 'ruleMode',
  scope: (scopeId: string, part: 'enabled' | 'onUnavailable') => `scope:${scopeId}:${part}`,
  scopesBulk: 'scopes.bulk',
  selectNode: 'selectNode',
  staticProxy: 'staticProxy',
  subscription: (id: string) => `subscription:${id}`,
  subscriptionCreate: 'subscription.create',
  subscriptionUpdateViaOutlet: 'subscriptionUpdateViaOutlet',
} as const;

export type NetworkProxyFieldId = string;

/** `conflict` is an error too — it is split out because its copy and recovery differ. */
export type NetworkProxyEntryStatus = 'conflict' | 'error' | 'pending' | 'success';

export interface NetworkProxyEntry {
  /**
   * The value the admin chose, kept while the write is in flight and after it fails, so a
   * failure never silently snaps the control back to the server value (design §6).
   * Absent once the write commits — the server bundle is then the truth.
   */
  draft?: unknown;
  /** `admin` namespace key describing the failure. Set for `error` and `conflict`. */
  errorKey?: string;
  /**
   * Server-provided, already-redacted failure text (B4 redacts `local.error` before returning
   * it). Rendered in preference to `errorKey` because it names the actual cause.
   */
  errorText?: string;
  /** Re-run the exact same write against whatever revision is current now. */
  retry?: () => Promise<void>;
  status: NetworkProxyEntryStatus;
}

/** Minimal seam over the settings SWR entry so the hook is testable without SWR. */
export interface NetworkProxySettingsStore {
  /** Replace the cached bundle with the authoritative one a write returned. */
  apply: (next: AdminNetworkProxySettings) => void;
  data?: AdminNetworkProxySettings;
  /**
   * Refetch and return the winning bundle. The conflict retry uses the returned value directly
   * rather than waiting for a re-render, so a retry can never re-send the stale revision.
   */
  reload: () => Promise<AdminNetworkProxySettings | undefined>;
}

export interface UseNetworkProxyActionsOptions {
  authMethod?: AdminReauthAuthMethod | null;
  service?: AdminNetworkProxyService;
  settings: NetworkProxySettingsStore;
}

/** A settings write expressed against the *freshest* bundle, so a retry cannot resurrect stale fields. */
export type NetworkProxySettingsWrite = (
  base: AdminNetworkProxySettings,
) => Promise<AdminNetworkProxySettings>;

export interface NetworkProxyActions {
  /** Field ids whose last write lost a CAS race and is waiting for Retry. */
  conflicts: NetworkProxyFieldId[];
  /** Drop a failed write: the draft disappears and the server value is shown again. */
  dismiss: (field: NetworkProxyFieldId) => void;
  dismissAll: () => void;
  entryOf: (field: NetworkProxyFieldId) => NetworkProxyEntry | undefined;
  installArtifact: (kind: NetworkProxyArtifactKind) => Promise<void>;
  isBusy: (field: NetworkProxyFieldId) => boolean;
  lastConnectivity: AdminNetworkProxyConnectivity | null;
  latestNodes: AdminNetworkProxyNodeList | null;
  patchConfig: (
    field: NetworkProxyFieldId,
    draft: unknown,
    build: (base: AdminNetworkProxySettings) => NetworkProxyConfigUpdate,
  ) => Promise<void>;
  restartEngine: () => Promise<void>;
  /** Re-run one failed write. */
  retry: (field: NetworkProxyFieldId) => Promise<void>;
  retryAll: () => Promise<void>;
  selectNode: (nodeName: string) => Promise<void>;
  testConnectivity: () => Promise<void>;
  testLatency: (nodeName?: string) => Promise<void>;
  updateScopes: (field: NetworkProxyFieldId, draft: unknown, ops: EgressScopeOp[]) => Promise<void>;
  /** The value to render for `field`: the admin's uncommitted choice, else the server value. */
  valueOf: <T>(field: NetworkProxyFieldId, serverValue: T) => T;
}

export interface NetworkProxySubscriptionActions {
  create: (input: SubscriptionCreate) => Promise<boolean>;
  refresh: (id: string) => Promise<boolean>;
  remove: (input: { id: string; reason?: string }) => Promise<boolean>;
  update: (input: SubscriptionUpdate) => Promise<boolean>;
}

/**
 * Every write on the 网络代理 tab (design §6): instant save, no drafts to publish.
 *
 * Four rules the whole tab depends on:
 * 1. A write is a function of the freshest server bundle, never of a local draft — so a
 *    revision conflict can be retried with the winning revision without losing the admin's edit.
 * 2. The admin's chosen value stays on screen until the write commits or they dismiss it. A
 *    conflict or a 500 never snaps a switch back to the old value behind their back.
 * 3. Failure state lives per field. A successful write to one control can never clear, hide or
 *    disarm another control's pending conflict.
 * 4. Long tasks (install / restart / refresh / test) expose pending → success / error with a
 *    retry next to the control, not a toast that scrolls away.
 */
export const useNetworkProxyActions = ({
  authMethod,
  service = adminNetworkProxyService,
  settings,
}: UseNetworkProxyActionsOptions): NetworkProxyActions & {
  subscriptions: NetworkProxySubscriptionActions;
} => {
  const { t } = useTranslation('admin');
  const [entries, setEntries] = useState<Record<string, NetworkProxyEntry | undefined>>({});
  const [latestNodes, setLatestNodes] = useState<AdminNetworkProxyNodeList | null>(null);
  const [lastConnectivity, setLastConnectivity] = useState<AdminNetworkProxyConnectivity | null>(
    null,
  );
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

  /**
   * Shared runner: reauth retry, conflict routing, per-field draft + failure state.
   * `draft` is `undefined` for tasks that are not a field edit (install, restart, tests).
   */
  const runField = useCallback(
    async (field: string, draft: unknown, run: () => Promise<void>): Promise<boolean> => {
      const withDraft = (entry: NetworkProxyEntry): NetworkProxyEntry =>
        draft === undefined ? entry : { ...entry, draft };
      const retry = async () => {
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
                retry,
                status: 'conflict',
              }),
            );
            return;
          }
          const errorKey = networkProxyErrorKey(error);
          const errorText =
            error instanceof NetworkProxyLocalError ? (error.localError ?? undefined) : undefined;
          setEntry(field, withDraft({ errorKey, errorText, retry, status: 'error' }));
          toast.error(errorText ?? t(errorKey as never));
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

  const runSettingsWrite = useCallback(
    async (field: string, draft: unknown, write: NetworkProxySettingsWrite): Promise<void> => {
      await runField(field, draft, async () => {
        const base = latestRef.current;
        if (!base) throw new Error('networkProxy settings not loaded');
        const next = await write(base);
        latestRef.current = next;
        settings.apply(next);
      });
    },
    [runField, settings],
  );

  /**
   * A settings write that also kicks the answering instance. The committed revision is applied
   * either way — the desired state is stored — but `local.ok === false` puts the field in the
   * error state with the server's redacted reason and a retry, never in `success`.
   */
  const runLocalSettingsWrite = useCallback(
    async (
      field: string,
      draft: unknown,
      write: (base: AdminNetworkProxySettings) => Promise<AdminNetworkProxySettingsMutation>,
    ): Promise<void> => {
      await runField(field, draft, async () => {
        const base = latestRef.current;
        if (!base) throw new Error('networkProxy settings not loaded');
        const next = await write(base);
        latestRef.current = next;
        settings.apply(next);
        if (!next.local.ok) throw new NetworkProxyLocalError(next.local.error);
      });
    },
    [runField, settings],
  );

  const patchConfig = useCallback(
    (
      field: string,
      draft: unknown,
      build: (base: AdminNetworkProxySettings) => NetworkProxyConfigUpdate,
    ) =>
      runSettingsWrite(field, draft, (base) =>
        service.updateSettings({ config: build(base), expectedRevision: base.revision }),
      ),
    [runSettingsWrite, service],
  );

  const updateScopes = useCallback(
    (field: string, draft: unknown, ops: EgressScopeOp[]) =>
      runSettingsWrite(field, draft, (base) =>
        service.updateScopes({ expectedRevision: base.revision, ops }),
      ),
    [runSettingsWrite, service],
  );

  const installArtifact = useCallback(
    (kind: NetworkProxyArtifactKind) =>
      runLocalSettingsWrite(NETWORK_PROXY_FIELDS.install(kind), undefined, async (base) => {
        const next = await service.installArtifact({ expectedRevision: base.revision, kind });
        await invalidateNetworkProxyEngine();
        return next;
      }),
    [runLocalSettingsWrite, service],
  );

  const restartEngine = useCallback(
    () =>
      runLocalSettingsWrite(NETWORK_PROXY_FIELDS.restart, undefined, async (base) => {
        const next = await service.restartEngine({ expectedRevision: base.revision });
        await invalidateNetworkProxyEngine();
        return next;
      }),
    [runLocalSettingsWrite, service],
  );

  const selectNode = useCallback(
    (nodeName: string) =>
      runLocalSettingsWrite(NETWORK_PROXY_FIELDS.selectNode, nodeName, (base) =>
        service.selectNode({ expectedRevision: base.revision, nodeName }),
      ),
    [runLocalSettingsWrite, service],
  );

  const testLatency = useCallback(
    async (nodeName?: string) => {
      const field = nodeName
        ? NETWORK_PROXY_FIELDS.nodeLatency(nodeName)
        : NETWORK_PROXY_FIELDS.latency;
      await runField(field, undefined, async () => {
        const result = await service.testLatency(nodeName ? { nodeName } : {});
        setLatestNodes(result);
        await invalidateNetworkProxyNodes();
      });
    },
    [runField, service],
  );

  const testConnectivity = useCallback(async () => {
    await runField(NETWORK_PROXY_FIELDS.connectivity, undefined, async () => {
      const result = await service.testConnectivity();
      setLastConnectivity(result);
      // A reachable-but-failing outlet is not a transport error — surface it as a task failure.
      if (!result.ok) throw new Error('PLATFORM_NETWORK_PROXY_UNAVAILABLE');
    });
  }, [runField, service]);

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

  const runSubscription = useCallback(
    async <T>(field: string, fn: () => Promise<T>): Promise<T | null> => {
      let result: T | null = null;
      await runField(field, undefined, async () => {
        result = await fn();
        await invalidateNetworkProxySubscriptions();
      });
      return result;
    },
    [runField],
  );

  const subscriptions = useMemo<NetworkProxySubscriptionActions>(
    () => ({
      create: async (input) =>
        (await runSubscription(NETWORK_PROXY_FIELDS.subscriptionCreate, () =>
          service.createSubscription(input),
        )) !== null,
      refresh: async (id) =>
        (await runSubscription(NETWORK_PROXY_FIELDS.subscription(id), () =>
          service.refreshSubscription({ id }),
        )) !== null,
      remove: async (input) =>
        (await runSubscription(NETWORK_PROXY_FIELDS.subscription(input.id), () =>
          service.deleteSubscription(input),
        )) !== null,
      update: async (input) =>
        (await runSubscription(NETWORK_PROXY_FIELDS.subscription(input.id), () =>
          service.updateSubscription(input),
        )) !== null,
    }),
    [runSubscription, service],
  );

  return {
    conflicts,
    dismiss,
    dismissAll,
    entryOf,
    installArtifact,
    isBusy,
    lastConnectivity,
    latestNodes,
    patchConfig,
    restartEngine,
    retry,
    retryAll,
    selectNode,
    subscriptions,
    testConnectivity,
    testLatency,
    updateScopes,
    valueOf,
  };
};

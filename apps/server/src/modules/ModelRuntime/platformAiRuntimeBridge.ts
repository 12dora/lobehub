import { createHash } from 'node:crypto';

import type { ModelRuntimeHooks } from '@lobechat/model-runtime';
import type { AiProviderRuntimeState } from '@lobechat/types';
import type { EnabledAiModel, ModelSearchImplementType } from 'model-bank';

import type { LobeChatDatabase } from '@/database/type';

/**
 * Opaque identity of the credential a runtime was actually built with.
 *
 * Needed because an execution failure is observed LONG after the runtime was constructed: an
 * admin reconnect (or a token rotation) in between would otherwise let the observation land on
 * a credential that never failed — and the pinned-revision path could deterministically report
 * the CURRENT credential as dead from an execution running on an old revision.
 *
 * A truncated SHA-256 rather than the token: it travels through the OSS runtime layer and into
 * a hook closure, and it must be useless to anything but an equality check.
 */
export const digestPlatformAiCredential = (accessToken: string | undefined): string | undefined =>
  accessToken
    ? createHash('sha256').update(accessToken).digest('base64url').slice(0, 22)
    : undefined;

export interface PlatformAiExecutionModel {
  abilities?: { search?: boolean };
  modelKey: string;
  settings?: { searchImpl?: ModelSearchImplementType };
  type: string;
}

export interface PlatformAiExecutionConfig {
  allowedModels: PlatformAiExecutionModel[];
  config: Record<string, unknown>;
  keyVaults: Record<string, Record<string, string> | string | undefined>;
  providerKey: string;
  revision: number;
  runtimeProvider: string;
}

export const assertPlatformPublishedModel = (
  state: AiProviderRuntimeState,
  providerKey: string,
  modelKey: string,
  type: string,
): void => {
  const published = state.enabledAiModels.some(
    (model) =>
      model.enabled &&
      model.providerId === providerKey &&
      model.id === modelKey &&
      model.type === type,
  );
  if (!published) {
    const error = new Error('PLATFORM_AI_MODEL_NOT_PUBLISHED') as Error & {
      code: string;
      errorType: string;
    };
    error.code = 'PLATFORM_AI_MODEL_NOT_PUBLISHED';
    error.errorType = 'PLATFORM_AI_MODEL_NOT_PUBLISHED';
    throw error;
  }
};

/** Secret-free exact model reference used to resolve a historical published provider revision. */
export interface PlatformAiExactModelRef {
  modelKey: string;
  providerChecksum: string;
  providerKey: string;
  providerRevision: number;
}

export interface PlatformAiRuntimeImplementation {
  createModelAllowlistHooks: (models: PlatformAiExecutionModel[]) => ModelRuntimeHooks;
  isEnabled: () => boolean;
  /**
   * True only while the administrator has PUBLISHED 平台托管 for AI providers. The feature
   * flag alone never authorizes the platform to override a user's own configuration.
   */
  isTakeoverActive: (db: LobeChatDatabase) => Promise<boolean>;
  /**
   * Published model set of an ACTIVELY managed provider, or `null` when the provider is not
   * platform-managed right now (never published, disabled, or archived) — `null` and `[]` are
   * different answers: `[]` means "managed, nothing published yet".
   */
  listPublishedModels: (
    db: LobeChatDatabase,
    providerKey: string,
  ) => Promise<EnabledAiModel[] | null>;
  /**
   * Record that a real execution through a PLATFORM-owned credential was rejected for auth
   * reasons. Only the enterprise side knows which error types are terminal and where the
   * observation is stored; this module must never learn either.
   *
   * `credentialDigest` identifies the credential the execution actually used; the observation
   * MUST be discarded when the stored credential no longer matches it.
   *
   * Best-effort and non-blocking by contract: the chat error is re-thrown regardless.
   */
  reportExecutionAuthFailure: (params: {
    credentialDigest: string;
    db: LobeChatDatabase;
    errorType: unknown;
    providerKey: string;
  }) => Promise<void>;
  resolveExecutionConfig: (
    db: LobeChatDatabase,
    providerKey: string,
  ) => Promise<PlatformAiExecutionConfig>;
  resolveExecutionConfigAtRevision: (
    db: LobeChatDatabase,
    ref: PlatformAiExactModelRef,
  ) => Promise<PlatformAiExecutionConfig>;
  resolveRuntimeState: (params: {
    db: LobeChatDatabase;
    upstreamState: AiProviderRuntimeState;
  }) => Promise<AiProviderRuntimeState>;
}

let implementation: PlatformAiRuntimeImplementation | null = null;

const envFlagEnabled = (): boolean =>
  ['1', 'true', 'yes', 'on'].includes(
    (process.env.ENABLE_PLATFORM_MANAGED_AI ?? '').trim().toLowerCase(),
  );

const requireImplementation = (): PlatformAiRuntimeImplementation => {
  if (!implementation) throw new Error('PLATFORM_AI_RUNTIME_NOT_REGISTERED');
  return implementation;
};

export const registerPlatformAiRuntime = (next: PlatformAiRuntimeImplementation): void => {
  implementation = next;
};

export const isPlatformManagedAiEnabled = (): boolean =>
  implementation?.isEnabled() ?? envFlagEnabled();

/**
 * Stable seam for upstream (`src/`) and non-enterprise server code: "is the platform AI
 * catalog currently allowed to override this user's providers?". Never true without the
 * feature flag AND a published 平台托管 policy.
 */
export const isPlatformAiTakeoverActive = async (db: LobeChatDatabase): Promise<boolean> => {
  if (!isPlatformManagedAiEnabled()) return false;
  return requireImplementation().isTakeoverActive(db);
};

export const resolvePlatformAiExecutionConfig = (
  db: LobeChatDatabase,
  providerKey: string,
): Promise<PlatformAiExecutionConfig> =>
  requireImplementation().resolveExecutionConfig(db, providerKey);

export const resolvePlatformAiExecutionConfigAtRevision = (
  db: LobeChatDatabase,
  ref: PlatformAiExactModelRef,
): Promise<PlatformAiExecutionConfig> =>
  requireImplementation().resolveExecutionConfigAtRevision(db, ref);

export const resolvePlatformAiRuntimeState = (params: {
  db: LobeChatDatabase;
  upstreamState: AiProviderRuntimeState;
}): Promise<AiProviderRuntimeState> => {
  if (!isPlatformManagedAiEnabled()) return Promise.resolve(params.upstreamState);
  return requireImplementation().resolveRuntimeState(params);
};

export const createPlatformAiModelAllowlistHooks = (
  models: PlatformAiExecutionModel[],
): ModelRuntimeHooks => requireImplementation().createModelAllowlistHooks(models);

/**
 * Observe auth rejections of a platform-owned credential on the chat path.
 *
 * The admin console used to learn about a dead shared account only from a refresh attempt,
 * which is a no-op while the stored access token is not near expiry — so a credential the
 * provider had already stopped accepting kept showing as connected while every member's chat
 * failed with "connection expired". `onChatError` is the seam where that rejection is real.
 *
 * Two properties this hook must hold, both of them the user's problem otherwise:
 *
 * - **It never delays the failure.** `ModelRuntime.chat` AWAITS `onChatError` before re-throwing,
 *   so doing the decrypt + CAS write inline would add that latency to every terminal chat error.
 *   The report is detached; the hook returns synchronously.
 * - **It never reports a credential it did not use.** `credentialDigest` pins the observation to
 *   the exact token this runtime was built with (undefined ⇒ nothing to report on, so nothing is
 *   written — silence is always safer than marking the wrong credential dead).
 *
 * Swallows everything: an observation must never replace the chat error the caller has to see.
 */
export const createPlatformAiAuthFailureHooks = (
  db: LobeChatDatabase,
  providerKey: string,
  credentialDigest: string | undefined,
): ModelRuntimeHooks => ({
  onChatError: (error) => {
    if (!credentialDigest || !implementation || !isPlatformManagedAiEnabled()) return;
    const errorType = (error as { errorType?: unknown } | undefined)?.errorType;
    // Detached on purpose (see above). The async wrapper turns a synchronous throw from the
    // implementation into a rejection, so ONE catch covers both.
    void (async () => {
      try {
        await implementation!.reportExecutionAuthFailure({
          credentialDigest,
          db,
          errorType,
          providerKey,
        });
      } catch {
        /* best-effort observation only */
      }
    })();
  },
});

export const listPlatformPublishedModels = (
  db: LobeChatDatabase,
  providerKey: string,
): Promise<EnabledAiModel[] | null> => requireImplementation().listPublishedModels(db, providerKey);

export const getEmptyPlatformAiRuntimeState = (): AiProviderRuntimeState => ({
  enabledAiModels: [],
  enabledAiProviders: [],
  enabledChatAiProviders: [],
  enabledImageAiProviders: [],
  enabledVideoAiProviders: [],
  runtimeConfig: {},
});

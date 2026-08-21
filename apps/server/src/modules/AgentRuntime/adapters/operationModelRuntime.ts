import { type AgentState } from '@lobechat/agent-runtime';
import type { ModelRuntime } from '@lobechat/model-runtime';

import { AgentOperationModel, platformStartBindingsEqual } from '@/database/models/agentOperation';
import {
  initModelRuntimeFromDB,
  initPlatformExactModelRuntime,
  rememberModelRuntimeConversationStartMs,
} from '@/server/modules/ModelRuntime';
import {
  getPlatformAiTakeoverFlags,
  type PlatformAiExecutionConfig,
  resolvePlatformAiExecutionConfig,
  resolvePlatformAiExecutionConfigAtRevision,
} from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';

import type { RuntimeExecutorContext } from '../context';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Thrown when a platform-managed operation cannot run on its EXACT pinned model revision — a missing
 * model pin, or a call whose provider/model doesn't match the pin (M10 PR-049 · RR2-2). Stable and
 * identifier-free: it carries no keys / revision / checksum, so surfacing it never leaks catalog
 * internals. Its presence forces the LLM call (and thus the operation) to fail closed instead of
 * silently downgrading to the managed *latest* pointer.
 */
export class PlatformExactModelUnavailableError extends Error {
  constructor() {
    super('PLATFORM_MODEL_UNAVAILABLE');
    this.name = 'PlatformExactModelUnavailableError';
  }
}

/**
 * Initialize the ModelRuntime for a single LLM call within an operation (M10 PR-049 · MODEL-EXACT +
 * RR2-2).
 *
 * The operation is first classified as platform-managed or ordinary from its persisted row (the
 * `platformOperation` marker is written fail-closed at start, so it is reliably present for a real
 * platform op). A DB read error propagates — the call fails closed, never guesses.
 *
 * - Platform-managed operation → it MUST run on its EXACT pinned provider revision. A missing model
 *   pin, or a call whose provider/model differs from the pin (tamper / downgrade attempt), fails
 *   closed via {@link PlatformExactModelUnavailableError} — it NEVER drops to the managed *latest*
 *   pointer. On a match, resolve the exact historical revision the operation started on (so a v1 op
 *   keeps calling v1's provider config/credentials after v2 is published), failing closed on a
 *   missing/disabled/checksum-mismatched revision.
 * - Ordinary / builtin operation (no platform marker, or the managed-AI flag off, or an anonymous
 *   call with no trusted userId) → byte-for-byte the legacy `initModelRuntimeFromDB` path.
 */
/** The operation's own start time, when its persisted state carries a usable one. */
const persistedStartMs = (state?: AgentState | null): number | undefined => {
  const createdAt = state?.createdAt;
  if (typeof createdAt !== 'string') return undefined;
  const startedAtMs = Date.parse(createdAt);

  return Number.isFinite(startedAtMs) ? startedAtMs : undefined;
};

/**
 * The operation IS the conversation for the CLI-shaped runtimes: every LLM call of one
 * operation belongs to one upstream session, and two operations never share one. Without
 * an explicit key each call would open its own session (the seam's per-construction
 * default), which is honest but loses the multi-step context the CLI would keep.
 *
 * The session id also encodes WHEN the conversation started, so that time must be as
 * durable as the key: it is the operation's persisted `createdAt`. An operation resumed
 * after a human interruption, after the in-memory registry evicted it, after a restart,
 * or on another replica therefore keeps the SAME upstream session. Only a state with no
 * usable timestamp falls back to the first sighting in this process.
 */
const conversationOptions = (ctx: RuntimeExecutorContext, state?: AgentState | null) => {
  const conversationKey = `user:${ctx.userId}:operation:${ctx.operationId}`;
  return {
    conversationKey,
    firstSeenMs:
      persistedStartMs(state) ?? rememberModelRuntimeConversationStartMs(conversationKey),
  };
};

/**
 * Verify the operation's server-authored classification against the persisted row and, for a
 * complete platform start, return the exact model pin both runtime init and context engineering
 * must resolve. A mismatch fails closed — never the current/latest pointer.
 *
 * Pass `state` when the caller already loaded it (runtime init) so the row is not read twice.
 */
export const resolveVerifiedPlatformModelPin = async (
  ctx: RuntimeExecutorContext,
  provider: string,
  model: string,
  state?: AgentState | null,
) => {
  const resolvedState = state === undefined ? await ctx.loadAgentState?.(ctx.operationId) : state;
  const trustedClassification = resolvedState?.metadata?.platformStartClassification;
  const trustedBinding = resolvedState?.metadata?.platformStartBinding;
  const ref = ctx.userId
    ? await new AgentOperationModel(
        ctx.serverDB,
        ctx.userId,
        ctx.workspaceId,
      ).findPlatformOperationRef(ctx.operationId)
    : null;

  if (trustedClassification === 'complete') {
    if (
      ref?.classification !== 'complete' ||
      !trustedBinding ||
      !platformStartBindingsEqual(ref.platformStart, trustedBinding)
    ) {
      throw new PlatformExactModelUnavailableError();
    }
  } else if (trustedClassification === 'ordinary') {
    if (trustedBinding !== undefined || (ref && ref.classification !== 'ordinary')) {
      throw new PlatformExactModelUnavailableError();
    }
  } else if (
    trustedClassification === undefined &&
    trustedBinding === undefined &&
    (!ref || ref.classification === 'ordinary')
  ) {
    // Upgrade compatibility: operations queued or parked before RR6 have no server-authored
    // runtime classification in their saved state. They may use the legacy runtime only when the
    // owner-scoped persisted row independently proves they are ordinary (or no row exists, as with
    // older fire-and-forget starts). A complete/partial persisted platform start never reaches this
    // branch, even when the managed-Agent feature flag is now disabled.
  } else {
    throw new PlatformExactModelUnavailableError();
  }

  if (ref?.isPlatformOperation) {
    const pin = ref.modelPin;
    if (!pin || pin.providerKey !== provider || pin.modelKey !== model) {
      throw new PlatformExactModelUnavailableError();
    }
    return pin;
  }

  return null;
};

const TRANSIENT_CATALOG_RESOLUTION_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

const TRANSIENT_CATALOG_RESOLUTION_BACKOFF_MS = 10;

export const isTransientCatalogResolutionError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CATALOG_RESOLUTION_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|connection reset|ECONNREFUSED|ETIMEDOUT/i.test(message);
};

const isPlatformNotFoundError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const errCode = (error as { code?: unknown }).code;
  if (errCode === 'PLATFORM_NOT_FOUND') return true;
  return error instanceof Error && error.message === 'PLATFORM_NOT_FOUND';
};

const withTransientCatalogRetry = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (!isTransientCatalogResolutionError(error)) throw error;
    await sleep(TRANSIENT_CATALOG_RESOLUTION_BACKOFF_MS);
    return run();
  }
};

export interface ResolvedOperationPlatformExecution {
  execution: PlatformAiExecutionConfig | null;
  pin: Awaited<ReturnType<typeof resolveVerifiedPlatformModelPin>>;
  state?: AgentState | null;
}

/**
 * One catalog lookup per LLM step: the verified pin (complete platform ops) or the
 * current published pointer. Transient snapshot failures (connection reset) retry
 * once with a short backoff. `PLATFORM_NOT_FOUND` is the stable unmanaged/BYOK miss
 * and becomes `execution: null`; every other error propagates.
 *
 * The executor shares this result with context engineering and runtime init so a
 * one-shot flake cannot abort the step before the runtime path would have succeeded.
 */
export const resolveOperationPlatformExecution = async (
  ctx: RuntimeExecutorContext,
  provider: string,
  model: string,
  state?: AgentState | null,
): Promise<ResolvedOperationPlatformExecution> => {
  const resolvedState = state === undefined ? await ctx.loadAgentState?.(ctx.operationId) : state;
  if (!ctx.serverDB) return { execution: null, pin: null, state: resolvedState };

  const pin = await resolveVerifiedPlatformModelPin(ctx, provider, model, resolvedState);

  if (pin) {
    const execution = await withTransientCatalogRetry(() =>
      resolvePlatformAiExecutionConfigAtRevision(ctx.serverDB, pin),
    );
    return { execution, pin, state: resolvedState };
  }

  // Ordinary calls use the same gate `initModelRuntimeFromDB` used before the shared
  // snapshot: feature flag off → inactive flags; providers takeover off → unmanaged
  // BYOK even when the catalog still has an entry for this provider.
  const takeoverFlags = await getPlatformAiTakeoverFlags(ctx.serverDB);
  if (!takeoverFlags.providers) return { execution: null, pin, state: resolvedState };

  try {
    const execution = await withTransientCatalogRetry(() =>
      resolvePlatformAiExecutionConfig(ctx.serverDB, provider),
    );
    return { execution, pin, state: resolvedState };
  } catch (error) {
    if (isPlatformNotFoundError(error)) return { execution: null, pin, state: resolvedState };
    throw error;
  }
};

export const initOperationModelRuntime = async (
  ctx: RuntimeExecutorContext,
  provider: string,
  model: string,
  resolved?: ResolvedOperationPlatformExecution,
): Promise<ModelRuntime> => {
  const state =
    resolved && 'state' in resolved ? resolved.state : await ctx.loadAgentState?.(ctx.operationId);
  const pin =
    resolved && 'pin' in resolved
      ? resolved.pin
      : await resolveVerifiedPlatformModelPin(ctx, provider, model, state);
  if (pin) {
    return initPlatformExactModelRuntime(ctx.serverDB, ctx.userId!, pin, ctx.workspaceId, {
      ...conversationOptions(ctx, state),
      ...(resolved?.execution ? { executionConfig: resolved.execution } : {}),
    });
  }

  return initModelRuntimeFromDB(ctx.serverDB, ctx.userId!, provider, ctx.workspaceId, {
    ...conversationOptions(ctx, state),
    ...(resolved ? { executionConfig: resolved.execution } : {}),
  });
};

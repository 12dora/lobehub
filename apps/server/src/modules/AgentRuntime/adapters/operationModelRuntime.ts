import type { ModelRuntime } from '@lobechat/model-runtime';

import { AgentOperationModel } from '@/database/models/agentOperation';
import {
  initModelRuntimeFromDB,
  initPlatformExactModelRuntime,
} from '@/server/modules/ModelRuntime';

import type { RuntimeExecutorContext } from '../context';

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
export const initOperationModelRuntime = async (
  ctx: RuntimeExecutorContext,
  provider: string,
  model: string,
): Promise<ModelRuntime> => {
  const ref = ctx.userId
    ? await new AgentOperationModel(
        ctx.serverDB,
        ctx.userId,
        ctx.workspaceId,
      ).findPlatformOperationRef(ctx.operationId)
    : null;

  if (ref?.isPlatformOperation) {
    const pin = ref.modelPin;
    if (!pin || pin.providerKey !== provider || pin.modelKey !== model) {
      throw new PlatformExactModelUnavailableError();
    }
    return initPlatformExactModelRuntime(ctx.serverDB, ctx.userId!, pin, ctx.workspaceId);
  }

  return initModelRuntimeFromDB(ctx.serverDB, ctx.userId!, provider, ctx.workspaceId);
};

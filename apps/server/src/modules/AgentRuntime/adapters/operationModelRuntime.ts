import type { ModelRuntime } from '@lobechat/model-runtime';

import { AgentOperationModel } from '@/database/models/agentOperation';
import {
  initModelRuntimeFromDB,
  initPlatformExactModelRuntime,
} from '@/server/modules/ModelRuntime';

import type { RuntimeExecutorContext } from '../context';

/**
 * Initialize the ModelRuntime for a single LLM call within an operation (M10 PR-049 · MODEL-EXACT).
 *
 * When the operation carries a secret-free platform model pin whose `providerKey`/`modelKey` match
 * this call, resolve the EXACT historical provider revision the operation started on — so a v1
 * operation keeps calling v1's provider config/credentials even after the admin publishes v2 and
 * advances the current pointer, failing closed on a missing/disabled/checksum-mismatched revision.
 * For every other call (a different provider/model, an ordinary local/builtin operation, or the
 * managed-AI flag off) this is byte-for-byte the legacy `initModelRuntimeFromDB` path.
 */
export const initOperationModelRuntime = async (
  ctx: RuntimeExecutorContext,
  provider: string,
  model: string,
): Promise<ModelRuntime> => {
  const pin = ctx.userId
    ? await new AgentOperationModel(ctx.serverDB, ctx.userId, ctx.workspaceId).findPlatformModelPin(
        ctx.operationId,
      )
    : null;

  if (pin && pin.providerKey === provider && pin.modelKey === model) {
    return initPlatformExactModelRuntime(ctx.serverDB, ctx.userId!, pin, ctx.workspaceId);
  }

  return initModelRuntimeFromDB(ctx.serverDB, ctx.userId!, provider, ctx.workspaceId);
};

import type { AgentRuntimeHost } from '@lobechat/agent-runtime';

import { createConnectorApprovalReceipt } from '@/server/enterprise/services/connectorCatalog/runtimeIntegration';

import { ServerCompressionTransport } from './adapters/ServerCompressionTransport';
import { ServerLifecycleSink } from './adapters/ServerLifecycleSink';
import { ServerLLMTransport } from './adapters/ServerLLMTransport';
import { ServerMessageTransport } from './adapters/ServerMessageTransport';
import { ServerOperationStore } from './adapters/ServerOperationStore';
import { ServerStreamSink } from './adapters/ServerStreamSink';
import { ServerSubAgentTransport } from './adapters/ServerSubAgentTransport';
import { ServerToolTransport } from './adapters/ServerToolTransport';
import type { RuntimeExecutorContext } from './context';
import { buildPostProcessUrl } from './executorHelpers';

/**
 * Build the {@link AgentRuntimeHost} from the server's `RuntimeExecutorContext`:
 * wraps the concrete services (`MessageModel`, `IStreamEventManager`,
 * `TopicModel`) in transport adapters + assembles the operation context. This
 * is the "server only registers adapters" seam — package-hosted executors take
 * the host instead of the raw ctx.
 *
 * Grows as more executors migrate (tools / llm / context / blob / lifecycle
 * adapters get added here); today it covers the transport-backed lightweight
 * executors such as `finish`, `request_human_approve`, and `resolve_*`.
 */
export const buildHost = (ctx: RuntimeExecutorContext): AgentRuntimeHost => ({
  // Only present when the operation registered hooks — mirrors the prior
  // `if (ctx.hookDispatcher)` guard in the human-approve executor.
  lifecycle: ctx.hookDispatcher
    ? new ServerLifecycleSink(ctx.hookDispatcher, ctx.operationId)
    : undefined,
  operation: {
    operationId: ctx.operationId,
    stepIndex: ctx.stepIndex,
    topicId: ctx.topicId,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  },
  transports: {
    compression: ctx.userId
      ? new ServerCompressionTransport(ctx.serverDB, ctx.userId, ctx.workspaceId)
      : undefined,
    llm: ctx.userId ? new ServerLLMTransport(ctx) : undefined,
    messages: new ServerMessageTransport(ctx.messageModel, {
      createToolPluginState: async (params) => {
        const plugin = params.plugin;
        if (!plugin?.identifier || !params.tool_call_id || !ctx.userId) return;
        const state = await ctx.loadAgentState?.(ctx.operationId);
        const manifest =
          state?.operationToolSet?.manifestMap?.[plugin.identifier] ??
          state?.toolManifestMap?.[plugin.identifier];
        const agentId = state?.metadata?.agentId;
        if (!agentId) return;
        const receipt = createConnectorApprovalReceipt({
          agentId,
          identifier: plugin.identifier,
          manifest,
          operationId: ctx.operationId,
          toolCallId: params.tool_call_id,
          userId: ctx.userId,
        });
        return receipt ? { platformConnectorApprovalReceipt: receipt } : undefined;
      },
      postProcessUrl: buildPostProcessUrl(ctx),
    }),
    operationStore: new ServerOperationStore(
      ctx.serverDB,
      ctx.userId,
      ctx.workspaceId,
      ctx.topicId,
    ),
    stream: new ServerStreamSink(ctx.streamManager, ctx.operationId),
    subAgent: ctx.execSubAgent ? new ServerSubAgentTransport(ctx) : undefined,
    tools: new ServerToolTransport(ctx),
  },
});

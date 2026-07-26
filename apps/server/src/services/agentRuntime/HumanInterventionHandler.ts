import type { HumanInterventionOutcome } from '@lobechat/agent-gateway-client';
import type { AgentRuntimeContext } from '@lobechat/agent-runtime';
import type { ChatToolPayload, ToolSource } from '@lobechat/types';
import debug from 'debug';

import type { MessageModel } from '@/database/models/message';
import type { LobeChatDatabase } from '@/database/type';

import { hookDispatcher } from './hooks';

const log = debug('lobe-server:human-intervention-handler');

export interface InterventionInput {
  approvedToolCall?: any;
  humanInput?: any;
  rejectAndContinue?: boolean;
  rejectionReason?: string;
  toolMessageId?: string;
}

export interface InterventionResult {
  newState: any;
  nextContext: AgentRuntimeContext | undefined;
  outcome: InterventionOutcome;
}

export type InterventionOutcome = HumanInterventionOutcome;

const toInterventionResult = (
  state: any,
  nextContext: AgentRuntimeContext | undefined,
  outcome: InterventionOutcome,
): InterventionResult => {
  const newState = structuredClone(state);
  newState.metadata = {
    ...newState.metadata,
    interventionOutcome: {
      message:
        outcome === 'accepted'
          ? undefined
          : 'This approval is no longer current. Refresh the conversation and try again.',
      occurredAt: new Date().toISOString(),
      status: outcome,
    },
  };
  return { newState, nextContext, outcome };
};

/**
 * Owns the three branches of human intervention on a `waiting_for_human`
 * operation, mirroring `conversationControl.ts` on the client side:
 *
 * - `approveToolCalling` → write `intervention.status='approved'`, resume via
 *   `phase: 'human_approved_tool'` so the runtime short-circuits into
 *   `call_tool` with `skipCreateToolMessage: true`.
 * - `rejectAndContinueToolCalling` → write `intervention.status='rejected'`
 *   and resume via `phase: 'user_input'` once the rest of the batch is
 *   resolved, so the next LLM call treats the rejection as user feedback.
 * - `rejectToolCalling` (halt) → write `intervention.status='rejected'` and
 *   move to `status='interrupted'` with `interruption.reason='human_rejected'`.
 *
 * Each branch is a self-contained method so the routing in `process()` reads
 * top-to-bottom: detect approval, then rejection, then unsupported humanInput.
 */
export class HumanInterventionHandler {
  constructor(
    _serverDB: LobeChatDatabase,
    private readonly messageModel: MessageModel,
  ) {}

  async process(state: any, intervention: InterventionInput): Promise<InterventionResult> {
    const { humanInput, approvedToolCall, rejectAndContinue, rejectionReason, toolMessageId } =
      intervention;

    if (approvedToolCall && state.status === 'waiting_for_human') {
      return this.approve(state, approvedToolCall, toolMessageId);
    }

    if (rejectionReason && state.status === 'waiting_for_human') {
      return this.reject(state, { rejectAndContinue, rejectionReason, toolMessageId });
    }

    // human_prompt / human_select (submitToolInteraction) — out of scope for
    // this codepath; the call site treats unrecognized intervention inputs as
    // a no-op and lets the regular step loop run.
    if (humanInput) {
      return toInterventionResult(state, undefined, 'mismatch');
    }

    return toInterventionResult(state, undefined, 'stale');
  }

  private async approve(
    state: any,
    approvedToolCall: any,
    toolMessageId: string | undefined,
  ): Promise<InterventionResult> {
    if (!toolMessageId) {
      log('approve requires toolMessageId, got undefined');
      return toInterventionResult(state, undefined, 'stale');
    }

    const plugin = await this.messageModel.findMessagePlugin(toolMessageId);
    const pendingTool = (state.pendingToolsCalling ?? []).find(
      (tool: ChatToolPayload) => tool.id === approvedToolCall.id,
    ) as ChatToolPayload | undefined;
    if (
      !plugin ||
      !pendingTool ||
      typeof plugin.toolCallId !== 'string' ||
      plugin.toolCallId !== approvedToolCall.id ||
      typeof plugin.apiName !== 'string' ||
      typeof plugin.arguments !== 'string' ||
      typeof plugin.identifier !== 'string'
    ) {
      log('approve tool receipt mismatch');
      return toInterventionResult(state, undefined, !plugin || !pendingTool ? 'stale' : 'mismatch');
    }
    const persistedType = plugin.type ?? 'default';
    if (
      pendingTool.apiName !== plugin.apiName ||
      pendingTool.arguments !== plugin.arguments ||
      pendingTool.identifier !== plugin.identifier ||
      pendingTool.type !== persistedType
    ) {
      log('approve pending tool differs from persisted plugin');
      return toInterventionResult(state, undefined, 'mismatch');
    }
    const source = this.resolvePersistedToolSource(state, plugin.identifier);
    const persistedToolCall: ChatToolPayload = {
      apiName: plugin.apiName,
      arguments: plugin.arguments,
      id: plugin.toolCallId,
      identifier: plugin.identifier,
      ...(source ? { source } : {}),
      type: persistedType as ChatToolPayload['type'],
    };
    const approved = await this.messageModel.approvePendingMessagePlugin(toolMessageId);
    if (!approved) return toInterventionResult(state, undefined, 'already_consumed');

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.pendingToolsCalling = (state.pendingToolsCalling ?? []).filter(
      (t: any) => t.id !== approvedToolCall.id,
    );
    // Keep waiting_for_human while other tools remain pending; resume to
    // running when this was the last one.
    newState.status = newState.pendingToolsCalling.length > 0 ? 'waiting_for_human' : 'running';
    const connectorApprovalReceipt = (plugin.state as Record<string, unknown> | undefined)
      ?.platformConnectorApprovalReceipt;
    if (connectorApprovalReceipt) {
      newState.metadata = { ...newState.metadata, connectorApprovalReceipt };
    }

    hookDispatcher
      .dispatch(
        state.metadata?.operationId ?? '',
        'afterHumanIntervention',
        {
          action: 'approve',
          operationId: state.metadata?.operationId ?? '',
          toolCallId: persistedToolCall.id,
          userId: state.metadata?.userId,
        },
        state.metadata?._hooks,
      )
      .catch(() => {});

    return toInterventionResult(
      newState,
      {
        payload: {
          approvedToolCall: persistedToolCall,
          parentMessageId: toolMessageId,
          skipCreateToolMessage: true,
        },
        phase: 'human_approved_tool',
      },
      'accepted',
    );
  }

  private resolvePersistedToolSource = (state: any, identifier: string): ToolSource | undefined => {
    const source =
      state.operationToolSet?.sourceMap?.[identifier] ?? state.toolSourceMap?.[identifier];
    return ['builtin', 'client', 'composio', 'lobehubSkill', 'mcp'].includes(source)
      ? (source as ToolSource)
      : undefined;
  };

  private async reject(
    state: any,
    params: {
      rejectAndContinue?: boolean;
      rejectionReason: string;
      toolMessageId: string | undefined;
    },
  ): Promise<InterventionResult> {
    const { rejectAndContinue, rejectionReason, toolMessageId } = params;

    if (!toolMessageId) {
      log('reject requires toolMessageId, got undefined');
      return toInterventionResult(state, undefined, 'stale');
    }

    const rejectionContent = rejectionReason
      ? `User reject this tool calling with reason: ${rejectionReason}`
      : 'User reject this tool calling without reason';

    const plugin = await this.messageModel.findMessagePlugin(toolMessageId);
    const rejectedToolCallId = plugin?.toolCallId;
    if (
      plugin?.intervention?.kind !== 'approval' ||
      !rejectedToolCallId ||
      !(state.pendingToolsCalling ?? []).some(
        (tool: ChatToolPayload) => tool.id === rejectedToolCallId,
      )
    ) {
      return toInterventionResult(state, undefined, 'stale');
    }
    const rejected = await this.messageModel.rejectPendingMessagePlugin(toolMessageId, {
      content: rejectionContent,
      rejectedReason: rejectionReason,
    });
    if (!rejected) return toInterventionResult(state, undefined, 'already_consumed');

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.pendingToolsCalling = rejectedToolCallId
      ? (state.pendingToolsCalling ?? []).filter((t: any) => t.id !== rejectedToolCallId)
      : (state.pendingToolsCalling ?? []);

    if (rejectAndContinue) {
      return this.rejectAndContinue(state, newState, rejectionReason, rejectedToolCallId);
    }

    return this.rejectAndHalt(state, newState, rejectionReason, rejectedToolCallId);
  }

  /**
   * Persist the rejection, then either (a) wait for the remaining pending
   * tools to be resolved or (b) resume LLM once this is the last one.
   * Returning a `phase: 'user_input'` nextContext while pendingToolsCalling
   * is non-empty would cause executeStep to run runtime.step immediately,
   * resuming the LLM with an unresolved batch — see review P1.
   */
  private rejectAndContinue(
    state: any,
    newState: any,
    rejectionReason: string,
    rejectedToolCallId: string | undefined,
  ): InterventionResult {
    hookDispatcher
      .dispatch(
        state.metadata?.operationId ?? '',
        'afterHumanIntervention',
        {
          action: 'rejectAndContinue',
          operationId: state.metadata?.operationId ?? '',
          rejectionReason,
          toolCallId: rejectedToolCallId,
          userId: state.metadata?.userId,
        },
        state.metadata?._hooks,
      )
      .catch(() => {});

    if (newState.pendingToolsCalling.length > 0) {
      newState.status = 'waiting_for_human';
      return toInterventionResult(newState, undefined, 'accepted');
    }

    newState.status = 'running';
    return toInterventionResult(newState, { phase: 'user_input' }, 'accepted');
  }

  /**
   * Halt: use `interrupted` + `reason='human_rejected'` to reuse the existing
   * terminal-state plumbing (early-exit, completion hooks, etc).
   */
  private rejectAndHalt(
    state: any,
    newState: any,
    rejectionReason: string,
    rejectedToolCallId: string | undefined,
  ): InterventionResult {
    hookDispatcher
      .dispatch(
        state.metadata?.operationId ?? '',
        'onStopByHumanIntervention',
        {
          operationId: state.metadata?.operationId ?? '',
          rejectionReason,
          toolCallId: rejectedToolCallId,
          userId: state.metadata?.userId,
        },
        state.metadata?._hooks,
      )
      .catch(() => {});

    newState.status = 'interrupted';
    newState.interruption = {
      canResume: false,
      interruptedAt: new Date().toISOString(),
      reason: 'human_rejected',
    };
    return toInterventionResult(newState, undefined, 'accepted');
  }
}

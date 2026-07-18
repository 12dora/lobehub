import type { ResumeInteractionKind } from '@lobechat/types';

import type { AgentRuntimeHost } from '../transport';
import type {
  AgentEvent,
  AgentInstruction,
  AgentState,
  AnyHookEvent,
  InstructionExecutor,
} from '../types';

/**
 * Derive the SERVER-owned resume-interaction kind for a pending tool (M10 PR-049 · RR5-2), read only
 * from the server-built `state.toolManifestMap` — never a client field. A tool that declares its OWN
 * static `humanIntervention: 'always'` (e.g. lobe-agent `askUserQuestion`) is a human-ANSWER tool
 * whose result IS the human's input → `toolResult`. Everything else parked for intervention (security
 * block, `required` policy, unknown tool, allow-list miss, dynamic policy) is an approve/reject
 * decision → `approval`.
 */
const deriveResumeKind = (
  state: AgentState,
  toolPayload: { apiName?: string; identifier?: string },
): ResumeInteractionKind => {
  const manifest = toolPayload.identifier
    ? state.toolManifestMap?.[toolPayload.identifier]
    : undefined;
  const api = manifest?.api?.find((a: any) => a.name === toolPayload.apiName);
  const config = api?.humanIntervention ?? manifest?.humanIntervention;
  return config === 'always' ? 'toolResult' : 'approval';
};

/**
 * `request_human_approve` executor — pauses the operation for human tool
 * approval (Tier A — the most critical executor that requires human
 * intervention for sensitive operations).
 *
 * Uses the `StreamSink` (event + chunk channels), `LifecycleSink`
 * (`beforeHumanIntervention` hook) and `MessageTransport` (create pending tool
 * messages / look them up on resume). Behavior mirrors the previous
 * server-local implementation.
 */
export const requestHumanApprove =
  (host: AgentRuntimeHost): InstructionExecutor =>
  async (instruction, state) => {
    const { pendingToolsCalling, skipCreateToolMessage } = instruction as Extract<
      AgentInstruction,
      { type: 'request_human_approve' }
    >;
    const { operation, transports, lifecycle } = host;
    const { operationId, stepIndex, userId } = operation;

    // Publish human approval request event
    await transports.stream.publishEvent({
      data: {
        pendingToolsCalling,
        phase: 'human_approval',
        requiresApproval: true,
      },
      stepIndex,
      type: 'step_start',
    });

    // Fire-and-forget lifecycle hook (webhook configs carried via state).
    lifecycle
      ?.dispatch({
        event: {
          operationId,
          pendingTools: pendingToolsCalling.map((t: any) => ({
            apiName: t.apiName,
            identifier: t.identifier,
          })),
          stepIndex,
          userId,
        } as AnyHookEvent,
        serializedHooks: state.metadata?._hooks,
        type: 'beforeHumanIntervention',
      })
      .catch(() => {});

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.status = 'waiting_for_human';
    newState.pendingToolsCalling = pendingToolsCalling;

    // Map of toolCallId -> toolMessageId, populated either by creating fresh
    // pending tool messages or (in resumption mode) by reusing the trusted refs.
    const toolMessageIds: Record<string, string> = {};
    // Kind-tagged, server-owned resume anchors surfaced on state (RR5-2).
    const pendingHumanToolMessages: { id: string; kind: ResumeInteractionKind }[] = [];

    if (skipCreateToolMessage) {
      // Re-park (resumption) mode: the pending tool messages already exist. Their ids + server-owned
      // resume kinds are read ONLY from the TRUSTED current-turn pending set already in runtime
      // `state.messages` — server-created rows with `intervention.status='pending'` parented to THIS
      // turn's assistant message — NOT re-derived from a message query keyed by `tool_call_id`, which
      // an attacker could poison with a forged role='tool' row (same tool_call_id, backdated
      // createdAt) to inject a fabricated anchor (M10 PR-049 · RR5-1). A row is a valid anchor only
      // when it carries a server-owned `intervention.kind` (`approval` / `toolResult`); the public
      // message API strips that key from client input, so a forged row (no kind) is skipped
      // fail-closed rather than binding under a default kind.
      const messages = (state.messages ?? []) as any[];
      let currentAssistantId: string | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === 'assistant' && (m.tool_calls?.length > 0 || m.tools?.length > 0)) {
          currentAssistantId = m.id;
          break;
        }
      }
      for (const m of messages) {
        if (
          m?.role !== 'tool' ||
          m.pluginIntervention?.status !== 'pending' ||
          m.parentId !== currentAssistantId
        ) {
          continue;
        }
        const kind = m.pluginIntervention?.kind as ResumeInteractionKind | undefined;
        const toolCallId: string | undefined = m.tool_call_id ?? m.plugin?.id;
        if (!m.id || !toolCallId || (kind !== 'approval' && kind !== 'toolResult')) continue;
        toolMessageIds[toolCallId] = m.id;
        pendingHumanToolMessages.push({ id: m.id, kind });
      }
    } else {
      // Find parent assistant message. Prefer state.messages (already in
      // memory from call_llm); fall back to a query if the runtime has been
      // rehydrated without recent messages.
      let parentAssistantId: string | undefined = (state.messages ?? [])
        .slice()
        .reverse()
        .find((m: any) => m.role === 'assistant' && m.id)?.id;

      if (!parentAssistantId) {
        try {
          const dbMessages = await transports.messages.query({
            agentId: state.metadata?.agentId,
            // Group runs need groupId or the query returns no group messages, so
            // the parent-assistant fallback lookup would find nothing.
            groupId: state.metadata?.groupId,
            threadId: state.metadata?.threadId,
            topicId: state.metadata?.topicId,
          });
          parentAssistantId = dbMessages
            .slice()
            .reverse()
            .find((m: any) => m.role === 'assistant')?.id;
        } catch {
          // fall through to the missing-parent guard below
        }
      }

      if (!parentAssistantId) {
        throw new Error(
          `[request_human_approve] No assistant message found as parent for pending tool messages (op=${operationId})`,
        );
      }

      for (const toolPayload of pendingToolsCalling) {
        // Server-derived resume kind from the tool's own manifest intervention type (RR5-2); an
        // unmapped tool defaults to 'approval' (approve/reject), never a blind toolResult write.
        const kind = deriveResumeKind(state, toolPayload);
        const toolMessage = await transports.messages.createToolMessage({
          agentId: state.metadata!.agentId!,
          content: '',
          groupId: state.metadata?.groupId ?? undefined,
          parentId: parentAssistantId,
          plugin: toolPayload as any,
          // Stamp the SERVER-owned resume kind alongside the pending status so a later resume can be
          // validated against it and the operation anchor is kind-keyed (RR5-2).
          pluginIntervention: { kind, status: 'pending' },
          role: 'tool',
          threadId: state.metadata?.threadId,
          tool_call_id: toolPayload.id,
          topicId: state.metadata?.topicId,
        });

        toolMessageIds[toolPayload.id] = toolMessage.id;
        pendingHumanToolMessages.push({ id: toolMessage.id, kind });

        // Intentionally DO NOT push the empty placeholder into
        // newState.messages. When the approval resumes, the `call_tool`
        // executor (skip-create branch) appends the resolved tool message to
        // state.messages itself. Pushing a placeholder here produced two
        // entries for the same tool_call_id.
      }
    }

    // RR4-1/RR5-2: surface the SERVER-created pending tool messages (id + server-owned kind) on state
    // so the server records them as the operation's trusted, KIND-KEYED resume anchors. A resume
    // approval/tool-result must target one of these exact ids under its OWN kind — a client-forged
    // tool message (spoofed parentId / pending plugin) is never a valid anchor, and an approval id
    // can never be replayed as a tool-result.
    newState.pendingHumanToolMessages = pendingHumanToolMessages;

    // Notify frontend to display approval UI through streaming system.
    // `toolMessageIds` is a new optional field; legacy consumers ignore it.
    await transports.stream.publishChunk({
      chunkType: 'tools_calling',
      stepIndex,
      toolMessageIds,
      toolsCalling: pendingToolsCalling as any,
    });

    const events: AgentEvent[] = [
      {
        operationId,
        pendingToolsCalling,
        type: 'human_approve_required',
      },
      {
        // pendingToolsCalling is ChatToolPayload[] but AgentEventToolPending
        // expects ToolsCalling[]; intentional for frontend display.
        toolCalls: pendingToolsCalling as any,
        type: 'tool_pending',
      },
    ];

    return {
      events,
      newState,
      // No nextContext — the operation waits for human intervention.
    };
  };

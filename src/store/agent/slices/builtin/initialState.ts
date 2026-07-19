export interface BuiltinAgentSliceState {
  /** Current authenticated identity/workspace allowed to own an Inbox projection. */
  activeInboxScope?: string;
  /**
   * Builtin agent id mapping { [slug]: agentId }
   * Used to store IDs of builtin agents (page-agent, etc.)
   */
  builtinAgentIdMap: Record<string, string>;
  /** Cache scope that owns the currently projected builtin Inbox config. */
  inboxProjectionScope?: string;
}

export const initialBuiltinAgentSliceState: BuiltinAgentSliceState = {
  activeInboxScope: undefined,
  builtinAgentIdMap: {},
  inboxProjectionScope: undefined,
};

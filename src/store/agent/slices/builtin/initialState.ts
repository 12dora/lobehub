export interface BuiltinAgentSliceState {
  /**
   * Builtin agent id mapping { [slug]: agentId }
   * Used to store IDs of builtin agents (page-agent, etc.)
   */
  builtinAgentIdMap: Record<string, string>;
  /** Cache scope that owns the currently projected builtin Inbox config. */
  inboxProjectionScope?: string;
}

export const initialBuiltinAgentSliceState: BuiltinAgentSliceState = {
  builtinAgentIdMap: {},
  inboxProjectionScope: undefined,
};

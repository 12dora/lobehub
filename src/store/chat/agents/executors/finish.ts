import type { AgentEvent, AgentInstruction, InstructionExecutor } from '@lobechat/agent-runtime';

import type { AgentExecutorContext } from './shared';
import { log } from './shared';

/** Completes runtime execution. */
export const createFinishExecutor = (_context: AgentExecutorContext): InstructionExecutor => {
  return async (instruction, state) => {
    const { reason, reasonDetail } = instruction as Extract<AgentInstruction, { type: 'finish' }>;
    const sessionLogId = `${state.operationId}:${state.stepCount}`;

    log(`[${sessionLogId}] Finishing execution: (%s)`, reason);

    const newState = structuredClone(state);
    newState.lastModified = new Date().toISOString();
    newState.status = 'done';

    const events: AgentEvent[] = [{ finalState: newState, reason, reasonDetail, type: 'done' }];

    return { events, newState };
  };
};

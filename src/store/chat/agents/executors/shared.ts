import debug from 'debug';

import type { CreateAgentExecutorsContext } from './types';

export const log = debug('lobe-store:agent-executors');

export const createAgentExecutorContext = (context: CreateAgentExecutorsContext) => {
  const getOperationContext = () => {
    const operation = context.get().operations[context.operationId];
    if (!operation) {
      throw new Error(`Operation not found: ${context.operationId}`);
    }
    return operation.context;
  };

  const getEffectiveAgentId = () => {
    const opContext = getOperationContext();

    // Use subAgentId for message ownership except in sub_agent scope
    // - sub_agent scope: callAgent scenario, message.agentId should stay unchanged
    // - Other scopes with subAgentId: Group mode, message.agentId should be subAgentId
    return opContext.subAgentId && opContext.scope !== 'sub_agent'
      ? opContext.subAgentId
      : opContext.agentId;
  };

  const getMetadataForSubAgent = () => {
    const opContext = getOperationContext();

    if (opContext.scope === 'sub_agent' && opContext.subAgentId) {
      return {
        scope: opContext.scope,
        subAgentId: opContext.subAgentId,
      };
    }
    return null;
  };

  return {
    get agentConfig() {
      return context.agentConfig;
    },
    getEffectiveAgentId,
    get get() {
      return context.get;
    },
    getMetadataForSubAgent,
    getOperationContext,
    get messageKey() {
      return context.messageKey;
    },
    get metadata() {
      return context.metadata;
    },
    get operationId() {
      return context.operationId;
    },
    get parentId() {
      return context.parentId;
    },
    get skipCreateFirstMessage() {
      return context.skipCreateFirstMessage;
    },
    get toolsEngine() {
      return context.toolsEngine;
    },
  };
};

export type AgentExecutorContext = ReturnType<typeof createAgentExecutorContext>;

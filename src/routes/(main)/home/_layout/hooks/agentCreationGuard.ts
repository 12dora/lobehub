export const isAgentCreationAllowed = (params: {
  agentCreationBlocked: boolean;
  canCreate: boolean;
}): boolean => params.canCreate && !params.agentCreationBlocked;

export const runAgentCreationIfAllowed = async <Result>(params: {
  action: () => Promise<Result>;
  agentCreationBlocked: boolean;
  blockedResult: Result;
  canCreate: boolean;
}): Promise<Result> => (isAgentCreationAllowed(params) ? params.action() : params.blockedResult);

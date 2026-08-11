import debug from 'debug';

const log = debug('lobe-business-server:model-completion-failure');

export type ModelCompletionFailureReason = 'empty_completion' | 'refusal';

export interface RecordModelCompletionFailureParams {
  attempt: number;
  maxAttempts: number;
  model: string;
  operationId: string;
  operationLogId: string;
  provider: string;
  reason: ModelCompletionFailureReason;
  /**
   * The model payload only. Provider credentials and transport headers are
   * deliberately not accepted by this hook.
   */
  request: unknown;
  /** Full normalized completion output and callback evidence. */
  response: unknown;
  stepIndex: number;
  topicId?: string;
  trigger?: unknown;
  userId?: string;
  workspaceId?: string;
}

export const recordModelCompletionFailure = async (
  params: RecordModelCompletionFailureParams,
): Promise<void> => {
  const {
    attempt,
    maxAttempts,
    model,
    operationId,
    operationLogId,
    provider,
    reason,
    stepIndex,
    topicId,
    workspaceId,
  } = params;

  try {
    // The canonical operation trace already records the normalized terminal
    // ModelEmptyCompletion / ModelRefusal error and its diagnostics. Keep this
    // hook as a privacy-safe breadcrumb correlated by operation id; never log
    // the request/response payloads (or credentials) and never block execution.
    log('[%s][%d] model completion failure: %O', operationLogId, stepIndex, {
      attempt,
      maxAttempts,
      model,
      operationId,
      provider,
      reason,
      topicId,
      workspaceId,
    });
  } catch {
    // Best-effort observability must never change the terminal error path.
  }
};

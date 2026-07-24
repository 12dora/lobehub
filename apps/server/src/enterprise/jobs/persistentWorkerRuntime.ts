/**
 * Shared runtime predicate for persistent (timer-based) enterprise workers.
 *
 * Persistent pollers must only run in long-lived Node processes with a database.
 * Serverless/edge hosts (AWS Lambda, Vercel) must use a durable scheduler or queue
 * instead — starting unref timers inside request containers causes duplicate work
 * and post-request DB activity.
 */
export const isPersistentEnterpriseWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean =>
  env.NODE_ENV === 'production' &&
  env.NEXT_RUNTIME !== 'edge' &&
  env.VERCEL !== '1' &&
  !env.VERCEL_ENV &&
  !env.AWS_LAMBDA_FUNCTION_NAME &&
  Boolean(env.DATABASE_URL);

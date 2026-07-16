import { createHash } from 'node:crypto';

import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';

import type { ConnectorRuntimeRateLimiter } from './runtimeAdapter';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

/** Multi-instance atomic fixed-window limiter. Redis absence is fail-closed. */
export class SharedConnectorRuntimeRateLimiter implements ConnectorRuntimeRateLimiter {
  consume = async (scope: string): Promise<boolean> => {
    const redis = getAgentRuntimeRedisClient();
    if (!redis) return false;
    const digest = createHash('sha256').update(scope).digest('hex');
    const count = await redis.eval(
      CONSUME_SCRIPT,
      1,
      `platform:connector-runtime:rate:${digest}`,
      String(WINDOW_MS),
    );
    return Number(count) <= MAX_REQUESTS;
  };
}

export const createSharedRateLimiter = (): ConnectorRuntimeRateLimiter =>
  new SharedConnectorRuntimeRateLimiter();

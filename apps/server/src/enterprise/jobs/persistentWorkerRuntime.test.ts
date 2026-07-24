// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';

const persistentEnv = {
  DATABASE_URL: 'postgres://localhost/test',
  NODE_ENV: 'production',
} satisfies Partial<NodeJS.ProcessEnv>;

const rejectedEnvs: Partial<NodeJS.ProcessEnv>[] = [
  { ...persistentEnv, NEXT_RUNTIME: 'edge' },
  { ...persistentEnv, VERCEL: '1' },
  { ...persistentEnv, VERCEL_ENV: 'production' },
  { ...persistentEnv, AWS_LAMBDA_FUNCTION_NAME: 'serverless-handler' },
  { ...persistentEnv, NODE_ENV: 'development' },
  { NODE_ENV: 'production' }, // missing DATABASE_URL
];

describe('isPersistentEnterpriseWorkerRuntime', () => {
  it('allows a production persistent Node process', () => {
    expect(isPersistentEnterpriseWorkerRuntime(persistentEnv)).toBe(true);
    expect(isPersistentEnterpriseWorkerRuntime({ ...persistentEnv, NEXT_RUNTIME: 'nodejs' })).toBe(
      true,
    );
  });

  it.each(rejectedEnvs)('rejects serverless / edge / non-production runtimes', (env) => {
    expect(isPersistentEnterpriseWorkerRuntime(env)).toBe(false);
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isPlatformSecretRewrapWorkerRuntime } from './secretRewrap';

const persistentVaultEnv = {
  DATABASE_URL: 'postgres://localhost/test',
  NODE_ENV: 'production',
  PLATFORM_KEY_PROVIDER: 'vault',
} satisfies Partial<NodeJS.ProcessEnv>;
const rejectedEnvs: Partial<NodeJS.ProcessEnv>[] = [
  { ...persistentVaultEnv, NEXT_RUNTIME: 'edge' },
  { ...persistentVaultEnv, VERCEL: '1' },
  { ...persistentVaultEnv, VERCEL_ENV: 'production' },
  { ...persistentVaultEnv, AWS_LAMBDA_FUNCTION_NAME: 'serverless-handler' },
  { ...persistentVaultEnv, PLATFORM_KEY_PROVIDER: 'env' },
  { ...persistentVaultEnv, NODE_ENV: 'development' },
];

describe('secret rewrap persistent worker runtime gate', () => {
  it('allows a production persistent Node process without requiring Next runtime globals', () => {
    expect(isPlatformSecretRewrapWorkerRuntime(persistentVaultEnv)).toBe(true);
  });

  it.each(rejectedEnvs)('rejects serverless, non-Vault, and non-production runtimes', (env) => {
    expect(isPlatformSecretRewrapWorkerRuntime(env)).toBe(false);
  });
});

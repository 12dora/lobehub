import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const emptyStringToUndefined = (value: unknown) => (value === '' ? undefined : value);

const optionalPositiveInt = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().positive().optional(),
);

export const getSandboxConfig = () => {
  return createEnv({
    runtimeEnv: {
      ONLYBOXES_BASE_URL: process.env.ONLYBOXES_BASE_URL,
      ONLYBOXES_JIT_ISSUER: process.env.ONLYBOXES_JIT_ISSUER,
      ONLYBOXES_JIT_SIGNING_KEY: process.env.ONLYBOXES_JIT_SIGNING_KEY,
      ONLYBOXES_JIT_TTL_SEC: process.env.ONLYBOXES_JIT_TTL_SEC,
      ONLYBOXES_LEASE_TTL_SEC: process.env.ONLYBOXES_LEASE_TTL_SEC,
      SANDBOX_DOCKER_HOST: process.env.SANDBOX_DOCKER_HOST,
      SANDBOX_DOCKER_SOCKET: process.env.SANDBOX_DOCKER_SOCKET,
      SANDBOX_LOCAL_CPUS: process.env.SANDBOX_LOCAL_CPUS,
      SANDBOX_LOCAL_IDLE_TTL_SEC: process.env.SANDBOX_LOCAL_IDLE_TTL_SEC,
      SANDBOX_LOCAL_IMAGE: process.env.SANDBOX_LOCAL_IMAGE,
      SANDBOX_LOCAL_MAX_CONTAINERS: process.env.SANDBOX_LOCAL_MAX_CONTAINERS,
      SANDBOX_LOCAL_MAX_OUTPUT_BYTES: process.env.SANDBOX_LOCAL_MAX_OUTPUT_BYTES,
      SANDBOX_LOCAL_MEMORY_MB: process.env.SANDBOX_LOCAL_MEMORY_MB,
      SANDBOX_LOCAL_NETWORK: process.env.SANDBOX_LOCAL_NETWORK,
      SANDBOX_LOCAL_PIDS_LIMIT: process.env.SANDBOX_LOCAL_PIDS_LIMIT,
      SANDBOX_LOCAL_PULL_POLICY: process.env.SANDBOX_LOCAL_PULL_POLICY,
      SANDBOX_LOCAL_TIMEOUT_MS: process.env.SANDBOX_LOCAL_TIMEOUT_MS,
      SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER,
    },
    server: {
      ONLYBOXES_BASE_URL: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
      ONLYBOXES_JIT_ISSUER: z.preprocess(emptyStringToUndefined, z.string().optional()),
      ONLYBOXES_JIT_SIGNING_KEY: z.preprocess(emptyStringToUndefined, z.string().optional()),
      ONLYBOXES_JIT_TTL_SEC: optionalPositiveInt,
      ONLYBOXES_LEASE_TTL_SEC: z.preprocess(emptyStringToUndefined, z.coerce.number().optional()),
      SANDBOX_DOCKER_HOST: z.preprocess(emptyStringToUndefined, z.string().optional()),
      SANDBOX_DOCKER_SOCKET: z.preprocess(
        emptyStringToUndefined,
        z.string().default('/var/run/docker.sock'),
      ),
      SANDBOX_LOCAL_CPUS: z.preprocess(
        emptyStringToUndefined,
        z.coerce.number().positive().default(1),
      ),
      SANDBOX_LOCAL_IDLE_TTL_SEC: z.preprocess(
        emptyStringToUndefined,
        z.coerce.number().int().positive().default(1800),
      ),
      SANDBOX_LOCAL_IMAGE: z.preprocess(
        emptyStringToUndefined,
        z.string().default('aihub-sandbox:latest'),
      ),
      SANDBOX_LOCAL_MAX_CONTAINERS: z.preprocess(
        emptyStringToUndefined,
        z.coerce.number().int().positive().default(8),
      ),
      SANDBOX_LOCAL_MAX_OUTPUT_BYTES: z.preprocess(
        emptyStringToUndefined,
        z.coerce.number().int().positive().default(1_048_576),
      ),
      SANDBOX_LOCAL_MEMORY_MB: z.preprocess(
        emptyStringToUndefined,
        z.coerce.number().int().positive().default(1024),
      ),
      SANDBOX_LOCAL_NETWORK: z.preprocess(
        emptyStringToUndefined,
        z.enum(['bridge', 'none']).default('bridge'),
      ),
      SANDBOX_LOCAL_PIDS_LIMIT: z.preprocess(
        emptyStringToUndefined,
        z.coerce.number().int().positive().default(256),
      ),
      SANDBOX_LOCAL_PULL_POLICY: z.preprocess(
        emptyStringToUndefined,
        z.enum(['if-missing', 'always', 'never']).default('if-missing'),
      ),
      SANDBOX_LOCAL_TIMEOUT_MS: z.preprocess(
        emptyStringToUndefined,
        z.coerce.number().int().positive().default(120_000),
      ),
      SANDBOX_PROVIDER: z.preprocess(
        emptyStringToUndefined,
        z.enum(['local', 'market', 'onlyboxes']).default('local'),
      ),
    },
  });
};

export const sandboxEnv = getSandboxConfig();

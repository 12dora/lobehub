/**
 * Local harness state for allowlisted readiness commands.
 * Real postconditions are observable on this state file — not recursive dry-runs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const stateSchema = z
  .object({
    flags: z.record(z.string(), z.boolean()),
    metrics: z.record(z.string(), z.number()),
    schemaVersion: z.literal(1),
    windowActive: z.string().nullable(),
  })
  .strict();

export type ReadinessCommandState = z.infer<typeof stateSchema>;

export const defaultCommandState = (): ReadinessCommandState => ({
  flags: {
    'branding-cutover': false,
    'connector-shared-credentials': false,
    'default-inbox': false,
    'oidc': false,
  },
  metrics: {
    'auth-failure-rate': 0,
    'error-rate': 0,
    'job-failure-rate': 0,
    'p95-latency-ms': 0,
  },
  schemaVersion: 1,
  windowActive: null,
});

export const resolveStatePath = (baseDir: string): string =>
  path.join(baseDir, 'readiness-command-state.json');

export const loadCommandState = async (baseDir: string): Promise<ReadinessCommandState> => {
  const filePath = resolveStatePath(baseDir);
  try {
    const raw = await readFile(filePath, 'utf8');
    return stateSchema.parse(JSON.parse(raw));
  } catch {
    return defaultCommandState();
  }
};

export const saveCommandState = async (
  baseDir: string,
  state: ReadinessCommandState,
): Promise<void> => {
  await mkdir(baseDir, { recursive: true });
  const parsed = stateSchema.parse(state);
  await writeFile(resolveStatePath(baseDir), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
};

export const HIGH_RISK_FLAG_BY_COMMAND: Record<string, string> = {
  'flag-disable-branding-cutover': 'branding-cutover',
  'flag-disable-connector-shared-credentials': 'connector-shared-credentials',
  'flag-disable-default-inbox': 'default-inbox',
  'flag-disable-oidc': 'oidc',
  'flag-enable-branding-cutover': 'branding-cutover',
  'flag-enable-connector-shared-credentials': 'connector-shared-credentials',
  'flag-enable-default-inbox': 'default-inbox',
  'flag-enable-oidc': 'oidc',
};

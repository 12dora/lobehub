import { z } from 'zod';

/**
 * Platform-level local-sandbox settings (single logical row).
 *
 * When `enabled` is false (or the row is absent) the process environment is the
 * source of truth. When `enabled` is true, each stored field overrides the matching
 * env value (`DB ?? env`).
 */

export const SANDBOX_PROVIDER_KINDS = ['local', 'market', 'onlyboxes'] as const;
export type SandboxSettingsProviderKind = (typeof SANDBOX_PROVIDER_KINDS)[number];

export const SANDBOX_PULL_POLICIES = ['always', 'if-missing', 'never'] as const;
export type SandboxSettingsPullPolicy = (typeof SANDBOX_PULL_POLICIES)[number];

export const SANDBOX_NETWORKS = ['bridge', 'none'] as const;
export type SandboxSettingsNetwork = (typeof SANDBOX_NETWORKS)[number];

export interface PlatformSandboxSettings {
  cpus?: number;
  dockerHost?: string;
  dockerSocket?: string;
  /** When false, env owns every field. When true, stored fields override env. */
  enabled: boolean;
  idleTtlSec?: number;
  image?: string;
  maxContainers?: number;
  maxOutputBytes?: number;
  memoryMb?: number;
  network?: SandboxSettingsNetwork;
  pidsLimit?: number;
  provider?: SandboxSettingsProviderKind;
  pullPolicy?: SandboxSettingsPullPolicy;
  timeoutMs?: number;
}

export const DEFAULT_PLATFORM_SANDBOX_SETTINGS: PlatformSandboxSettings = {
  enabled: false,
};

const optionalPositiveInt = z.number().int().positive().optional();
const optionalPositiveNumber = z.number().positive().optional();

export const platformSandboxSettingsFields = {
  cpus: optionalPositiveNumber,
  dockerHost: z.string().trim().max(512).optional(),
  dockerSocket: z.string().trim().min(1).max(512).optional(),
  enabled: z.boolean(),
  idleTtlSec: optionalPositiveInt,
  image: z.string().trim().min(1).max(256).optional(),
  maxContainers: optionalPositiveInt,
  maxOutputBytes: optionalPositiveInt,
  memoryMb: optionalPositiveInt,
  network: z.enum(SANDBOX_NETWORKS).optional(),
  pidsLimit: optionalPositiveInt,
  provider: z.enum(SANDBOX_PROVIDER_KINDS).optional(),
  pullPolicy: z.enum(SANDBOX_PULL_POLICIES).optional(),
  timeoutMs: optionalPositiveInt,
};

export const platformSandboxSettingsSchema = z.object(platformSandboxSettingsFields).strict();

const asOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asOptionalPositiveInt = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : undefined;
};

const asOptionalPositiveNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
};

const asOptionalEnum = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => {
  if (typeof value !== 'string') return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
};

/** Coerce an unknown jsonb blob into a stored sandbox-settings document. */
export const normalizeSandboxSettings = (value: unknown): PlatformSandboxSettings => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const next: PlatformSandboxSettings = {
    enabled: raw.enabled === true,
  };
  const provider = asOptionalEnum(raw.provider, SANDBOX_PROVIDER_KINDS);
  if (provider) next.provider = provider;
  const dockerHost = asOptionalString(raw.dockerHost);
  if (dockerHost) next.dockerHost = dockerHost;
  const dockerSocket = asOptionalString(raw.dockerSocket);
  if (dockerSocket) next.dockerSocket = dockerSocket;
  const image = asOptionalString(raw.image);
  if (image) next.image = image;
  const pullPolicy = asOptionalEnum(raw.pullPolicy, SANDBOX_PULL_POLICIES);
  if (pullPolicy) next.pullPolicy = pullPolicy;
  const network = asOptionalEnum(raw.network, SANDBOX_NETWORKS);
  if (network) next.network = network;
  const memoryMb = asOptionalPositiveInt(raw.memoryMb);
  if (memoryMb !== undefined) next.memoryMb = memoryMb;
  const pidsLimit = asOptionalPositiveInt(raw.pidsLimit);
  if (pidsLimit !== undefined) next.pidsLimit = pidsLimit;
  const cpus = asOptionalPositiveNumber(raw.cpus);
  if (cpus !== undefined) next.cpus = cpus;
  const timeoutMs = asOptionalPositiveInt(raw.timeoutMs);
  if (timeoutMs !== undefined) next.timeoutMs = timeoutMs;
  const maxOutputBytes = asOptionalPositiveInt(raw.maxOutputBytes);
  if (maxOutputBytes !== undefined) next.maxOutputBytes = maxOutputBytes;
  const idleTtlSec = asOptionalPositiveInt(raw.idleTtlSec);
  if (idleTtlSec !== undefined) next.idleTtlSec = idleTtlSec;
  const maxContainers = asOptionalPositiveInt(raw.maxContainers);
  if (maxContainers !== undefined) next.maxContainers = maxContainers;
  return next;
};

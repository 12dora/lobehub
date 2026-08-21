import type { AdminSystemSandboxSettings } from '@/enterprise/client/services/adminSystem';
import type {
  AdminSystemSandboxSettingsConfig,
  AdminSystemUpdateSandboxSettingsInput,
} from '@/server/enterprise/contracts/adminSystem';

export interface SandboxDraft {
  cpus: string;
  dockerHost: string;
  dockerSocket: string;
  idleTtlSec: string;
  image: string;
  maxContainers: string;
  maxOutputBytes: string;
  memoryMb: string;
  network: 'bridge' | 'none';
  pidsLimit: string;
  provider: 'local' | 'market' | 'onlyboxes';
  pullPolicy: 'always' | 'if-missing' | 'never';
  timeoutMs: string;
}

const asString = (value: number | string | null | undefined): string =>
  value === null || value === undefined ? '' : String(value);

export const toSandboxDraft = (view: AdminSystemSandboxSettings): SandboxDraft => ({
  cpus: asString(view.cpus),
  dockerHost: view.dockerHost ?? '',
  dockerSocket: view.dockerSocket,
  idleTtlSec: asString(view.idleTtlSec),
  image: view.image,
  maxContainers: asString(view.maxContainers),
  maxOutputBytes: asString(view.maxOutputBytes),
  memoryMb: asString(view.memoryMb),
  network: view.network,
  pidsLimit: asString(view.pidsLimit),
  provider: view.provider,
  pullPolicy: view.pullPolicy,
  timeoutMs: asString(view.timeoutMs),
});

export const fingerprintSandboxDraft = (draft: SandboxDraft): string => JSON.stringify(draft);

const parsePositiveNumber = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const parsePositiveInt = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed > 0 ? parsed : undefined;
};

export const validateSandboxDraft = (draft: SandboxDraft): Record<string, string> => {
  const errors: Record<string, string> = {};
  if (draft.provider === 'local') {
    if (!draft.dockerSocket.trim()) errors.dockerSocket = 'required';
    if (!draft.image.trim()) errors.image = 'required';
    if (parsePositiveInt(draft.memoryMb) === undefined) errors.memoryMb = 'positiveInt';
    if (parsePositiveInt(draft.pidsLimit) === undefined) errors.pidsLimit = 'positiveInt';
    if (parsePositiveNumber(draft.cpus) === undefined) errors.cpus = 'positiveNumber';
    if (parsePositiveInt(draft.timeoutMs) === undefined) errors.timeoutMs = 'positiveInt';
    if (parsePositiveInt(draft.maxOutputBytes) === undefined) errors.maxOutputBytes = 'positiveInt';
    if (parsePositiveInt(draft.idleTtlSec) === undefined) errors.idleTtlSec = 'positiveInt';
    if (parsePositiveInt(draft.maxContainers) === undefined) errors.maxContainers = 'positiveInt';
  }
  return errors;
};

export const toSandboxConfig = (
  draft: SandboxDraft,
  enabled: boolean,
): AdminSystemSandboxSettingsConfig => {
  if (!enabled) return { enabled: false };
  if (draft.provider !== 'local') {
    return { enabled: true, provider: draft.provider };
  }
  return {
    cpus: parsePositiveNumber(draft.cpus),
    dockerHost: draft.dockerHost.trim() || undefined,
    dockerSocket: draft.dockerSocket.trim(),
    enabled: true,
    idleTtlSec: parsePositiveInt(draft.idleTtlSec),
    image: draft.image.trim(),
    maxContainers: parsePositiveInt(draft.maxContainers),
    maxOutputBytes: parsePositiveInt(draft.maxOutputBytes),
    memoryMb: parsePositiveInt(draft.memoryMb),
    network: draft.network,
    pidsLimit: parsePositiveInt(draft.pidsLimit),
    provider: 'local',
    pullPolicy: draft.pullPolicy,
    timeoutMs: parsePositiveInt(draft.timeoutMs),
  };
};

export const toSandboxUpdateInput = (
  draft: SandboxDraft,
  enabled: boolean,
  expectedRevision: number,
): AdminSystemUpdateSandboxSettingsInput => ({
  config: toSandboxConfig(draft, enabled),
  expectedRevision,
});

import type {
  assertMailDestinationsAllowed,
  assertObjectStorageDestinationsAllowed,
} from '../infraSettings/destinationPolicy';
import type { InfraEnvBag, ResolvedEmailConfig } from './infraDependencyConfig';
import type { CreateInfraS3Client } from './infraProbes';

export type EnvBag = InfraEnvBag;

export interface InfraMailTransport {
  close?: () => void;
  verify: () => Promise<unknown>;
}

export interface InfraOutboundFetch {
  (
    input: string | URL,
    init?: {
      headers?: Record<string, string>;
      method?: string;
      secretBearing?: boolean;
      timeoutMs?: number;
    },
  ): Promise<{ ok: boolean; status: number }>;
}

export interface InfraSettingsServiceOptions {
  assertMailDestinations?: typeof assertMailDestinationsAllowed;
  assertObjectStorageDestinations?: typeof assertObjectStorageDestinationsAllowed;
  createMailTransport?: (
    config: Extract<ResolvedEmailConfig, { kind: 'smtp' }>,
  ) => InfraMailTransport;
  createS3Client?: CreateInfraS3Client;
  env?: EnvBag;
  now?: () => Date;
  outboundFetch?: InfraOutboundFetch;
}

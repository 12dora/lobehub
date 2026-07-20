import debug from 'debug';

import type { PlatformInstanceRepository } from '@/database/repositories/platformInstance';
import { PlatformInstanceRepository as DefaultPlatformInstanceRepository } from '@/database/repositories/platformInstance';
import type { PlatformInstanceRevisionErrorCategory } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { classifyEnterpriseError } from '../../observability';
import { getPlatformInstanceId, shouldStartPlatformInstanceHeartbeat } from './heartbeatRuntime';

const log = debug('lobe-server:platform-instance-runtime');

export type PlatformRuntimeReportedDomain =
  'ai_catalog' | 'branding' | 'settings' | 'skill_catalog';

export type PlatformRuntimeMaterializationState =
  | {
      domain: PlatformRuntimeReportedDomain;
      health: 'healthy';
      revision: number;
      revisionId?: never;
      source: 'database';
    }
  | {
      domain: PlatformRuntimeReportedDomain;
      health: 'healthy';
      revision?: never;
      revisionId: string;
      source: 'database';
    }
  | {
      domain: PlatformRuntimeReportedDomain;
      errorCategory: PlatformInstanceRevisionErrorCategory;
      health: 'unavailable';
      source: 'unavailable';
    };

export type PlatformRuntimeMaterializationReporter = (
  db: LobeChatDatabase,
  state: PlatformRuntimeMaterializationState,
) => void;

interface DomainReportState {
  committedSignature?: string;
  latestSignature?: string;
  tail: Promise<void>;
}

interface RuntimeReporterProcessState {
  domains: Map<PlatformRuntimeReportedDomain, DomainReportState>;
}

const runtimeReporterProcess = process as NodeJS.Process & {
  __lobehubPlatformRuntimeReporterState?: RuntimeReporterProcessState;
};

const processState = (): RuntimeReporterProcessState =>
  (runtimeReporterProcess.__lobehubPlatformRuntimeReporterState ??= { domains: new Map() });

const domainState = (domain: PlatformRuntimeReportedDomain): DomainReportState => {
  const state = processState();
  const existing = state.domains.get(domain);
  if (existing) return existing;
  const created: DomainReportState = { tail: Promise.resolve() };
  state.domains.set(domain, created);
  return created;
};

const signatureOf = (state: PlatformRuntimeMaterializationState): string =>
  state.health === 'healthy'
    ? 'revisionId' in state
      ? `${state.health}|${state.source}|immutable_id:${state.revisionId}`
      : `${state.health}|${state.source}|revision:${state.revision}`
    : `${state.health}|${state.source}|${state.errorCategory}`;

const isImmutableId = (value: string | undefined): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export interface RuntimeReporterFailureObservation {
  domain: PlatformRuntimeReportedDomain;
  errorClass: ReturnType<typeof classifyEnterpriseError>;
}

export interface PlatformRuntimeReporterOptions {
  createRepository?: (
    db: LobeChatDatabase,
  ) => Pick<PlatformInstanceRepository, 'upsertRevisionState'>;
  env?: Record<string, string | undefined>;
  getInstanceId?: () => string;
  observeFailure?: (event: RuntimeReporterFailureObservation) => void;
}

const defaultObserveFailure = ({ domain, errorClass }: RuntimeReporterFailureObservation): void => {
  log('revision state unavailable domain=%s errorClass=%s', domain, errorClass);
};

const observeFailureSafely = (
  observer: NonNullable<PlatformRuntimeReporterOptions['observeFailure']>,
  event: RuntimeReporterFailureObservation,
): void => {
  try {
    observer(event);
  } catch {
    console.error('[platform-instance-runtime] failure observer unavailable');
  }
};

/** Fixed convergence category mapping; raw database errors never enter persisted state or logs. */
export const classifyRuntimeMaterializationError = (
  error: unknown,
): PlatformInstanceRevisionErrorCategory => {
  switch (classifyEnterpriseError(error)) {
    case 'UnavailableError':
    case 'TimeoutError': {
      return 'database_unavailable';
    }
    case 'ValidationError': {
      return 'configuration_invalid';
    }
    default: {
      return 'load_failed';
    }
  }
};

/**
 * Non-blocking process reporter. Writes are serialized per closed domain, and only the latest
 * semantic signature is retained; revisions never accumulate in a process-global map.
 */
export const reportPlatformRuntimeMaterialization = (
  db: LobeChatDatabase,
  input: PlatformRuntimeMaterializationState,
  options: PlatformRuntimeReporterOptions = {},
): void => {
  if (!shouldStartPlatformInstanceHeartbeat(options.env ?? process.env)) return;
  if (input.health === 'healthy') {
    if ('revisionId' in input) {
      if (!isImmutableId(input.revisionId)) return;
    } else if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
      return;
    }
  }

  const state = domainState(input.domain);
  const signature = signatureOf(input);
  if (state.latestSignature === signature) return;
  state.latestSignature = signature;

  state.tail = state.tail.then(async () => {
    if (state.committedSignature === signature) return;
    try {
      const repository = options.createRepository
        ? options.createRepository(db)
        : new DefaultPlatformInstanceRepository(db);
      await repository.upsertRevisionState({
        domain: input.domain,
        errorCategory: input.health === 'unavailable' ? input.errorCategory : null,
        health: input.health,
        instanceId: (options.getInstanceId ?? getPlatformInstanceId)(),
        loadedRevision:
          input.health === 'healthy' && !('revisionId' in input) ? input.revision : null,
        loadedRevisionId:
          input.health === 'healthy' && 'revisionId' in input ? input.revisionId : null,
        loadMode: 'process_cached',
        source: input.source,
      });
      state.committedSignature = signature;
    } catch (error) {
      if (state.latestSignature === signature) {
        state.latestSignature = state.committedSignature;
      }
      observeFailureSafely(options.observeFailure ?? defaultObserveFailure, {
        domain: input.domain,
        errorClass: classifyEnterpriseError(error),
      });
    }
  });
};

/** Protects runtime materialization from a replaced/test observer that violates the no-throw seam. */
export const reportPlatformRuntimeMaterializationSafely = (
  reporter: PlatformRuntimeMaterializationReporter,
  db: LobeChatDatabase,
  state: PlatformRuntimeMaterializationState,
): void => {
  try {
    reporter(db, state);
  } catch {
    console.error('[platform-instance-runtime] reporter unavailable');
  }
};

export const waitForPlatformRuntimeReportsForTest = async (): Promise<void> => {
  await Promise.all([...processState().domains.values()].map(({ tail }) => tail));
};

export const resetPlatformRuntimeReporterForTest = (): void => {
  delete runtimeReporterProcess.__lobehubPlatformRuntimeReporterState;
};

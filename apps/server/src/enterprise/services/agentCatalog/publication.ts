import debug from 'debug';

import { checksumPayload } from '@/database/models/platform/checksum';
import {
  type ExactPlatformAgentVersion,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import type { PlatformAgentItem } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  AdminPlatformAgentRollbackInput,
  AdminPlatformAgentSaveInput,
} from '../../contracts/platformAgents';
import type { EnterpriseConfigPublishOperation } from '../../observability';
import { classifyEnterpriseError, observeEnterprisePlatformEvent } from '../../observability';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { assertExactPlatformAgentDependencies } from './dependencyValidator';
import { PlatformAgentNotFoundError, PlatformAgentRevisionConflictError } from './errors';
import { translatePlatformAgentPgError } from './pgErrors';

const log = debug('lobe-server:platform-agent-publication');

/** Label of an Agent's very first immutable version. */
export const FIRST_PLATFORM_AGENT_VERSION = '1.0.0';

export interface PlatformAgentPublicationLifecycle {
  afterDependencyLock?: (tx: Transaction) => Promise<void>;
  afterIdentityLock?: (tx: Transaction) => Promise<void>;
}

export interface PlatformAgentPublicationOptions {
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: PlatformAgentPublicationLifecycle;
  validateDependencies?: typeof assertExactPlatformAgentDependencies;
}

interface AgentDraftTokenInput {
  agentKey: string;
  currentVersionId: string | null;
  draftSequence: number;
  id: string;
  isDefault: boolean;
  migrationRequired: boolean;
  revision: number;
  status: string;
  systemKey: string | null;
}

export const platformAgentDraftToken = (identity: AgentDraftTokenInput): string =>
  checksumPayload({
    agentKey: identity.agentKey,
    currentVersionId: identity.currentVersionId,
    draftSequence: identity.draftSequence,
    id: identity.id,
    isDefault: identity.isDefault,
    migrationRequired: identity.migrationRequired,
    revision: identity.revision,
    status: identity.status,
    systemKey: identity.systemKey,
  });

export const assertExpectedPlatformAgentIdentity = (
  identity: AgentDraftTokenInput,
  expectedDraftToken: string,
  expectedRevision: number,
) => {
  if (
    identity.migrationRequired ||
    identity.revision !== expectedRevision ||
    platformAgentDraftToken(identity) !== expectedDraftToken
  ) {
    throw new PlatformAgentRevisionConflictError();
  }
};

/** Contract projection of the mutable Agent identity row. */
export const platformAgentIdentityView = (identity: PlatformAgentItem) => ({
  agentKey: identity.agentKey,
  currentVersionId: identity.currentVersionId,
  draftSequence: identity.draftSequence,
  id: identity.id,
  isDefault: identity.isDefault,
  migrationRequired: identity.migrationRequired,
  revision: identity.revision,
  status: identity.status as 'archived' | 'draft' | 'published',
  systemKey: identity.systemKey === 'default-inbox' ? ('default-inbox' as const) : null,
});

/** Identity projection plus the CAS token every follow-up mutation must echo back. */
export const platformAgentMutationView = (identity: PlatformAgentItem) => ({
  draftToken: platformAgentDraftToken(identity),
  identity: platformAgentIdentityView(identity),
});

/** Contract projection of an immutable version row (never leaks internal columns). */
export const platformAgentVersionView = (version: ExactPlatformAgentVersion) => ({
  agentId: version.agentId,
  checksum: version.checksum,
  config: version.config,
  createdAt: version.createdAt,
  createdBy: version.createdBy,
  dependencySnapshot: version.dependencySnapshot,
  id: version.id,
  version: version.version,
});

/**
 * Strict SemVer: MAJOR.MINOR.PATCH with no leading zeros, optional prerelease (`-…`) and
 * build (`+…`) metadata. Anything else is treated as a malformed legacy label.
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;

type SemverCore = [major: number, minor: number, patch: number];

/** Parsed MAJOR.MINOR.PATCH core, or null when the label is not valid SemVer. */
const semverCore = (label: string): SemverCore | null => {
  const match = SEMVER_PATTERN.exec(label.trim());
  if (!match) return null;
  const core: SemverCore = [Number(match[1]), Number(match[2]), Number(match[3])];
  return core.every((part) => Number.isSafeInteger(part)) ? core : null;
};

/** Precedence of two SemVer cores (prerelease precedence is irrelevant: the core is bumped). */
const isHigherCore = (candidate: SemverCore, current: SemverCore): boolean => {
  for (const [index, part] of candidate.entries()) {
    if (part !== current[index]) return part > current[index];
  }
  return false;
};

/**
 * Server-owned version label. Version labels are UNIQUE per Agent, so the next one must never
 * be able to land on an existing row:
 *
 * - no versions at all → `1.0.0`;
 * - at least one valid SemVer → patch bump of the HIGHEST valid one (not the newest created,
 *   which may be a malformed legacy label). Prerelease / build metadata is dropped, so
 *   `1.2.3+build.5` yields `1.2.4`;
 * - versions exist but none is valid SemVer → `0.0.<count + 1>`. Never `1.0.0`, which could
 *   already be taken; the `0.0.x` family is only ever reached from this branch, and as soon as
 *   one such label exists it is itself valid SemVer and the bump branch takes over.
 */
export const nextPlatformAgentVersion = (existing: readonly string[]): string => {
  if (existing.length === 0) return FIRST_PLATFORM_AGENT_VERSION;

  let highest: SemverCore | null = null;
  for (const label of existing) {
    const core = semverCore(label);
    if (core && (!highest || isHigherCore(core, highest))) highest = core;
  }
  if (!highest) return `0.0.${existing.length + 1}`;
  return `${highest[0]}.${highest[1]}.${highest[2] + 1}`;
};

/**
 * The de-drafted write body shared by `save` and `create`: revalidate the exact dependency
 * refs under the publication lock, append an immutable version with a server-generated label,
 * then move the published pointer onto it — all inside the caller's transaction.
 *
 * The caller must already hold the identity row lock and have asserted its CAS token.
 */
export const appendAndPublishPlatformAgentVersion = async (
  tx: Transaction,
  params: {
    actorUserId: string;
    config: ExactPlatformAgentVersion['config'];
    dependencySnapshot: ExactPlatformAgentVersion['dependencySnapshot'];
    /** Locked identity row (`SELECT … FOR UPDATE`). */
    identity: PlatformAgentItem;
    /** Overridable for tests / call sites with their own validator wiring. */
    validateDependencies?: typeof assertExactPlatformAgentDependencies;
    /** Server-generated label; derived from the Agent's existing labels when omitted. */
    version?: string;
  },
): Promise<{ identity: PlatformAgentItem; version: ExactPlatformAgentVersion }> => {
  const repository = new PlatformAgentCatalogRepository(tx);
  await acquirePlatformDependencyPublicationLock(tx);
  await (params.validateDependencies ?? assertExactPlatformAgentDependencies)(
    tx,
    params.dependencySnapshot,
  );

  const label =
    params.version ??
    nextPlatformAgentVersion(await repository.listVersionLabels(params.identity.id));
  const version = await repository.appendVersionCas({
    agentId: params.identity.id,
    config: params.config,
    createdBy: params.actorUserId,
    dependencySnapshot: params.dependencySnapshot,
    expectedDraftSequence: params.identity.draftSequence,
    expectedRevision: params.identity.revision,
    version: label,
  });
  if (!version) throw new PlatformAgentRevisionConflictError();

  // appendVersionCas advanced the draft sequence but not the revision; the pointer move
  // continues from that exact state so a concurrent writer still loses the CAS.
  const published = await repository.pointToVersionCas({
    agentId: params.identity.id,
    expectedDraftSequence: params.identity.draftSequence + 1,
    expectedRevision: params.identity.revision,
    publishedAt: new Date(),
    versionId: version.id,
  });
  if (!published) throw new PlatformAgentRevisionConflictError();
  return { identity: published, version };
};

/**
 * Post-commit cache invalidation. A publication that is already durable must never be
 * reported as a failure because the fan-out sink is down — the caller gets `deferred`.
 */
export const invalidatePlatformAgentPublication = async (params: {
  agentId: string;
  invalidation?: PlatformConfigInvalidationPublisher;
  revision: number;
}): Promise<'deferred' | 'delivered'> => {
  try {
    await (params.invalidation ?? getPlatformConfigInvalidationPublisher()).publish({
      at: new Date().toISOString(),
      resourceId: params.agentId,
      resourceType: 'agent',
      revision: params.revision,
      scopes: ['agent-catalog', 'agent-runtime'],
    });
    return 'delivered';
  } catch (error) {
    log(
      'post-commit invalidation failed agent=%s revision=%d class=%s',
      params.agentId,
      params.revision,
      error instanceof Error ? error.name : 'UnknownError',
    );
    return 'deferred';
  }
};

/**
 * Low-cardinality publication metric. The operation label comes from the shared closed set
 * (`publish` | `rollback` | `save`): the de-drafted `save` / `create` writes report `save`,
 * `rollback` reports `rollback`.
 */
export const observePlatformAgentPublication = (params: {
  error?: unknown;
  operation: EnterpriseConfigPublishOperation;
  startedAt: number;
}): void => {
  const conflict = params.error instanceof PlatformAgentRevisionConflictError;
  observeEnterprisePlatformEvent({
    domain: 'agent_catalog',
    durationMs: Date.now() - params.startedAt,
    ...(params.error
      ? {
          errorClass: conflict ? ('ConflictError' as const) : classifyEnterpriseError(params.error),
        }
      : {}),
    operation: params.operation,
    outcome: params.error ? (conflict ? 'conflict' : 'failure') : 'success',
    type: 'config_publish',
  });
};

export class PlatformAgentPublicationService {
  private readonly invalidation: PlatformConfigInvalidationPublisher;
  private readonly lifecycle: PlatformAgentPublicationLifecycle;
  private readonly validateDependencies: typeof assertExactPlatformAgentDependencies;

  constructor(
    private readonly db: LobeChatDatabase,
    options: PlatformAgentPublicationOptions = {},
  ) {
    this.invalidation = options.invalidation ?? getPlatformConfigInvalidationPublisher();
    this.lifecycle = options.lifecycle ?? {};
    this.validateDependencies =
      options.validateDependencies ?? assertExactPlatformAgentDependencies;
  }

  private invalidate = async (
    agentId: string,
    revision: number,
  ): Promise<'deferred' | 'delivered'> =>
    invalidatePlatformAgentPublication({ agentId, invalidation: this.invalidation, revision });

  private appendFailureAudit = async (params: {
    action: AuditAction;
    actorUserId: string;
    reason: string;
    targetId: string;
  }): Promise<void> => {
    try {
      await new PlatformAuditService(this.db).append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'platform_agent_publication_failed' },
        reason: params.reason,
        result: 'failure',
        targetId: params.targetId,
        targetType: 'agent',
      });
    } catch (error) {
      log(
        'failure audit append failed agent=%s class=%s',
        params.targetId,
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  };

  private observePublication = (params: {
    error?: unknown;
    operation: EnterpriseConfigPublishOperation;
    startedAt: number;
  }): void => observePlatformAgentPublication(params);

  /**
   * The single de-drafted write: append an immutable version and publish it live in ONE
   * transaction (lock → CAS → dependency publication lock → revalidate → append → point →
   * audit), then invalidate caches after the commit.
   */
  save = async (actorUserId: string, input: AdminPlatformAgentSaveInput) => {
    const startedAt = Date.now();
    try {
      const result = await this.db.transaction(async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        const locked = await repository.lockIdentity(input.agentId);
        if (!locked) throw new PlatformAgentNotFoundError();
        await this.lifecycle.afterIdentityLock?.(tx);
        assertExpectedPlatformAgentIdentity(
          locked,
          input.expectedDraftToken,
          input.expectedRevision,
        );

        const { identity, version } = await appendAndPublishPlatformAgentVersion(tx, {
          actorUserId,
          config: input.config,
          dependencySnapshot: input.dependencySnapshot,
          identity: locked,
          validateDependencies: async (transaction, snapshot) => {
            await this.lifecycle.afterDependencyLock?.(transaction);
            await this.validateDependencies(transaction, snapshot);
          },
        });

        await new PlatformAuditService(tx).append({
          action: 'admin.agents.save',
          actorUserId,
          afterDiff: {
            dependencyCounts: {
              connectors: version.dependencySnapshot.connectors.length,
              skills: version.dependencySnapshot.skills.length,
            },
            revision: identity.revision,
            version: version.version,
            versionChecksum: version.checksum,
            versionId: version.id,
          },
          beforeDiff: {
            currentVersionId: locked.currentVersionId,
            revision: locked.revision,
          },
          configRevision: identity.revision,
          reason: input.reason,
          result: 'success',
          targetId: locked.id,
          targetType: 'agent',
        });
        return { identity, version };
      });
      const invalidationStatus = await this.invalidate(
        result.identity.id,
        result.identity.revision,
      );
      this.observePublication({ operation: 'save', startedAt });
      return {
        ...platformAgentMutationView(result.identity),
        invalidationStatus,
        version: platformAgentVersionView(result.version),
      };
    } catch (rawError) {
      // Normalize raw PostgreSQL constraint / trigger failures (e.g. a duplicate version
      // label) before auditing or surfacing them (ADM-03).
      const error = translatePlatformAgentPgError(rawError);
      await this.appendFailureAudit({
        action: 'admin.agents.save',
        actorUserId,
        reason: input.reason,
        targetId: input.agentId,
      });
      this.observePublication({ error, operation: 'save', startedAt });
      throw error;
    }
  };

  rollback = async (actorUserId: string, input: AdminPlatformAgentRollbackInput) => {
    const startedAt = Date.now();
    try {
      const result = await this.db.transaction(async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        const locked = await repository.lockIdentity(input.agentId);
        if (!locked) throw new PlatformAgentNotFoundError();
        await this.lifecycle.afterIdentityLock?.(tx);
        assertExpectedPlatformAgentIdentity(
          locked,
          input.expectedDraftToken,
          input.expectedRevision,
        );

        await acquirePlatformDependencyPublicationLock(tx);
        await this.lifecycle.afterDependencyLock?.(tx);
        const target = await repository.getExactVersion(locked.id, input.targetVersionId);
        if (!target) throw new PlatformAgentNotFoundError();
        await this.validateDependencies(tx, target.dependencySnapshot);

        const identity = await repository.pointToVersionCas({
          agentId: locked.id,
          expectedDraftSequence: locked.draftSequence,
          expectedRevision: locked.revision,
          publishedAt: new Date(),
          versionId: target.id,
        });
        if (!identity) throw new PlatformAgentRevisionConflictError();
        await new PlatformAuditService(tx).append({
          action: 'admin.agents.rollback',
          actorUserId,
          afterDiff: {
            revision: identity.revision,
            version: target.version,
            versionChecksum: target.checksum,
            versionId: target.id,
          },
          beforeDiff: {
            currentVersionId: locked.currentVersionId,
            revision: locked.revision,
          },
          configRevision: identity.revision,
          reason: input.reason,
          result: 'success',
          targetId: locked.id,
          targetType: 'agent',
        });
        return { agentId: locked.id, revision: identity.revision, versionId: target.id };
      });
      const invalidationStatus = await this.invalidate(result.agentId, result.revision);
      this.observePublication({ operation: 'rollback', startedAt });
      return { ...result, invalidationStatus };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.agents.rollback',
        actorUserId,
        reason: input.reason,
        targetId: input.agentId,
      });
      this.observePublication({ error, operation: 'rollback', startedAt });
      throw error;
    }
  };
}

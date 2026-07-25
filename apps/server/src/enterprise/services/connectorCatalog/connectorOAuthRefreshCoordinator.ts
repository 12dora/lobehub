import { createHash, randomUUID } from 'node:crypto';

import debug from 'debug';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { PlatformJobModel } from '@/database/models/platform/job';
import { PlatformUserConnectorBindingRepository } from '@/database/repositories/platformConnectorCatalog';
import { platformJobs, type PlatformUserConnectorBindingItem } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { connectorOAuthTokenResponseSchema } from '../../contracts/platformConnectors';
import { ConnectorCatalogReadService, resolveConnectorSecretVersion } from './catalogSnapshot';
import { PlatformConnectorContractError } from './errors';
import { assertStoredSecret, bestEffortRevokeSecret, parseGrantedScopes } from './oauthHelpers';
import type { ConnectorOAuthRuntimeDependencies } from './oauthRuntime';

const log = debug('lobe-server:connector-oauth-refresh');

export const OAUTH_REFRESH_JOB_TYPE = 'connector.oauth.refresh.v1';
/** Short lease before outbound I/O; heartbeats renew while work is in flight. */
const OAUTH_REFRESH_LEASE_INTERVAL = sql<Date>`statement_timestamp() + interval '2 minutes'`;
/**
 * Extended lease once outbound token refresh has started — covers slow IdP
 * round-trips without allowing concurrent reclaim of an in-flight rotation.
 */
const OAUTH_REFRESH_OUTBOUND_LEASE_INTERVAL = sql<Date>`statement_timestamp() + interval '10 minutes'`;

const storedOAuthTokenSchema = z
  .object({
    accessToken: z.string().min(1).max(32_768),
    refreshToken: z.string().min(1).max(32_768).optional(),
  })
  .strict();

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export type RefreshLease = { jobId: string; owner: string };

/**
 * Distributed refresh lease + token rotation commit for per-user OAuth bindings.
 * Ownership must be proven on every heartbeat before IdP I/O and before complete.
 */
export class ConnectorOAuthRefreshCoordinator {
  private readonly bindings: PlatformUserConnectorBindingRepository;
  private readonly read: ConnectorCatalogReadService;

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly dependencies: ConnectorOAuthRuntimeDependencies,
  ) {
    this.bindings = new PlatformUserConnectorBindingRepository(db, userId);
    this.read = new ConnectorCatalogReadService(db, dependencies.secrets);
  }

  /** Server-only refresh path; the old valid binding remains untouched on every failure. */
  refreshBinding = async (connectorId: string, publishedRevision?: number): Promise<void> => {
    const [snapshot, binding] = await Promise.all([
      publishedRevision === undefined
        ? this.read.getSnapshot(connectorId)
        : this.read.getSnapshotRevision(connectorId, publishedRevision),
      this.bindings.getBinding(connectorId),
    ]);
    const connector = snapshot.payload.connector;
    const oauth = connector.oauthConfig;
    if (
      !binding ||
      binding.status !== 'connected' ||
      binding.publishedRevision !== snapshot.provenance.revision ||
      !binding.oauthTokenRef ||
      !oauth ||
      connector.credentialMode !== 'per_user_oauth'
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_BINDING_NOT_FOUND');
    }
    await this.dependencies.outbound.preflightToken(oauth.tokenEndpoint);
    const currentSecret = await this.dependencies.secrets.resolveSecretRef({
      connectorId,
      ref: binding.oauthTokenRef,
      slot: 'oauthBindingToken',
    });
    const currentToken = storedOAuthTokenSchema.safeParse(currentSecret?.value);
    if (!currentSecret || currentSecret.ref !== binding.oauthTokenRef || !currentToken.success) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
    if (!currentToken.data.refreshToken) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
    const clientSecret = connector.oauthClientSecretConfigured
      ? await resolveConnectorSecretVersion(
          this.dependencies.secrets,
          connector.id,
          'oauthClientSecret',
          connector.oauthClientSecretFingerprint,
        )
      : null;
    const clientSecretValue = clientSecret?.value;
    if (clientSecretValue !== undefined && typeof clientSecretValue !== 'string') {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
    const refreshLease = await this.acquireRefreshLease(binding);
    let completed = false;
    try {
      // Test-only seam: ownership theft between acquire and pre-outbound heartbeat.
      await this.dependencies.__testAfterRefreshLeaseAcquire?.(refreshLease);
      // Mark outboundStarted + extend lease before IdP I/O so concurrent callers
      // cannot reclaim mid-rotation; a crash after this point is fail-closed via TTL.
      // Heartbeat must prove ownership — a no-op update means another worker reclaimed.
      await this.heartbeatRefreshLease(refreshLease, { outbound: true, required: true });
      const response = await this.dependencies.outbound.refresh({
        clientId: oauth.clientId,
        clientSecret: clientSecretValue,
        refreshToken: currentToken.data.refreshToken,
        tokenEndpoint: oauth.tokenEndpoint,
      });
      // Post-outbound: ownership loss must not discard a live rotated credential.
      // Soft-continue to binding CAS (authoritative fence); complete() still checks owner.
      const postOutboundOwned = await this.heartbeatRefreshLease(refreshLease, {
        outbound: true,
        required: false,
      });
      if (!postOutboundOwned) {
        log(
          'post-outbound lease ownership lost jobId=%s; continuing to binding CAS',
          refreshLease.jobId,
        );
      }
      const token = connectorOAuthTokenResponseSchema.safeParse(response.body);
      if (!token.success) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
      }
      const scopes = parseGrantedScopes(token.data.scope, binding.scopes);
      if (scopes.some((scope) => !oauth.scopes.includes(scope))) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SCOPE_NOT_ALLOWED');
      }
      const storedToken = assertStoredSecret(
        await this.dependencies.secrets.persistSecret({
          connectorId,
          slot: 'oauthBindingToken',
          value: {
            accessToken: token.data.access_token,
            refreshToken: token.data.refresh_token ?? currentToken.data.refreshToken,
          },
        }),
      );
      const updatedAt = (this.dependencies.clock ?? (() => new Date()))();
      const updated = await this.bindings.updateBindingCas(connectorId, binding.revision, {
        expiresAt:
          token.data.expires_in === undefined
            ? binding.expiresAt
            : new Date(updatedAt.getTime() + token.data.expires_in * 1000),
        oauthTokenRef: storedToken.ref,
        scopes,
        tokenFingerprint: storedToken.fingerprint,
      });
      if (!updated) {
        await bestEffortRevokeSecret(
          this.dependencies,
          connectorId,
          'oauthBindingToken',
          storedToken.ref,
          this.db,
        );
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
      }
      const completedJob = await new PlatformJobModel(this.db).complete({
        jobId: refreshLease.jobId,
        resultSummary: { bindingRevision: updated.revision },
        workerId: refreshLease.owner,
      });
      if (!completedJob) {
        // Binding CAS already committed the rotated pair; lease ownership was lost
        // (e.g. reclaim race after a long post-outbound stall). Treat as success-
        // with-warning rather than a hard error for work that actually stuck.
        log(
          'post-cas lease complete missed jobId=%s bindingRevision=%s; rotated credential is durable',
          refreshLease.jobId,
          updated.revision,
        );
      }
      completed = true;
      await bestEffortRevokeSecret(
        this.dependencies,
        connectorId,
        'oauthBindingToken',
        binding.oauthTokenRef,
        this.db,
      );
    } finally {
      // Process crash is covered by finite leaseUntil + reclaim. This finally
      // releases the lease on any in-process failure so a held lease cannot
      // livelock the binding revision.
      if (!completed) {
        await this.releaseRefreshLeaseBestEffort(refreshLease, 'CONNECTOR_OAUTH_REFRESH_FAILED');
      }
    }
  };

  /**
   * Terminalise a refresh lease even when the standard job.fail() CAS misses
   * (expired lease). Idempotent: terminal rows and foreign owners are no-ops.
   */
  private releaseRefreshLeaseBestEffort = async (
    lease: RefreshLease,
    code: string,
  ): Promise<void> => {
    try {
      const failed = await new PlatformJobModel(this.db).fail({
        error: { code },
        jobId: lease.jobId,
        terminal: true,
        workerId: lease.owner,
      });
      if (failed) return;
      // fail() no-ops when lease already expired — force-clear ownership so the
      // binding revision can be reclaimed without waiting for another cycle.
      const databaseNow = sql<Date>`statement_timestamp()`;
      await this.db
        .update(platformJobs)
        .set({
          finishedAt: databaseNow,
          lastError: { code },
          leaseOwner: null,
          leaseUntil: null,
          status: 'failed',
          updatedAt: databaseNow,
        })
        .where(
          and(
            eq(platformJobs.id, lease.jobId),
            eq(platformJobs.leaseOwner, lease.owner),
            eq(platformJobs.status, 'running'),
          ),
        );
    } catch {
      // Best-effort only; finite leaseUntil remains the crash-recovery backstop.
    }
  };

  /**
   * Renew lease ownership.
   * - `required: true` (pre-outbound): zero rows throws — never start IdP I/O without ownership.
   * - `required: false` (post-outbound): zero rows returns false so the caller can still
   *   commit a rotated credential via binding CAS instead of discarding it.
   */
  private heartbeatRefreshLease = async (
    lease: RefreshLease,
    options: { outbound: boolean; required: boolean },
  ): Promise<boolean> => {
    const databaseNow = sql<Date>`statement_timestamp()`;
    const [owned] = await this.db
      .update(platformJobs)
      .set({
        heartbeatAt: databaseNow,
        // Outbound I/O uses the longer lease so slow IdPs cannot be reclaimed mid-flight.
        leaseUntil: options.outbound
          ? OAUTH_REFRESH_OUTBOUND_LEASE_INTERVAL
          : OAUTH_REFRESH_LEASE_INTERVAL,
        // Mark that outbound work may be in flight so reclaim refuses blind retry.
        input: options.outbound
          ? sql`jsonb_set(coalesce(${platformJobs.input}, '{}'::jsonb), '{outboundStarted}', 'true'::jsonb, true)`
          : platformJobs.input,
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(platformJobs.id, lease.jobId),
          eq(platformJobs.leaseOwner, lease.owner),
          eq(platformJobs.status, 'running'),
        ),
      )
      .returning({ id: platformJobs.id });
    if (!owned) {
      if (options.required) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
      }
      return false;
    }
    return true;
  };

  private acquireRefreshLease = async (
    binding: PlatformUserConnectorBindingItem,
  ): Promise<RefreshLease> => {
    const owner = randomUUID();
    const databaseNow = sql<Date>`statement_timestamp()`;
    // Finite lease so a crashed worker can be reclaimed after expiry instead of
    // permanently stranding the binding refresh path on an abandoned `running` row.
    // Heartbeats renew leaseUntil while the holder is still executing outbound work.
    const databaseLeaseUntil = OAUTH_REFRESH_LEASE_INTERVAL;
    const idempotencyKey = hash(`${binding.id}:${binding.revision}`);
    const [created] = await this.db
      .insert(platformJobs)
      .values({
        attempt: 1,
        heartbeatAt: databaseNow,
        idempotencyKey,
        input: {
          bindingId: binding.id,
          bindingRevision: binding.revision,
          connectorId: binding.connectorId,
          outboundStarted: false,
          userId: binding.userId,
        },
        leaseOwner: owner,
        leaseUntil: databaseLeaseUntil,
        requestedBy: binding.userId,
        startedAt: databaseNow,
        status: 'running',
        type: OAUTH_REFRESH_JOB_TYPE,
      })
      .onConflictDoNothing({ target: [platformJobs.type, platformJobs.idempotencyKey] })
      .returning({ id: platformJobs.id });
    if (created) return { jobId: created.id, owner };

    // Ambiguous outbound: lease expired after token endpoint may have rotated.
    // Mark dead and never reclaim for a blind refresh-token retry (fail closed).
    const [ambiguous] = await this.db
      .update(platformJobs)
      .set({
        lastError: { code: 'CONNECTOR_OAUTH_REFRESH_AMBIGUOUS_OUTBOUND' },
        status: 'dead',
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(platformJobs.type, OAUTH_REFRESH_JOB_TYPE),
          eq(platformJobs.idempotencyKey, idempotencyKey),
          eq(platformJobs.status, 'running'),
          sql`${platformJobs.leaseUntil} IS NOT NULL`,
          sql`${platformJobs.leaseUntil} < statement_timestamp()`,
          sql`coalesce((${platformJobs.input}->>'outboundStarted')::boolean, false) = true`,
        ),
      )
      .returning({ id: platformJobs.id });
    if (ambiguous) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
    }

    const [reclaimed] = await this.db
      .update(platformJobs)
      .set({
        attempt: sql`${platformJobs.attempt} + 1`,
        heartbeatAt: databaseNow,
        input: sql`jsonb_set(coalesce(${platformJobs.input}, '{}'::jsonb), '{outboundStarted}', 'false'::jsonb, true)`,
        lastError: null,
        leaseOwner: owner,
        leaseUntil: databaseLeaseUntil,
        status: 'running',
        updatedAt: databaseNow,
      })
      .where(
        and(
          eq(platformJobs.type, OAUTH_REFRESH_JOB_TYPE),
          eq(platformJobs.idempotencyKey, idempotencyKey),
          // Terminal non-ambiguous jobs, or abandoned running leases that never
          // started outbound (safe reclaim without double-rotate risk).
          sql`(
            (
              ${platformJobs.status} IN ('dead', 'failed')
              AND coalesce(${platformJobs.lastError}->>'code', '')
                <> 'CONNECTOR_OAUTH_REFRESH_AMBIGUOUS_OUTBOUND'
            )
            OR (
              ${platformJobs.status} = 'running'
              AND ${platformJobs.leaseUntil} IS NOT NULL
              AND ${platformJobs.leaseUntil} < statement_timestamp()
              AND coalesce((${platformJobs.input}->>'outboundStarted')::boolean, false) = false
              AND (
                ${platformJobs.heartbeatAt} IS NULL
                OR ${platformJobs.heartbeatAt} < statement_timestamp() - interval '2 minutes'
              )
            )
          )`,
        ),
      )
      .returning({ id: platformJobs.id });
    if (reclaimed) return { jobId: reclaimed.id, owner };
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  };
}

import { createHash, randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';

import { isPlainRecord } from '@lobechat/utils/object';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { PlatformJobModel } from '@/database/models/platform/job';
import {
  PlatformConnectorCatalogRepository,
  PlatformUserConnectorBindingRepository,
} from '@/database/repositories/platformConnectorCatalog';
import { platformJobs, type PlatformUserConnectorBindingItem } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  connectorBindingSchema,
  connectorOAuthCallbackInputSchema,
  connectorOAuthTokenResponseSchema,
  connectorScopesSchema,
  userConnectorDisconnectInputSchema,
  userConnectorDisconnectOutputSchema,
  userConnectorGetAuthorizationStatusInputSchema,
  userConnectorGetAuthorizationStatusOutputSchema,
  userConnectorListManagedInputSchema,
  userConnectorListManagedOutputSchema,
  userConnectorStartAuthorizationInputSchema,
  userConnectorStartAuthorizationOutputSchema,
} from '../../contracts/platformConnectors';
import { PlatformAuditService } from '../platformAudit';
import { ConnectorCatalogReadService, resolveConnectorSecretVersion } from './catalogSnapshot';
import { PlatformConnectorContractError } from './errors';
import type { ConnectorOAuthRuntimeDependencies } from './oauthRuntime';
import { MANAGED_CONNECTOR_OAUTH_STATE_PREFIX } from './oauthRuntime';
import { cleanupConnectorSecretRefs } from './secretCleanup';

const AUTHORIZATION_TTL_MS = 9 * 60 * 1000;
const OAUTH_REFRESH_JOB_TYPE = 'connector.oauth.refresh.v1';
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

type ListManagedInput = z.input<typeof userConnectorListManagedInputSchema>;
type StartAuthorizationInput = z.input<typeof userConnectorStartAuthorizationInputSchema>;
type GetAuthorizationStatusInput = z.input<typeof userConnectorGetAuthorizationStatusInputSchema>;
type DisconnectInput = z.input<typeof userConnectorDisconnectInputSchema>;
type CallbackInput = z.input<typeof connectorOAuthCallbackInputSchema>;

const toBindingProjection = (binding: PlatformUserConnectorBindingItem | undefined) =>
  binding
    ? connectorBindingSchema.parse({
        connectedAt: binding.connectedAt,
        expiresAt: binding.expiresAt,
        id: binding.id,
        lastErrorCategory: binding.lastErrorCategory,
        scopes: binding.scopes,
        status: binding.status,
        updatedAt: binding.updatedAt,
      })
    : null;

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const createPkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

const assertStoredSecret = (value: { fingerprint: string; ref: string }) => {
  if (
    value.fingerprint.length === 0 ||
    (!value.ref.startsWith('vault://') && !value.ref.startsWith('kms://'))
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  return value;
};

const assertExactAuthorizationEndpoint = (value: string): URL => {
  const url = new URL(value);
  const reserved = [
    'client_id',
    'code_challenge',
    'code_challenge_method',
    'redirect_uri',
    'response_type',
    'scope',
    'state',
  ];
  if (url.hash || reserved.some((key) => url.searchParams.has(key))) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
  }
  return url;
};

const parseGrantedScopes = (scope: string | undefined, requested: string[]): string[] => {
  if (!scope) return [...requested];
  const scopes = connectorScopesSchema.parse(scope.split(/\s+/u).filter(Boolean));
  const requestedSet = new Set(requested);
  if (scopes.some((candidate) => !requestedSet.has(candidate))) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SCOPE_NOT_ALLOWED');
  }
  return scopes;
};

const bestEffortRevokeSecret = (
  dependencies: ConnectorOAuthRuntimeDependencies,
  connectorId: string,
  slot: 'oauthBindingToken' | 'oauthPkceVerifier',
  ref: string | null | undefined,
): Promise<void> =>
  ref
    ? cleanupConnectorSecretRefs(dependencies.secrets, [{ connectorId, ref, slot }])
    : Promise.resolve();

const appendOAuthAuditBestEffort = async (
  db: LobeChatDatabase,
  params: {
    action: string;
    actorUserId: string;
    status: string;
    targetId: string;
  },
): Promise<void> => {
  try {
    await new PlatformAuditService(db).append({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: { status: params.status },
      reason: null,
      result: 'success',
      targetId: params.targetId,
      targetType: 'connector_binding',
    });
  } catch (error) {
    console.error('[connectorOAuth] audit append failed', {
      action: params.action,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
  }
};

export class UserConnectorOAuthService {
  private readonly bindings: PlatformUserConnectorBindingRepository;
  private readonly catalog: PlatformConnectorCatalogRepository;
  private readonly read: ConnectorCatalogReadService;

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly dependencies: ConnectorOAuthRuntimeDependencies,
  ) {
    this.bindings = new PlatformUserConnectorBindingRepository(db, userId);
    this.catalog = new PlatformConnectorCatalogRepository(db);
    this.read = new ConnectorCatalogReadService(db, dependencies.secrets);
  }

  listManaged = async (input: ListManagedInput) => {
    const command = userConnectorListManagedInputSchema.parse(input);
    const page = await this.catalog.listConnectors({
      cursor: command.cursor,
      enabled: true,
      limit: command.limit,
      query: command.query,
      status: 'published',
    });
    // Batch binding + published snapshot lookups once per page (no N+1).
    const connectorIds = page.items.map((connector) => connector.id);
    const [bindingsByConnectorId, publishedById] = await Promise.all([
      this.bindings.getBindingsForConnectors(connectorIds),
      this.read.getPublicPublishedBatch(connectorIds),
    ]);
    const items = page.items.map((connector) => {
      const published = publishedById.get(connector.id);
      if (!published) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
      }
      return {
        ...published,
        binding: toBindingProjection(bindingsByConnectorId.get(connector.id)),
      };
    });
    return userConnectorListManagedOutputSchema.parse({
      items,
      nextCursor: page.nextCursor?.connectorKey ?? null,
    });
  };

  getAuthorizationStatus = async (input: GetAuthorizationStatusInput) => {
    const command = userConnectorGetAuthorizationStatusInputSchema.parse(input);
    const attempt = await this.bindings.getAuthorizationAttempt(
      command.connectorId,
      command.attemptId,
    );
    if (!attempt) {
      return userConnectorGetAuthorizationStatusOutputSchema.parse({
        attemptId: command.attemptId,
        binding: null,
        status: 'invalid',
      });
    }
    const { binding, state } = attempt;
    const now = (this.dependencies.clock ?? (() => new Date()))();
    const expired = !state.authorizationOutcome && state.expiresAt.getTime() <= now.getTime();
    const completed =
      !state.revokedAt &&
      state.authorizationOutcome === 'completed' &&
      binding.status === 'connected' &&
      !binding.revokedAt;
    return userConnectorGetAuthorizationStatusOutputSchema.parse({
      attemptId: command.attemptId,
      binding: completed ? toBindingProjection(binding) : null,
      status: completed
        ? 'completed'
        : state.revokedAt
          ? 'superseded'
          : expired
            ? 'expired'
            : state.authorizationOutcome === 'failed'
              ? 'failed'
              : 'pending',
    });
  };

  startAuthorization = async (input: StartAuthorizationInput) => {
    const command = userConnectorStartAuthorizationInputSchema.parse(input);
    const [snapshot, current] = await Promise.all([
      this.read.getSnapshot(command.connectorId),
      this.catalog.getConnector(command.connectorId),
    ]);
    const connector = snapshot.payload.connector;
    const oauth = connector.oauthConfig;
    if (
      !current ||
      current.status !== 'published' ||
      !current.enabled ||
      current.publishedRevision !== snapshot.provenance.revision ||
      !connector.enabled ||
      connector.credentialMode !== 'per_user_oauth' ||
      !oauth
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
    }
    if (oauth.redirectUri !== this.dependencies.callbackRedirectUri) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
    }
    const authorizationUrl = assertExactAuthorizationEndpoint(oauth.authorizationEndpoint);
    await this.dependencies.outbound.preflightAuthorization(authorizationUrl.toString());

    const random = this.dependencies.randomBytes ?? cryptoRandomBytes;
    const state = `${MANAGED_CONNECTOR_OAUTH_STATE_PREFIX}${random(32).toString('base64url')}`;
    const stateId = random(16).toString('hex');
    const verifier = random(32).toString('base64url');
    if (state.length < 32 || stateId.length !== 32 || verifier.length < 43) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
    }
    const storedVerifier = assertStoredSecret(
      await this.dependencies.secrets.persistSecret({
        connectorId: connector.id,
        slot: 'oauthPkceVerifier',
        value: verifier,
      }),
    );
    const now = (this.dependencies.clock ?? (() => new Date()))();
    let prepared: Awaited<ReturnType<typeof this.bindings.prepareOAuthAuthorization>>;
    try {
      prepared = await this.bindings.prepareOAuthAuthorization({
        bindingId: randomUUID(),
        connectorId: connector.id,
        expiresAt: new Date(now.getTime() + AUTHORIZATION_TTL_MS),
        pkceVerifierRef: storedVerifier.ref,
        publishedRevision: snapshot.provenance.revision,
        redirectUri: oauth.redirectUri,
        returnTo: command.returnTo,
        scopes: oauth.scopes,
        stateHash: hash(state),
        stateId,
      });
    } catch (error) {
      await bestEffortRevokeSecret(
        this.dependencies,
        connector.id,
        'oauthPkceVerifier',
        storedVerifier.ref,
      );
      throw error;
    }
    await Promise.all(
      prepared.pkceVerifierRefs.map((ref) =>
        bestEffortRevokeSecret(this.dependencies, connector.id, 'oauthPkceVerifier', ref),
      ),
    );
    authorizationUrl.searchParams.set('client_id', oauth.clientId);
    authorizationUrl.searchParams.set('code_challenge', createPkceChallenge(verifier));
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('redirect_uri', oauth.redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', oauth.scopes.join(' '));
    authorizationUrl.searchParams.set('state', state);
    return userConnectorStartAuthorizationOutputSchema.parse({
      attemptId: stateId,
      authorizationUrl: authorizationUrl.toString(),
      bindingId: prepared.binding.id,
    });
  };

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
      // Mark outboundStarted + extend lease before IdP I/O so concurrent callers
      // cannot reclaim mid-rotation; a crash after this point is fail-closed via TTL.
      await this.heartbeatRefreshLease(refreshLease, { outbound: true });
      const response = await this.dependencies.outbound.refresh({
        clientId: oauth.clientId,
        clientSecret: clientSecretValue,
        refreshToken: currentToken.data.refreshToken,
        tokenEndpoint: oauth.tokenEndpoint,
      });
      // Renew after outbound returns to cover the persistence / CAS window.
      await this.heartbeatRefreshLease(refreshLease, { outbound: true });
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
        );
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
      }
      await new PlatformJobModel(this.db).complete({
        jobId: refreshLease.jobId,
        resultSummary: { bindingRevision: updated.revision },
        workerId: refreshLease.owner,
      });
      completed = true;
      await bestEffortRevokeSecret(
        this.dependencies,
        connectorId,
        'oauthBindingToken',
        binding.oauthTokenRef,
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
    lease: { jobId: string; owner: string },
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

  private heartbeatRefreshLease = async (
    lease: { jobId: string; owner: string },
    options: { outbound: boolean } = { outbound: false },
  ): Promise<void> => {
    const databaseNow = sql<Date>`statement_timestamp()`;
    await this.db
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
      );
  };

  private acquireRefreshLease = async (
    binding: PlatformUserConnectorBindingItem,
  ): Promise<{ jobId: string; owner: string }> => {
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

  disconnect = async (input: DisconnectInput) => {
    const command = userConnectorDisconnectInputSchema.parse(input);
    const result = await this.db.transaction(async (tx) => {
      const revoked = await new PlatformUserConnectorBindingRepository(
        tx,
        this.userId,
      ).revokeBindingWithPreviousSecret(command.connectorId);
      await new PlatformAuditService(tx).append({
        action: 'user.connectors.disconnect',
        actorUserId: this.userId,
        afterDiff: { status: 'revoked' },
        reason: null,
        result: 'success',
        targetId: command.connectorId,
        targetType: 'connector_binding',
      });
      return revoked;
    });
    await Promise.all([
      bestEffortRevokeSecret(
        this.dependencies,
        command.connectorId,
        'oauthBindingToken',
        result?.previousTokenRef,
      ),
      ...(result?.pkceVerifierRefs ?? []).map((ref) =>
        bestEffortRevokeSecret(this.dependencies, command.connectorId, 'oauthPkceVerifier', ref),
      ),
    ]);
    return userConnectorDisconnectOutputSchema.parse({ disconnected: true });
  };
}

export class ConnectorOAuthCallbackService {
  private readonly catalog: PlatformConnectorCatalogRepository;
  private readonly read: ConnectorCatalogReadService;

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly dependencies: ConnectorOAuthRuntimeDependencies,
  ) {
    this.catalog = new PlatformConnectorCatalogRepository(db);
    this.read = new ConnectorCatalogReadService(db, dependencies.secrets);
  }

  abandonAuthorization = async (rawState: string): Promise<void> => {
    const stateHash = hash(rawState);
    const reservation = await this.catalog.reserveOAuthState(stateHash);
    if (reservation.status === 'expired') {
      await cleanupConnectorSecretRefs(
        this.dependencies.secrets,
        reservation.pkceVerifierRefs.map((ref) => ({
          connectorId: reservation.connectorId,
          ref,
          slot: 'oauthPkceVerifier',
        })),
      );
      return;
    }
    if (reservation.status !== 'reserved') return;
    const terminated = await this.catalog.terminateOAuthStateReservation(
      stateHash,
      reservation.reservedAt,
    );
    if (terminated) {
      await bestEffortRevokeSecret(
        this.dependencies,
        terminated.connectorId,
        'oauthPkceVerifier',
        terminated.pkceVerifierRef,
      );
    }
  };

  callback = async (input: CallbackInput): Promise<{ returnTo?: string }> => {
    const command = connectorOAuthCallbackInputSchema.parse(input);
    const stateHash = hash(command.state);
    const reservation = await this.catalog.reserveOAuthState(stateHash);
    if (reservation.status === 'expired') {
      await Promise.all(
        reservation.pkceVerifierRefs.map((ref) =>
          bestEffortRevokeSecret(
            this.dependencies,
            reservation.connectorId,
            'oauthPkceVerifier',
            ref,
          ),
        ),
      );
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_EXPIRED');
    }
    if (reservation.status === 'replayed') {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_REPLAYED');
    }
    if (reservation.status !== 'reserved') {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
    }

    const state = reservation.state;
    let exchangeAttempted = false;
    let unboundTokenRef: string | undefined;
    try {
      const [snapshot, current] = await Promise.all([
        this.read.getSnapshot(state.connectorId),
        this.catalog.getConnector(state.connectorId),
      ]);
      const connector = snapshot.payload.connector;
      const oauth = connector.oauthConfig;
      if (
        !current ||
        current.status !== 'published' ||
        !current.enabled ||
        current.publishedRevision !== state.publishedRevision ||
        snapshot.provenance.revision !== state.publishedRevision ||
        !connector.enabled ||
        connector.credentialMode !== 'per_user_oauth' ||
        !oauth ||
        oauth.redirectUri !== state.redirectUri ||
        state.redirectUri !== this.dependencies.callbackRedirectUri ||
        state.scopes.some((scope) => !oauth.scopes.includes(scope))
      ) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
      }
      await this.dependencies.outbound.preflightToken(oauth.tokenEndpoint);
      const pkce = await this.dependencies.secrets.resolveSecretRef({
        connectorId: state.connectorId,
        ref: state.pkceVerifierRef,
        slot: 'oauthPkceVerifier',
      });
      if (
        !pkce ||
        pkce.ref !== state.pkceVerifierRef ||
        typeof pkce.value !== 'string' ||
        pkce.value.length < 43 ||
        pkce.value.length > 128
      ) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
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
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
      }
      exchangeAttempted = true;
      const response = await this.dependencies.outbound.exchangeCode({
        clientId: oauth.clientId,
        clientSecret: clientSecretValue,
        code: command.code,
        codeVerifier: pkce.value,
        redirectUri: state.redirectUri,
        tokenEndpoint: oauth.tokenEndpoint,
      });
      const token = connectorOAuthTokenResponseSchema.safeParse(response.body);
      if (!token.success || !isPlainRecord(response.body)) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
      }
      const scopes = parseGrantedScopes(token.data.scope, state.scopes);
      const storedToken = assertStoredSecret(
        await this.dependencies.secrets.persistSecret({
          connectorId: connector.id,
          slot: 'oauthBindingToken',
          value: {
            accessToken: token.data.access_token,
            refreshToken: token.data.refresh_token,
          },
        }),
      );
      unboundTokenRef = storedToken.ref;
      const connectedAt = (this.dependencies.clock ?? (() => new Date()))();
      const expiresAt =
        token.data.expires_in !== undefined
          ? new Date(connectedAt.getTime() + token.data.expires_in * 1000)
          : null;
      const finalized = await new PlatformUserConnectorBindingRepository(
        this.db,
        state.userId,
      ).finalizeOAuthAuthorization({
        connectedAt,
        connectorId: connector.id,
        expiresAt,
        oauthTokenRef: storedToken.ref,
        publishedRevision: state.publishedRevision,
        expectedBindingRevision: reservation.bindingRevision,
        reservedAt: reservation.reservedAt,
        scopes,
        stateHash,
        tokenFingerprint: storedToken.fingerprint,
      });
      unboundTokenRef = undefined;
      await Promise.all([
        bestEffortRevokeSecret(
          this.dependencies,
          connector.id,
          'oauthBindingToken',
          finalized.previousTokenRef,
        ),
        bestEffortRevokeSecret(
          this.dependencies,
          connector.id,
          'oauthPkceVerifier',
          state.pkceVerifierRef,
        ),
      ]);
      await appendOAuthAuditBestEffort(this.db, {
        action: 'user.connectors.oauthCallback',
        actorUserId: state.userId,
        status: 'connected',
        targetId: connector.id,
      });
      return state.returnTo ? { returnTo: state.returnTo } : {};
    } catch (error) {
      await bestEffortRevokeSecret(
        this.dependencies,
        state.connectorId,
        'oauthBindingToken',
        unboundTokenRef,
      );
      if (exchangeAttempted) {
        try {
          await this.catalog.failOAuthStateReservation(
            stateHash,
            reservation.reservedAt,
            (this.dependencies.clock ?? (() => new Date()))(),
          );
        } catch (statusError) {
          console.error('[connectorOAuth] failure outcome persistence failed', {
            errorClass: statusError instanceof Error ? statusError.name : 'UnknownError',
          });
        }
        await bestEffortRevokeSecret(
          this.dependencies,
          state.connectorId,
          'oauthPkceVerifier',
          state.pkceVerifierRef,
        );
      } else {
        await this.catalog.releaseOAuthStateReservation(stateHash, reservation.reservedAt);
      }
      if (error instanceof PlatformConnectorContractError) throw error;
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
    }
  };
}

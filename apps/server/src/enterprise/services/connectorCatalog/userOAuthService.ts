import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';

import { isPlainRecord } from '@lobechat/utils/object';
import type { z } from 'zod';

import {
  PlatformConnectorCatalogRepository,
  PlatformUserConnectorBindingRepository,
} from '@/database/repositories/platformConnectorCatalog';
import type { LobeChatDatabase } from '@/database/type';

import {
  connectorOAuthCallbackInputSchema,
  connectorOAuthTokenResponseSchema,
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
import { ConnectorOAuthRefreshCoordinator } from './connectorOAuthRefreshCoordinator';
import { PlatformConnectorContractError } from './errors';
import {
  appendOAuthAuditBestEffort,
  assertExactAuthorizationEndpoint,
  assertStoredSecret,
  bestEffortRevokeSecret,
  createPkceChallenge,
  hashOAuthValue,
  parseGrantedScopes,
  toBindingProjection,
} from './oauthHelpers';
import type { ConnectorOAuthRuntimeDependencies } from './oauthRuntime';
import { MANAGED_CONNECTOR_OAUTH_STATE_PREFIX } from './oauthRuntime';
import { cleanupConnectorSecretRefs } from './secretCleanup';

const AUTHORIZATION_TTL_MS = 9 * 60 * 1000;

type ListManagedInput = z.input<typeof userConnectorListManagedInputSchema>;
type StartAuthorizationInput = z.input<typeof userConnectorStartAuthorizationInputSchema>;
type GetAuthorizationStatusInput = z.input<typeof userConnectorGetAuthorizationStatusInputSchema>;
type DisconnectInput = z.input<typeof userConnectorDisconnectInputSchema>;
type CallbackInput = z.input<typeof connectorOAuthCallbackInputSchema>;

export class UserConnectorOAuthService {
  private readonly bindings: PlatformUserConnectorBindingRepository;
  private readonly catalog: PlatformConnectorCatalogRepository;
  private readonly read: ConnectorCatalogReadService;
  private readonly refreshCoordinator: ConnectorOAuthRefreshCoordinator;

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly dependencies: ConnectorOAuthRuntimeDependencies,
  ) {
    this.bindings = new PlatformUserConnectorBindingRepository(db, userId);
    this.catalog = new PlatformConnectorCatalogRepository(db);
    this.read = new ConnectorCatalogReadService(db, dependencies.secrets);
    this.refreshCoordinator = new ConnectorOAuthRefreshCoordinator(db, userId, dependencies);
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
        stateHash: hashOAuthValue(state),
        stateId,
      });
    } catch (error) {
      await bestEffortRevokeSecret(
        this.dependencies,
        connector.id,
        'oauthPkceVerifier',
        storedVerifier.ref,
        this.db,
      );
      throw error;
    }
    await Promise.all(
      prepared.pkceVerifierRefs.map((ref) =>
        bestEffortRevokeSecret(this.dependencies, connector.id, 'oauthPkceVerifier', ref, this.db),
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

  /** Server-only refresh path; delegates to the lease/CAS coordinator. */
  refreshBinding = async (connectorId: string, publishedRevision?: number): Promise<void> =>
    this.refreshCoordinator.refreshBinding(connectorId, publishedRevision);

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
        this.db,
      ),
      ...(result?.pkceVerifierRefs ?? []).map((ref) =>
        bestEffortRevokeSecret(
          this.dependencies,
          command.connectorId,
          'oauthPkceVerifier',
          ref,
          this.db,
        ),
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
    const stateHash = hashOAuthValue(rawState);
    const reservation = await this.catalog.reserveOAuthState(stateHash);
    if (reservation.status === 'expired') {
      await cleanupConnectorSecretRefs(
        this.dependencies.secrets,
        reservation.pkceVerifierRefs.map((ref) => ({
          connectorId: reservation.connectorId,
          ref,
          slot: 'oauthPkceVerifier' as const,
        })),
        { db: this.db },
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
        this.db,
      );
    }
  };

  callback = async (input: CallbackInput): Promise<{ returnTo?: string }> => {
    const command = connectorOAuthCallbackInputSchema.parse(input);
    const stateHash = hashOAuthValue(command.state);
    const reservation = await this.catalog.reserveOAuthState(stateHash);
    if (reservation.status === 'expired') {
      await Promise.all(
        reservation.pkceVerifierRefs.map((ref) =>
          bestEffortRevokeSecret(
            this.dependencies,
            reservation.connectorId,
            'oauthPkceVerifier',
            ref,
            this.db,
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
          this.db,
        ),
        bestEffortRevokeSecret(
          this.dependencies,
          connector.id,
          'oauthPkceVerifier',
          state.pkceVerifierRef,
          this.db,
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
        this.db,
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
          this.db,
        );
      } else {
        await this.catalog.releaseOAuthStateReservation(stateHash, reservation.reservedAt);
      }
      if (error instanceof PlatformConnectorContractError) throw error;
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
    }
  };
}

// Re-export coordinator for targeted unit tests without changing public service paths.
export { ConnectorOAuthRefreshCoordinator } from './connectorOAuthRefreshCoordinator';

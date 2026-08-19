import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';

import type { z } from 'zod';

import {
  PlatformConnectorCatalogRepository,
  PlatformUserConnectorBindingRepository,
} from '@/database/repositories/platformConnectorCatalog';
import type { LobeChatDatabase } from '@/database/type';

import {
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
import { ConnectorCatalogReadService } from './catalogSnapshot';
import { ConnectorOAuthRefreshCoordinator } from './connectorOAuthRefreshCoordinator';
import { PlatformConnectorContractError } from './errors';
import {
  applyAuthorizationQuery,
  assertExactAuthorizationEndpoint,
  assertPublishedPerUserOAuthConnector,
  assertStoredSecret,
  bestEffortRevokeSecret,
  createPkceChallenge,
  deriveAuthorizationAttemptStatus,
  hashOAuthValue,
  toBindingProjection,
} from './oauthHelpers';
import type { ConnectorOAuthRuntimeDependencies } from './oauthRuntime';
import { MANAGED_CONNECTOR_OAUTH_STATE_PREFIX } from './oauthRuntime';

const AUTHORIZATION_TTL_MS = 9 * 60 * 1000;

type ListManagedInput = z.input<typeof userConnectorListManagedInputSchema>;
type StartAuthorizationInput = z.input<typeof userConnectorStartAuthorizationInputSchema>;
type GetAuthorizationStatusInput = z.input<typeof userConnectorGetAuthorizationStatusInputSchema>;
type DisconnectInput = z.input<typeof userConnectorDisconnectInputSchema>;

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
    const now = (this.dependencies.clock ?? (() => new Date()))();
    return userConnectorGetAuthorizationStatusOutputSchema.parse({
      attemptId: command.attemptId,
      ...deriveAuthorizationAttemptStatus({
        binding: attempt.binding,
        now,
        state: attempt.state,
      }),
    });
  };

  startAuthorization = async (input: StartAuthorizationInput) => {
    const command = userConnectorStartAuthorizationInputSchema.parse(input);
    const [snapshot, current] = await Promise.all([
      this.read.getSnapshot(command.connectorId),
      this.catalog.getConnector(command.connectorId),
    ]);
    const connector = snapshot.payload.connector;
    const oauth = assertPublishedPerUserOAuthConnector({
      code: 'PLATFORM_CONNECTOR_NOT_PUBLISHED',
      connector,
      current,
      expectedRevision: snapshot.provenance.revision,
      oauth: connector.oauthConfig,
    });
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
    applyAuthorizationQuery(authorizationUrl, {
      challenge: createPkceChallenge(verifier),
      oauth,
      state,
    });
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

export { ConnectorOAuthCallbackService } from './oauthCallbackService';

// Re-export coordinator for targeted unit tests without changing public service paths.
export { ConnectorOAuthRefreshCoordinator } from './connectorOAuthRefreshCoordinator';

import { isPlainRecord } from '@lobechat/utils/object';
import type { z } from 'zod';

import type { OAuthStateReservationResult } from '@/database/repositories/platformConnectorCatalog';
import {
  PlatformConnectorCatalogRepository,
  PlatformUserConnectorBindingRepository,
} from '@/database/repositories/platformConnectorCatalog';
import type {
  PlatformConnectorItem,
  PlatformConnectorOAuthStateItem,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  connectorOAuthCallbackInputSchema,
  connectorOAuthTokenResponseSchema,
} from '../../contracts/platformConnectors';
import { ConnectorCatalogReadService, resolveConnectorSecretVersion } from './catalogSnapshot';
import type { ConnectorCatalogSecretStore } from './catalogTypes';
import { PlatformConnectorContractError } from './errors';
import {
  appendOAuthAuditBestEffort,
  assertPublishedPerUserOAuthConnector,
  assertStoredSecret,
  bestEffortRevokeSecret,
  hashOAuthValue,
  parseGrantedScopes,
} from './oauthHelpers';
import type { ConnectorOAuthRuntimeDependencies } from './oauthRuntime';
import { cleanupConnectorSecretRefs } from './secretCleanup';

type CallbackInput = z.input<typeof connectorOAuthCallbackInputSchema>;
type OAuthTokenResponse = z.infer<typeof connectorOAuthTokenResponseSchema>;
type ReservedOAuthState = Extract<OAuthStateReservationResult, { status: 'reserved' }>;
type PublishedSnapshot = Awaited<ReturnType<ConnectorCatalogReadService['getSnapshot']>>;

const revokePkceRefs = (
  reservation: { connectorId: string; pkceVerifierRefs: string[] },
  dependencies: ConnectorOAuthRuntimeDependencies,
  db: LobeChatDatabase,
): Promise<void> =>
  cleanupConnectorSecretRefs(
    dependencies.secrets,
    reservation.pkceVerifierRefs.map((ref) => ({
      connectorId: reservation.connectorId,
      ref,
      slot: 'oauthPkceVerifier' as const,
    })),
    { db },
  );

const admitReservedOAuthState = async (
  reservation: OAuthStateReservationResult,
  dependencies: ConnectorOAuthRuntimeDependencies,
  db: LobeChatDatabase,
): Promise<ReservedOAuthState> => {
  if (reservation.status === 'expired') {
    await revokePkceRefs(reservation, dependencies, db);
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_EXPIRED');
  }
  if (reservation.status === 'replayed') {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_REPLAYED');
  }
  if (reservation.status !== 'reserved') {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
  }
  return reservation;
};

const assertCallbackBindingMatchesState = (params: {
  callbackRedirectUri: string;
  current: PlatformConnectorItem | undefined;
  snapshot: PublishedSnapshot;
  state: PlatformConnectorOAuthStateItem;
}) => {
  const connector = params.snapshot.payload.connector;
  const oauth = assertPublishedPerUserOAuthConnector({
    code: 'PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID',
    connector,
    current: params.current,
    expectedRevision: params.state.publishedRevision,
    oauth: connector.oauthConfig,
  });
  if (
    params.snapshot.provenance.revision !== params.state.publishedRevision ||
    oauth.redirectUri !== params.state.redirectUri ||
    params.state.redirectUri !== params.callbackRedirectUri ||
    params.state.scopes.some((scope) => !oauth.scopes.includes(scope))
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
  }
  return { connector, oauth };
};

const resolveCallbackSecrets = async (params: {
  connector: {
    id: string;
    oauthClientSecretConfigured: boolean;
    oauthClientSecretFingerprint: string | null;
  };
  secrets: ConnectorCatalogSecretStore;
  state: PlatformConnectorOAuthStateItem;
}) => {
  const pkce = await params.secrets.resolveSecretRef({
    connectorId: params.state.connectorId,
    ref: params.state.pkceVerifierRef,
    slot: 'oauthPkceVerifier',
  });
  if (
    !pkce ||
    pkce.ref !== params.state.pkceVerifierRef ||
    typeof pkce.value !== 'string' ||
    pkce.value.length < 43 ||
    pkce.value.length > 128
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
  }
  const clientSecret = params.connector.oauthClientSecretConfigured
    ? await resolveConnectorSecretVersion(
        params.secrets,
        params.connector.id,
        'oauthClientSecret',
        params.connector.oauthClientSecretFingerprint,
      )
    : null;
  const clientSecretValue = clientSecret?.value;
  if (clientSecretValue !== undefined && typeof clientSecretValue !== 'string') {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
  }
  return { clientSecretValue, codeVerifier: pkce.value };
};

const persistExchangedBinding = async (params: {
  connector: { id: string };
  db: LobeChatDatabase;
  dependencies: ConnectorOAuthRuntimeDependencies;
  reservation: ReservedOAuthState;
  state: PlatformConnectorOAuthStateItem;
  stateHash: string;
  token: OAuthTokenResponse;
  unboundToken: { ref?: string };
}): Promise<{ returnTo?: string }> => {
  const { connector, db, dependencies, reservation, state, stateHash, token, unboundToken } =
    params;
  const scopes = parseGrantedScopes(token.scope, state.scopes);
  const storedToken = assertStoredSecret(
    await dependencies.secrets.persistSecret({
      connectorId: connector.id,
      slot: 'oauthBindingToken',
      value: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
      },
    }),
  );
  unboundToken.ref = storedToken.ref;
  const connectedAt = (dependencies.clock ?? (() => new Date()))();
  const expiresAt =
    token.expires_in !== undefined
      ? new Date(connectedAt.getTime() + token.expires_in * 1000)
      : null;
  const finalized = await new PlatformUserConnectorBindingRepository(
    db,
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
  unboundToken.ref = undefined;
  await Promise.all([
    bestEffortRevokeSecret(
      dependencies,
      connector.id,
      'oauthBindingToken',
      finalized.previousTokenRef,
      db,
    ),
    bestEffortRevokeSecret(
      dependencies,
      connector.id,
      'oauthPkceVerifier',
      state.pkceVerifierRef,
      db,
    ),
  ]);
  await appendOAuthAuditBestEffort(db, {
    action: 'user.connectors.oauthCallback',
    actorUserId: state.userId,
    status: 'connected',
    targetId: connector.id,
  });
  return state.returnTo ? { returnTo: state.returnTo } : {};
};

const recoverFailedCallback = async (params: {
  catalog: PlatformConnectorCatalogRepository;
  db: LobeChatDatabase;
  dependencies: ConnectorOAuthRuntimeDependencies;
  error: unknown;
  exchangeAttempted: boolean;
  reservation: ReservedOAuthState;
  state: PlatformConnectorOAuthStateItem;
  stateHash: string;
  unboundTokenRef: string | undefined;
}): Promise<never> => {
  const {
    catalog,
    db,
    dependencies,
    error,
    exchangeAttempted,
    reservation,
    state,
    stateHash,
    unboundTokenRef,
  } = params;
  await bestEffortRevokeSecret(
    dependencies,
    state.connectorId,
    'oauthBindingToken',
    unboundTokenRef,
    db,
  );
  if (exchangeAttempted) {
    try {
      await catalog.failOAuthStateReservation(
        stateHash,
        reservation.reservedAt,
        (dependencies.clock ?? (() => new Date()))(),
      );
    } catch (statusError) {
      console.error('[connectorOAuth] failure outcome persistence failed', {
        errorClass: statusError instanceof Error ? statusError.name : 'UnknownError',
      });
    }
    await bestEffortRevokeSecret(
      dependencies,
      state.connectorId,
      'oauthPkceVerifier',
      state.pkceVerifierRef,
      db,
    );
  } else {
    await catalog.releaseOAuthStateReservation(stateHash, reservation.reservedAt);
  }
  if (error instanceof PlatformConnectorContractError) throw error;
  throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
};

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
      await revokePkceRefs(reservation, this.dependencies, this.db);
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
    const reservation = await admitReservedOAuthState(
      await this.catalog.reserveOAuthState(stateHash),
      this.dependencies,
      this.db,
    );

    const state = reservation.state;
    let exchangeAttempted = false;
    const unboundToken: { ref?: string } = {};
    try {
      const [snapshot, current] = await Promise.all([
        this.read.getSnapshot(state.connectorId),
        this.catalog.getConnector(state.connectorId),
      ]);
      const { connector, oauth } = assertCallbackBindingMatchesState({
        callbackRedirectUri: this.dependencies.callbackRedirectUri,
        current,
        snapshot,
        state,
      });
      await this.dependencies.outbound.preflightToken(oauth.tokenEndpoint);
      const { clientSecretValue, codeVerifier } = await resolveCallbackSecrets({
        connector,
        secrets: this.dependencies.secrets,
        state,
      });
      exchangeAttempted = true;
      const response = await this.dependencies.outbound.exchangeCode({
        clientId: oauth.clientId,
        clientSecret: clientSecretValue,
        code: command.code,
        codeVerifier,
        redirectUri: state.redirectUri,
        tokenEndpoint: oauth.tokenEndpoint,
      });
      const token = connectorOAuthTokenResponseSchema.safeParse(response.body);
      if (!token.success || !isPlainRecord(response.body)) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
      }
      return await persistExchangedBinding({
        connector,
        db: this.db,
        dependencies: this.dependencies,
        reservation,
        state,
        stateHash,
        token: token.data,
        unboundToken,
      });
    } catch (error) {
      return recoverFailedCallback({
        catalog: this.catalog,
        db: this.db,
        dependencies: this.dependencies,
        error,
        exchangeAttempted,
        reservation,
        state,
        stateHash,
        unboundTokenRef: unboundToken.ref,
      });
    }
  };
}

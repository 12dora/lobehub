/**
 * admin.aiProviderOAuth.* — shared platform device-flow connection.
 */
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminAiProviderOAuthDisconnectInputSchema,
  adminAiProviderOAuthDisconnectOutputSchema,
  adminAiProviderOAuthInitiateInputSchema,
  adminAiProviderOAuthInitiateOutputSchema,
  adminAiProviderOAuthPollInputSchema,
  adminAiProviderOAuthPollOutputSchema,
  adminAiProviderOAuthStatusInputSchema,
  adminAiProviderOAuthStatusOutputSchema,
} from '../../contracts/aiProviderOAuth';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import {
  withAllPlatformPermissions,
  withPlatformPermission,
} from '../../guards/platformPermission';
import { getSharedConnectionStatus } from './aiProviderOAuth.connectionStatus';
import { disconnectSharedProviderAccount } from './aiProviderOAuth.disconnect';
import { initiateSharedDeviceCode } from './aiProviderOAuth.initiate';
import { pollSharedAuthStatus } from './aiProviderOAuth.poll';
import { disconnectPermissions, sharedAccountPermissions } from './aiProviderOAuthSupport';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

export const adminAiProviderOAuthRouter = router({
  /**
   * Withdraw the shared platform account: clear the vault and publish, leaving the
   * provider row, its models, and its `enabled` flag untouched.
   *
   * `enabled` is deliberately left alone. `assertRemovedModelsUnused` treats a flip
   * to `enabled: false` as removing every published enabled model of this provider,
   * so any published agent or setting that pins one of them (the normal state of a
   * shared account) rolls the whole write back with PLATFORM_RESOURCE_IN_USE.
   * Clearing the vault while staying enabled is a no-op for that check; members
   * then fall back to their own credentials because a secret-less published
   * provider is omitted from the runtime projection.
   *
   * NOT a revocation at the authorization server: the provider-side grant stays valid until
   * it expires or is revoked in the provider's own console. The copy must not imply otherwise.
   */
  disconnect: adminBase
    .use(withAllPlatformPermissions([...disconnectPermissions]))
    .input(adminAiProviderOAuthDisconnectInputSchema)
    .output(adminAiProviderOAuthDisconnectOutputSchema)
    .mutation(disconnectSharedProviderAccount),

  /**
   * Read the shared connection state of one rotating-refresh provider.
   * Presence + expiry + masked account only; token material never leaves the server.
   */
  getConnectionStatus: adminBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.AI_PROVIDER_READ))
    .input(adminAiProviderOAuthStatusInputSchema)
    .output(adminAiProviderOAuthStatusOutputSchema)
    .query(getSharedConnectionStatus),

  /**
   * Request a device code for the shared platform account.
   * Persists nothing — only the sanitized audit trail of the attempt.
   *
   * Reauth is asserted on THIS step rather than only on the store: it is the click-driven
   * one, so a step-up prompt still has user activation, and a session fresh here covers the
   * whole device-code lifetime. A later poll can then never redeem the single-use grant
   * with a session it is about to reject.
   */
  initiateDeviceCode: adminBase
    .use(withAllPlatformPermissions([...sharedAccountPermissions]))
    .input(adminAiProviderOAuthInitiateInputSchema)
    .output(adminAiProviderOAuthInitiateOutputSchema)
    .mutation(initiateSharedDeviceCode),

  /**
   * Poll the authorization server once (the client drives the retry cadence) and,
   * on authorization, store the shared connection in the platform vault.
   *
   * The reauth freshness check runs BEFORE the token exchange: the device grant is
   * single-use, so a tick that could not store the result must not redeem it. Apart from
   * that check (which audits only when it denies) a tick that finds no authorization yet
   * writes nothing.
   *
   * Storing applies immediately (the service publishes unconditionally): a `stored: true`
   * result means the credentials are committed, while the provider's existing `enabled` state
   * is preserved. If the store fails after the grant was redeemed the poll returns
   * a terminal `denied` outcome with a stable code rather than throwing.
   */
  pollAuthStatus: adminBase
    .use(withAllPlatformPermissions([...sharedAccountPermissions]))
    .input(adminAiProviderOAuthPollInputSchema)
    .output(adminAiProviderOAuthPollOutputSchema)
    .mutation(pollSharedAuthStatus),
});

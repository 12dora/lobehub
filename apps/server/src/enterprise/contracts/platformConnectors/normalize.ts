import { z } from 'zod';

import {
  adminConnectorOAuthConfigInputSchema,
  connectorIdSchema,
  httpUrlSchema,
  PlatformConnectorContractError,
} from './common';
import {
  adminConnectorCreateDraftInputSchema,
  adminConnectorDraftSchema,
  adminConnectorUpdateDraftInputSchema,
} from './draft';
import {
  expectedSlotLeaves,
  projectPatchSlots,
  resolveSlotState,
  resolveTargetOauthConfig,
} from './normalizeUpdateSlots';
import type { TrustedConnectorSecretContext } from './secrets';
import {
  applySecretMutationState,
  assertConfiguredCurrentSecretsLoaded,
  assertConnectorPersistentFieldsSafe,
  assertCreateSecretSlots,
  assertDraftMatchesSecretSlots,
  assertNoKnownSecret,
  assertReplacementLeavesComplete,
  clearOnlySecretMutationSchema,
  emptySecretState,
  getSecretLeaves,
  resolveTrustedSecretLeaves,
} from './secrets';

export const adminConnectorCreateDerivedInputSchema = z
  .object({
    id: connectorIdSchema,
    serverRedirectUri: httpUrlSchema.optional(),
    toolIds: z.array(connectorIdSchema).max(1000),
  })
  .strict();

export const normalizeAdminConnectorCreateInput = (
  input: z.input<typeof adminConnectorCreateDraftInputSchema>,
  derivedInput: z.input<typeof adminConnectorCreateDerivedInputSchema>,
  secretContext: TrustedConnectorSecretContext,
) => {
  const command = adminConnectorCreateDraftInputSchema.parse(input);
  const derivedResult = adminConnectorCreateDerivedInputSchema.safeParse(derivedInput);
  if (!derivedResult.success) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  const derived = derivedResult.data;
  const tools = command.tools ?? [];
  if (tools.length !== derived.toolIds.length) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  const redirectUri =
    command.credentialMode === 'per_user_oauth'
      ? httpUrlSchema.parse(derived.serverRedirectUri)
      : null;
  const common = {
    connectionTest: null,
    description: command.description ?? null,
    displayName: command.displayName,
    enabled: command.enabled ?? true,
    endpoint: command.endpoint,
    id: derived.id,
    key: command.key,
    revision: 0,
    sort: command.sort ?? 0,
    status: 'draft',
    tools: tools.map((tool, index) => ({ ...tool, id: derived.toolIds[index] })),
    transport: command.transport,
  } as const;
  const draft = adminConnectorDraftSchema.parse(
    command.credentialMode === 'none'
      ? {
          ...common,
          credentialMode: 'none',
          oauthClientSecret: emptySecretState,
          oauthConfig: null,
          sharedSecret: emptySecretState,
        }
      : command.credentialMode === 'shared_service_account'
        ? {
            ...common,
            credentialMode: 'shared_service_account',
            oauthClientSecret: emptySecretState,
            oauthConfig: null,
            sharedSecret: applySecretMutationState(emptySecretState, command.sharedSecret, true),
          }
        : {
            ...common,
            credentialMode: 'per_user_oauth',
            oauthClientSecret: applySecretMutationState(
              emptySecretState,
              command.oauthClientSecret,
              true,
            ),
            oauthConfig: { ...command.oauthConfig, redirectUri },
            sharedSecret: emptySecretState,
          },
  );
  assertCreateSecretSlots(draft, secretContext);
  assertReplacementLeavesComplete(
    {
      oauthClientSecret:
        command.credentialMode === 'per_user_oauth' ? command.oauthClientSecret : undefined,
      sharedSecret:
        command.credentialMode === 'shared_service_account' ? command.sharedSecret : undefined,
    },
    secretContext,
  );
  assertConnectorPersistentFieldsSafe(draft, command.reason, secretContext);
  assertNoKnownSecret(
    {
      description: command.description,
      displayName: command.displayName,
      endpoint: command.endpoint,
      key: command.key,
      oauthConfig: command.credentialMode === 'per_user_oauth' ? command.oauthConfig : null,
      tools: command.tools,
    },
    getSecretLeaves(secretContext),
  );
  return { command, draft };
};

/** Merge a patch with the current complete Draft and re-validate the credential discriminant. */
export const normalizeAdminConnectorUpdateInput = (
  currentInput: z.input<typeof adminConnectorDraftSchema>,
  patchInput: z.input<typeof adminConnectorUpdateDraftInputSchema>,
  serverRedirectUri: string | undefined,
  secretContext: TrustedConnectorSecretContext,
) => {
  const current = adminConnectorDraftSchema.parse(currentInput);
  const patch = adminConnectorUpdateDraftInputSchema.parse(patchInput);
  if (patch.id !== current.id) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  const targetMode = patch.credentialMode ?? current.credentialMode;
  const switchingMode = targetMode !== current.credentialMode;
  const redirectUri =
    targetMode === 'per_user_oauth' ? httpUrlSchema.parse(serverRedirectUri) : null;
  assertConfiguredCurrentSecretsLoaded(current, secretContext);
  assertReplacementLeavesComplete(
    { oauthClientSecret: patch.oauthClientSecret, sharedSecret: patch.sharedSecret },
    secretContext,
  );

  if (targetMode !== 'shared_service_account' && patch.sharedSecret) {
    clearOnlySecretMutationSchema.parse(patch.sharedSecret);
  }
  if (targetMode !== 'per_user_oauth' && patch.oauthClientSecret) {
    clearOnlySecretMutationSchema.parse(patch.oauthClientSecret);
  }
  if (targetMode !== 'per_user_oauth') z.null().optional().parse(patch.oauthConfig);
  if (targetMode === 'per_user_oauth' && patch.oauthConfig === null) {
    adminConnectorOAuthConfigInputSchema.parse(patch.oauthConfig);
  }

  const oauthConfig = resolveTargetOauthConfig(current, patch, targetMode, redirectUri);
  const currentOauthInput =
    current.credentialMode === 'per_user_oauth'
      ? {
          authorizationEndpoint: current.oauthConfig.authorizationEndpoint,
          clientId: current.oauthConfig.clientId,
          issuer: current.oauthConfig.issuer,
          scopes: current.oauthConfig.scopes,
          tokenEndpoint: current.oauthConfig.tokenEndpoint,
        }
      : undefined;

  const candidate = adminConnectorDraftSchema.parse({
    ...current,
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.displayName !== undefined && { displayName: patch.displayName }),
    ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    ...(patch.endpoint !== undefined && { endpoint: patch.endpoint }),
    ...(patch.sort !== undefined && { sort: patch.sort }),
    ...(patch.tools !== undefined && { tools: patch.tools }),
    ...(patch.transport !== undefined && { transport: patch.transport }),
    credentialMode: targetMode,
    oauthClientSecret: resolveSlotState(
      'oauthClientSecret',
      current,
      patch,
      targetMode,
      switchingMode,
    ),
    oauthConfig,
    sharedSecret: resolveSlotState('sharedSecret', current, patch, targetMode, switchingMode),
  });
  const trusted = resolveTrustedSecretLeaves(secretContext);
  assertDraftMatchesSecretSlots(candidate, {
    oauthClientSecret: expectedSlotLeaves('oauthClientSecret', current, patch, targetMode, trusted),
    sharedSecret: expectedSlotLeaves('sharedSecret', current, patch, targetMode, trusted),
  });
  assertConnectorPersistentFieldsSafe(candidate, patch.reason, secretContext);

  return {
    candidate,
    patch: {
      ...patch,
      credentialMode: targetMode,
      ...projectPatchSlots(patch, targetMode, currentOauthInput),
    },
  };
};

import { z } from 'zod';

import type {
  connectorOAuthClientSecretMutationSchema,
  connectorSecretStateSchema,
  connectorSharedSecretMutationSchema,
} from './common';
import {
  connectorIdSchema,
  containsConnectorCredentialMaterial,
  PlatformConnectorContractError,
} from './common';
import type { adminConnectorDraftSchema } from './draft';

export const clearSecretMutation = { operation: 'clear' } as const;
export const emptySecretState = { configured: false, fingerprint: null, updatedAt: null } as const;
export const configuredSecretState = {
  configured: true,
  fingerprint: null,
  updatedAt: null,
} as const;
export const clearOnlySecretMutationSchema = z.object({ operation: z.literal('clear') }).strict();
export const connectorSecretSlotLeavesSchema = z
  .object({
    oauthClientSecret: z.array(z.string().min(1).max(32_768)).max(1000),
    sharedSecret: z.array(z.string().min(1).max(32_768)).max(1000),
  })
  .strict();

export interface ConnectorSecretSlotSources {
  oauthClientSecret?: unknown;
  sharedSecret?: unknown;
}

export interface ConnectorCurrentSecretLoader {
  loadCurrentSecretSources: (connectorId: string) => Promise<ConnectorSecretSlotSources>;
}

export interface TrustedConnectorSecretContext {
  readonly source: 'server-secret-store';
}

const trustedSecretContexts = new WeakMap<
  TrustedConnectorSecretContext,
  {
    connectorId: string;
    current: z.infer<typeof connectorSecretSlotLeavesSchema>;
    replacement: z.infer<typeof connectorSecretSlotLeavesSchema>;
  }
>();

const KNOWN_SECRET_STRUCTURE_KEYS = new Set([
  'accesstoken',
  'apikey',
  'bearertoken',
  'clientsecret',
  'oauthaccesstoken',
  'password',
  'refreshtoken',
  'secretaccesskey',
  'sessiontoken',
  'username',
]);
const DYNAMIC_SECRET_CONTAINER_KEYS = new Set(['customheaders', 'headers']);
const normalizeSecretStructureKey = (key: string): string =>
  key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');

const collectSecretLeafValues = (
  value: unknown,
  output: Set<string>,
  dynamicKeys = false,
): void => {
  if (typeof value === 'string') {
    if (value.length > 0) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectSecretLeafValues(item, output, dynamicKeys));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, item]) => {
    const normalizedKey = normalizeSecretStructureKey(key);
    const childHasDynamicKeys = DYNAMIC_SECRET_CONTAINER_KEYS.has(normalizedKey);
    if (dynamicKeys || (!KNOWN_SECRET_STRUCTURE_KEYS.has(normalizedKey) && !childHasDynamicKeys)) {
      collectSecretLeafValues(key, output, true);
    }
    collectSecretLeafValues(item, output, dynamicKeys || childHasDynamicKeys);
  });
};

/** Canonical schema-aware collector shared by contracts and services. */
export const collectConnectorSecretLeaves = (...secretSources: unknown[]): Set<string> => {
  const leaves = new Set<string>();
  secretSources.forEach((source) => collectSecretLeafValues(source, leaves));
  return leaves;
};

const collectSecretSlots = (sources: ConnectorSecretSlotSources) => {
  const oauthClientSecret = collectConnectorSecretLeaves(sources.oauthClientSecret);
  const sharedSecret = collectConnectorSecretLeaves(sources.sharedSecret);
  return connectorSecretSlotLeavesSchema.parse({
    oauthClientSecret: [...oauthClientSecret],
    sharedSecret: [...sharedSecret],
  });
};

/** Only this server-side loader path can mint a context accepted by the normalizers. */
export const loadTrustedConnectorSecretContext = async (
  loader: ConnectorCurrentSecretLoader,
  connectorId: string,
  replacementSecretSources: ConnectorSecretSlotSources,
): Promise<TrustedConnectorSecretContext> => {
  const currentSources = await loader.loadCurrentSecretSources(connectorId);
  const context = Object.freeze({ source: 'server-secret-store' as const });
  trustedSecretContexts.set(context, {
    connectorId: connectorIdSchema.parse(connectorId),
    current: collectSecretSlots(currentSources),
    replacement: collectSecretSlots(replacementSecretSources),
  });
  return context;
};

export const resolveTrustedSecretLeaves = (context: TrustedConnectorSecretContext) => {
  const trusted = trustedSecretContexts.get(context);
  if (!trusted) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  return trusted;
};

export type SecretMutation =
  | z.infer<typeof connectorOAuthClientSecretMutationSchema>
  | z.infer<typeof connectorSharedSecretMutationSchema>
  | undefined;

export const applySecretMutationState = (
  current: z.infer<typeof connectorSecretStateSchema>,
  mutation: SecretMutation,
  switchingMode: boolean,
) => {
  if (mutation?.operation === 'clear') return emptySecretState;
  if (mutation?.operation === 'replace') return configuredSecretState;
  return switchingMode ? emptySecretState : current;
};

export const assertNoKnownSecret = (value: unknown, secretLeaves: ReadonlySet<string>): void => {
  if (typeof value === 'string') {
    if (
      containsConnectorCredentialMaterial(value) ||
      [...secretLeaves].some((secret) => value.includes(secret))
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoKnownSecret(item, secretLeaves));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, item]) => {
    assertNoKnownSecret(key, secretLeaves);
    assertNoKnownSecret(item, secretLeaves);
  });
};

export const assertConnectorPersistentFieldsSafe = (
  draft: z.infer<typeof adminConnectorDraftSchema>,
  reason: string,
  secretContext: TrustedConnectorSecretContext,
): void => {
  const trusted = resolveTrustedSecretLeaves(secretContext);
  const secretLeaves = new Set([
    ...trusted.current.oauthClientSecret,
    ...trusted.current.sharedSecret,
    ...trusted.replacement.oauthClientSecret,
    ...trusted.replacement.sharedSecret,
  ]);
  assertNoKnownSecret(reason, secretLeaves);
  assertNoKnownSecret(
    {
      connectionTestMessage: draft.connectionTest?.messageCode,
      description: draft.description,
      displayName: draft.displayName,
      endpoint: draft.endpoint,
      key: draft.key,
      oauthConfig: draft.oauthConfig,
      tools: draft.tools.map((tool) => ({
        description: tool.description,
        displayName: tool.displayName,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        toolKey: tool.toolKey,
      })),
    },
    secretLeaves,
  );
};

export const getSecretLeaves = (
  secretContext: TrustedConnectorSecretContext,
): ReadonlySet<string> => {
  const trusted = resolveTrustedSecretLeaves(secretContext);
  return new Set([
    ...trusted.current.oauthClientSecret,
    ...trusted.current.sharedSecret,
    ...trusted.replacement.oauthClientSecret,
    ...trusted.replacement.sharedSecret,
  ]);
};

export const assertReplacementLeavesComplete = (
  mutations: { oauthClientSecret: SecretMutation; sharedSecret: SecretMutation },
  secretContext: TrustedConnectorSecretContext,
): void => {
  const provided = resolveTrustedSecretLeaves(secretContext).replacement;
  for (const slot of ['oauthClientSecret', 'sharedSecret'] as const) {
    const mutation = mutations[slot];
    const actual =
      mutation?.operation === 'replace'
        ? collectConnectorSecretLeaves(mutation.value)
        : new Set<string>();
    if (
      actual.size !== provided[slot].length ||
      [...actual].some((secret) => !provided[slot].includes(secret))
    ) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
    }
  }
};

const isConfiguredSlotConsistent = (configured: boolean, leaves: string[]): boolean =>
  configured ? leaves.length > 0 : leaves.length === 0;

export const assertConfiguredCurrentSecretsLoaded = (
  draft: z.infer<typeof adminConnectorDraftSchema>,
  secretContext: TrustedConnectorSecretContext,
): void => {
  const trusted = trustedSecretContexts.get(secretContext);
  if (!trusted) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  if (trusted.connectorId !== draft.id) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  const valid =
    draft.credentialMode === 'none'
      ? trusted.current.sharedSecret.length === 0 && trusted.current.oauthClientSecret.length === 0
      : draft.credentialMode === 'shared_service_account'
        ? isConfiguredSlotConsistent(draft.sharedSecret.configured, trusted.current.sharedSecret) &&
          trusted.current.oauthClientSecret.length === 0
        : isConfiguredSlotConsistent(
            draft.oauthClientSecret.configured,
            trusted.current.oauthClientSecret,
          ) && trusted.current.sharedSecret.length === 0;
  if (!valid) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
};

export const assertCreateSecretSlots = (
  draft: z.infer<typeof adminConnectorDraftSchema>,
  secretContext: TrustedConnectorSecretContext,
): void => {
  const trusted = resolveTrustedSecretLeaves(secretContext);
  if (trusted.connectorId !== draft.id) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_RESOURCE_MISMATCH');
  }
  if (trusted.current.oauthClientSecret.length > 0 || trusted.current.sharedSecret.length > 0) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  assertDraftMatchesSecretSlots(draft, trusted.replacement);
};

export const assertDraftMatchesSecretSlots = (
  draft: z.infer<typeof adminConnectorDraftSchema>,
  slots: z.infer<typeof connectorSecretSlotLeavesSchema>,
): void => {
  const valid =
    draft.credentialMode === 'none'
      ? slots.sharedSecret.length === 0 && slots.oauthClientSecret.length === 0
      : draft.credentialMode === 'shared_service_account'
        ? isConfiguredSlotConsistent(draft.sharedSecret.configured, slots.sharedSecret) &&
          slots.oauthClientSecret.length === 0
        : isConfiguredSlotConsistent(draft.oauthClientSecret.configured, slots.oauthClientSecret) &&
          slots.sharedSecret.length === 0;
  if (!valid) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
};

import { isPlainRecord } from '@lobechat/utils/object';

import type { PlatformConnectorRevisionPayload } from '@/database/repositories/platformConnectorCatalog';

import { containsConnectorCredentialMaterial } from '../../contracts/platformConnectors';
import { parseConnectorRevisionPayload } from './catalogSnapshot';
import type { ConnectorDraft } from './catalogTypes';
import { PlatformConnectorContractError } from './errors';

export const revisionSecretFingerprint = (
  payload: PlatformConnectorRevisionPayload,
): string | null =>
  payload.connector.credentialMode === 'shared_service_account'
    ? payload.connector.sharedSecretFingerprint
    : payload.connector.credentialMode === 'per_user_oauth'
      ? payload.connector.oauthClientSecretFingerprint
      : null;

export const assertNoRevisionCredentialMaterial = (
  value: unknown,
  secretLeaves: ReadonlySet<string>,
): void => {
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
    value.forEach((item) => assertNoRevisionCredentialMaterial(item, secretLeaves));
    return;
  }
  if (!isPlainRecord(value)) return;
  Object.entries(value).forEach(([key, child]) => {
    assertNoRevisionCredentialMaterial(key, secretLeaves);
    assertNoRevisionCredentialMaterial(child, secretLeaves);
  });
};

export const revisionPayload = (draft: ConnectorDraft): PlatformConnectorRevisionPayload =>
  parseConnectorRevisionPayload({
    connector: {
      credentialMode: draft.credentialMode,
      description: draft.description,
      displayName: draft.displayName,
      enabled: draft.enabled,
      endpoint: draft.endpoint,
      id: draft.id,
      key: draft.key,
      // Draft slot views already project ref-presence + fingerprints from the connector row.
      oauthClientSecretConfigured: draft.oauthClientSecret.configured,
      oauthClientSecretFingerprint: draft.oauthClientSecret.fingerprint,
      oauthConfig: draft.oauthConfig,
      sharedSecretConfigured: draft.sharedSecret.configured,
      sharedSecretFingerprint: draft.sharedSecret.fingerprint,
      sort: draft.sort,
      transport: 'http',
    },
    schemaVersion: 'm09-v1',
    tools: draft.tools
      .filter((tool) => tool.enabled)
      .map((tool) => ({
        description: tool.description,
        displayName: tool.displayName,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        platformPolicy: tool.platformPolicy,
        requiresConfirmation: tool.requiresConfirmation,
        riskLevel: tool.riskLevel,
        sort: tool.sort,
        toolKey: tool.toolKey,
      })),
  });

/**
 * Strict persisted projection. Do not use the generic key-name redactor here:
 * OAuth and JSON Schema deliberately contain semantic names such as
 * `authorizationEndpoint`, `apiKey`, and `password`.
 */
export const sanitizeConnectorRevisionPayload = (
  rawPayload: Record<string, unknown>,
): PlatformConnectorRevisionPayload => {
  const payload = parseConnectorRevisionPayload(rawPayload);
  const connector = payload.connector;
  return {
    connector: {
      credentialMode: connector.credentialMode,
      description: connector.description,
      displayName: connector.displayName,
      enabled: connector.enabled,
      endpoint: connector.endpoint,
      id: connector.id,
      key: connector.key,
      oauthClientSecretConfigured: connector.oauthClientSecretConfigured,
      oauthClientSecretFingerprint: connector.oauthClientSecretFingerprint,
      oauthConfig: connector.oauthConfig
        ? {
            authorizationEndpoint: connector.oauthConfig.authorizationEndpoint,
            clientId: connector.oauthConfig.clientId,
            issuer: connector.oauthConfig.issuer,
            redirectUri: connector.oauthConfig.redirectUri,
            scopes: [...connector.oauthConfig.scopes],
            tokenEndpoint: connector.oauthConfig.tokenEndpoint,
          }
        : null,
      sharedSecretConfigured: connector.sharedSecretConfigured,
      sharedSecretFingerprint: connector.sharedSecretFingerprint,
      sort: connector.sort,
      transport: connector.transport,
    },
    schemaVersion: 'm09-v1',
    tools: payload.tools.map((tool) => ({
      description: tool.description,
      displayName: tool.displayName,
      inputSchema: structuredClone(tool.inputSchema),
      outputSchema: structuredClone(tool.outputSchema),
      platformPolicy: tool.platformPolicy,
      requiresConfirmation: tool.requiresConfirmation,
      riskLevel: tool.riskLevel,
      sort: tool.sort,
      toolKey: tool.toolKey,
    })),
  };
};

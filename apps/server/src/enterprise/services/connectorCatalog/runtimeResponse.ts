import { isPlainRecord } from '@lobechat/utils/object';
import type { z } from 'zod';

import type { connectorSharedCredentialReadSchema } from '../../contracts/platformConnectors';
import { redactDeep } from '../../security/redaction';
import { PlatformConnectorContractError } from './errors';
import type { ConnectorRuntimeJournalToken } from './runtimeExecutionJournal';

export const shouldAuditSharedFailure = (
  connector: { credentialMode: string },
  outboundStarted: boolean,
  journalToken: ConnectorRuntimeJournalToken | undefined,
  error: unknown,
): boolean =>
  connector.credentialMode === 'shared_service_account' &&
  !(outboundStarted && journalToken) &&
  !(
    error instanceof PlatformConnectorContractError &&
    (error.code === 'PLATFORM_CONNECTOR_RATE_LIMITED' ||
      error.code === 'PLATFORM_CONNECTOR_NOT_PUBLISHED' ||
      error.code === 'PLATFORM_CONNECTOR_RESOURCE_MISMATCH')
  );

export const parseArguments = (
  value: string | Record<string, unknown>,
): Record<string, unknown> => {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
  }
  if (!isPlainRecord(parsed)) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
  }
  return parsed;
};

export const sharedCredentialHeaders = (
  credential: z.infer<typeof connectorSharedCredentialReadSchema>,
): Record<string, string> => ({
  ...credential.headers,
  ...(credential.apiKey ? { Authorization: `Bearer ${credential.apiKey}` } : {}),
  ...(credential.bearerToken ? { Authorization: `Bearer ${credential.bearerToken}` } : {}),
  ...(credential.username && credential.password
    ? {
        Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
      }
    : {}),
});

const redactTaintedString = (value: string, taintedValues: string[]): string => {
  let redacted = value;
  for (const taint of new Set(taintedValues.filter(Boolean))) {
    const variants = new Set([
      taint,
      encodeURIComponent(taint),
      Buffer.from(taint).toString('base64'),
      Buffer.from(taint).toString('base64url'),
    ]);
    for (const variant of variants) redacted = redacted.split(variant).join('[REDACTED]');
  }
  return redacted;
};

const redactTaintedDeep = (value: unknown, taintedValues: string[]): unknown => {
  if (typeof value === 'string') return redactTaintedString(value, taintedValues);
  if (Array.isArray(value)) return value.map((item) => redactTaintedDeep(item, taintedValues));
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      redactTaintedString(key, taintedValues),
      redactTaintedDeep(child, taintedValues),
    ]),
  );
};

export const parseRuntimeResponse = (
  body: unknown,
  taintedValues: string[],
): { content: string; state?: Record<string, unknown> } => {
  if (!isPlainRecord(body) || 'error' in body) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
  }
  const value = 'result' in body ? body.result : body;
  const redacted = redactDeep(redactTaintedDeep(value, taintedValues));
  const content = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  return {
    content,
    ...(isPlainRecord(redacted) ? { state: redacted } : {}),
  };
};

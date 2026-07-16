import { containsSensitiveMaterial, isCredentialBearingUrl } from '../../security/redaction';
import { PlatformConnectorContractError } from './errors';

export type ConnectorOperationErrorCategory =
  'auth' | 'invalid_config' | 'network' | 'policy' | 'protocol';

const FIXED_OPERATION_MESSAGES = {
  failure: 'Connector operation failed',
  pending: 'Connector operation pending',
  success: 'Connector operation succeeded',
} as const;

export const collectConnectorSecretLeaves = (...secretSources: unknown[]): Set<string> => {
  const leaves = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.length > 0) leaves.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(visit);
  };
  secretSources.forEach(visit);
  return leaves;
};

export const assertConnectorPersistentTextSafe = (
  value: string,
  secretLeaves: ReadonlySet<string>,
): string => {
  if (
    containsSensitiveMaterial(value) ||
    isCredentialBearingUrl(value) ||
    [...secretLeaves].some((secret) => value.includes(secret))
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  return value;
};

/** Never persist or return an upstream exception/body; emit only fixed product copy. */
export const fixedConnectorOperationResult = (
  status: keyof typeof FIXED_OPERATION_MESSAGES,
  errorCategory: ConnectorOperationErrorCategory | null,
) => ({ errorCategory, sanitizedMessage: FIXED_OPERATION_MESSAGES[status], status });

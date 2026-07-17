import {
  collectConnectorSecretLeaves,
  CONNECTOR_OPERATION_MESSAGE_BY_STATUS,
  containsConnectorCredentialMaterial,
} from '../../contracts/platformConnectors';
import { PlatformConnectorContractError } from './errors';

export type ConnectorOperationErrorCategory =
  'auth' | 'invalid_config' | 'network' | 'policy' | 'protocol';

export { collectConnectorSecretLeaves };

export const assertConnectorPersistentTextSafe = (
  value: string,
  secretLeaves: ReadonlySet<string>,
): string => {
  if (
    containsConnectorCredentialMaterial(value) ||
    [...secretLeaves].some((secret) => value.includes(secret))
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  return value;
};

/** Never persist or return an upstream exception/body; emit only fixed product copy. */
export const fixedConnectorOperationResult = (
  status: keyof typeof CONNECTOR_OPERATION_MESSAGE_BY_STATUS,
  errorCategory: ConnectorOperationErrorCategory | null,
) => ({ errorCategory, messageCode: CONNECTOR_OPERATION_MESSAGE_BY_STATUS[status], status });

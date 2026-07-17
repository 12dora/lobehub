import type { ManagedConnector, ManagedConnectorBinding } from './types';

export type ConnectorAvailability = 'available' | 'authorization_required' | 'unavailable';

export const resolveConnectorAvailability = (
  connector: ManagedConnector,
): ConnectorAvailability => {
  if (connector.credentialMode !== 'per_user_oauth') return 'available';
  return connector.binding?.status === 'connected' ? 'available' : 'authorization_required';
};

export const isConnectorAuthorizationBusy = (
  busyConnectorId: string | null,
  connectorId: string,
): boolean => busyConnectorId === connectorId;

export const canDisconnectConnector = (binding: ManagedConnectorBinding | null): boolean =>
  Boolean(binding && ['connected', 'error', 'expired', 'pending'].includes(binding.status));

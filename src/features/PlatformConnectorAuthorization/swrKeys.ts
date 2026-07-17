import type { UserConnectorListInput } from './types';

export const MANAGED_CONNECTOR_LIST_KEY = 'managedConnector.list';

export const buildManagedConnectorListKey = (input: UserConnectorListInput) => [
  MANAGED_CONNECTOR_LIST_KEY,
  input.cursor ?? null,
  input.limit,
  input.query ?? null,
];

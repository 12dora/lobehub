import type { z } from 'zod';

import type {
  connectorBindingSchema,
  managedConnectorSchema,
  userConnectorDisconnectInputSchema,
  userConnectorDisconnectOutputSchema,
  userConnectorGetAuthorizationStatusInputSchema,
  userConnectorGetAuthorizationStatusOutputSchema,
  userConnectorListManagedInputSchema,
  userConnectorListManagedOutputSchema,
  userConnectorStartAuthorizationInputSchema,
  userConnectorStartAuthorizationOutputSchema,
} from '@/server/enterprise/contracts/platformConnectors';

export type ManagedConnector = z.infer<typeof managedConnectorSchema>;
export type ManagedConnectorBinding = z.infer<typeof connectorBindingSchema>;
export type UserConnectorDisconnectInput = z.infer<typeof userConnectorDisconnectInputSchema>;
export type UserConnectorDisconnectOutput = z.infer<typeof userConnectorDisconnectOutputSchema>;
export type UserConnectorAuthorizationStatusInput = z.infer<
  typeof userConnectorGetAuthorizationStatusInputSchema
>;
export type UserConnectorAuthorizationStatusOutput = z.infer<
  typeof userConnectorGetAuthorizationStatusOutputSchema
>;
export type UserConnectorListInput = z.infer<typeof userConnectorListManagedInputSchema>;
export type UserConnectorListOutput = z.infer<typeof userConnectorListManagedOutputSchema>;
export type UserConnectorStartAuthorizationInput = z.infer<
  typeof userConnectorStartAuthorizationInputSchema
>;
export type UserConnectorStartAuthorizationOutput = z.infer<
  typeof userConnectorStartAuthorizationOutputSchema
>;

import type { z } from 'zod';

import type { platformConnectorErrorCodeSchema } from '../../contracts/platformConnectors';

export type PlatformConnectorErrorCode = z.infer<typeof platformConnectorErrorCodeSchema>;

export class PlatformConnectorContractError extends Error {
  constructor(public readonly code: PlatformConnectorErrorCode) {
    super(code);
    this.name = 'PlatformConnectorContractError';
  }
}

import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { PlatformConnectorContractError } from '../services/connectorCatalog/errors';
import {
  assertLegacyConnectorTransportAllowed,
  mapConnectorRuntimeTransportError,
} from './connectorRuntimeTransport';

describe('assertLegacyConnectorTransportAllowed', () => {
  it.each([
    ['enforced', 'FORBIDDEN', 'PLATFORM_CONNECTOR_TOOL_DENIED'],
    ['blocked', 'PRECONDITION_FAILED', 'PLATFORM_CONNECTOR_NOT_PUBLISHED'],
  ] as const)('maps %s to a stable tRPC business contract', async (mode, code, message) => {
    const error = await assertLegacyConnectorTransportAllowed({
      env: { ENABLE_PLATFORM_MANAGED_CONNECTORS: 'true' },
      resolveState: async () => ({ mode, revision: 4 }),
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code, message });
  });

  it('maps a second service-level guard failure without losing the business contract', () => {
    const error = mapConnectorRuntimeTransportError(
      new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED'),
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: 'FORBIDDEN', message: 'PLATFORM_CONNECTOR_TOOL_DENIED' });
  });
});

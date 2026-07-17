import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { assertLegacyConnectorTransportAllowed } from './connectorRuntimeTransport';

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
});

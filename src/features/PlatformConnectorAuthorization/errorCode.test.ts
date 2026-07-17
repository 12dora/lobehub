import { describe, expect, it } from 'vitest';

import { resolveConnectorErrorCode } from './errorCode';

describe('resolveConnectorErrorCode', () => {
  it('keeps stable Connector contract codes', () => {
    expect(resolveConnectorErrorCode(new Error('PLATFORM_CONNECTOR_RATE_LIMITED'))).toBe(
      'PLATFORM_CONNECTOR_RATE_LIMITED',
    );
  });

  it('reads the structured client error code', () => {
    expect(resolveConnectorErrorCode({ data: { code: 'PLATFORM_CONNECTOR_TOOL_DENIED' } })).toBe(
      'PLATFORM_CONNECTOR_TOOL_DENIED',
    );
  });

  it('does not render arbitrary server text', () => {
    expect(resolveConnectorErrorCode(new Error('upstream token=secret'))).toBe(
      'PLATFORM_CONNECTOR_UNKNOWN_ERROR',
    );
  });
});

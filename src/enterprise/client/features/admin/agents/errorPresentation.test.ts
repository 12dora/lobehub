import { describe, expect, it, vi } from 'vitest';

import { getAdminAgentErrorMessage } from './errorPresentation';

const translate = vi.fn((key: string) => key);

describe('getAdminAgentErrorMessage', () => {
  it('maps a structured enterprise error without exposing its raw message', () => {
    const raw = 'database host and credential detail';
    const error = {
      data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
      message: raw,
    };

    const message = getAdminAgentErrorMessage(error, translate as never);

    expect(message).toBe('enterprise.error.PLATFORM_PERMISSION_DENIED');
    expect(message).not.toContain(raw);
  });

  it('uses a safe localized fallback for unknown errors', () => {
    const raw = 'SQLSTATE 08006 password=do-not-render';

    const message = getAdminAgentErrorMessage(new Error(raw), translate as never);

    expect(message).toBe('agentCatalog.errors.generic');
    expect(message).not.toContain(raw);
  });
});

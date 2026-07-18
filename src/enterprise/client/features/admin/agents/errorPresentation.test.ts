import { describe, expect, it, vi } from 'vitest';

import { getAdminAgentErrorMessage } from './errorPresentation';

describe('getAdminAgentErrorMessage', () => {
  it('maps a structured enterprise error to an existing admin message', () => {
    const raw = 'database host and credential detail';
    const error = {
      data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
      message: raw,
    };
    const translate = vi.fn((key: string) =>
      key === 'users.errors.permissionDenied' ? 'You do not have permission for this action.' : key,
    );

    const message = getAdminAgentErrorMessage(error, translate as never);

    expect(message).toBe('You do not have permission for this action.');
    expect(message).not.toContain('PLATFORM_PERMISSION_DENIED');
    expect(message).not.toContain(raw);
  });

  it('uses the safe generic locale when the mapped key is missing without a code defaultValue', () => {
    const raw = 'database host and credential detail';
    const error = {
      data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
      message: raw,
    };
    const translate = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === 'agentCatalog.errors.generic') return 'Safe localized Agent failure.';
      return options?.defaultValue ?? key;
    });

    const message = getAdminAgentErrorMessage(error, translate as never);

    expect(message).toBe('Safe localized Agent failure.');
    expect(message).not.toContain('PLATFORM_PERMISSION_DENIED');
    expect(message).not.toContain(raw);
    expect(translate).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultValue: 'PLATFORM_PERMISSION_DENIED' }),
    );
  });

  it('uses a safe localized fallback for unknown errors', () => {
    const raw = 'SQLSTATE 08006 password=do-not-render';
    const translate = vi.fn((key: string) =>
      key === 'agentCatalog.errors.generic' ? 'Safe localized Agent failure.' : key,
    );

    const message = getAdminAgentErrorMessage(new Error(raw), translate as never);

    expect(message).toBe('Safe localized Agent failure.');
    expect(message).not.toContain(raw);
  });
});

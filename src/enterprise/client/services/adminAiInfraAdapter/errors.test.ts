import { toast } from '@lobehub/ui/base-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAdminAiInfraErrorToasted,
  notifyAdminAiInfraError,
  withAdminAiInfraErrorToast,
} from './errors';

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('i18next', () => ({
  default: {
    t: (key: string) => key,
  },
}));

vi.mock('@/enterprise/client/errors/mapEnterpriseError', () => ({
  mapEnterpriseError: () => null,
}));

describe('notifyAdminAiInfraError', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  it('never surfaces raw exception text for unmapped failures (XT-007 / AI-10)', () => {
    notifyAdminAiInfraError(new Error('ECONNRESET upstream socket hang up'));

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('aiInfraError.saveFailed');
    expect(vi.mocked(toast.error).mock.calls[0][0]).not.toMatch(/ECONNRESET|socket hang up/);
  });

  it('never surfaces raw string causes', () => {
    notifyAdminAiInfraError('proxy 502 bad gateway from internal mesh');

    expect(toast.error).toHaveBeenCalledWith('aiInfraError.saveFailed');
    expect(String(vi.mocked(toast.error).mock.calls[0][0])).not.toMatch(/502|mesh/);
  });
});

describe('withAdminAiInfraErrorToast', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  it('tags rethrown errors so adapters can avoid double-toasting', async () => {
    const cause = new Error('network down');
    expect(isAdminAiInfraErrorToasted(cause)).toBe(false);

    await expect(
      withAdminAiInfraErrorToast(async () => {
        throw cause;
      }),
    ).rejects.toBe(cause);

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(isAdminAiInfraErrorToasted(cause)).toBe(true);
  });
});

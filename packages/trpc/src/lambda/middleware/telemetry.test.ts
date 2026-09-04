// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appEnv } from '@/envs/app';

import { type TelemetryContext } from './telemetry';
import { checkTelemetryEnabled } from './telemetry';

const { mockResolveEffectiveTelemetry } = vi.hoisted(() => ({
  mockResolveEffectiveTelemetry: vi.fn(async () => false),
}));

vi.mock('@/envs/app', () => ({
  appEnv: {
    TELEMETRY_DISABLED: false,
  },
}));

vi.mock('@/server/enterprise/services/settings/resolveTelemetryPolicy', () => ({
  resolveEffectiveTelemetry: mockResolveEffectiveTelemetry,
}));

const ctx = (): TelemetryContext => ({
  serverDB: {} as TelemetryContext['serverDB'],
  userId: 'test-user',
});

describe('checkTelemetryEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(appEnv).TELEMETRY_DISABLED = false;
    mockResolveEffectiveTelemetry.mockResolvedValue(false);
  });

  describe('environment variable priority (highest)', () => {
    it('should return telemetryEnabled: false when TELEMETRY_DISABLED=true', async () => {
      vi.mocked(appEnv).TELEMETRY_DISABLED = true;

      const result = await checkTelemetryEnabled(ctx());

      expect(result).toEqual({ telemetryEnabled: false });
      expect(mockResolveEffectiveTelemetry).not.toHaveBeenCalled();
    });

    it('should resolve effective telemetry when TELEMETRY_DISABLED is false', async () => {
      await checkTelemetryEnabled(ctx());

      expect(mockResolveEffectiveTelemetry).toHaveBeenCalledWith({
        db: expect.anything(),
        userId: 'test-user',
      });
    });

    it('should resolve effective telemetry when TELEMETRY_DISABLED is undefined', async () => {
      vi.mocked(appEnv).TELEMETRY_DISABLED = undefined;

      await checkTelemetryEnabled(ctx());

      expect(mockResolveEffectiveTelemetry).toHaveBeenCalled();
    });

    it('TELEMETRY_DISABLED wins over an explicit opt-in and a locked-true policy', async () => {
      vi.mocked(appEnv).TELEMETRY_DISABLED = true;
      mockResolveEffectiveTelemetry.mockResolvedValue(true);

      const result = await checkTelemetryEnabled(ctx());

      expect(result).toEqual({ telemetryEnabled: false });
      expect(mockResolveEffectiveTelemetry).not.toHaveBeenCalled();
    });
  });

  describe('effective resolver', () => {
    it('returns the resolver result in one call', async () => {
      mockResolveEffectiveTelemetry.mockResolvedValue(true);

      const result = await checkTelemetryEnabled(ctx());

      expect(result).toEqual({ telemetryEnabled: true });
      expect(mockResolveEffectiveTelemetry).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the platform resolver is unavailable', async () => {
      mockResolveEffectiveTelemetry.mockRejectedValue(new Error('platform module missing'));

      const result = await checkTelemetryEnabled(ctx());

      expect(result).toEqual({ telemetryEnabled: false });
    });
  });

  describe('missing context', () => {
    it('should return telemetryEnabled: false when userId is missing', async () => {
      const result = await checkTelemetryEnabled({
        serverDB: {} as TelemetryContext['serverDB'],
        userId: null,
      });

      expect(result).toEqual({ telemetryEnabled: false });
      expect(mockResolveEffectiveTelemetry).not.toHaveBeenCalled();
    });

    it('should return telemetryEnabled: false when serverDB is missing', async () => {
      const result = await checkTelemetryEnabled({
        serverDB: undefined,
        userId: 'test-user',
      });

      expect(result).toEqual({ telemetryEnabled: false });
      expect(mockResolveEffectiveTelemetry).not.toHaveBeenCalled();
    });
  });
});

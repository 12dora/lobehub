// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isBootModuleEnabled: vi.fn((_id: string) => true),
}));

vi.mock('../services/moduleSettings', () => ({
  isBootModuleEnabled: (id: string) => mocks.isBootModuleEnabled(id),
  moduleDisabledError: (id: string) => ({
    code: 'PLATFORM_MODULE_DISABLED',
    details: { moduleId: id },
    httpCode: 'FORBIDDEN' as const,
    message: 'PLATFORM_MODULE_DISABLED',
  }),
}));

vi.mock('./enterpriseErrors', () => ({
  throwEnterpriseError: (params: { code: string }) => {
    throw new Error(params.code);
  },
}));

vi.mock('ffmpeg-static', () => ({
  default: '/usr/bin/ffmpeg-static-mock',
}));

afterEach(() => {
  mocks.isBootModuleEnabled.mockReset();
  mocks.isBootModuleEnabled.mockReturnValue(true);
  vi.resetModules();
});

describe('resolveFfmpegStatic', () => {
  it('imports ffmpeg-static when imageGen is enabled at boot', async () => {
    const { resolveFfmpegStatic } = await import('./ffmpegStatic');
    await expect(resolveFfmpegStatic()).resolves.toBe('/usr/bin/ffmpeg-static-mock');
    expect(mocks.isBootModuleEnabled).toHaveBeenCalledWith('imageGen');
  });

  it('does not import ffmpeg-static when imageGen is off', async () => {
    mocks.isBootModuleEnabled.mockReturnValue(false);
    const { resolveFfmpegStatic } = await import('./ffmpegStatic');
    await expect(resolveFfmpegStatic()).rejects.toThrow('PLATFORM_MODULE_DISABLED');
  });
});

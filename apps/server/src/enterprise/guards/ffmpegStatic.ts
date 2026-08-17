/**
 * Boot-gated loader for `ffmpeg-static`.
 * (p5-4 cache probe: source-only comment; layer-a must stay CACHED)
 *
 * The binary is ~49 MiB and is only used by video generation. Gate the
 * dynamic import behind `imageGen` so a later image can drop the file
 * without MODULE_NOT_FOUND on boot. The default (full) image still ships
 * the binary — `serverExternalPackages` lists it and WITH_VIDEO was
 * reverted in phase 1 for that reason.
 */
import { isBootModuleEnabled, moduleDisabledError } from '../services/moduleSettings';
import { throwEnterpriseError } from './enterpriseErrors';

export const resolveFfmpegStatic = async (): Promise<string> => {
  if (!isBootModuleEnabled('imageGen')) {
    throwEnterpriseError(moduleDisabledError('imageGen'));
  }

  const loaded = await import('ffmpeg-static');
  const resolved = (loaded as { default?: unknown }).default ?? loaded;
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error('ffmpeg-static resolved to an empty path');
  }
  return resolved;
};

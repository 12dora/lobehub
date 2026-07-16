/**
 * GET /.well-known/easyauth-app.json — EasyAuth application descriptor (M02).
 *
 * Descriptor payload is built from `@/const/platform` (no server enterprise import)
 * so path-boundary CI stays green. Optional descriptor token is read from env here.
 */
import { timingSafeEqual } from 'node:crypto';

import { EASYAUTH_ENV } from '@/const/platform/easyauth';
import { buildEasyauthDescriptor } from '@/const/platform/easyauthManifest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const readSchemaVersion = (): number => {
  const raw = process.env[EASYAUTH_ENV.MANIFEST_SCHEMA_VERSION];
  const n = raw ? Number(raw) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
};

const safeEqualString = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

export const GET = async (request: Request) => {
  const descriptorToken = process.env[EASYAUTH_ENV.DESCRIPTOR_TOKEN]?.trim();
  const cacheControl = descriptorToken ? 'no-store' : 'public, max-age=60';

  if (descriptorToken) {
    const header = request.headers.get('authorization') || '';
    const prefix = 'Bearer ';
    const token =
      header.length > prefix.length && header.toLowerCase().startsWith('bearer ')
        ? header.slice(prefix.length).trim()
        : '';
    if (!token || !safeEqualString(token, descriptorToken)) {
      return Response.json(
        { error: 'unauthorized' },
        { headers: { 'Cache-Control': 'no-store' }, status: 401 },
      );
    }
  }

  const descriptor = buildEasyauthDescriptor({
    schemaVersion: readSchemaVersion(),
  });

  return Response.json(descriptor, {
    headers: {
      'Cache-Control': cacheControl,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
};

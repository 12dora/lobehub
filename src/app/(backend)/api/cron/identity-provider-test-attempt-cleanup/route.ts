import { timingSafeEqual } from 'node:crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface IdentityProviderTestAttemptCleanupRouteDependencies {
  runCleanup?: () => Promise<number>;
}

const authorized = (request: Request): boolean => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const runCleanup = async (): Promise<number> => {
  const { runIdentityProviderTestAttemptCleanup } =
    await import('@/server/enterprise/jobs/identityProviderTestAttemptCleanup');
  return runIdentityProviderTestAttemptCleanup();
};

/**
 * Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. Missing or mismatched credentials fail
 * closed before importing the cleanup job, which in turn gates DB acquisition on database OIDC.
 */
export const createIdentityProviderTestAttemptCleanupHandler = (
  dependencies: IdentityProviderTestAttemptCleanupRouteDependencies = {},
) =>
  async function GET(request: Request): Promise<Response> {
    if (!authorized(request)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    try {
      const deleted = await (dependencies.runCleanup ?? runCleanup)();
      return Response.json({ deleted }, { headers: { 'Cache-Control': 'no-store' }, status: 200 });
    } catch (error) {
      console.error('[identity-provider-test-attempt-cleanup] scheduled cleanup failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
      return Response.json(
        { error: 'cleanup_failed' },
        { headers: { 'Cache-Control': 'no-store' }, status: 500 },
      );
    }
  };

export const GET = createIdentityProviderTestAttemptCleanupHandler();

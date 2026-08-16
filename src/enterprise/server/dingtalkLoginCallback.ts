import { type NextRequest, NextResponse } from 'next/server';

import { appEnv } from '@/envs/app';
import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import { getIdentityProviderRuntimeArtifact } from '@/server/enterprise/services/identityProvider/startupArtifact';

/**
 * DingTalk → Better Auth callback shim.
 *
 * DingTalk's 统一登录 redirects back with the authorization code in **`authCode`**, while Better
 * Auth's generic-OAuth callback (`/api/auth/oauth2/callback/:providerId`) only reads the OAuth 2.0
 * standard `code`. Rather than fork Better Auth, DingTalk login methods register THIS path as
 * their redirect URL; it rewrites the parameter and forwards the browser to the real callback.
 *
 * Why a same-origin 302 is safe here:
 * - the redirect target is built from `APP_URL` plus a fixed path, so it can never leave this
 *   origin (no open redirect) and the browser re-sends the state cookie Better Auth signed;
 * - only the OAuth 2.0 authorization-response parameters are forwarded (allowlist below), so a
 *   crafted DingTalk redirect cannot smuggle extra query parameters into Better Auth;
 * - nothing is read from the request body, no database access, and no credential is touched —
 *   the authorization code stays opaque and is exchanged only by the runtime adapter.
 */

/** Same shape the platform enforces for `providerKey`. */
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** OAuth 2.0 authorization-response parameters Better Auth understands. */
const FORWARDED_PARAMS = ['state', 'error', 'error_description', 'error_uri', 'iss'] as const;

const notFound = (): NextResponse =>
  new NextResponse(null, { headers: { 'cache-control': 'no-store' }, status: 404 });

export const handleDingTalkLoginCallback = async (
  request: NextRequest,
  context: { params: Promise<{ providerKey?: string }> },
): Promise<NextResponse> => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_DATABASE_OIDC) return notFound();

  const { providerKey } = await context.params;
  if (!providerKey || !PROVIDER_KEY_PATTERN.test(providerKey)) return notFound();

  // The shim exists for exactly one kind. Forwarding an unknown key — or a key belonging to an
  // OIDC provider, whose callback must keep receiving the standard `code` — would turn this into
  // a generic parameter-rewriting relay in front of the login callback.
  const isActiveDingTalkProvider = getIdentityProviderRuntimeArtifact().databaseProviders.some(
    (provider) => provider.providerKey === providerKey && provider.type === 'dingtalk',
  );
  if (!isActiveDingTalkProvider) return notFound();

  let target: URL;
  try {
    target = new URL(`/api/auth/oauth2/callback/${providerKey}`, appEnv.APP_URL);
  } catch {
    return notFound();
  }

  const incoming = request.nextUrl.searchParams;
  const code = incoming.get('authCode') ?? incoming.get('code');
  if (code) target.searchParams.set('code', code);
  for (const name of FORWARDED_PARAMS) {
    const value = incoming.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }

  return NextResponse.redirect(target, { headers: { 'cache-control': 'no-store' }, status: 302 });
};

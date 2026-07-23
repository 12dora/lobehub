import { type NextRequest, NextResponse } from 'next/server';

import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';
import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import { createAdminIdentityProviderRuntime } from '@/server/enterprise/routers/admin/identityProvidersSupport';

const isTruthy = (value: string | undefined): boolean =>
  value === '1' || value?.toLowerCase() === 'true';

const parseSingleHeader = (value: string | null): string | null => {
  const normalized = value?.trim();
  if (!normalized || normalized.includes(',') || /[\r\n]/.test(normalized)) return null;
  return normalized;
};

const optionalSingleHeader = (value: string | null): string | undefined => {
  if (value === null) return undefined;
  const parsed = parseSingleHeader(value);
  if (!parsed) throw new Error('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
  return parsed;
};

const parseHttpOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
};

export const resolveIdentityProviderCallbackOrigin = (
  request: NextRequest,
  env: Record<string, string | undefined>,
): string => {
  const canonicalOrigin = parseHttpOrigin(env.APP_URL ?? '');
  if (!canonicalOrigin) throw new Error('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
  const allowedOrigins = new Set([canonicalOrigin]);
  for (const candidate of env.AUTH_TRUSTED_ORIGINS?.split(',') ?? []) {
    const origin = parseHttpOrigin(candidate.trim());
    if (origin) allowedOrigins.add(origin);
  }

  let protocol = request.nextUrl.protocol.replace(':', '');
  let host = optionalSingleHeader(request.headers.get('host')) ?? request.nextUrl.host;
  if (isTruthy(env.OIDC_TRUST_PROXY_HEADERS)) {
    protocol = optionalSingleHeader(request.headers.get('x-forwarded-proto')) ?? protocol;
    host = optionalSingleHeader(request.headers.get('x-forwarded-host')) ?? host;
    const forwardedPort = optionalSingleHeader(request.headers.get('x-forwarded-port'));
    if (forwardedPort) {
      if (!/^\d{1,5}$/.test(forwardedPort) || Number(forwardedPort) > 65_535) {
        throw new Error('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
      }
      const parsed = new URL(`${protocol}://${host}`);
      if (parsed.port && parsed.port !== forwardedPort) {
        throw new Error('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
      }
      parsed.port = forwardedPort;
      host = parsed.host;
    }
  }
  if (!['http', 'https'].includes(protocol)) throw new Error('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
  const effectiveOrigin = parseHttpOrigin(`${protocol}://${host}`);
  if (!effectiveOrigin || !allowedOrigins.has(effectiveOrigin)) {
    throw new Error('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
  }
  return effectiveOrigin;
};

const jsonForScript = (value: unknown): string =>
  JSON.stringify(value).replaceAll(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );

const renderTerminalPage = (success: boolean): NextResponse => {
  let targetOrigin: string;
  try {
    targetOrigin = new URL(appEnv.APP_URL).origin;
  } catch {
    targetOrigin = 'null';
  }
  const payload = jsonForScript({ success, type: 'aihub-identity-provider-test' });
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Identity provider test</title></head>
  <body><p>${success ? 'Test complete. You can close this window.' : 'Test failed. You can close this window and try again.'}</p>
    <script>(function(){try{if(window.opener){window.opener.postMessage(${payload},${jsonForScript(targetOrigin)});}}catch(e){}setTimeout(function(){window.close();},300);}());</script>
  </body>
</html>`;
  return new NextResponse(html, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
};

export const handleIdentityProviderTestCallback = async (
  request: NextRequest,
  db: LobeChatDatabase,
): Promise<NextResponse> => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_DATABASE_OIDC) {
    return renderTerminalPage(false);
  }
  let effectiveOrigin: string;
  try {
    effectiveOrigin = resolveIdentityProviderCallbackOrigin(request, process.env);
  } catch {
    return renderTerminalPage(false);
  }
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  // RFC 9207: preserve the authorization-response `iss` for exact-match validation.
  const iss = request.nextUrl.searchParams.get('iss');
  if (!state) return renderTerminalPage(false);

  try {
    const service = createAdminIdentityProviderRuntime(db).test;
    if (request.nextUrl.searchParams.has('error') || !code) {
      await service.abandon(state, effectiveOrigin);
      return renderTerminalPage(false);
    }
    const result = await service.callback({ code, effectiveOrigin, iss, state });
    return renderTerminalPage(result.valid);
  } catch (error) {
    // Neutral page for the browser; sanitized server log (name only) so a real callback failure
    // is not invisible in production.
    console.error('[identity-provider-test] callback failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return renderTerminalPage(false);
  }
};

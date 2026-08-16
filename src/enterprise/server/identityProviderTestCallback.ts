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

type CallbackLocale = 'en-US' | 'zh-CN';

const IDP_TEST_COPY = {
  'en-US': {
    fail: 'Test failed. You can close this window and try again.',
    success: 'Test complete. You can close this window.',
    title: 'Identity provider test',
  },
  'zh-CN': {
    fail: '测试失败。您可以关闭此窗口后重试。',
    success: '测试完成。您可以关闭此窗口。',
    title: '身份提供商测试',
  },
} as const satisfies Record<CallbackLocale, { fail: string; success: string; title: string }>;

/** Prefer zh-CN when Accept-Language ranks Chinese above English (or only Chinese). */
export const resolveCallbackLocale = (acceptLanguage: string | null): CallbackLocale => {
  if (!acceptLanguage) return 'en-US';
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tagRaw, ...params] = part.trim().split(';');
      const tag = (tagRaw ?? '').trim().toLowerCase();
      let q = 1;
      for (const param of params) {
        const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
        if (match) q = Number(match[1]);
      }
      return { index, q: Number.isFinite(q) ? q : 0, tag };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);

  for (const entry of ranked) {
    if (entry.tag === '*' || entry.q <= 0) continue;
    if (entry.tag.startsWith('zh')) return 'zh-CN';
    if (entry.tag.startsWith('en')) return 'en-US';
  }
  return 'en-US';
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const renderTerminalPage = (success: boolean, locale: CallbackLocale): NextResponse => {
  let targetOrigin: string;
  try {
    targetOrigin = new URL(appEnv.APP_URL).origin;
  } catch {
    targetOrigin = 'null';
  }
  const copy = IDP_TEST_COPY[locale];
  const message = success ? copy.success : copy.fail;
  const payload = jsonForScript({ success, type: 'aihub-identity-provider-test' });
  const html = `<!doctype html>
<html lang="${locale === 'zh-CN' ? 'zh-CN' : 'en'}">
  <head><meta charset="utf-8" /><title>${escapeHtml(copy.title)}</title></head>
  <body><p>${escapeHtml(message)}</p>
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
  const locale = resolveCallbackLocale(request.headers.get('accept-language'));
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_DATABASE_OIDC) {
    return renderTerminalPage(false, locale);
  }
  let effectiveOrigin: string;
  try {
    effectiveOrigin = resolveIdentityProviderCallbackOrigin(request, process.env);
  } catch {
    return renderTerminalPage(false, locale);
  }
  // DingTalk's 统一登录 returns the authorization code as `authCode`, not the OAuth 2.0
  // standard `code`. Accept both so one callback route serves every kind.
  const code =
    request.nextUrl.searchParams.get('code') ?? request.nextUrl.searchParams.get('authCode');
  const state = request.nextUrl.searchParams.get('state');
  // RFC 9207: preserve the authorization-response `iss` for exact-match validation.
  const iss = request.nextUrl.searchParams.get('iss');
  if (!state) return renderTerminalPage(false, locale);

  try {
    const service = createAdminIdentityProviderRuntime(db).test;
    if (request.nextUrl.searchParams.has('error') || !code) {
      await service.abandon(state, effectiveOrigin);
      return renderTerminalPage(false, locale);
    }
    const result = await service.callback({ code, effectiveOrigin, iss, state });
    return renderTerminalPage(result.valid, locale);
  } catch (error) {
    // Neutral page for the browser; sanitized server log (name only) so a real callback failure
    // is not invisible in production.
    console.error('[identity-provider-test] callback failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return renderTerminalPage(false, locale);
  }
};

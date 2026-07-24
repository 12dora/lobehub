import { type NextRequest, NextResponse } from 'next/server';

import type { LobeChatDatabase } from '@/database/type';
import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import {
  getConnectorOAuthRuntime,
  MANAGED_CONNECTOR_OAUTH_STATE_PREFIX,
} from '@/server/enterprise/services/connectorCatalog/oauthRuntime';
import { ConnectorOAuthCallbackService } from '@/server/enterprise/services/connectorCatalog/userOAuthService';

type CallbackLocale = 'en-US' | 'zh-CN';

const CONNECTOR_COPY = {
  'en-US': {
    fail: 'Authorization failed. You can close this window and try again.',
    success: 'Authorization complete. You can close this window.',
    title: 'Connector authorization',
  },
  'zh-CN': {
    fail: '授权失败。您可以关闭此窗口后重试。',
    success: '授权完成。您可以关闭此窗口。',
    title: '连接器授权',
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

const renderManagedResultPage = (success: boolean, locale: CallbackLocale): NextResponse => {
  const copy = CONNECTOR_COPY[locale];
  const message = success ? copy.success : copy.fail;
  const html = `<!doctype html>
<html lang="${locale === 'zh-CN' ? 'zh-CN' : 'en'}">
  <head><meta charset="utf-8" /><title>${escapeHtml(copy.title)}</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 24px; text-align: center;">
    <p>${escapeHtml(message)}</p>
  </body>
</html>`;
  return new NextResponse(html, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
};

/** Thin enterprise-owned implementation behind the exact upstream callback mount. */
export const handleManagedConnectorOAuthCallback = async (
  req: NextRequest,
  db: LobeChatDatabase,
): Promise<NextResponse | null> => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_CONNECTORS) return null;
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  if (!state?.startsWith(MANAGED_CONNECTOR_OAUTH_STATE_PREFIX)) return null;
  const locale = resolveCallbackLocale(req.headers.get('accept-language'));

  try {
    const service = new ConnectorOAuthCallbackService(db, getConnectorOAuthRuntime(db));
    if (req.nextUrl.searchParams.has('error') || !code) {
      await service.abandonAuthorization(state);
      return renderManagedResultPage(false, locale);
    }
    await service.callback({ code, state });
    return renderManagedResultPage(true, locale);
  } catch (error) {
    // Neutral page for the browser; sanitized server log (name only) so a real token-exchange
    // or DB failure is not invisible in production.
    console.error('[managed-connector-oauth] callback failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return renderManagedResultPage(false, locale);
  }
};

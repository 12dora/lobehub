import { type NextRequest, NextResponse } from 'next/server';

import type { LobeChatDatabase } from '@/database/type';
import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import {
  getConnectorOAuthRuntime,
  MANAGED_CONNECTOR_OAUTH_STATE_PREFIX,
} from '@/server/enterprise/services/connectorCatalog/oauthRuntime';
import { ConnectorOAuthCallbackService } from '@/server/enterprise/services/connectorCatalog/userOAuthService';

const renderManagedResultPage = (success: boolean): NextResponse => {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Connector authorization</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 24px; text-align: center;">
    <p>${success ? 'Authorization complete. You can close this window.' : 'Authorization failed. You can close this window and try again.'}</p>
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

  try {
    const service = new ConnectorOAuthCallbackService(db, getConnectorOAuthRuntime(db));
    if (req.nextUrl.searchParams.has('error') || !code) {
      await service.abandonAuthorization(state);
      return renderManagedResultPage(false);
    }
    await service.callback({ code, state });
    return renderManagedResultPage(true);
  } catch {
    return renderManagedResultPage(false);
  }
};

import { type NextRequest, NextResponse } from 'next/server';

import type { LobeChatDatabase } from '@/database/type';
import { appEnv } from '@/envs/app';
import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import { createAdminIdentityProviderRuntime } from '@/server/enterprise/routers/admin/identityProvidersSupport';

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
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  if (!state) return renderTerminalPage(false);

  try {
    const service = createAdminIdentityProviderRuntime(db).test;
    if (request.nextUrl.searchParams.has('error') || !code) {
      await service.abandon(state);
      return renderTerminalPage(false);
    }
    await service.callback({ code, state });
    return renderTerminalPage(true);
  } catch {
    return renderTerminalPage(false);
  }
};

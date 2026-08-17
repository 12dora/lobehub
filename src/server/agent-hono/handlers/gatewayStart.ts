import type { Context } from 'hono';

import { isBootModuleEnabled } from '@/server/enterprise/services/moduleSettings';

/**
 * Non-Vercel `ensureRunning` entry point — used by the standalone server
 * launcher (`scripts/serverLauncher/startServer.js`). Body: `{ restart?: boolean }`.
 *
 * Auth: `bearerSecretAuth(KEY_VAULTS_SECRET)` on the route.
 * When the `bots` module is off we return HTTP 200 `{ ok:false, disabled:true }`
 * so startServer.js's 10× poller treats it as a cheap success, not a retry.
 */
export async function gatewayStart(c: Context): Promise<Response> {
  if (!isBootModuleEnabled('bots')) {
    return c.json({ disabled: true, ok: false });
  }

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const { GatewayService } = await import('@/server/services/gateway');
  const service = new GatewayService();

  try {
    if ((body as { restart?: boolean }).restart) {
      console.info('[GatewayService] Restarting...');
      await service.stop();
    }

    await service.ensureRunning();
    console.info('[GatewayService] Started successfully');

    return c.json({ status: (body as { restart?: boolean }).restart ? 'restarted' : 'started' });
  } catch (error) {
    console.error('[GatewayService] Failed to start:', error);
    return c.json({ error: 'Failed to start gateway' }, 500);
  }
}

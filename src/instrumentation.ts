export async function register() {
  // In local development, write debug logs to logs/server.log
  if (process.env.NODE_ENV !== 'production' && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./libs/debug-file-logger');
  }

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Seeds platform RBAC (new permission codes on existing DBs) and, when the
    // BOOTSTRAP_SUPER_ADMIN_* env vars are set, provisions the first super admin
    // so a Docker-only deployment never needs a repo checkout.
    //
    // Guarded here as well as inside the module: Next waits for register() before
    // serving traffic, so a module-evaluation or env-validation failure in the
    // import itself would take the whole server down. Log and keep booting.
    try {
      const { bootstrapPlatformAdminRuntime } =
        await import('@/server/enterprise/bootstrap/startupBootstrap');
      await bootstrapPlatformAdminRuntime();
    } catch (error) {
      console.error('[Instrumentation] platform admin bootstrap unavailable (non-blocking)', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    const { bootstrapIdentityProviderRuntime } =
      await import('@/server/enterprise/services/identityProvider/bootstrap');
    await bootstrapIdentityProviderRuntime();

    const { ensurePlatformInstanceHeartbeatStarted } =
      await import('@/server/enterprise/services/platformInstance/heartbeatRuntime');
    await ensurePlatformInstanceHeartbeatStarted();
  }

  // Auto-start GatewayManager on server start for non-Vercel environments (Docker, local).
  // Persistent bots need reconnection after restart.
  // On Vercel, the cron job at /api/agent/gateway handles this reliably instead.
  // In local dev, opt-in via ENABLE_BOT_IN_DEV to avoid clobbering a shared bot binding.
  const isDev = process.env.NODE_ENV !== 'production';
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.DATABASE_URL &&
    !process.env.VERCEL_ENV &&
    (!isDev || process.env.ENABLE_BOT_IN_DEV === '1')
  ) {
    const { GatewayService } = await import('@/server/services/gateway');
    const service = new GatewayService();
    service.ensureRunning().catch((err) => {
      console.error('[Instrumentation] Failed to auto-start GatewayManager:', err);
    });
  }

  // Note: messenger system bot connections (Discord/Telegram) are managed
  // entirely from dc-center's System Bots admin — save / enable / forceReconnect
  // mutations call MessageGateway directly. The main app's only role here is
  // to receive forwarded events at `/api/agent/messenger/webhooks/<platform>`,
  // which doesn't require any startup work.

  if (process.env.NODE_ENV !== 'production' && !process.env.ENABLE_TELEMETRY_IN_DEV) {
    return;
  }

  const shouldEnable = process.env.ENABLE_TELEMETRY && process.env.NEXT_RUNTIME === 'nodejs';
  if (!shouldEnable) {
    return;
  }

  await import('./instrumentation.node');

  const { ensureOperationalMetricsRuntimeStarted } =
    await import('@/server/enterprise/services/platformObservability/operationalMetricsRuntime');
  await ensureOperationalMetricsRuntimeStarted();
}

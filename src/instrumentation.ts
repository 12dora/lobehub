let enterpriseWorkerShutdownHooksRegistered = false;

export async function register() {
  // In local development, write debug logs to logs/server.log
  if (process.env.NODE_ENV !== 'production' && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./libs/debug-file-logger');
  }

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      await (await import('@/server/enterprise/services/moduleSettings')).initBootModules();
    } catch (error) {
      console.error('[Instrumentation] module settings boot init failed (non-blocking)', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }

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

    // Identity providers are on by default, so the last-known-good snapshot is now read
    // on far more deployments. A missing / unreadable / wrongly-permissioned snapshot must
    // degrade to "no database identity providers", never to a server that will not start.
    try {
      const { bootstrapIdentityProviderRuntime } =
        await import('@/server/enterprise/services/identityProvider/bootstrap');
      await bootstrapIdentityProviderRuntime();
    } catch (error) {
      console.error('[Instrumentation] identity provider bootstrap failed (non-blocking)', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    try {
      const { ensurePlatformInstanceHeartbeatStarted } =
        await import('@/server/enterprise/services/platformInstance/heartbeatRuntime');
      await ensurePlatformInstanceHeartbeatStarted();
    } catch (error) {
      console.error('[Instrumentation] platform instance heartbeat failed (non-blocking)', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    try {
      await (
        await import('@/server/enterprise/bootstrap/workersBootstrap')
      ).startEnterpriseWorkers();
    } catch (error) {
      console.error('[Instrumentation] enterprise workers bootstrap failed (non-blocking)', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    }

    // Once-hooks: drain browser sessions on SIGTERM/SIGINT. Do not process.exit.
    if (!enterpriseWorkerShutdownHooksRegistered) {
      enterpriseWorkerShutdownHooksRegistered = true;
      const stopWorkers = () => {
        void import('@/server/enterprise/bootstrap/workersBootstrap')
          .then((mod) => mod.stopEnterpriseWorkers())
          .catch((error) => {
            console.error('[Instrumentation] enterprise workers stop failed (non-blocking)', {
              errorClass: error instanceof Error ? error.name : 'UnknownError',
            });
          });
      };
      process.once('SIGTERM', stopWorkers);
      process.once('SIGINT', stopWorkers);
    }
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

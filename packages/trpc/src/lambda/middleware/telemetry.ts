import { type LobeChatDatabase } from '@lobechat/database';

import { appEnv } from '@/envs/app';

import { trpc } from '../init';

export interface TelemetryContext {
  serverDB?: LobeChatDatabase;
  userId?: string | null;
}

export interface TelemetryResult {
  telemetryEnabled: boolean;
}

/** Per-request memo — not a process cache. Keyed by the ctx object of one call. */
const requestCache = new WeakMap<object, Promise<TelemetryResult>>();

const loadPlatformTelemetryResolver = async () => {
  const { resolveEffectiveTelemetry } =
    await import('@/server/enterprise/services/settings/resolveTelemetryPolicy');
  return resolveEffectiveTelemetry;
};

const computeTelemetryEnabled = async (ctx: TelemetryContext): Promise<TelemetryResult> => {
  if (!ctx.userId || !ctx.serverDB) {
    return { telemetryEnabled: false };
  }

  try {
    const resolveEffectiveTelemetry = await loadPlatformTelemetryResolver();
    const telemetryEnabled = await resolveEffectiveTelemetry({
      db: ctx.serverDB,
      userId: ctx.userId,
    });
    return { telemetryEnabled };
  } catch {
    return { telemetryEnabled: false };
  }
};

/**
 * Check if telemetry is enabled for the current user
 *
 * Precedence:
 * 1. TELEMETRY_DISABLED env → false
 * 2. Locked platform policy (when settingsPolicy is on)
 * 3. Explicit user value: override row, then legacy `user_settings.general.telemetry`,
 *    then legacy `users.preference.telemetry`
 * 4. Default-mode platform policy
 * 5. false (missing user fails closed before any platform default)
 */
export const checkTelemetryEnabled = async (ctx: TelemetryContext): Promise<TelemetryResult> => {
  // Priority 1: Check environment variable (highest priority)
  if (appEnv.TELEMETRY_DISABLED) {
    return { telemetryEnabled: false };
  }

  if (!ctx.userId || !ctx.serverDB) {
    return { telemetryEnabled: false };
  }

  const cached = requestCache.get(ctx);
  if (cached) return cached;

  const pending = computeTelemetryEnabled(ctx);
  requestCache.set(ctx, pending);
  return pending;
};

/**
 * Middleware that checks if telemetry is enabled for the current user
 * and adds telemetryEnabled to the context
 *
 * Requires serverDatabase middleware to be applied first
 */
export const telemetry = trpc.middleware(async (opts) => {
  const result = await checkTelemetryEnabled(opts.ctx as TelemetryContext);

  return opts.next({ ctx: result });
});

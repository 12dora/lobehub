import { trpc } from '@/libs/trpc/lambda/init';

/**
 * Workspace-scoped RBAC middleware.
 *
 * OSS / flag-off: no-op (upstream parity).
 * Enterprise (`ENABLE_PLATFORM_ADMIN=1`): still no-op for *workspace* scoped
 * checks here — real workspace RBAC remains cloud-only. Platform global
 * permissions use `withPlatformPermission` in `apps/server/src/enterprise/guards`.
 *
 * Export shape must stay stable for router imports:
 *   withRbacPermission / withAnyRbacPermission / withAllRbacPermissions / withScopedPermission
 *
 * Platform codes (`platform_*:…`) are intentionally NOT enforced here — callers
 * must use enterprise `withPlatformPermission` so global scope is strict.
 * This avoids treating workspace Owner as platform admin (M02).
 */
const isEnterprisePlatformAdminEnabled = (): boolean => {
  const raw = process.env.ENABLE_PLATFORM_ADMIN ?? process.env.ENABLE_ENTERPRISE_ADMIN ?? '';
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
};

export const withRbacPermission = (_code: string) =>
  trpc.middleware(async (opts) => {
    // Flag-on path reserved for future workspace enforcement adapters.
    // Currently identical to no-op so existing workspace routers keep working.
    void isEnterprisePlatformAdminEnabled();
    return opts.next();
  });

export const withAnyRbacPermission = (_codes: string[]) =>
  trpc.middleware(async (opts) => {
    void isEnterprisePlatformAdminEnabled();
    return opts.next();
  });

export const withAllRbacPermissions = (_codes: string[]) =>
  trpc.middleware(async (opts) => {
    void isEnterprisePlatformAdminEnabled();
    return opts.next();
  });

/**
 * Sugar for the "member-or-owner" gate — in cloud this fans the action code
 * out into the `:all | :owner` scope pair. OSS / enterprise-flag no-op.
 */
export const withScopedPermission = (_action: string) =>
  trpc.middleware(async (opts) => {
    void isEnterprisePlatformAdminEnabled();
    return opts.next();
  });

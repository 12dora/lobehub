import { isBootModuleEnabled } from '../../moduleSettings';

let bound = false;
let bindInflight: Promise<void> | null = null;

/**
 * Process-once load of G4's egress ALS / ssrf-safe-fetch binding.
 * No-op when the `networkProxy` module is off — do not import `egress/scope`
 * from a static graph (that file is G4-owned and pulls the engine + snapshot).
 *
 * `await import('../egress/scope')` is bundler-traceable (Turbopack / standalone).
 * Failures are logged at error level; the hook is not marked bound so a later
 * boot/init can retry.
 */
export const bindNetworkProxyEgressIfEnabled = (): Promise<void> => {
  if (!isBootModuleEnabled('networkProxy')) return Promise.resolve();
  if (bound) return Promise.resolve();
  if (bindInflight) return bindInflight;

  bindInflight = (async () => {
    try {
      const scope = await import('../egress/scope');
      scope.bindEgressCacheInvalidation();
      bound = true;
    } catch (error) {
      bound = false;
      console.error('[network-proxy] egress bind failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      bindInflight = null;
    }
  })();
  return bindInflight;
};

/** Test helper. */
export const resetNetworkProxyEgressBindForTest = (): void => {
  bound = false;
  bindInflight = null;
};

import type {
  NetworkProxyConfigUpdate,
  NetworkProxyConfigView,
  StaticProxyUpdate,
} from '@/types/platform/networkProxy';

/**
 * The read DTO (`NetworkProxyConfigView`) and the write DTO (`NetworkProxyConfigUpdate`) differ in
 * exactly two places: scopes are written through `updateScopes`, and the static-proxy password is
 * a keep / replace / clear instruction rather than a value. Everything else round-trips.
 *
 * Rebuilding the update from the *freshest* view (rather than from a local draft) is what lets a
 * revision conflict be retried without resurrecting stale fields: the retry re-derives the base
 * from the reloaded config and re-applies only the fields the admin actually touched.
 */
export const toConfigUpdate = (view: NetworkProxyConfigView): NetworkProxyConfigUpdate => ({
  bypassHosts: [...view.bypassHosts],
  downloadViaStaticProxy: view.downloadViaStaticProxy,
  engineLogLevel: view.engineLogLevel,
  masterEnabled: view.masterEnabled,
  outlet: { ...view.outlet },
  ruleMode: view.ruleMode,
  staticProxy: view.staticProxy
    ? {
        password: { action: 'keep' },
        port: view.staticProxy.port,
        server: view.staticProxy.server,
        type: view.staticProxy.type,
        ...(view.staticProxy.username === undefined ? {} : { username: view.staticProxy.username }),
      }
    : null,
  subscriptionUpdateViaOutlet: view.subscriptionUpdateViaOutlet,
});

export type NetworkProxyConfigPatch = Partial<NetworkProxyConfigUpdate>;

/** Apply a shallow field patch on top of the freshest server config. */
export const applyConfigPatch = (
  view: NetworkProxyConfigView,
  patch: NetworkProxyConfigPatch,
): NetworkProxyConfigUpdate => ({ ...toConfigUpdate(view), ...patch });

/** Patch just the outlet sub-object without losing the rest of it. */
export const patchOutlet = (
  view: NetworkProxyConfigView,
  outlet: Partial<NetworkProxyConfigUpdate['outlet']>,
): NetworkProxyConfigUpdate => {
  const base = toConfigUpdate(view);
  return { ...base, outlet: { ...base.outlet, ...outlet } };
};

/** Static-proxy form submit: the password instruction is explicit, never inferred from emptiness. */
export const patchStaticProxy = (
  view: NetworkProxyConfigView,
  staticProxy: StaticProxyUpdate | null,
): NetworkProxyConfigUpdate => ({ ...toConfigUpdate(view), staticProxy });

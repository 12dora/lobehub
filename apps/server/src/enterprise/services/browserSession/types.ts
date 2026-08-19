/**
 * Provider-neutral Browser Session Context (plan C1).
 *
 * The common type owns only identity, lifecycle, cookie-jar, and transport-pool
 * bookkeeping. ChatGPT OAI / Sentinel fields — and any other provider-specific
 * session state — attach through {@link BrowserSessionContext.providerState}
 * under a namespace the common layer never interprets.
 *
 * This registry key is independent of the global `installationId` consumed by
 * Grok and Cursor. Never reuse or regenerate that installation identity here.
 */

export type BrowserSessionLifecycleStatus = 'active' | 'invalidated' | 'released';

export class BrowserSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

/**
 * Process-local owner lease. `ownerId` is `pid:<pid>` — this process owns the
 * persistent transport. There is no distributed lock / Redis lease (plan
 * principle 7). Concurrent prepare / conversation / replenish on one context
 * is required (G6/G7); the lease is NOT an exclusive mutex. Generation
 * fencing is {@link BrowserSessionContext.revision} + {@link BrowserSessionContext.inFlight}.
 */
export interface BrowserSessionOwnerLease {
  acquiredAt: number;
  ownerId: string;
}

/** Captured at bind / ownership time so a stale handle cannot write a replacement. */
export interface BrowserSessionWriteFence {
  contextId: string;
  revision: number;
}

/** Filesystem Netscape jar owned by one context. Path is a digest, never a token. */
export interface BrowserSessionCookieJarRef {
  digest: string;
  path: string;
}

/**
 * Namespaced bag for provider adapters.
 *
 * Adapters may augment this interface locally:
 *
 * ```ts
 * declare module '@/server/enterprise/services/browserSession/types' {
 *   interface BrowserSessionProviderNamespaces {
 *     chatgptWeb: ChatGPTWebSessionState;
 *   }
 * }
 * ```
 *
 * The common registry must not import those fields.
 */
export interface BrowserSessionProviderNamespaces {
  // Intentionally empty. Provider adapters augment this interface.
}

export type BrowserSessionProviderState = Partial<BrowserSessionProviderNamespaces> &
  Record<string, unknown>;

export interface BrowserSessionContext {
  /** sha256 of the current credential/device/proxy/profile binding. */
  bindingDigest: string;
  browserProfileRevision: number;
  contextId: string;
  cookieJar: BrowserSessionCookieJarRef;
  createdAt: number;
  /**
   * Outstanding owners of this generation (bind / withContextOwnership).
   * The idle sweeper never evicts `inFlight > 0`. Invalidate does not wait
   * for this to reach 0 — it fences instead.
   */
  inFlight: number;
  lastUsedAt: number;
  lifecycle: BrowserSessionLifecycleStatus;
  /** Stable per context; G5 maps this to ChatGPT `OAI-Session-Id`. */
  logicalPageId: string;
  /** sha256(provider + accountId + origin). Safe for keys, logs, and metrics. */
  lookupKey: string;
  origin: string;
  ownerLease: BrowserSessionOwnerLease;
  provider: string;
  providerState: BrowserSessionProviderState;
  /**
   * Monotonic generation of this object. Starts at 1; bumped on drop so
   * closed-over handles fail {@link BrowserSessionWriteFence} checks.
   * `bindingDigest` is not a fence — rotate keeps the same digest.
   */
  revision: number;
  transportPoolKey: string;
}

/**
 * Acquire identity. Raw credential / device / token material is hashed into
 * the binding digest (accountId is hashed into the lookup key) and is never
 * stored on the context.
 *
 * Lookup (reuse) key: `provider + accountId + origin`.
 * Binding (invalidate on change): credential, device, proxy outlet, browser
 * profile revision, impersonation profile revision.
 */
export interface BrowserSessionAcquireInput {
  /**
   * Stable, non-secret account/connection handle unique within `provider`.
   * Hashed into the lookup key — do not pass a raw access token here; put
   * secret material in `credentialDigestInput`.
   */
  accountId: string;
  browserProfileRevision: number;
  /** Raw credential used only to compute the binding digest. Never persisted. */
  credentialDigestInput?: string;
  /** Provider-declared device binding. Change invalidates the context. */
  deviceId?: string;
  /**
   * Throwaway/staged context. Set at creation so capacity eviction cannot
   * steal a live account's slot. An ephemeral acquire at cap may only drop
   * another idle ephemeral entry.
   */
  ephemeral?: boolean;
  /** Impersonation/TLS profile revision; included in the transport-pool key. */
  impersonationProfileRevision?: string;
  origin: string;
  ownerId?: string;
  provider: string;
  /** Proxy/egress outlet id. Change invalidates the context. */
  proxyOutlet?: string;
}

/** Secret-safe view for logs and metrics. Never includes cookies or credentials. */
export interface BrowserSessionContextSummary {
  bindingDigest: string;
  browserProfileRevision: number;
  contextId: string;
  cookieJarDigest: string;
  createdAt: number;
  lastUsedAt: number;
  lifecycle: BrowserSessionLifecycleStatus;
  logicalPageId: string;
  lookupKey: string;
  origin: string;
  ownerId: string;
  provider: string;
  transportPoolKey: string;
}

export interface BrowserSessionRegistry {
  /**
   * Throws {@link BrowserSessionError} with `browser session registry is resetting`
   * once {@link dispose} has marked this instance disposed.
   */
  acquire: (input: BrowserSessionAcquireInput) => BrowserSessionContext;
  /**
   * Wait for every in-flight dispose drain+unlink. `invalidate` / `dispose`
   * stay synchronous for callers; shutdown and tests await this.
   */
  awaitPendingCleanup: () => Promise<void>;
  dispose: () => void;
  get: (contextId: string) => BrowserSessionContext | undefined;
  /**
   * Read-only lookup by provider + account + origin. Unlike {@link acquire},
   * this never inspects the binding digest and therefore cannot invalidate a
   * live context just because a candidate device / credential differs.
   */
  getForIdentity: (
    input: Pick<BrowserSessionAcquireInput, 'accountId' | 'origin' | 'provider'>,
  ) => BrowserSessionContext | undefined;
  invalidate: (contextId: string) => boolean;
  invalidateForIdentity: (
    input: Pick<BrowserSessionAcquireInput, 'accountId' | 'origin' | 'provider'>,
  ) => boolean;
  release: (contextId: string) => boolean;
  summarize: (context: BrowserSessionContext) => BrowserSessionContextSummary;
  /**
   * Evict idle / over-budget contexts. Never drops `inFlight > 0`.
   * Returns the number of contexts evicted.
   */
  sweepIdleAndBound: (nowMs?: number, reserve?: number) => number;
  touch: (contextId: string) => boolean;
  /**
   * Shared-generation ownership. Concurrent callers of the same revision
   * overlap (not an exclusive mutex). `inFlight` is incremented for the
   * duration of `fn` and decremented in `finally`.
   */
  withContextOwnership: <T>(
    contextId: string,
    fn: (ctx: BrowserSessionContext, fence: BrowserSessionWriteFence) => T | Promise<T>,
  ) => Promise<T>;
}

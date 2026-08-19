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
 * Process-local owner lease. C4 may replace the backend with a distributed
 * lock; the shape (one active owner id + acquire timestamp) is the extension
 * point. Persistent connections must have one active owner.
 */
export interface BrowserSessionOwnerLease {
  acquiredAt: number;
  ownerId: string;
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
  acquire: (input: BrowserSessionAcquireInput) => BrowserSessionContext;
  dispose: () => void;
  get: (contextId: string) => BrowserSessionContext | undefined;
  invalidate: (contextId: string) => boolean;
  invalidateForIdentity: (
    input: Pick<BrowserSessionAcquireInput, 'accountId' | 'origin' | 'provider'>,
  ) => boolean;
  release: (contextId: string) => boolean;
  summarize: (context: BrowserSessionContext) => BrowserSessionContextSummary;
  touch: (contextId: string) => boolean;
}

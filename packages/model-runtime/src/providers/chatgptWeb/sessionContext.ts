/**
 * Handle the ChatGPT Web runtime holds onto a Browser Session Context (plan C1).
 *
 * The registry itself lives in the server process. This package only sees an
 * opaque handle so a reconstructed-per-call client can still share bootstrap
 * cache, page session id, cookie-jar key, and Sentinel pool identity.
 */

export interface ChatGPTWebBootstrapState {
  clientBuildNumber?: string;
  clientVersion?: string;
  powResources?: { dataBuild: string; scriptSources: string[] };
}

export interface ChatGPTWebSessionContext {
  /**
   * Registry context id. Sentinel bundles are pooled under this key so two
   * ChatGPT accounts that happen to share a physical `oai-did` cannot spend
   * each other's proofs.
   */
  contextId: string;
  /**
   * Private hop-by-hop cookie-jar key (`X-AIHub-Cookie-Jar`). Namespaced
   * `ctx:<sha256>` when a real context is bound — never a raw device id, and
   * never an unnamespaced digest (a 64-hex legacy device id must stay legacy).
   */
  cookieJarKey: string;
  getBootstrap: () => ChatGPTWebBootstrapState | undefined;
  /** Maps 1:1 onto `OAI-Session-Id`. UUIDv4 minted once per context. */
  logicalPageId: string;
  /**
   * Drop this handle's in-flight ownership. The runtime package must not
   * import the server registry; the server adapter closes over the counter.
   * Idempotent.
   */
  release?: () => void;
  /** Generation captured at wrap time. Optional on in-memory test handles. */
  revision?: number;
  setBootstrap: (state: ChatGPTWebBootstrapState) => void;
}

/** In-memory handle for tests and runtime-only constructions (no server registry). */
export const createMemoryChatGPTWebSessionContext = ({
  contextId = 'memory-context',
  cookieJarKey,
  logicalPageId = '00000000-0000-4000-8000-000000000001',
}: {
  contextId?: string;
  cookieJarKey: string;
  logicalPageId?: string;
}): ChatGPTWebSessionContext => {
  let bootstrap: ChatGPTWebBootstrapState | undefined;
  return {
    contextId,
    cookieJarKey,
    getBootstrap: () => bootstrap,
    logicalPageId,
    release: () => undefined,
    revision: 1,
    setBootstrap: (state) => {
      bootstrap = state;
    },
  };
};

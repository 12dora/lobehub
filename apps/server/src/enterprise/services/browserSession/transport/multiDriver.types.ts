export interface LibcurlRequestInit {
  body?: Uint8Array;
  bodyStallTimeoutMs?: number;
  caBundle?: string;
  cookieJarPath?: string;
  dropHeaders?: string[];
  headers: [string, string][];
  impersonate: string;
  method: string;
  proxyUrl?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  url: string;
}

export interface LibcurlPoolIdentity {
  key: string;
  origin: string;
  proxyOutlet: string;
  scope: string;
}

export interface LibcurlMultiDriverStats {
  bufferedBodyBytes: number;
  inFlight: number;
  maxQueuedBytes: number;
  paused: number;
  pollEntered: number;
  pollExited: number;
  polling: number;
  pools: number;
}

export interface LibcurlMultiDriverOptions {
  onPoll?: (phase: 'enter' | 'exit') => void;
}

export interface LibcurlMultiDriver {
  drain: (keyOrScope: string) => Promise<void>;
  drainAll: () => Promise<void>;
  drainWhere: (predicate: (pool: LibcurlPoolIdentity) => boolean) => Promise<void>;
  stats: () => LibcurlMultiDriverStats;
  submit: (pool: LibcurlPoolIdentity, request: LibcurlRequestInit) => Promise<Response>;
}

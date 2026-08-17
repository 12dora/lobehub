import { runWithBoundFetch } from '@lobechat/model-runtime';
import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import { DEFAULT_BROWSER_DEVICE_PROFILE } from '@lobechat/model-runtime/browserProfile';
import { RequestTrigger } from '@lobechat/types';
import debug from 'debug';
import { ModelProvider } from 'model-bank';
import type { z } from 'zod';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';
import {
  buildPayloadFromKeyVaults,
  initModelRuntimeWithUserPayload,
  resolveManagedChatApiMode,
} from '@/server/modules/ModelRuntime';

import {
  AI_CONNECTION_TEST_ERROR_TYPES,
  type AiConnectionTestErrorType,
  type aiConnectionTestResultSchema,
} from '../../contracts/aiCatalog';
import {
  createSafeOutboundFetchAdapter,
  createSafeOutboundHttpClient,
  type SafeOutboundHttpClient,
} from '../../security/outboundHttp';
import { getChatGPTWebFetch } from '../chatgptWeb/transport';
import { getCursorAgentFetch } from '../cursorAgent';
import { getEgressProxyUrlForCurl } from '../networkProxy/egress/router';
import { createEgressSafeOutboundTransport } from '../networkProxy/egress/safeOutboundTransport';
import { resolveAiCatalogOutboundMode } from './outboundMode';
import type { PlatformProviderKeyVaults } from './secretManager';

export type AiConnectionTestResult = z.infer<typeof aiConnectionTestResultSchema>;

type AiConnectionErrorCategory = NonNullable<AiConnectionTestResult['errorCategory']>;

/** Category-only diagnostics. Never emits provider prose, request bodies or credentials. */
const log = debug('lobe-server:ai-catalog-connection-test');

export interface AiConnectionProbeParams {
  browserProfile?: BrowserDeviceProfile;
  keyVaults: PlatformProviderKeyVaults;
  /** Model to probe — the provider's stored `checkModel`, or an operator override. */
  model: string;
  provider: PlatformAiProviderItem;
  runtimeProvider: string;
}

export type AiConnectionProbe = (params: AiConnectionProbeParams) => Promise<void>;

/**
 * Explicit constructor options every enterprise connection-test runtime receives.
 * OpenAI/Anthropic honor `fetch`; Google/Vertex bind it via runWithBoundFetch;
 * Bedrock builds a Smithy requestHandler from the same fetch.
 */
export interface AiConnectionRuntimeTransportOptions {
  [key: string]: unknown;
  browserProfile?: BrowserDeviceProfile;
  fetch: typeof fetch;
}

/**
 * Runtimes that always talk to the OpenAI Responses API (`chatCompletion.useResponse`), whose
 * subscription backends are streaming-first. Probing them non-streaming takes a transport
 * production never uses, so the probe streams for exactly these — every other runtime keeps
 * the cheaper single-shot completion.
 */
const RESPONSES_ONLY_RUNTIMES = new Set(['chatgpt', 'chatgptweb', 'grok', 'supergrok', 'xai']);

/**
 * Runtimes whose production transport is NOT the enterprise outbound adapter.
 *
 * chatgpt.com is behind Cloudflare bot-fight: the SafeOutbound client is Node's own
 * fetch underneath, and its TLS/HTTP2 fingerprint is answered with a 403 challenge no
 * matter which headers or credentials are sent. Probing through it would report a
 * permanent auth failure for a connection that chats fine, so these runtimes probe
 * through exactly the transport production uses. The outbound POLICY still applies —
 * `resolveAiCatalogOutboundMode` continues to drive the shared client the rest of the
 * probes use — but the DNS/IP guard cannot be enforced on a child process, which is
 * acceptable here because the endpoint is a fixed, provider-owned host.
 */
const IMPERSONATED_TRANSPORT_RUNTIMES = new Set<string>([
  ModelProvider.ChatGPTWeb,
  ModelProvider.Cursor,
]);

const AI_CONNECTION_TEST_TIMEOUT_MS = 15_000;
/**
 * Streaming probes are judged on FIRST BYTE, not on a completed answer, but a reasoning model
 * (Codex `gpt-5.x`) can take double-digit seconds to produce it. 15s — the whole-round-trip
 * budget that is right for a single-shot completion — turned every such probe into a timeout.
 */
export const AI_CONNECTION_TEST_STREAM_TIMEOUT_MS = 45_000;
const AI_CONNECTION_TEST_MAX_RESPONSE_BYTES = 1024 * 1024;
const AI_CONNECTION_TEST_MAX_REDIRECTS = 3;

const KNOWN_ERROR_TYPES = new Set<string>(AI_CONNECTION_TEST_ERROR_TYPES);

/**
 * Stable `errorType` → category map. Values are `AgentRuntimeErrorType` members
 * (packages/model-runtime/src/types/error.ts) plus the platform catalog's own code.
 * Anything unmapped stays `provider` — an honest "the provider rejected us".
 */
const ERROR_TYPE_CATEGORY: Record<string, AiConnectionErrorCategory> = {
  AccountDeactivated: 'auth',
  // Deployment problem (the impersonation binary / CLI is missing), not a provider verdict.
  CHATGPT_WEB_TRANSPORT_UNAVAILABLE: 'invalid_config',
  cli_unavailable: 'invalid_config',
  ConnectionCheckFailed: 'network',
  ExceededContextWindow: 'invalid_config',
  InsufficientQuota: 'rate_limit',
  InvalidBedrockCredentials: 'auth',
  InvalidProviderAPIKey: 'auth',
  InvalidRequestFormat: 'invalid_config',
  InvalidVertexCredentials: 'auth',
  ModelNotFound: 'invalid_config',
  NoAvailableProvider: 'invalid_config',
  OAuthAuthorizationExpired: 'auth',
  PermissionDenied: 'auth',
  PLATFORM_AI_MODEL_NOT_PUBLISHED: 'invalid_config',
  ProviderNetworkError: 'network',
  QuotaLimitReached: 'rate_limit',
  RateLimitExceeded: 'rate_limit',
  UserConfigError: 'invalid_config',
};

/** Error names that mean "we never got an answer", whatever wrapper carries them. */
const NETWORK_ERROR_NAMES = new Set([
  'AbortError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'ConnectTimeoutError',
  'SafeOutboundFetchError',
  'SafeOutboundTruncatedError',
  'TimeoutError',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Follow the runtime payload's nesting: `{ error: { error: {…} } }` is routine. */
const errorChain = (error: unknown): Record<string, unknown>[] => {
  const chain: Record<string, unknown>[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    chain.push(current);
    current = current.error ?? current.body ?? current.cause;
  }
  return chain;
};

const toStatus = (value: unknown): number => {
  const status = typeof value === 'string' ? Number(value) : value;
  return typeof status === 'number' && Number.isFinite(status) ? status : 0;
};

/**
 * `AgentRuntimeError.chat` returns a PLAIN OBJECT — not an `Error`, and with no top-level
 * `status`. Reading only `error.status` made every OpenAI-compatible failure (401, 429, 400,
 * timeout) collapse into the same "provider rejected the request" string.
 */
const extractStatus = (error: unknown): number => {
  for (const node of errorChain(error)) {
    const status = toStatus(node.status ?? node.statusCode);
    if (status) return status;
  }
  return 0;
};

/** The transport's own code, and the runtime error kind it is carried as. */
const TRANSPORT_UNAVAILABLE_CODE = 'CHATGPT_WEB_TRANSPORT_UNAVAILABLE';
const CURSOR_CLI_UNAVAILABLE_CODE = 'cli_unavailable';
const TRANSPORT_UNAVAILABLE_KIND = 'transport_unavailable';

/**
 * A missing impersonation binary is a DEPLOYMENT fault, and it is the only failure whose
 * fix ("install curl-impersonate on the server") no provider-shaped category implies.
 *
 * The signal has to be dug out rather than read off the top: the model-runtime wraps it in
 * `AgentRuntimeError.chat({ errorType: 'ProviderBizError', error: { kind, code, … } })`,
 * so the outer `errorType` — which the generic extractor finds first — says nothing. Both
 * markers are accepted (`code` and `kind`) at any depth, so the classification survives
 * either shape the runtime settles on, and the raw transport error surviving unwrapped.
 */
const isTransportUnavailable = (error: unknown): boolean =>
  errorChain(error).some(
    (node) => node.code === TRANSPORT_UNAVAILABLE_CODE || node.kind === TRANSPORT_UNAVAILABLE_KIND,
  );

const isCursorCliUnavailable = (error: unknown): boolean =>
  errorChain(error).some((node) => node.code === CURSOR_CLI_UNAVAILABLE_CODE);

const extractErrorType = (error: unknown): string | undefined => {
  if (isTransportUnavailable(error)) return TRANSPORT_UNAVAILABLE_CODE;
  if (isCursorCliUnavailable(error)) return CURSOR_CLI_UNAVAILABLE_CODE;

  for (const node of errorChain(error)) {
    const errorType = node.errorType ?? node.code;
    if (typeof errorType === 'string' && errorType.length > 0) return errorType;
  }
  return undefined;
};

const extractName = (error: unknown): string | undefined => {
  for (const node of errorChain(error)) {
    if (typeof node.name === 'string' && node.name.length > 0) return node.name;
  }
  return undefined;
};

const MAX_CLASSIFIED_MESSAGE_LENGTH = 2000;

/**
 * Categorisation input ONLY. Never returned to the client: the sanitized message always comes
 * from the fixed table below, so provider prose and credential material cannot leak.
 */
const extractMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message.slice(0, MAX_CLASSIFIED_MESSAGE_LENGTH);
  for (const node of errorChain(error)) {
    if (typeof node.message === 'string' && node.message.length > 0) {
      return node.message.slice(0, MAX_CLASSIFIED_MESSAGE_LENGTH);
    }
  }
  if (typeof error === 'string') return error.slice(0, MAX_CLASSIFIED_MESSAGE_LENGTH);
  return '';
};

export interface AiConnectionFailure {
  errorCategory: AiConnectionErrorCategory;
  /** Only ever a code from the contract allowlist; unknown runtime codes are dropped. */
  errorType?: AiConnectionTestErrorType;
  status: number;
}

/**
 * Classify a probe failure into a stable category using the shape the model-runtime really
 * throws: a plain `{ endpoint, error, errorType, message, provider }` payload whose HTTP status
 * lives on the NESTED error.
 */
export const classifyAiConnectionFailure = (error: unknown): AiConnectionFailure => {
  const rawErrorType = extractErrorType(error);
  const errorType =
    rawErrorType && KNOWN_ERROR_TYPES.has(rawErrorType)
      ? (rawErrorType as AiConnectionTestErrorType)
      : undefined;
  const status = extractStatus(error);
  const name = extractName(error);
  const message = extractMessage(error).toLowerCase();

  const category = ((): AiConnectionErrorCategory => {
    // Decisive, ahead of every heuristic: the request never left this host, so neither a
    // wrapper's name nor its message describes what actually failed.
    if (rawErrorType === TRANSPORT_UNAVAILABLE_CODE) return 'invalid_config';
    if (rawErrorType === CURSOR_CLI_UNAVAILABLE_CODE) return 'invalid_config';
    // A named abort/timeout is decisive: an aborted request has no verdict from the provider,
    // whatever generic wrapper (`ProviderBizError`) the runtime put around it.
    if (name && NETWORK_ERROR_NAMES.has(name)) return 'network';
    if (rawErrorType && ERROR_TYPE_CATEGORY[rawErrorType])
      return ERROR_TYPE_CATEGORY[rawErrorType]!;
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate_limit';
    if (/auth|credential|api.?key|unauthor/.test(message)) return 'auth';
    if (
      /timeout|timed out|network|fetch|connect|dns|socket|outbound request blocked|enterprise network policy/.test(
        message,
      )
    ) {
      return 'network';
    }
    if (
      /endpoint|model|required|invalid config|unsupported.*transport|connection test transport/.test(
        message,
      )
    ) {
      return 'invalid_config';
    }
    return 'provider';
  })();

  return { errorCategory: category, ...(errorType ? { errorType } : {}), status };
};

/**
 * Stable codes, not prose: the admin checker translates them (`llm.checker.reason.*`), and a
 * server-authored English sentence was rendered verbatim in every locale.
 * Kept ≤ 500 chars and free of provider text by construction.
 *
 * A dead shared grant gets its OWN code rather than the generic `auth` one: it is the single
 * failure whose fix ("an administrator must reconnect the shared account") is not implied by
 * the category, and the code is ALSO the only thing that survives a superseded attempt — the
 * persisted connection-test state carries the message, not `errorType`.
 */
export const aiConnectionFailureCode = (
  category: AiConnectionErrorCategory,
  errorType?: AiConnectionTestErrorType,
): string => {
  if (errorType === 'OAuthAuthorizationExpired') return 'connection_failed_shared_account_expired';
  // Same reasoning as above: the fix ("install the ChatGPT Web transport on the server")
  // is not implied by the `invalid_config` category, so it gets its own stable code.
  if (errorType === 'CHATGPT_WEB_TRANSPORT_UNAVAILABLE' || errorType === 'cli_unavailable') {
    return 'connection_failed_transport';
  }
  return {
    auth: 'connection_failed_auth',
    invalid_config: 'connection_failed_invalid_config',
    network: 'connection_failed_network',
    provider: 'connection_failed_provider',
    rate_limit: 'connection_failed_rate_limit',
  }[category];
};

/**
 * Map managed `enableResponseApi` to the chat transport mode used by connection probes.
 * Delegates to the shared managed-runtime helper so probes match production traffic.
 */
export const resolveAiConnectionProbeApiMode = resolveManagedChatApiMode;

/**
 * Production probe: real chat completion against the configured check model.
 * Every HTTP hop is forced onto the enterprise outbound boundary via:
 * 1. explicit `fetch` constructor option (OpenAI-compatible, Anthropic, Bedrock handler)
 * 2. AsyncLocalStorage-bound global fetch for SDKs that ignore constructor options (Google)
 */
/**
 * Give the impersonated transport the same deadline every other probe hop has.
 *
 * The SafeOutbound adapters carry `timeoutMs` themselves; the curl child process does not
 * — its own `--max-time` budget is 600 s, sized for a long chat stream. Without this an
 * operator clicking "check" on a wedged connection waited ten minutes for a verdict.
 *
 * ONE `deadline` per probe invocation, created by the caller and reused for every hop.
 * A fresh timer per fetch was not a probe deadline at all: `LobeChatGPTWebAI.chat` runs
 * bootstrap, sentinel prepare/finalize and the conversation request in sequence, so each
 * hop restarted the clock and a single "check" could run for several multiples of it.
 * The caller's signal is composed in, so a cancelled test still hangs up immediately.
 */
const withProbeDeadline = (impersonatedFetch: typeof fetch, deadline: AbortSignal): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return impersonatedFetch(input, { ...init, signal });
  }) as typeof fetch;

export const createSafeAiConnectionProbe = (
  // G-07: platform provider endpoints are admin-authored, so the probe follows the same
  // private-network switch as connectors and identity providers (see ./outboundMode).
  // Tests may inject a client; production builds a per-provider egress-aware client.
  outbound?: SafeOutboundHttpClient,
): AiConnectionProbe => {
  return async ({ browserProfile, keyVaults, model, provider, runtimeProvider }) => {
    if (!model) throw new Error('check model is required');
    const payload = buildPayloadFromKeyVaults(keyVaults, runtimeProvider);
    const scope = `provider:${provider.providerKey}` as const;
    const client =
      outbound ??
      createSafeOutboundHttpClient({
        mode: resolveAiCatalogOutboundMode(),
        ...createEgressSafeOutboundTransport(scope),
      });

    const bufferedFetchAdapter = createSafeOutboundFetchAdapter(client, {
      maxRedirects: AI_CONNECTION_TEST_MAX_REDIRECTS,
      maxResponseBytes: AI_CONNECTION_TEST_MAX_RESPONSE_BYTES,
      secretBearing: true,
      timeoutMs: AI_CONNECTION_TEST_TIMEOUT_MS,
    });

    /**
     * A streaming probe on a buffering transport is not a streaming probe: the SDK's
     * `stream: true` call could not return until the WHOLE completion had been received, so the
     * 15s round-trip budget was spent on the model's full answer and the probe timed out.
     */
    const streamingFetchAdapter = createSafeOutboundFetchAdapter(client, {
      maxRedirects: AI_CONNECTION_TEST_MAX_REDIRECTS,
      maxResponseBytes: AI_CONNECTION_TEST_MAX_RESPONSE_BYTES,
      secretBearing: true,
      streaming: true,
      timeoutMs: AI_CONNECTION_TEST_STREAM_TIMEOUT_MS,
    });

    // Honor managed OpenAI request-format setting so probes match production traffic.
    const apiMode = resolveAiConnectionProbeApiMode(provider.config?.enableResponseApi);
    // Match production's transport where it matters: a Responses-API subscription backend
    // (Codex) is streaming-first, and a probe that takes a different transport than chat can
    // pass or fail for reasons chat never sees.
    const stream =
      apiMode === 'responses' ||
      RESPONSES_ONLY_RUNTIMES.has(runtimeProvider) ||
      runtimeProvider === ModelProvider.Cursor;

    // One deadline for the WHOLE probe, not per hop — see `withProbeDeadline`. It is armed
    // here, once per invocation, and reaches both the transport and the runtime call.
    const impersonated = IMPERSONATED_TRANSPORT_RUNTIMES.has(runtimeProvider);
    const probeDeadline = impersonated
      ? AbortSignal.timeout(AI_CONNECTION_TEST_STREAM_TIMEOUT_MS)
      : undefined;

    const extractUrl = (input: RequestInfo | URL): string => {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
      return String(input);
    };

    const fetchAdapter = probeDeadline
      ? withProbeDeadline(async (input, init) => {
          const proxyUrl = await getEgressProxyUrlForCurl(scope, extractUrl(input));
          if (runtimeProvider === ModelProvider.Cursor) {
            return getCursorAgentFetch(proxyUrl)(input, init);
          }
          return getChatGPTWebFetch(proxyUrl, {
            impersonate: (browserProfile ?? DEFAULT_BROWSER_DEVICE_PROFILE).impersonateProfile,
          })(input, init);
        }, probeDeadline)
      : stream
        ? streamingFetchAdapter
        : bufferedFetchAdapter;
    const transport: AiConnectionRuntimeTransportOptions = {
      /**
       * Whatever the caller resolved, for EVERY runtime that presents an installation
       * identity — never a constant. The seam fails closed for ChatGPT Web / Grok
       * without it, and Grok would otherwise probe as a device shared by every AIHub
       * deployment while chat used the real one.
       */
      ...(browserProfile ? { browserProfile } : {}),
      // Probes are their own conversation: one short session per provider, never mixed
      // into a user's chat session id.
      conversationKey: `platform:connection-test:${provider.providerKey}`,
      fetch: fetchAdapter,
      // One honest attempt. The SDK's default (2 retries) multiplied every deadline by three
      // and reported the last failure, so an operator waited ~45s for a misleading verdict.
      // Non-streaming probes keep the SDK default so API-key providers do not change behavior.
      ...(stream ? { maxRetries: 0 } : {}),
    };

    // Dual binding: constructor option + concurrent-safe global fetch binding.
    await runWithBoundFetch(fetchAdapter, async () => {
      const runtime = initModelRuntimeWithUserPayload(provider.providerKey, payload, transport);
      // The runtime tees the SDK stream, so cancelling the response body cannot reach the
      // socket. This signal is the probe's hang-up: once the verdict is in, the upstream
      // request is aborted instead of being left to run the completion out on our budget.
      const hangUp = new AbortController();
      // The same probe deadline the transport carries: the runtime's own sequencing (a
      // ChatGPT Web chat is several requests plus local work) must not outlive it either.
      const chatSignal = probeDeadline
        ? AbortSignal.any([hangUp.signal, probeDeadline])
        : hangUp.signal;
      try {
        const response = await runtime.chat(
          {
            ...(apiMode ? { apiMode } : {}),
            messages: [{ content: 'Hi', role: 'user' }],
            model,
            stream,
            temperature: 0,
          },
          { metadata: { trigger: RequestTrigger.Api }, signal: chatSignal },
        );
        if (!response.ok) {
          const failure = new Error(
            `provider responded with status ${response.status}`,
          ) as Error & {
            status: number;
          };
          failure.status = response.status;
          throw failure;
        }
        if (stream) await drainProbeStream(response);
      } finally {
        hangUp.abort();
      }
    });
  };
};

/**
 * FIRST-BYTE verdict: the question a connectivity probe answers is "did the provider accept us
 * and start producing", not "how long does a full answer take". Reading to `done` billed the
 * operator for the model's entire completion (and, for a reasoning model, blew every budget).
 *
 * A missing body is a FAILURE, not a pass: a streaming chat that produced no body produced no
 * completion, and silently accepting it turns the probe into a status-code check. Zero bytes
 * before `done` is the same failure. The body is always released.
 */
const drainProbeStream = async (response: Response): Promise<void> => {
  const body = response.body;
  if (!body) {
    throw new Error('provider returned an empty completion stream');
  }
  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      // Verdict reached — stop pulling and hang up instead of paying for the whole answer.
      if (bytes > 0) return;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released after an errored/cancelled stream.
    }
    await body.cancel().catch(() => undefined);
  }
  throw new Error('provider returned an empty completion stream');
};

export const defaultAiConnectionProbe: AiConnectionProbe = createSafeAiConnectionProbe();

export class AiCatalogConnectionTestService {
  private readonly probe: AiConnectionProbe;

  constructor(probe: AiConnectionProbe = defaultAiConnectionProbe) {
    this.probe = probe;
  }

  test = async (params: AiConnectionProbeParams): Promise<AiConnectionTestResult> => {
    const start = performance.now();
    try {
      await this.probe(params);
      return {
        errorCategory: null,
        latencyMs: Math.max(0, Math.round(performance.now() - start)),
        sanitizedMessage: 'Connection succeeded',
        status: 'success',
        testedAt: new Date(),
      };
    } catch (error) {
      const failure = classifyAiConnectionFailure(error);
      // Stable codes only. The probe failure previously left NO server-side trace at all, so a
      // 401, a payload rejection and a transport timeout were indistinguishable in production.
      // Never log `message` / `error` bodies: they can echo request material.
      log(
        'probe failed provider=%s runtime=%s model=%s category=%s errorType=%s status=%d',
        params.provider.providerKey,
        params.runtimeProvider,
        // Model ids are admin-authored free text: reduce to a bounded identifier charset.
        params.model.replaceAll(/[^\w.:/-]/g, '_').slice(0, 64),
        failure.errorCategory,
        failure.errorType ?? 'unknown',
        failure.status,
      );
      return {
        errorCategory: failure.errorCategory,
        ...(failure.errorType ? { errorType: failure.errorType } : {}),
        latencyMs: Math.max(0, Math.round(performance.now() - start)),
        sanitizedMessage: aiConnectionFailureCode(failure.errorCategory, failure.errorType),
        status: 'failure',
        testedAt: new Date(),
      };
    }
  };
}

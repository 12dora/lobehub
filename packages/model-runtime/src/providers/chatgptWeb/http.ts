import createDebug from 'debug';

import { randomUuid } from './binary';
import {
  CHATGPT_BASE_URL,
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_OFFSET_MIN,
  DEFAULT_USER_AGENT,
  TIMEOUTS,
} from './constants';
import {
  callerAbortReason,
  ChatGPTWebError,
  classifyResponseError,
  classifyTransportError,
  isChatGPTWebError,
} from './errors';
import { buildRequestHeaders, type SessionFingerprint } from './headers';

const log = createDebug('lobe-chatgptweb:http');

export interface ChatGPTWebClientOptions {
  accessToken: string;
  /** ChatGPT account id — kept for callers/telemetry; not sent as a header. */
  accountId?: string;
  /** Stable `OAI-Device-Id`; generated when absent (persist it per account). */
  deviceId?: string;
  fetch?: typeof fetch;
  locale?: string;
  sessionId?: string;
  timezone?: string;
  timezoneOffsetMin?: number;
  userAgent?: string;
}

export interface RequestOptions {
  accept?: string;
  body?: BodyInit;
  /** Short label used in error messages; never contains credentials. */
  context: string;
  headers?: Record<string, string | undefined>;
  method?: string;
  path: string;
  query?: string;
  route?: string;
  signal?: AbortSignal;
  /** 0 / undefined ⇒ no deadline of our own (the caller owns it). */
  timeoutMs?: number;
}

export interface ManagedSignal {
  cleanup: () => void;
  signal: AbortSignal | undefined;
}

/** `AbortSignal.any` when available, otherwise a manual relay. */
export const composeSignals = (signals: (AbortSignal | undefined)[]): ManagedSignal => {
  const present = signals.filter((item): item is AbortSignal => !!item);
  if (present.length === 0) return { cleanup: () => {}, signal: undefined };
  if (present.length === 1) return { cleanup: () => {}, signal: present[0] };

  const anyFn = (AbortSignal as { any?: (list: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return { cleanup: () => {}, signal: anyFn.call(AbortSignal, present) };

  const controller = new AbortController();
  const onAbort = (event: Event) => controller.abort((event.target as AbortSignal).reason);
  for (const item of present) {
    if (item.aborted) controller.abort(item.reason);
    else item.addEventListener('abort', onAbort, { once: true });
  }
  return {
    cleanup: () => {
      for (const item of present) item.removeEventListener('abort', onAbort);
    },
    signal: controller.signal,
  };
};

export const timeoutSignal = (ms: number | undefined): ManagedSignal => {
  if (!ms) return { cleanup: () => {}, signal: undefined };
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ChatGPTWebError('timeout', `request exceeded ${ms}ms`)),
    ms,
  );
  return { cleanup: () => clearTimeout(timer), signal: controller.signal };
};

/**
 * A response whose deadline / caller-signal wiring is still ARMED.
 *
 * `release()` must be called once the body has been fully consumed (or is no
 * longer needed) — never before: tearing the timers down at header time leaves
 * a slow or stalled body unbounded, which is exactly how a "60s" JSON request
 * turns into a hang.
 */
export interface ManagedResponse {
  /** Classify an error raised while consuming the body. */
  fail: (error: unknown) => Error;
  release: () => void;
  response: Response;
}

/** How much of a non-2xx body is worth keeping for diagnostics. */
export const MAX_ERROR_BODY_BYTES = 2000;

/**
 * Read at most {@link MAX_ERROR_BODY_BYTES} of an error body, then hang up.
 *
 * `response.text()` buffers the WHOLE body before truncating it, so a huge (or
 * endlessly chunked) 4xx/5xx would be materialised in full on a path that every
 * failed request goes through.
 *
 * @param fail the owning {@link ManagedResponse}'s classifier. A caller stop or
 *   our own deadline firing mid-body is a real failure and is rethrown; anything
 *   else degrades to "no diagnostic body".
 */
export const readBodySafely = async (
  response: Response,
  fail?: (error: unknown) => Error,
): Promise<string | undefined> => {
  try {
    if (!response.body) return (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (bytes < MAX_ERROR_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.length;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      // discard the remainder rather than draining it
      void reader.cancel().catch(() => {});
    }
    return text.slice(0, MAX_ERROR_BODY_BYTES);
  } catch (error) {
    if (fail) {
      const classified = fail(error);
      if (
        classified?.name === 'AbortError' ||
        (isChatGPTWebError(classified) && classified.kind === 'timeout')
      )
        throw classified;
    }
    return undefined;
  }
};

/**
 * Transport layer shared by every chatgpt.com call: session headers, target
 * path/route headers, deadline composition, typed error classification.
 *
 * Redirects are never followed (`redirect: 'manual'`); a 3xx is surfaced as an
 * upstream error rather than silently re-issued somewhere else.
 */
export abstract class ChatGPTWebHttp {
  protected readonly fetchImpl: typeof fetch;
  protected readonly fingerprint: SessionFingerprint;

  readonly accountId?: string;
  readonly deviceId: string;
  readonly sessionId: string;
  /** K5: defaults to `UTC` / offset `0` when the caller gives us nothing. */
  readonly timezone: string;
  readonly timezoneOffsetMin: number;

  constructor(options: ChatGPTWebClientOptions) {
    if (!options.accessToken) throw new ChatGPTWebError('auth', 'missing ChatGPT Web access token');

    this.accountId = options.accountId;
    this.deviceId = options.deviceId || randomUuid();
    this.sessionId = options.sessionId || randomUuid();
    this.timezone = options.timezone || DEFAULT_TIMEZONE;
    this.timezoneOffsetMin = options.timezoneOffsetMin ?? DEFAULT_TIMEZONE_OFFSET_MIN;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.fingerprint = {
      accessToken: options.accessToken,
      deviceId: this.deviceId,
      locale: options.locale,
      sessionId: this.sessionId,
      userAgent: options.userAgent || DEFAULT_USER_AGENT,
    };
  }

  protected get userAgent(): string {
    return this.fingerprint.userAgent || DEFAULT_USER_AGENT;
  }

  /**
   * A call to a host other than chatgpt.com (blob storage, bootstrap HTML).
   *
   * The returned {@link ManagedResponse} owns the deadline: the caller releases
   * it after consuming the body.
   */
  protected async rawFetch(
    url: string,
    init: RequestInit,
    { context, signal, timeoutMs }: { context: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ManagedResponse> {
    const deadline = timeoutSignal(timeoutMs);
    const composed = composeSignals([signal, deadline.signal]);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      deadline.cleanup();
      composed.cleanup();
    };

    /**
     * A caller-initiated abort keeps its own reason (a `DOMException`
     * `AbortError`), so upstream code can tell "the user pressed stop" from
     * "the provider timed out".
     */
    const fail = (error: unknown): Error => {
      const callerReason = callerAbortReason(signal);
      if (callerReason !== undefined) return callerReason as Error;
      if (deadline.signal?.aborted)
        return new ChatGPTWebError('timeout', `${context} exceeded ${timeoutMs}ms`, {
          cause: error,
        });
      return classifyTransportError(error, context);
    };

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'manual',
        signal: composed.signal,
      });
      return { fail, release, response };
    } catch (error) {
      release();
      throw fail(error);
    }
  }

  protected async request({
    accept = 'application/json',
    body,
    context,
    headers,
    method = 'GET',
    path,
    query = '',
    route,
    signal,
    timeoutMs = TIMEOUTS.json,
  }: RequestOptions): Promise<ManagedResponse> {
    log('%s %s', method, path);
    const managed = await this.rawFetch(
      `${CHATGPT_BASE_URL}${path}${query}`,
      {
        body,
        headers: buildRequestHeaders(this.fingerprint, {
          extra: { Accept: accept, ...headers },
          path,
          route,
        }),
        method,
      },
      { context, signal, timeoutMs },
    );

    if (managed.response.status >= 300) {
      // the deadline stays armed while the error body is drained
      let bodyText: string | undefined;
      try {
        bodyText = await readBodySafely(managed.response, managed.fail);
      } finally {
        managed.release();
      }
      throw classifyResponseError({
        bodyText,
        context,
        headers: managed.response.headers,
        status: managed.response.status,
      });
    }

    return managed;
  }

  protected async requestJson<T>(options: RequestOptions): Promise<T> {
    const managed = await this.request(options);
    let text: string;
    try {
      text = await managed.response.text();
    } catch (error) {
      throw managed.fail(error);
    } finally {
      managed.release();
    }

    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new ChatGPTWebError('upstream', `${options.context} returned malformed JSON`, {
        body: text.slice(0, 500),
        cause: error,
      });
    }
  }

  protected jsonBody(value: unknown) {
    return {
      body: JSON.stringify(value),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    } satisfies Partial<RequestOptions>;
  }
}

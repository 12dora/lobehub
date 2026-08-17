import { Readable } from 'node:stream';

import { request as undiciRequest } from 'undici';

import type { EgressScopeId } from '@/const/platform/networkProxy';
import {
  assertHostnamePolicy,
  type AttachedEgressDecision,
  DEFAULT_OUTBOUND_POLICY,
  type PinnedStreamingTransport,
  type PinnedTransport,
  type PinnedTransportRequest,
  type PinnedTransportResponse,
} from '@/server/enterprise/security/outboundHttp';
import {
  defaultPinnedStreamingTransport,
  defaultPinnedTransport,
} from '@/server/enterprise/security/outboundHttp/transport';

import {
  isConnectPhaseFailure,
  recordConnectPhaseFailure,
  recordConnectPhaseSuccess,
} from './circuit';
import { getDispatcher } from './dispatchers';
import { NetworkProxyUnavailableError } from './error';
import { resolveEgress } from './router';

const headersFromUndici = (
  headers: Record<string, string | string[] | undefined> | { [Symbol.iterator]?: unknown },
): Record<string, string | string[] | undefined> => {
  if (headers && typeof (headers as { forEach?: unknown }).forEach === 'function') {
    const out: Record<string, string | string[] | undefined> = {};
    (headers as Headers).forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return headers as Record<string, string | string[] | undefined>;
};

const proxyTransport = async (
  req: PinnedTransportRequest,
  proxyUrl: string,
  outlet: 'engine' | 'static',
) => {
  assertHostnamePolicy(req.url.hostname, DEFAULT_OUTBOUND_POLICY);
  const dispatcher = getDispatcher(proxyUrl);
  try {
    const response = await undiciRequest(req.url.toString(), {
      body: req.body,
      dispatcher,
      headers: req.headers,
      method: req.method,
      signal: req.signal ?? undefined,
    });
    if (response.statusCode === 407) {
      recordConnectPhaseFailure(outlet);
    } else {
      recordConnectPhaseSuccess(outlet);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of response.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = req.maxResponseBytes - total;
      if (buf.length > remaining) {
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        total = req.maxResponseBytes;
        truncated = true;
        break;
      }
      chunks.push(buf);
      total += buf.length;
    }
    const result: PinnedTransportResponse = {
      body: Buffer.concat(chunks, total),
      headers: headersFromUndici(response.headers as Record<string, string | string[] | undefined>),
      status: response.statusCode,
      statusText: '',
      truncated,
    };
    return result;
  } catch (error) {
    if (isConnectPhaseFailure(error, { beforeHeaders: true, proxyUrl })) {
      recordConnectPhaseFailure(outlet);
    }
    throw error;
  }
};

const limitStream = (
  body: ReadableStream<Uint8Array> | null,
  maxResponseBytes: number,
  onCancel: () => void,
): ReadableStream<Uint8Array> | null => {
  if (!body) return body;
  let total = 0;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      const chunk = value ?? new Uint8Array(0);
      const remaining = maxResponseBytes - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) controller.enqueue(chunk.subarray(0, remaining));
        onCancel();
        await reader.cancel();
        controller.close();
        return;
      }
      total += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      onCancel();
      return reader.cancel();
    },
  });
};

const isWebReadableStream = (value: unknown): value is ReadableStream<Uint8Array> =>
  !!value && typeof (value as { getReader?: unknown }).getReader === 'function';

const destroyNodeStream = (stream: unknown): void => {
  if (!stream || typeof stream !== 'object') return;
  const node = stream as { destroy?: (error?: Error) => void; cancel?: () => void };
  try {
    node.destroy?.();
  } catch {
    // already closed
  }
  try {
    void node.cancel?.();
  } catch {
    // already closed
  }
};

const toWebBody = (nodeBody: unknown): ReadableStream<Uint8Array> | null => {
  if (!nodeBody) return null;
  if (isWebReadableStream(nodeBody)) return nodeBody;
  return Readable.toWeb(nodeBody as Readable) as ReadableStream<Uint8Array>;
};

const proxyStreamingTransport = async (
  req: PinnedTransportRequest,
  proxyUrl: string,
  outlet: 'engine' | 'static',
): Promise<Response> => {
  assertHostnamePolicy(req.url.hostname, DEFAULT_OUTBOUND_POLICY);
  const dispatcher = getDispatcher(proxyUrl);
  const deadline = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
  try {
    const response = await undiciRequest(req.url.toString(), {
      body: req.body,
      dispatcher,
      headers: req.headers,
      method: req.method,
      signal,
    });
    if (response.statusCode === 407) {
      recordConnectPhaseFailure(outlet);
    } else {
      recordConnectPhaseSuccess(outlet);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(
      response.headers as Record<string, string | string[] | undefined>,
    )) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else {
        headers.set(key, value);
      }
    }
    const nodeBody = response.body;
    const webBody = toWebBody(nodeBody);
    const abortNode = () => destroyNodeStream(nodeBody);
    if (signal.aborted) abortNode();
    else signal.addEventListener('abort', abortNode, { once: true });
    const body = limitStream(webBody, req.maxResponseBytes, abortNode);
    return new Response(body, {
      headers,
      status: response.statusCode,
    });
  } catch (error) {
    if (isConnectPhaseFailure(error, { beforeHeaders: true, proxyUrl })) {
      recordConnectPhaseFailure(outlet);
    }
    throw error;
  }
};

const PLACEHOLDER_PIN = '0.0.0.0';

const dispatchWithDecision = async (
  req: PinnedTransportRequest,
  decision: AttachedEgressDecision,
  kind: 'buffered' | 'streaming',
): Promise<PinnedTransportResponse | Response> => {
  if (decision.mode === 'proxy') {
    return kind === 'buffered'
      ? proxyTransport(req, decision.proxyUrl, decision.outlet)
      : proxyStreamingTransport(req, decision.proxyUrl, decision.outlet);
  }
  if (req.pinnedAddress === PLACEHOLDER_PIN) {
    throw new Error('SafeOutbound: placeholder pin must not be used on the direct path');
  }
  return kind === 'buffered' ? defaultPinnedTransport(req) : defaultPinnedStreamingTransport(req);
};

/**
 * SafeOutbound transports for a feature/provider scope.
 *
 * Proxy path: hostname policy is still asserted, DNS pinning is skipped
 * (the engine REJECT rules become the IP-policy trust boundary).
 * Direct path: original pinned transports are unchanged.
 */
export const createEgressSafeOutboundTransport = (
  scope: EgressScopeId,
): { streamingTransport: PinnedStreamingTransport; transport: PinnedTransport } => {
  /**
   * Single hop decision. SafeOutbound attaches the returned `egress` to the
   * request so the transport does not call `resolveEgress` again.
   */
  const resolvesRemotely = async (
    url: URL,
  ): Promise<{ egress: AttachedEgressDecision; remote: boolean }> => {
    const decision = await resolveEgress(scope, url);
    if (decision.mode === 'fail') throw new NetworkProxyUnavailableError();
    if (decision.mode === 'proxy') {
      return {
        egress: { mode: 'proxy', outlet: decision.outlet, proxyUrl: decision.proxyUrl },
        remote: true,
      };
    }
    return { egress: { mode: 'direct' }, remote: false };
  };

  const attachedOrFresh = async (req: PinnedTransportRequest): Promise<AttachedEgressDecision> => {
    if (req.egress) return req.egress;
    const decision = await resolveEgress(scope, req.url);
    if (decision.mode === 'fail') throw new NetworkProxyUnavailableError();
    if (decision.mode === 'proxy') {
      return { mode: 'proxy', outlet: decision.outlet, proxyUrl: decision.proxyUrl };
    }
    return { mode: 'direct' };
  };

  const transport: PinnedTransport = async (req) => {
    const decision = await attachedOrFresh(req);
    return dispatchWithDecision(req, decision, 'buffered') as Promise<PinnedTransportResponse>;
  };
  transport.resolvesRemotely = resolvesRemotely;

  const streamingTransport: PinnedStreamingTransport = async (req) => {
    const decision = await attachedOrFresh(req);
    return dispatchWithDecision(req, decision, 'streaming') as Promise<Response>;
  };
  streamingTransport.resolvesRemotely = resolvesRemotely;

  return { streamingTransport, transport };
};

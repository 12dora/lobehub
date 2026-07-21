import { RequestTrigger } from '@lobechat/types';
import type { z } from 'zod';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';
import {
  buildPayloadFromKeyVaults,
  initModelRuntimeWithUserPayload,
} from '@/server/modules/ModelRuntime';

import type { aiConnectionTestResultSchema } from '../../contracts/aiCatalog';
import {
  createSafeOutboundFetchAdapter,
  createSafeOutboundHttpClient,
  type SafeOutboundHttpClient,
} from '../../security/outboundHttp';
import type { PlatformProviderKeyVaults } from './secretManager';

export type AiConnectionTestResult = z.infer<typeof aiConnectionTestResultSchema>;

export interface AiConnectionProbeParams {
  keyVaults: PlatformProviderKeyVaults;
  provider: PlatformAiProviderItem;
  runtimeProvider: string;
}

export type AiConnectionProbe = (params: AiConnectionProbeParams) => Promise<void>;

const AI_CONNECTION_TEST_TIMEOUT_MS = 15_000;
const AI_CONNECTION_TEST_MAX_RESPONSE_BYTES = 1024 * 1024;
const AI_CONNECTION_TEST_MAX_REDIRECTS = 3;

const classify = (error: unknown): NonNullable<AiConnectionTestResult['errorCategory']> => {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : 0;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/auth|credential|api.?key|unauthor/.test(message)) return 'auth';
  if (
    /timeout|network|fetch|connect|dns|socket|outbound request blocked|enterprise network policy/.test(
      message,
    )
  ) {
    return 'network';
  }
  if (/endpoint|model|required|invalid config/.test(message)) return 'invalid_config';
  return 'provider';
};

const safeFailureMessage = (
  category: NonNullable<AiConnectionTestResult['errorCategory']>,
): string =>
  ({
    auth: 'Connection failed: authentication rejected',
    invalid_config: 'Connection failed: invalid provider configuration',
    network: 'Connection failed: provider network unavailable',
    provider: 'Connection failed: provider rejected the request',
    rate_limit: 'Connection failed: provider rate limit reached',
  })[category];

/**
 * Production probe: real chat completion against the configured check model,
 * with every HTTP hop routed through the enterprise outbound policy boundary.
 * Callers may inject a SafeOutboundHttpClient for deterministic tests; raw fetch
 * is never accepted as a production bypass.
 */
export const createSafeAiConnectionProbe = (
  outbound: SafeOutboundHttpClient = createSafeOutboundHttpClient(),
): AiConnectionProbe => {
  const fetchAdapter = createSafeOutboundFetchAdapter(outbound, {
    maxRedirects: AI_CONNECTION_TEST_MAX_REDIRECTS,
    maxResponseBytes: AI_CONNECTION_TEST_MAX_RESPONSE_BYTES,
    secretBearing: true,
    timeoutMs: AI_CONNECTION_TEST_TIMEOUT_MS,
  });

  return async ({ keyVaults, provider, runtimeProvider }) => {
    if (!provider.checkModel) throw new Error('check model is required');
    const payload = buildPayloadFromKeyVaults(keyVaults, runtimeProvider);
    const runtime = initModelRuntimeWithUserPayload(provider.providerKey, payload, {
      fetch: fetchAdapter,
    });
    const response = await runtime.chat(
      {
        messages: [{ content: 'Hi', role: 'user' }],
        model: provider.checkModel,
        stream: false,
        temperature: 0,
      },
      { metadata: { trigger: RequestTrigger.Api } },
    );
    if (!response.ok) {
      const failure = new Error(`provider responded with status ${response.status}`) as Error & {
        status: number;
      };
      failure.status = response.status;
      throw failure;
    }
  };
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
      const errorCategory = classify(error);
      return {
        errorCategory,
        latencyMs: Math.max(0, Math.round(performance.now() - start)),
        sanitizedMessage: safeFailureMessage(errorCategory),
        status: 'failure',
        testedAt: new Date(),
      };
    }
  };
}

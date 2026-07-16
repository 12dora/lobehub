import { RequestTrigger } from '@lobechat/types';
import type { z } from 'zod';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';
import { M07_REDACTION_OPTIONS, redactForLog } from '@/server/enterprise/security/redaction';
import {
  buildPayloadFromKeyVaults,
  initModelRuntimeWithUserPayload,
} from '@/server/modules/ModelRuntime';

import type { aiConnectionTestResultSchema } from '../../contracts/aiCatalog';
import type { PlatformProviderKeyVaults } from './secretManager';

export type AiConnectionTestResult = z.infer<typeof aiConnectionTestResultSchema>;

export interface AiConnectionProbeParams {
  keyVaults: PlatformProviderKeyVaults;
  provider: PlatformAiProviderItem;
}

export type AiConnectionProbe = (params: AiConnectionProbeParams) => Promise<void>;

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
  if (/timeout|network|fetch|connect|dns|socket/.test(message)) return 'network';
  if (/endpoint|model|required|invalid config/.test(message)) return 'invalid_config';
  return 'provider';
};

const sanitizedMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const preRedacted = raw
    .replaceAll(/https?:\/\/[^\s"')]+/gi, '[endpoint]')
    .replaceAll(/\bsk-[\w-]{8,}\b/gi, '[REDACTED]')
    .replaceAll(/(bearer\s+)[\w.~+/=-]+/gi, '$1[REDACTED]');
  const redacted = redactForLog({ message: preRedacted }, M07_REDACTION_OPTIONS).message;
  return redacted.slice(0, 500);
};

export const defaultAiConnectionProbe: AiConnectionProbe = async ({ keyVaults, provider }) => {
  if (!provider.checkModel) throw new Error('check model is required');
  const runtimeProvider = provider.settings.sdkType ?? provider.providerKey;
  const payload = buildPayloadFromKeyVaults(keyVaults, runtimeProvider);
  const runtime = initModelRuntimeWithUserPayload(provider.providerKey, payload);
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
      return {
        errorCategory: classify(error),
        latencyMs: Math.max(0, Math.round(performance.now() - start)),
        sanitizedMessage: sanitizedMessage(error),
        status: 'failure',
        testedAt: new Date(),
      };
    }
  };
}

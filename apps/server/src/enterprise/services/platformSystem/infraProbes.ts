import { HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

import type { AdminSystemTestDependencyReason } from '@/server/enterprise/contracts/adminSystem';
import { resolveFileS3Config } from '@/server/modules/S3/resolveFileS3Config';

import type { DependencyHealth, InfraEnvBag } from './infraDependencyConfig';

export const PROBE_TIMEOUT_MS = 8000;

export type InfraProbeReason = AdminSystemTestDependencyReason;

export class InfraProbeError extends Error {
  readonly reason: InfraProbeReason;

  constructor(reason: InfraProbeReason) {
    super(reason);
    this.name = 'InfraProbeError';
    this.reason = reason;
  }
}

export interface InfraS3Client {
  destroy: () => void;
  send: (
    command: HeadBucketCommand | ListObjectsV2Command,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<unknown>;
}

export type CreateInfraS3Client = (
  config: Extract<ReturnType<typeof resolveFileS3Config>, { kind: 'complete' }>,
) => InfraS3Client;

export const isTimeoutError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  return (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    name === 'TimeoutExpired' ||
    /timeout|timed out|aborted/i.test(message)
  );
};

export const isUnauthorizedError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const status =
    'status' in error && typeof error.status === 'number'
      ? error.status
      : '$metadata' in error &&
          error.$metadata &&
          typeof error.$metadata === 'object' &&
          'httpStatusCode' in error.$metadata &&
          typeof error.$metadata.httpStatusCode === 'number'
        ? error.$metadata.httpStatusCode
        : undefined;
  return (
    status === 401 ||
    status === 403 ||
    /accessdenied|invalidaccesskey|unauthorized|forbidden|signature/i.test(`${name} ${message}`)
  );
};

export const withTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || isTimeoutError(error)) {
      throw new InfraProbeError('timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const defaultCreateS3Client: CreateInfraS3Client = (config) =>
  new S3Client({
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    region: config.region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

export const probeObjectStorage = async (
  env: InfraEnvBag,
  createS3Client: CreateInfraS3Client,
): Promise<void> => {
  const resolved = resolveFileS3Config(env);
  if (resolved.kind === 'unconfigured') throw new InfraProbeError('not_configured');
  if (resolved.kind === 'incomplete') throw new InfraProbeError('configuration_incomplete');

  const client = createS3Client(resolved);
  try {
    await withTimeout(async (signal) => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: resolved.bucket }), {
          abortSignal: signal,
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (/notimplemented|unknownoperation|invalidrequest/i.test(name)) {
          await client.send(new ListObjectsV2Command({ Bucket: resolved.bucket, MaxKeys: 1 }), {
            abortSignal: signal,
          });
          return;
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof InfraProbeError) throw error;
    if (isUnauthorizedError(error)) throw new InfraProbeError('unauthorized');
    throw new InfraProbeError('unreachable');
  } finally {
    client.destroy();
  }
};

export const probeObjectStorageHealth = async (
  env: InfraEnvBag,
  createS3Client: CreateInfraS3Client = defaultCreateS3Client,
  now: () => Date = () => new Date(),
): Promise<DependencyHealth> => {
  const checkedAt = now();
  try {
    await probeObjectStorage(env, createS3Client);
    return { errorCategory: null, lastCheckedAt: checkedAt, status: 'healthy' };
  } catch (error) {
    if (error instanceof InfraProbeError) {
      if (error.reason === 'timeout') {
        return { errorCategory: 'timeout', lastCheckedAt: checkedAt, status: 'unavailable' };
      }
      if (error.reason === 'not_configured') {
        return { errorCategory: null, lastCheckedAt: null, status: 'disabled' };
      }
      if (error.reason === 'configuration_incomplete') {
        return {
          errorCategory: 'configuration_incomplete',
          lastCheckedAt: null,
          status: 'degraded',
        };
      }
    }
    return {
      errorCategory: 'operation_unavailable',
      lastCheckedAt: checkedAt,
      status: 'unavailable',
    };
  }
};

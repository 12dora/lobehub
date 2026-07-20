const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_500;
const DEFAULT_INTERVAL_MS = 100;

export interface RedisHostReadinessOptions {
  attemptTimeoutMs?: number;
  connectionUrl: string;
  intervalMs?: number;
  probe?: (connectionUrl: string) => Promise<void>;
  timeoutMs: number;
}

const readinessError = (): Error => {
  const error = new Error('RedisHostReadinessTimeout');
  error.name = 'RedisHostReadinessTimeout';
  return error;
};

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
};

const boundedAttempt = async (operation: Promise<void>, timeoutMs: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(readinessError()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const probeRedisHost = async (
  connectionUrl: string,
  timeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
): Promise<void> => {
  const { default: Redis } = await import('ioredis');
  const client = new Redis(connectionUrl, {
    commandTimeout: timeoutMs,
    connectTimeout: timeoutMs,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    const response = await client.ping();
    if (response !== 'PONG') throw readinessError();
  } finally {
    client.disconnect(false);
  }
};

export const waitForRedisHostReady = async (options: RedisHostReadinessOptions): Promise<void> => {
  const timeoutMs = Math.trunc(options.timeoutMs);
  const attemptTimeoutMs = Math.trunc(options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS);
  const intervalMs = Math.trunc(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  if (timeoutMs <= 0 || attemptTimeoutMs <= 0 || intervalMs < 0) throw readinessError();

  const probe =
    options.probe ?? ((connectionUrl) => probeRedisHost(connectionUrl, attemptTimeoutMs));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      await boundedAttempt(probe(options.connectionUrl), Math.min(attemptTimeoutMs, remaining));
      return;
    } catch {
      const pause = Math.min(intervalMs, deadline - Date.now());
      if (pause > 0) await delay(pause);
    }
  }
  throw readinessError();
};

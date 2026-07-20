import { createServer, type Server, Socket } from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_CONNECTIONS = 16;
const SOCKET_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 3_000;
const LOOPBACK_UPSTREAMS = new Set(['127.0.0.1', '::1', 'localhost']);

export interface LoopbackFaultProxyOptions {
  upstreamHost: string;
  upstreamPort: number;
}

const safeProxyError = (name: string): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

export class LoopbackFaultProxy {
  private readonly connections = new Set<Socket>();
  private partitioned = false;
  private server: Server | null = null;

  constructor(private readonly options: LoopbackFaultProxyOptions) {
    if (
      !LOOPBACK_UPSTREAMS.has(options.upstreamHost) ||
      !Number.isSafeInteger(options.upstreamPort) ||
      options.upstreamPort < 1 ||
      options.upstreamPort > 65_535
    ) {
      throw safeProxyError('FaultProxyInvalidUpstream');
    }
  }

  private track = (socket: Socket): void => {
    this.connections.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.once('close', () => this.connections.delete(socket));
    socket.once('error', () => socket.destroy());
  };

  start = async (): Promise<number> => {
    if (this.server) throw safeProxyError('FaultProxyAlreadyStarted');
    const server = createServer((downstream) => {
      this.track(downstream);
      if (this.partitioned || this.connections.size >= MAX_CONNECTIONS) {
        downstream.destroy();
        return;
      }
      const upstream = new Socket();
      this.track(upstream);
      upstream.connect(this.options.upstreamPort, this.options.upstreamHost, () => {
        if (this.partitioned) {
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      });
    });
    server.maxConnections = MAX_CONNECTIONS;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: LOOPBACK_HOST, port: 0 }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw safeProxyError('FaultProxyAddressUnavailable');
    return address.port;
  };

  setPartitioned = (partitioned: boolean): void => {
    this.partitioned = partitioned;
    if (partitioned) {
      for (const connection of this.connections) connection.destroy();
    }
  };

  close = async (): Promise<void> => {
    for (const connection of this.connections) connection.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(safeProxyError('FaultProxyCleanupTimeout')),
            CLOSE_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

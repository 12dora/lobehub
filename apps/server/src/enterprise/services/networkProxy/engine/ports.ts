import { createServer } from 'node:net';

const BIND_HOST = '127.0.0.1';

const listenOnce = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, BIND_HOST, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else if (!port) reject(new Error('failed to allocate loopback port'));
        else resolve(port);
      });
    });
  });

/** Bind `127.0.0.1:0` and return the assigned port (caller must retry if it is stolen). */
export const allocateLoopbackPort = async (): Promise<number> => listenOnce();

export const allocateLoopbackPorts = async (count: number): Promise<number[]> => {
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    ports.push(await allocateLoopbackPort());
  }
  return ports;
};

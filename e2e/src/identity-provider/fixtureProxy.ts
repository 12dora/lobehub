import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';

import { AUTHENTIK_FIXTURE_HOST } from './authentikFixture';

export interface FixtureProxy {
  close: () => Promise<void>;
  port: number;
  url: string;
}

const listen = async (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('proxy port missing'));
      resolve(address.port);
    });
  });

export const startFixtureProxy = async (fixturePort: number): Promise<FixtureProxy> => {
  const server = createServer((_request, response) => {
    response.writeHead(405).end();
  });

  server.on('connect', (request, clientSocket, head) => {
    if (request.url !== `${AUTHENTIK_FIXTURE_HOST}:443`) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect({ host: '127.0.0.1', port: fixturePort });
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.once('error', () => {
      clientSocket.destroy();
    });
    clientSocket.once('error', () => upstream.destroy());
  });

  const port = await listen(server);
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    port,
    url: `http://127.0.0.1:${port}`,
  };
};

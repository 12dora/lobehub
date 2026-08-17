// @vitest-environment node
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { allocateLoopbackPort, allocateLoopbackPorts } from './ports';

describe('allocateLoopbackPort', () => {
  it('returns an unused port on 127.0.0.1', async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve());
      });
    });
  });

  it('allocates distinct ports', async () => {
    const ports = await allocateLoopbackPorts(2);
    expect(new Set(ports).size).toBe(2);
  });
});

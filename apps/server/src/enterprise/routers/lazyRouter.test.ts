// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { trpc } from '@/libs/trpc/lambda/init';

import { lazyRouter } from './lazyRouter';

const innerRouter = trpc.router({
  ping: trpc.procedure.query(() => 'pong'),
});

describe('lazyRouter', () => {
  it('does not import at evaluation time and hydrates on first call', async () => {
    const load = vi.fn(async () => innerRouter);
    const root = trpc.router({
      inner: lazyRouter(load),
    });
    expect(load).not.toHaveBeenCalled();

    const caller = root.createCaller({});
    await expect(caller.inner.ping()).resolves.toBe('pong');
    await expect(caller.inner.ping()).resolves.toBe('pong');
    expect(load).toHaveBeenCalledTimes(1);
  });
});

import { initTRPC } from '@trpc/server';
import debug from 'debug';
import superjson from 'superjson';

import { type AsyncContext } from './context';

const log = debug('lobe-async:init');

log('Initializing async tRPC with context and superjson transformer');

export const asyncTrpc = initTRPC.context<AsyncContext>().create({
  errorFormatter({ shape, error }) {
    log('tRPC error formatter called: %O', shape);
    if (error.cause && 'data' in error.cause) {
      return {
        ...shape,
        data: { ...shape.data, errorData: error.cause.data },
      };
    }
    return shape;
  },
  transformer: superjson,
});

log('Async tRPC initialized successfully');

// @vitest-environment node
import { TRPCError } from '@trpc/server';
import type { DefaultErrorShape } from '@trpc/server/unstable-core-do-not-import';
import { describe, expect, it } from 'vitest';

import { asyncTrpc } from './init';

describe('async tRPC errorFormatter', () => {
  it('mirrors the lambda formatter: cause.data becomes data.errorData', () => {
    const error = new TRPCError({
      cause: {
        data: {
          code: 'PLATFORM_MODULE_DISABLED',
          details: { moduleId: 'imageGen' },
          message: 'PLATFORM_MODULE_DISABLED',
        },
      },
      code: 'FORBIDDEN',
      message: 'PLATFORM_MODULE_DISABLED',
    });

    const shape: DefaultErrorShape = {
      code: -32_003,
      data: { code: 'FORBIDDEN', httpStatus: 403, path: 'image.generate' },
      message: error.message,
    };

    const formatted = asyncTrpc._config.errorFormatter({
      ctx: undefined,
      error,
      input: undefined,
      path: 'image.generate',
      shape,
      type: 'mutation',
    });

    expect(formatted.data).toMatchObject({
      code: 'FORBIDDEN',
      errorData: {
        code: 'PLATFORM_MODULE_DISABLED',
        details: { moduleId: 'imageGen' },
      },
    });
  });

  it('leaves the shape alone when cause has no data', () => {
    const error = new TRPCError({ code: 'NOT_FOUND', message: 'missing' });
    const shape: DefaultErrorShape = {
      code: -32_004,
      data: { code: 'NOT_FOUND', httpStatus: 404, path: 'file.get' },
      message: error.message,
    };

    const formatted = asyncTrpc._config.errorFormatter({
      ctx: undefined,
      error,
      input: undefined,
      path: 'file.get',
      shape,
      type: 'query',
    });

    expect(formatted).toEqual(shape);
    expect(formatted.data).not.toHaveProperty('errorData');
  });
});

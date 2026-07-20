import { describe, expect, it } from 'vitest';

import {
  decodeClusterRuntimeRequestFrame,
  isClusterRuntimeMessage,
  isClusterRuntimeRequest,
} from './protocol';

describe('cluster runtime protocol', () => {
  it('accepts only exact requests with positive safe ids', () => {
    expect(isClusterRuntimeRequest({ id: 1, type: 'load' })).toBe(true);
    expect(isClusterRuntimeRequest({ extra: true, id: 1, type: 'load' })).toBe(false);
    expect(isClusterRuntimeRequest({ id: 0, type: 'load' })).toBe(false);
    expect(isClusterRuntimeRequest({ id: Number.MAX_SAFE_INTEGER + 1, type: 'load' })).toBe(false);
    expect(isClusterRuntimeRequest({ id: 1, type: 'unknown' })).toBe(false);
  });

  it('maps malformed input to a fixed rejection or termination decision', () => {
    expect(decodeClusterRuntimeRequestFrame('{')).toEqual({ kind: 'terminate' });
    expect(decodeClusterRuntimeRequestFrame(JSON.stringify({ id: 1, type: 'unknown' }))).toEqual({
      id: 1,
      kind: 'reject',
    });
    expect(
      decodeClusterRuntimeRequestFrame(JSON.stringify({ extra: true, id: 1, type: 'load' })),
    ).toEqual({ id: 1, kind: 'reject' });
    expect(decodeClusterRuntimeRequestFrame(JSON.stringify({ id: 1, type: 'load' }))).toEqual({
      kind: 'request',
      request: { id: 1, type: 'load' },
    });
    expect(decodeClusterRuntimeRequestFrame('x'.repeat(9 * 1024))).toEqual({ kind: 'terminate' });
  });

  it('accepts exact kind-specific success frames', () => {
    expect(
      isClusterRuntimeMessage({
        id: 1,
        ok: true,
        type: 'result',
        value: { kind: 'load', revision: 2 },
      }),
    ).toBe(true);
    expect(
      isClusterRuntimeMessage({
        id: 2,
        ok: true,
        type: 'result',
        value: {
          branding: {
            degraded: 0,
            domain: 'branding',
            diverged: 0,
            fresh: 3,
            matching: 3,
            status: 'converged',
            unreported: 0,
          },
          kind: 'status',
        },
      }),
    ).toBe(true);
    expect(
      isClusterRuntimeMessage({ id: 3, ok: true, type: 'result', value: { kind: 'shutdown' } }),
    ).toBe(true);
  });

  it('rejects malformed successes, invalid counts and extra fields', () => {
    expect(
      isClusterRuntimeMessage({
        id: 1,
        ok: true,
        type: 'result',
        value: { extra: true, kind: 'load', revision: 2 },
      }),
    ).toBe(false);
    expect(
      isClusterRuntimeMessage({
        id: 1,
        ok: true,
        type: 'result',
        value: { kind: 'load', revision: 0 },
      }),
    ).toBe(false);
    expect(
      isClusterRuntimeMessage({
        id: 2,
        ok: true,
        type: 'result',
        value: {
          branding: {
            degraded: -1,
            domain: 'branding',
            diverged: 0,
            fresh: 3,
            matching: 3,
            status: 'converged',
            unreported: 0,
          },
          kind: 'status',
        },
      }),
    ).toBe(false);
    expect(
      isClusterRuntimeMessage({
        id: 2,
        ok: true,
        type: 'result',
        value: {
          branding: {
            degraded: 0,
            domain: 'branding',
            diverged: 0,
            fresh: 3,
            matching: 3,
            status: 'invented',
            unreported: 0,
          },
          kind: 'status',
        },
      }),
    ).toBe(false);
  });

  it('accepts only exact allowlisted failure frames', () => {
    expect(
      isClusterRuntimeMessage({
        errorCategory: 'protocol_error',
        id: 1,
        ok: false,
        type: 'result',
      }),
    ).toBe(true);
    expect(
      isClusterRuntimeMessage({
        errorCategory: 'unknown',
        id: 1,
        ok: false,
        type: 'result',
      }),
    ).toBe(false);
    expect(
      isClusterRuntimeMessage({
        errorCategory: 'command_failed',
        id: 1,
        ok: false,
        type: 'result',
        value: { kind: 'shutdown' },
      }),
    ).toBe(false);
  });
});

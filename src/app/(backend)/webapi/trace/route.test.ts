// @vitest-environment node
import { TraceEventType } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkTelemetryEnabled, copyMessage, createEvent, shutdownAsync } = vi.hoisted(() => {
  const copyMessage = vi.fn();
  const createEvent = vi.fn(() => ({ copyMessage }));
  const shutdownAsync = vi.fn(async () => undefined);
  return {
    checkTelemetryEnabled: vi.fn(),
    copyMessage,
    createEvent,
    shutdownAsync,
  };
});

vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    void cb();
  },
}));

vi.mock('@/app/(backend)/middleware/auth', () => ({
  checkAuth:
    (handler: (req: Request, ctx: { serverDB: object; userId: string }) => Promise<Response>) =>
    (req: Request) =>
      handler(req, { serverDB: {}, userId: 'trace-user' }),
}));

vi.mock('@/libs/trpc/lambda/middleware/telemetry', () => ({
  checkTelemetryEnabled,
}));

vi.mock('@/libs/traces', () => ({
  TraceClient: class {
    createEvent = createEvent;
    shutdownAsync = shutdownAsync;
  },
}));

describe('POST /webapi/trace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkTelemetryEnabled.mockResolvedValue({ telemetryEnabled: false });
  });

  it('returns 201 without recording a trace when telemetry is gated off', async () => {
    const { POST } = await import('./route');
    const request = new Request('https://test.com/webapi/trace', {
      body: JSON.stringify({
        eventType: TraceEventType.CopyMessage,
        traceId: 'trace-1',
      }),
      method: 'POST',
    });

    const response = await POST(request, { params: Promise.resolve({}) });

    expect(response.status).toBe(201);
    expect(checkTelemetryEnabled).toHaveBeenCalledWith({
      serverDB: {},
      userId: 'trace-user',
    });
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('records the event when telemetry is enabled', async () => {
    checkTelemetryEnabled.mockResolvedValue({ telemetryEnabled: true });
    const { POST } = await import('./route');
    const payload = {
      eventType: TraceEventType.CopyMessage,
      traceId: 'trace-2',
    };
    const request = new Request('https://test.com/webapi/trace', {
      body: JSON.stringify(payload),
      method: 'POST',
    });

    const response = await POST(request, { params: Promise.resolve({}) });

    expect(response.status).toBe(201);
    expect(createEvent).toHaveBeenCalledWith('trace-2');
    expect(copyMessage).toHaveBeenCalledWith(payload);
    expect(shutdownAsync).toHaveBeenCalled();
  });
});

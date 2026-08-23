import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as LibcurlFfi from './libcurlFfi';
import type { Pool, PoolCommand } from './multiDriver.lifecycle';
import type { MultiDriverRuntime, PoolController } from './multiDriver.loop';
import { submitLibcurlRequest } from './multiDriver.submit';

type WriteCallback = (ptr: unknown, size: unknown, nmemb: unknown) => number;

const ffi = vi.hoisted(() => ({
  callbacks: [] as WriteCallback[],
  decodeBytes: vi.fn((ptr: unknown) =>
    typeof ptr === 'string' ? Buffer.from(ptr) : new Uint8Array(64 * 1024),
  ),
  unregisterCallback: vi.fn(),
}));

vi.mock('./easyOptions', () => ({
  applyEasyOptions: vi.fn(),
  buildHeaderSlist: vi.fn(() => null),
}));

vi.mock('./libcurlFfi', async (importOriginal) => {
  const actual = await importOriginal<typeof LibcurlFfi>();
  return {
    ...actual,
    decodeBytes: ffi.decodeBytes,
    registerWriteCallback: vi.fn(
      (_bindings: LibcurlFfi.LibcurlBindings, callback: WriteCallback): bigint => {
        ffi.callbacks.push(callback);
        return BigInt(ffi.callbacks.length);
      },
    ),
    unregisterCallback: ffi.unregisterCallback,
  };
});

const identity = {
  key: 'test|https://chatgpt.com||chrome136',
  origin: 'https://chatgpt.com',
  proxyOutlet: '',
  scope: 'test',
};

describe('submitLibcurlRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ffi.callbacks.length = 0;
    ffi.decodeBytes.mockClear();
  });

  it('reports the configured body stall timeout', async () => {
    const pool = { destroyed: false } as Pool;
    const commands: PoolCommand[] = [];
    const controller = {
      drainPool: vi.fn(),
      enqueue: vi.fn((_pool: Pool, command: PoolCommand) => commands.push(command)),
      ensureLoop: vi.fn(),
      getOrCreatePool: vi.fn(() => pool),
    } as unknown as PoolController;
    const runtime = {
      bindings: {
        curl_easy_impersonate: vi.fn(() => 0),
        curl_easy_init: vi.fn(() => ({})),
      } as unknown as LibcurlFfi.LibcurlBindings,
      maxQueuedBytesHighWater: 0,
      options: {},
      pollEntered: 0,
      pollExited: 0,
      pools: new Map(),
    } as MultiDriverRuntime;

    const responsePromise = submitLibcurlRequest(runtime, controller, identity, {
      bodyStallTimeoutMs: 250,
      headers: [],
      impersonate: 'chrome136',
      method: 'GET',
      timeoutMs: 10_000,
      url: 'https://chatgpt.com/test',
    });
    const add = commands[0];
    if (!add || add.type !== 'add') throw new Error('request was not queued');

    const headerCallback = ffi.callbacks[1];
    const writeCallback = ffi.callbacks[0];
    if (!headerCallback || !writeCallback) throw new Error('callbacks were not registered');

    headerCallback('HTTP/2 200\r\n\r\n', 1, 1);
    const response = await responsePromise;
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    commands.length = 0;

    const chunkSize = 64 * 1024;
    expect(writeCallback(undefined, chunkSize, 1)).toBe(chunkSize);
    writeCallback(undefined, chunkSize, 1);
    expect(commands).toHaveLength(0);

    vi.advanceTimersByTime(249);
    expect(commands).toHaveLength(0);
    vi.advanceTimersByTime(1);

    const abort = commands[0] as Extract<PoolCommand, { type: 'abort' }>;
    expect(abort.req).toBe(add.req);
    expect(abort.error).toMatchObject({
      message:
        'fetch failed: the ChatGPT Web transport response body was not consumed within 250ms; the request was cancelled.',
    });
  });
});

// @vitest-environment node
import { ModelRuntime } from '@lobechat/model-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPlatformAiAuthFailureHooks,
  digestPlatformAiCredential,
  type PlatformAiRuntimeImplementation,
  registerPlatformAiRuntime,
  wrapPlatformModelRuntime,
} from './platformAiRuntimeBridge';

const reportExecutionAuthFailure = vi.fn();

/** Minimal registration: only the seam under test has to behave. */
const register = () =>
  registerPlatformAiRuntime({
    isEnabled: () => true,
    reportExecutionAuthFailure,
  } as unknown as PlatformAiRuntimeImplementation);

const DIGEST = digestPlatformAiCredential('shared-access-token')!;

beforeEach(() => {
  reportExecutionAuthFailure.mockReset();
  reportExecutionAuthFailure.mockResolvedValue(undefined);
  register();
});

describe('createPlatformAiAuthFailureHooks', () => {
  it('reports the failure with the digest of the credential the runtime used', async () => {
    const hooks = createPlatformAiAuthFailureHooks({} as never, 'chatgptweb', DIGEST);

    hooks.onChatError!({ errorType: 'OAuthAuthorizationExpired' } as never, {} as never);
    // Detached: the call is already scheduled, so one microtask turn is enough to observe it.
    await Promise.resolve();

    expect(reportExecutionAuthFailure).toHaveBeenCalledWith({
      credentialDigest: DIGEST,
      db: expect.anything(),
      errorType: 'OAuthAuthorizationExpired',
      providerKey: 'chatgptweb',
    });
  });

  it('reports nothing when the runtime was not built from a shared credential', async () => {
    const hooks = createPlatformAiAuthFailureHooks({} as never, 'chatgptweb', undefined);

    hooks.onChatError!({ errorType: 'OAuthAuthorizationExpired' } as never, {} as never);
    await Promise.resolve();

    // Silence beats guessing which credential to mark.
    expect(reportExecutionAuthFailure).not.toHaveBeenCalled();
  });

  /**
   * `ModelRuntime.chat` AWAITS `onChatError` before re-throwing, so anything this hook waits on
   * is added to the latency of every terminal chat failure the user is staring at.
   */
  it('never delays the chat failure, even while the report is still running', async () => {
    let settleReport: (() => void) | undefined;
    reportExecutionAuthFailure.mockReturnValue(
      new Promise<void>((resolve) => {
        settleReport = resolve;
      }),
    );

    const chatError = Object.assign(new Error('unauthorized'), {
      errorType: 'OAuthAuthorizationExpired',
    });
    const runtime = new ModelRuntime(
      { chat: vi.fn().mockRejectedValue(chatError) } as never,
      createPlatformAiAuthFailureHooks({} as never, 'chatgptweb', DIGEST),
    );

    // The report is still pending here and stays pending: the original rejection wins anyway.
    await expect(
      runtime.chat({ messages: [], model: 'gpt-5', temperature: 1 } as never),
    ).rejects.toBe(chatError);
    expect(reportExecutionAuthFailure).toHaveBeenCalledTimes(1);
    settleReport?.();
  });

  it('swallows a rejecting report so it can never replace the chat error', async () => {
    reportExecutionAuthFailure.mockRejectedValue(new Error('db down'));
    const hooks = createPlatformAiAuthFailureHooks({} as never, 'chatgptweb', DIGEST);

    // Returns nothing to await at all — the caller cannot be blocked, and the rejection is
    // absorbed by the detached wrapper instead of surfacing as an unhandled rejection.
    expect(
      hooks.onChatError!({ errorType: 'OAuthAuthorizationExpired' } as never, {} as never),
    ).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('swallows a report that throws synchronously', async () => {
    reportExecutionAuthFailure.mockImplementation(() => {
      throw new Error('boom');
    });
    const hooks = createPlatformAiAuthFailureHooks({} as never, 'chatgptweb', DIGEST);

    expect(
      hooks.onChatError!({ errorType: 'OAuthAuthorizationExpired' } as never, {} as never),
    ).toBeUndefined();
    await Promise.resolve();
  });
});

describe('wrapPlatformModelRuntime', () => {
  it('is identity when the implementation has no wrap', () => {
    register();
    const runtime = new ModelRuntime({ chat: vi.fn() } as never);
    expect(
      wrapPlatformModelRuntime(runtime, {
        db: {} as never,
        provider: 'openai',
        userId: 'user-1',
      }),
    ).toBe(runtime);
  });

  it('delegates to the registered wrap', () => {
    const wrapped = new ModelRuntime({ chat: vi.fn() } as never);
    const wrapModelRuntime = vi.fn(() => wrapped);
    registerPlatformAiRuntime({
      isEnabled: () => true,
      wrapModelRuntime,
    } as unknown as PlatformAiRuntimeImplementation);

    const runtime = new ModelRuntime({ chat: vi.fn() } as never);
    expect(
      wrapPlatformModelRuntime(runtime, {
        db: {} as never,
        provider: 'openai',
        userId: 'user-1',
      }),
    ).toBe(wrapped);
    expect(wrapModelRuntime).toHaveBeenCalledOnce();
  });
});

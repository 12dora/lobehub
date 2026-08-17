// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  gateWebapiRequest,
  platformModuleDisabledBody,
  resolveWebapiModuleId,
  withWorkflowsModule,
} from './webapiModuleGate';

const mocks = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(async (_id: string) => true),
}));

vi.mock('../services/moduleSettings', () => ({
  isModuleEnabled: (id: string) => mocks.isModuleEnabled(id),
}));

afterEach(() => {
  mocks.isModuleEnabled.mockReset();
  mocks.isModuleEnabled.mockResolvedValue(true);
});

describe('resolveWebapiModuleId', () => {
  it('maps agent gateway / messenger / webhooks to bots', () => {
    expect(resolveWebapiModuleId('/api/agent/gateway')).toBe('bots');
    expect(resolveWebapiModuleId('/api/agent/gateway/start')).toBeUndefined();
    expect(resolveWebapiModuleId('/api/agent/webhooks/bot-callback')).toBe('bots');
    expect(resolveWebapiModuleId('/api/agent/messenger/slack/install')).toBe('bots');
    expect(resolveWebapiModuleId('/gateway/start')).toBeUndefined();
  });

  it('maps workflows sub-mounts and leaves core agent paths unmapped', () => {
    expect(resolveWebapiModuleId('/api/workflows/agent-signal/nightly')).toBe('agentSignal');
    expect(resolveWebapiModuleId('/api/workflows/memory-user-memory/hourly')).toBe('memory');
    expect(resolveWebapiModuleId('/api/workflows/task/watchdog')).toBe('workflows');
    expect(resolveWebapiModuleId('/api/agent')).toBeUndefined();
    expect(resolveWebapiModuleId('/api/agent/run')).toBeUndefined();
  });
});

describe('gateWebapiRequest', () => {
  it('returns 403 PLATFORM_MODULE_DISABLED when the module is off', async () => {
    mocks.isModuleEnabled.mockResolvedValue(false);
    const response = await gateWebapiRequest(
      new Request('http://localhost/api/agent/gateway/callback', { method: 'POST' }),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(403);
    await expect(response!.json()).resolves.toEqual(platformModuleDisabledBody('bots'));
    expect(mocks.isModuleEnabled).toHaveBeenCalledWith('bots');
  });

  it('lets /api/agent/gateway/start through so the handler can answer 200 disabled', async () => {
    mocks.isModuleEnabled.mockResolvedValue(false);
    expect(
      await gateWebapiRequest(
        new Request('http://localhost/api/agent/gateway/start', { method: 'POST' }),
      ),
    ).toBeNull();
  });

  it('returns null for unmapped or enabled paths', async () => {
    expect(await gateWebapiRequest(new Request('http://localhost/api/agent/run'))).toBeNull();
    mocks.isModuleEnabled.mockResolvedValue(true);
    expect(
      await gateWebapiRequest(new Request('http://localhost/api/workflows/task/watchdog')),
    ).toBeNull();
  });
});

describe('withWorkflowsModule', () => {
  it('403s concrete agent-eval-run routes when workflows is off', async () => {
    mocks.isModuleEnabled.mockImplementation(async (id) => id !== 'workflows');
    const inner = vi.fn(async () => new Response('ok'));
    const response = await withWorkflowsModule(inner)(
      new Request('http://localhost/api/workflows/agent-eval-run/finalize-run', {
        method: 'POST',
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(platformModuleDisabledBody('workflows'));
    expect(inner).not.toHaveBeenCalled();
  });

  it('maps agent-signal / memory-user-memory to their own modules', async () => {
    mocks.isModuleEnabled.mockImplementation(async (id) => id !== 'agentSignal');
    const inner = vi.fn(async () => new Response('ok'));
    const denied = await withWorkflowsModule(inner)(
      new Request('http://localhost/api/workflows/agent-signal/nightly', { method: 'POST' }),
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual(platformModuleDisabledBody('agentSignal'));

    mocks.isModuleEnabled.mockResolvedValue(true);
    const allowed = await withWorkflowsModule(inner)(
      new Request('http://localhost/api/workflows/memory-user-memory/hourly', { method: 'POST' }),
    );
    expect(allowed.status).toBe(200);
    expect(inner).toHaveBeenCalledOnce();
  });
});

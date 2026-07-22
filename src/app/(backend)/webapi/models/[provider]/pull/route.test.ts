// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/auth';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { POST } from './route';

const bridgeMocks = vi.hoisted(() => ({
  getEmptyPlatformAiRuntimeState: vi.fn(() => ({
    enabledAiModels: [],
    enabledAiProviders: [],
    enabledChatAiProviders: [],
    enabledImageAiProviders: [],
    enabledVideoAiProviders: [],
    runtimeConfig: {},
  })),
  isPlatformManagedAiEnabled: vi.fn(),
  resolvePlatformAiRuntimeState: vi.fn(),
}));

vi.mock('@/app/(backend)/middleware/auth/utils', () => ({ checkAuthMethod: vi.fn() }));
vi.mock('@/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock('@/server/modules/ModelRuntime', () => ({ initModelRuntimeFromDB: vi.fn() }));
vi.mock('@/server/modules/ModelRuntime/platformAiRuntimeBridge', () => bridgeMocks);

beforeEach(() => {
  vi.clearAllMocks();
  bridgeMocks.isPlatformManagedAiEnabled.mockReturnValue(true);
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {} as never,
    user: { id: 'test-user' } as never,
  });
});

describe('managed model pull route', () => {
  it('rejects platform catalog providers before resolving credentials or invoking the SDK', async () => {
    bridgeMocks.resolvePlatformAiRuntimeState.mockResolvedValue({
      enabledAiModels: [],
      enabledAiProviders: [{ id: 'ollama', name: 'Ollama', source: 'builtin' }],
      enabledChatAiProviders: [],
      enabledImageAiProviders: [],
      enabledVideoAiProviders: [],
      runtimeConfig: {},
    });

    const request = new Request('https://test.com/webapi/models/ollama/pull', {
      body: JSON.stringify({ model: 'unknown-model' }),
      method: 'POST',
    });

    const response = await POST(request, {
      params: Promise.resolve({ provider: 'ollama' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      errorType: PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_PULL_DISABLED,
    });
    expect(initModelRuntimeFromDB).not.toHaveBeenCalled();
  });

  it('allows pull for user BYOK providers not present in the platform catalog', async () => {
    bridgeMocks.resolvePlatformAiRuntimeState.mockResolvedValue({
      enabledAiModels: [],
      enabledAiProviders: [{ id: 'openai', name: 'OpenAI', source: 'builtin' }],
      enabledChatAiProviders: [],
      enabledImageAiProviders: [],
      enabledVideoAiProviders: [],
      runtimeConfig: {},
    });

    const pullResponse = new Response('pulled', { status: 200 });
    vi.mocked(initModelRuntimeFromDB).mockResolvedValue({
      pullModel: vi.fn().mockResolvedValue(pullResponse),
    } as never);

    const request = new Request('https://test.com/webapi/models/oai/pull', {
      body: JSON.stringify({ model: 'custom-model' }),
      method: 'POST',
    });

    const response = await POST(request, {
      params: Promise.resolve({ provider: 'oai' }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pulled');
    expect(initModelRuntimeFromDB).toHaveBeenCalled();
  });
});

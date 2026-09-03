// @vitest-environment node
import './testUtils';

import type { ChatModelCard } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { params } from '../index';

describe('DeepSeek models', () => {
  const fetchModels = params.models as (params: { client: unknown }) => Promise<ChatModelCard[]>;
  const mockClient = {
    models: {
      list: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch and process models successfully', async () => {
    mockClient.models.list.mockResolvedValue({
      data: [{ id: 'deepseek-chat' }, { id: 'deepseek-coder' }, { id: 'deepseek-r1' }],
    });

    const models = await fetchModels({ client: mockClient });

    expect(mockClient.models.list).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(3);
    expect(models[0].id).toBe('deepseek-chat');
    expect(models[1].id).toBe('deepseek-coder');
    expect(models[2].id).toBe('deepseek-r1');
  });

  it('should handle single model', async () => {
    mockClient.models.list.mockResolvedValue({
      data: [{ id: 'deepseek-chat' }],
    });

    const models = await fetchModels({ client: mockClient });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('deepseek-chat');
  });

  it('should handle empty model list', async () => {
    mockClient.models.list.mockResolvedValue({
      data: [],
    });

    const models = await fetchModels({ client: mockClient });

    expect(models).toEqual([]);
  });

  it('should process models with MODEL_LIST_CONFIGS', async () => {
    mockClient.models.list.mockResolvedValue({
      data: [{ id: 'deepseek-chat' }],
    });

    const models = await fetchModels({ client: mockClient });

    // The processModelList function should merge with known model list
    expect(models[0]).toHaveProperty('id');
    expect(models[0].id).toBe('deepseek-chat');
  });

  it('should preserve model properties from API response', async () => {
    mockClient.models.list.mockResolvedValue({
      data: [
        { id: 'deepseek-chat', extra_field: 'value' },
        { id: 'deepseek-coder', another_field: 123 },
      ],
    });

    const models = await fetchModels({ client: mockClient });

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('deepseek-chat');
    expect(models[1].id).toBe('deepseek-coder');
  });

  it('lists models from the OpenAI-compatible surface when routed to the Anthropic client', async () => {
    // DeepSeek's `/anthropic` surface serves `/v1/messages` only. Its Anthropic SDK client
    // still exposes `models.list()`, so the listing must NOT go through the client.
    const injectedFetch = vi.fn().mockResolvedValue({
      json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    const anthropicClient = {
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/anthropic',
      fetch: injectedFetch,
      models: { list: vi.fn() },
    };

    const models = await fetchModels({ client: anthropicClient });

    expect(anthropicClient.models.list).not.toHaveBeenCalled();
    expect(injectedFetch).toHaveBeenCalledWith('https://api.deepseek.com/v1/models', {
      headers: { Accept: 'application/json', Authorization: 'Bearer sk-test' },
      method: 'GET',
    });
    expect(models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('strips a trailing slash from the Anthropic baseURL', async () => {
    const injectedFetch = vi.fn().mockResolvedValue({
      json: async () => ({ data: [{ id: 'deepseek-chat' }] }),
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    await fetchModels({
      client: {
        apiKey: 'sk-test',
        baseURL: 'https://gateway.example.com/deepseek/anthropic/',
        fetch: injectedFetch,
      },
    });

    expect(injectedFetch).toHaveBeenCalledWith(
      'https://gateway.example.com/deepseek/v1/models',
      expect.anything(),
    );
  });

  it('surfaces a non-ok model listing as an error', async () => {
    const injectedFetch = vi.fn().mockResolvedValue({
      json: async () => ({}),
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(
      fetchModels({
        client: {
          apiKey: 'sk-test',
          baseURL: 'https://api.deepseek.com/anthropic',
          fetch: injectedFetch,
        },
      }),
    ).rejects.toThrow('Failed to fetch DeepSeek models: 404 Not Found');
  });

  it('keeps using the client for an OpenAI-compatible baseURL', async () => {
    mockClient.models.list.mockResolvedValue({ data: [{ id: 'deepseek-chat' }] });

    const models = await fetchModels({
      client: { ...mockClient, baseURL: 'https://api.deepseek.com/v1' },
    });

    expect(mockClient.models.list).toHaveBeenCalledTimes(1);
    expect(models[0].id).toBe('deepseek-chat');
  });

  it('should handle models with different id patterns', async () => {
    mockClient.models.list.mockResolvedValue({
      data: [
        { id: 'deepseek-chat' },
        { id: 'deepseek-r1' },
        { id: 'deepseek-reasoner' },
        { id: 'deepseek-v3' },
      ],
    });

    const models = await fetchModels({ client: mockClient });

    expect(models).toHaveLength(4);
    expect(models.every((m) => typeof m.id === 'string')).toBe(true);
  });
});

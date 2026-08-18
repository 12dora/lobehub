// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { LobeAntGroupAI, params } from './index';

describe('LobeAntGroupAI - models', () => {
  it('uses the documented Ant Ling base URL', () => {
    expect(params.baseURL).toBe('https://api.ant-ling.com/v1');
  });

  it('surfaces a clear error when the gateway returns 200 without a data array', async () => {
    const instance = new LobeAntGroupAI({ apiKey: 'test_api_key' });
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: undefined,
    } as any);

    await expect(instance.models()).rejects.toThrow(
      'Ant Group models endpoint did not answer with a model list',
    );
    await expect(instance.models()).rejects.not.toBeInstanceOf(TypeError);
  });

  it('surfaces the same error for a ROUTE_NOT_FOUND body the SDK accepted as HTTP 200', async () => {
    await expect(
      params.models!({
        client: {
          models: {
            list: vi.fn().mockResolvedValue({ object: 'ROUTE_NOT_FOUND' }),
          },
        } as any,
      }),
    ).rejects.toThrow('Ant Group models endpoint did not answer with a model list');
  });

  it('returns listed models when the endpoint answers with a data array', async () => {
    const instance = new LobeAntGroupAI({ apiKey: 'test_api_key' });
    vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
      data: [{ id: 'Ring-2.6-1T' }, { id: 'embedding-1' }],
    } as any);

    const models = await instance.models();

    expect(models.map((model) => model.id)).toContain('Ring-2.6-1T');
  });
});

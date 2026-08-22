// @vitest-environment node
import { ModelProvider } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { getAttachmentCapabilities, resolveRuntimeProviderId } from './attachmentCapabilities';

describe('getAttachmentCapabilities', () => {
  it('disables tools for the Cursor runtime', () => {
    expect(getAttachmentCapabilities(ModelProvider.Cursor).tools).toBe(false);
  });

  it('keeps tools for OpenAI and unknown providers', () => {
    expect(getAttachmentCapabilities(ModelProvider.OpenAI).tools).toBe(true);
    expect(getAttachmentCapabilities('not-a-provider').tools).toBe(true);
    expect(getAttachmentCapabilities(undefined).tools).toBe(true);
  });
});

describe('resolveRuntimeProviderId', () => {
  it('returns the catalog id for builtin providers', () => {
    expect(resolveRuntimeProviderId({ provider: ModelProvider.Cursor })).toBe(ModelProvider.Cursor);
    expect(
      resolveRuntimeProviderId({
        provider: ModelProvider.OpenAI,
        providerConfig: { settings: { sdkType: 'anthropic' }, source: 'builtin' },
      }),
    ).toBe(ModelProvider.OpenAI);
  });

  it('maps a custom provider with sdkType cursor to cursor', () => {
    expect(
      resolveRuntimeProviderId({
        provider: 'my-cursor-proxy',
        providerConfig: { settings: { sdkType: 'cursor' }, source: 'custom' },
      }),
    ).toBe(ModelProvider.Cursor);
  });

  it('maps a custom provider with sdkType openai to openai', () => {
    expect(
      resolveRuntimeProviderId({
        provider: 'my-openai-proxy',
        providerConfig: { settings: { sdkType: 'openai' }, source: 'custom' },
      }),
    ).toBe(ModelProvider.OpenAI);
  });

  it('defaults custom providers without sdkType to openai', () => {
    expect(
      resolveRuntimeProviderId({
        provider: 'acme-llm',
        providerConfig: { settings: {}, source: 'custom' },
      }),
    ).toBe(ModelProvider.OpenAI);
  });

  it('uses source=custom even when the catalog id looks builtin-shaped', () => {
    expect(
      resolveRuntimeProviderId({
        provider: 'openai',
        providerConfig: { settings: { sdkType: 'cursor' }, source: 'custom' },
      }),
    ).toBe(ModelProvider.Cursor);
  });
});

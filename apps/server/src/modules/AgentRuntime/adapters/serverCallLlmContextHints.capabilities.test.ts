/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveServerCallLlmContextHints } from './serverCallLlmContextHints';

const { loadModels } = vi.hoisted(() => ({ loadModels: vi.fn() }));

vi.mock('@/business/client/model-bank/loadModels', () => ({ loadModels }));

const builtinModels = [
  // ChatGPT Web and ChatGPT (Codex) implement native document parts.
  { abilities: { files: true, vision: true }, id: 'auto', providerId: 'chatgptweb', type: 'chat' },
  { abilities: { vision: true }, id: 'gpt-5-3-mini', providerId: 'chatgptweb', type: 'chat' },
  // ChatGPT (Codex) subscription runtime.
  {
    abilities: { files: true, vision: true },
    id: 'gpt-5.6-sol',
    providerId: 'chatgpt',
    type: 'chat',
  },
  // Same card addressed by Azure-style deploymentName rather than catalog id.
  {
    abilities: { files: true, vision: true },
    config: { deploymentName: 'gpt-5.6-sol-deployed' },
    id: 'corp-sol',
    providerId: 'chatgpt',
    type: 'chat',
  },
  // OpenCode Zen advertises `abilities.files` on an OpenAI-compatible wire
  // format that has no file part.
  {
    abilities: { files: true, vision: true },
    id: 'gemini-3.1-pro',
    providerId: 'opencodezen',
    type: 'chat',
  },
];

const resolveCapabilities = async () => {
  const hints = await resolveServerCallLlmContextHints({
    ctx: { agentConfig: { chatConfig: {} } } as any,
    llmPayload: { messages: [] } as any,
    model: 'auto',
    provider: 'chatgptweb',
  });

  return hints.capabilities;
};

describe('resolveServerCallLlmContextHints — capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadModels.mockResolvedValue(builtinModels);
  });

  it('enables native file parts only for providers implementing the wire format', async () => {
    const capabilities = await resolveCapabilities();

    expect(capabilities.isCanUseFiles('auto', 'chatgptweb')).toBe(true);
    // Regression: `abilities.files` alone must not switch on native `file_url`
    // parts — the document would be dropped from the OpenCode Zen prompt.
    expect(capabilities.isCanUseFiles('gemini-3.1-pro', 'opencodezen')).toBe(false);
    expect(capabilities.isCanUseFiles('gpt-5-3-mini', 'chatgptweb')).toBe(false);
    expect(capabilities.isCanUseFiles('unknown-model', 'chatgptweb')).toBe(false);
  });

  it('enables native file parts for ChatGPT Codex models', async () => {
    const capabilities = await resolveCapabilities();

    expect(capabilities.isCanUseFiles('gpt-5.6-sol', 'chatgpt')).toBe(true);
  });

  it('resolves files ability by deploymentName when the catalog id differs', async () => {
    const capabilities = await resolveCapabilities();

    expect(capabilities.isCanUseFiles('gpt-5.6-sol-deployed', 'chatgpt')).toBe(true);
  });

  it('keeps the vision ability untouched by the native-file gate', async () => {
    const capabilities = await resolveCapabilities();

    expect(capabilities.isCanUseVision('gemini-3.1-pro', 'opencodezen')).toBe(true);
    expect(capabilities.isCanUseVision('auto', 'chatgptweb')).toBe(true);
  });

  it('resolves files from the same model source/fallback rules as vision', async () => {
    const capabilities = await resolveCapabilities();

    // Both read the builtin catalog and fall back to the same-id entry of
    // another provider when the exact (id, provider) pair is missing. The
    // provider gate is what keeps the fallback from enabling native parts.
    expect(capabilities.isCanUseVision('gemini-3.1-pro', 'a-custom-provider')).toBe(true);
    expect(capabilities.isCanUseFiles('gemini-3.1-pro', 'a-custom-provider')).toBe(false);
  });
});

describe('resolveServerCallLlmContextHints — extendParams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not inherit origin effort controls onto a non-aggregator empty card', async () => {
    loadModels.mockResolvedValue([
      {
        id: 'hunyuan-t1',
        providerId: 'hunyuan',
        settings: { extendParams: ['hy3ReasoningEffort'] },
      },
      {
        id: 'hunyuan-t1',
        providerId: 'cometapi',
        settings: { extendParams: [] },
      },
    ]);

    const hints = await resolveServerCallLlmContextHints({
      ctx: { agentConfig: { chatConfig: { hy3ReasoningEffort: 'no_think' } } } as any,
      llmPayload: { messages: [] } as any,
      model: 'hunyuan-t1',
      provider: 'cometapi',
    });

    expect(hints.resolvedExtendParams?.reasoning_effort).toBeUndefined();
  });

  it('still copies origin effort controls onto an empty LobeHub aggregator card', async () => {
    loadModels.mockResolvedValue([
      {
        id: 'hunyuan-t1',
        providerId: 'hunyuan',
        settings: { extendParams: ['hy3ReasoningEffort'] },
      },
      {
        id: 'hunyuan-t1',
        providerId: 'lobehub',
        settings: { extendParams: [] },
      },
    ]);

    const hints = await resolveServerCallLlmContextHints({
      ctx: { agentConfig: { chatConfig: { hy3ReasoningEffort: 'no_think' } } } as any,
      llmPayload: { messages: [] } as any,
      model: 'hunyuan-t1',
      provider: 'lobehub',
    });

    expect(hints.resolvedExtendParams?.reasoning_effort).toBe('no_think');
  });
});

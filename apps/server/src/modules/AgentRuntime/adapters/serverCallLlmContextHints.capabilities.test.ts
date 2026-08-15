/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveServerCallLlmContextHints } from './serverCallLlmContextHints';

const { loadModels } = vi.hoisted(() => ({ loadModels: vi.fn() }));

vi.mock('@/business/client/model-bank/loadModels', () => ({ loadModels }));

const builtinModels = [
  // ChatGPT Web: the only provider whose runtime uploads documents natively.
  { abilities: { files: true, vision: true }, id: 'auto', providerId: 'chatgptweb', type: 'chat' },
  { abilities: { vision: true }, id: 'gpt-5-3-mini', providerId: 'chatgptweb', type: 'chat' },
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

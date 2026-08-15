import { type EnabledAiModel, ModelProvider } from 'model-bank';
import { afterEach, describe, expect, it } from 'vitest';

import { useAiInfraStore } from '@/store/aiInfra';

import {
  getRuntimeModelKnowledgeCutoff,
  isCanUseAudio,
  isCanUseFiles,
  isCanUseVideo,
  isCanUseVision,
} from './helper';

describe('chat helper', () => {
  afterEach(() => {
    useAiInfraStore.setState({ enabledAiModels: [] });
  });

  it('should resolve LobeHub routed model abilities by model id fallback', () => {
    useAiInfraStore.setState({
      enabledAiModels: [
        {
          abilities: { audio: true, video: true, vision: true },
          id: 'gemini-3.1-flash-lite-preview',
          providerId: ModelProvider.Google,
          type: 'chat',
        } as EnabledAiModel,
      ],
    });

    expect(isCanUseVision('gemini-3.1-flash-lite-preview', ModelProvider.LobeHub)).toBe(true);
    expect(isCanUseVideo('gemini-3.1-flash-lite-preview', ModelProvider.LobeHub)).toBe(true);
    expect(isCanUseAudio('gemini-3.1-flash-lite-preview', ModelProvider.LobeHub)).toBe(true);
  });

  it('should not fallback across non-LobeHub providers', () => {
    useAiInfraStore.setState({
      enabledAiModels: [
        {
          abilities: { audio: true, video: true, vision: true },
          id: 'gemini-3.1-flash-lite-preview',
          providerId: ModelProvider.Google,
          type: 'chat',
        } as EnabledAiModel,
      ],
    });

    expect(isCanUseVision('gemini-3.1-flash-lite-preview', ModelProvider.OpenAI)).toBe(false);
    expect(isCanUseVideo('gemini-3.1-flash-lite-preview', ModelProvider.OpenAI)).toBe(false);
    expect(isCanUseAudio('gemini-3.1-flash-lite-preview', ModelProvider.OpenAI)).toBe(false);
  });

  describe('isCanUseFiles', () => {
    it('should enable native file parts only for providers implementing the wire format', () => {
      useAiInfraStore.setState({
        enabledAiModels: [
          {
            abilities: { files: true, vision: true },
            id: 'auto',
            providerId: 'chatgptweb',
            type: 'chat',
          } as EnabledAiModel,
        ],
      });

      expect(isCanUseFiles('auto', 'chatgptweb')).toBe(true);
    });

    it('should keep OpenCode Zen models (abilities.files) on the legacy files_info injection', () => {
      // Regression: `abilities.files` alone must NOT switch on native `file_url`
      // parts — OpenCode Zen ships enabled models with `files: true` while its
      // OpenAI-compatible wire format has no file part, so emitting native parts
      // would silently drop the document from the prompt.
      useAiInfraStore.setState({
        enabledAiModels: [
          {
            abilities: { files: true, functionCall: true, reasoning: true, vision: true },
            id: 'gemini-3.1-pro',
            providerId: 'opencodezen',
            type: 'chat',
          } as EnabledAiModel,
        ],
      });

      expect(isCanUseFiles('gemini-3.1-pro', 'opencodezen')).toBe(false);
      // The ability itself is untouched — only the native-part switch is gated.
      expect(isCanUseVision('gemini-3.1-pro', 'opencodezen')).toBe(true);
    });

    it('should stay false for a native provider whose model lacks the ability', () => {
      useAiInfraStore.setState({
        enabledAiModels: [
          {
            abilities: { vision: true },
            id: 'auto',
            providerId: 'chatgptweb',
            type: 'chat',
          } as EnabledAiModel,
        ],
      });

      expect(isCanUseFiles('auto', 'chatgptweb')).toBe(false);
    });

    it('should not enable native file parts for LobeHub-routed models', () => {
      useAiInfraStore.setState({
        enabledAiModels: [
          {
            abilities: { files: true },
            id: 'gemini-3.1-pro',
            providerId: ModelProvider.Google,
            type: 'chat',
          } as EnabledAiModel,
        ],
      });

      expect(isCanUseFiles('gemini-3.1-pro', ModelProvider.LobeHub)).toBe(false);
    });
  });

  it('should resolve exact model knowledge cutoff', () => {
    useAiInfraStore.setState({
      enabledAiModels: [
        {
          id: 'gpt-4o',
          knowledgeCutoff: '2023-10',
          providerId: ModelProvider.OpenAI,
          type: 'chat',
        } as EnabledAiModel,
      ],
    });

    expect(getRuntimeModelKnowledgeCutoff('gpt-4o', ModelProvider.OpenAI)).toBe('2023-10');
  });

  it('should resolve LobeHub routed model knowledge cutoff by model id fallback', () => {
    useAiInfraStore.setState({
      enabledAiModels: [
        {
          id: 'gemini-3.1-flash-lite-preview',
          knowledgeCutoff: '2025-01',
          providerId: ModelProvider.Google,
          type: 'chat',
        } as EnabledAiModel,
      ],
    });

    expect(
      getRuntimeModelKnowledgeCutoff('gemini-3.1-flash-lite-preview', ModelProvider.LobeHub),
    ).toBe('2025-01');
  });

  it('should not fallback model knowledge cutoff across non-LobeHub providers', () => {
    useAiInfraStore.setState({
      enabledAiModels: [
        {
          id: 'gemini-3.1-flash-lite-preview',
          knowledgeCutoff: '2025-01',
          providerId: ModelProvider.Google,
          type: 'chat',
        } as EnabledAiModel,
      ],
    });

    expect(
      getRuntimeModelKnowledgeCutoff('gemini-3.1-flash-lite-preview', ModelProvider.OpenAI),
    ).toBeUndefined();
  });
});

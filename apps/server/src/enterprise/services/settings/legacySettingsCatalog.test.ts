// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { validateLegacySettingsUpdate } from './legacySettingsCatalog';
import { settingsRegistry } from './registry';

const validReasoningGraph = {
  edges: [
    {
      condition: {
        properties: { prompt: { type: 'string' } },
        type: 'object',
      },
      from: '__root__',
      input: { fields: [{ field: 'answer', from: '__root__', required: true }] },
      instruction: 'Answer the prompt',
      output: { fields: [{ field: 'answer', required: true }], instruction: 'Return answer' },
      to: 'answer-node',
    },
  ],
  fields: {
    answer: {
      desc: 'Final answer',
      schema: {
        properties: { value: { type: 'string' } },
        required: ['value'],
        type: 'object',
      },
    },
  },
  name: 'answer graph',
  nodes: { 'answer-node': { type: 'llm' } },
  terminal: 'answer-node',
};

const graphPayload = (graph: unknown) => ({
  defaultAgent: { config: { chatConfig: { graph } } },
});

describe('strict legacy settings catalog (B4-R2)', () => {
  it.each([
    [
      'Advanced disableGatewayMode sparse patch',
      { defaultAgent: { config: { chatConfig: { disableGatewayMode: true } } } },
    ],
    [
      'model/provider/system role and all released LLM params',
      {
        defaultAgent: {
          config: {
            model: 'gpt-4o-mini',
            params: {
              frequency_penalty: 0.2,
              max_tokens: 4096,
              presence_penalty: 0.1,
              reasoning_effort: 'high',
              temperature: 0.7,
              top_p: 0.9,
            },
            provider: 'openai',
            systemRole: 'hi',
          },
        },
      },
    ],
    [
      'released chatConfig nested fields',
      {
        defaultAgent: {
          config: {
            chatConfig: {
              enableStreaming: true,
              historyCount: 12,
              memory: { effort: 'high', enabled: true, toolPermission: 'read-only' },
              runtimeEnv: { workingDirectory: '/workspace' },
              searchFCModel: { model: 'gpt-4o-mini', provider: 'openai' },
              selfIteration: { enabled: true },
              toolMode: 'agent',
            },
          },
        },
      },
    ],
    [
      'strict reasoning graph with intentional JSON Schema records',
      graphPayload(validReasoningGraph),
    ],
    [
      'released config and metadata presentation fields',
      {
        defaultAgent: {
          config: {
            avatar: '🤖',
            backgroundColor: '#fff',
            openingMessage: 'Hello',
            openingQuestions: ['Help me'],
            plugins: ['search', { identifier: 'memory', mode: 'disabled' }],
            title: 'Assistant',
            tts: {
              showAllLocaleVoice: true,
              sttLocale: 'en-US',
              ttsService: 'openai',
              voice: { openai: 'alloy' },
            },
            virtual: false,
          },
          meta: {
            avatar: '🤖',
            backgroundColor: '#fff',
            description: 'desc',
            marketIdentifier: 'market-agent',
            tags: ['tag'],
            title: 'Assistant',
          },
        },
      },
    ],
  ])('accepts %s', (_name, payload) => {
    const result = validateLegacySettingsUpdate(payload);
    expect(result.ok).toBe(true);
  });

  it('preserves sparse chatConfig without injecting canonical defaults', () => {
    const result = validateLegacySettingsUpdate({
      defaultAgent: { config: { chatConfig: { disableGatewayMode: true } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        defaultAgent: { config: { chatConfig: { disableGatewayMode: true } } },
      });
    }
  });

  it('rejects unknown nested defaultAgent.config field with zero-write semantics', () => {
    const r = validateLegacySettingsUpdate({
      defaultAgent: {
        config: { model: 'x', unknownNested: true },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toMatch(/UNKNOWN|INVALID/);
    }
  });

  it('rejects secret-like nested general.apiKey', () => {
    const r = validateLegacySettingsUpdate({
      general: { fontSize: 14, apiKey: 'sk-x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('MANAGED_SETTING_SECRET_PATH');
    }
  });

  it.each([
    ['meta', { defaultAgent: { meta: { title: 'A', unknownNested: true } } }],
    [
      'chatConfig memory',
      { defaultAgent: { config: { chatConfig: { memory: { enabled: true, extra: 1 } } } } },
    ],
    [
      'chatConfig runtimeEnv',
      {
        defaultAgent: {
          config: { chatConfig: { runtimeEnv: { workingDirectory: '/tmp', extra: true } } },
        },
      },
    ],
    ['params', { defaultAgent: { config: { params: { temperature: 1, extra: 1 } } } }],
    [
      'plugin object',
      {
        defaultAgent: {
          config: { plugins: [{ identifier: 'search', mode: 'pinned', extra: true }] },
        },
      },
    ],
    [
      'tts voice',
      { defaultAgent: { config: { tts: { voice: { openai: 'alloy', unknown: 'voice' } } } } },
    ],
  ])('rejects unknown nested fields in %s', (_name, payload) => {
    const result = validateLegacySettingsUpdate(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toMatch(/UNKNOWN|INVALID/);
  });

  it.each([
    ['graph root', graphPayload({ ...validReasoningGraph, unknownRoot: true })],
    [
      'graph node',
      graphPayload({
        ...validReasoningGraph,
        nodes: { 'answer-node': { type: 'llm', unknownNode: true } },
      }),
    ],
    [
      'graph field',
      graphPayload({
        ...validReasoningGraph,
        fields: {
          answer: { ...validReasoningGraph.fields.answer, unknownField: true },
        },
      }),
    ],
    [
      'graph edge',
      graphPayload({
        ...validReasoningGraph,
        edges: [{ ...validReasoningGraph.edges[0], unknownEdge: true }],
      }),
    ],
    [
      'graph input',
      graphPayload({
        ...validReasoningGraph,
        edges: [
          {
            ...validReasoningGraph.edges[0],
            input: { ...validReasoningGraph.edges[0].input, unknownInput: true },
          },
        ],
      }),
    ],
    [
      'graph input field',
      graphPayload({
        ...validReasoningGraph,
        edges: [
          {
            ...validReasoningGraph.edges[0],
            input: {
              fields: [
                { ...validReasoningGraph.edges[0].input.fields[0], unknownInputField: true },
              ],
            },
          },
        ],
      }),
    ],
    [
      'graph output',
      graphPayload({
        ...validReasoningGraph,
        edges: [
          {
            ...validReasoningGraph.edges[0],
            output: { ...validReasoningGraph.edges[0].output, unknownOutput: true },
          },
        ],
      }),
    ],
    [
      'graph output field',
      graphPayload({
        ...validReasoningGraph,
        edges: [
          {
            ...validReasoningGraph.edges[0],
            output: {
              ...validReasoningGraph.edges[0].output,
              fields: [
                { ...validReasoningGraph.edges[0].output.fields[0], unknownOutputField: true },
              ],
            },
          },
        ],
      }),
    ],
  ])('rejects unknown fields recursively in %s', (_name, payload) => {
    const result = validateLegacySettingsUpdate(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toMatch(/UNKNOWN|INVALID/);
  });

  it('rejects unexpected top-level languageModel', () => {
    const r = validateLegacySettingsUpdate({
      languageModel: { openai: {} },
    });
    expect(r.ok).toBe(false);
  });

  it('accepts systemAgent.reasoningEffort high', () => {
    const result = validateLegacySettingsUpdate({
      systemAgent: {
        thread: { reasoningEffort: 'medium' },
        topic: { model: 'gpt-4o-mini', provider: 'openai', reasoningEffort: 'high' },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.systemAgent?.topic?.reasoningEffort).toBe('high');
      expect(result.value.systemAgent?.thread?.reasoningEffort).toBe('medium');
    }
  });

  it('preserves sparse systemAgent without injecting reasoningEffort', () => {
    const result = validateLegacySettingsUpdate({
      systemAgent: { topic: { model: 'gpt-4o-mini', provider: 'openai' } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        systemAgent: { topic: { model: 'gpt-4o-mini', provider: 'openai' } },
      });
    }
  });

  it('accepts systemAgent.reasoningEffort null as explicit clear', () => {
    const result = validateLegacySettingsUpdate({
      systemAgent: { topic: { reasoningEffort: null } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.systemAgent?.topic?.reasoningEffort).toBeNull();
      // User save path: catalog then registry leaf. Null must pass both.
      expect(
        settingsRegistry.validateValue(
          'systemAgent.topic.reasoningEffort',
          result.value.systemAgent?.topic?.reasoningEffort,
        ).ok,
      ).toBe(true);
    }
  });

  it('rejects bogus systemAgent.reasoningEffort', () => {
    const result = validateLegacySettingsUpdate({
      systemAgent: { topic: { reasoningEffort: 'bogus' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MANAGED_SETTING_INVALID_VALUE');
  });

  it('still rejects unknown systemAgent item fields', () => {
    const result = validateLegacySettingsUpdate({
      systemAgent: { topic: { model: 'x', extra: true } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toMatch(/UNKNOWN|INVALID/);
  });
});

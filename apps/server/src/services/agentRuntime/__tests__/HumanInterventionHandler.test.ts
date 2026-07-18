// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HumanInterventionHandler } from '../HumanInterventionHandler';

const buildHandler = (
  pluginQuery: ReturnType<typeof vi.fn>,
  messageModel: {
    approvePendingMessagePlugin: any;
    findMessagePlugin: any;
    rejectPendingMessagePlugin: any;
  },
) => {
  const serverDB = { query: { messagePlugins: { findFirst: pluginQuery } } } as any;
  return new HumanInterventionHandler(serverDB, messageModel as any);
};

describe('HumanInterventionHandler.process', () => {
  let mockMessageModel: {
    approvePendingMessagePlugin: any;
    findMessagePlugin: any;
    rejectPendingMessagePlugin: any;
  };
  let mockDBPluginQuery: ReturnType<typeof vi.fn>;
  let handler: HumanInterventionHandler;

  const makeState = (overrides: Record<string, any> = {}) => ({
    lastModified: new Date().toISOString(),
    pendingToolsCalling: [
      {
        apiName: 'search',
        arguments: '{}',
        id: 'tool-call-1',
        identifier: 'web-search',
        type: 'default',
      },
      {
        apiName: 'write',
        arguments: '{}',
        id: 'tool-call-2',
        identifier: 'local-system',
        type: 'default',
      },
    ],
    status: 'waiting_for_human',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const persistedPlugin = {
      apiName: 'search',
      arguments: '{}',
      identifier: 'web-search',
      intervention: { kind: 'approval', status: 'pending' },
      toolCallId: 'tool-call-1',
      type: 'default',
    };
    mockDBPluginQuery = vi.fn().mockResolvedValue(persistedPlugin);
    mockMessageModel = {
      approvePendingMessagePlugin: vi.fn().mockResolvedValue(true),
      findMessagePlugin: vi.fn().mockResolvedValue(persistedPlugin),
      rejectPendingMessagePlugin: vi.fn().mockResolvedValue(true),
    };
    handler = buildHandler(mockDBPluginQuery, mockMessageModel);
  });

  describe('approve path', () => {
    it('persists intervention=approved on the tool message', async () => {
      const state = makeState();

      await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.approvePendingMessagePlugin).toHaveBeenCalledWith('tool-msg-1');
    });

    it('returns nextContext with phase=human_approved_tool and skipCreateToolMessage=true', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.nextContext).toEqual({
        payload: {
          approvedToolCall: {
            apiName: 'search',
            arguments: '{}',
            id: 'tool-call-1',
            identifier: 'web-search',
            type: 'default',
          },
          parentMessageId: 'tool-msg-1',
          skipCreateToolMessage: true,
        },
        phase: 'human_approved_tool',
      });
    });

    it('removes the approved tool from pendingToolsCalling', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.pendingToolsCalling).toHaveLength(1);
      expect(result.newState.pendingToolsCalling[0].id).toBe('tool-call-2');
    });

    it('keeps state waiting_for_human while other tools still pending', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('waiting_for_human');
    });

    it('transitions to running when last pending tool is approved', async () => {
      const state = makeState({
        pendingToolsCalling: [
          {
            apiName: 'search',
            arguments: '{}',
            id: 'tool-call-1',
            identifier: 'web-search',
            type: 'default',
          },
        ],
      });

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('running');
    });

    it('no-ops when toolMessageId is missing', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
      });

      expect(mockMessageModel.approvePendingMessagePlugin).not.toHaveBeenCalled();
      expect(result.nextContext).toBeUndefined();
    });

    it('fails closed when pending execution fields differ from the persisted plugin', async () => {
      const base = {
        apiName: 'search',
        arguments: '{}',
        id: 'tool-call-1',
        identifier: 'web-search',
        type: 'default',
      };
      for (const pendingTool of [
        { ...base, apiName: 'danger' },
        { ...base, arguments: '{"admin":true}' },
        { ...base, identifier: 'builtin-admin' },
        { ...base, type: 'builtin' },
      ]) {
        const result = await handler.process(makeState({ pendingToolsCalling: [pendingTool] }), {
          approvedToolCall: { ...pendingTool, source: 'composio', type: 'mcp' },
          toolMessageId: 'tool-msg-1',
        });
        expect(result.nextContext).toBeUndefined();
      }
      expect(mockMessageModel.approvePendingMessagePlugin).not.toHaveBeenCalled();
    });

    it('rebuilds source from the operation tool set instead of the request payload', async () => {
      const result = await handler.process(
        makeState({ operationToolSet: { sourceMap: { 'web-search': 'mcp' } } }),
        {
          approvedToolCall: { id: 'tool-call-1', source: 'composio', type: 'builtin' },
          toolMessageId: 'tool-msg-1',
        },
      );

      const payload = result.nextContext?.payload as { approvedToolCall?: unknown } | undefined;
      expect(payload?.approvedToolCall).toMatchObject({
        identifier: 'web-search',
        source: 'mcp',
        type: 'default',
      });
    });
  });

  describe('reject path (pure)', () => {
    it('persists intervention=rejected with reason and updates content', async () => {
      const state = makeState();

      await handler.process(state, {
        rejectionReason: 'privacy concern',
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.rejectPendingMessagePlugin).toHaveBeenCalledWith('tool-msg-1', {
        content: 'User reject this tool calling with reason: privacy concern',
        rejectedReason: 'privacy concern',
      });
    });

    it('does not enter the reject branch when rejectionReason is falsy', async () => {
      const state = makeState();

      await handler.process(state, {
        rejectionReason: '',
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.rejectPendingMessagePlugin).not.toHaveBeenCalled();
    });

    it('writes "with reason" content for any non-empty reason', async () => {
      const state = makeState();

      await handler.process(state, {
        rejectionReason: 'r',
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.rejectPendingMessagePlugin).toHaveBeenCalledWith(
        'tool-msg-1',
        expect.objectContaining({
          content: 'User reject this tool calling with reason: r',
        }),
      );
    });

    it('removes the rejected tool from pendingToolsCalling by tool_call_id lookup', async () => {
      const state = makeState();
      mockMessageModel.findMessagePlugin.mockResolvedValueOnce({
        intervention: { kind: 'approval', status: 'pending' },
        toolCallId: 'tool-call-2',
      });

      const result = await handler.process(state, {
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-2',
      });

      expect(result.newState.pendingToolsCalling).toHaveLength(1);
      expect(result.newState.pendingToolsCalling[0].id).toBe('tool-call-1');
    });

    it('transitions to interrupted + reason=human_rejected (pure reject, no continue)', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('interrupted');
      expect(result.newState.interruption).toEqual(
        expect.objectContaining({
          canResume: false,
          reason: 'human_rejected',
        }),
      );
      expect(result.nextContext).toBeUndefined();
    });
  });

  describe('reject_continue path', () => {
    it('stays paused (nextContext=undefined) when other tools are still pending', async () => {
      // makeState() has 2 pending; pluginQuery resolves tool-call-1 → 1 left.
      // Returning a `phase: 'user_input'` context here would resume the LLM
      // before the remaining pending tools are decided (review P1).
      const state = makeState();
      mockMessageModel.findMessagePlugin.mockResolvedValueOnce({
        intervention: { kind: 'approval', status: 'pending' },
        toolCallId: 'tool-call-1',
      });

      const result = await handler.process(state, {
        rejectAndContinue: true,
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('waiting_for_human');
      expect(result.nextContext).toBeUndefined();
    });

    it('returns nextContext with phase=user_input only when this is the last pending tool', async () => {
      const state = makeState({
        pendingToolsCalling: [
          { apiName: 'search', arguments: '{}', id: 'tool-call-1', identifier: 'web-search' },
        ],
      });
      mockMessageModel.findMessagePlugin.mockResolvedValueOnce({
        intervention: { kind: 'approval', status: 'pending' },
        toolCallId: 'tool-call-1',
      });

      const result = await handler.process(state, {
        rejectAndContinue: true,
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState.status).toBe('running');
      expect(result.nextContext).toEqual({ phase: 'user_input' });
    });

    it('still persists intervention=rejected on the tool message', async () => {
      const state = makeState();

      await handler.process(state, {
        rejectAndContinue: true,
        rejectionReason: 'privacy',
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.rejectPendingMessagePlugin).toHaveBeenCalledWith('tool-msg-1', {
        content: 'User reject this tool calling with reason: privacy',
        rejectedReason: 'privacy',
      });
    });

    it('fails closed without transitioning state when rejection CAS loses', async () => {
      mockMessageModel.rejectPendingMessagePlugin.mockResolvedValue(false);
      const state = makeState();

      const result = await handler.process(state, {
        rejectAndContinue: true,
        rejectionReason: 'stale',
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState).toBe(state);
      expect(result.nextContext).toBeUndefined();
    });

    it('never rejects a toolResult-kind human-answer interaction', async () => {
      mockMessageModel.findMessagePlugin.mockResolvedValue({
        intervention: { kind: 'toolResult', status: 'pending' },
        toolCallId: 'tool-call-1',
      });
      const state = makeState();

      const result = await handler.process(state, {
        rejectionReason: 'wrong path',
        toolMessageId: 'tool-msg-1',
      });

      expect(mockMessageModel.rejectPendingMessagePlugin).not.toHaveBeenCalled();
      expect(result.newState).toBe(state);
    });
  });

  describe('no-op paths', () => {
    it('returns state unchanged when status is not waiting_for_human (approve)', async () => {
      const state = makeState({ status: 'running' });

      const result = await handler.process(state, {
        approvedToolCall: { id: 'tool-call-1' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState).toBe(state);
      expect(result.nextContext).toBeUndefined();
      expect(mockMessageModel.approvePendingMessagePlugin).not.toHaveBeenCalled();
    });

    it('returns state unchanged when status is not waiting_for_human (reject)', async () => {
      const state = makeState({ status: 'running' });

      const result = await handler.process(state, {
        rejectionReason: 'nope',
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState).toBe(state);
      expect(result.nextContext).toBeUndefined();
    });

    it('handles humanInput as out-of-scope (no state transition)', async () => {
      const state = makeState();

      const result = await handler.process(state, {
        humanInput: { response: 'hi' },
        toolMessageId: 'tool-msg-1',
      });

      expect(result.newState).toBe(state);
      expect(result.nextContext).toBeUndefined();
    });
  });
});

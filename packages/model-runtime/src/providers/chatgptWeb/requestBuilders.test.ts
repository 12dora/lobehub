import { describe, expect, it } from 'vitest';

import {
  buildConversationBody,
  buildFConversationBody,
  buildFileCreateBody,
  buildImageConversationBodies,
  buildPrepareBody,
  normalizeThinkingEffort,
  toConversationMessages,
} from './requestBuilders';
import type { AttachmentRef } from './types';

const imageRef: AttachmentRef = {
  height: 512,
  id: 'file_img',
  kind: 'image',
  mimeType: 'image/png',
  name: 'image_1.png',
  size: 1234,
  width: 512,
};

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

const docRef: AttachmentRef = {
  fileTokenSize: 900,
  id: 'file_doc',
  kind: 'document',
  mimeType: 'application/pdf',
  name: 'report.pdf',
  size: 4567,
};

describe('normalizeThinkingEffort', () => {
  // upstream accepts standard | extended | max only (verified live 2026-08-15:
  // low / medium / high are rejected with 422 "Invalid conversation body")
  it.each([
    ['', undefined],
    ['auto', undefined],
    ['none', undefined],
    ['minimal', undefined],
    ['nonsense', undefined],
    ['low', 'standard'],
    ['MEDIUM', 'standard'],
    ['high', 'extended'],
    ['standard', 'standard'],
    ['max', 'max'],
    ['xhigh', 'extended'],
    ['extended', 'extended'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeThinkingEffort(input)).toBe(expected);
  });
});

describe('buildConversationBody', () => {
  it('never sends a conversation_id and uses a fresh parent uuid', () => {
    const body = buildConversationBody({
      messages: [{ content: 'hi', role: 'user' }],
      model: 'auto',
    });

    expect(body).not.toHaveProperty('conversation_id');
    expect(body.parent_message_id).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
    );
    expect(body.action).toBe('next');
    expect(body.model).toBe('auto');
    expect(body.history_and_training_disabled).toBe(true);
    expect(body.force_use_sse).toBe(true);
    expect(body.system_hints).toEqual([]);
    expect(body.timezone).toBe('UTC');
    expect(body.timezone_offset_min).toBe(0);
    expect(body).not.toHaveProperty('thinking_effort');
    expect(body.messages[0]).toMatchObject({
      author: { role: 'user' },
      content: { content_type: 'text', parts: ['hi'] },
    });
  });

  it('adds thinking_effort only when it normalizes to a value', () => {
    expect(
      buildConversationBody({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        thinkingEffort: 'xhigh',
      }).thinking_effort,
    ).toBe('extended');

    expect(
      buildConversationBody({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        thinkingEffort: 'auto',
      }),
    ).not.toHaveProperty('thinking_effort');
  });

  it('replays every role as its own upstream message', () => {
    const body = buildConversationBody({
      messages: [
        { content: 'you are helpful', role: 'system' },
        { content: 'hi', role: 'user' },
        { content: 'hello', role: 'assistant' },
        { content: 'again', role: 'user' },
      ],
      model: 'gpt-5-5',
    });

    expect(body.messages.map((message: any) => message.author.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });
});

describe('toConversationMessages', () => {
  it('places image pointers before the text and mirrors them in attachments', () => {
    const [message] = toConversationMessages([
      { attachments: [imageRef], content: 'describe this', role: 'user' },
    ]);

    expect(message.content.content_type).toBe('multimodal_text');
    expect(message.content.parts).toEqual([
      {
        asset_pointer: 'file-service://file_img',
        content_type: 'image_asset_pointer',
        height: 512,
        size_bytes: 1234,
        width: 512,
      },
      'describe this',
    ]);
    expect(message.metadata.attachments).toEqual([
      {
        height: 512,
        id: 'file_img',
        mime_type: 'image/png',
        name: 'image_1.png',
        size: 1234,
        source: 'local',
        width: 512,
      },
    ]);
  });

  it('keeps documents as plain text with attachment metadata only', () => {
    const [message] = toConversationMessages([
      { attachments: [docRef], content: 'summarize', role: 'user' },
    ]);

    expect(message.content).toEqual({ content_type: 'text', parts: ['summarize'] });
    expect(message.metadata.attachments).toEqual([
      {
        fileTokenSize: 900,
        id: 'file_doc',
        mime_type: 'application/pdf',
        name: 'report.pdf',
        size: 4567,
        source: 'local',
      },
    ]);
  });

  it('sets the system hints on the last message only', () => {
    const messages = toConversationMessages(
      [
        { content: 'a', role: 'user' },
        { content: 'b', role: 'user' },
      ],
      { lastMessageSystemHints: ['search'], withRichMetadata: true },
    );

    expect(messages[0].metadata.system_hints).toBeUndefined();
    expect(messages[1].metadata.system_hints).toEqual(['search']);
    expect(messages[1].metadata.serialization_metadata).toEqual({ custom_symbol_offsets: [] });
    expect(typeof messages[1].create_time).toBe('number');
  });
});

describe('buildPrepareBody', () => {
  it('puts the system hints at the top level and only the prompt in partial_query', () => {
    const body = buildPrepareBody({
      model: 'gpt-5-5',
      prompt: 'weather?',
      systemHints: ['search'],
    });

    expect(body.system_hints).toEqual(['search']);
    expect(body.client_prepare_state).toBe('success');
    expect(body.parent_message_id).toBe('client-created-root');
    expect(body.partial_query.content).toEqual({ content_type: 'text', parts: ['weather?'] });
    expect(body.supports_buffering).toBe(true);
    expect(body.supported_encodings).toEqual(['v1']);
    expect(body.client_contextual_info).toEqual({ app_name: 'chatgpt.com' });
  });

  it('keeps attachment_mime_types for the document flow only', () => {
    expect(
      buildPrepareBody({
        attachmentMimeTypes: ['application/pdf'],
        flow: 'attachments',
        model: 'auto',
        prompt: 'summarize',
      }).attachment_mime_types,
    ).toEqual(['application/pdf']);

    // E3 §1.3: the image prepare never advertises the reference mime types
    expect(
      buildPrepareBody({
        attachmentMimeTypes: ['image/png'],
        flow: 'picture',
        model: 'gpt-5-5',
        prompt: 'a red panda',
      }),
    ).not.toHaveProperty('attachment_mime_types');
  });

  it('threads a fresh uuid parent for the image flow', () => {
    expect(
      buildPrepareBody({ flow: 'picture', model: 'gpt-5-5', prompt: 'x' }).parent_message_id,
    ).toMatch(UUID_RE);
  });
});

describe('buildFConversationBody', () => {
  it('turns search on with all three switches', () => {
    const body = buildFConversationBody({
      messages: [{ content: 'weather?', role: 'user' }],
      model: 'gpt-5-5',
      search: true,
    });

    expect(body.messages[0].metadata.system_hints).toEqual(['search']);
    expect(body.system_hints).toEqual([]);
    expect(body.force_use_search).toBe(true);
    expect(body.client_reported_search_source).toBe('conversation_composer_web_icon');
    // E6 §1.3: the search run reports `success`, not the image flow's `sent`
    expect(body.client_prepare_state).toBe('success');
    expect(body.paragen_cot_summary_display_override).toBe('allow');
    expect(body.conversation_mode).toEqual({ kind: 'primary_assistant' });
    expect(body.parent_message_id).toBe('client-created-root');
  });

  it('sends the exact search contextual-info block from E6 §1.3', () => {
    const body = buildFConversationBody({
      flow: 'search',
      messages: [{ content: 'weather?', role: 'user' }],
      model: 'gpt-5-5',
      search: true,
    });

    expect(body.client_contextual_info).toEqual({
      app_name: 'chatgpt.com',
      is_dark_mode: false,
      page_height: 925,
      page_width: 886,
      pixel_ratio: 2,
      screen_height: 1440,
      screen_width: 2560,
      time_since_loaded: 36,
    });
  });

  it('sends the exact picture_v2 contextual-info block from E3 §1.4 with a uuid parent', () => {
    const body = buildFConversationBody({
      flow: 'picture',
      messages: [{ content: 'a red panda', role: 'user' }],
      model: 'gpt-5-5',
      systemHints: ['picture_v2'],
    });

    expect(body.client_prepare_state).toBe('sent');
    expect(body.client_contextual_info).toEqual({
      app_name: 'chatgpt.com',
      is_dark_mode: false,
      page_height: 1072,
      page_width: 1724,
      pixel_ratio: 1.2,
      screen_height: 1440,
      screen_width: 2560,
      time_since_loaded: 1200,
    });
    expect(body.parent_message_id).toMatch(UUID_RE);
  });

  it('uses the attachment contextual-info block and `sent` for documents', () => {
    const body = buildFConversationBody({
      flow: 'attachments',
      messages: [{ attachments: [docRef], content: 'summarize', role: 'user' }],
      model: 'auto',
    });

    expect(body.client_prepare_state).toBe('sent');
    expect(body.client_contextual_info).toEqual({
      app_name: 'chatgpt.com',
      is_dark_mode: false,
      page_height: 1138,
      page_width: 803,
      pixel_ratio: 2,
      screen_height: 1440,
      screen_width: 2560,
      time_since_loaded: 401,
    });
    expect(body.parent_message_id).toBe('client-created-root');
  });

  it('omits the search switches when search is off', () => {
    const body = buildFConversationBody({
      messages: [{ attachments: [docRef], content: 'summarize', role: 'user' }],
      model: 'auto',
    });

    expect(body).not.toHaveProperty('force_use_search');
    expect(body).not.toHaveProperty('client_reported_search_source');
    expect(body.messages[0].metadata.attachments).toHaveLength(1);
  });
});

describe('buildImageConversationBodies', () => {
  it('builds the picture_v2 prepare and conversation bodies', () => {
    const { conversation, prepare } = buildImageConversationBodies({
      model: 'gpt-5-5',
      prompt: 'a red panda',
      references: [imageRef],
    });

    expect(prepare.system_hints).toEqual(['picture_v2']);
    // E3 §1.3: references are NOT announced at prepare time
    expect(prepare).not.toHaveProperty('attachment_mime_types');
    expect(prepare.partial_query.content.parts).toEqual(['a red panda']);
    expect(prepare.parent_message_id).toMatch(UUID_RE);

    expect(conversation.system_hints).toEqual(['picture_v2']);
    expect(conversation.messages[0].metadata.system_hints).toEqual(['picture_v2']);
    expect(conversation.messages[0].content.content_type).toBe('multimodal_text');
    expect(conversation.messages[0].content.parts.at(-1)).toBe('a red panda');
    expect(conversation.client_contextual_info.app_name).toBe('chatgpt.com');
    expect(conversation.client_prepare_state).toBe('sent');
    // both bodies thread their own fresh uuid, never `client-created-root`
    expect(conversation.parent_message_id).toMatch(UUID_RE);
    expect(conversation.parent_message_id).not.toBe(prepare.parent_message_id);
  });

  it('uses a plain text content for text-to-image', () => {
    const { conversation, prepare } = buildImageConversationBodies({
      model: 'gpt-5-5',
      prompt: 'a red panda',
    });

    expect(conversation.messages[0].content).toEqual({
      content_type: 'text',
      parts: ['a red panda'],
    });
    expect(prepare).not.toHaveProperty('attachment_mime_types');
  });
});

describe('buildFileCreateBody', () => {
  it('uses the multimodal use case with dimensions for images', () => {
    expect(
      buildFileCreateBody({
        height: 512,
        kind: 'image',
        mimeType: 'image/png',
        name: 'image_1.png',
        size: 10,
        width: 512,
      }),
    ).toEqual({
      file_name: 'image_1.png',
      file_size: 10,
      height: 512,
      library_persistence_mode: 'opportunistic',
      reset_rate_limits: false,
      store_in_library: true,
      timezone_offset_min: 0,
      use_case: 'multimodal',
      width: 512,
    });
  });

  it('uses the my_files use case for documents', () => {
    expect(
      buildFileCreateBody({
        kind: 'document',
        mimeType: 'application/pdf',
        name: 'report.pdf',
        size: 20,
      }),
    ).toEqual({
      file_name: 'report.pdf',
      file_size: 20,
      reset_rate_limits: false,
      timezone_offset_min: 0,
      use_case: 'my_files',
    });
  });
});

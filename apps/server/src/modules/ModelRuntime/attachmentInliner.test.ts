// @vitest-environment node
import type { OpenAIChatMessage } from '@lobechat/model-runtime';
import { buildOwnDeploymentOrigins } from '@lobechat/utils';
import { DEFAULT_IMAGE_INLINE_MAX_BYTES } from '@lobechat/utils/imageToBase64';
import { describe, expect, it, vi } from 'vitest';

import { inlineOwnOriginAttachments } from './attachmentInliner';

const ownOrigins = buildOwnDeploymentOrigins({
  appUrl: 'http://localhost:3010',
});

const OWN_FILE_URL = 'http://localhost:3010/f/file-1';
const FOREIGN_URL = 'https://cdn.example.com/cat.png';
const DATA_URI = 'data:image/png;base64,aaaa';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`;

const imageMessage = (url: string): OpenAIChatMessage => ({
  content: [{ image_url: { url }, type: 'image_url' }],
  role: 'user',
});

describe('inlineOwnOriginAttachments', () => {
  it('replaces an own-origin image_url with a data URI', async () => {
    const resolver = vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' }));
    const messages = [imageMessage(OWN_FILE_URL)];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toEqual([{ image_url: { url: PNG_DATA_URI }, type: 'image_url' }]);
    expect(resolver).toHaveBeenCalledWith(OWN_FILE_URL);
  });

  it('leaves a foreign image_url untouched', async () => {
    const resolver = vi.fn();
    const messages = [imageMessage(FOREIGN_URL)];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toEqual([{ image_url: { url: FOREIGN_URL }, type: 'image_url' }]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('leaves a data URI image_url untouched', async () => {
    const resolver = vi.fn();
    const messages = [imageMessage(DATA_URI)];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toEqual([{ image_url: { url: DATA_URI }, type: 'image_url' }]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('replaces an own-origin file_url with a data URI and keeps the other fields', async () => {
    const resolver = vi.fn(async () => ({
      bytes: PNG_BYTES,
      mimeType: 'application/pdf',
    }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              content: 'extracted text',
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'report.pdf',
              size: 12,
              url: OWN_FILE_URL,
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toEqual([
      {
        file_url: {
          content: 'extracted text',
          fileId: 'file-1',
          mimeType: 'application/pdf',
          name: 'report.pdf',
          size: 12,
          url: `data:application/pdf;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
        },
        type: 'file_url',
      },
    ]);
  });

  it('leaves an over-cap attachment URL in place and does not throw', async () => {
    const resolver = vi.fn(async () => ({
      bytes: { byteLength: DEFAULT_IMAGE_INLINE_MAX_BYTES + 1 } as Uint8Array,
      mimeType: 'image/png',
    }));
    const messages = [imageMessage(OWN_FILE_URL)];

    await expect(
      inlineOwnOriginAttachments(messages, resolver, ownOrigins),
    ).resolves.toBeUndefined();
    expect(messages[0].content).toEqual([{ image_url: { url: OWN_FILE_URL }, type: 'image_url' }]);
  });

  it('leaves the URL in place when the resolver fails', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('s3 unavailable');
    });
    const messages = [imageMessage(OWN_FILE_URL)];

    await expect(
      inlineOwnOriginAttachments(messages, resolver, ownOrigins),
    ).resolves.toBeUndefined();
    expect(messages[0].content).toEqual([{ image_url: { url: OWN_FILE_URL }, type: 'image_url' }]);
  });

  it('strips own-origin url attributes from user text and keeps foreign ones', async () => {
    const resolver = vi.fn();
    const messages: OpenAIChatMessage[] = [
      {
        content: `<image name="own" url="${OWN_FILE_URL}"></image> <image name="foreign" url="${FOREIGN_URL}"></image>`,
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toBe(
      `<image name="own"></image> <image name="foreign" url="${FOREIGN_URL}"></image>`,
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('resolves the same URL in two messages once', async () => {
    const resolver = vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' }));
    const messages = [imageMessage(OWN_FILE_URL), imageMessage(OWN_FILE_URL)];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(messages[0].content).toEqual([{ image_url: { url: PNG_DATA_URI }, type: 'image_url' }]);
    expect(messages[1].content).toEqual([{ image_url: { url: PNG_DATA_URI }, type: 'image_url' }]);
  });
});

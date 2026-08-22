// @vitest-environment node
import type { OpenAIChatMessage } from '@lobechat/model-runtime';
import type { FileRenderMetadata } from '@lobechat/types';
import { buildOwnDeploymentOrigins } from '@lobechat/utils';
import {
  DEFAULT_FILE_INLINE_MAX_BYTES,
  DEFAULT_IMAGE_INLINE_MAX_BYTES,
} from '@lobechat/utils/imageToBase64';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileModel } from '@/database/models/file';

import {
  createOwnOriginAttachmentInlineHooks,
  inlineOwnOriginAttachments,
  inlineOwnOriginImageUrls,
} from './attachmentInliner';
import { getDocumentFeedStats, resetDocumentFeedStatsForTest } from './documentFeedStats';

const fileServiceMocks = vi.hoisted(() => ({
  getFileByteArray: vi.fn(),
  getFileContent: vi.fn(),
}));

const fileModelMocks = vi.hoisted(() => ({
  findById: vi.fn(),
}));

const pdfPageImagesMocks = vi.hoisted(() => ({
  renderPdfPagesToPng: vi.fn(
    async (): Promise<
      Array<{
        height: number;
        kind?: 'page' | 'tile';
        page: number;
        png: Uint8Array;
        tile?: { col: number; row: number };
        width: number;
      }>
    > => [],
  ),
}));

vi.mock('./pdfPageImages', () => ({
  renderPdfPagesToPng: pdfPageImagesMocks.renderPdfPagesToPng,
}));

vi.mock('@/server/services/file', () => ({
  FileService: class FileService {
    getFileByteArray = fileServiceMocks.getFileByteArray;
    getFileContent = fileServiceMocks.getFileContent;
  },
}));

vi.mock('@/database/models/file', () => ({
  FileModel: class FileModel {
    static getFileById = async (_db: unknown, _id: string) => undefined;
    findById = fileModelMocks.findById;
    constructor(_db?: unknown, _userId?: string) {}
  },
}));

const ownOrigins = buildOwnDeploymentOrigins({
  appUrl: 'http://localhost:3010',
});

const s3Origins = buildOwnDeploymentOrigins({
  appUrl: 'http://localhost:3010',
  bucket: 'lobe-files',
  endpoint: 'http://localhost:9000',
  forcePathStyle: true,
});

const OWN_FILE_URL = 'http://localhost:3010/f/file-1';
const FOREIGN_URL = 'https://cdn.example.com/cat.png';
const S3_URL = 'http://localhost:9000/lobe-files/secret.png';
const S3_PRESIGNED_URL = `${S3_URL}?X-Amz-Signature=secret`;
const DATA_URI = 'data:image/png;base64,aaaa';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`;
const CURSOR_IMAGE_INLINE_MAX_BYTES = 6 * 1024 * 1024;
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% image-only fixture\n');
const PAGE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PAGE_PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PAGE_PNG).toString('base64')}`;
const PAGE_IMAGE_PART = {
  image_url: { detail: 'high' as const, url: PAGE_PNG_DATA_URI },
  type: 'image_url' as const,
};
const TILE_ORDER = [
  { col: 0, row: 0 },
  { col: 1, row: 0 },
  { col: 0, row: 1 },
  { col: 1, row: 1 },
] as const;
const rasterPageWithTiles = (page = 1) => [
  { height: 100, kind: 'page' as const, page, png: PAGE_PNG, width: 200 },
  ...TILE_ORDER.map((tile) => ({
    height: 50,
    kind: 'tile' as const,
    page,
    png: PAGE_PNG,
    tile,
    width: 100,
  })),
];
const IMAGE_ONLY_PDF_NOTICE =
  '[PDF "card.pdf" is a scanned document with no text layer. Its pages are attached above as images — read the page images directly. Do not try to read or re-parse this file with tools; extracted text will always be empty.]';
const IMAGE_ONLY_PDF_NOTICE_WITH_TILES =
  '[PDF "card.pdf" is a scanned document with no text layer. Its pages are attached above as images — read the page images directly. The page is followed by four zoomed quadrant tiles (top-left, top-right, bottom-left, bottom-right). Do not try to read or re-parse this file with tools; extracted text will always be empty.]';
const SPARSE_PDF_NOTICE =
  '[PDF "scan.pdf" text layer is sparse; pages attached as images — read the page images directly. Do not try to read or re-parse this file with tools.]';

const pdfFileUrlPart = (fileId: string, name = 'card.pdf') => ({
  file_url: {
    content: '<page pageNumber="1">\n\n</page>',
    fileId,
    mimeType: 'application/pdf' as const,
    name,
    url: `http://localhost:3010/f/${fileId}`,
  },
  type: 'file_url' as const,
});

const imageMessage = (
  url: string,
  role: OpenAIChatMessage['role'] = 'user',
): OpenAIChatMessage => ({
  content: [{ image_url: { url }, type: 'image_url' }],
  role,
});

describe('inlineOwnOriginAttachments', () => {
  beforeEach(() => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockReset();
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([]);
  });

  it('replaces an own-origin image_url with a data URI', async () => {
    const resolver = vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' }));
    const messages = [imageMessage(OWN_FILE_URL)];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toEqual([{ image_url: { url: PNG_DATA_URI }, type: 'image_url' }]);
    expect(resolver).toHaveBeenCalledWith(OWN_FILE_URL, DEFAULT_IMAGE_INLINE_MAX_BYTES);
  });

  it('leaves a foreign image_url untouched', async () => {
    const resolver = vi.fn();
    const messages = [imageMessage(FOREIGN_URL)];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toEqual([{ image_url: { url: FOREIGN_URL }, type: 'image_url' }]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('does not resolve a raw S3 object or presigned URL', async () => {
    const resolver = vi.fn();
    const messages = [imageMessage(S3_URL), imageMessage(S3_PRESIGNED_URL)];

    await inlineOwnOriginAttachments(messages, resolver, s3Origins);

    expect(messages[0].content).toEqual([{ image_url: { url: S3_URL }, type: 'image_url' }]);
    expect(messages[1].content).toEqual([
      { image_url: { url: S3_PRESIGNED_URL }, type: 'image_url' },
    ]);
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
    expect(resolver).toHaveBeenCalledWith(OWN_FILE_URL, DEFAULT_FILE_INLINE_MAX_BYTES);
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

  it('leaves an image over the Cursor 6 MiB cap in place', async () => {
    const resolver = vi.fn(async () => ({
      bytes: { byteLength: CURSOR_IMAGE_INLINE_MAX_BYTES + 1 } as Uint8Array,
      mimeType: 'image/png',
    }));
    const messages = [imageMessage(OWN_FILE_URL)];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins, {
      imageMaxBytes: CURSOR_IMAGE_INLINE_MAX_BYTES,
    });

    expect(messages[0].content).toEqual([{ image_url: { url: OWN_FILE_URL }, type: 'image_url' }]);
    expect(resolver).toHaveBeenCalledWith(OWN_FILE_URL, CURSOR_IMAGE_INLINE_MAX_BYTES);
  });

  it('inlines an assistant image_url the same way as a user part', async () => {
    const resolver = vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' }));
    const messages = [imageMessage(OWN_FILE_URL, 'assistant')];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toEqual([{ image_url: { url: PNG_DATA_URI }, type: 'image_url' }]);
    expect(resolver).toHaveBeenCalledTimes(1);
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

  it('strips own-origin url attributes from files_info user text and keeps foreign ones', async () => {
    const resolver = vi.fn();
    const messages: OpenAIChatMessage[] = [
      {
        content: `<files_info><image name="own" url="${OWN_FILE_URL}"></image> <image name="foreign" url="${FOREIGN_URL}"></image></files_info>`,
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toBe(
      `<files_info><image name="own"></image> <image name="foreign" url="${FOREIGN_URL}"></image></files_info>`,
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('does not strip url attributes outside files_info while stripping inside', async () => {
    const resolver = vi.fn();
    const messages: OpenAIChatMessage[] = [
      {
        content: `please fetch url="${OWN_FILE_URL}"\n<files_info><image name="own" url="${OWN_FILE_URL}"></image></files_info>`,
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(messages[0].content).toBe(
      `please fetch url="${OWN_FILE_URL}"\n<files_info><image name="own"></image></files_info>`,
    );
  });

  it('resolves the same URL in two messages once', async () => {
    const resolver = vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' }));
    const messages = [imageMessage(OWN_FILE_URL), imageMessage(OWN_FILE_URL)];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(messages[0].content).toEqual([{ image_url: { url: PNG_DATA_URI }, type: 'image_url' }]);
    expect(messages[1].content).toEqual([{ image_url: { url: PNG_DATA_URI }, type: 'image_url' }]);
  });

  it('resolves a URL used as both image and file once with the larger cap', async () => {
    const resolver = vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          { image_url: { url: OWN_FILE_URL }, type: 'image_url' },
          {
            file_url: { mimeType: 'image/png', name: 'cat.png', url: OWN_FILE_URL },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(OWN_FILE_URL, DEFAULT_FILE_INLINE_MAX_BYTES);
  });

  it('inserts the page plus four quadrant tiles after a one-page image-only PDF', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue(rasterPageWithTiles());
    const resolver = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              content: '<page pageNumber="1">\n\n</page>',
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'card.pdf',
              size: PDF_BYTES.byteLength,
              url: OWN_FILE_URL,
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalledWith(
      PDF_BYTES,
      expect.objectContaining({
        maxBytesPerImage: DEFAULT_IMAGE_INLINE_MAX_BYTES,
        maxPages: 4,
        tiles: { grid: 2, maxLongEdgePx: 1800 },
      }),
    );
    expect(messages[0].content).toEqual([
      {
        file_url: {
          content: '<page pageNumber="1">\n\n</page>',
          fileId: 'file-1',
          mimeType: 'application/pdf',
          name: 'card.pdf',
          size: PDF_BYTES.byteLength,
          url: `data:application/pdf;base64,${Buffer.from(PDF_BYTES).toString('base64')}`,
        },
        type: 'file_url',
      },
      PAGE_IMAGE_PART,
      PAGE_IMAGE_PART,
      PAGE_IMAGE_PART,
      PAGE_IMAGE_PART,
      PAGE_IMAGE_PART,
      { text: IMAGE_ONLY_PDF_NOTICE_WITH_TILES, type: 'text' },
    ]);
  });

  it('keeps the page and drops the last tile when the Cursor ceiling is 4', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue(rasterPageWithTiles());
    const resolver = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              content: '<page pageNumber="1">\n\n</page>',
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'card.pdf',
              size: PDF_BYTES.byteLength,
              url: OWN_FILE_URL,
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins, { imageMaxCount: 4 });

    const content = messages[0].content as object[];
    expect(content.filter((part) => (part as { type: string }).type === 'image_url')).toHaveLength(
      4,
    );
    expect(content).toEqual([
      expect.objectContaining({ type: 'file_url' }),
      PAGE_IMAGE_PART,
      PAGE_IMAGE_PART,
      PAGE_IMAGE_PART,
      PAGE_IMAGE_PART,
      { text: IMAGE_ONLY_PDF_NOTICE_WITH_TILES, type: 'text' },
    ]);
  });

  it('attaches one image per page and no tiles for a multi-page PDF', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      ...rasterPageWithTiles(1),
      ...rasterPageWithTiles(2),
    ]);
    const resolver = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              content: '<page pageNumber="1">\n\n</page>',
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'card.pdf',
              size: PDF_BYTES.byteLength,
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
          content: '<page pageNumber="1">\n\n</page>',
          fileId: 'file-1',
          mimeType: 'application/pdf',
          name: 'card.pdf',
          size: PDF_BYTES.byteLength,
          url: `data:application/pdf;base64,${Buffer.from(PDF_BYTES).toString('base64')}`,
        },
        type: 'file_url',
      },
      PAGE_IMAGE_PART,
      PAGE_IMAGE_PART,
      { text: IMAGE_ONLY_PDF_NOTICE, type: 'text' },
    ]);
  });

  it('does not rasterize a PDF that already has extracted text', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolver = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              content: 'extracted text from a real text layer',
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

    expect(pdfPageImagesMocks.renderPdfPagesToPng).not.toHaveBeenCalled();
    expect(messages[0].content).toHaveLength(1);
  });

  it('skips rasterizing when the message already has 6 image parts', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue(rasterPageWithTiles());
    const resolver = vi.fn(async (url: string) =>
      url === OWN_FILE_URL
        ? { bytes: PDF_BYTES, mimeType: 'application/pdf' }
        : { bytes: PNG_BYTES, mimeType: 'image/png' },
    );
    const imageUrl = 'http://localhost:3010/f/img-1';
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          { image_url: { url: imageUrl }, type: 'image_url' },
          { image_url: { url: imageUrl }, type: 'image_url' },
          { image_url: { url: imageUrl }, type: 'image_url' },
          { image_url: { url: imageUrl }, type: 'image_url' },
          { image_url: { url: imageUrl }, type: 'image_url' },
          { image_url: { url: imageUrl }, type: 'image_url' },
          {
            file_url: {
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'card.pdf',
              url: OWN_FILE_URL,
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(pdfPageImagesMocks.renderPdfPagesToPng).not.toHaveBeenCalled();
    const content = messages[0].content as object[];
    expect(content).toHaveLength(7);
    expect(content.filter((part) => (part as { type: string }).type === 'image_url')).toHaveLength(
      6,
    );
  });

  it('does not throw when rasterization fails', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockRejectedValue(new Error('canvas exploded'));
    const resolver = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'card.pdf',
              url: OWN_FILE_URL,
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await expect(
      inlineOwnOriginAttachments(messages, resolver, ownOrigins),
    ).resolves.toBeUndefined();
    expect(messages[0].content).toEqual([
      {
        file_url: {
          fileId: 'file-1',
          mimeType: 'application/pdf',
          name: 'card.pdf',
          url: `data:application/pdf;base64,${Buffer.from(PDF_BYTES).toString('base64')}`,
        },
        type: 'file_url',
      },
    ]);
  });

  const FILES_INFO_PDF_ID = 'file_owIsKmixZ3DV';
  const FILES_INFO_UUID_ID = '550e8400-e29b-41d4-a716-446655440000';
  const filesInfoPdf = ({
    body = '<page pageNumber="1">\n\n</page>',
    id = FILES_INFO_PDF_ID,
    name = 'scan.pdf',
    sandboxPath = false,
    type = 'application/pdf',
  }: {
    body?: string;
    id?: string;
    name?: string;
    sandboxPath?: boolean;
    type?: string;
  } = {}) => {
    const sandbox = sandboxPath ? ' sandboxPath="/mnt/data/uploads/scan.pdf"' : '';
    return `<files_info>\n<files>\n<files_docstring>here are user upload files you can refer to</files_docstring>\n<file id="${id}" name="${name}" type="${type}" size="776756"${sandbox}>${body}</file>\n</files>\n</files_info>`;
  };
  const SCAN_PDF_NOTICE =
    '[PDF "scan.pdf" is a scanned document with no text layer. Its pages are attached above as images — read the page images directly. Do not try to read or re-parse this file with tools; extracted text will always be empty.]';

  it('rasterizes an empty-text PDF in string files_info into image parts and a notice', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const text = filesInfoPdf();
    const messages: OpenAIChatMessage[] = [{ content: text, role: 'user' }];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

    expect(resolveByFileId).toHaveBeenCalledWith(FILES_INFO_PDF_ID, DEFAULT_FILE_INLINE_MAX_BYTES);
    expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalledTimes(1);
    expect(messages[0].content).toEqual([
      { text: expect.stringContaining('scanned document: no text layer'), type: 'text' },
      { image_url: { detail: 'high', url: PAGE_PNG_DATA_URI }, type: 'image_url' },
      { text: SCAN_PDF_NOTICE, type: 'text' },
    ]);
  });

  it('rasterizes an empty-text PDF in a text part the same way', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const text = filesInfoPdf();
    const messages: OpenAIChatMessage[] = [{ content: [{ text, type: 'text' }], role: 'user' }];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

    expect(messages[0].content).toEqual([
      { text: expect.stringContaining('scanned document: no text layer'), type: 'text' },
      { image_url: { detail: 'high', url: PAGE_PNG_DATA_URI }, type: 'image_url' },
      { text: SCAN_PDF_NOTICE, type: 'text' },
    ]);
  });

  it('leaves a files_info PDF with a real text layer untouched', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const text = filesInfoPdf({ body: 'extracted text from a real text layer' });
    const messages: OpenAIChatMessage[] = [{ content: text, role: 'user' }];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

    expect(resolveByFileId).not.toHaveBeenCalled();
    expect(pdfPageImagesMocks.renderPdfPagesToPng).not.toHaveBeenCalled();
    expect(messages[0].content).toBe(text);
  });

  it('leaves a non-PDF files_info file untouched', async () => {
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const text = filesInfoPdf({ type: 'text/plain' });
    const messages: OpenAIChatMessage[] = [{ content: text, role: 'user' }];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

    expect(resolveByFileId).not.toHaveBeenCalled();
    expect(pdfPageImagesMocks.renderPdfPagesToPng).not.toHaveBeenCalled();
    expect(messages[0].content).toBe(text);
  });

  it('rasterizes a sandboxPath empty-text PDF the same way as a url-less file', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const text = filesInfoPdf({ sandboxPath: true });
    const messages: OpenAIChatMessage[] = [{ content: text, role: 'user' }];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

    expect(resolveByFileId).toHaveBeenCalledWith(FILES_INFO_PDF_ID, DEFAULT_FILE_INLINE_MAX_BYTES);
    expect(messages[0].content).toEqual([
      { text: expect.stringContaining('scanned document: no text layer'), type: 'text' },
      { image_url: { detail: 'high', url: PAGE_PNG_DATA_URI }, type: 'image_url' },
      { text: SCAN_PDF_NOTICE, type: 'text' },
    ]);
  });

  it('rasterizes once when the same PDF is both a file_url part and files_info', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolver = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const text = filesInfoPdf({ name: 'card.pdf' });
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          { text, type: 'text' },
          {
            file_url: {
              content: '<page pageNumber="1">\n\n</page>',
              fileId: FILES_INFO_PDF_ID,
              mimeType: 'application/pdf',
              name: 'card.pdf',
              url: OWN_FILE_URL,
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins, { resolveByFileId });

    expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalledTimes(1);
    expect(resolveByFileId).not.toHaveBeenCalled();
    expect(messages[0].content).toEqual([
      { text, type: 'text' },
      {
        file_url: {
          content: '<page pageNumber="1">\n\n</page>',
          fileId: FILES_INFO_PDF_ID,
          mimeType: 'application/pdf',
          name: 'card.pdf',
          url: `data:application/pdf;base64,${Buffer.from(PDF_BYTES).toString('base64')}`,
        },
        type: 'file_url',
      },
      { image_url: { detail: 'high', url: PAGE_PNG_DATA_URI }, type: 'image_url' },
      { text: IMAGE_ONLY_PDF_NOTICE, type: 'text' },
    ]);
  });

  it('leaves files_info untouched and does not throw when the fileId resolver fails', async () => {
    const resolveByFileId = vi.fn(async () => {
      throw new Error('s3 unavailable');
    });
    const text = filesInfoPdf();
    const messages: OpenAIChatMessage[] = [{ content: text, role: 'user' }];

    await expect(
      inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId }),
    ).resolves.toBeUndefined();
    expect(pdfPageImagesMocks.renderPdfPagesToPng).not.toHaveBeenCalled();
    expect(messages[0].content).toBe(text);
  });

  it('rasterizes a files_info PDF whose id is a UUID', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const text = filesInfoPdf({ id: FILES_INFO_UUID_ID });
    const messages: OpenAIChatMessage[] = [{ content: text, role: 'user' }];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

    expect(resolveByFileId).toHaveBeenCalledWith(FILES_INFO_UUID_ID, DEFAULT_FILE_INLINE_MAX_BYTES);
    expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalledTimes(1);
    expect(messages[0].content).toEqual([
      { text: expect.stringContaining('scanned document: no text layer'), type: 'text' },
      { image_url: { detail: 'high', url: PAGE_PNG_DATA_URI }, type: 'image_url' },
      { text: SCAN_PDF_NOTICE, type: 'text' },
    ]);
  });

  it('rasterizes at most 2 distinct image-only PDFs per payload', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, kind: 'page', page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolver = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [pdfFileUrlPart('file-a'), pdfFileUrlPart('file-b'), pdfFileUrlPart('file-c')],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalledTimes(2);
    const content = messages[0].content as Array<{ type: string }>;
    expect(content.filter((part) => part.type === 'image_url')).toHaveLength(2);
  });

  it('attaches at most 6 rasterized page/tile images per payload', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue(rasterPageWithTiles());
    const resolver = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [pdfFileUrlPart('file-a'), pdfFileUrlPart('file-b')],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalledTimes(2);
    const content = messages[0].content as Array<{ type: string }>;
    expect(content.filter((part) => part.type === 'image_url')).toHaveLength(6);
  });

  it('does not rasterize an image-only file_url PDF in an older user message', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, kind: 'page', page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolver = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const older = pdfFileUrlPart('file-old');
    const latest = pdfFileUrlPart('file-new');
    const messages: OpenAIChatMessage[] = [
      { content: [older], role: 'user' },
      { content: 'ok', role: 'assistant' },
      { content: [latest], role: 'user' },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins);

    expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalledTimes(1);
    const olderContent = messages[0].content as Array<{ type: string }>;
    const latestContent = messages[2].content as Array<{ type: string }>;
    expect(olderContent.filter((part) => part.type === 'image_url')).toHaveLength(0);
    expect(latestContent.filter((part) => part.type === 'image_url')).toHaveLength(1);
  });

  it('does not rasterize an image-only files_info PDF in an older user message', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const messages: OpenAIChatMessage[] = [
      { content: filesInfoPdf({ id: 'file_oldPdf1', name: 'old.pdf' }), role: 'user' },
      { content: 'ok', role: 'assistant' },
      { content: filesInfoPdf({ id: 'file_newPdf1' }), role: 'user' },
    ];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

    expect(resolveByFileId).toHaveBeenCalledTimes(1);
    expect(resolveByFileId).toHaveBeenCalledWith('file_newPdf1', DEFAULT_FILE_INLINE_MAX_BYTES);
    expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalledTimes(1);
    expect(messages[0].content).toBe(filesInfoPdf({ id: 'file_oldPdf1', name: 'old.pdf' }));
  });

  it.each([
    { body: '', chars: 0, rewrite: true, sparse: false },
    { body: 'x', chars: 1, rewrite: false, sparse: true },
    { body: 'x'.repeat(19), chars: 19, rewrite: false, sparse: true },
  ] as const)(
    'rasterizes files_info PDFs with $chars stripped chars (rewrite=$rewrite)',
    async ({ body, rewrite, sparse }) => {
      pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
        { height: 100, page: 1, png: PAGE_PNG, width: 200 },
      ]);
      const resolveByFileId = vi.fn(async () => ({
        bytes: PDF_BYTES,
        mimeType: 'application/pdf',
      }));
      const text = filesInfoPdf({ body });
      const messages: OpenAIChatMessage[] = [{ content: text, role: 'user' }];

      await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

      expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalledTimes(1);
      const content = messages[0].content as Array<{ text?: string; type: string }>;
      const filesInfoText = content.find((part) => part.type === 'text')?.text ?? '';
      if (rewrite) {
        expect(filesInfoText).toContain('scanned document: no text layer');
        expect(filesInfoText).not.toContain(`>${body}</file>`);
      } else {
        expect(filesInfoText).toContain(`>${body}</file>`);
        expect(filesInfoText).not.toContain('scanned document: no text layer');
      }
      expect(content).toEqual(
        expect.arrayContaining([
          { image_url: { detail: 'high', url: PAGE_PNG_DATA_URI }, type: 'image_url' },
          {
            text: sparse ? SPARSE_PDF_NOTICE : SCAN_PDF_NOTICE,
            type: 'text',
          },
        ]),
      );
    },
  );

  it('does not rasterize a files_info PDF whose stripped text is 20 chars', async () => {
    const body = 'x'.repeat(20);
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const text = filesInfoPdf({ body });
    const messages: OpenAIChatMessage[] = [{ content: text, role: 'user' }];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

    expect(resolveByFileId).not.toHaveBeenCalled();
    expect(pdfPageImagesMocks.renderPdfPagesToPng).not.toHaveBeenCalled();
    expect(messages[0].content).toBe(text);
  });

  it('does not rewrite a user-written <file> tag outside files_info', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([
      { height: 100, page: 1, png: PAGE_PNG, width: 200 },
    ]);
    const resolveByFileId = vi.fn(async () => ({
      bytes: PDF_BYTES,
      mimeType: 'application/pdf',
    }));
    const userWritten = `<file id="${FILES_INFO_PDF_ID}">example</file>`;
    const text = `${userWritten}\n${filesInfoPdf()}`;
    const messages: OpenAIChatMessage[] = [{ content: text, role: 'user' }];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { resolveByFileId });

    const content = messages[0].content as Array<{ text?: string; type: string }>;
    const filesInfoText = content.find((part) => part.type === 'text')?.text ?? '';
    expect(filesInfoText).toContain(`${userWritten}`);
    expect(filesInfoText).toContain('scanned document: no text layer');
    expect(filesInfoText).toMatch(
      /<file id="file_owIsKmixZ3DV">example<\/file>[\s\S]*scanned document: no text layer/,
    );
  });
});

describe('inlineOwnOriginImageUrls', () => {
  it('replaces own-origin URLs with data URIs and leaves the rest untouched', async () => {
    const resolver = vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' }));

    await expect(
      inlineOwnOriginImageUrls(
        [OWN_FILE_URL, FOREIGN_URL, DATA_URI, OWN_FILE_URL],
        resolver,
        ownOrigins,
      ),
    ).resolves.toEqual([PNG_DATA_URI, FOREIGN_URL, DATA_URI, PNG_DATA_URI]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(OWN_FILE_URL, DEFAULT_IMAGE_INLINE_MAX_BYTES);
  });

  it('does not resolve a raw S3 object URL', async () => {
    const resolver = vi.fn();

    await expect(inlineOwnOriginImageUrls([S3_URL], resolver, s3Origins)).resolves.toEqual([
      S3_URL,
    ]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('leaves an over-cap own-origin URL in place', async () => {
    const resolver = vi.fn(async () => ({
      bytes: { byteLength: DEFAULT_IMAGE_INLINE_MAX_BYTES + 1 } as Uint8Array,
      mimeType: 'image/png',
    }));

    await expect(inlineOwnOriginImageUrls([OWN_FILE_URL], resolver, ownOrigins)).resolves.toEqual([
      OWN_FILE_URL,
    ]);
  });

  it('leaves the URL in place when the resolver fails', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('s3 unavailable');
    });

    await expect(inlineOwnOriginImageUrls([OWN_FILE_URL], resolver, ownOrigins)).resolves.toEqual([
      OWN_FILE_URL,
    ]);
  });

  it('does not call the resolver when every URL is foreign or already a data URI', async () => {
    const resolver = vi.fn();

    await expect(
      inlineOwnOriginImageUrls([FOREIGN_URL, DATA_URI], resolver, ownOrigins),
    ).resolves.toEqual([FOREIGN_URL, DATA_URI]);
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('createOwnOriginAttachmentInlineHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileServiceMocks.getFileByteArray.mockReset();
    fileModelMocks.findById.mockReset();
    fileModelMocks.findById.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips an over-cap files-row without reading bytes', async () => {
    vi.spyOn(FileModel, 'getFileById').mockResolvedValue({
      fileType: 'image/png',
      size: DEFAULT_IMAGE_INLINE_MAX_BYTES + 1,
      url: 'files/huge.png',
    } as never);
    fileServiceMocks.getFileByteArray.mockResolvedValue(PNG_BYTES);

    const messages = [imageMessage(OWN_FILE_URL)];
    const hooks = createOwnOriginAttachmentInlineHooks({
      db: {} as never,
      ownOrigins,
    });

    await hooks.beforeChat?.({ messages, model: 'test' } as never);

    expect(FileModel.getFileById).toHaveBeenCalledWith(expect.anything(), 'file-1');
    expect(fileServiceMocks.getFileByteArray).not.toHaveBeenCalled();
    expect(messages[0].content).toEqual([{ image_url: { url: OWN_FILE_URL }, type: 'image_url' }]);
  });

  it('skips a Cursor-capped files-row without reading bytes', async () => {
    vi.spyOn(FileModel, 'getFileById').mockResolvedValue({
      fileType: 'image/png',
      size: CURSOR_IMAGE_INLINE_MAX_BYTES + 1,
      url: 'files/cursor-huge.png',
    } as never);
    fileServiceMocks.getFileByteArray.mockResolvedValue(PNG_BYTES);

    const messages = [imageMessage(OWN_FILE_URL)];
    const hooks = createOwnOriginAttachmentInlineHooks({
      db: {} as never,
      imageMaxBytes: CURSOR_IMAGE_INLINE_MAX_BYTES,
      ownOrigins,
    });

    await hooks.beforeChat?.({ messages, model: 'test' } as never);

    expect(fileServiceMocks.getFileByteArray).not.toHaveBeenCalled();
    expect(messages[0].content).toEqual([{ image_url: { url: OWN_FILE_URL }, type: 'image_url' }]);
  });

  it('does not look up a raw S3 URL', async () => {
    const getFileById = vi.spyOn(FileModel, 'getFileById');
    const messages = [imageMessage(S3_URL)];
    const hooks = createOwnOriginAttachmentInlineHooks({
      db: {} as never,
      ownOrigins: s3Origins,
    });

    await hooks.beforeChat?.({ messages, model: 'test' } as never);

    expect(getFileById).not.toHaveBeenCalled();
    expect(fileServiceMocks.getFileByteArray).not.toHaveBeenCalled();
  });

  it('inlines a /f/<id> image through FileModel then getFileByteArray(file.url)', async () => {
    vi.spyOn(FileModel, 'getFileById').mockResolvedValue({
      fileType: 'image/png',
      size: PNG_BYTES.byteLength,
      url: 'files/cat.png',
    } as never);
    fileServiceMocks.getFileByteArray.mockResolvedValue(PNG_BYTES);

    const messages = [imageMessage(OWN_FILE_URL)];
    const hooks = createOwnOriginAttachmentInlineHooks({
      db: {} as never,
      ownOrigins,
    });

    await hooks.beforeChat?.({ messages, model: 'test' } as never);

    expect(FileModel.getFileById).toHaveBeenCalledWith(expect.anything(), 'file-1');
    expect(fileServiceMocks.getFileByteArray).toHaveBeenCalledWith('files/cat.png');
    expect(messages[0].content).toEqual([{ image_url: { url: PNG_DATA_URI }, type: 'image_url' }]);
  });

  it('applies the same /f/<id> rules to beforeCreateImage', async () => {
    vi.spyOn(FileModel, 'getFileById').mockResolvedValue({
      fileType: 'image/png',
      size: PNG_BYTES.byteLength,
      url: 'files/cat.png',
    } as never);
    fileServiceMocks.getFileByteArray.mockResolvedValue(PNG_BYTES);

    const params = { imageUrls: [OWN_FILE_URL, S3_URL], prompt: 'edit' };
    const hooks = createOwnOriginAttachmentInlineHooks({
      db: {} as never,
      ownOrigins: s3Origins,
    });

    await hooks.beforeCreateImage?.({ model: 'test', params } as never);

    expect(params.imageUrls).toEqual([PNG_DATA_URI, S3_URL]);
    expect(fileServiceMocks.getFileByteArray).toHaveBeenCalledTimes(1);
  });

  it('does not attach images for a foreign files_info file id', async () => {
    fileModelMocks.findById.mockResolvedValue(undefined);
    const getFileById = vi.spyOn(FileModel, 'getFileById');
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue(rasterPageWithTiles());
    fileServiceMocks.getFileByteArray.mockResolvedValue(PDF_BYTES);

    const messages: OpenAIChatMessage[] = [
      {
        content:
          '<files_info><file id="foreign-file" name="secret.pdf" type="application/pdf"></file></files_info>',
        role: 'user',
      },
    ];
    const hooks = createOwnOriginAttachmentInlineHooks({
      db: {} as never,
      ownOrigins,
      userId: 'user-1',
    });

    await hooks.beforeChat?.({ messages, model: 'test' } as never);

    expect(fileModelMocks.findById).toHaveBeenCalled();
    expect(getFileById).not.toHaveBeenCalled();
    expect(pdfPageImagesMocks.renderPdfPagesToPng).not.toHaveBeenCalled();
    expect(fileServiceMocks.getFileByteArray).not.toHaveBeenCalled();
    expect(messages[0].content).toBe(
      '<files_info><file id="foreign-file" name="secret.pdf" type="application/pdf"></file></files_info>',
    );
  });

  it('uses findById when userId is set and skips getFileById', async () => {
    fileModelMocks.findById.mockResolvedValue({
      fileType: 'image/png',
      size: PNG_BYTES.byteLength,
      url: 'files/cat.png',
    } as never);
    const getFileById = vi.spyOn(FileModel, 'getFileById');
    fileServiceMocks.getFileByteArray.mockResolvedValue(PNG_BYTES);

    const messages = [imageMessage(OWN_FILE_URL)];
    const hooks = createOwnOriginAttachmentInlineHooks({
      db: {} as never,
      ownOrigins,
      userId: 'user-1',
    });

    await hooks.beforeChat?.({ messages, model: 'test' } as never);

    expect(fileModelMocks.findById).toHaveBeenCalledWith('file-1');
    expect(getFileById).not.toHaveBeenCalled();
    expect(messages[0].content).toEqual([{ image_url: { url: PNG_DATA_URI }, type: 'image_url' }]);
  });
});

describe('document render feed + viewDocumentPages markers', () => {
  beforeEach(() => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockReset();
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const PAGE_KEY = 'files/render/file-1/pages/1.png';
  const SHEET_KEY = 'files/render/file-1/contact/0.png';
  const loadReadyRender = async () =>
    ({
      contactSheets: [{ key: SHEET_KEY, pages: [1] }],
      hasTextLayer: false,
      pageCount: 1,
      pages: { '1': { chars: 0, png: PAGE_KEY, visual: true } },
      renderedPages: [1],
      status: 'ready' as const,
      tier: 'T2' as const,
    }) satisfies FileRenderMetadata;

  it('uses ready render artifacts instead of live PDF rasterization', async () => {
    const resolver = vi.fn(async () => ({ bytes: PDF_BYTES, mimeType: 'application/pdf' }));
    const loadArtifact = vi.fn(async (key: string) => {
      if (key === SHEET_KEY || key === PAGE_KEY) return PAGE_PNG;
      return null;
    });
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              content: '<page pageNumber="1">\n\n</page>',
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'scan.pdf',
              size: PDF_BYTES.byteLength,
              url: OWN_FILE_URL,
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins, {
      loadArtifact,
      loadRender: loadReadyRender,
    });

    expect(pdfPageImagesMocks.renderPdfPagesToPng).not.toHaveBeenCalled();
    const parts = messages[0].content as Array<{
      image_url?: { detail?: string; url: string };
      text?: string;
      type: string;
    }>;
    expect(
      parts.some((part) => part.type === 'image_url' && part.image_url?.detail === 'low'),
    ).toBe(true);
    expect(parts.some((part) => part.text?.includes('Document "scan.pdf"'))).toBe(true);
  });

  it('rasterizes a pending PDF with empty text instead of treating it as fed', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue(rasterPageWithTiles());
    const resolver = vi.fn(async () => ({ bytes: PDF_BYTES, mimeType: 'application/pdf' }));
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              content: '<page pageNumber="1">\n\n</page>',
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'scan.pdf',
              url: OWN_FILE_URL,
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins, {
      loadRender: async () => ({ status: 'pending', tier: 'T2' }),
    });

    expect(pdfPageImagesMocks.renderPdfPagesToPng).toHaveBeenCalled();
    const parts = messages[0].content as Array<{ text?: string; type: string }>;
    expect(parts.filter((part) => part.type === 'image_url')).toHaveLength(5);
    expect(JSON.stringify(messages[0].content)).not.toContain(
      'page images are still being prepared; text only this turn',
    );
  });

  it('injects image_url parts after the last viewDocumentPages tool message', async () => {
    const loadArtifact = vi.fn(async () => PAGE_PNG);
    const marker =
      '<document_page_image fileId="file-1" page="2" kind="page" key="files/render/file-1/pages/2.png"/>';
    const messages: OpenAIChatMessage[] = [
      { content: 'what is on slide 2?', role: 'user' },
      { content: 'calling tool', role: 'assistant' },
      {
        content: `Requested page images for "deck.pptx": pages 1.\n${marker.replace('page="2"', 'page="1"').replace('pages/2', 'pages/1')}`,
        role: 'tool',
        tool_call_id: 'old',
      },
      {
        content: `Requested page images for "deck.pptx": pages 2.\n${marker}`,
        role: 'tool',
        tool_call_id: 'new',
      },
    ];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { loadArtifact });

    expect(messages[2].content).toContain('[page images were shown earlier]');
    expect(messages[2].content).not.toContain('<document_page_image');
    expect(messages[4]?.role).toBe('user');
    const injected = messages[4]?.content as Array<{
      image_url?: { url: string };
      text?: string;
      type: string;
    }>;
    expect(
      injected.some(
        (part) => part.type === 'image_url' && part.image_url?.url === PAGE_PNG_DATA_URI,
      ),
    ).toBe(true);
    expect(
      injected.some((part) =>
        part.text?.includes('Requested page images for "deck.pptx": pages 2'),
      ),
    ).toBe(true);
  });

  it('inserts the synthetic page-image message after a contiguous tool-result block', async () => {
    const loadArtifact = vi.fn(async () => PAGE_PNG);
    const marker =
      '<document_page_image fileId="file-1" page="2" kind="page" key="files/render/file-1/pages/2.png"/>';
    const messages: OpenAIChatMessage[] = [
      { content: 'what is on slide 2?', role: 'user' },
      { content: 'calling tools', role: 'assistant' },
      {
        content: `Requested page images for "deck.pptx": pages 2.\n${marker}`,
        role: 'tool',
        tool_call_id: 'pages',
      },
      { content: 'web search results', role: 'tool', tool_call_id: 'search' },
    ];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { loadArtifact });

    expect(messages[2].role).toBe('tool');
    expect(messages[3].role).toBe('tool');
    expect(messages[3].content).toBe('web search results');
    expect(messages[4]?.role).toBe('user');
    const injected = messages[4]?.content as Array<{ type: string }>;
    expect(injected.some((part) => part.type === 'image_url')).toBe(true);
  });

  it('ignores a viewDocumentPages marker whose key is outside the file prefix', async () => {
    const loadArtifact = vi.fn(async () => PAGE_PNG);
    const messages: OpenAIChatMessage[] = [
      { content: 'what is on slide 2?', role: 'user' },
      { content: 'calling tool', role: 'assistant' },
      {
        content:
          'Requested page images for "deck.pptx": pages 2.\n<document_page_image fileId="file-1" page="2" kind="page" key="files/render/other-file/pages/2.png"/>',
        role: 'tool',
        tool_call_id: 'pages',
      },
    ];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, { loadArtifact });

    expect(loadArtifact).not.toHaveBeenCalled();
    expect(messages).toHaveLength(3);
    expect(messages[2].content).toContain('<document_page_image');
  });

  it('shares one image budget across the document feed and scanned-PDF fallback', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue(rasterPageWithTiles());
    const loadArtifact = vi.fn(async () => PAGE_PNG);
    const resolver = vi.fn(async () => ({ bytes: PDF_BYTES, mimeType: 'application/pdf' }));
    const deckRender = {
      contactSheets: [{ key: 'files/render/deck-1/contact/0.png', pages: [1] }],
      hasTextLayer: true,
      pageCount: 1,
      pages: { '1': { chars: 40, png: 'files/render/deck-1/pages/1.png', visual: true } },
      renderedPages: [1],
      status: 'ready' as const,
      tier: 'T2' as const,
    };
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            text: '<files_info><file id="deck-1" name="deck.pptx" type="application/vnd.openxmlformats-officedocument.presentationml.presentation"></file></files_info>',
            type: 'text',
          },
          {
            file_url: {
              content: '<page pageNumber="1">\n\n</page>',
              fileId: 'scan-1',
              mimeType: 'application/pdf',
              name: 'scan.pdf',
              url: 'http://localhost:3010/f/scan-1',
            },
            type: 'file_url',
          },
          { image_url: { url: DATA_URI }, type: 'image_url' },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins, {
      imageMaxCount: 3,
      loadArtifact,
      loadRender: async (fileId) => (fileId === 'deck-1' ? deckRender : undefined),
    });

    const userParts = messages[0].content as Array<{ type: string }>;
    expect(userParts.filter((part) => part.type === 'image_url')).toHaveLength(3);
    expect(pdfPageImagesMocks.renderPdfPagesToPng).not.toHaveBeenCalled();
  });

  it('shares one image budget across tool-image injection and scanned-PDF fallback', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue(rasterPageWithTiles());
    const loadArtifact = vi.fn(async () => PAGE_PNG);
    const resolver = vi.fn(async () => ({ bytes: PDF_BYTES, mimeType: 'application/pdf' }));
    const marker =
      '<document_page_image fileId="file-1" page="2" kind="page" key="files/render/file-1/pages/2.png"/>';
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              content: '<page pageNumber="1">\n\n</page>',
              fileId: 'scan-1',
              mimeType: 'application/pdf',
              name: 'scan.pdf',
              url: 'http://localhost:3010/f/scan-1',
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
      { content: 'calling tool', role: 'assistant' },
      {
        content: `Requested page images for "deck.pptx": pages 2.\n${marker}`,
        role: 'tool',
        tool_call_id: 'pages',
      },
    ];

    await inlineOwnOriginAttachments(messages, resolver, ownOrigins, {
      imageMaxCount: 2,
      loadArtifact,
    });

    expect(messages[3]?.role).toBe('user');
    const injected = messages[3]?.content as Array<{ type: string }>;
    expect(injected.filter((part) => part.type === 'image_url')).toHaveLength(1);
    const userParts = messages[0].content as Array<{ type: string }>;
    expect(userParts.filter((part) => part.type === 'image_url')).toHaveLength(1);
  });

  it('applies resolveFeedLimits to the shared per-request image budget', async () => {
    pdfPageImagesMocks.renderPdfPagesToPng.mockResolvedValue(rasterPageWithTiles());
    vi.spyOn(FileModel, 'getFileById').mockResolvedValue({
      fileType: 'application/pdf',
      size: PDF_BYTES.byteLength,
      url: 'files/scan.pdf',
    } as never);
    fileServiceMocks.getFileByteArray.mockResolvedValue(PDF_BYTES);

    const messages: OpenAIChatMessage[] = [
      {
        content: [pdfFileUrlPart('file-1')],
        role: 'user',
      },
    ];
    const hooks = createOwnOriginAttachmentInlineHooks({
      db: {} as never,
      imageMaxCount: 6,
      ownOrigins,
      resolveFeedLimits: async () => ({ imageMaxCount: 1, maxDocsPerRequest: 2 }),
    });

    await hooks.beforeChat?.({ messages, model: 'test' } as never);

    const parts = messages[0].content as Array<{ type: string }>;
    expect(parts.filter((part) => part.type === 'image_url')).toHaveLength(1);
  });

  it('bumps feed counters when stored page images are attached', async () => {
    resetDocumentFeedStatsForTest();
    const loadArtifact = vi.fn(async (key: string) => {
      if (key === SHEET_KEY || key === PAGE_KEY) return PAGE_PNG;
      return null;
    });
    const messages: OpenAIChatMessage[] = [
      {
        content: [
          {
            file_url: {
              content: '<page pageNumber="1">\n\n</page>',
              fileId: 'file-1',
              mimeType: 'application/pdf',
              name: 'scan.pdf',
              size: PDF_BYTES.byteLength,
              url: OWN_FILE_URL,
            },
            type: 'file_url',
          },
        ],
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, {
      loadArtifact,
      loadRender: loadReadyRender,
    });

    expect(getDocumentFeedStats()).toMatchObject({
      docsFed: 1,
      imagesFed: 2,
      pendingFallbacks: 0,
      requestsWithImages: 1,
    });
  });

  it('bumps pendingFallbacks when a pending office document is text-only', async () => {
    resetDocumentFeedStatsForTest();
    const messages: OpenAIChatMessage[] = [
      {
        content:
          '<files_info><file id="deck-1" name="deck.pptx" type="application/vnd.openxmlformats-officedocument.presentationml.presentation"></file></files_info>',
        role: 'user',
      },
    ];

    await inlineOwnOriginAttachments(messages, vi.fn(), ownOrigins, {
      loadRender: async () => ({ status: 'pending', tier: 'T2' }),
    });

    expect(getDocumentFeedStats().pendingFallbacks).toBe(1);
    expect(getDocumentFeedStats().pendingWaits).toBe(0);
  });

  it('bumps pendingWaits when polling a fresh pending render', async () => {
    resetDocumentFeedStatsForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'));
    try {
      const updatedAt = new Date().toISOString();
      fileModelMocks.findById.mockResolvedValue({
        id: 'file-1',
        metadata: { render: { status: 'pending', tier: 'T2', updatedAt } },
        name: 'deck.pptx',
      } as never);
      const messages: OpenAIChatMessage[] = [
        {
          content:
            '<files_info><file id="file-1" name="deck.pptx" type="application/vnd.openxmlformats-officedocument.presentationml.presentation"></file></files_info>',
          role: 'user',
        },
      ];
      const hooks = createOwnOriginAttachmentInlineHooks({
        db: {} as never,
        ownOrigins,
        userId: 'user-1',
      });
      const pending = hooks.beforeChat?.({ messages, model: 'test' } as never);
      await vi.advanceTimersByTimeAsync(11_000);
      await pending;
      expect(getDocumentFeedStats().pendingWaits).toBe(1);
      expect(getDocumentFeedStats().pendingFallbacks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fetch a text index whose key is outside the file prefix', async () => {
    fileModelMocks.findById.mockResolvedValue({
      id: 'file-1',
      metadata: {
        render: {
          contactSheets: [{ key: 'files/render/file-1/contact/0.png', pages: [1] }],
          pages: { '1': { chars: 10, png: 'files/render/file-1/pages/1.png', visual: true } },
          renderedPages: [1],
          status: 'ready',
          textIndex: 'files/render/other/text/index.json',
          tier: 'T2',
        },
      },
      name: 'deck.pptx',
    } as never);
    fileServiceMocks.getFileByteArray.mockResolvedValue(PAGE_PNG);
    fileServiceMocks.getFileContent.mockResolvedValue('{"1":"secret"}');

    const messages: OpenAIChatMessage[] = [
      {
        content:
          '<files_info><file id="file-1" name="deck.pptx" type="application/vnd.openxmlformats-officedocument.presentationml.presentation"></file></files_info>',
        role: 'user',
      },
    ];
    const hooks = createOwnOriginAttachmentInlineHooks({
      db: {} as never,
      ownOrigins,
      userId: 'user-1',
    });

    await hooks.beforeChat?.({ messages, model: 'test' } as never);

    expect(fileServiceMocks.getFileContent).not.toHaveBeenCalled();
  });
});

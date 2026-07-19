// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileModel } from '@/database/models/file';
import type { FileItem } from '@/database/schemas';
import { getServerDB } from '@/database/server';
import { FileService } from '@/server/services/file';

import { GET } from './route';

const fileServiceMocks = vi.hoisted(() => {
  const instance = {
    createCachedPreSignedUrlForPreview: vi.fn(),
    getFullFileUrl: vi.fn(),
  };

  return {
    FileService: vi.fn(() => instance),
    instance,
  };
});

const platformStorageMocks = vi.hoisted(() => ({
  createCachedPreSignedUrlForPreview: vi.fn(),
}));

vi.mock('@/database/models/file', () => ({
  FileModel: {
    getFileById: vi.fn(),
  },
}));

vi.mock('@/database/server', () => ({
  getServerDB: vi.fn(),
}));

vi.mock('@/server/services/file', () => ({
  FileService: fileServiceMocks.FileService,
}));

vi.mock('@/server/services/file/impls', () => ({
  createFileServiceModule: vi.fn(() => platformStorageMocks),
}));

describe('file proxy route', () => {
  const platformAssetRows: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => platformAssetRows) })),
      })),
    })),
  } as unknown as LobeChatDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    platformAssetRows.length = 0;

    vi.mocked(getServerDB).mockResolvedValue(db);
    vi.mocked(FileModel.getFileById).mockResolvedValue({
      id: 'file-id',
      url: 'files/user-id/image.png',
      userId: 'owner-user-id',
    } as FileItem);
    fileServiceMocks.instance.createCachedPreSignedUrlForPreview.mockResolvedValue(
      'https://s3.example.com/presigned-preview-url',
    );
    platformStorageMocks.createCachedPreSignedUrlForPreview.mockResolvedValue(
      'https://s3.example.com/platform-branding-object',
    );
  });

  it('should redirect to a cached presigned preview URL instead of a public full file URL', async () => {
    const response = await GET(new Request('https://lobehub.com/f/file-id'), {
      params: Promise.resolve({ id: 'file-id' }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://s3.example.com/presigned-preview-url');
    expect(FileModel.getFileById).toHaveBeenCalledWith(db, 'file-id');
    expect(FileService).toHaveBeenCalledWith(db, 'owner-user-id');
    expect(fileServiceMocks.instance.createCachedPreSignedUrlForPreview).toHaveBeenCalledWith(
      'files/user-id/image.png',
    );
    expect(fileServiceMocks.instance.getFullFileUrl).not.toHaveBeenCalled();
  });

  it('resolves an opaque ready platform Branding asset without a user-owned file row', async () => {
    platformAssetRows.push({ mimeType: 'image/png', objectKey: 'branding/logo/object.png' });
    const response = await GET(
      new Request('https://lobehub.com/f/pba_11111111-1111-4111-8111-111111111111'),
      {
        params: Promise.resolve({ id: 'pba_11111111-1111-4111-8111-111111111111' }),
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://s3.example.com/platform-branding-object',
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(FileModel.getFileById).not.toHaveBeenCalled();
  });

  it('does not fall back to user files for a missing platform asset-shaped ID', async () => {
    const response = await GET(
      new Request('https://lobehub.com/f/pba_22222222-2222-4222-8222-222222222222'),
      {
        params: Promise.resolve({ id: 'pba_22222222-2222-4222-8222-222222222222' }),
      },
    );

    expect(response.status).toBe(404);
    expect(FileModel.getFileById).not.toHaveBeenCalled();
  });

  it('fails closed for malformed or non-canonical IDs in the platform namespace', async () => {
    const response = await GET(
      new Request('https://lobehub.com/f/pba_11111111-1111-4111-8111-11111111111A'),
      {
        params: Promise.resolve({ id: 'pba_11111111-1111-4111-8111-11111111111A' }),
      },
    );

    expect(response.status).toBe(404);
    expect(FileModel.getFileById).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});

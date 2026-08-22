import { and, desc, eq, ne, sql } from 'drizzle-orm';

import { type FileItem, files } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type { FileRenderMetadata } from '@/types/files';
import { documentRenderArtifactPrefix, readFileRenderMetadata } from '@/types/files';

const rebaseKey = (key: string, sourcePrefix: string, targetPrefix: string): string =>
  key.startsWith(sourcePrefix) ? targetPrefix + key.slice(sourcePrefix.length) : key;

/**
 * Rewrite every object key in render metadata from the source file prefix to
 * the target prefix. Pure — does not touch S3.
 */
export const rebaseRenderMetadataKeys = (
  render: FileRenderMetadata,
  sourceFileId: string,
  targetFileId: string,
): FileRenderMetadata => {
  const sourcePrefix = documentRenderArtifactPrefix(sourceFileId);
  const targetPrefix = documentRenderArtifactPrefix(targetFileId);
  const rebase = (key: string | undefined): string | undefined =>
    typeof key === 'string' ? rebaseKey(key, sourcePrefix, targetPrefix) : key;

  const pages = render.pages
    ? Object.fromEntries(
        Object.entries(render.pages).map(([page, meta]) => [
          page,
          {
            ...meta,
            png: rebase(meta.png),
            thumb: rebase(meta.thumb),
            tiles: meta.tiles?.map((key) => rebaseKey(key, sourcePrefix, targetPrefix)),
          },
        ]),
      )
    : render.pages;

  return {
    ...render,
    contactSheets: render.contactSheets?.map((sheet) => ({
      ...sheet,
      key: rebaseKey(sheet.key, sourcePrefix, targetPrefix),
    })),
    figures: render.figures?.map((figure) => ({
      ...figure,
      key: rebaseKey(figure.key, sourcePrefix, targetPrefix),
    })),
    pages,
    textIndex: rebase(render.textIndex),
  };
};

export const hasReusableRenderArtifactKeys = (render: FileRenderMetadata): boolean =>
  render.contactSheets !== undefined ||
  render.pages !== undefined ||
  render.figures !== undefined ||
  render.textIndex !== undefined;

/**
 * Another `files` row with the same sha256, already rendered. Not scoped by
 * user — artifacts are derived from identical bytes and the copy lands under
 * the new file's own prefix.
 */
export const findReusableRenderSource = async (
  db: LobeChatDatabase,
  params: { fileHash: string; fileId: string },
): Promise<FileItem | undefined> => {
  const [row] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.fileHash, params.fileHash),
        ne(files.id, params.fileId),
        sql`${files.metadata} -> 'render' ->> 'status' in ('ready', 'partial')`,
        sql`${files.metadata} -> 'render' ->> 'engine' is not null`,
      ),
    )
    .orderBy(desc(files.updatedAt))
    .limit(1);

  if (!row) return undefined;
  const render = readFileRenderMetadata(row.metadata);
  if (!render || !hasReusableRenderArtifactKeys(render)) return undefined;
  return row;
};

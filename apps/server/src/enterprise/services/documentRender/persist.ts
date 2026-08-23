import { eq, sql } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import type { PlatformJobModel } from '@/database/models/platform/job';
import type { FileItem } from '@/database/schemas';
import { files } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type { DocumentRenderStatus, FileRenderMetadata, FileRenderSheetMeta } from '@/types/files';
import { readFileRenderMetadata } from '@/types/files';

import { deleteDocumentRenderArtifacts } from './artifacts';
import {
  FileDeletedDuringRenderError,
  SIDECAR_UNAVAILABLE,
  SidecarUnavailableError,
} from './control';

const asMetadataRecord = (metadata: FileItem['metadata']): Record<string, unknown> =>
  metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};

export interface RenderOutcome {
  durationMs: number;
  pages: number | null;
  retry?: boolean;
  reused?: boolean;
  status: DocumentRenderStatus;
}

export type LogLostOwnership = (action: 'complete' | 'fail') => void;

/** jsonb-merge into `files.metadata.render`. Omitting `status` leaves the worker's value intact. */
export const patchRenderMetadata = async (
  db: LobeChatDatabase,
  file: FileItem,
  patch: Partial<FileRenderMetadata>,
): Promise<FileRenderMetadata> => {
  const updatedAt = new Date().toISOString();
  const sqlPatch = { ...patch, updatedAt };
  const [row] = await db
    .update(files)
    .set({
      metadata: sql`coalesce(${files.metadata}, '{}'::jsonb) || jsonb_build_object('render', coalesce(${files.metadata} -> 'render', '{}'::jsonb) || ${JSON.stringify(sqlPatch)}::jsonb)`,
      updatedAt: sql`now()`,
    })
    .where(eq(files.id, file.id))
    .returning({ id: files.id, metadata: files.metadata });

  if (!row) {
    await deleteDocumentRenderArtifacts([file.id]);
    throw new FileDeletedDuringRenderError();
  }

  const prev = readFileRenderMetadata(file.metadata) ?? { status: patch.status ?? 'pending' };
  const next: FileRenderMetadata = readFileRenderMetadata(row.metadata) ?? {
    ...prev,
    ...patch,
    updatedAt,
  };
  file.metadata = (row.metadata as FileItem['metadata']) ?? {
    ...asMetadataRecord(file.metadata),
    render: next,
  };
  return next;
};

export const ensureFileStillExists = async (
  db: LobeChatDatabase,
  fileId: string,
): Promise<void> => {
  const current = await FileModel.getFileById(db, fileId);
  if (current) return;
  await deleteDocumentRenderArtifacts([fileId]);
  throw new FileDeletedDuringRenderError();
};

export const withSheets = (
  patch: Partial<FileRenderMetadata> & Pick<FileRenderMetadata, 'status'>,
  sheets: FileRenderSheetMeta[] | undefined,
): Partial<FileRenderMetadata> & Pick<FileRenderMetadata, 'status'> =>
  sheets && sheets.length > 0 ? { ...patch, sheets } : patch;

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export const failMissingFileId = async (params: {
  jobId: string;
  jobs: PlatformJobModel;
  logLostOwnership: LogLostOwnership;
  workerId: string;
}): Promise<void> => {
  const failed = await params.jobs.fail({
    error: { message: 'missing fileId' },
    jobId: params.jobId,
    terminal: true,
    workerId: params.workerId,
  });
  if (!failed) params.logLostOwnership('fail');
};

export const completeSkippedJob = async (params: {
  jobId: string;
  jobs: PlatformJobModel;
  logLostOwnership: LogLostOwnership;
  workerId: string;
}): Promise<void> => {
  const completed = await params.jobs.complete({
    jobId: params.jobId,
    resultSummary: { status: 'skipped' },
    workerId: params.workerId,
  });
  if (!completed) params.logLostOwnership('complete');
};

export const commitRenderOutcome = async (params: {
  db: LobeChatDatabase;
  file: FileItem;
  jobId: string;
  jobs: PlatformJobModel;
  logLostOwnership: LogLostOwnership;
  result: RenderOutcome;
  workerId: string;
}): Promise<void> => {
  const { file, result } = params;
  await patchRenderMetadata(params.db, file, {
    durationMs: result.durationMs,
    status: (readFileRenderMetadata(file.metadata)?.status ??
      result.status) as DocumentRenderStatus,
  });
  if (result.retry) {
    const failed = await params.jobs.fail({
      error: { message: SIDECAR_UNAVAILABLE, retryable: true },
      jobId: params.jobId,
      workerId: params.workerId,
    });
    if (!failed) {
      params.logLostOwnership('fail');
      return;
    }
    throw new SidecarUnavailableError();
  }
  const completed = await params.jobs.complete({
    jobId: params.jobId,
    resultSummary: {
      durationMs: result.durationMs,
      ext: extOf(file.name),
      fileId: file.id,
      pages: result.pages,
      ...(result.reused ? { reused: true } : {}),
      status: result.status,
    },
    workerId: params.workerId,
  });
  if (!completed) params.logLostOwnership('complete');
};

export const persistFailedRender = async (params: {
  db: LobeChatDatabase;
  file: FileItem;
  jobId: string;
  jobs: PlatformJobModel;
  logLostOwnership: LogLostOwnership;
  message: string;
  workerId: string;
}): Promise<boolean> => {
  await patchRenderMetadata(params.db, params.file, { error: params.message, status: 'failed' });
  const failed = await params.jobs.fail({
    error: { message: params.message },
    jobId: params.jobId,
    workerId: params.workerId,
  });
  if (!failed) {
    params.logLostOwnership('fail');
    return false;
  }
  return true;
};

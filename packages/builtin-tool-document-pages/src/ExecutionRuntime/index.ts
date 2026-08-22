import type { BuiltinServerRuntimeOutput, FileRenderMetadata } from '@lobechat/types';
import { readFileRenderMetadata } from '@lobechat/types';

import {
  type DocumentPageImageMarker,
  formatDocumentPageImageMarker,
  type ViewDocumentPagesParams,
  type ViewDocumentPagesState,
} from '../types';

export interface DocumentPagesFileRecord {
  fileType: string;
  id: string;
  metadata?: unknown;
  name: string;
}

export interface DocumentPagesRuntimeServices {
  enqueueRender?: (fileId: string, options?: { force?: boolean }) => Promise<unknown>;
  findAccessibleFile: (fileId: string) => Promise<DocumentPagesFileRecord | undefined>;
}

const OFFICE_OR_PDF_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const OFFICE_OR_PDF_EXT = new Set(['docx', 'pdf', 'pptx', 'xlsx']);

const MAX_PAGES_PER_CALL = 4;

export const isOfficeOrPdfFile = (fileType: string, name: string): boolean => {
  const mime = fileType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (OFFICE_OR_PDF_MIME.has(mime)) return true;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return OFFICE_OR_PDF_EXT.has(ext);
};

const uniquePositivePages = (pages: unknown): number[] => {
  if (!Array.isArray(pages)) return [];
  const seen = new Set<number>();
  const result: number[] = [];
  for (const item of pages) {
    const page = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(page) || page < 1 || seen.has(page)) continue;
    seen.add(page);
    result.push(page);
    if (result.length >= MAX_PAGES_PER_CALL) break;
  }
  return result;
};

const pagePng = (render: FileRenderMetadata, page: number): string | undefined =>
  render.pages?.[String(page)]?.png;

const pageTiles = (render: FileRenderMetadata, page: number): string[] =>
  render.pages?.[String(page)]?.tiles ?? [];

const fail = (content: string, state?: ViewDocumentPagesState): BuiltinServerRuntimeOutput => ({
  content,
  state,
  success: false,
});

const ok = (content: string, state: ViewDocumentPagesState): BuiltinServerRuntimeOutput => ({
  content,
  state,
  success: true,
});

export class DocumentPagesExecutionRuntime {
  constructor(private readonly services: DocumentPagesRuntimeServices) {}

  async viewDocumentPages(args: ViewDocumentPagesParams): Promise<BuiltinServerRuntimeOutput> {
    const fileId = typeof args.fileId === 'string' ? args.fileId.trim() : '';
    if (!fileId) return fail('fileId is required');

    const pages = uniquePositivePages(args.pages);
    if (pages.length === 0) return fail('pages must contain 1–4 one-based page numbers');

    const zoom = args.zoom === 'tiles' ? 'tiles' : 'page';

    const file = await this.services.findAccessibleFile(fileId);
    if (!file) return fail(`File not found or not accessible: ${fileId}`);

    const render = readFileRenderMetadata(file.metadata);

    if (render?.status === 'pending') {
      return ok('Page images are still being prepared, try again later.', {
        fileId,
        fileName: file.name,
        pages,
        status: 'pending',
        zoom,
      });
    }

    if (render?.status === 'ready' || render?.status === 'partial') {
      const useTiles = zoom === 'tiles' && pages.length === 1;
      const markers: DocumentPageImageMarker[] = [];
      const missing: number[] = [];

      for (const page of pages) {
        if (useTiles) {
          const tiles = pageTiles(render, page);
          if (tiles.length > 0) {
            for (const key of tiles) {
              markers.push({ fileId, key, kind: 'tile', page });
            }
            continue;
          }
        }
        const key = pagePng(render, page);
        if (!key) {
          missing.push(page);
          continue;
        }
        markers.push({ fileId, key, kind: 'page', page });
      }

      if (markers.length === 0) {
        if (render.status === 'partial' && this.services.enqueueRender) {
          try {
            await this.services.enqueueRender(fileId, { force: true });
          } catch {
            // enqueue is best-effort; the caller still retries later
          }
          return ok(
            `Page images for pages ${missing.join(', ') || pages.join(', ')} of "${file.name}" are being prepared, try again later.`,
            {
              fileId,
              fileName: file.name,
              markerCount: 0,
              pages,
              status: 'processing',
              zoom,
            },
          );
        }
        return ok(
          missing.length > 0
            ? `No rendered images for pages ${missing.join(', ')} of "${file.name}".`
            : `No rendered images for "${file.name}".`,
          { fileId, fileName: file.name, markerCount: 0, pages, status: 'ready', zoom },
        );
      }

      const attachedPages = [...new Set(markers.map((marker) => marker.page))].sort(
        (a, b) => a - b,
      );
      const lines = [
        `Requested page images for "${file.name}": pages ${attachedPages.join(', ')}.`,
        ...markers.map((marker) => formatDocumentPageImageMarker(marker)),
      ];
      if (missing.length > 0) {
        lines.push(`Pages without images: ${missing.join(', ')}.`);
      }

      return ok(lines.join('\n'), {
        fileId,
        fileName: file.name,
        markerCount: markers.length,
        pages: attachedPages,
        status: 'ready',
        zoom,
      });
    }

    if (isOfficeOrPdfFile(file.fileType, file.name) && this.services.enqueueRender) {
      try {
        await this.services.enqueueRender(fileId);
      } catch {
        // enqueue is best-effort; the caller still retries later
      }
      return ok('Page images are processing, please retry later.', {
        fileId,
        fileName: file.name,
        pages,
        status: 'processing',
        zoom,
      });
    }

    return fail(`No page images are available for "${file.name}".`, {
      fileId,
      fileName: file.name,
      pages,
      status: 'unavailable',
      zoom,
    });
  }
}

import { unzip as fflateUnzip } from 'fflate';

import type { SkillParser } from '@/server/services/skill/parser';

import type { SkillImportErrorReason } from './errors';
import { importError, SKILL_IMPORT_ERROR_REASONS } from './errors';
import { parser } from './manifest';

/** Decoded upload / remote ZIP compressed-byte cap. */
export const MAX_IMPORT_ZIP_BYTES = 20 * 1024 * 1024;
/** Total uncompressed entry-byte cap (ZIP bomb guard). */
export const MAX_IMPORT_ZIP_EXPANDED_BYTES = 50 * 1024 * 1024;
/** Mirrors skillResourceSchema content/sizeBytes cap. */
export const MAX_CONTENT_BYTES = 1_048_576;
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Consume a response body with an active abort deadline and a hard byte cap.
 * Rejects oversized Content-Length before reading; aborts on chunked oversize.
 */
export const readResponseBodyWithLimit = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> => {
  const contentLengthHeader = response.headers?.get?.('content-length');
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore cancel errors
      }
      return importError(
        maxBytes >= MAX_IMPORT_ZIP_BYTES
          ? SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE
          : SKILL_IMPORT_ERROR_REASONS.CONTENT_TOO_LARGE,
      );
    }
  }

  if (signal.aborted) {
    return importError(SKILL_IMPORT_ERROR_REASONS.TIMEOUT);
  }

  // Prefer streaming when available so we can abort mid-body.
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) {
          await reader.cancel().catch(() => undefined);
          return importError(SKILL_IMPORT_ERROR_REASONS.TIMEOUT);
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return importError(
            maxBytes >= MAX_IMPORT_ZIP_BYTES
              ? SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE
              : SKILL_IMPORT_ERROR_REASONS.CONTENT_TOO_LARGE,
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      if (signal.aborted || (error as Error).name === 'AbortError') {
        return importError(SKILL_IMPORT_ERROR_REASONS.TIMEOUT);
      }
      throw error;
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  // Fallback when body is not a stream (e.g. undici Response polyfills in tests).
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    return importError(
      maxBytes >= MAX_IMPORT_ZIP_BYTES
        ? SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE
        : SKILL_IMPORT_ERROR_REASONS.CONTENT_TOO_LARGE,
    );
  }
  return buffer;
};

/**
 * Expand a ZIP and reject when total uncompressed bytes exceed the hard cap.
 * Uses declared originalSize when present and re-checks actual decoded lengths.
 */
export const assertZipExpandedWithinLimit = async (buffer: Buffer): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let declaredTotal = 0;
    fflateUnzip(
      new Uint8Array(buffer),
      {
        filter(file) {
          const size =
            typeof file.originalSize === 'number' && Number.isFinite(file.originalSize)
              ? file.originalSize
              : 0;
          declaredTotal += size;
          if (declaredTotal > MAX_IMPORT_ZIP_EXPANDED_BYTES) {
            return false;
          }
          return true;
        },
      },
      (error, files) => {
        const fail = (reason: SkillImportErrorReason) => {
          try {
            importError(reason);
          } catch (err) {
            reject(err);
          }
        };

        if (declaredTotal > MAX_IMPORT_ZIP_EXPANDED_BYTES) {
          fail(SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE);
          return;
        }
        if (error) {
          fail(SKILL_IMPORT_ERROR_REASONS.INVALID_ZIP);
          return;
        }

        let actual = 0;
        for (const data of Object.values(files)) {
          actual += data.byteLength;
          if (actual > MAX_IMPORT_ZIP_EXPANDED_BYTES) {
            fail(SKILL_IMPORT_ERROR_REASONS.ZIP_TOO_LARGE);
            return;
          }
        }
        resolve();
      },
    );
  });
};

export const parseZipBuffer = async (
  buffer: Buffer,
  options?: { basePath?: string },
): Promise<Awaited<ReturnType<SkillParser['parseZipPackage']>>> => {
  await assertZipExpandedWithinLimit(buffer);
  return parser.parseZipPackage(buffer, options);
};

import { createHash } from 'node:crypto';

import {
  DUMP_MAX_BYTES,
  scanDumpPrivacyBuffer,
  scanDumpPrivacyFile,
  scanDumpPrivacyStream,
} from './privacy';

/**
 * External sanitized dump intake contract.
 *
 * Intentionally does NOT accept or persist path/URL/credentials in report output.
 * Callers may pass in-memory bytes or a local file handle only for the duration of
 * the run; reports record only safe metadata + content hash.
 */
export interface ExternalDumpInput {
  /**
   * Raw dump bytes (preferred). Mutually exclusive with `localPath` at the type level
   * is not enforced; runner prefers `content` when both are set.
   */
  content?: Buffer | string;
  /**
   * Optional local filesystem path used only transiently to load bytes.
   * Never written into reports.
   */
  localPath?: string;
}

export interface ExternalDumpAssessment {
  byteLength: number;
  contentSha256: string;
  privacy: 'failed' | 'passed';
  status: 'privacy-rejected' | 'privacy-verified' | 'unverified';
}

export interface ExternalDumpAbsent {
  status: 'absent';
}

export type ExternalDumpResult = ExternalDumpAbsent | ExternalDumpAssessment;

export const hashDumpContent = (
  content: Buffer | string,
): { byteLength: number; sha256: string } => {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return {
    byteLength: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
};

export const assessExternalDumpContent = async (
  content: Buffer | string,
): Promise<ExternalDumpAssessment> => {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const scan = await scanDumpPrivacyStream(buffer);
  if (scan.byteLength > DUMP_MAX_BYTES || scan.privacy === 'failed') {
    return {
      byteLength: scan.byteLength,
      contentSha256: scan.contentSha256,
      privacy: 'failed',
      status: 'privacy-rejected',
    };
  }
  // Defense in depth: buffer path also runs full-window scanner.
  if (scanDumpPrivacyBuffer(buffer) === 'failed') {
    return {
      byteLength: scan.byteLength,
      contentSha256: scan.contentSha256,
      privacy: 'failed',
      status: 'privacy-rejected',
    };
  }
  return {
    byteLength: scan.byteLength,
    contentSha256: scan.contentSha256,
    privacy: 'passed',
    status: 'privacy-verified',
  };
};

export const loadExternalDump = async (
  input: ExternalDumpInput | undefined,
): Promise<ExternalDumpResult> => {
  if (!input) return { status: 'absent' };

  if (input.content !== undefined) {
    return assessExternalDumpContent(input.content);
  }

  if (input.localPath) {
    // Path is used only to stream; never returned.
    const scan = await scanDumpPrivacyFile(input.localPath);
    if (scan.privacy === 'failed') {
      return {
        byteLength: scan.byteLength,
        contentSha256: scan.contentSha256,
        privacy: 'failed',
        status: 'privacy-rejected',
      };
    }
    return {
      byteLength: scan.byteLength,
      contentSha256: scan.contentSha256,
      privacy: 'passed',
      status: 'privacy-verified',
    };
  }

  // Explicit request without payload stays unverified (never pass).
  return {
    byteLength: 0,
    contentSha256: createHash('sha256').update('').digest('hex'),
    privacy: 'failed',
    status: 'unverified',
  };
};

/** Safe report slice — no path, URL, credentials, or body. */
export const toExternalDumpReportFields = (
  result: ExternalDumpResult,
): {
  byteLength?: number;
  contentSha256?: string;
  privacy?: 'failed' | 'not-applicable' | 'passed';
  status: 'absent' | 'privacy-rejected' | 'privacy-verified' | 'unverified';
} => {
  if (result.status === 'absent') {
    return { privacy: 'not-applicable', status: 'absent' };
  }

  return {
    byteLength: result.byteLength,
    contentSha256: result.contentSha256,
    privacy: result.privacy,
    status: result.status,
  };
};

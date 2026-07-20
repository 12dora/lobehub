/**
 * Privacy / redaction helpers for migration-compat reports and dump intake.
 * Never echo raw secrets, SQL, connection strings, or dump paths into reports.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

const FORBIDDEN_KEY_PATTERN =
  /ciphertext|connectionstring|connection_string|credential|hostname|instanceid|password|payload|private.?key|secret|token|uri|url|dump.?path|dump.?url|sql|error.?message|stack/iu;

const FORBIDDEN_VALUE_PATTERNS = [
  /(?:https?|postgres(?:ql)?|rediss?):\/\//iu,
  /(?:^|[^a-z\d])(?:localhost|host\.docker\.internal|127\.0\.0\.1)(?:[^a-z\d]|$)/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /(?:bearer|password|secret|token|api[_-]?key)\s*[:=]\s*\S+/iu,
  /(?:sk|pk|rk)[_-]live[_-][a-zA-Z0-9]{16,}/u,
  /(?:eyJ[\w-]{10,}\.[\w-]{10,})/u,
] as const;

/** Patterns that make an external dump unsafe to accept. */
export const DUMP_PRIVACY_REJECT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /postgres(?:ql)?:\/\/[^\s'"]+/iu,
  /(?:bearer|password|secret|api[_-]?key)\s*[:=]\s*\S+/iu,
  /(?:sk|pk|rk)[_-]live[_-][a-zA-Z0-9]{16,}/u,
  /COPY\s+public\.(?:accounts|sessions|verifications)\b/iu,
] as const;

/** Longest pattern allowance for chunk boundary overlap (bytes). */
export const DUMP_SCAN_OVERLAP_BYTES = 512;
export const DUMP_SCAN_CHUNK_BYTES = 64 * 1024;
/** Hard cap on accepted dump size (bytes). */
export const DUMP_MAX_BYTES = 32 * 1024 * 1024;

export const countForbiddenValues = (value: unknown, key?: string): number => {
  const violations = key && FORBIDDEN_KEY_PATTERN.test(key) ? 1 : 0;

  if (typeof value === 'string') {
    return violations + FORBIDDEN_VALUE_PATTERNS.filter((pattern) => pattern.test(value)).length;
  }

  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countForbiddenValues(item), violations);
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).reduce(
      (total, [childKey, childValue]) => total + countForbiddenValues(childValue, childKey),
      violations,
    );
  }

  return violations;
};

export const scanForForbiddenReportContent = (value: unknown) => {
  const violations = countForbiddenValues(value);
  return {
    result: violations === 0 ? ('passed' as const) : ('failed' as const),
    violations,
  };
};

const windowContainsForbidden = (windowText: string): boolean => {
  for (const pattern of DUMP_PRIVACY_REJECT_PATTERNS) {
    // Reset lastIndex for global-safe reuse (patterns are non-global today).
    pattern.lastIndex = 0;
    if (pattern.test(windowText)) return true;
  }
  return false;
};

/**
 * Full-content privacy scan with bounded overlapping windows so secrets that
 * straddle chunk boundaries are still detected. Fail closed on decode errors.
 */
export const scanDumpPrivacyBuffer = (buffer: Buffer): 'passed' | 'failed' => {
  if (buffer.byteLength === 0) return 'passed';
  if (buffer.byteLength > DUMP_MAX_BYTES) return 'failed';

  // UTF-8 validation (fail closed on invalid sequences).
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return 'failed';
  }

  const overlap = DUMP_SCAN_OVERLAP_BYTES;
  const chunk = DUMP_SCAN_CHUNK_BYTES;
  if (text.length <= chunk) {
    return windowContainsForbidden(text) ? 'failed' : 'passed';
  }

  for (let offset = 0; offset < text.length; offset += chunk - overlap) {
    const windowText = text.slice(offset, offset + chunk);
    if (windowContainsForbidden(windowText)) return 'failed';
    if (offset + chunk >= text.length) break;
  }
  return 'passed';
};

/** @deprecated Prefer scanDumpPrivacyBuffer; kept as thin alias for string inputs. */
export const scanDumpPrivacy = (content: string | Buffer): 'passed' | 'failed' => {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return scanDumpPrivacyBuffer(buffer);
};

export interface StreamPrivacyScanResult {
  byteLength: number;
  contentSha256: string;
  privacy: 'failed' | 'passed';
}

/**
 * Stream entire dump with overlap. Hashes all bytes. Fail closed on I/O,
 * unsupported encoding, size limit, or privacy hits.
 */
export const scanDumpPrivacyStream = async (
  source: Readable | string | Buffer,
): Promise<StreamPrivacyScanResult> => {
  if (typeof source === 'string' || Buffer.isBuffer(source)) {
    const buffer = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    if (buffer.byteLength > DUMP_MAX_BYTES) {
      return {
        byteLength: buffer.byteLength,
        contentSha256: createHash('sha256').update(buffer).digest('hex'),
        privacy: 'failed',
      };
    }
    return {
      byteLength: buffer.byteLength,
      contentSha256: createHash('sha256').update(buffer).digest('hex'),
      privacy: scanDumpPrivacyBuffer(buffer),
    };
  }

  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let carry = '';
  let byteLength = 0;
  let privacy: 'failed' | 'passed' = 'passed';

  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > DUMP_MAX_BYTES) {
        privacy = 'failed';
        // Drain remaining without processing secrets into memory beyond cap.
        break;
      }
      hash.update(buffer);
      let decoded: string;
      try {
        decoded = decoder.decode(buffer, { stream: true });
      } catch {
        privacy = 'failed';
        break;
      }
      const combined = carry + decoded;
      if (windowContainsForbidden(combined)) {
        privacy = 'failed';
      }
      // Keep overlap tail for boundary-crossing patterns.
      carry =
        combined.length > DUMP_SCAN_OVERLAP_BYTES
          ? combined.slice(combined.length - DUMP_SCAN_OVERLAP_BYTES)
          : combined;
    }
    try {
      const tail = decoder.decode();
      if (tail && windowContainsForbidden(carry + tail)) privacy = 'failed';
    } catch {
      privacy = 'failed';
    }
  } catch {
    privacy = 'failed';
  }

  return {
    byteLength,
    contentSha256: hash.digest('hex'),
    privacy,
  };
};

export const scanDumpPrivacyFile = async (
  absolutePath: string,
): Promise<StreamPrivacyScanResult> => {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      return {
        byteLength: 0,
        contentSha256: createHash('sha256').update('').digest('hex'),
        privacy: 'failed',
      };
    }
    if (info.size > DUMP_MAX_BYTES) {
      return {
        byteLength: info.size,
        contentSha256: createHash('sha256').update('').digest('hex'),
        privacy: 'failed',
      };
    }
    // Validate we can open; stream the full file.
    await open(absolutePath, 'r').then((handle) => handle.close());
    const stream = createReadStream(absolutePath, { highWaterMark: DUMP_SCAN_CHUNK_BYTES });
    return await scanDumpPrivacyStream(stream);
  } catch {
    return {
      byteLength: 0,
      contentSha256: createHash('sha256').update('').digest('hex'),
      privacy: 'failed',
    };
  }
};

export const shortSha = (fullSha: string): string => fullSha.slice(0, 7).toLowerCase();

export const isFullGitSha = (value: string): boolean => /^[a-f\d]{40}$/u.test(value);

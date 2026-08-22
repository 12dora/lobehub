import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CD_SIGNATURE = 0x02_01_4b_50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 65_535;

/** Per-entry cap for OOXML media (images). */
export const ZIP_ENTRY_MEDIA_MAX_BYTES = 4 * 1024 * 1024;
/** Per-entry cap for rels / XML. */
export const ZIP_ENTRY_XML_MAX_BYTES = 512 * 1024;
/** Aggregate decompressed bytes across extracted entries. */
export const ZIP_INFLATE_AGGREGATE_MAX_BYTES = 64 * 1024 * 1024;

const readU16 = (view: DataView, offset: number): number => view.getUint16(offset, true);
const readU32 = (view: DataView, offset: number): number => view.getUint32(offset, true);

const findEocdOffset = (bytes: Uint8Array, view: DataView): number => {
  const min = Math.max(0, bytes.byteLength - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let offset = bytes.byteLength - EOCD_MIN_SIZE; offset >= min; offset -= 1) {
    if (readU32(view, offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
};

/**
 * List ZIP entry names from the central directory (no inflate). Falls back to
 * a streaming `Unzip` scan if the EOCD/CD is truncated or ZIP64.
 */
export const listZipEntryNames = (bytes: Uint8Array): string[] => {
  const fromCd = listZipEntryNamesFromCentralDirectory(bytes);
  if (fromCd.length > 0) return fromCd;
  return listZipEntryNamesStreaming(bytes);
};

const listZipEntryNamesFromCentralDirectory = (bytes: Uint8Array): string[] => {
  if (bytes.byteLength < EOCD_MIN_SIZE) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocdOffset(bytes, view);
  if (eocd < 0) return [];

  const totalEntries = readU16(view, eocd + 10);
  const cdSize = readU32(view, eocd + 12);
  const cdOffset = readU32(view, eocd + 16);
  if (cdOffset + 46 > bytes.byteLength) return [];

  const names: string[] = [];
  const decoder = new TextDecoder('utf-8');
  let offset = cdOffset;
  const end = Math.min(bytes.byteLength, cdOffset + cdSize);

  for (let index = 0; index < totalEntries && offset + 46 <= end; index += 1) {
    if (readU32(view, offset) !== CD_SIGNATURE) break;
    const nameLen = readU16(view, offset + 28);
    const extraLen = readU16(view, offset + 30);
    const commentLen = readU16(view, offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.byteLength) break;
    names.push(decoder.decode(bytes.subarray(nameStart, nameEnd)));
    offset = nameEnd + extraLen + commentLen;
  }

  return names;
};

const listZipEntryNamesStreaming = (bytes: Uint8Array): string[] => {
  const names: string[] = [];
  try {
    const unzipper = new Unzip((file) => {
      names.push(file.name);
    });
    unzipper.register(UnzipPassThrough);
    unzipper.register(UnzipInflate);
    unzipper.push(bytes, true);
  } catch {
    return names;
  }
  return names;
};

export interface ExtractedZipEntry {
  bytes: Uint8Array;
  name: string;
}

export interface ExtractZipLimits {
  /** Stop extracting further entries once this many decompressed bytes have been kept. */
  aggregateMaxBytes?: number;
  /** Per-entry decompressed cap; when exceeded the stream is terminated and the entry skipped. */
  maxBytesFor?: (name: string) => number;
}

const concatChunks = (chunks: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/** Inflate only the named entries. Other files are skipped without decompression. */
export const extractZipEntries = async (
  bytes: Uint8Array,
  wanted: ReadonlySet<string>,
  limits: ExtractZipLimits = {},
): Promise<ExtractedZipEntry[]> => {
  if (wanted.size === 0) return [];

  const aggregateMax = limits.aggregateMaxBytes ?? ZIP_INFLATE_AGGREGATE_MAX_BYTES;
  const maxBytesFor = limits.maxBytesFor ?? (() => ZIP_ENTRY_MEDIA_MAX_BYTES);

  return new Promise((resolve, reject) => {
    const extracted: ExtractedZipEntry[] = [];
    let pending = 0;
    let finished = false;
    let failed: unknown;
    let inflated = 0;
    let aggregateExceeded = false;

    const maybeDone = () => {
      if (!finished || pending > 0 || failed) return;
      resolve(extracted);
    };

    const fail = (error: unknown) => {
      if (failed) return;
      failed = error;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    try {
      const unzipper = new Unzip((file) => {
        if (!wanted.has(file.name) || aggregateExceeded) return;
        const cap = maxBytesFor(file.name);
        pending += 1;
        const chunks: Uint8Array[] = [];
        let size = 0;
        let skipped = false;

        const skip = () => {
          if (skipped) return;
          skipped = true;
          file.terminate();
          pending -= 1;
          maybeDone();
        };

        file.ondata = (error, data, final) => {
          if (skipped) return;
          if (error) {
            skip();
            return;
          }
          if (data && data.byteLength > 0) {
            size += data.byteLength;
            if (size > cap || inflated + size > aggregateMax) {
              if (inflated + size > aggregateMax) aggregateExceeded = true;
              skip();
              return;
            }
            chunks.push(data);
          }
          if (!final) return;
          inflated += size;
          extracted.push({ bytes: concatChunks(chunks, size), name: file.name });
          pending -= 1;
          maybeDone();
        };
        try {
          file.start();
        } catch {
          skip();
        }
      });
      unzipper.register(UnzipPassThrough);
      unzipper.register(UnzipInflate);
      unzipper.push(bytes, true);
      finished = true;
      maybeDone();
    } catch (error) {
      fail(error);
    }
  });
};

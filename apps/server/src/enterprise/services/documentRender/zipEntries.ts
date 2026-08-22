import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CD_SIGNATURE = 0x02_01_4b_50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 65_535;

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

/** Inflate only the named entries. Other files are skipped without decompression. */
export const extractZipEntries = async (
  bytes: Uint8Array,
  wanted: ReadonlySet<string>,
): Promise<ExtractedZipEntry[]> => {
  if (wanted.size === 0) return [];

  return new Promise((resolve, reject) => {
    const extracted: ExtractedZipEntry[] = [];
    let pending = 0;
    let finished = false;
    let failed: unknown;

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
        if (!wanted.has(file.name)) return;
        pending += 1;
        const chunks: Uint8Array[] = [];
        file.ondata = (error, data, final) => {
          if (error) {
            fail(error);
            return;
          }
          if (data && data.byteLength > 0) chunks.push(data);
          if (!final) return;
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const out = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
          }
          extracted.push({ bytes: out, name: file.name });
          pending -= 1;
          maybeDone();
        };
        file.start();
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

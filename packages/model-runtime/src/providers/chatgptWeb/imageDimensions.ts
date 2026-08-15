/**
 * Minimal, dependency-free image header parser.
 *
 * chatgpt.com's `/backend-api/files` endpoint wants `width`/`height` alongside
 * the mime type when the upload is an image, and `packages/model-runtime` ships
 * to the browser SPA — so `sharp` / `image-size` / `Buffer` are all off limits.
 * We only read the few header bytes that carry the intrinsic size.
 */

export interface ImageDimensions {
  height: number;
  mimeType: string;
  width: number;
}

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) >>> 0) +
  (bytes[offset + 1] << 16) +
  (bytes[offset + 2] << 8) +
  bytes[offset + 3];

const readUint16BE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] << 8) + bytes[offset + 1];

const readUint16LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] + (bytes[offset + 1] << 8);

const readUint24LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean => {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
};

const asciiAt = (bytes: Uint8Array, offset: number, length: number): string => {
  if (bytes.length < offset + length) return '';
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const readPng = (bytes: Uint8Array): ImageDimensions | undefined => {
  // 8 signature bytes, 4 length, "IHDR", then width/height as big-endian u32
  if (bytes.length < 24 || asciiAt(bytes, 12, 4) !== 'IHDR') return undefined;
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (!width || !height) return undefined;
  // an APNG still starts with a plain IHDR; report it as png either way
  return { height, mimeType: 'image/png', width };
};

/** Frame markers that carry the frame size; excludes DHT/DAC/RSTn/SOS. */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Markers that carry NO payload at all — no length field follows them, so
 * reading one as a segment header would walk the parser into random bytes.
 * `0x01` is TEM (arithmetic-coding temporary), `0xD0`-`0xD7` are the restart
 * markers, `0xD8`/`0xD9` are SOI/EOI.
 */
const isStandaloneJpegMarker = (marker: number): boolean =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);

const readJpeg = (bytes: Uint8Array): ImageDimensions | undefined => {
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // resynchronise: fill bytes / corrupt segment
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // 0xFF padding: the next byte may still be the real marker
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // a stuffed 0xFF00 inside entropy data is not a marker
    if (marker === 0x00 || isStandaloneJpegMarker(marker)) {
      offset += 2;
      continue;
    }

    // every remaining marker is followed by a 16-bit segment length
    if (offset + 3 >= bytes.length) return undefined;
    const segmentLength = readUint16BE(bytes, offset + 2);
    if (segmentLength < 2) return undefined;

    if (JPEG_SOF_MARKERS.has(marker)) {
      // precision(1) + height(2) + width(2) + components(1) = 8 payload bytes
      if (segmentLength < 8 || offset + 8 >= bytes.length) return undefined;
      const height = readUint16BE(bytes, offset + 5);
      const width = readUint16BE(bytes, offset + 7);
      if (!width || !height) return undefined;
      return { height, mimeType: 'image/jpeg', width };
    }
    // 0xDA (SOS) means entropy-coded data follows — no size left to find
    if (marker === 0xda) return undefined;
    offset += 2 + segmentLength;
  }
  return undefined;
};

/** Only the two versions the spec defines; "GIF" alone is not a GIF. */
const GIF_VERSIONS = new Set(['GIF87a', 'GIF89a']);

const readGif = (bytes: Uint8Array): ImageDimensions | undefined => {
  if (bytes.length < 10 || !GIF_VERSIONS.has(asciiAt(bytes, 0, 6))) return undefined;
  const width = readUint16LE(bytes, 6);
  const height = readUint16LE(bytes, 8);
  if (!width || !height) return undefined;
  return { height, mimeType: 'image/gif', width };
};

/** VP8 keyframe start code: the 3 bytes that follow the frame tag. */
const VP8_START_CODE = [0x9d, 0x01, 0x2a];
/** VP8L stream signature byte. */
const VP8L_SIGNATURE = 0x2f;

const readWebp = (bytes: Uint8Array): ImageDimensions | undefined => {
  if (bytes.length < 21) return undefined;
  const format = asciiAt(bytes, 12, 4);

  // lossy: VP8 bitstream, size lives after the 3-byte frame tag + start code
  if (format === 'VP8 ') {
    if (bytes.length < 30 || !startsWith(bytes, VP8_START_CODE, 23)) return undefined;
    const width = readUint16LE(bytes, 26) & 0x3f_ff;
    const height = readUint16LE(bytes, 28) & 0x3f_ff;
    if (!width || !height) return undefined;
    return { height, mimeType: 'image/webp', width };
  }

  // lossless: after the 0x2f signature byte, 14 bits width-1 then 14 bits height-1
  if (format === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== VP8L_SIGNATURE) return undefined;
    const packed =
      bytes[21] + bytes[22] * 0x1_00 + bytes[23] * 0x1_00_00 + bytes[24] * 0x1_00_00_00;
    const width = (packed & 0x3f_ff) + 1;
    const height = ((packed >>> 14) & 0x3f_ff) + 1;
    return { height, mimeType: 'image/webp', width };
  }

  // extended: canvas size as two 24-bit little-endian values, minus one
  if (format === 'VP8X') {
    if (bytes.length < 30) return undefined;
    const width = readUint24LE(bytes, 24) + 1;
    const height = readUint24LE(bytes, 27) + 1;
    return { height, mimeType: 'image/webp', width };
  }

  return undefined;
};

/**
 * Read the intrinsic size and mime type out of an encoded image's header.
 * Returns `undefined` for anything unrecognised or truncated — callers should
 * treat the dimensions as optional rather than failing the upload.
 */
export const readImageDimensions = (bytes: Uint8Array): ImageDimensions | undefined => {
  if (!bytes || bytes.length < 10) return undefined;

  if (startsWith(bytes, PNG_SIGNATURE)) return readPng(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return readJpeg(bytes);
  if (asciiAt(bytes, 0, 3) === 'GIF') return readGif(bytes);
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return readWebp(bytes);

  return undefined;
};

/** Mime type alone, for callers that do not need the size. */
export const readImageMimeType = (bytes: Uint8Array): string | undefined =>
  readImageDimensions(bytes)?.mimeType;

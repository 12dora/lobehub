import { createFileS3 } from '@/server/modules/S3';
import { documentRenderArtifactKeys, documentRenderArtifactPrefix } from '@/types/files';

const CONTACT_SHEET_GUTTER_PX = 8;
const LABEL_PAD_X = 5;
const LABEL_PAD_Y = 4;
const DIGIT_W = 7;
const DIGIT_H = 12;
const DIGIT_GAP = 2;
const DIGIT_STROKE = 2;

/**
 * Seven-segment digit masks (a b c d e f g). The app image ships no system
 * fonts, so `fillText` would draw nothing — page numbers are drawn as rectangles.
 */
const SEVEN_SEGMENT: Record<string, number> = {
  '0': 0b111_1110,
  '1': 0b011_0000,
  '2': 0b110_1101,
  '3': 0b111_1001,
  '4': 0b011_0011,
  '5': 0b101_1011,
  '6': 0b101_1111,
  '7': 0b111_0000,
  '8': 0b111_1111,
  '9': 0b111_1011,
};

const drawDigit = (
  ctx: { fillRect: (x: number, y: number, w: number, h: number) => void },
  digit: string,
  x: number,
  y: number,
): void => {
  const mask = SEVEN_SEGMENT[digit] ?? 0;
  const half = DIGIT_H / 2;
  const t = DIGIT_STROKE;
  const segments: Array<[number, number, number, number]> = [
    [x, y, DIGIT_W, t], // a (top)
    [x + DIGIT_W - t, y, t, half], // b (top-right)
    [x + DIGIT_W - t, y + half, t, half], // c (bottom-right)
    [x, y + DIGIT_H - t, DIGIT_W, t], // d (bottom)
    [x, y + half, t, half], // e (bottom-left)
    [x, y, t, half], // f (top-left)
    [x, y + half - t / 2, DIGIT_W, t], // g (middle)
  ];
  for (const [index, rect] of segments.entries()) {
    if (mask & (1 << (6 - index))) ctx.fillRect(...rect);
  }
};
const S3_DELETE_CHUNK = 1000;

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  throw error;
};

export interface ContactSheetThumb {
  page: number;
  png: Uint8Array;
}

export interface ContactSheetComposeResult {
  height: number;
  pages: number[];
  png: Buffer;
  width: number;
}

export const composeContactSheet = async (params: {
  cols: number;
  rows: number;
  thumbs: readonly ContactSheetThumb[];
}): Promise<ContactSheetComposeResult | undefined> => {
  const cols = Math.max(1, params.cols);
  const maxRows = Math.max(1, params.rows);
  const thumbs = params.thumbs.slice(0, cols * maxRows);
  if (thumbs.length === 0) return undefined;
  // A trailing sheet only gets the rows it fills — no blank grid below the thumbs.
  const rows = Math.min(maxRows, Math.ceil(thumbs.length / cols));

  const canvasMod = await import('@napi-rs/canvas');
  const images = await Promise.all(
    thumbs.map(async (thumb) => ({
      image: await canvasMod.loadImage(Buffer.from(thumb.png)),
      page: thumb.page,
    })),
  );

  const cellWidth = Math.max(1, ...images.map((item) => item.image.width));
  const cellHeight = Math.max(1, ...images.map((item) => item.image.height));
  const width = cols * cellWidth + (cols + 1) * CONTACT_SHEET_GUTTER_PX;
  const height = rows * cellHeight + (rows + 1) * CONTACT_SHEET_GUTTER_PX;

  const canvas = canvasMod.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  for (const [index, item] of images.entries()) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = CONTACT_SHEET_GUTTER_PX + col * (cellWidth + CONTACT_SHEET_GUTTER_PX);
    const y = CONTACT_SHEET_GUTTER_PX + row * (cellHeight + CONTACT_SHEET_GUTTER_PX);
    const dx = x + Math.floor((cellWidth - item.image.width) / 2);
    const dy = y + Math.floor((cellHeight - item.image.height) / 2);
    ctx.drawImage(item.image, dx, dy);

    const label = String(item.page);
    const labelWidth = label.length * DIGIT_W + (label.length - 1) * DIGIT_GAP + LABEL_PAD_X * 2;
    const labelHeight = DIGIT_H + LABEL_PAD_Y * 2;
    const lx = x + cellWidth - labelWidth - 4;
    const ly = y + cellHeight - labelHeight - 4;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(lx, ly, labelWidth, labelHeight);
    ctx.fillStyle = '#ffffff';
    for (const [digitIndex, digit] of [...label].entries()) {
      drawDigit(
        ctx,
        digit,
        lx + LABEL_PAD_X + digitIndex * (DIGIT_W + DIGIT_GAP),
        ly + LABEL_PAD_Y,
      );
    }
  }

  return {
    height,
    pages: images.map((item) => item.page),
    png: canvas.toBuffer('image/png'),
    width,
  };
};

export const uploadPngArtifact = async (
  key: string,
  png: Uint8Array | Buffer,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  const s3 = await createFileS3();
  throwIfAborted(signal);
  await s3.uploadBuffer(key, Buffer.from(png), 'image/png');
};

export const uploadImageArtifact = async (
  key: string,
  bytes: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  const s3 = await createFileS3();
  throwIfAborted(signal);
  await s3.uploadBuffer(key, Buffer.from(bytes), contentType);
};

export const uploadPdfArtifact = async (
  fileId: string,
  pdf: Uint8Array,
  signal?: AbortSignal,
): Promise<string> => {
  throwIfAborted(signal);
  const key = documentRenderArtifactKeys.pdf(fileId);
  const s3 = await createFileS3();
  throwIfAborted(signal);
  await s3.uploadBuffer(key, Buffer.from(pdf), 'application/pdf');
  return key;
};

export const deleteDocumentRenderArtifacts = async (fileIds: string[]): Promise<void> => {
  if (fileIds.length === 0) return;
  const s3 = await createFileS3();
  for (const fileId of fileIds) {
    const keys = await s3.listObjectKeysByPrefix(documentRenderArtifactPrefix(fileId));
    for (let offset = 0; offset < keys.length; offset += S3_DELETE_CHUNK) {
      const chunk = keys.slice(offset, offset + S3_DELETE_CHUNK);
      if (chunk.length > 0) await s3.deleteFiles(chunk);
    }
  }
};

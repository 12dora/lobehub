import { createFileS3 } from '@/server/modules/S3';
import { documentRenderArtifactKeys, documentRenderArtifactPrefix } from '@/types/files';

const CONTACT_SHEET_GUTTER_PX = 8;
const LABEL_PAD_X = 5;
const LABEL_PAD_Y = 3;
const LABEL_FONT = '12px sans-serif';
const S3_DELETE_CHUNK = 1000;

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
  const rows = Math.max(1, params.rows);
  const thumbs = params.thumbs.slice(0, cols * rows);
  if (thumbs.length === 0) return undefined;

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
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  for (const [index, item] of images.entries()) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = CONTACT_SHEET_GUTTER_PX + col * (cellWidth + CONTACT_SHEET_GUTTER_PX);
    const y = CONTACT_SHEET_GUTTER_PX + row * (cellHeight + CONTACT_SHEET_GUTTER_PX);
    const dx = x + Math.floor((cellWidth - item.image.width) / 2);
    const dy = y + Math.floor((cellHeight - item.image.height) / 2);
    ctx.drawImage(item.image, dx, dy);

    const label = String(item.page);
    const metrics = ctx.measureText(label);
    const labelWidth = Math.ceil(metrics.width) + LABEL_PAD_X * 2;
    const labelHeight = 16 + LABEL_PAD_Y;
    const lx = x + cellWidth - labelWidth - 4;
    const ly = y + cellHeight - labelHeight - 4;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(lx, ly, labelWidth, labelHeight);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, lx + labelWidth / 2, ly + labelHeight / 2);
  }

  return {
    height,
    pages: images.map((item) => item.page),
    png: canvas.toBuffer('image/png'),
    width,
  };
};

export const uploadPngArtifact = async (key: string, png: Uint8Array | Buffer): Promise<void> => {
  const s3 = await createFileS3();
  await s3.uploadBuffer(key, Buffer.from(png), 'image/png');
};

export const uploadImageArtifact = async (
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> => {
  const s3 = await createFileS3();
  await s3.uploadBuffer(key, Buffer.from(bytes), contentType);
};

export const uploadPdfArtifact = async (fileId: string, pdf: Uint8Array): Promise<string> => {
  const key = documentRenderArtifactKeys.pdf(fileId);
  const s3 = await createFileS3();
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

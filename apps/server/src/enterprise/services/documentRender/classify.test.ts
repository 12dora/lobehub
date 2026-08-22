// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { classifyDocument, countOoxmlMediaEntries, resolveDocumentKind } from './classify';
import { listZipEntryNames } from './zipEntries';

const fixture = (...parts: string[]) =>
  path.join(process.cwd(), 'packages/file-loaders/src/loaders', ...parts);

const makeOoxml = (entries: Record<string, string | Uint8Array>): Uint8Array => {
  const files: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(entries)) {
    files[name] = typeof body === 'string' ? strToU8(body) : body;
  }
  return zipSync(files);
};

/** Minimal 1-page PDF with a filled rectangle and no text. */
const makeVisualPdf = (): Uint8Array => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>\nendobj\n',
  ];
  const stream = '0.2 0.4 0.8 rg\n10 10 180 80 re\nf\n';
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);

  const header = '%PDF-1.4\n';
  const offsets = [0];
  let pos = header.length;
  for (const object of objects) {
    offsets.push(pos);
    pos += object.length;
  }

  const xrefLines = ['xref', '0 5', '0000000000 65535 f '];
  for (let index = 1; index <= 4; index += 1) {
    xrefLines.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `);
  }
  const xref = `${xrefLines.join('\n')}\n`;
  const trailer = `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  return new TextEncoder().encode(header + objects.join('') + xref + trailer);
};

/** One-page PDF with a Helvetica text layer long enough to be non-visual. */
const makeTextPdf = (): Uint8Array => {
  const text = 'Hello world this is a long enough text layer for T0';
  const stream = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const header = '%PDF-1.4\n';
  const offsets = [0];
  let pos = header.length;
  for (const object of objects) {
    offsets.push(pos);
    pos += object.length;
  }
  const xrefLines = ['xref', '0 6', '0000000000 65535 f '];
  for (let index = 1; index <= 5; index += 1) {
    xrefLines.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `);
  }
  const xref = `${xrefLines.join('\n')}\n`;
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  return new TextEncoder().encode(header + objects.join('') + xref + trailer);
};

describe('resolveDocumentKind', () => {
  it('maps office and pdf names/MIME types', () => {
    expect(resolveDocumentKind('a.docx', 'application/octet-stream')).toBe('docx');
    expect(
      resolveDocumentKind(
        'a.bin',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe('pptx');
    expect(resolveDocumentKind('sheet.xlsx', '')).toBe('xlsx');
    expect(resolveDocumentKind('scan.PDF', 'application/pdf')).toBe('pdf');
    expect(resolveDocumentKind('notes.txt', 'text/plain')).toBe('other');
  });
});

describe('classifyDocument', () => {
  it('classifies the file-loaders test.docx fixture as T0', async () => {
    const bytes = await readFile(fixture('docx/fixtures/test.docx'));
    const names = listZipEntryNames(bytes);
    expect(names.length).toBeGreaterThan(0);
    expect(countOoxmlMediaEntries(names)).toBe(0);
    const result = await classifyDocument({
      bytes,
      fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      name: 'test.docx',
    });
    expect(result).toMatchObject({ kind: 'docx', mediaCount: 0, tier: 'T0' });
  });

  it('classifies the file-loaders test.pptx fixture as T2 when pptxAlwaysT2', async () => {
    const bytes = await readFile(fixture('pptx/fixtures/test.pptx'));
    const result = await classifyDocument(
      {
        bytes,
        fileType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        name: 'test.pptx',
      },
      { mediaThresholdT2: 3, pptxAlwaysT2: true },
    );
    expect(result.kind).toBe('pptx');
    expect(result.tier).toBe('T2');
    expect(result.reason).toBe('pptxAlwaysT2');
  });

  it('classifies pptx by media count when pptxAlwaysT2 is false', async () => {
    const bytes = makeOoxml({
      '[Content_Types].xml': '<Types/>',
      'ppt/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'ppt/slides/slide1.xml': '<p:sld/>',
    });
    const t1 = await classifyDocument(
      { bytes, fileType: 'application/octet-stream', name: 'deck.pptx' },
      { mediaThresholdT2: 3, pptxAlwaysT2: false },
    );
    expect(t1).toMatchObject({ kind: 'pptx', mediaCount: 1, tier: 'T1' });

    const t2bytes = makeOoxml({
      '[Content_Types].xml': '<Types/>',
      'ppt/media/a.png': new Uint8Array([1]),
      'ppt/media/b.png': new Uint8Array([1]),
      'ppt/media/c.png': new Uint8Array([1]),
    });
    const t2 = await classifyDocument(
      { bytes: t2bytes, fileType: '', name: 'deck.pptx' },
      { mediaThresholdT2: 3, pptxAlwaysT2: false },
    );
    expect(t2.tier).toBe('T2');
  });

  it('counts xl/charts and drawings as media for xlsx T2', async () => {
    const bytes = makeOoxml({
      'xl/charts/chart1.xml': '<c:chart/>',
      'xl/drawings/drawing1.xml': '<xdr:wsDr/>',
      'xl/media/image1.jpeg': new Uint8Array([1, 2, 3]),
    });
    const result = await classifyDocument(
      { bytes, fileType: '', name: 'book.xlsx' },
      { mediaThresholdT2: 3, pptxAlwaysT2: true },
    );
    expect(result).toMatchObject({ kind: 'xlsx', mediaCount: 3, tier: 'T2' });
  });

  it('classifies a generated text PDF as T0 and a visual PDF as T2', async () => {
    const text = await classifyDocument({
      bytes: makeTextPdf(),
      fileType: 'application/pdf',
      name: 'text.pdf',
    });
    expect(text.kind).toBe('pdf');
    expect(text.tier).toBe('T0');
    expect(text.pages?.[0]?.visual).toBe(false);

    const visual = await classifyDocument({
      bytes: makeVisualPdf(),
      fileType: 'application/pdf',
      name: 'scan.pdf',
    });
    expect(visual.tier).toBe('T2');
    expect(visual.pages?.[0]?.visual).toBe(true);
  });
});

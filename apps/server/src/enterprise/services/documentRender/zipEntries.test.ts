// @vitest-environment node
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  extractZipEntries,
  ZIP_ENTRY_MEDIA_MAX_BYTES,
  ZIP_ENTRY_XML_MAX_BYTES,
} from './zipEntries';

describe('extractZipEntries zip-bomb caps', () => {
  it('aborts inflation and skips an entry that decompresses past the media cap', async () => {
    const bomb = zipSync({ 'word/media/big.png': new Uint8Array(10 * 1024 * 1024) }, { level: 9 });
    expect(bomb.byteLength).toBeLessThan(64 * 1024);

    const entries = await extractZipEntries(bomb, new Set(['word/media/big.png']), {
      maxBytesFor: () => ZIP_ENTRY_MEDIA_MAX_BYTES,
    });
    expect(entries).toEqual([]);
  });

  it('skips rels/xml entries that decompress past 512 KiB', async () => {
    const xml = zipSync(
      { 'ppt/slides/_rels/slide1.xml.rels': new Uint8Array(600 * 1024) },
      { level: 9 },
    );
    const entries = await extractZipEntries(xml, new Set(['ppt/slides/_rels/slide1.xml.rels']), {
      maxBytesFor: () => ZIP_ENTRY_XML_MAX_BYTES,
    });
    expect(entries).toEqual([]);
  });

  it('keeps a small entry under the cap', async () => {
    const zip = zipSync({ 'word/media/a.png': new Uint8Array([1, 2, 3, 4]) });
    const entries = await extractZipEntries(zip, new Set(['word/media/a.png']));
    expect(entries).toHaveLength(1);
    expect([...entries[0]!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('enforces an aggregate decompressed cap across entries', async () => {
    const zip = zipSync(
      {
        'word/media/a.png': new Uint8Array(3 * 1024 * 1024),
        'word/media/b.png': new Uint8Array(3 * 1024 * 1024),
      },
      { level: 9 },
    );
    const entries = await extractZipEntries(
      zip,
      new Set(['word/media/a.png', 'word/media/b.png']),
      { aggregateMaxBytes: 4 * 1024 * 1024, maxBytesFor: () => ZIP_ENTRY_MEDIA_MAX_BYTES },
    );
    expect(entries.length).toBeLessThan(2);
    for (const entry of entries) {
      expect(entry.bytes.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });
});

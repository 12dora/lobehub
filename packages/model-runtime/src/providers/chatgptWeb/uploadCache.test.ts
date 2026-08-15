import { beforeEach, describe, expect, it } from 'vitest';

import type { UploadedFileRef } from './types';
import {
  clearUploadCache,
  getCachedUpload,
  setCachedUpload,
  uploadCacheKey,
  uploadCacheWeight,
  uploadNamespace,
} from './uploadCache';

const BYTES = new Uint8Array([1, 2, 3, 4]);

const ref = (fileId: string): UploadedFileRef => ({
  fileId,
  kind: 'image',
  mimeType: 'image/png',
  name: 'a.png',
  size: 4,
});

beforeEach(() => {
  clearUploadCache();
});

describe('uploadNamespace', () => {
  it('prefers the account id', () => {
    expect(uploadNamespace('acc-1', 'token')).toBe('acc:acc-1');
  });

  it('falls back to a digest of the access token, never a shared bucket', () => {
    const first = uploadNamespace(undefined, 'token-a');
    const second = uploadNamespace(undefined, 'token-b');

    expect(first).toMatch(/^tok:[\da-f]{32}$/);
    expect(first).not.toBe(second);
    // the token itself never appears in the key
    expect(first).not.toContain('token-a');
  });

  it('gives no namespace at all when it knows neither', () => {
    expect(uploadNamespace(undefined, undefined)).toBeUndefined();
    expect(uploadCacheKey(undefined, BYTES)).toBeUndefined();
  });
});

describe('uploadCache', () => {
  it('never serves one credential’s upload to another', () => {
    const a = uploadCacheKey(uploadNamespace(undefined, 'token-a'), BYTES);
    const b = uploadCacheKey(uploadNamespace(undefined, 'token-b'), BYTES);
    setCachedUpload(a, ref('file-a'));

    expect(getCachedUpload(a)).toMatchObject({ fileId: 'file-a' });
    expect(getCachedUpload(b)).toBeUndefined();
  });

  it('is a no-op without a namespace', () => {
    setCachedUpload(undefined, ref('file-x'));
    expect(getCachedUpload(undefined)).toBeUndefined();
  });

  it('expires an entry after 24h', () => {
    const key = uploadCacheKey('acc:acc-1', BYTES)!;
    setCachedUpload(key, ref('file-1'), 0);

    expect(getCachedUpload(key, 23 * 60 * 60 * 1000)).toMatchObject({ fileId: 'file-1' });
    expect(getCachedUpload(key, 25 * 60 * 60 * 1000)).toBeUndefined();
    // the expired entry is dropped, not just hidden
    expect(getCachedUpload(key, 0)).toBeUndefined();
  });

  it('evicts the least recently used entry past 200', () => {
    const keyFor = (index: number) => `acc:acc-1:${index}`;
    for (let index = 0; index < 200; index += 1) setCachedUpload(keyFor(index), ref(`f${index}`));

    // touching the oldest entry makes it the most recent again
    expect(getCachedUpload(keyFor(0))).toBeDefined();
    setCachedUpload(keyFor(200), ref('f200'));

    expect(getCachedUpload(keyFor(200))).toBeDefined();
    expect(getCachedUpload(keyFor(0))).toBeDefined();
    // …so entry 1 is the one that goes
    expect(getCachedUpload(keyFor(1))).toBeUndefined();
  });
});

describe('uploadCache retained size', () => {
  it('caps user-controlled strings and drops unknown fields', () => {
    const key = uploadCacheKey('acc:acc-1', BYTES)!;
    setCachedUpload(key, {
      ...ref('file-1'),
      name: 'a'.repeat(5000),
      // a caller-attached field must not be retained
      raw: { huge: 'b'.repeat(100_000) },
    } as any);

    const cached = getCachedUpload(key)!;
    expect(cached.name).toHaveLength(128);
    expect((cached as any).raw).toBeUndefined();
    expect(uploadCacheWeight()).toBeLessThan(1024);
  });

  it('bounds the TOTAL retained size, not just the entry count', () => {
    // entries well under the 200-entry cap, but heavy: the weight bound is what
    // has to evict here
    const key = (index: number) => `acc:acc-1:${'k'.repeat(400)}:${index}`;
    for (let index = 0; index < 150; index += 1)
      setCachedUpload(key(index), { ...ref(`f${index}`), name: 'n'.repeat(128) });

    expect(uploadCacheWeight()).toBeLessThanOrEqual(64 * 1024);
    // the oldest went first…
    expect(getCachedUpload(key(0))).toBeUndefined();
    // …and the newest survived
    expect(getCachedUpload(key(149))).toBeDefined();
  });
});

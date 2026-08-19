import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { download, installLibrary, warnLibraryFailure } from './install.mts';
import { LIBRARY_VERSION_MARKER, libraryFileName } from './lib';

const DIRTY_URL = 'https://user:pass@mirror.example/pinned/secret.tar.gz?sig=SIGNATURE';
const FETCH_TYPEERROR = new TypeError(`Failed to parse URL from ${DIRTY_URL}`);

const captureStdio = () => {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(push);
  vi.spyOn(console, 'warn').mockImplementation(push);
  vi.spyOn(console, 'error').mockImplementation(push);
  return lines;
};

const assertNoSecrets = (text: string) => {
  expect(text).not.toContain('user:pass');
  expect(text).not.toContain('user:');
  expect(text).not.toContain('/pinned/');
  expect(text).not.toContain('secret.tar.gz');
  expect(text).not.toContain('SIGNATURE');
};

describe('download', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('never writes userinfo or path to stderr/stdout when fetch rejects a credential URL', async () => {
    const lines = captureStdio();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const href = String(input);
        expect(href).not.toContain('user:pass');
        expect(href).not.toContain('user:');
        throw FETCH_TYPEERROR;
      }),
    );

    const error = await download(DIRTY_URL).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    assertNoSecrets(message);
    expect(message).toBe('download failed from https://mirror.example');

    warnLibraryFailure(message);
    assertNoSecrets(lines.join('\n'));
  });

  it('sends stripped URL plus Basic auth, never the raw userinfo URL', async () => {
    const fetchMock = vi.fn(async () => {
      throw FETCH_TYPEERROR;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(download(DIRTY_URL)).rejects.toThrow(
      'download failed from https://mirror.example',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mirror.example/pinned/secret.tar.gz?sig=SIGNATURE');
    expect(url).not.toContain('user:pass');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('user:pass', 'utf8').toString('base64')}`,
    );
  });
});

describe('installLibrary version marker', () => {
  let dir: string;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { force: true, recursive: true });
  });

  const seedLibrary = (version: string) => {
    dir = mkdtempSync(path.join(tmpdir(), 'libcurl-install-'));
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, libraryFileName('darwin'));
    writeFileSync(dest, 'stale-dylib');
    writeFileSync(path.join(dir, LIBRARY_VERSION_MARKER), `${version}\n`);
    return dest;
  };

  it('does not re-download when the marker matches the manifest version', async () => {
    const dest = seedLibrary('v2.1.0');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await installLibrary({
      assetKey: 'arm64-macos',
      base: 'https://user:pass@mirror.example/pinned',
      manifestVersion: 'v2.1.0',
      platform: 'darwin',
      targetDir: dir,
    });

    expect(result).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(dest, 'utf8')).toBe('stale-dylib');
    expect(readFileSync(path.join(dir, LIBRARY_VERSION_MARKER), 'utf8').trim()).toBe('v2.1.0');
  });

  it('drops the stable library before a failed upgrade so the warning is truthful', async () => {
    const dest = seedLibrary('v2.0.0');
    const lines = captureStdio();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw FETCH_TYPEERROR;
      }),
    );

    const error = await installLibrary({
      assetKey: 'arm64-macos',
      base: 'https://user:pass@mirror.example/pinned',
      manifestVersion: 'v2.1.0',
      platform: 'darwin',
      targetDir: dir,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    assertNoSecrets((error as Error).message);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(path.join(dir, LIBRARY_VERSION_MARKER))).toBe(false);

    warnLibraryFailure((error as Error).message);
    const output = lines.join('\n');
    assertNoSecrets(output);
    expect(output).toContain('no library installed → CLI fallback');
  });
});

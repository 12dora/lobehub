import { describe, expect, it } from 'vitest';

import {
  CURL_HTTP_VERSION_2TLS,
  CURL_WRITEFUNC_PAUSE,
  CURLINFO,
  CURLOPT,
  LIBCURL_IMPERSONATE_PATH_ENV,
  probeLibcurlImpersonate,
  resolveLibcurlImpersonatePath,
} from './libcurlFfi';

describe('libcurl-impersonate constants', () => {
  it('matches curl.h encodings used by this libcurl-impersonate release', () => {
    expect(CURLOPT.URL).toBe(10_002);
    expect(CURLOPT.WRITEFUNCTION).toBe(20_011);
    expect(CURLOPT.HEADERFUNCTION).toBe(20_079);
    expect(CURLOPT.POSTFIELDSIZE_LARGE).toBe(30_120);
    expect(CURLOPT.COPYPOSTFIELDS).toBe(10_165);
    expect(CURLOPT.SUPPRESS_CONNECT_HEADERS).toBe(265);
    expect(CURLINFO.RESPONSE_CODE).toBe(0x20_0002);
    expect(CURLINFO.HTTP_VERSION).toBe(0x20_002e);
    expect(CURLINFO.NUM_CONNECTS).toBe(0x20_001a);
    expect(CURLINFO.LOCAL_PORT).toBe(0x20_002a);
    expect(CURL_HTTP_VERSION_2TLS).toBe(4);
    expect(CURL_WRITEFUNC_PAUSE).toBe(0x10_000_001);
  });
});

describe('resolveLibcurlImpersonatePath', () => {
  it('returns undefined for a missing env override', () => {
    expect(
      resolveLibcurlImpersonatePath({
        env: { [LIBCURL_IMPERSONATE_PATH_ENV]: '/definitely/missing/libcurl-impersonate.so' },
      }),
    ).toBeUndefined();
  });

  it('finds the repo-local cache from a nested cwd', () => {
    const resolved = resolveLibcurlImpersonatePath({
      cwd: process.cwd(),
      env: {},
    });
    if (!resolved) {
      console.warn('libcurl-impersonate not in repo cache — resolve skipped');
      return;
    }
    expect(resolved).toMatch(/libcurl-impersonate\.(dylib|so)$/);
  });
});

describe('probeLibcurlImpersonate', () => {
  it('reports availability without throwing', () => {
    const probe = probeLibcurlImpersonate();
    if (!probe.available) {
      console.warn(`libcurl-impersonate unavailable: ${probe.reason}`);
      expect(probe.reason).toBeTruthy();
      return;
    }
    expect(probe.available).toBe(true);
    expect(probe.libraryPath).toBeTruthy();
  });
});

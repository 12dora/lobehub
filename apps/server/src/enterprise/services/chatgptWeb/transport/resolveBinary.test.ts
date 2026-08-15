import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ChatGPTWebTransportUnavailableError } from './errors';
import { CURL_IMPERSONATE_BIN_ENV, resolveCurlImpersonateBinary } from './resolveBinary';

let root: string;
let pathDir: string;
let repoRoot: string;

const writeExecutable = (path: string) => {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'curl-resolve-'));

  pathDir = join(root, 'bin');
  mkdirSync(pathDir);
  writeExecutable(join(pathDir, 'curl-impersonate'));

  // Repo-local dev cache, two levels below the repo root (a package cwd).
  repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, '.cache', 'curl-impersonate'), { recursive: true });
  mkdirSync(join(repoRoot, 'apps', 'server'), { recursive: true });
  writeExecutable(join(repoRoot, '.cache', 'curl-impersonate', 'curl-impersonate'));
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

describe('resolveCurlImpersonateBinary', () => {
  it('prefers the explicit override over everything else', () => {
    const override = join(pathDir, 'curl-impersonate');

    expect(resolveCurlImpersonateBinary({ cwd: repoRoot, env: {}, override })).toBe(override);
  });

  it('reads the environment override next', () => {
    const binary = join(pathDir, 'curl-impersonate');

    expect(
      resolveCurlImpersonateBinary({ cwd: root, env: { [CURL_IMPERSONATE_BIN_ENV]: binary } }),
    ).toBe(binary);
  });

  it('rejects an environment override that is not executable', () => {
    const missing = join(root, 'nope');

    expect(() =>
      resolveCurlImpersonateBinary({ env: { [CURL_IMPERSONATE_BIN_ENV]: missing } }),
    ).toThrow(ChatGPTWebTransportUnavailableError);
  });

  it('falls back to PATH', () => {
    expect(resolveCurlImpersonateBinary({ cwd: root, env: { PATH: pathDir } })).toBe(
      join(pathDir, 'curl-impersonate'),
    );
  });

  it('walks up from the cwd to the repo-local dev cache', () => {
    expect(resolveCurlImpersonateBinary({ cwd: join(repoRoot, 'apps', 'server'), env: {} })).toBe(
      join(repoRoot, '.cache', 'curl-impersonate', 'curl-impersonate'),
    );
  });

  it('throws an actionable error when nothing is installed', () => {
    // `root` itself has no `.cache`, and an empty env removes PATH discovery.
    expect(() => resolveCurlImpersonateBinary({ cwd: join(root, 'bin'), env: {} })).toThrow(
      /bun run curl-impersonate:install/,
    );
  });
});

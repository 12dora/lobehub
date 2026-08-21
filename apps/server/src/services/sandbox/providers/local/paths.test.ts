import { describe, expect, it } from 'vitest';

import { isInsideWorkspace, resolveSandboxPath } from './paths';

describe('resolveSandboxPath', () => {
  it('roots relative paths at /mnt/data', () => {
    expect(resolveSandboxPath('report.txt')).toBe('/mnt/data/report.txt');
    expect(resolveSandboxPath('./nested/a.txt')).toBe('/mnt/data/nested/a.txt');
    expect(resolveSandboxPath(undefined)).toBe('/mnt/data');
    expect(resolveSandboxPath('')).toBe('/mnt/data');
  });

  it('accepts absolute paths already inside the workspace', () => {
    expect(resolveSandboxPath('/mnt/data')).toBe('/mnt/data');
    expect(resolveSandboxPath('/mnt/data/foo/../bar.txt')).toBe('/mnt/data/bar.txt');
  });

  it('rejects escapes via .. and unrelated absolute paths', () => {
    expect(() => resolveSandboxPath('/etc/passwd')).toThrow(/escapes sandbox workspace/);
    expect(() => resolveSandboxPath('/mnt/data/../etc/passwd')).toThrow(
      /escapes sandbox workspace/,
    );
    expect(() => resolveSandboxPath('../../etc/passwd')).toThrow(/escapes sandbox workspace/);
    expect(() => resolveSandboxPath('/mnt/data-evil/secret')).toThrow(/escapes sandbox workspace/);
    expect(() => resolveSandboxPath('foo\0/bar')).toThrow(/NUL/);
  });

  it('does not treat /mnt/data as a prefix of /mnt/data2', () => {
    expect(isInsideWorkspace('/mnt/data2')).toBe(false);
    expect(isInsideWorkspace('/mnt/data/2')).toBe(true);
  });
});

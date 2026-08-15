import { describe, expect, it } from 'vitest';

import { matchSandboxFile, parseSandboxFileHref } from './parse';

describe('parseSandboxFileHref', () => {
  it('parses the canonical ChatGPT sandbox href', () => {
    expect(parseSandboxFileHref('sandbox:/mnt/data/aihub-uat7.pdf')).toEqual({
      fileName: 'aihub-uat7.pdf',
      filePath: '/mnt/data/aihub-uat7.pdf',
    });
  });

  it('collapses the double-slash authority form and is protocol case-insensitive', () => {
    expect(parseSandboxFileHref('Sandbox://mnt/data/report.csv')).toEqual({
      fileName: 'report.csv',
      filePath: '/mnt/data/report.csv',
    });
  });

  it('decodes percent-encoded names and drops query / hash', () => {
    expect(
      parseSandboxFileHref('sandbox:/mnt/data/%E6%8A%A5%E5%91%8A%20v2.xlsx?v=1#page=2'),
    ).toEqual({
      fileName: '报告 v2.xlsx',
      filePath: '/mnt/data/报告 v2.xlsx',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseSandboxFileHref('  sandbox:/mnt/data/a.txt  ')?.fileName).toBe('a.txt');
  });

  it('ignores non-sandbox hrefs', () => {
    expect(parseSandboxFileHref('https://example.com/a.pdf')).toBeNull();
    expect(parseSandboxFileHref('/mnt/data/a.pdf')).toBeNull();
    expect(parseSandboxFileHref('file:///mnt/data/a.pdf')).toBeNull();
    expect(parseSandboxFileHref(undefined)).toBeNull();
    expect(parseSandboxFileHref('   ')).toBeNull();
  });

  it('ignores sandbox hrefs without a resolvable file name', () => {
    expect(parseSandboxFileHref('sandbox:')).toBeNull();
    expect(parseSandboxFileHref('sandbox:/mnt/data/')).toBeNull();
    expect(parseSandboxFileHref('sandbox:/mnt/data/..')).toBeNull();
  });
});

describe('matchSandboxFile', () => {
  const files = [
    { id: 'file-1', name: 'aihub-uat7.pdf' },
    { id: 'file-2', name: 'AIHub-UAT7.pdf' },
    { id: 'file-3', name: 'notes.md' },
  ];

  it('prefers the case-sensitive match', () => {
    expect(matchSandboxFile('AIHub-UAT7.pdf', files)?.id).toBe('file-2');
  });

  it('falls back to a case-insensitive match', () => {
    expect(matchSandboxFile('NOTES.MD', files)?.id).toBe('file-3');
  });

  it('returns undefined when nothing matches', () => {
    expect(matchSandboxFile('missing.pdf', files)).toBeUndefined();
    expect(matchSandboxFile('notes.md', [])).toBeUndefined();
    expect(matchSandboxFile(undefined, files)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';

import {
  BRANDING_BASELINE_POLICY,
  createBrandingBaseline,
  decodeBrandingText,
  isExcludedBrandingPath,
  normalizeRepositoryPath,
  scanBrandingFile,
  validateBrandingBaseline,
} from './brandingLiterals';

describe('branding literal policy', () => {
  it('finds user-visible literals in runtime strings, templates, and JSX', () => {
    const source = `
      export const title = 'LobeHub';
      export const description = \`Welcome to LobeChat, \${name}\`;
      export const View = () => <span>Open LOBEHUB now</span>;
      // LobeHub in source documentation is not a runtime literal.
      type LobeChatDatabase = unknown;
    `;

    const result = scanBrandingFile('src/features/Branding.tsx', source);

    expect(result.errors).toEqual([]);
    expect(result.candidates.map(({ brand, line }) => ({ brand, line }))).toEqual([
      { brand: 'LobeHub', line: 2 },
      { brand: 'LobeChat', line: 3 },
      { brand: 'LobeHub', line: 4 },
    ]);
  });

  it('allows stable package paths, protocol ids, URLs, email addresses, and legal attribution', () => {
    const source = `
      import type { Config } from '@lobechat/types';
      const provider = 'lobehub';
      const storage = 'lobechat:chat-input-history:v2';
      const event = 'LOBEHUB_SKILL_AUTH_SUCCESS';
      const userAgent = 'LobeHub Desktop/2.2.10';
      const homepage = 'https://github.com/lobehub/lobehub';
      const email = 'support@lobehub.com';
    `;

    const result = scanBrandingFile('src/internal.ts', source);
    const legal = scanBrandingFile('packages/example/LICENSE.txt', 'Copyright LobeHub');
    const database = scanBrandingFile(
      'packages/database/src/schemas/legacy.ts',
      `export const tableName = 'lobechat_messages';`,
    );

    expect(result.candidates).toEqual([]);
    expect(new Set(result.allowed.map(({ category }) => category))).toEqual(
      new Set(['internal-package-or-path', 'stable-protocol-or-storage-id', 'stable-url-or-email']),
    );
    expect(legal.allowed[0]?.category).toBe('legal-attribution');
    expect(database.allowed[0]?.category).toBe('stable-database-id');
  });

  it('detects case, Unicode, zero-width, escaped, entity, and percent-encoded disguises', () => {
    const encoded = [
      'LoBeHuB',
      'ＬｏｂｅＣｈａｔ',
      'Lobe\u200BHub',
      String.raw`\u004cobeHub`,
      String.raw`\x4cobeChat`,
      '&#x4c;obeHub',
      '%4cobeChat',
    ];

    expect(encoded.map(decodeBrandingText)).toEqual([
      'LoBeHuB',
      'LobeChat',
      'LobeHub',
      'LobeHub',
      'LobeChat',
      'LobeHub',
      'LobeChat',
    ]);

    for (const [index, text] of encoded.entries()) {
      const result = scanBrandingFile(`src/disguise-${index}.yaml`, `title: ${text}`);
      expect(result.candidates, text).toHaveLength(1);
    }
  });

  it('rejects absolute, traversing, encoded, Windows, and Unicode-slash repository paths', () => {
    expect(() => normalizeRepositoryPath('/src/file.ts')).toThrow('absolute');
    expect(() => normalizeRepositoryPath('../src/file.ts')).toThrow('traversal');
    expect(() => normalizeRepositoryPath('%252e%252e/src/file.ts')).toThrow('traversal');
    expect(() => normalizeRepositoryPath('C:\\src\\file.ts')).toThrow('absolute');
    expect(() => normalizeRepositoryPath('src／..／secret.ts')).toThrow('unsafe');
    expect(normalizeRepositoryPath('./src/file.ts')).toBe('src/file.ts');
  });

  it('defines explicit document, fixture, generated, test, and tooling exclusions', () => {
    expect(isExcludedBrandingPath('src/docs/branding.ts')).toBe(true);
    expect(isExcludedBrandingPath('src/fixtures/branding.ts')).toBe(true);
    expect(isExcludedBrandingPath('src/generated/branding.ts')).toBe(true);
    expect(isExcludedBrandingPath('src/branding.test.ts')).toBe(true);
    expect(isExcludedBrandingPath('src/README.md')).toBe(true);
    expect(isExcludedBrandingPath('src/.prettierignore')).toBe(true);
    expect(isExcludedBrandingPath('src/branding.ts')).toBe(false);
  });

  it('fails closed on branded unknown extensions and binary content masquerading as text', () => {
    const unknown = scanBrandingFile('src/view.unknown', 'title=LobeHub', {
      supportedExtension: false,
    });
    const disguisedBinary = scanBrandingFile('src/view.unknown', 'Lobe\0Hub', {
      supportedExtension: false,
    });

    expect(unknown.errors[0]).toContain('unsupported text extension');
    expect(disguisedBinary.errors[0]).toContain('NUL byte');
  });

  it('creates a deterministic line-independent baseline and validates stale metadata', () => {
    const baseline = createBrandingBaseline([
      { brand: 'LobeHub', column: 20, line: 99, path: 'src/z.ts', preview: 'LobeHub' },
      { brand: 'LobeChat', column: 1, line: 1, path: 'src/a.ts', preview: 'LobeChat' },
      { brand: 'LobeHub', column: 1, line: 2, path: 'src/z.ts', preview: 'LobeHub' },
    ]);

    expect(baseline).toEqual({
      entries: [
        { LobeChat: 1, category: 'legacy-user-visible', path: 'src/a.ts' },
        { LobeHub: 2, category: 'legacy-user-visible', path: 'src/z.ts' },
      ],
      policy: BRANDING_BASELINE_POLICY,
      version: 1,
    });
    expect(validateBrandingBaseline(baseline)).toEqual([]);
    expect(
      validateBrandingBaseline({
        entries: [
          { LobeHub: 1, category: 'legacy-user-visible', path: 'src/z.ts' },
          { LobeHub: 1, category: 'legacy-user-visible', path: 'src/a.ts' },
        ],
        policy: BRANDING_BASELINE_POLICY,
        version: 1,
      }),
    ).toContain('baseline entries must be sorted: src/z.ts before src/a.ts');
  });
});

import { describe, expect, it } from 'vitest';

import {
  BRANDING_BASELINE_POLICY,
  brandingOccurrenceKey,
  createBrandingBaseline,
  decodeBrandingText,
  isExcludedBrandingPath,
  normalizeRepositoryPath,
  scanBrandingFile,
  validateBrandingBaseline,
} from './brandingLiterals';

describe('branding literal policy', () => {
  it('finds runtime strings, templates, JSX text, and object keys while ignoring comments/types', () => {
    const result = scanBrandingFile(
      'src/features/Branding.tsx',
      `
        export const title = 'LobeHub';
        export const description = \`Welcome to LobeChat, \${name}\`;
        export const labels = { LobeHub: 'value' };
        export const View = () => <span>Open LOBEHUB now</span>;
        // LobeHub in source documentation is not runtime text.
        type LobeChatDatabase = unknown;
      `,
    );

    expect(result.errors).toEqual([]);
    expect(result.candidates.map(({ brand }) => brand)).toEqual([
      'LobeHub',
      'LobeChat',
      'LobeHub',
      'LobeHub',
    ]);
    expect(result.candidates.every(({ locator }) => !locator.includes('line'))).toBe(true);
  });

  it('folds finite static concatenations, template spans, JSX expressions, and computed keys', () => {
    const result = scanBrandingFile(
      'src/static.tsx',
      `
        const concatenated = 'Lobe' + 'Hub';
        const templated = \`Lobe\${'Chat'}\`;
        const suffix = 'Hub';
        const identifierSpan = \`Lobe\${suffix}\`;
        const values = { ['Lobe' + 'Hub']: true };
        const View = () => <span>{'Lobe' + 'Chat'}</span>;
      `,
    );

    expect(result.candidates.map(({ brand }) => brand)).toEqual([
      'LobeHub',
      'LobeChat',
      'LobeHub',
      'LobeHub',
      'LobeChat',
    ]);
  });

  it('detects HTML and CSS comment-split literals without executing content', () => {
    expect(
      scanBrandingFile('public/view.html', '<h1>Lobe<!-- split -->Hub</h1>').candidates,
    ).toHaveLength(1);
    expect(
      scanBrandingFile('src/view.css', '.x::after { content: "Lobe/*x*/Chat" }').candidates,
    ).toHaveLength(1);
  });

  it('allows only exact stable package, protocol, database, URL, email, and legal tokens', () => {
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
    const database = scanBrandingFile(
      'packages/database/src/schemas/legacy.ts',
      `export const table = pgTable('lobechat_messages', {});`,
    );
    const sqlDatabase = scanBrandingFile(
      'packages/database/migrations/legacy.sql',
      'CREATE TABLE lobehub_messages (id text);',
    );
    const databaseLookalike = scanBrandingFile(
      'packages/database/src/schemas/label.ts',
      `export const label = 'lobechat_messages';`,
    );
    const legal = scanBrandingFile('packages/example/LICENSE.txt', 'Copyright LobeHub');

    expect(result.candidates).toEqual([]);
    expect(new Set(result.allowed.map(({ category }) => category))).toEqual(
      new Set(['internal-package-or-path', 'stable-protocol-or-storage-id', 'stable-url-or-email']),
    );
    expect(database.allowed[0]?.category).toBe('stable-database-id');
    expect(sqlDatabase.allowed[0]?.category).toBe('stable-database-id');
    expect(databaseLookalike.candidates).toHaveLength(1);
    expect(legal.allowed[0]?.category).toBe('legal-attribution');
  });

  it('does not let mixed fragments or brand-like marketing slugs inherit an allowed category', () => {
    const source = [
      'Welcome to LobeHub; docs: https://lobehub.com',
      '@lobechat/types plus LobeHub',
      'License notice for LobeHub',
      'LobeHub/Welcome',
      'lobehub-welcome',
    ]
      .map((value, index) => `export const value${index} = ${JSON.stringify(value)};`)
      .join('\n');
    const result = scanBrandingFile('packages/database/src/mixed.ts', source);

    expect(result.allowed).toEqual([]);
    expect(result.candidates).toHaveLength(7);
    expect(result.candidates.map(({ preview }) => preview)).toContain('lobehub-welcome');
  });

  it('decodes UTF-8 percent sequences, double encoding, NFKC, and default-ignorables', () => {
    const encoded = [
      'LoBeHuB',
      'ＬｏｂｅＣｈａｔ',
      'Lobe\u200BHub',
      'Lobe\uFE0FHub',
      'Lobe\u180BChat',
      String.raw`\u004cobeHub`,
      String.raw`\x4cobeChat`,
      '&#x4c;obeHub',
      '%EF%BC%AC%EF%BD%8F%EF%BD%82%EF%BD%85%EF%BC%A8%EF%BD%95%EF%BD%82',
      '%254cobeChat',
    ];

    for (const [index, value] of encoded.entries()) {
      const decoded = decodeBrandingText(value);
      expect(decoded, value).toMatch(/lobehub|lobechat/i);
      expect(
        scanBrandingFile(`src/disguise-${index}.txt`, `title: ${value}`).candidates,
        value,
      ).toHaveLength(1);
    }
  });

  it('uses YAML key paths and TS semantic positions instead of line numbers', () => {
    const yaml = scanBrandingFile('src/branding.yaml', 'brand:\n  title: LobeHub\n');
    const first = scanBrandingFile('src/title.ts', `export const title = 'LobeHub';`);
    const moved = scanBrandingFile('src/title.ts', `\n\nexport const title = 'LobeHub';`);

    expect(yaml.candidates[0]?.locator).toBe('yaml:brand.title');
    expect(brandingOccurrenceKey(first.candidates[0]!)).toBe(
      brandingOccurrenceKey(moved.candidates[0]!),
    );
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

  it('creates a deterministic occurrence multiset and rejects case-colliding paths', () => {
    const candidates = scanBrandingFile(
      'src/z.ts',
      `export const title = 'LobeHub'; export const title2 = 'LobeHub';`,
    ).candidates;
    const baseline = createBrandingBaseline([...candidates].reverse());

    expect(baseline.version).toBe(2);
    expect(baseline.policy).toBe(BRANDING_BASELINE_POLICY);
    expect(validateBrandingBaseline(baseline)).toEqual([]);
    const collision = structuredClone(baseline);
    collision.entries.push({ ...collision.entries[0]!, path: 'SRC/z.ts' });
    collision.entries.sort((left, right) =>
      brandingOccurrenceKey(left).localeCompare(brandingOccurrenceKey(right), 'en'),
    );
    expect(validateBrandingBaseline(collision)).toContain(
      'case-colliding baseline paths: SRC/z.ts and src/z.ts',
    );
  });
});

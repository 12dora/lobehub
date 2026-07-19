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
  it('finds runtime strings, templates, and JSX text while classifying object keys', () => {
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
    expect(result.candidates.map(({ brand }) => brand)).toEqual(['LobeHub', 'LobeChat', 'LobeHub']);
    expect(result.allowed).toEqual([
      expect.objectContaining({ brand: 'LobeHub', category: 'stable-code-key' }),
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
      'LobeChat',
    ]);
    expect(result.allowed).toEqual([
      expect.objectContaining({ brand: 'LobeHub', category: 'stable-code-key' }),
    ]);
  });

  it('does not flag runtime interpolation but still rejects a new visible brand literal', () => {
    const locale = scanBrandingFile(
      'locales/en-US/common.json',
      JSON.stringify({ 'tools.lobehubSkill.title': '{{platformName}}', 'title': 'LobeHub' }),
    );
    const ui = scanBrandingFile(
      'src/NewSurface.tsx',
      `export const NewSurface = () => <button aria-label="LobeHub">{{platformName}}</button>;`,
    );

    expect(locale.allowed).toEqual([
      expect.objectContaining({ category: 'stable-code-key', preview: 'tools.lobehubSkill.title' }),
    ]);
    expect(locale.candidates).toEqual([
      expect.objectContaining({ brand: 'LobeHub', preview: 'LobeHub' }),
    ]);
    expect(ui.candidates).toEqual([
      expect.objectContaining({ brand: 'LobeHub', preview: 'LobeHub' }),
    ]);
  });

  it('uses block lexical bindings and respects parameter, arrow, and local shadowing', () => {
    const result = scanBrandingFile(
      'src/scopes.ts',
      `
        const suffix = 'Hub';
        export const outer = \`Lobe\${suffix}\`;
        export function dynamic(suffix: string) { return \`Lobe\${suffix}\`; }
        export const arrow = (suffix: string) => \`Lobe\${suffix}\`;
        export const destructuredArrow = ({ suffix }: { suffix: string }) => \`Lobe\${suffix}\`;
        export function local() {
          const suffix = 'Chat';
          return \`Lobe\${suffix}\`;
        }
        export function destructuredLocal() {
          const { suffix } = { suffix: getSuffix() };
          return \`Lobe\${suffix}\`;
        }
        {
          const suffix = 'Hub';
          const nested = \`Lobe\${suffix}\`;
        }
      `,
    );

    expect(result.candidates.map(({ brand }) => brand)).toEqual(['LobeHub', 'LobeChat', 'LobeHub']);
  });

  it('folds static object, array, aliased, and defaulted destructuring bindings', () => {
    const result = scanBrandingFile(
      'src/destructuring.ts',
      `
        const { suffix: renamed } = { suffix: 'Hub' };
        const { direct } = { direct: 'Chat' };
        const { missing: objectDefault = 'Chat' } = {};
        const [arraySuffix] = ['Hub'];
        const [, arrayDefault = 'Chat'] = [];
        const { dynamicSuffix } = getConfig();
        export const one = \`Lobe\${renamed}\`;
        export const two = \`Lobe\${direct}\`;
        export const three = \`Lobe\${objectDefault}\`;
        export const four = \`Lobe\${arraySuffix}\`;
        export const five = \`Lobe\${arrayDefault}\`;
        export const dynamic = \`Lobe\${dynamicSuffix}\`;
      `,
    );

    expect(result.candidates.map(({ brand }) => brand)).toEqual([
      'LobeHub',
      'LobeChat',
      'LobeChat',
      'LobeHub',
      'LobeChat',
    ]);
  });

  it('detects HTML and CSS comment-split literals without executing content', () => {
    expect(
      scanBrandingFile('public/view.html', '<h1>Lobe<!-- split -->Hub</h1>').candidates,
    ).toHaveLength(1);
    expect(
      scanBrandingFile('src/view.css', '.x::after { content: Lobe/*x*/Chat }').candidates,
    ).toHaveLength(1);
  });

  it('parses nested HTML text, named entities, wbr boundaries, and DOM ancestry', () => {
    const first = scanBrandingFile(
      'public/view.html',
      '<section id="first"><p class="copy">Lobe<span>&Hfr;</span><wbr>ub</p></section>',
    );
    const moved = scanBrandingFile(
      'public/view.html',
      '<section id="second"><p class="copy">Lobe<span>&Hfr;</span><wbr>ub</p></section>',
    );

    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]?.locator).toContain('section#first:same(0)/p.copy:same(0)');
    expect(brandingOccurrenceKey(first.candidates[0]!)).not.toBe(
      brandingOccurrenceKey(moved.candidates[0]!),
    );
  });

  it('distinguishes same-description HTML siblings and identical CSS rules', () => {
    const htmlFirst = scanBrandingFile(
      'public/view.html',
      '<section><p>LobeHub</p></section><section><p>AIHub</p></section>',
    );
    const htmlSecond = scanBrandingFile(
      'public/view.html',
      '<section><p>AIHub</p></section><section><p>LobeHub</p></section>',
    );
    const cssFirst = scanBrandingFile(
      'src/view.css',
      '.same { content: "LobeHub"; } .same { content: "AIHub"; }',
    );
    const cssSecond = scanBrandingFile(
      'src/view.css',
      '.same { content: "AIHub"; } .same { content: "LobeHub"; }',
    );

    expect(htmlFirst.candidates[0]?.locator).toContain('section:same(0)');
    expect(brandingOccurrenceKey(htmlFirst.candidates[0]!)).not.toBe(
      brandingOccurrenceKey(htmlSecond.candidates[0]!),
    );
    expect(cssFirst.candidates[0]?.locator).toContain('rule:0');
    expect(brandingOccurrenceKey(cssFirst.candidates[0]!)).not.toBe(
      brandingOccurrenceKey(cssSecond.candidates[0]!),
    );
  });

  it('parses CSS escapes, adjacent content strings, and comments with selector/property identity', () => {
    const first = scanBrandingFile(
      'src/view.css',
      String.raw`
        .escaped { content: "Lobe\48 ub"; }
        .adjacent { content: "Lobe" "Hub"; }
        .inside { content: "Lobe/* literal */Hub"; }
        .outside { content: Lobe/**/Hub; }
      `,
    );
    const moved = scanBrandingFile('src/view.css', String.raw`.renamed { content: "Lobe\48 ub"; }`);

    expect(first.candidates).toHaveLength(3);
    expect(first.candidates.map(({ locator }) => locator)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('property:content'),
        expect.stringContaining('selector:'),
      ]),
    );
    expect(brandingOccurrenceKey(first.candidates[0]!)).not.toBe(
      brandingOccurrenceKey(moved.candidates[0]!),
    );
  });

  it('includes control-flow condition fingerprints and JSX DOM identity in TS locators', () => {
    const first = scanBrandingFile(
      'src/branch.tsx',
      `if (a) { render('LobeHub'); } const view = <section id="one"><span>LobeChat</span></section>;`,
    );
    const changed = scanBrandingFile(
      'src/branch.tsx',
      `if (b) { render('LobeHub'); } const view = <section id="two"><span>LobeChat</span></section>;`,
    );
    const whitespace = scanBrandingFile(
      'src/branch.tsx',
      `\n\nif ( /* stable */ a ) { render('LobeHub'); }\nconst view = <section id="one"><span>LobeChat</span></section>;`,
    );

    expect(first.candidates[0]?.locator).toContain('if:');
    expect(first.candidates[1]?.locator).toContain('section#one');
    expect(first.candidates.map(brandingOccurrenceKey)).not.toEqual(
      changed.candidates.map(brandingOccurrenceKey),
    );
    expect(first.candidates.map(brandingOccurrenceKey)).toEqual(
      whitespace.candidates.map(brandingOccurrenceKey),
    );
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
    const yaml = scanBrandingFile(
      'src/branding.yaml',
      'LobeHubKey: LobeChat value\nbrand:\n  title: LobeHub\n',
    );
    const first = scanBrandingFile('src/title.ts', `export const title = 'LobeHub';`);
    const moved = scanBrandingFile('src/title.ts', `\n\nexport const title = 'LobeHub';`);
    const flat = scanBrandingFile('src/collision.yaml', '"a.b": LobeHub\na:\n  b: AIHub\n');
    const nested = scanBrandingFile('src/collision.yaml', '"a.b": AIHub\na:\n  b: LobeHub\n');

    expect(yaml.candidates.map(({ locator }) => locator)).toEqual([
      'yaml:path:[]/key:"LobeHubKey"',
      'yaml:path:["LobeHubKey"]/value',
      'yaml:path:["brand","title"]/value',
    ]);
    expect(brandingOccurrenceKey(first.candidates[0]!)).toBe(
      brandingOccurrenceKey(moved.candidates[0]!),
    );
    expect(flat.candidates[0]?.locator).toBe('yaml:path:["a.b"]/value');
    expect(nested.candidates[0]?.locator).toBe('yaml:path:["a","b"]/value');
    expect(brandingOccurrenceKey(flat.candidates[0]!)).not.toBe(
      brandingOccurrenceKey(nested.candidates[0]!),
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

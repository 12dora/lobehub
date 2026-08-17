import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import admin from './admin';

/**
 * `admin` is authored by hand in en-US + zh-CN only (the other locales fall back to English),
 * so `bun run i18n` never regenerates it. This is the guard that keeps the three authoritative
 * files in step: a key added to one file and forgotten in another silently renders the raw key
 * in the admin console.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const loadLocale = (locale: 'en-US' | 'zh-CN'): Record<string, string> =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'locales', locale, 'admin.json'), 'utf8')) as Record<
    string,
    string
  >;

const defaults = admin as unknown as Record<string, string>;

/** A complete i18next interpolation — the closing braces are part of the contract. */
const INTERPOLATION = /\{\{\s*([\w.]+)\s*\}\}/g;

const variables = (value: string): string[] =>
  [...value.matchAll(INTERPOLATION)].map((match) => match[1]).sort();

describe('admin namespace locale parity', () => {
  const en = loadLocale('en-US');
  const zh = loadLocale('zh-CN');

  it('has a non-trivial key set in the default source', () => {
    expect(Object.keys(defaults).length).toBeGreaterThan(1000);
  });

  it('exposes the same key set in admin.ts, en-US and zh-CN', () => {
    const source = Object.keys(defaults).sort();
    expect(Object.keys(en).sort()).toEqual(source);
    expect(Object.keys(zh).sort()).toEqual(source);
  });

  it('keeps en-US identical to the authored default values', () => {
    const drifted = Object.keys(defaults).filter((key) => en[key] !== defaults[key]);
    expect(drifted, `en-US drifted from admin.ts for: ${drifted.join(', ')}`).toEqual([]);
  });

  it('has no blank translations', () => {
    const blank = [
      ...Object.keys(en).filter((key) => !en[key]?.trim()),
      ...Object.keys(zh).filter((key) => !zh[key]?.trim()),
    ];
    expect(blank, `blank translations: ${blank.join(', ')}`).toEqual([]);
  });

  it('keeps zh-CN interpolation variables in step with the source copy', () => {
    const mismatched = Object.keys(defaults).filter(
      (key) => variables(defaults[key]).join('|') !== variables(zh[key] ?? '').join('|'),
    );
    expect(mismatched, `zh-CN interpolation mismatch for: ${mismatched.join(', ')}`).toEqual([]);
  });

  /**
   * Counting only well-formed `{{…}}` pairs would silently accept a half-typed placeholder
   * (`{{count}` renders the braces to the admin), so every brace pair in a value has to belong
   * to a complete interpolation.
   */
  it('has no malformed interpolation braces in any value', () => {
    const occurrences = (value: string, needle: string): number => value.split(needle).length - 1;

    const malformed: string[] = [];
    for (const [locale, table] of [
      ['admin.ts', defaults],
      ['en-US', en],
      ['zh-CN', zh],
    ] as const) {
      for (const [key, value] of Object.entries(table)) {
        const complete = [...value.matchAll(INTERPOLATION)].length;
        if (occurrences(value, '{{') !== complete || occurrences(value, '}}') !== complete) {
          malformed.push(`${locale}:${key}`);
        }
      }
    }
    expect(malformed, `malformed interpolation: ${malformed.join(', ')}`).toEqual([]);
  });
});

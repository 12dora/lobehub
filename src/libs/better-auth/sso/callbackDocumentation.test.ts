// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

interface GenericProviderSource {
  file: string;
  id: string;
}

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');
const providersDirectory = path.join(import.meta.dirname, 'providers');
const historicalNextAuthDirectory = path.join(repositoryRoot, 'docs/self-hosting/auth/next-auth');
const legacyCallbackRoot = ['/api/auth', 'callback'].join('/');
const genericCallbackRoot = ['/api/auth', 'oauth2', 'callback'].join('/');

const genericProviders = readdirSync(providersDirectory)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .flatMap<GenericProviderSource>((file) => {
    const source = readFileSync(path.join(providersDirectory, file), 'utf8');
    if (!/type:\s*['"]generic['"]/.test(source)) return [];

    const id = source.match(/\bid:\s*['"]([^'"]+)['"]/)?.[1];
    if (!id) throw new Error(`Generic OAuth provider ${file} is missing a literal id`);
    return [{ file, id }];
  });

const listTextFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (absolutePath === historicalNextAuthDirectory) return [];
    if (entry.isDirectory()) return listTextFiles(absolutePath);
    return /\.(?:json|md|mdx|ya?ml)$/.test(entry.name) ? [absolutePath] : [];
  });

const currentDocumentationFiles = [
  ...listTextFiles(path.join(repositoryRoot, 'docs')),
  path.join(repositoryRoot, 'docker-compose/production/grafana/init_data.json'),
];

describe('Better Auth callback documentation', () => {
  it('derives every Generic OAuth provider from source and documents its oauth2 callback', () => {
    expect(genericProviders.length).toBeGreaterThan(0);
    expect(new Set(genericProviders.map(({ id }) => id)).size).toBe(genericProviders.length);

    for (const { file, id } of genericProviders) {
      for (const localeSuffix of ['', '.zh-CN']) {
        const documentationPath = path.join(
          repositoryRoot,
          `docs/self-hosting/auth/providers/${id}${localeSuffix}.mdx`,
        );
        expect(
          existsSync(documentationPath),
          `${file} is missing ${localeSuffix || 'EN'} docs`,
        ).toBe(true);
        const documentation = readFileSync(documentationPath, 'utf8');
        expect(documentation).toContain(`${genericCallbackRoot}/${id}`);
        expect(documentation).not.toContain(`${legacyCallbackRoot}/${id}`);
      }
    }
  });

  it('contains no legacy Generic OAuth callback in current docs or deployment config', () => {
    expect(
      currentDocumentationFiles.some((file) => file.startsWith(historicalNextAuthDirectory)),
    ).toBe(false);

    const failures = currentDocumentationFiles.flatMap((file) => {
      const content = readFileSync(file, 'utf8');
      return genericProviders
        .filter(({ id }) => content.includes(`${legacyCallbackRoot}/${id}`))
        .map(({ id }) => `${path.relative(repositoryRoot, file)}: ${id}`);
    });

    expect(failures).toEqual([]);
  });

  it('keeps administrator-facing providerKey templates on the Generic OAuth route', () => {
    const redevelopFiles = listTextFiles(path.join(repositoryRoot, 'docs/redevelopment'));
    const failures = redevelopFiles
      .filter((file) => readFileSync(file, 'utf8').includes(`${legacyCallbackRoot}/{providerKey}`))
      .map((file) => path.relative(repositoryRoot, file));

    expect(failures).toEqual([]);
  });

  it('keeps built-in and Generic OAuth callback guidance distinct', () => {
    for (const documentationPath of [
      'docs/development/basic/add-new-authentication-providers.mdx',
      'docs/development/basic/add-new-authentication-providers.zh-CN.mdx',
    ]) {
      const content = readFileSync(path.join(repositoryRoot, documentationPath), 'utf8');
      expect(content).toContain(`${legacyCallbackRoot}/{providerId}`);
      expect(content).toContain(`${genericCallbackRoot}/{providerId}`);
    }

    for (const documentationPath of [
      'docs/self-hosting/auth.mdx',
      'docs/self-hosting/auth.zh-CN.mdx',
    ]) {
      const content = readFileSync(path.join(repositoryRoot, documentationPath), 'utf8');
      expect(content).toContain(`${legacyCallbackRoot}/{provider}`);
      expect(content).toContain(`${genericCallbackRoot}/{provider}`);
    }
  });
});

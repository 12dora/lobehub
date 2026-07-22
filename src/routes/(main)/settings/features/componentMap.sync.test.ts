import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { componentMap as webMap } from './componentMap';
import { componentMap as desktopMap } from './componentMap.desktop';

describe('componentMap desktop sync', () => {
  it('desktop keys must match web keys', () => {
    const webKeys = Object.keys(webMap).sort();
    const desktopKeys = Object.keys(desktopMap).sort();

    const missingInDesktop = webKeys.filter((k) => !desktopKeys.includes(k));
    const extraInDesktop = desktopKeys.filter((k) => !webKeys.includes(k));

    expect(
      missingInDesktop,
      `Missing in componentMap.desktop: ${missingInDesktop.join(', ')}`,
    ).toEqual([]);
    expect(extraInDesktop, `Extra in componentMap.desktop: ${extraInDesktop.join(', ')}`).toEqual(
      [],
    );
  });

  it('personal and workspace connector routes share the managed-resource guard', () => {
    const personalRoute = readFileSync(
      path.resolve(process.cwd(), 'src/routes/(main)/settings/connector/index.tsx'),
      'utf8',
    );
    const workspaceRoute = readFileSync(
      path.resolve(process.cwd(), 'src/routes/(main)/[workspaceSlug]/settings/connector/index.tsx'),
      'utf8',
    );

    for (const route of [personalRoute, workspaceRoute]) {
      expect(route).toContain('ManagedConnectorSettings');
      expect(route).toContain('fallback={<ToolSettings');
    }
  });
});
